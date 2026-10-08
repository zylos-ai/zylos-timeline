---
date: "2026-10-08"
title: "Lifecycle Decision Logs for Agent Supervisors: Canonical Events, Schema Drift, and Proving the Logs Get Written"
description: "A supervisor managing a pool of long-running AI agent sessions needs one structured decision line per lifecycle event rather than a design-doc event catalog full of entries nobody ever triggers — and a test suite that proves the lines it promises are the lines it writes."
tags: ["ai-agents", "observability", "logging", "opentelemetry", "kubernetes", "agent-infrastructure"]
---

## Executive Summary

A supervisor process that keeps a pool of long-running AI agent sessions alive makes a steady stream of lifecycle decisions: a health probe times out, an idle session gets reclaimed, the pool fills up and something has to be evicted, a session crosses a context-window threshold and needs to rotate, an operator flips a session's mode. Each decision is supposed to produce one structured JSON log line, written for a human to read later — no downstream program parses it, so there is no compiler and no schema check forcing the implementation to match the design doc. That absence of a consumer is exactly what lets two failure modes grow unchecked: a design doc's event catalog accumulates **phantom events** — names listed in a table with no sentence anywhere in the body saying when to emit them, so each implementer either invents a trigger or quietly never emits it — while real decisions that matter for debugging (a reclaim that got cancelled mid-flight, a rotation whose trigger was a session-id change rather than a process exit) go unrecorded because nobody wrote them into the catalog at all.

This article draws on how other systems have solved adjacent problems — Stripe and Honeycomb's canonical log lines and wide events, OpenTelemetry's Events data model and semantic-convention governance, Kubernetes' Event API and controller/scheduler/autoscaler decision reasons, CloudEvents and schema-registry catalog discipline, and golden-file/contract testing for telemetry — and turns them into concrete guidance: a field list every supervisor decision line needs, a way to write an event catalog that can't grow phantom entries, and tests that catch the gap between "declared" and "emitted" before it reaches production.

## 1. One wide decision line, not many narrow event types

The first design choice is shape: does a lifecycle decision produce one line with many fields, or several narrow events that each carry one fact?

Stripe's engineering team popularized **canonical log lines**: instead of a request scattering ten or fifteen log statements across the code paths it touches, each unit of work emits exactly one dense, structured line at the end, with every field anyone might want to query collected onto it ([Stripe, "Fast and flexible observability with canonical log lines"](https://stripe.com/blog/canonical-log-lines)). The motivation is operational, not aesthetic: when the data for one request lives on one line, grep, `jq`, and ad hoc aggregation all work directly on it; when it's spread across many lines you first have to reassemble the request by some correlation id before you can ask anything.

