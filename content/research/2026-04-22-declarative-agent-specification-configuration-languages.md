---
date: "2026-04-22"
title: "Declarative Agent Specification: Configuration Languages and Standards for Autonomous AI Systems"
description: "How the AI agent ecosystem is converging on declarative configuration patterns — from CLAUDE.md and AGENTS.md to skill manifests, hook systems, and portable agent specifications."
tags:
  - ai-agents
  - configuration
  - declarative
  - standards
  - mcp
  - developer-tools
---

## Executive Summary

The AI agent ecosystem is undergoing a quiet but significant transformation: agent behavior is migrating from ad hoc prompt engineering toward structured, declarative configuration files that can be version-controlled, tested, and ported across runtimes. Files like CLAUDE.md and AGENTS.md are the opening move — they embed behavioral rules directly into codebases rather than inside volatile chat sessions. As the stack matures, hook systems, skill manifests, permission contracts, and cross-framework specifications like Oracle's Open Agent Specification and Google's Agent2Agent protocol are converging on a shared vocabulary. This article maps the current state of declarative agent specification in 2026 and identifies the open problems the field has not yet solved.

---

## From Prompts to Configuration Files

Early AI coding assistants operated entirely through imperative instructions typed into chat interfaces. Every session started fresh. Rules, conventions, and behavioral constraints lived in the user's head — or in copy-pasted prompt snippets that accreted informally over time.

The shift to declarative configuration files reflects a maturing engineering discipline. Rather than telling an agent what to do in every session, developers now declare the agent's operating environment once: what it knows, what it can touch, how it should behave. The file persists in the repository. It is readable by humans and machines alike. It travels with the code.

Two files pioneered this shift: **CLAUDE.md** from Anthropic and **AGENTS.md** from the broader open-source coding agent ecosystem.

### CLAUDE.md: Anthropic's Session-Loaded Context

