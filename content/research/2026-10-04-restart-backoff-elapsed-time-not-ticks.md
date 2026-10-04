---
date: "2026-10-04"
title: "Restart Backoff That Measures Time, Not Ticks"
description: "Crash-loop backoff and 'stable for N seconds' resets are specified in wall-clock time, but implemented as counted loop iterations — a gap that stays invisible until the loop's period changes, as it does the moment a supervisor's polling becomes adaptive."
tags: ["supervisors", "backoff", "crash-loops", "reliability", "testing", "ai-agents", "distributed-systems", "process-management"]
---

## Executive Summary

Every mature process supervisor — Kubernetes' kubelet, systemd, Erlang/OTP, PM2, supervisord, Docker — specifies restart backoff in units of time: wait 10 seconds, then 20, then cap at 5 minutes; reset the count after the process has run cleanly for 10 minutes. None of them specify it in units of "checks." That distinction sounds pedantic until a supervisor's control loop stops running at a fixed period. A monitoring loop that polls once a second can get away with treating "60 iterations" as a stand-in for "60 seconds," because the two numbers are almost always equal. The moment that loop's period becomes variable — because it adapts to load, because a GC pause stretches an iteration, because the process was suspended and resumed — the stand-in silently stops matching the thing it stands in for, and every duration the supervisor thinks it's enforcing (backoff delay, stability window, crash-loop detection threshold) drifts by whatever factor the loop period drifted by.

This article traces how five production-grade supervisors encode backoff and reset thresholds, shows the specific mechanisms (timer drift, adaptive polling, suspend/resume, slow iterations) that break a tick-counted implementation, and sets out the engineering practice — monotonic clocks, injectable time sources, and a negative-control test that fails on tick-counting code — that keeps a time-based contract actually time-based as the surrounding scheduler evolves. The motivating case is a supervisor for long-lived AI agent sessions: restart backoff computed as `min(5·2^n, 60)` seconds with a reset after 60 seconds of stable running, originally checked by a fixed ~1-second loop and counted in "checks not running," then redesigned so that session-starting moves into a dispatcher whose scheduler polls adaptively between 1 and 3 seconds per round. Under the old counting method, that redesign would have silently stretched every backoff and reset window by up to 3× — a regression with no error message, no crash, and no symptom until someone timed a crash loop with a stopwatch and found it three times slower than configured.

## The mechanism: why "one second, roughly" stops being roughly one second

A supervisor loop of the simplest kind looks like this:

```js
while (true) {
  checkAndMaybeRestart();
  await sleep(1000);
}
```

Two different things are true about this loop, and the bug class lives in the gap between them. The *intended* period is 1000 ms. The *actual* period is 1000 ms plus however long `checkAndMaybeRestart()` took to run, because `sleep` is scheduled after the work completes, not on a fixed wall-clock cadence. If `checkAndMaybeRestart()` normally takes a few milliseconds, the gap is negligible and a reasonable engineer rounds it to zero. But "normally" is doing a lot of work in that sentence. Any of the following turns the gap from negligible to the dominant term:

- **The loop itself becomes adaptive.** A scheduler redesigned to poll less aggressively when there's nothing to do — a very ordinary, well-motivated change to reduce idle CPU and wake-ups — might widen its own sleep from 1 s to 3 s under light load. Code that was counting iterations now counts something that represents between 1 and 3 seconds of real time, interchangeably.
- **A single iteration takes a long time.** A slow filesystem check, a blocked `tmux` query, a synchronous JSON parse of a large log, or a garbage-collection pause in the host runtime can make one "tick" take tens or hundreds of milliseconds longer than its neighbors — and if iterations occasionally take *seconds*, the count-based model of "60 ticks = 60 seconds" degrades further.
- **The process hosting the loop is suspended.** A laptop closing its lid, a VM pausing for a hypervisor-level snapshot, or a container being checkpointed all stop the loop entirely for an interval the loop never observes as elapsed time unless it's explicitly told to look.
- **The loop is intentionally throttled under backpressure**, e.g., reduced polling frequency when rate-limited by an upstream API — exactly the kind of condition an AI agent supervisor needs to survive gracefully rather than have its own internal time sense distorted by.

