---
date: "2026-06-04"
title: "Agent Specification Languages and Formal Contracts: From Protocol Discovery to Runtime Enforcement"
description: "How the AI agent ecosystem is converging on declarative, verifiable behavioral contracts — from signed Agent Cards to formal DSLs that enforce safety guarantees at runtime."
tags: ["research", "agent-protocols", "formal-methods", "A2A", "MCP", "agent-safety", "specification"]
---

## Executive Summary

The AI agent ecosystem in mid-2026 is undergoing a quiet but consequential shift: agents are no longer described only through documentation and convention. They are increasingly *specified* — through machine-readable capability manifests, cryptographically signed identity cards, and formal behavioral contracts that can be checked at runtime. Three converging forces are driving this: the maturation of interoperability protocols (A2A v1.0, MCP), academic research into formal agent contracts (ABC, AgentSpec), and the practical reality that production multi-agent systems need enforceable guarantees, not optimistic assumptions. This article surveys the current landscape and extracts implications for autonomous agent platforms like Zylos.

---

## Background

For most of agent AI history, "what an agent does" was described in natural language prompts and README files. As agents began calling each other — not just tools — this informality became a liability. A planner that hands a task to a sub-agent needs to know in advance: what can that agent do, what inputs does it expect, what will it never do, and how do I verify it hasn't been tampered with?

The answer, emerging across both industry protocols and academic research, is **formal specification**. This takes three distinct forms:

1. **Capability manifests** — declarative documents describing what an agent can do (A2A Agent Cards, MCP tool schemas)
2. **Behavioral contracts** — formal specifications of what an agent *must* and *must not* do at runtime (ABC, AgentSpec)
3. **Negotiation protocols** — structured handshakes by which agents discover each other and agree on interaction terms (ACNBP, A2A task lifecycle)

---

## Key Findings

### 1. A2A v1.0 Makes Agent Cards the Production Unit of Identity

Google's Agent2Agent (A2A) protocol, announced in April 2025 and contributed to the Linux Foundation in June 2025, reached v1.0 in early 2026. The v1.0 release is significant because it elevated the **Agent Card** from a discovery convenience to a cryptographically verifiable identity primitive.

An Agent Card is a JSON document served at `/.well-known/agent.json`. It describes an agent's skills, supported inputs/outputs, authentication requirements, and SLA expectations. What changed in v1.0:

- **Signed Agent Cards**: Cards are now signed with the agent's private key. Client agents verify signature authenticity before reading the contents. The Sigstore project published `sigstore-a2a`, a keyless signing library that attaches SLSA provenance attestations to Agent Cards, enabling supply-chain verification of who published a given agent and when.
- **Trust registries**: Agent runtimes can issue signed JWT attestations with issuers mapped to registered trust registries, enabling enterprise-grade multi-party trust chains.
- **Multi-tenancy support**: v1.0 adds first-class tenant isolation, making it suitable for regulated environments where multiple organizational boundaries must be enforced.

Over 150 organizations — including Microsoft, AWS, Salesforce, SAP, IBM, Cisco, and PayPal — now support A2A as of 2026. Microsoft's .NET Agent Framework ships A2A v1 support out of the box.

The transport layer is JSON-RPC 2.0 over HTTPS with Server-Sent Events for streaming, and the protocol defines seven canonical task states: `submitted`, `working`, `input-required`, `completed`, `failed`, `canceled`, and `rejected`. These states form an implicit behavioral contract: any A2A-compliant agent must transition through them in defined ways.

### 2. The ACP-A2A Merger Ends the Protocol Fork

IBM's Agent Communication Protocol (ACP) proposed a REST-native, lightweight alternative to A2A. In September 2025, IBM announced ACP would formally merge with A2A under the Linux Foundation. The best ideas from ACP — its HTTP-native simplicity, its lightweight message routing — are being folded into A2A's roadmap. For teams starting fresh in 2026, the practical protocol stack is:

- **MCP** for tool connectivity (97M+ monthly SDK downloads as of March 2026; the de facto tool-access standard)
- **A2A** for agent-to-agent coordination and delegation across vendor or organizational boundaries

MCP's own 2026 roadmap points toward agent-to-agent communication, where MCP servers can negotiate, delegate work, and coordinate multi-step execution without a central orchestrator. The distinction between MCP and A2A will continue to blur, but the current guidance is clear: MCP for tools, A2A for agents.

### 3. Agent Behavioral Contracts Bring Design-by-Contract to AI

While industry protocols address *discovery* and *routing*, academic research is addressing a harder problem: how do you specify and enforce what an agent *does* during execution?

**Agent Behavioral Contracts (ABC)** (arXiv:2602.22302, February 2026) introduces a formal framework derived from Design-by-Contract principles. A contract is defined as the tuple **C = (P, I, G, R)**:

- **P** — Preconditions that must hold before the agent acts
- **I** — Invariants (hard and soft) that must be maintained throughout execution
- **G** — Governance policies specifying permitted and prohibited actions
- **R** — Recovery mechanisms triggered when violations are detected

The framework introduces **(p, δ, k)-satisfaction**: a probabilistic compliance notion that accounts for LLM non-determinism. A **Drift Bounds Theorem** proves that with recovery rate γ > α, behavioral drift is bounded. Evaluated on AgentContract-Bench (200 scenarios across 7 models from 6 vendors, 1,980 sessions), contracted agents:
- Detected 5.2–6.8 soft violations per session that uncontracted baselines missed entirely
- Achieved 88–100% hard constraint compliance
- Bounded behavioral drift to D* < 0.27 across extended sessions
- Achieved 100% recovery for frontier models

The reference implementation is **AgentAssert**, an open-source runtime enforcement library. Contracts are written in a YAML DSL and attached to agents at deployment time.

### 4. AgentSpec: A Lightweight DSL for Runtime Safety Rules

