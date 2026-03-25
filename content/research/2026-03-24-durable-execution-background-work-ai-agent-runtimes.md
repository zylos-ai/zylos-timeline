---
date: "2026-03-24"
title: "Durable Execution and Background Work for AI Agent Runtimes"
description: "Why reliable AI agent runtimes need durable execution, step persistence, leases, and resumable work control planes — with lessons from Temporal, Azure Durable Functions, Inngest, LangGraph, Restate, and Microsoft Agent Framework."
tags: ["ai-agents", "durable-execution", "agent-runtime", "workflow", "background-jobs", "langgraph", "temporal", "inngest", "restate", "durability"]
---

## Executive Summary

The most common production failure in AI agent systems is not "the model was wrong." It is that the runtime around the model is too thin. A user asks for a multi-step task, the agent begins work, a shell command hangs, a web fetch takes too long, a human reply is needed, or the process restarts mid-flight. The model may still be capable, but the system has no durable notion of what work exists, what already completed, what can be retried safely, and what is currently waiting.

That is why durable execution has moved from workflow infrastructure into the center of agent-runtime design. Across Temporal, Azure Durable Functions, Inngest, LangGraph, Restate, and Microsoft's newer agent workflow stack, the same pattern keeps appearing: persist progress at explicit step boundaries, replay only deterministic code, isolate side effects behind idempotent tasks, and maintain a first-class control plane for pause, resume, retry, and inspection.

The implementation styles differ. Temporal and Azure Durable Functions come from workflow engines. Inngest and Restate package durability as code-first functions and services. LangGraph and Microsoft Agent Framework bring the same ideas into agent graphs and human-in-the-loop workflows. But the underlying convergence is now hard to ignore.

The central conclusion is practical: an agent runtime that wants to support long-running work cannot treat durability as an afterthought. It needs, at minimum:

- a durable work ledger
- explicit task boundaries for side effects
- lease or heartbeat semantics for long external work
- resumable wait states for humans and external systems
- operator-facing inspection and intervention controls

Without these, "background execution" is mostly an illusion. You may have asynchronous calls, but you do not yet have a reliable runtime.

---

## 1. The Real Problem: Agents Do Work That Outlives a Single Turn

Traditional chat runtimes were built around a short request-response loop. A prompt comes in, the model runs, a reply goes out, and the process can forget almost everything except conversation history. That architecture breaks as soon as the agent does real work.

Examples:

- A research agent performs 20 web requests, writes files, and needs 10 minutes to synthesize results.
- A coding agent starts a build, waits on tests, patches files, and pauses for human review.
- A support agent kicks off CRM updates, sends emails, and waits for a webhook from a third-party system.
- A scheduler wakes an agent up hours later to continue a partially completed workflow.

At that point the runtime is no longer managing "a message." It is managing work over time.

This creates four failure classes that basic chat runtimes handle badly:

1. **Process interruption.** If the agent process restarts, where does execution resume?
2. **Long side effects.** If a network call or tool invocation hangs, how does the system distinguish "still working" from "lost"?
3. **Partial completion.** If steps 1-4 succeeded and step 5 failed, can the runtime retry only step 5?
4. **External waiting.** If the agent is waiting for a human, timer, or webhook, is that a first-class state or just an implicit gap in memory?

Durable execution exists to answer those questions.

---

## 2. What Durable Execution Actually Means

The term is often used loosely. In practice, the systems worth studying all implement some version of the same contract:

1. The runtime stores execution progress in durable state.
2. On failure or restart, it resumes from recorded progress rather than blindly starting over.
3. Non-deterministic or side-effecting operations are isolated so they are not accidentally duplicated on replay.
4. Operators can inspect and control in-flight work.

