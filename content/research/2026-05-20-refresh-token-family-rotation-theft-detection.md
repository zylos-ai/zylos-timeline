---
date: "2026-05-20"
title: "Refresh Token Family Rotation and Theft Detection in Agent-Native Authentication"
description: "Deep dive into refresh token rotation using token families for theft detection, with specific patterns for hybrid human-agent authentication systems"
tags:
  - security
  - authentication
  - token-rotation
  - refresh-tokens
  - agent-authentication
  - multi-tenant
---

## Executive Summary

Refresh token rotation is one of the most effective mechanisms for detecting credential theft in OAuth 2.0 systems. The core insight is simple: if a refresh token can only be used once and a new one is issued on each exchange, then any attempt to replay a used token is an unambiguous signal of compromise. When paired with token family tracking — grouping all tokens that descend from a single initial grant — the system can revoke the entire lineage the moment a reuse event is detected, cutting off both the legitimate and attacker sessions simultaneously.

The pattern was formalized in IETF RFC 6819 (OAuth 2.0 Threat Model and Security Considerations) and has since been operationalized by major identity providers including Auth0, Okta, and Duende IdentityServer. The core algorithm is well understood, but real-world deployments quickly encounter edge cases: concurrent requests from multiple browser tabs, network failures that prevent a client from receiving a newly issued token, and agent runtimes that hold sessions across days without any human re-authentication event to anchor revocation.

AI agent platforms introduce a distinct class of challenges that the traditional browser-session mental model does not address. Agents hold long-lived credentials, may run hundreds of API calls per day, operate across distributed worker processes, and intermix with human browser sessions in the same tenant. The threat surface is different — prompt injection can exfiltrate tokens that a human user would never expose, and a compromised agent can silently drain a refresh token family before any anomaly detection fires. Designing authentication systems for these platforms requires rethinking not just the token rotation algorithm, but the entire credential lifecycle, from issuance through storage to revocation signaling.

This article examines the full stack: the rotation protocol itself, family-based theft detection, grace window design for concurrent clients, implementation data models, comparisons with alternative approaches, lessons from production deployments at Auth0 and Okta, and the specific patterns that agent-native platforms need to adopt to harden their authentication posture.

## The Refresh Token Rotation Pattern

### Why Refresh Tokens Exist

OAuth 2.0 access tokens are intentionally short-lived — typically 15 minutes to one hour. This limits the damage window if an access token is intercepted in transit or leaked through a log file. When the access token expires, the client needs a way to obtain a new one without sending the user back through the authorization code flow. Refresh tokens solve this: they are long-lived credentials presented only to the authorization server's token endpoint, never to resource servers, which exchange them for fresh access tokens.

The asymmetry is intentional. Access tokens travel over the network constantly, appearing in API request headers. Refresh tokens should travel once per expiry cycle, only to a single trusted endpoint, over TLS. This narrower exposure justifies their longer lifetime.

### The Problem with Static Refresh Tokens

A static refresh token — one that never changes — is a skeleton key. If it is compromised through any of the many vectors available (log file leakage, browser extension exfiltration, process memory dump, SSRF attack against a credential store), the attacker has persistent access until an administrator explicitly revokes the token. The legitimate user may be completely unaware, continuing to use their own copy of the same static token without any indication that a parallel session is active.

This is the fundamental gap RFC 6819 identifies in Section 4.2.2 (Obtaining Refresh Tokens): "An attacker may obtain refresh tokens by eavesdropping on all network communication or by compromising a client's storage." The countermeasures the RFC proposes include automatic rotation — replacing the refresh token on every use.

### How Rotation Works

With rotation enabled, the token endpoint does the following on every `/token` request with `grant_type=refresh_token`:

1. Validates the incoming refresh token (not expired, not revoked, bound to the correct client)
2. Issues a new access token
3. Issues a **new refresh token** with a different value
4. Immediately marks the old refresh token as **consumed** (not deleted — the record is retained for reuse detection)
5. Returns both new tokens to the client

The client must store and use the new refresh token for all subsequent exchanges. The old value is now permanently invalid under normal operation.

