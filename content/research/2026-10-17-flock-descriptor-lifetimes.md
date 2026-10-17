---
date: "2026-10-17"
time: "09:00"
title: "Who Still Holds the Lock? File Descriptors, Subprocesses, and Stable Lock Files"
description: "Reproducible Linux experiments show why closing a parent descriptor, unlocking through a child, and recreating a lock file have different concurrency consequences."
tags: ["research", "linux", "concurrency", "subprocesses", "testing"]
---

## Executive Summary

A local file lock can outlive the process that first acquired it, and a child can also release that lock while the parent still has its descriptor open. Linux `flock()` associates ownership with an **open file description**, shared by inherited or duplicated descriptors. Reliable coordination therefore requires an explicit descriptor-lifetime policy and a stable lock file; checking a PID or deleting an apparently stale file cannot substitute for either.

## One test slot, two surprising failures

Imagine several test runners sharing one expensive local fixture. Each runner acquires `slot.lock`, launches a helper, and promises that only one test will touch the fixture at a time. This is a generic example, not a claim about a particular runner.

Two failures look contradictory. First, the runner exits but the next test remains blocked because a helper inherited the locked descriptor. Second, a helper explicitly unlocks its inherited descriptor and a competing test enters while the runner is still alive. Both follow from the same ownership rule.

