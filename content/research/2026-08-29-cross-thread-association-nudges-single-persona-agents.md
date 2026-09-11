---
date: "2026-08-29"
title: "Cross-Thread Association and Advisory Nudges in Single-Persona Multi-Thread Agents"
description: "When one agent identity runs many isolated conversations, only the memory-consolidation pass can see that thread A and thread B are about the same thing. How should it tell them? A survey of how Claude Tag, ChatGPT memory, Gemini, Copilot, Letta, Zep, A-MEM and HippoRAG link episodes and surface links — and why 'pointer, advisory, rate-limited, permission-scoped' is the design that survives the documented failure modes."
tags: ["ai-agents", "memory", "multi-session", "context-engineering", "prompt-injection", "notifications", "agent-architecture"]
---

## Executive Summary

A persistent agent that serves one organization ends up holding many conversations at once: a group chat, three DMs, a task thread spawned from a ticket. The obvious architecture isolates them — each thread gets its own context window, its own running log, its own "what did I promise here" state — because letting them bleed into each other can produce the kinds of failure documented in this survey's small, heterogeneous sample: another client's name surfacing in a contract summary, private-channel content surfacing in a different context, or a "daily brief" resurfacing last week's search history and reading as surveillance rather than help.

But a single persona is supposed to be one mind. If the person in DM B asks about the release that thread A just decided to slip, the agent that answers "I don't know" is not isolated, it is amnesiac. Someone has to notice that A and B are related. In the architecture this note assumes — isolated live threads plus a periodic consolidation pass that reads every thread's log and folds it into long-term memory — that consolidation pass is the *only* component with a cross-thread view. The design question is narrow and concrete: when consolidation spots a link between two live threads, what does it send, to whom, in what form, and with what guardrails so the receiving thread treats it as a hint rather than a command?

The survey below reaches a consistent answer, assembled from what shipping systems do and from what has gone wrong when they did something else:

- **Send a pointer, not a payload.** Zep/Graphiti's whole architecture is built so every synthesized fact traces back to its source episode; the link is a citation, not a copy. Historical ChatGPT and Gemini incidents show why silently injected summaries can produce "how did it know that?" reactions, even though both products now expose substantially more provenance and control.
- **Deliver it as advisory data, tagged as such.** Anthropic's own developer guidance says the model treats tool-result content as untrusted and that instructions placed there may be ignored or flagged; OWASP LLM01 says to segregate and clearly denote external content. A cross-thread note should live in exactly that tier — something the receiving thread may mention, never something it must obey — because the "Bad Memory" study shows a payload sitting in a memory file is a durable, multi-session attack surface.
- **Let the receiving thread say nothing.** Claude Tag's stated design principle (as reported) is that an annoying agent is worse than an unhelpful one; it goes dormant in channels where it repeatedly has nothing to add. A nudge mechanism without a silence option and a backoff rule becomes alert fatigue, and the clinical-alert literature puts override rates for badly tuned systems at the 49–96% range.
- **Scope by permission, default to isolation.** Claude Tag gathers facts across channels only where admins grant it; Microsoft Copilot Studio keeps a separate memory store per person on purpose; Meta AI's memory excludes group chats entirely. These are illustrative scope choices, while the incident reports below document different retrieval and enforcement failures in other products; this sample does not establish a population-wide rule about all systems without scoping.
- **Accept read-time staleness and design for it.** Letta 0.7.0's sleep-time-enabled agent type wrote memory "anytime" while the live agent continued; the broader field still leaves read-time relevance re-scoring underspecified. A pointer that names its source lets an authorized recipient re-check freshness; an injected summary cannot.

The rest of this note walks the evidence: what each system actually does (section 1), the design primitives with their trade-offs (section 2), the documented failure modes (section 3), and a minimal implementable design with metrics (section 4).

## 1. What Shipping Systems Actually Do

### Claude Tag (Claude in Slack)

Claude Tag is the closest production analogue to the single-persona, many-thread setting: one Claude identity works across many Slack channels with per-channel memory. Anthropic's help center dates the switch-over to the new Claude Tag experience to August 3, 2026. Press coverage of the 2026 update (VentureBeat) describes the per-message decision as a choice among four moves — reply inline, start deeper work in a thread, route the message into an existing workstream, or say nothing — and reports that Anthropic replaced a lightweight per-message classifier with a design that reads the channel's full context plus memory and standing instructions, so the agent can synthesize across speakers who never addressed each other (one engineer states a theory, another posts evidence for the same bug, Claude opens the thread).

