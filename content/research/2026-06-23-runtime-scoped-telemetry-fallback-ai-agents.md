---
date: "2026-06-23"
title: "Runtime-Scoped Telemetry Fallback for Multi-Runtime AI Agents"
description: "Why multi-runtime agent dashboards need runtime-aware metric identity, freshness metadata, and explicit fallback provenance instead of generic latest-value resolution."
tags: ["ai-agents", "observability", "telemetry", "runtime", "dashboards", "opentelemetry"]
---

## Executive Summary

AI agent platforms are starting to run the same persistent agent identity across multiple runtimes: Claude Code, Codex, local models, hosted sandboxes, and specialized task workers. That flexibility creates a subtle observability trap. If the dashboard asks for "latest context usage" or "latest rate limit" without scoping the query to the active runtime, it can silently display a fresh-looking value from the wrong runtime.

Traditional monitoring systems already have vocabulary for this problem: resource identity, stale series, missing data, last-known status, evaluation delay, and high-availability deduplication. But agent telemetry adds a new dimension. Runtime is not just another label like `environment=prod`; it changes the meaning of the metric. Codex token accounting, Claude Code statusline usage, LangGraph run state, and OpenAI Agents SDK traces are related operational facts, but they are not interchangeable samples of the same physical stream.

The core design rule is simple: store runtime and source as part of physical metric identity, resolve logical metrics through an explicit policy, and return provenance with every displayed value. A dashboard should be able to say "Codex value is fresh," "Claude value is stale fallback," "no active-runtime data exists," or "multiple sources conflict." It should not draw a stale fallback value as if it were authoritative.

This article synthesizes current OpenTelemetry, Prometheus, Grafana, Datadog, New Relic, Codex, Claude Code, OpenAI Agents SDK, and LangSmith guidance into an implementable pattern for multi-runtime agent dashboards.

## The Failure Mode: Latest Value Is Not Current Truth

The tempting resolver is:

```sql
SELECT *
FROM metrics
WHERE metric_name = ?
ORDER BY event_time DESC
LIMIT 1;
```

That works only when one logical metric has one writer. Multi-runtime agents violate that assumption. After a runtime switch, Claude Code may still have a recent statusline sample, Codex may have a newer JSONL or OpenTelemetry sample for some fields, and system-level collectors may continue to emit runtime-neutral metrics. If the resolver only sorts by timestamp, it can pick the wrong producer.

The visible symptom is worse than a blank card: a dashboard shows a plausible value from the old runtime. Humans interpret the UI as "current active runtime state," while the system is actually showing "latest value from any compatible-looking source." That is stale data wearing the clothes of live data.

Monitoring vendors have spent years separating related states that look similar:

- **No data:** the query returned nothing.
- **Missing series:** one labeled dimension disappeared while peers still report.
- **Stale series:** a previously valid stream stopped updating.
- **Zero:** the value is actually zero.
- **Last known value:** the UI is intentionally carrying a past value forward.
- **Fallback:** the primary source failed and a secondary source was chosen.

Agent dashboards need the same distinctions, with runtime identity added to the model.

## Runtime Is Part of Metric Identity

OpenTelemetry defines a metric stream by its resource attributes, instrumentation scope, metric name, unit, type, temporality, and datapoint attributes. Overlapping writers for the same stream are treated as a producer or receiver problem, not a normal merge case. The spec provides tools for detecting gaps, resets, and overlapping writers through timestamps and `StartTimeUnixNano`, but it does not define a universal policy for choosing between overlapping sources.

That gap matters for agents. A metric such as `context_usage_percent` may exist across runtimes, but its semantics depend on how the runtime measures context:

- Claude Code telemetry exposes session, model, tool, token, cost, request, retry, and fallback/refusal fields.
- Codex telemetry exposes conversation starts, API requests, SSE/WebSocket events, prompts, tool decisions, tool results, token counts, model labels, sandbox and approval settings, and runtime configuration metadata.
- OpenAI Agents SDK tracing uses workflow, trace, group, span, agent, generation, tool, handoff, and guardrail concepts.
- LangSmith and LangGraph organize state around threads, runs, metadata, token/cost aggregation, and persistent graph state.

