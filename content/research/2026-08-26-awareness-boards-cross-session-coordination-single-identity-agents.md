---
date: "2026-08-26"
title: "Awareness Boards Revisited: Reduce the Mechanism Before You Build It"
description: "A design study showing why cross-session awareness in a single-identity agent reduces to targeted messages plus an authoritative conversation ledger, rather than a new shared-board subsystem."
tags: ["agent-coordination", "context-engineering", "shared-memory", "multi-session-agents", "system-design"]
---

## Executive Summary

An always-on agent can serve several chat channels through one identity while running a separate context-isolated session for each channel. That creates a real coordination requirement: a commitment made in one session may constrain what another session can safely say moments later.

The tempting answer is an "awareness board": a short-lived shared log with tags, cursors, expiry rules, and urgent notifications. In the target system studied here, that answer is unnecessary. The existing substrate already provides two complete paths:

- **Immediate coordination:** a point-to-point internal message addressed to the known destination `channel_key`; the Router alone resolves that stable key to the active, resumable, or newly started session.
- **Durable later recall:** an authoritative per-channel conversation ledger, consolidated through a slower memory path for future session starts and rotations.

Once those primitives are inventoried, the proposed board has no irreducible job. Its cursor, relevance tags, archival state, active-session roster, and broadcast control path duplicate existing machinery while adding data-loss and trust-boundary failures. The correct design is therefore a usage protocol over the existing substrate, not a new subsystem.

This conclusion is specific to a deployment that already has durable channel-keyed messages, targeted internal delivery, and consolidation, and whose governing design assumes one identity and one owner's memory across isolated attention threads. Systems without those primitives or assumptions may still need a shared store, but they must define its producers, readers, authorization, ordering, and lifecycle explicitly.

## 1. Why the Board Analogy Is Attractive

Blackboard systems such as Hearsay-II let independent knowledge sources coordinate by reading and writing a shared structured surface [1]. Linda tuple spaces similarly decouple producers and consumers through associative shared data rather than direct process addresses [2]. Modern agent frameworks expose related primitives:

| System | Relevant primitive | What it actually establishes |
|---|---|---|
| **LangGraph** | Thread-scoped checkpoints plus a cross-thread `Store` | Applications can persist and retrieve state across threads; the application still chooses namespaces and retrieval policy [3] |
| **CrewAI** | Unified memory with shallow and deep recall | Shallow recall is direct vector search without an LLM call; deep recall may analyze and expand longer queries [4] |
| **AG2** | Group chat history and orchestration | Multiple agents can coordinate inside an explicitly constructed group-chat workflow [5] |
| **OpenAI Agents SDK** | Sessions, manager-style orchestration, and handoffs | Sessions preserve a conversation; handoffs transfer a run to a selected specialist rather than synchronizing unrelated live sessions [6][7][8] |
| **Letta** | A shared-memory repository in the current model; attachable blocks in the legacy model | Current shared memory lets multiple agents access one repository. The legacy block API can place an attached block in multiple agents' context and exposes explicit attach/detach operations [9][10][11][12] |

These are useful comparisons, not proof that every multi-session agent needs a board. They show several different products combining storage, routing, and visibility in different ways. The design question is not "which named pattern resembles the problem?" It is "which capability is missing after the target system's existing primitives are enumerated?"

One open Codex issue requests a shared workspace or message bus for subagents within a multi-agent workflow [13]. It is evidence of one user's concrete workflow need, not industry-wide consensus and not evidence about unrelated external sessions sharing one identity.

## 2. Start With the Actual Substrate

The target deployment already has four properties:

1. **Inbound, internal, and outbound events accepted into the C4 delivery path are durably recorded** in an authoritative ledger and partitioned by a normalized `channel_key`. Non-mention group traffic is an explicit exception: it remains in component logs and does not enter C4 or channel memory.
2. **Internal messages use the same durable delivery path** as user messages, but name exactly one destination `channel_key`.
3. **The Router owns session resolution and wake behavior:** it maps the stable destination key to the active session, resumes prior context, or starts a new session as required. The sender never addresses a transient session identity.
4. **A slow consolidation path reads the ledger** and promotes durable facts into shared long-term memory. Channel Sync separately produces a checkpoint and coverage chain for its own channel. Origin and other readers each own an independent `sync_cursors(reader, channel_key, last_id)` position and advance it only after that reader's outputs commit; a dormant Channel Sync does not control another reader's progress.

