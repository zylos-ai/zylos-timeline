---
date: "2026-10-05"
time: "09:30"
title: "Typing Into a Busy Agent: Prompt Readiness, Type-Ahead and Idle-Gated Commands"
description: "Why a command typed into an interactive AI coding agent must be gated on when it takes effect, not on a single uniform idle check."
tags: ["ai-agents", "terminal", "tmux", "cli-tools", "distributed-systems", "automation"]
---

## Executive Summary

Zylos runs AI coding agents — Claude Code, Codex CLI — inside terminal multiplexer sessions, and a dispatcher process delivers both ordinary chat messages and control commands by typing them into the pane, the same way a human would. This works well for ordinary prompts: an agent mid-task can read a new line of input and fold it into what it's doing. It works badly for commands like `/clear` or `/exit`, which are only interpreted *as commands* when they land on an idle prompt. Typed while the agent is mid-turn, that same text is either queued for later or — worse — swallowed as an ordinary chat message, so `/clear` becomes a request to clear something rather than an instruction to reset the session.

The fix is not "always wait for idle." That would needlessly delay ordinary prompts the agent could have used immediately, and for an agent, delay has a real cost: the context keeps growing until it hits auto-compaction, discarding detail the task needed. The fix is to recognize that every signal has an *effect condition* — the receiver state required for that signal to do what the sender intended — and to gate delivery on that specific condition, not on one global rule.

This article surveys how interactive CLIs, terminal emulators, and concurrent systems already solve pieces of this problem — type-ahead buffering, OSC 133 semantic prompt marks, tmux's monitoring hooks, Erlang's selective receive — and distills design guidance: classify each signal by its effect condition, let the process that knows a step finished enqueue the follow-up itself, prefer structured readiness signals over screen-scraping, and prefer a cooldown/re-check loop over ack-deadline-retry machinery.

## The Core Problem: Two Kinds of Signal, One Delivery Pipe

When a dispatcher injects keystrokes into a pane (via `tmux send-keys` or a paste buffer), it is really sending two different kinds of signal through the same pipe. **Content signals** — ordinary user messages — don't depend on the receiver's execution phase; an LLM agent can read a new line of context whether it's mid-reasoning or waiting at a prompt, so delivering these immediately is strictly better. **Control signals** — commands like `/clear`, `/exit`, `/compact`, or a shell-level `Ctrl-C` — only mean what the sender intends when the receiver is in a specific state: idle, at a prompt, between turns. Sent mid-turn, the same bytes get reinterpreted by the receiving program as something else entirely — ordinary text to reason about, not an instruction to execute.

This is the hazard Zylos ran into while redesigning how a long-running session rotates its context: a design that had a supervisor deliver every rotation signal only at idle looked safe, until the baseline's reasoning was traced. The prompt asking the session to write a handoff never needed idle and only lost time waiting for it; `/clear` needs idle because typed into a busy Claude Code pane it does not fail loudly. It gets queued or absorbed as conversational input, and the operator who sent it has no idea the command never "happened" until much later. The bug is not in the agent; it's in treating a control signal as if it had the same effect condition as a content signal.

## How Interactive CLIs Already Handle "Busy" Input

### Type-ahead: the oldest version of this problem

