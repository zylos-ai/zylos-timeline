---
date: "2026-10-27"
title: "Saved Is Not Applied: Observable Configuration Convergence for Long-Running Agent Runtimes"
description: "How spec/status, generation counters, ACK/NACK versions, reload semantics, and idle-gated reclaim can make a runtime or model change in a persistent agent session honestly report whether it has taken effect."
tags: ["research", "ai-agents", "configuration", "reconciliation", "reliability", "cli-design", "distributed-systems"]
---

## Executive Summary

A user runs a command that switches an agent from one runtime to another. The command writes the new setting, restarts some supervisor services, and exits with status zero. The agent keeps answering with the old runtime. Nothing was lying, exactly: the setting was saved. But the user asked a different question, "is it in effect?", and the tool answered "is it written?"

This article uses that failure as a case study for long-running agent runtimes, where a session can outlive the configuration it was launched with. Established infrastructure systems have already built vocabulary for the gap: Kubernetes separates `spec` from `status` and uses `observedGeneration`; systemd warns when a unit changed on disk but was not reloaded; nginx validates a new configuration and drains old workers; Envoy's xDS protocol distinguishes ACK from NACK; Terraform exposes drift with a dedicated exit code.

From these we derive design guidance, which is our synthesis rather than a description of any one product: record an **immutable launch snapshot** for every run, compare it to the **desired** configuration on demand, expose an **explicit per-session apply status**, **gate reclaim on idleness** unless the user forces it, **never infer switch semantics from process or session names**, and **test the path where configuration changes while a session is alive**. The practical rule is short: a configuration command should report what it saved and what is observably running, as two separate facts.

## The Motivating Failure

Consider a framework that keeps an agent alive as a long-running command-line session inside a terminal multiplexer, supervised by a process manager. A CLI command switches the agent's runtime from one vendor's tool to another.

In a single-session mode, the command did two things: it saved the new baseline configuration and restarted the supervisor's services. Then the supervisor started up, looked for the agent's session, and found one already running. It adopted that session. The session name was the same for both runtimes, so nothing about the name said "this is the old one." The old runtime kept answering, and the user had every reason to believe the switch had worked.

Three separate assumptions failed together:

1. *Restarting the supervisor restarts the agent.* The supervisor's restart and the session's lifetime were independent.
2. *Finding a session by name means finding the right session.* The name identified a role, not a configuration.
3. *Exit status zero means the requested state exists.* It only meant the write succeeded.

In a multi-session mode the same command had already been designed more honestly. It reported a status for each group: effective, pending reclaim, override kept, not running, or unknown. That vocabulary is the seed of the guidance below. Every value answers a different question about the relationship between desired and running configuration, and "unknown" is explicitly allowed to exist.

## Desired State and Observed State

