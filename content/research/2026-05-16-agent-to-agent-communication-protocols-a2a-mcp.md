---
date: "2026-05-16"
title: "Agent-to-Agent Communication Protocols: A2A, MCP, and Multi-Agent Orchestration"
description: "Deep dive into Google's A2A protocol, its relationship with MCP, and production patterns for inter-agent communication in enterprise AI systems"
tags:
  - a2a
  - mcp
  - multi-agent
  - protocol
  - agent-communication
  - google
---

## Executive Summary

The shift from single-agent AI systems to collaborative multi-agent architectures is creating demand for standardized communication protocols — the same way the web needed HTTP and TCP/IP before it could scale. Two protocols now define the emerging agent interoperability stack: Anthropic's **Model Context Protocol (MCP)**, which standardizes how individual agents connect to tools and data sources, and Google's **Agent2Agent (A2A) protocol**, which standardizes how agents discover, delegate to, and collaborate with each other. Together they address different layers of the agent communication problem.

A2A was announced by Google in April 2025 with backing from 50+ enterprise partners, contributed to the Linux Foundation in June 2025, and reached v1.0 in early 2026. As of mid-2026, 150+ organizations — including AWS, Microsoft, Salesforce, SAP, IBM, and ServiceNow — have adopted it in production. The GitHub repository has surpassed 22,000 stars, with production-ready SDKs in Python, JavaScript, Java, Go, and .NET.

This article examines the full technical picture: A2A's architecture and wire protocol, how it compares and integrates with MCP, alternative multi-agent communication approaches (AutoGen, CrewAI, LangGraph, custom WebSocket protocols), and the hard production challenges around authentication, service discovery, observability, and security that the spec intentionally leaves for implementers to solve.

---

## The Problem: Why Inter-Agent Communication Needs Standardization

Before A2A and MCP, multi-agent systems suffered from the same N×M integration problem that plagued API ecosystems before REST. Each agent framework had its own calling conventions, serialization formats, and handshake patterns. A LangGraph orchestrator couldn't natively delegate to a CrewAI specialist agent; an Agentforce workflow couldn't call a custom Python agent without bespoke glue code.

The result: most "multi-agent" systems were actually single-framework systems. True heterogeneous collaboration required custom middleware maintained by the team building the system, meaning vendor lock-in was the path of least resistance.

A2A and MCP together define a two-layer solution:

- **MCP (vertical integration):** Standardizes how an agent connects to tools, APIs, databases, and memory stores. One protocol for agent-to-resource connections.
- **A2A (horizontal integration):** Standardizes how agents discover each other, delegate tasks, exchange results, and coordinate on long-running work. One protocol for agent-to-agent connections.

The Google Developer Blog's guide to agent protocols frames this cleanly: use MCP when you need raw data or tool access through a standard API; use A2A when the expertise you need lives inside another agent that manages its own state, reasoning, and context.

---

## A2A Protocol: Architecture Deep Dive

### Transport and Encoding

A2A is built on mature web infrastructure: **HTTP/1.1 and HTTP/2** for transport, **JSON-RPC 2.0** for message framing, **Server-Sent Events (SSE)** for streaming responses, and optionally **gRPC bidirectional streams** for high-throughput scenarios. This choice is deliberate — it means A2A agents are reachable from any language or platform that can speak HTTP, without requiring a new runtime or specialized client library.

The protocol version is negotiated via the `A2A-Version` request header (e.g., `A2A-Version: 1.0`). Servers must process requests using the requested version's semantics or return a `VersionNotSupportedError`.

### Agent Cards: The Service Discovery Layer

Every A2A agent publishes a machine-readable **Agent Card** at a well-known URL:

```
GET /.well-known/agent-card.json
```

The Agent Card is a JSON document that serves as the agent's identity, capability advertisement, and contact information — analogous to an OpenAPI spec, but for autonomous agents. A minimal Agent Card looks like:

```json
{
  "name": "InventorySpecialist",
  "description": "Manages real-time inventory data, stock forecasting, and supplier queries for the supply chain domain.",
  "version": "1.2.0",
  "url": "https://agents.example.com/inventory",
  "capabilities": {
    "streaming": true,
    "pushNotifications": true,
    "stateTransitionHistory": false
  },
  "skills": [
    {
      "id": "stock-query",
      "name": "Query Stock Levels",
      "description": "Returns current inventory levels by SKU, warehouse, or region.",
      "inputModes": ["text", "application/json"],
      "outputModes": ["application/json"]
    }
  ],
  "securitySchemes": {
    "oauth2": {
      "type": "oauth2",
      "flows": {
        "clientCredentials": {
          "tokenUrl": "https://auth.example.com/token",
          "scopes": { "inventory:read": "Read inventory data" }
        }
      }
    }
  }
}
```

A2A v1.0 introduced **signed Agent Cards** — the most significant security improvement in the production-grade release. Signatures allow receiving agents to cryptographically verify that the card was issued by the domain owner, closing off card impersonation attacks that were identified by security researchers in 2025.

For agents that expose sensitive capability details, A2A supports an **Extended Agent Card** endpoint that requires client authentication before returning full metadata. This allows public agents to advertise their existence without leaking internal implementation details to unauthenticated callers.

### The Task Lifecycle

The **Task** is the fundamental unit of work in A2A. Each task has a unique ID and progresses through a defined state machine:

```
SUBMITTED → WORKING → COMPLETED (terminal)
                    → FAILED    (terminal)
                    → CANCELED  (terminal)
         → INPUT_REQUIRED (interrupted — awaiting user input)
         → AUTH_REQUIRED  (interrupted — auth needed)
         → REJECTED       (terminal — agent declined)
```

Tasks are initiated via JSON-RPC calls. The primary methods are:

| Method | Description |
|--------|-------------|
| `SendMessage` | Submit a task and wait for synchronous response |
| `SendStreamingMessage` | Submit a task and receive streaming SSE updates |
| `GetTask` | Poll current task state |
| `ListTasks` | List tasks matching filters |
| `CancelTask` | Request cancellation |
| `SubscribeToTask` | Subscribe to state-change events for an existing task |
| `CreateTaskPushNotificationConfig` | Register a webhook for async callbacks |

A task carries a **message history** (the conversation context), the current **status**, and zero or more **artifacts** — structured outputs produced during execution. This design explicitly supports multi-turn conversations: when a task enters `INPUT_REQUIRED`, the orchestrating agent can inject additional messages and resume processing without starting a new task.

### Streaming with SSE

For tasks that produce incremental output — a streaming LLM response, a progress report, a long data export — A2A uses Server-Sent Events. The client calls `SendStreamingMessage`, and the server returns:

```
HTTP/1.1 200 OK
Content-Type: text/event-stream

data: {"jsonrpc": "2.0", "id": "req-1", "result": {"id": "task-abc", "status": "submitted"}}

data: {"jsonrpc": "2.0", "id": "req-1", "result": {"type": "TaskStatusUpdateEvent", "taskId": "task-abc", "status": "working"}}

data: {"jsonrpc": "2.0", "id": "req-1", "result": {"type": "TaskArtifactUpdateEvent", "taskId": "task-abc", "artifact": {"type": "text", "content": "First paragraph of analysis..."}}}

data: {"jsonrpc": "2.0", "id": "req-1", "result": {"type": "TaskStatusUpdateEvent", "taskId": "task-abc", "status": "completed"}}
```

The stream closes when the task reaches a terminal state. For very long-running tasks where the client cannot maintain a persistent connection, A2A supports **push notifications**: the client registers an HTTPS webhook via `CreateTaskPushNotificationConfig`, and the server calls the webhook when significant state transitions occur.

---

## MCP vs A2A: Complementary Roles, Not Competitors

The most common misconception when A2A launched was that it would replace or compete with MCP. In practice, they are complementary — and most mature multi-agent systems use both.

| Dimension | MCP | A2A |
|-----------|-----|-----|
| Primary concern | Tool/resource access | Agent-to-agent collaboration |
| Direction | Vertical (agent → resource) | Horizontal (agent ↔ agent) |
| State model | Largely stateless per call | Stateful task lifecycle |
| Discovery | `mcp://` server URLs | Agent Cards at `/.well-known/agent-card.json` |
| Output | Tool results, resource reads | Tasks, artifacts, multi-turn conversations |
| Spec origin | Anthropic (Nov 2024) | Google (Apr 2025) |
| Adoption | 97M+ downloads, universal platform support | 150+ orgs, 5-language SDK |

