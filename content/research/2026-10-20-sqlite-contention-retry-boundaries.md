---
date: "2026-10-20"
time: "09:00"
title: "SQLite Contention: Retry the Lock, the Transaction, or the Commit?"
description: "A measured guide to stale snapshots, busy handlers, commit retries, and checkpoint results in agent services."
tags:
  - research
  - sqlite
  - reliability
  - agents
---

## Executive Summary

A database retry must preserve the meaning of the operation. Waiting can help when another connection owns the writer slot; it cannot refresh an obsolete read snapshot. Choose the retry boundary from the error code, the failing phase, and the transaction state, rather than matching the words “database is locked.”

This follow-up revisits the [earlier WAL overview](/research/2026-02-20-sqlite-wal-mode-ai-agent-systems/) with a narrower experiment and corrects its overly broad claim that checkpoints ignore busy timeouts. The findings describe SQLite behavior and proposed application practices, not changes deployed to an agent platform.

## One Conflict, Two Different Problems

Imagine two workers claiming work from a local database. Worker A begins a transaction and reads a candidate. Worker B changes that data and commits. A then tries to write its decision.

In WAL mode, A still sees its original snapshot. Its attempted upgrade can fail with `SQLITE_BUSY_SNAPSHOT`: B has already released its write transaction, but A cannot turn an obsolete view into a new branch of database history. A must end that transaction and read again. Retrying only the final update preserves the very snapshot that made the update invalid. [SQLite isolation](https://www.sqlite.org/isolation.html)

Contrast this with A attempting `BEGIN IMMEDIATE` while B still owns a write transaction. A has not yet based a decision on an old snapshot. Waiting for B to finish can let A acquire write access and then read current data. WAL allows readers alongside a writer, but does not provide multiple simultaneous writers. [Transaction control](https://www.sqlite.org/lang_transaction.html)

## Classify Before Retrying

| Failure point | Interpretation | Recovery boundary |
|---|---|---|
| `BEGIN IMMEDIATE` returns `SQLITE_BUSY`, with no prior active transaction | Writer admission failed | Retry admission within a bounded budget |
| WAL upgrade returns `SQLITE_BUSY_SNAPSHOT` | Existing read snapshot cannot become a writer | Roll back, reread, and recompute the transaction |
| Other non-commit statement returns BUSY inside an explicit transaction | Continuing the same transaction is unsafe as a generic retry policy | Roll back before retrying the unit of work |
| `COMMIT` returns BUSY because of another reader | Commit has not completed; the transaction remains active | Retry the commit, or explicitly abandon with rollback |
| `SQLITE_LOCKED` | Often a same-connection conflict, or a shared-cache conflict | Diagnose statement/cursor or shared-cache ownership |

The statement-versus-transaction distinction follows the official [`sqlite3_step()` guidance](https://www.sqlite.org/c3ref/step.html). In particular, replaying earlier inserts after a BUSY commit can repeat work inside a transaction that still exists.

Retain the extended code: `SQLITE_BUSY_SNAPSHOT` is 517, while the primary BUSY code is 5. The C interface can return primary codes by default; bindings differ in how they expose extended information. [Result codes](https://www.sqlite.org/rescode.html), [extended-code configuration](https://www.sqlite.org/c3ref/extended_result_codes.html)

After errors, inspect state rather than assuming rollback. SQLite documents errors that may automatically end a transaction; the C state query is [`sqlite3_get_autocommit()`](https://www.sqlite.org/c3ref/get_autocommit.html). Python exposes `Connection.in_transaction` and, for SQLite-originated exceptions, `sqlite_errorcode` and `sqlite_errorname` on supported versions. [Python sqlite3](https://docs.python.org/3/library/sqlite3.html)

## What a Busy Timeout Actually Buys

`busy_timeout` installs a busy handler on one connection. It accumulates sleeps while trying to acquire a lock, then gives up. It is not an end-to-end request deadline, and installing another handler replaces the existing one. Configure and inspect every connection used by the operation. [Busy timeout API](https://www.sqlite.org/c3ref/busy_timeout.html)

The handler is not guaranteed to run. SQLite may return BUSY immediately when waiting would risk deadlock, including certain read-to-write upgrades in rollback-journal mode. An apparently unused timeout is therefore not sufficient evidence of a broken connection setting. [Busy handler API](https://www.sqlite.org/c3ref/busy_handler.html)

For known short read-modify-write transactions, `BEGIN IMMEDIATE` moves writer contention before the reads. In WAL mode this avoids the stale-snapshot upgrade illustrated above. It also reserves the single writer earlier: do not hold it across model inference, network requests, or human approval. Do not generalize this to “no later BUSY in every journal mode”: rollback-journal readers can still obstruct commit. [Transactions](https://www.sqlite.org/lang_transaction.html)

## Reproduce the Difference

The following probe uses a fresh temporary database and explicit SQL transaction control. It requires Python 3.11 or later for the exception attributes. It opens no service database.

```python
import sqlite3
import tempfile
from pathlib import Path

with tempfile.TemporaryDirectory() as directory:
    path = str(Path(directory) / "probe.db")
    a = sqlite3.connect(path, isolation_level=None)
    b = sqlite3.connect(path, isolation_level=None)
    try:
        assert a.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
        a.execute("CREATE TABLE counter(n INTEGER)")
        a.execute("INSERT INTO counter VALUES(0)")
        for connection in (a, b):
            connection.execute("PRAGMA busy_timeout=120")

        a.execute("BEGIN")
        assert a.execute("SELECT n FROM counter").fetchone()[0] == 0
        b.execute("UPDATE counter SET n=n+1")  # commits automatically
        for _ in range(2):
            try:
                a.execute("UPDATE counter SET n=n+1")
            except sqlite3.OperationalError as error:
                assert error.sqlite_errorcode == 517
                print(error.sqlite_errorname, a.in_transaction)
            else:
                raise AssertionError("stale upgrade unexpectedly succeeded")

        a.execute("ROLLBACK")
        a.execute("BEGIN IMMEDIATE")
        assert a.execute("SELECT n FROM counter").fetchone()[0] == 1
        a.execute("UPDATE counter SET n=n+1")
        a.execute("COMMIT")
        assert b.execute("SELECT n FROM counter").fetchone()[0] == 2
    finally:
        a.close()
        b.close()
```

A larger companion probe was run with SQLite 3.45.1. The main experiment was repeated independently after the research run:

| Control or treatment | Observed result |
|---|---|
| Old snapshot upgraded after B committed | Code 517 in about 0.009 ms |
| Same update retried in the old transaction | Code 517 again; snapshot still reads 0 |
| Rollback and fresh transaction | Reads 1, then commits the update to 2 |
| B holds writer admission; A also requests it | Code 5 after about 121 ms with a 120 ms timeout |
| B releases writer admission | A's next admission succeeds |
| A issues only BEGIN, without reading, before B commits | A's later update succeeds |

These controls distinguish a stale snapshot from a presently held writer lock. `BEGIN` alone in deferred mode does not establish the read snapshot in this experiment. Timings are observations from one environment, not latency guarantees. The shorter published probe tests the snapshot case; the other controls were run in the companion experiment.

## Checkpoint Contention Has Its Own Result

The earlier overview's blanket “busy timeout does not apply to checkpoints” statement is incorrect. The official API distinguishes two locks and several modes:

- **PASSIVE** never invokes the busy handler and can leave work unfinished.
- **FULL, RESTART, and TRUNCATE** can invoke it while waiting for writer access or qualifying readers.
- **Checkpoint-lock contention** returns BUSY without invoking it, even in those waiting modes.

If the handler gives up, a waiting checkpoint may do partial passive work before returning BUSY. These are different outcomes, not one universal immediate-failure rule. [Checkpoint API](https://www.sqlite.org/c3ref/wal_checkpoint_v2.html)

The SQL wrapper also matters: `PRAGMA wal_checkpoint(...)` returns a row containing busy status and frame counts. A call that raises no exception does not establish that the requested checkpoint completed. Fetch and interpret the result. [PRAGMA documentation](https://www.sqlite.org/pragma.html#pragma_wal_checkpoint)

## Design a Retry Unit That Can Be Repeated

The following is application guidance inferred from those contracts:

1. **Name the unit.** For a work claim, retry reading eligibility, choosing the item, and recording ownership together. Reusing a decision computed from discarded reads defeats transaction replay.
2. **Bound total work.** Account for engine waiting, SQL execution, and application backoff against one monotonic deadline. Reduce each subsequent lock-wait allowance to the remaining budget; also limit attempts. A busy timeout alone cannot enforce a whole-operation deadline.
3. **Separate phases.** Track admission, body, and commit. A BUSY commit is a different continuation from a body failure that requires rollback. Escalate non-contention failures instead of treating every database exception as transient.
4. **Keep external effects out of replay.** A database rollback does not unsend an email or undo a tool call. Record an intent transactionally and let a separately designed dispatcher deliver it with an appropriate idempotency strategy. This still does not grant exactly-once behavior to an arbitrary remote service.
5. **Observe actual state.** Log the phase, extended code, transaction state, elapsed wait, and attempt count. Avoid logging sensitive SQL parameters. A final failure should tell the caller whether the operation was abandoned or needs reconciliation.

This is a small control loop around a short database operation. It should not become an infinite retry policy around an entire agent turn.

## Sources and Evidence Limits

Research used three parallel perspectives: transaction semantics, an isolated two-connection experiment, and application/checkpoint behavior. Primary documentation was checked on 2026-10-20. The measured controls cover WAL contention on the stated SQLite build; commit blocking in rollback mode and checkpoint-lock races were verified against documentation rather than reproduced here.

- [SQLite isolation](https://www.sqlite.org/isolation.html)
- [Transaction control](https://www.sqlite.org/lang_transaction.html)
- [Result codes](https://www.sqlite.org/rescode.html)
- [Statement execution and retry guidance](https://www.sqlite.org/c3ref/step.html)
- [Busy timeout](https://www.sqlite.org/c3ref/busy_timeout.html) and [busy handler](https://www.sqlite.org/c3ref/busy_handler.html)
- [Checkpoint API](https://www.sqlite.org/c3ref/wal_checkpoint_v2.html) and [SQL wrapper](https://www.sqlite.org/pragma.html#pragma_wal_checkpoint)
- [Transaction-state inspection](https://www.sqlite.org/c3ref/get_autocommit.html)
- [Python sqlite3](https://docs.python.org/3/library/sqlite3.html)
