---
date: "2026-07-07"
title: "Schedule Inheritance: The Timezone Bug That Hides Inside a Correct-Looking Cron String"
description: "When an autonomous agent is migrated, forked, or succeeded, its scheduled tasks must be re-homed — and timezone handling is the subtle failure mode that silently fires reports at the wrong hour while every log line insists the schedule is correct."
tags: ["ai-agents", "scheduling", "timezone", "agent-migration", "reliability"]
---

## Executive Summary

Long-running autonomous agents accumulate operational state: memory, credentials, identity, and — easy to forget — scheduled tasks. When an agent is migrated to a new host, forked into a new instance, or succeeded by a replacement, every cron-like job it owns has to be re-homed into a new scheduler. That re-homing step has a well-documented but routinely under-tested failure surface: timezone handling. A cron expression that is byte-for-byte identical to the original can fire at a completely different wall-clock hour on the new system, and — worse — the agent's own records will keep insisting the schedule is correct, because nothing about the stored cron string changed. This piece walks through the concrete ways schedule migration goes wrong, why the bug is so good at hiding, and a practical checklist for re-homing schedules (and the broader operational state they represent) without silent drift.

## Failure Mode 1: Verbatim Copy Across a Timezone Boundary

The simplest failure is also the most common: a cron expression like `0 8 * * *` is copied from the origin host to the successor host without re-examining what timezone each side assumes. Standard POSIX cron has no native concept of a per-job timezone — it evaluates schedule fields against whatever timezone the daemon (and often the whole OS) is configured with. Some cron implementations (cronie, ISC cron and derivatives) support a `CRON_TZ=<zone>` variable set at the top of a crontab to control *when* jobs fire, but that variable does not set the `TZ` environment variable the job itself sees at runtime — controlling execution time and controlling what the job process perceives as "now" are two separate settings, and conflating them is its own bug. If the origin host's crontab implicitly ran in UTC and the successor's scheduler defaults to the host's local timezone (say, a container image configured for `Asia/Shanghai`, UTC+8), an `0 8 * * *` job that used to mean 08:00 UTC now means 08:00 China Standard Time — an eight-hour shift with no error, no warning, and an identical-looking config file.

## Failure Mode 2: The Double-Conversion Trap

A more insidious variant happens when a human or agent tries to be helpful during migration. Someone notices the job is "supposed to" run at 08:00 local wall-clock time, manually converts that to UTC (08:00 local becomes 00:00 UTC in a UTC+8 zone), writes `0 0 * * *` into the new schedule — and then, because the new scheduler asks for an explicit timezone field, tags the task with the *local* zone instead of leaving it as UTC. The result: the scheduler takes the already-converted UTC hour and reinterprets it as local time, firing the job eight hours before anyone intended. This is a classic double-conversion error, and it's dangerous precisely because each individual step (convert to UTC, fill in the timezone field) looks like correct, careful behavior in isolation.

## Failure Mode 3: Per-Task TZ vs Host-Clock Inheritance

Different schedulers make fundamentally different design choices about where timezone lives, and migrating between them is where assumptions break. Kubernetes CronJobs are a good illustration of the industry converging on the right answer over several release cycles: timezone support for `.spec.timeZone` shipped as alpha in Kubernetes 1.24, beta in 1.25, and became stable in 1.27 (tracked as KEP-3140), specifically so that a CronJob's fire time is pinned to an explicit IANA zone name rather than inherited from the node's local clock or the API server's TZ setting. Before that field existed, CronJob schedules were evaluated against the kube-controller-manager's local time — meaning the same YAML could fire at different wall-clock times depending on which cluster or node it landed on. systemd timers have the analogous ambiguity by default: an `OnCalendar=` directive with no explicit zone suffix falls back to the system's local timezone, and only an explicit suffix (`UTC`, an IANA name like `Asia/Tokyo`, or a fixed offset like `+05:30`) pins it. Google Cloud Scheduler takes the opposite default — jobs run in UTC unless `--time-zone` is set explicitly — which is safer by default but still requires the operator to consciously choose a zone rather than assume one. When an agent's scheduler is swapped or its host changes, the surviving artifact is usually just the schedule string; the *policy* of which of these models applied is easy to lose in translation.

## Failure Mode 4: DST-Affected Zones vs Fixed-Offset Zones

Some zones are safe to reason about statically; others are not. Asia/Shanghai and Asia/Singapore are both fixed at UTC+8 with no daylight saving component — China dropped DST after 1991, and Singapore fixed its offset in 1981 when it aligned with Malaysia's standard time — so a schedule expressed in either zone means the same wall-clock offset from UTC every day of the year. Contrast that with most America/* and Europe/* zones, where the UTC offset itself changes twice a year. This creates two additional, more subtle bugs during and after migration: spring-forward can produce a wall-clock time that never exists (e.g., 02:30 during a "spring forward" transition), and fall-back can produce a wall-clock time that exists twice. Cron implementations disagree on the resulting behavior — some run the skipped-time job immediately after the gap, others silently drop that firing; some rerun a job that falls in the repeated hour, others suppress the duplicate. If a migrated agent's schedule happens to land near a DST boundary in its new zone, the correctness question isn't just "did we pick the right zone" but "does this scheduler handle the transition the way we assumed."

## Why This Bug Is So Good at Hiding

