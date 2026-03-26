---
date: "2026-03-26"
title: "Agent Interoperability Protocols 2026: MCP, A2A, ACP and the Path to Convergence"
description: "A comprehensive analysis of the evolving agent-to-agent communication protocol landscape — comparing MCP, A2A, ACP, and emerging standards shaping how AI agents discover, connect, and collaborate across platforms."
tags: ["agent protocols", "interoperability", "MCP", "A2A", "ACP", "multi-agent systems", "B2B communication"]
---

## Executive Summary

The agent interoperability landscape has matured significantly in Q1 2026, moving from a cacophony of competing proposals into a clearer, if still fragmented, architecture. Three protocols now dominate serious production conversations: Anthropic's **Model Context Protocol (MCP)** — the de facto standard for agent-to-tool connectivity, now governed by the Linux Foundation's Agentic AI Foundation (AAIF) with over 18,000 community servers and 97 million monthly SDK downloads; Google's **Agent-to-Agent Protocol (A2A)** — the leading standard for inter-agent coordination, backed by 100+ enterprise partners; and IBM/AGNTCY's **Agent Communication Protocol (ACP)** — a REST-native alternative favored by teams wanting minimal friction and existing HTTP toolchain compatibility.

The most important structural shift in early 2026 is not a new protocol — it is governance convergence. MCP, A2A, and ACP all now sit under Linux Foundation oversight, creating institutional alignment that did not exist a year ago. The AAIF's composition (Anthropic, OpenAI, Google, Microsoft, AWS, Block, Cloudflare, Bloomberg) signals that the era of winner-take-all protocol wars is over and the era of complementary layering has begun. The two-layer stack — MCP for vertical tool integration, A2A for horizontal agent coordination — is rapidly becoming the architectural default for enterprise agent deployments.

For agent platform builders, the strategic decisions have crystallized: implement Streamable HTTP for MCP transport, adopt OAuth 2.1 with Resource Indicators for security, design Agent Card-compatible discovery endpoints, and build observability into the protocol layer from day one. The remaining open questions — fine-grained authorization, cross-protocol interoperability, and the eventual role of decentralized identity — are active work items with clear timelines, not indefinite research problems. This article maps the full landscape, compares the protocols across the dimensions that matter for production deployments, and identifies the practical implications for teams building agent platforms in 2026.

