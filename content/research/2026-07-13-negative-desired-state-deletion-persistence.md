---
date: "2026-07-13"
title: "Making Deletion Stick: Negative Desired State in Self-Healing Agent Infrastructure"
description: "When an operator deliberately removes a service, config, or capability, how do you stop the platform's own reconciliation and upgrade machinery from resurrecting it? A survey of systemd masking, GitOps pruning, package-manager holds, Terraform lifecycle blocks, and CRDT tombstones — and what it means for AI agent platforms whose operator is itself an agent with soft memory."
tags:
  - self-healing-infrastructure
  - desired-state
  - reconciliation
  - deletion-semantics
  - systemd
  - gitops
  - kubernetes
  - terraform
  - configuration-management
  - ai-agents
  - component-lifecycle
  - platform-engineering
---

## Executive Summary

Every reconciliation system — a process supervisor, a Kubernetes controller, a package manager, a config management run — answers one question relentlessly: does reality match the desired state, and if not, fix it. That property is exactly what makes such systems valuable, and exactly what makes *deletion* the hardest operation they support. Adding something is a straightforward convergence target: declare it, and the reconciler keeps making it true. Removing something is not the mirror image, because "absent" isn't a value a reconciler can converge toward unless absence is itself recorded somewhere the reconciler will consult. If it isn't, the very next reconciliation pass — the next upgrade, the next boot, the next `pm2 resurrect`, the next controller sync — treats the gap between "declared" and "observed" as drift to be corrected, and recreates the thing a human just spent effort destroying.

Infrastructure tooling has spent decades rediscovering this problem under different names, and every mature answer converges on the same shape: **deletion has to be written down as a positive fact, not inferred from an absence.** systemd's `mask` writes a symlink to `/dev/null` because `disable` alone leaves a service startable by any dependency chain that still wants it. dpkg records that an administrator deliberately deleted a conffile so the next upgrade won't silently restore it — the alternative, `update-rc.d remove`, has no such memory, and a package's postinst script cheerfully reinstates the init links it removed. Argo CD and Flux both prune resources that fall out of Git, and both ship an opt-out annotation — `Prune=false`, `kustomize.toolkit.fluxcd.io/prune: disabled` — because prune-by-default treats "missing from the manifest" as "should be deleted," which is occasionally exactly wrong (a PVC holding data, a resource someone provisioned by hand). Terraform's `removed` block and `prevent_destroy` exist because "not in the `.tf` files anymore" is ambiguous between "destroy this" and "stop managing this, but leave it alone." CRDTs need tombstones for the same underlying reason at the data-structure level: where updates can arrive out of order from multiple replicas, "the value is gone" has to outlive "the value was here," or a late-arriving add resurrects what was deleted.

This article works through that pattern across six domains — process supervision, package management, Kubernetes/GitOps, Terraform, configuration management (Ansible/Puppet/Chef), and CRDT/distributed-systems tombstones — and then applies the accumulated lesson to a live problem in AI agent infrastructure: component and plugin managers for autonomous agent platforms, where the *operator* deciding what should no longer exist is itself an AI agent, and that agent's memory of "I deleted this on purpose, for this reason" is soft state that a context rotation, a session restart, or simply the passage of time can erode. The grounding case is real (anonymized): an agent's messaging component was kept installed for its CLI tooling, but its long-connection worker process had been dead for days after a policy decision to run read-only. The owner directed the process be deleted. The agent ran the equivalent of `pm2 delete` and `pm2 save`, verified no supervisor config could resurrect it — and then flagged a residual risk that no tooling could close: the next component upgrade would very likely re-register that worker from the component's install manifest, because the platform had no way to say "this component is installed, and this specific service inside it is intentionally, permanently disabled." That gap — and a concrete schema for closing it — is where this piece ends up.

## Why Deletion Is the Hard Direction

Reconciliation loops are built around a monotone-feeling operation: compare desired to actual, and add what's missing. Kubernetes controllers, Ansible playbooks, Terraform applies, and self-healing process supervisors all default to being *additive* by construction — their entire reason for existing is to keep making a thing true even after something knocks it down. That default is a feature for the 95% case (a crashed pod, a missing config line, a service that died and should restart) and a landmine for the other case: a human, or an agent acting on a human's instruction, decided the thing should stop existing.

