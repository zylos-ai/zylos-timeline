---
date: "2026-09-25"
time: "09:09"
title: "Process-Tree Cleanup for Agent-Spawned Subprocesses"
description: "Why killpg() and even a full process-group signal are not enough to clean up what an agent's tool call started, and what actually stops every descendant on Linux: subreapers, pidfd, and cgroup.kill."
tags: ["ai-agents", "linux", "process-management", "cgroups", "systemd", "pidfd", "reliability"]
---

## Executive Summary

An autonomous agent runtime spawns shell commands, dev servers, headless browsers, and background jobs on behalf of a model that cannot see process tables. When a tool call times out, gets cancelled, or the agent shuts down, the runtime has to stop *everything that call started* — not just the PID it happened to capture. The intuitive fix, `kill(-pgid, SIGTERM)`, is what most agent harnesses do, and it is not enough.

This article traces why, with primary sources (man7.org, kernel docs, systemd docs, Node/Python docs, and real GitHub issues from OpenHands and Codex CLI), and then proves it with small experiments run on this machine (Linux 6.17, aarch64, cgroup v2, unprivileged user session):

- A process that double-forks and calls `setsid()` leaves its parent's process group and session entirely. `killpg()` on the original group provably does not reach it — we reproduced this directly.
- `PR_SET_CHILD_SUBREAPER` reparents that escaped orphan to a designated ancestor instead of to init, letting the harness find and kill it even after it changed pgid and session — we reproduced this too, and watched the reparenting happen in under a second.
- An unprivileged, delegated **cgroup v2** subtree survives `setsid()` entirely (cgroup membership is orthogonal to process groups and sessions), and `cgroup.kill` kills the whole tree with one write, no root required. It stops *accidental* escape; a same-user process that deliberately migrates itself to another cgroup in the same delegated subtree is a separate threat, covered in Section 3.5.
- `systemd-run --user --scope` gets you the same cgroup-backed guarantee for free, plus a name you can `systemctl stop`.
- `pidfd_open`/`pidfd_send_signal` close the PID-reuse race: signaling a pidfd after the target has been reaped fails with `ESRCH` instead of silently hitting an unrelated process that inherited the recycled number.

Of these mechanisms, only cgroup confinement and PID namespaces (which are heavier) survive a daemonizing descendant. The practical answer for an agent harness is: put every tool call in its own cgroup (or systemd scope) at spawn time, track it by pidfd instead of raw PID, escalate TERM→KILL, and confirm cleanup via `cgroup.events`, not via `kill(pid, 0)`.

## 1. What "kill the tool call" actually has to reach

When an agent runtime runs a tool call, it typically does something like `subprocess.Popen(cmd, start_new_session=True)` or `child_process.spawn(cmd, { detached: true })`. Both do the same thing under the hood: `fork()` + `setsid()` + `exec()`. The resulting child becomes the leader of a brand-new session and process group, and its PID equals both its PGID and SID. The harness remembers that one PID.

The assumption baked into `killpg(-pid, SIGTERM)` is that every process this tool call ever spawns stays in that one process group for its entire life. That fails constantly in practice, because:

- shells background jobs with `&` and disown them,
- daemonizing tools (database servers, browser helper processes, `nohup`, watch processes) deliberately call `setsid()` to detach from the controlling terminal,
- some tools call `setpgid()` directly to control their own job control,
- and every one of those actions is *explicitly designed* to survive the parent going away — which is exactly what an agent harness is trying to prevent when it kills a runaway tool call.

## 2. Failure modes, one at a time

### 2.1 Double-fork + `setsid()` daemonization

The classic Unix daemonization idiom is: fork, have the first child call `setsid()` (making it a new session leader with a new PGID equal to its own PID), fork again, and have the *original* first child exit immediately. The grandchild is now orphaned right away and belongs to a session and process group that share no ancestry with the harness's tracked PGID. `man7.org`'s `credentials(7)` and `setsid(2)` pages describe the mechanics that make this possible.

We reproduced this directly (Section 5.1): `killpg()` on the tracked group leaves the double-forked descendant running, indefinitely, with a different PGID and SID.

### 2.2 Processes that change their own process group

