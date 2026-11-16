---
date: "2026-10-16"
time: "09:00"
title: "SQLite WAL Growth: Bound the Reader Lifetime, Not Just the Query"
description: "A reproducible experiment shows how idle read transactions stall checkpoints while writes succeed, and how agent observability can release snapshots before waiting on clients."
tags: ["research", "sqlite", "wal", "observability", "ai-agents", "reliability"]
---

## Executive Summary

An agent can keep recording events successfully while its observer prevents SQLite from reclaiming the write-ahead log. The failure can hide behind a checkpoint result whose first column is zero. A local experiment reproduced this: after 300 additional commits, a pinned reader left 451 frames uncheckpointed; releasing that reader allowed all frames to be checkpointed, but did not shrink the file. A subsequent successful truncating checkpoint reduced it to zero bytes.

For dashboard and export authors, the practical recommendation is to bound the lifetime of database snapshots independently of network requests. Fetch a bounded result, finish its database transaction, then wait on the client. This article investigates that storage boundary; transport queue limits, pagination completeness, backups, and migrations are separate concerns.

## The observer can retain history after its query finishes

Consider a service that opens a read transaction, selects a dashboard snapshot, and waits for a browser before committing. The SQL may take milliseconds. The read transaction may remain open for minutes.

SQLite WAL readers retain a view associated with an end mark. Writers append newer changes while that view remains stable. A checkpoint transfers eligible WAL content back to the database, but cannot advance past changes that would invalidate an active reader's view. Long or continuously overlapping readers can therefore prevent WAL recycling. The usual automatic checkpoint threshold is 1,000 pages, subject to configuration; crossing it requests checkpoint work, rather than imposing a hard file-size ceiling. [SQLite WAL concurrency and checkpoint starvation](https://www.sqlite.org/wal.html)

