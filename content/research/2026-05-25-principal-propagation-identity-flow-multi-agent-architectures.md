---
date: "2026-05-25"
title: "Principal Propagation and Identity Flow in Multi-Agent Architectures"
description: "How user and agent identity travels through service boundaries, delegation chains, and API gateways in modern multi-agent AI platforms"
tags: ["security", "identity", "multi-agent", "authorization", "delegation", "zero-trust", "OAuth", "SPIFFE"]
---

## Executive Summary

As AI agent platforms evolve from single-agent request-response systems into multi-agent architectures where agents delegate work to sub-agents, call external APIs, and traverse service boundaries, a critical question emerges: **how does the initiating principal's identity and authority propagate through the chain?** This is the problem of principal propagation — ensuring that every service in a multi-hop workflow knows who originally authorized the action, what permissions apply, and that authority cannot silently escalate along the way.

This research examines the problem across three domains: classical microservice identity propagation (JWT forwarding, token exchange, service mesh patterns), the emerging field of agent-specific authorization propagation (Invocation-Bound Capability Tokens, the Agent Identity Protocol), and practical implementation patterns for AI agent platforms that need to maintain security without sacrificing the autonomy that makes agents useful.

## The Problem Space

### Why Classical Auth Falls Short

In a traditional web application, authentication happens at the edge (API gateway or load balancer) and backend services either trust the gateway implicitly (the "trusted subsystem" pattern) or receive a forwarded JWT. This works because the call chain is shallow and deterministic — a user hits an endpoint, the gateway validates their token, and one or two backend services fulfill the request.

Multi-agent AI systems break these assumptions in several ways:

1. **Dynamic call chains.** An agent decides at runtime which tools to call, which sub-agents to invoke, and in what order. The call graph is not known at deploy time.
2. **Delegation depth.** Agent A may delegate to Agent B, which delegates to Agent C, which calls an MCP server. The original user's authority must survive four hops without accumulating extra privileges.
3. **Aggregation inference.** An agent that queries multiple data sources may combine results in ways that reveal information none of the individual sources would have authorized on their own.
4. **Temporal validity.** A long-running agent workflow may span hours or days, during which the user's permissions may change or be revoked.

A May 2026 paper by Krti Tallam formalizes this as "authorization propagation" — a workflow-level property that is not reducible to prompt injection defense and is not fully addressed by classical RBAC, ABAC, or ReBAC models. The paper identifies three sub-problems (transitive delegation, aggregation inference, and temporal validity) and derives seven structural requirements for authorization architectures in multi-agent systems.

### The Trust Boundary Problem

Every hop in a multi-agent workflow crosses a trust boundary. Consider a Zylos-like architecture where:

- A user sends a message via Telegram
- The communication bridge routes it to the main agent
- The agent spawns a background sub-agent for research
- The sub-agent calls WebSearch, reads files, and writes results
- Results flow back through the bridge to the user

At minimum, five trust boundaries are crossed. The question at each boundary: does this caller have the authority to perform this action, and can I verify that authority traces back to a legitimate principal?

## Classical Patterns: Microservice Identity Propagation

### Pattern 1: JWT Forwarding

The simplest approach. The API gateway validates the user's token and forwards it (or a derived internal JWT) to downstream services via the `Authorization` header. Each service can independently verify the token and extract claims.

**Strengths:** Simple, stateless, well-understood. Each service can make its own authorization decisions based on user claims.

**Weaknesses:** The token carries the same authority at every hop. A compromised intermediate service can replay the token against any other service. No scope attenuation — the token is either fully valid or fully invalid.

### Pattern 2: OAuth 2.0 Token Exchange (RFC 8693)

RFC 8693 defines a protocol for exchanging one token for another at each service boundary. Two semantics are supported:

- **Impersonation:** The exchanged token represents the original user directly. The downstream service cannot distinguish it from a token the user obtained themselves.
- **Delegation:** The exchanged token includes both the original user (the `subject`) and the acting service (the `actor`). Downstream services can see the full delegation chain.

The delegation semantic is particularly relevant for agent systems. When Agent A delegates to Agent B, the exchanged token contains Agent A as the actor and the original user as the subject. Agent B can then exchange again, adding itself as the actor. The `act` claim in JWTs supports nested delegation chains.

**Strengths:** Standard protocol, supported by major identity providers. Scope can be narrowed at each exchange. Delegation chain is visible in the token.

**Weaknesses:** Requires a token exchange endpoint (online dependency). Each exchange adds latency. The authorization server becomes a bottleneck and single point of failure.

### Pattern 3: Service Mesh with SPIFFE/SPIRE

