---
date: "2026-06-07"
title: "Cross-Instance State Aggregation for Autonomous Agent Fleets: Data-Plane Patterns for Real-Time Multi-Agent Dashboards"
description: "A design memo covering the aggregation data plane for multi-agent dashboards: pull vs push transport, scoped auth, staleness semantics, service discovery, and topology choices — grounded in Prometheus, Kubernetes, OTel, and Consul precedents."
tags: ["multi-agent", "observability", "distributed-systems", "ai-agents", "architecture"]
---

## Executive Summary

When you operate a fleet of autonomous AI agents — each running its own local state, dashboard, and read API — you need an aggregation layer that can pull together live status from N agents and present it as a coherent view. This document is about the **data plane** for that aggregation: how state flows from agents to the hub, not which metrics to display.

The core design decisions are:

1. **Transport model** — periodic pull vs. streaming push, and the latency/connection-count trade-offs between them
2. **Uniform endpoint model** — treating every agent as a network endpoint rather than special-casing co-located instances
3. **Scoped authentication** — short-lived read tokens exchanged from long-lived keys, so the observation plane carries least-privilege credentials
4. **Staleness as first-class state** — distinguishing "agent idle", "agent unreachable", and "aggregator partitioned" at the data model level
5. **Topology choice** — embedded hub vs. standalone aggregator service (a packaging question, not an architectural one)

Real systems — Prometheus federation, Kubernetes list-watch/informers, OpenTelemetry Collector fan-in, Consul/Serf gossip — have each solved pieces of this puzzle. The patterns are well-established; the novelty for AI-agent fleets is that the state schema differs (context-window %, token cost, active tool, runtime heterogeneity) and the fleet sizes are currently small enough that simpler designs dominate.

---

## The Core Problem

A hub instance needs to present the live state of N agents. Each agent exposes a read API at some network address. The hub must:

- Collect current state from all agents
- Detect agents that are down, unreachable, or idle
- Serve a dashboard that reflects reality as closely as tolerable staleness allows
- Remain useful even when individual agents or the hub itself are temporarily unavailable

The naive solution — polling each agent on a fixed interval — works fine at small N. The interesting design decisions appear as N grows, as agents run across separate machines, or as you want sub-second freshness.

---

## Pull vs Push: Transport Trade-offs

### The Pull Model

The canonical pull model is Prometheus's scrape architecture. Each target exposes a `/metrics` endpoint; the Prometheus server scrapes each target at a configured interval (default 15s, commonly tuned to 5–30s). For fleet aggregation, a global Prometheus can federate from per-cluster leaf instances by scraping their `/federate` endpoints, selecting only the high-level time series it needs.

Pull's key properties:

- **Aggregator controls the schedule.** If an agent is slow or overwhelmed, the aggregator can back off without the agent needing to implement backpressure.
- **No persistent connection.** Each scrape is a short HTTP GET. The aggregator can scrape N agents with N short-lived connections, then idle. Memory and connection-table footprint on the aggregator is predictable.
- **Dead-simple agent side.** Each agent only needs to serve one endpoint. No keep-alive socket management, no reconnect logic.
- **Latency floor = interval.** You cannot know an agent's state more freshly than the last scrape interval. For a 15s interval, worst-case staleness is 15s.

Pull becomes strained when:
- N is large and scrape latency varies (scrape timeouts accumulate)
- You want sub-second freshness (very short intervals cause thundering-herd on small agents)
- Agents run behind NAT or a firewall that blocks inbound connections to the agent

Prometheus's push gateway solves the NAT/firewall case: agents push to an intermediary that the Prometheus server can reach. Weaveworks and Zapier both maintain aggregating push gateway variants that merge pushes from multiple sources before Prometheus scrapes them.

### The Push / Streaming Model

Push models — SSE (Server-Sent Events) or WebSocket — invert the flow: each agent maintains a persistent connection to the aggregator and streams state changes as they happen.

