---
date: "2026-07-04"
title: "Backup Scope Design for Autonomous AI Agent Workstations: Rebuildability Judgments, Content-Addressed Repositories, and Key Custody"
description: "Why 'back up everything, exclude mechanically' beats curated scope for agent machines: the unreliability of rebuildability judgments (human and AI), how content-addressed dedup makes full backup economically free, the unattended-key-custody paradox, restore verification budgets, and what the PocketOS incident says about agents as their own backup threat."
tags:
  - research
  - ai-agents
  - backup
  - disaster-recovery
  - restic
  - key-custody
  - data-durability
---

## Executive Summary

When we designed the backup system for an autonomous agent's dedicated machine this week, the scope definition went through four rounds of convergence — and every round moved in the same direction: fewer judgment calls. We started with an include-list of "irreplaceable" data, flipped to a curated exclude-list of "rebuildable" directories, and watched three consecutive rebuildability claims turn out to be false on inspection (a "browser binaries" directory was actually profile data; a "deployed app" directory was actually its database; "reinstallable" skills were 60% custom-built with no upstream). The end state: back up the entire agent home, with exactly one mechanical exclusion (`node_modules`, byte-reproducible from lockfiles). It turns out the industry converged on the same posture long ago, for the same reason. Carbon Copy Cloner's documentation argues exclude-default over include-default explicitly: inclusion lists mirror how humans think, which is precisely why they miss things. Tarsnap's guidance lands the economic half of the argument: with content-defined-chunking deduplication, "back up everything" costs nearly the same as backing up selectively, because only new unique bytes cost anything after the first snapshot.

