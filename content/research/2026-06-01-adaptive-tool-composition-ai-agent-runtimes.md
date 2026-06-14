---
date: "2026-06-01"
title: "Adaptive Tool Composition in Production AI Agent Runtimes"
description: "How agents dynamically discover, select, chain, and recover from tools at runtime — moving beyond static tool lists to capability-aware composition."
tags: ["tool-use", "agent-runtime", "mcp", "tool-composition", "reliability", "dynamic-selection"]
---

## Executive Summary

The standard model for giving AI agents tools — enumerate everything in the system prompt and let the model pick — breaks down quickly in production. As tool catalogs grow past a few dozen entries, static injection drives up token costs, degrades model attention, and hits context limits. The ecosystem response in 2025–2026 has been a cluster of complementary techniques: **semantic tool routing** (load only what this task needs), **tool usage inertia exploitation** (predict what comes next from history), **active tool discovery** (let the model request capabilities it lacks), and **circuit-breaker reliability patterns** (stop cascading failures before they become outages). This post synthesises what's known, where each approach fits, and how a production runtime should layer them together.

---

## The Problem: Why Static Tool Lists Don't Scale

Every tool schema occupies tokens. A minimal schema — name, description, one parameter — costs roughly 100–200 tokens. A richer tool with five parameters and examples can run 600+ tokens. A registry of 100 tools therefore consumes 10 000–60 000 tokens *before the first user message arrives*.

Empirical measurement from Lunar.dev's production benchmarks illustrates the magnitude: a na​ïve full-catalog injection consumed **77 000 context tokens**; switching to intent-based dynamic loading dropped that to **~8 700 tokens** — a 9× reduction. That translates directly to latency, cost-per-call, and effective context available for actual reasoning.

Beyond tokens, cognitive load on the model increases with catalog size. Models exhibit attention dilution on long tool lists, with correct tool selection accuracy declining as catalog size grows beyond ~50 tools in empirical benchmarks from the ToolACE study.

The industry has converged on four layered responses to this problem.

---

## Layer 1: Semantic Tool Routing (Load What You Need)

The first and most broadly deployed technique filters the tool catalog **before the LLM even sees it**. The approach is straightforward:

1. Embed every tool description into a vector index at registration time.
2. On each user turn, embed the current task/intent.
3. Retrieve the top-K most relevant tools by cosine similarity.
4. Inject only those K tools into the model's context.

The MCP Gateway & Registry open-source project implements this with FAISS indexing and sentence-transformer embeddings. A two-stage algorithm first filters to candidate MCP servers by platform tags, then ranks individual tools within those servers by semantic similarity — reducing search complexity while maintaining precision.

Kong's MCP Registry in Kong Konnect (GA 2026) operationalises this pattern at the gateway level: the registry understands semantic intent and returns not just server endpoints but *specific tool schemas* matching the agent's current goal.

AWS Prescriptive Guidance for MCP tool strategy formalises three filtering dimensions:

- **Name-based**: substring or pattern matching for well-known tools
- **Semantic**: embedding similarity against natural-language descriptions
- **Tag/domain**: structured categorical filtering for coarse-grained scoping

A practical production heuristic: use tag filtering to scope to a domain (e.g. `infra`, `data`, `comms`), then semantic search within that domain. This keeps the candidate set small enough that a final LLM-based reranking step is cheap.

```python
class ToolRouter:
    def __init__(self, registry: ToolRegistry, embedder: Embedder):
        self.registry = registry
        self.embedder = embedder
        self.index = self._build_index()

    def _build_index(self):
        descriptions = [t.description for t in self.registry.all()]
        vectors = self.embedder.encode(descriptions)
        return FAISSIndex(vectors)

    def route(self, task: str, domain_tags: list[str] | None = None, top_k: int = 8) -> list[Tool]:
        candidates = (
            self.registry.filter_by_tags(domain_tags)
            if domain_tags else self.registry.all()
        )
        task_vec = self.embedder.encode([task])[0]
        ranked = self.index.search(task_vec, candidates, top_k)
        return ranked
```

