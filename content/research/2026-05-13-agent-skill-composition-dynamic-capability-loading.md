---
date: "2026-05-13"
title: "Agent Skill Composition: Dynamic Capability Loading in Production"
description: "How modular SKILL.md packages enable LLM agents to discover, load, and compose capabilities at runtime — architecture, routing at scale, and security findings."
tags: ["agent-skills", "dynamic-loading", "skill-routing", "composability", "mcp", "production"]
---

## Executive Summary

A new architectural pattern is consolidating across LLM agent platforms: the **agent skill**. Rather than hardcoding capabilities or bloating context windows with every available tool, skills are self-describing, markdown-based packages that an agent loads on demand. The SKILL.md format — originated at Anthropic and now an open standard — structures capabilities as directories with metadata, instructions, scripts, and reference files loaded progressively as a task demands. This article covers the three-tier loading model, the emerging challenge of skill selection at scale (routing over 80K+ skills is a solved problem, but only barely), critical security findings (26.1% of published skills contain vulnerabilities), and practical implementation patterns for production agent systems.

## What Is an Agent Skill?

A skill is not a tool. Tools are atomic functions — a single API call or shell command. Skills are domain-specific capability packages that bundle:

- **Instructions** — procedural knowledge telling the agent *how* to work
- **Scripts** — executable code the agent can invoke
- **References** — supplementary documentation loaded on demand
- **Assets** — templates, schemas, lookup data

The distinction matters architecturally. An MCP server exposes tools (connectivity layer); a skill teaches the agent to use those tools in context-appropriate ways (intelligence layer). They are complementary, not competing abstractions.

The minimal SKILL.md format is a YAML frontmatter block followed by Markdown instructions:

```markdown
---
name: pdf-processing
description: Extract text and tables from PDF files, fill PDF forms, merge multiple PDFs. Use when the user mentions PDFs, forms, or document extraction.
license: Apache-2.0
metadata:
  author: example-org
  version: "1.0"
allowed-tools: Bash(python3:*) Read Write
---

## Steps
1. Determine operation: extraction, form-filling, or merge
2. Run scripts/extract.py with the target file path
...
```

Key schema constraints: name max 64 chars (lowercase, hyphens only), description max 1024 chars (keyword-rich for routing), optional `allowed-tools` for declarative permission pre-approval.

## Progressive Disclosure: The Three-Tier Loading Model

The architectural insight that makes large skill libraries viable is **progressive disclosure** — loading only what the current task requires:

| Tier | Content | Token Budget | Trigger |
|------|---------|-------------|---------|
| 1 — Metadata | name + description for all skills | ~100 tokens/skill | Session start |
| 2 — Instructions | Full SKILL.md body | <5,000 tokens (recommended) | Skill activation |
| 3 — Resources | scripts/, references/, assets/ | As needed | On-demand read |

At session start, only skill metadata (names and descriptions) is injected into the system prompt. The agent's LLM then acts as the router — it reads task intent, matches it against descriptions, and calls a `load_skill` tool to pull Tier 2 content. Reference files and scripts are fetched only when the executing instructions reference them.

This design allows hundreds of skills to be "registered" in a system with a total Tier 1 overhead of perhaps 10,000 tokens — manageable — while the actual working context at any point contains only the 1–3 skills the current task requires. The recommendation to keep SKILL.md bodies under 500 lines enforces this discipline.

## Routing at Scale: From Metadata to 80K Skills

When skill libraries grow into the thousands, LLM-based routing from metadata descriptions alone breaks down. The ecosystem has produced two distinct approaches:

### LLM-Native Routing (Small Libraries)

For libraries under ~100 skills, the standard pattern suffices: construct a dynamic "meta-tool" description aggregating all skill names and descriptions, inject it into the system prompt, and let the LLM select. No external retrieval required.

### Embedding-Based Retrieval (Large Libraries)

Research on routing over 80,000 skills (SkillRouter, 2026) establishes a **two-stage retrieve-and-rerank** pipeline as the production standard:

