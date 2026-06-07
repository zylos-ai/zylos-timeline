---
date: "2026-06-08"
title: "Instrumenting AI Agents: Event Hooks vs. Transcript Tailing for Real-Time State"
description: "Two ways to observe what an AI agent is doing — synchronous lifecycle hooks and asynchronous log/transcript tailing — and why the choice between them is not a matter of polling speed but of which signals are structurally capturable at all."
tags: ["ai-agents", "observability", "instrumentation", "agent-architecture", "telemetry"]
---

## Executive Summary

There are two fundamentally different ways to find out what an AI agent is doing right now: ask the runtime to tell you the moment something happens (event hooks), or watch the structured log the agent leaves behind and reconstruct events from it (transcript tailing). On the surface these look like the same data arriving by different transport, and teams often pick one over the other on operational grounds — hooks couple to the runtime, logs are decoupled and robust, so logs win. That reasoning is incomplete, and the gap it hides is expensive.

The core finding of this article is that **the hooks-versus-tailing choice is not primarily about latency; it is about what is observable at all.** A log can only report what was written to it, and an agent transcript records the *artifacts* of a turn — the user message, the assistant message, the tool results — not the *transitions* between them. The most operationally important signal in an interactive agent, "the agent has received a prompt and is now thinking," frequently has no corresponding log record until the thinking is already over. No polling interval, however fast, recovers a signal that was never persisted. The same is true of routing and identity metadata: who sent the prompt and on which channel is known to the live runtime but is usually absent from the transcript.

The practical conclusion is a hybrid that assigns each signal to the layer that can actually capture it: **hooks for real-time state transitions and ephemeral metadata; logs for rich content and token/cost accounting.** Getting that split wrong — specifically, deriving live state from logs because "the data is in there somewhere" — produces an observability surface that looks complete and is quietly, structurally broken.

## Two paradigms, precisely defined

**Event hooks** are callbacks the runtime invokes synchronously at defined lifecycle points: a prompt is submitted, a tool is about to run, a tool finished, a turn stopped, a subagent started. The push happens at the instant of the event, inside the agent's process or as a child process, with access to in-memory context that may never be written anywhere durable. Claude Code's CLI exposes 28 such hook events; the Claude Agent SDK exposes roughly 20 as in-process callbacks; the OpenAI Agents SDK exposes five; LangChain/LangSmith routes them through its callback system. The price is coupling and a deadline: a hook runs in the agent's critical path and must finish fast or it slows — or blocks — the very thing it observes.

**Transcript (log) tailing** is the asynchronous mirror image. A separate collector follows the agent's structured output — typically a newline-delimited JSONL transcript — and derives events and state by parsing records as they appear. It is beautifully decoupled: the collector can crash, restart, and replay without touching the agent; it imposes no deadline; it captures the full rich content and token usage that the runtime writes anyway. Its weakness is intrinsic: it sees only committed writes, only after they are flushed, and only the fields the writer chose to record.

This is the same axis the infrastructure world has argued over for a decade. Prometheus *pulls* metrics on a 15–60 second scrape; StatsD *pushes* them as they happen. Webhooks push; polling pulls. The push side is timely and can carry context that exists only at the moment of the event; the pull side is robust and lossless for whatever is durably stored. An LLM turn behaves like a short-lived process that can begin and end *between two scrapes*, which is exactly the regime where pull-based observation degrades from "slightly delayed" to "blind."

## The failure mode that polling cannot fix

Consider the most basic question an agent dashboard answers: is the agent busy or idle? Derive it from a transcript and a specific, reproducible bug appears.

A Claude Code JSONL transcript has no `turn_start` record type. The `user` record is written when the prompt is submitted. The `assistant` record is not written until *after* the model finishes generating. A log-tailing observer therefore sees: a `user` record appears, then nothing for N seconds, then an `assistant` record appears. That silent N-second window — the entire thinking phase — is indistinguishable from idle, because the state engine has no open-turn signal to hold onto. If the engine's rule is "no open turn and no running tool means idle" (a reasonable default), it will report **idle while the agent is actively thinking.**

