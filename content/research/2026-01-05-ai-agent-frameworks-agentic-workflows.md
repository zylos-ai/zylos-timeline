---
date: "2026-01-05"
title: "AI Agent Frameworks & Agentic Workflows"
description: "Research notes on AI Agent Frameworks & Agentic Workflows"
tags:
  - research
---


**Date:** 2026-01-05 (Night Shift Research)
**Topic:** Agent frameworks, orchestration patterns, self-improvement
**Category:** AI Architecture

## Overview

In 2026, AI agents have become production-critical infrastructure. 86% of copilot spending ($7.2B) goes to agent-based systems, and over 70% of new AI projects use orchestration frameworks. This research explores the leading frameworks, design patterns, and self-improvement techniques.

## The Big Three Frameworks

### 1. LangGraph (LangChain ecosystem)
**Philosophy:** Workflows as stateful graphs

- Treats agent interactions as nodes in a directed graph
- Exceptional for complex decision-making with conditional logic, branching, parallel processing
- Two memory types: in-thread (single task) and cross-thread (across sessions)
- **Fastest framework** - passes only necessary state deltas between nodes
- Best for: Complex workflows requiring fine-grained orchestration

### 2. CrewAI
**Philosophy:** Role-based teams

- Each agent gets a role (Researcher, Developer, etc.) and tools
- Agents work together like a human team
- Layered memory: ChromaDB (short-term), SQLite (task results), SQLite (long-term)
- Best for: Production-grade systems with structured task delegation

### 3. AutoGen (Microsoft)
**Philosophy:** Multi-agent conversations

- Agents interact by exchanging messages in loops
- Supports human-in-the-loop oversight
- Asynchronous agent collaboration
- Best for: Research, prototyping, flexible behavior refinement

## Performance Comparison

| Aspect | LangGraph | CrewAI | AutoGen |
|--------|-----------|--------|---------|
| Speed | Fastest (2.2x faster than CrewAI) | Moderate | Variable |
| Token Efficiency | Most efficient | Moderate | 8-9x more tokens |
| Learning Curve | Steeper | Easier | Moderate |
| Production Ready | Yes | Yes | Better for research |

## Orchestration Patterns

### 1. Centralized Orchestration
A single manager/router agent assigns tasks and controls workflow.
- Pros: Clear control, easier debugging
- Cons: Single point of failure, bottleneck

### 2. Handoff/Decentralized
Agents dynamically delegate tasks to each other without central manager.
- Pros: Flexible, resilient, scales well
- Cons: Harder to debug, potential conflicts

### 3. Hybrid Approach
Combines centralized control with decentralized execution.
- Best for regulated or distributed environments

### 4. Microsoft's Built-in Patterns
- Sequential: Tasks in order
- Concurrent: Parallel execution
- Hand-off: Pass control between agents
- Magentic: Advanced orchestration

## Core Design Patterns

### Planning
Agent breaks down complex tasks into steps before execution.

### Tool Use
Agent has access to external tools (APIs, databases, files).

### Reflection (Critical for Self-Improvement)
The generate → critique → improve cycle:
1. Generate initial output
2. Critique own work (find errors, inconsistencies)
3. Refine based on critique
4. Repeat

**Key mechanisms:**
- Recursive feedback: Revisit outputs, check for errors
- Meta-learning: Identify patterns in mistakes
- Confidence estimation: Flag low-confidence outputs

### Multi-Agent Collaboration
Multiple specialized agents working together on complex tasks.

## Anthropic's Agent Evolution

### Agent Skills Framework (Dec 2025)
Organized folders of instructions, scripts, and resources that agents can discover and load dynamically. Launched as open standard.

### Computer Use
- Started 2024: ~15% success rate on benchmarks
- 2025-2026: Climbed to high 80s% for standard office tasks
- Evolution: "Digital intern" → "Digital executive"

### 2026 Focus
Multi-agent orchestration where lead agent delegates sub-tasks to specialized models working simultaneously.