None of these failure modes corrupt the stored schedule. The cron string is still `0 8 * * *`. The agent's memory, logs, and self-reports all say "this task runs at 08:00." Every artifact an operator would normally audit looks correct. The only artifact that reveals the bug is the scheduler's *computed next-fire timestamp* — and that's rarely checked, because checking it requires converting the schedule plus its timezone into an absolute UTC instant and comparing that against the human's actual intent, a step most migration checklists skip entirely. The bug surfaces only empirically: a "midday" report arrives at 5 a.m., a daily digest goes out at 2 a.m. local time, or — worst case — nobody notices for weeks because the output looks plausible enough on a random schedule.

## Detection and Prevention

A few concrete practices close most of this gap:

- **Store timezone explicitly, per task, never by inheritance.** Whatever the origin scheduler's convention, the successor's schedule record should carry an explicit IANA zone name (not "local," not "server default") so it survives a host change unambiguously.
- **Verify computed next-run, not the cron string.** After re-homing, compute each task's actual next-fire instant in UTC and compare it against the human's intended wall-clock time. A cron expression that "looks the same" is not evidence of correctness — the next-fire timestamp is.
- **Prefer fixed-offset zones where the business logic allows.** If a task doesn't need to track a DST-observing region's local convention, choosing a zone like a fixed UTC+8 or plain UTC removes an entire category of twice-yearly failure.
- **Keep the origin alive until the successor's schedule has proven itself.** Don't decommission the source of truth until at least one scheduled task has fired at the correct time on the new system — a single successful firing is a far stronger correctness signal than a config diff.

## Role-Based Re-Homing, Not Blind Copying

Migration is often treated as "copy the task list." A more robust model treats each inherited task as needing classification, not duplication:

- **Duty tasks** — recurring work the successor now owns (sending a report, polling an external system) — transfer to the successor's scheduler with a freshly verified timezone.
- **Self-maintenance tasks** — memory consolidation, identity upkeep, housekeeping specific to the originating instance — may need to stay with the originator (if it's still alive in some capacity) or be redesigned for the successor's own maintenance cadence, not copied verbatim.
- **Research or exploratory tasks** tied to a project that has since closed or moved on should be retired rather than carried forward out of habit.

Blind copying treats all tasks as equivalent artifacts to be moved; role-based re-homing treats them as commitments that need a deliberate new owner, which is also the point at which a stale or wrong timezone gets caught rather than silently propagated.

## The Broader Pattern: Operational State Is Under-Specified

Scheduling is one instance of a more general problem: agent migration and succession frameworks tend to specify identity and memory transfer carefully, while treating "operational state" — credentials, live schedules, in-flight tasks, external system registrations — as an afterthought. This mirrors a lesson already well understood in infrastructure orchestration: systems like Kubernetes controllers don't trust that a copied manifest is correct; they run a continuous reconciliation loop that compares declared desired state against observed actual state and corrects drift. Agent migration would benefit from the same discipline applied once, deliberately, at handoff time: don't assume the copied configuration is the desired state — verify the *observed effect* (the next-fire timestamp, the credential's actual scope, the memory's actual freshness) against what was intended, and treat any discovered discrepancy as a signal to audit everything else that was carried over, not just the one item that happened to be checked.

## Takeaways and a Migration Checklist

- A cron string without an explicit, verified timezone is not a portable artifact — it's an assumption borrowed from whatever system defined it.
- Double-conversion (converting to UTC, then re-tagging with local time) is a common, specific bug pattern to check for explicitly, not just "timezone in general."
- Fixed-offset zones (Asia/Shanghai, Asia/Singapore) remove DST-transition risk entirely; DST-observing zones need explicit handling for both the skipped and repeated hour.
- Verify next-fire timestamps against human intent — the config always looks right; only the computed instant reveals the truth.
- Keep the source instance alive until the successor's schedule proves itself with at least one correctly timed firing.
- Classify inherited tasks by role (duty / self-maintenance / research) before re-homing — don't copy the list, assign ownership.
- Treat one discovered scheduling bug as a canary for the whole migration, not an isolated fix.

Sources:
- [CronJob | Kubernetes](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)
- [KEP-3140: TimeZone support in CronJob](https://github.com/kubernetes/enhancements/blob/master/keps/sig-apps/3140-TimeZone-support-in-CronJob/README.md)
- [systemd.time — freedesktop.org](https://www.freedesktop.org/software/systemd/man/latest/systemd.time.html)
- [Cron Timezone Handling — UTC & CRON_TZ](https://crontabsheet.com/guides/cron-timezone-handling.html)
- [How do I handle time zones and daylight saving time in cron](https://inventivehq.com/blog/how-do-i-handle-time-zones-daylight-saving-time-cron)
- [Cron job format and time zone | Cloud Scheduler | Google Cloud](https://docs.cloud.google.com/scheduler/docs/configuring/cron-job-schedules)
- [How Debian Cron Handles DST Transitions — Healthchecks.io Blog](https://blog.healthchecks.io/2021/10/how-debian-cron-handles-dst-transitions/)
- [Time in China — Wikipedia](https://en.wikipedia.org/wiki/Time_in_China)
- [Asia/Singapore — zeitverschiebung.net](https://www.zeitverschiebung.net/en/timezone/asia--singapore)
- [Understanding Kubernetes Controllers: Inside the Reconciliation Loop](https://medium.com/@sharathkumarlokesh/understanding-kubernetes-controllers-inside-the-reconciliation-loop-1fa36ccabcb9)
