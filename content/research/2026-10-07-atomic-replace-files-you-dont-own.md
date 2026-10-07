---
date: "2026-10-07"
time: "09:30"
title: "Replacing a File You Don't Own: Atomic Writes That Keep Symlinks, Permissions and Ownership"
description: "A code-review finding in Zylos's config writer — truncate-then-write instead of write-then-rename — turns into a survey of what POSIX rename() actually guarantees, what it silently breaks, and a checklist for agents that edit other programs' config files."
tags: ["ai-agents", "filesystem", "reliability", "configuration", "posix"]
---

## Executive Summary

Zylos needs to persist permission defaults into a coding-agent CLI's per-project `config.toml` — a file Zylos does not own and whose other keys and formatting it must not disturb. A code review caught the original implementation doing the simplest possible thing: open the path, truncate it, write the new bytes. That is not atomic. A crash, an OOM-kill, or a concurrent reader landing mid-write sees a zero-length or half-written TOML file, and the next CLI startup either loses its config or fails to parse it.

The standard fix is write-temp-then-rename, used by git, Vim, npm, and most serious config writers: write new content to a temp file in the same directory, then atomically rename it over the target. POSIX `rename()` guarantees that swap is atomic with respect to any other process — readers see fully-old or fully-new, never partial. But "atomic" only covers the directory-entry swap. Everything else about the old file — that it might be a symlink, that its mode was `0644` under a restrictive umask, that it belonged to a specific uid/gid, that something held a lock or an inotify watch on it — is *not* carried over by a naive rename. Replacing a file you don't own means explicitly re-deriving all of that state before committing the swap.

Zylos's fix does five things beyond "write temp, rename over target":

