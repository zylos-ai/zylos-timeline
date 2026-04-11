---
date: "2026-04-11"
title: "Agent Authentication & Delegated Access: OAuth Flows, Scoped Tokens, and Identity Patterns for AI Agents (2026)"
description: "How AI agents authenticate, obtain least-privilege access, and act on behalf of users — from OAuth 2.1 and RFC 8693 token exchange to SPIFFE workload identity, JIT provisioning, and the emerging IETF standards shaping the field."
tags: ["ai-agents", "authentication", "oauth", "security", "identity", "authorization"]
---

## Executive Summary

The rise of autonomous AI agents has exposed a fundamental gap in identity infrastructure: the entire auth stack was built for humans logging in, not for software principals acting indefinitely on their behalf. In 2026, this gap is being patched from four directions simultaneously — OAuth 2.1 extensions for agentic delegation, SPIFFE/SVID workload identity standards for machine-speed attestation, purpose-built commercial platforms (Aembit, Stytch, Nango, WorkOS FGA, CyberArk for AI), and a flurry of IETF drafts racing to standardize agent identity semantics before the market fragments permanently.

The stakes are concrete: a 2026 survey of 900+ practitioners found that 93% of AI agent projects are still using unscoped API keys, and 74% of respondents said their agents end up with more access than they actually need. With agents now calling APIs, querying databases, provisioning cloud infrastructure, and orchestrating other agents, those excess permissions translate directly into blast radius when something goes wrong.

This article maps the full problem space — the unique identity challenges agents pose, the technical patterns being deployed to address them, the vendors and open-source projects shaping the landscape, and the open questions that remain unsolved heading into the second half of 2026.

---

## Problem Statement: Why Agent Auth Is Different

### The Perpetual Delegation Problem

Traditional OAuth was designed for a specific scenario: a human user opens a browser, authenticates, consents to a scope, and an app receives a short-lived access token. The human's session is the authorization context. When the session ends, the token expires.

AI agents break every assumption in that model.

An agent may be initiated by a user but continue operating hours, days, or weeks after that user closes their browser. The initiating session is gone; the authority to act must persist. This transforms what OAuth called a "short-lived login artifact" into long-lived delegated infrastructure. Refresh tokens rotate, access tokens expire and renew, and the agent keeps running — but who authorized that continued operation? Under what constraints? With what ability to revoke?

This isn't a theoretical concern. Production deployments of coding agents (e.g., GitHub Copilot Workspace, Cursor background tasks), customer service agents, and data pipeline agents all exhibit this pattern. The authorization event and the authorization context have decoupled.

### The Scope Collapse Problem

When teams want an agent to "do stuff with Google Drive," the path of least resistance is to hand it a Google OAuth token with drive.readonly or drive scope. That token is valid for far more than the agent's actual task. If the agent is compromised, hijacked via prompt injection, or simply makes an error, it can read or write far beyond the intended scope. This is scope collapse: an agent accumulates the full privileges of the initiating user, even when its actual task requires only a narrow slice.

The correct model — narrow, purpose-built tokens scoped to the specific task — requires infrastructure most teams don't have. So they take the shortcut, and the shortcut becomes the production system.

### The Multi-Hop Delegation Problem

Agentic systems increasingly involve orchestrator agents spawning subagents that call tools that call external APIs. At each hop, the question of "under whose authority is this acting?" becomes harder to answer. If a user authorizes an orchestrator, does that authority flow automatically to subagents? To what depth? Can a subagent acquire more permissions than the orchestrator that spawned it? RFC 8693's token exchange mechanism supports nested delegation chains, but it also introduces a known security weakness (delegation chain splicing) that was formally documented by the IETF OAuth WG in early 2026.

### The Non-Human Identity Provenance Problem

Humans have established provenance mechanisms — SAML assertions, OIDC tokens, MFA factors. When a token says "this is Alice," there's a chain of evidence back to Alice's credential event. When an agent says "I'm the customer-support-orchestrator-v2.3," the chain of evidence is murky. What codebase generated this agent? What model is it running? Was it deployed from a verified artifact? The identity question for agents is fundamentally also a provenance question, and that requires cryptographic build attestation, not just token claims.

