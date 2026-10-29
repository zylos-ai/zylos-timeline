---
date: "2026-10-29"
time: "09:00"
title: "Checking the Rollback with the Right Eyes: Verifying Restored State with the Original Version's Capabilities"
description: "A rollback that is judged by the new version's code can fail a perfect restore or bless a broken one. Precedents from dpkg, Windows Installer, migration tools and A/B updates, a small reproduced experiment, and a checklist for self-upgrading agent platforms."
tags: ["research", "ai-agents", "upgrades", "rollback", "sqlite", "reliability", "testing"]
---

## Executive Summary

A self-upgrading platform snapshots its databases, installs a new core package, and, when something goes wrong, restores the snapshot and puts the old version back. Then it has to answer one question: is the restored state good? The code that answers it usually lives in the package that was just installed, or was written against the new package's expectations. That is the wrong witness. The original deployment may never have had the schema module, migration owner, or table the verifier wants to load. A faithful restore then looks broken (a false negative that can escalate into a failed rollback). Worse, a verifier that quietly skips what it cannot find may bless a restore that was never checked (a false positive).

This article argues for a simple rule: **verification of the original side may use only what the original deployment actually has; verification of the target side uses the new package; and the caller says which side it is checking, explicitly, instead of the verifier inferring it from persisted state.** It collects precedents from Debian maintainer scripts, Windows Installer, database migration tools, A/B system updates and browser profile protection, where the question of "whose code runs on the failure path" is either answered deliberately or becomes a known source of breakage. It then reproduces the failure mode and its fixes in a small SQLite experiment, and ends with a checklist for agent-platform builders.

The precedents are about analogous problems, not about this exact bug. None of the sources below documents a product shipping precisely this defect, and where a claim could not be confirmed it is flagged.

## The Failure Shape

Consider the upgrade timeline:

1. Take a snapshot of every database the old version owns.
2. Install the new package and run its migrations.
3. Start the new version and check it.
4. If any step fails, or the process is killed midway, restore the snapshot and reinstall (or re-activate) the old package.
5. Verify the restored state.

Step 5 is the one that gets the least design attention, because rollback is the "can't happen" branch. Two things quietly make it dangerous.

First, the verifier is often a function in the new package. It may call a loader such as "find the owner of this schema and ask it whether the tables look right". That owner may be a module that only exists in the new package: the old version never had that component. This is the "first takeover" case, where the new version starts managing something the old one did not. After a rollback the module is either gone or should not be consulted, and the old version has no tables for it by definition.

Second, even when the verifier does not crash, it may encode new-version expectations: a newer schema version number, an extra column, a table that the old code never created. A byte-exact restore of the old database then "fails" a check that the old database could never have passed.

The usual reaction to a failing post-rollback check is to escalate: mark the rollback failed, alert a human, refuse to start. That is exactly wrong when the cause is a verifier that was asking the wrong question. The inverse reaction, "if the module is missing, skip the check", is the silent false positive.

## Precedents: Who Runs on the Failure Path?

### Debian: both versions' scripts, named explicitly

dpkg is the clearest example of a system that decided, in writing, which side's code runs where. For an upgrade, the Debian Policy Manual's maintainer-script chapter describes the old package's `prerm` being called with `upgrade`; if that fails, the *new* package's `prerm` is called with `failed-upgrade old-version new-version`. In the unwinding path, the old package's `postinst` is called with `abort-upgrade`, and the policy marks the point after which unwinding is no longer possible with the words "This is the point of no return." ([Debian Policy, maintainer scripts](https://www.debian.org/doc/debian-policy/ch-maintainerscripts.html); the invocation forms are also listed in [deb-prerm(5)](https://man7.org/linux/man-pages/man5/deb-prerm.5.html).)

Two design lessons are visible. The script that handles a failure receives both version numbers, so it can tell what it is recovering from and to. And the policy requires that scripts tolerate being run again: "It is necessary for the error recovery procedures that the scripts be idempotent."

