---
date: "2026-05-26"
title: "Agent Authorization Models: Beyond OAuth — How AI Agents Challenge Traditional Access Control"
description: "Analysis of emerging authorization patterns for AI agents: scope intersection, tri-party trust, capability-based security, and the gap between OAuth 2.0 and agent-native auth."
tags: ["ai-agents", "authorization", "oauth", "security", "mcp", "agent-trust"]
---

## Executive Summary

OAuth 2.0 was designed for a world where software acts predictably on behalf of humans. A user grants a client application a defined set of permissions; the application exercises those permissions in a deterministic, auditable way. AI agents break every assumption in that sentence.

Agents are non-deterministic. The same agent with the same permissions will take different actions depending on context, prompt, and reasoning path. Agents operate across time — a long-running planning agent may hold delegated authority for hours while the human principal has moved on. Agents compose — one agent spawns sub-agents, which call tools, which invoke other agents, and the original authorization context becomes a faint signal at the end of a delegation chain. And agents have intent — they don't just execute what users specify, they interpret what users *meant* and make judgment calls about what actions to take.

This article examines why these properties cause traditional OAuth 2.0 and RBAC to fail for agent workloads, surveys the authorization models that have emerged in 2025–2026 to address the gap, and draws practical conclusions for teams building agent platforms. We draw on our own experience evaluating the ATH (Agent Trust Handshake) protocol and building COCO Workspace — a multi-agent platform with principal propagation, RBAC, and agent-to-service authorization — to ground the analysis in operational realities.

The core argument: **agent authorization is not an extension of OAuth — it is a different problem that happens to use some of the same primitives.** The sooner platform builders internalize this, the less painful their security architectures will be.

---

## The Fundamental Problem: Why OAuth Breaks for Agents

### Request-Level vs. Sequence-Level Authorization

OAuth validates individual requests. An access token carries a set of scopes; the resource server checks whether the requested operation falls within those scopes; it either grants or denies. This works when software behavior is deterministic and the sequence of calls is predictable.

Agents create *sequences* of requests where each individual call is authorized but the combined effect is not. Consider an agent with read access to email and write access to calendar. No single OAuth scope check catches the fact that the agent is reading meeting invitations and autonomously adding attendees to calendar events — a workflow the user never explicitly approved. Each individual tool call passes authorization; the emergent action does not.

This is sometimes called the **permission composition explosion**: a set of individually safe permissions becomes dangerous when an agent combines them in ways no human anticipated. Standard RBAC and OAuth have no mechanism for reasoning about compositions — they only evaluate individual operations at the moment they are requested.

### The Agency Gap

There is a gap between what users delegate and what agents decide. A user says "book me a flight to Tokyo next week." The agent decides: which airline to query first, whether to access the user's calendar to check constraints, whether to use stored payment credentials, whether to buy now or wait for a price drop, and dozens of other sub-decisions that were never explicitly authorized.

This is the **agency gap**: the user delegates intent, and the agent decides actions. Traditional authorization was designed for systems where the software's action space was bounded and known in advance — you grant "read:files" and the application reads files. Agents operate with open action spaces where the same high-level delegation can manifest as radically different sequences of tool calls depending on the agent's reasoning.

The gap has a troubling security implication: an agent that is *correctly* authorized under OAuth may still act far outside the scope of what the user actually meant to permit. Authorization correctness is necessary but not sufficient for agent safety.

### The Temporal Dimension

OAuth tokens are session-scoped. They expire. They encode a grant that was valid at a point in time. Agents are not session-scoped — a planning agent might hold authority granted at 9 AM and still be executing actions at 11 PM when the user's intent, context, or even employment status has changed.

Long-running agents make two temporal assumptions OAuth does not support:

1. **Persistent delegation**: The agent needs the original grant to remain valid across multiple reasoning steps and tool calls that may span hours or days.
2. **Dynamic revocation**: If the user's intent changes or they want to cancel the agent's work, there is no standard mechanism to signal mid-execution revocation that the agent will respect.

Token refresh handles credential expiry, but it does not re-validate the underlying human intent. A refreshed token is still carrying the authorization context from the original grant, even if the user has long since changed their mind.

### The Multi-Hop Delegation Problem

OAuth handles one-hop delegation well: user → client → resource server. The moment delegation becomes recursive — user → orchestrator agent → sub-agent A → sub-agent B → tool server — the authorization chain loses its anchor.

