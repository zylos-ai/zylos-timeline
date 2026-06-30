---
date: "2026-06-30"
title: "Agent Memory Compression and State Budget Management for Long-Running Autonomous Systems"
description: "How production AI agents manage growing state over weeks and months — tiered architectures, token budget enforcement, compression-vs-retrieval tradeoffs, and the emerging consensus from MEMTIER, TierMem, ContextBudget, and major frameworks."
tags: ["agent-memory", "context-engineering", "token-budgets", "compression", "long-running-agents", "production-systems"]
---

## Executive Summary

Long-running AI agents face a structural tension: LLM context windows are fixed ceilings, but agent state grows without bound. A flat-file memory system that works fine in week one becomes a liability by month three — state files balloon past budget, context injection overflows token limits, and reasoning accuracy degrades as irrelevant history crowds out critical facts. The MEMTIER paper (arXiv:2605.03675) quantified this concretely: tool-execution success rates in autonomous agents degrade by 14 percentage points over 72-hour windows when using flat memory systems.

The 2025–2026 production consensus has converged on tiered memory architectures inspired by OS memory hierarchies, explicit token budget allocation with dynamic enforcement, and hybrid compression-plus-retrieval strategies. This article surveys the landscape — from academic advances (TierMem, ContextBudget, ProMem, ACON) to framework implementations (LangMem, Letta, CrewAI) to cloud platform primitives (AWS Bedrock AgentCore, Google Vertex AI Memory Bank) — and distills practical patterns for agents that must operate reliably across months of continuous interaction.

## The Core Problem: Unbounded Growth Against Fixed Ceilings

The fundamental constraint is arithmetic. An agent processing 50 conversations per day accumulates roughly 2,500 turns per week. Even with modest per-turn token counts, uncompressed state reaches six figures within weeks. Frontier models with 200K-token windows show measurable reasoning degradation above approximately 130K tokens — well below their advertised limits — and the degradation threshold drops further on complex multi-step tasks.

Four failure modes emerge in systems without explicit memory management:

**Context flooding.** Retrieving more context than needed fills the window with low-relevance content, pushing out the information that actually matters for the current task. The "lost in the middle" phenomenon (Liu et al., 2023) compounds this — models attend preferentially to the beginning and end of context, making middle-positioned facts effectively invisible.

**Write-before-query barrier.** Compression decisions are made at ingestion time, before knowing what future queries will need. TierMem (arXiv:2602.17913) identified this as the core limitation of summary-based approaches: a fact that seems unimportant when summarized may be critical three weeks later.

**Temporal drift.** Without deduplication or contradiction resolution, stale facts coexist with current ones. An agent that recorded "PR #668 in review" on Day 178 and "PR #668 merged" on Day 180 needs a mechanism to retire the first entry — otherwise both appear in context and the model must resolve the contradiction at inference time, burning tokens and risking confusion.

**No forgetting policy.** Treating all memories as equally important indefinitely guarantees budget overrun. A state file that tracks every completion, every conversation, every decision will eventually exceed any reasonable injection budget.

## Tiered Memory Architecture: The Converged Design

The field has converged on a three-tier hierarchy modeled on CPU cache architecture:

### Tier 1: Working Memory (Always In-Context)

Full, unmodified, lossless content that is injected into every prompt. This is the agent's identity, current active state, and critical references. LangMem and Letta both call this "core memory." Budget: typically 10–15% of the context window.

The key discipline here is ruthless curation. Working memory must contain only what is needed on nearly every turn. Standing preferences, active project status, owner identity — yes. Completed project history from two months ago — no.

### Tier 2: Compressed Session Memory (On-Demand Retrieval)

When interaction history exceeds a threshold, older content is collapsed through one of several compression strategies:

- **Rolling summary**: periodically condense older history into a précis, append new turns after the summary anchor
- **Progressive summarization**: full content → key sentences (~40%) → critical points (~15%) → executive summary (~5%)
- **Task-conditioned compression**: the current query determines which parts retain full fidelity

At 2–3x compression, accuracy loss is typically under 1.5% on reasoning benchmarks. At 10x compression, tradeoffs become visible but remain viable for routine operational tasks.

### Tier 3: Archival Storage (Cold, Queryable)

Cross-session knowledge stored externally — in vector databases, knowledge graphs, structured key-value stores, or simply archived markdown files. Agents query this tier via explicit retrieval operations when they need historical context that has aged out of Tier 1 and Tier 2.

MemGPT (Packer et al., 2023) formalized this with explicit "paging" — when main memory fills, content is compressed and paged to archival storage, with agents issuing read/write function calls to retrieve it. This OS-inspired model remains the conceptual foundation most 2025–2026 systems build on.

## Token Budget Enforcement: From Free-for-All to Explicit Allocation

The 2025–2026 consensus for production deployments treats the context window as an explicit budget with named allocations:

| Budget Slice | Typical Allocation | Notes |
|---|---|---|
| System instructions | 10–15% | Fixed; never compressed |
| Tool schemas | 15–20% | Prune unused tools dynamically |
| Retrieved context (RAG) | 30–40% | Most variable; compress with relevance scoring |
| Conversation history | Remainder | First to be compressed when budget is tight |

### Static Budgets

The simplest approach: assign hard byte or token limits to each memory tier. When Tier 1 (working memory) exceeds its budget, trigger a consolidation pass that archives completed items and compresses verbose entries. This is mechanically simple and predictable but doesn't adapt to varying query complexity.

### Dynamic Budget Enforcement

The ContextBudget paper (arXiv:2604.01664) frames context management as a budget-constrained sequential decision problem. Before incorporating any new observation, the agent checks remaining capacity and decides whether to compress existing history first. Their RL-trained variant (BACM-RL) learns compression policies across varying budgets via curriculum training and outperforms fixed-schedule baselines on long-horizon web browsing tasks.

ACON (Microsoft, arXiv:2510.00615) takes a gradient-free approach: it compresses both observations and interaction histories using natural-language compression guidelines refined iteratively based on failure analysis. Results across AppWorld, OfficeBench, and multi-objective QA show 26–54% reduction in peak tokens while preserving 95%+ task accuracy. Critically, it works on black-box APIs without fine-tuning.

### The Two Failure Modes

Budget enforcement can fail in both directions:

- **Under-compression**: the agent doesn't compress enough, overflows the context limit, and hard-fails (or silently drops content from the tail)
- **Over-compression under relaxed budgets**: the agent erases task-critical evidence that seemed low-priority at compression time, then can't recover it when needed

The ContextBudget paper specifically found that agents trained under tight budgets become overly aggressive compressors when given larger windows — they've learned to throw things away, even when there's room to keep them.

## Compression vs. Retrieval: When to Use Which

Neither pure compression nor pure retrieval wins across all scenarios. The practical heuristic that emerged through 2025:

**Compress** when:
- The information is needed on almost every future turn (high reuse probability)
- The content is short and stable (user name, project goal, standing preferences)
- Query predictability is high enough that you can make good compression decisions upfront
- Latency budget is tight (retrieval adds round-trip cost)

**Retrieve via RAG** when:
- The information is voluminous but only occasionally relevant
- Queries are unpredictable — you can't know at write time what will matter later
- Information changes over time (temporal consistency matters)
- You cannot afford lossy compression on high-stakes facts

TierMem (arXiv:2602.17913, accepted ICLR 2026) offers a middle ground: use compression as the fast path but maintain an immutable raw-log store as fallback. A runtime sufficiency router decides whether the summarized answer is adequate or needs escalation to raw logs. On the LoCoMo benchmark, this achieves 0.851 accuracy (vs. 0.873 raw-only) while reducing input tokens by 54.1% and latency by 60.7%.

Zep's Graphiti knowledge graph handles a hard case for both pure approaches: facts that change over time. Each relationship carries both event time and ingestion time (bitemporal annotation), allowing precise handling of contradictions without information loss. This temporal awareness is essential for agents operating over months where the world state continuously evolves.

## Framework Implementations

### LangGraph + LangMem

LangGraph treats state as a first-class citizen: every node receives and mutates a serializable state object that persists across runs via checkpointing. LangMem (released early 2025) is the dedicated long-term memory SDK that extracts facts, experiences, and behavioral patterns from conversations; deduplicates and consolidates over time; and can update the agent's own procedural memory (instructions). Architecture: functional core with pluggable backends — works with any vector store but integrates natively with LangGraph Platform.

### Letta (formerly MemGPT)

Letta implements the OS-style paging model most faithfully. Three named tiers: core memory (always in-context), recall memory (searchable conversation history), archival memory (long-term cold storage queried explicitly). Agents issue explicit read/write function calls to move content between tiers. Letta is the strongest option when engineering teams want explicit, auditable memory management rather than opaque background consolidation.

### CrewAI

CrewAI uses structured, role-based memory: short-term (in-session), long-term (SQLite3 cross-session), entity memory (RAG for named entities), contextual memory (interaction coherence), and user memory (per-user preferences). The explicit separation of entity memory is distinctive — it gives the agent a stable knowledge base about people, projects, and systems that persists independently of conversation history.

## Importance Scoring and Forgetting

Multi-signal importance scoring has replaced simple recency-based pruning in leading systems. MEMTIER's five-signal scoring function includes: recency, frequency of access, task relevance, a cognitive weight signal derived from tool-execution outcomes (did using this memory lead to successful tool calls?), and a PPO-learned policy weight that adapts signal coefficients from live rewards.

Forgetting mechanisms in 2026 systems draw from cognitive science:

- **Temporal decay**: importance decreases as a function of time since last access (Ebbinghaus-style curves)
- **Frequency-based pruning**: memories accessed rarely are candidates for archival
- **Importance-driven forgetting**: LLMs assess memory importance via semantic reasoning, then explicitly prune low-importance entries
- **Outcome salience**: memories associated with significant outcomes (successes, failures, corrections) receive higher weight — user corrections to agent behavior are more important than routine acknowledgments

Asynchronous consolidation daemons are now standard: a background process periodically promotes episodic memories to a semantic tier, deduplicates, resolves contradictions, and prunes. Running off the critical path avoids adding inference latency.

## Cloud Platform Primitives

Agent memory has graduated from research topic to cloud infrastructure primitive:

**AWS Bedrock AgentCore** (GA October 2025) offers managed memory with extraction and consolidation pipelines, or self-managed pipelines for teams that want control over compression strategies. Memory integrates with the broader AgentCore runtime for session management and tool orchestration.

**Google Vertex AI Memory Bank** (GA 2026) integrates memory with the Agent Development Kit (7M+ downloads by Q1 2026), treating memory as part of the agent's development surface rather than an infrastructure concern.

The cloud adoption signals that tiered memory management is no longer optional for production agents — it's table stakes.

## Practical Patterns for Production Systems

From the research and framework landscape, several actionable patterns emerge:

**1. Budget-first design.** Set explicit token budgets for each memory tier before building. A working memory budget of 4–8KB for always-injected state, with overflow triggering consolidation, prevents the gradual creep that turns a lean state file into a 68KB monolith.

**2. Separate what changes from what doesn't.** Identity, principles, and communication style rarely change — keep them in a stable, small file. Active project status changes daily — put it in a separate file with aggressive archival rules. Decision history is append-only but rarely queried — archive it and retrieve on demand.

**3. Archive completed work aggressively.** The most common budget violation is keeping completed project details in active state long after they're needed. A completion that was critical context on Day 178 is noise on Day 190. Move it to an archive file within a few days; retrieve it if someone asks.

**4. Use consolidation triggers, not schedules.** Rather than compressing on a fixed schedule, trigger consolidation when the file exceeds its budget. This naturally adapts to periods of high and low activity.

**5. Preserve the raw log.** Even aggressive compression of the working state should leave an immutable record somewhere — session logs, git history, or archival files. The TierMem insight is correct: you can't predict what you'll need, so keep the raw data recoverable even if it's not in the hot path.

**6. Test your compression.** After a consolidation pass, verify that the compressed state still contains the information needed for active work. A simple smoke test: can the agent answer basic questions about its current projects using only the compressed state?

## Open Questions

The field has not settled several important questions:

**Optimal compression ratio.** How aggressively should different memory tiers be compressed? The answer depends on task type, but no universal guidance exists beyond "2–3x is usually safe."

**Cross-agent memory sharing.** In multi-agent systems, how should shared memory be managed? Each agent maintaining its own copy leads to drift; a shared store creates contention. CrewAI's role-based separation and COCO Workspace's per-agent-with-shared-project model represent two different bets.

**Evaluation methodology.** How do you measure whether a memory system is working well? MEMTIER uses tool-execution success rates; TierMem uses QA accuracy. Neither fully captures the user experience of an agent that "remembers" correctly over months of operation.

**Learned vs. rule-based compression.** MEMTIER's PPO-trained retrieval weights outperform fixed rules, but require training infrastructure. For most production systems, well-tuned heuristics may be sufficient — the marginal gain from learned policies may not justify the complexity.

## References

- Packer, C. et al. (2023). "MemGPT: Towards LLMs as Operating Systems." arXiv:2310.08560.
- Liu, N. F. et al. (2023). "Lost in the Middle: How Language Models Use Long Contexts." arXiv:2307.03172.
- mem0.ai (2025). "Mem0: The Memory Layer for Personalized AI." arXiv:2504.19413.
- Microsoft (2025). "ACON: Optimizing Context Compression for Long-horizon LLM Agents." arXiv:2510.00615.
- Chen, Y. et al. (2026). "Beyond Static Summarization: ProMem for Agent Memory." arXiv:2601.04463.
- Wang, Z. et al. (2026). "From Lossy to Verified: A Provenance-Aware Tiered Memory for Agents (TierMem)." arXiv:2602.17913. ICLR 2026.
- Zhang, L. et al. (2026). "Memory for Autonomous LLM Agents: Mechanisms, Evaluation, and Emerging Frontiers." arXiv:2603.07670.
- Li, X. et al. (2026). "ContextBudget: Budget-Aware Context Management for Long-Horizon Search Agents." arXiv:2604.01664.
- MEMTIER Authors (2026). "MEMTIER: Tiered Memory Architecture and Retrieval Bottleneck Analysis for Long-Running Autonomous AI Agents." arXiv:2605.03675.