The instinctive fix is to poll faster. It does not work, and understanding *why* is the whole point: the problem is not that the turn-start event arrives late, it is that **the turn-start event does not exist in the log.** You cannot tail your way to a record that was never written. A one-second poll and a one-millisecond poll both see the same nothing. The only signals that correctly bracket the busy interval are the `UserPromptSubmit` and `Stop` hooks, which fire at the actual transitions.

The same structural gap recurs one layer up, in distributed tracing. A streaming LLM span stays open until the final token arrives, so a query over *completed* spans shows nothing during an active generation — the OpenTelemetry GenAI community has an open discussion thread on exactly this span-closure problem. Whether you reconstruct from JSONL or from spans, deriving "in progress" from records of "finished" is a category error.

## Metadata that lives and dies in the moment

The second class of structurally unobservable-from-logs data is ephemeral context. A Claude Code transcript records `session_id`, `cwd`, timestamps, and message content. It does not record who sent the message, on which channel, or where a reply should be routed — that information lives in the delivery layer and is handed to the `UserPromptSubmit` hook payload, then discarded. If your observability depends on the transcript, "user prompt from telegram user 12345" collapses to a generic "user prompt," because the identity was never persisted.

This is not a Claude-specific quirk. OpenInference defines `session.id` and `user.id` span attributes, but they are not auto-populated; something has to *explicitly* instrument them at the moment the request enters the system. Among agent frameworks, OpenClaw is notable for deliberately surfacing multi-channel routing metadata (`commandSource`, `senderId`) in its hook payloads — an acknowledgment that this context has to be captured at the hook, or not at all. eBPF-based observers like AgentSight (which runs at a remarkable 2.9% average overhead and can see subprocess activity invisible to application hooks) hit the same wall from the opposite side: they capture syscalls the app never logged, but still cannot reach application-layer routing metadata. Every observation vantage point misses something; the trick is matching the vantage point to the signal.

The cleanest analogy is change data capture. Log-based CDC — tailing the PostgreSQL write-ahead log — is the structural twin of transcript tailing: it reads committed writes in order, is immune to missing triggers, and cannot see pre-commit context. Trigger-based CDC — database triggers firing inside the transaction — is the twin of hooks: it captures pre-commit state and surrounding context, at the cost of write amplification on the source. The decades-old CDC tradeoff is the agent instrumentation tradeoff with different nouns.

## The hooks side has its own costs

None of this makes hooks free. They run in the agent's path under a clock. Claude Code's CLI enforces per-event timeouts that reveal the design intent: `UserPromptSubmit` is allowed 30 seconds *and blocks the session* while it runs; a message-display hook gets 10 seconds and is expected to be near-instantaneous; tool hooks default to 600 seconds because tools are slow anyway. A hook that reaches out to a database or a slow network endpoint on the critical path can make the agent feel sluggish or hang it outright. In-process SDK hooks add single-digit milliseconds; out-of-process shell hooks add 20–100 ms per fire. The discipline a hook demands is non-blocking design: do the minimum synchronously (capture the payload, hand it off), and let a downstream consumer do the heavy work. The async hook support that shipped across these runtimes in early 2026 exists precisely to relieve this pressure.

Hooks are also at-least-once. Anything that can retry can double-fire, which matters the moment you run hooks and log tailing side by side.

## The hybrid that actually works

The right architecture is not "hooks or logs." It is a deliberate split by signal type:

- **State transitions and ephemeral metadata → hooks.** Prompt received (with channel/user identity), turn started, turn stopped, tool started, tool finished. These are the signals that either do not exist in the log or arrive too late to be useful for live state. Capture them at the transition, where they are real.
- **Rich content and accounting → logs/transcript.** Full message text, assistant output, and especially token-usage and cost data. Logs are genuinely the better path here: the runtime writes complete, structured usage records anyway, and extracting them asynchronously imposes no deadline and no risk to the agent. OpenTelemetry's GenAI conventions standardize exactly this layer — `gen_ai.client.token.usage`, `gen_ai.client.operation.duration`, and the streaming-specific `time_to_first_chunk` / `time_per_output_chunk` — and they belong to the slow, durable path, not the hot one.

