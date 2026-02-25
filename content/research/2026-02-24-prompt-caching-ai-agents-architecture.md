---
date: "2026-02-24"
title: "Prompt Caching for AI Agents: Architecture Patterns for Cost and Latency Optimization"
description: "How to architect agentic systems to maximize KV-cache hit rates, cutting token costs by 41–90% and reducing latency by up to 85%."
tags: ["prompt-caching", "ai-agents", "cost-optimization", "architecture", "LLM"]
---

## Executive Summary

Prompt caching — the reuse of previously computed key-value (KV) attention tensors for repeated prompt prefixes — is one of the highest-leverage optimizations available to production AI agent systems. For agentic workloads where the same system prompt, tool definitions, and conversation history accumulate across dozens of API calls, naively ignoring caching mechanics leaves 40–90% of input token costs on the table.

This article covers how prompt caching works at the infrastructure level, how each major provider exposes it, and — critically — the architectural patterns that determine whether an agent system achieves near-100% cache hit rates or inadvertently breaks every cache it builds.

---

## How Prompt Caching Works

### The KV-Cache Mechanism

Every transformer LLM computes "key" and "value" vectors for each token when processing a prompt. These computations are expensive: for a 100K-token context, they dominate both latency and compute cost. Prompt caching stores these KV tensors server-side after the first computation. When a subsequent request shares an identical token prefix, the server reuses the cached tensors rather than recomputing them.

The condition for a cache hit is strict: **byte-for-byte identical prefix**. A single changed character — even a whitespace difference — causes a full cache miss. This is why architectural discipline around prompt construction is essential, not optional.

### What Gets Cached vs. What Cannot

Cacheable content (stable, reusable):
- System prompt instructions
- Tool/function definitions
- Background documents and retrieval context
- Few-shot examples
- Structured output schemas

Non-cacheable (must remain dynamic):
- The current user message
- Live tool results injected mid-conversation
- Timestamps or request IDs embedded anywhere before dynamic content
- Any content that changes between requests

The fundamental rule: **everything that can be cached must appear before everything that cannot.**

---

## Provider Comparison (2025–2026)

### Anthropic Claude — Explicit Cache Control

Anthropic requires developers to explicitly mark cache breakpoints using `cache_control`. The API accepts up to 4 cache breakpoints per request. The supported type is `ephemeral`, with configurable TTL:

```json
{
  "cache_control": { "type": "ephemeral", "ttl": "1h" }
}
```

Default TTL is 5 minutes. The extended 1-hour TTL option was added in late 2025 for workloads where conversations naturally exceed 5 minutes. A cache breakpoint placed on the system prompt block means the full system prompt (including tool definitions appended to it) is cached as a prefix.

Key characteristics:
- **Cost**: Cached input tokens are billed at 10% of standard input token price (90% reduction)
- **Latency**: Up to 85% reduction for long prompts; a 100K-token prompt that previously took 11.5s drops to ~2.4s
- **Cache hit rate**: 100% when the cache is warm and the prefix is identical
- **Workspace isolation**: As of February 5, 2026, caches are isolated per workspace (not per organization). This matters for multi-tenant deployments — different workspaces cannot share caches even if they use identical prompts.

**Automatic prompt caching** was introduced for Claude in 2026, where Anthropic automatically places a cache breakpoint on the last cacheable block. This simplifies integration for teams that don't want to manage breakpoints manually, though explicit control remains available for optimization.

### OpenAI — Automatic Prefix Caching

OpenAI's approach is fully automatic — no API changes required. The system caches the longest matching prefix of any prompt that is 1,024 tokens or longer.

Cache matching works in 128-token increments: the cached sequence length will always be in the set {1024, 1152, 1280, 1408, ...}. This means even slight prefix mismatches can drop the effective cached length dramatically.

Key characteristics:
- **Cost**: Cached tokens are billed at 50% of standard input price (50% reduction) — less aggressive than Anthropic's discount
- **Minimum**: 1,024 tokens; requests shorter than this are never cached
- **Increment**: 128-token blocks — a single token difference shifts the cache boundary
- **No TTL control**: Cache lifetime is managed automatically by OpenAI
- **Supported content**: Messages array, tool definitions, and structured output schemas all participate in the prefix

Because caching is automatic, the discipline burden falls entirely on prompt structure: if tool definitions or the system prompt change between requests, cache effectiveness collapses.

### Google Gemini — Context Caching

