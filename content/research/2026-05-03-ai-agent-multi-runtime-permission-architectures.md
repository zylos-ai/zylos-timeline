---
date: "2026-05-03"
title: "AI Agent Multi-Runtime Permission Architectures: Claude Code, Codex CLI, and Gemini CLI in Production"
description: "A technical comparison of permission models, sandboxing strategies, context handoff patterns, and security vulnerabilities across the three dominant AI coding CLIs in 2026."
tags: ["ai-agents", "security", "cli-tools", "permissions", "runtime", "claude-code", "codex", "gemini-cli"]
---

## Executive Summary

By mid-2026, three AI coding CLIs have achieved meaningful production adoption: Anthropic's Claude Code, OpenAI's Codex CLI, and Google's Gemini CLI. While benchmarks dominate press coverage, production teams face a more practical question: how do these runtimes handle permissions, tool restriction, sandboxing, context persistence, and cross-runtime handoff? This article examines the permission architectures of each runtime, surfaces a high-severity vulnerability discovered in Claude Code's deny rule enforcement, and establishes patterns for teams operating across multiple runtimes simultaneously.

## Background: The Three-Runtime Landscape

The AI coding CLI ecosystem consolidated rapidly in the first half of 2026. Each major lab shipped its own CLI, and each made fundamentally different bets on where to draw the trust boundary.

**Claude Code** (Anthropic) runs locally, on your machine, with your credentials, your file system, and your shell. It operates with full ambient authority unless explicitly constrained. Its primary trust mechanism is the interactive permission prompt — every file write and shell command execution surfaces a confirmation dialog. Teams can encode project-level behavioral rules in `CLAUDE.md`, a plain-text configuration file that the agent reads at session start.

**Codex CLI** (OpenAI) initially shipped as a local CLI but evolved toward cloud-container execution by early 2026. Long-running tasks execute in OpenAI-managed sandboxes, which means disconnected operation (tasks continue without an open terminal) but also means the agent works within sandbox constraints when local environment variables matter. Its permission model is a three-tier graduated framework: Suggest (approve all changes), Auto-Edit (auto-apply file writes, approve external commands), and Full Auto (complete autonomy).

**Gemini CLI** (Google) took the most conservative default stance. As of v0.34.0 in March 2026, it defaults to Plan Mode — a read-only posture where the agent reads the codebase and proposes changes before making any edits. Trusted folder configuration restricts which directories the tool can modify. A "Yolo mode" exists for trusted workspaces, equivalent to Codex's Full Auto. Being Apache 2.0 licensed, its entire codebase is auditable.

## Permission Model Comparison

### Claude Code: Prompt-First with Declarative Restrictions

Claude Code's default mode requires explicit user approval for each sensitive operation. This creates an audit trail and ensures humans remain in the loop for consequential actions, at the cost of interrupting flow for repetitive tasks.

The `settings.json` file (project-level or user-level) extends this model with three additional layers:

- **allowlist**: Commands approved without prompting. Teams use this for read-only operations and low-risk build commands (`npm test`, `git status`).
- **ask**: Commands that always prompt regardless of context. High-risk operations like database migrations.
- **denylist**: Commands the agent is never permitted to execute. Intended as a hard security boundary.

A `CLAUDE.md` file layers behavioral instructions on top — coding standards, architectural constraints, workflow preferences — persisting across every session without consuming context window on re-explanation.

The practical result is that Claude Code feels like the most controllable of the three CLIs for teams with established governance requirements, but it assumes manual human supervision at each interaction.

### Codex CLI: Graduated Autonomy with Container Isolation

Codex's three-tier model maps cleanly to different risk appetites. Suggest mode is appropriate for unfamiliar codebases; Auto-Edit suits routine development; Full Auto targets CI-adjacent automation where human oversight is impractical.

The strongest differentiator is Docker-based sandboxing. In sandboxed mode, Codex restricts both network access and file system writes to the project directory. The agent cannot exfiltrate credentials, cannot reach external services, and cannot modify files outside the declared project root. This is a structural guarantee rather than a policy-level one — even if an attacker poisons the agent's instructions, the sandbox limits blast radius.

The tradeoff is environmental fidelity. If your build process depends on system-level tools, global configurations, or environment variables outside the container, sandboxed Codex will fail or produce incorrect results. Teams typically run sandboxed for untrusted input and unsandboxed for known-good workflows.

### Gemini CLI: Directory Scoping with Read-Only Default

Gemini CLI's trusted folder model is the simplest to reason about: you declare which directories the tool may modify, and operations outside those directories are blocked at the filesystem level. The Plan Mode default means that even within trusted folders, no writes happen until the user approves the diff.