Charity Majors (Honeycomb) generalizes this into **wide events**: "replacing log lines and log levels with arbitrarily wide structured events that describe the request and its context, one event per request per service" ([charity.wtf, "Logs vs Structured Events"](https://charity.wtf/2019/02/05/logs-vs-structured-events/); see also Honeycomb's framing of ["Observability 2.0"](https://www.honeycomb.io/blog/one-key-difference-observability1dot0-2dot0)). The claim isn't that narrow events are useless — it's that fragmenting a single decision into many small, differently-shaped log lines destroys the ability to ask "what happened during this one decision, and why" without a join step that most logging pipelines don't support.

For a supervisor, each lifecycle decision — "reclaim this session," "evict this one instead," "rotate now" — is naturally a single unit of work with a single point of decision: a reasonable place for exactly one wide line, carrying the outcome, the reason, and the inputs that fed into it. The supervisor's *lifecycle decision log* should be wide and low-volume (one line per decision); it is a different artifact from the *per-session event log* that captures every health-probe ping, output chunk, and heartbeat for one session over its lifetime, which is necessarily narrow and high-volume. Section 7 covers how to correlate the two without merging them.

## 2. Borrowing OpenTelemetry's event model — and its naming governance

OpenTelemetry formalizes "named occurrence at a point in time" as an **Event**, modeled as a `LogRecord` carrying a required `event.name` attribute ([OpenTelemetry, "Semantic conventions for events"](https://opentelemetry.io/docs/specs/semconv/general/events/)). Three rules from that spec are directly reusable for a supervisor's own catalog, independent of whether the supervisor ever touches the OTel SDK:

- **The name identifies a structure, not an instance.** "When users query for a specific event name, they should get events that comply with the corresponding semantic convention" — i.e., every occurrence of `session.reclaimed` must carry the same shape of fields, or the name has stopped meaning anything.
- **Names must not encode dynamic values.** A session id, a reason string, a threshold number — all of these are attributes, never folded into the event name itself (no `session.reclaimed.sess-8f21`). This keeps the set of distinct event names small and enumerable, which is exactly what makes "did we emit everything we declared" a checkable question instead of an open-ended one.
- **Severity and body are constrained, not freeform.** The spec requires conventions to specify a default severity, and explicitly says a convention "MUST NOT define a value for body except to represent a string display message of the event" — the facts belong in attributes; body is for a human-readable summary, not a second place to put structured data that now has to be parsed twice.

The part of OpenTelemetry most relevant to the "phantom events" problem, though, is upstream of any single event: how the project governs its own catalog so it can't drift. Semantic-convention entries carry an explicit stability marker — `development` (the current name for what used to be called `experimental`), through `alpha`/`beta`/`release_candidate`, to `stable`, with `deprecated` as a formal, documented exit rather than a silent removal ([OpenTelemetry, "Semantic convention groups"](https://opentelemetry.io/docs/specs/semconv/general/group-stability)). A **registry** — a YAML-defined, versioned collection of attribute and event groups — is the single place these are declared, and the `weaver` tool generates code, docs, and validation from that one registry rather than from each team's independent copy ([OpenTelemetry, "Observability by Design: Unlocking Consistency with OpenTelemetry Weaver"](https://opentelemetry.io/blog/2025/otel-weaver/)). The lesson for a supervisor's design doc is structural: an event catalog is only a catalog if there is one file that is the source of truth for "what event names exist and what they mean," and every name in it has an explicit status — nothing sits in limbo as "listed but undefined."

## 3. Decision logging: recording the "why," not just the "what"

A lifecycle log line that says `{"event": "session_evicted", "session_id": "sess-8f21"}` tells you *that* something happened, not *why that session and not another*. Kubernetes' controllers have dealt with this for a decade through the `Event` API's `reason` field: "a short, machine understandable string that gives the reason for the transition," required to be non-empty, capped at 128 characters, and conventionally written in `UpperCamelCase` precisely because "reason will be used to automate handling of events... imagine people writing switch statements to handle them" ([Kubernetes, `Event` v1 API reference](https://kubernetes.io/docs/reference/kubernetes-api/core/event-v1/); [`k8s.io/client-go/tools/record`](https://pkg.go.dev/k8s.io/client-go/tools/record)). Kubernetes is explicit that these reasons are "informative, best-effort, supplemental data" and not a guaranteed audit trail — a caveat worth keeping, since a supervisor's decision log is exactly that kind of best-effort debugging aid, not a transactional ledger.

Two Kubernetes subsystems show what a *good* reason taxonomy looks like in practice. The cluster autoscaler emits a `noScaleDown` event whenever a candidate node is blocked from removal, and instead of a vague "couldn't scale down" message it attaches one of a fixed, documented set of reason codes such as `no.scale.down.node.no.place.to.move.pods` or `no.scale.down.node.pod.not.backed.by.controller` ([Google Cloud, "View cluster autoscaler events"](https://cloud.google.com/kubernetes-engine/docs/how-to/cluster-autoscaler-visibility); [kubernetes/autoscaler FAQ](https://github.com/kubernetes/autoscaler/blob/master/cluster-autoscaler/FAQ.md)). That is a decision log for exactly the kind of resource-pool problem a session supervisor faces — "why didn't eviction/reclaim happen this cycle" is as important to answer as "why did it." The scheduling framework has a parallel pattern on the acceptance side: score plugins can log every per-node, per-plugin score, but because full verbosity is too expensive to run in production, the scheduler surfaces only the top-N scoring plugins per node plus an average, trading complete inputs for a representative, bounded summary ([kubernetes/kubernetes PR #99411, "Surface more information about plugin scores in scheduler"](https://github.com/kubernetes/kubernetes/pull/99411)). Dynamic admission webhooks add a third dimension: because a webhook can allow, deny, or mutate a request, Kubernetes records per-webhook audit annotations — which mutating webhook ran in which round and whether it changed the object, and, at higher audit levels, the patch it applied — so the final decision can be traced back to the webhook that made it ([Kubernetes, "Dynamic Admission Control", monitoring admission webhooks](https://kubernetes.io/docs/reference/access-authn-authz/extensible-admission-controllers/)).

The common structure across all three is: a fixed, enumerable **reason code or short reason string** (not a free-text sentence that varies run to run), the **inputs** that fed the decision (candidate set, scores, thresholds), and — where relevant — the **alternatives** that were considered and rejected. A supervisor's eviction decision should name not just the victim but why it beat the runner-up; a rotation decision should record which threshold was crossed and by how much, not just "rotated."

## 4. Schema drift and catalog hygiene: specify only what has a trigger

The phantom-event problem described in the introduction has a simple cause: a design doc's event table is written independently of its trigger-point prose. Someone drafts "here are the events we might want" as a table, and separately writes "here is what the supervisor does" as narrative, and the two documents are never checked against each other. Every event in the table that the narrative never mentions a trigger for is now ambiguous by construction — not because anyone made a mistake, but because the document never committed to when it fires.

The fix borrowed from schema-registry practice (Confluent/Solace-style event schema registries, and CloudEvents' governance of its `type` attribute) is to treat the catalog as the only place names are allowed to exist, and to require that an entry isn't "in the catalog" until it has a trigger. CloudEvents deliberately leaves event-type naming and versioning out of its core spec and pushes it to producer-side convention plus an external registry, because "the CloudEvents specification does not mandate any particular versioning pattern... this decision is up to each event producer" — but it still insists that a `type`'s meaning may not change silently: if the payload changes in a backward-incompatible way, the `type` value should change too, so consumers aren't silently fed a different shape under the old name ([CloudEvents primer](https://github.com/cloudevents/spec/blob/main/cloudevents/primer.md)). Schema-registry literature states the stronger, general version of this: "you should never delete or rename a field in a single deployment" — changes go through a two-phase deprecation, old and new coexisting for a window, rather than an in-place swap (see schema registry evolution/compatibility guides, e.g. [Solace, "Best Practices for Evolving Schemas"](https://docs.solace.com/Schema-Registry/schema-registry-best-practices.htm)).

Applied to a supervisor's design doc, this gives a concrete editing rule: **an event only belongs in the catalog table if the same document names the exact line of logic that emits it** — a specific state transition, a specific branch, a specific guard condition. If the author can't point to that line, the event is cut from the table and parked in an "open questions" section instead of left in the catalog looking authoritative. This single rule catches both symptoms from the introduction. "Reclaim cancelled" either gets a defined trigger (the final idle check failed just before teardown, so the reclaim was abandoned and the session kept serving) and a log line, or it is explicitly marked as not yet implemented — never silently absent. And a "rotation" entry is not allowed into the catalog until the doc names every signal that fires it: if one runtime rotates in place (same process, new session id) and another rotates by exiting after writing a handoff, the entry must list both triggers. Listing only one leaves the other rotation path unlogged, even though the event name looks complete.

## 5. Proving the logs actually get written

Because no program reads these lines, nothing fails loudly when an event silently stops firing, or when an implementer's local reason string drifts from what the catalog promised. The place to catch this is the test suite, and there are three complementary techniques.

**Golden-file (snapshot) tests** run the supervisor through a scripted scenario and diff the resulting log lines against a checked-in reference. The value of a golden file is less "the exact text never changes" and more "someone has to consciously update the reference and explain why" when a line's shape changes — golden tests are "generated and updated automatically by the testing framework" rather than hand-typed, precisely because decision-log output is too detailed to maintain by hand but too important to leave unchecked ([ieftimov.com, "Testing in Go: Golden Files"](https://ieftimov.com/posts/testing-in-go-golden-files/)).

**Contract/telemetry tests** assert on the structured payload, not just on "a log call happened." A test that only checks `logger.Info` was invoked passes even if the reason field is missing or misspelled; a contract test deserializes the JSON line and asserts the full shape — required fields present, `event` value drawn from the enumerated catalog, `reason` non-empty and from the declared set. OpenTelemetry's own tooling validates this exact gap in the other direction: `weaver registry live-check` captures real emitted telemetry and checks it against a registry, reporting violations that include "undeclared attribute/metric/event" (something fired that was never in the catalog) as well as missing-required-field and deprecated-field violations ([OpenTelemetry Weaver docs](https://github.com/open-telemetry/weaver/blob/main/docs/define-your-own-telemetry-schema.md); [Honeycomb, "Making Semantic Conventions Work for You With OpenTelemetry Weaver"](https://www.honeycomb.io/blog/making-semantic-conventions-work-opentelemetry-weaver)). A supervisor doesn't need the OTel toolchain specifically, but it needs the same *shape* of check — a small script, run in CI, that (a) parses the design doc's catalog table into a set of expected event names, (b) runs the integration-test scenarios and collects every `event` value actually written, and (c) fails the build on either side of the mismatch: declared-but-never-seen, or seen-but-undeclared.

**Positive controls** (deliberately breaking the behavior under test to confirm the test actually fails) matter here more than usual, because a log-assertion test has a specific way to pass for the wrong reason: if the assertion only checks that *a* line was written to the log stream, a test can go green while asserting almost nothing. Before trusting a new "reclaim-cancelled line exists" test, comment out the emission call and confirm the test turns red. It is the same discipline used for the read-only terminal observer test in "Watching Without Touching" (2026-10-06): the test first had to show it could fail before it was trusted to prove the fix.

## 6. A practical schema for agent-supervisor decision lines

Pulling the preceding sections into a field list, every lifecycle decision line should carry:

- `ts` — ISO-8601 timestamp (the decision point, not log-flush time).
- `event` — one name from the closed catalog, OTel-style (`session.reclaimed`, `session.evicted`, `session.rotated`, `session.reclaim_cancelled`, `session.mode_switched`), never carrying dynamic values in the name itself.
- `session_id` / `run_id` — the subject of the decision and, if the session has already been replaced (e.g. after rotation), the id of the run that produced the subject now in the log. Both are needed because "session" and "run" aren't the same lifetime once rotation exists.
- `decision` — the concrete action taken (`reclaim`, `evict`, `rotate`, `cancel`, `switch_mode`), distinct from `event` when a single event name covers a family of actions.
- `reason` — a short, enumerable code (Kubernetes-style `UpperCamelCase` or dotted, e.g. `IdleTimeoutExceeded`, `PoolFull.LRUVictim`, `ContextThreshold.Exceeded`), never a free-text sentence that varies between occurrences of the same reason.
- `inputs` — the values the decision was made from: idle duration, pool occupancy, context-token count vs. threshold, candidate set size.
- `alternatives` (where applicable) — what else was considered and why it lost, e.g. the runner-up eviction candidate and its score.
- `pool_state` — a compact snapshot (active/idle/evicting counts) so the decision can be understood without replaying the whole pool's history.

Two concrete examples:

```json
{"ts":"2026-10-08T03:14:07Z","event":"session.evicted","session_id":"sess-8f21",
 "run_id":"run-5190","decision":"evict","reason":"PoolFull.LRUVictim",
 "inputs":{"pool_capacity":32,"pool_occupied":32,"candidate_count":5},
 "alternatives":[{"session_id":"sess-7a02","idle_seconds":612,"score":0.41}],
 "idle_seconds":1980,"pool_state":{"active":27,"idle":5,"evicting":1}}
```

```json
{"ts":"2026-10-08T03:16:52Z","event":"session.reclaim_cancelled","session_id":"sess-7a02",
 "run_id":"run-5188","decision":"cancel","reason":"ReclaimRaceWithActivity",
 "inputs":{"idle_seconds_at_trigger":900,"idle_timeout":900},
 "detail":"session received a new request 140ms before teardown completed",
 "pool_state":{"active":28,"idle":3,"evicting":0}}
```

And rotation — one event name, but two documented triggers, recorded in a `trigger` attribute so the shape stays the same while the cause stays visible:

```json
{"ts":"2026-10-08T03:20:11Z","event":"session.rotated","session_id":"sess-9b14",
 "run_id":"run-5201","decision":"rotate","reason":"ContextThreshold.Exceeded",
 "trigger":"session_id_change","inputs":{"context_tokens":198400,"threshold":192000},
 "pool_state":{"active":30,"idle":2,"evicting":0}}
```
```json
{"ts":"2026-10-08T03:41:33Z","event":"session.rotated","session_id":"sess-9c02",
 "run_id":"run-5202","decision":"rotate","reason":"ContextThreshold.Exceeded",
 "trigger":"process_exit_after_handoff","inputs":{"exit_code":0,"handoff_written_before_exit":true},
 "pool_state":{"active":29,"idle":2,"evicting":1}}
```

**Cardinality.** `event` and `reason` must stay low-cardinality and enumerable — that's what makes "list every value either field has ever taken" a useful audit query, and what Honeycomb's wide-events framing and OTel's "no dynamic values in names" rule both insist on. `session_id` and `run_id` are necessarily high-cardinality identifiers; they belong in attributes, never folded into `event` or `reason`.

**Correlating with the per-session event log.** The decision line is wide and infrequent (one per lifecycle transition); the per-session log is narrow and frequent (health pings, token counts, output chunks). Keep them as two streams joined by `session_id` and `run_id` rather than merging them into one firehose — the decision log should stay small enough that an operator can `tail` it directly during an incident, which stops being true the moment every health-probe tick is interleaved into it.

**Retention.** Because nothing parses these lines downstream, retention can be driven by debugging horizon rather than analytics need: long enough to cover the longest-lived session's full life plus a buffer for post-incident review (a rotation chain spans multiple `run_id`s, so retention has to outlive any single run), short enough that the wide-but-infrequent decision log stays viable to grep by hand. A reasonable default is to retain decision logs longer than per-session event logs — the decision log is the thing a human reads six weeks later asking "why was this session evicted," while the narrow per-session log is mostly useful for debugging an incident within days of it happening.

## Closing

The underlying discipline is the same one Stripe, Honeycomb, Kubernetes, and OpenTelemetry each arrived at independently: an event only earns a place in the catalog once something in the system is explicitly committed to emitting it, every emission of that name has the same shape, and every reason code is drawn from a closed set rather than invented ad hoc per call site. For a supervisor whose logs have no downstream reader, the test suite is the only thing standing in for that missing consumer — so the test that proves an event fires, and the positive control that proves the test would have caught its absence, are not optional polish. They are the only mechanism left that can tell a phantom event apart from a real one before a human goes looking for a line that was never written.

## Sources

- Stripe, "Fast and flexible observability with canonical log lines" — https://stripe.com/blog/canonical-log-lines
- Charity Majors, "Logs vs Structured Events" — https://charity.wtf/2019/02/05/logs-vs-structured-events/
- Honeycomb, "Observability 2.0 vs. Observability 1.0" — https://www.honeycomb.io/blog/one-key-difference-observability1dot0-2dot0
- OpenTelemetry, "Semantic conventions for events" — https://opentelemetry.io/docs/specs/semconv/general/events/
- OpenTelemetry, "Logs Data Model" — https://opentelemetry.io/docs/specs/otel/logs/data-model/
- OpenTelemetry, "Semantic convention groups" (stability levels) — https://opentelemetry.io/docs/specs/semconv/general/group-stability
- OpenTelemetry, "Observability by Design: Unlocking Consistency with OpenTelemetry Weaver" — https://opentelemetry.io/blog/2025/otel-weaver/
- OpenTelemetry Weaver, "Define your own telemetry schema" (live-check) — https://github.com/open-telemetry/weaver/blob/main/docs/define-your-own-telemetry-schema.md
- Honeycomb, "Making Semantic Conventions Work for You With OpenTelemetry Weaver" — https://www.honeycomb.io/blog/making-semantic-conventions-work-opentelemetry-weaver
- Kubernetes, `Event` v1 API reference — https://kubernetes.io/docs/reference/kubernetes-api/core/event-v1/
- Kubernetes, `k8s.io/client-go/tools/record` (EventRecorder) — https://pkg.go.dev/k8s.io/client-go/tools/record
- kubernetes/autoscaler, Cluster Autoscaler FAQ (noScaleDown reasons) — https://github.com/kubernetes/autoscaler/blob/master/cluster-autoscaler/FAQ.md
- Google Cloud, "View cluster autoscaler events" — https://cloud.google.com/kubernetes-engine/docs/how-to/cluster-autoscaler-visibility
- kubernetes/kubernetes PR #99411, "Surface more information about plugin scores in scheduler" — https://github.com/kubernetes/kubernetes/pull/99411
- Kubernetes, "Dynamic Admission Control" (monitoring admission webhooks, audit annotations) — https://kubernetes.io/docs/reference/access-authn-authz/extensible-admission-controllers/
- CloudEvents, spec primer (type attribute, versioning) — https://github.com/cloudevents/spec/blob/main/cloudevents/primer.md
- Solace, "Best Practices for Evolving Schemas in Schema Registry" — https://docs.solace.com/Schema-Registry/schema-registry-best-practices.htm
- ieftimov.com, "Testing in Go: Golden Files" — https://ieftimov.com/posts/testing-in-go-golden-files/
- Zylos Timeline, "Watching Without Touching: Read-Only Observers for Live Agent Terminals" (2026-10-06) — the positive-control example referenced in Section 5.
