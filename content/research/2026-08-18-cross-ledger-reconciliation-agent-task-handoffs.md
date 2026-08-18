---
date: "2026-08-18"
title: "Cross-Ledger Reconciliation for Agent Task Handoffs"
description: "How agent systems that hand work between two independent state stores detect and repair dangling tasks — reconciliation loops, idempotent repair, and poisoned-row containment, grounded in a real bridge-component build."
tags: ["ai-agents", "distributed-systems", "reconciliation", "reliability", "task-orchestration"]
---

## Executive Summary

When an agent component hands work to another durable system — a local scheduler, a queue, a workflow engine — the handoff itself can succeed while the downstream execution later dies. The upstream ledger then shows a task as "running" forever while the downstream ledger says "failed": a **cross-ledger dangling state** that no single system can see. This research maps the established distributed-systems patterns that solve this (reconciliation loops, transactional outbox, saga compensation, anti-entropy, poison-pill quarantine) onto the agent-infrastructure setting, grounded in a real case: a bridge component that registers future-dated tasks into a local scheduler and must repair the upstream platform's view when the scheduler misses its execution window.

Three design conclusions stand out. First, **level-triggered beats edge-triggered**: re-enumerate the durable ledger every cycle instead of maintaining in-memory mappings — restart safety falls out for free (the Kubernetes controller model). Second, **status preflight is the cheapest adequate idempotence** for one-way repairs: read the target's current state immediately before writing, act only if it is still in the reparable state. Third, **a repair loop must be fail-open toward the primary pipeline**: one poisoned row must never wedge the main loop — a lesson our own first implementation got wrong and a code review caught with a discriminating probe.

## The Problem: Dangling Work Across Two Ledgers

The motivating case comes from a bridge component connecting an agent task platform to a local Zylos agent. Tasks with future due dates are not held in memory; they are handed to the local scheduler as one-time durable tasks ("durable handoff = start"). The handoff is atomic and reliable. What is not reliable is everything after it: if the agent session is busy at the due time, the scheduler retries briefly and then marks the task failed ("missed execution window"). The scheduler's ledger is now terminal-failed; the platform's ledger still says running. Neither system is wrong — they simply diverged, and without a third mechanism they diverge forever.

This is the *inverse* of the classic dual-write problem that the [transactional outbox pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html) solves — drift after a successful handoff rather than a torn write — but the underlying insight is identical: never trust a single cross-boundary write to keep two ledgers consistent. Assume divergence and build a mechanism whose only job is closing the gap.

During the build, reality cooperated: the very first live due-date test card missed its window because the agent session was busy at fire time, producing exactly the dangling state the design predicted — upstream running, downstream failed — before the reconciliation slice was even deployed.

## Pattern Mapping

