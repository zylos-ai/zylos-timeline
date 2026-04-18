---
date: "2026-04-18"
title: "Agent-to-Agent Interoperability Protocols: A2A, ACP, and ANP in Production"
description: "A deep technical survey of the emerging protocols enabling AI agents to discover, communicate, and collaborate across vendor boundaries — from A2A's v1.0 release to the convergence under the Linux Foundation."
tags: ["a2a", "agent-interoperability", "multi-agent", "protocols", "llm-infrastructure"]
---

## Executive Summary

A year after Google introduced the Agent2Agent (A2A) protocol in April 2025, the agent interoperability landscape has transformed from a collection of incompatible proprietary frameworks into a maturing, Linux Foundation-governed ecosystem. A2A has reached v1.0 with cryptographically signed Agent Cards, gRPC bindings, and production deployments inside Azure AI Foundry, Amazon Bedrock AgentCore, and Google Agent Engine. The competing Agent Communication Protocol (ACP) from IBM Research has formally merged its roadmap into A2A. The Agent Network Protocol (ANP), built on W3C Decentralized Identifiers, continues to evolve as the open-internet complement to A2A's enterprise focus. Together with Anthropic's Model Context Protocol (MCP), these specifications now form a coherent layered stack: MCP handles vertical tool access, A2A handles horizontal agent-to-agent delegation, and ANP extends that federation to the open web.

This article surveys the technical architecture of each protocol, compares their design tradeoffs, traces their convergence trajectory, and examines the unresolved challenges — trust federation, prompt injection across agent chains, and verifiable delegation — that will define the next chapter of autonomous AI systems.

---

## Background and Problem Statement

### The Silo Problem in Multi-Agent Systems

Early multi-agent systems were built as closed, proprietary systems. A LangChain agent could not delegate work to an AutoGen agent. A Salesforce Einstein agent could not discover the capabilities of a ServiceNow agent. Each framework defined its own internal message format, task schema, and authentication model. As enterprise deployments grew from single-agent assistants to networks of dozens of specialized agents, this fragmentation became a critical bottleneck.

The core problem is straightforward to state: two AI agents built by different teams on different frameworks should be able to discover each other's capabilities, negotiate task delegation, exchange structured messages, and receive asynchronous status updates — all without requiring a custom integration for every pair of agents. The protocols described in this article are attempts to solve exactly this problem, in the same way HTTP solved the problem of heterogeneous web server communication in the 1990s.

### Why Existing Standards Were Insufficient

Before 2025, the dominant approach was to expose agents as standard HTTP REST APIs or as OpenAPI-described services. This worked for simple request-response interactions but broke down in several ways:

- **No capability discovery standard.** Callers needed to read documentation to understand what an agent could do, rather than querying the agent at runtime.
- **No task lifecycle semantics.** Long-running agent tasks — which may take seconds to hours — have states (submitted, working, paused, completed, failed) that REST APIs were not designed to model.
- **No agent-native authentication.** OAuth 2.0 and API keys were designed for human-facing services; they lacked concepts like delegated agent authority, scoped capability grants, and agent identity attestation.
- **No streaming primitives for agent output.** Agents produce partial results, status updates, and streaming artifacts that don't map cleanly to synchronous HTTP responses.

---

## The Protocol Landscape

### A2A: Agent2Agent Protocol

Google launched A2A in April 2025 alongside 50+ industry partners including Atlassian, Cohere, LangChain, MongoDB, PayPal, Salesforce, SAP, ServiceNow, UKG, and Workday. In June 2025 it was donated to the Linux Foundation, joining MCP under the Agentic AI Foundation umbrella. By April 2026, over 150 organizations support the standard.

**Core design principles:**

A2A is deliberately built on existing, well-understood infrastructure standards rather than inventing new wire formats. The transport is plain HTTP. The message format is JSON-RPC 2.0. Real-time streaming uses Server-Sent Events (SSE). Long-running async updates use webhook-based push notifications. The v1.0 release added gRPC bindings, elevating `a2a.proto` to the normative source of truth for all protocol data objects.

