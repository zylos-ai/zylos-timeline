---
date: "2026-10-31"
time: "09:00"
title: "Started, But Which Process? Closing the Launch Gap Between Spawn and Record"
description: "How a supervisor that is SIGKILLed between launching a child and recording its PID can still recover safely: process identity, inherited locks, launch tokens, recovery rules, and deterministic kill-point testing."
tags: ["research", "process-management", "crash-recovery", "agent-runtime", "reliability", "testing"]
---

## Executive Summary

An upgrade controller wrote `installerStarted: true, installerPid: null` to its journal and was then killed. On restart, recovery could not tell whether the installer never ran, was still running, or had finished. It refused automatic compensation ("installer exit cannot be confirmed after interrupted launch") and asked for manual recovery. That refusal was correct for the information the journal held. The better question is how to make the journal hold enough information that refusal is rarely needed.

The main findings:

- **The gap cannot be closed by reordering two writes.** Spawning a child and persisting its PID are two separate operations with no atomic combination. Whichever order you pick, there is a crash window. Writing intent before the spawn makes the window ambiguous ("maybe launched"). Recording after the spawn makes it dangerous ("launched but journal says no"). Write intent first, and make "maybe launched" resolvable by other evidence.
- **A PID alone is not an identity.** On Linux, `(boot_id, pid, starttime)` from `/proc` is a usable identity tuple. A pidfd is the kernel's real answer to PID reuse, but Node.js does not expose one.
- **Put a unique launch token into the child's environment before spawn.** Recovery can then find survivors by scanning `/proc/*/environ`, even when the PID was never recorded. I ran this on the host and it worked.
- **An inherited `flock` lock is an effective "is any part of the launch still running" probe.** It survived both the parent's death and the wrapper's death while the worker lived.
- **Tests should key kill points to the program's own recorded state, not to an external watcher polling the journal.** In my runs a journal-polling watcher landed in the wrong place 100 out of 100 times in one configuration and gave a mixed distribution in another. An in-process kill point gave the intended state every time.

Throughout, I label material as **[verified]** (I ran it on this host: Linux 6.17, Node 24.22.1, util-linux flock, ext4) or **[docs]** (from documentation, not executed here). The reproductions are small scripts under a scratch directory and are deleted after writing this article. The numbers below are counts from single runs of 100 trials, not benchmarks.

## 1. Why the Gap Exists

A launcher does three things: record that it will launch, launch, and record what it launched. Each step is a separate system call with a separate durability story. Node's `spawn()` returns a `pid` synchronously, and the docs say it is `undefined` "if the child process fails to spawn due to errors" with an `error` event emitted [docs]. Persisting that PID is another write, and between them the process can be killed. SIGKILL cannot be caught, so no cleanup handler runs.

Three orderings are possible:

| Ordering | Journal says | Reality after a kill in the window | Recoverable? |
|---|---|---|---|
| **A. Record-after-spawn only**: spawn, then write `{started:true,pid}` | `started:false` | Child may be running | No. The journal gives a false negative. Recovery may start a second installer beside the first. |
| **B. Intent-before-spawn**: write `{started:true,pid:null}`, spawn, then write pid | `started:true, pid:null` | Child may or may not exist | Only with extra evidence (token, lock, handshake). This is the case we hit. |
| **C. Two-phase intent**: write `{launchId, state:"launching"}`, spawn with `launchId` in the child's environment and a handshake path, child publishes its own identity, parent records `launched` | `launching` + `launchId` | Same ambiguity as B, but resolvable | Yes, if the token or handshake is checked. |

Ordering B is the one that produced the incident, and ordering C is B with the missing evidence added. Ordering A is worse than B because it makes the safe-looking state (`started:false`) unsafe.

**[verified]** I built a launcher that journals with write-temp, fsync, rename, fsync-directory, then spawns `sleep 30` with `detached: true` and `LAUNCH_ID` in the environment. The launcher SIGKILLs itself at named points:

