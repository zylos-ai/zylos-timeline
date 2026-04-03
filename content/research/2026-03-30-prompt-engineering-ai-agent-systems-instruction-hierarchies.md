---
date: "2026-03-30"
title: "Prompt Engineering for AI Agent Systems: System Prompts, Tool Descriptions, and Instruction Hierarchies"
description: "How production AI agent systems structure their prompts at the system level — covering the constitutional document pattern, tool description best practices, instruction priority hierarchies, context window management, multi-turn coherence, and real examples from Claude Code, Cursor, Devin, and MCP."
tags: ["ai-agents", "prompt-engineering", "system-prompts", "tool-use", "security", "production-engineering", "context-management"]
---

## Executive Summary

Production AI agent systems have moved far beyond basic prompt tips into sophisticated prompt architecture. All major agents (Claude Code, Cursor, Devin, Codex) converge on a five-layer system prompt anatomy: identity framing, behavioral rules, typed tool APIs, safety layers, and conditional sections assembled at runtime. Claude Code's system prompt alone is 110+ separate instruction strings totaling 16,000-25,000 tokens. Tool descriptions have become a critical engineering surface — vague descriptions are the primary driver of tool selection errors, and 31 tools add approximately 4,500 tokens per query. Instruction hierarchy (system > user > tool output) is now trained into models, achieving +63% defense against prompt extraction, though RL-based attacks still achieve 98% bypass rates against current defenses. The dominant multi-turn pattern across all production agents is plan-execute-observe-repeat with bounded iterations, but even 90%+ single-turn accuracy degrades to 10-15% success across full multi-step conversations — making coherence the central unsolved challenge.

## System Prompt Architecture: The Constitutional Document Pattern

### Five-Layer Anatomy

All major production agents converge on a common structure:

1. **Identity framing** — "You are X, built by Y" (~100 tokens). Sets the agent's role and capabilities.
2. **Behavioral rules** — Task execution principles, reversibility guidelines, tone, output format. The operational constitution.
3. **Typed tool APIs** — Explicit per-tool instruction sections beyond just JSON schemas. How to use each tool, when to prefer one over another, what side effects to expect.
4. **Safety layers** — Embedded as operational rules woven throughout the prompt, not a separate block. Security is architectural, not appended.
5. **Conditional sections** — Mode-specific instructions (plan mode, auto mode, minimal mode) assembled dynamically at runtime.

Claude Code's system prompt is not a monolithic document but 110+ separate instruction strings conditionally assembled based on context — active tools, current mode, project configuration, and skill invocations.

### Project-Layer Overrides: CLAUDE.md and .cursorrules

CLAUDE.md is dynamically injected as a `<system-reminder>` block, not hardcoded into the base prompt. This enables repository-specific behavior without modifying the base agent. The skills architecture extends this further: SKILL.md files are loaded only when invoked ("on-demand prompt expansion"). Cursor's `.mdc` rules files follow the same pattern — project-level behavioral overrides without touching the core system prompt.

### Evolution: Shorter and Less Prescriptive

The long-term trend in system prompt design is toward brevity. Claude Code 2.0 (Sonnet 4.5, September 2025) shifted from `"MUST"` to `"should"`, from `"NEVER"` to `"NEVER... unless explicitly instructed"`, and removed entire code-convention blocks that the model had absorbed through RLHF training. The exception: safety-critical instructions (git operations, destructive actions) got tighter, not looser — addressing real incidents from earlier versions.

The principle: as model capability increases, reduce prompt verbosity. Find the smallest set of high-signal tokens that maximize the likelihood of the desired outcome.

## Tool Description Best Practices

### The Choice Overload Problem

Tool hallucinations come in two forms: function selection errors (calling non-existent or wrong tools) and parameter hallucination (fabricating input values). The root cause is often choice overload — presenting all tool descriptions in every prompt. At 31 tools, descriptions alone consume approximately 4,500 tokens per query with measurable accuracy degradation.

