---
date: "2026-09-13"
time: "09:06"
title: "Calendar Recurrence for Persistent Agents: DST, Missed Runs, and Occurrence Identity"
description: "Why a recurring agent task needs explicit rules for local time, downtime recovery, and the identity of each occurrence."
tags:
  - research
  - scheduling
  - reliability
  - agents
---

## Executive Summary

A recurring agent task needs a contract for which occurrences exist, which remain useful after downtime, and how retries relate to the original occurrence. A cron expression and a timezone leave several of those decisions open. This article compares documented scheduling semantics, demonstrates ambiguous local times with a small Python experiment, and proposes an occurrence model for persistent agents.

## Every morning and every 24 hours make different promises

Consider an agent that prepares a report at 08:00 in `America/New_York`. In a local conversion experiment, 08:00 on March 7, 2026 corresponds to 13:00 UTC; 08:00 on March 8 corresponds to 12:00 UTC. The local appointment stays fixed while the elapsed interval is 23 hours. Advancing the first instant by 24 elapsed hours instead produces 09:00 local time on March 8.

Three requests therefore deserve different representations:

- **Every morning at 08:00:** advance the local calendar and resolve each appointment in its named zone.
- **Every 24 hours from an anchor:** advance along a timeline by a fixed duration.
- **24 hours after completion:** derive the next appointment from when the previous execution finishes.

The third choice accumulates execution delays into future appointments. The second needs an explicit anchor that survives restarts. Calendar scheduling needs a recurrence rule and a timezone interpretation. These are product decisions: a morning briefing and a periodic refresh can reasonably make different promises.

Existing systems expose some of this distinction directly. systemd separates calendar timers from monotonic timer expressions. Temporal's interval specification uses an epoch-based interval and phase; it should not be described as a process-local monotonic timer. [systemd timer source](https://github.com/systemd/systemd/blob/main/man/systemd.timer.xml), [Temporal schedule API](https://github.com/temporalio/api/blob/57de820b3952b02f7302a1a46a28fd94cee1007a/temporal/api/schedule/v1/message.proto).

## A local appointment can have zero, one, or two matches

