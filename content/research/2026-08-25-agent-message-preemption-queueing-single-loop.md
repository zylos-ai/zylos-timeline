---
date: "2026-08-25"
title: "Message Preemption, Queueing, and Interrupt Semantics for Single-Threaded Agent Loops"
description: "How an agent with one foreground reasoning loop can separate steering, deferred work, cancellation, and parallel execution without corrupting in-flight side effects."
tags: ["ai-agents", "concurrency", "scheduling", "dispatcher", "human-in-the-loop", "actor-model"]
---

## Executive Summary

An agent may have background tools and subagents, yet still expose one foreground reasoning loop. When a new message arrives during that loop, four different actions are possible: steer the active turn, defer a later turn, cancel the active work, or route the message to another session. Those actions are not interchangeable. Each has different guarantees for latency, durability, ordering, and side effects.

The survey does not support a universal rule such as “owner DMs always interrupt” or “webhooks may be dropped.” The safer design is two-stage: ingress records the message and its delivery contract; the runtime then chooses an action using urgency, latency target, durability and redelivery guarantees, side-effect state, idempotency, and available isolation. The lane table below is therefore a design hypothesis, not a property inherited from Temporal, actor systems, or any SDK.

## Scope and vocabulary

This article concerns one **foreground reasoning loop**, not a process that can do literally only one thing. Tool calls, background commands, and subagents may run concurrently. The scheduling problem is which input may change the foreground loop and when.

- **Steer:** expose new input to the active run at a supported reasoning or tool boundary without starting a new run.
- **Follow up:** retain the input for a later turn after the active run settles.
- **Cancel:** ask the active run to stop. Cancellation does not imply rollback, checkpoint restore, or confirmed reversal of external effects.
- **Parallelize:** route work to another isolated session or worker and reconcile its result later.

These terms describe control-flow choices. Queue durability, acknowledgement, ordering, retry, and deduplication are separate delivery properties.

## What current systems actually provide

### Claude Code: current behavior is boundary-aware queueing, not a timeless default

Current Claude Code interactive-mode documentation says that a message submitted while Claude is working is queued rather than immediately interrupting the turn. If tool calls are running, the message is passed to Claude after those calls finish, within the same turn; remaining entries can become later turns. `Esc` interrupts and immediately supplies queued input. Queued entries can also be taken back with `Up`.

Historical issue reports conflict because they describe different versions and clients. Issue #36326 reported queueing in CLI 2.1.79 while the documentation then promised Enter-to-interrupt. Issue #50246 later described interrupt as the current behavior and proposed queue mode. These reports are useful evidence of product evolution, not a basis for claiming one invariant “Claude Code default” across releases, the terminal, Desktop, and SDK surfaces. A dispatcher integrating Claude Code must pin the client/version it tested and treat the current official interaction reference as the authority for that surface.

### Claude Agent SDK and OpenAI Agents SDK: two different control models

Claude Agent SDK's Python source implements `interrupt()` by sending an SDK control request with subtype `interrupt` to the Claude Code process. That is not documented as a shared `AbortController` propagated by the SDK through every API call, tool, and child agent. Consumers should treat the control response and subsequent result stream as the observable contract, and should verify external state after interruption when a tool may already have run.

OpenAI Agents SDK exposes a different API. `cancel(mode="immediate")` cancels running tasks and clears internal queues; `cancel(mode="after_turn")` sets a flag so the current turn, pending tools, session writes, and usage accounting can finish before the next turn is prevented. The caller should continue consuming `stream_events()` until cancellation settles. These are task cancellation and a turn-boundary stop flag respectively, not proof that one abort signal reached every external API or side effect.

### LangGraph: durable human-in-the-loop pause with node re-entry

LangGraph's `interrupt()` pauses graph execution, saves state through a checkpointer, and resumes when the caller invokes the graph with `Command(resume=...)`. On resume, the containing node starts again from the beginning; code before the interrupt can therefore run again. The official guidance is to make preceding side effects idempotent, put them after the interrupt, or isolate them in separate nodes/tasks.

This is a deliberate durable pause point. It should not be generalized into “arbitrary cancellation resumes from a checkpoint.”

