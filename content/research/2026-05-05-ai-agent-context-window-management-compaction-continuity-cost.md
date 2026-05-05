---
date: "2026-05-05"
title: "AI Agent Context Window Management: Compaction, Continuity, and Cost Trade-offs"
description: "How persistent AI agents manage finite context windows in production through compaction strategies, session continuity mechanisms, and cache-aware cost engineering."
tags:
  - ai-agents
  - context-window
  - compaction
  - prompt-caching
  - cost-engineering
  - session-continuity
  - observability
---

## Executive Summary

For single-turn chatbots, the context window is a generous buffer that rarely becomes a constraint. For persistent AI agents — systems that run for hours, execute dozens of tool calls, and accumulate state across sessions — the context window is the scarcest runtime resource. A coding agent that reads five files can burn 81% of its context on tool results alone. Performance measurably degrades at 60–70% fill, and by 90% fill, structured tool-call quality deteriorates enough to affect task outcomes.

The 2026 landscape reveals three philosophically distinct approaches to this problem: Claude Code's precision forgetting (three-layer cascade preserving cache prefixes), Codex CLI's handoff memo (all-or-nothing history replacement), and OpenCode's stepped governance (non-destructive hiding before summarization). Each reflects different trade-offs between information preservation, cost efficiency, and operational simplicity. JetBrains Research demonstrates that observation masking — simply hiding old tool results — achieves 52% cost reduction with a 2.6% solve rate improvement, while pure LLM summarization cuts cost similarly but extends runtime by 15% because summaries obscure stopping signals.

The economics are equally consequential. Anthropic's prompt caching makes cache hits 90% cheaper than uncached input, but every compaction event destroys the cached prefix and triggers a full-price re-read. Aligning compaction strategy with cache TTL is not an optimization — it is a first-order cost concern for agents processing thousands of requests daily.

## Context Windows as a Finite Runtime Resource

The distinction between a chatbot and a persistent agent is not merely conversational memory — it is the rate at which context fills. A chatbot exchanges short messages; an agent reads files, executes shell commands, queries databases, and processes API responses. Each tool result is typically 10–50x larger than the user message that triggered it.

In a representative Claude Code coding session, the context breakdown looks roughly like:

- **System prompt + tool definitions**: 8–12K tokens (stable, cacheable)
- **Conversation turns**: 2–5K tokens per exchange
- **Tool results**: 5–50K tokens per file read or command output
- **Accumulated history**: grows linearly with session length

Five file reads can account for over 160K tokens in a 200K context window. The agent is not running out of conversation space — it is running out of working memory for its tools.

### The Degradation Curve

Context pressure does not manifest as a hard wall. Research and production telemetry show a degradation slope:

- **0–60% fill**: Nominal performance. The model has sufficient attention bandwidth for all content.
- **60–70% fill**: Measurable quality decrease begins. Long-range dependencies (referencing a file read from 30 turns ago) become unreliable.
- **70–85% fill**: Structured output quality degrades. JSON formatting errors, incomplete tool calls, and missed instructions increase.
- **85–100% fill**: Critical zone. The model may fail to follow system prompt instructions or produce truncated responses.

This means the effective usable window for a 200K-context agent is closer to 140–160K tokens before quality matters. Gemini's 1M (and experimental 10M) native context defers this problem but does not eliminate it — the degradation curve simply stretches over a larger range, and cost scales linearly with context size regardless of quality.

### Multi-Runtime Context Budgets (2026)

| Runtime | Max Context | Effective Usable | Compaction Strategy |
|---------|------------|-----------------|-------------------|
| Claude Code | 200K (1M available) | ~160K | Three-layer cascade |
| Codex CLI | 128K | ~100K | Single-pass summary |
| Gemini CLI | 1M–10M | ~700K–7M | Context Compression Service (v0.38.0) |
| OpenCode | Model-dependent | Varies | Stepped governance |

## Compaction Strategies: Three Schools of Thought

When context pressure reaches critical levels, the agent must shed tokens. How it chooses what to forget — and what it preserves — defines its operational character.

### Claude Code: Precision Forgetting

Claude Code implements the most sophisticated compaction pipeline in production, operating as a three-layer cascade:

**Layer 1 — Tool Result Trimming**: Before any LLM call, old tool results are replaced with compact placeholders (e.g., `[File content was read but has been trimmed]`). This is a zero-cost operation — no LLM invocation required. It typically recovers 40–60% of consumed context because tool results dominate token usage.

**Layer 2 — Cache-Preserving Tail Trim**: If Layer 1 is insufficient, the system trims from the tail of the conversation while preserving the prefix that anchors the prompt cache. This is the critical economic insight: Anthropic's prompt caching prices cache reads at $0.30/MTok versus $3.00/MTok for uncached input (Sonnet). Preserving the cache prefix means the next request after compaction still benefits from cached pricing on the system prompt and early conversation.

**Layer 3 — Structured LLM Summary**: At approximately 83.5% fill (~167K of 200K), the system generates a structured 9-section summary of the conversation. This fires only when the first two layers cannot free sufficient space. Post-compaction, the system re-reads the 5 most recently referenced files and re-declares tool definitions to restore working context.

The v2.1.128 release (May 2026) fixed a critical bug where 1M-context sessions triggered compaction at incorrect thresholds, and reduced sub-agent cache usage by approximately 3x.

### Codex CLI: The Handoff Memo

Codex takes a philosophically simpler approach. When context pressure triggers compaction, it replaces the entire conversation history with a single LLM-generated summary. All user messages are preserved verbatim; all assistant replies and tool results are discarded.

This approach is clean and predictable — the agent restarts with a fresh working context and a summary of what came before. The trade-off is that it is all-or-nothing: any detail not captured in the summary is permanently lost. There is no Layer 1 equivalent that preserves recent tool results while trimming older ones.

Codex exposes context pressure through `token_count` events in its JSONL rollout log, enabling external monitoring (like the CodexContextMonitor pattern) to trigger preemptive action before compaction fires.

### OpenCode: Stepped Governance

OpenCode introduces a middle path: non-destructive timestamp-based hiding. Old messages are hidden from the context window but remain in the session log and can be recovered. Only when hiding is insufficient does it escalate to LLM summarization.

This is the most developer-friendly approach — nothing is truly deleted, making the compaction process auditable and reversible. The trade-off is implementation complexity and the storage overhead of maintaining the full history alongside the active context.

### Gemini CLI: Async Compression

Gemini CLI added a Context Compression Service in v0.38.0 (April 2026). An open research issue proposes async union-find forest clustering to move compaction off the blocking response path — the most architecturally ambitious approach currently in proposal stage. The idea is that semantic similarity clusters can be pre-computed during idle time, so when compaction is needed, the system already knows which content blocks are redundant.

### Empirical Evidence: Masking Beats Summarization

JetBrains Research (December 2025) tested compaction strategies on SWE-bench with 250-turn agent trajectories:

- **Observation masking** (replacing old tool results with placeholders): 52% cost reduction, 2.6% solve rate improvement
- **Pure LLM summarization**: Similar cost reduction, but 15% longer runtime — summaries obscure the signals that tell an agent when to stop
- **Hybrid** (masking primary, summarization fallback): Saves 7% more than masking alone

The solve rate improvement from masking is counterintuitive but explained by attention mechanics: removing stale tool outputs reduces noise in the attention window, letting the model focus on the current task state.

## Session Continuity Across Context Resets

Compaction is a within-session strategy. But persistent agents face a harder problem: maintaining coherence across session boundaries — whether triggered by compaction, crash recovery, or scheduled restarts.

### Tiered Memory Architecture

Production systems converge on a tiered model that separates memory by volatility and access frequency:

| Tier | Contents | Lifetime | Loading |
|------|----------|----------|---------|
| Hot | Current conversation + tool results | Single session | Always in context |
| Warm | Session log, current task state | Single day | Loaded at session start |
| Cool | Reference docs, decisions, user profiles | Indefinite | Loaded on demand |
| Cold | Historical archives | Indefinite | Searched when needed |

The architectural key: **write important state to files before compaction fires, not after**. Post-compaction context may lack the detail needed to reconstruct what was lost. The warm and cool tiers live in files that are explicitly loaded at session start — they survive any context reset because they were never part of the context that got compacted.

### Subagent Delegation

Background task delegation is the primary mechanism for protecting the main context window from overflow. The pattern:

