---
date: "2026-03-17"
title: "Identity Resolution and Cross-Platform User Mapping for Multi-Channel AI Agents"
description: "How AI agents that operate across Telegram, Slack, Discord, Lark, and web consoles resolve and unify user identities — covering deterministic vs probabilistic matching, identity graphs, trust tier assignment, and the security implications of cross-platform identity linking."
tags:
  - research
  - ai-agents
  - identity
  - security
  - multi-channel
  - trust
---

## Executive Summary

Multi-channel AI agents face a fundamental identity problem: the same human can contact the agent from Telegram, a web console, Lark, and Discord — and each platform issues a different, platform-scoped user identifier. Without identity resolution, the agent sees four strangers instead of one person, losing conversation history, trust status, and personalization across channels.

This article examines how production systems solve this problem, drawing on Customer Data Platform (CDP) identity graph patterns, enterprise identity federation standards (SAML, OIDC, SCIM), and the emerging body of agentic AI identity management work from the OpenID Foundation and Cloud Security Alliance. The core pipeline — `sender_id → identity resolution → internal_user_id → trust_level → access control` — is straightforward to describe but non-trivial to implement correctly in the face of impersonation risks, shared devices, anonymous users, and privacy regulations.

Key findings:
- Deterministic matching (shared secrets, OAuth linking) provides high accuracy at the cost of coverage; probabilistic matching extends coverage but introduces false-positive risk.
- Identity graphs must be treated as a security boundary: a misconfigured merge rule can grant one user another's trust level.
- Traditional IAM frameworks (OAuth 2.0, SAML) were not designed for multi-channel agents acting on behalf of users; the emerging OIDC-A and token exchange patterns (RFC 8693) are the right direction.
- Privacy regulations (GDPR, EU AI Act) impose meaningful constraints: cross-platform linking requires a lawful basis, and linking anonymous identifiers can itself constitute personal data processing.

---

## The Core Problem: Platform-Scoped Identifiers

Every messaging platform issues identifiers that are opaque and scoped to that platform. A Telegram user ID (e.g., `8474920163`) means nothing to a Lark server, and a Lark open user ID (e.g., `ou_abc123`) is meaningless to a Discord server. When a user writes to your agent from two platforms, you receive two different `sender_id` values with no intrinsic link between them.

This is not an accident. Platform-scoped identifiers are a deliberate privacy and business design: platforms want to prevent cross-platform tracking without their mediation. Apple's App Tracking Transparency and the deprecation of third-party cookies reflect the same principle extended to the web.

For an AI agent, the consequences are concrete:

- **Fragmented memory**: a user who set their preferences on Telegram gets default behavior on Lark.
- **Inconsistent trust**: a user verified as the owner on Telegram gets treated as a stranger on the web console.
- **Duplicate user records**: analytics and audit logs inflate user counts and misattribute sessions.
- **Broken access control**: if trust levels are stored per `sender_id` rather than per resolved identity, a trust escalation on one channel does not propagate to others.

---

## Identity Resolution Approaches

### Deterministic Matching

Deterministic resolution uses exact, shared identifiers — values that the user has explicitly provided across platforms. Common examples:

- **Email address**: if both platforms collect a verified email, the hash of that email is a reliable join key.
- **Phone number**: similar to email, but less consistently collected.
- **OAuth account linking**: the user explicitly connects their accounts (e.g., "Link your Telegram to your web account"). The agent stores a mapping table of `(platform, platform_user_id) → internal_user_id`.
- **Shared secret / passcode**: the agent issues a linking code on one channel; the user submits it on another channel to prove they are the same person.

Deterministic matching is highly accurate — if the shared identifier is correct, the match is certain. Its weakness is coverage: users who never link accounts remain as separate identities per channel.

```
# Deterministic identity store (conceptual)
identity_links = {
    ("telegram", "8474920163"): "user:howard",
    ("lark", "ou_abc123"):      "user:howard",
    ("web", "session:xyz"):     "user:howard",
}

def resolve(platform: str, sender_id: str) -> str | None:
    return identity_links.get((platform, sender_id))
```

### Probabilistic Matching

When no shared deterministic identifier is available, probabilistic methods estimate identity overlap using correlated signals:

