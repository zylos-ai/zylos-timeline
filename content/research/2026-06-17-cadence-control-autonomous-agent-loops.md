---
date: "2026-06-17"
title: "Cadence Control in Autonomous Agent Loops"
description: "Cache-aware wakeup scheduling, task-dispatch semantics, and idempotent execution for always-on AI agents"
tags:
  - autonomous-agents
  - scheduling
  - prompt-cache
  - reliability
  - agentic-systems
---

## Executive Summary

Autonomous AI agents that run self-paced control loops face a non-obvious scheduling problem: how often to wake up is not just a performance question but an economics question shaped by LLM prompt-cache TTLs, event-notification availability, and the cost of unnecessary context re-hydration. The core insight is that sleep intervals should cluster into two regimes — well below the cache TTL when actively polling observable external state, or well beyond it when genuinely idle — because the pathological choice is an interval that sits right at the boundary, paying the cache-miss penalty without amortizing it over useful work. Beyond interval selection, reliable autonomous loops require well-defined task-dispatch semantics (distinguishing one-time, cron, and interval tasks), idempotency guards that distinguish legitimate repeat dispatches from double-dispatch bugs, and observability primitives that let a human audit why the agent chose a particular cadence. This article provides concrete decision tables, pseudo-code patterns, and reliability primitives for building production-grade agent loops.

## The Control Loop Shape

Every autonomous agent loop has the same fundamental shape regardless of runtime:

```
wake → assess → act → reschedule → sleep
```

The *assess* step determines what work is pending. The *act* step executes it. The *reschedule* step is the subject of this article: deciding the next wakeup time based on what was found and done.

### Why Self-Paced Beats Fixed External Cron

A fixed external cron fires at wall-clock intervals regardless of what the agent found. A self-paced agent adjusts its own next wakeup based on context — if it just dispatched a background task that will complete in ~3 minutes, it schedules a wakeup in 3 minutes, not 15. If it found nothing to do, it extends the interval.

The key advantages of self-scheduling:

- **Adaptive response latency**: the agent can wake early when it knows work is imminent
- **Idle cost suppression**: extend intervals when nothing is happening
- **Cache-awareness**: the agent can reason about its own TTL window
- **Auditability**: each scheduled wakeup carries a `reason` string, forming a log of self-narrated decisions

```python
# Conceptual wakeup scheduler
def schedule_next_wakeup(reason: str, delay_seconds: int):
    wakeup_time = now() + delay_seconds
    scheduler.add_task(
        id=f"wakeup-{uuid4()}",
        run_at=wakeup_time,
        type="one-time",
        payload={"trigger": "self-scheduled", "reason": reason}
    )
    log.info(f"[cadence] next wakeup in {delay_seconds}s — reason: {reason}")
```

The `reason` string is not cosmetic. It is the primary observability primitive for cadence audits.

## Prompt-Cache Economics

### The Cache TTL Constraint

LLM providers maintain a server-side prompt cache. When the same prefix (system prompt + conversation history) is submitted within a short window — typically around 5 minutes for providers like Anthropic — the cached representation is reused. Cache hits are significantly faster and cheaper than cache misses, which require re-encoding the entire context from scratch.

This creates a non-linear cost structure for agent wakeup intervals:

```
interval < TTL:    cache hit  → fast, cheap, but possibly wasted work
interval > TTL:    cache miss → full re-encode cost incurred
interval >> TTL:   cache miss → cost amortized over longer productive sleep
interval ≈ TTL:    WORST CASE → reliably misses cache, no amortization
```

The pathological choice is a fixed interval equal to or slightly greater than the TTL (e.g., exactly 5 minutes). This guarantees cache misses on every wakeup while providing no benefit from the longer gap. The correct approach is bimodal:

- **Active polling regime**: intervals well below TTL (e.g., 60–180 seconds) — context stays warm, each wakeup is cheap
- **Idle regime**: intervals well beyond TTL (e.g., 20–60 minutes) — pay the miss once, amortize over a long quiet period

### Cache Miss Multiplier

Consider an agent waking 12 times per hour on a fixed 5-minute interval versus 2 times per hour on a 30-minute interval during an idle period:

| Schedule | Wakeups/hour | Cache hit rate | Tokens re-encoded/hr |
|----------|-------------|----------------|----------------------|
| 5-min fixed | 12 | ~0% (boundary) | 12 × full context |
| 3-min active | 20 | ~95% | ~1 × full context |
| 30-min idle | 2 | ~0% (expected miss) | 2 × full context |

