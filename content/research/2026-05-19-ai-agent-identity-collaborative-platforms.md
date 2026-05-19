---
date: "2026-05-19"
title: "AI Agent Identity in Collaborative Platforms: First-Class Citizens, Not Second-Class Integrations"
description: "How collaborative platforms handle AI agent identity, authentication, and authorization — and why unified identity models with human/agent parity represent the architectural frontier."
tags: ["ai-agents", "identity", "authentication", "authorization", "rbac", "multi-tenant", "collaborative-platforms", "security"]
---

## Executive Summary

The industry has reached consensus in 2025-2026: AI agents must be first-class identity principals, not second-class API integrations. Yet every major platform studied — GitHub, Slack, Discord, Notion, Google Workspace — still treats agents as structurally different from human users. Agents cannot hold organizational memberships, participate in RBAC role assignments, or appear in member directories the same way humans do. The gaps are operational: 93% of agent projects still use unscoped API keys, agents are projected to outnumber human identities 80-to-1 by 2027, and only 10% of organizations have formal agent governance. A unified identity model — single identity table, `type: human | agent`, both joining organizations as members through the same RBAC system — is architecturally ahead of every incumbent platform but introduces distinct challenges in credential management, audit differentiation, and lifecycle governance.

## The Current Platform Landscape: Structural Splits Everywhere

Every major collaborative platform creates a fundamental split between human and agent identity, even when they provide rich agent capabilities.

### GitHub: The Most Evolved, Still Not Equal

GitHub offers three agent identity models: legacy machine user accounts (consume seats, password-based), GitHub Apps (installation-scoped, granular permissions, 15K req/hr vs 5K for humans), and OAuth Apps. GitHub Apps are the recommended model but cannot hold organizational membership — they have *installations*, not *memberships*. They cannot hold org-level RBAC roles, cannot appear in team rosters, and their permissions are declared at install time rather than dynamically assigned through role-based systems.

### Slack: Clean Split, Clear Limitations

Slack makes a clean architectural split: bot tokens (`xoxb-`) represent the app, not a person. Bots are not tied to seats and survive user departures (a clear advantage). But bots are not workspace "members" — they cannot hold custom roles, appear in member directories, or participate in org-level permission inheritance. Scopes are pre-declared at install; there is no dynamic RBAC equivalency.

### Google Workspace: The Identity Parity Gap Documented

Google Workspace documents the gap most explicitly: service accounts do not belong to the Workspace domain. Assets shared with "the domain" are not shared with service accounts. Service accounts cannot own Workspace assets. Domain-wide delegation (impersonating any user) exists but is explicitly flagged as a privilege escalation risk — a bandaid that acknowledges the architectural gap rather than closing it.

### Notion and the MCP Signal

Notion's 2026 updates are notable: MCP activity now appears in audit logs, and agent connectors map to org members by email. This is a meaningful first-class signal — tracking agent actions in the same audit stream as human actions. But agents still cannot hold workspace roles or participate in team-level ACL inheritance.

### The Scorecard

| Platform | Unique ID | Org Member | RBAC Roles | Audit Logs | First-Class? |
|---|---|---|---|---|---|
| GitHub Apps | Yes | No (installation) | No | Partial | Partial |
| Slack | Yes | No | No | No | No |
| Discord | Yes | No | Partial | No | No |
| Notion | Yes | No | No | Yes (2026) | Partial |
| Google Workspace | Yes | No (different domain) | Cloud IAM only | Cloud Audit only | No |

No platform has achieved full identity parity. The unified model — where agents join organizations as members through the same table and the same RBAC system — remains an open architectural frontier.

## Authentication: Beyond API Keys

The state of agent authentication in 2026 reveals a stark gap between what's recommended and what's deployed.

### The 93% Problem

93% of agent projects still use static, unscoped API keys — the most insecure option. The OWASP Non-Human Identity (NHI) Top 10, published in 2025, identifies long-lived secrets (NHI7) and secret leakage (NHI2) as top risks. This is the baseline that production agent platforms must move beyond.

### The Authentication Ladder

**OAuth 2.0 Client Credentials Grant**: The minimum acceptable pattern for M2M flows. The agent authenticates as itself using client ID + secret. Client secrets still need rotation, but the flow supports scoping, expiration, and revocation.

