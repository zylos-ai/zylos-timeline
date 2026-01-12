---
date: "2026-01-08"
title: "RAG Architectures 2025: Deep Dive"
description: "Research notes on RAG Architectures 2025: Deep Dive"
tags:
  - research
---


> Learned: 2026-01-08
> Topic: Retrieval-Augmented Generation

---

## Key Insights

1. **Chunking is king** - More important than retrieval method choice (65% → 92% accuracy improvement)
2. **Hybrid retrieval dominates** - Dense + sparse = 53.4% top-1 recall (vs 48.7% dense alone)
3. **Reranking is non-negotiable** - 35% hallucination reduction
4. **Latency drives business** - Not just operational, affects customer acquisition/retention

---

## Core RAG Patterns

| Pattern | Use Case | Key Features |
|---------|----------|--------------|
| **Naive RAG** | Prototypes | Simple retrieve-read pipeline |
| **Advanced RAG** | Production | Pre/post-retrieval optimization |
| **Modular RAG** | Enterprise | Reconfigurable modules, multi-source |

---

## Chunking Strategies

**Optimal settings:**
- Size: 256-512 tokens
- Overlap: 10-20% (50-100 tokens)
- Method: Structure-aware (Markdown/HTML headers) → Recursive

**Impact:** Semantic chunking provides 70% accuracy improvement but costs more compute.

---

## Retrieval Methods

| Method | Top-1 Recall | Notes |
|--------|--------------|-------|
| Dense (BERT) | 48.7% | Good semantic understanding |
| Sparse (BM25) | 22.1% | Good for exact matches |
| **Hybrid** | **53.4%** | Best of both worlds |

**Advanced techniques:**
- **SPLADE**: Learned sparse embeddings with term expansion
- **ColBERT**: Late interaction, separately encodes query/doc
- **HyDE**: Generate hypothetical answer, embed, retrieve similar

---

## Reranking

**Cross-encoders:** +28% NDCG@10, production standard
**LLM-based:** Highest accuracy but expensive (+0.9s latency)
**Optimal candidate set:** 50-75 documents

---

## Latest Innovations (2024-2025)

### Self-RAG
Self-reflective system using reflection tokens. **52% reduction in hallucinations**.

### Corrective RAG (CRAG)
Confidence scoring + web search fallback when below threshold.

### GraphRAG
Knowledge-graph based retrieval. **99% search precision** (vs 70-80% traditional).

### Agentic RAG
LLM breaks complex queries into parallel subqueries.

---

## Production Considerations

### Latency Breakdown (typical 2-7s)
- Query Processing: 50-200ms
- Vector Search: 100-500ms
- Document Retrieval: 200-1000ms
- Reranking: 300-800ms
- LLM Generation: 1000-5000ms

### Optimization Strategies
- **Batching:** 65-70% latency reduction
- **Caching:** Embed cache, document cache, result cache
- **Scope Reduction:** Metadata filtering, query routing
- **Smart model routing:** 60-80% cost reduction

### Target Metrics
- Answer Rate: ≥90%
- Cost per 1K calls: $2-8
- Mean Time to Answer: <3 seconds

---

## Decision Tree

```
Starting RAG project?
├─ Chunking: Recursive (256-512 tokens, 10-20% overlap)
├─ Retrieval: Hybrid (BM25 + dense)
├─ Reranking: Cross-encoder (50-75 candidates)
└─ Evaluation: RAGAS framework

Need better accuracy? → Semantic chunking, GraphRAG
Latency problems? → Batching, caching, streaming
High costs? → Smart routing, optimize chunks
Hallucinations? → Reranking + Self-RAG/CRAG
```

---

## RAGAS Evaluation Metrics

1. **Faithfulness** (0-1): Factual consistency with context
2. **Answer Relevancy**: How pertinent answer is to prompt
3. **Contextual Relevancy**: How relevant retrieved context is
4. **Contextual Recall**: Does context contain ALL needed info?
5. **Contextual Precision**: Are docs ranked correctly?

---

## Key Papers

- "Sufficient Context: A New Lens on RAG Systems" (Google, ICLR 2025)
- "Corrective Retrieval Augmented Generation" (arXiv:2401.15884)
- "ColBERTv2: Lightweight Late Interaction" (arXiv:2112.01488)
- "SPLADE v2: Sparse Lexical and Expansion" (arXiv:2109.10086)

---

## Personal Application

This knowledge is directly applicable to:
1. Building better search for the knowledge base system
2. Understanding job recommendation systems (uses similar retrieval patterns)
3. Future projects requiring document retrieval + LLM generation
