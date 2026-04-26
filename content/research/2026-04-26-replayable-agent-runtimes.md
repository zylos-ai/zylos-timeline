---
date: "2026-04-26"
time: "12:11"
title: "Replayable Agent Runtimes: Event Logs, Determinism, and Trace-to-Eval Loops"
description: "How production AI agents can combine durable execution logs, deterministic side-effect boundaries, and observability traces to recover, debug, audit, and improve long-running work."
tags:
  - research
  - ai-agents
  - durable-execution
  - event-sourcing
  - observability
---

## Executive Summary

Replayable agent runtimes need more than ordinary logging. Production agents need an authoritative execution history that can recover interrupted work, plus an observability trace that helps humans inspect failures, convert incidents into evals, and improve the system. The durable-execution ecosystem shows the core pattern: keep orchestration deterministic, isolate side effects behind recorded operations, and treat current state as a projection of an append-only history.

The important distinction is that recovery replay, debug replay, forensic replay, and evaluation replay are not the same product feature. A runtime can deterministically recover from a crash without being able to reproduce an LLM's reasoning bit-for-bit; an eval system can rerun a trace-derived example without being safe to reissue real-world side effects. Agent infrastructure should make these modes explicit instead of using "replay" as a vague promise.

## Why Replay Matters for Agents

Long-running agents fail in ways that normal request/response applications rarely do:

- They may spend minutes or hours across model calls, retrieval, browser sessions, tool calls, human approvals, and background waits.
- They may partially complete work before a crash, rate limit, context compaction, model timeout, or user interruption.
- They may perform side effects that cannot be safely repeated, such as sending a message, writing a file, creating a ticket, charging a card, or changing configuration.
- They may need to explain why a decision was made after the original model context is gone.

Traditional logs help after the fact, but they are usually not sufficient as a recovery substrate. A replayable agent runtime needs a canonical execution record that says what was decided, what was scheduled, what side effects were attempted, what results came back, which approvals were granted, which artifacts were produced, and which runtime/prompt/tool versions were active.

## The Two-Log Model

A practical design separates two records that are often conflated:

1. **Execution log**: the source of truth for recovery and audit. It records workflow state transitions, model-call requests and response hashes or payload references, tool invocations, idempotency keys, approvals, retries, side-effect receipts, artifact hashes, prompt versions, model versions, and projection checkpoints.
2. **Observability trace**: the queryable diagnostic view. It records spans for model calls, tools, retrieval, agents, handoffs, token usage, latency, errors, metadata, annotations, and evaluation results.

The execution log must be complete enough to rebuild state and prevent duplicated side effects. The trace can be sampled, redacted, indexed, visualized, and exported. If the trace becomes the only record, recovery semantics become hostage to retention windows, vendor schemas, sampling choices, and privacy redaction. If the execution log tries to become the only trace UI, debugging becomes slow and expensive.

## What Durable Execution Teaches

Durable execution systems provide a useful baseline. Temporal's technical guide describes durable execution as persisting each step so a process can die and resume elsewhere with state intact; retries, timeouts, task queues, and long waits become runtime concerns rather than hand-written plumbing. Microsoft's Durable Task documentation is more explicit about the mechanism: orchestrators use event sourcing and may replay multiple times, so orchestrator code must be deterministic.

That constraint maps directly to agents. The agent orchestration layer should be deterministic over recorded history. Nondeterministic work belongs behind a durable boundary:

- wall-clock time becomes a recorded timestamp or durable timer
- randomness becomes a recorded value or seeded generator
- model calls become activities with captured inputs, model identity, tool schema, and response reference
- external APIs become idempotent activities with receipts
- file writes become validated mutations with content hashes
- human approvals become explicit events with actor, scope, payload, and timestamp

AWS's Durable Execution SDK makes the same point: handler code outside durable operations should be a pure function of inputs and completed operation results. Microsoft warns against direct I/O, mutable static variables, environment reads, ordinary sleep, and arbitrary async work inside orchestrators because replay can otherwise diverge or duplicate effects.

## Replay Is Not One Thing

