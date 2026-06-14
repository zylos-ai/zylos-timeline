---
date: "2026-05-31"
title: "Speculative Decoding for Agent Runtimes: From Research to Production"
description: "How speculative decoding, speculative tool calling, and prefill-decode disaggregation are reshaping inference latency in multi-step agentic workloads."
tags: ["speculative-decoding", "ai-agents", "inference-optimization", "llm-serving", "tool-calling", "kv-cache"]
---

## Executive Summary

The single biggest constraint on agentic AI systems in 2026 is not model quality — it is inference latency. A coding agent that takes three seconds per reasoning step feels interactive; one that takes ten seconds per step breaks the feedback loop that makes agentic work valuable. As agents grow more capable and tackle longer-horizon tasks with many sequential tool calls, this latency compounds in ways that degrade user experience faster than any benchmark captures.

Speculative decoding — a class of techniques that exploits parallel verification to generate multiple tokens per model forward pass — emerged from research around 2023 and crossed into mainstream production deployment in 2025. By 2026, it is a standard component of every serious LLM serving stack, built into vLLM, SGLang, and TensorRT-LLM with single-flag enablement. More importantly, the research community has now extended the core idea beyond token-level speculation into the agentic domain: speculative tool calling, speculative actions, and workflow-aware KV cache management collectively offer a new set of architectural levers for reducing multi-step agent latency without touching model quality.

This article examines the state of speculative inference for agent runtimes in 2026: the core mechanics, the production deployment landscape, agentic-specific extensions, and practical guidance for teams building latency-sensitive agent systems.

## How Speculative Decoding Works

Standard autoregressive decoding generates one token at a time. Each token requires a full forward pass through a large model, which is expensive. The insight behind speculative decoding is that a small, fast "draft" model can propose a sequence of candidate tokens cheaply, and then the large "target" model can verify the entire candidate sequence in a single parallel forward pass. When the draft model's predictions are correct, multiple tokens are committed per target model call. When they diverge, execution falls back gracefully to standard decoding from the point of disagreement.

The key property is that speculative decoding is **lossless** — the outputs produced are statistically identical to those of the target model run in standard mode. This is not an approximation or a quality trade-off; it is a pure latency optimization that exploits the gap between GPU memory bandwidth (the bottleneck for sequential decoding) and GPU compute (which has headroom for parallel verification).

Practical speedups depend on the acceptance rate: the fraction of draft tokens the target model agrees with. For typical conversational and agentic workloads, acceptance rates of 70–90% translate to 2–3× end-to-end speedups. Acceptance rates are task-dependent — repetitive structured outputs (JSON tool calls, code) tend to have higher acceptance rates than creative prose.

### EAGLE and the Draft Architecture Evolution

The dominant speculative decoding family in production is EAGLE (Extrapolation Algorithm for Greater Language-model Efficiency). Unlike naive approaches that train a separate smaller model as a draft, EAGLE uses the target model's own hidden states from the previous token to condition the draft head. This dramatically improves acceptance rates because the draft has access to the same context representation as the target.

EAGLE-3, released in early 2025, further improves acceptance rates by training the draft head with multiple layers of feature extraction rather than a single linear projection. In production measurements on SGLang with an H100 GPU, EAGLE-3 provides 1.81× throughput improvement at batch size 2 and maintains 1.38× at batch size 64. The absolute speedup shrinks at high batch sizes because the decode step becomes more compute-efficient with batching, reducing the relative benefit of speculation.

In March 2026, vLLM shipped **P-EAGLE** (Parallel EAGLE), which addresses a fundamental limitation of EAGLE's sequential draft generation. Standard EAGLE must generate K draft tokens in K autoregressive steps within the draft head, which introduces its own sequential bottleneck. P-EAGLE generates all K draft tokens in a single forward pass through the draft head by using learnable mask tokens for positions where future tokens are not yet available. On NVIDIA B200 hardware, P-EAGLE achieves 1.05–1.69× additional speedup over EAGLE-3 at low concurrency, and 5–25% gains at high concurrency (64 concurrent requests). Its optimal speculation depth increases from K=3 (EAGLE-3's sweet spot) to K=7, meaning each target model call can commit up to 7 tokens when predictions align.

