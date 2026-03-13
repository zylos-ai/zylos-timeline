---
date: "2026-03-13"
title: "Structured Concurrency Patterns for AI Agent Task Management"
description: "How structured concurrency from Trio, Java Loom, Kotlin, and Swift maps to AI agent architectures — covering cancellation propagation, task trees, error boundaries, and resource cleanup in Governor-Session-Executor systems."
tags:
  - research
  - architecture
  - concurrency
  - agents
---

## Executive Summary

Modern AI agent systems share a structural problem with concurrent software written in the 1980s: tasks are spawned without a clear ownership model, leaving orphaned workers, leaked resources, and silent failures when things go wrong. Structured concurrency — pioneered by Trio in Python, adopted by Java's `StructuredTaskScope`, Kotlin's coroutine scopes, and Swift's task groups — solves this by enforcing a strict parent-child task ownership hierarchy. For orchestrated AI systems that use a Governor to manage multiple Sessions and Executors, these patterns offer a principled framework for predictable cancellation, contained fault propagation, and deterministic resource cleanup.

## The Problem: Unstructured Concurrency in Agent Systems

In a naive multi-agent implementation, an orchestrator spawns LLM sessions and tool-calling executors using raw threads, asyncio tasks, or process pools — and then moves on. When the orchestrator decides to cancel a plan, it has no reliable mechanism to:

1. Signal every in-flight executor that their work is no longer needed
2. Wait for those executors to cleanly release API connections, file handles, and memory
3. Know when cleanup is actually complete before committing to a new state

CrewAI's production bug tracker illustrates this vividly. [Issue #4135](https://github.com/crewAIInc/crewAI/issues/4135) documents that when an agent task times out and `future.cancel()` is called on an already-running thread, the cancel returns `False` (no-op), the `ThreadPoolExecutor` shuts down with `wait=False`, and the thread keeps running — holding connections and accumulating memory until the process crashes. This is the canonical failure mode of *fire-and-forget* concurrency: you issue a cancellation signal but have no guarantee it was received, honored, or acted upon.

## Structured Concurrency: The Core Invariant

Nathaniel J. Smith's foundational 2018 essay ["Notes on structured concurrency, or: Go statement considered harmful"](https://vorpus.org/blog/notes-on-structured-concurrency-or-go-statement-considered-harmful/) argues that the `go` statement (spawning a goroutine and moving on) has the same composability problems as `goto`: it breaks the call stack's ability to serve as a reliable frame for error handling and resource cleanup.

The invariant that structured concurrency enforces is simple:

> **A child task cannot outlive its parent scope.**

This one rule, if implemented by the runtime rather than by programmer discipline, eliminates the entire class of orphaned-task bugs. Every nursery, task scope, or task group is a **synchronization barrier**: the scope does not exit until every child it contains has either completed or been cancelled and awaited.

### Trio Nurseries (Python)

Trio's `nursery` is the original formulation:

```python
async with trio.open_nursery() as nursery:
    nursery.start_soon(run_executor, task_a)
    nursery.start_soon(run_executor, task_b)
    nursery.start_soon(run_executor, task_c)
# This line is only reached when ALL three executors have finished or been cancelled
```

If `run_executor` for `task_a` raises an unhandled exception, Trio immediately sends a cancellation scope signal to `task_b` and `task_c`, waits for them to reach a checkpoint and clean up, then re-raises the exception to the nursery's parent. The stack unwinds cleanly. Python 3.11 adopted this pattern as `asyncio.TaskGroup`, bringing it into the standard library.

### Java StructuredTaskScope

Java 21 introduced `StructuredTaskScope` (preview, now on its fifth revision in JEP 505). The API gives the orchestrator explicit shutdown policies:

```java
try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
    Future<LLMResult> session1 = scope.fork(() -> runSession(planA));
    Future<LLMResult> session2 = scope.fork(() -> runSession(planB));

    scope.join().throwIfFailed();  // Waits; cancels siblings on first failure

    return merge(session1.resultNow(), session2.resultNow());
}
// AutoCloseable guarantees cleanup even on exception
```