"Desired state" is usually encoded as a *positive* list — a manifest, a `.tf` file, an ecosystem config, a package list — and a reconciler's simplest algorithm is "whatever is on the list, make true." Absence from that list is semantically ambiguous. It can mean any of:

1. **"Delete this."** The thing used to be desired and no longer is; tear it down.
2. **"I never expressed an opinion about this."** It's out of scope for this reconciler; leave it exactly as found.
3. **"This was deliberately, permanently removed and must never be recreated by this system again."** Stronger than (1) — not just "not currently wanted" but "actively forbidden," including by *future* versions of the manifest that might re-add it by accident.

Every tool discussed below is, in effect, a different mechanism for letting an operator pick option 3 explicitly, because the reconciler cannot infer it from silence. Silence is indistinguishable from "haven't gotten to it yet," and a system that guesses wrong in the direction of resurrection is far more dangerous than one that guesses wrong in the direction of doing nothing — a resurrected payment worker, a resurrected long-connection socket, a resurrected cron job can all cause real side effects before anyone notices.

## systemd: The Canonical "Make Deletion Stick" Primitive

systemd's three levels of "off" are the cleanest illustration of the problem because they were designed, in public, specifically to close the gap between "looks off" and "cannot come back on."

**`systemctl stop`** terminates the running instance and does nothing else — the most temporary and superficial operation possible. If anything asks for the unit again (a dependency, a timer, a manual start, the next boot), it starts right back up. Stop expresses no desired state at all; it's an imperative action on current state, not a declaration about the future.

**`systemctl disable`** unhooks the unit from its `WantedBy=`/`RequiredBy=` activation triggers — it's a real, persistent change that survives reboots. But disable has a specific, well-documented hole: a disabled unit can still be started manually, and critically, it can still be **pulled in as a dependency by another unit**. If service B declares `Requires=service-A.service` and something starts B, systemd will happily start the disabled A to satisfy the dependency, because disable only removed A's *own* activation triggers, not its eligibility to be activated by someone else's.

**`systemctl mask`** closes that hole by symlinking the unit file to `/dev/null`. This is a structural block, not a policy flag: any attempt to start the unit — manual, at boot, or as a pulled-in dependency — resolves to a unit file that is `/dev/null`, which cannot define a working service, and the start fails. Nothing short of `systemctl unmask` can undo it. Mask is systemd's answer to the exact failure mode this article is about: a reconciliation-adjacent mechanism (systemd resolving a dependency graph) recreating something an operator turned off, because "off" was recorded as a preference rather than a prohibition.

The **package-manager parallel** makes the same point from the install side. `update-rc.d remove` deletes System V init script symlinks — but it has no persistent memory of *why* they're gone. The Debian documentation is explicit about the resulting trap: "a common system administration error is to delete the links with the thought that this will disable the service... [but] if all links have been deleted, then the next time the package is upgraded, the package's postinst script will run `update-rc.d` again and this will reinstall links at their factory default locations." The removal was real, but it wasn't a fact the packaging system remembered — it was just an artifact the packaging system happened not to notice was missing until the next postinst script ran and put it back.

dpkg's handling of **conffiles**, by contrast, gets this right, and it's a genuinely under-appreciated piece of design: dpkg *does* remember deliberate conffile deletion. If an administrator deletes a file dpkg manages as a conffile (typically something under `/etc`), the package system records that fact, and the next upgrade does **not** silently restore it — the file simply stays gone. The rationale, per Debian's own documentation, is symmetric: restoring it by default would be dangerous (an operator's deliberate removal getting silently undone), but *not* remembering the "deliberate" qualifier would be equally dangerous (an accidental deletion getting permanently baked in with no easy recovery). dpkg's answer is to record the deletion as a first-class fact and offer an explicit escape hatch — `--force-confmiss` to force restoration, `--force-confask` to be asked — putting the operator back in control on the rare occasions the default is wrong. This single mechanism is close to a template for the AI-agent design this article proposes later: **a positive record of intentional absence, checked on every subsequent write, with an explicit override for the rare case it should be reversed.**

## Package Version Locks: Pinning as Negative Desired State for Upgrades

A closely related problem: not "stop this from running" but "stop this from *changing*." `apt-mark hold` prevents a package from being automatically installed, upgraded, or removed — `apt upgrade` skips held packages entirely. `dnf`'s `versionlock` plugin does the equivalent for RPM-based systems, and APT's pinning system in `/etc/apt/preferences.d/` lets an operator express version preferences with numeric priority, including priorities above 1000 that force a *downgrade* to match the pin. Windows Update's legacy `wushowhide` tool works the same way in spirit: hiding an update writes a record that survives future scan cycles, so it stays suppressed rather than reappearing on the next sweep.

