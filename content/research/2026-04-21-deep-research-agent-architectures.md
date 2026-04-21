---
date: "2026-04-21"
title: "Deep Research Agent Architectures: Multi-Hour Autonomous Research Systems"
description: "How OpenAI Deep Research, Claude Research, Perplexity Labs, and Gemini Deep Research build agents that autonomously research for hours — planning, parallelism, memory, and the economics."
tags: [ai-agents, deep-research, architecture, autonomous-agents, long-horizon-execution]
---

## Executive Summary

Deep Research agents represent a qualitative shift from reactive chatbots to autonomous information workers. Launched in earnest by OpenAI in February 2025, the "deep research" category now spans every major AI lab and a vibrant open-source ecosystem. These systems decompose vague queries into structured research plans, fan out across dozens to hundreds of web sources over 10 minutes to 2 hours, maintain evidence state across context windows that would otherwise overflow, and synthesize citation-rich reports that users previously needed human researchers to produce.

The core architectural pattern that recurs across all mature implementations is a **Plan → Search → Read → Reflect → Iterate → Synthesize** loop, with the most capable systems layering multi-agent parallelism on top. The dominant technical challenges are context budget management (how to avoid stuffing 200K+ tokens of crawled content into a single context), intermediate-step hallucinations that escape end-to-end evaluation, and the economics of a category where a single user session can cost the provider $5–$30 in API fees. This report examines each layer in detail, drawing on engineering blog posts, system cards, API documentation, and peer-reviewed benchmarks.

---

## 1. Planning & Decomposition

All mature deep research systems perform some form of query decomposition before executing searches, but the *mode* of decomposition differs significantly.

**Three documented planning strategies** (from the 2506.18096 systematic examination):

- **Planning-Only**: The agent receives the query, generates a research plan internally, and starts executing without user interaction. Used by Grok DeepSearch, H2O, and Manus. Fastest time-to-first-search, but most prone to pursuing the wrong decomposition.

- **Intent-to-Planning**: The agent asks clarifying questions before committing to a plan. Used by OpenAI Deep Research. ChatGPT will ask follow-ups about scope, preferred format, and constraints before the research loop begins. This reduces wasted compute on misdirected subtopics at the cost of a round-trip with the user.

- **Unified Intent-Planning**: The agent generates a full research plan and surfaces it to the user for review and editing before execution. Used by Gemini Deep Research. The user sees a multi-step outline and can revise it, which provides the highest level of alignment at the cost of requiring user engagement.

**Decomposition mechanics**: Once intent is established, the agent decomposes the topic into subtopics or sub-questions. Anthropic's engineering blog documents that their LeadResearcher agent (Claude Opus 4) uses extended thinking to analyze the query and define each subagent's scope with explicit objectives, output format requirements, and clear task boundaries. Early experiments showed that vague instructions ("research the semiconductor shortage") led to duplicated work across subagents; structured delegation with specific outputs proved essential.

GPT-Researcher uses a planner-executor-publisher pattern: the planner generates a set of research questions that collectively cover the topic, and execution agents (one per question) work in parallel to gather information. Stanford STORM's approach is distinctive: it discovers perspectives by surveying related articles, then simulates multi-perspective conversations where LLM "experts" answer questions from LLM "writers", building an outline from the accumulated dialogue before any prose is written.

**Adaptive re-planning**: Initial plans are often revised mid-execution when retrieved information reveals unexpected angles. The Plan-and-Act framework (2503.09572) documents that dynamic replanning enhanced robustness by adapting strategies based on real-time observations. In practice, the lead agent periodically evaluates whether the current search trajectory is still aligned with the original query or whether a plan revision is warranted. Mind2Report implements multi-dimensional reflection after each retrieval batch, scoring results on freshness, integrity, and plurality before deciding whether to expand queries or proceed to synthesis.

---

## 2. Search & Retrieval Strategy

Deep research systems fall into three retrieval architectures, with the most capable systems using hybrid approaches.

