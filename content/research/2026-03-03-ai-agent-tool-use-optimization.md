---
date: "2026-03-03"
title: "AI Agent Tool-Use Optimization: Efficiency, Selection, and Composition Patterns"
description: "A comprehensive survey of the current state of art in optimizing how AI agents call and compose tools — covering dynamic selection, parallel execution, trajectory reduction, Tool RAG, and alignment techniques for smarter tool invocation decisions."
tags: ["ai-agents", "tool-use", "function-calling", "optimization", "efficiency", "architecture", "research"]
---

## Executive Summary

Tool-use — the ability of an LLM to invoke external functions, APIs, and services — transformed AI agents from conversational systems into action-capable actors. But as production agent deployments have matured, a new class of problems has emerged: agents that call too many tools, call the wrong tools, call tools in the wrong order, or drown in the growing output of prior tool results.

Poorly optimized tool use is now one of the leading drivers of unnecessary cost and latency in agentic systems. Every tool call adds a round-trip: the model generates a structured request, the external system responds, the result re-enters context, and the model reasons over it again. Five redundant tool calls at 300ms each adds 1.5 seconds of user-perceived latency and potentially hundreds of extra input tokens — tokens that compound as the trajectory grows.

The research frontier in 2025–2026 has converged on five distinct axes of tool-use optimization: (1) smarter dynamic tool *selection* from large catalogs via Tool RAG, (2) *alignment* techniques that teach models when *not* to call tools, (3) *parallel execution* that eliminates sequential wait time, (4) *trajectory reduction* that prunes the ever-growing tool-result context, and (5) *tool design* discipline that makes the right choice obvious. This article surveys all five axes with current research, implementation patterns, and concrete recommendations for agent builders.

---

## Why Tool-Use Efficiency Matters Now

### The Cost Anatomy of a Tool Call

Each tool invocation carries three distinct cost components:

**Latency cost:** The model must generate the tool call (output tokens), wait for the external response (network/compute round-trip), then process the result (input tokens). Sequential chains multiply these delays: five API calls at 200ms each equals a full second of pure wait time before the model can reason further.

**Token cost:** Tool results re-enter the context window as input tokens — often the most expensive token type. A long JSON blob from a database query can easily consume 1,000+ tokens per call. Over a 10-step trajectory, accumulated tool results can dominate the input context and drive the majority of inference cost.

**Error cost:** Failed or mismatched tool calls require the model to recognize the error, adjust, and retry — doubling the effective cost of that step. Models that call tools with incorrect argument schemas trigger structured error handling that further inflates token counts.

### The Overreliance Problem

Recent research (arXiv 2503.06708, published March 2025) identified a systematic failure mode in current LLMs: **over-tool-reliance**. Models invoke tools even when they possess sufficient internal knowledge to answer directly. On queries LLMs can answer from parametric memory with high confidence, unnecessary tool calls add latency and cost with zero accuracy benefit.

The inverse failure — **overconfidence** — also exists: models refusing tools on genuinely difficult queries where retrieval would materially improve accuracy. Both failure modes share a root cause: the model lacks an accurate, calibrated estimate of its own knowledge boundary.

### Scale Amplifies Every Inefficiency

In a low-traffic prototype, an extra tool call per query is invisible. In production, inefficiencies scale with request volume. An agent handling 10,000 requests per day that makes two unnecessary tool calls per request, each costing $0.002 in token costs and API fees, burns $14,600/year in avoidable expense — before accounting for latency impact on user retention.

---

## Axis 1: Tool RAG — Dynamic Tool Selection at Scale

### The Catalog Explosion Problem

Early agents exposed a small, curated set of tools directly in the system prompt. This approach breaks as tool catalogs grow. Presenting an agent with 50+ tool descriptions simultaneously causes **choice overload**: model accuracy degrades, prompts bloat with irrelevant tool descriptions, and the probability of selecting a suboptimal tool increases with catalog size.

Anthropic's internal research on RAG-MCP demonstrated the severity: a naively configured large toolset reduced tool selection accuracy to 13%. Basic retrieval brought it to 43% — more than a 3× improvement, while simultaneously reducing prompt size dramatically.

### Tool RAG Architecture

Tool RAG applies the Retrieval-Augmented Generation paradigm to tools rather than documents. When a user query arrives, the system performs semantic search over an indexed database of tool descriptions, API schemas, and usage examples — selecting only the top-K most relevant tools to present to the model.

