---
date: "2026-03-16"
title: "Incremental Computation and Reactive Dataflow for AI Agent State Management"
description: "How self-adjusting computation, differential dataflow, and fine-grained signals can make AI agent runtimes respond to state changes in time proportional to the change — not the total state."
tags: ["incremental-computation", "reactive-dataflow", "agent-runtime", "rust", "salsa", "differential-dataflow", "signals"]
---

## Executive Summary

AI agent runtimes face a fundamental asymptotic problem: as agent state grows (memory, context, tool results, inter-agent messages), naively recomputing derived views on every change becomes prohibitively expensive. Incremental computation — a family of techniques that make programs automatically avoid redundant work by tracking dependencies and propagating only deltas — offers a path from O(total_state) to O(changed_state) per update cycle.

This article surveys the theoretical foundations (self-adjusting computation, Adapton), production systems (Salsa, differential dataflow, Turbopack), and the Rust ecosystem's rich toolkit for building incremental agent runtimes. We examine five concrete application patterns: state change propagation across agent networks, incremental plan re-evaluation, reactive fleet dashboards, change-driven tool invocation, and incremental knowledge graph updates. The analysis concludes with architectural recommendations for Rust-based agent systems.

## The Core Problem: Recomputation Scales With Total State

Consider an agent runtime managing 100 bots, each with memory, active tasks, tool results, and inter-agent subscriptions. When one bot's status changes, the system must update dashboards, notify subscribers, re-evaluate dependent plans, and potentially trigger downstream tool invocations. The naive approach — recompute everything from scratch — scales as O(N × S) where N is the number of bots and S is the average state size per bot.

Incremental computation replaces this with O(Δ) — work proportional to what actually changed. Three mechanisms underpin all incremental systems:

- **Memoization with invalidation**: Cache computation results; mark them dirty when dependencies change.
- **Dependency tracking**: Record which computations read which data at runtime.
- **Change propagation**: When an input changes, propagate effects through the dependency graph.

The difference is not merely a constant-factor optimization. For large, long-running systems, it is the difference between sub-millisecond updates and full recomputation taking seconds.

## Theoretical Foundations

### Self-Adjusting Computation

Umut Acar's 2005 CMU dissertation established the theoretical foundation. Programs are represented as **Dynamic Dependence Graphs (DDGs)** capturing both data and control dependencies. A change-propagation algorithm replays only affected sub-computations when inputs change. In many cases, update time approaches the information-theoretic optimum — you cannot do better without skipping necessary work.

The key insight is that self-adjusting programs are **composable**: any function can be made incremental by wrapping it in the framework, and composed incremental functions remain incremental. This composability is what makes the approach practical for complex agent systems where state derivation chains are deep and dynamic.

### Adapton: Demand-Driven Change Propagation

Adapton (Hammer et al., PLDI 2014) extended self-adjusting computation with a crucial innovation: **demand-driven semantics**. Computations are only re-evaluated when their results are actually demanded, not eagerly propagated. This avoids wasted work on outputs no one currently needs — a common scenario in agent systems where many derived views exist but only a subset is actively queried at any time.

Adapton introduces two primitives:

- **Cells**: Mutable data inputs that can change over time.
- **Thunks**: Cached computations whose results and dependency observations are stored in a **Demanded Computation Graph (DCG)**.

The Rust implementation (`adapton.rust`) achieves the highest performance of any Adapton variant because Rust's ownership model eliminates the need for tracing garbage collection — a major bottleneck in incremental systems where stale cached results accumulate rapidly.

### DBSP: Algebraic Incrementalization

DBSP (best paper, VLDB 2023; extended in VLDB Journal 2025) provides the most elegant theoretical treatment. Its circuit algebra uses just four operators — **lift**, **delay**, **differentiate**, and **integrate** — to express arbitrary SQL, Datalog, and relational algebra incrementally. Given any DBSP program, the system can **mechanically derive** its incremental version.

