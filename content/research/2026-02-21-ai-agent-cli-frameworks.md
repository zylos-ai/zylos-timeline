---
date: "2026-02-21"
title: "AI Agent CLI Frameworks: Terminal-Native Agent Runtimes"
description: "How the command line became the dominant execution environment for autonomous AI agents — a survey of the landscape, architecture patterns, security models, and emerging standards shaping the 2025-2026 ecosystem."
tags: ["ai-agents", "cli", "terminal", "developer-tools", "mcp", "claude-code", "aider", "codex", "architecture"]
---

## Executive Summary

After a decade in which IDEs grew heavier and browser-based editors tried to displace local development, the command line has re-emerged as the center of gravity for AI-assisted coding — and for AI agency more broadly. Between February 2025 and early 2026, every major AI lab shipped a terminal-native agent runtime: Anthropic with Claude Code, OpenAI with Codex CLI, Google with Gemini CLI, Block with Goose, Sourcegraph with Amp. The open-source ecosystem — Aider, Cline, Plandex, Continue.dev, OpenCode — expanded in parallel, driven by a user base that demands model flexibility and Unix composability that locked-in IDEs cannot provide.

The underlying shift is architectural. These tools are not glorified autocomplete plugins. They are agent loops: they read the filesystem, execute shell commands, manage git history, call external APIs, spawn subprocesses, and act across multi-file codebases with minimal human intervention. The terminal is their native habitat because it is where all of those capabilities already live. This report surveys the landscape, explains the architectural patterns that define the category, examines the security models emerging to constrain autonomous execution, and traces the standardization work — MCP, AGENTS.md, and the Linux Foundation's Agentic AI Foundation — that will determine whether the ecosystem fragments or converges.

---

## The Landscape: Who Built What and When

### Big-Lab Native Tools

**Claude Code (Anthropic)** launched in February 2025 and reached general availability in May 2025. It is Anthropic's agentic coding tool that runs in the terminal, understands the full codebase, and handles file editing, shell command execution, and git workflows through natural language. By November 2025 it had reached $1 billion in annualized revenue — an unusually fast trajectory for a developer tool. Claude Code follows the Unix philosophy explicitly: you can pipe logs into it, run it headlessly in CI, or chain it with other shell tools. As of version 2.0, it includes a VS Code extension, session checkpoints for autonomous operation, and a hooks system for workflow automation. It is locked to Anthropic's Claude models (Sonnet, Opus families).

**OpenAI Codex CLI** launched alongside Codex (the cloud coding agent service) in May 2025. The open-source CLI is built in Rust for speed, runs locally, and supports an `AGENTS.md` convention for per-repository agent instructions. It integrates with the OpenAI Agents SDK for orchestration and supports MCP for tool extension via `~/.codex/config.toml`. By late 2025 Codex had evolved from "a model you prompt" into a full software engineer surface — connecting models, local tooling, and cloud services.

**Gemini CLI (Google)** is open-source and free, providing access to Gemini's 1-million-token context window from the command line. Its free tier is notably generous: 60 requests per minute, 1,000 per day. Gemini CLI integrates with VS Code and GitHub Actions and supports web grounding — using live search to augment agent responses. It targets cost-sensitive developers and teams doing large-context reasoning tasks.

### Open-Source and Independent Tools

**Aider** is the largest deployed open-source coding CLI by usage, with 39,000+ GitHub stars, 4.1 million installations, and 15 billion tokens processed per week. It supports virtually every LLM — Claude, GPT-4o, DeepSeek, Gemini, local models via Ollama — making it the default choice for teams that want model flexibility without vendor lock-in. Aider integrates tightly with git, generating automatic commit messages for every change. It supports 100+ programming languages, voice-to-code input, and an IDE watch mode. Free and open-source; users pay their model provider directly.

**Cline** takes a "human-in-the-loop" philosophy: every file change and terminal command requires explicit user approval before execution. It supports virtually every model provider and adds browser automation and workspace checkpoint capabilities. Cline 2.0 re-architected itself as a "terminal AI agent control plane," positioning it as a control surface for orchestrating multiple agents rather than a single pair-programming assistant.

**Goose (Block)** is fully open-source under Apache 2.0, runs as both a CLI and desktop application, and has native MCP integration for extensibility. Block contributed Goose to the Linux Foundation's Agentic AI Foundation in December 2025. It supports any LLM and can run multiple model configurations simultaneously — useful for cost-optimized multi-agent pipelines.