Red Hat's November 2025 research formalized this pattern, identifying three retrieval layers:

**Dense retrieval:** Embed tool descriptions and queries into a shared vector space; retrieve by cosine similarity. Fast and scalable, but struggles with complex or ambiguous queries where the user's vocabulary diverges from the tool description vocabulary.

**Hybrid retrieval:** Combine dense vector search with sparse BM25 keyword matching. Improves recall for precise technical terms (API names, parameter names) that dense embeddings sometimes fail to surface.

**LLM-assisted reranking:** After retrieving candidate tools, use a small LLM to rerank them based on the full query context. Adds latency but materially improves precision for ambiguous cases.

### Graph-Augmented Tool Selection

A limitation of pure vector similarity is that it treats tools as independent items. Real tool catalogs have rich relationships: some tools are prerequisites for others, some tools conflict, some compose naturally into higher-order operations.

Research in late 2025 (COLT, Graph RAG-Tool Fusion) explored knowledge graphs over tool relationships. By modeling inter-tool dependencies explicitly, these systems achieve higher recall for complex multi-step queries where the initially retrieved tool is merely the first in a necessary chain. The graph structure allows the retrieval system to proactively surface the full tool chain required for a given task class.

### Tool-to-Agent Retrieval

The arxiv paper 2511.01854 ("Tool-to-Agent Retrieval") extended the Tool RAG concept to multi-agent systems where tools are themselves specialized agents. Rather than selecting an API function, the orchestrator performs semantic retrieval over a registry of sub-agents, each with capability descriptions. This bridges tool selection and agent routing into a unified retrieval problem.

---

## Axis 2: Alignment for Efficient Tool Calling

### Teaching Models Their Knowledge Boundaries

The core challenge in tool-use alignment is giving models an accurate, calibrated self-model of what they know and don't know. Without this, models default to reflexive tool-calling on any query that *might* benefit from retrieval.

The March 2025 paper "Alignment for Efficient Tool Calling of Large Language Models" (arXiv 2503.06708) proposed a multi-objective alignment framework with two components:

**Knowledge boundary estimation:** Two approaches were studied. *Consistency-based estimation* measures how consistently the model produces the same answer across multiple samplings — high consistency correlates with high parametric knowledge confidence. *Absolute estimation* directly probes the model's confidence via calibrated output probabilities. These estimates are computed cheaply at inference time and used to gate tool invocation.

**Training strategy integration:** The knowledge boundary estimates are incorporated into the model's decision-making via preference alignment (DPO-style) training. Preference pairs are constructed where the "preferred" completion avoids a tool call on high-confidence queries and uses tools on low-confidence ones. Fine-tuning on these pairs instills the desired behavior without requiring explicit confidence calibration at inference time.

Experimental results showed significant reductions in unnecessary tool calls while maintaining or improving overall task accuracy.

### DEPO: Dual-Efficiency Preference Optimization

The November 2025 DEPO framework (arXiv 2511.15392) addressed a related but distinct efficiency axis: not just whether to call tools, but how verbosely to do so. DEPO introduces a dual-efficiency objective:

- **Step-level efficiency:** Minimize tokens generated per reasoning step while maintaining accuracy
- **Trajectory-level efficiency:** Minimize the total number of tool-call steps required to complete a task

Using preference optimization with an efficiency bonus term, DEPO achieved up to 60.9% token reduction and 26.9% step count reduction on benchmarks, with a simultaneous 29.3% accuracy improvement — demonstrating that efficiency and accuracy are not always in tension when training is designed correctly.

### Prompt-Engineering Alternatives

For teams not yet ready for fine-tuning, structured prompting techniques materially improve tool-calling discipline:

**Forced reasoning traces:** Requiring a brief explanation *before* each tool call ("I need to call weather_api because...") reduces impulsive tool invocations and surfaces reasoning errors before they propagate.

**Post-call observations:** Requiring a brief synthesis after each tool result ("The API returned X, which means...") helps the model integrate results before deciding on next steps, reducing chains of tool calls that could be collapsed into one.

**Explicit no-tool paths:** System prompts that explicitly license the model to answer from memory ("If you are confident you know the answer, respond directly without calling tools") reduce overreliance without requiring training.

---

## Axis 3: Parallel Tool Execution

### The Sequential Wait Problem

