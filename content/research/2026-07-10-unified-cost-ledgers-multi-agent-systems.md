---
date: "2026-07-10"
title: "Unified Cost Ledgers for Multi-Agent Systems: Normalizing Tokens, Compute, and API Costs into a Single Credit Model"
description: "How production multi-agent platforms account for, attribute, and cap heterogeneous costs — LLM tokens, sandbox compute, third-party APIs — and why the unified real-time ledger remains more aspiration than reality in mid-2026."
tags:
  - ai-agents
  - cost-management
  - multi-agent
  - credit-billing
  - observability
  - finops
  - token-economics
---

## Executive Summary

When a single user task fans out across an orchestrator agent, three sub-agents running different models, a sandboxed code-execution environment, a browser automation session, and two third-party API calls, who pays for what — and how does anyone know in real time? The answer in mid-2026 is surprisingly primitive: most production multi-agent systems either punt on unified cost accounting entirely, or paper over the problem with opaque "credit" abstractions that deliberately hide the underlying cost math. This article surveys how frameworks, platforms, and emerging standards handle cost tracking across heterogeneous resource types, where the attribution problem breaks down, and what the gap between aspiration and reality means for teams building agent platforms today.

## The Heterogeneity Problem

A multi-agent task can incur at least five distinct cost types, each metered differently:

| Cost Type | Unit | Variability |
|-----------|------|-------------|
| LLM inference | Input/output/cached tokens (rates vary by model, provider, and cache state) | Per-request, sub-second |
| Sandbox compute | vCPU-seconds, GPU-seconds, memory-GiB-hours | Per-second, continuous |
| Browser automation | Session-minutes, page loads, screenshots | Per-action or per-minute |
| Third-party APIs | Per-call, per-record, per-query (each vendor different) | Per-call |
| Storage and egress | GB stored, GB transferred | Per-GB, often delayed |

These units are incommensurable. A token is not a vCPU-second. A search API call is not a GPU-hour. Yet a user who triggers a task wants one number: "how much did this cost me?" And an orchestrator enforcing a budget cap needs one number to compare against a threshold mid-execution. This tension — between the physical reality of heterogeneous metering and the operational need for a single ledger — is the core design problem.

## How Production Frameworks Handle Cost Tracking

### Anthropic Claude Agent SDK

The Claude Agent SDK exposes token usage at three granularities: per-step (each assistant message, keyed by message ID), per-model (a `model_usage` map on the result — critical for mixed-model setups where sub-agents run Haiku while the orchestrator runs Opus), and per-`query()` cumulative total (`total_cost_usd`). Anthropic explicitly warns that these are client-side estimates: "The `total_cost_usd` and `costUSD` fields are client-side estimates, not authoritative billing data... Do not bill end users or trigger financial decisions from these fields." Authoritative billing requires the separate Usage and Cost API.