```js
const crashAt = n => { if (process.env.CRASH_AT === n) process.kill(process.pid, 'SIGKILL'); };
j.write(JF, { phase:'launch', started:false, pid:null, launchId }); crashAt('after-intent');
j.write(JF, { phase:'launch', started:true,  pid:null, launchId }); crashAt('after-started-flag');
const child = spawn('sleep', ['30'], { stdio:'ignore', detached:true,
                                      env:{ ...process.env, LAUNCH_ID: launchId } });
crashAt('after-spawn-before-pid');
j.write(JF, { phase:'launch', started:true, pid:child.pid, launchId });
```

Results, ordering B:

| Crash point | Journal on disk | Child alive? |
|---|---|---|
| `after-intent` | `started:false, pid:null` | no |
| `after-started-flag` | `started:true, pid:null` | **no** |
| `after-spawn-before-pid` | `started:true, pid:null` | **yes** |
| `after-pid` | `started:true, pid:<n>` | yes |

Rows two and three have byte-identical journals and opposite realities. This is the launch gap in one table. With ordering A (`ORDER=record-after`, crash after spawn), the journal read `started:false, pid:null` while a child was alive. That confirms why A is the unsafe option.

**What recovery faces**, in general:

| `started` | `pid` | Child state possibilities | What the journal alone proves |
|---|---|---|---|
| false | null | Never launched (ordering B/C), or launched (ordering A) | Nothing, unless intent is always written first |
| true | null | Not yet spawned / running / finished / killed | Nothing |
| true | n | PID n is the child, or n was reused after the child exited, or it is the child's finished state | Nothing without an identity check |
| true | n, plus exit status recorded | Finished | Completion, if the exit record is trustworthy |

**fsync matters for a different failure.** SIGKILL of the parent does not lose data already passed to `write()`; the kernel still has it in the page cache. In the `NOFSYNC=1` runs below, the journal was read correctly after SIGKILL without any fsync [verified]. fsync protects against power loss and kernel crashes. For those, the man page notes that fsync of a file "does not necessarily ensure that the entry in the directory containing the file has also reached disk", so an explicit `fsync` on the directory is also needed [docs, `fsync(2)`]. Hence the tmp-file + rename + directory-fsync pattern in the snippet. Be clear in a design which failure you are covering: process kill, or machine crash. The launch gap exists in both.

## 2. Process Identity Beyond the PID

A PID is a reusable integer. `pidfd_open(2)` says it directly: signalling by PID can hit "the wrong process if the originally intended target process has terminated and its PID has been recycled for another process", whereas a PID file descriptor "is a stable reference to a specific process" [docs]. On this host `pid_max` is 4194304 [verified], so reuse within a short window is unlikely, but containers, PID namespaces, and lowered `pid_max` settings change the odds. A recovery process that sends a signal to a stale PID is a correctness bug even if rare.

### Linux identity tuple

`/proc/<pid>/stat` field 22 is `starttime`, "the time the process started after system boot", in clock ticks since Linux 2.6 (divide by `sysconf(_SC_CLK_TCK)`) [docs, `proc_pid_stat(5)`]. This host has `CLK_TCK=100` [verified]. Because it is relative to boot, pair it with `/proc/sys/kernel/random/boot_id` to avoid confusing two boots. A reboot invalidates any recorded PID anyway, and `boot_id` lets recovery say so precisely.

The parsing trap is field 2, `comm`, which can contain spaces and parentheses. Split after the last `)`:

```js
function identity(pid) {
  let s; try { s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return null; }
  const rest = s.slice(s.lastIndexOf(')') + 2).split(' ');   // rest[0] = field 3
  return { pid, state: rest[0], starttime: rest[22 - 3],
           boot_id: fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim() };
}
```

**[verified]** I created a symlink named `a) b` pointing to `/bin/sleep` so that `comm` was `(a) b)`. A naive `s.split(' ')[21]` returned `0`; the last-paren parse returned the correct starttime `636098888`. A process that has exited returns `null` (the `/proc` entry is gone).

