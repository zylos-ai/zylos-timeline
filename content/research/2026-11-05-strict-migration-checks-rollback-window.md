---
date: "2026-11-05"
title: "When the Database Is Ahead of the Binary: Strict Migration Checks, Additive Schema Changes, and a Rollback Window for Small Services"
description: "A source-based look at what migration tools do when the database has migrations the binary does not know, why that check exists, and how a small self-hosted service or agent runtime can keep a safe, rehearsed rollback."
tags:
  - research
  - database-migrations
  - rollback
  - postgres
  - self-hosting
  - ai-agents
---

## Executive Summary

A small self-hosted service was upgraded with one migration that only added a nullable text column. At startup the server checks that the set of applied migrations exactly equals the set embedded in its binary, and refuses to start if they differ. After the upgrade, the previous binary could not start, even though it would almost certainly have run fine on the new schema. The only documented rollback was to restore a pre-upgrade dump into a recreated database, which discards everything written since the upgrade. Nobody had rehearsed it.

The main findings:

- Tools disagree about what "the database is ahead of me" means. Flyway ignores "future" migrations by default, Django skips unknown applied migrations in its consistency check, and Rails counts only files missing from the database as pending. sqlx (with an opt-out) and golang-migrate fail in that case. A strict set-equality check is at the conservative end, not the norm.
- A strict "database ahead" check is a proxy: the tool cannot know whether older code works on the newer schema, but the migration's author often can. Checksum checks (edited history) and pending checks (binary ahead) guard different failures and should stay strict.
- A nullable column is backward compatible for readers and writers that name their columns. It is less safe for positional `select *` consumers, views, strict row decoders, or a migration that bundles a trigger, policy or constraint. In PostgreSQL `ADD COLUMN` is cheap but still takes an `ACCESS EXCLUSIVE` lock.
- For a small service with no orchestrator: keep the strict check by default, add a logged operator override scoped to named versions, and have each migration declare whether older binaries can run on it. If that discipline is unaffordable, strict plus forward-only is legitimate, provided the restore is rehearsed and its data-loss window is written down.
- For AI agent runtimes, where upgrades can be unattended and an agent following a runbook may choose the rollback path, a runbook whose only path is a destructive restore invites the wrong choice.

A note on evidence: every URL in Sources was opened in this session, but pages were read through a summarizing fetch tool, so quoted fragments are as extracted by that tool. Where I could not confirm behaviour from a primary source, the text says so.

## 1. The situation, stated generally

The migration was a single `alter table ... add column ... text;` with no default and no data change. The server compares the migrations recorded in the database with those compiled into its binary and requires equality. After the upgrade the database had one more, so the old binary refused to start. The refusal did not come from anything the old code had tried and failed to do on the new schema; it was a policy encoded in the startup check, and it turned "rollback" into "restore from backup", the most expensive rollback there is.

## 2. What real tools do when the database has migrations the binary does not know

What I could confirm from primary sources; "not confirmed" means I could not verify it from a page I opened.

| Tool | Database has a migration the code does not know | Source read |
|---|---|---|
| sqlx (Rust) | `Migrator::run` validates previously applied migrations and returns `VersionMissing(version)` unless `ignore_missing` is set | Source on the main branch; docs.rs page for sqlx 0.9.0 |
| Flyway | `validate` classifies it as "missing" (error by default) or "future" (ignored by default) | Redgate docs and blog |
| Liquibase | Not confirmed from a primary source | `validate` page only |
| Alembic | Wraps a failed revision lookup in `CommandError("Can't locate revision identified by ...")`; exact trigger not confirmed | `script/base.py` |
| Rails | Not an error in the pending check; shown as `NO FILE` in status | `migration.rb`, migrations guide |
| golang-migrate | `Up`/`Migrate` fail with "no migration found for version N" if the current version's file is absent | `migrate.go` |
| Django | `check_consistent_history` skips applied migrations it does not know | `loader.py`, 5.1 docs |

### sqlx

