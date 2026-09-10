---
date: "2026-07-26"
title: "Data Migration Rehearsal and Verification for Stateful AI Agent Components"
description: "Why single-instance agent components must rehearse migrations on real data copies, verify with independent gates, and treat backups — not down-migrations — as the rollback path."
tags: ["data-migration", "sqlite", "verification", "backup-restore", "ai-agents", "upgrade-safety", "rollback", "embedded-databases"]
---

## Executive Summary

Classic database migration practice assumes a DBA in the loop, a client-server RDBMS, a staging tier, and a CI/CD gate between "migration written" and "migration applied." Stateful AI agent components invert every one of those assumptions: storage is embedded (a SQLite file, JSONL logs, markdown knowledge stores), there is exactly one copy of the data, nobody is watching the terminal, and the process performing the upgrade is often the agent itself. When Rails-style migration workflow assumptions quietly ride along into this environment, the failure mode is not a bad deploy that ops rolls back — it is silent, unattended corruption of the only copy of an agent's memory.

This article assembles a migration discipline for that environment from verifiable industry prior art. The core loop: take a live snapshot of the real data (SQLite's Backup API or `VACUUM INTO`), rehearse the migration against that copy with all live effectors disabled, verify the result with an independent checker that must exit 0 — not the migration script's own return code — then enter a maintenance window, stop and drain all database users, take a final snapshot that includes the latest committed writes, and migrate and verify a fresh copy before cutover. Retain the final pre-migration backup until a human explicitly accepts the result. Down-migrations are deliberately absent: for single-instance embedded stores, the verified snapshot is the rollback path, because scripted "undo" logic cannot account for data the new version wrote in the meantime.

The cited sources support different parts of this proposed discipline, not a shared implementation of the entire loop. Prisma's shadow database illustrates schema-history replay; Flyway dry runs illustrate SQL preview. Neither establishes that a migration has run against copied production records. SQLite backup and migration procedures, data-comparison tools, and staged migration examples supply other building blocks. Combining real-data rehearsal, independent verification, and backup retention until acceptance is this article's recommendation for the stated environment.

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

**Prisma Migrate's shadow database** illustrates isolated schema replay: it creates a fresh shadow database (or resets a configured one), reruns migration history, introspects the resulting schema, and compares it with the development database to detect drift. This is not a copy of production records or a real-data migration rehearsal. The shadow database must use a different connection string from the development database to avoid data deletion. Production-focused commands such as `prisma migrate deploy` do not use it; that fact does not prove any separate rehearsal occurred. See [Prisma's shadow-database workflow](https://www.prisma.io/docs/orm/v7/prisma-migrate/understanding-prisma-migrate/shadow-database).

**Flyway's dry-run mode** (`flyway.dryRunOutput=<file>`) computes the full SQL a migration would execute and writes it to a file for review without touching the target — explicitly recommended before unattended overnight runs, which is precisely the agent situation. **Liquibase** splits the same concern into `validate` (changelog consistency) and `updateSQL` (preview exact SQL before the real `update`). For Postgres-scale systems, **pgcopydb** exists to stand up a full resumable clone of a production instance specifically so an upgrade can be rehearsed end-to-end.

The backup-testing world contributes the framing that ties this together: a backup is not a recovery plan until someone has restored it and inspected the result. The same logic applies verbatim — a migration is not safe until it has *actually run* against a real copy and the output has been examined, not merely planned and reviewed.

### The agent-component recipe

For an embedded SQLite store, the rehearsal loop is scriptable. This is a rehearsal, not a production cutover. Run from a fresh, private rehearsal directory with `live.db` resolved to the intended source; all output paths below must be unused. The migration and verifier commands are component-specific placeholders; `sqldiff` is a separate SQLite utility that must be available.

```bash
set -euo pipefail

# 1. Consistent live snapshot; preserve it for reconciliation
sqlite3 -bail live.db ".backup 'before.db'"
sqlite3 -bail before.db ".backup 'rehearsal-first.db'"

# 2. Run the new version's migration against the copy
NEW_VERSION_MIGRATE --db rehearsal-first.db

# 3. Independent verification (see next section) — must exit 0
verify-migration --db rehearsal-first.db

# 4. Preserve run 1; execute run 2 on its own consistent copy
sqlite3 -bail rehearsal-first.db ".backup 'rehearsal-second.db'"
NEW_VERSION_MIGRATE --db rehearsal-second.db
verify-migration --db rehearsal-second.db

# 5. Check both command success and actual output, not exit status alone
sqldiff rehearsal-first.db rehearsal-second.db > second-run.diff.sql
test ! -s second-run.diff.sql
sqldiff --table sqlite_schema rehearsal-first.db rehearsal-second.db > second-run.schema.sql
test ! -s second-run.schema.sql
```

The CLI `.backup` command uses SQLite's Online Backup API; `VACUUM INTO` is another consistent snapshot primitive, but may change implicit rowids. Neither promises zero contention or captures future writes. The preserved `before.db` supplies the reconciliation baseline to the component-specific verifier. Every migration/verifier process must finish and close its connections before comparison; nothing writes to the first-run result after step 3. [SQLite Backup API](https://sqlite.org/backup.html), [VACUUM](https://www.sqlite.org/lang_vacuum.html).

An empty ordinary `sqldiff` is not a complete schema check: triggers, views, and some column-definition differences need the separate `sqlite_schema` comparison. That output is diagnostic, never SQL to execute. Virtual tables and application-specific state require explicit verifier coverage; add a deliberately changed row/schema as a negative control to demonstrate that the gate rejects differences. [sqldiff limitations](https://sqlite.org/sqldiff.html).

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

The convergence check deserves emphasis because agent components re-run their own upgrades: an interrupted upgrade will be retried, so the migration must be **convergent** (a second run reconciles to the same end state), not merely idempotent in the weak `CREATE TABLE IF NOT EXISTS` sense that avoids errors without guaranteeing the same result. Check the repeated-run case by preserving the first result, migrating an independent copy of it, and asserting no logical or schema change. This does not prove restart safety at every intermediate failure point; interrupted migrations also need failure-injection cases.

## Rollback: The Snapshot Is the Undo, and Acceptance Is the Gate

### Down-migrations are a trap here

The strongest argument against scripted down-migrations comes from the GitOps world: a "down" script that undoes the last deploy can **silently drop a column the new version already populated with real data** written between deploy and rollback — data whose existence the down script, written before the deploy, never anticipated. Django codifies the same reality by letting migrations be explicitly irreversible (`RunPython` without `reverse_code` raises `IrreversibleError`), and the practitioner consensus is forward-only: if a bad migration ships, write a *new* forward migration that compensates, or restore the snapshot.

For a single-instance embedded store the conclusion is cleaner still. There is no fleet to roll back in waves; there is one file. The verified pre-migration snapshot **is** the rollback mechanism — restoring it returns the database to the captured state, with the explicit, visible cost that anything written after the migration is discarded. That trade is at least honest; a down-script makes the same trade silently.

Keeping an old database generation is useful, but it is not an online SQLite migration protocol. A POSIX rename switches a pathname; it does not transfer connections or replay commits made after a rehearsal snapshot. SQLite explicitly warns that renaming an open database can leave different files sharing journal/WAL names, and that a database must remain paired with its recovery journal. [SQLite corruption guidance, §§1.4 and 2.5](https://www.sqlite.org/howtocorrupt.html).

SQLite's 12-step ALTER TABLE procedure changes tables through SQLite transactions. Its table renames do not justify filesystem replacement of an active database. The maintenance-window procedure below is this article's proposed operational synthesis, not a SQLite-provided online cutover guarantee. [SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html).

### "Success" is not acceptance

The GitLab database incident of January 31, 2017 is the canonical proof that green statuses are claims, not facts. An engineer accidentally ran a removal command against the primary database, deleting ~300GB of production data — and then discovered that **all five** of GitLab's backup and replication mechanisms were broken or misconfigured: S3 backup uploads had been silently failing, and the failure-notification emails were themselves misconfigured. Recovery depended on an incidental snapshot an engineer had taken six hours earlier for unrelated testing. Roughly 5,000 projects and comments and ~700 user accounts were unrecoverable.

Two rules for agent components fall directly out of this:

- **A backup mechanism that has never been restore-drilled is not a backup mechanism.** The rehearsal loop above doubles as the drill: every migration rehearsal starts by restoring the snapshot into a working copy, so the restore path is exercised on every upgrade rather than trusted on faith.
- **The pre-migration backup is retained until a human explicitly accepts the migrated system — not deleted when the migration "succeeds."** The migration's own exit code, and even the verifier's green run, are machine claims. Acceptance — the owner exercising the upgraded component against real usage and confirming the data is intact — is the event that ends the rollback window. Auto-deleting the backup on reported success collapses the distinction GitLab learned the hard way.

This sequencing also fixes who bears the risk of being wrong. Between "migration succeeded" and "owner accepted," the old snapshot remains available, but once the new version accepts writes, restoration loses those later writes unless they can be separately reconciled. If a defect surfaces, stop writers and decide whether to preserve/replay that new data or explicitly accept its loss before restoring; backup retention alone does not make rollback lossless.

## A Consolidated Upgrade Runbook for Stateful Agent Components

Pulling the threads together, a migration-bearing upgrade of a stateful agent component should read as an evidence chain:

1. **Rehearse ahead of downtime.** Capture a live snapshot and run the inert rehearsal and independent checks above. Record migration/version identifiers and expected transformations. Rehearsal output is evidence, never the later production replacement: the running service may have committed new data since that snapshot.
2. **Enter maintenance and prevent reopening.** Block new requests, pause schedulers/consumers and automatic restarts, drain in-flight transactions, then stop every reader and writer (including administrative tools) and close all their connections. Keep this exclusion in force through validation and cutover. If all users cannot be accounted for, stop the upgrade.
3. **Capture the final source.** With application access blocked, use a maintenance connection to let SQLite recover any hot journal. For a WAL database, run `PRAGMA wal_checkpoint(TRUNCATE)` and check its returned busy/result values: a busy result or incomplete checkpoint is a stop, not success. Create a fresh final backup with the Backup API; verify its integrity and expected last committed records, record its checksum, and close the maintenance connection. This snapshot replaces the earlier rehearsal baseline for reconciliation. [Checkpoint result semantics](https://www.sqlite.org/pragma.html#pragma_wal_checkpoint).
4. **Migrate the final copy.** Make a separate working copy of that final backup, run the approved migration, then perform integrity, foreign-key, structural, reconciliation and semantic checks against the final baseline. New rows since rehearsal are expected; unexplained differences from the transformation contract are not. Close every migration and verifier connection. This offline procedure accepts downtime for copying, migration and verification; it has no incremental catch-up mechanism.
5. **Prepare a closed, self-contained candidate.** Use SQLite to recover/checkpoint the candidate as needed, then close its last connection and verify the database is self-contained. Before replacement, require both generations to have no remaining `-wal`, `-shm` or `-journal` files. If sidecars remain, stop and investigate through SQLite; never blindly delete them to satisfy this gate. Preserve any unresolved database and sidecars together under their original names. Last-connection cleanup normally removes WAL sidecars, but persistence settings and abnormal shutdown can leave them behind. [SQLite WAL lifecycle](https://www.sqlite.org/wal.html#the_wal_file).
6. **Cut over while access stays blocked.** Retain the verified final backup and the matching old executable/configuration. Stage the candidate on the same filesystem with correct ownership/permissions, flush the file, replace the closed production pathname, and flush the containing directory using a tested platform-specific deployment mechanism. No old connection or sidecar may survive into this step. Record which generation is installed; after interruption, inspect that record and verify the file before starting any process. Atomic rename alone is neither a database transaction nor a crash-durability guarantee.
7. **Verify before reopening.** Start the new version with external traffic and effectors still blocked, confirm it opens the intended database/schema, and run read-only smoke checks. If this fails, stop it and close its connections before restoring the final backup and old executable using the same sidecar/durability precautions. Reopen traffic only after checks pass. Once writes resume, snapshot restoration requires an explicit decision about post-cutover data loss or a tested reconciliation path.
8. **Retain until acceptance.** Keep the final pre-migration backup until the owner accepts the upgraded system and its recovery limits. For this runbook, use forward fixes or a controlled restore rather than assuming a down-migration can recover lost information.

The proposed pattern costs storage for several copies, an independent verifier, and a maintenance window long enough for the final migration and checks. The sources above support distinct techniques, from schema replay and SQL preview to data validation and staged change. They do not establish that the full protocol has already been exercised. For the single-instance environment considered here, real-data rehearsal and final-copy verification remain separate work whose evidence must be collected before cutover.

## Sources

- Prisma Migrate shadow database: https://www.prisma.io/docs/orm/prisma-migrate/understanding-prisma-migrate/shadow-database
- Flyway dry runs: https://documentation.red-gate.com/flyway/reference/tutorials/tutorial-dry-runs
- Liquibase commands (validate / updateSQL): https://docs.liquibase.com/commands/home.html
- SQLite 12-step ALTER TABLE procedure: https://www.sqlite.org/lang_altertable.html
- SQLite Online Backup API: https://sqlite.org/backup.html
- SQLite VACUUM INTO: https://www.sqlite.org/lang_vacuum.html
- SQLite corruption guidance (§§1.4 and 2.5): https://www.sqlite.org/howtocorrupt.html
- SQLite checkpoint result semantics: https://www.sqlite.org/pragma.html#pragma_wal_checkpoint
- SQLite WAL lifecycle: https://www.sqlite.org/wal.html#the_wal_file
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