### Engineering Tool Descriptions

| Practice | Rationale |
|----------|-----------|
| State purpose, constraints, and side effects explicitly | Vague descriptions force the model to guess behavior |
| One clear domain per tool | Multi-purpose tools create ambiguous selection signals |
| Disclose side effects upfront | Hidden consequences lead to misuse |
| Strong typed input schemas with ranges and patterns | Ambiguous inputs drive parameter hallucination |
| Include usage guidance and follow-up steps | Reduces mid-task confusion |

The primary test: if a human engineer cannot definitively say which tool to use in a given situation, an AI agent cannot be expected to do better.

### Semantic Tool Filtering

Production systems should filter tools before the agent sees them — use vector similarity against the current query to load only relevant tool definitions. This is the same principle as the on-demand skill loading architecture: do not pay the context cost for tools the agent will not need in the current step.

### MCP Tool Description Standards

MCP standardizes tool descriptions across providers. Tools declare side effects via `readOnlyHint` and `destructiveHint` annotations. Critical security note: treat tool description annotations as untrusted unless from a verified server — descriptions themselves are an injection vector.

```json
{
  "name": "specific_verb_noun",
  "description": "Clear purpose. Constraints. Side effects. Usage guidance.",
  "inputSchema": { "type": "object", "properties": {}, "required": [] },
  "annotations": { "readOnlyHint": true, "destructiveHint": false }
}
```

## Instruction Hierarchy and Priority

### The Formal Model

Without explicit hierarchy, LLMs treat all inputs equally — enabling injection through any channel.

```
Priority 0  — System messages (application developer)
Priority 10 — User messages (end user)
Priority 30 — Tool output (web results, API responses, third-party content)
```

OpenAI trained GPT-3.5 Turbo with two techniques for hierarchy enforcement: Context Synthesis (aligned responses) and Context Ignorance (teaching the model to answer "as if it never saw" conflicting lower-priority instructions). Results: +63% system prompt extraction defense, +30% jailbreak robustness, generalizing to unseen attack types.

### The Arms Race

RL-Hammer attacks achieved approximately 98% success against GPT-4o's Instruction Hierarchy defense. Training-based hierarchy is necessary but not sufficient against adaptive adversaries. Prompt injection remains OWASP LLM Top 10 #1 in 2025.

### Practical Layered Defense

1. XML/delimiter separation between instruction blocks and user data
2. Filter known injection patterns: "ignore previous", "act as", DAN variants
3. LLM guardrails layer (Bedrock Guardrails, Azure AI Content Safety, NeMo)
4. RAG source authentication — 5 poisoned documents can manipulate 90% of RAG responses
5. Structured queries — treat user input as data structures, not natural language (USENIX Security 2025)

## Context Window Management

### Static vs Dynamic Content

| System Prompt (Static) | Dynamic Injection (Just-in-Time) |
|------------------------|----------------------------------|
| Identity and role | Retrieved documents / RAG results |
| Core behavioral rules | Current file or code being edited |
| Tool definitions | Conversation summary |
| Security constraints | User profile and preferences |
| Output format guidance | Skill instructions (on invocation) |

### Three Long-Horizon Strategies

**Compaction**: Summarize conversation history and reinitiate with compressed summaries. Preserve architectural decisions and unresolved problems; discard redundant tool outputs. Best for conversational tasks.

**Structured note-taking**: Persistent external memory (CLAUDE.md, session files) outside the context window. The agent reads and writes to external files rather than relying on in-context history. Best for iterative development with clear milestones.

**Sub-agent architectures**: Clean context windows per sub-agent, returning condensed summaries (1,000-2,000 tokens) to the coordinator. Always scope what the sub-agent sees — suppress ancestral history. Best for parallel exploration and preventing context contamination.

## Multi-Turn Agent Coherence

### The Coherence Gap

