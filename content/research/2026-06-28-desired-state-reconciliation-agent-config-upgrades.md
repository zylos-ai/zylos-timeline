---
date: "2026-06-28"
title: "Desired-State Reconciliation for Agent Runtime Configuration: Upgrading Without Clobbering User Edits"
description: "How to treat a long-running AI agent's local config files — hook registries, settings.json, service manifests — as declarative desired state that converges across upgrades without destroying user customizations, drawing on Kubernetes controllers, Terraform, NixOS, GitOps, and three-way merge theory."
tags:
  - configuration-management
  - desired-state
  - reconciliation
  - ai-agents
  - upgrades
  - kubernetes
  - terraform
  - gitops
  - nixos
  - three-way-merge
  - idempotence
  - platform-engineering
---

## Executive Summary

Every long-running AI agent platform eventually confronts a deceptively hard problem: how do you upgrade the framework's default configuration — adding new hook registrations, updating session-start handlers, evolving settings.json defaults — without silently overwriting changes the user made to those same files? The naive approaches all fail in predictable ways. "Just overwrite on upgrade" destroys user edits. "Never touch user files after first install" means the agent runs stale or broken defaults forever. "Apply a patch script per version" accumulates O(n) fragile assumptions across n release cycles until the migration logic collapses under its own weight.

The infrastructure world has spent thirty years building principled answers to this class of problem: Kubernetes controller loops, Terraform plan/apply, Ansible idempotence, GitOps drift detection, and NixOS generational replacement all encode variations of the same core insight — desired-state reconciliation. This article extracts the transferable principles from those systems and applies them concretely to local agent config management, with a focus on the four hardest sub-problems: the framework-vs-user ownership split, canonical identity for config entries, the forward/reverse pass pair, and cross-platform portability.

The audience is AI agent platform engineers who are building or maintaining CLI upgraders for persistent agent runtimes — systems like Zylos, where a locally-installed agent process has configuration files that evolve with each framework release while users simultaneously customize those same files for their workflows.

---

## Why Config Convergence Is Hard: The Competing Ownership Problem

Configuration files in agent runtimes serve two masters simultaneously. The framework owns a set of "template entries" — defaults and required registrations that must exist and stay current as the platform evolves. The user owns customizations — personal hooks, overridden timeouts, additional event subscriptions — that live in the same files and must survive every upgrade.

This dual-ownership structure creates a fundamental tension. Three failure modes emerge immediately:

**Silent overwrite.** The upgrader replaces the entire config file with the new template, clobbering everything the user wrote. Fast to implement, catastrophic in effect. This is the failure mode that produces the most user complaints.

**Frozen framework entries.** The upgrader never touches files that already exist. The framework adds a new required hook in v1.4, but users who installed at v1.2 never get it. The agent silently runs without the new capability.

**Patch accumulation.** Each release ships a migration script that checks for the previous release's output and applies a targeted patch. By release v1.8, the migration script contains nested conditionals checking for the presence of strings from v1.1, v1.2, v1.3, v1.4, and v1.5, each with subtly different matching heuristics for path normalization, whitespace, and comment presence. The script is untestable and breaks on any config the original author did not anticipate.

The third failure mode is particularly common in practice because it appears to work for a long time before it does not. Each individual patch is easy to write; the complexity accumulates invisibly until a new platform (different OS, different home directory layout, Docker container) exposes an untested assumption.

---

## Foundations: How Infrastructure Tools Solve Desired-State Convergence

Before designing a solution, it is worth extracting the proven patterns from tools that have operated at scale.

### Kubernetes: Level-Triggered Reconciliation

The Kubernetes controller model is the most explicit formalization of desired-state reconciliation. Every controller follows the same structure:

1. Watch for changes to objects (via informers backed by an API server cache)
2. Enqueue changed objects into a work queue
3. For each dequeued item, call `Reconcile(ctx, request)`: read the object's `.spec` (desired state), compare it to `.status` (current reality), issue create/update/delete API calls to close the gap
4. Return a result indicating whether to requeue (for retries or periodic re-sync)