**Plandex** is designed for large-scale, long-horizon tasks: it ships with a 2-million-token effective context window and 20-million-token indexing via Tree-sitter parsing. A cumulative diff review sandbox lets developers review and test all accumulated changes before applying any of them — a critical feature for multi-session work spanning many files.

**Amp (Sourcegraph)** offers a CLI agent backed by Sourcegraph's code intelligence, giving it deep understanding of cross-repository references and symbol graphs — an advantage in large monorepos where simple file-level context is insufficient.

**Continue.dev** is the open-source IDE extension that bridges terminal-native and IDE workflows. Its strength is the breadth of model support (any provider, local or remote) and a context provider system that lets developers pull in documentation, GitHub issues, web pages, and database schemas alongside code.

The table below summarizes the competitive positions:

| Tool | Model Lock-in | GitHub Stars | Free Tier | MCP Support | Headless/CI |
|------|--------------|-------------|-----------|-------------|------------|
| Claude Code | Anthropic only | — | No | Yes | Yes |
| Codex CLI | OpenAI only | Open-source | Via subscription | Yes | Yes |
| Gemini CLI | Google only | Open-source | 1,000 req/day | Yes | Yes |
| Aider | None (100+ models) | 39,000+ | Yes (OSS) | Partial | Yes |
| Cline | None | High | Yes (OSS) | Yes | Partial |
| Goose | None | Open-source | Yes (OSS) | Yes (native) | Yes |
| Plandex | None | Open-source | Yes (OSS) | Partial | Yes |

---

## Why the Terminal Won

### Composability Over Convenience

The terminal was built for long-running processes, parallel sessions, scriptable workflows, piped I/O, and composable tools. These properties align precisely with what autonomous agents need. Claude Code makes this explicit in its documentation: you can pipe `git diff` output into it, pipe its output into `jq`, or chain it with `make` targets. An IDE plugin operates within the IDE's extension API — expressive for code intelligence, but structurally ill-suited to orchestrating shell commands, managing processes, or running headlessly in a CI pipeline.

The Unix philosophy scales to the agent layer: build a tool that does one thing well, accept input on stdin, emit structured output on stdout, and let the human (or orchestrator) compose the rest. CLI agents inherit this composability for free. Web UIs do not.

### Context Quality at Scale

IDE plugins typically operate on the current file or function. The terminal, by contrast, gives agents access to the full project tree, `.git` history, environment variables, test runners, build systems, and any other shell-accessible resource. The agents that excel — Claude Code on 500,000-line legacy codebases, Plandex on multi-session rewrites — do so because the terminal context is richer and less artificially bounded than what an IDE plugin can access.

### Headless and Autonomous Operation

A critical capability that web UIs structurally cannot provide is headless execution: running an agent without a human in the session. This unlocks CI/CD integration, scheduled autonomous work, and agent-to-agent orchestration. Practical applications include:

- Piping `git diff` into Cline for automated code review on pull request open
- Running Claude Code in GitHub Actions to fix failing tests and commit the result
- Scheduling Aider to apply dependency upgrades overnight and open PRs
- Chaining Codex CLI outputs into deployment scripts

The growing availability of `--headless` flags, `--print` (non-interactive) modes, and environment-variable-driven configuration across these tools reflects a deliberate architectural choice: the CLI is the primitive; the UI is a convenience wrapper.

---

## Architectural Patterns

### The Agent Loop

All terminal-native agents share a common execution structure. The agent receives a task, enters a loop of: (1) reasoning about what to do, (2) calling a tool (read file, write file, run command, call API), (3) observing the result, and (4) deciding whether the task is complete or another tool call is needed. The loop terminates on completion or an error condition requiring human input.

The tool interface maps cleanly to the Unix process model: tools are invoked as subprocess calls or function calls, returning structured output the model can reason over. This is architecturally simpler than the callback-heavy event models of browser extensions or the sandboxed JS worker threads of VS Code extensions.

### File System Access

File access is the primitive capability every CLI agent exposes. The standard pattern is directory-scoped: the agent can read and write any file under the project root, with the boundary enforced by either convention or by the OS-level sandbox (see Security, below). Tools like `read_file`, `write_file`, `list_files`, and `search_files` are implemented as thin wrappers around standard filesystem calls, giving the agent full POSIX semantics.

### Shell Execution

The second primitive is shell command execution. Agents use this for running tests, invoking compilers, executing git commands, calling CLIs like `curl` or `jq`, and any other subprocess-based operation. Permission models differ: Claude Code asks before each novel command; Cline requires explicit approval for every command; Aider is more permissive by default but configurable.

