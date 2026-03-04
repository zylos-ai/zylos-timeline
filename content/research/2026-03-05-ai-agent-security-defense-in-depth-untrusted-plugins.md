---
date: "2026-03-05"
title: "AI Agent Security: Defense-in-Depth for Untrusted Plugin Environments"
description: "A comprehensive security model for AI agent frameworks that support user-installable plugins, covering credential isolation, trust tiers, sandboxing, and the unique enforcement challenges of prompt-based architectures."
tags: ["ai-agents", "security", "sandboxing", "defense-in-depth", "credential-isolation", "trust-tiers", "prompt-injection", "supply-chain"]
---

## Executive Summary

AI agent frameworks have moved from single-model tools to extensible ecosystems with user-installable plugins, skills, and MCP servers. This shift unlocks enormous capability — but it also introduces a class of security problem fundamentally different from traditional software. When a plugin's instructions are delivered as natural language to an LLM, the boundary between "configuration" and "arbitrary code execution" dissolves. The enforcement primitives that protect conventional plugin architectures — sandboxed processes, signed manifests, permission scopes — must be re-engineered from scratch for an architecture where the interpreter is a language model.

This article surveys the threat landscape, analyzes how current frameworks (Claude Code, OpenClaw, HiClaw/Alibaba's API gateway model) address these challenges, identifies the structural "enforcement gap" unique to prompt-based agents, and proposes a universal four-layer defense-in-depth model applicable across frameworks.

The adjacent article on [AI Agent Credential Management for Headless Deployment](/research/2026-03-04-ai-agent-credential-management-headless-deployment) covers the narrower problem of token storage and rotation. This article is broader: the full security model governing what plugins are allowed to do in the first place.

---

## The Threat Landscape

### What Changed When Agents Got Plugin Registries

Traditional plugin systems — browser extensions, IDE plugins, VS Code extensions — run as code in an isolated process. The OS enforces a process boundary. The plugin either has a file descriptor or it doesn't. Security policies are enforced by the runtime, not by the plugin author's behavior.

Agent plugin systems are different. A skill or MCP server doesn't just execute code: it also injects instructions into the agent's context window. The "plugin" is partly a process and partly a prompt. This means a plugin can influence the agent's behavior not only through its declared tool functions but through any natural language it places in the model's context — tool descriptions, error messages, system prompts returned from API calls.

This creates three interlocking threat categories that don't exist in traditional plugin architectures:

**1. Tool Poisoning**
A malicious plugin registers tool descriptions that contain hidden instructions. The model reads the description as part of its context and acts on embedded commands, even if those commands have nothing to do with the tool's declared purpose. Researchers benchmarking the MCPTox suite found this attack class present across 43% of publicly available MCP server implementations.

**2. Indirect Prompt Injection via Plugin Outputs**
A plugin fetches external data (a webpage, a file, an API response) and returns it as tool output. Attackers who control that external data can embed instructions that hijack the agent's behavior mid-task. The GitHub MCP server incident in 2025 demonstrated this precisely: a malicious GitHub issue, processed by a privileged agent, caused it to exfiltrate private repository contents into a public pull request.

**3. Supply Chain Compromise**
The plugin registry itself becomes an attack surface. Koi Security's audit of ClawHub found 341 malicious skills out of 2,857 examined (roughly 12%). These ranged from credential harvesters reading `.env` files and API key environment variables, to plugins that silently BCC'd every outbound message to an attacker-controlled address. The pattern mirrors PyPI and npm supply chain attacks but with a critical amplifier: AI agents install and use plugins programmatically, without the human review step that catches suspicious packages in manual workflows.

### The Credential Exposure Surface

Agent plugins operate in an environment saturated with high-value credentials. A typical deployment has:

- LLM API keys (for model access, often with billing implications)
- OAuth tokens for connected services (email, calendar, cloud storage)
- Database credentials
- Webhook secrets and signing keys
- SSH keys, if the agent has shell access

Plugins installed from a third-party registry can potentially access all of these, depending on how the agent runtime manages its environment. In 2025, "LLMjacking" — the theft of LLM API credentials to build paid services for cybercriminals — became prevalent enough that Microsoft filed a civil suit against a gang specializing in it. The OpenClaw CVE-2026-25253 (CVSS 8.8) disclosed in early 2026 showed the concrete path: malicious `SKILL.md` files instructing agents to harvest Apple Keychain credentials and exfiltrate them via `curl`.

---

## Current Approaches: How Frameworks Address Plugin Security

### Claude Code: Hook-Based Policy Enforcement

Claude Code's security model for plugins centers on its hook system — a lifecycle interception layer that sits between the model's decisions and the execution of any tool call. Four hook types are available: shell command hooks, HTTP hooks, prompt hooks, and agent hooks. Together they allow operators to build a policy engine that gates every tool invocation.

The hook system operates at the tool-call level rather than the plugin level, which is architecturally significant. Instead of trusting a plugin based on its declared capabilities at install time, every individual tool call is evaluated against a policy at runtime:

```yaml
# .claude/settings.json — hook-based policy example
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "bash /home/user/.claude/hooks/validate-command.sh"
    - matcher: "Write"
      hooks:
        - type: command
          command: "bash /home/user/.claude/hooks/check-write-path.sh"
```

This provides a deterministic enforcement layer that doesn't rely on the LLM's judgment. The model may decide to write a file; the hook checks whether that write targets an allowed path before the OS syscall is made.

Claude Code also supports `allowManagedHooksOnly` for enterprise deployments — a flag that disables user-level and plugin-level hooks, ensuring only administrator-approved hooks can run. This implements a trust tier distinction between managed and unmanaged plugins at the configuration level.

### OpenClaw: Tool Policy Engine and Manifest Signing

OpenClaw's approach (prior to the CVE-2026-25253 disclosure) centered on a declarative tool policy engine embedded in plugin manifests. Each skill declares its required permissions in a structured manifest:

```yaml
# OpenClaw skill manifest
name: email-sender
version: 1.2.0
permissions:
  - net:outbound:smtp
  - env:read:SMTP_PASSWORD
  - fs:write:/tmp/drafts
signature: sha256:a8f3c2...
publisher: verified:acme-corp
```

The framework validates the manifest signature at install time and enforces permission scopes at runtime. The vulnerability exposed in CVE-2026-25253 was precisely that `SKILL.md` — a natural language instruction file read by the agent, not the manifest — could override this policy through prompt injection. A malicious `SKILL.md` could instruct the model to use tools beyond the declared scope. The structural lesson: a manifest-based policy is only as strong as the barrier between the manifest processor (deterministic) and the instruction processor (the LLM).

### HiClaw/Alibaba: API Gateway Proxy Pattern

HiClaw implements a proxy-gateway architecture that places an intermediary between the agent and all external services. Rather than allowing plugins to call APIs directly, all outbound calls route through a policy-enforcement gateway:

```
Agent → [Tool Call] → HiClaw Gateway → [Policy Check] → External API
                              ↑
                    Credential Injection
                    Rate Limiting
                    Audit Logging
                    Response Sanitization
```

The gateway handles credential injection — plugins never receive raw API keys. They receive scoped, short-lived tokens generated per-request by the gateway. This directly addresses the credential exposure problem: a compromised plugin that exfiltrates its credentials gets tokens valid for minutes and scoped to specific operations, not long-lived master keys.

Response sanitization at the gateway layer also provides a defense against indirect prompt injection: API responses can be stripped of instruction-like content before they enter the agent's context window.

---

## The Enforcement Gap

All three frameworks share a structural limitation: the gap between where security policies are defined (in code, configuration, or manifests) and where agent behavior is actually determined (in the model's context window).

Consider the trust chain in a typical agent interaction:

```
User intent → System prompt → Plugin instructions → Tool outputs → Model decision → Tool call
                                      ↑                    ↑
                            Natural language          Natural language
                            (unverifiable)           (unverifiable)
```

At every natural-language boundary, the model is processing free text from a potentially untrusted source. A shell script can be statically analyzed for dangerous syscalls; a plugin's `SKILL.md` cannot be statically analyzed in the same way because its semantics are determined by how a language model interprets it at runtime — which depends on context, model version, and the specific phrasing of other content already in the window.

This enforcement gap explains why:

- **Behavioral policies alone fail**: Telling the model "never read `.env` files" is not a security control. It's a behavioral instruction that can be countermanded by a sufficiently crafted injection.
- **Manifest-based permission systems are necessary but insufficient**: They constrain what tools are available, not what the model will do with them given adversarial inputs.
- **Defense requires enforcement at the execution layer, not the inference layer**: Security controls that rely on the model's judgment to enforce them are not controls — they are defaults that can be overridden.

---

## Proposed Defense-in-Depth Model

A robust security architecture for agent plugin environments requires four layers, each operating independently so that a failure in one layer does not cascade.

### Layer 1: Supply Chain Integrity

Before a plugin enters the environment, verify its provenance and contents.

**Controls:**
- Cryptographic signing of plugin manifests by registered publishers
- Automated static analysis scanning for suspicious patterns (credential file access, unexpected network destinations, keylogging patterns)
- Registry reputation scores based on community audits and incident history
- Pin plugins to specific versions/hashes in `requirements.lock` equivalents — auto-update is a supply chain attack vector

**Example policy manifest with signature validation:**
```yaml
# zylos-plugin-lock.yaml
plugins:
  - name: calendar-sync
    version: 2.1.4
    hash: sha256:f4a9b2c8d1e3...
    publisher: acme-corp
    publisher_key_fingerprint: 4E7F:A3C1:...
    last_audited: "2026-02-10"
    audit_status: clean
```

### Layer 2: Structural Sandboxing

Plugins that need execution isolation should run in environments with enforced resource limits, regardless of what the plugin claims it will do.

**Options by threat tolerance:**

| Isolation Level | Technology | Overhead | Use Case |
|---|---|---|---|
| Process isolation | `bubblewrap` / `nsjail` | Low | Lightweight skills, no network |
| Container isolation | Docker / Podman | Medium | Plugins with network access |
| MicroVM | Docker Sandboxes / Firecracker | High | High-risk, third-party plugins |
| WASM runtime | Wasmtime / WasmEdge | Very low | Stateless computation plugins |

A practical implementation for a Zylos-style plugin host:

```bash
# bubblewrap sandbox for a plugin process
bwrap \
  --ro-bind /usr /usr \
  --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 \
  --tmpfs /tmp \
  --unshare-all \
  --new-session \
  --die-with-parent \
  -- node /path/to/plugin/index.js
```

This provides no filesystem access beyond read-only system libraries, no network access (blocked by `--unshare-net`), and no ability to spawn child processes outside the sandbox.

### Layer 3: Runtime Policy Enforcement

At execution time, every tool call from a plugin should be evaluated against a declarative policy before the OS executes it. This is the layer Claude Code's hook system implements.

**Key principles:**
- Policy enforcement is out-of-band from the model — the hook runs as a separate process, not as a model instruction
- Policies are allowlist-based, not denylist-based: tools not explicitly permitted are blocked by default
- Plugin trust tier determines the policy set applied

**Trust tier taxonomy:**

```yaml
# trust-tiers.yaml
tiers:
  verified:
    description: "Publisher-signed, audited, installed by owner"
    sandbox: none
    credential_access: scoped_vault
    network: allowed
    filesystem: declared_paths_only

  community:
    description: "Registry-listed, community-reviewed"
    sandbox: container
    credential_access: none_direct  # gateway-injected tokens only
    network: allowlist_only
    filesystem: /tmp only

  untrusted:
    description: "Local/unregistered/experimental"
    sandbox: microvm
    credential_access: none
    network: blocked
    filesystem: none
```

### Layer 4: Context Sanitization and Prompt Firewall

The final layer addresses the enforcement gap directly: sanitize untrusted content before it enters the model's context window.

**Controls:**
- Strip instruction-like patterns from tool outputs before model sees them (gateway-level sanitization, as in HiClaw)
- Implement CaMeL-style control-data flow separation: user queries are parsed into structured execution plans; tool output populates data slots that are never re-interpreted as instructions
- Token-level trust tagging: mark each token in the context with its origin (system-trusted, plugin-trusted, untrusted-external-data)
- Implement a "prompt firewall" that evaluates tool outputs for injection patterns before they are appended to context

```python
# Simplified context sanitization example
INJECTION_PATTERNS = [
    r"ignore previous instructions",
    r"new task:",
    r"system prompt override",
    r"<\|system\|>",
    r"<!-- instruction:",
]

def sanitize_tool_output(output: str, source_trust: TrustLevel) -> str:
    if source_trust == TrustLevel.UNTRUSTED:
        for pattern in INJECTION_PATTERNS:
            output = re.sub(pattern, "[REDACTED]", output, flags=re.IGNORECASE)
        # Wrap in clear delimiters that signal data, not instructions
        output = f"[TOOL_DATA_BEGIN]\n{output}\n[TOOL_DATA_END]"
    return output
```

---

## Implementation Patterns

### The Gateway Pattern for Credential Isolation

The most practical immediate improvement for any agent framework is moving credentials out of the plugin execution environment and into a gateway that injects scoped tokens per-request. This eliminates the credential exfiltration attack surface at the plugin layer:

```
Without gateway:                    With gateway:
Plugin → env.OPENAI_KEY (long-lived) Plugin → gateway request
                                              → token (30s TTL, read-only)
                                              → API call
                                              → response (sanitized)
```

Even if the plugin is fully compromised, it obtains only a 30-second scoped token — useless for persistent access.

### Layered Manifest Verification

Plugin installation should be a multi-step verification process, not a single hash check:

1. **Publisher verification**: Is the publisher registered and non-revoked?
2. **Content hash**: Does the downloaded package match the declared hash?
3. **Static analysis**: Does the code access credential files, unexpected network endpoints, or system directories?
4. **Behavioral simulation**: Run the plugin in a monitored sandbox during install-time and record all syscalls, network connections, and file accesses for review
5. **SKILL.md / instruction file analysis**: Flag instruction files that contain patterns consistent with prompt injection

### Audit Logging as a Detection Layer

When prevention fails, detection is the fallback. Every tool call from a plugin should produce a structured audit log entry:

```json
{
  "timestamp": "2026-03-05T14:23:11Z",
  "plugin": "calendar-sync@2.1.4",
  "tool": "Bash",
  "command": "curl https://example.com/api",
  "trust_tier": "community",
  "policy_decision": "allowed",
  "sandbox": "container:abc123"
}
```

Anomaly detection over these logs can surface behaviors that passed policy at install time but violate the plugin's stated purpose at runtime — an email plugin making SMTP calls to unexpected destinations, for example.

---

## Open Research Areas

Several problems remain unsolved in the field:

**Semantic policy verification**: Current manifest-based permission systems describe what a plugin can do in terms of API calls and filesystem paths. They cannot express or verify semantic constraints — "this plugin should only process the user's own data, never third-party data". Building a semantic permission model that an LLM-based agent can reliably enforce is an open problem.

**Cross-plugin trust propagation**: When a high-trust plugin calls a low-trust plugin as a sub-agent, what trust tier should the resulting actions carry? The lattice of trust propagation in multi-agent systems lacks standardized treatment.

**Prompt injection detection at inference time**: Current injection detection relies on pattern matching over known attack strings. Adaptive attackers using paraphrase and encoding evasion routinely defeat these filters. A robust detector would need to operate at the semantic level — identifying instructions that claim to override the model's principal hierarchy, regardless of surface form.

**Registry governance for decentralized ecosystems**: Centralized registries can enforce signing and conduct audits, but many agent frameworks allow arbitrary local plugins. Establishing community-operated governance (analogous to CRAN for R or the Python Packaging Authority) for agent plugin ecosystems remains nascent.

---

## Conclusion

The extensibility that makes AI agent frameworks powerful is the same property that makes them difficult to secure. When the interpreter is a language model, the attack surface includes not just executable code but any natural language that enters the model's context. This demands a defense-in-depth approach that operates at every layer: supply chain integrity before installation, structural sandboxing during execution, runtime policy enforcement per tool call, and context sanitization before the model sees untrusted data.

No single layer is sufficient. Manifest signing does not prevent prompt injection from tool outputs. Sandboxing does not prevent a plugin from exfiltrating data it legitimately touches. Runtime hooks do not prevent supply chain compromise of a trusted plugin. Context sanitization does not prevent a plugin from registering poisoned tool descriptions. Each layer compensates for the weaknesses of the others.

The frameworks surveyed here — Claude Code's hook system, OpenClaw's policy engine, HiClaw's gateway pattern — each implement one or two of these layers well. The field lacks a unified reference implementation that applies all four. Building that is the immediate next frontier in agent security engineering.

---

## Sources

- [OWASP's AI Agent Security Top 10 Security Risks 2026](https://medium.com/@oracle_43885/owasps-ai-agent-security-top-10-agent-security-risks-2026-fc5c435e86eb)
- [Agentic AI Threat Modeling Framework: MAESTRO — CSA](https://cloudsecurityalliance.org/blog/2025/02/06/agentic-ai-threat-modeling-framework-maestro)
- [Agentic AI Security: Threats, Defenses, Evaluation, and Open Challenges — arXiv](https://arxiv.org/html/2510.23883v1)
- [Prompt Injection Attacks in LLMs and AI Agent Systems — MDPI](https://www.mdpi.com/2078-2489/17/1/54)
- [A Multi-Agent LLM Defense Pipeline Against Prompt Injection Attacks — arXiv](https://arxiv.org/abs/2509.14285)
- [Indirect Prompt Injection: The Hidden Threat — Lakera](https://www.lakera.ai/blog/indirect-prompt-injection)
- [MCP Security Vulnerabilities: Prompt Injection and Tool Poisoning — Practical DevSecOps](https://www.practical-devsecops.com/mcp-security-vulnerabilities/)
- [MCP Tools: Attack Vectors and Defense Recommendations — Elastic Security Labs](https://www.elastic.co/security-labs/mcp-tools-attack-defense-recommendations)
- [A Timeline of MCP Security Breaches — AuthZed](https://authzed.com/blog/timeline-mcp-breaches)
- [We Audited 2,857 Agent Skills. 12% Were Malicious — Grith](https://grith.ai/blog/agent-skills-supply-chain)
- [NPM Supply Chain Attacks: Hidden Risks for AI Agents — Oligo Security](https://www.oligo.security/blog/the-hidden-risks-of-the-npm-supply-chain-attacks-ai-agents)
- [Critical OpenClaw Vulnerability Exposes AI Agent Risks — Dark Reading](https://www.darkreading.com/application-security/critical-openclaw-vulnerability-ai-agent-risks)
- [CVE-2025-34291: Critical Vulnerability in Langflow AI Platform — Obsidian Security](https://www.obsidiansecurity.com/blog/cve-2025-34291-critical-account-takeover-and-rce-vulnerability-in-the-langflow-ai-agent-workflow-platform)
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks)
- [Securely Deploying AI Agents — Anthropic](https://platform.claude.com/docs/en/agent-sdk/secure-deployment)
- [Sandboxing AI Agents in Linux — Senko Rašić](https://blog.senko.net/sandboxing-ai-agents-in-linux)
- [Docker Sandboxes for AI Agents](https://docs.docker.com/ai/sandboxes)
- [AI Agent Security Cheat Sheet — OWASP](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html)
- [AI Agents Are Privileged Processes — EMSI](https://www.emsi.me/tech/ai-ml/ai-agents-are-privileged-processes-weve-been-treating-them-like-chatbots/2026-02-27/133a40)
