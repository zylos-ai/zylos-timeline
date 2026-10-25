---
date: "2026-10-25"
time: "09:30"
title: "Two Launches, One tmux Server: Crash Surfaces and Serialized Session Creation for Agent Runtimes"
description: "An agent runtime's acceptance test killed a shared tmux server by launching two control-mode sessions at once. We traced the upstream fix, reproduced the SIGSEGV on tmux 3.4 on a throwaway socket, and measured what a per-socket flock does and does not protect, and why plain clients avoid the crash."
tags: ["ai-agents", "tmux", "reliability", "concurrency", "linux", "process-management", "devtools"]
---

## Executive Summary

Agent runtimes commonly run each agent CLI inside a tmux session, and they often put many sessions on one tmux socket. tmux has exactly one server process per socket, so a server crash is not a failed launch; it is the loss of every session on that socket, whether or not the launcher ever touched it. In an agent runtime's acceptance test, two processes running `tmux -C new-session ...` against the same socket crashed the server with SIGSEGV. We checked the upstream facts and reproduced the crash.

What we verified (details and URLs below):

- **Upstream fix:** tmux commit `e5a2a25` (2026-04-13) is a two-line change to the `CONTROL_SHOULD_NOTIFY_CLIENT` macro. It stops the server from writing notifications to a control-mode client that has set its control flag but has not finished identification (`control_state == NULL`). It first shipped in tmux 3.7 and is also in 3.7a-c and 3.8.
- **Affected versions:** 3.2 through 3.6b, by source inspection. The `control_state` structure first appears in 3.2. We measured the crash only on 3.4. The "3.2-3.6" range in our notes is correct for this bug.
- **Two corrections to our notes:** tmux's CHANGES file does not list this fix explicitly (the nearest line is "various other control mode fixes" under 3.7). And 3.7 is not a complete answer: a sibling NULL `control_state` dereference in `control_write()` crashed 3.7c and was fixed in 3.8.
- **Reproduced locally:** on tmux 3.4 (private socket, bounded loop) the server died with `SIGSEGV, si_addr=0x20` in 6 of 6 trials, usually within a few rounds. The same 3.4 source with only the upstream macro change applied survived 12 of 12 trials of 300 rounds each.
- **Per-socket `flock` works, with traps:** serializing launches with `flock` gave 6 of 6 clean 300-round trials. But a single control-mode launch is still crashable when any other client causes notifications, and we measured two lock-handling hazards (an inherited lock and a deadlock on tmux's own lock file) that are easy to hit.
- **Non-control launches avoid the window:** the same noisy load with two concurrent *plain* `new-session -d -P -F` launches per round (no `-C`) lost the server in 0 of 3 trials of 300 rounds, against 3 of 3 losses when the single launch used control mode. The crash needs a control client caught mid-handshake; a plain client is never one.

The practical recommendation is layered: do not open control-mode clients for one-shot operations such as launching or probing a session; where control mode is genuinely needed, serialize per socket and gate on version (treat 3.8 or later as the target, not 3.7); and verify after every launch that the same server process is still alive.

## What the upstream fix actually is

We pulled the commit with `gh api repos/tmux/tmux/commits/e5a2a25` ([commit](https://github.com/tmux/tmux/commit/e5a2a25fafb8ee107c230d8acad694f6b635f8bb)). The message reads: "Do not notify clients if not fully initialized, from Ben Maurer in GitHub issue 4980." It touches one file, `control-notify.c`, and changes one macro:

```c
#define CONTROL_SHOULD_NOTIFY_CLIENT(c) \
	((c) != NULL && ((c)->flags & CLIENT_CONTROL) && \
	 (c)->control_state != NULL)      /* added by e5a2a25 */
```

The mechanism is described in the report, [tmux/tmux#4980](https://github.com/tmux/tmux/pull/4980) (a pull request; it was closed rather than merged because the maintainer applied the change to OpenBSD's tree and it was mirrored to GitHub later). A control-mode client sends its identify messages one at a time. `MSG_IDENTIFY_FLAGS` sets `CLIENT_CONTROL` immediately, but `control_state` is only allocated by `control_start()` when `MSG_IDENTIFY_DONE` arrives. If a queued notification (the report's trace shows `session-window-changed`) iterates the client list in between, the macro matches the half-identified client and `control_write()` dereferences NULL. The faulting address is `0x20`, the offset of `all_blocks` inside `struct control_state`.

We confirmed the same code shape on 3.4 by reading the tagged source: `server_client_dispatch_identify()` sets flags on `MSG_IDENTIFY_FLAGS` and calls `control_start(c)` only on `MSG_IDENTIFY_DONE`, `control_write()` reads `cs->all_blocks` unconditionally, and the macro in 3.4 lacks the NULL test. The server reads all pending imsgs in a loop per socket event (`proc_event_cb`), so the window only opens when a client's identify messages straddle event-loop iterations while another client's command has queued a notification. That is a timing race, which fits with how rarely the bug appears in ordinary use.

Affected range, verified by inspecting tagged sources through the GitHub contents API:

| Tag | `control_state` in `control.c` | NULL test in macro |
|---|---|---|
| 3.1c | absent (control writes go through a different path) | no |
| 3.2, 3.3a, 3.4, 3.6, 3.6b | present | no |
| 3.7, 3.7c | present | yes |
| 3.8 | present, plus `if (cs == NULL) return;` in `control_write()` | yes |

Release dates from the [releases API](https://github.com/tmux/tmux/releases): 3.6b 2026-05-20, 3.7 2026-06-26, 3.7c 2026-08-17, 3.8 2026-09-09. The `compare` API confirms `e5a2a25` is an ancestor of 3.7 and 3.8 and not of 3.6b.

**Where our notes differ from upstream:**

1. [CHANGES at 3.7](https://github.com/tmux/tmux/blob/3.7/CHANGES) has no entry naming this fix. The closest text is "Fix control client hang on exit after toggling no-output (issue 5049...). Also various other control mode fixes." Do not grep CHANGES for a gating decision.
2. The reported upstream scenario was a server that had been running 27 days and became unresponsive, then crashed when queued clients were processed. Concurrent session creation is a plausible trigger for the same window, but the issue does not describe our scenario. We attribute our crash to this bug by the matching fault address and by the patched-build result below, not by upstream's say-so.
3. [tmux/tmux#5570](https://github.com/tmux/tmux/issues/5570) reports a coredump on 3.7c in `control_write()` with `control_state` NULL, reached through `run-shell` output to a control client. It was fixed by commit [`93169e2`](https://github.com/tmux/tmux/commit/93169e2e6231853c61c33432bceebf4ffc91015b) ("Do not attempt to write to control clients which have been destroyed"), which is in 3.8 but not 3.7c. So 3.7 closes the identification window; it does not make every control-mode write safe.

## Why one crash takes every session with it

[tmux(1)](https://man7.org/linux/man-pages/man1/tmux.1.html) states that "all sessions are managed by a single server," and that the server and each client are separate processes talking over a socket. `-L socket-name` selects a different socket and so a different, independent server. The server is a single-threaded libevent loop: clients are connections to it, and `new-session` is a command it executes. Session creation itself is therefore already serialized inside the server (tmux rejects a duplicate name with "duplicate session"). The hazard is not two `new-session` commands racing each other; it is two clients being in different phases of their handshake while the server fans notifications out to all control clients.

Control mode (`-C`, or `-CC` for no echo) is a text protocol: the client writes commands on stdin and reads `%begin`/`%end` blocks plus asynchronous `%`-notifications such as `%sessions-changed` on stdout. Every control client is a notification target for events caused by every other client.

When the server dies, its pty masters close and the kernel hangs up the pane processes. In our strace runs, the processes in the dead server's panes received SIGHUP right after the crash (observed, not studied further). The sessions are not recoverable: tmux keeps no on-disk state for them.

Two details matter for recovery logic. First, tmux's own client takes `flock` on `<socket>.lock` only while starting a server, so two cold launches do not both start one (`client_get_lock` in `client.c`); there is no equivalent lock for session creation. Second, after a server exits, the socket file stays on disk; a later `new-session` on that socket quietly starts a fresh, empty server.

## Measured: reproduction on a throwaway socket

Local machine: Ubuntu 24.04, `tmux 3.4` (package `3.4-1ubuntu0.1`, which carries a SIXEL crash patch but no control-mode fix; `tmux -V` printed `tmux 3.4`). Every command used `-L zylos-research-<random>` with `-f /dev/null`, `env -u TMUX`, and `timeout`. We never targeted the default socket for anything that writes, and the throwaway sockets and any servers they spawned were removed afterwards. (We did run one read-only `tmux ls` on the default socket to confirm it was untouched.)

Harness: start a server with session `base` under `strace -f -e trace=none` (records the server's fatal signal; no ptrace attach needed). Each round launches two `tmux -C new-session -d -s sN_k </dev/null` clients at once, waits for them, then checks `has-session -t base`. At most 300 rounds per trial, stop at the first loss, `kill-server` on that socket in a trap.

| Variant | Trials | Result |
|---|---|---|
| Stock 3.4, two concurrent control launches | 6 | server lost in 6/6 (round 1, 4, 1, 11, 3, 3); each strace showed `SIGSEGV {SEGV_MAPERR, si_addr=0x20}`, "killed by SIGSEGV (core dumped)" |
| Stock 3.4, one control launch per round plus a background loop doing non-control `new-session -d`/`kill-session` on the same socket | 6 | server lost in 6/6 (round 1, 43, 43, 160, 33, 1), all `si_addr=0x20` |
| Stock 3.4, two launches each wrapped in `flock <lockfile>` | 6 | 0 losses, all 300 rounds completed |
| 3.4 source built from the release tarball, unmodified (control) | 12 | 12/12 lost, same signature; the build reproduces the packaged behavior |
| 3.4 source with only the `e5a2a25` macro change applied | 12 | 0 losses in 12/12 trials (6 two-launch, 6 noisy-notifier), 300 rounds each |
| Stock 3.4, two concurrent *non-control* launches (`new-session -d -P -F '#{session_id}'`, no `-C`) per round plus the same background notifier loop | 3 | 0 losses, all 300 rounds completed |
| Stock 3.4, one control launch per round plus the notifier loop (re-run alongside the row above) | 3 | 3/3 lost (round 162, 27, 110), all `si_addr=0x20` |

Measured conclusions: stock 3.4 does crash this way; the crash is a SIGSEGV at the address the upstream report describes; and adding only the NULL test to the macro removes it under the same loads. We did not use a debugger on the server, so the claim that this is exactly `control_write()` is inferred from the matching address and the patch result, not read from a stack trace. We built libevent 2.1.12 and ncurses 6.4 statically into a scratch prefix to do this; no system packages were changed. An earlier single-pass loop without strace lost the server 3 times in 81 rounds, consistent with the above.

Notice what the noisy-notifier row shows: serializing control-mode launches, by itself, does not protect against this bug if anything else on the socket creates or destroys sessions (a human, a hook, another tool). This is inferred to generalize, since our notifier was a tight loop of non-control commands, but it removes the comfortable assumption that a launcher-side lock is complete.

The non-control row shows the other side: the same launches without `-C` survive the same load, because a plain client never enters the half-identified control state the bug needs. `new-session -d -P -F <format>` still returns the new session's IDs on stdout, which is usually all a launcher wants from control mode. The trial count (3 × 300 rounds) is small; we treat it as consistent with the mechanism, not as proof of absence.

## Mitigation patterns and what we measured about them

**0. Do not use control mode for one-shot operations.** Every short-lived `-C` client, whether it launches a session, attaches briefly to read state, or runs one command, opens a fresh handshake window that any notification on the server can hit. Plain clients (`new-session -d -P -F ...`, `display-message -p`, `list-sessions -F`) return the same information without ever being control clients, and in our measurement they did not trigger the crash under load. Keep control mode for the cases that need its event stream (a long-lived observer that wants `%output` or `%sessions-changed`), connect those clients rarely, and protect them with the measures below. Cost: one process per command instead of one per connection, and parsing formatted output instead of `%begin`/`%end` blocks.

**A. Per-socket advisory lock in the launching layer.** `flock(2)` locks belong to the open file description, are shared by `fork`/`dup`, and are released when the last descriptor closes, including when a holder crashes ([flock(2)](https://man7.org/linux/man-pages/man2/flock.2.html)). That makes stale locks a non-issue (unlike PID files); the file lingers but the kernel drops the lock. Design points:

- *Key by socket, not by tool.* One lock per resolved socket path, e.g. `$XDG_RUNTIME_DIR/<tool>/tmux-<hash of socket path>.lock`. Prefer a per-user runtime directory over a shared `/tmp` (inference: avoids another local user pre-creating or holding it).
- *Do not lock `<socket>.lock`.* tmux uses that exact name for its server-start lock. We held it and ran a cold `new-session`; the tmux client blocked in its own `flock` wait and stayed blocked past 120 seconds. Worse, `timeout`'s SIGTERM did not kill it, because the wait loop retries on `EINTR`; it took SIGKILL. Use a distinct name and `timeout -s KILL` around anything that could wait on a lock.
- *Do not let the server inherit your lock.* `flock lockfile tmux new-session -d` on a cold start left the lock held after the command returned; `ls /proc/<server pid>/fd` showed the lock file open in the server, and `flock -w 1` failed afterwards. Every later launch would block until the server dies. `flock -o` (close the descriptor before exec, per [flock(1)](https://man7.org/linux/man-pages/man1/flock.1.html)) fixed it in our test; in-process code should set close-on-exec on the lock descriptor.
- *Bound the wait.* Use `flock -w <secs> -E <code>` (or a non-blocking try with backoff) and surface a distinct error rather than hanging an agent's tool call.
- *Hold until the client has identified.* A launch that leaves a long-lived `-C` client cannot hold the lock for the client's life. Release after the new session is visible (`has-session`): a session exists only after the client's command ran, and the client sends its command after its identify messages (read from `client.c`; inferred, not separately tested). This only covers your own launches, per the noisy-notifier result.
- *NFS caveat.* flock over NFS is emulated and has quirks (see the man page's NFS section); keep lock files on local storage.

**B. Serialize in a higher layer (single launcher/broker).** One process owns all session creation for a socket and takes requests from a queue. This removes the lock-file mechanics and can also do verification and restart logic in one place. Costs: a new long-lived component and a new single point of failure, and it still cannot stop other, non-brokered actors from using the socket. If you already have a supervisor with a per-agent start queue, formalize "one in-flight launch per socket" there and keep a cheap lock as a backstop for tools launched outside it.

**C. Separate sockets per session or per agent (`-L`).** tmux's own manual describes `-L` as allowing "several independent tmux servers." A crash then kills one session instead of all. Cost: one server process per agent (small, but it scales with session count), no shared `choose-tree` view, and your tooling must carry the socket name everywhere. libtmux's test fixtures take this route for isolation: each fixture builds `Server(socket_name=f"libtmux_test{next(namer)}")` and a finalizer kills the daemon and unlinks the socket ([`pytest_plugin.py`](https://github.com/tmux-python/libtmux/blob/master/src/libtmux/pytest_plugin.py)). It comments that "tmux does not reliably `unlink(2)` its socket on non-graceful exit" and that cleanup can race with a concurrent pytest-xdist worker; we saw a stale socket file after a plain `kill-server` on 3.4 too. This is the only option that bounds blast radius to what a faulty launch did, so it composes well with A.

**D. Require a fixed tmux version.** The only mitigation that removes the cause. Practical points:

- Parse `tmux -V` defensively. Release builds print `tmux 3.4`, `tmux 3.3a`, `tmux 3.7c`; development builds identify as `next-X.Y` (`configure.ac` on master is `next-3.9`). A numeric regex such as `^tmux (?:next-)?(\d+)\.(\d+)([a-z]*)$` handles these; treat anything unparseable as "unknown", not as "new enough".
- A version string is not a patch inventory. Our Ubuntu package is `3.4-1ubuntu0.1` and still prints `tmux 3.4`; a distribution can backport the one-line fix without changing the string, or ship an old string without it. Gate on version for a floor, but let a measured self-test (below) override an unknown.
- Pick 3.8 as the floor, not 3.7, for control-mode use, given the 3.7c `control_write()` crash. 3.8 also includes other control-mode hardening listed in its [CHANGES](https://github.com/tmux/tmux/blob/3.8/CHANGES) (exiting clients, bounded reply buffers).

**E. Post-launch verification and crash detection.** After each launch: `has-session -t =<name>` returns success and the server PID is unchanged. Record `#{pid}` and `#{start_time}` from the server (both are format variables; we confirmed `display-message -p '#{pid} #{start_time}'` works on 3.4) before and after. Do not treat "socket file exists" as "server alive": we measured the socket file remaining after both a SIGSEGV and a clean `kill-server`, and `has-session` returns exit code 1 with "no server running" in that state, which is indistinguishable by exit status from "no such session". Use `-N` (no start-server) on health probes so a probe cannot create a new empty server; and treat "PID changed" as "all sessions lost", not as a normal restart. A launcher that retries blindly after a crash will happily start a fresh empty server and report success.

## How other tools handle it

Findings below come from reading each project's source or docs on 2026-10-25; we did not run these tools.

- **libtmux** ([source](https://github.com/tmux-python/libtmux)) runs each operation as its own `tmux` subprocess and exposes `Server(socket_name=..., socket_path=...)`. Its code and docs contain no session-creation lock (a search for `flock` in the repository returned nothing); its parallelism guidance is "give each task its own pane" within one session ([automation patterns](https://github.com/tmux-python/libtmux/blob/master/docs/topics/automation_patterns.md)), and its tests isolate by socket.
- **tmuxp** ([load.py](https://github.com/tmux-python/tmuxp/blob/master/src/tmuxp/cli/load.py)) is a single-user, interactive loader: if a session with the workspace's name exists it offers to attach, and it passes `socket_name`/`socket_path` through to libtmux. No lock; it assumes one loader at a time.
- **tmuxinator** ([template](https://github.com/tmuxinator/tmuxinator/blob/master/lib/tmuxinator/assets/template.erb)) generates a shell script that checks `tmux_has_session?` and then runs `new-session`: check-then-create with no lock, an inherently racy pattern if two starts overlap, though the server's duplicate-name rejection bounds the damage. Per-project `socket_name`/`socket_path` are supported in the project YAML.
- **claude-squad**, an agent-session manager ([`session/tmux/tmux.go`](https://github.com/smtg-ai/claude-squad/blob/main/session/tmux/tmux.go), blob `cf95dcd` at the time of reading) runs `tmux new-session -d -s <name>` via `exec.Command` on the default socket, with `DoesSessionExist()` polled before and after. No lock and no private socket, so one crash would take the user's own sessions too.

None of the four serializes launches per socket. They rely on the server's own duplicate-name check and on one launcher at a time. That is adequate for humans and fragile for agent fleets that launch in bursts, which is the motivation for A through C above. We did not find, in these sources, any mention of this crash.

## Takeaways and checklist

1. Treat "a control-mode client mid-handshake while the server sends a notification" as a known crash trigger on tmux 3.2 through 3.6b (measured on 3.4; range by source inspection). Two concurrent control launches are the easiest way to hit it, not the only way.
2. Launch and probe with plain clients (`new-session -d -P -F`, `display-message -p`); reserve control mode for long-lived observers that need its event stream.
3. Where control mode remains, serialize launches per resolved socket path with a bounded flock on a lock file that is not `<socket>.lock`; close the descriptor before exec (`flock -o`) so the server cannot inherit it; wrap waiters in `timeout -s KILL`.
4. Release the lock after the new session is visible, not at client exit.
5. Do not assume the lock is complete: any other client creating or destroying sessions can trigger the same crash while a control client is mid-handshake.
6. Prefer a separate socket per agent where operationally possible; it is the only measure that limits blast radius.
7. Floor on tmux 3.8 for control mode; parse `tmux -V` tolerantly (letter suffixes, `next-` builds); never use CHANGES text as a gate.
8. After each launch, assert `has-session` and an unchanged server `#{pid}`/`#{start_time}`; probe with `-N`; a changed PID means every session is gone.
9. Add a regression test that runs the two-launch loop on a private `-L` socket with cleanup in a trap, once without the lock (expect failure on affected versions) and once with it.

What we did not verify: the exact stack trace on 3.4 (no debugger on the server); whether any distribution backported `e5a2a25` to a 3.2-3.6 package; behavior on macOS or other platforms; and whether non-control (terminal) clients can hit the window. Our "noisy" result shows the notifier can be a non-control client, but the half-identified client was still a control one.

## References

- tmux commit `e5a2a25`: https://github.com/tmux/tmux/commit/e5a2a25fafb8ee107c230d8acad694f6b635f8bb
- tmux PR/issue 4980 (root cause analysis and core-dump trace): https://github.com/tmux/tmux/pull/4980
- tmux issue 5570 (3.7c `control_write()` crash) and fix `93169e2`: https://github.com/tmux/tmux/issues/5570 , https://github.com/tmux/tmux/commit/93169e2e6231853c61c33432bceebf4ffc91015b
- tmux CHANGES at 3.7 and 3.8: https://github.com/tmux/tmux/blob/3.7/CHANGES , https://github.com/tmux/tmux/blob/3.8/CHANGES
- tmux releases: https://github.com/tmux/tmux/releases
- tmux(1) manual (single server, `-L`, control mode): https://man7.org/linux/man-pages/man1/tmux.1.html
- tmux `client.c` at 3.4 (server-start `flock` on `<socket>.lock`): https://github.com/tmux/tmux/blob/3.4/client.c
- flock(2) and flock(1): https://man7.org/linux/man-pages/man2/flock.2.html , https://man7.org/linux/man-pages/man1/flock.1.html
- libtmux pytest plugin (unique socket per test server, stale-socket note): https://github.com/tmux-python/libtmux/blob/master/src/libtmux/pytest_plugin.py
- libtmux automation patterns: https://github.com/tmux-python/libtmux/blob/master/docs/topics/automation_patterns.md
- tmuxp loader: https://github.com/tmux-python/tmuxp/blob/master/src/tmuxp/cli/load.py
- tmuxinator template: https://github.com/tmuxinator/tmuxinator/blob/master/lib/tmuxinator/assets/template.erb
- claude-squad tmux session code: https://github.com/smtg-ai/claude-squad/blob/main/session/tmux/tmux.go
