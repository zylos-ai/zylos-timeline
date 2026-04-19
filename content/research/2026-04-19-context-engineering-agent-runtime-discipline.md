---
date: "2026-04-19"
title: "Context Engineering: The Runtime Discipline Behind Production AI Agents"
description: "How leading teams manage, compress, and architect context windows to keep long-running agents coherent and cost-efficient"
tags: ["context-engineering", "agents", "context-window", "memory", "production"]
---

## Executive Summary

As AI agents move into long-running, multi-step production deployments, context window management has emerged as a first-class engineering discipline. The naive approach — appending everything to the message history — fails in two distinct ways: the window overflows, or it fills with enough noise to degrade model quality well before the limit is reached. Researchers call this second failure mode "context rot," and in 2025 studies across 18 frontier models, every single one showed measurable performance decline as input length grew.

The field has responded with a layered set of techniques: proactive compression algorithms like ACON that reduce peak token usage 26–54% without parameter updates, provider-native compaction APIs from Anthropic that automatically summarize aging context, structured memory architectures that keep canonical facts outside the window until needed, and multi-agent patterns that isolate subagent contexts so each actor always operates in a clean window. Together these represent a shift from "build a bigger context window" to "build smarter context discipline."

This article synthesizes findings from academic research, production case studies at Slack and Factory.ai, Anthropic's engineering blog, and the emerging field of commercial context engineering to present a comprehensive playbook for managing context in long-running agents.

---

## The Problem: Context Rot and Attention Dilution

The fundamental assumption many teams make when building their first agent is that more context is better — include every prior turn, every tool result, every file read, and the model will have maximum information to work with. Production data has decisively refuted this.

Chroma's 2025 research tested 18 frontier models including GPT-4.1, Claude Opus 4, and Gemini 2.5 Pro using controlled degradation benchmarks. Every single model performed worse as input length increased — some steeply. Models that held at 95% accuracy on short contexts nosedived to 60% accuracy once input crossed certain token thresholds. The degradation is not a hard cliff but a gradient, starting well before context limits are reached.

Three architectural mechanisms drive this:

**Lost-in-the-middle effect.** Transformer attention creates a U-shaped recall pattern: models attend well to tokens at the beginning and end of context, and poorly to the middle. In multi-document QA benchmarks, placing the relevant document in positions 5–15 (out of 20) caused accuracy drops of more than 30% compared to position 1 or 20. The effect inverts when the context is more than 50% full — at that point, the model favors recency over position, but middle content remains disadvantaged throughout.

**Attention dilution.** Transformer attention is quadratic in complexity. At 100,000 tokens, the model processes 10 billion pairwise relationships. As the denominator grows, individual token attention weights shrink, raising the noise floor. Each new token added to context marginally reduces the signal strength of every other token.

**Distractor interference.** Semantically similar but irrelevant content actively misleads models. Chroma's 2025 experiments found that logically coherent distractors performed worse than shuffled text across all 18 models tested — coherence makes distractors more confusing, not less. This has concrete implications for coding agents: when an agent greps for a function name and returns eight files, the relevant code in file four sits in the model's attention blind spot, surrounded by plausible but wrong alternatives.

The result is a phenomenon Anthropic terms "context rot" and Redis defines operationally as the gradual degradation of response quality as irrelevant history crowds the context window. Nearly 65% of enterprise AI failures in 2025 were attributed to context drift or memory loss during multi-step reasoning — not raw token exhaustion. The practical implication: context size must be actively managed, not passively accumulated.

---

## Compression Strategies: Keeping Tokens High-Signal

When context accumulates faster than it can be discarded, compression is the primary mitigation. The field has developed several approaches with meaningfully different fidelity-efficiency tradeoffs.

### Anchored Iterative Summarization

Factory.ai evaluated three major summarization approaches across 36,000 real engineering session messages, rating them on accuracy, completeness, and continuity. Their anchored iterative summarization achieved the highest overall quality score (3.70/5.0) compared to Anthropic's approach (3.44) and OpenAI's (3.35). The largest gap appeared in accuracy (4.04 vs. 3.43), reflecting superior retention of technical details like file paths, variable names, and line numbers.

The key insight: structure prevents information loss. Rather than summarizing context as free-form prose, the Factory method dedicates explicit sections to decisions made, files modified, and next steps planned. This ensures that the most operationally important artifacts survive compression intact.

A critical weakness all three methods shared was artifact tracking — maintaining awareness of which files had been modified and to what state across extended sessions. All methods scored 2.19–2.45/5.0 on this dimension, revealing a gap that general summarization cannot close. Dedicated structured state (a manifest of file changes) is needed alongside any compression scheme.

