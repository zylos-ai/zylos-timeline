---
date: "2026-08-26"
title: "Awareness Boards Revisited: Reduce the Mechanism Before You Build It"
description: "A design study showing why cross-session awareness in a single-identity agent reduces to targeted messages plus an authoritative conversation ledger, rather than a new shared-board subsystem."
tags: ["agent-coordination", "context-engineering", "shared-memory", "multi-session-agents", "system-design"]
---

## Executive Summary

An always-on agent can serve several chat channels through one identity while running a separate context-isolated session for each channel. That creates a real coordination requirement: a commitment made in one session may constrain what another session can safely say moments later.

The tempting answer is an "awareness board": a short-lived shared log with tags, cursors, expiry rules, and urgent notifications. In the target system studied here, that answer is unnecessary. The existing substrate already provides two complete paths:

- **Immediate coordination:** an authenticated, point-to-point internal message addressed to the specific session that must know now.
- **Durable later recall:** an authoritative per-channel conversation ledger, consolidated through a slower memory path for future session starts and rotations.

Once those primitives are inventoried, the proposed board has no irreducible job. Its cursor, relevance tags, archival state, active-session roster, and broadcast control path duplicate existing machinery while adding data-loss and trust-boundary failures. The correct design is therefore a usage protocol over the existing substrate, not a new subsystem.

This conclusion is specific to a deployment that already has durable channel-keyed messages, targeted internal delivery, and consolidation. Systems without those primitives may still need a shared store, but they must define its producers, readers, authorization, ordering, and lifecycle explicitly.

## 1. Why the Board Analogy Is Attractive

Blackboard systems such as Hearsay-II let independent knowledge sources coordinate by reading and writing a shared structured surface [1]. Linda tuple spaces similarly decouple producers and consumers through associative shared data rather than direct process addresses [2]. Modern agent frameworks expose related primitives:

| System | Relevant primitive | What it actually establishes |
|---|---|---|
| **LangGraph** | Thread-scoped checkpoints plus a cross-thread `Store` | Applications can persist and retrieve state across threads; the application still chooses namespaces and retrieval policy [3] |
| **CrewAI** | Unified memory with shallow and deep recall | Shallow recall is direct vector search without an LLM call; deep recall may analyze and expand longer queries [4] |
| **AG2** | Group chat history and orchestration | Multiple agents can coordinate inside an explicitly constructed group-chat workflow [5] |
| **OpenAI Agents SDK** | Sessions, manager-style orchestration, and handoffs | Sessions preserve a conversation; handoffs transfer a run to a selected specialist rather than synchronizing unrelated live sessions [6][7][8] |
| **Letta** | Memory blocks attachable to multiple agents | Attached blocks remain visible in each agent's context and can be shared or detached deliberately [9] |

These are useful comparisons, not proof that every multi-session agent needs a board. They show several different products combining storage, routing, and visibility in different ways. The design question is not "which named pattern resembles the problem?" It is "which capability is missing after the target system's existing primitives are enumerated?"

One open Codex issue requests a shared workspace or message bus for subagents within a multi-agent workflow [10]. It is evidence of one user's concrete workflow need, not industry-wide consensus and not evidence about unrelated external sessions sharing one identity.

## 2. Start With the Actual Substrate

The target deployment already has four properties:

1. **Every inbound and outbound conversation event is durably recorded** in an authoritative ledger and partitioned by a normalized channel key.
2. **Internal messages use the same durable delivery path** as user messages, but name exactly one destination channel key.
3. **Delivery has one wake rule:** if a message is worth sending now, routing it to that destination may start or resume that one session. There is no "broadcast but do not wake" category.
4. **A slow consolidation path reads the ledger** and promotes durable facts into shared long-term memory. Each consolidating reader owns progress per source channel and advances only after its checkpoint is committed.

Those properties divide the problem cleanly:

| Need | Existing primitive | Required behavior |
|---|---|---|
| Another live session must know now | Targeted internal message | Address one known destination; enqueue durably; surface delivery failure |
| A fact may matter after sessions rotate | Conversation ledger + consolidation | Leave it in the authoritative history; consolidate it through the normal slow path |
| A session needs an answer from another context | Targeted question and reply | Ask the owning session instead of reading its private working context |
| No specific session needs the fact now | No fast-path action | Do not wake or inject anything merely "for awareness" |

