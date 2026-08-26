---
date: "2026-08-26"
title: "Awareness Boards: Fast-Path Coordination for Concurrent Sessions of a Single-Identity Agent"
description: "A design study of a small append-only shared board that lets concurrent chat-channel sessions of one always-on agent avoid contradicting each other between periodic memory consolidations."
tags: ["multi-agent-systems", "blackboard-architecture", "context-engineering", "shared-memory", "agent-coordination", "llm-agents", "system-design"]
---

## Executive Summary

An always-on agent serving many chat channels through one shared identity faces a coordination problem unlike classic multi-agent orchestration: it is not many minds that must agree, it is *one* mind running as several concurrent, context-isolated processes (one LLM session per channel) that must not contradict itself. Periodic memory consolidation handles the slow path, but runs on the order of hours — while a user in Channel A can ask "did you tell Howard we'd ship Friday?" thirty seconds after Channel B promised exactly that. That gap is the fast-path problem.

This article traces the proposed solution — a small, append-only "awareness board" — to blackboard architectures (Hearsay-II, BB1), Linda tuple spaces, and stigmergic coordination, then surveys how contemporary agent frameworks (LangGraph, CrewAI, AutoGen/AG2, OpenAI Agents SDK, MetaGPT, Letta/MemGPT) implement shared state today. None solve this exact problem — they coordinate *different* agents, not replicas of one identity — but each contributes a reusable mechanism: append-only writes, block-scoped visibility, cursor-based reads, and read-only vs. owner-writable regions.

The core tension is read timing: reading the board every turn maximizes freshness but taxes every response with tokens that are mostly irrelevant. "Lost in the Middle," Chroma's "Context Rot," and needle-in-haystack distractor studies all show LLM accuracy degrading as irrelevant content is injected, independent of raw context-window size. The recommended design reads at turn start via a per-thread cursor, filtered by relevance tags, with an urgent side channel for anything that cannot wait for the next turn boundary. A concrete file format, protocol, TTL/archival policy, and failure-mode analysis follow, sized for a single-machine deployment of about four concurrent sessions, closing with open questions (embedding-based filtering, contradiction detection, multi-machine extension).

Fact vs. inference: Sections 1–2 report what published systems and papers say, with citations. Sections 3–5 are this article's synthesis, not documented industry consensus — no cited source describes an "awareness board" for concurrent replicas of one identity. The closest real-world analog is an open, unresolved GitHub feature request against OpenAI's Codex CLI (cited below).

## 1. Lineage

### 1.1 Blackboard architectures — the direct ancestor

**Hearsay-II** (Carnegie Mellon, 1971–1976) was the first blackboard system, built for connected-speech understanding: independent "knowledge sources" — parallel processes activated asynchronously by data events — read and write hypotheses on a shared global data structure, the blackboard, instead of communicating point-to-point [1][2]. The transferable idea: knowledge sources need not know of each other, only of a shared structured surface, plus a "focus of attention" mechanism, since scanning the whole blackboard was already recognized as expensive [3].

**BB1** (Barbara Hayes-Roth, Stanford, 1983) added a *second*, control-specific blackboard layered on the domain blackboard — a place to post strategic decisions ("what to do next, why") separately from domain hypotheses [4][5]. This is the direct precedent for separating an awareness board's *content* (commitments/decisions/incidents) from a *control channel* (urgent signaling): mixing control into the main stream forces every consumer to filter it out on every read.

### 1.2 Tuple spaces — decoupled, associative, append-based

**Linda** (David Gelernter, Yale, 1985–86) generalized shared-memory coordination into "generative communication": processes write (`out`), read (`rd`), and destructively read (`in`) tuples in a shared tuple space, addressed by content rather than location [6]. Its key contribution here is *decoupling* — producers and consumers need not run at the same time or know of each other — exactly the relationship between a session in Channel A that posts a commitment and one in Channel B that reads it minutes later.

