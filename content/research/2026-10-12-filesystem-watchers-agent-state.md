---
date: "2026-10-12"
title: "Filesystem Watchers Are Invalidation Signals, Not State Histories"
description: "A reproducible Node.js experiment shows why agent hot reload needs reconciliation after file replacement and missed notifications."
tags:
  - research
  - agents
  - nodejs
  - reliability
  - filesystems
---

## Executive Summary

A long-running agent can keep serving requests while silently using an outdated configuration, even though its file watcher originally worked. A Linux experiment with Node.js v24.17.0 reproduced one cause: replacing a watched file changed its inode, and a later write reached a directory watcher but produced no callback from the original file watcher during the observation window. The proposed response is to make notifications request an authoritative reread, with periodic reconciliation covering missed signals; this recovers current state but cannot reconstruct every intermediate edit.

## The Failure Hidden Inside a Successful Save

Consider an agent that reads `config.json` at startup and registers a watcher on that filename. An operator saves a new configuration by writing a temporary file and renaming it over the destination. The agent sees activity and reloads successfully. A later edit changes the new file, yet the agent keeps its earlier settings.

That first successful reload is misleading. The application followed the pathname when reading, but its watch remained associated with the old filesystem object. Node's pinned v24.17.0 documentation describes inode-based watches on Linux and macOS: recreating a path does not transfer the original watch to its new inode. [Node.js: Inodes](https://nodejs.org/download/release/v24.17.0/docs/api/fs.html#inodes).