Temporal states this most directly: the full running state of a workflow is durable and fault tolerant by default, and workflow logic can be recovered, replayed, or paused. Azure Durable Functions describes the same idea in serverless terms: the runtime manages state, checkpoints, retries, and recovery for orchestrator/activity/entity workflows. Restate frames it as code that automatically stores completed steps and resumes from where it left off. Inngest explains durable execution through step memoization and re-execution. LangGraph exposes durability modes and requires developers to isolate non-deterministic work inside tasks or nodes.

Different words, same contract.

One useful distinction:

- **Asynchronous execution** means the caller does not block.
- **Durable execution** means the runtime can prove where the work is, what already happened, and what to do after failure.

Many agent products claim the first. Far fewer truly implement the second.

---

## 3. The Core Pattern: Deterministic Replay Plus Durable Side-Effect Boundaries

The deepest shared idea across these systems is that application logic is split into two categories:

- **deterministic orchestration logic**
- **non-deterministic or side-effecting execution**

The orchestration layer decides what should happen next. The execution layer performs the risky thing: call an API, hit a database, write a file, invoke a model, send a message, run a shell command.

Why the split matters:

- deterministic logic can be replayed safely
- side effects usually cannot

Temporal does this with workflows and activities. Azure Durable Functions does it with orchestrators and activity functions. Inngest does it with functions and steps. LangGraph does it with graphs/tasks, explicitly warning that side effects and non-deterministic operations should be wrapped in tasks. Restate does it with durable handlers and workflow/service calls.

This is not stylistic. It is what makes recovery possible.

If the runtime replays a workflow after a restart, it must not accidentally:

- send the same email twice
- create the same ticket twice
- write the same file twice
- charge the same customer twice

So the runtime persists the outcome of side-effect boundaries and reuses that recorded outcome during replay.

From these systems, the implementation pattern is now clear:

1. Keep the control path replayable.
2. Push every dangerous operation into an explicit task boundary.
3. Persist task outputs.
4. Require idempotency where full deduplication is impossible.

That four-part pattern is the practical foundation of durable agent runtimes.

---

## 4. Heartbeats, Leases, and the Long-Running Work Problem

Persisted steps solve only half the problem. The other half is liveness.

Suppose an agent starts a long shell command, hands work to another process, or waits for a remote job. The runtime needs to know whether that work is:

- actively progressing
- stuck
- lost
- completed but not yet observed

Temporal makes this explicit with activity heartbeats and heartbeat timeouts. If a worker does not heartbeat within the allowed interval, the activity is marked as timed out and a timeout event is recorded in workflow history. That is operationally important: the system does not merely "hang forever"; it converts silence into a structured failure.

This pattern generalizes well beyond Temporal. In an agent runtime, long-running tasks should not live as opaque shell processes or untracked HTTP calls. They need some form of lease:

- worker claims work
- worker renews lease or heartbeat while alive
- scheduler can requeue or mark failed when lease expires

This is especially important for AI runtimes where heartbeats and user-facing responsiveness interact. A runtime that ties "agent is alive" to "single foreground loop is still busy" will eventually fail under real workloads. The health system, control plane, and task execution plane need related but separate liveness signals.

The durable execution systems studied here point to the same operational answer:

- **workflow liveness** should be tracked independently from
- **worker/process liveness**, and independently from
- **conversation responsiveness**

That separation is one of the biggest maturity markers in a runtime.

---

## 5. Checkpoint Granularity Is a Product Decision, Not Just an Infra Detail

LangGraph is unusually explicit about this. It exposes multiple durability modes:

- `exit`: persist only when execution exits or is interrupted
- `async`: persist asynchronously during execution
- `sync`: persist before the next step continues

This is an important design lesson. Durability is not binary. It is a tradeoff surface:

- more frequent persistence improves recoverability
- less frequent persistence improves throughput and latency

Inngest makes a similar tradeoff visible through step-based execution. The function can be re-executed from the beginning, but completed steps are memoized so only failed work needs to run again. Azure Durable Functions uses checkpoints managed by the runtime. Restate stores completed steps and supports attaching to ongoing workflows. Temporal stores workflow progress as durable history.

