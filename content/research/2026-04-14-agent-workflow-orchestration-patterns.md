---
date: "2026-04-14"
title: "Agent Workflow Orchestration Patterns: DAG, Event-Driven, and Actor Models"
description: "A deep dive into the three dominant architectural patterns for orchestrating AI agent workflows in 2025-2026 — directed acyclic graphs, event-driven pub/sub systems, and the actor model — covering trade-offs, production tooling, and when to use each."
tags:
  - orchestration
  - workflow
  - dag
  - event-driven
  - actor-model
  - langgraph
  - temporal
  - autogen
  - multi-agent
  - production
---

## Executive Summary

The question of how to coordinate AI agents — how to sequence work, pass state, handle failures, and scale — has emerged as one of the most consequential architectural decisions in production AI systems. In 2024 the answer was often "just chain together some LLM calls." By 2025 that approach had collapsed under its own complexity: deadlocks, state corruption, silent failures, and runaway costs had taught teams that agent coordination deserves the same engineering discipline as distributed systems in general.

Three architectural schools have crystallised: **DAG-based orchestration** (explicit dependency graphs, deterministic execution order), **event-driven orchestration** (asynchronous pub/sub, agents as reactive consumers), and the **actor model** (isolated state, message-passing, supervision hierarchies). Each maps to a different philosophy about control, observability, and flexibility. The dominant production frameworks — LangGraph, Temporal, AutoGen v0.4/Microsoft Agent Framework, Dagster, and Kafka-native stacks — each embody one or more of these philosophies.

This article surveys all three patterns, the frameworks that implement them, how they handle the hard production problems (durability, failure recovery, human-in-the-loop, observability), and provides a decision guide for choosing the right pattern for a given workload.

---

## Why Workflow Orchestration Matters More Than Ever

Gartner projects 40% of enterprise applications will include task-specific AI agents by end of 2026, up from less than 5% in 2025. The AI agents market grew from $5.40 billion in 2024 to $7.63 billion in 2025, with a 45.8% CAGR projected through 2030. At this scale, ad-hoc agent coordination is not viable.

Production failures are instructive. A 2025 analysis of multi-agent system reliability identified the dominant failure categories:

- **Semantic failures**: the LLM produces a tool call with syntactically valid but logically wrong parameters — wrong outputs that look like right outputs to the execution layer
- **Cascading context corruption**: one agent writes incorrect state; downstream agents inherit it and amplify the error
- **Deadlock via circular delegation**: agent A waits for B, B waits for A, no timeout fires
- **Runaway cost**: an agent without budget constraints retries an expensive LLM call indefinitely
- **Silent state loss**: an agent process crashes mid-execution; no checkpoint exists; the entire job restarts

None of these are solved by prompt engineering. They require structural solutions — which is exactly what the three orchestration patterns provide.

---

## Pattern 1: DAG-Based Orchestration

### Concept

A Directed Acyclic Graph defines the execution plan up front. Nodes are tasks (or agents); directed edges are dependencies. The scheduler executes nodes whose upstream dependencies have completed. Because the graph is acyclic, there are no cycles and execution terminates.

```
     ┌──────────────┐
     │  Research     │
     └──────┬───────┘
            │
    ┌───────┴────────┐
    │                │
┌───▼────┐    ┌──────▼───┐
│Summarise│   │Fact-check │
└───┬────┘    └──────┬───┘
    └───────┬─────────┘
            │
     ┌──────▼───────┐
     │  Draft Report │
     └──────────────┘
```

### Core Strengths

- **Determinism**: given the same inputs, the execution order is identical. This makes debugging and auditing tractable.
- **Dependency management**: the scheduler automatically parallelises independent branches and serialises dependent ones.
- **Proven tooling**: Airflow, Dagster, Prefect, and Kestra all implement DAGs with decades of production hardening.
- **Strong observability**: DAG UIs show which node failed, its logs, and its upstream/downstream context.

### Limitations

- **Acyclicity constraint**: real agent reasoning is often iterative — an agent may need to loop, revisit, or branch conditionally based on intermediate results. Pure DAGs can't express this natively (workarounds involve recursive DAG expansion or task-group patterns).
- **Static topology**: the graph is typically defined at author time. When the required workflow shape depends on runtime conditions, authors must over-provision nodes and use conditional skip logic, which obscures intent.
- **Not designed for streaming**: DAG schedulers are optimised for batch, scheduled, finite workloads — not continuous event streams.