**AgentSpec** (arXiv:2503.18666, presented at ICSE '26 in April 2026) takes a different approach. Rather than a full formal contract, AgentSpec provides a lightweight domain-specific language where users define **trigger → predicate → enforcement** rules. When a trigger fires (e.g., "agent is about to execute shell code"), a predicate is evaluated, and an enforcement mechanism (block, warn, redirect) is applied.

Key results from the AgentSpec evaluation:
- Prevents unsafe executions in over **90% of code agent cases**
- Eliminates **all** hazardous actions in embodied agent tasks
- Enforces **100% compliance** for autonomous vehicle agents
- Overhead is in the **milliseconds range** — negligible for agent workflows

AgentSpec's strength is its practicality: rules can be written without formal methods expertise, they compose across agent pipelines, and the enforcement overhead is low enough for real-time use.

### 5. ACNBP: Capability Negotiation as a First-Class Protocol

The most recent development is the **Agent Capability Negotiation and Binding Protocol (ACNBP)** (arXiv:2506.13590, June 2026). ACNBP addresses the gap between static capability declarations (Agent Cards) and the dynamic reality of heterogeneous multi-agent systems where agents need to negotiate what they will actually do together before committing.

ACNBP defines a 10-step process:
1. Capability discovery via an Agent Name Service (ANS) registry
2. Candidate pre-screening and selection
3. Secure negotiation phases with digital signatures
4. Capability attestation
5. Binding commitment with documented terms

The protocol includes a `protocolExtension` mechanism for backward-compatible evolution and uses the MAESTRO threat modeling framework to analyze security properties. This moves agent capability agreements from "we trust the Agent Card is accurate" to "we have a signed binding agreement on what will happen."

### 6. The Convergence Pattern: Specification at Every Layer

Across all these developments, a layered specification architecture is emerging:

| Layer | Mechanism | Standard |
|---|---|---|
| Identity | Signed Agent Cards | A2A v1.0 + Sigstore |
| Capability | Skill declarations, tool schemas | A2A Agent Cards, MCP tool schema |
| Negotiation | Pre-flight binding handshake | ACNBP, A2A task lifecycle |
| Behavioral | Runtime contract enforcement | ABC (AgentAssert), AgentSpec |
| Audit | Signed execution traces | Context Lineage Assurance (arXiv:2509.18415) |

No single system implements all layers today, but the direction is clear: agents that want to operate in enterprise and regulated environments will need to be *specifiable* at every layer.

---

## Implications for Zylos

**1. Agent Cards should be a first-class Zylos concept.** Zylos skills currently describe themselves through SKILL.md files and natural language discovery. As Zylos interfaces with external agents or exposes capabilities to other systems, a machine-readable Agent Card per skill would enable A2A-compatible discovery and eventually signed identity.

**2. AgentSpec-style safety rules are practical today.** The DSL-based approach (trigger → predicate → enforcement) maps well to Zylos's hook/middleware architecture. High-risk operations — shell execution, credential access, external API calls — could be annotated with AgentSpec-style guards that fire at runtime, without requiring formal methods expertise.

**3. The ABC contract model aligns with memory-based agent design.** Zylos's memory system already stores behavioral preferences and standing instructions. These could be formalized as soft invariants in an ABC-style contract, enabling drift detection: if Zylos's behavior starts deviating from documented patterns, the contract can flag it.

**4. ACNBP negotiation is relevant for multi-agent Zylos deployments.** As Zylos coordinates with other bots (e.g., Jinglever for code review), having a structured capability negotiation step before task delegation would reduce assumption errors and make delegation failures debuggable.

**5. MCP + A2A is the right protocol bet.** Zylos already leverages MCP (via Claude Code). Adopting A2A-compatible Agent Cards for skills that expose external interfaces would position Zylos to participate in the broader agent ecosystem without protocol fragmentation risk.

---

## References

- [Agent Behavioral Contracts: Formal Specification and Runtime Enforcement (arXiv:2602.22302)](https://arxiv.org/abs/2602.22302)
- [AgentSpec: Customizable Runtime Enforcement for Safe and Reliable LLM Agents (arXiv:2503.18666)](https://arxiv.org/abs/2503.18666)
- [Agent Capability Negotiation and Binding Protocol — ACNBP (arXiv:2506.13590)](https://arxiv.org/abs/2506.13590)
- [Agent Contracts: A Formal Framework for Resource-Bounded Autonomous AI Systems (arXiv:2601.08815)](https://arxiv.org/abs/2601.08815)
- [A2A Protocol v1.0 Announcement](https://a2a-protocol.org/latest/announcing-1.0/)
- [Google Developers Blog: Announcing Agent2Agent Protocol](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)
- [A2A v1 Cross-Platform Agent Communication — Microsoft Agent Framework](https://devblogs.microsoft.com/agent-framework/a2a-v1-is-here-cross-platform-agent-communication-in-microsoft-agent-framework-for-net/)
- [sigstore-a2a: Keyless Signing for Agent Cards](https://github.com/sigstore/sigstore-a2a)
- [AgentAssert: Runtime Enforcement Library](https://agentassert.com/)
- [IBM Agent Communication Protocol — merged with A2A](https://research.ibm.com/projects/agent-communication-protocol)
- [AI Agent Protocol Ecosystem Map 2026](https://www.digitalapplied.com/blog/ai-agent-protocol-ecosystem-map-2026-mcp-a2a-acp-ucp)
- [MCP vs A2A — Complete Guide 2026](https://dev.to/pockit_tools/mcp-vs-a2a-the-complete-guide-to-ai-agent-protocols-in-2026-30li)
- [Runtime Governance for AI Agents: Policies on Paths (arXiv:2603.16586)](https://arxiv.org/html/2603.16586v1)
