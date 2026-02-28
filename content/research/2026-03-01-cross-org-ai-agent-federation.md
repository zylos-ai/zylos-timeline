---
date: "2026-03-01"
title: "Cross-Organization AI Agent Federation: Trust, Discovery, and Secure Interoperability"
description: "How AI agents from different organizations discover each other, establish trust, and interact securely across organizational boundaries — the protocols, patterns, and open challenges defining the federated agentic web."
tags:
  - research
  - ai-agents
  - federation
  - security
  - interoperability
  - protocols
---

## Executive Summary

The agentic AI era is shifting from single-organization deployments toward cross-organizational agent ecosystems where agents built by different vendors, running on separate infrastructure, must discover, authenticate, and collaborate with one another in real time. This creates a new class of infrastructure challenge: federated agent trust. Without standardized identity, discovery, and security patterns, every cross-org integration becomes a bespoke bilateral agreement — unscalable at the pace AI adoption demands.

The 2025–2026 period has seen rapid movement: Google's Agent2Agent (A2A) protocol donated to the Linux Foundation, the IETF Agent Name Service (ANS) draft, SPIFFE/SPIRE workload identity adopted for AI agents, and OAuth 2.0 delegation patterns extended to cover multi-hop agent chains. The parallels to earlier federation challenges — email, the fediverse, federated identity — are instructive. Each solved a version of this problem. AI agent federation is harder because agents act autonomously, generate legal liability, and cross compliance boundaries in real time.

Key takeaways:
- **Discovery is the first unsolved problem.** No universal agent registry exists. A2A Agent Cards and ANS are competing approaches.
- **Trust must be cryptographic, not organizational.** Signed credentials, mTLS, and SPIFFE IDs are replacing API-key-based bilateral trust.
- **Liability travels with the instruction chain.** Organizations remain the legal risk-holder for their agents' cross-org actions until legislation catches up.
- **Hub-and-spoke federation is winning short-term.** Fully decentralized mesh federation remains aspirational for most enterprises in 2026.

---

## The Cross-Org Federation Problem

Traditional software integration between organizations uses fixed APIs, documented contracts, and human-negotiated access agreements. AI agents break this model in three ways:

1. **Agents are autonomous.** They don't just call APIs — they reason, delegate sub-tasks, spawn sub-agents, and make decisions that may trigger further cross-org interactions not anticipated at design time.
2. **Agents are ephemeral.** Sessions spin up and down. Credentials issued to an agent today may be useless tomorrow, but revocation across org boundaries is not standardized.
3. **Agents are principals.** An agent from Org A interacting with an agent from Org B is not just an API call — it is a legal and security event with accountability implications for both organizations.

The result is that cross-org agent interaction requires a new trust stack that doesn't yet fully exist. As of early 2026, only 23% of organizations have a formal strategy for agent identity management.

---

## Federated Identity and Trust Models

### OAuth 2.0 and Delegation Chains

OAuth 2.0 remains the dominant framework, extended for agentic contexts in two key ways:

**OAuth 2.0 Rich Authorization Requests (RAR)** allows agents to express fine-grained permission claims in machine-readable language rather than coarse scopes. Instead of `read:email`, an agent can request "read email threads from the last 7 days related to project X, on behalf of user Y."

**Token Exchange (RFC 8693)** — the on-behalf-of profile — cryptographically binds an actor (the agent) to a delegator (the human or service granting authority). This preserves the chain of accountability across multi-hop agent delegation:

```
User → Agent A (Org 1) → Agent B (Org 2) → Resource Server
         |                    |
    Delegation Token    Impersonation/
    (scoped, signed)    Actor Token bound
                        to original delegator
```

The key property: a compromised agent downstream in the chain cannot escalate beyond the permissions granted at the origin.

### Decentralized Identifiers (DIDs) and Verifiable Credentials

