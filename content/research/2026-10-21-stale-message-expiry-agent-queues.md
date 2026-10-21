---
date: "2026-10-21"
time: "09:00"
title: "Too Old to Deliver: Age Gates and Expiry Receipts for Agent Message Queues"
description: "How a persistent agent should expire stale pending messages at claim time with one conditional UPDATE, and tell senders once instead of fifty times."
tags: ["research", "message-queues", "agent-runtime", "reliability", "sqlite", "ttl", "dead-letter", "notifications"]
---

## Executive Summary

Picture this. An AI agent's model account gets rate-limited at 08:00. Over the next two hours, people send it fifty messages across several chat apps: "are you there?", "ping", "did you see my last message?". The account recovers at 10:00 and the agent starts draining its backlog. Without an age limit it answers a question that was moot ninety minutes ago, then answers the follow-up that depends on it, then the one after that. The user sees a burst of confusing, out-of-order replies from a bot that appears to have lost its mind.

**The conclusion:** put an age gate at the moment the dispatcher claims a row, before any delivery or session-start decision. Expire the row with a single conditional `UPDATE ... WHERE id=? AND status='pending' AND age > max`, and treat "one row changed" as the only proof that this caller owns the expiry. Give the row its own terminal reason (`pending_expired`), tell the sender once per cooldown window with the same "temporarily unavailable" wording they already know, and never send a notice to system or no-reply rows. Make the threshold an environment variable with a sane default (30 minutes), log the effective value at startup, and test the boundary seconds on both sides of the threshold.

The SQLite snippets in this article were run against SQLite 3.45.1 with the `sqlite3` CLI and behaved as described.

## The Problem in Precise Terms

Many channels (DMs, group chats, a web console) write into one SQLite-backed inbound table. A dispatcher claims `pending` rows and hands them to a single long-lived agent session. When the model account is rate-limited or its login has failed, rows stay `pending` (or bounce `pending -> running -> pending` through a health-wait requeue). Unlike a queue of idempotent jobs, a chat message's meaning decays: "are you there?" is worth about a minute, "run the deploy" may be dangerous after a context change. The question is where to expire, by what clock, and what the sender is told.

## Where to Check Age

There are three places an age limit can live: the broker (TTL or retention), a background sweeper, or the consumer at claim time. Real systems mostly pick the first, and their documented behavior shows why the third is often the one that actually protects the consumer.

### What the brokers do