**API-Based Retrieval**: Direct integration with indexed search engines (Google Search, Bing, DuckDuckGo, arXiv APIs). Fast and low-latency, but cannot access JavaScript-rendered content, authenticated resources, or interactive elements. Used by Gemini Deep Research (google_search + url_context tools), Search-o1 (Bing Search + Jina Reader).

**Browser-Based Retrieval**: Headless browser automation (Chromium/BrowserGym) that simulates human interaction — tab management, form filling, JavaScript execution, scroll-based content discovery. Higher latency and resource cost, but accesses dynamic content and deeply nested information. Used by Manus AI, AutoAgent, DeepResearcher, Kimi-Researcher. AutoGLM Rumination adds authenticated resource access (CNKI, WeChat) via RL-based self-reflection.

**Hybrid**: Tool-Star separates a Search Engine agent from a Web Browser Agent, routing queries to the appropriate tool based on content type. SimpleDeepSearcher combines search APIs with direct HTTP fetching for content not surfaced by index.

**Query reformulation**: When initial searches return weak results, agents generate alternative query formulations. Benchmarks like Mind2Web explicitly evaluate reformulation ability. N-gram-based deduplication removes trajectories with excessive repetition. In practice, systems deduplicate by URL and filter previously-seen sources to avoid re-reading the same content across iterations.

**Source ranking and authority**: Step-DeepResearch maintains a curated index of 600+ authoritative sources (government sites, research institutes, academic platforms) with "authority-aware ranking heuristics" that prioritize authoritative sources when relevance scores are comparable. This counters a documented failure mode in less sophisticated systems: selecting SEO-optimized content farms over primary sources. The full knowledge-dense retrieval library contains 20M+ documents.

**Perplexity Sonar Deep Research** uses a modular architecture: a planner decomposes queries, a retriever fetches data via Perplexity's search API (reportedly hundreds of sources per run), and a synthesizer compiles insights. In one documented example from Perplexity's API docs, a single query ran 21 searches, generated over 193,000 reasoning tokens, and produced a 10,000-word report.

---

## 3. Long-Horizon Execution Loops

The defining challenge of deep research agents is maintaining coherent goal-directed behavior across a 10-minute to 2-hour autonomous execution without drifting or looping. Several mechanisms address this.

**Execution loop structure**: The dominant pattern is ReAct (Reason-Act-Observe), but extended over hundreds of iterations. Step-DeepResearch uses a single-agent ReAct loop cycling through: plan/reflect → tool execution → feedback/cross-validation. The system imposes a maximum of 3 error-reflection iterations per sub-task to prevent infinite correction loops.