SPIFFE (Secure Production Identity Framework for Everyone) and its runtime implementation SPIRE provide workload identity without shared secrets. Instead of distributing API keys or passwords, SPIRE uses platform-specific attestation (Kubernetes pod metadata, AWS instance identity documents, Unix process attributes) to verify workload identity and issue short-lived X.509 certificates (SVIDs).

In a service mesh like Istio, Envoy sidecar proxies handle mTLS between services. Each service gets a SPIFFE ID (e.g., `spiffe://cluster.local/ns/agents/sa/research-agent`), and authorization policies can reference these IDs directly.

For principal propagation, Istio concatenates the JWT's `iss` and `sub` fields to form the request principal, which is then available to authorization policies at every hop.

**Strengths:** Zero-trust by default. Identity is cryptographic, not bearer-token-based. Short-lived certificates limit blast radius of compromise. Works at the infrastructure layer — no application code changes needed.

**Weaknesses:** Significant operational complexity. SPIFFE IDs represent workloads, not end users — user identity still needs to be propagated separately (typically via JWT in headers). Not designed for dynamic delegation chains.

### Pattern 4: The Trusted Subsystem

The API gateway authenticates the user, then backend services communicate using service accounts with elevated privileges. User identity may be forwarded in a custom header but is not cryptographically verified downstream.

**Strengths:** Simple. No token exchange overhead.

**Weaknesses:** Backend services operate with super-user privileges. No end-to-end audit trail. A compromised backend service has access to everything. This pattern is explicitly discouraged by OWASP for microservice architectures.

## Agent-Specific Patterns: Authorization Propagation

### Invocation-Bound Capability Tokens (IBCTs)

The most promising pattern for multi-agent systems fuses identity, attenuated authorization, and provenance binding into a single token chain. Two modes:

- **Compact mode (single hop):** Standard JWT with Ed25519 signatures. The token contains the user's identity, the agent's identity, the authorized capabilities, and a budget constraint.
- **Chained mode (multi-hop):** Biscuit tokens with append-only blocks and Datalog policy evaluation. Each delegation adds a block that can only narrow permissions, never widen them.

The Biscuit token structure for a delegation chain looks like:

- **Block 0 (Authority):** Root identity, initial capabilities, budget, max delegation depth, expiration.
- **Block 1 (First delegation):** Delegator identity, delegate identity, attenuated capabilities (expressed as Biscuit `right` facts), attenuated budget, context.
- **Block N (Nth delegation):** Same structure, further attenuated.

The critical property is **monotonic attenuation** — each block can only add restrictions, never remove them. A sub-agent cannot grant itself more authority than its parent had. This is enforced cryptographically: each block is signed by the delegator, and the Datalog evaluation engine rejects any block that would expand the authority set.

### The Agent Identity Protocol (AIP)

Published as an IETF draft in March 2026, AIP builds on IBCTs to provide a complete identity and delegation framework for AI agent systems. Key features:

- **Verifiable delegation across MCP and A2A protocols.** AIP tokens can be attached to MCP tool calls and A2A task messages, providing end-to-end identity verification.
- **Performance:** In real deployments, AIP adds 0.22ms overhead for single-hop MCP calls and 2.35ms for multi-agent workflows with LLM inference — 0.086% of total latency. Identity verification is not a bottleneck.
- **Budget propagation:** Each delegation can include a token/cost budget that attenuates through the chain, preventing runaway spending by sub-agents.

### Human Delegation Provenance (HDP)

A complementary protocol focused specifically on maintaining cryptographic proof that a human authorized the action. HDP tokens embed the human's authorization context and can be verified at any point in the chain without contacting an authorization server.

### Okta's Cross App Access (XAA)

Okta's production implementation embeds both user identity and agent identity into every token exchange, with scope narrowing at each delegation hop. Their approach uses ID-JAG (Identity JWT for Agent Governance) tokens that maintain the chain of custody through multi-agent workflows.

Key insight from Okta's research: 97% of non-human identities carry excessive privileges. Without explicit scope attenuation at each delegation hop, privilege escalation is the default, not the exception.

## Seven Structural Requirements

Drawing from the Tallam paper and practical implementations, authorization architectures for multi-agent systems must satisfy:

1. **Continuous evaluation.** Authorization state must be evaluated at every interaction boundary, not checked periodically or applied as middleware. This is analogous to encryption in transit — you cannot have "mostly encrypted" communication.

2. **Monotonic attenuation.** Authority must decrease or stay constant through delegation chains, never increase. This must be cryptographically enforced, not policy-enforced.

3. **Provenance binding.** Every action must be traceable to the originating principal through an unforgeable chain of delegation evidence.

4. **Temporal validity.** Tokens must have bounded lifetimes, and revocation must propagate to all active delegation chains within a bounded time.

