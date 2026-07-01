---
date: "2026-07-02"
title: "Agent Context Transport — Envelope-Artifact Patterns for Large Payload Management"
description: "How AI agent frameworks handle large data handoffs between tools, hooks, and sub-agents when communication channels have size constraints. Covers envelope-artifact separation, manifest patterns, and practical design principles."
tags: ["ai-agents", "context-management", "system-architecture", "agent-infrastructure"]
---

## Executive Summary

AI agent systems communicate internally through channels — stdout pipes, tool-result payloads, sub-agent return values — that were designed for small, structured messages. As agents grow more capable and autonomous, the data they need to pass between components (conversation histories, analysis outputs, session state snapshots) routinely exceeds these channels' size limits. The result is silent truncation, context corruption, and degraded reasoning.

This article surveys how modern agent frameworks handle large payload transport. A clear architectural pattern emerges across the landscape: **envelope-artifact separation**, where a small manifest travels through the constrained channel while the full payload is stored externally and referenced by pointer. This is the classic Claim-Check Pattern from enterprise integration, now rediscovered and adapted for AI agent runtimes. We examine concrete implementations in Claude Code, OpenAI Codex, MCP, LangGraph, CrewAI, AutoGen, and Google ADK, and distill design principles for building agent systems that handle large context reliably.

## The Problem: Channels Were Not Built for This

Agent runtimes impose hard size limits on the channels between components. These limits exist for good reasons — protecting context windows, controlling costs, preventing memory exhaustion — but they create a transport problem when agents need to move large data.

**Claude Code** caps hook output at 10,000 characters; content exceeding this limit is saved to a file and replaced in-context with a preview plus a file path. General tool output faces a separate threshold around 30KB, truncated to a 2KB preview. Sub-agent (Task tool) results hit a hardcoded 32,000-token limit for API responses regardless of configuration. A GitHub issue documents that `claude plugin list --json` silently truncates at 64KB when piped — a systemic buffer boundary in the codebase.

**OpenAI Codex CLI** enforces a hard 10 KiB or 256-line truncation on tool outputs, preserving the beginning and end while marking removed middle content. The default `tool_output_token_limit` is 12,000 tokens. A community-filed issue describes how oversized tool outputs ingested wholesale into context disproportionately drain the usage quota because every subsequent turn becomes expensive with bloated context.

**Model Context Protocol (MCP)** has no hard global cap in the specification itself, but a 2025 discussion proposes adding `max_response_bytes` capability negotiation with a suggested default of 256KB-512KB. The motivation is concrete: browser automation tool calls returning full page reads can consume 50,000 to 500,000 tokens per call, causing session failures after a handful of navigation steps.

These are not edge cases. They are the normal operating conditions of production agent systems.

## Taxonomy of Transport Patterns

Six distinct patterns appear across the landscape, arranged from simplest to most sophisticated.

### 1. Inline Everything

The naive default: serialize the entire payload into the channel. This works for small data and fails predictably at every size limit documented above. It remains the starting point for most frameworks and the failure mode that motivates everything else.

### 2. Truncation with Recovery Hints

The first mitigation: truncate to fit, but provide enough information for the agent to recover the full content. Claude Code implements this for hooks (preview + file path). A research paper on terminal coding agents describes this as "agent-aware truncation hints" — the truncation message includes a tailored recovery suggestion based on the agent's capabilities, such as subagent delegation or incremental processing with offset/limit parameters. This pattern acknowledges the size constraint without solving the underlying transport problem.

### 3. Envelope-Artifact Separation (Claim-Check)

The core pattern. Store the large payload in external storage; pass only a small reference — a "claim ticket" — through the constrained channel. The consumer redeems the ticket to retrieve the full payload when needed.

This maps directly onto the **Claim-Check Pattern**, a well-established Enterprise Integration Pattern formalized in the classic Hohpe/Woolf text and documented in Microsoft's Azure Architecture Center. The analogy is luggage check: check your bag, receive a ticket, redeem it at your destination. The pattern is motivated by messaging systems "optimized to manage a high volume of small messages" where large messages "degrade the performance of the entire system."

In agent contexts, this pattern has been independently named **Context Offloading**, the **Filesystem Scratchpad**, and **Dynamic Context Discovery**. The Encyclopedia of Agentic Coding Patterns traces its crystallization to mid-2025 through early 2026, as practitioners building production coding agents "hit the same wall from several directions." The mechanism: write the full payload to a file and hand the agent a short summary plus a reference.

### 4. Manifest-Payload with Consistency Guarantees

A more rigorous variant of envelope-artifact separation. A metadata/manifest record stores versioning, checksums, and chunk counts. Chunk records hold the actual payload fragments. The manifest write acts as a **commit barrier** — readers can trust that referenced chunks exist once the manifest is present. This pattern, documented in research on chunked-object storage for managed NoSQL databases, adds the consistency guarantees that simple file-pointer approaches lack.

### 5. Shared State Surfaces (Blackboard Pattern)

Rather than point-to-point message passing, agents coordinate through a globally shared structured object. The **Blackboard Pattern** centralizes agent state around a common board; agents act asynchronously and react to state changes. This solves the "agent phone game" — lossy telephone-style hand-offs between agents — by giving all participants direct access to the authoritative state. The tradeoff is coordination complexity: concurrent writes require conflict resolution that point-to-point patterns avoid.

### 6. Database-Backed Context Stores

The most infrastructure-heavy approach: persist context in a database (relational, key-value, or vector store) and query it on demand. This enables cross-session persistence, semantic retrieval, and fine-grained access control, but introduces operational overhead and latency.

## Framework Implementations

### Claude Code

