---
date: "2026-11-01"
time: "09:05"
title: "Trust the Anchor, Not the Whole Path: Symlink-Aware Filesystem Boundaries for Agent Runtimes"
description: "A capability-based filesystem model that tolerates legitimate deployment links while preventing managed paths from escaping their ownership boundary."
tags:
  - research
  - security
  - filesystems
  - agents
  - sandboxing
---

## Executive Summary

An agent runtime should not decide whether a path is safe by asking whether its entire absolute pathname contains a symbolic link. Deployment environments routinely use symlinks, junctions, projected-volume links, and bind mounts. The useful security boundary is ownership: tolerate the environment's topology before the component-owned root, then anchor that root with an open directory handle and resolve every managed descendant relative to it.

This model avoids two common failures. Blanket symlink rejection breaks valid deployments, while `realpath()` or `lstat()` followed by a later pathname-based open creates a time-of-check/time-of-use (TOCTOU) gap. On Linux, a strict owned-tree policy can be expressed with directory file descriptors and `openat2()` resolution constraints. Other platforms need equivalent handle-relative operations or a deliberately weaker threat model.

## The Boundary Is Ownership, Not Text

Consider a runtime configured to keep component state at:

```text
/service/current/state/agents/a17/result.json
```

`/service/current` may be a release symlink managed by the host. The state directory may sit on a bind-mounted persistent volume. Those facts do not automatically make `result.json` unsafe. The runtime's real requirement is that, after it takes ownership of `state`, no untrusted name inside that tree can redirect an operation elsewhere.

A practical design separates three zones:

1. **Environment-owned prefix.** Configuration and the launcher choose the ancestors. Links and mounts may be legitimate here.
2. **Component-owned root and descendants.** The runtime acquires a stable directory descriptor or handle at this boundary. Managed operations are relative to that capability, and a strict policy can reject every descendant symlink or reparse point.
3. **External read-only inputs.** Some inputs intentionally use links as a version-switching protocol. Kubernetes projected volumes, for example, use visible symlinks and a `..data` link to publish atomic updates. These inputs need a separate, explicit read policy rather than inheriting the writable-state policy.

The distinction is important: “inside the configured string prefix” is not an ownership guarantee, and “contains a link somewhere” is not evidence of an escape.

## Why the Obvious Checks Fail

### Check, then reopen

A common sequence is:

```text
resolve or inspect path
verify it is inside the allowed directory
open the original path by name
```

The verification and the open are separate filesystem operations. A cooperating local process can replace an inspected parent directory with a symlink between them. The Go security team uses this exact pattern to explain why `EvalSymlinks` followed by `Open` is vulnerable, and the 2026 MCP filesystem-server advisory documents the same parent-directory swap in a real write path.

Kubernetes encountered the broader version of this problem in its `subPath` handling: validating a user-controlled path and then handing a pathname to the container runtime did not bind later use to the object that had been checked. Its fix moved toward descriptor-based traversal and bind-mounting the already resolved object.

### Reject links across the whole absolute path

Linux `openat2()` can reject symlinks in every component it resolves, but its manual explicitly warns that indiscriminate use can break systems when an ordinary system path gains a symlink. Applied to the full configured pathname, the policy also treats environment-owned release links as though they were attacker-controlled descendants.

The safer rule is narrower: establish the trusted anchor first, then apply strict resolution to relative names below that anchor.

### Rely on `O_NOFOLLOW` alone

`O_NOFOLLOW` protects only the final pathname component. An intermediate directory can still be a symlink. A fallback implementation therefore has to walk one component at a time, opening each directory relative to the descriptor from the previous step and retaining the resulting descriptors until the operation finishes.

## A Linux Contract for a Strict Owned Tree

The following is a target contract, not a description of what every standard library already guarantees:

1. A trusted launcher or configuration source identifies the environment-owned parent. Passing an already-open parent directory descriptor is stronger than passing an absolute string.
2. Open or create the component root relative to that parent with no-follow semantics. Validate the opened object with `fstat()`; do not infer its type from the pathname.
3. Keep the root descriptor for the component's lifetime. Do not convert it back into a pathname as the authority for later operations.
4. Accept only relative managed names. Reject absolute inputs and parent traversal before invoking the filesystem operation.
5. On Linux 5.6 and later, resolve descendants with `openat2(rootfd, relative, ...)` using `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS`. Add explicit regular-file or directory checks for the expected object type.
6. Without `openat2()`, walk each component with descriptor-relative `openat()` calls and `O_NOFOLLOW`, checking every opened object. This is more code and needs platform-specific review.

`RESOLVE_NO_XDEV` is a separate decision. It blocks mount-point traversal, including bind mounts, so it should not be smuggled into a no-symlink policy. Likewise, symlink controls do not by themselves reject hard links, device nodes, FIFOs, sockets, or another trusted writer replacing a regular file. Each belongs to a separate threat-model decision.

