---
date: "2026-11-09"
title: "Two Copies of a Native SQLite Driver in One Node.js Process"
description: "How a Node.js app quietly ends up with two copies of better-sqlite3 (or SQLite via node:sqlite) in one process, why POSIX advisory locks make that dangerous even when no query fails, how to detect it, and how to enforce one driver per process."
tags: ["sqlite", "better-sqlite3", "nodejs", "native-modules", "posix-locks", "wal", "ai-agents", "reliability"]
---

## Executive Summary

The standard better-sqlite3 build statically embeds SQLite inside a `.node` file. Loading two independently built copies, or using it alongside Node's built-in `node:sqlite`, can put independent SQLite libraries in one process, each with private bookkeeping. Distinct JavaScript module instances alone do not establish that another native library was loaded.

That matters because SQLite on Unix uses POSIX advisory locks (`fcntl`), and POSIX locks belong to the *process*, not to the file descriptor. Closing any descriptor on a file silently drops every lock the process holds on it. SQLite hides this quirk inside one library copy by tracking open inodes and deferring `close()`. Two copies do not share that tracking, so a `close()` in copy B can erase the locks copy A believes it holds. SQLite's own documentation lists this as a database-corruption scenario. In the author-reported WAL case below, another process treated itself as the last connection, checkpointed, and deleted the `-wal` and `-shm` files; the long-lived reader stopped seeing new commits. This is a possible failure, not a measured frequency comparison or a guaranteed result of the next close.

This article covers how duplicates arise, how to detect them in a running process, what can break (including an excerpt from an author-reported run), real-world reports from 2018 to 2026, and mitigations that enforce one driver per process. It deliberately does not repeat general WAL tuning (see the earlier WAL article) or ABI mismatch (see the earlier native-module ABI article): here every copy loads and works fine, which is exactly why the problem survives testing.

## How a Process Ends Up With Two Copies

Node resolves `require('better-sqlite3')` by walking up `node_modules` directories from the *requiring file*, not from the application entry point. Separate package directories can resolve to distinct `better_sqlite3.node` files, which Node loads with `dlopen`; symlinks or shared native files need not load separate libraries. Typical routes to a second copy:

- **Nested `node_modules` that npm could not dedupe.** Package X depends on `better-sqlite3@^12.6` and your app on `^12.9`; if the ranges are compatible npm hoists one copy, but a pinned or conflicting range, a lockfile that predates the other dependency, or `--install-strategy=nested` leaves two. A dependency such as an ORM driver adapter that carries its own `better-sqlite3` dependency is the classic case.
- **A global package plus a local one.** A CLI installed with `npm i -g` has its own `node_modules`. If the app resolves a library from that global root while the host process also has a local install, the process holds both. Version equality alone does not help when the paths refer to independently built native files.
- **Plugins and skills with their own roots.** An agent that lets each skill or plugin ship its own `package.json` and `node_modules` multiplies the risk. Each skill resolves its dependency from its own directory, and may resolve to independent native builds.
- **Lazy loading.** The second copy may only appear after a particular code path runs (a chat send, a settings page, an upgrade check). A process that starts with one copy can acquire another hours later.
- **pnpm and Yarn layouts.** pnpm stores each version under `.pnpm/<name>@<version>/...` and symlinks; two versions coexist by design. Hoisting rules (`public-hoist-pattern`, `node-linker`) decide whether a transitive dependency shares your copy.
- **Mixing drivers.** `better-sqlite3`, `sqlite3` (node-sqlite3), and `node:sqlite` (Node 22.5+ built-in) can introduce independent native SQLite libraries. Prisma/Drizzle/Kysely adapters use a selected driver; an adapter is not itself proof of another engine. WASM builds have different VFS/storage arrangements and are outside this native Unix lock analysis.
- **Duplicate module instances for another reason.** Worker threads, bundler chunks, or cache-busted `import()` can evaluate a module twice. Node documents that addons must use Node-API or be context-aware to load in several environments, but a second JavaScript environment or module evaluation does not by itself prove that a second native SQLite library was loaded.

The repository layout often hides all of this. A dev checkout with one top-level `node_modules` dedupes cleanly; the *installed* layout (global package, per-skill dependencies, different install timestamps) does not.

## Detecting It

None of these need privileges.

**On a live Linux process** read the memory map. Every loaded binding is a mapped file:

