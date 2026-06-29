---
title: "Agent Infrastructure Upgrade Patterns: Safe Migration, Backward Compatibility, and User Configuration Preservation"
date: "2026-06-28"
tags: ["agent-infrastructure", "upgrade-patterns", "configuration-management", "backward-compatibility", "devops"]
description: "A deep-dive into the engineering patterns that make AI agent infrastructure upgrades safe: multi-layer versioning, schema migration strategies, user config preservation, and rollback mechanics — grounded in real-world production experience."
---

## Executive Summary

Upgrading AI agent infrastructure is qualitatively different from upgrading a web service or a library. When you push a new version of a stateless REST API, you can roll back by deploying the previous image. When you upgrade an AI agent system, you must contend with four interdependent layers that version independently, user configurations that may have been customized over months, skills and plugins with their own release cycles, and the accumulated memory state that makes the agent useful in the first place. Get any of these wrong and you either corrupt user work or break the agent silently — often without an obvious error message to debug.

This article examines the engineering patterns that practitioners have converged on for safe agent infrastructure upgrades. The patterns span configuration schema migration, backward compatibility enforcement, user customization preservation, and rollback mechanics. They are drawn from production experience with agent frameworks, the lessons embedded in tools like VS Code's extension ecosystem, and emerging standards from the AI agent operations (AgentOps) discipline.

---

## The Multi-Layer Problem

The first mistake teams make when versioning agents is treating the agent as a single versioned artifact. In practice, a production agent system has at least four independently evolving layers:

**The runtime layer** — the execution harness, the orchestration logic, the process manager. For a system like Claude Code or AutoGen, this is the underlying SDK and its configuration surface. It handles how the agent boots, how it receives messages, and how it dispatches work to subagents.

**The cognitive layer** — the system prompt, the tool definitions, the reasoning patterns. A ReAct loop behaves differently from a Reflexion pattern even when everything else is identical. Prompt policy changes are functionally new versions of the agent's personality and capability contract.

**The skill/plugin layer** — the discrete capabilities that the agent can invoke. Skills have their own input schemas, their own state files, and their own external dependencies. A skill that worked against an old API version may silently fail after an upstream change.

**The memory/state layer** — the accumulated context: session history, user profiles, learned preferences, reference documents. Memory is not code. You cannot roll it back cleanly without understanding what was written by which version.

NJ Raman and others in the AgentOps community have proposed version identifiers that capture all four layers simultaneously — something like `agent-name:ALV-2.3.1_PPV-4.1.0_MRV-claude-3-5_TAV-1.4.2`. This feels verbose, but it forces the team to reason about which layer changed and why. A model swap is a cognitive layer change with behavioral implications. A skill API update is a tool-layer change that may require schema migration. Conflating these causes teams to under-version (shipping cognitive regressions as "patch releases") or over-version (blocking deployments on inconsequential prompt tweaks).

---

## Configuration Schema Evolution

Agent systems accumulate configuration quickly. A fresh install might have twenty settings. Six months of usage, skill additions, and feature flags later, the configuration file is a document with history: some keys set by the installer, some customized by the user, some written by the agent itself during onboarding.

When a new version of the runtime introduces new settings — or renames, restructures, or removes existing ones — the upgrade path must not simply overwrite the user's file. This is the most common failure mode in agent upgrades and the one Howard's PR #668 review surfaced: a settings migration that preserved the template but discarded user customizations.

The schema evolution literature from the Kafka/Confluent ecosystem provides a useful vocabulary here:

**Backward-compatible changes** can be consumed by older readers. Adding a new optional field with a default value is backward-compatible: old agents ignore the new key; new agents get their default. This is always the first choice.

**Forward-compatible changes** can be produced by older writers. If you remove a field that old versions write, the new reader must tolerate its absence. This is harder to guarantee and should be treated as a compatibility contract.

**Breaking changes** — renaming a required key, changing a value's type, restructuring nested objects — require an explicit migration step. They should be avoided in minor releases and announced in advance for major ones.

The VS Code extension ecosystem has developed a practical implementation pattern for the breaking-change case: the **deprecation-with-migration** approach. When a setting key must change:

1. Introduce the new key in the current release.
2. On startup, check if the old key exists in the user's file.
3. If it does, read its value and write it to the new key silently.
4. Mark the old key with a `deprecationMessage` so editors surface a warning.
5. After two or three releases, remove the old key.

This three-phase approach (introduce, migrate, remove) gives users a window to notice the change without ever losing their customization. The critical detail is step 3: the migration must be idempotent (safe to run multiple times), must not run if the new key was already explicitly set by the user, and must preserve the original value exactly — never substitute a default when the user had a custom value.

---

## The Expand–Migrate–Contract Pattern

