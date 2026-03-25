---
date: "2026-03-24"
title: "Work Ledger + Lease + Close-Out Contracts for Long-Running Agent Runtimes"
description: "A practical architecture for single-node and small-cluster AI agent runtimes: model work as explicit ledger entries, attach renewable leases for liveness, and enforce close-out/waiting contracts to prevent zombie tasks and silent drops."
tags: ["ai-agents", "runtime-architecture", "durable-execution", "leases", "observability", "sqlite", "workflow-systems"]
---

## Executive Summary

Most AI agent runtime failures in production are not model-quality failures. They are control-plane failures:

- work exists but is not visible as a first-class object,
- work starts but never gets a definitive terminal state,
- workers crash mid-flight and the system cannot distinguish "still running" from "lost",
- human/external waits are represented implicitly (or only in prompt text),
- retries and timeouts are inconsistent across subsystems.

A robust fix is to combine three mechanisms:

1. **Work ledger**: every inbound unit of runtime work gets a durable identity and lifecycle record.
2. **Lease-based liveness**: active work holds a renewable lease; no lease renewal means ownership has expired.
3. **Close-out/waiting contract**: runtime must explicitly declare terminal completion (`done`/`failed`/`timeout`) or explicit non-terminal waiting (`waiting_user`/`waiting_external`).

This pattern is consistent with mature orchestration systems:

- **Temporal** uses event history as the source of truth and explicit activity timeout/retry policies.
- **AWS Step Functions** models retry/catch/timeout as first-class state machine semantics.
- **LangGraph** persists checkpoints and supports indefinite pause/resume via interrupts and thread IDs.
- **Prefect** treats state transitions as first-class and distinguishes terminal vs non-terminal state types.
- **Kubernetes Lease** formalizes renewable ownership/liveness to avoid split-brain execution.

Inference for agent runtimes: for a lightweight stack (SQLite + queue + monitor), the fastest path is a thin control layer (`runtime_work`, `runtime_work_event`) over existing subsystem tables, with fail-open adapters and strict lifecycle invariants.

## Why This Matters for Zylos-Style Runtimes

In conversational and multi-channel agents, runtime work is heterogeneous:

- inbound human messages,
- control-plane commands (heartbeat, health-check, maintenance),
- scheduled jobs (periodic trackers, reporting, sync),
- long-running interactions waiting for user/external dependencies.

When these are tracked in separate tables without a shared execution identity, you lose operational guarantees:

- no single view of "what is currently active",
- no reliable way to enforce timeout policy uniformly,
- no clean handoff between dispatcher, runtime loop, and monitor,
- no precise postmortem trail of lifecycle transitions.

The work-ledger pattern solves this while preserving existing subsystem schemas.

## Primary-Source Pattern Synthesis

### 1) Temporal: Event-Sourced Runtime Truth + Explicit Time Boundaries

Temporal documentation emphasizes workflow execution/event history and explicit activity timeout classes (`Schedule-To-Close`, `Start-To-Close`, heartbeat timeout) and retry policy configuration. This gives two directly reusable ideas:

- **Fact pattern**: lifecycle should be persisted as append-only events, not inferred from transient process state.
- **Fact pattern**: timeout semantics must be explicit and typed; timeout is a state outcome, not a log message.

Inference for lightweight runtimes: keep a compact event table for status transitions and policy events, rather than overloading one mutable row.

### 2) AWS Step Functions: Retry/Catch/Timeout as Contract, Not Convention

Step Functions error-handling docs define `Retry`/`Catch` as explicit state machine fields and include typed errors such as `States.Timeout`. Retry controls include `IntervalSeconds`, `BackoffRate`, `MaxAttempts`, optional jitter, and max delay.

- **Fact pattern**: retries are declarative policy attached to state transitions.
- **Fact pattern**: timeout is part of the failure taxonomy and can be routed differently than generic failure.