The lesson is narrower than mask/disable but still relevant: a package manager's default behavior — converge every installed package to the latest available version — is *also* a desired-state assumption the operator didn't necessarily sign up for, and overriding it requires a persistent, out-of-band record (a hold file, a lock database, a preferences stanza), not a one-time flag passed to a single command. **The reconciler's default is additive/current-seeking; suppressing that for one item requires its own durable record, separate from the item itself.**

## Kubernetes and GitOps: Reconciliation That Actively Fights You

Kubernetes is the sharpest version of this problem because its reconciliation loops are *fast* and *level-triggered* — they don't ask what happened, they ask what's true right now, continuously, often on a sub-minute cycle. Delete a pod that's managed by a Deployment and the ReplicaSet controller notices the actual replica count has dropped below `spec.replicas`, and creates a new pod within seconds. This is not a bug; it is the entire value proposition of a Deployment. But it means `kubectl delete pod` is never actually "delete this pod" — it's "kill this pod and let the reconciler immediately prove that deletion doesn't stick unless you also change the desired state." The correct way to actually stop pods from existing is to change `spec.replicas` to 0, or delete the Deployment itself — i.e., **express the absence at the level the reconciler reads, not at the level of the artifact it produces.** The same logic explains why `kubectl scale` fights a live HorizontalPodAutoscaler: a manual scale patches `spec.replicas` directly, but the HPA reconciler wakes on its own sync period (commonly every 15 seconds), recomputes the desired replica count from current metrics, and overwrites the manual value on the next pass — two reconcilers with different opinions about the same field, and whichever ran most recently wins until the other runs again.

GitOps controllers generalize this to entire clusters and, having been burned by it in production, generalize the fix too. Both Argo CD and Flux implement **pruning**: if a resource previously applied from Git is no longer in the Git manifest, the controller deletes it from the live cluster on the next sync, treating "missing from source" as "should not exist." That's the deletion-as-desired-state principle done right — except both tools learned the hard way that *default* pruning is too blunt for stateful or manually-provisioned resources, so both ship an opt-out annotation: Argo CD's `argocd.argoproj.io/sync-options: Prune=false` and the stronger `compare-options: IgnoreExtraneous` (which drops a resource from sync-status calculation entirely), and Flux's `kustomize.toolkit.fluxcd.io/prune: disabled`. Both projects' docs cite the same use case almost verbatim: protect PersistentVolumeClaims, databases, and other resources where "prune because it's not in the file anymore" would mean silent, possibly catastrophic data loss. Helm's `helm.sh/resource-policy: keep` annotation solves the identical problem at uninstall time, with a caveat worth internalizing: once kept, the resource becomes fully **orphaned** — no longer tracked or updated by Helm in any future operation. Escaping the reconciler's deletion sweep means escaping its management entirely; Helm has no native "keep it, but still let me manage it later" state.

Kubernetes' **finalizers** and deletion propagation policies attack the adjacent problem — not "don't delete this" but "delete this correctly, and be explicit about what happens to its children." A finalizer blocks deletion (the API server sets `deletionTimestamp` but the object persists) until the owning controller finishes cleanup and removes its own finalizer key. Cascading deletion has three policies — **Foreground** (children deleted before the parent), **Background** (parent vanishes immediately, dependents cleaned up asynchronously), and **Orphan** (`--cascade=orphan`: delete the parent, leave dependents alive and disconnected from any owner). Orphaning is Kubernetes' native way of saying "stop managing this without destroying it" — the same intent Terraform's `removed` block and Helm's `resource-policy: keep` reach for from different angles.

Finally, **suspend-as-desired-state** is the cleanest positive pattern in the Kubernetes ecosystem, because it inverts the deletion problem into something a reconciler handles natively rather than fights. A CronJob's `spec.suspend: true` doesn't delete the object or fight the controller — it *is* the controller's own vocabulary for "stop scheduling new runs, but keep the definition." The dedicated CronJob controller reconciles roughly every 10 seconds and simply skips scheduling while suspend is true. This is the pattern the rest of this article argues for: **don't make the operator fight the reconciler by deleting an artifact out from under it; give the reconciler an explicit field for the disabled state, so "disabled" is something it converges toward, not away from.**

