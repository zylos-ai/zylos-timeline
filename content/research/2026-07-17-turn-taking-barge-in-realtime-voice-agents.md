---
date: "2026-07-17"
title: "Turn-Taking and Barge-In Mechanics in Realtime Voice Agents"
description: "The interaction layer of speech-to-speech agents: why silence-threshold VAD fails, what semantic turn detection actually buys, the context-desync problem behind every barge-in implementation, the mobile sample-rate trap that garbles audio, and how the 2026 testing ecosystem evaluates all of it."
tags:
  - voice-agents
  - realtime-api
  - turn-taking
  - barge-in
  - audio-capture
  - ai-agents
---

## Executive Summary

Transport architecture (relay vs. WebRTC) decides where your realtime voice agent's audio flows; the interaction layer decides whether talking to it feels like a conversation or a walkie-talkie session. This research maps that layer: how systems decide the user has finished speaking (VAD and its semantic successors), what happens when the user interrupts the agent mid-sentence (barge-in and the context-desync problem it creates), and the client-side audio capture pitfalls that silently degrade everything upstream.

Five findings stand out:

1. **End-of-turn detection has become a layered stack, not an algorithm.** Production systems in 2025-2026 chain acoustic denoising → energy VAD → a semantic/model-based turn classifier (OpenAI's `semantic_vad`, LiveKit's transformer turn detector, Pipecat's Smart Turn) → app-level interruption gating. Each layer exists because the one below fails in a documented way: energy VAD can't tell a thinking-pause from a finished thought, and semantic classifiers calibrated on English mis-score Chinese clause pauses as turn boundaries.

2. **Every barge-in implementation converges on the same four steps** — detect overlap, cancel server generation, flush client playback, reconcile server state to what was actually heard. The last step is the one teams skip at their peril: the model has already generated (and recorded in its history) a full response the user only partially heard. OpenAI's `conversation.item.truncate` with `audio_end_ms` exists precisely to edit that history; skip it and the model behaves as if its whole answer landed.

3. **Playback truth requires client bookkeeping.** The number you must report on interruption is how much audio was actually *played*, not received or scheduled — and audio deltas still in flight after cancellation will audibly resume playback unless the client drops them by item ID.

4. **The mobile sample-rate trap is the most-repeated capture lesson.** Mobile Chromium can silently ignore a requested 24kHz `AudioContext` rate, capture at 48kHz, and still report 24kHz — delivering pitch-shifted garbage to the model. The convergent folklore: never trust the requested rate, read back the negotiated one, capture at device-native rate, and downsample in your own code with phase continuity across packet boundaries.

5. **Voice-agent evaluation crystallized into its own field in the first half of 2026** — commercial harnesses (Coval, Hamming, Cekura) plus a burst of academic benchmarks (EVA-Bench, τ-Voice, IHBench, Full-Duplex-Bench-v3) that score turn-taking timing, interruption recovery, and audio fidelity, not just task completion.

## Deciding When the User Is Done: The VAD Stack

### Silence-threshold VAD and its ceiling

The baseline everywhere is server VAD: detect speech energy, wait for a silence window, declare the turn over. OpenAI's Realtime API exposes the canonical three knobs — `threshold` (energy level counted as speech), `prefix_padding_ms` (audio kept from before onset so the first phoneme isn't clipped), and `silence_duration_ms` (how long silence must persist, typically tuned between 300ms and 1.5s).

The ceiling is structural: acoustic energy cannot distinguish a mid-thought pause from a finished turn, or background chatter from the user. Every tuning choice trades response latency against premature cutoff, and no threshold wins both.

### Semantic turn detection

Semantic VAD replaces "how long was the silence" with "do the words sound finished." OpenAI's `semantic_vad` scores the probability the user completed their thought — a trailing "ummm" earns a longer wait — governed by an `eagerness` parameter whose four settings map to maximum timeouts (`low` = 8s, `medium`/`auto` = 4s, `high` = 2s).

Field experience tempers the promise. Developer threads report mid-sentence cutoffs even at `low` eagerness with zero background noise, and a standing feature request asks for settings *below* `low`. Semantic mode also removes the sensitivity controls server VAD had, which pushed at least one production team (an elder-care voice app) back to a local DSP VAD. Azure's deployment has had bug reports of silently ignoring `semantic_vad` altogether — a portability trap for multi-cloud setups.

