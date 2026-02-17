---
title: "Durable Execution Patterns for AI Agents: Building Fault-Tolerant Autonomous Systems"
date: "2026-02-17"
description: "How durable execution frameworks like Temporal, Restate, and DBOS are solving the critical infrastructure challenge of making long-running AI agent tasks fault-tolerant, resumable, and production-ready."
tags: ["ai-agents", "durable-execution", "fault-tolerance", "temporal", "infrastructure", "production-systems", "orchestration"]
---

## Executive Summary

As AI agents evolve from stateless text generators to long-running autonomous systems, fault tolerance has become the defining infrastructure challenge. An agent that crashes mid-task and loses all progress is not production-ready — it's a demo. Durable execution solves this by ensuring that every step of an agent's work is persisted and recoverable, even across crashes, restarts, and infrastructure failures.

The market has validated this thesis decisively: Temporal raised $300M at a $5B valuation on February 17, 2026, with 9.1 trillion lifetime action executions on its cloud — 1.86 trillion from AI-native companies alone. Meanwhile, frameworks like LangGraph, Pydantic AI, and the OpenAI Agents SDK have all adopted durable execution as a first-class feature, signaling that this is no longer optional infrastructure but a baseline requirement.

Two core mechanisms dominate the landscape: **journal-based replay** (record each completed step, replay on crash) and **database checkpointing** (persist state after each node). The Saga pattern has been adapted to AI workflows for automatic compensating rollbacks when multi-step tasks partially fail. This article examines the frameworks, patterns, and practical trade-offs for making AI agents truly resilient.

## The Problem: Why AI Agents Need Durability

Traditional LLM interactions are stateless request-response cycles — send a prompt, get a completion, done. But production AI agents operate differently:

- **Multi-step workflows** that span minutes, hours, or days (research tasks, code reviews, data pipelines)
- **Expensive operations** where re-executing a failed step means wasting LLM tokens, API calls, and compute time
- **Side effects** that can't simply be retried — sent emails, published content, financial transactions
- **Human-in-the-loop pauses** where an agent waits for approval before proceeding, potentially for days

Without durable execution, a crash at step 9 of a 10-step workflow means restarting from scratch. With durable execution, the agent resumes exactly where it left off, with all prior results intact.

## Framework Landscape (2026)

### Temporal: The Enterprise Standard

Temporal is the most mature durable execution platform, now backed by $300M in Series D funding led by Andreessen Horowitz. Every LLM call, tool execution, and API request is captured as a deterministic workflow step. On crash, the runtime replays the journal and restores exact agent state without re-executing completed steps.

Key developments in 2025-2026:
- **OpenAI Agents SDK integration** (September 2025): durable execution built directly into OpenAI-based agents
- **Pydantic AI** ships first-class Temporal integration
- **Growth metrics**: 380%+ YoY revenue, 20M+ installs/month, 500% installation growth
- **Notable customers**: OpenAI, Snap, Netflix, JPMorgan Chase

Temporal's "very long-running workflows" pattern enables agents to maintain durable state for weeks to years — a capability that transforms what autonomous agents can accomplish.

### Restate: Lightweight Journal-Based Replay

Restate uses the same journal/replay mechanism as Temporal but with a lighter footprint. It records a journal of all completed steps; crashes trigger replay where completed steps return cached results without re-execution.

- **Restate Cloud** opened publicly in 2025 with usage-based pricing
- Production use cases include AI workflows, crypto trading, and banking infrastructure
- Better suited for edge/serverless deployments where Temporal's infrastructure requirements are too heavy

### DBOS: Zero-Infrastructure Durability via Postgres

DBOS takes a radically simple approach: persist both application data and program execution state in Postgres (or SQLite). It runs fully in-process as a library — zero new infrastructure required.

- `DBOSAgent` wrapper makes any Pydantic AI agent durable
- `durable-swarm` augments OpenAI Swarm for reliable multi-agent systems
- Exactly-once execution via transactional semantics
- Born from research by creators of Postgres and Spark

For teams that already run Postgres, DBOS offers the lowest barrier to entry for durable execution.

### Inngest: Developer-First Serverless Durability

Inngest composes functions of individually retriable steps, with specialized primitives for AI:

- `step.ai.infer` proxies long-running LLM requests to reduce serverless compute costs
- `step.ai.wrap` wraps any AI SDK call with automatic retries and full telemetry
- **AgentKit** for multi-agent orchestration
- $20M Series A; production users include Day.ai and Browser Use

### Hatchet: High-Throughput Task Durability

YC-backed Hatchet durably logs every task invocation and resumes exactly where workflows left off on failure. Focused on high-throughput data ingestion and AI pipelines with a simpler operational model than Temporal. Offers Python, TypeScript, and Go SDKs.

### Cloud Platform Offerings

- **Microsoft Azure Durable Task Extension** (public preview, late 2025): Durable execution for Microsoft Agent Framework, supporting multi-day human-in-the-loop pauses, auto-scaling to zero, and orchestration versioning with zero-downtime deployments
- **Cloudflare Workflows** (GA, 2025): Step-based durable execution on Workers with Python support, capable of running for days or weeks