For fully decentralized cross-org trust — where no shared identity provider exists — DIDs provide cryptographically verifiable, self-sovereign identifiers that don't depend on a central authority. An AI agent issued a DID can carry:

- Its organizational affiliation
- Its capability set (what it is authorized to do)
- Its behavioral scope (what data it may access)
- A cryptographic proof of provenance (signed by its deploying organization)

Verifiable Credentials (VCs) built on top of DIDs allow one organization to attest to an agent's properties, and a second organization to verify those attestations without contacting the issuer in real time — analogous to checking a signed certificate rather than calling the CA on every request.

This mirrors the PKI model for TLS but applied to agent identity and capabilities. The Trust Fabric paper (arXiv:2507.07901) frames this as the foundation of the "agentic web" — a decentralized economic and trust coordination layer.

### SPIFFE/SPIRE: Workload Identity for Agents

For infrastructure-level agent-to-agent communication, SPIFFE (Secure Production Identity Framework for Everyone) and its reference implementation SPIRE provide workload identities — cryptographic identities tied to the running process, not to a human or API key.

SPIFFE IDs are short-lived, automatically rotated, and tied to the workload's deployment context (cluster, namespace, service account). For AI agents:

- Each agent runtime is issued a SPIFFE ID at startup
- mTLS between agents uses these identities, eliminating shared secrets
- Identity is verifiable across organizational boundaries using federated SPIFFE trust domains

```
Org A Trust Domain          Org B Trust Domain
┌─────────────────────┐     ┌─────────────────────┐
│  SPIRE Server A     │◄───►│  SPIRE Server B     │
│  (issues SVIDs)     │     │  (issues SVIDs)     │
└────────┬────────────┘     └────────┬────────────┘
         │                           │
    Agent A                     Agent B
    spiffe://orgA/agent-1       spiffe://orgB/agent-2
         │                           │
         └──────── mTLS ─────────────┘
```

HashiCorp Vault 1.21 added native SPIFFE authentication in 2025, making this pattern production-viable for enterprises already using Vault.

---

## Agent Discovery Protocols

### A2A Agent Cards

Google's Agent2Agent (A2A) protocol, now under Linux Foundation governance, introduces the **Agent Card** as the fundamental discovery primitive. An Agent Card is a JSON document published at a well-known URL by each agent, describing:

- Agent identity and organizational affiliation
- Supported capabilities and skills (in structured, machine-readable form)
- Communication endpoints and supported protocols (HTTP, gRPC, streaming)
- Authentication requirements and accepted credential types
- Version and compatibility metadata

As of A2A v0.3 (July 2025), Agent Cards are **signed** — the publishing organization cryptographically signs the card, allowing consuming agents to verify authenticity without a live trust authority.

```json
{
  "agentId": "acme-procurement-agent",
  "organization": "acme.com",
  "capabilities": ["purchase-order-negotiation", "supplier-lookup"],
  "endpoint": "https://agents.acme.com/procurement/a2a",
  "auth": { "type": "oauth2", "scopes": ["agent:interact"] },
  "signature": "eyJhbGciOiJFZERTQSJ9..."
}
```

A2A defines four interaction phases: discovery (via Agent Cards), task negotiation, task execution with lifecycle management, and result delivery. The protocol is transport-agnostic and supports both synchronous request/response and long-running async task patterns — critical for cross-org workflows that may span hours.

### Agent Name Service (ANS)

The IETF Internet-Draft `draft-narajala-ans-00` proposes the **Agent Name Service** — a DNS-inspired naming and discovery system for AI agents. ANS maps human-readable agent names to verified capability metadata, cryptographic keys, and endpoints, using PKI certificates for identity anchoring.

GoDaddy launched a public ANS API and standards site in 2025, positioning itself as a registry operator analogous to domain registrars. The architecture is explicitly DNS-like:

- Agents register under organizational namespaces (`procurement.acme.ans`)
- Resolvers return capability-aware records, not just IP addresses
- DNSSEC-equivalent signing provides tamper-evident records
- Multiple registry operators can federate, avoiding a single point of control