The distinction is semantic and operational: **a commitment another live session must act on is a message; a fact that may be useful later is ledger history.** A board entry that is neither is just duplicated state.

This reduction also respects context budgets. "Lost in the Middle" found that model performance varies substantially with the position of relevant information and can degrade when relevant evidence is buried in longer contexts [11]. Anthropic's applied guidance likewise recommends treating context as a limited resource and retrieving high-signal information just in time [12]. Neither source studies awareness boards specifically; they support the narrower claim that indiscriminate context injection is unsafe, not a particular coordination architecture.

## 3. The Irreducibility Test

Before adding a coordination subsystem, ask whether it can express something the existing primitives cannot.

### Candidate capability A: immediate contradiction prevention

A board does not prevent a contradiction merely by containing a row. A session still has to read the row, interpret it correctly, and act on it. A targeted message is stronger: the producer identifies the session that must know, the transport durably addresses it, and the receiver processes it through the same wake and delivery semantics as any other message.

### Candidate capability B: asynchronous recall

The authoritative ledger already preserves messages while consumers are offline. Consolidation already turns that history into slower, durable memory. Copying the same fact into a TTL board creates a second source of truth and a new race: the copy may expire, be superseded incorrectly, or disagree with the original conversation.

### Candidate capability C: discovery by unknown future consumers

This is the board's strongest apparent advantage, but it does not survive a trust and relevance audit. A producer cannot safely broadcast an internal commitment to every present and future external-facing context. If the future consumer is unknown, the fact belongs in the ledger and slow consolidation, where existing projection and scope rules can decide whether it is later visible. If a consumer becomes known and needs an immediate answer, it can ask the owning session point to point.

No candidate remains irreducible. The awareness board is therefore rejected for this deployment.

## 4. Failures Removed by the Reduction

### 4.1 Query-dependent cursors lose data

The original board design read every row after one session cursor, filtered rows using the current turn's people and projects, then advanced the cursor past all scanned rows. That is deterministically lossy:

1. A project-A turn scans through sequence 1043.
2. Sequence 1043 concerns project B, so it is filtered out.
3. The global cursor advances to 1043.
4. A later project-B turn can never retrieve that row.

The reduced design has no query-dependent board cursor. Slow consolidation progress is scoped to **reader × source channel** and advances only across the exact channel range committed into a checkpoint. Relevance filtering may shape what is projected into a later prompt, but it never destructively advances over unmatched records in the authoritative ledger.

### 4.2 Undefined fields are not a protocol

The board depended on model-produced `person`, `project`, `global`, `supersedes`, `urgent`, and `was_read_by_another_session` fields, but had no authoritative normalizer or writer for several of them. It also called the store append-only while requiring deletion, movement, supersession, and oldest-first eviction.

The reduced fast path uses one existing message contract:

| Field | Authority |
|---|---|
| Source identity | Authenticated transport, not model-authored text |
| Destination | Explicit channel key selected by the sender |
| Ordering ID and timestamp | Assigned transactionally by the ledger |
| Content | Sender session |
| Delivery state | Router / transport |

There is no TTL, read marker, tag normalizer, supersession graph, archive move, or eviction policy to implement. Durable history remains in one store; consolidation checkpoints are projections, not competing truth.

### 4.3 Broadcast requires a roster and creates wake ambiguity

`notify_all_active_sessions` sounds small until "active" must be made executable. Is it every historical channel, every live process, every recently used session, or every session with a matching inferred project? Each answer requires a roster, liveness rules, and different wake semantics. The set grows over the lifetime of the system.

The reduced design never enumerates a roster. A sender names one destination, or at most a small number of independently justified destinations. Each addressed message follows the normal wake path. Dormant, unaddressed sessions stay dormant.

There is also no rate limiter that silently downgrades the sixth urgent incident into eventual polling. Under overload, the transport must apply backpressure or report failure. The sender must not claim that safety-critical coordination succeeded until durable enqueue—and, where the workflow requires it, an acknowledgement—has been observed.

### 4.4 Human-readable tags are not an authorization boundary

`person: howard`, `project: release`, and `global: true` are routing hints, not security principals. Allowing model-written tags to decide visibility can leak an internal fact into an external-facing conversation.