Production P-EAGLE is enabled with a single configuration field:

```json
{ "parallel_drafting": true }
```

Pre-trained P-EAGLE draft heads are available on HuggingFace for GPT-OSS 120B, GPT-OSS 20B, and Qwen3-Coder 30B. The Snowflake team's Arctic-based speculative decoding work on vLLM has demonstrated similar results: 2.8× speedup on MT-Bench in low-concurrency scenarios.

## Prefill-Decode Disaggregation for Agentic Workloads

Token generation (decode) is not the only latency bottleneck. In agentic workflows, where agents frequently receive large context windows containing conversation history, retrieved documents, and tool results, the **prefill phase** — processing the full input before generating any tokens — can dominate time-to-first-token (TTFT) latency.

Prefill is compute-bound (GPU FLOPs), while decode is memory-bandwidth-bound (loading model weights). Mixing these two workloads on the same GPU means neither can be optimally scheduled. **Prefill-decode disaggregation** solves this by routing prefill requests to compute-optimized instances and decode requests to memory-bandwidth-optimized instances.

Meta, LinkedIn, Mistral, and HuggingFace were among the early production adopters of disaggregated serving in 2025. NVIDIA's Dynamo project, announced at GTC 2025, provides a production-grade infrastructure layer for this pattern. Research from 2025 has shown 4.5× lower p95 latency and 3.9× higher throughput in multi-model agent workloads through disaggregation combined with shared prefill modules.

For multi-agent systems, an additional optimization becomes relevant: **prefix caching**. Many agentic workflows share large static prefixes — the system prompt, retrieved documents, or shared tool schemas. When KV tensors for these prefixes are cached and reused across requests, prefill cost drops to near zero for the shared portion. This is particularly valuable in patterns like:

- Multi-agent orchestration where all sub-agents share the same system context
- Retrieval-augmented agents where the same retrieved chunks appear in multiple queries
- Tool-use agents where the tool schema definitions remain static across turns

The RelayCaching paper (2025) demonstrated over 80% KV cache reuse across agent collaborations, reducing TTFT by up to 4.7× with negligible accuracy degradation.

## Speculative Tool Calling: Extending Speculation Beyond Tokens

The most architecturally significant extension of speculative decoding to agentic systems is **speculative tool calling** — predicting which tools an agent will invoke before the model explicitly generates the tool call, and executing them in parallel with model generation.

### Static Speculative Tool Calls (arxiv:2512.15834)

The approach described in "Optimizing Agentic Language Model Inference via Speculative Tool Calls" works in three phases:

1. **Speculation**: A lightweight predictor estimates which tool will be called based on current conversation context, before the target model finishes generating.
2. **Parallel execution**: The predicted tool executes concurrently while the model continues generating tokens.
3. **Verification**: When the model produces its actual tool call, predictions are validated. If they match, the precomputed result is used immediately. If they diverge, the speculative execution is discarded.

This approach achieves 1.5–3× end-to-end speedups for tool-heavy agentic workflows. Gains are largest when tools have significant latency (database queries, API calls, web scraping) because the overlap between tool execution and model generation becomes more valuable. For fast in-process tools, the gains are smaller.

The approach is lossless by construction — the agent produces identical outputs whether or not tool calls were speculated, because speculative results are only used when they exactly match what the model requested.

### Asynchronous Speculative Tool Calling (arxiv:2605.13360)

"Speculative Interaction Agents" extends the concept further by combining asynchronous I/O with speculative tool execution to enable real-time agents with sub-second response latency even during multi-turn tool calling. Key innovations:

- **Asynchronous I/O**: The agent does not block waiting for tool results. It continues reasoning about other aspects of the task while tool execution proceeds in a background thread.
- **Safe vs. unsafe classification**: Tools are classified as safe (read-only: web search, database reads) and unsafe (state-modifying: file writes, API mutations). Safe tools execute speculatively on partial information; unsafe tools wait for final confirmation that the full query has been received.
- **Clock-based training**: The model is trained to handle streaming inputs by converting asynchronous delays into token counts, enabling it to adapt its generation to handle mid-utterance updates.

