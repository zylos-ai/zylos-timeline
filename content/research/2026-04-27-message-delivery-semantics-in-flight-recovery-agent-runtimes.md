---
date: "2026-04-27"
title: "Message Delivery Semantics and In-Flight Recovery for Long-Running Agent Runtimes"
description: "How AI agent runtimes should define acknowledgment boundaries, in-flight leases, idempotency, and recovery paths so user messages and tool side effects survive crashes, restarts, and model failures."
tags:
  - ai-agents
  - runtime-architecture
  - reliability
  - message-queues
  - durable-execution
  - idempotency
---

## Executive Summary

Long-running AI agents are message-processing systems before they are reasoning systems. A user message enters through Telegram, Slack, Lark, email, a web console, or a scheduler. A bridge stores it, dispatches it to a runtime, the runtime calls an LLM, the LLM requests tools, tools mutate external state, and a final response is delivered through another channel. Every one of those transitions can fail after the previous layer believes it has succeeded.

This makes delivery semantics a first-class agent runtime concern. The core lesson from mature queueing and workflow systems is not that agents should chase global exactly-once delivery. They should design for at-least-once delivery and exactly-once effects only at carefully controlled state boundaries. Google Pub/Sub's exactly-once feature is scoped to pull subscriptions and regional delivery, Amazon SQS standard queues remain at-least-once even during visibility timeout, and Kafka's exactly-once semantics work only when offsets and output records are committed inside Kafka's transaction model. Outside that boundary, idempotency and durable receipts still matter.

For agent runtimes, the dangerous state is in-flight work: a message has left the durable inbox and entered a terminal, model API, browser session, shell process, or external service, but the system has not durably recorded completion. A successful terminal paste is not processing completion. A submitted model request is not a user-visible answer. A sent tool command is not a durable side effect unless the receipt is stored. The runtime must name these boundaries explicitly and preserve enough state to recover, retry, reconcile, or quarantine work after a crash.

The practical architecture is a durable message ledger, not a magical delivery guarantee. Each message and step should carry stable IDs, attempt numbers, lease ownership, heartbeats, input hashes, result references, and explicit timestamps for acknowledged, dispatched, accepted, completed, and sent states. The recovery loop should scan stale in-flight work, but it should retry only idempotent steps or steps with receipt checks. Unknown non-idempotent work should be quarantined for reconciliation rather than replayed blindly. This article maps queueing, workflow, and idempotency patterns to the specific reliability problems of AI agent runtimes.

## Why Agent Runtimes Need Delivery Semantics

The first generation of agent systems often treated the runtime as a conversational process: send text in, wait for text out. That model is too weak for autonomous agents that must run across days, channels, tools, and restarts. A production agent is closer to a distributed workflow engine with an LLM in the middle.

A single user request can cross many reliability domains:

- An inbound platform webhook or polling loop receives the message.
- A communication bridge writes it to a database or queue.
- A dispatcher chooses when to deliver it to the active runtime.
- A terminal or API bridge injects it into Claude, Codex, or another model runtime.
- The model calls tools such as shell commands, browser automation, calendar APIs, email APIs, GitHub, or local file edits.
- The agent writes memory, creates commits, sends external replies, or schedules follow-up tasks.
- A monitor restarts the runtime when it becomes unhealthy.

Every boundary creates a question: who owns the message now? If this process dies after this point, should the message be retried, resumed, suppressed, or escalated?

Without explicit semantics, systems end up with accidental acknowledgment boundaries. A dispatcher may mark work done after writing to a terminal. A model runtime may lose a response after a server-side 400. A tool wrapper may retry a non-idempotent API call because the first response was not captured. A health monitor may restart a session and scan only the pending queue, missing work that was already dispatched but not completed.

The resulting failure mode is subtle: the message is not visibly pending, but it also never produced a durable outcome. This is the core in-flight recovery problem.

## The Exactly-Once Trap

"Exactly once" is attractive language, but in distributed systems it almost always has a scope clause.