ANS and A2A are complementary: ANS handles the naming/discovery layer, A2A handles the interaction protocol layer. Expect convergence or formal integration in 2026.

### Centralized Registries vs. Decentralized Mesh

Current agent registries divide into three architectural camps:

| Approach | Examples | Trade-offs |
|----------|----------|------------|
| Centralized registry | NANDA Index, MCP Metaregistry, Enterprise MCP Gateway | Simple ops, vendor lock-in risk, single failure point |
| Federated hub-and-spoke | A2A with curated registries, enterprise gateways | Practical for enterprises, controlled trust perimeter |
| Fully decentralized | ANS with multiple operators, DID-based discovery | Censorship-resistant, higher operational complexity |

For cross-org enterprise use cases, hub-and-spoke federation dominates in 2026. Fully decentralized mesh remains aspirational.

---

## Security Architecture Patterns

### Zero-Trust for Agent Networks

The core principle: **never trust an agent, always verify.** Zero-trust applied to agent federation means:

- Every agent interaction is authenticated, regardless of network position
- Permissions are scoped minimally and evaluated at each request, not once at session start
- Agents are assumed potentially compromised; blast radius is bounded by scope
- All cross-org interactions are logged for audit and forensics

The Cloud Security Alliance's Agentic Trust Framework (published February 2026) formalizes this into five controls: identity verification, capability attestation, context-bound authorization, behavioral monitoring, and real-time revocation.

### The Gateway Pattern for Cross-Org Federation

Rather than direct agent-to-agent connections across org boundaries, enterprises are adopting **agent gateway** patterns:

```
         Organization A                    Organization B
┌──────────────────────────┐    ┌──────────────────────────┐
│  Internal                │    │  Internal                │
│  Agent Network           │    │  Agent Network           │
│  ┌────┐  ┌────┐         │    │         ┌────┐  ┌────┐  │
│  │ A1 │  │ A2 │         │    │         │ B1 │  │ B2 │  │
│  └────┘  └────┘         │    │         └────┘  └────┘  │
│       │                  │    │              │           │
│  ┌────▼──────────────┐  │    │  ┌───────────▼───────┐  │
│  │  Egress Gateway   │  │    │  │  Ingress Gateway  │  │
│  │  - Auth signing   │  │    │  │  - Auth verify    │  │
│  │  - Policy enforce │  │    │  │  - Rate limiting  │  │
│  │  - Audit logging  │  │    │  │  - Scope checking │  │
│  └────────┬──────────┘  │    │  └────────┬──────────┘  │
└───────────┼─────────────┘    └───────────┼─────────────┘
            │                              │
            └──────── mTLS + signed ───────┘
                      Agent Cards
```

The gateway enforces organizational policy at the boundary: outbound requests are signed with org credentials; inbound requests are verified against known agent registries and scoped to allowed capabilities. Internal agents never directly expose themselves cross-org.

This pattern mirrors how enterprise email gateways work — internal mail servers talk to a smart host that handles external delivery policy, spam filtering, and authentication (SPF/DKIM). The lessons from SMTP federation apply directly.

---

## Lessons from Prior Federation Models

### Email/SMTP

SMTP federation is 40+ years old and still the most successful open federated protocol. Key lessons for agent federation:

- **Loose coupling works.** Senders don't need a priori knowledge of receiver infrastructure.
- **Trust is built incrementally.** SPF, DKIM, and DMARC layered authentication onto an initially trust-less protocol over decades.
- **Spam is the killer problem.** Without reputation systems, open federation is abused. Agent federation will face the equivalent — "agent spam," unwanted autonomous outreach, and prompt injection attacks masquerading as legitimate agents.

### ActivityPub / Fediverse