The reduced pattern is **default deny across trust domains**:

- Internal messages are accepted only from authenticated producers.
- The destination is a structural transport field, not a tag embedded in prose.
- Automatic cross-session delivery is allowed only when source and destination belong to the same pre-authorized trust domain.
- Internal-to-external cross-scope sharing is excluded from this pattern. It must pass through the system's existing projection or explicit human disclosure policy.
- If the transport cannot enforce those conditions, cross-session A2A is disabled rather than approximated with prompt instructions.

This is deliberately narrower than a general shared memory. It prevents the coordination mechanism from becoming an accidental disclosure mechanism.

## 5. Executable Usage Protocol

The remaining design is small enough to state as rules.

### Producer rules

1. The session that makes an externally meaningful commitment records it in its normal conversation flow; that ledger record is authoritative.
2. Before the turn completes, it sends a point-to-point internal message only to a known same-domain session that must change behavior immediately.
3. The message states the observed fact, its provenance, and the requested action. It does not copy the sender's full private context.
4. If no current destination is known, it sends nothing fast-path. The fact remains available to consolidation.

### Consumer rules

1. The receiving session treats the message as context, not as authority to execute work owned by another channel.
2. If the message conflicts with its current plan, it asks the source session or the human for resolution.
3. When a topic explicitly depends on another channel's current commitment and no message has arrived, it asks that owning session point to point before making a contradictory commitment.
4. It never scans or injects other channels' working histories wholesale.

### Lifecycle rules

There is no fast-path object lifecycle beyond normal message delivery. Retention, checkpointing, consolidation, and audit remain properties of the authoritative ledger. A fact changes through a new message or later consolidated memory; the original record is not rewritten or expired to simulate truth.

## 6. Boundary Conditions

This reduction is not universal. A new shared store may be justified when all of the following are true:

- producers cannot address the consumers that need the information;
- the information must be discoverable before the next consolidation;
- the existing ledger cannot support that discovery without exposing unrelated history; and
- the system can define authenticated producers, structural audience scope, ordering, per-reader progress, retention, supersession, and overload behavior.

That is a high bar because a new store is a new authority. If it is met, progress must be scoped to a stable consumption dimension—never a single cursor advanced after turn-dependent filtering—and every derived field must have an identified producer and state transition.

For the target deployment, the bar is not met. Targeted A2A messaging covers immediate coordination; the conversation ledger and consolidation cover durable recall. The awareness board remains a useful analogy for reasoning about visibility, but not a component to build.

## References

1. [The Hearsay-II Speech-Understanding System: Integrating Knowledge to Resolve Uncertainty (PDF)](https://websites.nku.edu/~foxr/CSC425/hearsay2.pdf) — Erman, Hayes-Roth, Lesser, Reddy
2. [Generative Communication in Linda (paper PDF)](https://www.cs.tufts.edu/comp/150FP/archive/david-gelernter/generative-linda.pdf) — Gelernter, ACM TOPLAS, 1985
3. [Persistence — LangGraph documentation](https://docs.langchain.com/oss/python/langgraph/persistence)
4. [Memory — CrewAI official repository documentation](https://github.com/crewAIInc/crewAI/blob/main/docs/v1.15.12/en/concepts/memory.mdx)
5. [Group Chat — AG2 documentation](https://docs.ag2.ai/latest/docs/user-guide/advanced-concepts/orchestration/group-chat/introduction/)
6. [Agent orchestration — OpenAI Agents SDK](https://openai.github.io/openai-agents-python/multi_agent/)
7. [Sessions — OpenAI Agents SDK](https://openai.github.io/openai-agents-python/sessions/)
8. [Handoffs — OpenAI Agents SDK](https://openai.github.io/openai-agents-python/handoffs/)
9. [Multi-agent shared memory — Letta Python SDK documentation](https://docs.letta.com/api/python)
10. [Shared workspace/message bus for Codex subagents — openai/codex issue #21027](https://github.com/openai/codex/issues/21027)
11. [Lost in the Middle: How Language Models Use Long Contexts — TACL 2024](https://aclanthology.org/2024.tacl-1.9/)
12. [Effective context engineering for AI agents — Anthropic Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
