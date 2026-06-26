---
date: "2026-06-26"
title: "Context Engineering for AI Agents: From Craft to Production Discipline"
description: "A deep dive into context engineering — the discipline of designing the complete information environment for AI agents. Covers tiered memory architectures, dynamic context assembly, tool description engineering, context budgeting, prompt caching strategies, and security challenges in production deployments."
tags: ["context-engineering", "ai-agents", "memory-architecture", "prompt-caching", "rag", "mcp", "production-patterns"]
---

## Executive Summary

Context engineering has emerged as the defining discipline of production AI systems in 2025-2026. Where prompt engineering focuses on what you say to a model in a single turn, context engineering addresses the complete information environment the model inhabits: system prompts, memory, tool definitions, retrieved knowledge, conversation history, and the dynamic assembly logic that stitches these together at runtime.

The term was popularized in June 2025 when Shopify CEO Tobi Lütke posted that context engineering is "the art of providing all the context for the task to be plausibly solvable by the LLM," followed days later by Andrej Karpathy amplifying it as "the delicate art and science of filling the context window." The phrase had earlier roots at Cognition (the team behind Devin), but mid-2025 was when it went mainstream. By 2026, the field has spawned dedicated job titles, conference tracks, and an emerging body of academic literature.

The central insight is this: most agent failures are not model failures — they are context failures. The model's reasoning is only as good as what you put in front of it. Getting that right at scale, reliably, across sessions and users, is an engineering discipline, not an artisanal craft.

## Definition and Scope

Prompt engineering operates at the instruction level: you craft a message, the model responds, and the quality of that response depends on how well you phrased the request. Context engineering operates at the system level: you design the entire information architecture that determines what the model knows, in what order, and with what constraints, across every step of a multi-turn, multi-tool workflow.

Concretely, everything in the model's context window at inference time is within scope:

- **System prompts**: identity, behavioral rules, output contracts
- **Conversation history**: prior turns, tool calls, tool outputs
- **Retrieved knowledge**: documents, records, search results injected via RAG
- **Tool definitions**: schemas, descriptions, and usage examples that shape which tools an agent calls and how
- **Memory**: distilled summaries of past sessions or external user state
- **Environmental state**: date/time, active user, task parameters

A useful frame comes from Firecrawl's engineering team: context engineering separates into *static context* (decision rules, API specs, guidelines — stable across requests) and *dynamic context* (user state, real-time data, task-specific retrieval — assembled fresh per request). The separation matters for both cost and reliability: static context can be aggressively cached; dynamic context must be precisely targeted.

## Core Techniques

### System Prompt Design and Layering

Production system prompts are not monolithic blobs of text. Claude Code, for instance, assembles its system prompt from 110+ conditional fragments at query time, with the base weighing around 2,900 tokens before any user context is added. The effective architecture follows a five-layer model:

1. **Identity**: Who the agent is, its persona, its stated purpose
2. **Behavioral rules**: How it should act — tone, decision boundaries, escalation rules
3. **Format constraints**: Output structure (JSON schema, markdown, etc.)
4. **Edge case handling**: Explicit "do not" statements, failure modes
5. **Examples**: Few-shot demonstrations for high-variance tasks

Research on instruction style confirms that mixing styles outperforms any single approach. *Prohibitive* instructions ("never expose API keys") work best for hard safety boundaries. *Conditional* instructions ("if the user asks about billing, route to...") handle situational logic. *Explanatory* instructions ("avoid markdown tables because the renderer strips them") improve compliance by giving the model a rationale.

One critical finding from 2025 evaluations: instructions buried past the 2,000-word mark receive measurably less attention than front-loaded ones. The first 500 words carry disproportionate weight. Core constraints belong at the top.

### Dynamic Context Assembly

Static prompts break down in production because user needs, available data, and task state change on every request. The pattern that has emerged is *just-in-time context construction*: the system determines what the model needs to know for this specific step, pulls it from the appropriate source (database, vector store, tool output, memory layer), and injects it into the context window at inference time.

A key concept here is **Minimum Viable Context (MVC)**: the model receives exactly what it needs — user goal, relevant retrieved information, applicable policies, necessary tool definitions, compacted memory summary — and nothing else. Over-injecting information is not neutral; it actively degrades performance through what researchers call "context distraction," where accumulated irrelevant history causes the model to drift from the current task.

### Memory Architectures