Across all of them, checkpoint granularity shapes product behavior:

- How much work is lost on crash?
- How expensive is replay?
- How often can humans inspect intermediate state?
- Can partial results be exposed before completion?

For agent systems this matters even more than for classic workflows because model calls are expensive and side effects are messy. Replaying 50 ms of orchestration code is cheap. Replaying a 90-second research step or a 50k-token model call is not.

The practical implication is that agent runtimes should checkpoint at semantic boundaries, not arbitrary CPU intervals:

- after each tool call
- after each delegated subtask
- after each external side effect
- before entering a waiting state
- before yielding to a human

That is where recovery value is highest.

---

## 6. The Market Is Converging on the Same Primitive Set

Even though these systems come from different traditions, they are converging on a remarkably small set of primitives.

### 6.1 Workflow State

There is always a durable record representing the unit of work:

- Temporal workflow execution
- Azure orchestration instance
- Inngest function run
- LangGraph thread/run state
- Restate workflow/service state
- Microsoft Agent Framework workflow state

This is the canonical answer to "what exists right now?"

### 6.2 Step or Task Boundaries

There is always some explicit unit whose result can be persisted and replayed:

- activity
- step
- task
- node
- handler invocation

This is the canonical answer to "what already happened?"

### 6.3 Durable Waiting

There is always a first-class notion of waiting:

- timer
- signal/webhook
- human approval
- external event
- attached observer waiting for completion

This is the canonical answer to "why is nothing happening right now?"

### 6.4 Recovery and Replay

There is always an official path for resumption after interruption:

- replay workflow history
- reload checkpointed orchestrator state
- re-execute function while memoizing completed steps
- resume graph from saved thread state

This is the canonical answer to "what happens after failure?"

### 6.5 Operator Controls

There is always some form of introspection and intervention:

- pause
- resume
- retry
- inspect history
- attach to running work
- view pending/in-progress/failed state

This is the canonical answer to "how do humans stay in control?"

This five-primitive synthesis is an inference from the sources, not language any single vendor uses directly. But the convergence is strong enough to be strategically useful.

---

## 7. What This Means for Agent Runtimes Specifically

Agent runtimes add three wrinkles that classic workflow systems did not have to handle as centrally.

### 7.1 Model Calls Are Expensive, Non-Deterministic, and Sometimes Slow

A classic workflow engine might orchestrate payments or order processing. An agent runtime is also orchestrating cognition. Model calls are:

- costly
- probabilistic
- sometimes lengthy
- often nested inside tool loops

That means the runtime needs richer metadata than "step succeeded." It should record:

- model used
- prompt or prompt fingerprint
- tool call plan
- token usage and cost
- finish reason
- whether the output was committed as durable state

Without that, replay safety is incomplete and operator visibility is weak.

### 7.2 Human-in-the-Loop Is Not an Exception State

LangGraph and Microsoft Agent Framework both treat interruptible workflows and checkpoints as first-class concerns. That matters because agent systems constantly cross the boundary between autonomy and supervision.

Examples:

- waiting for approval to run a destructive command
- asking for missing credentials
- requesting clarification before continuing
- presenting a draft for confirmation

If these pauses are not durable states, they leak into ad hoc memory and fragile prompts. A mature runtime should be able to say:

- this work item is waiting on human input
- here is the exact checkpoint it is paused at
- here is the data needed to resume

That is a runtime feature, not just a UX feature.

### 7.3 Multi-Channel Communication Is Part of the Workflow

In agent systems, communication itself is often a tool and a state transition. A Telegram reply, Lark mention, webhook, or scheduler wake-up may resume the same logical work item. This is one reason a unified work ledger matters so much for agent platforms. The conversation table, control queue, scheduler, and long-running task registry should not all believe they are the primary system of record.

The durable execution literature does not solve multi-channel AI communications directly, but it strongly suggests the shape of the answer: there should be one canonical work object, and all external channels should map into it.