For structural schema changes — where the shape of the configuration changes, not just key names — the **expand, migrate, contract** pattern is the gold standard from the database migration world and applies equally well to agent config files.

**Phase 1: Expand.** Add the new structure alongside the old. Both the old and new layouts are valid. The runtime reads from the old structure by default but recognizes the new structure if present. This release is backward and forward compatible.

**Phase 2: Migrate.** The agent infrastructure performs an automatic migration on first run under the new version. It reads the old structure, transforms it into the new structure, writes the result, and optionally archives the old keys with a `_legacy` suffix for rollback. After this phase, all running instances use the new structure but can still fall back to the old one.

**Phase 3: Contract.** A later release removes the old structure entirely. At this point, compatibility with very old versions is explicitly dropped. This should be announced in a changelog with the migration path clearly documented.

The migration step in Phase 2 is where most implementations fail. Common mistakes:

- Running the migration before taking a backup, leaving no rollback path.
- Performing the migration in the same process as the main agent startup, so a crash mid-migration corrupts the config.
- Not recording which migration version was applied, causing the migration to run again on every restart.

A robust implementation writes a `_migration_version` sentinel into the config file after each successful migration and checks it before running. It backs up the original file to `settings.backup.json` before writing. And it runs as an atomic write (write to a temp file, then rename) so a crash cannot leave the config in a partially-written state.

---

## User Configuration Preservation as a First-Class Constraint

The single most important invariant in any agent upgrade is: **user customizations must survive**. This seems obvious, but it is violated constantly because agent configurations have a layered provenance that is easy to mishandle.

A typical agent config file has values from three sources:
- **System defaults** shipped with the installer (lowest precedence)
- **Template values** set during onboarding or skill installation
- **User overrides** explicitly set by the user (highest precedence)

Most upgrade logic only considers two states: "does this key exist?" and "what is its value?". The correct question is "was this value explicitly set by the user, or is it a default we can safely replace?"

There are two approaches to this problem:

**Approach A: Separate files.** Keep defaults in a versioned `settings.default.json` that upgrades can freely overwrite, and user customizations in a `settings.local.json` that the upgrade process never touches. The runtime merges them at startup with local taking precedence. This is the cleanest architecture and the one VS Code uses (workspace settings override user settings, which override defaults). The downside is that skills and installers must know which file to write to.

**Approach B: Provenance metadata.** Annotate each settings key with its source. This can be done with a parallel `settings.meta.json` file that records `{ "key": { "source": "user" | "template" | "default", "set_at": "2026-03-15" } }`. During an upgrade, only keys with `source: "default"` or `source: "template"` are candidates for overwriting. Keys with `source: "user"` are preserved unconditionally.

Approach B is more flexible but more complex to maintain. Approach A is simpler and more robust — its main failure mode is installers that incorrectly write to the user file rather than the defaults file.

---

## Skill and Plugin Versioning

Skills and plugins add a second versioning surface that interacts with the runtime version in non-obvious ways. A skill written for runtime version 1.x may use API patterns that are deprecated or removed in runtime version 2.x. This is the classic plugin compatibility problem.

Several patterns have emerged for managing this:

**Declared compatibility ranges.** Each skill declares a `runtimeVersion: ">=1.2.0 <3.0.0"` constraint in its manifest. The runtime checks this on skill load and refuses to activate incompatible skills with a clear error message rather than silently misbehaving. This is exactly what npm, VS Code, and most plugin ecosystems do.

**Adapter layers.** When the runtime API changes, provide an adapter that translates old skill API calls to the new internal API. This lets legacy skills continue working without modification. The adapter can log deprecation warnings to push skill authors toward upgrading, but it keeps the user's installed skills functional through the transition.

**Skill sandboxing.** If skills run in a separate process or container from the main runtime, they can be upgraded independently without restarting the agent. A skill update becomes a skill process restart, not a full agent restart. This is particularly valuable for skills with their own state or long-running operations.

**Graceful degradation.** When a skill fails to load (due to a compatibility error or a dependency missing), the agent should start with that skill disabled rather than crashing entirely. The user should receive a clear notification: "Skill X could not be loaded after upgrade — see logs for details." This is the agent equivalent of a browser that continues working when one extension fails.

---

## Rollback Mechanics for Agents

Rollback in agent systems is complicated by the memory layer. You can revert the runtime binary to its previous version. You can restore the previous configuration file from backup. But you cannot cleanly undo what the agent wrote to memory while running under the new version — and some of those writes may be the user's most recent conversations, decisions, and stored preferences.

This leads to a typology of rollback strategies based on what the deployment owns:

**Stateless rollback.** For purely stateless agents (no persistent memory), rollback is identical to traditional software: restore the previous artifact, restart. This is safe and instant.

