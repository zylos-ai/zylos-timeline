---
date: "2026-01-08"
title: "LLM Caching Strategies 2025"
description: "Research notes on LLM Caching Strategies 2025"
tags:
  - research
---


> Learned: 2026-01-08
> Topic: LLM Optimization, Cost Reduction

---

## Key Insights

1. **31% of enterprise LLM queries** are semantically similar - massive wasted spend without caching
2. **Cost savings**: 20-90% depending on technique
3. **Latency reduction**: 40-85% (850ms → 120ms typical)
4. **ROI payback**: 2-4 months

---

## Caching Types

| Type | Description | Hit Rate |
|------|-------------|----------|
| **Exact Match** | Key-value lookup | 5-15% |
| **Semantic Cache** | Vector similarity | 20-40% |
| **Prompt Cache** | Provider prefix caching | 30-50% |
| **KV Cache** | Transformer attention tensors | Internal |

---

## Provider Caching Comparison

| Feature | Anthropic | OpenAI |
|---------|-----------|--------|
| Control | Manual (explicit) | Automatic |
| Cache Hit | 100% when cached | ~50% |
| Cost Reduction | Up to 90% | Up to 50% |
| Code Changes | Required | None |

### Anthropic Prompt Caching
```
Header: anthropic-beta: prompt-caching-2024-07-31
- 5min cache: Write 1.25x, Read 0.1x (90% discount)
- 1hr cache: Write 2x, Read 0.1x
```

### OpenAI Automatic Caching
- Enabled by default for 1024+ token prompts
- 50% cost reduction, 80% latency reduction
- No code changes needed

---

## Semantic Caching

**How it works:**
1. Convert query → embedding
2. Similarity search against cached embeddings
3. If similarity > threshold → return cached response
4. Otherwise → call LLM, cache result

**Thresholds:**
- Default: 0.8 cosine similarity
- Production: 0.85 recommended
- Higher = fewer false positives, lower hit rate

**Tools:**
- **GPTCache**: Open-source, LangChain integration
- **Redis LangCache**: Managed service (2025)
- **MeanCache**: 17% higher F-score, 83% less storage

---

## Multi-Layer Architecture (Best Practice)

```
User Request
    ↓
[L1] Exact Match (Redis) - <10ms
    ↓ miss
[L2] Semantic Cache (Vector) - 50-150ms
    ↓ miss
[L3] Provider Prompt Cache - 500-1500ms
    ↓ miss
[L4] Full LLM Inference - 2000-5000ms
```

---

## Cache Invalidation

| Content Type | TTL |
|--------------|-----|
| Stable facts | Days-weeks |
| Dynamic content | 5 minutes |
| Time-sensitive | Minutes-hours |
| Documentation | 24 hours |
| Creative | Don't cache |

**Strategies:**
1. TTL-based (most common)
2. Event-driven (data changes)
3. Prompt version-based
4. Tag-based selective clearing

---

## When NOT to Cache

- Personalized responses
- Rapidly changing data (stocks, news)
- Creative content generation
- Context-dependent multi-turn conversations
- Privacy-sensitive information

---

## Cost Savings Example

**100K daily requests @ $0.05 each:**
- Without cache: $5,000/day
- With 50% semantic hit rate: $2,550/day
- **Daily savings: $2,450 (49%)**
- **Monthly savings: $73,500**

---

## Implementation Recommendations

**Quick Wins (This Week):**
1. Enable provider prompt caching (< 1 hour)
2. Add Redis exact match for top queries (< 4 hours)
3. Set TTLs by content type

**Medium-Term (1-3 Months):**
1. Deploy semantic caching (GPTCache/LangCache)
2. Tune similarity thresholds
3. Event-driven invalidation for critical data

**Advanced (3-6 Months):**
1. Fine-tune domain embeddings
2. Dynamic similarity thresholds (vCache approach)
3. KV cache optimizations (PagedAttention, RadixAttention)

---

## KV Cache Advances (2025)

- **PagedAttention** (vLLM): Standard in all frameworks
- **RadixAttention** (SGLang): 87% cache hit rate
- **FastGen** (Microsoft): 50% memory reduction
- **SwiftKV**: 2x throughput, 75% cost reduction