Those systems can be normalized for dashboard use, but they should not be collapsed at ingest. Runtime and source must be part of the physical series key.

An agent platform should store at least:

```text
physical_series_key =
  metric_name
  agent_id
  session_id or conversation_id
  runtime_id
  runtime_kind
  source_id
  source_kind
  writer_id
  normalized_dimensions
```

Then expose a separate logical key for UI queries:

```text
logical_metric_key =
  metric_name
  agent_id
  session_id or conversation_id
  normalized_dimensions
```

This mirrors high-availability metric systems. Grafana Mimir uses a cluster label to identify the redundant source group and a replica label to identify the individual replica. After deduplication, the replica label can be dropped from the user-facing series. Multi-runtime agents need a similar split, except the resolver is not merely deduplicating replicas. It is choosing among semantically different producers.

## Freshness Is a Product Field, Not a UI Afterthought

Freshness should be visible and queryable. Google SRE guidance treats monitoring freshness as operationally important; data that is four or five minutes stale can materially slow incident response. Agent dashboards are often used for live operations: deciding whether an agent is idle, blocked, rate-limited, burning context, or waiting on a subagent. A stale value can cause the wrong action.

Every resolved metric should carry:

```json
{
  "value": 73,
  "event_time": "2026-06-23T03:55:00Z",
  "ingest_time": "2026-06-23T03:55:02Z",
  "source_runtime": "codex",
  "source_kind": "jsonl_usage",
  "requested_runtime": "codex",
  "active_runtime": "codex",
  "freshness_ms": 12000,
  "max_age_ms": 60000,
  "resolution_status": "authoritative",
  "fallback_reason": null
}
```

Event time and ingest time both matter. Event time tells when the measurement was observed. Ingest time tells when the platform learned about it. Delayed cloud metrics, batched runtime telemetry, paused local collectors, and clock skew can all produce misleading freshness if the resolver only sees one timestamp.

For agent dashboards, default freshness windows should be short for live runtime state and longer for historical or billing views:

| Metric type | Example | Suggested default |
| --- | --- | --- |
| Live runtime state | active runtime, idle/busy, current context | 30-90 seconds |
| API pressure | rate limit remaining, retry state | 30-120 seconds |
| Cost counters | token/cost totals | 2-10 minutes, depending on source delay |
| Historical trends | daily usage, PR throughput, task counts | hours or days |
| Runtime-neutral host metrics | CPU, disk, memory | normal infrastructure TTLs |

The exact numbers are product decisions. The important part is that every card knows whether it is looking at a fresh primary value, a stale primary value, a fallback, or nothing.

## Resolution Policy: Exact Runtime First

A runtime-aware metric resolver should be deterministic. A practical policy is:

1. If the user or card requested an exact runtime, only that runtime is eligible.
2. Otherwise, prefer the active runtime for the agent/session.
3. Within that runtime, prefer the authoritative source for the metric.
4. If multiple equivalent writers exist, use an explicit high-availability dedupe rule.
5. If no fresh active-runtime value exists, apply the metric's fallback policy.
6. If fallback is used, return fallback provenance and mark the value visually.
7. If sources conflict or required identity labels are missing, return `ambiguous` or `conflict`.

In code, the result should look more like a typed decision than a raw row:

```ts
type ResolutionStatus =
  | "authoritative"
  | "fallback"
  | "stale"
  | "missing"
  | "ambiguous"
  | "conflict";

interface ResolvedMetric<T> {
  value: T | null;
  status: ResolutionStatus;
  requestedRuntime?: string;
  activeRuntime?: string;
  sourceRuntime?: string;
  sourceKind?: string;
  eventTime?: string;
  ingestTime?: string;
  freshnessMs?: number;
  maxAgeMs?: number;
  fallbackReason?: string;
  candidatesConsidered: number;
  confidence: number;
}
```

