---
date: "2026-03-07"
title: "AI Agent Identity, Discovery, and Trust Frameworks"
description: "How AI agents establish identity, discover peers, and build trust in multi-agent ecosystems — DIDs, agent cards, reputation systems, and emerging standards"
tags:
  - ai-agents
  - identity
  - trust
  - did
  - discovery
  - multi-agent
  - b2b-protocol
---

## Executive Summary

As AI agents proliferate across enterprise workflows — with over 40% of enterprise processes expected to involve autonomous agents by late 2026 — the foundational questions of *who is this agent?*, *how do I find it?*, and *can I trust it?* have become critical infrastructure problems. This research covers the rapidly converging landscape of agent identity, discovery, and trust:

- **Identity** is coalescing around W3C Decentralized Identifiers (DIDs) v1.1 and Agent Cards (JSON metadata documents), with OAuth 2.1 and a new IETF on-behalf-of extension handling delegation.
- **Discovery** has a de facto standard: the `/.well-known/agent-card.json` URI registered with IANA as part of Google's A2A protocol, supplemented by DNS-inspired systems like Agent Name Service (ANS).
- **Trust** is moving from pre-negotiated federation to cryptographically verifiable credentials — W3C Verifiable Credentials, Digital Agent Passports (Trulioo KYA), and Visa's Trusted Agent Protocol (TAP).
- **Governance** is consolidating under two Linux Foundation bodies: the **Agentic AI Foundation (AAIF)** stewarding MCP, goose, and AGENTS.md; and the **A2A Project** governing the Agent-to-Agent protocol.

The practical implication for B2B agent platforms: design around Agent Cards for discovery, OAuth 2.1 with delegation for auth, and Verifiable Credentials for cross-org trust — these are no longer speculative; they are shipping in production SDKs.

## The Agent Identity Problem

Traditional identity systems were designed for humans and applications. An AI agent is neither — it is an autonomous software entity that:

- Acts on behalf of a human, an organization, or itself
- May be ephemeral (spun up for one task) or persistent (long-running service)
- Needs to prove *what it can do*, not just *who it is*
- Operates across organizational and platform boundaries
- May delegate authority to sub-agents in a chain

This creates what The Hacker News called "identity dark matter" (March 2026): agents that are powerful, invisible, and unmanaged by traditional IAM systems. The industry response has been a multi-layered identity stack.

## Decentralized Identifiers (DIDs) for AI Agents

### W3C DIDs v1.1

The W3C published the first public working draft of DIDs v1.1 in 2025 and issued a call for implementations in early 2026 (comments due April 2026). DIDs provide a URI-based identifier that is:

- **Self-sovereign** — the controller (agent or its operator) manages the identifier without a central authority
- **Cryptographically verifiable** — bound to public key material in a DID Document
- **Decoupled from providers** — portable across platforms, unlike OAuth client IDs tied to a specific IdP

A DID looks like this:

```
did:web:agents.acme.com:finance-bot
did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK
did:wba:agent-network-protocol.com:agents:travel-agent
```

### DID Methods Compared

| Method | Resolution | Decentralization | Best For |
|--------|-----------|------------------|----------|
| `did:web` | HTTP GET on domain | Low (relies on DNS/TLS) | Enterprise agents with existing web infrastructure |
| `did:key` | Self-contained in identifier | High (no external resolution) | Ephemeral agents, quick bootstrapping |
| `did:wba` | Web-based with crypto auth | Medium (DNS + signatures) | ANP-compatible open-internet agents |
| `did:indy` | Hyperledger Indy ledger | High (distributed ledger) | Cross-domain trust with shared governance |
| `did:peer` | Peer-to-peer exchange | High (no registry needed) | Direct agent-to-agent private channels |

### How Agents Use DIDs

Research from November 2025 (arXiv:2511.02841) demonstrated a working prototype where:

1. Each agent receives a DID anchored on a shared ledger (Hyperledger Indy BCovrin testnet)
2. The DID Document contains public keys for authentication and assertion
3. Agents prove DID ownership via cryptographic challenge-response at the start of each interaction
4. Verifiable Credentials are bound to the DID for capability attestation

