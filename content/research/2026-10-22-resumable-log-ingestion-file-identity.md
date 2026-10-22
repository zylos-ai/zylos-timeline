---
date: "2026-10-22"
time: "09:00"
title: "The Offset Is Not the File: Building Durable Tail Cursors That Survive Rotation, Truncation and Replacement"
description: "A measured, source-checked guide to resumable JSONL log ingestion: how mature tailers identify files, what each rotation style breaks, where every detection signal is blind, and how to commit rows and cursors atomically with visible gaps."
tags: ["research", "logging", "observability", "agent-infrastructure", "reliability", "data-ingestion"]
---

## Executive Summary

Agent platforms tend to grow the same small subsystem: one process (a dashboard, an indexer) tails append-only JSONL files written by other processes (hooks, routers, supervisors), keeps a byte offset in a database, and must resume correctly after a restart. The offset is the easy part. The hard part is that an offset is only meaningful relative to a specific sequence of bytes, and a path name does not guarantee you are looking at the same bytes you were looking at yesterday.

This article combines a read of the documentation and source of the main production tailers (Fluent Bit, Vector, Filebeat, the OpenTelemetry Collector `filelog` receiver, Promtail/Alloy, GNU `tail`) with a set of reproductions on a Linux machine. Everything labelled **Measured** below was run on Linux 6.17.0 (aarch64), ext4, Python 3.12.3, logrotate 3.21.0 and GNU coreutils 9.4. Everything labelled **Docs** comes from the cited documentation and is not something I re-tested.

The main conclusions:

1. **Identity must be a tuple, not a single signal.** `(device, inode)` alone is wrong because inodes are reused (measured: immediate delete-then-create reused the same inode in 20 of 20 trials on ext4). A head-of-file fingerprint alone is wrong because files can share identical headers and because short files have no stable fingerprint yet. Use `(dev, ino)` plus a *sealed* head anchor plus a monotonically increasing generation.
2. **`size < offset` is necessary but far from sufficient.** In a measured copytruncate run with a writer that did not use `O_APPEND`, the file never appeared smaller than the old offset at 1 ms sampling, because the writer immediately wrote past its stale offset and left a 1.7 MB run of NUL bytes.
3. **copytruncate is hostile to correct readers.** With logrotate's own `copytruncate`, 350 of 73,850 lines (0.47%) vanished in the copy-to-truncate window, in a contiguous range, with no error anywhere.
4. **Commit rows and the new offset in one transaction.** Measured: committing rows first and the offset second duplicates 10 of 10 lines after a crash; the reverse order loses all 10; one transaction is exact. An idempotency key makes the first ordering safe too, but not the second.
5. **Some things cannot be detected, and the honest design says so.** An in-place rewrite that preserves the anchor bytes and ends up at least as long as the cursor is invisible to head-fingerprint tailers. A cheap second check (a hash of the bytes immediately before the cursor) closes most of that hole; I measured it doing so. Loss of bytes that were never observed can only be detected if the writer embeds sequence numbers.
6. **Losses must be surfaced, not smoothed over.** Model "continuity cannot be proven" as a first-class `gap` record with a reason, and show it in the UI.

## 1. The problem, stated precisely

A tail cursor is a claim of the form "I have durably consumed bytes `[0, offset)` of *this particular file*". It breaks when "this particular file" changes without the reader noticing. The failure modes fall into four groups:

| Event between two polls | What a path+offset cursor does | Consequence |
|---|---|---|
| Writer renames `app.log` to `app.log.1`, creates new `app.log` | Resets or continues on the new file | Unread tail of the old file is skipped |
| Two rotations between polls | Sees only the newest file | Whole intermediate file never read |
| File truncated, then regrown past the offset | Resumes mid-file, often mid-line | Skipped lines plus a mangled partial line |
| File deleted and recreated (possibly same inode) | Treats it as the same file | Skipped prefix, or duplicates |

A good tailer must (a) never skip bytes silently, (b) never ingest the same line twice as distinct records, and (c) when (a) cannot be guaranteed, say so in the data.

## 2. How mature tailers identify files and persist cursors

### 2.1 Comparison matrix (Docs)