None of these failure modes announce themselves. A tick-counted backoff that's supposed to wait 60 seconds and actually waits 180 seconds doesn't throw, doesn't log an error, and doesn't fail any test that doesn't specifically simulate the loop period changing. It just restarts a crashed process three times slower than the operator configured, or — the more dangerous direction — resets its stability counter three times *faster* than intended if the miscount runs the other way, letting a process that's crash-looping every 40 seconds get miscounted as "stable" and have its backoff prematurely reset to the minimum, causing the exponential curve to restart from the bottom indefinitely. On an agent supervisor, that specific failure mode is actively dangerous: a config or auth error that always crashes the agent shortly after each restart should drive the backoff up toward its ceiling, not get reset to five seconds forever because a reset threshold got satisfied on a miscounted clock.

## How mature supervisors define it: always in time, never in ticks

The specifications below are drawn from each project's own source or documentation. The pattern is uniform: thresholds are durations; the mechanism used to measure those durations is the designer's own problem to solve correctly, and notably, every one of them that publishes implementation detail uses either real elapsed-time comparisons or an explicit, swappable clock abstraction — never a raw iteration count.

| Supervisor | Backoff curve | Reset / stability condition | Startup-failure limit |
|---|---|---|---|
| **Kubernetes kubelet** (CrashLoopBackOff, pre-KEP-4603 default) | 10s, 20s, 40s, 80s, 160s, capped at 300s (doubling) | Counter resets after the container has run for 10 minutes (2× the max backoff) without exiting | No separate limit; backoff alone governs restart rate |
| **Kubernetes kubelet** (`ReduceDefaultCrashLoopBackoffDecay` feature gate, KEP-4603) | 1s initial, capped at 60s (doubling) | Reset threshold held at a flat 10 minutes, decoupled from the max-backoff value | Same |
| **systemd** (≥ v254) | `RestartSec` as the base, growing over `RestartSteps` steps up to `RestartMaxDelaySec` | No "ran successfully" reset of the restart delay itself; instead `StartLimitIntervalSec` defines a sliding time window and `StartLimitBurst` the max restart attempts inside it | Unit enters `failed` (rate-limit tripped) once `StartLimitBurst` is exceeded inside `StartLimitIntervalSec` |
| **Erlang/OTP supervisor** | No backoff curve by default — a child is restarted immediately per its `restart` type (`permanent`/`transient`/`temporary`) | `intensity` restarts allowed per `period` seconds (default: 1 restart per 5 seconds); exceeding it shuts the whole supervisor down | Supervisor (and its children) terminate if `intensity` is exceeded within `period` |
| **PM2** | `exp_backoff_restart_delay`: base delay × 1.5 per attempt (e.g. 100ms → 150ms → 225ms → …) | Delay resets to 0 after the app stays online over 30 seconds | `max_restarts` consecutive restarts faster than `min_uptime` (default 1000ms) before giving up (default max: 16) |
| **supervisord** | No built-in exponential backoff; fixed restart on exit per `autorestart` policy | `startsecs`: process must stay in RUNNING for N seconds to count as a successful start (default 1s) | `startretries` consecutive failed starts before FATAL (default 3) |
| **Docker** (`--restart on-failure`) | 100ms base, doubling (100ms, 200ms, 400ms, 800ms, …) | No documented automatic reset of the counter short of recreating the container | Optional `on-failure:N` caps total restart count |
| **runit / s6** | No exponential curve; s6 and runit both enforce a flat ~1-second minimum delay between spawns if a service exits in under 1 second | N/A — philosophy is "a crashing service is an operator problem, not something to paper over with backoff tuning" | None built in; left to external supervision |

A few things are worth pulling out of this table individually.