The default tool-calling loop in most agent frameworks is strictly sequential: call a tool, receive the result, incorporate it into context, decide the next action. This serialization is often unnecessary. Many tool calls within a single agent step are logically independent — looking up two different entities in a database, fetching weather and news simultaneously, reading multiple files at once.

Sequential execution of four 300ms API calls takes 1,200ms. Parallel execution takes 300ms — the time of the single longest call. For user-facing applications, this 4× latency reduction is often the difference between a responsive and frustrating experience.

### When Parallel Execution Is Safe

The safety boundary for parallelization follows a simple rule identified in 2025 practice:

**Read-only operations can always be parallelized.** Database reads, API GET calls, file reads, search queries — none of these have side effects that could create race conditions.

**State-modifying operations require sequential execution.** Write operations, API calls with side effects, operations with order dependencies — these must remain serialized to prevent consistency violations.

This read/write distinction can often be encoded directly in tool schema metadata, enabling the agent runtime to automatically determine which tools within a batch can be parallelized.

### Reinforcement Learning for Parallel Call Identification

The "Parallel Tool Call Learning" research (agentic-patterns.com) demonstrated that RL-trained models learn to identify independent sub-queries and issue them as parallel batches *without explicit programming*. Models trained on execution traces with parallelism reward signals achieved 40–50% latency reduction on applicable query types, with parallelism emerging as a learned behavior rather than a hardcoded rule.

### SPAgent: Speculative Parallel Execution

The 2025 SPAgent framework (arxiv 2507.08944) generalized parallel execution to include *speculative* tool calls — preemptively calling tools that are likely to be needed based on intermediate results, before the decision to use them is formally made. By combining adaptive speculation with scheduling, SPAgent achieved up to 1.65× end-to-end speedup on sequential multi-step tasks.

The risk management mechanism is key: speculative calls that turn out to be unnecessary are discarded, with only their token cost (the result that enters context) as the penalty. The framework optimizes the speculation policy to ensure the expected speedup exceeds the expected waste cost.

---

## Axis 4: Trajectory Reduction

### The Compounding Context Problem

Each tool call leaves a permanent trace in the agent's context: the tool invocation request (output tokens at call time) and the tool result (input tokens at every subsequent step). For a 20-step trajectory with 10 tool calls returning 500 tokens each, the final inference step processes 5,000 tokens of tool history — the majority of which may be irrelevant to the current decision.

This is what the September 2025 AgentDiet paper (arXiv 2509.23586) calls the "ever-growing trajectory" problem: **useless, redundant, and expired information proliferates in trajectories**, and current agents make no effort to prune it.

### AgentDiet: Automated Trajectory Pruning

AgentDiet identifies three categories of waste in agent trajectories:

**Useless information:** Tool results that turned out to be irrelevant to the final task. A search result that the agent glanced at but didn't use for any subsequent step can be dropped safely.

**Redundant information:** Duplicate or near-duplicate content across tool calls. If two database queries returned overlapping records, only the unique content needs to be retained.

**Expired information:** Early-trajectory state that has been superseded by later tool calls. An initial user profile lookup may be "expired" once a more specific profile query returned richer data.

AgentDiet's automated identification of these categories reduced input tokens by 39.9–59.7% across benchmark tasks, translating to 21.1–35.9% computational cost reduction with no statistically significant performance degradation.

### Acon: Context Compression with LLM-Generated Guidelines

The Acon framework (arXiv 2510.00615) addressed trajectory reduction through a different mechanism: rather than automated rule-based pruning, Acon uses a capable LLM to analyze *why* agents fail on given tasks, then distills those failure patterns into compression guidelines. These guidelines encode what information in trajectories tends to be critical versus discardable for specific task types.

The approach achieved strong results on long-horizon tasks where simple rule-based pruning would lose critical early-trajectory context that domain-aware compression retains.

### Practical Patterns for Trajectory Management

Beyond research frameworks, production teams have converged on several lightweight patterns:

**Result summarization:** After a tool returns a large response, a small model (or structured prompt) summarizes it to the key facts needed for the current step before it enters the main context.

**Sliding window with pinning:** Maintain a sliding context window that drops old steps, but "pin" certain critical observations (initial task description, key constraints discovered) so they persist throughout the trajectory.

**Step-level state extraction:** After each tool call, explicitly update a structured state object with key findings, and pass that structured state (not the raw tool output) to subsequent steps.

---

## Axis 5: Tool Design Discipline

### The Upstream Source of Tool-Use Failures

