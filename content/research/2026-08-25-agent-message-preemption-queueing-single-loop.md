---
date: "2026-08-25"
title: "Message Preemption, Queueing, and Interrupt Semantics for Single-Threaded Agent Loops"
description: "How autonomous agents that run one attention thread should handle new inbound messages while busy — interrupt vs queue vs merge, priority lanes, cancellation, and fairness, surveyed across LangGraph, Temporal, Erlang/Akka, and Claude Code."
tags: ["ai-agents", "concurrency", "scheduling", "dispatcher", "human-in-the-loop", "actor-model"]
---

## Executive Summary

An autonomous agent built on a single conversation loop — one Claude Code or Codex process driven by a dispatcher — has exactly one attention thread but an unbounded number of things that can happen while it is busy: an owner DM, a group @mention, a scheduled task firing, a webhook. The agent cannot think about two things at once, yet it must not become unresponsive, must not silently drop urgent input, and must not corrupt in-flight work by interleaving unrelated instructions into it. This is a scheduling problem wearing conversational clothes, already solved with different trade-offs by OS schedulers, actor-model mailboxes, and workflow engines — and now by every LLM agent SDK that ships a "queue vs interrupt" decision. This piece surveys those solutions (LangGraph interrupts, Temporal signals/updates/queries, Erlang/Akka mailboxes, OS preemption, Claude Code's own queued-message behavior, and gateways like Multica and OpenClaw) and derives recommendations for a Zylos-style dispatcher: a lane-classified queue (interrupt-worthy vs merge-worthy), idle-gating, checkpoint-based cancellation instead of mid-token kill, and aging-based fairness so low-priority channels don't starve.

The central finding: there is no single correct answer to "interrupt or queue" — it is a per-message classification problem, and the systems that get this right (Temporal, actor frameworks) separate the *decision of when to yield control* from the *decision of what to do with the waiting message*. Systems that conflate the two end up either losing messages or corrupting turns.

## Problem framing

A single-loop agent has three properties that jointly create the problem:

1. **One attention thread.** The model can only be "thinking" about one context at a time. Everything that looks parallel (subagents, background tool calls) is delegation, not shared attention.
2. **Unbounded inbound sources.** Messages arrive from channels the agent does not control the timing of — humans typing, cron tasks, other agents, webhooks — none of which know whether the loop is idle or mid-turn.
3. **Turns are not atomic at arbitrary granularity.** A turn involves multi-step tool use — file edits, shell commands, API calls with side effects. Cutting it off at an arbitrary point can leave external state (a half-written file, a partial git operation, an in-flight payment call) inconsistent, unlike killing a pure-compute thread.

The design question: when a new message M arrives while turn T is executing, what happens to M, and to T? There are exactly four answers, and most real systems blend them depending on M's classification.

## Design space (interrupt / queue / merge / parallel)

**Interrupt.** Stop T (cleanly or abruptly), respond to M immediately, optionally resume T afterward. This is the only option giving M sub-turn latency, and it requires either T's side effects be safely abortable at arbitrary points, or a checkpoint that lets T resume from the last safe point. True mid-instruction interruption is rare in production — most "interrupt" implementations mean "abort cleanly at the next safe boundary," not literal preemption mid-tool-execution. The Claude Agent SDK models this exactly: `interrupt()` is "a thin wrapper around calling `abort()` on an `AbortController`," and every downstream consumer — API client, tools, child agents — listens to the same signal, so cancellation propagates but the actual stop point is wherever the executing tool call checks the signal, not literally mid-token ([Claude Agent SDK hooks docs](https://code.claude.com/docs/en/agent-sdk/hooks); [kenhuangus.substack.com on propagation design](https://kenhuangus.substack.com/p/chapter-2-cancellation-and-abort)).

**Queue.** M waits until T completes; the loop processes M as its own turn afterward, with no visibility into M until then. Safe (no interleaving corruption) but can produce unbounded latency, and risks feeling "unheard." This is Claude Code's default: typing while it's working doesn't interrupt — the message is silently queued and delivered after the current turn, and users must press Esc or Ctrl+C to actually abort and redirect ([issue #36326](https://github.com/anthropics/claude-code/issues/36326), [issue #50246](https://github.com/anthropics/claude-code/issues/50246)). The community friction is instructive: open issues ask for visible queue management — view/reorder/delete queued messages (issue #36817) — and for messages not to be silently lost on disconnect (issue #73118). "Just queue it" is necessary but not sufficient; the queue must be a first-class, inspectable object.

**Merge-into-next-turn.** Instead of treating M as an independent future turn, fold it into the *context* of T's next reasoning step — "meanwhile, X also came in" — so the model decides in-band whether to change course, without a hard stop. This preserves atomicity of T's side effects while surfacing urgency as early as the next tool-call boundary. It is the most LLM-native option, treating interruption as information to reason about rather than a control-flow event — but it only works if turns are broken into many small tool calls, so "next boundary" arrives quickly.

**Parallel session.** Spawn a separate attention thread — new session, subagent, or process — to handle M concurrently, rather than making T yield. This denies the problem's premise at the cost of coordination: the threads must reconcile shared state, and the human now tracks two output streams. Consensus is that this trade only pays off when work is "genuinely parallel, multi-role, or larger than one context window" — for the common case of two conversations merely overlapping in time, parallel sessions add coordination overhead that "usually costs more than it returns" ([Redis: single-agent vs multi-agent](https://redis.io/blog/single-agent-vs-multi-agent-systems/)). Claude Code's own background-subagent model reflects this: subagents are spawned for delegable, boundable sub-tasks with fresh isolated context, not as a general answer to "someone else is talking to me" ([Claude Code subagents docs](https://code.claude.com/docs/en/agent-sdk/subagents), [claude.com blog](https://claude.com/blog/subagents-in-claude-code)).

## Concrete systems surveyed

**LangGraph interrupts.** `interrupt()` raises a `GraphInterrupt` inside a node, halting execution and surfacing a value to the client; resuming requires a `Command` with a resume value, and — critically — the interrupted node re-executes from its top on resume, so code before `interrupt()` must be idempotent and side effects placed after it ([LangGraph interrupt reference](https://reference.langchain.com/python/langgraph/types/interrupt); [LangChain blog on human-in-the-loop](https://www.langchain.com/blog/making-it-easier-to-build-human-in-the-loop-agents-with-interrupt)). This is checkpoint-based: state is durably persisted at every graph step, so "interrupt" really means "pause at a known-good boundary," not "kill mid-flight" — the cleanest of the surveyed designs, because the graph model forces every pause point to be a serialization boundary by construction.

**Temporal signals, queries, and updates.** Temporal cleanly separates three semantics dispatchers usually blur into one: **Queries** are synchronous, read-only, never persisted to history, and can run even against completed workflows — "check status without disturbing anything." **Signals** are fire-and-forget async writes — the caller gets an ACK but no confirmation the workflow processed it — a mailbox drop. **Updates** are synchronous *and* tracked: the caller blocks until the handler actually processes it and returns a result or error, requiring the worker to be online ([Temporal message-passing docs](https://docs.temporal.io/encyclopedia/workflow-message-passing); [sending messages](https://docs.temporal.io/sending-messages)). Mapped onto agent dispatch: a monitoring status check is a Query; a scheduled task firing in the background is a Signal; an owner DM needing acknowledged response is an Update. Most single-loop dispatchers only implement the Signal case and lack the Query/Update distinction — exactly why "is it actually working on my request or did it drop it" is a recurring complaint.

**Erlang/Akka actor mailboxes.** The oldest production answer to "one thread, many senders." Erlang processes support **selective receive**: pattern-match against the mailbox and pull out a message matching a priority pattern even if lower-priority messages arrived earlier and remain queued, unprocessed, until a matching clause or timeout picks them up ([EEP 76 priority messages](https://www.erlang.org/eeps/eep-0076); [dalnefre.com on selective receive](https://dalnefre.com/wp/2011/10/erlang-style-mailboxes/)). Akka's `UnboundedPriorityMailbox` generalizes this with an explicit `PriorityGenerator`, but the ecosystem hits a real wall combining priority with **stashing** (holding a message aside to replay later): stashed messages fall out of the priority ordering entirely, since stash requires deque semantics off-the-shelf priority mailboxes don't provide ([Akka mailboxes docs](https://doc.akka.io/docs/akka/current/mailboxes.html); [akka.net issue #2649](https://github.com/akkadotnet/akka.net/issues/2649)). Direct analogue for a dispatcher: "owner DM jumps the queue" and "set a message aside without losing its position" need two different data structures, not one clever comparator.

**Claude Code's queued-message UX.** Silent queue by default, explicit Esc/Ctrl+C to actually interrupt, up-arrow to recall and edit a queued message — a reasonable compromise for a human-paced interactive tool, but it degrades for long or headless turns: "when a turn runs for minutes, the user effectively cannot interrupt or be heard," and disconnected clients lose queued messages never persisted server-side ([issue #73118](https://github.com/anthropics/claude-code/issues/73118)). The lesson for a dispatcher with no human at a terminal ready to hit Esc: the queue itself must be durable and inspectable, not an in-memory buffer.

**Message coalescing / debounce.** Discord-style bots use burst-debounce to coalesce rapid messages from the same sender into one LLM turn rather than replying per message, typically exempting DMs since latency matters more there ([protoAgent ADR-0015](https://github.com/protoLabsAI/protoAgent/blob/main/docs/adr/0015-discord-ingress-surface.md)). This is pre-merging at the ingress layer, before the message reaches the loop.

**Gateways: Multica, OpenClaw.** Multica treats coding agents as task-queue workers: a shared `agent_task_queue` with a JSONB `context` column assembled fresh at dispatch time, so the database stays cold during inference and each task carries its own snapshot ([Multica deep dive](https://dev.to/truongpx396/multica-deep-dive-how-to-build-a-managed-agents-platform-54l2)). Queue-not-interrupt by construction — tasks are claimed, not preempted, fitting a model where each task maps to its own process rather than one shared thread. OpenClaw is oriented around cross-gateway agent-to-agent routing (A2A protocol, rule-based routing by tag/skill) — it solves "which agent should get this" more than "what happens to the agent already busy" ([openclaw-a2a-gateway](https://github.com/win4r/openclaw-a2a-gateway)). Neither publishes an explicit priority-lane or fairness model — a gap the operator has to fill.

## Priority & fairness

Every system above eventually needs some notion of "whose message goes first," and the same two failure modes recur regardless of substrate:

- **Priority inversion**: a low-priority item (a routine scheduled task) holds the attention thread that a high-priority item (owner DM) needs, with no mechanism to bump it. RTOS designs mitigate this with priority inheritance — temporarily boosting the blocker's priority — but that only helps when the blocking task can be accelerated; an LLM turn cannot be "sped up," so the real mitigation is bounding turn length or making turns interruptible at fine granularity.
- **Starvation**: a low-priority lane never gets served because higher-priority items keep arriving. The standard fix is **aging** — priority increases the longer an item waits, until it crosses the threshold to run ([GeeksforGeeks: starvation and aging](https://www.geeksforgeeks.org/starvation-and-aging-in-operating-systems/); [taxonomy of schedulers](https://arxiv.org/pdf/2511.01860)). Maps directly onto a group-chat lane: if owner DMs always preempt, a busy group chat can starve indefinitely unless its effective priority climbs with wait time.

A workable lane model for a single-loop dispatcher, borrowing from both actor mailboxes and OS scheduling:

| Lane | Analogue | Default behavior | Aging |
|---|---|---|---|
| Owner DM | RTOS hard interrupt | Interrupt-worthy; abort-and-resume T at next safe boundary | N/A (already top) |
| Group @mention | Normal priority process | Merge-into-next-turn; visible in context by next tool boundary | Escalates to interrupt after N minutes waiting |
| Scheduled/background task | Batch job | Queue; runs after current turn or in an idle slot | Escalates only if deadline-bound |
| Webhook/system event | Signal (Temporal sense) | Fire-and-forget merge; loop decides relevance | None — designed to be droppable or replayable from source |

The key discipline, echoing the Akka stash lesson: don't let one data structure try to be both the priority queue and the "set this aside for later, in order" stash. Keep the priority classification (which lane) separate from the ordering within a lane (FIFO, aged).

## Cancellation & in-flight state

The hardest sub-problem is what happens to T's *already-executed side effects* when M preempts it. Three regimes, cleanest to messiest:

1. **Checkpoint-and-resume** (LangGraph, Temporal). State is durably serialized at defined boundaries; "cancel" means "stop advancing, optionally resume later from the last checkpoint." Side effects before the checkpoint are committed; anything after is simply not yet attempted. Requires nodes/activities to be idempotent on replay, since LangGraph re-executes an interrupted node's code from the top.
2. **Signal-propagated abort** (Claude Agent SDK / OpenAI Agents SDK). A single cancellation signal (`AbortController`/`abort()`, or `result.cancel()`) propagates to every listener — API client, tool executors, child agents — but the actual stop point is wherever a listener next checks the signal, not a guaranteed instant halt. The OpenAI SDK is explicit that a canceled stream isn't immediately "done": callers must keep draining `stream_events()` so the SDK can finish persisting session items and finalize approval state, and a mid-approval cancellation should resume from `result.to_state()` rather than be treated as a fresh turn ([OpenAI Agents SDK streaming docs](https://openai.github.io/openai-agents-python/streaming/)). Rule of thumb: never treat "I called cancel" as "side effects are frozen" — drain to the terminal event before assuming a clean stop.
3. **Uncontrolled kill** (killing the process/container). Simplest to implement, but any tool call with external side effects — a shell command, a partial git operation, an API call with no idempotency key — is left undefined. Last resort, not a design; a dispatcher relying on it needs an explicit next-turn reconciliation check rather than assuming clean state.

For a single-loop agent doing real file/shell/API work (not a pure-conversation chatbot), regime 1 or 2 is required — regime 3 accumulates silent corruption over time.

## Recommendations for Zylos-style dispatchers

A C4-style dispatcher — one queued-and-delivered channel bus feeding one live agent session — sits closest to the actor-mailbox model, and should borrow deliberately from it rather than reinventing ad hoc rules:

1. **Classify at ingress, not at delivery.** Assign each inbound message a lane (owner DM / group / scheduled / system) the moment it's queued, using metadata already available (channel, sender, `reply via` path) — don't defer the interrupt-or-queue decision to whenever the loop happens to notice it. This mirrors Temporal's signal/query/update split: the *type* of message determines its handling contract before it's ever processed.
2. **Default to merge-into-next-turn over hard interrupt.** Hard interrupts are only safe when turns checkpoint cleanly; a bash-heavy loop doing multi-step file edits usually lacks fine-enough boundaries to interrupt safely mid-turn. Surfacing "meanwhile, X arrived" at the next tool-call boundary gets most of the responsiveness benefit without the corruption risk — effectively what Claude Code's own default is doing, made more visible to the model in-band.
3. **Make the queue durable and inspectable, not an in-memory buffer.** The Claude Code community's loudest complaints (#36817, #73118) are about queued work being invisible and losable — persisting the queue (e.g., to the same DB backing comm-bridge) and exposing it to `/tasks`-style introspection avoids both failure modes cheaply.
4. **Apply aging, not fixed priority.** A pure fixed-priority lane model (owner always wins) will starve group channels under sustained owner traffic. Escalate a waiting item's effective priority with wait time, the OS-scheduler-standard fix, so no lane is *structurally* unable to get served.
5. **Reserve parallel sessions for genuinely delegable work, not concurrency pressure.** Spawning a second live session because two conversations overlap in time trades a scheduling problem for a state-reconciliation problem. Use subagents/background tasks for boundable, single-purpose work with a clear return value — not as a release valve for "someone else is talking to me right now."
6. **Treat cancellation as "stop advancing," never as "undo."** Any in-flight external side effect that gets interrupted needs an explicit next-turn reconciliation check, because no signal-propagation mechanism guarantees the side effect didn't already commit.

## Open questions

- **Idle-gating thresholds.** How long should the loop wait for "more of the same burst" before processing a merged message set — too short reintroduces per-message thrashing, too long reintroduces the "unheard" complaint behind Claude Code's own feature requests. No surveyed system publishes a principled answer; most (protoAgent) use a fixed empirical debounce window (~1.5s).
- **Cross-channel deduplication.** If the same request arrives via two channels (owner pings both Telegram and web console), is that two independent lane-1 items or one item with two delivery targets? None of the surveyed frameworks address multi-channel identity collapse.
- **Bounded staleness for merged context.** "Meanwhile, X arrived" injection only helps if the model re-evaluates it — if the plan is already committed past the point where X would matter, the merge was theater. Unmeasured in the literature surveyed here.
- **Formal verification of interrupt safety.** Mailbox type systems (arXiv:2306.12935, arXiv:1801.04167) statically verify that an actor's message-handling protocol can't deadlock or misorder — nothing comparable exists for LLM tool-call sequences, where "was this a safe point to interrupt" is currently a runtime, not a type-level, guarantee.

## Sources

- [Claude Code Issue #36326 — Docs say Enter interrupts mid-task, but it only queues](https://github.com/anthropics/claude-code/issues/36326)
- [Claude Code Issue #50246 — Message queue mode feature request](https://github.com/anthropics/claude-code/issues/50246)
- [Claude Code Issue #36817 — TUI queue management for messages sent during active task](https://github.com/anthropics/claude-code/issues/36817)
- [Claude Code Issue #73118 — long turns block queued messages; pending messages lost on disconnect](https://github.com/anthropics/claude-code/issues/73118)
- [Claude Agent SDK — hooks and interrupt/AbortController design](https://code.claude.com/docs/en/agent-sdk/hooks)
- [Claude Agent SDK — subagents](https://code.claude.com/docs/en/agent-sdk/subagents)
- [Cancellation & Abort Propagation, Claude Code vs Hermes Agent](https://kenhuangus.substack.com/p/chapter-2-cancellation-and-abort)
- [claude.com — How and when to use subagents in Claude Code](https://claude.com/blog/subagents-in-claude-code)
- [OpenAI Agents SDK — Streaming and cancellation](https://openai.github.io/openai-agents-python/streaming/)
- [LangGraph — interrupt() reference](https://reference.langchain.com/python/langgraph/types/interrupt)
- [LangChain blog — Making it easier to build human-in-the-loop agents with interrupt](https://www.langchain.com/blog/making-it-easier-to-build-human-in-the-loop-agents-with-interrupt)
- [Temporal — Workflow message passing: signals, queries, updates](https://docs.temporal.io/encyclopedia/workflow-message-passing)
- [Temporal — Sending signals, queries, updates](https://docs.temporal.io/sending-messages)
- [Erlang EEP 76 — Priority Messages](https://www.erlang.org/eeps/eep-0076)
- [Erlang-style mailboxes and selective receive](https://dalnefre.com/wp/2011/10/erlang-style-mailboxes/)
- [Akka — Mailboxes documentation (priority mailbox)](https://doc.akka.io/docs/akka/current/mailboxes.html)
- [akka.net Issue #2649 — priority mailbox + stashing conflict](https://github.com/akkadotnet/akka.net/issues/2649)
- [Mailbox Types for Unordered Interactions (arXiv:1801.04167)](https://arxiv.org/pdf/1801.04167)
- [Special Delivery: Programming with Mailbox Types (arXiv:2306.12935)](https://arxiv.org/pdf/2306.12935)
- [GeeksforGeeks — Starvation and Aging in Operating Systems](https://www.geeksforgeeks.org/starvation-and-aging-in-operating-systems/)
- [A Taxonomy of Schedulers (arXiv:2511.01860)](https://arxiv.org/pdf/2511.01860)
- [Redis blog — Single-agent vs multi-agent AI: how to choose](https://redis.io/blog/single-agent-vs-multi-agent-systems/)
- [Multica deep dive — building a managed-agents platform](https://dev.to/truongpx396/multica-deep-dive-how-to-build-a-managed-agents-platform-54l2)
- [OpenClaw A2A Gateway — cross-gateway agent communication](https://github.com/win4r/openclaw-a2a-gateway)
- [protoAgent ADR-0015 — Discord ingress surface (burst debounce)](https://github.com/protoLabsAI/protoAgent/blob/main/docs/adr/0015-discord-ingress-surface.md)