The layered architecture looks like this in practice:

```
Orchestrator Agent
    │
    ├── MCP → PostgreSQL server (read order data)
    ├── MCP → Stripe server (process payments)
    │
    ├── A2A → InventoryAgent (complex stock reasoning)
    │             │
    │             └── MCP → WarehouseDB
    │
    └── A2A → ComplianceAgent (regulatory checks)
                  │
                  └── MCP → RegulationsAPI
```

The orchestrator uses MCP for direct tool access and A2A for delegation to specialist agents. Each specialist agent is itself an autonomous system that may internally use MCP to access its own data sources. A2A delegates the *problem*; MCP fetches the *data*.

The Google Developer guide's recommendation: start with MCP for straightforward tool integration. Introduce A2A when you need capabilities that can't be expressed as a single synchronous tool call — when the expertise lives inside another reasoning agent with its own memory and judgment.

---

## Other Multi-Agent Communication Approaches

### AutoGen: Conversational Agents

Microsoft's **AutoGen** (now AutoGen 2 / AG2) structures multi-agent coordination as conversations. Agents are personas in a shared dialogue; a selector determines who speaks next. The **GroupChat** pattern allows N agents to collaborate in a shared message thread, with a GroupChatManager routing messages based on role definitions.

AutoGen excels at brainstorming, code review, and debate-style tasks where the value comes from agents challenging each other's outputs. The conversational model is intuitive but can produce verbose logs and makes it harder to enforce strict task boundaries. AutoGen is now adding A2A compatibility to allow its conversational agents to interoperate with external A2A-compliant agents.

### CrewAI: Role-Based Delegation

**CrewAI** models agents as a crew of workers with defined roles, goals, and backstories. Delegation is hierarchical: a manager agent assigns tasks to worker agents based on role descriptions. The 2025 addition of **Flows** — event-driven pipelines — added more predictable routing for production workloads where the conversational model introduces too much non-determinism.

CrewAI's role-based mental model maps well to organizational workflows (sales agent → research agent → writing agent) and makes it easy to reason about which agent is responsible for what. The tradeoff is rigidity: adding a new agent type requires restructuring the crew definition.

### LangGraph: State Machine Orchestration

**LangGraph** treats multi-agent coordination as a directed graph, where nodes are agent invocations and edges are transitions. All agents read from and write to a shared **state object**, with reducer logic handling concurrent updates. This gives precise control over execution order, branching on intermediate results, and error recovery paths.

LangGraph is the most production-hardened of the framework-native approaches — it integrates deeply with LangSmith for observability and supports durable execution (checkpointing state to storage so workflows can resume after failures). The tradeoff is verbosity: graph definitions require explicit modeling of all state transitions.

### Custom WebSocket Protocols (e.g., HXA-Connect)

For real-time, low-latency bot-to-bot messaging, custom WebSocket-based protocols remain common. HXA-Connect, for example, uses a persistent WebSocket connection with JSON message framing for bidirectional communication between AI agents deployed across different hosts. Unlike A2A's HTTP+SSE model, a WebSocket connection is fully bidirectional and multiplexed, making it well-suited for chat-style interactions or scenarios where the server needs to push events without a client polling first.

The tradeoff vs. A2A: custom WebSocket protocols require implementing your own service discovery, message typing, error handling, and authentication — all the things A2A's spec provides out of the box. WebSocket protocols make sense when you control both ends of the connection and need sub-100ms round trips; A2A makes sense when you need interoperability across organizational or vendor boundaries.

---

## Production Patterns and Hard Challenges

### Authentication and Authorization

Authentication is where A2A's production story gets complicated. The protocol explicitly supports multiple auth schemes — API key, HTTP Bearer, OAuth 2.0 (Authorization Code, Client Credentials, Device Code), OpenID Connect, and mutual TLS — but the spec intentionally does not mandate which to use or how to verify Agent Cards. The result: authentication correctness is entirely the implementer's responsibility.

