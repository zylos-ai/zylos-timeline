---
date: "2026-04-21"
title: "Agent Context Compaction for Long-Running Sessions: Techniques and Tradeoffs"
description: "A 2026 review of the compaction problem for persistent AI agents: summarization, eviction, retrieval, external memory, and structural techniques — with production tradeoffs, prompt-caching interactions, and recommendations for Zylos-style platforms."
tags: ["ai-agents", "context-engineering", "compaction", "prompt-caching", "memory", "long-running-agents"]
---

## Executive Summary

- **Context compaction is now a first-class platform concern.** Long-running agents accumulate O(N²) token costs with each tool call, suffer from the "lost-in-the-middle" attention deficit, and face hard context-window ceilings (200K–1M tokens). Without deliberate compaction, sessions are both expensive and increasingly unreliable after tens of thousands of tokens.
- **The field has converged on four viable strategies:** provider-native summarization APIs (Anthropic, OpenAI), structured "anchored iterative" compaction with persistent section templates, external memory offload (MemGPT/Letta, Cognee), and retrieval-augmented episodic memory. No single technique dominates; production platforms combine them.
- **Prompt caching and compaction are in fundamental tension.** Compaction is a hard semantic break that invalidates all prior cached prefixes. Mitigation requires stable system-prompt prefixes with cache breakpoints placed before the volatile conversation region, and Anthropic's server-side API (`compact_20260112`) natively places a `cache_control` marker on the compaction block for this reason.
- **Evaluation lags practice significantly.** Benchmarks like [LoCoMo](https://arxiv.org/abs/2402.17753), [LongBench](https://arxiv.org/abs/2308.14508), and RULER measure single-session long-context recall but do not model compaction chains—sequential, lossy compressions over days-long agent runs. Artifact tracking (which files were modified?) is uniformly weak across all production methods, scoring 2.19–2.45/5.0 in [Factory.ai's head-to-head evaluation](https://factory.ai/news/evaluating-compression).
- **For Zylos-style persistent platforms, the practical stack is:** stable system prefix + append-only cache breakpoint → structured compaction at ≈75% threshold → external memory offload for long-lived facts → episodic retrieval for cross-session continuity.

---

## The Compaction Problem

### Why Long Sessions Break

Every API call to a frontier model bills the full conversation history as input tokens. A naive 20-step agent loop where each step produces 1 000 tokens yields 210 000 cumulative input tokens—not the 20 000 a per-step estimate suggests. At Claude Sonnet 4.6 pricing, this O(N²) growth turns a 100-step debugging session into a non-trivial line item; at Opus 4.6 rates the same session can cost two orders of magnitude more than the first call.

Token cost is only one failure mode. In a [2023/2024 paper published in Transactions of the ACL](https://aclanthology.org/2024.tacl-1.9/), Liu et al. demonstrated that model performance peaks when relevant information sits at the very beginning or end of a context, and degrades sharply—by over 30 percentage points on multi-document QA—when the answer document falls in the middle of a 20-document context. The paper coined this the **"lost-in-the-middle"** effect, and it is caused by how Rotary Position Embeddings (RoPE) attenuate mid-sequence attention. This is not a quirk of small models: the effect persists in explicitly long-context models and worsens as the session grows longer.

[Anthropic's own engineering blog on context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) names a third failure mode: **context rot**—the gradual degradation of model behavior as irrelevant tool outputs, outdated intermediate states, and redundant re-reads accumulate. Context rot is insidious because the model does not emit an error; it just silently attends less accurately to the signal buried beneath the noise. A [2025 industry survey](https://medium.com/@moradikor296/the-end-of-infinite-context-engineering-reliability-in-the-age-of-agentic-workflows-9531163159b4) attributed 65% of enterprise AI task failures to context drift or memory loss rather than raw token exhaustion.

The concrete trigger for compaction is the context-window ceiling. Most frontier models in 2025–2026 offer 200K tokens (Claude Sonnet/Opus) or up to 1M (Gemini 2.0). Anthropic's Claude Code auto-compact fires at approximately 98% of the effective window (total context minus reserved output tokens). At 200K tokens this is a hard wall that most multi-hour coding sessions hit.

---

## Techniques Landscape

### Summarization-Based Compaction

**How it works.** The simplest form is a **rolling summary**: at a threshold, a model call summarizes the prior conversation into a compact narrative, which replaces the raw history. Hierarchical variants apply rolling summaries recursively—summarize turns 1–50, then turns 1–100 including the first summary, and so on. Map-reduce applies this in parallel: chunk the history, independently summarize each chunk (map), then combine the partial summaries into a final condensation (reduce). Google Cloud's [Gemini long-document summarization workflow](https://cloud.google.com/blog/products/ai-machine-learning/long-document-summarization-with-workflows-and-gemini-models) implements map-reduce for production document pipelines.

**Strengths.** Summarization is provider-agnostic, easy to implement, and produces human-readable state that can be inspected and debugged. It is the primary mechanism behind Anthropic's `compact_20260112` API and Claude Code's `/compact` command.

**Weaknesses.** Information loss is irreversible. Crucially, Factory.ai's [benchmark of 36 611 production messages](https://factory.ai/news/evaluating-compression) found that all three tested summarization approaches—Factory's own, Anthropic's, and OpenAI's—scored only 2.19–2.45 out of 5.0 on **artifact tracking** (which files were modified). Freeform summaries silently discard precise technical details. The ACON paper ([arxiv:2510.00615](https://arxiv.org/abs/2510.00615)) confirms this: naive summarization baselines ("FIFO," generic prompting) showed severe accuracy degradation on multi-step tasks, while ACON's optimized guidelines were needed to recover comparable task performance.

**Production users.** Anthropic Claude Code, Google ADK, Microsoft Azure AI Agent Framework, LangChain Deep Agents.

---

### Selective Eviction / Token Budgeting

**How it works.** Rather than summarizing, selective eviction identifies which tokens or message blocks to drop entirely. LRU (least-recently-used) eviction drops the oldest tool results first. Importance-scoring variants—common in **KV cache compression** research—rank tokens by their cumulative attention weight (the "heavy hitter" heuristic), L₂ norm of key vectors, or entropy of attention distributions, then retain only the top-K. The [NACL paper (ACL 2024)](https://aclanthology.org/2024.acl-long.428.pdf) combines random eviction with proxy-token attention estimates; [Ada-KV](https://arxiv.org/abs/2407.11550) allocates the KV budget adaptively per attention head.

A higher-level application of the same concept appears in agent frameworks: tool results that are duplicates of prior calls (e.g., re-reading the same file twice) are dropped, keeping only the most recent result. The [Pi dynamic context pruning](https://github.com/complexthings/pi-dynamic-context-pruning) extension for Claude Code deduplicates identical tool outputs and purges error messages that were subsequently resolved.

**Strengths.** Zero information synthesis cost; no additional model call required for eviction. KV-level eviction operates inside inference, reducing memory footprint without API round trips.

**Weaknesses.** Positional gaps and broken reference chains after eviction can confuse models. Importance scoring based on attention is circular: a token that was never retrieved because it was irrelevant in prior turns may be highly relevant to a new sub-task. LRU eviction discards old tool outputs that may be critical (e.g., an early-session architecture decision).

**Production users.** vLLM's automatic prefix caching, SGLang's RadixAttention, Cursor's context window trimming (via third-party extensions).

---

### Retrieval-Augmented (Episodic Memory)

**How it works.** Instead of keeping prior turns in the active context, this approach stores them in an external vector database and retrieves relevant segments on demand. Each conversation turn (or turn-chunk) is embedded and indexed; at each new step, the agent issues a semantic query against the index and injects only the top-K retrieved turns into the prompt. This mirrors how [LoCoMo's](https://arxiv.org/abs/2402.17753) evaluation model works: the benchmark tasks agents with answering questions about 300-turn, 35-session conversations that vastly exceed any context window.

[The February 2025 position paper "Episodic Memory is the Missing Piece for Long-Term LLM Agents"](https://arxiv.org/abs/2502.06975) argues that the single-shot learning property of episodic memory—recording specific past events with their temporal and spatial context—is precisely what current agents lack, and that RAG-over-turns is the closest practical approximation.

**Strengths.** Near-unlimited history depth. Retrieval only pulls what is actually needed, keeping the active context small and precise. Scales to weeks-long sessions without context growth.

**Weaknesses.** Retrieval accuracy is a hard prerequisite: a missed retrieval means a silently forgotten fact. As [Factory.ai's evaluation notes](https://factory.ai/news/evaluating-compression), RAG baselines perform well on factual QA but fail at **preference inference** and **causal chains**—tasks that require implicit reasoning over many dispersed prior turns rather than a single relevant passage. Embedding-based retrieval also adds latency at each agent step and a dependency on a vector store.

**Production users.** Amazon Bedrock AgentCore Memory (Qdrant-backed), Letta's archival memory layer, AWS LangGraph + Redis vector search integrations.

---

### Hybrid: Keep Edges, Summarize the Middle

**How it works.** The most widely deployed production strategy keeps three regions of context intact: (1) the **system prompt** (full, unchanged), (2) the **recent N turns** (verbatim, for coherence), and (3) a **compact summary** that replaces all prior history. Anthropic's server-side API makes this explicit: when compaction fires, it inserts a `compaction` block containing the summary, then on subsequent requests automatically drops all messages prior to that block while preserving the system prompt and the newly appended turns.

[Claude Code auto-compact](https://platform.claude.com/docs/en/build-with-claude/compaction) follows this hybrid pattern. The default trigger is 150 000 input tokens, and the summary prompt instructs the model to write "anything that would be helpful, including state, next steps, learnings." The `pause_after_compaction: true` flag lets integrators inject additional verbatim context (e.g., the 3 most recent tool results) before the session continues.

[Google ADK's compaction](https://adk.dev/context/compaction/) implements an event-count variant: it fires after `compaction_interval` completed workflow events, summarizes a sliding window defined by `overlap_size`, and writes the result back to the session as a new compaction event. Custom summarizer models (Gemini or user-specified) can be plugged in.

**Strengths.** Preserves coherence at the edges (the model always sees the current instruction and recent actions), while controlling growth. Simple to reason about and inspect.

**Weaknesses.** The "middle" summary is a lossy single point of failure. Compaction chains—repeated summarizations over a multi-day session—compound error. Each summary is itself summarized in the next compaction cycle, progressively smoothing out specifics.

**Production users.** Claude Code, Google ADK, Microsoft Azure AI Agent compaction, LangChain Deep Agents autonomous compaction.

---

### External Memory Offload

**How it works.** Rather than compacting conversation history into a summary, the agent continuously writes important facts, decisions, and state into an external memory store—typically structured files, a key-value store, or a knowledge graph—and reads from it explicitly at each step. This is the approach taken by [MemGPT/Letta](https://arxiv.org/abs/2310.08560), which drew inspiration from OS virtual memory: the LLM's context window acts as fast "main memory," while an external store acts as "disk." The agent uses tool calls (`core_memory_replace`, `archival_memory_insert`) to move information in and out of active context.

[Cognee](https://github.com/topoteretes/cognee) extends this with a knowledge graph layer: ingested information is classified, chunked, entity-extracted (subject–relation–object triplets), and committed to a graph database. A `memify` pass then prunes stale nodes, strengthens frequently traversed connections, and adds derived facts. Retrieval combines vector similarity (to find entry nodes) with graph traversal (to collect structured context), providing 14 retrieval modes including chain-of-thought graph traversal. Cognee reports processing over one million pipelines per month in production.

The [Zylos platform](https://zylos.ai) uses a markdown-file approach: structured `memory/` files act as the persistent store, with the agent reading and writing them explicitly. This is simpler to debug and version-control than a vector store, at the cost of requiring the agent to self-organize the taxonomy.

**Strengths.** No compaction chains—facts persist with full fidelity as long as the external store is intact. Supports cross-session continuity natively. Memory can be versioned, audited, and shared across agent instances.

**Weaknesses.** Requires the agent to proactively decide what to write to external memory. Missed writes mean silently lost context. Write latency adds overhead at each significant step. The Letta V1 agent [blog post](https://www.letta.com/blog/letta-v1-agent) documents how the MemGPT heartbeat/`request_heartbeat` control-flow mechanism was necessary to ensure tool chains kept running long enough for writes to happen—a complexity that has partially been absorbed by frontier models' native agentic training.

**Production users.** Letta (MemGPT architecture), Cognee, Zylos, Mem0 (used by AutoGPT, Cursor community extensions).

---

### Structural Techniques

**How it works.** These techniques reduce token count through engineering discipline rather than model calls. Key approaches:

- **Tool result deduplication:** If the same file is read N times, only the most recent read is kept in context. Older identical outputs are replaced with a `[deduplicated: <timestamp>]` marker. The Pi dynamic context pruning extension automates this for Claude Code.
- **Canonicalization:** Tool outputs are normalized to a standard format before being inserted (e.g., JSON → compact-JSON, verbose error stacktraces truncated to the first 20 lines + last 5 lines) to reduce token waste from verbose API responses.
- **Error purging:** Once an error is resolved (subsequent tool call succeeds), prior error messages are removed from context. This can be implemented deterministically without a model call.
- **Extractive token compression (LLMLingua):** [Microsoft's LLMLingua-2](https://arxiv.org/abs/2403.12968) frames compression as a binary token classification task—keep or drop each token—using a fine-tuned BERT-sized encoder trained via GPT-4 distillation. It achieves up to 20× compression with minimal accuracy loss, and is 3–6× faster than generative summarization, with end-to-end latency improvements of 1.6–2.9×. ACON's ablations confirm LLMLingua as a strong extractive baseline but one that underperforms optimized generative summarization on multi-step agentic tasks.

**Strengths.** Zero or near-zero model cost; no additional LLM call required. Predictable, deterministic behavior that is easy to test and debug.

**Weaknesses.** Cannot synthesize across information—only retain or discard existing tokens. LLMLingua-style extractive compression can corrupt syntax in code or structured data if not handled carefully.

---

### Learned Compaction

**How it works.** The most ambitious approach trains a dedicated compression model rather than prompting an LLM to summarize. [ACON's distillation pathway](https://arxiv.org/abs/2510.00615) shows that a GPT-4.1-optimized compression guideline can be distilled into a Qwen3-8B or Phi-4 compressor that retains 95%+ of the teacher's performance at a fraction of the cost and latency. CCF (Context Compression Framework, [arxiv:2509.09199](https://arxiv.org/html/2509.09199v1)) trains lightweight encoders to produce condensed continuous representations from long sequences. Separate work has co-trained a summarizer and a generator to learn a shared compression scheme, staying close to full-context next-token prediction while using an order of magnitude fewer tokens.

**Strengths.** Lower runtime cost and latency than invoking a frontier model for every compaction event. The compressor can be specialized for a domain (code, legal, medical) and trained to preserve task-relevant structure.

**Weaknesses.** Requires curated training data and periodic retraining as the host model changes. A mismatched compressor can produce summaries the downstream model cannot interpret correctly. Not yet widely deployed outside research.

---

## Technique Comparison

| Technique | Token Savings | Info Fidelity | Added Latency | Model Cost | Debuggability |
|---|---|---|---|---|---|
| Rolling summarization | High (95–99%) | Medium | High (extra call) | High | Medium |
| Structured summarization | High (98–99%) | Medium-high | High (extra call) | High | High |
| Selective eviction / LRU | Medium (30–60%) | Medium-low | None | None | Low |
| KV cache eviction | Medium (50–90%) | High | Minimal | None | Very low |
| RAG over turns | Near-unlimited | High (if retrieval works) | Per-step retrieval | Embedding only | Medium |
| External memory offload | Near-unlimited | Very high | Per-step write | Medium | High |
| Structural (dedup, canonicalize) | Low-medium (10–30%) | Perfect | None | None | Very high |
| Extractive (LLMLingua) | Very high (up to 20×) | Medium | Low | Low | Low |
| Learned distilled compressor | High (10–50×) | Medium-high | Low | Low | Low |

---

## Evaluation

### Benchmarks

**[LongBench](https://arxiv.org/abs/2308.14508)** (2023, updated to v2 in 2024) is the foundational bilingual multi-task benchmark for long-context understanding: 21 datasets across single-doc QA, multi-doc QA, summarization, few-shot learning, synthetic tasks, and code completion. Average English context length is ≈6 700 words; LongBench v2 extends to 503 challenging multiple-choice questions with contexts up to 2M words. LongBench is primarily used to measure baseline long-context capability, not compaction quality specifically.

**RULER** extends the Needle-in-a-Haystack (NIAH) paradigm with more varied retrieval and aggregation tasks across different context lengths. It surfaces the performance-cliff behavior of models as context grows beyond their effective attention range.

**[LoCoMo](https://arxiv.org/abs/2402.17753)** (Snap Research, 2024) is the most relevant benchmark for persistent agent evaluation. Fifty multi-session conversations, each averaging 300–600 turns over 19–35 sessions (9K–26K tokens per conversation). Tasks include single-hop and multi-hop factual QA, temporal QA, event summarization, and multi-modal next-turn generation. Findings confirm that models systematically fail at temporal and causal connections across sessions—precisely the failure mode that compaction chains exacerbate. A 2025 extension, [Locomo-Plus](https://arxiv.org/html/2602.10715v1), adds "beyond-factual" cognitive memory tasks.

**Context-Bench** (Letta, October 2025) focuses on chained file operations, cross-project relationship tracing, and multi-step decision consistency—the specific failure modes of compaction chains. It is available as part of the Letta evaluation suite.

### Metrics and Common Pitfalls

[Factory.ai's probe-based framework](https://factory.ai/news/evaluating-compression) offers the most actionable set of metrics for compaction evaluation: six dimensions (accuracy, context awareness, artifact trail, completeness, continuity, instruction following) scored 0–5 using an LLM judge (GPT-5.2). Their critical finding: **compression ratio is a misleading primary metric.** All three tested methods achieved 98–99% compression, yet quality scores differed meaningfully (3.35–3.70) and the technical specificity of preserved information differed dramatically.

Common evaluation pitfalls:
- **Single-session evaluation.** Most benchmarks test one compaction event. Real persistent agents undergo dozens of compaction cycles; compaction chain degradation is not captured.
- **Factual recall over task continuation.** Asking "what was discussed?" is easier than "can you continue the task correctly?"—yet most benchmarks use the former.
- **No artifact tracking.** File modification history, tool call results, and intermediate decisions are the hardest to preserve and the most practically important for coding agents.
- **Static gold labels.** Conversations with predetermined correct answers do not model the open-ended nature of real agent sessions.

---

## Production Tradeoffs

### Latency Spike at Compaction

Compaction requires a full-context inference pass plus the cost of generating a summary. Anthropic's billing documentation shows compaction runs as a separate iteration, billable separately from the main response. For a 150 000-token context window, the compaction call alone can consume 3 000–5 000 output tokens and add 5–15 seconds of wall-clock latency in a streaming session—a visible pause. Google ADK mitigates this by running compaction asynchronously relative to user-facing turns (the `compaction_interval` fires after a turn completes, not during). Anthropic's `pause_after_compaction: true` flag lets integrators absorb this latency gracefully by acknowledging the pause to the user.

### Correctness Loss

[ACON's ablations](https://arxiv.org/html/2510.00615v1) demonstrate that the failure mode is not uniform. On AppWorld (complex multi-step API tasks), naive summarization baselines lost 10–15 percentage points of accuracy versus no-compression upper bounds; ACON recovered to within 1–2%. But on tasks requiring exact artifact recall (which file paths were modified), all methods including ACON fell short. The [Factory.ai benchmark](https://factory.ai/news/evaluating-compression) makes this concrete: after a 178-message debugging session, Anthropic's compaction remembered "401 error on the authentication endpoint" while Factory's structured compaction remembered "/api/auth/login endpoint… stale Redis connection."

### Debuggability

Compaction creates an asymmetric audit trail: the developer can see the current summary but not the raw history it was derived from. Structured compaction (explicit sections for files modified, decisions made, next steps) substantially reduces the opacity compared to freeform narrative summaries. Letta's architecture makes external memory fully inspectable: since memory is stored as structured data outside the model, it can be queried, versioned, and diffed.

### Cost Curve vs. Naive

Without compaction, agentic token costs grow quadratically. With compaction at 80% threshold, costs grow linearly: each compaction resets the history to a summary of ≈1 000–5 000 tokens, and subsequent turns accumulate against that smaller base. In practice, the [Augment Code guide](https://www.augmentcode.com/guides/ai-agent-loop-token-cost-context-constraints) shows that combining prompt caching (90% reduction on stable prefixes) with context compaction (40–60% reduction) yields a net cost curve substantially below linear for sustained sessions.

---

## Prompt Caching Interaction

This is the most underappreciated operational constraint for compaction-enabled platforms.

Prompt caching—Anthropic's 5-minute TTL ephemeral cache and the 1-hour extended cache—requires an **exact byte-for-byte prefix match**. Any modification to early tokens invalidates the cache for all subsequent tokens. Compaction is a **hard semantic break**: the moment a compaction fires and the conversation history is replaced with a summary, the entire prior cached prefix is stale. On the next API call, all tokens must be processed fresh.

Anthropic's [official caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) and the [compaction API specification](https://platform.claude.com/docs/en/build-with-claude/compaction) address this directly. The recommended architecture:

1. **Stable system prompt prefix.** The system prompt (tools, instructions, personality) never changes between turns. A `cache_control: { type: "ephemeral" }` breakpoint is placed at the end of the system prompt.
2. **Append-only conversation history.** New turns are always appended; no prior turns are modified.
3. **Cache breakpoint on the compaction block.** When compaction fires, the API places a `cache_control` marker on the compaction block itself. On subsequent turns, the system prompt and the compaction summary are both served from cache; only the new turns are billed as fresh input.
4. **No dynamic content in the prefix.** Timestamps, session IDs, and user-specific metadata that changes every turn must be placed in the **last** user message, not in the system prompt—otherwise they invalidate the cache every call.

The [arxiv paper "Don't Break the Cache"](https://arxiv.org/html/2601.06007v2) quantifies this empirically: prompt caching yields 41–80% cost savings and 13–31% TTFT improvements across providers, but **naively enabling full-context caching can paradoxically increase latency** by triggering cache writes on dynamic tool results that are never re-used. System-prompt-only caching delivered more consistent benefits across both cost and latency dimensions.

A critical edge case surfaced in early 2026: a [Claude Code bug (v2.1.62)](https://github.com/anthropics/claude-code/issues/29230) increased KV cache hit rates without adding a compaction-event cache invalidation trigger, causing stale pre-compaction prefixes to be served into post-compaction turns. This illustrates that the compaction–caching interaction requires explicit engineering attention at the infrastructure layer.

---

## State of Play at Frontier Labs and Tools (2026)

**Anthropic / Claude Code.** The [`compact_20260112` API](https://platform.claude.com/docs/en/build-with-claude/compaction) (beta as of April 2026) is the most fully specified production compaction interface. It supports configurable thresholds (minimum 50K, default 150K tokens), custom summarization prompts via `instructions`, streaming of compaction blocks, and `pause_after_compaction` for fine-grained control. Claude Code's `/compact` command invokes this directly. Supported models include Claude Sonnet 4.6, Opus 4.6, and the Mythos preview.

**OpenAI / Codex.** [GPT-5.1-Codex-Max and GPT-5.2-Codex](https://openai.com/index/introducing-gpt-5-2-codex/) introduced compaction as a native training objective—"the model is trained to prune its own history while coherently preserving critical context." OpenAI reports internal runs [exceeding 25 hours](https://www.gend.co/blog/gpt-5-1-codex-max-compaction) on complex coding tasks, consuming ≈13M tokens. A separate `/responses/compact` API endpoint is available. Codex memory additionally stores cross-session preferences (preferred libraries, coding style) and surfaces them at session start—a form of external memory offload with automated capture.

**Google ADK.** [Context compaction](https://adk.dev/context/compaction/) ships in ADK Python v1.16.0+, Java v0.2.0+, and TypeScript v0.6.0+. The sliding-window event-count approach with configurable `compaction_interval` and `overlap_size` allows fine-grained control. Custom summarizer models via `LlmEventSummarizer` enable domain-specific compression. ADK's Java 1.0 release (April 2026) elevated compaction to a first-class architecture concern.

**Cursor.** Native Cursor does not persist memory across chat sessions; each conversation starts fresh. The [2025 ecosystem](https://forum.cursor.com/t/persistent-ai-memory-for-cursor/145660) has produced community solutions: Recallium (MCP-based persistent memory), ContextPool (which scans prior sessions and injects relevant context via MCP), and Memory Bank (structured markdown files). Cursor 2.0 fixed memory leaks during long sessions but has not yet shipped built-in compaction. Best practice remains: open a new chat per task to prevent context rot, and commit key decisions to `.cursor/rules/` files.

**Devin (Cognition).** Devin's [long-horizon task handling](https://docs.devin.ai/essential-guidelines/instructing-devin-effectively) relies on structured planning documents and explicit memory saves. A 2025 finding showed Devin entering "context anxiety" mode as it approached limits—generating premature summaries and abandoning tasks. The fix was counterintuitive: allow a larger context window but cap usage programmatically at a lower threshold to prevent the model from seeing its own impending limit.

**LangGraph (LangChain).** [LangGraph's checkpointing system](https://docs.langchain.com/oss/python/langgraph/add-memory) provides thread-level state persistence via PostgresSaver, SqliteSaver, or RedisSaver. Long-term memory is stored in a separate `Store` abstraction (vector-searchable). The [autonomous context compression middleware](https://www.langchain.com/blog/autonomous-context-compression) (Deep Agents SDK) lets the model itself trigger compaction at task boundaries, retaining the 10 most recent messages verbatim and summarizing prior history. Evaluation on Terminal-bench-2 showed agents compress conservatively but accurately when they do.

**MCP (Model Context Protocol).** The [November 2025 MCP specification](https://modelcontextprotocol.io/specification/2025-11-25) adds server-side agent loops, parallel tool calls, and flexible task lifecycle management (working/input_required/completed states). MCP does not specify a compaction mechanism but enables the "call now, fetch later" pattern: a task ID is returned immediately, results are fetched asynchronously—reducing the need to keep pending tool output in the active context window.

---

## Open Problems

**Agent-aware compaction.** Current summarization prompts compress conversation history without awareness of the agent's current tool schema, active goals, or pending sub-tasks. A summary that drops a tool call return value the agent was mid-way through processing can corrupt the agent's internal state silently. The `pause_after_compaction` hook is a workaround but not a solution; the compactor needs access to a structured representation of active goals and pending tool results.

**Compaction chain degradation.** No published benchmark systematically measures accuracy degradation across sequential compaction events. A 7-day session might compact 50–100 times; each compaction is a lossy operation applied to the output of the previous one. The error compounds. This is not a solved problem—it is not even reliably measured.

**Cross-session continuity.** LoCoMo defines the problem space (300-turn, 35-session conversations), but production platforms have only partial solutions. Letta's archival memory, Cognee's knowledge graph, and Zylos's memory files are all file-based approaches that require explicit agent discipline to maintain. Automated cross-session extraction (identifying what from session N should persist to session N+1) remains heuristic.

**Multi-modal context.** As agents use vision (screenshots, diagrams, UI states), image tokens dominate context budgets—a single high-resolution screenshot can consume 1 000–2 000 tokens. [CVPR 2025 work on Progressive Visual Token Compression (PVC)](https://openaccess.thecvf.com/content/CVPR2025/papers/Yang_PVC_Progressive_Visual_Token_Compression_for_Unified_Image_and_Video_CVPR_2025_paper.pdf) and [DyCoke](https://openaccess.thecvf.com/content/CVPR2025/papers/Tao_DyCoke_Dynamic_Compression_of_Tokens_for_Fast_Video_Large_Language_CVPR_2025_paper.pdf) address visual token reduction at the model level, but agent-level compaction strategies for multi-modal histories (summarize the text; downsample or drop the screenshots; preserve key UI states as structured data) are largely unexplored.

**Evaluation of compaction quality.** The [Factory.ai probe-based framework](https://factory.ai/news/evaluating-compression) is the most rigorous published methodology, but it requires large-scale production traces and an LLM judge—neither is accessible to most teams. A standardized open-source evaluation harness for compaction quality across the six dimensions (accuracy, artifact tracking, continuity, etc.) does not yet exist.

---

## Recommendations for Zylos-Style Platforms

The following guidelines apply to any persistent agent platform where sessions span hours to weeks:

1. **Stabilize your system prefix and never vary it between turns.** Tool definitions, personality, core instructions—everything in the system prompt must be byte-for-byte identical across requests. Place a `cache_control` breakpoint at the end of the system prompt. Move timestamps, session IDs, and per-turn metadata into the final user message, not the prefix. This is the single highest-ROI change for cost reduction.

2. **Set compaction threshold at ≈70–75% of the context window, not 95–98%.** Triggering compaction early (at 150K tokens for a 200K window) gives the model adequate output tokens to write a high-quality summary. Triggering at 98% leaves the model context-anxious and produces compressed, incomplete summaries—the "context anxiety" failure Devin documented.

3. **Use structured compaction templates, not freeform summarization.** Require the compaction summary to explicitly populate sections: `## Session Intent`, `## Files Modified` (full paths), `## Key Decisions`, `## Active Goals`, `## Next Steps`. Structured sections act as checklists the compressor must fill or explicitly mark as empty, preventing silent information loss. This is the primary differentiator in Factory.ai's benchmark results.

4. **Offload long-lived facts to external memory on write, not at compaction time.** Architectural decisions, user preferences, environment constants, and project conventions should be written to structured memory files (or a key-value store) as soon as they are established—not extracted from conversation history during compaction. Relying on compaction to capture important context produces fragile, retroactive extraction.

5. **Deduplicate tool results proactively and purge resolved errors.** Before any compaction fires, apply deterministic structural cleanup: drop duplicate file reads (keep only the most recent), remove error messages whose errors have since been resolved, truncate verbose API responses to canonical-length excerpts. This free reduction can cut context by 15–30% with no information loss and no model cost.

6. **Test your compaction pipeline with probe-based evaluation, not ROUGE scores.** Build or adapt the Factory.ai probe methodology: after each compaction event in CI/staging, fire four probe types (recall, artifact, continuation, decision) and score them with an LLM judge. Alert on regressions in artifact tracking score, which is the metric most sensitive to real-world agent failures.

7. **Implement compaction-aware cache invalidation.** Log every compaction event with a session token and timestamp. On each API call, verify that the cached prefix the provider is serving matches the post-compaction system prompt + compaction block, not a pre-compaction prefix. A mismatch (as in the Claude Code v2.1.62 bug) produces subtly corrupted sessions that are hard to detect without explicit monitoring.

8. **Design for compaction chains from day one.** Assume any session over 4 hours will compact 10+ times. This means: (a) external memory must be the source of truth for durable facts, not the compaction summary; (b) active goal state should be explicitly written to a structured `state.md` at each significant milestone, not inferred from history; (c) compaction summary quality should be monitored as a rolling metric over the session lifetime, not just immediately after the first compaction.

---

## References

1. [Liu et al., "Lost in the Middle: How Language Models Use Long Contexts" — TACL 2024](https://aclanthology.org/2024.tacl-1.9/)
2. [Packer et al., "MemGPT: Towards LLMs as Operating Systems" — arXiv 2310.08560](https://arxiv.org/abs/2310.08560)
3. [Kang et al., "ACON: Optimizing Context Compression for Long-Horizon LLM Agents" — arXiv 2510.00615](https://arxiv.org/abs/2510.00615)
4. [Anthropic, "Compaction — Claude API Documentation"](https://platform.claude.com/docs/en/build-with-claude/compaction)
5. [Anthropic, "Prompt Caching — Claude API Documentation"](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
6. [Anthropic, "Effective Context Engineering for AI Agents"](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
7. [Xu et al., "Evaluating Very Long-Term Conversational Memory of LLM Agents" (LoCoMo) — arXiv 2402.17753](https://arxiv.org/abs/2402.17753)
8. [Bai et al., "LongBench: A Bilingual, Multitask Benchmark for Long Context Understanding" — arXiv 2308.14508](https://arxiv.org/abs/2308.14508)
9. [Jiang et al., "LLMLingua-2: Data Distillation for Efficient and Faithful Task-Agnostic Prompt Compression" — arXiv 2403.12968](https://arxiv.org/abs/2403.12968)
10. [Factory.ai, "Evaluating Context Compression for AI Agents"](https://factory.ai/news/evaluating-compression)
11. ["Don't Break the Cache: An Evaluation of Prompt Caching for Long-Horizon Agentic Tasks" — arXiv 2601.06007](https://arxiv.org/html/2601.06007v2)
12. [Pink et al., "Position: Episodic Memory is the Missing Piece for Long-Term LLM Agents" — arXiv 2502.06975](https://arxiv.org/abs/2502.06975)
13. [Google ADK, "Context Compression Documentation"](https://adk.dev/context/compaction/)
14. [LangChain, "Autonomous Context Compression — Deep Agents SDK"](https://www.langchain.com/blog/autonomous-context-compression)
15. [Letta, "Rearchitecting Letta's Agent Loop: Lessons from ReAct, MemGPT, & Claude Code"](https://www.letta.com/blog/letta-v1-agent)
16. [OpenAI, "Introducing GPT-5.2-Codex"](https://openai.com/index/introducing-gpt-5-2-codex/)
17. [Model Context Protocol, "November 2025 Specification"](https://modelcontextprotocol.io/specification/2025-11-25)