Where Adapton operates on individual cached computations, DBSP operates on **streams of changes** (Z-sets: collections of `(data, time, multiplicity)` triples where negative multiplicity represents deletion). This makes it naturally suited for event-driven agent systems where state changes are append-only logs of events.

## Production Systems and the Rust Ecosystem

### Salsa: The Gold Standard for Query-Based Incrementality

Salsa, used by rust-analyzer, Ruff, and Turbopack, implements **on-demand, query-based incremental computation**. Its core abstractions map cleanly to agent runtime concepts:

- **Inputs**: Root data that can be mutated externally (agent config, environment variables, incoming messages).
- **Tracked functions**: Pure functions whose results are memoized against a database keyed by their arguments (derived agent state, dashboard summaries, plan validity checks).
- **Tracked structs**: Intermediate immutable data produced within tracked computations.

Salsa's **Red-Green Algorithm** is the engine:

1. A global **revision counter** increments on every input change — O(1) cost.
2. Each memoized result records the revision at which it was last verified.
3. On query, Salsa performs a forward traversal to inputs, checking if any dependency changed.
4. If no dependency changed, the result is **backdated** without re-execution.
5. If a dependency changed, the function re-executes. If the new result equals the old (**early cutoff**), downstream dependents are not invalidated.

The early cutoff optimization is particularly valuable for agent systems: a context change that doesn't affect a plan step's logical inputs should not trigger LLM re-invocation.

**Durability** is another Salsa feature relevant to agents. rust-analyzer's work on **durable incrementality** — persisting the memoization graph to disk — enables warm caches across process restarts. For agent runtimes that restart between sessions, this means derived state can be recovered instantly rather than recomputed from scratch.

### Differential Dataflow: Incremental Data-Parallel Computation

Frank McSherry's differential dataflow (CIDR 2013) is the most theoretically sophisticated system for data-parallel incremental workloads. It operates over Z-sets and supports the full relational algebra — joins, aggregations, group-by, and recursive Datalog queries — with correct incremental implementations.

**Materialize**, the primary commercial deployment, operates as a streaming SQL database maintaining materialized views incrementally over Kafka/Postgres CDC streams. For agent runtimes, this is directly applicable: agent events (task_started, tool_called, error, completed) written to a streaming log can have SQL views maintained over them with sub-second freshness.

**Pathway** makes differential dataflow accessible through a Python API backed by a Rust engine, with LLM-specific extensions (vector indexing, LangChain integration) for live RAG pipelines.

### Turbopack: State of the Art in Production

Turbopack (stable in Next.js 16, January 2026) represents the most complete production implementation, combining Salsa-like memoization with signal-like fine-grained dependency tracking:

- **Value cells** (`Vc<T>`): Every piece of intermediate state is a value cell. Functions record which cells they read during execution, automatically building the dependency graph.
- **Automatic dependency tracking**: No manual declaration of dependencies. The runtime observes reads and writes.
- **Aggregation graphs**: A parallel data structure over the dependency graph that summarizes subtrees for efficient bulk queries (collect all errors, find all dirty nodes).
- **File system caching**: The full dependency graph and all value cell contents are persisted to disk and restored on restart.

### Comemo: Simple Memoization for Pure Functions

Typst's Comemo offers a simpler alternative to Salsa. Functions annotated with `#[comemo::memoize]` cache results; arguments wrapped in `Tracked<T>` record which parts of the argument were actually accessed — not just that the argument changed. This provides fine-grained access tracking without requiring the full Salsa query graph.

Comemo stores 128-bit SipHashes of results rather than full result values, reducing cache memory overhead. For agent systems, this is ideal for lightweight memoization of pure utility functions (formatting, filtering, summarization) without the complexity of a full incremental framework.

### Fine-Grained Signals: Leptos and Dioxus

The signals pattern from UI frameworks translates well to agent state fan-out:

- **Signals**: Atomic mutable state units (agent status, task progress).
- **Memos/Computed**: Derived values that automatically re-evaluate when signal dependencies change, with equality-based deduplication.
- **Effects**: Side-effect runners that re-execute when their signal reads change (WebSocket push, notification dispatch).