`setpgid(2)` lets any process (subject to some restrictions — see the man page for the exact rules about session leaders and execed children) move itself, or a child that hasn't yet called `exec()`, into a different process group. Job-control shells do this routinely. A tool call doesn't need `setsid()` to escape a `killpg()` — `setpgid()` alone accomplishes the same thing without the session change.

### 2.3 Orphans reparented to init or a subreaper

Per `man7.org`'s `pid_namespaces(7)`: "When a child process becomes orphaned, it is reparented to the 'init' process in the PID namespace of its parent" — *unless* an ancestor has registered itself as a subreaper via `PR_SET_CHILD_SUBREAPER`, in which case the orphan is reparented to the nearest such ancestor instead. Either way, the orphan's parent link no longer points at the process the harness was watching, and the process itself is untouched by `killpg()` if it also changed PGID (which double-fork daemonization always does).

In our experiment, reparenting to the subreaper was already visible within our 200 ms poll window after the immediate parent exited; it happens when the parent exits, not at some later cleanup point.

### 2.4 PID reuse races

`kill(2)` and `killpg(2)` address a process purely by number. Per `pidfd_send_signal(2)`: "the sender might accidentally send [a] signal to an unrelated process" if "the original process terminated and its process ID was recycled for a different process." The kernel's built-in `pid_max` default is 32,768 (scaled up on machines with many CPUs), and systemd raises it to 4,194,304 on 64-bit systems (the value on our test machine). A large `pid_max` makes reuse rare in a short window on an idle box — but "rare" is not a safety property, it's the textbook definition of a race. `golang/go#13987`, "os: on unix Process.Kill() can kill the wrong process," is a real, filed report of exactly this bug.

### 2.5 Zombies from parents that never `wait()`

A terminated process stays in the process table as a zombie — dead, but occupying a PID — until its parent calls `wait()`/`waitpid()` on it. `wait(2)` documents this lifecycle. We hit this by accident in our own first experiment run: our harness sent `SIGTERM` via `killpg()`, and `kill(pid, 0)` kept reporting the target as present half a second later — not because the signal failed, but because the process had already died and was sitting as a zombie (`/proc/<pid>/stat` state `Z`) waiting to be reaped. A harness that checks "is it dead yet" with `kill(pid, 0)` instead of an actual `wait()`/`waitid()` call can spin forever on this, or worse, treat a live process and a stuck zombie identically.

### 2.6 `nohup` / `&` inside a shell tool call

If the agent's tool call is `bash -c "long_running_job &"`, the backgrounded job is a child of the bash process the harness is tracking, in the *same* process group (unless the job itself calls `setsid`). `killpg()` will actually reach it here — the danger with `&` is different: if the wrapping `bash -c` process exits normally (script finishes, or is `exec`'d away — see 2.8), the backgrounded job keeps running as an orphan the harness never explicitly decided to keep alive, because the harness only knew about the shell's PID, not the grandchild's.

### 2.7 SIGTERM ignored or trapped

`SIGTERM` is the default polite signal, but any process can install a handler for it (or explicitly `trap` it in a shell) and simply not exit. `SIGKILL`, by contrast, cannot be caught, blocked, or ignored (`signal(7)`). Any harness that sends only `SIGTERM` and treats "signal sent" as "process gone" is trusting cooperative behavior it cannot verify.

### 2.8 `timeout` kills the wrapper, not the children

GNU coreutils' `timeout(1)` is a common way agents bound a shell command. Its manual is explicit about a sharp edge: by default `timeout` puts the command in its own background process group so descendants can be signaled together — but `--foreground`, needed when the command needs a real terminal, disables that isolation entirely, and the manual states plainly: "In this mode of operation, any children of command will not be timed out." Separately, if the wrapped command is `bash -c '...'` and the script is a single simple command, bash typically `exec`s it rather than forking, collapsing wrapper and payload into one process image. The operational lesson matches 2.6: what a harness thinks is "the process" and what's actually running underneath it can diverge silently.

## 3. Mechanisms and what they actually guarantee

### 3.1 Process groups and sessions

A process group is a signaling unit (`kill(-pgid, sig)` reaches every member); a session is mostly about controlling terminals and job control (`credentials(7)`, `setsid(2)`). Neither is escape-proof: membership in both is something a process can voluntarily leave via `setsid()` or `setpgid()`, and neither survives that departure. This is the mechanism most language runtimes expose by default (Node's `detached: true`, Python's `start_new_session=True`), and it is necessary but not sufficient.