Agents scoring 90%+ on individual tool calls succeed in only 10-15% of full multi-step conversations. Context drift and goal loss emerge across turns, not within single turns. This is the central unsolved challenge in agent engineering.

### Production Coherence Mechanisms

**One-action-per-iteration loops**: All production agents use plan → execute → observe → repeat. Each iteration is bounded to a single meaningful action.

**Verifiable intermediate goals**: Tests as ground truth. Cursor's pattern: write failing tests first, implement until they pass. This provides objective checkpoints independent of model confidence.

**Iteration limits with hooks**: Cursor's `.cursor/hooks.json` loops agents until a success condition is met, with a maximum iteration cap. Autonomous completion without infinite loops.

**Fresh context for subtasks**: Start a new conversation when switching tasks or when the agent shows confusion. Sub-agent architectures provide clean windows by design.

**Goal re-injection**: For very long tasks, periodically re-inject the original goal to counter drift. Devin's planning phase before each major action implements this pattern.

### Research Direction

Multi-turn PPO with both outcome rewards and intermediate step rewards produces significantly more coherent long-horizon behavior than single-turn training — beginning to appear in production model capabilities.

## Production System Examples

### Claude Code (v2.1.87)

- 110+ conditional instruction strings, 16-25K tokens at runtime
- Skills loaded via meta Skill tool call, not embedded in system prompt
- Tool permissions scoped per skill invocation via `contextModifier` (least-privilege)
- 40+ conditional system reminders injected based on context
- CLAUDE.md as project-level override, dynamically injected

### Cursor

- Minimal edits mandate: `// ... existing code ...` markers to prevent full rewrites
- `.cursor/rules/` for persistent project context, `.cursor/commands/` for reusable workflows
- Natural language skill matching — skill descriptions are themselves the routing signal
- Hooks-based iteration loops for agent autonomy with bounds

### Devin

- Full-stack engineer scope: planning, coding, testing, deployment
- Citation-mandatory: file path + line numbers for every claim ("code archaeology" framing)
- Planning phase before each major action serves as goal re-injection

## Implications for AI Agent Platform Design

1. **System prompts are software, not prose.** Treat them as conditionally assembled code with version control, testing, and gradual rollout. Claude Code's 110+ instruction strings are individually testable units.

2. **Tool descriptions are the highest-leverage prompt surface.** A well-written tool description prevents more errors than pages of behavioral instructions. Invest engineering time in tool descriptions proportional to their impact on agent accuracy.

3. **On-demand loading is the scaling pattern.** Do not load all tools, all skills, and all context into every prompt. Load identity + rules always; load everything else only when needed. This is how you scale to hundreds of tools without degrading accuracy.

4. **Instruction hierarchy must be both trained and enforced.** Training-level hierarchy defenses are necessary but breakable. Layer runtime defenses (input filtering, output validation, structured queries) on top.

5. **Multi-turn coherence requires architectural solutions**, not just better prompts. Bounded iteration loops, verifiable checkpoints (tests), sub-agent isolation, and periodic goal re-injection are engineering patterns, not prompt tricks.

6. **Reduce prompt length over time.** As models absorb conventions through training, remove redundant instructions. The optimal system prompt shrinks as the model improves — but safety constraints should tighten, not loosen.

## Sources

- Piebald-AI/claude-code-system-prompts — complete Claude Code prompt decomposition
- Anthropic Engineering: Effective Context Engineering for AI Agents
- arXiv:2404.13208 — The Instruction Hierarchy: Training LLMs to Prioritize Privileged Instructions
- Cursor: Agent Best Practices (official blog)
- MCP Specification 2025-11-25 and MCP Best Practices
- USENIX Security 2025: Structured Queries Defense against Prompt Injection
- OWASP LLM01:2025 — Prompt Injection
- arXiv:2505.11821 — Multi-Turn RL for Long-Horizon Agent Tasks