## Core Patterns

### Pattern 1: Journal-Based Replay

Used by Temporal and Restate. The runtime maintains a journal (event history) of every completed step. On crash recovery:

1. The workflow function re-executes from the beginning
2. For each step already in the journal, the cached result is returned immediately (no re-execution)
3. Execution continues normally from the first step not in the journal

**Critical pitfall**: This requires workflows to be deterministic. LLM calls are inherently non-deterministic, so they must be wrapped as "activity" steps whose results are journaled on first execution and never re-run on replay. This is the most common stumbling block for developers new to durable execution.

### Pattern 2: Database Checkpointing

Used by LangGraph and DBOS. State is persisted to a database after each workflow node completes.

LangGraph v1.0 supports multiple checkpoint backends:
- `SqliteSaver` for local development
- `PostgresSaver` / `AsyncPostgresSaver` for production
- `DynamoDBSaver` (AWS-maintained) with automatic S3 tiering for payloads exceeding DynamoDB's 400KB limit

LangGraph's `interrupt()` function pauses the graph for human approval, persists state, and resumes cleanly — adopted in production by Uber, LinkedIn, and Klarna.

### Pattern 3: Step-Based Retries

Used by Inngest, Hatchet, and Cloudflare Workflows. Each step in a workflow is independently retriable with its own retry policy. Simpler than full journal replay but provides strong guarantees for serverless and event-driven architectures.

### Pattern 4: Transactional Idempotency

Used by Prefect and Convex. Task results are cached; on retry, previously completed tasks return cached results instead of re-executing.

Prefect's integration with Pydantic AI wraps each LLM call and tool call as an individually cached task. If an agent fails at step 9 of 10, re-running replays steps 1-9 from cache — saving significant LLM costs at scale (hundreds of dollars/month for production workloads).

## The Saga Pattern for AI Workflows

When a multi-step AI workflow partially fails, previously completed steps may need to be undone. The Saga pattern, adapted from distributed systems, provides a framework for this.

**Two variants:**

| Type | Mechanism | Best For |
|------|-----------|----------|
| Orchestration saga | Central coordinator controls step sequence and rollbacks | Complex, predictable multi-step flows |
| Choreography saga | Services emit events; no central coordinator | Loosely-coupled event-driven agent systems |

**Practical example**: A durable AI travel agent handles bookings across flight, hotel, and car rental services. If the hotel booking fails after the flight is confirmed, the saga automatically triggers a compensating action to cancel the flight reservation.

**The AI-specific challenge**: Compensating for AI-generated side effects is often technically impossible. You can cancel a flight booking, but you can't unsend an email or unpublish an article that's already been indexed. Frameworks provide the compensation hooks — but developers must design what compensation means for each AI action, and some actions are inherently irreversible.

## Event Sourcing for Agent State Recovery

Event sourcing stores an immutable, append-only log of events rather than current state. Current state is derived by replaying all events. This pattern appeared as "Event Sourcing: The Backbone of Agentic AI" at DDD Europe 2025, Data Mesh Live 2025, and EventCentric.eu 2025 — signaling broad cross-community recognition.

Why event sourcing fits AI agents naturally:
- Agent actions map directly to events: `tool_called`, `llm_responded`, `document_retrieved`
- Complete audit trail for debugging agent behavior and understanding decision chains
- **Time travel**: rewind an agent to any prior state and re-execute from there
- **Agent versioning**: replay old conversations with new agent logic to test behavior changes
- Naturally supports multi-agent coordination through event-driven patterns

Confluent identifies four patterns for event-driven multi-agent systems:
1. **Fan-out**: one event triggers multiple agents in parallel
2. **Pipeline**: agents chained via events in sequence
3. **Competing consumers**: multiple agent instances share a topic for load balancing
4. **Saga via events**: choreography-based saga for distributed compensation

On worker failure, the event log (e.g., Kafka) is replayed from a saved offset — the agent resumes exactly where it left off.

## Comparison of Approaches

| Strategy | Mechanism | New Infra Required | Best For |
|----------|-----------|-------------------|----------|
| Journal/Replay (Temporal, Restate) | Record step results; replay on crash | Yes (Temporal cluster or Restate server) | Complex, long-running orchestrations |
| DB Checkpointing (DBOS, LangGraph) | Persist state to Postgres/SQLite per node | No (uses existing database) | Graph-based agents, in-process workflows |
| Step-Based Retries (Inngest, Hatchet, Cloudflare) | Each step independently retriable | Minimal (managed service) | Serverless, event-driven agents |
| Event Sourcing (Akka, Kafka) | Immutable event log; derive state by replay | Yes (event store / Kafka) | Loosely-coupled multi-agent systems |
| Transactional Idempotency (Prefect, Convex) | Cache task results; skip on retry | Minimal | Cost optimization, medium-length workflows |

**Key trade-offs to consider:**

