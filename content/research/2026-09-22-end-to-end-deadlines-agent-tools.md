---
date: "2026-09-22"
title: "End-to-End Deadlines for Agent Tools: What a Timeout Actually Guarantees"
description: "How to share a time budget across queueing, retries and tool calls, and why cancellation cannot establish the outcome of a remote write."
tags:
  - ai-agents
  - reliability
  - distributed-systems
  - timeouts
---

## Executive Summary

An agent can stop waiting for a tool without stopping the tool. A local experiment for this article aborted a Node.js HTTP request after server admission; the server still completed its simulated write. Another experiment gave a Python coroutine a 20ms timeout, but cancellation cleanup delayed the returned error until about 100ms. Both are legitimate behaviors, and both break the assumption that a timeout proves an operation stopped at a particular instant.

For agent runtimes, a useful design has three separate contracts: a shared budget for the attempt, a policy for cancelling and cleaning up work, and evidence about the business operation's outcome. This article develops that design from official runtime and protocol documentation, then tests narrow failure cases locally. The proposed integration points are suggestions for Zylos-like systems, not claims about features already deployed in Zylos.

## One Attempt, One Shrinking Budget

Consider an agent asked to look up an account and submit an update within ten seconds. Its work may include queueing, connection setup, authentication, a read, backoff, a write, and result processing. Giving every stage ten seconds does not make the overall attempt ten seconds long.

Define a start time and one deadline in the same local clock domain:

```text
deadline = start + total_budget
remaining = max(0, deadline - now)
stage_budget = min(stage_cap, remaining)
```

Create the deadline at the boundary the product promises to measure. If that promise includes queueing, creating it when a worker finally dequeues the request silently excludes queue time. For parallel branches, give each branch a deadline no later than its parent; elapsed time is shared, while concurrency and cost need separate limits.

Here is an illustrative ten-second allocation, not a recommended production default:

| Point in the attempt | Elapsed time | Remaining budget |
|---|---:|---:|
| Accepted into the queue | 0s | 10s |
| Worker starts | 2s | 8s |
| First call fails | 5s | 5s |
| Backoff completes | 6s | 4s |
| Retry begins | 6s | At most 4s |

If the retry needs a minimum useful duration plus time to record an outcome, admission should fail when that allowance cannot fit. This is an application policy: the exact reserve requires measurements of the actual workload. A reserve creates room for cleanup; it cannot force an uncooperative operation to stop.

gRPC provides an established example of this approach. Clients should explicitly set deadlines; some language implementations propagate them to downstream calls, with defaults differing by language. The framework transmits a timeout derived from the remaining time to avoid directly comparing unsynchronized host clocks. Use the implementation's propagation mechanism where available and verify its configuration. [gRPC deadlines](https://grpc.io/docs/guides/deadlines/).

## Choose a Clock With the Required Meaning