1. **Bi-encoder retrieval**: A 0.6B encoder retrieves top-20 candidates from the full library using full-text embeddings (HNSW index)
2. **Cross-encoder reranking**: A 0.6B reranker scores candidates against the query using full skill documentation

A 1.2B parameter configuration achieved **74.0% Hit@1** while running 5.8× faster than 16B baseline models, with 495ms median serving latency.

The critical finding: **full skill body text is essential for routing signal**. Routing from metadata alone (name + description) caused performance drops of 31–44 percentage points across all retrieval methods. This directly invalidates the assumption that well-written descriptions suffice at scale — the implementation content itself encodes routing signal.

Two training adaptations proved essential for homogeneous skill pools:
- **False-negative filtering** (removing near-duplicate skills that corrupt contrastive learning): +4.0pp improvement
- **Listwise training** (ranking candidates against each other rather than scoring independently): +30.7pp improvement over pointwise approaches

### The SkillRet Benchmark

SkillRet (2026) provides the first large-scale benchmark for skill retrieval: 17,810 curated skills across 6 major categories, 4,997 evaluation queries, 63,259 training samples. Key findings:

- Off-the-shelf retrieval models achieve 66.55 NDCG@10 — substantially below useful
- Domain-specific fine-tuning reaches 83.45 NDCG@10 (+16.9 points)
- **MTEB Retrieval rankings do not predict skill retrieval performance** — general retrieval benchmarks are poor proxies
- Hardest categories: Information Retrieval, AI Agents; Easiest: Data & ML
- Skill documents average 1,583 tokens vs. typical tool descriptions of ~100 tokens

The implication: skill retrieval is a specialized subdomain that requires purpose-built models and benchmarks, not off-the-shelf semantic search.

## Skill Acquisition: Beyond Human-Authored

The human-authored model (write a SKILL.md, commit it) works for known capabilities. Research in 2025–2026 explored automated acquisition:

| Method | Result |
|--------|--------|
| Human-Authored | 62,000+ GitHub stars (Oct 2025 launch) |
| SAGE (RL + Sequential Rollout) | +8.9% task completion, −59% token usage |
| SEAgent (Autonomous, curriculum learning) | 11.3% → 34.5% success on novel software tasks |
| CUA-Skill (Structured) | 57.5% SOTA on WindowsAgentArena |
| Compositional Synthesis | 91.6% performance on AIME 2025 |

SAGE's −59% token reduction is particularly striking: reinforcement learning can discover skill decompositions that are dramatically more efficient than human intuition, packaging workflows in ways that avoid redundant context injection.

A critical caveat: skill compilation research identifies a **phase transition phenomenon** — beyond certain library sizes, selection accuracy degrades sharply. The routing systems above are the engineering response to this discovery.

## Security: The Open Ecosystem's Hidden Risk

Three concurrent studies (Oct 2025 – Feb 2026) converged on alarming findings about publicly available skill packages:

- **26.1% of skills contain at least one vulnerability**
- Data exfiltration via credential harvesting: 13.3% of vulnerable skills
- Privilege escalation through capability abuse: 11.8%
- Skills bundling executable scripts are **2.12× more vulnerable** than instruction-only skills
- Confirmed malicious skills averaged 4.03 vulnerabilities spanning multiple kill-chain stages

### The Four-Gate Trust Model

A proposed governance framework maps skill provenance through progressive verification:

| Gate | Method | Detects |
|------|--------|---------|
| G1 — Static Analysis | Pattern matching, dependency scanning | Known malicious patterns |
| G2 — LLM Semantic Classification | Intent mismatch detection | Disguised capabilities |
| G3 — Behavioral Sandbox | Side-effect monitoring | Runtime data exfiltration |
| G4 — Permission Validation | Formal capability declarations | Privilege scope violations |

This maps to trust tiers T1–T4:
- **T1 (unvetted)**: Instructions-only execution, full tool isolation
- **T2–T3**: Graduated permissions based on provenance and review
- **T4 (vendor-certified)**: Full capabilities enabled