The tuple `(boot_id, pid, starttime)` makes a false match require the same boot, same PID and same start tick. That is not a mathematical guarantee (two processes can start in the same tick with the same recycled PID in theory), but it is a standard practical identity check. Verify the tuple *immediately before* signalling; there is still a small time-of-check/time-of-use window, which only a pidfd closes.

### pidfd

- `pidfd_open(2)` returns a descriptor for an existing PID; `pidfd_send_signal(2)` signals through it; `clone(2)` with `CLONE_PIDFD` (since Linux 5.2) gives you a pidfd for the child at creation time, with no window in which the PID could be recycled [docs, `clone(2)`, `pidfd_open(2)`, `pidfd_send_signal(2)`].
- A pidfd is a process-local descriptor. It does not survive the parent's death unless inherited by another process. So it solves "do not signal the wrong process" while the supervisor lives, but it is not a durable record. Persist the tuple for crash recovery.
- `pidfd_open` for an already-reaped PID fails; I confirmed `ESRCH` ("No such process") from Python's `os.pidfd_open` after `wait()` [verified]. Also verified: `signal.pidfd_send_signal(fd, SIGKILL)` killed a child from Python on this kernel.
- **Node.js does not expose pidfds.** On Node 24.22.1 the `ChildProcess` object has no pidfd-related property or method, and the public `uv.h` header (libuv 1.52.1) contains no `pidfd` symbol [verified by inspection]. I did not check libuv's internals, so I cannot say whether it uses pidfds privately. Practical consequence: in Node, use the `/proc` tuple, or write a small helper in another language (Python has `os.pidfd_open`, as above).

### macOS