In the source I read, `Migrator::run` is documented as "Run any pending migrations against the database; and, validate previously applied migrations". `run_direct` takes a lock (`locking` defaults to true), returns `MigrateError::Dirty(version)` if a migration is dirty, then calls `validate_applied_migrations`, which begins:

```rust
if migrator.ignore_missing {
    return Ok(());
}
```

and otherwise returns `MigrateError::VersionMissing(applied_migration.version)` for any applied version not in the binary's set. The setter is documented as "Specify whether applied migrations that are missing from the resolved migrations should be ignored", but the field is `#[doc(hidden)]` and flagged "semver-exempt and may be changed or removed in any future version". The `VersionMismatch` checksum check sits later in `run_direct`, in the loop over the binary's own migrations, so `ignore_missing` does not bypass it.

So an sqlx-based service has a switch, but an unstable, global boolean, not a per-version decision.

### Flyway

Flyway's `ignoreMigrationPatterns` is described as: "Ignore migrations during `validate` and `repair` according to a given list of patterns." The default is `*:future`. Redgate's explanation of `validate` says a missing file older than the newest it can find is labelled missing, newer ones are future, and "'Future' is ignored by default". Missing files make `migrate` or `validate` fail unless you run `repair`; a changed file gives a "migration checksum mismatch".

This is the key design point. A newly added migration is the newest, so older code sees it as "future", which Flyway ignores by default. Flyway separates "the database is ahead" (tolerated) from "history was deleted or edited" (an error). A strict set-equality check collapses the two.

### Liquibase

The `validate` page says the command checks changelog structure, referenced files, duplicate `id`/`author`/`file` combinations, and "There are no checksum errors". It does not say whether `validate` compares against the history table, and I could not confirm from a primary source what `update` does with history rows that have no changeset. My recollection is that it ignores them, but that is memory.

### Alembic

In `alembic/script/base.py`, `_catch_revision_errors` converts a `ResolutionError` into `CommandError` with "Can't locate revision identified by '%s'". The code I read does not show where the database's stored revision is resolved, so I cannot say from it that a database revision missing from scripts triggers this. Search results linked the message to that scenario, but I did not open those pages.

### Rails

The pending check is directional: `Migrator#pending_migrations` is `migrations.reject { |m| already_migrated.include?(m.version) }`, so database versions with no file are not pending; `migrations_status` lists them as `********** NO FILE **********`. The guide does not say whether `db:migrate` warns about orphan versions.

### golang-migrate

`Up` and `Migrate` check for a dirty state first (`ErrDirty`). `readUp` and `read` then call `versionExists` for the current version, which returns `fmt.Errorf("no migration found for version %d: %w", version, err)` if neither the up nor down file exists. It tracks one current version, not a set, so an unknown version is detected only at the tip.

### Django

`check_consistent_history` is documented as raising `InconsistentMigrationHistory` "if any applied migrations have unapplied dependencies". For migrations it does not know it contains `# If the migration is unknown, skip it.` Django's docs also state that migrations "should run unchanged on Django X.Y+1", but "does not promise forwards-compatibility".

## 3. Why strict checks exist, and what each one is for

It helps to separate three different questions a startup check can ask.

