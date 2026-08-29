---
date: "2026-08-29"
title: "Cross-Thread Association and Advisory Nudges in Single-Persona Multi-Thread Agents"
description: "When one agent identity runs many isolated conversations, only the memory-consolidation pass can see that thread A and thread B are about the same thing. How should it tell them? A survey of how Claude Tag, ChatGPT memory, Gemini, Copilot, Letta, Zep, A-MEM and HippoRAG link episodes and surface links — and why 'pointer, advisory, rate-limited, permission-scoped' is the design that survives the documented failure modes."
tags: ["ai-agents", "memory", "multi-session", "context-engineering", "prompt-injection", "notifications", "agent-architecture"]
---

## Executive Summary

A persistent agent that serves one organization ends up holding many conversations at once: a group chat, three DMs, a task thread spawned from a ticket. The obvious architecture isolates them — each thread gets its own context window, its own running log, its own "what did I promise here" state — because letting them bleed into each other is how you get the failure modes every memory product has now shipped at least once: a client's name surfacing in another client's contract summary, an assistant announcing facts it learned in a private channel inside a public one, a "daily brief" that resurfaces last week's search history and reads as surveillance rather than help.

But a single persona is supposed to be one mind. If the person in DM B asks about the release that thread A just decided to slip, the agent that answers "I don't know" is not isolated, it is amnesiac. Someone has to notice that A and B are related. In the architecture this note assumes — isolated live threads plus a periodic consolidation pass that reads every thread's log and folds it into long-term memory — that consolidation pass is the *only* component with a cross-thread view. The design question is narrow and concrete: when consolidation spots a link between two live threads, what does it send, to whom, in what form, and with what guardrails so the receiving thread treats it as a hint rather than a command?

The survey below reaches a consistent answer, assembled from what shipping systems do and from what has gone wrong when they did something else:

- **Send a pointer, not a payload.** Zep/Graphiti's whole architecture is built so every synthesized fact traces back to its source episode; the link is a citation, not a copy. Injecting summaries silently (the ChatGPT and Gemini pattern) is what produces the "how did it know that?" reactions and the cross-client leaks.
- **Deliver it as advisory data, tagged as such.** Anthropic's own developer guidance says the model treats tool-result content as untrusted and that instructions placed there may be ignored or flagged; OWASP LLM01 says to segregate and clearly denote external content. A cross-thread note should live in exactly that tier — something the receiving thread may mention, never something it must obey — because the "Bad Memory" study shows a payload sitting in a memory file is a durable, multi-session attack surface.
- **Let the receiving thread say nothing.** Claude Tag's stated design principle (as reported) is that an annoying agent is worse than an unhelpful one; it goes dormant in channels where it repeatedly has nothing to add. A nudge mechanism without a silence option and a backoff rule becomes alert fatigue, and the clinical-alert literature puts override rates for badly tuned systems at the 49–96% range.
- **Scope by permission, default to isolation.** Claude Tag gathers facts across channels only where admins grant it; Microsoft Copilot Studio keeps a separate memory store per person on purpose; Meta AI's memory excludes group chats entirely. The systems that skipped the scoping step are the ones with incident write-ups.
- **Accept read-time staleness and design for it.** Letta's sleep-time compute writes links "anytime" and the live agent reads whenever it reads; nobody documents recomputing link relevance at read time. A pointer that names its source lets the receiving thread re-check freshness; an injected summary cannot.

The rest of this note walks the evidence: what each system actually does (section 1), the design primitives with their trade-offs (section 2), the documented failure modes (section 3), and a minimal implementable design with metrics (section 4).

## 1. What Shipping Systems Actually Do

### Claude Tag (Claude in Slack)

