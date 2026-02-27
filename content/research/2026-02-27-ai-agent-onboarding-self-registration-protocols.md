---
date: "2026-02-27"
title: "AI Agent Onboarding: Self-Registration and Discovery Protocols"
description: "A deep-dive into how AI agents discover, register with, and authenticate to communication platforms and services — covering registration protocols, service discovery, identity bootstrapping, real-world examples, and security considerations."
tags:
  - research
  - ai-agents
  - protocols
  - security
  - infrastructure
---

## Executive Summary

As AI agents move from novelty to production infrastructure, a critical engineering challenge has come into focus: how does an agent introduce itself to the world? Human users tap "Sign Up" and fill out a form. Agents need to do the same — programmatically, autonomously, and securely — often without any human present at the moment of registration.

This article surveys the full landscape of agent onboarding: the registration patterns that platforms use today, the emerging discovery protocols being standardized across the industry, the identity bootstrapping techniques that let a brand-new agent establish a trustworthy identity from nothing, and the security mechanisms that prevent that openness from being abused.

Key takeaways:

- **Platform-native registration** (Telegram BotFather, Discord Developer Portal, Slack OAuth) remains the dominant approach for consumer-facing agents, but it requires human intervention.
- **OAuth 2.0 Dynamic Client Registration** (RFC 7591) and its extension into the Model Context Protocol provide the cleanest path toward fully headless, autonomous registration.
- **Emerging discovery standards** — Google A2A Agent Cards at `/.well-known/agent.json`, MCP's `/.well-known/mcp`, and OWASP's Agent Name Service — are converging on a DNS-like model where capability and identity are inseparable.
- **Security is not optional**: ticket/invite codes, proof-of-work bootstrapping, rate limiting, and short-lived credentials are the key defenses against registration abuse.

---

## Registration Protocols

### Ticket-Based and Invite-Code Models

The simplest controlled-onboarding mechanism is the one-time token: a human operator generates an invite code or registration ticket, hands it to the agent installation script, and the service accepts exactly that code once.

This pattern appears in:

- **Matrix/Element homeservers**: registration tokens (`m.login.registration_token`) gate who can create accounts. A homeserver operator generates a token via the admin API, shares it out-of-band, and the registration call includes it as a credential.
- **Self-hosted services** (Gitea, Forgejo, Mattermost): registration can be globally disabled except for email-domain allow-lists or one-time tokens, preventing open sign-up while allowing scripted agent provisioning.
- **Post-install hooks**: a common pattern in Kubernetes operators and Helm charts where a `post-install` Job runs once, hits the service's `/register` endpoint with a bootstrap token embedded in a Secret, and creates the service account that the main workload will use.

The ticket model is easy to audit — every registration traces back to a specific token issuance event — but it does not scale to multi-tenant or federated deployments without additional infrastructure.

### API Key Provisioning

API key provisioning is the oldest headless onboarding pattern and still the most common in practice. A human creates credentials once via a web UI or CLI; those credentials are stored as environment variables or secrets and injected into the agent at startup.

```bash
# Typical provisioning flow
# 1. Human creates key via dashboard
export BOT_TOKEN="sk-proj-..."

# 2. Agent reads at startup
token = os.getenv("BOT_TOKEN")

# 3. Agent authenticates all requests
headers = {"Authorization": f"Bearer {token}"}
```

The limitation is that this is not truly autonomous — a human is still in the loop for the initial key creation. True self-provisioning requires either OAuth (see below) or a bootstrapping identity that can request new keys from a secrets management API (Vault, AWS Secrets Manager) using an instance identity credential (e.g., an AWS IAM instance profile or a Kubernetes service account token).

### OAuth 2.0 for Bots and Agents

OAuth 2.0 is the backbone of modern bot registration for platforms like Slack, Discord, and GitHub. The standard three-legged OAuth flow was designed for delegated user authorization, but two variants are particularly relevant for agents:

**Client Credentials Grant**: The agent has a pre-registered `client_id` and `client_secret`. It exchanges these for an access token directly, with no user in the loop. This is the standard flow for server-to-server integrations.