- **Device fingerprint**: screen resolution, OS, browser engine, timezone — stable across platforms if accessed from the same device.
- **IP address / network subnet**: weaker signal due to NAT and VPNs, but useful for coarse grouping.
- **Behavioral patterns**: message timing, vocabulary, topic distribution, interaction style.
- **Geolocation**: coarse location data available on many platforms.

Each signal contributes to a confidence score. If the composite score exceeds a threshold, the system merges the identities. The threshold is a calibrated parameter: lower thresholds increase coverage but increase false merges (granting one user another's access); higher thresholds are more conservative.

```
def probabilistic_match(profile_a: UserProfile, profile_b: UserProfile) -> float:
    score = 0.0
    if profile_a.timezone == profile_b.timezone:
        score += 0.15
    if subnet_match(profile_a.last_ip, profile_b.last_ip):
        score += 0.20
    score += behavioral_similarity(profile_a.message_vectors, profile_b.message_vectors) * 0.45
    score += device_fingerprint_similarity(profile_a.fingerprint, profile_b.fingerprint) * 0.20
    return score  # 0.0–1.0

MERGE_THRESHOLD = 0.75  # tune based on false positive tolerance
```

Probabilistic matching is appropriate for enrichment and analytics, but for security-sensitive operations (granting elevated trust, accessing private data) it should be treated as a suggestion requiring human confirmation rather than an automatic merge.

### Hybrid Strategy

Production systems combine both approaches. The standard pattern from CDP literature is:

1. **Deterministic resolution first**: attempt to resolve `(platform, sender_id)` against the identity link table. If a match exists, use it.
2. **Probabilistic fallback for unlinked users**: compute a match score against existing profiles. If above threshold, surface a confirmation prompt ("Are you the same person who contacted us on Telegram?").
3. **Progressive disclosure**: for unresolvable anonymous users, operate in a limited mode until the user voluntarily provides a linking identifier.

---

## The Identity Graph

An **identity graph** is the data structure that stores identity resolution results. Each node represents either a platform-scoped identity (`(platform, sender_id)`) or an internal user record. Edges represent established links, tagged with the resolution method (deterministic/probabilistic) and confidence score.

```
[telegram:8474920163] ──deterministic──► [internal:user:howard]
[lark:ou_abc123]      ──deterministic──► [internal:user:howard]
[web:session:xyz]     ──probabilistic──► [internal:user:howard]  (confidence: 0.82)

[telegram:0000000001] ──unresolved──► [ephemeral:anon:t_0000000001]
```

Key design properties for agent-facing identity graphs:

- **Canonical ID**: every platform identity must resolve to exactly one canonical internal ID. No fan-out (one platform ID linking to multiple canonical IDs).
- **Directed edges**: the graph is from platform identities to canonical IDs, not the reverse. This prevents circular merge chains.
- **Audit log**: every merge and split operation must be logged with timestamp, method, and confidence.
- **Split capability**: identity merges can be wrong. The graph must support splitting a canonical record back into two separate identities.
- **TTL on probabilistic links**: probabilistic links should have a time-to-live. A shared office IP should not permanently merge two employees' identities.

---

## The Trust Assignment Pipeline

Once a `sender_id` is resolved to an internal user record, the agent evaluates the trust level to apply for this session. This is not a static lookup — trust is contextual.

```
Inbound message
    │
    ▼
[1] Platform auth check
    │  (is the sender_id authentic per the platform's webhook signature?)
    ▼
[2] Identity resolution
    │  sender_id → internal_user_id (or ephemeral anon ID)
    ▼
[3] Base trust lookup
    │  internal_user_id → base_trust_tier (owner/admin/user/stranger)
    ▼
[4] Contextual modifiers
    │  - Channel type (private DM vs group chat)
    │  - Resolution confidence (deterministic → full trust; probabilistic → reduced trust)
    │  - Anomaly signals (new device, unusual location, behavioral shift)
    │  - Session recency (how recently was identity last confirmed?)
    ▼
[5] Effective trust level for this session
    │
    ▼
[6] Access control enforcement
```

### Trust Tiers in Practice

A practical tier model for a personal AI agent:

| Tier | Description | Capabilities |
|------|-------------|--------------|
| `owner` | Verified owner via deterministic linking | Full system access, secret exposure, config changes |
| `admin` | Explicitly granted by owner | Extended capabilities, cannot escalate to owner |
| `user` | Known linked user | Standard agent capabilities, memory, personalization |
| `stranger` | Unresolved sender | Public-facing capabilities only, no memory persistence |
| `blocked` | Explicit deny list | Rejected with no response |

### Resolution Confidence as a Trust Modifier

The resolution method itself should inform the effective trust level:

```python
def effective_trust(base_trust: str, resolution_method: str, confidence: float) -> str:
    if resolution_method == "deterministic":
        return base_trust  # full trust, no reduction
    elif resolution_method == "probabilistic":
        if confidence >= 0.90:
            return base_trust  # high confidence, minimal reduction
        elif confidence >= 0.75:
            return demote_one_tier(base_trust)  # e.g., owner → admin
        else:
            return "stranger"  # too uncertain
    else:
        return "stranger"
```

This prevents an attacker from gaining owner-level trust through a probabilistic match that happens to score just above the merge threshold.

---

## Enterprise Platform Patterns

### Intercom / Zendesk / Salesforce Approach

Customer service platforms solved the multi-channel unification problem years before AI agents. Intercom's approach is representative: a user can contact via web chat, email, WhatsApp, or SMS, and the platform builds a unified conversation timeline. The technical mechanism is:

1. **Known user tracking**: when a user is authenticated (logged in), the platform receives a verified `user_id` from the integrating product, signed with an HMAC identity verification secret. This is deterministic linking.
2. **Anonymous visitor stitching**: before login, a device-scoped anonymous ID is created. On login, the anonymous ID is merged into the authenticated user record, preserving conversation history.
3. **Cross-channel real-time sync**: identity updates on one channel propagate immediately. A new lead in Intercom triggers a Salesforce record creation; a profile update on either side syncs in real time.

The HMAC identity verification pattern is directly applicable to multi-channel AI agents: when routing a message from a trusted platform (e.g., your own web console), include a server-generated HMAC of the user's internal ID. The agent verifies the HMAC and can deterministically resolve the identity without relying on the platform's own opaque ID.

```python
import hmac, hashlib

def generate_identity_token(internal_user_id: str, secret: str) -> str:
    return hmac.new(
        secret.encode(), internal_user_id.encode(), hashlib.sha256
    ).hexdigest()

def verify_identity_token(internal_user_id: str, token: str, secret: str) -> bool:
    expected = generate_identity_token(internal_user_id, secret)
    return hmac.compare_digest(expected, token)
```

### OAuth Account Linking

For third-party platform channels (Telegram, Discord, Slack), the cleanest deterministic linking mechanism is OAuth-based account linking:

1. The agent sends the user a one-time linking URL pointing to an OAuth endpoint you control.
2. The user authenticates via your OAuth server (which knows their internal identity).
3. Your server stores `(platform, platform_user_id) → internal_user_id` and marks the link as deterministic.
4. Future messages from that platform user are instantly resolved.

This is the same pattern used by "Connect with Google" / "Connect with Facebook" social login, applied in reverse: instead of using a third-party identity to authenticate into your system, you're using your system's identity to claim a third-party channel.

---

## Identity Federation Standards

### OIDC Token Exchange (RFC 8693)

For agent-to-agent and cross-system scenarios, OAuth 2.0 Token Exchange (RFC 8693) provides a standards-based mechanism for identity delegation. An agent acting on behalf of a user obtains a token that cryptographically binds:

- The **subject** (the user whose identity is being delegated)
- The **actor** (the agent performing the action)
- The **scope** (what the agent is authorized to do on behalf of the subject)

This is critical for audit trail integrity: when agent A delegates to agent B, the resulting actions are attributable to both the originating user and the specific agent chain that executed them.

### SCIM for User Lifecycle

System for Cross-domain Identity Management (SCIM 2.0) provides a REST API standard for provisioning and deprovisioning user identities across systems. For a multi-channel agent, SCIM can serve as the protocol by which an enterprise identity provider (Okta, Azure AD, Google Workspace) pushes user records into the agent's identity graph:

- **User created in IdP**: SCIM `POST /Users` creates the internal user record.
- **User deprovisioned**: SCIM `DELETE /Users/{id}` or `PATCH` with `active: false` triggers immediate trust revocation across all channels.
- **Group membership changes**: SCIM `PATCH /Groups` updates trust tiers.

Without SCIM integration, a terminated employee's Telegram identity might retain access to the agent indefinitely because the agent never received the deprovisioning signal.

---

## Real-World Challenges

### Impersonation

Platform-scoped user IDs are not secret. On many platforms, a user's ID is visible in profile URLs, API responses, or group membership lists. An attacker who learns that user ID `8474920163` has owner-level trust cannot impersonate that user over a verified webhook — but they could attempt:

- **Webhook forgery**: sending a forged payload with someone else's `sender_id`. Mitigated by verifying platform-specific webhook signatures (Telegram's bot token signature, Slack's signing secret, Discord's Ed25519 signature).
- **Account takeover on the source platform**: if the attacker compromises the user's Telegram account, they inherit the user's agent identity. The agent cannot distinguish a compromised account from the legitimate user.
- **Probabilistic match manipulation**: crafting signals (device fingerprint, behavior) to score high against a high-trust user profile. Mitigated by limiting probabilistic matching to low-trust operations only.