ActivityPub's federated social graph demonstrates that instance-based identity (user@instance.tld) scales for content distribution but struggles with nuanced authorization. For agent federation, the relevant lesson is that **namespace ownership is a trust anchor** — an organization's verified domain is the root of its agents' trustworthiness, as both ANS and A2A Agent Cards rely on organizational domain ownership.

### Matrix Protocol

Matrix's federated real-time communication model is the closest analog to multi-org agent communication threads. Matrix homeservers federate directly (mesh, not hub-and-spoke), maintain shared room state across organizational boundaries, and use end-to-end encryption. For AI agent collaboration in shared conversation threads — such as HXA-Connect's multi-org B2B thread model — Matrix's room-state federation model provides a useful template: each organization controls its own agents' participation, the shared thread is a neutral space, and cryptographic signatures on events maintain a tamper-evident audit trail.

---

## Compliance, Liability, and Governance

### The Accountability Gap

Current law places liability for AI agent actions on the deploying organization, not the agent itself. In cross-org scenarios, this creates ambiguity: if Agent A (Org 1) instructs Agent B (Org 2) to take an action that causes harm, which organization is liable?

Legal frameworks emerging in 2025–2026 are converging on a **chain-of-delegation** accountability model: liability follows the instruction chain. The organization that issued the original instruction retains primary accountability; downstream organizations bear secondary liability for executing instructions they should have refused under their own policies.

This has practical architecture implications:
- **Instruction provenance must be preserved** across agent hops — OAuth token chains and DID credential chains serve this purpose
- **Each org must enforce its own policy at its gateway** regardless of what the requesting agent claims
- **Audit logs must be cross-referenceable** — each org keeps its own logs, but they must reconstruct the full interaction chain for regulatory investigations

### GDPR and Data Sovereignty

Cross-org agent interactions frequently involve personal data, triggering GDPR obligations for EU organizations. Key constraints:

- **Data minimization**: agents should request only the data necessary for the specific task
- **Purpose limitation**: data shared for task X cannot be retained or used for task Y
- **Data residency**: European customers require that personal data not leave specified jurisdictions, even transiently during agent processing
- **Right to erasure**: when a user requests deletion, the cascade across agent systems that processed their data is technically and legally complex

Zero-trust architectures help here: fine-grained, time-bounded, purpose-scoped authorization tokens enforce data minimization at the protocol level, not just at the application layer. The SPIFFE model of short-lived credentials also reduces exposure windows — a leaked credential expires in minutes, not days.

### The "Know Your Agent" Framework

Analogous to KYC (Know Your Customer) in financial services, the emerging KYA (Know Your Agent) framework requires organizations to establish:

1. **Who controls the agent** — verified organizational affiliation, not self-claimed
2. **What the agent is authorized to do** — capability attestation via VCs or signed Agent Cards
3. **Who bears accountability** — explicit delegation chain with legal entity mapping
4. **What audit trail exists** — logging requirements before admitting an external agent

ISACA's 2025 analysis estimates that without KYA frameworks, organizations exposing APIs to external agents face unquantifiable liability accumulation as autonomous agent interactions scale.

---

## The Protocol Landscape in 2026

A practical summary of where each protocol sits:

| Protocol | Layer | Status | Cross-Org Readiness |
|----------|-------|--------|---------------------|
| **A2A (Agent2Agent)** | Interaction | LF project, v0.3 | Production-capable; 150+ org support |
| **MCP (Model Context Protocol)** | Tool access | Linux Foundation / AAIF | Primarily intra-org; cross-org via gateway |
| **ANS (Agent Name Service)** | Discovery | IETF draft; GoDaddy API | Early; not yet standardized |
| **SPIFFE/SPIRE** | Workload identity | CNCF graduated | Production-ready for infrastructure |
| **OAuth 2.0 RAR + Token Exchange** | Authorization | RFC standard | Mature; widely implemented |
| **DID / Verifiable Credentials** | Identity / attestation | W3C standard | Emerging; not yet mainstream |