### Temporal: message passing, cancellation, replay, and Reset are separate

Temporal distinguishes three Workflow message types:

- **Query:** a synchronous read request whose handler cannot block; it does not add an Event History entry and can inspect a completed Workflow.
- **Signal:** an asynchronous write; the sender does not await a handler result or error.
- **Update:** a tracked synchronous write. With a start-style API, a client may wait until the Worker is contacted and the Update is persisted (`Accepted`), or until the handler returns (`Completed`).

Cancellation is a separate request to stop a Workflow gracefully; exact propagation and waiting behavior depend on Workflow and Activity cancellation handling. **Replay** reconstructs Workflow state by re-running deterministic Workflow code against recorded Event History. **Reset** terminates the current execution, copies history up to a chosen point into a new execution, and resumes from there; progress after that point is discarded. None of these facts makes Cancel equivalent to “pause now and later resume from the last checkpoint.”

### Erlang and Akka: selection and priority are different mechanisms

An Erlang `receive` selects the first queued message that matches its clauses; unmatched earlier messages remain in the mailbox. That is **selective receive**, not automatic priority. OTP 28 added a distinct opt-in priority-message mechanism (EEP 76): accepted priority messages are inserted ahead of ordinary messages while preserving order within the priority and ordinary regions. The feature uses priority aliases/options and is intended for specific cases, not as a general mailbox policy.

Akka differs again: an actor handles the next dequeued message and does not scan the mailbox for a matching one. A stable priority mailbox uses an explicit `PriorityGenerator` to choose dequeue order while preserving FIFO among equal priorities. This is enough to show that “single consumer” does not dictate one scheduling policy; it does not imply that Erlang selective receive and Akka priority mailboxes offer the same semantics.

### OpenClaw: a documented queue policy, not just routing

OpenClaw's official queue documentation defines four active-run modes: `steer`, `followup`, `collect`, and `interrupt`. The default `steer` mode injects pending input at runtime boundaries when supported; it does not abort an already running tool. `followup` waits for a later turn, `collect` coalesces compatible queued input after a debounce window, and `interrupt` aborts the active run before starting the newest message.

The same documentation defines session overrides, global and per-channel configuration, lane-aware concurrency, debounce, a queue cap, and `summarize`/`old`/`new` overflow policies. This makes OpenClaw direct evidence that an agent gateway can expose queue behavior as explicit policy. It does not prove those defaults fit another dispatcher's workloads.

## Proposed dispatcher model (design hypothesis)

The following is an illustrative policy for a dispatcher feeding one foreground session. It is not a surveyed standard, and source channel alone is insufficient to assign a lane.

| Proposed lane | Candidate action | Preconditions to validate |
|---|---|---|
| Urgent control | Cancel or steer at the next supported boundary | Human intent is unambiguous; latency SLA cannot tolerate a later turn; interrupted side effects are known or reconcilable |
| Active-work guidance | Steer the current run | Runtime accepts steering; input concerns the active work; current tool boundary is safe |
| Deferred work | Follow up as its own turn | Durable queue and acknowledgement exist; deadline and maximum wait are explicit |
| Independent work | Parallel session/worker | State ownership is isolated; output contract and reconciliation owner are defined |

Before choosing among them, record these decision inputs:

1. **Urgency and SLA:** how late is too late, and is that deadline measured to acknowledgement, start, or completion?
2. **Source delivery contract:** is the input durably stored, redelivered, at-most-once, or potentially duplicated? A webhook is not inherently droppable or replayable; that depends on the sender and receiver protocol.
3. **In-flight side-effect state:** which API calls, files, commands, or child tasks may already have committed?
4. **Idempotency and reconciliation:** can retry repeat an effect, and who verifies ambiguous outcomes?
5. **Workload and latency:** expected turn length, tool duration, burst shape, queue depth, and concurrency determine whether steering or parallelism pays.
6. **Scope and isolation:** does ordering apply per session, per user, per channel, or globally, and which state can concurrent workers mutate?

The classifier should persist both the message and these contract fields before attempting delivery. Policy can then evolve without rewriting the authoritative ingress record.