**Recommended production pattern:**

1. **mTLS for transport-layer identity.** Each agent holds a PKI-issued certificate. mTLS ensures the connection itself is authenticated before any application-level message is exchanged.
2. **OAuth 2.0 Client Credentials for service-to-service token issuance.** Agents obtain short-lived access tokens from a central authorization server, scoped to specific capabilities (e.g., `inventory:read`).
3. **Signed Agent Cards for capability verification.** Before accepting task delegation from a new agent, verify the card signature against the domain's published public key.
4. **Zero-trust task routing.** Don't trust the agent card alone — validate that the presenting agent's token has the scopes claimed in its card before routing tasks.

Auth0's published integration with Google Cloud A2A (2026) demonstrates this pattern: OAuth 2.0 machine-to-machine tokens issued per agent identity, with short expiry and automatic rotation, scoped to specific A2A endpoints.

### Security: Agent-in-the-Middle and Prompt Injection

Trustwave SpiderLabs researchers demonstrated a significant attack class in 2025: a rogue agent presents an inflated Agent Card with a description crafted to manipulate the *orchestrator's LLM-based selection logic*. Because most orchestrators choose specialist agents by reasoning over card descriptions, injecting persuasive natural language into a card's description field can hijack task routing. This is a form of prompt injection operating at the infrastructure layer.

Mitigations:
- Verify Agent Cards cryptographically, not just semantically.
- Maintain an allowlist of trusted agent identities; don't dynamically trust new agents without human approval.
- Sandbox agent card descriptions from the orchestrator's planning context — don't feed raw card content directly into the planning LLM.
- Audit task routing decisions in structured logs, separate from LLM reasoning traces.

A 2025 research paper (arXiv:2505.12490) analyzed systematic mitigations for sensitive data leakage and unintended harm propagation in A2A multi-agent systems, proposing sandboxed execution boundaries and differential privacy controls for cross-agent data sharing.

### Service Discovery at Scale

A2A's `/.well-known/agent-card.json` pattern works well for known agents, but enterprise deployments need centralized registries. The emerging pattern is an **Agent Registry** — an internal service that:
- Indexes Agent Cards from deployed agents
- Enforces organizational allowlists
- Caches and periodically refreshes cards
- Provides search by capability (e.g., "find all agents with `compliance:check` skill")

Dapr's A2A integration (2026) takes this further by using Dapr's service mesh for agent discovery and routing, adding sidecar-based traffic management and circuit breaking to A2A deployments.

### Observability Across Agent Boundaries

Distributed tracing becomes critical when a single user request may fan out through 5+ agents before producing a response. A2A tasks carry correlation metadata, but mapping task IDs to distributed trace spans requires integration with your observability infrastructure (OpenTelemetry, Datadog, etc.).

Key observability requirements for production A2A:
- **Trace propagation:** Inject W3C `traceparent` headers into A2A requests so spans chain across agent boundaries.
- **Task state logging:** Persist every task state transition (submitted, working, completed, failed) to a structured log or events store.
- **Latency attribution:** Track time spent in each agent so you can identify bottlenecks.
- **Error semantics:** A2A's `FAILED` state is a terminal error — log the failure reason and the full task context for post-mortem analysis.

### Task Delegation vs. Collaboration

A2A supports two collaboration patterns that are worth distinguishing:

**Delegation:** The orchestrator sends a task and waits for a result. The specialist agent is a black box — the orchestrator doesn't care how it works, only that it returns a correct artifact. This is the common case and maps directly to A2A's `SendMessage` / `SendStreamingMessage` pattern.

**Collaboration:** Multiple agents contribute to a shared task, potentially with back-and-forth turns. A2A supports this via multi-turn conversations within a task: when an agent reaches `INPUT_REQUIRED`, the orchestrator can inject a follow-up message to the same task, resuming the work without losing context. Long-running collaborative workflows (e.g., a research task that takes hours and requires intermediate human review) use push notifications + polling on the same task ID.

---

## Industry Adoption and Enterprise Trajectories

A2A's first-year adoption metrics are notable given how young the protocol is:

- **150+ organizations** including Google, AWS, Microsoft, IBM, Salesforce, SAP, ServiceNow, Cisco
- **5 production SDKs** (Python, JavaScript, Java, Go, .NET) — up from one Python implementation at launch
- **22,000+ GitHub stars** on the core repository
- **Linux Foundation governance** — a signal that Google is serious about open stewardship, not proprietary lock-in
- **v1.0 specification** released in early 2026, marking the transition from experimental to production-grade

Major platform integrations:
- **Google Vertex AI Agent Engine** natively supports A2A for coordinating agents deployed on GCP.
- **Microsoft Azure AI Foundry** has A2A integration, allowing Azure-hosted agents to interoperate with external A2A agents.
- **AWS Bedrock** has A2A support in its agent orchestration layer.
- **Salesforce Agentforce** uses A2A to bridge its platform agents with third-party ecosystems.
- **SAP Joule** supports A2A for connecting SAP's enterprise AI agents to external orchestrators.

Vertical use cases driving production adoption:
- **Supply chain:** A2A coordinates inventory, logistics, procurement, and demand-forecasting agents across vendor boundaries.
- **Financial services:** Compliance, risk, fraud detection, and customer service agents collaborate via A2A while maintaining regulatory isolation.
- **IT operations:** Monitoring, incident response, and remediation agents coordinate autonomous resolution workflows.
- **Employee onboarding:** HR, IT provisioning, and access management agents handle multi-step onboarding without human handoffs.

System integrators (Accenture, Deloitte, EPAM, Wipro) are building A2A-based multi-agent platforms as managed service offerings — a sign that enterprise buyers are asking for this capability, not just experimenting.

One ongoing tension: the **AAIF (Agentic AI Interoperability Framework)** emerged in late 2025 as an alternative proposal, creating some fragmentation in the standards landscape. As of mid-2026, A2A has significantly more momentum, but the existence of competing proposals means the interoperability layer isn't fully settled.

---

## Practical Recommendations

**For teams starting with multi-agent systems:**
1. Implement MCP first for tool/data integration. It's more mature, has broader support, and the local complexity is lower.
2. Use a single-framework approach (LangGraph, CrewAI, or AutoGen) while your team learns multi-agent patterns. Intra-framework communication is simpler than cross-framework.
3. Add A2A at the boundaries where you need to integrate external agents or cross organizational lines.

**For teams building A2A agents for production:**
1. Sign your Agent Cards and verify signatures before accepting delegated tasks.
2. Use short-lived OAuth 2.0 tokens scoped to specific capabilities. Never use long-lived shared secrets.
3. Instrument every task state transition with structured logs and trace propagation headers.
4. Test your `INPUT_REQUIRED` and `AUTH_REQUIRED` states — most early implementations only handle the happy path.
5. Build an internal Agent Registry rather than relying purely on `/.well-known/` discovery.

**For enterprises evaluating multi-agent architecture:**
- A2A + MCP is the emerging standard stack. Investing in proprietary inter-agent protocols now creates technical debt.
- Start with a pilot in a bounded domain (e.g., internal IT helpdesk automation) before deploying A2A across business-critical workflows.
- Security review of Agent Cards is not optional — validate signatures, audit card descriptions for prompt injection vectors, and maintain allowlists.

---

*Sources: [Google A2A Announcement](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/) · [A2A Protocol Specification](https://a2a-protocol.org/latest/specification/) · [Linux Foundation A2A Adoption Press Release](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year) · [Google Developer Guide to Agent Protocols](https://developers.googleblog.com/developers-guide-to-ai-agent-protocols/) · [A2A Streaming Documentation](https://a2a-protocol.org/latest/topics/streaming-and-async/) · [arXiv: Protecting Sensitive Data in A2A Systems](https://arxiv.org/html/2505.12490v3) · [Auth0 A2A Integration](https://auth0.com/blog/auth0-google-a2a/) · [Dapr A2A Integration](https://www.diagrid.io/blog/making-agent-to-agent-a2a-communication-secure-and-reliable-with-dapr) · [Palo Alto A2A Security Analysis](https://live.paloaltonetworks.com/t5/community-blogs/safeguarding-ai-agents-an-in-depth-look-at-a2a-protocol-risks/ba-p/1235996)*