```bash
grep -o '/[^ ]*better_sqlite3\.node' /proc/<pid>/maps | sort -u
# multiple paths are a signal to investigate these addon builds
```

On macOS use `vmmap <pid> | grep better_sqlite3`; on Windows, Process Explorer or `Get-Process -Id <pid> | % Modules`. Also look at open files: `ls -l /proc/<pid>/fd | grep '\.db'` and `lsof -p <pid>` show how many descriptors the process has on the database. For a connection that has acquired shared memory, `/proc/locks` can show locks on the `-shm` inode; missing locks are a clue, not proof of loss, since connection state and VFS configuration also matter.

**From inside the process:**

```js
// startup self-check (Linux)
const fs = require('fs');
function sqliteAddonPaths() {
  const maps = fs.readFileSync('/proc/self/maps', 'utf8');
  return [...new Set(maps.split('\n')
    .map(l => l.split(/\s+/)[5])
    .filter(p => p && /(better_sqlite3|node_sqlite3)\.node$/.test(p)))];
}
// call after the app's own modules have loaded, and again after lazy paths run
```

These probes count distinct mapped path strings matching the named addon builds, not all SQLite libraries. They miss `node:sqlite` and other filenames, may count aliases separately, and the simple parser mishandles paths containing spaces. Inspect the build and file identity before treating paths as independent engines.

Other signals: log `require.resolve('better-sqlite3')` from each module that opens a database, or wrap `Module._load`/`process.dlopen` once to record the filename of every `.node` file loaded (a debugging aid, not production code). Offline, `npm ls better-sqlite3 --all`, `find <roots> -name better_sqlite3.node`, and `pnpm why better-sqlite3` list candidates, while the memory map shows matching files actually mapped at the time of inspection, including lazy loads already exercised.

