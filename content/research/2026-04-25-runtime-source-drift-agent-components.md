---
date: "2026-04-25"
title: "Runtime-Source Drift Detection for Agent Component Systems"
description: "How agent component platforms can detect when Git source, installed files, local patches, generated backups, and running services have diverged — with lessons from GitOps, Terraform drift plans, package integrity, and supply-chain provenance."
tags: ["ai-agents", "agent-runtime", "components", "drift-detection", "gitops", "terraform", "provenance", "operations"]
---

## Executive Summary

Agent component systems have a drift problem that looks familiar but is not identical to Kubernetes or infrastructure drift. Source repositories may be merged, an installed component directory may still contain an older version, a runtime process may be running stale code, local hotfixes may exist outside Git, and automated upgrade tooling may leave smart-merge backups that quietly change the operational truth.

For a small agent platform, this can be dismissed as ordinary deployment hygiene. For a persistent AI agent system, it becomes a reliability boundary. Agents run scheduled jobs, answer users across channels, modify files, use credentials, and continue across days. If the operator cannot answer "what source is this running, what local changes exist, and what would change if I upgraded," then component updates become guesswork.

The infrastructure world has already developed useful patterns. Argo CD continuously compares desired Git state with live cluster state. Flux can detect Helm release drift. Terraform separates drift detection from mutation through refresh-only plans. Package managers bind installed artifacts to checksums and lockfiles. SLSA and Sigstore model provenance and verification as first-class supply-chain metadata.

The lesson for agent components is not "turn every agent install into Kubernetes." It is more specific: build a lightweight desired-versus-live control plane around component state.

The minimum useful design has five parts:

- a source manifest: repo, commit, version, lockfile, and expected file hashes
- an installed manifest: actual files, generated files, local edits, backup files, and config pointers
- a runtime manifest: PM2 process, command, cwd, environment source, uptime, and loaded version
- a drift plan: classify differences before changing anything
- a provenance record: who or what produced the installed artifact, and from which source revision

The most important product choice is to treat local mutation as operational state, not as dirt to erase. Agent platforms need detection and review before repair. Auto-healing should be optional and scoped, because local patches, config migrations, and emergency fixes may be intentional.

## Why Agent Components Drift

Agent components occupy an awkward middle ground. They are not just libraries imported by an application. They are also not always immutable services deployed by a strict CI/CD pipeline. A component may include:

- executable scripts
- configuration templates
- PM2 service definitions
- local data directories
- OAuth credentials or token references
- scheduler tasks
- skills or instruction files
- generated artifacts
- user-modified runtime state

That mix creates multiple truths.

Git says what the maintainer merged. The registry says what version is available. The local install directory says what files are actually on disk. PM2 says what process is currently running. The component database says what the platform thinks is installed. Memory or documentation may say something else again.

Drift appears when these truths diverge.

Common examples:

- A PR is merged but the local component was never upgraded.
- The local component was upgraded but PM2 was not restarted.
- A smart merge produced backup files that still affect debugging and operator confidence.
- A local hotfix exists in the installed directory but not in Git.
- Generated instruction files were rebuilt from an older template.
- A package version was bumped but a runtime model list still differs across adapters.
- A config file points to the new service while the running process still uses the old cwd.

None of these are exotic. They are normal operations in a fast-moving agent environment. The failure is not that drift exists. The failure is when the system cannot see it.

## The GitOps Lesson: Desired Versus Live State

GitOps systems make one idea operationally powerful: desired state and live state should be continuously comparable.

Argo CD calculates differences between desired state and live state to decide whether an application is out of sync, and exposes those differences in the UI. Its newer server-side diff mode uses Kubernetes server-side apply in dry-run mode to predict the live object before actually syncing. That matters because admission controllers and server defaults can affect what would really happen.

For agent components, the direct equivalent is not a Kubernetes manifest. It is a component manifest:

```json
{
  "component": "recruit",
  "source": {
    "repo": "zz-howard/zylos-recruit",
    "commit": "3b1f59f",
    "version": "0.2.9"
  },
  "install": {
    "path": "~/zylos/.claude/skills/recruit",
    "hashManifest": "sha256:..."
  },
  "runtime": {
    "service": "zylos-recruit",
    "manager": "pm2",
    "expectedCwd": "~/zylos/.claude/skills/recruit"
  }
}
```

A drift detector can then compare:

- desired source commit versus installed metadata
- expected file hashes versus actual files
- declared service cwd versus PM2 cwd
- declared start command versus PM2 command
- declared config pointers versus actual config files
- generated files versus their source templates

This is the smallest useful GitOps translation: not automated deployment, but inspectable desired-versus-live comparison.

## The Terraform Lesson: Review Drift Before Repair

Terraform's drift workflow is valuable because it separates observation from mutation. Its refresh-only plan detects differences between state and real infrastructure without changing remote resources. The operator can then decide whether to import, update state, change configuration, or revert the live change.

Agent components need the same discipline. A command like `zylos component drift recruit` should not immediately repair anything. It should produce a plan:

```text
Component: recruit
Status: Drifted

Source:
  expected: zz-howard/zylos-recruit@3b1f59f v0.2.9
  installed: zz-howard/zylos-recruit@3b1f59f v0.2.9

Files:
  modified:
    server/routes/candidates.js
  untracked:
    backups/server.routes.candidates.js.20260425
  generated-stale:
    AGENTS.md

Runtime:
  pm2 service: zylos-recruit
  status: online
  cwd: matches
  started before last install: yes

Recommended action:
  review local file modification before upgrade
  restart service after accepting installed state
```

This plan should classify drift by intent and risk:

- **source drift:** installed version differs from declared source version
- **file drift:** installed files differ from expected hashes
- **runtime drift:** service is running a different path, command, version, or start time
- **config drift:** config keys or schema differ from expected version
- **generated drift:** derived files are stale relative to templates
- **local patch drift:** files changed locally outside the source repo
- **backup drift:** smart-merge backup files exist and may need review or cleanup

The key is that drift is not always a bug. Terraform explicitly allows operators to record, import, or reconcile drift depending on whether the live change was intended. Agent platforms need the same posture.

## The Package-Manager Lesson: Integrity Needs a Local Ledger

Package managers solve part of this problem with lockfiles and integrity hashes. They record exactly which package version and artifact hash was installed. If the artifact changes unexpectedly, the installer can detect the mismatch.

Agent components should borrow this pattern, but extend it beyond package tarballs. A useful component ledger should record:

- component name and version
- source repository and commit
- installer version
- install timestamp
- expected file hashes
- ignored paths
- generated paths and their source templates
- config schema version
- service manager metadata
- postinstall scripts that ran
- migration scripts that ran

This ledger should live next to the component installation and also be referenced from the platform's component database. The local file is useful when the central registry is wrong or unavailable. The database reference is useful for fleet-level queries.

For AI agent systems, the ignored-path design is especially important. Runtime data, OAuth tokens, local config, logs, and memory should not be hashed as if they were source files. The manifest needs a clear boundary between:

- immutable installed code
- generated-but-reproducible files
- mutable runtime data
- secret-bearing config
- operator-owned local patches

Without that boundary, drift reports become noisy and operators stop trusting them.

## The Provenance Lesson: Know Where the Artifact Came From

Drift detection answers "what changed." Provenance answers "where did this installed thing come from."

The SLSA specification frames provenance as a way to trace software artifacts back to their source and build process. Sigstore and cosign apply similar ideas through signatures and attestations. The full enterprise supply-chain stack may be too heavy for a small agent component system, but the underlying data model is useful.

At minimum, an agent component install should record:

- source repo URL
- source commit SHA
- version tag
- installer identity
- install command
- build or packaging command, if any
- artifact digest
- timestamp
- verification result

For third-party skills or components, this is a security boundary. If a component can read files, send messages, use credentials, or modify services, then the platform should know whether it was installed from a trusted release, a branch, a local path, or an unknown artifact.

The long-term version of this is signed component releases. The practical first version is a local attestation file that says: "this install claims to be component X at commit Y, installed by tool Z at time T, with these file hashes."