The critical design choice is **level-triggering**, not edge-triggering. The reconciler does not ask "what event happened?" — it asks "what is the current state, and does it match the desired state?" If a watch event is missed, the periodic re-sync guarantees eventual convergence. If the reconciler crashes mid-operation, re-running it produces correct results because the reconciler observes actual state before deciding what to do.

This is directly applicable to agent config management: the upgrader should not ask "what migrations have I run?" but rather "what is in this config file right now, and does it match the template?" State machines over versions are fragile; observation-based convergence is robust.

The `.spec` / `.status` split maps cleanly to the agent config problem: the template is `.spec` (what should be there), and the actual config file is `.status` (what is there). The reconciler's job is to close the gap while respecting user ownership.

### Terraform: Resource Identity and Planned Destroys

Terraform's approach introduces two concepts that the Kubernetes model underweights: **canonical resource identity** and **planned destruction of obsolete resources**.

Each Terraform resource has an address of the form `provider.resource_type.resource_name` (e.g., `aws_s3_bucket.my-bucket`). This address is the canonical key used to match the desired-state declaration in `.tf` files against the recorded state in `terraform.tfstate`. When you rename a resource in the configuration, Terraform sees a destruction of the old address and a creation of the new one — unless you use `moved` blocks to provide an explicit identity mapping.

The plan/apply cycle separates **diff computation** (what would change, if applied?) from **execution** (actually change it). This gives operators a preview and an opportunity to catch misidentified resources before destruction. For agent config management, the analog is a `--dry-run` or `--preview` mode that prints proposed changes without writing them.

Terraform also handles the reverse problem explicitly. Resources present in the state file but absent from the current configuration are **planned for destruction**. The operator must explicitly approve this. This is the **reverse pass** — removing entries that the framework no longer ships — and Terraform makes it deliberate, not automatic.

The `lifecycle { ignore_changes = [attribute] }` block allows specific resource attributes to be declared user-owned: Terraform will not overwrite them even when the configuration specifies a different value. This is the nearest analog to per-attribute ownership in config files.

### Ansible: Idempotent Modules and the Check Mode Pattern

Ansible's contribution to this design space is the **module-level idempotence contract**: every module must check whether the desired state already exists before taking action, and must report `ok` (no change) vs `changed` (modified) accurately. A playbook run twice against a system in the desired state produces zero changes.

This contract is enforced culturally and by the module API (`changed_when`, `failed_when`), not by the framework. The practical test for idempotence is to run the playbook twice in sequence and assert that the second run reports `changed=0`. Ansible's Molecule testing framework automates this as an "idempotence test" — a standard step in role CI pipelines.

For agent config management, this implies: running the upgrader twice must produce identical results and must not report changes on the second run. Any upgrade step that passes on first run but fails on second is a bug, not a warning.

### GitOps: Drift Detection and Pruning

ArgoCD and Flux CD operationalize the GitOps principle: Git is the single source of truth for desired state, and a controller continuously watches for divergence between the Git-declared desired state and the live cluster state.

The reconciliation loop in both tools works on a configurable period (default: 3 minutes in ArgoCD, 1 minute in Flux). Any resource present in the live cluster but absent from the Git manifest can be **pruned** (deleted) automatically, but pruning is opt-in because accidental deletion is destructive. This is the same conservatism Terraform applies to planned destroys.

The key GitOps insight for local config management: **Git history is the ownership registry**. When did this configuration entry first appear? Who authored it? These questions are answerable from the commit log, and a config management system that maintains its own history (even just a metadata file) gains similar traceability.

### NixOS: Generational Replacement as the Extreme

NixOS takes the most radical position: rather than patching the running system, each `nixos-rebuild switch` builds a complete new system generation in `/nix/store` and atomically activates it. The old generation remains available for rollback via symlink switching.

This solves the partial-update problem completely — there is no partial state, only a clean transition from one generation to another. If activation fails, the symlink is not updated and the system remains on the previous generation.

The lesson for agent config management is not "build immutable generations" (too heavyweight for local config files) but rather **transactional activation**: compute the complete desired config state, write it to a temporary file, validate it, then atomically rename it into place. If any step fails, the original config is unchanged. This prevents the "half-written config" failure mode where the upgrader crashes between entries.