The 3-minute active schedule is actually cheaper per hour than the 5-minute fixed schedule, despite waking more often, because warm-cache reads cost a fraction of cold reads.

## Interval Selection Decision Table

The correct interval depends on what you are waiting for and whether the runtime can notify you.

| Waiting For | Runtime Can Notify? | Recommended Interval | Notes |
|-------------|--------------------|--------------------|-------|
| Background task completion | Yes (tracked task) | Long fallback (30–60 min) | Schedule only heartbeat; notification fires on completion |
| CI/CD pipeline result | No | 60–90 s while running; 30 min if idle | Poll actively during known active window; fall back when pipeline is quiet |
| Remote queue / webhook | No | 60–120 s | External state not observable by runtime |
| Inbound message check | Partial (push channel) | Skip polling; rely on push + 15-min heartbeat | If push channel reliable, polling is pure waste |
| Scheduled job trigger | Yes (scheduler) | Scheduler handles; no additional wakeup needed | Cron task fires at absolute wall time |
| Nothing known pending | — | 20–60 min (scale with consecutive idle count) | Idle backoff; suppress narration |
| Post-action confirmation | No | 30–90 s (one check) | Confirm action took effect, then reschedule normally |

### Idle Backoff

Consecutive empty-check wakeups should trigger interval scaling:

```python
IDLE_BACKOFF_SCHEDULE = [5*60, 10*60, 20*60, 30*60, 60*60]  # seconds

def compute_next_interval(consecutive_idle: int, active_tasks: list) -> tuple[int, str]:
    if active_tasks:
        return 90, "active tasks in flight — polling for completion"
    
    idx = min(consecutive_idle, len(IDLE_BACKOFF_SCHEDULE) - 1)
    interval = IDLE_BACKOFF_SCHEDULE[idx]
    return interval, f"idle (streak={consecutive_idle}) — backing off to {interval//60}min"
```

Critically, when an agent wakes and finds nothing, it should **not** log "nothing to do" in the user-facing channel. Log it internally, increment the idle streak counter, reschedule with backoff, and sleep. Narrating empty checks is noise.

## Task-Dispatch Semantics

### Three Task Types

Autonomous agent schedulers need to distinguish three fundamentally different task types:

**One-time tasks**: fire once at a specific wall-clock time, then expire. After execution, the task record persists for audit but no re-arming occurs.

**Cron tasks**: fire on a recurrence expression (standard cron syntax or named intervals). The scheduler computes the next fire time from the expression; the agent does not need to re-arm.

**Interval tasks**: fire on a delay measured from the *completion* of the previous run, not from a fixed clock. This is the self-scheduling pattern — the agent re-arms after finishing work.

```yaml
# Example task definitions
tasks:
  - id: pr-advance-check
    type: interval
    interval: 90s
    handler: check_and_advance_prs
    rearm_on: completion  # not on dispatch

  - id: daily-summary
    type: cron
    cron: "0 18 * * 1-5"
    handler: generate_daily_summary

  - id: onboarding-followup
    type: one-time
    run_at: "2026-06-18T10:00:00Z"
    handler: send_onboarding_email
```

### Repeat Dispatch vs. Double Dispatch

This is the most important correctness invariant: **an interval task legitimately fires again after every completion cycle — this is not a duplicate**. However, dispatching the same task-id twice before the first execution completes is a bug that must be caught.

The distinction requires tracking execution state per dispatch, not per task-id:

```python
class TaskDispatcher:
    def __init__(self, store: KVStore):
        self.store = store

    def dispatch(self, task_id: str, dispatch_key: str) -> bool:
        """
        dispatch_key: unique per dispatch cycle (e.g., task_id + run_timestamp)
        Returns True if this dispatch should proceed, False if it's a duplicate.
        """
        lock_key = f"dispatch_lock:{dispatch_key}"
        acquired = self.store.set_nx(lock_key, "running", ttl_seconds=300)
        if not acquired:
            log.warning(f"[dispatch] double-dispatch detected for {dispatch_key}, skipping")
            return False
        return True

    def complete(self, dispatch_key: str):
        self.store.delete(f"dispatch_lock:{dispatch_key}")
        # For interval tasks: re-arm here with a new dispatch_key
```

The `dispatch_key` incorporates both the task ID and the scheduled run time. Two dispatches of `pr-advance-check` at different times produce different dispatch keys and are both legitimate. Two dispatches of the same scheduled time produce the same key — the second is rejected.