The architecture defines two credential tiers:

- **Basic VCs (bVCs):** Minimal identity ("this entity is an agent in domain X"), issued at deployment
- **Rich VCs (rVCs):** Capabilities, roles, and authorizations, issued after attestation — can include unstructured data (natural language, images) for LLM-based interpretation

Key limitation identified: when LLMs are solely responsible for orchestrating security procedures (signing, verification, credential exchange), completion rates ranged from ~20% to ~95% depending on model capability. The recommendation is to externalize crypto operations to dedicated tooling injected via MCP.

## Agent Discovery Protocols

### The Well-Known URI Pattern

The dominant discovery mechanism is hosting an Agent Card at a standardized path:

```
https://{domain}/.well-known/agent-card.json
```

This follows RFC 8615. In April 2025, `agent-card.json` became the first AI-agent-specific entry in the IANA `.well-known` registry, registered under the Linux Foundation as part of the A2A protocol.

### Agent Card Structure (A2A)

An Agent Card is a JSON document that answers three questions: *Who am I? What can I do? How do you talk to me?*

```json
{
  "name": "Finance Reconciliation Agent",
  "description": "Automated invoice matching and reconciliation",
  "provider": {
    "organization": "Acme Corp",
    "url": "https://acme.com"
  },
  "url": "https://agents.acme.com/finance/a2a",
  "version": "2.1.0",
  "capabilities": {
    "streaming": true,
    "pushNotifications": true
  },
  "authentication": {
    "schemes": ["Bearer", "OAuth2"],
    "credentials": null
  },
  "skills": [
    {
      "id": "invoice-match",
      "name": "Invoice Matching",
      "description": "Match purchase orders to invoices with fuzzy matching",
      "inputModes": ["application/json", "text/csv"],
      "outputModes": ["application/json"],
      "examples": [
        "Match all outstanding invoices for Q4 2025",
        "Find discrepancies between PO-4521 and INV-8832"
      ]
    }
  ]
}
```

### Discovery Methods Hierarchy

| Method | Use Case | Pros | Cons |
|--------|----------|------|------|
| **Well-Known URI** | Public agents, open discovery | Standards-based, no registry needed | Requires DNS/domain ownership |
| **Curated Registry** | Enterprise marketplaces | Searchable by skill/tag/provider | Centralized dependency |
| **Agent Name Service (ANS)** | Cross-protocol discovery | DNS-like universal resolution | Still in draft stage |
| **Direct Configuration** | Private, tightly-coupled systems | Simple, no external dependencies | No dynamic discovery |
| **Authenticated Extended Cards** | Sensitive capabilities | Selective disclosure by client identity | More complex handshake |

### Agent Name Service (ANS)

ANS, proposed in May 2025 (arXiv:2505.10609), is a DNS-inspired resolution framework for agents. It maps human-readable names to verified capabilities, cryptographic keys, and endpoints:

```
a2a://textProcessor.DocumentTranslation.AcmeCorp.v2.1.hipaa
```

The naming structure encodes: protocol, agent ID, capability, provider, version, and deployment metadata.

ANS resolution flow:

```
Agent --> ANS Service --> Registry Query --> PKI Certificate Verification --> Authenticated Endpoint
                                    |
                          Protocol Adapter Layer
                         /        |        \
                      A2A       MCP       ACP
                    Adapter   Adapter   Adapter
```

Key technical details:

- Each registered agent receives a CA-signed X.509 certificate
- All registry responses are digitally signed
- Resolution includes TTL values (default 300s) for caching
- Supports multiple deployment architectures: centralized, distributed (Cassandra/DHT), blockchain, or federated
- Protocol adapters normalize A2A Agent Cards, MCP tool descriptions, and ACP agent profiles into a unified registry format

### Agent Network Protocol (ANP) Discovery

ANP takes the most decentralized approach, using the `did:wba` method (web-based authentication DID). Agents publish capability descriptions at predictable URLs, which are crawlable by search engines and other agents to build distributed directories — essentially SEO for agents.

