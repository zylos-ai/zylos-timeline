---
date: "2026-01-11"
title: "AI Agent Memory Systems 2026"
description: "Research notes on AI Agent Memory Systems 2026"
tags:
  - research
---


*Research Date: 2026-01-11*

## Executive Summary

AI agent memory has evolved from simple conversation buffers to sophisticated multi-tier cognitive architectures. Memory is now recognized as "the cornerstone of foundation model-based agents." Key insight: Store **understanding** (knowledge networks) rather than **mechanical action sequences**.

## Three Core Memory Types

| Type | Purpose | Example |
|------|---------|---------|
| **Episodic** | Time-stamped events, "what happened when" | User rescheduled meeting on Thursday |
| **Semantic** | Factual knowledge, "what do I know" | Python is a programming language |
| **Procedural** | Workflows/skills, "how to do" | Steps to generate financial report |

### Knowledge vs Memory Distinction

- **Knowledge**: Facts true for all users (stable, shared)
- **Memory**: Personal, dynamic, unique per user (evolves)

## Storing "Understanding" vs Action Sequences

### Modern Approaches

**A-Mem (Zettelkasten Method)** - NeurIPS 2025:
- Creates "atomic notes" with rich context, keywords, tags
- Memories form interconnected knowledge networks
- Captures understanding, not just action logs
- 85-93% token reduction

**Procedural Memory with Templates**:
- Turns successful trajectories into reusable patterns
- Enables few-shot learning by referencing similar past situations

**Temporal Knowledge Graphs**:
- Represent trajectories as graphs with action dependencies
- Time as first-class citizen for temporal reasoning

## Open-Source Frameworks

### Mem0 (41K+ GitHub stars)
- **Architecture**: Vector DB + Graph DB + Key-Value store
- **Performance**: 26% higher accuracy than OpenAI, 90% token savings
- **Usage**:
```python
from mem0 import Memory
m = Memory()
m.add("I prefer morning meetings", user_id="howard")
results = m.search("schedule preference", user_id="howard")
```

### Letta (MemGPT evolution)
- **Architecture**: Core Memory (essential) + Recall Memory (searchable) + Archival Memory (long-term)
- **Feature**: Self-editing memory via tool calling
- **Status**: #1 on Terminal-Bench

### A-Mem
- Zettelkasten-inspired interconnected knowledge networks
- Doubled performance in complex reasoning
- <$0.0003 per memory operation

### MIRIX
- First multimodal multi-agent memory system
- 6 memory types with Meta Memory Manager
- 35% higher accuracy than RAG baseline

## Best Practices for Memory Retrieval

1. **Hybrid Storage**: Combine vector (semantic), graph (relationships), key-value (fast facts)
2. **Scoped Retrieval**: User-level, session-level, agent-level memories
3. **Context Engineering**: Governed, explainable, adaptive context injection
4. **Memory Maintenance**: Automated deduplication, consolidation, pruning

## Recommendations for Zylos

Based on this research, for our site-specific knowledge caching:

1. **Use Semantic Memory Model**: Store "understanding" of site structure as factual knowledge
2. **Zettelkasten-style Linking**: Connect related knowledge (Twitter → social media → posting patterns)
3. **Scoped by Domain**: `x.com`, `xiaohongshu.com` as memory scopes
4. **Retrieval by URL**: Domain extraction → knowledge lookup → context injection

Example structure:
```json
{
  "domain": "x.com",
  "type": "semantic",
  "knowledge": {
    "reply_button": "[data-testid='reply']",
    "editor": "[data-testid='tweetTextarea_0']",
    "view_count_pattern": "aria-label contains '次查看'"
  },
  "procedural_notes": "先点帖子进详情页再回复",
  "last_updated": "2026-01-11"
}
```

## Market Context

- Gartner: 40% of enterprise apps will embed AI agents by end of 2026
- Agent market: $7.8B → $52B by 2030
- Memory recognized as key differentiator for production agents

---
*Extension of previous memory research (2026-01-04). Directly relevant to current browser automation site knowledge caching discussion.*
