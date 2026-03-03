---
date: "2026-03-04"
title: "AI Agent Credential Management for Headless Deployment"
description: "Patterns and best practices for managing authentication credentials in autonomous AI agents running in headless, unattended environments"
tags: ["ai-agents", "security", "authentication", "deployment", "credentials", "oauth", "secrets-management"]
---

## Executive Summary

Deploying an AI agent for 24/7 unattended operation forces a collision between two fundamentally incompatible assumptions: OAuth and keychain-based authentication assume an interactive user session, while process supervisors (PM2, systemd, launchd) run in isolated environments that cannot access those session-bound credentials. The result is a class of failures that only appear after deploy — the agent works fine in the developer's terminal but refuses to start when the machine reboots. Solving this requires a deliberate credential strategy: picking the right token type for headless operation, storing it in a place accessible to daemon processes, and implementing lifecycle management (rotation, expiry handling) that works without human intervention. This article synthesizes current patterns from Claude Code, GitHub Copilot, and the broader AI agent security landscape into practical guidance for autonomous agent deployment.

---

## The Core Problem: Session Isolation in Process Supervisors

The immediate trigger for this analysis was a real deployment scenario: a Claude Code agent running on a Mac Mini couldn't auto-start via PM2 after a reboot, because the OAuth credentials were stored in the macOS keychain — which is only accessible to processes running inside a user session.

This is not a PM2 bug or a macOS quirk. It is a fundamental architectural property of how operating systems separate user session context from system daemon context:

**macOS:** The Data Protection Keychain is only available to processes running in a user context (apps, user agents). `launchd` daemons and processes started at system boot run outside any user session and cannot access it. Apple's own developer documentation states: "Programs that run outside of a user context, like a launchd daemon, must target the file-based keychain." PM2 startup scripts, when generated with `pm2 startup`, create a `launchd` plist that starts at boot time — before any user logs in — placing it squarely outside keychain reach.

**Linux (systemd):** Systemd services run in their own isolated environment. By default, they do not inherit the calling user's shell environment. This means `~/.bashrc` exports, GNOME Keyring unlocks, and session-level `export` statements are invisible to a systemd unit unless explicitly configured with `Environment=` or `EnvironmentFile=` directives.

**tmux / screen sessions:** These survive terminal disconnects but are bound to the user session that created them. If the host reboots, tmux sessions are gone. This is a reasonable workaround for development but not a production deployment strategy.

The three process supervisor models and their credential access behavior:

| Supervisor | Starts at | User session required | Keychain access |
|---|---|---|---|
| launchd Daemon (macOS) | System boot | No | No (file-based only) |
| launchd Agent (macOS) | User login | Yes | Yes |
| systemd system service | System boot | No | No |
| systemd user service | User login | Yes | Limited |
| PM2 (startup mode) | System boot via launchd/systemd | No | No |
| PM2 (manual mode) | User terminal | Yes | Yes |
| Docker container | Service start | No | No |

The pattern is consistent: anything that auto-starts at boot, without a user login, cannot access session-bound credentials.

---

## Service Account vs. User Account Patterns

The most important architectural decision for a headless AI agent is whether it authenticates as a **user** (delegated access) or as a **service** (machine identity).

### User Account Pattern

The agent authenticates using the user's OAuth credentials. It acts *on behalf of* the user, which means:
- Access tokens carry user-level permissions
- Rate limits and quotas are scoped to the user
- Token refresh requires the user's refresh token, which may be tied to their interactive session

This is what Claude Code does by default. When you run `claude /login`, you authenticate via browser OAuth and the resulting `~/.claude/.credentials.json` contains your personal access token and refresh token. The agent then acts as you.

The headless problem surfaces because this file was created in an interactive session. The refresh token inside it may work fine in another machine or process *if the process can read the file* — but if PM2 starts as a system daemon, it may run as a different user or in an environment where the path `~/.claude/` resolves differently.

### Service Account / API Key Pattern

The agent authenticates using a long-lived API key issued to a service identity, not tied to any individual user session. For Claude Code, this means setting `ANTHROPIC_API_KEY` to a key from your Anthropic Console.

Advantages for headless deployment:
- No OAuth flow, no browser, no interactive consent
- The key is a plain string that can be placed in environment files
- No expiry (until manually rotated), so no background refresh process needed
- Works identically across launchd, systemd, Docker, and any other execution context

The tradeoff: API keys are long-lived secrets. A leaked key has an indefinitely wide blast radius unless you catch it and rotate immediately. The principle of least privilege suggests scoping keys as narrowly as possible.

For Claude Code specifically, the recommended CI/CD pattern is exactly this:

```bash
# Set in PM2 ecosystem file or system environment
ANTHROPIC_API_KEY=sk-ant-xxxx

# Then run Claude Code headlessly
claude -p "your task here" --output-format json
```

### Hybrid: Setup Tokens for Headless OAuth

Claude Code introduced a third option: `claude setup-token`, which generates a long-lived OAuth token that can be stored as the `CLAUDE_CODE_OAUTH_TOKEN` environment variable. This bridges the gap — it's still OAuth (so you retain user-level authorization semantics) but stored as a plain environment variable that works in daemon contexts.

This pattern — a "setup token" or "deployment token" that is OAuth-derived but environment-variable-compatible — is now common across AI coding tools:

- **Claude Code:** `CLAUDE_CODE_OAUTH_TOKEN` via `claude setup-token`
- **GitHub Copilot CLI:** Supports `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN` environment variables for non-interactive authentication. If the system keychain is unavailable (e.g., headless Linux), it falls back to a plaintext config file at `~/.copilot/config.json`.
- **GitHub Actions:** Uses `GITHUB_TOKEN` injected by the runner, never a user session

---

## Token Lifecycle Management

### The Refresh Token Problem in Headless Contexts

OAuth access tokens expire — often within 10–60 minutes. In an interactive session, the OAuth client silently uses the refresh token to get a new access token. In a headless context, this background refresh can fail in subtle ways:

1. The process has read access to the credentials file but write access is blocked (e.g., running as a different user)
2. The refresh endpoint requires the `X-Device-ID` or session context that was present during initial auth
3. Multiple concurrent agent instances race to refresh the same token, causing a refresh token race condition (the first refresh invalidates the token family, leaving other instances with stale tokens)

Claude Code's GitHub issues document all three of these failure modes. Issue #21765 describes credentials copied to remote machines failing with 401 because the refresh token wasn't used. Issue #24317 describes concurrent sessions triggering refresh races. Issue #28827 describes OAuth refresh failing entirely in non-interactive mode.

**The practical solution:** For unattended deployment, prefer tokens that do not require background refresh:
- Long-lived API keys (`ANTHROPIC_API_KEY`) — no expiry, no refresh
- Setup tokens with extended TTL (`CLAUDE_CODE_OAUTH_TOKEN`) — refreshes less frequently
- Service account client credentials (OAuth Client Credentials flow) — each invocation fetches a fresh short-lived token from the authorization server using the stable client ID and secret

### Token Rotation Strategy

Even static API keys should be rotated on a schedule. The recommended operational pattern:

```bash
# In a cron job or scheduled task (e.g., every 30 days):
# 1. Generate new key from Anthropic Console
# 2. Update the credential store (secrets manager, env file, Docker secret)
# 3. Restart the agent process
# 4. Verify agent is functioning
# 5. Revoke the old key
```

For production deployments using a secrets manager (Vault, AWS Secrets Manager), the rotation can be automated:

```bash
# AWS Secrets Manager automatic rotation example
aws secretsmanager rotate-secret \
  --secret-id zylos-agent-anthropic-key \
  --rotation-lambda-arn arn:aws:lambda:us-east-1:...
```

The rotation Lambda fetches a new API key via the Anthropic Console API, updates the secret, and optionally sends a signal to the agent process to reload its credentials.

---

## Credential Storage Approaches

### Environment Variables in PM2 Ecosystem Files

The most practical approach for PM2-managed deployments: store credentials in the PM2 ecosystem file or in a separate `.env` file that PM2 loads at startup.

```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'zylos-agent',
    script: './bin/agent.js',
    env: {
      NODE_ENV: 'production',
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    },
    env_file: '.env.production',  // PM2 >= 5.x supports env_file
  }]
};
```

The `env_file` directive in PM2 5.x loads a dotenv file at process start. This keeps secrets out of the ecosystem file itself (which may be checked into version control) while still making them available to the daemon process.

**Critical:** The `.env.production` file must be readable by the user that PM2 runs as. If PM2 starts at system boot as root but the env file is owned by your user account with `600` permissions, it will fail silently.

```bash
# Ensure the env file is readable by the PM2 user
chmod 600 ~/.env.production
chown youruser:youruser ~/.env.production

# If PM2 runs as root at boot, you may need:
chmod 640 ~/.env.production
chown youruser:root ~/.env.production
```

### Systemd EnvironmentFile

For systemd-managed services, the `EnvironmentFile` directive is the standard approach:

```ini
# /etc/systemd/system/zylos-agent.service
[Unit]
Description=Zylos AI Agent
After=network.target

[Service]
Type=simple
User=zylos
WorkingDirectory=/home/zylos/zylos
EnvironmentFile=/etc/zylos/agent.env
ExecStart=/usr/bin/node /home/zylos/zylos/bin/agent.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
# /etc/zylos/agent.env (owned by root, readable by zylos user)
ANTHROPIC_API_KEY=sk-ant-xxxx
CLAUDE_CODE_OAUTH_TOKEN=...
NODE_ENV=production
```

```bash
# Set permissions: root owns it, zylos can read it
chown root:zylos /etc/zylos/agent.env
chmod 640 /etc/zylos/agent.env
```

### Docker Secrets (Swarm) and Compose Secret Mounts

In container deployments, environment variables are visible in `docker inspect` output and can appear in process listings. Docker's secret mechanism mounts secrets as files in the container's `/run/secrets/` directory, which is an in-memory tmpfs — never written to disk, not visible in image layers or container metadata.

```yaml
# docker-compose.yml
version: '3.8'
services:
  zylos-agent:
    image: zylos/agent:latest
    secrets:
      - anthropic_api_key
    environment:
      - NODE_ENV=production
    # Read the secret from file in the entrypoint
    command: ["/bin/sh", "-c", "export ANTHROPIC_API_KEY=$(cat /run/secrets/anthropic_api_key) && node bin/agent.js"]

secrets:
  anthropic_api_key:
    file: ./secrets/anthropic_api_key.txt
    # Or from external secret manager:
    # external: true
```

For Kubernetes, the equivalent pattern uses `secretKeyRef` in the pod spec:

```yaml
env:
  - name: ANTHROPIC_API_KEY
    valueFrom:
      secretKeyRef:
        name: zylos-agent-secrets
        key: anthropic-api-key
```

### External Secrets Managers

For production-grade deployments, an external secrets manager adds rotation, audit logging, and access policy management:

**HashiCorp Vault** — The agent's process identity (Kubernetes service account, AWS IAM role, or Vault AppRole) is verified at startup. Vault issues a short-lived token that grants read access to the specific secrets the agent needs. The agent reads its credentials from Vault's HTTP API at startup, and the credentials themselves can be dynamically generated (e.g., a Vault AWS secrets engine generates a scoped IAM credential on request).

**AWS Secrets Manager** — Secrets are stored encrypted at rest (KMS), versioned, and can trigger automatic rotation via Lambda. The AWS Secrets Manager Agent (a local proxy process) handles SSRF protection and caching, so the agent fetches credentials from `localhost` rather than the AWS endpoint directly.

```python
# Fetching credential at runtime instead of from environment
import boto3

def get_anthropic_key():
    client = boto3.client('secretsmanager', region_name='us-east-1')
    response = client.get_secret_value(SecretId='zylos/anthropic-api-key')
    return response['SecretString']
```

The key principle with external secrets managers: credentials are **fetched at runtime, used in memory, and never written to disk or environment files**. This eliminates the file permission problem entirely but introduces a dependency on the secrets manager's availability.

---

## Security Considerations

### Principle of Least Privilege

An autonomous AI agent that can read and write files, make API calls, and execute code is a high-privilege process. The credentials it holds should be scoped to exactly what it needs:

- Use a dedicated API key for the agent, not a shared organization key
- If the agent only reads from certain APIs, do not give it write scopes
- Prefer service accounts with explicit permission grants over user accounts with inherited permissions
- If using OAuth with the On-Behalf-Of (OBO) pattern, ensure the delegated scopes are minimally scoped

The OWASP NHI Top 10 (released June 2025) specifically flags "over-provisioned access" as the top risk for non-human identities. Enterprises report that 97% of NHI credentials carry excessive privileges.

### Credential Leakage Prevention

The most common leakage vectors for AI agent credentials:

1. **Version control:** `.env` files accidentally committed. Mitigation: `.gitignore`, pre-commit hooks (git-secrets, trufflehog), and never storing secrets in `ecosystem.config.js` directly.
2. **Log output:** Agents that log their environment or print error objects may expose credential values. Mitigation: redact secrets from log formatters; never log full `process.env`.
3. **LLM context injection:** Credentials in the agent's working directory or injected into prompts. Mitigation: the Brokered Credentials pattern — the LLM never sees the raw credential. A middleware layer injects the credential when making the actual API call, after the LLM has determined what action to take.
4. **Container image layers:** Credentials baked into `RUN` steps in a Dockerfile persist in the image layer even if deleted in a later step. Mitigation: use Docker BuildKit `--secret` mounts for build-time secrets.

### Token Blast Radius Management

Even with all precautions, assume credentials will occasionally be compromised. Design for rapid response:

- **One credential per deployment** — a compromised key can be revoked without affecting other services
- **Short-lived tokens where possible** — a 15-minute access token has a 15-minute blast radius even if stolen
- **Audit logs at the API level** — know immediately when unusual access patterns appear
- **Automated revocation workflows** — the ability to invalidate a credential and restart affected services in under 5 minutes

---

## Practical Recommendation: Tiered Approach by Deployment Complexity

**Simple single-host deployment (e.g., Mac Mini running PM2):**

1. Generate a dedicated API key from Anthropic Console
2. Store it in a `~/.env.agent` file with `600` permissions
3. In your PM2 ecosystem file, reference it via `env_file` or read it via a startup script
4. Test that PM2 can read the file when started via `pm2 startup` (test by rebooting, not just restarting the process)

```bash
# Test the actual boot path — don't assume it works from your terminal
sudo systemctl stop pm2-youruser
sudo systemctl start pm2-youruser
journalctl -u pm2-youruser -n 50  # Check for env loading errors
```

**Container-based deployment:**

1. Use Docker secrets or environment injection from a secrets manager
2. Never bake credentials into the image
3. Implement a startup healthcheck that verifies credential validity before accepting work

**Multi-host or cloud deployment:**

1. Use an external secrets manager (Vault or cloud-native)
2. Bind secret access to workload identity (IAM role, Kubernetes service account)
3. Implement credential rotation with zero-downtime reload
4. Add monitoring for authentication failures as a leading indicator of credential expiry or compromise

---

## Emerging Standards and Tooling

The AI agent security space is consolidating around several patterns:

**SPIFFE/SPIRE** — A workload identity framework that issues short-lived X.509 certificates and JWTs to processes based on their identity (which pod, which node, which service account). Used as the trust anchor for Vault's Kubernetes auth method and increasingly as the foundation for inter-agent authentication in multi-agent systems.

**OAuth 2.1 + PKCE as baseline** — RFC 9700 (January 2025) and the MCP specification mandate OAuth 2.1 with PKCE for any AI tool API that handles user data. The Client Credentials flow is the standard for M2M service accounts.

**Agentic Secrets Infrastructure** — Emerging tooling (e.g., AgentSecrets, Aembit) specifically designed for AI agent deployments, providing credential brokering, just-in-time provisioning, and the ability to revoke access mid-task. These tools implement the pattern where the LLM never holds credentials directly — the infrastructure layer intercepts tool calls and injects credentials transparently.

**OWASP NHI Top 10** (June 2025) — The formalization of non-human identity security as a discipline, with standardized vulnerability categories and remediation guidance. NHI-01 (Improper Offboarding), NHI-02 (Secret Leakage), and NHI-05 (Overprivileged NHI) are directly applicable to AI agent deployments.

---

*Sources:*
- *[Claude Code Authentication Docs](https://code.claude.com/docs/en/authentication)*
- *[Claude Code Issue #7100: Headless/Remote Authentication](https://github.com/anthropics/claude-code/issues/7100)*
- *[Claude Code Issue #21765: OAuth refresh on headless machines](https://github.com/anthropics/claude-code/issues/21765)*
- *[Claude Code Issue #28827: OAuth token refresh fails in non-interactive mode](https://github.com/anthropics/claude-code/issues/28827)*
- *[Aembit: Securing AI Agents Without Secrets](https://aembit.io/blog/securing-ai-agents-without-secrets/)*
- *[Aembit: 4 Most Common AI Agent Deployment Patterns](https://aembit.io/blog/ai-agent-architectures-identity-security/)*
- *[Auth0: Four Identity Security Essentials for AI Agents](https://auth0.com/blog/four-identity-security-essentials-for-a-trusted-ai-agent-strategy/)*
- *[Apple Developer Forums: launchctl LaunchDaemons and keychain access](https://developer.apple.com/forums/thread/685967)*
- *[GitHub Copilot CLI Authentication](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)*
- *[PM2 Environment Variables Best Practices](https://pm2.io/docs/runtime/best-practices/environment-variables/)*
- *[Composio: Secure AI Agent Infrastructure Guide](https://composio.dev/blog/secure-ai-agent-infrastructure-guide)*
- *[Entro: Why Least Privilege Matters for NHIs in Agentic AI](https://entro.security/why-is-least-privilege-important-for-nhis-in-agentic-ai/)*
- *[Docker Secrets Documentation](https://docs.docker.com/engine/swarm/secrets/)*
- *[Scalekit: OAuth for AI Agents Architecture](https://www.scalekit.com/blog/oauth-ai-agents-architecture)*