---

## The Ownership Problem: Three Strategies

With the infrastructure background established, the core config management problem sharpens: how do you track which entries are framework-owned (safe to update/remove) versus user-owned (must be preserved)?

### Strategy 1: Three-Way Merge

Three-way merge is the mechanism git uses to reconcile diverging branches. Given three versions:
- **Base**: the last common ancestor (what the config looked like when the user received it from the framework)
- **Theirs**: the new framework template (what the framework wants it to look like now)
- **Ours**: the current on-disk config (what the user has modified it to be)

The algorithm applies changes from base→theirs to ours, except where ours has already diverged from base in the same region (indicating a user edit). Conflicts — where both the framework and the user modified the same region since the base — are surfaced explicitly rather than silently resolved.

`git merge-file` implements this at the text level: given three files (current, base, other), it produces a merged output with `<<<<<<<` markers for conflicts. Config management systems can use this algorithm directly by storing the previous framework template as the "base" and running a three-way merge on each upgrade.

**Strengths:** Handles the majority of non-conflicting changes automatically. Works at the text level without requiring semantic understanding of the config format.

**Weaknesses:** Config files are not always line-oriented text amenable to line-diff. JSON/YAML structured diffs are more accurate but require format-specific merge logic. Storing the "base" (previous template) requires careful bookkeeping — it is easy to lose track of what version of the template was last applied.

### Strategy 2: Managed-Section Markers

Section markers partition the config file into framework-owned zones and user-owned zones using comment delimiters:

```json
// BEGIN ZYLOS MANAGED — do not edit between these markers
{
  "event": "SessionStart",
  "command": "node ~/zylos/.claude/skills/comm-bridge/scripts/heartbeat.js"
},
// END ZYLOS MANAGED
```

The upgrader only reads and writes within marked sections. User content outside the markers is untouched. New framework entries are added inside existing marker pairs or in new marker pairs appended at the end.

This is the same pattern used by `/etc/hosts` (on some systems) for managed ranges, by Puppet's `file_line` resource, and by tools like `conflict-markers` in generated code.

**Strengths:** Visually explicit — users can see exactly which config is framework-managed. Simple to implement: the upgrader only needs to parse marker boundaries, not understand the full config schema.

**Weaknesses:** The file format must support comments (JSON without comments is problematic). Users can accidentally edit inside markers or delete markers entirely. Marker reordering — a user moving a managed section to a different position — confuses the parser. The marker must be resilient to the upgrader's own output being inconsistently formatted.

### Strategy 3: Ownership Registry

A separate metadata file tracks which entries are framework-owned, keyed by canonical identity:

```json
{
  "version": "1.4.0",
  "managed_entries": {
    "hook:SessionStart:heartbeat": {
      "canonical_key": "hook:SessionStart:node ~/zylos/.claude/skills/comm-bridge/scripts/heartbeat.js",
      "added_in": "1.2.0",
      "value_hash": "sha256:a3f1b2..."
    }
  }
}
```

The `value_hash` field is critical: it records a hash of the entry's value at the time of last framework write. On the next upgrade, the reconciler reads the current entry's value, hashes it, and compares against the registry. If the hashes match, the entry is still in its framework-written state — safe to update. If they differ, the user has modified it — preserve it and warn.

**Strengths:** Invisible to the user (no markers in the config file). Cannot be corrupted by user editing the config. Survives config format changes. Enables precise ownership tracking per entry.

**Weaknesses:** The registry must stay in sync with the actual config — if the user manually deletes a managed entry, the registry still believes it exists, and the reverse pass must handle this. Registry location must be stable and discoverable. A missing registry (first install, or user deleted it) means the upgrader cannot distinguish user edits from the previous framework write.

### Choosing an Approach: Trade-offs

| Criterion | Three-Way Merge | Section Markers | Ownership Registry |
|---|---|---|---|
| Invisible to users | No (base storage) | No (markers in file) | Yes |
| Handles JSON/YAML cleanly | Needs schema-aware diff | Comment support required | Yes |
| Survives marker deletion | N/A | No | Yes |
| Supports per-entry ownership | No (line-level) | No (region-level) | Yes |
| Implementation complexity | Medium | Low | Medium |
| Base storage required | Yes | No | No |