Claude Tag is the closest production analogue to the single-persona, many-thread setting: one Claude identity works across many Slack channels with per-channel memory. Anthropic's help center dates the switch-over to the new Claude Tag experience to August 3, 2026. Press coverage of the 2026 update (VentureBeat) describes the per-message decision as a choice among four moves — reply inline, start deeper work in a thread, route the message into an existing workstream, or say nothing — and reports that Anthropic replaced a lightweight per-message classifier with a design that reads the channel's full context plus memory and standing instructions, so the agent can synthesize across speakers who never addressed each other (one engineer states a theory, another posts evidence for the same bug, Claude opens the thread).

Three properties matter for our question. First, cross-channel awareness is opt-in and admin-gated: the help center describes Claude gathering facts from elsewhere in the organization only when it has been granted permission to read other channels, with admins controlling which tools and information the model can access in which channels. Second, isolation is an explicit promise: coverage quotes Anthropic saying Claude will not leak one channel's context into a different channel — facts can inform behavior across channels without being re-exposed verbatim. Third, restraint is a stated design goal: the reported principle is that an annoying agent is worse than an unhelpful one, and the agent goes dormant in channels where it repeatedly has nothing to add. Admins additionally get a spend cap and an audit log of everything the agent did and who asked for it.

Claude Tag surfaces cross-context knowledge as *an agent turn in-channel* — visible, attributable, and channel-scoped — not as an invisible injection. That is the "notification" end of the design spectrum.

### ChatGPT memory and "reference chat history"

OpenAI's memory has two documented layers — explicit saved memories and an implicit layer (rolled out April 2025, expanded June 2025) that automatically draws relevant context from past conversations into new ones — and, per independent reverse-engineering, a third undocumented layer of dense periodic user summaries injected into hidden system context, not visible or editable in settings. Surfacing is fully automatic, silent, and payload-level: the context is injected, not pointed to.

The documented failure is instructive precisely because it is not a bug in the narrow sense. A lawyer disabled the Memory setting, then asked ChatGPT to summarize a contract; it opened by referencing his other client. The write-up's conclusion: a setting labeled "memory" does not necessarily cover every place a product can pull in prior context. A separate 2025 episode — ChatGPT using stored names unprompted inside visible reasoning traces, independent of memory settings — drew "creepy and unnecessary" from named developers in TechCrunch's reporting. Both are the same shape: cross-conversation knowledge arriving with no provenance and no consent gate.

### Gemini "Personal Context" and the Daily Brief

