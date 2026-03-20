---
date: "2026-03-17"
title: "Dynamic Context Assembly and Projection Patterns for LLM Agent Runtimes"
description: "How production AI agent runtimes treat the context window as an ephemeral projection assembled on demand from persistent substrate, and the architectural patterns that make this tractable at scale."
tags:
  - research
  - ai
  - agents
  - architecture
  - context-management
  - rag
  - prompt-caching
---

## Executive Summary

The dominant mental model for LLMs — a stateless function from prompt to completion — breaks down the moment you build a long-running agent. Sessions extend across dozens or hundreds of inference calls. The codebase, user history, tool results, and conversation turns accumulate far beyond any single context window. Passing everything every time is both impossible and economically ruinous.

The solution that has emerged across production agent systems is a clean architectural separation: **persistent substrate** (all state that exists between calls) vs. **ephemeral context window** (what the model actually sees on any given call). The context window is not storage; it is a **projection** — a temporary, purpose-built view assembled from substrate on demand for each inference step.

This article surveys the patterns, tradeoffs, and real-world implementations of dynamic context assembly for agent runtimes, covering retrieval strategies, compression approaches, caching layers, and the cost/latency calculus that governs every design decision.

---

## The Core Problem: Substrate vs. Projection

### Why the Naive Approach Fails

Consider a coding agent that has been working on a large repository for two hours. Its substrate might include:

- The full repository (~500k tokens of source code)
- 40 tool call exchanges (bash commands, file reads, grep outputs)
- System instructions and persona (~2k tokens)
- A task description with acceptance criteria (~500 tokens)

Concatenating all of this into every inference call is not feasible. Even at 200k-token context limits, you would exhaust the window within the first few tool cycles. Cost scales linearly (or worse) with input tokens. Latency increases with prompt length. And critically, the research from Liu et al. (2023) — "Lost in the Middle" — demonstrated that models perform significantly worse when relevant information is buried in the middle of long contexts, with performance degrading substantially as context length grows.

### The Substrate/Projection Abstraction

The solution is to treat the context window like a database view:

```
Persistent Substrate (disk/memory/vector DB)
├── Long-term memory (facts, preferences, past decisions)
├── Session history (tool calls, observations, summaries)
├── Knowledge base (documents, code, reference material)
├── System configuration (instructions, persona, tools)
└── Working state (current task, intermediate results)

            ↓  Context Assembly Engine  ↓

Ephemeral Projection (context window, ~8k–128k tokens)
├── System prompt (fixed role + task-relevant instructions)
├── Relevant knowledge (retrieved, not bulk-dumped)
├── Recent history (last N turns or summarized)
└── Current observation (most recent tool result / user message)
```

The assembly engine is the critical piece. It decides what makes it into the projection for each inference call, and that decision determines both quality and cost.

---

## Context Assembly Strategies

### 1. Sliding Window

The simplest approach: keep the most recent N turns in context and drop older ones. This works well for conversational agents with short tasks.

```python
def assemble_context(history: list[Turn], window_size: int = 20) -> list[Turn]:
    system = history[0]  # Always keep system prompt
    recent = history[-window_size:]
    return [system] + recent
```

**Tradeoffs:**
- Simple to implement, zero retrieval latency
- Loses early context completely — dangerous if early decisions remain relevant
- No semantic awareness; may drop critical observations just because they are old
- Works well for short, continuous tasks; breaks for long multi-day sessions

### 2. Retrieval-Augmented Context (RAC)

Embed all history and knowledge into a vector store. At each inference step, embed the current query or task state and retrieve the top-K semantically relevant chunks.

```python
async def assemble_context(
    task_state: str,
    vector_store: VectorDB,
    top_k: int = 10,
    token_budget: int = 8000,
) -> list[Chunk]:
    query_embedding = await embed(task_state)
    candidates = vector_store.search(query_embedding, top_k=top_k * 3)

    # Pack chunks greedily within token budget
    selected = []
    used_tokens = 0
    for chunk in rerank(candidates, query=task_state):
        if used_tokens + chunk.token_count <= token_budget:
            selected.append(chunk)
            used_tokens += chunk.token_count
    return selected
```

This is the pattern used by Cursor and similar code intelligence tools when surfacing relevant file sections for each edit. The codebase is indexed once; each LLM call receives only the semantically relevant portions.

**Tradeoffs:**
- Scales to arbitrarily large substrates
- Retrieval adds latency (typically 20–100ms for well-tuned FAISS/HNSW indices)
- Recall is imperfect — you can miss crucial context if the query embedding doesn't capture it
- Re-ranking improves precision but adds further latency
- Cold-start: first indexing of a large codebase is expensive