No deployed standard protocol can cryptographically prove which human principal authorized which specific agent to perform which specific action at depth four of a delegation chain. Bearer tokens passed between agents carry no attenuation discipline: each hop *should* only be able to reduce permissions, never expand them, but standard bearer tokens have no mechanism to enforce this constraint. A sub-agent receiving a delegated token can technically reuse it at full scope.

Research has documented real attacks exploiting this gap. EchoLeak (CVE-2025-32711, CVSS 9.3), Unit 42's Agent Session Smuggling, and cross-agent privilege escalation all exploited the same structural flaw: no scope attenuation at delegation boundaries.

---

## The Authorization Landscape in 2025–2026

The industry has responded to these problems with a collection of new protocols, extensions, and frameworks. None is a complete solution. Each addresses a different subset of the problem space.

### MCP Authorization: OAuth 2.1 with Agent Extensions

The Model Context Protocol's 2025-03-26 authorization specification mandated OAuth 2.1 as the mechanism for accessing remote MCP servers, with a subsequent major revision in November 2025. The key additions over baseline OAuth 2.0:

- **PKCE required for all flows**, not just public clients — eliminates authorization code interception attacks
- **Dynamic Client Registration (DCR)** — agents discover and register with MCP servers at runtime without requiring prior knowledge of every server they'll encounter. Since agents are deployed against arbitrary tool ecosystems, static client registration is not practical
- **Scope management** — the spec provides structure for granular scopes that map to specific tool operations rather than broad capability grants
- **Implicit grant removed entirely** — eliminates the least secure OAuth flow

MCP's approach is pragmatic: it uses existing infrastructure (OAuth 2.1 is widely supported) and provides enough structure for basic agent-to-tool authorization. But it does not address scope composition, delegation depth, or multi-agent trust chains. MCP assumes a two-party model (client agent + MCP server) and does not specify how authorization should flow when agents spawn agents.

```
# MCP OAuth 2.1 Discovery Flow
GET /.well-known/oauth-authorization-server HTTP/1.1

# Response includes:
{
  "issuer": "https://mcp-server.example.com",
  "authorization_endpoint": "...",
  "token_endpoint": "...",
  "registration_endpoint": "...",   # DCR
  "code_challenge_methods_supported": ["S256"]  # PKCE required
}
```

The practical value of MCP's authorization spec is in standardizing server-side discovery and registration. Before this, every tool server implemented authentication differently — custom API keys, proprietary token schemes, ad-hoc OAuth flows. Standardizing on OAuth 2.1 with DCR at least creates a consistent integration surface for agent developers.

### Google A2A: Signed Agent Cards and Federated Trust

Google's Agent-to-Agent (A2A) protocol, released in April 2025 and donated to the Linux Foundation in June, takes a different approach: **agent identity before authorization**. A2A defines Agent Cards — JSON documents where agents describe their capabilities, supported input/output modalities, and security schemes.

As of A2A v0.3 (July 2025), Agent Cards can be cryptographically signed using JWS (RFC 7515), allowing client agents to verify the server agent's identity and card integrity before establishing a connection. Authorization then follows standard OAuth 2.0 / OIDC flows, but the signed Agent Card provides a layer of identity assurance that raw OAuth tokens do not.

```json
{
  "name": "Document Analysis Agent",
  "version": "1.2.0",
  "capabilities": ["text/analyze", "pdf/extract"],
  "security": [{"oauth2": {"scopes": ["analyze:read"]}}],
  "agentCardSignature": {
    "alg": "RS256",
    "kid": "agent-signing-key-v1",
    "signature": "..."
  }
}
```

A2A's contribution is establishing **agent identity as distinct from client application identity**. A traditional OAuth client ID identifies an application. An A2A Agent Card identifies a specific agent with specific capabilities, versioned and attestable. This distinction matters enormously for multi-agent systems: when sub-agent B receives a request from sub-agent A, it needs to know not just that the request is authenticated, but *which agent* is making it and what its declared capabilities are.

A2A has broad industry adoption — 150+ organizations as of early 2026, including Google, Microsoft, AWS, Salesforce, SAP, and Workday. But adoption of the spec does not mean adoption of signed Agent Cards, and the authorization layer remains OAuth 2.0 with all its limitations for agent workloads.

