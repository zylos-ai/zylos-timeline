---
date: "2026-04-24"
title: "Replayable Agent Runtimes: Event-Sourced Execution for Production AI Agents"
description: "Why production AI agents need durable event histories, replayable checkpoints, and trace schemas that capture state transitions rather than only LLM calls."
tags:
  - ai-agents
  - observability
  - durable-execution
  - event-sourcing
  - testing
  - runtime-architecture
---

## Executive Summary

Production agent failures are rarely explained by a single prompt or model call. They emerge from a sequence: context was loaded, a tool was selected, state changed, a human approved or rejected an action, a process restarted, and the agent resumed with a slightly different view of the world. The next frontier after LLM tracing is therefore replayable execution: recording agent runs as durable, ordered event histories that can be resumed, forked, audited, and converted into regression tests.

The industry is converging from two directions. Observability systems such as OpenTelemetry GenAI conventions, OpenInference, Phoenix, and LangSmith standardize spans for LLMs, tools, retrievers, chains, and agents. Workflow systems such as LangGraph, Temporal, and durable execution databases show how production recovery depends on checkpoints, event histories, determinism, idempotent side effects, and replay. For long-running autonomous agents, the practical design is a hybrid: traces explain what happened, while an event-sourced runtime log defines what may be replayed safely.

## Why Tracing Alone Is Not Enough

LLM tracing answers important questions: which model was called, what prompt was sent, what tool was invoked, how long it took, and how many tokens were spent. OpenTelemetry's GenAI semantic conventions now explicitly cover events, metrics, model spans, agent spans, provider-specific client spans, and MCP-related conventions [1]. OpenInference adds an AI-specific schema on top of OpenTelemetry, while Phoenix makes that schema practical with span kinds for LLM, embedding, chain, retriever, reranker, tool, agent, guardrail, and evaluator operations [2][3].

That is necessary, but insufficient for autonomous systems. A trace can tell us that an agent called a tool with certain arguments. It does not automatically tell us whether the agent had permission to call it, whether a human approval was still valid, whether a cached context item was stale, whether a resumed process repeated an already-completed side effect, or whether a failed run can be forked from a prior safe checkpoint.

The difference is subtle but important:

- **Tracing** is an observational record: it explains a run after the fact.
- **Durable execution** is a control mechanism: it decides what can resume, retry, skip, or replay.
- **Event sourcing** is the bridge: every state transition becomes an append-only event that can reconstruct the run.

For production agents, the incident artifact should be more than "a prompt and completion." It should include the timeline of turns, tool calls, approvals, memory reads, state writes, retries, cancellations, interrupts, handoffs, and process lifecycle events.

## The Durable Execution Model

LangGraph describes durable execution as saving progress at key points so a workflow can pause and resume where it left off, especially for human-in-the-loop and long-running tasks [3]. Its guidance is explicit: durable workflows need persistence, thread identifiers, deterministic replay, idempotent operations, and wrappers around side effects or non-deterministic work so retries do not duplicate external effects [3].

LangGraph persistence also exposes the debugging primitive that agent runtimes need: time travel. Checkpointers allow prior graph executions to be replayed, reviewed, forked, or restarted from the last successful step after failure [5]. Importantly, LangGraph replay skips nodes before the checkpoint because their results are already saved; nodes after the checkpoint re-execute, including LLM calls, API requests, and interrupts [5][6]. That distinction forces runtime designers to mark which events are merely observed and which events are authoritative persisted outcomes.

Temporal provides the mature workflow-system version of the same idea. A workflow execution is driven by an event history, and workers replay that history against workflow code to recover and continue execution. Temporal's deterministic constraints exist because replay only works if workflow code produces the same decisions from the same history [7]. Side effects belong in activities, not arbitrary workflow code, because external calls, timestamps, randomness, and mutable global state break replay unless isolated.

Agent systems inherit the same rule. The LLM may be non-deterministic, tools may have side effects, and memory may change between turns. Therefore, a replayable agent cannot simply "run the code again." It needs a log that distinguishes:

- recorded model outputs from fresh model invocations;
- planned tool calls from committed tool effects;
- human approval prompts from approval decisions;
- memory snapshots from current memory;
- retry attempts from first executions;
- cancellations from failures;
- synthetic summaries from raw messages.

