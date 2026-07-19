---
date: "2026-07-19"
title: "Cross-Provider Realtime Voice: Adapting Gemini Live to the OpenAI Realtime Surface"
description: "A practitioner's comparison of the OpenAI Realtime and Google Gemini Live protocols and the adapter patterns needed to run one voice agent codebase across both."
tags:
  - voice-ai
  - realtime-api
  - openai
  - gemini
  - protocol-adapters
  - agent-infrastructure
---

## Executive Summary

By mid-2026, two speech-to-speech protocols dominate production voice agents: OpenAI's Realtime API (now on `gpt-realtime-2.1`) and Google's Gemini Live API (`BidiGenerateContent`, now fronting Gemini 3.1 Flash Live and 2.5 native-audio models). They solve the same problem — a persistent, full-duplex, audio-in/audio-out session with interruption, tool calling, and server-side turn detection — but they disagree on almost every wire-level detail: event names, turn lifecycle, VAD tuning knobs, audio sample rates, and how "thinking" interacts with spoken output.

Rather than build a provider-neutral abstraction from scratch, the pattern that has actually won in the field is **asymmetric adaptation**: treat the OpenAI Realtime WebSocket event schema as the de facto standard (multiple vendors — Inworld, xAI's Grok Voice Agent — now expose OpenAI-compatible endpoints directly), and write a translation adapter for anything that doesn't already speak it, Gemini Live chief among them. This is exactly the shape of the integration this note generalizes from: a voice-agent system (Rounds) built on OpenAI Realtime that added Gemini Live support via an upstream adapter emulating the OpenAI WS surface, handling event translation, 24kHz→16kHz resampling with anti-alias filtering, native bidirectional transcription (replacing a separate ASR sidecar), `thinkingConfig` pitfalls that silently degrade barge-in, and VAD retuning for Chinese speech cadence.

This note lays out the current shape of both protocols, the concrete engineering mismatches an adapter must absorb, how the open-source agent frameworks (Pipecat, LiveKit Agents, TEN) handle multi-provider abstraction, a cost/latency comparison methodology, and where standardization is (and isn't) heading.

## The Two Protocols, Side by Side

Both are stateful, bidirectional, audio-native session protocols — a sharp departure from request/response chat completions. A client opens a long-lived connection, streams raw PCM audio in, and receives streamed PCM audio out, interleaved with structured events for transcripts, tool calls, and turn state.

| Dimension | OpenAI Realtime API | Gemini Live API |
|---|---|---|
| Transport | WebSocket (`wss://api.openai.com/v1/realtime`), also WebRTC and SIP | WebSocket (`wss://…BidiGenerateContent`) |
| Session init | `session.update` client event | `setup` message (first frame on the socket) |
| Current flagship model | `gpt-realtime-2.1` (mini tier: `gpt-realtime-2.1-mini`) | `gemini-3.1-flash-live-preview`, plus `gemini-2.5-flash-native-audio-preview-12-2025` |
| Response modality control | `output_modalities`: `["audio"]`, `["text"]`, or both | `response_modalities`; **native-audio models support `AUDIO` only** — text must come from output transcription |
| VAD / turn detection | `turn_detection`: `semantic_vad` (default, model-judged), `server_vad` (energy-based), or `null` (manual push-to-talk) | `automaticActivityDetection` with `startOfSpeechSensitivity` / `endOfSpeechSensitivity` (LOW/MEDIUM/HIGH), `silenceDurationMs`, `prefixPaddingMs` |
| Input audio format | PCM16, configurable rate, 24kHz typical | PCM16 **fixed at 16kHz**, little-endian |
| Output audio format | PCM16 or PCMU, ~24kHz | PCM16, **fixed at 24kHz** |
| Native transcription | `whisper` or `gpt-4o-transcribe` for input; output audio is itself the "transcript" unless text modality requested | `inputAudioTranscription` and `outputAudioTranscription`, both native, bidirectional, no sidecar ASR required |
| Interruption / barge-in | Client detects `input_audio_buffer.speech_started`, sends `conversation.item.truncate`; WebRTC/SIP auto-truncate server-side | Server sets `interrupted` flag on `BidiGenerateContentServerContent`; client clears local playback queue |
| Reasoning control | N/A (no exposed "thinking" step) | `thinkingConfig` — `thinkingLevel` (3.1 models: minimal/low/medium/high) or `thinkingBudget` (2.5 models, token count, 0 disables) |
| Tool calling | `function_call` items in the conversation, client executes, returns `function_call_output`, then `response.create` | Function/tool calls interleaved in `BidiGenerateContentToolCall`; async tool use supported |
| Session length | Up to 60 minutes per connection, no built-in resumption protocol documented | 15 min audio-only / 2 min audio+video by default; extendable via `contextWindowCompression`; `SessionResumptionUpdate` handles reconnect with a resumption token valid ~2 hours; `GoAway` message warns of imminent termination |
| Pricing (mid-2026) | Audio in ≈ $32/1M tokens (~$0.06/min), audio out ≈ $64/1M tokens (~$0.24/min); mini tier ~1/3 the cost; cached input ~$0.40/1M | Audio in ≈ $3/1M tokens (~$0.005/min), audio out ≈ $12/1M tokens (~$0.018/min) on Flash Live; free tier available on AI Studio with rate limits |

The pricing gap is the headline: Gemini Live's audio tokens are priced roughly **10x cheaper** than OpenAI's per-minute equivalents, which is the commercial reason teams bother building the adapter at all rather than staying single-provider. OpenAI's edge is elsewhere — richer tool-calling maturity, longer sessions, and (per independent latency panels) competitive time-to-first-audio on `gpt-realtime-1.5`/`2.1`, while some `flash-live` benchmarks running through third-party relays show notably higher tail latency, likely reflecting infrastructure/region effects rather than the protocol itself.

## Why Adapt *To* OpenAI's Surface, Not Build a Third Abstraction

When a system already has a working OpenAI Realtime integration — event handlers, audio pipeline, tool-calling glue, reconnect logic — the lowest-risk way to add a second provider is not to invent a provider-neutral internal protocol and rewrite both sides against it. It's to build a **shim that makes the second provider look like the first one** to the rest of the codebase.

Two things make this specifically viable for Gemini:

1. **OpenAI's event schema is becoming the industry's lingua franca by adoption, not by standards body.** Inworld's Realtime API is explicitly OpenAI Realtime-schema-compatible — same event names, same message flow, same SDKs, swap the base URL. xAI's Grok Voice Agent API (shipped December 2025) does the same at `wss://api.x.ai/v1/realtime`, with only minor event-name deltas (e.g., `conversation.item.input_audio_transcription.updated` instead of OpenAI's `.delta`, and it's cumulative, not incremental). That means an adapter written once to emulate the OpenAI surface pays off for more than just Gemini.
2. **The alternative — a fully generic internal event bus** — is what the open-source frameworks (LiveKit Agents, Pipecat) already offer, and building a bespoke one inside a single product is usually wasted effort unless you need the framework's other affordances (room/media server, multi-party audio mixing, telephony bridging). If a system is already OpenAI-Realtime-shaped end to end, adapting inbound is cheaper than migrating to someone else's abstraction.

The adapter sits **upstream of the provider**, translating Gemini Live's `BidiGenerateContent` wire format into synthetic OpenAI Realtime events (`session.created`, `response.audio.delta`, `conversation.item.input_audio_transcription.completed`, `input_audio_buffer.speech_started`, etc.) that the existing application code already knows how to consume. The rest of the system — the orchestration, the tool dispatch, the transcript store — never learns a new protocol.

### Reference shape of an adapter

A minimal event-translation table looks roughly like this in practice:

| OpenAI Realtime event (emitted to app) | Synthesized from Gemini Live message |
|---|---|
| `session.created` | first successful `setup` ack |
| `input_audio_buffer.speech_started` | `automaticActivityDetection` start-of-speech signal (or local VAD, if the app drives its own) |
| `conversation.item.input_audio_transcription.delta`/`.completed` | `inputAudioTranscription` fragments, buffered/segmented to emulate delta vs. completed framing |
| `response.audio.delta` | `serverContent.modelTurn.parts[].inlineData` (audio) chunks, resampled 24kHz passthrough |
| `response.audio_transcript.delta` | `outputAudioTranscription` fragments |
| `response.done` | `turnComplete` (guarded against the premature-`turnComplete` bug, see below) |
| `response.function_call_arguments.done` | `toolCall` message, arguments serialized to match OpenAI's JSON-string-in-item convention |
| `conversation.item.truncate` (outbound, client→server) | translated to nothing on the wire — Gemini has no equivalent; the adapter instead locally discards queued output audio and relies on Gemini's own `interrupted` flag rather than emitting a truncate command upstream |

The important discipline is that the adapter is allowed to be *lossy in one direction* (it can drop or approximate app-issued events that Gemini has no concept of) but must be *faithful in the other* (anything the app receives has to look exactly like what the OpenAI SDK would have produced, including field names and framing), because the app-side code has no idea it's not talking to OpenAI.

## The Hard Mismatches

Everything below is a place where a naive 1:1 event translation breaks, because the two protocols encode genuinely different assumptions about how a spoken turn works.

### 1. Turn lifecycle and interruption semantics

OpenAI's model is explicit and client-driven at the edges: the client sees `input_audio_buffer.speech_started`, decides to stop local playback, and sends `conversation.item.truncate` with an `audio_end_ms` so the server knows exactly how much of its own audio was actually heard before being cut off. On WebRTC/SIP transports this truncation is automatic; on raw WebSocket, the client is responsible for it.

Gemini's model is server-declarative: the server unilaterally marks a turn `interrupted` inside `BidiGenerateContentServerContent`, and the client's job is just to stop playing queued audio and clear its buffer. There's no equivalent of "tell the server how much of the last utterance you actually played" — Gemini doesn't need it because it tracks generation state itself.

The adapter has to fabricate OpenAI-shaped truncation semantics from Gemini's coarser signal, which means tracking local playback position independently (how many audio frames were actually flushed to the output device) rather than trusting either server to know it. Getting this wrong shows up as clipped words at the *start* of the agent's next turn, not the end — a subtle bug that's easy to miss in short test calls and only surfaces in real back-and-forth conversation.

A second-order issue reported widely in mid-2026: Gemini's native-audio models have a **known bug class** where the server sends `turnComplete` mid-generation with no `interrupted` flag set — the model just stops speaking mid-sentence, unprompted by any user speech. This is tracked across `googleapis/python-genai`, `googleapis/js-genai`, and the `live-api-web-console` repos, with reports that it worsens specifically after tool-call returns. An adapter needs its own heuristic (e.g., detect suspiciously short response audio following a function result and treat it as a truncation to gracefully re-prompt) because there's no clean protocol-level signal to distinguish "model finished" from "model got cut off by a server bug."

### 2. VAD semantics and cross-language tuning

OpenAI's `semantic_vad` is model-judged — it uses the model's own understanding of the utterance to decide the user is done, with an `eagerness` knob and separate `interrupt_response`/`create_response` flags so you can decouple "detect end of turn" from "automatically generate a response." `server_vad` is the older energy-threshold mode with `threshold`, `prefix_padding_ms`, `silence_duration_ms`.

Gemini's `automaticActivityDetection` is a more classical two-sided energy/sensitivity model: `startOfSpeechSensitivity` and `endOfSpeechSensitivity` (each LOW/MEDIUM/HIGH) plus `silenceDurationMs` and `prefixPaddingMs`, with Google's own documentation recommending **at least 500–800ms of silence** before ending a turn.

Neither of these is a drop-in replacement for the other, and neither ships tuned for every language. Mandarin and other tonal/syllable-timed languages have shorter natural inter-word pauses and different breath/pause cadence than English speech, and a silence-duration threshold tuned against English test calls will systematically clip Chinese speakers mid-sentence or, in the other direction, feel sluggish because it's waiting through pauses that aren't actually turn boundaries. Tuning VAD is not something an adapter can get right generically — it has to be treated as a per-locale, per-provider calibration surface, exposed as configuration rather than hardcoded, and validated against real recorded conversations in the target language rather than assumed from the vendor's English-tuned defaults.

### 3. Audio format and resampling

OpenAI is comparatively flexible on rate (commonly 24kHz PCM16 in and out, PCMU also supported for telephony). Gemini Live is rigid: **16kHz PCM16 input, 24kHz PCM16 output**, non-negotiable. Any system built around a 24kHz capture pipeline (or a browser client that hands over 48kHz and downsamples to 24kHz for OpenAI) needs a second resampling stage to hit Gemini's 16kHz input requirement.

The naive approach — decimate every Nth sample — introduces aliasing: energy above the new Nyquist frequency folds back into the audible band as noise, and for speech this specifically degrades consonants and sibilants, which is exactly the content VAD and ASR rely on most. The correct approach is band-limited resampling: a low-pass filter at the target Nyquist frequency *before* decimation, not after. Where the ratio is large (e.g., 48kHz→16kHz, a 3:1 ratio), doing it as a single step is riskier than a staged conversion (48→24→16) because each stage's filter has an easier job and introduces less passband ripple — the same principle that makes 24kHz→16kHz (a clean 3:2 ratio) tractable but naive 24kHz→8kHz noticeably worse. In an adapter, this resampling has to sit in both directions: downsample capture audio 24→16kHz on the way in, and the output audio Gemini returns at 24kHz generally matches what a 24kHz-native playback pipeline already expects, so that leg is often free — but if the rest of the stack assumes a single fixed rate throughout, the input leg is not.

### 4. Thinking budget vs. audio latency and tool calls

Gemini's `thinkingConfig` is unique to this comparison — OpenAI's Realtime models expose no reasoning-step control. On Gemini 3.1 models it's `thinkingLevel` (minimal/low/medium/high, defaulting to minimal for latency); on 2.5 models it's a numeric `thinkingBudget` you can zero out. This matters for voice specifically because reasoning tokens are generated *before* the first audio token, so any non-minimal thinking level directly adds to time-to-first-audio — the single most latency-sensitive metric in a voice UX. Two pitfalls recur in practice:

- Even with `thinking_budget=0` / `include_thoughts=False`, some Gemini Live model versions have been reported to still leak internal thinking content into the response stream, which an adapter has to filter defensively rather than trust the config to fully suppress.
- Tool calling interacts badly with thinking: a tool round-trip already adds latency (client executes, sends result back), and if the model then re-engages a non-trivial thinking level before speaking the result, the combined delay is where the mid-sentence-truncation bug above tends to concentrate — suggesting the two issues share a root cause in how the server manages long-running turns that span a tool call.

The practical mitigation is to force minimal/zero thinking budget for any latency-sensitive conversational turn, and reserve higher thinking levels (if used at all) for asynchronous, non-blocking tool-invoked reasoning rather than the live conversational path.

### 5. Tool-call flow shape

Both protocols support function calling mid-conversation, but the *shape* of the round trip differs enough that an adapter needs explicit state tracking rather than a stateless translation. OpenAI's flow is a clean three-step exchange: the model emits a `function_call` conversation item with a `call_id`, the client executes and posts back a `function_call_output` item referencing that same `call_id`, and the client explicitly triggers `response.create` to resume generation. Nothing happens until the client asks for it — which is convenient for an adapter because it can hold the synthesized OpenAI-shaped events until it has everything it needs.

Gemini's `BidiGenerateContentToolCall` arrives inline in the turn stream, and — notably — Gemini supports **asynchronous tool use**, where the model can continue speaking (or move on) while a long-running tool executes in the background and its result is patched in later, rather than blocking the turn on the tool's completion. An adapter that assumes OpenAI's block-until-tool-returns model will either stall unnecessarily waiting for Gemini to "finish" a turn that was never going to block, or mishandle the case where audio keeps streaming past a still-pending tool call. Getting this right means the adapter has to track tool-call state independently of turn state, rather than assuming one gates the other.

### 6. Session resumption and context handoff

OpenAI Realtime sessions run up to 60 minutes with no documented resumption protocol — a dropped connection generally means a new session and, if needed, application-level context replay (re-sending relevant prior turns as text/system context). Gemini Live is more explicit here: opt into session resumption at setup time and the server periodically emits `SessionResumptionUpdate` messages carrying a token; reconnect within roughly 2 hours using that token as the new session's `handle` to continue where you left off. Separately, `contextWindowCompression` lets a single logical session outlive its default 15-minute (audio-only) cap by sliding-window compressing older context rather than dropping the connection. An adapter that wants to expose "long call" semantics uniformly across both providers has to build its own resumption/replay layer for the OpenAI side, since the protocol doesn't give you one, while surfacing (and correctly re-registering) Gemini's native token on every reconnect.

### 7. Voice and persona portability

Neither protocol gives you the same voice. OpenAI ships a fixed named-voice catalog (alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar) that becomes immutable for a session after first audio output. Gemini's `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName` draws from Google's separate TTS voice catalog. There is no shared voice identity — "the same agent persona" across providers is a product/prompt-design problem (consistent instructions, consistent name, consistent register) rather than something the protocol layer can paper over. Systems that need brand-consistent persona across providers should treat voice selection as a per-provider config value tied to the persona, not something derived automatically.

## Native Transcription Removes a Moving Part — But Changes Failure Modes

A secondary but material win from either protocol's native bidirectional transcription is that it lets a system retire a separate ASR sidecar (e.g., a standalone streaming Whisper deployment) that used to run in parallel just to get a text transcript for logging, analytics, or downstream NLU. Both `gpt-4o-transcribe`/`whisper` (OpenAI) and `inputAudioTranscription`/`outputAudioTranscription` (Gemini) produce that transcript as a first-class stream on the same connection, which is one fewer service to deploy, one fewer audio fan-out to manage, and one fewer place where transcript and audio can drift out of sync.

The tradeoff an adapter has to absorb: a dedicated ASR sidecar is a component you can swap, tune, or fall back on independently of the realtime provider; native transcription is entirely at the mercy of that provider's transcription quality and its bugs (Gemini's premature-`turnComplete` issue, for instance, doesn't just cut audio — it truncates the transcript at the same point, so any downstream system reading transcripts for compliance or QA has to be aware it may see prematurely truncated text with no distinguishing marker). If a system has hard requirements around transcript completeness (e.g., regulatory call logging), it's worth explicitly testing transcript segmentation edge cases against both providers rather than assuming "native = strictly better."

## Framework Landscape: How Others Abstract This

A system doesn't have to build its own adapter layer from zero; several open-source frameworks have already solved (parts of) this problem, and it's worth knowing their tradeoffs even when the decision is to build a narrower purpose-built adapter instead.

- **Pipecat** models a voice agent as a left-to-right pipeline of frame processors (VAD → STT → LLM → TTS, or a single realtime-model node standing in for the middle three). It's transport-agnostic by design — the pipeline doesn't care whether audio arrives over WebRTC, a phone call, or a raw socket — which makes it a natural fit for teams that want to swap STT/LLM/TTS vendors independently, and it has first-class support for both OpenAI Realtime and Gemini Live as drop-in "realtime model" pipeline nodes.
- **LiveKit Agents** provides a `RealtimeSession`/`RealtimeModel` abstraction per provider plugin (OpenAI, Gemini, Nova Sonic, xAI, etc.) sitting inside its own room/media-server infrastructure. Swapping providers is close to a one-line config change in the common case, at the cost of buying into LiveKit's transport and room model rather than staying transport-agnostic. Its Gemini plugin also natively streams camera/screen-share frames alongside audio when multimodal input is enabled, something the OpenAI Realtime protocol doesn't currently support.
- **TEN Framework** takes a more graph/extension-oriented approach aimed at multimodal (voice + vision) agents with a stronger emphasis on pluggable turn-detection extensions — useful if VAD/turn-detection is itself something you expect to swap out independently of the model provider.
- **Amazon Nova Sonic** and **Azure Voice Live API** are notable as full "batteries included" alternatives rather than protocols to adapt around: Nova Sonic unifies understanding and generation with strong per-minute pricing (~$0.02/min) and a large context window, while Azure Voice Live bundles VAD, echo cancellation, noise suppression, and avatar streaming behind one API, with the option to select OpenAI-family voices within Azure's own session model. Neither has seen the same organic "OpenAI-schema-compatible" convergence as Inworld and xAI, so adapting to them means genuine protocol translation, not schema aliasing.

The pattern across all of them: the frameworks that scale to many providers do so by defining their **own** internal event/session abstraction and writing N provider adapters against it — which is the generic version of exactly what a single-provider-turned-two-provider system does when it emulates its first provider's surface instead of a third abstraction. The framework route pays off when you need more than two providers, or you need the framework's other infrastructure (rooms, telephony, recording); the narrow-adapter route pays off when you have a working single-provider system and want to add one more provider with minimal blast radius to existing code.

| Framework | Abstraction unit | Transport coupling | Realtime-model providers covered | Best fit |
|---|---|---|---|---|
| Pipecat | Frame processor pipeline | Transport-agnostic | OpenAI, Gemini, Nova Sonic, Azure Voice Live, plus cascaded STT/LLM/TTS | Teams that want to mix-and-match realtime models with classic cascaded pipelines in the same codebase |
| LiveKit Agents | `RealtimeSession`/`RealtimeModel` plugin per provider | Coupled to LiveKit rooms/media server | OpenAI, Gemini (incl. video), Nova Sonic, xAI | Teams already on LiveKit for transport/telephony/multi-party |
| TEN Framework | Extension graph, pluggable turn-detection | Loosely coupled | Growing provider set, strong multimodal/vision focus | Voice + vision agents where turn-detection itself needs to be swappable |
| Purpose-built adapter (this note's subject) | Emulated OpenAI Realtime event stream | Whatever the existing system already uses | One additional provider at a time, by design | A working single-provider system adding exactly one more provider with minimal disruption |

## Other Notable Players, Briefly

- **Amazon Nova Sonic / Nova 2 Sonic**: unifies speech understanding and generation in one model, supports seven languages, polyglot voices, cross-modal switching between voice and text mid-session, asynchronous tool use (similar in spirit to Gemini's), and up to a 1M-token context window. Pricing (~$0.02/min) undercuts both OpenAI and, on some workloads, even Gemini Flash Live. It has its own Bedrock-native event protocol (via `InvokeModelWithBidirectionalStream`), unrelated to either OpenAI's or Google's schema, so integrating it means a third, independent adapter rather than reuse of Gemini-adapter logic.
- **Azure Voice Live API**: positions itself as a fully managed, "batteries included" layer — VAD, echo cancellation, noise suppression, semantic turn detection, and avatar streaming (including photo-realistic custom avatars) bundled behind one API, notably including the *option* to use OpenAI-family voices within its own session model. This makes it attractive for enterprises wanting a single vendor contract and support line rather than for teams optimizing for protocol portability.
- **xAI Grok Voice Agent**: covered above under standardization — notable precisely because it chose to clone OpenAI's schema rather than invent its own, and reports the lowest time-to-first-audio in several 2026 latency panels.

## A Decision Framework for Choosing an Approach

For a team deciding how to support a second (or third) realtime voice provider, the shape of the decision generally reduces to three questions:

1. **How many providers do you actually need, realistically, in the next 12 months?** One additional provider (as in the OpenAI→Gemini case this note generalizes from) strongly favors a narrow, purpose-built adapter: the surface area is bounded, the team already understands the target schema (their own, from the first integration), and the maintenance cost is one translation layer, not a whole framework dependency. Three or more providers tips the calculus toward adopting (or building) a proper N-provider abstraction, because the marginal cost of each additional adapter under a framework is lower than repeatedly hand-rolling point-to-point shims.
2. **Do you need the framework's other infrastructure?** If telephony bridging, multi-party rooms, recording, or vision/screen-share are already requirements, LiveKit Agents or Pipecat's ecosystem value goes well beyond the realtime-model abstraction alone, and adopting the framework is likely justified independent of the provider-portability question.
3. **How deep are the semantic mismatches for the providers you actually need?** Adapting to xAI or Inworld is nearly free (schema-compatible by design). Adapting to Gemini requires absorbing real semantic differences (thinking budgets, async tool use, server-declarative interruption, fixed sample rates). Adapting to Nova Sonic or Azure Voice Live means a from-scratch protocol translation with no schema head start. Budget adapter engineering effort accordingly — it is not the same fixed cost per provider.

## Testing and Validating an Adapter

Unit tests against recorded event fixtures catch schema drift but not the failure modes that actually matter in production voice, which are timing-dependent and only show up under real conversational dynamics. A useful validation ladder:

1. **Fixture replay**: capture real `BidiGenerateContent` message sequences (including tool calls, interruptions, and the premature-`turnComplete` bug) and replay them through the adapter, asserting the synthesized OpenAI-shaped event stream matches what the OpenAI SDK would actually emit for an equivalent scenario. This is cheap, deterministic, and catches most schema-level regressions.
2. **Scripted live calls, both providers, same script**: run an identical scripted conversation (including deliberate interruptions at fixed points, a tool call, and a long pause) against both the adapter-fronted Gemini path and the native OpenAI path, and diff the application-level behavior (what got logged, what the transcript store recorded, whether the agent's turn was clipped). Divergence here is the adapter, not the underlying model.
3. **Locale-specific conversational corpora**: for VAD tuning specifically, a small set of recorded real conversations in the target language (not synthetic TTS test audio, which tends to have unnaturally clean silence gaps) is the only reliable way to validate `silenceDurationMs`/`endOfSpeechSensitivity` settings — synthetic test audio will pass VAD tests that real speech with natural disfluencies and pauses would fail.
4. **Chaos on the tool-call path**: since both the truncation bug and the async-tool-use mismatch concentrate around tool calls, specifically test interruption *during* a pending tool call, not just during plain speech — this is the scenario most likely to be under-covered by scripted happy-path testing.
5. **Long-session soak tests**: exercise session resumption (Gemini's token-based reconnect, or whatever context-replay mechanism substitutes for OpenAI's lack of one) across a connection drop mid-conversation, since this path is rarely exercised in short manual testing but is exactly what happens on flaky mobile networks in production.

## Cost and Latency: A Comparison Methodology

Vendor-reported latency numbers are not comparable to each other without controlling for measurement point, and several 2026 write-ups illustrate the range: production panels put `gpt-realtime-1.5`/`xAI Grok Voice Agent` time-to-first-audio around 0.8s, while some third-party relay-based measurements show `gemini-3.1-flash-live` closer to 3s — a gap almost certainly dominated by network path and relay/region choice rather than raw model latency, given other benchmarks show Gemini's native-audio dialog models among the fastest at ~0.6s. This is the core methodology trap: **latency numbers are meaningless without stating measurement point (client mic → first speaker sample vs. server-received-audio → first-audio-byte), network path, and region.**

Reported time-to-first-audio figures from independent 2026 panels illustrate the spread (treat as directional, not authoritative, given the methodology caveat above):

| Model | Reported TTFA (2026 panels) |
|---|---|
| xAI Grok Voice Agent | ~0.78s |
| OpenAI gpt-realtime-1.5 / 2.1 | ~0.82s |
| Amazon Nova 2 Sonic | ~1.14s |
| Gemini 2.5 Flash Native Audio Dialog | ~0.63s (direct) / up to ~2.98s (via some third-party relay setups) |

The Gemini spread above is the clearest illustration of why measurement point matters more than model choice: the same underlying model shows up as one of the fastest *or* one of the slowest depending entirely on whether the measurement includes a relay hop.

A workable internal methodology:

1. **Component-level, not just end-to-end**: measure time-to-first-audio-byte from the server separately from client-side jitter buffer and playback scheduling latency, so provider comparisons aren't polluted by your own client code.
2. **Percentiles, not averages**: track p50/p95/p99 of end-to-end voice-activity-response-time (VART) — tail latency is what users notice as "the agent froze," and it's driven by different failure modes (retries, tool round-trips, reasoning-token overhead) than the median.
3. **Cost per realized minute, not list price per token**: audio token-to-minute conversion differs by provider (OpenAI ≈ $0.06/min in, $0.24/min out on the flagship tier; Gemini Flash Live ≈ $0.005/min in, $0.018/min out) and real conversations include silence, retries, and tool round-trips that inflate effective cost well past the sticker rate — a 5-minute call and a 30-minute call do not scale linearly per-minute once system-prompt and context-window growth are factored in.
4. **Same-scenario, both providers, same day**: because both protocols evolve monthly (new model revisions, pricing changes), a comparison run weeks apart across providers is not trustworthy; run the same scripted conversation set against both within the same measurement window.

## Outlook: Is a Standard Emerging?

Not through a standards body — but **through imitation**, which in practice is doing the job a standard would. By mid-2026:

- **Inworld's Realtime API** is explicitly built OpenAI-Realtime-schema-compatible — same event names, same message flow — while fronting a router that can swap the underlying LLM (including Gemini, Claude, Llama, Mistral) without the client-facing protocol changing at all.
- **xAI's Grok Voice Agent API** (shipped December 2025) speaks the OpenAI Realtime event schema at `wss://api.x.ai/v1/realtime`, with most OpenAI Realtime client libraries working against it via a base-URL swap and only minor per-event naming differences.
- Google and Amazon have **not** converged their wire protocols toward OpenAI's — Gemini Live and Nova Sonic remain protocol-incompatible with the OpenAI schema at the transport level — but both are increasingly reachable *through* the abstraction frameworks (LiveKit Agents, Pipecat) that hide the difference behind a provider-neutral SDK surface.

This mirrors, with a lag, how OpenAI's Chat Completions format became the de facto text-generation interface that Groq, Together, Mistral, and countless others chose to imitate rather than compete against on protocol shape — the network effect of existing client code and tooling outweighs any technical merit a competing schema might have. The realtime-voice version of that convergence is roughly a generation behind text: two of the four major model providers have adopted OpenAI's event schema outright, one (Gemini) has such deep architectural differences (native multimodal input, thinking-token budgets, different turn-completion signaling) that schema-level convergence looks unlikely soon, and one (Amazon) has stayed in its own AWS-native lane. There is no formal standards effort (no IETF/W3C working group on realtime-voice-agent wire protocols as of mid-2026) — WebRTC standardizes the media transport (ICE, DTLS-SRTP, codec negotiation), not the application-level event semantics sitting on top of it, and that gap is exactly where OpenAI's schema is filling the vacuum by adoption.

**Practical implication for anyone building a multi-provider voice agent today**: treat the OpenAI Realtime event schema as the integration target even when OpenAI isn't your primary or cheapest provider, because it is increasingly the schema other vendors ship natively, which shrinks your adapter surface to just the providers (chiefly Gemini, and to a lesser extent Nova Sonic and Azure Voice Live) that have made deliberate architectural choices — native multimodality, thinking budgets, avatar streaming — that don't map cleanly onto anyone else's event model.

## Sources

- [Introducing gpt-realtime and Realtime API updates for production voice agents (OpenAI)](https://openai.com/index/introducing-gpt-realtime/)
- [Realtime conversations guide (OpenAI API docs)](https://developers.openai.com/api/docs/guides/realtime-conversations)
- [GPT-Realtime Model reference (OpenAI API docs)](https://developers.openai.com/api/docs/models/gpt-realtime)
- [Pricing (OpenAI API docs)](https://developers.openai.com/api/docs/pricing)
- [Managing costs (OpenAI platform docs)](https://platform.openai.com/docs/guides/realtime-costs)
- [OpenAI Realtime API Pricing in 2026: Real-World Data From 4,000 Measured Sessions (HackerNoon)](https://hackernoon.com/openai-realtime-api-pricing-in-2026-real-world-data-from-4000-measured-sessions)
- [Live API capabilities guide (Gemini API docs)](https://ai.google.dev/gemini-api/docs/live-api/capabilities)
- [Session management with Live API (Gemini API docs)](https://ai.google.dev/gemini-api/docs/live-api/session-management)
- [Best practices with Gemini Live API (Gemini API docs)](https://ai.google.dev/gemini-api/docs/live-api/best-practices)
- [Configure language and voice (Gemini Enterprise Agent Platform docs)](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/configure-language-voice)
- [Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Bug Report: Gemini Live API Native Audio Premature turnComplete Causes Mid-Sentence Audio Truncation (googleapis/python-genai #2117)](https://github.com/googleapis/python-genai/issues/2117)
- [Gemini Live API responses cut off prematurely with turnComplete despite incomplete content (googleapis/js-genai #707)](https://github.com/googleapis/js-genai/issues/707)
- [Thinking output on gemini-live-2.5-flash-preview model (googleapis/python-genai #1491)](https://github.com/googleapis/python-genai/issues/1491)
- [Using the Amazon Nova Sonic Speech-to-Speech model (AWS docs)](https://docs.aws.amazon.com/nova/latest/userguide/speech.html)
- [Real-time voice agents with Stream Vision Agents and Amazon Nova 2 Sonic (AWS ML blog)](https://aws.amazon.com/blogs/machine-learning/real-time-voice-agents-with-stream-vision-agents-and-amazon-nova-2-sonic/)
- [Voice Live API Overview (Microsoft Learn)](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live)
- [Configuring Noise Detection and Barge-In with Azure Voice Live API (Microsoft Community Hub)](https://techcommunity.microsoft.com/blog/healthcareandlifesciencesblog/configuring-noise-detection-and-barge%E2%80%91in-with-azure-voice-live-api/4506916)
- [OpenAI Realtime API Alternatives: Best APIs for Speech (Inworld)](https://inworld.ai/resources/openai-realtime-api-alternatives)
- [Voice Agents API (Inworld)](https://inworld.ai/voice-agents)
- [Grok Voice Agent API (xAI)](https://x.ai/news/grok-voice-agent-api)
- [Voice Agent API reference (xAI docs)](https://docs.x.ai/developers/model-capabilities/audio/voice-agent)
- [xAI Voice Agent (Realtime API) — liteLLM docs](https://docs.litellm.ai/docs/providers/xai_realtime)
- [RealTime AI Agents frameworks comparison: LiveKit, Pipecat and TEN (Medium)](https://medium.com/@ggarciabernardo/realtime-ai-agents-frameworks-bb466ccb2a09)
- [RoomKit, Pipecat, TEN Framework, LiveKit Agents: Choosing the Right Conversational AI Framework (RoomKit blog)](https://www.roomkit.live/blog/choosing-the-right-conversational-ai-framework/)
- [GitHub: livekit/agents](https://github.com/livekit/agents)
- [Gemini Live API plugin (LiveKit docs)](https://docs.livekit.io/agents/models/realtime/plugins/gemini/)
- [Amazon Nova Sonic integration guide (LiveKit docs)](https://docs.livekit.io/agents/models/realtime/plugins/nova-sonic/)
- [Speech to Speech Models and Providers Analysis (Artificial Analysis)](https://artificialanalysis.ai/speech-to-speech)
- [Gemini 3.1 Flash Live vs GPT Realtime 1.5: Which Voice AI Agent Should You Build With in 2026? (Flowtivity)](https://flowtivity.ai/blog/gemini-3-1-flash-live-vs-gpt-realtime-1-5-voice-agent-comparison-2026/)
- [Real-Time vs Turn-Based Voice Agents in 2026: Architecture, Latency, Cost Compared (Softcery)](https://softcery.com/lab/ai-voice-agents-real-time-vs-turn-based-tts-stt-architecture)
- [A Developer's Guide to Voice AI Evaluation Metrics (2026) (Cekura)](https://www.cekura.ai/blogs/voice-ai-evaluation-metrics)
- [Voice Agent Evaluation Metrics: Definitions, Formulas & Benchmarks (Hamming AI)](https://hamming.ai/resources/voice-agent-evaluation-metrics-guide)
- [48 kHz in, 16 kHz out: why resampling matters (Voice Type blog)](https://carelesswhisper.app/blog/resampling-48-to-16-khz)
- [Add Telephony to a Gemini Live Agent with Twilio (DEV Community)](https://dev.to/googleai/add-telephony-to-a-gemini-live-agent-with-twilio-1elc)
