---
date: "2026-01-08"
title: "pgvector Performance & Optimization 2025"
description: "Research notes on pgvector Performance & Optimization 2025"
tags:
  - research
---


> Learned: 2026-01-08
> Topic: Vector Database, PostgreSQL

---

## Key Insights

1. **HNSW > IVFFlat** for production: 15x faster queries, handles updates better
2. **pgvector 0.8.0** is game-changing: iterative scans fix overfiltering, 9x faster filtered queries
3. **pgvector vs Pinecone**: 28x lower latency, 16x higher throughput, 75% cost savings at 50M vectors
4. **Scale limit**: pgvector handles 50-100M vectors well; beyond that consider dedicated solutions

---

## Index Types Comparison

| Factor | HNSW | IVFFlat |
|--------|------|---------|
| Query Speed | 40.5 QPS | 2.6 QPS (@99.8% recall) |
| Build Time | 32x slower | Fast |
| Memory | 2.8x more | Compact |
| Updates | No rebuild | Needs rebuild |
| Build on empty | Yes | No |

**Recommendation**: HNSW for production unless memory-constrained

---

## Configuration Tuning

### HNSW Parameters

```sql
CREATE INDEX ON items USING hnsw (embedding vector_l2_ops)
WITH (m = 16, ef_construction = 64);

SET hnsw.ef_search = 100;  -- Query accuracy (default 40)
```

| Parameter | Default | Recommendation |
|-----------|---------|----------------|
| m | 16 | 16-48 (higher for >768 dims) |
| ef_construction | 64 | 64-128 (higher = better quality) |
| ef_search | 40 | 100-200 for production |

### IVFFlat Parameters

```sql
CREATE INDEX ON items USING ivfflat (embedding vector_l2_ops)
WITH (lists = 1000);

SET ivfflat.probes = 32;  -- sqrt(lists)
```

- lists: `rows/1000` (up to 1M), `sqrt(rows)` (over 1M)
- probes: `sqrt(lists)` for good balance

---

## pgvector 0.8.0 Critical Features (Nov 2024)

**Iterative Scans** - Fixes overfiltering problem:
```sql
SET hnsw.iterative_scan = 'on';
SET ivfflat.iterative_scan = 'on';
```

- Up to 9x faster queries
- 100x better relevance for filtered queries
- Better cost estimation for query planner

---

## Hybrid Search Pattern

```sql
-- Create indexes
CREATE INDEX ON docs USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON docs (category);      -- B-tree for WHERE
CREATE INDEX ON docs (created_at);    -- B-tree for filters

-- Hybrid query
SELECT id, title, embedding <=> query_vec AS similarity
FROM docs
WHERE category = 'technical'
  AND created_at > '2024-01-01'
ORDER BY embedding <=> query_vec
LIMIT 10;
```

---

## Scaling Guidelines

| Scale | Recommendation |
|-------|----------------|
| < 10M | pgvector excellent |
| 10-100M | pgvector + pgvectorscale |
| 100M-1B | Partitioning + optimization |
| > 1B | Dedicated vector DB |

### Optimization Strategies

1. **Dimensionality reduction**: 1536 → 768 dims = 2x memory savings, 97% accuracy
2. **Use halfvec (float16)**: 50% memory reduction
3. **Bulk load then index**: Much faster than incremental
4. **Concurrent index creation** for production

---

## Benchmarks vs Dedicated DBs

| Database | Best For | Scale |
|----------|----------|-------|
| pgvector | SQL integration, ACID, cost | 50-100M |
| Pinecone | Managed, enterprise | Billions |
| Qdrant | Complex filtering | Billions |
| Milvus | GPU, largest scale | Billions |

**pgvector advantages**:
- 75% cheaper than Pinecone
- Full SQL (JOINs, transactions)
- Existing Postgres ecosystem

---

## Production Memory Sizing (50M vectors, 768 dims)

- Base vectors: 150 GB
- HNSW index: 450 GB
- shared_buffers: 200 GB
- **Total**: ~850 GB

```sql
-- postgresql.conf
shared_buffers = 200GB
maintenance_work_mem = 8GB
work_mem = 256MB
```

---

## Monitoring

```sql
-- Query performance
SELECT query, calls, mean_exec_time, max_exec_time
FROM pg_stat_statements
WHERE query LIKE '%<=>%'
ORDER BY mean_exec_time DESC;

-- Index size
SELECT pg_size_pretty(pg_relation_size('items_embedding_idx'));

-- Recall validation
WITH exact AS (SELECT id FROM items ORDER BY embedding <-> q LIMIT 100),
     approx AS (SELECT id FROM items ORDER BY embedding <-> q LIMIT 100)
SELECT COUNT(*) * 1.0 / 100 AS recall
FROM approx WHERE id IN (SELECT id FROM exact);
```

---

## Quick Reference

```sql
-- HNSW index (recommended)
CREATE INDEX ON items USING hnsw (embedding vector_l2_ops)
WITH (m = 16, ef_construction = 64);

-- Query tuning
SET hnsw.ef_search = 100;
SET hnsw.iterative_scan = 'on';

-- Maintenance
VACUUM ANALYZE items;
REINDEX INDEX CONCURRENTLY items_embedding_idx;

-- Debug
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM items ORDER BY embedding <-> '[...]' LIMIT 10;
```
