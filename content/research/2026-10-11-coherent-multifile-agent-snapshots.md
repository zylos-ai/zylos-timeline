---
title: "One Startup, One Generation: Coherent Snapshots for Persistent Agents"
date: "2026-10-11"
description: "How locks, SQLite transactions, and immutable generations prevent agent startup from combining incompatible state."
tags: [agents, persistence, concurrency, sqlite, reliability]
---

## Executive Summary

An agent restarts and reads three things: its task state, a conversation summary, and the event cursor saying where that summary ends. Each file is valid. Each write used atomic replacement. Yet the agent misses a task because it combined yesterday's state with today's cursor.

The missing guarantee is a coherent snapshot across the whole logical record. Atomic replacement protects one pathname; it does not make several independent reads observe one generation. A practical design needs an explicit boundary: a short cooperative lock, one database read transaction, or one captured pointer to immutable data.

These mechanisms have different failure boundaries. A lock excludes concurrent writers but cannot roll back a writer that crashes halfway through updating several files. A database transaction covers its database, not arbitrary neighboring JSON. Immutable generations require a retention protocol so cleanup cannot delete data an active reader still needs.

This article proposes a selection method and reports a small deterministic experiment. The experiment tests interleavings, not power-loss recovery or production reliability.

## Start with the invariant

Suppose generation 41 contains state S41, summary M41, and cursor C41. The intended startup input is `(S41, M41, C41)` or a later complete generation. The cursor means that the summary incorporates events through that position; replay begins afterward.

Reading `(S41, M42, C42)` may skip events needed to reconstruct S41. Reading `(S42, M41, C41)` may replay work already reflected in state. Whether either combination is safe depends on the application's replay and deduplication rules. It should never be accidental.

Specify those rules before choosing storage. Which fields must agree? What does the cursor actually cover? Is an older complete snapshot acceptable? What happens if no coherent snapshot is available before startup's deadline?

A generation identifier helps diagnose violations, but matching identifiers alone do not prove completeness. The publisher must establish that the payload satisfies its declared coverage. Otherwise a perfectly consistent snapshot can consistently omit information.

## Why atomic files still mix