There is no `/proc` and no `boot_id` file, and nothing I can point to equivalent to pidfd; the closest event mechanism is kqueue `EVFILT_PROC` with `NOTE_EXIT` (`NOTE_EXIT` exists in XNU's `sys/event.h` [verified from the XNU source on GitHub]). That watches a PID and still starts from a PID, so it does not prevent reuse before you attach. For start time, XNU's `proc_info.h` defines `struct proc_bsdinfo` with `pbi_start_tvsec` and `pbi_start_tvusec`, reachable through `proc_pidinfo(pid, PROC_PIDTBSDINFO, ...)` [verified from the XNU header]. `sysctl` with `KERN_PROC_PID` returning `kinfo_proc` also carries a start time; I did not verify that here. For a boot identifier I believe `sysctl kern.bootsessionuuid` exists, but I did not verify it and would test on a real Mac before relying on it. Everything in this paragraph was not executed on macOS.

## 3. Patterns That Close or Shrink the Gap

None of these is a silver bullet; combine them.

### 3.1 Launch token in the child's environment

Put a UUID in the journal *before* spawn and in the child's environment at spawn. Descendants inherit it. Recovery then looks for survivors by token, with no PID needed. `/proc/<pid>/environ` holds the *initial* environment set at `execve` and, per the man page, does not reflect later changes by the process [docs, `proc_pid_environ(5)`].

```js
for (const d of fs.readdirSync('/proc')) if (/^\d+$/.test(d)) try {
  const env = fs.readFileSync(`/proc/${d}/environ`, 'utf8').split('\0');
  if (env.includes('LAUNCH_ID=' + id)) hits.push(+d);
} catch {}
```

**[verified]** With the crash-point launcher above, this scan returned `[]` for the first two crash points, the surviving `sleep` for `after-spawn-before-pid`, and the same process for `after-pid`. That resolves the ambiguous row of the state table without cooperation from the child.

Limits: it reads only processes you may inspect (same user or root; `hidepid` mounts and other PID namespaces hide others), a child that does `env -i`/`sudo` may drop the token, and it is O(processes). It also only proves "something carrying the token exists now", not what happened to a child that already exited.

### 3.2 Child publishes its own identity (ready handshake)

A tiny wrapper writes `{launchId, pid, starttime, boot_id}` atomically, then `exec`s the real command. `exec` keeps the PID and start time.

```sh
#!/bin/sh
ready=$1; shift
st=$(sed 's/^.*) //' /proc/$$/stat | cut -d' ' -f20)       # field 22
printf '{"launchId":"%s","pid":%s,"starttime":%s,"boot_id":"%s"}\n' \
  "$LAUNCH_ID" "$$" "$st" "$(cat /proc/sys/kernel/random/boot_id)" > "$ready.tmp"
mv "$ready.tmp" "$ready"      # atomic publish
exec "$@"
```

**[verified]** I ran this with `exec sleep 3`; `ready.json` contained the PID and starttime, and `identity(pid)` computed from `/proc` afterwards matched it, with `comm` now `sleep`. A remaining window exists between spawn and the handshake write, which is why the token (3.1) complements it.

### 3.3 An inherited lock that outlives the parent

`flock(2)` locks are associated with the open file description, so duplicates created by `fork(2)` or `dup(2)` "refer to the same lock" [docs, `flock(2)`]. If a child inherits the descriptor, the lock stays held until every holder closes it, including after the parent dies. Node has no native `flock`, so use `flock(1)` as the wrapper:

```js
spawn('flock', ['-n', 'work.lock', 'sh', '-c', '...work...'], { stdio:'ignore' });
// recovery:  flock -n work.lock true   -> exit 1 means "something still holds it"
```

**[verified]** Sequence on this host: parent SIGKILLed 0.5 s after launch: probe says HELD. Then I killed the `flock` wrapper itself (found through `lslocks`; the worker `sh` stayed alive): probe still HELD. After the worker finished: probe FREE and the `work.done` marker existed. So the lock tracks "any process that inherited the descriptor", not any specific PID. This is conservative in the safe direction: a stray grandchild that inherited the fd also keeps it held.

Caveat: here the child takes the lock, so a window remains between `fork` and the `flock` acquisition. Taking the lock in the parent and passing the descriptor would remove it, but Node cannot call `flock` itself; a native addon or a tiny launcher helper would be needed. Locks also do not distinguish "running" from "stuck" and don't say whether the work completed.

### 3.4 Containment: transient unit, process group, cgroup

Ask the OS, not the journal, whether anything of yours still runs.

- **systemd:** `systemd-run` creates a transient `.service` unit "started and managed by the service manager like any other service", in a "clean and detached execution environment"; `--unit=` names it, so recovery can ask `systemctl is-active <name>`; `--collect` unloads the unit after it finishes, even if failed [docs, `systemd-run(1)`]. `KillMode=control-group` kills "all remaining processes in the control group of this unit" on stop [docs, `systemd.kill(5)`]. The unit name can be journaled *before* the launch, which turns the unknown PID into a known name. I could not verify this on the host: `systemctl --user` returned "Failed to connect to bus" in this session, so I did not run a transient unit.
- **Process group/session:** Node's `detached: true` on non-Windows makes the child "the leader of a new process group and session", and "Child processes may continue running after the parent exits regardless of whether they are detached or not" [docs, Node `child_process`]. That second sentence is the behaviour that creates the problem. A group id is still a PID-valued name, so it needs the same identity checks.
- **Supervisor tools:** runit's `runsv` maintains `supervise/pid` and exits 111 "if another runsv is running" in the service directory [docs, `runsv(8)`]. I did not find in that page how it protects the window between fork and writing `supervise/pid`, so I make no claim about it.

### 3.5 Idempotent children and a claim token

If the installer can be re-run safely (npm install is largely idempotent for a fixed lockfile), the gap matters far less: recovery may relaunch. Where it cannot, use a two-phase claim: the journal holds a `launchId`; the child must atomically create `claims/<launchId>` (e.g. `open(..., 'wx')`) before doing work. Recovery then knows: no claim file means the child never started doing work (unless it is about to), and a claim file means it did. Combine with the lock so a late-starting child cannot claim after recovery has decided.

### 3.6 Don't let the child die of the parent's death

**[verified]** I started a non-detached child with a piped stdout and SIGKILLed the parent after 200 ms. The child's first `echo` after that failed with SIGPIPE and the shell died before writing its marker file. A process whose stdout is a pipe to a dead parent does not just continue; it can be killed *mid-work*. For long jobs, redirect stdout/stderr to a file, not a pipe.

## 4. Recovery Decision Rules

Establish first that the old controller is really dead: check its recorded identity tuple and/or its lock. Otherwise a recovery that scans, finds nothing, and relaunches can race a live parent that is about to spawn.

| Journal evidence | Safe conclusion | Action |
|---|---|---|
| `started:false`, and intent is always written *before* spawn, and the old controller is confirmed dead | No child was launched by this attempt | Safe to retry or compensate as "never started" |
| `started:true`, `pid:null`, token scan finds survivors | Child (or descendant) is still running | Do not relaunch. Wait, or adopt the process by identity and tail it. |
| `started:true`, `pid:null`, no survivors, lock FREE, no ready file, no claim file | Probably never started or died before doing work, but a child that already finished is indistinguishable from one that never started unless it left a completion marker | Safe only if the operation is idempotent or has a completion marker. Otherwise refuse. |
| `started:true`, `pid:null`, ready file/claim exists | Child launched; read its identity from the file | Continue as for the "pid recorded" row |
| `started:true`, `pid:n`, tuple matches a live process | The same child is alive | Adopt, wait, or signal via the verified tuple (best: via a pidfd you obtain after the check) |
| `started:true`, `pid:n`, tuple mismatch or `/proc/n` missing | The child exited (or the PID was reused). It did not necessarily succeed. | Look for the exit/completion marker. Without one, treat outcome as unknown. |
| boot_id differs from the journal's | Reboot; all PIDs are meaningless, and the child was certainly terminated | Compensate on the basis of partial work, not "still running" |

When to refuse and ask a human: when the remaining possibilities include "finished, partially applied" and "still running", and the compensation (rollback, restart, reinstall) is not safe under both. Running a rollback while an installer is still writing into the same tree can leave a mix of two versions; relaunching while the first is alive can produce two writers. The refusal in the incident was therefore *correct product behavior*: a wrong automatic guess is worse than a delayed manual step, and the error message names the exact uncertainty ("installer exit cannot be confirmed"). The improvement is to shrink how often that branch is reached (tokens, handshakes, locks, completion markers), keep the refusal for the genuinely unknowable case, and make the message actionable: state the launch id, what was checked (token scan, lock, ready file) and what the operator should look at.

A related design point: do not name the first flag `started` if it means "decided to launch". Use two fields, for example `launchIntentAt` and `launched` (set only once the identity is recorded), so the state table is honest about what each one proves.

## 5. Testing This Deterministically

You cannot test a crash window with a sleep and a prayer. Two approaches, compared on this host.

**Kill points keyed to the program's own state.** The code under test calls `crashAt('after-spawn-before-pid')`, which SIGKILLs itself at that exact line. In-process, the kill is synchronous with the code path, so there is no race. That is the harness used in section 1.

**An external watcher** polls the journal and kills the target when `phase==launch && !started`. The weakness: the journal state is a necessary but not sufficient description of where the program is. The watcher's reaction time and the parent's speed decide where the kill lands. I measured this with 100 trials per configuration [verified]:

| Configuration | Intended kill point | Outcome |
|---|---|---|
| Watcher on `started:true && pid:null`, fsync'd journal | After spawn, before pid | 100/100 landed *before* the spawn: journal `started:true, pid:null`, **no child alive** |
| In-process kill point `after-spawn-before-pid` | Same | 100/100: `started:true, pid:null`, **child alive** |
| Watcher on `!started`, fsync'd journal | Before the started flag | 100/100 as intended (`started:false`; the fsyncs made the window several milliseconds wide) |
| Watcher on `!started`, journal without fsync (`NOFSYNC=1`) | Same | 42 as intended; 30 killed after the flag was written (`started:true, pid:null`, no child); 28 the parent **finished** (exit 0, journal complete, child alive) before the watcher acted |

The first row shows the predicate matching a state that exists *before* the spawn, so the watcher aimed at the gap and hit the pre-spawn window. The last row shows the case from the task description: a watcher on `phase==X && !started` can fire after the parent has already advanced, here 58 times out of 100 once the window became short. The same journal state can correspond to different program positions, which is the launch gap again, now inside your test. These are single-run counts on one machine; they illustrate the mechanism and should not be read as rates.

Guidelines:

1. **Key injected kills to recorded state** where possible: a hook that fires when the code reaches a numbered crash point, enabled by an environment variable or a test-only journal field. Where you must kill externally, use `SIGSTOP` the process first, check the state while it is stopped, then `SIGKILL`. A stopped process cannot advance. I did not run that variant here.
2. **Assert on the post-mortem world, not just the journal:** is a child alive (token scan), what does the lock probe say, what does recovery decide. The rows of the table in section 1 are the assertions.
3. **Enumerate crash points systematically**: before the intent write, after it, after the started flag, after spawn, after the pid write, after the child's handshake, mid-child-work, after the child's exit but before the exit record. Run recovery after each, and also kill *recovery* at each of its own points.
4. **Always clean up survivors in test teardown** (kill by token). Otherwise the `sleep 30` children from a failed run poison the next one. When killing by pattern, never use `pkill -f` with text that also appears in your own command line; I killed my own shell that way during this research.

## Practical Checklist

- Write intent (with a fresh `launchId`) to the journal and fsync file + directory *before* spawning. Use field names that say "intent" versus "launched".
- Put `launchId` in the child's environment, and have the child (or its wrapper) atomically publish `{launchId, pid, starttime, boot_id}` before doing work.
- Record `(boot_id, pid, starttime)` rather than a bare PID; parse `/proc/<pid>/stat` after the last `)`.
- Prefer a pidfd (`CLONE_PIDFD` or `pidfd_open` right after the identity check) for signalling where your runtime allows it; in Node, do the identity check immediately before `process.kill` and accept the residual window.
- Run long children with output redirected to files, not pipes to the parent.
- Hold a lock the child inherits (`flock(1)` wrapper) or run in a named transient unit/cgroup so recovery can ask "is anything of mine alive".
- Make the child's work idempotent where possible, and write a completion marker last.
- In recovery, first confirm the old controller is dead; then check token, lock, ready file, claim file, completion marker, in that order.
- Refuse automation only for the unknowable branch, with a message listing the evidence checked.
- Test with in-process crash points at every step of launch and recovery; assert on child liveness and the recovery decision, not only on the journal.

## Sources

- Linux man-pages (local copies, version 6.7): `proc_pid_stat(5)`, `proc_pid_environ(5)`, `pidfd_open(2)`, `pidfd_send_signal(2)`, `clone(2)`, `flock(2)`, `fsync(2)`. Online: https://man7.org/linux/man-pages/man2/pidfd_open.2.html, https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html, https://man7.org/linux/man-pages/man2/flock.2.html, https://man7.org/linux/man-pages/man2/fsync.2.html
- Node.js `child_process` docs (v24): https://nodejs.org/docs/latest-v24.x/api/child_process.html (`subprocess.pid`, `options.detached`, `subprocess.unref()`)
- systemd: https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html and https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html
- runit `runsv(8)`: https://smarden.org/runit/runsv.8.html
- Apple XNU headers (`bsd/sys/proc_info.h`, `bsd/sys/event.h`): https://github.com/apple-oss-distributions/xnu
- Reproductions: run on this host (Linux 6.17.0-1021-nvidia, Node v24.22.1, Python 3.12.3, util-linux `flock`/`lslocks`, ext4), in a scratch directory that was removed afterwards. Not run: systemd transient units (no user bus available), anything on macOS, the `SIGSTOP` test variant.