For structured config formats (JSON, YAML) with per-entry semantics, the ownership registry approach is most robust. For line-oriented text config files (shell scripts, `.env` files), section markers are pragmatic. Three-way merge is most powerful when the config is large and free-form text where the framework and user edits to different regions are the common case.

---

## Canonical Identity: Matching the Same Entry Across Variations

Before any reconciler can answer "does this entry already exist?", it needs a **canonical identity function** — a mapping from a config entry to a stable, comparable key that is invariant across superficial format differences.

### The Identity Problem in Practice

Consider a hook registry entry that the framework writes as:

```json
{ "event": "SessionStart", "command": "~/zylos/scripts/heartbeat.js" }
```

The same logical entry might appear in the actual config file as:

```json
{ "event": "SessionStart", "command": "/home/alice/zylos/scripts/heartbeat.js" }
```

Or in a Docker container as:

```json
{ "event": "SessionStart", "command": "/root/zylos/scripts/heartbeat.js" }
```

A naive string comparison declares these three entries to be different. The reconciler then adds a second copy rather than updating the first, and on the next run adds a third. This is the **duplicate accumulation** bug — the most common failure mode in patch-based upgraders.

Kubernetes solves this problem cleanly: the canonical identity for a resource is its `GroupVersionKind` tuple plus `namespace/name`. There is no ambiguity because the schema enforces that each resource has these fields. Terraform uses the resource address (`aws_s3_bucket.my-bucket`) which is explicitly declared in configuration. Both approaches make identity **explicit and stable** by design.

For local agent config, the canonical identity function must be **computed** rather than declared, which introduces ambiguity. The reconciler must decide: is `~/x` the same as `/home/alice/x`?

### Normalization Rules

A practical canonical identity function for path-containing config entries should:

1. **Expand tilde to absolute path** using the runtime's home directory resolution (`os.homedir()` in Node.js, `os.UserHomeDir()` in Go, `Path.home()` in Python). This must happen at reconcile time, not at template-authoring time, so the same template works across users.

2. **Resolve symlinks to realpath**. On macOS, `/tmp` is a symlink to `/private/tmp`. A path written as `/tmp/x` and a path written as `/private/tmp/x` refer to the same file. However, symlink resolution has a subtle failure mode: if the path does not yet exist (a new hook script that will be created by the activation), `realpath` fails. The canonical function must handle missing-path cases by expanding what exists and leaving the rest as-is.

3. **Normalize separators**. On Windows, backslashes and forward slashes are interchangeable. A Windows-aware canonical function must normalize to a single separator style.

4. **Preserve case on case-sensitive filesystems, normalize on case-insensitive**. macOS and Windows default to case-insensitive filesystems; Linux is case-sensitive. A config entry `~/Scripts/foo.sh` and `~/scripts/foo.sh` are the same file on macOS but different files on Linux. The canonical function must be platform-aware.

### Collision Detection

After normalization, the canonical identity function must be checked for collisions: two logically different entries that map to the same canonical key. This can happen when:

- A user adds a hook that differs from the framework hook only in path capitalization (on a case-sensitive system, these are different; after lowercasing, they collide).
- A hook registered with a timeout argument (`command: "node heartbeat.js --timeout 5000"`) and one without (`command: "node heartbeat.js"`) differ in value but the canonical key is derived only from the event+script tuple.

The design choice: what constitutes the canonical key for a hook entry? Options:

| Key Design | Pros | Cons |
|---|---|---|
| Full normalized command string | No collisions | Cannot detect "same script, different args" |
| Normalized script path only | Detects same-script variants | False collisions on scripts with multiple uses |
| Event + normalized script path | Semantically clean | Cannot run same script on same event twice |

The right choice depends on whether the config semantically allows multiple entries for the same (event, script) pair. If the schema is a set (no duplicates intended), keying on (event, normalized_script) is correct. If the schema is a list (order and duplicates matter), keying on the full entry value is safer.