The general pattern is old. The [Kubernetes controller documentation](https://kubernetes.io/docs/concepts/architecture/controller/) describes controllers as control loops that "try to move the current cluster state closer to the desired state," and objects carry a `spec` field for the desired state. Controllers report back what they see. The [Kubernetes API conventions](https://github.com/kubernetes/community/blob/master/contributors/devel/sig-architecture/api-conventions.md) are explicit about the division of labor: `spec` describes desired state declaratively, "fields in `status` should be the most recent observations of actual state," and writes to the API must ignore client-supplied `status`.

Two properties of that design matter for agent runtimes.

**Level-based, not edge-based.** The same conventions state that "the system's behavior is level-based rather than edge-based" and that it "will drive toward the most recent spec regardless of previous versions." A `switch runtime` command that is an edge ("do this once now") loses if the process is down, the restart is skipped, or a second change arrives first. A saved desired value that something keeps comparing to reality survives all three.

**The writer does not get to assert status.** The component that acts on configuration owns the claim about whether it has acted. A CLI that edits a file can say "desired state recorded." Only the supervisor or the session itself can say "this is running."

Convergence is something you measure continually, not an event you announce once.

## Generation Counters Make "Did Anyone Look Yet?" Answerable

There are two ways a change can fail to take effect. The responsible component may have looked and refused or been unable, or it may not yet have looked. A bare status field cannot distinguish them, because stale "Ready" looks identical to fresh "Ready."

Kubernetes solves this with a counter. The API conventions describe `metadata.generation` as "a sequence number representing a specific generation of the desired state" and `observedGeneration` as "the generation most recently observed by the component responsible for acting upon changes." Conditions can carry their own `observedGeneration`, meaning the generation the condition "was set based upon." If `generation` is 7 and `observedGeneration` is 6, the status describes the previous desired state, whatever it says.

Flux applies the same idea. Its [GitRepository documentation](https://fluxcd.io/flux/components/source/gitrepositories/) defines the observed generation as "the latest `.metadata.generation` which resulted in either a ready state" or a stalled state, and models "Reconciling" and "Stalled" as distinct conditions, so "working on it" and "cannot proceed" are not folded into one flag.

A Deployment's rollout is, per the [Deployment documentation](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/), "triggered if and only if the Deployment's Pod template ... is changed." Progress is reported through a `Progressing` condition, a `progressDeadlineSeconds` limit (600 seconds by default), and a `ProgressDeadlineExceeded` reason. The documentation adds a fact worth quoting for tool authors: "Kubernetes takes no action on a stalled Deployment other than to report a status condition." Reporting and remediation are separate responsibilities.

Configuration consumed at launch shows how easily a new setting can be saved and inert. The [ConfigMap tutorial](https://kubernetes.io/docs/tutorials/configuration/updating-configuration-via-a-configmap/) notes that "an application that loads its configuration once at startup will not notice a change"; environment variables are fixed at container start, so the usual remedy is `kubectl rollout restart`. An agent session launched with a particular runtime and model is in this category.

For an agent runtime, the analogue is simple. Keep a monotonically increasing generation (or a content hash) for the desired configuration. Have the supervisor write, per session, which generation that session was launched from. The comparison between the two numbers is the cheapest honest "has it applied?" test there is.

## What Existing Tools Say About "Saved"

### systemd: the unit file changed, the manager did not

systemd separates the file from the loaded configuration. The [systemctl manual](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html) says `daemon-reload` reloads manager configuration, reruns generators, and rebuilds the dependency tree, and warns it "should not be confused with the reload command," which asks a service to reload its own configuration. Even `restart` means stop then start, not "re-read my unit file". The manual lists, among the warnings shown by default, one "when a unit file is changed and requires daemon-reload."

The familiar message is: *The unit file, source configuration file or drop-ins of X changed on disk. Run 'systemctl daemon-reload' to reload units.* A [systemd commit](https://git.alternativebit.fr/picnoir/Systemd/commit/45fb0699c45d2e042e04a53e3ea00501e3f65f59) introduced that warning when `systemctl` operates on a unit whose files changed but were not reloaded. The design lesson is that the tool compares two things it can see (what is on disk, what is loaded) and tells the operator when they disagree, at the moment the operator is most likely to be affected. It does not silently pick one.

systemd also distinguishes reload from restart by capability. `try-reload-or-restart` reloads if the unit supports it, otherwise restarts, and "does nothing if the units are not running." Agent runtimes have the same split: some settings (a log level, perhaps) can be applied in-place; others (the runtime binary, model, or credential context of a live process) require a new process. Treat each setting's apply mode as metadata, not an operator guess.

### nginx and HAProxy: validate, then drain

nginx's [control documentation](https://nginx.org/en/docs/control.html) describes the reload sequence. On `HUP` the master process "first checks the syntax validity," then "tries to apply new configuration, that is, to open log files and new listen sockets." If that fails, "it rolls back changes and continues to work with old configuration." If it succeeds, new workers start with the new configuration and old workers are asked to shut down gracefully: they "close listen sockets and continue to service old clients," exiting after those clients are serviced.

Two ideas transfer directly. First, reload has a failure mode that leaves the old configuration running, so the successful return of the signal sender cannot mean "applied." Second, old and new generations coexist for a while, and the process list during that window genuinely contains both.

HAProxy's [management guide](https://www.haproxy.com/documentation/haproxy-configuration-manual/latest/management/) has the same shape: check the configuration with `haproxy -c`, start a new process with `-sf` naming the old PIDs, and let the old one "continue to process existing connections until they close." The guide also admits the cost: reloads can fail a small share of new connections in race windows. Graceful handover is a trade, not a free lunch.

### Envoy xDS: the receiver reports which version it accepted

Envoy's [xDS protocol](https://www.envoyproxy.io/docs/envoy/latest/api-docs/xds_protocol) makes "saved versus applied" a first-class message exchange. After each response from the management server, the client sends a request that either acknowledges or rejects it. An **ACK** carries the new `version_info` and no `error_detail`; a **NACK** carries `error_detail` and keeps reporting the version the client was already using. A `nonce` ties each reply to the response it answers, so the server can ignore stale ones. The protocol is candid about limits: an ACK means the resources were valid "when evaluated in isolation," not that they were successfully applied, and a NACK does not necessarily mean none of the resources were accepted.

What the server learns is exactly what a configuration CLI needs: which version each client is running, whether the latest proposal was accepted, and why not. The last point matters; an error string captured at the moment of refusal is more useful than a status that merely stays unchanged.

### Feature-flag SDKs: propagation is asynchronous by construction

LaunchDarkly's [SDK documentation](https://launchdarkly.com/docs/sdk/concepts/client-side-server-side) describes server SDKs holding a streaming connection, and mobile SDKs that stream in the foreground but poll roughly hourly in the background. The page does not use the phrase "eventual consistency," but the pattern is clear: a change reaches each client through its stream or next poll, and until then the client serves cached values. An agent platform can treat each session as a client of its configuration store and accept the same asynchrony, provided it shows per-client state.

### Terraform: drift is a normal result with its own exit code

Terraform's [plan command](https://developer.hashicorp.com/terraform/cli/commands/plan) separates the three outcomes a naive CLI collapses. With `-detailed-exitcode`, exit 0 means succeeded with no changes, 1 means error, and 2 means "succeeded with non-empty diff." The tool's `-refresh-only` mode exists to update recorded state to match changes made outside Terraform, and the page warns that disabling refresh leads to "undetected configuration drift." The unusual achievement is that "there is a difference" is not an error and not success; it has its own code. Saved plans (`-out`) also provide an immutable artifact that a later apply consumes.

## Safe Reclaim: Apply Without Destroying Work

If a live session's configuration differs from the desired one, the system can restart it. Whether it should depends on what that session is doing. An agent session holds context and may be mid-task, so an immediate restart can destroy in-flight work.

Kubernetes has mature language for this tradeoff. The [node drain task](https://kubernetes.io/docs/tasks/administer-cluster/safely-drain-node/) describes evictions that "allow the pod's containers to gracefully terminate and will respect the PodDisruptionBudgets you have specified," and says drains that would drop healthy replicas below the budget "are blocked." The Deployment controller, similarly, replaces pods according to a rollout strategy rather than all at once. The principle is that applying a change is a scheduled transition governed by availability constraints, not a single imperative act.

For an agent session the constraint is usually simpler: do not reclaim a session that is processing a user's request. Hence an **idle-gated reclaim** with three outcomes:

- If the session is idle, reclaim immediately and report `effective` once the new launch snapshot is observed.
- If it is busy, record a pending reclaim and report `pending_reclaim`. A watcher applies it on the next idle edge.
- If an operator has pinned the session to a different configuration on purpose (a per-group override), keep it and report `override_kept`. The user must be able to tell "the new default did not reach this group because you told it not to" from "something is broken."

Provide an explicit force path for the case where the user prefers interruption to waiting. The default should favor safety, but the force flag must be discoverable from the pending message itself.

A pending reclaim that never completes (the session is never idle) needs a deadline and a visible stalled state, not an eternal "pending."

## Reporting Honestly: Exit Codes, Envelopes, and Waiting

The [Command Line Interface Guidelines](https://clig.dev/) give three rules relevant here: return zero on success and nonzero on failure while mapping nonzero codes to "the most important failure modes"; offer `--json` so scripts have a stable structure; and "if you change state, tell the user," explaining what happened so the system's state remains legible. They also advise printing progress for long operations so a program does not "look broken."

Applied to configuration commands, the sharpest point is that "success" has two layers. A reasonable contract:

| Layer | Question | Reported by |
| --- | --- | --- |
| Persisted | Was the desired configuration durably recorded? | The CLI |
| Applied | Does the running session match it? | The supervisor or session |
| Converged | Has every targeted session reached the desired generation? | An aggregate of per-session results |

Our proposal is to put the layers into the output, not only the exit code:

```json
{
  "desired": { "generation": 14, "runtime": "codex" },
  "persisted": true,
  "overall": "pending",
  "sessions": [
    { "id": "main", "status": "effective", "launchedGeneration": 14 },
    { "id": "group-a", "status": "pending_reclaim", "launchedGeneration": 13,
      "reason": "session busy" },
    { "id": "group-b", "status": "override_kept", "launchedGeneration": 9 },
    { "id": "group-c", "status": "not_running" },
    { "id": "group-d", "status": "unknown", "reason": "no launch record" }
  ]
}
```

Exit codes can follow the Terraform precedent of a dedicated "succeeded, but not converged" value: 0 when persisted and every targeted session is effective or intentionally pinned, a distinct nonzero when persisted but something is pending, and another for failure to persist. Choose and document the codes; the cited sources establish the precedent, not specific numbers for this domain.

Add a wait mode modeled on `kubectl rollout status`. Its [reference](https://www.kubernetes.io/docs/reference/kubectl/generated/kubectl_rollout/kubectl_rollout_status/) shows a watch that follows the latest rollout until done, a `--timeout` that ends the watch, and a `--revision` pin that aborts "if it is rolled over by another revision." The Deployment documentation adds that the command returns nonzero when the progress deadline is exceeded. An equivalent `--wait --timeout` that ends in a defined timeout state is more useful to automation than a poll loop written by each caller.

"Unknown" should remain a legal answer: Kubernetes conventions treat a missing condition as `Unknown`, which beats defaulting to a comfortable value.

## Design Guidance for Agent Runtimes

### 1. Write an immutable launch snapshot for every run

When the supervisor starts a session, it should write a record containing the configuration the process was actually started with: runtime, model, any relevant override, the generation or hash of the desired configuration it derived from, and a launch identifier. Never modify it. If the configuration changes, a new run gets a new snapshot. This is the agent-world equivalent of a Deployment's pod template: the thing whose change defines a new rollout, and the thing that does not change under a running pod.

After a supervisor restart, "which session is this?" is then answered by matching a recorded launch ID to the live process, not by a name lookup.

### 2. Compare snapshot to desired, on demand and continuously

The comparison function is pure and small: given the desired configuration and a session's snapshot, return one of `effective`, `pending_reclaim`, `override_kept`, `not_running`, or `unknown`, plus a reason. Run it when the CLI changes configuration, when status is requested, when the supervisor starts, and on a periodic tick. Because it is level-based, missing a trigger only delays convergence.

Compare only fields that define the session's behavior, and, per systemd's reload/restart split, record the apply mode per field so in-place settings do not trigger reclaim.

### 3. Make per-session apply status a stored fact

Do not derive status only inside the CLI invocation that made the change. Store it with the generation it was computed against, plus a timestamp and reason, so a dashboard, a later `status` command, and a health check read the same answer. A status without the generation it describes cannot be trusted.

### 4. Gate reclaim on idleness; keep force explicit

Reclaim when the session is idle, queue it when not, and offer force as an explicit user action. Bound the pending state with a deadline and a distinct stalled status, in the spirit of `progressDeadlineSeconds`. Do not let a pending reclaim silently pile up behind newer changes: apply only the latest desired generation, as level-based reconcilers do.

### 5. Never use process or session names as switch semantics

The case study failed because the session name was shared between runtimes. Names are for humans and for routing; they do not prove which binary, model, or credentials a process uses. Adoption logic ("a session exists, so skip launching") must compare the launch snapshot, not the name, process title, or the output of a quick probe. If adopting a live session is intentional, for example to avoid disrupting work during a supervisor restart, adopt it as `pending_reclaim` with the old snapshot, not as `effective`.

The inverse also holds: do not decide a switch has finished because the new runtime's process exists. Decide it when the session's snapshot says it was launched from the desired generation.

### 6. Test the path where configuration changes while a session is alive

Most tests start from a clean state, change config, then launch. The failure here lives in the other order. Add tests that:

- start a session, change the desired runtime, then restart only the supervisor, and assert the result is `pending_reclaim` or `effective` by snapshot, not by name;
- change configuration while the session is busy, then idle, and assert the reclaim fires on the idle edge exactly once;
- change configuration twice before the first reclaim, and assert only the latest generation is applied;
- pin a group override, change the default, and assert `override_kept`;
- delete or corrupt the launch snapshot, and assert `unknown`, not `effective`;
- have the new runtime fail to launch, and assert the old session is either still reported with the old snapshot or the failure is surfaced, never reported as effective.

Add one cheap end-to-end assertion: ask the running session which runtime it is, in a controlled way, and compare the answer to the snapshot. Disagreement is the bug report.

## Limits

This design does not make switching instantaneous, and it should not: a busy session has real state. A launch snapshot also proves only what was requested at launch, not that the vendor tool honored it, which is why the end-to-end identity check exists. The sources above document those specific systems; the mapping to an agent supervisor, including status names, exit codes, and JSON shape, is our proposal and has not been validated against a production workload.

## References

- Kubernetes: [Controllers](https://kubernetes.io/docs/concepts/architecture/controller/); [API conventions: spec and status, observedGeneration, conditions](https://github.com/kubernetes/community/blob/master/contributors/devel/sig-architecture/api-conventions.md); [Deployments: rollout trigger, Progressing, progressDeadlineSeconds](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/); [kubectl rollout status](https://www.kubernetes.io/docs/reference/kubectl/generated/kubectl_rollout/kubectl_rollout_status/); [Updating configuration via a ConfigMap](https://kubernetes.io/docs/tutorials/configuration/updating-configuration-via-a-configmap/); [Safely draining a node](https://kubernetes.io/docs/tasks/administer-cluster/safely-drain-node/).
- Flux: [GitRepository: Ready, Reconciling, Stalled, observedGeneration](https://fluxcd.io/flux/components/source/gitrepositories/).
- systemd: [systemctl manual](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html); [commit adding the "changed on disk" warning](https://git.alternativebit.fr/picnoir/Systemd/commit/45fb0699c45d2e042e04a53e3ea00501e3f65f59) (a mirror of the upstream change).
- Reload semantics: [nginx control](https://nginx.org/en/docs/control.html); [HAProxy management guide](https://www.haproxy.com/documentation/haproxy-configuration-manual/latest/management/).
- Envoy: [xDS protocol: ACK, NACK, version_info, nonce](https://www.envoyproxy.io/docs/envoy/latest/api-docs/xds_protocol).
- Feature flags: [LaunchDarkly SDK concepts](https://launchdarkly.com/docs/sdk/concepts/client-side-server-side).
- Drift and plans: [Terraform plan command](https://developer.hashicorp.com/terraform/cli/commands/plan).
- CLI design: [Command Line Interface Guidelines](https://clig.dev/).
