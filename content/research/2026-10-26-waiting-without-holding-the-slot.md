---
date: "2026-10-26"
time: "09:00"
title: "Waiting Without Holding the Slot: Human-Decision Waits, Head-of-Line Blocking and Suspend/Resume in Single-Slot Agent Runners"
description: "Why an agent that waits for a human inside a running task starves everything queued behind it, how job queues, workflow engines and agent frameworks release the slot instead, and a park-and-release design with checklists for platforms and agents."
tags: ["research", "agents", "task-queues", "human-in-the-loop", "workflow-engines", "reliability"]
---

## Executive Summary

An AI coding agent runs on a task platform with exactly one execution slot. Midway through a task it reaches a point that needs a human decision. It posts a comment saying the work is "still active, waiting for the owner's decision" and leaves the run open. The owner is asleep and will be for hours.

Meanwhile, every other task for that agent is queued behind the open run. That includes an unrelated task on the critical path of an integration, and a message from the coordinator saying "wrap up and hand over." New messages arrive as new queued runs, and a queued run cannot start until the current one ends. So the agent cannot receive the message that would tell it to stop waiting. The coordinator's only options are to wait or to cancel another agent's live run, which is hard to reverse and may destroy partial work.

This is classic head-of-line blocking, and the cause is a category error. The platform and the agent both treated "this issue is not finished" as the same fact as "this run is not finished." The issue can be unfinished for hours. The run, which consumes the only slot, should end within minutes of discovering it can make no further progress.

Mature job systems solved this long ago. Airflow's reschedule mode and deferrable operators release the worker slot between checks. AWS Step Functions pauses a workflow on a task token without holding compute. Temporal sleeps and waits for signals durably. LangGraph and the OpenAI Agents SDK persist state at an interrupt and resume later. The common move is the same: persist what is needed to continue, end the occupying process, and resume from a new trigger.

This article collects what the primary documentation says, then proposes a park-and-release design for single-slot agent runners. It adds an out-of-band control channel, priority lanes, timeouts with escalation, and a blocking question written with a predicted default. The park-and-release design and the control-channel ideas are proposals synthesized from these systems. No source below documents them as a package for agent task platforms.

## The Failure Mode, Stated Precisely