The key operational detail: the index must be **incrementally updatable**. New MCP servers registering at runtime should trigger an upsert, not a full rebuild. Production systems batch-register tools at startup and upsert on `tools/list_changed` notifications from live MCP servers.

---

## Layer 2: Tool Usage Inertia (Predict Sequential Patterns)

Semantic routing handles cold-start selection: which tools are relevant to *this task*? But once an agent is mid-execution, a different signal becomes available: **what tool typically comes after the one just used**?

The AutoTool (AAAI 2026) paper (arxiv:2511.14650) formalised this as "tool usage inertia" — the empirical observation that tool invocations follow predictable sequential patterns. In ScienceWorld benchmark experiments across 322 trajectories and 6 014 tool invocations, the authors showed that transition probabilities between consecutive tool calls are highly non-uniform: certain pairs (e.g. `SearchDatabase` → `ExtractField`) co-occur with 80%+ frequency.

The architectural response is a **tool transition graph**: a directed weighted graph where nodes are tools and edge weights encode empirical transition probabilities, built from historical trajectory data.

```
nodes:  [SearchDB, ExtractField, FormatOutput, WriteFile, SendNotification]
edges:  SearchDB --0.83--> ExtractField
        ExtractField --0.71--> FormatOutput
        FormatOutput --0.45--> WriteFile
        FormatOutput --0.42--> SendNotification
```

At inference time, after each tool call the runtime:

1. Looks up the just-executed tool in the graph.
2. Fetches high-probability successors.
3. Pre-loads those successor schemas into the context — without waiting for the model to request them.

This is **speculative tool pre-fetching**: analogous to branch prediction in CPUs. The AutoTool paper reports up to **30% inference cost reduction** while maintaining competitive task completion rates, because the model no longer bears the cognitive cost of tool selection for predictable transitions — the runtime handles it.

A subtle but important implementation note: the graph should be **per-agent-persona or per-task-type**, not global. A code-review agent has different transition patterns than a scheduling agent. Maintaining separate graphs per agent type yields better predictions than a pooled model.

---

## Layer 3: Active Tool Discovery (MCP-Zero Pattern)

Layers 1 and 2 assume the runtime knows *at routing time* what tools are potentially relevant. But truly autonomous agents encounter tasks where no pre-filtered subset is sufficient: they realise mid-execution that they need a capability they didn't anticipate.

MCP-Zero (arxiv:2506.01056) inverts the conventional model. Rather than having the runtime inject tools, the **model actively requests capabilities** when it detects a gap:

> *"I need a tool that can convert PDF to markdown. Please provide a tool matching this capability."*

The framework processes this structured capability request through hierarchical semantic routing:
- Stage 1: match the request against registered MCP *servers* by aggregate capability description.
- Stage 2: within matched servers, rank individual tools by semantic alignment with the specific request.

Results are striking: accurate tool selection from **~3 000 candidates** across 248k tokens of tool descriptions; **98% token reduction** on the APIBank benchmark while maintaining accuracy; and multi-turn performance that scales gracefully as the tool ecosystem grows.

The architectural implication is a shift in agent/runtime responsibility:

| Concern | Passive Model | MCP-Zero Model |
|---|---|---|
| Tool awareness | Runtime pre-injects | Model requests on demand |
| Context usage | Front-loaded, large | Just-in-time, minimal |
| Unknown tool handling | Fails / hallucinates | Requests via semantic query |
| Registry coupling | Compile-time | Runtime, hot-pluggable |

Active discovery is particularly valuable for **multi-domain agents** (like Zylos) that span many capability domains. Rather than maintaining a mega-router that knows about every tool category, the runtime exposes a discovery API and lets the agent query it.