**Kubernetes' own justification for its reset threshold is the single most on-point primary source for this whole topic.** The KEP-4603 proposal to reduce kubelet's default max backoff from 5 minutes to 1 minute deliberately kept the 10-minute reset threshold untouched, and the stated reason is exactly the tick-granularity problem this article is about, stated from the other side: "the granularity of the associated worker polling loops governing restart behavior is between 1 and 10 seconds, so a reset value under 10 seconds is effectively meaningless." In other words, Kubernetes' own authors reasoned explicitly about the relationship between a *stability threshold* (how long must a thing run before we trust it) and the *polling granularity* of the loop that observes it — and concluded you cannot set a meaningful threshold below the loop's own measurement resolution. That's the generalizable principle: a time-based contract is only as precise as the clock enforcing it, and if that "clock" is actually a loop counter, its resolution is not 1 second, it's "however long the slowest iteration during the observation window happened to take."

**systemd's split between `RestartSec`/`RestartSteps` and `StartLimitIntervalSec`/`StartLimitBurst` separates two different questions** that are easy to conflate: how long to wait before the *next* restart (a growing delay), versus how many restarts are tolerated in a sliding *window* before giving up entirely (a rate limit). Both are time-denominated, but they answer different questions, and an agent supervisor copying this pattern should keep them as two separate knobs rather than trying to derive a hard stop from the backoff curve alone — a backoff curve capped at 60 seconds, left running forever, will retry forever at a tolerable rate; only a separate attempt-count-within-a-window rule turns "slow but infinite" into "give up and alert a human."

**Erlang/OTP's `intensity`/`period` pair is the oldest version of this idea in the list** (the design dates to the 1990s telecom systems OTP was built for) and is explicit that both numbers are a *rate* — restarts per unit time — not a count in isolation. A supervisor configured for `intensity: 1, period: 5` is not saying "allow one restart"; it's saying "allow a restart rate of up to 1 per 5 seconds," which only makes sense as a time-windowed measurement.

**PM2's two mechanisms — `exp_backoff_restart_delay` and `min_uptime`/`max_restarts` — are a particularly close analogue to an AI agent supervisor**, because PM2 is solving the identical problem (user-space process supervision of a long-lived script that might fail transiently or might be stuck in a bad state). `min_uptime` is PM2's name for what this article calls the stability window, and the PM2 docs are explicit that it's wall-clock: "the number of seconds to wait after restart before considering the app stable."

## Tick-counting vs. elapsed-time: the actual failure modes

The category of bug is familiar wherever a repeated-poll loop is treated as a clock, but it has specific, well-documented sub-cases worth separating:

**1. `setInterval`'s own drift vs. a self-scheduling loop's drift are different bugs with the same symptom.** A `setInterval(fn, 1000)` callback is queued every 1000ms regardless of how long `fn` took, which means if `fn` takes longer than 1000ms, invocations queue up and can fire back-to-back once the event loop catches up — a burst, not a slowdown. A self-scheduling pattern (`setTimeout` that re-arms itself inside its own callback, i.e. `fn(); setTimeout(fn, 1000)`) instead drifts *later* every time `fn` takes non-zero time, because the next tick's countdown starts only once the current one finishes — turning a nominal 1-second loop into something closer to "1 second plus however long the work took," compounding every iteration. Most real supervisor loops (including a `setTimeout`-after-each-iteration pattern) use the second model, so their drift is cumulative lateness, not bursts — which is the more dangerous direction for backoff math, because it means the loop silently gets *slower* than its nominal period and every tick-counted duration silently gets *longer* than configured, with no compensating correction anywhere in the design.

**2. Adaptive polling is the drift mechanism turned into an intentional feature**, and it is the one most directly relevant here: a scheduler that polls every 1 second when busy and backs off to every 3 seconds when idle is a sound, common design (less wasted CPU and wake-ups, same responsiveness when it matters) — but it means the very same counted value ("60 polling rounds") can represent anywhere from 60 to 180 seconds of real time depending on load at the time, a 3× range with no bound on which end a given run lands on.

**3. Wall clock vs. monotonic clock is a second, separate trap that elapsed-time fixes can walk straight into if they pick the wrong clock.** `Date.now()` (or any `time.Now()`/wall-clock read) can jump — NTP corrections, manual clock changes, leap-second smoothing — and can even run *backward*, which breaks any duration computed as `end - start` if the system clock was adjusted between the two reads. The fix used throughout the industry is a dedicated monotonic time source: Node's `process.hrtime()` / `performance.now()`, Go's `time.Since()` against a `time.Time` captured for duration measurement rather than display, or any OS-level `CLOCK_MONOTONIC` read — a clock that is guaranteed only to move forward and is explicitly decoupled from wall-clock adjustments. The rule of thumb used across these ecosystems: wall-clock time is for timestamps meant for humans or logs ("this happened at..."), monotonic time is for durations and timeouts ("how long since...").