Many tool-use inefficiencies originate not in model behavior but in poor tool design. When tools are badly documented, poorly scoped, or have ambiguous schemas, models make more errors, require more retries, and make more calls than tasks actually require.

The statsig.com analysis of production tool calling identified tool documentation as the highest-leverage optimization point — poor docs cause models to hallucinate parameters, call the wrong tool for a task, or make redundant calls to triangulate what a tool actually does.

**A well-designed tool definition includes:**
- A purpose line that states exactly what the tool does and when to use it (not just a name)
- A negative statement: when *not* to use this tool (prevents misuse)
- 1–2 concrete usage examples in the description
- Strict typed schemas with meaningful constraints (enum values rather than free strings where possible)
- Return value documentation that sets expectations for downstream processing

### Namespace and Scope Discipline

As tool catalogs grow, grouping and naming become critical. Tools that are too broadly scoped (one tool handling 12 related but distinct operations via a `mode` parameter) force models to reason about the internal branching logic rather than selecting the right tool directly. Tools that are too narrowly scoped (separate tools for every minor variation) create unnecessary selection complexity.

The principle: **each tool should do exactly one thing, with its name stating what that thing is**. The model should be able to select the right tool from its name alone; the schema and docs are confirmation, not the primary signal.

### Return Value Trimming

Tool results should return only the information the agent actually needs for subsequent decisions. Returning a full API response with 40 fields when only 3 are relevant to the current task pollutes the context with noise and consumes unnecessary tokens. A lightweight transformation layer between the raw API response and what enters the agent context dramatically improves downstream reasoning quality and reduces context pollution.

---

## Evaluation: Benchmarks and Measurement

### The BFCL Standard

The Berkeley Function Calling Leaderboard (BFCL) has become the de facto standard for evaluating tool-calling capability. BFCL V4 Agentic (July 2025) extended evaluation beyond single-turn function calls to realistic agentic scenarios: multi-hop reasoning with web search, agent memory management across turns, error recovery, and format sensitivity.

BFCL evaluates using Abstract Syntax Tree (AST) comparison rather than string matching, making it robust to irrelevant formatting variation while sensitive to semantic call correctness.

### ToolBench and API-Bank

ToolBench (ICLR 2024 spotlight) provides an end-to-end platform for training, serving, and evaluating tool-learning models at scale, with reliable tool-use rates for modern 7B–32B parameter models now routinely exceeding 70%. API-Bank offers a more constrained but highly curated benchmark of 73 tools with 314 annotated dialogues, useful for regression testing.

### Production Metrics

For teams building production agents, benchmark scores are necessary but not sufficient. The most actionable production metrics are:

- **Tool call rate per task completion** (lower is better for simple tasks; should trend down over time)
- **First-call success rate** (fraction of tool calls that succeed without retry)
- **Unnecessary call rate** (calls where the result doesn't affect the agent's subsequent action)
- **Trajectory token cost per task** (tracks the compounding-context problem directly)
- **P95 end-to-end latency** (captures the user experience impact of sequential tool chains)

LangSmith's "waterfall" view is particularly useful here — it visualizes which tool calls contribute most to overall latency and identifies sequential chains that could be parallelized.

---

## A Practical Optimization Roadmap

For agent teams looking to systematically improve tool-use efficiency, a phased approach prioritizes the highest-leverage interventions:

**Phase 1 — Tool design audit (highest leverage, zero model changes):**
Review all tool definitions for documentation quality, scope clarity, and return value trimming. Fix ambiguous names, add negative-use statements, trim response payloads. This alone typically reduces error/retry rates by 20–40%.

**Phase 2 — Parallelization pass:**
Identify tool call patterns in production traces where independent read operations are executed sequentially. Add parallel execution for these cases. Expected latency reduction: 30–60% for affected query types.

**Phase 3 — Tool RAG for large catalogs:**
If the tool catalog exceeds ~20 tools, implement semantic retrieval to present only relevant tools per query. Reduces both token costs and selection confusion. Expected improvement: 2–4× selection accuracy on complex queries.

**Phase 4 — Trajectory pruning:**
Instrument trajectory token counts. If tool history dominates context (>50% of input tokens in late steps), implement result summarization or sliding-window pruning. Expected cost reduction: 30–55%.

