---
date: "2026-06-02"
title: "The Transactional Outbox Pattern for AI Agent Coordination"
description: "How the DB outbox pattern solves the dual-write problem in distributed agent systems, enabling reliable task handoff, Saga-style compensation, and at-least-once delivery without two-phase commit."
tags: ["ai-agents", "distributed-systems", "outbox-pattern", "saga", "microservices", "event-driven", "reliability"]
---

## Executive Summary

Every production AI agent system eventually hits the same wall: you need to update local state *and* hand a task off to another service — and one of those operations will fail first. The naive approach (write to DB, then publish to queue) means you can lose events silently on crash. The opposite order (publish first, then write) means you can publish twice. Neither is acceptable in agent pipelines where a missed task goes unexecuted and a duplicate task can cause double billing, duplicate emails, or conflicting state mutations.

The Transactional Outbox pattern is the proven fix. It converts the dual-write problem into a single atomic database transaction: write your business state *and* an outbox event row together in one commit, then let a separate relay process pick up completed rows and publish them. Because the relay reads committed rows, it can safely retry on crash with no data loss. Because consumers implement idempotency, occasional duplicates are harmless.

This pattern — invented in the microservices world and battle-tested by companies like Uber, Netflix, and Amazon — is now migrating into AI agent runtimes as agent workflows grow longer, multi-step, and multi-service. When an orchestrator agent dispatches a sub-agent, when a tool invocation must atomically record its result and trigger a follow-up, or when a Saga-style multi-agent workflow needs safe compensation on failure, the outbox is the architectural primitive that makes it work. This article explains why, how to implement it at different scales, and what failure modes remain even after adoption.

## The Dual-Write Problem in Agent Systems

### Why It Surfaces

Traditional microservices have a well-known dual-write hazard: after persisting an order to a database, the service must publish an `OrderCreated` event to a message broker. A crash between the two operations leaves the system inconsistent — the order exists in the database but downstream services never hear about it.

AI agent systems face the same hazard at every task boundary:

- An orchestrator agent receives a user request, writes task state to its database, and dispatches a sub-agent job to a queue. If it crashes after writing but before dispatching, the job is never created.
- A tool handler records the result of a long-running tool call and must trigger the next pipeline stage. If the trigger is lost, the pipeline stalls silently.
- A Saga coordinator records a saga step as "completed" and must publish a compensation event in case a later step fails. If the compensation event is lost, rollback is impossible.

In short: wherever an agent needs to update durable state *and* send a message, the dual-write hazard applies.

### Why Simple Fixes Fail

**Write-then-publish:** The state is saved, but if the publish fails or the process crashes before the publish completes, the event is lost. There is no way to reconstruct it from the database row alone without external coordination.

**Publish-then-write:** The event is sent, but if the database write fails, the published event describes a state change that never happened. Consumers proceed on false information.

**Distributed two-phase commit (2PC):** Coordinates the database and message broker in a single atomic protocol. Works in theory, but requires both systems to support the XA protocol, kills throughput due to locking, and creates a distributed deadlock risk when the coordinator crashes in the prepared state. Almost no production system uses it for this reason.

**Idempotent retry with a lock:** Write a "pending publish" flag before publishing, clear it after. Races and partial failures turn this into subtle bugs. The logic is hard to get right across process restarts.

The outbox pattern avoids all of these by treating the message broker as a secondary consumer of the database rather than a coordinate of it.

## The Outbox Pattern: Core Mechanics

### Schema

The pattern adds an `outbox` table to the service's own database:

```sql
CREATE TABLE outbox (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  aggregate   TEXT NOT NULL,          -- e.g. 'agent_task', 'saga_step'
  event_type  TEXT NOT NULL,          -- e.g. 'TaskDispatched', 'StepCompleted'
  payload     JSONB NOT NULL,
  published   BOOLEAN NOT NULL DEFAULT false,
  published_at TIMESTAMPTZ
);
```

### The Atomic Write

When business logic runs, *both* the entity update and the outbox row are written inside the same database transaction:

```sql
BEGIN;

-- Business state update
UPDATE agent_tasks SET status = 'dispatched', dispatched_at = now()
WHERE id = $1;

-- Outbox event (written atomically with the state change)
INSERT INTO outbox (aggregate, event_type, payload)
VALUES ('agent_task', 'TaskDispatched', '{"task_id": "...", "agent_id": "..."}');

COMMIT;
```

If the transaction commits, both the state change and the event are durable. If it rolls back, neither exists. The two are always in sync.

### The Relay

A relay process (sometimes called the "outbox publisher" or "message relay") runs independently:

```
loop:
  SELECT id, event_type, payload FROM outbox
  WHERE published = false
  ORDER BY created_at
  LIMIT 100
  FOR UPDATE SKIP LOCKED;

  for each row:
    publish to message broker (Kafka, SQS, Redis Streams, etc.)
    UPDATE outbox SET published = true, published_at = now()
    WHERE id = row.id;
```

`SKIP LOCKED` is essential in PostgreSQL — it lets multiple relay instances compete for rows without blocking each other, enabling horizontal scaling.