### Hooks and Event Lifecycle

Claude Code's hooks system is the most developed lifecycle extension mechanism in the category. Hooks fire at defined points in the agent execution cycle:

- `PreToolUse`: before any tool is invoked (useful for enforcing approval gates)
- `PostToolUse`: after tool completion (useful for logging, linting, or chaining)
- `SessionStart`: at initialization (for loading context or configuring state)

Hooks are shell scripts or executables; they receive JSON on stdin describing the event and can modify behavior by returning structured JSON. This enables teams to inject quality gates — for example, running a linter after every file write, or blocking shell commands that match a deny-list pattern — without modifying the agent's core logic. Hooks compose with MCP tools, creating a two-layer extension system: MCP extends what the agent *can* do, hooks extend how it *behaves* at runtime.

### Session and Context Management

Long-horizon tasks require persistent context across multiple interactions. The major tools handle this differently:

- **Claude Code** uses session checkpoints: the agent can save its working state and resume it later, enabling multi-session autonomous work.
- **Plandex** maintains a cumulative diff sandbox: all changes accumulate across the session and are applied atomically when the developer approves the batch.
- **Aider** uses git as the session store: every agent action is committed, making the entire history inspectable and rollback trivial.
- **Cline** offers workspace checkpoints that snapshot the entire project state before the agent begins a task.

### Model Context Protocol (MCP) Integration

MCP, introduced by Anthropic in November 2024 and donated to the Linux Foundation in December 2025, is rapidly becoming the standard for extending agent capabilities with external tools and data sources. It defines a client-server protocol where an MCP server exposes tools, resources, and prompts that any compliant agent can consume.

The growth is striking: from 100,000 total downloads in November 2024 to 8 million by April 2025 — 80x in five months. As of early 2026, tens of thousands of MCP servers are available, covering databases, web APIs, development tools, cloud services, and domain-specific data sources.

Every major CLI agent now supports MCP: Claude Code, Codex CLI, Gemini CLI, Goose (natively), Cline, and Aider (partially). A practical design principle is emerging: "build a good CLI first, then wrap it as an MCP." A well-designed CLI — usable from shell, pipeable, testable standalone — makes an excellent MCP server, because both interfaces share the same input/output semantics.

---

## Security Considerations

Autonomous agents that can read files, execute shell commands, and make network requests create a meaningful attack surface. The industry has converged on three categories of controls.

### Sandboxing

Claude Code's sandboxing implementation, detailed in Anthropic's engineering blog, uses OS-level primitives: Linux `bubblewrap` on Linux and macOS Seatbelt on Apple devices. The sandbox enforces two orthogonal isolation boundaries:

**Filesystem isolation**: The agent can only access or modify directories explicitly permitted. This prevents prompt injection attacks — malicious instructions embedded in source files or comments — from causing the agent to access SSH keys, `.env` credentials, or other sensitive files outside the project root.

**Network isolation**: All outbound network traffic is routed through a unix-domain-socket proxy running outside the sandbox. The proxy enforces domain allowlists and requires user consent for connections to new domains. This blocks unauthorized data exfiltration — an agent compromised by prompt injection cannot leak credentials to an attacker-controlled server.

Anthropic reports that this dual sandbox reduces permission prompts by 84% in internal usage: predefined boundaries let the agent work autonomously within its permitted domain without triggering per-action approval requests.

Docker has released a complementary approach for teams that want container-level isolation: purpose-built sandbox containers that mirror the local workspace and enforce strict boundaries at the container level. This is particularly useful in CI/CD contexts where the agent runs in an ephemeral environment with no access to the developer's host system.

### Permission Models

Permission models across the ecosystem range from fully manual to fully permissive with configuration:

- **Cline**: Approve every file change and shell command. Maximally controlled, lowest autonomy.
- **Claude Code (default)**: Auto-approve safe read operations; prompt for writes and novel shell commands.
- **Claude Code (sandboxed)**: Approve the sandbox boundary once; auto-approve all operations within it.
- **Aider**: Configurable; permissive by default for speed, can be locked down with deny lists.
- **Codex CLI**: Three explicit modes — `suggest` (read-only proposals), `auto-edit` (apply file changes, prompt for shell), `full-auto` (execute everything).

### Credential Management