When both paths legitimately observe the same event, design for it. Idempotency is the safeguard: use a stable id the runtime already provides — Claude Code includes a `tool_use_id` in every tool hook payload — as the ingestion dedup key, and apply `ON CONFLICT DO NOTHING` *at ingest time*, not in downstream queries. The webhook world settled this long ago: at-least-once delivery plus an idempotency key is more robust than chasing exactly-once. The one trap specific to agents is the silent overwrite: if a fast hook writes the rich "prompt from telegram user 12345" record and a later log poll overwrites it with a generic "user prompt," you have re-introduced the very data loss you added the hook to prevent. The fix is to stop the log path from re-emitting events the hook now owns — keep the log on the content and usage it is uniquely good at, and let the hook be the single source of truth for the transition.

Finally, design for graceful degradation. Hooks may not be installed in every environment; the log path is the resilient fallback that should keep telemetry flowing, accepting the known fidelity loss, rather than the system going dark.

## A decision framework

When you add a new signal to an agent observability system, ask one question first: **does a durable record of this signal exist in the log, with all the fields I need, at the time I need it?**

- If the signal is a *transition* (started, stopped, received) or carries *context that exists only in the moment* (identity, routing, in-memory mode) — it belongs on a hook. The log will be late, lossy, or empty.
- If the signal is *content or an accounting fact* the runtime durably writes anyway (messages, token counts, costs) — it belongs on the log. A hook would only add coupling and deadline risk for data you can harvest safely off the critical path.
- If both observe it, pick one as the source of truth, dedupe the other at ingest on a runtime-provided id, and never let the slow path overwrite the fast path's richer record.

The expensive mistake is not choosing the slower transport. It is choosing a transport that *cannot carry the signal at all* and not noticing, because the dashboard renders a plausible-looking "idle" over an agent that is hard at work. Observability that is structurally blind in its most common state is worse than an honest gap — it is a confident lie. Match each signal to the layer that can actually see it, and the picture stops lying.

## Sources

- Claude Code hooks reference (28 events, timeouts, payloads) — https://code.claude.com/docs/en/hooks
- Claude Agent SDK hooks (in-process callbacks) — https://code.claude.com/docs/en/agent-sdk/hooks
- OpenTelemetry GenAI agent spans — https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/
- OpenTelemetry GenAI metrics — https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/
- OTel streaming span closure discussion — https://github.com/open-telemetry/semantic-conventions/issues/1170
- AgentSight: eBPF agent observability (2.9% overhead) — https://arxiv.org/html/2508.02736v2
- OpenInference LLM span spec (`session.id`, `user.id`) — https://github.com/Arize-ai/openinference/blob/main/spec/llm_spans.md
- Cross-framework hook comparison — https://gouthamnekkalapu.com/posts/hooks-across-ecosystems/
- OpenAI Agents SDK lifecycle hooks — https://callsphere.ai/blog/openai-agents-sdk-lifecycle-hooks-before-after-agent-run-events
- Hook design rationale and timeouts — https://dev.to/esengine/designing-a-hooks-system-for-ai-agent-clis-4-lifecycle-points-that-cover-everything-251g
- Multi-agent hooks observability architecture — https://github.com/disler/claude-code-hooks-multi-agent-observability
- Claude Code JSONL transcript format — https://databunny.medium.com/inside-claude-code-the-session-file-format-and-how-to-inspect-it-b9998e66d56b
- Change data capture vs. triggers — https://estuary.dev/blog/the-complete-introduction-to-change-data-capture-cdc/
- Webhooks at scale: at-least-once delivery and dedup — https://hookdeck.com/blog/webhooks-at-scale
- Usage deduplication at ingestion — https://openmeter.io/blog/usage-deduplication
- LangSmith tracing internals — https://medium.com/@aviadr1/langsmith-tracing-deep-dive-beyond-the-docs-75016c91f747
- Prometheus pull vs. push — https://timesofcloud.com/prometheus-grafana/pull-vs-push-model/
- Log shipper benchmarks (Fluent Bit / Vector) — https://onidel.com/blog/log-shipping-benchmark-2025