### 3.2 `PR_SET_PDEATHSIG`

`prctl(2)`'s `PR_SET_PDEATHSIG` arms a signal to be delivered to a child automatically "upon subsequent termination of the parent thread." We verified the basic case directly (Section 5.4): a child armed with `PR_SET_PDEATHSIG(SIGTERM)` received the signal well under a millisecond after its parent called `exit()`, with no explicit kill from anyone.

The documented gotchas, straight from the man page: the "parent" is the specific *thread* that made the `prctl()` call, and the signal fires "when that thread terminates ... rather than after all of the threads in the parent process terminate." The setting is cleared across `fork()` (each child must re-arm it) and cleared on `execve()` of a set-UID/set-GID binary or one with file capabilities, or on any change to effective/filesystem UID or GID. This thread-vs-process distinction is not theoretical. `golang/go#27505` reports a child that kept dying because it was started on one thread and waited on from another, and asks Go to fix its misleading `Pdeathsig` documentation. `tetratelabs/func-e#173` describes the fix in a Go runtime, which moves goroutines between OS threads: start the child from a goroutine locked to its OS thread, and keep that goroutine alive until the child exits. `PR_SET_PDEATHSIG` also only fires on the parent's own death — it does nothing for a grandchild already re-parented away.

### 3.3 `PR_SET_CHILD_SUBREAPER`

Also a `prctl(2)` operation, available since Linux 3.4. It makes the calling process the reparenting target for any of its descendants that would otherwise be orphaned up to init: "a subreaper fulfills the role of `init(1)` for its descendant processes," and orphan search walks up the ancestry from the dying parent, stopping at the nearest ancestor that has set this flag (or at the namespace's init if none has). This is real, load-bearing infrastructure — it's exactly what `tini`'s `-s`/`TINI_SUBREAPER` flag and Docker's own init process rely on for zombie reaping in containers.

It does **not**, by itself, stop the orphan from doing anything — it only makes sure the harness *finds out about it* (it becomes a direct child, discoverable via `/proc/<harness_pid>/task` or a `PPid` scan, or eventually reapable via `wait()`). The harness still has to notice and act. Our experiment shows this working end to end: the escaped grandchild's `PPid` became the subreaper's PID before the harness even sent its first signal, letting the harness walk `/proc`, find it, and `SIGKILL` it directly — something plain `killpg()` on the original group could never do, because the escapee's PGID and SID had both changed.

### 3.4 `pidfd_open` / `pidfd_send_signal` / `waitid(P_PIDFD)`

`pidfd_open(2)` (Linux 5.3+) returns a file descriptor bound to a specific task, not a recyclable number. The man page states the guarantee directly: "even if the child has already terminated by the time of the `pidfd_open()` call, its PID will not have been recycled" — with three caveats: `SIGCHLD` must not be `SIG_IGN`, `SA_NOCLDWAIT` must not be set, and nothing else must have already reaped the zombie; if none of those hold, `clone(2)` with `CLONE_PIDFD` gets the fd atomically at process-creation time instead. `pidfd_send_signal(2)` (Linux 5.1+) signals through that fd; if the task has already exited and been waited on, it fails with `ESRCH` rather than risking delivery to a different process that inherited the number. `waitid(2)`'s `P_PIDFD` idtype (Linux 5.4+) lets you `wait()` on a pidfd the same way. We reproduced the safety property directly (Section 5.5): after reaping a short-lived process via its pidfd, calling `pidfd_send_signal` on that same, still-open pidfd fails with `ESRCH` — it does not, and structurally cannot, land on whatever process the kernel later handed that PID number to.

pidfd solves the *addressing* problem, not the *escape* problem: a pidfd for a specific process still only lets you signal that one process (or, with the pidfd from `CLONE_PIDFD`, none of its later descendants). It has to be combined with something that catches the whole tree.

### 3.5 cgroup v2: `cgroup.kill`, `cgroup.procs`, `cgroup.events`

This is the one mechanism here that a process does not leave by calling `setsid()`, `setpgid()`, or forking twice: cgroup membership is inherited across `fork()` and unaffected by session or process-group changes.

There is one limit. The kernel's migration rule requires write access to the `cgroup.procs` file of the *common ancestor* of the source and destination cgroups. When the harness and its tool calls run as the same user inside that user's delegated subtree, a tool call that writes its own PID into a sibling cgroup can leave. Ordinary daemonizing software never does this, so cgroups reliably catch accidental escape. Against a deliberately hostile tool call, the confinement boundary must also be one the tool call cannot write to: a different UID, a container, or a delegated subtree it has no write access to.

Per the kernel's cgroup v2 admin guide: `cgroup.kill` is "a write-only single value file which exists in non-root cgroups," and "writing '1' to the file causes the cgroup and all descendant cgroups to be killed" — every process gets `SIGKILL`, "protected against migrations," handling concurrent forks correctly (introduced in Linux 5.14; runc adopted it for exactly this reason — `opencontainers/runc#3135` frames it as a more reliable replacement for runc's own userspace process-tree-walking kill routine). `cgroup.events`' `populated` field reports "1 if the cgroup or its descendants contains any live processes; otherwise, 0," pollable/notifiable — the correct way to confirm cleanup finished, not polling `kill(pid, 0)` on remembered PIDs.

