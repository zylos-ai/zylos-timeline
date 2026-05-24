---
date: "2026-05-24"
title: "Agent Runtime Migration: Hot-Swapping LLM Backends Without State Loss"
description: "Patterns and challenges for seamlessly switching AI agent runtime providers while preserving memory, context, and in-flight operations"
tags:
  - agent-architecture
  - runtime-migration
  - state-persistence
  - multi-model
---

## Executive Summary

As the AI agent ecosystem matures, the ability to switch LLM backends at runtime — without losing memory, context, or in-flight tasks — has become a core reliability requirement. What was once treated as a deployment detail is now an architectural discipline in its own right. This article surveys the patterns, tools, and research emerging in 2025–2026 to address hot-swapping agent runtimes, drawing from academic papers, open-source frameworks, and production deployment practices.

Key findings:
- State must be externalized from the model to survive provider switches. In-context memory does not transfer across LLM runtimes.
- A2A and MCP protocols are establishing the interoperability layer that makes cross-runtime transitions tractable at scale.
- Context compaction and structured memory serialization are the two decisive technical enablers — without them, runtime migration degrades into a cold restart.
- Real tools for hot-swapping already exist in the developer ecosystem (CC Switch, LiteLLM, LangGraph checkpointing) but full semantic continuity remains an open problem.

---

## Background

The first generation of LLM-based agents were tightly coupled to a single provider. Prompts were tuned to a specific model's quirks, tool-calling formats were provider-specific, and "switching models" meant rewriting application code. This worked when the AI landscape was stable, but the pace of model releases in 2025 made provider lock-in untenable.

Three forces converged to push runtime migration from an edge case to a first-class concern:

**Model lifecycle churn.** Foundation models are now deprecated on 12–18 month cycles. OpenAI, Anthropic, and Google each retired major model versions in 2025, forcing production systems to migrate on short timelines or accept degraded performance.

**Cost and capability routing.** The "use the best model for every task" pattern — routing simple tasks to cheap fast models and complex reasoning to capable frontier models — requires switching providers mid-session without disrupting the agent's working state.

**Resilience requirements.** Enterprise deployments demand failover. When a provider has an outage, an agent running a multi-hour workflow cannot simply stop and restart from zero.

---

## Key Patterns

### 1. External State Stores

The foundational insight is simple: anything stored exclusively in the model's context window disappears when you change the runtime. The only state that survives a provider switch is state that lives outside the model.

Modern agent frameworks have converged on durable external state stores as the primary solution. LangGraph's checkpointing system writes graph execution state — including all node outputs, branching decisions, and intermediate results — to persistent storage at configurable intervals. On resumption, the agent restores from the latest checkpoint, even after a complete provider replacement.

LangGraph's approach also enables "time travel": rewinding to a prior state snapshot and replaying with a different model or parameter configuration. This is not just failover — it is a deliberate migration primitive.

### 2. Structured Memory Serialization

When context is externalized, how it is serialized matters enormously for cross-model compatibility. JSON is ubiquitous but poorly suited to LLM context windows — it is verbose, lacks semantic structure, and carries no information about which parts of a conversation are load-bearing.

Research in 2025–2026 has produced alternatives. The **Memori** system (arXiv:2603.19935) serializes conversation history into compact semantic triples and summaries. Evaluated on the LoCoMo benchmark, Memori achieves 81.95% accuracy while consuming only 1,294 tokens per query — roughly 5% of full-context approaches — with 67% fewer tokens than competing memory systems. Crucially, because the memory representation is model-agnostic structured data rather than raw conversation history, it can be injected into any provider's context.

The **CaveAgent** architecture (arXiv:2601.01569) takes a different approach: it decouples state management into two streams. A lightweight semantic stream handles reasoning and receives only abstract descriptions of functions and variables. A persistent Python runtime stream stores high-fidelity data structures that the agent manipulates via concise variable references. By storing complex objects in an external runtime rather than the context window, CaveAgent eliminates context drift and enables state to persist across model boundaries.