```
Client                          Authorization Server
  |                                      |
  |-- POST /token ---------------------->|
  |   grant_type=refresh_token           |
  |   refresh_token=RT_v1                |
  |                                      |
  |                              Validate RT_v1
  |                              Issue AT_v2, RT_v2
  |                              Mark RT_v1 consumed
  |                                      |
  |<-- {access_token: AT_v2, -----------|
  |     refresh_token: RT_v2}           |
  |                                      |
  |   (Client stores RT_v2)              |
```

If an attacker later presents RT_v1 (which they captured before the legitimate client used it), the server sees a consumed token and knows a reuse event has occurred.

## Token Families — Lineage-Based Theft Detection

### The Family Concept

A token family is the complete lineage of refresh tokens that descend from a single authorization grant. When a user authenticates and an initial refresh token RT_0 is issued, that token is the root of a family. RT_0 is exchanged for RT_1, RT_1 for RT_2, and so on. All of these tokens share a `family_id` — a stable identifier that persists across the entire chain regardless of how many rotations occur.

The family model is what makes theft detection actionable. Without it, reuse of a consumed token is a local anomaly: "this one token was replayed." With it, the server knows: "this family is compromised — every token that has ever been or will be issued from this grant must be treated as suspect." The response is to revoke the entire family immediately and force re-authentication.

Auth0's implementation makes this explicit in their log schema, which exposes a `data.details.familyId` field on token events. When a `ferrt` (failed exchange — reuse detected) event fires, querying all tokens in that `familyId` gives the complete blast radius.

### Data Model

A minimal relational schema for family tracking:

```sql
CREATE TABLE refresh_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     UUID NOT NULL,          -- shared across the entire lineage
  token_hash    TEXT NOT NULL UNIQUE,   -- SHA-256 of the raw token value
  generation    INTEGER NOT NULL,       -- 0 for root, increments with each rotation
  status        TEXT NOT NULL           -- 'active' | 'consumed' | 'revoked'
    CHECK (status IN ('active', 'consumed', 'revoked')),
  user_id       UUID NOT NULL,
  client_id     TEXT NOT NULL,
  scope         TEXT,
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,           -- set when status transitions to 'consumed'
  parent_id     UUID REFERENCES refresh_tokens(id),  -- points to the token this replaced
  initial_ip    INET,
  last_ip       INET,
  initial_ua    TEXT,
  last_ua       TEXT
);

CREATE INDEX idx_rt_family    ON refresh_tokens(family_id);
CREATE INDEX idx_rt_user      ON refresh_tokens(user_id, status);
CREATE INDEX idx_rt_hash      ON refresh_tokens(token_hash);
```

The `generation` counter makes forensic analysis straightforward: after an incident, you can reconstruct the full token chain in order and identify exactly when the lineage diverged between the legitimate client and an attacker.

### Reuse Detection Algorithm

```python
def exchange_refresh_token(raw_token: str, client_id: str) -> TokenPair:
    token_hash = sha256(raw_token)
    
    with db.transaction(isolation="serializable"):
        token = db.query_one(
            "SELECT * FROM refresh_tokens WHERE token_hash = %s FOR UPDATE",
            [token_hash]
        )
        
        if token is None:
            raise InvalidTokenError("Unknown token")
        
        if token.client_id != client_id:
            raise InvalidTokenError("Client mismatch")
        
        if token.expires_at < now():
            raise InvalidTokenError("Token expired")
        
        if token.status == "revoked":
            raise InvalidTokenError("Token revoked")
        
        if token.status == "consumed":
            # Reuse detected — revoke entire family
            db.execute(
                "UPDATE refresh_tokens SET status = 'revoked' "
                "WHERE family_id = %s AND status IN ('active', 'consumed')",
                [token.family_id]
            )
            emit_security_event("refresh_token_reuse", {
                "family_id": token.family_id,
                "generation": token.generation,
                "user_id": token.user_id,
            })
            raise TokenFamilyCompromisedError("Reuse detected — family revoked")
        
        # Happy path: token is active
        new_raw_token = generate_secure_token()
        new_token = RefreshToken(
            family_id   = token.family_id,
            token_hash  = sha256(new_raw_token),
            generation  = token.generation + 1,
            status      = "active",
            user_id     = token.user_id,
            client_id   = client_id,
            parent_id   = token.id,
            expires_at  = now() + REFRESH_TOKEN_TTL,
        )
        
        token.status      = "consumed"
        token.consumed_at = now()
        
        db.save(token)
        db.save(new_token)
        
        access_token = issue_access_token(token.user_id, token.scope)
        
        return TokenPair(access_token=access_token, refresh_token=new_raw_token)
```

