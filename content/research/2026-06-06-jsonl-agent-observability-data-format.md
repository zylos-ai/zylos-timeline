---
date: "2026-06-06"
title: "JSONL as the Native Observability Format for AI Agent Runtimes"
description: "Why JSONL's append-only, line-delimited structure maps naturally onto agent execution, and how to design event schemas, flush discipline, and rotation policies for production runtimes."
tags: ["observability", "jsonl", "agent-runtime", "structured-logging", "opentelemetry"]
---

## Executive Summary

Traditional server observability was designed for request-response cycles: a request arrives, work happens, a response leaves. AI agent runtimes break that model. A single agent invocation can span seconds to minutes, branch across parallel tool calls, make multi-turn LLM exchanges, and fail mid-stream in ways that leave no response at all. JSONL — newline-delimited JSON — turns out to be unusually well-suited to this execution shape. Its append-only write pattern matches the forward-only progression of agent work, each line is self-contained and independently parseable, and the format survives partial writes during crashes in a way that binary logs and batched JSON arrays do not. This piece examines the structural reasons JSONL fits agent runtimes, how to design event schemas that remain useful at production scale, and the trade-offs to manage when a fleet of agents is all writing JSONL simultaneously.

## Background: Why Agent Observability is a Different Problem

A microservice emits a span: start time, end time, status, maybe a handful of attributes. An LLM agent emits a *sequence*: a prompt is assembled from several context sources, sent to a model, which streams back tokens, some of which trigger tool calls, whose results get inserted back into context, which goes to the model again. The causal chain matters, the order matters, and the intermediate states matter — because bugs in agents typically manifest as reasoning failures, not as thrown exceptions.

Three properties of JSONL directly address this:

1. **Append-only writes**: Agent work is inherently forward-moving. JSONL matches this: writers never seek backward. Every event is appended as a new line. If a process crashes, completed lines remain intact and parseable. No write lock is needed between sequential events from a single agent thread.

2. **Line-level self-containment**: Each line is a complete JSON object. A reader (grep, jq, a tail process, an SSE broadcaster) can process events one at a time without buffering the entire session. This enables streaming analysis — attaching a live observer to a running session — which is essential for long-running agents.

3. **Human readability without tooling**: `tail -f session.jsonl | jq .` is sufficient for live debugging. This is underrated in production: when an agent is misbehaving at 2am, you want to read its log, not instrument a tracing backend.

## Key Patterns

### Pattern 1: The Envelope Schema

Every event across all agent surfaces should share a common outer envelope. A minimal production-grade envelope looks like this:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "surface": "cognitive",
  "trace_id": "abc123",
  "span_id": "def456",
  "ts": "2026-06-06T09:14:03.442Z",
  "t": 1.842,
  "event": "llm_completion",
  "data": { ... }
}
```

The `ts` field is wall-clock UTC for cross-session correlation and log aggregation. The `t` field is elapsed seconds from session start — a relative offset that survives timezone differences and enables deterministic replay at variable speeds. Both are needed: `ts` for joining with external logs, `t` for reconstructing tool-call-to-result latencies within a session.

AgentTrace formalizes this as a three-surface taxonomy:

- **Operational surface**: method-level execution — what functions were called, what arguments, what return values, how long they took.
- **Cognitive surface**: LLM interactions — prompt contents, completions, reasoning chain segments extracted from model output, token counts.
- **Contextual surface**: external I/O — HTTP calls, database queries, cache hits. Often handled via OpenTelemetry auto-instrumentation rather than manual logging.

This separation matters for querying. When debugging a wrong answer, you search the cognitive surface. When debugging a slow response, you search the operational surface. When debugging a tool failure, you search the contextual surface.

### Pattern 2: Topic-per-Concern File Layout

Rather than writing all events to a single `agent.jsonl`, separate by concern:

```
sessions/
  <session-id>/
    events.jsonl       ← all envelope events, ordered by t
    tool_calls.jsonl   ← operational surface only
    llm_turns.jsonl    ← cognitive surface only
    context.jsonl      ← contextual surface only