5. **Aggregation control.** The system must prevent agents from combining authorized partial results into unauthorized composite outputs.

6. **Delegation depth limits.** Maximum delegation chain length must be specified at token issuance and enforced cryptographically.

7. **Offline verification.** Token verification must work without contacting a central authorization server, enabling operation in disconnected or high-latency environments.

## Practical Implementation for Agent Platforms

### Lightweight Approach: JWT + Scope Headers

For platforms that do not need multi-hop delegation (e.g., a single agent calling tools directly), a pragmatic approach:

1. User authenticates at the communication layer (Telegram bot token, web session).
2. The gateway issues an internal JWT with the user's identity and authorized scopes.
3. The JWT is forwarded to the agent runtime in a request header.
4. When the agent calls tools, the JWT (or a derived scoped token) is passed along.
5. Tools verify the JWT and check scopes before executing.

This is Pattern 1 (JWT forwarding) with explicit scope claims. It works for shallow call chains but does not protect against token replay or privilege escalation in deeper chains.

### Medium Approach: Token Exchange at Delegation Boundaries

For platforms with sub-agent delegation:

1. When Agent A spawns Agent B, it exchanges its token for a new one scoped to Agent B's task.
2. The exchanged token contains the `act` claim identifying Agent A as the actor.
3. Agent B can only exercise the scoped permissions, not Agent A's full authority.
4. Each exchange is logged for audit.

This requires a token exchange endpoint (can be a lightweight service using RFC 8693 semantics) but provides real attenuation and an audit trail.

### Full Approach: Biscuit Tokens with Datalog Policies

For platforms requiring cryptographic guarantees:

1. The root authority issues a Biscuit token with the user's capabilities.
2. Each delegation appends a block with Datalog facts that attenuate the authority.
3. Verification is offline — any service with the root public key can verify the entire chain.
4. Budget constraints propagate through the chain, preventing cost overruns.

This is the approach taken by AIP and is the most robust, but requires Biscuit library integration (available in Rust, Go, Java, TypeScript, and Python).

### Mapping to Zylos-Like Architecture

In a Zylos-style agent platform with a communication bridge, scheduler, and component system:

| Boundary | Propagation Pattern |
|----------|-------------------|
| User to Comm Bridge | Platform-native auth (Telegram bot token, web session) |
| Comm Bridge to Agent | Internal JWT with user identity and channel context |
| Agent to Sub-Agent | Token exchange with scope attenuation |
| Agent to MCP Server | Scoped token with tool-specific permissions |
| Agent to External API | OAuth 2.0 with user-delegated scopes |
| Scheduler to Agent | Service identity (no user principal — scheduled tasks act under their own authority) |

The scheduler case is interesting: scheduled tasks have no originating user principal. They act under a service identity with pre-configured permissions. This is a valid use of the trusted subsystem pattern — the scheduler's authority is bounded by its configuration, not by a user's token.

## Open Challenges

### The Aggregation Problem

Even with perfect principal propagation, an agent that can query multiple authorized data sources may synthesize results that reveal information none of the sources would individually authorize. For example, an agent authorized to read employee names from HR and salary bands from Finance could combine them to reveal individual salaries.

Current solutions rely on data classification and output filtering, but no general-purpose solution exists. This is an active research area with connections to differential privacy and secure multi-party computation.

### Long-Running Sessions

Agent sessions that span hours or days challenge token lifetime assumptions. Short-lived tokens require frequent refresh (adding latency and a dependency on the token issuer), while long-lived tokens increase the window of vulnerability if compromised.

Sliding window approaches (tokens that extend their lifetime on each use) offer a middle ground, but require careful implementation to prevent indefinite extension.

### Human-in-the-Loop Revocation

When a user revokes authorization mid-workflow, how quickly does that revocation reach all active sub-agents? In a deep delegation chain, the revocation signal must traverse every hop. Current approaches use either push notification (fast but requires persistent connections) or short token lifetimes (eventually consistent but adds overhead).

## Conclusion

Principal propagation in multi-agent architectures is not merely an extension of microservice authentication — it is a fundamentally different problem that requires new abstractions. The convergence of Biscuit-based capability tokens, the Agent Identity Protocol (AIP), and OAuth 2.0 token exchange (RFC 8693) provides a practical toolkit for building systems where authority attenuates through delegation chains, every action is traceable to an originating principal, and privilege escalation is structurally impossible.

For agent platform builders, the key design decision is the tradeoff between implementation complexity and security guarantees. JWT forwarding works for simple architectures; token exchange adds delegation awareness; Biscuit tokens provide cryptographic monotonic attenuation. The right choice depends on delegation depth, threat model, and operational maturity — but the direction is clear: agent identity and authorization propagation are becoming first-class infrastructure concerns, not afterthoughts.