Wall-clock time is useful for human-readable timestamps and durable expiry records. For a live local duration budget, a monotonic clock avoids discontinuous wall-clock corrections. Python documents an unspecified reference point for `time.monotonic()`: differences are meaningful, while its raw value is not a portable timestamp. [Python time documentation](https://docs.python.org/3.12/library/time.html#time.monotonic).

Suspend behavior is a separate choice. On Linux, `CLOCK_MONOTONIC` excludes system suspend, while `CLOCK_BOOTTIME` includes it. Neither fact should be generalized to every high-level timer on every operating system. An agent running on a laptop needs an explicit answer to whether a ten-second budget expires while the machine sleeps. [Linux clock documentation](https://man7.org/linux/man-pages/man2/clock_gettime.2.html).

A proposed recovery policy is to persist a durable expiry alongside the operation identity, then reconstruct a fresh local deadline after restart using an authoritative time source and a bounded maximum budget. This introduces clock-skew and clock-correction assumptions that must be documented. Persisting an arbitrary monotonic reading and comparing it after migration to another host does not solve that problem.

Likewise, a home-grown `remaining_ms` header is not automatically an end-to-end deadline protocol. It needs defined handling for transit delay, queue delay, units, rounding, validation, and maximum values. A receiver that starts a fresh timer from the received duration can give itself time the caller has already spent in transit. The caller must still enforce its own deadline; a remote timer is a resource-control aid, not proof of a globally synchronized stopping instant.

## Cancellation Has Several Observable Stages

For a tool call, these are different events:

1. The caller decides it no longer wants the result.
2. The local client requests cancellation.
3. The remote handler notices cancellation.
4. Spawned work stops and resources are released.
5. The application determines whether a business effect committed.

gRPC's cancellation guide assigns the application responsibility for cooperating with cancellation and stopping its work. A framework cannot generally interrupt arbitrary application logic safely. [gRPC cancellation](https://grpc.io/docs/guides/cancellation/).

Node exposes cancellation signals through `AbortController` and `AbortSignal`; the operation must actually consume the signal. Merely racing its promise against a timer changes which result the caller receives. Our local race experiment below shows the original promise continuing afterward. [Node global objects](https://nodejs.org/api/globals.html#class-abortcontroller).

Cancellation is also not rollback. gRPC explicitly allows `DEADLINE_EXCEEDED` even when a state-changing operation completed successfully but its response arrived too late. Consequently, translating every timeout into “the update failed” gives the agent more certainty than the transport established. [gRPC status codes](https://grpc.io/docs/guides/status-codes/).

For an ambiguous write, a useful proposed result shape separates observation from effect:

```json
{
  "wait_outcome": "deadline_exceeded",
  "effect_outcome": "unknown",
  "operation_id": "example-operation-42",
  "next_action": "query_operation_status"
}
```

The identifier helps only if the target service supports lookup or deduplication for it. Sending a random header to a service that ignores it provides neither. If status lookup is unavailable, preserve the uncertainty and use a domain-specific reconciliation path before repeating a consequential write.

## Retry Admission Must Respect Both Time and Meaning

A retry has two independent preconditions: there is enough budget left, and repeating the operation is semantically acceptable. More time does not make an ambiguous write safe to repeat.

gRPC retry policy includes retryable status codes, attempt limits and backoff settings; its guide also describes transparent retry and the point at which a call becomes committed to an attempt after response headers. Application-level retry loops must account for retries already performed beneath them. [gRPC retry guide](https://grpc.io/docs/guides/retry/).

For a proposed agent adapter, check the remaining budget before backoff and again after waking. Compute the next call's allowance from the original deadline. Keep attempt limits and concurrency limits as separate controls: a time budget by itself can still permit many fast attempts or many simultaneous requests.

HTTP `Retry-After` may contain a delay in seconds or an HTTP date. It indicates when a later request should be attempted, not an extension to the user's budget. If the advised delay does not fit, stop this attempt or schedule a separately authorized continuation. A date-valued header additionally requires a wall-clock interpretation. [RFC 9110, Retry-After](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3).

For example, an adapter with four seconds remaining and a five-second retry delay should not sleep five seconds and then start another full timeout. The correct outcome under a strict attempt budget is to decline that retry. Whether the larger task may resume later belongs to the task's policy, not to a hidden transport retry.

## Cleanup Can Outlive the Requested Timeout

Python's `asyncio.wait_for()` cancels the awaited task on timeout and waits for cancellation to finish; the documented elapsed wait can therefore exceed the configured timeout. `asyncio.timeout()` and related structured-concurrency mechanisms also rely on cancellation behavior. Catching and suppressing cancellation can interfere with their intended operation. [Python asyncio tasks](https://docs.python.org/3/library/asyncio-task.html#timeouts).

Timers are not preemption. Node's documentation does not guarantee exact callback timing; synchronous work can delay when the event loop runs a timeout callback. A timer in the same blocked execution context cannot enforce an exact wall-time limit on that work. [Node timers](https://nodejs.org/api/timers.html#timers).

For a runtime that requires a bounded user-facing response, distinguish that response boundary from cleanup completion. A proposed implementation can mark the wait as expired, retain ownership of outstanding cleanup, and prevent late results from overwriting a newer attempt. This must be an explicit lifecycle with an observable owner, not an abandoned promise.

If the requirement is stronger—local uncooperative work must be forcibly stopped—use an independently scheduled supervisor and an isolation boundary appropriate to the workload. Killing a local worker still does not reverse a write already accepted by a remote service. Hard containment, cooperative cancellation, and business reconciliation address different failures.

## Local Experiments and Their Limits

The following checks ran on Node.js 24.17.0 and Python 3.12.3. They are small demonstrations of the stated mechanisms, not latency benchmarks or tests of a production agent integration.

**Budget reset, deterministic arithmetic.** Two stages consuming 70 units each both fit a freshly assigned 100-unit stage timeout; together they consume 140. A shared 100-unit deadline leaves only 30 for the second stage. This checks the accounting model, not real scheduler behavior.

**Promise race, continued execution.** A 10ms timer won against an 80ms promise. The test then awaited the original promise and asserted that its completion flag was set. The timeout result did not cancel the losing work.

**Aborted HTTP request, completed server effect.** A loopback HTTP server signalled that it had admitted a POST. Only after that signal did the client abort its fetch. The client observed `AbortError`; the server later incremented an in-memory write counter exactly once. Waiting for admission avoids confusing a request cancelled before dispatch with one already being handled. This is an intentionally non-cooperative server and a simulated effect, not a database rollback test.

**Cancellation cleanup, delayed error.** The runnable Python example below reproduced the cleanup behavior. A 20ms timeout and an 80ms cleanup sleep returned `TimeoutError` after 100.5ms in the recorded run. The assertion targets cleanup completion and a broad lower bound, not exact timing.

```python
import asyncio

async def main():
    loop = asyncio.get_running_loop()
    started = loop.time()
    cleaned = False

    async def job():
        nonlocal cleaned
        try:
            await asyncio.sleep(10)
        finally:
            await asyncio.sleep(0.08)
            cleaned = True

    try:
        await asyncio.wait_for(job(), timeout=0.02)
    except TimeoutError:
        elapsed = loop.time() - started
        assert cleaned
        assert elapsed >= 0.08
        print(f"Returned after {elapsed * 1000:.1f}ms")
    else:
        raise AssertionError("Expected a timeout")

asyncio.run(main())
```

These experiments do not measure suspend behavior, cross-host clock skew, gRPC propagation, a database commit race, or process termination. Those remain integration tests for the chosen deployment. A meaningful cancellation test should include both a cooperative handler that stops and a handler that completes after the client gives up; otherwise a single happy path can conceal the distinction this article depends on.

## A Small Adoption Path for Agent Runtimes

Start with one tool adapter whose timeout behavior matters to users. Trace where its budget begins, what queueing and connection work it includes, and which layer owns retries. Record the remaining budget before each attempt and whether the target API acknowledges an operation identity.

Then exercise four outcomes: expiry before dispatch, cancellation during execution, effect completion with a lost response, and cleanup that does not converge promptly. Check both the user-visible result and the eventual effect ledger. A useful acceptance condition is that the runtime never claims “not executed” merely because its own wait ended.

Suggested telemetry separates `wait_finished_at`, cancellation requested/observed events, cleanup status, and the independently known effect outcome. Measure elapsed durations locally; use wall timestamps for correlation without treating them as a universal ordering proof. Keep operation identifiers in traces or logs rather than unbounded metric labels.

The engineering decision is where each promise ends. An interactive turn may expire while a durable operation remains unresolved. A scheduled continuation may receive a new attempt budget while preserving the original business expiry. Making those boundaries explicit lets the agent communicate a precise outcome and choose a safe next step.