The memory problem is fundamentally about bridging session boundaries. In-context memory (conversation history) is ephemeral and token-expensive. External memory (databases, vector stores) is persistent but requires retrieval. The state of the art in 2025-2026 uses tiered architectures:

- **Working memory (in-context)**: The current conversation and immediate task state. Hot, fast, expensive per token.
- **Episodic memory (session logs)**: What happened in recent sessions. Retrieved selectively; often summarized before injection.
- **Semantic memory (knowledge bases)**: Domain knowledge, user preferences, organizational facts. Retrieved via embedding similarity or graph traversal.
- **Procedural memory (tool definitions, skills)**: How to do things — agent capabilities encoded in tool schemas and system prompt instructions.

Systems like MemGPT and MemoryOS pioneered the swap-in/swap-out model: working memory holds the active task context, and the system pages in colder material from episodic or semantic stores as needed, similar to virtual memory in operating systems. Persistent agent systems like Zylos apply a five-tier variant: identity (always loaded), state (always loaded), references (always loaded as a pointer file), user profiles (loaded per-user), and session logs (loaded on demand). This keeps the baseline context lean while preserving access to full context depth when needed.

Memory compression is the unlock that makes this practical. Production systems report cutting token usage by up to 80% by distilling conversation transcripts into structured summaries rather than verbatim logs. Factory's evaluation across 36,000 real engineering session messages showed that merging new summaries into a persistent state document outperforms both verbatim history and fresh summarization on accuracy, completeness, and continuity.

### Tool Description Engineering

Tool definitions are underestimated context. Every tool schema injected into the context — its name, description, parameter names, and types — shapes what actions the agent considers and how it decides to invoke them. Poorly named tools create ambiguity; vague descriptions increase hallucinated argument values.

Research published in early 2026 on MCP tool descriptions identified what the authors called "smelly" tool schemas: descriptions that are too generic, parameter names that are misleadingly abbreviated, and missing examples of valid inputs. Augmenting tool descriptions with usage examples and explicit failure modes measurably improved agent efficiency across benchmark tasks.

The practical guidance: treat tool schemas as API documentation for the model. Include a one-sentence purpose statement, describe each parameter's valid range and semantics, and provide at least one example call. For tools with overlapping capabilities, add a disambiguation note explaining when to prefer each.

### Context Window Management

Context windows grew dramatically in 2025-2026 — Claude now supports 1 million tokens, Gemini 2.5 reaches 2 million. But capacity and capability are not the same thing. A Databricks study showed correctness beginning to decline around 32,000 tokens for large models, well before window limits. The "lost in the middle" effect — where models attend strongly to the beginning and end of context but lose track of middle content — persists even at 1M token scales.

Three compression patterns dominate production deployments:

**Sliding window**: Retain the most recent N turns verbatim; drop earlier turns. Simple, predictable, lossy for long tasks.

**Hierarchical summarization**: Compress older segments into increasingly abstract summaries while keeping recent exchanges verbatim. Factory's evaluation showed this outperforms sliding window on long-horizon continuity.

**State accumulation**: Rather than summarizing conversations, maintain a structured state document that agents update incrementally. Each turn merges new information into the persisted state. This preserves constraint tracking (a specific value confirmed earlier, a dependency noted two hours ago) that conversation summarization tends to drop.

Anthropic has productized automatic context compaction via a server-side API, removing the need for client-side management in many scenarios. The ACON research framework goes further: agents learn from their own context-induced failures, refining what information they retain over time.

### RAG Integration Patterns

Retrieval-Augmented Generation has evolved from a static document-lookup pattern into what practitioners now call a *Context Engine*: the retrieval layer handles all context assembly needs, not just document Q&A. Agentic RAG systems embed retrieval decisions into the model's reasoning flow — the agent determines when it needs external information, formulates a retrieval query, and integrates results before proceeding.

Advanced architectures like GraphRAG combine vector similarity search with relationship traversal in a knowledge graph, enabling multi-hop reasoning that flat document retrieval cannot support. When an agent needs to answer "which customers are affected by this outage, and what SLAs apply," a knowledge graph connecting customers → services → SLAs → incidents delivers an answer that bag-of-documents retrieval cannot.

## Production Patterns

### Context Budgeting

A 200K token context window with a $15/M input token price creates immediate budget pressure. Allocating that window requires explicit accounting:

- **System prompt** (static): 2,000-10,000 tokens, cached after first request
- **Tool definitions**: 500-3,000 tokens per tool × number of tools
- **Conversation history**: Grows unboundedly; must be managed
- **Retrieved documents**: Highly variable; largest single controllable cost driver
- **Model output**: Typically 10-20% of total request tokens

Prompt caching is the highest-leverage optimization available. Anthropic's caching cuts cached input cost by 90%. Claude Code applies caching to CLAUDE.md: the first request in a session pays full price; subsequent requests within roughly five minutes hit the cache. The architectural implication is significant: separate stable from dynamic content, structure prompts so stable content is prefix-anchored (cacheable), and reserve dynamic content for the suffix.

### Context Observability

A model running on bad context fails silently. It keeps generating, the agent keeps running, and what disappears is the constraint confirmed earlier or the value tracked from three steps ago. This is why context observability has become a first-class engineering concern.

Platforms like Langfuse and LangSmith provide structured logs of every inference call: the exact prompt sent, the model's response, token usage, latency, and all tool calls in between. Custom dashboards track token usage, P50/P99 latency, error rates, cost breakdowns, and user feedback scores. The critical addition in agent-specific observability is turn-level context diffs — seeing what changed in the context between steps reveals where drift or poisoning occurs.

### Cross-Session Context Persistence

Agents serving real users need to remember across sessions without making the user re-explain their preferences every time. The pattern is a dedicated memory layer with a write-select-compress-isolate lifecycle:

1. **Write**: At session end (or continuously), extract meaningful facts into structured memory entries
2. **Select**: On session start, retrieve entries relevant to the current user and task via semantic search
3. **Compress**: Resolve contradictions, merge duplicates, age out stale entries
4. **Isolate**: Keep different domains (user preferences, project state, world knowledge) in separate namespaces to prevent cross-contamination

## Challenges and Open Problems

### Context Poisoning and Injection Attacks

OWASP rates prompt injection the #1 LLM vulnerability (LLM01:2025). In RAG-powered agents, the attack surface expands: any document in the retrieval corpus is potential attack surface. PoisonedRAG (USENIX Security 2025) demonstrated that inserting just five carefully crafted documents into a corpus of millions achieves over 90% success rates for query-specific manipulation. Poisoning 0.04% of a corpus yielded 98.2% attack success.

The MINJA attack (NeurIPS 2025) went further: adversaries can poison agent memory through normal queries, with over 95% injection success rates against production architectures. Entry vectors include SharePoint, Google Drive, Confluence, and Slack — any external data source feeding a RAG corpus.

Mitigations include input sanitization pipelines, retrieval result sandboxing, layered permission systems that limit what retrieved content can instruct the agent to do, and anomaly detection on tool call patterns. None are complete solutions; this remains an active research area.

### Measuring Context Quality

There is no standard metric for "context quality." Practitioners currently proxy it through downstream task success rate, hallucination rate (outputs not grounded in provided context), and context utilization (percentage of tokens that actually influenced the output). The last metric requires interpretability tools that are still maturing.

A fundamental measurement challenge: context quality is task-relative. A context perfectly calibrated for a coding task may be actively harmful for a customer support task. Multi-task agents require dynamic quality assessment.

### Multi-Agent Context Coordination

When multiple agents collaborate, the context problem multiplies. Each agent has its own context window; shared state must be explicitly communicated. Approaches include a central context store all agents read/write (creates contention), message-passing with structured payloads (scales but requires schema discipline), and shared memory with decentralized writes verified via consensus (high integrity, high overhead).

Google's Agent2Agent (A2A) protocol and IBM's Agent Communication Protocol (ACP), both now under the Linux Foundation's Agentic AI Foundation as of December 2025, attempt to standardize how agents share context across organizational boundaries. Neither solves the semantic alignment problem — agents agreeing on the *meaning* of shared facts, not just their format.

## Emerging Trends

### Model Context Protocol (MCP)

Anthropic launched MCP in November 2024 as a standard for how LLM-based systems integrate with external tools and data sources. The adoption curve was steep: from 2M monthly SDK downloads at launch to 97M by March 2026, with all major cloud providers and AI labs supporting the protocol. By 2026, MCP has become the de facto transport layer for context augmentation: tool servers expose structured capabilities; agents call them via standardized JSON-based exchanges; and the protocol handles authentication, versioning, and schema discovery.

