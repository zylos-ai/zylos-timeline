---
date: "2026-05-24"
title: "Multi-Agent Skill Sharing and Portable Capability Architectures"
description: "How AI agents share, discover, and compose reusable skills across platforms and organizations through open standards, federated registries, and trust frameworks"
tags: ["multi-agent", "skills", "MCP", "portability", "security", "federation"]
---

## Executive Summary

The AI agent ecosystem has undergone a fundamental shift in early 2026: capabilities are no longer hardcoded into individual agents but packaged as portable, composable skills that can be shared across platforms, teams, and organizations. The Agent Skills open standard (SKILL.md), originating from Anthropic's Claude Code in late 2025, has been adopted by over 30 agent platforms including OpenAI Codex, Google Gemini CLI, Cursor, and GitHub Copilot. This convergence has spawned federated registries, enterprise governance platforms, and an emerging marketplace economy — but also a significant supply chain security crisis, with over 1,200 malicious skills discovered in early 2026. This article examines the architectural patterns enabling multi-agent skill sharing, the federation and discovery mechanisms that connect distributed agents, the security challenges inherent in capability exchange, and what these developments mean for autonomous agent platforms like Zylos.

## The Agent Skills Open Standard

### From Hardcoded to Modular

Traditional agent implementations embed capabilities directly in code — a deployment script lives as a function, a code review workflow as a prompt template. The Agent Skills format inverts this pattern by packaging procedural expertise as filesystem-based, self-describing modules that any compatible agent can load and execute.

A valid Skill requires exactly one file: `SKILL.md`, containing YAML frontmatter followed by Markdown instructions. The minimal structure:

```
my-skill/
├── SKILL.md          # Required: metadata + instructions
├── scripts/          # Optional: executable automation
├── references/       # Optional: context documents
└── assets/           # Optional: templates, configs
```

The frontmatter declares identity and activation triggers:

```yaml
name: aws-ecs-deploy
description: Deploy containerised application to AWS ECS with Fargate
version: 1.2.0
triggers:
  - deploy
  - ecs
  - fargate
```

### Progressive Disclosure Architecture

Skills employ a three-level loading strategy that optimizes token economics:

1. **Level 1 (Discovery)**: Only name and description are loaded at startup — minimal token cost across potentially hundreds of available skills.
2. **Level 2 (Activation)**: Full SKILL.md instructions injected into context when a task matches trigger conditions.
3. **Level 3 (Execution)**: Scripts, reference documents, and assets loaded on demand during task execution.

This architecture mirrors the principle of "building an onboarding guide for a new hire" — the agent receives context progressively, exactly when needed, without overwhelming the context window upfront.

### Cross-Platform Portability

The format's power lies in its universality. A skill authored for Claude Code runs unchanged in OpenAI Codex, Google Gemini CLI, Cursor, JetBrains Junie, and dozens of other platforms. The timeline of adoption:

- **October 2025**: Anthropic introduces the format in Claude Code
- **November 2025**: OpenAI adopts for Codex CLI
- **December 2025**: Open standardization; Vercel launches skills.sh as the first package manager
- **January 2026**: Google integrates into Gemini CLI (then Antigravity)
- **Q1 2026**: 30+ agent platforms declare compatibility

Each platform may extend the standard with proprietary features (Claude Code has `.claude/agents/` for subagents; Codex has its own conventions), but the core SKILL.md contract ensures portability across the ecosystem.

## Multi-Agent Skill Sharing Patterns

### Workspace-Level Sharing (Multica Model)

Multica, an open-source orchestration engine, demonstrates the most direct skill sharing pattern: skills registered to a workspace are immediately available to every agent in that workspace, regardless of underlying runtime.

Key architectural decisions in Multica:

- **PostgreSQL + pgvector storage**: Skills and their semantic embeddings live alongside issues, agents, and activity feeds — enabling vector-similarity-based skill discovery.
- **Multi-provider coordination**: Agents running Claude Code, Codex, or OpenClaw all access identical skill definitions without adaptation layers.
- **Experiential learning**: When one agent solves a novel deployment problem, the resulting skill becomes available to all agents on the team for subsequent similar tasks.

The limitation: cross-workspace sharing is not yet first-class. Skills operate within organizational boundaries, not across them.

### Registry-Mediated Discovery (MCP Federation)

The Model Context Protocol (MCP) provides the complementary connectivity layer. While Skills package procedural knowledge, MCP standardizes how agents connect to external tools via JSON-RPC 2.0 with three primitives: tools, resources, and prompts.

The MCP Gateway Registry pattern enables federation across organizational boundaries:

```
┌─────────────────────────────────────────────────┐
│              Agent (any platform)                 │
└──────────────────────┬──────────────────────────┘
                       │ tools/list
┌──────────────────────▼──────────────────────────┐
│              MCP Gateway / Registry              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│  │ Auth     │  │ RBAC     │  │ Health   │      │
│  │ Layer    │  │ Filter   │  │ Monitor  │      │
│  └──────────┘  └──────────┘  └──────────┘      │
└───────┬──────────────┬──────────────┬───────────┘
        │              │              │
   ┌────▼────┐    ┌────▼────┐   ┌────▼────┐
   │ MCP     │    │ MCP     │   │ MCP     │
   │ Server A│    │ Server B│   │ Server C│
   └─────────┘    └─────────┘   └─────────┘
```