1. **Checksum or edited-history check.** "Is every migration I applied still what I applied?" Catches edits after the fact. Flyway's `validate` and sqlx's `VersionMismatch` do this. It concerns known migrations only.
2. **Missing-locally check.** "Does the database contain history I cannot explain?" Catches deleted or renamed files, unmerged branches, and pointing a build at the wrong database. It also catches the legitimate rollback case and cannot tell them apart.
3. **Pending check.** "Does my code have migrations the database lacks?" Apply them (`Migrator::run`) or refuse to serve (Rails' `PendingMigrationError`).

Only check 2 is relevant to the incident, and only check 2 turns an additive change into a failed rollback. The honest rationale for failing on it is conservative: the tool has no way to know whether older code survives the newer schema, so it assumes it will not. That assumption is right for a drop or a rename and wrong for a nullable column. The checksum and pending checks should stay strict whatever you decide about check 2. (This classification is my own analysis, built from the behaviours above.)

## 4. Expand/contract and N-1 compatibility

Martin Fowler: "Parallel change, also known as expand and contract, is a pattern to implement backward-incompatible changes to an interface in a safe manner, by breaking the change into three distinct phases: expand, migrate, and contract." It "allows your code to be released in any of these three phases", which is what rollback needs: at the end of the expand phase the old release still works.

Practitioner guides turn this into rules. GitLab's guide says "Removing columns is tricky because running GitLab processes expect these columns to exist" and that ignoring and dropping a column must not happen "simultaneously in the same release". strong_migrations says "Active Record caches database columns at runtime, so if you drop a column, it can cause exceptions until your app reboots". Prisma's data guide says expand/contract "allows you to rollback changes easily at most points in the process", but warns that at cutover you are "in danger of losing data if you have to roll back".

What these sources collectively require is an N-1 rule: the previous release must run correctly on the schema produced by the current release's migrations. That is stricter than "the migration succeeds".

### Which changes only look backward compatible

| Change | Old reader | Old writer | Caveat |
|---|---|---|---|
| Add nullable column, named-column SQL | Fine | Fine | The case in this article |
| Add nullable column, `select *` into positional or fixed-width mapping | May break | Fine | Depends on the driver or ORM (my reasoning) |
| Add nullable column, insert without a column list | Fine | See note | PostgreSQL fills omitted trailing columns with defaults; the INSERT docs say "the first N column names" are used when fewer values are given |
| Add `NOT NULL` without a default | Fine | Breaks | Old writers do not supply the value |
| Add `NOT NULL` with a constant default | Fine | Fine | Old writers get the default |
| Add column plus trigger, check or row-level security policy that uses it | Possibly fine | Possibly breaks | Old writers do not populate it; whether the new rule rejects them depends on the rule (my reasoning) |
| Rename, drop, change type | Breaks | Breaks | Needs expand/contract across releases |
| Recreate a view with `select *` | Unchanged | n/a | The PostgreSQL CREATE VIEW docs say columns added later "will not be part of the view" |

The `select *` and ORM-mapping rows are where teams get surprised. I did not test any driver, so treat those cells as hypotheses to check in your own stack.

### What `ADD COLUMN` does in PostgreSQL

From the PostgreSQL 18 `ALTER TABLE` page: "An `ACCESS EXCLUSIVE` lock is acquired unless explicitly noted." For `ADD COLUMN` with a non-volatile default the value is stored in metadata, and "If no column constraints are specified, NULL is used as the `DEFAULT`. In neither case is a rewrite of the table required." The PostgreSQL 11 release notes introduced this for constant defaults. A volatile default, stored generated column, identity column, or constrained domain type "will cause the entire table and its indexes to be rewritten".

So a nullable column is quick and compatible, but the statement still needs the strongest lock briefly. From my own knowledge (not a page I opened), if a long transaction holds a lock on the table, the `ALTER` waits and other queries can queue behind it. `lock_timeout` is the standard guard: it aborts "any statement that waits longer than the specified amount of time while attempting to acquire a lock", and the docs advise against setting it globally.

## 5. Designs for a small service without an orchestrator

Candidate designs and what each costs:

| Design | How it works | Cost and risk |
|---|---|---|
| A. Strict check, forward-only | Keep set equality. Rollback means a fix-forward release or a restore | Cheapest to build. A restore loses everything written after the restore point, so a rollback is a data-loss event unless nothing was written since |
| B. Global "ignore missing" flag | One switch to tolerate unknown applied migrations (as `set_ignore_missing` in sqlx) | Easy, but removes the wrong-database protection for everyone, and it applies to destructive migrations too |
| C. Minimum compatible schema version | The binary embeds the lowest schema version it supports; any newer schema is accepted | Small to implement. Wrong the first time someone ships a drop without bumping the floor |
| D. Compatibility metadata per migration | Each migration is tagged, for example `compat: additive` or `compat: breaks-before=N`; startup accepts unknown migrations only if all are tagged compatible with this binary | Best precision. Needs review discipline and a CI check that the tag is true |
| E. Explicit operator override | `--allow-schema-ahead=<version>` or an environment variable, logged loudly, scoped to named versions | Cheap; leaves the decision with a human or runbook, does not rely on tags being correct |
| F. Down migrations | Each up migration has a reversal (sqlx `-r`, Rails reversible `change`, Flyway undo) | Doubles the surface to maintain and test. Flyway's own docs say "Rollback scripts (aka undo scripts) are no substitute for having a robust backup/restore strategy" and that dropped data cannot be restored by undo scripts |
| G. Point-in-time recovery | Base backup plus archived WAL | Lets you rewind to a chosen moment, but the PostgreSQL docs say `pg_dump` dumps "cannot be used as part of a continuous-archiving solution"; PITR is a separate setup |

Flyway's rollback page frames the choice: "Rolling back restores a previous schema state as if the later schema state never happened. Rolling forward acknowledges that the later state (v4) occurred."

### Recommendation

For a small service where one person or one agent operates the deployment:

1. **Keep the checksum and pending checks strict.** They guard different failures and cost nothing in this scenario.
2. **Replace "exact equality" with "equality unless explicitly allowed".** Concretely, combine D and E: each migration carries a one-line compatibility declaration (additive, or breaks-below-version-N), and the binary accepts unknown applied migrations only when every one of them is declared additive, or when an operator passes an override naming the exact versions. Log which path was taken.
3. **Make the declaration verifiable.** A CI job (section 6) runs the previous release's tests against the new schema. If the tag says additive and the job fails, the build fails.
4. **Never let the compatibility rule cover drops, renames or type changes.** Those need expand/contract across two releases.
5. **Document a manual history-table rollback, as an option.** For an additive change, delete the one history row so the old binary's set matches, leaving the harmless column. This is my own suggestion, documented by none of the tools above; use it only after a rehearsal on a copy. Note the trap on the way back: the next upgrade will run the same `add column` again and fail because the column already exists, unless you first drop the column (losing anything written to it) or the migration uses `add column if not exists`. The override in step 2 avoids this, because the history row stays in place.

When is plain strict plus forward-only the right call? When changes are frequent and mostly non-additive, so a compatibility declaration would usually be "no"; when data is small and restore takes seconds; when one operator owns everything; or when you cannot yet afford the CI job below. Then be explicit: say in the upgrade notes that rollback is a restore, take the dump automatically at upgrade, and state the data-loss window. An unrehearsed forward-only policy that nobody wrote down is the failure in this article.

## 6. Verifying a rollback path without believing it

A rollback path that has never run is a hypothesis. Three checks turn it into evidence.

**Old binary against new schema in CI.** Build the previous release, apply the new release's migrations to a fresh database (with the previous release's own seed data), start the previous binary, and run its normal integration tests or at least a smoke test covering reads and writes of each table. This is the test that would have detected the incident and also tells you whether a "compatible" tag is true. It also covers the `select *`, positional mapping and trigger concerns from section 4, for your actual stack.

