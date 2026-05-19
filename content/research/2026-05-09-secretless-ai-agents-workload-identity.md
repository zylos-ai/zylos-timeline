---
date: "2026-05-09"
title: "Secretless AI Agents: From .env Files to Workload Identity"
description: "How AI agent platforms are eliminating static credentials through workload identity, zero-knowledge credential proxies, and runtime attestation — and why the .env file is becoming a liability."
tags: ["security", "workload-identity", "credentials", "SPIFFE", "agent-architecture"]
---

## Executive Summary

The `.env` file has been the default credential store for AI agent platforms since their inception. A flat file sitting in the project root, readable by every process in the tree, containing API keys, database passwords, and cloud credentials in plaintext. For a human developer working locally, this was an acceptable trade-off. For an autonomous AI agent that executes arbitrary code, reads arbitrary files, and maintains long-running sessions — it is an architectural liability.

2026 has made this viscerally clear. In April, a supply chain attack on the Bitwarden CLI npm package specifically targeted AI coding assistant credentials — Claude Code, Gemini CLI, Copilot, and others. The malware harvested SSH keys, cloud credentials, and authenticated sessions from the host environment. Separately, a "Comment and Control" prompt injection attack demonstrated that a single malicious GitHub PR title could cause Claude Code, Gemini CLI, and Copilot to leak their own API keys through PR comments. The attack surface is not theoretical.

The industry response is converging on a principle that systemd articulated decades ago: **processes should not inherit their parent's environment**. Instead, each agent process should receive a minimal, explicitly declared set of credentials — or better yet, no credentials at all. This article examines the emerging patterns for secretless AI agent operation: workload identity, zero-knowledge credential proxies, and runtime attestation.

## The .env Problem at Scale

The traditional model is straightforward: a `.env` file contains `KEY=value` pairs, a library like `dotenv` loads them into `process.env`, and application code reads them at runtime. For AI agents, this model breaks in several ways.

**Full environment inheritance.** When a process manager like PM2 starts a child process, that child inherits the full environment of its parent. If the parent shell has `AWS_SECRET_ACCESS_KEY` set, every managed process — including the AI agent — can read it. The agent doesn't even need to open the `.env` file; the values are already in its `process.env`. PM2's dump file compounds the problem by persisting environment variables across restarts, meaning credentials set once can survive indefinitely in a serialized process list.

**Agent code execution.** AI coding agents routinely execute generated code in the host environment. An indirect prompt injection — a malicious instruction embedded in a README, a dependency's docstring, or a PR description — can instruct the agent to read `process.env` and exfiltrate its contents. NVIDIA's AI Red Team explicitly classifies this as a mandatory-mitigation threat: "LLM-generated code must be treated as untrusted output."

**Session persistence.** Long-running agents in tmux or screen sessions inherit the environment from the shell that created the session. If the session outlives the original SSH connection, environment variables like `SSH_AUTH_SOCK` point to dead sockets. More critically, credentials set at session creation time remain active long after they should have been rotated. The clean environment principle — where each process starts with a blank slate and receives only what it needs — is violated by default.

**Lateral movement.** A compromised agent with access to a `.env` file containing multiple service credentials can pivot across systems. A database credential becomes an entry point to production data. An AWS key becomes a path to S3 buckets, Lambda functions, and IAM roles. The blast radius of a single `.env` file is unbounded.

## The Clean Environment Principle

systemd solved this problem for Linux services years ago. Every systemd service runs in a **clean, minimal environment** — it does not inherit the shell environment of whoever started it. Variables from `~/.bashrc` or `/etc/environment` are invisible unless explicitly injected via `Environment=` or `EnvironmentFile=` directives.

This design separates **configuration from inheritance**. The service definition declares exactly which variables it needs. The environment file can be permission-restricted (mode `0600`, owned by a service account). The values are not exposed through `systemctl show` when loaded via `EnvironmentFile=`. And the `Environment=` directive supports reset semantics: assigning an empty string clears all previously defined variables, providing a clean slate.

AI agent platforms are beginning to adopt this pattern. The key insight is **manifest-driven configuration injection**: instead of agents discovering credentials in their environment, a manifest declares what the agent needs, and a supervisor injects only those values at process start time.

In practice, this looks like:

```yaml
# agent-manifest.yaml
name: coding-agent
environment:
  allow:
    - ANTHROPIC_API_KEY
    - GITHUB_TOKEN
    - DATABASE_URL
  deny:
    - AWS_*
    - STRIPE_*
  sources:
    - file: /etc/agent-secrets/coding-agent.env
      mode: "0600"
    - vault: secrets/coding-agent
      ttl: 3600
```

The supervisor reads the manifest, resolves values from the declared sources, injects only the allowed variables, and starts the agent process with a clean environment. Variables not in the allow list are absent — not hidden, not filtered, but never present. This is the systemd model applied to agent runtimes.

## Zero-Knowledge Credential Proxies