Google's 2025 rollout gave Gemini cross-chat recall paired with a proactive Daily Brief that resurfaces prior activity — past searches, unfinished research — without being asked. TechCrunch's August 2026 critique is blunt: the brief cannot tell the difference between something urgent or actionable and an unsolicited nudge to follow up on other things, and the second kind "doesn't feel useful; it feels creepy." Press coverage describes the feature as on by default with a kill switch and a temporary-chat mode (we could not confirm those controls against Google's own documentation). The Daily Brief is the purest example of a proactive cross-thread surfacing mechanism shipped without a relevance threshold or a silence option.

### Microsoft Copilot Studio Memory and Meta AI

Two deliberate non-implementations bracket the space. Microsoft's Copilot memory is documented as per-user by design — a separate memory store per person so one user's context is never visible to another — which is to say cross-thread linking across people is ruled out at the architecture level. Meta AI's memory (1:1 chats on WhatsApp and Messenger, 2025) explicitly does not support group chats, while users can delete memories but cannot opt out of the underlying personalization. Both vendors chose scope boundaries over cleverness; both boundaries are exactly the ones the Slack and Copilot incidents (section 3) violated.

### Letta / MemGPT sleep-time compute

Letta's sleep-time architecture is the closest published description of "a background pass is the thing that writes cross-context memory." A sleep-time agent — often a stronger, slower model — processes context while the primary agent is idle and writes learned context into shared memory blocks that the live agent reads. Two design decisions transfer directly. The primary agent lacks tools to edit its own core memory; only the sleep-time agent can, which Letta presents as the fix for the original MemGPT design that bundled memory editing and conversation in one agent. And updates are "anytime": the sleep-time agent modifies memory in an anytime fashion, so the primary agent can read it whenever, without waiting for the sleep-time agent to finish its reasoning. Freshness is asynchronous and read-time-eventual — the live thread never blocks on consolidation, and consequently what it reads may be one cycle stale.

### Zep / Graphiti, A-MEM, HippoRAG: how episodes get linked

Three research systems give the mechanics of *detecting* that two episodes are related, which is the step before surfacing.

Zep's temporal knowledge graph (Graphiti; arXiv, January 2025) stores raw episodes, extracts entity nodes and semantic edges from them, and keeps bidirectional episodic edges so that any synthesized fact can be traced back to the episode it came from — the paper describes episodes being able to quickly retrieve their relevant entities and facts. Zep reports 94.8% on the Deep Memory Retrieval benchmark against MemGPT's 93.4%, and up to 18.5% accuracy improvement with 90% latency reduction on LongMemEval. The architectural point is provenance-first: a link is a path back to a source, which is what makes it citable and re-checkable.

A-MEM (arXiv, February 2025; NeurIPS 2025) draws on the Zettelkasten method: each new memory is an atomic note that is dynamically indexed and linked to related existing notes, and writing a new note can trigger retroactive updates to the older notes it links to. Context propagates both forward and backward through the network — the closest thing in the agent literature to "a new event changes what an old thread should know."

HippoRAG (NeurIPS 2024) models a parahippocampal encoder plus an artificial hippocampus (an open knowledge graph) and uses Personalized PageRank to stand in for hippocampal pattern completion — linking a query's named entities to a persistent index built from many past episodes. It is the explicit spreading-activation analogue: relevance flows out from the entities a thread is currently touching to the episodes that share them, which is also how ACT-R's associative memory formalizes retrieval (contextual activation from current goals plus base-level recency and frequency).

### Cross-linking in issue trackers

Linear's GitHub integration links issues to PRs and commits and updates status from PR activity; genuinely AI-driven related-issue detection exists as third-party GitHub Actions that compute embedding similarity against a configurable threshold and post a cross-reference *comment* — a pointer with a one-line rationale, advisory only, that a human then acts on or ignores. This is the design this note recommends, already running in production, just not from a first-party vendor. Notion AI's marketing describes identifying relationships between pieces of data, but community answers indicate users cannot prompt it to consult other pages when answering; we treat that as aspiration rather than documented behavior.

## 2. Design Primitives and Their Trade-offs

### Notification versus context injection

The systems split cleanly. ChatGPT, Gemini and Meta inject cross-conversation payloads directly into the live context, invisibly and without a consent gate. Claude Tag posts as an agent turn: visible, attributable, scoped to the channel. The GitHub duplicate detector posts a discrete comment with its reasoning. Every documented "creepy" reaction and every cross-client leak in section 3 sits on the injection side of this line. Injection optimizes for the answer "just landing"; notification optimizes for the recipient knowing where a fact came from and being able to decline it.

### Pointer plus rationale versus summary payload

Zep/Graphiti is the strongest documented pointer-first design: every fact carries provenance back to its source episode. A-MEM's interlinked notes are closer to payload-plus-pointer (summaries that reference each other). For cross-thread nudges the pointer form has a property the payload form lacks: the receiving thread can go read the source (or ask the source thread directly) and judge freshness and relevance for itself, instead of trusting a summary that was true at consolidation time. It also keeps the consolidation pass out of the business of deciding *how much* of thread A thread B is allowed to see — the pointer names a location whose access is governed by whatever permission model already exists.

### Freshness: computed at sync time, read later

Letta's sleep-time compute commits explicitly to write-time-asynchronous, read-time-eventual consistency. No source we found documents a system that re-scores a cross-thread link's relevance at read time; that trade-off is underspecified across the field. The practical consequence for a consolidation-driven design: a link is at best as fresh as the last consolidation cycle, and the receiving thread may pick it up one or more cycles later still (if it was asleep and got woken). The mitigation is structural, not algorithmic — the note carries a timestamp and a pointer, and the receiving thread treats it as "as of then," re-checking at the source if it matters.

### Dedup and rate limits

Claude Tag's dormancy after repeated no-value turns is the only first-party documented anti-spam mechanism among the surveyed systems; no vendor publishes a numeric threshold. The general evidence that thresholds matter is strong: clinical alert systems show override rates between 49% and 96% when poorly tuned, and product-design guidance on AI nudges argues that a nudge the user will not respond to is worse than none because it accelerates notification fatigue. For cross-thread nudges the analogous rules are: one nudge per (source, target, topic) pair per consolidation cycle; suppress repeats until the source changes; back off a target thread that has ignored N nudges.

### Relevance scoring

Four documented recipes, cheapest first: embedding similarity between thread summaries with a configurable threshold (the GitHub Action); entity overlap via graph traversal with Personalized PageRank (HippoRAG); the Generative Agents blend of recency, embedding relevance, and self-rated importance; and temporal knowledge-graph edges with contradiction handling (Zep). A consolidation pass that already extracts entities and users per thread gets the second and third almost for free; the first needs only an embedding call per thread summary.

### "Advisory, not instruction" — the prompt-injection lens

This is the guardrail the surveyed products mostly do not talk about and the security literature does. Anthropic's developer guidance is explicit: do not put your own instructions in tool results, because Claude treats tool-result content as untrusted data and instructions placed there may be ignored or flagged as a potential injection; tag untrusted content with identifiers the model recognizes as external data, and never place it in the system prompt or plain user text. OWASP's LLM01:2025 gives the general form: segregate and identify external content, separating and clearly denoting untrusted content to limit its influence on prompts.

The "Bad Memory" study (arXiv 2607.14611, 2026) makes the stakes concrete for exactly our architecture. Testing Claude Code and OpenAI Codex agents across models, it finds that persistent memory files create a durable, multi-session attack surface — a payload already in those files can influence behavior and persist across sessions — while noting that agents rarely self-overwrite trusted files from untrusted external input. Its mitigation is tiered trust: low-trust knowledge can supply facts but cannot override safety rules, with re-validation at every session start. A cross-thread note written by the consolidation pass into a live thread is, by construction, content that originated in a *different* conversation with possibly different participants. It belongs in the low-trust tier: it may inform, it may not instruct.

## 3. Documented Failure Modes

**Cross-context leakage.** The 2024 Slack AI prompt-injection flaw let an attacker post a crafted message in a public channel that, when a victim later queried Slack AI, caused private-channel content to surface in the answer — because the retrieval design pulled from public channels the user had not joined, a behavior Slack initially treated as intended. Microsoft 365 Copilot had a 2025 flaw in its "work tab" chat that could read and summarize emails marked confidential, bypassing DLP; a separate zero-click exploit (EchoLeak, CVE-2025-32711) was disclosed the same year. In both cases the mechanism is the same as an unguarded cross-thread nudge: content from one context, reachable by retrieval, was rendered into another context without a scope check.

**The toggle that does not cover the path.** The ChatGPT law-firm case shows what happens when a product has more retrieval surfaces than it has switches: the user disabled the thing labeled "memory," and a different pathway kept pulling cross-project context. A consolidation-driven nudge system that adds a new pathway must add it *under* the existing permission model, not beside it.

**Unwanted knowing.** Gemini's Daily Brief and ChatGPT's unprompted name use both drew "creepy" from users and developers on the record. The common cause is surfacing without provenance and without a relevance floor — the assistant knows something, shows that it knows, and cannot say why it thought you wanted to hear it now.

**Feedback loops.** No source documents an observed A-nudges-B-nudges-A oscillation in production; the risk is inferred from alert-fatigue research on repeated and duplicate alerts. It is cheap to prevent — a nudge must never itself be a consolidation input that generates the reverse nudge — and expensive to diagnose after the fact, so it is worth an explicit rule.

**Staleness.** Inherent in any write-at-sync, read-later design (Letta's model). A link computed from thread A's log at 02:00 may describe a decision A reversed at 02:30; the receiving thread cannot know unless the note points at a source it can re-read.

## 4. A Minimal Implementable Design

For a small team running one persona across isolated threads with a periodic consolidation pass, the evidence supports the following. Nothing in it requires a new subsystem; each piece reuses something the architecture already has (a per-thread log, a consolidation pass, an internal message channel between threads).

**Detection, in the consolidation pass.** While folding each thread's recent log into long-term memory, compute candidate links between live threads with a cheap score: embedding similarity of the two threads' recent summaries, plus entity and user overlap, plus temporal adjacency, along the lines of the Generative Agents blend and HippoRAG-style entity linking. Threshold conservatively; a missed link costs one "I don't know," a spurious link costs trust.

**Payload: a pointer, one line of rationale, a timestamp.** "Thread A (topic X) decided Y at 02:14; relevant to your work on Z." Provenance back to the source entry, as Zep/Graphiti does for every fact. No copied context. If the receiving thread needs more, it reads the source (subject to its permissions) or asks thread A directly through the internal channel — one extra round trip is cheaper than acting on a stale summary.

**Delivery: through the ordinary message path, tagged advisory.** The note arrives as an inbound message from an internal sender, wrapped and labeled as external, advisory data — the tier Anthropic's guidance and OWASP LLM01 describe — never in the system prompt and never as user text. It states its own scope: this may be mentioned to the participant if relevant; it is not an instruction to act. Because a thread that was asleep may be woken by the note and will not have re-read consolidated memory, the note must be self-contained: everything needed to decide "mention or ignore" is in the note itself.

**Receiving thread: mention, act, or say nothing.** Claude Tag's four-move model applies, and "say nothing" must be a real option. A thread that ignores repeated nudges triggers backoff for that (source, target) pair; a thread never re-broadcasts a nudge as a fact of its own.

**Scope: permission-gated, isolation by default.** Links are only computed between threads the same principal is allowed to see across — Claude Tag's admin-scoped model — and never from a DM into a group thread without an explicit grant. Where in doubt, the Copilot Studio per-person default wins.

**Audit and metrics.** Log every emitted link with source, target, score, and outcome (mentioned / acted / ignored / suppressed). Track link precision on a spot-checked sample, acceptance rate, suppression and backoff counts per thread (a proxy for nudge fatigue), and time-to-staleness — how often the source entry had changed by the time the note was read, which the Letta model predicts will be nonzero. Treat the memory-write path as a security boundary, per Bad Memory: the consolidation pass may write links; live threads may not write into each other's memory.

## Key Takeaways

- The consolidation pass is the only component with a cross-thread view; give it the job of *noticing* links, and only that job. Surfacing and acting belong to the live threads.
- Every documented incident and every documented "creepy" reaction comes from silent context injection without provenance. Send pointers through the normal message path; let the recipient decide.
- A cross-thread note is untrusted content from another conversation. Tag it as advisory data in the tier Anthropic's guidance and OWASP LLM01 describe; the Bad Memory results show why persistent memory that can instruct is an attack surface.
- Silence is a first-class response. The one first-party anti-spam mechanism in the survey (Claude Tag's dormancy) is behavioral, not numeric; add explicit per-pair rate limits and backoff.
- Scope before cleverness: Claude Tag's admin gating, Copilot's per-person stores and Meta's group-chat exclusion are the boundaries the Slack and Copilot incidents crossed.
- Read-time staleness is inherent to sync-time linking (Letta). Timestamps and pointers make it survivable; summaries do not.
- Two gaps in the field worth watching: no published system re-scores link relevance at read time, and nobody publishes the dormancy or rate-limit thresholds that make proactive surfacing tolerable.

## References

- Anthropic Help Center, "What is Claude Tag?" — https://support.claude.com/en/articles/15594475-what-is-claude-tag
- Anthropic, "Introducing Claude Tag" — https://www.anthropic.com/news/introducing-claude-tag
- VentureBeat, "Anthropic's new Claude Tag update lets its Slack agent read the full conversation — and jump in unprompted" (2026) — https://venturebeat.com/orchestration/anthropics-new-claude-tag-update-lets-its-slack-agent-read-the-full-conversation-and-jump-in-unprompted
- OpenAI, "Memory and new controls for ChatGPT" (April 2025) — https://openai.com/index/memory-and-new-controls-for-chatgpt/
- Stephen Smith, "He Turned Off ChatGPT's Memory. It Referenced Another Client Anyway." — https://www.smithstephen.com/p/he-turned-off-chatgpts-memory-it
- TechCrunch, "ChatGPT is referring to users by their names unprompted and some find it creepy" (April 18, 2025) — https://techcrunch.com/2025/04/18/chatgpt-is-referring-to-users-by-their-names-unprompted-and-some-find-it-creepy
- TechCrunch, "Google's Gemini has a branding problem, and so does the rest of AI" (August 26, 2026) — https://techcrunch.com/2026/08/26/googles-gemini-has-a-branding-problem-and-so-does-the-rest-of-ai/
- Microsoft, "Introducing Copilot Memory" (2025) — https://techcommunity.microsoft.com/blog/microsoft365copilotblog/introducing-copilot-memory-a-more-productive-and-personalized-ai-for-the-way-you/4432059
- Silicon Republic, "Meta AI can now remember details from your chats" (2025) — https://www.siliconrepublic.com/machines/meta-ai-memory
- Letta, "Sleep-time Compute" (2025) — https://www.letta.com/blog/sleep-time-compute/
- Rasmussen et al., "Zep: A Temporal Knowledge Graph Architecture for Agent Memory" (arXiv 2501.13956, January 2025) — https://arxiv.org/abs/2501.13956
- Xu et al., "A-MEM: Agentic Memory for LLM Agents" (arXiv 2502.12110; NeurIPS 2025) — https://arxiv.org/abs/2502.12110
- Gutiérrez et al., "HippoRAG: Neurobiologically Inspired Long-Term Memory for Large Language Models" (NeurIPS 2024) — https://arxiv.org/abs/2405.14831
- Park et al., "Generative Agents: Interactive Simulacra of Human Behavior" (2023) — https://arxiv.org/abs/2304.03442
- Anthropic Claude Platform Docs, "Mitigate jailbreaks and prompt injections" — https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks
- OWASP GenAI Security Project, "LLM01:2025 Prompt Injection" — https://genai.owasp.org/llmrisk/llm01-prompt-injection/
- "Bad Memory: Evaluating Prompt Injection Risks from Memory in Agentic Systems" (arXiv 2607.14611, 2026) — https://arxiv.org/abs/2607.14611
- The Register, "Slack AI can leak private data via prompt injection" (August 21, 2024) — https://www.theregister.com/2024/08/21/slack_ai_prompt_injection/
- Metomic, "Microsoft 365 Copilot Security Risks: 2026 Guide" — https://www.metomic.io/resource-centre/what-are-the-security-risks-of-microsoft-co-pilot/
- GitHub Marketplace, "AI-Powered GitHub Issue Duplicates & Relations Detector" — https://github.com/marketplace/actions/ai-powered-github-issue-duplicates-relations-detector
- Shape of AI, "AI UX Patterns: Nudges" — https://www.shapeof.ai/patterns/nudges

*Verification note: quotations and figures attributed to Anthropic's help center, the Letta blog, the Zep, A-MEM, HippoRAG and Bad Memory papers, the Smith and TechCrunch pieces, The Register, and the Anthropic/OWASP guidance were checked against the source pages. Statements attributed to VentureBeat, OpenAI's announcement, Microsoft's blog and press descriptions of Gemini's controls could not be re-fetched mechanically and are reported as coverage rather than quoted.*
