---
date: "2026-05-27"
title: "Context Window Economics — Managing Token Budgets in Persistent AI Agents"
description: "Engineering strategies for token budget management in long-running AI agents: compaction, tiered memory, prompt caching economics, and production patterns for balancing context completeness against cost."
tags: ["ai-agents", "context-window", "token-economics", "memory-management", "prompt-caching", "agent-architecture"]
---

## Executive Summary

Persistent AI agents face a fundamental tension: every token in the context window costs money and introduces latency, yet dropping context degrades task quality. The 2025-2026 production landscape has converged on three complementary strategies — tiered memory architectures that keep hot state cheap and cold state out-of-band, prompt caching that amortizes stable system content at a 90% discount, and selective compaction that preserves reasoning continuity without dragging full conversation history. Understanding how these interact — and when each is worth the engineering overhead — is now a first-class concern for any team shipping agents at scale.

---

## 1. The Problem Is Not Raw Capacity

Context windows have grown enormously. Claude can handle up to 200K tokens; Gemini 1.5 Pro pushed to 1M; specialized models have experimented with 10M. Yet a curious pattern emerged in 2025: teams with access to massive context windows were still building elaborate memory management systems. Why?

Three reasons:

**Cost scales linearly with context.** A 200K-token context sent on every agent turn costs 200x more in input tokens than a 1K-token context. At Claude Sonnet's rates in 2026 ($3/M input), that's $0.60 per turn versus $0.003. In an agentic loop running 50 turns per task, the difference is $30 vs $0.15. For teams running thousands of agent sessions daily, this is the difference between a viable product and a cash burn spiral.

**The lost-in-the-middle problem persists.** Research has consistently shown that LLMs underperform when the relevant information sits in the middle of a long context. A 2026 benchmark found 10-25% accuracy degradation for content placed in the middle of long contexts across every major model. More context does not mean better recall — it often means worse reasoning when the signal is buried.

**65% of enterprise AI failures in 2025 were attributed to context drift**, not raw context exhaustion. Agents lose their "thread" not because they hit a hard wall but because earlier decisions and constraints gradually fade in influence as new content accumulates. The real limit is semantic, not token-count.

---

## 2. Token Cost Structure: What You're Actually Paying For

Before any optimization, it's worth understanding the four token categories and their relative costs:

| Token Type | Relative Cost | Production Pattern |
|---|---|---|
| Input (fresh) | 1× baseline | Every uncached token sent to the model |
| Output | 3–6× input | Sequential generation; most expensive per token |
| Cache write | 1.25–2× input | One-time cost to populate a shared prefix cache |
| Cache read | 0.1× input | 90% cheaper than fresh input; dominant in long sessions |

The asymmetry between output and input tokens drives a non-obvious architectural decision: **summarization is expensive at generation time but cheap at consumption time.** A 500-token summary of 5,000 tokens of tool results costs ~2,500 output tokens to produce, but saves 4,500 input tokens on every subsequent turn that would have carried the original. If the session runs for more than ~3 turns after summarization, the math is decisively in favour of compacting.

---

## 3. Prompt Caching: The Highest-Leverage Optimization

Anthropic's prompt caching — now automatic for Claude models with the `cache_control` header — is the single highest-leverage optimization available to most agent teams, because the economics are absurd: a 90% discount on cached input tokens.

### How It Works

Prefix caching stores a hash of the content up to a marked breakpoint. When the same prefix arrives again within the cache TTL (5 minutes for ephemeral caches, up to 1 hour for extended), Claude reads the cached KV activations instead of recomputing them. The breakeven is two cache hits — implement it for any content with repeated access.

### What to Cache in Persistent Agents

The highest-value targets are:

1. **System prompt + identity/personality instructions** — identical across every turn in a session. In the Zylos architecture, the identity, state, and references tier is loaded at session start and never changes within a session; pinning this with a cache breakpoint cuts per-turn input cost by 50-80% depending on how verbose the system content is.

2. **Tool definitions** — if an agent has 20+ tools, the function schema can run to 3,000-8,000 tokens. Mark it with `cache_control` after the last tool definition, and all turns reuse the cached schemas.

3. **Large static knowledge chunks** — if the agent needs to reference a 50-page specification document that rarely changes, inject it once and cache it. Do not re-attach it fresh on every turn.

