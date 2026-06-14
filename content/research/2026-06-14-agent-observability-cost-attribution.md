---
date: "2026-06-14"
title: "Agent Observability and Cost Attribution in Multi-Agent Systems"
description: "How to instrument, trace, and attribute costs across multi-agent LLM architectures — covering OTel GenAI conventions, leading platforms, attribution models, and production patterns for preventing runaway token spend."
tags: ["ai-agents", "observability", "cost-attribution", "opentelemetry", "multi-agent", "llm-ops"]
---

## Executive Summary

Multi-agent LLM systems break the fundamental assumption underlying traditional application monitoring: that a single request maps to a bounded, deterministic execution path. When agents spawn sub-agents, retry on failure, fan out across parallel workers, and share context through MCP servers, token costs compound in non-linear ways that are invisible without deliberate instrumentation. A single misconfigured agent in a retry loop can accumulate thousands of dollars before a human notices. Production measurements show multi-agent research systems consuming roughly 15x more tokens than equivalent single-agent chat interactions — mostly from system prompt repetition, tool schema overhead, and coordination messaging between agents.

The LLM observability market reached $2.69 billion in 2026 (up from $1.97B in 2025, a 36.3% CAGR), reflecting how urgently teams need visibility into what their agents are actually doing and spending. But the market is fragmented: there are proxy gateways, SDK-based tracers, OTel-native backends, and proprietary platforms, each with different cost models, licensing constraints, and integration paths.

This article maps the structural reasons multi-agent costs are hard to attribute, surveys the current tool landscape (LangSmith, Langfuse, Arize Phoenix, Helicone, AgentOps, Datadog), explains the attribution models teams use in production, details the OTel GenAI semantic conventions that are becoming the lingua franca for agent tracing, and provides practical implementation patterns for instrumenting a multi-agent system from zero. The central recommendation: instrument against OTel GenAI conventions rather than proprietary SDKs — this keeps migration options open as the market consolidates, and the tooling is now mature enough to make this viable.

## Why Multi-Agent Cost Attribution Is Hard

Six structural properties of multi-agent systems defeat naive cost monitoring:

**Token cost non-linearity.** A ReAct reasoning loop with 5 steps uses roughly 10x the tokens of a direct answer. Every agent hop re-transmits conversation history, system prompts, and tool schemas — none of which are typically cached at agent boundaries. Production multi-agent pipelines regularly exceed projected token budgets by 3-5x on first deployment.

**MCP Tax and schema duplication.** Tool schemas alone account for 60-80% of token usage in static toolsets. MCP deployments commonly see 10,000-60,000 tokens per turn in schema overhead, which compounds at every agent hop since schemas are re-transmitted rather than cached. This is an architectural cost that most teams discover only after deploying to production.

**Fan-out coordination overhead.** Communication channel count grows quadratically with agent count: a 5-agent mesh has 10 channels, a 10-agent mesh has 45. Coordination overhead exceeds 30% of the total token budget in typical hub-and-spoke designs. Organizations running 5+ agents without per-agent attribution reported 35-50% higher-than-projected costs in a 2026 survey.

**Retry cascades.** Failed attempts accumulate full conversation history, making each retry more expensive than the previous one. Model-controlled retries add extra reasoning passes before the retry action, creating silent cost storms that can triple hourly spend without triggering any application-layer error. Production failure rates in multi-agent systems range from 41% to 86.7%, predominantly from coordination issues — and each failure generates a full retry cost.

**Verification stacking.** Self-verification architectures using a second model call to validate the first achieve higher accuracy at approximately 2.3x the cost of sequential baselines — a tradeoff invisible without step-level tracing.

**Non-determinism at scale.** The same user query can cost $0.01 or $1.00 depending on which code path the agent takes. Without trace-level granularity, there is no way to identify which path ran, what caused it, or whether a regression occurred after a model update.

## The Tool Landscape

### LangSmith

LangSmith (by LangChain) captures the complete execution tree for agents: every LLM call, tool invocation, retrieval step, and reasoning chain. It uses *threads* to correlate related traces across multi-turn interactions and agent handoffs, and provides per-step cost metrics including input/output tokens per trace and tool call latency per model invocation.