**Agent Cards — capability discovery:**

Every A2A server publishes an Agent Card at a well-known URL (typically `/.well-known/agent.json`). The card is a JSON document declaring:

- The agent's human-readable name and description
- Its supported skills and input/output modalities (text, images, structured data, files)
- The authentication schemes it requires (OAuth 2.0 bearer tokens, API keys, mTLS)
- The endpoint URL for task submission
- A cryptographic signature (in v1.0) proving the card was issued by the domain owner

Agent Cards make capability discovery machine-readable at runtime. A client agent fetches the card, parses the supported skills, and knows immediately whether the remote agent can handle its request — without reading documentation.

**Task lifecycle:**

The core abstraction in A2A is a `Task`. Tasks are stateful entities that transition through a defined lifecycle:

```
submitted → working → (input-required) → completed
                    ↘ failed
                    ↘ canceled
```

The `input-required` state is critical for human-in-the-loop or multi-step workflows where the remote agent needs clarification mid-task. Task artifacts (files, structured outputs, reports) accumulate on the task object and are accessible by the client throughout execution.

**Streaming and push notifications:**

For short tasks, the client calls `message/send` and receives a synchronous response. For long-running tasks, the client calls `message/stream`, which returns an SSE stream. Each event in the stream is a complete JSON-RPC response containing a task status update or a partial artifact.

For tasks that may run for hours or days — or where the client connection may drop — A2A supports push notifications. The client provides a webhook URL when submitting the task; the server posts status updates to that URL asynchronously. This pattern maps cleanly to mobile clients and serverless function runtimes where maintaining a persistent connection is impractical.

**v1.0 additions:**

The v1.0 release in early 2026 added four capabilities that moved A2A from prototype to production-grade:

1. **Signed Agent Cards.** Each card includes a cryptographic signature using the domain's public key, enabling receiving agents to verify the card was actually issued by the claimed domain. This closes the card forgery vector and makes decentralized discovery viable.
2. **gRPC transport binding.** The `a2a.proto` file is now the normative specification, providing efficient binary transport for high-throughput agent networks.
3. **Multi-tenancy support.** A single A2A server can host multiple logical agents, each with distinct Agent Cards and authentication policies — critical for SaaS platforms serving multiple enterprise customers.
4. **Agent Payments Protocol (AP2) extension.** AP2 is a formal A2A extension, supported by 60+ organizations in payments and financial services, enabling agents to initiate and settle transactions autonomously.

### ACP: Agent Communication Protocol

IBM Research introduced ACP in parallel with A2A's launch. ACP took a different architectural bet: REST over JSON-RPC, with an emphasis on multipart MIME messages and native support for multimodal agent outputs (text, images, audio, binary files in a single message).

ACP's design was lighter-weight and runtime-agnostic. Its REST API surface required no special client libraries — any HTTP client could interact with an ACP agent. It natively supported both synchronous and asynchronous interaction patterns. The BeeAI open-source project, now under the Linux Foundation, provided the reference implementation.

By late 2025, the ACP team formally decided to wind down active development and contribute their technology to A2A, recognizing that protocol fragmentation was a bigger problem than any technical advantage either protocol held. ACP's multimodal messaging patterns and its lightweight REST-first design influenced A2A's v1.0 artifact model.

### ANP: Agent Network Protocol

ANP takes the most ambitious architectural stance of the three protocols. While A2A assumes agents exist within known organizational boundaries and communicate over private or semi-private networks, ANP is designed for the open internet — a world where any agent can discover and communicate with any other agent without pre-established trust relationships.

ANP is built on three foundational standards:

- **W3C Decentralized Identifiers (DIDs).** Each agent has a cryptographically verifiable identity that does not depend on any central authority. An agent's DID is its passport on the agent network.
- **JSON-LD.** Agent descriptions are expressed as linked data graphs, enabling semantic interoperability — agents can reason about each other's capabilities using shared vocabularies.
- **End-to-end encryption.** Communication is encrypted at the protocol layer using the agent's DID keys, independent of the transport.

ANP's three-layer architecture separates concerns cleanly:

1. **Identity and encryption layer.** DID-based authentication and end-to-end encrypted channels.
2. **Meta-protocol negotiation layer.** Agents negotiate which application-layer protocol to use for a given interaction. This is the layer that makes ANP extensible to future protocols.
3. **Application protocol layer.** Agent Description Protocol (ADP) for capability publication, and Agent Discovery Protocol for finding relevant agents on the network.

ANP presented a white paper to the W3C in November 2025, positioning itself as "the HTTP of the Agentic Web era." The protocol remains in active development and has not yet achieved the enterprise adoption that A2A has, but its decentralized identity model addresses trust gaps that A2A's signed Agent Cards only partially solve.

---

## Technical Architecture: A Deep Dive

### The A2A Communication Flow

A typical A2A interaction proceeds as follows:

1. **Discovery.** The client agent fetches the remote agent's Agent Card from `/.well-known/agent.json`. It verifies the cryptographic signature against the domain's published public key.
2. **Authentication.** The client obtains an access token using the scheme declared in the Agent Card (typically OAuth 2.0 client credentials flow for machine-to-machine scenarios).
3. **Task submission.** The client sends a `message/send` or `message/stream` JSON-RPC request to the remote agent's endpoint, including the task payload and, for async tasks, a webhook URL.
4. **Task execution.** The remote agent executes the task, potentially spawning its own sub-agents via additional A2A calls. It posts status updates to the client's webhook or streams them over SSE.
5. **Artifact retrieval.** On completion, the client fetches artifacts from the task object using `tasks/get`.
6. **Task management.** If needed, the client can pause, resume, or cancel the task using `tasks/cancel` or `tasks/resubscribe`.

### Message Format

Every A2A request is a JSON-RPC 2.0 object:

```json
{
  "jsonrpc": "2.0",
  "id": "task-abc123",
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "parts": [
        {
          "kind": "text",
          "text": "Analyze Q3 revenue trends for the APAC region"
        }
      ]
    },
    "configuration": {
      "blocking": false,
      "pushNotificationConfig": {
        "url": "https://client.example.com/webhooks/a2a",
        "authentication": { "schemes": ["bearer"] }
      }
    }
  }
}
```

The `parts` array supports multiple content types: `text`, `file` (with inline data or a URI), and `data` (structured JSON). This multipart design, influenced by ACP, allows a single message to carry rich context to a remote agent.

### The Agent Card Schema

```json
{
  "protocolVersion": "1.0",
  "name": "FinancialAnalysisAgent",
  "description": "Analyzes financial data and generates reports",
  "url": "https://agents.example.com/finance",
  "skills": [
    {
      "id": "revenue-trend-analysis",
      "name": "Revenue Trend Analysis",
      "description": "Analyzes revenue data and generates trend reports",
      "inputModes": ["text", "data"],
      "outputModes": ["text", "data", "file"]
    }
  ],
  "securitySchemes": {
    "bearerToken": {
      "type": "http",
      "scheme": "bearer"
    }
  },
  "security": [{ "bearerToken": [] }],
  "signature": "eyJhbGciOiJFZERTQSJ9..."
}
```

The `signature` field (added in v1.0) is a JWS (JSON Web Signature) using the Ed25519 algorithm. Verifying it requires resolving the domain's public key from a well-known endpoint, analogous to DKIM in email authentication.

---

## Production Considerations

### Deployment Patterns

