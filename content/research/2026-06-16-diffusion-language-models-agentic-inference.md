---
date: "2026-06-16"
title: "Diffusion Language Models for Agentic Inference"
description: "Non-autoregressive diffusion LLMs (Mercury, DiffusionGemma, LLaDA, Dream, Seed Diffusion) promise hundreds-to-thousands of tokens per second. This examines the mechanism, the 2026 model landscape, the honest tradeoffs, and where parallel decoding actually helps latency-stacked agent loops."
tags: ["ai-agents", "diffusion-llm", "inference-optimization", "agent-latency", "llm-serving", "model-landscape"]
---

## Executive Summary

Diffusion language models (dLLMs) — a class of non-autoregressive text generators based on iterative masked denoising — have crossed from academic curiosity to early commercial deployment in 2025–2026. Models from Inception Labs (Mercury), Google (DiffusionGemma, Gemini Diffusion), ByteDance (Seed Diffusion), and the open research community (LLaDA, Dream, DiffuLLaMA) now collectively demonstrate that you can generate coherent text at hundreds to thousands of tokens per second on modern GPUs — far faster than frontier autoregressive (AR) models at comparable quality tiers. For AI agent runtimes, this matters acutely: agent loops are structurally latency-stacked, and shaving the per-step model call time from seconds to milliseconds compresses multi-hop task completion from minutes to seconds. This article surveys the mechanism, the 2026 model landscape, the honest tradeoffs, and where dLLMs slot usefully into agentic inference pipelines.

## How Diffusion Language Models Differ from Autoregressive Decoding

### The Autoregressive Bottleneck

Standard transformer-based LLMs generate tokens one at a time, left to right. At each step, the model runs a full forward pass through all layers, samples one token, appends it to the context, and repeats. This is fundamentally sequential: step N cannot begin until step N-1 produces its token. The practical consequence is that throughput — tokens per second — is bounded by the time for a single forward pass, and you cannot parallelize across output token positions without breaking the causal structure.

On frontier models served via API as of mid-2026, you typically see 50–200 tokens/s under light load, and considerably less when you factor in queueing, prefill time, and long-context overhead. A 500-token response thus takes several seconds of wall-clock time at the token-generation phase alone.

### Masked Diffusion: The Core Mechanism

Diffusion language models work differently. The dominant family in 2025–2026 is masked diffusion (also called discrete diffusion or masked language model diffusion), descended from the MDLM line of work, and most visibly realized in LLaDA (arxiv:2502.09992, presented as an oral at NeurIPS 2025).

The forward process corrupts a full target sequence by progressively masking tokens — at full noise, the entire sequence is masked. The model (a bidirectional transformer) learns the reverse: starting from a fully masked sequence, iteratively predict and unmask tokens across all positions. At inference time, you start with `[MASK][MASK]...[MASK]` for N positions and run a fixed number of denoising steps T (typically much smaller than N). In each step, the model attends to every token position simultaneously — including both already-revealed tokens and still-masked ones — and fills in some fraction of the remaining masks.

The crucial difference from AR: token generation is parallel within a step, and the model uses bidirectional context. A token near position 100 can attend to tokens at position 200 when making its prediction. This gives dLLMs a structural advantage for tasks where the correct completion depends on future context: code infilling, inline editing, fill-in-the-middle, and constraint satisfaction.

### The Denoising Steps vs. Sequence Length Tradeoff

In AR decoding, you always run exactly N forward passes to generate N tokens — the math is fixed. In masked diffusion, T (number of denoising steps) is a free parameter independent of N. If N=512 and T=32, each denoising step unmasks roughly 16 tokens on average. You can set T=8 for a rough but fast output, or T=128 for higher quality at the cost of more passes. This is the speed/quality knob that makes dLLMs attractive: you can trade generation quality for latency at runtime, something AR models cannot do without changing the underlying architecture.

However, there is a fundamental quality challenge: when you unmask multiple tokens simultaneously in one step, you must assume conditional independence between them given the current context. This factorized approximation introduces bias. The ParallelBench study (arxiv:2510.04767) quantified this: accuracy on GSM8K drops roughly 10 percentage points when you go from unmasking 1 token per step (equivalent to AR) to 2 tokens per step. The degradation accelerates as you try to unmask more tokens at once. In practice, commercial dLLMs use carefully tuned denoising schedules to balance this tradeoff.

## The 2026 Landscape

### Inception Labs Mercury