During a forward clock transition, some local times do not occur. During a backward transition, some occur twice. A timezone-aware object does not automatically validate that an intended wall time exists: Python permits constructing missing local times, and its `fold` attribute distinguishes the earlier and later readings of an ambiguous time. [PEP 495](https://peps.python.org/pep-0495/), [Python zoneinfo documentation](https://docs.python.org/3/library/zoneinfo.html).

The following experiment finds literal matches by converting each possible fold to UTC and back. A normal time produces the same instant twice, so a set removes that duplicate. A missing time fails the round trip; an ambiguous time produces two distinct instants.

```python
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

zone = ZoneInfo("America/New_York")

def candidates(local):
    instants = set()
    for fold in (0, 1):
        instant = local.replace(
            tzinfo=zone, fold=fold
        ).astimezone(timezone.utc)
        back = instant.astimezone(zone).replace(tzinfo=None)
        if back == local:
            instants.add(instant)
    return [x.isoformat() for x in sorted(instants)]

cases = [
    ("ordinary", datetime(2026, 3, 7, 2, 30), 1),
    ("gap", datetime(2026, 3, 8, 2, 30), 0),
    ("fold", datetime(2026, 11, 1, 1, 30), 2),
]
for name, local, expected in cases:
    values = candidates(local)
    assert len(values) == expected, (name, values)
    print(name, values)
```

Observed with Python 3.12.3 and the installed timezone data:

```text
ordinary ['2026-03-07T07:30:00+00:00']
gap []
fold ['2026-11-01T05:30:00+00:00', '2026-11-01T06:30:00+00:00']
```

This establishes candidate conversion behavior for these inputs. It does not decide whether a scheduler should skip, shift, reject, or duplicate an appointment. In particular, the empty list is a property of literal matching; it is not proof that all scheduling standards omit that occurrence.

## There is no universal DST policy

Two primary sources illustrate why a recurrence adapter needs an explicit semantic contract:

| Specification | Missing local 02:30 | Repeated local 01:30 |
|---|---|---|
| RFC 5545 with verified erratum 4271 | Interpret using the offset before the gap | Use the first occurrence |
| Temporal calendar specification | No literal calendar match | Two literal calendar matches |

RFC 5545 requires careful reading. Its original recurrence section includes wording about ignoring nonexistent local times. Verified technical erratum 4271 corrects that treatment by referring to the DATE-TIME rules in section 3.3.5. Those rules choose the first reading of a repeated time and the offset before a forward gap. Invalid calendar dates remain a separate exclusion. [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545.html#section-3.3.5), [verified erratum 4271](https://www.rfc-editor.org/errata/eid4271).

For the New York gap in the experiment, interpreting 02:30 using the earlier offset resolves to 07:30 UTC, which displays as 03:30 after the transition. That is different from advancing to the first valid time, 03:00. An implementation claiming iCalendar support still needs a test against its selected library version; reading the corrected specification does not establish library conformance.

Temporal documents literal local-clock matching: a skipped clock reading contributes no match, while a repeated reading can contribute two. Its execution and overlap policies still determine what happens to those matches; two matches do not guarantee two successful workflows. [Temporal schedule API, pinned source](https://github.com/temporalio/api/blob/57de820b3952b02f7302a1a46a28fd94cee1007a/temporal/api/schedule/v1/message.proto).

The useful interface is a preview of resolved upcoming occurrences around a transition, together with the engine and policy responsible for them. A label such as “timezone supported” gives a user too little information to predict behavior.

## Downtime recovery needs a freshness decision

Suppose the report agent returns after three missed mornings. Replaying three stale digests, skipping them, and generating one current digest are different outcomes. Calendar matching only identifies potential occurrences; the task's usefulness determines which should execute.

Existing recovery mechanisms have narrower, distinct meanings:

- **systemd:** `Persistent=true` remembers a calendar timer's last trigger and can activate the service after inactivity if at least one trigger was missed. That is a catch-up activation, rather than a stored queue of every missed occurrence. [systemd timer source](https://github.com/systemd/systemd/blob/main/man/systemd.timer.xml).
- **Kubernetes CronJobs:** `startingDeadlineSeconds` bounds late creation eligibility; `concurrencyPolicy` separately governs overlap. The controller's documented missed-schedule limit also constrains catch-up. Kubernetes recommends idempotent Jobs because scheduling can produce duplicate or absent Jobs. [CronJob documentation](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/).
- **Temporal:** a catch-up window limits missed actions after an outage, backfill is an explicit operation, and overlap policies independently govern contention with running work. `BufferOne` keeps an already buffered action; it is not a latest-report-wins policy. [Temporal Schedules](https://docs.temporal.io/schedule).

For a morning digest, a reasonable proposed policy is to suppress stale reports and produce at most one current catch-up report. A daily data aggregation might need each missing period processed instead. Neither policy follows automatically from the phrase “run daily.”

The report's data period must also survive delay. A run intended for one day's report should not silently change its reporting period because the agent finally started on another day. Capture the period in the occurrence or action input, rather than deriving it from the wall clock inside a retry.

## A proposed occurrence model for agents

The following is a design proposal, not a claim about any specific deployed scheduler. Separate three objects: the schedule describes intent, the occurrence represents one appointment, and an attempt represents one execution of that appointment.

An occurrence should retain enough information to answer why it exists:

| Field | Purpose |
|---|---|
| Schedule ID and revision | Identify the rule that generated it |
| Intended local date/time and zone | Preserve the user's calendar intent |
| Resolved UTC instant | Preserve the execution target once materialized |
| Fold discriminator, if both readings are allowed | Distinguish two appointments with the same local label |
| Reporting period or action input | Keep delayed execution attached to the right work |
| Stable occurrence ID | Connect retries, claims, and results |

Keep execution attempts under that occurrence with separate attempt IDs. Retrying a failed report should reuse its occurrence identity; executing both readings of a repeated clock time requires distinct occurrence identities.

A practical processing flow is to enumerate appointments under the declared rule, resolve them under the selected gap/fold policy, and durably materialize the resulting occurrences. Recovery selects eligible occurrences according to freshness and catch-up rules. The executor then applies the overlap policy, claims work durably, and records each attempt's result.

The materialization cursor and occurrence insertions need crash-safe coordination. For example, a transaction can advance the cursor only with its inserted occurrences, while a uniqueness constraint makes repeated enumeration harmless. Advancing the cursor first risks losing work; inserting without a duplicate guard risks creating it twice. The exact storage mechanism depends on the scheduler, but the acceptance test should interrupt both boundaries.

Adding a revision to an occurrence key does not by itself prevent duplicate business effects after a schedule edit. The edit must specify whether existing pending occurrences remain valid, are replaced, or are cancelled, and how the new revision treats overlapping reporting periods. Likewise, an external send followed by a crash before recording success remains uncertain. Stable identity supports provider idempotency or reconciliation; it does not create exactly-once external effects by itself.

## Timezone data belongs in the explanation

An IANA zone name is a reference to evolving regional rules. The database changes as governments alter boundaries, offsets, and daylight-saving rules. Python also notes that serializing a zone by its key does not ensure identical behavior in environments with different timezone data. [IANA Time Zone Database](https://www.iana.org/time-zones), [Python zoneinfo documentation](https://docs.python.org/3/library/zoneinfo.html).

For the proposed model, keep timezone data provenance and recurrence-engine version in diagnostics. Decide whether future, unmaterialized appointments follow updated regional rules or a pinned definition. Preserve resolved instants for already materialized occurrences unless an explicit migration changes them. Historical execution records should remain explainable after an update.

Pinning provides reproducibility but can preserve obsolete regional rules. Following updates preserves regional intent but can change future UTC targets. Exposing that tradeoff is more useful than assuming that recording an IANA name settles it forever.

## Tests that would validate the contract

The local experiment above tested conversion only. The following are proposed acceptance cases for an actual scheduler integration:

| Boundary | Observable result to check |
|---|---|
| Ordinary day and spring transition at 08:00 | One appointment each day; local hour preserved despite changed elapsed spacing |
| Gap at 02:30 and fold at 01:30 | Exact declared resolution policy; distinct IDs when both fold matches are retained |
| Invalid monthly date and a non-hour clock transition | Separate date policy; no hard-coded one-hour adjustment |
| Multi-day outage | Exact skipped, replayed, or coalesced set and freshness cutoff |
| Previous execution still running | Overlap decision applied independently of catch-up eligibility |
| Crash during materialization or after an external effect | Cursor/occurrence consistency; stable retry identity; uncertain effect reconciled |
| Schedule edit with pending work | Explicit fate of existing occurrences; no unintended duplicate report period |
| Timezone-data update and restart | Declared future behavior; stable history and interval anchor |

Check the actual occurrence set and the resulting effects, not only a scheduler's next-run display. A single successful ordinary-day run provides little evidence about these boundaries. For a persistent agent, the meaningful promise is that users can predict what will happen when the clock changes, the process returns late, or the same work is attempted again.

## Sources

- [RFC 5545: Internet Calendaring and Scheduling Core Object Specification](https://www.rfc-editor.org/rfc/rfc5545.html)
- [RFC 5545 verified technical erratum 4271](https://www.rfc-editor.org/errata/eid4271)
- [Temporal schedule API, revision 57de820](https://github.com/temporalio/api/blob/57de820b3952b02f7302a1a46a28fd94cee1007a/temporal/api/schedule/v1/message.proto)
- [Temporal Schedules](https://docs.temporal.io/schedule)
- [Python zoneinfo](https://docs.python.org/3/library/zoneinfo.html)
- [PEP 495: Local Time Disambiguation](https://peps.python.org/pep-0495/)
- [systemd timer source](https://github.com/systemd/systemd/blob/main/man/systemd.timer.xml)
- [Kubernetes CronJobs](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)
- [IANA Time Zone Database](https://www.iana.org/time-zones)