Claude Code implements truncation-with-pointer for hooks (10,000-char cap, excess saved to file with preview) and stores session transcripts as JSONL files containing tool_use/tool_result pairs, thinking blocks, and token usage. Sub-agent results face a 32,000-token hardcoded ceiling with approximately 20,000 tokens of fixed overhead per invocation — a constraint that can cause critical details like stack traces to be lost in the handoff.

### OpenAI Codex CLI

Codex truncates at 10 KiB / 256 lines by default with a configurable token limit. Unlike Claude Code, it has **not yet** adopted automatic artifact spillover — community issues explicitly request "auto-spill large tool outputs to files instead of silently truncating," making this a known gap under active discussion.

### Model Context Protocol

MCP's specification includes a native envelope-artifact dichotomy: **embedded resources** (full text or base64 blob inline) versus **resource links** (URI plus annotations like audience, priority, and modification time). The specification guidance is explicit: return a link rather than embedded content "if returned content is large or frequently reused" to avoid repeated context bloat. This is envelope-artifact separation built into the protocol layer.

### LangGraph

LangGraph provides a Checkpointer for thread-scoped state persistence, but warns explicitly against storing large binaries in state: "if your agent state includes a 50MB PDF and the agent takes 10 steps, the checkpointer writes 500MB of data to PostgreSQL." The recommended fix is to store files in specialized storage and keep only reference URLs in state. An advanced **Pointer State Pattern** splits control-plane state (routing flags, counters — kept in Postgres) from data-plane state (heavy RAG contexts, large string arrays — offloaded to Redis/Valkey). The practical impact of failing to separate these concerns is quantified: one GitHub issue reports checkpoint serialization causing 85% storage bloat and 37.8% token overhead with no opt-out.

LangGraph's `Send()` API for dynamic fan-out carries the same lesson: the community-recommended practice is "keep the Send payload small — send IDs and let each branch fetch its own data."

### CrewAI

CrewAI provides three memory tiers: short-term (ChromaDB with RAG, scoped to a single crew run), long-term (SQLite, persisting across executions), and entity memory (RAG-based, tracking people, places, and concepts). For inter-task data, Task objects accept a `context` attribute for explicit output chaining and an `output_file` parameter to write large outputs to disk rather than inline — a lightweight built-in claim-check option.

### AutoGen / AG2

AutoGen's GroupChatManager broadcasts every agent message to all other agents in the group. No built-in size-aware routing or claim-check mechanism was found in the documentation. This positions AutoGen closer to the "naive inlining" end of the spectrum, leaving large-payload handling as an exercise for the implementer.

### Google ADK

Google ADK has the most explicit built-in implementation. **Artifacts** are a first-class concept: named, versioned binary data associated with a session or persistently with a user. Each artifact is identified by filename plus an auto-incrementing version number. Session-scoped artifacts live and die with the session; user-scoped artifacts (using a `user:` filename prefix) persist across sessions. Storage backends are pluggable: in-memory for testing, local filesystem (with explicit path-traversal protection), or Google Cloud Storage for production. ADK's documentation frames artifacts as solving exactly this problem: "allowing agents to handle large content that doesn't fit well in regular session state."

## Design Principles

Five principles emerge from surveying the landscape.

**1. Separate transport from content.** The channel between components is a control plane. It should carry manifests, references, and coordination signals — not bulk data. Payload belongs on a data plane (filesystem, object store, database) accessed by reference.

**2. Make the envelope self-describing.** A pointer alone is fragile. The envelope should include enough metadata — content type, size, version, checksum — for the consumer to decide whether and how to retrieve the payload without fetching it first.

**3. Scope artifacts explicitly.** Google ADK's session-scoped vs. user-scoped distinction is the right abstraction. Artifacts without explicit lifecycle scoping become orphans. Session-scoped artifacts can be garbage-collected aggressively; persistent artifacts need versioning and access control.

**4. Treat artifact content as untrusted input.** When an agent reads back an artifact file, that content re-enters the prompt as untrusted input. Research on indirect prompt injection shows that malicious instructions embedded in tool output can hijack agent behavior in up to 60% of tested scenarios involving tool integration. Mitigation requires least-privilege separation between agents that read external content and agents with write or action permissions.

**5. Plan for cleanup.** No major agent framework has standardized artifact lifecycle management, but adjacent infrastructure provides a ready vocabulary: TTL-based auto-deletion (Kubernetes pattern), soft-delete with reference-counted garbage collection (Weights & Biases artifacts), and delayed deletion queues that protect in-flight readers (WarpStream's approach). Agent artifact stores need at least one of these mechanisms to prevent unbounded storage growth.

## Implications for Persistent Agent Systems

Always-on agents that operate across session boundaries face the envelope-artifact problem at its most acute. Every session rotation is a transport event: the agent's working context must cross from the dying session to the fresh one through a constrained channel.

The pattern that recurs across ADK, LangGraph, and the research literature on coding agents is consistent: keep the hot working context to summaries and IDs, keep the durable substrate on disk or in a database, and version or scope artifacts explicitly. Google ADK's design goal — agents that "pause, wait for extended periods, delegate tasks to sub-agents, and resume without losing context" — is achieved through durable state schemas rather than raw conversation-history replay, event-driven dormancy rather than polling, and multi-agent delegation rather than monolithic prompts.

The cautionary counterexample is LangGraph's checkpoint bloat: 85% storage overhead and 37.8% token waste from failing to separate control-plane state from data-plane state. For persistent agents, the Pointer State Pattern — lightweight routing metadata in the fast store, heavy context in the bulk store — is not an optimization. It is a survival requirement.

The envelope-artifact pattern is not new. It is the Claim-Check Pattern, the presigned URL, the manifest-and-chunks model. What is new is that AI agent systems are rediscovering it under pressure, and the frameworks that build it in as a first-class primitive — rather than leaving it as an exercise for the implementer — will be the ones that scale.