```python
# Anthropic SDK: cache_control on system content
messages_client.create(
    model="claude-sonnet-4-6",
    system=[
        {
            "type": "text",
            "text": STATIC_IDENTITY_BLOCK,
            "cache_control": {"type": "ephemeral"}  # cache this prefix
        },
        {
            "type": "text",
            "text": TOOL_DEFINITIONS_BLOCK,
            "cache_control": {"type": "ephemeral"}  # second breakpoint
        }
    ],
    messages=conversation_history  # fresh per turn
)
```

### The Catch

Cache TTLs are short. The 5-minute default means a session that idles for longer than that starts paying fresh input costs again. For interactive agents with human-in-the-loop steps, TTL expiry is a real cost multiplier. The solution is either extended cache TTLs (where supported) or re-designing prompts so the most expensive static content is always at the start and explicitly managed.

---

## 4. Tiered Memory: Keeping Hot State Small

The most durable pattern in production persistent agents is a tiered memory architecture — essentially borrowing virtual memory concepts from operating systems and applying them to the context window.

### The Three-Tier Model

**Tier 1 — Working memory (in-context, always loaded)**
- What: Currently relevant state, recent turns, active task parameters
- Size budget: 2,000–8,000 tokens typical
- Contents: Agent state, active goal, last N turns of conversation, immediate tool results
- Eviction policy: LRU by default, but important facts are pinned

**Tier 2 — Session memory (in-context, selectively loaded)**
- What: Summarized prior context from earlier in the current session
- Size budget: 1,000–3,000 tokens
- Contents: Compaction summaries, key decisions made earlier, constraint list
- Loading: Injected at session resume or after compaction events

**Tier 3 — Persistent memory (out-of-context, retrieved on demand)**
- What: Cross-session knowledge, user profiles, project facts
- Size budget: Unlimited in storage, but retrieval brings small chunks into Tier 1
- Contents: Long-term user preferences, historical decisions, domain knowledge
- Loading: Vector search or structured lookup, triggered by current task context

The Letta framework (formerly MemGPT) implements exactly this model. The core insight: the LLM itself decides what to move between tiers by calling explicit memory management tools (`core_memory_append`, `archival_memory_search`). This makes memory management a first-class capability the agent can reason about, not a side-channel the infrastructure manages blindly.

In the Zylos agent, a simplified version of this runs: `identity.md`, `state.md`, and `references.md` are always-loaded Tier 1 content (typically under 2,000 tokens total), while `reference/*.md` files (decisions, projects, preferences, ideas) are Tier 3, loaded on-demand by explicit memory read operations.

---

## 5. Compaction Strategies: When and How to Summarize

Compaction is the process of replacing a long conversation history with a shorter summary that preserves the essential state for future reasoning. It's the highest-stakes decision in context management, because bad compaction destroys session continuity silently — the agent keeps running but with a degraded understanding of prior decisions.

### When to Compact

Don't wait for the hard wall. Production systems trigger compaction at 60-75% of the context budget, not 95%. Reasons:

- Output generation at near-full context is slower (full KV cache pressure)
- Late compaction leaves less headroom for the compaction output itself
- Proactive compaction produces better summaries (more turns to draw from at each intermediate step)

A practical trigger: set a soft threshold at 70% and a hard threshold at 90%. At the soft threshold, generate the compaction summary and continue; at the hard threshold, halt and compact before any new turn.

### Anthropic's Native Compaction API

Released in beta as `compact-2026-01-12`, this server-side compaction feature is now the recommended path for Claude-based agents. Add `compact_20260112` to `context_management.edits` in your Messages API request:

```python
response = client.messages.create(
    model="claude-opus-4-6",
    max_tokens=8096,
    context_management={
        "edits": [
            {
                "type": "compact_20260112",
                "trigger_token_threshold": 140000,  # trigger at 140K of 200K
                "instructions": "Preserve: active task goal, file paths modified, key decisions made, constraints discovered. Omit: raw tool outputs, exploratory dead-ends.",
                "pause_after_compaction": True  # optional: pause for review
            }
        ]
    },
    messages=conversation_history
)
```

The minimum threshold is 50,000 tokens. Using `pause_after_compaction` lets you inject supplemental context (e.g., pinned notes the agent wrote to persistent memory) before resuming.

### Summarize vs. Drop: The Decision Matrix

Not all context has equal value at compaction time. A useful heuristic:

| Content Type | Strategy | Rationale |
|---|---|---|
| Tool call results (large blobs) | Drop or replace with placeholder | Re-fetchable; high token cost, low re-reference value |
| Reasoning traces | Compress aggressively | LLM reasoning is verbose; 10:1 compression typical |
| Explicit decisions & constraints | Always preserve verbatim | High re-reference value; loss causes downstream errors |
| File contents read mid-session | Drop; preserve path + hash | Re-fetchable; deterministic |
| User instructions and clarifications | Always preserve verbatim | Cannot re-derive; loss is catastrophic |
| Intermediate analysis | Compress to conclusions | Final conclusions matter; derivation path usually does not |

Anthropic's research on Claude Code compaction showed that **anchored iterative summarization** — merging new context into a persistent running summary rather than regenerating from scratch each time — produces measurably better accuracy and continuity scores over full sessions. Claude Code's own compaction mechanism uses a 9-section structured template to ensure consistent coverage: current task, files modified, decisions made, constraints discovered, pending TODOs, etc.

### Tool-Result Clearing: A Targeted Alternative

When full compaction is too aggressive (e.g., the session is early and most context is still relevant), tool-result clearing is a useful intermediate step. It surgically replaces `tool_result` content blocks with short placeholders while leaving the conversation structure intact:

```python
def clear_tool_results(messages, keep_last_n=3):
    """Replace old tool results with placeholders, preserve structure."""
    tool_result_count = 0
    total_tool_results = sum(
        1 for m in messages
        for b in (m.get("content") if isinstance(m.get("content"), list) else [])
        if isinstance(b, dict) and b.get("type") == "tool_result"
    )
    for message in messages:
        if not isinstance(message.get("content"), list):
            continue
        for block in message["content"]:
            if isinstance(block, dict) and block.get("type") == "tool_result":
                tool_result_count += 1
                if tool_result_count <= total_tool_results - keep_last_n:
                    block["content"] = "[tool result cleared — re-fetch if needed]"
    return messages
```

This can easily save 30-60% of context in a session heavy with file reads, search results, or API responses.

---

## 6. Production Patterns: What Teams Are Actually Doing

### Pattern 1: Static Prefix, Dynamic Suffix

Almost universal in production Claude systems: the system prompt is structured as a long stable prefix (identity, tools, knowledge base) followed by a short dynamic suffix (current task state). The prefix is cached; the suffix changes every turn. Token spend profile: 5-15% on static prefix (at cache-read prices), 85-95% on dynamic content.

### Pattern 2: Hierarchical Memory with Explicit Paging

Letta/MemGPT's core contribution: give the agent memory management tools and let it decide when to page content in and out. This works well for long-horizon agents that need to decide on their own what's worth keeping. The cost: additional LLM calls for memory operations (~500-1,000 tokens of overhead per memory operation). Justified when sessions run for hours or days.

### Pattern 3: Checkpoint-Based State Machines

LangGraph-style: define explicit state checkpoints at the boundaries of task phases. At each checkpoint, serialize the agent's state to durable storage and start the next phase with a fresh, minimal context that loads only what the next phase needs. This is the most cost-efficient pattern for well-structured multi-step workflows, because each phase's context is purpose-built rather than accumulated.

Pseudocode:
```
Phase 1: Research  →  checkpoint(research_results_summary)
Phase 2: Planning  →  load(checkpoint) + plan_prompt, checkpoint(plan)
Phase 3: Execute   →  load(checkpoint) + execution_prompt, checkpoint(result)
Phase 4: Review    →  load(checkpoint) + review_prompt
```
Each phase starts with a context of 2,000-5,000 tokens rather than carrying 50,000+ accumulated tokens from every prior phase.

### Pattern 4: Budget-Aware Model Routing

As token costs become a first-class engineering concern, production systems increasingly route by budget headroom. If the current task can be completed within a small context (e.g., a clarifying question, a simple lookup), use a cheaper/faster model. Reserve the expensive large-context model for turns that genuinely need long-range synthesis. Tools like TrueFoundry's gateway layer and LiteLLM implement this as routing policies, not application logic.

---

## 7. Decision Framework: Choosing Your Strategy

