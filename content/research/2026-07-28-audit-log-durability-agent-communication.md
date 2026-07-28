---
date: "2026-07-28"
title: "When the Send Succeeds but the Record Fails — Audit-Log Durability in Agent Communication Pipelines"
description: "Why outbound message delivery and audit-trail writes must not share fate, and how to design agent communication gateways so a failed audit write is never silent."
tags:
  - agents
  - reliability
  - audit
  - distributed-systems
---

## Executive Summary

Agent fleets increasingly route every outbound message — Telegram replies, Slack posts, webhook calls — through a gateway that does two things per call: **deliver** the message, and **record** that it happened. These are two independent writes to two independent systems (an HTTP/API call and a local database insert), and nothing forces them to succeed or fail together. This is the classic *dual-write problem*, and in agent systems it shows up with a specific, painful shape: the audit record is the only evidence an agent has that it spoke on the user's behalf, so when the record silently disappears, the fleet operator loses the ability to answer "what did my agents actually say, and when."

Two failure modes were observed recently in a production agent fleet:

1. **Silent swallow.** The gateway wrapped the audit-write call in a try/catch that logged a warning and continued, on the theory that "the message got through, don't block the user on a logging failure." The result: audit-write exceptions from an unrelated regression accumulated for days with the message-delivery success rate looking perfect, and nobody knew the audit trail had a hole in it until a reconciliation was attempted for an unrelated reason.

2. **Environment drift breaking a dependency silently.** A privilege-switched invocation (`sudo -u otheruser`) resolved a different Node.js installation than the one the audit-write binding had been compiled against. The compiled SQLite native addon's ABI no longer matched the running Node ABI. The message still went out — delivery and audit-write were sequential, not transactional, so the send had already completed — but the audit insert threw at the module-load or native-call boundary. Because the failure was caught and logged rather than surfaced, the sender only discovered it by accident when checking logs for an unrelated reason.

Both failures share a root cause: **delivery and recording are treated as one logical operation but implemented as two independent, non-atomic writes, and the second write's failure mode is "best effort."** The rest of this note surveys how distributed systems have solved structurally identical problems (dual writes, outbox pattern, at-least-once delivery, WAL durability), builds a failure taxonomy that generalizes past the two incidents above, and lays out concrete recommendations for agent communication gateways — record-before-send ordering, a durable local fallback log, mandatory alerting on audit-write failure, and periodic reconciliation between transport logs and the audit database.

The core recommendation: **treat "deliver" and "record" as a single unit of work with an explicit ordering and an explicit fallback, never as two calls where the second one is allowed to fail quietly.** Which of the two happens first is a real design choice with trade-offs (below), but "fail open, log a warning, move on" should never be the answer for the audit write.

## The Dual-Write Problem, Restated for Agent Communication

The dual-write problem is well known in distributed systems: whenever an application needs to update two separate systems of record as part of what should be one logical operation, there is no built-in mechanism to make both updates succeed or fail together unless the two systems participate in a shared transaction. Classic examples are "write to the database, publish to the message queue" or "charge the card, create the order." A crash, exception, or partial failure between the two writes leaves the systems inconsistent, and because each write is usually retried independently (or not retried at all), the inconsistency can be a silent, permanent record loss rather than a visible outage.

Agent communication pipelines have exactly this shape:

```
handle_outbound_message(payload):
    result = transport.send(payload)      # write #1: external side effect
    audit_db.insert(payload, result)      # write #2: local system of record
    return result
```

Two things make this worse than the textbook e-commerce example:

- **The two writes have very different failure domains.** `transport.send` talks to an external network service (Telegram/Slack/webhook API) and its failure is usually loud — a non-200 response, a timeout, an exception the caller has to handle to know whether to retry. `audit_db.insert` talks to a local resource (a SQLite file, in the observed incidents) that "should never fail," so engineers reach for defensive try/catch around it out of a reasonable-sounding instinct: *don't let a logging subsystem take down the primary function of the service.* That instinct is exactly what converts a loud failure into a silent one.
- **There is no natural retry-and-reconcile signal.** In a queue-based system, a failed publish is visible as a gap in an offset or a DLQ entry. In a "send then locally log" gateway, a failed local write leaves literally nothing behind — no error surfaces to the caller, no entry exists to reconcile against, and the external transport log (if one exists at all, e.g. Telegram's own delivery receipt) is usually not queryable by the agent fleet after the fact.

This second point is the crux: **the dual-write problem is dangerous in proportion to how invisible the failure is.** A failed payment-then-order write is bad, but it usually produces a support ticket ("I was charged but got nothing") that forces reconciliation. A failed audit write produces nothing — no user complaint, no error budget burn, nothing but a hole in a table that nobody is looking at until an incident review needs it.

## Failure Taxonomy

Generalizing past the two observed incidents, failures in a "deliver + record" pipeline fall into four categories:

### 1. Silent swallow (application-level)

The code path around the audit write catches exceptions and continues. This is nearly always introduced with good intentions — "a broken audit log shouldn't block message delivery" — and is nearly always wrong in isolation, because it removes the only signal that anything went wrong. The defensible version of this pattern keeps the non-blocking behavior for the *user-facing* path but makes the failure loud somewhere else (structured error log with alerting, metric increment, fallback write — see Recommendations). The indefensible version is a bare `except: pass` or `except: log.warning(...)` with no counter, no alert, and no fallback.

### 2. Environment drift (infrastructure-level)

The runtime environment used to execute a given call path is not the one that was tested or the one the dependency was built against. The observed case — `sudo -u` resolving a different Node.js version, whose ABI didn't match a compiled native addon — is a specific instance of a broader class: version managers (`nvm`, `pyenv`, `rbenv`), privilege-switch tools (`sudo`, `su`, `runuser`), containers with mismatched base images, and CI runners with a different toolchain than production all create paths where "the same code" runs against a subtly different environment and a compiled/native dependency breaks. This is particularly dangerous for native bindings (SQLite, better-sqlite3, node-gyp-built modules, Python C extensions) because the failure is an exception at import or first-call time, not a slow degradation — it is a hard break that a try/catch around "just the audit part" converts into an invisible one.

### 3. Partial writes

The audit write starts but doesn't complete atomically — e.g., a multi-statement insert where the first statement succeeds and the second fails, or a write that succeeds at the OS level but is not durable (not flushed/fsynced) before a crash. SQLite in WAL mode and most embedded databases guard against torn writes at the storage-engine level, but application-level partial writes (writing to two tables, updating a counter and inserting a row non-atomically) remain the caller's responsibility.

### 4. Ordering/atomicity failures (the core dual-write case)

Delivery succeeds, recording fails (or vice versa), and there is no transaction spanning both. This is the general case that categories 1–3 are specific instances of. The two sub-variants matter for design:
- **Send-then-record**: message goes out, audit write fails → an unrecorded, but real, outbound message (the observed incidents' shape).
- **Record-then-send**: audit write succeeds, transport send fails → a recorded message that was never actually delivered (a "phantom" audit entry, less dangerous for compliance but can mislead reconciliation and retry logic if not marked pending/failed).

### Detection strategies

- **Write-then-readback**: after an audit insert, immediately read the row back (or check `rowcount`/`lastrowid`) rather than trusting a non-exception return as success. Catches partial writes and silently-degraded storage.
- **Negative controls**: periodically send a known-canary message through the full pipeline and assert both the delivery receipt and the audit row exist. This catches environment drift (category 2) proactively instead of by accident, because it runs the *exact* code path including any privilege switches, rather than a unit test that runs as the developer's own user.
- **Reconciliation sweeps**: compare the transport layer's own delivery log (where the transport exposes one — e.g., Telegram Bot API's `getUpdates`/webhook logs, an outbound HTTP proxy's access log) against the audit DB on a schedule, flagging any delivery with no corresponding audit row. This is the most general detector because it doesn't depend on the audit-write code path working correctly — it depends on an independent, external record of what actually happened.
- **Fallback-file diffing**: if a durable fallback log exists (see below), a nightly job that diffs "rows present in fallback but absent from the primary audit DB" surfaces every silent-swallow event even if no alert fired at the time.

## Prior Art Survey

**Transactional outbox pattern.** The standard fix for the dual-write problem in service-to-service messaging: instead of writing to the database and separately publishing to a message broker, the application writes the business row *and* an outbox row in the same local database transaction, and a separate relay process (or CDC connector like Debezium) reads the outbox table and publishes to the broker, deleting/marking rows once confirmed. This converts a distributed atomicity problem into a single-database local transaction plus an at-least-once relay, which is a solved problem. The direct translation to agent communication: **the audit write and the "intent to send" should be the atomic operation, and the actual transport send should be the at-least-once relay step**, not the other way around. See the AWS Prescriptive Guidance writeup and Confluent's explainer on the dual-write problem for canonical descriptions.

**Write-ahead logging (WAL).** Databases guarantee durability by writing every change to an append-only log *before* applying it to the main data structures, and only acknowledging the operation as committed once the log write is durable (flushed to disk). Recovery after a crash replays the log to determine what actually happened. The generalizable idea for audit logging: an append-only, sequentially-written log is cheap to make durable and cheap to make crash-safe, which is exactly the property a "local system of record for compliance" needs — and it is a good candidate for the *fallback* layer when the primary structured audit DB write fails.

**At-least-once delivery + idempotent processing.** Message systems that need reliability (Kafka with `acks=all`, SQS, most brokers) choose at-least-once delivery over exactly-once because exactly-once is either impossible or prohibitively expensive across independent systems, and instead push the burden of correctness onto idempotent consumers (dedup by producer ID + sequence number, or by a caller-supplied idempotency key). The audit-logging analogue: it is fine, and often correct, for the audit-recording step to be retried and to occasionally produce a duplicate row, as long as duplicates are cheap to detect (unique message ID) and reconciliation tooling treats "duplicate audit row" as a non-event while treating "missing audit row" as an incident.

**Syslog reliability tiers.** Classic syslog over UDP is explicitly best-effort — messages can be silently dropped under load or on network failure, which is why RFC 5424 and its TCP/TLS transports exist for anyone who needs a durability guarantee instead of "probably arrives." The lesson that transfers directly: **best-effort logging is a legitimate design choice, but only when it is an explicit, documented choice with a named consumer who has accepted the loss characteristics** — not a default that falls out of an unexamined try/catch. An audit trail used for compliance, incident response, or "what did the agent say" reconstruction is never the right consumer for a best-effort transport.

**OpenTelemetry / observability pipeline guarantees.** Modern telemetry pipelines (OTel Collector, vendor agents) distinguish between the SDK-side export (which can buffer, retry, and drop under backpressure — usually best-effort by design, to avoid the telemetry pipeline taking down the host application) and durable sinks further downstream. The key design pattern worth borrowing is **backpressure policy as an explicit, named setting** (e.g., OTel's batch processor drop-vs-block behavior) rather than an accidental property of how the code happens to be written. An agent audit pipeline should make the same choice explicitly: what happens when the audit DB is unavailable — block the send, drop the audit record with alerting, or fall back to a durable file? All three are legitimate; "silently drop with a debug-level log line" is not.

**Financial systems' journal-before-post.** Ledger and payment systems generally journal an intent record before attempting the external effect (authorize/capture), specifically so that a crash mid-operation leaves a recoverable, reconcilable trail rather than an untraceable side effect. This is the record-before-send ordering discussed below, and it is the dominant pattern in domains where "we did something but can't prove what" is unacceptable — which describes agent audit logging as much as it describes payments.

## Recommended Patterns for Agent Systems

**1. Record-before-send (outbox-style), not send-then-record.**
Write a "pending send" row to the local audit DB *first*, inside a transaction that either fully succeeds or fully fails before any external call is attempted. Only after that row is durably committed does the gateway attempt the transport send; on success, update the row to `sent`; on failure, update it to `failed` (with retry metadata). This guarantees the audit DB always has a record of every attempted send, even if the process crashes between the two steps — worst case you have a `pending`/`failed` row for a message that actually went out (recoverable by reconciliation against the transport's own delivery log), which is a far better failure mode than a `sent` message with zero record. This is the direct application of the transactional-outbox pattern to this domain.

**2. If send-then-record is unavoidable, the audit write must never silently fail.**
Some systems have legitimate reasons to prefer send-then-record (e.g., minimizing latency on the user-facing send path). If so, the audit write failure path must do all of the following, not just log a warning:
   - Append to a durable, dependency-light fallback (see #3).
   - Increment a metric/counter that feeds an alert (`audit_write_failures_total`), not just a log line that nobody greps.
   - Re-raise or surface the failure to a supervisory layer even if the original request to the caller still reports success — the caller succeeded, but the *system* is now in a degraded state that must be visible.

**3. Durable append-only fallback file when the structured DB write fails.**
A flat, append-only file (or a WAL-mode SQLite file *separate* from the primary — different failure domain, e.g., no native-addon dependency, plain-text JSON lines) that the gateway writes to whenever the primary audit insert throws. This directly mirrors the "syslog TCP fallback" and "WAL as the durability primitive" prior art: it should be as dependency-free as possible so that the failure mode that breaks the primary audit DB (a native ABI mismatch, a disk-full condition on that particular volume, a lock contention issue) is unlikely to also break the fallback. A nightly reconciliation job merges fallback entries back into the primary store and alerts on any fallback activity, since fallback activity is itself the leading indicator that something is silently broken in the primary path — this would have caught the ABI mismatch on day one instead of "by accident."

**4. Alert on audit-write failure as a first-class signal, not a debug log line.**
The single biggest lesson from both observed incidents: the failures were *technically* logged, but logged in a way indistinguishable from routine noise. Audit-write failure should page or notify the same way a failed message delivery would — arguably more urgently, since a failed delivery is usually self-evident to the sender (an exception bubbles up) while a failed audit write is not.

**5. Run negative controls / canary sends through the exact privileged code path.**
Because the ABI-mismatch incident was specifically triggered by a privilege switch (`sudo -u`) resolving a different toolchain, a canary test that only runs as the developer's own user would never have caught it. Health checks and canaries for agent gateways must exercise the *actual* invocation context — same user, same privilege elevation, same environment resolution — not a convenient proxy for it. This generalizes: any environment-drift class of bug (categories 2 above) is only caught by tests that run in the real execution environment, not adjacent to it.

**6. Periodic reconciliation between transport logs and the audit DB.**
Independent of everything above, run a scheduled sweep that compares an external, independently-maintained record of "what was sent" (the transport API's own delivery/webhook log, an outbound proxy's access log, or at minimum a lightweight pre-send fallback entry per #3) against the audit DB, and alert on any divergence. This is the detection strategy that does not depend on the audit-write code path working, which is precisely the property needed to catch failures *in* that code path.

**7. Treat native/compiled dependencies in the audit path as a supply-chain risk, not an implementation detail.**
Where possible, prefer the pure-JS/pure-Python fallback of a database driver for the audit path specifically, or pin and verify the exact runtime (Node/Python version, architecture) the compiled binding was built against as part of process startup — fail loudly at boot if the resolved runtime doesn't match, rather than deferring the failure to the first audit write under a privilege-switched invocation.

## Conclusion

The two incidents that motivated this note — a swallowed exception and an ABI mismatch surfaced only by a privilege switch — are different bugs with the same shape: an audit write was allowed to fail quietly because it was implemented as a second, independent step after the "real" work (message delivery) had already succeeded. The distributed-systems literature has a name and a well-tested fix for this shape of problem (the dual-write problem and the transactional outbox pattern), and adjacent fields (databases via WAL, message brokers via at-least-once + idempotency, payments via journal-before-post) have converged on the same underlying principle: **make the record durable before or atomically with the side effect, and treat any deviation from that ordering as an alertable, reconciled event — never a caught exception with a log line.** For agent fleets specifically, where the audit trail is often the *only* evidence of what an autonomous system said or did on a human's behalf, this is not a logging nicety; it is the mechanism by which "agent did X" remains a falsifiable, trustworthy claim.

## References

- [Understanding the Dual-Write Problem and Its Solutions — Confluent](https://www.confluent.io/blog/dual-write-problem/)
- [Handling the Dual-Write Problem in Distributed Systems — Auth0](https://auth0.com/blog/handling-the-dual-write-problem-in-distributed-systems/)
- [Transactional outbox pattern — AWS Prescriptive Guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)
- [Solving Data Consistency in Distributed Systems with the Transactional Outbox — Scott Logic](https://blog.scottlogic.com/2025/09/08/solving-data-consistency-in-distributed-systems-with-the-transactional-outbox.html)
- [Write-Ahead Logging: How Databases Ensure Durability — DevX](https://www.devx.com/technology/write-ahead-logging-how-databases-ensure-durability/)
- [Message Delivery Guarantees for Apache Kafka — Confluent Documentation](https://docs.confluent.io/kafka/design/delivery-semantics.html)
- [Understanding Message Delivery Semantics in Kafka — Medium](https://harshit-sharma.medium.com/understanding-message-delivery-semantics-in-kafka-3d12f6bdbde3)
- [NODE_MODULE_VERSION mismatch when running better-sqlite3 on Node 21.7.3 — WiseLibs/better-sqlite3 #1437](https://github.com/WiseLibs/better-sqlite3/issues/1437)
- [better_sqlite3 was compiled against a different Node.js version — WiseLibs/better-sqlite3 #549](https://github.com/WiseLibs/better-sqlite3/issues/549)
- [bun global install fails when run with node: native module ABI mismatch — tobi/qmd #319](https://github.com/tobi/qmd/issues/319)
