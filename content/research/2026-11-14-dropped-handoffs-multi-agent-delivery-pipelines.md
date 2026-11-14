---
date: "2026-11-14"
title: "Nobody Picked It Up: Detecting Dropped Handoffs in Multi-Agent Delivery Pipelines"
description: "How mature monitoring, messaging, workflow, and code-review systems detect that an expected follow-up never happened, and how to apply those mechanisms to agent handoffs that silently fail to trigger a reviewer."
tags: [ai-agents, multi-agent, reliability, observability, code-review, webhooks, monitoring, workflow-orchestration]
---

## Executive Summary

A developer agent finishes a change and posts "done, here is the PR" on a task card. The post succeeds. The card shows a new comment. Nothing else happens: the reviewer was never triggered, because the @mention was malformed, the webhook did not fire, or an event filter dropped the message. No error was raised anywhere, so no alert fired. Hours later someone notices that the work has been sitting there.

This failure is not about the post failing. It is about a follow-up that was expected and never occurred. Systems that only watch for errors cannot see it, because nothing erred. The research question is how mature infrastructure detects "event emitted, expected follow-up absent," and which of those mechanisms transfer to fleets of autonomous agents.

This article surveys primary documentation from monitoring systems (Prometheus, Healthchecks.io, Cronitor), message brokers (Google Pub/Sub, Amazon SQS), workflow engines (Temporal, AWS Step Functions), code-review tooling (GitHub, Gerrit, Prow/Tide, Phabricator), and alert-suppression features (Alertmanager, PagerDuty). Five findings stand out:

1. **Absence needs a clock.** Every system that detects "it never happened" attaches a deadline to an expected event: a Healthchecks.io period plus grace time, a Pub/Sub acknowledgement deadline, a Temporal Schedule-To-Start timeout, a Prometheus `for:` duration. Without a deadline, absence is indistinguishable from "not yet."
2. **The deadline hangs off a recorded obligation.** Gerrit's attention set, Phabricator's "Action Required" list, and GitHub's review requests all store who owes the next action, as data. Systems that infer the obligation from free text (a comment that happens to contain an @mention) have nothing to time out.
3. **A successful post is not a successful trigger.** GitHub's own documentation separates a mention notification from a review request, and its webhook docs state that failed deliveries are not automatically redelivered. Verifying the trigger's outcome after posting is a separate step.
4. **Brokers solved this with leases, redelivery, and dead-letter queues.** In systems that use them, the consumer must acknowledge within a deadline or the message comes back, and messages that keep failing land somewhere a human or alarm will see them.
5. **Suppression must be scoped to a cause and must expire.** Silences, inhibitions, and snoozes are built to hide noise. The documentation of Alertmanager and PagerDuty shows how each is scoped (label matchers, an acknowledged incident, a duration), and those scoping choices determine whether a snooze can hide a genuine dropped handoff.

The article ends with concrete design recommendations: model the handoff as an explicit state with an owner and a deadline, detect "delivery without a following review start," send a reminder before taking any automatic action, guard against false positives, and evaluate the detector by injecting a known dropped handoff as a positive control.

A note on claims: where this article states an architectural judgment, it is scoped ("in systems that...") and labeled as inference. Statements about what a product does or does not do are limited to what its official documentation shows.

## The Failure Shape: Emitted, Not Followed

It helps to name the pieces of a handoff, because each can fail independently.

| Step | What should happen | Typical silent failure |
|---|---|---|
| 1. Artifact | The developer agent produces a PR or commit | Commit pushed to the wrong branch, PR left as a draft |
| 2. Announcement | A message is posted on the task card | Post succeeds but is routed nowhere |
| 3. Trigger | The announcement causes a reviewer to be notified or started | Malformed or unresolved @mention, webhook not sent, event filtered out, trigger sent while reviewer is offline |
| 4. Acknowledgement | The reviewer starts (a session opens, a review is requested, a comment is posted) | Reviewer never starts; reviewer starts and crashes |
| 5. Completion | A review verdict is posted | Verdict posted on the wrong object |

Steps 1 and 2 are controlled by the producer and usually emit a success signal. Step 3 is where the producer's knowledge ends: it posted text, and it assumes text was a trigger. Steps 4 and 5 happen in a different actor. A monitoring setup that looks only at the producer sees a green run all the way through.