**Phase 5 — Alignment fine-tuning:**
For high-volume deployments where tool call patterns are well-understood, construct preference datasets that reward appropriate tool-use decisions and fine-tune with DEPO or similar approaches. Expected improvement: further 20–40% reduction in unnecessary calls, with possible accuracy gains.

---

## Implications for Zylos

Several of these findings apply directly to Zylos's architecture:

**Tool RAG is relevant at the skill level.** As the Zylos skill catalog grows, dynamically selecting which skills to surface for a given task (rather than exposing all skill capabilities to every context) would reduce system prompt bloat and improve routing accuracy. The existing MCP research from the timeline provides a natural implementation path.

**Trajectory pruning matters for long-running sessions.** Zylos operates in multi-turn sessions that can accumulate substantial tool-call history. Implementing lightweight result summarization — especially for tool calls that return large JSON blobs — would reduce per-step inference costs on extended tasks.

**The forced-reasoning-trace pattern is immediately applicable.** Adding brief pre-call justifications to Zylos's tool invocation behavior (already partly present via reasoning traces) would improve auditability and reduce impulsive tool calls that don't contribute to task completion.

**Parallel execution is underutilized.** Many Zylos tasks involve independent reads (checking memory files, querying the scheduler, reading config) that are currently serialized. Identifying and parallelizing these would reduce response latency for complex multi-source lookups.

---

## Conclusion

Tool-use optimization has matured from an afterthought into a first-class engineering discipline. The five axes surveyed here — Tool RAG for dynamic selection, alignment for smarter invocation decisions, parallel execution for latency, trajectory reduction for context management, and tool design discipline for upstream quality — each address a distinct failure mode with concrete, measurable techniques.

The field has benefited from a wave of 2025 research (AgentDiet, DEPO, Acon, BFCL V4, the alignment framework from arXiv 2503.06708) that provides both theoretical foundations and empirical results. For practitioners, the highest-leverage interventions require no model changes — tool documentation quality and result payload trimming deliver immediate ROI at zero training cost.

As agentic systems take on longer, more complex tasks with larger tool catalogs, the efficiency gap between optimized and naively implemented tool-use will grow. Teams that treat tool-use efficiency as a first-class concern — measuring it, designing for it, and continuously improving it — will achieve substantially better user experiences and economics than those treating tool calls as free operations.

---

## Sources

- [Alignment for Efficient Tool Calling of Large Language Models (arXiv 2503.06708)](https://arxiv.org/abs/2503.06708)
- [Improving the Efficiency of LLM Agent Systems through Trajectory Reduction (AgentDiet, arXiv 2509.23586)](https://arxiv.org/abs/2509.23586)
- [DEPO: Dual-Efficiency Preference Optimization for LLM Agents (arXiv 2511.15392)](https://arxiv.org/html/2511.15392)
- [Acon: Optimizing Context Compression for Long-horizon LLM Agents (arXiv 2510.00615)](https://arxiv.org/html/2510.00615v1)
- [Tool RAG: The Next Breakthrough in Scalable AI Agents — Red Hat Emerging Technologies](https://next.redhat.com/2025/11/26/tool-rag-the-next-breakthrough-in-scalable-ai-agents/)
- [Tool-to-Agent Retrieval: Bridging Tools and Agents for Scalable LLM Multi-Agent Systems (arXiv 2511.01854)](https://arxiv.org/html/2511.01854v1)
- [Tool Calling Optimization: Efficient Agent Actions — Statsig](https://www.statsig.com/perspectives/tool-calling-optimization)
- [How Poor Tool Calling Behavior Increases LLM Cost and Latency — DEV Community](https://dev.to/amartyajha/how-poor-tool-calling-behavior-increases-llm-cost-and-latency-3idf)
- [Why Parallel Tool Calling Matters for LLM Agents — CodeAnt AI](https://www.codeant.ai/blogs/parallel-tool-calling)
- [Berkeley Function Calling Leaderboard (BFCL) V4](https://gorilla.cs.berkeley.edu/leaderboard.html)
- [Evaluating Tool Calling Capabilities in Large Language Models — Quotient AI](https://blog.quotientai.co/evaluating-tool-calling-capabilities-in-large-language-models-a-literature-review/)
- [Optimizing Sequential Multi-Step Tasks with Parallel LLM Agents (arXiv 2507.08944)](https://arxiv.org/html/2507.08944v1)
- [AI Agent Latency: How do I speed up my AI agent? — LangChain Blog](https://blog.langchain.com/how-do-i-speed-up-my-agent/)