## Runtime Drift Is Different From File Drift

Most deployment tools focus on desired versus installed files. Agent components also need runtime drift detection.

A component can be correct on disk and wrong in process. PM2 may still be running a process that started before the last upgrade. The command may point to an old path. Environment variables may have changed in `.env`, but the process may not have been restarted. A service may be online but serving a stale bundle.

Runtime drift checks should answer:

- Is the service online?
- What command and cwd is it running?
- When did it start?
- Was it started before or after the last install?
- Which version does its health endpoint report?
- Which config file path does it use?
- Does the service manager definition match the component manifest?
- Are there orphaned processes from previous versions?

For PM2-based systems, much of this can be collected from `pm2 jlist`, service health endpoints, local install metadata, and config files. The detector does not need a full orchestrator. It needs a consistent comparison model.

Runtime drift also creates a better upgrade UX. After an install, the platform can say:

```text
Installed files updated.
Runtime drift remains: service zylos-recruit started before this install.
Run restart to activate the new version.
```

That is more honest than treating "files copied" as "component shipped."

## Smart Merge Backups Are Drift Signals

Agent component systems often need to preserve local edits during upgrades. A smart merge that saves backup files is better than blindly overwriting operator changes. But those backups should not disappear from the operational model.

A backup file means one of three things:

1. a local patch was intentionally preserved
2. a merge conflict was avoided but still needs human review
3. stale backup debris is accumulating and confusing future debugging

All three should be visible.

Backups should be recorded in the installed manifest with:

- original path
- backup path
- reason
- timestamp
- source version before merge
- source version after merge
- whether the operator acknowledged it

This turns backup files from "mysterious leftovers" into actionable state. A drift report can then say:

```text
Backup drift:
  2 smart-merge backups exist
  1 acknowledged
  1 unreviewed
```

That is enough to support cleanup without losing auditability.

## A Minimal Architecture for Agent Component Drift Detection

A lightweight implementation can be built without adopting Kubernetes, OCI registries, or a full signing pipeline.

### 1. Component Install Manifest

Each install writes `.zylos-component/install.json`:

```json
{
  "name": "recruit",
  "version": "0.2.9",
  "sourceRepo": "zz-howard/zylos-recruit",
  "sourceCommit": "3b1f59f",
  "installedAt": "2026-04-25T12:00:00Z",
  "installer": "zylos-core@0.4.13",
  "files": {
    "server/index.js": "sha256:...",
    "package.json": "sha256:..."
  },
  "generated": {
    "AGENTS.md": {
      "template": "CLAUDE.md",
      "generator": "instruction-builder@0.4.13",
      "hash": "sha256:..."
    }
  },
  "ignore": [
    "data/**",
    "logs/**",
    "config.local.json",
    ".env"
  ]
}
```

### 2. Runtime Manifest

Each component declares expected runtime shape:

```json
{
  "serviceManager": "pm2",
  "serviceName": "zylos-recruit",
  "cwd": "~/zylos/.claude/skills/recruit",
  "command": "node server/index.js",
  "health": "http://127.0.0.1:3020/health"
}
```

### 3. Drift Scanner

The scanner collects four snapshots:

- source snapshot from Git or registry metadata
- installed snapshot from the local manifest and file hashes
- runtime snapshot from PM2 and health endpoints
- config snapshot from schema version and declared config paths

Then it emits a classified drift plan.

### 4. Operator Actions

The detector should suggest but not force actions:

- `accept-local`: record intentional local edits
- `restore-source`: overwrite local edits from source
- `restart`: restart runtime service
- `regenerate`: rebuild generated files
- `cleanup-backups`: remove acknowledged backups
- `import`: bring a local component into the component database
- `upgrade`: apply a newer source version

The important rule: every mutating action should be explicit and reviewable.

## Why Auto-Healing Should Be Conservative

Argo CD supports self-healing when live cluster state deviates from Git. That is powerful in a Kubernetes deployment because the desired state is meant to be declarative and authoritative.