Inference: if retries are encoded ad hoc in runtime code paths, behavior diverges between conversation/control/scheduler. A shared work contract should centralize retry metadata and backoff decisions.

### 3) LangGraph: Durable Pause/Resume + Explicit Wait Semantics

LangGraph interrupt documentation shows:

- execution can pause indefinitely,
- graph state is checkpointed,
- resumption is tied to durable identity (`thread_id`),
- node code before interrupt may rerun on resume (thus side effects must be idempotent).

This is the clearest primary-source confirmation for `waiting_*` states in agent systems.

- **Fact pattern**: waiting is a first-class, persisted state; not an error and not completion.
- **Fact pattern**: resumes require stable identity and replay-safe side effects.

Inference: runtime work model should include explicit `waiting_user` and `waiting_external`, plus idempotent tool-call boundaries around waits.

### 4) Prefect: Rich State Taxonomy and Terminal Classification

Prefect docs define named state types and terminal semantics (`COMPLETED`, `FAILED`, `CRASHED`, etc.) with explicit transition reasoning (`Late`, `AwaitingRetry`, `Paused`, `TimedOut`).

- **Fact pattern**: strong distinction between state *name* and state *type* improves operator reasoning.
- **Fact pattern**: terminal/non-terminal classification is foundational for orchestration.

Inference: a runtime work row needs both normalized status enums and optional reason/subtype fields; otherwise operators cannot reliably separate retriable delays from hard failures.

### 5) Kubernetes Lease: Renewable Ownership for Liveness

Kubernetes lease docs formalize lease resources with fields like `holderIdentity`, `leaseDurationSeconds`, and `renewTime`, used for node heartbeats and leader coordination.

- **Fact pattern**: liveness is represented as renewable ownership, not process PID trust.
- **Fact pattern**: expiration is deterministic (`renew_time + duration + grace`).

Inference: runtime "active work" should be lease-backed; monitors should enforce expiration and reclaim semantics.

### 6) SQLite WAL + Constraint Model: Practical Local Durability Foundation

SQLite WAL documentation highlights reader/writer concurrency improvements and checkpointing behavior, while SQLite create-table docs reinforce constraint-driven integrity (`PRIMARY KEY`, `UNIQUE`, `CHECK`, etc.).

- **Fact pattern**: WAL mode is practical for single-host runtimes with mixed reads/writes.
- **Fact pattern**: constraints are the first defense against invalid lifecycle transitions.

Inference: for a single-node runtime, SQLite + WAL + strict constraints is enough for a reliable work ledger before introducing distributed infra.

## Proposed Data Model

### `runtime_work` (current state snapshot)

Recommended minimal schema:

- `work_id` (TEXT/UUID, PK)
- `source_system` (TEXT, enum: `conversation|control|scheduler|manual`)
- `source_id` (TEXT, e.g., conversation ID / control ID / task ID)
- `source_run_id` (TEXT nullable; required for recurring scheduler runs)
- `status` (TEXT, enum)
- `status_reason` (TEXT nullable)
- `owner` (TEXT nullable; runtime/session/worker identity)
- `lease_token` (TEXT nullable)
- `lease_expires_at` (DATETIME nullable)
- `attempt_count` (INTEGER default 0)
- `priority` (INTEGER default 3)
- `retry_policy_json` (TEXT nullable)
- `next_retry_at` (DATETIME nullable)
- `waiting_kind` (TEXT nullable: `user|external`)
- `waiting_ref` (TEXT nullable; endpoint/thread/correlation id)
- `created_at`, `updated_at`, `started_at`, `finished_at` (DATETIME)

Suggested status enum:

- non-terminal: `queued`, `running`, `waiting_user`, `waiting_external`, `retry_scheduled`
- terminal: `done`, `failed`, `timeout`, `cancelled`

### `runtime_work_event` (append-only lifecycle log)