---

## Landscape and Taxonomy

### Category 1: OAuth Extensions for Agents

**OAuth 2.1** (the 2025 consolidation of 2.0) mandates PKCE for all public clients and deprecates implicit grant and resource owner password credentials. For agents, this is the baseline: Authorization Code + PKCE for interactive authorization flows where a user is present to consent.

**RFC 8693 — OAuth 2.0 Token Exchange** defines the Security Token Service (STS) pattern where an existing token is exchanged for a narrower, task-scoped token. The exchange request specifies `subject_token` (the existing credential), `actor_token` (the agent's identity), `scope` (the reduced scope desired), and `requested_token_type`. The STS validates both tokens and issues a new one. For agents, this is the right primitive for scope reduction: start with a user's broad token, exchange it for a tool-specific token before the agent calls that tool. A delegation chain (the `act` claim hierarchy in the response) records the path from original authorizer through each delegation step.

The 2026 IETF OAuth WG thread on "delegation chain splicing" is worth understanding: a compromised intermediary can present a valid subject token and a valid actor token that came from different contexts, and the STS — validating each independently — issues a properly-signed token asserting a chain that never actually occurred. Mitigations require binding subject and actor tokens to the same authorization request, which most current implementations do not enforce.

**On-Behalf-Of (OBO)** is Microsoft's pre-RFC implementation of token exchange, widely deployed in Azure AD / Entra. It allows a service that received a user token to exchange it for a token scoped to a downstream service, with the user's identity preserved in the chain. For agent developers targeting enterprise Microsoft environments, OBO is often the fastest path.

**DPoP (Demonstrating Proof of Possession)** binds access tokens to a specific client key pair, preventing bearer token theft. A DPoP-protected token is useless to an attacker who intercepts it without also possessing the private key. For agents operating in environments where token exfiltration is a risk (prompt injection attacks that leak context), DPoP provides a meaningful additional layer.

**CAEP (Continuous Access Evaluation Protocol)** enables real-time revocation by publishing access change events that relying parties can react to sub-second. For agents that hold long-lived access, CAEP is the emergency brake: if a user's account is compromised, or a user revokes consent, CAEP-aware systems can terminate the agent's access within seconds rather than waiting for token expiry.

### Category 2: Workload Identity

**SPIFFE (Secure Production Identity Framework For Everyone)** defines cryptographically verifiable workload identities. A SPIFFE Verifiable Identity Document (SVID) is either an X.509 certificate or a JWT token encoding a SPIFFE ID of the form `spiffe://trust-domain/path/to/workload`. SPIRE is the reference implementation. HashiCorp Vault 1.21 added native SPIFFE authentication, enabling agents to obtain Vault secrets by presenting their SVID rather than a static API key.

SPIFFE IDs are tied to workloads, not people, making them structurally correct for AI agents. An agent's SVID encodes its origin, deployment path, and trust domain. Critically, SVIDs are short-lived and automatically rotated by the SPIRE agent, eliminating the standing credential problem entirely. The CNCF's 2026 recommendation for internal service-to-service auth is "SPIFFE for identity, OAuth 2.0 for access delegation, OPA for policy."

**Workload Identity Federation (WIF)** — available in AWS (IAM Roles Anywhere), GCP (Workload Identity Federation), and Azure (Managed Identity / federated credentials) — allows workloads to exchange platform-issued identity tokens (OIDC JWTs, SVIDs) for cloud IAM credentials without any long-lived secrets. For agents deployed in cloud infrastructure, WIF is often the right primitive: the agent gets an IAM role via its platform identity, and that role is scoped to exactly the resources it needs.

### Category 3: MCP Authorization

The Model Context Protocol (MCP), which reached 97 million monthly downloads by March 2026, specifies its own authorization layer. The MCP Authorization Specification defines:

- **Protected Resource Metadata (PRM)**: A standard endpoint (`.well-known/oauth-protected-resource`) where MCP servers advertise their authorization requirements. Clients discover the authorization server URL, required scopes, and token endpoint from this metadata — no hardcoded configuration.
- **MCP clients as OAuth 2.1 clients**: MCP clients obtain access tokens via Authorization Code + PKCE and present them as Bearer tokens on MCP requests. The MCP server validates the token against the authorization server.
- **Resource indicators (RFC 8707)**: Tokens are bound to specific resource URIs, preventing token reuse across unintended servers.

Cloudflare's Agents platform implements MCP authorization natively, providing a managed OAuth 2.1 server that handles the full consent flow when an agent first requests access to a Cloudflare-hosted MCP server. The Claude Desktop MCP OAuth implementation (shipped December 2025) follows the same spec.

### Category 4: Agent-to-Agent (A2A) Authorization

When an orchestrator agent needs to invoke a subagent, neither party is a human. The emerging patterns are:

**Delegated sub-tokens**: The orchestrator's token is exchanged (via RFC 8693) for a narrower token scoped to the subagent's domain. The subagent receives only the authority the orchestrator explicitly delegates.

**Mutual TLS + SPIFFE**: Subagents authenticate to each other via mTLS, with certificates rooted in the same SPIFFE trust domain. Authorization policy (in OPA or similar) then determines what operations the calling agent can perform on the called agent.

**JWT delegation chains**: A user-issued JWT is passed as `subject_token`; each agent in the chain receives an `actor_token` and requests a new narrowed token. The resulting chain's `act` claim hierarchy records the full delegation path, satisfying audit requirements.

---

## Key Patterns and Technical Mechanisms

### Pattern 1: Scope Reduction via Token Exchange

The most important operational pattern for agents is exchanging broad user tokens for task-scoped tokens before any external API call. Implementation sketch:

1. User authenticates and grants broad scopes (e.g., `email`, `calendar.events`, `drive.file`)
2. Orchestrator receives this token but does not use it directly
3. Before calling Calendar API, orchestrator calls the STS: exchange user token for a `calendar.events.readonly`-scoped token with 15-minute TTL
4. Before calling Drive API, orchestrator calls the STS: exchange user token for a `drive.file`-scoped token covering only the specific file ID
5. Subagents only ever receive the task-scoped token for their specific operation

The reduction in blast radius is significant: a compromised subagent can only affect the specific resource it was scoped to, not the user's entire Google account. Platforms like Aembit's MCP Identity Gateway automate this pattern: the gateway intercepts outbound agent calls and performs real-time credential exchange against the appropriate backend, so the agent never directly holds upstream credentials.

### Pattern 2: Just-in-Time (JIT) Credential Issuance

Zero Standing Privileges (ZSP) applied to agents means: agents hold no credentials at rest. When the agent needs access to a resource, it requests a credential for that specific operation; the request goes through policy evaluation; if approved, a short-lived credential is issued and used; access is automatically revoked when the operation completes.

Aembit's 2026 JIT access paper quantifies the benefit: the exploitation window for a stolen credential shrinks from "indefinite" (standing API key) to "minutes or seconds" (ephemeral JIT token). For agents running in sandboxed environments where process memory is accessible to prompt injection, eliminating standing credentials removes the most valuable exfiltration target.

BeyondTrust's PAM platform extended JIT access to AI agents in early 2026, allowing enterprises to route agent credential requests through the same approval workflows used for human privileged access. CyberArk shipped its first AI-agent-specific identity security offering in Q1 2026, introducing privileged controls designed specifically for autonomous agents — including session recording for agent API calls, equivalent to the privileged session management used for human administrators.

### Pattern 3: Blended Identity (Human + Agent)

Aembit's GA release in April 2026 introduced "Blended Identity" as a differentiator: access policy evaluates the identity of the AI agent AND the identity of the human operator who invoked it, simultaneously. This enables policies like:

- "Agent X can access production database, but only when invoked by a member of the SRE team"
- "Agent Y can call the payment API, but only between 09:00–17:00 and never for users in region EU-SANCTION"
- "Agent Z can read customer PII, but only when the invoking user has completed MFA in the last 30 minutes"

This pattern is important because it collapses the dangerous assumption that agent identity alone is sufficient for access decisions. An agent's identity tells you what software is running; it doesn't tell you who authorized the current task or whether that authorization was legitimate.

### Pattern 4: Capability URLs and Macaroon-Style Tokens

Several teams are experimenting with capability URLs — HTTPS URLs that encode their own authorization (the URL itself is the capability). Sharing the URL shares the capability. This pattern (popularized by Google Drive's "share link" feature) has interesting properties for agent-to-agent handoffs: an orchestrator can generate a capability URL scoped to a specific resource and pass it to a subagent without any separate auth flow.

Macaroon tokens extend this idea: structured tokens where authorization caveats can be appended (attenuated) at each delegation step, and the resulting token is verifiable without contacting the issuer. For agent systems where the authorization server may be unavailable or slow, macaroons enable offline capability delegation while preserving the property that delegates can only narrow, never expand, the original grant.

### Pattern 5: Cryptographic Attestation for Agent Provenance

The supply chain concern — "is this agent actually the software we think it is?" — requires attestation beyond token claims. Microsoft's Agent Governance Toolkit (released April 2, 2026) ships with SLSA-compatible build provenance: agent artifacts are signed at build time, and the runtime verifies the signature before executing the agent. The toolkit's Agent Mesh component assigns cryptographic identities using DIDs (Decentralized Identifiers) with Ed25519 keys.

Prova Trust offers Attestation-as-a-Service: a hardware-backed API that issues verifiable attestation certificates for running AI agents, covering model hash, runtime environment, and deployment origin. These certificates can be included in agent authentication flows, allowing relying parties to verify not just "who is this agent" but "what code is this agent running and from what verified artifact."

---

## Vendor and Tool Comparison

### Aembit — IAM for Agentic AI (GA: April 2026)

Architecture: MCP Authorization Server (managed cloud) + MCP Identity Gateway (deployable VM). Key capabilities: OAuth 2.1 flows, Blended Identity (human + agent), JIT credential issuance, policy-based kill switch, SIEM-integrated audit logs, Okta/Azure AD integration. Differentiator: The only platform as of April 2026 to evaluate human and agent identity jointly in access decisions. Target: enterprises needing to govern existing agent deployments at scale.

### Stytch Connected Apps

Architecture: API-first B2B auth platform extension. Key capabilities: OAuth 2.1 token lifecycle management, consent UI, MCP authorization support (shipped late 2025), PKCE, SCIM. Differentiator: Deep developer ergonomics; designed for product teams building agent-enabled SaaS rather than security teams governing deployed agents. Target: developers building B2B platforms that want to offer "AI agent access" as a feature.

### Nango

Architecture: Open-source OAuth infrastructure with managed cloud offering. Key capabilities: OAuth flow handling, automatic token refresh, multi-tenant credential isolation, support for 400+ APIs. Differentiator: Focused exclusively on the OAuth pipe — handles tokens, stays out of your way. No opinions on authorization policy. Target: teams that want clean OAuth integration without building and maintaining the plumbing.

### WorkOS FGA (Fine-Grained Authorization)

Architecture: Zanzibar-inspired authorization service. Key capabilities: Hierarchical, resource-scoped RBAC/ABAC, designed for B2B multi-tenant products, AI agent permission integration. Differentiator: Handles the authorization policy layer that OAuth alone cannot — "can this agent perform this specific operation on this specific resource for this specific tenant?" Target: B2B SaaS companies with complex tenant-permission topologies.

### Composio

Architecture: Integration platform with managed auth. Key capabilities: 500+ connectors, OAuth lifecycle management, MCP support, agent-specific APIs. Differentiator: Broadest connector coverage; handles both auth and integration in a single SDK. Target: developers who want to give agents access to many external tools as fast as possible.

### CyberArk for AI Agents (Q1 2026)

Architecture: Extension of existing PAM platform. Key capabilities: Agent session recording, privileged access workflows, JIT credential issuance for agents, integration with CyberArk Vault. Differentiator: Enterprise pedigree; routes agent credential requests through existing PAM governance workflows. Target: regulated enterprises (finance, healthcare, government) that already use CyberArk and need to extend their PAM policies to cover AI agents.

### BeyondTrust

Architecture: PAM + endpoint privilege management. Key capabilities: Privileged Account and Session Management (PASM) for agents, JIT privileged access. Differentiator: Strong session monitoring and recording capabilities applicable to agent API call streams. Target: enterprises with existing BeyondTrust deployment looking to extend coverage to agents.

### SPIFFE/SPIRE (CNCF, open-source)

Architecture: Workload identity issuing infrastructure. Key capabilities: SVID issuance (X.509 / JWT), automatic rotation, mTLS bootstrapping, Vault integration (native from 1.21). Differentiator: Open standard, no vendor lock-in, designed specifically for non-human workload identity. Target: engineering teams who want CNCF-standard, self-hosted workload identity as the foundation for both agents and services.

### Microsoft Agent Governance Toolkit (April 2026, open-source)

Architecture: Runtime security layer — Agent Mesh (cryptographic identities, IATP), Policy Runtime (OPA, OWASP mitigations), Build Pipeline (SLSA provenance). Key capabilities: DIDs, dynamic trust scoring (0–1000), SLSA attestation, all 10 OWASP agentic AI risks addressed. Differentiator: First open-source toolkit combining agent identity, runtime policy, and build provenance in a single package. Target: teams who want deterministic, sub-millisecond policy enforcement for agents and are comfortable with a Microsoft-led OSS project.

---

## Emerging IETF Standards

The IETF produced an unusual density of agent-identity-relevant drafts in Q1 2026, reflecting both the urgency of the problem and the lack of consensus on the right approach:

**draft-klrc-aiagent-auth-01** — "AI Agent Authentication and Authorization": Defines agent attestation as the identity-proofing mechanism. Introduces `agent_assertion` as a new OAuth grant type and specifies how agent metadata (model hash, runtime environment, deployment origin) can be included in token requests.

**draft-ni-wimse-ai-agent-identity-02** — "WIMSE Applicability for AI Agents": Extends the Workloads in Multi-System Environments (WIMSE) WG's workload identity spec to cover AI agents specifically, addressing ephemeral agent instances and the agent-spawns-agent case.

**draft-yl-agent-id-requirements-00** — "Digital Identity Management for AI Agent Communication Protocols": Proposes a globally unique identifier format for agents in an "interoperable, universal format" usable across agent communication protocols.

**draft-aip-agent-identity-protocol-00** — "Agent Identity Protocol: Agentic Authentication and Authorized Policy Enforcement": Defines AIP as an open standard for verifiable identity and policy enforcement for AI agents, with a focus on preventing unbounded permissions.

**SCIM Agents Extension (draft-abbey-scim-agent-extension-00)**: Proposes two new SCIM resource types — `Agents` and `AgenticApplications` — giving identity systems (Okta, Azure AD, etc.) a standard way to represent and provision non-human identities at the same lifecycle fidelity as human users.

The Agent Name Service (ANS) proposal maps agent identities to verified capabilities, cryptographic keys, and endpoints — functioning as a PKI-backed directory for agent discovery and trust establishment.

None of these drafts has achieved RFC status as of April 2026. The field is in the "competing proposals" phase. Most production teams are building on OAuth 2.1 + PKCE + RFC 8693 because those are the most mature standards available, regardless of whether they're the theoretically optimal primitives for agent identity.

---

## Tradeoffs and Open Questions

### The Consent Problem

For delegated access to work correctly, the user must meaningfully consent to what the agent will do on their behalf. But agent tasks are often defined at a level of abstraction ("analyze my inbox and flag important threads") that makes it impossible to specify precise OAuth scopes at consent time. The agent will need whatever scopes are required to complete the task — but the task may evolve. 

The current workaround is broad up-front consent, which defeats the purpose of scoping. More principled approaches (incremental consent, task-aware scope suggestions, just-in-time consent prompts) exist in prototype but aren't yet production-standard. RSAC 2026's agent identity track made this a recurring theme: "OAuth tells you who the caller is; it says nothing about whether the action was actually intended by the user."

### The Action Governance Gap

Multiple presenters at RSAC 2026 converged on the same conclusion: identity alone is insufficient. Knowing that "agent X, acting on behalf of user Y" made a request doesn't tell you whether that request was within the bounds of what the user intended, whether the agent was behaving as designed, or whether a prompt injection attack had modified the agent's intent. Action governance — intercepting and evaluating individual tool calls against policy, independent of the identity layer — is the "missing layer" that most current deployments lack.

This is the distinction between authorization (can this identity perform this class of action?) and action governance (should this specific action be allowed given current context?). The latter requires runtime policy evaluation at every tool call, not just at token issuance time.

### The Multi-Agent Depth Problem

RFC 8693 supports nested delegation chains in the `act` claim, but there's no standard limit on chain depth. In practice, orchestrator systems can build delegation chains 5–10 hops deep. At that depth, the "human in the loop" semantic of OAuth delegation becomes notional rather than meaningful — no human reviewed each step in the chain. The "max delegation depth" concept (capping how many hops authority can propagate) is discussed in draft-klrc-aiagent-auth-01 but not yet standardized.

### Token Storage in Agent Runtimes

Where does an agent store its credentials between operations? Options include: encrypted in a local secrets manager (risk: process memory exposure), in a cloud secrets vault (risk: latency overhead per operation), externalized to a credential proxy like Aembit's gateway (risk: availability dependency), or not at all (JIT pattern: the agent holds no credentials, requests them at operation time). The JIT pattern is theoretically cleanest but adds latency to every external call. For latency-sensitive agent loops, credential caching becomes necessary, reintroducing the storage problem.

### The Fragmentation Risk

With five different vendors releasing five different agent identity frameworks in the same week at RSAC 2026 (CrowdStrike, Cisco, Palo Alto, Microsoft, Cato CTRL), and multiple competing IETF drafts, there's a real fragmentation risk. An agent ecosystem built on CyberArk PAM doesn't interoperate with one built on Aembit's MCP Gateway without custom integration work. If the IETF drafts don't converge on a unified approach within 12–18 months, enterprises may find themselves locked into vendor-specific agent identity systems the same way they became locked into vendor-specific SSO systems in the early 2000s.

---

## Implications for Zylos

Zylos is precisely the system that these patterns are designed for: a persistent, multi-service AI agent OS that holds long-lived delegated access to Telegram, Lark, Google Calendar, Gmail, GitHub, and other services. The current architecture uses static API keys and tokens stored in `.env` — the 93% pattern that the industry has identified as the primary security liability for agentic systems.

**Immediate priority: Credential externalization.** Moving secrets out of `.env` and into a secrets manager with short TTL tokens (AWS Secrets Manager, HashiCorp Vault, or Doppler) is the highest-impact near-term improvement. Zylos doesn't need Aembit-grade orchestration immediately; it needs to stop holding long-lived static credentials in a plaintext file.

**Medium-term: OAuth 2.1 for external service integrations.** Services that support OAuth (Google APIs, GitHub, possibly Telegram bots via OAuth for third-party apps) should be integrated via OAuth flows with token refresh rather than static API keys. Nango is purpose-built for this — a single integration layer that handles token lifecycle, refresh, and multi-service credential isolation.

**Medium-term: Scope audit.** For each external service Zylos accesses, document the minimum required scopes. Where current tokens are over-scoped (which is likely for Google APIs), re-authorize with narrow scopes. This requires no new infrastructure — just re-running the OAuth flow with a constrained `scope` parameter.

**Long-term: JIT credential issuance for high-risk operations.** Operations that carry significant blast radius (sending messages to users, posting content, modifying calendar events) should be gated by a JIT approval flow rather than exercised from standing credentials. This is the architectural direction the industry is moving toward, and it aligns with Zylos's existing approval/consent loop patterns.

**Architecture consideration: MCP Authorization.** As Zylos adopts MCP more broadly for tool connectivity, the MCP Authorization spec (OAuth 2.1 + PRM) becomes the natural auth layer for MCP server connections. Building MCP clients that properly implement the Authorization Code + PKCE flow, consuming PRM metadata, and scoping tokens per MCP server will position Zylos correctly as the MCP ecosystem matures.

**Trust model for subagents.** Zylos already spawns background subagents (Task tool, memory sync, scheduled tasks). As this pattern grows, implementing delegated token scope (subagents receive a narrowed token derived from the parent session's authority, not a copy of the full credential set) prevents privilege escalation through the agent hierarchy.

---

## Conclusion

Agent authentication and delegated access in 2026 is a field in rapid transition: the problem is clearly defined, the worst practices are well-documented (unscoped API keys, inherited user tokens, standing credentials), and multiple solution paths exist — but no single dominant standard has emerged.

The practical tier-zero for any production agent system is: no standing credentials, no unscoped tokens, no shared secrets across agents. OAuth 2.1 + PKCE for user-delegated flows, RFC 8693 token exchange for scope reduction, SPIFFE/SVID for machine-to-machine identity, and JIT issuance for high-privilege operations. These primitives are mature, widely supported, and implementable today.

The harder problems — action governance beyond identity, meaningful consent for high-level agentic tasks, delegation chain depth limits, interoperability across vendor identity systems — remain open. The IETF drafts active in early 2026 suggest the standards community is engaged, but the 12–24 month timeline to RFC means enterprises need to make practical architectural choices now, before full standardization. Those that build on OAuth 2.1 and SPIFFE (both stable, widely implemented standards) are best positioned to integrate the agent-specific extensions as they arrive.

The identity question is not an optional concern. As CyberArk's Q1 2026 launch materials put it: agents that lack verifiable identity, auditable authority chains, and revocable credentials are indistinguishable from insider threats from the perspective of downstream systems. Giving agents proper identity infrastructure is not just security hygiene — it's what allows organizations to trust agents with meaningful work.

---

## References

- [2026 Guide to OAuth Token Exchange & Agentic AI — Strata](https://www.strata.io/blog/agentic-identity/why-agentic-ai-demands-more-from-oauth-6a/)
- [OAuth for AI Agents: Production Architecture and Practical Implementation Guide — Scalekit](https://www.scalekit.com/blog/oauth-ai-agents-architecture)
- [Agent-to-Agent OAuth: A Guide for Secure AI Agent Connectivity with MCP — Stytch](https://stytch.com/blog/agent-to-agent-oauth-guide/)
- [How to Authenticate AI Agents in B2B SaaS: Delegated Auth, Scoped Tokens, and Audit Trails — Medium](https://geekpython.medium.com/how-to-authenticate-ai-agents-in-b2b-saas-delegated-auth-scoped-tokens-and-audit-trails-3b7b31f97878)
- [On-Behalf-Of Authentication for AI Agents: Secure, Scoped, and Auditable Delegation — Scalekit](https://www.scalekit.com/blog/delegated-agent-access)
- [Auth0 Token Vault: Secure Token Exchange for AI Agents — Auth0](https://auth0.com/blog/auth0-token-vault-secure-token-exchange-for-ai-agents/)
- [MCP, OAuth 2.1, PKCE, and the Future of AI Authorization — Aembit](https://aembit.io/blog/mcp-oauth-2-1-pkce-and-the-future-of-ai-authorization/)
- [MCP Authorization Specification — Model Context Protocol](https://modelcontextprotocol.io/specification/draft/basic/authorization)
- [Authorization for MCP: OAuth 2.1, PRMs, and Best Practices — Oso](https://www.osohq.com/learn/authorization-for-ai-agents-mcp-oauth-21)
- [MCP Authentication & Authorization: Guide for 2026 — Infisign](https://www.infisign.ai/blog/what-is-mcp-authentication-authorization)
- [Authorization — Cloudflare Agents Docs](https://developers.cloudflare.com/agents/model-context-protocol/authorization/)
- [New Identity Playbook for AI Agents in 2026 — Strata](https://www.strata.io/blog/agentic-identity/new-identity-playbook-ai-agents-not-nhi-8b/)
- [AI Agent Identity and Next-Gen Enterprise Authentication Prominent at RSAC 2026 — Biometric Update](https://www.biometricupdate.com/202603/ai-agent-identity-and-next-gen-enterprise-authentication-prominent-at-rsac-2026)
- [RSAC 2026 Proved Agent Identity Is Not Enough: The Missing Layer Is Action Governance — DEV Community](https://dev.to/aguardic/rsac-2026-proved-agent-identity-is-not-enough-the-missing-layer-is-action-governance-e9a)
- [SPIFFE: Securing the Identity of Agentic AI and Non-Human Actors — HashiCorp](https://www.hashicorp.com/en/blog/spiffe-securing-the-identity-of-agentic-ai-and-non-human-actors)
- [Agent Identity and Access Management — Can SPIFFE Work? — Solo.io](https://www.solo.io/blog/agent-identity-and-access-management---can-spiffe-work)
- [SPIFFE Meets OAuth2: Current Landscape for Secure Workload Identity in the Agentic AI Era — Riptides](https://riptides.io/blog-post/spiffe-meets-oauth2-current-landscape-for-secure-workload-identity-in-the-agentic-ai-era/)
- [SPIFFE vs. OAuth: Access Control for Nonhuman Identities — Security Boulevard](https://securityboulevard.com/2026/03/spiffe-vs-oauth-access-control-for-nonhuman-identities/)
- [Zero Standing Privileges: The Only Way to Stop Agent Privilege Drift — Strata](https://www.strata.io/blog/zero-standing-privileges-the-only-way-to-stop-agent-privilege-drift/)
- [Aembit IAM for Agentic AI Is Now Generally Available — Aembit](https://aembit.io/blog/aembit-iam-for-agentic-ai-is-now-generally-available/)
- [JIT Access for Workloads: Eliminating Standing Privileges — Aembit](https://aembit.io/blog/jit-access-workloads-eliminating-standing-privileges/)
- [CyberArk Introduces First Identity Security Solution Purpose-Built to Protect AI Agents — CyberArk](https://www.cyberark.com/press/cyberark-introduces-first-identity-security-solution-purpose-built-to-protect-ai-agents-with-privilege-controls/)
- [RFC 8693: OAuth 2.0 Token Exchange — IETF](https://www.rfc-editor.org/rfc/rfc8693.html)
- [Delegation Chain Splicing in RFC 8693 Token Exchange — IETF OAuth WG](http://www.mail-archive.com/oauth@ietf.org/msg25680.html)
- [draft-klrc-aiagent-auth-01: AI Agent Authentication and Authorization — IETF](https://datatracker.ietf.org/doc/draft-klrc-aiagent-auth/)
- [draft-ni-wimse-ai-agent-identity-02: WIMSE Applicability for AI Agents — IETF](https://datatracker.ietf.org/doc/draft-ni-wimse-ai-agent-identity/)
- [draft-aip-agent-identity-protocol-00: Agent Identity Protocol — IETF](https://datatracker.ietf.org/doc/draft-aip-agent-identity-protocol/)
- [SCIM for AI: Inside the New IETF Draft for Agent and Agentic Application Provisioning — WorkOS](https://workos.com/blog/scim-agents-agentic-applications)
- [State of AI Agent Security 2026 — Grantex](https://grantex.dev/report/state-of-agent-security-2026)
- [Best Authorization Platforms for Managing AI Agent Permissions in 2026 — WorkOS](https://workos.com/blog/best-authorization-platforms-ai-agent-permissions-2026)
- [Best AI Agent Authentication Platforms to Consider in 2026 — Nango](https://nango.dev/blog/best-ai-agent-authentication/)
- [Introducing the Agent Governance Toolkit: Open-Source Runtime Security for AI Agents — Microsoft](https://opensource.microsoft.com/blog/2026/04/02/introducing-the-agent-governance-toolkit-open-source-runtime-security-for-ai-agents/)
- [How Treating AI Agents as Identities Can Reduce Enterprise AI Risk — Security Boulevard](https://securityboulevard.com/2026/04/how-treating-ai-agents-as-identities-can-reduce-enterprise-ai-risk/)
- [AI Agent Identity & Zero-Trust: The 2026 Playbook — Medium](https://medium.com/@raktims2210/ai-agent-identity-zero-trust-the-2026-playbook-for-securing-autonomous-systems-in-banks-e545d077fdff)
- [Attestation as a Service for AI Agents — Prova Trust](https://www.provatrust.com/)