**SSE fan-in** is the simpler choice for unidirectional state streams (agent → hub). SSE is HTTP/1.1-compatible, passes through most CDN and reverse-proxy layers without special configuration (Fastly, Cloudflare, nginx all handle it), and provides automatic reconnect with `Last-Event-ID` semantics baked into the browser spec. Timeplus benchmarks show SSE and WebSocket have roughly equivalent throughput and latency (3ms difference) for typical dashboard payloads; the framing overhead is irrelevant compared to JSON serialization and network RTT.

**WebSocket fan-in** is appropriate when agents and the hub need bidirectional communication — but for a read-only observation plane this is unnecessary complexity. WebSocket also requires sticky-session affinity when load-balancing across multiple aggregator instances, whereas SSE reconnects can land on any instance if state is backed by a shared store.

**Backpressure** is the primary operational risk in push models. If the aggregator is slow to consume (CPU spike, GC pause, downstream write stall), a fast-pushing agent will exhaust its send buffer. Proper mitigation is:
1. Bounded per-agent write buffers on the aggregator side
2. A drop-newest or drop-oldest policy when the buffer fills
3. The agent detects a slow consumer via socket write errors and falls back to a reduced push rate

The FastAPI/asyncio WebSocket community has documented this clearly: "If you design for fan-out from day one — through sharding, hierarchy, backpressure, and broadcast control — you gain predictability."

### Hybrid: Push with Poll Fallback

The most resilient design is push-primary with polling as degraded mode:

1. Each agent tries to establish a persistent SSE connection to the aggregator on startup
2. If the aggregator is unreachable, the agent buffers locally (bounded) and retries with exponential backoff
3. The aggregator also runs a background poller for agents that never established a push channel (e.g., older agent version, firewall issue)
4. The dashboard shows which transport each agent is using as a secondary status signal

This mirrors what the Kubernetes informer mechanism does: it starts with a `list` (full snapshot via poll) and then transitions to `watch` (persistent streaming). If the watch stream breaks, it falls back to re-list. The `resourceVersion` field prevents missing events during the gap. A fleet aggregator can implement the same pattern using a monotonic `sequenceId` per agent.

### Pull vs Push Trade-off Table

| Property | Pull (periodic poll) | Push (SSE/WS stream) |
|---|---|---|
| Freshness | Bounded by interval | Near real-time |
| Agent complexity | Minimal (serve one endpoint) | Must manage connection lifecycle |
| Aggregator connections | Short-lived, bursty | Persistent, N concurrent |
| Firewall/NAT | Aggregator must reach agent | Agent initiates outbound |
| Backpressure | Aggregator controls naturally | Explicit buffer management needed |
| Reconnect handling | Aggregator retries on failure | Agent reconnects with backoff |
| Best for | Small fleet, low-churn state | Large fleet, high-churn state |

---

## Uniform Endpoint Model

A critical simplification: **treat every agent — including co-located ones on localhost — as a network endpoint with the same shape**: `{name, base_url, scoped_read_token}`.

The temptation to special-case local agents (reading state from shared memory, a local file, or an in-process call) creates a two-code-path problem. Every local shortcut needs its own retry logic, error handling, and auth bypass. When co-located agents later move to separate machines (or when you add a remote agent), the aggregator needs surgery.

Uniformity gives you:
- **One code path** for all agents, simplifying testing and debugging
- **Isolation**: even a co-located agent that crashes cannot corrupt the aggregator's state because they communicate over a network boundary (even if it's loopback)
- **Portability**: the same aggregator binary works for all-local, all-remote, or mixed deployments

The base URL for a local agent is simply `http://127.0.0.1:<port>`. The overhead of an HTTP call to loopback is negligible compared to the simplicity gain.

This is how the Kubernetes API server and kubelet relationship works: even in single-node (kind/minikube) clusters, kubelet communicates with the API server over the same HTTPS endpoint that remote kubelets use. No special-casing.