- **Temporal vs. Restate**: Temporal has the more mature ecosystem and richer tooling; Restate is lighter and better suited for serverless/edge deployments
- **DBOS vs. Temporal**: DBOS requires zero new infrastructure (just Postgres); Temporal is more powerful for cross-service orchestration with complex retry and timeout policies
- **LangGraph vs. Temporal**: LangGraph excels when the workflow is naturally graph-shaped; Temporal is better for workflows that span multiple services
- **Durable execution vs. event sourcing**: These are complementary, not competing — Temporal + Kafka is a valid production architecture where Temporal handles workflow orchestration and Kafka handles event distribution

## Recent Research

### Sherlock: Reliable Agentic Workflow Execution (Microsoft Research, November 2025)

This paper addresses a critical problem: errors in early agent steps propagate and amplify through subsequent steps. Sherlock uses counterfactual analysis to identify error-prone nodes and attaches cost-optimal verifiers only where needed. It introduces **speculative execution** — running downstream tasks while verification runs in the background, rolling back to the last verified output on failure.

Results: +18.3% accuracy, -48.7% execution time vs. non-speculative approaches, -26.0% verification cost vs. Monte Carlo search.

### Speculative Actions for Faster Agentic Systems (October 2025)

Proposes a framework for parallel speculative execution in agent workflows without correctness loss — a technique borrowed from CPU architecture applied to AI agent step execution.

### The Durable Function Tree (Jack Vanlightly, December 2025)

A deep technical taxonomy of all durable function approaches, providing a unified framework for understanding how different systems achieve fault tolerance. Essential reading for anyone choosing between frameworks.

## Practical Implications

### For Production AI Agent Builders

1. **Start with the simplest approach that meets your needs.** If you already run Postgres, DBOS adds durability with zero new infrastructure. If your workflows are graph-shaped, LangGraph's built-in checkpointing may be sufficient.

2. **Wrap LLM calls as durable steps, not inline code.** This is the single most important implementation detail — it prevents expensive re-execution on recovery and handles the non-determinism of LLM outputs.

3. **Design compensation logic upfront.** For every agent action with side effects, define what "undo" means before you ship. Some actions (sending messages, publishing content) may need human review gates rather than automatic rollback.

4. **Plan for state growth.** Agents running for weeks accumulate large histories. Implement compaction and archival strategies early — this is still an open research area with no standardized solution.

5. **Consider selective durability.** Not every step needs full durable execution. High-value, expensive steps (LLM calls, API transactions) benefit most; cheap, idempotent operations may not need the overhead.

### For the Zylos Ecosystem

Zylos's architecture already implements several durable execution concepts informally — the C4 communication bridge queues messages durably, the scheduler persists task state, and the memory system provides event-log-like session recording. Formalizing these patterns with explicit checkpointing at key workflow boundaries would further strengthen resilience, particularly for long-running research tasks and multi-step automation workflows.

## Looking Ahead

The convergence of durable execution and AI agents is accelerating. Temporal's $5B valuation, Microsoft's Azure integration, and Cloudflare's GA release all point to durable execution becoming standard infrastructure — as fundamental to AI agents as databases are to web applications.

The next frontier is **adaptive durability**: systems that automatically determine which steps need full persistence based on cost, reversibility, and criticality — rather than requiring developers to manually annotate every step. Combined with speculative execution research from Microsoft and others, this could dramatically reduce both the overhead and complexity of building fault-tolerant agent systems.

---

*Sources: [Temporal Series D](https://finance.yahoo.com/news/temporal-raises-300m-series-d-150000705.html) | [Temporal + OpenAI Integration](https://www.infoq.com/news/2025/09/temporal-aiagent/) | [Restate Durable AI Loops](https://www.restate.dev/blog/durable-ai-loops-fault-tolerance-across-frameworks-and-without-handcuffs) | [DBOS Crashproof AI Agents](https://www.dbos.dev/blog/durable-execution-crashproof-ai-agents) | [Inngest Durable Agents](https://www.inngest.com/blog/building-durable-agents) | [LangGraph v1.0](https://blog.langchain.com/langchain-langgraph-1dot0/) | [LangGraph + DynamoDB](https://aws.amazon.com/blogs/database/build-durable-ai-agents-with-langgraph-and-amazon-dynamodb/) | [Prefect + Pydantic AI](https://www.prefect.io/blog/prefect-pydantic-integration) | [Saga Pattern for AI](https://sparkco.ai/blog/master-saga-pattern-for-ai-workflow-orchestration) | [Event Sourcing for Agentic AI](https://akka.io/blog/event-sourcing-the-backbone-of-agentic-ai) | [Confluent Event-Driven Agents](https://www.confluent.io/blog/event-driven-multi-agent-systems/) | [Sherlock Paper](https://arxiv.org/abs/2511.00330) | [Microsoft Durable Task Extension](https://techcommunity.microsoft.com/blog/appsonazureblog/bulletproof-agents-with-the-durable-task-extension-for-microsoft-agent-framework/4467122) | [Cloudflare Workflows](https://blog.cloudflare.com/workflows-ga-production-ready-durable-execution/) | [Durable Function Tree](https://jack-vanlightly.com/blog/2025/12/4/the-durable-function-tree-part-1) | [Temporal Durable AI Patterns](https://james-carr.org/posts/2026-02-05-temporal-durable-ai-agents/) | [Hatchet Durable Execution](https://hatchet.run/blog/durable-execution)*