## Terraform: Lifecycle as an Instruction to the Reconciler, Not a Fact About Reality

Terraform separates the desired-state file (`.tf` configuration) from the record of what was actually provisioned (`.tfstate`), and its `plan`/`apply` split exists so a human can preview the gap before closing it — including the reverse-pass case, where a resource is present in state but absent from configuration and gets flagged for destruction, requiring explicit approval rather than happening silently. Two mechanisms sit directly on the "absence needs a positive record" theme.

**`lifecycle { prevent_destroy = true }`** is a safety rail: Terraform refuses to destroy that resource and throws a plan-time error instead, even if the configuration change would otherwise call for it — a strictly stronger statement than simply leaving the block present.

**The `removed` block** (Terraform 1.7+) is the more direct analog to everything else in this article. Before it existed, forgetting a resource from state without destroying the real infrastructure required an imperative, out-of-band CLI command — `terraform state rm` — not version-controlled, not code-reviewed, and leaving no trace for the next engineer. The `removed` block moves that into declarative configuration itself: `from = aws_instance.legacy` plus `lifecycle { destroy = false }` tells Terraform, in a file that goes through the same PR review as everything else, "stop managing this resource, and don't tear it down while doing so." It is deletion of *management*, expressed as code, with an audit trail — precisely the shape this article argues AI agent component managers need but currently lack.

`ignore_changes` rounds out the set: specific attributes of an otherwise-managed resource are allowed to drift without triggering a corrective apply — the closest Terraform analog to the ownership-registry idea covered in this site's companion desired-state-reconciliation article, where some fields are framework-owned and some deliberately left alone, per-field rather than per-resource.

## Ansible, Puppet, and Chef: Declarative Absence, and the Trap of the Unmanaged

Configuration management tools make deletion a first-class *action verb* rather than an inferred gap: Ansible's `state: absent`, Puppet's `ensure => absent`, Chef's `action :remove` (or `:purge`, which additionally strips configuration files). These are, on their face, the cleanest expression of negative desired state in this survey — a resource block that says, explicitly, "this package/file/user/service should not exist," checked and enforced on every run exactly like a `present` declaration.

The trap sits one level up, and it's the same trap `update-rc.d` falls into: **a resource not mentioned in the manifest at all is not "absent" — it is unmanaged**, a third state these tools do not automatically converge toward either value. If a Puppet manifest used to declare a package `present` and a later revision simply deletes that resource block instead of changing it to `absent`, Puppet doesn't remove the package on the next run — it stops thinking about it at all, and whatever state it was last left in persists indefinitely, invisible to drift detection. This is the configuration-management version of the ambiguity flagged earlier: silence is not a value, and a system whose only source of truth is "what's currently written in the manifest" cannot distinguish "never wanted this" from "changed my mind" from "want this actively gone." Real-world Ansible bug reports bear this out repeatedly — modules where `state: absent` silently no-ops on certain resource types because the provider was never taught to detect and act on the removal case, leaving a manifest that reads as declarative and enforced but is, for that resource, decorative.

## The Distributed-Systems Precedent: Tombstones and Negative Caching

This publication has covered CRDTs as a data-structure topic before (see the January and March entries in this research series), so the point here is narrower and purely load-bearing for the infrastructure argument: **CRDTs need tombstones for structurally the same reason systemd needs mask and dpkg needs to remember conffile deletion.** In a system where replicas can receive operations out of order — an add from replica X arriving after a delete from replica Y has already been applied locally — removing an element from a set on delete is not commutative with a late-arriving add of that same element; applying the two operations in either order produces different final states, which breaks the convergence guarantee that's the whole point of a CRDT. The standard fix in OR-Set-style CRDTs is a tombstone: deletion doesn't erase the element, it marks it deleted with an identifier that dominates any earlier add of the same logical element, so a replica that later receives that earlier add can compare identifiers and correctly conclude the delete wins. Absence has to be a *record with provenance*, not a *state with no record at all*, because a record is the only thing that can be compared against a competing claim ("this should exist") arriving later from elsewhere in the system.