### Production Tools

**Apache Airflow 3.0 (GA 2025)** remains the industry standard with 30 million monthly downloads and 80,000+ organisations. Airflow 3.0 added Task Isolation, Event-Driven Workflows, and a modernised UI. 30% of users now leverage it for MLOps; 10% for GenAI applications. Its Providers ecosystem (1,000+ integrations) is unmatched.

**Dagster** takes an asset-centric view: the primary artifact is a *software-defined asset* (a dataset, model checkpoint, or report), not a task. The DAG expresses asset lineage, not just execution order. The Components framework (GA October 2025) allows modular, typed pipeline composition. Dagster's asset-first model is especially valuable for ML pipelines where reproducibility and data lineage matter.

**Prefect** launched **ControlFlow** in 2025, a framework specifically for LLM-driven workflows that embeds agent tasks as Prefect flows. Dynamic flows, hybrid execution, and a clean Python decorator API make it popular for teams that want fast iteration. Prefect's `.run()` is synchronous by default but the runtime manages concurrency automatically.

### Code Example: Dagster asset-centric agent pipeline

```python
from dagster import asset, AssetIn, materialize

@asset
def raw_research_results(context) -> str:
    """Agent fetches and aggregates research."""
    agent = ResearchAgent(model="claude-opus-4-5")
    return agent.run("latest trends in quantum computing 2026")

@asset(ins={"research": AssetIn("raw_research_results")})
def fact_checked_claims(research: str) -> list[dict]:
    """Fact-check agent verifies claims."""
    agent = FactCheckAgent()
    return agent.verify(research)

@asset(ins={"claims": AssetIn("fact_checked_claims")})
def final_report(claims: list[dict]) -> str:
    """Writer agent produces final output."""
    agent = WriterAgent()
    return agent.draft(claims)

# Run
result = materialize([raw_research_results, fact_checked_claims, final_report])
```

Dagster automatically tracks which assets are stale, enables incremental recomputation, and logs asset metadata (row counts, quality scores) for later inspection.

---

## Pattern 2: Event-Driven Orchestration

### Concept

Agents are reactive consumers. Instead of a central scheduler pushing work, agents subscribe to event streams and react when relevant events arrive. Every agent action produces an event; every event can trigger further agent actions. The workflow emerges from the event topology rather than being declared up front.

```
Kafka Topic: tasks.research
    │
    ▼
ResearchAgent ──publishes──► Kafka Topic: results.research
                                    │
                              ┌─────┴──────┐
                              │            │
                       SummaryAgent   FactCheckAgent
                              │            │
                              └─────┬──────┘
                                    ▼
                          Kafka Topic: results.validated
                                    │
                              DraftAgent
```

### Core Strengths

- **Decoupling**: producers and consumers don't know about each other. Adding a new agent that reacts to an existing event requires zero changes to existing code.
- **Natural scalability**: Kafka partitions allow horizontal scaling of consumer groups — add more agent instances to handle higher load automatically.
- **Real-time processing**: event-driven systems respond to events as they arrive, not on a schedule. This is essential for time-sensitive tasks (fraud detection, live threat analysis, user-reactive assistants).
- **Auditability via event log**: if every agent action is an immutable event on a durable log, you get complete replay capability, time-travel debugging, and A/B testing for free.

### Limitations

- **Complexity**: reasoning about system behaviour requires understanding the full event topology, which isn't visible from any single component.
- **Ordering guarantees**: ensuring causal ordering across multiple topics requires careful partition key design and (sometimes) distributed transactions.
- **Failure visibility**: a silent consumer crash may not surface immediately; dead letter queues and consumer lag monitoring are mandatory.
- **Latency**: event bus round-trips add overhead compared to direct in-process calls. For sub-second agent pipelines, this matters.

### Production Architecture: Kafka + A2A + MCP

The canonical 2025 production stack combines three layers:

1. **Apache Kafka** as the durable event backbone (topic-per-concern, event sourcing)
2. **Agent2Agent (A2A) protocol** (Google, released April 2025, Linux Foundation June 2025) for structured inter-agent delegation — signed agent cards, gRPC support (v0.3, July 2025)
3. **Model Context Protocol (MCP)** for tool access (file system, APIs, databases)

```
User Request
    │
    ▼
Orchestrator Agent
    │ publishes task event (A2A envelope)
    ▼
Kafka Topic: agent.tasks
    ├──► SpecialistAgent-A (consumes, publishes to agent.results)
    ├──► SpecialistAgent-B (consumes, publishes to agent.results)
    └──► SpecialistAgent-C (consumes, publishes to agent.results)

Kafka Topic: agent.results
    │
    ▼
Aggregator Agent (consumes all results, synthesises)
    │
    ▼
Kafka Topic: agent.outputs → User
```

Confluent published four canonical multi-agent patterns built on this stack:

| Pattern | Description | Use Case |
|---|---|---|
| **Orchestrator-Worker** | Central orchestrator emits task events; workers consume and emit results | Parallel subtask execution |
| **Hierarchical Agent** | Parent monitors a topic, spawns ephemeral child agents per event | Dynamic task spawning |
| **Blackboard** | All agents share a single event log as shared working memory | Collaborative problem solving |
| **Market-Based** | Agents bid on opportunity events; coordinator assigns to winning bidder | Load-balanced, priority-aware dispatch |

### Dead Letter Queues for Agent Failures

In agent systems, messages fail for LLM-specific reasons that differ from typical microservice failures:

- Context window exceeded
- API rate limit hit
- Output validation failure (structured output schema mismatch)
- Circular delegation (agent A delegates to B which delegates back to A)
- Tool timeout

An ML-based automated DLQ triage layer has emerged as a best practice in 2025: it classifies the failure type and routes to the appropriate remediation workflow (retry with truncated context, escalate to human review, substitute a cheaper model, etc.).

```python
# Dead letter queue handler pattern
async def handle_dlq_message(message: AgentMessage) -> None:
    failure_type = classify_failure(message.error)
    
    match failure_type:
        case FailureType.CONTEXT_OVERFLOW:
            await retry_with_summarized_context(message)
        case FailureType.RATE_LIMIT:
            await schedule_delayed_retry(message, backoff_seconds=60)
        case FailureType.SCHEMA_MISMATCH:
            await retry_with_constrained_decoding(message)
        case FailureType.CIRCULAR_DELEGATION:
            await escalate_to_human(message)
        case _:
            await route_to_fallback_model(message)
```

---

## Pattern 3: The Actor Model

### Concept

Actors are the fundamental unit of computation. Each actor has:
- **Private, encapsulated state** (no shared memory)
- **A mailbox** (message queue)
- **A behaviour** (function that processes messages and optionally sends messages to other actors, creates child actors, or updates its own state)

The actor model originated in Erlang/OTP for telecommunications systems requiring extreme fault tolerance. It maps naturally to multi-agent AI because agents are conceptually stateful entities that respond to messages.

```
Supervisor Actor
    │ spawns and monitors
    ├──► ResearchActor [state: {topic, results_so_far}]
    │         │ sends message
    │         ▼
    ├──► VerifyActor [state: {claims_pending, verified}]
    │         │ sends message
    │         ▼
    └──► WriteActor [state: {drafts, revision_count}]
```

### Core Strengths

- **Fault isolation**: an actor crash does not corrupt other actors' state. A supervisor can restart the crashed actor with a clean state, retry, or escalate — all configurable via supervision strategies.
- **Location transparency**: actors can be on the same process, different threads, or different machines. The message-passing API is identical.
- **Natural concurrency**: the actor model eliminates shared-state races. Each actor processes messages sequentially from its mailbox; all concurrency is expressed as message exchange.
- **Supervision hierarchies**: parent actors monitor children. This enables structured error recovery without global error handlers.

### Limitations

- **Cognitive model shift**: developers accustomed to synchronous function calls find async message passing unfamiliar. Debugging is harder when control flow is implicit in message routing.
- **Overhead for simple pipelines**: for straightforward sequential pipelines, actor overhead (mailboxes, supervision setup) isn't justified.
- **Ordering is not guaranteed across actors**: if two actors A and B both send to C, C receives them in arrival order, not send order.