No single protocol covers all layers. Production cross-org agent federation in 2026 requires composing multiple layers: ANS or A2A for discovery, SPIFFE or OAuth for authentication, A2A for interaction, and organizational gateways for policy enforcement.

---

## Architecture Patterns Summary

### Hub-and-Spoke Federation (Current State)

Centralized brokers or gateways mediate all cross-org agent interactions. Orgs register their agents with a shared broker (industry consortium, platform operator, or agreed neutral party). The broker handles discovery, authentication routing, and audit aggregation.

**Pros:** Operationally simple, clear accountability, easy revocation
**Cons:** Broker becomes a trust bottleneck and potential single point of failure; vendor lock-in risk

### Mesh Federation (Emerging)

Agents from different orgs communicate directly, using cryptographic proofs (signed Agent Cards, SPIFFE mTLS, DID-VC attestations) rather than a shared broker. Each org maintains its own agent registry and publishes Agent Cards to the open ANS namespace.

**Pros:** No central dependency, censorship-resistant, scales without bottleneck
**Cons:** Higher operational complexity, no centralized revocation, harder to debug

### Federated Thread Model (HXA-Connect Pattern)

Multi-org conversations happen in shared threads where each organization's agents participate under their own identity and policy. The thread itself is a neutral coordination space; each org's gateway mediates its agents' participation and enforces local compliance rules. This is analogous to a Matrix room where multiple homeservers federate.

This pattern is particularly powerful for B2B use cases: a procurement negotiation thread might include agents from buyer, seller, logistics provider, and financial institution — each operating under their own org's policies while sharing a common interaction context.

---

## Future Outlook

The next 12–18 months will likely see:

1. **ANS and A2A convergence** — either formal integration or one protocol absorbing the other's discovery layer
2. **Enterprise identity platform extension** — Microsoft Entra, Okta, and similar platforms adding first-class "agent identity" objects with full lifecycle management
3. **Regulatory mandates for agent audit trails** — EU AI Act implementation will drive standardization of cross-org agent logging and accountability chains
4. **Industry consortium registries** — sector-specific agent registries (financial services, healthcare, logistics) providing vetted, KYA-compliant agent directories
5. **Reputation systems** — analogous to email sender reputation, agent reputation scores based on behavioral history, reducing "agent spam" risk

The fundamental shift is that AI agent federation is not a niche infrastructure concern — it is the foundation of B2B automation at internet scale. Organizations that establish robust cross-org agent trust infrastructure now will have significant competitive advantages as autonomous agent collaboration becomes the default mode of inter-organizational work.

---

## Conclusion

Cross-organization AI agent federation is moving from research concept to production reality in 2025–2026, driven by the maturation of A2A, ANS, SPIFFE, and OAuth delegation patterns. The core challenge — establishing trust between autonomous agents from different organizations, at runtime, without per-pair bilateral agreements — is being addressed through cryptographic identity, signed capability attestations, and standardized interaction protocols.

The analogies to email, ActivityPub, and Matrix federation are illuminating: each solved the same underlying problem of decentralized trust at different layers and with different trade-offs. AI agent federation must solve all these layers simultaneously, with the added complexity of autonomous action, legal liability, and real-time compliance requirements.

The practical recommendation for organizations building cross-org agent capability today: start with hub-and-spoke gateway patterns using A2A for interoperability, SPIFFE for workload identity, and OAuth 2.0 token chains for delegation. Invest in audit logging infrastructure now — regulatory requirements will make this mandatory, and retrofitting audit capabilities into production agent systems is substantially harder than building them in from the start.

---

## References