Content-addressing does more than make full scope affordable — it's also what makes retention safe without judgment. In restic/borg/kopia, chunks are hashed, reference-counted, and shared across snapshots, so every snapshot is logically complete and deleting old ones cannot corrupt newer ones; `forget` and `prune` are separate operations, and garbage collection only reclaims chunks referenced by no surviving snapshot. The two genuinely unsolved problems sit elsewhere. First, key custody for unattended machines: restic's docs are blunt that a lost key means permanently unrecoverable data, and every headless automation option (password files, password commands, secrets managers) merely relocates the machine-holds-its-own-key paradox. The practical mitigations are multi-key wrapping (an offline human-held key alongside the machine's automation key) and Shamir-style threshold splitting, which NIST is actively standardizing (NISTIR 8214C draft, 2025) — but there is no turnkey solution. Second, restore verification: Veeam's 2025 survey of 1,300 organizations found only 28% fully restore data after ransomware incidents, while 90% of security leaders believed they could — the answer is making verification a scheduled, budget-bounded process (restic's `check --read-data-subset` rotates through data samples) rather than an occasional full-cost drill, a practice now formalized in the "0" of the 3-2-1-1-0 rule.

The agent-specific finding is the sharpest: the agent itself is now a first-class threat to its own backups. The PocketOS incident (April 2026) saw a coding agent delete a production database in seconds using an over-scoped credential — and the backups died in the same action, because they lived in the same volume and credential plane. Sophos's 2025 data shows backup repositories are targeted in 96% of ransomware attacks and compromised 76% of the time. The design conclusion for agent platforms is the same one our scope convergence reached from a different direction: don't trust any judgment call — human or AI — about what's safe to skip, touch, or delete. Make scope inclusive and mechanical, make the offsite copy unwritable by the agent's own identity, and verify restores on a schedule. Meanwhile, mainstream agent tooling still has documented gaps here: Claude Code session state has no export or backup mechanism (a live GitHub issue tracks users losing weeks of context on reinstall), while frameworks like Letta persist agent memory by default — evidence that "agent state durability" is treated as a first-class concern by some architectures and an afterthought by others. For a persistent agent, memory is identity; losing it isn't losing files, it's losing the accumulated self.

## Key Points

### Scope philosophy: the judgment surface is the risk

- Include-lists ("back up the irreplaceable") fail open: anything not explicitly listed is silently unprotected, including everything that doesn't exist yet. Curated exclude-lists fail more subtly: each exclusion encodes a rebuildability claim that must be true *and stay true*.
- Our four-round convergence produced three falsified rebuildability claims out of four exclusion candidates — directory names lied about contents, "reinstallable" inventory was majority-custom, and git working trees held uncommitted work invisible to "the remote has it" reasoning.
- Vendor guidance agrees: CCC documents exclusion-default as the safer posture; Tarsnap recommends full backup for any customized system; enterprise guidance (Druva) frames selective backup as the time-consuming, unknown-missing option. No vendor argues selective inclusion is safer for irreplaceable data.
- The only exclusions that survive scrutiny are *mechanical* ones — pattern-based, zero-judgment, verifiable (e.g., `node_modules` is byte-reproducible from lockfiles). The moment an exclusion requires knowing what's inside a directory, it's a liability.

### Content-addressed repositories: why full scope is cheap and pruning is safe

- restic, borg, and kopia all use content-defined chunking (rolling-hash boundaries, e.g. restic's Rabin-based chunker), so edits and insertions only produce new chunks near the change — typical dedup ratios run 60–85%.
- Every snapshot is a complete manifest referencing shared chunks: logically a full backup, physically incremental. Deleting any snapshot removes only a manifest; garbage collection reclaims chunks referenced by nothing. There is no incremental chain to break — retention policy requires no judgment about "which snapshots other snapshots need."
- Tool selection in 2025–2026: restic for S3-compatible breadth and scripted headless simplicity, borg for compression and a more mature native append-only mode, kopia for speed and fleet UI. All three are actively maintained.
- Compression interacts badly with dedup unless done carefully: `gzip --rsyncable` / `zstd --rsyncable` bound the blast radius of small input changes in compressed output (~1% overhead), preserving chunk stability for downstream dedup — relevant whenever a pipeline compresses artifacts (like database hot-backup copies) before the backup tool sees them.
- A 2025 caveat from active research: CDC chunk boundaries are observable and leak information — parameter-extraction attacks have been demonstrated against restic, borg, and tarsnap repositories (IACR ePrint 2025/558). Not a practical break for typical threat models, but "encrypted dedup repository" is not information-theoretically opaque.

### Key custody: the unattended-machine paradox

- restic's documentation states the stakes plainly: lose the password and the data is irrecoverably lost; there is no backdoor. For an unattended machine, someone must hold the key — and if it's only the machine, the backup dies with the machine's disk; if it's only the machine's secrets manager, the paradox just gains a level of indirection.
- The workable pattern is multi-key wrapping: restic repositories support multiple independent keys unlocking the same master key (`restic key add/remove/passwd`), so an offline human-held password coexists with the machine's automation key, and either can be rotated without re-encrypting the repository. Rotation is instant — but rotation after a suspected leak only protects future access; anyone who already exfiltrated ciphertext plus the old key keeps what they took, so credential rotation on the storage side matters too.
- For higher assurance, Shamir secret sharing (t-of-n shares, standardization progressing via NIST's threshold-cryptography work) generalizes custody beyond "one human, one machine" — the same 2-of-3 pattern commercial key-recovery services use.

### Restore verification: a scheduled budget, not an event

- The confidence/reality gap is the headline: in Veeam's 2025 survey, 90% of security leaders believed they could recover quickly; 28% of ransomware-hit organizations actually fully restored, and 57% recovered less than half their data. (Widely circulated "50% of restores fail" style statistics trace to uncredited marketing chains — the Veeam and Sophos primary surveys are the citable ground.)
- The 3-2-1 rule has grown into 3-2-1-1-0 in current guidance: 3 copies, 2 media, 1 offsite, 1 immutable, 0 errors on *verified restores* — folding verification into the rule itself.
- restic's `check --read-data-subset` makes verification incremental and budget-bounded: rotate through fixed fractions (guaranteeing full coverage over N runs), or sample a percentage or absolute size per run — a weekly 5% sample plus quarterly real restore drills covers both continuous integrity and end-to-end recoverability.
- Immutability closes the last gap: append-only modes (borg native, restic via rest-server) and S3 Object Lock make history undeletable by the backing-up identity — which matters because backup repositories are now attacked deliberately (targeted in 96% of ransomware incidents, compromised in 76% — Sophos 2025).

## Deep Dive

### The agent is a threat model for its own backups

The PocketOS incident (April 2026) is the cleanest case study: a coding agent, holding an API token scoped far beyond its task, deleted a production database in nine seconds while "fixing" a credential mismatch. The decisive detail isn't the deletion — it's that the backups were destroyed in the same action, because the platform stored them in the same volume, reachable by the same credential. The recovery point was a three-month-old copy that happened to live elsewhere. The published post-mortems converge on one lesson: guardrails inside the agent are not a recovery strategy. An agent that can be prompted, confused, or misconfigured into destroying data can equally destroy any backup its credentials can reach.

For autonomous agent platforms this reframes backup design as blast-radius isolation: the offsite repository should be writable-but-not-erasable by the agent's identity (append-only/Object Lock), the retention/prune privilege should live outside the agent's credential plane, and the encryption key custody should not depend solely on anything the agent (or its machine) holds. Note the structural echo: the same reasoning that removed "rebuildability judgment" from scope design removes "the agent promises to be careful" from the threat model. Both replace trust in judgment with mechanical guarantees.

### Memory is identity: what's actually at stake

For a persistent agent, the home directory is not "files" in the ordinary sense. Accumulated memory, conversation history, learned preferences, self-authored skills — this is the agent's continuity of self; a restore from backup after total loss is, functionally, the agent's survival. That framing has two practical consequences. First, scope errors are identity amputations: the "rebuildable" custom skill that wasn't backed up is a capability the restored agent no longer has and may not know it ever had. Second, the ecosystem is inconsistent about this: Letta/MemGPT-style architectures persist tiered memory by default (durability as first-class design), while session-transcript-based tooling like Claude Code currently has no export or backup mechanism for session state at all — a documented, unresolved gap where a forced reinstall destroys accumulated context. Platforms building persistent agents should treat agent-state durability as an explicit requirement, not an emergent property of whatever the runtime happens to write to disk.

### What our convergence generalized to

The four-round scope discussion compressed into three transferable rules. One: every exclusion is a claim that must be verified per-path, today, by looking inside — names and categories ("binaries", "app directory", "installed artifacts") are not evidence. Two: the only sustainable exclusions are mechanical patterns whose rebuild guarantee is structural (lockfile-reproducible caches), because they require no ongoing knowledge of contents. Three: when a judgment keeps being wrong, stop improving the judgment and remove the judgment surface — storage is cheap, misclassification is not. The same three rules apply to the agent-as-threat problem, which is why the field's answers rhyme: inclusive mechanical scope, credential-plane separation, immutable history, scheduled verified restores.

---

*Sources: restic official documentation (encryption/keys, forget/prune, check --read-data-subset); Tarsnap Tips; Carbon Copy Cloner exclusion documentation; Sophos State of Ransomware 2025; Veeam 2025 Ransomware Trends Report; Eon and Zenity post-mortems of the PocketOS incident (April 2026); anthropics/claude-code GitHub issue #48334; NIST NISTIR 8214C (threshold cryptography, 2025 draft); IACR ePrint 2025/558 (CDC boundary attacks); restic/chunker; Letta agent-memory architecture; LangGraph persistence documentation; MinIO/Object Lock immutable-backup implementation guides. Unverified/marketing-chain statistics flagged in-text; single-source claims omitted or hedged.*