Same-version duplicates are easy to miss in lockfile audits: two independently built native copies of 12.6.2 can still be two SQLite libraries, even with identical package versions. (Glibc's `dlopen` returns the same handle for the same underlying file, so a symlink to a single file is not a second copy; I did not test this for every platform.)

## Why It Is Dangerous: POSIX Locks Belong to the Process

SQLite's corruption guidance describes the mechanism in section 2.2: the default Unix locking uses POSIX advisory locks, and closing a descriptor on a file cancels those locks on that file for every thread and descriptor in the process. A thread that opens the database file, reads 16 bytes and closes it can drop other SQLite connections' locks on that database inode, without notifying those connections.

SQLite defends against this itself, but only inside one library copy. In `os_unix.c`, each `unixInodeInfo` counts the locks held on an inode, and when a `unixFile` is closed while other files on the same inode hold locks, the `close()` of the descriptor is deferred and queued until the last lock clears. That is the "pending close" list. The state lives in a mutex-protected global list inside the library.

Section 2.3 of the same page states the consequence: with multiple library copies, "there will be multiple instances of this global list." Each copy is unaware of the other's connections, so its workaround cannot protect those connections against lock loss on close. The page describes resulting corruption as possible and cites a commercial product whose bug was traced to linking two copies of SQLite.

The release is per underlying file (inode), not per connection or pathname. An actual close of B's descriptor on the database inode can clear A's locks on that database inode; it does not clear locks on the separate `-shm` inode. For B's close to clear A's shared-memory locks, B must also have acquired a shared-memory reference and actually close a descriptor on that same `-shm` inode. In upstream `os_unix.c`, `unixShmUnmap` returns immediately when `pDbFd->pShm` is null; otherwise it decrements that copy's `unixShmNode.nRef`, and `unixShmPurge` closes the shm descriptor when those references reach zero. A read-only constructor followed by `close()` is therefore not, by itself, proof that shm locks were released.

### What it looks like in WAL mode

WAL's lifecycle rules make the failure concrete. The WAL documentation says the last connection to close "does one last checkpoint and then deletes the WAL and its associated shared-memory file". "Last" is decided by trying to take an exclusive lock on the database file. If B actually closes a descriptor on the database inode and erases A's database locks, a subsequent external connection may acquire the exclusive database lock, treat itself as last, checkpoint and unlink `-wal` and `-shm` (subject to cleanup configuration and other connections). This does not require assuming that B also closed a shm descriptor. In the stale-mapping failure described here, copy A:

- still holds an open descriptor and an `mmap` of the *deleted* `-shm`; it never learns the files are gone;
- the next external writer creates a new `-wal`/`-shm` pair that copy A is not mapped to;
- copy A's cached wal-index says "nothing changed," so `SELECT` keeps returning the old snapshot indefinitely. There is no error and no `SQLITE_BUSY`. Where the mapping is truncated or reset under the reader, the symptom can instead be a bus error (SIGBUS).

Without a WAL-read lock, copy A can also read pages while a checkpoint overwrites them (torn reads), and a writer in copy A could in theory write while another process also believes it holds the write lock. SQLite 3.51.0 (2025-11-04) added "Improved resistance to database corruption caused by an application breaking Posix advisory locks using close()" (release item 17) and the howtocorrupt page notes the defenses help for WAL databases accessed from multiple processes but "are not a cure-all". The release notes do not say how it works, so do not treat newer SQLite as a license to run two copies; the bundled SQLite version in each binding copy decides what defenses exist, and the two copies may differ.

### Excerpt from an author-reported run

The author reported a Linux/Node 24 run with separate better-sqlite3 installs, 12.6.2 and 12.9.0, on a WAL database. The excerpt labels the installs A and B but does not record which version was assigned to each, their bundled SQLite versions, or the exact Node patch version. The reader holds a connection through A; B opens and closes the same database; external writer processes use A. This is an excerpt, not a complete runnable fixture: `writer.js` and the initial database contents/reset procedure are absent. It also does not show a query through B or otherwise establish that B acquired shared memory.

```js
// reader.js  (copy a/ and b/ are separate installs of better-sqlite3)
const A = require('./a/node_modules/better-sqlite3');
const B = require('./b/node_modules/better-sqlite3');
const { execFileSync } = require('child_process');
const db = new A('t.db'); db.pragma('journal_mode=WAL');
db.exec('create table if not exists t(x)');
const count = () => db.prepare('select count(*) c from t').get().c;
if (process.argv[2] === 'dup') { new B('t.db', { readonly: true }).close(); }
for (let i = 1; i <= 3; i++) {
  execFileSync('node', ['writer.js']);   // inserts one row using copy A, then closes
  console.log(i, 'reader sees', count());
}
```

The author reported counts of 1, 2, 3 with one copy and 1, 1, 1 with the duplicate open/close, plus disappearance of the WAL and shm files while the reader was alive, in a run dated 2026-11-09. The excerpt alone cannot independently reproduce or verify those observations, attribute the unlink to a particular close, or prove shm-lock loss. No database experiment was rerun for this revision; those results remain author-reported, not guaranteed output.

## Real-World Reports

Links are to primary issue trackers; dates are issue creation dates as returned by the GitHub API.

- **Two SQLite copies in one TensorBoard process** (tensorboard #1467, 2018-09-27): Python's `sqlite3` plus a copy compiled into TensorFlow. Reported spurious "database file deleted" errors in rollback mode, and a macOS "Bus Error: 10" in WAL mode. The issue cites the howtocorrupt section directly.
- **Signal Desktop on Arch Linux** (Signal-Desktop #4513, opened 2020-09-12; the relevant comment is from 2021-03-13): after a GTK update enabled a search indexer that loaded system SQLite, the app, which already used SQLCipher, reported the encrypted database as corrupt (`SQLITE_NOTADB`). Downgrading gtk3 made it go away. The maintainers' analysis attributes it to two SQLite-derived libraries in one process. This one involves symbol clashes as well as lock bookkeeping, so it is not a pure instance of the locking mechanism.
- **SQLCipher #385** (2021-03-18): asks for symbol versioning because loading both libsqlite3 and SQLCipher into one process lets symbols resolve unpredictably.
- **iris-eval/mcp-server #739** (2026-09-29): `better-sqlite3` and Node's built-in `node:sqlite` on one WAL file in one process; a minimal fixture died with SIGBUS in 3 of 5 runs with two copies and 0 of 10 with one. Resolution: refuse the second copy on a file that one copy already holds.
- **OpenWaggle #371** (2026-10-26): a host process opened its live database with `node:sqlite` while it was already open with better-sqlite3; classified as a release blocker, fixed by reusing the existing connection and adding a regression guard.
- **open-project-manager #238** (2026-10-29): the top-level `better-sqlite3` 13.x set WAL mode while a Prisma adapter loaded a nested 12.11.1. Reproduction: after a second process inserted a row, the server's count did not change until restart. Fix: set WAL through the adapter's connection and remove the direct open.

I could not find a better-sqlite3 or node-sqlite3 maintainer-authored issue specifically titled around duplicate copies; searches of both trackers for "multiple copies" and "WAL stale" returned nothing relevant (checked 2026-11-09). The reports above are from downstream applications, and I did not independently reproduce them beyond my own test. Also, I have only the issue text for the Signal case and did not verify the root-cause claim with the gtk or tracker maintainers.

## Case Study: A Dashboard That Froze After Another Process Removed the WAL

In the author's account, an agent dashboard read a message queue database (WAL mode) through a long-lived connection to render live status once per second. In the repository layout, one `node_modules` provided one better-sqlite3 (12.9.0). A test in that layout passed.

The installed layout differed. The dashboard imported helper code from an installed core package, which carried its own nested better-sqlite3 (12.6.2). When one of the helper's code paths ran (an idle-state lookup on a one-second timer, a status snapshot every few seconds, and the first chat send), it opened and closed the same database through the second copy. After a chat send, a third copy (a sibling component's install, same 12.6.2) was also mapped; `/proc/<pid>/maps` showed three distinct `.node` files.

The reported observations were stale dashboard reads and removal of WAL/shm files while its reader remained alive. A possible mechanism is that copy 2 closed a descriptor on the database inode, clearing copy 1's database lock and allowing an external connection to perform last-connection cleanup. Loss of copy 1's shm locks would additionally require copy 2 to have acquired shared memory and closed a descriptor on that shm inode; the excerpt does not establish that step. Torn reads are a possible consequence of lost WAL read locks, not an observation established by this case.

The author also reported controls: with the second copy replaced by a link to the first (single copy), 16 probes and 35 open/close cycles stayed fresh; with two copies the freeze reproduced repeatedly in an isolated install built the way a user would install it. The report also describes separate native copies of the same version (12.6.2).

These author-reported controls have not been independently rerun here. They support a layout-dependent failure in that case, not a claim that every duplicate-driver close follows the same sequence.

Lessons from the report: the bug depended on layout, not on the application logic; the reader never raised an error; and the trigger was a *short-lived helper opening and closing* rather than a long-lived second connection.

## Mitigations

**1. One driver per process (primary).**
- Have the host own the driver dependency used by plugins, skills and helper libraries, and verify resolution in each environment. A `peerDependency` can express that ownership but does not by itself enforce it. Where a plugin must carry dependencies, have the host pass its `Database` constructor or an open connection into it (dependency injection) instead of letting the plugin `require` its own.
- Centralise cooperating modules' driver loading in one module and cache it on `globalThis`, so the first loader wins within that JavaScript realm, regardless of the caller's directory:

```js
const KEY = Symbol.for('app.sqlite-driver');
module.exports = function loadDriver(resolveFrom) {
  if (!globalThis[KEY]) globalThis[KEY] = require(require.resolve('better-sqlite3', { paths: [resolveFrom] }));
  return globalThis[KEY];
};
```

  Copies of this wrapper sharing the same `globalThis` agree on the cache. Worker environments have separate globals; a Node 24.22.1 probe found that a worker could not see the main thread's cached value under the same `Symbol.for` name. Direct imports can also bypass this wrapper. Enforce dependency ownership through the host across all environments, or put independently owned drivers in separate processes; this cache alone cannot enforce a process-wide invariant. A connection registry in the same realm can reduce open/close churn, but has the same boundary.
- Dedupe at install time (`npm dedupe`, `overrides`, pnpm `overrides`, or `resolutions`). Treat this as a convenience, not a guarantee: aligning version numbers does not merge two files, and rebuilds or upgrades re-split them.

**2. Avoid mixed drivers on the same file.** Do not open a database with `node:sqlite` and better-sqlite3 in the same process; the iris-eval and OpenWaggle fixes both reduced to "one copy per file." If a second runtime must touch the file, put it in a separate process.

**3. Prefer long-lived connections to open/close per call.** A helper that opens and closes on every poll is the best lock-eraser. Keep one connection per database per process.

**4. Detect at startup and at lazy-load points.** Run the memory-map check above after boot and again from a periodic health probe or from the code path that lazily loads components; flag multiple matching addon paths for investigation. This is a heuristic, not proof that the one-driver invariant holds. Pair with a staleness canary: a reader that notices its `-wal`/`-shm` inode no longer matches the path (`fs.statSync` on the file versus the open descriptor) can at least warn, although reopening only hides the freeze and does not restore lost locks.

**5. VFS and lock-type options, with tradeoffs.**
- `unix-excl` (a selectable VFS) holds an exclusive lock and keeps the wal-index in heap rather than shared memory, so other *processes* are shut out. It removes the shared-memory aspect of this failure but needs every process (including your CLI and backup tools) to cooperate, and a second copy in the same process still bypasses it for file locks. Similarly `PRAGMA locking_mode=EXCLUSIVE` before first WAL access avoids the wal-index but locks out all other connections (WAL docs, section 8).
- Open-file-description (OFD, `F_OFD_SETLK`) locks would not be released by closing a different descriptor, which makes them the proper fix at the kernel level. Upstream SQLite does not use them: I grepped current `os_unix.c` on 2026-11-09 and found no `F_OFD` references, and the howtocorrupt, VFS and 3.51.0 release pages do not mention them. A Go port, modernc.org/sqlite, exposes an opt-in OFD locking setting (its Go documentation says so; I did not test it). Custom builds of better-sqlite3 with a patched VFS are possible but you take on maintenance and WAL's `-shm` locks may stay on POSIX locks, so check carefully.
- Never mix locking protocols between processes (howtocorrupt section 2.4); the VFS documentation allows mixing only `unix` and `unix-excl`.

**6. Test in the installed layout.** The duplicate is invisible in a deduped dev checkout. Add a CI job that installs the app the way users do (global package, per-component installs, fresh `npm ci` in an empty prefix), starts the process, exercises lazy paths, and checks the expected `better_sqlite3.node` mappings in `/proc/<pid>/maps` as a filename-specific guard, alongside auditing host/worker dependency ownership and mixed-driver use. Then run an external writer probe against a long-lived reader and assert the reader sees new commits. Run the same test after an upgrade, since upgrades are when nested copies drift.

## Takeaways

- Independently embedded SQLite libraries have separate lock bookkeeping; module instances and path counts alone do not establish their number.
- POSIX locks plus `close()` make that a correctness issue. A frozen WAL reader is one reported symptom; the sources do not establish how common it is.
- Enforce driver ownership through the host or process isolation. Use realm-local caches and memory-map heuristics within their limits, and test the real installed layout.

## References

1. SQLite, "How To Corrupt An SQLite Database File", sections 2.2 (POSIX advisory locks canceled by close()), 2.3 (multiple copies of SQLite linked into the same application), 2.4 (different locking protocols): https://www.sqlite.org/howtocorrupt.html
2. SQLite, "Write-Ahead Logging": https://www.sqlite.org/wal.html
3. SQLite, "VFS" (unix, unix-excl, other unix VFSes): https://www.sqlite.org/vfs.html
4. SQLite 3.51.0 release notes (2025-11-04): https://www.sqlite.org/releaselog/3_51_0.html
5. SQLite source, `os_unix.c`, `unixInodeInfo` and deferred close comment: https://github.com/sqlite/sqlite/blob/master/src/os_unix.c
6. SQLite forum, saved file descriptors with POSIX locks (2024-03-21): https://sqlite.org/forum/forumpost/4b2e1fd222
7. Node.js, "C++ addons" (context-aware addons, loading in multiple environments): https://nodejs.org/api/addons.html
8. TensorBoard #1467, double-linked SQLite libs (2018-09-27): https://github.com/tensorflow/tensorboard/issues/1467
9. Signal-Desktop #4513 (2020-09-12; comment 2021-03-13): https://github.com/signalapp/Signal-Desktop/issues/4513#issuecomment-798791447
10. SQLCipher #385 (2021-03-18): https://github.com/sqlcipher/sqlcipher/issues/385
11. iris-eval/mcp-server #739, SIGBUS with two SQLite copies (2026-09-29): https://github.com/iris-eval/mcp-server/issues/739
12. OpenWaggle #371 (2026-10-26): https://github.com/OpenWaggle/OpenWaggle/issues/371
13. open-project-manager #238 (2026-10-29): https://github.com/jciccio/open-project-manager/issues/238
14. modernc.org/sqlite, OFD locking option: https://pkg.go.dev/modernc.org/sqlite
15. Linux `fcntl(2)`, open file description locks: https://man7.org/linux/man-pages/man2/fcntl.2.html
16. Node.js, "Worker threads" (independent JavaScript execution threads): https://nodejs.org/api/worker_threads.html#class-worker
17. better-sqlite3 build, bundled SQLite static library: https://github.com/WiseLibs/better-sqlite3/blob/master/deps/sqlite3.gyp