Replacing the destination can still be the right writer behavior. Linux `rename()` atomically replaces an existing destination, avoiding a moment when readers find that destination missing. The operation has filesystem and mount boundaries; a temporary file beside the destination avoids accidentally relying on a cross-mount rename. Atomic namespace replacement does not itself promise persistence after power loss. [Linux rename manual](https://github.com/mkerrisk/man-pages/blob/master/man2/rename.2).

The lesson for a reader is that successful publication and continued observation are separate responsibilities. A replacement protocol can improve what readers see while exposing an assumption in how readers notice the next update.

## What Notifications Actually Establish

There are three different questions:

| Question | Evidence needed |
| --- | --- |
| Could my cached state be stale? | A notification is a useful trigger. |
| What state should I use now? | Read and validate the authoritative source. |
| What exactly happened between two moments? | Preserve a durable history of changes. |

Linux inotify may coalesce identical unread events, so event counts cannot reliably count operations. Its queue can overflow and lose events; the manual recommends rebuilding cached state when needed. Native directory watches are not recursive, and adding a watch after discovering a new directory leaves a race that calls for scanning its contents. These are documented interface properties, not failures induced by the experiment below. [Linux inotify manual](https://github.com/mkerrisk/man-pages/blob/master/man7/inotify.7).

Node adds a portability boundary: a callback's filename can be absent, and watching may be unreliable on network or virtualized filesystems. A consumer should therefore handle a missing filename as a reason to check the relevant source set, rather than discard the callback. [Node.js: Watch caveats](https://nodejs.org/download/release/v24.17.0/docs/api/fs.html#caveats).

This article proposes a consumer design for a small set of agent settings or memory documents. It does not propose that a watcher become a transactional log, or that one reread creates a coherent snapshot across unrelated files.

## A Reproducible Replacement Experiment

The following experiment needs Node.js and a local Linux filesystem. Save it as `watch-study.mjs` and run `node watch-study.mjs`. It creates an isolated temporary directory and leaves the small fixture available for inspection. It does not read application configuration.

The experiment establishes an in-place positive control, replaces the destination, then modifies the replacement. It records watcher callbacks separately from the value actually applied. Finally, it stops both watchers and demonstrates that a direct reconciliation still retrieves a newer revision.

```javascript
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-study-'));
const target = path.join(dir, 'config.json');
const temp = path.join(dir, 'next.json');
const put = (p, n) => fs.writeFileSync(p, JSON.stringify({ revision: n }));
const read = () => JSON.parse(fs.readFileSync(target, 'utf8')).revision;
let phase = 'initial', applied = 0;
const events = [];
put(target, 0);
const oldInode = fs.statSync(target).ino;
const fileWatch = fs.watch(target, (type, name) =>
  events.push({ watch: 'file', phase, type, name }));
const directoryWatch = fs.watch(dir, (type, name) => {
  events.push({ watch: 'directory', phase, type, name });
  if (name === null || name === 'config.json') applied = read();
});
const waitFor = async (test) => {
  for (let i = 0; i < 200; i++) {
    if (test()) return;
    await delay(10);
  }
  assert.ok(test(), 'timed out');
};
try {
  phase = 'in-place-control'; put(target, 1);
  await waitFor(() => events.some(e =>
    e.watch === 'file' && e.phase === phase) && applied === 1);
  await delay(150);
  phase = 'replacement'; put(temp, 2); fs.renameSync(temp, target);
  await waitFor(() => applied === 2);
  await delay(250);
  const newInode = fs.statSync(target).ino;
  assert.notEqual(oldInode, newInode);
  phase = 'post-replacement'; put(target, 3);
  await waitFor(() => applied === 3);
  await delay(500);
  const fileAfter = events.filter(e =>
    e.watch === 'file' && e.phase === 'post-replacement').length;
  const directoryAfter = events.filter(e =>
    e.watch === 'directory' && e.phase === 'post-replacement').length;
  assert.equal(fileAfter, 0);
  assert.ok(directoryAfter > 0);
  assert.equal(read(), 3);
  fileWatch.close(); directoryWatch.close();
  put(target, 4);
  assert.equal(applied, 3);
  applied = read();
  assert.equal(applied, 4);
  console.log({ node: process.version, oldInode, newInode,
    fileAfter, directoryAfter, applied });
} finally {
  fileWatch.close(); directoryWatch.close();
}
```

Observed on Node.js v24.17.0, Linux 6.17, using a local filesystem:

| Stage | Observed result |
| --- | --- |
| In-place revision 1 | Both watches fired; applied revision became 1. |
| Rename replacement, revision 2 | Inode changed; directory-triggered reread applied 2. |
| In-place revision 3 | Original file watch: 0 callbacks; directory watch: 1 callback; applied 3. |
| Both watchers closed, revision 4 | Applied value remained 3 until direct reread, then became 4. |

The silence claim has two checks: the original watch passed an earlier positive control, and a separate watch plus direct content read confirmed the later update. The documented inode behavior supplies an independent explanation. Exact callback counts and ordering are observations of this run, not a portable contract.

The final step emulates one periodic reconciliation by calling the same read directly. It does not test timer scheduling, kernel queue overflow, network filesystems, recursive watch installation, or process restart. The synchronous I/O keeps this tiny probe easy to inspect; it is not a production reload loop. A finite observation interval alone cannot prove that a callback will never arrive.

## A Minimal Reconciliation Design

The following is a proposed design derived from the failure scenario. Its goal is eventual adoption of the latest valid single-document state after writers settle, assuming reads eventually succeed and the reconciliation worker keeps running.

### Watch the directory, then read the path

For a replaceable file, watch a stable parent directory and treat relevant notifications as requests to reconcile the configured pathname. Install the watch before the initial read, and perform that initial read regardless of notifications. This avoids making startup depend on a future edit.

The parent directory is itself an object. If deployments can replace that directory, the application must detect the change and reestablish its watch. Periodic checks should compare the current parent identity with the identity associated with the installed watcher, while continuing to read the configured target. Otherwise the design simply moves the original assumption up one level.

A missing filename should broaden reconciliation to the small configured scope. A notification about a temporary file need not be interpreted as a completed configuration update. Filtering can reduce work, but correctness should come from rereading the source and the periodic fallback.

### Serialize reconciliation and retain pending work

Maintain a dirty flag and allow only one reconciliation worker. Notifications, periodic ticks, and retries all set that same flag; pending requests coalesce, with at most one retry timer scheduled. The worker clears dirty immediately before reading, then reads, parses, validates, and publishes a complete candidate. If another request arrived during the work, dirty remains set and the worker makes another pass. Yield between passes so a sustained event stream does not monopolize the event loop.

Clearing dirty after publication would erase a notification that arrived while the previous read was in flight. Launching independent asynchronous reloads would introduce another hazard: an older read could finish later and overwrite a newer applied state. A single worker makes publication order explicit.

For small files, comparing a content digest or validated revision avoids repeating expensive application work for duplicate notifications. Metadata can be a useful shortcut, but a design that promises eventual content reconciliation must not permanently skip reads solely because size and timestamps appear unchanged.

### Keep failure visible and retry independently

A temporary parse failure should leave the last valid candidate intact and schedule a bounded-backoff retry. Record the failed attempt and the active revision. Do not update the applied digest when validation fails; otherwise an unchanged invalid candidate can become indistinguishable from something already accepted.

If watcher setup throws or an established watcher emits an error, report monitoring as degraded and attempt bounded-backoff reestablishment. Periodic reconciliation continues independently of watcher availability, through the same serialized worker.

Missing files require an explicit semantic choice. An optional instruction document may mean an empty value when absent; a required configuration may mean startup refusal or a degraded running state. Neither policy should arise accidentally from catching every exception and retaining stale data forever.

Retaining old permissions after a revocation fails to load can be unsafe. For security-sensitive settings, choose a fail-closed or freshness-deadline policy separately. A generic “last good configuration” rule cannot decide that tradeoff for the application.

### Reconcile periodically, even when everything seems quiet

Use notifications for low latency and a timer for recovery from silence. The interval trades additional reads against the tolerated stale window. With a healthy scheduler, successful reads, and a stable valid source, the interval plus reconciliation time gives an approximate recovery target; it is not a hard bound during event-loop stalls, I/O failures, or endless invalid writes.

Debouncing reduces redundant work during bursts, but an indefinitely extended debounce can starve reloads. A bounded delay or separate periodic path prevents a continuous event stream from indefinitely postponing the next attempt.

Health reporting should expose last successful read, active revision or digest, last apply time, last error, and whether the watcher has been established. “The watcher object exists” cannot show that the runtime matches its source.

## Current State Is Not an Audit Trail

Suppose revisions A, B, and C are published while the consumer is stalled. A later successful reconciliation sees C. That meets the proposed current-state objective, but it cannot show whether B existed, who authored it, or whether it briefly revoked a permission.

If every transition matters, the writer needs a durable version history or transactional event record with consumer progress tracking. Retrofitting that guarantee onto notification counts cannot recover events already lost or coalesced. Reconciliation and audit answer different questions and may legitimately coexist.

For an agent, this distinction also separates source adoption from conversation behavior. Loading a new instruction document changes the runtime's source state; it does not automatically remove older instructions already placed in a model's context. Record which applied revision a new operation uses, and define when changes take effect for work already running.

The practical acceptance test is therefore behavioral: replace the file, edit the replacement, interrupt notifications, and verify that the active validated revision eventually matches the source. Watcher callbacks are supporting diagnostics. The result to measure is the state the agent actually uses.

## Sources

- [Node.js v24.17.0 filesystem API](https://nodejs.org/download/release/v24.17.0/docs/api/fs.html): pinned runtime documentation, especially watch caveats and inode behavior.
- [Linux inotify manual source](https://github.com/mkerrisk/man-pages/blob/master/man7/inotify.7): documentation snapshot dated 2021-03-22; longstanding queue, coalescing, and reconciliation semantics.
- [Linux rename manual source](https://github.com/mkerrisk/man-pages/blob/master/man2/rename.2): atomic destination replacement and cross-mount restrictions.
- Original experiment above: isolated Linux execution with Node.js v24.17.0; observations scoped to replacement and explicit reread recovery.