Activation for LangChain/LangGraph requires only setting an environment variable:

```bash
export LANGSMITH_TRACING=true
export LANGSMITH_API_KEY=<your-key>
```

Custom instrumentation uses the `@traceable` decorator:

```python
from langsmith import traceable

@traceable
def run_agent(user_input: str) -> str:
    # All LLM calls within this function are automatically traced
    # with inputs, outputs, latency, and token usage
    result = llm.invoke(user_input)
    return result
```

Pricing: Developer tier (5K free traces/month), Plus ($39/seat/month), overage at ~$2.50 per thousand traces. Best for teams already using LangChain or LangGraph — the integration depth is unmatched for that ecosystem.

### Langfuse

Langfuse (MIT license, open-source) supports 80+ framework integrations (LangChain, LiteLLM, OpenAI SDK, and more) with accurate token and cost tracking for 100+ models. Self-hosted deployment is free; the cloud tier charges per trace/observation/score with 50K free monthly. ClickHouse acquired Langfuse in January 2026, and the backend is being optimized around ClickHouse OLAP for high-volume trace analytics — making it attractive for teams that need to run aggregate queries over millions of traces.

Langfuse is the most framework-agnostic option at the open-source tier. The SDK wraps any LLM client:

```python
from langfuse.openai import openai  # drop-in replacement

response = openai.chat.completions.create(
    model="claude-opus-4-5",
    messages=[{"role": "user", "content": "Hello"}],
    # Langfuse captures tokens, cost, latency automatically
)
```

### Arize Phoenix

Arize Phoenix (Elastic License 2.0, ~9,900 GitHub stars) is OpenInference-native and designed for local/Docker development workflows, RAG debugging, and fast experimentation. It runs with a local PostgreSQL backend. For production multi-agent use, Arize AX (the managed, proprietary counterpart) offers specialized views for multi-agent conversation flows.

**Important licensing note:** The Elastic License 2.0 prohibits using Phoenix as the basis for a competing hosted service. Review carefully before embedding in commercial products. The upstream OpenInference span taxonomy (Apache 2.0) is separately licensed.

Pricing: 25K spans/month free on the managed tier, then per-span plus data ingestion charges.

### Helicone

Helicone (open-source, YC W23) operates as an LLM proxy gateway — change the base URL in your API client and Helicone logs every request with zero code changes. It supports 300+ models via an open-source cost repository.

```python
from openai import OpenAI

client = OpenAI(
    api_key="<your-openai-key>",
    base_url="https://oai.helicone.ai/v1",
    default_headers={
        "Helicone-Auth": f"Bearer {HELICONE_API_KEY}",
        "Helicone-Session-Id": "workflow-123",          # group related calls
        "Helicone-Property-Feature": "document-analysis", # cost attribution tag
        "Helicone-Property-UserTier": "premium",
    }
)
```

Session grouping via `Helicone-Session-Id` headers enables per-workflow cost rollups without modifying agent logic. A reported cache hit rate of 73% saved $1,247/month in one production case study.

**Critical risk:** Helicone is a single point of failure for the entire LLM fleet. Any outage or latency spike at the proxy propagates to all agents simultaneously. Mitigation: use Helicone's fallback routing configuration and test failover regularly.

Pricing: 10K requests/month free, usage-based thereafter.

### AgentOps

AgentOps (MIT license) provides SDK-based agent tracing with "time-travel replay debugging" — the ability to replay agent execution state at any historical point, which is particularly useful for diagnosing intermittent failures in non-deterministic multi-agent systems. It supports OTel GenAI conventions and integrates with CrewAI, AutoGen, and Swarm frameworks.

### Datadog LLM Observability

For teams already on Datadog, the LLM Observability module supports OTel GenAI conventions natively from agent v1.37 onward, auto-mapping `gen_ai.*` attributes to its internal schema. The pricing model is important: Datadog charges only for LLM spans — tool, embedding, retrieval, and agent spans are free. This makes it significantly cheaper than flat per-span billing models for tool-heavy agents with many non-LLM steps.

