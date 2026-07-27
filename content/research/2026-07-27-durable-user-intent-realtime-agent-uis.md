---
date: "2026-07-27"
title: "Durable User Intent in Realtime Agent UIs: Why the End Button Must Always Win"
description: "How client-side guards silently swallow critical user intents like end, cancel, and submit — and the persist-mint-resend pattern that guarantees delivery across disconnects, races, and half-open sockets."
tags: ["realtime", "websocket", "idempotency", "voice-agents", "ui-patterns", "reliability", "state-machines", "offline-first"]
---

## Executive Summary

There is a class of bug where the user clicks "end call" or "submit" and nothing happens — not because the server mishandled the request, but because the request was never sent. A disabled button, an early-return guard, or a `send()` on a half-open WebSocket quietly consumed the user's intent, and the server never got a chance to act on something it could have handled perfectly well. In a realtime agent UI — a voice session, a conversational data-collection flow, a long-running streamed response — this failure mode is endemic, because the client is full of transient states (response in flight, mode switch in progress, socket reconnecting) that guard logic loves to gate on.

The fix is a discipline, not a patch: treat a critical user intent as **durable state with a stable identity**, not as an ephemeral RPC. Persist the intent the instant it is expressed, mint its idempotency ID at creation time, resend it on every "channel is viable again" signal, and let the server dedupe. Client-side guards may reduce duplicate noise; they must never decide whether the intent exists. This is exactly the model that offline-first sync engines (Replicache, Linear, Firestore), payment APIs (Stripe idempotency keys, AWS client tokens), and messaging protocols (MQTT QoS 1) converged on independently — and it maps cleanly onto the end/cancel/submit semantics of realtime voice agent protocols like OpenAI Realtime and Gemini Live.

## The Anti-Pattern: Guards That Swallow Intent

Three client-side mechanisms, each individually reasonable, combine into intent black holes:

1. **Disabled buttons during transient states.** The UI disables "End" while a response is pending or a mode switch is in flight. If that transient state gets stuck — a run that never terminates, a switch that never completes — the user's only escape hatch is welded shut. UX research has criticized disabled buttons for years on explainability grounds ([Smashing Magazine](https://www.smashingmagazine.com/2021/08/frustrating-design-patterns-disabled-buttons/)); in realtime UIs the problem is sharper: the disable condition depends on *server* state cached locally, and a desynced cache disables the button forever.

2. **Early-return guards in the intent handler.** `if (switching || runPending) return;` — the click handler itself drops the intent on the floor. Unlike a disabled button, this one is invisible: the button looked clickable, the click "worked", nothing happened.

3. **Sends on half-open sockets.** Per the [WebSocket spec as implemented in browsers](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/send), calling `send()` in the CLOSING or CLOSED state **silently discards the data** — no exception, no callback. Worse, an intermediate proxy or NAT can kill a connection without FIN/RST, leaving `readyState === OPEN` while everything sent goes into a void. Local socket state cannot distinguish a healthy connection from a zombie; only an application-level heartbeat can (ping/pong with a miss threshold, tuned below the shortest proxy idle timeout in the path).

The common structure: each guard assumes the blocked state is short-lived and the user will retry into a healthier moment. When the state is *not* short-lived, the guard converts a recoverable server-side situation into a permanently stuck client — and the server, which has robust handling for the end/cancel request, never receives it.