Leptos and Dioxus implement this pattern in Rust. The reactive core can be used standalone outside of a UI framework — `reactive_graph` (Leptos's underlying algorithm) is available as an independent crate.

### Buck2's DICE: Parallel Incremental Computation at Scale

Meta's Buck2 build system uses DICE, a Rust incremental computation engine inspired by Shake, Salsa, Skip, and Adapton. DICE demonstrates that incremental computation scales to entire corporate codebases with parallel evaluation across the dependency graph. Build systems are structurally similar to agent task graphs: external inputs trigger expensive computation steps that produce outputs, and incremental recomputation is essential for responsiveness.

## Application Patterns for Agent Runtimes

### Pattern 1: State Change Propagation Across Agent Networks

In a multi-agent system communicating via WebSocket, state changes (tool invocations, LLM responses, external events, inter-agent messages) must propagate to subscribers: dashboards, dependent agents, memory systems.

The **push-pull hybrid** pattern fits naturally:

1. On state change, push a dirty marker to all registered dependents — O(1) per subscriber.
2. When a subscriber queries its derived view, pull by re-executing only the dirty portions.
3. Apply early cutoff: if derived state equals previous value, do not propagate further.

For WebSocket broadcasts, adopt a differential message format: instead of full state snapshots, send `(entity_type, entity_id, field, new_value, revision)` tuples. Recipients maintain local views and apply deltas, requesting full snapshots only when they detect missed revisions — analogous to Materialize's `SUBSCRIBE` with snapshot fallback.

### Pattern 2: Incremental Plan Re-Evaluation

Agent planning involves expensive LLM calls, tool lookups, and constraint checking. When context changes, the plan should be partially re-evaluated rather than regenerated from scratch.

Represent the plan as a **dependency graph of steps**, where each step declares which context variables it reads (analogous to Salsa inputs). When a context variable changes, mark dependent plan steps as dirty. Re-evaluate only dirty steps, applying early cutoff: if a re-evaluated step produces the same decision as before, downstream steps need not re-evaluate.

Research supports this direction. A 2025 paper on "Revisiting Replanning from Scratch: Real-Time Incremental Planning" specifically addresses incrementally-valid replanning, and streaming decision agents (2026) use online A* planners in receding-horizon loops where incremental plan evaluation is the key to tractability.

### Pattern 3: Reactive Fleet Dashboards

Real-time agent fleet dashboards map directly onto incremental view maintenance. Three approaches at different complexity levels:

**Differential dataflow approach**: Maintain SQL views over an event stream via Materialize or DBSP. Dashboard queries ("active agents by status", "average task duration in last 5 minutes") update incrementally on each new event.

**Signal-based approach**: Each agent's status is a signal. Derived signals compute fleet-level aggregates. The UI subscribes to aggregate signals and updates surgically. Simpler to implement in a pure-Rust stack.

**Custom push-pull**: Each bot has a `Signal<BotState>`. Dashboard subscribers register as reactive consumers. On state change, dirty-mark derived aggregates; recompute and push deltas to WebSocket clients.

### Pattern 4: Change-Driven Tool Invocation

Tools (web search, database queries, file reads) are expensive. If a tool's inputs haven't changed, its output needn't be recomputed.

A 2025 MDPI paper on hierarchical caching for agentic workflows proposes a multi-level architecture:

- **Workflow-level cache**: Reuse entire multi-step tool sequences if all inputs match.
- **Tool-level cache**: Reuse individual tool results if that tool's specific inputs match.
- **Dependency-aware invalidation**: Graph-based tracking ensures write operations correctly invalidate downstream read caches.
- **Category-specific TTLs**: Different tools have different staleness tolerances (file read: seconds; DNS lookup: minutes; web search: hours).

In Rust, this maps to Comemo-style `#[memoize]` annotations on tool invocation functions with `Tracked<T>` arguments that record which parts of the input were actually accessed.

### Pattern 5: Incremental Knowledge Graph Updates

Graphiti (by Zep) demonstrates incremental computation applied to agent memory as a knowledge graph. Rather than batch-recomputing the entire graph when new episodes arrive, Graphiti:

- Continuously ingests episodes and immediately extracts entities and relationships.
- Resolves new entities against existing nodes incrementally.
- Maintains a **bi-temporal model** (event time + ingestion time) with explicit validity intervals on edges.
- Uses semantic conflict detection to update or invalidate outdated knowledge without discarding it.
- Achieves P95 retrieval latency of 300ms using hybrid search without LLM calls during retrieval.

This is incremental view maintenance applied to a property graph, where the "views" are entity relationship states and the "inputs" are incoming episodes.

## Comparing Approaches

### Push vs. Pull vs. Push-Pull

| Property | Push-Based | Pull-Based | Push-Pull Hybrid |
|----------|-----------|-----------|-----------------|
| Update trigger | Source propagates to all dependents | Consumers query on demand | Push marks dirty; pull re-executes on demand |
| Glitch risk | High (intermediate states visible) | None | None (if well-implemented) |
| Wasted work | Propagates to unused outputs | Full re-execution on query | Only marked-dirty nodes re-execute |
| Dynamic dependencies | Difficult | Natural | Natural |
| Back-pressure | Difficult | Easy (consumer controls) | Easy |

Analysis of three reactivity algorithms (Jonathan Frere, 2025) shows that pure push suffers from the "diamond problem" (a node updated twice through two paths from a common ancestor); pure pull wastes work re-traversing unchanged subgraphs; push-pull hybrid is O(n) with each node visited exactly once per update cycle.

### Topological vs. Demand-Driven Scheduling

| Property | Topological (batch, forward) | Demand-Driven (lazy, backward) |
|----------|------------------------------|-------------------------------|
| Execution | Process all dirty nodes in topo order | Re-execute only when output is queried |
| Systems | Make, Shake, basic reactive streams | Salsa, Adapton, Turbopack |
| Wasted work | May compute unread nodes | None (only demanded nodes) |
| Parallelism | Easier (level parallelism) | Harder (query-driven) |

For agent runtimes, demand-driven evaluation is preferable when many derived views exist but only a subset is actively queried — a dashboard that's not open shouldn't trigger recomputation.

### Fine-Grained vs. Coarse-Grained

Fine-grained reactivity (signals, Salsa tracked functions) minimizes re-execution per change at the cost of higher bookkeeping overhead per node. Coarse-grained reactivity (per-file in Make, per-agent in naive systems) has less bookkeeping but over-triggers recomputation.

For agent runtimes: coarse-grained is acceptable for agent-level state (per-bot status, per-task progress); fine-grained becomes essential when agents have complex derived state computed from joins over many agents.

## Cutting-Edge: Reactive Probabilistic Reasoning

A February 2026 paper, "Reactive Knowledge Representation and Asynchronous Reasoning," introduces **Reactive Circuits (RCs)** — a framework applying incremental computation to probabilistic inference for real-time agents:

- Drone swarms and autonomous agents must continuously update beliefs as sensor data streams in at different rates.
- RCs partition computations by signal **Frequency of Change (FoC)**, estimated via Kalman filters.
- High-volatility sub-graphs are re-evaluated frequently; low-volatility sub-graphs are memoized and reused.
- Performance: orders-of-magnitude speedup over frequency-agnostic inference in multi-UAV simulations.

This is directly applicable to agents integrating multiple data streams with different update rates — environment sensors refresh constantly while configuration changes rarely.

## Challenges

### Garbage Collection of Stale Computations

Incremental systems accumulate stale cached results. In Rust, the system must explicitly track reachability:

- **Reference counting** (Turbopack): Cells freed when reference count drops to zero. Works well for acyclic graphs.
- **Epoch-based collection** (Salsa): Old revisions' results freed when no live query depends on them.
- **Explicit eviction** (Skip): LRU or capacity-based eviction with reactive re-computation on cache miss.

Cycles in the dependency graph (agent A depends on agent B which depends on agent A) require special handling — differential dataflow's lattice time model handles iterative queries; Salsa assumes acyclic graphs.

### Side Effects in Incremental Systems

Pure functions are safe to cache; LLM calls, tool invocations, and network requests are not. Three strategies:

1. **Isolate effects**: Separate pure computation from effectful execution. Only memoize the pure parts.
2. **Effect tracking with staleness**: Mark effectful computations as impure with explicit TTL-based cache entries rather than dependency-based invalidation.
3. **Idempotent effects**: Design tool invocations to be idempotent (same inputs → same output). Then memoization is safe even for "effectful" functions.

### Distributed Incremental Computation

When agents are distributed across processes and machines, change propagation faces consistency, partial failure, and latency challenges. Research on multi-agent coordination frameworks shows they waste 53-86% of tokens on redundant context sharing — an incremental approach would share only deltas, not full replays, directly applying differential dataflow's Δ-propagation model.

### Debugging Reactive Dataflow

Reactive systems move complexity from application code into the runtime. The call stack no longer reflects causation, and time-travel debugging becomes essential. Silent failures — where missed dependency tracking returns stale results without error — are particularly insidious. Research on debugging data flows in reactive programs (ICSE 2018) identifies that specialized tooling is required.

## Architectural Recommendations

For Rust-based agent runtimes, the research suggests a layered approach:

1. **Salsa or Comemo for state derivation**: Use Salsa's tracked functions for complex query-structured derived state (effective configuration, plan validity). Use Comemo's simpler `#[memoize]` for pure utility functions.

2. **Signals for WebSocket fan-out**: Use Leptos's `reactive_graph` crate standalone for push-pull propagation of bot state changes to dashboard subscribers.

3. **Delta-based inter-agent protocol**: Send `(entity, field, value, revision)` tuples instead of full state snapshots. Recipients apply deltas locally, requesting full snapshots only on detected gaps.

4. **Two-level tool cache**: In-memory Comemo-style memoization (fast, fine-grained) backed by persistent SQLite cache (durable, TTL-based) for expensive tool results.

5. **Plan dependency graph with early cutoff**: Represent plans as DAGs with declared context dependencies. Re-evaluate only dirty steps; skip LLM re-invocation when early cutoff detects no logical change.

The fundamental shift is from "recompute everything on every change" to "track what depends on what, and only redo the minimum." For agent runtimes managing growing state over long lifetimes, this shift is not an optimization — it is an architectural necessity.

## References

- Acar, U. A. (2005). Self-Adjusting Computation. CMU Dissertation.
- Hammer, M. A. et al. (2014). Adapton: Composable, Demand-Driven Incremental Computation. PLDI 2014.
- McSherry, F. et al. (2013). Differential Dataflow. CIDR 2013.
- Budiu, M. et al. (2023). DBSP: Automatic Incremental View Maintenance. VLDB 2023, extended VLDB Journal 2025.
- Salsa Framework. https://github.com/salsa-rs/salsa
- Comemo (Typst). https://github.com/typst/comemo
- Materialize. https://github.com/MaterializeInc/materialize
- Graphiti (Zep). https://github.com/getzep/graphiti
- Turbopack Incremental Computation. https://nextjs.org/blog/turbopack-incremental-computation (January 2026).
- Durable Incrementality — rust-analyzer. https://rust-analyzer.github.io/blog/2023/07/24/durable-incrementality.html
- Reactive Knowledge Representation and Asynchronous Reasoning. arXiv:2602.05625 (February 2026).
- Hierarchical Caching for Agentic Workflows. MDPI, 2025.
- Frere, J. (2025). Three Reactivity Algorithms. https://jonathan-frere.com/posts/reactivity-algorithms/
- Buck2 DICE. https://github.com/facebook/buck2/blob/main/dice/dice/docs/index.md
- Pathway. https://github.com/pathwaycom/pathway
- Skip (SkipLabs). https://skiplabs.io/
