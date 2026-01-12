---
date: "2026-01-10"
title: "AI Observability & LLM Monitoring 2026"
description: "Research notes on AI Observability & LLM Monitoring 2026"
tags:
  - research
---


*Research Date: 2026-01-10*

## Executive Summary

LLM observability market has matured with 89% of enterprises implementing agent observability. Market fragmented into tracing (Langfuse, Helicone) and evaluation (Braintrust, Phoenix) layers. No single tool dominates.

## Key Platforms Comparison

| Platform | Type | License | Free Tier | Paid |
|----------|------|---------|-----------|------|
| **Langfuse** | Tracing+Eval | MIT | 50k obs/mo | $59/mo |
| **LangSmith** | LangChain-native | Commercial | 5k traces/mo | $39/user/mo |
| **Phoenix** | OpenTelemetry | ELv2 | Full local | Cloud prod |
| **Helicone** | Gateway/Proxy | Open source | Yes | - |
| **Braintrust** | CI/CD Eval | Commercial | 1M spans | $249/mo |
| **Datadog** | Enterprise | Commercial | - | Usage-based |

## Critical Metrics

### Latency
- **E2E Latency**: Total request-to-response time
- **TTFT**: Time to First Token
- **P95/P99**: Tail latencies (averages mislead!)

### Quality
- **Hallucination Rate**: Industry avg 8.2% (down from 38% in 2021)
- **Best systems**: 0.7-1.3% (GPT-4o, Gemini 2.0)

### Cost
- Track per user/feature/conversation
- Outcome-aligned: cost per successful task

## Integration Patterns

### 1. Proxy-Based (Helicone)
```
App → Proxy Gateway → LLM Provider
```
One-line integration, minimal code changes.

### 2. SDK/Decorator (Langfuse, Weave)
```python
@observe()
def my_llm_function():
    pass
```

### 3. OpenTelemetry-Native (Phoenix)
Vendor-neutral, route to any backend.

## Evaluation Approaches

### LLM-as-a-Judge
- 80% agreement with human evaluators
- Known biases: position (40% inconsistency), verbosity (~15%)
- Best practice: pairwise comparisons > direct scoring

### Automated Evals
- Reference-based: BLEU, ROUGE
- Reference-free: internal consistency
- Task-specific: summarization, Q&A

## Hallucination Detection

| Method | Speed | Accuracy |
|--------|-------|----------|
| Phoenix | 2s/test | 90% |
| W&B Weave | Slower | 91% |
| HaluGate | 76-162ms | Token-level |

## Recommendations

| Use Case | Best Platform |
|----------|---------------|
| LangChain projects | LangSmith |
| Multi-framework | Langfuse, Phoenix |
| Fast deployment | Helicone (proxy) |
| Enterprise compliance | Langfuse self-hosted |
| RAG applications | Phoenix |
| CI/CD workflows | Braintrust |
| Existing observability | OpenLLMetry |

## Key Insight

The market has specialized: use a **gateway tool** (Helicone/Portkey) for cost tracking + an **evaluation tool** (Phoenix/Braintrust) for quality. OpenTelemetry standardization is enabling vendor-neutral tracing.

---

*New topic - not previously covered in KB*