The relay delivers *at-least-once* semantics: if it crashes after publishing but before marking the row as processed, it will republish on restart. Consumers must be idempotent to handle this gracefully.

### CDC as an Alternative Relay

Polling the outbox table works for moderate throughput but adds latency (proportional to poll interval) and query load. For high-throughput systems, Change Data Capture (CDC) is the alternative: tools like Debezium hook directly into PostgreSQL's logical replication stream, capturing `INSERT` events on the outbox table and forwarding them to Kafka in near-real-time (typically under 100ms end-to-end), with no additional database load.

The trade-off is operational complexity: CDC requires configuring logical replication, deploying and operating the CDC connector, and handling connector restarts and schema evolution. For most agent systems, polling is the right starting point. Switch to CDC if you measure unacceptable latency or database load.

## Applied to AI Agent Architectures

### Task Dispatch Handoff

The most direct application is agent-to-agent task dispatch. An orchestrator agent receives a multi-step task and must break it into sub-tasks for specialized agents:

```
Orchestrator receives: "Research company X, draft an email, schedule a meeting"
↓
Create sub-tasks in DB + insert outbox events — one transaction
↓
Relay publishes TaskDispatched events to sub-agent queues
↓
Sub-agents pick up work independently, acknowledge completion
```

Without the outbox, a crash between creating the sub-tasks and dispatching them leaves orphaned tasks that no agent will ever pick up. With the outbox, the relay will publish on restart and the sub-agents will receive their assignments.

### Tool Invocation Results

When an agent calls a long-running tool (web scraping, code execution, file processing), the tool result must be:
1. Stored in the agent's context/memory
2. Used to trigger the next action

Using the outbox here ensures that a crash between storing the result and triggering the next step doesn't silently stall the pipeline. The next action is modeled as an outbox event that the relay will eventually deliver.

### Saga-Based Multi-Agent Compensation

The Saga pattern extends the outbox to handle long-running multi-step workflows that span multiple agents. Each step is a local transaction that writes both its result *and* a compensation event to the outbox. If a later step fails, the saga coordinator reads the compensation events in reverse order and executes them.

A concrete agent workflow example:

```
Step 1: ReserveCalendarSlot     → compensation: CancelSlot
Step 2: DraftEmail              → compensation: DiscardDraft
Step 3: SendEmail               → compensation: (none — cannot unsend)
Step 4: CreateCRMRecord         → compensation: DeleteCRMRecord
```

If step 4 fails, the coordinator runs: DeleteCRMRecord → (skip unsend) → DiscardDraft → CancelSlot. Each compensation is guaranteed to be attempted because the compensation events were written atomically with the forward steps.

The key invariant: **compensation events are written in the same transaction as the forward step, before knowing whether the saga will succeed.** This is what makes recovery possible even after a crash at any point.

### Inbox Pattern for Idempotent Consumers

The outbox handles the producer side. The inbox pattern handles the consumer side. When a sub-agent receives an event, it writes it to its own `inbox` table *before* processing:

```sql
BEGIN;
INSERT INTO inbox (event_id, event_type, payload, processed_at)
VALUES ($1, $2, $3, NULL)
ON CONFLICT (event_id) DO NOTHING;  -- idempotency check
COMMIT;

-- Only proceed if the INSERT succeeded (not a duplicate)
```

Combined, outbox + inbox delivers end-to-end exactly-once processing semantics despite the underlying at-least-once transport.

## Implementation Patterns by Scale

### SQLite-Based Agent Systems (Single-Process)

For lightweight embedded agents (like CLI tools, local assistants, or single-process agent runtimes), SQLite with WAL mode provides a surprisingly capable outbox implementation:

```sql
-- WAL mode enables concurrent reads during writes
PRAGMA journal_mode=WAL;

CREATE TABLE outbox (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  event     TEXT NOT NULL,
  payload   TEXT NOT NULL,    -- JSON
  published INTEGER DEFAULT 0
);
```

The relay runs in a background goroutine or thread, polling with a short sleep interval. This works well up to thousands of events per hour with sub-second latency. No external infrastructure required.

### PostgreSQL with Polling (Small to Medium Agent Platforms)

For multi-process agent platforms on a single database, PostgreSQL with `SKIP LOCKED` provides a production-grade outbox. Key additions:

- **Outbox lag monitoring:** Alert when `MAX(created_at) - NOW()` for unpublished rows exceeds threshold (typically 30 seconds). This is the primary SRE metric for outbox health.
- **Dead letter:** After N failed publish attempts, move rows to a `outbox_dlq` table for manual inspection.
- **TTL cleanup:** Archive or delete published rows older than 7 days to prevent table bloat.
- **Multiple relay instances:** Use `SKIP LOCKED` to run 2-3 relay instances for availability.

### CDC-Based High-Throughput Platforms

For large-scale multi-agent platforms processing thousands of events per second:

- Deploy Debezium connected to PostgreSQL logical replication
- Configure the `outbox` table as a monitored source
- Debezium publishes to Kafka with the aggregate type and event type as the topic/key
- Downstream agent consumers are Kafka consumer groups