## Cost Attribution Models

### Per-Agent Attribution

The foundational pattern: each deployed agent is assigned an identity, and token consumption is tracked against that identity continuously. Without per-agent attribution, when a cost spike occurs there is no way to identify the responsible agent or detect behavior changes after a model update.

Implementation with OpenLLMetry/OTel:

```python
from traceloop.sdk import Traceloop
from traceloop.sdk.decorators import agent

Traceloop.init(app_name="coordinator-agent")

@agent(name="document-analyzer")
def analyze_document(text: str) -> dict:
    # All LLM calls within this function are attributed to "document-analyzer"
    return llm.invoke(f"Analyze: {text}")
```

### Per-Session Attribution

Groups all API calls within a user interaction to reveal the true cost of a complete workflow. Without this, you may know your average cost per API call but have no idea that some user workflows trigger 50 calls while others trigger 5.

```typescript
// Helicone session attribution
headers: {
  "Helicone-Session-Id": `support-ticket-${ticketId}`,
  "Helicone-Property-Channel": "web-chat",
  "Helicone-Property-UserTier": "premium",
}
```

Langfuse models this as a `trace` containing multiple `spans` — the trace represents the user session, spans represent individual LLM calls within it.

### Per-Workflow/Task Attribution

Evaluates ROI at the business process level. The question shifts from "how much did we spend this hour?" to "how much does a completed document review cost, and is it worth the revenue it generates?"

Multi-dimensional tagging is the implementation primitive:

```python
# Requesty multi-agent workflow tagging
response = client.chat.completions.create(
    model="claude-opus-4-5",
    messages=messages,
    extra_body={
        "requesty": {
            "tags": ["eval-loop", f"iteration-{i}"],
            "trace_id": "order_12345",          # shared across all agents in workflow
            "extra": {
                "hierarchy_level": "coordinator",
                "workflow_type": "document-review",
                "business_unit": "legal"
            }
        }
    }
)
```

### Provider-Native Limitations

OpenAI natively supports only user and project attribution dimensions. Anthropic's Enterprise Analytics API (launched March 2026) adds per-user attribution with 90-day history, but has no per-request granularity and a 3-day delay on engagement data — insufficient for operational cost management. Databricks' Unity AI Gateway is currently the most mature native provider layer, with identity tracking, endpoint tags, custom request tags, and automatic logging to Unity Catalog system tables with actual dollar costs. For all other providers, third-party tooling is required.

**The chargeback problem:** Without attribution infrastructure, distributing LLM costs across teams or products is "impossible to administer fairly." The recommended approach is deploying attribution infrastructure for 4-6 weeks to establish per-workflow cost baselines before hardening budget limits or implementing chargebacks.

## OTel GenAI Semantic Conventions

The `gen_ai.*` namespace in OpenTelemetry's Semantic Conventions is becoming the lingua franca for agent observability. The GenAI SIG has been active since April 2024. As of mid-2026, the spec is in **Development status** (one stage below Stable), meaning attribute names can change without major version bumps. Production safety mechanism:

```bash
export OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental
# Enables dual-emission of both legacy and current attribute names during transitions
```

### Span Hierarchy (v1.41)

OTel GenAI v1.41 defines a canonical span hierarchy for agent systems:

| Operation | Span Kind | Trigger |
|---|---|---|
| `create_agent` | INTERNAL | Agent instantiation |
| `invoke_agent` (CLIENT) | CLIENT | Remote execution (OpenAI Assistants, Bedrock) |
| `invoke_agent` (INTERNAL) | INTERNAL | Local framework (LangChain, CrewAI) |
| `invoke_workflow` | INTERNAL | Multi-agent orchestration root |
| `execute_tool` | INTERNAL | Single function/tool call |
| `chat` / `inference` | CLIENT | LLM model call |

MCP tool tracing (added in v1.39) enriches existing `execute_tool` spans rather than creating new ones, preventing trace bloat. MCP-specific attributes: `mcp.method.name`, `mcp.session.id`, and `mcp.protocol.version`.

