---
date: "2026-09-09"
title: "End-to-End Deadlines and Cancellation Boundaries for AI Agents"
description: "How shared time budgets survive queues, RPC hops, retries, and restarts—and why a timeout cannot prove that external work stopped."
tags:
  - research
  - ai-agents
  - deadlines
  - cancellation
  - distributed-systems
---

## Executive Summary

A multi-step agent needs a deadline for the whole operation, with each child consuming the remaining budget. Independent per-tool timeouts can let queueing, retries, and cleanup extend a task far beyond its intended duration. Cancellation also needs an explicit boundary: the caller stopping its wait, the worker stopping execution, and an external operation committing are different events.

This report combines established RPC, runtime, and workflow semantics into an agent design proposal. It focuses on elapsed-time budgets and cancellation acknowledgement; it does not propose a new retry protocol or claim that these mechanisms make external effects reversible.

## Start with the User's Waiting Budget

Consider an illustrative agent request with a 60-second response budget. Admission and queueing consume 8 seconds, retrieval consumes 20, and synthesis plus response delivery need a 5-second reserve. A second retrieval attempt cannot receive a fresh 60 seconds just because its HTTP client permits that timeout.

One possible allocation is:

| Stage | Elapsed or reserved | Budget consequence |
|---|---:|---|
| Admission and queueing | 8 seconds elapsed | 52 seconds remain |
| First retrieval attempt | 20 seconds elapsed | 32 seconds remain |
| Retry backoff | 2 seconds elapsed | 30 seconds remain |
| Response reserve | 5 seconds reserved | At most 25 seconds available for another attempt |

These numbers are a worked design example, not measured service latencies or recommended defaults. A 25-second cap does not imply that another attempt is worthwhile. The planner should decline it if the task is unlikely to produce useful output in that interval, and return a truthful partial result where the product supports one.

The proposed local rule is:

```text
remaining = parent_deadline - monotonic_now
child_budget = min(operation_cap, remaining - response_reserve)
if child_budget <= 0:
    do not start another operation
```

For parallel children, elapsed time is shared rather than divided mechanically by the number of branches. Each child is bounded by the parent's deadline; concurrency and token-spend limits remain separate constraints. A fast wall-clock result can still involve expensive parallel work.

## Propagate Remaining Time Across Boundaries