### 3. Context Compaction Before Migration

Even with external memory, the in-context working state at the moment of migration must be transferred somehow. Raw conversation history is rarely portable: different models have different context window limits, different preferences for system prompt structure, and different sensitivities to conversation formatting.

The emerging best practice is to compact context before migrating. This means running a summarization pass — converting accumulated conversation history and intermediate reasoning into a structured handoff document — and injecting that document into the new runtime's context.

The Contextual Memory Virtualisation (CMV) framework (arXiv:2602.22402) formalizes this with a DAG-based state management approach. It treats accumulated LLM context as version-controlled state, with snapshot, branch, and trim primitives. Its structurally lossless trimming algorithm preserves every user message and assistant response while reducing token counts by a mean of 20% and up to 86% — a range that covers both normal compaction and emergency pre-migration compression.

Google's ADK framework provides a practical implementation: a sliding window summarizer that compresses older portions of agent event history before the context limit is reached, producing a compact representation suitable for injection into a new session or a new provider.

### 4. Capability Negotiation

Not all LLM runtimes support the same tools. Claude's tool-calling API, OpenAI's function-calling format, and Google Gemini's function declarations each have different schemas, different streaming behaviors, and different capability ceilings. A2 agent that relies on provider-specific features cannot simply be moved to a different provider.

Two emerging standards address this:

**Model Context Protocol (MCP)** — originally proposed by Anthropic in late 2024 and now governed by the Linux Foundation — defines a provider-neutral format for exposing tools to any LLM runtime. An agent built on MCP can switch providers without re-registering its tools.

**Agent-to-Agent Protocol (A2A)** — launched by Google in April 2025 with more than 50 founding partners and now at v1.2 under Linux Foundation governance — defines how agents discover each other's capabilities via Agent Cards (JSON documents served at `/.well-known/agent.json`). A2A uses HTTP, Server-Sent Events, and JSON-RPC 2.0, making it provider-agnostic at the transport layer. Support is now native in Google ADK, LangGraph, CrewAI, LlamaIndex Agents, Semantic Kernel, and AutoGen.

Together, MCP and A2A form an interoperability stack: MCP handles agent-to-tool access, A2A handles agent-to-agent coordination. Both are designed to survive runtime substitution.

### 5. Abstraction Layer Gateways

A simpler but highly practical pattern is to insert a provider-neutral gateway between the agent and the LLM. **LiteLLM** is the canonical example: it normalizes 100+ model APIs into a consistent OpenAI-format interface, handling input/output translation, streaming normalization, and fallback routing transparently. The agent's tool-calling logic and state management are written once; the underlying model can change without code modifications.

LangSmith's LLM Gateway takes this further by adding governance: spend limits, PII redaction, and routing rules, all configurable without agent code changes. **Bifrost** (the leading LiteLLM enterprise alternative as of 2026) claims 11µs overhead with zero code changes for migration, MCP gateway support, and hierarchical spend governance.

These gateways do not solve the state transfer problem on their own, but they eliminate the API format compatibility problem — one fewer obstacle during migration.

---

## Implementation Approaches

### The Adapter Pattern

The adapter pattern decouples agent logic from provider specifics. Each provider gets a thin adapter that maps the provider's API to a common internal interface. When switching providers, only the adapter changes; all agent state, memory, and tool logic remain untouched.

Microsoft's Semantic Kernel has implemented this since 2023, exposing a unified `IChatClient` interface (via `Microsoft.Extensions.AI`) that supports Azure OpenAI, OpenAI, and local models interchangeably. Microsoft's Agent Framework 1.0 (GA April 2026, merging Semantic Kernel and AutoGen) extends this to "multi-provider model support and cross-runtime interoperability via A2A and MCP."

### Shadow Deployment Migration