The `serializable` isolation level is critical: it prevents two concurrent requests with the same refresh token from both passing the `status == 'active'` check before either has marked the token consumed. Without this, a race window exists where both callers succeed and the token family produces two live branches simultaneously.

## Multi-Tab and Multi-Device Grace Windows

### The False Positive Problem

Strict single-use rotation creates a practical problem in browser environments: multiple tabs open to the same application will each independently detect an expired access token and simultaneously fire a refresh request. If Tab A's request arrives first, it consumes RT_n and receives RT_{n+1}. Tab B's request arrives milliseconds later with RT_n — which is now consumed. Strict reuse detection would revoke the entire family, logging the user out of a legitimate session.

The same failure mode occurs with network delivery failures: the server issues a new token pair and marks the old token consumed, but a transient network error prevents the client from receiving the response. The client retries with the same refresh token and hits a consumed-token rejection.

### Grace Window Design

The solution is a configurable grace window during which a consumed token may still be exchanged, returning the same replacement token rather than triggering family revocation. This makes a single rotation event effectively idempotent for a short window.

Industry defaults:
- **Auth0**: configurable "Rotation Overlap Period" in seconds; the overlap window is the key concept but specific defaults vary by SDK version
- **Okta**: 30-second default grace period, configurable 0–60 seconds via `leeway` in `settings.oauthClient`
- **FusionAuth**: configurable grace period per application

The algorithm modification:

```python
GRACE_PERIOD_SECONDS = 30

if token.status == "consumed":
    # Check if within grace window
    if token.consumed_at and (now() - token.consumed_at).seconds <= GRACE_PERIOD_SECONDS:
        # Return the replacement token rather than revoking
        successor = db.query_one(
            "SELECT * FROM refresh_tokens WHERE parent_id = %s",
            [token.id]
        )
        if successor and successor.status == "active":
            access_token = issue_access_token(token.user_id, token.scope)
            return TokenPair(
                access_token  = access_token,
                refresh_token = raw_successor_token(successor)  # same RT for the client
            )
    
    # Outside grace window — genuine reuse, revoke family
    revoke_family(token.family_id)
    raise TokenFamilyCompromisedError("Reuse outside grace window")
```

A critical constraint noted by Mihai Andrei's implementation analysis: **only the immediate predecessor token benefits from the grace window**. If the second-to-last token is presented (not the most recently consumed one), that is an unambiguous replay attack and should immediately trigger family revocation regardless of timing. The grace window applies only to the most recently consumed token.

### Client-Side Coordination

An alternative or complementary approach is request deduplication at the client. A shared token refresh manager (singleton in the browser, or a dedicated refresh service in server-side apps) serializes all refresh calls. If a refresh is already in flight, subsequent callers wait for the existing promise rather than firing their own request.

```typescript
class TokenRefreshManager {
  private inflightRefresh: Promise<TokenPair> | null = null;

  async refreshIfNeeded(currentToken: string): Promise<TokenPair> {
    if (this.inflightRefresh) {
      return this.inflightRefresh;
    }
    this.inflightRefresh = this.doRefresh(currentToken).finally(() => {
      this.inflightRefresh = null;
    });
    return this.inflightRefresh;
  }

  private async doRefresh(token: string): Promise<TokenPair> {
    // actual token exchange
  }
}
```

Client-side coordination alone is insufficient for distributed agent environments where multiple worker processes cannot share in-memory state. In those cases, a distributed lock (Redis SETNX, PostgreSQL advisory lock) must guard the token exchange for a given family.

## Comparison with Alternative Approaches

### Sliding Window Expiry

A sliding window refreshes the token's lifetime on each use, so the token expires only after a period of inactivity rather than at a fixed wall-clock time. This is simpler to implement than full rotation but provides no theft detection: both the legitimate client and an attacker can use the token indefinitely as long as neither stops for long enough to let it expire. Auth0 and Okta both implement inactivity-based expiry as a complement to rotation, not as a substitute for it.

### Absolute Expiry (No Rotation)

