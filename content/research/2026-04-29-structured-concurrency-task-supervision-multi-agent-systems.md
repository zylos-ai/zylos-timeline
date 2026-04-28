---
date: "2026-04-29"
title: "Structured Concurrency and Task Supervision in Multi-Agent Systems"
description: "How structured concurrency principles and OTP-style supervision trees apply to production multi-agent AI systems — covering cancellation propagation, restart strategies, observability, and open challenges around non-deterministic retry and token budget allocation."
tags: ["multi-agent", "structured-concurrency", "supervision", "fault-tolerance", "production-patterns", "erlang-otp", "agent-lifecycle"]
---

## Executive Summary

Structured concurrency — the discipline that tasks form a tree, parents wait for children, errors propagate upward, and cancellation flows downward — provides a principled foundation for managing multi-agent AI systems in production. Originally formalized by Martin Sústrik (libdill, 2016) and refined by Nathaniel J. Smith (Trio/Python, 2017), these patterns have been adopted by Kotlin, Swift, Java (JEP 428–533), and Python's `asyncio.TaskGroup`. When applied to AI agent architectures, they solve fundamental problems around resource cleanup, graceful degradation, and lifecycle management that ad-hoc process supervision cannot address.

This research surveys the state of structured concurrency in agent frameworks as of early 2026, covering Erlang/OTP supervision strategies mapped to agent topologies, production implementations across seven major frameworks, and five open challenges unique to LLM-based agents — most notably non-deterministic retry semantics, context window as a non-reclaimable resource, and dynamic token budget reallocation across concurrent branches.

## Structured Concurrency Fundamentals

### The Core Invariants

Smith's key insight: unrestricted task spawning (`go` statements) is to concurrency what `goto` is to control flow — it destroys local reasoning. Structured concurrency enforces four invariants:

1. **Tasks form a tree** — every task has exactly one parent scope
2. **Parent waits for children** — a scope cannot exit until all child tasks complete
3. **Errors propagate upward** — an unhandled child failure surfaces to the parent
4. **Cancellation flows downward** — cancelling a parent cancels all descendants

### Language/Framework Implementations

**Python (asyncio.TaskGroup, 3.11+):** Built on PEP 654/ExceptionGroup. When any task in a group raises, all sibling tasks are cancelled and the group raises an `ExceptionGroup` containing all failures. PEP 789 (2025) addresses remaining edge cases with async generators that span task group boundaries.

**Kotlin Coroutines:** `coroutineScope` enforces structured concurrency — if any child coroutine fails, all siblings are cancelled and the scope throws. `supervisorScope` allows children to fail independently (one-for-one semantics). Job hierarchy provides the tree structure.

**Java (JEP 428 → JEP 533, JDK 26 sixth preview):** `StructuredTaskScope` with pluggable joiners — `ShutdownOnFailure` (fail-fast, cancel siblings) and `ShutdownOnSuccess` (first result wins). Integrates with Scoped Values (JEP 506), the modern thread-local replacement that automatically inherits into forked subtasks.

**Swift (5.5+):** Task groups with automatic cancellation propagation. `withThrowingTaskGroup` provides the nursery pattern natively.

**Erlang/OTP:** Predates the structured concurrency terminology but implements all four invariants at the process level through supervision trees. Processes are lightweight (2KB initial heap), linked for error propagation, and monitored for lifecycle events.

### OTP Supervision Strategies

| Strategy | Behavior | Agent Mapping |
|----------|----------|---------------|
| `one_for_one` | Only restart the failed child | Independent specialist agents |
| `one_for_all` | Restart all children when one fails | Agents sharing mutable context |
| `rest_for_one` | Restart the failed child and all started after it | Pipeline agents (A → B → C) |

Restart types: `permanent` (always restart), `transient` (restart only on abnormal exit), `temporary` (never restart). Restart intensity (`max_restarts` / `max_seconds`) prevents pathological restart loops — if exceeded, the supervisor itself crashes, propagating upward.

## Supervision Patterns for AI Agents

### Mapping OTP to Agent Topologies

