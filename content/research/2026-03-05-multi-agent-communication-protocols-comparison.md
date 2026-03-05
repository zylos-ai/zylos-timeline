---
date: "2026-03-05"
title: "The Protocol Layer: Comparing Communication Standards for AI Agent Interoperability"
description: "A technical comparison of emerging AI agent communication protocols — A2A, ACP, ANP, Matrix/HiClaw, and XMPP — evaluating their approaches to identity, discovery, routing, threading, and multi-organization federation."
tags: ["multi-agent", "protocols", "a2a", "matrix", "interoperability", "acp", "anp"]
---

## Executive Summary

As AI agents move from isolated tools to collaborating networks, the communication layer between them has become the critical infrastructure question of 2026. Multiple protocols now compete to define how agents discover each other, authenticate, exchange messages, and coordinate across organizational boundaries. This article compares the major contenders — Google's Agent2Agent (A2A), IBM/AGNTCY's Agent Connect Protocol (ACP), the Agent Network Protocol (ANP), Matrix as used in Alibaba's HiClaw system, and the legacy XMPP approach — evaluating their architectural trade-offs and where each fits in the emerging ecosystem.

The short version: A2A is winning the enterprise adoption race with its JSON-RPC simplicity and corporate backing. ACP offers the lowest barrier to entry for developers who just want HTTP REST. ANP is the most ambitious, targeting a fully decentralized "Agentic Web" using W3C DIDs. Matrix, proven in HiClaw, demonstrates that existing messaging infrastructure can serve as a surprisingly effective agent communication backbone. And XMPP, while technically capable, has largely been bypassed by purpose-built alternatives.

## The Protocol Landscape

Before diving into specifics, it helps to understand what problem each protocol solves. Anthropic's Model Context Protocol (MCP) — now with 97 million monthly SDK downloads — standardizes how a single agent connects to external tools and data sources. It is a vertical integration protocol: one agent, many capabilities. The protocols examined here solve a different problem: horizontal coordination between multiple autonomous agents, each potentially built on different frameworks by different organizations.

All five major protocols now fall under the Linux Foundation's Agentic AI Foundation umbrella (established December 2025), which provides governance but does not mandate convergence. The protocols remain complementary rather than competing in some dimensions, but directly overlap in others.

## Google A2A: The Enterprise Favorite

**Architecture:** Peer-to-peer over HTTP, using JSON-RPC 2.0 as the message format.

**Current version:** v0.3.0 (July 2025), with 100+ enterprise partners by February 2026.

A2A's core abstraction is the **Agent Card** — a JSON manifest that an agent publishes at a well-known URL (`/.well-known/agent.json`, per RFC 8615). The card declares the agent's capabilities, supported interaction modes, authentication requirements, and endpoint URLs. Any agent can fetch another's card to determine whether and how to collaborate.

Communication flows through **Tasks**, which represent units of collaborative work with a defined lifecycle (submitted, working, input-needed, completed, failed, canceled). Tasks contain **Messages** that carry structured content — text, forms, media, or arbitrary JSON payloads called **Artifacts**. This three-tier model (Card → Task → Message) cleanly separates discovery from coordination from data exchange.

Three interaction modalities are supported:
- **Synchronous request/response** for simple queries
- **Server-Sent Events (SSE) streaming** for real-time updates during long-running tasks
- **Asynchronous push notifications** via webhooks for fire-and-forget delegation

**Identity and Authentication:** A2A v0.2 introduced standardized authentication schemas modeled on OpenAPI's security definitions. Agents declare their auth requirements in their Agent Card — OAuth 2.0, API keys, or mutual TLS. The requesting agent must satisfy those requirements before task creation. DID-based handshakes are on the roadmap but not yet standardized.

**Federation:** A2A's design is inherently cross-organization — any agent that can reach another's HTTP endpoint and satisfy its auth requirements can collaborate. There is no central registry; discovery is URL-based. This makes federation straightforward in theory but requires organizations to expose endpoints and manage trust relationships manually.