This makes Gemini CLI the safest out-of-the-box option for developers onboarding to AI-assisted coding — the worst-case outcome of an accidental invocation is a proposed change, not a committed one. The downside is throughput: each cycle requires a review step that Claude Code and Codex Auto-Edit modes skip.

Gemini's open-source codebase also allows security teams to audit data transmission behavior directly, rather than relying on vendor attestation.

## The Claude Code Deny Rule Vulnerability

A high-severity vulnerability was disclosed against Claude Code's permission system and patched in v2.1.90. The root cause illuminates a broader design tension in AI agent security.

### Technical Details

The vulnerability lives in `bashPermissions.ts`. When Claude Code parses a shell command to decide whether it matches any deny rules, it walks the command's subcommand tree. As a performance optimization, the legacy regex parser gives up after encountering 50 subcommands joined by `&&`, `||`, or `;`. At that point, instead of applying deny rules, it falls back to a generic "ask" prompt.

This means an attacker who chains 50 innocuous commands (fifty `true` invocations, for example) followed by a malicious payload at position 51 will bypass deny rule evaluation entirely. A poisoned `CLAUDE.md` containing a realistic multi-step build process is sufficient delivery vehicle — the agent reads the file, executes the build sequence, and the forbidden operation (exfiltrating credentials via `curl`, for instance) executes without triggering the deny rule.

The internal tree-sitter parser correctly enforces deny rules regardless of command length, but it was not shipping to customers.

### Why This Matters Beyond the Specific Bug

The vulnerability is instructive because it reveals that AI agent security policies can silently degrade under load. The system does not fail closed — it fails open, substituting a weaker control (a prompt) for a stronger one (a deny). From a user perspective, nothing looks wrong; a dialog appears asking for permission. The deny rule is just never consulted.

This pattern — optimization paths that bypass security evaluation — is likely present in other CLIs as well. Any rule engine that applies heuristics to skip expensive checks creates potential bypass surface. Security teams auditing AI coding CLIs should specifically probe high-complexity commands and verify that deny rules remain enforced.

### Recommended Mitigations

Until deny rules can be trusted as a hard boundary again, the recommended mitigations are:

1. Apply deny rules before expensive parsing — deny checks are cheap string comparisons; they should run first, not last.
2. Default to deny on parse failure, not ask. If the system cannot analyze a command, the safe fallback is rejection, not a human prompt that most users will approve.
3. Treat deny rules as defense-in-depth, not as a primary security control. Layer OS-level restrictions (file permissions, container isolation) underneath.
4. Review all `CLAUDE.md` files received from external repositories before allowing Claude Code to read them.

## Context Persistence and Cross-Runtime Handoff

Teams operating in production environments often run more than one runtime. A common pattern: Claude Code for interactive local development, Codex for cloud-native CI automation, and Gemini CLI for security-sensitive tasks that benefit from plan review. How does context survive the transition?

### The State Portability Problem

No cross-framework serialization standard exists in production as of mid-2026. An agent session in Claude Code cannot hand off directly to a Codex container with its full context intact. Each transition is a cold start.

In practice, teams have converged on a HANDOFF.md artifact pattern — a human-readable markdown file committed to the repository that captures:

- Current task objective and scope
- Work completed (git references, not summaries)
- Pending decisions and blockers
- Assumptions that were validated during the session
- Files modified and rationale

This pattern succeeds because it is runtime-agnostic. Any CLI can read a markdown file. The file survives git, is auditable, and gives the receiving agent enough grounding to continue without re-exploring the entire codebase.

### Claude Code's Structural Advantage

`CLAUDE.md` functions as a persistent context layer across all Claude Code sessions. Teams that maintain a well-curated `CLAUDE.md` effectively pre-load architectural knowledge, coding standards, and workflow preferences into every session. This asymmetry matters for multi-runtime environments: Claude Code sessions start with project context pre-injected; Codex and Gemini sessions start cold unless you manually provide equivalent context.

Research into long-running agent deployments found that agents with structured handoff artifacts dramatically outperformed those relying on model memory alone. The pattern maps to `CLAUDE.md`: externalizing knowledge into files produces consistent behavior across sessions in a way that in-context instructions cannot.

### Context Loss at Scale

When agents hand off repeatedly, context degrades. Empirical measurement in multi-agent workflows shows measurable task output degradation appearing at 8-10 handoffs. Summarized context reduces token counts by 70-90% but introduces information loss and adds 500ms–1.5s of latency per handoff.

The practical implication: minimize handoff frequency and maximize session depth. Assign tasks to a single runtime and let it run to completion rather than splitting across runtimes mid-task. Use handoffs at natural task boundaries — completion of a feature, resolution of a bug — not in the middle of a complex multi-step workflow.