```
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_id=abc123
&client_secret=xyz789
&scope=read:messages write:messages
```

**Dynamic Client Registration (RFC 7591)**: The agent registers itself programmatically at a registration endpoint, receiving `client_id` and `client_secret` in the response — no prior manual setup required.

```http
POST /connect/register
Content-Type: application/json
Authorization: Bearer <initial_access_token>

{
  "client_name": "Inventory Agent v2",
  "redirect_uris": ["https://agent.example.com/callback"],
  "grant_types": ["client_credentials"],
  "token_endpoint_auth_method": "client_secret_post",
  "scope": "inventory:read inventory:write"
}
```

Response:
```json
{
  "client_id": "dyn_abc123",
  "client_secret": "dyn_secret_xyz",
  "client_id_issued_at": 1740614400,
  "client_secret_expires_at": 0
}
```

RFC 7591 Dynamic Client Registration is now central to how agents interact with MCP servers. When an agent encounters a new MCP server, it can use DCR to register and obtain credentials at runtime — solving the M×N problem where every agent-to-server pair would otherwise need pre-coordinated credentials.

---

## Real-World Platform Registration

### Telegram BotFather

Telegram's registration pattern is intentionally human-gated: you must interact with `@BotFather` in the Telegram client, send `/newbot`, and follow a conversational flow to receive a token. The token authenticates all subsequent API calls on behalf of that bot.

```
/newbot
> Alright, a new bot. How are we going to call it? Please choose a name for your bot.
My Cool Bot
> Good. Now let's choose a username for your bot...
my_cool_bot
> Done! Congratulations on your new bot. You will find it at t.me/my_cool_bot.
> Use this token to access the HTTP API:
> 7483920154:AAF8R2XmV9K-example-token-string
```