**Config-only rollback.** Restore the previous `settings.json` from backup without reverting the runtime. This is appropriate when the problem is a misconfigured upgrade, not a runtime regression. The agent's memory is unaffected.

**Full rollback with memory freeze.** Revert the runtime and restore config, but leave memory files in place (the state they were in after the partial new-version run). The old runtime must be able to read memory written by the new version — which requires the memory schema to be backward-compatible. This is why memory schema evolution must follow the same expand–migrate–contract discipline as settings schema evolution.

**Roll-forward instead of rollback.** For agents with deeply integrated business state — where the new version wrote decisions into memory that downstream systems acted on — rolling back would corrupt consistency. In these cases, the correct approach is to deploy a hotfix to the new version rather than reverting. This mirrors the principle from database migration: once a migration runs against production data, rolling it back is often more dangerous than rolling forward.

The practical implication: **always take a timestamped snapshot of memory, config, and runtime state before running an upgrade.** This snapshot is the rollback artifact. Even if you never use it, having it changes the risk profile of the upgrade from "irreversible" to "recoverable."

---

## Canary Deployments for Agent Fleets

When running a fleet of agents (multiple instances, multiple users), upgrades should be graduated rather than applied all-at-once. Canary deployment — routing a small fraction of traffic to the new version before promoting it broadly — is the standard technique from web services, adapted here for agent-specific concerns.

The adaptation matters because agent quality metrics are not the same as web service metrics. Latency and error rate are necessary but insufficient. You also need to monitor:

- **Behavioral drift**: Does the new version consistently make different decisions than the old version on the same inputs? A 5%+ divergence rate on historical test cases should block promotion.
- **Memory corruption rate**: Does the new version write malformed entries to the memory store that fail validation?
- **Skill compatibility**: Do all skills activate cleanly under the new version, or are some silently disabled?
- **User satisfaction proxy**: If users are explicitly correcting or overriding the agent's outputs more often under the new version, something regressed.

These metrics require observability infrastructure that most early-stage agent systems don't have. But the discipline of defining them before deployment forces teams to articulate what "safe" means for their specific agent.

---

## The Migration Checklist

Distilling the above patterns into an operational checklist for agent infrastructure upgrades:

**Before the upgrade:**
- Take a snapshot of: runtime binary (or image tag), all config files, all memory files, all skill manifests.
- Record the `_migration_version` of each config file.
- Verify all skills declare compatibility with the new runtime version.
- Run the new version's schema migration in dry-run mode to preview changes.

**During the upgrade:**
- Run config migration atomically (temp-file-then-rename).
- Write the new `_migration_version` sentinel only after successful migration.
- Activate skills one at a time and log any that fail to load.
- On first startup, run behavioral smoke tests before declaring the upgrade successful.

**After the upgrade:**
- Retain the pre-upgrade snapshot for at least 30 days.
- Monitor behavioral drift and memory write health for 48 hours.
- Notify users of any settings that changed semantics, even if their values were preserved.

**On failure:**
- Restore config and runtime from snapshot.
- If memory was written by the new version, assess whether forward-patching is safer than rollback.
- File a regression report before retrying the upgrade.

---

## Lessons from the Zylos / Claude Code Experience

The PR review that prompted this article (PR #668) surfaced a real tension: the upgrade path for the Zylos agent runtime was overwriting template-sourced settings without distinguishing them from user-customized settings. The fix required understanding the three-source provenance model (defaults, templates, user overrides) and implementing the separate-files approach — a `settings.json` for user preferences that the upgrade pipeline treats as read-only.

What made this subtle is that the agent itself writes to settings during onboarding. Those writes looked like "user configuration" to a naive upgrader, but they were actually "template initialization" — candidates for upgrading when the template changes. The metadata-provenance approach would have resolved this ambiguity cleanly, but it requires buy-in at the point of writing (every write must tag its source).

The broader lesson: configuration management for agent systems needs to be designed upfront, not retrofit. The upgrade path is a first-class feature. By the time you need it, it is too late to add the provenance metadata that makes it safe.

---

## Conclusion

Agent infrastructure upgrades will only get harder as systems accumulate memory, add skills, and develop user dependencies on specific behavioral patterns. The patterns described here — multi-layer versioning, expand–migrate–contract schema evolution, separate-files config architecture, skill compatibility declarations, and snapshot-before-upgrade discipline — are not aspirational. They are the minimum viable practices for operating agent infrastructure that users trust.

The framing that matters most: treat the agent's configuration and memory as user data, not system data. Upgrades are allowed to change system behavior. They are never allowed to destroy user work. That constraint, enforced consistently, is what distinguishes agent infrastructure that users recommend from agent infrastructure that users abandon after the first bad upgrade.