1. `lstat` the target first. If it's a symlink, resolve with `realpath` and write the temp file in the **target's** directory, then rename onto the resolved path — the symlink itself is never replaced.
2. Create the temp file with an exclusive, randomly-named open (`O_CREAT|O_EXCL`, Node's `'wx'` flag), so concurrent writers can't collide.
3. `fchmod` the temp file to the **existing** file's mode before writing content, so a `0644` file doesn't silently become `0600` under a restrictive umask. New files get an explicit `0600`.
4. `fsync` the temp file, close it, then `rename()`. On error, unlink only the temp file this call created — never touch the original.
5. A dangling symlink is an explicit error, not a target to create. Following it and writing a new file would silently turn a broken link into a real file.

The gap left open: `rename()` cannot preserve the replaced file's uid/gid — that's not a Zylos oversight, it's what the syscall is. If the CLI runs as a different user than the agent, the new file inherits the writer's ownership, and a `0600` file becomes unreadable to whoever needs it. Zylos accepts this under a documented "same user" assumption rather than reaching for `chown`, which needs privileges the writer may not have and introduces its own race.

## What POSIX `rename()` Actually Promises

The Linux `rename(2)` man page: "If newpath already exists, it will be atomically replaced, so that there is no point at which another process attempting to access newpath will find it missing" ([man7.org](https://man7.org/linux/man-pages/man2/rename.2.html)). That's the whole contract — the directory-entry swap is indivisible. It says nothing about the new data being durable yet (a separate fsync concern) and nothing about any attribute of the old file carrying over.

Two structural requirements follow:

**Same filesystem, or `EXDEV`.** `rename()` only works within one mounted filesystem; crossing filesystems (including bind mounts of the same filesystem) fails with `EXDEV`, because a cross-filesystem move can't be a single atomic metadata operation. This is why the temp file must live in the **same directory as the target**: `/tmp` is often a different filesystem (frequently `tmpfs`) than `/etc` or wherever the real config lives, and a temp-in-/tmp pattern will intermittently throw `EXDEV` — and helpers that "handle" that by falling back to copy+unlink (as `mv` does) quietly reintroduce non-atomicity.

**Symlinks are followed for lookup, not for replacement.** Per the man page: "If oldpath refers to a symbolic link, the link is renamed; if newpath refers to a symbolic link, the link will be overwritten." `rename(tmp, newpath)` replaces whatever entry sits *at* `newpath`, even a symlink — it does not resolve the link and replace the file at the far end. This is exactly what Zylos works around: resolve with `realpath()` first, then rename onto the resolved path.

Linux's `renameat2()` adds `RENAME_NOREPLACE` (fail instead of clobbering; added for ext4 in 3.15, btrfs/shmem/cifs in 3.17, xfs in 4.0) and `RENAME_EXCHANGE` (atomically swap two existing paths, possibly of different types) ([LWN](https://lwn.net/Articles/592952/)). Both are Linux-only and not part of POSIX.

## Atomicity Is Not Durability: fsync and the ext4 Saga

Atomic and durable are different properties. `rename()` atomically swaps a directory entry; it says nothing about whether the new content, or the rename itself, has reached stable storage. Two fsyncs matter: **fsync the file before renaming** (otherwise dirty pages for the temp file may still be in memory when the crash hits), and **fsync the containing directory after renaming** (the rename changes the directory's own on-disk name-to-inode mapping, a separate write from the file's contents; without fsyncing the directory, a crash can roll that mapping back to the old inode even though the new file's data was durable). The safe order: write temp → fsync(temp) → rename → fsync(directory).

This isn't theoretical — it's the center of the 2009 ext4 controversy. ext3's default `data=ordered` mode happened to mask a class of application bugs, because it always flushed data blocks before a journal commit. ext4's delayed allocation broke that: it could journal a rename's metadata before the new file's data blocks existed, so a crash in between left a zero-length file. As Ted Ts'o put it, "metadata changes can be journalled without writing out the blocks. So in case of a crash, the metadata changes ... get replayed, but the data changes don't" ([LWN](https://lwn.net/Articles/322823/); [Ts'o's blog](https://thunk.org/tytso/blog/2009/03/12/delayed-allocation-and-the-zero-length-file-problem/)). The fix that mattered most for this idiom was `auto_da_alloc`: it detects the replace-via-rename pattern and forces delayed blocks to be written before the rename's journal commit, in `data=ordered` mode. See also the broader LWN series ([323199](https://lwn.net/Articles/323199/), [326524](https://lwn.net/Articles/326524/), [387635](https://lwn.net/Articles/387635/)). The lesson survives the debate either way: never assume a filesystem will make your rename safe without an explicit fsync.

## What Popular Tools Do

**Python** moved from the now-deprecated `atomicwrites` library to the idiomatic `tempfile` + `os.replace()` pattern — the maintainer's own deprecation notice points users at stdlib `os.replace`/`os.rename` directly ([GitHub](https://github.com/untitaker/python-atomicwrites); [discussion](https://news.ycombinator.com/item?id=32026624)).

**Go's `google/renameio`** creates its pending temp file at mode `0600` by default; v2 adds `WithPermissions(perm)` and `WithExistingPermissions()` options, the latter being the same "inherit the old file's mode" rule discussed below. Its `Symlink` helper replaces an existing symlink atomically (plain `os.Symlink` fails if the destination exists), but the docs are explicit that this replaces the **symlink itself**, "which is rarely the caller's intent" ([pkg.go.dev](https://pkg.go.dev/github.com/google/renameio/v2)). The library also documents that it isn't reliable on NFS with multiple clients, and doesn't support Windows; an open issue tracks adopting `O_TMPFILE` as a cleaner primitive ([renameio#39](https://github.com/google/renameio/issues/39)).

**npm's `write-file-atomic`** is the closest prior art to Zylos's fix: unless `mode`/`chown` are explicitly passed, it defaults to the existing file's permissions and owner ([npm](https://www.npmjs.com/package/write-file-atomic)) — the same "inherit the old file's mode" idea Zylos implements with `fchmod`. Its `chown` default is the more ambitious attempt at the ownership problem flagged below; it only works when the writer actually has permission to `chown` to that uid, typically root.

**Rust's `tempfile::NamedTempFile::persist`** performs an atomic rename on Unix (best-available mechanism on Windows), but its docs flag what it doesn't do: "Neither the file contents nor the containing directory are synchronized, so the update may not yet have reached the disk when persist returns" ([docs.rs](https://docs.rs/tempfile/latest/tempfile/struct.NamedTempFile.html)) — fsync is entirely the caller's job.

**Vim's `backupcopy`** names this article's exact tradeoff. `backupcopy=no` renames the original aside and writes a new file in its place — fast, but breaks hard links and symlink targets. `backupcopy=yes` copies content into the original inode in place — preserves links and ownership, at the cost of a non-atomic in-place write. Vim's actual default, `auto`, splits the difference: it uses the rename path "when Vim sees that renaming the file is possible without side effects (the attributes can be passed on and the file is not a link)," and falls back to a copy otherwise — the same lstat-first decision Zylos's fix makes, generalized to an editor's save path.

**Git's lockfile API** creates `<file>.lock` with `O_CREAT|O_EXCL` (so a second writer fails loudly instead of racing), writes new content into it, then renames it onto the real path: "readers are guaranteed to see either the old contents of the file or the new contents (assuming the filesystem implements rename() atomically)" ([git-scm.com](https://git-scm.com/docs/api-lockfile)).

**chezmoi** treats symlinks as first-class manageable targets, but its default strategy regenerates a tracked dotfile as a regular file rather than symlinking to a shared store, specifically to support features symlinks can't carry (encryption, templating, executable bits) ([chezmoi.io](https://www.chezmoi.io/user-guide/manage-different-types-of-file/)). Dotfile managers built around symlinks inherit the symlink-preservation problem whenever an external tool updates the symlinked path without knowing it's a link.

## What Rename-Replace Breaks

- **Symlinks.** `rename(tmp, path)` replaces whatever is *at* `path`; a symlink there is replaced by a regular file, orphaning whatever it pointed to. Fix: `lstat`, resolve, rename onto the resolved target.
- **Hard links.** Other names for the same inode aren't updated by a rename — they keep pointing at the old content. This is exactly why `backupcopy=auto` avoids the fast path for multiply-linked files.
- **Ownership (uid/gid).** The new inode belongs to whoever created the temp file, not whoever owned the file being replaced. `rename()` has no mechanism to carry ownership; a separate, privileged `chown()` is needed and often unavailable to an unprivileged writer.
- **ACLs, xattrs, security labels.** POSIX ACLs, xattrs (macOS Finder metadata, SELinux's `security.selinux`) live on the inode. A fresh temp file starts with none of them unless explicitly recreated.
- **inotify/fanotify watches.** A watch on the file's inode doesn't follow the rename — it's left watching an orphaned inode and typically stops producing events. A watch on the directory does see the new entry, which is why config-reload tooling usually watches the directory.
- **Advisory locks** (`flock`/`fcntl`) attach to the inode. A lock-holder keeps its lock on the now-orphaned old inode; a new opener gets the new, unlocked one.
- **Windows** maps `rename()`/`os.replace()` to `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`, which can fail with `ERROR_ACCESS_DENIED` or a sharing violation if any other handle has the destination open without `FILE_SHARE_DELETE`. `ReplaceFileW` exists for exactly this: it preserves creation time, short name, object ID, DACLs, security attributes, encryption and compression from the replaced file — none of which a bare rename carries over — and requires both files on the same volume ([Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew)).
- **macOS** has the same rename-replaces-the-link semantics as Linux, plus `renamex_np()` with `RENAME_SWAP` (the modern replacement for deprecated `exchangedata()`) for atomically exchanging two existing paths.

## Alternatives

- **Copy-in-place** (`backupcopy=yes`-style): preserves inode identity, hard links, ownership, ACLs — at the cost of not being atomic.
- **`O_TMPFILE` + `linkat`** (Linux ≥ 3.11): open an anonymous, nameless file in the target directory, write and `fchmod`/`fsetxattr` it while invisible, then `linkat` it into place. If the process dies first, the kernel reclaims it automatically — no orphaned temp files ever exist ([LWN](https://lwn.net/Articles/619146/)). Still doesn't solve symlink or ownership preservation on its own.
- **`renameat2(RENAME_EXCHANGE)`** atomically swaps two *existing* paths — useful for staged/current swaps, not for "write a config that may not exist yet."
- **Advisory locks around the whole read-modify-write** address concurrent writers stepping on each other, which rename-based atomicity alone doesn't prevent (two writers can each successfully write-temp-and-rename; the second simply wins silently).

## Decision Table

| Property | Truncate+write | write-temp + rename | + symlink/mode-aware (Zylos) | `O_TMPFILE`+`linkat` | Copy-in-place |
|---|---|---|---|---|---|
| Atomic to readers | No | Yes (same fs) | Yes | Yes | No |
| Survives crash mid-write | No | Only with fsync(file+dir) | Only with fsync(file+dir) | Only with fsync(file+dir) | No |
| Preserves symlink at target | N/A | No | Yes | No | Yes |
| Preserves hard links | Yes | No | No | No | Yes |
| Preserves mode under restrictive umask | Yes | No | Yes (explicit fchmod) | Yes (explicit fchmod) | Yes |
| Preserves uid/gid | Yes | No | No (documented gap) | No | Yes |
| Preserves ACLs/xattrs/labels | Yes | No | No | No | Yes |
| No leftover temp files on crash | N/A | Possible leak | Explicit cleanup | Automatic reclaim | N/A |
| Portable | Yes | Yes (`ReplaceFile` on Windows) | Yes | Linux-only | Yes |

## Checklist for Agent Tooling That Edits Configs It Doesn't Own

1. `lstat` the target before anything else — not `stat`, which follows symlinks.
2. If it's a symlink, resolve with `realpath` and redirect to the resolved path's directory. A dangling link is a hard failure, not an invitation to materialize a file.
3. Create the temp file in the same directory as the resolved target, exclusive and randomly named.
4. Set the mode before writing content: `fchmod` to the existing file's mode, or `0600` for new files — never rely on the ambient umask.
5. `fsync` the temp file, `close()`, then `rename()`.
6. `fsync` the containing directory afterward if you need crash-immediately-after-write durability.
7. On failure, unlink only the temp file you created; never touch the original.
8. Document what you don't handle — cross-user ownership, ACLs, xattrs — rather than let it surface as a confusing permission error later.

## A Minimal Node.js Implementation

```js
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

async function replaceOwnedFile(targetPath, content) {
  let writeDir = path.dirname(targetPath);
  let writeTarget = targetPath;
  let existingMode = 0o600;
  let fileExisted = false;

  try {
    const linkStat = await fs.lstat(targetPath);
    if (linkStat.isSymbolicLink()) {
      try {
        writeTarget = await fs.realpath(targetPath); // dangling link -> throws
      } catch {
        throw new Error(`refusing to replace a dangling symlink: ${targetPath}`);
      }
      writeDir = path.dirname(writeTarget);
    }
    const targetStat = await fs.stat(writeTarget);
    existingMode = targetStat.mode & 0o777;
    fileExisted = true;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  const tmpName = path.join(
    writeDir,
    `.${path.basename(writeTarget)}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );

  const fh = await fs.open(tmpName, 'wx'); // O_CREAT|O_EXCL — this call owns tmpName
  try {
    try {
      await fh.chmod(fileExisted ? existingMode : 0o600);
      await fh.writeFile(content);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmpName, writeTarget);
  } catch (e) {
    await fs.unlink(tmpName).catch(() => {}); // only the temp file we created
    throw e;
  }

  const dirFh = await fs.open(writeDir, 'r');
  try { await dirFh.sync(); } finally { await dirFh.close(); }
}
```

This follows the shape of Zylos's fix: `lstat` first, resolve and redirect for symlinks, dangling links rejected, exclusive randomly-named temp file, `fchmod` before content, `fsync` before close, `rename`, and cleanup of only the owned temp file on any failure (write, fsync or rename). The trailing directory fsync is an addition for crash-immediately-after-write durability; drop it if that guarantee isn't needed. It deliberately does not attempt `chown` — that's the documented residual gap.

## Testing Each Property

Each row in the decision table is independently testable:

- **New file is `0600`** regardless of umask (e.g. under `umask 022`) — proves the mode comes from the explicit `fchmod`, not the umask. Negative control: remove the `fchmod` call in a throwaway build and confirm the test fails.
- **Existing `0644` file stays `0644`** under a restrictive `umask 0077` — this is the test that would have caught the original bug. A naive write-temp+rename *without* the explicit `fchmod` creates the temp at whatever the umask allows, silently downgrading the file; this test should fail against that half-fixed implementation too.
- **Symlink and target mode preserved**: symlink `config.toml -> real-config.toml`, run the replace, assert `config.toml` is still a symlink pointing at `real-config.toml`, and `real-config.toml` has the new content at the expected mode.
- **No leftover temp files**: list the directory before/after a run, including one where `fsync` is stubbed to throw mid-write; assert nothing matching the temp-name pattern remains.
- **Dangling link errors, link untouched**: symlink `config.toml -> does-not-exist`, assert the replace throws rather than creating `does-not-exist`, and assert the link is unchanged afterward.
- **Read-only directory yields `EACCES`, original unchanged**: `chmod 0555` the directory, attempt a replace on an existing file, assert `EACCES` and that the original bytes/mtime are untouched.
- **Crash injection**: stub the rename step to throw right after fsync returns, and verify the old file is intact — the fsync-then-rename ordering means there's no window where neither is valid. A full power-loss test needs VM- or block-device-level fault injection, usually reserved for integration testing on high-value configs.
- **Negative controls matter as much as assertions**: run the symlink test against a build with the lstat/resolve logic disabled and confirm it fails — otherwise a test that always passes isn't testing anything.

## Open Question: Cross-User Ownership

`rename()` cannot carry a uid/gid across the swap — the new inode belongs to whoever created it. `write-file-atomic` papers over this by `fchown`-ing the temp file to the existing owner before renaming, which only works when the writer has the privilege to `chown` to that uid (root, typically). An unprivileged agent replacing a file owned by a different, less-privileged user has no such option. Zylos documents a same-user assumption instead: the agent and the CLI it configures are expected to run as the same OS user. If that assumption breaks — a sandboxed agent writing into a config consumed by a system service, say — the right fix is either running the writer with the target's privileges, or having the consuming process re-apply ownership after each external write, rather than forcing a `chown` the writer was never entitled to make.

## References

- `rename(2)` — Linux man-pages: atomicity, `EXDEV`, symlink-replacement semantics — https://man7.org/linux/man-pages/man2/rename.2.html
- `renameat2(2)` / `RENAME_NOREPLACE` / `RENAME_EXCHANGE` — LWN — https://lwn.net/Articles/592952/
- "ext4 and data loss" — LWN, 2009 — https://lwn.net/Articles/322823/
- "Delayed allocation and the zero-length file problem" — LWN, 2009 — https://lwn.net/Articles/323199/
- "Ext4 breaking the promise of data=ordered?" — LWN — https://lwn.net/Articles/326524/
- "ext4 and data consistency" — LWN — https://lwn.net/Articles/387635/
- Theodore Ts'o, "Delayed allocation and the zero-length file problem" — https://thunk.org/tytso/blog/2009/03/12/delayed-allocation-and-the-zero-length-file-problem/
- "open() flags: O_TMPFILE and O_BENEATH" — LWN — https://lwn.net/Articles/619146/
- Python `atomicwrites` deprecation notice — https://github.com/untitaker/python-atomicwrites and discussion — https://news.ycombinator.com/item?id=32026624
- `google/renameio` v2 — permission options, symlink behavior, NFS and Windows caveats — https://pkg.go.dev/github.com/google/renameio/v2
- `google/renameio` issue on adopting `O_TMPFILE` — https://github.com/google/renameio/issues/39
- `write-file-atomic` (npm) — mode/chown defaults — https://www.npmjs.com/package/write-file-atomic
- Rust `tempfile::NamedTempFile::persist` — https://docs.rs/tempfile/latest/tempfile/struct.NamedTempFile.html
- Git lockfile API — `.lock` + rename, reader guarantees — https://git-scm.com/docs/api-lockfile
- chezmoi — symlinks as first-class targets, default regular-file strategy — https://www.chezmoi.io/user-guide/manage-different-types-of-file/
- Microsoft Learn — `ReplaceFileW`: attribute/ACL preservation, same-volume requirement, error codes — https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew
- macOS/BSD `rename(2)` manual page (symlink semantics; `renamex_np`/`RENAME_SWAP` context) — https://man.freebsd.org/cgi/man.cgi?query=rename&sektion=2&manpath=macOS+10.13.6