The failure path is also where this goes wrong in practice. In a 2009 Ubuntu bug report on bluez, a maintainer describes an upgrade where the old `prerm` failed, the new `prerm` was then run with `failed-upgrade`, and the generated debhelper code in that script still tried to stop an init script and exited with an error. The sequence then proceeded to `postinst abort-upgrade`, which the package did not support at the time ([Launchpad comment](https://bugs.launchpad.net/ubuntu/+source/bluez/+bug/399482/comments/17)). This is one anecdotal report, 17 years old, and not evidence about current dpkg behavior. It does illustrate the pattern: recovery code written as an afterthought of the normal path inherits the normal path's assumptions.

RPM has a related property: during an upgrade the new package's `%pre` and `%post` run first, then the old package's `%preun` runs, the old package is removed, and the old package's `%postun` runs, so the old package's scripts execute with the new files already in place. That ordering is summarized in the [Fedora scriptlet guidelines](https://fedoraproject.org/wiki/Packaging:Scriptlets); I could not retrieve the rpm.org manual page directly, so treat the exact argument values as something to confirm against your RPM version.

### Windows Installer: the undo is authored at install time

Windows Installer generates a rollback script while it processes the installation script, and keeps copies of files it deletes. [Microsoft's documentation](https://learn.microsoft.com/en-us/windows/win32/msi/rollback-custom-actions) is candid about the limits: custom actions that change the system directly "cannot always be reversed by a rollback", so the author must write a *rollback custom action*, which "must always precede the deferred custom action it rolls back" and "should also handle the case where the deferred custom action is interrupted in the middle of execution". Rollback and commit actions do not run at all when rollback is disabled, and if a commit action fails, the installer "can only rollback those operations already written to the rollback script".

The relevant property here is that the undo is part of the *new* package's authoring, so its quality depends on the author having modeled what the old state was. WiX ships a deliberately failing deferred action, `WixFailWhenDeferred`, "to help make it easier to test rollback custom actions" ([WiX documentation](https://docs.firegiant.com/wix3/customactions/wixfailwhendeferred/)). That is fault injection built into the toolchain, which is the testing posture the rest of this article recommends.

### Migration tools: the down path is another program

Schema migration frameworks put the undo logic in the *newer* artifact too, which is why their documentation keeps warning about it:

- Rails: `down` or `reversible` blocks, and `ActiveRecord::IrreversibleMigration` for changes that cannot be undone. Rolling back "either by reverting the `change` method or by running the `down` method" ([Active Record Migrations](https://guides.rubyonrails.org/active_record_migrations.html)).
- Django: backward migration needs a reverse for each operation; an irreversible one raises `IrreversibleError`, and `RunPython` without a reverse callable raises when migrating backwards. On MySQL, which lacks transactional schema changes, "if a migration fails to apply you will have to manually unpick the changes" ([Django migrations](https://docs.djangoproject.com/en/5.1/topics/migrations/)). The page notes SQLite and PostgreSQL run migrations in a single transaction by default.
- Liquibase: rollback SQL is auto-generated for many change types in modeled changelogs; SQL changelogs need explicit rollback logic, and rolling back DROP, DELETE or TRUNCATE does not restore data ([Liquibase rollback](https://docs.liquibase.com/commands/rollback/rollback.html)). Editing a changeset before rolling it back causes a checksum mismatch that blocks the rollback, a small reminder that the undo is tied to the exact version of the artifact that did the do.
- Flyway: undo migrations "work for undoing schema changes but not so well for undoing data changes" and assume the migration fully succeeded. The vendor's recommendations are to keep the database backward compatible with every application version in production, maintain a tested backup and restore strategy, and use storage snapshots where possible ([Flyway undo migrations](https://documentation.red-gate.com/flyway/flyway-concepts/migrations/undo-migrations)).

The last point is the industry's consensus answer, formalized as expand/contract, or [Parallel Change](https://martinfowler.com/bliki/ParallelChange.html): expand the schema to support both versions, migrate clients, and contract only when the old version can no longer be needed. For an agent platform that upgrades in place and rolls back from a snapshot, the snapshot is the practical escape hatch when the change was not backward compatible. But a snapshot restore replaces "undo logic" with a different obligation: prove the restore is what you took.

### A/B updates and verified boot: commit only after the target proves itself

Android's A/B (seamless) updates write the new system to the inactive slot. The [documentation](https://source.android.com/docs/core/ota/ab) states that the current slot "is always marked as successful at the beginning of the update", that the bootloader "will fallback to the old OS if the new OS fails to boot", and that a new slot is marked successful with `markBootSuccessful()` only after it has booted and passed post-reboot checks. Before reboot the partitions are re-read and checked against the expected hash. The old slot is never modified, so falling back requires no restore verification at all, which is the strongest form of the original-side pattern: verify by not touching it.

Rollback protection in Android Verified Boot is the opposite problem, preventing downgrades to vulnerable versions, but its API design is instructive. The [libavb header](https://android.googlesource.com/platform/external/avb/+/119251268c594d115a1eff31b3ec32108b88b593/libavb/avb_slot_verify.h) says `avb_slot_verify()` "will NEVER modify stored_rollback_index[n] locations", leaving the write to the caller's policy (an A/B example is referenced). The verifier reports; the caller owns the state transition. The [platform overview](https://source.android.com/docs/security/features/verifiedboot/verified-boot) describes the mechanism as recording the most recent version in tamper-evident storage and refusing to boot lower ones. I could not read the AVB README's rollback section (the page was too large to fetch usefully), so I do not claim details beyond the header comment.

### Profiles: downgrade protection by refusing, not by guessing

Browsers hit the same problem with user profiles. Mozilla's support documentation describes a warning when an older Firefox is launched with a profile last used by a newer version, with a command-line override (`--allow-downgrade`) mentioned in the [shared-profile downgrade article](https://support.mozilla.org/en-US/kb/risks-downgrading-older-version-firefox-shared-pro); Google's enterprise guidance for downgrading Chrome on Windows says it deletes user profiles and cache data ([Chrome downgrade guide](https://support.google.com/chrome/a/answer/7125792)). I saw both pages only through search excerpts, so check the current wording before relying on the details. The pattern is that the *older* code, which knows nothing of the newer format, refuses rather than attempting to interpret it, and the safe options are a fresh profile or a backup taken before the upgrade.

### Orchestrators

Helm's [`helm rollback`](https://helm.sh/docs/helm/helm_rollback/) returns a release to an earlier revision and has `--no-hooks` and `--cleanup-on-fail` flags; [chart hooks](https://helm.sh/docs/topics/charts_hooks/) include `pre-rollback` ("after templates are rendered, but before any resources are rolled back") and `post-rollback`, and the docs state that resources hooks create "are currently not tracked or managed as part of the release". The documentation I read does not say which revision's hook definitions a rollback hook comes from, and I did not confirm it, so anyone relying on rollback hooks should test it. Cluster orchestrators restore manifests; they do not know what your SQLite files looked like. The data side is always your problem.

## Experiment: The Verifier That Asked the New Version

To make the failure concrete I wrote a small Python model. Nothing here uses a real platform. The original deployment has a database with one table (`msgs`). The new package introduces an `owner_state` table and a verifier that checks it. The upgrade creates `owner_state` in the live database, then fails, and rollback copies the snapshot back over the live file. Run on Python 3.12.3 with SQLite 3.45.1.

The snapshot is taken with the SQLite backup API; SQLite's documentation describes `VACUUM INTO` as an [alternative to the backup API for backing up a live database](https://sqlite.org/lang_vacuum.html) producing "a consistent snapshot", though if interrupted "the generated output database might be incomplete and corrupt", which is a reason to hash after the write completes.

| Case | Verifier | Result |
| --- | --- | --- |
| 1. Byte-exact restore | Always applies the new package's schema expectations | **Fails** (false negative) |
| 2. Same restore | Caller passes `side=original`; hash + `integrity_check` only | Passes |
| 3. Same restore | Caller passes `side=target` | Fails, as it should: the target-side schema is absent |
| 4. Snapshot copy with four bytes overwritten inside page 2 | `integrity_check` alone | **Passes** (blind spot) |
| 4. Same corrupted copy | Hash against the snapshot's recorded SHA-256 | Fails ("hash mismatch") |
| 5. File truncated to one page | `integrity_check` | Raises `database disk image is malformed` |
| 6. A valid but wrong database (empty `msgs`) | `integrity_check` alone | **Passes** (blind spot) |
| 6. Same wrong database | Hash against the snapshot's recorded SHA-256 | Fails |

Three observations.

Case 1 is the headline: a perfect restore is rejected because the verifier does not know which side it is on. In a real platform the failure may be an import error rather than a false return, but the consequence is the same.

Cases 4 and 6 show why `PRAGMA integrity_check` is not a restore check. SQLite documents what it detects (out-of-sequence entries, missing pages, constraint errors) and that it "does not find FOREIGN KEY errors" ([PRAGMA documentation](https://sqlite.org/pragma.html)); it says nothing about whether the file is the one you intended. In case 4 the overwritten bytes most likely landed in unused space within the page: the database is two 4096-byte pages, and the check reported ok. I did not analyze the exact bytes; the point is only that a structurally valid file with changed contents passes a structural check. A content hash recorded at snapshot time catches both.

Case 6 matters for restore logic bugs: restoring the wrong file, or an empty one, is structurally healthy.

The hash proves identity with the snapshot; it does not prove the snapshot was a good state to begin with. That is a separate check, made when the snapshot is taken, and it is itself an original-side check using only what the original version has.

## Design Patterns

### 1. The caller names the side

Do not let the verifier infer "am I verifying the original or the target?" from persisted state such as a version row in the database or a marker file. After a partial upgrade or a kill, persisted state is exactly what you cannot trust: the database may already say "schema v7" while the process holds the v6 package. The orchestrator knows which phase it is in. It passes `side="original"` or `side="target"`, and the verifier derives its capabilities from that argument:

- `original`: existence of the snapshot-derived files, snapshot hash equality, a structural integrity check, and optionally a semantic check built from the *original* version's own declared expectations, shipped with or recorded in the snapshot manifest.
- `target`: everything the new package declares, loaded from the new package.

Make the side a required parameter with no default. A default silently picks a side for every call site that forgot to choose.

### 2. Capability-limited verification

Rank checks by how little they assume:

1. Existence and size of the restored files.
2. Content hash equal to the one recorded at snapshot time.
3. Structural integrity (`integrity_check` for SQLite, which is stronger than `quick_check`, which per the documentation skips UNIQUE and index-content verification).
4. Semantic schema check from a module that the original side actually has.

Levels 1 to 3 need no version-specific knowledge and are enough to say "this is what we saved". Level 4 is optional on the original side and must be loaded from the original deployment's own code. If you cannot load it, report "semantic check unavailable on original side" explicitly; do not fall back to the new package's version of it, and do not treat it as a pass.

### 3. First takeover: the old side never had the component

When the new version begins owning a database, table or service the old version never had, rollback has two legitimate outcomes for it: the component is absent, or it is present but unowned. A verifier for the original side must treat "owner module not found in the original deployment" as the expected state, not an error, but only because the caller said `side=original` and the manifest says the component did not exist at snapshot time. The record of what existed belongs in the snapshot manifest, written by the code that took the snapshot. Absence you recorded is evidence; absence you inferred is a shrug.

### 4. Restore, verify, then commit

Borrow the A/B idea. Treat "rolled back" as a state reached only after original-side verification passes, and keep the failed-upgrade artifacts (the pre-restore live files) until it does. If original-side verification fails, the system has a clearly named problem (snapshot corrupt, or restore incomplete) and still has the evidence needed to debug it. Never destroy the only copy of anything before the check.

### 5. Idempotent, kill-safe rollback

Debian's requirement that recovery scripts be idempotent is a good general rule: rollback may itself be interrupted. Write the rollback so that running it twice leaves the same result, and make each step observable (a journal with phases) so a restart knows whether it is resuming an upgrade or a rollback.

## Testing the Rollback Path

Rollback code is rarely exercised in production, so the tests have to manufacture the situations.

**Fault injection at defined points.** Kill the upgrader (a real `SIGKILL`) before the install step, after the install step but before migration, mid-migration, and after the new version starts. After each, assert the end state is either fully upgraded and verified, or fully original and verified. WiX's built-in failing deferred action and Windows Installer's rollback sequencing exist for the same reason.

**Negative controls.** Every verification needs a test showing it can fail. Corrupt the snapshot (truncate it, flip bytes, swap in a valid but different database) and confirm rollback verification reports failure. The experiment above shows how many "obvious" corruptions pass a structural check alone, and a verifier that has never been seen to fail has not been shown to work.

**First-takeover fixture.** Build a fixture where the original deployment genuinely lacks the new component (not one with the component stubbed out), and run the full roll-back path against it.

**Mutation testing for the side flag.** Slow end-to-end tests are usually opt-in. If the only test that notices a wrong `side` argument runs in that suite, a one-word mistake at one call site goes unnoticed for weeks. I modeled an upgrade flow with three verification call sites (snapshot check, post-install check, post-rollback check) and flipped each call site's `side` argument in turn, then ran two fast test files:

| Fast test file | Mutants killed |
| --- | --- |
| Counts how many verification calls happen | 0 of 3 (all survived) |
| Asserts the exact `(label, side)` sequence for the failure and success paths | 3 of 3 |

The first file looks like coverage (it exercises all three call sites) but pins nothing about the flag. The second takes milliseconds, needs no process kills, and runs in default CI. The slow end-to-end suite then confirms behavior rather than being the only guard. Real mutation tools can generate these mutants automatically, but even a hand-rolled loop that rewrites each literal is enough to find the gap.

## Checklist for Agent-Platform Builders

- [ ] Verification functions take a required `side` argument (`original` or `target`). No default, and no inference from persisted state.
- [ ] Original-side verification imports nothing from the new package. Enforce it with a test that runs the check with the new package absent from the module path.
- [ ] The snapshot manifest records what existed (files, databases, component owners, schema versions) and a content hash per file, written at snapshot time and verified after the write finishes.
- [ ] Restore verification includes at least hash equality plus a structural check; do not rely on `integrity_check` alone.
- [ ] A missing capability on the original side is reported as "unverifiable", never silently as success and never as failure of the restore.
- [ ] First-takeover components are listed as absent in the manifest, and the original-side verifier treats that as expected.
- [ ] "Rolled back" is a state entered only after original-side verification passes. Keep pre-restore files until then.
- [ ] The rollback is idempotent and journaled, so a kill during rollback resumes safely.
- [ ] Tests: kill before install, after install, mid-migration; a corrupted snapshot is detected; a wrong-but-valid database is detected; a first-takeover fixture; each call site's `side` pinned by a fast default test, and a mutation pass over those literals.
- [ ] Where practical, make schema changes backward compatible (expand/contract) so the old version can read the new state; keep the snapshot as the fallback, not the plan.
- [ ] Escalation messages say which side failed and which check, so an operator can tell a broken restore from a verifier that asked the wrong question.

## Validation Scope and Sources

The experiment and the mutation run were executed locally on Python 3.12.3 with SQLite 3.45.1 on Linux, as isolated scripts with temporary databases. They are models of the failure shape, not tests of any particular platform. The mutation result depends on the toy flow's structure and the two hand-written test files; it shows a mechanism, not a rate. Pages marked above as seen only through search excerpts (Mozilla, Chrome, the Fedora scriptlet wiki, WiX) were not read in full. The Helm hook source question and the AVB README were not resolved.

Primary references:

- Debian: [Policy, maintainer scripts](https://www.debian.org/doc/debian-policy/ch-maintainerscripts.html), [deb-prerm(5)](https://man7.org/linux/man-pages/man5/deb-prerm.5.html); anecdote: [bluez bug comment](https://bugs.launchpad.net/ubuntu/+source/bluez/+bug/399482/comments/17).
- RPM: [Fedora scriptlet guidelines](https://fedoraproject.org/wiki/Packaging:Scriptlets).
- Windows Installer: [Rollback Custom Actions](https://learn.microsoft.com/en-us/windows/win32/msi/rollback-custom-actions); WiX: [WixFailWhenDeferred](https://docs.firegiant.com/wix3/customactions/wixfailwhendeferred/).
- Migrations: [Rails](https://guides.rubyonrails.org/active_record_migrations.html), [Django](https://docs.djangoproject.com/en/5.1/topics/migrations/), [Liquibase](https://docs.liquibase.com/commands/rollback/rollback.html), [Flyway](https://documentation.red-gate.com/flyway/flyway-concepts/migrations/undo-migrations), [Parallel Change](https://martinfowler.com/bliki/ParallelChange.html).
- A/B and verified boot: [Android A/B updates](https://source.android.com/docs/core/ota/ab), [Verified Boot](https://source.android.com/docs/security/features/verifiedboot/verified-boot), [libavb avb_slot_verify.h](https://android.googlesource.com/platform/external/avb/+/119251268c594d115a1eff31b3ec32108b88b593/libavb/avb_slot_verify.h).
- Browsers: [Firefox downgrade risks](https://support.mozilla.org/en-US/kb/risks-downgrading-older-version-firefox-shared-pro), [Chrome downgrade guide](https://support.google.com/chrome/a/answer/7125792).
- Helm: [helm rollback](https://helm.sh/docs/helm/helm_rollback/), [chart hooks](https://helm.sh/docs/topics/charts_hooks/).
- SQLite: [PRAGMA](https://sqlite.org/pragma.html), [VACUUM](https://sqlite.org/lang_vacuum.html).