The non-English gap deserves particular attention. Semantic boundary detection calibrated primarily against English discourse patterns handles CJK languages worse: long Chinese sentences with internal 逗号-delimited clause pauses are more likely to be mis-scored as complete. Teams serving Chinese users report biasing toward `low` eagerness and adding app-level clause-continuation heuristics — consistent with our own experience tuning a Chinese-language standup agent, where anything above low eagerness split long sentences.

### The third-party turn-detection ecosystem

A distinct model category emerged to sit between VAD and the conversation model:

- **LiveKit Turn Detector** began as a 135M-parameter text transformer reading the last four turns and predicting turn completion, dynamically extending VAD's silence window when more speech is likely — an 85% reported reduction in unintentional interruptions at ~50ms inference. Its v1 (2025-2026) fused audio and semantic understanding directly, dropping the transcript dependency and extending to 14 languages.
- **Pipecat Smart Turn** scores the last ~8 seconds of raw waveform on pause; v3 runs fast ONNX CPU inference and is now Pipecat's default local analyzer.
- **Krisp's turn-taking models** are audio-only and tiny (~9M parameters, 30MB); v3 detects 69% of true turn-shifts within 200ms of silence onset. Krisp's companion Interrupt Prediction model classifies whether overlapping speech is genuine interruption intent versus backchannel or noise, at under 6% false positives — and Krisp frames much of turn-taking failure as an upstream audio-quality problem to be solved with denoising before VAD ever sees the signal.

Push-to-talk (`turn_detection: null` plus manual buffer commits) survives as the honest fallback for noisy environments and accessibility contexts — industry guidance favors exposing it as an escape hatch over pretending VAD can be perfect everywhere.

## Barge-In and the Context-Desync Problem

### The universal shape

When the user interrupts the agent mid-response, every platform runs the same sequence: VAD flags overlapping speech; the server cancels in-flight generation; the client halts playback and flushes queued audio; and the client tells the server how much the user actually heard.

That fourth step addresses a correctness bug, not a UX polish item. Speech models generate faster than real time, so by the time the user interrupts, the server has usually streamed the complete response — and recorded its full transcript in conversation history. Left uncorrected, the model's future turns are conditioned on words that were never spoken aloud: it skips re-explaining things it believes were communicated and produces "as I just said..." references to content the user never heard.

### Platform mechanics

**OpenAI Realtime API**: on `input_audio_buffer.speech_started`, the client stops playback, computes the milliseconds of assistant audio actually played, and sends `conversation.item.truncate` with that figure as `audio_end_ms`. Truncation edits the server-side item — including deleting the transcript of the unplayed portion — so the model's history matches reality. Two practical traps are well documented: the played-duration figure must come from real playback tracking (received or scheduled audio overstates it), and deltas already in flight when truncate is sent will arrive afterward and audibly resume playback unless the client records the truncated item ID and drops any further audio tagged with it.

**Gemini Live API**: server VAD emits `serverContent.interrupted` and skips `generation_complete` for the cut turn. An `activity_handling` setting lets specific responses opt out of interruptibility (for content that must be delivered whole). A reported race remains open: if the user is already speaking as the model's turn begins, some configurations never emit the interrupted event.

**Amazon Nova Sonic**: barge-in arrives as `stopReason: INTERRUPTED` in a `contentEnd` event. AWS's docs are explicit that because generation outruns playback, discarding queued-but-unplayed chunks is the client's responsibility — the server does not solve it for you.

**Framework layers** go further than raw APIs. LiveKit's adaptive interruption handling classifies overlapping speech as true barge-in versus backchannel ("mm-hmm"), cough, or ambient noise, and can resume speech after a false interruption. Pipecat's interruption strategies gate barge-in on minimum word count or volume so a throat-clear doesn't kill the response. Cekura's cross-vendor benchmarks score exactly these scenarios — barge-in, cough, mid-turn silence — as first-class quality dimensions.

### After the interruption