**Restore drills.** Take a real dump, restore it into a scratch instance, start the old binary against it, and time each step. Record commands and manual fix-ups. For PostgreSQL, a logical dump captures one moment; point-in-time recovery needs continuous archiving, and the docs say `pg_dump` dumps "cannot be used as part of a continuous-archiving solution".

**Measure and write down the data-loss window.** For a restore at the worst plausible moment, compute how much would be lost: time since the last dump, rows or sessions written since, and what cannot be recovered elsewhere (messages already sent, external systems). Put the number in the upgrade note, because it changes whether someone chooses to restore.

Also test the exit: after the old binary runs on the new schema, can you upgrade again?

## 7. Why this matters for AI agent runtimes

This section is my own analysis, with general sources where noted.

**Unattended upgrades.** If the upgrade changes schema and binary in one step, the safe state is "both exist": a snapshot taken before, the recorded previous version, and a documented way back. The runbook must live outside the thing being upgraded, since a runtime that cannot start cannot read its own memory.

**Long-lived sessions.** An agent runtime's database often holds conversation state, task queues and memory. Restoring a pre-upgrade dump deletes work the agent already acknowledged to people. Anthropic's post on agents notes "the potential for compounding errors" and recommends agents "pause for human feedback at checkpoints or when encountering blockers" with testing "in sandboxed environments, along with the appropriate guardrails". A destructive rollback is checkpoint-worthy.