### ATH Protocol: Scope Intersection as First-Class Primitive

The ATH (Agent Trust Handshake) protocol addresses the multi-party authorization problem directly through **tri-party scope intersection**. Rather than an agent receiving the user's full delegated scope and deciding how to use it, ATH computes:

```
effective_scope = Agent_Capabilities ∩ User_Delegation ∩ Requested_Operation
```

No operation proceeds unless it is authorized by all three parties simultaneously: the agent must be capable of it (agent identity and capability), the user must have delegated permission for it (user consent), and the specific operation must fall within what was requested at this invocation (operation scope).

This is a meaningful advance over OAuth's two-party model (user grants, client uses). ATH makes the agent a principal in the authorization decision, not just an authorized client. An agent cannot exceed its declared capabilities even with broad user delegation, and user delegation cannot be stretched beyond what the current operation requires.

The scope intersection model has practical implications for COCO Workspace's design. When an orchestrator agent delegates to a sub-agent, the effective scope of the sub-agent is the intersection of: what the orchestrator was permitted to do, what the sub-agent declares it can do, and what the specific sub-task requires. Each delegation hop can only narrow, never broaden, the permission surface. This is the **attenuation discipline** that bearer tokens cannot enforce structurally but that ATH enforces cryptographically.

The challenge with ATH is complexity. Three-party handshakes require more round-trips and more coordination infrastructure than a simple token check. The performance overhead is real. But for high-stakes operations — agents that touch financial data, production systems, or PII — the overhead is justified.

### Visa Trusted Agent Protocol: Authorization for Agentic Commerce

Visa's Trusted Agent Protocol (TAP), unveiled in 2025 in collaboration with Cloudflare, addresses a specific and high-stakes instance of the agent authorization problem: **autonomous payment actions**.

TAP adds cryptographically signed identity to every agent-initiated transaction. Signed HTTP messages transmit an agent's intent, verified user identity, and payment details. Critically, signatures are specific to the merchant and purpose, time-bound, and cannot be replayed or relayed — properties that bearer tokens do not have.

```
# TAP Signed Request Structure
POST /checkout HTTP/1.1
Agent-Identity: <signed-jwt-with-agent-did>
User-Delegation: <user-consent-token>
Transaction-Intent: <signed-operation-envelope>
Signature: keyId="agent-key-v2", algorithm="rsa-sha256", ...
```

TAP's core insight is that **authorization for high-stakes actions requires non-repudiation**. A bearer token tells the server "someone with this token is asking to do X." A TAP-signed request tells the server "agent A, acting under user B's delegation, is asking to do X at this specific merchant for this specific amount at this specific time, and this claim is cryptographically verifiable and non-replayable."

This is closer to a capability token than a bearer token. The request itself carries the authorization proof, scoped to the exact operation, not a general grant that the agent then uses as it sees fit.

Visa predicts mainstream agentic commerce adoption by the 2026 holiday season. TAP represents what authorization for consequential agent actions should look like — though the overhead of signed HTTP messages per transaction may not be appropriate for every domain.

### Microsoft Entra Agent ID: Enterprise Identity for Agents

Microsoft Entra Agent ID (GA in late 2025) extends Zero Trust principles — authentication, authorization, governance, lifecycle management — to non-human agent identities using standard protocols (OAuth 2.0, OIDC, MCP, A2A). Entra Agent ID supports two distinct authorization patterns:

**On-Behalf-Of (OBO) delegation**: The agent acts for a specific user. The downstream service enforces the user's current permissions. If the user loses access to a resource, so does the agent — real-time permission propagation. This is the correct pattern for agents that are fundamentally user-serving and should inherit the user's access boundaries.

**Autonomous agent identity**: The agent acts independently with its own identity and permissions, independent of any user session. This is appropriate for background agents (scheduled reports, continuous monitoring) where there is no live user to delegate from.

The distinction matters architecturally. Many platforms conflate these two modes, giving agents user-level credentials when they need autonomous identity or giving them service account credentials when they need to propagate user context. Entra Agent ID formalizes the choice and provides appropriate infrastructure for each mode.

Entra also provides Conditional Access policies for agent identities — the same risk-based access controls that apply to human users can now apply to agents. An agent accessing data from an unexpected location or at an unusual time can trigger additional verification requirements, just as a human would.