### Shared Devices

Two family members sharing a tablet present as the same device fingerprint. Any probabilistic signals derived from device characteristics will incorrectly merge their identities. This is the "family plan" problem well-documented in CDP literature.

Mitigation: treat device fingerprint as a weak signal only. Require explicit deterministic linking for trust elevations. Where device sharing is expected (enterprise kiosks, call center terminals), disable device-based probabilistic signals entirely.

### Anonymous Users

Not all users want to be identified. An agent serving a public channel should function gracefully for unresolved anonymous users:

- Assign an ephemeral session-scoped identifier.
- Persist only session-local state; do not write to the long-term user graph.
- Apply `stranger` trust tier unconditionally.
- Offer opt-in linking: "If you'd like me to remember you next time, link your account at [URL]."

### Identity Resolution Latency

Identity resolution adds latency to every message. For a streaming-response agent, this is acceptable if resolution completes before the first token is generated. For latency-sensitive use cases, pre-resolve identities at webhook ingestion time and cache the resolved `internal_user_id` with a short TTL (e.g., 5 minutes) rather than re-resolving on every message.

---

## Privacy and Compliance

Cross-platform identity linking is personal data processing under GDPR and similar frameworks. Key requirements:

**Lawful basis**: Linking platform identities requires a lawful basis (typically legitimate interest or contract performance for agent use cases). Purely analytics-driven linking of anonymous users may require explicit consent.