| Tailer | File identity | Persistent cursor | Copytruncate stance in docs | Notable knobs |
|---|---|---|---|---|
| **Fluent Bit** `tail` | inode; optional `db.compare_filename` adds the name (default `false`, inode only) | SQLite DB: "essentially stores `inode=offset`"; example table `in_tail_files(id, name, offset, inode, created)` | Says rotation "is properly handled, including `copytruncate`", then lists race-condition and backpressure loss risks | `rotate_wait` (default 5 s), `db.sync`, `db.journal_mode` (default WAL), `inotify_watcher` |
| **Vector** `file` | Default `fingerprint.strategy = checksum`: CRC over the first `fingerprint.lines` lines (default 1); alternative `device_and_inode` | Checkpoints in `data_dir`, written after each successful read | "Handles this well out of the box" but recommends also including the first rotated file in `include` to cover the gap | `fingerprint.ignored_header_bytes`, `ignore_not_found`, `read_from`, `remove_after_secs` |
| **Filebeat** `filestream` | Default (9.0+) `fingerprint`: hash of byte range, offset 0, length 1024 (min 64); also `native` (inode+device), `path`, `inode_marker` | Registry of per-file state | With fingerprint, "the input detects copytruncate rotation on its own" | `close.on_state_change.renamed`, `clean_removed`, `clean_inactive`, `prospector.scanner.check_interval` (10 s) |
| **OTel Collector** `filelog` | Content fingerprint of first `fingerprint_size` bytes (default 1000, min 16), prefix-matching as files grow | Optional `storage` extension; without it, offsets are in memory only | Detects truncation by comparing stored offset with size; `on_truncate`: `ignore` (default), `read_whole_file`, `read_new` | `start_at`, `poll_interval` (200 ms), `exclude_older_than` |
| **Promtail / Alloy** `loki.source.file` | Positions are matched on path and labels (per the Alloy docs on legacy-position conversion); no inode or fingerprint logic is documented | Positions file (Promtail `sync_period` default 10 s) | Promtail's rotation guide recommends rename+create and says polling combined with copytruncate "may result in losing some logs" | `tail_from_end`, `on_positions_file_error`; entry removed when a target leaves the list |
| **GNU `tail`** | `-f` follows the descriptor, `-F` follows the name (`--follow=name --retry`) | None | n/a | inotify or polling (`-s`) |

Sources are in the References section. A few observations worth drawing out.