DNS negative caching is a lower-stakes but pleasingly literal instance of the same idea: RFC 2308 makes it mandatory for resolvers to cache NXDOMAIN (name does not exist) responses using the zone's SOA-defined TTL, precisely so that "this name does not exist" is a fact with its own lifetime and its own record, rather than something re-derived from scratch — and re-queried from authoritative infrastructure — on every lookup. And the soft-delete pattern in application databases (`deleted_at` timestamp columns rather than `DELETE FROM`) is the same principle at the application layer: deletion is stored as a fact with a timestamp and, ideally, an actor, precisely so later processes (audits, sync jobs, replication) have something to reconcile against instead of a row that simply isn't there and offers no explanation for why.

The generalized principle, stated once and then applied for the rest of this article: **in any system that converges toward a declared state, "should not exist" must be encoded with the same durability and comparability as "should exist," or it will lose to any process — including the system's own reconciler — that only checks for the positive case.**

## The AI-Agent Twist: An Operator With Soft Memory

Everything above assumes the operator deciding what should not exist is a human, or at minimum a system with a durable, external record of its own decisions — a Terraform config in a git repo, a Puppet manifest under version control, a `wushowhide` database on disk. AI agent platforms with self-healing supervisors — process managers like PM2 that resurrect saved process lists on boot, guardian/activity-monitor processes that restart a stopped agent runtime, component and plugin managers that reconcile installed capabilities against a manifest on every upgrade — introduce a new failure mode this survey doesn't fully anticipate: **the operator itself can be an AI agent, and that agent's record of "I deleted this on purpose, here's why" lives in its own memory, which is exactly the kind of soft, lossy, session-bounded state that the rest of this article has been arguing infrastructure must never rely on for deletion.**

The grounding case makes this concrete. An agent's Lark (a Feishu/Lark-family messaging platform) component was kept installed specifically for its command-line tooling — useful, wanted, actively used. But the same component also ran a long-connection WebSocket service, a separate PM2-managed process, that had sat dead for days after an explicit policy decision to interact with the platform read-only rather than maintain a live connection. The owner directed the agent to delete the service. The agent did the textbook-correct thing by every process-supervisor standard covered above: `pm2 delete` to remove the running process, `pm2 save` to persist the updated process list so a reboot wouldn't resurrect it from `dump.pm2`, and a verification pass confirming no PM2 ecosystem-config entry could re-spawn it. Every mechanism this article has surveyed for "make deletion stick within the process supervisor" was correctly applied.

And yet the agent flagged, correctly, a residual risk none of that tooling closes: **the component's own install manifest almost certainly still declares that service** — because the manifest describes what the Lark component *is*, not what the owner currently wants running. The next time that component is upgraded, the upgrade flow's natural, additive, convergence-seeking default is to read the manifest and ensure every service it declares is registered and running — exactly the way a package's postinst script re-runs `update-rc.d` and silently restores init links an administrator manually removed. The desired state "this service should not exist" was real, deliberate, and correctly actioned at the process-supervisor layer. But it was never written down at the *manifest* layer, the layer the upgrade flow actually reads. It existed only in the agent's own memory of the conversation and in the owner's intent — exactly the "soft state" this article has been arguing is not durable enough to survive a reconciler's next pass.

This is not a hypothetical fragility. Current research on AI agent memory in production converges on the same finding from multiple angles: agent memory is bounded by context, degrades or gets summarized away under compaction, and — for platforms that periodically rotate the runtime session to manage context budget — is explicitly *designed* to be discarded and reconstructed from external persistent stores, not trusted as an authoritative record on its own. A Zylos-style platform's own memory architecture makes this point structurally: identity, state, and references are always-loaded lean summaries, while authoritative detail lives in on-demand reference files, precisely because the always-present context isn't assumed durable enough to be the system of record. Treating "the agent remembers deleting this" as equivalent to "the manifest says this is disabled" is the same category error as treating a pod's current running state as equivalent to its Deployment's desired replica count — one is an observation the next reconciliation pass can overwrite; the other is the input the reconciler actually reads.

The nearest existing precedent for the right fix is not from infrastructure at all — it's the ordinary desktop plugin ecosystem's disabled/uninstalled distinction. VS Code treats "disabled" as a first-class, persisted state distinct from "uninstalled": a disabled extension is not removed, its metadata and settings remain, and it can be re-enabled later — the extension host simply skips loading it while the flag is set. Claude Code's own plugin system makes the same split explicit at the CLI level: `claude plugin disable <plugin>` keeps a plugin installed but inert (its skills, agents, hooks, and MCP servers stop being available) while `enable` reverses it without reinstalling anything, and `uninstall` is a separate, stronger operation entirely. Disabled, in both systems, is a record checked by the loader on every startup — not the absence of one. Nothing about a manifest update or version upgrade quietly overrides it, because the loader's contract is to check the disabled flag before doing anything else with that component.