This architecture separates concerns cleanly: the agent service only touches its own database, never the message broker directly. All broker interaction is mediated by the CDC pipeline.

## Failure Modes and Mitigations

### Relay Crash After Publish, Before Mark

The relay publishes to the broker, then crashes before updating `published = true`. On restart, it republishes the same event. Consumers receive it twice.

**Mitigation:** Idempotent consumers. Use the event `id` as a deduplication key. Write to `inbox` with `ON CONFLICT DO NOTHING` before processing.

### Broker Unavailability

The relay cannot connect to the broker. Outbox rows accumulate. When the broker recovers, the relay processes the backlog — but in the meantime, all downstream agents see no new work.

**Mitigation:** Monitor outbox lag. Alert when unpublished rows exceed age threshold. Design agent consumers to handle gaps gracefully (timeouts, heartbeats, dead-letter escalation).

### Schema Evolution

A published event type changes its payload structure. Old consumers cannot parse new events.

**Mitigation:** Version event types (`TaskDispatched.v2`). Use an event registry. Never remove fields; only add optional fields. Test consumer compatibility before deploying producer changes.

### Compensation Event Loss (Saga Failure)

The saga coordinator writes compensation events to its outbox but the outbox relay fails before delivering them. A later crash means compensation cannot complete.

**Mitigation:** Compensation events are just outbox rows — the relay will deliver them eventually. The saga state machine must be idempotent: re-running a compensation that already ran must be a no-op.

### Long-Running Relay Gaps

A relay instance is paused (e.g., stuck in a long GC pause). Other instances using `SKIP LOCKED` pick up new rows, but rows held by the paused instance are locked until the transaction times out.

**Mitigation:** Set a statement timeout on relay SELECT queries. Use advisory locks with timeouts rather than row-level locks if extended holds are a concern.

## Relationship to Durable Execution

Durable execution frameworks (Temporal, Restate, Inngest) solve a related but broader problem: they make entire function call graphs resumable across crashes, handling the retry/replay logic transparently. The outbox pattern solves the narrower problem of atomic state-plus-event writes.

The two are complementary. A Temporal workflow can use an outbox inside its activity implementations when those activities need to coordinate with services outside Temporal's control. An outbox-based system may adopt durable execution for orchestration-level concerns while keeping the outbox for intra-service event publishing.

For agent systems that cannot adopt a full durable execution framework (due to complexity, cost, or vendor lock-in), the outbox pattern provides most of the reliability guarantees for the specific problem of cross-service task handoff — at a fraction of the operational overhead.

## 2026 Ecosystem Notes

Several AI agent frameworks are beginning to expose outbox-adjacent primitives natively:

- **Temporal Activities** can be configured with exactly-once semantics by pinning the activity to a workflow ID and using the workflow as the coordination point — effectively an in-memory outbox.
- **LangGraph's checkpoint system** persists graph state before and after each node execution, which provides crash recovery but does not solve the cross-service publish problem without additional instrumentation.
- **Claude Agent SDK (Managed Agents)** does not currently expose an outbox primitive; developers must implement their own outbox when agent decisions need to trigger durable downstream side effects.

The gap between what agent frameworks offer and what production reliability demands continues to drive teams to implement the outbox pattern manually — usually discovering it after their first production incident involving a dropped task.

## Implementation Checklist

For teams adding an outbox to an agent service:

- Add `outbox` table to the service's own database (not a shared database)
- Wrap all business state changes + outbox inserts in a single transaction
- Deploy a relay process with exponential backoff on broker unavailability
- Use `SKIP LOCKED` (PostgreSQL) or equivalent for concurrent relay safety
- Implement idempotency on all consumers using event `id` as deduplication key
- Add outbox lag monitoring (alert if unpublished rows exceed 30s threshold)
- Add dead-letter handling after N failed publish attempts
- Schedule TTL cleanup for published rows
- Load test the relay at 2x expected peak event rate before going to production

---

*Sources: [microservices.io — Transactional Outbox Pattern](https://microservices.io/patterns/data/transactional-outbox.html) · [InfoQ — Saga Orchestration Using the Outbox Pattern](https://www.infoq.com/articles/saga-orchestration-outbox/) · [Debezium — Reliable Microservices Data Exchange](https://debezium.io/blog/2019/02/19/reliable-microservices-data-exchange-with-the-outbox-pattern/) · [AppScale Blog — Saga + Outbox 2026](https://appscale.blog/en/blog/microservices-pattern-combo-saga-outbox-2026) · [DEV.to Redis — Building Reliable Agents with Outbox Pattern](https://dev.to/redis/building-reliable-agents-with-the-transactional-outbox-pattern-and-redis-streams-45e6) · [AWS Prescriptive Guidance — Transactional Outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html) · [Streamkap — Outbox Pattern Explained](https://streamkap.com/resources-and-guides/outbox-pattern-explained) · [james-carr.org — The Transactional Outbox Pattern](https://james-carr.org/posts/2026-01-15-transactional-outbox-pattern/)*