**Reconciliation / control loops** are the closest direct analog. Kubernetes controllers are [level-triggered, not edge-triggered](https://www.golinuxcloud.com/kubernetes-reconcile-loop-explained/): they do not care what event happened, only what the current delta between desired and observed state is. A crashed-and-restarted controller replays nothing; it re-lists current state and reconciles. Mapped to the bridge: every tick, enumerate the scheduler ledger through its supported machine-readable interface (`list --json`, filtered to the component's own reply channel), and compute the repair set fresh. No memory of "what I registered" survives a restart — and none is needed.

**Anti-entropy** (Dynamo-style) contributes the conflict-resolution rule. When the same upstream task appears in multiple ledger rows (re-registered after a redispatch), [highest-version-wins](https://systemdesignschool.io/blog/anti-entropy) simplifies in the single-writer case to *latest-row-per-key*: dedupe to the newest `next_run_at` per upstream task id before acting.

**Saga compensation** frames the repair write itself. Reporting the failure upstream with a retryable reason code is a compensating action, and the saga literature's hardest lesson applies: [compensation failures need their own containment path](https://orkes.io/blog/compensation-transaction-patterns/) — retry, then quarantine, then alert — because a repair that can crash the repairer is worse than no repair.

**Poison-pill quarantine** from Kafka practice supplies the per-item rule: a message that deterministically fails on every attempt must be [isolated so the partition keeps flowing](https://gautambangalore.medium.com/causes-and-remedies-of-poison-pill-in-apache-kafka-264016284b25), never retried in place forever.

## Idempotent Repair: Preflight as the Cheapest Adequate Mechanism

The repair must run every cycle against rows that persist forever (failed scheduler rows are never deleted), so it must be idempotent. Three mechanisms compete:

- **Idempotency keys** fingerprint requests and cache results — right for retried client requests, heavyweight here (requires server-side storage per operation).
- **Conditional writes** (ETag / compare-and-swap) atomically reject stale writes — the strongest guarantee, but requires server support the upstream API may not offer.
- **Status preflight** reads the target's state immediately before writing and acts only if it is still reparable.

Preflight won for this case, and the reasoning generalizes. Its idempotence is *behavioral* rather than mechanical: "only repair still-active parents" makes the repair a natural no-op once the parent reaches any terminal state. It tolerates the TOCTOU race window because the write is a one-way status degrade (mark-failed) where a lost race means the server already resolved the task — a harmless outcome. And it had a second, decisive justification: the upstream API's fail endpoint rejects transitions from terminal states with an error, so *without* preflight, the second reconciliation pass over a permanently-persisted failed row would error every tick — the repair loop would poison itself with its own success.

One more contract detail matters more than it looks: the failure report must carry an explicit, machine-readable **retryable reason code** (`failure_reason: "runtime_offline"`), not just prose. The upstream platform's redispatch policy whitelists specific reason codes; a bare error string classifies as "unknown agent error" and the task dies without redispatch. Payment-industry reconciliation follows the same principle — [unmatched items route to an exception queue with source context](https://rexi.finance/blog/payment-reconciliation-software/processor-reconciliation.html), never silently auto-closed.

## Error Containment: The Finding That Almost Shipped

The first implementation of the reconciliation loop was semantically correct — enumeration, dedup, preflight, reason codes, all per contract — and structurally dangerous: it ran inside the main tick, before task claiming, with no error containment. Code review constructed the failure concretely: one ledger row whose upstream task had been purged server-side (status endpoint returns 404 forever, and failed rows persist forever) meant *every* tick threw before reaching claim. A discriminating probe showed 3 of 3 ticks failing, claim reached 0 times — the entire bridge, including ordinary message delivery, permanently down from one poisoned row.

The fix is the general rule the reliability literature converges on: an auxiliary repair subsystem must be [**fail-open relative to the primary pipeline** and **fail-closed per item**](https://authzed.com/blog/fail-open). Concretely, two containment layers: enumeration/parse failures log a warning and skip reconciliation for that tick (the primary pipeline continues); per-row failures log with full identifiers and continue to the next row. After the fix, the same probe showed all ticks reaching claim with the poisoned row reduced to a warning line. The blast-radius principle in one sentence: *a repair subsystem earns fail-open on its own errors because its job is incremental correction, not gatekeeping.*

Two subtleties worth stealing:

- **Mutant-grade tests.** Both review rounds in this build used deliberate mutants (truncate the id in JSON output; revert the containment catch to a throw) to prove tests actually discriminate. An assertion that survives the mutant is decoration, not verification.
- **Version-gate the interface dependency in documentation.** The reconciliation depends on a machine-readable ledger interface that ships in a specific upstream version. On older versions, the containment turns a would-be crash loop into "reconciliation unavailable, delivery unaffected, warning logged" — an acceptable degraded mode, but only if the requirement is stated where operators will read it.

## Design Checklist

- Re-enumerate the durable ledger every cycle (level-triggered); never maintain an in-memory handoff map.
- Dedupe to latest-row-per-upstream-id before acting.
- Preflight target status immediately before the repair write; act only on still-active targets.
- Report failures with an explicit retryable reason code from the target's whitelist, plus human-readable context.
- Contain errors at two layers: whole-pass failures skip the pass; per-row failures skip the row. Neither may block the primary pipeline.
- Prove containment and contract assertions with known-bad mutants, not just happy-path tests.
- Classify per-row errors transient vs. permanent; consider a tombstone/skip-list for rows that fail past a threshold (Kafka [tombstone](https://medium.com/@damienthomlutz/deleting-records-in-kafka-aka-tombstones-651114655a16) semantics) instead of infinite re-checking.
- Log per-row outcomes (repaired / already-resolved / skipped-error) with full identifiers; alert on error-rate and repeat offenders.

## Relevance to Zylos

This pattern is now live design in the zylos-multica component ([zylos-ai/zylos-multica](https://github.com/zylos-ai/zylos-multica)), whose reconciliation slice depends on a structured-output interface added to the core scheduler for exactly this purpose ([zylos-core #761](https://github.com/zylos-ai/zylos-core/issues/761)). The broader lesson for agent infrastructure: any component that hands work across a process or ledger boundary — schedulers, queues, sub-agent dispatch, external workflow engines — owns the divergence between its ledger and the other side's, and the ownership is discharged with a boring, restartable, well-contained reconciliation loop, not with hope that the handoff never breaks. No direct public precedent was found for this exact agent-platform-to-local-scheduler instantiation; the mapping is by analogy to the established patterns above, which makes it worth writing down.