The most visible commercial entrant. Inception Labs launched Mercury Coder in early 2025 as the first commercial-scale dLLM, followed by Mercury 2 in February 2026, described as the first reasoning dLLM. The company's benchmarks, run on NVIDIA H100s, report Mercury Coder Mini at 1,109 tokens/s and Mercury Coder Small at 737 tokens/s. Mercury 2 is claimed at over 1,000 tokens/s, versus roughly 100 tokens/s for frontier AR models. These figures are **vendor claims**, measured under controlled conditions — but Mercury 2 is the one case with strong independent corroboration: the third-party benchmark service Artificial Analysis recorded roughly 1,196 tokens/s on Mercury 2's live API endpoint, the single best-verified throughput number in the class as of mid-2026.

On quality benchmarks, Mercury Coder Small scores 90.0 on HumanEval — competitive with mid-tier code models but not at the frontier of specialized coding models. Mercury 2 supports tool calling and structured JSON output via an OpenAI-compatible API, is priced around $0.20–0.25/M input and $1.00/M output, and is available on Inception's platform plus OpenRouter and Azure AI Foundry. The speed-quality pitch is explicitly positioned not against GPT-4-class intelligence but against the cost-performance tier of capable-but-fast models.

### Google: DiffusionGemma and Gemini Diffusion

Google announced Gemini Diffusion at Google I/O 2025, claiming it was 5x faster than Gemini 2.0 Flash-Lite while matching its programming performance, with a DeepMind researcher citing up to ~2,000 tokens/s on programming tasks. As of mid-2026 it remains a research preview limited to trusted testers; no public API exists and no independent benchmarks have been reproduced. The ~2,000 t/s figure is for a favorable workload (programming) and should be read as a vendor claim.