The gateway implements a three-plane architecture:

1. **Inbound authentication**: Validates bearer tokens against multiple methods (PAT, Virtual Account Token, IdP JWT, OAuth)
2. **Registry query + schema resolution**: Returns cached tool schemas with freshness guarantees
3. **RBAC filtering**: Applies tool-level access control before aggregating the unified response

Federation between registry instances uses the `PeerFederationService`, which synchronizes metadata between local registries and configured peers — enabling agents to discover tools regardless of which specific registry originally registered them.

### Enterprise Governance (Nacos 3.2 Model)

Alibaba's Nacos 3.2 Skill Registry represents the enterprise governance approach: a centralized trust layer implementing "trust after verification" between agents and skills.

Key governance mechanisms:

- **Lifecycle stages**: Draft → Under Review → Gray (canary) → Formal → Offline, with immutable versions at each stage
- **Security review pipeline**: 10+ built-in risk scans with plugin-based extension; admission principle of "if it doesn't pass, it won't be published"
- **Three-layer permission model**: RBAC roles (publisher, reviewer, read-only), namespace isolation for teams, and skill-level visibility controls (public/private/scoped)
- **Multi-protocol agent coordination**: Supports A2A Protocol 1.0.0 with planned ACP and Matrix protocol integration for cross-platform interoperability

The system manages skills alongside other AI resources (Prompts, MCP servers, AgentCards) in a unified registry, with a roadmap toward "Agent Team Spec" for collaborative multi-agent network construction.

## The Marketplace Economy

### Ecosystem Growth

The agent skills ecosystem expanded from one registry (December 2025) to eight major marketplaces by Q2 2026:

| Platform | Focus | Notable Feature |
|----------|-------|-----------------|
| skills.sh (Vercel) | Package manager | CLI-first, npm-like experience |
| AgentExchange | General marketplace | Cross-platform compatibility ratings |
| Agentspace | Enterprise | Governance-first, SOC2 compliance |
| ClawHub | OpenClaw ecosystem | Largest community (and largest attack surface) |
| Agensi | Curated/security-reviewed | 8-point security checklist |
| HiMarket (Alibaba) | Enterprise China | Nacos-integrated governance |
| Microsoft Marketplace | Copilot ecosystem | Enterprise licensing integration |
| awesome-agent-skills | Open-source directory | 1000+ curated community skills |

The unit of exchange is **capability, not code** — each skill ships with a permission manifest declaring what it reads, writes, and what endpoints it calls, alongside the skill bundle itself and often an accompanying MCP server.

### Economic Model

Skills follow the app-store model: free community skills drive adoption while premium skills (enterprise integrations, regulated-industry compliance) generate revenue. The installed base of 30+ compatible agent platforms creates sufficient demand to sustain a marketplace economy where skill authors can monetize specialized expertise.

## Supply Chain Security Crisis

### The Scale of the Problem

The rapid growth of skill marketplaces has attracted sophisticated attacks:

- **ClawHavoc campaign** (January–February 2026): 1,200+ malicious skills infiltrated the OpenClaw marketplace, distributing credential theft malware including Atomic macOS Stealer
- **MalTool catalogue**: 6,487 malicious tools identified that evade conventional detection
- **Empirical finding**: 26.1% of 42,447 community skills contain vulnerabilities; skills with bundled scripts increase risk 2.12x

### Attack Vectors

Security researchers identified four primary attack primitives:

1. **Install count manipulation**: Unauthenticated API endpoints allow artificial inflation of popularity metrics through simple GET requests with no rate limiting or token validation
2. **Non-deterministic scanning**: Security audits occur only at creation and popularity thresholds, creating exploitation windows for bait-and-switch attacks
3. **Silent skill override**: Installing a skill with an identical name replaces the original without confirmation — enabling hijacking of trusted skills
4. **Blind bulk updates**: All installed skills update simultaneously without per-skill version pinning, changelogs, or review

### Attack Flows

- **Bait-and-Switch**: Publish benign code, pass initial scans, inject malicious instructions before subsequent audits
- **Nested Injection**: Create innocent skills that programmatically install additional malicious skills with telemetry disabled
- **Delayed Weaponization**: Build legitimate, widely-adopted skills, then push malicious updates universally

### Trust and Verification Framework

The research community has proposed a four-tier trust governance model (T1–T4) with graduated verification gates:

| Gate | Method | Purpose |
|------|--------|---------|
| G1 | Static analysis | Detect vulnerability signatures |
| G2 | LLM-based semantic classification | Identify intent mismatches between description and behavior |
| G3 | Behavioral sandbox execution | Reveal invisible side effects |
| G4 | Permission manifest validation | Compare declared vs. observed behavior |

