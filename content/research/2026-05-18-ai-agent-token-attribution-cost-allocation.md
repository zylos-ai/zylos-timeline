---
date: "2026-05-18"
title: "AI Agent Token Attribution and Cost Allocation in Multi-Project Workflows"
description: "How AI agent systems handle cost attribution when a single agent session works across multiple codebases — gateway-level tagging, proportional allocation, cache attribution, budget enforcement, and cost-aware model routing patterns."
tags: ["ai-agents", "token-economics", "cost-optimization", "observability", "multi-project"]
---

## Executive Summary

As AI coding agents evolve from single-session tools into autonomous CI/CD participants operating across dozens of repositories simultaneously, the question of *who pays for what* has become an engineering problem in its own right. The industry is converging on three architectural patterns to address it: mandatory gateway-level metadata tagging with direct per-request attribution, hierarchical budget enforcement with tiered alert thresholds, and cost-aware model routing that selects inference targets based on budget headroom before execution. The flat-rate subscription era for AI coding tools is ending — GitHub Copilot, Cursor, and Windsurf all migrated to token-based billing by mid-2026 — which means organizations can no longer absorb per-seat costs as a fixed line item. Token attribution is now a first-class operational discipline, not an afterthought.

## 1. The Attribution Problem

When an AI agent makes a single API call, cost attribution is trivial: one request, one bill. When that agent operates across multiple repositories in a single turn — reading a shared library, modifying a service, updating a configuration repo, and then synthesizing a summary — the cost structure fractures. Which project owns the tokens consumed by the shared-library read? Who pays for the cross-cutting context that had to be injected to connect the pieces?

### Why Naive Attribution Fails

The simplest approach — charge the "active" repo at the moment of inference — produces systematically wrong numbers. A single agentic task in a monorepo refactoring workflow might touch a core utilities package, three feature services, and an infrastructure module. If the agent is invoked from the infrastructure repo, 100% of the cost lands there regardless of what actually drove the token consumption.

The opposite failure mode is averaging: divide total session cost equally across touched repos. This undercharges high-complexity codebases and overcharges simple ones. An agent that read 50,000 tokens of context from a complex financial service but only made two line changes to a config file should not split the cost evenly.

### The Two Viable Approaches

**Direct attribution** traces every inference call to its initiating context. Each LLM request carries mandatory tags — project ID, team, pipeline step, and cost center — injected at the gateway layer. The total cost of that request is booked to exactly one owner, determined at the moment the request was dispatched. This is the most accurate approach and the one adopted by production systems like TrueFoundry's agentic CI/CD platform. The price of accuracy is instrumentation discipline: untagged requests must be rejected outright rather than silently attributed to a default bucket.

**Proportional allocation** distributes costs post-hoc based on measurable dimensions: lines of context pulled from each repo, tool calls per project, or output tokens written to each codebase. This is appropriate for shared infrastructure costs — a common vector database query or a system prompt loaded once but used across multiple projects. Activity-based costing is the most sophisticated variant: complexity-weighted allocation that factors in both volume and task type. The overhead of computing these weights is only justified for organizations with significant cross-project agent workflows at scale.

Most production systems use a hybrid: direct attribution for inference calls that can be cleanly tagged at dispatch, proportional allocation for shared-context overheads.

## 2. Industry Billing Architectures

### The Death of Flat-Rate AI

Between June 2025 and June 2026, every major AI coding platform abandoned flat-rate request-based billing in favor of token-consumption metering:

- **Cursor** (June 2025): Migrated from fixed request counts to credit-based billing pegged to API costs. The rollout was rocky — users reported unexpected charges, and Cursor issued a public apology and refunds, illustrating the operational risk of billing model transitions when users lack real-time visibility.
- **Windsurf** (March 2026): Followed the same credit model.
- **GitHub Copilot** (June 2026): All plans now receive monthly GitHub AI Credits at $0.01/credit, consumed based on actual token usage — input, output, and cached tokens — at per-model rates. Organizations get pooled credit budgets across seats, with admin controls at enterprise, cost-center, and user levels. Per-repository attribution is not yet a native feature; that granularity falls to third-party observability tooling.
- **Claude Code**: Has operated on token-based consumption from the outset, with usage stored locally in `~/.claude/projects/*/*.jsonl` JSONL files. Each entry records `message.usage` containing input tokens, output tokens, cache creation tokens, and cache read tokens, alongside model identifiers and timestamps. This local-first data model enables per-project analytics without requiring any API call to Anthropic.