Google offers both implicit prefix caching (similar to OpenAI's automatic approach) and explicit "context caching" via the API. Explicit context caching allows developers to upload a large document once and reference its cache ID across multiple requests, which is well-suited for agentic systems that repeatedly query the same knowledge base.

Google's 2M token context window combined with explicit caching makes it particularly strong for document-heavy agent workflows.

---

## Agent Architecture Patterns for Maximum Cache Efficiency

### Pattern 1: Static-First, Dynamic-Last Ordering

This is the foundational rule. Structure every prompt in this order:

```
1. System instructions (static)
2. Tool definitions (static within a session)
3. Few-shot examples (static)
4. Conversation history (grows, but old parts are static)
5. Latest user message (dynamic — always at the end)
```

Violating this order — for example, injecting a timestamp into the system prompt, or appending retrieval results before tool definitions — breaks the cache for everything that follows.

### Pattern 2: Freeze Tool Definitions Early

Tool definitions for an agent session are typically fixed: the set of tools available doesn't change mid-conversation. However, teams frequently rebuild tool definition objects programmatically, and subtle differences (JSON key ordering, formatting whitespace, description updates) cause cache misses across all subsequent content.

Best practice: serialize tool definitions to a canonical JSON string once at agent startup and reuse that exact string for the session lifetime. A checksum-based approach can detect accidental mutations:

```typescript
const TOOLS_CANONICAL = JSON.stringify(buildToolDefinitions(), null, 0);
const TOOLS_HASH = sha256(TOOLS_CANONICAL);
// Assert TOOLS_HASH matches expected value at startup
```

The payoff is significant: complex tool definitions can be 2,000–10,000 tokens. In an agent with 50 tool-calling steps, caching the tool block alone can save 100K–500K tokens per session.

### Pattern 3: Separate Tool Results from the Cache Prefix

The research paper "Don't Break the Cache" (arxiv 2601.06007, 2025) established a critical finding: **naive full-context caching can paradoxically increase latency** relative to no caching. The cause: when tool results are voluminous and dynamic, including them in the cache breakpoint forces a cache write on every step, and the write overhead exceeds the read savings.

The optimal strategy is to cache the system prompt and tool definitions as a stable prefix, but treat tool results as non-cached dynamic content appended at the end. This yields:
- **41–80% cost reduction** (vs. 0% for no caching or negative for naive caching)
- **13–31% time-to-first-token improvement**

The specific strategies tested in the paper, ranked by effectiveness:
1. System prompt only caching — most consistent benefits
2. Full context minus tool results — good for long conversations
3. Naive full-context caching — risky, provider-dependent

### Pattern 4: Multi-Layered Cache Prefixes for Multi-Tenant Systems

For platforms serving multiple users (like Zylos's multi-tenant architecture), a layered approach maximizes shared cache value while maintaining isolation:

```
Layer 1: Global prefix — shared across ALL users
  - Core system identity and capabilities
  - Universal tool definitions
  - Company-wide policies
  ↓ Cache breakpoint #1

Layer 2: User-class prefix — shared within a user segment
  - Role-specific instructions
  - Feature flags for that user tier
  ↓ Cache breakpoint #2 (Anthropic supports up to 4)

Layer 3: Per-user context — user profile, preferences
  ↓ Cache breakpoint #3

Layer 4: Conversation history (dynamic, grows per session)
Layer 5: Current message (never cached)
```

With this structure, the expensive global layer (potentially 50K+ tokens for a full instruction set) is cached once and reused across all users' requests. Anthropic's workspace-level isolation ensures that different tenant workspaces cannot share each other's cache, preventing cross-tenant data exposure.

### Pattern 5: Agentic Plan Caching

A 2025 paper on "Agentic Plan Caching" introduced a higher-level approach: caching the agent's *reasoning plan* (the decomposed task structure), not just the prompt prefix. When an agent encounters a task semantically similar to a previously solved one, it retrieves the cached plan and adapts it rather than replanning from scratch.

Benchmarks show this approach delivers:
- 50.31% cost reduction on average
- 27.28% latency reduction on average
- Quality maintained at near-baseline levels

This is complementary to KV-cache optimization — one operates at the API call level, the other at the agent reasoning level.

---

## Security Considerations: The KV-Cache Side Channel

A 2025 NDSS paper ("I Know What You Asked: Prompt Leakage via KV-Cache Sharing") identified a serious security vulnerability in multi-tenant LLM serving: by observing cache behavior timing, an adversarial user can reconstruct other users' prompt prefixes. The attack exploits the fact that a cache hit produces faster responses than a cache miss.

Implications for agent platforms:
- **Never share caches across tenant boundaries** — this is now enforced at the provider level (Anthropic workspace isolation), but self-hosted deployments (vLLM, llama.cpp) require explicit configuration
- **vLLM mitigation**: Use the `cache_salt` parameter to prevent cross-tenant prefix sharing even when prefixes are identical
- **Avoid predictable cache refresh patterns**: Batch cache invalidation into irregular maintenance windows to reduce timing attack surface
- **Audit what's in system prompts**: If a system prompt contains sensitive business logic, it will be reconstructible by sophisticated adversaries in shared infrastructure

For self-hosted agentic deployments, the recommendation is namespace-based cache isolation: each tenant's KV-cache namespace is cryptographically separated, trading some cache efficiency for strict isolation.

---

## Semantic Caching: Beyond Prefix Matching

Exact prefix matching has a fundamental limitation: even semantically identical prompts ("What is the weather?" vs. "Tell me the weather") produce different tokens and thus different cache keys. Semantic caching addresses this by storing responses and retrieval context indexed by embedding vectors.

**SemanticALLI** (2025) demonstrated this at PMG's marketing analytics platform by decomposing agent pipelines into cacheable intermediate representations (IRs) rather than caching raw responses. The system:
- Achieves 78% token usage reduction vs. monolithic caching's 38.7% cap
- Caches "analytic intents" (what the user is actually asking for) rather than their literal phrasing
- Uses hybrid retrieval: exact match → semantic neighborhood → lexical fallback

For production agent systems, semantic caching is most valuable when:
1. The agent answers many similar but not identical queries
2. Tool call results are expensive (API costs, latency) and idempotent
3. Users frequently rephrase the same underlying intent

The implementation complexity is higher than KV-cache optimization, but the ceiling for cache hit rate improvement is also much higher.

---

## Measuring Cache Effectiveness

Blind deployment of caching without measurement is a missed optimization. Track these metrics:

| Metric | Description | Target |
|--------|-------------|--------|
| **Cache hit rate** | % of requests with at least partial cache hit | >80% for production agents |
| **Cached token fraction** | Cached tokens / total input tokens | >60% for long-context agents |
| **TTFT delta** | Time-to-first-token: cached vs. uncached | Should see >30% improvement |
| **Input token savings** | Monthly cached tokens × price delta | Track in cost dashboard |
| **Cache write overhead** | Cost of write-only misses | Should be <5% of total input cost |

Both Anthropic and OpenAI return cache statistics in API responses (`usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`). Log these alongside each API call and aggregate in your observability stack.

---

## Practical Checklist for Agent Systems

**Prompt structure:**
- [ ] System prompt is the first block, never modified between requests
- [ ] Tool definitions are serialized canonically (no whitespace drift, stable key order)
- [ ] Tool results are appended after cache breakpoints, not before
- [ ] No timestamps, request IDs, or random values in cacheable content
- [ ] User-specific content comes after all shared content

**Provider configuration:**
- [ ] Anthropic: `cache_control` breakpoints placed on system prompt and tool definition blocks
- [ ] Extended TTL (`1h`) configured for sessions that exceed 5 minutes
- [ ] OpenAI: verify minimum prompt length ≥1,024 tokens; pad system prompt if needed for short-context use cases
- [ ] Cache hit metrics are being logged per request

**Multi-tenant:**
- [ ] Different tenants use separate workspaces (Anthropic) or cache namespaces (self-hosted)
- [ ] Global shared prefix is factored out and cached at the highest level
- [ ] No per-user data in the shared cache layer

**Security:**
- [ ] System prompts don't contain secrets (passwords, API keys) — they're reconstructible
- [ ] Self-hosted deployments use cache_salt or namespace isolation
- [ ] Cache invalidation timing is irregular, not predictable

---

## Real-World Impact Estimates for Zylos

For a Zylos-style agent with the following profile:
- System prompt: ~3,000 tokens (identity + tools + instructions)
- Tool definitions: ~5,000 tokens (15 tools with descriptions and schemas)
- Average conversation: 20 turns, ~2,000 tokens/turn

Without caching: 20 turns × (3,000 + 5,000 + avg 10,000 history) = ~360,000 input tokens/session

With caching optimally applied:
- System + tools (8,000 tokens) cached after turn 1: saves 8,000 × 19 = 152,000 tokens at 90% discount
- Growing history partially cached: ~40,000 tokens saved
- Effective cost: equivalent to ~168,000 uncached tokens instead of 360,000 — **53% cost reduction**

At Claude Sonnet pricing (~$3/M input tokens), this is $1.08 vs. $0.50 per session — roughly halving inference costs for ongoing conversations. At scale across hundreds of daily sessions, this compounds to meaningful monthly savings.

---

## Summary

Prompt caching is not a set-and-forget feature — it requires deliberate architectural choices. The most impactful practices are:

1. **Structure prompts static-first**: system prompt → tool definitions → history → user message
2. **Freeze tool definitions** canonically and assert stability at startup
3. **Exclude dynamic tool results** from cache breakpoints; let them float at the end of context
4. **Layer cache prefixes** in multi-tenant systems: global → user-class → per-user → conversation
5. **Measure cache hit rate and cached token fraction** in your observability stack
6. **Enforce tenant cache isolation** to prevent KV-cache side-channel attacks

With these patterns applied, production agent systems routinely achieve 41–90% input token cost reductions and 13–85% latency improvements — with no change to model quality.