The token acts as both identity and credential. Once obtained, the agent uses it entirely programmatically:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getMe"
curl "https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<ID>&text=Hello"
```

There is no automated self-registration path in Telegram's public API — the BotFather step is mandatory. For autonomous deployments, teams typically provision the token in advance during infrastructure setup and inject it as a secret.

### Discord Bot Setup

Discord's model separates application creation (done once via the Developer Portal) from server authorization (done per-guild via an OAuth2 invite URL):

1. Create an application at `discord.com/developers/applications`
2. Under the Bot tab, generate a token and enable the required gateway intents (e.g., `MESSAGE_CONTENT`)
3. Generate an OAuth2 invite URL with the bot scope and selected permissions
4. A guild administrator visits the URL to authorize the bot into their server

The key security insight here is **permission scoping at invite time**: the bot token grants capability, but actually joining a server requires explicit administrator approval. This prevents a compromised token from spreading to new servers without human authorization.

### Slack App Registration and OAuth

Slack uses a richer OAuth flow with granular Bot Token Scopes. The registration steps:

1. Create a Slack app at `api.slack.com/apps`
2. Declare required OAuth scopes (e.g., `channels:read`, `chat:write`)
3. Implement the OAuth 2.0 redirect flow to obtain a workspace-specific Bot User OAuth Token (`xoxb-...`)
4. Store the token; Slack also provides a Signing Secret for verifying incoming webhook signatures

For Slack's OAuth flow, the bot receives a workspace-scoped token — the same token cannot be used across workspaces. This gives workspace administrators independent revocation control.

---

## Service Discovery

### DNS-SD and Traditional Service Discovery

DNS-Based Service Discovery (RFC 6763) is the established standard for local network service discovery — a device announces `_http._tcp.local` records that others can browse. While DNS-SD works well for local infrastructure (printers, IoT sensors), it was not designed for the semantics-rich, globally distributed, and identity-sensitive requirements of AI agent ecosystems.

Traditional DNS lacks:
- Capability metadata (what can this agent do?)
- Verifiable identity (is this actually the agent it claims to be?)
- Dynamic revocation (how do I know this agent hasn't been compromised?)

### A2A Agent Cards and `/.well-known/agent.json`

Google's Agent2Agent (A2A) protocol, released in April 2025, solves discovery through **Agent Cards** — small JSON documents published at a well-known URL that describe everything a client needs to connect and delegate work.

Every A2A-compliant agent publishes at `/.well-known/agent.json`:

```json
{
  "name": "Inventory Agent",
  "description": "Manages warehouse inventory queries and adjustments",
  "url": "https://inventory.internal/a2a",
  "version": "1.2.0",
  "provider": {
    "organization": "Acme Corp",
    "url": "https://acme.example.com"
  },
  "capabilities": {
    "streaming": true,
    "pushNotifications": false
  },
  "authentication": {
    "schemes": ["Bearer"],
    "credentials": "https://auth.acme.example.com/.well-known/openid-configuration"
  },
  "skills": [
    {
      "id": "query-stock",
      "name": "Query Stock Levels",
      "description": "Returns current stock for a given SKU"
    }
  ]
}
```

A client agent fetches this card (either directly or via a registry), learns the endpoint, authentication scheme, and capabilities — then connects. No out-of-band configuration is required.

### MCP's `/.well-known/mcp` Endpoint

The Model Context Protocol is converging on a similar pattern. A proposed `/.well-known/mcp` endpoint serves server metadata including available endpoints, capability declarations, and authentication requirements:

```json
{
  "server_name": "File System Server",
  "version": "0.4.1",
  "endpoints": {
    "http": "https://mcp.example.com/v1",
    "sse": "https://mcp.example.com/events"
  },
  "capabilities": ["tools", "resources", "prompts"],
  "auth": {
    "type": "oauth2",
    "authorization_server": "https://auth.example.com",
    "registration_endpoint": "https://auth.example.com/connect/register"
  }
}
```

Note the `registration_endpoint` — this is RFC 7591 Dynamic Client Registration, allowing a client to fully self-configure on first contact with a new server.

### Agent Name Service (ANS)

The OWASP Agent Name Service, proposed in mid-2025, extends the DNS metaphor more formally. ANS provides a protocol-agnostic registry that uses PKI certificates for verifiable agent identity. Key properties:

- **Human-readable and machine-resolvable identifiers** in a unified endpoint format
- **Registration and renewal lifecycle** with explicit expiry and revocation
- **Trust accumulation** based on agent age, activity history, and platform attestations
- **Protocol adapter layer** with adapters for MCP, A2A, and other emerging standards

ANS addresses the gap that DNS cannot fill: an agent registered in ANS carries cryptographically verifiable proof of its identity, capabilities, and current trust level.

---

## Identity Bootstrapping

### First-Run Identity Creation

When an agent starts for the first time on a new host, it has no identity. The bootstrapping sequence typically follows a pattern borrowed from PKI and secrets management:

1. **Generate a keypair** (e.g., ED25519) — this becomes the agent's permanent cryptographic identity
2. **Obtain a bootstrap credential** — either injected at deployment time (a one-time token from a secrets manager) or derived from the host's platform identity (AWS instance profile, GCP workload identity, Kubernetes service account JWT)
3. **Present the bootstrap credential to a registration endpoint** to receive long-lived service credentials
4. **Rotate the bootstrap credential** — it should be single-use or short-lived

```python
# Example: First-run identity bootstrapping
import secrets
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

# Step 1: Generate permanent identity keypair
private_key = Ed25519PrivateKey.generate()
public_key = private_key.public_key()

# Step 2: Read bootstrap token from environment (injected by orchestrator)
bootstrap_token = os.environ["AGENT_BOOTSTRAP_TOKEN"]