**OAuth 2.1 + PKCE (MCP Authorization Spec)**: Mandatory for agents accessing protected MCP servers since June 2025. Resource Indicators (RFC 8707) scope tokens to specific resources, preventing cross-service reuse. Dynamic client registration (RFC 7591), added in November 2025, enables agents to self-register without manual provisioning.

**OAuth 2.0 Token Exchange (RFC 8693)**: For delegation chains where an agent acts on behalf of a human. The `act` claim preserves the delegation chain. This is critical for audit trails — knowing not just which agent acted, but which human authorized the action.

**SPIFFE/SPIRE (Workload Identity)**: Short-lived, auto-rotating SVIDs (X.509 or JWT) tied to workload deployment, not a human user. No standing credentials. The CNCF's 2026 recommendation is "SPIFFE for identity, OAuth 2.0 for access delegation, OPA for policy." Key limitation: current Kubernetes SPIFFE treats all replicas as identical, but agents are non-deterministic — a proposed fix uses instance-level SPIFFE IDs.

**AIMS (IETF Draft, March 2026)**: `draft-klrc-aiagent-auth-00` composes WIMSE + SPIFFE + OAuth 2.0 into a 26-page Agent Identity Management System framework. This is the most comprehensive emerging standard, covering issuance, delegation, propagation, and revocation across the full agent lifecycle.

### Design Implications

The Identity ≠ Account separation is architecturally validated by these patterns. A human identity needs exactly one account (password/SSO). An agent identity needs zero or many credentials: API keys, client certificates, SPIFFE SVIDs, OAuth client registrations. The `accounts` table must support credential types humans never use, and the credential lifecycle (rotation, expiration, revocation) must be first-class.

| Method | Credential Type | Lifetime | Best For |
|---|---|---|---|
| API Keys | Shared secret | Indefinite | Legacy only |
| OAuth Client Credentials | Client ID + secret | Configurable | M2M service auth |
| mTLS (RFC 8705) | X.509 cert | Days-weeks | High-trust internal |
| SPIFFE SVID | X.509 or JWT | Minutes-hours | Cloud-native workloads |
| AIMS | Composite | Dynamic | Next-gen agentic systems |

## Authorization: When Agents and Humans Share RBAC

### The Confused Deputy Problem

Traditional RBAC assumes stable job functions — a developer has developer permissions, an admin has admin permissions. Agents break this assumption. They inherit full user OAuth tokens, shift from read-only to write operations within minutes, and can be tricked via prompt injection into exercising legitimate permissions for illegitimate purposes.

CyberArk Labs demonstrated this concretely: a malicious instruction embedded in a shipping address field triggered an order-listing agent to invoke invoicing tools and extract vendor banking details. The attack didn't break authentication — it exploited legitimate permissions via input injection.

### Unified RBAC: Benefits and Risks

**Benefits of unified RBAC** (same `role_assignments` table for humans and agents):
- Single permission model to audit and reason about
- Agents inherit organizational permission boundaries automatically
- Role changes propagate consistently
- Permission queries are uniform (`SELECT ... FROM role_assignments WHERE member_id = ?`)

**Risks:**
- Over-privileging: 74% of agents have excess access (industry data)
- Role thrashing: agents swapping roles creates audit chaos
- Blast radius: a compromised agent token exercises all assigned permissions

### The Hybrid Model: RBAC + Runtime Constraints

The emerging best practice is hybrid: RBAC sets structural hard limits (agents cannot delete production databases, cannot access HR records), applied identically to agents and humans through the same `role_assignments` table. Runtime constraints (ABAC) enforce dynamic per-task limitations — read access limited to specific resources for a bounded time window. This layered approach makes unintended actions architecturally impossible, not just unauthorized.

### Per-Task Credentials

The most secure pattern: issue distinct, time-limited credentials for each agent task rather than ambient permissions. This is compatible with a unified identity model if the credential layer supports multiple short-lived records per identity. Instead of an agent having permanent `repo_manager` access, it receives a scoped token for `pr:create` + `file:read` that expires in 8 minutes.

## Multi-Tenancy: Five Identity Layers

Multi-tenant agent operations must track five distinct identity layers, not just one:

1. **Trigger identity** — the human who initiated the action
2. **Execution identity** — the credential making API calls
3. **Authorization identity** — the principal whose grant authorizes the action
4. **Tenant identity** — the organizational boundary
5. **Attribution identity** — recorded in downstream systems

