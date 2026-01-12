---
date: "2026-01-08"
title: "LLM Structured Output & Tool Use Patterns 2025"
description: "Research notes on LLM Structured Output & Tool Use Patterns 2025"
tags:
  - research
---


> Learned: 2026-01-08
> Topic: Tool Use, Function Calling, Structured Output

---

## Key Insights

1. **Programmatic Tool Calling** (Anthropic) - 37% token reduction, 19+ fewer inference passes
2. **Constrained Decoding** is production-ready - Outlines, XGrammar, llguidance
3. **Hybrid Agentic Patterns** - Combine ReAct + Planning + Reflection for production
4. **Output tokens cost ~4x input** - Reducing output has highest latency impact

---

## Structured Output Methods

| Method | Use Case | Notes |
|--------|----------|-------|
| **JSON Mode** | Basic | No schema guarantee |
| **Structured Outputs** | Production | Schema-guaranteed via logit biasing |
| **Constrained Decoding** | Self-hosted | FSM/grammar-based enforcement |

**Constrained Decoding Libraries:**
- **Outlines**: FSM-based, 97% success rate, 0.4% hallucination
- **XGrammar**: Pushdown automata for complex grammars
- **llguidance**: Super-fast (50μs CPU/token)

---

## Schema Design Best Practices

**OpenAI Strict Mode:**
```json
{
  "additionalProperties": false,
  "required": ["all", "fields"],
  "strict": true
}
```

**General Principles:**
- Use Pydantic for schema generation + validation
- Clear, descriptive tool names
- Comprehensive type information
- Modular, reusable components

---

## Multi-Step Tool Use Patterns

### Core Orchestration Patterns

| Pattern | Strength | Cost |
|---------|----------|------|
| **ReAct** | Fast, flexible | Lower deliberation |
| **Planning** | Structured multi-step | Upfront planning overhead |
| **Reflection** | Self-critique quality | Higher deliberation |

**Production: Use hybrid approach combining all three.**

### Parallel Execution
- **LLMCompiler**: Auto-identifies parallel vs sequential tasks
- **M1-Parallel**: 2.2x speedup with concurrent agents

### Programmatic Tool Calling (Anthropic)
Claude writes Python scripts to orchestrate workflows:
- 37% token reduction
- 19+ fewer inference passes
- Tool results processed by script, not added to context

---

## Error Handling

**Retry Patterns:**
1. **Tenacity Library**: Exponential backoff, validation recovery
2. **LLM-Assisted Retries**: Resubmit output + error to LLM
3. **Circuit Breakers**: Monitor failures, preemptive fallbacks

**Multi-Layer Architecture:**
- User-level: Frontend reprocessing
- Database-level: Transient error retry
- Application-level: Exception catching

---

## Grounding & Verification

**Best Practices:**
1. RAG with span-level verification
2. Post-hoc consistency checking
3. Knowledge graph integration
4. Self-verification (reflection, consistency, questioning)

**Philosophy Shift 2025:**
- From "zero hallucinations" to "managing uncertainty"
- Design for transparency: confidence scores, "no answer found"

---

## Performance Optimization

**Highest Impact:**
- Output token reduction (50% tokens → 50% latency reduction)
- Output tokens cost ~4x input tokens

**Other Optimizations:**
- Keep prompts concise
- Aggressive RAG filtering (3 small chunks > 10 large)
- KV caching, semantic caching
- H100 GPU: 2-3x faster than A100

**Key Principle:** Not every problem needs an LLM call

---

## Provider Comparison

| Provider | Focus | Special Features |
|----------|-------|------------------|
| **OpenAI** | Consumer AI | Parallel function calling, strict mode |
| **Anthropic** | Enterprise coding | Programmatic tool calling, tool search |
| **Google** | Multimodal/scale | 1M token context, Workspace integration |

**Pricing (per 1M tokens):**
- Claude Sonnet 4: $3 input / $15 output
- Claude Opus 4.1: $15 input / $75 output

---

## 2025 Key Trends

1. Agent-native APIs with multimodal I/O
2. Programmatic tool orchestration
3. Massive context windows (200k-1M tokens)
4. Guardrails as standard practice
5. Multi-agent over single general agents
6. Tool use as commodity (all providers support)
7. Coding agents breakout (Claude Code, GPT Codex)

---

## Model Selection Guide

| Complexity | Recommended |
|------------|-------------|
| Complex/ambiguous | Claude Opus/Sonnet 4.5, GPT-4.1 |
| Straightforward | Claude Haiku |
| Multimodal | Gemini 2.5 Pro |
| Cost-sensitive | Grok, Gemini |

---

## Implementation Frameworks

- **LangChain**: Memory classes, multi-step orchestration
- **LangGraph**: State machine workflows, enterprise reliability
- **CrewAI**: Role-based multi-agent
- **vLLM**: Supports Outlines, XGrammar for self-hosted