Terminal input handling has dealt with "input arrives while the receiver is busy" since before CLIs ran anything resembling an agent. The Linux kernel's tty layer buffers raw input into a flip buffer, and in canonical mode the line discipline holds a full line until Enter before handing it to the reading process — this is what lets you type ahead of a command that's still finishing, without losing keystrokes. That buffering is naive, though: it has no idea what the buffered text *means*, and a large enough paste can even overrun the line discipline buffer under certain kernel versions, a long-documented class of bug in `n_tty` ([Linux kernel TTY buffer docs](https://docs.kernel.org/driver-api/tty/tty_buffer.html); [LKML thread on paste overruns into readline](https://lkml.iu.edu/hypermail/linux/kernel/1311.2/02427.html)). Line editors like GNU Readline and zsh's `zle` add their own edit buffer and key bindings on top, but still don't know whether the *shell* is ready to treat the next Enter as "run a command" versus "continue a multi-line construct" — that distinction is downstream, in the shell's own parser.

The lesson for an agent dispatcher is the same one the tty layer teaches: buffering keystrokes so nothing is lost is a different problem from knowing what the text will *mean* once delivered — which is the guarantee a dispatcher actually needs.

### Claude Code: queued messages are not all queued the same way

Claude Code's own interactive mode formalizes almost exactly the asymmetry this article is about. Per the official docs, typing a message and pressing Enter while Claude is working queues it instead of interrupting the turn, but what happens next depends on *what* was queued:

> "Messages: if you queue a message while Claude is running tool calls, Claude Code passes it to Claude as soon as those tool calls finish, within the same turn. … Commands and shell commands: Claude Code holds them until the turn ends, then runs them one at a time, keeping the order you queued them in." ([Claude Code docs — Interactive mode](https://code.claude.com/docs/en/interactive-mode))

A plain prompt is folded into the live turn at the next tool-call boundary — delivered as soon as there's a safe point, before the agent is even fully idle. A slash command or `!` shell command waits for the turn to actually end. A small set of commands (`/model`, `/effort`, `/fast`, `/status`, among others) run immediately regardless, because their effect doesn't depend on turn boundaries at all.

A detailed community-filed documentation issue spells out the resulting hazard: because plain prompts are absorbed mid-turn while commands wait for the turn to end, "a message typed later can run earlier" — if you queue a `!` command and then a plain prompt, the prompt runs first, "[and] nothing in the UI or the transcript indicates that the order changed" ([anthropics/claude-code issue #87037](https://github.com/anthropics/claude-code/issues/87037)). Claude Code's own queueing already produces this silent reordering inside a single interface; a dispatcher typing into the pane from outside inherits the same hazard, minus even the gray "queued" annotation a human would see.

A second, related bug shows what happens when the receiving program has no "pending command" concept at all: queuing `!echo "test"` or `/commit` while Claude was mid-task sent the literal command text to the model as a chat message instead of executing it and injecting the result — Claude had to interpret `` !`ls -la` `` as English rather than receive a directory listing ([anthropics/claude-code issue #18399](https://github.com/anthropics/claude-code/issues/18399)). This is the clearest illustration of the Zylos lesson: identical bytes mean "run this" at one receiver state and "here is a string to reason about" at another.

Claude Code also ships an escape hatch for this exact tension: a send-now key, `Ctrl+Enter` (or `Ctrl+X Ctrl+S`), added in v2.1.275, interrupts the current turn and sends all queued messages at once (later releases move running tools to the background instead of cancelling them) ([Claude Code docs — Interactive mode](https://code.claude.com/docs/en/interactive-mode)). Forcing early delivery this way is a deliberate, visible trade of a little lost work for making the signal effective right away, the inverse of Zylos's problem, where the signal was sent but silently had no effect.

### Codex CLI: an explicit key-binding for "now" vs "next turn"

OpenAI's Codex CLI exposes the same distinction through keybindings rather than queue semantics: pressing **Tab** queues a message or slash command for after the current turn finishes, while "steer mode" lets **Enter** deliver a message mid-turn, affecting the running turn immediately ([Codex CLI developer commands docs](https://developers.openai.com/codex/cli/slash-commands)). A filed bug shows the queueing path isn't fully baked: queuing `/clear` followed by further prompts silently drops those later prompts, because dequeuing `/clear` tears down the chat widget the rest of the queue was attached to ([openai/codex issue #26574](https://github.com/openai/codex/issues/26574)). The details differ from Claude Code's, but the shape is identical: a control signal (reset the session) and the signals queued after it have different effect conditions, and the implementation didn't fully reconcile them.

## Detecting "Ready" Without Guessing

If a dispatcher is going to gate a control signal on receiver state, it needs a reliable way to know that state. There is a spectrum of techniques, from fragile to structured.

### Screen-scraping and `expect`/`pexpect`

The classic approach, going back to Don Libes's original `expect`, is to pattern-match on the text a program prints and infer "it's at a prompt" from seeing the prompt string. `pexpect`'s documentation and issue tracker catalog why this is fragile: the end-of-line anchor `$` is nearly useless, since pexpect reads character-by-character and must instead match `\r\n` explicitly; a MOTD or other incidental text containing the prompt substring can trigger a false match before real output arrives; and matching too eagerly after a `send()` can catch the command's own echo rather than the actual response ([Pexpect documentation](https://pexpect.readthedocs.io/en/3.x/api/pxssh.html); [pexpect issue #552](https://github.com/pexpect/pexpect/issues/552); [pexpect issue #675](https://github.com/pexpect/pexpect/issues/675)). This isn't specific to `pexpect` — any readiness inference from raw output inherits the same ambiguity, because the "ready" signal and the ordinary output stream aren't separated.

### OSC 133: a structured readiness signal

Terminal emulators converged on a better answer: have the shell emit an out-of-band marker, distinct from its regular output, at each phase transition. This is the OSC 133 "semantic prompt" protocol, originated by the now-defunct FinalTerm terminal and adopted and extended by iTerm2, then standardized in practice across VS Code's integrated terminal, Windows Terminal, WezTerm, kitty, Zellij, and Ghostty: `OSC 133;A` marks prompt start, `OSC 133;B` marks the end of the prompt and start of command input, `OSC 133;C` marks the start of execution, and `OSC 133;D[;exit-code]` marks completion, optionally with exit status ([iTerm2 shell integration protocol spec](https://gist.github.com/tep/e3f3d384de40dbda932577c7da576ec3); [VS Code terminal shell integration docs](https://code.visualstudio.com/docs/terminal/shell-integration); [Windows Terminal shell integration tutorial](https://learn.microsoft.com/en-us/windows/terminal/tutorials/shell-integration)).

This matters for the exact reason screen-scraping is fragile: the marker is unambiguous and separate from the data stream it brackets, so "the shell is ready for a command" is a discrete event, not an inference. The catch, as of this research, is that neither Claude Code nor Codex CLI emits OSC 133 sequences for its own prompt/turn transitions — a request to add them to Claude Code exists on the tracker but is closed as a duplicate with no visible maintainer commitment ([anthropics/claude-code issue #22528](https://github.com/anthropics/claude-code/issues/22528)). So today, a dispatcher driving these specific agents cannot rely on OSC 133 for agent-level readiness — only for shell-level readiness inside the pane.

### tmux's own signals

tmux offers several primitives relevant to readiness detection, each with a different limitation. `pane_current_command` reports the foreground process name — coarse, and useless for telling an idle agent prompt from a busy one, since the name doesn't change. `monitor-silence <interval>` highlights a window once it has produced no output for `interval` seconds ([tmux man page, Debian build](https://manpages.debian.org/buster/tmux/tmux.1.en.html)) — a reasonable heuristic, but silence isn't idle: a long-running, quiet tool call looks identical to an idle prompt. `wait-for` (alias `wait`) is a synchronization primitive — `-L`/`-U` lock/unlock a named channel, `-S` signals it — letting one tmux client block until another signals readiness ([tmux `wait` reference](https://fig.io/manual/tmux/wait)). It's a coordination tool, not a detector: useful once something else has already decided the moment of readiness and needs to notify a waiter, close to the "doer enqueues its own follow-up" pattern recommended below.

None of these tmux primitives gives a dispatcher a first-class "agent is at an idle prompt" signal. The agents themselves do offer one, though not on the terminal stream: Claude Code runs user-configured [hooks](https://code.claude.com/docs/en/hooks) on lifecycle events such as `UserPromptSubmit` and `Stop` (turn finished), plus a `Notification` hook whose `idle_prompt` type fires when the prompt has sat idle; Codex CLI can run a configured `notify` program on `agent-turn-complete`. A dispatcher that records these events gets turn boundaries as discrete events rather than inferences — this is how Zylos tracks busy/idle. What remains is the gap between "the turn ended" and "my keystrokes land": the state can change between the check and the send, which is why the effect condition should still be enforced as close to the receiver as possible.

### Bracketed paste mode

Separately from readiness, *how* text is injected matters once you've decided to send it. Bracketed paste mode (`\e[200~` … `\e[201~`) tells the receiving program a block of text arrived as a paste rather than as individually typed keystrokes — without it, embedded newlines in a multi-line payload can be read as individual Enter presses, triggering premature submission or accidental execution of a partial command ([bracketed paste overview](https://cirw.in/blog/bracketed-paste); [Bracketed-paste, Wikipedia](https://en.wikipedia.org/wiki/Bracketed-paste)). A dispatcher injecting multi-line prompts via `tmux send-keys`/paste-buffer should bracket the payload the same way, so the receiving line editor treats it as one block rather than a sequence of Enters that could trigger a command mid-paste.

## Analogies From Concurrent Systems

The same problem — a message is only safe to act on in certain receiver states — shows up, solved, in classic concurrency design. **Erlang's selective receive** lets a process scan its mailbox for a message matching the pattern it's currently willing to act on, leaving non-matching messages in the mailbox rather than acting on them out of context ([Learn You Some Erlang, "More On Multiprocessing"](https://learnyousomeerlang.com/more-on-multiprocessing)); the process decides what's actionable *right now*, so the sender doesn't need to know the receiver's state. **EEP-76, Priority Messages**, extends this: an ordinary selective receive scans the whole mailbox to find a match, which is expensive with a long queue, so Erlang added a true priority class that jumps the queue instead of waiting to be found by pattern matching ([EEP-76 — Priority Messages](https://www.erlang.org/eeps/eep-0076)) — the actor-systems version of "most signals wait their turn; a few skip the line," directly analogous to Claude Code's small set of immediate commands. **IRQ masking** is the hardware-level version: interrupts are deferred until the CPU reaches a safe point, except for classes (non-maskable interrupts) that can't wait for one. The same pattern recurs at every layer, from silicon to chat UI.

## Failure Modes

| Failure mode | What happens | Observed in |
|---|---|---|
| Control signal misread as content | `/clear` or `!cmd` typed mid-turn is absorbed as a literal chat message | Claude Code issue #18399 |
| Silent reordering | A command queued before a prompt executes *after* it, with no visible marker | Claude Code issue #87037 |
| Queue corruption on reset | A queued reset tears down the structure the rest of the queue depended on, dropping it | Codex CLI issue #26574 |
| TOCTOU between check and send | Dispatcher checks "idle," but the agent starts a new turn before the keystrokes land | Inherent to any poll-then-act readiness check |
| Lost/merged keystrokes | Oversized or rapid input overruns a line-discipline buffer, or lands mid-line of other in-flight input | Linux kernel `n_tty` paste-overrun patches |
| Starvation | A control signal waits for "idle," but the agent never becomes idle (long tool loop, retry storm) | Any idle-gated design with no escape hatch |
| Over-cautious idle gate | Waiting for idle delays a prompt the agent could have used immediately; the wasted time is context that keeps accumulating toward auto-compaction | General pattern in long-running agent sessions |

## Design Guidance

1. **Classify every signal by its effect condition, not a blanket policy.** A prompt's effect condition is "any time the agent can read input"; a control command's is "idle, at the top-level prompt." Gate delivery on *that* condition per signal type — the split Claude Code's queueing already encodes between messages and commands.
2. **Let the party that knows a step finished enqueue the follow-up.** An external watcher polling the pane can only guess when a step ended. The step itself — in Zylos's case, the session writing its handoff — knows the exact moment and should trigger the next command itself, which also removes the TOCTOU gap between "is it ready" and "it just became ready."
3. **Prefer a cooldown / re-trigger loop over ack-deadline-retry machinery.** Guessing a retry deadline risks duplicate delivery; idempotent commands plus a short cooldown-then-recheck are simpler and safer.
4. **Prefer structured signals over screen-scraping.** Use OSC 133 for shell-level readiness where available; for agent-level readiness, use the agent's own lifecycle hooks (Claude Code's `Stop` / `UserPromptSubmit` / `idle_prompt` notification, Codex CLI's `agent-turn-complete` notify) rather than scraping the pane, and fall back to output matching — with `pexpect`'s documented caveats in mind — only where no such signal exists.
5. **Make control commands idempotent**, so a double-delivery — e.g. `/clear` sent twice because the first send's effect was uncertain — is harmless.
6. **Don't gate what doesn't need gating.** A uniform idle gate reintroduces the latency cost gating was meant to avoid for content signals — and for a context-bounded agent, that latency is context accumulating toward auto-compaction while the command waits.

## Comparison Table: How Different Systems Gate Delivery

| System | Content-like signal | Control-like signal | Readiness mechanism |
|---|---|---|---|
| Claude Code | Folded into turn at next tool-call boundary | Held until turn ends; a small immediate set bypasses the queue | Internal turn-state tracking; no OSC signal exposed |
| Codex CLI | Steer mode: Enter delivers mid-turn | Tab queues for after the turn | Internal; `/clear` bug shows queue isn't fully isolated from UI state |
| Terminal emulators (iTerm2, VS Code, Windows Terminal, WezTerm) | N/A | N/A | OSC 133 prompt/command/output/exit markers |
| `expect`/`pexpect` automation | Any send is "immediate" | Same | Regex match against raw output — a scraping heuristic |
| Erlang processes | Selective receive matches an accepted pattern | Priority messages (EEP-76) jump the scan | Receiver-side pattern match against its own mailbox |
| tmux | N/A | N/A | `pane_current_command` (coarse), `monitor-silence` (heuristic), `wait-for` (coordination only) |

## Practical Checklist

- Ask whether a signal's effect depends on receiver state; if not, send it immediately rather than idle-gating it by default.
- If it does, identify the exact state required (idle at the top-level prompt, not just "quiet for N seconds") and check for that specifically.
- Have the completing step trigger its own follow-up rather than having an external poller guess when it finished.
- Bracket multi-line payloads before injecting them, so embedded newlines can't be misread as premature submissions.
- Make every control command idempotent so a possible double-delivery is harmless.
- Use a short cooldown-then-recheck loop instead of ack-deadline-retry for commands whose delivery you can't directly confirm.
- Prefer a structured readiness signal (OSC 133, an explicit API state field) over pattern-matching output; where none exists, anchor on exact, stable strings including line terminators and distrust the first match.
- Re-verify an agent's queueing behavior against its current docs before relying on it — this has changed across recent versions of both Claude Code and Codex CLI.
- Watch for starvation: if "idle" can be deferred indefinitely, give control commands an explicit escape hatch.

## Sources

- [Claude Code docs — Interactive mode](https://code.claude.com/docs/en/interactive-mode) (queueing semantics, send-now key, immediate commands)
- [Claude Code changelog](https://code.claude.com/docs/en/changelog) (versioned history of queueing and send-now key changes)
- [anthropics/claude-code issue #87037 — queued input ordering is undocumented](https://github.com/anthropics/claude-code/issues/87037)
- [anthropics/claude-code issue #18399 — queued messages with command syntax sent as raw text](https://github.com/anthropics/claude-code/issues/18399)
- [anthropics/claude-code issue #22528 — OSC 133 shell integration feature request](https://github.com/anthropics/claude-code/issues/22528)
- [openai/codex issue #26574 — queued /clear drops later queued prompts](https://github.com/openai/codex/issues/26574)
- [Codex CLI developer commands documentation](https://developers.openai.com/codex/cli/slash-commands)
- [iTerm2 shell integration protocol specification](https://gist.github.com/tep/e3f3d384de40dbda932577c7da576ec3)
- [VS Code terminal shell integration docs](https://code.visualstudio.com/docs/terminal/shell-integration)
- [Windows Terminal shell integration tutorial](https://learn.microsoft.com/en-us/windows/terminal/tutorials/shell-integration)
- [Linux kernel TTY buffer documentation](https://docs.kernel.org/driver-api/tty/tty_buffer.html)
- [LKML — readline/n_tty paste buffer overrun discussion](https://lkml.iu.edu/hypermail/linux/kernel/1311.2/02427.html)
- [Pexpect documentation (pxssh)](https://pexpect.readthedocs.io/en/3.x/api/pxssh.html)
- [pexpect issue #552 — additional prompt causes incorrect matching](https://github.com/pexpect/pexpect/issues/552)
- [pexpect issue #675 — expect not properly matching patterns](https://github.com/pexpect/pexpect/issues/675)
- [Bracketed paste mode overview](https://cirw.in/blog/bracketed-paste)
- [Bracketed-paste — Wikipedia](https://en.wikipedia.org/wiki/Bracketed-paste)
- [tmux man page (Debian buster build)](https://manpages.debian.org/buster/tmux/tmux.1.en.html)
- [tmux `wait` command reference](https://fig.io/manual/tmux/wait)
- [Learn You Some Erlang — More On Multiprocessing (selective receive)](https://learnyousomeerlang.com/more-on-multiprocessing)
- [EEP-76 — Priority Messages](https://www.erlang.org/eeps/eep-0076)
