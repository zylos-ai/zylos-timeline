---
date: "2026-11-15"
time: "09:00"
title: "Finished, but Still Scanned: Keeping Terminal Records Out of the Hot Loop"
description: "Why polling and reconcile loops should do work proportional to active tasks rather than total history, how Kubernetes, job queues and workflow engines handle finished objects, and how to keep records for audit and dedup without keeping them hot."
tags: ["research", "agent-infrastructure", "nodejs", "reconcile-loops", "state-management", "performance"]
---

## Executive Summary

**A polling loop whose cost grows with total history is a latent bug.** It is invisible for months, because the average CPU cost stays tiny, and then it shows up as late timers and missed deadlines. The fix is not to delete old records. The fix is to stop touching them.

The scenario this article starts from is common in agent infrastructure. A long-running Node.js bridge daemon polls a task platform every ~15 seconds. It keeps a local JSON state file with every dispatch or task it has ever seen. On every pass it re-examines all records, including ones that finished long ago, and rewrites the whole file. As history grows, each pass blocks the event loop for longer. Eventually something time-sensitive, such as delivering a cancellation notice to a running agent, waits behind a multi-second synchronous pass and misses its window.

The main findings:

- **Serialization and file rewriting dominate, not the per-record checks.** In a local micro-benchmark (details below), skipping terminal records inside the loop changed nothing measurable, because the whole-file `JSON.stringify` and write still ran. Making the pass O(active) requires both skipping terminal records and not rewriting unchanged state.
- **Mature systems separate the active set from history.** Kubernetes controllers are level-triggered and work from caches and queues, Jobs and Pods have explicit finished-object cleanup, job queues expose retention knobs, and workflow engines keep closed executions on a bounded retention period.
- **Do not simply delete finished records.** They are your dedup and idempotency memory. If the remote platform can still list or redeliver an old task, a locally forgotten record turns into a replayed side effect, such as a second cancellation notice. Keep terminal records, but cold, indexed, and with an explicit retention window.
- **Guard it with tests, not discipline.** Assert that per-tick work (counted in visits and writes, not milliseconds) is independent of history size, that a no-op tick writes nothing, and that terminal records never trigger side effects after a restart. Add an event-loop-lag alarm in production.

Everything in the benchmark sections was measured on one machine for this article. Claims that are my interpretation rather than documented behavior are marked "(inference)".

## 1. Why O(history) per tick is a latent bug

**Per-tick cost that scales with total history is a time bomb because the tick interval does not scale with it.** A 15-second interval is fixed. Work per tick grows without bound, as long as tasks keep arriving.

There are three reasons it stays hidden.

1. **The average looks harmless.** If a pass takes 200 ms out of every 15 s, CPU use is about 1.4%. No dashboard turns red. But the pass is one contiguous synchronous block. For those 200 ms, nothing else in the process runs: not other timers, not socket callbacks, not the cancellation handler that just became due.
2. **The growth is gradual.** Linear growth with a small slope looks like noise for a long time. It is only a problem once the product of history size and per-record cost crosses a latency budget.
3. **The symptom is far from the cause.** The visible failure is "a cancellation was delivered late" or "a heartbeat timer drifted", not "the state file got big".

### How blocking shows up in Node.js

Node runs your JavaScript on one thread. The official guide on [not blocking the event loop](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop) singles out JSON operations (along with regular expressions) as an exception to V8's general speed, and recommends bounding input size so that worst-case time is known. `JSON.stringify` of a large object and `fs.writeFileSync` are both synchronous and both scale with the size of the state.

The observable symptom is **late timers**. A `setTimeout(fn, 50)` registered just before a 200 ms synchronous pass does not fire at 50 ms. It fires after the pass ends, because timers run from the event loop, and the loop is busy. In my test below, a 50 ms timer fired about 155 ms late behind a pass over 100,000 records, roughly the pass duration minus the 50 ms already scheduled.

### Measuring it