### 3. Hierarchical Summarization

Instead of dropping or retrieving history, compress it progressively. Older sections get summarized; summaries replace raw content in the context window.

```
Raw history:   [T1][T2][T3][T4][T5][T6][T7][T8][T9][T10]
After 1 pass:  [S1-3]          [T4][T5][T6][T7][T8][T9][T10]
After 2 pass:  [S1-6]                        [T7][T8][T9][T10]
```

AWS Bedrock Agents implement this pattern: at session end, the full conversation is compressed into a summary by calling the foundation model with a summarization prompt. Subsequent sessions load the compressed summary rather than the full transcript.

**Tradeoffs:**
- Information is lossy — summarization discards detail
- Summarization itself costs tokens (an LLM call to compress history)
- Maintains temporal coherence better than retrieval alone
- Good for session-to-session continuity; less useful within a single long task

### 4. Hybrid: Pinned + Retrieved

The pattern used by the most sophisticated production systems combines a pinned region (stable, always included) with a dynamic retrieved region:

```
Context Window Layout:
┌─────────────────────────────┐  ← cache boundary
│ PINNED (stable, cached)     │
│  - System instructions      │
│  - Tool definitions         │
│  - Persona / constraints    │
├─────────────────────────────┤  ← cache boundary
│ SESSION SUMMARY (static)    │
│  - Compressed prior work    │
│  - Key decisions made       │
├─────────────────────────────┤
│ RETRIEVED (dynamic)         │
│  - Relevant code sections   │
│  - Related past tool calls  │
│  - Background knowledge     │
├─────────────────────────────┤
│ RECENT RAW (last N turns)   │
│  - Uncompressed recent work │
│  - Current observation      │
└─────────────────────────────┘
```

The pinned region is designed to hit the prompt cache on every call. The retrieved region changes per call. This is the architecture that makes long-running coding agents economically viable.

---

## The "Lost in the Middle" Problem

Any context assembly strategy must account for the positional sensitivity of transformer attention. Liu et al. (2023) demonstrated that retrieval tasks show degraded performance when the relevant document appears in the middle of a long context. Performance is highest when relevant content appears at the beginning or end.

This has concrete implications for context layout:

1. **Put the most critical information first or last**, not in the middle of a long retrieved section.
2. **Use short retrieved chunks** rather than long documents — the relevant sentence buried in a 2000-token block will be harder to attend to than that same sentence as a standalone 50-token chunk.
3. **Interleave rather than batch** retrieved context when multiple sources are needed — rather than dumping source A then source B, interleave them in order of decreasing relevance.
4. **Structural markers** (XML tags, section headers) help the model locate information within a large context.

---

## Prompt Caching and the KV Cache Layer

Context assembly does not happen in isolation from the inference infrastructure. The KV (key-value) cache baked into transformer inference creates a strong economic incentive to stabilize the beginning of the context window.

### How Prompt Caching Works

Both Anthropic (Claude) and Google (Gemini) expose explicit prompt caching APIs. The mechanism:

1. The first time a prompt prefix is processed, the KV representations are stored server-side.
2. Subsequent requests sharing that prefix skip recomputation — the cached KV state is loaded directly.
3. This yields roughly **90% cost reduction** on cached tokens and meaningful latency improvements.

Anthropic's cache pricing for Claude Sonnet 4.6:
- Standard input: $3.00/MTok
- Cache write: $3.75/MTok (1.25x)
- Cache read: $0.30/MTok (0.1x)

At 10x reuse of a 100k-token system prompt, this represents approximately 78% total cost reduction on that portion of the prompt.

Gemini 2.5 Flash offers implicit caching (automatic, no code changes) plus explicit caching with a 1-hour default TTL and 1,024-token minimum.

### Cache-Aware Context Layout

The prefix ordering required for cache hits creates a strong convention for context layout:

```
1. Tool definitions         ← rarely change; cache across all calls
2. System instructions      ← change per deployment; cache per session
3. Static documents         ← change per task; cache per task
4. Conversation history     ← grows each turn; cache what exists, append new
5. Current observation      ← always new; never cached
```

The assembly engine must design layouts such that stable content precedes dynamic content. Any change to an earlier block invalidates all subsequent cache entries. Tool definition changes are particularly expensive — they cascade through all three downstream cache layers.

Anthropic's caching supports up to four concurrent cache breakpoints per request, enabling fine-grained control:

```python
messages.create(
    tools=[..., {"cache_control": {"type": "ephemeral"}}],  # Breakpoint 1
    system=[
        {"type": "text", "text": instructions},
        {"type": "text", "text": large_doc, "cache_control": {"type": "ephemeral"}},  # Breakpoint 2
    ],
    messages=conversation,  # Automatic rolling breakpoint
    cache_control={"type": "ephemeral"}  # Top-level: Breakpoint 3
)
```

### Interaction with Context Assembly

The cache layer effectively penalizes dynamic context that appears early in the prompt. If your assembly engine inserts a freshly-retrieved chunk at position 2 (right after the system prompt), every single call will incur a cache miss on everything after that point, even if the rest of the context is identical.

This means retrieval-augmented context should go **after** stable content, even if it is conceptually "background knowledge." The assembly engine needs to be aware of cache topology, not just semantic relevance.

---

## Real-World Implementations

### Claude Code

Claude Code, Anthropic's agentic coding tool, manages context explicitly through CLAUDE.md files — Markdown documents that are loaded at session start and remain stable across all inference calls within a session. This is a direct implementation of the pinned region pattern: project conventions, coding standards, and architectural decisions are loaded once and kept at the start of the context window where they will hit the cache on every subsequent call.

For the working session, Claude Code uses a combination of:
- Direct file reads (tool calls that fetch specific files on demand)
- The sliding window of recent tool exchanges
- Auto-memory: extracted learnings written back to CLAUDE.md asynchronously

This is a pragmatic hybrid: the agent reads what it needs through tool calls (on-demand retrieval), maintains a window of recent work, and uses the CLAUDE.md substrate for anything that needs to persist.

### Cursor (AI Code Editor)

Cursor indexes the codebase using embeddings and retrieves relevant code chunks at each step. The architecture is similar to RAC: a large codebase substrate (potentially hundreds of thousands of tokens) is projected down to the relevant files and sections for each specific edit operation.

The key insight from code intelligence use cases is that **file-level granularity is often wrong** — the unit of retrieval should be function or class bodies, not entire files. This yields better precision and tighter token budgets.

### Generative Agents (Stanford Research)

The 2023 Generative Agents paper (Park et al.) demonstrated a full substrate/projection architecture for social simulation agents. Each agent maintained:

- An **experience stream** — a time-ordered log of observations in natural language
- **Higher-level reflections** — LLM-synthesized summaries of patterns in the experience stream
- **Retrieval scoring** that combined recency, importance, and relevance to surface what to project into each planning call

The retrieval function ranked memories by a weighted sum:

```
score = α * recency + β * importance + γ * relevance
```

Where recency decayed exponentially, importance was scored by asking the LLM "how important is this memory on a scale of 1-10?", and relevance was cosine similarity to the current query.

This tripartite scoring is one of the more sophisticated context assembly heuristics published — it directly addresses the failure mode where naive recency-based windows miss crucial older events.

### AWS Bedrock Agents

AWS Bedrock Agents implements session-level hierarchical summarization. When a session ends, the foundation model compresses the full conversation into a summary using a configurable prompt template. Subsequent invocations with the same `memoryId` load this summary rather than the raw history, with cross-session retention up to 365 days.

The separation between `sessionId` (current conversation) and `memoryId` (user-level persistent identity) provides a clean multi-session, multi-user model: each agent has a substrate keyed by user identity, and each inference call receives a projection assembled from that user's historical summaries plus the current session.

---

## Cost and Latency Tradeoffs

| Strategy | Assembly Latency | Per-Call Token Cost | Information Fidelity | Implementation Complexity |
|----------|-----------------|--------------------|--------------------|--------------------------|
| Sliding Window | ~0ms | Low (small window) | Poor (loses old context) | Low |
| Full History | ~0ms | High (grows unbounded) | High | Low |
| RAC (vector retrieval) | 20–100ms | Medium (fixed budget) | Medium (recall ~85–95%) | High |
| Hierarchical Summarization | Async (at session end) | Low (compressed) | Medium (lossy) | Medium |
| Hybrid Pinned+Retrieved | 20–100ms | Low-Medium | High | High |

The economic argument for sophisticated assembly is compelling. A naive agent that dumps 100k tokens of history into every call at $3/MTok on Claude Sonnet 4.6 spends $0.30 per call on history alone. At 100 calls per task, that is $30 in input costs. With a hybrid approach that keeps 8k tokens of compressed history + 8k retrieved context, the same 100 calls cost approximately $2.40 — a 12.5x reduction, before prompt caching multipliers.

### Assembly Latency Budget