Fixed-lifetime refresh tokens expire at a predetermined time regardless of usage. They are simple and predictable, but offer no revocation capability in the absence of a server-side record. If the token is compromised on day 1 of a 90-day lifetime, the attacker has 89 days of access. This approach is sometimes used for machine-to-machine credentials where the refresh cadence is predictable and the risk profile is lower.

### Opaque Reference Tokens

Opaque tokens are random identifiers that carry no claims of their own — all session data lives server-side and is retrieved via a token introspection endpoint (`POST /introspect`). This gives the authorization server instant, complete revocation control: deleting the server-side record immediately invalidates the token everywhere. The tradeoff is that every API call requires a network round-trip to the introspection endpoint rather than local JWT signature verification.

The hybrid pattern used by most production systems: access tokens are JWTs (locally verifiable, no introspection call on the hot path) and refresh tokens are opaque (server-side record, immediate revocability). This gives speed on the access path and control on the revocation path.

```
Access Token:  JWT (verifiable by resource server without network call)
              Expires in 15-60 minutes
              Stolen token remains valid until expiry

Refresh Token: Opaque random string → server record
              Single-use with rotation
              Stolen token detectable on next use
```

### Token Binding (DPoP)

Demonstrating Proof of Possession (DPoP, RFC 9449) cryptographically binds tokens to a specific key pair held by the client. A token stolen without the private key is useless. This is the strongest theft-prevention mechanism but requires client-side key management, adds latency for proof generation and verification, and is not yet widely supported across all client environments. For agent runtimes where key management infrastructure is available, DPoP is worth evaluating as a complement to rotation.

## Real-World Implementations and Lessons

### Auth0

Auth0's refresh token rotation is configurable per-application in the dashboard. Key behaviors:
- Every exchange returns a new refresh token; the previous one is immediately marked consumed
- Token families are tracked server-side with a stable `familyId`
- Reuse events fire a `ferrt` log event that can be streamed to SIEM systems
- Post-Login Actions can inspect `event.refresh_token.device` fields (`initial_ip`, `last_ip`, `initial_user_agent`, `last_user_agent`) to detect geographic or device anomalies within a family
- The `api.refreshToken.revoke()` and `api.session.revoke()` Action APIs allow custom revocation logic

Auth0's documented detection approach layers three signals: rotation policy violations (reuse count above threshold), location anomalies (multiple distinct IP ranges within a family), and user-agent inconsistencies. Combining all three reduces false positive rates versus any single signal.

### Okta

Okta's implementation exposes the rotation type (`ROTATE` vs `STATIC`) and leeway as first-class OAuth client settings:

```json
{
  "settings": {
    "oauthClient": {
      "rotation_type": "ROTATE",
      "leeway": 30
    }
  }
}
```

An important Okta behavior to design around: when a refresh token is rotated, the new token inherits the **original expiry date** from the root of the family rather than getting a fresh lifetime from the point of rotation. A refresh token family issued with a 90-day lifetime will have all its descendants expire on the same date as the root token, regardless of how recently they were issued. This means long-running agent sessions must re-authenticate at the family root's expiry even if the tokens have been continuously rotated.