## Trust and Reputation Systems

### The Trust Gap

Two agents from different organizations meet for the first time. Neither has interacted before. How does trust get established? There are three emerging models:

### Model 1: Verifiable Credentials (W3C VC)

The most mature approach. A trusted third party issues a tamper-proof credential bound to the agent's DID:

```json
{
  "@context": ["https://www.w3.org/ns/credentials/v2"],
  "type": ["VerifiableCredential", "AgentCapabilityCredential"],
  "issuer": "did:web:trust-authority.example.com",
  "validFrom": "2026-03-01T00:00:00Z",
  "validUntil": "2027-03-01T00:00:00Z",
  "credentialSubject": {
    "id": "did:web:agents.acme.com:finance-bot",
    "type": "AIAgent",
    "capabilities": ["invoice-processing", "reconciliation"],
    "complianceCertifications": ["SOC2-Type-II", "ISO-27001"],
    "maxTransactionValue": "USD 50000",
    "operatorOrganization": "Acme Corp"
  },
  "proof": {
    "type": "Ed25519Signature2020",
    "verificationMethod": "did:web:trust-authority.example.com#key-1"
  }
}
```

The DIF Presentation Exchange protocol governs how agents request and present credentials to each other during mutual authentication.

### Model 2: Know Your Agent (KYA) / Digital Agent Passport

Trulioo introduced KYA in collaboration with PayOS as a practical trust framework for commerce. The five-step process:

1. **Verify the Agent Developer** — identity check on the organization that built the agent
2. **Lock the Agent Code** — cryptographic hash of the agent's codebase to detect tampering
3. **Capture User Permission** — record of the human who authorized the agent to act
4. **Issue a Digital Agent Passport** — tamper-proof credential encoding builder, principal, and permissions
5. **Ongoing Lookup** — continuous real-time verification checks

The Digital Agent Passport is a lightweight credential showing *who built the agent*, *who it represents*, and *what permissions it has*. Trulioo has integrated this into Google's Agent Payments Protocol (AP2) for commerce use cases.

### Model 3: Visa Trusted Agent Protocol (TAP)

Announced October 2025, TAP enables merchants to distinguish trusted AI agents from bots using verifiable signatures and identity signals. Currently being piloted with Cloudflare and Nuvei. TAP focuses specifically on the payments vertical where agent identity directly impacts fraud risk.

### Reputation and Endorsement Patterns

Beyond binary trust (credential valid / not valid), emerging systems include:

- **Trust Graphs:** Algorithmic reputation scores across marketplaces, where endorsements propagate through a web of agent interactions
- **Capability Attestation via Zero-Knowledge Proofs:** Agents prove they possess a capability without revealing implementation details (proposed in ANS)
- **Endorsement Chains:** Agent A trusts Agent B because Agent C (whom A trusts) has issued a VC to B
- **Runtime Capability Validation:** Challenge-response mechanisms that test claimed capabilities during the discovery phase, not just at registration

### Attestix: Open-Source Trust Infrastructure

The Attestix project (GitHub: VibeTensor/attestix) provides an open-source attestation infrastructure for AI agents with 47 MCP tools across 9 modules, covering DID-based identity, W3C Verifiable Credentials, EU AI Act compliance, delegation chains, and reputation scoring.

## Authentication and Authorization

### The OAuth Evolution

Traditional OAuth 2.0 was designed for human users clicking "Allow" in a browser. AI agents break this model in several ways:

- Agents may need to authenticate without human interaction
- Multiple agents may form delegation chains (User -> App -> Agent -> Sub-agent)
- Permissions need to be more granular and dynamically revocable
- The identity of the *acting agent* must be captured separately from the *authorized user*

### IETF OAuth Extension: On-Behalf-Of for AI Agents

A draft specification (`draft-oauth-ai-agents-on-behalf-of-user-01`) defines a three-party delegation flow:

```
User (Resource Owner)
  |
  | 1. Authorizes
  v
Client Application
  |
  | 2. Delegates via actor_token
  v
AI Agent (Actor)
  |
  | 3. Accesses resources with compound token
  v
Resource Server
```

