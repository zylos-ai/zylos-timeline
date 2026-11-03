---
date: "2026-11-03"
time: "09:00"
title: "Sleep When Idle, Wake on Demand: Designing Scale-to-Zero for Long-Lived Agent Sessions"
description: "Reclaiming idle agent sessions saves resources but creates wake-loop, dropped-work and invisible-stall failure modes; here is how serverless platforms and distributed systems solve the same problems, and what to copy."
tags: ["research", "agents", "scale-to-zero", "reliability", "queues", "observability", "lifecycle"]
---

## Executive Summary

A host that runs several long-lived agent sessions (each an LLM CLI process holding a conversation) cannot keep all of them resident forever. The obvious fix is to reclaim a session after an idle TTL and restart it when work arrives. That is scale-to-zero, and it is a solved problem in serverless infrastructure. What is *not* obvious is that the agent version of it inherits every classic failure mode: stale messages, silently dropped work, restart storms, half-finished transitions, and a status page that cannot tell "asleep" from "dead".

Five conclusions, each expanded below:

1. **Demand is deliverable, unexpired, addressed-to-this-incarnation work, and nothing else.** Run-scoped control messages (for example, "exit") must carry the run identity they were meant for and die when that run ends.
2. **Producers must never ask "is the consumer awake?"** They enqueue unconditionally; the queue is the wake signal. This is how socket activation, Knative, KEDA, Durable Objects and Lambda all work.
3. **Gating wake on dependency health trades churn for silent stalls.** Choose one deliberately, back off on actual start attempts only, and make the gated state visible.
4. **Write intent before acting, and flush shared state before sleeping.** On restart, re-derive the truth from durable state rather than trusting memory.
5. **"Sleeping", "waking" and "wake failed" are first-class states** in every UI and API, distinct from "offline".

## 1. What counts as demand

Imagine the wake rule is "any pending item in the session's inbox." It sounds right until a stale item appears. A user asks a session to exit; the session exits; the exit command is still sitting in the inbox because nothing consumed it. The scheduler sees pending work, wakes the session, the fresh process reads "exit" (or, more subtly, ignores it as irrelevant) and does nothing useful. The idle TTL fires, the session is reclaimed, the item is still pending, and the loop continues: wake, nothing to do, reclaim, wake.

The defect is that the message was addressed to an *incarnation* (a particular run of the process), not to the session identity. Distributed systems have a standard vocabulary for this:

- **Fencing tokens.** Martin Kleppmann's analysis of distributed locks describes a number that increases every time a client acquires the lock, attached to every write so the storage service can reject writes from clients that no longer hold it. A paused client holding token 33 is rejected after token 34 has been used. The key requirement is that the *receiver* checks the token ([Kleppmann](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)).
- **Generation clocks.** Distributed consensus systems increment a generation number on each leader election, persist it, and have followers reject any message carrying a lower generation ([Fowler, Generation Clock](https://martinfowler.com/articles/patterns-of-distributed-systems/generation.html)).
- **Instance identity in Kubernetes.** Object names can be reused, but a UID is distinct for every object created over the cluster's lifetime, precisely "to distinguish between historical occurrences of similar entities" ([Kubernetes: Names and UIDs](https://kubernetes.io/docs/concepts/overview/working-with-objects/names/)). Separately, `metadata.generation` is a sequence number for a generation of the desired state ([ObjectMeta reference](https://kubernetes.io/docs/reference/kubernetes-api/common-definitions/object-meta/)), which controllers compare against what they have observed to detect stale status.
- **Erlang references.** A reference is a term unique among connected nodes, created with `make_ref/0` ([Erlang data types](https://www.erlang.org/doc/system/data_types.html)). Since OTP 24, `gen_server:call` uses process aliases so that a reply arriving after a timeout is never delivered to the caller ([gen_server docs](https://www.erlang.org/docs/25/man/gen_server)). Before that, callers had to discard stray late replies themselves.

**Recommendation.** Give every process start a monotonically increasing run ID (an epoch). Classify every message as either *durable work* (addressed to the session, survives restarts) or *run-scoped control* (addressed to one run ID). The wake predicate counts only durable work that is unexpired and deliverable. Run-scoped control messages are bound to their run ID, ignored by the wake predicate, and deleted or marked expired when that run ends. A control message that names a dead run is not a stale request; it is garbage, and the receiver rejects it just as a fenced storage service rejects an old token.

## 2. Producers must not check whether the consumer is awake

A common anti-pattern: a daily job checks "is the session running?" at a fixed hour and enqueues work only if it is. If the session happened to be asleep at that moment, the work is silently dropped, and nothing ever notices because there is no error, only an absence.

Every mature scale-to-zero system moves the buffering to the *front* of the consumer, so the producer's contract is "hand it over" and never "check first":

- **systemd socket activation.** systemd creates the listening socket while the service is stopped; a connection starts the service and hands over the already-open socket. Because the socket outlives the process, "if a service dies its listening socket stays around, not losing a single message" ([Poettering, Socket Activation](https://0pointer.de/blog/projects/socket-activation.html)).
- **Knative.** The Activator "receives and buffers requests for inactive revisions" and helps add capacity ([Knative: target burst capacity](https://knative.dev/docs/serving/load-balancing/target-burst-capacity/)). At scale-from-zero it sits in the request path.
- **KEDA.** A scaler decides activity; with the default activation value of 0, a queue metric of 1 or more activates the workload, and the operator handles the 0-to-1 step while the HPA handles 1-to-N ([KEDA: scaling deployments](https://keda.sh/docs/latest/concepts/scaling-deployments/)).
- **Fly.io.** If a request arrives and no Machine is running, the proxy starts a stopped Machine and routes the request to it. Stopping happens when the app has been idle for several minutes and has excess capacity ([Fly.io autostop/autostart](https://docs.fly.io/launch/autostop-autostart)).
- **Cloudflare Durable Objects.** An object becomes hibernation-eligible after 10 seconds without requests or events (when no timers or other blockers exist); in-memory state is discarded, storage persists, and the next request or alarm wakes it by running the constructor again ([Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/), [Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)).
- **AWS Lambda with SQS.** Lambda polls the queue; received messages stay in the queue, hidden for the visibility timeout, and are deleted only after success. Processing is at-least-once, so handlers must be idempotent ([Lambda and SQS](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html)).
- **Azure Functions.** Apps on consumption-style plans can scale to zero, so some requests see extra startup latency ([Azure Functions scale and hosting](https://learn.microsoft.com/en-us/azure/azure-functions/functions-scale)).

The shared lesson is that a cold start costs latency, never data.

**Recommendation.** Producers enqueue unconditionally, with a TTL if the work is time-sensitive. A small supervisor watches queue depth and wakes the session. Make delivery at-least-once and consumption idempotent, as Lambda's documentation demands. If "a daily job should run only if the session exists", encode that as an *expiry* on the item, not as a pre-check by the producer. Expiry is the only legitimate way for work to vanish, and it is visible and auditable.

## 3. Health gates versus wake churn

Suppose the session's downstream dependency is broken, for example its account credentials have expired. A woken session cannot do the work. There are two policies:

- **Gate wake on health.** Do not start the session while the dependency is unhealthy. No churn, no wasted startup cost. The risk is a *silent stall*: work accumulates in the queue and nobody is told.
- **Do not gate.** Wake anyway. The session starts, fails, idles out, is reclaimed, and the pending work wakes it again. You get a periodic start/stop cycle that burns resources and floods logs, though at least something is visibly failing.

Neither is free. The Kubernetes kubelet shows a middle path for the churn side: restarts use an exponential delay (10s, 20s, 40s, and so on) capped at 300 seconds, and the timer resets only after a container has run for 10 minutes without problems ([Pod lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)). Cloudflare alarms apply a similar idea: failed alarms retry with exponential backoff starting at 2 seconds, with up to 6 retries ([Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)).

**Recommendation.** Use a hybrid:

1. Gate wake on a cheap health probe, but give the gate an explicit state ("blocked: dependency unhealthy") and an alert with a deadline, so a stall cannot stay silent.
2. Apply exponential backoff, and have the counter increment only on *actual start attempts*, not on every evaluation of the wake predicate. Otherwise a fast polling loop exhausts the backoff budget without ever trying, or a slow one never escalates.
3. Reset the counter only after sustained success (a session that started and completed useful work), not merely because the process stayed alive for a few seconds. This mirrors the kubelet's 10-minute rule.
4. When the probe turns healthy, wake immediately and clear the backoff; do not make users wait out a timer that exists only to punish a failure that has ended.

## 4. Pre-sleep consolidation and crash-safe transitions

A conversation-holding process is the one place where sleeping loses information. Durable Objects state the rule bluntly: all in-memory state is discarded on hibernation, so anything not saved elsewhere is gone ([lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)). An agent session has the same property, so sleep must be a two-phase operation:

1. **Consolidate.** Before reclaim, the session flushes what only it knows: a summary of the conversation, open commitments, updates to shared state, and any backlog it has claimed but not finished. If a unit of work was claimed but not completed, it is released back to the queue, not carried silently into sleep.
2. **Then reclaim.** Only after consolidation is recorded as durable does the supervisor stop the process.

Mode transitions (awake to sleeping, sleeping to waking) can themselves be interrupted by a crash. The robust pattern is the one Kubernetes controllers rely on: record desired state, then act, and make the loop re-derivable. Controllers "watch the state of your cluster, then make or request changes where needed" to bring the current state closer to the desired one ([Kubernetes controllers](https://kubernetes.io/docs/concepts/architecture/controller/)). Applied here:

- **Write intent first.** Persist "transition to sleeping, run N" *before* stopping anything.
- **Act idempotently.** Stopping an already-stopped process, or flushing an already-flushed summary, must be harmless.
- **Re-derive on restart.** After a supervisor crash, do not trust in-memory flags. Read durable state: the recorded intent, the last consolidation marker, the queue, and whether a process for run N actually exists. If intent says "sleeping" but consolidation was never recorded, redo consolidation; if the process is gone but intent says "awake", mark it crashed and decide whether to wake.
- **Fence the old run.** If the previous incarnation turns out to be alive after all (a slow shutdown), its writes carry a stale run ID and are rejected, as in section 1.

## 5. Observability: sleeping is not offline

If a status page shows a sleeping session as "offline", users will assume the system is broken, restart things by hand, and file reports about a healthy design. Serverless platforms make the distinction obvious: Fly.io Machines are explicitly "stopped" or "suspended", not failed, and a cold start is described as an expected latency cost ([Fly.io](https://docs.fly.io/launch/autostop-autostart)); Azure documents scaled-to-zero apps as normal, with first-request latency ([Azure Functions](https://learn.microsoft.com/en-us/azure/azure-functions/functions-scale)).

**Recommendation.** Model at least these states, and show them in every status API and UI:

| State | Meaning | What the user should do |
|---|---|---|
| Active | Process running, working or ready | Nothing |
| Idle | Running, TTL clock ticking | Nothing |
| Sleeping | Reclaimed on purpose, backlog (if any) is queued | Nothing; show queue depth and "will wake on next message" |
| Waking | Start in progress | Wait; show how long |
| Wake failed | Start attempted and failed, with attempt count and next retry time | Read the reason |
| Blocked | Health gate closed, with reason and since-when | Fix the dependency |
| Crashed | Process died without a recorded sleep intent | Investigate |

The two states most often missing are *Waking* and *Wake failed*. Without them, the interval between "message sent" and "session responding" looks identical to a hang.

## End-to-end scenario

A host runs three sessions. Session A finishes its work at 17:00 and goes idle.

1. **17:10, idle TTL.** The supervisor records intent "sleep, run 41". Session A consolidates: it writes a summary, updates the shared notes, and releases one half-finished item to the queue. It records the consolidation marker. The supervisor stops the process. The status shows *Sleeping, 1 queued item*.
2. **17:12, a stale message.** An old "exit" command addressed to run 40 is found in the inbox. It names a dead run, so the wake predicate ignores it and it is expired. No wake, no loop.
3. **Next morning, 09:00.** The daily job does not check whether Session A is up. It enqueues unconditionally with a 6-hour expiry. The supervisor sees deliverable, unexpired work, and the status flips to *Waking*.
4. **Health gate fails.** The probe shows the account credentials have expired. The status becomes *Blocked: credentials, since 09:00*, an alert fires, and no start is attempted, so the backoff counter stays at zero. The work remains queued, not lost.
5. **09:40, credentials fixed.** The probe passes, the supervisor starts run 42 immediately, and Session A drains the queue. The backoff counter resets after the session completes real work, not at process start.

At every step, a person looking at the status page can tell what is happening and why.

## Checklist

- [ ] Every process start gets a monotonically increasing run ID; run-scoped messages carry it.
- [ ] The wake predicate counts only unexpired, deliverable, durable work.
- [ ] Run-scoped control messages are expired when their run ends.
- [ ] Producers enqueue unconditionally; the only way work disappears is an explicit expiry.
- [ ] Consumption is at-least-once and idempotent.
- [ ] Wake is gated on a health probe, with a visible Blocked state and an alert deadline.
- [ ] Backoff counts actual start attempts and resets only after sustained useful work.
- [ ] Sleep is two-phase: consolidate and record, then reclaim; claimed-but-unfinished work returns to the queue.
- [ ] Mode transitions write intent first and re-derive state from durable records after a crash.
- [ ] Status surfaces distinguish Sleeping, Waking, Wake failed, Blocked and Crashed.

## Sources

- Martin Kleppmann, [How to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html) (fencing tokens)
- Martin Fowler, [Patterns of Distributed Systems: Generation Clock](https://martinfowler.com/articles/patterns-of-distributed-systems/generation.html)
- Kubernetes docs: [Object names and UIDs](https://kubernetes.io/docs/concepts/overview/working-with-objects/names/), [ObjectMeta reference](https://kubernetes.io/docs/reference/kubernetes-api/common-definitions/object-meta/), [Pod lifecycle (restart backoff)](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/), [Controllers](https://kubernetes.io/docs/concepts/architecture/controller/)
- Erlang/OTP docs: [Data types (references)](https://www.erlang.org/doc/system/data_types.html), [gen_server](https://www.erlang.org/docs/25/man/gen_server)
- Lennart Poettering, [Socket Activation](https://0pointer.de/blog/projects/socket-activation.html)
- Knative: [Target burst capacity and the Activator](https://knative.dev/docs/serving/load-balancing/target-burst-capacity/), [Scale to zero](https://knative.dev/docs/serving/autoscaling/scale-to-zero/)
- KEDA: [Scaling Deployments](https://keda.sh/docs/latest/concepts/scaling-deployments/)
- Cloudflare: [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/), [Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- Fly.io: [Autostop and autostart](https://docs.fly.io/launch/autostop-autostart)
- AWS: [Using Lambda with Amazon SQS](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html)
- Microsoft: [Azure Functions scale and hosting](https://learn.microsoft.com/en-us/azure/azure-functions/functions-scale)
