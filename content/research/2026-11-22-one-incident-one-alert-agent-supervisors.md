---
date: "2026-11-22"
title: "One Incident, One Alert: Keying, Deduplicating and Wording Supervisor Alerts for Agent Runtimes"
description: "How a small self-hosted agent supervisor can send one alert per incident and one resolve message that points back to it, with wording a non-engineer owner can act on, drawn from Alertmanager, PagerDuty, Opsgenie, Grafana, Nagios and Google SRE guidance."
tags:
  - research
  - ai-agents
  - alerting
  - observability
  - reliability
  - incident-management
  - supervisor
---

## Executive Summary

A small self-hosted AI-agent system has a supervisor process that watches a long-running agent in a terminal session. One morning the agent's model-provider authentication failed for about 50 minutes. A user message waited the whole time. The supervisor sent an alert to the owner's chat, then a near-identical second alert a minute later. The text showed a raw internal state name (something like `session_auth_blocked`) that the owner had to ask about. After recovery, no message said so.

Each defect has a standard fix in mature alerting systems. Those systems are built for teams and fleets, so most of their machinery is too much for one owner. The ideas are small, though. This article separates the ideas from the machinery.

Conclusions:

1. **Key the incident on the root condition of one subject, not on the detector, the time, or the process.** A good key looks like `agent-main/cannot-answer`. It has no timestamp, PID, restart counter, error string or detector name. PagerDuty and Opsgenie both state the rule: a later event with the same key joins the open alert instead of creating a new one.
2. **Use a short lifecycle: open, optional slow reminder, resolve.** One message on open, one on resolve. Put a short delay on both transitions (a pending period in, a "keep firing" period out) so flapping does not become a message storm.
3. **Persist a tiny incident record to disk.** In-memory dedup is lost on every supervisor restart, which is the most likely cause of a duplicate one minute later. About eight fields in a JSON file or SQLite row are enough.
4. **Write for the owner.** Say what happened, what it affects (with a number and a clock time), whether the owner must act, and what to do. Put the machine code in a footer, never in the sentence.
5. **Send alerts over a path that does not depend on the failing component, and keep the model out of the alert text.** A model-auth failure is the moment the model cannot write anything.
6. **Do not build a PagerDuty.** A keyed record, a small state machine, two timers, a plain template and a direct send path are enough.

One caution: I do not know why the second alert fired. "Two checks or a restart re-detected the condition with no memory of the first alert" is a hypothesis that fits the symptoms. The design below removes all the plausible causes anyway.

## 1. What the reference systems do

| System | What identifies "the same problem" | Repeats | Recovery |
|---|---|---|---|
| Prometheus Alertmanager | `group_by`: "The labels by which incoming alerts are grouped together." | `group_wait` before the first notification of a group, `group_interval` between later ones, `repeat_interval` (default 4h) before repeating | `send_resolved`: "Whether to notify about resolved alerts." Default true for most integrations; email, Rocketchat, Slack and WeChat default to false |
| PagerDuty Events API v2 | `dedup_key`, max 255 characters | Later events with the same key are "applied to an open alert matching that `dedup_key`" | A `resolve` event with the same key |
| Opsgenie | `alias`: "user-defined unique identifier for 'open' alerts" | "At most one open alert with the same alias"; repeats raise a Count | Alias is unique only among open alerts |
| Grafana alerting | Alert instance (label set) | Pending period in; "keep firing for" out | Recovering state, then Normal and Resolved |
| Nagios / Icinga | Host or service object | Soft/hard states, flap detection, re-notify interval | Recovery notification |