---

## Scoped Data-Plane Auth

For an observation-only plane, you want the aggregator to hold credentials that can only **read** agent state, not issue commands or modify configuration. This is the read/admin separation that AWS IAM enforces structurally: read-only policies cannot be accidentally escalated to write.

### Two-Layer Token Architecture

Borrowing from AWS STS's AssumeRole pattern:

- **Layer 1: Long-lived API key** — stored only in the aggregator's config/secrets store. Never transmitted in individual scrape requests. Used once per session to exchange for a short-lived token.
- **Layer 2: Short-lived scoped session token** — exchanged from the API key at session start (or on TTL expiry). Scoped to `read` operations only. Transmitted in every HTTP request header.

The dual-layer design matters specifically in **plaintext or no-HTTPS environments** (e.g., a local development cluster on a trusted LAN, or agents communicating over a VPN without per-service TLS). If the session token is sniffed in transit, the attacker gets a short-lived credential that can only read dashboard state — not reconfigure or control agents. The long-lived key that could issue new tokens never travels the wire after initial exchange.

Session token TTLs of 15–60 minutes match the Prometheus scrape and OTel collector refresh cycles. Token refresh should happen proactively (refresh at 80% of TTL), not reactively (waiting for a 401 to trigger refresh), to avoid a stall on the critical path.

### Least-Privilege Scope

The read scope should be narrowly defined:
- `GET /state` — current agent snapshot
- `GET /health` — liveness and heartbeat
- `GET /metrics` — if using Prometheus exposition format

Write endpoints (`POST /command`, `PATCH /config`) must require the admin key, which the aggregator never holds. This prevents a compromised aggregator from becoming a lateral-movement pivot into agent control planes.

---

## Staleness and Liveness as First-Class State

The most common mistake in fleet dashboards is treating "no data" as the same as "agent is idle." These are distinct states that require different UI treatment and different operational responses.

### Three Distinct Absence States

| State | Meaning | Trigger |
|---|---|---|
| **Idle** | Agent is up, reachable, has no active work | Agent reports low activity; heartbeat current |
| **Unreachable** | Aggregator cannot connect; agent may be fine | Poll/push timeout, no heartbeat within TTL |
| **Offline / Down** | Agent process has exited or machine is down | No heartbeat for extended period (2–3× TTL) |

The distinction between "unreachable" and "down" matters because network partitions are common and transient. Consul's Lifeguard extension to the SWIM gossip protocol explicitly addresses this: the original protocol incorrectly declared members as faulty when CPU exhaustion or network delay caused slow message processing. Lifeguard introduced "situational awareness" — a node suspects itself is faulty before suspecting others — reducing false positives dramatically.

For a fleet aggregator, the equivalent is: before marking an agent as down, check whether other recently-healthy agents are also failing (suggests aggregator-side connectivity issue, not agent failure).

### Heartbeat TTL Design

```
                    ┌──────────────────────────────────────────┐
time →              │  heartbeat  │  heartbeat  │  heartbeat   │
                    └──────────────────────────────────────────┘
                    0            T            2T            3T

Agent state in aggregator:
  t < T+grace:     FRESH (last_seen within TTL)
  T+grace < t < 2T: STALE (show warning on card)
  t > 2T:           UNREACHABLE (show offline card)
  t > 3T:           PRESUMED DOWN (trigger alert)
```

Clock skew between machines can cause false positives. Mitigations:
1. Use the aggregator's receive timestamp, not the agent's send timestamp, for TTL calculation
2. Add a grace period equal to 2× expected clock drift (NTP-synchronized machines: 50ms; unsynchronized: up to a few seconds)
3. For the dashboard, display both the agent's reported timestamp and the aggregator's last-seen time so operators can diagnose skew

### Cached State on Agent Unavailability

