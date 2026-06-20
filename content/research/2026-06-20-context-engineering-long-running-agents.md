---
date: "2026-06-20"
title: "Context Engineering for Long-Running AI Agents"
description: "How production AI agents manage their context windows — from dynamic assembly and compression to multi-tier memory and token budgeting"
tags: ["context-engineering", "ai-agents", "memory", "llm", "prompt-engineering"]
---

## Executive Summary

Context engineering has emerged as the defining discipline of production AI agent development. The term, popularized by Shopify CEO Tobi Lutke and formalized by Andrej Karpathy in mid-2025, describes the practice of dynamically assembling the right information into an LLM's context window at inference time. As Karpathy put it: "Context engineering is the delicate art and science of filling the context window with just the right information for the next step." By mid-2026, Cognition AI (the team behind Devin) states flatly that "context engineering is effectively the #1 job of engineers building AI agents."

The shift from prompt engineering to context engineering reflects a fundamental change in how production systems interact with LLMs. Prompt engineering optimizes a single input-output pair at write time. Context engineering designs dynamic systems that retrieve, compress, assemble, and budget information across multi-turn sessions that may span hours or days. The core insight is that most agent failures are not model failures --- they are context failures. A model that receives the right 50,000 tokens will outperform one drowning in 200,000 tokens of accumulated noise.

This article synthesizes research and production patterns from mid-2025 through mid-2026, drawing on case studies from Claude Code, Devin, Factory AI, and OpenHands, along with academic work including the ACON framework (ICML 2026), JetBrains' SWE-bench compression benchmarks, and AWS AgentCore's managed memory service. The focus is on actionable architecture: how to build context assembly pipelines, when and how to compress, how to structure multi-tier memory, and how to avoid the failure modes that degrade agent performance in production.

For readers who followed our earlier coverage of AI agent memory architecture (January 2026), this article builds on that foundation by examining the runtime mechanics of context management --- the engineering that happens between memory storage and model inference.

## From Prompt Engineering to Context Engineering

The distinction between prompt engineering and context engineering is not semantic. It reflects a shift in what engineers optimize and at what layer of the system.

| Dimension | Prompt Engineering | Context Engineering |
|-----------|-------------------|---------------------|
| Scope | Single input-output pair | Everything the model sees across a multi-turn session |
| Timing | Write-time, static | Runtime, dynamic per request |
| Knowledge source | Encoded in instructions | Retrieved from external systems at query time |
| Core question | "How should I phrase this?" | "What does the model need to know right now?" |
| Bottleneck addressed | Instruction clarity | Information relevance, freshness, and density |
| Scale behavior | Works for demos | Designed for production with many users and long sessions |

Karpathy's OS analogy clarifies the relationship: model weights are the CPU (fixed processing substrate), the context window is RAM (volatile working memory), and prompting is programming (steering computation). The engineer's job is deciding what data to load into working memory at each step, when to evict stale information, and how to organize it so the processor can execute efficiently. An agent that treats context as an append-only log is like a program that never frees memory --- it will crash, or worse, silently degrade.

LangChain's framing captures the hierarchy: prompt engineering is a *component* of context engineering, not the other way around. Getting the phrasing right matters, but it is dominated by the question of whether the right information is present in the first place.

## Dynamic Context Assembly

The most architecturally significant aspect of context engineering is dynamic assembly: the system that decides what goes into the context window before each inference call.

### The Assembly Pipeline

A production context assembly pipeline typically operates in stages:

```
User Input
    |
    v
+---------------------------+
|  Parallel Retrieval        |
|  - Vector search           |
|  - Keyword/grep search     |
|  - Structured DB queries   |
|  - Tool definition lookup  |
+---------------------------+
    |
    v
+---------------------------+
|  Candidate Ranking         |
|  - Relevance scoring       |
|  - Recency weighting       |
|  - Deduplication           |
+---------------------------+
    |
    v
+---------------------------+
|  Memory Layer Integration  |
|  - Conversation history    |
|  - Session summaries       |
|  - Persistent user prefs   |
+---------------------------+
    |
    v
+---------------------------+
|  Token Budget Enforcement  |
|  - Truncate/compress to    |
|    fit budget allocation   |
+---------------------------+
    |
    v
+---------------------------+
|  Context Window            |
|  [System] [Retrieved]      |
|  [History] [User Query]    |
+---------------------------+
```