- `event_id` (INTEGER PK autoincrement)
- `work_id` (FK -> runtime_work.work_id)
- `event_type` (TEXT)
- `from_status`, `to_status` (TEXT nullable)
- `message` (TEXT nullable)
- `payload_json` (TEXT nullable)
- `actor` (TEXT; subsystem or runtime identity)
- `created_at` (DATETIME)

Typical event types:

- `work_created`
- `claimed`
- `lease_acquired`
- `lease_renewed`
- `transition`
- `waiting_set`
- `retry_scheduled`
- `timeout_marked`
- `close_out`
- `lease_released`

## Lifecycle Contract

### Invariants

1. Every inbound unit of actionable work creates exactly one `runtime_work` row.
2. Every status transition appends one `runtime_work_event` row.
3. `running` work must either renew lease periodically or transition out of `running`.
4. Terminal states are immutable (no transition out unless explicit requeue creates a new attempt event and returns to `queued`).
5. `waiting_*` and terminal close-out are mutually exclusive in a single transition.
6. Scheduler recurring runs must map by run instance (`source_run_id`), not only schedule ID.

### Allowed transitions (minimal)

- `queued -> running`
- `running -> waiting_user|waiting_external`
- `running -> done|failed|timeout|retry_scheduled`
- `waiting_* -> running|timeout|cancelled`
- `retry_scheduled -> queued`

Reject or flag as corruption:

- `done -> running`
- `failed -> waiting_user`
- `timeout -> done` (without explicit recovery/requeue contract)

## Lease Model (Single-Node / Small Cluster)

### Lease Acquire

When dispatcher hands work to active execution:

- generate `lease_token`,
- set `owner`,
- set `lease_expires_at = now + lease_ttl`,
- append `lease_acquired`.

### Lease Renew

Activity monitor renews if all true:

- work is `running`,
- owner is current runtime session,
- activity freshness is within threshold,
- runtime is not in waiting state.

Renew action:

- bump `lease_expires_at`,
- append `lease_renewed`.

### Lease Expiry Handling

If `now > lease_expires_at + grace`:

- transition `running -> timeout`,
- append `timeout_marked`,
- clear active pointer and lease fields.

### Active Pointer

Use lightweight pointer file (for monitor/ops convenience), e.g. `active-work.json`, but treat database as source of truth. Pointer must be cleared on close-out/waiting/timeout/restart reconciliation.

## Close-Out and Waiting Contract

### Close-Out

Runtime must explicitly call close-out with:

- `status` in terminal set,
- optional result summary / error classification,
- optional downstream output references.

No implicit close-out by "message delivered" in transport layers.

### Waiting

Runtime must explicitly mark wait reason:

- `waiting_user`: blocked on human reply/approval/input,
- `waiting_external`: blocked on external system callback/event.

Required fields:

- waiting reference (conversation endpoint, callback correlation ID, etc.),
- timeout budget / escalation policy.

Resume should:

- append resume event,
- transition back to `running`,
- acquire/renew lease accordingly.

## Retry and Timeout Semantics

Adopt typed policies inspired by Step Functions/Temporal:

- retryable classes: transient network, rate limit, service unavailable,
- non-retryable classes: validation errors, policy denials, permanent misconfiguration.

Per-work policy fields:

- `max_attempts`,
- `initial_backoff_sec`,
- `backoff_multiplier`,
- `max_backoff_sec`,
- optional jitter strategy.

On retry scheduling:

- increment attempt count,
- compute `next_retry_at`,
- transition `running -> retry_scheduled`,
- transition to `queued` when eligible.

Timeouts should be explicit by phase where possible:

- claim/start timeout,
- execution timeout,
- waiting timeout,
- heartbeat timeout (lease renewal miss).

## Failure Modes and Anti-Patterns

1. **No unified work identity**
   - Symptom: separate queues/tables cannot answer "what is running now?"
   - Fix: mandatory `runtime_work` creation at ingress.

2. **Lease-less running state**
   - Symptom: zombie work after crash/restart.
   - Fix: lease acquire/renew/expire enforcement.