### AutoGen v0.4 and Microsoft Agent Framework

Microsoft rebuilt AutoGen from scratch in v0.4 around a pure actor model with typed message passing. The design separates:

- **Core API**: a scalable, event-driven actor framework for creating agentic workflows at any scale
- **AgentChat API**: a higher-level, task-driven API built on Core for interactive multi-agent applications

In October 2025, Microsoft merged AutoGen with Semantic Kernel to create the **Microsoft Agent Framework (MAF)** — the enterprise-grade successor. New projects should use MAF directly; AutoGen → MAF migration guides are available.

```python
# AutoGen v0.4 / MAF actor pattern
from autogen_core import AgentRuntime, TypeSubscription
from autogen_agentchat.agents import AssistantAgent

runtime = AgentRuntime()

# Agents subscribe to typed message topics
await runtime.add_subscription(
    TypeSubscription(topic_type="research_request", agent_type="ResearchAgent")
)
await runtime.add_subscription(
    TypeSubscription(topic_type="research_complete", agent_type="WriterAgent")
)

# Publish a message — routing is handled by subscriptions
await runtime.publish_message(
    ResearchRequest(topic="AI orchestration patterns"),
    topic_id=TopicId(type="research_request", source="user")
)
```

Supervision in MAF follows Erlang conventions: `one_for_one` (restart only the failed actor), `one_for_all` (restart all siblings), and `rest_for_one` (restart failed actor and all actors started after it).

### Akka for JVM-Native Agent Systems

For teams on the JVM, Akka provides the most mature actor model implementation. Akka enables asynchronous, message-driven orchestration of distributed AI services. Akka Cluster allows actors to be distributed across nodes with automatic load balancing and failure detection.

---

## Durable Execution: The Cross-Cutting Concern

Across all three patterns, **durable execution** — the guarantee that a workflow runs to completion despite failures — has emerged as the defining production requirement. OpenAI's VP of App Infrastructure stated in 2025: "Durable Execution is a core requirement for modern AI systems… as AI systems become more complex and long-running, durability is as important as performance."

**Temporal.io** is the leading durable execution engine. Rather than implementing a specific orchestration pattern, Temporal provides a substrate on which any pattern can be built durably.

Temporal's core insight: separate *orchestration code* (deterministic, executes on Temporal workers, defines the workflow logic) from *activity code* (non-deterministic, makes LLM calls, calls external APIs). Temporal replays the orchestration code from its event history to reconstruct state after failures — only activities re-execute.

```python
# Temporal workflow — deterministic orchestration
@workflow.defn
class AgentPipelineWorkflow:
    @workflow.run
    async def run(self, request: PipelineRequest) -> str:
        # Each activity is automatically retried and its result persisted
        research = await workflow.execute_activity(
            research_activity,
            request.topic,
            start_to_close_timeout=timedelta(minutes=5),
            retry_policy=RetryPolicy(maximum_attempts=3)
        )
        
        # Human approval — workflow pauses here until signal arrives
        await workflow.wait_condition(lambda: self._approved)
        
        report = await workflow.execute_activity(
            write_report_activity,
            research,
            start_to_close_timeout=timedelta(minutes=10)
        )
        return report
    
    @workflow.signal
    async def approve(self) -> None:
        self._approved = True
```

As of March 2026, the OpenAI Agents SDK + Temporal integration is Generally Available, allowing OpenAI Swarm-style agents to run on Temporal's durable execution engine. Temporal also reached 99.99% SLA with Multi-Region Replication GA in early 2026.

---

## Static vs. Dynamic Workflow Topology

A critical dimension orthogonal to the three patterns is whether the workflow topology is fixed at author time (static) or generated at runtime (dynamic).

### Static Topology

The workflow shape is predetermined. Every run follows the same structure; only data values vary. This is the default for DAG systems and simple actor hierarchies.

- **Predictable cost**: you know exactly how many LLM calls will be made
- **Testable**: you can write unit tests for each node in isolation
- **Limited flexibility**: cannot adapt to discovered information mid-run

### Dynamic Topology