## Architectural Tier Model for Multi-Runtime Deployment

Production deployments in 2026 have converged on a three-tier model based on task characteristics:

**Tier 1 — Interactive (single session)**: Claude Code or Gemini CLI on the developer's machine. Human is present and supervising. Short tasks with immediate feedback loops. Permission prompts are acceptable because the developer is watching.

**Tier 2 — Supervised parallel (multiple local agents)**: Agent Teams or equivalent orchestration running multiple agents in isolated worktrees. A human reviews diffs and resolves conflicts. Each agent has its own context window and tool permissions. Appropriate for parallel feature development.

**Tier 3 — Cloud-native autonomous (no terminal required)**: Codex cloud containers or Claude Managed Agents. Tasks run in sandboxed environments with no human in the loop. Strongest isolation guarantees. Appropriate for CI automation, scheduled maintenance, and high-frequency repetitive tasks.

Each tier has different security implications. Tier 1 relies on human judgment in the loop. Tier 2 requires file-locking and conflict resolution infrastructure. Tier 3 requires the strongest pre-defined permission scoping because there is no human to catch errors.

## Emerging Interoperability Efforts

Several efforts aim to reduce the friction of cross-runtime operation:

**Open Agent Specification (Agent Spec)**: Describes execution graphs in a runtime-agnostic format, enabling task definitions to be expressed independently of the underlying CLI. Early adoption is limited but the specification is technically sound.

**Model Context Protocol (MCP)**: Anthropic's standardization of resource and data provision to agents. MCP servers can expose tools, context, and resources to any MCP-compatible client. In a multi-runtime world, an MCP server acts as a shared state layer — all runtimes connect to the same context source rather than maintaining independent representations.

**Agent2Agent (A2A) Protocol**: Google's proposal for standardized APIs enabling distributed agent communication across framework boundaries. If adopted broadly, A2A would allow a Gemini CLI session to formally hand off to a Claude Code session with structured context transfer rather than the current HANDOFF.md workaround.

None of these standards are stable enough for production reliance in Q2 2026, but MCP is closest. Teams building new infrastructure should design with MCP-compatible context sources from the start.

## Practical Recommendations for Production Teams

**For security-conscious deployments:**
- Do not treat Claude Code deny rules as a hard security boundary until you have verified the patched version (v2.1.90+) is deployed and tested against complex commands.
- Prefer Codex Docker sandboxing for untrusted input processing — it provides structural isolation that policy-level rules cannot guarantee.
- Audit any `CLAUDE.md` files received from external repositories before allowing Claude Code sessions to read them.

**For context persistence:**
- Maintain a project-level `CLAUDE.md` with architectural context, coding standards, and known pitfalls. This is the highest-leverage investment for Claude Code users.
- Use HANDOFF.md artifacts at task boundaries when switching runtimes. Commit them to git so they are version-controlled and auditable.
- Measure handoff depth — if a workflow requires more than 5-6 agent handoffs, restructure to reduce them.

**For multi-runtime architecture:**
- Assign runtimes to tiers based on isolation requirements, not model preference. Use Codex containers for anything running without human supervision.
- Use MCP servers as a shared context layer when multiple runtimes need access to the same project knowledge.
- Pin CLI versions in team tooling configurations. Security patches (like the deny rule fix) ship in minor versions and silent auto-updates can introduce regressions.

## Implications for the AI Agent Ecosystem

The divergence in permission models across Claude Code, Codex, and Gemini CLI reflects different answers to the same question: who should bear the cost of security decisions? Claude Code pushes that cost to humans through prompts. Codex pushes it to infrastructure through containers. Gemini pushes it to process through plan review defaults.

None of these is universally correct. The right choice depends on the threat model. An agent processing untrusted repository content needs structural isolation (Codex sandboxing). An agent working on proprietary IP in a high-trust environment benefits from the contextual awareness of Claude Code's `CLAUDE.md` system. A team onboarding to AI-assisted development benefits from Gemini's conservative plan-review defaults.

The deny rule vulnerability serves as a reminder that policy-level controls in AI agents are still maturing. We should not treat AI agent permission systems with the same confidence we extend to OS-level access controls. Defense-in-depth — combining runtime policies with infrastructure-level isolation with human review at key checkpoints — is the appropriate posture until the underlying security models stabilize.

The most durable pattern for 2026 is to treat each CLI's permission model as one layer in a defense stack, not as the sole security control. Runtime portability through structured artifacts (HANDOFF.md, `CLAUDE.md`, MCP context servers) reduces the coupling between runtime choice and operational capability. Teams that build for portability today will be better positioned as the interoperability standards mature through the second half of 2026.
