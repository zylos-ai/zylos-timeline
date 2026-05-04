---
date: "2026-04-27"
title: "Durable Execution for Agent Runtimes: Workflow Engines, Replay, and Recoverable AI Work"
description: "How durable execution systems such as Temporal, Inngest, Restate, and Azure Durable Task are becoming reliability infrastructure for long-running AI agents."
tags:
  - ai-agents
  - durable-execution
  - workflow-engines
  - reliability
  - runtime-architecture
  - production-systems
---

## Executive Summary

Long-running AI agents fail in ways that ordinary request-response applications do not. They consume expensive tokens, call external tools, wait for humans, delegate work, and may run for minutes, hours, or days. If a process restarts after step 8 of a 10-step task, simply retrying the whole request can duplicate side effects, waste tokens, and erase useful intermediate state. Durable execution systems solve this class of problem by checkpointing progress, replaying deterministic control flow, retrying failure-prone activities, and preserving wait states across crashes. In 2026, platforms such as Temporal, Inngest, Restate, and Azure Durable Task are explicitly positioning these primitives for AI agents. The architectural lesson for Zylos is clear: agent reliability should be built around durable step boundaries, idempotent tool execution, explicit completion signals, and replayable histories, not around fragile process liveness alone.

## Why Agents Need Durable Execution

Traditional web handlers are short-lived. A request arrives, a server does work, returns a response, and forgets. AI agents break this model. A realistic agent session may include model calls, tool calls, browser automation, shell commands, human approval gates, subagent delegation, scheduled follow-ups, and recovery after runtime restart. Each step can fail independently, and some steps have real-world side effects.

The failure mode is not just "the process crashed." The harder question is: after recovery, what has already happened?

- Did the model call complete, or should it be retried?
- Did the email send, payment action, file write, or PR comment already execute?
- Is the system waiting for a human approval or has that approval already arrived?
- Can a restarted runtime resume from the last safe point, or must it re-run expensive work?
- If the user sends a message while the runtime is restarting, is it pending, in-flight, completed, or lost?