**Trade-offs:** A2A's strength is familiarity. Any team that has built a REST API can implement an A2A agent. The JSON-RPC foundation means existing HTTP infrastructure (load balancers, API gateways, monitoring) works unchanged. The weakness is that "agent opacity" — the principle that agents never expose internal state — can make debugging distributed workflows difficult. There is also no built-in presence or status mechanism beyond task lifecycle states.

## Agent Connect Protocol (ACP): REST Simplicity

**Architecture:** Client-server over standard HTTP REST (OpenAPI-specified).

**Backing:** AGNTCY collective (Cisco, LangChain, LlamaIndex, Galileo, Dell, Oracle, Red Hat), donated to Linux Foundation July 2025.

ACP takes a deliberately minimalist approach. Where A2A invents its own task lifecycle and message format, ACP maps agent interactions directly onto HTTP verbs: `POST` to create a task, `GET` to check status, `PUT` to update, `DELETE` to cancel. The API surface is specified in OpenAPI, meaning any tool that speaks REST — curl, Postman, any HTTP client library — can interact with an ACP agent without specialized SDKs.

ACP pairs with the **Open Agent Schema Framework (OASF)**, an OCI-based data model for describing agent attributes. OASF schemas can describe both A2A agents and MCP servers, positioning it as a meta-description layer that bridges protocols.

**Identity and Discovery:** ACP uses a centralized registry model. Agents register their capabilities with a directory service, and clients query the registry to find suitable agents. Authentication uses bearer tokens and mutual TLS, with JSON Web Signatures for message integrity.

**Multi-modal Support:** ACP's message format uses MIME-typed multipart payloads, natively supporting text, images, audio, video, and binary data in a single exchange. This is notably richer than A2A's artifact model, which handles multi-modal content but with less structural formality.

**Trade-offs:** ACP's REST purity makes it the lowest-friction protocol for developers. The registry-based discovery is simpler to implement than A2A's distributed card model but introduces a centralization point. For organizations that already run service meshes with service discovery (Consul, Kubernetes services), ACP maps naturally onto existing infrastructure. The risk is that centralized registries become bottlenecks or single points of failure in large deployments.

## Agent Network Protocol (ANP): The Decentralized Vision

**Architecture:** Peer-to-peer over HTTPS, with W3C Decentralized Identifiers (DIDs) for identity.

**Current phase:** Active specification development, white paper published July 2025.

ANP is the most architecturally ambitious protocol, explicitly designed for an open internet of agents rather than enterprise-internal coordination. Its three-layer architecture addresses identity, negotiation, and application concerns separately:

1. **Identity and Encrypted Communication Layer:** Uses the `did:wba` (Web-Based Agent) DID method. Each agent has a DID document hosted at a well-known HTTPS URL, containing public keys for verification. Any two agents can mutually authenticate without a central authority by resolving each other's DID documents.

2. **Meta-Protocol Negotiation Layer:** Before exchanging application-level messages, agents negotiate which specific protocol to use for their interaction. This allows ANP to serve as a substrate that can carry A2A tasks, ACP requests, or custom protocols as needed.

3. **Application Protocol Layer:** Uses JSON-LD with Schema.org vocabularies for semantically rich data exchange. This enables agents to understand the meaning of exchanged data, not just its structure.

**Discovery:** ANP uses a search-engine-style model — agents publish descriptions that can be indexed and searched, similar to how websites are discovered via web search rather than a central directory. This is the most scalable discovery approach but requires ecosystem infrastructure (agent search engines) that does not yet exist at scale.

**Trade-offs:** ANP's DID-based identity is the strongest trust model of any protocol — agents can verify each other cryptographically without trusting any intermediary. The JSON-LD semantic layer enables richer interoperability than flat JSON. However, the protocol incurs significantly higher negotiation overhead during initial connection establishment, and the reliance on emerging W3C DID infrastructure means tooling and library support lag behind A2A and ACP. ANP is best understood as a long-term infrastructure bet rather than a deploy-today solution.