### 1.3 Stigmergy — coordination through traces, not messages

Stigmergy (Grassé, 1959) — coordination through persistent traces in a shared environment rather than direct signaling — has been explicitly proposed as a lens for LLM multi-agent systems: agents write to a shared artifact and others react to the trace [7][8]. A 2026 formalization applied to blockchain agents, "Ledger-State Stigmergy," identifies three reusable primitives — State-Flag, Event-Signal, Threshold-Trigger — that map onto the board's entry classes: a *decision* is a state flag, an *incident* is an event signal, and an urgent push is a threshold trigger [9].

### 1.4 What modern agent frameworks actually ship

| Framework | Shared-state mechanism | Read / write model | Gap vs. this problem |
|---|---|---|---|
| **LangGraph** | `Store` — persistent cross-thread key-value namespace, separate from the per-thread checkpointer | Tool call or preload at node entry; explicit `put` | No built-in relevance filtering, TTL, or urgency — "you wire entity extraction, recall, and contradiction handling yourself" [10][11] |
| **CrewAI** | Crew-level `Memory` shared by all agents | Auto-recalled into the prompt before each task; auto-extracted "facts" after | Recall/extraction go through an LLM call each time, adding cost; no entry-class or urgency model [12] |
| **AutoGen/AG2** | `GroupChat` shared history + `ContextVariables` | All agents see the full transcript; any agent can update variables | Built for *different* agents debating in one thread, not isolated sessions; no TTL [13][14] |
| **OpenAI Agents SDK** | `Session` memory + `handoffs` | Appended to memory on turn resumption; handoff transfers control | Moves a *single* thread of control — no board for concurrently live sessions [15][16] |
| **MetaGPT** | Shared message pool, publish/subscribe by role | Each role subscribes only to messages matching its profile | Fixed pipeline of specialized roles, not identical replicas of one identity; no TTL [17][18] |
| **Letta / MemGPT** | Shared memory *blocks* attached to multiple agents; `memory_insert` (append, safe) vs. `memory_rethink` (rewrite, last-writer-wins) | Block content sits in every attached agent's context at all times | No cursor/delta read — freshness is perfect but token cost is paid every turn regardless of relevance [19][20] |
| **Claude Code / Codex CLI** | No first-class mechanism; users emulate with `board.md`/`decisions.md` files; Claude Code's experimental Agent Teams use file-locking for task claims | Ad hoc, instructed via `CLAUDE.md`/`AGENTS.md` | Closest real antecedent — and explicitly unsolved (below) [21][22][23] |

The most relevant primary source found is **GitHub issue openai/codex#21027**, "Shared workspace/message bus for Codex subagents," requesting an append-only, namespaced, per-agent-writable log of "board updates, agent status events, findings, handoff notes, and accepted decisions" to stop subagents from duplicating work or reaching contradictory conclusions — the same failure mode targeted here, and still open and unimplemented at research time [21]. That is evidence the problem is recognized industry-wide but not yet standardized.

Two facts distinguish "one identity, many concurrent sessions" from everything above: there is no orchestrator dividing labor — sessions are triggered independently by unrelated external users; and contradiction reads worse than in a multi-agent debate, because to an outside observer it isn't "two agents disagreeing," it's "you said X five minutes ago and not-X now."

## 2. Read-Timing Tradeoffs

| Model | Freshness | Token cost | Failure mode |
|---|---|---|---|
| **Read at turn start (cursor delta)** | As of turn start; misses mid-turn posts | Low — only new entries since last cursor | Long turn can act on stale state if another session posts mid-turn |
| **Read every turn (full re-scan)** | Always current | High, largely redundant | Re-reads unchanged entries; adds distractor load |
| **Tool-on-demand** | Perfect at call time, but model must decide to call | Lowest average, unreliable | Silent misses if the model doesn't think to check |
| **Event push (urgent channel)** | Immediate, independent of turn boundaries | Very low (rare messages) | Only viable for a small minority of entries |