## Idempotency-Guarded Task Handlers

Even with dedup at the dispatch layer, individual handlers should be written to be safe if called twice. The pattern is: **compare against persisted cursor state before acting**.

```python
def check_and_advance_prs(ctx: TaskContext):
    """
    Idempotent PR advance handler.
    Uses persisted 'last_checked_sha' to avoid re-processing.
    """
    prs = github.list_open_prs(repo=ctx.repo)
    
    for pr in prs:
        cursor_key = f"pr_cursor:{pr.id}"
        last_sha = ctx.store.get(cursor_key) or ""
        
        if pr.head_sha == last_sha:
            # No new commits since last check — nothing to do
            continue
        
        status = github.get_ci_status(pr.head_sha)
        
        if status == "success" and pr.is_approved():
            github.merge(pr.id)
            ctx.store.set(cursor_key, pr.head_sha)
            log.info(f"[pr-advance] merged PR #{pr.id} at sha={pr.head_sha[:8]}")
        elif status == "pending":
            # CI still running — reschedule a near-term check
            ctx.schedule_followup(delay_seconds=90, reason=f"CI pending on PR #{pr.id}")
            ctx.store.set(cursor_key, pr.head_sha)  # mark as seen
```

The SHA cursor is the idempotency key here. Even if this handler is called twice in rapid succession, the second call will find `pr.head_sha == last_sha` and skip, since the first call already updated the cursor.

### Persisted State Schema

For each trackable external resource, persist a minimal cursor record:

```json
{
  "resource_id": "pr:42",
  "last_checked_at": "2026-06-17T14:23:00Z",
  "last_known_sha": "a3f9d12",
  "last_action_taken": "approved",
  "last_action_at": "2026-06-17T14:20:00Z"
}
```

At handler start: read cursor, compare against live state, decide whether action is warranted. At handler end: write updated cursor. Crash between read and write is the only failure mode that can cause double-action — mitigated by making the action itself idempotent where possible (e.g., GitHub merge is idempotent: merging an already-merged PR fails gracefully).

## At-Least-Once vs. At-Most-Once Dispatch

| Semantic | Suitable For | Risk | Mitigation |
|----------|-------------|------|------------|
| At-least-once | Notifications, non-destructive checks | Duplicate messages/work | Idempotency keys, cursor comparison |
| At-most-once | Destructive actions (send email, charge payment) | Missed execution on crash | Accept the gap; log and alert on missed runs |
| Effectively-once | Most agentic work | Complexity | At-least-once + idempotent handlers |

For most autonomous agent tasks, **at-least-once dispatch with idempotent handlers** is the right target. True at-most-once requires distributed consensus primitives that add substantial complexity for marginal gain.

## Missed-Run and Catch-Up Policy

When an agent is down during a scheduled cron fire, it must decide on recovery: skip, run-once, or backfill.

```python
def handle_missed_runs(task: CronTask, since: datetime) -> MissedRunPolicy:
    missed = task.compute_missed_runs(since=since, until=now())
    
    if not missed:
        return MissedRunPolicy.NONE
    
    match task.missed_run_policy:
        case "skip":
            log.info(f"[recovery] skipping {len(missed)} missed runs for {task.id}")
            return MissedRunPolicy.SKIP
        
        case "run-once":
            log.info(f"[recovery] running once for {len(missed)} missed runs of {task.id}")
            dispatch(task, dispatch_key=f"{task.id}:recovery:{now().isoformat()}")
            return MissedRunPolicy.RUN_ONCE
        
        case "backfill":
            # Dangerous: can flood the system on long outage
            for run_time in missed[-task.max_backfill:]:  # cap backfill depth
                dispatch(task, dispatch_key=f"{task.id}:backfill:{run_time.isoformat()}")
            return MissedRunPolicy.BACKFILL
```

**Recommended defaults by task type:**

- **Monitoring checks**: `skip` — catching up on stale checks produces noise, not value
- **Daily summaries / reports**: `run-once` — one missed summary is worth generating; ten are not
- **Data ingestion / sync**: `backfill` with a depth cap — need the data, but cap to avoid flooding

### Drift in Naive Sleep Loops

A common bug in agent loops: `sleep(interval)` accumulates drift because execution time is not subtracted from the interval. Over hours, the agent's wakeup phase drifts relative to wall-clock time.

```python
# Drifting loop (wrong)
while True:
    do_work()
    sleep(300)  # next wakeup is 300s after work finishes, not 300s after it started

# Non-drifting loop (correct)
while True:
    start = now()
    do_work()
    elapsed = now() - start
    sleep(max(0, interval - elapsed))
```

