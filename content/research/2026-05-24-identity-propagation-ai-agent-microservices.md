---
date: "2026-05-24"
title: "Identity Propagation Patterns in AI Agent Microservice Platforms"
description: "A technical comparison of five identity propagation patterns for microservice architectures — from JWT passthrough to serialized proto principals — with AI agent-specific considerations and a decision framework."
tags:
  - research
  - security
  - microservices
  - identity
  - ai-agents
  - grpc
  - zero-trust
---

## Executive Summary

When a request enters an AI agent platform through an API gateway, it carries a verified identity — a human user, an agent, or a service. The central challenge is how that identity travels through a chain of microservices without re-authenticating at every hop. Five distinct patterns exist, each representing a different point on the trust-vs-complexity spectrum: JWT passthrough (cheapest, tightest coupling), internal JWT minting (edge-terminated trust), opaque token introspection (real-time revocation at the cost of latency), serialized proto principal (maximum performance, network-trust model), and mesh-level SPIFFE/mTLS identity (zero-trust cryptographic workload identity). For AI agent platforms specifically, the challenge is compounded by multiple principal kinds — Human, Agent, Service — and delegation chains where an agent acts on behalf of a human across long-running, multi-hop sessions. The serialized proto principal pattern (used by Netflix's Passport, and implemented in cws-core) offers the best latency profile for intra-cluster traffic and fits the "verify once at the edge, trust inside the mesh" model that dominates production-scale platforms.

## The Problem: Identity Across Service Boundaries

In a monolith, authentication is straightforward: one process, one session store. In a microservice architecture, a single user-facing request may fan out to a dozen internal services. Each service needs to know *who* is calling — not just that a valid network request arrived, but the identity of the originating principal and any delegation context.

The naive solution — re-authenticate at every service boundary using the original credential — is untenable. External tokens (OAuth2 access tokens, OIDC JWTs) are issued by an external Identity Provider (IdP), and verifying them requires either calling the IdP or fetching its public keys. For a request that hits 8 services in sequence, this means 8 JWKS fetches or 8 introspection calls. Under load, this becomes the dominant cost of the request.

The real design question is: **where does verification happen, and what travels beyond that boundary?**

### The Trust Boundary Model

Every propagation pattern makes an implicit or explicit choice about trust boundaries:

- **Re-verify at every hop**: Defense-in-depth, but expensive
- **Verify at edge, trust the internal network**: Fast, but relies on network isolation
- **Verify at edge, re-sign an internal token**: Decouples external/internal auth, moderate cost
- **Verify via mesh cryptographic identity**: Zero-trust, but infrastructure-heavy

These choices have compounding implications for latency, revocation, key management, and audit.

## Pattern 1: JWT Passthrough

The simplest approach: the API gateway or BFF forwards the original external JWT downstream. Each service independently verifies the JWT signature using the IdP's public key (fetched from JWKS endpoint and cached).

### How It Works

```
Client → [BFF: validates JWT] → Service A (validates JWT) → Service B (validates JWT)
         Authorization: Bearer <external-jwt>           ↑ same token forwarded
```

### Pros

- Zero additional infrastructure
- True end-to-end cryptographic verification — every service independently validates the token's authenticity
- Standard library support (every language has a JWT library)
- Transparent: logs show the same principal all the way through

### Cons

- Every service needs access to the IdP's JWKS endpoint (or must cache keys and handle rotation)
- Tight coupling to the external auth protocol — internal services must understand OAuth2/OIDC semantics
- No enrichment: the JWT contains only what the IdP issued. Internal roles, service-specific claims, and workspace membership must be fetched separately by each service
- Short-lived JWTs require frequent rotation, which propagates token refresh complexity throughout the stack
- The external JWT may contain PII or scopes that internal services have no business seeing

### When to Use

Appropriate for small systems (2-4 services), or when you genuinely need each service to independently verify the caller hasn't been revoked. Common in early-stage products where operational simplicity outweighs architectural purity.

## Pattern 2: Internal JWT Minting

The BFF or API gateway terminates the external JWT, verifies it once, and then mints a new *internal* JWT with a different signing key, possibly enriched claims, and a short TTL. Downstream services verify the internal JWT against the BFF's signing key.

### How It Works

```
Client → [BFF: validates external JWT, mints internal JWT] → Service A (validates internal JWT)
         Authorization: Bearer <external-jwt>                    X-Internal-Token: <internal-jwt>
```

This is the approach described in the OWASP Microservice Security Cheat Sheet as "Protocol-Agnostic Identity Propagation." Uber's Security Token Service (STS) also follows this model, minting a new short-lived JWT at each service hop with a single `aud` claim and an actor chain recording the full delegation lineage.

### Pros

- Clean separation between external and internal auth domains
- Enriched claims eliminate per-service lookups for common attributes (org, workspace, roles)
- Short TTL limits blast radius of a leaked internal token
- Audience-scoped tokens prevent token reuse across unintended service boundaries
- Full actor chain provides end-to-end auditability for delegation scenarios

### Cons

- The BFF must implement JWT signing (private key management, rotation)
- Each downstream service still performs JWT signature verification (CPU overhead)
- JWKS distribution: all internal services must know the BFF's public key
- Adds a signing/verification round-trip that wasn't there before

### When to Use

The right default for medium-to-large systems that need enriched claims, clean internal/external separation, and full auditability. The main cost is JWT signing infrastructure and per-hop verification CPU.

## Pattern 3: Opaque Token + Central Auth Service

Instead of a self-contained JWT, the token is a random opaque string (like a session ID). Downstream services call a central Auth Service (implementing OAuth2 Token Introspection, RFC 7662) to validate it and retrieve associated claims.

### How It Works

```
Client → [BFF: validates, issues opaque token] → Service A
                                                     ↓ POST /introspect token=<opaque>
                                               [Auth Service] → { active: true, sub: ..., ... }
```

### Pros

- **Real-time revocation**: When a user is revoked, the change is reflected immediately on the next introspection call
- No token forgery risk: opaque tokens cannot be decoded or fabricated without the auth server
- Simple token issuance: no signing infrastructure required at the issuer
- Token size is minimal (a random 32-byte ID vs a 500-byte JWT)

### Cons

- **Latency**: Every service call requires a network round-trip to the Auth Service. At 20-50ms per introspection, a 5-service chain adds 100-250ms of pure auth overhead
- **Single point of failure**: If the Auth Service is unavailable, no service can authenticate any request
- **Scalability bottleneck**: High-throughput systems generate enormous introspection load

### When to Use

Use when real-time revocation is a hard requirement — financial services, compliance-heavy applications, or AI agent platforms where an agent's authorization can be revoked mid-session and you need that to take effect immediately.

## Pattern 4: Serialized Principal (Proto Binary)

The most performant pattern for intra-cluster gRPC traffic: the BFF verifies the external JWT once, constructs a strongly-typed `Principal` object, serializes it as protobuf binary, and passes it as a gRPC metadata header. Downstream services deserialize the principal without re-verification. Trust is enforced entirely by network isolation (Kubernetes NetworkPolicy + Istio mTLS).

This is the pattern used by Netflix's Passport and implemented in cws-core (COCO Workspace).

### How It Works

```
Client → [BFF: validates JWT, builds Principal proto]
               ↓ gRPC header: x-principal-bin: <base64 protobuf bytes>
         Service A (deserializes Principal, uses directly)
               ↓ gRPC header: x-principal-bin: <same bytes>
         Service B (deserializes Principal, uses directly)
```

No signature verification occurs downstream. The binary blob is trusted because it arrived over an mTLS-authenticated gRPC channel from within the cluster.

### Go: Client Interceptor (ConnectRPC)

```go
func PrincipalPropagationInterceptor() connect.UnaryInterceptorFunc {
    return func(next connect.UnaryFunc) connect.UnaryFunc {
        return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
            if req.Spec().IsClient {
                principal, ok := PrincipalFromContext(ctx)
                if ok && principal != nil {
                    data, _ := proto.Marshal(principal)
                    req.Header().Set("X-Principal-Bin",
                        base64.StdEncoding.EncodeToString(data))
                }
                if rid := observability.RequestID(ctx); rid != "" {
                    req.Header().Set("X-Request-Id", rid)
                }
                observability.WriteTraceContext(ctx, req.Header())
            }
            return next(ctx, req)
        }
    }
}
```

### Trust Model

This pattern requires two infrastructure prerequisites:

1. **Kubernetes NetworkPolicy**: Services in the cluster cannot be reached from outside the pod network without going through the API gateway
2. **Istio mTLS (STRICT mode)**: All service-to-service communication is mutually authenticated at the transport layer

### Real-World: Netflix Passport

Netflix's Passport, described in their "Edge Authentication and Token-Agnostic Identity Propagation" post, follows the same conceptual model. Passport is created at the edge (Zuul), scoped to the lifetime of that request, completely internal, and binary-serialized in headers. Netflix adds one element the pure network-trust model skips: Passport is cryptographically signed by an internal Passport Service, creating a hybrid between Pattern 4 and Pattern 2.

### Pros

- **Lowest latency**: Zero network calls for auth on downstream hops. Deserialization of a small protobuf is microseconds
- **Strongly typed**: No string parsing — structured access via generated code
- **No key distribution**: Downstream services need no signing keys or JWKS endpoints
- **Rich principal model**: Supports delegation chains, multiple principal kinds, and arbitrary enrichment

### Cons

- **Network trust dependency**: Security guarantee comes entirely from Istio mTLS + NetworkPolicy
- **No revocation in-flight**: If a principal is revoked after the BFF minted the principal object, that revocation won't be seen until the next request
- **Not suitable across trust boundaries**: Never propagate a serialized principal to an external service

### When to Use

The default choice for high-throughput intra-cluster gRPC traffic in a well-maintained Kubernetes environment with Istio in STRICT mTLS mode. The latency advantage compounds significantly in chains of 5+ services.

## Pattern 5: Mesh-Level Identity (SPIFFE/mTLS)

Rather than propagating application-level identity through headers, the service mesh itself provides cryptographic workload identity. Each service receives a SPIFFE Verifiable Identity Document (SVID) — an X.509 certificate with a URI SAN like `spiffe://cluster.local/ns/prod/sa/agent-service`.

### Key Insight

SPIFFE tells you *which service* is calling, not *which user* initiated the request. It does not solve the human/agent identity propagation problem — you still need one of Patterns 1-4 for end-user context. SPIFFE is an infrastructure layer that makes Pattern 4 safe.

### When to Use

Use as the trust enforcement mechanism combined with another pattern for principal context. In a mature Kubernetes deployment, Istio with STRICT mTLS effectively delivers SPIFFE-based workload identity without separately operating SPIRE.

## AI Agent-Specific Considerations

### Multiple Principal Kinds

A production AI agent platform has at least three principal kinds:

| Kind | Example | Trust Characteristics |
|---|---|---|
| Human | `hm-{uuid}` | Authenticated via OIDC/OAuth2, high trust, revocable |
| Agent | `am-{uuid}` | Authenticated via API key + runtime attestation, scoped authorization |
| Service | `svc-{slug}` | Workload identity (SPIFFE), internal only |

These kinds must be distinguishable in the principal object. A service that processes payments should refuse requests where `kind = AGENT` unless explicitly authorized.

### Agent Delegation Chains

When an agent acts on behalf of a human, the identity must carry both the original human principal and the acting agent. Without this, audit logs show only the agent, and the human's intent is invisible.

The critical security property: **delegation does not amplify privilege**. The acting agent inherits at most the permissions of its delegator.

### Long-Running Sessions

Human web requests have a natural TTL. Agent sessions are different — a background agent may run for hours. The solution: issue a long-lived agent credential at delegation time, and have the agent re-authenticate through the BFF for each sub-request to receive a fresh principal.

### Trace Correlation

In gRPC metadata, principal and trace context travel as separate headers:

```
x-principal-bin: <protobuf bytes>
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
x-request-id: req_01H...
```

Combining `x-request-id` with the deserialized principal in structured logs gives per-request audit trails.

## Pattern Comparison

| Pattern | Verification | Latency/hop | Revocation | Trust Model |
|---|---|---|---|---|
| JWT Passthrough | Each service | Medium | On JWT expiry | Network + Crypto |
| Internal JWT Minting | Each service | Medium | On JWT expiry | Crypto |
| Opaque Token | Central auth | High | Real-time | Central authority |
| Serialized Proto | BFF only | Minimal | On next BFF request | Network isolation |
| SPIFFE/mTLS | Mesh layer | Minimal | On cert expiry | Crypto (workload) |

## Decision Framework

For AI agent platforms, the recommended architecture is a **layered hybrid**:

1. **SPIFFE/Istio mTLS** (Pattern 5) for workload-to-workload authentication
2. **Serialized Proto Principal** (Pattern 4) for intra-cluster principal propagation
3. **Internal JWT or API Key** (Pattern 2) at the BFF for agent long-session credential exchange
4. **Delegation chains** in the proto model for full human-to-agent lineage

This combination gives: minimal per-hop latency, strong audit trails, multi-kind principal support, and the network-trust foundation to make the proto passthrough safe.

## Summary

Identity propagation in microservice platforms is ultimately about choosing a trust anchor and deciding how far that trust reaches before re-verification is required. JWT passthrough puts the trust anchor everywhere. Serialized proto principal puts it at the edge — and then relies on Kubernetes and Istio to keep the interior safe. For AI agent platforms with Human/Agent/Service principal kinds, multi-hop delegation chains, and long-running sessions, the serialized proto principal pattern gives the best engineering trade-off: a rich, typed identity structure, near-zero per-hop cost, and full delegation auditability — as long as the operator commits to the mTLS and NetworkPolicy discipline that makes it safe.

*Sources: OWASP Microservice Security Cheat Sheet (2025), Netflix Tech Blog — Edge Authentication and Token-Agnostic Identity Propagation, Uber Engineering — Solving the Agent Identity Crisis, Google Cloud — Application Layer Transport Security, SPIFFE Workload API specification, gRPC Metadata Guide.*