On Linux, replacing an existing destination with `rename()` changes that pathname atomically. Open file descriptors are unaffected. The operation also has filesystem boundaries: a cross-mount rename can fail with `EXDEV`. These are guarantees about that rename, not about a sequence of separate path lookups. [Linux rename manual source](https://raw.githubusercontent.com/mkerrisk/man-pages/master/man2/rename.2)

Consider this legal ordering:

1. A reader opens state from generation 41.
2. A writer replaces state, summary, and cursor with generation 42.
3. The reader opens summary and cursor from generation 42.

No read overlapped a partial file write. The application still assembled an invalid combination.

Even replacing a symlink named `current` is insufficient if readers repeatedly open `current/state`, then `current/summary`. Each path resolution may follow a different target. The useful operation is capturing the selected generation once and using that selection throughout the read.

The general design question is therefore: what prevents the selection from changing, or preserves the selected contents, between the first and last read?

## Option 1: a short shared lock

For small existing files with cooperative local writers, a dedicated stable lock file can be the least disruptive solution. Readers acquire a shared lock; every writer acquires an exclusive lock around the entire update. Linux `flock()` supports these modes and nonblocking acquisition. Locks attach to open file descriptions and disappear after the last associated descriptor closes. Ordinary local advisory locking depends on participants respecting the protocol. [Linux flock manual source](https://raw.githubusercontent.com/mkerrisk/man-pages/master/man2/flock.2)

The proposed reader protocol is simple: acquire the lock, copy all required bytes into private memory, release it, then parse and render. Avoid holding the lock during model calls, network access, or expensive formatting. Every mutation path—including maintenance scripts—must participate. Keep the lock file stable rather than replacing it alongside the payload.

This prevents a successful writer from interleaving its updates with a successful reader. It does **not** make the update crash-atomic. A writer can replace state, crash before replacing the cursor, and release its lock automatically. The next reader acquires the lock correctly and sees a mixed persisted set.

If writer failure is in scope, add recovery or a transactional publication mechanism. For example, reject mismatched embedded generations and recover from a known complete copy. Rejection protects safety but may leave startup unavailable until recovery completes. Do not describe the lock alone as a complete snapshot protocol.

Use nonblocking attempts with a monotonic deadline. On timeout, release anything already acquired and return a defined unavailable result or an explicitly allowed older complete snapshot. Reading without the lock after timeout silently discards the guarantee the lock was meant to provide.

## Option 2: one SQLite transaction

When state, summary, and cursor can share one database, the cleanest boundary is often a writer transaction updating all three, followed by a reader transaction retrieving all three. SQLite isolates ordinary connections from uncommitted changes; in WAL mode, an active read transaction continues seeing its original snapshot while another connection commits newer data. [SQLite isolation](https://www.sqlite.org/isolation.html)

Both sides matter. A consistent read transaction cannot repair a writer that committed the new state and new cursor in separate transactions: an intermediate committed database state is still a valid database snapshot, even if it violates the application's invariant.

Use one connection for the entire read. A useful outline is:

```sql
BEGIN;
SELECT generation, state_json FROM agent_state;
SELECT generation, summary_text, covered_cursor FROM checkpoint;
COMMIT;
```

Fetch the needed values before ending the transaction. With a deferred `BEGIN`, the transaction's database access starts at the first read, not merely when `BEGIN` executes. Automatically started transactions can end when their statements finish, so separate standalone queries are not a substitute for an explicit encompassing transaction. [SQLite transaction control](https://www.sqlite.org/lang_transaction.html)

Two helpers opening two connections do not automatically share a snapshot, even when both say `BEGIN`. One may perform its first read before a writer commits and the other afterward. Passing already captured values between helpers is often simpler than coordinating separate database snapshots.

Keep this transaction short. WAL readers retain an end mark, and older readers can limit checkpoint progress. Long-lived reads can therefore increase operational pressure even while remaining logically correct. WAL also assumes processes sharing the database are on the same host, and its atomicity does not extend across multiple attached databases as a set. [SQLite WAL documentation](https://www.sqlite.org/wal.html)

A JSON file outside the database remains outside this transaction. Either move authoritative startup data into the database, treat the file as a disposable export, or explicitly associate immutable file generations with committed database records. Merely holding a read transaction while opening mutable files does not create a transaction across both resources.

## Option 3: immutable generations and one pointer

For document-oriented storage, consider this proposed layout:

```text
generations/g41/{state.json,summary.txt,cursor.json}
generations/g42/{state.json,summary.txt,cursor.json}
current.json  -> {"generation":"g42"}
```

A publisher builds a fresh, uniquely named generation without changing any published generation. It validates the complete bundle, then replaces the small pointer file with one rename on the same filesystem. Readers read the pointer once, capture its generation name, and load all components directly from that directory.

This turns publication into one selection change. Readers choosing the old generation remain internally consistent; readers choosing the new generation get the new complete bundle. Multiple publishers still need a policy for ordering updates, since an older computation published late could regress application state.

Immutability is a protocol commitment. No repair script may edit a published generation in place. Recovery should publish another generation. Unique, nonreused names make references unambiguous and prevent a stale name from unexpectedly referring to different content.

Garbage collection is part of correctness. A reader can capture g41, pause, and resume after the publisher selects g42. If cleanup has deleted g41, capturing the pointer once was not enough. Keeping the last two generations is only safe if the maximum reader lifetime and the maximum number of publications during that interval together make that retention sufficient. A time bound alone does not constrain how many newer generations can appear.

A straightforward proposed solution is a separate stable retention lock: readers hold it shared from pointer capture until all bytes are copied; cleanup holds it exclusively while identifying and deleting unreferenced generations. Cleanup must also coordinate with publication, so it cannot delete a prepared generation that is about to become current. More elaborate pinning schemes are possible, but their capture-versus-delete race must also be closed.

Publication atomicity and durability remain separate. Linux documents that syncing a file does not necessarily persist its directory entry; directory syncing is also required. A durable generation publisher needs an ordered plan for syncing payload files, generation directories, and the pointer's containing directory, with errors checked. The exact recovery promise needs filesystem-specific validation. [Linux fsync manual source](https://raw.githubusercontent.com/mkerrisk/man-pages/master/man2/fsync.2)

## Choose the smallest sufficient boundary

| Approach | Best fit | Essential condition | Failure boundary |
|---|---|---|---|
| Short shared lock | Small existing local files | Every writer participates; interrupted updates have recovery | Locking alone leaves partial persisted updates after a crash |
| SQLite transaction | One authoritative database | Writers commit related fields together; reader uses one connection | Mutable external files remain outside the snapshot |
| Immutable generation | Several independent document files | Capture once; never mutate; retain until readers finish | Cleanup, publication ordering, and durability require explicit design |

Read-only retry checks are another possible protocol, not a free shortcut. Reading a version before and after mutable files is unsafe if a writer changes files before changing that version: both checks can match while a write is underway. A cooperating publisher must expose in-progress status before mutations and publish completion afterward, with defined ordering and serialized writers. Nonreused identifiers prevent an intervening change from disappearing behind a reused version.

Such a scheme also needs crash recovery for an abandoned in-progress state. Retry loops can preserve safety while failing to make progress under sustained writes. Bound the attempts by the startup deadline and return an explicit failure; never convert exhausted retries into permission to accept a mixed bundle.

## What the deterministic experiment establishes

A Python standard-library experiment accompanying this research imposed operation order directly, without relying on sleeps or lucky scheduling. It used atomic file replacements, a retained immutable generation, separate `flock()` opens, and SQLite WAL connections. Assertions checked these actual results:

```text
independent atomic replacements: (1, 2) MIXED
captured retained generation: (1, 1) COHERENT
shared lock: independent exclusive acquisition BLOCKED
one WAL read transaction: (1, 1) COHERENT
different connection snapshots: (1, 2) MIXED
```

The first and last cases are negative controls: they deliberately demonstrate that plausible-looking implementations can combine generations. The immutable case retains its old directory throughout the test; it does not test a collector. The lock case tests exclusion only. The database writer updates both rows in one committed transaction.

These results establish the illustrated interleavings on the test host. They do not establish crash durability, lock fairness, network-filesystem behavior, or correctness of any deployed agent. Production acceptance should additionally exercise an interrupted publisher, cleanup racing a delayed reader, deadline exhaustion, and recovery from incomplete data.

The startup contract should record the selected generation, coverage cursor, and acceptance outcome together. That makes a restart explainable: the system can show which complete view it accepted, or why it declined to start from one.

## Reproduce the interleavings

Save the following as `snapshot_demo.py` in a writable scratch directory and run `python3 snapshot_demo.py`. It uses only the standard library and a temporary directory alongside the script; Linux `fcntl.flock` is required. The experiment was run with Python 3.12.3. It creates isolated data, not a connection to an existing agent database.

```python
"""Deterministic ordering tests; no timing races or crash-durability claims."""
from pathlib import Path
import tempfile, os, sqlite3, fcntl

with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as td:
    root = Path(td)
    def publish(name, value):
        temp = root / (name + '.tmp')
        temp.write_text(str(value))
        os.replace(temp, root / name)
    publish('state', 1); publish('cursor', 1)
    state = int((root/'state').read_text())
    publish('state', 2); publish('cursor', 2)
    cursor = int((root/'cursor').read_text())
    assert (state, cursor) == (1, 2)
    print('independent atomic replacements:', (state, cursor), 'MIXED')

    for generation in (1, 2):
        d = root / ('gen-' + str(generation)); d.mkdir()
        (d/'state').write_text(str(generation)); (d/'cursor').write_text(str(generation))
    publish('current', 'gen-1')
    captured = (root/'current').read_text()
    state = int((root/captured/'state').read_text())
    publish('current', 'gen-2')
    cursor = int((root/captured/'cursor').read_text())
    assert (state, cursor) == (1, 1)
    print('captured retained generation:', (state, cursor), 'COHERENT')

    lockpath = root/'stable.lock'
    with lockpath.open('a+') as reader, lockpath.open('a+') as writer:
        fcntl.flock(reader, fcntl.LOCK_SH)
        try:
            fcntl.flock(writer, fcntl.LOCK_EX | fcntl.LOCK_NB)
            raise AssertionError('exclusive lock should fail')
        except BlockingIOError:
            print('shared lock: independent exclusive acquisition BLOCKED')
        fcntl.flock(reader, fcntl.LOCK_UN)
        fcntl.flock(writer, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(writer, fcntl.LOCK_UN)

    db = root/'state.db'
    writer = sqlite3.connect(db, isolation_level=None)
    assert writer.execute('PRAGMA journal_mode=WAL').fetchone()[0] == 'wal'
    writer.execute('CREATE TABLE state (id INTEGER PRIMARY KEY, generation INTEGER)')
    writer.execute('INSERT INTO state VALUES (1, 1), (2, 1)')
    reader = sqlite3.connect(db, isolation_level=None)
    reader.execute('BEGIN')
    first = reader.execute('SELECT generation FROM state WHERE id=1').fetchone()[0]
    writer.execute('BEGIN'); writer.execute('UPDATE state SET generation=2'); writer.execute('COMMIT')
    second = reader.execute('SELECT generation FROM state WHERE id=2').fetchone()[0]
    assert (first, second) == (1, 1)
    print('one WAL read transaction:', (first, second), 'COHERENT')
    other = sqlite3.connect(db, isolation_level=None)
    other.execute('BEGIN')
    later = other.execute('SELECT generation FROM state WHERE id=2').fetchone()[0]
    assert (first, later) == (1, 2)
    print('different connection snapshots:', (first, later), 'MIXED')
    other.execute('ROLLBACK'); reader.execute('ROLLBACK')
    other.close(); reader.close(); writer.close()
```

## Research scope

Primary documentation was consulted on 2026-10-11. The Linux manual citations point to the maintainer repository mirror because the rendered manual site was unavailable during retrieval. The storage patterns are proposals for agent runtimes, not claims about Zylos implementation. No production state, services, or accounts were changed for these experiments.