Google's SRE book frames the general principle: monitoring should address "what's broken, and why," and it recommends spending "much more effort on catching symptoms than causes" ([SRE Book: Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/)). The Prometheus alerting guidance gives the same advice for offline pipelines: for batch jobs, "page if the batch job has not succeeded recently enough," and measure how long work takes to pass through the pipeline ([Prometheus: Alerting practices](https://prometheus.io/docs/practices/alerting/)). A dropped handoff is a pipeline-latency symptom: the time from "implementation done" to "review started" grew without bound. Detecting it by symptom does not require knowing which of the several causes (bad mention, dead webhook, filtered event) produced it.

## "No Error" Is Not "Success": Absence Monitoring

### Dead-man's switches and heartbeats

The classic pattern for silent failure is the heartbeat. Healthchecks.io describes it directly: it "listens for HTTP requests ('pings')" from your jobs, stays quiet while they arrive on schedule, and "raises an alert as soon as a ping does not arrive on time" ([Healthchecks.io docs](https://healthchecks.io/docs/)). Its model has explicit parts:

- A **period** defines when the check becomes late.
- A **grace time** is "the additional time to wait before sending an alert when a check is late," absorbing normal variation.
- Status moves through up, late, and down; only "down" (grace elapsed) triggers alerts.
- Optional **start** and **failure** signals let a job report that it began or that it failed. With start signals, grace time "also sets the maximum allowed time gap between 'start' and 'success' signals."

The start signal is a useful analogue for handoffs. "Reviewer started" is the start ping. A handoff that has a "delivered" event but no "started" event within the grace window is exactly a missed start.

Cronitor's heartbeat monitors work on the same shape: an expected interval, a configurable grace period, and an alert when "heartbeats stop arriving or report failures" ([Cronitor: heartbeat monitoring](https://cronitor.io/docs/heartbeat-monitoring)).

The Prometheus ecosystem uses the same idea for the alerting pipeline itself. The kube-prometheus runbook describes a `Watchdog` alert that is "always firing" by design, so that "if not firing then it should alert external systems that this alerting system is no longer working" ([Prometheus Operator runbook: Watchdog](https://runbooks.prometheus-operator.dev/runbooks/general/watchdog/)). The signal is the absence of an alert that should always exist. This matters later, because the same trick can verify the detector.

### Prometheus: `absent()` and `for:`

Prometheus offers `absent()`: it "returns an empty vector if the vector passed to it has any elements," and otherwise a one-element vector with value 1, which "is useful for alerting on when no time series exist for a given metric name and label combination." `absent_over_time()` does the same over a range, so it can express "for a certain amount of time" ([Prometheus: query functions](https://prometheus.io/docs/prometheus/latest/querying/functions/)). Two consequences are worth drawing out.

First, the `for:` clause adds the deadline. Alerting rules with `for:` wait a duration between first seeing an expression result and "counting an alert as firing"; in between, elements "are in the pending state." Without `for:`, a rule "will become active on the first evaluation." `keep_firing_for` holds an alert firing after the condition last held, to prevent "flapping alerts, false resolutions due to lack of data loss, etc." ([Prometheus: Alerting rules](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/)). Both are tools for separating "not yet" from "never."

Second, `absent()` is documented in terms of a selector for a given metric name and label combination. In an inference scoped to metric-based setups: it tells you that a series you named is missing, and it does not enumerate which entities should have had a series. A per-handoff check ("this particular handoff has no review-start") therefore needs the handoff itself to exist as a record (or as a series) before it can be found missing. That is the argument for modeling the handoff explicitly, developed below.

## Acknowledgement Deadlines, Redelivery, and Dead Letters

Message brokers faced the same problem: a message handed to a consumer might vanish into a crashed process. Their answer is a lease with a deadline.

**Google Pub/Sub.** A pull subscriber "must process and acknowledge (ack) the message within the acknowledgment deadline"; if it cannot finish in time, it must extend the deadline. If the deadline lapses without an ack or extension, Pub/Sub delivers the message again. The documentation states the tradeoff plainly: "A low value increases the likelihood of duplicates and a high value delays the redelivery of failed messages" ([Pub/Sub: lease management](https://docs.cloud.google.com/pubsub/docs/lease-management)). The client libraries offer lease management that automatically extends the deadline while a handler is still working, and "redelivery occurs when the first subscriber processing the message crashes or becomes unhealthy" and can no longer send extension requests. The same page cautions that acknowledgement deadlines "are not guaranteed to be respected unless you enable exactly-once delivery," so consumers still need to tolerate duplicates.

For messages that keep failing, Pub/Sub can forward them to a dead-letter topic after a configured number of delivery attempts (default 5, range 5 to 100, forwarded "on a best-effort basis"). Forwarded messages can be monitored through the `subscription/dead_letter_message_count` metric ([Pub/Sub: dead-letter topics](https://docs.cloud.google.com/pubsub/docs/handling-failures)).

**Amazon SQS.** A received message "remains in the queue but becomes temporarily invisible to other consumers." If it is not deleted before the visibility timeout expires, "the message becomes visible again in the queue and can be retrieved by another consumer." The default is 30 seconds; the documentation recommends a heartbeat mechanism that periodically extends the timeout, and notes a 12-hour maximum from first receipt ([SQS: visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)). A redrive policy's `maxReceiveCount` sets how many times a message may be received before it moves to a dead-letter queue, where it can be examined, and the documentation links to CloudWatch alarms for messages moved there ([SQS: dead-letter queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)).

What transfers to agent handoffs, as inference:

- **Acknowledgement is a distinct event from delivery.** The broker does not treat "sent" as "handled." Handled means the consumer called ack or delete.
- **The lease makes absence observable.** The message itself carries its deadline. No separate monitor has to guess what should have happened.
- **Redelivery needs idempotency.** Both documents warn about duplicates. A re-trigger of a reviewer must be safe to receive twice.
- **A terminal sink prevents silent loss.** A dead-letter destination only helps if something watches it. The Pub/Sub and SQS docs each point to a metric or alarm for that purpose.

## Workflow Engines: Timers Owned by the Orchestrator

Workflow systems place the deadline in the orchestration layer, so a missing follow-up is a first-class event rather than something to infer.

**Temporal.** Activity timeouts are separate on purpose. Schedule-To-Start is "a limit for how long an Activity Task can be enqueued," measured from when the task is placed in a Task Queue to when a Worker picks it up; Start-To-Close bounds a single execution and mainly serves "to detect when a Worker crashes after it has started executing an Activity Task"; Schedule-To-Close bounds the whole execution, including retries. Heartbeats are "a ping from the Worker that is executing the Activity to the Temporal Service," informing it that "the Activity Execution is making progress and the Worker has not crashed." The documentation lists Schedule-To-Start's uses (detecting a crashed worker, or a fleet that cannot keep up) but says that "in most cases, we recommend monitoring the `temporal_activity_schedule_to_start_latency` metric" instead, and notes the timeout is "non-retryable by design" ([Temporal: Detecting Activity failures](https://docs.temporal.io/encyclopedia/detecting-activity-failures)).

The distinction maps cleanly onto handoffs. Schedule-To-Start is "delivered but not picked up." Start-To-Close plus heartbeats is "picked up but stalled." These are different failures, and a single "task is old" alarm conflates them. Temporal's timers are also durable: "a Workflow can set a durable Timer for a fixed time period," timers "are persisted," and the TypeScript documentation shows racing a timer against a Signal, for example to send a reminder if nothing happens in time ([Temporal: Timers (TypeScript)](https://docs.temporal.io/develop/typescript/timers)). A reminder-then-escalate flow is therefore a native pattern there, not a cron job bolted on the side.

**AWS Step Functions.** Errors surface as named states: `States.Timeout` is reported when a Task "runs longer than the `TimeoutSeconds` value or failed to send a heartbeat for a period longer than the `HeartbeatSeconds` value," and Catch/Retry fields can route it ([Step Functions: error handling](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html)). The callback pattern is the closest analogue to a handoff: with `.waitForTaskToken`, a task pauses until an external system calls `SendTaskSuccess` or `SendTaskFailure`. The documentation warns that such a task "will wait until the execution reaches the one year service quota," and recommends `HeartbeatSeconds` "to avoid stuck executions" ([Step Functions: service integration patterns](https://docs.aws.amazon.com/step-functions/latest/dg/connect-to-resource.html)). That is nearly a description of a dropped handoff: the workflow posted a token (the announcement), and nobody ever returned it.

**Sagas.** The saga pattern describes choreography, where "each local transaction publishes domain events that trigger local transactions in other services," and orchestration, where "an orchestrator (object) tells the participants what local transactions to execute" ([microservices.io: Saga](https://microservices.io/patterns/data/saga.html)). That page does not discuss timeouts. As an inference scoped to choreographed designs: when nothing owns the overall flow, no component is positioned to notice that a published event was never consumed. Orchestrated designs have a natural owner for the deadline. For an agent fleet, this is an argument for giving a coordinator (or the task record itself) ownership of the "review must start by" clock, instead of trusting each agent to remember it.

## Code-Review Tooling: What Says "A Review Is Owed"?

The most useful comparison for this problem is how review systems represent the obligation. In each, the answer is some explicit piece of state, rather than a message that someone should read.

### GitHub

- **Requested reviewers.** Requesting a review needs write access, and the reviewer receives a notification ([GitHub: Requesting a pull request review](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/requesting-a-pull-request-review)). A review request is an object on the PR. The webhook `pull_request` event has `review_requested` ("Review by a person or team was requested for a pull request") and `review_request_removed` actions, with `requested_reviewer` and `requested_team` fields ([GitHub: webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads)).
- **Mentions are a different thing.** An @mention "will trigger a notification and bring their attention to the conversation," but "a person will only be notified about a mention if the person has read access to the repository," and for organization repositories must also be an organization member ([GitHub: writing syntax](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax)). GitHub's notification docs list `mention` and `review requested` as separate notification reasons, and a `reason:review-requested` filter exists to find PRs where someone asked for your review ([GitHub: about notifications](https://docs.github.com/en/subscriptions-and-notifications/concepts/about-notifications)). A mention in a comment is a notification. It is not, by those docs, recorded as a pending review.
- **CODEOWNERS.** "Code owners are automatically requested for review when someone opens a pull request that modifies code that they own," but "are not automatically requested to review draft pull requests"; on marking a draft ready, "code owners are automatically notified" ([GitHub: about code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)). The auto-assignment is event-driven off PR state, not off anyone's message.
- **Team routing.** Round robin and load-balance algorithms assign reviewers, and members whose status is Busy are skipped ([GitHub: team code review settings](https://docs.github.com/en/organizations/organizing-members-into-teams/managing-code-review-settings-for-your-team)).
- **Scheduled reminders.** GitHub can "send a message to your team in Slack with all open pull requests that you or your team have been asked to review." A "Require review requests" option limits the list to PRs where the team or a member was explicitly asked; there are options to ignore drafts, ignore approved PRs, and set minimum age and staleness ([GitHub: scheduled reminders](https://docs.github.com/en/organizations/organizing-members-into-teams/managing-scheduled-reminders-for-your-team)). The reminder's scope is defined by the review-request state. In a configuration with that option on, a PR whose only "request" was an @mention comment would not be listed. That is an inference from the documented option, not a statement about a default.

### Gerrit

Gerrit makes the obligation a first-class object. "Code Review is a turn-based workflow going back and forth between the change owner and reviewers," and "for every change Gerrit maintains an 'Attention Set' with users that are currently expected to act on the change." Adding reviewers adds them to the set; a reply removes the replier and adds the participants who now owe a response; uploading a new patch set alone is "not a relevant event." Service-user bots are never added. An admin-configurable job re-adds the change owner for open changes that have been inactive for a set period. The docs set an expectation for people too: "If you don't plan to respond within ~24h, then you should either remove yourself from the attention set" or tell the owner ([Gerrit: attention set](https://gerrit-review.googlesource.com/Documentation/user-attention-set.html)).

Two properties stand out. The set is driven by explicit events (reviewer added, reply posted), and it has a "Your turn" view per person, so an owed review has a place to appear. And the docs themselves caution that "these rules are not meant to be super smart and to always do the right thing" and provide manual overrides. A designer should expect to ship overrides as well.

### Prow and Tide

In Prow, reviewer selection is a plugin: blunderbuss "provides statistical means to select a subset of approvers found in OWNERS files," picks 2 reviewers per PR by default, and can skip users who marked themselves busy. The `lgtm` and `approved` labels carry review state, and "the bot retracts the label automatically if someone updates the PR with a new commit" ([Prow: reviewers and approvers](https://docs.prow.k8s.io/docs/components/plugins/approve/approvers/)). Tide "maintains a GitHub status context that indicates if each PR is in a pool or what requirements are missing" ([Prow: Tide](https://docs.prow.k8s.io/docs/components/core/tide/)). So a PR's review state is visible as labels and as a status that states what is missing. A new commit invalidating a prior approval is a documented rule worth copying: the artifact changed, so earlier review evidence no longer applies.

### Phabricator

Differential's home screen separates "Action Required" ("revisions you are the author of or a reviewer for, which you need to review, revise, or push") from "Waiting on Others." Herald rules "are often used to notify users, add reviewers, initiate audits," and Herald offers Transcripts "to review which rules did or did not trigger for a particular event (and why)" ([Differential user guide](https://github.com/phacility/phabricator/blob/master/src/docs/user/userguide/differential.diviner), [Herald user guide](https://github.com/phacility/phabricator/blob/master/src/docs/user/userguide/herald.diviner)). The Transcripts idea is the code-review equivalent of a delivery log: an after-the-fact record of whether the automation that was supposed to fire actually did.

### Comparison

| System | What records "a review is owed" | Who is on the hook | Automatic routing | Visible-to-owner surface |
|---|---|---|---|---|
| GitHub | Review request on the PR (`requested_reviewer` / `requested_team`) | Requested reviewer or team | CODEOWNERS (not for drafts), team assignment algorithms | Notification reason `review requested`; scheduled reminders |
| Gerrit | Attention set membership | Users "currently expected to act" | Reviewer-add and reply rules | "Your turn" dashboard section |
| Prow / Tide | `lgtm` / `approved` labels and Tide status context | Selected reviewers (OWNERS) | blunderbuss selects 2 by default | Status context lists missing requirements |
| Phabricator | Revision state with reviewers | Reviewers and author | Herald rules | Action Required / Waiting on Others lists |
| Free-text @mention in a comment | Nothing structured | Whoever resolves the mention | None | Notification inbox only |

The last row is the situation in the failure story. Its absence of structured state is the reason there is no timer to expire. This article does not claim any of the first four systems solves the dropped-handoff problem completely (a requested reviewer can still ignore a request), only that each stores a durable, queryable statement of who owes the next step.

## Verifying the Trigger After Posting

For automation that triggers through webhooks or notifications, the documentation shows what can and cannot be checked.

GitHub's webhook documentation sets expectations. Servers "should respond with a 2XX response within 10 seconds"; otherwise "GitHub terminates the connection and considers the delivery a failure" ([GitHub: best practices for webhooks](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)). "GitHub does not automatically redeliver failed deliveries." You can redeliver manually or through the REST API, and the documentation suggests a script that runs on a schedule, fetches deliveries attempted since its last run, checks for a `status` that is not `OK`, and redelivers failures ([GitHub: handling failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)). Deliveries are viewable for "the past 3 days," showing request headers and payload, the send time, and "the response that GitHub received from your server," and only for people with admin access to the repository ([GitHub: viewing deliveries](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/viewing-webhook-deliveries)). The REST API lists deliveries and filters by `status` (success is a code in the 200 to 399 range, failure is 400 to 599) and offers a redelivery endpoint ([GitHub REST: repository webhooks](https://docs.github.com/en/rest/repos/webhooks#list-deliveries-for-a-repository-webhook)). Redelivered requests keep the same `X-GitHub-Delivery` header, which makes duplicate detection possible.

Three limits follow, and they are exactly the ones that bite in a dropped handoff. Treating these as inference from the documented behavior:

- **A 2XX means received, not acted on.** The delivery log records the response from your server. It cannot tell you that the downstream reviewer actually started.
- **A delivery log covers deliveries that were attempted.** If no delivery was created (the event was not subscribed, a filter excluded it, or a mention never resolved to a real recipient), there is no row to find failed. The detector has to look from the other direction: "was there a start?"
- **A retention window bounds forensics.** With a 3-day view, a handoff noticed on day five has no log to inspect. Alert on the deadline, not on someone's eventual curiosity, and persist your own record.

Phabricator's Herald Transcripts show the same need from the review-tool side: automation that "did or did not trigger... (and why)" is only debuggable if a transcript was kept.

The practical pattern is read-after-write verification. After the announcement is posted, the producer (or a supervisor) checks for evidence that the trigger had its effect:

1. For a review-request trigger, the PR shows a requested reviewer, or a `review_requested` event arrived.
2. For an agent-reviewer trigger, a reviewer session or task was created and bound to this handoff.
3. For a mention-based trigger, the mention resolved to a known participant with access (per the GitHub notification condition quoted above), checked at post time.

The check is cheap, runs in seconds, and turns a common cause of dropped handoffs (malformed mention, unresolved recipient) into an immediate error instead of an hours-long silence. The deadline-based detector below then catches whatever the immediate check cannot see.

## Snoozes, Silences, and the Ways They Hide Real Problems

The failure story has a second half: an idle or reminder system already exists, and a snooze or allowlist for idle workers can hide the dropped handoff. The documentation of mature alerting products shows how each scopes suppression.

**Alertmanager.** "Silences are a straightforward way to simply mute alerts for a given time." A silence "is configured based on matchers, just like the routing tree," and matching alerts produce no notifications ([Alertmanager overview](https://prometheus.io/docs/alerting/latest/alertmanager/)). In the v2 OpenAPI schema, a silence requires `matchers`, `startsAt`, `endsAt`, `createdBy`, and `comment` ([Alertmanager OpenAPI](https://github.com/prometheus/alertmanager/blob/main/api/v2/openapi.yaml)). In other words, a silence is scoped by label matchers, must have an end time, and records who set it and why. Inhibition "suppress[es] notifications for certain alerts if certain other alerts are already firing," and the configuration reference notes that "a missing label and a label with an empty value are the same thing," so if the labels named in `equal` are missing from both alerts, "the inhibition rule will apply." The docs advise choosing matchers so that alerts never match both sides of a rule ([Alertmanager configuration](https://prometheus.io/docs/alerting/latest/configuration/)). An inhibition keyed on labels that happen to be absent is a documented way for a broad rule to suppress more than intended.

**PagerDuty.** Snooze lets responders "prevent an acknowledged incident from escalating while they are working on the issue." It is "only available for acknowledged incidents"; options run from 1 hour to a maximum of 168 hours; when the snooze expires and the incident is unresolved, it "returns to a triggered state and notifies you again"; reassigning the incident "cancels the snooze timer"; and "the incident log captures all snooze actions" ([PagerDuty: edit incidents](https://docs.pagerduty.com/incident-management/incidents/edit-incidents)). Separately, event-orchestration suppression stores alerts "for forensics, analysis, and context" but does not create incidents, filters them out of the incidents dashboard by default, and they are not visible in the mobile app ([PagerDuty: event management](https://docs.pagerduty.com/incident-management/incidents/event-management)).

Compare how those two products scope their suppressions to what would hide a dropped handoff in an agent fleet:

| Scoping choice | Examples in the docs | Risk when applied to handoffs (inference) |
|---|---|---|
| Scoped to a **specific incident that someone has acknowledged** | PagerDuty snooze | Safe: it hides a problem a human has taken ownership of. A dropped handoff has no acknowledger by definition, so this scope cannot apply to it |
| Scoped to a **label set with a mandatory end time and a recorded author and reason** | Alertmanager silence | Reasonable, provided the label identifies the cause or the specific object rather than a whole class |
| Scoped to **a person or worker's state** ("this worker is idle, so stay quiet") | Not drawn from a documented product feature; the situation under discussion | Dangerous: worker state is orthogonal to whether work is owed to that worker. The reviewer being "snoozed as idle" is exactly the condition under which a handoff to that reviewer vanishes |
| **Inhibition by presence of another alert** | Alertmanager inhibit rules | A broad `source` alert can mute every dependent alert, including ones about different objects, if the `equal` labels do not separate them |
| **Permanent suppression or allowlist** | Event suppression with no expiry | Hides the failure indefinitely; the stored data may exist but nobody looks at it |

Design principles that follow, scoped as recommendations for systems that combine idle reminders with handoff tracking:

- **Scope a snooze to a cause, not a person.** "Reviewer X is idle, do not nudge X" is a statement about X. "Handoff H is known to be waiting on an external dependency until Friday" is a statement about H. Only the second should suppress an alert about H.
- **Keep alert classes separate.** An idle-worker reminder answers "is this worker doing nothing?" An owed-handoff alert answers "is something owed that nobody has started?" A worker's snooze or allowlist should be able to mute the first and never the second. A snoozed worker with an overdue handoff should still produce an alert, addressed to the producer or a supervisor.
- **Make every suppression expire and carry a reason.** Alertmanager makes `endsAt`, `createdBy`, and `comment` mandatory. PagerDuty caps snooze at a week. Neither lets an open-ended mute exist silently.
- **Report suppressed counts.** PagerDuty's suppressed alerts are retained but hidden by default. A periodic digest ("12 handoffs older than the deadline were suppressed by snooze rules") keeps the suppression itself observable.

## Design Recommendations for Agent Fleets

These recommendations are inference built on the mechanisms above, for fleets of agents that exchange work through a task board.

### 1. Model the handoff as an explicit state, with an owner and a deadline

Create a handoff record at announcement time, not after the fact:

```
handoff {
  id, task_id, artifact_ref (PR number + head commit),
  from_agent, to_role / to_agent (the owner of the next step),
  state: delivered | started | completed | cancelled,
  delivered_at, started_at, ack_deadline, reminder_at,
  trigger_evidence: { kind, ref }
}
```

This is the same move Gerrit makes with the attention set and Pub/Sub makes with the ack deadline: the obligation is data, and the deadline travels with it. It is also what makes a per-entity "never started" query possible, in contrast with the series-existence semantics of `absent()`. `artifact_ref` should include the commit, because Prow's retracted `lgtm` and Gerrit's treatment of outdated votes both encode the same rule: a new head commit changes what was reviewed, so the earlier evidence no longer applies, while Gerrit separately notes that merely uploading a patch set is not a relevant event for the attention set. Choose deliberately which behavior fits your fleet.

### 2. Detect "delivery without a following review start"

The core query is simple: handoffs in state `delivered` where `now > ack_deadline` and there is no start evidence. Define start evidence as an explicit event: a requested reviewer appears, a reviewer agent session opens bound to the handoff, or the reviewer posts any comment against the artifact commit. Follow Temporal's split of timeouts:

- **Delivered, not started** (Schedule-To-Start): the trigger failed or the reviewer is unavailable. Short deadline.
- **Started, no progress** (Start-To-Close plus heartbeat): the reviewer began and stalled. Longer deadline, refreshed by heartbeats like Pub/Sub lease extension.
- **Overall budget** (Schedule-To-Close): a hard upper bound for the whole handoff, after which a human is told.

Treat the first two as different alerts with different remedies. Temporal's own documentation recommends watching a latency metric more often than setting a hard Schedule-To-Start timeout; the same fits here: always alert on latency, and only apply auto-actions after the reminder step below.

### 3. Verify the trigger right after posting

Add the read-after-write check described earlier: confirm that the mention resolved to a participant with access, or that a review request or reviewer session now exists. If it does not, retry once through a different path (an explicit review request instead of a comment mention, for example) and record `trigger_evidence`. Make the retry idempotent, reusing the original delivery identifier in the way GitHub keeps `X-GitHub-Delivery` stable across redeliveries.

### 4. Reminder before auto-action

Use a ladder rather than a single alarm:

1. At `ack_deadline`: re-trigger through the alternate path, and message the owner with a precise statement ("handoff H, artifact at commit C, delivered 40 minutes ago, no start").
2. At a second threshold: remind the owner's supervisor or the producer, and surface the handoff in a "your turn" view like Gerrit's.
3. At the overall budget: escalate to a human, or perform a pre-approved automatic action such as reassigning to another reviewer.

Automatic reassignment should come last and should be recorded, like PagerDuty's incident log capturing "all snooze actions." GitHub's own team-routing options (round robin, load balance, skipping Busy members) are an example of a reassignment policy that is explicit and configurable.

### 5. Avoid false positives

A detector that cries wolf will be snoozed, and the snooze is the problem. Build exclusions from documented review-system semantics:

| Condition | Why it should not alert | Source of the semantics |
|---|---|---|
| Draft PR | Owners are not requested on drafts; review is not expected yet | GitHub CODEOWNERS docs; reminders can ignore drafts |
| Reviewer session already running | Start evidence exists; switch to the heartbeat clock | Temporal heartbeats, Pub/Sub lease extension |
| Review request removed or handoff cancelled | The obligation no longer exists | GitHub `review_request_removed` action |
| Artifact superseded by a newer commit | Old handoff is obsolete; the new commit spawns its own | `synchronize` event; Prow `lgtm` retraction |
| Draft marked ready, or PR converted back to draft | Restart or pause the clock rather than counting elapsed time | `ready_for_review` / `converted_to_draft` actions |
| Handoff younger than a minimum age | Normal latency | GitHub reminders' minimum age and staleness options |
| Explicit, cause-scoped, expiring hold on this handoff | A human or coordinator already owns it | PagerDuty snooze on acknowledged incidents |

Use `for:`-style persistence on the detector itself: require the condition to hold across several consecutive evaluations before firing, as Prometheus does with `for:`, and consider `keep_firing_for`-style hysteresis so a brief reviewer start does not flap the alert.

### 6. Evaluate with a known dropped handoff (positive control)

A detector that has never fired has not been shown to work. Healthchecks.io-style monitoring and the Watchdog alert both rely on the same insight: a component that should always produce a signal gives you a way to detect its own silence.

- **Inject a canary.** On a schedule, create a synthetic task in a sandbox project and post a "done" announcement with a deliberately malformed mention, or with the trigger blocked. The expectation is that the detector fires within a known time. Record the detection latency.
- **Alert on the canary's silence.** If an injected dropped handoff does not produce an alert by its deadline, page someone, as a Watchdog-style dead-man's switch for the detector.
- **Run negative controls.** Inject a draft PR, a handoff to a reviewer already running, and a cancelled handoff. None should alert. These measure false positives.
- **Include the snooze path.** Run the canary while the target reviewer is snoozed or on an allowlist. This directly tests the failure from the opening story; an owed-handoff alert should still fire.
- **Track outcomes.** Report recall on injected faults, median and maximum detection latency, and false-positive rate over a window. Keep them with the handoff records so changes to rules can be compared.

## Limitations

- This article reports what primary documentation says about each system. It does not evaluate how well each performs in production, and it does not claim that any listed product has or lacks features beyond what the cited pages state. Where a page did not mention a feature, this article says nothing about it.
- The design recommendations are inferences, not established standards. Detection thresholds, escalation timings, and canary cadences depend on fleet size and how quickly reviews are expected.
- GitHub documentation retention windows and defaults (for example, the 3-day delivery view, the 10-second response window) and product limits (for example, PagerDuty's 168-hour snooze maximum) reflect the pages as read on 2026-11-14 and can change.
- Not covered: reviewer-side failure modes (a reviewer that starts and posts a low-effort approval), and the economics of review latency.

## References

- [Google SRE Book: Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/)
- [Prometheus: Alerting practices](https://prometheus.io/docs/practices/alerting/)
- [Prometheus: Query functions (`absent`, `absent_over_time`)](https://prometheus.io/docs/prometheus/latest/querying/functions/)
- [Prometheus: Alerting rules (`for`, `keep_firing_for`)](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/)
- [Prometheus Operator runbook: Watchdog](https://runbooks.prometheus-operator.dev/runbooks/general/watchdog/)
- [Prometheus Alertmanager: Overview (inhibition and silences)](https://prometheus.io/docs/alerting/latest/alertmanager/)
- [Prometheus Alertmanager: Configuration (`inhibit_rule`)](https://prometheus.io/docs/alerting/latest/configuration/)
- [Prometheus Alertmanager: API v2 OpenAPI specification (silence schema)](https://github.com/prometheus/alertmanager/blob/main/api/v2/openapi.yaml)
- [Healthchecks.io documentation](https://healthchecks.io/docs/)
- [Cronitor: Heartbeat monitoring](https://cronitor.io/docs/heartbeat-monitoring)
- [Google Cloud Pub/Sub: Lease management and acknowledgement deadlines](https://docs.cloud.google.com/pubsub/docs/lease-management)
- [Google Cloud Pub/Sub: Dead-letter topics](https://docs.cloud.google.com/pubsub/docs/handling-failures)
- [Amazon SQS: Visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)
- [Amazon SQS: Dead-letter queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)
- [Temporal: Activity timeouts and heartbeats](https://docs.temporal.io/encyclopedia/detecting-activity-failures)
- [Temporal: Durable Timers (TypeScript SDK)](https://docs.temporal.io/develop/typescript/timers)
- [AWS Step Functions: Handling errors](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html)
- [AWS Step Functions: Service integration patterns (callback with task token)](https://docs.aws.amazon.com/step-functions/latest/dg/connect-to-resource.html)
- [microservices.io: Saga pattern](https://microservices.io/patterns/data/saga.html)
- [GitHub Docs: Requesting a pull request review](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/requesting-a-pull-request-review)
- [GitHub Docs: About code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)
- [GitHub Docs: Managing code review settings for your team](https://docs.github.com/en/organizations/organizing-members-into-teams/managing-code-review-settings-for-your-team)
- [GitHub Docs: Managing scheduled reminders for your team](https://docs.github.com/en/organizations/organizing-members-into-teams/managing-scheduled-reminders-for-your-team)
- [GitHub Docs: Basic writing and formatting syntax (mentions)](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax)
- [GitHub Docs: About notifications](https://docs.github.com/en/subscriptions-and-notifications/concepts/about-notifications)
- [GitHub Docs: Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
- [GitHub Docs: Best practices for using webhooks](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)
- [GitHub Docs: Handling failed webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)
- [GitHub Docs: Viewing webhook deliveries](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/viewing-webhook-deliveries)
- [GitHub REST API: Repository webhooks (list and redeliver deliveries)](https://docs.github.com/en/rest/repos/webhooks#list-deliveries-for-a-repository-webhook)
- [Gerrit Code Review: Attention Set](https://gerrit-review.googlesource.com/Documentation/user-attention-set.html)
- [Prow: Tide](https://docs.prow.k8s.io/docs/components/core/tide/)
- [Prow: Reviewers and approvers (blunderbuss, lgtm)](https://docs.prow.k8s.io/docs/components/plugins/approve/approvers/)
- [Phabricator: Differential user guide](https://github.com/phacility/phabricator/blob/master/src/docs/user/userguide/differential.diviner)
- [Phabricator: Herald user guide](https://github.com/phacility/phabricator/blob/master/src/docs/user/userguide/herald.diviner)
- [PagerDuty: Edit incidents (snooze)](https://docs.pagerduty.com/incident-management/incidents/edit-incidents)
- [PagerDuty: Event management (alert suppression)](https://docs.pagerduty.com/incident-management/incidents/event-management)