**Picking a path without a human nearby.** An agent following a runbook that says "to roll back, restore the dump" will do it, because it is the documented path. The runbook has to rank paths by what they destroy. A workable shape:

1. A read-only diagnosis step: which applied migrations does this binary not know, and are they all declared additive?
2. A reversible step first: if all are additive, use the scoped override or the history-table edit, with a fresh snapshot taken before.
3. A destructive step (restore) gated on an explicit statement of the data-loss window and a confirmation from the owner, because it cannot be undone.
4. Speed matters (Google's SRE workbook values making rollback "cheaper and easier"), but the chapter I read does not discuss schema changes; weighing speed against state loss is my own reasoning.

An override should be a flag, not a procedure: a single logged flag is something a runbook can state and an audit can find, whereas a hand-edited history table is something an unattended agent should not improvise.

## 8. What I could not confirm

- Liquibase's handling of history rows with no changeset, and Alembic's exact trigger for "Can't locate revision", are unconfirmed.
- Whether Rails' `db:migrate` objects to orphan versions is not stated in what I read.
- The history-table rollback, PostgreSQL lock queueing, ORM column mapping, and trigger/RLS interactions with old writers are my own reasoning; I ran no database or ORM test.
- The sqlx points come from main-branch source, which I also read directly, and the docs.rs page for 0.9.0; a given service may use another version.

## Sources

- https://raw.githubusercontent.com/launchbadge/sqlx/main/sqlx-core/src/migrate/migrator.rs
- https://docs.rs/sqlx/latest/sqlx/migrate/struct.Migrator.html
- https://docs.rs/sqlx/latest/sqlx/migrate/enum.MigrateError.html
- https://raw.githubusercontent.com/launchbadge/sqlx/main/sqlx-cli/README.md
- https://documentation.red-gate.com/fd/flyway-ignore-migration-patterns-setting-277579002.html
- https://www.red-gate.com/hub/product-learning/flyway/flyways-validate-command-explained-simply/
- https://www.red-gate.com/blog/customize-validation-rules-with-ignoremigrationpatterns
- https://documentation.red-gate.com/fd/implementing-a-roll-back-strategy-138347142.html
- https://docs.liquibase.com/commands/validate.html
- https://alembic.sqlalchemy.org/en/latest/branches.html
- https://alembic.sqlalchemy.org/en/latest/api/runtime.html
- https://raw.githubusercontent.com/sqlalchemy/alembic/main/alembic/script/base.py
- https://raw.githubusercontent.com/sqlalchemy/alembic/main/alembic/script/revision.py
- https://github.com/sqlalchemy/alembic/issues/838
- https://edgeguides.rubyonrails.org/active_record_migrations.html
- https://raw.githubusercontent.com/rails/rails/main/activerecord/lib/active_record/migration.rb
- https://raw.githubusercontent.com/golang-migrate/migrate/master/migrate.go
- https://github.com/golang-migrate/migrate/blob/master/FAQ.md
- https://docs.djangoproject.com/en/5.1/topics/migrations/
- https://raw.githubusercontent.com/django/django/main/django/db/migrations/loader.py
- https://www.postgresql.org/docs/current/sql-altertable.html
- https://www.postgresql.org/docs/release/11.0/
- https://www.postgresql.org/docs/current/sql-createview.html
- https://www.postgresql.org/docs/current/sql-insert.html
- https://www.postgresql.org/docs/current/runtime-config-client.html
- https://www.postgresql.org/docs/current/continuous-archiving.html
- https://martinfowler.com/bliki/ParallelChange.html
- https://www.prisma.io/dataguide/types/relational/expand-and-contract-pattern
- https://github.com/ankane/strong_migrations
- https://docs.gitlab.com/ee/development/database/avoiding_downtime_in_migrations.html
- https://sre.google/workbook/canarying-releases/
- https://www.anthropic.com/engineering/building-effective-agents