The workflow shape is determined at runtime, often by an LLM. A planner agent analyses the task and generates the execution graph before (or during) execution.

Research published in 2025 (arxiv:2603.22386) categorises dynamic approaches by their generation point:

| Approach | Generation Point | Example |
|---|---|---|
| **Difficulty-Aware** | Pre-execution | Estimate query complexity; allocate workflow depth proportionally |
| **Template Selection** | Pre-execution | LLM selects from a library of predefined workflow templates |
| **Assemble Your Crew** | Pre-execution | LLM samples roles and edges to produce a query-conditioned DAG |
| **ReAct/Plan-and-Execute** | Mid-execution | Agent decides next step after each action |
| **AgentConductor** | Iterative | Generates YAML topology, executes, re-generates based on validity/cost feedback |

The survey (arxiv:2508.01186) found that fully dynamic approaches consistently outperform static templates on open-ended tasks but are more expensive and harder to debug. Hybrid approaches — deterministic outer structure, dynamic inner loops — dominate production deployments.

```
Static outer pipeline:
  [Gather] → [Plan] → [Execute] → [Validate] → [Report]

Dynamic inner loop (within [Execute]):
  Planner ─── generates ──► subtask DAG (varies per run)
      └──────────────────► re-plans if validation fails
```

---

## Failure Handling and Compensation

Production agent systems require explicit failure handling strategies. The dominant patterns are:

### 1. Retry with Policy

```python
# Temporal retry policy — per activity, per error class
retry_policy = RetryPolicy(
    initial_interval=timedelta(seconds=1),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(minutes=5),
    maximum_attempts=5,
    non_retryable_error_types=["InvalidRequestError", "AuthenticationError"]
)
```

The key insight from 2025 production experience: retry policies must be defined **per error class**, not as a single catch-all. Rate limit errors warrant exponential backoff; context overflow errors warrant retry with summarised context; schema validation errors warrant retry with constrained decoding.

### 2. Saga / Compensation Pattern

For workflows spanning multiple agents that modify external state, the Saga pattern ensures atomicity. If step N fails, compensating actions for steps 1..N-1 run in reverse order.

```
Forward:   [ReserveDB] → [CallAPI] → [SendEmail] → [Commit]
                                           ↓ FAIL
Compensate:                          [UndoEmail] → [UndoAPI] → [UndoReserve]
```

Temporal implements this natively via workflow compensation handlers. The critical production caveat (identified in 2025): cancellation mid-execution does not automatically reverse completed activities — compensation logic must handle partial cancellation as a first-class scenario.

### 3. Circuit Breaker

When a downstream service (LLM API, tool endpoint) starts failing at high rates, a circuit breaker trips to prevent cascading failures:

```python
class AgentCircuitBreaker:
    def __init__(self, failure_threshold=5, recovery_timeout=60):
        self.failures = 0
        self.state = "closed"  # closed=normal, open=tripped, half-open=testing
    
    async def call(self, fn, *args):
        if self.state == "open":
            raise CircuitOpenError("Downstream service unavailable")
        try:
            result = await fn(*args)
            self.reset()
            return result
        except Exception as e:
            self.record_failure()
            raise
```

---

## Observability: The 2026 Differentiator

The 2026 production consensus: **an orchestration platform without deep observability is a prototype, not a production system**. Specifically, agent-aware observability requires:

1. **Trace-level visibility into every LLM call**: inputs, outputs, latency, cost, token counts
2. **State snapshots at each checkpoint**: not just logs, but full serialised state
3. **Time-travel debugging**: ability to replay execution from any checkpoint with different inputs
4. **Cost attribution**: which agent, which workflow step, which run consumed how many tokens

| Tool | Observability Strengths |
|---|---|
| **LangGraph Studio** | Time-travel debugging, state inspection at every node |
| **LangSmith** | Trace-level LLM visibility, evaluation pipelines |
| **Temporal UI** | Full workflow event history, query-able workflow state |
| **Dagster UI** | Asset materialisation history, metadata per run |
| **Arize / Weave** | LLM-specific observability: hallucination detection, drift |
| **OpenTelemetry** | Vendor-neutral tracing across the entire stack |

The emerging standard is OpenTelemetry semantic conventions for LLM spans (gen_ai.* attributes), allowing traces from any agent framework to flow into any observability backend.