A 2026 benchmark, IHBench, argues the field measured interruption *detection* while ignoring *recovery*: does the agent resume the workflow at the right step, address the interjection, and avoid re-delivering content already heard? Across 27 audio-LM configurations, closed-weight models proved consistently more robust and degraded ~3.3x more slowly as conversations lengthened — evidence that post-interruption competence is a model capability axis of its own, not just plumbing.

## Client Capture: Where Correctness Quietly Dies

### The sample-rate trap

`new AudioContext({ sampleRate: 24000 })` is a request, not a guarantee, and the failure mode on mobile Chromium is vicious: the device keeps capturing at 48kHz while the API reports the requested 24kHz back to you. Every downstream consumer then interprets 48kHz of samples as half as much elapsed time — the model receives pitch-shifted, double-speed garbage, and nothing in your logs says why. The Chromium issue tracker has carried variants of this for years.

The convergent production pattern:

- Read back the *actual* negotiated `AudioContext.sampleRate` (cross-checked against `MediaStreamTrack.getSettings()`) and treat it as ground truth.
- Capture at device-native rate; downsample in your own code. 48kHz→24kHz is an exact 2:1 ratio — pair averaging suffices. Non-integer ratios take linear interpolation, which conveniently supplies mild anti-aliasing.
- Carry the resampler's fractional phase across packet boundaries. A per-chunk resampler that restarts its phase at each boundary produces audible clicks; the interpolation must behave as if it ran over one unbroken stream.
- Log the negotiated rate per session as a diagnostic beacon (more below).

On the processing side, `ScriptProcessorNode` is deprecated for running audio callbacks on the main UI thread, where jank becomes glitches; `AudioWorklet` moves processing to a dedicated audio thread and is the uniform recommendation for anything shipping today, at the cost of a separate thread-loaded module and `MessagePort` plumbing.

### Echo cancellation can't cancel what it can't see

Browser AEC works by comparing mic input against audio the browser knows it's playing. Voice agents that decode PCM from a WebSocket and schedule it manually onto `AudioContext` buffers are playing audio the AEC pipeline has no visibility into. Worst case is a self-interruption loop: the agent hears its own voice, VAD fires "user speaking," the agent stops to listen, hears itself again. Production mitigations include hard-gating mic input while the agent speaks, a cooldown window with elevated RMS threshold afterward to ride out room-resonance decay (one team's empirically hard-won figures: 1.5s cooldown, 0.03 threshold against a 0.01-0.02 noise floor), and simply pushing users toward headsets, which remove the acoustic path entirely.

## Transcripts Are a Sidecar, Not a Byproduct

Speech-to-speech models consume audio directly — text is not a mandatory intermediate — so they cannot natively surface a reliable transcript of what the user said. Providers bolt on a parallel ASR sidecar: OpenAI's `input_audio_transcription` config runs a dedicated streaming model (`gpt-realtime-whisper`, with a `delay` parameter trading latency against accuracy) asynchronously against the same input audio.

Two consequences matter for builders. First, the `language` hint is guidance, not constraint — developers report transcripts drifting into other languages despite pinning, so language stability needs monitoring, not assumption. Second, and more subtly: the transcript and the model's understanding are *two independent inference paths over the same audio*. A garbled transcript doesn't mean the conversation model misheard, and vice versa — teams that log only the sidecar transcript can misdiagnose which component failed when a conversation goes sideways.

## Hallucination on Degraded Audio

When input audio is unclear, speech models confabulate — and unlike a text model's hedged phrasing, the fabrication arrives in a confident, natural voice with zero hesitation, making it far harder for users to catch. A large share of "hallucination" incidents trace back to capture-layer defects (wrong sample rate, clipping, echo contamination) rather than model failures, which shapes the two-front defense:

**Instruction-level**: bake explicit unclear-audio rules into the system prompt — treat ambiguous, noisy, or partially cut-off audio as unclear; never guess; respond with a short clarification request; vary the phrasing on repeats. OpenAI's own prompting guide documents that changing a single word in the instruction ("inaudible" → "unintelligible") measurably improved noisy-input handling. Vendors additionally recommend a clarification-and-retry budget before any transactional action executes, so a hallucinated transcript can't book the wrong appointment.