The aggregator should serve the **last known state** for an unreachable agent rather than an error. The UI overlays a "stale" badge with the age of the data. This is the same pattern Redis uses for read-from-replica with `slave-serve-stale-data yes`: return possibly-stale data rather than an error, but annotate it. Returning an error from the dashboard when one of N agents is down makes the dashboard unreliable precisely when operators need it most.

---

## Service Registry and Discovery

For a fleet dashboard, discovery is how the aggregator learns which agents exist and where they are.

### Static Registry

The simplest: a YAML/JSON config file listing `{name, base_url, token_hint}` for each agent. The aggregator loads it at startup (and watches for file changes).

**Appropriate when**: fleet size is small (2–20 agents), agents are long-running on known addresses, and operational simplicity is the priority. This covers most current AI-agent fleet deployments. Static registry has zero runtime dependencies: no Consul, no etcd, no DNS-SD.

### Self-Registration

Each agent, on startup, registers itself with the aggregator by calling `POST /registry/agents`. On shutdown (or via a health-check timeout), it deregisters.

**Trade-off**: couples agent code to the aggregator's registration API. Also requires the aggregator to be up before agents start — or agents need retry logic. The Kubernetes service registry pattern avoids this by making registration a kubelet/controller responsibility, not the application's.

**Appropriate when**: agents are ephemeral (spin up/down frequently), addresses are dynamic (container IPs), or fleet size exceeds ~50 where manual config is error-prone.

### External Discovery

DNS-SD, Consul catalog, or Kubernetes Service/Endpoint resources. The aggregator queries an external registry to enumerate agents; agents register with that registry, not directly with the aggregator.

**Appropriate when**: you already run Consul or Kubernetes for other purposes and want to avoid a parallel registry. Adds operational complexity for small fleets with no other orchestrator.

### Recommendation by Fleet Size

| Fleet Size | Recommended Approach |
|---|---|
| 2–10 agents | Static config file |
| 10–50 agents | Static config + file-watch for hot reload |
| 50+ agents | Self-registration or external discovery |

---

## Topology: Embedded Hub vs. Standalone Aggregator

Two packaging options for the aggregation logic:

**Embedded hub**: the aggregation logic lives inside one existing agent's process. That agent serves both its own dashboard and a "fleet view" that aggregates peers. This is convenient for small fleets where one agent is naturally "primary."

**Standalone aggregator service**: a dedicated process whose sole job is aggregation. It has no agent logic of its own.

The key insight: **the aggregation logic is identical in both cases**. The same polling/streaming engine, the same state model, the same auth layer. The choice is purely packaging and deployment:

- Embedded hub is simpler to deploy (one fewer process), but couples the fleet view to one agent's availability. If that agent restarts, the fleet view is temporarily unavailable.
- Standalone aggregator decouples fleet visibility from individual agent health. It can be deployed on a management machine that has no other agent responsibilities.

**Graceful degradation** applies to both: if the aggregator (embedded or standalone) is unreachable, individual agents continue operating normally. The aggregation plane is observation-only; agents are not dependent on it for their own functioning. This is a hard requirement — the aggregator must never be on the critical path for agent operation.

If the aggregator goes down, individual agent dashboards remain accessible directly via their own local UI. The fleet view just goes blank until the aggregator recovers.

---

## Consistency Model: Best-Effort Observation

This data plane is **eventually consistent and best-effort**. It is explicitly not a control plane, not a source of truth, and not a transactional system.

Implications:

- **No consensus required.** The aggregator does not need quorum. It can serve its last known view from a single instance.
- **Partial views are acceptable.** A fleet dashboard showing 7/8 agents is more useful than showing nothing while waiting for the 8th. The UI should clearly indicate which agent is missing and why.
- **Idempotent updates.** State pushes from agents should be full snapshots, not deltas, so that a missed push doesn't leave the aggregator in a permanently inconsistent state. (Alternatively, deltas with sequence numbers and periodic snapshot resets, as Kubernetes does with list-watch.)
- **No transactions across agents.** The aggregator never needs to present an "atomic" view of all agents at the same logical time. Each agent's state is independently timestamped.