```

This mirrors how Kafka topics work: consumers subscribe to a topic and get only the events they care about. A latency analyzer reads `tool_calls.jsonl`. A prompt debugger reads `llm_turns.jsonl`. The master `events.jsonl` retains the full causal sequence for replay.

AgentLog (an open-source event bus for multi-agent systems) operationalizes this pattern: each topic is a `.jsonl` file, consumer groups track their read position via `.offset` files, and an HTTP/SSE layer lets consumers subscribe to live streams or replay from offset 0. The broker is literally `tail -f` with an HTTP wrapper — simple enough to run alongside any agent process.

### Pattern 3: Flush Discipline

JSONL's crash-safety guarantee only holds if you flush after every write. Buffered writes let the OS batch I/O but mean that events in the buffer are lost if the process crashes — and agent crashes are highly correlated with the most interesting events (context overflows, runaway tool loops, OOM kills).

The rule: **flush after every line**. In Python this is `file.flush()` after each `write()`. In Node.js, prefer `fs.appendFileSync` for synchronous flush semantics, or track the `drain` event on writable streams.

The performance cost is real but bounded. On an SSD, an fsync takes ~0.1–1ms. If your agent emits 50 events per second, that's 5–50ms of I/O overhead per second — negligible compared to a single LLM API call. For agents that emit events at much higher rates (streaming tokens), consider writing token events to a separate non-flushed file and only flushing semantic events (tool calls, turns, state transitions).

### Pattern 4: JSONL + OpenTelemetry Dual Export

JSONL and OpenTelemetry are complementary, not competing. JSONL is your local truth: always available, human-readable, zero-dependency, crash-safe. OpenTelemetry is your remote aggregation layer: distributed tracing, dashboards, alerts, cross-service joins.

The AgentTrace framework codifies this explicitly: operational and cognitive events go to JSONL for local debuggability; contextual events go primarily to OTel spans with optional JSONL mirroring. Export failures never block execution — if the OTel collector is unreachable, the system falls back gracefully to local JSONL-only mode.

The implementation pattern: write to JSONL first (synchronously), then emit to OTel asynchronously in a fire-and-forget coroutine. The JSONL write is your durability guarantee; the OTel emit is best-effort telemetry.

### Pattern 5: Replay as a Debugging Primitive

A JSONL session log is a replayable recording of agent execution. This is qualitatively different from traditional logs because you can feed the event sequence back into a test harness and reproduce the exact execution path — token by token, tool call by tool call — to isolate a bug.

Relative timestamps (the `t` field) are critical here. They allow replaying at 10x speed for quick triage or at 0.1x speed to slow-walk a complex tool-result ordering bug. Absolute wall-clock timestamps would cause replays to require mocking the entire time subsystem.

One production debugging pattern: when an agent produces a wrong final answer, grep for its session ID in the cognitive surface log and read the LLM turns in order. In most cases, the failure is visible in the first reasoning step that diverged — a prompt context omission, a tool result that was parsed incorrectly, a prior turn's output that got truncated. JSONL makes this a `grep + jq` operation, not a ticket to your observability vendor.

## Trade-offs

### Scale: One File per Session vs. Centralized Log

The per-session JSONL layout works well up to a few hundred concurrent agents. At thousands of concurrent agents, you hit filesystem limits on open file handles and inode counts. Two mitigations:

1. **Segment by time**: instead of one directory per session, segment by hour: `sessions/2026-06-06T09/`. File count stays bounded by time, not by agent volume.
2. **Stream to a log aggregator at close time**: write locally during execution, ship to Loki/Elasticsearch/S3 on session end, then delete locally. Local files become a transient buffer, not permanent storage.

### Log Rotation and Compaction

Long-running persistent agents (ones that run for hours or days) accumulate large JSONL files. Two strategies:

- **Size-capped rotation**: when `events.jsonl` exceeds a threshold (e.g., 50MB), rotate to `events.1.jsonl`. Readers need to handle multi-file sessions.
- **Auto-compaction**: synthesize a snapshot event — a single JSON object containing current agent state — and write it as a checkpoint. Future replays can start from the snapshot instead of replaying from the beginning. This mirrors how Kafka log compaction works: the compacted log preserves the latest value per key, not the full history.

For agent memory systems specifically, compaction has additional semantics: the in-memory context window gets compacted (summarized) while the full JSONL history is retained. This means you can always reconstruct what the agent was thinking at any point, even though the agent itself was operating on a compressed context.

### Schema Evolution

JSONL files accumulate across sessions, potentially across software versions. Old files may not match new schemas. Two safe approaches:

1. **Additive-only schema changes**: never remove or rename fields, only add new optional ones. Readers always handle missing fields gracefully.
2. **Version in the envelope**: include a `"v": 2` field in every event. Readers dispatch to version-specific parsers. This costs 2 bytes per event but eliminates migration headaches.

## Practical Implications for Zylos

Given this week's work on API token auth, SSE revalidation, and JSONL pipeline migration, several of these patterns apply directly:

**SSE + JSONL integration**: The pattern of JSONL-as-append-only-log combined with SSE-as-live-stream is exactly the AgentLog model. Each SSE event broadcast corresponds to a JSONL line write. The JSONL file becomes the durable record; SSE is the ephemeral live feed. If an SSE client disconnects and reconnects, it can request replay from an offset — the JSONL file provides that offset capability.

**Auth event logging**: Authentication lifecycle events (token issued, validated, revoked, expired) are prime candidates for the operational surface. Writing these to `auth_events.jsonl` gives an auditable trail that can be replayed to reconstruct what auth state looked like at any point — useful for debugging token expiry races without relying on in-memory state reconstruction.

**Pipeline migration validation**: During a JSONL pipeline migration, you can run old and new pipelines in parallel, both writing to separate JSONL files, and diff the outputs. Because each line is self-contained, line-by-line diffing with `diff <(jq .data old.jsonl) <(jq .data new.jsonl)` surfaces semantic differences that would be invisible in binary formats.

## References

- [AgentTrace: A Structured Logging Framework for Agent System Observability](https://arxiv.org/html/2602.10133v1) — arxiv.org, February 2026
- [AgentLog: Lightweight Event Bus for AI Agents on Append-Only JSONL](https://github.com/sumant1122/agentlog) — GitHub
- [I Can Now Replay Any AI Agent Stream from Production](https://dev.to/abhishek_chatterjee_33b9d/i-can-now-replay-any-ai-agent-stream-from-production-heres-how-4bg4) — DEV Community
- [AI Agent Observability: Tracing, Logging, and Monitoring with OpenTelemetry](https://callsphere.ai/blog/ai-agent-observability-tracing-logging-monitoring-opentelemetry-2026) — CallSphere Blog, 2026
- [LLM Observability with OpenTelemetry: A Practical Guide](https://agenta.ai/blog/the-ai-engineer-s-guide-to-llm-observability-with-opentelemetry) — Agenta, 2025
- [Observability: Unify Lifecycle/Runtime/Agent Logs into Correlated Event Stream](https://github.com/ComposioHQ/agent-orchestrator/issues/1457) — ComposioHQ GitHub Issue