### Suffix-Collision Pitfall

A particularly nasty collision is the **suffix collision**: two entries whose canonical keys happen to share a prefix, causing one to be mistaken for the other. For example:

- Entry A: `command: "node ~/scripts/heartbeat.js"`
- Entry B: `command: "node ~/scripts/heartbeat-v2.js"`

After normalization, if the identity function uses a string prefix match rather than exact match (e.g., "does the config contain an entry starting with `node ~/scripts/heartbeat`"), Entry A will match when looking for Entry B. This produces false-positive duplicate detection: the reconciler believes Entry B already exists and skips adding it.

The safest canonical identity function is **exact match after normalization** for the entire entry value, with no substring or prefix matching. Pattern-matching heuristics in reconcilers are technical debt waiting to activate.

---

## Forward and Reverse Passes

A complete reconciler for agent config must run two passes over the config file on each upgrade.

### Forward Pass: Add and Update Framework Entries

For each entry in the current framework template:

1. Compute its canonical key.
2. Search the current config for an entry with the same canonical key.
3. If **not found**: add the entry to the config and record it in the ownership registry.
4. If **found and registry says framework-owned**: compare the stored value hash to the current entry's value hash.
   - Hashes match (user has not modified it): update the entry to the new template value; update the registry.
   - Hashes differ (user has modified it): log a warning; preserve the user's version; do not update the registry hash.
5. If **found and registry says user-owned** (or registry does not mention it): skip entirely.

The forward pass is idempotent by construction: running it twice produces no changes on the second run, because all template entries are already present after the first run.

### Reverse Pass: Remove Obsolete Framework Entries

The reverse pass handles the case where the framework removes an entry from its template between versions — for example, a SessionStart hook that is no longer needed.

For each entry in the ownership registry:

1. Check whether the entry's canonical key appears in the current template.
2. If **still in template**: no action (forward pass handles it).
3. If **not in template** (the entry is now obsolete):
   a. Look up the entry in the current config.
   b. If **not found in config**: it was already removed (perhaps manually). Remove from registry; no warning.
   c. If **found and value hash matches registry**: the entry is in its framework-written state. Remove it from the config and unregister it.
   d. If **found and value hash differs**: the user has modified a now-obsolete framework entry. Do not remove it automatically. Log a warning: "Entry `X` is no longer needed by the framework but has been modified. Manual cleanup recommended."

This last case (3d) is deliberately conservative. Removing a user-modified entry that the framework no longer ships could break the user's custom workflow. The principle here mirrors ArgoCD's opt-in pruning: automatic deletion of resources the declarative config no longer describes is correct for framework-owned resources but dangerous for user-modified ones.

### Why Patch-on-Patch Accumulates Debt

The failure of the patch accumulation approach is structural, not accidental. Each version's migration script adds code like:

```javascript
// v1.2 migration
if (!hooks.some(h => h.command.includes("heartbeat.js"))) {
  hooks.push({ event: "SessionStart", command: "~/scripts/heartbeat.js" });
}

// v1.3 migration
if (hooks.filter(h => h.event === "SessionStart").length < 2) {
  hooks.push({ event: "SessionStart", command: "~/scripts/health-check.js" });
}

// v1.4 migration
const heartbeatHook = hooks.find(h => h.command.includes("heartbeat") && h.timeout !== 30000);
if (heartbeatHook) heartbeatHook.timeout = 30000;
```

By v1.6, the migration script has:
- String-substring matching for path detection (vulnerable to suffix collisions)
- Count checks for "is entry X already present" (breaks if user adds their own hooks)
- Timeout comparisons for ownership detection (breaks as defaults change across versions)
- Event-name checks mixed with command-content checks (coupling two orthogonal dimensions)

Each check encodes assumptions about the state the previous migration left behind. If a user skips from v1.1 directly to v1.6, some of those intermediate assumptions are violated. If the user is running in a Docker container where the home directory is `/root` rather than `/home/alice`, tilde-expanded paths from old migrations do not match.