Okta also immediately invalidates all access tokens issued since last authentication (not just the current family's tokens) when reuse is detected, providing a harder security boundary.

### RFC 6749 and RFC 6819

RFC 6749 (The OAuth 2.0 Authorization Framework) establishes the base protocol. Refresh tokens are specified in Section 6 (`Refreshing an Access Token`) but the specification does not mandate rotation — it is listed as optional server behavior.

RFC 6819 (OAuth 2.0 Threat Model and Security Considerations) makes the security case more explicit. Section 4.2.2 identifies refresh token compromise as a critical threat and lists countermeasures including: client binding (verifying that the client presenting the token matches the client to which it was issued), automatic rotation, and token revocation APIs. The RFC explicitly recommends rotation as a mechanism to detect unauthorized parallel usage.

## Agent-Specific Considerations

### The Hybrid Session Problem

Modern SaaS platforms serve two very different session types from the same authorization server:
1. **Human sessions**: Browser-based, interactive, re-authentication is low-friction, session duration is bounded by working hours
2. **Agent sessions**: Headless, unattended, re-authentication requires operator intervention, sessions can run for days or weeks

Applying the same rotation policy to both creates tension. A 15-minute access token lifetime that feels seamless to a human browser (the refresh is transparent) creates hundreds of token exchanges per day for an agent executing a high-volume workflow. Each exchange is a potential failure point and adds latency.

One approach is to issue agent sessions with longer access token lifetimes (e.g., 4-8 hours for a known, verified agent workload identity) while maintaining strict rotation for human sessions. The tradeoff is that a compromised agent access token remains valid longer. The right balance depends on the sensitivity of the protected resources and the feasibility of agent workload identity verification.

### API Key vs. Refresh Token Tradeoffs for Agents

Many platforms default to API keys for agent authentication because they are operationally simple: generate once, embed in configuration, use indefinitely. However, API keys have significant security weaknesses at scale:

| Property | API Key | Refresh Token + Rotation |
|----------|---------|--------------------------|
| Theft detection | None — key can be silently replayed | Reuse detected on next exchange |
| Revocation granularity | Delete entire key | Revoke individual family or all families for a user |
| Scope enforcement | Platform-dependent | OAuth scopes, enforced per-token |
| Audit trail | Key-level only | Per-exchange, per-family, per-user |
| Prompt injection risk | Key exposed to agent context | Token stored externally in vault |

The recommendation from Auth0's 2025 guidance: do not issue refresh tokens to AI agents for the duration of a single task. Instead, issue a time-limited access token scoped to exactly the permissions needed for that task, and require the orchestration layer (not the agent itself) to manage token refresh using a stored refresh token that the agent never sees.

### Token Theft Vectors Unique to Agent Runtimes

Several theft vectors are specific to LLM-based agents:

**Prompt injection**: Malicious content in data the agent processes (emails, documents, web pages) can instruct the model to exfiltrate credentials. If the agent's refresh token is in its context window or reachable via a tool call, it can be stolen without any traditional network intrusion.

**Tool call interception**: In multi-agent pipelines, tool calls cross process boundaries. A compromised intermediate agent or MCP server can intercept credentials passed as tool arguments.

**Memory extraction**: Long-running agents with persistent memory may cache token values in their memory store. If that store is readable by other agents or accessible via a jailbreak, tokens can be extracted.

**Log leakage**: Agent frameworks that log tool arguments in debug mode can write refresh tokens to log files, which may be stored in less secure infrastructure than the credential vault.

Mitigation strategies:
- Never put token values in the agent's context window; resolve them just-in-time via a vault API call
- Use opaque references ("the GitHub token for this user") rather than raw values when passing credentials between agents
- Ensure agent memory stores have the same access controls as the credential vault
- Audit all tool call argument logging to confirm sensitive values are redacted

### Credential Vault Integration

A production-grade agent authentication architecture centralizes token management in a dedicated vault service rather than distributing credentials across agent processes:

```
┌─────────────────────────────────────────────────────────┐
│                    Credential Vault                      │
│  - Stores refresh tokens encrypted at rest (AES-256-GCM)│
│  - Handles token rotation transparently                  │
│  - Issues short-lived access tokens to agents on demand  │
│  - Enforces per-agent, per-user scope restrictions       │
│  - Provides audit log for every credential access        │
└──────────────────────┬──────────────────────────────────┘
                       │ Authenticated vault API call
                       │ (agent presents workload identity,
                       │  receives scoped access token)
              ┌────────▼────────┐
              │   Agent Worker  │
              │ (stateless,     │
              │  no stored creds│
              └────────┬────────┘
                       │ Bearer access_token (short-lived)
                       ▼
              Resource Server APIs
```

The agent never holds a refresh token. It holds only a short-lived access token obtained from the vault, which itself manages the refresh token rotation cycle. This containment means that even a fully compromised agent process cannot exfiltrate durable credentials — the access token it holds expires within minutes and cannot be used to obtain new ones.

Implementations to evaluate:
- **Auth0 Token Vault**: Managed service integrating with Auth0's authorization server; handles rotation, scoping, and audit logging
- **HashiCorp Vault with AppRole**: Agent authenticates via AppRole (role_id + secret_id), receives a Vault token scoped to the paths it needs; dynamic secrets can be generated per-agent-invocation
- **AWS Secrets Manager + Bedrock AgentCore Identity**: AWS-native pattern where agents authenticate via IAM roles and receive short-lived credentials

## Implementation Patterns Summary

### Minimum Viable Rotation

For teams implementing rotation from scratch, the minimum viable implementation requires:

1. **Token storage**: Server-side record per refresh token with `family_id`, `status`, `consumed_at`
2. **Atomic exchange**: Serializable transaction that reads, marks consumed, and issues new token in one operation
3. **Reuse handler**: On consumed token → revoke entire family, emit event
4. **Grace window**: 15-30 second window for same consumed token → return successor

### Production Additions

- Generation counter for forensic chain reconstruction
- Device metadata (`ip`, `user_agent`) on each token for anomaly detection
- Streaming reuse events to SIEM/alerting infrastructure
- Distributed lock for multi-process environments
- Token family dashboard for support and incident response teams
- Automated family revocation on anomalous location/device signals

### Agent-Specific Additions

- Vault proxy layer between agents and authorization server
- Workload identity for agent authentication to the vault (no human-in-the-loop)
- Per-agent-invocation token scoping (narrower than per-user scoping)
- Prompt injection detection at the tool call boundary
- Credential access audit log separate from application logs

## Practical Recommendations

**For new systems:**
- Enable refresh token rotation by default; the operational cost is low and the security benefit is substantial
- Set access token lifetime to 15-60 minutes; set refresh token lifetime based on re-authentication friction (shorter for browser sessions, longer for agent sessions with vault-mediated access)
- Implement the grace window at 15-30 seconds; tuning down to 0 is only appropriate if you have eliminated all concurrent-refresh scenarios at the client
- Store refresh tokens as opaque values (random strings), not as JWTs — the server record provides revocability that a self-contained JWT cannot

**For agent platforms:**
- Do not give agents direct access to refresh tokens; use a vault intermediary
- Issue per-task or per-session access tokens scoped to exactly the permissions needed; do not reuse a broad-scope token across tasks
- Implement workload identity for agent-to-vault authentication so that credential access is auditable per agent instance
- Treat prompt injection as a credential theft vector, not just a content safety issue — design system prompts to instruct agents never to repeat or transmit credentials, and audit tool call argument logging

**For existing systems migrating to rotation:**
- Rotation can be enabled per-application without affecting other clients
- Run rotation in shadow mode first: log what would have been revoked without actually revoking, to calibrate the false positive rate before enforcement
- Communicate to API consumers that refresh token values will change on each use; any code that stores the refresh token value as a static configuration value will break

**For incident response:**
- A reuse detection event should trigger immediate family revocation and user notification
- Use the `generation` counter and `parent_id` chain to reconstruct when the family diverged and which generation was likely stolen
- Correlate `initial_ip` vs `last_ip` across the family to identify the likely attacker origin

---

*Sources:*
- *[Refresh Token Security: Detecting Hijacking and Misuse with Auth0](https://auth0.com/blog/refresh-token-security-detecting-hijacking-and-misuse-with-auth0/)*
- *[Refresh Token Rotation - Auth0 Docs](https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation)*
- *[Refresh Tokens and Rotation - Okta Developer](https://developer.okta.com/docs/guides/refresh-tokens/main/)*
- *[RFC 6819 - OAuth 2.0 Threat Model and Security Considerations](https://datatracker.ietf.org/doc/html/rfc6819)*
- *[Secure Refresh Token Rotation with Theft Detection - Mihai Andrei](https://mihai-andrei.com/blog/refresh-token-reuse-interval-and-reuse-detection/)*
- *[How to Handle Token Refresh for AI Agents in Production - Scalekit](https://www.scalekit.com/blog/how-handle-token-refresh-ai-agents)*
- *[Token Vault for AI Agent Workflows - Scalekit](https://www.scalekit.com/blog/token-vault-ai-agent-workflows)*
- *[Common Risks of Giving Your API Keys to AI Agents - Auth0](https://auth0.com/blog/api-key-security-for-ai-agents/)*
- *[Refresh Token Rotation Grace Period Issue - better-auth](https://github.com/better-auth/better-auth/issues/8512)*
- *[AI Agent Authentication Methods - Stytch](https://stytch.com/blog/ai-agent-authentication-methods/)*
- *[JWT vs. Opaque Tokens - ZITADEL](https://zitadel.com/blog/jwt-vs-opaque-tokens)*