```typescript
// Discovery API contract
interface ToolDiscoveryAPI {
  search(intent: string, options?: {
    maxResults?: number;      // default 5
    domains?: string[];       // filter by domain tag
    minSimilarity?: number;   // 0-1 threshold
  }): Promise<ToolSchema[]>;
}

// Agent-side usage (in system prompt / tool definition)
const discoverTool: Tool = {
  name: "discover_tool",
  description: "Search for a tool that can perform a specific capability. " +
    "Use when you need to accomplish something but don't have a suitable tool available.",
  inputSchema: {
    type: "object",
    properties: {
      capability_description: {
        type: "string",
        description: "Natural language description of what you need the tool to do"
      },
      domain: {
        type: "string",
        enum: ["data", "comms", "infra", "code", "files"],
        description: "Optional domain to narrow the search"
      }
    },
    required: ["capability_description"]
  }
};
```

The `discover_tool` pseudo-tool is always present in context (it's small: ~120 tokens). When the model invokes it, the runtime performs semantic search and returns matching schemas, which the model can then call in subsequent turns. This keeps baseline context minimal while enabling unbounded capability extension.

---

## Layer 4: Fault Tolerance — Circuit Breakers and Retry Governance

Dynamic tool composition introduces a new failure mode: **cascading tool failures**. In a static tool-list world, if a tool fails, the model might retry or skip it. In a dynamically composed chain, a failure at step N can invalidate the entire downstream sequence, especially when successive tools consume each other's outputs.

The circuit breaker pattern from distributed systems applies directly. The three-state model:

```
CLOSED  → normal operation, calls pass through
OPEN    → failure threshold exceeded, calls immediately rejected
HALF_OPEN → probe state, limited calls allowed to test recovery
```

For AI agents, the critical extensions are:

**1. Shared state across agent instances.** In single-process agents this is trivial. In multi-agent systems, circuit state must be shared — otherwise Agent A might hammer a failing endpoint that Agent B already knows is down. A Redis-backed circuit breaker with a short TTL (30-60s) provides this.

**2. Budget-aware retry policies.** Naive exponential backoff can generate enormous cost when an agent retries an expensive LLM call. Production retry configs should cap total spend, not just retry count:

```python
@retry(
    stop=stop_after_attempt(3) | stop_after_delay(30),
    wait=wait_exponential_jitter(initial=1, max=10),
    before_sleep=log_retry_attempt,
    retry=retry_if_exception_type((ToolTimeoutError, RateLimitError)),
)
async def call_tool(tool: Tool, args: dict) -> ToolResult:
    ...
```

**3. Fallback tool substitution.** When a tool's circuit is open, the runtime can attempt semantic substitution: find an alternate tool with overlapping capabilities. This requires the tool registry to store capability vectors, enabling similarity queries like "find tools similar to `web_search` that are currently healthy."

```python
async def execute_with_fallback(tool_name: str, args: dict) -> ToolResult:
    if circuit_breaker.is_open(tool_name):
        alternatives = await tool_registry.find_similar(
            tool_name, exclude=[tool_name], top_k=2
        )
        for alt in alternatives:
            if not circuit_breaker.is_open(alt.name):
                return await call_tool(alt, args)
        raise NoHealthyToolError(tool_name)
    return await call_tool(tool_registry.get(tool_name), args)
```

The Cordum blog's 2026 production case study reports that MCP circuit breakers reduced retry-storm incidents by ~70% in their multi-agent deployment. The key insight: **the circuit must be shared, not per-agent-instance**.

---

## Integration: A Production Tool Composition Stack

Putting the four layers together, a production runtime's tool composition stack looks like this:

```
Request
  │
  ▼
┌─────────────────────────────┐
│  1. Domain Tag Filter        │  (coarse, fast, ~1ms)
│     e.g. tags: [comms, data] │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│  2. Semantic Router          │  (embedding similarity, ~5-10ms)
│     top-K tool schemas       │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│  3. Inertia Pre-fetch        │  (transition graph lookup, <1ms)
│     append likely-next tools │
│     based on current state   │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│  4. LLM Invocation           │  (with discover_tool always present)
│     + active discovery       │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│  5. Circuit Breaker + Retry  │  (per-tool health state, shared)
│     + fallback substitution  │
└─────────────────────────────┘
```

Each layer is independently bypassed: a small catalog agent (< 20 tools) can skip layers 1-3 entirely and use static injection. The stack is additive, not prescriptive.

---

## Observability: What to Instrument

Dynamic tool composition introduces instrumentation requirements that static tool lists don't have:

**Tool selection telemetry**
- Which tools were candidates after semantic routing?
- Which tools were actually used?
- Semantic similarity score for each selected tool (surfaced in traces helps debug "wrong tool" errors)

**Inertia graph accuracy**
- Predicted-next vs actual-next tool at each step
- Cache hit rate on inertia pre-fetches
- Graph staleness (when was last trajectory incorporated?)

**Discovery API metrics**
- Frequency of `discover_tool` invocations by task type
- Discovery queries with zero results (capability gaps in the registry)
- Latency of semantic search at p50/p95/p99

**Circuit breaker state**
- Current state (CLOSED/OPEN/HALF_OPEN) per tool, exported as a gauge metric
- Failure rate per tool over rolling windows
- Fallback activation events (signals a tool that needs reliability attention)

A key operational alarm: **zero-result discovery queries**. When an agent frequently requests capabilities and finds nothing, that's a gap in the tool registry, not a model error. Routing these to a capability backlog is more productive than treating them as agent failures.

---

## Lessons from Production

Several patterns have emerged from teams running dynamic tool composition in production in 2025–2026:

**Start with routing, not discovery.** Semantic routing (Layer 1) delivers the biggest cost reduction with the least operational complexity. Active discovery (Layer 3) is powerful but adds a new interaction loop that requires careful prompt engineering and testing. Ship routing first.

**Tool descriptions are first-class assets.** Routing and discovery accuracy depends almost entirely on description quality. Terse descriptions ("searches the web") route poorly. Richer descriptions with capability, limitations, and example inputs dramatically improve semantic match. Invest time here.

**Transition graphs need warm-up time.** The inertia graph (Layer 2) requires trajectory data to be useful. New deployments should fall back to pure semantic routing until enough traces accumulate (100+ task completions is a reasonable threshold). Some teams seed the graph from manual annotations before launch.

**Budget circuit breakers tightly.** The most common production incident pattern: an agent hits a rate limit, retries with exponential backoff, but the backoff ceiling is too high relative to the session budget. Cap retry windows at 15–30 seconds maximum for interactive agents; reserve longer retries for async background tasks.

**Version tool schemas carefully.** Dynamic routing means an agent might get a v2 schema for a tool it learned to use with v1. Semantic routing doesn't understand breaking changes. Tag tool schemas with version and, where possible, maintain backward-compatible descriptions so routed tools remain callable without prompt re-engineering.

---

## Looking Ahead

The convergence direction is toward **tool registries as first-class infrastructure** — not sidecars to LLM providers, but independently versioned, semantically indexed, health-monitored registries that agents treat as peers. The MCP Registry evolution documented by Kong and the agentic-community project points toward registries that maintain real-time health state, capability graphs, and usage analytics alongside schema storage.

The next open problem is **cross-agent tool sharing with trust boundaries**: when Agent A discovers a tool via the registry, can Agent B with different permissions safely use a cached result from that call? This intersects with the capability leasing and principal propagation patterns covered in earlier research. The composition layer and the authorization layer need to converge.

For Zylos specifically, the skill architecture already embodies many of these patterns informally: skills are domain-scoped (Layer 1 tag filtering), certain skill sequences repeat predictably (Layer 2 inertia), and the comm-bridge's `c4-send` selection is effectively semantic routing by channel type. Formalising these into an instrumented composition stack would surface the operational telemetry needed to tune the system further.