3. **Implicit completion inference**
   - Symptom: transport delivery mistaken for business completion.
   - Fix: explicit close-out API/CLI.

4. **Waiting hidden in prompt text**
   - Symptom: runtime appears idle but work remains semantically active.
   - Fix: explicit `waiting_user` / `waiting_external` status.

5. **Retry policy scattered across subsystems**
   - Symptom: inconsistent behavior across conversation/control/scheduler paths.
   - Fix: centralized retry metadata and transition rules.

6. **Scheduler run identity collapse**
   - Symptom: recurring job instances overwrite each other.
   - Fix: require run-level identifier (`source_run_id`).

7. **Mutable-only status row without event log**
   - Symptom: no postmortem lineage.
   - Fix: append-only `runtime_work_event`.

## Lightweight Implementation Blueprint (SQLite + Queue + Monitor)

### Phase 0: Thin Ledger Layer

- Create `runtime_work` + `runtime_work_event` tables.
- Add small shared module APIs:
  - `create_work`, `transition_work`, `append_event`, `close_out`.
- Add minimal CLI for ops:
  - `list`, `show`, `close-out`, `waiting`.

### Phase 1: Ingress Adapters

- conversation ingress creates `source_system='conversation'` work,
- control ingress creates `source_system='control'` work,
- scheduler run start creates `source_system='scheduler'` work with run ID.

### Phase 2: Lease and Monitor

- acquire lease on active execution handoff,
- monitor renews lease when runtime is healthy and active,
- mark timeout on expiration,
- reconcile pointer/database on restart.

### Phase 3: Contract Hardening

- enforce transition constraints at DB/service layer,
- add lifecycle integration tests across all three source systems,
- add operator dashboards for non-terminal aging work and lease expiry risk.

## Concrete Policy Defaults (Recommended)

For practical small-team operations:

- Lease TTL: 45s
- Renewal interval: 15s
- Expiry grace: 30s
- Default waiting timeout: 24h (`waiting_user`), 2h (`waiting_external`)
- Retry: attempts=3, backoff=2x, jitter full, max delay=5m

These should be configurable per source type.

## Final Recommendation

Treat runtime work as a control-plane resource, not an implementation detail.

The minimum reliable package is:

- durable work ledger,
- renewable leases,
- explicit close-out/waiting semantics,
- append-only lifecycle events,
- run-level identity for scheduled executions.

Inference: this architecture gives most of the operational reliability benefits associated with larger durable-execution platforms, while remaining compatible with a lightweight single-node runtime and existing subsystem tables.

## Sources (Primary)

- Temporal Docs — Workflow Execution: https://docs.temporal.io/workflow-execution
- Temporal Docs — Activity Execution: https://docs.temporal.io/activity-execution
- Temporal TS Failure Detection / Activity Timeouts: https://docs.temporal.io/develop/typescript/failure-detection#activity-timeouts
- AWS Step Functions — Error Handling (`Retry`, `Catch`, `States.Timeout`): https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html
- AWS Step Functions — SendTaskHeartbeat API: https://docs.aws.amazon.com/step-functions/latest/apireference/API_SendTaskHeartbeat.html
- LangGraph Docs — Interrupts, checkpointing, resume semantics: https://docs.langchain.com/oss/javascript/langgraph/interrupts
- LangGraph Docs — Durability modes: https://docs.langchain.com/oss/python/langgraph/durable-execution
- Prefect Docs — States and transitions: https://docs.prefect.io/v3/concepts/states
- Kubernetes Docs — Lease concept: https://kubernetes.io/docs/concepts/architecture/leases/
- Kubernetes API Reference — Lease v1: https://kubernetes.io/docs/reference/kubernetes-api/cluster-resources/lease-v1/
- SQLite Docs — WAL: https://www.sqlite.org/wal.html
- SQLite Docs — CREATE TABLE constraints: https://www.sqlite.org/lang_createtable.html