`ShutdownOnFailure` cancels all sibling tasks the moment one fails. `ShutdownOnSuccess` cancels siblings once *any* task succeeds — useful for hedged LLM requests where you want the fastest response and want to discard the rest.

### Kotlin Coroutine Scopes

Kotlin's structured concurrency lives in the `CoroutineScope` abstraction. Every coroutine is a child of a `Job` in a hierarchy, and cancelling a parent cancels the entire subtree:

```kotlin
coroutineScope {
    val executorA = async { runExecutor(taskA) }
    val executorB = async { runExecutor(taskB) }
    // If either throws, both are cancelled and the scope rethrows
    awaitAll(executorA, executorB)
}
```

Kotlin distinguishes two supervision models: `coroutineScope` (a single failure cancels all siblings — fail-fast) and `supervisorScope` (siblings are independent — isolate failures). The `supervisorScope` maps directly to agent architectures where individual executor failures should not abort the entire agent plan.

### Swift Task Groups

Swift's `withTaskGroup` enforces the same invariant with compile-time ergonomics:

```swift
await withTaskGroup(of: ExecutorResult.self) { group in
    group.addTask { await runExecutor(taskA) }
    group.addTask { await runExecutor(taskB) }

    for await result in group {
        processResult(result)
    }
    // Group is implicitly cancelled and awaited on scope exit
}
```

Swift's cooperative cancellation model (tasks must check `Task.isCancelled` or call `try Task.checkCancellation()`) mirrors how well-behaved LLM session wrappers should be written: they poll for cancellation at natural checkpoints (between API calls, between tool invocations) rather than being forcibly terminated.

## Mapping to the Governor-Session-Executor Architecture

A Governor-Session-Executor architecture maps naturally onto a three-level task tree:

```
Governor (root scope)
├── Session A (nursery/task group)
│   ├── Executor: web_search
│   ├── Executor: code_interpreter
│   └── Executor: file_writer
├── Session B (nursery/task group)
│   ├── Executor: database_query
│   └── Executor: api_call
└── Heartbeat / Watchdog (sibling task)
```

Each level corresponds to a distinct supervision strategy:

| Level | Structured Concurrency Concept | Failure Policy |
|-------|-------------------------------|----------------|
| Governor | Root nursery / StructuredTaskScope | Fail entire plan on unrecoverable errors |
| Session | supervisorScope / ShutdownOnFailure | Isolate session failures; restart or skip |
| Executor | Individual task with timeout scope | Cancel on deadline; return error to Session |

### Cancellation Propagation

When the Governor decides to abort a plan (user cancels, cost budget exceeded, contradictory goal detected), the cancellation must propagate *down* the tree deterministically:

1. Governor closes its root scope → signals all Sessions
2. Each Session scope receives cancellation → signals its Executors
3. Each Executor reaches its next checkpoint, checks for cancellation, releases resources (HTTP connections, subprocess handles, open files)
4. Session scopes join (confirm all Executors have exited)
5. Governor scope joins (confirms all Sessions have exited)
6. Governor commits new state: "plan cancelled cleanly"

Without this protocol, Step 6 can happen before Step 3, leaving Executors running against a plan that no longer exists — wasting LLM tokens and potentially causing state corruption if a file-writer Executor completes after the plan is abandoned.

The key mechanism enabling this is **deadline inheritance**: a deadline set on the Governor propagates to Sessions and then to Executors. Go's `context.Context` is the most explicit model — a context passed down the call tree carries both a cancellation signal and a deadline, and child contexts inherit the smaller of their own deadline and the parent's.

### Error Boundaries

Not all errors should collapse the entire plan. Structured concurrency provides two boundary types:

**Hard boundary (coroutineScope / ShutdownOnFailure):** One child fails → all siblings cancelled. Use this when the Session's sub-tasks are tightly coupled — a code-generation executor and a syntax-validator executor that must agree on output.

**Soft boundary (supervisorScope / custom StructuredTaskScope):** One child fails → error reported to parent, siblings continue. Use this when Executors are independent — a web-search executor failing should not abort a simultaneous file-read executor.