The resulting JWT captures three distinct identities:

```json
{
  "iss": "https://auth.example.com",
  "sub": "user-456",
  "azp": "client-app-id",
  "scope": "read:invoices write:payments",
  "act": {
    "sub": "agent-finance-v1"
  },
  "aut": "APPLICATION_USER",
  "exp": 1746009896
}
```

- `sub` — the resource owner (human)
- `azp` — the client application facilitating the flow
- `act.sub` — the specific AI agent performing the action

This creates an auditable record: *"user authorized client to delegate to agent"*.

Key requirements: PKCE is mandatory, authorization codes are single-use and short-lived, and codes must be bound to the specific user, client, and requested actor.

### OpenID Connect for Agents (OIDC-A)

Proposed in April 2025, OIDC-A extends the OpenID Connect framework with:

- Agent-specific claims and metadata
- Agent attestation verification
- Delegation chain representation
- Fine-grained authorization based on agent attributes

The core idea: agents register with an IdP *as agents* (a new entity type), not as clients or users. This gives them first-class identity in the OAuth ecosystem.

### MCP Authentication Model

MCP mandates OAuth 2.1 with PKCE for remote servers. The flow:

1. Agent authenticates via OAuth to get a scoped token
2. Token identifies both the user and the acting agent
3. MCP server uses the token to determine available tools and permissions
4. Resource indicators (RFC 9396) scope tokens to specific MCP servers

Major identity providers — Auth0, Okta, WorkOS — now provide out-of-the-box MCP auth integration.

### Capability-Based Security Pattern

Rather than role-based access, agents increasingly use capability tokens — unforgeable references to specific permitted operations:

```
Agent holds: capability://invoices.acme.com/read?filter=department:finance&max=1000
```

This aligns with the principle of least privilege: an agent receives only the exact capabilities it needs, scoped by resource, operation, and constraints. Capabilities can be attenuated (reduced) when delegated to sub-agents, but never amplified.

## Existing Standards and Projects

### Protocol Landscape (March 2026)

| Protocol | Origin | Governance | Primary Focus | Identity Model |
|----------|--------|-----------|---------------|----------------|
| **MCP** | Anthropic (Nov 2024) | AAIF / Linux Foundation | Tool/context integration | OAuth 2.1, server identity |
| **A2A** | Google (Apr 2025) | Linux Foundation | Agent-to-agent collaboration | Agent Cards, OAuth/mTLS |
| **ACP** | IBM BeeAI (2025) | Linux Foundation (merged into A2A Aug 2025) | Lightweight HTTP messaging | REST-native, SSE streaming |
| **ANP** | Community (2024) | Open source | Open-internet agent networks | W3C DIDs (did:wba), JSON-LD |
| **KERI** | DIF / IETF | Decentralized Identity Foundation | Decentralized key management | Autonomic Identifiers (AIDs) |
| **W3C DID** | W3C (v1.1 2025-2026) | W3C | Universal decentralized identity | DID Documents, multiple methods |
| **W3C VC** | W3C | W3C | Verifiable claims/attestations | Credential + Proof |
| **FIPA ACL** | IEEE FIPA (1990s) | IEEE (legacy) | Agent communication semantics | Sender/receiver fields |

### KERI (Key Event Receipt Infrastructure)

KERI provides decentralized key management without blockchain dependency through:

- **Autonomic Identifiers (AIDs):** Self-certifying identifiers with cryptographic root-of-trust
- **Key Event Logs (KELs):** Append-only logs of key lifecycle events
- **Pre-rotation:** Next key commitment published before current key is compromised
- **Witnesses:** Distributed receipt infrastructure for key event verification
- **Two trust modes:** Direct (1:1 verified signatures) and indirect (witnessed key event receipt logs)

KERI is particularly relevant for long-lived agent identities that need secure key rotation over time. The KERI Foundation continues active development with an event scheduled for April 2026.

### Agentic AI Foundation (AAIF)

Formed December 2025 under the Linux Foundation, AAIF represents the governance convergence of the agent ecosystem:

- **Founding projects:** MCP, goose (Block's agent framework), AGENTS.md (OpenAI)
- **Platinum members:** AWS, Anthropic, Block, Bloomberg, Cloudflare, Google, Microsoft, OpenAI
- **Governance model:** Board handles strategy and budget; individual projects retain full technical autonomy
- **Scope:** Open standards for agentic AI infrastructure

### The Protocol Stack Model

The emerging consensus is that these protocols are *complementary layers*, not competitors:

```
Layer 4: Application Logic
         (Business workflows, domain-specific behavior)
              |
Layer 3: Agent-to-Agent Collaboration  [A2A]
         (Task lifecycle, skill negotiation, artifacts)
              |
Layer 2: Tool & Context Integration    [MCP]
         (Data access, tool execution, prompts)
              |
Layer 1: Identity & Encrypted Comm     [DIDs, OAuth, KERI]
         (Authentication, delegation, key management)
              |
Layer 0: Transport                     [HTTP/2, gRPC, WebSocket, SSE]
```

MCP handles the *vertical* problem (agent-to-tools), A2A handles the *horizontal* problem (agent-to-agent), and DIDs/KERI handle the *foundational* problem (who are you, and can I verify that?).

## Practical Implications for B2B Agent Platforms

### Design Recommendations

For a B2B agent communication platform (e.g., an HXA-Connect style system), the following architecture emerges from the current standards landscape:

**1. Agent Identity Layer**

```yaml
identity:
  primary: did:web:{your-domain}:agents:{agent-id}
  fallback: did:key:{public-key-multibase}
  credentials:
    - type: OrganizationVerifiedAgent
      issuer: did:web:trust-registry.example.com
    - type: CapabilityAttestation
      issuer: did:web:your-domain.com
```

Use `did:web` for enterprise agents (leverages existing PKI) with `did:key` as a bootstrap mechanism for new agents before domain verification completes.

**2. Discovery Layer**

- Publish Agent Cards at `/.well-known/agent-card.json` (A2A standard)
- Register with curated enterprise registries for B2B marketplace discovery
- Support both pull (well-known URI) and push (registry notification) patterns
- Implement authenticated extended cards for sensitive capability details

**3. Authentication Layer**

```
Recommended Stack:
- OAuth 2.1 with PKCE for user-delegated agent actions
- IETF OBO extension for delegation chains
- mTLS for server-to-server agent communication
- API keys only for development/testing (never production cross-org)
```

**4. Trust Layer**

- Issue W3C Verifiable Credentials for platform-verified agents
- Accept VCs from recognized issuers for cross-platform trust
- Implement credential revocation checking (CRL or OCSP)
- Log all trust decisions for audit trail

### Cross-Platform Interoperability Checklist

| Requirement | Standard | Status (Mar 2026) |
|-------------|----------|-------------------|
| Agent metadata exchange | A2A Agent Cards | RC 1.0 (stable) |
| Tool integration | MCP | Production (10K+ servers) |
| Agent-to-agent tasks | A2A | RC 1.0 |
| Decentralized identity | W3C DID v1.1 | Candidate Recommendation |
| Credential exchange | W3C VC + DIF Presentation Exchange | Stable |
| OAuth delegation | IETF OBO draft | Draft-01 |
| Agent-specific OIDC | OIDC-A | Proposal stage |
| DNS-based agent resolution | ANS | Research paper |
| Commerce trust | Trulioo KYA / Visa TAP | Pilot |

### What to Build Now vs. Wait

**Build now:**
- Agent Card publishing (A2A `.well-known/agent-card.json`)
- OAuth 2.1 with delegation support
- MCP server/client integration
- Basic VC issuance for your platform's agents

**Adopt when stable:**
- ANS-based resolution (wait for IETF standardization)
- OIDC-A agent registration (wait for spec maturity)
- Cross-registry federation

**Watch:**
- EU AI Act enforcement (August 2, 2026) — may mandate specific identity/compliance credentials
- KERI integration for long-lived agent key management
- Zero-knowledge capability proofs

## Key Takeaways

1. **Agent Cards are the new business cards.** The A2A `.well-known/agent-card.json` pattern is the de facto discovery mechanism. If your agents are not publishing cards, they are invisible to the ecosystem.

2. **DIDs are the long-term identity anchor.** While OAuth handles day-to-day auth, DIDs provide portable, platform-independent identity that survives provider changes. Start with `did:web` for practicality.

3. **Trust requires credentials, not just authentication.** Knowing *who* an agent is differs from knowing *what it can do* and *whether to trust it*. Verifiable Credentials bridge this gap.

4. **The protocol stack is settling.** MCP for tools, A2A for agent collaboration, DIDs for identity, OAuth for auth. These are not competing — they are layers. Build to the stack, not to a single protocol.

5. **Governance has consolidated.** AAIF (MCP, goose, AGENTS.md) and the A2A Linux Foundation project provide vendor-neutral homes for the core standards. The risk of a standards war has significantly decreased.

6. **Regulatory pressure is real.** EU AI Act enforcement in August 2026 will likely require identity and compliance credentials for autonomous agents operating in regulated sectors. Start building the credential infrastructure now.

---

*Sources:*

- [W3C DIDs v1.1 Call for Implementations (2026)](https://www.w3.org/news/2026/w3c-invites-implementations-of-decentralized-identifiers-dids-v1-1/)
- [AI Agents with DIDs and VCs (arXiv:2511.02841)](https://arxiv.org/html/2511.02841v1)
- [Building the Agentic Economy — DIF](https://blog.identity.foundation/building-the-agentic-economy/)
- [A2A Protocol Specification](https://a2a-protocol.org/latest/)
- [A2A Agent Discovery](https://a2a-protocol.org/latest/topics/agent-discovery/)
- [A2A Protocol Upgrade — Google Cloud Blog](https://cloud.google.com/blog/products/ai-machine-learning/agent2agent-protocol-is-getting-an-upgrade)
- [Agent Name Service (ANS) (arXiv:2505.10609)](https://arxiv.org/html/2505.10609v1)
- [Agent Network Protocol (ANP)](https://agent-network-protocol.com/specs/white-paper.html)
- [IETF OAuth OBO for AI Agents](https://www.ietf.org/archive/id/draft-oauth-ai-agents-on-behalf-of-user-01.html)
- [OIDC-A Proposal](https://subramanya.ai/2025/04/28/oidc-a-proposal/)
- [MCP Specification (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP Joins AAIF](http://blog.modelcontextprotocol.io/posts/2025-12-09-mcp-joins-agentic-ai-foundation/)
- [AAIF Announcement — Linux Foundation](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation)
- [Trulioo Know Your Agent (KYA)](https://www.trulioo.com/blog/know-your-agent-kya/know-your-agent-kya-agentic-commerce-trust)
- [Visa Trusted Agent Protocol](https://developer.visa.com/capabilities/trusted-agent-protocol)
- [Attestix — Agent Trust Infrastructure](https://github.com/VibeTensor/attestix)
- [KERI Foundation](https://keri.foundation/)
- [Identity Management for Agentic AI — OpenID Foundation](https://openid.net/wp-content/uploads/2025/10/Identity-Management-for-Agentic-AI.pdf)
- [Microsoft: Why OAuth Must Evolve for AI Agents](https://techcommunity.microsoft.com/blog/microsoft-entra-blog/the-future-of-ai-agents%E2%80%94and-why-oauth-must-evolve/3827391)
- [Survey of AI Agent Registry Solutions (arXiv:2508.03095)](https://arxiv.org/html/2508.03095v1)
- [Agent Interoperability Protocols Survey (arXiv:2505.02279)](https://arxiv.org/html/2505.02279v1)
- [Agent Discovery Trends — Google Cloud Community](https://medium.com/google-cloud/what-are-the-trends-in-agent-discoverability-and-interoperability-91865e098365)
- [AI Agent Protocols 2026 — Complete Guide](https://www.ruh.ai/blogs/ai-agent-protocols-2026-complete-guide)
