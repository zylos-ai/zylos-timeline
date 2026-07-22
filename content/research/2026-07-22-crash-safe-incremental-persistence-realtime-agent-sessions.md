---
date: "2026-07-22"
title: "Crash-Safe Incremental Persistence for Real-Time Agent Sessions"
description: "Why buffering long-lived voice and streaming agent conversations in memory until session end is a durability bug, and how incremental flush, idempotent writes, and finalize-once aggregation fix it."
tags: [ai-agents, durability, persistence, streaming, reliability, event-sourcing]
---

## Executive Summary

Long-lived, real-time agent sessions — voice interviews, streaming chat relays, multi-turn dialog agents — routinely buffer conversation state in memory and persist it only when the session ends "normally." A deploy, an OOM kill, or a preempted node destroys that buffer and any goodwill built with the user, because there is no such thing as a guaranteed normal exit in production. The fix is not "add more try/finally blocks" — it is a structural shift to incremental, write-ahead persistence: flush completed turns to durable storage as they happen, back that with a periodic timer as a safety net, make every write idempotent against replay, and compute derived aggregates (duration, token counts, summaries) exactly once at finalization rather than accumulating them incrementally. This article walks through the failure mode, the pattern catalog (WAL, checkpointing, event sourcing), the idempotency mechanics that make crash-during-flush safe, and a practical checklist for deciding when a stateful agent needs this treatment.

## The Failure Mode: In-Memory-Until-Done

The default architecture for most agent backends looks like this: accept a connection, hold conversation state (messages, tool calls, transcript segments) in a process-local variable or object, and write to the database once — on session completion. This is not laziness; it is often the *correct* design for short request/response agents, where "session" and "request" are the same thing and the runtime already gives you atomicity: either the handler returns and the response (plus any writes inside it) completes, or it doesn't and the client retries. There is no in-between state worth protecting.

The failure mode appears the moment a session's lifetime stops being bounded by a single request. A real-time voice-interview agent is the canonical case: the session is a WebSocket or SIP call that can run for 20-60 minutes, holding a growing transcript in memory the entire time. "Write on completion" implicitly assumes the process hosting that memory outlives the conversation. In production that assumption is false for mundane, frequent reasons:

- **Deploys.** A routine rolling restart sends SIGTERM (or, if the app doesn't shut down within the grace period, SIGKILL) to every instance, including ones mid-call. Deploys are not rare edge cases — they are a *weekly or daily* event in active development.
- **OOM kills.** A memory leak or a spike in concurrent long sessions triggers the kernel OOM killer or the container orchestrator's memory limit, which sends SIGKILL with no chance to run cleanup code.
- **Autoscaling evictions and node preemption.** Cloud autoscalers scale a pod down, or spot/preemptible nodes are reclaimed, with a termination notice window that is often too short to safely persist a large in-memory buffer, and no guarantee the process gets to run at all.
- **Crashes.** Unhandled exceptions, native-library segfaults, or hung event loops can kill a process instantly with no unwind.

The result is the same in every case: the in-memory buffer — potentially 30+ minutes of a live interview — evaporates, and the user is told to start over. This is a durability bug, not a bad-luck incident, because the trigger conditions (deploys, autoscaling, OOM) are routine operational events, not rare disasters. The severity is proportional to session length: a 3-second tool call has almost nothing to lose; a 45-minute voice interview has almost everything to lose, and the user experienced the value of that lost work in real time.

**Short-lived vs. long-lived, contrasted:**

| Property | Short request/response agent | Long-lived streaming/voice session |
|---|---|---|
| State lifetime | Milliseconds–seconds | Minutes–hours |
| Recovery unit | The whole request (client retries) | Partial session (nothing to retry from) |
| Natural durability boundary | HTTP response / function return | None — must be engineered |
| Cost of a mid-flight kill | Wasted compute, client retries | Lost human time, lost trust, lost data |
| Deploy risk window | Effectively zero | The entire session duration |

## Incremental / Write-Ahead Persistence Patterns

The remedy family is well-established in database and distributed-systems literature and is now being explicitly imported into agent runtimes. The core idea in every variant: **don't let unpersisted state exist for longer than you can afford to lose it.**

### Append-only event log / write-ahead logging (WAL)

Instead of holding a mutable in-memory object and writing it once, treat every meaningful state change (a completed turn, a tool call, a partial transcript chunk) as an immutable event appended to a durable log. The log *is* the source of truth; any in-memory representation is a cache that can be rebuilt by replaying the log — the same principle as a database's WAL, where durability comes from persisting the *delta* before (or immediately after) it takes effect, not from periodically snapshotting a large mutable structure. Event-sourced agent architectures (the ESAA family, "the log is the agent" pattern) apply this directly to conversational state: an append-only `EventLog` records every interaction, and any working state — transcript, summary, tool-call ledger — is a deterministic projection of that log.

### Per-turn incremental flush

The most direct fix for the motivating case: after each completed conversational turn, flush that turn to the database immediately, rather than accumulating turns and writing at session end. This bounds data loss to "at most the current in-flight turn" instead of "the entire session," and maps naturally onto a meaningful application boundary — a turn is a coherent, replayable unit, unlike an arbitrary byte offset in a stream.

### Checkpointing

Rather than logging every micro-event, periodically snapshot enough state to resume without replaying expensive or side-effecting work. Modern agent frameworks (LangGraph's checkpointer is a widely cited example) checkpoint graph state after every "superstep" or node execution, and specifically recommend checkpointing after side effects — API calls, large generations, before pausing for human input — so that on restart the agent doesn't repeat an already-committed external action. Checkpointing trades granularity for overhead: coarser checkpoints (once per turn) cost less I/O but risk replaying more work; finer checkpoints (every token) cost more I/O but bound loss more tightly.

### Periodic timer flush as a safety net

Turn-boundary flushing alone is insufficient: a turn itself can run long (a rambling answer, a slow generation), and a crash mid-turn would still lose that entire in-progress turn. A periodic timer (every 5-15 seconds) that flushes whatever partial state exists — even an incomplete turn — acts as a backstop independent of application-level event boundaries, the same "belt and suspenders" logic as combining WAL fsync with periodic full checkpoints in a database.

### Trade-offs

| Pattern | Write frequency | Latency impact | DB load | Loss bound |
|---|---|---|---|---|
| Write-only-at-end (baseline, unsafe) | 1x per session | None | Minimal | Entire session |
| Flush-on-turn-boundary | ~1x per turn | Small, off critical path if async | Moderate | One in-flight turn |
| Periodic timer flush | Fixed interval | Small | Moderate–high depending on interval | One timer interval |
| Turn-boundary + timer fallback | Combination | Small | Moderate | min(turn, interval) |
| Per-token/chunk append log | Very high | Must be async/batched or it adds latency to the hot path | High — needs batching | Near-zero |

**Write amplification and batching**: naive per-event synchronous writes to a relational database can dominate latency and DB load at scale. The standard mitigation is to batch writes (buffer a small window, e.g. 1-2 seconds or N events, then flush as one transaction) and to make the flush asynchronous relative to the user-facing turn — the agent doesn't need to block the next turn on the DB commit completing, it just needs the commit to be *in flight and guaranteed* before the next unrecoverable state change.

## Idempotency and Exactly-Once Concerns

Incremental persistence introduces a new failure surface: what happens if the process crashes *during* a flush, or a flush is retried after a transient DB error? Without care, this produces duplicate or corrupted writes — arguably worse than the original problem, because now data is silently wrong instead of visibly missing.

The standard toolkit, borrowed directly from streaming systems (Kafka's idempotent producer is the canonical reference implementation):

- **Monotonic sequence numbers / turn indices.** Every turn or event carries a strictly increasing index scoped to the session. The write becomes `UPSERT turn WHERE session_id = ? AND turn_index = ?` — replaying it is a no-op (identical overwrite); skipping ahead is detectable (a gap signals lost data, not silent corruption); duplicate or out-of-order delivery can be deduplicated by comparing indices, the same mechanism Kafka brokers use for producer sequence ordering.
- **Idempotent upserts over blind inserts.** Never `INSERT` a new row per flush attempt for the same logical turn — always upsert keyed on `(session_id, turn_index)`. This makes "flush the same turn twice because the process died right after commit but before acking" harmless.
- **"Finalize once" for derived aggregates.** This is the subtlety the motivating incident actually hinged on. Session duration, token counts, and summaries are *derived* from the event stream, not independent facts to write incrementally. Naively incrementing a `duration_seconds` counter on every flush double-counts it the moment both incremental writes and a final write exist, or the process crashes and resumes. The correct pattern: incremental writes append/upsert raw turn data only; a single, idempotent **finalization** step — guarded by a status flag (`'active' -> 'finalized'`, checked via `WHERE status != 'finalized'`) — computes derived aggregates *from the persisted log*, not an in-memory running total. Duration becomes `finalized_at - started_at`, computed once from durable timestamps.
- **Crash-during-flush safety.** The classic technique — write to a temp location, then atomically rename/commit — ensures a crash mid-write never leaves a half-written record that looks valid. For SQL databases this is just wrapping the upsert in a transaction; for file-based logs it means write-then-rename rather than write-in-place.

```text
-- Incremental turn flush (idempotent, safe to replay)
UPSERT INTO transcript_turns (session_id, turn_index, speaker, text, started_at, ended_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT (session_id, turn_index) DO UPDATE SET
  text = excluded.text, ended_at = excluded.ended_at;

-- Finalization (exactly once, guarded)
UPDATE sessions
SET status = 'finalized',
    duration_seconds = EXTRACT(EPOCH FROM (now() - started_at)),
    finalized_at = now()
WHERE id = ? AND status != 'finalized';
-- if 0 rows affected, finalization already happened — safe no-op
```

## Event Sourcing vs. Snapshotting

Two complementary strategies exist for representing the persisted state itself:

- **Event sourcing (append deltas)**: persist each turn/event as an immutable record; current state is a projection (fold/replay) over the log. Strengths: natural audit trail, cheap append-only writes, trivial idempotency via sequence numbers, full replay/time-travel for debugging. Weakness: reconstructing "current state" requires replaying (or maintaining a materialized projection of) the whole log, expensive for very long sessions without periodic snapshots.
- **Snapshotting (overwrite full state)**: persist the entire current state object on each flush. Strengths: trivial, fast reads. Weaknesses: write amplification grows with conversation length (each flush rewrites everything accumulated so far), and a crash mid-write can corrupt the *only* copy of state unless combined with atomic write-then-rename or double-buffering.

In practice, the mature pattern is hybrid: append-only event log as the durability primitive (turns, tool calls), with periodic snapshots or a materialized "current session" row for fast reconnect/resume reads — the same shape as LangGraph's checkpoint store or a database combining a WAL with periodic full checkpoints. On reconnect, the agent reads the latest snapshot (or session row) plus any events after it, and replays only that tail — not the entire session history.

## Streaming-Specific Concerns

Voice and streaming sessions add wrinkles beyond generic crash safety:

- **Partial/interrupted turns.** A turn in progress when the process dies is, by construction, not yet a "completed turn" for the flush-on-turn-boundary policy — this is exactly why the periodic timer fallback matters. The acceptable loss boundary should be an explicit design decision: losing the last *few seconds* of an in-progress utterance is usually tolerable (the user can repeat themselves); losing the entire session is not.
- **Ordering guarantees.** Turns and events must be persisted (or at least made visible to readers) in the order they occurred, or replay/resume produces a scrambled transcript. Monotonic per-session sequence numbers, not wall-clock timestamps (which can skew or collide under concurrent writers), are the reliable ordering key.
- **Resume/reconnect semantics.** For sessions where the *client* (not just the server process) can drop and reconnect — a flaky mobile network during a voice call — the same resume-token / last-event-ID pattern used for resumable LLM token streams applies: track a position marker per session, let the client (or a recovering server process) request "everything after event N," and keep the generation/session process decoupled from the specific client connection so a reconnect doesn't have to restart generation from scratch.

## Deploy & Lifecycle Safety

Graceful shutdown handling (catch SIGTERM, stop accepting new sessions, flush in-flight state, exit within the grace period) is necessary but explicitly **not sufficient**. It handles the cooperative case. It does nothing for SIGKILL, which is what actually arrives when: the graceful period expires (Kubernetes' default `terminationGracePeriodSeconds` is commonly 30s — often too short for a "flush everything" strategy on a large in-memory buffer, but plenty of time for a system that's already durable incrementally); the OOM killer fires; or the underlying node/VM is preempted without notice.

This is the central architectural principle: **durability must survive an un-graceful kill, not just a graceful one.** A system where correctness depends on a shutdown handler running is not durable — it merely reduces the *probability* of loss. Incremental persistence sidesteps the problem entirely: if every turn is already committed to durable storage by the time the process is killed, *no* shutdown handler is required for correctness (graceful drain still matters for user experience — e.g., not cutting off a call mid-sentence — but it stops being a durability dependency).

This also changes the calculus for zero-downtime deploys of stateful agent services: instead of needing to drain every long-lived connection before a deploy proceeds (slow, and still fragile against SIGKILL-class failures), the service can restart under normal rolling-update timing, and any in-flight session simply reconnects (if the client supports it) or is recoverable server-side from the last durable checkpoint — turning a data-loss risk into, at worst, a brief reconnect.

## Practical Checklist

**Does this agent need incremental persistence?**

| Question | If yes → |
|---|---|
| Can a single session run longer than one deploy cycle or SIGTERM grace period? | Needs incremental flush |
| Is session state held only in process memory before completion? | High risk — audit now |
| Would losing the whole session (not just the last few seconds) be a real cost to the user? | Needs incremental flush + safety-net timer |
| Are there derived aggregates (duration, counts, summaries) computed from running totals in memory? | Needs finalize-once refactor |
| Can the same flush be triggered twice (retry, restart, timer overlap)? | Needs idempotent upsert keyed on sequence/turn index |
| Do clients need to reconnect mid-session? | Needs ordered event log + resume-position tracking |

**Storage choices:**
- **SQLite in WAL mode** (optionally shipped continuously to object storage, e.g. Litestream-style) — strong default for single-writer, per-session durability with minimal infra; WAL mode lets appends proceed without blocking concurrent reads.
- **Postgres** — best when multiple processes/replicas write concurrently, when you need cross-session queries, or when the aggregate scale justifies a managed durable store.
- **Append-only log stores (Redis Streams, Kafka-like logs)** — best when the event volume is high, when multiple consumers need the same event stream (e.g., live transcript display + persistence + analytics), or when you specifically want the event-sourcing replay model as a first-class capability.

**Testing durability — crash-injection checklist:**
- Kill the process (SIGKILL, not SIGTERM) at a random point mid-turn; verify at most the acceptable-loss window (one turn or one timer interval) is missing on restart.
- Kill the process mid-flush (inject a delay or fault right after the DB write starts, before commit); verify no partial/corrupt row and no duplicate row on retry.
- Run the same flush twice deliberately (simulate a retried write); verify the result is identical to running it once (true idempotency, not "close enough").
- Trigger finalization twice (simulate a race or duplicate completion event); verify duration/aggregates are computed once and match a value independently derivable from the raw event log.
- Simulate a client disconnect/reconnect mid-session; verify the resumed session's transcript has no gaps, no duplicates, and correct ordering.

These are the direct analogs of the incident that motivates this article: the actual fix was flushing the filled transcript prefix to the database after each completed turn, adding a periodic timer as a backstop against long partial turns, and moving session-duration computation to a single finalization step so the incremental writes couldn't double-count it. None of this requires exotic infrastructure — it requires treating "the session might be killed at any instant" as the normal case to design for, not the exceptional one.

Sources:
- [Durable AI Agents: How to Build Long-Running Workflows That Survive Crashes, Restarts, and Real Users](https://pub.towardsai.net/durable-ai-agents-how-to-build-long-running-workflows-that-survive-crashes-restarts-and-real-c79b32c24cde)
- [Durable Execution for AI Agent Runtimes: Checkpointing, Replay, and Recovery](https://zylos.ai/research/2026-04-24-durable-execution-agent-runtimes/)
- [SQLite Durable Workflows: Skip Temporal Until You Need It](https://byteiota.com/sqlite-durable-workflows-skip-temporal/)
- [Durable AI Workflows with SQLite - Sesame Disk](https://sesamedisk.com/sqlite-litestream-durable-ai-workflows/)
- [AI Agent State Management: Persistence, Sessions, and Recovery (2026)](https://www.aimadetools.com/blog/ai-agent-state-management/)
- [ESAA-Conversational: An Event-Sourced Memory Layer for Continuity, Handoff, and Curation Across Heterogeneous LLM Coding Agents](https://arxiv.org/abs/2606.23752)
- [The Log is the Agent: Event-Sourced Reactive Graphs for Auditable, Forkable Agentic Systems](https://arxiv.org/abs/2605.21997)
- [Event-Driven Architecture for AI Agent Systems](https://zylos.ai/research/2026-03-02-event-driven-architecture-ai-agent-systems/)
- [Always-On Agents: A Survey of Persistent Memory, State, and Governance in LLM Agents](https://arxiv.org/abs/2606.30306)
- [Exactly-Once Semantics in Kafka - Conduktor](https://www.conduktor.io/glossary/exactly-once-semantics-in-kafka)
- [Idempotency in Streaming Pipelines: Exactly-Once Without the Headaches](https://streamkap.com/resources-and-guides/idempotency-streaming-pipelines)
- [Idempotent Writer Pattern - Confluent](https://developer.confluent.io/patterns/event-processing/idempotent-writer/)
- [Resumable token streaming: why AI streams break on reconnect](https://ably.com/blog/token-streaming-for-ai-ux)
- [Resume tokens and last-event IDs for LLM streaming](https://ably.com/blog/resume-tokens-last-event-id-llm-streaming-reconnection)
- [How to Build LLM Streams That Survive Reconnects, Refreshes, and Crashes](https://upstash.com/blog/resumable-llm-streams)
- [Graceful Shutdown and SIGTERM: Deploy Without Dropping Requests](https://web-alert.io/blog/graceful-shutdown-sigterm-zero-downtime-deploys-guide)
- [Graceful shutdown in Kubernetes is not always trivial](https://blog.palark.com/graceful-shutdown-in-kubernetes-is-not-always-trivial/)