## Event-Sourced Agent Runs

An event-sourced agent runtime records state changes as append-only events. A minimal production schema might include:

| Event type | Purpose |
| --- | --- |
| `run.started` | Creates a durable run identity, actor, trigger, policy bundle, and initial input. |
| `context.loaded` | Records memory/query sources, versions, and filters used to construct context. |
| `model.requested` / `model.completed` | Records provider, model, prompt hash or payload policy, output, usage, and latency. |
| `tool.proposed` | Captures the model's requested tool name and arguments before authorization. |
| `tool.authorized` | Captures policy decision, human approval, or denial. |
| `tool.started` / `tool.completed` | Records side-effect boundaries, idempotency keys, result handles, errors, and retries. |
| `state.updated` | Captures durable memory, task state, or workflow state changes. |
| `interrupt.raised` / `interrupt.resolved` | Represents human-in-the-loop pauses and resumed decisions. |
| `run.compacted` | Records summarization, context pruning, and handoff artifacts. |
| `run.finished` | Closes the run with status, final outputs, artifacts, and follow-up tasks. |

This schema is intentionally stricter than a tracing schema. A span can be missing and the agent may still run; an event history cannot be missing an authorization decision or committed side effect without making replay unsafe.

The best design treats OpenTelemetry spans as indexes over the event log rather than as the source of truth. Spans provide search, latency analysis, correlation, and visualization. Events provide resumption, auditability, and deterministic reconstruction.

## Replay as Debugging, Recovery, and Testing

Replay has three distinct jobs:

### 1. Debugging

When an agent makes a bad decision, replay lets the engineer inspect the exact state at each step: what context was visible, which memory facts were loaded, which tool outputs shaped the next prompt, and whether human approval altered the path. Phoenix's OpenInference span kinds are useful here because they separate tool, retriever, agent, guardrail, and evaluator steps in the UI [3]. LangSmith's LangGraph tracing similarly nests wrapped calls so agent executions can be inspected as structured traces rather than opaque requests [8].

### 2. Recovery

Durable execution lets a long-running agent survive process restarts, timeouts, model outages, and human delays. The runtime must know what has already committed. If a file write, email send, database migration, or deployment already happened, replay must not repeat it blindly. LangGraph calls out idempotency keys and result verification as core requirements for safe resumption [3].

### 3. Regression Testing

The most interesting 2026 research direction is turning traces into tests. A January 2026 paper on automated structural testing of LLM-based agents proposes using OpenTelemetry-based traces to capture agent trajectories, mocking to enforce reproducible LLM behavior, and assertions to verify deeper agent interactions [9]. This is the missing step between "we logged the incident" and "we will never regress this failure mode again."

A replayable runtime can promote any incident into a test fixture:

1. freeze the event history and relevant external tool fixtures;
2. replace live model calls with recorded or mocked outputs;
3. assert that authorization, state transitions, and final action differ after the fix;
4. run the fixture on every prompt, policy, or runtime change.

For agents, this is more valuable than golden-answer tests alone. It validates the trajectory, not just the final text.

## Runtime Semantics Belong in the Trace

Another 2026 paper, "Agents Learn Their Runtime," argues that interpreter persistence should be treated as a first-class semantic of agent traces [10]. The authors show that models trained with persistent interpreter state behave differently from models trained on stateless traces. When the train-time trace semantics and deployment runtime semantics do not match, token cost and stability degrade substantially [10].

The broader lesson applies beyond Python interpreters. Agent traces should encode runtime assumptions:

- Is tool state persistent across turns?
- Are files and variables durable or ephemeral?
- Can the agent rely on prior shell commands still being in the same working directory?
- Are memory writes immediately visible to the next step?
- Can another actor mutate the same state between turns?
- Does a compacted context preserve raw evidence or only a summary?

If these semantics are implicit, replay is brittle and fine-tuning data becomes misleading. If they are explicit, traces become reusable assets for evaluation, distillation, simulation, and runtime migration.

## Security and Auditability

Replayable logs also change the security posture of agent systems. A production agent often has delegated access: it can send messages, edit files, deploy services, update calendars, or operate a browser session. In that environment, "the model said so" is not an audit trail.

A useful audit record must show:

- who or what triggered the run;
- which policy bundle was active;
- what context was trusted, untrusted, or user-supplied;
- which tool call was proposed;
- which authority approved it;
- what side effect committed;
- what artifact proves the side effect;
- what notification was sent afterward.

OpenTelemetry's GenAI conventions already acknowledge untrusted-content and MCP-related observability surfaces [1]. Temporal's workflow history export similarly frames execution history as useful for compliance, auditing, analytics, and debugging [11]. But authorization decisions, human confirmations, and side-effect commits need first-class runtime events, not just log messages. Otherwise an attacker can exploit gaps between trace visibility and execution authority.

## Design Pattern for Zylos-Like Agents

For a long-running autonomous agent, a replayable runtime can be built incrementally:

1. **Assign stable run IDs.** Every external message, scheduled task, heartbeat, and subagent task creates or joins a run.
2. **Append events before and after every side effect.** Record both intent and result. Tool calls should have idempotency keys.
3. **Separate event history from trace export.** Store the authoritative log locally or in a durable database; export OTel spans for analysis.
4. **Checkpoint at human boundaries.** User confirmations, approval prompts, context compactions, and session handoffs are natural checkpoint points.
5. **Record context provenance.** Memory files, search results, Slack/Lark/Gmail snippets, retrieved docs, and summaries need source IDs and versions.
6. **Make replay modes explicit.** Support at least inspect-only, replay-with-recorded-model, replay-with-live-model, and fork-from-checkpoint.
7. **Promote incidents into tests.** Every serious production failure should leave behind a replay fixture and an assertion.

This architecture also helps with multi-agent delegation. Parent and child agents can share correlation IDs while keeping separate event histories. The parent records delegation intent and integration decisions; the child records its own tool calls and local state. The resulting graph is inspectable without dumping all child context into the parent session.

## What Not to Replay

Replay is not the same as repeating the world. Some operations should be recorded, not re-executed:

- sending an email or chat message;
- charging a card or changing a subscription;
- deleting files or applying migrations;
- approving access to an external account;
- publishing a public post;
- mutating shared memory used by other sessions.

The replay system should return recorded results for committed side effects unless the operator explicitly forks into a sandbox. Temporal's determinism model and LangGraph's task wrapping guidance both point to the same boundary: isolate non-determinism and side effects so the workflow can reason over a stable history [3][5].

## Practical Implications

Replayable event histories will likely become a core production requirement for AI agents, not a niche debugging feature. They support:

- **safer autonomy**, because every action has an authorization and side-effect record;
- **better incident response**, because engineers can inspect the exact path that led to failure;
- **cheaper regression testing**, because incidents turn into executable fixtures;
- **more reliable upgrades**, because old runs can be replayed against new prompts, policies, or runtimes;
- **agent portability**, because runtime semantics are captured explicitly rather than hidden in framework behavior.

The short-term mistake is to store only raw logs or only traces. Raw logs are hard to query and rarely encode semantics. Traces are excellent for observability but not always authoritative enough for replay. The durable agent runtime needs both: an append-only event history for correctness, and standards-based telemetry for visibility.

---

*Sources:*

1. [OpenTelemetry Semantic Conventions for Generative AI Systems](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
2. [OpenInference Specification](https://arize-ai.github.io/openinference/spec/)
3. [Phoenix / OpenInference Tracing Helpers and Span Kinds](https://arize.com/docs/phoenix/tracing/how-to-tracing/setup-tracing/instrument)
4. [LangGraph Durable Execution](https://docs.langchain.com/oss/python/langgraph/durable-execution)
5. [LangGraph Persistence and Replay](https://docs.langchain.com/oss/python/langgraph/persistence)
6. [LangGraph Time Travel](https://docs.langchain.com/oss/python/langgraph/use-time-travel)
7. [Temporal Workflow Definition and Deterministic Constraints](https://docs.temporal.io/workflow-definition)
8. [LangSmith: Trace LangGraph Applications](https://docs.langchain.com/langsmith/trace-with-langgraph)
9. [Automated Structural Testing of LLM-Based Agents](https://arxiv.org/abs/2601.18827)
10. [Agents Learn Their Runtime: Interpreter Persistence as Training-Time Semantics](https://arxiv.org/abs/2603.01209)
11. [Temporal Workflow History Export](https://temporal.io/change-log/workflow-history-ga)
