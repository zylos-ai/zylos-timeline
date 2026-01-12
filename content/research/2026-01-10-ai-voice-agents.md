---
date: "2026-01-10"
title: "AI Voice Agents & Speech-to-Speech Technology 2026"
description: "Research notes on AI Voice Agents & Speech-to-Speech Technology 2026"
tags:
  - research
---


*Research Date: 2026-01-10*

## Executive Summary

AI voice agents have matured significantly, with production-ready platforms handling millions of concurrent calls. Key advances include sub-second latency, 70%+ call containment rates, and robust compliance frameworks for healthcare/finance.

## Key Players & Pricing

| Platform | Price | Key Strength |
|----------|-------|--------------|
| Deepgram | $4.50/hr | #1 VAQI score (71.5), BYOM support |
| ElevenLabs | ~$6/hr | 80% function calling accuracy |
| OpenAI Realtime | ~$18/hr | Integrated S2S, <800ms target |
| Retell AI | $0.07/min | HIPAA/SOC2/GDPR, 3-min deploy |
| Vapi | $0.05+/min | API-first, 1M+ concurrent calls |

## Technical Approaches

### Speech-to-Speech (S2S)
- OpenAI's integrated approach
- Eliminates text bottleneck
- Target: sub-800ms latency
- Less flexible, harder to debug

### STT-LLM-TTS Pipeline
- Used by Deepgram, ElevenLabs, Vapi, Retell
- Six-step latency chain: 450-2700ms total
  - Audio capture: 10-50ms
  - Network upload: 20-100ms
  - Speech recognition: 100-500ms
  - LLM processing: 200-2000ms (40-60% of total!)
  - Speech synthesis: 100-400ms
  - Network download: 20-100ms

## Latency Benchmarks

**The 300ms Rule**: Sub-300ms needed for natural conversation.

**STT Performance:**
- NVIDIA Nemotron ASR: <25ms (streaming)
- Deepgram Nova-3: <300ms, 18% WER
- Whisper: 600-800ms (not real-time suitable)

**TTS Performance:**
- Murf Falcon: 55ms model latency
- Speechmatics: ~150ms TTFAB
- Chatterbox: <200ms

## Production Use Cases

### Healthcare (50% of US hospitals plan adoption by 2026)
- Tampa General: 70% front-desk call offload, 90%+ satisfaction
- 12-physician practice: eliminated 2 FTE, saved $87k/year
- Use: scheduling, reminders, insurance verification

### Customer Service
- 35% call center workload reduction
- PolyAI: 80-87% containment rates
- $7.7M annual savings achievable

### Market Size
- $30B global market projected for 2026
- 157M voice assistant users in US

## Open Source Options

**Speech Models:**
- NVIDIA Nemotron Speech ASR: 600M params, <25ms
- Chatterbox: Sub-200ms, voice cloning
- XTTS-v2 (Coqui): 17 languages, 6-second voice cloning
- Kokoro, OpenVoice, Bark, Mozilla TTS

**Frameworks:**
- Pipecat: Multi-provider voice AI framework
- TEN Framework: Full-duplex dialogue, VAD
- LiveKit: Powers ChatGPT voice mode

## Key Challenges

1. **Latency**: LLM is 40-60% of total time
2. **Turn-taking**: VAD quality varies; OpenAI slow, ElevenLabs interrupts
3. **Emotional intelligence**: Prosody + NLP + paralinguistics
4. **Compliance**: HIPAA/SOC2/GDPR requirements
5. **Cost**: Pass-through LLM costs can 3-6x total price

## Integration Patterns

1. **All-in-One**: Deepgram/Retell API (fastest)
2. **Modular**: Plivo + Deepgram + Claude + ElevenLabs (flexible)
3. **Framework**: Pipecat, TEN, LiveKit (balanced)
4. **Telephony**: WebRTC (browser), SIP (PSTN)

## Recommendations by Use Case

| Need | Recommendation |
|------|----------------|
| Fast deployment | Retell (3 min) |
| Best performance | Deepgram (#1 VAQI) |
| Cost-sensitive | Deepgram or open-source |
| Compliance-critical | Retell (built-in) |
| Maximum control | Pipecat + NVIDIA models |
| High customization | Vapi |

## Key Insight

The LLM processing step is the dominant latency factor (40-60% of response time). Using smaller, faster models like GPT-4o-mini or Claude 3.5 Haiku is essential for real-time voice applications. The 300ms threshold for natural conversation means every millisecond counts across the pipeline.

---

*New topic - not previously covered in KB*