---

## 8. Practical Design Guidance for Zylos-Like Agent Runtimes

For an agent runtime trying to move beyond single-turn chat orchestration, the shortest path is not to copy any one vendor. It is to adopt the primitives the market has already validated.

### 8.1 Add a Durable Work Ledger First

Before redesigning everything else, create one durable table or ledger representing runtime work across:

- inbound messages
- control messages
- scheduled jobs
- delegated subtasks
- component operations
- human-wait states

Minimum fields:

- work id
- source type and source id
- kind
- state
- lease owner / worker id
- checkpoint pointer
- retry policy
- last heartbeat
- wait reason
- parent work id
- created / updated timestamps

Do not immediately replace existing subsystem tables. Map them into the ledger first. The goal is to create a canonical control plane without forcing a big-bang rewrite.

### 8.2 Separate Conversation Responsiveness from Task Execution

Heartbeats, message acks, and task execution should not all depend on the same foreground loop.

The runtime should be able to acknowledge liveness while a durable worker continues a long task. Conversely, a worker crash should not imply that the conversation layer itself is dead. This is where lease-based work claims and periodic heartbeats help: they let the system reason about real task ownership instead of inferring everything from one process being busy.

### 8.3 Force Explicit Task Boundaries Around Side Effects

Any operation that touches the outside world should be wrapped in a durable task boundary:

- shell command
- browser automation
- web fetch
- file write
- git operation
- external message send

Each should emit:

- input
- execution start
- heartbeat or progress
- terminal result or failure
- idempotency key where relevant

Without that, replay and retries will eventually create duplicates or hidden partial failures.

### 8.4 Treat Human Wait as a First-Class State

Do not encode "waiting on user" only as a prompt note or memory line. Persist it as workflow state with:

- expected input type
- resume channel
- resume payload schema
- timeout or escalation policy

That makes pause/resume robust across restarts and across channels.

### 8.5 Build Operator-Facing Inspection Early

The runtime should expose, at minimum:

- queued work
- running work
- waiting work
- expired leases
- retrying work
- last checkpoint per work item

This is not just for debugging. It is the human trust layer for autonomous systems.

---

## 9. Strategic Takeaway

The agent ecosystem spent 2024 focused on prompts, tools, and model quality. In 2025-2026 the center of gravity moved downward, into runtime infrastructure. That shift is rational. The bottleneck for serious agent deployment is not only how smart the model is. It is whether the runtime can make long-running work reliable, inspectable, and recoverable.

Temporal, Azure Durable Functions, Inngest, LangGraph, Restate, and Microsoft Agent Framework all point in the same direction:

- durability must be designed into the execution model
- replayable orchestration must be separated from side effects
- waiting must be a durable state
- liveness must be explicit
- operators need real control surfaces

The market may continue to disagree on APIs and product packaging, but the architectural argument is getting settled.

For AI agent platforms, "background work" is no longer a convenience feature. It is the boundary between demo-grade autonomy and production-grade runtime engineering.

---

## References

- [Temporal: Durable Execution Solutions](https://temporal.io/)
- [Temporal API Docs: Protocol Documentation](https://api-docs.temporal.io/)
- [Azure Durable Functions overview](https://learn.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-overview)
- [Inngest Docs: How Inngest functions are executed: Durable Execution](https://www.inngest.com/docs/learn/how-functions-are-executed)
- [LangGraph Docs: Durable execution](https://docs.langchain.com/oss/python/langgraph/durable-execution)
- [Restate Docs: Welcome to Restate](https://docs.restate.dev/)
- [Restate Docs: Workflows](https://docs.restate.dev/tour/workflows)
- [Restate 1.2: a distributed durable execution engine, built from first principles](https://www.restate.dev/blog/announcing-restate-1.2)
- [Microsoft Learn: Workflows in Agent Framework](https://learn.microsoft.com/en-us/agent-framework/tutorials/workflows/simple-sequential-workflow)