Experimental results on cloud APIs show 1.3–1.7× speedups with minor accuracy degradation. On edge models (Qwen2.5-3B, Llama-3.2-3B), speedups reach 1.6–2.2× on HotpotQA and TinyAgent benchmarks.

### Speculative Actions at the Workflow Level (arxiv:2510.04371)

A higher-level abstraction is **speculative actions** — parallelizing entire workflow branches rather than individual tool calls. Rather than executing agent steps sequentially (generate → act → observe → generate → act), the system speculatively executes multiple candidate next steps in parallel, then commits the branch that matches what the model actually requested.

Results across multiple benchmarks show 1.5–2.5× speedups on complex reasoning tasks. The overhead from failed speculations is minimal when prediction accuracy is reasonable (above ~60%). This approach is model-agnostic and compatible with existing agent frameworks.

## KV Cache Management for Agentic Workloads

Speculative decoding and speculative tool calling reduce the cost of active computation. But agentic workloads introduce a distinct class of problem: **KV cache eviction** during tool execution pauses.

When an agent calls a tool and waits for a result, the inference server may reassign GPU memory to serve other requests. On return, the agent's KV cache has been evicted, requiring a full prefill from the beginning of context — a significant penalty for long-context agents. Standard serving systems use Least Recently Used (LRU) eviction, which is oblivious to agent execution schedules and frequently evicts a cache just before the agent needs it.

**KVFlow** (arxiv:2507.07400) addresses this by introducing workflow-aware eviction. The system models agent execution as an "Agent Step Graph" and assigns each agent a "steps-to-execution" value — an estimate of how soon the agent will need its cached context. Eviction priority is assigned based on this value, preserving KV entries for agents about to resume while evicting entries for agents that are in a long wait state.

KVFlow also introduces **overlapped KV prefetching**: when an agent is scheduled next, its KV tensors begin transferring from CPU to GPU before the agent is fully ready, hiding the prefetch latency behind other work.

Results:

- 1.83× speedup over SGLang with hierarchical radix cache for large prompts in single-workflow scenarios
- 2.19× speedup for high-concurrency scenarios with many concurrent workflows
- 1.12× improvement on realistic PEER-style multi-agent applications

Similarly, **CacheTTL** (arxiv:2511.02230) introduces time-to-live policies for KV cache entries based on agent scheduling information, enabling servers to make smarter eviction decisions without requiring deep workflow instrumentation.

## Production Stack Patterns in 2026

By May 2026, a typical production inference stack for a latency-sensitive agent system combines several of these techniques:

- **Draft model**: EAGLE-3 or P-EAGLE draft head, pre-trained for the target model family
- **Speculation depth**: K=3–7 depending on workload and hardware generation
- **Prefill handling**: Chunked prefill to prevent long prompts from monopolizing GPU, with radix-tree prefix caching for shared contexts
- **Infrastructure**: Disaggregated prefill/decode for large-scale deployments; combined instances for small-scale or cost-constrained deployments
- **Tool calling**: Lightweight predictor for speculative tool pre-execution, with safe/unsafe classification
- **KV cache policy**: Workflow-aware eviction (KVFlow-style) when running concurrent agent workloads

A representative multi-model stack described in the speculative decoding community in 2026 combines DeepSeek-V3 with Multi-Token Prediction for long-context retrieval, an EAGLE-3-augmented Qwen3-32B for interactive customer-service agents, and Medusa-on-Llama-3.1 as a cost-optimized fallback. Each component is chosen for the latency-throughput tradeoff appropriate to its task.

## The SpecForge Training Infrastructure

Training high-quality draft models has historically been a barrier to adopting speculative decoding. Pre-trained draft heads are available for popular base models but not for custom fine-tunes.

**SpecForge** (arxiv:2603.18567), released in early 2026, provides an open-source framework for training EAGLE-style draft models with target-draft decoupling, hybrid parallelism, and optimized training kernels. Key result: up to 9.9× faster EAGLE-3 training compared to the reference implementation. Draft models trained with SpecForge achieve up to 4.48× end-to-end inference speedup on SGLang, matching the performance of hand-tuned commercial draft heads.