## Cancellation and side effects

Stopping computation and repairing effects are separate obligations:

1. **Before a side effect starts:** cancellation can prevent the operation.
2. **While an external operation is in flight:** the caller may not know whether it committed. Timeout or cancellation is an ambiguous outcome until the target system is read back or reconciled.
3. **After commit:** cancellation cannot undo the effect; compensation or an idempotent follow-up is required.

Therefore “interrupt accepted” must never be treated as “nothing happened.” A safe dispatcher records the active operation, its idempotency key where available, the last durable local state, and the reconciliation action for an unknown outcome. Checkpoint/resume mechanisms help only at boundaries they actually own.

## Recommendations, with assumptions made explicit

1. **Persist first, then schedule.** Acceptance into a durable ledger is separate from when the foreground loop sees the message.
2. **Prefer steering only for related guidance.** Same-turn injection is useful when the runtime supports a clear boundary and the message concerns the active task; unrelated work remains a later turn.
3. **Make cancellation observable.** Record requested, applied, settled, and reconciled separately rather than using one “interrupted” flag.
4. **Use priority only with a starvation rule.** Aging, quotas, or deadlines are candidate mechanisms, but the choice requires workload measurements and an explicit maximum wait.
5. **Parallelize only behind an ownership boundary.** Separate sessions are appropriate when mutable state, output, and reconciliation can be isolated. “Two messages overlapped” is not by itself enough evidence.
6. **Test the full scheduling matrix.** Cover source × urgency × active operation × runtime capability × failure outcome, including duplicate delivery, lost acknowledgement, cancellation during a side effect, and a worker that never reaches the next boundary.

## Open questions

- What are the measured acknowledgement/start/completion SLAs for each class of input?
- Which ingress sources redeliver, and what identifiers make deduplication possible?
- Which tool operations expose idempotency keys or authoritative read-back?
- What is the longest observed interval between safe steering boundaries?
- Does the queue require per-session ordering only, or any cross-session/global constraint?
- At what measured queue depth or latency does an isolated parallel worker become cheaper than waiting?

## Sources

- [Claude Code — Interactive mode: queue messages while Claude works](https://code.claude.com/docs/en/interactive-mode#queue-messages-while-claude-works)
- [Claude Code Issue #36326 — CLI 2.1.79 queueing report](https://github.com/anthropics/claude-code/issues/36326)
- [Claude Code Issue #50246 — interrupt-current / queue-proposed report](https://github.com/anthropics/claude-code/issues/50246)
- [Claude Agent SDK Python — interrupt control request source](https://github.com/anthropics/claude-agent-sdk-python/blob/3379406f18fcea64617d25663d811dfdde8cd171/src/claude_agent_sdk/_internal/query.py#L684-L686)
- [OpenAI Agents SDK — `RunResultStreaming.cancel`](https://openai.github.io/openai-agents-python/ref/result/#agents.result.RunResultStreaming.cancel)
- [OpenAI Agents SDK — running agents and resumable run state](https://openai.github.io/openai-agents-python/running_agents/)
- [LangGraph — interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)
- [Temporal — Workflow message passing](https://docs.temporal.io/encyclopedia/workflow-message-passing)
- [Temporal documentation source — cancellation and Reset](https://github.com/temporalio/documentation/blob/main/docs/develop/dotnet/workflows/cancellation.mdx)
- [Temporal documentation source — Event History and replay](https://github.com/temporalio/documentation/blob/main/docs/encyclopedia/event-history/python.mdx)
- [Erlang — `receive` expressions](https://www.erlang.org/doc/system/expressions.html#receive)
- [Erlang EEP 76 — Priority Messages](https://www.erlang.org/eeps/eep-0076)
- [Akka — actors and mailbox dequeue behavior](https://doc.akka.io/libraries/akka-core/current/general/actors.html)
- [Akka — stable priority mailbox](https://doc.akka.io/libraries/akka-core/current/mailboxes.html#mailbox-configuration-examples)
- [OpenClaw — command queue](https://docs.openclaw.ai/queue)
- [OpenClaw — steering queue](https://docs.openclaw.ai/concepts/queue-steering)