[Head-of-line blocking](https://en.wikipedia.org/wiki/Head-of-line_blocking) is a general queueing phenomenon: the item at the front of a line stalls everything behind it. In networking it is a packet; here it is a run.

Three properties combine to make the scenario unusually damaging:

1. **One slot.** With N slots, one stalled run costs 1/N of capacity. With one slot it costs all of it.
2. **Messages are queued runs.** The coordinator's wrap-up note is not delivered into the open run. It waits for its own turn, which will not come until the blocker ends. The control signal is stuck in the same queue as the work it is meant to control.
3. **The waiter is the only party who can unblock the queue, and it is waiting on someone who is offline.** Nothing inside the system can progress. The wait is bounded only by a human's sleep schedule.

Note that the agent behaved reasonably by a local standard. It did not guess at a consequential decision, and it said so honestly. The defect is structural: the platform gave it no cheap way to wait without occupying the slot, so the "safe" behavior became the most disruptive one.

## What Job Systems Say About Waiting Inside a Running Job

### Worker pools: waiting wastes the slot

Celery's task documentation says that [having a task wait for the result of another task is "really inefficient"](https://docs.celeryq.dev/en/stable/userguide/tasks.html) and "may even cause a deadlock if the worker pool is exhausted." It recommends an asynchronous design with callbacks or chains. The same page warns that a task that blocks indefinitely may eventually stop the worker from doing any other work. A single-slot runner is a worker pool of size one, where exhaustion is immediate.

Sidekiq's [best-practices page](https://github.com/sidekiq/sidekiq/wiki/Best-Practices) is relevant for a different reason. It says Sidekiq executes a job "at least once, not exactly once," and that even a completed job can be re-run, so jobs must be idempotent. It also advises passing simple identifiers rather than saving state in the job and looking up current data when the job runs. Both points matter for resume: a parked task will be resumed against a world that has changed.

### Airflow: poke versus reschedule is the cleanest illustration

Airflow's [sensor documentation](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/sensors.html) describes two modes for a task that waits for a condition. In the default `poke` mode, a sensor "takes up a worker slot for its entire runtime." In `reschedule` mode it takes a worker slot "only when it is checking," and between checks the task is rescheduled after the `poke_interval`. The docs name the trade-off as latency: poke suits fast, frequent checks; reschedule suits slower ones.

Airflow goes further with [deferrable operators](https://airflow.apache.org/docs/apache-airflow/stable/authoring-and-scheduling/deferring.html). Standard operators and sensors "take up a full worker slot for the entire time they are running, even if they are idle." When an operator defers, execution moves to a separate triggerer process, the task no longer occupies a worker slot, and by default deferred tasks do not occupy pool slots either. The deployment needs a triggerer running next to the scheduler. The lesson for agent platforms is that releasing the slot needs a second component that holds the waiting state cheaply and fires the resume.

### Step Functions: the callback pattern

AWS Step Functions' [callback pattern](https://docs.aws.amazon.com/step-functions/latest/dg/connect-to-resource.html) is designed for exactly the human case. The docs say a task "might need to wait for a human approval" and that Step Functions can pause until the execution hits its one-year quota while waiting for an external process. The task receives a token (`.waitForTaskToken`), hands it to an outside system, and resumes only when that system calls `SendTaskSuccess` or `SendTaskFailure` with the token. To avoid stuck executions, the docs recommend `HeartbeatSeconds`; if no valid token or heartbeat arrives in that window, the task fails with `States.Timeout`. Two details are worth borrowing: the resume trigger is a correlation token, not "whichever message comes next", and every wait has an explicit timeout path.

### Temporal: durable waits are first-class

Temporal's [workflow documentation](https://docs.temporal.io/workflows) says workflows can run for years even if infrastructure fails, and are recovered by replaying event history: the code runs from the beginning, replays history step by step, and "Activities aren't executed again during replay." The [timers documentation](https://docs.temporal.io/develop/python/timers) says a workflow can sleep for months and that sleeping is "resource-light": it does not tie up the process, and a single worker can run millions of timers. [Signals](https://docs.temporal.io/encyclopedia/workflow-message-passing) are asynchronous write requests, and signal senders do not depend on the worker being available.

For long human reviews inside an activity, the [activity docs](https://docs.temporal.io/activity-execution) describe asynchronous completion: an activity function can return without completing the activity, and an external client completes it later. They also note that a signal-based approach can use a shorter timeout so failed notifications retry sooner than a one-week activity timeout would allow. Again the shape is the same: the thing that waits is a lightweight record, not a busy worker.

### GitHub Actions: approvals as gates

GitHub's [environment documentation](https://docs.github.com/en/actions/deployment/targeting-different-environments/managing-environments-for-deployment) lets you configure required reviewers (up to six people or teams, any one of whom can approve) and a wait timer, and the [reviewing deployments page](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/reviewing-deployments) says rejecting a job fails the workflow. These pages do not say how long a job may wait or whether it consumes a runner, so this article makes no claim about that. The design point is that approval is a first-class gate with a named approver set, not something a running job improvises.

## What Agent Frameworks Say About Human Interrupts

### LangGraph

LangGraph's [interrupts documentation](https://docs.langchain.com/oss/python/langgraph/interrupts) says `interrupt()` can be called at any point in a graph node and accepts a JSON-serializable value that is surfaced to the caller. A checkpointer is required to persist graph state (a durable one in production). The `thread_id` is "effectively your persistent cursor" and the same ID must be used to resume. After saving state, the graph "waits indefinitely until you resume execution," and the caller resumes by invoking it again with `Command(resume=...)`, whose value becomes the return value of `interrupt()`.

One caveat deserves emphasis. The docs state that on resume "the runtime restarts the entire node from the beginning," not from the line of the `interrupt()` call, so "any code that ran before the interrupt will execute again" and side effects before an interrupt should be idempotent. That is the resume-correctness requirement in one sentence.

### OpenAI Agents SDK

The Agents SDK's [human-in-the-loop guide](https://openai.github.io/openai-agents-python/human_in_the_loop/) describes tools marked `needs_approval`. When a call needs approval and has no stored decision, execution pauses and the pending approvals come back as interruption items. You convert the result with `result.to_state()`, approve or reject each item, and pass the state back to the runner, which "continues where it left off." State can be serialized with `to_json()` or `to_string()` and stored in a database or queue. The guide advises storing a version marker if approvals may sit for a while, so changes to models, prompts or tools do not break deserialization. It also says to deserialize only from trusted storage and to verify each reviewer's identity before applying a decision. It states no maximum pause duration.

### What the two have in common

Both frameworks pause at the decision point with a serialized record, and resumption is a new invocation carrying the human's answer. A coding agent run inside a CLI session has no such built-in facility unless the platform builds one, so the pattern has to live in the task platform and in the agent's own discipline.

## Pattern Comparison

| System | What waits | Slot held while waiting? | Resume trigger | Timeout story |
|---|---|---|---|---|
| Airflow poke sensor | Running task | Yes, whole runtime | Condition becomes true | Sensor timeout |
| Airflow reschedule / deferrable | Task record / trigger | No (reschedule: only while checking; deferred: no worker or pool slot by default) | Next poke or trigger event | Sensor or trigger timeout |
| Step Functions `.waitForTaskToken` | Execution state | No compute held for the wait | `SendTaskSuccess` / `SendTaskFailure` with token | `HeartbeatSeconds`, one-year quota |
| Temporal timer / signal | Workflow event history | Resource-light, no process tied up | Timer fires or signal arrives | Explicit timers and activity timeouts |
| LangGraph interrupt | Checkpointed state | Not specified as a slot; state persisted | `Command(resume=...)` on same `thread_id` | None by default ("waits indefinitely") |
| OpenAI Agents SDK | Serialized `RunState` | Not held; state stored by the caller | Pass approved state back to runner | None stated |
| Single-slot agent, "still ACTIVE" | The run itself | Yes, the only slot | Human replies, if the message can even be delivered | None |

Several systems that release the slot still leave the wait unbounded (LangGraph, by its docs). Releasing the slot fixes starvation. It does not by itself fix a forgotten decision, so timeouts and escalation are a separate piece.

## Design Patterns for Single-Slot Agent Runners

### 1. Separate "issue not done" from "run done"

Keep two state machines. The work item (issue) has states such as `in_progress`, `blocked_on_human`, `done`. The run has states such as `queued`, `running`, `parked`, `finished`. A run that discovers a blocker should finish with outcome `parked` while the issue stays open and flips to `blocked_on_human`. The slot frees when the run finishes, not when the issue does.

### 2. Park and release

Before ending, the agent writes down everything a later run needs:

- Work done so far and where it lives (branch name, commit hash, uncommitted changes saved to a patch or WIP commit).
- What remains, in order.
- The blocking question, who should answer it, and what the answer changes.
- The predicted default and what happens if no answer arrives (see below).
- A resume token or correlation key.

Then the run ends with a status that says what it is waiting for. A later run, triggered by the human's reply or by a timeout, reads that record and continues. This is the same shape as a Step Functions token, a LangGraph checkpoint, or a serialized `RunState`, just implemented at the task level.

### 3. Make the question explicit, with a predicted default

A good blocking question is answerable in one line from a phone. It states the options, the agent's recommendation, and what will happen if nobody answers by a deadline:

```text
BLOCKED_ON: owner
QUESTION:   Keep the legacy endpoint during the migration, or remove it now?
OPTIONS:    A) keep for one release (recommended)  B) remove now
DEFAULT:    A, applied automatically at 2026-10-26T14:00Z if no reply
AFFECTS:    API compatibility only; reversible by a later commit
RESUME:     run <task-id> with reply text; continue from branch wip/<x>
```

The default turns a silent stall into a scheduled decision. It also tells the reader how much the question matters: a reversible default with a deadline is a prompt for the reader, not a stop sign. Not every question has a safe default. Irreversible or security-relevant choices should park with no default and escalate instead.

### 4. Out-of-band control channel

The coordinator's wrap-up message failed because control traffic used the same queue as work. A control channel separate from the work queue can carry messages such as "pause", "wrap up", "reprioritize", or "release your slot." In Temporal's vocabulary, the closest analogue is a signal to a running workflow, which does not depend on the worker being available. For a single-slot runner there are two workable designs:

- **Deliver into the live run.** Control messages are injected into the running agent's context between steps, so a waiting agent sees "release now" within seconds. This only works if the agent actually checks, which brings in the agent-side checklist below.
- **Platform-level run states.** The platform lets the coordinator mark a run `park_requested`, and the runner enforces it (for instance by sending the agent a mandatory prompt: "Save state and end the run"). This is a softer, reversible alternative to cancelling.

Either way, the coordinator should have a lever between "wait" and "cancel another agent's live run."

### 5. Priority lanes and preemption

A critical-path task should not queue behind a run that is merely waiting. Two options:

- **Priority lane.** Tasks tagged critical are dispatched ahead of ordinary ones. This does not help if the slot is already occupied by a blocked run, so it needs to be combined with the next point.
- **Preemption of waiting runs only.** Allow the platform to park a run that has been idle or in a declared waiting state longer than a threshold. Parking is non-destructive when the agent has saved state; cancelling an actively working run is not. The distinction between waiting and working should be explicit in the run status rather than inferred.

These are proposals; the sources above show queue-slot release, not agent preemption policy.

### 6. Timeouts with escalation

Every park carries a deadline and an escalation chain, as Step Functions' heartbeat and Airflow's sensor timeouts do for machines:

1. T+0: post the question to the human's primary channel.
2. T+N: re-ask via a second channel and notify a delegate.
3. T+M: apply the predicted default if one exists and is safe, or mark the issue `stalled` and tell the coordinator.

## Trade-offs

**Context loss versus slot starvation.** Releasing the slot means the next run starts without the previous run's working memory. The cost is real: re-reading files, re-deriving why a choice was made. Mitigations are a written handoff record, a WIP commit, and keeping the park record short enough to read first. The cost of holding the slot is paid by everyone else in the queue, and it grows with the wait.

**Idempotent resume.** Resume can re-run earlier steps. LangGraph says plainly that code before the interrupt runs again; Sidekiq says jobs may run more than once. A resumed agent run must check before acting: does the branch already exist, was the comment already posted, was the migration already applied? Prefer "ensure" operations over "do" operations.

**Stale premises.** Hours later, the repository, the task priorities or the question itself may have changed. A resume step should re-validate the premise before applying the human's answer. The Agents SDK's advice to store a version marker is the serialization-level cousin of this.

**When holding is acceptable.** Airflow's docs frame poke versus reschedule as a latency trade-off, not a rule. Holding is reasonable when the wait is short relative to the cost of a cold restart, the answer is expected within minutes, the queue behind the slot is empty or all of it is low priority, and the control channel can still reach the run. A reasonable starting threshold is a few minutes, or any wait on a human whose availability is unknown. If the wait outlasts the threshold, park.

## Checklist for Agent Task Platforms

- [ ] Model "run outcome" and "issue state" separately; allow a run to end as `parked` while the issue stays open.
- [ ] Provide a standard `blocked_on` field (who, question, default, deadline) that is visible to coordinators.
- [ ] Resume by new trigger (reply, timer, token), with a correlation key tying the reply to the parked work.
- [ ] Give coordinators an out-of-band control path that does not queue behind work, plus a non-destructive "request park" action short of cancel.
- [ ] Distinguish waiting from working in run status; show how long a run has been waiting.
- [ ] Apply a maximum wait for a run in waiting status; auto-park or alert when exceeded.
- [ ] Support priority lanes for critical-path tasks, with a defined rule for what they may preempt.
- [ ] Attach deadlines and escalation steps to every human gate; record who was notified and when.
- [ ] Verify the identity of whoever resolves a gate (the Agents SDK guide warns serialized state is unauthenticated), and log every park, resume and auto-default.

## Checklist for Agents

- [ ] Before waiting on a human, ask whether the wait could exceed a few minutes or the human's availability is unknown. If yes, park instead of holding.
- [ ] Save state first: commit or patch work in progress, record the branch and the remaining steps.
- [ ] Write the question so it is answerable in one line, with options, a recommendation and a default with a deadline.
- [ ] Keep the issue open and set it to blocked, but end the run. Do not post "still active, waiting" and keep the run open.
- [ ] Continue with unblocked work first. Only park when nothing useful remains.
- [ ] While holding for a short wait, check for coordinator messages at each step and honor wrap-up requests at once.
- [ ] On resume, re-read the park record, re-validate the premise, and use ensure-style operations that are safe to repeat.
- [ ] Never guess at an irreversible decision to avoid parking; park and escalate.

## Conclusion

The mistake in the opening scenario was to let a pending decision appear as a running job. Every system surveyed here separates the two: the waiting state is a durable record plus a trigger, and the compute is free for other work. For single-slot agent runners the fix needs three parts working together. The agent has to park cleanly with a good question and a default. The platform has to treat parked as a normal outcome and give coordinators a gentle lever. And the control path has to be independent of the queue it controls. With those in place, a sleeping human delays one decision instead of everything behind it.

## Sources

- Head-of-line blocking (general definition): https://en.wikipedia.org/wiki/Head-of-line_blocking
- Apache Airflow, Sensors (poke and reschedule modes): https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/sensors.html
- Apache Airflow, Deferrable Operators and Triggers: https://airflow.apache.org/docs/apache-airflow/stable/authoring-and-scheduling/deferring.html
- AWS Step Functions, service integration patterns (callback with task token, heartbeat): https://docs.aws.amazon.com/step-functions/latest/dg/connect-to-resource.html
- Temporal, Workflows: https://docs.temporal.io/workflows
- Temporal, Python timers: https://docs.temporal.io/develop/python/timers
- Temporal, Workflow message passing (signals): https://docs.temporal.io/encyclopedia/workflow-message-passing
- Temporal, Activity Execution (timeouts, asynchronous completion): https://docs.temporal.io/activity-execution
- Celery, Tasks (avoid launching synchronous subtasks): https://docs.celeryq.dev/en/stable/userguide/tasks.html
- Sidekiq, Best Practices (idempotency): https://github.com/sidekiq/sidekiq/wiki/Best-Practices
- GitHub Docs, Managing environments for deployment: https://docs.github.com/en/actions/deployment/targeting-different-environments/managing-environments-for-deployment
- GitHub Docs, Reviewing deployments: https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/reviewing-deployments
- LangGraph, Interrupts: https://docs.langchain.com/oss/python/langgraph/interrupts
- OpenAI Agents SDK, Human-in-the-loop: https://openai.github.io/openai-agents-python/human_in_the_loop/