**4. Monotonic clocks have their own edge case: suspend/resume.** On Linux, `CLOCK_MONOTONIC` is explicitly defined to *not* include time spent in system suspend — if a laptop sleeps for ten minutes, a monotonic-clock-based duration measurement spanning that sleep will undercount by ten minutes, because the kernel's monotonic counter itself paused. `CLOCK_BOOTTIME` (added in Linux 2.6.39 specifically to address this) does keep counting through suspend. For a long-lived desktop or laptop-hosted agent supervisor — plausible for local developer tooling, less likely for a cloud-hosted one — this matters directly: a backoff timer measured in `CLOCK_MONOTONIC` that spans a laptop sleep will think far less time has passed than actually has, potentially retrying a backed-off restart immediately upon wake when the intended wait hadn't elapsed, or conversely under-crediting a stability window that should have reset. The practical choice is to pick the clock source deliberately based on deployment environment rather than defaulting to whichever one the standard library makes most convenient.

## Defining "stable": from-start vs. from-ready, and why it matters for cold-start-heavy agents

A second, related ambiguity sits inside "reset the backoff after the process has run stably for N seconds": stable *from when*? Two candidate start points give materially different behavior:

- **From process start.** The clock starts the instant the supervisor spawns the process. This is simple and is what most of the table above actually measures (kubelet's 10-minute reset, PM2's `min_uptime`), but it conflates "took a while to initialize" with "crashed quickly" if initialization itself is slow and variable — a concern Kubernetes addressed separately with the startup probe, which exists precisely to stop the liveness probe from punishing a container for a slow-but-healthy initialization sequence by disabling liveness/readiness checks entirely until the startup probe first succeeds.
- **From readiness.** The clock starts only once the process has signaled it's actually doing useful work — a readiness probe passing, a login/auth handshake completing, a model finishing its cold-start load. This is the more correct measure of "is this instance actually stable," but it requires the supervised process to expose an explicit readiness signal, which not every process does.

For an AI agent supervisor specifically, this distinction maps onto a known, named failure split: a session that **never became ready** (crashed during an expensive cold start — model/context load, auth handshake, tool-server attach — before doing any real work) versus one that **crashed after ready** (ran successfully for a while, then failed mid-task, possibly due to a transient upstream rate limit or a bug triggered by specific input). These call for different operator responses — "never ready" points at config, credentials, or environment and should probably alert a human well before the backoff ceiling is reached, since retrying a broken config at increasing delays just delays the inevitable diagnosis — while "crashed after ready" is closer to the transient-failure case backoff is actually designed for. A supervisor that only measures "ticks since start" cannot distinguish these two cases at all; one that measures elapsed time *and* tracks whether a readiness signal was ever observed can.

## Jitter: when it matters, and when it's a distraction

The AWS Architecture Blog's "Exponential Backoff And Jitter" is the canonical reference here, and it's worth being precise about what problem jitter solves, because it's easy to import the pattern somewhere it doesn't help. The post works through three variants:

- **Full Jitter:** `sleep = random(0, min(cap, base * 2^attempt))` — the entire delay is randomized up to the exponential ceiling.
- **Equal Jitter:** half the exponential delay is kept fixed, the other half randomized — a compromise that avoids ever sleeping near zero.
- **Decorrelated Jitter:** each retry's delay is randomized based on the *previous* delay rather than purely on attempt count, which the post's own simulation shows produces both less total work and lower completion time than the other two under contention.