**Data minimization**: Store only the identifiers needed for resolution. Do not copy platform user profiles into your identity graph unless necessary.

**Right to erasure**: A user's request to delete their data must cascade through the identity graph. Deleting the canonical user record must also delete all platform identity links.

**Purpose limitation**: An identity graph built for agent personalization cannot be repurposed for advertising profiling without a separate lawful basis.

**Probabilistic merge transparency**: Users should be able to discover which platform identities have been linked to their canonical record and request correction of incorrect merges.

The EU AI Act adds additional obligations for high-risk AI systems: identity resolution systems that influence consequential decisions (access control, financial services, employment) face stricter requirements including algorithmic transparency and human oversight of automated decisions.

---

## Implementation Blueprint

For a multi-channel AI agent, the minimal viable identity resolution architecture:

```
┌─────────────────────────────────────────────────────┐
│                   Message Ingestion                  │
│  [Telegram] [Lark] [Discord] [Slack] [Web Console]  │
└──────────────────────┬──────────────────────────────┘
                       │ (platform, sender_id, message)
                       ▼
┌─────────────────────────────────────────────────────┐
│             Platform Auth Verification               │
│   Verify webhook signature per platform protocol    │
└──────────────────────┬──────────────────────────────┘
                       │ (verified sender_id)
                       ▼
┌─────────────────────────────────────────────────────┐
│              Identity Resolution Layer               │
│  1. Deterministic lookup in identity_links table    │
│  2. If miss: probabilistic scoring against profiles │
│  3. If match above threshold: surface confirmation  │
│  4. If no match: assign ephemeral anon ID           │
└──────────────────────┬──────────────────────────────┘
                       │ (internal_user_id OR anon_id)
                       ▼
┌─────────────────────────────────────────────────────┐
│               Trust Evaluation Layer                 │
│  base_trust + channel_modifier + confidence_modifier│
│  → effective_trust_level for this session           │
└──────────────────────┬──────────────────────────────┘
                       │ (user_context with trust_level)
                       ▼
┌─────────────────────────────────────────────────────┐
│                  Agent Processing                    │
│  Access control gates, memory retrieval, response  │
└─────────────────────────────────────────────────────┘
```