The intuition that "extra injected context can only help, since the model can ignore what's irrelevant" is contradicted by several independent findings:

- **Lost in the Middle** (Liu et al., TACL 2024): accuracy on retrieving relevant information from long contexts is highest when it sits at the start or end and degrades when buried in the middle, even for long-context-tuned models [24][25]. A board entry buried mid-prompt is read less reliably than one placed at the start or just before the user turn.
- **Chroma's "Context Rot"** (Hong, Troynikov, Huber, 2025) tested 18 frontier models on needle-in-haystack variants and found performance degrades unevenly as input grows, driven by the presence and structure of surrounding distractor content, not token count alone [26][27].
- **"Hidden in the Haystack"** (2025–2026): degradation is driven mainly by the volume of irrelevant surrounding content rather than needle difficulty, with distractors having non-uniform impact depending on semantic proximity to the query [28][29].

None of these papers study coordination boards specifically, but together they are reasonably strong indirect evidence that full re-scan on every turn is counterproductive past a small board size. Anthropic's applied context-engineering guidance reaches the same conclusion from production experience: treat context as "the smallest possible set of high-signal tokens," prefer just-in-time retrieval over always-preloaded content, and use structured persisted notes rather than holding everything live in the window [30]. This favors **cursor-based read-at-turn-start** over full re-scan, and tag-filtering before injection over dumping the whole board.