### Required Attributes

Mandatory per OTel GenAI for any `chat` or `inference` span:

```
gen_ai.operation.name      # "chat", "text_completion", "embeddings"
gen_ai.provider.name       # "anthropic", "openai", "google_vertex_ai"
gen_ai.request.model       # model ID as sent in the request
gen_ai.response.model      # model ID as returned in the response
gen_ai.usage.input_tokens  # integer, mandatory
gen_ai.usage.output_tokens # integer, mandatory
```

Mandatory metrics:
- `gen_ai.client.operation.duration` — latency histogram in seconds
- `gen_ai.client.token.usage` — token consumption histogram with input/output breakdown

### Cross-Agent Trace Propagation

W3C Trace Context is the standard mechanism for stitching spans from different agent processes into a single trace tree. Each agent propagates the `traceparent` and `tracestate` HTTP headers (or equivalent transport headers) to downstream agents and tool calls, enabling a complete execution tree from orchestrator to leaf tool call.

OpenLLMetry implements cross-MCP-server trace propagation, passing a trace identifier from one MCP server to another to maintain a continuous trace thread — critical for systems where MCP calls cross process boundaries.

### Content Capture Strategy

Prompt and response content capture is opt-in with three modes:
1. **Not recorded** (default) — preserves privacy, lowest storage cost
2. **Stored on span attributes** — full content on the span, indexed and searchable
3. **External storage with reference URL only** — trace structure preserved, content in separate storage

For PII-sensitive systems, the recommended production pattern is external storage mode: the trace tree and metadata are fully intact, but customer data never enters telemetry pipelines.

### OpenInference Span Taxonomy

OpenInference (Apache 2.0, published by Arize) complements OTel GenAI by defining span kinds as enumerated types: `CHAIN`, `LLM`, `RETRIEVER`, `TOOL`, `AGENT`, `EMBEDDING`, `RERANKER`. This semantic vocabulary for agent-type classification fills a gap that OTel GenAI's attribute-based approach doesn't address — knowing the *type* of agent/component that emitted a span, not just its name.

## Practical Implementation Patterns

### Instrumentation Selection Matrix

| Constraint | Recommended Approach |
|---|---|
| Data residency / sovereignty | Self-hosted: Langfuse (Docker/K8s) or Arize Phoenix |
| Speed-to-value (tracing this week) | Managed SDK: LangSmith or Braintrust |
| Zero-code-change cost visibility | Proxy gateway: Helicone |
| Already on major APM (Datadog, Dynatrace) | Extend via OpenLLMetry |
| Open-source, any backend | OpenLLMetry + OTel collector |

### Zero-Friction OTel Instrumentation

```python
from opentelemetry.instrumentation.openai import OpenAIInstrumentor
from opentelemetry.instrumentation.anthropic import AnthropicInstrumentor

# Auto-instruments all subsequent API calls with gen_ai.* attributes
OpenAIInstrumentor().instrument()
AnthropicInstrumentor().instrument()
```

For Anthropic/Claude specifically via OpenLLMetry:

```python
from traceloop.sdk import Traceloop

Traceloop.init(
    app_name="zylos-agent",
    api_endpoint="https://your-otel-backend:4317",  # any OTLP-compatible backend
)
# All Anthropic SDK calls are now traced automatically
```

### Hierarchical Budget Enforcement

The recommended production pattern pairs observability with active budget controls:

```python
class BudgetedAgent:
    def __init__(self, agent_id: str, token_budget: int):
        self.agent_id = agent_id
        self.token_budget = token_budget
        self.tokens_used = 0

    def invoke(self, messages: list) -> str:
        if self.tokens_used >= self.token_budget:
            raise BudgetExceededError(
                f"Agent {self.agent_id} exceeded budget: "
                f"{self.tokens_used}/{self.token_budget} tokens"
            )

        response = llm.invoke(messages)
        self.tokens_used += response.usage.total_tokens

        # Emit cost attribution span
        span.set_attribute("gen_ai.usage.input_tokens", response.usage.input_tokens)
        span.set_attribute("gen_ai.usage.output_tokens", response.usage.output_tokens)
        span.set_attribute("agent.id", self.agent_id)
        span.set_attribute("agent.budget_remaining",
                           self.token_budget - self.tokens_used)

        return response.content
```