This model aligns with how Datadog and SigNoz instrument LLM applications: they collect spans and metrics from each agent independently, aggregate asynchronously, and display dashboards that may lag by seconds. The display is informational, not authoritative.

---

## AI-Agent Fleet State: What's Different

Traditional service metrics (CPU %, request rate, error rate) are well-understood. LLM-agent state introduces several novel dimensions:

### Context Window Exhaustion

Context window fill percentage is a **non-renewable resource per session**. Unlike memory (which can be freed), once context is consumed, the only recovery is a new session. This means:
- The aggregator should display context fill as a prominent, color-coded signal (green → yellow → red)
- Trend matters: an agent at 60% context that is filling at 5%/minute needs attention sooner than one at 80% that has been stable for an hour
- Context exhaustion is silent — the agent doesn't error, it just starts forgetting. The aggregator is often the only place this is visible across the fleet

### Token Cost as a First-Class Signal

Unlike CPU (which scales with cloud provider pricing), token cost is a direct, real-time billing signal. The aggregator should accumulate:
- Tokens in/out per agent per session
- Estimated cost (input tokens × input price + output tokens × output price, per model)
- Cumulative cost across the fleet for the current billing period

Platforms like Datadog LLM Observability, LangSmith, and Langfuse have converged on this as a required metric. A 2025 Mavvrik study found 50% of AI-core companies don't track LLM API costs at all — fleet aggregation is an opportunity to surface this by default.

### Runtime Heterogeneity

A fleet may mix Claude (Anthropic API), Codex (OpenAI API), and local models (Ollama). Each has:
- Different context window sizes (Claude 3.5 Sonnet: 200k tokens; GPT-4o: 128k; local Llama 3: 8k–128k depending on quantization)
- Different pricing models
- Different rate limits (TPM/RPM per API key)

The aggregator's state schema must be model-aware. The context window fill % must be calculated relative to the specific model's limit, not a global constant. Rate limit headroom is a per-API-key concern, not a per-agent one, if multiple agents share a key.

### Active Tool as State

LLM agents typically spend significant time in tool calls (bash, file read, web search). The currently active tool is valuable fleet-level signal:
- An agent that has been in `bash` for 10 minutes may be stuck in a long-running command or an infinite loop
- An agent in `WebSearch` for >2 minutes may be hitting a rate limit
- Aggregated tool distribution across the fleet reveals what the fleet is collectively doing

Traditional APM has nothing equivalent to this. It maps loosely to distributed tracing's active span concept (the OTel collector fan-in model can carry this as a trace attribute), but the semantics are specific to LLM agents.

---

## Practical Recommendations

### What to Build for an MVP

1. **Static registry**: a YAML file listing each agent's `{name, url, token}`. Aggregator reads it on startup.
2. **Pull model with 5–10s interval**: one goroutine/async task per agent, simple HTTP GET to `/state`. No persistent connections to manage.
3. **Short-lived session tokens**: each agent issues read tokens via `POST /auth/session` (input: long-lived key, output: 30-minute read token). Aggregator refreshes proactively.
4. **Three-state liveness model**: FRESH / STALE / UNREACHABLE based on last-seen TTL. Serve last-known-state for stale/unreachable agents with visual annotation.
5. **Uniform endpoint model from day one**: even for localhost agents. No special cases.

This is enough for a working fleet dashboard. The pull model with a handful of agents is operationally trivial and has zero persistent connection state to manage.

### What to Defer