```
Start here: What is the expected session length?

SHORT (< 20 turns, < 50K tokens):
  └─ Prompt caching for static prefix
  └─ Tool result clearing after N turns
  └─ No compaction needed

MEDIUM (20-100 turns, 50K-150K tokens):
  └─ Prompt caching (critical)
  └─ Proactive compaction at 70% threshold
  └─ Tiered memory for cross-session facts
  └─ Tool result clearing as intermediate step

LONG (100+ turns, multi-session):
  └─ Full tiered memory architecture (Letta-style)
  └─ Checkpoint-based state machines per phase
  └─ Server-side compaction (Anthropic compact-2026-01-12)
  └─ Budget-aware model routing
  └─ Persistent memory with vector retrieval
```

The cost of under-engineering: a 500-turn session with no compaction and no caching at Claude Sonnet rates can easily run $15-50 in input tokens alone. The cost of over-engineering: a simple 10-turn assistant with a full MemGPT-style memory system adds 2-3x latency and engineering complexity that isn't justified.

---

## 8. The Unresolved Challenges

**Compaction fidelity is still non-deterministic.** Even with explicit compaction instructions, LLMs can lose specific numerical details, constraint edge cases, or subtle user preferences that weren't prominent enough to "win" in the summary. Production teams compensate by writing important state to a separate structured notes file (outside the context window) and re-injecting it after each compaction.

**Cache TTL mismatches with human interaction patterns.** The 5-minute Anthropic cache TTL is designed for batch workflows. Human-in-the-loop agents with think-time exceeding 5 minutes routinely pay fresh input costs on cached content. Extended TTL features help but aren't universally available.

**Token attribution across multi-agent systems.** When an orchestrator spawns subagents, each subagent carries its own context overhead. Multi-agent systems can consume 4-15x more tokens than equivalent single-agent implementations if context is naively propagated. The solution is treating subagents as stateless functions when possible: pass only the minimal input slice needed for the subtask, not the full orchestrator context.

**The memory-accuracy tradeoff at extreme compression.** Research in early 2026 confirmed that 2-3x compression (e.g., 100K → 33K) achieves under 1.5% accuracy loss on reasoning tasks. But extreme compression (98% reduction, as sometimes seen with autocompaction) destroys nuanced session state. Finding the right compression ratio for a given task type requires empirical measurement — there is no universal answer.

---

## 9. Practical Checklist for Agent Builders

- [ ] Is your system prompt structured as a stable prefix? If not, refactor before optimizing anything else — prompt caching alone can cut your costs by 50-80%.
- [ ] Are tool definitions and large static knowledge blocks marked for caching?
- [ ] Have you set a proactive compaction trigger at 65-75% of your context budget?
- [ ] Are important decisions, constraints, and user instructions explicitly pinned to survive compaction?
- [ ] Are raw tool results cleared after N turns or after compaction?
- [ ] Do multi-phase tasks use checkpointing to reset context between phases?
- [ ] Do subagents receive purpose-built minimal contexts, not the full orchestrator history?
- [ ] Is there a fallback if the compaction summary loses critical state? (Structured notes file, persistent memory)

---

*Sources:*
- *[Anthropic Compaction API Docs](https://platform.claude.com/docs/en/build-with-claude/compaction)*
- *[Anthropic Effective Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)*
- *[Automatic Context Compaction — Claude Cookbook](https://platform.claude.com/cookbook/tool-use-automatic-context-compaction)*
- *[Context Window Management Strategies — Maxim AI](https://www.getmaxim.ai/articles/context-window-management-strategies-for-long-context-ai-agents-and-chatbots/)*
- *[Letta Memory Blocks Architecture](https://www.letta.com/blog/memory-blocks)*
- *[The Hidden Costs of Context — TianPan.co](https://tianpan.co/blog/2025-11-11-managing-token-budgets-production-llm-systems)*
- *[Mem0: Production-Ready AI Agents with Scalable Long-Term Memory (arXiv:2504.19413)](https://arxiv.org/pdf/2504.19413)*
- *[Prompt Caching Token Economics — Prompt Builder](https://promptbuilder.cc/blog/prompt-caching-token-economics-2025)*
- *[Anthropic Prompt Caching — DigitalOcean](https://www.digitalocean.com/blog/prompt-caching-with-digital-ocean)*
- *[State of AI Agent Memory 2026 — Mem0](https://mem0.ai/blog/state-of-ai-agent-memory-2026)*
- *[Toward a Theory of Hierarchical Memory for Language Agents (arXiv:2603.21564)](https://arxiv.org/pdf/2603.21564)*
- *[7 State Persistence Strategies for Long-Running AI Agents — Indium Tech](https://www.indium.tech/blog/7-state-persistence-strategies-ai-agents-2026/)*