The standard guidance across all tools is to use environment variable references in agent context rather than actual credential values. The `.env` file pattern is ubiquitous in the ecosystem: agents are expected to read `process.env` values rather than having credentials injected into prompts. Filesystem sandboxing then prevents the agent from reading `.env` files outside the permitted directory tree.

A December 2025 security report uncovered 30+ vulnerabilities across AI coding tools, many related to prompt injection and unrestricted `.env` file access. This accelerated adoption of explicit deny-list patterns (`~/.claudeignore`, per-project `.agentignore`) that prevent agents from accessing credential files even when those files are within the project root.

---

## Standardization and Future Directions

### The Agentic AI Foundation (AAIF)

In December 2025, the Linux Foundation announced the Agentic AI Foundation, co-founded by Anthropic, Block, and OpenAI, with platinum members including AWS, Google, Microsoft, Bloomberg, and Cloudflare. The AAIF received three founding project contributions:

1. **MCP**: The universal protocol for connecting AI models to tools and data sources, contributed by Anthropic.
2. **Goose**: Block's open-source, local-first agent framework with MCP-native integration.
3. **AGENTS.md**: A lightweight standard for per-repository agent configuration — a markdown file that gives any agent a consistent source of project-specific guidance. Contributed by OpenAI, already adopted by more than 60,000 open-source repositories by the time of donation.

The AAIF signals that the major players have decided standardization serves everyone's interests more than fragmentation does. MCP as neutral infrastructure, AGENTS.md as a universal repository configuration format, and Goose as a reference open-source implementation form a coherent foundation that independent tools can build on without depending on any single vendor.

### MCP as the Interoperability Layer

MCP's trajectory from Anthropic-specific experiment to Linux Foundation standard mirrors the path of earlier infrastructure standards like OAuth and OpenAPI. The OpenAI Assistants API deprecation (scheduled for mid-2026) effectively mandates the migration of the entire OpenAI developer ecosystem to MCP-based architectures — a forcing function that will drive MCP adoption beyond the CLI agent category into the broader AI application ecosystem.

The "CLI-first, MCP-second" design principle is gaining traction: build the tool as a well-behaved CLI with clean stdio semantics, then expose it as an MCP server. This keeps the tool usable by humans in the terminal while making it accessible to any MCP-compliant agent. The pattern is visible in how the community is building MCP servers for existing tools (Playwright, PostgreSQL, GitHub) rather than rewriting them as agent-native APIs.

### Parallel Execution and Agent Orchestration

The next architectural evolution underway in 2026 is parallel agent orchestration: running multiple CLI agents simultaneously on different subtasks and coordinating their results. Tools like Claude-Flow (community-built orchestration for Claude Code) and the OpenAI Agents SDK's Codex integration enable patterns like scatter/gather (spawn N agents on N files, merge results), pipeline (agent A's output feeds agent B), and supervisor/worker (a coordinator agent delegates to specialist agents).

The CLI is the natural primitive for this pattern too: processes are the unit of parallelism, pipes are the communication channel, and the shell is the orchestrator. What is new is that the agent can now write the orchestration script itself, spawning child agents as needed to decompose a large task.

### Remaining Open Problems

Several hard problems remain unsolved or only partially addressed:

**Context freshness at scale**: Multi-million-token context windows exist, but the quality of reasoning degrades in the middle of very long contexts. Retrieval-augmented approaches (Tree-sitter indexing as in Plandex, Sourcegraph's code intelligence in Amp) are active areas.

**Agent identity and auditability**: When an agent takes an action in a CI pipeline, who is responsible? Current tools log actions to files; few have cryptographic audit trails or chain-of-custody semantics that would satisfy compliance requirements.

**Cross-agent trust**: When Agent A spawns Agent B (via MCP or subprocess), what trust does B inherit? The permission models are per-agent, not per-chain. An agent orchestrating other agents can inadvertently grant subagents more authority than intended.

**Prompt injection at scale**: As agents consume larger contexts from richer sources (web pages, third-party APIs, user-submitted files), the attack surface for prompt injection grows proportionally. Sandboxing mitigates the blast radius but does not prevent the injection itself.

---

## Conclusion

The terminal-native AI agent runtime is not a transitional form waiting to be replaced by something with a better UI. It is an architectural choice grounded in composability, scriptability, and decades of Unix infrastructure that IDEs and web UIs cannot replicate. The convergence of the major labs on this pattern — all releasing CLI agents in the same twelve-month window — reflects a shared conclusion: the shell is the right substrate for autonomous software agents.

The category is maturing rapidly. MCP is becoming the USB-C of agent tool integration. AGENTS.md is establishing per-repository configuration as a first-class concept. The AAIF is providing neutral governance for the standards that will define interoperability. And the security layer — sandboxing, permission models, credential isolation — is advancing from afterthought to core architecture.

The open questions are real, but the trajectory is clear. By the end of 2026, the terminal will be the control plane from which developers orchestrate fleets of parallel agents, manage long-running autonomous tasks, and integrate AI execution into every layer of the software delivery pipeline.

---

## Sources

- [Claude Code Overview — Anthropic](https://code.claude.com/docs/en/overview)
- [Enabling Claude Code to work more autonomously — Anthropic](https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously)
- [Claude Code Sandboxing — Anthropic Engineering](https://www.anthropic.com/engineering/claude-code-sandboxing)
- [Claude Code Plugins — Anthropic](https://www.anthropic.com/news/claude-code-plugins)
- [OpenAI Codex CLI — GitHub](https://github.com/openai/codex)
- [Introducing Codex — OpenAI](https://openai.com/index/introducing-codex/)
- [Unrolling the Codex Agent Loop — OpenAI](https://openai.com/index/unrolling-the-codex-agent-loop/)
- [OpenAI for Developers 2025 — OpenAI](https://developers.openai.com/blog/openai-for-developers-2025/)
- [Gemini CLI — Google](https://blog.google/technology/developers/introducing-gemini-cli-open-source-ai-agent/)
- [Aider — AI Pair Programming in Your Terminal](https://aider.chat/)
- [Aider — GitHub](https://github.com/Aider-AI/aider)
- [Understanding Claude Code's Full Stack — alexop.dev](https://alexop.dev/posts/understanding-claude-code-full-stack/)
- [The 2026 Guide to Coding CLI Tools: 15 AI Agents Compared — Tembo](https://www.tembo.io/blog/coding-cli-tools-comparison)
- [From IDE Helpers to CLI Agents — Medium](https://medium.com/@lawrenceteixeira/from-ide-helpers-to-cli-agents-how-agentic-clis-are-accelerating-real-world-dev-workflows-81c96c802579)
- [AI Coding Tools in 2025: Welcome to the Agentic CLI Era — The New Stack](https://thenewstack.io/ai-coding-tools-in-2025-welcome-to-the-agentic-cli-era/)
- [How to sandbox AI agents in 2026 — Northflank](https://northflank.com/blog/how-to-sandbox-ai-agents)
- [Docker Sandboxes for Coding Agent Safety — Docker Blog](https://www.docker.com/blog/docker-sandboxes-a-new-approach-for-coding-agent-safety/)
- [Researcher Uncovers 30+ Flaws in AI Coding Tools — The Hacker News](https://thehackernews.com/2025/12/researchers-uncover-30-flaws-in-ai.html)
- [Model Context Protocol — Wikipedia](https://en.wikipedia.org/wiki/Model_Context_Protocol)
- [MCP Specification 2025-11-25 — modelcontextprotocol.io](https://modelcontextprotocol.io/specification/2025-11-25)
- [Linux Foundation Announces Agentic AI Foundation (AAIF)](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation)
- [OpenAI co-founds the Agentic AI Foundation](https://openai.com/index/agentic-ai-foundation/)
- [OpenAI, Anthropic, and Block join Linux Foundation AI standardization effort — TechCrunch](https://techcrunch.com/2025/12/09/openai-anthropic-and-block-join-new-linux-foundation-effort-to-standardize-the-ai-agent-era/)
- [Build CLIs First, Wrap as MCPs Second — RobertMelton.com](https://robertmelton.com/posts/clis-wrap-as-mcps/)
- [Cline CLI 2.0 Turns Terminal Into AI Agent Control Plane — DevOps.com](https://devops.com/cline-cli-2-0-turns-your-terminal-into-an-ai-agent-control-plane/)
- [Best AI Coding Assistants as of February 2026 — Shakudo](https://www.shakudo.io/blog/best-ai-coding-assistants)
- [awesome-cli-coding-agents — GitHub](https://github.com/bradAGI/awesome-cli-coding-agents)
- [Securing AI Coding Tools — Brian Gershon](https://www.briangershon.com/blog/securing-ai-coding-tools/)
- [Practical Security Guidance for Sandboxing Agentic Workflows — NVIDIA](https://developer.nvidia.com/blog/practical-security-guidance-for-sandboxing-agentic-workflows-and-managing-execution-risk/)