| System | Granularity | When expiry is enforced | What happens to the expired message |
|---|---|---|---|
| RabbitMQ | Per-queue `message-ttl` and per-message `expiration`; the lower wins | Only when the message reaches the head of the queue; consumers never receive expired messages | Discarded, or dead-lettered if a DLX is configured ([docs](https://www.rabbitmq.com/docs/ttl)) |
| Amazon SQS | Queue-level `MessageRetentionPeriod` only (60 s to 14 days, default 4 days); no per-message TTL | Retention clock, enforced by the service | Deleted; lowering retention can expire existing messages within up to 15 minutes ([API ref](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_SetQueueAttributes.html)) |
| Azure Service Bus | Per-message `TimeToLive`, capped by an entity default | `expires-at-utc` = enqueued time + TTL; may be lazily removed; locked messages are unaffected; not enforced when no clients are listening | Dropped, or moved to the dead-letter queue if enabled, with a dead-letter reason property ([docs](https://learn.microsoft.com/en-us/azure/service-bus-messaging/message-expiration)) |
| NATS JetStream | Stream `MaxAge`; per-message `Nats-TTL` header since server 2.11, opt-in via `AllowMsgTTL` | Server removes the message at the earliest applicable deadline | Deleted ([per-message TTL](https://docs.nats.io/learn/jetstream/message-ttl)) |
| Google Pub/Sub | Subscription message retention (10 min to 31 days, default 7 days); no per-message TTL | After the retention duration "Pub/Sub might discard the message" | Discarded ([docs](https://docs.cloud.google.com/pubsub/docs/subscription-properties)) |
| Kafka | Topic `retention.ms`, applied to whole log segments, not records | Closed segments are deleted once their newest record is past the threshold; the active segment is never deleted | Segment file removed; consumers need to filter by timestamp themselves ([explainer](https://conduktor.io/blog/kafka-retention-policies-when-messages-disappear)) |
| Celery | Per-task `expires` (seconds or datetime) | Checked by the worker when it receives the task | Task is not run and is marked `REVOKED` ([docs](https://docs.celeryq.dev/en/stable/userguide/calling.html)) |
| Sidekiq Pro | Per-job `expires_in` | The job must start before its expiry; once started it may run as long as needed | Job is skipped; inside a batch it counts as success ([wiki](https://sidekiq.org/wiki/Pro-Expiring-Jobs)) |

Three lessons stand out.

**Broker-level expiry is lazy.** RabbitMQ states that "only when expired messages reach the head of a queue will they actually be discarded", so an expired message can sit behind live ones and still count in queue statistics. Azure says the broker "might choose to lazily expire" messages and that TTL "isn't enforced when no clients are actively listening." The guarantee brokers give is about *delivery* ("consumers never receive expired messages"), not about *removal*. That is exactly the guarantee an agent dispatcher needs, and it is implemented at the point where a consumer asks for a message.

**Most brokers expire silently.** Plain TTL deletes the message; only dead-letter variants (a RabbitMQ DLX, Azure's dead-letter-on-expiry) keep a record. A sender-facing receipt is never a broker feature, so it is an application concern.

**Per-message expiry is rare.** SQS and Pub/Sub offer only queue-wide retention, and Kafka's retention is a storage mechanism, not a delivery contract. In an agent whose queue is a SQLite table, you are the broker.

### Claim-time check versus sweeper

A background sweeper is simple and keeps the table tidy, but between sweeps a stale row is still claimable, and recovery is the dangerous moment: the dispatcher wakes up, claims the oldest row, and delivers it before the next tick.

A claim-time check closes that window. The dispatcher selects a candidate row, and before it decides anything else (start a session, spend tokens, mark running) it evaluates age. This mirrors Celery (worker checks on receipt) and Sidekiq (job must start before expiry). The sweeper becomes optional housekeeping, useful mainly so that rows from a channel nobody is currently draining do not linger. If you keep both, make them use the same conditional write.

### Which clock

There are two natural clocks.

- **Inbound/enqueue timestamp.** Age measured from when the message entered the queue. This matches Azure (`enqueued-time-utc + TTL`) and Celery (seconds from publish). It answers "how long has this person been waiting?", which is the question that matters for staleness.
- **First-claim timestamp.** Age measured from the first delivery attempt. This is the wrong clock for this problem: during an outage the first claim is exactly the thing that is delayed, so the clock starts late and the message looks young.

Use the enqueue timestamp. Then pick *one* time source for both sides of the comparison. If the row timestamp comes from a chat platform's server clock while "now" comes from the agent host, any skew between them shifts the threshold, and a negative age can even appear. Stamp rows on ingest with the local database clock and compare against the same clock. In SQLite that is `unixepoch('now')` (3.38+) or `strftime('%s','now')` on older builds; both returned sensible epoch values in the test run. A platform-supplied send time helps only if the bridge itself was down; if you use it, clamp future timestamps.

## Making Expiry Race-Safe

The naive version reads and then writes:

```js
// WRONG: another worker can change the row between these two lines
const row = db.prepare("SELECT * FROM inbound WHERE id=?").get(id);
if (row.status === 'pending' && now - row.ts > MAX) {
  db.prepare("UPDATE inbound SET status='failed', reason='pending_expired' WHERE id=?").run(id);
  sendReceipt(row);
}
```

Between the `SELECT` and the `UPDATE`, a second dispatcher, a requeue, or an operator command can move the row to `running` or `done`. The code above would then overwrite a legitimate state, and it would still send a receipt for a message that was in fact delivered. The check and the write must be one atomic statement:

```sql
UPDATE inbound
   SET status = 'failed', reason = 'pending_expired'
 WHERE id = :id
   AND status = 'pending'
   AND unixepoch('now') - ts > :max_age_sec;
```

```js
const info = expireStmt.run({ id, max_age_sec: MAX });
if (info.changes === 1) {
  // We, and only we, expired this row. Safe to consider a receipt.
}
// 0 changes: someone else took it, or it is no longer pending or no longer old. Do nothing.
```

Rows-affected is the decision. SQLite serializes writers, so exactly one concurrent caller sees `changes === 1`. In the SQLite CLI, `SELECT changes();` after the statement reports the same count, which is what [`sqlite3_changes()`](https://www.sqlite.org/c3ref/changes.html) returns: rows directly modified by the most recently completed `INSERT`, `UPDATE` or `DELETE`. Trigger and foreign-key side effects are not counted.

If you need the row's contents for the receipt (channel, endpoint), use `RETURNING`, available since [SQLite 3.35.0](https://www.sqlite.org/lang_returning.html), instead of a follow-up read:

```sql
UPDATE inbound
   SET status = 'failed', reason = 'pending_expired'
 WHERE id = :id AND status = 'pending' AND unixepoch('now') - ts > :max
RETURNING id, channel, endpoint;
```

No row returned means no ownership. `RETURNING` row order is arbitrary, which does not matter for a single-id update but does if you run a batch sweep.

**Verified behavior (SQLite 3.45.1).** With "now" pinned at 10000 and a 1800 s limit, rows aged 1799 s and 1800 s were left pending, a row aged 1801 s and a row aged 7200 s were expired, and `RETURNING` listed only those two. Re-running the update against an already-failed row gave `changes() = 0`. A row that had been moved to `running` before the update also gave `changes() = 0`, even though it was old enough to expire.

## Telling the Sender, but Not Fifty Times

Dropping a message silently is the worst outcome for the sender; telling them fifty times is second worst.

### Prior art

Email solved this decades ago. A delivery status notification, as defined in [RFC 3464](https://www.rfc-editor.org/rfc/rfc3464), gives the sender a machine-readable report. Its `Action` field distinguishes `failed` (stopped trying, terminal), `delayed` (still trying, more notices may follow), and `delivered`. Two ideas transfer directly. A terminal failure and a "still trying" notice are different things, and an agent with an outage should say the first when it expires a message. And DSNs are sent with a null return path (`MAIL FROM:<>`) so that no notice is generated in response to a notice. In a chat setting, that means a receipt must never re-enter the inbound queue as a new message.

Chat platforms expose delivery state as events, not apologies: WhatsApp's Cloud API emits `sent`, `delivered`, `read` and `failed` status webhooks with error codes ([reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status)). That is a transport fact; the human-readable "I could not answer this in time" must come from the agent.

### Rate-limit with a cooldown key

When the backlog expires, fifty rows can belong to three conversations. One notice per conversation per window is enough. Keep a small table:

```sql
CREATE TABLE notice_cooldown (key TEXT PRIMARY KEY, last_sent INTEGER NOT NULL);

INSERT INTO notice_cooldown(key, last_sent) VALUES (:key, unixepoch('now'))
ON CONFLICT(key) DO UPDATE SET last_sent = excluded.last_sent
 WHERE excluded.last_sent - notice_cooldown.last_sent >= :cooldown_sec;
-- changes() = 1 -> send the notice; 0 -> suppressed
```

This is the same trick as the expiry: a conditional write whose rows-affected answers "may I send?". In the test run with a 600 s window, the first attempt returned 1, a second attempt 5 s later returned 0, and one at +600 s returned 1 again.

Choosing the key dimensions:

- **Channel + endpoint** (for example `telegram|chat:123`) is the sensible default. The notice goes to a place, so the limit applies to that place.
- Adding **sender** helps in group chats where one person's messages expired but others' did not. Without it, one person's expired burst can suppress a notice another person needs.
- Do **not** key on message id (that defeats the purpose) or on channel alone (one noisy chat would silence every other chat on the same platform).
- A window of about 10 minutes is a reasonable start.

### Reuse the existing wording

The agent probably already has a "temporarily unavailable" auto-reply for when it cannot serve right now. Reuse it for expiry. Users learn one phrase, support documentation stays accurate, and you avoid inventing a second tone ("your message expired") that raises more questions than it answers. If you want to add information, add it after the familiar sentence ("...so some earlier messages were not delivered; please resend if still needed"), not instead of it. Keep the text free of internal terms such as queue, row or status.

### Who is eligible

A receipt needs a real place to go. Send one only when the expired row has a real reply endpoint and a human or external sender behind it. Exclude:

- rows with no endpoint or a null/placeholder one,
- internal, scheduler and system-originated messages (a heartbeat or a control message is not a person),
- messages from other bots whose reply would start a conversation loop,
- the receipt itself, if it ever shows up as inbound.

Such a row is still expired with its terminal reason; it just gets no notice, the application-level equivalent of the null return path.

## Record a Distinct Terminal Reason

Use a specific reason, not a generic `failed`. `pending_expired` means "we never tried to deliver this because it was too old." `auth_rejected` means "we tried and the model login was refused." `delivery_error` means "we tried and it broke." Those three call for different responses: the first is tuned with the threshold, the second is an outage alert, the third is a bug.

With distinct reasons, `SELECT reason, count(*) FROM inbound WHERE status='failed' GROUP BY reason` is already a dashboard, and an alert on the rate of `pending_expired` tells you how long and how bad outages are. This is the same reason Azure attaches a dead-letter reason to expired messages.

## Configuration

Make the threshold an environment variable, for example `PENDING_MAX_AGE_SEC`, with a default (30 minutes is a decent starting point for chat). Parse defensively:

```js
function readMaxAgeSec(env = process.env, fallback = 1800) {
  const raw = env.PENDING_MAX_AGE_SEC;
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback; // invalid -> default
}
const MAX_AGE_SEC = readMaxAgeSec();
console.log(`pending expiry threshold: ${MAX_AGE_SEC}s`);
```

Invalid values (negative, zero, `abc`, `1.5`) fall back to the default rather than disabling expiry or expiring everything. Log the effective value once at startup. If you want an "off" switch, make it a separate explicit flag rather than overloading zero.

## Testing

1. **Boundary seconds.** Test ages of threshold-1, threshold and threshold+1. With a strict `>`, only threshold+1 expires. If the code uses `>=`, the middle case flips. Inject "now" so the test is deterministic.
2. **Conditional write against a non-pending row.** Create an old row, move it to `running` or `done`, then call the expire function. Assert `changes === 0`, unchanged status, and no receipt.
3. **One receipt per window.** Expire 50 old rows from the same endpoint; assert exactly one notice sent. Advance the clock past the cooldown and expire one more; assert a second notice. Add rows from a different endpoint and assert they get their own.
4. **Ineligible rows.** Expire a system or no-endpoint row; assert the row is marked `pending_expired` and no notice is sent.
5. **No session launch.** Fake the session launcher and assert it is never called when the only claimable row is expired. This protects against a cold start into an unhealthy account.
6. **Config parsing.** Unset, empty, valid, zero, negative and non-numeric values.

## Pitfalls

**Partially delivered messages.** If a message has already been handed to the session (status `running`, or a multi-part payload with some parts consumed), do not expire it on age alone. The `AND status='pending'` guard handles the simple case. Azure draws the same line: expiration "doesn't affect messages that are currently locked for delivery," and a successfully settled message is not dead-lettered after the fact. For multi-part or chunked inbound messages, expire at the logical-message level so a consumer never sees half of one.

**Requeue on health-wait.** A row can go `pending -> running -> pending` while the model is unhealthy. With the enqueue timestamp, a row that bounced back and is now 40 minutes old will expire, which is usually right, but it may have been partly processed. Record a delivery-attempt marker and exempt or distinctively log rows with real side effects. Never reset the enqueue timestamp on requeue, or a long outage keeps every message perpetually young.

**Head-of-line behavior.** RabbitMQ's head-of-queue rule shows the trap: expired messages hidden behind live ones. If your claim query picks the oldest row first and expiry is applied per claim, a pile of expired rows is cleared one claim at a time, which is fine as long as the loop continues to the next candidate instead of ending the tick. Make the dispatcher loop until it finds a live row or the queue is empty, and consider a bounded batch expiry (with `RETURNING`) when recovering from a long outage.

**Silent drops.** The deepest failure mode is a path where a row ends up `failed` with no reason and no notice. Every expiry should write a reason, increment a metric, and log the id and age. Receipts that fail to send should be logged and counted, but must not roll back the expiry; a failed notice is not a reason to deliver a stale message.

## Design Checklist

- [ ] Age check runs at claim time, before any session or delivery decision.
- [ ] Clock is the enqueue timestamp, from the same clock as "now" (the database host).
- [ ] Expiry is a single conditional `UPDATE ... WHERE status='pending' AND age > max`; `changes()` or `RETURNING` decides ownership.
- [ ] Comparison is strict `>`, and boundary tests pin it.
- [ ] Terminal reason is distinct (`pending_expired`), with a metric and a log line.
- [ ] Receipts only for rows with a real reply endpoint and a human sender.
- [ ] Receipts are gated by a conditional cooldown write keyed on channel + endpoint (+ sender in groups).
- [ ] Receipt text reuses the existing "temporarily unavailable" wording and never re-enters the inbound queue.
- [ ] Threshold from an env var, invalid values fall back to the default, effective value logged once at startup.
- [ ] Rows partially delivered or already `running` are never expired by age alone.
- [ ] Requeue does not reset the enqueue timestamp.
- [ ] Dispatcher continues past expired rows instead of ending the tick.
- [ ] An optional sweeper uses the same conditional write.
- [ ] Tests: boundary, non-pending row, one receipt per window, ineligible rows, no session launch, config parsing.

## References

- RabbitMQ, [Time-To-Live and Expiration](https://www.rabbitmq.com/docs/ttl)
- AWS, [SQS SetQueueAttributes (MessageRetentionPeriod)](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_SetQueueAttributes.html)
- Microsoft, [Azure Service Bus message expiration (TTL)](https://learn.microsoft.com/en-us/azure/service-bus-messaging/message-expiration)
- NATS, [JetStream per-message TTL](https://docs.nats.io/learn/jetstream/message-ttl) and [streams](https://docs.nats.io/nats-concepts/jetstream/streams)
- Google Cloud, [Pub/Sub subscription properties](https://docs.cloud.google.com/pubsub/docs/subscription-properties)
- Conduktor, [Kafka retention: when messages disappear](https://conduktor.io/blog/kafka-retention-policies-when-messages-disappear)
- Celery, [Calling tasks: expires](https://docs.celeryq.dev/en/stable/userguide/calling.html)
- Sidekiq, [Pro expiring jobs](https://sidekiq.org/wiki/Pro-Expiring-Jobs)
- SQLite, [RETURNING](https://www.sqlite.org/lang_returning.html) and [sqlite3_changes()](https://www.sqlite.org/c3ref/changes.html)
- IETF, [RFC 3464: An Extensible Message Format for Delivery Status Notifications](https://www.rfc-editor.org/rfc/rfc3464)
- Meta, [WhatsApp message status webhooks](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status)