Runtime trust can evolve — anomalous behavior triggers demotion; clean execution histories enable promotion. The `allowed-tools` frontmatter field is the primitive that makes declarative permission scoping possible.

## Production Implementation Patterns

### The Skill Composition Architecture

For production systems, the mature pattern combines:

1. **SkillRegistry**: Central catalog with metadata index, category organization, tag-based cross-indexing, and automatic OpenAI-compatible tool schema generation
2. **DynamicSkillLoader**: Resource-constrained async loading with priority queuing and memory limits
3. **SkillRouter**: Two-stage retrieval for large libraries; LLM-native for small ones
4. **SkillSecurityManager**: Enforces SecurityPolicy objects (permissions, data classifications, input validation) before any skill execution

### Composing Multi-Skill Workflows

Skills compose through explicit orchestration — a `ResearchReportSkill` might invoke a `WebSearchSkill`, then a `DataAnalystSkill`, then a `DocumentGenerationSkill` sequentially. The agent coordinates these as a workflow, with each skill responsible for a bounded domain.

Anti-pattern: allowing skills to invoke other skills directly without agent coordination. This creates implicit dependency graphs that are hard to audit and prone to trust inheritance bugs (a T1-tier skill shouldn't be able to invoke T4-tier capabilities through a composition chain).

### Observability

Production skill systems benefit from per-skill metrics:
- Execution count and success rate
- Latency distribution
- Routing accuracy (was the right skill selected?)
- Context overhead per activation

The skill dependency graph — which skills co-activate — surfaces unexpected coupling and routing failures that aggregate metrics miss.

## The Skills + MCP Stack

The clearest mental model for the emerging agentic stack:

```
User Task
    ↓
Skill Router (selects procedural intelligence)
    ↓
SKILL.md Body (teaches the agent how to work)
    ↓
MCP Tools (connectivity: data sources, APIs, services)
    ↓
Result
```

MCP handles *what* can be connected; skills handle *how* to use those connections effectively. An agent with MCP access to a database but no skill for data analysis will thrash. An agent with a data-analysis skill but no MCP database connection has knowledge with no execution path.

The [Agent Skills specification](https://agentskills.io/specification) formalizes the SKILL.md format as an open standard. As of May 2026, over 2,636 skills are publicly available across Claude Code, Codex, and compatible platforms, with the catalog doubling roughly quarterly.

## Open Challenges

1. **Cross-platform portability**: Skills written for Claude Code's tool invocations may not translate directly to Codex or other runtimes
2. **Skill composition safety**: Multi-skill workflows can create implicit trust inheritance chains that bypass per-skill security gates
3. **Selection at scale**: Even 74% Hit@1 at 80K skills means 1 in 4 tasks routes incorrectly — a significant failure rate in production
4. **Continual learning without forgetting**: How skills themselves improve from agent usage without introducing capability drift
5. **Bridging learned and externalized skills**: Model-internal capabilities (encoded in weights) and SKILL.md artifacts remain disconnected — an agent can't easily "extract" what it knows into a skill
6. **Evaluation metrics**: Standard benchmarks don't measure reusability, composability, or cross-agent transferability

## Key Takeaways

- The SKILL.md format (metadata + instructions + progressive resource loading) is the emerging standard for packaging agent capabilities as first-class, version-controlled artifacts
- Skill routing at scale requires purpose-built retrieval systems — general semantic search underperforms by 16+ NDCG points
- Full skill body text, not just descriptions, is essential routing signal — contra the intuition that good descriptions suffice
- Security is a first-order concern: 26.1% of open-source skills contain vulnerabilities; the four-gate trust model provides a mitigation framework
- MCP and skills are complementary layers: skills provide procedural intelligence, MCP provides connectivity
- The ecosystem is maturing fast — from an experimental pattern to a production discipline with dedicated benchmarks, security research, and framework support across all major agent platforms