Sourcegraph's production pipeline (documented March 2026) runs retrieval stages in parallel, merges results into a candidate set, applies a re-ranker to score candidates against a relevance threshold, then integrates memory layers before passing the assembled context to the model.

### The Bill of Lading Architecture

A pattern gaining traction separates *storage* from *loading* through a manifest (or "bill of lading," per Michael Bee's formulation). Each context segment is stored independently, and a manifest controls which segments load for each inference pass. Evicting a segment removes it from the manifest without deleting it from storage --- it remains retrievable if needed later.

This enables a three-tier KV cache for efficient session startup:

1. **Global boot**: System prompt + tool definitions (precomputed once)
2. **User boot**: Preferences + custom instructions (precomputed per user)
3. **Conversation-specific**: Computed fresh per session

New conversations load precomputed layers instantly rather than re-tokenizing thousands of tokens. Combined with provider-level prompt caching APIs (Anthropic and Google both offer these), this architecture significantly reduces both latency and cost for the static portions of context.

### Tool Selection as Context Assembly

One of the most impactful and underappreciated forms of context assembly is tool filtering. Every tool definition consumes context tokens --- a single YNAB transaction tool costs approximately 663 tokens, and a full Playwright MCP server consumes 14,300 tokens constantly, even in sessions where browser automation is never used.

Research from Taskade found that removing irrelevant tools improved accuracy from 80% to 100% while reducing token usage by 40%. More dramatically, a quantized Llama 3.1 8B model failed with 46 tools but succeeded with only 19 tools, despite having sufficient context window capacity. The failure was not about space --- it was about distraction.

Progressive disclosure addresses this: Claude Code's skill system loads only name and description initially (~200 tokens per skill), expanding to full content (~4,000-5,000 tokens) only when invoked. This contrasts with always-on MCP servers that pay the full token cost regardless of usage. LangChain's Bigtool library applies semantic search to tool descriptions, improving tool-use success 3x when managing large tool collections.

## Conversation Compression Strategies

Even with careful assembly, context accumulates. A single `nmap` scan or `sqlmap` result can produce tens of thousands of tokens. An 8-12 tool call research session can generate 40,000+ tokens of raw API responses. Compression is not optional for long-running agents.

### The Three-Layer Cascade

The most effective production pattern is a multi-layer cascade, where each layer activates at increasing pressure thresholds:

**Layer 1 --- Tool Output Compression (always-on):** Truncate tool outputs exceeding a threshold (e.g., 2,000 tokens), write full output to disk, and replace with a file path reference plus a 10-line preview. Zero LLM calls, only disk I/O. This layer alone prevents the most common cause of context blowout: large API responses and file reads.

**Layer 2 --- Input Eviction (at ~85% fill):** Remove large arguments from write-type tool calls after the written content has been persisted to disk or a vector store. Offload inputs exceeding 500 tokens. The 85% threshold leaves headroom for the compression operation itself --- triggering at 95% risks insufficient space for the summarization output before replacement.

**Layer 3 --- LLM Summarization (threshold-triggered):** A single LLM call replaces hundreds of messages with a structured summary. Preserve the most recent 10% of turns verbatim as active working memory. This layer is expensive (one additional inference call) but can compress thousands of tokens into hundreds.

The key insight is that Layers 1 and 2 handle the majority of context pressure without any LLM calls. Layer 3 is the backstop, not the primary mechanism.

### Structured Summarization Formats

When LLM summarization is triggered, structured formats dramatically outperform free-form prose. A seven-field approach has emerged as a practical standard:

```json
{
  "session_intent": "Implementing OAuth2 PKCE flow for the mobile app",
  "progress_so_far": "Created auth module, implemented token exchange, added refresh logic",
  "key_facts": ["Using auth0 as provider", "Token expiry: 3600s", "Refresh token rotation enabled"],
  "artifacts_created": ["src/auth/oauth.ts", "src/auth/token-store.ts"],
  "documents_loaded": ["RFC 7636 (PKCE)", "Auth0 SPA SDK docs"],
  "next_steps": ["Add CSRF state parameter", "Write integration tests"],
  "open_questions": ["Should we support silent refresh via iframe?"]
}
```

Factory AI's evaluation of 36,000 real engineering session messages found that their "anchored iterative" approach --- which incrementally merges new information into a persistent summary with explicit sections for decisions, file modifications, and next steps --- scored highest in blind evaluations (3.70/5 vs. Anthropic's 3.44 and OpenAI's 3.35). The largest gap appeared in accuracy (4.04 vs. 3.43), reflecting superior retention of technical details like file paths and variable names.

A critical finding: all three major approaches scored only 2.19-2.45/5 on artifact trail preservation --- tracking which files were created, modified, or deleted across a session. This remains an active research problem. Dedicated structured state (a manifest of file changes) is needed alongside any compression scheme.

### Summarization Triggering

Production systems vary in when they trigger summarization:

- **Claude Code**: Auto-compact fires at 95% context capacity using recursive hierarchical summarization
- **Threshold-based pipelines**: Layer 2 activates at 85%, Layer 3 at configurable thresholds
- **Turn-based**: OpenHands summarizes every 21 turns while preserving the 10 most recent uncompressed
- **Agent-initiated**: Agents explicitly call a compact function at natural task boundaries (after processing large result sets, between research phases)

JetBrains' benchmarking on SWE-bench Verified (500 instances) found that LLM summarization reduced costs 50%+ vs. raw baselines, but caused 15% trajectory elongation --- agents took more steps to complete tasks, partially offsetting cost savings. Simpler observation masking (replacing old tool outputs with placeholders while preserving action and reasoning structure) achieved 52% cost reduction without trajectory elongation, making it the more cost-effective default.

## Multi-Tier Memory Architecture

Long-running agents need memory that extends beyond the context window. The standard taxonomy that has emerged across production systems separates memory into four tiers:

| Memory Type | Time Horizon | Storage | Retrieval | Latency |
|-------------|-------------|---------|-----------|---------|
| **Working** | Current turn | Context window | Immediate | 0ms |
| **Episodic** | Past sessions | Vector DB / relational DB | Embedding search | 10-200ms |
| **Semantic** | Facts and knowledge | Vector DB / knowledge graph | Hybrid search | 10-600ms |
| **Procedural** | How-to patterns | Files / structured DB | Keyword + tag lookup | <50ms |

### The MemGPT Paging Model

The MemGPT architecture (now the Letta framework) applies the operating system's virtual memory model to LLM context. The context window is RAM --- fast but limited. External storage is disk --- slow but unlimited. The agent has explicit tools to page information in and out:

- **Memory blocks** with labels ("human," "persona," "project"), size limits, and editability flags
- Agent-initiated reads and writes to external storage
- Multiple agents can share memory blocks, enabling collaborative patterns

The key contribution is making memory management an *agent capability* rather than a system-level concern. The agent decides what to remember and what to forget, using the same reasoning that drives its other tool use.

### Retrieval Performance

The choice of retrieval mechanism has significant performance implications:

| Method | Latency | Recall@5 | Best For |
|--------|---------|----------|----------|
| Vector stores (ANN) | 10-50ms | 0.75-0.85 | Broad semantic similarity |
| Graph RAG | 300-600ms | 0.75-0.85 | Complex entity relationships |
| Hybrid (vector + graph) | 200-500ms | +35% precision | Production systems needing both |

Hybrid approaches that combine vector pre-retrieval with graph-based refinement yield approximately 35% precision gains over single-method solutions. Redis's dual-tier architecture (in-memory short-term + vector DB long-term) achieves sub-millisecond access for recent context and semantic caching that reduces inference costs by up to 73% by recognizing semantically equivalent queries.

AWS AgentCore's managed memory service provides a production reference point: 89-94% compression for semantic memory, 95% for summaries, with retrieval latency around 200ms and correctness scores of 70-83% depending on task complexity.

## Token Budget Management

Treating the context window as a finite resource with explicit budget allocation is the hallmark of mature context engineering. The budget framework categorizes token spend into five buckets:

1. **System instructions** (fixed per session, typically 2,000-8,000 tokens)
2. **Tool definitions** (semi-fixed, 200-15,000 tokens depending on tool count)
3. **Retrieved context** (variable, from knowledge base and memory)
4. **Conversation history** (grows over session lifetime)
5. **Response headroom** (reserved for model output)

Research consistently shows that models perform best when context is 30-40% full. Exceeding this threshold introduces context rot --- quality degradation from irrelevant content, even when the window has capacity remaining. The practical implication: a 200,000-token window should target 60,000-80,000 tokens of actual content, not 190,000.

### Budget Enforcement in Practice

Several tools have emerged for programmatic budget control:

- **Tokencap** (Python): Wraps Anthropic/OpenAI clients to track and enforce per-request budgets. Works with LangChain and CrewAI via one-line import
- **TALE framework**: Achieved 68% reduction in token usage with less than 5% accuracy degradation through token-budget-aware reasoning. However, LLMs often exceed specified budgets when constraints are tight --- prompting alone is insufficient for strict enforcement
- **Agent Contracts** (arxiv:2601.08815): Formal framework for resource-bounded autonomous AI with hard token limits

The anti-patterns to avoid are well-documented:

1. **Context stuffing**: Dumping all retrieved documents regardless of relevance (retrieving 10 documents at 500 tokens each = 5,000 tokens before generation begins, yet only 1-2 may be relevant)
2. **Immortal memory**: Never pruning outdated information
3. **Monolithic system prompts**: Prompts exceeding 5,000 tokens that bury critical instructions
4. **Retrieval without re-ranking**: Embedding similarity alone produces too many false positives
5. **Ignoring token economics**: No monitoring, treating context as unlimited

## Real-World Production Patterns

### Claude Code

Claude Code operates with a ~200,000-token window (Sonnet 4.5), though practical usable space is substantially less after system prompts, tool definitions, and MCP server schemas are loaded. Auto-compact fires at 95% capacity using recursive hierarchical summarization. The documented risk: repeated compaction cycles produce "summaries of summaries" where decisions made early in a session fade.

Claude Code's subagent delegation pattern is particularly instructive: a subagent performing code review might consume 52,000 tokens independently while reporting only a structured summary back to the main agent, preserving main context space. The main agent's context sees the *conclusion*, not the *process*.

Claude Sonnet 4.5 has "maintained focus for more than 30 hours on complex, multi-step tasks" (per Anthropic), but this requires active context management throughout --- not passive accumulation.

### Cognition AI (Devin)

Devin's team uses fine-tuned models specifically for summarization to ensure "critical event capture" at agent-agent handoffs. This is notable because it treats summarization as a specialized task deserving its own model, rather than using the general-purpose agent model for compression.

### OpenHands

JetBrains' benchmarking revealed that OpenHands' LLM summarization (21-turn batches, 10 turns preserved verbatim) achieved 50%+ cost reduction but with 15% trajectory elongation. The hybrid approach --- observation masking with occasional LLM summarization --- yielded 7% additional savings over pure masking while maintaining task completion rates.

### Factory AI

Factory AI's anchored iterative summarization scored best in quality evaluations but identified artifact trail preservation as "an unsolved problem" --- all evaluated approaches lost track of which files were created and modified over extended sessions. Their key architectural lesson: "Token optimization requires system-level thinking --- optimize total tokens per task, not per request."

## Failure Modes

Drew Breunig's taxonomy of context failures (June 2025) has become the standard reference. Four failure modes recur across production systems:

### Context Poisoning

A hallucination or error enters the context and is repeatedly referenced in subsequent turns, compounding the original mistake. In Gemini's Pokemon game agent, false game state injected into the goals section caused the agent to pursue impossible objectives indefinitely. The fix: validation gates before context injection, and quarantine zones for potentially hallucinated outputs.

### Context Distraction

Context grows long enough that the model over-focuses on history, neglecting its training. Gemini's context exceeding 100,000 tokens caused the agent to favor repeating past actions from history instead of developing novel strategies. The fix: aggressive pruning and treating context as a curated workspace, not a log.

### Context Confusion

Superfluous content degrades response quality even when the window has capacity. The Llama 3.1 8B example is canonical: failure with 46 tools, success with 19, despite identical context capacity. The failure is attentional, not spatial. The fix: tool gating that exposes only tools relevant to the current task stage.

### Context Clash

New information conflicts with earlier information that remains in context. Multi-turn conversations where early incorrect model outputs persist alongside later corrections cause an average 39% performance drop. The fix: explicit correction markers or context quarantines that separate uncertain information from confirmed facts.

### Compounding Summarization Loss

Recursive summarization --- summaries of summaries --- is a production-specific failure mode. Each compression cycle is lossy, and the losses compound. Critical details that survived the first compression may be dropped in the second. Claude Code's documentation acknowledges this directly: "this compression is lossy and details get dropped." The mitigation is to maintain structured state (file manifests, decision logs) outside the summarization pipeline, ensuring that operationally critical facts are never subject to lossy compression.

## Emerging Techniques

### ACON (ICML 2026)

The ACON framework optimizes compression in natural language space without fine-tuning. It iteratively refines compression guidelines based on failure analysis, achieving 26-54% peak token reduction vs. existing baselines. A particularly compelling finding: smaller models achieved 46% performance gains with ACON compression because reduced context eliminated distracting history. The optimized compressor can be distilled into smaller models with 95% accuracy preservation, lowering runtime overhead.

### MemAgent

MemAgent handles 3.5 million tokens of effective context with under 5% performance degradation through learned compression, extending the practical horizon for extremely long-running agents.

### Latent Space Reasoning

The Huginn model enables internal iterative processing without token consumption --- computation happens in latent space before output. If this approach matures, it could decouple reasoning depth from context window growth, fundamentally changing how agents handle long-horizon tasks.

### Sliding Window with Observation Masking

JetBrains' research established observation masking as the most cost-effective context management strategy for coding agents: keep the latest N turns fully accessible, replace older tool outputs with structured placeholders, and maintain the complete action/reasoning skeleton. This achieved 52% cost reduction with Qwen3-Coder 480B while preserving task completion rates --- superior to pure LLM summarization on a cost-adjusted basis.

## Practical Recommendations

For teams building long-running agents, the research points to a clear hierarchy of interventions:

1. **Start with tool design.** Quiet modes, truncated outputs, and returning only actionable fields extend effective context lifespan 3-4x without any compression infrastructure.

2. **Implement the three-layer cascade.** Layer 1 (tool output truncation) and Layer 2 (input eviction) handle the majority of context pressure without LLM calls. Layer 3 (LLM summarization) is the expensive backstop.

3. **Use structured summaries.** When you compress, use explicit fields (session intent, progress, artifacts, next steps) rather than free-form prose. Maintain artifact manifests separately from summaries.

4. **Gate tool exposure.** Progressive disclosure of tool definitions saves tokens and improves accuracy. Expose only what is relevant to the current task stage.

5. **Budget explicitly.** Target 30-40% context utilization. Reserve capacity for response generation and unexpected tool outputs. Monitor token usage per request, not just per session.

6. **Separate memory tiers.** Working memory (context window), episodic memory (recent sessions), semantic memory (facts), and procedural memory (patterns) each need different storage and retrieval mechanisms.

7. **Validate before injecting.** Context poisoning from hallucinated or stale content is harder to fix than to prevent. Gate all context injection with relevance and freshness checks.

---

*Sources: Andrej Karpathy (X, June 2025); Sourcegraph engineering blog (March 2026); LangChain blog on context engineering; Mem0 engineering blog; Letta/MemGPT documentation; JetBrains Research (December 2025); AWS AgentCore deep dive; Factory AI / ZenML evaluation; ACON paper (ICML 2026, arxiv:2510.00615); Drew Breunig, "How Contexts Fail" (June 2025); Redis developer guide on context window management; Taskade context engineering research; LangMem documentation; "A Survey of Context Engineering for Large Language Models" (arXiv:2507.13334).*