## A Concrete Service-Disposition Schema

Generalizing from every mechanism above — dpkg's remembered conffile deletion, systemd's mask, Terraform's `removed` block, Kubernetes' `spec.suspend`, VS Code's and Claude Code's disabled state — into something an AI agent component manager can actually implement:

**States, not a boolean.** A per-component-service disposition needs at least four states, because "installed" and "running" are independent axes: `installed+enabled` (normal), `installed+disabled` (present, deliberately inert — the state the Lark case needed and didn't have), `not-installed`, and transitional install/upgrade states. A single "enabled: false" flag on the whole component isn't enough: as in the grounding case, a component can be wanted for one capability (the CLI) while a specific sub-service inside it is unwanted, so disposition needs to be addressable per-service — mirroring VS Code's and Claude Code's per-extension/per-plugin granularity rather than an all-or-nothing switch.

**A record, not an inference.** The disposition must live in a file the install/upgrade flow reads *before* it reconciles services against the component manifest — structurally the same position dpkg's conffile-deletion record occupies relative to a package upgrade, or an ownership registry occupies relative to a config reconciler (as covered in this site's companion piece on config-file reconciliation). A minimal shape:

```json
{
  "component": "lark",
  "service_disposition": {
    "lark-longconn-worker": {
      "state": "disabled",
      "set_by": "agent",
      "authorized_by": "owner",
      "reason": "read-only policy decision; long-connection socket not needed",
      "set_at": "2026-07-12T09:41:00Z",
      "reversible": true
    }
  }
}
```

**Upgrade flows must consult it as a gate, not a hint.** The install/upgrade reconciler's algorithm changes from "for every service in the manifest, ensure it is registered and running" to "for every service in the manifest, check the disposition record first; if disabled, skip registration entirely and leave a note in the upgrade log that a service was intentionally not (re)started." This is precisely `spec.suspend` for CronJobs, or Claude Code checking a plugin's disabled flag before loading its hooks — the reconciler's own vocabulary gains a state it actively honors, rather than the operator fighting the reconciler by deleting an artifact the reconciler will simply recreate.

**Who may flip it, and how it degrades safely.** Mirroring the owner-authorization model already present in this platform's security posture (destructive operations require explicit owner confirmation), the record should carry both who executed the change (`set_by`, which may legitimately be an agent) and who authorized it (`authorized_by`, which should trace to a verified human owner for anything affecting a running service). A missing `authorized_by`, or a record that fails to parse, should default the reconciler to its conservative option — treating the service as *unmanaged* rather than force-enabling or force-removing it — the same conservatism Ansible's forward/reverse-pass design applies to entries whose ownership can't be established with confidence.

**An audit trail, because the whole point was auditability.** Every mechanism surveyed here that got deletion right also got auditability nearly for free, because the record of deletion *is* the audit trail: dpkg's remembered conffile state, Terraform's `removed` block reviewed in a pull request, a CronJob's `suspend` field visible in `kubectl get`. A service-disposition file that is itself plain, diffable, version-controllable JSON or YAML — rather than a database row or, worse, an agent's conversational memory — inherits this property automatically. The `reason` field is not decoration; it answers the exact question the "Operational Memory" argument raises about infrastructure generally — not just *what* is disabled, but *why*, recoverable without a phone call or, in this platform's case, without depending on a specific agent session's now-rotated context.

## Cross-Domain Pattern Summary

