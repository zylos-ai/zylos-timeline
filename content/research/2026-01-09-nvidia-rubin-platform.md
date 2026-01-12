---
date: "2026-01-09"
title: "NVIDIA Rubin AI Platform - CES 2026"
description: "Research notes on NVIDIA Rubin AI Platform - CES 2026"
tags:
  - research
---


## Executive Summary

NVIDIA unveiled Rubin at CES 2026 - the first "extreme codesigned" six-chip AI platform. Named after astronomer Vera Rubin (dark matter theory), it's already in full production (Q1 2026) with H2 2026 partner availability.

**Key Claims:**
- 10x reduction in inference token cost
- 5x inference performance vs Blackwell
- 4x fewer GPUs to train MoE models

---

## Six-Chip Architecture

| Chip | Purpose | Key Spec |
|------|---------|----------|
| **Rubin GPU (R200)** | AI compute | 50 PFLOPS FP4, 288GB HBM4 |
| **Vera CPU** | 88 Olympus cores | 2x Grace performance |
| **NVLink 6** | GPU interconnect | 3.6 TB/s per GPU |
| **ConnectX-9 SuperNIC** | Networking | 800 Gb/s |
| **BlueField-4 DPU** | Data processing | 64-core Grace CPU |
| **Spectrum-6** | Ethernet switch | Co-packaged optics |

---

## Rubin GPU (R200) Specs

- **Process:** TSMC 3nm
- **Architecture:** Dual-die (two reticle-sized compute tiles)
- **Memory:** 288 GB HBM4 (8 stacks)
- **Memory Bandwidth:** 22 TB/s (2.75x Blackwell)
- **FP4 Inference:** 50 PFLOPS (5x Blackwell)
- **FP4 Training:** 35 PFLOPS (3.5x Blackwell)
- **GPU-to-GPU:** 3.6 TB/s via NVLink 6
- **Power:** ~1.8 kW

---

## Rubin vs Blackwell

| Metric | Rubin R200 | Blackwell B200 | Improvement |
|--------|------------|----------------|-------------|
| FP4 Inference | 50 PFLOPS | 10 PFLOPS | **5x** |
| FP4 Training | 35 PFLOPS | 10 PFLOPS | **3.5x** |
| Memory | 288 GB HBM4 | 192 GB HBM3E | 1.5x |
| Memory BW | 22 TB/s | 8 TB/s | **2.75x** |
| GPU BW | 3.6 TB/s | 1.8 TB/s | 2x |

---

## Why 10x Lower Token Cost?

The claim specifically applies to **Mixture-of-Experts (MoE)** models (GPT-4, Claude, Gemini use this):

1. **NVLink 6 Bandwidth** - 3.6 TB/s per GPU enables efficient expert consultation
2. **HBM4** - 22 TB/s memory bandwidth feeds GPUs better
3. **5x Raw Performance** - More tokens/second per GPU
4. **Extreme Codesign** - 6 chips designed as unified system, not loosely coupled

**Economic formula:** Fewer GPUs (4x) + Higher throughput (5x) + Better utilization = ~10x cost reduction

---

## Product Variants & Timeline

| Product | Availability | Key Feature |
|---------|--------------|-------------|
| **Rubin (R200)** | H2 2026 | Standard flagship |
| **Rubin CPX** | Late 2026 | 128GB GDDR7, 1M+ token context |
| **Rubin Ultra** | H2 2027 | 4-die, 100 PFLOPS, 1TB HBM4e |

### Rubin CPX - The Context King
- **Purpose:** Million-token context inference (coding agents, full codebase analysis)
- **Memory:** 128 GB GDDR7 (1/5th cost of HBM4)
- **NVL144 CPX System:** 100 TB fast memory, $5B token revenue per $100M invested

---

## Rack-Scale: Vera Rubin NVL72

- 72 Rubin GPUs + 36 Vera CPUs + 18 BlueField-4 DPUs
- **Performance:** 3.6 exaflops FP4 inference
- **Memory:** 54 TB LPDDR5X + 20.7 TB HBM4
- **Total Bandwidth:** 1.6 PB/s HBM4, 260 TB/s NVLink
- **Assembly:** 18x faster than Blackwell (modular, cable-free)

---

## New Technologies

### NVLink 6
- 3.6 TB/s per GPU (2x NVLink 5)
- 260 TB/s rack aggregate ("more than entire internet")
- 400G SerDes technology
- 14.4 TFLOPS FP8 in-network compute

### HBM4 (First Major Adoption)
- Interface width doubled vs HBM3E
- 22 TB/s bandwidth achieved
- Samples from SK Hynix, Samsung, Micron

### Co-Packaged Optics (Spectrum-6)
- Optical components packaged with switch chip
- 5x power efficiency
- 10x reliability vs traditional switches
- First time for NVIDIA

---

## Early Deployment Partners

**Cloud:** AWS, Google Cloud, Azure, OCI, CoreWeave, Lambda

**AI Labs:** OpenAI, Anthropic, Meta, xAI, Mistral, Cohere, Perplexity, Cursor, Runway

---

## Key Implications

1. **MoE models become economical** - 10x cost reduction makes scaled inference viable
2. **Million-token context** - Rubin CPX enables true coding agents analyzing entire repos
3. **Liquid cooling mandatory** - All components 100% liquid cooled
4. **Data center as compute unit** - Not single servers, entire racks designed together
5. **GDDR7 path** - Cost-effective alternative for specific workloads

---

## For Our Work

The shift to MoE and million-token context directly impacts AI agent capabilities:
- Longer context = better reasoning traces
- Lower cost = more economical agentic workflows
- Rubin CPX specifically targets "coding agents" use case

---

*Research completed: 2026-01-09*
*Source: CES 2026 announcements, NVIDIA technical blogs*