**Two camps.** Fluent Bit (and Filebeat's `native`) identify files by the filesystem's `(dev, ino)`. Vector's default, Filebeat 9's default and OTel identify by *content*. The content camp exists precisely because inodes get reused: Vector's docs say the fingerprint strategy "avoids the common pitfalls associated with using device and inode names since inode names can be reused across files", and Filebeat has a dedicated page titled "Inode reuse causes Filebeat to skip lines" describing the mechanism: the old file is removed, a new one is created immediately, "the new file may have the exact same inode", and the reader "tries to continue reading at the old position, which is not correct". Filebeat's docs also list other ways inodes or device IDs are unstable: non-ext filesystems may generate different inode numbers after reboot, tools such as `rsync` or `sed -i` change inodes, and device IDs may change after reboot (LVM is the documented example).

**Content identity has its own failure modes, and the docs say so.**
- *Short files.* OTel's fingerprint grows with the file: its source implements `StartsWith`, a prefix match, "since their initial size is typically less than that of a fingerprint". Filebeat before 9.5 ignored files smaller than `offset + length`; since 9.5 it tracks them with a "growing fingerprint" and migrates the identity once the file reaches the fingerprint size. Filebeat still states that files smaller than the fingerprint `offset` cannot be tracked.
- *Shared headers.* Vector's docs mention `ignored_header_bytes` as "helpful if all files share a common header that should be skipped". Filebeat says that "normally, log lines contain timestamps and other unique fields that make the default fingerprint range suitable" and tells you to inspect your logs. JSONL with a fixed schema preamble can violate that assumption.
- *Changing the fingerprint size.* Both Filebeat and OTel document that changing the fingerprint configuration leads to re-ingestion.

**Persistence guarantees are at-least-once.** Fluent Bit's docs state that after a crash delivery is at-least-once, so some records may be re-ingested. Vector checkpoints after each successful read. OTel's docs caveat that the storage extension "can ensure that log files are consumed accurately" but records can still be lost downstream. None of these tailers is writing to a transactional store together with the offset, which is exactly what an *in-process indexer* can do (section 6).

**Promtail is end-of-life.** The Loki repository states Promtail reached end of life on March 2, 2026 and points to Alloy. I cite its rotation guide because it is the clearest vendor writeup of the tailer/rotator race.

### 2.2 `tail -F` semantics (Measured, GNU coreutils 9.4)

The man page says `-f` defaults to following the descriptor, so a renamed file continues to be tracked, while `--follow=name` "tracks the named file in a way that accommodates renaming, removal and creation". I ran both:

- `tail -F` across rename+create: it printed `l1`, `l2`, then "has become inaccessible" and "has appeared; following new file", then `n1`, `n2`. The line `l3`, appended to the *renamed* file after the rename, was never shown. Name-following is a live-view tool; it is not a no-loss reader.
- `tail -f` (descriptor): printed `l1 l2 l3` and never moved to the new file.
- Truncate-and-regrow with inotify: `tail -F` printed `tail: c.log: file truncated` and re-read from the start.
- The same truncate-and-regrow with polling (`---disable-inotify -F -s 1`) printed the original 8 lines and then `w-10`, `new-11`, `new-12`. It silently skipped `new-1` through `new-9`, and the first emitted record is the middle of the line `new-10`. This is the canonical shape of a `size < offset` miss: the file regrew past the offset between polls.

## 3. Rotation styles and what each one breaks

### 3.1 Measured identity behaviour (ext4, Linux 6.17)

| Operation | Result for `(st_dev, st_ino)` |
|---|---|
| `rename()` in same directory | unchanged (`66306, 29510779` before and after) |
| `rename()` into a subdirectory, same filesystem | unchanged |
| New file at the old path | new inode |
| `unlink` then create, nothing in between | **same inode reused, 20 of 20 trials** |
| `unlink`, create 5 other files, then create | different inode in that run (reuse is allocator-dependent, not guaranteed either way) |
| `open(path, "w")` (truncate in place) | unchanged |
| write temp file, `rename()` over the path | new inode (the temp file's) |
| `gzip` of a rotated file | new inode |
| `mv` ext4 to tmpfs | new `st_dev` *and* new inode (copy+delete) |
| hard link | same identity (`st_nlink` 2) |
| descriptor held across `unlink`, new file created at path | descriptor still reads the *old* content; `st_nlink` is 0 |

The last row matters for implementation: after you `open()` a file, take identity from `fstat(fd)`, not from a separate `stat(path)`, or you can pair a cursor with the wrong file.

### 3.2 Rotation style versus failure

| Rotation style | Writer must | What happens to a path+offset reader | What happens to an identity-aware reader | Residual risk |
|---|---|---|---|---|
| **rename + create** (logrotate `create`) | reopen the log after rename | Skips unread tail of the old file | Finishes the renamed file, then reads new one | If the writer never reopens, it keeps writing into the renamed file (measured below) |
| **copytruncate** | nothing | Offset > size: reset to 0 (or worse, miss it) | Detects truncation only if it polls before regrowth | Bytes written between copy and truncate are lost; no reader can fix this |
| **delete + recreate** | reopen | Same path, maybe same inode | Needs head anchor to tell apart | Inode reuse (measured 20/20) |
| **rename twice between polls** | reopen | Skips the intermediate file entirely | Must enumerate siblings and sort by age | Ordering ambiguity if names are reused |
| **rename across directories, same fs** | n/a | Path lost | Identity preserved, but only if the reader scans that directory | Reader can't find it |
| **rename across filesystems / move by copy** | n/a | Path lost | New `(dev, ino)`: looks like a brand-new file, duplicates | `EXDEV` for `rename()` (Docs) |
| **compression of rotated file** | n/a | Path lost or garbage | New inode, content not byte-identical | Offsets in compressed stream are not offsets in the original |
| **atomic replace (tmp + rename over)** | n/a | Same path, different file | New inode caught by identity | Old inode vanishes with unread bytes |

### 3.3 copytruncate, measured with the real logrotate

I wrote a writer that appended numbered lines continuously and ran `logrotate -f` with `copytruncate` and with `create`, each with an `O_APPEND` writer and a plain-`open` writer.

| Mode / writer | Lines written | Lines readable after rotation | Lost | Notes |
|---|---|---|---|---|
| copytruncate / `O_APPEND` | 73,850 | 73,500 | **350** (lines 40,851..41,200, contiguous) | A 1 ms size sampler saw the file shrink by 1,687,150 bytes |
| copytruncate / no `O_APPEND` | 75,600 | 75,249 | **351** (lines 41,601..41,951) | Live file was 3,099,600 bytes, **1,719,950 of them NUL bytes**; the sampler never saw a size drop |
| create / either | 75,400 and 74,950 | all | 0 | But every line went to `app.log.1`: the new `app.log` stayed empty because nothing told the writer to reopen |

This reproduces what the docs warn about: the logrotate man page says "there is a very small time slice between copying the file and truncating it, so some logging data might be lost", Fluent Bit's docs list the same race, and Promtail's guide says a tailer will often lose the race. What the docs do not emphasise:

- The loss window is *contiguous and invisible*. The rotated copy ends cleanly at a line boundary and the live file restarts at the next line, so nothing looks wrong.
- A writer that opened the file without `O_APPEND` keeps its own file offset across the truncation. Its next `write` lands at the old offset and the kernel zero-fills the hole. A reader that polls for `size < offset` may never see the dip because the file is already at least as large as before. A reader then ingests a run of NULs as the beginning of a "line".
- The `create` rows show the other half of the rename contract: rename-based rotation only works if the writer reopens.

## 4. Detection signals and their blind spots

| Signal | Detects | Blind spot |
|---|---|---|
| `(st_dev, st_ino)` of the open fd | rename, move within a filesystem, hard links; replacement by a different inode | Inode reuse (measured); in-place truncate and rewrite keep it (measured); unstable on some filesystems (overlayfs, network shares) |
| `size < offset` | Truncation seen before regrowth | Regrowth past offset between polls; non-`O_APPEND` writers (measured); cannot say how much was lost |
| Head anchor (hash of first *K* bytes, stored) | Replacement or rewrite whose head differs, including inode reuse (measured) | Files shorter than *K*; files with identical heads; in-place edits beyond *K*; truncate-to-prefix |
| Cursor-window hash (hash of the *W* bytes before the cursor) | Rewrites and replacements that preserve the head but change the region just consumed (measured to catch the truncate-to-prefix case) | Rewrites that preserve those *W* bytes too |
| `mtime` | Something wrote | Writers can set it; granularity; changes on every append so it can't distinguish append from rewrite |
| `ctime` | Metadata or content change | Same; also changes on rename and link count updates, so it is noisy |
| Birth time via `statx` | Creation of a *different* file at the same inode | Not on every filesystem; the kernel clears the mask bit if unsupported (Docs); Python's `os.stat` has no `st_birthtime` on Linux (measured), needs `statx` via ctypes |
| Writer-embedded sequence number | Missing records, even ones never observed | Requires writer cooperation |

### 4.1 Why the head anchor must be fixed-length and never re-sampled

An anchor is "the first *K* bytes at the time we consumed them", stored as a hash. Three rules:

1. **Seal it once and compare, never recompute.** If you re-hash the current head of the file at each poll and *store that* as the new identity, a replaced file simply gets a new identity with no alarm. The check must be "does the current head match what I saved?".
2. **Fixed length.** Changing *K* later changes every hash; Filebeat and OTel both warn that changing the fingerprint size triggers re-ingestion.
3. **Extend from consumed bytes only.** For a file shorter than *K* when first seen, store a hash of what you have (`k < K` bytes). On each later poll verify that prefix, and extend the anchor only using bytes at or below the committed offset, so the anchor always describes bytes you have actually consumed. This is the same idea as OTel's prefix-matching `StartsWith` and Filebeat's growing fingerprint.

It fails in two predictable ways: files whose first *K* bytes are identical (a fixed JSON preamble or banner), and files that are shorter than *K* and have not yet grown.

### 4.2 Birth time (Measured)

`statx(2)` with `STATX_BTIME` returned a birth time with nanosecond precision on ext4 (`1792630870.748621589`) and on tmpfs (`/dev/shm`), and returned the mask bit *cleared* on `/proc` (the man page says unsupported fields are cleared in `stx_mask`, so you must check the mask). GNU `stat -c %w` also shows it. Birth time was unchanged by in-place truncation and different after delete+create (about 110 ms later in my run). That makes it a useful *tiebreak* for inode reuse where available, and for ordering unseen rotated files, but it is not portable enough to be your only signal.

### 4.3 Capability boundaries

Stated plainly, a head-anchor plus size tailer **cannot** detect:

- an in-place rewrite that preserves the first *K* bytes and leaves the file at least as long as the cursor;
- a replacement file with the same inode, same head, and length at least the cursor;
- an in-place edit of bytes already consumed (it won't matter for an append-only contract, and nothing can be done if it is violated);
- loss of bytes that were never observed, for example lines appended and then deleted between two polls (see test S7 in section 8). From the reader's side these bytes never existed.

The window hash narrows the first two, and writer-side sequence numbers address the last one. The rest should be turned into a written contract with the writers (section 7).

## 5. A reference tailer, and what it measured

To check the claims above I wrote a compact reference tailer in Python with SQLite (about 150 lines) and ran it against three deliberately simplified baselines:

- **naive-path**: `(path, offset)`, reset to 0 if `size < offset`.
- **inode-only**: `(dev, ino) -> offset`, scans rotated siblings.
- **fingerprint-only**: identity is a hash of the first 128 bytes, no `(dev, ino)`.

These baselines are *my minimal models of each identity strategy*, not Vector, Filebeat or any shipping product. Real tailers add rotation handling and more; the point is to isolate what each single signal can and cannot do.

The cursor schema:

```sql
CREATE TABLE files(
  id INTEGER PRIMARY KEY, stream TEXT, dev INT, ino INT, gen INT,
  anchor_len INT, anchor_hash BLOB,         -- sealed head anchor (<= K bytes)
  off INT, last_size INT, win_hash BLOB,    -- committed cursor + hash of W bytes before it
  sealed INT,                               -- drained to EOF after it stopped being the live name
  status TEXT,                              -- active | retired | gap
  gap_reason TEXT, gap_bytes INT);
CREATE TABLE rows(
  stream TEXT, dev INT, ino INT, gen INT, line_off INT, body BLOB, malformed INT,
  PRIMARY KEY(stream, dev, ino, gen, line_off));   -- idempotency key
```

The heart of one poll for one known file, simplified:

```python
fd = os.open(path, os.O_RDONLY)
st = os.fstat(fd)                       # identity from the fd, not a second stat(path)
if (st.st_dev, st.st_ino) != (rec.dev, rec.ino): return    # raced; try next poll

reason = None
if st.st_size < rec.off:                                   reason = "truncated_below_cursor"
elif rec.anchor_len and h(pread(fd, rec.anchor_len, 0)) != rec.anchor_hash:
                                                           reason = "head_anchor_mismatch"
elif rec.win_hash and h(pread(fd, W, rec.off - W)) != rec.win_hash:
                                                           reason = "cursor_window_mismatch"
if reason:                                                 # same identity, different bytes
    close_as_gap(rec, reason)                              # keep history, flag it
    rec = new_generation(rec.dev, rec.ino, gen=rec.gen + 1, off=0)

data = pread(fd, CHUNK, rec.off)
end  = data.rfind(b"\n") + 1                               # whole, terminated lines only
rows = [(stream, dev, ino, gen, rec.off + pos, line, is_malformed(line)) ...]

db.execute("BEGIN")
db.executemany("INSERT OR IGNORE INTO rows VALUES (?,?,?,?,?,?,?)", rows)
db.execute("UPDATE files SET off=?, anchor_len=?, anchor_hash=?, last_size=?, win_hash=? WHERE id=?", ...)
db.execute("COMMIT")                                       # rows and cursor move together
```

Discovery enumerates the live file and its same-directory siblings (`app.log`, `app.log.N`, no `.gz`), processes known files first in the order they were first seen, then unknown files sorted oldest-first by mtime with the live name last. Birth time would be a better sort key where `statx` reports it.

## 6. Cursor and data atomicity

### 6.1 One transaction

The rule: **the inserted rows and the advanced offset are committed in a single database transaction**. Anything else has a window where the two disagree. I tested the three orderings with a crash injected between the steps, then a restart:

| Ordering | Idempotency key | Rows in DB (10 lines in file) | Outcome |
|---|---|---|---|
| rows commit, then offset commit | none | 20 | duplicates |
| rows commit, then offset commit | `(…, line_off)` + `INSERT OR IGNORE` | 10 | exact |
| offset commit, then rows commit | none | 0 | **loss** |
| offset commit, then rows commit | key | 0 | **loss** (a key cannot recreate rows you never inserted) |
| single transaction | either | 10 | exact |

Writing the offset first is the dangerous order and no key rescues it. A single transaction (`BEGIN; INSERT OR IGNORE ...; UPDATE cursor; COMMIT`) gives you exactly-once into the table, and the unique key is the belt to go with those suspenders: it also makes re-ingestion after a *manual cursor reset* or a restore from backup harmless. In a separate fault run, crashing before the commit and after the commit both ended with 20 of 20 rows, zero duplicates, in order. SQLite's atomic-commit documentation (References) describes why a transaction is all-or-nothing across a power loss.

### 6.2 What the idempotency key should be

`(stream, dev, ino, generation, byte offset of line start)`:

- **byte offset of line start** is stable and unique within one file generation, and it costs nothing to compute. A hash of line content is not unique (identical heartbeat lines repeat).
- **generation** distinguishes "the same inode, but different bytes". When truncation, anchor mismatch, or window mismatch is detected, the current record is closed and a new record starts with `gen + 1` and `offset 0`. Without generation, the replaced file's rows would collide with, and silently be dropped in favour of, the previous file's rows via `INSERT OR IGNORE`.
- **`dev`** is included because inode numbers are only unique within a filesystem. The trade-off: if the device number changes across a reboot, as Filebeat's docs warn can happen, every file looks new and is re-ingested. If your deployment sees that, prefer writer-assigned record ids as the key.

### 6.3 Gaps are data

When identity breaks, do not delete the old cursor and start over. Mark it `gap` with a reason and the number of bytes you *know* were unread (`last_size - offset`). In my runs the reasons were `truncated_below_cursor`, `head_anchor_mismatch`, `cursor_window_mismatch` and `vanished_before_sealed`. Two subtleties:

- `gap_bytes` is a lower bound. After truncation the reader only knows the size at its last poll, so the true loss may be larger (it was 0 in my truncation tests even though three lines had been destroyed).
- A gap means "continuity cannot be proven", not "loss is certain". After delete+recreate of a fully-drained file (test S6) the reference tailer flagged a gap although nothing had been lost. That is the correct bias: false alarms are cheap; silent loss is not.

### 6.4 "Retired" versus "vanished"

A file that disappears is only cleanly retired if the reader had already *drained it to EOF after it stopped being the live name* (`sealed`). If it disappears while it was still the live file, or before it was drained, the extent of the unread tail is unknowable: the writer may have appended after your last poll. Retention deletion therefore creates a gap by default, and clean retirement is the exception you have to earn. In tests S7 and S7b the same deletion produced `LOSS-FLAGGED` when the rotated file had five unread lines and `OK` when it had been sealed first.

### 6.5 Ordering, partial lines, malformed lines

- **Order.** Read old, then intermediate, then current. Because a rename keeps the inode, a known file that has been renamed is found by identity among the siblings and continues from its cursor. Unknown siblings are processed oldest first, then the live name. The reference tailer handled two rotations between polls with zero loss and zero duplicates; the path-and-offset baseline lost 11 of 25 lines in the same test.
- **Partial lines.** Only consume up to the last `\n`. In test S8 an unterminated record stayed unconsumed (3 rows), then was ingested whole (4 rows) once the newline arrived. Never advance the cursor past a partial line, and consider a timeout that surfaces a record stuck unterminated for too long.
- **Malformed lines.** Store them with `malformed = 1` and advance. Refusing to advance on a bad line turns one corrupt record into a permanently stuck ingester. Keep the raw bytes so they can be inspected or reparsed.
- **A mid-line resume is a symptom.** Whenever a resume offset lands inside a line, the cursor was applied to the wrong bytes. In the naive runs a "mangled" partial record appeared exactly when that happened.

## 7. Writer-side contracts that make reading reliable

Readers can only be as good as the weakest writer. The cheapest correctness work is to put these rules on the writers:

1. **Append-only, whole lines.** One `write()` per record, ending in `\n`, on a descriptor opened with `O_APPEND`. The `open(2)` man page says the offset move and the write are "a single atomic step" with `O_APPEND`. If multiple processes write the same file, serialise with an advisory lock (or make one process the single writer).
2. **Not on NFS with multiple appenders.** The same man page warns that `O_APPEND` "may lead to corrupted files on NFS filesystems if more than one process appends data to a file at once".
3. **Never truncate or rewrite in place.** No `open(path, "w")` on a live log, no editing with tools that rewrite files, no `: > file`. Every rule in section 4.3 is about this.
4. **Rotate only by same-directory `rename()`.** `rename(2)` is atomic with respect to replacing the new path, leaves open descriptors unaffected, and fails with `EXDEV` across mount points. Rotation by copy (copytruncate, `renamecopy`, cross-device `mv`) creates a window and new identities.
5. **Reopen after rotation, or rotate yourself.** The best pattern is for the writing process to rename and reopen under its own lock. If an external rotator does the rename, the writer must be signalled (the `create` rows of table 3.3 show what happens otherwise).
6. **Never reuse rotated names, and don't shift.** Prefer unique names (timestamp plus sequence) over the `.1 -> .2` shuffle, which changes the name of every file on each rotation.
7. **Delay destructive cleanup.** Compress or delete rotated files only after a retention window longer than the longest plausible reader outage. Compressing immediately creates a new inode and non-comparable offsets; Vector's docs recommend logrotate's `delaycompress` for a related reason (it fingerprints the rotated file uncompressed).
8. **Put a sequence number in every record** (a writer id/epoch and a monotonic counter). It is the only mechanism that detects loss of bytes the reader never saw, and it gives you a content-level dedupe key independent of `dev`.
9. **Avoid identical file preambles**, or keep them shorter than the anchor. If a banner is unavoidable, include a per-file random id in it.

Why copytruncate is hostile in one sentence: it makes the *reader* the only party that can lose data, on a race the reader cannot see, in a file whose identity does not change. If you inherit it, mitigations exist (Vector suggests also listing the first rotated file; OTel's `on_truncate` modes trade duplicates for completeness; Filebeat has copytruncate-specific settings for non-fingerprint identities) but each is damage limitation, not repair.

## 8. Testing: fault injection and the assertions that matter

Every case below was run against the reference tailer and the three baselines. The harness compares a ground-truth multiset of written lines with what landed in the database, and classifies each result as `OK`, `LOSS-FLAGGED` (loss exists but a gap record exists) or `SILENT-CORRUPTION`. Numbers are lines missing in the ingested table for the reference tailer; "baselines" lists the worst baseline result.

| Case | Setup | Correct tailer must show | Measured (reference tailer) | Measured (worst baseline) |
|---|---|---|---|---|
| S1a | Crash before commit | 0 missing, 0 duplicate, in order | 20/20 rows, in order | n/a |
| S1b | Crash after commit | same | 20/20 rows, in order | n/a |
| S2 | Rename + create, 5 unread lines in renamed file | read them, then new file | 0 missing | naive-path: 5 missing |
| S3 | Two rotations between polls | read old tail, intermediate, new | 0 missing, 0 dup | naive-path: 11 missing |
| S4a | Truncate to 0, regrow smaller than cursor | gap flagged | 3 lost, `truncated_below_cursor` | all baselines: silent |
| S4b | Truncate to 0, regrow past cursor | gap flagged, new generation | 3 lost, `head_anchor_mismatch` | inode/path: 13 missing + 1 mangled line |
| S4c | Truncate to prefix, regrow past cursor | **blind spot** for head anchor | with head anchor only: silent. With cursor-window hash: gap flagged, 3 lost, 6 replayed | all baselines: 7 missing + mangled line |
| S5 | In-place rewrite, same inode, different head, longer | gap flagged | 2 lost, `head_anchor_mismatch` | 12 missing + mangled |
| S6 | Drained file deleted, new longer file, inode reused | new generation, no skipped prefix | 0 missing (inode reuse confirmed), flagged conservatively | inode/path: 10 missing + mangled |
| S7 | Retention deletes rotated file with 5 unread lines | gap flagged | 5 lost, `vanished_before_sealed` | all silent |
| S7b | Same, but file was drained first | clean retirement, no gap | 0 missing, no gap | n/a |
| S8 | Unterminated final line completed later | 3 rows, then 4 | 3 then 4 | n/a |
| S9 | Rotation with identical >128-byte preamble | no skip, no duplicate | 0 missing | fingerprint-only: 13 missing + dup |

What distinguishes a correct tailer from a wrong one:

- **`missing > 0` implies a gap record exists.** If not, the tailer lost data silently.
- **`duplicates == 0` after any crash point.** Run it with the idempotency key removed to prove the test can fail.
- **No ingested row starts mid-line.** An unparseable row at an unexpected offset means the cursor was applied to the wrong bytes.
- **Replay equivalence.** Delete the cursor, keep the rows, re-run: row count must not change (idempotency key does its job).
- **Order.** Within one stream, rows from an older file precede rows from a newer file.
- **Blind-spot honesty.** Keep S4c in the suite as a *documented* failure for the head-anchor-only variant, so that the capability boundary is a tested fact rather than folklore.

Test S9 is the one that surprises people: the fingerprint-only baseline skipped 13 lines because the rotated-in file began with the same 128-byte preamble. That does not mean Vector, Filebeat or OTel have the bug (their defaults and prefix handling differ, and the docs tell you to tune `ignored_header_bytes` or the fingerprint range), only that identity-by-content demands that you look at your files' first bytes.

## 9. Environment limits (not reproduced)

I did not reproduce NFS, overlayfs or container behaviour; the following are from the documentation only:

- The kernel's overlayfs documentation says `st_ino` is unique only in combination with `st_dev`, and that non-directories "may report an st_dev from the lower filesystem or upper filesystem" and that both values can change over the lifetime of a non-directory object. With `xino` enabled and all layers supporting NFS file handles, inode numbers are persistent. In containers using overlay layers, a copy-up of a lower-layer file is therefore a plausible identity change.
- Filebeat's documentation notes that "some file systems (i.e. in Docker) cache and re-use inodes" and that some identity modes do not support network shares.
- Fluent Bit's docs say the default WAL journal mode of its SQLite DB "isn't compatible with shared network file systems".

If you cannot control the filesystem, assume identity can be wrong and rely more on the content checks.

## 10. Design checklist

Identity and detection
- [ ] Identity is `(dev, ino)` taken from `fstat` on the open descriptor, plus a generation counter.
- [ ] A head anchor of fixed length *K* is sealed from consumed bytes, stored as a hash, verified (never re-sampled) each poll, and extended only up to the committed offset.
- [ ] Short files (< *K*) are handled: partial anchor, prefix compare, extend later.
- [ ] A window hash of the *W* bytes before the cursor is also verified on resume.
- [ ] `size < offset`, anchor mismatch, window mismatch and vanished file each close the record as `gap` with a reason and start a new generation.
- [ ] You have looked at your files' first *K* bytes and confirmed they are not shared across files.

Atomicity
- [ ] Rows and cursor commit in one transaction. Offset is never written before rows.
- [ ] Unique key `(stream, dev, ino, generation, line_start_offset)` with `INSERT OR IGNORE`.
- [ ] Only whole `\n`-terminated lines are consumed. Malformed lines are stored with a flag and the cursor advances.

Rotation and retention
- [ ] Siblings in the same directory are enumerated each poll; unknown files are processed oldest first, live name last; compressed files are excluded or handled separately.
- [ ] A file is retired only after it was drained to EOF while no longer the live name (`sealed`). Any other disappearance is a gap.
- [ ] Gaps are visible: a counter by reason, a UI banner, and an alert when `gap_bytes` or gap count grows.

Writer contract
- [ ] `O_APPEND`, one `write()` per record, lock if more than one writer, no NFS multi-appender.
- [ ] Rotation by same-directory `rename()` only, writer reopens, unique rotated names.
- [ ] No in-place truncation or rewrite, no copytruncate.
- [ ] Cleanup (compress/delete) waits longer than your worst reader outage.
- [ ] Records carry a writer epoch and a monotonic sequence number.

Tests
- [ ] The thirteen fault cases of section 8, including the documented blind spot, run in CI with the "silent loss implies failure" assertion.

## 11. What I could not verify

- Fluent Bit's documentation site was not fetchable from my environment; I read the same page from its source repository on GitHub. Behaviour claims about Fluent Bit are from that text, not from running it.
- I did not run Vector, Filebeat, the OTel Collector or Alloy. All statements about them are from their documentation or (for OTel) source code of the fingerprint matcher.
- The Promtail positions-file claim is limited to what the Alloy documentation says; I found no documented inode or fingerprint check for Promtail.
- Inode reuse is allocator-dependent. The 20/20 result holds for immediate delete+create on this ext4 volume; with other filesystems or other activity in between, you will see something else (I saw non-reuse after creating five other files).
- Birth time availability was measured on ext4, tmpfs and `/proc` only.
- My reference tailer is polling-based, single-process and unoptimised. It is a vehicle for testing ideas, not a drop-in library.

## References

Tailer documentation and source
- Fluent Bit, `tail` input (read from source): https://github.com/fluent/fluent-bit-docs/blob/master/pipeline/inputs/tail.md (rendered: https://docs.fluentbit.io/manual/pipeline/inputs/tail)
- Vector, `file` source: https://vector.dev/docs/reference/configuration/sources/file/
- Filebeat `filestream` input: https://www.elastic.co/docs/reference/beats/filebeat/filebeat-input-filestream (source: https://github.com/elastic/beats/blob/main/docs/reference/filebeat/filebeat-input-filestream.md)
- Filebeat file identity and growing fingerprint: https://github.com/elastic/beats/blob/main/docs/reference/filebeat/file-identity.md
- Filebeat, "Inode reuse causes Filebeat to skip lines": https://github.com/elastic/beats/blob/main/docs/reference/filebeat/inode-reuse-issue.md
- OpenTelemetry Collector `filelog` receiver: https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/receiver/filelogreceiver/README.md
- OpenTelemetry fingerprint matcher (`StartsWith`): https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/pkg/stanza/fileconsumer/internal/fingerprint/fingerprint.go
- Promtail log rotation guide (v3.5.0 docs): https://github.com/grafana/loki/blob/v3.5.0/docs/sources/send-data/promtail/logrotation/_index.md
- Promtail configuration, `positions` (v3.5.0): https://github.com/grafana/loki/blob/v3.5.0/docs/sources/send-data/promtail/configuration.md
- Promtail end-of-life notice: https://github.com/grafana/loki/blob/main/docs/sources/send-data/promtail/_index.md
- Grafana Alloy `loki.source.file`: https://github.com/grafana/alloy/blob/main/docs/sources/reference/components/loki/loki.source.file.md
- GNU `tail` manual page: https://man7.org/linux/man-pages/man1/tail.1.html

Operating-system and tooling references
- logrotate manual (`copytruncate`, `renamecopy`, `delaycompress`): https://github.com/logrotate/logrotate/blob/main/logrotate.8.in
- `statx(2)`: https://man7.org/linux/man-pages/man2/statx.2.html
- `inode(7)`: https://man7.org/linux/man-pages/man7/inode.7.html
- `open(2)` (`O_APPEND` and the NFS caveat): https://man7.org/linux/man-pages/man2/open.2.html
- `rename(2)`: https://man7.org/linux/man-pages/man2/rename.2.html
- Linux kernel overlayfs documentation (inode properties, `xino`): https://docs.kernel.org/filesystems/overlayfs.html
- SQLite atomic commit (background, not re-verified for this article): https://www.sqlite.org/atomiccommit.html
- SQLite conflict clauses, `INSERT OR IGNORE` (background, not re-verified): https://www.sqlite.org/lang_conflict.html

Measurements
- All "Measured" items: Linux 6.17.0-1021 (aarch64), ext4 root volume, tmpfs for the cross-filesystem and birth-time probes, Python 3.12.3, logrotate 3.21.0, GNU coreutils 9.4. Experiments were run in a throwaway scratch directory and cover identity behaviour, `statx` birth time, copytruncate under real logrotate, `tail` follow modes, commit-ordering crash tests, and the fault-injection harness described in section 8.
</content>
</invoke>