The UI can now behave honestly:

- `authoritative`: show normally.
- `fallback`: show value with source label and fallback badge.
- `stale`: show muted value with age, or replace with stale marker.
- `missing`: show no-data state, not zero.
- `ambiguous`: show warning and link to candidate sources.
- `conflict`: show warning and avoid picking a winner silently.

## Fallback Is a Policy Matrix

CloudWatch, Grafana, Datadog, and New Relic all treat missing data differently because the right answer depends on the metric. CloudWatch supports missing, ignore current state, breaching, and not-breaching modes. Grafana distinguishes no-data from missing series and stale alert instances. Datadog supports last-known status, zero evaluation, no-data display, and group retention. New Relic has explicit loss-of-signal expiration with actions such as opening or closing incidents.

Agent platforms should copy the principle, not a single vendor default. Fallback policy belongs on the metric definition:

```yaml
metric: context_usage_percent
runtime_scope: active_runtime
authoritative_sources:
  codex: ["jsonl_usage", "otel_codex"]
  claude: ["statusline_current_usage", "otel_claude"]
fallback:
  allow_cross_runtime: false
  allow_stale_primary: false
  missing_behavior: "no_data"
freshness:
  max_age_seconds: 60
ui:
  show_source_runtime: true
  show_age_when_over_seconds: 30
```

For a runtime-neutral metric such as host disk usage, cross-runtime fallback may be valid because the metric describes the machine, not the active model runtime:

```yaml
metric: host_disk_used_percent
runtime_scope: runtime_neutral
authoritative_sources: ["node_exporter", "system_probe"]
fallback:
  allow_cross_runtime: true
  allow_stale_primary: true
  max_stale_seconds: 300
```

This distinction prevents a common bug: treating all fallback as equally safe. Falling back from one disk collector to another is reasonable. Falling back from Codex context usage to Claude statusline context usage after a runtime switch is usually wrong.

## The Agent Telemetry Schema Should Separate Five Identities

The research sources converge on a broader identity model. Multi-runtime agent telemetry should separate:

| Identity | Purpose | Typical fields |
| --- | --- | --- |
| Agent identity | Who the persistent assistant is | `agent_id`, `agent_name`, `workspace_id` |
| Conversation/session identity | Which human-agent continuity thread this belongs to | `session_id`, `conversation_id`, `thread_id`, `group_id` |
| Run/trace identity | Which execution attempt produced the event | `run_id`, `trace_id`, `span_id`, `parent_span_id` |
| Runtime identity | Which runtime surface produced the signal | `runtime_kind`, `runtime_id`, `runtime_version`, `model`, `provider` |
| Source/writer identity | Which collector or parser wrote the row | `source_kind`, `source_id`, `writer_id`, `schema_version` |

Do not overload `model` as runtime identity. A Claude runtime can switch models mid-session. Codex can use configurable providers. Local and hosted runtimes may expose the same model name through different telemetry paths. Model is a dimension, not the root identity.

## Anti-Patterns

**Latest timestamp wins.** This ignores runtime scope, source authority, delayed ingestion, and clock skew.

**Dropping runtime labels after ingest.** Once runtime/source labels are removed, downstream resolvers cannot distinguish old-runtime fallback from active-runtime truth.

**Treating missing as zero.** Zero is a valid measurement. Missing is an absence of measurement. Collapsing them breaks both dashboards and alerts.

**Carrying last value forward without provenance.** Last-known status is useful only when the UI says it is last-known.

**Using deployment environment as identity.** OpenTelemetry explicitly treats deployment environment as separate from service identity. `prod` does not distinguish Codex from Claude or one agent session from another.

**Letting vendor tag mapping define semantics.** Datadog, New Relic, Honeycomb, InfluxDB, Prometheus, and Mimir each map or merge labels differently. Normalize runtime/source identity before depending on vendor queries.

## Implementation Checklist

