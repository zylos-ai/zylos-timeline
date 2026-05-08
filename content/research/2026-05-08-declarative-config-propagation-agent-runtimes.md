---
date: "2026-05-08"
title: "Declarative Configuration Propagation in AI Agent Runtimes"
description: "Manifest patterns for solving the nested process environment variable problem in AI agent deployments"
tags:
  - research
  - ai
  - devops
  - agents
  - configuration
---

## Executive Summary

AI agents deployed in production commonly run inside layered process boundaries: a process supervisor like PM2 launches a terminal multiplexer like tmux, which in turn runs the agent CLI. Environment variables set in an outer shell — whether `.bashrc` exports or OpenTelemetry OTEL variables in a monitoring config — frequently fail to reach the innermost process. The result is silent misconfiguration: telemetry goes dark, model endpoints point nowhere, API keys are absent.

The industry already has proven solutions to this exact class of problem, developed through container orchestration and service management. The key insight is **declarative indirection**: instead of hardcoding a list of variable names or relying on ambient shell inheritance, a single manifest key declares *which* variables should be forwarded. This shifts configuration from implicit inheritance to explicit contract.

This article surveys how existing tools — Docker, Kubernetes, systemd, PM2, tmux — handle the env propagation problem, how AI agent frameworks currently fall short, and what a principled manifest pattern looks like for agent runtimes.

---

## The Propagation Problem in Practice

Consider a typical agent deployment on Linux:

```
PM2 (process supervisor)
  └── ecosystem.config.js defines service
        └── tmux new-session (launches terminal)
              └── claude --model sonnet (agent CLI)
```

When PM2 starts, it inherits the shell environment of whatever user ran `pm2 start`. But tmux sessions are notoriously environment-agnostic: a session created by PM2 inherits PM2's environment at creation time, and that snapshot is frozen. Any variables set in `~/.bashrc`, exported after session creation, or injected by subsequent `export` commands in an interactive shell are invisible inside the tmux pane.

The practical consequences are significant:

- **OTel variables** (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`) configured in a shell profile never reach the agent process — telemetry pipelines silently produce no data
- **Model overrides** (`ANTHROPIC_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`) set in the environment are not propagated to spawned subagents within agent frameworks — a known open issue in Claude Code
- **API endpoint overrides** configured for staging environments are ignored when the process tree is launched by a supervisor that pre-dates the export

tmux's `update-environment` configuration option (`set-option -g update-environment "DISPLAY SSH_AUTH_SOCK"`) exists precisely to address this, but it only helps when *reattaching* to sessions and only propagates variables already named in the list — back to the enumeration problem.

---

## How Existing Systems Solve It

### The 12-Factor App: Env Vars as the Universal Plane

The [Twelve-Factor App methodology](https://12factor.net/config) established the canonical principle: configuration that varies between deployments belongs in environment variables, never in code. Factor III states that env vars are "easy to change between deploys without changing any code" and are "a language- and OS-agnostic standard."

The methodology's key contribution to the propagation discussion is its insistence on *orthogonality*: each env var is fully independent, never grouped into named "environments" hardcoded in the app. You don't check `if ENV == "production"` — you read `DATABASE_URL` directly. This prevents the enumeration trap where a list of variable names must be maintained in two places.

But 12-factor assumes the variables *arrive* in the process environment. It does not specify how to get them there across process boundaries — that gap is where container orchestrators stepped in.

### Docker: The `--env-file` Manifest

Docker's `--env-file` flag accepts a file of `KEY=VALUE` pairs and injects them into the container's environment at startup:

```bash
docker run --env-file ./agent.env my-agent-image
```

The `agent.env` file is the manifest. It is version-controlled, reviewed, and treated as a first-class artifact separate from the image. Docker Compose extends this further: a service definition can specify `env_file: [.env, agent-specific.env]`, establishing a layered, declarative contract for what environment the process receives.

Critically, this pattern separates *declaration* (which variables exist and what their values are) from *injection* (when and how they reach the process). The runtime reads the manifest at launch time rather than relying on the ambient shell state.

### Kubernetes: ConfigMaps, Secrets, and `envFrom`

Kubernetes solves the same problem at cluster scale. A ConfigMap is a named object that stores key-value configuration data decoupled from the Pod definition:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: agent-telemetry-config
data:
  OTEL_SERVICE_NAME: "my-agent"
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4318"
```

The Pod manifest then *references* the ConfigMap rather than enumerating values inline:

```yaml
envFrom:
  - configMapRef:
      name: agent-telemetry-config
```

The `envFrom` pattern is the key: it injects *all* keys from the referenced ConfigMap as environment variables without listing each one. This is indirection over enumeration. Secrets follow the same pattern but with additional access controls and encryption at rest.

For agent runtimes, the lesson is structural: the manifest (ConfigMap/Secret) is the single source of truth, the Pod spec is a pointer to it, and the runtime resolves the indirection at pod start. Updating the ConfigMap and restarting the pod automatically propagates changes without touching the pod definition.

### systemd: `EnvironmentFile`

systemd's approach to the same problem predates containers. A service unit can specify:

```ini
[Service]
EnvironmentFile=/etc/agent/otel.env
EnvironmentFile=-/etc/agent/local-overrides.env
```

The `-` prefix on the second line means "ignore errors if the file does not exist" — a useful affordance for optional local overrides. systemd reads these files at service start and injects all defined variables into the process execution context.

The critical insight from systemd: **every service runs in a clean, minimal environment**. It does not inherit the shell environment of whoever started it. Variables set in `~/.bashrc` or `/etc/environment` are *not* automatically available. This is a feature, not a bug — it forces explicit, auditable configuration.

PM2's ecosystem file follows a similar philosophy. The `env` object within `ecosystem.config.js` is PM2's version of `EnvironmentFile`:

```javascript
module.exports = {
  apps: [{
    name: 'my-agent',
    script: 'agent.js',
    env: {
      NODE_ENV: 'production',
      OTEL_SERVICE_NAME: 'my-agent'
    },
    env_production: {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.prod.example.com'
    }
  }]
}
```

However, PM2's env injection does not reach processes launched *inside* PM2-managed processes (like a tmux session spawned by the app). The manifest pattern ends at the PM2 boundary.

### OpenTelemetry: Env Vars as a Context Propagation Protocol

OTel's [environment variable specification](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/) is an instructive example of a *domain-specific env var schema*. The spec defines a fixed namespace (`OTEL_*`) and uses a single file mechanism (`OTEL_CONFIG_FILE`) as a manifest pointer: if set, the file is parsed and all SDK components are configured from it, while all other `OTEL_*` environment variables are ignored.

This is the indirection principle applied precisely: `OTEL_CONFIG_FILE` is a pointer variable. Its value is not the configuration — it is the *address* of the configuration. This pattern composes cleanly: you can set one variable in the outer environment to unlock an entire configuration namespace, without enumerating every individual variable in the launch command.

---

## How Agent Frameworks Currently Handle This

### LangChain / LangGraph

LangChain relies almost entirely on ambient shell environment inheritance. The canonical pattern in documentation is:

```python
import os
def _set_env(var: str):
    if not os.environ.get(var):
        os.environ[var] = getpass.getpass(f"{var}: ")
```

This is interactive fallback, not declarative configuration. LangChain reads from `os.environ` at call time — whatever was in the environment when the process started. There is no manifest mechanism, no `envFrom` equivalent, no configuration pointer. If the outer shell did not export the right variables before the process tree was constructed, there is no remedy short of code changes.

LangGraph adds persistence and streaming to multi-agent workflows but does not address the env propagation layer — it inherits LangChain's implicit ambient approach.

### CrewAI and AutoGen

Both frameworks follow the same pattern: read from environment at instantiation, provide no mechanism for cross-boundary propagation. AutoGen's enterprise-oriented features (sandboxing, identity integration) address *access control* but not *configuration delivery*.

AutoGen's 2025 API changes broke compatibility with 20% of legacy code partly because configuration assumptions embedded in agent definitions were fragile. A manifest-based approach would have allowed configuration to be versioned independently of code.

### Claude Code (Anthropic)

Claude Code reads environment variables at startup via a settings hierarchy: shell environment, then `settings.json` `env` object, then command-line flags. But there are documented propagation failures: `ANTHROPIC_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`, and OTel variables are not propagated to agent teammates spawned via tmux. The `--model` flag for spawned subagents is resolved from an internal lookup table rather than the environment — a hardcoded enumeration rather than a propagated contract.

This is the exact failure mode the manifest pattern prevents.

### OpenAI Agents SDK

The OpenAI Agents SDK introduced sandbox environments for agents, where a `Manifest` object describes the starting state of a fresh sandbox:

```python
sandbox = Sandbox(
    manifest=Manifest(
        environment={"OTEL_SERVICE_NAME": "my-agent", "LOG_LEVEL": "info"},
        repos=[...],
    )
)
```

This is the closest current analogue to a proper manifest pattern in an agent framework. The `Manifest.environment` field is a declarative dict that the runtime injects at sandbox start, independent of the outer shell. It is not a pointer (no indirection to a file), but it establishes the right contract boundary.

---

## The Manifest Pattern: Design Principles

Drawing from the above survey, a well-designed configuration propagation manifest for agent runtimes should follow these principles:

### 1. Indirection Over Enumeration

Use a pointer variable rather than listing each forwarded variable at the launch site. Instead of:

```bash
claude --env OTEL_SERVICE_NAME=x --env OTEL_ENDPOINT=y --env LOG_LEVEL=z ...
```

Use a single pointer:

```bash
AGENT_ENV_MANIFEST=/etc/agent/env.yaml claude ...
```

The runtime resolves the manifest at startup. Adding a new variable requires updating the manifest file, not the launch command.

### 2. The Manifest Is the Source of Truth

The manifest file (YAML, TOML, or simple `KEY=VALUE`) is version-controlled and reviewed. It is not derived from the shell state — it is an explicit contract. This makes configuration auditable and reproducible regardless of which user or shell launched the process.

```yaml
# agent-env.yaml
forward:
  - OTEL_SERVICE_NAME
  - OTEL_EXPORTER_OTLP_ENDPOINT
  - ANTHROPIC_MODEL
  - LOG_LEVEL

inject:
  OTEL_SERVICE_NAME: "zylos-agent"
  LOG_LEVEL: "info"
```

The `forward` list names variables inherited from the outer environment (resolved at runtime). The `inject` block provides defaults that take effect when the forwarded variable is absent.

### 3. Clean Execution Environment by Default

Following systemd's model, agent processes should start with a minimal environment, not the full ambient shell. Configuration arrives exclusively through the manifest. This eliminates the class of bugs caused by "it worked on my laptop" — environment pollution from interactive sessions.

### 4. Secrets Never in cmdline or Logs

A process's command-line arguments are world-readable via `/proc/<pid>/cmdline` on Linux. Secrets passed as `--env SECRET=value` are exposed to any process on the machine. The manifest pattern resolves this: secrets are referenced by name in the manifest, resolved from a secrets manager or file with restricted permissions (`chmod 600`), and injected into the process environment without appearing in cmdline.

```yaml
secrets:
  ANTHROPIC_API_KEY:
    from_file: /run/secrets/anthropic-api-key
  DATABASE_URL:
    from_env: DATABASE_URL_SECRET  # resolved from secrets manager
```

### 5. Layered Override Precedence

Following Docker Compose's multi-file pattern and systemd's multiple `EnvironmentFile` directives, manifests should support layered overrides with clear precedence:

```
base.env          ← shared defaults (checked in)
environment.env   ← deployment-specific (per environment)
local.env         ← developer overrides (gitignored)
```

Later layers win. This matches the 12-factor principle of orthogonal, independently managed variables while supporting the practical need for local development overrides.

---

## What Agent Runtimes Should Adopt

The gap between current agent framework practice and established infrastructure patterns is significant. Container orchestration solved this problem definitively a decade ago; agent runtimes are repeating early mistakes.

**Short-term improvements:**

- PM2 ecosystem files should support an `env_file` directive analogous to Docker Compose, reading from a file path rather than only inline objects
- tmux session launchers should explicitly pass a curated env set using `-e KEY=VALUE` flags sourced from a manifest file rather than relying on inherited shell state
- Agent CLIs should support a `--env-file` flag (like Docker) or `--env-manifest` pointer that is authoritative over ambient shell env

**Medium-term patterns:**

Agent frameworks should adopt a `Manifest` abstraction similar to the OpenAI Agents SDK sandbox approach, where configuration delivery is a first-class runtime concern rather than a documentation note about setting env vars before launching. The manifest should be resolvable from a file path (enabling the pointer pattern) and support both direct values and secret references.

**Long-term direction:**

As agent runtimes mature into platforms (with supervisor daemons, multi-agent coordination, and long-running sessions), they will encounter the same operational problems that drove container orchestration design. The investment in ConfigMap/Secret/EnvironmentFile patterns by the infrastructure community represents hard-won operational knowledge. Agent runtime designers should study these patterns rather than rediscovering them.

---

## Conclusion

The env propagation problem in AI agent runtimes is not new or unique. It is a well-studied problem in process supervision and container orchestration, solved by the manifest pattern: a declarative, version-controlled contract that specifies which configuration variables a process receives, resolved by the runtime at startup rather than inherited from the ambient shell.

The core design principle is indirection over enumeration: a single pointer variable (`--env-file`, `OTEL_CONFIG_FILE`, `EnvironmentFile=`) unlocks a configuration namespace without requiring the launch command to enumerate each variable. This is more maintainable, more auditable, and more secure than relying on shell inheritance.

Current AI agent frameworks — LangChain, CrewAI, AutoGen, Claude Code — largely rely on ambient shell inheritance and suffer predictable failures when deployed through process supervisors like PM2 that create isolated environments. The OpenAI Agents SDK's `Manifest.environment` is a step toward the right abstraction.

The 12-factor app principle remains sound: configuration belongs in the environment. The missing piece for agent runtimes is a principled mechanism for delivering that configuration reliably across nested process boundaries — a manifest with clear ownership, explicit forwarding declarations, secret indirection, and layered override support.

---

*Sources:*
- [The Twelve-Factor App — Config](https://12factor.net/config)
- [Kubernetes ConfigMaps](https://kubernetes.io/docs/concepts/configuration/configmap/)
- [Docker: Best practices for environment variables](https://docs.docker.com/compose/how-tos/environment-variables/best-practices/)
- [systemd.exec — EnvironmentFile](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
- [PM2 — Environment Variables](https://pm2.keymetrics.io/docs/usage/environment/)
- [OpenTelemetry Environment Variable Specification](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/)
- [OpenTelemetry Environment Variables as Context Propagation Carriers](https://opentelemetry.io/docs/specs/otel/context/env-carriers/)
- [tmux: Forwarding environment variables with new-session](https://github.com/orgs/tmux/discussions/3659)
- [Claude Code CLI Environment Variables](https://gist.github.com/mculp/e6a573f2a45ef7dbbf30f6a8574c7351)
- [Claude Code Issue #32987 — Agent teammates ignore model environment variables](https://github.com/anthropics/claude-code/issues/32987)
- [OpenAI API — Sandbox Agents](https://developers.openai.com/api/docs/guides/agents/sandboxes)
- [AWS Copilot CLI — Manifest Environment Variables](https://aws.github.io/copilot-cli/docs/developing/manifest-env-var/)
- [Are environment variables still safe for secrets in 2026?](https://www.doppler.com/blog/environment-variable-secrets-2026)
- [How to Handle Secrets on the Command Line](https://smallstep.com/blog/command-line-secrets/)
- [12 Factor App meets Kubernetes](https://www.redhat.com/en/blog/12-factor-app-containers)
