---
date: "2026-02-28"
title: "OpenTelemetry for AI Agents: Observability, Tracing, and the GenAI Semantic Conventions"
description: "How to instrument AI agent systems with OpenTelemetry's emerging GenAI semantic conventions to gain deep visibility into LLM calls, tool executions, and multi-agent workflows."
tags: ["observability", "opentelemetry", "tracing", "ai-agents", "llm", "devops", "monitoring"]
---

## Executive Summary

Deploying an AI agent is the easy part. Understanding what it actually does in production — why it chose a particular tool, how long each LLM call took, which reasoning branch led to a wrong answer, where token costs are accumulating — requires a fundamentally different observability strategy than traditional software.

The industry is converging on OpenTelemetry (OTel) as the standard telemetry layer for AI agent systems, with the OpenTelemetry GenAI Semantic Conventions SIG actively defining the attribute schemas for LLM calls, agent invocations, tool executions, and session-level metrics. This is not a future concern: major vendors including Datadog, Honeycomb, and New Relic already support these conventions, and frameworks such as LangChain, CrewAI, AutoGen, and AG2 emit OTel-compliant spans natively or via instrumentation packages.

This article covers the architecture of AI agent observability, the GenAI semantic conventions that define what data to capture, practical implementation patterns for Node.js/TypeScript agent systems, and how to use traces to debug the failure modes unique to autonomous agents — stuck tool loops, runaway token costs, context propagation failures in multi-agent pipelines.

---

## Why Traditional Observability Falls Short for AI Agents

Standard application monitoring answers questions like: "Did this HTTP request succeed? How long did the database query take? What error was thrown?" These metrics are deterministic — the same input produces the same output, and failures have clear error codes.

AI agent systems violate this model in several ways:

**Non-determinism.** The same prompt with the same inputs can produce meaningfully different tool call sequences, reasoning paths, and outputs across invocations. A latency spike might not indicate a bug — it might indicate the model chose a more expensive reasoning path that was actually more correct.

**Compound operations.** A single user request might trigger ten LLM calls, five tool executions, two database lookups, and a web fetch — each with its own latency, token cost, and potential failure mode. Traditional request/response tracing captures one hop; agent tracing must capture the full decision tree.

**Token cost as a runtime variable.** Unlike CPU or memory, token consumption is both a cost center and a functional signal. An agent that uses 50,000 tokens to answer a question that normally takes 3,000 is likely misbehaving — stuck in a loop, re-reading context unnecessarily, or hitting a prompt engineering problem. Without per-span token accounting, this is invisible.

**Emergent failures.** Agents can fail gracefully from a systems perspective (no exception thrown, HTTP 200 returned) while producing wrong or harmful outputs. Observability for agents must include semantic telemetry — not just "did it run?" but "what did it decide and why?"

These constraints drive the design of OpenTelemetry's GenAI conventions, which are structured around capturing the decision graph of an agent, not just its I/O boundary.

---

## The OpenTelemetry GenAI Semantic Conventions

The OpenTelemetry Generative AI Observability SIG, which began work in April 2024, is standardizing the attribute names, span types, and metric definitions for AI workloads. As of early 2026, the conventions cover four primary areas: LLM client spans, agent spans, events (for capturing prompt/completion content), and metrics.

### LLM Client Spans

When an agent calls an LLM provider, the instrumentation should emit a span with `gen_ai.operation.name` set to `chat` (or `text_completion` for older models) and the following key attributes:

| Attribute | Description |
|---|---|
| `gen_ai.system` | Provider identifier: `openai`, `anthropic`, `aws.bedrock`, etc. |
| `gen_ai.request.model` | Model requested, e.g. `claude-3-5-sonnet-20241022` |
| `gen_ai.response.model` | Actual model used (may differ if routing is in play) |
| `gen_ai.usage.input_tokens` | Tokens in the prompt, including cached tokens |
| `gen_ai.usage.output_tokens` | Tokens in the completion |
| `gen_ai.request.temperature` | Sampling temperature |
| `gen_ai.request.max_tokens` | Token cap if set |
| `server.address` | Endpoint called (useful for detecting proxy or gateway hops) |