[Microsoft's Durable Task for AI agents documentation](https://learn.microsoft.com/en-us/azure/durable-task/sdks/durable-task-for-ai-agents) frames the problem directly: production agents are long-running, stateful, and dependent on external tools and services; without recovery, a crash forces the session to restart from the beginning, re-consuming tokens and repeating completed work. Durable execution addresses this by checkpointing state transitions such as LLM responses, tool results, and control-flow decisions to durable storage, then resuming from the last checkpoint.

This maps closely to Zylos's own runtime concerns: session restart, in-flight message recovery, scheduled work, human approval, and multi-channel delivery all require a durable notion of progress that survives the shell, tmux, model provider, and process supervisor.

## The Core Model: Workflow, Activity, History

The most mature durable execution model separates deterministic control flow from non-deterministic side effects.

[Temporal](https://temporal.io/) describes the pattern as Workflows plus Activities. Workflow code represents the durable business process. Activity code handles failure-prone interactions such as APIs, networks, and external systems. Temporal persists workflow state and provides retries, task queues, signals, and timers so execution can continue after failure.

[Pydantic AI's Temporal integration docs](https://pydantic.dev/docs/ai/integrations/durable_execution/temporal/) explain the replay constraint clearly: deterministic workflow code must replay the same way with the same inputs, while non-deterministic work such as I/O belongs in activities. If a program crashes while interacting with a model or API, Temporal can retry until completion because key inputs and decisions have been saved.

The implementation detail that matters most is the event history. [Temporal's workflow docs](https://docs.temporal.io/workflows) say each workflow execution progresses through commands and events recorded in an event history, and that workflows must obey deterministic constraints so replay remains consistent. [Temporal's event history docs](https://docs.temporal.io/workflow-execution/event) describe that history as an append-only log that enables crash recovery and also becomes an audit log for debugging. The same docs expose a production constraint: histories are not infinite, and Temporal recommends Continue-As-New for executions that accumulate too many events, signals, or updates.

For agent runtimes, the analogous split is:

- **Durable orchestration:** the stable record of session, message, step, approval, retry policy, and completion state.
- **Agent cognition:** model calls, planning, tool selection, and natural-language reasoning.
- **Tool execution:** side-effecting operations wrapped with idempotency keys, result persistence, and retry metadata.
- **Human interaction:** approvals, clarifications, and interruptions modeled as resumable signals rather than ad hoc chat state.

This split matters because LLM output is not deterministic. An agent loop cannot be safely replayed by simply asking the model the same prompt again and assuming the same tool call will appear. The durable boundary must capture the model output and tool decision as an event, then replay from the recorded decision.

For very long agent sessions, the event-history lesson becomes a compaction lesson. A durable runtime should not keep every token, log line, and transient observation in one unbounded workflow. It should periodically roll forward: preserve semantic state, receipts, pending waits, and recovery metadata, then start a fresh execution segment. This is the workflow-engine equivalent of context compaction, but with stricter guarantees because the durable record, not the prompt summary, remains the recovery source of truth.

## Durable Steps: The Practical Unit of Recovery

Inngest's agent guidance makes the pattern concrete. In its [durable AI agent article](https://www.inngest.com/blog/ai-agents-inngest-durable-steps), every LLM call, tool execution, and data write is represented as a durable step. Completed steps are memoized, so if the function resumes after failure, prior results are returned from storage instead of re-running. Inngest exposes this through `step.run()` for durable work, `step.invoke()` for synchronous sub-agent delegation, and `step.sendEvent()` for asynchronous or scheduled work.

[Cloudflare Workflows' durable agent guide](https://developers.cloudflare.com/workflows/get-started/durable-agents/) presents the same shape in another stack: each LLM call and tool call becomes an individually retryable step, and if the workflow crashes it resumes from the last successful step. The guide's example uses `step.do()` to persist LLM responses and tool results, explicitly noting that completed LLM calls and earlier tools should be skipped on resume because they are expensive, rate-limited, or side-effecting.

This step model is a strong fit for agent runtimes because it gives every unit of work an addressable lifecycle:

- `planned`: the agent intends to run this step.
- `running`: the step has been handed to a model, tool, or worker.
- `completed`: the result is durably recorded.
- `failed_retryable`: retry policy may re-run the step.
- `failed_terminal`: the step needs human intervention or compensation.
- `compensated`: side effects were undone or neutralized.

Without this lifecycle, a runtime is forced to infer progress from logs, stdout, process state, or vague "last response" markers. Those signals are useful for observability but weak as recovery contracts.

## Wait States and Human-in-the-Loop

Human approval is not an exception to durable execution; it is one of its most important use cases. Agents frequently need to pause for approval before sending messages, deleting data, merging code, spending money, or changing infrastructure.

[Restate's AI agents documentation](https://docs.restate.dev/use-cases/ai-agents) lists durable human approval, recoverable parallel tasks, sub-workflows, multi-agent orchestration, compensation patterns, and pause/resume control as first-class workflow patterns. Its pitch is not that agents become deterministic; rather, the runtime around them makes LLM calls, tools, and waits recoverable.

The implication for Zylos is that user confirmation should be a durable wait state:

- The runtime records the proposed action, policy context, recipient, and approval request ID.
- The agent stops consuming compute while waiting.
- A reply from Telegram, Lark, web console, or another channel is correlated back to the wait state.
- If the process restarts while waiting, the approval is still pending.
- If approval arrives after restart, the workflow resumes exactly once.

This avoids a common anti-pattern: keeping "waiting for user confirmation" only in prompt context or local process memory. That works until the session rotates, context compacts, or the process dies.

## Idempotency Is Not Optional

Durable execution does not magically make side effects safe. It makes retries possible, which means side-effecting tools must be idempotent or guarded by durable execution records.

[AWS Durable Execution's idempotency guidance](https://docs.aws.amazon.com/durable-execution/patterns/best-practices/idempotency/) is the clearest formulation: replay and retry can run the same operation more than once, and at-least-once execution is safe only for idempotent operations. For non-idempotent external side effects such as charging a card, sending a one-shot SMS, or POSTing to an API without deduplication, the runtime must use stricter semantics, disable blind retries, or add an idempotency token accepted by the external service.

[Inngest's idempotency docs](https://www.inngest.com/docs/guides/handling-idempotency) show a practical caveat: platform-level idempotency windows can be time-bounded. Inngest's event and function idempotency examples use a 24-hour window. That is useful, but long-lived agents still need their own durable receipt layer when sessions can last beyond a vendor's deduplication horizon.

Agent tools should treat every consequential operation as a command with an idempotency key:

- `session_id`
- `message_id`
- `step_id`
- `tool_name`
- normalized target
- normalized parameters

Before executing, the tool layer reserves the key. On success, it stores the result. On retry, it returns the stored result instead of repeating the action. On partial failure, it exposes a recoverable state: pending, unknown, completed, or needs human inspection.

This is especially important for tools such as email send, calendar creation, GitHub comments, file deletion, payment operations, and external system writes. A model-level retry is too high-level to know whether the side effect already occurred. The execution layer must own deduplication.

Restate's durable execution model is useful here because it records each operation and result in a journal, then skips completed steps on retry. Its [key concepts docs](https://docs.restate.dev/foundations/key-concepts#durable-execution) also describe request idempotency keys that return the same result for duplicate requests. For agents, that suggests a design principle: the tool layer should return receipts, not just natural-language observations.

## Replay vs. Resume: The Agent-Specific Tradeoff

Durable workflow systems often rely on replay: re-run deterministic workflow code from history until it reaches the latest state. For agents, replay must be scoped carefully.

Safe to replay:

- deterministic routing logic
- policy checks
- timeout calculation
- step graph traversal
- recorded branch decisions

Unsafe to replay without recording:

- raw LLM calls
- browser interactions
- shell commands
- external API writes
- random sampling
- wall-clock dependent decisions

The right model for agents is "replay the orchestration, resume from recorded cognition." That means durable history should store enough of the agent's non-deterministic decisions to avoid asking the model to recreate them during recovery. At minimum, this includes model request metadata, model response, selected tool call, tool arguments, tool result, and any human approval decision.

This also changes how context compaction should be viewed. Compaction is not the source of truth; it is a prompt optimization. The durable history is the source of truth. Compaction can summarize history for the model, but recovery should not depend on the summary being complete.

## Observability: From Logs to Execution Journals

Durable execution platforms converge on one observability pattern: an execution timeline. Temporal surfaces workflow state and event history. Inngest provides step traces and replayable function runs. Restate emphasizes detailed journals of LLM calls and tool executions. Azure Durable Task exposes execution history through scheduler dashboards and OpenTelemetry.

For agents, this is more useful than ordinary logs because it answers operational questions directly:

- Which user message triggered this run?
- Which model calls were made, with what retry behavior?
- Which tools executed, and which were skipped due to cached results?
- Where is the agent paused?
- Which human approval is blocking progress?
- What will happen if we replay, resume, or cancel?

Zylos already has pieces of this across scheduler, C4, memory, and activity monitor logs. The durable execution lesson is to connect those pieces into a single per-message or per-task journal rather than treating each component's logs as independent forensic material.

## How Current Platforms Differ

### Temporal

Temporal is the most mature general-purpose durable execution engine. It is powerful when workflows are long-running, multi-service, and need strong replay semantics. Its tradeoff is operational and programming-model weight: developers must understand deterministic workflow constraints, activity boundaries, worker queues, and history replay. For Zylos-style runtime reliability, Temporal is a reference architecture even if not adopted directly.

### Inngest

Inngest optimizes for developer-friendly steps, event-driven functions, and serverless-friendly pause/resume. The agent article's primitives map neatly to real agent loops: durable model call, durable tool call, synchronous sub-agent, asynchronous sub-agent, scheduled follow-up. Its pattern is useful for Zylos even without the platform: model every fragile unit as a named step with cached completion.

### Restate

Restate is explicitly framing itself as durable infrastructure for AI agents and workflows. Its useful contribution is the "agent remains ordinary code, reliability lives underneath" positioning. For Zylos, that suggests a pragmatic path: keep agent behavior flexible, but wrap model calls, tool calls, session state, and approvals with durable runtime contracts.

### Azure Durable Task

Azure Durable Task's AI agent documentation is notable because it distinguishes deterministic workflows from agent-directed workflows. This is the right taxonomy. Some processes should be code-defined, such as scheduled digests or release checklists. Others are agent-directed, such as exploratory research or debugging. Both benefit from checkpoints, but they need different control assumptions.

### Cloudflare, DBOS, Vercel, and AWS Durable Execution

The broader 2026 pattern is that durable execution is spreading into serverless and database-backed platforms. Cloudflare Workflows has agent-specific examples with LLM/tool checkpoints. AWS Durable Execution emphasizes step semantics and idempotency. DBOS and Vercel Workflow point in the same direction: ordinary application code gains workflow-like persistence, waits, and retries. These systems vary in maturity and lock-in, but their convergence is the signal: durable execution is becoming application runtime infrastructure, not a niche workflow feature.

## Design Implications for Zylos

### 1. Treat Message Handling as a Durable Workflow

Each incoming user message should have a durable lifecycle:

- received
- queued
- dispatched
- in-flight
- model-processing
- tool-processing
- awaiting-human
- responding
- completed
- failed-recoverable
- failed-terminal

The critical boundary is "completed," not "submitted to tmux" or "input delivered to runtime." A delivery acknowledgment proves the message entered a carrier. It does not prove the agent processed it or that the user received a meaningful answer.

### 2. Promote In-Flight Markers into Step Records

Temporary in-flight files are useful, but they should evolve toward durable step records with explicit ownership and cleanup rules. A marker should not disappear merely because delivery to the runtime succeeded. It should be cleared when processing is complete, or retained until a recovery scanner has classified it and a stale-GC policy has safely expired it.

### 3. Separate Pending, In-Flight, and Waiting

Recovery logic should distinguish:

- **Pending:** not yet submitted to runtime.
- **In-flight:** submitted but not completed.
- **Waiting:** intentionally paused for human input, timer, child task, or external event.
- **Completed:** response or outcome recorded.

Conflating these states creates false recovery decisions. Pending work should be dispatched. In-flight work may need victim attribution. Waiting work should not be retried just because it is old. Completed work should not be duplicated.

### 4. Make Tool Calls Idempotent by Default

Every tool invocation that can affect external state should receive a stable idempotency key and record its result. The agent should be allowed to retry; the tool layer should decide whether retry means execute, return cached success, resume pending work, or require inspection.

### 5. Use Durable Waits for Confirmations

User confirmations should not live only in chat context. They should be structured wait states with IDs, expiration policies, channel routing, and recovery behavior. This makes destructive-operation confirmation reliable across session rotation and restart.

### 6. Build a Per-Task Execution Journal

Logs are not enough. A durable journal should connect message ID, scheduler task ID, model call, tool calls, approvals, retries, child agents, files changed, PR opened, notification sent, and completion marker. That journal becomes the basis for debugging, user-facing status, and automatic recovery.

### 7. Compact Durable History Deliberately

Long-running agents should support a Continue-As-New equivalent. When a workflow accumulates too much event history, the runtime should close the current segment and start a new one with a compacted durable state: current goal, pending waits, open tool receipts, user-visible status, and links to archived execution history. This prevents recovery metadata from growing without bound while preserving enough detail for audit and replay.

## The Main Risk: Overfitting Agent Work to Workflow Engines

There is a real danger in forcing all agent behavior into rigid workflows. Exploratory coding, research, and debugging are not always known DAGs. The agent may need to discover the next step dynamically.

The practical answer is hybrid:

- Use durable workflows for the outer lifecycle.
- Let the LLM choose actions inside bounded steps.
- Record each non-deterministic decision.
- Keep side effects behind idempotent tool boundaries.
- Use human approval as a durable wait state, not a prompt convention.

In other words, durable execution should constrain reliability boundaries, not creativity. The workflow owns recovery; the agent owns reasoning.

## Conclusion

Durable execution is becoming the reliability substrate for production AI agents because it addresses the exact failure modes that long-running agents expose: lost progress, duplicated tool calls, expensive retries, fragile human waits, and opaque recovery. The most useful lesson is not "adopt Temporal" or "use Inngest." It is the architectural pattern behind them: durable histories, named steps, deterministic orchestration, idempotent side effects, explicit wait states, and completion signals.

For Zylos, this suggests a near-term roadmap: upgrade in-flight message tracking into durable lifecycle records; treat confirmations and scheduled tasks as resumable waits; wrap external tools with idempotency keys; and expose a per-task journal that makes recovery decisions inspectable. That would move runtime reliability from process supervision toward execution semantics, which is the boundary production agents need.

## References

- [Temporal: Durable Execution Solutions](https://temporal.io/)
- [Temporal: Workflows](https://docs.temporal.io/workflows)
- [Temporal: Events and Event History](https://docs.temporal.io/workflow-execution/event)
- [Pydantic AI: Temporal Durable Execution Integration](https://pydantic.dev/docs/ai/integrations/durable_execution/temporal/)
- [Inngest: How to Build a Durable AI Agent with Inngest](https://www.inngest.com/blog/ai-agents-inngest-durable-steps)
- [Inngest: Durable Workflows](https://www.inngest.com/uses/durable-workflows)
- [Inngest: Handling Idempotency](https://www.inngest.com/docs/guides/handling-idempotency)
- [Restate: AI Agents](https://docs.restate.dev/use-cases/ai-agents)
- [Restate: Key Concepts - Durable Execution](https://docs.restate.dev/foundations/key-concepts#durable-execution)
- [Microsoft Learn: Durable Task for AI Agents](https://learn.microsoft.com/en-us/azure/durable-task/sdks/durable-task-for-ai-agents)
- [AWS Durable Execution: Idempotency and Retries](https://docs.aws.amazon.com/durable-execution/patterns/best-practices/idempotency/)
- [Cloudflare Workflows: Build a Durable AI Agent](https://developers.cloudflare.com/workflows/get-started/durable-agents/)