The catch: creating and killing arbitrary cgroups requires *delegation* — write access to a subtree, normally handed out by systemd to each login session and to unprivileged containers. It depends on already running inside a delegated slice, not something a bare process can conjure alone.

### 3.6 systemd: `systemd-run --scope`/`--user`, `KillMode`

`systemd-run --scope` runs a command as the initial process of a new *scope* unit — a cgroup-backed unit systemd tracks. Unlike a service, the command runs in the invoking process itself rather than being started by the service manager. `--user` targets the calling user's own systemd instance instead of the system one, which is how this works entirely without root, given a user manager and session bus (an active login session, or lingering via `loginctl enable-linger`). `systemd.kill(5)` documents `KillMode=control-group` as the default: on unit stop, "all remaining processes in the control group of this unit will be killed." Since a scope is a cgroup, it gets the same membership guarantee as Section 3.5. We confirmed this experimentally in Section 5.3: a double-forked, fully re-parented-to-init descendant with a completely different PGID and SID than the scope's main process still died the instant we ran `systemctl --user stop` on the scope.

### 3.7 PID namespaces

Killing the init process of a PID namespace is the heaviest hammer available: per `pid_namespaces(7)`, "the kernel terminates all of the processes in the namespace via a SIGKILL signal" as soon as that init exits, and the namespace stops accepting new processes (`ENOMEM` on subsequent `fork()`) as it's torn down. Escape-proof by construction — nothing inside can leave — but heavier machinery (`CLONE_NEWPID`, normally root or user namespaces plus supporting setup) than most tool calls justify per invocation.

### 3.8 `tini` / `dumb-init`

Both run as PID 1 in a container to solve two problems: reaping zombies (inheriting orphans as the namespace's init and `wait()`-ing on them) and correct default signal delivery (PID 1 doesn't get default `SIGTERM` handling, so an unhandled `CMD` can become unkillable via the friendly path). `tini`'s README documents an explicit opt-in, `-s`/`TINI_SUBREAPER`, to register as a `PR_SET_CHILD_SUBREAPER` even when not PID 1, and a separate `-g`/`TINI_KILL_PROCESS_GROUP` to forward signals to the whole foreground group instead of just the immediate child — by default even `tini` only forwards to one process.

## 4. How real agent tooling actually handles this

Scoped to what is verifiable from documentation and public source/issues:

- **Node.js `child_process`**: the official docs confirm `detached: true` makes the child "the leader of a new process group and session," citing `setsid(2)` directly. The commonly used follow-up, `process.kill(-child.pid)` to signal the whole group via a negative PID, is standard POSIX `kill(2)` behavior, but it isn't itself spelled out in the Node docs we checked — community convention layered on a documented primitive, not a documented Node.js guarantee.
- **Python `subprocess`**: `start_new_session=True` is documented to call `setsid()` in the child before `exec`; a newer `process_group` parameter (Python 3.11+) wraps `setpgid(0, value)` directly. The docs don't discuss zombies, orphaned grandchildren, or `os.killpg()` usage — that's left to the caller.
- **OpenHands** (`OpenHands/software-agent-sdk`): issue #4910 is a filed, first-party bug report describing exactly the failure mode in Section 2.1/2.3 — an ACP-managed subprocess tree (`npx` → `sh -c` → `node` → the actual tool) was being shut down by signaling only the top-level PID, without `start_new_session=True`, so descendants survived as orphans of init. The tracked fix is precisely: spawn with `start_new_session=True`, terminate via `os.killpg(pgid, signal.SIGTERM)`. That confirms, from OpenHands' own tracker rather than our inference, both the baseline process-group approach and its exact gap for anything that changes its own group or session.
- **OpenAI Codex CLI**: issue #7932, an open, unresolved user report, describes background processes (a web-scraping tool spawning Chrome) surviving session interruption (Esc/Ctrl-C), with the reporter's diagnosis matching Section 2 almost verbatim: "child processes not attached to a process group," "interrupt signals not forwarded," "no centralized job tracking." We could not verify Codex CLI's internal job-control implementation from source, so we report this as a documented user-facing issue, not a verified architectural claim.
- **PM2**: shipped a "treekill" system (`Unitech/pm2#1036`) using `ps --ppid` traversal to find descendants and signal each one, rather than relying solely on process-group signaling. Valid for the "different PGID" case, but a `ps`-based tree walk is a point-in-time snapshot — it can still race against a process forking after the walk but before the kill, which cgroup- or subreaper-based approaches don't.

## 5. Hands-on verification

All experiments ran in a scratch directory (shown here as `/tmp/proctree/`) on this machine: Linux 6.17, aarch64, cgroup v2 mounted with `nsdelegate`, running inside an already-delegated systemd cgroup slice, no root. Every PID killed below was one we captured from our own experiment's output — nothing was killed by name.

### 5.1 Baseline: `killpg()` misses a double-forked, `setsid()`'d escapee

The harness forks a "tool call" process (`child0`), which calls `setsid()` (mirroring `start_new_session=True`/`detached: true`), then double-forks a "sleeper" daemon that also calls `setsid()` before sleeping — the textbook daemonization escape from Section 2.1:

```
$ python3 harness.py plain
[harness pid=1979938] plain mode (no subreaper)
[harness] child0   pid=1979954 state=S ppid=1979938 pgid=1979954 sid=1979954
[harness] sleeper  pid=1979956 state=S ppid=1      pgid=1979956 sid=1979956
[harness] killpg(1979954, SIGTERM)   # this is what an agent does after a tool-call timeout
[harness] after killpg: child0 alive=False  sleeper alive=True
[harness] child0 raw state: pid=1979954 state=Z ppid=1979938 ...   (Z = zombie: terminated but unreaped)
[harness] sleeper info now: pid=1979956 state=S ppid=1 pgid=1979956 sid=1979956
[harness] reaping child0 via waitpid() ...
[harness] child0 after reap: pid=1979954 <gone>
[harness] FINAL: child0 alive=False  sleeper alive=True
[harness] cleanup: force killing leftover sleeper pid=1979956
```

Two things worth noting beyond the headline result: the sleeper's `ppid` was already `1` (init), confirming Section 2.3, and the very first version of this script had a bug where it checked "alive" with a bare `kill(pid, 0)`, which reported `child0` as alive for a beat *after* `SIGTERM` had already killed it, because it was sitting as a zombie (state `Z`) waiting to be reaped — an unplanned, live demonstration of Section 2.5.

### 5.2 `PR_SET_CHILD_SUBREAPER` catches the escapee

Same script, with the harness first calling `prctl(PR_SET_CHILD_SUBREAPER, 1)` on itself:

```
$ python3 harness.py subreaper
[harness pid=1981896] set PR_SET_CHILD_SUBREAPER=1 on self
[harness] child0   pid=1981912 state=S ppid=1981896 pgid=1981912 sid=1981912
[harness] sleeper  pid=1981914 state=S ppid=1981896 pgid=1981914 sid=1981914
[harness] killpg(1981912, SIGTERM)
[harness] after killpg: child0 alive=False  sleeper alive=True
[harness] scanning /proc for processes reparented to us (subreaper)...
[harness] children now reparented to harness: [1981914]
[harness] killing reparented orphan pid=1981914 directly
[harness] FINAL: child0 alive=False  sleeper alive=False
```