Three properties matter for our question. First, cross-channel awareness is opt-in and admin-gated: the help center describes Claude gathering facts from elsewhere in the organization only when it has been granted permission to read other channels, with admins controlling which tools and information the model can access in which channels. Second, isolation is an explicit promise: coverage quotes Anthropic saying Claude will not leak one channel's context into a different channel — facts can inform behavior across channels without being re-exposed verbatim. Third, restraint is a stated design goal: the reported principle is that an annoying agent is worse than an unhelpful one, and the agent goes dormant in channels where it repeatedly has nothing to add. Admins additionally get a spend cap and an audit log of everything the agent did and who asked for it.

Claude Tag surfaces cross-context knowledge as *an agent turn in-channel* — visible, attributable, and channel-scoped — not as an invisible injection. That is the "notification" end of the design spectrum.

### ChatGPT memory and "reference chat history"

OpenAI's current documentation describes memory as a continually updated synthesis of past chats and other enabled sources. Users can inspect and directly correct a Memory Summary, see response-level Memory Sources through the book icon, delete memories, turn memory off, or use Temporary Chat. Project-only memory can constrain references to conversations inside one project, although availability and defaults vary by plan and workspace. Memory Sources are useful provenance but are not represented as an exhaustive account of every factor that shaped a response.

Those controls postdate or clarify the surfaces discussed in two historical reports. A law-firm article published in May 2026 described a lawyer disabling the then-visible Memory setting before a contract summary referenced another client; the author argued that the control did not cover every path that could supply prior context at that time. A separate April 2025 episode — ChatGPT using names unprompted inside visible reasoning traces — drew "creepy and unnecessary" from named developers in TechCrunch's reporting, which said the cause and any relationship to memory were unclear. These are reports of cross-conversation or unexpectedly personal knowledge arriving without provenance that was legible to the recipient, not descriptions of the current control surface or proof of one shared mechanism.

### Gemini "Personal Context" and the Daily Brief

Google's 2025 rollout gave Gemini cross-chat recall; its 2026 Personal Intelligence and Daily Brief surfaces can also synthesize Gemini chats and connected apps into proactive items. Google's current help pages expose each Daily Brief item's source, let a user mark it complete or dismiss it, accept helpful/not-helpful feedback, and provide a full Daily Brief off switch. Personal Intelligence can also be disabled for one chat, while Temporary Chat avoids saving or using that chat for personalization. TechCrunch's August 2026 critique remains useful as a historical user reaction to low-relevance proactive items, but "no provenance" and "no silence option" are no longer accurate descriptions of the documented product.

### Microsoft Copilot Studio Memory and Meta AI

Two deliberate non-implementations bracket the space. Microsoft's Copilot memory is documented as per-user by design — a separate memory store per person so one user's context is never visible to another — which is to say cross-thread linking across people is ruled out at the architecture level. Meta AI's memory (1:1 chats on WhatsApp and Messenger, 2025) explicitly does not support group chats, while users can delete memories but cannot opt out of the underlying personalization. Both vendors chose explicit scope boundaries over cleverness. They illustrate design options for this note; they are not the controls implicated in the separate Slack AI retrieval and Microsoft 365 DLP incidents in section 3.

### Letta / MemGPT sleep-time compute

Letta's April 2025 sleep-time design is the closest published description of "a background pass is the thing that writes cross-context memory," but its claim must be scoped to the sleep-time-enabled agent type released with Letta 0.7.0. In that design, the primary conversational agent did not receive the memory-editing tools; a separate sleep-time agent processed context and modified shared memory blocks in an "anytime" fashion, so the primary agent could continue and later read an asynchronously updated block.

That was not a platform-wide invariant even for long. In September 2025 Letta introduced a built-in memory omni-tool that let agents modify, create, and delete their own memory blocks. In February 2026 Letta Code introduced Context Repositories: git-backed memory files managed with normal filesystem tools and background subagents; Letta subsequently described server-side sleep-time agents as being replaced by client-side subagents. The transferable property is therefore asynchronous background consolidation, not a current rule that only a sleep-time agent may edit memory.

### Zep / Graphiti, A-MEM, HippoRAG: how episodes get linked

Three research systems give the mechanics of *detecting* that two episodes are related, which is the step before surfacing.