The canonical reconciler approach eliminates this debt by making each upgrade stateless with respect to previous migration code. The reconciler does not ask "what did v1.3 install?" — it asks "is the current template entry present, with the correct value, and owned by the framework?" The answer is observable from the config file and registry without requiring knowledge of version history.

---

## Cross-Platform Portability

Config fixtures and tests written on one platform routinely fail on another. The most common portability failures in config management tooling:

### Home Directory Assumptions

Template files and test fixtures that embed absolute paths are not portable:

```json
{ "command": "/home/alice/zylos/scripts/heartbeat.js" }
```

This path is correct on Alice's Linux system, incorrect on Bob's system (`/home/bob/...`), incorrect on macOS (`/Users/alice/...`), and incorrect in a Docker container (`/root/...`).

The correct approach: template files store paths using tilde notation (`~/zylos/scripts/heartbeat.js`) or a platform-agnostic placeholder (`${ZYLOS_HOME}/scripts/heartbeat.js`). The canonical identity function expands these at reconcile time using the runtime's home directory. Test fixtures use a temporary directory as the mock home directory, injected via environment variable.

### XDG Base Directory Standard

The XDG Base Directory Specification (used by most modern Linux applications) defines environment variables for configuration and data directories:

- `$XDG_CONFIG_HOME` (default: `$HOME/.config`) for user configuration
- `$XDG_DATA_HOME` (default: `$HOME/.local/share`) for user data
- `$XDG_STATE_HOME` (default: `$HOME/.local/state`) for persistent state (like the ownership registry)

Using XDG variables rather than hardcoding `~/.config/zylos/` makes the config management system overridable for testing (set `XDG_CONFIG_HOME=/tmp/test-config` in test setup) and compatible with systems that use non-default XDG paths (common in enterprise environments and containers).

### macOS Symlink Traps

On macOS:
- `/tmp` is a symlink to `/private/tmp`
- `/var` is a symlink to `/private/var`
- `/etc` is a symlink to `/private/etc`

A canonical identity function that resolves symlinks will normalize `/tmp/zylos/heartbeat.js` to `/private/tmp/zylos/heartbeat.js`. If the template stores the path as `/tmp/...` and the config stores it as `/private/tmp/...` (because a previous version of the upgrader resolved symlinks), the canonical keys will match — but only if the current upgrader also resolves symlinks. A version that stopped resolving symlinks would see these as two different entries and add a duplicate.

The safest rule: **apply the same normalization in the template and in the current-config reader**. Do not apply symlink resolution in one but not the other.

### Windows Path Portability

Windows paths require special handling:
- Drive letter prefix (`C:\Users\alice`) has no Unix equivalent
- WSL paths (`/mnt/c/Users/alice`) and native Windows paths refer to the same filesystem location but look completely different
- Backslash separators must be normalized to forward slashes for comparison

Agent platforms targeting Windows should maintain a platform-specific path normalization module that is swapped in at compile time or detected at runtime, rather than trying to handle all platforms with a single code path.

---

## Failure Mode Taxonomy

A consolidated view of the failure modes that a production reconciler must prevent:

| Failure Mode | Triggering Condition | Consequence | Prevention |
|---|---|---|---|
| Silent user edit overwrite | No ownership check before write | User loses customizations | Hash-check before update; ownership registry |
| Duplicate accumulation | Normalization mismatch in ID function | Redundant entries, incorrect behavior | Normalize consistently; test with path variants |
| Non-idempotent re-run | State not fully reflected in registry | Different state after second run | Run upgrader twice in tests; assert zero changes |
| Orphaned framework entries | No reverse pass | Stale entries accumulate across versions | Maintain manifest; garbage-collect obsolete entries |
| Missing entry after skip-upgrade | Migration assumes sequential versions | Required entry not present | Reconcile against current template, not against diff from previous version |
| Collision false-positive | Substring/prefix matching in ID function | Wrong entry updated/removed | Use exact match on normalized keys |
| Partial write on crash | Non-atomic file write | Config file in inconsistent state | Write to temp file, validate, atomic rename |
| Registry/config desync | User manually deletes managed entry | Reverse pass tries to remove non-existent entry | Handle missing entries gracefully in reverse pass |
| Cross-platform path mismatch | Hardcoded paths in templates or tests | Fails on different users/OS | Use tilde notation in templates; temp dir in tests |