The application has two different lifetimes to manage. An implicit transaction generally ends when its final active statement finishes; resetting or finalizing a statement guarantees that it is finished. An explicit transaction normally persists until `COMMIT` or `ROLLBACK`. Exhausting a result set inside an explicit transaction does not end that transaction. SQLite also distinguishes a deferred `BEGIN` from the read transaction established by a subsequent database access. [SQLite transaction lifecycle](https://www.sqlite.org/lang_transaction.html)

This distinction suggests a specific review question: does any code await a socket, external tool, user action, or retry delay while still owning a database snapshot? Optimizing the query cannot eliminate that waiting interval.

## A controlled reproduction

The following experiment uses three hundred small, separately committed inserts. All connections access a newly created temporary database; no existing database is opened. Automatic checkpointing is disabled deliberately so each checkpoint observation has an explicit cause. SQL operations execute sequentially in one thread, while the reader transaction remains open across writer operations.

Observed environment: Python **3.12.3**, SQLite **3.45.1**, page size **4,096 bytes**. The bundled SQLite source identifier was `2024-01-30 16:01:20 e876e51a0ed5c5b3126f52e532044363a014bc594cfefa87ffb5b82257ccalt1`. Frame counts below are measurements of this schema and build, not portable constants.

```python
import pathlib
import sqlite3
import tempfile

root = pathlib.Path(tempfile.mkdtemp(prefix="wal-reader-test-"))
path = root / "test.db"
w = sqlite3.connect(path, isolation_level=None, timeout=0)
w.execute("PRAGMA page_size=4096")
assert w.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
w.execute("PRAGMA wal_autocheckpoint=0")
w.execute("CREATE TABLE events(id INTEGER PRIMARY KEY, body BLOB)")
w.execute("INSERT INTO events(body) VALUES (?)", (b"x" * 1000,))
r = sqlite3.connect(path, isolation_level=None, timeout=0)
r.execute("BEGIN")
assert r.execute("SELECT count(*) FROM events").fetchone()[0] == 1
wal = pathlib.Path(str(path) + "-wal")

def checkpoint(label, mode="PASSIVE"):
    result = w.execute("PRAGMA wal_checkpoint(" + mode + ")").fetchone()
    print(label, result, wal.stat().st_size)
    return result

checkpoint("reader pinned")
for batch in range(1, 4):
    for _ in range(100):
        w.execute("INSERT INTO events(body) VALUES (?)", (b"x" * 1000,))
    status, frames, copied = checkpoint(f"{batch * 100} writes")
    assert status == 0 and frames > copied
assert checkpoint("truncate pinned", "TRUNCATE")[0] == 1
assert r.execute("SELECT count(*) FROM events").fetchone()[0] == 1
r.execute("COMMIT")
status, frames, copied = checkpoint("reader released")
assert status == 0 and frames == copied
assert checkpoint("truncate released", "TRUNCATE") == (0, 0, 0)
assert wal.stat().st_size == 0
assert r.execute("SELECT count(*) FROM events").fetchone()[0] == 301
assert w.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
r.close()
w.close()
```

The three returned columns are shown as `(status, WAL frames, checkpointed frames)`:

| Observation | Result | WAL bytes |
| --- | --- | ---: |
| Reader pinned, before additional writes | `(0, 3, 3)` | 12,392 |
| After 100 inserts | `(0, 154, 3)` | 634,512 |
| After 200 inserts | `(0, 304, 3)` | 1,252,512 |
| After 300 inserts | `(0, 454, 3)` | 1,870,512 |
| TRUNCATE while reader remains pinned | `(1, 454, 3)` | 1,870,512 |
| PASSIVE after reader commits | `(0, 454, 454)` | 1,870,512 |
| TRUNCATE after reader commits | `(0, 0, 0)` | 0 |

The reader still saw one row after all writes. After committing its transaction, a new read saw 301. This establishes that the test retained the original view rather than merely keeping an idle connection open. The final integrity check returned `ok`; it is a check of this run, not a general durability proof.

The initial `(0, 3, 3)` is also useful: all existing frames were checkpointed while the read transaction was active. An active reader does not necessarily imply that zero checkpoint work is possible. Later commits created the divergence.

## Why zero does not mean fully checkpointed

The PRAGMA's first column reports whether the equivalent checkpoint call returned success or busy. Its other columns describe log and checkpoint progress; absent WAL state can produce `-1` values. Treat those as unavailable values rather than subtracting them into a plausible backlog. [SQLite WAL checkpoint PRAGMA](https://www.sqlite.org/pragma.html#pragma_wal_checkpoint)

PASSIVE does the work available without waiting for readers or writers, and does not invoke the busy handler. It can return successfully with unfinished work. FULL waits for the conditions needed to checkpoint all frames; RESTART additionally waits until readers no longer require the WAL, allowing the next writer to restart it. TRUNCATE adds file truncation to RESTART's requirements. Busy-handler termination can prevent stronger modes from completing. [SQLite checkpoint API contract](https://www.sqlite.org/c3ref/wal_checkpoint_v2.html)

In the experiment, PASSIVE returned zero with a 451-frame gap. The pinned TRUNCATE returned one because it could not finish and the connections had a zero busy timeout. Increasing a timeout would not change what snapshot the reader needed; it would only offer more time for the reader to release it.

After release, equal frame counts established complete checkpoint progress at that observation. The unchanged file length showed something different: checkpoint completion and physical truncation are separate outcomes. Therefore, neither a large file alone nor a zero status alone identifies starvation.

The measured length also reconciles with the format: a WAL has a 32-byte header, followed by frames containing a 24-byte header and one database page. Here `32 + 454 × (24 + 4096) = 1,870,512`. Do not apply this arithmetic as a universal count of currently live frames: recycled file capacity and current logical contents can differ. [SQLite WAL file format](https://www.sqlite.org/fileformat2.html#walformat)

## Proposed observability design

The following is an application policy inferred from the experiment, not a SQLite guarantee or a deployed feature.

**Separate acquisition from delivery.** For a dashboard refresh, read a bounded page into an application-owned buffer, finish statements and the explicit transaction, then serialize and deliver. Bound rows and bytes as well as elapsed database time. Moving an unlimited export into memory would exchange disk retention for memory exhaustion.

**Make consistency costs explicit.** Independent short read transactions can observe different committed states. If an export requires a single coherent view, specify that requirement and give its snapshot a deadline and a resource budget. Do not quietly replace it with paginated live reads and continue calling the result a snapshot. SQLite's documented WAL isolation explains why an uninterrupted transaction preserves the earlier view. [SQLite isolation](https://www.sqlite.org/isolation.html)

**Instrument ownership.** Record the operation holding each explicit read transaction, its start time, and its completion or cancellation. Also account for active statements when the binding uses implicit transactions. The SQLite C API exposes per-schema transaction state through `sqlite3_txn_state()`; that reports state, not a transaction start timestamp or request owner. Application instrumentation must supply those. [SQLite transaction-state API](https://www.sqlite.org/c3ref/txn_state.html)

**Observe several signals together.** Sample WAL bytes, valid log/checkpoint frame counts, checkpoint duration and mode, oldest owned reader age, and filesystem headroom. A growing gap plus an old reader is a useful investigation trigger. A single gap is not proof of a leak, and a large reusable WAL is not itself evidence of uncheckpointed data. PASSIVE sampling performs work; do not label it a read-only metric.

**Recover through the owner.** Cancel or finish the expired observation through its normal cleanup path, verify the transaction is released, and retry a checkpoint. Use a stronger checkpoint only with an explicit wait budget and awareness of writer interference. A successful retry must be read back; repeatedly requesting truncation while the same reader remains pinned is not a lifecycle fix. Never manually delete an active WAL to reclaim space: it can contain committed database state. [SQLite WAL file lifecycle](https://www.sqlite.org/wal.html#the_wal_file)

## What this test establishes—and leaves open

The release step is the causal control: the same database and writer progressed immediately after the reader ended. The test establishes snapshot retention, incomplete successful PASSIVE checkpoints, and the difference between checkpoint completion and truncation. It does not benchmark throughput, reproduce overlapping reader cohorts, test process crashes, or validate an ORM's cleanup behavior.

The installed test library is also older than SQLite's documented WAL-reset race fix. SQLite identifies fixes in 3.51.3 and the 3.44.6/3.50.7 backports. This sequential exercise does not validate concurrent write/checkpoint race safety; production version selection must account for that separate issue. [SQLite WAL-reset bug](https://www.sqlite.org/wal.html#walresetbug)

A useful integration acceptance test is consequently narrow: hold one observer's transaction open, keep committing events, detect the growing checkpoint gap, cancel the observer, and verify progress resumes. Repeat through the actual database binding and request cancellation path. That demonstrates the lifecycle property an observability service needs, rather than merely showing that a checkpoint command can be called.

## Sources

- [SQLite WAL](https://www.sqlite.org/wal.html)
- [Transaction lifecycle](https://www.sqlite.org/lang_transaction.html)
- [WAL checkpoint PRAGMA](https://www.sqlite.org/pragma.html#pragma_wal_checkpoint)
- [Checkpoint API](https://www.sqlite.org/c3ref/wal_checkpoint_v2.html)
- [WAL file format](https://www.sqlite.org/fileformat2.html#walformat)
- [Isolation](https://www.sqlite.org/isolation.html)
- [Transaction state API](https://www.sqlite.org/c3ref/txn_state.html)