# Step 3: Register with identity service
response = requests.post("https://identity.internal/agents/register", json={
    "public_key": public_key_pem,
    "bootstrap_token": bootstrap_token,
    "agent_type": "inventory-agent",
    "version": "1.2.0"
})
agent_id = response.json()["agent_id"]
# Store agent_id and private_key in secure local storage
```

### MoltID and Proof-of-Work Bootstrapping

MoltID, an emerging identity protocol for autonomous agents, adds a lightweight proof-of-work challenge to the registration flow. The agent must solve a computational puzzle to prove intentionality — making bulk disposable registrations computationally expensive without affecting legitimate single-agent onboarding. MoltID then issues JWT-like signed tokens that platforms can verify locally or via an introspection endpoint.

### Credential Rotation

Static credentials are a security liability. Best practice for long-running agents:

- **Access tokens**: short-lived (minutes to hours), automatically refreshed using a refresh token or client credentials
- **Refresh tokens / client secrets**: rotated on a schedule (weekly/monthly) or after any suspected compromise
- **Signing keys**: rotated using a key rollover period where both old and new keys are valid simultaneously

In cloud-native environments, the preferred pattern is **no static secrets at all**: the agent authenticates using its platform identity (IRSA for AWS, Workload Identity for GCP) and uses that to request short-lived tokens from a secrets manager just before each operation.

### Multi-Org Identity

An agent operating across multiple organizations faces the challenge of presenting different identities in different contexts. Patterns:

- **Per-org credentials**: the agent holds a separate credential set for each organization, selected based on which service it is calling
- **Identity federation**: a central identity provider issues organization-scoped tokens on demand, with the agent authenticating to the IdP once and obtaining context-specific tokens as needed
- **Decentralized identifiers (DIDs)**: the agent has a DID that it presents universally; individual organizations verify against the DID document and issue local access tokens

---

## Patterns for Autonomous Agents

### Self-Registration Without Human Intervention

Full headless onboarding requires every step of the registration flow to be automatable. The conditions that make this possible:

1. The service supports programmatic registration (DCR, API, or webhook)
2. The initial credential (bootstrap token, platform identity) is injected by the deployment infrastructure
3. Post-install hooks or init containers handle registration before the main workload starts
4. Failures are handled gracefully with retry logic and alerting

A typical Kubernetes-native pattern:

```yaml
# post-install Job that bootstraps agent identity
apiVersion: batch/v1
kind: Job
metadata:
  name: agent-bootstrap
  annotations:
    "helm.sh/hook": post-install
spec:
  template:
    spec:
      serviceAccountName: agent-bootstrapper  # has IRSA / Workload Identity
      containers:
      - name: bootstrap
        image: agent-bootstrap:latest
        command: ["/bootstrap.sh"]
        env:
        - name: REGISTRY_URL
          value: "https://agent-registry.internal"
        - name: AGENT_TYPE
          value: "inventory-agent"
```

The `bootstrap.sh` script exchanges the Kubernetes service account JWT for a registry token, registers the agent, stores the resulting `agent_id` and credentials in a Kubernetes Secret, and exits. The main agent deployment then reads from that Secret.

### Post-Install Hooks

Post-install hooks are the standard pattern for registration in package-managed deployments:

- **npm/pip**: `postinstall` script in `package.json` or a custom install step
- **Helm**: `post-install` and `post-upgrade` hooks
- **Ansible**: handlers that fire on role completion
- **Docker Compose**: `depends_on` with health checks ensuring the registration service is up before the dependent agent starts

The hook pattern cleanly separates "I installed the software" from "I registered the agent" — re-running an upgrade does not accidentally re-register.

---

## Security Considerations

### Preventing Unauthorized Registration

Open registration endpoints are targets for abuse. Defense layers:

**Initial Access Tokens (RFC 7591)**: DCR endpoints should require an initial access token (IAT) for any registration unless the deployment is intentionally open. The IAT is a short-lived credential issued by the authorization server operator and scoped to allow a single registration.

**Proof-of-Work**: Requiring the registering client to solve a computational challenge (hashcash-style) adds friction for bulk automated abuse without meaningfully burdening legitimate single registrations.

**Domain/IP allow-listing**: In internal deployments, restrict the registration endpoint to known network segments via firewall rules or service mesh policies.

**Human attestation**: For consumer-facing platforms (Telegram, Slack), keeping the initial credential issuance human-gated is a deliberate security choice — even if subsequent operations are fully automated.

### Ticket Expiry

Registration tickets and one-time tokens should have strict expiry policies:

- **Time-to-live**: tokens should expire within minutes to hours of issuance (not days)
- **Single-use enforcement**: track used tokens server-side and reject replay
- **Binding**: tie the token to a specific intended registrant (IP, organization ID, or expected agent type) when possible

### Rate Limiting Registration Endpoints

Registration endpoints are disproportionately expensive to service (database writes, credential generation, notification dispatch). Specific protections:

```nginx
# Nginx rate limiting for registration endpoint
limit_req_zone $binary_remote_addr zone=registration:10m rate=5r/m;