Note the sleeper's `ppid` is already `1981896` (the harness) *before* `killpg` even runs — reparenting to the subreaper happened as soon as the double-fork's first intermediate process exited, not lazily. This is what let the harness find it via a `/proc` scan on `PPid` and kill it directly, even though its PGID/SID never matched the tracked group.

(A stray run where the harness itself crashed mid-experiment left the sleeper briefly re-parented to `1`/init instead — confirming that a subreaper only protects descendants while it's alive; if it dies too, orphans fall through to whatever the next subreaper up the chain is, or to init.)

### 5.3 cgroup v2 confinement + `cgroup.kill`, and a `systemd-run --user --scope` equivalent

First, using a manually created delegated sub-cgroup (`mkdir` under our own already-delegated cgroup path — no root needed):

```
$ python3 cgroup_demo.py
[harness] created delegated sub-cgroup: .../proctree-demo
[harness] child0  pid=1992311  stat={'state': 'S', 'ppid': 1992300, 'pgid': 1992311, 'sid': 1992311}
[harness] sleeper pid=1992322 stat={'state': 'S', 'ppid': 1,       'pgid': 1992322, 'sid': 1992322}
[harness] sub-cgroup members before kill: ['1992311', '1992322']
[harness] step 1: killpg(1992311, SIGTERM)  -- the naive approach
[harness] after killpg: child0 alive=False  sleeper alive=True
[harness] step 2: echo 1 > .../proctree-demo/cgroup.kill
[harness] after cgroup.kill: child0 alive=False  sleeper alive=False
[harness] .../proctree-demo/cgroup.events:
populated 0
frozen 0
```

The sleeper survived `killpg()` exactly as before (different PGID, different SID, reparented to init) but was still listed in `cgroup.procs` for the sub-cgroup the whole time, because `setsid()` never touches cgroup membership. One write to `cgroup.kill` ended both processes, and `cgroup.events` confirmed `populated 0` — the correct way to verify an empty tree, instead of polling remembered PIDs.

Second, the systemd equivalent, using a real `systemd --user` scope (available here without root because the login session already runs a user manager):

```
$ systemd-run --user --unit=proctree-demo --scope -- python3 escaper_only.py &
Running as unit: proctree-demo.scope; ...

$ ps -o pid,ppid,pgid,sid,stat,cmd -p 2019550,2019566
    PID    PPID    PGID     SID STAT CMD
2019550       1 2019550 2019547 S    python3 escaper_only.py
2019566       1 2019566 2019566 Ss   python3 escaper_only.py

$ cat /sys/fs/cgroup/.../proctree-demo.scope/cgroup.procs
2019550
2019566

$ systemctl --user stop proctree-demo.scope
$ # both 2019550 and 2019566 gone; scope cgroup directory removed automatically
```

Same result as the manual cgroup: a fully escaped descendant (different PGID and SID from the scope's main process, reparented to init) died the instant the scope was stopped, and systemd cleaned up the cgroup directory itself — no manual `rmdir`.

### 5.4 `PR_SET_PDEATHSIG` fires within a millisecond, unprompted

A child arms `PR_SET_PDEATHSIG(SIGTERM)`, and the parent exits without ever explicitly signaling it:

```
$ python3 pdeathsig_demo.py
[parent pid=...] child pid=... armed PR_SET_PDEATHSIG(SIGTERM); parent now exits WITHOUT killing the child
$ cat pdeathsig_result.txt
signaled=True elapsed=0.0003644069656729698
```

0.36 ms from parent exit to the child's own `SIGTERM` handler firing — confirming the man page's guarantee, and showing it's fast enough to rely on for immediate child cleanup when the parent is a single, un-threaded process. We did not attempt to reproduce the multi-threaded footgun from `golang/go#27505` (it requires a specific parent-thread-exits-independently setup); we report it here as a documented, filed issue rather than as something we verified locally.

### 5.5 pidfd avoids the PID-reuse race

A short-lived process is spawned, its pidfd is opened and used to reap it, then ~4,000 more processes are forked and reaped to push the kernel's PID allocator forward:

```
$ python3 pidfd_demo.py
[demo] target pid=2024410, opened pidfd=3
[demo] reaped via pidfd: posix.waitid_result(si_pid=2024410, si_uid=1000, si_signo=17, si_status=0, si_code=1)
[demo] spawning ~4000 short-lived processes to force PID counter forward...
[demo] is numeric pid 2024410 alive again right now? False
[demo] pidfd_send_signal(original pidfd, sig=0) -> OSError errno=3 (No such process)
[demo] this proves the pidfd is bound to the exact task, not the recycled PID slot: it fails safe with ESRCH=True instead of silently signaling the new process
```

With the default `pid_max` of 4,194,304 on this machine, 4,000 forks were nowhere near enough to force an actual numeric collision (confirmed: the old PID was not reissued in this run) — reliably forcing a real reuse would mean lowering `pid_max` via `sysctl`, which requires root and which we deliberately avoided. What we *did* verify directly is the safety property that makes the race moot: signaling through the original pidfd after the target is reaped fails closed with `ESRCH`, rather than succeeding against whatever unrelated process might later hold that number. That's the guarantee the man page documents, and it's what actually matters operationally — a harness using pidfd cannot be tricked into signaling the wrong process no matter what the numeric PID situation looks like later.

## 6. A practical recipe for agent harnesses

1. **Give every tool call its own confinement boundary at spawn time**, not as an afterthought at kill time. A cgroup v2 leaf (via `systemd-run --user --scope` where a user session/lingering is available, or a manually delegated cgroup subtree otherwise) beats a bare new session/process group, because daemonizing does not take a process out of it. If tool calls are untrusted, also make sure they cannot write to the delegated subtree (see Section 3.5).
2. **Still call `setsid()`/`start_new_session=True`** even with cgroup confinement — it's free, stops stray terminal `SIGINT`/`SIGHUP` from reaching the tool call, and keeps `killpg()` a valid fast path when nothing escapes.
3. **Set `PR_SET_CHILD_SUBREAPER`** on the process that owns tool-call lifecycles (or run under `tini -s`/`dumb-init`), so anything that does escape its process group is at least reparented somewhere the harness can enumerate, instead of vanishing into init.
4. **Track children by pidfd, not raw PID**, once your runtime supports it; treat `ESRCH` on signal-by-pidfd as authoritative proof the process is gone, not `kill(pid, 0)`.
5. **Escalate TERM → KILL on a deadline.** SIGTERM can be caught or ignored; SIGKILL cannot.
6. **Verify emptiness at the confinement boundary**, not by re-checking remembered PIDs: poll `cgroup.events`'s `populated` field after triggering `cgroup.kill` / stopping the scope. A remembered PID may already have been reused by something else.
7. **Reap, always.** A signal-and-forget without an eventual `wait()`/`waitid()` leaks a zombie table entry per tool call — over a long agent session, that's a slow PID-exhaustion bug.
8. **Report leftovers as a first-class failure.** If the confinement boundary still reports non-empty after TERM, KILL, and `cgroup.kill`, that's worth surfacing — it means the isolation model itself was insufficient.

### Mechanism comparison

| Mechanism | Escape-proof? | Needs root? | Min. kernel | Race-free addressing? | Notes |
|---|---|---|---|---|---|
| Process group / session (`setsid`, `killpg`) | No — defeated by `setsid()`/`setpgid()` in a descendant | No | Any | No (numeric PID/PGID) | Default in Node `detached`, Python `start_new_session` |
| `PR_SET_PDEATHSIG` | No — only covers direct parent-thread death, cleared on `fork()`/setuid exec | No | Any (long-standing) | N/A (signal, not addressing) | Per-thread, not per-process; Go footgun (`golang/go#27505`) |
| `PR_SET_CHILD_SUBREAPER` | No — makes escapees *discoverable*, doesn't kill them | No | 3.4+ | N/A | Must still enumerate + act; what `tini -s` uses |
| `pidfd_open`/`pidfd_send_signal` | N/A — addressing mechanism, not confinement | No | 5.1–5.4 (open 5.3, send 5.1, waitid P_PIDFD 5.4) | Yes — fails `ESRCH` instead of hitting a reused PID | Combine with a confinement mechanism, doesn't stop trees alone |
| cgroup v2 `cgroup.kill` | **Yes** against daemonizing; a same-UID process with write access to the delegated subtree can migrate out | No (with delegation) | 5.14+ | Yes (kills by cgroup membership, not PID) | Membership survives `setsid()`/`setpgid()`; needs a delegated subtree |
| `systemd-run --user --scope` + stop | **Yes** against daemonizing (cgroup-backed, same caveat) | No (needs user session/lingering) | cgroup v2 (systemd kills every member of the unit's cgroup on stop) | Yes | Gets you naming, `systemctl status`, and automatic cgroup cleanup for free |
| PID namespace (kill ns init) | **Yes**, absolutely | Usually (or user namespaces) | Namespaces widely available; heavier setup | Yes | Heaviest option; whole namespace dies with its init |
| `tini`/`dumb-init` (default) | No — forwards to one child only | No | N/A (userspace) | N/A | Needs `-g`/`TINI_KILL_PROCESS_GROUP` for group-wide forwarding, `-s` for subreaper |

The practical takeaway from this table: nothing that is merely a *signaling* trick (process groups, PDEATHSIG, pidfd) survives a daemonizing descendant, because all of them address processes through ancestry or group membership that the descendant can leave. The two mechanisms that do survive it, cgroups and PID namespaces, work by *confinement* rather than addressing. They ignore which session or process group a task claims and look only at the container it belongs to. A PID namespace cannot be left from inside. A cgroup can be left only by a process with write access to the surrounding subtree, so for untrusted tool calls that write access must be removed as well.

## Sources

- [prctl(2) — man7.org](https://man7.org/linux/man-pages/man2/prctl.2.html)
- [PR_SET_PDEATHSIG / PR_GET_PDEATHSIG — man7.org](https://man7.org/linux/man-pages/man2/PR_SET_PDEATHSIG.2const.html)
- [pid_namespaces(7) — man7.org](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html)
- [pidfd_open(2) — man7.org](https://man7.org/linux/man-pages/man2/pidfd_open.2.html)
- [pidfd_send_signal(2) — man7.org](https://man7.org/linux/man-pages/man2/pidfd_send_signal.2.html)
- [waitid(2) — man7.org](https://man7.org/linux/man-pages/man2/waitid.2.html)
- [Control Group v2 — The Linux Kernel documentation (docs.kernel.org)](https://docs.kernel.org/admin-guide/cgroup-v2.html)
- [systemd.kill(5) — man.archlinux.org mirror](https://man.archlinux.org/man/systemd.kill.5)
- [systemd-run(1) — man.archlinux.org mirror](https://man.archlinux.org/man/systemd-run.1)
- [GNU coreutils manual: timeout invocation](https://www.gnu.org/software/coreutils/manual/html_node/timeout-invocation.html)
- [tini README (krallin/tini)](https://github.com/krallin/tini#readme)
- [Node.js child_process documentation](https://nodejs.org/api/child_process.html)
- [Python subprocess documentation](https://docs.python.org/3/library/subprocess.html)
- [opencontainers/runc issue #3135 — adopt cgroup.kill](https://github.com/opencontainers/runc/issues/3135)
- [OpenHands/software-agent-sdk issue #4910 — ACP subprocess leaf process orphaned on shutdown on POSIX systems](https://github.com/OpenHands/software-agent-sdk/issues/4910)
- [openai/codex issue #7932 — Background Process Leak + Missing Job Control](https://github.com/openai/codex/issues/7932)
- [Unitech/pm2 issue #1036 — pm2 now kills detached processes](https://github.com/Unitech/pm2/issues/1036)
- [golang/go issue #27505 — syscall: misleading documentation for linux SysProcAttr.Pdeathsig](https://github.com/golang/go/issues/27505)
- [golang/go issue #13987 — os: on unix Process.Kill() can kill the wrong process](https://github.com/golang/go/issues/13987)
- [tetratelabs/func-e issue #173 — Incorrect use of Pdeathsig for killing child on linux](https://github.com/tetratelabs/func-e/issues/173)
- [LWN.net — cgroup: introduce cgroup.kill](https://lwn.net/Articles/855924/)