Zep's temporal knowledge graph (Graphiti; arXiv, January 2025) stores raw episodes, extracts entity nodes and semantic edges from them, and keeps bidirectional episodic edges so that any synthesized fact can be traced back to the episode it came from — the paper describes episodes being able to quickly retrieve their relevant entities and facts. Zep reports 94.8% on the Deep Memory Retrieval benchmark against MemGPT's 93.4%, and up to 18.5% accuracy improvement with 90% latency reduction on LongMemEval. The architectural point is provenance-first: a link is a path back to a source, which is what makes it citable and re-checkable.

A-MEM (arXiv, February 2025; NeurIPS 2025) draws on the Zettelkasten method: each new memory is an atomic note that is dynamically indexed and linked to related existing notes, and writing a new note can trigger retroactive updates to the older notes it links to. Context propagates both forward and backward through the network — the closest thing in the agent literature to "a new event changes what an old thread should know."

HippoRAG (NeurIPS 2024) models a parahippocampal encoder plus an artificial hippocampus (an open knowledge graph) and uses Personalized PageRank to stand in for hippocampal pattern completion — linking a query's named entities to a persistent index built from many past episodes. It is the explicit spreading-activation analogue: relevance flows out from the entities a thread is currently touching to the episodes that share them, which is also how ACT-R's associative memory formalizes retrieval (contextual activation from current goals plus base-level recency and frequency).

### Cross-linking in issue trackers

Linear's GitHub integration links issues to PRs and commits and updates status from PR activity; genuinely AI-driven related-issue detection exists as third-party GitHub Actions that compute embedding similarity against a configurable threshold and post a cross-reference *comment* — a pointer with a one-line rationale, advisory only, that a human then acts on or ignores. This is the design this note recommends, already running in production, just not from a first-party vendor. Notion AI's marketing describes identifying relationships between pieces of data, but community answers indicate users cannot prompt it to consult other pages when answering; we treat that as aspiration rather than documented behavior.

## 2. Design Primitives and Their Trade-offs

### Notification versus context injection

The surveyed systems expose a spectrum rather than a clean binary. ChatGPT and Gemini can inject remembered or personalized context into a live response, but their current products also expose source and control surfaces; Meta's cited implementation personalizes 1:1 chats. Claude Tag posts as an agent turn: visible, attributable, scoped to the channel. The GitHub duplicate detector posts a discrete comment with its reasoning. The historical "creepy" reactions and cross-context leaks in section 3 cluster around surfacing whose provenance or scope was not legible to the recipient. Injection optimizes for the answer "just landing"; notification makes origin and refusal easier to inspect.

### Pointer plus rationale versus summary payload

Zep/Graphiti is the strongest documented pointer-first design: every fact carries provenance back to its source episode. A-MEM's interlinked notes are closer to payload-plus-pointer (summaries that reference each other). For cross-thread nudges the pointer form has a property the payload form lacks: after disclosure authorization passes, the receiving thread can follow the source and judge freshness and relevance instead of trusting a summary frozen at consolidation time. A pointer is not permission by itself: both its visible label and the referenced content must remain non-sensitive until the source-to-target disclosure check succeeds.

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

**Cross-context leakage.** The 2024 Slack AI prompt-injection flaw let an attacker post a crafted message in a public channel that, when a victim later queried Slack AI, caused private-channel content to surface in the answer — because the retrieval design pulled from public channels the user had not joined, a behavior Slack initially treated as intended. Microsoft 365 Copilot had a 2025 flaw in its "work tab" chat that could read and summarize emails marked confidential, bypassing DLP; a separate zero-click exploit (EchoLeak, CVE-2025-32711) was disclosed the same year. These are different mechanisms and enforcement boundaries. What they contribute here is narrower: a retrieval or policy path can render content outside the context in which the recipient expected it to stay, so a new cross-thread path needs its own explicit disclosure check.

**The toggle that does not cover the path.** The 2026 law-firm report describes what its author interpreted as a product having more retrieval surfaces than the visible switch covered: the user disabled the thing labeled "memory," yet another client's context still appeared. The report does not independently establish which pathway supplied it. For this design, the conservative lesson is that a consolidation-driven nudge path must sit *under* the existing permission model, not beside it.

**Unwanted knowing.** Gemini's Daily Brief and ChatGPT's unprompted name use both drew "creepy" reactions from users and developers on the record. The reports establish the reaction, not a shared cause; TechCrunch explicitly said the cause of the name use and its relationship to memory were unclear. Treating visible provenance and a relevance floor as mitigations is therefore a design inference from the two examples, not a documented diagnosis of either product.