1. Add runtime and source fields to every telemetry row before storage.
2. Backfill unknown runtime/source values as `unknown`, not null.
3. Define physical series keys that include runtime/source/writer identity.
4. Define logical metric keys for UI-level queries.
5. Store event time and ingest time separately.
6. Add freshness TTLs per metric, not globally.
7. Add `resolution_status` and `fallback_reason` to resolver output.
8. Make cross-runtime fallback opt-in per metric.
9. Require UI cards to render fallback/stale/missing states differently.
10. Add tests for runtime switch scenarios and stale old-runtime data.

For the dashboard test suite, the most valuable regression test is concrete:

```text
Given active_runtime = "codex"
And metric context_usage_percent has a fresh Claude value
And no fresh Codex value exists
When resolving context_usage_percent for the active runtime
Then the result is missing or stale
And it must not return the Claude value as authoritative
```

## Why This Matters for Long-Lived Agents

Short-lived web requests can tolerate a simpler model because each request has a clear process boundary. Persistent agents do not. They accumulate memory, switch runtimes, delegate to subagents, replay context, restart services, migrate machines, and keep talking to humans across all of it. Observability has to preserve those boundaries.

The dashboard is part of the control loop. If it shows old-runtime data as current state, the human operator may debug the wrong runtime, blame the wrong component, or miss a real outage. Runtime-scoped telemetry is not a polish detail. It is how the system tells the truth about what is alive now.

## Sources

- OpenTelemetry Runtime Semantic Conventions: https://opentelemetry.io/docs/specs/semconv/runtime/
- OpenTelemetry Process Resource Attributes: https://opentelemetry.io/docs/specs/semconv/resource/process/
- OpenTelemetry Service Attributes: https://opentelemetry.io/docs/specs/semconv/registry/attributes/service/
- OpenTelemetry Deployment Environment Resource: https://opentelemetry.io/docs/specs/semconv/resource/deployment-environment/
- OpenTelemetry Metrics Data Model: https://opentelemetry.io/docs/specs/otel/metrics/data-model/
- Codex Advanced Configuration and OpenTelemetry: https://developers.openai.com/codex/config-advanced
- Claude Code Monitoring and Usage: https://code.claude.com/docs/en/monitoring-usage
- OpenAI Agents SDK Tracing: https://openai.github.io/openai-agents-python/tracing/
- OpenAI Agents SDK Usage: https://openai.github.io/openai-agents-python/usage/
- LangSmith Threads: https://docs.langchain.com/langsmith/threads
- LangGraph Threads and Runs: https://docs.langchain.com/langsmith/use-threads
- Google SRE Workbook, Monitoring: https://sre.google/workbook/monitoring/
- AWS CloudWatch Alarms and Missing Data: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/alarms-and-missing-data.html
- Grafana Missing Data Guide: https://grafana.com/docs/grafana/latest/alerting/guides/missing-data/
- Grafana No Data and Error States: https://grafana.com/docs/grafana/latest/alerting/fundamentals/alert-rule-evaluation/nodata-and-error-states/
- Grafana Stale Alert Instances: https://grafana.com/docs/grafana/latest/alerting/fundamentals/alert-rule-evaluation/stale-alert-instances/
- Grafana Mimir High Availability Deduplication: https://grafana.com/docs/mimir/latest/configure/configure-high-availability-deduplication/
- Prometheus Querying Basics: https://prometheus.io/docs/prometheus/latest/querying/basics/
- Prometheus Federation: https://prometheus.io/docs/prometheus/latest/federation/
- Datadog Monitor Configuration: https://docs.datadoghq.com/monitors/configuration/
- Datadog Interpolation and `default_zero`: https://docs.datadoghq.com/dashboards/functions/interpolation/
- New Relic NRQL Alert Conditions and Signal Loss: https://docs.newrelic.com/docs/alerts/create-alert/create-alert-condition/create-nrql-alert-conditions/
- Honeycomb Metrics: https://docs.honeycomb.io/send-data/metrics
- InfluxDB Duplicate Points: https://docs.influxdata.com/influxdb/v2/write-data/best-practices/duplicate-points/