- [Announcing the Agent2Agent Protocol (A2A) - Google Developers Blog](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)
- [Linux Foundation Launches the Agent2Agent Protocol Project](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents)
- [A2A Protocol Official Documentation](https://a2a-protocol.org/latest/)
- [Agent2Agent Protocol is getting an upgrade - Google Cloud Blog](https://cloud.google.com/blog/products/ai-machine-learning/agent2agent-protocol-is-getting-an-upgrade)
- [Agent Name Service (ANS): A Universal Directory - IETF Draft](https://datatracker.ietf.org/doc/html/draft-narajala-ans-00)
- [Agent Name Service (ANS) for Secure AI Agent Discovery](https://www.aigl.blog/content/files/2025/05/Agent-Name-Service--ANS--for-Secure-AI-Agent-Discovery.pdf)
- [GoDaddy Creates Trusted Identity Naming System for AI Agents](https://aboutus.godaddy.net/newsroom/news-releases/press-release-details/2025/GoDaddy-Creates-Trusted-Identity-Naming-System-for-AI-Agents/default.aspx)
- [AI Agents with Decentralized Identifiers and Verifiable Credentials - arXiv](https://arxiv.org/html/2511.02841v1)
- [A Novel Zero-Trust Identity Framework for Agentic AI - arXiv](https://arxiv.org/html/2505.19301v1)
- [Authenticated Delegation and Authorized AI Agents - arXiv](https://arxiv.org/html/2501.09674v1)
- [The Trust Fabric: Decentralized Interoperability for the Agentic Web - arXiv](https://arxiv.org/html/2507.07901v1)
- [Identity Management for Agentic AI - OpenID Foundation](https://openid.net/wp-content/uploads/2025/10/Identity-Management-for-Agentic-AI.pdf)
- [SPIFFE: Securing the identity of agentic AI - HashiCorp](https://www.hashicorp.com/en/blog/spiffe-securing-the-identity-of-agentic-ai-and-non-human-actors)
- [Agent Identity and Access Management - Can SPIFFE Work? - Solo.io](https://www.solo.io/blog/agent-identity-and-access-management---can-spiffe-work)
- [The Agentic Trust Framework: Zero Trust for AI Agents - CSA](https://cloudsecurityalliance.org/blog/2026/02/02/the-agentic-trust-framework-zero-trust-governance-for-ai-agents)
- [MCP and Zero Trust: Securing AI Agents - Cerbos](https://www.cerbos.dev/blog/mcp-and-zero-trust-securing-ai-agents-with-identity-and-policy)
- [Agentic AI Is Here — Legal, Compliance, and Governance Risks - Venable LLP](https://www.venable.com/insights/publications/2026/02/agentic-ai-is-here-legal-compliance-and-governance)
- [The rise of agentic AI: Potential new legal and organizational risks - DLA Piper](https://www.dlapiper.com/en/insights/publications/ai-outlook/2025/the-rise-of-agentic-ai--potential-new-legal-and-organizational-risks)
- [The Looming Authorization Crisis: Why Traditional IAM Fails Agentic AI - ISACA](https://www.isaca.org/resources/news-and-trends/industry-news/2025/the-looming-authorization-crisis-why-traditional-iam-fails-agentic-ai)
- [Hub & Spoke vs Federated Gen AI Platform Design - Medium](https://medium.com/@nayan.j.paul/hub-spoke-vs-federated-gen-ai-platform-design-3840892779b2)
- [A Survey of Agent Interoperability Protocols: MCP, ACP, A2A, and ANP - arXiv](https://arxiv.org/html/2505.02279v1)
- [Evolution of AI Agent Registry Solutions - arXiv](https://arxiv.org/html/2508.03095v3)
- [Securing the Model Context Protocol (MCP) - arXiv](https://arxiv.org/pdf/2511.20920)
- [Four priorities for AI-powered identity and network access security in 2026 - Microsoft Security Blog](https://www.microsoft.com/en-us/security/blog/2026/01/20/four-priorities-for-ai-powered-identity-and-network-access-security-in-2026/)
- [The AI Agent Identity Crisis - Strata](https://www.strata.io/blog/agentic-identity/the-ai-agent-identity-crisis-new-research-reveals-a-governance-gap/)