For organizations building on custom fine-tuned models, SpecForge is the practical path to enabling speculative decoding without depending on third-party draft model availability.

## Design Guidance for Agent Runtimes

For teams building or operating LLM-backed agent runtimes today, the following priorities emerge from the research:

**Enable speculative decoding first.** If you are using vLLM or SGLang with a supported model, enabling EAGLE or P-EAGLE is a configuration-level change that typically yields 1.5–2.5× speedup with no accuracy cost. This should be the first inference optimization evaluated.

**Classify tools by safety for speculative execution.** Read-only tools (search, read file, query database) can execute speculatively on partial predictions. Write tools (send message, commit code, modify state) must wait for confirmed tool call generation. Build this classification into your tool registry.

**Model your agent execution schedule for KV cache management.** Naive LRU eviction causes expensive prefill recomputation during tool waits. If you run more than a handful of concurrent agent sessions, a scheduling-aware KV cache policy will significantly reduce tail latency.

**Use prefix caching for shared agent context.** If multiple agent instances share a system prompt or a large retrieved context, ensure your serving infrastructure uses radix-tree prefix caching and that your prompt construction keeps shared prefixes at the head of the context window. A misplaced instruction that varies per-request will break prefix sharing for everything that follows.

**Plan for disaggregated serving at scale.** Prefill-decode disaggregation requires high-bandwidth interconnect between workers and adds operational complexity. For teams below ~100 QPS it is rarely worth the overhead. Above that threshold, disaggregation can unlock 2–4× better latency for the same hardware budget.

## Conclusion

Speculative decoding has made the transition from research novelty to production standard in under two years. The 2025–2026 expansion of the idea into speculative tool calling, speculative actions, and workflow-aware KV cache management represents the next frontier: applying the same principle of parallel-verify-commit not just at the token level but at the action and workflow levels of the agent execution stack.

For agent runtime developers, these techniques are now accessible without deep infrastructure expertise. P-EAGLE in vLLM, prefix caching in SGLang, and the SpecForge training framework collectively lower the barrier to deployment. The remaining open questions — how to train speculative predictors for custom tool sets, how to coordinate speculation across multi-agent boundaries, how to handle speculative state mutations safely — are active research areas with practical solutions expected within the year.

Agents that think fast enough to feel like thought are not just a user experience improvement. They change what workloads are feasible: a three-second-per-step agent can replace a five-minute workflow; a 300ms-per-step agent can replace a real-time conversation. Inference latency is the moat between what AI agents can do in demos and what they can do in production.

---

*Sources:*
- *[P-EAGLE: Faster LLM inference with Parallel Speculative Decoding in vLLM](https://vllm.ai/blog/2026-03-13-p-eagle)*
- *[Speculative Interaction Agents (arxiv:2605.13360)](https://arxiv.org/html/2605.13360v2)*
- *[Optimizing Agentic Language Model Inference via Speculative Tool Calls (arxiv:2512.15834)](https://arxiv.org/pdf/2512.15834)*
- *[Speculative Actions: A Lossless Framework for Faster Agentic Systems (arxiv:2510.04371)](https://arxiv.org/pdf/2510.04371)*
- *[KVFlow: Efficient Prefix Caching for LLM Multi-Agent Workflows (arxiv:2507.07400)](https://arxiv.org/html/2507.07400v1)*
- *[SpecForge: A Flexible Framework for Speculative Decoding Training (arxiv:2603.18567)](https://arxiv.org/pdf/2603.18567)*
- *[EAGLE-3 Speculative Decoding Guide](https://www.e2enetworks.com/blog/Accelerating_LLM_Inference_with_EAGLE)*
- *[Disaggregated Prefill-Decode Architecture](https://docs.jarvislabs.ai/blog/llm-optimization-disaggregated-prefill-decode)*
- *[LLM Inference Optimization Playbook](https://www.runpod.io/articles/guides/llm-inference-optimization-playbook)*