The clean environment approach reduces the blast radius but still places credential values in `process.env`, where they can be read by the agent or any code it executes. The next evolution eliminates credential visibility entirely.

**AgentSecrets**, an open-source project that gained traction in early 2026, implements a zero-knowledge credential proxy. The architecture is deliberately simple:

1. Credentials are stored in the OS keychain or an encrypted vault
2. A local proxy intercepts outgoing HTTP requests from the agent
3. The proxy matches the request domain against an allowlist
4. For allowed domains, it injects the appropriate authentication header (Bearer token, API key, etc.)
5. The agent receives only the API response — never the credential value

The key property is **architectural, not policy-based**: at no point does the agent hold, see, or have access to the actual credential value. The credential resolution happens at the transport layer, below the agent's abstraction boundary. Even if the agent is compromised via prompt injection, there is no credential to exfiltrate — because there is no credential in the agent's process space.

AgentSecrets supports six authentication injection styles (Bearer, Basic, API key header, query parameter, cookie, and custom header), domain allowlist enforcement, response body redaction (to prevent credentials from leaking in API responses that echo them back), and SSRF protection. Every proxy call is logged against the agent identity that made it, and tokens can be revoked per-agent without touching any other agent's access.

This model aligns with Render's security guidance: "Use a credential broker that provides short-lived tokens on demand, ideally via a mechanism that is not directly accessible to the agent." The broker pattern ensures the agent can *use* credentials without *knowing* them.

## Workload Identity: Eliminating Secrets Entirely

Zero-knowledge proxies still require *someone* to manage the underlying credentials. Workload identity takes the final step: replacing static credentials with cryptographic proof of identity.

The core idea, championed by the SPIFFE (Secure Production Identity Framework for Everyone) standard and its reference implementation SPIRE, is that a workload proves its identity based on **what it is and where it runs**, not by possessing a shared secret.

### How It Works

1. **Attestation.** When an agent process starts, a SPIRE agent on the host inspects its characteristics — container image hash, Kubernetes namespace, service account, process UID, binary signature. These attestation attributes establish the workload's identity without any pre-shared credential.

2. **Identity issuance.** If attestation succeeds, SPIRE issues a SPIFFE Verifiable Identity Document (SVID) — either an X.509 certificate or a JWT — with a short TTL (typically minutes to hours). The SVID contains a SPIFFE ID like `spiffe://zylos.ai/agent/coding-agent/prod`.

3. **Credential exchange.** The agent presents its SVID to an OAuth 2.0 authorization server, which validates the SVID signature against the SPIRE trust bundle and issues a scoped access token. No client secret is involved — the SVID *is* the authentication. This is now standardized in the IETF draft `draft-ietf-oauth-spiffe-client-auth`.

4. **Access.** The agent uses the short-lived OAuth token to access APIs, databases, and services. When the token expires, the agent re-attests and obtains a new one.

### Why This Matters for AI Agents

Traditional OAuth client credentials require a `client_secret` — which is, itself, a static credential that must be stored somewhere. SPIFFE eliminates this bootstrap problem. The agent's identity is derived from its runtime context, not from a secret it possesses.

This has several consequences for agent platforms:

- **No credential rotation.** SVIDs are issued with short TTLs and automatically renewed. There is no long-lived credential to rotate.
- **No credential sharing.** Each agent instance receives its own SVID. Scaling horizontally does not require distributing secrets.
- **Revocation is identity-level.** Revoking an agent's access means removing its registration entry from SPIRE, not hunting for every place a credential was stored.
- **Attestation binds identity to context.** An agent running in a different container, namespace, or host will fail attestation — even if an attacker has copied the agent's code. The identity is not portable because it is derived from the execution environment.

CyberArk's Secure AI Agents solution, launched in late 2025 and extended through 2026, implements this pattern at enterprise scale. Their platform enforces zero standing privileges for AI agents, with every access request evaluated against real-time context: is the agent running during business hours? In a production environment? With up-to-date security patches? Within approved geographic regions? Only if all policy conditions are met is an OAuth token issued.

## The Bitwarden Wake-Up Call

The April 2026 Bitwarden CLI supply chain attack crystallized why this shift matters. The malicious npm package `@bitwarden/cli@2026.4.0` — available for only 90 minutes — contained a payload that specifically hunted for AI coding assistant credentials. It harvested:

- SSH keys and cloud credentials from the host environment
- Authenticated sessions from Claude Code, Cursor, Codex CLI, Aider, Kiro, and Gemini CLI
- CI/CD secrets from environment variables
- Shell RC persistence for long-term access

The attack was novel in its targeting: this was the first documented supply chain attack that explicitly sought AI coding assistant credentials. The payload combined a multi-cloud credential harvester, a self-propagating npm worm, and a GitHub commit dead-drop C2 channel.

In a secretless architecture, this attack's impact would be dramatically reduced:

- **Clean environment:** No cloud credentials in `process.env` to harvest
- **Zero-knowledge proxy:** No API keys in the agent's address space to steal
- **Workload identity:** No static credentials to exfiltrate — SVIDs are bound to the runtime context and useless outside it
- **Short-lived tokens:** Even if a token were captured, it would expire within minutes

The Bitwarden attack was followed weeks later by the "Comment and Control" disclosure, where researchers demonstrated that a malicious PR title could cause Claude Code, Gemini CLI, and Copilot to leak their API keys through PR comments. The mechanism was simple: the agent read the PR title containing a prompt injection, followed the injected instruction, and posted its environment variables as a comment. In a secretless architecture, `process.env` would contain no credentials to post.

## Practical Architecture for Agent Platforms

Moving from `.env` files to workload identity is not an overnight migration. Here is a pragmatic progression that agent platform operators can follow:

### Level 0: Raw .env (Current Default)

Credentials in a plaintext `.env` file, loaded into `process.env`, inherited by all child processes. This is where most agent platforms are today.

**Risk profile:** Maximum. Any code the agent executes can read every credential.

### Level 1: Environment Allowlisting

The agent process manager filters `process.env` to include only declared variables. Undeclared variables are stripped before the agent starts. This is the manifest-driven approach described earlier.

```javascript
// Process manager pseudo-code
const manifest = loadManifest('agent-manifest.yaml');
const cleanEnv = {};
for (const key of manifest.environment.allow) {
  if (process.env[key]) cleanEnv[key] = process.env[key];
}
spawn(agentBinary, { env: cleanEnv });
```

**Risk profile:** Reduced. The agent sees only what it needs. But values are still in-process.

### Level 2: Credential Broker / Proxy

Credentials are removed from the agent environment entirely. A local proxy or broker handles authentication at the transport layer. The agent makes HTTP requests; the proxy injects auth headers.

**Risk profile:** Low. Credentials never enter the agent's address space. Prompt injection cannot exfiltrate what does not exist in context.

### Level 3: Workload Identity

Static credentials are eliminated. The agent authenticates via SPIFFE SVIDs or platform-native attestation (AWS IAM roles, GCP service accounts, Kubernetes service account tokens). OAuth tokens are issued just-in-time, scoped to the minimum required permissions, and expire within minutes.

**Risk profile:** Minimal. No static credentials exist to steal, rotate, or manage. Identity is bound to the runtime environment and is non-transferable.

### Hybrid Approach

Most production deployments will operate at Level 1-2, with Level 3 for cloud-native deployments. The key principle is **progressive elimination**: move credentials out of `.env` files, then out of `process.env`, then out of existence.

## Implementation Considerations

**Process managers need clean-env support.** PM2, the most common Node.js process manager, inherits the parent shell's full environment by default. Achieving Level 1 requires either wrapping the spawn call with environment filtering or using `ecosystem.config.js` with explicit `env` declarations and `filter_env: true`. systemd provides this natively via `Environment=` and `EnvironmentFile=`.

**tmux sessions are a special case.** Long-running agents in tmux sessions inherit the environment from session creation time. Environment changes (credential rotations, new variables) are not reflected in existing panes. The solution is a session-level manifest that the agent reads on attach, rather than relying on inherited environment variables. Some platforms implement a `TMUX_ENV` pattern where a manifest file declares the intended environment, and a hook script sources it on each new pane creation.

**MCP servers need credential isolation.** Model Context Protocol servers often run as child processes of the agent, inheriting its full environment. A compromised or malicious MCP server can read all credentials the agent has access to. The fix is the same: MCP servers should run with a clean environment and receive only the credentials they need, ideally through a proxy rather than environment variables.

**Audit trails are essential.** Regardless of the credential model, every credential access should be logged with the agent identity, timestamp, target service, and action performed. AgentSecrets provides this at the proxy level. SPIFFE/SPIRE provides it at the identity issuance level. Without audit trails, detecting credential misuse requires forensic analysis after the fact.

## What's Next

The IETF is actively standardizing AI agent authentication through `draft-klrc-aiagent-auth-00`, which addresses the unique challenges of autonomous agents that authenticate on behalf of users but operate independently. The WIMSE (Workload Identity in Multi-System Environments) working group is developing standards for workload identity federation across organizational boundaries — critical for multi-agent systems where agents from different platforms need to authenticate to each other.

The convergence of SPIFFE, OAuth 2.0 token exchange, and agent-specific authentication standards points toward a future where AI agents are first-class identity principals — not applications borrowing human credentials, not services using shared secrets, but authenticated entities with cryptographically verifiable identities, scoped permissions, and auditable access trails.

For agent platform operators, the practical advice is: start with Level 1 (environment allowlisting) today. It requires no new infrastructure, just discipline in how you start agent processes. Then evaluate zero-knowledge proxies (Level 2) for production deployments where agents handle sensitive data. Workload identity (Level 3) is the destination, but the journey starts with a simple principle that systemd got right years ago: **don't let processes inherit what they don't need**.