---

## A Concrete Reconciliation Design for Agent Config

Pulling the above together into a practical design for an agent config upgrader:

### Data Model

The config file contains entries with values. The ownership registry (stored separately, e.g., at `$XDG_STATE_HOME/zylos/managed-config.json`) tracks:

```
registry[canonical_key] = {
  added_in_version: "1.2.0",
  last_updated_in_version: "1.4.0",
  value_hash: "<sha256 of the written value, normalized>",
  entry_type: "hook" | "setting" | "permission"
}
```

### Canonical Key Function

```
function canonical_key(entry):
  if entry.type == "hook":
    return "hook:" + entry.event + ":" + normalize_path(entry.command)
  if entry.type == "setting":
    return "setting:" + entry.key
  if entry.type == "permission":
    return "permission:" + normalize_path(entry.pattern)

function normalize_path(p):
  p = expand_home(p)          # ~/x → /home/alice/x
  p = resolve_real_if_exists(p)  # resolve symlinks for existing paths only
  p = to_forward_slashes(p)   # Windows: C:\x → C:/x
  # Do NOT lowercase — preserve case for case-sensitive filesystems
  return p
```

### Reconciliation Algorithm

```
function reconcile(template, current_config, registry):
  # --- Forward pass ---
  for entry in template.entries:
    key = canonical_key(entry)
    current = find_by_canonical_key(current_config, key)

    if current is None:
      # New entry: add it
      current_config.add(entry)
      registry[key] = { value_hash: hash(entry.value), ... }

    elif key in registry:
      stored_hash = registry[key].value_hash
      actual_hash = hash(current.value)
      if stored_hash == actual_hash:
        # Framework-owned, not user-modified: safe to update
        current_config.update(key, entry.value)
        registry[key].value_hash = hash(entry.value)
      else:
        # User has modified a framework entry: preserve
        log_warning("User-modified framework entry preserved: " + key)

    else:
      # Not in registry: assume user-owned, preserve
      pass

  # --- Reverse pass ---
  template_keys = { canonical_key(e) for e in template.entries }
  for key, meta in registry.items():
    if key not in template_keys:
      current = find_by_canonical_key(current_config, key)
      if current is None:
        # Already removed: clean up registry
        del registry[key]
      elif hash(current.value) == meta.value_hash:
        # Framework-owned, unmodified: remove it
        current_config.remove(key)
        del registry[key]
      else:
        # User modified an obsolete framework entry: warn, do not remove
        log_warning("Obsolete managed entry has user modifications: " + key)

  # --- Atomic write ---
  write_atomic(config_path, current_config)
  write_atomic(registry_path, registry)
```

### Atomic Write Safety

The `write_atomic` function:
1. Write the new content to `config_path + ".tmp"`
2. Validate the new content (parse it; if invalid, abort and log error)
3. Rename `config_path + ".tmp"` to `config_path` (atomic on POSIX, near-atomic on Windows with `MoveFileEx`)
4. If any step fails, the original file is intact

This is the NixOS lesson applied locally: commit to the new state only after validation, never leave the config in a partially-written state.

---

## Testing a Config Reconciler

A reconciler without tests is a ticking clock. The minimum test matrix:

**Idempotence test**: Run the reconciler on a clean install. Run it again. Assert that the config file and registry are identical and that zero changes are reported on the second run.

**User-edit preservation test**: Apply the framework template. Manually modify a framework-managed entry. Run the reconciler. Assert that the user's modification is preserved and that a warning is logged.

**Reverse pass test**: Apply framework v1.0 template (which includes entry X). Upgrade to v1.1 template (which removes entry X). Run the reconciler. Assert that entry X is removed from the config and the registry.

**Reverse pass with user edit test**: Apply framework v1.0. Manually modify entry X. Upgrade to v1.1. Run the reconciler. Assert that entry X is NOT removed (user-modified), and that a warning is logged.