Trust tiers map to permissions: T1 skills receive instruction-only access with full tool isolation; T4 skills receive full capabilities including network and filesystem access.

## Architectural Trade-offs

### Centralized vs. Federated Discovery

| Dimension | Centralized Registry | Federated Mesh |
|-----------|---------------------|----------------|
| **Governance** | Single authority, clear accountability | Distributed trust, complex consensus |
| **Latency** | Single hop, cached schemas | Multi-hop federation sync delays |
| **Resilience** | Single point of failure | Degraded gracefully |
| **Cross-org sharing** | Requires explicit grants | Natural discovery across peers |
| **Security** | Unified scanning pipeline | Inconsistent policies across peers |

The emerging consensus favors a **hybrid model**: centralized governance within organizations (Nacos-style) with federated discovery across organizational boundaries (MCP Gateway-style).

### Skills vs. MCP: Complementary, Not Competing

A common misconception positions Skills and MCP as alternatives. They serve distinct roles:

| Dimension | Agent Skills | MCP |
|-----------|-------------|-----|
| **Role** | Procedural knowledge (how to do things) | Tool connectivity (what can be done) |
| **Unit** | Directory with SKILL.md | Server with JSON-RPC endpoints |
| **Modifies** | Agent context + permissions | Available tools and data sources |
| **Persistence** | Filesystem-resident, version-controlled | Runtime connections, ephemeral |

The highest-leverage pattern combines both: a Skill provides the procedural knowledge for a workflow, while MCP servers supply the tool connectivity that workflow requires. The Skill knows *how* to deploy; MCP provides *access* to the deployment infrastructure.

### Scalability Limits

Research reveals a critical finding: single-agent systems with skill libraries exhibit a **phase transition** beyond a critical library size where skill selection accuracy degrades sharply. This indicates fundamental scalability limits to the "one agent, many skills" approach and argues for multi-agent architectures where specialized agents hold focused skill sets rather than a single agent attempting to master hundreds of capabilities.

## Relevance to Zylos

The Zylos architecture already implements several patterns that align with the emerging industry consensus:

1. **Filesystem-based skills**: Zylos skills in `~/.claude/skills/` follow the SKILL.md standard with progressive disclosure loading — the same format now adopted across 30+ platforms.

2. **Workspace-level sharing**: Skills registered in the Zylos workspace are available to all runtime sessions, matching the Multica workspace-sharing model.

3. **Component-based extensibility**: The `zylos add` component management system provides governed installation with review capabilities — addressing the supply chain concerns that plague open marketplaces.

4. **Security-first approach**: Zylos's CLAUDE.md mandates skill security review before execution, implementing a manual version of the G1–G4 verification gates.

Opportunities for enhancement:

- **Federated discovery**: Connecting to external MCP registries would allow Zylos agents to discover and consume tools from the broader ecosystem without manual configuration
- **Skill export**: Publishing Zylos-developed skills to public registries (with appropriate security review) could contribute to the ecosystem while establishing presence
- **Trust scoring**: Implementing automated trust tier assessment for third-party skills before installation would formalize the current manual review process
- **Multi-agent skill routing**: As Zylos supports multiple runtime agents, implementing skill-based routing (directing tasks to agents with the most relevant loaded skills) would optimize capability utilization

## Conclusion

The convergence on portable agent skills represents one of the most significant architectural shifts in AI systems since the introduction of function calling. In less than eight months, the ecosystem has moved from proprietary, hardcoded agent capabilities to an open standard with cross-platform portability, marketplace distribution, and federated discovery. However, this rapid growth has outpaced security infrastructure — the 26.1% vulnerability rate in community skills and sophisticated supply chain attacks demonstrate that the "install and trust" model of traditional package managers is insufficient for AI agent capabilities that execute with elevated privileges.

For autonomous agent platforms, the strategic imperative is clear: embrace the open standard for maximum ecosystem leverage while implementing governance layers (trust tiers, behavioral sandboxing, permission manifests) that protect against the supply chain risks inherent in capability sharing. The platforms that solve this trust-at-scale problem will define the next generation of multi-agent collaboration.

## References

1. Agent Skills for Large Language Models: Architecture, Acquisition, Security, and the Path Forward — arXiv:2602.12430v3
2. Towards Secure Agent Skills: Architecture, Threat Taxonomy, and Security Analysis — arXiv:2604.02837v1
3. Formal Analysis and Supply Chain Security for Agentic AI Skills — arXiv:2603.00195
4. MCP Gateway Registry — github.com/agentic-community/mcp-gateway-registry
5. TrueFoundry: Building a Centralized MCP Registry Architecture — truefoundry.com
6. Nacos 3.2 Skill Registry — Alibaba Cloud
7. Orca Security: Supply Chain Attack Vectors in AI Agent Skills Marketplace
8. OWASP GenAI Exploit Round-up Report Q1 2026
9. Agent Skills Specification — agentskills.io/specification
10. Multica Skills System — flowtivity.ai
