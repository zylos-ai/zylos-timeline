---
date: "2026-01-10"
title: "Edge AI & On-Device LLMs 2026"
description: "Research notes on Edge AI & On-Device LLMs 2026"
tags:
  - research
---


*Research Date: 2026-01-10*

## Executive Summary

42%+ developers now run LLMs locally for privacy, cost, and latency benefits. NPUs hitting 80+ TOPS standard in flagships. Industry converging on hybrid local+cloud architecture.

## Key Frameworks

| Framework | Best For | Strength |
|-----------|----------|----------|
| **llama.cpp** | Max performance | 65K stars, NVIDIA 35% speed boost |
| **MLX** | Apple Silicon | Unified memory, 12x vs CPU |
| **MLC LLM** | Cross-platform | OpenAI-compatible API |
| **TensorRT Edge-LLM** | Automotive/Robotics | Real-time on Jetson |
| **ExecuTorch** | Mobile | Powers Meta apps |

## Popular On-Device Models

| Model | Size | Best Use |
|-------|------|----------|
| **Qwen3-0.6B** | 0.6B | Mobile, 40 tok/s |
| **Llama 3.2** | 1B/3B | iOS/Android |
| **Phi-4** | 14B | Reasoning |
| **Gemma 3n** | - | Everyday devices |
| **Ministral-3** | 3.4B | Edge, ~8GB VRAM |

## Hardware Requirements

| Model Size | Min VRAM | Quantization |
|------------|----------|--------------|
| 7B | 8GB | 4-bit |
| 13B | 16GB | 4-8 bit |
| 70B | 40GB+ | 4-bit |

**New 2026**: NVIDIA NVFP4 (60% memory save, 3x speed), NVFP8 (40% save, 2x speed)

## Performance Benchmarks

| Platform | Model | Speed |
|----------|-------|-------|
| iPhone 15 Pro | Qwen3-0.6B | ~40 tok/s |
| RTX 4060 Ti | 7B 4-bit | 20-40 tok/s |
| Apple M-series | Various | 40-80 tok/s |
| Raspberry Pi 5 | 1B | 5-15 tok/s |

**TTFT**: Cactus achieves sub-50ms

## Mobile Chips 2026

| Chip | NPU | Improvement |
|------|-----|-------------|
| Snapdragon 8 Gen 5 | 80 TOPS | +46% AI |
| Dimensity 9500 | NPU 990 | 2x perf, -56% power |
| Snapdragon X2 Plus | 80 TOPS | PC/laptop |

## Key Players

### Apple Intelligence
- Siri 3.0 delayed to Fall 2026
- $1B/year Google Gemini deal
- Architecture: On-device → Private Cloud → Gemini

### Google
- Gemma 3n for everyday devices
- Coral NPU for wearables
- LiteRT with MediaTek: 12x vs CPU

### NVIDIA
- TensorRT Edge-LLM for automotive
- JetPack 7.1 for Jetson T4000
- 35% faster llama.cpp, 3x ComfyUI

## Use Cases

1. **Privacy**: Healthcare, finance, biometrics
2. **Offline**: Remote monitoring, translation
3. **Automotive**: In-car AI (Bosch, ThunderSoft)
4. **Coding**: Local copilots (Pieces, Private LLM)
5. **Cost**: 4.3x cheaper than cloud at scale

## Recommendations

**Framework Choice**:
- Apple → MLX
- Cross-platform → MLC LLM
- NVIDIA → llama.cpp
- Mobile → ExecuTorch or Cactus

**Model Choice**:
- Mobile: 1-3B (Qwen3-0.6B, Llama 3.2 1B)
- Desktop 8GB: 7B 4-bit
- Desktop 16GB+: 13B or 70B quantized

## Key Insight

NPU ubiquity (80+ TOPS) + automated quantization tools (HAQA) = on-device AI becoming default for privacy-sensitive applications. Industry converging on Apple's hybrid model: local for common queries, cloud for complex reasoning.

---

*New topic - not previously covered in KB*