[CLAUDE.md](https://code.claude.com/docs/en/overview) is Claude Code's primary specification file. It lives in a project's root directory and is loaded automatically at the start of every session. The file is plain Markdown with no required schema — developers embed behavioral rules, codebase conventions, architectural decisions, and security constraints in free-form prose and lists.

The companion file, `settings.json` (located at `.claude/settings.json` for project scope or `~/.claude/settings.json` for global defaults), handles the structured, machine-readable side: permission rules, allowed and denied tool invocations, and hook definitions. The split is intentional — CLAUDE.md carries human-readable intent, settings.json carries machine-enforced policy.

Permission rules follow a deterministic evaluation model: deny rules are checked first, then `ask` rules, then `allow` rules. The first matching rule wins. Rules reference tool names or patterns like `Bash(rm -rf:*)`. This creates an explicit allowlist/denylist model that is auditable and commitable alongside the code it governs.

Practical guidance has converged around keeping CLAUDE.md under 300 lines. [Community analysis](https://www.humanlayer.dev/blog/writing-a-good-claude-md) consistently finds that lean files with pointers to documentation outperform exhaustive inlined specifications — the model handles indirection well but degrades with information overload.

### AGENTS.md: The Cross-Tool Open Standard

[AGENTS.md](https://agents.md/) emerged from a different impulse. Where CLAUDE.md is Anthropic-specific, AGENTS.md was designed from the start to be tool-agnostic. It is plain Markdown with no required fields and no custom syntax. An agent simply parses the text.

The format was created through collaboration between OpenAI, Google, Cursor, Amp, Factory, and other ecosystem participants, and is now stewarded by the [Agentic AI Foundation](https://openai.com/index/agentic-ai-foundation/) under the Linux Foundation. Since its release in August 2025, AGENTS.md has been adopted by [more than 60,000 open-source projects](https://prpm.dev/blog/agents-md-deep-dive), and is read natively by Codex, Cursor, GitHub Copilot, Jules (Google), Devin, Factory, Gemini CLI, and VS Code.

The format's strength is precisely its lack of structure. There is no schema to validate, no version to track, no required sections. Agents read what they can understand and ignore what they cannot. The result is a spec that works across the full diversity of the 2026 coding agent landscape without requiring any coordination between tool maintainers.

A feature request filed against Claude Code (anthropics/claude-code [issue #6235](https://github.com/anthropics/claude-code/issues/6235)) asks Anthropic to load AGENTS.md as a complement to CLAUDE.md — a signal that the two formats are converging toward a shared project-level configuration surface.

---

## The Model Context Protocol: Declarative Tool Manifests

While CLAUDE.md and AGENTS.md handle behavioral instructions, the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/specification/2025-11-25) handles capability declaration. MCP is Anthropic's open protocol for connecting LLM applications to external data sources and tools, now adopted by OpenAI and Google as the de facto standard for agent tool interoperability.

An MCP server exposes a machine-readable manifest of its capabilities. Each tool entry includes:

- **Name**: a stable identifier
- **Description**: a human- and model-readable explanation of what the tool does
- **Input schema**: a JSON Schema object specifying required and optional parameters
- **Output schema**: the shape of the returned data
- **Annotations**: optional metadata including read-only flags, destructive-action warnings, and audience hints

The current specification (version [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)) defines the authoritative protocol in TypeScript and publishes a JSON Schema translation for language-agnostic implementations. Server configuration follows a reverse-DNS naming convention for namespacing, a human-readable title, and a plain-language description of server functionality.

For builders, MCP's key property is portability: an MCP server built once works with Claude, GPT-4o, and Gemini without modification. [OpenAI adopted MCP](https://openai.github.io/openai-agents-python/mcp/) in 2025 and [VS Code integrated MCP server management](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) as a first-class feature, cementing MCP as the shared tool interface layer across the major runtimes.

MCP complements rather than replaces OpenAPI-based tool definitions. Many organizations maintain OpenAPI specs for existing services and wrap them in MCP servers via adapter layers, preserving the existing API contract while gaining MCP interoperability.

---

## Hook Systems: Event-Driven Behavior Configuration

Beyond static instruction files, mature agent platforms expose hook systems — defined points in the agent lifecycle where user-specified code, prompts, or HTTP endpoints can intercept and modify behavior.

### Claude Code's Hook Architecture

Claude Code's [hook system](https://code.claude.com/docs/en/hooks) defines events across the full agent lifecycle:

| Event | Trigger | Blocking |
|-------|---------|---------|
| `PreToolUse` | Before any tool call | Yes — can abort |
| `PostToolUse` | After tool returns | No |
| `PreCompact` | Before context compaction | No |
| `PostCompact` | After compaction | No |
| `Stop` | When agent finishes | No |
| `SubagentStop` | When subagent finishes | No |

Hooks support three handler types: **Command** hooks run shell processes that receive JSON on stdin and return structured JSON on stdout (exit code 2 signals a blocking rejection); **Prompt** hooks invoke a Claude model for single-turn evaluation; **Agent** hooks spawn full subagents with tool access for deep verification tasks.

This architecture creates programmable safety rails. A `PreToolUse` hook on `Bash` can enforce allowlists for shell commands. A `PostToolUse` hook on file writes can trigger linters or security scanners. Hooks are configured in `settings.json` alongside permission rules, making them version-controlled first-class citizens of the project configuration.

### Cursor and Agno Hook Systems

[Cursor 1.7](https://www.infoq.com/news/2025/10/cursor-hooks/) (October 2025) introduced lifecycle hooks including `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `afterFileEdit`, and `stop` — a parallel evolution reflecting the same underlying need across different implementations.

[Agno](https://docs.agno.com/basics/hooks/overview) exposes pre-hooks and post-hooks at the agent and team level in Python: pre-hooks execute before any LLM call, post-hooks execute after the response is prepared but before it is returned. This gives framework-level control over the request-response cycle without requiring subclassing.

The convergence across Claude Code, Cursor, and Agno on similar hook vocabularies suggests an emerging informal standard: lifecycle events map onto a small, predictable set of phases (pre-tool, post-tool, pre-response, post-response, stop).

---

## The Open Agent Specification: Framework-Agnostic Declarative Agent Definitions

The most ambitious attempt to unify agent configuration across runtimes is the [Open Agent Specification (Agent Spec)](https://arxiv.org/abs/2510.04173), published by Oracle in October 2025.

Agent Spec is a declarative, framework-agnostic language for defining AI agents and agentic workflows. Its core insight is that most agentic systems decompose into a small set of primitives: **agents** (goal-directed actors), **flows** (workflows connecting nodes), **nodes** (typed execution units like `LLMNode` or `ToolNode`), and **tools** (external capability declarations).

These primitives serialize to JSON or YAML using standard JSON Schema property conventions. A Python SDK (`PyAgentSpec`) handles serialization and deserialization. A reference runtime (`WayFlow`) executes Agent Spec definitions directly. Adapters translate Agent Spec into LangGraph, AutoGen, and CrewAI agent definitions.

The [technical report](https://arxiv.org/html/2510.04173v1) demonstrates Agent Spec running identical definitions across four distinct runtimes — LangGraph, CrewAI, AutoGen, and WayFlow — evaluated over three benchmarks (SimpleQA Verified, τ²-Bench, and BIRD-SQL). The specification lives at [oracle.github.io/agent-spec](https://github.com/oracle/agent-spec).

For comparison, [LangGraph's `langgraph.json`](https://docs.langchain.com/langgraph-platform/application-structure) takes a narrower approach: a JSON configuration file specifying dependencies, graph entry points, environment variable bindings, and deployment settings. It is runtime-specific and tightly coupled to the LangGraph execution model, but provides a practical, working deployment target today.

---

## Configuration Inheritance and Override Hierarchies

As agent deployment scales from individual developers to teams and organizations, configuration inheritance becomes a structural problem. The emerging pattern is a layered model:

```
Global (user home directory)
  └── Project (repository root)
        └── User-local (gitignored personal overrides)
              └── Session (runtime-injected context)
```

Claude Code implements this hierarchy explicitly. `~/.claude/settings.json` provides global defaults. `.claude/settings.json` in the project root provides project-scoped rules committed to the repository. A local override file handles personal preferences that should not be shared. Session-level context flows through CLAUDE.md loading and runtime injection.

The [agentsmd/agents.md](https://github.com/agentsmd/agents.md) project has proposed standardizing global user configuration at `~/.config/agents/AGENTS.md` ([issue #91](https://github.com/agentsmd/agents.md/issues/91)), paralleling the global CLAUDE.md concept.

[Agent OS](https://buildermethods.com/agent-os/profiles) introduces profile inheritance for more complex scenarios: profiles like `rails-api → rails → general → default` cascade configuration changes, with each level declaring only what differs from its parent. The `inherits_from: false` flag produces a clean-slate profile with no inherited settings. An `exclude_inherited_files` section allows surgical removal of specific inherited configuration elements.

OpenAI's Codex [advanced configuration](https://developers.openai.com/codex/config-advanced) provides session-level control through explicit `inherit` settings that can start from `"none"` (fully clean) or `"core"` (minimal set) and build up incrementally.

---

## Agent Behavior Contracts: Permissions, Sandboxing, and Trust Boundaries

Declarative configuration is most consequential at the security boundary — specifying what an agent is allowed to do, under what conditions, and with what oversight.

Claude Code's sandboxed Bash tool demonstrates the current state of the art in file-level permission granularity:

- Default **write access**: restricted to the current working directory and its subtree
- Default **read access**: most of the filesystem, minus explicit deny patterns
- **Configurable overrides**: project settings can add allowed or denied paths
- **Pre-approval gates**: `PreToolUse` hooks can block specific command patterns before execution

[NVIDIA's security guidance](https://developer.nvidia.com/blog/practical-security-guidance-for-sandboxing-agentic-workflows-and-managing-execution-risk/) for agentic workflows outlines a defense-in-depth model: isolation boundaries, resource limits, network egress controls, permission scoping, and runtime monitoring. The key principle is zero-trust by default — all connections must be explicitly whitelisted, not implicitly permitted.

The [MicroVM and gVisor approach](https://northflank.com/blog/how-to-sandbox-ai-agents) for sandboxing agent execution provides OS-level isolation when process-level controls are insufficient. This becomes relevant for agents that run arbitrary code or install dependencies.

A recurring practical problem is approval fatigue. Community analysis of Claude Code deployments found that sandbox-level controls reduce permission prompts by 84%, and that without sandbox backstops, reflexive approval behavior makes the prompts operationally meaningless. The design implication is that declarative permission rules should pre-approve common safe operations — moving human judgment upstream to configuration time rather than execution time.

---

## Secrets and Credential Management in Agent Configurations

Agent configuration files create a new attack surface for credential exposure. An autonomous agent that has file system access and operates in a development environment can read `.env` files, configuration files, and SSH keys — sometimes without this being the agent's intent.

[GitGuardian's State of Secrets Sprawl Report](https://www.helpnetsecurity.com/2026/04/14/gitguardian-ai-agents-credentials-leak/) found 28,649,024 new secrets exposed in public GitHub commits across 2025, a 34% year-over-year increase. The report attributes a significant portion of this growth to AI-assisted development workflows where agents inadvertently surface credentials in generated code or configuration files.

The security community has converged on several practices for agent credential management:

**Short-lived scoped tokens over static secrets.** Agents should receive credentials that expire, are scoped to the minimum required permissions, and are generated on demand rather than stored persistently. [HashiCorp Vault's dynamic secrets](https://developer.hashicorp.com/validated-patterns/vault/ai-agent-identity-with-hashicorp-vault) for AI agents implements this model: the agent authenticates via standard OAuth 2.0 and receives a time-bounded credential with only the permissions needed for its current task.

**Token vaults as credential brokers.** A [token vault](https://www.scalekit.com/blog/token-vault-ai-agent-workflows) sits between the agent and external services, issuing short-lived credentials in response to authenticated requests, logging all access, and enforcing permission scoping. The agent never stores credentials — it requests them when needed and they expire after use.

**Workload identity for cloud environments.** For agents running on cloud infrastructure, workload identity federation (AWS IAM roles, GCP service accounts, Azure managed identities) eliminates static credential storage entirely. The agent's runtime environment has an identity; credentials are issued based on that identity without any stored secret.

The implication for declarative configuration is that `secrets` sections in agent config files should contain references to credential sources (vault paths, environment variable names, identity provider configurations), not credential values.

---

## The Agent2Agent Protocol: Multi-Agent Communication Config

As agents increasingly orchestrate other agents, the configuration problem extends to inter-agent communication. The [Agent2Agent (A2A) protocol](https://a2a-protocol.org/latest/), initially introduced by Google in April 2025 and donated to the Linux Foundation in June 2025, addresses this layer.

A2A v1.0 (early 2026) introduced **Signed Agent Cards** — JSON documents that cryptographically describe an agent's identity, capabilities, and communication endpoints. The signature allows receiving agents to verify that a card was actually issued by its claimed domain, preventing impersonation in multi-agent systems. Version 1.2 (March 2026) is the current stable release.

The protocol now has [150+ organizations as participants](https://stellagent.ai/insights/a2a-protocol-google-agent-to-agent) including Microsoft, AWS, Salesforce, SAP, and ServiceNow. It is built on HTTP, SSE, and JSON-RPC — deliberately boring infrastructure choices that maximize compatibility with existing enterprise stacks.

A2A's four capability categories map directly onto declarative configuration concerns:
1. **Capability discovery** — what can this agent do? (Agent Cards)
2. **Task management** — how are work items tracked across agent boundaries?
3. **Agent collaboration** — how is context and instruction passed between agents?
4. **UX negotiation** — what interface capabilities does the consuming agent expect?

A2A and MCP are complementary: MCP handles tool invocation within a single agent's context, A2A handles communication between opaque agent systems that may be running different frameworks and models.

---

## Multi-Runtime Portability: Writing Once, Running Everywhere

The practical aspiration of declarative agent configuration is portability: define an agent's behavior once and run it on Claude, GPT-4o, or Gemini without modification. The reality in 2026 is partial.

**MCP provides the strongest portability story** at the tool layer. Because OpenAI and Google both adopted MCP in 2025, an MCP server built for one runtime works with all three major LLM families. Tool definitions do not need to be ported.

**Behavioral instructions have lower portability.** CLAUDE.md is read by Claude Code. AGENTS.md is read by 60,000+ projects and agents across multiple tools — but parsing is heuristic, not schema-validated. An instruction that works well for Codex may be ignored or misread by a different agent.

**The Open Agent Specification targets the runtime portability gap** most directly. By serializing agent graphs into neutral JSON/YAML and providing adapters for LangGraph, AutoGen, and CrewAI, it allows the same agent definition to execute on multiple backends. The [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/mcp/) is explicitly provider-agnostic with documented paths for non-OpenAI models.

**Memory portability** is an emerging front: Anthropic's Import Memory tool (March 2026) pulls context from ChatGPT and Gemini exports into Claude's markdown files, marking an early move toward cross-platform context portability.

---

## Emerging Standards and Governance

The governance picture has clarified significantly in the past year:

- **MCP** — published by Anthropic, adopted by OpenAI and Google, de facto standard for tool interfaces
- **AGENTS.md** — stewarded by the Agentic AI Foundation (Linux Foundation), adopted across 60,000+ projects
- **A2A** — donated by Google to the Linux Foundation, v1.2 current, 150+ organizational participants
- **Open Agent Specification** — Oracle research project, open-source at github.com/oracle/agent-spec
- **Agentic AI Foundation** — Linux Foundation umbrella for AGENTS.md, A2A, and related open standards

The OpenAI Responses API (replacing the Assistants API, sunset August 26, 2026) introduces versioned prompt management, structured conversation items replacing threads, and first-party tools (web search, file search, computer use) as configuration primitives.

---

## Open Problems

### Version Control for Agent Configurations

Agent configurations interact with the code they govern, but the relationship is not formalized. Pinning a CLAUDE.md version to a code commit is trivially achievable with git, but understanding how a CLAUDE.md change affects agent behavior requires running the agent — there is no static analysis path.

The problem deepens for behavioral configurations: a change to a permission rule or hook definition may have non-obvious effects on agent task completion rates. Teams that have adopted GitOps workflows for agent deployment (similar to infrastructure-as-code approaches) report cutting deployment time significantly — but behavioral regression testing frameworks for agent config changes remain primitive.

### Configuration Drift Detection

[AI agent drift](https://www.getmaxim.ai/articles/a-comprehensive-guide-to-preventing-ai-agent-drift-over-time/) degrades system performance through model updates, data distribution changes, and prompt variations. Research indicates 91% of ML systems experience performance degradation without proactive intervention, yet most teams lack tooling to distinguish configuration drift from model drift.

Configuration drift in the infrastructure sense — where the running agent's effective configuration diverges from what is in the repository — is detectable with standard GitOps tooling. Behavioral drift, where the same configuration produces different behavior as the underlying model changes, requires behavioral baselining and continuous evaluation.

### Testing Agent Configurations

There is no standard testing framework for agent configurations. A `settings.json` permission rule can be unit-tested by checking its syntax. Whether it produces the right agent behavior under adversarial inputs is an integration test that requires running the agent against test scenarios.

The [promptfoo evaluation framework](https://www.promptfoo.dev/docs/guides/evaluate-langgraph/) provides one approach for LangGraph agents. [Relevance AI's version control](https://relevanceai.com/version-control) tracks behavioral changes across agent deployments. But the field lacks the equivalent of a test runner that accepts an agent specification file and a suite of behavioral assertions and produces a pass/fail result.

### Schema Validation and IDE Support

CLAUDE.md and AGENTS.md are free-form Markdown. There is no schema to validate, no LSP server to provide autocomplete, no linter to catch common mistakes. Developers working in settings.json have somewhat better tooling (JSON Schema validation in editors), but hook configurations and permission rule patterns are not yet formally specified in ways that enable rich IDE integration.

---

## Summary

The declarative agent specification landscape in 2026 is a field in mid-transition. The foundations are solid: CLAUDE.md, AGENTS.md, MCP tool manifests, and JSON/YAML-serialized agent graphs provide a vocabulary for expressing agent behavior in machine-readable, version-controllable form. Hook systems give developers deterministic interception points in the agent lifecycle. Permission contracts and sandboxing models establish explicit trust boundaries. Governance bodies under the Linux Foundation are stewarding key standards.

The unsolved problems are the next frontier: behavioral testing for configuration changes, drift detection across model updates, schema validation and IDE tooling for instruction files, and the deeper portability challenge of making the same behavioral intent work reliably across Claude, GPT, and Gemini.

The trajectory is toward agents that are as configurable, testable, and auditable as the software systems they help build.

---

## References

1. [Writing a good CLAUDE.md — HumanLayer Blog](https://www.humanlayer.dev/blog/writing-a-good-claude-md)
2. [Claude Code overview — Claude Code Docs](https://code.claude.com/docs/en/overview)
3. [Claude Code settings — Claude Code Docs](https://code.claude.com/docs/en/settings)
4. [Hooks reference — Claude Code Docs](https://code.claude.com/docs/en/hooks)
5. [Feature Request: Support AGENTS.md — anthropics/claude-code issue #6235](https://github.com/anthropics/claude-code/issues/6235)
6. [Custom instructions with AGENTS.md — OpenAI Codex Docs](https://developers.openai.com/codex/guides/agents-md)
7. [AGENTS.md — The Open Format for AI Coding Agents](https://agents.md/)
8. [agents.md: The Complete Guide to the Open Standard — PRPM](https://prpm.dev/blog/agents-md-deep-dive)
9. [OpenAI co-founds the Agentic AI Foundation under the Linux Foundation](https://openai.com/index/agentic-ai-foundation/)
10. [MCP Specification 2025-11-25 — Model Context Protocol](https://modelcontextprotocol.io/specification/2025-11-25)
11. [MCP — OpenAI Agents SDK](https://openai.github.io/openai-agents-python/mcp/)
12. [Add and manage MCP servers in VS Code](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)
13. [Open Agent Specification (Agent Spec) Technical Report — arxiv:2510.04173](https://arxiv.org/abs/2510.04173)
14. [Open Agent Specification — oracle/agent-spec GitHub](https://github.com/oracle/agent-spec)
15. [Announcing the Agent2Agent Protocol (A2A) — Google Developers Blog](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)
16. [A2A Protocol — a2a-protocol.org](https://a2a-protocol.org/latest/)
17. [Linux Foundation Launches the Agent2Agent Protocol Project](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents/)
18. [A2A Protocol: 150+ Organizations in One Year — Stellagent](https://stellagent.ai/insights/a2a-protocol-google-agent-to-agent)
19. [Cursor 1.7 Adds Hooks for Agent Lifecycle Control — InfoQ](https://www.infoq.com/news/2025/10/cursor-hooks/)
20. [Pre-hooks and Post-hooks — Agno Docs](https://docs.agno.com/basics/hooks/overview)
21. [Practical Security Guidance for Sandboxing Agentic Workflows — NVIDIA](https://developer.nvidia.com/blog/practical-security-guidance-for-sandboxing-agentic-workflows-and-managing-execution-risk/)
22. [How to sandbox AI agents in 2026: MicroVMs, gVisor — Northflank](https://northflank.com/blog/how-to-sandbox-ai-agents)
23. [29 million leaked secrets in 2025: AI agent credentials out of control — Help Net Security](https://www.helpnetsecurity.com/2026/04/14/gitguardian-ai-agents-credentials-leak/)
24. [Secure AI agent authentication using HashiCorp Vault dynamic secrets](https://developer.hashicorp.com/validated-patterns/vault/ai-agent-identity-with-hashicorp-vault)
25. [Token vault for AI agent workflows — Scalekit](https://www.scalekit.com/blog/token-vault-ai-agent-workflows)
26. [Agent OS Profiles and inheritance — BuilderMethods](https://buildermethods.com/agent-os/profiles)
27. [LangGraph Platform application structure](https://docs.langchain.com/langgraph-platform/application-structure)
28. [Versioning AI agents — Medium](https://medium.com/@nraman.n6/versioning-rollback-lifecycle-management-of-ai-agents-treating-intelligence-as-deployable-deac757e4dea)
29. [A Comprehensive Guide to Preventing AI Agent Drift — Maxim](https://www.getmaxim.ai/articles/a-comprehensive-guide-to-preventing-ai-agent-drift-over-time/)
30. [Agent Skills as an Open Standard — MindStudio](https://www.mindstudio.ai/blog/agent-skills-open-standard-claude-openai-google-2)