The span name follows the pattern `{operation.name} {gen_ai.system}` — for example, `chat anthropic` or `chat openai`. This makes traces human-readable in any OTel-compatible backend.

Prompt and completion content are captured as **span events** rather than attributes, because they can be arbitrarily large and should be filterable for privacy:

```typescript
// gen_ai.content.prompt event on the span
span.addEvent('gen_ai.content.prompt', {
  'gen_ai.prompt': JSON.stringify(messages),
});

// gen_ai.content.completion event after the response
span.addEvent('gen_ai.content.completion', {
  'gen_ai.completion': completion.content,
});
```

This approach lets you disable content capture in production by suppressing those event types without changing your span attributes — important for GDPR compliance or when processing sensitive user data.

### Agent Spans

Agent spans represent higher-level coordination — the invocation of an agent (which may itself call multiple LLMs and tools) rather than a single model call. Two primary operation types are defined:

**`invoke_agent`** — The core agent execution span. The span name is `invoke_agent {gen_ai.agent.name}`. Span kind should be `CLIENT` when calling a remote agent service (OpenAI Assistants API, AWS Bedrock Agents) or `INTERNAL` when the agent runs in-process (LangChain, CrewAI).

**`create_agent`** — Covers agent instantiation for frameworks that maintain persistent agent objects with their own lifecycle (e.g., a vector-store-backed assistant that needs to be created before it can be invoked).

Key agent span attributes:

| Attribute | Description |
|---|---|
| `gen_ai.agent.name` | Human-readable name set by the application |
| `gen_ai.agent.description` | What this agent does (optional but useful) |
| `gen_ai.agent.id` | Stable identifier for the agent instance |
| `gen_ai.operation.name` | `invoke_agent` or `create_agent` |

### Tool Execution Spans

When an agent invokes a tool (function call, MCP tool, API call), a child span should be emitted with `gen_ai.operation.name` set to `execute_tool`. The span kind is `INTERNAL` by convention. Tool spans are children of the agent or LLM span that triggered the call, creating the parent-child hierarchy that makes traces navigable:

```
[invoke_agent: research-agent]          ← root agent span
  [chat: anthropic]                     ← LLM call to plan the task
  [execute_tool: web_search]            ← tool call #1
  [chat: anthropic]                     ← LLM call to process results
  [execute_tool: write_file]            ← tool call #2
  [chat: anthropic]                     ← final LLM call for synthesis
```

In this hierarchy, you can immediately see that the agent made three LLM calls and two tool calls, identify which was slowest, and drill into any span to see the full attributes.

### Metrics

Beyond per-request tracing, the GenAI conventions define standard metrics for aggregate monitoring:

- `gen_ai.client.token.usage` — Histogram of token counts per operation, tagged by model and system
- `gen_ai.client.operation.duration` — Duration of LLM operations in seconds
- `gen_ai.server.request.duration` — Server-side latency (for gateway/proxy instrumentation)
- `gen_ai.server.time_per_output_token` — Time-to-first-token and inter-token latency

These metrics enable dashboards that answer aggregate questions: "What's our P99 LLM latency over the last hour?" and "Which agent is consuming 80% of our monthly token budget?"

---

## Instrumentation Patterns for Node.js Agent Systems

### Option 1: Auto-instrumentation via OpenLLMetry