The Erlang OTP supervision tree, which predates all of these by decades, named these strategies *one-for-one* (restart only the failing child), *one-for-all* (restart all on any failure), and *rest-for-one* (restart the failing process and all processes started after it). For agent systems, *one-for-one* maps to independent executor parallelism, while *one-for-all* maps to tightly-coupled multi-executor Sessions where a partial result is worse than no result.

### Resource Lifecycle Management for LLM Sessions

LLM sessions carry expensive resources: API rate-limit slots, token budgets, context window state, and connection pools. In unstructured systems, these leak when a session is "cancelled" by simply abandoning its future handle. Structured concurrency solves this through the `finally` / `defer` / `AsyncContextManager` guarantee:

```python
async def run_session(plan: Plan) -> SessionResult:
    async with llm_session_pool.acquire() as session:
        try:
            async with trio.open_nursery() as nursery:
                nursery.start_soon(executor_a, session, plan)
                nursery.start_soon(executor_b, session, plan)
        finally:
            # This block runs even if the nursery is cancelled
            await session.flush_logs()
            await session.release_context()
    # Pool slot returned here via __aexit__, always
```

The `async with` block on the session pool, combined with the nursery's guarantee that child tasks are finished before the scope exits, means the pool slot is never returned while an executor is still using it. This eliminates the entire class of use-after-return bugs common in thread-pool-based agent systems.

## Unstructured Patterns and Their Failure Modes

For contrast, consider the common unstructured patterns and what they fail to provide:

**Raw thread pools with future.cancel():** `cancel()` is advisory — the thread continues if it has started. No guarantee that the thread has exited before the caller proceeds. Orphaned threads accumulate.

**asyncio.create_task() without await:** The task runs as a "fire-and-forget." If the event loop closes, the task is destroyed mid-execution without cleanup. Exceptions in the task are silently swallowed unless an exception handler is attached.

**Process spawning without waitpid:** Child processes continue after the parent decides to cancel a plan. They may continue writing to shared state, consuming quota, or holding locks.

All three patterns share the same structural defect: the task lifetime is unbound from the scope that created it.

## Practical Recommendations for Agent System Design

1. **Adopt a scope-per-session model.** Each Session the Governor creates should live within an explicit scope object (nursery, task group, or StructuredTaskScope). The Governor should never "move on" without either awaiting or explicitly cancelling every scope it owns.

2. **Use cooperative cancellation checkpoints in Executors.** Every Executor that calls an external API should check for cancellation between calls. In Python: `await trio.sleep(0)` or `trio.lowlevel.checkpoint()`. In Kotlin: `ensureActive()`. In Swift: `try Task.checkCancellation()`.

3. **Separate supervision strategies by coupling.** Use fail-fast (hard) boundaries for tightly coupled sub-tasks. Use supervisor (soft) boundaries for independent parallel Executors where partial results are useful.

4. **Propagate deadlines, not just signals.** The Governor's wall-clock deadline for a plan should be inherited by Sessions, which should inherit by Executors. A web-search Executor that doesn't know the overall plan has 10 seconds left may spend 8 seconds on its own sub-request.

5. **Treat context window state as a managed resource.** LLM session context is as finite as a database connection. Wrap session acquisition in a `finally`-protected block and ensure the context is released (or checkpointed for replay) before the scope exits.

6. **Use observability tooling that understands task trees.** Java's structured concurrency JEP explicitly notes that the task hierarchy enables debuggers and profilers to display threads as subordinate to their parent. The same principle applies to agent observability: spans and traces should reflect the nursery hierarchy, not just flat concurrent tasks.

## Conclusion

Structured concurrency is not just a programming language feature — it is a specification for how concurrent lifetimes should be managed. For AI agent systems where a Governor orchestrates Sessions and Executors, the pattern enforces three properties that are otherwise left to programmer discipline: (1) no task outlives its parent, (2) errors propagate up the ownership tree rather than disappearing silently, and (3) resources are released in a deterministic order when scopes close. As agent systems grow from single-model demos to multi-session production systems running for hours at a time, these guarantees are the difference between systems that degrade gracefully and systems that accumulate orphaned tasks until they crash.