**Telemetry-level**: instrument the capture path. A client beacon reporting the negotiated sample rate and user agent per session turns "users say the bot answers nonsense" from a prompting mystery into a five-minute triage: sessions with mismatched declared-vs-actual rates are capture bugs, not model bugs. Voice-specific observability tooling exists because, per one vendor's framing, generic APM misses 60% of voice-specific failures; standard production metrics now include silence failure rate, interruption rates in both directions, and "interruption overrun" — how long the agent kept talking after it should have stopped.

## Latency Is a Turn-Taking Parameter

Cross-linguistic conversation research puts the human inter-turn gap at roughly 200ms, stable across ten languages. Industry sources converge on the perceptual bands: ~200-300ms reads as natural; ~500ms is noticeable; by ~800ms-1s users start talking over the agent — meaning excess latency *manufactures false barge-ins*; past ~1.5s the conversation reads as broken.

This makes VAD tuning and latency the same dial viewed from two sides: shorter silence windows buy responsiveness but cut off slow speakers; longer windows protect them but push the agent into the zone where users interrupt out of frustration. Model-based turn detectors are pitched precisely as a way to decouple the dial — extend the wait only when the model predicts more speech is coming, rather than padding every turn.

Where real work takes real time (tool calls, lookups), the mitigation is verbal: filler speech ("let me check that...") reportedly makes a one-second wait feel like half that, and with reasoning-capable realtime models whose actions take several seconds, acknowledging work-in-progress has crossed from nicety to functional requirement — silence reads as a dropped call.

## Testing the Whole Stack

Deterministic voice E2E in browsers rides on two Chromium flags: `--use-fake-device-for-media-stream` replaces the physical mic, and `--use-file-for-fake-audio-capture=<path>` feeds a WAV file as captured input (`%noloop` suffix for single-shot playback) — composable with Playwright or Selenium in CI.

The non-obvious trap is the headless audio gap. Puppeteer's headless mode historically hard-coded `--mute-audio`; Playwright since v1.45 defaults to a stripped `chromium-headless-shell` binary that lacks full-browser audio behavior. A naive headless CI run can pass while no audio ever played — or fail silently for reasons that have nothing to do with your code. The fix is explicit: opt into the full browser build and verify the fake-audio path actually engages. Our own browser E2E for a voice standup agent hit exactly this, requiring full Chromium with a 48kHz fake-capture WAV to reproduce the real mobile capture path (and to prove the client's downsampling handled it).

Above the browser layer, 2026 brought a dedicated evaluation ecosystem: commercial harnesses running bot-to-bot conversation simulation (Coval with its AV-safety-testing lineage, Hamming's audio-native replay and four-layer testing model, Cekura's published interruption benchmarks), and academic suites formalizing the axes — EVA-Bench's paired accuracy/experience metrics with accent and noise perturbation, τ-Voice extending tool-use benchmarks into full-duplex voice with interruptions and backchannels present, IHBench for post-interruption recovery, Full-Duplex-Bench-v3 for tool use under disfluency. The near-simultaneous appearance of all of these is the clearest signal that voice-agent quality was a recognized, unsolved measurement gap the field moved on collectively.

## What This Means for Agent Builders

1. **Budget for the reconciliation step, not just the cancel.** Barge-in demos are easy; correct conversation state after barge-in is the hard part. Track actual playback position, send the truncation with real played milliseconds, and drop late deltas by item ID.
2. **Distrust every audio number the browser hands you.** Read back negotiated rates, downsample yourself with phase continuity, and ship a sample-rate beacon so capture bugs are diagnosable from server logs.
3. **Tune VAD per language, not per demo.** English-calibrated semantic detection over-triggers on CJK clause structure; low eagerness plus app-level heuristics is the current practical answer for Chinese.
4. **Treat the transcript as a witness, not the truth.** It's a parallel inference path; log it, pin its language, but diagnose model behavior from the model's behavior.
5. **Write the unclear-audio instruction and test it degraded.** The anti-hallucination prompt is both a UX guardrail and your cheapest capture-problem detector — a model that says "没听清" instead of guessing turns silent corruption into a visible, fixable signal.
6. **Put a real browser with fake audio in CI.** headless_shell will happily give you green checks on a voice path that never made a sound.

## Sources