The fastest path to coverage is [OpenLLMetry](https://github.com/traceloop/openllmetry-js), an open-source instrumentation library from Traceloop that patches popular LLM SDKs automatically. It supports 20+ providers (OpenAI, Anthropic, Bedrock, Ollama) and frameworks (LangChain, CrewAI).

```typescript
// Must be the very first import in your entry point
import * as Traceloop from "@traceloop/node-server-sdk";

Traceloop.initialize({
  disableBatch: false, // enable batching for production
  exporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    headers: { authorization: `Bearer ${process.env.OTEL_API_KEY}` },
  }),
});

// From this point on, all Anthropic/OpenAI calls are automatically traced
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic();
```

With this setup, every `client.messages.create()` call produces a properly attributed OTel span — no manual instrumentation required.

### Option 2: Manual Instrumentation with the OTel SDK

For custom agent architectures that don't use a standard framework, or when you need precise control over what gets traced, manual instrumentation gives you full flexibility:

```typescript
import { trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { SemanticAttributes } from "@opentelemetry/semantic-conventions";

const tracer = trace.getTracer("zylos-agent", "1.0.0");

async function invokeAgent(agentName: string, userMessage: string) {
  return tracer.startActiveSpan(
    `invoke_agent ${agentName}`,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": agentName,
        "gen_ai.system": "anthropic",
      },
    },
    async (agentSpan) => {
      try {
        const result = await runAgentLoop(agentSpan, userMessage);
        agentSpan.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        agentSpan.recordException(err as Error);
        agentSpan.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        agentSpan.end();
      }
    }
  );
}

async function callLLM(messages: Message[], agentSpan: Span) {
  return tracer.startActiveSpan(
    "chat anthropic",
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.system": "anthropic",
        "gen_ai.request.model": "claude-sonnet-4-6",
        "gen_ai.request.max_tokens": 8192,
      },
    },
    async (llmSpan) => {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        messages,
      });

      // Record token usage on the span
      llmSpan.setAttributes({
        "gen_ai.usage.input_tokens": response.usage.input_tokens,
        "gen_ai.usage.output_tokens": response.usage.output_tokens,
      });

      llmSpan.end();
      return response;
    }
  );
}

async function executeTool(toolName: string, args: unknown) {
  return tracer.startActiveSpan(
    `execute_tool ${toolName}`,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": toolName,
        "gen_ai.tool.call.id": crypto.randomUUID(),
      },
    },
    async (toolSpan) => {
      const startMs = Date.now();
      try {
        const result = await tools[toolName](args);
        toolSpan.setAttribute("gen_ai.tool.output", JSON.stringify(result));
        toolSpan.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        toolSpan.recordException(err as Error);
        toolSpan.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        toolSpan.setAttribute("duration_ms", Date.now() - startMs);
        toolSpan.end();
      }
    }
  );
}
```

The `startActiveSpan` API automatically handles parent-child relationships — any spans created inside the callback are children of the current span. This means the LLM and tool spans created inside `invokeAgent` are automatically nested under the agent span without explicit parent references.

### Exporter Configuration

OTel supports multiple export protocols. For production use, OTLP over HTTP or gRPC is standard:

```typescript
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: "https://otel-collector.internal:4318/v1/traces",
  }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: "https://otel-collector.internal:4318/v1/metrics",
    }),
    exportIntervalMillis: 30_000,
  }),
  serviceName: "zylos-agent",
  serviceVersion: "1.0.0",
});

sdk.start();
process.on("SIGTERM", () => sdk.shutdown());
```

The OTLP collector then routes data to your backend of choice — Jaeger, Tempo, Honeycomb, Datadog, or any OTel-compatible store — without requiring changes to the instrumentation code.

---

## Debugging AI-Specific Failure Modes with Traces

### Detecting Stuck Tool Loops

A common agent failure mode is the tool loop — the model calls a tool, gets a result, decides to call the same tool again, gets a similar result, and repeats indefinitely. This burns tokens, increases latency, and often produces no useful output.

With OTel tracing, this pattern is immediately visible: the trace timeline shows the "comb" pattern of alternating LLM and tool call spans repeating with no forward progress. You can set alerts on this directly:

```typescript
// Emit a metric when a single agent invocation exceeds N tool calls
if (toolCallCount > MAX_TOOL_CALLS) {
  meter.createCounter("gen_ai.agent.tool_loop_detected").add(1, {
    "gen_ai.agent.name": agentName,
    "gen_ai.tool.name": lastToolName,
  });
}
```

Pairing this metric with a trace filter on `tool_call_count > 10` gives you a direct link from alert to trace for investigation.

### Token Cost Attribution

Without per-span token tracking, you only know total token cost per billing period. With OTel, you can answer questions like: "Which agent is responsible for 60% of our token spend?" or "Which tool call causes the model to generate the longest outputs?"

A useful derived metric is cost-per-outcome — total tokens consumed for agent invocations that completed successfully versus those that errored or required human intervention. This tells you whether token spend is going to productive work or error recovery.

```typescript
// Track tokens by outcome
span.setAttributes({
  "gen_ai.usage.input_tokens": usage.input_tokens,
  "gen_ai.usage.output_tokens": usage.output_tokens,
  "gen_ai.agent.outcome": outcome, // "success" | "error" | "human_handoff"
});
```

### Context Propagation in Multi-Agent Pipelines

When one agent delegates work to another — either via direct call or a message queue — the OTel trace context must be propagated so the work shows up as a single distributed trace rather than two disconnected traces.

OTel handles this via the W3C TraceContext header (`traceparent`, `tracestate`). For HTTP-based inter-agent calls, the SDK propagates these automatically. For queue-based communication, you need to serialize the context into the message:

```typescript
import { propagation, context } from "@opentelemetry/api";

// Sending agent: inject trace context into message
const carrier: Record<string, string> = {};
propagation.inject(context.active(), carrier);

await queue.publish({
  payload: taskPayload,
  traceContext: carrier, // { traceparent: "...", tracestate: "..." }
});

// Receiving agent: extract and restore trace context
const incomingContext = propagation.extract(
  context.active(),
  message.traceContext
);

// All spans created within this context are children of the originating trace
await context.with(incomingContext, async () => {
  await processTask(message.payload);
});
```

With this propagation in place, a Jaeger/Tempo trace view shows the entire work item — from the orchestrator agent through the worker agents and back — as a single connected graph, even if those agents run in different processes or on different hosts.

---

## Sampling Strategies for High-Volume Agent Systems

A busy agent system can generate thousands of spans per minute. Sending every span to your backend is expensive and often unnecessary — most successful routine operations don't need permanent storage.

**Head-based sampling** decides at trace start whether to record the entire trace. It's simple and has zero overhead for dropped traces, but it can discard rare but important failure traces.

**Tail-based sampling** buffers spans and decides after the trace completes — which lets you always keep traces where something interesting happened (error, slow response, high token count) while sampling down routine success traces. This is the right default for agent systems:

```yaml
# OpenTelemetry Collector tail sampling config
processors:
  tail_sampling:
    decision_wait: 10s
    policies:
      - name: errors
        type: status_code
        status_code: { status_codes: [ERROR] }
      - name: slow-traces
        type: latency
        latency: { threshold_ms: 5000 }
      - name: high-token-usage
        type: span_count
        span_count: { min_spans: 20 }  # proxy for complex/expensive traces
      - name: sample-routine
        type: probabilistic
        probabilistic: { sampling_percentage: 5 }
```

This policy keeps 100% of error traces, all traces over 5 seconds, all traces with 20+ spans (likely complex multi-step agent work), and 5% of routine successful traces. The result is a trace corpus that is maximally useful for debugging without excessive storage cost.

---

## Relevance to Zylos / AI Agent Systems

Zylos operates as a persistent, multi-session AI agent that coordinates across multiple communication channels, runs scheduled tasks autonomously, and integrates with an expanding set of skills and external services. The observability challenges described in this article are directly applicable:

**Session and task tracing.** Each scheduled task Zylos processes should emit a root `invoke_agent` span with the task ID as a trace attribute. This creates a direct link between the scheduler's task history and the OTel trace for that task's execution — when a task fails, you can pull the task ID, find the trace, and see exactly which LLM call or tool execution caused the failure.

**Token cost monitoring.** As Zylos's capabilities expand and it handles more autonomous work, token consumption will become a meaningful operational cost. Per-agent-invocation token tracking via OTel metrics enables budgeting, per-skill cost attribution, and anomaly alerts when a skill starts consuming unexpectedly many tokens.

**Multi-channel context isolation.** The CLAUDE.md spec requires strict context isolation between channels. OTel's trace context propagation model maps naturally to this: each incoming message starts a new root trace with a `channel.id` attribute, and all work done in response to that message is captured under that trace. Cross-channel context leaks become visible as incorrectly nested spans.

**Skill execution visibility.** Skills in Zylos are the equivalent of tools in a standard agent framework. Wrapping each skill invocation in an `execute_tool` span — with the skill name, input parameters (sanitized), and outcome — would make the skill execution log searchable and queryable, replacing the current need to grep through log files.

**Debuggability for autonomous operation.** The most critical benefit for an autonomous agent is post-hoc debuggability. When Zylos runs an overnight scheduled task and something goes wrong, a complete OTel trace showing every LLM call, tool invocation, and decision point is far more useful than log lines scattered across PM2 output.

A lightweight OTel setup for Zylos would involve: adding the `@opentelemetry/sdk-node` package, wrapping the main message processing loop in an `invoke_agent` span, instrumenting the Anthropic SDK calls via OpenLLMetry, and exporting to a local Jaeger or Grafana Tempo instance running via Docker. The instrumentation overhead is negligible (sub-millisecond per span) and the debugging value in production is substantial.

---

## The Observability Stack Landscape

Several backends and platforms now offer first-class GenAI telemetry support:

**Open-source self-hosted:**
- [Jaeger](https://www.jaegertracing.io/) — Battle-tested distributed tracing with a clean UI. Best for getting started quickly.
- [Grafana Tempo](https://grafana.com/oss/tempo/) — Integrates with Prometheus metrics and Loki logs for a unified observability stack. Strong for correlating traces with metrics.
- [OpenSearch](https://opensearch.org/) — Full-text search over trace data, useful for querying prompt content across traces.

**Managed platforms with GenAI-specific features:**
- [Langfuse](https://langfuse.com/) — Purpose-built for LLM observability with built-in prompt management and scoring. Offers a self-hosted Docker option.
- [Honeycomb](https://www.honeycomb.io/) — Excellent for high-cardinality trace querying. Their "BubbleUp" feature is particularly useful for finding which attribute combination correlates with slow traces.
- [Arize Phoenix](https://phoenix.arize.com/) — Open-source LLM observability with built-in evaluations and experiment tracking.

**Vendor platforms:**
- Datadog, New Relic, and Dynatrace all now support the GenAI semantic conventions natively, meaning OTel-instrumented agent code sends data to these platforms without any SDK changes.

The right choice depends on budget and existing tooling. For a self-hosted agent system like Zylos, Langfuse (self-hosted) or Grafana Tempo are the most practical starting points.

---

## Getting Started Checklist

For teams instrumenting an agent system for the first time:

1. **Add OpenTelemetry SDK** — `@opentelemetry/sdk-node`, `@opentelemetry/api`, and an OTLP exporter. Configure as early as possible in the process lifecycle.

2. **Add OpenLLMetry or equivalent auto-instrumentation** — Gets you LLM client spans with token usage and model metadata immediately, before any manual instrumentation.

3. **Add agent-level spans** — Wrap your top-level agent invocation function with an `invoke_agent` span. This creates the root of the decision tree.

4. **Add tool-level spans** — Wrap each tool execution with `execute_tool` spans. These are where latency outliers and errors typically surface.

5. **Configure tail sampling** — Start with a policy that keeps all error traces and a 10% sample of success traces. Adjust as you learn what's useful.

6. **Set up token usage dashboards** — Build a Grafana/Datadog board showing tokens per agent, tokens per model, and total daily cost. Review weekly.

7. **Add context propagation for async work** — If tasks are dispatched to queues or worker processes, inject and extract trace context to maintain distributed trace continuity.

The investment pays off quickly: the first time a production agent failure is diagnosed in minutes from a trace instead of hours from log archaeology, the value is clear.

---

## Summary

OpenTelemetry's GenAI Semantic Conventions provide a vendor-neutral, standardized foundation for AI agent observability. The conventions define span types for LLM calls (`chat`), agent invocations (`invoke_agent`), and tool executions (`execute_tool`), along with a rich attribute vocabulary covering token usage, model identity, and agent metadata.

For Node.js/TypeScript agent systems, the combination of `@opentelemetry/sdk-node` for the SDK layer and OpenLLMetry for automatic LLM provider instrumentation provides a practical path to full coverage with minimal code. Manual instrumentation with `tracer.startActiveSpan` handles custom agent orchestration logic cleanly.

The patterns that matter most in production are: hierarchical span trees that mirror the agent's decision graph, per-span token attribution for cost visibility, tail-based sampling to keep storage costs manageable, and W3C trace context propagation for distributed multi-agent pipelines.

As the GenAI SIG's conventions stabilize and more frameworks adopt them natively, the cost of adoption decreases while the ecosystem of compatible backends and analysis tools grows. Instrumenting now positions a system to benefit from that ecosystem without vendor lock-in.
