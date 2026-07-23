---
date: "2026-07-14"
title: "Context Engineering: System-Level Context Design for AI Agents"
description: "How the industry moved from prompt engineering to context engineering — memory tiers, context budgeting, production patterns from Claude Code/Cursor/Devin/Codex, and the challenge of context rot."
tags:
  - research
  - context-engineering
  - ai-agents
  - llm
  - memory-systems
  - rag
  - prompt-engineering
  - agent-architecture
---

## Executive Summary

Over the past year, the practitioner consensus has shifted from "prompt engineering" — crafting a clever instruction string — to "context engineering": the systems discipline of deciding, at every turn of an agent's execution, exactly which tokens belong in a finite context window, where they come from, and when they should be evicted, compressed, or delegated elsewhere. The discipline now has a shared vocabulary (write/select/compress/isolate), a body of empirical evidence that more context is not free (context rot, lost-in-the-middle), and converging production patterns — subagents, file-based memory, todo-list re-injection, aggressive compaction — visible across Claude Code, Cursor, Devin, Manus, and OpenAI's Codex CLI. The throughline for any agent platform, including tiered-memory systems that always load a compact identity/state summary and pull detailed records only on demand, is the same: treat the context window as a scarce, actively managed resource rather than a passive log.

## From Prompt Engineering to Context Engineering

The term crystallized in public discourse in June 2025, when Andrej Karpathy posted on X: "+1 for 'context engineering' over 'prompt engineering'... People associate prompts with short task descriptions you'd give an LLM in your day-to-day use. When in every industrial-strength LLM app, context engineering is the delicate art and science of filling the context window with just the right information for the next step." Shopify CEO Tobi Lütke made a parallel argument around the same time, and the phrase spread quickly through practitioner circles because it named something people were already doing but didn't have a word for: in a real production agent, the model doesn't see a prompt — it sees a context window assembled at runtime from system instructions, retrieved documents, conversation history, tool-call results, memory records, and reasoning traces, all competing for a limited token budget.

Anthropic formalized this in its engineering blog post "Effective context engineering for AI agents" (September 2025), reframing the entire problem: "the engineering problem at hand is optimizing the utility of tokens against the inherent constraints of LLMs in order to consistently achieve a desired outcome." Their guidance across every context component — system prompts, tool definitions, few-shot examples, message history — reduces to one heuristic: be informative, yet tight. This is a meaningfully different mandate from prompt engineering's focus on wording and few-shot examples; it's an architecture and resource-allocation problem, not a copywriting one. The distinction matters because it changes what "getting better at AI" means for a team: fewer hours spent wordsmithing a system prompt, more hours spent designing what information flows into the model and when it gets removed.

## Key Techniques: Memory Tiers, RAG, and Dynamic Assembly

The academic and open-source memory literature has converged on a taxonomy borrowed from cognitive science, most visibly through CoALA (Cognitive Architectures for Language Agents), which several major frameworks — Letta, Mem0, LangChain — now use as a foundation. The taxonomy splits agent memory into:

- **Working memory**: the live context window itself, scoped to the current task.
- **Semantic memory**: facts and world knowledge about the environment, retrieved on demand (the classic RAG pattern — keep it outside the window, pull in only what's relevant to the current decision).
- **Episodic memory**: records of specific past experiences or task instances, useful for few-shot-style recall of "how did I solve something like this before."
- **Procedural memory**: skills and rules, either baked into model weights via fine-tuning or externalized as explicit guidelines/skills documents the agent consults.

RAG itself has matured past "shove the top-k chunks into the prompt." Production teams increasingly report that going from 8K to 200K tokens of retrieved context does not improve answer quality on held-out evaluation sets — precision of retrieval beats volume. This has pushed teams toward tighter chunking strategies, hybrid dense+sparse retrieval, and mandatory reranking stages, since irrelevant-but-similar retrieved passages actively degrade output rather than being merely wasted space.

Dynamic context assembly is the connective layer: rather than a static prompt template, the agent's runtime decides per-turn what to include — condensing older tool outputs, pulling a user profile only when a name is mentioned, or fetching a document only after a retrieval step scores it above a relevance threshold. This is the layer where "context engineering" is actually practiced day to day, and it's where LangChain's four-part taxonomy (below) is most directly actionable.

## Context Budgeting

Because the context window is finite and quality degrades well before the hard token limit, mature systems treat it as an explicit budget rather than an open bucket. A common production pattern allocates a fixed percentage of a ~200K-token window across competing needs — system instructions, tool schemas, retrieved/long-term context, and conversation history — with an explicit reserved buffer (commonly 10–20%) left unused to avoid hitting the hard cap mid-generation and to preserve headroom for the model's own output. Ratios tend to be more stable across models than absolute token counts, since window sizes vary but the *relative* competition between components doesn't.

The practical decision rules that show up repeatedly in production writeups:
- **System/instructions**: kept as small and stable as possible, since a large static system prompt is pure overhead paid on every single call.
- **Long-term memory/identity context**: loaded as a lean, always-on summary, with full detail fetched only when a specific need arises — this is the same tiered pattern seen in agent platforms that keep a compact identity/state digest resident at all times and load user-specific or historical records on demand rather than upfront.
- **Conversation history**: the first thing summarized or truncated once the token count crosses a threshold, since raw turn-by-turn history has the worst token-to-value ratio over a long session.
- **Tool call results**: often the largest and most disposable component — a directory listing or long log dump is valuable for one turn and irrelevant afterward, making it a prime compaction target.

LangChain's engineering blog crystallized the operative techniques into four verbs, now a widely cited taxonomy: **Write** (persist information outside the window — scratchpad files, notes — so it survives without occupying live tokens), **Select** (pull only the relevant slice back in via retrieval, embedding search, or dynamic tool selection), **Compress** (summarize conversation history, shrink tool outputs, or maintain running state-schema summaries instead of full transcripts), and **Isolate** (split context across multiple agents or sandboxes so no single context window has to hold everything at once). Nearly every production pattern described below is an instance of one of these four moves.

## Production Patterns: How Claude Code, Cursor, Devin, and Codex Manage Context

**Claude Code (Anthropic)** leans hard on isolation via subagents: each subagent runs in its own context window with a custom system prompt and scoped tool access, does its work, and returns only a final summary to the parent session — every intermediate tool call, file read, or verbose log stays sealed inside the subagent and never floods the orchestrating context. On top of isolation, Claude Code applies several context-reduction strategies before every model call: lazy loading of instructions, deferred tool schemas (only fetched when actually needed), microcompaction that reacts to accumulating cache overhead, and a heavier auto-compact/summarization pass as a last resort when a session runs long. A three-tier memory hierarchy (broadly: durable identity/config, project-level conventions, and session-dynamic context) persists relevant information across sessions without keeping full history resident.

**Cursor** takes a different angle, built around persistent codebase indexing rather than per-session memory: on opening a project it builds a semantic embedding index of the entire codebase (reportedly supporting very large context windows via retrieval, not brute-force inclusion), letting `@codebase` and agent navigation answer structural questions without manually selecting files. Crucially, the index and project rules (`.cursor/rules/`) persist across sessions even when conversation history doesn't — a clean separation between "what the codebase is" (durable, indexed, cheap to query) and "what we're currently discussing" (ephemeral, discarded aggressively).

**Devin (Cognition Labs)** targets long-horizon tasks — 50+ step engineering work spanning hours — through a combination of persistent working memory, subagent orchestration for sub-tasks, and sandboxed execution. Its most instructive limitation: each Devin session is a self-contained sandboxed run, and task context from one session is not automatically carried into the next unless explicitly re-supplied — a reminder that "long-horizon" and "cross-session" are different problems requiring different solutions.

**OpenAI's Codex CLI** uses explicit, mechanized compaction: once token count crosses a threshold, the agent's conversation is replaced with a smaller, representative set of "items" summarizing what happened, including an opaque compaction item that preserves the model's latent understanding of prior turns without carrying the raw transcript forward. Its `AGENTS.md` convention (file-based, directory-scoped instructions concatenated root-to-leaf, with closer-to-cwd files taking precedence, capped at a fixed byte budget) is itself a context-budgeting mechanism — instructions are structured so more specific, more relevant guidance wins without requiring the model to read everything.

**Manus**, a general-purpose agent product, published one of the most concrete field reports on this problem. Their team found that maintaining a live `todo.md` file that gets rewritten and re-appended at each step is a deliberate attention-manipulation technique: by reciting the plan back into the *end* of the context on every turn, they push the global objective into the model's high-attention recency window and counteract lost-in-the-middle decay. They also learned the technique has real overhead — roughly a third of actions were once being spent just updating the todo list — which pushed them toward a dedicated planner agent delegating to executor subagents instead of a single agent constantly rewriting its own state. Manus also treats the filesystem itself as "the ultimate context": unlimited, persistent, and directly operable by the agent, so long-lived information lives in files rather than in the token stream. A second discipline they emphasize is keeping the prompt prefix byte-for-byte stable and making context strictly append-only, because autoregressive caching means a single altered token anywhere in the prefix invalidates the KV-cache for everything after it — a subtle but expensive cost most teams don't budget for until they hit it.

Across all five systems, the same three moves recur: **delegate to isolate** (subagents/sandboxes), **externalize to persist** (files, indexes, todo lists instead of raw history), and **compact to survive** (summarization, opaque compaction tokens, threshold-triggered rewrites).

## Challenges: Context Pollution and Context Rot

The empirical case for treating context as expensive, not free, has gotten much stronger. Chroma's 2025 research, testing 18 frontier models (including Claude 4, GPT-4.1, and Gemini 2.5 families) on multi-hop reasoning across context lengths from 10,000 to 500,000 tokens, found that every model's accuracy degraded monotonically as input length grew — even on simple retrieval tasks, and even well before hitting the documented context limit. The steepest degradation clustered in the 100K–500K token range, with accuracy drops of 30–50% observed before models reached their stated maximum. Chroma's team coined "context rot" for this: the phenomenon that quality decay is a function of *quantity* of context, not just presence or absence of the right fact.

Three mechanisms compound to produce this: (1) **lost-in-the-middle**, first documented rigorously in Liu et al.'s "Lost in the Middle: How Language Models Use Long Contexts" (arXiv 2307.03172; TACL 2024), which found performance is highest when relevant information sits at the very start or end of the context and drops significantly when it's buried in the middle — a U-shaped attention curve that holds even for models explicitly built for long contexts; (2) **attention dilution**, since transformer self-attention scales quadratically, meaning a 100K-token context creates on the order of 10 billion pairwise token relationships competing for the same attention budget; and (3) **distractor interference**, where semantically similar but ultimately irrelevant content actively misleads the model rather than being neutral noise — a retrieved passage that's "close enough" can be worse than no passage at all.

The practical implication is that relevance filtering is not an optimization, it's a correctness requirement. A system that retrieves ten mediocre documents instead of two excellent ones isn't just wasting tokens — it's measurably degrading the answer. This also reframes the classic "context pollution" problem (stale user preferences, contradictory notes accumulated over a long-running session, conflicting instructions layered over months of memory writes) as a rot-acceleration risk rather than a purely hygiene issue: polluted context doesn't just risk being *wrong*, it actively lowers the model's accuracy on everything else in the window too.

## Emerging Standards and Frameworks

The **Model Context Protocol (MCP)**, announced by Anthropic in November 2024 as an open standard for connecting AI assistants to external tools and data sources (often described as "USB-C for AI applications"), has become deeply entangled with context engineering as a discipline — not because MCP itself decides what to keep or drop, but because it standardizes *how* context enters the window from external systems, making retrieval and tool-result injection consistent and composable across vendors instead of bespoke per-integration glue code. In December 2025, Anthropic donated MCP to the Agentic AI Foundation, a directed fund under the Linux Foundation, formalizing it as vendor-neutral infrastructure rather than a single company's proprietary interface — a signal that the industry views standardized context plumbing as foundational, similar to how HTTP standardized transport before anyone cared about what was in the payload.

On the taxonomy side, LangChain's **write/select/compress/isolate** framework (published via their engineering blog and an accompanying open-source `context_engineering` reference repo) is the closest thing the field has to a shared vocabulary for context-management strategies, and it maps cleanly onto what the production systems above are actually doing. Anthropic's "effective context engineering for AI agents" post functions as the complementary practitioner-facing companion — less a taxonomy of strategies and more a set of concrete heuristics (tight system prompts, curated tool sets, "just in time" retrieval over upfront loading) for applying them.

## Practical Implications for AI Agent Developers

- **Budget the window explicitly, don't let it fill implicitly.** Assign rough percentage targets to system instructions, tool schemas, memory/retrieved context, and conversation history, and keep a 10–20% reserved buffer. Treat crossing 80% utilization as a trigger for action, not a warning to ignore.
- **Tier memory instead of flattening it.** Keep a small, always-resident summary (identity/state/current objective) and load detailed records — user history, past decisions, project files — only when the current turn actually needs them. This is cheaper and more reliable than either loading everything upfront or nothing until asked.
- **Prefer isolation over inclusion for noisy sub-tasks.** Any operation that will generate large, mostly-disposable output (log dumps, broad file searches, multi-step research) belongs in a subagent or sandboxed call that returns a summary, not inline in the main context.
- **Externalize working state to files rather than re-stating it in-context.** A todo list, scratchpad, or state file that the agent reads/writes is more durable and more token-efficient than repeating the same plan across many turns of conversation history.
- **Compact proactively, and prefer structured compaction over raw truncation.** Threshold-triggered summarization that preserves the "why" of prior decisions beats simply dropping the oldest turns, which silently deletes information that later turns may implicitly depend on.
- **Treat retrieval precision as a correctness metric, not a cost metric.** Given context rot and distractor interference, adding more retrieved documents can make answers worse, not just slower and pricier. Invest in reranking and tight top-k selection before increasing the retrieval budget.
- **Keep prompt prefixes stable and context append-only where caching matters.** Editing earlier turns invalidates prefix caches downstream and can materially increase latency and cost, independent of any accuracy concerns.
- **Instrument before optimizing.** Log per-call token allocation across system/memory/history/tools so budget drift is visible; most context bloat accumulates gradually rather than arriving as an obvious spike.

## References

- Andrej Karpathy, post on X, June 2025 — https://x.com/karpathy/status/1937902205765607626
- Anthropic Engineering, "Effective context engineering for AI agents," September 2025 — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- LangChain, "Context Engineering for Agents" (write/select/compress/isolate framework) — https://www.langchain.com/blog/context-engineering-for-agents
- LangChain, `context_engineering` reference repository — https://github.com/langchain-ai/context_engineering
- Claude Code documentation, "Create custom subagents" — https://code.claude.com/docs/en/sub-agents
- Manus, "Context Engineering for AI Agents: Lessons from Building Manus" — https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- OpenAI, "Unrolling the Codex agent loop" — https://openai.com/index/unrolling-the-codex-agent-loop/
- OpenAI Codex, `AGENTS.md` custom instructions guide — https://developers.openai.com/codex/guides/agents-md
- Chroma Research, "Context Rot: How Increasing Input Tokens Impacts LLM Performance," 2025 — https://www.trychroma.com/research/context-rot
- Nelson F. Liu et al., "Lost in the Middle: How Language Models Use Long Contexts," arXiv:2307.03172; Transactions of the Association for Computational Linguistics, vol. 12, 2024, pp. 157–173 — https://arxiv.org/abs/2307.03172
- Model Context Protocol overview — https://en.wikipedia.org/wiki/Model_Context_Protocol
- CoALA memory taxonomy (episodic/semantic/procedural), as referenced by Letta, Mem0, and LangChain memory implementations
- Cursor documentation, "Codebase indexing" — https://cursor.com/help/customization/indexing
- Reporting on Devin (Cognition Labs) long-horizon task architecture and session-scoped memory limitations, various 2025–2026 practitioner writeups
- TianPan.co, "The Hidden Costs of Context: Managing Token Budgets in Production LLM Systems," November 2025 — https://tianpan.co/blog/2025-11-11-managing-token-budgets-production-llm-systems