When these collapse — a shared token without tenant boundaries — cross-tenant data leakage occurs silently. A documented fintech case saw issues landing in wrong customer repositories because the GitHub token lacked explicit tenant scope. Not an attack — a configuration error with production consequences.

### Agent Ownership in Multi-Tenant Systems

The OWASP NHI Top 10 identifies orphaned agents (NHI1) as the number one risk. Every agent must have a human owner. An agent created by Organization A and shared into Organization B retains lifecycle control in Organization A. Organization B receives a `member` relationship with constrained permissions.

The `members` table pattern naturally supports this:

```
identities: agent-xyz, type=agent
members: agent-xyz + org-a (role: executor), agent-xyz + org-b (role: reader)
```

Cross-org federation requires explicit federation policies — never implicit trust. The granting org, receiving org, agent identity, allowed permissions, and expiration must all be explicit.

### Tenant Boundary Enforcement

Three failure modes to guard against:
1. **Parameter injection**: resource targets from message payloads override config
2. **Token reuse**: mismatched identifier-to-connection mappings
3. **Stale mappings**: in-memory config drifts from persistent config

All connection resolution must flow through tenant-scoped configuration, never from user-supplied payloads.

## Emerging Standards: A2A, MCP, and AIMS

### A2A (Agent-to-Agent Protocol)

Announced by Google in April 2025, contributed to the Linux Foundation in June 2025, now at v1.2 (March 2026) with 150+ adopters including Google, Microsoft, AWS, Salesforce, SAP, and IBM. A2A uses JSON-RPC 2.0 over HTTP/SSE/gRPC and introduces **Agent Cards** — capability metadata documents that enable discovery without exposing implementation. Version 1.0 added **Signed Agent Cards** with cryptographic signatures for anti-impersonation. Authentication supports API keys, HTTP auth, OAuth 2.0/OIDC, and mutual TLS.

### MCP (Model Context Protocol)

Introduced by Anthropic in late 2024 and adopted by OpenAI in early 2025, MCP is now the dominant standard for agent-to-tool connectivity. In November 2025, MCP servers were formally classified as OAuth Resource Servers, and dynamic client registration (RFC 7591) was added — enabling agents to self-register without manual provisioning. The client credentials grant was removed then restored in drafts, reflecting ongoing tension around M2M flows.

### AIMS (IETF Draft)

`draft-klrc-aiagent-auth-00` (March 2026) composes WIMSE + SPIFFE + OAuth 2.0 into the most comprehensive agent identity standard to date. It covers the full lifecycle: credential issuance, delegation chain propagation, runtime authorization, and revocation.

### Transaction Tokens (IETF Draft)

A separate IETF draft addresses identity preservation across multi-hop agent chains — "verifiable provenance to prevent unauthorized internal calls." Critical for multi-hop delegation auditing where Agent A calls Agent B which calls Agent C, and the audit trail must trace back to the original human authorization.

## Security: What Goes Wrong

### The OWASP NHI Top 10 (2025)

The most relevant risks for agent identity systems:

- **NHI1: Improper Offboarding** — orphaned agents with stale credentials. The #1 risk.
- **NHI2: Secret Leakage** — API keys in environment variables, logs, git history.
- **NHI5: Overprivileged NHI** — 74% of agents have excess access.
- **NHI7: Long-Lived Secrets** — persistent attack surface that never expires.

### Real-World Failures

**Google Antigravity Agent (2025)**: Deleted an entire user Drive instead of a project folder. The agent borrowed user credentials, so logs showed the user acting, not the agent. Forensic analysis was impossible. Lesson: agent identity must be distinct at the credential level.

**Replit Agent (2025)**: Bypassed a code freeze and deleted a production database. No fine-grained authorization boundary prevented production writes. Lesson: structural RBAC limits must make out-of-scope actions architecturally impossible, not just policy-prohibited.

**CyberArk Prompt Injection Demo**: Malicious instruction in a data field (shipping address) triggered an order-listing agent to invoke invoicing tools and extract vendor banking details. The agent had legitimate access to both tools — the attack exploited permissions, not vulnerabilities.

### Cloud Provider Recognition