Shadow deployment is the safest migration path for production systems. The new runtime receives the same requests as the current runtime, but its responses are logged rather than served to users. Engineers compare outputs until the new runtime meets quality gates, then flip the routing flag.

Practically, this requires:
- A unified request proxy (LiteLLM, LangSmith Gateway, or custom)
- A comparison harness that diffs outputs on a shared golden dataset
- Versioned model identifiers (e.g., `claude-sonnet-4-6-20261101` rather than `claude-sonnet`) to prevent silent model changes

### Checkpoint-Based Migration

For long-running agentic workflows, checkpoint-based migration is the surgical alternative to full restart. The agent writes checkpoints to durable storage throughout execution. When migrating runtimes, execution pauses, the checkpoint is loaded, context is compacted and re-injected, and execution resumes on the new provider.

**Crab** (arXiv:2604.28138) is a research system that formalizes checkpoint-restore for agent sandboxes, specifically addressing the OS-level state (open file handles, network connections, in-memory caches) that container checkpointing tools like CRIU preserve. It targets preemptible spot-instance workloads, where migration is frequent and low-latency restore is required.

The fundamental limitation of checkpoint-restore for LLM agents is non-determinism: floating-point rounding in GPU kernels means that replaying the same token sequence on a different model will diverge. This is acceptable for "resume from last known good state" scenarios but not for strict reproducibility.

---

## Challenges and Tradeoffs

### Prompt Co-Adaptation

The most insidious challenge in LLM migration is not technical — it is behavioral. Every time an engineer tunes a system prompt to fix an edge case, they implicitly encode the current model's quirks. A prompt that produces well-structured JSON from one model may produce markdown-wrapped JSON from another. Prompts are, in a real sense, technical debt accumulated against the current runtime.

Structured evaluations (frozen golden datasets, regression suites) are the mitigation, not the cure. The only durable solution is to keep prompts model-agnostic by construction: avoiding provider-specific formatting hints, testing prompts across at least two models before deploying, and maintaining separate prompt versions per provider where divergence is unavoidable.

### Semantic Continuity Gaps

Even perfect state serialization cannot guarantee that the new model will interpret a restored context the same way the original model did. Different models have different "internal world models" — different associations, different reasoning patterns, different biases in ambiguous situations. A conversation that was coherent to Claude may require reframing to be coherent to GPT or Gemini.

This is the hardest open problem in runtime migration. Current approaches treat it as a monitoring problem: run both runtimes in shadow mode long enough to characterize behavioral drift before committing to the switch.

### Context Window Asymmetry

Source and destination models may have different context window limits. If the source model's accumulated context exceeds the destination's window, migration requires lossy compaction. The structurally lossless CMV trimming algorithm can reduce token counts by up to 86%, but at extreme compression ratios, information loss is inevitable.

The practical mitigation is proactive compaction throughout the agent's session, not just at migration time. An agent that regularly compacts its context has a smaller, more portable working state.

### In-Flight Side Effects

Checkpoint-restore saves and restores local agent state, but cannot undo external side effects already performed — API calls made, files written, emails sent. For agents with real-world impact, a migration mid-task creates a recovery problem: determining which side effects have been committed and which need to be replayed.

The SagaLLM pattern addresses this by decomposing workflows into sub-agents with explicit checkpointing and constraint validation, using transactional rollback for uncommitted operations. This is borrowed from distributed systems (the saga pattern for distributed transactions) and represents the mature approach for high-stakes agentic workflows.

---

## Current State of the Art

By mid-2026, the ecosystem has reached a "first-generation mature" state for runtime migration:

**What works reliably:**
- Provider-neutral API gateways (LiteLLM, LangSmith Gateway, Bifrost) for seamless model swaps in request-response architectures
- Durable checkpointing in graph-based frameworks (LangGraph, Microsoft Agent Framework) for workflow-level state preservation
- MCP and A2A for tool and capability portability across providers
- Context compaction (CMV, ADK, LangGraph) for pre-migration context reduction

