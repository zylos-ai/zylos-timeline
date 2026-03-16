---
date: "2026-03-16"
title: "Supervisor Trees and Fault Tolerance Patterns for AI Agent Systems"
description: "How Erlang/OTP's proven supervision model translates to resilient AI agent runtimes — covering strategies, Rust implementations, health checking, graceful degradation, and state recovery."
tags:
  - research
  - ai
  - architecture
  - fault-tolerance
  - erlang
  - rust
  - distributed-systems
---

## Executive Summary

Building resilient AI agent runtimes requires the same discipline that Erlang engineers applied to telecom systems in the 1980s: accept that processes will fail, isolate the blast radius, and automate recovery. Erlang/OTP's supervision tree model — now 30+ years old — remains the clearest conceptual framework for this problem. Its core ideas map directly onto modern AI agent architectures: LLM sessions, executor workers, memory services, and tool-calling subprocesses all behave like supervised child processes that must be started, monitored, and restarted with well-defined strategies.

Key takeaways:

- The "let it crash" philosophy is not recklessness — it is the discipline of separating fault-handling logic from business logic
- Supervision strategies (one-for-one, one-for-all, rest-for-one) encode dependency relationships between components
- Restart intensity limits (max restarts in time window) prevent infinite crash loops from consuming resources
- Modern Rust runtimes (Bastion, Lunatic, tokio with JoinSet) implement these patterns at varying levels of fidelity
- Kubernetes probes, PM2, and systemd are coarser-grained but follow the same underlying philosophy
- Exponential backoff with jitter and circuit breakers are the standard tools for handling cascading failures
- State recovery after restart — via checkpointing, event sourcing, or snapshot + replay — is the hardest problem and the most consequential for AI agents with long-running sessions

---

## 1. Erlang/OTP Supervision Trees

### 1.1 The Supervision Model

Erlang's Open Telecom Platform (OTP) defines a formal process supervision hierarchy. A **supervisor** process is responsible only for: starting child processes, monitoring them, and restarting them on failure. Business logic lives in **worker** processes. The structural separation is strict.

A supervision tree is built by composing supervisors as children of other supervisors, creating a hierarchy where:

- Critical, stable logic lives near the root
- Volatile, frequently-crashing logic lives at the leaves
- A failure at a leaf cannot propagate upward past its supervisor without explicit policy

The tree is the unit of deployment — starting a supervision tree starts an entire subsystem in dependency order, and stopping it tears down in reverse order.

### 1.2 Restart Strategies

Erlang defines three supervision strategies that encode the dependency model between children:

**one_for_one**
Each child is independent. When one child crashes, only that child is restarted. Use this when children have no shared state and do not depend on each other. This is the most common strategy and the right default for stateless worker pools.

**one_for_all**
When any child crashes, all children are terminated and then all are restarted. Use this when the children form a tightly coupled group where partial state is worse than no state — for example, a set of processes that collectively hold a distributed lock or shared transaction.

**rest_for_one**
Children are ordered. When a child crashes, it and all children started after it are terminated and restarted (in order). This encodes a linear dependency chain: child B depends on child A, child C depends on B, etc. A crash in the middle of the chain restarts the tail but not the head.

### 1.3 Restart Intensity and Flood Control

Supervisors carry a restart intensity configuration: `{MaxRestarts, PeriodSeconds}`. If a child crashes more than `MaxRestarts` times within `PeriodSeconds`, the supervisor itself terminates and reports failure upward. This prevents infinite restart loops from silently consuming CPU and memory.

Tuning guidance:
- Set `PeriodSeconds` long enough that the allowed restart rate is sustainable (e.g., 5 restarts in 30 seconds = 1 restart per 6 seconds)
- In multi-level trees, do not use identical intensity values at every level — the effective total restarts before the top supervisor gives up is the product of all intensity values in the chain
- Defaults in Erlang/OTP are `{1, 5}` — intentionally conservative

### 1.4 Child Process Types

- **permanent**: always restarted on exit (the default for long-running services)
- **temporary**: never restarted (fire-and-forget tasks)
- **transient**: restarted only on abnormal exit (non-zero exit code, uncaught exception) — not on clean shutdown