**Documented execution budgets** (from PromptLayer's analysis of OpenAI Deep Research):
- Time limit: 20–30 minutes
- Search calls: 30–60 per task
- Page fetches: 120–150 maximum
- Reasoning loops: 150–200 iterations
- Code executions: 5–10 calls with 30–60 second timeouts per call

Gemini Deep Research API enforces a hard 60-minute maximum runtime. The API is fully asynchronous: a request immediately returns a partial interaction object with `status: in_progress`, which transitions to `completed` or `failed`.

**Drift prevention**: Without structural constraints, long-horizon agents frequently "go down rabbit holes" — following interesting but off-topic threads. Mitigation strategies include: explicit scaling rules embedded in system prompts (e.g., "use 1 agent for simple fact-finding, 10+ for complex research"), early stopping when 2+ independent sources confirm a sub-question, and novelty exhaustion detection that halts search when new pages provide no new claims.

**Checkpointing**: Anthropic's system documents checkpoint-based resumability: agents summarize completed work phases and store essential information before proceeding. Fresh subagents can be spawned with clean contexts while maintaining continuity through stored checkpoints. This is critical for graceful recovery — resuming from a checkpoint rather than restarting from scratch when a tool call fails or a context limit is reached.

**Rainbow deployments**: Anthropic uses rainbow deployments to avoid disrupting running agents during code updates — both old and new versions run simultaneously while traffic gradually shifts, so in-flight multi-hour research jobs aren't killed by a version bump.

---

## 4. Memory & State Management

Context window management is the central systems problem in deep research. A 60-minute research session with 100+ page fetches can easily accumulate 500K–1M tokens of intermediate content — far exceeding any model's context window.

**Three primary strategies** (from the 2506.18096 taxonomy):

**Approach 1 — Context Window Expansion**: Gemini's 1M token window combined with RAG allows more raw content to persist in-context. High computational cost. Gemini Deep Research's standard task consumes approximately 250K input tokens (50–70% cached), with complex tasks reaching 900K input tokens.

**Approach 2 — Intermediate Compression**: When approaching the context limit, the system feeds current history into a compression model that produces a condensed natural-language summary retaining key nodes and future plans. Step-DeepResearch's hybrid context management uses both summarization and folding (rule-based pruning with far-end truncation). Crucially, its reference-preservation variant strips detailed content while maintaining hyperlinks and citation metadata — so the agent doesn't lose track of its source evidence even when body text is compressed. In a 100-turn dialogue test, context management techniques reduced total token consumption by 84% while maintaining task coherence.

**Approach 3 — External Structured Storage**: Agents write structured outputs to external storage and pass lightweight references to coordinators. Anthropic's system uses external memory for research plans, with the lead agent saving plans to persist context when approaching the 200,000-token limit. More sophisticated systems use vector databases (AutoAgent uses similarity-based lookup), knowledge graphs (Agentic Reasoning captures reasoning processes), and shared knowledge bases (Agent-KB, Alita) that multiple agents can read and write concurrently.

**Scratchpad patterns**: Extended thinking in Claude functions as a controllable scratchpad — a private reasoning space that doesn't consume the main context window. The lead agent uses extended thinking to plan approach and assess tool fit before committing to tool calls.

**Citation tracking**: Maintaining citation provenance through compression is non-trivial. Step-DeepResearch built a custom context management layer specifically to maintain citation links during summarization and folding operations. Mind2Report's dynamic memory maintains unique identifiers, distilled content, and source references as a buffer against context exhaustion, actively interacting with the structural chapter tree to enrich sections while preventing raw retrieved content from saturating the model context.

**Mind2Report performance**: 21.93K token average report length, 385 seconds average processing time, 6.12% hallucination rate (vs. 16.54% for o4-mini baseline).

---

## 5. Parallelism

Parallelism is the primary lever for both performance and quality: parallel subagents complete complex research faster and cover more ground than sequential single-agent loops.

**Dual-level parallelization** (Anthropic's documented architecture): The lead agent spawns 3–5 subagents in parallel rather than serially. Subagents themselves use 3+ tool calls in parallel. Together, these changes reduced research time by up to 90% for complex queries.

**Scaling rules** documented by Anthropic:
- Simple fact-finding: 1 agent, 3–10 tool calls
- Direct comparisons: 2–4 subagents, 10–15 tool calls each
- Complex research: 10+ subagents with clearly divided responsibilities

The performance case for multi-agent vs. single-agent is stark: a multi-agent system with Claude Opus 4 as lead and Claude Sonnet 4 subagents outperformed single-agent Claude Opus 4 by **90.2%** on internal research evaluations. Token usage alone explained 80% of performance variance across the BrowseComp evaluation.

**GPT-Researcher** implements parallel execution via LangGraph sub-graphs: each subtopic spawns an independent graph instance with its own state, avoiding race conditions and context inconsistencies that arise from shared state approaches.

**STORM** achieves a different form of parallelism: multiple LLM "expert" agents simultaneously answer questions from multiple "writer" agents, with perspectives curated independently and then merged during outline generation.

**Current limitation**: Anthropic explicitly documents that their lead agents currently execute subagent batches synchronously — waiting for each set to complete before triggering the next. This creates information flow bottlenecks: the lead agent cannot steer subagents mid-task, and slow subagents block the entire pipeline. Asynchronous parallel execution across multi-agent deep research systems is identified in multiple papers (2506.18096) as a major unsolved architectural challenge.

**Genspark Super Agent** uses a mixture-of-agents approach for its "Super Agent" feature, where different specialist agents handle different aspects of the research and analysis process concurrently.

---

## 6. Quality Control

Quality control in deep research systems addresses two distinct problems: factual accuracy (are retrieved claims true?) and citation accuracy (do cited sources actually support the stated claims?).

**LLM-as-Judge**: Anthropic's system uses a unified evaluation prompt that outputs a 0.0–1.0 score plus pass-fail grade against rubric criteria: factual accuracy, citation accuracy, completeness, source quality (primary over secondary sources preferred), and tool efficiency (appropriate tool count). The rubric criteria follow five principles: atomicity, verifiability, unambiguity, independence, and alignment with task requirements.

**Self-critique loops**: Step-DeepResearch implements reflection, verification, and cross-validation as one of four atomic capabilities, training the model on error-reflection trajectories. The system uses PPO-based RL optimization with binary reward mapping (1 or 0 rather than ternary 1/0.5/0) for better discriminability in reward signals. GRPO reduces gradient direction conflicts from 12 to 3 per training epoch versus PPO.

**Coverage-based early stopping**: OpenAI Deep Research implements confidence thresholds — once 2+ independent sources confirm a sub-question's answer, the agent stops searching for that subtopic. This prevents the agent from continuing to seek confirmation for already-verified claims.

**Source quality heuristics**: Prompts explicitly guide agents to prioritize authoritative primary sources over SEO-optimized content farms. Step-DeepResearch's authority-aware ranking applies this at the retrieval layer rather than relying solely on the model's judgment.

**CitationAgent**: Anthropic's production system uses a dedicated CitationAgent that post-processes drafted reports, identifying specific locations for citations and ensuring every claim traces back to a verified source. This is a separate pass rather than inline citation during generation.

**DeepHalluBench and the PIES taxonomy**: A January 2026 paper (arxiv 2601.22984) introduced DeepHalluBench — 100 hallucination-prone tasks including adversarial scenarios — to evaluate six state-of-the-art DRAs. The PIES taxonomy categorizes failures on two axes: Planning vs. Summarization errors, and Explicit vs. Implicit mistakes. The key finding: **no system achieves robust reliability**, and intermediate-step hallucinations (particularly in planning) are invisible to end-to-end evaluation. Errors compound: a flawed plan in step 3 propagates through all subsequent search and synthesis steps.

---

## 7. Output Synthesis

Synthesizing 20,000–100,000 tokens of crawled evidence into a coherent, well-cited report is a distinct technical challenge from the retrieval phase.

**Section-aware decomposition**: WebThinker maps "structured subtasks to content sections" — each subagent's findings directly correspond to a section of the final report, making synthesis a merge-and-edit operation rather than a free-form generation problem.

**Mind2Report's coherent-preserved synthesis**: Reports are generated sequentially by segment. The system consolidates claims from identical sources (preventing fragmentation where the same citation appears 12 times in different forms) and maintains reference matching to verify evidentiary support before each claim is written.

**Structured output formats**: Reports include inline citations linking claims to source URLs. Gemini Deep Research explicitly supports structured output instructions via prompt (e.g., "format as technical report with sections: Executive Summary, Key Players, Supply Chain Risks"). OpenAI Deep Research generates reports averaging 15,000 words; Mind2Report averages 21,930 tokens per report.

**Uncertainty signaling**: Well-designed systems distinguish between high-confidence claims (multiple independent sources) and lower-confidence claims (single source or conflicting accounts). The DeepResearch Bench and DeepResearchGym evaluation frameworks score on knowledge precision/recall (KPC/KPR) and agreement scores, explicitly measuring citation variance.

**Iterative synthesis**: Rather than a single generation pass, advanced systems draft sections, evaluate them against source evidence, and revise. Mind2Report's ablation study shows that removing any of its three core components (intent-driven outline, memory-augmented search, coherent synthesis) causes significant performance degradation across relevance, hallucination rate, and structure scores.

---

## 8. Cost & Economics

Deep research is computationally expensive. Understanding the token math is essential for any system designing or consuming these APIs.

**Pricing as of 2025–2026**:

| System | Input | Output | Cached | Typical run cost |
|--------|-------|--------|--------|-----------------|
| OpenAI o3-deep-research | $10/M | $40/M | $2.50/M | $5–$30 estimated |
| Perplexity Sonar Deep Research | $2/M input + $3/M reasoning | $8/M | — | $3–$15 + $5/1000 searches |
| Gemini Deep Research (3.1 Pro rates) | — | — | cached discount | $2–$5 standard, $3–$5 complex |

**Token consumption at scale**:
- Gemini Deep Research standard task: ~250K input tokens (50–70% cached), ~60K output tokens
- Gemini complex task: ~900K input tokens, ~80K output tokens
- Perplexity documented example: 193,000 reasoning tokens for a single 21-search query
- Anthropic's multi-agent system: approximately 15x more tokens than equivalent single-agent chat; agents use about 4x more tokens than chat interactions

**Output token premium**: Output tokens are priced 3–8x higher than input tokens across providers. For o3-deep-research specifically, the ratio is 4:1 ($40 vs. $10 per million). This means long-form report generation is disproportionately expensive relative to retrieval.

**Prompt caching**: The most impactful cost optimization for agent workloads. When a deep research system always begins with the same large system prompt, tool schema definitions, and instructions, provider caching of the KV representation reduces costs on cached tokens by approximately 90%. Gemini's 50–70% cache hit rate on input tokens reflects this — repeated page content read across multiple retrieval cycles benefits heavily from caching.

**Parallel.ai's compute-scaling pricing model** illustrates an alternative economics: rather than a per-token model, they offer CPM (cost per million, presumably tokens or compute units) tiers — Base ($10 CPM, 4% accuracy), Core ($25 CPM, 7%), Pro ($100 CPM, 17%), Ultra ($300 CPM, 27%), Parallel 600 ($600 CPM, 39%), Parallel 1200 ($1200 CPM, 48%). The accuracy curve is roughly logarithmic: doubling compute yields significantly less than double the accuracy gain.

**Anthropic's finding on model efficiency**: "Upgrading to Claude Sonnet 4 is a larger performance gain than doubling the token budget on Claude Sonnet 3.7." This has direct economics implications: spending on a better model is more cost-effective than throwing more token budget at a weaker model.

---

## 9. User Experience

UX for deep research systems must solve a novel problem: how do you engage a user productively during a 10–60 minute autonomous operation?

**Clarification rounds**: OpenAI Deep Research asks follow-up questions before the research loop begins, refining scope, preferred format, and user constraints. This is the "Intent-to-Planning" model. Gemini's "Unified Intent-Planning" goes further, surfacing a full editable research plan.

**Mid-flight interruption**: A significant UX advancement introduced in late 2025 for OpenAI Deep Research: users can interrupt a running deep research session and inject new information or redirect focus without losing progress or restarting from scratch. The sidebar update mechanism appends new context to the in-flight agent.

**Progress visibility**: Streaming output (`stream=True` in Gemini's API) enables real-time progress updates as the agent works. Gemini's API supports `thinking_summaries: "auto"` in `agent_config`, surfacing intermediate reasoning for user visibility. The status model (`in_progress` → `completed`/`failed`) provides coarse-grained progress.

**Async architecture**: Gemini Deep Research is exclusively async — the API returns immediately with a reference to the in-progress interaction. This is the correct UX pattern for operations that take minutes to hours: the client polls or subscribes for updates rather than holding a connection open.

**Report UI**: OpenAI added a full-screen report view and redesigned sidebar for Deep Research in 2025, making it easier to start, review, and manage research as a first-class document rather than a chat response.

**Focus constraints**: OpenAI added the ability to constrain Deep Research to specific websites, reducing search scope for domain-specific research tasks.

---

## 10. Known Failure Modes

Despite impressive capabilities, all current deep research systems exhibit well-documented failure modes.

**Hallucination propagation**: The DeepHalluBench study found that intermediate hallucinations in planning cascade through the entire research trajectory. A flawed decomposition in the first step contaminates all downstream search queries, source selection, and synthesis. End-to-end evaluation (judging only the final report) misses these accumulated intermediate errors.

**Citation fabrication**: A compound taxonomy identifies five failure modes: Total Fabrication (66% of cases in the NeurIPS 2025 citation hallucination study), Partial Attribute Corruption (27%), Identifier Hijacking (4%), Placeholder Hallucination (2%), and Semantic Hallucination (1%). Deep research agents generate citations that appear plausible but link to non-existent or unrelated sources — a form of hallucination that escaped detection by 3–5 expert reviewers in 53 published NeurIPS 2025 papers.

**Rabbit hole descent**: Without strong drift detection, agents follow interesting tangential threads away from the original query. Anthropic documents this as one of the top early failure modes: agents that endlessly search for nonexistent sources or continue research long after obtaining sufficient results.

**Echo chamber retrieval**: Agents that issue similar search queries across iterations retrieve the same sources repeatedly, creating artificial confidence through repetition rather than independent confirmation. N-gram deduplication and URL-level deduplication mitigate but don't fully solve this.

**Source quality failures**: Without authority-aware ranking, agents prefer highly-ranked SEO content farms over authoritative primary sources. This is a structural bias of web search APIs that agents inherit.

**Overspawning**: Early multi-agent implementations spawned 50 subagents for simple queries. Explicit scaling rules in system prompts are the documented mitigation, but the right number of subagents for a given query complexity remains a judgment call without a principled solution.

**Benchmark misalignment**: Current evaluation frameworks (BrowseComp, GAIA, GPQA) test specific retrieval and reasoning capabilities but don't fully capture practical deep research quality. OpenAI Deep Research achieves 51.5% on BrowseComp (vs. near-zero for non-research models), but BrowseComp measures single targeted fact retrieval, not comprehensive multi-angle synthesis. Most benchmarks omit report generation quality entirely.

**Stale information**: Web search APIs have indexing delays. Grok DeepSearch's integration with X/Twitter's real-time feed is specifically designed to provide recency that web indexes miss, but most systems have no special handling for "published in the last 24 hours" queries.

**Cognitive bias inheritance**: The "chat-chamber effect" — users who trust and internalize unverified AI outputs — creates downstream risk. Research agents can propagate single-source misinformation with apparent confidence because they retrieved that misinformation from a seemingly authoritative source.

---

## Zylos Implications

The deep research agent space has several direct implications for Zylos's own long-running agent design.

**Context budget as a first-class concern**: Every session that runs for more than a few minutes needs explicit context budget management. The Anthropic model — saving plans to external memory when approaching 200K tokens, using checkpoint summarization before spawning fresh subagents — is the right pattern. Zylos's current sessions/current.md approach is a lightweight version of this; for longer-running tasks, a two-tiered approach (compressed in-context + external structured storage) would handle heavier workloads. The Step-DeepResearch finding that patch-based editing reduces output costs by 70%+ vs. full rewrites is also relevant to any task involving iterative document updates.

**Parallel subagent decomposition**: For research or multi-angle investigation tasks, the Anthropic orchestrator-worker pattern is directly applicable. A lead Claude Opus call that decomposes a task and defines structured subagent objectives, followed by parallel Sonnet subagents, consistently outperforms single-agent approaches at the same total token budget. The 90.2% improvement figure should inform any decision about whether to parallelize a heavy research or analysis workload.

**Explicit scaling rules in prompts**: The failure mode of over-spawning subagents is avoidable with explicit rules: "use 1 subagent for simple tasks, 2–4 for comparisons, 10+ for comprehensive research." These rules belong in the system prompt, not left to model judgment.

**Async execution model**: Deep research's async pattern (request → in-progress reference → poll/stream for completion) maps naturally to Zylos's scheduler (C5) and background Task model. Long-running research requests should be dispatched as scheduled background tasks with progress checkpoints, not synchronous blocking calls.

**Quality control gates**: Before synthesis, a dedicated citation verification pass (equivalent to Anthropic's CitationAgent) should check that every cited source actually supports its attributed claim. LLM-as-judge with explicit rubric criteria (factual accuracy, citation accuracy, completeness, source quality, tool efficiency) provides a scalable evaluation pattern.

**Convergence on ReAct + memory**: The field has converged on ReAct-style loops with external memory as the baseline, with multi-agent parallelism as the primary performance lever. Systems that diverge significantly from this pattern (pure static pipelines, single-pass retrieval) consistently underperform on complex tasks. This validates the architecture direction of the current Zylos agent loop.

**Cost discipline**: At $10–$40/M tokens for frontier reasoning models, a 15x token multiplier for agent vs. chat workloads means a complex research task can cost $5–$30. Prompt caching (targeting 50–70% cache hit rates on repeated context) and careful model tier selection (Sonnet subagents, Opus orchestrators) are essential to keeping per-task costs acceptable. The Anthropic finding that a better model beats a larger token budget means model selection matters more than throwing tokens at the problem.

---

## References

- https://openai.com/index/introducing-deep-research/ — OpenAI Deep Research announcement, February 2025
- https://cdn.openai.com/deep-research-system-card.pdf — OpenAI Deep Research System Card
- https://platform.openai.com/docs/guides/deep-research — OpenAI Deep Research API documentation
- https://developers.openai.com/api/docs/models/o3-deep-research — o3-deep-research model page
- https://blog.promptlayer.com/how-deep-research-works/ — PromptLayer technical analysis of OpenAI Deep Research architecture
- https://www.anthropic.com/engineering/multi-agent-research-system — Anthropic engineering blog: How we built our multi-agent research system
- https://ai.google.dev/gemini-api/docs/deep-research — Gemini Deep Research API documentation
- https://blog.google/technology/developers/deep-research-agent-gemini-api/ — Google blog: Build with Gemini Deep Research
- https://docs.perplexity.ai/getting-started/models/models/sonar-deep-research — Perplexity Sonar Deep Research model docs
- https://research.perplexity.ai/articles/architecting-and-evaluating-an-ai-first-search-api — Perplexity research: Architecting an AI-first search API
- https://x.com/xai/status/1892400134178164775 — xAI announcement of Grok DeepSearch and Think mode
- https://github.com/assafelovic/gpt-researcher — GPT-Researcher open-source repository
- https://github.com/stanford-oval/storm — Stanford STORM open-source repository
- https://storm-project.stanford.edu/research/storm/ — Stanford STORM research project page
- https://arxiv.org/abs/2601.22984 — "Why Your Deep Research Agent Fails? On Hallucination Evaluation in Full Research Trajectory" (DeepHalluBench)
- https://arxiv.org/abs/2506.18096 — "Deep Research Agents: A Systematic Examination And Roadmap"
- https://arxiv.org/html/2508.12752v1 — "Deep Research: A Survey of Autonomous Research Agents"
- https://arxiv.org/html/2512.20491v1 — Step-DeepResearch Technical Report
- https://arxiv.org/html/2601.04879v1 — "Mind2Report: A Cognitive Deep Research Agent for Expert-Level Commercial Report Synthesis"
- https://arxiv.org/html/2509.04499 — "DeepTRACE: Auditing Deep Research AI Systems for Tracking Reliability Across Citations and Evidence"
- https://openai.com/index/browsecomp/ — BrowseComp benchmark for browsing agents
- https://arxiv.org/html/2504.12516v1 — BrowseComp paper
- https://blog.bytebytego.com/p/how-openai-gemini-and-claude-use — ByteByteGo: How OpenAI, Gemini, and Claude use agents for deep research
- https://pricepertoken.com/pricing-page/model/openai-o3-deep-research — o3-deep-research pricing
- https://pricepertoken.com/pricing-page/model/perplexity-sonar-deep-research — Perplexity Sonar Deep Research pricing
- https://parallel.ai/blog/deep-research — Parallel.ai state of the art deep research APIs
- https://parallel.ai/blog/deep-research-benchmarks — Parallel.ai deep research price-performance benchmarks
- https://arxiv.org/html/2503.09572v3 — "Plan-and-Act: Improving Planning of Agents for Long-Horizon Tasks"
- https://arxiv.org/html/2510.24699v1 — "AgentFold: Long-Horizon Web Agents with Proactive Context Management"
- https://journals.sagepub.com/doi/10.1177/20539517241306345 — "The chat-chamber effect: Trusting the AI hallucination"
- https://github.com/texttron/BrowseComp-Plus — BrowseComp-Plus benchmark (ACL 2026)