| Domain | "Looks off" but isn't durable | The mechanism that actually makes it stick | What breaks without it |
|---|---|---|---|
| systemd | `stop`, `disable` | `mask` (symlink to `/dev/null`) | Dependency chain restarts the "disabled" unit |
| Debian packaging | Deleting init script symlinks | dpkg's remembered conffile-deletion record | Postinst script reinstates links on next upgrade |
| Package versions | Manual pin in a shell alias/habit | `apt-mark hold`, `dnf versionlock` | Routine upgrade silently bumps the version anyway |
| Kubernetes pods | `kubectl delete pod` | `spec.replicas: 0` / delete the Deployment | ReplicaSet controller recreates the pod in seconds |
| Kubernetes scaling | `kubectl scale` under live HPA | Removing the field from HPA-managed scope entirely | HPA overwrites the manual value on its next sync |
| GitOps | Removing a resource from the live cluster by hand | `Prune=false` / `prune: disabled` annotation, or actually removing it from Git | Controller prunes it right back out on next sync, or re-applies it from Git |
| Helm | Manually deleting a chart-managed resource | `helm.sh/resource-policy: keep` | `helm uninstall` deletes it along with everything else |
| Terraform | `terraform state rm` (imperative, untracked) | `removed` block in version-controlled config | No audit trail; next `apply` may re-provision if the block is still declared elsewhere |
| Ansible/Puppet/Chef | Deleting the resource block from the manifest | `state: absent` / `ensure => absent` kept in the manifest | Resource becomes unmanaged, not removed; stale state persists invisibly |
| CRDTs | Removing an element from a local replica's set | Tombstone with a dominating identifier | Late-arriving add from another replica resurrects the element |
| Desktop plugins | Nothing (no such state) vs. disabling | VS Code / Claude Code persisted "disabled" flag | Framework loads the plugin's hooks again on next start |
| AI agent component managers | `pm2 delete` + `pm2 save` on the process alone | *(missing today)* Per-service disposition record in the install manifest | Next component upgrade re-registers the service from the manifest |

## Conclusion

The pattern is consistent enough across six unrelated engineering domains that it stops looking like a coincidence and starts looking like a law: any system built to converge state toward a declaration cannot converge toward the *absence* of something unless that absence is written down with the same durability, place-in-the-pipeline, and authority as everything else the system manages. Every tool that gets this right — mask, `removed` blocks, tombstones, remembered conffile deletions, `spec.suspend`, disabled-vs-uninstalled — does it by demoting deletion from a one-time imperative action to a declarative fact checked on every subsequent reconciliation pass. Every failure mode surveyed here — the resurrected init script, the recreated pod, the pruned PVC, the reappearing package version, the unmanaged-not-absent config resource — is the same bug in different domains' clothes: a reconciler that knows how to check for "should this exist" and has nowhere to check for "should this specifically not."

AI agent platforms with self-healing supervisors and component/plugin managers are not exempt, and they add a wrinkle the infrastructure precedents didn't anticipate: the operator making the deletion decision can itself be an agent whose memory of that decision is bounded, compactable, and not guaranteed to survive the next session. The fix is the same fix as everywhere else in this article, applied to a component manifest instead of a systemd unit or a Terraform resource: a per-service disposition record, checked by the upgrade flow before it reconciles services against the manifest, carrying who disabled it, who authorized it, and why. Until that record exists, "this service should not exist" remains exactly what the grounding case found it to be — true in an agent's memory and an owner's intent, and one routine upgrade away from being quietly, correctly, and wrongly undone.

---

*Sources:*