Node ships a built-in measurement: [`perf_hooks.monitorEventLoopDelay()`](https://nodejs.org/api/perf_hooks.html) returns a histogram of event loop delay, sampled with a timer at a configurable resolution. The docs note that the measurement itself depends on the event loop turning, and that every interval-based sample includes the resolution, so the baseline is roughly the resolution you picked rather than zero.

```js
import { monitorEventLoopDelay } from 'node:perf_hooks';

const lag = monitorEventLoopDelay({ resolution: 20 }); // ms
lag.enable();

setInterval(() => {
  // histogram values are nanoseconds
  const p99 = lag.percentile(99) / 1e6;
  const max = lag.max / 1e6;
  if (max > 250) {               // alarm on the worst stall, not just the mean
    log.warn({ p99, max }, 'event loop stalled');
  }
  lag.reset();
}, 10_000).unref();
```

Alarm on **max** (or p99.9) over each window. A mean or even p95 will hide one 800 ms stall every 15 seconds.

### A local benchmark

I wrote a small synthetic benchmark to see which part of a typical "scan everything and rewrite the file" tick actually costs time. It builds a state object of N task records (about 390 bytes of JSON each, 20 of them active, the rest terminal), then times several tick designs. Environment: Node v24.22.1, a 20-core Linux box with an NVMe SSD on ext4, writes go through the page cache (no `fsync` in the first table). Numbers are medians of 5 to 9 runs. They will differ on your hardware, and a small VPS with a slow disk will be worse (inference). The shape matters more than the values.

| Records | State file | Naive tick (scan all + rewrite) | Skip terminal, still rewrite | Active-only, no change | Active-only, one change (whole-file rewrite) |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 0.4 MB | 1.2 ms | 1.3 ms | ~0.001 ms | 1.1 ms |
| 10,000 | 3.8 MB | 14 ms | 14 ms | ~0.0004 ms | 12 ms |
| 50,000 | 19 MB | 94 ms | 94 ms | ~0.0004 ms | 81 ms |
| 100,000 | 39 MB | 208 ms | 209 ms | ~0.0006 ms | 174 ms |
| 200,000 | 78 MB | 463 ms | 464 ms | ~0.0006 ms | 371 ms |

Three observations:

1. **Cost is linear, about 2 microseconds per record on this machine.** If a platform produced 2,000 tasks a day (an assumed rate for illustration), this machine would pass 100,000 records after about 50 days and 470,000 after about 235 days, where a single pass would exceed one second. A slower environment gets there sooner.
2. **"Skip terminal records early" alone did nothing.** The second column is identical to the first. The per-record status check is nearly free. The cost is serializing and writing everything.
3. **Dirty tracking on a single big file still hurts when something changes.** The last column shows that if one record changes and you rewrite the whole 39 MB file, you still pay about 174 ms. That is why the storage layout matters, covered in section 3.

A breakdown at 100,000 records: `JSON.stringify` took about 141 ms, `writeFileSync` of the resulting string about 36 ms, and the rename was negligible. A compare-before-write (stringify, then `===` against the last written text) cost about 130 ms, so it avoids the write but not the serialization. Parsing the file at startup (`JSON.parse`) took about 106 ms, which matters for restart time. Adding `fsync` to a 38.6 MB write added only about 6 ms on this NVMe drive (35 ms vs 41 ms); on spinning or networked disks the difference can be orders of magnitude larger (inference).

## 2. How established systems treat terminal objects

**Every mature system I looked at separates "things still in motion" from "things that finished", and offers mechanisms to keep the second group out of hot work and to bound its retention.** These are mechanisms, not guarantees: retention is bounded only when someone configures it, and some of them still re-process objects they already hold.

### Kubernetes

- **Controllers are level-triggered and work from a cache plus a queue.** One of the guidelines in the upstream [controller-writing guide](https://github.com/kubernetes/community/blob/master/contributors/devel/sig-api-machinery/controllers.md) reads "Level driven, not edge driven": your controller may be off for an indeterminate time, and on return it can only rely on the state it now observes, not on having seen each transition. That makes reconcile idempotent by design. The same guide notes that informers can periodically "resync", calling the update handler for every cached object, and suggests comparing versions to skip no-op work when you know there is nothing to do. In other words, the cache-plus-queue design does not by itself make work proportional to change: a resync re-processes every cached object, and skipping the no-op ones is the controller author's job. See also the [controller concept page](https://kubernetes.io/docs/concepts/architecture/controller/) and the [API concepts](https://kubernetes.io/docs/reference/using-api/api-concepts/) on list and watch.
- **Finished Jobs have an explicit cleanup mechanism.** The Job docs say [finished Jobs are usually no longer needed and keeping them around puts pressure on the API server](https://kubernetes.io/docs/concepts/workloads/controllers/job/). The [TTL-after-finished controller](https://kubernetes.io/docs/concepts/workloads/controllers/ttlafterfinished/) makes a Job eligible for deletion `.spec.ttlSecondsAfterFinished` seconds after it becomes Complete or Failed, but only if that field is set. It is configured per Job, or by a cluster policy such as a mutating admission webhook that sets the field; per the Job docs, "If the field is unset, this Job won't be cleaned up by the TTL controller after it finishes."
- **Finished Pods are garbage collected by count.** Per the [Pod lifecycle docs](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/), PodGC cleans up terminated Pods (phase Succeeded or Failed) when their number exceeds `terminated-pod-gc-threshold` in the kube-controller-manager, "to avoid a resource leak". See also the general [garbage collection concepts](https://kubernetes.io/docs/concepts/architecture/garbage-collection/).
- **Deletion in caches is represented explicitly.** client-go's [`DeletedFinalStateUnknown`](https://pkg.go.dev/k8s.io/client-go/tools/cache#DeletedFinalStateUnknown) is a marker type that tells a handler "this object was deleted, but its final state was missed". It is a built-in acknowledgment that deletions and gaps are normal and need a defined representation.

The lesson is not "copy Kubernetes". The lesson is that the TTL is a first-class field you have to set, deletion is a separate controller's job rather than the main reconcile path's, and even a cache-driven design needs explicit work to avoid re-processing what did not change.

### Job queues

- **BullMQ** offers `removeOnComplete` and `removeOnFail`, as `true`, a count, or an age. The [docs](https://docs.bullmq.io/guide/queues/auto-removal-of-jobs) suggest keeping "a handful" of completed jobs and a much larger number of failed jobs, a deliberate asymmetry: failures are the ones you will want to inspect. Removal is lazy, so these options bound retention only while jobs keep finishing: the docs say "jobs are not removed unless a new job completes or fails, since that is when the auto-removal takes place."
- **Sidekiq** moves jobs that exhausted retries to a Dead set, and per its [error-handling wiki](https://github.com/sidekiq/sidekiq/wiki/Error-Handling) that set is limited by default to 10,000 jobs or 6 months so it does not grow indefinitely.
- **Celery** stores results with a `result_expires` setting. The [configuration docs](https://docs.celeryq.dev/en/stable/userguide/configuration.html) say the default is one day, that the stored "task tombstones" are deleted by a built-in periodic cleanup task, and that this requires the beat scheduler to be running. A subtle operational point: expiry is itself a job that someone has to run.

### Workflow engines

Temporal keeps closed workflow executions for a per-Namespace [retention period](https://docs.temporal.io/temporal-service/temporal-server), the duration for which the service stores data about closed executions in its persistence store. The [namespaces docs](https://docs.temporal.io/namespaces) list retention as a per-namespace configuration boundary. Running executions are handled by the core machinery. Closed ones are history with an expiry date.

### The common pattern

| Concept | Kubernetes | Queues / workflow engines |
|---|---|---|
| Active set drives work | informer cache plus workqueue | pending/active lists, task queues |
| Terminal objects | Succeeded/Failed Pods, Complete/Failed Jobs | completed/failed/dead sets, closed executions |
| Retention controls (when configured) | TTL field, count threshold | `removeOnComplete`, dead-set limits, `result_expires`, retention period |
| Who cleans up | separate controller | background task or storage-level expiry |

Applying this to a bridge daemon: keep an **active index** (the only thing the poll/reconcile loop iterates), a **terminal index** keyed by id (for dedup), and a **bounded archive** (for audit).

## 3. Write-on-change: do not rewrite what did not change

**Write only when something changed, and prefer writing only the part that changed.** The benchmark showed why both halves matter.

### Dirty tracking beats content comparison

Compare-before-write is a good safety net but a poor primary mechanism, because you have to serialize everything to compare it. My measurement at 100,000 records: about 130 ms to stringify and compare, versus about 141 ms to stringify and write. The saving is only the ~36 ms file write.

Track changes at the point of mutation instead. Make the transition function return whether anything changed, and make terminal states absorbing:

```js
const TERMINAL = new Set(['completed', 'cancelled', 'failed']);

class Store {
  records = new Map();  // id -> record: all history, in memory
  active  = new Set();  // ids that are not terminal: what loops iterate
  dirty   = new Set();  // ids changed since last flush

  apply(id, patch) {
    const prev = this.records.get(id);
    if (prev && TERMINAL.has(prev.status)) return false;       // terminal is absorbing
    if (prev && Object.keys(patch).every(k => prev[k] === patch[k])) return false; // no-op
    const rec = { ...prev, ...patch, id, updatedAt: Date.now() };
    this.records.set(id, rec);
    if (TERMINAL.has(rec.status)) this.active.delete(id); else this.active.add(id);
    this.dirty.add(id);
    return true;
  }
}
```

"Terminal is absorbing" is a design choice. If your platform allows retrying a failed task, model the retry as a new attempt with a new id or an explicit attempt counter, not as a quiet reversal of a terminal record.

### Atomic replace: temp file plus rename

If you keep a snapshot file, write it atomically so a crash never leaves half a file. The standard recipe is: write a temp file in the same directory, flush it, `rename` over the target, then sync the directory so the rename itself is durable. The npm [write-file-atomic](https://github.com/npm/write-file-atomic) package implements the first three steps, gives each call its own temporary name (process id plus an invocation counter), and serializes concurrent writes to the same path; its source syncs the temporary file before the rename but does not sync the directory. A minimal version:

```js
import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

async function atomicWrite(path, text) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`; // unique per call
  const fh = await fs.open(tmp, 'wx');
  try {
    await fh.writeFile(text);
    await fh.sync();               // the data is on disk before it gets the name
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, path);      // atomic replace on POSIX filesystems
  const dir = await fs.open(dirname(path), 'r');
  try {
    await dir.sync();              // makes the rename itself survive power loss
  } finally {
    await dir.close();
  }
}
```

Two details matter. The unique temporary name keeps two overlapping calls from writing into, or renaming away, the same temp file: in my test, 20 rounds of two concurrent calls of a same-PID-name version failed one call per round with `ENOENT`, while this version failed none. Unique names do not order the writes, though. The last rename wins, which may be the older snapshot, so keep a single writer per file (one compaction at a time, or a promise queue like write-file-atomic's). Second, `fh.sync()` plus `rename` makes the file's contents durable, but the new directory entry lives in the directory, so the directory needs its own `fsync` to survive power loss. I ran this on Linux; directory sync support differs on other platforms, so check yours (inference).

Use the async API. `fs.promises` does the I/O off the main thread, though note that `JSON.stringify` of the whole state still runs on it, which is why the layout below matters more than sync versus async.

A caution on durability: rename-over-existing without syncing the data first has a known history of producing zero-length files after a crash on some filesystem configurations; LWN's [coverage of the ext4 delayed-allocation episode](https://lwn.net/Articles/322823/) is the classic account, and Dan Luu's [file consistency overview](https://danluu.com/file-consistency/) summarizes how much behavior differs across systems. Whether you need `fsync` depends on how much you can afford to lose. For a state file that can be rebuilt from the platform, you may reasonably skip it. For dedup memory that prevents duplicate notices, I would sync (inference about priorities).

On `fsync` storms: my test showed little extra cost per sync on a fast SSD, but the risk is not per-call cost. It is calling it every tick regardless of change. Write on change, and the problem mostly disappears.

### Append-only journal with periodic compaction

A single JSON document forces an O(file) cost for any change. The alternative that several storage systems use is an **append-only log plus compaction**. Redis's AOF persistence [rewrites the log in the background](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/). Before Redis 7.0 there was a single AOF: the rewrite built a new file with the minimal set of operations needed to recreate the current data set while appends continued to the old file, then switched the two. Since 7.0 the AOF is split into a base file and incremental files tracked by a manifest; when a rewrite starts, the parent opens a new incremental file for ongoing writes, the child writes a new base file, and Redis atomically replaces the manifest once both are ready. SQLite's [write-ahead log](https://www.sqlite.org/wal.html) follows the same idea: changes are appended to a log and periodically checkpointed into the main file.

For a bridge daemon, a simple version looks like this:

```js
flushing = Promise.resolve();
journalBytes = 0;     // length of the journal's acknowledged prefix
uncertain = false;    // an append failed: the file may end in a partial batch

flush() {             // serialized: overlapping calls queue behind each other
  const run = this.flushing.catch(() => {}).then(() => this.flushOnce());
  this.flushing = run;
  return run;
}

async flushOnce() {
  if (this.dirty.size === 0) return;                         // no-op tick: no I/O
  const batch = [...this.dirty].map(id => this.records.get(id)); // capture, do not clear yet
  const text = batch.map(r => JSON.stringify(r)).join('\n') + '\n';
  if (this.uncertain) await fs.truncate(this.journalPath, this.journalBytes); // drop partial tail
  const fh = await fs.open(this.journalPath, 'a');           // creates the file on first use
  this.uncertain = true;                                     // only now can the append touch the file
  try {
    await fh.appendFile(text);                               // O(changed), not O(history)
    await fh.datasync();                                     // success = durable, not just accepted
  } finally {
    await fh.close();
  }
  this.uncertain = false;
  this.journalBytes += Buffer.byteLength(text);
  for (const r of batch) {                                   // acknowledge only what was written
    if (this.records.get(r.id) === r) this.dirty.delete(r.id); // a newer change stays dirty
  }
  if (this.journalBytes > COMPACT_AT) this.scheduleCompaction();
}
```

The rules this encodes:

- **Acknowledge after persistence.** The batch is captured but stays in `dirty` until the append succeeds. A tempting shorter version clears `dirty` before appending; when I ran it with a writer that rejected once, the dirty set was already empty and the next flush never called the writer, so a terminal marker was silently lost.
- **A failed or uncertain append is retried whole.** A failed append may still have written part of the batch, so the next flush first truncates the journal back to the last acknowledged length. Without that, the retried batch is glued onto the partial line and replay later throws (both observed in my harness). The tail is marked uncertain only after `open` has returned a handle, because only then can the append change the file. Marking it earlier breaks the first write: if the very first `open` fails while the journal does not exist yet, every retry would try to truncate a missing file and fail with `ENOENT` before reaching `open` again (also observed; with the flag set after `open`, the retry creates the file and writes the batch).
- **Newer changes survive an in-flight append.** A record is removed from `dirty` only if it is still the exact object that was written; a change made while the append was in flight stays dirty and goes out on the next flush.
- **Overlapping calls are serialized.** A second `flush()` waits for the first, then writes only what is still dirty, so two appends never interleave.
- **Success means durable here.** `flush()` resolves after `datasync` returned, not merely after the write was accepted into the page cache. Dropping the `datasync` gives page-cache acceptance: it survives a process crash but not power loss. Choose per data class, as in the durability caution above. If the journal file is newly created, sync its directory once too, as above.

Replay on startup is last-write-wins by id, so duplicate lines are harmless. Only newline-terminated lines count; bytes after the last newline are a torn append from a crash, so replay ignores them and truncates them away before new appends. A malformed line in the middle is corruption, not a torn append, and should stop startup. Redis [takes the same approach](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/) to a truncated AOF by default, "discarding the last non well formed command in the file".

```js
async function replay(journalPath) {
  const text = await fs.readFile(journalPath, 'utf8')
    .catch(err => { if (err.code === 'ENOENT') return ''; throw err; }); // first start: no journal yet
  const complete = text.slice(0, text.lastIndexOf('\n') + 1); // after the last '\n' = torn append
  const records = new Map();
  for (const line of complete.split('\n')) {
    if (line) { const r = JSON.parse(line); records.set(r.id, r); } // last write wins; a bad
  }                                                                // complete line throws
  const journalBytes = Buffer.byteLength(complete);
  if (complete.length < text.length) await fs.truncate(journalPath, journalBytes);
  return { records, journalBytes };
}
```

I ran these snippets against a real file with injected faults: reject once then succeed, a partial write followed by a rejection, a change during an in-flight append, three overlapping `flush()` calls, a torn final line, a first `open` that fails while the journal does not exist yet, and a first start with no journal file. In each case the journal replayed to the latest in-memory state with nothing left dirty. Newline framing will not catch every kind of damage; a per-line checksum would (inference).

Compaction writes a fresh snapshot (temp plus rename) and then retires the journal segment. It is still O(history), but it runs rarely, off the tick path, ideally with a rotated journal segment so appends during compaction are not lost. In my benchmark, appending one small record to a log file took a few microseconds (page-cache, median of 50 appends), versus ~174 ms to rewrite a 39 MB snapshot. That figure does not include the per-flush `datasync` above.

Even simpler and often enough: **split by lifecycle**. Keep `active.json` small and rewritten on change, and move records to an append-only `terminal.ndjson` the moment they become terminal. The hot file's size now tracks concurrency, not age.

If your needs grow past this, an embedded database such as SQLite gives you indexes on status, transactions, and incremental writes without writing any of the above yourself (inference: a reasonable default for new designs, though it adds a native dependency).

## 4. Keeping records without keeping them hot

**The reason not to delete finished records is that they are how you remember what you already did.** Cold is fine. Gone is dangerous.

Consider the failure sequence if the daemon deletes a cancelled dispatch from its state:

1. The daemon delivers a cancellation notice and marks the dispatch cancelled.
2. A cleanup pass removes the record to keep the file small.
3. The platform's list endpoint still returns that task in its recent history, or redelivers it after a network retry.
4. The daemon sees an unknown id with a status that triggers an action. It delivers the cancellation notice again, or worse, dispatches it as new work.

This is the same reason payment APIs keep idempotency keys. Stripe's [idempotency docs](https://docs.stripe.com/api/idempotent_requests) say keys can be removed after they are at least 24 hours old, and that a reused key after pruning produces a new request. Their [engineering write-up](https://stripe.com/blog/idempotency) explains the design. The dedup window is a **contract**: it has to be longer than the longest period in which a duplicate can legitimately arrive.

### Patterns that work

- **Terminal index (id to terminal metadata).** Keep a compact map `id -> { status, terminalAt, noticeSentAt }` in memory, loaded from the archive at startup. Lookups are O(1) and it is tiny relative to full records. The loops never iterate it. They only consult it when the platform presents an id.
- **Tombstones for deletions.** When a record is dropped from full storage, leave a minimal marker (id plus terminal timestamp). Kafka's log compaction uses this idea: a [null-payload record is a delete marker](https://kafka.apache.org/41/design/design/) that is itself removed after a configured delete retention period. Celery's docs use the word "tombstones" for expired result placeholders too.
- **Retention with explicit semantics.** Write down what expiry means: "terminal records are kept in full for 30 days, tombstones for 180 days, and the platform is known not to return tasks older than 90 days". Then the expiry of the tombstone is safe by construction. Without that last clause, you are guessing (inference: I have not seen a platform contract for this in the public docs I read; check yours).
- **Make side effects idempotent at the receiver where possible.** Send an idempotency key (the dispatch id plus action) with notices. Then even if your local memory is lost, duplicates are absorbed downstream.
- **Retain asymmetrically.** As BullMQ suggests, failures deserve longer retention than successes, because they are what humans investigate.
- **Make the poll itself O(active).** A tick's cost is the work over three sets: the records the remote returns, the active records it reconciles, and the changed records it writes. The terminal index only makes each returned record cheap; it does not shrink the set. So bound the returned set explicitly: ask for active items or items changed since a cursor rather than the full list. Kubernetes' list-then-watch model (see its [API concepts](https://kubernetes.io/docs/reference/using-api/api-concepts/)) is the canonical version of this. If the platform can only return the full list, the terminal index still keeps finished records free of side effects, but each tick stays O(history) in lookups; poll the full list less often than the active work instead.

A reconcile loop built this way does O(returned + active + changed) work per tick, which is O(active + changed since the last tick) once the query is bounded:

```js
async function tick(platform, store) {
  // Bounded query: only tasks changed since the cursor, never the full history.
  const { items, cursor } = await platform.list({ updatedSince: store.cursor });
  for (const t of items) {                     // O(returned) = O(changed)
    if (store.isTerminal(t.id)) continue;      // O(1) lookup: finished, ignore
    store.apply(t.id, toLocal(t));
  }
  for (const id of store.active) {             // O(active)
    await reconcile(store.records.get(id));
  }
  await store.flush();                         // O(changed); no-op when nothing is dirty
  store.cursor = cursor;                       // advance only after the flush succeeded
}
```

One more benefit: the cancellation path. If the active set is small, you can afford to make the cancellation step cheap and ahead of other work, for instance by processing "cancel requested" records first in the pass. That is the time-sensitive path from the motivating scenario, and it only works when the pass is short.

## 5. Testing and guarding

**Test work done, not time taken.** Wall-clock assertions are flaky in CI. Counters for visits and writes are deterministic.

### Per-tick work is O(active)

Inject the I/O and count every kind of work the tick does: records the remote returned, terminal-index lookups, reconcile calls, and journal lines written. Assert exact, nonzero expected counts for a small and a huge history. Equal counts alone are not enough: a tick that lists everything and discards finished records through the terminal index reconciles and writes exactly as much as a good one, and two zero counts are always equal. So the suite includes that scan-all tick as a known-bad control that must fail the check.

```js
import test from 'node:test';
import assert from 'node:assert/strict';

// setup() puts `historySize` finished tasks and 5 running ones on a fake platform and in
// the store, flushes, sets the cursor, and returns counters: records the platform returned,
// terminal-index lookups, reconcile calls, and journal lines written.
async function oneTick(historySize, tickImpl) {
  const { platform, store, stats } = await setup({ historySize, running: 5 });
  platform.update('live-0', { status: 'cancel_requested' });  // two remote changes
  platform.update('live-1', { status: 'completed' });
  await tickImpl(platform, store);
  return stats;
}
const expected = { returned: 2, terminalLookups: 2, reconciled: 4, written: 2 };

test('per-tick work tracks changed and active records, not history', async () => {
  for (const historySize of [1_000, 200_000]) {
    assert.deepEqual(await oneTick(historySize, tick), expected);
  }
});

test('control: a scan-all tick fails the same check', async () => {
  // scanAllTick is tick() with the filter removed: platform.list({})
  await assert.rejects(async () => {
    for (const historySize of [1_000, 200_000]) {
      assert.deepEqual(await oneTick(historySize, scanAllTick), expected);
    }
  }, assert.AssertionError);
});
```

Run against the code above, both tests pass. Pointed at `scanAllTick` instead, the first test fails at the 1,000-record history with `returned: 1005, terminalLookups: 1005` against the expected 2, while `reconciled` and `written` match: exactly the gap that equal-count assertions miss.

### A no-op tick writes nothing

Counting writes through an injected writer is more reliable than watching `mtime`, but an mtime check is a good end-to-end smoke test, particularly if you worry about code paths that bypass the writer. Beware coarse timestamp granularity: sleep a few milliseconds or compare `mtimeMs` plus file size and inode.

```js
test('no-op tick performs zero writes', async () => {
  const { platform, store, stats } = await setup({ historySize: 10_000, running: 5 });
  await tick(platform, store);
  await tick(platform, store);
  assert.equal(stats.written, 0);
  assert.equal(stats.reconciled, 10);          // the ticks did run: 5 records, twice
});
```

### Terminal records are never re-acted upon, including after restart

This is the test that protects the idempotency contract. Persist, build a fresh instance from disk (simulating a restart), replay a platform response that still contains the finished tasks, and assert that no side-effect function fired.

```js
test('finished tasks cause no side effects after restart', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'bridge-'));
  const sent = [];
  const first = await Store.open(dir, { notify: (m) => sent.push(m) });
  await tickWith(first, [{ id: 't1', status: 'cancelled' }]);
  assert.equal(sent.length, 1);                          // the one legitimate notice

  const second = await Store.open(dir, { notify: (m) => sent.push(m) }); // "restart"
  await tickWith(second, [{ id: 't1', status: 'cancelled' }]);          // platform replays it
  assert.equal(sent.length, 1);                          // no duplicate
});
```

Also test the retention boundary explicitly: a record past full retention but inside tombstone retention must still dedup, and one past tombstone retention is allowed to be treated as new.

### Benchmarks and production alarms

- **Synthetic large history benchmark** (like the one above) as a non-blocking CI job or a manual script. Record ticks per size, and fail only on large regressions in the ratio between 1,000 and 100,000 records, not on absolute milliseconds.
- **Event-loop lag alarm** using `monitorEventLoopDelay` as shown earlier, plus a periodic log line of state size, active count, and tick duration. When the first two are flat and the third grows, you have found an O(history) path.
- **Tick duration metric** with the labels `visited`, `written`, `duration_ms`. A healthy system has `visited` tracking active count, and `written` equal to zero on most ticks.
- **Startup time check.** Cold-start parse cost scales with history (about 106 ms at 100,000 records here). If startup time matters, it is another reason to split archive from active data.

## 6. A checklist for agent-runtime authors

1. **Write down the unit of work per tick.** It should be "active items", "changed items", or "items returned by a cursor". If the honest answer is "all items ever", fix it before it ships.
2. **Define terminal states and make them absorbing.** Retries get new attempt ids.
3. **Maintain an active index** and have loops iterate only that. Do not filter the full collection each time.
4. **Ask the remote for less.** Use status filters, `updatedSince` cursors, or watch semantics where the platform supports them.
5. **Track dirtiness at mutation time.** A transition function returns "changed" or "unchanged". Use content comparison only as a backstop.
6. **No-op ticks do no I/O.** No timestamps updated just because we looked ("lastChecked"), no rewrites of identical content.
7. **Do not rewrite big files per change.** Use an append-only journal with rotation and compaction, or split active and terminal storage by lifecycle, or use an embedded database.
8. **Write atomically** (temp file in the same directory plus rename) and decide your `fsync` policy deliberately per data class.
9. **Keep terminal records, cold.** Archive them, load a compact dedup index, and never iterate it in the hot path.
10. **Give retention explicit semantics.** Full record TTL, tombstone TTL, and the replay horizon of the upstream platform, written down and checked into the repo. Never let the tombstone TTL be shorter than the longest period in which duplicates can arrive.
11. **Make side effects idempotent downstream too.** Send an idempotency key with every notice.
12. **Prioritize time-sensitive work within a pass.** Cancellations and deadlines run before bulk bookkeeping, and long passes yield to the event loop.
13. **Measure the loop.** Event-loop delay histogram, tick duration, visited and written counts, state size. Alarm on max lag.
14. **Test the invariants:** O(active) visits, zero writes on no-op, no duplicate side effects after restart, and retention boundaries.
15. **Benchmark with a synthetic history** several times larger than production before shipping, and again whenever the storage layout changes.

## Limitations

The benchmark is a single-machine microbenchmark with synthetic records of a single shape, no real network or per-record business logic, and no contention. Real passes that make an API call or do heavier computation per record will degrade faster than shown. The code snippets are illustrative sketches, not production-ready libraries, and the compaction and rotation steps are only described, not implemented. Statements marked "(inference)" are my interpretation rather than documented behavior of the cited systems.

## Sources

All URLs were fetched and confirmed reachable on 2026-11-15, and the specific claims attributed to them were checked against the page text.

- Node.js, [Don't Block the Event Loop](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop)
- Node.js, [Performance measurement APIs (`perf_hooks`, `monitorEventLoopDelay`)](https://nodejs.org/api/perf_hooks.html)
- Kubernetes, [Writing controllers (community guide)](https://github.com/kubernetes/community/blob/master/contributors/devel/sig-api-machinery/controllers.md)
- Kubernetes, [Controllers](https://kubernetes.io/docs/concepts/architecture/controller/)
- Kubernetes, [Jobs, including cleanup of finished Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/job/)
- Kubernetes, [TTL-after-finished controller](https://kubernetes.io/docs/concepts/workloads/controllers/ttlafterfinished/)
- Kubernetes, [Pod lifecycle, garbage collection of Pods](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- Kubernetes, [Garbage collection](https://kubernetes.io/docs/concepts/architecture/garbage-collection/)
- Kubernetes, [API concepts (list and watch)](https://kubernetes.io/docs/reference/using-api/api-concepts/)
- client-go, [`tools/cache` package, `DeletedFinalStateUnknown`](https://pkg.go.dev/k8s.io/client-go/tools/cache#DeletedFinalStateUnknown)
- BullMQ, [Auto-removal of jobs](https://docs.bullmq.io/guide/queues/auto-removal-of-jobs)
- Sidekiq, [Error Handling (retries and the Dead set)](https://github.com/sidekiq/sidekiq/wiki/Error-Handling)
- Celery, [Configuration, `result_expires`](https://docs.celeryq.dev/en/stable/userguide/configuration.html)
- Temporal, [Temporal Server, retention period](https://docs.temporal.io/temporal-service/temporal-server) and [Namespaces](https://docs.temporal.io/namespaces)
- Stripe, [Idempotent requests](https://docs.stripe.com/api/idempotent_requests) and [Designing robust and predictable APIs with idempotency](https://stripe.com/blog/idempotency)
- Redis, [Persistence (AOF and background rewrite)](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
- SQLite, [Write-Ahead Logging](https://www.sqlite.org/wal.html)
- Apache Kafka, [Design: log compaction and tombstones](https://kafka.apache.org/41/design/design/)
- npm, [write-file-atomic](https://github.com/npm/write-file-atomic)
- LWN, [ext4 and data loss](https://lwn.net/Articles/322823/)
- Dan Luu, [Files are hard](https://danluu.com/file-consistency/)