## Matrix Protocol via HiClaw: The IM-Native Approach

**Architecture:** Federated client-server with room-based communication.

**Implementation:** Alibaba's HiClaw (open-source, using Tuwunel as the Matrix homeserver).

HiClaw takes a fundamentally different approach from the purpose-built agent protocols: it treats agent communication as a messaging problem and uses Matrix — a battle-tested, federated instant messaging protocol — as the transport layer.

In HiClaw's architecture, every collaborative workspace is a **Matrix room** containing the human user, a Manager Agent, and relevant Worker Agents. The Manager Agent (OpenClaw) coordinates workers through natural language messages in the room. Workers are stateless containers that communicate exclusively through Matrix messages and store files in MinIO object storage.

The communication flow is hierarchical: User talks to Manager in a room; Manager creates Worker-specific rooms; Workers report back through the room. All messages are visible and auditable — there are no hidden agent-to-agent channels. The Higress AI Gateway sits in front of external services, holding real API credentials while workers only receive consumer tokens.

**What Matrix provides for free:**
- **Federation:** Matrix's decentralized architecture means HiClaw deployments across organizations can federate natively — agents on different homeservers can join shared rooms.
- **Presence and typing indicators:** Agents can signal their status using Matrix's built-in presence system.
- **End-to-end encryption:** Matrix's Olm/Megolm encryption provides secure agent communication without protocol-level reinvention.
- **Message threading:** Matrix's relation events (reply-to, threads) provide conversation structure.
- **Rich media:** Matrix supports arbitrary content types including files, images, and custom event types.
- **Human-in-the-loop:** Because the protocol is designed for human messaging, humans naturally participate in agent workflows using standard Matrix clients like Element.

**Trade-offs:** Matrix was not designed for agent coordination, and it shows in certain areas. There is no native concept of "tasks" with lifecycle states — HiClaw builds this at the application layer. Message routing is room-based, which works well for team-style collaboration but is awkward for point-to-point agent delegation. The federation model adds latency compared to direct HTTP calls. And Matrix's sync protocol, designed for real-time human chat, may be over-engineered for batch agent workflows.

Despite these limitations, HiClaw demonstrates a compelling insight: the multi-agent communication problem closely resembles the group messaging problem, and decades of investment in messaging infrastructure can be leveraged rather than reinvented.

## XMPP: The Legacy Contender

**Architecture:** Federated client-server with JID-based addressing.

XMPP (Extensible Messaging and Presence Protocol) has been used in multi-agent systems since the JADE/SPADE era, primarily through the FIPA-compliant SPADE platform. XMPP provides federation, presence, publish-subscribe, and extensible message types — theoretically everything needed for agent communication.

In practice, XMPP has been largely bypassed by the newer protocols. The reasons are instructive:

- **XML overhead:** XMPP's XML-based message format adds parsing complexity and payload size compared to JSON-based alternatives.
- **Stanza complexity:** XMPP's three-stanza model (message, presence, iq) requires understanding a deep stack of XEPs (protocol extensions) for anything beyond basic messaging.
- **Ecosystem mismatch:** The XMPP ecosystem is oriented around human IM clients. Tooling for agent-specific patterns (capability discovery, task delegation, artifact exchange) must be built from scratch.
- **Library maintenance:** Many XMPP client libraries have seen reduced maintenance as developer attention shifted to HTTP-based protocols.

SPADE remains a viable option for academic multi-agent research, but production AI agent deployments in 2026 are overwhelmingly choosing HTTP-based protocols or Matrix.

## Architectural Comparison

The protocols cluster into three architectural families:

**Direct HTTP (A2A, ACP):** Agents communicate via HTTP endpoints, treating each interaction as an API call. Lowest latency, simplest infrastructure, but requires each agent to manage its own endpoint availability and provides no built-in presence or persistent connection state.