The convergence narrative has limits: fragmentation persists at the edges. ANP (Agent Network Protocol) pursues a fully decentralized vision using W3C DIDs that is technically compelling but not yet ecosystem-ready. Matrix-based approaches (Alibaba's HiClaw) solve the human-in-the-loop problem elegantly but require infrastructure investment that most teams are not ready to make. OpenAPI tool-use schemas remain the lowest-common-denominator interop layer. And emerging B2B agent protocols targeting payment, contract, and cross-company workflow automation are adding new dimensions to an already complex space. The path to true convergence runs through NIST's AI Agent Standards Initiative, a Q3 2026 MCP/A2A joint specification, and the slow maturation of W3C DID infrastructure — none of which are yet complete.

## The Protocol Stack: How the Layers Fit Together

Before examining individual protocols, understanding the architectural division of labor is essential. A common source of confusion is treating these protocols as competitors when most address different layers.

The agent protocol stack has three layers:

**Layer 1 — Tool Integration (Vertical):** How a single agent connects to external capabilities — databases, APIs, file systems, code execution environments. This is MCP's domain. An agent uses MCP to call tools, read resources, and execute prompts. The relationship is agent-to-capability, not agent-to-agent.

**Layer 2 — Agent Coordination (Horizontal):** How multiple agents discover each other, negotiate tasks, and exchange results. This is A2A's and ACP's domain. The relationship is agent-to-agent across organizational or framework boundaries.

**Layer 3 — Identity and Trust (Cross-Cutting):** How agents establish who they are, verify counterparties, and maintain audit trails across interactions. This spans all protocols and is addressed through OAuth 2.1, W3C DIDs, Verifiable Credentials, and Agent Cards.

The practical implication: most production systems will run MCP and A2A simultaneously. Individual agents use MCP to access their tools; agents use A2A to coordinate with other agents on complex workflows. These are not alternatives — they are complements, and deploying both is increasingly the expected baseline.

## MCP in Q1 2026: From Protocol to Infrastructure

MCP's journey from a November 2024 developer experiment to enterprise infrastructure in 15 months is one of the fastest protocol adoption stories in software history. Understanding its current state requires understanding how dramatically the implementation model has changed.

### Transport: Streamable HTTP as the Standard

The `2025-03-26` specification's introduction of **Streamable HTTP** was the pivotal moment. The architecture is elegantly simple: everything flows through a single `/mcp` endpoint using standard HTTP POST and GET requests. Servers respond immediately for fast operations, upgrade to SSE streaming for long-running tasks, and can operate statelessly — allowing deployment behind standard round-robin load balancers without sticky sessions.

This last property is underappreciated. Before Streamable HTTP, scaling MCP servers required session-affinity infrastructure because each client had to maintain a connection to the same server instance. Streamable HTTP eliminates this constraint: MCP servers can now be deployed as Kubernetes pods, serverless functions, or Cloudflare Workers with no special configuration. The deployment model is identical to scaling a REST API.

As of March 2026, stdio (local subprocess communication) remains in the specification for development tooling, but remote production deployments standardize on Streamable HTTP. The old HTTP+SSE transport with its two-endpoint architecture is effectively deprecated in practice, though not yet formally removed from the spec.

### Security: OAuth 2.1 with Resource Indicators

The security architecture that emerged from the March and June 2025 spec updates is now battle-tested. The core model:

- MCP servers are classified as **OAuth resource servers**; clients as **OAuth clients**
- **PKCE** (Proof Key for Code Exchange) eliminates the authorization code interception vulnerability
- **Dynamic client registration** allows clients to connect to servers they have never accessed before — critical for open ecosystems where new servers appear daily
- **Resource Indicators (RFC 8707)** — added in the June 2025 update — close the critical token leakage vulnerability where a rogue server could trick a client into obtaining tokens valid for other services

The June 2025 fix is worth emphasizing because it addresses a class of attack that enterprise security teams specifically worry about: a malicious integration point harvesting credentials for legitimate services. Without Resource Indicators, the MCP OAuth model had a structural weakness that made it unsuitable for enterprise deployments where agents connect to many services. With them, tokens are scoped to specific resource server URIs and cannot be replayed across services.

### Tool Annotations and Safety Policies

The March 2025 spec added **tool annotations** — metadata that lets MCP servers describe their behavior semantics:

- `readOnly`: The tool does not modify external state
- `destructive`: The tool modifies or deletes data
- `idempotent`: Repeated invocations have the same effect as one
- `openWorld`: The tool produces effects visible outside the agent environment (sending emails, publishing content)

These annotations enable policy enforcement at the client layer: automatically approve read-only tools, require confirmation for destructive ones, block open-world tools in sandboxed environments. For enterprise deployments where human oversight is mandatory, tool annotations provide the machine-readable basis for consistent governance.

### The November 2025 Spec: Bidirectional Capabilities

The first anniversary release (`2025-11-25`) added capabilities that shift MCP from a unidirectional tool-calling protocol toward a genuine coordination layer:

**Sampling with tool calling:** MCP servers can now request LLM completions from the client, including tool calls within those completions. A server is no longer a passive tool provider — it can orchestrate multi-step reasoning flows, asking the client's LLM to reason about a problem and use tools to resolve it. This turns MCP bidirectional in a meaningful way.

**Elicitation:** Servers can request structured input from users through the client, defining schemas for the information they need. This enables richer human-in-the-loop workflows where servers actively request clarification rather than failing on ambiguous inputs.

### The Ecosystem: Scale and Governance

The numbers are staggering for a 15-month-old protocol. As of March 2026:

- Community registries index **18,000+ MCP servers** (Glama.ai: 18,374; MCP.so: 18,250+)
- The official MCP Registry (launched September 2025 preview) is becoming the authoritative source, with planned GA including signing and trust scoring
- **97 million monthly SDK downloads** across Python and TypeScript
- **50+ enterprise partners** including Salesforce, ServiceNow, Workday, and SAP

Governance transferred from Anthropic to the **Agentic AI Foundation (AAIF)** under the Linux Foundation in December 2025. The AAIF founding membership — Anthropic, OpenAI, Google, Microsoft, AWS, Block, Cloudflare, Bloomberg — encompasses the full enterprise AI landscape. This was a prerequisite for serious enterprise adoption; organizations were hesitant to build on a protocol controlled by a single AI vendor.

Cloudflare's position as the default deployment platform for remote MCP servers deserves note. Their Workers platform offers one-click deployment, built-in OAuth via `workers-oauth-provider`, Streamable HTTP support out of the box, and Python support alongside TypeScript. The combination removes the two biggest barriers to publishing remote MCP servers — deployment complexity and authorization — reducing time-to-live for a new server to minutes.

### Gaps That Remain

MCP's rapid adoption has outpaced some of its operational features:

**Audit trails:** The spec does not mandate structured logging of tool invocations. Production deployments need to know exactly which agent called which tool with what parameters and what result was returned — for compliance, debugging, and security forensics. Teams are currently building this at the application layer.

**Fine-grained authorization:** MCP servers typically expose all tools to all authenticated clients. Role-based tool access (this agent may call read tools but not write tools) is an application-layer concern, not a protocol concern. Salesforce's Agentforce has implemented enterprise governance layers on top of MCP; most teams have not.

**Observability:** OpenTelemetry span integration for MCP calls is not in the spec. Production systems need latency tracking and error classification built into their MCP client layers manually.

These gaps are known and on the roadmap. The June 2026 spec release is expected to address server-as-agent capabilities — MCP servers that connect to other MCP servers, enabling recursive composition patterns. Fine-grained authorization is expected to follow in a subsequent release.

## A2A: Enterprise Coordination Layer in Production

Google's Agent-to-Agent Protocol entered 2026 in the strongest position of any new-entrant protocol, having cleared the credibility bar that matters most in enterprise sales: third-party governance and broad industry partnership.

### Governance and Industry Alignment

A2A's donation to the Linux Foundation's **A2A Project** (announced alongside AAIF in December 2025) created the institutional symmetry with MCP that enables the two-layer narrative to be credible, not just aspirational. Both protocols are now Linux Foundation projects, both have overlapping membership, and both have committed to a Q3 2026 joint interoperability specification.

The A2A Project's composition mirrors the enterprise AI market: Google, Microsoft, Salesforce, ServiceNow, SAP, AWS, and 100+ additional enterprise partners. The protocol is not a research proposal — it is shipping in production at scale.

### Architecture: Agent Cards, Tasks, and Opacity

A2A's core architecture has stabilized around three concepts:

**Agent Cards** serve as the discovery mechanism — JSON documents published at `/.well-known/agent.json` (per RFC 8615) that declare capabilities, interaction modes, authentication requirements, and endpoint URLs. Any A2A-speaking agent can fetch a card to determine whether and how to collaborate. Signed Agent Cards (using JWS) allow consumers to verify cards have not been tampered with.

**Tasks** represent units of collaborative work with a defined lifecycle: `submitted` → `working` → `completed` / `failed` / `canceled`. Tasks can also enter `input_required` and `auth_required` states for multi-turn interactions. The terminal states are final — subsequent work requires a new task within the same `contextId`. This lifecycle model is what distinguishes A2A from simple HTTP APIs: the protocol has native concepts of long-running work, cancellation, and multi-turn dialogue.

**Opacity by design:** A2A agents collaborate based on declared capabilities without exposing internal reasoning, plans, or tool implementations. This is a deliberate architectural constraint that enables true inter-organization collaboration — you can delegate a task to a third-party agent without that agent knowing your internal systems, and vice versa. The trade-off is that debugging distributed workflows requires log correlation at the application layer rather than protocol inspection.

### Communication Modalities

A2A supports three delivery mechanisms, making it adaptable to different latency and connectivity requirements:

- **Synchronous request/response** over JSON-RPC 2.0 for simple queries
- **Server-Sent Events (SSE) streaming** for real-time updates during long-running tasks
- **Asynchronous push notifications** via webhooks for fire-and-forget delegation (clients that cannot maintain persistent connections)

The flexibility is practical: a simple "look up a customer record" request returns synchronously in milliseconds. A "analyze this 200-page contract" request upgrades to SSE streaming and delivers partial results over minutes. The client handles both cases with the same protocol.

### SDK Maturity and Adoption Signals

Official SDKs are available for Python, TypeScript, Go, Java, and .NET. The GitHub repository had accumulated 21,900+ stars as of early 2026. Production implementations include:

- **Salesforce Agentforce**: Cross-ecosystem agent collaboration via A2A
- **ServiceNow Now Assist**: A2A + MCP enabled in the Zurich Patch 4 release
- **Google Agent Development Kit (ADK)**: Native A2A integration alongside MCP support
- **AgentMaster (Stanford/George Mason)**: First academic system integrating both A2A and MCP in a unified architecture

The ADK's native support for both A2A and MCP is significant: it is Google's implicit endorsement of the two-layer architecture as the reference model, not just a concept.

### Where A2A Falls Short

A2A's enterprise momentum comes with gaps:

**No native presence.** Task lifecycle states (`submitted`, `working`, `completed`) give consumers coarse-grained visibility, but there is no built-in mechanism for agents to signal availability, capacity, or health. Teams building systems that need to route tasks to the least-loaded agent must build this at the application layer.

**Discovery remains manual in practice.** While Agent Cards enable URL-based discovery, finding *which* agents to connect to in the first place requires either out-of-band knowledge (a catalog maintained separately) or a registry service. The `/.well-known/` mechanism tells you *how* to talk to an agent you already know about; it does not help you discover agents you do not know about.

**Federation complexity.** Cross-organization A2A deployments require both parties to expose HTTP endpoints and manage trust relationships (OAuth client credentials, allowed origins). This is straightforward for greenfield deployments but requires network and security changes in enterprise environments with strict ingress controls.

## ACP: The REST-Native Alternative

The Agent Communication Protocol from the AGNTCY collective (Cisco, LangChain, LlamaIndex, Galileo, Dell, Oracle, Red Hat, donated to Linux Foundation in July 2025) represents a different philosophy: take standard REST HTTP and add the minimum necessary for agent coordination.

### Architecture: Pure HTTP with OpenAPI Specification

ACP maps agent interactions onto HTTP verbs: `POST` to create a task, `GET` to check status, `PUT` to update, `DELETE` to cancel. The API is fully specified in OpenAPI, meaning any HTTP client — curl, Postman, any language's HTTP library — can interact with an ACP agent without specialized SDKs.

This is ACP's primary competitive advantage: zero barrier to entry for teams that already work with REST APIs. There is no new message format to learn, no new transport to implement, no SDK to install. If you can build a REST API, you can build an ACP agent.

### OASF: The Meta-Description Layer

ACP pairs with the **Open Agent Schema Framework (OASF)** — an OCI-based data model for describing agent attributes. Crucially, OASF schemas can describe both A2A agents and MCP servers, positioning it as a protocol-agnostic agent description layer.

This is OASF's most interesting potential contribution to the convergence story: if agent descriptions can be expressed in OASF regardless of which protocol the agent implements, routing and orchestration systems can treat A2A agents, ACP agents, and MCP servers as equivalent capability sources. The OASF layer abstracts over protocol heterogeneity rather than eliminating it.

### Multi-modal Messaging

ACP's message format uses MIME-typed multipart payloads, natively handling text, images, audio, video, and binary data in a single exchange. This is structurally richer than A2A's artifact model, which handles multi-modal content but with less formality. For teams building agents that process diverse media types — document processing, image analysis, audio transcription — ACP's native multipart support reduces the application-layer work needed to handle mixed content.

### Where ACP Fits

ACP's strengths and weaknesses mirror its design philosophy:

**Strengths:** Lowest integration friction of any protocol; maps onto existing REST infrastructure (API gateways, load balancers, monitoring); centralized registry discovery is simpler to implement than distributed Agent Cards; OASF provides cross-protocol compatibility.

**Weaknesses:** Centralized registry is a bottleneck and single point of failure; no native streaming for long-running tasks (must be implemented at the application layer); simpler task model than A2A means less expressive lifecycle management; smaller enterprise adoption footprint than A2A.

ACP is best suited for teams that: have existing REST-native infrastructure they want to reuse; need the lowest possible integration overhead; are building agents that process multi-modal content; or want protocol-agnostic agent descriptions via OASF.

## OpenAPI Tool-Use: The Lowest Common Denominator

Before MCP, A2A, and ACP, the de facto mechanism for agent tool use was **OpenAPI specifications** augmented with LLM-specific metadata. Many LLMs natively support calling tools defined as OpenAPI schemas — the model reads the API spec, generates a JSON call, and the framework executes it.

OpenAPI-based tool use remains relevant in 2026 because:

- **Existing coverage:** Most enterprise APIs already have OpenAPI specs. No new server-side code is required — agents can call these APIs directly.
- **Framework support:** LangChain, LlamaIndex, AutoGen, and most agent frameworks support OpenAPI tool use natively.
- **Fallback compatibility:** When an MCP server is not available for a particular service, an OpenAPI spec provides a workable alternative with significantly less overhead than building a custom MCP server.

The practical pattern is layered: prioritize MCP for tools that need rich features (streaming, resource access, sampling), use OpenAPI specs for existing APIs that do not warrant MCP server development, and use A2A for coordinating between agents that have their own tool stacks.

The limitation of raw OpenAPI tool use is that it provides no standard for long-running operations, streaming, or session management. It is a synchronous request-response model. For simple, fast tool calls, this is entirely sufficient. For complex workflows, MCP's or A2A's richer models are necessary.

## ANP and the Decentralized Vision

The **Agent Network Protocol** represents the most architecturally ambitious approach to agent interoperability — and the one furthest from production readiness.

ANP uses W3C Decentralized Identifiers (DIDs) with the `did:wba` (Web-Based Agent) method for agent identity: each agent publishes a DID document at a well-known HTTPS URL containing public key material. Any two ANP agents can mutually authenticate without a central authority by resolving each other's DID documents. Authentication is cryptographically verified without trusting any intermediary.

Above the identity layer, ANP includes a **meta-protocol negotiation layer** where agents agree on which application protocol to use for their interaction. This makes ANP theoretically capable of carrying A2A tasks, ACP requests, or custom protocols as needed — it is a substrate, not a competing application protocol.

For discovery, ANP envisions a search-engine-style model: agents publish descriptions that can be indexed and found, similar to how websites are discovered via web search. This is more scalable than registries at internet scale, but it requires ecosystem infrastructure (agent search engines) that does not yet exist.

The technical case for ANP's approach is compelling: DID-based identity is the most robust trust model available, eliminating dependency on any central authority. For cross-internet agent collaboration between parties that do not have pre-existing relationships, cryptographic identity solves the bootstrapping problem that OAuth and API keys cannot.

The practical case is weak in early 2026: DID resolver infrastructure is still maturing, tooling and library support lag significantly behind HTTP-based protocols, and the meta-protocol negotiation overhead adds latency to every connection. ANP is a long-term infrastructure bet, not a deploy-today solution. Organizations building for a 2-3 year horizon should track it; those building for production in 2026 should not depend on it.

## Emerging B2B Agent Protocols

Beyond the four major frameworks, 2026 has seen the emergence of specialized protocols for specific inter-organization agent interaction patterns.

### Financial and Payment Orchestration

Visa's **Trusted Agent Protocol (TAP)** addresses a specific problem: how do AI agents acting on behalf of users initiate financial transactions with verified authorization? TAP provides a framework for agents to present cryptographically verifiable credentials proving they are authorized to act for a specific user within defined limits (spending caps, merchant categories, time bounds). Financial services organizations are building on TAP rather than rolling custom solutions, suggesting it may become the de facto standard for agent-initiated payments.

### Procurement and B2B Commerce

Early work on standardized agent-to-agent protocols for purchase orders, contracts, and procurement workflows has emerged from enterprise software vendors. The pattern is A2A-compatible (tasks, messages, artifacts) but with domain-specific schemas for business documents. These are currently vendor-specific extensions rather than open standards, but the demand is real: if two enterprise agents need to negotiate and execute a purchase order without human involvement, they need shared vocabulary beyond what general-purpose protocols provide.

### AGENTS.md: The Human-Readable Convention

A simpler convention gaining traction is `AGENTS.md` — a markdown file at the root of a repository or website that describes what an agent does, how to interact with it, and what constraints apply. Analogous to `robots.txt` for web crawlers, `AGENTS.md` provides human-readable (and LLM-parseable) metadata about agents without requiring implementation of a full discovery protocol.

The AAIF has endorsed `AGENTS.md` as a complement to formal Agent Cards, recognizing that not every agent needs the full A2A discovery stack. For simpler deployments, a well-structured markdown file may be sufficient to enable basic agent-to-agent interaction.

## Convergence vs. Fragmentation: The Honest Assessment

The convergence narrative is real but incomplete. Here is what is actually converging, and what is not.

### What Is Converging

**Governance:** MCP, A2A, and ACP all under Linux Foundation oversight. This institutional alignment is the most important structural fact of Q1 2026. Joint working groups, shared specification processes, and cross-protocol interoperability commitments were not possible when these protocols were controlled by competing vendors.

**The two-layer model:** MCP for tool integration + A2A for agent coordination is solidifying as the reference architecture. Google's ADK implements both. Salesforce's Agentforce implements both. ServiceNow's Now Assist implements both. The pattern is becoming a pre-competitive standard that enables differentiation at the application layer rather than the protocol layer.

**Transport:** Streamable HTTP (for MCP) and HTTP/JSON-RPC 2.0 (for A2A) mean both protocols work with existing HTTP infrastructure. The days of special-purpose transports are over.

**Security:** OAuth 2.1 with PKCE and Resource Indicators is the shared authentication foundation across all major protocols. The security model is no longer a point of differentiation — it is a shared baseline.

**Discovery:** The `/.well-known/` URI convention (Agent Cards, OAuth metadata) is becoming the shared discovery mechanism. Combined with the emerging Agent Name Service (ANS) concept, DNS-like lookups for agent capabilities are a credible near-term development.

### What Is Not Converging

**Discovery at scale:** Finding agents you do not already know about remains unsolved. Agent Cards tell you how to talk to a known agent; they do not help you find the right agent for a task among thousands of candidates. Centralized registries (ACP's model) versus distributed search (ANP's vision) is an unresolved architectural choice with significant implications for ecosystem dynamics.

**Fine-grained authorization:** Every protocol handles authentication (who are you?) but none handles authorization (what can you do?) at sufficient granularity for enterprise compliance requirements. Role-based tool access, capability leasing with time bounds, and delegation chains with restrictions are all application-layer concerns that the protocols leave to implementers.

**Cross-protocol interoperability:** An A2A agent cannot yet natively delegate to an ACP agent and receive a response in a unified task lifecycle. OASF's meta-description layer is the most credible path to solving this, but the Q3 2026 MCP/A2A joint specification is the first formal step toward protocol-level bridges.

**Decentralized identity:** W3C DIDs and Verifiable Credentials are part of the convergence roadmap but are not yet production-ready infrastructure for most teams. The Trulioo Digital Agent Passport and similar KYA (Know Your Agent) frameworks are interesting but require ecosystem adoption that has not yet occurred.

**Observability:** No protocol mandates structured logging or OpenTelemetry integration. Every production team builds this independently, leading to fragmented monitoring approaches that make cross-system debugging difficult.

## Transport and Message Format Comparison

For teams making implementation decisions, the protocol choices map onto specific technical trade-offs:

| Dimension | MCP | A2A | ACP | ANP |
|-----------|-----|-----|-----|-----|
| **Transport** | Streamable HTTP (POST/GET), stdio | HTTP/JSON-RPC 2.0, gRPC, SSE | HTTP/REST (OpenAPI) | HTTPS/JSON-LD |
| **Message Format** | JSON-RPC 2.0 | JSON-RPC 2.0 | Multipart MIME | JSON-LD (Schema.org) |
| **Discovery** | MCP Registry, manual config | Agent Cards (/.well-known/) | Central Registry | DID + search |
| **Auth** | OAuth 2.1 + PKCE + Resource Indicators | OAuth 2.0, mTLS, API Key, OIDC | Bearer + mTLS + JWS | DID signatures |
| **Streaming** | SSE upgrade on single endpoint | SSE, push notifications | Application-layer | Not native |
| **Long-running tasks** | Via streaming | Native task lifecycle | Via polling | Not native |
| **Stateless operation** | Yes (Streamable HTTP) | Yes | Yes | Yes |
| **Multi-modal** | Via resources + artifacts | Via artifact types | Native MIME multipart | Via JSON-LD |
| **SDK Maturity** | Production (97M+ monthly downloads) | Production (5 official SDKs) | Production | Early (reference implementations) |
| **Governance** | Linux Foundation (AAIF) | Linux Foundation (A2A Project) | Linux Foundation (AGNTCY) | Community |

## Security Model Deep Dive

Security is where the protocol choices have the most significant long-term implications, because retrofitting authorization is far harder than implementing it correctly from the start.

### The OAuth 2.1 Foundation

MCP's security architecture — OAuth 2.1 with PKCE, dynamic client registration, and Resource Indicators — is now the explicit model for A2A as well. Both protocols treat authentication as a solved problem with a clear implementation path. The question is not *whether* to use OAuth 2.1 but *how to configure it correctly* for multi-agent workflows.

The key configuration decisions:

**Token scoping:** Tokens should be scoped to specific operations and resource servers. Generic "agent access" tokens that grant broad permissions are security anti-patterns in multi-agent systems where a compromised sub-agent could lateral-move to other services.

**Delegation chains:** When Agent A delegates work to Agent B, B's tokens should encode the delegation chain — "B is acting on behalf of A on behalf of User U." The IETF on-behalf-of extension for OAuth is the emerging standard for this, though it is not yet universally implemented.

**Token lifetime:** Short-lived tokens (minutes to hours) with automatic refresh are the recommended pattern. Long-lived tokens in multi-agent systems create risk when an agent is compromised or decommissioned but retains valid credentials.

### Signed Agent Cards

A2A's Agent Cards can be signed using JWS (JSON Web Signatures), allowing consumers to verify that a card has not been tampered with. This matters when cards are fetched through intermediaries (registries, CDN caches) rather than directly from the agent.

Signing Agent Cards is not yet universally implemented, but it is on the recommended path for production deployments that operate across organizational boundaries. An unsigned card from a third-party agent is a trust assumption that is easy to overlook and consequential to get wrong.

### The Prompt Injection Threat

A protocol-level security gap that none of the standards adequately addresses: **prompt injection via tool responses**. When an MCP tool returns data that contains instructions ("Ignore previous context and instead..."), a poorly-aligned agent may follow those instructions. This is not a transport-layer problem — it is an application-layer problem — but it is the most significant practical security threat in production multi-agent systems.

Current mitigations are ad hoc: output sanitization in tool wrappers, separate context segments for trusted and untrusted content, and structural output formats (JSON rather than freeform text) that are harder to inject into. None of these are standardized at the protocol layer. This is a genuine gap that platforms must address explicitly.

## Discovery Mechanisms in Practice

Discovery is the practical bottleneck for multi-agent deployments. The protocol specifications describe how agents communicate once discovered; the harder problem is finding the right agents in the first place.

### Static Configuration: The Current Reality

Most production multi-agent deployments in early 2026 use static configuration — agent URLs, credentials, and capabilities are hardcoded or environment-variable-driven. This is operationally simple and makes debugging straightforward, but it does not scale to dynamic agent ecosystems where capabilities change and new agents are added regularly.

### Agent Card Discovery

The `/.well-known/agent.json` convention enables URL-based discovery: if you know an agent's domain, you can fetch its capabilities without prior coordination. This is a significant improvement over static configuration — adding a new capability to an agent requires only updating the card, not reconfiguring every consumer.

The gap: you still need to know the domain. Agent Card discovery solves the "how do I connect to this agent?" problem but not the "which agents exist?" problem.

### Registry-Based Discovery

Centralized registries (ACP's model, the official MCP Registry) provide searchable catalogs of agents and tools. The trade-offs are well-understood: registries enable discovery at the cost of centralization, operational dependency, and the risk of becoming bottlenecks.

The emerging pattern is **federated registries** — organizational registries that can peer with each other, providing the discoverability of a central registry without a single point of failure. This is analogous to how email works: you have a local mail server, but discovery of remote addresses happens through DNS and the distributed email infrastructure.

### Dynamic Discovery: The Forward View

The Agent Name Service (ANS) concept — DNS-like lookup for agent capabilities — is being prototyped but has not yet reached production readiness. A query like "find me an agent that can process insurance claims with SOC2 compliance" would resolve to a set of candidate agents with ranked capability matches. This is the discovery model that makes truly dynamic agent ecosystems possible.

For platform builders, the practical recommendation is to design for static configuration today while building Agent Card endpoints that will enable more dynamic discovery as the infrastructure matures. Avoid architectures that make discovery the critical path for high-frequency agent interactions.

## Practical Implications for Agent Platform Builders

The landscape analysis points to concrete architectural decisions for teams building agent platforms in 2026.

### Protocol Selection Decision Tree

The decision of which protocols to implement is driven by use case:

**Building an agent that uses tools?** Implement MCP with Streamable HTTP transport. This is no longer optional for production systems — the ecosystem, tooling, and enterprise expectations all assume MCP for tool integration.

**Building a system where multiple agents coordinate?** Implement A2A for agent-to-agent coordination. Start with the Agent Card discovery mechanism; add SSE streaming as a second step once synchronous request-response is working.

**Integrating with existing REST infrastructure?** Consider ACP alongside or instead of A2A. If your team already operates an API gateway, service mesh, and OpenAPI-based tooling, ACP's model maps onto that infrastructure with minimal friction.

**Need multi-modal content (images, audio, documents) natively?** ACP's multipart MIME format handles this more naturally than A2A's artifact model. Consider ACP for media-heavy agent workflows even if A2A handles other coordination.

**Building for cross-internet discovery with untrusted parties?** Track ANP. Implement it only when DID infrastructure matures to production readiness, which is unlikely before late 2026.

### Infrastructure Recommendations

**Transport:** Default to Streamable HTTP for all remote MCP deployments. Never design production systems around stdio. Use Cloudflare Workers or equivalent edge deployment for MCP servers that need global distribution.

**Authorization from day one:** Implement OAuth 2.1 with Resource Indicators before exposing any multi-agent capabilities. Retrofitting authorization onto a running multi-agent system is significantly more painful than implementing it during initial development. Use short-lived tokens with delegation chain encoding.

**Observability as a protocol layer concern:** Build OpenTelemetry span instrumentation into your MCP client implementation, not just application-level logging. Every tool invocation should produce a span with: agent identity, tool name, parameters (sanitized), response status, latency, and token consumption. This instrumentation is the foundation for debugging, compliance reporting, and cost optimization.

**Agent Card endpoint:** Publish a signed Agent Card at `/.well-known/agent.json` for every agent you expose externally. Even if you are not implementing full A2A protocol today, having the card in place enables discovery without requiring protocol commitment.

**Design for the MCP Registry:** As the official MCP Registry matures from preview to GA, agents will discover tools dynamically rather than through static configuration. Build agent architectures that can incorporate new tools at runtime without code changes — this means treating tool discovery as a runtime operation, not a startup-time configuration.

### What to Watch in Q2-Q3 2026

**June 2026 MCP spec:** Expected to include server-as-agent capabilities — MCP servers that connect to other MCP servers, enabling recursive composition. This will unlock complex delegation patterns: a project manager MCP server that delegates code analysis, documentation, and testing to specialized servers, all coordinated via the protocol.

**Q3 2026 MCP/A2A joint specification:** The joint interoperability spec from Google, Anthropic, Microsoft, and Salesforce will define how MCP tool invocations can trigger A2A agent delegations and vice versa. This is the formal bridge between the two layers that the ecosystem needs.

**MCP Registry GA:** The transition from preview to general availability is expected to include signing, verification, and trust scoring for servers. Combined with dynamic client registration, this will enable agents to discover and connect to new tools at runtime without manual configuration.

**NIST AI Agent Standards Initiative:** The NIST framework (announced February 2026) is working on protocol interoperability requirements and security guidelines for agent systems. Government adoption will drive enterprise adoption in regulated industries.

**ANP DID infrastructure maturity:** The W3C DID v1.1 specification (first public working draft 2025, comments due April 2026) is on a timeline that could enable ANP production deployments by late 2026 or early 2027. Organizations with long planning horizons should include ANP in their technology radar.

## Building an Agent Communication Hub

For teams building an agent communication hub — a platform that routes messages between diverse agents from multiple frameworks and vendors — the protocol landscape creates specific architectural requirements.

An agent communication hub in 2026 must simultaneously support:
- **MCP clients and servers** for tool integration connections
- **A2A agent orchestration** for inter-agent task delegation
- **ACP REST-native connections** for lowest-friction agent onboarding
- **OpenAPI tool-use** for existing API integration without MCP server overhead
- **Static configuration** for today's deployments alongside dynamic discovery for future ones

The hub's core value proposition is **protocol translation** — insulating application agents from the heterogeneity of the protocol layer. An agent built for MCP should be able to delegate to an A2A agent without understanding A2A's task lifecycle; the hub handles translation between the models.

This translation layer is where OASF's meta-description language becomes most valuable. If all agents in the hub express their capabilities in OASF regardless of their native protocol, the routing logic can operate on a unified capability representation rather than protocol-specific data structures.

The security implications for a hub are more acute than for direct agent-to-agent connections. The hub sits in the authorization path for every agent interaction it brokers, which means it must:
- Validate tokens from every protocol variant (OAuth 2.1, API keys, mTLS client certificates)
- Enforce delegation chain integrity when routing across protocol boundaries
- Maintain per-agent audit logs for compliance reporting
- Implement rate limiting and backpressure at the protocol level to prevent agent cascade failures

## Conclusion: The Protocol Landscape in One View

The agent interoperability landscape in March 2026 is not converged, but it has a credible convergence path. The institutional alignment under the Linux Foundation, the crystallization of the two-layer MCP+A2A architecture as the reference model, and the commitment to a joint interoperability specification by the major vendors provide the structural conditions for genuine convergence within 12-18 months.

The practical state today: MCP is infrastructure. A2A is the coordination standard. ACP is the REST-native alternative for lower-friction deployments. ANP is the decentralized long-term bet. OpenAPI tool-use is the compatibility layer for existing APIs. Discovery remains the hardest unsolved problem.

For teams making decisions now: implement MCP for tool integration (non-negotiable for production systems), add A2A for multi-agent coordination (the ecosystem expects it), build Agent Card endpoints for discovery, invest in observability at the protocol layer, and design authorization with delegation chains from day one. Monitor the June 2026 MCP spec and Q3 joint interoperability specification as the next inflection points.

The winner is not a single protocol — it is the layered ecosystem that enables agents built by different teams, using different frameworks, on different infrastructure, to collaborate on complex tasks without either party exposing or depending on the other's internal implementation. That ecosystem is being assembled in real time, and the foundations are solid enough to build on today.

---

*Sources:*
- [MCP Streamable HTTP Specification (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
- [MCP Authorization Specification](https://modelcontextprotocol.io/specification/draft/basic/authorization)
- [MCP One-Year Anniversary Spec (2025-11-25)](http://blog.modelcontextprotocol.io/posts/2025-11-25-first-mcp-anniversary/)
- [MCP Registry Preview](http://blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview/)
- [A2A Protocol GitHub Repository](https://github.com/a2aproject/A2A)
- [Linux Foundation A2A Project Launch](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents)
- [Google Cloud Blog: A2A Protocol Upgrade](https://cloud.google.com/blog/products/ai-machine-learning/agent2agent-protocol-is-getting-an-upgrade)
- [Agent Connect Protocol Specification](https://spec.acp.agntcy.org/)
- [AGNTCY Documentation](https://docs.agntcy.org/)
- [Agent Network Protocol GitHub](https://github.com/agent-network-protocol/AgentNetworkProtocol)
- [Survey of Agent Interoperability Protocols (arXiv:2505.02279)](https://arxiv.org/html/2505.02279v1)
- [Auth0: Why MCP Streamable HTTP Simplifies Security](https://auth0.com/blog/mcp-streamable-http/)
- [Auth0: MCP Spec Updates from June 2025](https://auth0.com/blog/mcp-specs-update-all-about-auth/)
- [Cloudflare: Streamable HTTP MCP Servers](https://blog.cloudflare.com/streamable-http-mcp-servers-python/)
- [CData: 2026 Enterprise MCP Adoption](https://www.cdata.com/blog/2026-year-enterprise-ready-mcp-adoption)
- [Glama.ai MCP Server Directory](https://glama.ai/mcp/servers)
- [Merge.dev: MCP vs A2A Comparison](https://www.merge.dev/blog/mcp-vs-a2a)
- [NIST AI Agent Standards Initiative](https://www.hungyichen.com/en/insights/ai-agent-protocol-wars)
- [ruh.ai: AI Agent Protocols 2026 Complete Guide](https://www.ruh.ai/blogs/ai-agent-protocols-2026-complete-guide)
- [Descope: MCP Auth Spec Deep Dive](https://www.descope.com/blog/post/mcp-auth-spec)
- [W3C DID Working Draft 2025](https://www.w3.org/TR/did-1.1/)