**Recommendation:** cursor-and-tag read at turn start as the default (bounded, cheap, fresh as of turn boundary); a narrow urgent side channel (BB1's control-blackboard pattern) for entries that cannot wait, such as an incident that changes what's safe to say right now; tool-on-demand as a supplementary escape hatch before making an external commitment, not the primary mechanism, since relying on the model to "remember" to check is a known silent-failure mode.

## 3. Entry Design

### 3.1 Board vs. consolidated memory

| | Awareness board | Consolidated memory |
|---|---|---|
| Purpose | Prevent contradiction right now | Durable, searchable long-term understanding |
| Lifetime | Hours (TTL, default 24h) | Indefinite |
| Granularity | Raw, immediate — "told Howard ship date is Friday" | Synthesized — "team ships weekly, usually Friday" |
| Write trigger | Every commitment/decision/incident | Periodic batch pass over transcripts |
| Read trigger | Every turn start (cursor delta) | On demand / session bootstrap |
| Cost if missed | Contradiction, broken trust | Slower learning, recoverable |

The dividing line is temporal urgency, not importance: a board entry's job is to survive long enough for consolidation to absorb it, then die. This defines the three entry classes:

- **Commitment** — a promise to a specific person/channel ("I'll send the report by Friday"); must be visible to any session that might independently make a conflicting one.
- **Decision** — a choice constraining future behavior with no single addressee ("primary proxy node is 新加坡02 now").
- **Incident** — something went wrong or anomalous ("both proxy nodes 01 and 03 are down"); time-critical, often warrants the urgent path.

### 3.2 Tags and relevance filtering

- **person** — filters to sessions concerning a specific individual
- **project** — filters to sessions on the same named effort
- **channel** — mostly a provenance field, rarely useful alone
- **global** — always injected; reserved for identity-level facts ("owner changed," "runtime switched")

A turn-start read defaults to `global` entries plus any matching the current conversation's person/project. This is a cheap heuristic, not semantic search — MetaGPT's subscribe-by-role is the closest documented precedent for filtering broadcasts by consumer relevance rather than broadcasting everything [17]. Embedding-based filtering is deferred to open questions: it trades determinism and auditability for marginal recall gain, and determinism matters more on a small, human-auditable board.

### 3.3 TTL, expiry, and archival

Default TTL: 24 hours, matching the assumed consolidation cadence. On expiry: if never read by another session and already absorbed into a consolidation pass, delete outright; if actively read (it did its coordination job), archive to a flat log for post-hoc audit rather than deleting — cheap, and useful for auditing the identity's own contradiction rate over time.

### 3.4 Ordering and idempotency without distributed-systems overhead

This is explicitly a **single-machine, single-writer-at-a-time** system: each session is a separate process, but all append to one local file/DB on one host. No vector clocks are needed — one physical clock and one filesystem give a real total order for free, unlike Lamport's construction, built specifically to order events *without* a shared clock across independent nodes [31][32]. Requirements: **append-only** writes, matching Linda's `out`/`rd` model and Letta's guidance that insert-style appends are concurrency-safe while full rewrites are not [6][19][20]; a **monotonic sequence number** assigned at write time, which is the cursor a session's delta-read advances past; and a **single-writer-at-a-time** guarantee via a plain file lock or DB transaction — sufficient for one machine, no consensus protocol required.

## 4. Failure Modes and Mitigations

| Failure mode | Mechanism | Mitigation |
|---|---|---|
| **Contradicting commitments** | Session A commits to X before B's commitment to not-X lands, or B never reads the board | Write the commitment to the board *before* delivering it to the user; treat "check board for existing commitments on this topic" as mandatory, not optional |
| **Stale entries acted on** | Plan changes but TTL hasn't expired and no update posted | Require a superseding entry to reference the old one (`supersedes: <seq>`), killing it immediately rather than waiting for TTL |
| **Board bloat** | High traffic outpaces what a few sessions can usefully read | Tag-filtering bounds what any session reads regardless of board size; hard cap per tag with oldest-first eviction |
| **Urgent-storm** | Any session can mark anything urgent, at no cost | Reserve urgent-push for `incident` only; rate-limit and degrade excess to the normal path — BB1's separate control blackboard only works if it stays small [4][5] |
| **False confidence from partial reads** | A tag-filtered subset is mistaken for the whole picture | Board entries are additive hints, never the sole check before an irreversible action — that's what explicit confirmation gates are for |
| **Silent tool-on-demand misses** | A session that could check, but doesn't think to | Never make tool-on-demand the only path for anything commitment-critical; pair with the mandatory cursor read |

## 5. Recommended Design

### 5.1 File format sketch

Flat, append-only, line-delimited JSON (equivalently a single-table SQLite DB — JSONL shown for auditability and zero dependencies):

```jsonl
{"seq": 1042, "ts": "2026-08-26T14:03:11Z", "class": "commitment",
 "actor_session": "telegram-howard", "tags": {"person": "howard", "project": "release-v3"},
 "text": "Told Howard the v3 release ships Friday 2026-08-28.",
 "supersedes": null, "urgent": false, "ttl_hours": 24}

{"seq": 1043, "ts": "2026-08-26T14:07:52Z", "class": "incident",
 "actor_session": "lark-ops-channel", "tags": {"global": true},
 "text": "Proxy node 新加坡01 unreachable; failed over to 新加坡02.",
 "supersedes": null, "urgent": true, "ttl_hours": 24}

{"seq": 1044, "ts": "2026-08-26T15:30:00Z", "class": "decision",
 "actor_session": "web-console", "tags": {"project": "release-v3"},
 "text": "v3 release date moved to Monday 2026-08-31 per Howard's request.",
 "supersedes": 1042, "urgent": false, "ttl_hours": 24}
```

Per-session cursor state tracks only the last `seq` consumed:

```json
{"session": "telegram-howard", "last_seq_read": 1042}
```

### 5.2 Read/write protocol (pseudocode)

```
# WRITE — called whenever a session makes a commitment/decision or
# records an incident, before finishing the turn
function post_entry(class, text, tags, urgent=False, supersedes=None):
    with file_lock(board_path):
        seq = next_seq(board_path)          # monotonic, single-writer-at-a-time
        entry = { seq, now(), class, current_session_id(),
                  tags, text, supersedes, urgent, ttl_hours=24 }
        append_line(board_path, json(entry))
    if urgent:
        push_control_channel(entry)          # bypasses turn boundary entirely

# READ — called once at the start of every turn, before generation
function read_relevant_deltas(session_id, conversation_context):
    cursor = load_cursor(session_id)
    new_entries = read_entries_after(board_path, cursor.last_seq_read)
    relevant = [ e for e in new_entries if
                 e.tags.get("global")
                 or e.tags.get("person") in conversation_context.people
                 or e.tags.get("project") in conversation_context.projects ]
    save_cursor(session_id, max(e.seq for e in new_entries) if new_entries else cursor.last_seq_read)
    return relevant   # inject near the top of context or just before the
                       # user message — never buried mid-prompt

# CONTROL CHANNEL — urgent path, independent of turn boundaries
function push_control_channel(entry):
    if rate_limited(class="incident", window="1h", max=5):
        return  # degrade to normal read path rather than storming
    notify_all_active_sessions(entry)

# ARCHIVAL — runs alongside/just before periodic memory consolidation
function archive_expired():
    for e in board_path where age(e) > e.ttl_hours:
        if e.was_read_by_another_session:
            move_to_archive_log(e)
        else:
            delete(e)
```

### 5.3 Defaults for a ~4-session single-machine deployment

- TTL: 24h, aligned with consolidation cadence.
- Read timing: mandatory cursor delta at turn start; urgent push for `incident` only; tool-on-demand as a supplement.
- Injection placement: top of context or immediately adjacent to the user turn — per Lost-in-the-Middle, position matters as much as presence [24].
- Urgent rate limit: ~5/hour system-wide; beyond that, degrade to the normal path.
- Storage: single JSONL file with a file lock, or one SQLite table — no distributed consensus needed at this scale [6][31][32].
- Board size ceiling: soft cap ~200 live entries, oldest non-referenced evicted first.

### 5.4 Open questions

1. **Contradiction detection isn't free.** This design makes commitments visible but doesn't automatically block a session from violating one. Whether to add a mandatory "check before commit" gate is a policy decision this article leaves open.
2. **Tag filtering is coarse.** It will over-inject (shared tag, unrelated sub-topic) and under-inject (relevant, no shared tag). Whether embedding-based semantic filtering is worth the added latency and lost auditability at this small scale is unmeasured.
3. **Multi-machine extension.** The design leans entirely on one physical machine giving total order for free. Sessions spread across hosts would need Lamport clocks or a real partitioned event log [31][33].
4. **Board-vs-consolidation boundary drift.** The 24h TTL assumes a matching consolidation cadence; a slower cadence makes stale-but-unexpired entries more likely and would require revisiting the boundary in Section 3.1.

## References

1. [The Hearsay-II Speech-Understanding System: Integrating Knowledge to Resolve Uncertainty (PDF)](https://websites.nku.edu/~foxr/CSC425/hearsay2.pdf) — Erman, Hayes-Roth, Lesser, Reddy
2. [Organization of the Hearsay II speech understanding system — IEEE Xplore](https://ieeexplore.ieee.org/document/1162648/)
3. [Focus of attention in the HEARSAY II speech understanding system (ResearchGate)](https://www.researchgate.net/publication/220814833_Focus_of_attention_in_the_HEARSAY_II_speech_understanding_system)
4. [The BB1 Blackboard Control Architecture — Stanford KSL project page](http://www-ksl.stanford.edu/projects/BB1/bb1.html)
5. [BB1: an architecture for blackboard systems that control, explain, and learn about their own behavior — ACM Digital Library](https://dl.acm.org/doi/abs/10.5555/892336) — Barbara Hayes-Roth, 1983
6. [Linda (coordination language) — Wikipedia](https://en.wikipedia.org/wiki/Linda_(coordination_language)) — David Gelernter, Yale, 1985–86
7. [Coordination as an Architectural Layer for LLM-Based Multi-Agent Systems (arXiv 2605.03310)](https://arxiv.org/abs/2605.03310), 2026
8. [Emergent Collective Memory in Decentralized Multi-Agent AI Systems (arXiv 2512.10166)](https://arxiv.org/pdf/2512.10166), 2025
9. [Ledger-State Stigmergy: A Formal Framework for Indirect Coordination Grounded in Distributed Ledger State (arXiv 2604.03997)](https://arxiv.org/pdf/2604.03997), 2026
10. [Persistence — LangGraph docs (LangChain)](https://docs.langchain.com/oss/python/langgraph/persistence)
11. [Persistent Agent Memory in LangGraph: Cross-Thread State and Memory Stores — Focused](https://focused.io/lab/persistent-agent-memory-in-langgraph)
12. [Memory — CrewAI documentation](https://docs.crewai.com/v1.15.17/en/concepts/memory)
13. [Group Chat — AG2 documentation](https://docs.ag2.ai/latest/docs/user-guide/advanced-concepts/orchestration/group-chat/introduction/)
14. [GroupChatManager — AG2 API reference](https://docs.ag2.ai/latest/docs/api-reference/autogen/GroupChatManager/)
15. [Handoffs — OpenAI Agents SDK](https://openai.github.io/openai-agents-python/handoffs/)
16. [Sessions — OpenAI Agents SDK (JS)](https://openai.github.io/openai-agents-js/guides/sessions/)
17. [MetaGPT: Meta Programming for a Multi-Agent Collaborative Framework (arXiv 2308.00352, ICLR 2024)](https://arxiv.org/abs/2308.00352)
18. [What is MetaGPT? — IBM](https://www.ibm.com/think/topics/metagpt)
19. [Shared memory blocks — Letta Docs](https://docs.letta.com/tutorials/shared-memory-blocks/)
20. [Shared memory — Letta Docs (multi-agent guide)](https://docs.letta.com/guides/agents/multi-agent-shared-memory)
21. [Shared workspace/message bus for Codex subagents — openai/codex issue #21027](https://github.com/openai/codex/issues/21027)
22. [Orchestrate teams of Claude Code sessions — Claude Code Docs](https://code.claude.com/docs/en/agent-teams)
23. [Coordinate Multiple Claude Code Sessions on a Shared Repo — DEV Community](https://dev.to/sahil_kat/coordinate-multiple-claude-code-sessions-on-a-shared-repo-1dh4)
24. [Lost in the Middle: How Language Models Use Long Contexts — ACL Anthology / TACL 2024](https://aclanthology.org/2024.tacl-1.9/) — Liu, Lin, Hewitt, Paranjape, Bevilacqua, Petroni, Liang
25. [Lost in the Middle (arXiv 2307.03172)](https://arxiv.org/abs/2307.03172)
26. [Context Rot: How Increasing Input Tokens Impacts LLM Performance — Chroma Research](https://www.trychroma.com/research/context-rot), July 2025 — Hong, Troynikov, Huber
27. [Context Rot GitHub repository](https://github.com/chroma-core/context-rot)
28. [Hidden in the Haystack: Smaller Needles are More Difficult for LLMs to Find (arXiv 2505.18148)](https://arxiv.org/abs/2505.18148), 2025–2026
29. [Lost in the Haystack: Smaller Needles are More Difficult for LLMs to Find — PMC](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12478432/)
30. [Effective context engineering for AI agents — Anthropic Engineering Blog](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
31. [Lamport's Logical Clocks — explainer](https://mwhittaker.github.io/blog/lamports_logical_clocks/)
32. [Dotted Version Vectors: Logical Clocks for Optimistic Replication (arXiv 1011.5808)](https://arxiv.org/pdf/1011.5808)
33. [Event Sourcing Patterns with Kafka — Conduktor glossary](https://www.conduktor.io/glossary/event-sourcing-patterns-with-kafka)
34. [How we built our multi-agent research system — Anthropic Engineering Blog](https://www.anthropic.com/engineering/multi-agent-research-system), June 2025