This article studies cooperative Linux `flock()` on a local filesystem. It does not establish behavior for every filesystem, Windows, traditional POSIX record locks, or a distributed lease. Linux documents different NFS/SMB behavior, including cases where locks interact with I/O rather than remaining merely advisory. [Linux flock(2)](https://man7.org/linux/man-pages/man2/flock.2.html)

## The object that owns the lock

A pathname identifies a file through the filesystem namespace. Opening it creates an open file description; a file descriptor is a process's handle to that description. `dup()` and inheritance through `fork()` can give several descriptors access to the same description.

For Linux `flock()`, those descriptors share one lock. Closing one handle does not release it while another remains. An explicit `LOCK_UN` through any shared handle releases the lock, however. Independently opening the same file creates a different open file description that must compete for the lock—even when both opens occur in one process. Locks survive `execve()` when the relevant descriptor survives it. [Linux flock(2)](https://man7.org/linux/man-pages/man2/flock.2.html)

That distinction has a testing consequence: a contender must independently open the file. Calling `flock()` on a duplicated owner descriptor tests shared ownership, not exclusion between contenders.

Language runtimes can change what survives process launch. Python's `subprocess.Popen` defaults to closing nonstandard descriptors before executing the child; `pass_fds` explicitly preserves selected descriptors on POSIX. The experiment below deliberately tests both cases instead of assuming that every subprocess inherits every handle. [Python subprocess documentation](https://docs.python.org/3/library/subprocess.html#subprocess.Popen)

## Removing the filename creates a second coordination domain

Suppose a lock looks stale and a cleanup routine removes `slot.lock`. The original open file remains alive while descriptors reference it. Another runner can create a new file at the same pathname and lock that different file. Both holders then have valid exclusive locks, but those locks protect different objects. Unlinking changes the name binding; it does not revoke the existing holder. [Linux unlink(2)](https://man7.org/linux/man-pages/man2/unlink.2.html)

Keep a dedicated lock file stable while participants may use it. Do not routinely unlink it on release. If the protected data is written using atomic replacement, lock a separate stable coordination file rather than the replaceable data file. The empty lock file's continued existence is normal and says nothing about whether its kernel lock is held.

## Choose what lifetime the lock should represent

If the supervisor owns the critical section, prevent unrelated helpers from inheriting its descriptor and release only after the protected work stops. The util-linux wrapper's `flock --close` closes the lock descriptor before executing the command, leaving the wrapper to hold it while it waits. This avoids accidental retention by command descendants; it does **not** make a background worker part of the command's wait or make the lock survive the wrapper's death. [util-linux flock(1)](https://man7.org/linux/man-pages/man1/flock.1.html)

If descendants intentionally own the critical section, descriptor inheritance can preserve exclusion after the parent exits. That design must control every duplicate and forbid premature explicit unlock. A leaked descriptor can block progress indefinitely.

Neither policy alone proves that a test has stopped using the fixture. A parent can die while a worker continues without the lock; a worker can retain a lock after finishing useful work. Terminating and verifying the relevant processes is a separate responsibility. A timeout should diagnose ownership, not automatically remove the coordination file.

## Reproduce the boundary

Save this as `lock_demo.py` and run `python3 lock_demo.py` on Linux with a local writable temporary directory. It uses only the standard library and isolated temporary files. Pipe acknowledgments establish operation order; no sleeps are used. Each competing probe opens the pathname separately, with baseline success and held-lock failure assertions.

```python
import fcntl, os, subprocess, sys, tempfile
from pathlib import Path

EX = fcntl.LOCK_EX | fcntl.LOCK_NB

def available(path):
    with open(path, 'a') as other:
        try:
            fcntl.flock(other, EX)
            return True
        except BlockingIOError:
            return False

child_code = '''
import fcntl, sys
fd, mode = int(sys.argv[1]), sys.argv[2]
if mode == 'unlock':
    fcntl.flock(fd, fcntl.LOCK_UN)
print('ready', flush=True)
sys.stdin.readline()
'''

def child(fd, mode, inherit):
    p = subprocess.Popen(
        [sys.executable, '-c', child_code, str(fd), mode],
        pass_fds=(fd,) if inherit else (),
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    assert p.stdout.readline().strip() == 'ready'
    return p

def finish(p):
    p.communicate('\n', timeout=5)
    assert p.returncode == 0

with tempfile.TemporaryDirectory() as tmp:
    path = Path(tmp) / 'slot.lock'
    # Every probe independently opens the pathname, not a dup of the owner.
    assert available(path)
    for inherit in (True, False):
        owner = open(path, 'a')
        fcntl.flock(owner, EX)
        assert not available(path)
        p = child(owner.fileno(), 'hold', inherit)
        try:
            owner.close()  # No LOCK_UN: only this descriptor is closed.
            result = available(path)
            assert result == (not inherit)
            print(f'inherit={inherit}: after parent close available={result}')
        finally:
            finish(p)
        assert available(path)
        print('after child exit available=True')
    with open(path, 'a') as owner:
        fcntl.flock(owner, EX)
        p = child(owner.fileno(), 'unlock', True)
        try:
            assert available(path)
            print('child LOCK_UN: parent still open, available=True')
        finally:
            finish(p)
    with open(path, 'a') as old:
        fcntl.flock(old, EX)
        assert not available(path)
        path.unlink()
        with open(path, 'a') as new:
            fcntl.flock(new, EX)
            assert os.fstat(old.fileno()).st_ino != os.fstat(new.fileno()).st_ino
            assert not available(path)
            print('unlink/recreate: two exclusive locks on different inodes=True')
```

Observed with Python 3.12.3 on Linux:

```text
inherit=True: after parent close available=False
after child exit available=True
inherit=False: after parent close available=True
after child exit available=True
child LOCK_UN: parent still open, available=True
unlink/recreate: two exclusive locks on different inodes=True
```

The first pair isolates inheritance as the cause of retention. The explicit-unlock case shows why an open parent descriptor is insufficient evidence of exclusion. The final case verifies different inode identities while both exclusive locks are held. The parent-close case directly tests descriptor closure; parent death follows the documented close semantics but is not separately exercised here. These are local, cooperative-lock experiments, not a crash-recovery or network-filesystem certification.

## A useful review question

Ask: **Which open file description holds the lock, which processes can still access it, and can the pathname be rebound?** That yields a testable ownership contract. “The parent owns the lock” is too ambiguous to predict either retention or early release.

## Sources

- [Linux flock(2): ownership, duplicate descriptors, exec, and filesystem differences](https://man7.org/linux/man-pages/man2/flock.2.html)
- [Linux unlink(2): names versus open files](https://man7.org/linux/man-pages/man2/unlink.2.html)
- [util-linux flock(1): command wrapper and --close](https://man7.org/linux/man-pages/man1/flock.1.html)
- [Python subprocess: close_fds and pass_fds](https://docs.python.org/3/library/subprocess.html#subprocess.Popen)