Sources: [Alertmanager configuration](https://prometheus.io/docs/alerting/latest/configuration/), [PagerDuty](https://docs.pagerduty.com/developer/send-alert-event), [Opsgenie](https://support.atlassian.com/opsgenie/docs/what-is-alert-de-duplication/), [Grafana](https://grafana.com/docs/grafana/latest/alerting/fundamentals/alert-rule-evaluation/), [Nagios](https://assets.nagios.com/downloads/nagioscore/docs/nagioscore/4/en/flapping.html), [Icinga](https://icinga.com/docs/icinga-2/latest/doc/03-monitoring-basics/).

The common pattern: the system, not the detector, decides what counts as "the same". It keeps a record of what it already told people. Opening and closing a problem are two events that both get a message.

Google's SRE book gives the target: noisy alerts "should be tweaked to approach a 1:1 alert/incident ratio" ([Being On-Call](https://sre.google/sre-book/being-on-call/)). Here that means one alert per incident.

## 2. Choosing the incident key

### 2.1 One key per root condition of one subject

The key answers: "If I get this signal again, is it a problem the owner already knows about?"

PagerDuty: the `dedup_key` "can be specified when submitting the first trigger event that creates an alert." If omitted, PagerDuty generates one, and "A trigger event sent without a `dedup_key` will always generate a new alert" because the value is a unique UUID ([PagerDuty](https://docs.pagerduty.com/developer/send-alert-event)). An unstable or missing key therefore means every detection is a new alert. That is the failure in the motivating case.

Opsgenie, from the other side: when a source creates an alert while one with that alias is open, "the **Count** value of the open alert will be increased by one instead of creating another alert." Repeats go to the activity log, not to a new notification ([Opsgenie](https://support.atlassian.com/opsgenie/docs/what-is-alert-de-duplication/)).

### 2.2 What goes in the key

| In the key | Stored as attributes, not in the key |
|---|---|
| Subject (`agent-main`) | Timestamps, counters, attempt numbers |
| Condition class at the level the owner cares about (`cannot-answer`, `model-auth`) | PID, session ID, restart count |
| A provider name, only if it changes what the owner must do | Raw error text, HTTP status, stack trace |
| | Which detector or check noticed it |

The key must survive three events unchanged: the same detector firing again, a supervisor restart, and a different detector noticing the same root cause. A readable string is better than a hash because you can read it in logs and the state file.

### 2.3 Symptom or cause?

The SRE book: "The 'what's broken' indicates the symptom; the 'why' indicates a (possibly intermediate) cause." It calls this "one of the most important distinctions in writing good monitoring with maximum signal and minimum noise" ([Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/)). Rob Ewaschuk: "Include cause-based information in symptom-based pages or on dashboards, but avoid alerting directly on causes", and print "a terse summary of all of your cause-based rules that are firing in every page" ([My Philosophy on Alerting](https://docs.google.com/document/u/0/d/199PqyG3UsyXlwieHaqbGiWVa8eMWi8zzAn0YfcApr8Q/mobilebasic)).

For a supervisor:

- The incident is the **symptom**: `agent-main/cannot-answer`, meaning the agent is not processing the owner's messages.
- Detectors for causes (auth rejected, process crashed, terminal hung, rate limit) do not open incidents of their own. They attach a **cause code** to the one open incident. The most specific code wins, and the others go in an "also seen" field.
- This is what Alertmanager inhibition does at fleet scale: "suppressing notifications for certain alerts if certain other alerts are already firing" ([overview](https://prometheus.io/docs/alerting/latest/alertmanager/)). One agent needs only a ranked list of cause codes, not rules.

Trade-off: if the cause changes mid-incident and the owner's required action changes (auth failure becomes a rate limit), send one short "update" in the same incident. If only technical detail changes, update the record silently.

Keying on cause (`agent-main/model-auth`) also works if every detector of that cause maps to it. The failure mode is two keys for one outage. Pick one level and keep it.

### 2.4 A supervisor restart is a detector, not an incident

systemd's `Restart=` restarts a service "when the service process exits, is killed, or a timeout is reached"; `RestartSec=` "Defaults to 100ms" ([systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)). Units "started more than burst times within an interval time span are not permitted to start any more" ([systemd.unit](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html)). Each restart can re-detect the same condition. Do not alert per restart. Treat "gave up restarting" as a cause code on the same incident.

## 3. Lifecycle: open, remind, resolve

### 3.1 State machine

```
          condition holds for N probes / T_pending
(none) ─────────────────────────────────────────────► OPEN   (send "opened" once)
                                                       │  ▲
                        long, slow interval            │  │ condition returns inside
                        (send "reminder")              │  │ T_clear: no message
                                                       ▼  │
                       condition absent for T_clear ► RESOLVING
                                                       │
                                                       ▼
                                                   RESOLVED  (send "resolved" once,
                                                              replying to the open message)
```

After RESOLVED, the same key returning within a reopen window reopens the incident with one short "back again" message. Outside the window it is a new incident. PagerDuty always starts a new one: new trigger events with a resolved key "won't re-open the incident. Instead, a new incident will be created."

### 3.2 Hysteresis: delay in, delay out

Prometheus's `for` clause makes it "wait for a certain duration" before "counting an alert as firing"; without it, rules "become active on the first evaluation" ([alerting rules](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/)). Grafana's pending period is "how long the condition must be met to start firing," to "prevent unnecessary notifications caused by temporary issues."

On the way out, Prometheus's `keep_firing_for` keeps an alert firing "for the specified duration after the firing condition was last met", to "prevent situations such as flapping alerts." Grafana makes it a visible state: Recovering is "The state of a firing alert when the threshold is no longer breached, but the keep firing for period has not yet elapsed." And: "If the condition comes back first, the instance goes back to Alerting without sending new notifications" ([Grafana](https://grafana.com/docs/grafana/latest/alerting/fundamentals/alert-rule-evaluation/)). That sentence is the core of flap suppression. A return inside the clear window is the same incident, with no new message.

Google's workbook names the cost of each delay. Detection time: "Long detection times can negatively impact the error budget." Reset time: "How long alerts fire after an issue is resolved. Long reset times can lead to confusion or to issues being ignored" ([Alerting on SLOs](https://sre.google/workbook/alerting-on-slos/)).

For a supervisor probing every 30-60 seconds, a starting shape is: open after two or three consecutive failures, resolve after two or three consecutive successes. These numbers are my illustration, not from a source. Skip the pending period for failures known to need a human, such as an authentication rejection from the provider.

### 3.3 Flapping

Nagios defines flapping as a state that "changes state too frequently, resulting in a storm of problem and recovery notifications." It stores "the results of the last 21 checks," computes a percent state change, and compares it with high and low thresholds. When flapping starts it will "Send a 'flapping start' notification" and "Suppress other notifications"; when it stops it sends "a 'flapping stop' notification" and lifts the block ([Nagios](https://assets.nagios.com/downloads/nagioscore/docs/nagioscore/4/en/flapping.html)).

Icinga's soft/hard states are a simpler form: a problem is re-checked in a SOFT state, and only if "still non-OK after the re-checks" does it become HARD and "notifications are sent." Icinga also sends `Recovery` notifications only to "users who have been notified of a problem before" ([Icinga](https://icinga.com/docs/icinga-2/latest/doc/03-monitoring-basics/)). Copy that: never send "resolved" for something you did not announce.

A cheap version for one owner: count reopens per key in a rolling window. Past a small count, send one "unstable" message, mute that key's open/resolve messages, and send one "stable again" message after a quiet period.

### 3.4 Reminders

Alertmanager's `repeat_interval` is "How long to wait before repeating the last notification." Datadog says reminders exist "to remind your team that a problem is not solved" and to "Include only extra details" rather than repeating the original ([Datadog](https://docs.datadoghq.com/monitors/notify/)). For one owner: one reminder after about an hour, then every several hours, each carrying new facts (duration, messages now waiting). Skip it if the owner has already acted.

### 3.5 The resolve message

PagerDuty: a `resolve` event with the same key puts the incident into the resolved state, and "Once an incident is resolved, it won't generate any additional notifications."

Two points for chat:

- **Resolved messages may be off by default.** Alertmanager's `send_resolved` defaults to false for Slack, email, WeChat and Rocketchat. If a tool posts to chat for you, check it. A silent resolve was the fourth defect here.
- **Point back to the alert.** Use the chat platform's reply-to on the stored message ID of the open alert. Without that feature, repeat the incident number and the original time.

## 4. Persisting state across supervisor restarts

An in-memory "already alerted" flag fails simply. The supervisor restarts, the flag is gone, the condition is still true, and the first check looks like a new problem.

Alertmanager keeps a notification log for this. Its HA documentation describes it as "Records of which notifications were sent to prevent duplicates", and states the goal of "At-least-once delivery": "Alertmanager prefers duplicate notifications over missed alerts" ([HA](https://prometheus.io/docs/alerting/latest/high_availability/), as summarized by my fetch tool). The one-owner version is a file.

### 4.1 Minimal durable record

One JSON object or row per incident:

| Field | Example | Why |
|---|---|---|
| `key` | `agent-main/cannot-answer` | Dedup identity, unique among non-closed incidents |
| `state` | `open`, `resolving`, `resolved` | Drives the next message |
| `opened_at` | `2026-11-22T10:02:10+08:00` | Duration and the "since" in text |
| `last_seen_at` | `2026-11-22T10:51:40+08:00` | Clear-window timing |
| `cause_code` | `AUTH_REJECTED` | Machine code for the footer |
| `notified_at` | timestamp or null | Whether the open message really went out |
| `last_reminder_at` | null | Reminder pacing |
| `chat_msg_ref` | platform message ID | So resolve can reply to the open alert |

Add a short human `incident_id` (`#14`) and an append-only history file with one line per transition. The history answers "what did I tell the owner at 10:02?".

### 4.2 Write order

1. Detect. Look up the key.
2. No open record: write `state=open, notified_at=null`, send, then set `notified_at` and `chat_msg_ref`.
3. Open record exists: update `last_seen_at` and stay silent.
4. On startup, for any open record with `notified_at = null`, send the open message once.

This is at-least-once delivery. A crash between write and send delays one message. A crash between send and `notified_at` causes at most one duplicate. For a single owner that beats a silent outage.

### 4.3 Startup reconciliation

Load the file. Announce nothing for conditions matching an open record. For open records whose condition is gone, run the clear window, then send resolve. If the file is missing or corrupt, log it loudly and send one honest message ("I restarted and lost my alert memory; a repeated alert may be a duplicate"). Keep the file on a path that survives restarts, not `/tmp`. A user-reported Alertmanager issue (secondary source, see below) describes a non-persistent data directory causing every firing alert to be re-notified after each restart.

## 5. Wording for a non-engineer owner

### 5.1 What to include

The SRE book: "Every page should be actionable." Prometheus: "avoid having pages where there is nothing to do," and "Alerts should link to relevant consoles and make it easy to figure out which component is at fault" ([practices](https://prometheus.io/docs/practices/alerting/)). Datadog suggests including "a step-by-step way to resolve the problem" in the message. Prometheus's own example summaries are plain statements ("Instance {{ $labels.instance }} down") with durations in the description, and annotations are for "alert descriptions or runbook links."

Turn that into five slots, in this order:

1. **What happened**, in the owner's words.
2. **Impact**, with a number and a time: "1 message from you has been waiting since 10:00."
3. **Do you need to act?** Say "Action needed" or "No action needed, I'm retrying."
4. **What to do**, one concrete step, or "nothing, I will tell you when it is fixed."
5. **Footer**: incident number and machine code.

### 5.2 Rules

- Lead with the effect ("Your assistant is not answering"), not the component.
- Use clock times in the owner's timezone, not "5m ago", which goes stale in chat.
- Take counts from the live system at send time.
- Say who is doing what: "I'm retrying every minute" or "I can't fix this myself."
- Keep it to about six lines. Put the rest behind a "reply `details`" command.
- No enum names, state names, file paths or stack traces in the sentences.
- Use fixed templates filled by code (see section 6).

### 5.3 Human text plus machine code

PagerDuty shows the shape: `payload.summary` is "A brief text summary of the event" (max 1024 characters), `custom_details` holds "Additional details about the event and affected system," and `links` carries links with text. Do the same locally: the record holds `cause_code`, and a lookup table in code maps each code to an owner sentence and an action line. An unmapped code falls back to a generic sentence ("Something is wrong with the assistant; details attached") and logs an error so a developer adds the mapping. The raw state name never reaches the owner, even on the fallback path.

### 5.4 Good and bad

**Bad (the motivating case, paraphrased):**

```
ALERT: agent state session_auth_blocked, restarting.
ALERT: agent state session_auth_blocked, restarting.   (a minute later)
```

An internal name, no impact, no instruction, two copies, no resolve.

**Good, open:**

```
Your assistant can't sign in to its AI provider, so it is not answering.
Since 10:02. 1 message from you has been waiting since 10:00.
Action needed: please sign in again, or check that the subscription
is active. I'll keep checking and tell you when it works.
Ref #14 - code: AUTH_REJECTED
```

**Good, resolve (as a reply to the open message):**

```
Fixed at 10:53. The assistant is answering again after 51 minutes.
Your waiting message is being handled now.
Ref #14 - code: AUTH_REJECTED (resolved)
```

The resolve text may claim only what the supervisor verified. If it cannot see the queue drain, say less.

**Good, transient failure (no action needed):**

```
Your assistant had a short outage (the AI provider is not responding).
No action needed, I'm retrying every minute. 1 message waiting since 10:00.
Ref #15 - code: PROVIDER_UNAVAILABLE
```

## 6. Channel independence

An alert must not travel through the thing that failed. If the owner-facing chat bridge is part of the agent system, or the agent drafts the alert, a model outage cuts the alert off.

1. **Send directly from the supervisor.** One plain HTTP call to the messaging API (or SMTP, or a push service), with a credential the supervisor holds. Not through the agent, its terminal, its tools or its model.
2. **No LLM in the alert path.** Templates only.
3. **Make the send resilient.** Retry with a delay. If it still fails, leave `notified_at` null so the startup rule retries, and write a local log line. A second channel for first-channel failure is a cheap extra.
4. **Watch the watcher (optional).** The usual answer is a dead man's switch: the supervisor pings an outside service on a schedule, and the service alerts when pings stop. Healthchecks.io: "When Healthchecks.io does not receive the HTTP request at the expected time, it notifies you," and grace time is "the amount of extra time to wait when a cron job is running late before declaring it as down" ([docs](https://healthchecks.io/docs/monitoring_cron_jobs/)). Keep the checker off the supervisor's machine.

## 7. What not to build

For one owner, skip: routing trees and matchers (one recipient); a grouping engine (one incident per subject by construction); a silences UI (a "pause alerts for an hour" command is enough, if even that); clustering and gossip (one process); escalation policies and on-call schedules (the owner is the only responder); acknowledge workflows (an owner reply can mean "seen"); multi-channel fan-out (one chat plus at most one fallback); the 21-sample statistical flap detector (a reopen counter gets most of the value); similarity-based or ML dedup (hard keys already work); a templating language or runbook wiki (a dictionary of cause code to sentence and action).

Add more only when there are several owners or agents, several channels, a need to record who acknowledged, or an on-call rotation.

The same restraint applies to detectors. Google's workbook gives a low-precision example: "you could receive up to 144 alerts per day every day, not act upon any alerts, and still meet the SLO." Fewer, better alerts.

## 8. Design sketch

Parts:

1. **Detectors** (any number). Each calls `report(subject, cause_code, details)`. They never send messages and never know about chat.
2. **Incident engine**. Owns the incident file, the state machine, and the pending, clear and reminder timers.
3. **Notifier**. Renders a template for (transition, cause code), sends over the independent channel, returns a message reference.
4. **Heartbeat** (optional). Pings an external service while the supervisor loop runs.

The pending counter can live in memory. Losing it on restart delays an alert by a few probes and never creates a duplicate.

How it prevents the original defects:

| Defect | Mechanism |
|---|---|
| Duplicate alert a minute later | Stable key; open record means silence; record survives restart |
| Two detectors for one root cause | Both attach to the same key; extra cause goes in "also seen" |
| Raw state name in text | Code-to-sentence table; code only in the footer |
| Owner had to ask what it meant | Five-slot template with explicit "action needed" |
| No resolve message | Resolve transition sends one message replying to the stored message ref |
| Alert unreliable during a model outage | Direct send path; no model in the loop |

## 9. Checklist

- Key is `subject/condition`, with no timestamps, PIDs, counters, error text or detector names.
- All detectors of one root cause map to one key; a restart never creates an incident.
- Pending period before open; clear period before resolve; a return inside the clear window is silent.
- Exactly one open message and one resolve message per incident; no resolve for an unannounced incident.
- Reminders are slow, add new facts, and stop once the owner acts.
- Reopen counter with a single "unstable" message.
- Incident record on durable disk; write before send, `notified_at` after; startup retries unsent messages and reconciles open incidents.
- Text has: what happened, impact with number and clock time, action needed or not, one concrete step, footer with incident number and code.
- No internal enum, state name, path or stack trace in sentences; unmapped codes get a generic fallback.
- Resolve replies to the original and claims only verified facts.
- Alert is sent directly by the supervisor, from templates, with retry and a persistent unsent marker.

## What I could not confirm

- **Why the duplicate fired in the motivating case.** I have no logs. Restart with in-memory state, or two detectors, are likely explanations, not facts.
- **Good numbers.** Nagios's 21 checks is documented, but I found no source recommending thresholds for a one-owner agent supervisor. The numbers in sections 3.2 to 3.4 are my illustrations.
- **Alertmanager's on-disk notification log.** That it persists the notification log and silences under `--storage.path` and reloads them on restart, and that a non-persistent directory causes re-notification, came from search-result summaries and user GitHub issues, not a primary page I could open. The HA page quotes come from my fetch tool's summary of the page. The Alertmanager overview has no deduplication section; it names deduplication only in its intro.
- **`group_wait` detail.** That an alert resolving before `group_wait` ends produces no notification comes from the fetch tool's summary of the configuration page.
- **The Prometheus Watchdog pattern.** An always-firing alert routed to an external heartbeat service appears only in community guides. I did not verify it against Prometheus or kube-prometheus docs. Healthchecks.io's docs support the generic heartbeat idea.
- **Opsgenie's status.** Search results say Atlassian is winding Opsgenie down, with end of support in 2027. I could not open the primary page to confirm dates. Its alias semantics are still a useful reference. The Opsgenie page does not say what happens when an alias arrives after the alert is closed. A new alert is likely, but that is an inference.
- **Grafana and Icinga gaps.** Grafana uses "flapping conditions" without defining flapping. The Icinga page I fetched was cut off before any flap-detection section, so I cite only its soft/hard state and recovery text.
- **Wording evidence.** I found guidance on what an alert should contain (Google SRE, Ewaschuk, Prometheus, Datadog) but no empirical study of which wording non-engineers act on fastest. The five-slot template is my synthesis, not a tested format. An Atlassian alert-fatigue article could not be read by my tool.
- **PagerDuty URLs.** `developer.pagerduty.com` pages redirect to `docs.pagerduty.com`; all PagerDuty quotes come from the new URL.

## Sources

- Alertmanager configuration: https://prometheus.io/docs/alerting/latest/configuration/
- Alertmanager overview: https://prometheus.io/docs/alerting/latest/alertmanager/
- Alertmanager high availability: https://prometheus.io/docs/alerting/latest/high_availability/
- Prometheus alerting rules: https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/
- Prometheus alerting practices: https://prometheus.io/docs/practices/alerting/
- PagerDuty, Sending an Alert Event: https://docs.pagerduty.com/developer/send-alert-event
- PagerDuty, Events API v2 overview: https://docs.pagerduty.com/developer/events-api-v2-overview
- Opsgenie alert de-duplication: https://support.atlassian.com/opsgenie/docs/what-is-alert-de-duplication/
- Grafana alert rule evaluation: https://grafana.com/docs/grafana/latest/alerting/fundamentals/alert-rule-evaluation/
- Grafana error and no data states: https://grafana.com/docs/grafana/latest/alerting/fundamentals/alert-rule-evaluation/nodata-and-error-states/
- Nagios Core 4, state flapping: https://assets.nagios.com/downloads/nagioscore/docs/nagioscore/4/en/flapping.html
- Icinga 2 monitoring basics: https://icinga.com/docs/icinga-2/latest/doc/03-monitoring-basics/
- Google SRE book, Monitoring Distributed Systems: https://sre.google/sre-book/monitoring-distributed-systems/
- Google SRE book, Being On-Call: https://sre.google/sre-book/being-on-call/
- Google SRE Workbook, Alerting on SLOs: https://sre.google/workbook/alerting-on-slos/
- Rob Ewaschuk, My Philosophy on Alerting: https://docs.google.com/document/u/0/d/199PqyG3UsyXlwieHaqbGiWVa8eMWi8zzAn0YfcApr8Q/mobilebasic
- systemd.service: https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html
- systemd.unit: https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html
- Datadog monitor notifications: https://docs.datadoghq.com/monitors/notify/
- Healthchecks.io, monitoring cron jobs: https://healthchecks.io/docs/monitoring_cron_jobs/