For interactive agents, retrieval latency matters. Rough benchmarks for a 1M-token codebase:

- FAISS flat index: ~5ms (exact, memory-intensive)
- FAISS HNSW: ~2ms (approximate, 95% recall)
- Pinecone/Weaviate (serverless): ~30–80ms
- Full BM25 keyword search: ~10ms
- Hybrid dense+sparse (reciprocal rank fusion): ~40–120ms

For non-interactive background agents, 100ms assembly latency is irrelevant against a 5–30 second LLM call. For chat-latency-sensitive applications, retrieval should be parallelized with any fixed-latency operations (authentication, logging, etc.).

---

## Architectural Recommendations

### Principle 1: Separate Concerns Explicitly

Design your substrate and projection layers with explicit interfaces. The assembly engine should be a first-class component, not scattered logic across prompt construction code.

```python
class ContextAssembler:
    def __init__(self, substrate: Substrate, budget: TokenBudget):
        self.substrate = substrate
        self.budget = budget

    async def assemble(self, current_observation: str) -> Context:
        pinned = await self.substrate.get_pinned()        # Tools, system prompt
        summary = await self.substrate.get_summary()      # Session history
        retrieved = await self.substrate.retrieve(        # Semantic search
            query=current_observation,
            budget=self.budget.dynamic_region
        )
        recent = await self.substrate.get_recent(n=10)    # Last N turns
        return Context(pinned, summary, retrieved, recent, current_observation)
```

### Principle 2: Design for Cache Topology

Structure your context layout so the most stable content appears first. Apply cache breakpoints at natural stability boundaries (tools, system prompt, static documents, dynamic content). This single change can reduce per-call input costs by 60–80% for long-running agents.

### Principle 3: Make the Budget Explicit

Rather than accumulating context until you hit the limit, work within a declared budget from the start. Allocate token budgets to each region and have the assembly engine enforce them. This makes cost predictable and prevents the gradual degradation that occurs as context grows.

### Principle 4: Prefer Chunk-Level Retrieval Over File-Level

When indexing large corpora (codebases, documentation), chunk at the semantic unit level (function, class, section) rather than the file level. Smaller chunks mean tighter token budgets and higher relevance scores. Functions of 20–200 lines indexed individually outperform files of 2000 lines treated as single chunks.

### Principle 5: Track Cache Performance in Production

Log `cache_creation_input_tokens` and `cache_read_input_tokens` from API responses. Cache hit rate below 70% on the stable region signals a layout problem — likely that dynamic content is polluting the stable prefix. This metric should be in your agent runtime's observability dashboard.

---

## The "Prompt is a View" Principle

Taken together, these patterns crystallize into a single principle: **the prompt is a view, not storage.**

The same principle underlies relational databases (views are computed from tables, not stored as truth), operating systems (process address space is a projection of physical memory), and reactive UI frameworks (rendered output is derived from state, not stored directly). The LLM agent context window is the latest instance of this recurring pattern.

The substrate is the source of truth. The context window is a materialized view assembled on demand for the specific operation at hand. The assembly engine is the query planner — it optimizes what to include given the constraints of the context budget, the retrieval cost, and the caching topology.

This framing makes it easier to reason about correctness (does the projection include everything the model needs to reason correctly about this step?), cost (is the projection minimal?), and performance (is the stable prefix maximally cached?). It also makes it easier to debug agent failures: when an agent makes a wrong decision, the first question to ask is "what was missing from the projection for that inference call?"

---

## Further Reading

- Liu, N.F., et al. (2023). "Lost in the Middle: How Language Models Use Long Contexts." *arXiv:2307.03172*. Key empirical work on positional attention bias in long contexts.
- Park, J.S., et al. (2023). "Generative Agents: Interactive Simulacra of Human Behavior." *arXiv:2304.03442*. Architecture reference for memory retrieval scoring in agents.
- Weng, L. (2023). "LLM Powered Autonomous Agents." *Lil'Log*. Comprehensive survey of memory types and retrieval patterns in early agent architectures.
- Anthropic. (2026). "Prompt Caching Guide." *platform.claude.com*. Full technical reference for cache breakpoints, pricing, and multi-breakpoint strategies.
- Google DeepMind. (2025). "Gemini API Context Caching." *ai.google.dev/gemini-api/docs/caching*. Gemini's implicit and explicit caching with TTL and model-specific minimums.
- AWS. (2025). "Memory for Amazon Bedrock Agents." *docs.aws.amazon.com/bedrock*. Production implementation of session summarization and cross-session memory.

---

*Research conducted 2026-03-17. Pricing figures current as of research date.*