1. The main agent identifies a heavy workload (multiple web searches, deep code analysis, large file processing)
2. It spawns a subagent with its own isolated context window
3. The subagent does the heavy work — accumulating tool results, searching, iterating
4. It returns a 1,000–2,000 token summary to the parent
5. The parent's context is barely touched; its cache prefix remains intact

This is not just a convenience pattern — it is an economic necessity. A research task that involves 20 web searches might generate 200K tokens of raw results. Running that in the main context would trigger compaction and destroy the cache prefix. Delegating to a subagent keeps the main window clean and the cache warm.

### Handoff Protocols

When an agent must start a fresh session (context too high, crash recovery, daily rotation), the quality of the handoff determines whether work is lost:

1. **Pre-switch checkpoint**: Write current task state, open questions, and next steps to a persistent file
2. **Context snapshot**: Summarize the key decisions and discoveries from the current session
3. **File references**: Record which files were recently read or modified — the new session can re-read them
4. **Pending actions**: List any incomplete operations that need to resume

The new session loads its identity, reads the checkpoint, and continues. The quality gap between "the agent remembers everything" and "the agent re-reads its notes" is narrower than expected, because the notes are structured for machine consumption, not human readability.

### Academic Foundations

ByteRover (arXiv, April 2026) formalizes a 5-tier progressive retrieval system for agent memory:

- **Tiers 0–2**: Hash lookup, BM25 search, simple pattern matching — resolve most queries in under 100ms with zero LLM cost
- **Tiers 3–4**: Semantic search, then full agentic reasoning — expensive but handles novel queries

On the LoCoMo benchmark, this achieves 96.1% accuracy versus 89.9% for the prior state-of-the-art (HonCho). The key insight is that most memory retrievals do not need LLM reasoning — structured file organization and simple search resolve the majority of lookups.

## Cost Engineering: Cache TTL and the Economics of Forgetting

For agents running 24/7, context management is inseparable from cost management. The interaction between compaction and prompt caching creates non-obvious economic dynamics.

### The Prompt Caching Model

Anthropic's prompt caching (the dominant pricing mechanism for Claude-based agents) works as follows:

- **Cache write**: When content is first processed, it is written to cache at 1.25x the normal input price
- **Cache read**: Subsequent requests with the same prefix are read from cache at 0.1x the normal input price — a 90% discount
- **Cache TTL**: Content remains cached for 5 minutes after last use
- **Breakpoints**: Maximum 4 cache breakpoints per request. Minimum cacheable size: 2,048 tokens (Sonnet), 4,096 tokens (Opus/Haiku)

For an agent making requests every 30–60 seconds, the system prompt and tool definitions are cached on the first request and read from cache on every subsequent request. This typically saves 70–85% of input token costs across a session.

### The Compaction-Cache Interaction

Every compaction event destroys the cached prefix. Here is the cascade:

1. Context fills to threshold → compaction fires
2. Conversation history is restructured (summarized, trimmed, or replaced)
3. The new request has a different prefix than the cached version
4. The entire system prompt + tools + new context is re-processed at full price (cache write)
5. Subsequent requests benefit from caching again — until the next compaction

For an agent that compacts every 2 hours, this means roughly 12 cache-miss events per day. At Sonnet pricing ($3.00/MTok input, with ~15K tokens of system prompt + tools), each compaction costs approximately $0.045 in cache write overhead. Across a fleet of agents, this adds up.

### Sleep Interval Alignment

The 5-minute cache TTL creates a critical operational constraint for agents with idle periods:

- **Sleep < 5 minutes**: Cache stays warm. Next request benefits from cached pricing.
- **Sleep = 5 minutes**: Worst case. Pay the cache miss without gaining any benefit from the longer wait.
- **Sleep > 5 minutes**: Cache is cold. Acceptable if the longer wait serves a purpose (waiting for a build, polling a slow process).

The optimal strategy: if you need to wait, either stay under 270 seconds (preserving cache with margin) or commit to a much longer interval (1200+ seconds) where the cache miss is amortized over meaningful wait time. The 5-minute boundary is a dead zone — avoid it.

### Token Budget Planning

For autonomous agents running continuously, monthly token budgets are predictable:

- **Base cost**: System prompt + tools cached, read on every request ≈ negligible after first write
- **Conversation cost**: Scales with interaction frequency and tool result size
- **Compaction overhead**: Number of compaction events × cache rebuild cost
- **Subagent cost**: Each background delegation has its own context lifecycle

The dominant cost driver is typically tool result size, not conversation length. An agent that reads 10 files per task generates 10x the token volume of one that reads 1 file. Strategies that reduce unnecessary file reads (reading specific line ranges instead of full files, caching file contents in warm memory) have outsized cost impact.

## Monitoring and Observability

Context pressure is a leading indicator — by the time compaction fires, the degradation has already affected recent responses. Effective monitoring catches pressure early.

### Key Metrics

| Metric | Source | Alert Threshold |
|--------|--------|----------------|
| Context fill % | API response `usage` field | 60% warn, 75% checkpoint, 85% critical |
| Cache hit rate | `cache_read_input_tokens / total_input` | Below 70% = TTL mismatch |
| Cache creation spike | `cache_creation_input_tokens` week-over-week | >50% increase = possible regression |
| Time to compaction | Derived from fill rate | Predict compaction timing |
| Compaction frequency | Event counter | Increasing trend = growing tool result size |

The Messages API returns `cache_read_input_tokens` and `cache_creation_input_tokens` on every response, making instrumentation trivial. OpenTelemetry spans (`gen_ai.usage.*`) enable integration with standard observability stacks (Prometheus, Grafana, SigNoz).

### Threshold Callbacks

Production agents implement threshold callbacks that trigger before compaction:

- **60% fill**: Log warning. Begin preferring targeted file reads over full-file reads.
- **75% fill**: Write checkpoint to persistent storage. Ensure current task state is recoverable.
- **85% fill**: Compaction imminent. Consider delegating remaining work to a subagent or initiating a session switch.

These callbacks turn compaction from an emergency event into a managed transition.

### Cost Anomaly Detection

Cache hit rate is the canary metric. A sustained drop below 70% indicates one of:

- TTL mismatch (requests spaced too far apart)
- Frequent compaction (context growing too fast)
- System prompt changes (invalidating the cached prefix)
- Upstream TTL regression (provider-side change)

Monitoring `cache_creation_input_tokens` as a percentage of total input tokens provides early warning — a spike in cache creation without a corresponding increase in unique content means the cache is being rebuilt unnecessarily.

## Emerging Patterns

### Hierarchical Context with Retrieval Tiers

The convergence of RAG and context management is producing hybrid architectures where the context window is just the top tier of a multi-level memory system. ByteRover's 5-tier progressive retrieval demonstrates that most agent memory access patterns follow a power law — a small number of facts are accessed frequently (and belong in-context), while the long tail is accessed rarely (and belongs in searchable files or vector stores).

### Context-Aware Model Routing

As context fills, the economics of model selection shift. A fresh context with 20% fill can afford to use a more capable (and expensive) model. A context at 75% fill, where quality is already degrading, might be better served by a cheaper model that will soon be compacted anyway. This creates an optimization surface: route requests to models based on context pressure, not just task complexity.

### Streaming Summarization

Research systems like ReSum and EM-LLM demonstrate theoretically infinite context via periodic summarization — the context is continuously compressed as new content arrives, maintaining a fixed-size window that represents the entire history. In practice, fidelity decreases with each compression cycle, creating an information half-life where details from early in the session are progressively simplified. This is acceptable for conversational agents but problematic for coding agents where early file reads may contain critical details.

### From Window Management to Knowledge Management

The 2026 trend is clear: context window size is no longer the primary competition axis among model providers. The frontier has moved to inference-time scaling, hybrid compression-plus-caching architectures, and memory-augmented systems that treat the context window as a working register rather than the sole storage medium. The agents that perform best are not those with the largest windows, but those that manage their windows most intelligently — knowing what to keep, what to offload, and what to forget.

---

*Sources: Anthropic documentation (prompt caching, Messages API, compaction beta), Claude Code release notes (v2.1.128), JetBrains Research (SWE-bench compaction study, Dec 2025), ByteRover (arXiv, Apr 2026), Gemini CLI v0.38.0 changelog, OpenCode documentation, Codex CLI architecture notes, GitHub community reports on cache behavior.*