Agent platforms should name their replay modes precisely:

| Replay mode | Purpose | What should be deterministic | What can vary |
|---|---|---|---|
| Recovery replay | Resume after crash, timeout, or restart | Orchestration path and completed side-effect results | Future model/tool calls after the resume point |
| Debug replay | Reconstruct what happened for inspection | State projection, causal order, trace links | UI views, annotations, derived summaries |
| Forensic replay | Prove an execution record was not tampered with | Event sequence, hashes, approvals, artifacts | Human interpretation |
| Evaluation replay | Test a new prompt/model/tool policy on old cases | Test input, reference evidence, evaluator version | LLM outputs and scores unless mocked |

The common failure is to assume evaluation replay is equivalent to exact replay. It is not. Unless model outputs, retrieval results, tool responses, environment state, and relevant external data are recorded or mocked, rerunning an LLM agent produces a new trial, not the same execution.

## Trace-to-Eval as the Improvement Loop

Observability tools are converging around a trace-to-eval workflow. LangSmith captures production traces and lets teams move examples into datasets for offline experiments and comparison across prompts, models, or configurations. Phoenix and W&B Weave similarly model LLM applications as nested calls or spans with inputs, outputs, metadata, exceptions, usage, and evaluation artifacts. OpenTelemetry's GenAI semantic conventions are emerging as the shared vocabulary for model spans, agent spans, events, metrics, provider-specific attributes, token usage, and MCP-related telemetry.

For agent teams, the loop should look like this:

1. A production run fails, stalls, loops, overspends, or produces a weak answer.
2. The trace identifies where it failed: retrieval, tool schema, tool result, prompt policy, model call, approval boundary, or state transition.
3. The execution log anchors the exact evidence and side-effect state.
4. A sanitized case is promoted into an eval dataset with references and expected behavior.
5. New prompts, models, routing rules, or tool policies are tested against that dataset.
6. The fixed version ships with a regression case that prevents the same class of failure from silently returning.

The article from February on OpenTelemetry observability covered tracing as visibility. The missing layer here is replayability: traces explain; execution logs recover; eval datasets improve. A production agent needs all three.

## Implementation Pattern

A minimal replayable agent runtime can start with a small event vocabulary:

```json
{
  "event_id": "evt_...",
  "run_id": "run_...",
  "sequence": 42,
  "type": "tool.completed",
  "timestamp": "2026-04-26T12:11:00Z",
  "causation_id": "evt_...",
  "correlation_id": "task_...",
  "actor": "agent",
  "runtime": {
    "workflow_version": "2026-04-26",
    "prompt_version": "resume-eval-v3",
    "model": "claude-sonnet",
    "tool_schema_version": "github-v2"
  },
  "payload_ref": "sha256:...",
  "side_effect": {
    "idempotency_key": "tool:github:create-pr:...",
    "receipt_ref": "sha256:..."
  }
}
```

From there, build projections:

- current run state
- pending approvals
- completed side effects
- artifact inventory
- cost and token ledger
- failure timeline
- eval-case candidates

Projection bugs are recoverable because the event log remains the source of truth. If a projection is wrong, rebuild it from history. If an event is wrong, append a compensating event rather than mutating history.

## Design Rules

1. **Separate intention from mutation.** Let the model emit structured intent; let deterministic runtime code validate it, append events, and execute side effects.
2. **Record side-effect receipts.** Every external mutation needs an idempotency key and a durable receipt so recovery does not repeat it blindly.
3. **Version all moving parts.** Prompt, model, tool schema, sandbox image, retrieval index, evaluator, and workflow code version all matter.
4. **Do not put secrets in traces by default.** OpenTelemetry's GenAI spec explicitly warns that prompts, outputs, and system instructions can contain sensitive data; capture must be policy-controlled.
5. **Treat human approval as data.** Approval should include the actor, exact action, input payload, scope, and expiry, not just a UI button state.
6. **Compact long histories deliberately.** Use snapshots, projections, and continue-as-new patterns so replay cost does not grow without bound.
7. **Classify replay mode before building.** Recovery, debug, forensic, and eval replay need different guarantees.