Those properties divide the problem cleanly:

| Need | Existing primitive | Required behavior |
|---|---|---|
| Another channel must know now | Targeted internal message | Address its known `channel_key`; enqueue durably; let the Router resolve the runtime session |
| A fact may matter after sessions rotate | Conversation ledger + consolidation | Leave it in the authoritative history; consolidate it through the normal slow path |
| A channel needs an answer from another context | Targeted question and reply | Ask the owning channel instead of reading its full working context |
| No specific channel needs the fact now | No fast-path action | Do not wake or inject anything merely "for awareness" |

The distinction is semantic and operational: **a commitment another channel must act on now is a message; a fact that may be useful later is ledger history.** A board entry that is neither is just duplicated state.

This reduction also respects context budgets. "Lost in the Middle" found that model performance varies substantially with the position of relevant information and can degrade when relevant evidence is buried in longer contexts [14]. Anthropic's applied guidance likewise recommends treating context as a limited resource and retrieving high-signal information just in time [15]. Neither source studies awareness boards specifically; they support the narrower claim that indiscriminate context injection is unsafe, not a particular coordination architecture.

## 3. The Irreducibility Test

Before adding a coordination subsystem, ask whether it can express something the existing primitives cannot.

### Candidate capability A: immediate contradiction prevention

A board does not prevent a contradiction merely by containing a row. A session still has to read the row, interpret it correctly, and act on it. A targeted message is stronger: the producer names the stable destination `channel_key`, the transport durably records that address, and the Router alone resolves it to the session that should process it. Rotation does not invalidate the address.

### Candidate capability B: asynchronous recall

The authoritative ledger already preserves messages while consumers are offline. Consolidation already turns that history into slower, durable memory. Copying the same fact into a TTL board creates a second source of truth and a new race: the copy may expire, be superseded incorrectly, or disagree with the original conversation.

### Candidate capability C: discovery by unknown future consumers

This is the board's strongest apparent advantage. Under the target design's explicit same-owner, single-identity assumption, it still does not require a board: accepted C4 events remain in the channel-keyed ledger, and independent readers can consume them later through consolidation. The design does not promise pre-consolidation discovery by an unknown consumer. If a different system requires that property across identities or external audiences, it needs a separate security and discovery design rather than an unscoped board. Once a destination becomes known and needs an immediate answer, it can ask the owning channel point to point.

No candidate remains irreducible. The awareness board is therefore rejected for this deployment.

## 4. Failures Removed by the Reduction

### 4.1 Query-dependent cursors lose data

The original board design read every row after one session cursor, filtered rows using the current turn's people and projects, then advanced the cursor past all scanned rows. That is deterministically lossy:

1. A project-A turn scans through sequence 1043.
2. Sequence 1043 concerns project B, so it is filtered out.
3. The global cursor advances to 1043.
4. A later project-B turn can never retrieve that row.

The reduced design has no query-dependent board cursor. Slow-consolidation progress is scoped to **reader × source channel** in `sync_cursors`, and each reader advances only after its own derived outputs commit. This is independent of the Channel Sync checkpoint/coverage chain, which is an artifact produced by that channel's Sync process rather than a gate on other readers. Relevance filtering may shape later retrieval, but it never destructively advances another reader over unmatched records in the authoritative ledger.

### 4.2 Undefined fields are not a protocol

The board depended on model-produced `person`, `project`, `global`, `supersedes`, `urgent`, and `was_read_by_another_session` fields, but had no authoritative normalizer or writer for several of them. It also called the store append-only while requiring deletion, movement, supersession, and oldest-first eviction.

The reduced fast path uses one existing message contract:

| Field | Authority |
|---|---|
| Source channel metadata | Existing delivery record; not an authorization boundary |
| Destination | Explicit `channel_key` selected by the sender |
| Ordering ID and timestamp | Assigned transactionally by the ledger |
| Content | Producing turn |
| Delivery attempts and recovery state | Router / transport; not necessarily visible to the sender |

There is no TTL, read marker, tag normalizer, supersession graph, archive move, or eviction policy to implement. Durable history remains in one store. Channel Sync checkpoints record channel coverage; other derived consolidation outputs remain projections rather than competing truth.

### 4.3 Broadcast requires a roster and creates wake ambiguity