Data schema for the identity link table (PostgreSQL):

```sql
CREATE TABLE identity_links (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    internal_user_id UUID NOT NULL REFERENCES users(id),
    platform        TEXT NOT NULL,     -- 'telegram', 'lark', 'discord', etc.
    platform_user_id TEXT NOT NULL,
    resolution_method TEXT NOT NULL,   -- 'deterministic', 'probabilistic'
    confidence      FLOAT,             -- NULL for deterministic
    linked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ,       -- NULL for permanent deterministic links
    UNIQUE (platform, platform_user_id)
);

CREATE INDEX idx_identity_links_lookup
    ON identity_links (platform, platform_user_id)
    WHERE expires_at IS NULL OR expires_at > NOW();
```

---

## Summary

Identity resolution for multi-channel AI agents is an intersection of three historically separate disciplines: Customer Data Platform identity graphs, enterprise IAM federation, and conversational AI design. The key principles:

1. **Never conflate `sender_id` with user identity.** The pipeline from platform identifier to internal user to trust level must be explicit and auditable.
2. **Deterministic before probabilistic.** Use exact linking wherever possible. Use probabilistic methods only for enrichment, never for security-sensitive trust escalation.
3. **Resolution method affects trust.** A probabilistic match warrants a lower effective trust level than a deterministic one, regardless of the base trust assigned to the canonical user.
4. **The identity graph is a security boundary.** Merge rules, split operations, and TTLs must be treated with the same rigor as access control policies.
5. **GDPR and similar regulations apply from day one.** Cross-platform linking is personal data processing. Build consent, erasure, and purpose limitation in from the start, not as retrofits.
6. **Deprovisioning must be immediate.** Use SCIM or equivalent lifecycle signals to ensure that revoked access propagates across all channels in real time.

As AI agents become primary interfaces across enterprise and consumer contexts, the identity layer will determine whether they are trustworthy — or a vector for privilege escalation and privacy violation.

---

## References and Further Reading

- [Identity Management for Agentic AI — OpenID Foundation Whitepaper](https://openid.net/wp-content/uploads/2025/10/Identity-Management-for-Agentic-AI.pdf)
- [Agentic AI Identity and Access Management — Cloud Security Alliance](https://cloudsecurityalliance.org/artifacts/agentic-ai-identity-and-access-management-a-new-approach)
- [Cross-Platform Identity Resolution 2025 — Switchboard Software](https://switchboard-software.com/post/cross-platform-identity-resolution-in-2025-the-holy-grail-of-modern-marketing/)
- [CDP Identity Resolution: Deterministic vs Probabilistic — Medium](https://medium.com/@pradeepwho/cdp-identity-resolution-a-comparison-of-deterministic-and-probabilistic-methods-f06ad8b9f148)
- [The 5 Trends Reshaping Identity Resolution in 2026 — MarTech](https://martech.org/the-5-trends-reshaping-identity-resolution-in-2026/)
- [Identity Resolution — Twilio](https://www.twilio.com/en-us/blog/insights/identity-resolution)
- [Agentic AI Identity Management Approach — CSA Blog](https://cloudsecurityalliance.org/blog/2025/03/11/agentic-ai-identity-management-approach)
- [A Novel Zero-Trust Identity Framework for Agentic AI — arXiv](https://arxiv.org/html/2505.19301v1)
- [The Looming Authorization Crisis: Why Traditional IAM Fails Agentic AI — ISACA](https://www.isaca.org/resources/news-and-trends/industry-news/2025/the-looming-authorization-crisis-why-traditional-iam-fails-agentic-ai)
- [Engineering GDPR Compliance in the Age of Agentic AI — IAPP](https://iapp.org/news/a/engineering-gdpr-compliance-in-the-age-of-agentic-ai)
- [IAM for AI Agents: Federation and Lifecycle Control — BigID](https://bigid.com/blog/iam-for-ai-agents/)
- RFC 8693: OAuth 2.0 Token Exchange — [IETF](https://datatracker.ietf.org/doc/html/rfc8693)
- SCIM 2.0: RFC 7644 — [IETF](https://datatracker.ietf.org/doc/html/rfc7644)
