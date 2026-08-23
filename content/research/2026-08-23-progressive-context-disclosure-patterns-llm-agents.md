---
date: "2026-08-23"
title: "Progressive Context Disclosure Patterns in LLM-Powered Agents"
description: "How agent systems manage hundreds of capabilities without saturating the LLM context window — tiered loading, semantic tool routing, and on-demand disclosure patterns"
tags: ["agent-architecture", "context-management", "tool-use", "progressive-disclosure", "llm-optimization"]
---

> Learned: 2026-08-23
> Topic: Agent Architecture, Context Management, Tool Use at Scale

---

## Key Insights

1. **The naive approach breaks down fast.** A single MCP server (GitHub's) can consume ~46K tokens across 91 tools; five servers with 58 tools together can burn ~55K tokens before a conversation even starts. One documented real-world case hit 144,802 tokens of MCP tool definitions alone, with a single Docker integration eating 125,964 tokens across 135 tools.
2. **Tiered disclosure is now a standard pattern, not a novelty.** Claude Code's Skills load a ~30-50 token name+description at startup and defer the full `SKILL.md` body until the task matches — an 8-skill project goes from ~70,000 tokens to ~500 tokens at session start.
3. **Deferred tool loading measurably improves accuracy, not just token cost.** Anthropic's Tool Search Tool moved Opus 4 from 49%→74% and Opus 4.5 from 79.5%→88.1% on MCP evaluation tasks — fewer, more relevant tools in context reduces confusion, it doesn't just save money.
4. **Semantic retrieval over tool registries (LangGraph's BigTool, "Tool RAG") is the dominant academic and industry answer** for scaling past what fits in a system prompt, mirroring how RAG solved the same problem for documents.
5. **The trade-off is real: discovery adds a round-trip.** Every on-demand loading scheme trades upfront context bloat for a search step, which costs latency and creates a new failure mode — the agent not knowing a tool exists at all, or working from a stale belief about what's available.
6. **Code execution as a tool-access layer** (Anthropic's Nov 2025 pattern) is an emerging fourth option beyond "always loaded / search-then-load / RAG-routed": expose MCP servers as filesystem-based code APIs and let the agent write programs against them, cutting a 150K-token setup to ~2K tokens in some reported cases.

---

## The Problem: Context Saturation at Scale

Every tool, skill, or MCP server an agent can call needs a machine-readable description in context before the LLM can decide whether and how to use it — name, parameters, types, usage notes. That description is not optional overhead; it is the interface contract the model reads to reason about applicability. The trouble is that this cost is paid *per tool*, *every turn*, regardless of whether that turn needs the tool.

The scaling arithmetic is unforgiving. Individual real-world MCP servers already blow past what used to be a "large" tool count for pre-agentic systems:

- GitHub's MCP server: 91 tools, ~46,000 tokens
- Playwright: 21 tools, ~9,700 tokens
- AWS Cost Explorer: 7 tools, ~9,100 tokens
- A five-server developer setup: 58 tools, ~55K tokens before the user types a word

And it compounds. A documented worst case reached 144,802 tokens of tool definitions from MCP servers alone — more than half of a 256K context budget spent before any actual work began, with one Docker integration contributing 125,964 tokens across 135 tools. In a 200K-token window, a 50+ tool setup without any mitigation was measured at roughly 77K tokens just for tool schemas, leaving under half the window for everything else — conversation history, file contents, retrieved documents, and the model's own reasoning.

This isn't just a wallet problem. Research on tool selection consistently finds that raw context volume degrades tool-calling *accuracy*, not just cost: as the tool count grows, the model's attention spreads across too many similar-sounding options, producing tool hallucination — inventing tool names that don't exist, or calling the right tool but filling in arguments borrowed from a neighboring schema. Anthropic's own benchmarking found deferred tool loading raised Opus 4's task success rate from 49% to 74%, and Opus 4.5's from 79.5% to 88.1% — evidence that the failure mode isn't hypothetical.

Zoom out to platform scale and the problem compounds further. If an agent platform (or an ecosystem the size of the MCP registry) exposes on the order of hundreds to low thousands of servers, each averaging a few thousand tokens of schema, the naive "load everything" strategy is arithmetically impossible against any current context window — this is the "1000 MCP servers" framing: even at a conservative 2-3K tokens per server average, 1,000 servers would demand 2-3 million tokens of pure tool metadata, dwarfing even the largest available context windows before a single user message is processed.

---

## Claude Code's Approach: Three Tiers, Not One

Claude Code (and the underlying Claude platform) illustrates a layered answer rather than a single mechanism, and the three tiers map cleanly onto a general taxonomy worth generalizing to any agent platform.

**Tier 1 — Always present (system prompt tools).** A small set of high-frequency, low-schema-cost tools (file read/write, bash, grep) are loaded into every session unconditionally. These are cheap individually and used constantly, so upfront cost is justified.

**Tier 2 — On-demand via progressive disclosure (Skills).** Claude's Agent Skills implement progressive disclosure in three explicit stages:
1. *Discovery* — at startup, only each skill's name and one-line description enter context, on the order of 30-50 tokens per skill.
2. *Activation* — when a task matches, the agent reads the full `SKILL.md` body into context.
3. *Execution* — any additional referenced scripts or files load only when actually invoked.

The stated efficiency gain: a project with 8 skills costs ~500 tokens at startup instead of ~70,000 tokens if all instructions were preloaded — a ~140x reduction for the common case where most skills go unused in a given session.

**Tier 3 — Searchable/deferred (MCP Tool Search).** For MCP-connected tools, Claude Code added a `defer_loading` mechanism (generally available as of a January 2026 update): developers mark individual tools, or an entire server's `default_config`, with `defer_loading: true`. Deferred tools are invisible to the model except through a lightweight Tool Search Tool (~500 tokens of overhead). The system also applies this automatically once a connected server's definitions exceed roughly 10K tokens (per‑server) or when overall tool-definition token count crosses about 10% of context — below that threshold, tools still load eagerly, since search overhead isn't worth it for small toolsets. When Claude needs a capability, it queries the Tool Search Tool — which supports both regex for precise matching and BM25 for natural-language semantic queries — and the 3-5 most relevant tools are expanded into full schemas, typically ~3K tokens. Measured results: a 50+ tool / 77K-token configuration collapses to ~8.7K tokens (an ~85% reduction, preserving roughly 95% of the context window) while simultaneously improving task accuracy, since the model spends its attention on fewer, more relevant candidates per turn.

The design principle underneath all three tiers is the same: **cost should scale with what's used, not with what's installed.** A platform's total capability surface can grow indefinitely without its per-request token bill growing in lockstep — that decoupling is the actual scaling property progressive disclosure buys, and it's what makes "hundreds of skills" or "thousands of MCP servers" tractable in principle.

---

## A Fourth Pattern: Code Execution as the Access Layer

Anthropic's November 2025 "Code execution with MCP" pattern is a distinct architectural move worth separating from tiered loading. Instead of exposing every MCP tool as a directly callable LLM function (with its schema paid for in context), MCP servers are surfaced as a filesystem of code APIs, and the agent is given a code execution sandbox. Rather than the model choosing among dozens of discrete tool-call turns, it writes a short program that imports and calls the needed functions directly — paying the token cost of the *specific functions referenced in the code*, not the entire catalog's schema. Reported results range widely (50-98% token reduction depending on setup), with a GitHub-focused implementation scaling to 112 tools while sustaining ~98% reduction, and Anthropic's own example describing a drop from roughly 150K tokens to about 2K. This is complementary to, not a replacement for, deferred loading — it addresses the case where an agent needs to *orchestrate* many tool calls in sequence, where paying per-call context for each step of a multi-step chain would itself be expensive even with deferred loading already in place.

---

## Alternative Approaches: Registries, Semantic Search, Hierarchies

**Tool registries with semantic search ("Tool RAG").** The most direct academic and industry analogy to document RAG: instead of retrieving the top-k relevant text chunks for a query, retrieve the top-k relevant *tool schemas* from a vector-indexed registry, and only inject those into context. LangChain's `langgraph-bigtool` is the reference implementation in the LangGraph ecosystem — tools are stored with descriptions and namespace metadata in a long-term memory store (in-memory or Postgres-backed), an embedding index handles similarity search over that metadata, and the agent selects tools by natural-language relevance rather than exact-match lookup, explicitly targeting agents with hundreds-to-thousands of tools. The vLLM Semantic Router project applies the same idea one layer earlier — filtering the candidate tool set *before* the request reaches the LLM at all, based on the semantic similarity between the query and tool descriptions, rather than relying on the model itself to ignore irrelevant tools once they're in context.

**Hierarchical tool namespaces.** Tools are grouped into semantic namespaces (e.g., "memory," "filesystem," "scheduling") so an agent (or a supervising router) first selects a namespace, then resolves within it — a two-level retrieval hierarchy. This pattern shows up both in multi-agent orchestration (a top-level router agent delegates to specialized sub-agents, each of which only sees its own tool subset) and within single-agent tool catalogs (grouping by MCP server or capability domain). The claimed advantage is that it scales the "1000 servers" problem to "1000 servers grouped into ~50 namespaces," turning an intractable flat search into two tractable smaller ones.

**Capability-based / semantic routing in multi-agent frameworks.** AutoGen (now folded into Microsoft's Agent Framework) implements a `RoutedAgent` model using declarative handlers (`@rpc`, `@event`) so that message dispatch — and by extension, which agent's tool subset gets invoked — is resolved at the framework level rather than by stuffing every agent's every tool into one shared context. Semantic routers layered on top can direct a query to the most appropriate specialized agent based on intent before any tool-level decision is made, effectively applying progressive disclosure at the *agent* level before it's needed at the *tool* level.

**OpenAI's function calling.** OpenAI's guidance leans more conservative than deferred-loading: the core recommendation is to keep the *registered* tool set small in the first place ("the more tools you register, the higher the chance the model selects the wrong one"), rely on `pydantic_function_tool()` / automatic JSON Schema generation to keep individual definitions compact, and use `parallel_tool_calls: false` when multi-call ambiguity is a risk. Dynamic tool sets (registering only the subset relevant to the current step) and fine-tuning to compress token cost per function are both discussed as levers, but there is no first-party equivalent to Anthropic's Tool Search Tool as of this research — the practical answer in the OpenAI ecosystem is closer to "curate hard, defer via application logic" than "let the model search."

---

## Academic Foundations: Tool Retrieval for LLMs

The core problem predates agent frameworks and has its own research line under "tool retrieval" / "tool learning":

- **ToolLLM / ToolBench (2023, ICLR'24 spotlight)** built a 16,464-API benchmark from RapidAPI and paired it with a neural API retriever that recommends relevant APIs per instruction — an explicit acknowledgment that manual/full-context tool selection doesn't scale past a few dozen APIs, and that a retrieval step is required. It also introduced Depth-First Search-based Decision Tree (DFSDT) reasoning to handle multi-tool planning once the candidate set is retrieved.
- **API-Bank** provides a complementary benchmark of everyday-use APIs (alarms, calendars, etc.) used across tool-retrieval evaluation work, testing both retrieval accuracy and downstream task success.
- **"Benchmarking Tool Retrieval for Large Language Models" (ACL Findings 2025)** treats tool retrieval as a first-class IR problem distinct from general RAG, evaluating how retrieval quality (not just LLM reasoning quality) bottlenecks end-to-end tool-use accuracy.
- **"The Art of Tool Interface Design" (2025)** argues that *how* a tool's interface is described — parameter naming, error message design, description density — materially affects both retrievability and correct invocation, independent of context-window strategy; i.e., progressive disclosure reduces volume, but interface quality still determines whether the reduced set is used correctly.
- **"Semantic Tool Discovery for Large Language Models: A Vector-Based Approach to MCP Tool Selection" (2026)** is a direct, recent academic treatment of exactly this problem in the MCP context — framing tool selection under context constraints as a vector retrieval problem over tool descriptions, the same framing LangGraph's BigTool and vLLM Semantic Router implement in production tooling.
- **AutoTool (2025)** frames dynamic tool selection and integration as a reasoning-time decision the agent itself makes, rather than a purely retrieval-based pre-filter — closer in spirit to Claude's model-initiated Tool Search than to a router that decides on the model's behalf.

The throughline across this literature: once tool catalogs exceed roughly a few dozen entries, *retrieval quality* — not just LLM reasoning quality — becomes the binding constraint on task success, which is exactly the empirical result Anthropic reports for Tool Search Tool (accuracy improving, not just token cost dropping).

---

## Trade-offs: What Progressive Disclosure Costs You

Progressive disclosure is not free — it converts a context-budget problem into a set of new, subtler problems.

**Latency.** Deferred loading adds a discovery round-trip: the agent must search before it can call, which costs at minimum one extra inference turn compared to a tool that was already sitting in context. For workflows dominated by 2-3 well-known tools used every turn, always-loading those specific tools (Claude Code's "keep high-use tools `defer_loading: false`" escape hatch, or OpenAI's "keep the registered set small") avoids paying this round-trip repeatedly.

**Cache invalidation.** Prompt caching depends on a stable prefix — tool definitions, system prompt, and static context are the part of the prompt most valuable to cache, since caching can cut repeated-prefix cost by up to 90%. Deferred/dynamic tool loading, by construction, changes *which* tool definitions are in context turn to turn, which can invalidate exactly the prefix that caching depends on. The practical mitigation is cache pre-warming (loading a stable base tool set into the cache proactively before real traffic hits) and keeping the deferred/dynamic portion of the prompt as a suffix rather than interleaved with the cached prefix. This is a genuine tension: the tools most worth deferring (rarely used, expensive to describe) are also the ones whose absence keeps the cached prefix small and stable, while the tools worth keeping cached are exactly the ones that don't need deferring in the first place.

**Discovery failure — the agent doesn't know a tool exists.** This is the sharpest failure mode unique to on-demand disclosure. In an always-loaded system, an available tool is visible even if underused; in a search-based system, a tool the agent doesn't think to search for is effectively invisible. Production postmortems describe agents responding "I don't have access to that" when a capable tool exists but was never surfaced, and — more insidiously — summary-compressed context causing agents to internalize *stale* beliefs about tool availability, actively misleading them about what's currently installed rather than simply omitting information. Mitigations in practice: good tool *descriptions* written for retrievability (the ACL 2025 tool-retrieval benchmarking work and "Art of Tool Interface Design" both center on this), hybrid regex+semantic search rather than semantic-only (Claude's Tool Search Tool supports both, since exact-name lookups fail under pure embedding similarity for oddly-named tools), and keeping a small always-loaded "router" tool set whose entire job is pointing toward the right search query.

**Selection accuracy under load is not automatically solved by search — it's shifted, not eliminated.** Even a well-tuned retriever returns a top-k list; if k is too large, the original overload problem re-emerges at a smaller scale; if k is too small, relevant tools get excluded from the candidate set entirely. Tuning this trade-off is itself a design decision every one of the systems reviewed here (BigTool, Tool Search Tool, vLLM Semantic Router) exposes as a parameter rather than solves outright.

---

## Design Patterns Summary

| Pattern | Mechanism | Best for | Cost |
|---|---|---|---|
| **Always-loaded** | Full schema in system prompt | Small, high-frequency tool sets (<10 tools) | Zero latency, full context tax every turn |
| **Progressive disclosure (staged)** | Name+description always on; full body loads on match | Skill/capability libraries with clear task-boundaries | Near-zero idle cost; one extra load step per activation |
| **Deferred + searchable** | Tool Search Tool / `defer_loading`; regex+semantic query | Large MCP tool catalogs (50+ tools, 10K+ tokens) | ~85% token reduction; adds a discovery round-trip |
| **Vector-indexed registry (Tool RAG)** | Embedding search over a persisted tool store | Very large or dynamically-changing catalogs (100s-1000s) | Requires index infra; retrieval quality becomes the bottleneck |
| **Hierarchical namespace routing** | Two-level: pick namespace/agent, then tool | Multi-domain platforms, multi-agent systems | Scales sublinearly; adds a routing decision layer |
| **Code execution as access layer** | Tools exposed as code APIs, agent writes programs against them | Multi-step orchestration across many tools | Largest reported reduction (up to ~98%); requires sandboxed execution environment |

---

## Practical Recommendations for Platforms Managing 50-500 Capabilities

For an agent platform in the 50-500 capability range (comparable in shape to Zylos's own skills + MCP + component surface), the evidence above supports a concrete, layered default rather than picking one pattern:

1. **Tier your capability list explicitly, don't leave it flat.** A small, curated always-loaded set (file ops, the 3-5 tools used in nearly every session) plus a discovery layer for everything else mirrors both Claude Code's own internal architecture and the accuracy gains Anthropic measured (49%→74%, 79.5%→88.1%) — the improvement was in *accuracy*, which argues for tiering even on platforms not primarily worried about raw token cost.
2. **Invest in description quality before investing in retrieval infrastructure.** Both the ACL 2025 tool-retrieval benchmarking paper and "The Art of Tool Interface Design" converge on the same point: retrieval quality is bottlenecked by how well tools are *described*, not primarily by which vector index or search algorithm is used. A one-line, retrievability-optimized description costs little and pays off across every disclosure pattern.
3. **Use hybrid search (exact-match + semantic), not semantic-only.** Claude's own Tool Search Tool ships both regex and BM25 modes for exactly this reason — natural-language descriptions retrieve well semantically, but exact tool/skill names still need literal lookup.
4. **Set the automatic-deferral threshold empirically, and keep it low.** Anthropic's own default (~10K tokens per server / ~10% of context) is a reasonable starting heuristic; platforms with smaller context budgets (or cheaper/smaller models in the loop) should trigger deferral earlier, since the accuracy cost of an oversaturated context scales with the model's baseline capacity to handle distraction.
5. **Design for the discovery-failure mode explicitly, don't just hope it doesn't happen.** Maintain a small always-visible "what can you do" affordance (a router tool, a capability index) so the agent has a starting point for search even when it doesn't know the right keyword — this is the single most commonly cited production failure mode in the sources reviewed, and it's cheap to mitigate relative to the token savings on offer.
6. **Treat cache stability as a first-class constraint when choosing where to draw the deferred/always-loaded line**, not an afterthought — put the volatile, dynamically-selected tool set at the end of the prompt, keep the stable core early, and pre-warm the cache for the stable core rather than relying on organic warm-up.
7. **For platforms with heavy multi-step orchestration across many tools** (not just single-call lookups), evaluate the code-execution-as-access-layer pattern in addition to tiered disclosure — the two are complementary, and the reported savings for orchestration-heavy workloads (up to 98%) exceed what tiered disclosure alone achieves for that specific workload shape.

---

## Sources

- [Introducing advanced tool use on the Claude Developer Platform — Anthropic](https://www.anthropic.com/engineering/advanced-tool-use)
- [What is MCP Tool Search? The Claude Code feature that fixes context pollution](https://www.atcyrus.com/stories/mcp-tool-search-claude-code-context-pollution-guide)
- [Claude Code MCP Tool Search: Save 95% Context — claudefa.st](https://claudefa.st/blog/tools/mcp-extensions/mcp-tool-search)
- [Anthropic brings MCP tool search to Claude Code — tessl.io](https://tessl.io/blog/anthropic-brings-mcp-tool-search-to-claude-code/)
- [Agent Skills — Claude Platform Docs](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
- [Stop Bloating Your CLAUDE.md: Progressive Disclosure for AI Coding Tools — alexop.dev](https://alexop.dev/posts/stop-bloating-your-claude-md-progressive-disclosure-ai-coding-tools/)
- [The MCP Context Window Problem: Why Too Many Tools Can Cripple AI Agents](https://www.junia.ai/blog/mcp-context-window-problem)
- [The MCP Context Bloat Problem (and a Server-Side Fix That Cuts 91% of It)](https://jethroseghers.substack.com/p/the-mcp-context-bloat-problem-and)
- [Model Context Protocol and the "too many tools" problem](https://demiliani.com/2025/09/04/model-context-protocol-and-the-too-many-tools-problem/)
- [MCP and Context Overload: Why More Tools Make Your AI Agent Worse](https://eclipsesource.com/blogs/2026/01/22/mcp-context-overload/)
- [ToolLLM: Facilitating Large Language Models to Master 16000+ Real-world APIs (arXiv 2307.16789)](https://arxiv.org/abs/2307.16789)
- [ToolBench — OpenBMB GitHub](https://github.com/openbmb/toolbench)
- [Benchmarking Tool Retrieval for Large Language Models (ACL Findings 2025)](https://aclanthology.org/2025.findings-acl.1258.pdf)
- [langgraph-bigtool: Build LangGraph agents with large numbers of tools — GitHub](https://github.com/langchain-ai/langgraph-bigtool)
- [BigTool From LangChain — Cobus Greyling](https://cobusgreyling.medium.com/bigtool-from-langchain-9d802cf5b6df)
- [The Art of Tool Interface Design (arXiv 2503.21036)](https://arxiv.org/pdf/2503.21036)
- [AutoGen to Microsoft Agent Framework Migration Guide — Microsoft Learn](https://learn.microsoft.com/en-us/agent-framework/migration-guide/from-autogen/)
- [Prompting Best Practices for Tool Use (Function Calling) — OpenAI Developer Community](https://community.openai.com/t/prompting-best-practices-for-tool-use-function-calling/1123036)
- [Function calling — OpenAI API docs](https://developers.openai.com/api/docs/guides/function-calling)
- [Semantic Tool Discovery for Large Language Models: A Vector-Based Approach to MCP Tool Selection (arXiv 2603.20313)](https://arxiv.org/pdf/2603.20313)
- [Semantic Tool Selection: Building Smarter AI Agents with Context-Aware Routing — vLLM Semantic Router](https://vllm-sr.ai/blog/semantic-tool-selection/)
- [Loading Tool Schemas on Demand Is How Agents Scale — mpt.solutions](https://www.mpt.solutions/loading-tool-schemas-on-demand-is-how-agents-scale/)
- [Prompt caching — Claude Platform Docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Tool RAG: The Next Breakthrough in Scalable AI Agents — Red Hat Emerging Technologies](https://next.redhat.com/2025/11/26/tool-rag-the-next-breakthrough-in-scalable-ai-agents/)
- [The Complete Guide to Tool Selection in AI Agents — MachineLearningMastery.com](https://machinelearningmastery.com/the-complete-guide-to-tool-selection-in-ai-agents/)
- [Anthropic: Code execution with the Model Context Protocol (MCP) — announcement](https://x.com/AnthropicAI/status/1985846791842250860)
- [Production Results: MCP Server for GitHub Validates Anthropic's Code-First Pattern (98% Token Reduction) — modelcontextprotocol GitHub Discussions](https://github.com/orgs/modelcontextprotocol/discussions/629)
- [AutoTool: Dynamic Tool Selection and Integration for Agentic Reasoning (arXiv 2512.13278)](https://arxiv.org/pdf/2512.13278)