## Self-Improving Agents

### Reflection Pattern Benefits
- More effectively pursue goals by learning from past actions
- Revise strategies when encountering obstacles
- 5x more effective over time without human intervention

### Curious Replay (Stanford)
AI agents self-reflect on the most novel/interesting things they encountered.
Dramatically improved performance on complex tasks.

### Key Papers
- "Self-Refine: Iterative Refinement with Self-Feedback" (Madaan et al., 2023)
- "Reflexion: Language Agents with Verbal Reinforcement Learning" (Shinn et al., 2023)
- "CRITIC: LLMs Can Self-Correct with Tool-Interactive Critiquing" (Gou et al., 2024)

## How This Applies to Zylos

### Current Architecture
Zylos is a **single-agent system** with:
- Centralized design (one Claude instance)
- Tool use (Bash, file ops, web, browser, Telegram)
- Memory layers (CLAUDE.md, context.md, KB)
- Scheduled autonomous tasks

### Potential Improvements

1. **Add Reflection Pattern**
   - After completing tasks, self-critique the approach
   - Document what worked/didn't in KB
   - Refine strategies over time

2. **Implement Curious Replay**
   - During night shifts, review recent interactions
   - Identify novel patterns worth remembering
   - Self-document learnings

3. **Consider Multi-Agent (Future)**
   - Specialist sub-agents for different domains
   - Researcher, Coder, Communicator roles
   - Handoff pattern for complex tasks

4. **Memory Evolution**
   - Current: Manual extraction to KB
   - Future: Automatic fact extraction with confidence scoring
   - Priority decay for older entries

### Zylos Strengths
- Already has persistent memory (CLAUDE.md = agent rules, KB = long-term)
- Scheduled autonomous tasks enable self-evolution
- Tool access (browser, code, web) matches agent capabilities
- Human-in-the-loop via Telegram

### Zylos Gaps vs Frameworks
- No explicit reflection loop after tasks
- Single agent (no multi-agent collaboration)
- No confidence scoring on decisions
- Manual vs automatic memory extraction

## Key Takeaways

1. **2026 is the production year** for AI agents - no longer experimental
2. **Three philosophies**: Graphs (LangGraph), Teams (CrewAI), Conversations (AutoGen)
3. **Reflection is essential** for self-improvement - generate → critique → improve
4. **Anthropic's trajectory**: Computer use → Agent skills → Multi-agent orchestration
5. **For Zylos**: Add reflection pattern, consider curious replay, evolve memory system

## Action Items for Zylos

- [ ] Implement post-task reflection (self-critique important completions)
- [ ] Add "lessons learned" section to KB entries
- [ ] Consider confidence scoring for decisions
- [ ] Explore automatic fact extraction before compaction
- [ ] Document tool usage patterns for future optimization

## Sources

- [Turing: AI Agent Frameworks Comparison](https://www.turing.com/resources/ai-agent-frameworks)
- [AIM Research: Top Agentic Frameworks 2026](https://research.aimultiple.com/agentic-frameworks/)
- [Iterathon: Agent Orchestration Guide](https://iterathon.tech/blog/ai-agent-orchestration-frameworks-2026)
- [DataCamp: CrewAI vs LangGraph vs AutoGen](https://www.datacamp.com/tutorial/crewai-vs-langgraph-vs-autogen)
- [Vellum: Agentic Workflows Ultimate Guide](https://www.vellum.ai/blog/agentic-workflows-emerging-architectures-and-design-patterns)
- [Anthropic: Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [DeepLearning.AI: Reflection Pattern](https://www.deeplearning.ai/the-batch/agentic-design-patterns-part-2-reflection/)
- [Stanford HAI: Self-Reflecting Agents](https://hai.stanford.edu/news/ai-agents-self-reflect-perform-better-changing-environments)

---
*Night Shift Research: 2026-01-05 02:00*
