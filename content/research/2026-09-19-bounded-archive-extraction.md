---
date: "2026-09-19"
title: "Untrusted Archives in Agent Tools: Bound the Namespace, Work, and Publication"
description: "Why path filters alone do not make archive ingestion safe, with local TAR and ZIP experiments and a staged publication design."
tags:
  - research
  - agents
  - security
  - archives
---

## Executive Summary

An agent asked to summarize an uploaded archive needs documents, not the authority to recreate an arbitrary filesystem. Treat extraction as a constrained import with three separate decisions: which names and object types may exist, how much work may be performed, and when the result becomes available to the agent.

Seven small Linux experiments showed why these decisions matter. A TAR path filter rejected traversal but left earlier files behind; duplicate TAR members overwrote earlier content; an internal symlink remained permitted; and two distinct ZIP names collapsed onto the same output path. A stricter demonstration rejected links and duplicates and stopped writes at a byte budget, but still left a partial staging directory.

The design proposed here is for document ingestion, not a drop-in replacement for a software installer or backup restorer. It is research guidance, not a claim that Zylos currently implements this pipeline.

## A Filter Is Not an Import Transaction

Python introduced TAR extraction filters in 3.12 and made `data` the default in 3.14. Filters may also appear in older maintained releases through backports: check `hasattr(tarfile, "data_filter")`, use `filter="data"` explicitly, and fail closed when the required feature is absent. Feature presence does not replace keeping the runtime patched. The `data` filter restricts paths, link targets, special files, and selected metadata; it does not ban every link or provide denial-of-service protection. [Python tarfile documentation](https://docs.python.org/3/library/tarfile.html#extraction-filters).

There is a reason to check members during extraction: a previous member can change how a later path resolves. An up-front listing is useful for policy checks but cannot replace enforcement at the actual write. Extraction errors also do not roll back successful earlier writes. These are central constraints in the filter design, not evidence that a rejection failed. [PEP 706](https://peps.python.org/pep-0706/).

For an agent pipeline, the problematic sequence is:

1. The extractor writes `report.txt` to a watched directory.
2. An indexer ingests it or a tool returns its path.
3. A later archive member is rejected.
4. The tool reports failure, but the document has already influenced downstream work.

Returning an error is too late to restore that boundary. Keep the workspace private until the whole import passes.

## Name Policy Must Match the Written Namespace

For a document-only importer, a deliberately small policy is easier to reason about:

- Accept regular files and ordinary directories; reject symlinks, hardlinks, devices, FIFOs, and unsupported sparse representations.
- Reject absolute paths, traversal components, foreign separators, control characters, and excessive depth or name length. Prefer rejection to silently repairing an unexpected name.
- Track the actual destination key. Reject duplicate files, file/directory conflicts, and aliases under the destination's case and Unicode rules. Account for implicit parent directories as well as explicit members.
- Create files exclusively and assign application-owned permissions. Do not restore ownership or executable metadata from the archive.

These are proposed application restrictions, not promises made by every archive library. They intentionally reject some legitimate archives. If preserving links is a product requirement, it needs a different policy and evidence.

ZIP illustrates why “the library sanitizes paths” is insufficient. Python's `extract()` and `extractall()` sanitize names, whereas `zipfile.Path` does not. In the local fixture, `same.txt` and `../same.txt` both became `same.txt`; the second member replaced the first. Validate the destination mapping, not just uniqueness of raw member names. A caller copying entries obtained through `zipfile.Path` owns its path checks. [Python zipfile documentation](https://docs.python.org/3/library/zipfile.html#path-objects).

A private temporary directory removes pre-existing workspace objects from the normal path. It does not isolate an extractor from a hostile process sharing its operating-system identity. A lexical path check followed by an ordinary open is not a race-proof boundary. Use a separate security boundary when concurrent hostile writers are in scope; do not claim a containment guarantee from string validation alone.

## Bound the Work Before Trusting the Result

Declared sizes support early rejection. Count actual output bytes as well, before writing each chunk, and enforce both per-file and total limits. Also bound member count and namespace complexity. A compressed-input limit or a compression-ratio threshold alone does not bound extraction CPU or memory.

There is another gap before the application's per-member loop: metadata parsing. In CPython 3.12.3, `_proc_pax()` reads an extended header payload while preparing a member. A callback that only sees the completed member cannot retroactively limit that allocation. A streamed archive API therefore does not, by itself, establish a bounded parser. [CPython 3.12.3 implementation](https://github.com/python/cpython/blob/v3.12.3/Lib/tarfile.py).

Count decompressed stream bytes as well as file output: metadata consumes the former without appearing in the latter. Place that counter between the decompressor and archive parser, and retain external memory limits because a decompressor can allocate before returning a chunk.

The proposed import worker should start inside its resource boundary **before opening or inspecting the archive**. Give it a wall-clock deadline, CPU and memory ceilings, a dedicated storage quota, and restricted filesystem access. If it terminates or exceeds a limit, no result is published. The application counters explain ordinary policy failures; the external limits contain work the parser performs before those counters run. These controls require deployment-specific validation and were not exercised by the small experiments below.

Do not automatically recurse into embedded archives. If recursive import is a requirement, share one budget across the entire tree, including nesting depth; a fresh budget per child permits multiplication.

## Completion Needs an Explicit Integrity Check

An exception-free extraction is not necessarily a complete-stream check. In an additional local fixture, a TAR read through `gzip.GzipFile` extracted its file successfully despite a corrupted gzip CRC trailer. Draining the remaining decompressed stream then raised `BadGzipFile`; the valid control passed both steps. The archive parser had stopped before the compression trailer was checked.

Define what completion means for each accepted format: reject malformed or missing required termination records, enforce the trailing-data policy, and finish compression integrity checks under the same byte and time budgets. A manifest derived only from the members the parser returned cannot prove that it saw everything the sender intended; use a trusted expected manifest when that guarantee matters. The local CRC fixture demonstrates one gap, not a complete archive validator. [Python gzip documentation](https://docs.python.org/3/library/gzip.html).

## Publish One Complete Result

A useful proposed lifecycle is `staging → validated → published`, with a failed staging job never visible to readers:

1. Allocate a fresh job directory in a parent only the importer can write. Keep it outside indexing and serving roots.
2. Extract under the namespace and resource policy. Require the format-specific completion and integrity checks above. Treat parser errors, rejected members, and limit breaches as failure of the entire import; do not turn them into a successful partial result.
3. Ensure the worker has exited and no surviving writer can mutate staging, then check the expected manifest and content policy. Successful extraction does not authorize executing scripts or obeying instructions embedded in documents.
4. Let a trusted coordinator publish to a fresh destination only after worker success. Serialize name allocation or use a no-replace primitive; a prior `exists()` check does not reserve a name.
5. Return the published identifier only after publication succeeds. On failure, retain or remove staging according to a bounded cleanup policy. On restart, reconcile abandoned jobs without advertising them as completed imports.

A same-filesystem directory rename can provide an atomic namespace transition, but it cannot make a cross-filesystem move atomic or guarantee crash durability. Linux `renameat2(RENAME_NOREPLACE)` adds a no-replacement option where supported. Plain rename behavior depends on the existing target; do not treat it as a universal “publish if absent” operation. Durability, if required, needs a separately tested synchronization protocol. [Linux rename documentation](https://man7.org/linux/man-pages/man2/rename.2.html).

## What the Local Experiments Established

The experiments ran on Linux with Python **3.12.3**, Ubuntu package **3.12.3-1ubuntu0.13**, using explicit filter arguments and disposable directories. This identifies the tested build, including distribution backports; the version string alone does not establish identical behavior elsewhere, and it is not a recommended production patch level. All attempted traversal stayed inside a disposable test parent. No external archive was downloaded or executed.

| Fixture | Observed result |
| --- | --- |
| `fully_trusted`, member `../escape.txt` | Wrote a sibling fixture file: the known-bad control could trigger the detector |
| `data`, ordinary file followed by traversal | Raised `OutsideDestinationError`; the ordinary file remained |
| Two TAR members named `same.txt` | `data` retained the later content; duplicate-rejecting demonstration stopped |
| Regular file plus internal symlink | `data` created the symlink; regular-file-only demonstration rejected it |
| Ordinary five-byte file | Narrow demonstration accepted it: the valid control remained usable |
| 8 KiB file, actual-write budget 4 KiB | Demonstration stopped at 4 KiB; partial staging still existed |
| ZIP names `same.txt` and `../same.txt` | Both mapped to one extracted file; later content won |
| Valid/corrupt gzip CRC around the same TAR | Both extracted through `GzipFile` + `r\|`; draining rejected only the corrupt stream |

These tests establish specific library behavior and application-counter behavior. They do not establish resistance to decompressor bugs, metadata exhaustion, concurrent filesystem mutation, Windows path aliases, or power loss.

Here is a minimal reproduction of two results. It uses only the Python standard library and cleans up its own fixture directory:

```python
import io
import tarfile
import tempfile
from pathlib import Path

def pack(rows):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        for name, data in rows:
            member = tarfile.TarInfo(name)
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
    return buffer.getvalue()

with tempfile.TemporaryDirectory() as scratch:
    root = Path(scratch)
    target = root / "partial"
    target.mkdir()
    raw = pack([("ok.txt", b"ok"), ("../escape.txt", b"bad")])
    try:
        with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
            archive.extractall(target, filter="data")
    except tarfile.OutsideDestinationError:
        pass
    else:
        raise AssertionError("traversal was not rejected")
    assert (target / "ok.txt").read_bytes() == b"ok"
    assert not (root / "escape.txt").exists()

    target = root / "duplicates"
    target.mkdir()
    raw = pack([("same.txt", b"first"), ("same.txt", b"last")])
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        archive.extractall(target, filter="data")
    assert (target / "same.txt").read_bytes() == b"last"
    print("PASS: rejection leaves partial output; duplicates overwrite")
```

For agent-tool builders, the useful acceptance test is broader than “did traversal fail?” Ask whether a rejected import produced any published identifier, indexed content, overwritten destination, or unbounded resource consumption. Namespace filtering, bounded execution, and publication each need evidence of their own.
