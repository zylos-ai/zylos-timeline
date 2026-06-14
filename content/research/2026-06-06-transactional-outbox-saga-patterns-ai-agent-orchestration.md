---
date: "2026-06-06"
title: "Transactional Outbox and Saga Patterns for AI Agent Orchestration"
description: "How the transactional outbox and saga patterns solve the dual-write problem in multi-service AI agent systems — ensuring durable, consistent state transitions when agents coordinate across service boundaries."
tags:
  - distributed-systems
  - ai-agents
  - microservices
  - transactional-outbox
  - saga-pattern
  - unit-of-work
  - golang
  - data-consistency
---

## Executive Summary

AI agents make decisions that must survive infrastructure failures. When an agent approves an action — booking a resource, escalating a task, triggering a downstream workflow — that decision must become durable before the rest of the system responds to it. The **transactional outbox pattern** addresses exactly this: the gap between "we wrote state" and "we told everyone else." Combined with the **saga pattern** for multi-step compensation logic, these two patterns form the foundation of reliable agent orchestration across service boundaries. This article explores how both patterns work, where they apply in AI agent systems, and how teams building in Go can implement them without sacrificing clean architecture.

---

## The Core Problem: Dual Writes in Agent Systems

When an AI agent completes a decision step, two things typically need to happen atomically:

1. **Persist the new state** — the agent's decision is written to a database
2. **Notify other services** — a message is published to trigger downstream work

In a simple monolith these happen in the same process. In a multi-service architecture they don't. The naive approach — write to the database, then publish to a message broker — creates a race condition with no clean resolution:

- If the **database write succeeds** but the **publish fails**, the system state has advanced but no downstream service knows it. The agent appears to have decided, but nothing happens.
- If the **publish succeeds** but the **database write fails** (or rolls back), downstream services act on a decision that was never durably committed.

This is the **dual-write problem**, and it is fundamental — no amount of retry logic on the publish side can recover an event that was never recorded in the first place.

---

## Pattern 1: Transactional Outbox

### How It Works

The transactional outbox pattern eliminates the race condition by making event publication part of the database transaction itself:

1. Within a single atomic transaction, the service writes both the **business state change** and an **outbox record** (a serialized event) to the same database.
2. A separate background **relay process** reads pending outbox records and forwards them to the message broker.
3. Once the broker acknowledges delivery, the relay marks the outbox record as processed (or deletes it).

Because both writes happen in the same transaction, they either both commit or both roll back. The relay only ever sees committed records — so if the broker publish fails, the relay retries. If the relay crashes, the next run picks up where it left off. The event is guaranteed to exist if and only if the state change committed.

### The Relay: Two Implementation Strategies

**Polling publisher** — A scheduled job queries the outbox table for unprocessed records at a configurable interval (e.g., every 100ms). Simple to implement, adds minor latency, and can introduce database load at high throughput.

**Change Data Capture (CDC)** — The database's replication stream (PostgreSQL WAL, DynamoDB Streams, MySQL binlog) is consumed by a dedicated relay (often Debezium). The relay tails the log and forwards committed changes without polling. Lower latency, no extra database load, but operationally more complex.

### Application to AI Agents

The pattern is particularly well-suited to agent systems because agents make high-stakes decisions with downstream side effects:

- An agent routing a support ticket must atomically record its routing decision **and** enqueue a notification to the assigned team.
- An orchestrator scheduling a follow-up task must atomically persist the task record **and** emit a task-created event to the scheduler service.
- A billing agent approving a refund must atomically update the case state **and** notify the payment service.

In each case, the outbox ensures the "decision moment" is durable. As one Redis implementation guide puts it: "retries handle events that already exist; the outbox ensures the event exists in the first place."

### Redis Streams as an Outbox Store

For agent systems using Redis as their primary state store, the outbox can be implemented using Redis transactions with hash tags. A case state hash and an outbox stream share the same hash tag (`{tenant-id}`) to ensure they occupy the same cluster slot, making atomic writes possible:

```
support:{tenantId}:case:{caseId}  →  Redis Hash (agent state)
support:{tenantId}:outbox          →  Redis Stream (outbox events)
```

A single `MULTI/EXEC` block atomically updates the case hash and appends to the outbox stream. A background worker reads the stream, delivers events to downstream consumers, and advances the consumer group cursor only after successful delivery.

### Idempotency Requirement

The relay may deliver the same event more than once (network retries, relay restarts, at-least-once broker semantics). Downstream consumers **must** be idempotent — processing the same event twice must produce the same result as processing it once. The standard approach is to include a unique `event_id` in each outbox record and have consumers deduplicate by that ID.

---

## Pattern 2: Saga Pattern for Multi-Step Workflows

The outbox guarantees that a single state change is reliably broadcast. But agent workflows often span multiple services and multiple steps, each of which can fail. This is where the **saga pattern** applies.

### What a Saga Is

A saga is a sequence of local transactions, one per service, each paired with a **compensating transaction** that can undo its effect if a later step fails. Instead of a single distributed ACID transaction (which requires 2-phase commit and does not scale), a saga achieves consistency through eventual compensation.

A typical agent workflow saga:

```
Step 1: Reserve resource       →  Compensate: Release reservation
Step 2: Charge budget          →  Compensate: Refund budget
Step 3: Notify downstream      →  Compensate: Send cancellation notice
Step 4: Mark task complete     →  (terminal — no compensation needed)
```

If step 3 fails, the saga runs compensations for steps 2 and 1 in reverse order.

### Choreography vs. Orchestration

**Choreography** — Each service reacts to events from the previous step and emits events for the next. There is no central coordinator. Simple to implement but difficult to trace; the workflow logic is distributed across services.

**Orchestration** — A central saga orchestrator issues commands to each service in sequence and handles compensation on failure. The workflow logic is centralized and observable. This is the preferred model for AI agent systems where the agent itself is often the logical orchestrator.

In practice, modern agent frameworks like LangGraph implement orchestration sagas natively: the workflow graph represents the saga, persistent nodes store checkpoint state, and compensation steps are modeled as explicit graph branches on failure.

### Saga + Outbox: The Durable Transaction Recipe

The outbox pattern and saga pattern are complementary:

- The **outbox** ensures that each saga step's local transaction reliably notifies the next participant.
- The **saga** ensures that multi-step workflows have a coherent compensation strategy when any step fails.

Without the outbox, a saga step might commit locally but fail to trigger the next step. Without compensation logic, a partial saga leaves the system in an inconsistent state. Together, they form the complete solution for durable multi-service consistency.

---

## Unit of Work in Go: Coordinating Cross-Repository Transactions

For teams building in Go, the **unit of work** pattern provides a clean way to implement the transactional outbox without leaking transaction management into service logic.

### The Problem with Per-Repository Transactions

Each repository might expose its own `Tx()` method, but this doesn't compose. If a service needs to atomically write to a `TaskStore` and an `OutboxStore`, it can't do that by calling each repository's transaction method independently — they'd use separate database connections.

### The UnitOfWork Interface

The solution is a single interface that starts one database transaction and provides all repository instances backed by it:

```go
type Stores struct {
    Tasks   TaskStore
    Outbox  OutboxStore
}

type UnitOfWork interface {
    RunInTx(ctx context.Context, fn func(Stores) error) error
}
```

A concrete implementation acquires a `*sql.Tx`, constructs each store using that transaction, runs the callback, and commits or rolls back:

```go
func (u *pgUoW) RunInTx(ctx context.Context, fn func(Stores) error) error {
    tx, err := u.db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    stores := Stores{
        Tasks:  NewTaskStore(tx),
        Outbox: NewOutboxStore(tx),
    }
    if err := fn(stores); err != nil {
        _ = tx.Rollback()
        return err
    }
    return tx.Commit()
}
```

An agent service then writes its state change and outbox record atomically:

```go
func (s *AgentService) CompleteTask(ctx context.Context, taskID string, result TaskResult) error {
    return s.uow.RunInTx(ctx, func(stores Stores) error {
        if err := stores.Tasks.MarkComplete(ctx, taskID, result); err != nil {
            return err
        }
        event := OutboxEvent{
            AggregateID: taskID,
            EventType:   "task.completed",
            Payload:     marshalResult(result),
        }
        return stores.Outbox.Append(ctx, event)
    })
}
```

The relay process then reads the outbox table and publishes events. Because only committed rows are visible, every published event corresponds to a real, durable state change.

---

## Operational Considerations

### Outbox Table Design

A minimal outbox table for PostgreSQL:

```sql
CREATE TABLE outbox (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_id TEXT NOT NULL,
    event_type   TEXT NOT NULL,
    payload      JSONB NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ
);

CREATE INDEX outbox_unprocessed_idx ON outbox (created_at)
WHERE processed_at IS NULL;
```

The partial index ensures the relay's polling query scans only unprocessed rows, keeping the query fast even as the table grows.

### Relay Robustness

- **Backpressure** — Batch the relay's read and publish in fixed-size chunks to avoid overwhelming the broker on startup or after downtime.
- **Dead-letter handling** — Events that fail to publish after N retries should be moved to a dead-letter table for manual inspection rather than blocking the relay indefinitely.
- **Exactly-once semantics** — Most brokers offer at-least-once delivery. Combine message deduplication IDs (using the outbox `id`) with idempotent consumers to achieve effectively-once processing.

### Dapr Integration

For teams using Dapr as their service mesh, the outbox pattern is available as a built-in building block. Configuring `outboxPublishPubsub` and `outboxPublishTopic` on a state store component enables atomic state+event writes through Dapr's unified state management API. Dapr handles the relay internally, routing events through a verification step that confirms the state transaction committed before publishing to external topics.

---

## When to Use Each Pattern

| Scenario | Pattern |
|---|---|
| Single service: reliably notify another service when state changes | Transactional Outbox |
| Multi-service workflow that must partially undo on failure | Saga |
| Cross-repository writes in a single service (Go) | Unit of Work |
| Long-running agent workflow with checkpointed steps | Saga + Persistent Orchestrator (LangGraph, Temporal) |
| Agent decision that triggers side effects in other systems | Outbox + Idempotent Consumers |
| Event-driven microservices requiring audit trails | Outbox with CDC (Debezium) |

---

## Relevance to Zylos Architecture

Zylos operates as a multi-service agent platform: the scheduler (C5), communication bridge (C4), memory system (C3), and HTTP service (C6) each own their own state but must coordinate reliably. Several current and near-future design challenges map directly to these patterns:

- **Scheduled task completion** — When a task is marked done, both the scheduler state and any notification dispatch must succeed atomically. An outbox on the scheduler's task table would ensure the notification is never lost even if the comm bridge is temporarily unavailable.
- **Memory sync coordination** — Memory sync jobs that update multiple memory tiers should succeed or roll back as a unit, with outbox events notifying downstream consumers of the new memory state.
- **Agent action durability** — When an agent takes an action (file write, API call, external service trigger), recording the action in an outbox before executing it provides an audit trail and recovery path.

These patterns are not hypothetical improvements — they are proven solutions to consistency problems that every agent platform eventually hits at scale.

---

## Summary

The transactional outbox pattern solves the fundamental dual-write problem in event-driven agent systems: it guarantees that state changes and their downstream notifications are atomically linked, eliminating the risk of silent failures where state advances but the world does not hear about it. The saga pattern extends this guarantee to multi-step workflows, providing principled compensation when any step in a long-running agent task fails. In Go codebases, the unit of work interface provides the clean abstraction needed to implement outbox writes without polluting service logic with transaction management. Together, these three patterns — outbox, saga, unit of work — form the reliability substrate on which durable AI agent orchestration is built.