### 1.5 The "Let It Crash" Philosophy

"Let it crash" is frequently misunderstood. It does not mean "ignore errors." It means:

1. Do not write defensive error-handling boilerplate inside every worker for every possible failure mode
2. Instead, let workers crash when they encounter unexpected state
3. The supervisor handles recovery, not the worker itself
4. The worker code remains clean and expressive — only the happy path

The practical implication is that worker processes can be simpler, more readable, and more correct, because they are not cluttered with recovery logic that is often wrong anyway. The supervisor provides a known-good restart with fresh state as the recovery mechanism.

This philosophy is appropriate for recoverable failures (network timeouts, transient resource exhaustion, unexpected input). It is not a substitute for validating user input or handling expected error conditions in business logic.

---

## 2. Translating OTP Patterns to AI Agent Runtimes

### 2.1 The Agent Process Tree

An AI agent runtime can be modeled as a supervision tree with four tiers:

```
Root Supervisor (one_for_one)
├── Memory Service Supervisor (one_for_all)
│   ├── Vector Store Worker
│   ├── Session Store Worker
│   └── Cache Worker
├── Executor Pool Supervisor (one_for_one)
│   ├── Executor Worker 1
│   ├── Executor Worker 2
│   └── ... N workers
├── LLM Session Supervisor (rest_for_one)
│   ├── Auth/Token Manager
│   ├── Request Queue
│   └── Session Handler
└── Tool Registry Supervisor (one_for_one)
    ├── Web Tool Worker
    ├── Code Execution Worker
    └── External API Worker
```

**Memory Service uses one_for_all** because the vector store, session store, and cache must be consistent. If the session store crashes with in-flight writes, restarting only the session store risks cache serving stale data. Restart all three together.

**Executor Pool uses one_for_one** because each executor is stateless and independent. A crash in executor 2 should not interrupt executor 1's work.

**LLM Session uses rest_for_one** because the auth/token manager must be live before the request queue accepts work, and the request queue must be live before the session handler can function. A crash in the request queue should restart the queue and the session handler (which depends on it), but not the auth manager.

**Tool Registry uses one_for_one** because tool workers are independent. A web tool timeout should not restart the code execution worker.

### 2.2 Session-Level Supervision

LLM sessions are long-running, stateful, and expensive to restart. Special considerations:

- Use **transient** restart type: a session that completes normally (agent finishes its task) should not be restarted, but one that crashes mid-task should be
- Checkpoint session state before any external call (tool use, API call) so a restart can resume rather than repeat
- The session supervisor should have a high restart intensity (10 restarts in 60 seconds) but the root supervisor should have a low intensity, creating a clear boundary between "session is flaky but system is stable" and "something is fundamentally broken"

### 2.3 AIOS: A Research Instantiation

The AIOS (LLM Agent Operating System) paper from 2024 formalizes an OS-level abstraction for agent process management. Its kernel includes:

- **Agent Scheduler**: prioritizes and schedules LLM requests (round-robin, priority-based)
- **Context Manager**: snapshots and restores LLM generation state, enabling preemption
- **Memory Manager**: per-agent short-term memory isolation
- **Storage Manager**: durable persistence of agent interaction logs

This maps almost exactly to an OTP application: the AIOS kernel is the root supervisor, each module is a supervised service, and agent processes are supervised workers. The paper reports up to 2.1x throughput improvement over unmanaged concurrent agents.

---

## 3. Rust Implementations

### 3.1 Actix: Actor Model with Supervision

Actix is a Rust actor framework built on top of tokio. Its `Supervisor` struct wraps an actor and provides restart-on-crash semantics. Key properties:

- Actors implement the `Supervised` trait, which includes a `restarting()` lifecycle hook
- The `Supervisor::start()` function launches a supervised actor; if the actor panics or returns `Running::Stop`, the supervisor creates a new execution context and restarts it
- Supervisors cannot guarantee message delivery across a crash — if an actor fails mid-message, that message is lost
- Supervision is one-to-one: each Supervisor manages a single actor, not a pool

Actix supervision is appropriate for individual long-lived actors (an LLM session handler, a queue processor) but does not provide tree-level coordination. For multi-actor fault tolerance, you need to compose supervisors manually or use a higher-level framework.