### Token Metering Patterns

The industry has settled on four token categories that each carry distinct pricing:

| Token Type | Typical Cost Ratio | Notes |
|---|---|---|
| Input tokens | 1x (baseline) | Processed in parallel; cheapest to compute |
| Output tokens | 2–6x input | Sequential generation; highest per-token cost |
| Cache write | 1.25–2x input | One-time cost to populate shared prefix cache |
| Cache read | 0.1x input | 90% discount; dominant in long agentic sessions |

For attribution purposes, this matters because a single agent session working across multiple projects generates very different cost profiles depending on which project prompted cache population (expensive) versus which projects benefited from cache reads (cheap). Attributing cache writes to the project that *triggered* them rather than the one that first *benefited* from them is a subtle but financially significant design choice.

## 3. Technical Architecture: Data Pipelines for Token Attribution

### Hook-Based Collection (Local Agent Tools)

Claude Code's approach is illustrative of the local hook pattern. The `~/.claude/projects/` directory contains per-project JSONL session files. Each line is a complete event record. Third-party tools like `ccusage` parse these files to produce per-project breakdowns filtered by date range, session ID, or project path.

The hook integration layer fires on `SessionEnd` events and writes enriched records to a local SQLite store. Cost calculation applies the current model pricing table: input price for input tokens, output price for output tokens, 1.25x input price for cache writes, and 0.1x input price for cache reads. The critical design constraint is that this must run within 500ms to avoid blocking the parent session — which is why it is implemented as a standalone CJS module with zero external dependencies.

This architecture has a key limitation: it cannot attribute costs *within* a session when that session spans multiple project directories. The `ccusage` tool's `--filter-by-project` flag addresses this by matching the `cwd` field in each event record against known project paths, but events that span projects (a tool call that reads from `/repo-a` and writes to `/repo-b`) are attributed to whichever project's path appears in the session metadata.

### Gateway-Level Attribution (Production Systems)

For multi-tenant and CI/CD contexts, the gateway is the canonical attribution point. The TrueFoundry pattern is representative:

1. **Mandatory metadata injection**: Every request carries an `X-TFY-METADATA` header with `team`, `repository`, `pipeline`, `agent_step`, and `cost_center` fields. Requests without this header are rejected with a 400 error rather than passed through — treating missing attribution as a hard failure rather than a soft deficiency.

2. **Egress cost calculation**: At response egress, the gateway reads `usage.input_tokens`, `usage.output_tokens`, and `usage.cache_read_input_tokens` from the provider response, applies the current pricing table, and writes a complete ledger entry containing the full attribution context.

3. **Hierarchical budget evaluation**: The ledger entry is debited against all matching budget rules simultaneously. A single request may debit the "frontend-team" budget, the "react-monorepo" project budget, and the "q2-migration" cost center budget in parallel. Allow/block decisions come from the most specific matching rule only.

4. **P95 rolling forecasts**: Budget systems track per-project P95 token consumption velocity rather than averages, projecting end-of-month spend with enough lead time to adjust quotas before surprise invoices arrive. In practice this achieves ±8–12% forecast accuracy.

### OpenTelemetry Integration

The OpenTelemetry GenAI Semantic Conventions define the standard instrumentation schema for AI agent observability. Core metrics relevant to cost attribution:

- `gen_ai.client.token.usage` — histogram of token consumption per request, with `gen_ai.token.type` distinguishing input from output
- `gen_ai.operation.name` — identifies the operation type (chat, embeddings, tool_call)
- `gen_ai.provider.name` — tracks cross-provider costs in multi-model pipelines
- `gen_ai.request.model` and `gen_ai.response.model` — enables per-model cost breakdown

A critical gap: the OTel GenAI conventions do not define tenant, project, or cost center attributes. Organizations must extend the schema with custom attributes (`org.project.id`, `org.team.id`, `org.cost_center`) and ensure these propagate through W3C trace context headers across distributed agent calls. Without explicit propagation, multi-hop agent chains lose attribution context at each hop boundary.

### Real-Time vs. Batch Aggregation

The choice between real-time streaming and batch aggregation depends on the control objective:

- **Real-time streaming** (sub-second latency): Required for budget enforcement and circuit breakers. Cost events must reach the budget evaluation layer before the *next* inference call in the loop is dispatched. Implementing this as async fire-and-forget with an in-process budget cache avoids adding latency to the critical path while still preventing overspend.
- **Batch aggregation** (hourly/daily): Sufficient for reporting, forecasting, and chargeback calculations. JSONL files accumulate locally and are ingested into a warehouse (ClickHouse, BigQuery) on a schedule. This is the dominant pattern for analytics dashboards.

## 4. Multi-Dimensional Cost Models

### The Compounding Problem

Simple cost models that only track total tokens consistently underestimate real spend by 40–70%. The full cost of an agentic session includes:

- **Inference tokens**: Input, output, cache writes, cache reads — four separate pricing dimensions
- **Reasoning tokens**: For models with extended thinking, reasoning tokens are billed as output tokens but can multiply costs 5–20x compared to direct responses
- **Tool call overhead**: Each tool invocation injects structured JSON into the context window; high-frequency tool callers accumulate significant input token overhead
- **Retry costs**: Failed or rejected tool calls that trigger re-planning loops consume output tokens at full price before the loop terminates
- **Context compaction**: Automatic summarization triggers an output-heavy operation at compaction time that appears as a cost spike in per-session data

### Fast Mode and Model Tier Multipliers

When attribution spans a model switch mid-session — the agent used Sonnet for planning, Haiku for file reads, Sonnet again for synthesis — the cost ledger must record the model at each inference call, not just the session's primary model. Systems that attribute all session costs at the primary model's price overcharge by 30–60% for workflows that make heavy use of cheaper routing.

### Cache Attribution Complexity