### ACON: Optimization-Based Compression

The ACON (Agent Context Optimization) framework, published in late 2025, reframes compression as an optimization problem: given paired trajectories where full context succeeds but compressed context fails, capable LLMs analyze the failure causes and update compression guidelines accordingly. This gradient-free approach requires no parameter updates and works with any API-accessible model.

ACON compresses two distinct context types:

- **History compression**: Summarizes interaction trajectories when they exceed a length threshold
- **Observation compression**: Condenses environment outputs (tool results, file reads, API responses) with access to prior history for grounding

Results across three long-horizon agent benchmarks (AppWorld, OfficeBench, Multi-objective QA) show 26–54% peak token reduction while maintaining task accuracy — and in some cases exceeding baseline performance when irrelevant history was actively removed. A particularly compelling finding: ACON-compressed contexts help smaller models (Qwen3-14B) approach larger model performance, with 32% and 46% performance gains on AppWorld and Multi-objective QA respectively. Well-compressed context reduces cognitive load from distracting history, effectively lending smaller models the focus of a much larger model.

The framework also enables distillation: the optimized compressor (typically a large model like GPT-4.1) can be distilled into smaller models with 95% accuracy preservation, lowering runtime overhead.

### Verbatim Compaction vs. Lossy Summarization

Morph's FlashCompact analysis identifies a fundamental tradeoff: summarization achieves 70–90% token reduction but introduces paraphrasing risk that can corrupt precise technical content (line numbers, exact error messages, variable names). Verbatim compaction — preserving selected tokens exactly while discarding the rest — achieves 50–70% reduction with zero hallucination risk.

The FlashCompact team argues for a "prevention over compression" thesis: rather than compressing after context fills, eliminate waste at the source. Their targeted search tool returns snippets rather than entire files; their diff tool emits minimal edits rather than full rewrites. These changes extend effective context lifespan 3–4x without any information loss.

This prevention approach is underutilized in practice. Most teams add compression pipelines rather than revisiting tool design. Reviewing whether tools return the minimum necessary information — building quiet modes, post-processing API responses to extract only actionable fields — often yields more benefit than a sophisticated compression algorithm.

---

## Provider-Native Compaction: Anthropic's Approach

Anthropic shipped production-ready context compaction as an API beta feature (header `compact-2026-01-12`) available on Claude Sonnet 4.6, Opus 4.6, Opus 4.7, and Mythos Preview. The feature operates server-side, automatically summarizing older conversation context when input tokens approach a configured trigger threshold, replacing accumulated history with a structured `compaction` block.

The API exposes several configuration axes:

**Trigger threshold**: Default 150,000 tokens, configurable down to 50,000. Tuning this lower gives more frequent but smaller compaction events; higher values batch context reduction but risk degradation before triggering.

**Pause-after-compaction**: Setting `pause_after_compaction: true` allows the caller to inspect or augment the summary before the conversation continues — useful for injecting domain-specific state that the model's generic summarizer might drop.

**Custom instructions**: The default summarization prompt can be replaced entirely, enabling domain-specific preservation rules. A coding agent might specify: "Preserve all file paths, function signatures, error messages, and architectural decisions. Discard intermediate reasoning that reached a dead end."

**Integration with prompt caching**: Compaction blocks can be cache-controlled separately. Since the compaction block replaces old message history on subsequent calls, it becomes the stable prefix that benefits most from caching. Adding `cache_control: {type: "ephemeral"}` to the compaction block and system prompt together captures most cacheable content.

A critical operational detail: top-level `input_tokens` and `output_tokens` in usage reporting do not include the compaction iteration. Callers must sum all entries in the `iterations` array to compute actual tokens billed. Compaction itself consumes tokens (an additional sampling step), so the total cost is: compaction input + compaction output + subsequent message tokens. In practice, for long sessions this remains well below the alternative of full context at each turn.

Claude Code itself uses compaction in production, combining it with two complementary memory systems for cross-session persistence. This layered approach — compaction for within-session management, external memory for across-session continuity — represents the current reference architecture.

---

## External Memory: What Lives Outside the Window

Compression manages what's in the context window. External memory defines what never enters it until actively retrieved. The distinction matters architecturally: compression is reactive (context grows, then gets shrunk), while external memory is preventive (most information never enters context unless the agent explicitly fetches it).

### The Memory Taxonomy

The 2026 State of AI Agent Memory report from Mem0 describes a stabilizing taxonomy used across production deployments:

- **Episodic memory**: Records of past interactions and events, queryable for "what happened when X"
- **Semantic memory**: Extracted facts and relationships (user preferences, domain knowledge, project state)
- **Procedural memory**: How things should be done — workflows, patterns, agent skills
- **Working memory**: The active context window, containing what the agent is currently processing

Production systems that treat these as a single undifferentiated blob reliably hit operational problems. Episodic records from three months ago contaminate current reasoning. User preferences overridden in a specific session persist as permanent policy. Slack's engineering team, building on their three-channel architecture (Director's Journal for working decisions, Critic's Review for evidence quality scores, Critic's Timeline for consolidated findings), explicitly states their design principle: "We do not pass any message history forward between agent invocations." Each agent invocation receives only the structured summaries relevant to its specific role.

### RAG vs. Stateful Agent Memory

A meaningful architectural distinction has emerged in 2025–2026: RAG is stateless retrieval — it fetches relevant document chunks at query time and forgets everything when the session ends. Stateful memory is persistent, cross-session, and models what the agent has learned rather than what documents say.

The Mem0 benchmark reveals the production tradeoff quantitatively. Full-context approaches achieve 72.9% accuracy but require 17-second response times and 26,000 tokens per conversation. Selective memory retrieval (Mem0's approach) trades 6 percentage points of accuracy for 91% lower latency and 90% fewer tokens — production-viable where full-context is not. Graph-enhanced memory (Mem0g) partially closes that accuracy gap by modeling entity relationships, which recently moved from experimental to production status.

VentureBeat's "observational memory" approach — passively mining agent trajectories for reusable facts rather than explicit writes — achieves 10x cost reduction versus RAG while outperforming on long-context benchmarks. This suggests that the extraction pattern matters as much as the storage pattern: agents that continuously observe and distill rather than retrospectively summarize build higher-quality memory over time.

### The Promotion Problem

Jeremy Daly's analysis of commercial agent deployments identifies memory promotion — elevating session-level observations to durable storage — as the highest-risk operation in agent architecture. His rules reflect hard-won production lessons:

- Session → User scope: allowed for preferences and drafts
- Session → Tenant scope: allowed only for verified facts and approved episodes
- Session → Global scope: never at runtime

Without these gates, two failures compound over time. **Silent guardrail drift**: as session histories expand, tenant-level policy instructions get crowded out of the working set by accumulated content. **Precedent poisoning**: exceptions made for a specific case persist as permanent policy because no governance process separates ephemeral overrides from deliberate rule changes.

The Slack engineering team describes an analogous failure mode they've named "confirmation bias injection" — if a subagent receives too much history, it anchors to prior conclusions rather than reasoning fresh from current evidence. Their solution is aggressive scoping: each agent's information view is tailored specifically to its role, explicitly limited to prevent over-anchoring.

---

## Multi-Agent Context Architecture

Multi-agent systems multiply every context management surface by the number of active agents. The patterns that work at single-agent scale must be enforced at boundaries, and new failure modes emerge at boundaries themselves.

### Isolated Context as a Design Primitive

The dominant pattern in 2025–2026 production deployments is isolated subagent contexts. The coordinator agent explicitly chooses what information to pass to each subagent. Subagents operate within their own token budget. Subagent outputs are treated like tool results — data with provenance, not directives that inherit the parent's authority.

Anthropic's subagent architecture in Claude Code exemplifies this: subagents receive a fresh context window with scoped task descriptions. The parent agent incorporates structured summaries, not raw transcripts. Scope inheritance is mandatory (tenant, user, policy, privacy mode must propagate), but the parent's working set does not propagate — preventing the accumulation of irrelevant cross-task history.

Morphllm's analysis found that subagent isolation produced a 90.2% improvement in task success rates compared to a single-agent architecture with shared context, primarily because each actor always reasons from a coherent, minimal context rather than a large, noisy shared history.

### Fan-Out / Fan-In Decomposition

For tasks with independent sub-problems, the fan-out / fan-in pattern parallelizes work while maintaining context discipline. A supervisor decomposes the task into cognitively independent subtasks, assigns each to a specialized subagent with explicit output requirements and a fixed token budget, and merges structured results into a coherent output. Token consumption drops 67% compared to skills-based approaches in multi-domain scenarios, because context isolation prevents any single agent's accumulated history from inflating the total.

The Slack architecture described above is a specialized variant: Director (planning and coordination), Experts (domain-specific investigation), and Critics (evidence evaluation) each maintain independent context channels. The only information flowing between roles is structured summaries — the Director's Journal, Critic's Review, and Critic's Timeline — not raw message histories.

### Just-in-Time Retrieval over Pre-Loading

Anthropic's context engineering guidance articulates a pattern that directly counters the "load everything upfront" instinct: agents should maintain lightweight identifiers (file paths, URLs, query parameters) and load context dynamically via tools only when the relevant step requires it. This mirrors human cognition — a senior engineer doesn't read every file in a codebase before starting a task. They navigate progressively, loading context as exploration reveals what's needed.

The ContextBudget research formalizes this as a sequential decision problem: before loading new observations, the agent checks remaining context headroom and decides whether to preemptively compress history. Three compression modes respond to budget pressure: null (preserve full history when budget permits), partial (selectively compress older segments), and full (aggregate all history under severe constraints). Training with progressive curriculum learning — gradually tightening context budgets from 8K to 4K tokens — forces models to develop sophisticated management strategies rather than defaulting to minimal compression when resources are plentiful. The resulting system shows 1.6× improvement over strong baselines in high-complexity settings and 5× gains in 32-objective scenarios.

---

## Context Engineering as Infrastructure

Jeremy Daly's analysis of production commercial agent failures converges on a conclusion that cuts across all the specific techniques above: context is infrastructure, not an implementation detail. Teams that treat it as infrastructure — with explicit budgets, governance for what gets promoted to durable memory, structural isolation at agent boundaries, and observability into context composition — build systems that hold up under load. Teams that treat it as a convenient dump for all available information build systems that degrade silently and fail unpredictably.

Several concrete principles emerge from production deployments:

**Budget allocation, not unlimited accumulation.** The context window should be thought of as a finite resource divided explicitly: system instructions (10–15% of budget — high influence, must remain visible), tool context (15–20%), retrieved knowledge (30–40%), recent conversation (remaining budget). When one category grows, others must shrink. If guardrails are not explicitly budgeted, they get crowded out.

**Canonical truth separate from derived acceleration.** Production systems that use vector stores as the source of record — rather than as a queryable projection of an append-only canonical log — eventually face unauditable state. The right separation: an event log plus structured memory store as canonical truth, with embeddings and caches as fully-rebuildable derived layers that can fail without breaking correctness.

**Evaluation must include context composition.** Token consumption variance across equivalent tasks reaching 10× (observed by Cognition) indicates that quality metrics are insufficient without context efficiency metrics. Teams should measure tokens per completed task, not just tokens per request, and track how context composition changes as sessions age.

**Compaction before summarization, not after.** A failure pattern in early production deployments: aggressive summarization happening before structured extraction, corrupting meaning. The correct order is to normalize references and extract typed artifacts (decisions, file changes, open questions) before enforcing token limits. Summarize the noise; preserve the structure.

---

## Open Problems

Despite significant progress, several challenges remain inadequately solved:

**Artifact tracking across compaction boundaries.** All evaluated summarization approaches scored poorly (2.19–2.45/5.0) on maintaining accurate file state across extended sessions. General-purpose summarization cannot reliably track which files changed, to what state, in what sequence. Purpose-built artifact manifests updated as structured state, not reconstructed from prose summaries, remain the practical workaround.

**Memory staleness detection.** High-relevance memories can become confidently wrong rather than merely outdated. A preference noted six months ago may be contradicted by recent behavior. Systems need staleness signals — not just recency timestamps, but corroboration counts that decay over time and trigger re-verification.

**Application-specific evaluation.** General benchmarks (LOCOMO and others) do not predict performance for specific agent workflows. An agent managing database migrations has different context retention requirements than one conducting research. Building domain-specific evaluation suites for context management — probing recall on artifacts, decisions, and continuation state specific to the application — remains largely manual work.

**Cross-device identity resolution.** When the same user interacts from different devices or channels, memory systems must decide whether those interactions belong to the same memory namespace. Most production systems handle this with explicit user ID linking, but the policy for resolving conflicts between sessions remains application-specific without emerging standards.

---

## Practical Recommendations

For teams building or improving long-running agent systems:

1. **Audit context composition before optimizing.** Before choosing compression strategies, measure what is actually in context at the point of model calls. Token breakdown by category (system, history, tool results, retrieved docs) reveals where waste lives.

2. **Adopt anchored iterative summarization over full reconstruction.** Merging new summaries into a persistent structured state consistently outperforms regenerating a fresh summary from scratch. Use explicit sections for decisions, file changes, and next steps — not free-form prose.

3. **Treat tool output as context waste by default.** Design tools to return the minimum actionable information. File reads should return relevant sections, not full contents. API responses should be post-processed to extract key fields. This prevention approach outperforms reactive compression for many workloads.

4. **Implement compaction with custom instructions.** Anthropic's compaction API works well out of the box, but `pause_after_compaction` and custom `instructions` parameters unlock domain-specific preservation. Define which artifacts must survive — code signatures, error messages, architectural decisions — and encode that explicitly.

5. **Separate agent contexts at boundaries.** Avoid subagents that inherit the parent's full message history. Pass scoped summaries with explicit output requirements. Return structured summaries, not raw transcripts.

6. **Gate memory promotion.** Not everything observed in a session should become durable state. Implement explicit promotion gates with tiered rules by memory type and scope. Review promotion logs periodically for drift patterns.

7. **Monitor token trends, not just quality.** Track tokens per completed task and context growth rate across session age. Rising averages indicate accumulation without corresponding quality improvement — a leading indicator of context rot.

---

## References

1. [ACON: Optimizing Context Compression for Long-horizon LLM Agents](https://arxiv.org/abs/2510.00615) — Gradient-free framework achieving 26–54% peak token reduction while preserving task accuracy across three agent benchmarks

2. [Evaluating Context Compression for AI Agents — Factory.ai](https://factory.ai/news/evaluating-compression) — 36,000-message engineering session benchmark comparing anchored iterative summarization against Anthropic and OpenAI approaches

3. [Managing Context in Long-Run Agentic Applications — Slack Engineering](https://slack.engineering/managing-context-in-long-run-agentic-applications/) — Production architecture using Director's Journal, Critic's Review, and Critic's Timeline to replace message history with online summarization

4. [Effective Context Engineering for AI Agents — Anthropic Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) — Principles and techniques for optimizing token allocation across system prompts, tools, examples, and runtime strategies

5. [Compaction — Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/compaction) — Full documentation for the `compact-2026-01-12` beta API including configuration parameters, streaming, caching integration, and billing model

6. [Effective Harnesses for Long-Running Agents — Anthropic Engineering](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) — Session handoff patterns, progress file architectures, and incremental commit discipline for multi-session agents

7. [Context Rot: Why LLMs Degrade as Context Grows — Morph](https://www.morphllm.com/context-rot) — Chroma 2025 benchmark results across 18 frontier models with quantitative degradation data and root cause analysis

8. [FlashCompact: Every Context Compaction Method Compared — Morph](https://www.morphllm.com/flashcompact) — Comparison of eight compaction approaches including tradeoffs between summarization fidelity and verbatim precision

9. [Context Engineering for Commercial Agent Systems — Jeremy Daly](https://www.jeremydaly.com/context-engineering-for-commercial-agent-systems/) — Production architecture patterns including the 10-step context engine loop, memory promotion gates, and canonical vs. derived storage separation

10. [State of AI Agent Memory 2026 — Mem0](https://mem0.ai/blog/state-of-ai-agent-memory-2026) — Benchmark data on full-context vs. selective memory tradeoffs, graph memory production status, and infrastructure proliferation across 13 frameworks

11. [ContextBudget: Budget-Aware Context Management for Long-Horizon Search Agents](https://arxiv.org/html/2604.01664v1) — Sequential decision problem formulation for adaptive compression with 1.6× improvement over baselines in high-complexity settings

12. [Context Window Management in Agentic Systems — jroddev](https://blog.jroddev.com/context-window-management-in-agentic-systems/) — Practical implementation patterns including summarization memory, RAG, external memory stores, hierarchical planning, and tool output management

13. [Context Window Management Strategies — Maxim](https://www.getmaxim.ai/articles/context-window-management-strategies-for-long-context-ai-agents-and-chatbots/) — Token budget allocation framework and monitoring patterns for production systems

14. [Solving the Lost-in-the-Middle Problem — Maxim](https://www.getmaxim.ai/articles/solving-the-lost-in-the-middle-problem-advanced-rag-techniques-for-long-context-llms/) — Advanced RAG techniques addressing attention pattern limitations in long-context settings

15. [Observational Memory Cuts AI Agent Costs 10x — VentureBeat](https://venturebeat.com/data/observational-memory-cuts-ai-agent-costs-10x-and-outscores-rag-on-long) — Passive trajectory mining approach outperforming RAG on long-context benchmarks with 10× cost reduction

16. [Agentic Workflows for 2026 — SuperMemory Engineering](https://blog.supermemory.ai/agentic-workflows-vp-engineering-guide/) — VP-level guide to building production agentic workflows with memory-based context patterns

17. [How to Build Multi-Agent AI Systems with Context Engineering — Vellum](https://www.vellum.ai/blog/multi-agent-systems-building-with-context-engineering) — Patterns for context isolation, fan-out/fan-in decomposition, and cost attribution across multi-agent boundaries