`notify_all_active_sessions` sounds small until "active" must be made executable. Is it every historical channel, every live process, every recently used session, or every session with a matching inferred project? Each answer requires a roster, liveness rules, and different wake semantics. The set grows over the lifetime of the system.

The reduced design never enumerates a roster. A sender names one destination `channel_key`, or at most a small number of independently justified keys. The Router alone resolves each key and applies the normal wake, resume, or new-start path. Dormant, unaddressed channels stay dormant.

There is also no rate limiter that silently downgrades the sixth urgent incident into eventual polling. The existing substrate establishes durable enqueue/store-and-forward, Router delivery/wake behavior, and bounded at-least-once recovery windows. Sender-visible failure, overload backpressure, and end-to-end acknowledgement are **additional contracts to implement and verify** for workflows that require stronger safety. Until those contracts exist, the sender may claim durable enqueue, not confirmed downstream handling.

### 4.4 State the identity boundary honestly

`person: howard`, `project: release`, and `global: true` would be routing hints, not security principals. Removing them avoids pretending that model-written metadata provides isolation. It does not, however, create a new security boundary.

The governing target design assumes **one identity and one owner's memory** across context-isolated attention threads. Reads across those threads are intentionally unrestricted. Multi-personality sandboxing, data classification, trust-domain enforcement, and context projection are outside its scope. The reduced protocol therefore relies on that explicit deployment assumption, not on security guarantees the substrate does not provide:

- The destination is a structural `channel_key`, not a tag embedded in prose.
- The Router, not the producing session, resolves that key to runtime session state.
- The message carries only the fact and action needed for coordination, not the source channel's full working context. This is a relevance and minimization rule, not an authorization control.
- Cross-identity or internal-to-external sharing is a separate design problem. It requires data classification, audience authorization, and projection mechanisms that this target substrate does not currently claim.

This is deliberately narrower than a general shared memory, and its boundary must not be extrapolated beyond the single-owner deployment.

## 5. Executable Usage Protocol

The remaining design is small enough to state as rules.

### Producer rules

1. The session that makes an externally meaningful commitment records it in its normal conversation flow; that ledger record is authoritative.
2. Before the turn completes, it sends a point-to-point internal message to the known destination `channel_key` that must change behavior immediately. It does not select or retain a runtime session identity.
3. The message states the observed fact, its provenance, and the requested action. It does not copy the sender's full private context.
4. If no current destination is known, it sends nothing fast-path. The fact remains available to consolidation.

### Consumer rules

1. The receiving session treats the message as context, not as authority to execute work owned by another channel.
2. If the message conflicts with its current plan, it asks the source channel or the human for resolution.
3. When a topic explicitly depends on another channel's current commitment and no message has arrived, it asks that owning channel point to point before making a contradictory commitment.
4. It never scans or injects other channels' working histories wholesale.

### Lifecycle rules

There is no fast-path object lifecycle beyond normal message delivery. Retention and audit remain properties of the authoritative ledger. Channel Sync checkpoints/coverage and each consolidating reader's independent cursor are separate slow-path records. A fact changes through a new message or later consolidated memory; the original record is not rewritten or expired to simulate truth.

## 6. Boundary Conditions

This reduction is not universal. A new shared store may be justified when all of the following are true:

- producers cannot address the consumers that need the information;
- the information must be discoverable before the next consolidation;
- the existing ledger cannot support that discovery without exposing unrelated history; and
- the system can define producer identity, structural audience scope, ordering, per-reader progress, retention, supersession, overload behavior, and any required acknowledgement contract.

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
9. [Shared memory — Letta documentation](https://docs.letta.com/concepts/shared-memory/)
10. [Memory — Letta Agent SDK documentation](https://docs.letta.com/agent-sdk/memory/)
11. [Attach a block to an agent — Letta Python API](https://docs.letta.com/api/python/resources/agents/subresources/blocks/methods/attach/)
12. [Detach a block from an agent — Letta Python API](https://docs.letta.com/api/python/resources/agents/subresources/blocks/methods/detach/)
13. [Shared workspace/message bus for Codex subagents — openai/codex issue #21027](https://github.com/openai/codex/issues/21027)
14. [Lost in the Middle: How Language Models Use Long Contexts — TACL 2024](https://aclanthology.org/2024.tacl-1.9/)
15. [Effective context engineering for AI agents — Anthropic Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