The core property is simple: after the anchor is acquired, the kernel resolves the operation relative to the anchored directory object. A rename of an ancestor changes a name, not the object represented by the open descriptor.

## Portable Runtime Choices

### Go

Go 1.24 introduced `os.Root`, whose methods operate on relative names and prevent traversal outside the root. It is a good containment abstraction, but it is not the same as a zero-symlink tree: links that remain inside the root are allowed, and bind mounts are not blocked. A runtime requiring “no links anywhere in managed state” must add that stricter contract rather than equating containment with link rejection.

Recent Go advisories also show why edge cases deserve explicit tests. One Unix flaw followed an escaping final symlink when the name ended in `/`; a Windows flaw allowed certain operations through a final junction. A high-level API reduces risk, but trailing separators, final components, and reparse points remain security-relevant regression cases.

### Python and native helpers

On Unix, Python exposes `dir_fd` variants for many `os` operations plus low-level open flags, so a descriptor-walking backend is possible. It is not automatically portable to Windows; a Windows implementation needs handle-relative rules and explicit reparse-point treatment.

For runtimes whose public filesystem API only reopens string paths, a native helper or a small privileged broker can own the descriptor-relative operation. Node.js is a relevant example: its documented `fs.open()` surface accepts a path, and the Go implementation notes that its JavaScript target cannot provide the same race resistance because the Node filesystem API lacks the `openat` family. Process isolation can also remove the hostile-co-writer assumption, but that is a change in threat model, not a pathname-validation technique.

## What Real Systems Teach

Three cases expose different parts of the model:

- **Kubernetes `subPath`:** a checked pathname was not enough when a later actor reopened it. Binding use to an already opened object closed the gap.
- **Kubernetes projected volumes:** the `AtomicWriter` design intentionally creates user-visible symlinks and switches a `..data` link atomically. Blanket rejection would break a supported read-only delivery protocol.
- **MCP filesystem server:** one advisory covered symlink escape inside allowed roots; a later advisory covered a parent-directory TOCTOU during file creation. Containment checks must cover both static topology and concurrent replacement.

Together they argue against a universal “allow links” or “deny links” switch. The policy should follow who controls each zone and whether the operation reads external input or mutates owned state.

## Acceptance Tests That Can Falsify the Design

A strict component-owned tree should demonstrate both compatibility and rejection.

Expected to succeed:

- a legitimate symlink in an ancestor before the ownership boundary;
- an owned root located on an approved bind mount, if mount crossing is allowed;
- ordinary directories and regular files below the root;
- continued descriptor-relative access to the same directory object after an ancestor rename.

Expected to fail:

- the owned root entry itself is a symlink;
- an intermediate or final managed component is a symlink, even when it points back inside the root;
- an absolute input or `..` escape;
- a final escaping symlink followed by a trailing slash;
- a Windows junction or other reparse-point escape;
- a device, FIFO, or socket where the contract requires a regular file;
- a concurrent parent-directory swap that attempts to redirect a write outside the root.

Mount crossing and hard links need their own tests because no-symlink resolution does not decide either policy. The test suite should also include a known-bad concurrent swap so a passing result proves that the detector can actually observe the failure mode.

## Limits of the Model

An anchored directory capability controls pathname resolution; it does not make every writer trustworthy. If another process already has write access to the same directory, it may still replace file contents or names within the permitted tree. Permissions, process isolation, ownership, and write protocols remain necessary.

The model also does not prescribe one policy for read-only external trees. Following a link that stays within a declared input root may be correct, while following any link in mutable private state may violate the component's integrity contract. Document those as separate interfaces so a compatibility exception cannot silently weaken the writable boundary.

## Primary Sources

- [Linux `openat2(2)` manual](https://man7.org/linux/man-pages/man2/openat2.2.html)
- [Linux `open(2)` manual](https://man7.org/linux/man-pages/man2/open.2.html)
- [Go: Traversal-resistant file APIs](https://go.dev/blog/osroot)
- [Go vulnerability GO-2026-4970: trailing-slash symlink escape](https://pkg.go.dev/vuln/GO-2026-4970)
- [Go vulnerability GO-2026-6604: Windows junction escape](https://pkg.go.dev/vuln/GO-2026-6604)
- [Kubernetes: Fixing the Subpath Volume Vulnerability](https://kubernetes.io/blog/2018/04/04/fixing-subpath-volume-vulnerability/)
- [Kubernetes `AtomicWriter` source](https://github.com/kubernetes/kubernetes/blob/master/pkg/volume/util/atomic_writer.go)
- [MCP filesystem-server symlink advisory](https://github.com/modelcontextprotocol/servers/security/advisories/GHSA-q66q-fx2p-7w4m)
- [MCP filesystem-server parent-directory TOCTOU advisory](https://github.com/modelcontextprotocol/servers/security/advisories/GHSA-53mr-w429-c597)
- [Python `os` documentation](https://docs.python.org/3/library/os.html)
- [Node.js filesystem documentation](https://nodejs.org/api/fs.html)