The mechanism jitter fixes is **synchronized retries across many independent clients hitting the same shared resource** — thousands of SDK clients all backing off from a throttled API and then all retrying at the exact same moment because they all compute the exact same exponential delay, turning backoff into a self-reinforcing thundering herd. That mechanism simply doesn't exist for a supervisor managing a single long-lived agent session restarting against its own dependencies: there's no fleet, no shared contended resource, no other client computing the same delay at the same instant to collide with. Jitter is a reasonable, cheap thing to add regardless, but the specific justification is different: it exists to avoid a resonance between the backoff curve and some unrelated periodic process (a cron job, another timer in the same host) that happens to line up with it, not to protect a shared backend from a stampede. Where it does become essential for an agent supervisor is the moment there *are* many independent agent sessions sharing a rate-limited upstream API (the classic AWS motivating case reappears exactly), at which point the fleet-level reasoning fully applies again.

## Testing a timing contract: the negative control

A backoff/reset implementation is a *timing contract*: "wait at least X, at most Y; reset after Z of stability." The natural way to test it is also the way most teams get it wrong — running the real implementation against real timers and asserting on wall-clock behavior, which makes the test either slow (if it actually waits) or non-deterministic (if it doesn't wait quite long enough and flakes under CI load).

The fix used throughout the ecosystems surveyed here is to make time itself an injectable dependency rather than a global ambient call:

- **JavaScript/Node:** Sinon's fake timers (`@sinonjs/fake-timers`, used via `sinon.useFakeTimers()`) replace the global `setTimeout`, `setInterval`, `Date`, and even `performance.now()`/`process.hrtime` with a controllable virtual clock. Tests advance time synchronously with `clock.tick(ms)` and assert on what fired, with no real waiting and no flakiness tied to CI machine speed.
- **Go:** the `benbjohnson/clock` pattern — now continued under community maintenance — defines a `Clock` interface with a `New()` (real) and `NewMock()` (test) implementation; application code takes a `Clock` as a dependency instead of calling `time.Now()`/`time.Sleep()` directly, and tests drive the mock clock forward explicitly with `Add(duration)`.
- **Kubernetes itself does exactly this for its own backoff library.** `client-go/util/flowcontrol`'s `Backoff` struct holds a `clock.Clock` field, and the package exposes `NewFakeBackOff` specifically to inject a test clock — meaning the same codebase that documents the backoff *algorithm* in prose also treats the algorithm's dependence on a clock as a first-class, swappable interface in code, not an implicit global.

The test design that actually catches a tick-for-time substitution bug is a **negative control**: before trusting that a test proves the fix works, first prove the test can *fail* — run it against a deliberately wrong, tick-counting implementation and confirm the test reports a failure, then run it against the time-based implementation and confirm it passes. Concretely, for the motivating redesign in this article:

```js
// Negative control: a tick-counting implementation that the test
// must catch as wrong before trusting the test against the real one.
function brokenBackoffTick(notRunningTicks) {
  // treats "ticks" as if each were exactly 1 second — the bug.
  return Math.min(5 * 2 ** notRunningTicks, 60);
}

test('tick-counting implementation is wrong under adaptive polling (negative control)', () => {
  const clock = FakeClock.at(0);
  const sched = new AdaptiveScheduler({ clock, periods: [1000, 3000, 3000] }); // 1s, 3s, 3s
  const sup = new Supervisor({ clock, scheduler: sched, backoffFn: brokenBackoffTick });

  sup.recordNotRunning(); sched.advanceOneRound(); // "tick" 1 -> actually +1s
  sup.recordNotRunning(); sched.advanceOneRound(); // "tick" 2 -> actually +3s
  sup.recordNotRunning(); sched.advanceOneRound(); // "tick" 3 -> actually +3s

  // 3 "ticks" should mean backoff = min(5*2^3, 60) = 40s by the broken model,
  // but 7 real seconds have elapsed -- the broken implementation has no way
  // to know that, so this assertion is expected to pass against the broken
  // code and is the point: it proves the test harness can tell them apart.
  expect(sup.currentBackoffSeconds()).toBe(40);
  expect(clock.elapsedSeconds()).toBe(7); // real time, far less than the tick math assumes
});

test('elapsed-time implementation is correct under the same adaptive schedule', () => {
  const clock = FakeClock.at(0);
  const sched = new AdaptiveScheduler({ clock, periods: [1000, 3000, 3000] });
  const sup = new Supervisor({ clock, scheduler: sched, backoffFn: elapsedTimeBackoff });

  sup.recordNotRunning(); sched.advanceOneRound();
  sup.recordNotRunning(); sched.advanceOneRound();
  sup.recordNotRunning(); sched.advanceOneRound();

  // Backoff is a function of elapsed wall/monotonic time since the first
  // failure, not of how many scheduler rounds observed it -- so the same
  // 7 real seconds produce the same backoff regardless of whether the
  // scheduler polled every 1s or every 3s along the way.
  expect(sup.currentBackoffSeconds()).toBe(elapsedTimeBackoff(7));
});

test('a 1s-only and a 3s-only schedule converge to the same backoff for the same elapsed time', () => {
  const resultFast = runToElapsed({ periodMs: 1000, elapsedSeconds: 30 });
  const resultSlow = runToElapsed({ periodMs: 3000, elapsedSeconds: 30 });
  expect(resultFast.currentBackoffSeconds()).toBe(resultSlow.currentBackoffSeconds());
});
```

The third test is the one that generalizes best as a regression guard: it asserts invariance of the backoff value to the scheduler's polling period, for the same amount of real elapsed time. Any implementation that counts loop iterations instead of elapsed time fails this test immediately and deterministically, with no need to simulate GC pauses or suspend/resume to trigger it — a fixed difference in configured polling period is enough. That property is also what makes it a reasonable **tolerance** check rather than a strict equality in a more realistic adaptive scheduler: the correct assertion is usually "backoff/reset timing is accurate to within one scheduler period," not "to the millisecond," because the supervisor genuinely cannot detect a state change faster than its own next poll — which is precisely the KEP-4603 reasoning about reset thresholds applied as a test tolerance instead of a design constant.

## Recommendations for an AI agent supervisor

Generalizing from the comparison table and the failure mechanisms above, for a supervisor restarting long-lived agent sessions (expensive cold starts, rate-limited upstream APIs, failures that range from transient network blips to permanently broken config):

1. **Specify backoff and reset purely in elapsed time, and compute that elapsed time from a monotonic clock**, never from a count of polling rounds and never from wall-clock subtraction. If the deployment target includes machines that suspend (laptops, some VM hosting), use a clock source that accounts for suspend (`CLOCK_BOOTTIME`-equivalent) rather than one that silently loses that interval.
2. **Decouple the polling/scheduling loop's period from every duration the supervisor enforces.** A scheduler is free to poll adaptively (1–3 s, or wider) for efficiency; backoff delay, stability-window length, and crash-loop detection must all be read from a clock at decision time, not inferred from how many times the loop happened to run.
3. **Track whether a readiness signal was ever observed, separately from "process is running."** This is what lets the supervisor distinguish *never became ready* (cold start or config/auth failure — a case worth surfacing to a human quickly rather than retrying indefinitely at increasing delay) from *crashed after ready* (plausibly transient — the case exponential backoff is designed for).
4. **Keep the backoff-delay curve and the hard-stop/alert threshold as two separate mechanisms**, following systemd's `RestartSec` vs. `StartLimitBurst`/`StartLimitIntervalSec` split: a capped exponential delay alone degrades gracefully into "retry forever, slowly," which is fine for a human-supervised system but insufficient alone for an unattended one — pair it with a restart-count-within-a-window ceiling (PM2's `max_restarts`/`min_uptime`, or OTP's `intensity`/`period`) that stops retrying and escalates once a session is clearly looping rather than recovering.
5. **Set stability-window and reset thresholds no finer than the scheduler's own worst-case polling period**, and document why, following KEP-4603's explicit reasoning: a reset value finer than the loop's measurement resolution is not actually controllable and just adds false precision to the configuration.
6. **Treat jitter as optional for a single supervised session and necessary the moment multiple sessions share a rate-limited upstream.** Don't add jitter reasoning (fleet-level thundering-herd avoidance) to justify a design choice that's actually solving a different, single-process problem — but revisit it the moment the architecture adds concurrent sessions against the same API.
7. **Test the timing contract with an injectable/fake clock, and include a negative control.** Before trusting a test suite's green result on the time-based implementation, confirm the same suite goes red against a deliberately tick-counting implementation under a scheduler with a non-constant period — only then does a passing suite mean what it's supposed to mean.

## Sources

- [Kubernetes documentation: Pod Lifecycle — restart backoff](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- [KEP-4603: Tune CrashLoopBackoff](https://github.com/kubernetes/enhancements/blob/master/keps/sig-node/4603-tune-crashloopbackoff/README.md)
- [kubernetes/enhancements issue #4603: Tune CrashLoopBackOff](https://github.com/kubernetes/enhancements/issues/4603)
- [kubernetes/enhancements issue #5593: Configure the max CrashLoopBackOff delay](https://github.com/kubernetes/enhancements/issues/5593)
- [Tunable CrashLoopBackOff in GKE (Google Cloud / DEV Community)](https://dev.to/googlecloud/tunable-crashloopbackoff-in-gke-accelerating-aiml-recovery-and-eliminating-risky-node-hacks-1o6k)
- [client-go util/flowcontrol backoff.go (source)](https://github.com/kubernetes/client-go/blob/master/util/flowcontrol/backoff.go)
- [client-go util/flowcontrol backoff_test.go (source, fake clock usage)](https://github.com/kubernetes/client-go/blob/master/util/flowcontrol/backoff_test.go)
- [Kubernetes: Configure Liveness, Readiness and Startup Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- [systemd.service(5) manual page (Debian)](https://manpages.debian.org/testing/systemd/systemd.service.5.en.html)
- ["How systemd exponential restart delay works"](https://enotty.pipebreaker.pl/posts/2024/01/how-systemd-exponential-restart-delay-works/)
- [Erlang System Documentation: Supervisor Behaviour](https://www.erlang.org/doc/system/sup_princ.html)
- [Erlang/OTP `supervisor` module reference](https://www.erlang.org/doc/apps/stdlib/supervisor.html)
- [PM2 — Ecosystem File / application declaration (exp_backoff_restart_delay, min_uptime, max_restarts)](https://pm2.keymetrics.io/docs/usage/application-declaration/)
- [Supervisor (supervisord) Configuration File documentation](https://supervisord.org/configuration.html)
- [s6-supervise manual (skarnet.org)](https://skarnet.org/software/s6/s6-supervise.html)
- ["Back off" setting for crashing services with s6+openrc? (supervision mailing list)](https://skarnet.org/lists/supervision/2943.html)
- [Docker restart policies — "From PM2 to Docker: Automatic Restarts"](https://maximorlov.com/pm2-to-docker-automatic-restarts/)
- [AWS Architecture Blog: "Exponential Backoff And Jitter"](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
- [AWS Builders' Library: "Timeouts, retries, and backoff with jitter"](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter)
- ["Why Javascript timer is unreliable, and how can you fix it" (setInterval vs setTimeout drift)](https://abhi9bakshi.medium.com/why-javascript-timer-is-unreliable-and-how-can-you-fix-it-9ff5e6d34ee0)
- [MDN: Performance.now()](https://developer.mozilla.org/en-US/docs/Web/API/Performance/now)
- ["Your Clock Can Go Backward—Use the Right One for Durations" (monotonic vs wall clock)](https://dev.to/luciano655/your-clock-can-go-backward-use-the-right-one-for-durations-1ic)
- [CLOCK_MONOTONIC vs CLOCK_BOOTTIME and suspend behavior (eclipse-paho/paho.mqtt.c issue #1095)](https://github.com/eclipse-paho/paho.mqtt.c/issues/1095)
- [Baeldung: Understanding Timekeeping and Clocks in Linux](https://www.baeldung.com/linux/timekeeping-clocks)
- [Sinon.JS: sinon.useFakeTimers()](https://sinonjs.org/concepts/fake-timers/use-fake-timers)
- [sinonjs/fake-timers (GitHub)](https://github.com/sinonjs/fake-timers)
- [benbjohnson/clock — mocking time in Go (GitHub)](https://github.com/benbjohnson/clock)
- [Wikipedia: Negative testing](https://en.wikipedia.org/wiki/Negative_testing)