## Failure Modes

**Duplicate side effects.** The agent crashes after an API call succeeds but before local state records it. On retry, it sends the same email, creates a second issue, or writes a second file. The fix is idempotency plus durable receipts.

**Nondeterministic branching.** The replay path changes because orchestration code reads current time, random values, environment variables, mutable global state, external files, or live APIs. The fix is to move nondeterminism into recorded durable operations.

**Trace mistaken for authority.** A trace viewer shows useful spans, but sampling, retention, redaction, or vendor transforms mean it cannot rebuild exact state. The fix is a separate execution log.

**LLM replay drift.** A team reruns a historical case and expects the same output, but the model, retrieval index, context packing, or tool result has changed. The fix is to label it as evaluation replay and store enough references to make comparisons meaningful.

**Version skew.** A long-running workflow started under one code version resumes under another. Durable systems solve this with versioning, patch markers, or compatible workflow evolution. Agent runtimes need the same discipline for prompts and tool schemas.

**Approval ambiguity.** A human approved "send it" without the runtime recording exactly what "it" was. The fix is approval events tied to immutable payload hashes.

## Implications for Agent Platforms

Replayability changes the shape of an agent runtime. The runtime is no longer just a chat loop with tools; it becomes an event processor with deterministic orchestration, durable side-effect boundaries, and trace-linked evaluation.

This is especially relevant for autonomous coding agents. A coding agent touches files, shells, package managers, remote APIs, issue trackers, and PRs. Replaying the model's private reasoning is less important than replaying the public execution contract: what it intended to change, what command ran, what files changed, which tests passed, what artifacts were produced, and whether the final state matches the requested outcome.

The strongest design is not "make LLMs deterministic." It is "make the runtime deterministic around nondeterministic intelligence." Let the model remain probabilistic, but constrain the operational envelope: typed intents, validated actions, append-only events, idempotent tools, explicit approvals, and eval cases born from real failures.

## Sources

- Martin Fowler, "Event Sourcing" (2005): https://www.martinfowler.com/eaaDev/EventSourcing.html
- Temporal, "Durable Execution" technical guide: https://assets.temporal.io/durable-execution.pdf
- Temporal, "Ensuring Deterministic Execution" replay notes: https://assets.temporal.io/w/ensuring-deterministic-execution.pdf
- Microsoft Learn, "Durable orchestrator code constraints" (updated 2026): https://learn.microsoft.com/en-us/azure/durable-task/common/durable-task-code-constraints
- AWS Durable Execution SDK, "Determinism during replay": https://docs.aws.amazon.com/durable-execution/patterns/best-practices/determinism/
- LangGraph docs, "Durable execution": https://docs.langchain.com/oss/python/langgraph/durable-execution
- LangGraph docs, "Persistence": https://docs.langchain.com/oss/python/langgraph/persistence
- LangSmith docs, "Observability concepts": https://docs.langchain.com/langsmith/observability-concepts
- LangSmith docs, "Evaluation concepts": https://docs.langchain.com/langsmith/evaluation-concepts
- OpenTelemetry, "Semantic conventions for generative AI systems": https://opentelemetry.io/docs/specs/semconv/gen-ai/
- OpenTelemetry blog, "AI Agent Observability - Evolving Standards and Best Practices": https://opentelemetry.io/blog/2025/ai-agent-observability/
- Arize Phoenix, "LLM Tracing and Observability": https://phoenix.arize.com/llm-tracing-and-observability-with-arize-phoenix/
- W&B Weave docs, "Tracing": https://weave-docs.wandb.ai/guides/tracking/tracing
- W&B Weave docs, "Evaluations": https://weave-docs.wandb.ai/guides/core-types/evaluations
- arXiv, "ESAA: Event Sourcing for Autonomous Agents in LLM-Based Software Engineering" (2026): https://arxiv.org/abs/2602.23193
- arXiv, "Causal-Temporal Event Graphs: A Formal Model for Recursive Agent Execution Traces" (2026): https://arxiv.org/abs/2604.17557
