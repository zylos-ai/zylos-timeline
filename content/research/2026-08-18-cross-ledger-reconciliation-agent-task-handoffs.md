---
date: "2026-08-18"
title: "Cross-Ledger Reconciliation for Agent Task Handoffs"
description: "How agent systems that hand work between two independent state stores detect and repair dangling tasks — reconciliation loops, idempotent repair, and poisoned-row containment, grounded in a real bridge-component build."
tags: ["ai-agents", "distributed-systems", "reconciliation", "reliability", "task-orchestration"]
---

## Executive Summary

When an agent component hands work to a local scheduler, a queue, or a workflow engine, downstream execution can fail after both sides have acknowledged the handoff. The upstream ledger may still show “running” while the downstream ledger says “failed”: a **cross-ledger dangling state**. A reconciliation loop can detect that mismatch and report the failure upstream, provided it identifies the right attempt and respects the upstream state-transition contract.

The motivating case is the [zylos-multica bridge at `e7eae3d`](https://github.com/zylos-ai/zylos-multica/blob/e7eae3d9e34cdc445f51f4d63a27973dda949dc2/src/index.js). Three lessons matter: reconstruct work from durable state; combine client status preflight with a **server-side conditional transition**; and contain repair exceptions without mistaking that containment for a guarantee of prompt task claiming. This article describes that bridge revision and checks server semantics against [Multica at `19155e41`](https://github.com/multica-ai/multica/blob/19155e41f96cb3aec2355ae1d40da80c00030cdf/server/internal/service/task.go). The latter is a pinned contract check, not evidence of the server revision deployed during the original build.

## The Problem: Dangling Work Across Two Ledgers

The bridge hands future-dated work to the local scheduler, then reports platform task start. These are **two separate writes**: scheduler `add` succeeds before the bridge awaits the platform `/start` request. A crash between them, or a failed acknowledgement, can leave a durable scheduler entry without an acknowledged platform start. The handoff is not atomic; torn-write and duplicate recovery require their own design.

The failure slice considered here starts **after scheduler persistence and a successfully acknowledged platform start**. If execution subsequently misses its window, the scheduler can reach terminal failure while the platform still says running. Repairing that later drift is distinct from the initial dual-write problem addressed by a [transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html). An outbox can coordinate a local transaction with eventual delivery; it does not by itself establish that downstream execution finished.

A controlled probe of the pinned bridge, with scheduler and API calls replaced by test doubles, reproduces successful scheduler persistence followed by `/start` failure. That demonstrates the ordering boundary; it is not a reproduction of a production incident.

## Pattern Mapping and Attempt Identity

**Reconciliation / control loops** are the closest direct analogy. A [Kubernetes controller](https://kubernetes.io/docs/concepts/architecture/controller/) observes current state and makes changes toward the desired state. The bridge enumerates the durable scheduler ledger on every tick through `list --json`, restricted to its own reply channel, and reconstructs the repair set. Restart correctness therefore does not depend on retaining a process-local registration map. Level-triggered correctness does not require full polling on every cycle or forbid reconstructible caches; this bridge simply uses full enumeration.

**Anti-entropy** is a useful analogy for repeatedly detecting divergence, but it does not supply this bridge's ordering rule. The selector groups rows by upstream task ID, chooses the greatest `next_run_at`, and, for equal values, prefers a non-failed row over a failed row. If time and failure preference are equal, it retains the earlier encountered row. **`next_run_at` is a due time, not an attempt number or creation sequence.**

For this heuristic to identify the intended current registration, newer registrations sharing an upstream ID must not move the requested due time backwards; equal-time registrations must also be safe to resolve using the non-failed preference. Single-writer ordering alone establishes neither condition. Those are required scheduling assumptions, not invariants proved by the selector. For example, an older failed row due at 200 and a newer pending row due at 100 cause the selector to choose the old failure. This controlled example disproves the general “newest registration” claim; it does not establish that the sequence occurs, or is admissible, in the deployed workflow. A general implementation should carry stable attempt/generation identity or prove its scheduling invariants before treating due-time deduplication as causal ordering.

**Saga compensation** is only a limited analogy here: the repair propagates failure status and may permit another attempt. It does not undo completed business effects or implement a complete saga protocol. Any retry that could repeat effects still needs its own idempotency design.

**Poisoned-row containment** supplies a separate rule: one permanently invalid row must not prevent other rows and ordinary tasks from being processed. Quarantining repeat offenders is an optional extension; the pinned bridge logs failures and revisits retained rows on later passes.

## Idempotent Repair: Preflight Plus a Conditional Transition

Failed scheduler rows remain available for later reconciliation passes. The bridge first reads upstream status and sends `/fail` only for `running`, `dispatched`, or `waiting_local_directory`. This preflight avoids unnecessary writes and checks eligibility, but a task can finish between the read and the write.

Race safety comes from the server. The pinned [FailAgentTask SQL](https://github.com/multica-ai/multica/blob/19155e41f96cb3aec2355ae1d40da80c00030cdf/server/pkg/db/queries/agent.sql#L1055) updates only rows still in those three states. A concurrent completion or cancellation cannot be overwritten by an unconditional stale failure report. Calling the action a “one-way degrade” would not provide that protection.

The [FailTask transaction and outer return path](https://github.com/multica-ai/multica/blob/19155e41f96cb3aec2355ae1d40da80c00030cdf/server/internal/service/task.go#L3933) also matter: if the conditional update returns `ErrNoRows`, the outer path reads the existing task and returns it with no error when that lookup succeeds. The [HTTP handler](https://github.com/multica-ai/multica/blob/19155e41f96cb3aec2355ae1d40da80c00030cdf/server/internal/handler/daemon.go) then returns HTTP 200. An already-terminal task therefore does not necessarily error or poison the loop. A missing task is different: the lookup cannot return an existing task, and that failure needs containment. These guarantees depend on the pinned server contract, not on preflight alone.

An explicit machine-readable reason, `failure_reason: "runtime_offline"`, preserves **retry eligibility**, rather than guaranteeing redispatch. The pinned server additionally checks the remaining attempt budget, excludes autopilot runs, and requires linkage to an issue or chat session. If the reason is omitted, it classifies the error text; it does not always assign one unknown-error bucket. Supplying a correct reason makes intent clear while leaving retry policy to the server.

## Error Containment and Its Latency Boundary

The original [round-one component review](https://github.com/zylos-ai/zylos-multica/pull/2#pullrequestreview-4953964412) records a local controlled experiment: a retained failed scheduler row whose upstream status read always returned 404 made all three ticks throw before claim, so claim was reached zero times. That is an attributed review observation, not a production outage measurement. The [round-two review](https://github.com/zylos-ai/zylos-multica/pull/2#pullrequestreview-4953997665) reports the same poisoned-row probe reaching claim on all three ticks after error containment was added.

The pinned bridge has two containment layers. Enumeration or parse failures log a warning and skip that repair pass. Individual status/fail errors log row identifiers and continue to the next row. These catches prevent a recurring exception from aborting every tick before claim.

**They do not isolate claiming latency.** `tick()` awaits the entire repair pass before calling claim, and status/fail calls run serially. The [API helper](https://github.com/zylos-ai/zylos-multica/blob/e7eae3d9e34cdc445f51f4d63a27973dda949dc2/src/lib/multica-api.js) applies a 30-second timeout per request, but the pass has no aggregate time budget. Many slow rows can therefore delay ordinary task delivery. A controlled deferred-response probe confirms that claim waits until the pending status response settles. An immediate-404 probe demonstrates exception containment, not slow-row isolation.

If prompt primary-pipeline progress is required, bounded batches and a pass budget, or separately scheduled reconciliation, need explicit design and verification. Those are options beyond this pinned implementation. “Fail-open” here means that handled repair exceptions allow eventual continuation, not that repair work cannot delay claim.

Two additional practices remain useful:

- **Discriminating tests.** Inject a known-bad mutant, such as restoring a throw in place of the row catch, and verify that the relevant test fails. Separately test slow responses; a fast exception is not a substitute.
- **Document interface prerequisites.** An older scheduler without the required machine-readable ledger interface can make reconciliation unavailable. The enumeration catch contains that error and then allows claim to proceed; it does not make the missing interface usable.

## Design Checklist

- Define the handoff acknowledgement boundary and separate later execution drift from torn-write or duplicate recovery.
- Reconstruct repair work from durable state; any cache must be reconstructible after restart.
- Identify the correct attempt with a stable identity, or document and verify the scheduling assumptions and tie rules behind any heuristic.
- Preflight target status to avoid unnecessary writes, and enforce allowed state transitions atomically on the server.
- Report a correct machine-readable failure reason with human-readable context; verify the server's additional retry gates.
- Contain whole-pass and per-row exceptions. Measure slow-row effects separately and set a batch/pass budget if claim latency matters.
- Verify both normal behavior and known-bad mutants against the failure each test is meant to detect.
- Distinguish transient from permanent row errors; consider an explicit quarantine or skip-list with review/re-entry rules for repeat offenders. Kafka tombstones are deletion markers, not quarantine records.
- Log repaired, already-resolved, and skipped-error outcomes with identifiers; monitor repeat failures and repair-pass duration.

## Relevance to Zylos

The [zylos-multica reconciliation slice](https://github.com/zylos-ai/zylos-multica/pull/2) uses the structured scheduler interface tracked by [zylos-core #761](https://github.com/zylos-ai/zylos-core/issues/761). It illustrates both the value and the limits of a small repair loop: durable enumeration survives process restart, conditional server transitions protect terminal outcomes, and catches contain exceptions. Correct attempt selection and bounded interference with ordinary delivery remain distinct concerns that those mechanisms do not automatically solve.