[Google Pub/Sub's exactly-once delivery documentation](https://docs.cloud.google.com/pubsub/docs/exactly-once-delivery) is a useful example because it is precise about the boundary. The feature lets subscribers know whether acknowledgments succeeded, prevents redelivery after a successful acknowledgment, and rejects expired acknowledgment IDs when a newer delivery might already be in-flight. But the guarantee applies to pull subscriptions, has regional constraints, and still requires consumers to maintain processing progress until acknowledgment succeeds.

[Amazon SQS visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html) shows the more common model. A received message becomes invisible to other consumers while it is in-flight. If the consumer finishes, it deletes the message. If the consumer crashes or misses the timeout, the message becomes visible again for another attempt. AWS explicitly keeps the model at least-once for standard queues, so duplicate processing remains possible.

BullMQ makes the same tradeoff at the job-worker layer. Its [important notes](https://docs.bullmq.io/bull/important-notes) describe an at-least-once strategy based on locks and renewal. If a worker loses the lock, the job can be marked stalled and restarted, which means the job may be processed twice. BullMQ's [stalled jobs guide](https://docs.bullmq.io/guide/workers/stalled-jobs) frames this as a worker liveness and lock-renewal problem, not as a universal guarantee.

Kafka narrows the scope differently. Kafka's exactly-once processing can combine idempotent producers, transactions, and consumer offset commits when the workflow consumes from Kafka and produces back to Kafka. But once a processor calls an external API, writes to a local file, drives a browser, or sends a Telegram message, Kafka can no longer make that side effect exactly-once by itself.

Agent runtimes have even wider side effects than typical stream processors. They call nondeterministic models, execute shell commands, mutate repositories, operate browsers with logged-in sessions, and communicate with humans. The correct design target is therefore:

- at-least-once delivery for messages and work steps;
- idempotent processing for repeated attempts;
- effectively-once side effects where the runtime controls the state boundary;
- quarantine and reconciliation for side effects that cannot be safely replayed.

## Acknowledgment Boundaries Are Ownership Boundaries

An acknowledgment is not just a status flag. It transfers responsibility.

If an inbound Telegram message is acknowledged before it is stored durably, the platform may not resend it, and the agent can lose it. If a queue message is deleted before the response is durably recorded, a crash can erase the only copy of the work. If a dispatcher deletes an in-flight marker after terminal submission, the monitor may assume the runtime is responsible even though the runtime has not completed processing.

For an agent runtime, at least five boundaries should be explicit.

**Ingress ack** happens when an external event is safely committed to the local inbox. The platform-facing handler can return success only after this write succeeds. If the handler crashes before the write, the platform or polling loop should be allowed to retry.

**Dispatch claim** happens when a worker atomically moves a message from queued to in-flight. This should include an owner, attempt number, lease expiration, and fencing token. Two dispatchers should not believe they own the same attempt.

**Runtime accept** happens when the runtime bridge has durable evidence that the runtime accepted the input. For terminal-based agents, this is harder than it looks. "Pasted into tmux" is not the same as "the model runtime parsed and started processing this message." If the runtime cannot emit an accept event, the system should treat terminal submission as a weak accept and keep the in-flight marker until a later completion or restart scan.

**Completion** happens when the response, tool receipt, memory update, or next-step intent is durably written. This is the boundary that proves the agent has produced a recoverable outcome.

**Outbound ack** happens when a provider or bridge accepts the outgoing message. The runtime should use an outbox so that a crash after composing a reply but before provider acceptance does not lose the reply. The outbox relay may send twice, so outbound messages need provider idempotency when available or duplicate suppression when not.

The key correction is simple: do not collapse runtime accept and completion. A message can be accepted by a bridge and still be lost by the runtime.

## In-Flight Work Is a Lease, Not a Boolean

In-flight state is often modeled as a boolean: pending or active. That is insufficient. In-flight work needs a lease.

A lease says: this worker owns this attempt until a particular time, and it must renew ownership while it is still alive. If the lease expires, recovery may assume the worker is dead or unable to make progress. SQS visibility timeout, Pub/Sub lease extension, BullMQ lock renewal, and Temporal activity heartbeats all implement variants of this pattern.

The lease should include:

- `message_id`: stable identity of the user or scheduler message;
- `step_id`: stable identity of a runtime step within the message;
- `attempt`: monotonically increasing attempt number;
- `lease_owner`: process, session, or runtime instance that claimed the work;
- `lease_version`: fencing token that prevents stale workers from committing after a newer attempt starts;
- `lease_expires_at`: recovery eligibility time;
- `heartbeat_at`: latest liveness update;
- `input_hash`: canonical hash of the input being processed;
- `status`: queued, in-flight, completing, completed, failed, quarantined;
- `result_ref`: pointer to durable result or receipt;
- `completed_at`: durable completion boundary.

This model lets the recovery loop reason about work rather than infer state from logs. If a runtime restarts, HealthEngine or the equivalent monitor can scan `status = in_flight AND lease_expires_at < now`, group affected messages, and decide how to handle each one.

The important nuance is that stale does not always mean safe to retry. A stale worker may have crashed before doing anything. It may also be stuck in an API call that eventually succeeds. It may have mutated a browser session or sent an email but failed to record the result. The scanner needs a policy based on step type and idempotency, not a universal retry.

## Outbox and Inbox Patterns for Agent Boundaries

The [transactional outbox pattern](https://microservices.io/patterns/data/transactional-outbox.html) solves a classic dual-write problem: a service must update local state and publish a message, but it cannot atomically commit both the database and broker through a practical two-phase commit. The solution is to write the state change and outbound message into the same database transaction. A separate relay publishes the message later.

The catch is that the relay can publish the same message more than once if it crashes after publishing but before recording success. Therefore the receiver must be idempotent, usually by tracking processed message IDs. The matching [idempotent consumer pattern](https://microservices.io/patterns/communication-style/idempotent-consumer.html) handles duplicate delivery by making repeated processing of the same message produce the same durable effect.

Agent runtimes need both patterns:

- an inbox for inbound user, scheduler, webhook, and internal control messages;
- an outbox for Telegram, Lark, email, GitHub, calendar, and other outbound side effects;
- processed-message records for inbound deduplication;
- provider message IDs or local idempotency keys for outbound deduplication;
- durable tool receipts for tool calls that may be retried.

For example, a Telegram reply should not be sent directly from a model callback with no durable record. The agent should write an outbound intent first: recipient, thread reference, content hash, correlation ID, and idempotency key. A relay sends it and records the provider response. If the relay crashes, it can inspect the outbox and either resend safely or reconcile with provider state.

The same applies to file edits and shell commands, although they are harder. The runtime should record tool-call intent before execution and receipt after execution. If a retry happens, the executor first checks whether a receipt exists for the same idempotency key and input hash. If yes, it reuses the recorded result instead of executing again.

## Durable Execution Lessons for LLM Agents

Workflow engines such as Temporal and Azure Durable Functions offer a useful mental model: orchestration state is durable and replayable, while nondeterministic side effects are isolated into activities.

[Temporal's documentation](https://docs.temporal.io/) describes durable execution as the ability to resume after crashes and outages from recorded workflow history. Temporal activities can be retried, and practical Temporal guidance emphasizes idempotency keys for activities that call external systems. Azure Durable Functions similarly warns developers not to put nondeterministic I/O inside orchestrator code because orchestrators replay.

LLM agents need the same separation, but with extra care because LLM calls themselves are nondeterministic. A retry of the same prompt may produce a different plan, a different tool call, or a different user-facing answer. That is sometimes acceptable for purely informational text, but dangerous for workflows that mutate state.

A durable agent runtime should treat each of these as an activity:

- model invocation;
- shell command;
- file edit;
- browser action;
- external API call;
- outbound human message;
- memory update;
- scheduled follow-up creation.

Each activity should have an intent record and a receipt record. On replay, the orchestrator should prefer the receipt over re-execution. If the receipt is missing, the runtime decides whether the activity is safe to retry.

This implies a different architecture from a single unstructured transcript. The transcript is useful for human review, but recovery needs structured step records.

## Idempotency Keys Must Come From the Runtime

The LLM should not invent idempotency. Idempotency keys should be generated by the runtime from stable data:

```text
session_id + message_id + step_id + tool_name + canonical_input_hash
```

For outbound provider calls, use the provider's native idempotency mechanism when it exists. For local tools, enforce a unique key in the local receipts table. For file operations, use content hashes and patch identity. For GitHub comments or Telegram messages where provider idempotency is limited, keep a local send ledger and reconcile by provider message ID after send.

The [AWS Builders Library article on idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-apis/) is especially relevant here. It argues for caller-provided request tokens, careful handling of late-arriving retries, and detection of the same token being reused with different parameters. Agent runtimes need the same safeguards. A retry with the same idempotency key but different canonical input should be rejected or quarantined, not treated as the same operation.

Idempotency records also need retention. Keeping them for only a few minutes is too short if retries, delayed webhooks, human waits, session restarts, or background jobs can arrive hours later. Retention should exceed the maximum redelivery, retry, and late-arrival window for the channel.

## Recovery Policy: Retry, Resume, Reconcile, or Quarantine

Stale in-flight work should not have a single recovery action. The runtime needs a decision matrix.

**Retry** when the step is deterministic or idempotent. Examples include parsing local state, reading a file, re-running a pure analysis step, or sending a request to an API with a strong idempotency key.

**Resume** when there is a durable checkpoint. A long-running workflow can continue from the last completed step instead of replaying the entire user request.

**Reconcile** when the side effect may have happened but the receipt is missing. The runtime should query provider state, check local files, inspect a Git branch, or look up outbound channel history before deciding whether to retry.

**Quarantine** when the runtime cannot prove safety. Examples include partially completed browser actions, account-setting changes, payments, destructive file operations, or messages that may have been sent through a provider with no idempotency key and no reliable lookup path. Quarantine should produce a human-readable recovery report, not silently replay the work.

This matrix is more important for AI agents than for ordinary queues because agents operate across high-variance tools. The same message may include a harmless read-only search and a destructive production deployment. Recovery must understand step risk.

## Applying the Model to Terminal-Based Agent Runtimes

Many agent systems wrap interactive runtimes through terminal sessions, tmux panes, or browser-like control channels. This is practical, but it creates a weak observability boundary. The bridge can often prove that it wrote bytes to the terminal. It may not know when the runtime parsed the message, when the model call started, when the assistant answer became final, or whether a tool call was interrupted.

The main design rule is: terminal submission cannot be the completion boundary.

A robust terminal-based runtime should keep an in-flight marker after submit verification and clear it only when one of these happens:

- the runtime emits an explicit processing-complete event;
- the bridge observes a durable assistant response associated with the message ID;
- the recovery scanner has examined the marker during session restart and either requeued, reconciled, or quarantined it;
- a stale garbage collector clears the marker only after it is too old to be actionable and after logging a diagnostic event.

This is the distinction between "message reached the terminal" and "message produced a recoverable result." Deleting the marker at terminal submit time recreates the original gap: a crash after submit but before completion leaves no pending queue item and no in-flight victim marker.

The runtime should also distinguish DB-pending messages from in-flight messages. DB-pending messages have not been submitted and can usually be dispatched normally. In-flight messages have crossed a side-effect boundary and require recovery policy.

## Observability for Delivery Semantics

Delivery semantics need metrics and traces. Otherwise, the system will only discover gaps when a user reports a missing reply.

Useful metrics include:

- pending queue age;
- in-flight count;
- stale in-flight count;
- lease renewal failures;
- duplicate delivery attempts;
- idempotency key reuse;
- receipt-missing recoveries;
- quarantine count;
- outbound send retries;
- recovery time after restart;
- user-visible missed-message incidents.

Useful traces should include correlation IDs from inbound message through model call, tool call, memory write, and outbound reply. A human reviewing an incident should be able to answer: where did ownership transfer, what was the last durable receipt, and what did recovery decide?

Google Pub/Sub exposes metrics for exactly-once warning events and expired acknowledgment deadlines. SQS recommends monitoring high in-flight counts. BullMQ recommends logging stalled events because they imply possible double processing. Agent runtimes should expose the equivalent signals rather than treating them as internal implementation details.

## Implementation Checklist for Zylos-Like Agents

A practical implementation does not need to become a full workflow engine immediately. The next reliability layer can be incremental:

1. Add a durable message ledger with explicit `queued`, `in_flight`, `completed`, `failed`, and `quarantined` states.
2. Add lease owner, lease version, lease expiry, heartbeat, attempt, and input hash fields.
3. Keep in-flight markers until completion, restart recovery, or stale GC, not merely until terminal submit verification.
4. Add a stale in-flight scanner that produces a structured victim list during runtime restart.
5. Split recovery actions into retry, resume, reconcile, and quarantine.
6. Add outbound outbox records before sending replies to external channels.
7. Add tool-call intent and receipt records for side-effecting tools.
8. Generate idempotency keys outside the LLM from stable runtime identifiers.
9. Reject same idempotency key with different canonical input unless manually reconciled.
10. Keep idempotency and receipt records longer than the maximum late-arrival window.

This checklist turns reliability from a best-effort monitor into a protocol.

## Caveats and Tradeoffs

Longer leases delay recovery. Shorter leases increase duplicate processing. There is no universal setting; the right value depends on runtime latency, model timeout behavior, tool duration, and restart frequency.

More receipts improve recovery but increase storage, schema, and privacy obligations. Agent systems that store tool results must decide what is safe to retain, especially when results include user data, credentials, or private documents.

Idempotency is not always free. Some provider APIs do not support idempotency keys. Some browser interactions cannot be repeated safely. Some file operations are easy to check by content hash; others require semantic inspection. The runtime should not hide these differences behind a single retry abstraction.

Finally, human-facing language matters. A design document should avoid claiming "exactly-once delivery" unless the scope is precise. Better terms are at-least-once delivery, idempotent processing, effectively-once side effects, and durable recovery boundaries.

## Strategic Takeaway

The next reliability frontier for AI agents is not better heartbeat detection alone. It is clear ownership semantics around every message and side effect.

For Zylos-like systems, the lesson is direct: an activity monitor can restart a dead runtime, but only a durable message protocol can tell it what work was at risk. In-flight state must survive past submit verification. Completion must mean a recoverable result exists. Recovery must understand idempotency. Once these boundaries are explicit, crashes and restarts become ordinary workflow events rather than sources of silent message loss.