### AWS AgentCore Identity: Production-Scale Agent Auth

Amazon Bedrock AgentCore Identity (GA October 2025) is powered by Amazon Cognito extended with agent-specific capabilities. AgentCore addresses the practical deployment problem: **identity at scale** across hundreds or thousands of agent instances.

AWS's approach uses Workload Identity Federation to exchange credentials from external identity providers (including Microsoft Entra and Google IAM) for AWS credentials. This enables cross-cloud agent deployments where an agent running on GCP can access AWS resources through federated identity, without requiring a separate AWS-native identity.

The runtime authorization gap that AWS identifies is important: OAuth and API permissions answer "can the agent call this API?" but not "should the agent execute this action under business policy, compliance constraints, data boundaries, and approval thresholds?" AgentCore positions a runtime authorization decision plane as a separate layer from identity — an observation we'll return to in the practical implications section.

---

## Emerging Patterns and What They Signal

### Agent Identity as a First-Class Principal

The clearest signal from 2025–2026: **agents are not client applications**. Traditional OAuth treats the client application as the trust anchor — you grant "the GitHub app" access to your repositories. Agent architectures require treating *each agent instance* as a distinct principal with its own identity, declared capabilities, and lifecycle.

This shift has operational implications. Client application credentials are managed by developers and are stable. Agent identities need to be provisioned programmatically, associated with specific model versions and capability declarations, rotated as agents are updated, and revoked when agents are decommissioned. Microsoft Entra Agent ID and AWS AgentCore both provide infrastructure for this lifecycle management. Doing it with raw OAuth client credentials does not scale.

### Capability-Based Security vs. Role-Based

RBAC assigns permissions based on predefined roles. Roles are stable; agents are not. An agent's effective role shifts within a single conversation turn — from read-only research to write-capable code execution to external API calls. Static role assignment fails to track this dynamism.

The emerging alternative is **attribute-based or capability-based authorization** (ABAC/CapBAC), where access decisions incorporate:

- The agent's declared capability set (from its Agent Card or attestation)
- The current task context (what operation is actually being attempted)
- Real-time risk signals (unusual request patterns, anomalous timing, unexpected data access)
- Policy rules that combine these attributes

Policy-based authorization engines (OPA, Cedar, custom rule engines) are increasingly used as the authorization layer *above* OAuth — OAuth handles authentication and token issuance, while a policy engine handles the per-operation authorization decisions that OAuth's scope model is too coarse to express.

```cedar
// Cedar policy: agent can only delete records owned by the delegating user
permit(
  principal is Agent,
  action == Action::"deleteRecord",
  resource is Record
) when {
  principal.delegatedBy == resource.owner &&
  principal.capabilities.contains("record:delete") &&
  context.operationScope == "user-specific"
};
```

### Just-In-Time Authorization

The consent fatigue problem is real. Requiring users to approve every agent action breaks the utility of autonomous agents; never requiring approval creates serious security risks. The emerging resolution is **progressive autonomy with just-in-time escalation**:

- **Pre-approved operations**: Low-risk, reversible actions within a defined policy envelope. The agent executes without per-action approval.
- **Escalation triggers**: Policy rules define when an operation exceeds the pre-approved envelope — dollar amount threshold, sensitive data access, irreversible action, unusual context. These trigger a real-time user prompt.
- **Autonomous ceiling**: Operations above a certain risk threshold can never be pre-approved and always require explicit user confirmation.

The key insight is that consent is not binary (always ask vs. never ask). It can be structured as a policy that the agent operates within, with defined escalation points. This matches how humans delegate to other humans — we don't approve every email a delegate sends, but we do expect to be consulted before they sign contracts.

### Execution Sandboxing as Post-Authorization Constraint

Even with robust authorization, an authorized agent can still cause harm by acting correctly-authorized-but-unexpected. Post-authorization behavioral constraints — **execution sandboxing** — are an emerging complementary layer:

- Network egress controls (the agent's allowed external endpoints are enumerated, not open)
- Write scope restriction (agent can write to designated namespaces, not arbitrary paths)
- Rate limiting per agent instance (caps on tool call frequency and volume)
- Action rollback capabilities (reversible operations logged for potential undo)

Authorization answers "is this action permitted?" Sandboxing answers "even if permitted, can this action cause unbounded damage?" The two are different control planes. Platform builders increasingly implement both.

### Decentralized Identity for Agents (DIDs + Verifiable Credentials)

Research from late 2025 (arxiv 2511.02841) proposes equipping each agent with a ledger-anchored Decentralized Identifier (DID) and a set of Verifiable Credentials (VCs) that attest to its capabilities, authorizations, and provenance. Platforms like Indicio's ProvenAI are beginning to issue VCs to agents in production.

The appeal is cross-organizational portability. An agent issued credentials by organization A can present them to organization B's services without organization B needing to query organization A's identity provider. The credentials are cryptographically verifiable and carry the issuer's attestation.

This is promising for the cross-organizational trust problem (discussed below) but is early-stage. DID/VC infrastructure for agents has not reached the deployment maturity of OAuth-based patterns. Watch this space.

---

## Practical Implications for Agent Platform Builders

### When to Use OAuth Extensions vs. Custom Auth Layers

Use OAuth 2.1 (with PKCE + DCR) as your baseline for agent-to-tool authentication. It's widely supported, well-understood, and handles the credential exchange problem adequately. Do not try to build a custom credential scheme — the ecosystem is converging on OAuth 2.1 for this layer.

But recognize what OAuth does not provide: per-operation authorization, scope composition analysis, delegation depth limits, or multi-agent trust chain verification. For these, you need a separate authorization layer — a policy engine that sits above OAuth and makes per-operation decisions based on richer context than token scopes can express.

The architecture that works:

```
User/Agent Request
       ↓
[Identity Layer]        ← OAuth 2.1 / OIDC (who are you?)
       ↓
[Authorization Layer]   ← Policy engine / ABAC (can you do this, in this context?)
       ↓
[Execution Layer]       ← Sandboxed tool invocation
       ↓
[Audit Layer]           ← Structured action log with full principal chain
```

Conflating identity and authorization into a single OAuth token-check is the most common mistake in agent platform design.

### Agent Registry Patterns

Maintain a trusted agent registry that tracks:

- **Agent identity** (DID or Entra Agent ID / AgentCore ID)
- **Declared capabilities** (capability set, model version, tool access)
- **Authorization envelope** (which users have delegated to this agent, under what scope)
- **Operational constraints** (rate limits, network egress allowed, write namespaces)
- **Audit association** (which agent instance generated which action)

Pre-approved agents (those in the registry with a defined capability declaration) should require less friction to operate. Unknown agents (not in registry, or with unsigned/unverified Agent Cards) should require explicit user approval before executing operations beyond read-only scope.

This mirrors how enterprises manage third-party application access — a registry of approved apps with defined permission scopes — extended with the agent-specific properties that OAuth client registration does not capture.

### Token Binding and Scope Narrowing

When orchestrator agents delegate to sub-agents, use token binding patterns to enforce scope narrowing:

```python
# Orchestrator creates a narrowed delegation token for sub-agent
sub_agent_token = create_delegation_token(
    parent_token=orchestrator_token,
    max_scope=intersection(
        orchestrator_token.scope,
        sub_agent.declared_capabilities,
        current_subtask.required_scope
    ),
    max_depth=orchestrator_token.delegation_depth - 1,
    expiry=subtask_deadline,
    audience=sub_agent.id
)
```

Key constraints:
- Scope can only narrow at each delegation hop, never broaden
- Delegation depth must be explicit and decremented at each hop
- Audience binding prevents a sub-agent's token from being used by a different agent
- Expiry should match the sub-task timeline, not the parent token's full validity

JWT-based delegation tokens can encode these constraints directly in claims. The receiving agent's authorization layer verifies the constraints before executing any operation.

### Audit Trail Design for Non-Deterministic Agents

Standard OAuth audit logs record: token issued, token used, resource accessed. This is insufficient for agents. Agent audit trails must capture:

- **The full principal chain**: User → Orchestrator Agent (instance ID) → Sub-agent A (instance ID) → Tool invocation
- **The reasoning context**: What prompt and context state drove this action (hashed or summarized for privacy)
- **The authorization evidence**: Which policy rule authorized this specific operation, not just "token was valid"
- **The scope narrowing chain**: What the effective scope was at each delegation level
- **Revocation state at execution time**: Was the delegation still valid? Was the user's session still active?

The structured audit log is what makes post-incident investigation tractable. When an agent takes an unexpected action, you need to trace back: who authorized this? What context triggered it? What scope was claimed? Standard OAuth access logs cannot answer these questions for multi-hop agent chains.

### The UX Challenge: Consent Architecture

Avoid the two failure modes:

1. **Over-prompting**: Asking users to approve every agent action. Creates confirmation fatigue, leads to reflexive approval of anything, paradoxically reduces security.
2. **Under-prompting**: Asking once at agent setup and never again. The user grants broad authority that the agent exercises in ways the user did not anticipate.

The correct model is **consent architecture**: a structured policy that the user sets once, with well-defined escalation triggers that surface only when the agent encounters a decision outside the pre-approved envelope. This requires:

- A clear, human-readable description of what the agent's pre-approved envelope covers
- Explicit enumeration of the escalation triggers (amounts, actions, data types)
- An accessible audit summary so users can review what the agent has done
- Easy revocation that the agent will respect mid-execution

Building this well requires UX investment, not just protocol work. The policy editor, the escalation UX, and the audit summary are as important as the underlying authorization protocol.

---

## Open Problems

### No Standard for Agent Capability Certification

Today, an agent's declared capabilities are self-asserted in its Agent Card or identity registration. There is no standard for third-party certification of what an agent actually does vs. what it claims. An agent that declares "read-only calendar access" in its Agent Card can technically attempt write operations — the declaration is not enforced at the identity layer.

What is needed is analogous to app store certification: a process by which an agent's actual behavior (in a sandboxed test environment) is attested by a trusted third party, with the attestation included in the agent's signed credentials. This does not exist at production scale today.

### Cross-Organization Agent Trust

When organization A's agent needs to access organization B's APIs, existing protocols require either: a pre-established federation agreement between the two organizations' identity providers, or API key exchange (which is not scalable or auditable). Neither is adequate for the ecosystem model where agents freely discover and interact with external services.

The Cloud Security Alliance (March 2026) identified cross-domain agent trust as one of the top unsolved problems in agent security: "Without identity chaining protocols, tokens crossing trust domains shed their limitations." Delegation rules like "read-only" or "two-hop max" rarely survive the jump across organizational boundaries.

DID/VC-based approaches (where credentials are self-contained and cryptographically verifiable without querying the issuer's IdP) are the most promising direction, but deployment is nascent.

### Revocation Cascades in Agent Chains

When a user revokes an agent's authorization, what happens to the downstream sub-agents that agent has spawned? With bearer tokens, the answer is: nothing, until the tokens expire. A revoked delegation at depth zero does not automatically invalidate tokens issued at depth one, two, or three.

Capability tokens with explicit revocation identifiers and a revocation check at each hop can solve this technically. But the infrastructure for real-time revocation propagation in multi-agent chains does not exist in production deployments today. The practical result is that revocation is a best-effort operation with a window of continued agent activity equal to the sub-tokens' remaining validity period.

### Post-Quantum Considerations

Agent identity tokens will increasingly be long-lived (a continuous background agent may hold credentials for months). RSA and ECDSA signatures that are adequate today may not be adequate against quantum adversaries. NIST's post-quantum cryptography standards (finalized in 2024) need to be incorporated into agent identity schemes before agents become high-value cryptographic targets. This is a planning horizon issue now, not an immediate crisis — but agent platform architects should be choosing algorithms and key sizes with quantum migration in mind.

---

## Conclusion

OAuth 2.0 was a revolution in delegated authorization for the web. It is not adequate for AI agents, and extending it incrementally will not close the gap. The fundamental mismatches — request-level vs. sequence-level, deterministic vs. non-deterministic, session-scoped vs. persistent, two-party vs. multi-hop — require authorization models built with agent properties as first-class design constraints.

The 2025–2026 landscape has produced real progress: MCP's OAuth 2.1 + DCR standardizes the tool-layer integration surface; A2A's signed Agent Cards establish agent identity as distinct from application identity; ATH's scope intersection provides a principled model for tri-party delegation; Visa TAP demonstrates what non-repudiable agent authorization looks like for high-stakes actions; Entra Agent ID and AWS AgentCore bring lifecycle management infrastructure for enterprise deployments.

None of these is the complete answer. The field has not yet converged on a standard for capability certification, cross-organizational trust, or revocation cascades in agent chains. Platform builders working in this space today are making choices that will be revisited as standards mature.

Our recommendation for agent platform architects: implement OAuth 2.1 for the identity/credential layer, add a policy engine for per-operation authorization, adopt signed Agent Cards (A2A) for agent identity declarations, implement scope narrowing at every delegation boundary, and build audit infrastructure that captures the full principal chain — not just the terminal token check. Treat consent as architecture, not a checkbox. And watch the DID/VC ecosystem closely; it may provide the cross-organizational trust model the current OAuth-centric approaches cannot.

The agents are already running. The authorization models are catching up.

---

*Sources:*
- *[OAuth Is Not Enough: Authorization Challenges for Autonomous AI Agents — TechRxiv](https://www.techrxiv.org/users/928372/articles/1299852-oauth-is-not-enough-authorization-challenges-for-autonomous-ai-agents)*
- *[Standards, Gaps, and Research Directions for AI Agents — arXiv 2604.23280](https://arxiv.org/html/2604.23280v1)*
- *[Your AI Agent Passed OAuth. Now What? — DEV Community](https://dev.to/uu/your-ai-agent-passed-oauth-now-what-the-authorization-gap-nobody-talks-about-2404)*
- *[MCP Authorization Specification — modelcontextprotocol.io](https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization)*
- *[Client Registration and Enterprise Management in the November 2025 MCP Authorization Spec — Aaron Parecki](https://aaronparecki.com/2025/11/25/1/mcp-authorization-spec-update)*
- *[Agent2Agent Protocol v0.3 Upgrade — Google Cloud Blog](https://cloud.google.com/blog/products/ai-machine-learning/agent2agent-protocol-is-getting-an-upgrade)*
- *[Visa Trusted Agent Protocol — Visa Developer](https://developer.visa.com/capabilities/trusted-agent-protocol/overview)*
- *[Visa Introduces Trusted Agent Protocol: An Ecosystem-Led Framework for AI Commerce](https://corporate.visa.com/en/sites/visa-perspectives/newsroom/visa-unveils-trusted-agent-protocol-for-ai-commerce.html)*
- *[Microsoft Entra Agent ID — Microsoft Learn](https://learn.microsoft.com/en-us/entra/agent-id/what-is-microsoft-entra-agent-id)*
- *[AI Agent Identity at Scale: Microsoft Entra Agent ID vs. AWS AgentCore Identity — DEV Community](https://dev.to/sreeni5018/ai-agent-identity-at-scalemicrosoft-entra-agent-id-vs-aws-agentcore-identity-1945)*
- *[Why RBAC Is Not Enough for AI Agents — Oso](https://www.osohq.com/learn/why-rbac-is-not-enough-for-ai-agents)*
- *[RBAC Is Not Enough for AI Agents: A Practical Authorization Model — TianPan.co](https://tianpan.co/blog/2026-04-20-rbac-ai-agents-authorization)*
- *[Authorization Propagation in Multi-Agent AI Systems — arXiv 2605.05440](https://arxiv.org/html/2605.05440v1)*
- *[AI Agents with Decentralized Identifiers and Verifiable Credentials — arXiv 2511.02841](https://arxiv.org/html/2511.02841v1)*
- *[AI Security Across Domains: Who Vouches? — Cloud Security Alliance](https://cloudsecurityalliance.org/blog/2026/03/11/ai-security-when-your-agent-crosses-multiple-independent-systems-who-vouches-for-it)*
- *[Decision Provenance in Agentic Systems: Audit Trails That Actually Work — TianPan.co](https://tianpan.co/blog/2026-04-19-decision-provenance-agentic-systems)*
- *[Before the Tool Call: Deterministic Pre-Action Authorization for Autonomous AI Agents — arXiv 2603.20953](https://arxiv.org/pdf/2603.20953)*
- *[Agent Identity overview — Google Cloud IAM](https://docs.cloud.google.com/iam/docs/agent-identity-overview)*
- *[Confirmation Fatigue and the Protocol Gap in Agentic AI Oversight](https://changkun.de/blog/ideas/human-in-the-loop-agents/)*
- *[AI Agent Identity Management: A 2026 CISO Playbook — Security Boulevard](https://securityboulevard.com/2026/05/ai-agent-identity-management-a-2026-ciso-playbook/)*