**Skip-version upgrade test**: Apply framework v1.0 template. Run the v1.3 reconciler directly (simulating a user who skips v1.1 and v1.2). Assert that all v1.3 template entries are present.

**Path variant test**: Write a framework template using tilde notation. Set `HOME=/tmp/test-alice`. Run the reconciler. Write the same entry with an absolute path equivalent. Run the reconciler again. Assert that only one entry is present (deduplication succeeded).

**Missing registry test**: Delete the registry file. Run the reconciler. Assert graceful recovery: the reconciler treats existing entries as user-owned (conservative) and adds missing template entries as new.

---

## Conclusion

The desired-state reconciliation pattern, honed across three decades of infrastructure tooling, offers a principled escape from the patch-accumulation trap. The core insight is consistent across Kubernetes, Terraform, Ansible, GitOps, and NixOS: **observe the current state, compare it to the desired state, and close the gap idempotently** — rather than recording a history of mutations and replaying them forward.

Translating this to local agent config management requires solving four problems that infrastructure tools largely sidestep:

1. **Dual ownership**: Unlike Kubernetes resources (fully framework-owned) or user dotfiles (fully user-owned), agent config files are co-owned. An ownership registry with value hashing is the most robust mechanism for tracking this at entry granularity.

2. **Canonical identity**: Config entries lack the explicit `namespace/name` identifiers that Kubernetes resources carry. A canonical key function must normalize paths, expand tildes, and resolve symlinks consistently — and must be tested with the full range of path variants it will encounter in production.

3. **Reverse pass**: Adding new entries (forward pass) is easy. Removing entries the framework no longer ships (reverse pass) requires maintaining a manifest and conservatively preserving user-modified obsolete entries rather than silently deleting them.

4. **Cross-platform portability**: Template files must store paths in portable notation (tilde or env-derived), and the canonical key function must be platform-aware. Tests must run against a temporary home directory, not the real user home.

For AI agent platforms building CLI upgraders today, the practical recommendation is: start with the ownership registry approach (more robust than section markers for JSON/YAML config), implement both forward and reverse passes from the beginning (retrofitting the reverse pass is painful), and write the five canonical test cases before shipping. The investment is modest; the alternative — a migration script that accumulates version-conditional patches until it breaks on the first Docker deployment — is far more expensive to maintain and debug.

---

*Sources:*

- *Kubernetes controller-runtime documentation, controller reconcile loop design, kubernetes.io/docs*
- *"Kubernetes Reconciliation: How Controllers Achieve Desired State," randomwrites.com/architecture/06-Reconciliation-Mechanics*
- *"Understanding and Implementing the Reconciliation Loop Pattern," oneuptime.com/blog/post/2026-02-09-operator-reconciliation-loop*
- *HashiCorp, "Detecting and Managing Drift with Terraform," hashicorp.com/en/blog/detecting-and-managing-drift-with-terraform*
- *HashiCorp, "Manage resource drift," developer.hashicorp.com/terraform/tutorials/state/resource-drift*
- *"GitOps Configuration Drift Reconciliation: Continuous Cluster State Enforcement Using Declarative Repositories," ayeezh.com*
- *"Understanding ArgoCD Reconciliation: How It Works, Why It Matters, and Best Practices," docs.rafay.co/blog/2025/08/04/understanding-argocd-reconciliation*
- *NixOS Wiki, "Overview of the NixOS Linux distribution," nixos.wiki/wiki/Overview_of_the_NixOS_Linux_distribution*
- *Luis Ibarra, "Nix Generations and Rollbacks," blog.bitclvx.com/posts/nix-generations*
- *git-merge-file documentation, git-scm.com/docs/git-merge-file*
- *"Troubleshooting Ansible Idempotency and State Drift," mindfulchase.com*
- *"Ansible Idempotency in Practice," sonnyenchill.com/blog/ansible-idempotency-in-practice*
- *Microsoft, "Mitigation: Path Normalization," learn.microsoft.com/en-us/dotnet/framework/migration-guide/mitigation-path-normalization*
- *XDG Base Directory Specification, freedesktop.org/wiki/Specifications/basedir-spec*