The gRPC model distinguishes an absolute deadline from a relative timeout. Its guidance recommends explicit client deadlines and notes that automatic propagation to downstream RPCs depends on the language implementation. To avoid depending on synchronized host clocks, propagation uses a timeout with elapsed time deducted. The application must still stop the work it spawned when cancellation is observed. [gRPC deadline guide](https://grpc.io/docs/guides/deadlines/)

The protocol defines `grpc-timeout` with a numeric value and time unit. That is a gRPC contract; a similarly named header on an unrelated HTTP endpoint acquires meaning only if that endpoint implements it. A generic agent adapter should declare what its transport supports rather than assuming that setting a local timer communicates a budget to a remote service. [gRPC HTTP/2 protocol](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md)

For an agent runtime, this suggests an adapter contract containing:

- The remaining execution budget, computed immediately before dispatch.
- A parent cancellation signal that the adapter actually observes.
- Whether remote cancellation exists and how acknowledgement is obtained.
- A stable operation identifier if a later status query is possible.
- The interpretation of a timeout when an operation can change external state.

These fields are a design recommendation, not a cross-provider standard. Budget propagation should be tested for each adapter, including SDK retry behavior and time spent acquiring a connection. Keeping the parent timer active is necessary even when the child has its own timer.

## Use Clocks According to Their Scope

Within a running process, elapsed-time accounting should use a monotonic clock. Python documents `time.monotonic()` as unaffected by system clock updates; its reference point is undefined, so differences between readings are meaningful. A raw monotonic reading is not a portable expiration timestamp that can be sent to arbitrary machines or carried across a reboot. [Python time reference](https://docs.python.org/3/library/time.html#time.monotonic)

Durable jobs need a separate persistence contract. A practical proposal is to store the intended expiration with the durable job and let one authoritative scheduler decide whether it is still eligible. When execution resumes, that authority provides the remaining budget and the worker establishes a new local monotonic deadline. The design must state how clock error is handled; simply writing a UTC timestamp does not create synchronized clocks.

If admission promises completion within a fixed duration, time spent in the queue and time spent offline both count. A worker restart must not grant the original full budget again. If the product instead promises durable background completion, distinguish that job lifetime from a short interactive response deadline. A user interface timing out need not cancel an explicitly authorized background job, but that separation should be visible to the user.

## What Runtime Cancellation Actually Does

Python's `asyncio.wait_for()` requests cancellation on timeout and waits for cancellation to complete, so total elapsed time can exceed the specified timeout. The `asyncio.timeout()` context manager uses task cancellation internally and converts its own cancellation into `TimeoutError` at the context boundary. Suppressing cancellation can interfere with structured concurrency. [Python asyncio tasks](https://docs.python.org/3/library/asyncio-task.html#timeouts)

A small local probe makes the first property observable:

```python
import asyncio
import time

async def work():
    try:
        await asyncio.sleep(1)
    finally:
        await asyncio.sleep(0.1)  # cancellation cleanup

async def main():
    started = time.monotonic()
    try:
        await asyncio.wait_for(work(), timeout=0.05)
    except TimeoutError:
        print(round((time.monotonic() - started) * 1000))

asyncio.run(main())
```

One run under Python 3.12.3 returned approximately 150 milliseconds: a requested 50-millisecond timeout followed by 100 milliseconds of cleanup. This is a semantic demonstration, not a latency benchmark, and scheduler load can change the observed duration. It demonstrates why a timeout setting alone is insufficient evidence of a hard response deadline.

Node.js provides `AbortSignal.timeout()` and `AbortSignal.any()` for creating and combining cancellation signals. The receiving API must support the signal. A runtime can combine a user cancellation with a deadline signal, but creating that signal does not preempt arbitrary code or establish a remote cancellation protocol. [Node.js AbortSignal documentation](https://nodejs.org/api/globals.html#class-abortsignal)

For subprocess tools, cancellation must reach the execution boundary. Node explicitly distinguishes sending a kill signal from proving process termination: `subprocess.killed` does not establish that the child exited. Its documentation also warns that terminating a parent on Linux does not necessarily terminate grandchildren. An execution adapter therefore needs to observe exit and define descendant-process ownership, using platform-appropriate process groups or isolation when necessary. [Node.js child processes](https://nodejs.org/api/child_process.html#subprocesskillsignal)

## Queue Time, Attempt Time, and Liveness Are Different

Temporal provides a useful vocabulary for separating clocks:

| Timer | What it bounds | Agent interpretation |
|---|---|---|
| Schedule-To-Start | Waiting for an Activity Task to begin | Queue delay |
| Start-To-Close | One Activity Task Execution | An individual attempt |
| Schedule-To-Close | Overall Activity Execution, including its retry chain | A tool operation's total budget |
| Heartbeat Timeout | Time between heartbeats | Loss of progress/liveness reporting |

These are Temporal's Activity concepts, not interchangeable names for a single task timeout. Its documentation explains that Start-To-Close applies to individual attempts, whereas Schedule-To-Close covers the overall execution. Regular Activity cancellation is delivered through heartbeats, which can be throttled; cancellation delivery may therefore lag behind the request. [Temporal Activity failure detection](https://docs.temporal.io/encyclopedia/detecting-activity-failures)

Application consequence: a fresh heartbeat should not extend a finite business deadline. A worker can be alive and making progress while the result is already too late to be useful. Conversely, a missing heartbeat is not proof that an external operation failed to commit.

A timeout recorded by a workflow service also does not physically kill a disconnected worker. Temporal allows Activities to handle cancellation cooperatively, and a Workflow can choose whether to wait for cancellation acceptance. That makes acknowledgement policy part of the orchestration contract. [Temporal Activity execution](https://docs.temporal.io/activity-execution)

## Record the Outcome the Runtime Actually Knows

The most consequential boundary is an external mutation. gRPC's status reference explicitly permits `DEADLINE_EXCEEDED` even when a state-changing operation completed successfully. Reissuing that operation solely because the caller timed out can duplicate its effect. [gRPC status codes](https://github.com/grpc/grpc/blob/master/doc/statuscodes.md)

A proposed outcome model should preserve these distinctions:

| Observation | Safe interpretation | Next action |
|---|---|---|
| Budget expired before dispatch | Adapter did not start this attempt | Return expired without invoking the tool |
| Cancellation requested; worker has not acknowledged | Stopping is in progress or unconfirmed | Track acknowledgement and bound local cleanup |
| Worker acknowledged exit | Local execution ended | Check external outcome separately if needed |
| Remote commit known, response late | Operation succeeded despite caller timeout | Reconcile by operation ID; do not duplicate it |
| Remote outcome unavailable | Effect is unknown | Report uncertainty and query status before retrying |

The labels above describe knowledge, not provider status codes. An application may implement them as orthogonal fields rather than a single state enum—for example, response status, worker status, and external-effect status. This avoids forcing “caller expired, worker stopped, remote operation succeeded” into a misleading single failure label.

Reserve bounded cleanup time, retain reconciliation work under an explicit owner, and prevent late results from silently replacing the current user-visible result. Hard termination may stop local resource consumption; it still cannot undo a committed remote operation.

## Verify the Contract with Failure Scenarios

For a Zylos-like agent platform, the useful acceptance checks are concrete:

- Hold a task in the queue until its deadline passes. Assert that dequeueing it does not invoke the model or tool.
- Spend most of a budget on the first attempt. Assert that backoff and a second attempt cannot reset the original deadline.
- Cancel during a non-cooperative tool. Observe both the user response and whether the worker remains active; fail a “fully stopped” claim if work continues.
- Execute a shell tool that starts a child process. Verify that the declared cancellation boundary includes descendants or explicitly reports them as unresolved.
- Complete a remote mutation, then delay the response beyond the client deadline. Require status reconciliation rather than a blind second write.
- Restart the scheduler with an expired durable job. Verify that expiration survives the restart.
- Keep sending heartbeats after the business deadline. Confirm that liveness does not renew authority to continue.
- Return a late result after another user request has taken over. Verify that result ownership prevents an obsolete response from overwriting the active one.

These are proposed tests; this research executed only the small Python cancellation probe. No production runtime migration or provider cancellation guarantee was validated.

## Methodology and Confidence

Research used three background Sonnet agents for RPC propagation, runtime cancellation, and queue/workflow budgets, followed by primary-source checks and synthesis. The existing research inventory and open PR titles were checked for overlap. Earlier coverage of temporal reasoning, general backpressure, and retries provides context; this article concentrates on end-to-end elapsed-time accounting and acknowledgement boundaries.

Confidence is high in the cited API semantics and the local probe result. The proposed adapter fields, durable-expiration design, outcome model, and acceptance scenarios are engineering inferences that require testing in the chosen runtime. No claim is made about a universal HTTP deadline header, a fixed network-delay error bound, or automatic cancellation of provider billing. Documentation was consulted on 2026-09-09; the central ideas are established practice, not newly introduced features.

## Sources

- [gRPC deadlines](https://grpc.io/docs/guides/deadlines/): deadline propagation and server responsibility.
- [gRPC HTTP/2 protocol](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md): transport-specific timeout representation.
- [Python time](https://docs.python.org/3/library/time.html#time.monotonic): local elapsed-time measurement.
- [Python asyncio tasks](https://docs.python.org/3/library/asyncio-task.html#timeouts): cooperative timeout and cancellation behavior.
- [Node.js AbortSignal](https://nodejs.org/api/globals.html#class-abortsignal): local cancellation composition.
- [Node.js child processes](https://nodejs.org/api/child_process.html#subprocesskillsignal): signal delivery and process-exit distinctions.
- [Temporal Activity failure detection](https://docs.temporal.io/encyclopedia/detecting-activity-failures): queue, attempt, total-duration, and heartbeat timers.
- [Temporal Activity execution](https://docs.temporal.io/activity-execution): cancellation acceptance and waiting policy.
- [gRPC status codes](https://github.com/grpc/grpc/blob/master/doc/statuscodes.md): timeout despite successful state change.