- *"Difference Between systemctl mask and systemctl disable," Baeldung on Linux, baeldung.com/linux/systemctl-mask-disable*
- *"What is the difference between systemctl disable and systemctl mask?," Linux Audit, linux-audit.com/systemd/faq/what-is-the-difference-between-systemctl-disable-and-systemctl-mask*
- *"systemd: Masking units," Fedora Magazine, fedoramagazine.org/systemd-masking-units*
- *Lennart Poettering, "systemd for Administrators, Part V" (three levels of off), 0pointer.de/blog/projects/three-levels-of-off*
- *update-rc.d(8) manual page, Debian, manpages.debian.org/testing/init-system-helpers/update-rc.d.8.en.html*
- *"Outsmarting dpkg's conffile handling," David Pashley, davidpashley.com/2008/02/05/confmiss*
- *"Everything you need to know about conffiles," Raphaël Hertzog, raphaelhertzog.com/2010/09/21/debian-conffile-configuration-file-managed-by-dpkg*
- *DpkgConffileHandling, Debian Wiki, wiki.debian.org/DpkgConffileHandling*
- *"Locking package versions to prevent updates," Linux Bash, linuxbash.sh/post/locking-package-versions-to-prevent-updates*
- *"Prevent harmful Linux updates with versionlock," perl.com, perl.com/article/prevent-harmful-updates-with-versionlock*
- *"How to Hide (Block) a Specific Windows Update," Windows OS Hub, woshub.com/hide-block-specific-windows-update*
- *Argo CD, "Sync Options," argo-cd.readthedocs.io/en/latest/user-guide/sync-options*
- *Argo CD, "Compare Options," argo-cd.readthedocs.io/en/stable/user-guide/compare-options*
- *Argo CD, "App Deletion," argo-cd.readthedocs.io/en/latest/user-guide/app_deletion*
- *"How to Use Annotations to Prevent Pruning in Flux," OneUptime, oneuptime.com/blog/post/2026-03-13-how-to-use-annotations-to-prevent-pruning-in-flux/view*
- *Flux, "Kustomization," fluxcd.io/flux/components/kustomize/kustomizations*
- *"Kubernetes pod gets recreated when deleted," Medium, medium.com/@haroldfinch01/kubernetes-pod-gets-recreated-when-deleted-a7a8eea832c8*
- *"What Happens When You Create a CronJob in Kubernetes," Tanmay Batham, Medium, tanmaybatham.medium.com/what-happens-when-you-create-a-cronjob-in-kubernetes-a-deep-internal-level-breakdown-70797edda81b*
- *"Kubernetes HPA & VPA: Fix Scaling Conflicts & Death Spiral," ScaleOps, scaleops.com/blog/hpas-three-architectural-flaws-and-why-your-autoscaling-keeps-failing*
- *"Using Finalizers to Control Deletion," Kubernetes Blog, kubernetes.io/blog/2021/05/14/using-finalizers-to-control-deletion*
- *"Use Cascading Deletion in a Cluster," Kubernetes docs, kubernetes.io/docs/tasks/administer-cluster/use-cascading-deletion*
- *"Annotation \"helm.sh/resource-policy\": keep not honored when uninstalling," helm/helm#10890, github.com/helm/helm/issues/10890*
- *Helm, "Chart Development Tips and Tricks," helm.sh/docs/howto/charts_tips_and_tricks*
- *Terraform, "removed block reference," developer.hashicorp.com/terraform/language/block/removed*
- *Terraform, "lifecycle meta-argument reference," developer.hashicorp.com/terraform/language/meta-arguments/lifecycle*
- *"Removing a Resource from the Terraform State Using the 'removed' block," HashiCorp Help Center, support.hashicorp.com/hc/en-us/articles/34185721057555*
- *"Support state: absent on ansible.builtin.template," ansible/ansible#83512, github.com/ansible/ansible/issues/83512*
- *"Potential dangerous behaviour of file module with state=absent," ansible/ansible#14706, github.com/ansible/ansible/issues/14706*
- *Chef Infra, "All Infra Resources," docs.chef.io/resources*
- *"Chef Resource not idempotent," drdroid.io/stack-diagnosis/chef-resource-not-idempotent*
- *"An introduction to Conflict-Free Replicated Data Types · Part 5: Tombstones," Lars Hupel, lars.hupel.info/topics/crdt/05-tombstones*
- *CRDT Glossary, crdt.tech/glossary*
- *RFC 2308, "Negative Caching of DNS Queries (DNS NCACHE)," datatracker.ietf.org/doc/html/rfc2308*
- *"DNS Resolvers: Negative Caching — The Setting That Makes Outages Last Longer," cr0x.net/en/dns-negative-caching-outages*
- *"Understanding Soft Delete and Hard Delete in Software Development," Suraj Singh Bisht, Medium, surajsinghbisht054.medium.com*
- *"How to Use PM2 for Process Management in Node.js," OneUptime, oneuptime.com/blog/post/2026-01-22-nodejs-pm2-process-management/view*
- *PM2, "Ecosystem File," pm2.keymetrics.io/docs/usage/application-declaration*
- *VS Code docs, "Extension Marketplace" (disable vs. uninstall), code.visualstudio.com/docs/editor/extension-marketplace*
- *Claude Code, "Plugins reference," code.claude.com/docs/en/plugins-reference*
- *"Operational Memory: Why Infrastructure Forgets Intent," rack2cloud.com/operational-knowledge-management*
- *Zylos Research, "AI Agent Plugin and Extension Architecture," zylos.ai/research/2026-02-21-ai-agent-plugin-extension-architecture*
- *Zylos Research, "CRDTs and Distributed State Synchronization for Multi-Agent AI Systems," zylos.ai/research/2026-03-17-crdts-distributed-state-sync-multi-agent-systems*
- *Zylos Research, "Desired-State Reconciliation for Agent Runtime Configuration," zylos.ai/research/2026-06-28-desired-state-reconciliation-agent-config-upgrades*