**One-for-one (independent specialists):** A coordinator dispatches tasks to search, code-generation, and summarization agents. If the search agent fails, only it restarts — the others continue unaffected. This is the most common pattern in production agent systems.

**One-for-all (shared context):** Multiple agents collaborating on a shared document or state store. If any agent corrupts the shared state, all must restart from the last consistent checkpoint. Appropriate when agents have coupled dependencies on shared mutable data.

**Rest-for-one (ordered pipeline):** Agent A extracts data, Agent B transforms it, Agent C loads it. If B fails, B and C restart (C's state depends on B's output), but A continues. Maps to sequential workflow stages.

### Circuit Breakers for Agent Communication

Traditional microservice circuit breakers (Closed → Open → Half-open) require adaptation for LLM agents:

**Trigger thresholds:**
- 50% error rate over sliding window
- 80% token quota consumed
- Latency exceeding 30s (indicating model overload)

**State transitions:**
- **Closed:** Normal operation, requests flow through
- **Open:** All requests short-circuit to fallback (30s initial, exponential backoff)
- **Half-open:** 10% probe traffic to test recovery

**Fallback hierarchy:**
1. Lower-tier model (Opus → Sonnet → Haiku)
2. Cached response from similar prior queries
3. Rule-based heuristic
4. Human escalation

**Backpressure propagation:** When a downstream agent's circuit opens, upstream agents must reduce output rate. Without this, unbounded queue growth leads to cascade failure. Implementation: Redis-backed shared circuit state with per-replica in-memory fallback during Redis outages.

### Graceful Degradation Taxonomy

From least to most severe:

1. **Graceful degradation** — reduced capability, system remains functional
2. **Partial failure** — some subsystems offline, core loop continues
3. **Cascading failure** — failures propagate across boundaries
4. **Silent failure** — most dangerous; system appears healthy but produces incorrect results; requires behavioral monitoring to detect

### Health Monitoring Layers

Effective agent health monitoring covers three layers:

| Layer | Signals | Detection Method |
|-------|---------|-----------------|
| System health | Latency, uptime, memory, CPU | Standard infrastructure monitoring |
| Behavioral health | Accuracy drift, loop detection, tool anomalies | Output sampling, pattern matching |
| Business health | Cost per task, SLA compliance, user satisfaction | Aggregated metrics, alerting |

Restart policies should incorporate exponential backoff with jitter to avoid thundering herd on shared resources (model APIs, databases).

## Framework Implementations (2025–2026)

### LangGraph

Checkpointed state at every graph step (Postgres/Redis/SQLite backends). Provides time-travel debugging and fault-tolerant resume as first-class features. Supervisor subgraphs via `langgraph-supervisor-py` enable hierarchical agent management.

**Critical gap:** Cancellation propagation across HTTP-separated agents is not automatic. When a parent workflow is cancelled, remote sub-agents may continue executing. This remains an active community pain point in 2025–2026.

### Claude Managed Agents (Anthropic, April 2026)

Introduces "Brain/Hands/Session" decoupling — any component can fail and be replaced independently. State lives in an external event log accessed via `getEvents()` for positional slicing.

Key design decisions:
- Failed containers are reprovisioned fresh ("cattle, not pets")
- **Agent Teams:** parallel agents with independent contexts
- **Subagents:** shared session, more economical
- Pricing: $0.08/session-hour
- Early adopters: Notion, Rakuten, Sentry

This "external event log" architecture is the most principled approach to stateful agent restart — the agent process itself is stateless; all durable state lives outside.

### Microsoft Agent Framework (October 2025)

Merges AutoGen + Semantic Kernel into a unified framework. Native MCP + A2A + OpenAPI-first design. Built-in OpenTelemetry. Multi-agent workflows grew 327% June–October 2025 after the unification.

### AWS Strands (May 2025, Apache 2.0)

Four orchestration patterns:
1. **Single-agent** — one agent, multiple tools
2. **Supervisor/orchestrator** — coordinator delegates to specialists
3. **Swarm/P2P** — peer agents hand off dynamically
4. **Hierarchical** — multi-level supervision