For cron tasks, use absolute next-fire-time computation rather than relative sleep:

```python
next_fire = cron.next_fire_time(after=now())
sleep_duration = (next_fire - now()).total_seconds()
sleep(sleep_duration)
```

## Observability: Auditing Cadence

Every scheduled wakeup and dispatch decision should be logged with structured fields that enable post-hoc cadence audits:

```json
{
  "ts": "2026-06-17T14:23:00Z",
  "event": "wakeup_scheduled",
  "delay_seconds": 90,
  "reason": "CI pending on PR #42",
  "consecutive_idle": 0,
  "cache_warm": true,
  "active_dispatches": 1
}
```

Key fields for a cadence audit dashboard:

- `reason`: human-readable string explaining the interval choice
- `consecutive_idle`: how long the agent has been finding nothing to do
- `cache_warm`: whether the agent expects to hit cache (interval < TTL)
- `active_dispatches`: count of in-flight tasks at scheduling time

With this data, an operator can answer: "Why was the agent waking every 90 seconds at 3am?" without reading source code — the reason trail is in the logs.

### Token Cost Ledger

Track actual token spend per wakeup category to quantify cadence costs:

| Wakeup category | Avg tokens/wake | Cache hit rate | Effective cost/wake (relative) |
|----------------|----------------|----------------|-------------------------------|
| Active polling (CI pending) | 1,200 input | 95% | 0.06× |
| Idle backoff wakeup | 1,200 input | 5% | 1.0× (baseline) |
| Post-idle first wake | 1,200 input | 0% | 1.0× |
| Work-carrying wakeup | 4,000 input + output | 80% | 0.8× input + output |

An agent waking 12 times per hour on a fixed idle schedule (no cache hits) spends roughly 12× more on input tokens than one waking twice per hour with cache misses — and significantly more than one waking 20 times per hour with near-perfect cache hits. **Frequency alone does not determine cost; cache efficiency does.**

## Putting It Together: A Complete Wakeup Decision

```python
def decide_next_wakeup(state: AgentState) -> tuple[int, str]:
    """
    Returns (delay_seconds, reason).
    Called at the end of every control loop iteration.
    """
    # 1. Check for in-flight background tasks the runtime tracks
    tracked = state.scheduler.running_tasks()
    if tracked:
        names = ", ".join(t.id for t in tracked)
        return 30*60, f"tracked tasks running ({names}) — long fallback heartbeat"

    # 2. Active external polling needs
    pending_ci = state.ci.pending_runs()
    if pending_ci:
        return 90, f"{len(pending_ci)} CI run(s) pending — polling below cache TTL"

    pending_queue = state.remote_queue.depth()
    if pending_queue > 0:
        return 60, f"remote queue depth={pending_queue} — polling for new items"

    # 3. Nothing active — idle backoff
    interval = IDLE_BACKOFF_SCHEDULE[
        min(state.consecutive_idle, len(IDLE_BACKOFF_SCHEDULE) - 1)
    ]
    reason = f"idle (streak={state.consecutive_idle}) — backing off"
    state.consecutive_idle += 1
    return interval, reason
```

This function is deterministic, auditable (it returns a reason string), and embeds the cache-TTL awareness structurally: active polling targets 60–90 seconds (well below ~5-minute TTL), idle backoff jumps past 20 minutes (paying the miss, amortizing it).

## Conclusion

Cadence control in autonomous agent loops is a systems problem with three interlocking dimensions: **economics** (cache TTL shapes interval selection), **correctness** (idempotency and dispatch dedup prevent double-action), and **reliability** (missed-run policy and drift prevention ensure coverage). The key principles are:

- Bimodal interval selection: stay warm or go cold — never hover at the TTL boundary
- Self-scheduling with reason strings enables auditability that external cron cannot provide
- Distinguish interval/cron/one-time tasks and implement their re-arming semantics explicitly
- Idempotency lives in the handler, not the scheduler — compare cursors, not just dispatch keys
- Log cadence decisions as structured events; token cost auditing follows naturally

An agent that sleeps intelligently is not a less capable agent — it is a more economical and observable one.

---

*Research context: grounded in operational experience with Zylos, an always-on autonomous AI agent running a self-paced control loop. Prompt-cache TTL figures reference Anthropic's Claude API cache behavior as of mid-2026. Patterns are applicable across agent runtimes.*