---

## Comparison: Choosing the Right Pattern

| Dimension | DAG | Event-Driven | Actor Model |
|---|---|---|---|
| **Topology** | Static (usually) | Emergent | Hierarchical |
| **State management** | Centralised / passed between nodes | Distributed via event log | Per-actor, isolated |
| **Concurrency model** | Scheduler-managed parallelism | Consumer group scaling | Message-passing |
| **Failure isolation** | Node-level, propagates to dependents | Dead letter queue per consumer | Supervision tree |
| **Human-in-the-loop** | Sensor/trigger nodes | Approval events on dedicated topic | Signal messages to running actor |
| **Debugging** | DAG UI, node logs | Replay from event log, consumer lag | Actor state dumps, message traces |
| **Ideal for** | Batch pipelines, ML training, ETL with AI | Real-time reactive systems, microservice-scale agents | Stateful agents with complex lifecycles, distributed systems |
| **Representative tools** | Dagster, Airflow, Prefect | Kafka + A2A, Confluent, Redpanda | AutoGen/MAF, Akka, Elixir/OTP |
| **Durable execution add-on** | Temporal (activity wrapping) | Temporal (workflow wrapping) | Temporal (actor supervision) |

### Decision Guide

```
Start here: How long does a single agent job run?

Under 30 seconds → simple chain or ReAct loop is fine
30s – 10 minutes → LangGraph with checkpointing
10 minutes – hours → Temporal + LangGraph or Temporal + custom
Hours – indefinitely → Temporal (durable execution mandatory)

Then ask: Is the topology known in advance?

Yes, fixed → DAG (Dagster / Airflow / Prefect)
Yes, but iterative → LangGraph state machine
No, LLM-generated → Dynamic topology with Temporal backbone

Then ask: Is this real-time reactive or batch?

Batch / scheduled → DAG
Real-time event stream → Kafka + event-driven
Complex stateful agents needing isolation → Actor model (MAF / Akka)
```

---

## Production Case Studies

### LinkedIn: AI Recruiter (LangGraph)

LinkedIn's AI recruiter agent uses LangGraph with persistent checkpointing. The workflow involves candidate research (parallel web searches), profile synthesis, personalised outreach drafting, and scheduling coordination. State is checkpointed after each phase, allowing human recruiters to pause, review, and resume at any point.

### Uber: Large-Scale Code Migration (LangGraph + Temporal)

Uber's codebase migration agent combines LangGraph for agent reasoning with Temporal for durable execution across migrations that span hours or days. Each file migration is a Temporal activity with automatic retry. The LangGraph planner dynamically selects migration strategies per file type.

### Elastic: Real-Time Threat Detection (Kafka + Event-Driven)

Elastic's security agent system processes security events via Kafka. Each event triggers relevant specialist agents (network analysis, user behaviour, threat intelligence lookup) as parallel consumers. Results are aggregated on a results topic. The event log provides a full audit trail for compliance.

### IBM + Confluent: WatsonX Orchestrate (Kafka + A2A)

IBM's production deployment combines Kafka as the event backbone, A2A for agent delegation protocol, and WatsonX Orchestrate for enterprise workflow management. The architecture handles thousands of concurrent agent tasks with per-consumer dead letter queues for failure isolation.

---

## Emerging Patterns (2026)

### Difficulty-Aware Dynamic Routing

Rather than routing all tasks through the same pipeline depth, a classifier estimates query difficulty and allocates compute proportionally. Simple queries get a shallow chain; complex queries get a deep multi-agent pipeline. This delivers significant cost reductions without accuracy loss.

### Workflow-as-Code with LLM-Assisted Generation

Teams are beginning to use LLMs to generate Temporal workflow code from natural language descriptions. The generated code is reviewed by a human, tested, and deployed — combining the creativity of dynamic generation with the safety of static review. This is an early-stage pattern with significant tooling gaps.

### Federated Orchestration

As agents are deployed at the edge (device-local models, edge inference), orchestration must span cloud and edge. Federated orchestration coordinates agents across trust boundaries without centralising all state. A2A's signed agent cards are a building block for this pattern.

### Self-Optimising Workflows