For context engineers, MCP changes the tool definition problem from "write JSON schema manually" to "discover and call a living registry of capability definitions." ScaleMCP research demonstrated dynamic auto-synchronizing of MCP tool catalogs, where agents maintain fresh tool knowledge without manual schema maintenance. The remaining challenge is that MCP tool descriptions are still hand-authored and exhibit the same quality problems as static schemas.

### Extended Context Windows vs. Effective Utilization

The 1M token context window changes the architecture space without eliminating context engineering concerns. Processing a 500-page codebase in one shot is now feasible; RAG is less necessary for many document-heavy workflows. But reliable reasoning degrades well before the advertised limit for most models. By mid-2026, vendor competition has shifted from raw token count to reliable token utilization — how far into the context window can a model maintain accurate retrieval and coherent reasoning.

The practical implication: engineers still need tiered context strategies. Extended windows buy headroom; they do not eliminate the need for relevance filtering, compression, and position-aware content placement.

### Prompt Caching Architecture

Anthropic's prompt caching (90% cost reduction on cache hits, ~5-minute TTL) has driven a new architectural constraint: design context so stable content is always the prefix. System prompts, tool definitions, and large static documents go first. Dynamic content (user query, retrieved documents for this specific request) comes last. This structure maximizes cache hit rates across a fleet of agents all sharing the same static prefix.

## Conclusion

Context engineering is not a refinement of prompt engineering — it is a different discipline at a different level of abstraction. Prompt engineering asks "what do I say?" Context engineering asks "what should the system know, when should it know it, how should that knowledge be maintained, and how do we measure whether it's working?"

The field has moved from informal craft to structured engineering practice in roughly 18 months. The technical foundations now exist: tiered memory architectures, dynamic context assembly pipelines, standardized tool protocols via MCP, production observability tooling, and increasingly sophisticated RAG frameworks. What remains immature is the science of measuring context quality, the security discipline for adversarial context manipulation, and the coordination protocols for multi-agent context sharing.

The through-line for practitioners: treat the context window as a scarce, structured resource. Budget it explicitly. Separate stable from dynamic content. Compress aggressively. Cache everything cacheable. Monitor what actually reaches the model. The model's intelligence is a constant; the context is the variable you control.

## References

- Tobi Lütke on context engineering — [X/Twitter, June 2025](https://x.com/toaborern/status/1937871892317561138)
- Andrej Karpathy on context engineering — [X/Twitter, June 2025](https://x.com/karpathy/status/1937902205765607626)
- "Context Engineering vs Prompt Engineering" — [Firecrawl Engineering Blog](https://www.firecrawl.dev/blog/context-engineering)
- "Why AI teams are moving to context engineering" — [Neo4j Blog](https://neo4j.com/blog/agentic-ai/context-engineering-vs-prompt-engineering/)
- "Context Engineering: AI Agents Guide" — [mem0.ai](https://mem0.ai/blog/context-engineering-ai-agents-guide)
- "Context Engineering 2.0" — [arXiv 2510.26493](https://arxiv.org/pdf/2510.26493)
- "How Claude Code Builds a System Prompt" — [Drew Breunig](https://www.dbreunig.com/2026/04/04/how-claude-code-builds-a-system-prompt.html)
- "MCP Tool Descriptions Are Smelly" — [arXiv 2602.14878](https://arxiv.org/html/2602.14878v1)
- "PoisonedRAG" — [USENIX Security 2025](https://arxiv.org/pdf/2505.18543)
- "Memory and Context Poisoning" — [WorkOS Blog](https://workos.com/blog/ai-agent-memory-poisoning)
- "Context Window Management Strategies" — [getmaxim.ai](https://www.getmaxim.ai/articles/context-window-management-strategies-for-long-context-ai-agents-and-chatbots)
- "Agent Context Compression" — [mem0.ai](https://mem0.ai/blog/how-hermes-and-claude-handle-context-compression-in-real-production-agents-(and-what-you-should-extract))
- "Agentic RAG Survey" — [arXiv 2501.09136](https://arxiv.org/abs/2501.09136)
- "Don't Break the Cache" — [arXiv 2601.06007](https://arxiv.org/pdf/2601.06007)
- Model Context Protocol — [Wikipedia](https://en.wikipedia.org/wiki/Model_Context_Protocol)
- Langfuse LLM Observability — [langfuse.com](https://langfuse.com/)
