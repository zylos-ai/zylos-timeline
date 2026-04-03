---
date: "2026-04-03"
title: "Inference Acceleration for AI Agent Loops: Speculative Decoding, KV Cache Reuse, and Prefill Disaggregation"
description: "A deep dive into the inference-level techniques that reduce latency and cost in production AI agent systems — covering speculative decoding variants, KV cache strategies, prefill-decode disaggregation, and the emerging category of speculative tool execution."
tags:
  - inference
  - speculative decoding
  - KV cache
  - AI agents
  - performance
  - cost optimization
  - serving infrastructure
---

## Executive Summary

Running AI agents in production exposes a structural mismatch: LLM inference was designed for single-turn, human-paced interaction, but agents execute tight loops — dozens or hundreds of sequential model calls where each step's output feeds the next step's input. The result is that inference latency compounds into end-to-end task durations that feel unacceptably slow, while token costs accumulate at 100:1 input-to-output ratios.

Three families of techniques have emerged to close this gap: **speculative decoding** (generate draft tokens cheaply, verify in parallel), **KV cache reuse** (avoid recomputing shared prefixes across agent turns), and **prefill-decode disaggregation** (split the compute graph so the two phases don't interfere). A fourth, newer category — **speculative tool execution** — applies speculative reasoning at the agent-action level rather than the token level, overlapping tool calls with LLM decoding.

In 2025 these moved from research curiosities to production defaults. EAGLE-3 ships in vLLM and Google Vertex AI. KV-aware routing in llm-d achieves 57x TTFT improvements. SuffixDecoding powers Snowflake's ArcticInference. Anthropic introduced automatic prompt caching on Claude 3.7 Sonnet. Together AI's prefill-decode disaggregation delivers 40% higher throughput on long-context workloads. For teams running agent infrastructure, understanding these mechanisms is now as fundamental as understanding batching was five years ago.

---

## The Agent Inference Problem

Standard LLM benchmarks measure single-request latency or throughput. Neither metric captures the agent loop:

- **Prefix growth**: Each agent turn appends to a growing context window. A 50-turn coding agent starting with a 10K-token system prompt accumulates 500K tokens of redundant prompt material, all re-sent on every API call.
- **Sequential dependency**: Step N cannot start until step N-1 completes — the agent must read tool results to decide the next action. Parallel batching offers no relief for the critical path.
- **High input-to-output ratio**: Agent calls often generate 20–50 output tokens (a tool call or a brief observation) while processing thousands of input tokens. The decode phase is short; the prefill phase dominates.
- **Tool latency interleaved with inference**: API calls, code execution, database queries, and web fetches sit between inference steps, and waiting for both the LLM and the tool sequentially doubles the effective latency.

The compounding effect is significant. An agent completing 30 turns with 1 second of LLM latency per step takes 30 seconds minimum — before tool latency. Reduce that per-step latency by 3x through speculative decoding and the same task completes in 10 seconds.

---

## Speculative Decoding: Drafting Tokens in Parallel

### Core Mechanism

Standard autoregressive decoding generates one token per forward pass. For a 70B parameter model, generating 500 tokens requires 500 sequential full-model passes. Speculative decoding inserts a fast **draft model** that proposes multiple candidate tokens, then uses the target model to verify all proposals in a single parallel forward pass. Accepted tokens advance the sequence; rejected tokens trigger regeneration from the rejection point. The output distribution is mathematically identical to the target model alone — there is no accuracy tradeoff.

The speedup depends on the **token acceptance rate** of the draft model. A draft that is right 80% of the time on average yields meaningful speedups; one right 50% of the time may actually regress.

### EAGLE-3: Training-Time Test

The EAGLE family (SafeAILab, accepted at ICML'24, EMNLP'24, and NeurIPS'25) reached its third generation in March 2025 with a key architectural change: rather than predicting the next token from the top-layer hidden state alone, EAGLE-3 fuses **low-, mid-, and high-level semantic features** from the target model and removes the feature prediction constraint by simulating the process during training via training-time testing.

Production numbers published by Red Hat, Google Vertex AI, and Amazon SageMaker AI show:

- **2–3x decode speedup** for Llama 70B on typical workloads
- **Up to 6x speedup** for code generation tasks where token sequences follow repetitive templates
- **HumanEval benchmark**: 2.52x speedup at batch size 4, consistently the highest of any task type tested

EAGLE-3 is integrated into vLLM and SGLang. AWS SageMaker AI introduced EAGLE-based adaptive speculative decoding as a managed feature in 2025, selecting draft model configurations dynamically based on observed acceptance rates.

### SuffixDecoding: Model-Free Speculation for Agents

NeurIPS 2025 Spotlight **SuffixDecoding** (CMU / Snowflake) takes a different approach entirely: it maintains a **suffix tree** over the output token history across requests and uses high-frequency suffix patterns to propose draft continuations — no draft model, no GPU overhead, runs on CPU memory.

The insight is that agent workloads are extremely repetitive. An agent issuing SQL queries, editing files, or calling APIs generates predictable token sequences — boilerplate around tool invocations, fixed JSON structures, repeated error handling phrasing. SuffixDecoding exploits this directly.

Benchmark results on agentic tasks:

- **AgenticSQL**: 5.3x mean speedup over vanilla decoding; 2.8x over EAGLE-2/3; 1.9x over Token Recycling
- **SWE-Bench**: 2.5x mean speedup over vanilla; 1.7x over Prompt-Lookup Decoding

SuffixDecoding adapts speculation length dynamically — longer drafts when acceptance likelihood is high, shorter when uncertain. It powers Snowflake's ArcticInference, described as the fastest speculative decoding solution for agents in vLLM.

### PEARL and Universal Speculative Decoding

**PEARL** (2025) demonstrates that draft models do not need to share vocabulary with the target model, enabling **any small model** to accelerate any large model regardless of tokenizer differences. Intel and Weizmann Institute advanced this with cross-architecture speculative decoding, opening paths to using highly quantized or domain-tuned small models as universal drafts. PEARL reports up to 2.5x inference time reduction vs traditional autoregressive decoding.

---

## Speculative Tool Execution: Beyond the Token Level

The most agent-specific innovation of 2025 applies speculation not to individual tokens but to **entire tool calls**.

### Optimizing Agentic LM Inference via Speculative Tool Calls (arXiv 2512.15834)

This paper introduces engine-level speculation for agentic inference: when the target model begins decoding what appears to be a tool call, the engine speculatively begins executing that tool call before decoding is complete. If the speculation is correct (verified in a single forward pass via early exit decoding), the tool result is available immediately when decoding finishes — eliminating the sequential model → wait → tool → model pipeline.

Results: **several hundred tokens per second throughput improvement** when hosting inference for LM agents on concurrent request workloads.

### PASTE: Pattern-Aware Speculative Tool Execution (arXiv 2603.18897)

**PASTE** extends this by observing that agents exhibit **stable application-level control flows** — the sequence of tool calls in a given workflow is highly predictable from previous interactions. A pattern library built from agent history predicts the next N tool calls with high accuracy, enabling multi-step speculative execution.

Results: **48.5% reduction in average task completion time** and **1.8x improvement in tool execution throughput**.

### Speculative Actions (arXiv 2510.04371)

This framework generalizes to all agentic system actions. A faster model predicts likely next actions; faster but lower-confidence predictions are verified or rolled back. On the tested benchmarks, next-action prediction accuracy reaches **up to 55%**, translating to significant end-to-end latency reductions without output quality degradation.

The combined picture: speculative techniques are being applied at every level of the stack — token drafting, tool call speculation, and full action prediction — creating layered parallelism in what was previously a purely sequential pipeline.

---

## KV Cache Reuse: Eliminating Redundant Prefill

### The Prefix Problem

Every LLM inference call starts with a **prefill phase** that processes the entire input sequence and computes key-value attention tensors for every token. In a 50-turn agent session where the system prompt and accumulated context grows to 100K tokens, the final turn's prefill must process those 100K tokens even though 99K of them are identical to the previous turn. This is expensive: prefill is compute-bound, and recomputing the same KV tensors at every step accounts for a substantial fraction of total inference cost in long-horizon agent tasks.

**Prefix caching** stores computed KV tensors keyed on the token sequence hash. When a new request shares a prefix with a cached entry, the server skips recomputation and loads tensors directly from cache.

### Provider-Level Prompt Caching

Major inference providers have made prefix caching accessible via API:

- **Anthropic**: Explicit cache control headers allow marking segments for caching. Cache write costs 1.25x the base input token price (5-minute TTL) or 2x (1-hour TTL). Cache read costs 0.1x the base price — a **90% reduction**. For Claude 3.7 Sonnet, cache read tokens no longer count against ITPM rate limits, removing a significant production constraint. Anthropic also introduced automatic prompt caching that identifies static prefix segments without manual annotation.
- **OpenAI**: Automatic prefix caching for prefixes over 1,024 tokens with a 90% discount on cached tokens.
- **Google**: Similar caching semantics for Gemini models.

A concrete example: a coding agent running 50 turns with a 10K-token system prompt would otherwise pay for 500K input tokens of the same instructions. With prompt caching, only the first call pays full price; subsequent calls pay 10% of the input token cost for the cached portion. Combined with the batch API (50% discount), overall cost can be reduced by up to **95%** relative to naive implementation.

### KVFlow: Workflow-Aware Cache Management (NeurIPS 2025)

Standard prefix caching uses **Least Recently Used (LRU)** eviction — the cache entry that was accessed longest ago is evicted first. This fails in multi-agent workloads because agents may lie dormant for multiple steps before their turn, and LRU evicts their KV cache shortly before it would be needed.

**KVFlow** (arXiv 2507.07400, NeurIPS 2025 poster) introduces workflow-aware eviction by modeling the agent execution schedule as an **Agent Step Graph**. Each agent is assigned a "steps-to-execution" value indicating how many steps until it next needs the inference engine. KVFlow's eviction policy prioritizes evicting agents with high steps-to-execution (they won't be needed soon), preserving cache for agents about to activate.

Additionally, KVFlow introduces **KV prefetching**: background threads proactively load KV tensors from CPU to GPU for agents scheduled in the next step, hiding the memory transfer latency behind computation.

Results vs SGLang with hierarchical radix cache:
- **1.83x speedup** for single workflows with large prompts
- **2.19x speedup** for scenarios with many concurrent workflows

### Distributed KV Caching: llm-d and LMCache

Single-node prefix caching breaks down in distributed serving where requests are load-balanced across multiple inference replicas — a request may land on a replica that doesn't hold the relevant cache, incurring full recomputation.

**llm-d** (IBM, Google, Red Hat collaboration) implements **KV cache-aware routing**: requests are directed to the replica whose GPU memory already holds the relevant cached prefix. The llm-d-kv-cache service coordinates cross-node cache state, enabling precise cache-aware scheduling.

Production numbers from the llm-d team:
- **87.4% overall cache hit rate** in benchmarked workloads
- **57x faster response times** and **2x throughput** on identical hardware vs round-robin baseline
- v0.5 validated ~3,100 tokens/second per B200 decode GPU with up to 50K output tokens/second on a 16x16 B200 topology

**LMCache** (arXiv 2510.09665) provides an enterprise-scale KV cache layer that sits between the serving infrastructure and GPU memory, supporting multi-tier storage (GPU VRAM → CPU DRAM → NVMe) with semantic-aware prefetching. It is designed to integrate with vLLM as a pluggable cache backend.

---

## Prefill-Decode Disaggregation

### Why Disaggregation Matters for Agents

LLM inference has two distinct compute phases:

- **Prefill**: Process all input tokens in parallel. Compute-bound — benefits from large batch sizes and high FLOPs throughput. Can be milliseconds to seconds for long contexts.
- **Decode**: Generate output tokens sequentially. Memory-bandwidth-bound — dominated by KV cache read speed, not arithmetic throughput.

In a monolithic serving setup, prefill and decode compete for the same GPU. A long prefill for one request delays the decode step of another, introducing jitter and increasing p99 latency for all concurrent users. For agent workloads with high input-to-output ratios, this interference is severe.

**Disaggregation** routes prefill and decode to separate pools of hardware optimized for each phase. Prefill workers use high-FLOPs configurations; decode workers optimize for memory bandwidth.

### Production Deployments

**Together AI** (blog, 2025) implemented **cache-aware prefill-decode disaggregation (CPD)** that further separates cold requests (no cache hit) from warm requests (cache hit) by hit rate. Results: **up to 40% higher sustainable throughput** and significantly lower TTFT for long-context inference.

**DistServe** (Hao AI Lab, UCSD) formalizes the principle: treating prefill and decode as separate scheduling problems and demonstrating that disaggregation maximizes "goodput" (throughput of requests meeting latency SLAs) rather than raw throughput.

**vLLM** added experimental disaggregated prefill support in 2025, enabling vLLM instances to be configured as dedicated prefill or decode workers with KV cache transfer over InfiniBand or NVLink.

The practical benefit for agent infrastructure: long system prompts and accumulated context (prefill-heavy) do not degrade the decode latency of concurrent shorter requests. Teams running mixed agent workloads — some with long context, some with short — see the most benefit.

---

## Putting It Together: A Layered Optimization Stack

For a production agent serving system, these techniques compose into a stack where each layer attacks a different bottleneck:

| Layer | Technique | Primary Benefit | Typical Gain |
|---|---|---|---|
| **Token generation** | EAGLE-3 / SuffixDecoding | Reduce decode latency | 2–5x |
| **Prefix processing** | Prompt caching / KV reuse | Eliminate redundant prefill | 85–90% TTFT reduction |
| **Multi-agent scheduling** | KVFlow workflow-aware eviction | Preserve cache across agent turns | 1.8–2.2x |
| **Distributed serving** | KV-aware routing (llm-d) | Cross-node cache hit rate | 57x TTFT, 2x throughput |
| **Compute allocation** | Prefill-decode disaggregation | Eliminate phase interference | 40% throughput increase |
| **Tool latency** | PASTE / speculative tool calls | Overlap inference and tools | 48% task time reduction |

No single technique dominates all workload types. SuffixDecoding outperforms EAGLE-3 on highly repetitive agentic patterns. EAGLE-3 outperforms SuffixDecoding on diverse generation. Prompt caching has a threshold effect — below 1,024 tokens it provides no benefit. KV-aware routing matters most in multi-replica deployments.

The practical recommendation for teams building agent infrastructure:

1. **Enable prompt caching first** — zero engineering effort for API users, immediate 90% input cost reduction on long prefixes.
2. **Structure prompts for cache efficiency** — stable content (system prompt, tools, examples) should precede variable content (user turn, conversation history) to maximize prefix hit rates.
3. **Deploy SuffixDecoding or EAGLE-3** for self-hosted inference — choose SuffixDecoding for repetitive agent patterns (SQL, code editing, structured output), EAGLE-3 for diverse generation.
4. **Implement KV-aware routing** when scaling to multiple replicas — round-robin destroys cache hit rates; prefix-aware routing restores them.
5. **Profile tool latency** — if external tool calls (APIs, code execution) account for >30% of end-to-end time, speculative tool execution becomes the highest-leverage optimization.

---

## The Metric That Matters: KV Cache Hit Rate

Several production teams have independently arrived at the same conclusion: **KV cache hit rate is the single most important metric for a production-grade AI agent**. It directly drives both latency (via TTFT reduction) and cost (via input token discounts).

A team tracking this metric can directly observe the impact of prompt structure changes, caching policy adjustments, and routing decisions. llm-d reports 87.4% hit rates on well-structured workloads; poorly structured prompts with variable content early in the sequence may see 10-20% hit rates on the same hardware.

The practical implication: prompt engineering for agent systems is not only about instruction quality but also about **cache geometry** — where in the token sequence the static vs dynamic content is placed.

---

## Open Problems

- **Speculative decoding acceptance rates degrade with diversity**: SuffixDecoding and EAGLE both rely on output predictability. As agents are used for more open-ended, creative tasks, acceptance rates drop and speedups diminish. Adaptive systems (TurboSpec's closed-loop control) partially address this.
- **Cross-session KV reuse**: Current caching is typically per-session or per-prefix. Sharing KV cache across different users' sessions (e.g., for a common system prompt) requires careful security isolation to prevent cross-user information leakage.
- **Speculative tool execution correctness**: Rolling back a partially executed tool call (one that had side effects) is much harder than rejecting a draft token. Current systems only speculate side-effect-free tools.
- **Cost of cache misses in disaggregated systems**: KV transfer between prefill and decode workers over network adds latency. For short-context requests where transfer overhead exceeds prefill time, disaggregation can hurt rather than help.

---

## Conclusion

Inference acceleration for AI agent loops has moved decisively from academic exploration to production infrastructure in 2025–2026. EAGLE-3 is a managed cloud feature on major providers. Prompt caching is on by default. Disaggregated serving is in experimental vLLM releases. Speculative tool execution has demonstrated near-50% task latency reductions in targeted benchmarks.

The compounding effect of layering these techniques — cheaper prefill, faster decode, overlapped tool execution — transforms the economics of running autonomous agents at scale. What previously required expensive GPU clusters and careful request batching can now be achieved at a fraction of the cost with the same hardware, simply by understanding and applying these inference-level optimizations.

---

*Sources:*
- *[NVIDIA: An Introduction to Speculative Decoding](https://developer.nvidia.com/blog/an-introduction-to-speculative-decoding-for-reducing-latency-in-ai-inference/)*
- *[EAGLE-3: Scaling up Inference Acceleration (arXiv 2503.01840)](https://arxiv.org/html/2503.01840v1)*
- *[SuffixDecoding: Extreme Speculative Decoding for Emerging AI Applications (NeurIPS 2025 Spotlight)](https://suffix-decoding.github.io/)*
- *[KVFlow: Efficient Prefix Caching for Multi-Agent Workflows (arXiv 2507.07400)](https://arxiv.org/abs/2507.07400)*
- *[Optimizing Agentic LM Inference via Speculative Tool Calls (arXiv 2512.15834)](https://arxiv.org/abs/2512.15834)*
- *[PASTE: Act While Thinking (arXiv 2603.18897)](https://arxiv.org/abs/2603.18897)*
- *[Speculative Actions: A Lossless Framework for Faster Agentic Systems (arXiv 2510.04371)](https://arxiv.org/abs/2510.04371)*
- *[llm-d: KV Cache Wins You Can See](https://llm-d.ai/blog/kvcache-wins-you-can-see)*
- *[Together AI: Cache-Aware Prefill-Decode Disaggregation](https://www.together.ai/blog/cache-aware-disaggregated-inference)*
- *[Don't Break the Cache: Prompt Caching for Long-Horizon Agentic Tasks (arXiv 2601.06007)](https://arxiv.org/html/2601.06007v2)*
- *[Anthropic: Token-saving updates on the Anthropic API](https://claude.com/blog/token-saving-updates)*
- *[Red Hat: EAGLE-3 in vLLM](https://developers.redhat.com/articles/2025/07/01/fly-eagle3-fly-faster-inference-vllm-speculative-decoding)*
- *[AWS: P-EAGLE Parallel Speculative Decoding in vLLM](https://aws.amazon.com/blogs/machine-learning/p-eagle-faster-llm-inference-with-parallel-speculative-decoding-in-vllm/)*
- *[Berkeley EECS: Efficient LLM System with Speculative Decoding](https://www2.eecs.berkeley.edu/Pubs/TechRpts/2025/EECS-2025-224.html)*