Research systems (AgentConductor, AFlow/ICLR 2025) demonstrate workflows that optimise their own topology based on execution feedback. After each run, a meta-agent adjusts node assignments, parallelism, and retry policies. Production deployments of this pattern remain rare but are accelerating.

---

## Conclusion

Workflow orchestration for AI agents has graduated from an afterthought to a first-class architectural concern. The three patterns — DAG, event-driven, and actor model — are not mutually exclusive; most production systems blend them. LangGraph's state-machine model is DAG-like with cycles and checkpointing. Temporal's durable execution works with any of the three. AutoGen/MAF's actor model publishes events that can flow into Kafka.

The practical synthesis for 2026:

1. **Use Temporal for durability** regardless of which coordination pattern you choose. It handles retries, state persistence, and human-in-the-loop pausing in a way that no framework-specific solution matches.
2. **Use LangGraph for agent reasoning** — its graph model is expressive enough for iterative agent logic and has the best production tooling (Studio, LangSmith).
3. **Use Kafka + A2A for inter-service agent coordination** at microservice scale — when agents span separate services, a durable event bus is safer than direct RPC.
4. **Invest in observability from day one** — LangSmith + OpenTelemetry + your workflow engine's native UI is the minimum viable observability stack.
5. **Start static, add dynamism incrementally** — dynamic topology is powerful but expensive to debug. Begin with a fixed workflow, identify where flexibility is genuinely needed, and introduce dynamic planning only there.

The frameworks have matured. The patterns are understood. The remaining challenge is operational: teams that treat agent orchestration with the same rigour as distributed systems engineering will ship reliable products. Those that don't will rediscover the hard way that LLM non-determinism and distributed system complexity compound rather than cancel.

---

## References

- [A Survey on Agent Workflow — Status and Future (arxiv:2508.01186)](https://arxiv.org/abs/2508.01186)
- [From Static Templates to Dynamic Runtime Graphs: Survey of Workflow Optimization for LLM Agents (arxiv:2603.22386)](https://arxiv.org/html/2603.22386v1)
- [The Orchestration of Multi-Agent Systems: Architectures, Protocols, and Enterprise Adoption (arxiv:2601.13671)](https://arxiv.org/html/2601.13671v1)
- [Temporal: Durable Execution Meets AI](https://temporal.io/blog/durable-execution-meets-ai-why-temporal-is-the-perfect-foundation-for-ai)
- [Temporal + OpenAI Agents SDK Integration (GA)](https://temporal.io/blog/announcing-openai-agents-sdk-integration)
- [AutoGen v0.4: Reimagining the Foundation of Agentic AI](https://www.microsoft.com/en-us/research/articles/autogen-v0-4-reimagining-the-foundation-of-agentic-ai-for-scale-extensibility-and-robustness/)
- [Four Design Patterns for Event-Driven Multi-Agent Systems — Confluent](https://www.confluent.io/blog/event-driven-multi-agent-systems/)
- [The Future of AI Agents Is Event-Driven — Confluent](https://www.confluent.io/blog/the-future-of-ai-agents-is-event-driven/)
- [Agentic AI with A2A Protocol and Apache Kafka — Kai Waehner](https://www.kai-waehner.de/blog/2025/05/26/agentic-ai-with-the-agent2agent-protocol-a2a-and-mcp-using-apache-kafka-as-event-broker/)
- [LangGraph Production Guide 2025 — Versalence](https://blogs.versalence.ai/production-ai-agents-langgraph-complete-guide-2025)
- [Multi-Agent Workflows Often Fail — GitHub Blog](https://github.blog/ai-and-ml/generative-ai/multi-agent-workflows-often-fail-heres-how-to-engineer-ones-that-dont/)
- [Orchestration Showdown: Airflow vs Dagster vs Temporal in the Age of LLMs](https://medium.com/datumlabs/orchestration-showdown-airflow-vs-dagster-vs-temporal-in-the-age-of-llms-758a76876df0)
- [Building Effective Agents — Anthropic](https://www.anthropic.com/research/building-effective-agents)
- [State of Open Source Workflow Orchestration Systems 2025](https://www.pracdata.io/p/state-of-workflow-orchestration-ecosystem-2025)