### 3.2 Bastion: Erlang-Inspired Fault-Tolerant Runtime

Bastion is explicitly positioned as "Erlang/OTP for Rust." It provides:

- Full supervision tree construction with nested supervisors
- All three Erlang strategies: `OneForOne`, `OneForAll`, `RestForOne`
- Children groups (pools of identical workers under one supervisor)
- Cross-supervisor message passing via broadcasters
- Built on the Nuclei async runtime (IOCP/epoll/kqueue depending on platform)

Bastion's design makes it the closest Rust equivalent to building an OTP application. The tradeoff is that Bastion is less mature and less widely deployed than Erlang/BEAM for production systems. As of 2024, the project is active but the ecosystem around it is thin compared to tokio.

### 3.3 Lunatic: WASM + Erlang Model

Lunatic takes a different approach: instead of implementing Erlang patterns in native Rust, it creates an Erlang-like runtime for WebAssembly modules. Key properties:

- Each process runs as an isolated WebAssembly instance with its own heap and stack
- Preemptive scheduling via a work-stealing async executor (never blocks a thread on I/O)
- Supervision trees inspired directly by Erlang/OTP
- Process isolation stronger than BEAM: each process can be memory-limited and CPU-limited
- Language-agnostic: any language that compiles to WASM can use Lunatic's process model

For AI agent runtimes, Lunatic's WASM isolation is particularly attractive: a misbehaving tool-execution worker (e.g., a sandboxed code interpreter) can be strictly resource-bounded at the process level without OS container overhead.

### 3.4 Tokio: Structured Concurrency Patterns

Tokio itself does not implement supervision trees, but its primitives support supervision-like patterns:

**JoinSet**: a collection of tasks that can be awaited collectively. When a JoinSet is dropped, all tasks in it are immediately aborted. This provides "all-or-nothing" shutdown semantics similar to `one_for_all`. Tasks can be individually aborted via `AbortHandle`.

