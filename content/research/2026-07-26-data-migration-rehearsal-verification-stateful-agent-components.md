---
date: "2026-07-26"
title: "Data Migration Rehearsal and Verification for Stateful AI Agent Components"
description: "Why single-instance agent components must rehearse migrations on real data copies, verify with independent gates, and treat backups — not down-migrations — as the rollback path."
tags: ["data-migration", "sqlite", "verification", "backup-restore", "ai-agents", "upgrade-safety", "rollback", "embedded-databases"]
---

## Executive Summary

Classic database migration practice assumes a DBA in the loop, a client-server RDBMS, a staging tier, and a CI/CD gate between "migration written" and "migration applied." Stateful AI agent components invert every one of those assumptions: storage is embedded (a SQLite file, JSONL logs, markdown knowledge stores), there is exactly one copy of the data, nobody is watching the terminal, and the process performing the upgrade is often the agent itself. When Rails-style migration workflow assumptions quietly ride along into this environment, the failure mode is not a bad deploy that ops rolls back — it is silent, unattended corruption of the only copy of an agent's memory.

This article assembles a migration discipline for that environment from verifiable industry prior art. The core loop: take a live snapshot of the real data (SQLite's Backup API or `VACUUM INTO`), rehearse the migration against that copy with all live effectors disabled, verify the result with an independent checker that must exit 0 — not the migration script's own return code — then apply to the live store only after the rehearsal and live run reconcile, and retain the pre-migration backup until a human explicitly accepts the result. Down-migrations are deliberately absent: for single-instance embedded stores, the verified snapshot is the rollback path, because scripted "undo" logic cannot account for data the new version wrote in the meantime.

The practices here are not speculative. Prisma's shadow database, Flyway's dry runs, SQLite's own 12-step ALTER TABLE procedure, `sqldiff`, Percona's `pt-table-checksum`, AWS DMS validation, GitHub's Scientist library, and Stripe's four-phase online migration pattern all converge on the same three principles — rehearse on real data, verify independently, keep the old state untouched until acceptance — and the GitLab 2017 database incident shows what happens when any of them is assumed rather than proven.

## Why Agent Components Break Classic Migration Assumptions

Mainstream migration tooling — Rails ActiveRecord, Django migrations, Flyway, Liquibase — was designed for a world with structural safety nets:

- **A human operator** runs the migration and watches it, or a release engineer gates it in CI.
- **A client-server database** (Postgres, MySQL) separates the data's lifecycle from any one application process.
- **Multiple environments** (dev → staging → prod) mean the migration has run somewhere before it runs on data that matters.
- **Replicas and backups** managed by a dedicated function mean a botched migration is an incident, not an extinction event.

A long-running agent component has none of these. A rounds-style conversation service, a pages-rendering component, or a comm-bridge each typically own a single SQLite file or a directory of JSON/markdown state on one machine. There is no staging tier with representative traffic. There is no DBA. The upgrade path is often `component upgrade` executed by the agent itself, unattended, as part of its own maintenance loop. And critically, there is **one copy of the data** — the production copy is not the most important environment, it is the *only* environment.

This last point sharpens a well-known observation from migration-testing literature: staging environments "almost never contain representative production data" — they lack the orphan rows, legacy encodings, never-backfilled nulls, and sheer volume that production accumulates. For an agent component, the gap is absolute. Any rehearsal that does not use a literal copy of the real data file is rehearsing against fiction.

## Rehearsal-on-Copy: The Core Discipline

### Prior art

The strongest mainstream expression of "rehearse on a throwaway copy" is **Prisma Migrate's shadow database**: Prisma creates a temporary second database, replays the entire migration history into it, and diffs the result against the development database to detect drift and destructive changes *before* touching the real target. Two of its documented caveats transfer directly to agent practice: the shadow database must never share a connection string with the real one ("this risks permanent data deletion"), and it is a development-time mechanism — production application (`prisma migrate deploy`) assumes the rehearsal already happened elsewhere.

**Flyway's dry-run mode** (`flyway.dryRunOutput=<file>`) computes the full SQL a migration would execute and writes it to a file for review without touching the target — explicitly recommended before unattended overnight runs, which is precisely the agent situation. **Liquibase** splits the same concern into `validate` (changelog consistency) and `updateSQL` (preview exact SQL before the real `update`). For Postgres-scale systems, **pgcopydb** exists to stand up a full resumable clone of a production instance specifically so an upgrade can be rehearsed end-to-end.

The backup-testing world contributes the framing that ties this together: a backup is not a recovery plan until someone has restored it and inspected the result. The same logic applies verbatim — a migration is not safe until it has *actually run* against a real copy and the output has been examined, not merely planned and reviewed.

### The agent-component recipe

For an embedded SQLite store, the rehearsal loop is cheap and fully scriptable:

```bash
# 1. Live snapshot without blocking the running component
sqlite3 live.db "VACUUM INTO 'rehearsal.db'"

# 2. Run the new version's migration against the copy
NEW_VERSION_MIGRATE --db rehearsal.db

# 3. Independent verification (see next section) — must exit 0
verify-migration --db rehearsal.db || exit 1

# 4. Convergence check: run the migration again, assert no-op
NEW_VERSION_MIGRATE --db rehearsal.db
sqldiff rehearsal.db rehearsal-after-second-run.db   # expect empty
```

`VACUUM INTO` produces a consistent, compacted copy of a live database without exclusive access; the lower-level Online Backup API (`sqlite3_backup_init/step/finish`) does the same for cases needing incremental copying. Both are official, load-bearing SQLite primitives — no third-party tooling required.

### The rehearsal copy must be inert, not just isolated

A cautionary tale from the *Test-Driven Development with Python* ("Obey the Testing Goat") appendix on migration testing: a team copied a production database dump into staging to test against realistic data, and an automated process on staging fired against the copied data — sending **hundreds of real, incorrect invoices to actual customers**. The data was isolated; the *effectors* were not.

Agent components are unusually exposed to this failure because their state files sit adjacent to live credentials and schedulers. A rehearsal copy of a comm-bridge or conversation database must run with no real API keys, no live outbound channels, and no scheduler that can fire. Rehearse in a directory the running component does not read, with the migration invoked as a bare script rather than through the full component runtime, and the copy is inert by construction.

## Verification: An Independent Gate, Not a Return Code

Every mature migration-verification system separates "the migration claims success" from "a second process confirms the result":

- **`sqldiff`** (ships with SQLite) computes the logical difference between two database files and emits the SQL to transform one into the other — the direct tool for asserting "the migrated copy differs from the original in exactly the intended ways, and the second migration run changed nothing."
- **`pt-table-checksum`** (Percona Toolkit) pioneered chunked CRC32 checksum reconciliation between MySQL primaries and replicas — the ancestor of verify-equivalence-without-full-diff.
- **AWS DMS validation** automates row-count plus per-row checksum comparison between migration source and target, reporting in-sync / out-of-sync / not-comparable counts — a managed-service version of what a small verifier script does by hand.
- **CI migration gates** branch on a dedicated verifier's exit code: the pipeline proceeds only when the checker — not the migration tool — exits 0.

For an agent component the verifier should be a standalone script, versioned with the component, that checks three layers:

1. **Structural**: schema matches the target version exactly; foreign-key check passes (`PRAGMA foreign_key_check`); expected indexes and triggers exist.
2. **Reconciliation**: row counts per table match expectations derived from the pre-migration copy; every migrated record is accounted for — including a decision, recorded in the verifier's output, for each record that was intentionally dropped or archived. Silent shrinkage is the classic sign of a migration eating data.
3. **Semantic**: for transformations too complex for structural diffing, borrow the dual-read pattern from **GitHub's Scientist** library (used by Stripe in its four-phase online migration playbook): run the *reading* logic of both old and new versions against equivalent state and diff the derived outputs, not just the raw rows. A byte-level diff cannot catch a migration that preserved all the bytes but broke the interpretation.

The convergence check deserves emphasis because agent components re-run their own upgrades: an interrupted upgrade will be retried, so the migration must be **convergent** (a second run reconciles to the same end state), not merely idempotent in the weak `CREATE TABLE IF NOT EXISTS` sense that avoids errors without guaranteeing the same result. Proving it is one extra rehearsal step: run the migration twice on the copy and assert the second run is a no-op.

## Rollback: The Snapshot Is the Undo, and Acceptance Is the Gate

### Down-migrations are a trap here

The strongest argument against scripted down-migrations comes from the GitOps world: a "down" script that undoes the last deploy can **silently drop a column the new version already populated with real data** written between deploy and rollback — data whose existence the down script, written before the deploy, never anticipated. Django codifies the same reality by letting migrations be explicitly irreversible (`RunPython` without `reverse_code` raises `IrreversibleError`), and the practitioner consensus is forward-only: if a bad migration ships, write a *new* forward migration that compensates, or restore the snapshot.

For a single-instance embedded store the conclusion is cleaner still. There is no fleet to roll back in waves; there is one file. The verified pre-migration snapshot **is** the rollback mechanism — restoring it is a byte-exact return to a known state, with the explicit, visible cost that anything written after the migration is discarded. That trade is at least honest; a down-script makes the same trade silently.

Martin Fowler's expand-contract ("Parallel Change") pattern translates into file-level form for embedded stores: rather than mutating the live file in place, migrate a copy, verify it, and atomically swap it in (rename, not in-place edit), leaving the original untouched as the contract-phase artifact — removed only after acceptance. SQLite's own documented 12-step ALTER TABLE procedure embodies the same principle in miniature: build the new table under a temporary name, copy data in, verify foreign keys, and rename *last* — never rename the old one first.

### "Success" is not acceptance

The GitLab database incident of January 31, 2017 is the canonical proof that green statuses are claims, not facts. An engineer accidentally ran a removal command against the primary database, deleting ~300GB of production data — and then discovered that **all five** of GitLab's backup and replication mechanisms were broken or misconfigured: S3 backup uploads had been silently failing, and the failure-notification emails were themselves misconfigured. Recovery depended on an incidental snapshot an engineer had taken six hours earlier for unrelated testing. Roughly 5,000 projects and comments and ~700 user accounts were unrecoverable.

Two rules for agent components fall directly out of this:

- **A backup mechanism that has never been restore-drilled is not a backup mechanism.** The rehearsal loop above doubles as the drill: every migration rehearsal starts by restoring the snapshot into a working copy, so the restore path is exercised on every upgrade rather than trusted on faith.
- **The pre-migration backup is retained until a human explicitly accepts the migrated system — not deleted when the migration "succeeds."** The migration's own exit code, and even the verifier's green run, are machine claims. Acceptance — the owner exercising the upgraded component against real usage and confirming the data is intact — is the event that ends the rollback window. Auto-deleting the backup on reported success collapses the distinction GitLab learned the hard way.

This sequencing also fixes who bears the risk of being wrong. Between "migration succeeded" and "owner accepted," the system runs in a deliberately reversible posture: new version live, old state preserved byte-identical. If a defect surfaces in that window — a semantic break the verifier's checks did not cover — the response is a restore, not an apology.

## A Consolidated Upgrade Runbook for Stateful Agent Components

Pulling the threads together, a migration-bearing upgrade of a stateful agent component should read as an evidence chain:

1. **Snapshot** the live store (`VACUUM INTO` / Backup API) immediately before any change; record its checksum.
2. **Rehearse** the migration on a copy of that snapshot in an inert environment — no live credentials, channels, or schedulers.
3. **Verify** the rehearsal with an independent script (structural + reconciliation + semantic layers) that must exit 0; run the migration a second time on the copy and assert convergence (empty `sqldiff`).
4. **Apply** to the live store only after rehearsal passes, and re-run the same verifier against the live result; the live migration's behavior should match the rehearsal exactly — any divergence (row counts, warnings, duration wildly off) is a stop signal, because it means the rehearsal did not model reality.
5. **Retain** the pre-migration snapshot until the owner explicitly accepts the upgraded system; only then does the rollback window close and cleanup become safe.
6. **Never write a down-migration.** Forward-only migrations plus the retained snapshot cover every rollback case a down-script would, without the silent-data-destruction failure mode.

The pattern costs one extra file copy and one verifier script per component. Against that stands the asymmetry every source in this article converges on: for a single-instance agent, the production data file is not the most important copy — it is the only one, and every safety property must be proven against it before it is touched.

## Sources

- Prisma Migrate shadow database: https://www.prisma.io/docs/orm/prisma-migrate/understanding-prisma-migrate/shadow-database
- Flyway dry runs: https://documentation.red-gate.com/flyway/reference/tutorials/tutorial-dry-runs
- Liquibase commands (validate / updateSQL): https://docs.liquibase.com/commands/home.html
- SQLite 12-step ALTER TABLE procedure: https://www.sqlite.org/lang_altertable.html
- SQLite Online Backup API and VACUUM INTO: https://sqlite.org/backup.html
- sqldiff: https://sqlite.org/sqldiff.html
- Litestream point-in-time restore: https://litestream.io/how-it-works/
- pt-table-checksum (Percona Toolkit): https://docs.percona.com/percona-toolkit/pt-table-checksum.html
- AWS DMS data validation: https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Validating.html
- GitHub Scientist: https://github.com/github/scientist
- Stripe, "Online migrations at scale": https://stripe.com/blog/online-migrations
- Martin Fowler, "Parallel Change": https://www.martinfowler.com/bliki/ParallelChange.html
- Atlas, "The Hard Truth about GitOps and Database Rollbacks": https://atlasgo.io/blog/2024/11/14/the-hard-truth-about-gitops-and-db-rollbacks
- GitLab database incident postmortem (2017): https://about.gitlab.com/blog/postmortem-of-database-outage-of-january-31/
- "Obey the Testing Goat," appendix on testing database migrations: https://www.obeythetestinggoat.com/book/appendix_IV_testing_migrations.html
- pgcopydb: https://pgcopydb.readthedocs.io/
