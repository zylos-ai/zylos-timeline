---
date: "2026-06-13"
title: "Remote Tool Execution and Cloud Sandbox Platforms for AI Agents"
description: "How AI agent tool execution is moving off the local box into cloud-hosted isolated runtimes — platform landscape (E2B, Daytona, Modal, Cloudflare, hyperscalers), MCP remote execution patterns, principal propagation, and policy enforcement architectures."
tags: ["ai-agents", "cloud-sandboxes", "remote-execution", "mcp", "identity", "security", "infrastructure"]
---

## Executive Summary

- **The market solidified in 2025-2026 around three isolation primitives**: Firecracker microVMs (E2B, Daytona, some Runloop), gVisor syscall interception (Modal, Google GKE Agent Sandbox), and V8 isolates (Cloudflare Dynamic Workers for ephemeral short-lived tasks). No single approach dominates; the choice turns on threat model, latency budget, and whether GPU access is required.
- **Startup latency is the central engineering problem**: Cold starts range from sub-90ms (Daytona pre-provisioned pools), ~150ms (E2B Firecracker), ~200ms (Kata/microVM), to 1-3 seconds for Docker-based approaches. Across an agentic workflow of 15 sequential tool calls, a 2-second cold start per call adds 30 seconds of pure waiting; sub-100ms brings that to under 2 seconds. Snapshot/resume technology (Cloudflare, Morph, E2B beta) reduces warm-start to 5-30ms.
- **Principal propagation has no consensus standard yet**: The state of the art is RFC 8693 (OAuth Token Exchange) for carrying end-user identity into tool calls via short-lived, audience-scoped JWTs. SPIFFE/SPIRE provides workload identity but does not naturally handle the per-agent-instance granularity that auditable agentic systems require. Uber's production implementation is the most complete public reference.
- **The MCP authorization spec matured significantly**: The March 2025 spec established OAuth 2.1 as the foundation; June 2025 classified MCP servers as OAuth Resource Servers and mandated RFC 9728 Protected Resource Metadata; Streamable HTTP transport replaced SSE. The 2026 roadmap targets stateless horizontal scaling and cookie-like session tokens decoupled from transport connections.
- **Policy enforcement is converging on a three-layer model**: (1) client-side pre-authorization checks before the tool call is issued; (2) gateway-layer enforcement (Docker MCP Gateway, AWS AgentCore Gateway, Cloudflare's egress proxy) as the centralized enforcement point; (3) in-sandbox resource limits as a last-resort backstop. The gateway layer provides the best combination of coverage and debuggability.
- **The hyperscalers entered the space at scale in late 2025/early 2026**: AWS Bedrock AgentCore (8-hour execution windows, deterministic policy enforcement outside the LLM loop), Google GKE Agent Sandbox (gVisor, 300 sandboxes/second, GA at Google Next '26), and Cloudflare Sandboxes GA (April 2026) all shipped production-grade offerings. This commoditizes the infrastructure layer and shifts competitive differentiation to developer experience and identity/policy integration.
- **Real-world adoption reveals a consistent pattern**: Devin/Cognition, OpenHands Cloud, and Cursor background agents all run agent tool execution inside dedicated cloud VMs (not local), with the agent reasoning loop remaining separate from the execution sandbox. This "agent-outside, tools-inside" separation of concerns is increasingly recognized as the correct long-term architecture.
- **For a self-hosted autonomous agent system**, the local-execution default remains defensible only when data gravity (files, credentials, private network) makes remote execution operationally expensive. The critical risk is not the sandbox overhead itself but the absence of principal propagation and policy enforcement that local execution encourages — both become mandatory the moment a second user or agent operates in the same system.

## Platform Landscape

### Comparison Table

| Platform | Isolation Tech | Cold Start | Statefulness | Agent Connection | GPU | Pricing Model | Notable Capability |
|---|---|---|---|---|---|---|---|
| **E2B** | Firecracker microVM | ~150ms | Ephemeral (24h Pro); snapshot beta | Python/JS SDK, REST | No | ~$0.05/vCPU-hr, usage-based | Open-source; AI-native SDK; versioned templates |
| **Daytona** | Container + pooled VMs | Sub-90ms | Ephemeral (default 15 min, configurable) | Python/TS SDK | No | ~$19/user/mo team tier | Pre-provisioned pools eliminate cold start |
| **Modal** | gVisor containers | Sub-second (mem snapshots) | Up to 24h; filesystem snapshots | Python SDK, REST | Yes (H100/A100/L40S/T4) | Usage-based, per-second | GPU access; LLM-defined environments at runtime |
| **Morph Cloud** | VM (Infinibranch) | ~250ms branch/restore | Snapshot + branch (VM clone in under 250ms) | Python SDK, CLI | Not public | Contact sales / self-hosted | VM branching for parallel exploration |
| **Runloop** | Custom bare-metal hypervisor | 100ms exec (custom) | Blueprints + Snapshots | SDK, REST | Enterprise | Enterprise | 2x faster vCPUs; Blueprints for env standardization |
| **Cloudflare Sandboxes** | Container-based (GA April 2026) + V8 isolates (Dynamic Workers) | 2s full; V8 isolates ~ms | Persistent (auto-sleep + R2 snapshot) | Workers SDK, Agents SDK | No | Active CPU pricing (no idle charges) | Edge distribution; egress proxy for credential injection; PTY over WebSocket |
| **OpenHands Runtime** | Docker containers (pluggable: Daytona, K8s) | Docker: 2-5s; Daytona: sub-90ms | Agent event log persisted; workspace ephemeral | REST API (agent loop drives runtime) | No | Open-source (Cloud: managed) | Pluggable runtime backends; full event log; production SDK |
| **AWS Bedrock AgentCore** | Serverless containers (managed) | Not published | 8-hour sessions | Bedrock SDK, A2A protocol | Via Bedrock | Enterprise/consumption | Deterministic policy enforcement outside LLM loop; 8h execution window |
| **Google GKE Agent Sandbox** | gVisor + Pod Snapshots | Sub-second (300/sec allocation) | Pod snapshots for resume | Kubernetes API, Agent Substrate OSS | Via GKE GPU nodes | GKE pricing + ~30% Axion savings | 300 sandboxes/sec; open-source Agent Substrate |

### Platform Analysis

**E2B** is the most widely adopted dedicated sandbox for AI coding agents in 2025-2026 due to its open-source posture, clean SDK, and Firecracker's strong isolation story. The ~$0.05/vCPU-hour pricing is competitive for moderate workloads, but at 200 concurrent sandboxes the monthly cost approaches $17K, which is substantially higher than multi-tenant alternatives. E2B's main limitation for stateful multi-step workflows is its ephemeral-by-default model; the auto-pause beta addresses this but remains in preview as of mid-2026. The absence of GPU support limits applicability to code execution and browser automation rather than inference workloads.

**Daytona** made the most aggressive pivot in this space, rebuilding from developer environment tooling to agent-native infrastructure in early 2025. Its sub-90ms cold starts come from pre-provisioned VM pools rather than from a faster isolation primitive — an architectural choice that trades cloud resource efficiency for latency predictability. The Docker-to-Daytona migration case study is instructive: for an agent making 15 sequential tool calls, the 2-second Docker cold start per call versus Daytona's sub-90ms translates to 30+ seconds of overhead reduction per task. The tradeoff is that self-hosted control and custom runtime configuration are more complex than running a local Docker daemon.

**Modal** targets a different axis: enterprises that need both code execution sandboxes and ML inference on the same platform, or that need GPU access inside the sandbox (for example, running a vision model as part of an agent tool call). gVisor's syscall interception provides weaker isolation guarantees than Firecracker at the kernel level, but Modal's memory snapshotting and optimized filesystem make warm starts competitive. The ability for LLMs to define their own execution environments at runtime (rather than relying on pre-built templates) suits research and exploratory agent workflows where environment requirements are not known ahead of time.

**Morph Cloud's** "Infinibranch" VM branching capability occupies a niche not served by any other platform: the ability to snapshot a running VM state and fork it into multiple parallel instances in under 250ms. This is architecturally significant for agents that need to explore multiple solution paths simultaneously (tree-of-thought execution, A/B testing code changes) without reinstalling dependencies or losing execution context. The contact-sales pricing model and Python-only SDK limit immediate adoption, but the underlying capability is technically unique.

**Runloop** positions on enterprise reliability rather than raw latency. Its custom bare-metal hypervisor delivers 2x faster vCPUs than commodity cloud VMs, and the Blueprints + Snapshots model for environment standardization maps well to enterprise use cases where consistent, auditable environments matter more than flexibility. The $7M seed round (July 2025) is modest relative to E2B or Morph, indicating a focused enterprise sales motion rather than a broad developer platform play.

**Cloudflare's** two-tier architecture (V8 isolates via Dynamic Workers for ephemeral short-lived code execution; container-based Sandboxes for persistent full-OS workloads) is the most architecturally complete edge offering. The programmable egress proxy for credential injection — where the sandbox never holds raw credentials but the proxy swaps in real keys at the network layer — is the most production-ready secrets management pattern among the dedicated sandbox platforms. The active CPU pricing model (no charges during LLM thinking time) is well-aligned with agentic workflows where the sandbox is mostly idle waiting for model responses.

**Google GKE Agent Sandbox** and **AWS Bedrock AgentCore** represent the hyperscaler response. Google's 300-sandboxes/second allocation rate and open-source Agent Substrate project indicate infrastructure depth that dedicated sandbox vendors cannot match at equivalent cost, but the Kubernetes operational complexity is a real barrier for teams not already running on GKE. AWS AgentCore's deterministic policy enforcement outside the LLM reasoning loop — a direct response to the failure mode where agents are instructed to reason around their own constraints — is architecturally notable and distinguishes it from prompt-based guardrail approaches.

## MCP Remote Execution Patterns

### Transport Evolution

The MCP specification's transport layer underwent a major revision with the March 2025 release, which replaced the original HTTP+SSE transport with Streamable HTTP. The previous design required persistent SSE connections for server-to-client messages, making it incompatible with standard load balancers, proxies, and horizontal scaling patterns. Streamable HTTP uses a single HTTP endpoint that can return either a direct response or an SSE stream on the same connection, enabling stateless deployments behind standard CDN/proxy infrastructure.

As of mid-2026, the Transport Working Group is finalizing stateless session management via a cookie-like mechanism that decouples session state from the underlying HTTP connection. This is critical for production deployments: the current stateful session model requires sticky routing, which prevents effective auto-scaling and creates single points of failure.

### Remote MCP Server Patterns

Three patterns have emerged for deploying MCP servers remotely:

**1. Gateway aggregation (Docker MCP Gateway pattern)**: A gateway process runs on the agent host and manages multiple MCP server processes in isolated containers. The agent speaks stdio to the gateway; the gateway multiplexes requests to the appropriate server containers. This keeps the agent-to-gateway link local and low-latency while providing isolation between servers. Docker's open-source implementation adds interceptors (secret scanning, signature verification, call logging) at the gateway layer without requiring any MCP server modification.

**2. Cloud-hosted endpoints (Cloudflare Workers/McpAgent pattern)**: MCP servers run as stateful Durable Objects on Cloudflare's edge network. Each agent session maps to a specific Durable Object instance, providing per-session state without shared mutable state. Authentication uses OAuth 2.1 with the workers-oauth-provider library, enabling third-party identity providers (GitHub, Google, Auth0). The agent connects via Streamable HTTP over HTTPS from anywhere on the internet. This pattern eliminates the local server management burden but introduces ~50-100ms round-trip latency per tool call from most locations.

**3. Code execution via MCP (Anthropic's November 2025 pattern)**: Rather than exposing tools as direct function calls in the model context, MCP servers are presented as code APIs with documentation on a virtual filesystem. The agent discovers tools by reading these files, then writes code to invoke them in a local execution environment. This approach reduced token usage from ~150,000 to ~2,000 in benchmark tasks (98.7% reduction) by keeping intermediate data in the execution environment rather than the model context. PII tokenization is implemented at the MCP client layer, so sensitive data (email addresses, phone numbers) flows between systems without entering the model's context window. The tradeoff is operational complexity: a sandboxed code execution environment must be provisioned, secured, and monitored alongside the MCP infrastructure.

### MCP Gateways as Policy Enforcement Points

MCP gateways — whether self-hosted (Docker) or cloud-based — are emerging as the natural enforcement point for multi-server deployments. A gateway provides:

- A single point for authentication token validation across all servers
- Request/response inspection and filtering (secret blocking, PII redaction)
- Tool-level allowlisting (expose only specific tools from each server)
- Audit logging across all tool invocations
- Transport normalization (convert stdio to HTTP and vice versa)

AWS Bedrock AgentCore Gateway extends this pattern with natural language policies executed outside the LLM reasoning loop, meaning policy decisions are deterministic system operations rather than LLM-generated safety outputs. This addresses a known failure mode: sufficiently capable models can sometimes be instructed to reason around prompt-based guardrails; deterministic gateway-level enforcement cannot be reasoned around.

## Identity and Principal Propagation

### The Problem

When an agent executes a tool in a remote sandbox, two identity questions must be answered:

1. **Workload identity**: Is this process authorized to connect to the sandbox at all? (Authentication of the agent process itself)
2. **Principal identity**: On whose behalf is this action being taken? (The human or upstream system that initiated the workflow)

Most current deployments solve problem 1 (via API keys or mTLS) and ignore problem 2. This creates an audit gap: the sandbox logs show that "the agent" took an action, but not which user's request triggered it.

### RFC 8693 Token Exchange: The Current State of the Art

The WorkOS "intersection rule" formalization provides the clearest production pattern:

1. Each agent has its own OAuth client ID, distinct from any user account
2. When a user initiates a workflow, the orchestrator exchanges the user's session token for a new token via RFC 8693, encoding three things: user identity (as `sub`), agent identity (as `act`), and target service (as `aud`)
3. The effective permission set is the strict intersection of (a) what the agent's role allows and (b) what the user's current permissions allow
4. Tokens are short-lived (minutes), single-hop (one specific audience), and re-issued per task rather than cached

Uber's production implementation demonstrates this at enterprise scale: P99 latency for the Security Token Service token exchange is below 40ms, and the full actor chain (user → agent 1 → agent 2 → MCP gateway) is embedded in each JWT. Authorization policies at the gateway evaluate both the personnel identity and the agent identity simultaneously, enabling context-aware access control before tool execution. All steps are logged into an OTEL-compatible system for compliance and SIEM integration.

### SPIFFE/SPIRE: Workload Identity with Agent Caveats

SPIFFE provides cryptographically verifiable workload identity (SVIDs/X.509 certificates) that is well-suited to the authentication problem in service meshes. Its application to AI agents surfaces a fundamental mismatch: SPIFFE's standard Kubernetes implementation issues identical identities to all replicas of a deployment. AI agent instances are non-deterministic and context-driven — two instances of the same agent image will behave differently based on their individual conversation histories and tool call results. For compliance purposes, auditors need to know which specific agent instance took which action, not just which deployment it came from.

The correct SPIFFE extension for agentic systems is per-instance identity URIs:

```
spiffe://acme.com/ns/prod/sa/coding-agent/instance/7f4a2b1c
```

rather than the deployment-level:

```
spiffe://acme.com/ns/prod/sa/coding-agent
```

This requires rethinking how authorization policies work, as fine-grained per-instance identities cannot be statically enumerated in policy documents. The AIP (Agent Identity Protocol) paper proposes a structured approach for verifiable delegation across MCP and A2A boundaries, but as of mid-2026 this remains academic rather than deployed infrastructure.

### Open Problems

**Delegation depth**: RFC 8693 handles two-level delegation (user → agent) cleanly. Chains longer than three hops (user → orchestrator → sub-agent → tool server) become cumbersome because each hop requires a token exchange, and the JWT grows with each embedded actor claim.

**Cross-organization identity**: When an agent in organization A needs to call a tool in organization B, there is no standardized way to propagate the end-user's identity across the organizational boundary without federation agreements. Current practice is to use organization B's service account for the agent, which breaks attribution.

**Real-time permission revocation**: When a user's permissions change mid-workflow (role demotion, access revocation), short-lived tokens propagate the change only after the current token expires. The WorkOS intersection rule mitigates this by evaluating user permissions at each tool call, but this requires the authorization server to be in the hot path of every tool invocation.

## Policy Enforcement Architectures

### Three-Layer Model

**Layer 1 — Client-side pre-authorization (agent harness)**: Before issuing a tool call, the agent harness checks a local policy manifest specifying which tools are permitted for the current context. This is the approach Claude Code uses with its `settings.json` permission allowlist. Advantages: zero network latency, works offline, immediate feedback to the model. Limitations: can be bypassed if the agent process is compromised, does not scale across multiple agents sharing the same tools, requires policy synchronization per agent deployment.

**Layer 2 — Gateway enforcement (the primary enforcement point)**: All tool calls route through a gateway that validates identity, evaluates authorization policy, and produces an audit record before forwarding to the tool server. The Docker MCP Gateway, AWS AgentCore Gateway, Uber's MCP Gateway, and Cloudflare's edge layer all implement this pattern. This is the architecturally correct location for shared policy: it is out of the agent's control, covers all tool servers uniformly, and provides a centralized audit stream. The cost is latency (one additional network hop per tool call) and the gateway becoming a critical availability dependency.

**Layer 3 — In-sandbox resource limits (backstop)**: CPU limits, memory quotas, filesystem scoping, network egress filters, and execution timeouts enforced by the hypervisor or container runtime. This layer cannot be bypassed even if the agent process is fully compromised. It does not implement business logic (who can do what) but prevents runaway resource consumption and limits blast radius. Cloudflare's egress proxy for credential injection is the most sophisticated production implementation of this layer: credentials never exist inside the sandbox; they are swapped in at the network boundary by an external proxy that the agent cannot query directly.

### Secrets Management: Vault-Sidecar vs. Proxy Injection

Two patterns have emerged for getting credentials into sandboxes without baking them into container images or environment variables:

**HashiCorp Vault sidecar injection**: A Vault Agent container runs alongside the execution container and renders secrets to a shared memory volume. The main container consumes secrets from the filesystem without direct Vault awareness. Secrets are dynamic (short-lived, auto-rotated), user-attributed (the AI application requests credentials scoped to the requesting user's role), and never persisted to disk beyond the pod's lifetime. This pattern works well on Kubernetes but adds a sidecar to every sandbox pod, increasing startup time and resource overhead.

**Egress proxy credential injection (Cloudflare pattern)**: The sandbox holds only an opaque stub token (a non-secret placeholder). All outbound HTTP requests are routed through a programmable egress proxy. The proxy resolves the stub token to a real credential, injects the real Authorization header on the outbound request, and strips it from the inbound response. The agent never has access to the raw credential even in a memory dump. This is architecturally cleaner for ephemeral sandboxes where a Vault sidecar is heavyweight, but it requires all tool calls to be HTTP-based and the proxy to have per-host authentication logic.

## Trade-off Analysis

### When Cloud Execution Wins

- **Multi-user / multi-agent systems**: Once more than one user or agent shares the same system, local execution creates namespace collisions (filesystem paths, environment variables, port bindings) and makes attribution impossible without additional instrumentation. Cloud sandboxes provide first-class isolation between concurrent sessions.
- **Untrusted or LLM-generated code**: LLM-generated code must be treated as untrusted input. Running it on the agent host machine exposes credentials, private network access, and host filesystem to an adversarial execution model. Hardware-enforced isolation (Firecracker/microVM) is the minimum acceptable boundary for production deployments handling LLM-generated code.
- **Long-running background tasks**: Tasks that take minutes to hours (repository refactoring, CI pipeline execution, data processing) should not occupy the interactive agent session. Cloud VMs with 8-24 hour execution windows and snapshot/resume capabilities handle this workload class correctly; local Docker containers do not.
- **Compliance and audit requirements**: Gateway-enforced policy with centralized audit logging is difficult to implement reliably on local execution. Enterprise deployments requiring SOC 2 Type II or HIPAA compliance need the audit guarantees that a gateway layer provides.
- **Parallel exploration**: Morph Cloud's branching and the general snapshot/fork pattern enable agent architectures that run multiple solution paths simultaneously. This is architecturally impossible on a single local machine without heavy containerization overhead.

### When Local Execution Remains Correct

- **Data gravity**: When the agent's primary inputs and outputs are large local files (video editing, large codebases, local database state), the cost of syncing data to and from remote sandboxes exceeds the benefit of isolation. Local execution with a carefully scoped permission model remains a reasonable tradeoff.
- **Latency-sensitive interactive workflows**: Even the fastest cloud sandboxes add 50-250ms of network round-trip per tool call. For interactive sessions where the user expects sub-100ms response, local execution (Docker sidecar or in-process) remains superior. Edge distribution mitigates this for geographically distributed deployments but does not eliminate it.
- **Offline and degraded operation**: Self-hosted agents that must operate without internet connectivity (air-gapped environments, field deployments) cannot depend on cloud sandbox APIs. Local Docker or local microVM execution is the only option.
- **Simplicity and cost at small scale**: For a single-user, single-agent system executing trusted code, cloud sandbox API costs may exceed the value of the isolation guarantee. The cost advantage of cloud sandboxes only emerges when Docker startup overhead is material — which requires high tool call volume.
- **Private network tool access**: If an agent's tools require access to services on a private network (internal APIs, private databases), routing tool calls through a cloud sandbox requires either VPN integration, network peering, or outbound tunneling — all of which add operational complexity that can be avoided by running locally within the private network.

## Implications for Self-Hosted Autonomous Agent Systems

For a self-hosted autonomous AI agent system like Zylos — serving multiple users across multiple communication channels, executing tools (bash, file operations, browser) locally — the following implications apply:

1. **Local execution is defensible today but carries growing risk as user count increases.** A single-operator system has limited attack surface: the agent can be trusted to execute tools on the host because there is no other user whose data could be exposed. The moment a second user joins, local execution creates cross-user contamination risks: one user's tool call could read another's files, environment variables, or conversation context.

2. **The principal propagation gap is the most urgent structural problem.** When all tool calls execute without encoding whose request triggered them, incident investigation ("which user asked the agent to delete that file?") and per-user permission enforcement become impossible. The minimum viable fix is tagging every tool call with a user identifier before execution and logging it to a persistent audit stream. The full fix (RFC 8693 token exchange per user request) requires the agent to have its own OAuth client and the downstream tools to be OAuth Resource Servers — a larger infrastructure investment.

3. **The policy enforcement model should move to the gateway layer before scaling.** A client-side allowlist works for a trusted single-user scenario but provides no enforcement for multi-user cases where different users should have different tool permissions, or for enforcing that actions taken for User A cannot affect User B's resources.

4. **For a remote sandbox transition, the most practical entry point is browser automation.** Browser tool calls are the highest-risk local execution type (they can access any logged-in account, click any button, navigate to any URL) and the most natural fit for cloud sandboxes (browser state is session-scoped, no local file dependencies). Moving browser execution to a cloud sandbox while keeping file/bash tools local is a lower-risk first step than a full remote execution migration.

5. **Snapshot/resume capabilities matter for a long-lived autonomous agent.** An agent that runs continuously across days and weeks cannot use ephemeral-by-default sandboxes for stateful work. VM branching (Morph) or object-storage-backed snapshot/restore (Cloudflare R2 pattern) are the appropriate models when the sandbox must persist agent-specific installation state between tasks.

6. **The MCP gateway pattern is the correct target architecture for tool permission management.** Rather than encoding permission checks in the agent's system prompt or client-side config, all tool calls should route through a gateway process that holds the permission manifests, validates the requesting user's identity and role, and produces an immutable audit log. This decouples permission management from the agent's reasoning process and allows permission policies to be updated without restarting the agent session.

---

*Sources:*

1. *E2B Platform — https://e2b.dev/ (official docs, accessed June 2026)*
2. *Northflank: E2B vs Modal comparison — https://northflank.com/blog/e2b-vs-modal (June 2026)*
3. *Koyeb: Top Sandbox Platforms for AI Code Execution 2026 — https://www.koyeb.com/blog/top-sandbox-code-execution-platforms-for-ai-code-execution-2026 (2026)*
4. *Daytona — https://github.com/daytonaio/daytona (accessed June 2026)*
5. *Sub-90ms cloud code execution with Daytona — https://medium.com/@kacperwlodarczyk/sub-90ms-cloud-code-execution-how-daytona-replaced-docker-in-our-ai-agent-stack-b6f343e4e547 (2025)*
6. *Runloop: Enterprise Sandboxes for AI Coding Agents — https://runloop.ai/media/runloop-unveils-enterprise-grade-sandboxes-for-ai-coding-agents (May 2025)*
7. *Runloop: $7M Seed Round — https://runloop.ai/media/runloop-raises-7m-seed-round-to-bring-enterprise-grade-infrastructure-to-ai-coding-agents (July 2025)*
8. *Cloudflare Sandboxes GA — https://blog.cloudflare.com/sandbox-ga/ (April 2026)*
9. *Cloudflare: Build a Remote MCP server — https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/ (2026)*
10. *Cloudflare: Remote MCP servers — https://blog.cloudflare.com/remote-model-context-protocol-servers-mcp/ (2025)*
11. *Anthropic Engineering: Code execution with MCP — https://www.anthropic.com/engineering/code-execution-with-mcp (November 2025)*
12. *Simon Willison: Code execution with MCP — https://simonwillison.net/2025/Nov/4/code-execution-with-mcp/ (November 2025)*
13. *OpenHands Runtime Architecture — https://docs.openhands.dev/openhands/usage/architecture/runtime (2025)*
14. *MCP blog: Transport future — https://blog.modelcontextprotocol.io/posts/2025-12-19-mcp-transport-future/ (December 2025)*
15. *Auth0: MCP Specs Update — All About Auth — https://auth0.com/blog/mcp-specs-update-all-about-auth/ (June 2025)*
16. *Docker: MCP Gateway Secure Infrastructure — https://www.docker.com/blog/docker-mcp-gateway-secure-infrastructure-for-agentic-ai/ (2025)*
17. *Uber Engineering: Solving the Agent Identity Crisis — https://www.uber.com/us/en/blog/solving-the-agent-identity-crisis/ (2025)*
18. *WorkOS: Delegated Access for AI Agents — https://workos.com/blog/delegated-access-ai-agents (2025)*
19. *Solo.io: Agent Identity and Access Management — Can SPIFFE Work? — https://www.solo.io/blog/agent-identity-and-access-management---can-spiffe-work (2025)*
20. *HashiCorp: SPIFFE for Agentic AI — https://www.hashicorp.com/en/blog/spiffe-securing-the-identity-of-agentic-ai-and-non-human-actors (2025)*
21. *Northflank: How to sandbox AI agents in 2026 — https://northflank.com/blog/how-to-sandbox-ai-agents (2026)*
22. *Modal: Best Code Execution Sandboxes for Tool-Calling Agents — https://modal.com/resources/best-code-execution-sandboxes-tool-calling-ai-agents (2026)*
23. *Morph Cloud: Daytona Alternatives — https://www.morphllm.com/comparisons/daytona-alternative (2026)*
24. *AWS re:Invent 2025: Bedrock AgentCore Gateway — https://repost.aws/articles/ARy9ar569iSO-DRe5cIihUyQ/re-invent-2025-modernize-containers-for-ai-agents-using-agentcore-gateway (December 2025)*
25. *Google Cloud: GKE Agent Sandbox GA and Agent Substrate — https://cloud.google.com/blog/products/containers-kubernetes/bringing-you-agent-sandbox-on-gke-and-agent-substrate (2026)*
26. *HashiCorp: Secure AI Agent Authentication with Vault Dynamic Secrets — https://developer.hashicorp.com/validated-patterns/vault/ai-agent-identity-with-hashicorp-vault (2025)*
27. *Computer-Use Agents — 3 Sandboxing Patterns — https://dev.to/gabrielanhaia/computer-use-agents-3-sandboxing-patterns-that-dont-leak-credentials-4hci (2025)*
28. *arXiv: AIP — Agent Identity Protocol for Verifiable Delegation — https://arxiv.org/pdf/2603.24775 (March 2026)*
29. *Cursor: Background Agents on Morph — https://www.morphllm.com/cursor-background-agents (2026)*
30. *RFC 8693: OAuth 2.0 Token Exchange — https://www.rfc-editor.org/rfc/rfc8693.html (IETF, January 2020)*