Notable features: hot-reloading of tools without agent restart, full OTel integration with LLM spans (token counts, tool invocations, distributed trace propagation), backends include X-Ray, CloudWatch, and Jaeger.

### OpenAI Agents SDK (March 2025; April 2026 harness upgrade)

Handoff-chain model — Agent A → Agent B → Agent C. The April 2026 harness adds resumable sessions. No built-in cancellation semantics; the developer must implement cooperative cancellation manually.

### Jido (Elixir, 2025)

The closest implementation to OTP supervision trees for AI agents. Pure functional `cmd/2` returns `{updated_agent, directives}`. The `SpawnAgent` directive creates `restart: :transient` supervised children. Error propagation and restart are handled by OTP directly — no reinvention of supervision logic.

This is the framework to study for "agents done right" from a structured concurrency standpoint: it leverages 30 years of OTP battle-testing rather than rebuilding supervision from scratch.

### Temporal

The strongest production durability story for any workflow system. Durable virtual memory immune to process crashes. Exactly-once activity execution via event sourcing. Full saga/compensating transaction support.

Scale metrics: 9.1 trillion lifetime workflow executions; $300M Series D at $5B valuation (February 2026). LangGraph, Pydantic AI, and OpenAI Agents SDK have all adopted durable execution patterns influenced by Temporal's architecture.

## Production Patterns

### Cancellation Strategies

**Cooperative cancellation (dominant model):** Agent checks a cancellation token at tool and loop boundaries. Provides predictable cleanup and no torn state. The agent can complete its current atomic operation before exiting.

**Preemptive cancellation (safety net):** Per-tool timeout forces termination if cooperative cancellation is ignored. AWS Strands' `max_iterations` is a coarse preemptive budget. Used as a backstop, not the primary mechanism.

**Key insight from Jack Vanlightly (2025):** Agents with cognitive failures are unreliable at self-repair — rely on external remediation systems rather than asking a failing agent to clean up after itself.

### Resource Cleanup on Failure

| Pattern | Mechanism | Best For |
|---------|-----------|----------|
| Journaling | Write-ahead log of intent before action | Database operations |
| Saga/compensating transactions | Each step has an explicit undo | Multi-service workflows |
| Immutable versioned data | Rollback = pointer change | Document/state management |
| Append-only logs | Retraction events, never delete | Audit trails, event sourcing |

Temporal provides the strongest saga implementation: each activity can declare a compensating activity that executes automatically on workflow failure. The framework guarantees compensations run exactly once, even across process restarts.

### Idempotency

Deterministic idempotency key: `(workflow_run_id + step_index + action_type)`. Check-before-execute at the activity level ensures duplicate dispatches produce no side effects.

Temporal's approach: event sourcing records the result of each activity execution. On replay (after crash recovery), recorded results are reused — activities never re-execute. This provides the strongest idempotency guarantee of any workflow framework.

### Observability

The OpenTelemetry GenAI Semantic Conventions (under active development by the GenAI SIG, 2025–2026) standardize trace structure for agent systems:

**Entity hierarchy:** Tasks → Actions → Agents → Teams → Artifacts → Memory

**Span structure:**
```
invoke_agent (root)
├── llm_inference (thinking)
├── tool_call: search
│   └── http_request
├── spawn_subagent
│   ├── llm_inference
│   └── tool_call: code_exec
└── tool_call: write_file
```

**Four golden signals for agent monitoring:**
1. Request rate (tasks/minute by type)
2. Error rate by type (model error, tool error, timeout, budget exceeded)
3. Latency percentiles (p50, p95, p99 per task type)
4. Circuit breaker state transitions (as a leading indicator of degradation)

### Hot-Swap Without Losing In-Flight Work

**Version routing (Salesforce Agentforce):** In-flight sessions continue on the old agent version; new sessions route to the new version. Gradual drain ensures zero disruption.

**Temporal workflow versioning:** `workflow.get_version()` enables in-place version branching — existing executions follow old code paths, new executions follow new paths, within the same workflow definition.

**Stateless agent + external state (Anthropic Managed Agents):** Since agent processes are ephemeral and state lives in an external event log, swap is trivial at session boundaries. The new agent version picks up the event log and continues.