**Structured concurrency via scopes**: a proposed extension (RFC #2592) would make task lifetimes lexically scoped — if any task in a scope fails, all others are cancelled. This is similar to `rest_for_one` semantics.

**tokio-stage**: a third-party crate implementing fault-tolerance and self-healing for tokio applications, providing supervisor-like process trees over tokio tasks.

**Practical pattern for tokio supervision**:

```rust
// Supervision loop pattern
loop {
    let result = tokio::spawn(run_worker()).await;
    match result {
        Ok(Ok(())) => break,          // clean exit
        Ok(Err(e)) => {               // worker error
            log_and_backoff(e).await;
        }
        Err(join_err) => {            // panic
            log_panic(join_err);
            backoff().await;
        }
    }
}
```

This manual pattern is how most tokio-based services implement supervision today. It lacks the declarative structure of OTP but is widely understood and easy to audit.

---

## 4. Comparison: OTP vs Kubernetes vs PM2 vs systemd

| Dimension | Erlang/OTP | Kubernetes | PM2 | systemd |
|---|---|---|---|---|
| **Unit of supervision** | Process (lightweight, 1KB) | Pod (container group) | OS process | OS service |
| **Restart granularity** | Individual process | Pod (all containers restart together) | Individual process | Service unit |
| **Dependency ordering** | rest_for_one, explicit tree | init containers, depends-on | ecosystem (manual) | After=, Requires= |
| **Health checking** | Monitor links, process signals | liveness/readiness/startup probes | heartbeat file, http check | `ExecStartPost=`, `sd_notify` |
| **Restart rate limiting** | intensity + period | restartPolicy + backoffLimit + CrashLoopBackOff | max_restarts + min_uptime | StartLimitIntervalSec + StartLimitBurst |
| **State on restart** | Fresh process (no shared memory) | Fresh container (ephemeral) | Fresh process | Fresh process |
| **Scope** | Single BEAM VM | Cluster-wide | Single node | Single host |
| **Overhead per supervised unit** | ~300 bytes/process | ~100MB+ (container) | ~30MB (Node.js overhead) | minimal |

**Kubernetes** is OTP at container granularity. The three probe types map directly to OTP concepts:
- **Liveness probe** = "is this process still running at all?" — maps to process monitor links
- **Readiness probe** = "is this process ready to accept work?" — maps to a custom health check handler
- **Startup probe** = "has the process finished initializing?" — maps to OTP's `init` phase before a process is registered

Kubernetes CrashLoopBackOff is the equivalent of OTP's restart intensity — exponential backoff applied when a container crashes repeatedly.

**PM2** is a practical Node.js supervisor. Its restart strategies include exponential moving average backoff (delay grows up to 15 seconds, resets after 30 seconds of stability) and memory-limit-triggered restarts. Its cluster mode provides zero-downtime reload via graceful handoff, analogous to a hot-upgrade in OTP.

**systemd** is the broadest but crudest. `Restart=on-failure`, `RestartSec=`, `StartLimitBurst=` provide basic supervisor semantics for OS services. It has no concept of supervision trees or dependency-aware restart strategies beyond simple `After=` ordering.

---

## 5. Backoff Strategies: Exponential Backoff, Jitter, and Circuit Breakers

### 5.1 Exponential Backoff

The standard retry delay formula:

```
delay = min(base * 2^attempt, max_delay)
```

Example: base=100ms, max=30s → delays of 100ms, 200ms, 400ms, 800ms, 1.6s, 3.2s, 6.4s, 12.8s, 25.6s, 30s (capped).

Rationale: each retry represents an opportunity for the failing component to recover. Doubling the delay gives the system progressively more recovery time without waiting indefinitely.

### 5.2 Jitter

Without jitter, all clients that were blocked by a failure event will retry at the same time (the thundering herd problem), potentially re-triggering the failure immediately. Jitter adds randomness to spread retries across time.

Two common jitter strategies:

**Full jitter**:
```
delay = random(0, min(cap, base * 2^attempt))
```

**Decorrelated jitter** (AWS recommendation):
```
delay = min(cap, random(base, prev_delay * 3))
```

AWS research found decorrelated jitter produces better throughput than full jitter in most load scenarios.

### 5.3 Circuit Breaker

The circuit breaker pattern complements backoff by stopping requests entirely when a dependency is known to be failing, rather than queuing retries that will also fail.

States:
- **Closed**: normal operation, requests flow through, failures are counted
- **Open**: failure threshold exceeded, requests are immediately rejected without calling the dependency
- **Half-Open**: after a cooldown period, a probe request is sent; if it succeeds, circuit closes; if it fails, circuit stays open

Circuit breaker parameters:
- `failure_threshold`: how many failures in what window to trigger open state
- `success_threshold`: how many successes in half-open to trigger closed state
- `timeout`: how long to stay in open state before probing

For AI agent systems, circuit breakers are critical on LLM API calls. If the upstream model API is experiencing an outage, continuing to send requests burns credits, adds latency, and fills queues. A circuit breaker allows the agent to degrade gracefully (return cached results, queue for later, or surface a clean error) rather than stacking up failed requests.

---

## 6. Health Checking and Liveness Probes for AI Agent Components

### 6.1 Probe Types by Component

Different agent components need different health check strategies:

**LLM Session Handlers**
- Liveness: TCP connection to LLM API endpoint is reachable
- Readiness: session has completed initialization (loaded system prompt, memory context)
- Deep health: send a minimal ping request (e.g., 1-token completion) and verify response time < threshold

**Memory Services (vector DB, session store)**
- Liveness: database process responds to socket connection
- Readiness: can execute a read query without error
- Deep health: round-trip write + read + delete of a test record

**Executor Workers**
- Liveness: worker process is running and heartbeating
- Readiness: worker has claimed no active tasks (can accept new work)
- Heartbeat pattern: worker writes a timestamp to a shared file every N seconds; supervisor checks that file age < 2N

**Tool Workers**
- Liveness: worker process is alive
- Readiness: dependent external services (web, code sandbox) are reachable

### 6.2 Heartbeat Implementation Pattern

For worker processes without HTTP endpoints (background processors, queue consumers), a file-based heartbeat is a practical approach:

1. Worker touches `/tmp/worker-{id}-alive` every 10 seconds
2. Supervisor checks file mtime every 15 seconds
3. If file age > 30 seconds, supervisor kills and restarts the worker

This is the approach used by Celery workers in Kubernetes environments where HTTP health probes are not native.

### 6.3 AI-Specific Failure Modes

AI agent processes have failure modes that standard probes miss:

- **Silent semantic failure**: the process is alive and responding, but the LLM is returning nonsensical output (context overflow, model degradation)
- **Stuck generation**: the process is waiting for a streaming response that will never complete (upstream timeout not configured)
- **Memory leak via context growth**: each request adds to the context window; the process is healthy but each call is slower than the last

Mitigations:
- Set explicit generation timeouts on all LLM calls (not just connection timeouts)
- Monitor response latency percentiles (p95, p99) as health signals, not just availability
- Track context window utilization and restart/refresh sessions before they hit the limit

---

## 7. Graceful Degradation

### 7.1 Dependency Classification

The first step in designing graceful degradation is classifying every dependency:

**Critical dependencies** (system cannot function without them):
- LLM API connectivity
- Session state storage
- Authentication service

**Important dependencies** (degraded but functional without them):
- Vector memory / RAG retrieval (agent answers from context only, without long-term recall)
- Tool execution sandbox (agent plans but cannot execute actions)
- Observability / logging pipeline

**Optional dependencies** (loss is invisible to end user):
- Analytics collection
- Background cache warming
- Non-critical notification services

### 7.2 Degradation Strategies by Dependency Type

For **critical dependency failure**: fail fast, surface a clear error to the user, do not attempt to operate in a partially-initialized state. A session that cannot reach the LLM API should not pretend to work.

For **important dependency failure**:
- Return stale cached data when the live source is unavailable
- Disable the feature and continue (feature toggle pattern)
- Queue the work for when the dependency recovers
- Communicate degraded state to the caller explicitly (not silently)

For **optional dependency failure**: log and continue. Never let an analytics call or a non-critical notification block the main request path.

### 7.3 Bulkhead Pattern

The bulkhead pattern partitions resources (thread pools, connection pools, rate limits) so that a failure in one area cannot exhaust resources needed by another. In agent systems:

- The LLM API call pool and the tool execution pool should be separate, with independent queue depth limits
- A flood of tool-call timeouts should not exhaust the connection pool used for LLM API calls
- Memory service requests should have a separate timeout budget from the main task execution timeout

This maps to OTP's process isolation: a crashing child process cannot corrupt its supervisor's heap or stack.

---

## 8. State Recovery After Restart

### 8.1 The Core Problem

When a supervised process is restarted, it begins with clean state. For stateless workers (HTTP request handlers, queue processors), this is ideal — clean state means no corruption. For stateful agents (long-running sessions tracking multi-step task progress), clean state means lost work.

Three main strategies address this:

### 8.2 Checkpointing

Checkpointing serializes the full process state to durable storage at regular intervals (or at explicit safe points). On restart, the process loads the most recent checkpoint and resumes from there.

**Checkpoint granularity tradeoffs**:
- Too frequent: high write amplification, storage cost, latency spikes during checkpointing
- Too infrequent: more work is repeated after a restart ("recovery window")

**Safe point checkpointing** (preferred for agent systems): checkpoint after each completed atomic step (after each tool call completes, after each LLM response is received). This minimizes replay while keeping checkpoints meaningful.

LangGraph implements this pattern: the entire graph state — conversation history, tool results, current node — is serialized to PostgreSQL or Redis after each step. Any instance can resume the session after a crash by loading the latest checkpoint.

The Microsoft Durable Task extension for AI agent frameworks takes this further: agent sessions are automatically checkpointed to Azure Storage and can resume across process restarts and even machine migrations.

### 8.3 Event Sourcing

Event sourcing stores the **log of state transitions** rather than the state itself. State is reconstructed by replaying events from the beginning (or from a snapshot).

Structure:
- `EventStore`: append-only log of all state transitions
- `Snapshot`: periodic captures of current state to bound replay time
- Recovery: load latest snapshot + replay events since snapshot

For AI agents, this maps naturally to the conversation history: the conversation log *is* an event log. Replaying it through the LLM reconstructs approximate agent state, though exact internal state (tool call results, memory queries) must also be included.

**Snapshot + replay optimization**: store a checkpoint every N events, then only replay the tail. For agents with long task histories (hundreds of tool calls), snapshotting every 50 events keeps recovery time bounded.

### 8.4 Recovery Considerations Specific to AI Agents

**Idempotency of tool calls**: if the agent crashed after making an external write (sending an email, updating a database) but before checkpointing, a naive restart will repeat the action. Tool calls must be idempotent or the agent must track which calls have been acknowledged.

**LLM non-determinism**: replaying a conversation through an LLM does not guarantee the same decisions will be made (temperature, model updates, different context window). Event sourcing for agents must store the actual LLM responses, not just the inputs.

**Memory service recovery ordering**: if the memory service and the agent session both crash, the memory service must be fully recovered before any agent sessions attempt to resume. This is the `rest_for_one` pattern applied to recovery sequencing.

**Context window management**: after a long-running session is checkpointed and resumed, the reconstructed context may approach the model's context limit. Resumption logic should summarize or truncate history before injecting it, not blindly replay the full log.

---

## 9. Applying These Patterns to Zylos

The Zylos agent runtime is a concrete candidate for applying these patterns. The current architecture has several supervision surfaces:

**Current state**: PM2 supervises top-level processes (one_for_one equivalent). Individual session logic has no internal supervision structure.

**Recommended additions**:

1. **Session checkpointing**: persist conversation state and task progress to a durable store (Redis or SQLite) after each major step. The current `memory/sessions/current.md` file is a human-readable log, not a machine-resumable checkpoint — these are separate concerns.

2. **Component health classification**: classify each Zylos component (C2-C6) as critical, important, or optional and define explicit degradation behavior for each failure mode.

3. **Circuit breaker on LLM API**: wrap the Anthropic API call with a circuit breaker. When the API is consistently timing out, stop retrying and surface a clean "unavailable" response rather than stacking up queued requests.

4. **Heartbeat monitoring**: the current activity monitor (C2) provides external visibility but not self-healing. A simple heartbeat loop per component + supervisor restart logic would provide the missing recovery layer.

5. **Backoff on scheduler dispatch**: when a scheduled task fails, apply exponential backoff with jitter before retry rather than immediate re-dispatch.

---

## Further Reading

- [Erlang OTP Supervisor Behaviour (official docs)](https://www.erlang.org/doc/system/sup_princ.html)
- [The Zen of Erlang — Fred Hebert](https://ferd.ca/the-zen-of-erlang.html)
- [Adopting Erlang: Supervision Trees](https://adoptingerlang.org/docs/development/supervision_trees/)
- [The misunderstanding of "let it crash" — AmberBit](https://www.amberbit.com/blog/2019/7/26/the-misunderstanding-of-let-it-crash/)
- [Bastion: Fault-tolerant runtime for Rust](https://github.com/bastion-rs/bastion)
- [Lunatic: Erlang-inspired WASM runtime](https://lunatic.solutions/)
- [Supervision and Fault Tolerance in Actor Systems for Rust — Medium/Rustaceans](https://medium.com/rustaceans/when-things-break-supervision-and-fault-tolerance-in-actor-systems-2b61d41660f9)
- [Rust tokio task cancellation patterns](https://cybernetist.com/2024/04/19/rust-tokio-task-cancellation-patterns/)
- [Exponential Backoff and Jitter — AWS Architecture Blog](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
- [Timeouts, retries and backoff with jitter — AWS Builders' Library](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)
- [AIOS: LLM Agent Operating System (arXiv 2403.16971)](https://arxiv.org/abs/2403.16971)
- [AI Agent State Checkpointing: A Practical Guide — Fast.io](https://fast.io/resources/ai-agent-state-checkpointing/)
- [Graceful Degradation — AWS Well-Architected Reliability Pillar](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_mitigate_interaction_failure_graceful_degradation.html)
- [Kubernetes Liveness, Readiness, and Startup Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- [PM2 Restart Strategies](https://pm2.keymetrics.io/docs/usage/restart-strategies/)
- [Bulletproof agents with Durable Task — Microsoft](https://techcommunity.microsoft.com/blog/appsonazureblog/bulletproof-agents-with-the-durable-task-extension-for-microsoft-agent-framework/4467122)
