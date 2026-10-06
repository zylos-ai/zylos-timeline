---
date: "2026-10-06"
time: "09:30"
title: "Watching Without Touching: Read-Only Observers for Live Agent Terminals"
description: "A read-only tmux viewer silently broke message delivery to an AI agent on tmux 3.7. The source-level cause, why the fix works, how other terminal-sharing tools define 'read-only', and rules for building observers that can't perturb the session they watch."
tags: ["ai-agents", "tmux", "terminal", "reliability", "observability", "testing"]
---

## Executive Summary

Many agent runtimes, Zylos among them, run an interactive coding agent inside a tmux session and feed it work by injecting text: `tmux set-buffer` / `paste-buffer` to place the message, then `tmux send-keys Enter` to submit it. A web dashboard lets humans watch the session by attaching a **read-only** tmux client (`tmux attach-session -r`).

On tmux 3.7, those two features collided. While anyone had the dashboard's viewer open, every `send-keys` from the runtime failed with `client is read-only`. Pasted text still reached the agent's input box, but the Enter that submits it was refused, so messages sat in the box and were never processed. The viewer had done nothing; it was simply *attached*.

The cause, traced through tmux's source:

- `send-keys` resolves a **target client** even when the caller never names one. Without `-c`, tmux picks the session's "best client", which is simply the client with the most recent activity. A freshly attached viewer often wins.
- In tmux 3.7, a security fix (commit `49bb430`, PR #4881) made `send-keys` refuse to act when its target client is read-only. That correctly closes a hole where a read-only user's own key binding could run `send-keys`. As a side effect, an unrelated automation process that happens to resolve to the viewer is refused too.
- `set-buffer`, `paste-buffer` and `load-buffer` have no such check. That is why the text arrived but the submit didn't.

The fix shipped in zylos-core PR #810. On tmux ≥ 3.4, the runtime passes `send-keys -c <name-that-matches-no-client>`. The lookup quietly returns no client, the read-only check is skipped, and the keys still go to the pane named by `-t`.

The broader lessons are about what "read-only" actually means:

- Most viewer tools carefully block *typing* but still let viewers influence the session in other ways: terminal size (ttyd, gotty, upterm), the target of implicit lookups (tmux), or a whole command channel (tmux control mode).
- The robust patterns are:
  - **observers that are structurally one-way**: capture or stream the output instead of attaching a client;
  - **automation that never relies on implicit "current" resolution**;
  - **delivery that counts a message as delivered only once it has been submitted**;
  - **tests that attach a real read-only client in an isolated server, with a positive control.**

## The Incident

The setup is common in agent infrastructure:

```
 channel bots ──► message queue ──► dispatcher ──► tmux session "claude-main" (agent TUI)
                                       │ set-buffer + paste-buffer   (text)
                                       │ send-keys Enter             (submit)
 web dashboard ──► tmux attach-session -r  (human watches the agent work)
```

The dashboard only starts its viewer while someone has the observer page open, and detaches a few seconds after they leave. On one machine running tmux 3.7c, messages began failing in a pattern that made sense only in hindsight: failures came and went with whether someone was watching.

The dispatcher's structured log is what made the diagnosis tractable. Every failed message showed the same shape:

```
paste_attempt → paste_sent            (text placed in the input box: OK)
enter_attempt → enter_failed          (submit refused)
```

The text was in the agent's input box. Only the submit was missing. On a second machine running tmux 3.4, the identical setup (viewer attached, same dispatcher) delivered normally. So this was something that changed in tmux between 3.4 and 3.7, not something in the agent or the queue.

## Inside tmux: How a Viewer Became the Target

### `send-keys` always has a target client, even when you don't name one

`send-keys` is declared with `CMD_CLIENT_CFLAG` (see `cmd-send-keys.c`), which means tmux resolves a target client for it from `-c`. If `-c` is absent, `cmd_find_client()` falls back to the "current client". When the command arrives from outside tmux (a dispatcher process has no `$TMUX`), that means the **best client** of the best session.

Best-client selection is purely about recency. From `cmd-find.c`:

```c
static int
cmd_find_client_better(struct client *c, struct client *than)
{
	if (than == NULL)
		return (1);
	return (timercmp(&c->activity_time, &than->activity_time, >));
}
```

Nothing in this comparison knows about read-only flags. And a newly connected client starts with `activity_time` set to its creation time (`server-client.c`, `memcpy(&c->activity_time, &c->creation_time, ...)`). So a dashboard viewer that has just attached holds the most recent activity in the session and becomes the implicit target of every `send-keys` that doesn't name a client.

Before tmux 3.7 this didn't matter: the target client was resolved, but `send-keys` didn't care whether it was read-only.

### The check that changed: a security fix with a side effect

tmux 3.7 added this guard to `cmd_send_keys_exec()`:

```c
if (tc != NULL && tc->flags & CLIENT_READONLY && !args_has(args, 'X')) {
	cmdq_error(item, "client is read-only");
	return (CMD_RETURN_ERROR);
}
```

It came in with commit `49bb430` ("Allow copy mode to work for readonly clients, except for copy commands"), contributed in tmux PR #4881. The review thread explains the intent. The feature let read-only clients scroll in copy mode, and the maintainer asked whether `send-keys` without `-X` should still be allowed for them. The contributor replied that this was an oversight, that "the vulnerability can be triggered with a key bind", and added the guard. A one-line follow-up the next day (`bcbad05`, "tc can be NULL, so check before deref") added the `tc != NULL` test.

So the check is a deliberate security fix. Its job is to stop a **read-only user** from typing into the pane through a key binding. The CHANGES entry for 3.7 describes it only as a copy-mode change, and the man page still documents read-only clients purely in terms of the read-only user's own keys. Nothing in the documentation tells an automation author that a *different* process's `send-keys` can now be refused because a viewer is attached. We checked the commit ancestry directly: `49bb430` is in tag 3.7 and not in 3.6. We also searched tmux's GitHub issues and found none that describes this automation-side effect; the mailing list was not searched.

### Why the text still got through

The same source tree explains the split behaviour:

| Command | Resolves a target client? | Read-only check? | Result with a viewer attached (tmux 3.7) |
|---|---|---|---|
| `paste-buffer` | No (flags are `CMD_AFTERHOOK` only) | None | Text pasted |
| `set-buffer`, `load-buffer` | Yes (`-t`, may fail quietly) | None in their exec functions | Buffer set |
| `send-keys` (no `-c`) | Yes: best client, often the viewer | Yes (`CLIENT_READONLY`) | **Refused** |
| `send-keys -X` (copy-mode command) | Yes | Exempt | Allowed |

The runtime used two different mechanisms for one logical operation, "deliver a message", and only one of them acquired a new failure mode. That's why the symptom was partial delivery rather than a clean failure.

## The Fix, and Why It Works

zylos-core #809 / PR #810 changes every key send in the core (Enter and Escape) to:

```
tmux send-keys -c zylos-no-client -t <session> Enter      # tmux >= 3.4
tmux send-keys -t <session> Enter                         # older tmux, unchanged
```

Three tmux facts make this safe, all verified against commit ancestry:

1. **`-c` exists on `send-keys` since 3.4.** Commit `3b3f420` (December 2022, released in 3.4) added it, together with `-K`. Its documented purpose is narrow: with `-K`, keys are looked up in the named client's key table.
2. **A non-matching `-c` resolves quietly to "no client".** Three days later, commit `4d79d46` ("Allow send-keys without a client again") added `CMD_CLIENT_CANFAIL` to `send-keys`, also in 3.4. In `cmd_find_client()`, a target that matches no client's name or tty returns `NULL`, and with the can-fail flag the command proceeds instead of erroring with `can't find client`.
3. **A `NULL` target client skips the read-only guard.** The guard starts with `tc != NULL`. The keys still go to the pane named by `-t`, which is resolved independently of any client.

The name `zylos-no-client` was chosen so that it can't collide with a real client. tmux matches `-c` against client names and tty paths (`/dev/pts/N` or `pts/N`), so a word with no slash and no `pts` prefix matches nothing.

Two practical details matter for anyone copying this.

**Gate on the version where the escape hatch exists, not where the bug appears.** The bug needs 3.7, but the fix works from 3.4, so applying it from 3.4 onward protects against future tightening too. Below 3.4, `-c` isn't accepted by `send-keys` at all, so the old argument list must be kept. The independent Python library libtmux draws the same line: its `Pane.send_keys(target_client=...)` passes `-c` only when `has_gte_version("3.4")` and otherwise ignores the option with a warning.

**Parse real-world version strings, and fail loudly to the old behaviour.** `tmux -V` prints release versions like `3.4`, patch letters like `3.7c`, and development builds like `next-3.9`. A build straight from git can even print `master`. The zylos-core parser accepts an optional `next-` prefix and trailing letters. Anything it can't parse falls back to the pre-fix argument list and logs a one-time warning naming the reason. That is deliberately conservative: an unknown tmux gets today's behaviour, not a guess.

This interaction is not unique to one project. At least three other open-source agent or terminal tools have merged or proposed fixes with titles describing the same collision:

- omnigent, PR #6028: "deliver web chat keystrokes despite a read-only-only tmux client set"
- ccbot, PR #232: "Fix tmux input from read-only Linux clients"
- regulus-office, PR #109: "sendKeys via tmux buffers so it works while a watcher is attached"

They solve it in different ways. Some route everything through paste buffers; others isolate the socket. Anyone driving a TUI through tmux and also offering a "watch" view will eventually meet tmux 3.7.

## "Read-Only" Is Not One Property

The incident is a narrow tmux story, but it points at a general gap. Tools offering a view-only mode almost always block **typed input**. They are much less consistent about the other ways an attached viewer can influence a shared session:

- the **terminal size** the session renders at;
- being picked as the **target of implicit lookups**;
- having its own **command channel** to the server.

A survey of common terminal-sharing mechanisms, checked against source where noted:

| Mechanism | How read-only is enforced | Can the viewer still affect the session? |
|---|---|---|
| tmux `attach -r` | Server-side: `CLIENT_READONLY` drops the viewer's keys and refuses commands not marked `CMD_READONLY` | Yes, indirectly: it can become the "best client" for other callers (above). `-r` also sets `ignore-size`, so it doesn't shrink the window. `-f read-only` alone would not |
| tmux control mode (`-C`/`-CC`) + read-only | Typed keys are dropped | **Yes.** Commands arriving over the control pipe go through `control.c` and `cmd-parse.y`, where neither `CLIENT_READONLY` nor `CMD_READONLY` appears. A "read-only" control client can still issue commands |
| tmux `capture-pane` polling / `pipe-pane` | No client is attached at all | No input path exists |
| ttyd (without `-W`) | Server-side: `case INPUT: if (!server->writable) break;` | **Size:** the `RESIZE_TERMINAL` case has no writable check. Harmless with one pty per connection; it matters when ttyd fronts a shared `tmux attach` |
| gotty (without `-w`) | Server-side input gate | **Size:** resize messages are not gated unless a fixed width/height is configured (per source survey) |
| upterm `--read-only` | Server-side: a read-only guest's stdin is read and discarded (`io.Copy(io.Discard, ...)`) | **Size:** the pty and window-change handling is registered before the read-only branch, so read-only guests' window changes still feed the shared terminal size |
| asciinema live streaming | Protocol is one-way by construction | No viewer-to-producer message type exists |
| GNU screen multiuser ACLs | One daemon checks write permission (`ACL_WRITE`) before forwarding any input to the pty | No separate size side channel was found |

Two patterns stand out.

The first is **input versus everything else**. ttyd, gotty and upterm, three independent codebases in C and Go, all gate keystrokes and all let a view-only participant's window size through. For a single-user pty that's harmless. For an observer of a *shared* session it's precisely the kind of channel through which a watcher changes what the watched program sees. tmux handles size correctly for `attach -r` only because `-r` is shorthand for `-f read-only,ignore-size`. The two properties are separate flags that happen to be bundled.

The second is **checks versus construction**. Every row with "Yes" has a bidirectional channel guarded by a check, and each check covers some paths but not all. The rows with "No" (`capture-pane`, `pipe-pane`, asciinema streaming) have no path back to the session at all. A missing check can't open a hole in a channel that doesn't exist.

## The Observer Effect Is an Old Problem

Systems people have a name for this: the **probe effect**. Jason Gait's 1986 paper "A Probe Effect in Concurrent Programs" described how inserting instrumentation delays into concurrent programs changes the frequency of the very errors being observed, sometimes hiding them entirely. The terminal-viewer case is a sibling: the observer doesn't change timing, it changes *state the observed system consults*.

Production systems have plenty of documented examples of "watching" that turns out to be "touching":

- **`docker attach`** proxies signals by default. With `--sig-proxy` true (the default), the Docker docs say plainly that "`CTRL-c` sends a `SIGINT` to the container". Someone who attaches to watch and presses Ctrl-C to leave signals the workload; the safe detach is Ctrl-P Ctrl-Q.
- **MySQL `SHOW PROCESSLIST`**, a monitoring command, was part of a documented three-way lock-order deadlock in certain Alibaba Cloud RDS MySQL 8.0 minor versions. Once triggered, the instance stopped accepting new connections, and even `SHOW GLOBAL STATUS` hung, so the monitoring lost visibility exactly when it was needed.
- **Chrome DevTools** being open made V8 stack-trace collection for console messages 5–10× slower in a case documented on the Chrome developer blog, because DevTools changes what V8 collects.
- **`kubectl attach`** and **`kubectl logs`** are the Kubernetes version of the same split. `attach` wires up the container's live stdin and TTY; `logs` only streams output. If all you want is to watch, use the tool with no input path.

The tmux case adds a twist worth naming. The viewer did nothing at all; its mere *presence* changed the outcome of a lookup that other software performed implicitly. That's the hardest kind of observer effect to anticipate, because nobody reviewing the viewer's code would find anything wrong with it.

## Design Rules for Observable Agent Sessions

The following rules are written as proposals for agent runtimes generally. For Zylos, item 2 is what shipped in #810; the rest are recommendations, not yet implemented.

**1. Prefer observers that are one-way by construction.** If the goal is to show a human what the agent is doing, `capture-pane` polling or a `pipe-pane` stream gives you the screen or the byte stream without attaching a client at all. That removes the best-client problem, the size problem and the command-channel problem in one move. The trade-off is fidelity and latency: polling at a few hertz looks less live than an attached client, and `pipe-pane` gives raw bytes you must render yourself. If you do attach, use plain `attach -r` (which bundles `ignore-size`). Don't use control mode as a "read-only" mechanism: its read-only flag doesn't restrict the command pipe.

**2. Automation must name its targets explicitly.** The tmux bug exists because `send-keys` was allowed to choose a client on the caller's behalf. The general rule applies far beyond tmux. Anything that resolves "current", "default" or "best" — a kube context, a default git remote, a default cloud profile — can be steered by whoever else happens to be present. Where a tool offers no way to say "none", look for a documented quiet-failure path like tmux's `CMD_CLIENT_CANFAIL`, and pin it with a test.

**3. A message isn't delivered until it's submitted.** Delivery here is two steps, and only the second one failed. A dispatcher that logged success after the paste would have reported every one of these messages as delivered. What made the diagnosis quick was the per-step event log (`paste_sent`, `enter_failed`) and a post-submit check that the input box is empty again. Treat each step as its own fallible operation, and record it that way.

**4. Version-gate from the upstream source, and degrade loudly.** Take the threshold from the project's own commit history or CHANGES file, not from a downstream comment. Handle the version strings that actually occur (letter suffixes, `next-X.Y`, `master`). When the version is unknown, fall back to the old behaviour and say so in the log. Capability probing (running the command against a throwaway server and checking the result) is the stronger option in principle. In the tmux ecosystem, though, the tools we looked at (tmux-plugins helpers, tmuxinator, libtmux) all parse `tmux -V` instead. A probe for this bug would need to attach a read-only client, and that is too heavy for a startup check.

**5. Test with a real read-only client, a positive control and a negative control.** The PR #810 test runs against an isolated tmux server (`-L` with a unique socket name, `-f /dev/null`). It attaches a genuine read-only client through `script` (util-linux on Linux; BSD `script` on macOS, with stdin redirected from `/dev/null`). It then polls `list-clients -F '#{client_readonly}'` until the client is registered, and checks two things:

- **The fixed path delivers** the message while the viewer is attached.
- **Positive control:** with `-c` removed, the same send fails with `client is read-only` on tmux ≥ 3.7. This proves the test actually exercises the read-only check. Without it, a passing test might only mean the viewer never attached.

A **negative control** completes the picture: run the baseline with no viewer attached and confirm it passes. Then, if the test goes red, you know it is reacting to the read-only client and not to something else. The fix was verified this way on four setups: Linux with tmux 3.4, Linux with 3.7c, macOS with 3.6a, and macOS with a locally built 3.7c. The fixed path passed on all four. The positive control can only fail where the check exists, so it was run on the two 3.7c setups, and failed there as expected. After release, the same check ran on a live machine running 3.7c with a read-only client attached. A message that had failed before the fix was now submitted, and the input box cleared.

A sketch of the core of such a test in shell:

```bash
SOCK="$(mktemp -u)"
tmux -S "$SOCK" -f /dev/null new-session -d -s target 'cat'
script -q -c "tmux -S $SOCK attach-session -r -t target" /dev/null &   # real read-only client
until tmux -S "$SOCK" list-clients -F '#{client_readonly}' | grep -q '^1$'; do sleep 0.05; done

# fixed path must succeed
tmux -S "$SOCK" send-keys -c no-such-client -t target Enter || exit 1
# positive control (tmux >= 3.7): the implicit-target path must be refused
if tmux -S "$SOCK" send-keys -t target Enter 2>err; then exit 1; fi
grep -q 'client is read-only' err || exit 1
tmux -S "$SOCK" kill-server
```

**6. Treat "who is attached" as part of the system state you diagnose.** When delivery fails intermittently, `tmux list-clients -F '#{client_name} #{client_readonly}'` belongs in the first round of checks. The failure here depended on a human having a browser tab open, a variable no log of the runtime itself would have shown.

## Open Questions

- **Upstream intent.** tmux's documentation describes `-c` on `send-keys` only in relation to `-K`. The quiet "no client" resolution that the fix relies on comes from `CMD_CLIENT_CANFAIL` and is not documented as an interface. A future tmux could reasonably change it, which is why the regression test above matters. Asking upstream whether `send-keys -t <pane>` should consult a client at all when `-K` isn't given would be the durable fix.
- **Observer fidelity.** Replacing an attached viewer with `capture-pane` polling removes the whole class of problems, but changes what humans see (refresh rate, scrollback, colours). Whether that trade is right depends on how the observer page is used, and measuring it is still to be done.
- **Other runtimes.** Interactive agents run under tmux, screen, zellij or bare ptys. The table above covers how the common viewer tools enforce read-only, but not every multiplexer's "best client" or "current client" rules. Any of them could have a similar implicit lookup.

## References

- tmux source: `cmd-send-keys.c`, `cmd-find.c` (`cmd_find_client`, `cmd_find_best_client`, `cmd_find_client_better`), `server-client.c`, `control.c`, `cmd-paste-buffer.c`, `cmd-set-buffer.c`, `cmd-load-buffer.c` — https://github.com/tmux/tmux
- tmux commits `49bb43047d56` (read-only check in `send-keys`, in 3.7), `bcbad050d4b8` (NULL guard, in 3.7), `3b3f42053a5f` (`send-keys -c`/`-K`, in 3.4), `4d79d463ef73` (`CMD_CLIENT_CANFAIL` for `send-keys`, in 3.4)
- tmux PR #4881 (review discussion of the read-only `send-keys` guard) — https://github.com/tmux/tmux/pull/4881
- tmux manual, `attach-session -r` / `-f read-only,ignore-size`, `send-keys` — https://man.openbsd.org/tmux.1
- zylos-core issue #809 and PR #810 — https://github.com/zylos-ai/zylos-core/pull/810
- libtmux `Pane.send_keys` (`target_client` gated on tmux 3.4) — https://github.com/tmux-python/libtmux/blob/master/src/libtmux/pane.py
- omnigent PR #6028 — https://github.com/omnigent-ai/omnigent/pull/6028 · ccbot PR #232 — https://github.com/Time4Mind/ccbot/pull/232 · regulus-office PR #109 — https://github.com/regulus-advanced-systems/regulus-office/pull/109
- ttyd `src/protocol.c` — https://github.com/tsl0922/ttyd/blob/main/src/protocol.c
- upterm `host/internal/server.go` — https://github.com/owenthereal/upterm
- gotty `webtty/webtty.go` — https://github.com/yudai/gotty
- asciinema live streaming — https://docs.asciinema.org/manual/server/streaming/
- GNU screen multiuser — https://www.gnu.org/software/screen/manual/html_node/Multiuser.html
- J. Gait, "A Probe Effect in Concurrent Programs", *Software: Practice and Experience* 16(3), 1986 — https://doi.org/10.1002/spe.4380160304
- Docker `container attach` (`--sig-proxy`) — https://docs.docker.com/reference/cli/docker/container/attach/
- Alibaba Cloud RDS MySQL `SHOW PROCESSLIST` deadlock notice — https://www.alibabacloud.com/help/en/rds/apsaradb-rds-for-mysql/notice-show-processlist-deadlock-bug-description
- Chrome DevTools, "Faster stack traces" — https://developer.chrome.com/blog/faster-stack-traces/
- Kubernetes `kubectl attach` — https://kubernetes.io/docs/reference/kubectl/generated/kubectl_attach/