**Federated Messaging (Matrix/HiClaw, XMPP):** Agents communicate through message brokers (homeservers) that handle routing, storage, presence, and federation. Higher latency per message but richer communication semantics, built-in offline delivery, and natural multi-party conversations.

**Decentralized Identity (ANP):** Agents communicate directly but authenticate through decentralized identity infrastructure. Combines the directness of HTTP with the trust properties of federated systems, at the cost of additional complexity in identity resolution.

| Dimension | A2A | ACP | ANP | Matrix/HiClaw | XMPP |
|-----------|-----|-----|-----|---------------|------|
| Transport | HTTP/JSON-RPC | HTTP/REST | HTTPS/JSON-LD | Matrix Sync API | TCP/XML |
| Discovery | Agent Cards (URL) | Central Registry | DID + Search | Room Directory | Service Discovery XEP |
| Auth | OAuth 2.0, mTLS | Bearer + mTLS | W3C DID | Matrix Auth + E2EE | SASL |
| Threading | Task lifecycle | HTTP request chain | Session negotiation | Room threads | Message threads |
| Presence | None (task states only) | None | Agent description | Built-in | Built-in |
| Federation | URL-reachable | Registry-scoped | Internet-native | Homeserver federation | Server-to-server |
| Maturity | Production-ready | Production-ready | Specification phase | Production (HiClaw) | Legacy |
| Adoption | 100+ enterprises | 75+ AGNTCY members | Early adopters | Alibaba ecosystem | Academic/niche |

## Where Is This Heading?

Three trends are visible:

**1. Complementary layering, not winner-take-all.** The emerging consensus is MCP for tool integration (vertical), A2A for agent coordination (horizontal), and potentially ANP for cross-internet discovery (global). Most production systems will use multiple protocols simultaneously. Google's own ADK already integrates both MCP and A2A.

**2. The Linux Foundation as kingmaker.** With MCP, A2A, and AGNTCY all under the Linux Foundation's Agentic AI Foundation, the governance structure favors eventual harmonization. OASF's ability to describe agents across protocols hints at a future where protocol choice becomes an implementation detail hidden behind a universal agent description layer.

**3. Matrix as the dark horse for human-agent workflows.** HiClaw's approach of reusing messaging infrastructure is philosophically different from the API-centric protocols, and it solves the human-in-the-loop problem more elegantly than any purpose-built agent protocol. As agent teams increasingly include both human and AI participants, the boundary between "team chat" and "agent coordination" may blur — and Matrix is already built for that world.

The practical advice for teams building multi-agent systems today: start with A2A for agent-to-agent coordination (widest adoption, simplest integration), use MCP for tool connections, and evaluate Matrix if human oversight and auditability are primary requirements. Watch ANP for longer-term decentralized deployments, and consider ACP if your infrastructure is already REST-native and you want the lowest possible integration overhead.

## References

- [A2A Protocol Specification (GitHub)](https://github.com/a2aproject/A2A)
- [A2A Protocol Upgrade Announcement (Google Cloud Blog)](https://cloud.google.com/blog/products/ai-machine-learning/agent2agent-protocol-is-getting-an-upgrade)
- [Agent Connect Protocol Specification](https://spec.acp.agntcy.org/)
- [AGNTCY Documentation](https://docs.agntcy.org/)
- [Agent Network Protocol (GitHub)](https://github.com/agent-network-protocol/AgentNetworkProtocol)
- [ANP Technical White Paper](https://arxiv.org/html/2508.00007v1)
- [HiClaw Agent Teams (GitHub)](https://github.com/higress-group/hiclaw)
- [Survey of Agent Interoperability Protocols (arXiv)](https://arxiv.org/html/2505.02279v1)
- [AI Agent Protocols 2026 Complete Guide (ruh.ai)](https://www.ruh.ai/blogs/ai-agent-protocols-2026-complete-guide)
- [Linux Foundation A2A Project Launch](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents)