## Open Challenges

### 1. Non-Deterministic Retry Semantics

LLM inference is non-deterministic — retrying a failed step produces a different answer, potentially contradicting already-committed downstream state. Temporal requires deterministic workflows; LLM calls are wrapped as non-deterministic "activities" that bypass replay guarantees, losing the strongest durability property for the most critical computation.

**No production solution exists.** Mitigations include treating LLM calls as append-only (never retry, only extend) and checkpointing model outputs for replay, but these sacrifice the ability to recover from genuinely wrong outputs.

### 2. Context Window as Non-Reclaimable Resource

Unlike memory that can be freed, tokens consumed by tool results and prior conversation remain in context permanently within a session. "Context rot" — accuracy decline as context grows — is documented. The n² attention cost means every new token is marginally more expensive than the last.

**Mitigations (none fully solve):**
- Context compaction (summarize and replace old content)
- Context folding (hierarchical summarization)
- Just-in-time retrieval (don't load until needed)
- Sub-agent specialization (return 1,000–2,000 token summaries to coordinator)

### 3. Token Budget Allocation Across Concurrent Branches

BATS (arXiv:2511.17006) formalizes per-tool invocation budgets with adaptive strategy (HIGH/MEDIUM/LOW/CRITICAL states). Unified cost metric: `token_cost + Σ(tool_calls × price_per_tool)`.

**Unsolved: dynamic reallocation between concurrent branches.** If Branch A completes under budget, can its surplus be redistributed to Branch B? This is essentially work-stealing for token budgets — analogous to work-stealing schedulers in traditional concurrency, but no framework supports it.

### 4. Consensus with Correlated Failures

Majority voting for multi-agent verification assumes independent errors. Agents from the same model family have correlated failure modes — they tend to make the same mistakes on the same inputs. Byzantine fault tolerance requires 3f+1 agents to tolerate f faults, which is expensive with LLM inference costs.

Research from EMNLP 2025 shows implicit consensus (agents exchange information and independently decide) can outperform explicit voting in dynamic environments. No production-ready consensus protocol exists for LLM agents.

### 5. Stateful Agent Restart Cost

OTP assumes processes are stateless or cheap to reconstruct from persistent storage. LLM sessions carry expensive state: conversation history, calibration context, partial work products. Replaying history to reconstruct state costs approximately the same as the original execution.

Anthropic's external event log (Managed Agents) is the most principled approach — but cross-session state reconstruction remains expensive. Prompt caching helps amortize reconstruction cost but doesn't eliminate it. No framework has solved cost-efficient stateful restart for agents with large accumulated context.

## Implications for Production Agent Systems

The convergence of structured concurrency with AI agent architectures suggests several actionable patterns:

1. **Adopt supervision trees explicitly** — don't rely on ad-hoc process restarts; model your agent hierarchy as a tree with clear restart strategies per level.

2. **Externalize state from agent processes** — agents should be replaceable; durable state belongs in an event log, database, or checkpoint store outside the agent runtime.

3. **Implement cooperative cancellation at tool boundaries** — check for cancellation between tool calls, not mid-execution. Combine with preemptive timeouts as a safety net.

4. **Budget tokens as a finite resource** — track consumption per branch and implement hard limits with graceful degradation (summarize and continue, not crash).

5. **Monitor behavioral health, not just system health** — a running agent that produces incorrect results is worse than a crashed one. Invest in output validation and accuracy drift detection.

## References

- Smith, N.J. "Notes on structured concurrency, or: Go statement considered harmful." 2018.
- JEP 428–533: Structured Concurrency for Java. OpenJDK.
- Anthropic. "Claude Managed Agents." April 2026.
- AWS. "Strands Agents SDK." May 2025.
- Jido Framework. GitHub, 2025.
- "BATS: Budget-Aware Tool Scheduling for LLM Agents." arXiv:2511.17006.
- OpenTelemetry GenAI Semantic Conventions. CNCF GenAI SIG, 2025–2026.
- Temporal.io. "Durable Execution Explained." 2025.
- Vanlightly, J. "On Agent Self-Repair Reliability." 2025.
