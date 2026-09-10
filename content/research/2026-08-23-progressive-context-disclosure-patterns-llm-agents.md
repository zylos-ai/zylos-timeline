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

1. **The naive approach breaks down fast.** A single MCP server (GitHub's) can consume ~46K tokens across 91 tools; five servers with 58 tools together can burn ~55K tokens before a conversation even starts. In one user-reported Claude Code `/doctor` output, MCP tool definitions occupied 144,802 tokens, including 125,964 tokens from a 135-tool Docker integration.
2. **Tiered disclosure is now a standard pattern, not a novelty.** Claude's Agent Skills load roughly 100 tokens of name-and-description metadata per skill at startup and defer the full `SKILL.md` body until the task matches. Eight skills therefore contribute roughly 800 startup tokens; the avoided cost depends on the actual size of their instruction bodies.
3. **Deferred tool loading measurably improves accuracy, not just token cost.** Anthropic's Tool Search Tool moved Opus 4 from 49%→74% and Opus 4.5 from 79.5%→88.1% on MCP evaluation tasks — fewer, more relevant tools in context reduces confusion, it doesn't just save money.
4. **Several retrieval designs now coexist.** LangGraph's BigTool uses embedding search over a tool registry; Anthropic provides separate regex and BM25 lexical search variants plus a custom-search path; OpenAI's GPT-5.4 API supports hosted or client-executed Tool Search. The evidence does not establish one universally dominant algorithm.
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

And it compounds. One Claude Code user posted `/doctor` output showing 144,802 tokens of MCP tool definitions — more than half of that session's 256K context budget — with a 135-tool Docker integration contributing 125,964 tokens. This is a practitioner report, not a controlled benchmark. In Anthropic's worked 200K-token example, a 50+ tool setup consumed roughly 77K tokens before work began, leaving 123K tokens, or 61.5% of the window, for conversation history, file contents, retrieved documents, and the model's own reasoning.

This isn't just a wallet problem. Research on tool selection consistently finds that raw context volume degrades tool-calling *accuracy*, not just cost: as the tool count grows, the model's attention spreads across too many similar-sounding options, producing tool hallucination — inventing tool names that don't exist, or calling the right tool but filling in arguments borrowed from a neighboring schema. Anthropic's own benchmarking found deferred tool loading raised Opus 4's task success rate from 49% to 74%, and Opus 4.5's from 79.5% to 88.1% — evidence that the failure mode isn't hypothetical.

Zoom out to platform scale and the problem compounds further. If an agent platform (or an ecosystem the size of the MCP registry) exposes on the order of hundreds to low thousands of servers, each averaging a few thousand tokens of schema, the naive "load everything" strategy is arithmetically impossible against any current context window — this is the "1000 MCP servers" framing: even at a conservative 2-3K tokens per server average, 1,000 servers would demand 2-3 million tokens of pure tool metadata, dwarfing even the largest available context windows before a single user message is processed.

---

## Claude Code's Approach: Three Tiers, Not One

Claude Code (and the underlying Claude platform) illustrates a layered answer rather than a single mechanism, and the three tiers map cleanly onto a general taxonomy worth generalizing to any agent platform.

**Tier 1 — Always present (system prompt tools).** A small set of high-frequency, low-schema-cost tools (file read/write, bash, grep) are loaded into every session unconditionally. These are cheap individually and used constantly, so upfront cost is justified.

**Tier 2 — On-demand via progressive disclosure (Skills).** Claude's Agent Skills implement progressive disclosure in three explicit stages:
1. *Discovery* — at startup, only each skill's name and description enter context, approximately 100 tokens per skill according to the Agent Skills documentation.
2. *Activation* — when a task matches, the agent reads the full `SKILL.md` body into context.
3. *Execution* — any additional referenced scripts or files load only when actually invoked.

At that documented estimate, eight skills contribute roughly 800 tokens of startup metadata. Their full instruction and resource cost is deferred until activation, so the reduction relative to eager loading depends on the actual files bundled with those skills rather than a universal multiplier.

**Tier 3 — Searchable/deferred tools.** The Claude API and Claude Code expose related behavior through different configuration contracts:

- **Claude API / MCP connector.** A client marks individual tool definitions with `defer_loading: true`; for an MCP connector it sets `mcp_toolset.default_config.defer_loading`, with per-tool overrides under `configs`. Anthropic's built-in Tool Search has two separate variants: case-insensitive Python regex, and BM25 queried with natural language. Both are lexical retrieval; embedding-based semantic search is an explicitly custom implementation option. Search returns up to five matches by default and expands their schemas inline.
- **Claude Code.** MCP Tool Search is controlled by `ENABLE_TOOL_SEARCH`: unset or `true` defers supported MCP tools by default, `false` loads them upfront, and `auto` / `auto:N` enables an overall context-percentage threshold (10% for `auto`). A server's `alwaysLoad: true` setting, or an individual tool's `anthropic/alwaysLoad` metadata, exempts it from deferral. These are Claude Code settings, not aliases for the API's `mcp_toolset` JSON fields.

Anthropic's worked example moves from ~77K tokens before work begins to ~8.7K. Those two figures imply an 88.7% reduction and leave about 95.7% of a 200K window free. Anthropic separately summarizes the result as an 85% reduction; that broader figure should not replace the arithmetic of the displayed example. The same evaluation reports Opus 4 improving from 49% to 74% and Opus 4.5 from 79.5% to 88.1%.

The design principle underneath all three tiers is the same: **for requests that use only a subset of the catalog, context cost should track what is surfaced rather than every capability installed.** This weakens the lockstep relationship between catalog size and per-request prompt cost, but it does not make growth unbounded: search quality, catalog metadata, latency, and provider limits still constrain the system.

---

## A Fourth Pattern: Code Execution as the Access Layer

Anthropic's November 2025 "Code execution with MCP" pattern is a distinct architectural move worth separating from tiered loading. Instead of exposing every MCP tool as a directly callable LLM function (with its schema paid for in context), MCP servers are surfaced as a filesystem of code APIs, and the agent is given a code execution sandbox. Rather than the model choosing among dozens of discrete tool-call turns, it writes a short program that imports and calls the needed functions directly — paying the token cost of the *specific functions referenced in the code*, not the entire catalog's schema. In Anthropic's worked example, the pattern reduces context use from about 150,000 tokens to 2,000, a 98.7% reduction for that workload. This is complementary to, not a replacement for, deferred loading — it addresses the case where an agent needs to *orchestrate* many tool calls in sequence, where paying per-call context for each step of a multi-step chain would itself be expensive even with deferred loading already in place.

---

## Alternative Approaches: Registries, Semantic Search, Hierarchies

**Tool registries with semantic search ("Tool RAG").** The most direct academic and industry analogy to document RAG: instead of retrieving the top-k relevant text chunks for a query, retrieve the top-k relevant *tool schemas* from a vector-indexed registry, and only inject those into context. LangChain's `langgraph-bigtool` is the reference implementation in the LangGraph ecosystem — tools are stored with descriptions and namespace metadata in a long-term memory store (in-memory or Postgres-backed), an embedding index handles similarity search over that metadata, and the agent selects tools by natural-language relevance rather than exact-match lookup, explicitly targeting agents with hundreds-to-thousands of tools. The vLLM Semantic Router project applies the same idea one layer earlier — filtering the candidate tool set *before* the request reaches the LLM at all, based on the semantic similarity between the query and tool descriptions, rather than relying on the model itself to ignore irrelevant tools once they're in context.

**Hierarchical tool namespaces.** Tools are grouped into semantic namespaces (e.g., "memory," "filesystem," "scheduling") so an agent (or a supervising router) first selects a namespace, then resolves within it — a two-level retrieval hierarchy. This pattern shows up both in multi-agent orchestration (a top-level router agent delegates to specialized sub-agents, each of which only sees its own tool subset) and within single-agent tool catalogs (grouping by MCP server or capability domain). It replaces one large flat decision with two smaller routing decisions; whether that improves quality or cost depends on namespace balance and router accuracy, not a guaranteed sublinear scaling law.

**Capability-based / semantic routing in multi-agent frameworks.** AutoGen (now folded into Microsoft's Agent Framework) implements a `RoutedAgent` model using declarative handlers (`@rpc`, `@event`) so that message dispatch — and by extension, which agent's tool subset gets invoked — is resolved at the framework level rather than by stuffing every agent's every tool into one shared context. Semantic routers layered on top can direct a query to the most appropriate specialized agent based on intent before any tool-level decision is made, effectively applying progressive disclosure at the *agent* level before it's needed at the *tool* level.

**OpenAI Tool Search.** On March 5, 2026, OpenAI introduced first-party Tool Search in the API with GPT-5.4. The Responses API can defer functions or MCP servers with `defer_loading: true`; the model then initiates discovery and loads matching definitions into the conversation. Hosted search lets OpenAI perform the lookup, while client-executed search lets an application supply the retrieved subset. For namespaces and MCP servers, the model initially sees only lightweight namespace/server metadata. OpenAI reports that putting 36 MCP servers behind Tool Search reduced total token use by 47% at the same accuracy on 250 MCP Atlas tasks. This is an API capability scoped to GPT-5.4 and later, not a claim about every OpenAI model or product surface.

---

## Academic Foundations: Tool Retrieval for LLMs

The core problem predates agent frameworks and has its own research line under "tool retrieval" / "tool learning":

- **ToolLLM / ToolBench (2023, ICLR'24 spotlight)** built a 16,464-API benchmark from RapidAPI and paired it with a neural API retriever that recommends relevant APIs per instruction — an explicit acknowledgment that manual/full-context tool selection doesn't scale past a few dozen APIs, and that a retrieval step is required. It also introduced Depth-First Search-based Decision Tree (DFSDT) reasoning to handle multi-tool planning once the candidate set is retrieved.
- **API-Bank** provides a complementary benchmark of everyday-use APIs (alarms, calendars, etc.) used across tool-retrieval evaluation work, testing both retrieval accuracy and downstream task success.
- **"Retrieval Models Aren't Tool-Savvy" / ToolRet (ACL Findings 2025)** introduces a 7.6K-task, 43K-tool benchmark and evaluates six retriever classes. It finds that strong general-purpose retrieval models can still perform poorly on tool retrieval, that weak retrieval lowers downstream tool-use pass rates, and that training on more than 200K tool-retrieval instances materially improves retrieval performance. Its evaluated classes include sparse lexical retrieval such as BM25 as well as dense and other learned retrievers.
- **"The Art of Tool Interface Design" (2025)** presents the Thinker framework for customer-service reasoning. Its tested mechanisms are state-machine tools for business logic, delegation to LLM-powered tools, and adaptive context management. It does not test whether parameter naming or description density dominates tool retrieval algorithms.
- **"Semantic Tool Discovery for Large Language Models: A Vector-Based Approach to MCP Tool Selection" (2026)** is a direct, recent academic treatment of exactly this problem in the MCP context — framing tool selection under context constraints as a vector retrieval problem over tool descriptions, the same framing LangGraph's BigTool and vLLM Semantic Router implement in production tooling.
- **AutoTool (2025)** frames dynamic tool selection and integration as a reasoning-time decision the agent itself makes, rather than a purely retrieval-based pre-filter — closer in spirit to Claude's model-initiated Tool Search than to a router that decides on the model's behalf.

Together, these results establish retrieval as a distinct source of error in large tool catalogs, not a universal threshold at which it becomes the sole binding constraint. ToolRet shows that retrieval misses reduce downstream pass rates across its benchmark, while Anthropic's separate MCP evaluations show higher task accuracy when only a focused subset of tools is loaded.

---

## Trade-offs: What Progressive Disclosure Costs You

Progressive disclosure is not free — it converts a context-budget problem into a set of new, subtler problems.

**Latency.** Deferred loading adds a discovery step before a tool can be called. For workflows dominated by a few well-known tools used every turn, keeping those tools non-deferred in the Claude API, or using Claude Code's `alwaysLoad` exception for a small MCP server, avoids repeated discovery.

**Cache stability depends on the loading mechanism.** Native deferred discovery in both Anthropic's and OpenAI's APIs is designed to preserve the stable cache prefix: deferred definitions are excluded from the prefix and discovered definitions are appended later in the conversation. Cache churn is instead a risk when application code adds, removes, or reorders top-level tool definitions, or changes a previously loaded client-supplied tool set. For such custom mutation, preserve ordering and append new definitions after the stable prefix; do not attribute that mitigation cost to native deferred loading itself.

**Discovery failure — the relevant tool is not surfaced.** In an always-loaded system, every available definition is visible; in a search-based system, a missed query or low-ranked match can exclude a capable tool from the candidate set. ToolRet demonstrates that retrieval quality affects downstream task success, while Anthropic's operational guidance recommends clear names, keyword-rich descriptions, consistent namespaces, visible category hints, and monitoring what Claude discovers. Anthropic's built-ins offer regex and BM25 as separate lexical choices; teams that need embedding-based semantic retrieval must implement a custom search path rather than assume a shipped hybrid.

**Selection accuracy under load is not automatically solved by search — it's shifted, not eliminated.** Even a well-tuned retriever returns a top-k list; if k is too large, the original overload problem re-emerges at a smaller scale; if k is too small, relevant tools get excluded from the candidate set entirely. Tuning this trade-off is itself a design decision every one of the systems reviewed here (BigTool, Tool Search Tool, vLLM Semantic Router) exposes as a parameter rather than solves outright.

---

## Design Patterns Summary

| Pattern | Mechanism | Best for | Cost |
|---|---|---|---|
| **Always-loaded** | Full schema in system prompt | Small, high-frequency tool sets (<10 tools) | Zero latency, full context tax every turn |
| **Progressive disclosure (staged)** | Name+description always on; full body loads on match | Skill/capability libraries with clear task-boundaries | Near-zero idle cost; one extra load step per activation |
| **Deferred + searchable** | Native tool search with deferred schemas; Anthropic offers separate regex and BM25 variants | Large MCP tool catalogs or tool definitions above the provider's recommended range | Can sharply reduce context use; adds a discovery step |
| **Vector-indexed registry (Tool RAG)** | Embedding search over a persisted tool store | Very large or dynamically-changing catalogs | Requires index infrastructure and task-specific retrieval evaluation |
| **Hierarchical namespace routing** | Two-level: pick namespace/agent, then tool | Multi-domain platforms, multi-agent systems | Shrinks each decision set but adds router error and latency |
| **Code execution as access layer** | Tools exposed as code APIs, agent writes programs against them | Multi-step orchestration across many tools | Largest reported reduction (up to ~98%); requires sandboxed execution environment |

---

## Practical Recommendations for Platforms Managing 50-500 Capabilities

For an agent platform in the 50-500 capability range (comparable in shape to Zylos's own skills + MCP + component surface), the evidence above supports a concrete, layered default rather than picking one pattern:

1. **Tier your capability list explicitly, don't leave it flat.** A small, curated always-loaded set (file ops, the 3-5 tools used in nearly every session) plus a discovery layer for everything else mirrors both Claude Code's own internal architecture and the accuracy gains Anthropic measured (49%→74%, 79.5%→88.1%) — the improvement was in *accuracy*, which argues for tiering even on platforms not primarily worried about raw token cost.
2. **Treat metadata quality and retrieval choice as separate levers.** Clear, keyword-rich names and descriptions help every search path, but ToolRet shows material differences among retriever classes and gains from domain-specific training. Improve metadata, then evaluate regex, BM25, embeddings, or learned retrievers against your own queries rather than assuming one factor dominates.
3. **Choose the search variant deliberately.** Anthropic's regex variant handles literal patterns, while BM25 provides natural-language lexical ranking; embeddings are available through a custom search implementation. A system may combine multiple retrievers at the application layer, but Anthropic does not ship regex and semantic retrieval as one hybrid algorithm.
4. **Configure deferral on the surface you actually run.** In the Claude API, use per-tool `defer_loading` or MCP `mcp_toolset.default_config` plus overrides. In Claude Code, use `ENABLE_TOOL_SEARCH` and reserve `alwaysLoad` for the small set that must be visible immediately. Treat the documented 10K-token / 10-tool guidance for the API and the optional 10%-of-context `auto` mode in Claude Code as separate starting points, then measure task accuracy and latency.
5. **Design for discovery misses explicitly.** Keep a small always-visible capability index or category hint, monitor which tools searches return, and test realistic paraphrases and exact names against the catalog. These mitigations are inexpensive compared with diagnosing a capable tool that retrieval never surfaced.
6. **Preserve cache stability according to the mechanism.** Native deferred search already appends discovered definitions without changing the cached prefix. If application code dynamically mutates top-level tools, keep the stable core ordered first and append changes rather than inserting or reordering definitions.
7. **For platforms with heavy multi-step orchestration across many tools** (not just single-call lookups), evaluate the code-execution-as-access-layer pattern in addition to tiered disclosure — the two are complementary, and the reported savings for orchestration-heavy workloads (up to 98%) exceed what tiered disclosure alone achieves for that specific workload shape.

---

## Sources

- [Introducing advanced tool use on the Claude Developer Platform — Anthropic](https://www.anthropic.com/engineering/advanced-tool-use)
- [What is MCP Tool Search? The Claude Code feature that fixes context pollution](https://www.atcyrus.com/stories/mcp-tool-search-claude-code-context-pollution-guide)
- [Claude Code MCP Tool Search: Save 95% Context — claudefa.st](https://claudefa.st/blog/tools/mcp-extensions/mcp-tool-search)
- [Anthropic brings MCP tool search to Claude Code — tessl.io](https://tessl.io/blog/anthropic-brings-mcp-tool-search-to-claude-code/)
- [Agent Skills — Claude Platform Docs](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
- [Stop Bloating Your CLAUDE.md: Progressive Disclosure for AI Coding Tools — alexop.dev](https://alexop.dev/posts/stop-bloating-your-claude-md-progressive-disclosure-ai-coding-tools/)
- [Claude Code issue #12241 — user-reported MCP tool-definition context usage](https://github.com/anthropics/claude-code/issues/12241)
- [The MCP Context Bloat Problem (and a Server-Side Fix That Cuts 91% of It)](https://jethroseghers.substack.com/p/the-mcp-context-bloat-problem-and)
- [Model Context Protocol and the "too many tools" problem](https://demiliani.com/2025/09/04/model-context-protocol-and-the-too-many-tools-problem/)
- [MCP and Context Overload: Why More Tools Make Your AI Agent Worse](https://eclipsesource.com/blogs/2026/01/22/mcp-context-overload/)
- [ToolLLM: Facilitating Large Language Models to Master 16000+ Real-world APIs (arXiv 2307.16789)](https://arxiv.org/abs/2307.16789)
- [ToolBench — OpenBMB GitHub](https://github.com/openbmb/toolbench)
- [Benchmarking Tool Retrieval for Large Language Models (ACL Findings 2025)](https://aclanthology.org/2025.findings-acl.1258.pdf)
- [langgraph-bigtool: Build LangGraph agents with large numbers of tools — GitHub](https://github.com/langchain-ai/langgraph-bigtool)
- [The Art of Tool Interface Design (arXiv 2503.21036)](https://arxiv.org/pdf/2503.21036)
- [AutoGen to Microsoft Agent Framework Migration Guide — Microsoft Learn](https://learn.microsoft.com/en-us/agent-framework/migration-guide/from-autogen/)
- [Prompting Best Practices for Tool Use (Function Calling) — OpenAI Developer Community](https://community.openai.com/t/prompting-best-practices-for-tool-use-function-calling/1123036)
- [Function calling — OpenAI API docs](https://developers.openai.com/api/docs/guides/function-calling)
- [Introducing GPT-5.4 — OpenAI](https://openai.com/index/introducing-gpt-5-4/)
- [Tool Search — OpenAI API docs](https://developers.openai.com/api/docs/guides/tools-tool-search)
- [Connect Claude Code to tools via MCP — Claude Code docs](https://code.claude.com/docs/en/mcp#configure-tool-search)
- [Semantic Tool Discovery for Large Language Models: A Vector-Based Approach to MCP Tool Selection (arXiv 2603.20313)](https://arxiv.org/pdf/2603.20313)
- [Semantic Tool Selection: Building Smarter AI Agents with Context-Aware Routing — vLLM Semantic Router](https://vllm-sr.ai/blog/semantic-tool-selection/)
- [Loading Tool Schemas on Demand Is How Agents Scale — mpt.solutions](https://www.mpt.solutions/loading-tool-schemas-on-demand-is-how-agents-scale/)
- [Prompt caching — Claude Platform Docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Tool RAG: The Next Breakthrough in Scalable AI Agents — Red Hat Emerging Technologies](https://next.redhat.com/2025/11/26/tool-rag-the-next-breakthrough-in-scalable-ai-agents/)
- [The Complete Guide to Tool Selection in AI Agents — MachineLearningMastery.com](https://machinelearningmastery.com/the-complete-guide-to-tool-selection-in-ai-agents/)
- [Anthropic: Code execution with the Model Context Protocol (MCP) — announcement](https://x.com/AnthropicAI/status/1985846791842250860)
- [Code execution with MCP: Building more efficient agents — Anthropic](https://www.anthropic.com/engineering/code-execution-with-mcp)
- [AutoTool: Dynamic Tool Selection and Integration for Agentic Reasoning (arXiv 2512.13278)](https://arxiv.org/pdf/2512.13278)