Prompt caching creates a specific attribution edge case. A shared system prompt cached by Project A's CI pipeline costs 1.25x to write. When Project B's pipeline runs an hour later and benefits from the cache hit at 0.1x cost, the naive attribution gives Project A all the cost and Project B a windfall. Production systems address this with amortized cache attribution: the write cost is divided among sessions that will benefit from the cache during its lifetime (typically 5 minutes for Anthropic's default TTL), with subsequent sessions receiving credit for the amortized share they consumed at hit rates.

## 5. Visualization and Dashboards

### Essential Views

**Per-project burn rate**: A time-series line chart showing cumulative spend against project budget, updated in near real-time. Color coding follows a standard traffic light scheme: green below 50% of budget, amber 50–80%, red above 80%. This is the primary operational view for engineering leads who own project budgets.

**Per-agent efficiency**: Cost per completed task, charted over time. An agent that costs $0.12 per PR review is meaningfully different from one that costs $1.40 — not because the latter is broken, but because its workflow involves more tool calls and larger context windows. Efficiency trends reveal optimization opportunities and detect regression after prompt or workflow changes.

**Model mix breakdown**: A stacked bar chart showing what fraction of costs accrued on each model tier. In a well-tuned multi-model routing setup, expensive frontier models should represent a small fraction of total inference volume while cheaper models handle the bulk of retrieval, formatting, and validation work.

**Budget forecast**: A P95 projection of end-of-month spend per project, compared against the configured budget. Systems that only show current spend without projecting trajectory are operationally blind to burst risk — a single agentic loop that goes off-rails can exhaust a monthly budget in hours.

### Alert Architecture

Production budget alerting uses four thresholds with distinct response actions:

| Threshold | Alert Type | Automated Response |
|---|---|---|
| 50% | Informational notification | None; awareness only |
| 75% | Soft warning | Team notification, forecast updated |
| 90% | Constrained mode | Agent switches to cheaper model tier |
| 100% | Hard cap | Requests rejected with 429; agent paused |

The 90% threshold triggering a model downgrade rather than a hard stop is a key design choice: it preserves agent functionality for work-in-progress tasks while automatically reducing burn rate. A hard stop at 90% would leave tasks in inconsistent states.

## 6. Emerging Patterns

### Layered Budget Controls for Autonomous Agents

The architecture that has emerged for production autonomous agents uses three nested budget layers:

- **Per-iteration limit** (innermost): Caps tokens per reasoning step, typically 2,000–4,000 tokens. Prevents runaway context accumulation within a single ReAct loop.
- **Per-run budget** (middle): Caps total spend for a single agent execution, typically $5–$25 depending on task complexity. This is the primary control for CI/CD pipelines where each run is a discrete unit of work.
- **Per-project monthly budget** (outermost): The organizational cost envelope. All per-run executions debit against this aggregate.

These layers are not just accounting — they feed back into agent behavior. An agent that hits its per-iteration limit must summarize and continue rather than expanding context. An agent approaching its per-run budget receives explicit remaining-budget information in its system context, enabling it to prioritize the highest-value remaining work.

### Cost-Aware Model Routing

Model routing has matured into a five-dimension decision framework evaluated before each inference call:

1. **Task complexity**: Estimated from input characteristics (query depth, required reasoning chains, ambiguity signals)
2. **Confidence threshold**: A lightweight classifier pre-screens requests; uncertain outputs escalate to a larger model
3. **Latency sensitivity**: Interactive tasks require fast models; async pipeline steps tolerate cheaper, slower models
4. **Budget headroom**: Routing decisions explicitly incorporate remaining project budget — constrained budgets force routing toward smaller models
5. **Risk tolerance**: User-facing outputs demand higher accuracy; internal pipeline steps accept lower precision

The "small → large fallback cascade" pattern is the most common deployment: every request starts at the cheapest model tier that might plausibly handle it. If the response confidence score falls below threshold, the system re-runs at the next tier up. This consumes tokens twice on escalated requests but cuts overall cost by 60–85% for workloads where 70–85% of requests are successfully handled by budget models.

### Inference Cost as a Scheduling Signal

The most advanced emerging pattern treats inference cost as an input to workflow scheduling, not just an output to measure. When a CI/CD system knows that a repository's agent budget is 85% consumed with 10 days left in the billing period, it can de-prioritize optional analysis tasks (code smell detection, documentation refresh) while preserving budget for mandatory tasks (PR review, test failure diagnosis). This transforms the cost attribution system from a reporting mechanism into a real-time scheduling constraint — a pattern borrowed from cloud cost-aware autoscaling and applied to agentic workflows.

### The JSONL-to-Warehouse Pipeline

For organizations running Claude Code at scale, the local JSONL data model provides an unexpected opportunity: rich, granular, per-session attribution data that commercial observability platforms do not collect. The emerging pattern is to tail these JSONL files in real time (using inotify on Linux, FSEvents on macOS), parse each event record as it arrives, enrich it with project metadata from the directory structure, and stream it to a warehouse. This gives organizations sub-minute attribution latency with zero instrumentation changes to the agent itself — the data collection is entirely out-of-band.

The schema that has emerged for the enrichment layer adds four fields to each raw event: `project_id` (derived from the git remote URL of the `cwd`), `team_id` (from a directory-to-team mapping table), `cost_usd` (computed from token counts and current pricing), and `budget_remaining` (from the project's ledger). This enriched stream feeds both real-time budget enforcement and historical analytics.

## 7. Practical Recommendations

For teams building or adopting multi-project AI agent workflows, the implementation priority sequence is:

1. **Instrument first**: Stand up token collection before worrying about attribution logic. You cannot attribute costs you have not measured. JSONL parsing for Claude Code and OTel auto-instrumentation for framework-based agents cover the majority of cases with minimal engineering investment.

2. **Reject untagged requests at the gateway**: Soft attribution (defaulting untagged requests to a catch-all bucket) produces systematically corrupted attribution data. The cost of enforcing mandatory tagging is a one-time instrumentation effort; the cost of correcting months of corrupted data is far higher.

3. **Model cache attribution explicitly**: Systems that ignore cache write costs under-attribute by 20–40% for sessions with long system prompts or repeated document context. Design the amortization policy before data accumulates, not after.

4. **Implement the 90% model-downgrade threshold before the 100% hard cap**: Hard stops at budget exhaustion leave agent tasks in inconsistent states. The constrained-mode pattern — automatic routing to cheaper models when approaching the cap — preserves task completion while slowing burn rate.

5. **Use P95 forecasting, not averages**: Agentic token consumption has heavy tails. A pipeline that averaged 50K tokens per run for three weeks and then hit a refactoring task consuming 2M tokens will exhaust its monthly budget in a single run. Average-based forecasts are blind to this risk; P95 forecasts over a rolling window catch it with enough lead time to intervene.