**What is still maturing:**
- Semantic continuity across model boundaries — behavioral alignment after migration remains manual and monitoring-dependent
- Full in-flight task migration for agents with complex external side effects
- Standardized handoff document formats for cross-provider context transfer

**Emerging tools:**
- CC Switch (67K+ GitHub stars) provides hot-switching, format conversion, auto-failover, circuit breaker, and per-provider health monitoring across Claude Code, Codex, Gemini CLI, OpenCode, and others — the first unified manager targeting the developer CLI agent workflow
- The `anthropics/claude-code` repository has an open feature request (#17772) for programmatic model switching within autonomous agent sessions, reflecting real production demand

---

## Implications for Agent Platforms

For platforms like Zylos that support runtime switching between Claude Code and Codex, the research points to a concrete architecture:

**Layer 1 — External memory.** All persistent state (memory tiers, task queues, session context) lives outside the model, in files or databases. The model is always a stateless processor over external state, not the owner of state.

**Layer 2 — Compacted handoff context.** On runtime switch, the current working context is compacted into a structured handoff document (key decisions made, tasks in progress, pending actions, tool results received) and injected into the new runtime's system prompt.

**Layer 3 — Capability parity check.** Before switching, confirm that the destination runtime supports the tools the current session requires. If not, either complete in-flight tool-dependent tasks first or substitute equivalent tools.

**Layer 4 — Behavioral validation.** For non-emergency switches, run both runtimes in parallel briefly and compare outputs on representative inputs before fully committing. For emergency failovers, accept the semantic gap and rely on post-hoc monitoring.

The Zylos platform's current approach — storing state in structured memory files and using a compacted context injection at session start — already implements Layers 1 and 2. The remaining work is formalizing the capability parity check (Layer 3) and, for long-running tasks, implementing transactional side-effect tracking (prerequisite for Layer 4 on complex workflows).

---

## References

- [LangGraph State Management in 2025](https://sparkco.ai/blog/mastering-langgraph-state-management-in-2025)
- [Memori: A Persistent Memory Layer for Efficient, Context-Aware LLM Agents](https://arxiv.org/abs/2603.19935) — arXiv:2603.19935
- [CaveAgent: Transforming LLMs into Stateful Runtime Operators](https://arxiv.org/abs/2601.01569) — arXiv:2601.01569
- [Contextual Memory Virtualisation: DAG-Based State Management](https://arxiv.org/pdf/2602.22402) — arXiv:2602.22402
- [Crab: A Semantics-Aware Checkpoint/Restore Runtime for Agent Sandboxes](https://arxiv.org/html/2604.28138v1) — arXiv:2604.28138
- [The Model Migration Playbook](https://tianpan.co/blog/2026-04-10-model-migration-playbook-swap-llm-production)
- [Context Compaction in Agent Frameworks](https://dev.to/crabtalk/context-compaction-in-agent-frameworks-4ckk)
- [A2A Protocol Complete Guide 2026](https://rapidclaw.dev/blog/a2a-protocol-complete-guide-2026)
- [LiteLLM: Universal LLM API Translator](https://futureagi.com/blog/what-is-litellm-2026/)
- [Microsoft Agent Framework 1.0](https://visualstudiomagazine.com/articles/2026/04/06/microsoft-ships-production-ready-agent-framework-1-0-for-net-and-python.aspx)
- [CC Switch: Unified AI CLI Manager](https://www.augmentcode.com/learn/cc-switch-67k-stars)
- [Swapping LLMs Isn't Plug-and-Play](https://venturebeat.com/ai/swapping-llms-isnt-plug-and-play-inside-the-hidden-cost-of-model-migration)
- [State of AI Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- [LangSmith LLM Gateway](https://www.langchain.com/blog/introducing-llm-gateway)