Replace model-controlled retries with deterministic exponential-backoff logic to prevent the retry cost cascade pattern:

```python
import time

def invoke_with_backoff(agent, messages, max_retries=3):
    for attempt in range(max_retries):
        try:
            return agent.invoke(messages)
        except RateLimitError:
            if attempt == max_retries - 1:
                raise
            wait = 2 ** attempt  # 1s, 2s, 4s — bounded, predictable cost
            time.sleep(wait)
```

### Measurement Cadence

- **Daily:** Monitor 12-hour token usage spikes by agent and workflow type
- **Weekly:** Analyze the highest-cost traces for systemic patterns (retry storms, MCP schema bloat)
- **Monthly:** Snapshot cost baselines before major model updates or architecture changes

### Architectural Cost Reduction

Beyond instrumentation, the router pattern and caching are the two highest-leverage cost controls:

**Router pattern:** Route simple queries to smaller/cheaper models, complex queries to frontier models. Production data shows 30-60% cost reduction.

```python
def route_to_model(query: str, complexity_score: float) -> str:
    if complexity_score < 0.3:
        return "claude-haiku-4-5"      # ~20x cheaper than Opus
    elif complexity_score < 0.7:
        return "claude-sonnet-4-5"
    else:
        return "claude-opus-4-5"
```

**Prompt and prefix caching:** 50-90% reduction on cached input tokens. Both Anthropic and OpenAI support cache-control prefixes for static content (system prompts, tool schemas) that doesn't change between calls — the exact pattern most multi-agent systems need.

## What's Coming

**OTel GenAI Semantic Conventions for Agentic Systems (issue #2664):** An active proposal to extend the GenAI SIG conventions to the full agentic primitive set. Defines six convention families: Tasks, Actions, Agents, Teams, Artifacts, and Memory. Not yet formalized but actively designed.

**OpenLLMetry cross-MCP trace propagation:** Already implemented in the Traceloop SDK, this pattern is likely to become standard as MCP adoption grows. The ability to trace a user request from web interface through an orchestrator agent, across multiple MCP servers, to individual tool calls — as a single coherent trace — is the observability primitive the ecosystem needs most.

**Provider-native improvements:** Anthropic's Enterprise Analytics API and OpenAI's usage dashboards are improving but remain insufficient for operational cost management. Expect provider-native attribution to mature as enterprise customers demand it, but third-party tooling will remain superior for multi-provider architectures.

The market is consolidating: Braintrust's $80M Series B at $800M valuation (February 2026), ClickHouse's acquisition of Langfuse (January 2026), and Datadog's native OTel GenAI support signal that LLM observability is becoming a standard infrastructure layer, not a specialized tool.

## Key Takeaways

Multi-agent cost attribution is a first-day infrastructure concern, not a cleanup task. The practical guidance:

1. **Start with OTel GenAI conventions** rather than proprietary SDKs. The spec is Development status (v1.41) — pin carefully and use `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` during transitions.

2. **Choose your tool based on constraints.** For data sovereignty: self-hosted Langfuse. For speed: LangSmith. For zero-code-change visibility: Helicone proxy. For existing APM users: Datadog + OpenLLMetry.

3. **Tag everything from day one.** Agent ID, session ID, workflow type, business unit. Tags added retroactively require reprocessing history.

4. **Pair observability with active budget controls.** Hierarchical token budgets with circuit breakers stop runaway agents before they become billing surprises.

5. **Replace model-controlled retries with deterministic backoff.** The retry cost cascade is the most common silent budget killer in production multi-agent systems.

6. **Use caching for static content.** System prompts and tool schemas don't change between calls — they should be cached, not retransmitted.

The production architecture pairing: OTel GenAI-compliant spans for observability + hierarchical token budgets with circuit breakers for cost control + eval gates in CI and runtime for quality assurance.