**Feedback loops.** No source documents an observed A-nudges-B-nudges-A oscillation in production; the risk is inferred from alert-fatigue research on repeated and duplicate alerts. It is cheap to prevent — a nudge must never itself be a consolidation input that generates the reverse nudge — and expensive to diagnose after the fact, so it is worth an explicit rule.

**Staleness.** Inherent in any write-at-sync, read-later design (Letta's model). A link computed from thread A's log at 02:00 may describe a decision A reversed at 02:30; the receiving thread cannot know unless the note points at a source it can re-read.

## 4. A Minimal Implementable Design

For a small team running one persona across isolated threads with a periodic consolidation pass, the evidence supports the following. Nothing in it requires a new subsystem; each piece reuses something the architecture already has (a per-thread log, a consolidation pass, an internal message channel between threads).

**Detection, in the consolidation pass.** While folding each thread's recent log into long-term memory, compute candidate links between live threads with a cheap score: embedding similarity of the two threads' recent summaries, plus entity and user overlap, plus temporal adjacency, along the lines of the Generative Agents blend and HippoRAG-style entity linking. Threshold conservatively; a missed link costs one "I don't know," a spurious link costs trust.

**Payload: an opaque pointer, a non-sensitive rationale, a timestamp.** Before authorization, the note may say only that a related source exists and that access is pending; it must not copy a conclusion such as "decided Y" into the label or rationale. After a source-to-target disclosure grant passes, the pointer may expose only the fields covered by that grant. If the receiving thread needs more, an authorized participant follows the source or requests disclosure through the ordinary channel — one extra round trip is cheaper than leaking a stale or private summary.

**Delivery: through the ordinary message path, tagged advisory.** The note arrives as an inbound message from an internal sender, wrapped and labeled as external, advisory data — the tier Anthropic's guidance and OWASP LLM01 describe — never in the system prompt and never as user text. Its enforced authority is narrow: it may inform the response or be mentioned, but it cannot alter goals, grant permission, or trigger a tool call or other side effect. Any action requires a separate instruction from an authorized participant in the current thread or the source thread and must pass the ordinary approval boundary. The note is self-contained only for "mention or ignore"; self-contained does not mean self-authorizing.

**Receiving thread: mention or say nothing.** Claude Tag's restraint model applies, and silence must be a real option. The thread may ask an authorized participant whether to follow up, but the nudge itself never supplies action authority. A thread that ignores repeated nudges triggers backoff for that (source, target) pair; a thread never re-broadcasts a nudge as a fact of its own.

**Scope: recipient-set disclosure authorization, isolation by default.** Define a grant as an authorization, issued by a participant allowed to disclose the source information, to disclose specified fields from one source thread into one target thread to the target's complete recipient set — every human, agent, and integration that can receive it. This is distinct from the consolidating agent's ability to read both threads. Re-evaluate the grant against the live recipient set at delivery time; membership or visibility changes invalidate a cached pass. Without a valid grant, neither the pointer label nor its rationale contains sensitive source payload. A DM-to-group disclosure therefore requires explicit source-to-target authorization covering every group recipient; where that cannot be established, keep the threads isolated.

**Audit and metrics.** Log every candidate and emitted link with source, target, disclosure-grant result, recipient-set version, score, and outcome (mentioned / follow-up requested / ignored / suppressed). Track link precision on a spot-checked sample, acceptance rate, suppression and backoff counts per thread (a proxy for nudge fatigue), and time-to-staleness — how often the source entry had changed by the time the note was read. Treat the memory-write path as a security boundary, per Bad Memory: the consolidation pass may write links; live threads may not write into each other's memory.

## Key Takeaways

- The consolidation pass is the only component with a cross-thread view; give it the job of *noticing* links, and only that job. A live thread may surface an authorized link, but action still requires a separate authorized instruction and the ordinary approval boundary.
- In the incidents sampled here, the damaging or "creepy" cases involved provenance, scope, or relevance that was not legible to the recipient. Current ChatGPT and Gemini controls reduce that gap but do not remove the need for explicit cross-thread disclosure authorization.
- A cross-thread note is untrusted content from another conversation. Tag it as advisory data in the tier Anthropic's guidance and OWASP LLM01 describe; the Bad Memory results show why persistent memory that can instruct is an attack surface.
- Silence is a first-class response. The one first-party anti-spam mechanism in the survey (Claude Tag's dormancy) is behavioral, not numeric; add explicit per-pair rate limits and backoff.
- Scope before cleverness: Claude Tag's admin gating, Copilot Memory's per-person stores and Meta's group-chat exclusion illustrate possible boundaries. The Slack AI retrieval flaw and Microsoft 365 Copilot DLP incident crossed different, product-specific enforcement boundaries; they do not validate those illustrative choices as the exact controls that failed.
- Read-time staleness is inherent to sync-time linking; Letta 0.7.0's sleep-time agent is one concrete example. Timestamps and pointers make it survivable; summaries do not.
- Two gaps in the field worth watching: no published system re-scores link relevance at read time, and nobody publishes the dormancy or rate-limit thresholds that make proactive surfacing tolerable.

## References

- [Anthropic: What is Claude Tag?](https://support.claude.com/en/articles/15594475-what-is-claude-tag)
- [Anthropic: Introducing Claude Tag](https://www.anthropic.com/news/introducing-claude-tag)
- [VentureBeat: Claude Tag in Slack](https://venturebeat.com/orchestration/anthropics-new-claude-tag-update-lets-its-slack-agent-read-the-full-conversation-and-jump-in-unprompted)
- [OpenAI: Memory FAQ](https://help.openai.com/en/articles/8590148)
- [OpenAI: Projects and project-only memory](https://help.openai.com/en/articles/10169521)
- [OpenAI: Memory and new controls (2025)](https://openai.com/index/memory-and-new-controls-for-chatgpt/)
- [Stephen Smith: ChatGPT memory law-firm case](https://www.smithstephen.com/p/he-turned-off-chatgpts-memory-it)
- [TechCrunch: ChatGPT's unprompted name use](https://techcrunch.com/2025/04/18/chatgpt-is-referring-to-users-by-their-names-unprompted-and-some-find-it-creepy)
- [Google: Daily Brief help](https://support.google.com/gemini/answer/17077455?hl=en)
- [Google: Personal Intelligence controls](https://support.google.com/gemini/answer/16598406?hl=en)
- [TechCrunch: Gemini Daily Brief critique](https://techcrunch.com/2026/08/26/googles-gemini-has-a-branding-problem-and-so-does-the-rest-of-ai/)
- [Microsoft: Introducing Copilot Memory](https://techcommunity.microsoft.com/blog/microsoft365copilotblog/introducing-copilot-memory-a-more-productive-and-personalized-ai-for-the-way-you/4432059)
- [Silicon Republic: Meta AI memory](https://www.siliconrepublic.com/machines/meta-ai-memory)
- [Letta: Sleep-time Compute](https://www.letta.com/blog/sleep-time-compute/)
- [Letta: Memory Omni-Tool](https://www.letta.com/blog/introducing-sonnet-4-5-and-the-memory-omni-tool-in-letta/)
- [Letta: Context Repositories](https://www.letta.com/blog/context-repositories/)
- [Letta: Next Phase](https://www.letta.com/blog/our-next-phase/)
- [Rasmussen et al.: Zep / Graphiti](https://arxiv.org/abs/2501.13956)
- [Xu et al.: A-MEM](https://arxiv.org/abs/2502.12110)
- [Gutiérrez et al.: HippoRAG](https://arxiv.org/abs/2405.14831)
- [Park et al.: Generative Agents](https://arxiv.org/abs/2304.03442)
- [Anthropic: Mitigate prompt injections](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks)
- [OWASP: LLM01 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)
- [Bad Memory paper](https://arxiv.org/abs/2607.14611)
- [The Register: Slack AI prompt injection](https://www.theregister.com/2024/08/21/slack_ai_prompt_injection/)
- [Metomic: Microsoft 365 Copilot risks](https://www.metomic.io/resource-centre/what-are-the-security-risks-of-microsoft-co-pilot/)
- [GitHub Marketplace: Related-issue detector](https://github.com/marketplace/actions/ai-powered-github-issue-duplicates-relations-detector)
- [Shape of AI: Nudges](https://www.shapeof.ai/patterns/nudges)

*Verification note: current ChatGPT, Gemini, and Letta control claims were checked against the first-party pages linked above. Historical incidents remain attributed to their dated reports; they are not treated as descriptions of current product behavior.*