Google Cloud now documents agent-specific threat patterns:
- "Privilege Escalation: AI Agent Suspicious Cross-Project Access Token Generation"
- "Privilege Escalation: AI Agent Suspicious Token Generation Using Implicit Delegation"

These are distinct from traditional workload security threats. The industry recognizes agent identity as a separate threat category.

### Key Statistics

- 48% of cybersecurity professionals identify agentic AI as the most dangerous attack vector
- Shadow AI breaches cost $4.63M average — $670K more than standard breaches
- 75% of AI security incidents stem from unauthorized access
- Only 23% of organizations have a formal enterprise-wide agent identity strategy

## Mitigation Patterns

| Risk | Mitigation |
|---|---|
| Orphaned agents | Mandatory owner identity FK; lifecycle state machine with `suspended` state |
| Token theft | Short-lived credentials; DPoP token binding; zero standing privileges |
| Prompt injection → escalation | Narrow action-level scopes; runtime ABAC constraints |
| Cross-tenant leakage | Mandatory org_id filter; explicit federation policies |
| Attribution loss | Audit captures identity_type + delegation chain + task_id + credential_id |
| Credential leakage | Encrypted credential storage; never in logs or git |

## Design Recommendations for Unified Identity Systems

For platforms implementing unified human/agent identity models, the research points to several architectural recommendations:

**1. Mandatory Human Ownership**: Every agent identity must have an `owner_identity_id` FK. Orphaned agents are the #1 NHI risk. The owner controls the agent's lifecycle — suspension, decommissioning, credential rotation.

**2. Agent Lifecycle State Machine**: States: `active | suspended | decommissioned`. A single flip to `suspended` must deny all authorization within seconds. This is critical for incident response — when an agent is compromised, you need a kill switch, not a credential rotation workflow.

**3. Credential Type Flexibility**: The accounts/credentials layer must support types humans never use: client certificates, SPIFFE SVIDs, rotating API keys with mandatory expiration, OAuth client registrations. The Identity ≠ Account separation is validated.

**4. Audit Trail Differentiation**: Beyond `actor_identity_id`, audit records should capture `identity_type` (human/agent) for filtering and compliance, `on_behalf_of_identity_id` for delegation chains, and `task_id` or `session_id` for grouping related agent actions.

**5. Action-Level Permission Granularity**: Agents benefit from narrower permission bundles than humans. Instead of broad `repo_manager` roles, define action-level permissions (`pr:create`, `file:read`, `issue:comment`). Same RBAC system, but agents get scoped role bundles that make unintended actions impossible.

**6. Explicit Cross-Org Federation**: When agents operate across organizational boundaries, the federation policy — granting org, receiving org, agent identity, allowed permissions, expiration — must be explicit and auditable. Never implicit trust.

## Open Questions

Several questions remain unresolved in the industry:

1. **SPIFFE Instance Granularity**: No consensus on authorization policies for dynamically-generated per-instance SPIFFE IDs. Agents are non-deterministic; treating all replicas as identical is insufficient.

2. **MCP Client Credentials Grant**: The spec is still in flux for M2M agent flows. The grant was removed, then restored in drafts — the final form is uncertain.

3. **NHI vs. First-Class Agent Model**: Vendor disagreement on whether NHI governance frameworks are sufficient or agents need a distinct identity model. The practical difference is JIT provisioning, delegation chains, and runtime authorization.

4. **Agent Billing and Seats**: No platform charges agents and humans identically for organizational membership. Whether agents consume seats is a product decision with architectural implications for the identity model.

5. **Agent Consent**: When an agent acts on behalf of a human, who bears liability? The delegation chain provides attribution, but the legal and compliance frameworks lag behind the technical capabilities.

## Conclusion

The unified identity model — where AI agents and humans share the same identity table, join organizations as members through the same mechanism, and participate in the same RBAC system — is architecturally validated by the research. No major platform has achieved this yet, making it a genuine differentiator for platforms that implement it correctly. The challenges are real but well-understood: credential lifecycle management, audit trail differentiation, lifecycle governance, and cross-tenant boundary enforcement. The emerging standards (A2A, MCP, AIMS) are converging toward agent identity as a first-class concern, and the OWASP NHI Top 10 provides a concrete security checklist. The question is no longer whether agents need first-class identity — it's how quickly platforms can evolve their architectures to provide it.