**Managed platform integration:** The simplest production path is to use a cloud platform that has built A2A support into its agent runtime. Google Agent Engine, Azure AI Foundry, and Amazon Bedrock AgentCore all provide managed A2A server infrastructure. Developers deploy their agent code; the platform handles Agent Card publication, authentication, SSE streaming, and push notification delivery.

**Self-hosted with SDK:** For teams that need control over their infrastructure, the A2A SDK ecosystem now covers Python, JavaScript/TypeScript, Java, Go, and .NET. The SDK handles the JSON-RPC serialization, SSE event loop, push notification signing, and Agent Card generation. Teams are responsible for hosting and scaling the HTTP server.

**API gateway integration:** In enterprise environments, A2A endpoints are typically placed behind an API gateway (Kong, Apigee, AWS API Gateway) that handles rate limiting, logging, and mTLS termination. The gateway verifies incoming bearer tokens against the organization's authorization server before forwarding requests to the A2A backend.

### Authentication in Practice

A2A specifies *which* authentication scheme an agent requires (via the Agent Card's `securitySchemes` field) but does not prescribe the identity provider. In practice, enterprise deployments use one of three patterns:

1. **Centralized IAM.** All agents in an organization are registered as OAuth 2.0 clients in a shared authorization server (Okta, Azure AD, Google Cloud IAM). Client credentials flow issues short-lived bearer tokens. This is the simplest model but requires pre-registration of every agent pair.

2. **Service mesh mTLS.** Agents communicate over a service mesh (Istio, Linkerd) where mTLS is handled transparently at the infrastructure layer. The A2A bearer token still carries identity claims but is validated against the mesh's PKI. This pattern eliminates the pre-registration requirement but requires a uniform service mesh deployment.

3. **Federated token exchange.** For cross-organizational A2A calls, OAuth 2.0 token exchange (RFC 8693) is used. Agent A's token is exchanged at a federation endpoint for a token accepted by Agent B's organization. This is the most flexible but most complex pattern, and tooling is still immature.

### Scaling Long-Running Tasks

A2A's push notification pattern aligns naturally with event-driven infrastructure. Production deployments at scale typically route task status updates through a message broker (Apache Kafka, Google Pub/Sub, Amazon SQS) rather than posting directly to client webhook URLs. This decouples the agent server from downstream webhook availability and provides durability against network failures.

A pattern that has emerged in production:

1. A2A server publishes task events to Kafka topic `agent.tasks.{org-id}`.
2. A webhook relay service consumes from Kafka and delivers HTTP POST requests to registered client webhooks with retry logic.
3. Clients that prefer polling can subscribe to the Kafka topic directly using a dedicated consumer, skipping the webhook relay entirely.

### Observability

Because A2A uses standard HTTP and JSON-RPC, existing observability infrastructure (OpenTelemetry, Datadog, Grafana) integrates naturally. Key metrics to instrument:

- **Task submission rate and latency** (from `message/send` to first `working` status event)
- **Task completion rate by skill and outcome** (completed vs. failed vs. canceled)
- **Artifact size distribution** (large artifacts indicate potential memory pressure in agent servers)
- **Push notification delivery success rate** (high failure rates indicate webhook endpoint reliability issues)
- **Agent Card fetch latency** (caching Agent Cards reduces discovery overhead; monitor cache hit rate)

---

## Case Studies and Real-World Deployments

### Microsoft Copilot Studio and Azure AI Foundry

Microsoft began integrating A2A into Copilot Studio in mid-2025 and achieved general availability for multi-agent orchestration features in early April 2026. The integration allows a Copilot Studio agent to act as both an A2A client (delegating tasks to other agents) and an A2A server (receiving delegated tasks from orchestrator agents).

In practice, this means a Copilot Studio agent built for HR workflows can delegate candidate analysis to a specialized recruiting agent built on an entirely different framework — as long as both expose A2A-compliant endpoints. Microsoft's documentation for this feature cites the concrete use case of an enterprise assistant that orchestrates specialized agents for legal review, financial analysis, and project management, none of which were built by Microsoft.

Azure AI Foundry adds A2A support at the infrastructure layer: deploying any supported agent framework (Semantic Kernel, LangGraph, CrewAI) to Foundry automatically generates a compliant A2A endpoint, Agent Card, and authentication configuration.

### Amazon Bedrock AgentCore

AWS integrated A2A into the AgentCore Runtime, allowing Bedrock agents to communicate with external A2A-compliant agents outside the AWS ecosystem. AWS Open Source Blog published a four-part series on agent interoperability protocols in late 2025, detailing how Bedrock AgentCore handles the authentication challenge for cross-cloud A2A calls using AWS STS and OAuth token exchange.

### Supply Chain Orchestration at SAP

SAP has published case study material on using A2A to coordinate agents across their supply chain suite. The architecture involves a master orchestrator agent that receives natural-language supply chain queries, decomposes them into sub-tasks, and delegates each sub-task to specialized agents: an inventory analysis agent, a supplier risk assessment agent, and a logistics optimization agent. Each specialist is a separate microservice with its own A2A endpoint.

This pattern — a thin orchestrator delegating to opaque specialist agents — is the canonical A2A use case. The orchestrator does not need to know how each specialist works internally; it only needs to know what skills are declared on their Agent Cards.

### Financial Services with AP2

The Agent Payments Protocol extension enables a class of agent use cases that were previously impractical: agents that can autonomously initiate and settle transactions. Early production deployments in financial services use AP2 for automated invoice processing: a procurement agent identifies an approved invoice, delegates payment initiation to a payments agent via A2A/AP2, and the payments agent executes the transfer within pre-approved limits. The entire workflow is auditable through A2A's task artifact trail.

---

## Security: The Incomplete Picture

### What A2A Gets Right

A2A's security model is sound at the transport and authentication layers. TLS is mandatory. Bearer token authentication follows OAuth 2.0 best practices. Signed Agent Cards in v1.0 prevent card forgery — a receiving agent can now verify that an Agent Card was actually issued by the domain it claims. This closes the most obvious spoofing vector in the discovery phase.

### The Trust Chain Problem

The deeper security challenge is the trust chain problem in multi-agent delegation. When Agent A delegates to Agent B, which delegates to Agent C, several questions go unanswered by the current A2A specification:

- Does Agent C have any way to verify that Agent A authorized Agent B to delegate this task?
- What happens when Agent B is compromised and begins issuing unauthorized delegations?
- Can Agent C verify that the original user (or system) that initiated the chain actually intended for Agent C to be involved?

A2A v1.0 does not answer these questions. The `AIP: Agent Identity Protocol for Verifiable Delegation` paper (arXiv 2603.24775) proposes addressing this through verifiable credential chains — each delegation step attaches a cryptographically signed delegation token to the task, creating an auditable chain of authority. This approach is being actively discussed in the A2A GitHub repository (issues #1497, #1472, #1501) but has not yet been merged into the specification.

### Prompt Injection Across Agent Boundaries

Perhaps the most novel security risk in multi-agent systems is cross-agent prompt injection. In a single-agent system, prompt injection attacks occur when adversarial content in the environment (a malicious web page, a crafted document) influences the agent's behavior. In a multi-agent system, the attack surface expands: a compromised or malicious agent can craft its A2A responses to inject instructions into the receiving agent's context.

A2A provides no protocol-level defense against this. The specification's security guidance acknowledges the risk and recommends defense-in-depth controls: validating and sanitizing content received from remote agents, applying least-privilege task scopes, and monitoring for anomalous agent behavior. These are necessary but insufficient — they shift the burden to each agent implementation rather than addressing the problem at the protocol layer.

Research published in 2025-2026 (arXiv 2506.23260, arXiv 2602.11327) classifies prompt injection as a tier-1 threat in LLM-powered agent workflows and rates the current mitigation posture as inadequate. This remains one of the most significant open problems in production multi-agent deployment.

### Trust Model Taxonomy

A 2025 paper (arXiv 2511.03434) analyzing trust models across A2A, AP2, and related protocols identifies six trust mechanisms:

| Mechanism | Description | A2A v1.0 Support |
|-----------|-------------|-----------------|
| Claim | Self-declared capabilities (Agent Card) | Yes |
| Proof | Cryptographic verification (signed cards, bearer tokens) | Partial |
| Brief | Verifiable third-party attestation | No |
| Stake | Bonded collateral with slashing | No |
| Reputation | Historical performance scoring | No |
| Constraint | Sandboxing and capability bounding | No |

The gap between "Claim" and "Proof" remains the most pressing near-term concern. Signed Agent Cards prove that a card was issued by the domain owner; they do not prove that the agent is behaving within the claimed scope during execution. Bridging this gap requires runtime attestation mechanisms that do not yet exist in the standard.

---

## Challenges and Open Problems

### Cross-Organizational Federation

The most common deployment pattern — agents within a single organization communicating over a shared identity provider — works well with current tooling. The hard problem is cross-organizational A2A: a customer's agent delegating tasks to a vendor's agent, across different identity providers and without pre-established federation agreements.

Four IETF Internet-Drafts published in early 2026 (AIMS, WIMSE, Agentic JWT, and SCIM for agents) each address pieces of this problem. WIMSE (Workload Identity in Multi-System Environments) is particularly relevant: it defines how workload identities (agents, services) can be attested and exchanged across organizational boundaries. But as of April 2026, no single implemented protocol combines all the necessary properties — offline attenuable delegation, expressive chained policy, provenance-aware completion records, and transport bindings across MCP, A2A, and HTTP.

### Protocol Convergence and Governance

With ACP merged into A2A and ANP pursuing its own W3C standardization track, the ecosystem is converging but not yet unified. The Linux Foundation's Agentic AI Foundation (AAIF) now governs both MCP and A2A, which reduces the risk of incompatible protocol evolution. The remaining governance question is how ANP's decentralized identity model will integrate with A2A's enterprise-centric authentication model — whether as a profile of A2A or as a separate protocol that bridges via a gateway.

### Behavioral Compatibility

A2A ensures structural interoperability — messages can be delivered and parsed. It does not ensure behavioral compatibility — that two agents trained by different teams on different models will produce coherent collaborative outputs when chained together. An orchestrator agent trained to expect structured JSON from a specialist agent may behave unpredictably when that specialist produces verbose prose. Managing output format contracts across agent boundaries is currently a manual engineering concern, not a protocol-level guarantee.

### The Tooling Gap

Despite five production SDK languages (Python, JavaScript, Java, Go, .NET), the developer tooling for debugging multi-agent A2A flows remains primitive. Inspecting a task chain that crosses four agent boundaries requires correlating logs from four separate services, each potentially in different cloud accounts. The A2A specification does not define a correlation identifier standard, leaving teams to implement their own distributed tracing propagation.

### Long-Tail Agent Discovery

For agents within a known organizational boundary, Agent Card discovery via well-known URLs works well. For the broader vision of an open agent network where specialized agents can be discovered and composed dynamically — the ANP vision — the discovery infrastructure does not yet exist at scale. There is no equivalent of npm or Docker Hub for A2A agents: no searchable registry, no trust ratings, no version management for Agent Cards.

---

## Conclusion

The twelve months following A2A's April 2025 launch have demonstrated that the agent interoperability problem is solvable at the protocol level, and that the industry is willing to coordinate on a shared standard rather than competing on protocol lock-in. The Linux Foundation governance of both MCP and A2A, combined with ACP's merger into A2A, gives the ecosystem a coherent standards body with real industry commitment.

The protocol architecture is now relatively clear: MCP as the vertical tool layer, A2A as the horizontal agent layer, ANP extending that to the open web. The transport primitives — HTTP, JSON-RPC 2.0, SSE, gRPC, push notifications — are well-understood and easy to integrate with existing infrastructure. Signed Agent Cards in v1.0 solve the most obvious discovery-phase security vulnerability.

What remains unsolved are the harder problems: verifiable delegation chains, cross-agent prompt injection resistance, cross-organizational federation without pre-established trust, and behavioral compatibility across agent boundaries. These are not protocol design problems so much as fundamental security and distributed systems problems applied to a new execution model. They will require continued investment from both the research community and the standards bodies that now govern this space.

For teams building production multi-agent systems today, the pragmatic path is to adopt A2A for agent-to-agent communication — it has the broadest tooling, the most enterprise integration support, and the most active governance — while treating the security gaps (prompt injection, delegation chains) as engineering constraints to be managed at the application layer until the specification catches up.

---

## References

1. [Announcing the Agent2Agent Protocol (A2A) — Google Developers Blog](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)
2. [Agent2Agent Protocol GitHub Repository — a2aproject/A2A](https://github.com/a2aproject/A2A)
3. [Agent2Agent (A2A) Protocol Specification — a2a-protocol.org](https://a2a-protocol.org/latest/specification/)
4. [What's New in v1.0 — A2A Protocol](https://a2a-protocol.org/latest/whats-new-v1/)
5. [Agent2Agent protocol is getting an upgrade — Google Cloud Blog](https://cloud.google.com/blog/products/ai-machine-learning/agent2agent-protocol-is-getting-an-upgrade/)
6. [A2A Protocol Surpasses 150 Organizations — Linux Foundation Press Release](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year)
7. [A Survey of Agent Interoperability Protocols: MCP, ACP, A2A, and ANP — arXiv 2505.02279](https://arxiv.org/abs/2505.02279)
8. [What is Agent Communication Protocol (ACP)? — IBM](https://www.ibm.com/think/topics/agent-communication-protocol)
9. [Agent Network Protocol — agent-network-protocol.com](https://agent-network-protocol.com/)
10. [Agent Network Protocol White Paper — W3C Community Group](https://w3c-cg.github.io/ai-agent-protocol/)
11. [Empowering multi-agent apps with A2A — Microsoft Cloud Blog](https://www.microsoft.com/en-us/microsoft-cloud/blog/2025/05/07/empowering-multi-agent-apps-with-the-open-agent2agent-a2a-protocol/)
12. [Connect to an agent over A2A — Microsoft Copilot Studio Docs](https://learn.microsoft.com/en-us/microsoft-copilot-studio/add-agent-agent-to-agent)
13. [Open Protocols for Agent Interoperability Part 4: A2A — AWS Open Source Blog](https://aws.amazon.com/blogs/opensource/open-protocols-for-agent-interoperability-part-4-inter-agent-communication-on-a2a/)
14. [Announcing Agent Payments Protocol (AP2) — Google Cloud Blog](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol/)
15. [A Security Engineer's Guide to the A2A Protocol — Semgrep](https://semgrep.dev/blog/2025/a-security-engineers-guide-to-the-a2a-protocol/)
16. [How to enhance Agent2Agent (A2A) security — Red Hat Developer](https://developers.redhat.com/articles/2025/08/19/how-enhance-agent2agent-security)
17. [Inter-Agent Trust Models: A Comparative Study — arXiv 2511.03434](https://arxiv.org/html/2511.03434v1)
18. [From Prompt Injections to Protocol Exploits — arXiv 2506.23260](https://arxiv.org/html/2506.23260v1)
19. [Security Threat Modeling for Emerging AI-Agent Protocols — arXiv 2602.11327](https://arxiv.org/html/2602.11327v1)
20. [AIP: Agent Identity Protocol for Verifiable Delegation Across MCP and A2A — arXiv 2603.24775](https://arxiv.org/html/2603.24775v1)