Agent components are messier. Local mutation may represent a live emergency patch, a user-specific integration, a credential migration, or a deliberate temporary override. Automatically erasing those changes can break the exact system the operator is trying to preserve.

So the default should be:

- detect continuously
- classify clearly
- alert only on meaningful drift
- repair only with an explicit command

Auto-healing can still be useful, but only for narrow classes:

- generated files that are purely reproducible
- stale runtime after a successful upgrade, when restart policy allows it
- missing non-secret cache directories
- obsolete acknowledged backup files

For source files, config, credentials, and runtime process replacement, review should come first.

## What This Enables

A drift detector sounds like maintenance tooling, but it unlocks larger product capabilities.

### Safer Component Upgrades

Before upgrading, the platform can show whether the local component is clean, patched, stale, or running old code. That prevents the common mistake of treating merge as ship.

### Better Support and Debugging

Support can ask for a drift report instead of a vague directory listing. The report can reveal stale PM2 processes, mismatched commits, unreviewed backups, or config schema gaps.

### Fleet Awareness

If many Zylos instances run the same component, a central view can show which machines are on which version, which have local patches, and which are running stale processes.

### Security Review

Third-party components can be flagged when installed from unverified commits, local paths, unsigned artifacts, or modified files.

### Regression Confidence

When a component bug is fixed, the platform can verify not only that the PR merged, but that the fix reached the installed files and the running process.

## Implementation Roadmap

### Phase 1: Local Drift Reports

Build a CLI command that compares installed manifests, file hashes, PM2 status, and source metadata for one component. Output text and JSON. Do not mutate anything.

Success criterion: the report can distinguish clean, source drift, file drift, runtime drift, and backup drift.

### Phase 2: Upgrade Gate

Run drift detection before install or upgrade. If local patches or unreviewed backups exist, require explicit operator confirmation. After install, report remaining runtime drift and suggest restart.

Success criterion: upgrades no longer silently overwrite local edits or leave stale runtime state unnoticed.

### Phase 3: Provenance and Verification

Record source commit, artifact digest, installer version, and verification result. For trusted components, verify tags or release artifacts. For local installs, mark provenance as local and unverified.

Success criterion: every installed component can answer where it came from.

### Phase 4: Fleet Summary

Aggregate drift reports across instances. Track installed version, running version, local patch count, unreviewed backup count, and service health.

Success criterion: operators can see which instances are actually running a merged fix.

### Phase 5: Policy and Selective Auto-Heal

Add policies for low-risk automatic actions: regenerate derived files, clean acknowledged backups, restart after selected upgrades, or alert on unverified third-party components.

Success criterion: automation reduces routine cleanup without erasing meaningful local state.

## The Core Design Principle

The right mental model is not "keep the install directory clean." It is "make operational truth inspectable."

Agent platforms will always have local state. They will have generated files, credentials, human edits, service restarts, emergency patches, and component-specific migrations. Pretending all of that can be forced into a pure Git checkout creates brittle tooling.

A better system accepts that drift exists, records it, classifies it, and gives the operator reviewable repair paths.

That is the practical bridge between GitOps discipline and agent-runtime reality: Git remains the desired source of truth, but the live system is allowed to speak before the platform changes it.

## References

- Argo CD Documentation: [Diff Strategies](https://argo-cd.readthedocs.io/en/release-3.1/user-guide/diff-strategies/)
- Argo CD Documentation: [Automated Sync Policy](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/)
- Flux Documentation: [Drift detection for Helm Releases](https://fluxcd.io/flux/installation/configuration/helm-drift-detection/)
- HashiCorp Developer: [Manage resource drift](https://developer.hashicorp.com/terraform/tutorials/state/resource-drift)
- SLSA Specification v1.2: [SLSA specification](https://slsa.dev/spec/)
- Kubernetes Documentation: [Server-Side Apply](https://kubernetes.io/docs/reference/using-api/server-side-apply/)
- Sigstore Documentation: [Verify signatures and attestations with cosign](https://docs.sigstore.dev/cosign/verifying/verify/)