A production instance of this class: LiveKit's agent framework had a case where [agent-side session shutdown left the user stranded in the room](https://community.livekit.io/t/agent-disconnects-after-session-shutdown-drain-true-but-user-remains-stuck-in-room-production-issue/647) — teardown on one side was assumed to imply notification of the other. Another: LiveKit's end-call tool [failed ~30% of the time against Gemini Live](https://github.com/livekit/agents/issues/5096) because the termination handshake waited on an unbounded audio-playback-completion signal. Both are the same lesson from different directions: **termination must be a first-class, boundedly-acknowledged message, not an inference from a side effect.**

## Prior Art: Everyone Converged on the Same Three Moves

### Persist first, send second

Offline-first sync engines never let intent live only in a network request:

- **Replicache** applies a mutation optimistically and persists a pending-mutation record locally before any network attempt; its docs state plainly that the same mutation can be sent multiple times and handlers "must be idempotent" ([how it works](https://doc.replicache.dev/concepts/how-it-works)). Every mutation carries a sequential per-client MutationID generated *before* the mutator runs.
- **Linear's sync engine** applies the mutation to in-memory state instantly and queues the same mutation for WebSocket push, decoupling "user saw it happen" from "server heard it" ([analysis](https://www.fujimon.com/blog/linear-sync-engine)).
- **Firestore offline persistence** queues writes across app restarts and flushes automatically on reconnect ([docs](https://firebase.google.com/docs/firestore/manage-data/enable-offline)) — with the useful nuance that durable *delivery* and conflict-free *application* are separate guarantees.
- **Automerge/CRDTs** make idempotence a property of the data structure itself: changes queue during a partition and merge safely regardless of duplication or order ([automerge.org](https://automerge.org/)).

### Mint the ID at intent-creation time

Payment APIs solved retried-command dedup a decade ago, and their contract is precise:

- **Stripe**: client generates a UUID `Idempotency-Key` per *logical operation*, not per HTTP attempt; the server persists key→result and replays the original response on retry ([Stripe blog](https://stripe.com/blog/idempotency)). Same key with different parameters is an explicit error — accidental key reuse must not silently masquerade as the earlier intent.
- **AWS**: `ClientToken` on mutating APIs, framed as a general reliability best practice (Well-Architected REL04-BP04, "make mutating operations idempotent"), with the same conflict-on-mismatch semantics ([docs](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_prevent_interaction_failure_idempotent.html)).

The shared rule: the identifier is generated **once, client-side, at the moment the intent is expressed**, and travels unchanged with every retry. An ID minted inside the send routine regenerates on each attempt and defeats the dedup entirely.

### Resend on channel-ready signals, not timers

- **MQTT QoS 1/2** requires unacknowledged messages to be re-sent *specifically on reconnect* with the same packet identifier — and v5 explicitly forbids resending at any other time ([EMQX design docs](https://docs.emqx.com/en/emqx/latest/design/retransmission.html)). The redelivery trigger is "the channel just became viable", a principled event, not a timer racing the guard state.
- **Socket.IO** is at-most-once by default; at-least-once requires explicitly adding acks, timeouts, and retries ([delivery guarantees](https://socket.io/docs/v4/delivery-guarantees)) — a reminder that realtime frameworks do not give you durable delivery for free.
- **Phoenix Channels** rejoins topics automatically after reconnect and buffers pushes for flush-on-join — and still had a documented edge case where a pre-join push was buffered but never flushed ([issue #1295](https://github.com/phoenixframework/phoenix/issues/1295)). Even frameworks built for this get the edges wrong; the pattern needs testing against adversarial timing, not just happy paths.

## Mapping Onto Realtime Voice Agent Protocols

The realtime voice APIs already expose the right server-side primitives; the client's job is to use them idempotently:

- **OpenAI Realtime** documents `response.cancel` as safe to send even when no response is in progress — you get an error event but "the session will remain unaffected" ([API reference](https://platform.openai.com/docs/api-reference/realtime-client-events/response)). A redundantly re-sent cancel is harmless by design. This is precisely the property that lets a client resend its end/cancel intent on every ready signal without first consulting local guard state.
- **Gemini Live** hard-caps connection lifetimes and sends a `GoAway` message with a `timeLeft` countdown before terminating, plus periodic `SessionResumptionUpdate` tokens the client persists and presents on reconnect ([session docs](https://ai.google.dev/gemini-api/docs/live-session)). Graceful termination is a first-class message type, and session continuity rides on a durable client-held token — the same persist-and-represent structure as a durable intent.

For an agent platform running conversations over a relay (browser → relay → model provider), this means the relay's canonical session state machine should treat "user requested end" as a **persistent flag with a request ID** that the client re-asserts on every `ready`/`mode-changed`/reconnect signal until the server confirms the terminal state — rather than as a single message whose loss strands the session.

## The Event-Sourcing Frame: Intent Is a Command, and Idempotency Must Cross the Stack

Event sourcing gives the cleanest vocabulary: a **command** is an expression of intent — retryable, rejectable, not yet fact; an **event** is an immutable record of what happened. Durable intent delivery is at-least-once command delivery with dedup, and the dedup must exist at *every* at-least-once hop: command handler (dedup on client-generated CommandId before emitting events), projections (their event delivery is also at-least-once), and the outbox boundary for external effects ([CQRS idempotency patterns](https://domaincentric.net/blog/event-sourcing-projection-patterns-deduplication-strategies)). A UI "end session" typically crosses client → gateway → session service → cleanup worker; fixing only the button fixes one hop of four.

## Practitioner Checklist

1. **Persist the intent locally the instant it's expressed** — before any network attempt, in state that survives reconnects (and ideally page reloads).
2. **Mint a stable request ID at intent-creation time**, never inside the retried send path.
3. **Resend on every channel-ready signal** (reconnect, ready, mode-change-settled) until the server confirms the terminal state. Stop conditions come from the server, not from local guard flags.
4. **Guards only reduce noise.** Post-click disable to suppress duplicate submission of an *already-persisted* intent is fine. Any guard whose failure mode is "the intent was never recorded or sent" is a bug.
5. **Never trust `send()` or `readyState`.** Detect zombie connections with an application-level heartbeat (miss threshold ≈ 3, interval below the shortest infra idle timeout in the path).
6. **Server-side idempotency is the actual correctness layer**: same ID + same params → same outcome, replayed safely within a stated retention window; same ID + different params → explicit conflict.
7. **Terminal-state transitions come first and are bounded.** Never sequence the guaranteed transition (the thing joiners and retries wait on) behind unbounded cleanup like adapter teardown or playback completion — demote cleanup to fire-and-forget after the terminal state is committed.
8. **State the guarantee window explicitly** (Stripe: 24h key retention; Gemini: 24h resumption tokens) instead of implying forever.
9. **Test with adversarial timing**: a legal-but-hostile counterpart (cancel that rejects, close that never resolves, socket that half-opens) plus a concurrent second operation is what discriminates these bugs; happy-path E2E has zero power over them.

## Relevance to Agent Platform Engineering

Any platform that puts a human in a long-lived realtime session with an agent — voice standups, conversational surveys, live copilots — has at least three critical intents (end, cancel, submit) whose loss strands a real user. The pattern above turns each into: one durable flag, one stable ID, one resend loop keyed to server-ready signals, one idempotent server handler, and one terminal-first commit ordering. It is a small amount of machinery, all of it boring and battle-tested elsewhere; the engineering discipline is refusing to let any transient client state stand between the user's intent and the server's chance to honor it.