A notable architectural gap: per-subagent attribution is unsupported. A GitHub feature request for per-subagent token metrics in Claude Code (issue #22625) was closed as "not planned," indicating that granular sub-agent chargeback is not on the near-term roadmap. Sessions spanning multiple `query()` calls are not auto-summed — developers must accumulate manually.

### OpenAI Agents SDK

Usage is aggregated across all model calls in a run, including tool calls and handoffs, via `result.context_wrapper.usage`. A `request_usage_entries` list provides per-API-request granularity. Both multi-agent patterns — "handoffs" (full control transfer between agents) and "agents-as-tools" (orchestrator retains control) — roll usage up to the parent run context. This means you get a total for the run, but drilling into "how much did sub-agent B cost within this run" requires correlating individual request entries with agent identifiers manually.

### AG2 (formerly AutoGen)

AG2's `OpenAIWrapper` tracks cost and tokens per call, with `Agent.print_usage_summary()` and `get_actual_usage()` providing per-agent and total breakdowns. OpenTelemetry integration allows span-level tracking. Among the open frameworks surveyed, AG2 comes closest to native per-agent cost attribution — though it still requires the developer to wire up the aggregation logic for multi-level delegation chains.

### Amazon Bedrock Agents

Bedrock offers the most mature chargeback (not just observability) story. It supports cost-allocation tags on agents and aliases, IAM-principal-based cost attribution that automatically assigns inference cost to the calling identity, "Bedrock Projects" for per-application cost grouping, and application inference profiles carrying tenant tags (TenantID, business-unit) for proportional chargeback. This is architecturally distinct from token-counting approaches — it piggybacks on AWS's existing IAM and cost-allocation infrastructure, treating agent cost as a special case of cloud resource cost rather than inventing a new metering primitive.

### LangSmith and LangGraph

LangSmith attributes token usage, latency, and cost down to individual spans and tool calls via nested trace visualization. It aggregates costs across the full agent workflow, including retrieval, tool execution, and downstream API spend — making it one of the more complete observability solutions, though it remains an observability layer rather than a billing or enforcement system.

### Google A2A Protocol

Google's Agent-to-Agent protocol defines Agent Cards and Task objects with session metadata, but research found no evidence of a standardized cost or usage field in the A2A spec itself. This is a genuine gap in the emerging interoperability standard: agents can discover and delegate to each other, but the protocol says nothing about how cost flows back up the delegation chain. Google's ADK 1.0 addresses cost indirectly through "Event Compaction" (context summarization), reported to cut token usage by roughly 38% — a cost-reduction mechanism, not a cost-accounting one.

## The Credit Abstraction: Who Has Actually Built One?

Two platforms stand out for shipping a genuine unified credit model that normalizes heterogeneous costs into a single unit:

### Cognition Devin — Agent Compute Units (ACUs)

Devin defines an ACU as "a normalized measure of the computing resources Devin uses to complete a task, such as virtual machine time, model inference, and networking bandwidth." One ACU approximates 15 minutes of active Devin work, billed at $2.25/ACU (Core plan) or $2.00/ACU (Team plan, bundled at 250 ACUs for $500/month). This is the clearest publicly documented "normalize everything into one unit" abstraction found in this research. It fuses token cost, sandbox/VM time, and network bandwidth into a single number, deliberately obscuring the underlying cost composition from the customer.

### Manus AI — Credit Model

Manus credits are consumed by three explicitly named sources: LLM tokens (task planning, decision-making, output generation), virtual machines (cloud environments for file operations, browser automation, code execution), and third-party APIs. Concrete anchors: a simple chat costs 5-15 credits, image generation costs 30-100 credits, and a 30-minute research agent run costs 500-900 credits. The standard plan offers 4,000 credits for $20/month. This is a task-outcome-based normalization — credits scale with task complexity and duration rather than a fixed per-unit conversion table.

### What Neither Publishes

Neither Devin nor Manus publishes the internal conversion formula — how many compute-seconds or tokens equal one ACU or credit. This opacity is deliberate: it gives the vendor flexibility to change the underlying cost mix (switching models, optimizing inference, negotiating compute rates) without repricing the customer-facing unit. But it also means the credit abstraction is a black box that cannot be independently audited or replicated by platform builders studying these models.

### Infrastructure Providers Remain Un-Normalized

Sandbox compute providers like E2B ($0.0504/vCPU/hr + $0.0162/GiB/hr, per-second billing) and Modal ($0.0000131/physical-core/s; H100 at $3.95/hr) meter in raw infrastructure units with no token equivalence. Platforms building agent products on top of these providers must construct their own conversion layer. No standard exchange rate between tokens and compute-seconds exists in the ecosystem.

Even within the token world, normalization is fragile. The same JPEG image can be tokenized as 87 tokens on one provider and 6,636 on another. Gemini charges 1,120 tokens per input image while other providers use entirely different accounting. Any credit abstraction that spans multiple LLM providers must maintain its own mapping table — and update it every time a provider changes their tokenization scheme.

## The Attribution Problem in Fan-Out Execution

When an orchestrator agent delegates to three sub-agents running in parallel, each of which makes tool calls that trigger further LLM inference, the cost-attribution graph becomes a tree. The question is: does any production system actually walk this tree automatically?

### The Dominant Pattern: Metadata Propagation

The most common real-world approach borrows directly from distributed tracing in web services. Every LLM call is stamped with metadata — `user_id`, `feature`, `deployment`, `agent_run_id`, `customer_id` — and cost rollup for a multi-agent run happens by grouping spans on `agent_run_id` after the fact. This is an OpenTelemetry-style parent-child span solution, not a purpose-built agent-economics primitive. It works, but it requires discipline at every call site and provides no built-in mechanism for attributing shared costs (cache warming that benefits multiple sub-agents, for example).

### The Deduplication Trap

A universal mechanical challenge across SDKs: when an agent fires multiple tool calls in a single turn, multiple assistant messages can share an identical message ID and usage payload. Naive summation inflates totals. Anthropic's docs provide an explicit deduplication pattern (track seen IDs, count each once), and the same class of bug recurs in threads about OpenAI and AG2 tracking. Any custom cost ledger must handle this edge case or risk systematic over-counting.

### Cache Token Accounting

Cache token fields are now standard across major providers: `cache_creation_input_tokens` (billed higher than standard input) and `cache_read_input_tokens` (billed lower). Logs must preserve prompt tokens, completion tokens, and both cache token types as separate fields. Conflating them — or failing to distinguish cache reads from cache writes — produces cost estimates that diverge from actual billing, especially in cache-heavy agentic workloads where the same system prompt is reused across hundreds of sub-agent calls.

### Game-Theoretic Approaches

Academic work is exploring more principled attribution methods. A 2026 paper on "Token Economics for LLM Agents" (arXiv:2605.09104) frames a four-level taxonomy from micro (single-agent budget constraints) through meso (multi-agent collaboration friction, analyzed via transaction cost and principal-agent theories) to macro (ecosystem-level congestion externalities). The paper references Shapley value cost allocation — a cooperative game theory method for fair cost distribution among collaborating agents — as an emerging alternative to simple metadata-tag rollup. A companion paper, "ZEBRA: Zero-Shot Budgeted Resource Allocation for LLM Orchestration" (arXiv:2605.20485), addresses the allocation side: given a fixed budget, how to distribute resources across multiple agents to maximize task performance, framed as a knapsack-style constrained optimization problem.

These remain academic rather than deployed, but they signal that the current metadata-propagation approach is recognized as insufficient for more complex delegation topologies.

## Budget Enforcement Patterns

Three distinct control patterns have emerged for preventing cost overruns in multi-agent execution:

### Pre-Flight Gating

Tokenize the full request, estimate worst-case cost (input tokens plus maximum possible output) against a static price table, and reject before the call fires if it would exceed a cap. The open-source `llm-cost-cap` library implements this per-call, but explicitly does not track cumulative spend across calls — "you need to add that accounting layer yourself if you want to enforce a session total." Pre-flight gating catches obviously expensive single calls but cannot prevent death-by-a-thousand-cuts from many small calls.

### Real-Time Metering with Kill Switches

Budget enforcement belongs "in the orchestrator, not in the agent" — the orchestrator checks before every model call. Detection heuristics include sliding-window duplicate-prompt detection (loop detection) that triggers a hard stop before the provider even charges. The kill condition can be widened beyond pure dollar cost to include token count, tool-call count, retry count, or span depth — all proxies for runaway behavior that precedes a cost explosion.

### Graceful Degradation and Model Fallback

Rather than hard-killing a task, budget pressure triggers a fallback chain: for example, from Claude Sonnet to Claude Haiku to GPT-4o-mini, with progressively shorter context windows. If no model is cheap enough, the system triggers an explicit human handoff. One practitioner frames it memorably: "a cheaper model, a shorter context, and an honest 'I should hand this to a human' instead of a small fortune in quiet retries." A subtlety: the router or orchestrator model itself needs its own fallback — degradation logic cannot assume the routing model stays available and cheap.

## The Dual-Ledger Reality

Every SDK-level cost field examined — Claude Agent SDK, OpenAI Agents SDK, AG2 — is explicitly documented as an estimate for developer visibility, with a separate authoritative Usage/Cost API as the source of truth for actual billing. This split between a fast/approximate live ledger and a slow/authoritative reconciled ledger appears to be the de facto industry pattern. No production system found in this research offers a single unified ledger that is simultaneously real-time, accurate, and authoritative.

The implication for platform builders: if you are building budget enforcement on top of SDK-reported costs, you are making enforcement decisions on estimates that may diverge from actual charges. The gap is usually small (token counts are accurate; the variance comes from pricing-table staleness or cache-state misattribution), but it exists, and any system that treats the live estimate as ground truth will eventually drift from the reconciled bill.

## The Standards Landscape

### OpenTelemetry GenAI Semantic Conventions

The closest thing to an emerging standard. The GenAI SIG (active since April 2024) defines attributes like `gen_ai.request.model`, `gen_ai.token.type`, and `gen_ai.response.completion_tokens`/`prompt_tokens`. Critically, cost itself is not a standardized emitted attribute — you compute it locally from token counts plus your own price table. Only the token-count attributes are semi-standardized. As of mid-2026, GenAI semantic conventions remain in "Development" (pre-stable) status with no public stabilization timeline.

### FinOps Foundation

The FinOps Foundation has formally extended its framework to cover AI/agent workloads. Their State of FinOps 2026 report found that 98% of organizations now manage AI spend (up from 63% in 2025 and 31% in 2024), with GPU spend now the top FinOps concern for AI-first organizations. Their prescribed pattern: showback first (4-6 weeks to find tagging gaps), then chargeback once tag coverage exceeds 80%. Notably, FinOps practitioners now treat "agent workflow" as its own cost-allocation dimension alongside traditional infrastructure — a recognition that agent-level cost attribution is a distinct problem from container or VM cost attribution.

### Observability Tooling

The landscape is fragmenting into composable layers rather than converging on a single tool: gateway/observability (Langfuse, Portkey), metering (OpenMeter), governance (Credal), and platform-native (Datadog LLM Observability at $160/month for 100K spans, billing only on LLM-provider-call spans). Helicone, previously a leading proxy-based cost-tracking tool, was acquired by Mintlify in March 2026 and is now in maintenance-only mode — a cautionary data point about vendor risk in this rapidly consolidating space.

## Failure Modes: What Happens Without a Ledger

The case for unified cost ledgers is best made by examining what happens without them:

- **The $47,000 recursive loop**: A multi-agent research tool had two of its four agents lock into a clarification/verification exchange loop "thousands of times, around the clock" for 11 days before detection. The detection method was a human opening an invoice — not any automated monitor, dashboard, or cost alert.

- **The $4,200 weekend**: A developer left an agent running unattended over a long weekend with no budget cap. The total was discovered on Monday morning.

- **The $1.3 million month**: Approximately 100 concurrent Codex-style instances generated over 603 billion tokens and 7.6 million requests over 30 days. This may be the largest publicly disclosed individual agent cost figure.

- **Replit's margin collapse**: Replit's gross margin reportedly fell from 36% to -14% as its AI agent product consumed more model compute than its pricing model captured — a business-model-level failure of cost/pricing alignment, not just a single-incident overrun.

The common root cause across all documented cases: absence of automated real-time monitoring and kill-switches. Every horror story was discovered via manual invoice review, not a ledger system. This reinforces the core finding: unified real-time cost ledgers are more aspirational than deployed in most production systems as of mid-2026.

## Implications for Agent Platform Builders

For teams building multi-agent platforms today, several practical patterns emerge from this survey:

1. **Start with metadata propagation, not a custom ledger.** Stamp every LLM call and tool invocation with a run ID, agent ID, and user ID. Aggregate after the fact using your observability stack. This is unglamorous but it is what actually works at scale today.

2. **Separate the live estimate from the authoritative bill.** Build budget enforcement on the fast/approximate ledger but reconcile against the provider's authoritative usage API daily. Alert on drift.

3. **Build the kill switch before the credit model.** Loop detection (sliding-window duplicate prompts), span-depth limits, and total-token-count ceilings prevent the catastrophic failures. The credit abstraction can come later.

4. **If you build a credit unit, keep the conversion formula internal.** Every vendor that ships a credit model (ACU, Manus credits) keeps the conversion opaque. This is not just commercial strategy — it is operational necessity, because the underlying cost mix changes as models and infrastructure evolve.

5. **Watch OpenTelemetry GenAI conventions.** They are pre-stable but represent the most likely path to cross-vendor cost-attribute standardization. Building on their attribute naming now reduces future migration cost.

6. **Budget for the attribution gap.** No production SDK today auto-attributes cost to individual sub-agents in a delegation chain. If your product requires per-tenant or per-task cost attribution in a multi-agent system, you are building that layer yourself. Plan accordingly.

---

*Sources:*

1. *Anthropic, "Track cost and usage" — Claude Agent SDK docs (2026)*
2. *GitHub, anthropics/claude-code Issue #22625 — Per-Subagent Token Usage Tracking (2026)*
3. *OpenAI, "Usage — OpenAI Agents SDK" (2026)*
4. *AG2 docs, "Usage tracking with AG2" (2026)*
5. *AWS ML Blog, "Introducing granular cost attribution for Amazon Bedrock" (2026)*
6. *AWS, "Track Amazon Bedrock Costs by Caller Identity with IAM-Based Cost Allocation" (2026)*
7. *AWS ML Blog, "Manage multi-tenant Amazon Bedrock costs using application inference profiles" (2026)*
8. *arXiv:2605.09104, "Token Economics for LLM Agents: A Dual-View Study" (2026)*
9. *arXiv:2605.20485, "ZEBRA: Zero-Shot Budgeted Resource Allocation for LLM Orchestration" (2026)*
10. *OpenTelemetry, GenAI Semantic Conventions Registry (2026)*
11. *Braintrust, "How to track LLM costs (2026)" (2026)*
12. *Datadog, Agent Observability and LLM Cost Docs (2026)*
13. *E2B, Pricing and Billing Docs (2026)*
14. *Cognition/Devin, ACU Pricing Analysis (2026)*
15. *Manus AI, "What are credits" — manus.im/help/credits (2026)*
16. *FinOps Foundation, "Chargeback and Finance Integration" / "FinOps for AI Overview" (2026)*
17. *TechStartups, "AI Agents Horror Stories: The $47,000 Failure" (2025)*
18. *byteiota, "The $500M AI Bill: How Agentic Loops Break Enterprise Budgets" (2026)*
19. *Google Developers Blog, "Announcing the Agent2Agent Protocol (A2A)" (2026)*
20. *GitHub, MukundaKatta/llm-cost-cap (2026)*
21. *pricepertoken.com, "AI Image Model Pricing" (2026)*
22. *Modal pricing via Blaxel comparison guide (2026)*