More accessible is DiffusionGemma, released June 10, 2026 as an open model under Apache 2.0 — the first time Google made a diffusion-based text model available as open weights. It is a 26B Mixture-of-Experts architecture (~3.8B active parameters) that denoises blocks of 256 tokens in parallel, with confirmed vLLM support. Google claims up to 4x faster text generation and 1,000+ tokens/s on a single H100. Because the weights are open, the research community can reproduce and evaluate it — though comprehensive independent evaluation has not yet consolidated in the literature. (Note: Gemini Diffusion the research preview and DiffusionGemma the open release are related but distinct; Google's own materials name them separately.)

### ByteDance Seed Diffusion

Seed Diffusion Preview (arxiv:2508.02193) is ByteDance's entry, focused on code generation. It claims 2,146 tokens/s — the highest throughput claim in the class as of mid-2026, a reported 5.4x speedup over AR models of comparable scale. The model is competitive with autoregressive counterparts on standard code benchmarks and reportedly outperforms AR models on code-editing tasks. These are self-reported figures from a preprint; independent verification is pending. Technical contributions include constrained-order diffusion, block-wise parallel sampling, and two-stage curriculum training.

### Open Research: LLaDA, LLaDA 2.x, Dream, DiffuLLaMA

**LLaDA** (arxiv:2502.09992, Renmin University / Ant Group) is the landmark open research model — an 8B diffusion model trained from scratch on 2.3T tokens, presented as a NeurIPS 2025 oral. It achieves performance comparable to LLaMA 3 8B across a range of benchmarks (MMLU ~65.9 for the base model) and, notably, surpasses GPT-4o on reversal completion tasks — a concrete demonstration of the bidirectional-context advantage and a direct counter to the "reversal curse."

**LLaDA 2.0** (arxiv:2512.15745) from Ant Group's InclusionAI team scaled diffusion LLMs to 100B parameters for the first time, releasing a 16B mini and a 100B MoE flash variant as open weights. **LLaDA 2.1** (February 2026) added Token-to-Token editing alongside Mask-to-Token generation and the first large-scale RL post-training framework specifically for dLLMs, reporting 663–892 tokens/s on coding benchmarks at the 100B scale (author claim). Together these demonstrate that AR-to-diffusion conversion is viable at scale, bypassing the need to train from scratch.

**Dream 7B** (arxiv:2508.15487, HKU NLP Group) initializes from an AR backbone and continues training with diffusion objectives. It achieves competitive scores vs. AR models of similar size, with particularly strong results on planning tasks (Countdown, Sudoku), where bidirectional generation apparently helps with constraint propagation.

**DiffuLLaMA** (arxiv:2410.17891, ICLR 2025, HKU NLP) pioneered adapting pretrained AR weights (GPT-2, LLaMA-7B) into masked diffusion format using attention-mask annealing and a shift operation — with under 200B tokens of adaptation compute. It is the conceptual ancestor of the later AR-to-diffusion conversion work and demonstrated the transfer is feasible at 7B scale on a modest budget.

## Why Agent Loops Are Uniquely Latency-Sensitive

### The Latency Stacking Problem

A ReAct-style agent loop is structurally sequential: reason → call tool → observe result → reason again → call next tool → ... Each model call must complete before the next begins, because the observation from step N is the input to step N+1.

Empirically, running a 70B AR model on two A100s produces roughly 11 tokens/s, with an average of ~52 tokens per planning step, yielding ~4.5 seconds per step. A 10-step task thus takes 45+ seconds of pure model time, before tool execution. Context also grows per step: by step 10 you may be feeding 8K+ tokens into prefill, which scales roughly linearly and adds further cost. Even on faster cloud APIs delivering 100–200 tokens/s, a 10-step agent task with 200-token responses per step takes 20–40 seconds of LLM time — already at the edge of acceptable for interactive use, and agentic software-engineering tasks routinely run 50+ steps.

### Where Parallel Decoding Changes the Calculus

If a dLLM generates 200 tokens in 8–16 denoising steps at 1,000+ tokens/s throughput, the wall-clock latency per step drops from multiple seconds to fractions of a second. On a 10-step task, that compresses LLM time from ~40 seconds to perhaps 3–5 seconds, and the agent-loop overhead (tool execution, I/O, orchestration) becomes the dominant term rather than model inference.

Additionally, dLLMs naturally produce a whole structured block in one batch of denoising steps. If that block is a JSON object containing multiple tool calls, the entire multi-call payload is generated together rather than serialized token-by-token — a clean fit for the parallel tool-execution patterns that most production agent frameworks still underutilize.

## Honest Tradeoffs and Current Limitations

### Quality Gap at the Reasoning Frontier

The most important caveat: no dLLM as of mid-2026 competes with frontier reasoning models (GPT-4-class, Claude Opus, Gemini Pro) on complex multi-step reasoning. The comparison that makes sense is against mid-tier fast-inference AR models — and even there, dLLMs show clear gaps on tasks requiring deep chain-of-thought. The GSM8K accuracy drop when parallelizing unmasks is a microcosm of a broader challenge: reasoning tasks with strong sequential dependencies get harder when you break the left-to-right commitment order. Dream 7B's strong planning performance is encouraging and shows diffusion's bidirectional awareness can help with certain constraint-heavy tasks, but that is not the same as general mathematical reasoning.

### KV Cache Incompatibility

Standard AR inference engines (vLLM, TensorRT-LLM) are built around incremental KV cache: after generating token N, you cache the K/V tensors for positions 1..N and reuse them. Diffusion models iterate over the entire sequence at each denoising step — all N positions are active simultaneously — so the standard incremental KV cache does not apply. Early work (Fast-dLLM, dInfer) is emerging, but mainstream frameworks lack mature support as of mid-2026. Block diffusion architectures, which factorize autoregressively over blocks while applying diffusion within blocks, partially recover KV caching across blocks — but this is still a research-stage capability. The upshot: dLLM serving infrastructure today is less mature than the AR ecosystem, and vendor throughput benchmarks may reflect bespoke optimization that is not reproducible with off-the-shelf tooling.

There is a sharper version of this caveat worth internalizing. An independent efficiency study ("How Efficient Are Diffusion Language Models?", arxiv:2510.18480) found that at batch scale, AR models actually achieve the *highest* throughput, followed by block diffusion, with vanilla dLLMs slowest — and that dLLM acceleration techniques "mainly offer gains at batch size of 1," with benefits diminishing as you scale up batching. This is not a flat contradiction of the vendor numbers (Inception measures single-request latency on top-tier GPUs with optimal batching; the critical study measures batch throughput on commodity H100s), but it means the headline "10x faster" figure is a single-request-latency claim, not a throughput-per-dollar claim. For an agent runtime, single-request latency on the critical path is often exactly what you care about — but for a high-throughput batch workload, the economics can invert. Measure your actual serving regime.

### Structured Output and Tool Calling Maturity

Mercury 2's OpenAI-compatible API with tool calling and JSON-schema support is a meaningful step, and the argument that diffusion's whole-sequence refinement improves schema adherence (the model sees the full JSON structure at once rather than committing left-to-right) is architecturally plausible. But production-grade reliability for nested JSON, complex schemas, or adversarial inputs has not been independently benchmarked against AR alternatives at comparable quality tiers. Treat these capabilities as provisional until reproduced.

### Context Length, Determinism, Controllability

Current open dLLMs operate most reliably at shorter sequence lengths — denoising quality degrades as output length grows. Long-horizon planning, the primary capability of frontier AR models in agentic contexts, remains an area where autoregressive systems have a significant lead. And diffusion sampling inherently involves stochastic noise at each step, which complicates the deterministic replay that production agent systems value for debugging; AR greedy decoding (temperature=0) is deterministic by default, whereas dLLM determinism requires extra machinery.

## Architecture of the Serving Stack

Diffusion serving is compute-bound in a different way than AR. AR inference is primarily memory-bandwidth-bound at small batch sizes (loading weights per token step). dLLM inference runs T full forward passes over the entire sequence, behaving more like T batched requests — which plays nicely with high-batch throughput but makes latency-per-request hard to push below T×(single-pass time). Speculative diffusion decoding (e.g. Spiffy, arxiv:2509.18085) combines dLLM draft generation with AR verification to get fast parallel drafts plus AR-grade quality — the draft-verify paradigm of traditional speculative decoding, with the diffusion model playing the drafter role.

## Forward Look: What Needs to Be True

**Block diffusion at production scale.** Block diffusion (the "Interpolating Between Autoregressive and Diffusion Language Models" line of work) recovers KV caching across blocks and enables flexible sequence lengths — addressing two of the largest infrastructure gaps. If it scales cleanly to frontier sizes and integrates with vLLM-style serving (SGLang has dLLM serving on its roadmap), the infrastructure gap narrows substantially.

**Reasoning-quality convergence.** LLaDA 2.0 scaling to 100B parameters signals the quality gap may not be fundamental. If scaled pretraining plus RL post-training (DiRL and similar dLLM-specific RLHF analogs) converge on reasoning benchmarks, the use case expands from "fast sub-agent for extraction and code editing" to "capable reasoning model at lower cost."

**Hybrid AR-diffusion architectures.** Systems that run AR for reasoning traces (where sequential dependence matters) and diffusion for response generation (where parallelism is safe) are a pragmatic middle path — keep AR where it wins, use diffusion where parallelism helps. This "AR planner + dLLM executor" split is the most likely near-term production pattern.

## Implications for Agent Builders

**Where dLLMs slot in today.** Latency-critical sub-agent roles are the natural fit: structured data extraction, code infilling and patch generation, fill-in-the-middle completions, rapid draft generation for a verify-then-refine pipeline, and edge/local deployments where infrastructure simplicity matters. If your orchestration layer has a "worker" tier doing high-volume, lower-complexity tasks — classification, summarization, schema population — a dLLM at 500–1,000+ tokens/s is compelling versus frontier API costs at 50 tokens/s.

**Where AR frontier models still win.** Main-loop reasoning: long-horizon task decomposition, complex architecture decisions, multi-step math, adversarial robustness. Keep the orchestrator AR. And remember the bottleneck is not always the model — tool execution, I/O, and orchestration overhead often dominate. Swapping in a dLLM that produces lower-quality plans faster may not improve end-to-end completion if the planning errors require extra recovery steps.

**Production-readiness caveat.** The throughput numbers (1,000–2,000+ tokens/s vs 50–200 for AR) are compelling, but most are vendor benchmarks on controlled workloads — Mercury 2's ~1,196 t/s via Artificial Analysis is the notable independently-verified exception. The serving infrastructure is immature: KV-cache support is nascent, vLLM/TGI integration is partial, and structured-output reliability is not independently stress-tested. Evaluate on your specific workloads with realistic quality bars before architectural commitments.

**What this means for a persistent agent runtime like Zylos.** The honest read for mid-2026: the frontier reasoning model driving the main loop is not threatened. But a fast dLLM is a credible candidate for the cheap, high-fan-out sub-agent roles a runtime spawns constantly — memory-sync summarization, structured extraction from conversations, code-patch drafting, classification/triage — where latency and cost matter more than peak reasoning. The right frame is not "dLLMs replace AR" but "dLLMs unlock a new cost-latency operating point that makes certain agent topologies — high-fan-out, latency-sensitive, lower-complexity execution — economically and architecturally viable." Worth tracking the independently-reproduced benchmarks and block-diffusion serving maturity; not worth re-architecting around yet.