- **Push/streaming transport**: only worth the complexity when you need sub-second freshness or the fleet exceeds ~30 agents where poll latency accumulates
- **Self-registration / dynamic discovery**: unnecessary until agent addresses change frequently or fleet size exceeds ~20
- **Standalone aggregator service**: consider this when the embedded hub's restarts cause noticeable fleet-view gaps, not before
- **Distributed aggregator (HA aggregator cluster)**: the aggregator is observation-only; a brief gap during a restart is acceptable. Full HA adds significant complexity for minimal operational gain at small scale
- **Full OTel pipeline integration**: valuable for connecting fleet state to your existing observability stack, but adds an OTel Collector dependency that is overhead for a self-contained fleet

### Implementation Checklist

- [ ] All agents expose `GET /state` and `GET /health` on a configured port
- [ ] Auth: agents issue short-lived read tokens; aggregator never stores or uses long-lived keys in per-request headers
- [ ] State schema includes: `{agent_id, timestamp, context_pct, tokens_in, tokens_out, cost_usd, model, runtime, active_tool, status}`
- [ ] Aggregator state model distinguishes FRESH / STALE / UNREACHABLE; UI shows last-known state with age badge
- [ ] Aggregator is not on the critical path for any agent's operation
- [ ] Dashboard shows per-agent last-seen time and transport type (for diagnosing connectivity issues)

---

## Conclusion

Cross-instance state aggregation for agent fleets is a well-solved problem in distributed systems observability — the patterns from Prometheus federation, Kubernetes list-watch, OTel Collector, and Consul gossip each contribute a piece. The challenge for AI-agent fleets is applying the right pattern at the right scale: most current deployments are small enough that a pull model with static registry and three-state liveness is entirely sufficient, and the complexity of streaming fan-in or dynamic service discovery is premature.

The genuine novelty is in the **state schema**: context window exhaustion, real-time token cost, and active tool state are LLM-specific signals with no direct analogue in traditional service observability. Getting the data plane right enables these signals to be surfaced clearly — but the data plane itself is infrastructure, and it should be boring.

---

*Sources:*
- *[Prometheus Federation](https://prometheus.io/docs/prometheus/latest/federation/) — Official Prometheus docs on hierarchical federation*
- *[Prometheus Federation Architecture & Pitfalls](https://www.groundcover.com/learn/observability/prometheus-federation) — Groundcover*
- *[Kubernetes Informers Deep Dive](https://arriqaaq.substack.com/p/kubernetes-informers) — Arriqaaq*
- *[Kubernetes ListWatch Anatomy](https://www.mgasch.com/2021/01/listwatch-prologue/) — mgasch.com*
- *[OpenTelemetry Collector Architecture](https://opentelemetry.io/docs/collector/architecture/) — OpenTelemetry official docs*
- *[WebSockets vs SSE](https://ably.com/blog/websockets-vs-sse) — Ably*
- *[WebSocket vs SSE Performance Comparison](https://www.timeplus.com/post/websocket-vs-sse) — Timeplus*
- *[Backpressure in WebSocket Streams](https://skylinecodes.substack.com/p/backpressure-in-websocket-streams) — Skyline Codes*
- *[Consul Gossip Protocol](https://developer.hashicorp.com/consul/docs/architecture/gossip) — HashiCorp*
- *[Making Gossip More Robust with Lifeguard](https://www.hashicorp.com/en/blog/making-gossip-more-robust-with-lifeguard) — HashiCorp*
- *[AWS STS Temporary Credentials](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp.html) — AWS IAM docs*
- *[Heartbeats in Distributed Systems](https://arpitbhayani.me/blogs/heartbeats-in-distributed-systems/) — Arpit Bhayani*
- *[Service Discovery in Microservices](https://www.baeldung.com/cs/service-discovery-microservices) — Baeldung*
- *[Datadog LLM Observability](https://docs.datadoghq.com/llm_observability/) — Datadog*
- *[LLM Cost Tracking](https://www.traceloop.com/blog/from-bills-to-budgets-how-to-track-llm-token-usage-and-cost-per-user) — Traceloop*