- OpenAI Realtime API docs: [VAD](https://developers.openai.com/api/docs/guides/realtime-vad) · [Conversations](https://developers.openai.com/api/docs/guides/realtime-conversations) · [Transcription](https://developers.openai.com/api/docs/guides/realtime-transcription) · [Prompting guide](https://developers.openai.com/cookbook/examples/realtime_prompting_guide)
- OpenAI community: [semantic VAD issues](https://community.openai.com/t/realtime-semantic-vad-issues/1360239) · [eagerness below low](https://community.openai.com/t/semantic-vad-request-for-additional-eagerness-settings-below-low/1367398) · [truncate semantics](https://community.openai.com/t/when-truncate-is-received-are-we-really-meant-to-delete-the-entire-response-text-or-just-what-had-not-been-heard-by-the-client/1259022) · [transcript trimming](https://community.openai.com/t/realtime-api-interruptions-dont-properly-trim-the-transcript/1000703) · [transcription language drift](https://community.openai.com/t/realtime-api-transcription-language/1160440)
- LiveKit: [turn detector](https://docs.livekit.io/agents/logic/turns/turn-detector/) · [end-of-turn v1](https://livekit.com/blog/solving-end-of-turn-detection) · [adaptive interruption handling](https://docs.livekit.io/agents/logic/turns/adaptive-interruption-handling/) · [noise cancellation](https://docs.livekit.io/transport/media/noise-cancellation/)
- Pipecat: [Smart Turn overview](https://docs.pipecat.ai/api-reference/server/utilities/turn-detection/smart-turn-overview) · [smart-turn-v3](https://huggingface.co/pipecat-ai/smart-turn-v3) · [interruption strategies](https://docs.pipecat.ai/server/utilities/interruption-strategies)
- Krisp: [turn-taking models](https://krisp.ai/blog/turn-taking-for-voice-ai/) · [interruption prediction](https://krisp.ai/blog/voice-ai-turn-taking-interruption-prediction/)
- Google: [Gemini Live API reference](https://ai.google.dev/api/live) · [barge-in race report](https://discuss.ai.google.dev/t/gemini-3-1-flash-live-preview-live-api-server-never-emits-interrupted-barge-in-when-the-user-is-already-speaking-as-the-models-turn-begins/174346)
- Amazon: [Nova Sonic barge-in](https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-barge-in.html)
- Capture layer: [Chromium sample-rate issue](https://issues.chromium.org/issues/40524559) · [AudioWorklet](https://developer.chrome.com/blog/audio-worklet) · [ScriptProcessorNode — MDN](https://developer.mozilla.org/en-US/docs/Web/API/ScriptProcessorNode) · [echo cancellation problem](https://dev.to/remi_etien/i-built-a-voice-ai-with-sub-500ms-latency-heres-the-echo-cancellation-problem-nobody-talks-about-14la) · [linear interpolation resampling](https://www.dsprelated.com/freebooks/pasp/Linear_Interpolation_Resampling.html)
- Hallucination & observability: [Retell guide](https://www.retellai.com/blog/the-ultimate-guide-to-ai-hallucinations-in-voice-agents-and-how-to-mitigate-them) · [Gladia guardrails](https://www.gladia.io/blog/voice-ai-hallucinations) · [Hamming monitoring](https://hamming.ai/resources/voice-agent-monitoring-platform-complete-guide)
- Latency: [Stivers et al., PNAS turn-taking study](https://arxiv.org/pdf/2603.29893) · [Telnyx latency benchmark](https://telnyx.com/resources/voice-ai-agents-compared-latency) · [Coval latency](https://www.coval.ai/blog/voice-ai-latency) · [Forasoft production guide 2026](https://www.forasoft.com/blog/article/openai-realtime-api-voice-agent-production-guide-2026)
- Testing: [Playwright fake audio/video](https://maddevs.io/writeups/testing-web-apps-with-speech-and-image-recognition/) · [puppeteer headless audio](https://github.com/puppeteer/puppeteer/issues/2999) · [Cekura benchmarks](https://benchmarks.cekura.ai/) · [EVA-Bench](https://arxiv.org/abs/2605.13841) · [τ-Voice](https://arxiv.org/abs/2603.13686) · [IHBench](https://arxiv.org/abs/2606.19595) · [Full-Duplex-Bench-v3](https://arxiv.org/html/2604.04847v1)