location /agents/register {
    limit_req zone=registration burst=2 nodelay;
    limit_req_status 429;
    proxy_pass http://identity-service;
}
```

Beyond simple IP-based rate limiting, progressive friction is effective: the first registration from an IP succeeds immediately; subsequent registrations within a window require a CAPTCHA or additional verification; sustained high volumes trigger a temporary block and alert.

### Scope Minimization and Least Privilege

Each agent should be granted only the scopes it needs for its defined tasks, declared at registration time. Token introspection and periodic scope reviews prevent scope creep. For OAuth flows, scopes should be declared explicitly in the client metadata rather than requested dynamically.

### Revocation Infrastructure

A registration system without revocation is incomplete. Revocation paths:

- **Token revocation endpoint** (RFC 7009): immediate invalidation of a specific token
- **Client deregistration**: removes all tokens for a registered client (equivalent to deleting a bot account)
- **Key rotation with overlap**: for key-based systems, a revocation event publishes the new public key and sets an expiry on the old one
- **Registry tombstoning**: ANS and similar registries support publishing a revocation record that propagates to consumers without requiring a central authority to block individual requests

---

## Synthesis: Choosing a Registration Pattern

| Scenario | Recommended Pattern |
|---|---|
| Consumer chat bot (Telegram, Slack, Discord) | Platform-native registration + static token stored in secrets manager |
| Internal agent on Kubernetes | Post-install Job + platform workload identity + DCR for downstream services |
| Multi-tenant SaaS agent | OAuth Client Credentials + DCR + per-tenant credential isolation |
| Agent-to-agent discovery | A2A Agent Card at `/.well-known/agent.json` + short-lived bearer tokens |
| High-security or regulated environment | MoltID or ANS with PKI-backed identity + proof-of-work bootstrap + strict ticket expiry |

The industry is converging on a layered model: well-known URIs for discovery, OAuth DCR for autonomous credential acquisition, platform workload identities for the bootstrapping layer, and short-lived tokens for all runtime access. The remaining gap — standardized revocation propagation across federated registries — is the next active area of protocol development.

---

*Sources:*
- [Introducing ANS: DNS-Inspired Secure Discovery for AI Agents — InfoQ](https://www.infoq.com/news/2025/06/secure-agent-discovery-ans/)
- [Agent Name Service (ANS) — arxiv.org](https://arxiv.org/html/2505.10609v1)
- [Agent Discovery — A2A Protocol](https://a2a-protocol.org/latest/topics/agent-discovery/)
- [Announcing the Agent2Agent Protocol (A2A) — Google Developers Blog](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)
- [MCP and OAuth Dynamic Client Registration — Stytch](https://stytch.com/blog/mcp-oauth-dynamic-client-registration/)
- [RFC 7591 — OAuth 2.0 Dynamic Client Registration Protocol](https://datatracker.ietf.org/doc/html/rfc7591)
- [SEP: .well-known/mcp Discovery Endpoint — modelcontextprotocol/modelcontextprotocol #1960](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1960)
- [MoltID — OAuth-Style Identity Verification for Autonomous Agents](https://dev.to/moltid/moltid-oauth-style-identity-verification-for-autonomous-agents-2lni)
- [From BotFather to Hello World — Telegram Core](https://core.telegram.org/bots/tutorial)
- [How To Get Slack Token for Bot API — Suptask](https://www.suptask.com/blog/get-slack-token-for-bot-api)
- [Beyond DNS: NANDA Index and AgentFacts — MIT Media Lab](https://www.media.mit.edu/publications/beyond-dns-unlocking-the-internet-of-ai-agents-via-the-nanda-index-and-verified-agentfacts/)
- [Cloudflare Private Rate Limiting — Anonymous Credentials](https://blog.cloudflare.com/private-rate-limiting/)
