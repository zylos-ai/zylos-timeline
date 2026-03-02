---
date: "2026-03-02"
title: "AI Agent Model Routing and Dynamic Model Selection Strategies"
description: "A comprehensive survey of how AI agents dynamically select the optimal LLM for each task — covering routing strategies, real-world implementations, architecture patterns, and emerging research from 2024–2026."
tags: ["ai-agents", "llm-routing", "model-selection", "cost-optimization", "architecture", "research"]
---

## Executive Summary

The era of the single-model agent is ending. As the LLM landscape has proliferated — with GPT-4o, Claude Haiku/Sonnet/Opus, Gemini Flash/Pro, Llama variants, Mistral, and dozens of specialized models each occupying different cost-capability niches — routing queries to the *right* model at the *right* time has become a first-class engineering problem.

Dynamic model routing can reduce inference costs by 40–85% while maintaining 90–95% of the quality you'd get from the most capable model on every query. That delta funds a significant portion of an AI product's operating budget. Yet the majority of deployed agents today still hardcode a single model.

This article surveys the state of the art in LLM routing as of early 2026: the theoretical foundations, the routing strategy taxonomy, real-world infrastructure (OpenRouter, Martian, LiteLLM, Not Diamond, Amazon Bedrock), recent academic research (RouteLLM, MasRouter, Router-R1, BaRP), architecture patterns for agent developers, and the emerging frontier of self-learning routers.

---

## The Problem: One Model Cannot Win Every Trade-off

### The Cost-Capability Spectrum

Modern LLMs span several orders of magnitude in cost per token:

| Model Tier | Example Models | Input Cost ($/M tokens) | Strengths |
|---|---|---|---|
| Nano/Flash | GPT-4o Mini, Gemini Flash-Lite, Claude Haiku | $0.07–$0.30 | Speed, cost, simple tasks |
| Mid-tier | GPT-4o, Gemini Flash, Claude Sonnet | $0.50–$3.00 | General competency, function calling |
| Frontier | GPT-5, Claude Opus, Gemini Ultra | $3.00–$15.00 | Complex reasoning, long context |
| Reasoning | o3, DeepSeek R1, Claude w/ extended thinking | $6.00–$60.00 | Math, code, multi-step logic |

Routing 90% of requests to the nano tier and 10% to frontier can yield ~86% cost savings with negligible quality loss on the 90% — because most queries in production are not frontier-hard.

The proliferation of specialized models compounds this: a medical Q&A model, a code-completion fine-tune, an embedding model, a vision model, a reasoning model. No single generalist excels across all these axes simultaneously.

### Agent-Specific Pressures

Inside an agent loop, the routing problem is even more acute. A single agent turn may involve:

1. A quick intent classification (cheap)
2. A tool selection decision (medium)
3. A multi-hop reasoning chain (expensive)
4. A final response synthesis (medium)

Sending all four steps through Claude Opus would be correct but wasteful. Sending all four through Haiku would be fast but brittle on step 3. The optimal strategy routes *each step* independently.

---

## Routing Strategy Taxonomy

### Static Routing

The simplest form: hardcode a model per task type in application logic.

```python
ROUTING_TABLE = {
    "intent_classification": "claude-haiku-3",
    "tool_selection": "gpt-4o-mini",
    "complex_reasoning": "claude-opus-4",
    "response_synthesis": "claude-sonnet-4",
}

def route(task_type: str) -> str:
    return ROUTING_TABLE[task_type]
```

**Pros:** Predictable, zero overhead, easy to audit.
**Cons:** Brittle — cannot adapt to query-level variation within a task type. A "complex_reasoning" query might be trivial (use Haiku) or truly hard (needs Opus).

Static routing is appropriate for well-typed pipelines where task categories truly have uniform complexity, such as OCR post-processing or structured data extraction from fixed schemas.

### Classifier-Based Routing

A small, fast model evaluates incoming queries and predicts which tier will suffice. This is the most widely deployed approach in production systems.

```
Query → [Lightweight Classifier] → complexity score → model selection
```

The classifier can be:
- A BERT-class model trained on preference data (RouteLLM's approach)
- A small generative model prompted to rate difficulty 1–5
- A rule-based heuristic on query length + keyword signals
- An embedding similarity lookup against difficulty-labeled examples

[RouteLLM](https://arxiv.org/abs/2406.18665) (LMSYS, published at ICLR 2025) is the canonical open-source implementation. It trains four router variants on human preference data from Chatbot Arena and achieves:

- **85% cost reduction** on MT Bench routing between GPT-4 and Mixtral 8x7B, maintaining 95% of GPT-4 quality
- **45% savings** on MMLU
- **35% savings** on GSM8K
- Routers transfer to unseen model pairs (Claude 3 Opus / Llama 3 8B) without retraining

The BERT classifier variant is particularly practical: it runs in under 10ms and requires no LLM inference to make the routing decision. [Code is available on GitHub](https://github.com/lm-sys/RouteLLM).

### Cascading / Sequential Fallback

Rather than predicting upfront which model to use, cascading *tries* a cheap model first and escalates only if the output quality is below a threshold.

```
Query → Haiku → [confidence check]
  → if high confidence: return response
  → if low confidence: Sonnet → [confidence check]
    → if high confidence: return response
    → if low confidence: Opus → return response
```

[ETH Zurich's 2024 paper "A Unified Approach to Routing and Cascading for LLMs"](https://arxiv.org/abs/2410.10347) proves theoretical optimality conditions for cascading and introduces **cascade routing** — a unified framework that combines both approaches. The key insight: cascading pays a latency tax (sequential calls) but eliminates the need for an accurate upfront complexity classifier. Routing pays zero latency overhead but requires a good predictor. The optimal choice depends on your latency budget and classifier accuracy.

**Confidence estimation** is the hard part. Common techniques:
- Self-reported confidence in the model's own output
- Consistency checking across multiple samples
- A secondary judge model evaluating the response
- Perplexity or logprob thresholds on specific answer tokens

### Semantic Routing

Semantic routing uses embedding-based similarity to map incoming queries to predefined *route categories*, each associated with a model or specialist.

```
Query → [Embedding Model] → vector
      → cosine_similarity(vector, route_prototypes)
      → top-k match → dispatch to specialist model
```

The [`semantic-router`](https://github.com/aurelio-labs/semantic-router) library by Aurelio Labs is the reference open-source implementation. Route prototypes are defined as small sets of representative utterances ("utterances"), embedded at startup, then matched against live queries.

[vLLM Semantic Router](https://blog.vllm.ai/2025/09/11/semantic-router.html), released September 2025, takes this further for inference-serving. It uses a **ModernBERT-based classifier** to decide whether a query needs chain-of-thought reasoning or can be answered directly — effectively routing between a reasoning model path and a fast path. Results are significant:

- ~10% accuracy improvement overall, exceeding 20% in specialized domains
- ~50% latency reduction
- ~50% fewer tokens consumed

The v0.1 "Iris" release (January 2026) added a Go/Rust dual-language implementation with Envoy integration for cloud-native deployments, and LoRA-based multi-task classification sharing base model computation across classification tasks.

**When to use semantic routing:** Applications with clearly delineated intent categories (customer support triage, RAG routing to different document sets, multi-domain assistant). Less suited for continuous complexity gradients.

### Cost-Aware / Budget-Constrained Routing

Rather than optimizing for quality subject to cost as a constraint, budget-constrained routing treats cost as a hard budget and maximizes quality within it.

The [PILOT paper](https://arxiv.org/abs/2508.21141) (2025) formulates this as a contextual bandit problem — learning a shared embedding space for queries and LLMs from offline preference data, then refining with online bandit feedback. This enables operators to dial the cost/quality trade-off at inference time without retraining the router.

For enterprise deployments, per-user or per-project token budgets can be encoded directly:

```python
def route_with_budget(query: str, remaining_budget_usd: float) -> str:
    estimated_tokens = estimate_tokens(query)

    if remaining_budget_usd < 0.001:
        return "gpt-4o-mini"  # exhausted budget
    elif complexity_score(query) > 0.8 and remaining_budget_usd > 0.05:
        return "claude-opus-4"
    elif complexity_score(query) > 0.5:
        return "claude-sonnet-4"
    else:
        return "claude-haiku-3"
```

---

## Real-World Implementations

### OpenRouter Auto Router

[OpenRouter](https://openrouter.ai/docs/guides/routing/routers/auto-router) provides a unified API endpoint (`openrouter/auto`) that automatically selects among dozens of models based on prompt analysis. The selection is powered by Not Diamond's meta-model. No additional cost beyond the selected model's standard rate.

OpenRouter also provides:
- **Provider fallback**: if a provider is down or rate-limited, automatically failover to secondary
- **Model fallbacks**: declarative list of fallback models per request
- **Free models router**: route to free-tier models when budget allows

```python
import openai

client = openai.OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key="sk-or-...",
)

response = client.chat.completions.create(
    model="openrouter/auto",  # auto-selects the best model
    messages=[{"role": "user", "content": query}],
)
# Check which model was selected:
selected_model = response.model
```

### Martian Model Router

[Martian](https://withmartian.com) was the first commercial LLM router, backed by $9M from NEA and General Catalyst, with Accenture as a strategic investor. It routes to the model with the best uptime, skillset, and cost-to-performance ratio for each prompt.

Key claims: up to 98% cost reduction, used by 300+ companies. Martian's core capability is *estimating* model performance without running it — using model compression and distillation techniques to predict output quality ahead of inference. The drop-in API is OpenAI-compatible.

### Not Diamond

[Not Diamond](https://notdiamond.ai) trains a meta-model that predicts which downstream LLM will perform best on a given query. It goes beyond routing into **prompt adaptation** — automatically rewriting prompts to better suit the selected model, achieving 5–60% accuracy improvements on enterprise datasets.

Performance results: 39% average accuracy improvement, with some models more than doubling on SRE benchmarks. IBM Ventures is an investor; SAP integrated Not Diamond into its Generative AI Hub at Sapphire 2025.

Not Diamond powers [OpenRouter's Auto Router](https://openrouter.ai/openrouter/auto).

### Amazon Bedrock Intelligent Prompt Routing

[Amazon Bedrock IPR](https://aws.amazon.com/bedrock/intelligent-prompt-routing/) (GA April 2025) provides a serverless endpoint that routes within model families:
- **Anthropic**: between Claude 3.5 Sonnet and Claude 3 Haiku
- **Meta**: between Llama 3.1 70B and 8B

A lightweight SLM predicts each candidate model's likely performance and routes to the cheapest model predicted to meet quality requirements. Claimed 60% cost reduction vs. always using the larger model. No additional API cost for routing.

```python
import boto3

bedrock = boto3.client("bedrock-runtime", region_name="us-east-1")

response = bedrock.converse(
    modelId="arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-router-v1",
    messages=[{"role": "user", "content": [{"text": query}]}],
)
```

### LiteLLM Proxy

[LiteLLM](https://docs.litellm.ai/docs/routing) is the most widely deployed open-source LLM proxy, with routing built into its core. Its routing capabilities include:

**Fallback types:**
- `fallbacks`: general error fallback list
- `context_window_fallbacks`: trigger when context limit exceeded
- `content_policy_fallbacks`: trigger on content violations

**Load balancing strategies:** round-robin, least-busy, latency-based, cost-based

**Config-driven routing:**
```yaml
model_list:
  - model_name: "fast-model"
    litellm_params:
      model: "claude-haiku-3"

  - model_name: "smart-model"
    litellm_params:
      model: "claude-opus-4"

router_settings:
  routing_strategy: "cost-based-routing"
  fallbacks:
    - "fast-model": ["smart-model"]
  context_window_fallbacks:
    - "fast-model": ["smart-model"]
```

LiteLLM's **auto routing** feature classifies query complexity and selects from a configured model pool automatically, functioning as an in-proxy classifier router.

---

## Architecture Patterns

### Pattern 1: Router as Middleware/Proxy

```
Client Application
       |
       ▼
 [Router Proxy]  ←── routing config, model registry, budget state
       |
  ┌────┼────┐
  ▼    ▼    ▼
Haiku  Sonnet  Opus
```

All LLM calls are intercepted by a proxy layer. The proxy makes routing decisions, handles fallbacks, logs decisions, and applies cost controls. The application is model-agnostic — it sends to one endpoint and the proxy handles the rest.

This is the pattern used by OpenRouter, LiteLLM, Martian, and Amazon Bedrock IPR. It enables centralized governance: routing policy changes without code deploys, cross-application budget management, audit logs.

### Pattern 2: Agent-Internal Routing Logic

The agent itself reasons about which model to invoke for each step. This is appropriate when the agent has complex, context-dependent routing needs that can't be expressed in a simple classifier.

```python
class RoutingAgent:
    async def plan_and_route(self, task: str) -> str:
        # Use a cheap model to classify the task type
        task_type = await self.classify(task, model="haiku")

        if task_type == "math_proof":
            return await self.invoke(task, model="o3")
        elif task_type == "code_generation":
            return await self.invoke(task, model="claude-sonnet-4")
        elif task_type == "factual_qa":
            return await self.invoke(task, model="gpt-4o-mini")
        else:
            # Default: try cheap, escalate if needed
            result = await self.invoke_with_confidence(task, model="haiku")
            if result.confidence < 0.7:
                return await self.invoke(task, model="sonnet")
            return result.text
```

**MasRouter** ([arxiv:2502.11133](https://arxiv.org/abs/2502.11133), ACL 2025) formalizes this for multi-agent systems. It introduces a cascaded controller network with three layers: a **collaboration mode determiner** (should this be solved by one agent or many?), a **role allocator** (what roles are needed?), and an **LLM router** (which model fits each role?). Results: 1.8–8.2% improvement over SOTA on MBPP, 52% overhead reduction on HumanEval.

### Pattern 3: Multi-Model Ensemble

Rather than picking one model, run several in parallel and aggregate their outputs. This is expensive but maximizes quality for high-stakes decisions.

```
Query
  ├──→ Model A → response_A
  ├──→ Model B → response_B
  └──→ Model C → response_C
              ↓
        [Aggregator/Judge]
              ↓
        Final Response
```

[Router-R1](https://arxiv.org/abs/2506.09033) (NeurIPS 2025) pushes this further with a **multi-round approach**: the router itself is an LLM that interleaves "think" actions (internal deliberation) with "route" actions (invoking specialized models), integrating each model's response into an evolving context. This enables the router to dynamically decide *whether* to invoke additional models mid-chain, rather than committing upfront to a fixed ensemble.

### Pattern 4: Quality-of-Service Tiering

Define explicit SLO tiers and map them to model configurations:

```
SLO Tier  │ Latency Budget │ Cost Ceiling │ Model Pool
──────────┼────────────────┼──────────────┼────────────────────────
Realtime  │ <500ms         │ $0.001/req   │ Haiku, GPT-4o Mini
Standard  │ <3s            │ $0.01/req    │ Sonnet, GPT-4o
Premium   │ <30s           │ $0.10/req    │ Opus, o3
Batch     │ hours          │ $0.001/token │ Local Llama, DeepSeek
```

Each incoming request is tagged with its SLO tier at the API edge (by product tier, user class, or endpoint), and the router selects from only the eligible model pool.

---

## Practical Considerations

### Latency Budgets

A routing decision itself has a latency cost:
- Embedding-based semantic router: 5–15ms
- BERT classifier: 10–50ms
- LLM-based classifier (Haiku): 200–800ms
- Cascading fallback: adds full model roundtrip per escalation

For sub-500ms SLOs, only embedding or BERT classifiers are viable. For sub-200ms SLOs, consider pre-classifying at request ingress or using rule-based heuristics (query length + keyword patterns).

### Fallback and Retry Strategy

A robust fallback chain handles three distinct failure modes:

1. **Provider outage/rate limit** → fail over to same-capability model at different provider
2. **Context window exceeded** → fail over to larger-context model variant
3. **Quality threshold not met** (cascading) → escalate to more capable model

```python
fallback_chains = {
    "gpt-4o": {
        "provider_failure": "claude-sonnet-4",
        "context_exceeded": "gpt-4o-128k",
        "quality_escalation": "claude-opus-4",
    },
}
```

LiteLLM's `allowed_fails` + `cooldown` mechanism handles provider failures automatically: if a model fails more than N times in a window, it's cooled down and traffic shifts to fallbacks.

### Model Capability Matrix

Not all models can handle all tasks equally. Before building a router, map your task types against model capabilities:

| Task | Haiku | Sonnet | Opus | GPT-4o Mini | o3 |
|---|---|---|---|---|---|
| Intent classification | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓ |
| JSON extraction | ✓ | ✓✓ | ✓✓ | ✓ | ✓ |
| Multi-step code | ✗ | ✓ | ✓✓ | ✓ | ✓✓ |
| Math proofs | ✗ | ✗ | ✓ | ✗ | ✓✓ |
| Long doc analysis | ✓ | ✓✓ | ✓✓ | ✓ | ✓ |
| Function calling | ✓ | ✓✓ | ✓✓ | ✓✓ | ✓ |

This matrix informs hard routing rules that constrain which models are even eligible for certain task types, before the cost-based selection runs.

### Monitoring Routing Decisions

Routing decisions must be observable to be improvable. At minimum, log:
- The routing decision (query hash, selected model, router confidence score)
- Actual response quality (downstream eval, user feedback, task success)
- Cost per routed request
- Fallback events and their triggers

Tools like [Langfuse](https://langfuse.com), Datadog LLM Observability, and [Braintrust](https://braintrust.dev) support routing-aware tracing. Langfuse integrates natively with LiteLLM's proxy, capturing the selected model on every span.

### A/B Testing Model Choices

Before committing to a routing policy, shadow test it:

1. **Shadow mode**: run new router in parallel with existing policy, compare outputs without serving shadow results
2. **Traffic splitting**: route X% of production traffic through new policy, measure quality metrics
3. **Canary by user cohort**: apply new routing to a subset of users, monitor retention and feedback signals

Datadog's LLM Experiments (2025) enables testing prompt and model changes against production data before deployment.

---

## Emerging Research Trends (2025–2026)

### Self-Improving Routers via Bandit Feedback

The limitation of classifiers trained on offline preference data: they cannot adapt to distribution shift, new models added to the pool, or changing user behavior patterns.

[BaRP](https://arxiv.org/abs/2510.07429) (Learning to Route LLMs from Bandit Feedback, 2025) addresses this with a bandit framework that trains under the same partial-feedback restriction encountered at deployment — only observing the quality of the *chosen* model's response, not all models. BaRP consistently outperforms strong offline routers by at least 12.46% and outperforms the largest LLM by 2.45%.

This enables routers that improve over time as they accumulate production feedback, without requiring expensive offline re-labeling campaigns.

### Router-R1: Reasoning Routers

[Router-R1](https://arxiv.org/abs/2506.09033) (NeurIPS 2025, ulab-uiuc) instantiates the router itself as a capable LLM with an explicit reasoning trace. Rather than making a one-shot routing decision, the router-LLM interleaves:
- `<think>` steps: analyzing the query, reasoning about model capabilities, considering cost
- `<route>` actions: invoking a specific downstream LLM and integrating its response

The router learns via RL with a reward function combining task success, format correctness, and a cost penalty. Crucially, it generalizes to *unseen* models by conditioning on simple model descriptors (pricing, latency, benchmark scores) rather than model-specific embeddings.

### vLLM Semantic Router: Inference-Level Routing

The [vLLM Semantic Router](https://blog.vllm.ai/2026/01/05/vllm-sr-iris.html) project moves routing into the inference serving layer itself, making routing decisions before tokens are generated. This is architecturally distinct from proxy-level routing: the serving infrastructure itself is routing-aware.

The v0.1 Iris release (January 2026) features LoRA-based multi-task classification — a single ModernBERT base model handles intent classification, complexity estimation, and tool-catalog filtering simultaneously, sharing computation across all classification tasks.

Key architectural insight: by routing the *reasoning path* (full CoT vs. direct answer) rather than just the model, you can use a single model and still achieve 50% latency and token savings.

### MCP and Tool-Use Routing

With Model Context Protocol (MCP) becoming the standard for agent tool access in 2025, a new routing dimension has emerged: which model handles which tool categories best?

Some models excel at structured tool invocation (consistent JSON, proper argument handling) while others are better at synthesizing tool results into coherent responses. Emerging patterns:

- Route tool-heavy subtasks to models with strong function-calling benchmarks (GPT-4o, Claude Sonnet)
- Route reasoning-heavy subtasks to models with strong CoT (o3, DeepSeek R1)
- Route the final synthesis to a model tuned for response quality (Claude Opus, Gemini Pro)

[MCP Gateways](https://composio.dev/blog/mcp-gateways-guide) (Composio, 2026) are emerging as a hybrid: a proxy that routes both MCP tool requests and LLM model selection, creating a unified control plane for agent infrastructure.

### Multi-Agent System Routing

In systems with multiple specialized agents, routing extends beyond single-query model selection to *agent selection* and *collaboration topology*. The MASR (Multi-Agent System Routing) problem formalized in MasRouter encompasses:

1. Should this query be solved by a single agent or a multi-agent workflow?
2. What roles are needed in the multi-agent workflow?
3. Which LLM backbone should each role use?

This is a combinatorial optimization problem that current systems solve approximately via cascaded probabilistic models. The [Orchestrating Intelligence paper](https://arxiv.org/abs/2601.04861) (January 2026) extends this with confidence-aware routing — agents self-report confidence and the orchestrator dynamically reassigns subtasks based on live confidence signals.

---

## Recommended Architecture for Agent Developers

For a practical starting point, this architecture handles the most common cases:

```
                    ┌─────────────────────┐
Incoming Query ───→ │  Edge Classifier     │  (BERT, <20ms)
                    │  - complexity: 0-1   │
                    │  - task_type: enum   │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
         score < 0.4      0.4 ≤ score < 0.8   score ≥ 0.8
              │                │                │
         [Fast Pool]      [Mid Pool]       [Frontier Pool]
         Haiku/Mini        Sonnet/4o         Opus/o3
              │                │                │
              └────────────────┴────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Confidence Check    │
                    │  if conf < threshold │
                    │  → escalate          │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Observability       │
                    │  Log: model, score,  │
                    │  cost, quality       │
                    └─────────────────────┘
```

**Implementation stack:**
- **Classifier**: RouteLLM's BERT router (open-source, pretrained on Chatbot Arena)
- **Proxy**: LiteLLM with fallback chains and cost-based routing
- **Observability**: Langfuse for tracing + routing decision logging
- **Long-term**: collect feedback signals, feed into BaRP-style online learning

---

## Summary

LLM routing is no longer an optimization curiosity — it is production infrastructure. The cost savings (40–85%) are too large to ignore, and the tooling has matured to the point where a basic routing layer is a few days of engineering work rather than a research project.

The field is moving fast:
- **2024**: RouteLLM establishes the academic baseline; Martian and Not Diamond validate commercial viability
- **2025**: Amazon Bedrock IPR goes GA; vLLM Semantic Router ships; Router-R1 shows RL-trained reasoning routers; MasRouter formalizes multi-agent routing
- **2026**: Bandit-feedback online learning routers (BaRP, PILOT) begin replacing static classifiers; MCP Gateways emerge as unified control planes; inference-level semantic routing (vLLM Iris) moves routing below the application layer

For agent developers: start with a proxy router (LiteLLM or OpenRouter), add RouteLLM's classifier, instrument with Langfuse, and you have a production routing layer. Evolve to online learning as you accumulate feedback data.

---

## Sources

- [RouteLLM: Learning to Route LLMs with Preference Data (ICLR 2025)](https://arxiv.org/abs/2406.18665)
- [RouteLLM Open-Source Framework — LMSYS Blog](https://lmsys.org/blog/2024-07-01-routellm/)
- [RouteLLM GitHub](https://github.com/lm-sys/RouteLLM)
- [A Unified Approach to Routing and Cascading for LLMs (ETH Zurich)](https://arxiv.org/abs/2410.10347)
- [MasRouter: Learning to Route LLMs for Multi-Agent Systems (ACL 2025)](https://arxiv.org/abs/2502.11133)
- [Router-R1: Teaching LLMs Multi-Round Routing via RL (NeurIPS 2025)](https://arxiv.org/abs/2506.09033)
- [BaRP: Learning to Route LLMs from Bandit Feedback](https://arxiv.org/abs/2510.07429)
- [PILOT: Adaptive LLM Routing under Budget Constraints](https://arxiv.org/abs/2508.21141)
- [Dynamic LLM Routing Based on User Preferences (OptiRoute)](https://arxiv.org/abs/2502.16696)
- [vLLM Semantic Router — Next Phase in LLM Inference (Sep 2025)](https://blog.vllm.ai/2025/09/11/semantic-router.html)
- [vLLM Semantic Router v0.1 Iris Release (Jan 2026)](https://blog.vllm.ai/2026/01/05/vllm-sr-iris.html)
- [vLLM Semantic Router: When to Reason (arxiv:2510.08731)](https://arxiv.org/abs/2510.08731)
- [OpenRouter Auto Router Documentation](https://openrouter.ai/docs/guides/routing/routers/auto-router)
- [OpenRouter Model Fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks)
- [Martian Model Router](https://withmartian.com/)
- [Martian — TechCrunch Coverage](https://techcrunch.com/2023/11/15/martians-tool-automatically-switches-between-llms-to-reduce-costs/)
- [Not Diamond AI Model Routing](https://www.notdiamond.ai/)
- [Not Diamond — VentureBeat](https://venturebeat.com/ai/not-diamond-automatically-routes-your-query-to-the-best-llm)
- [Amazon Bedrock Intelligent Prompt Routing (GA)](https://aws.amazon.com/bedrock/intelligent-prompt-routing/)
- [Amazon Bedrock IPR — AWS Blog](https://aws.amazon.com/blogs/aws/reduce-costs-and-latency-with-amazon-bedrock-intelligent-prompt-routing-and-prompt-caching-preview/)
- [LiteLLM Routing and Load Balancing Docs](https://docs.litellm.ai/docs/routing)
- [LiteLLM Fallback Configuration](https://docs.litellm.ai/docs/proxy/reliability)
- [Multi-LLM Routing Strategies on AWS](https://aws.amazon.com/blogs/machine-learning/multi-llm-routing-strategies-for-generative-ai-applications-on-aws/)
- [Dynamic LLM Routing Tools and Frameworks — Latitude](https://latitude.so/blog/dynamic-llm-routing-tools-and-frameworks)
- [semantic-router library — Aurelio Labs](https://github.com/aurelio-labs/semantic-router)
- [Intelligent LLM Routing: 85% Cost Reduction — Swfte AI](https://www.swfte.com/blog/intelligent-llm-routing-multi-model-ai)
- [IDC: The Future of AI is Model Routing](https://www.idc.com/resource-center/blog/the-future-of-ai-is-model-routing/)
- [MCP Gateways Developer Guide 2026 — Composio](https://composio.dev/blog/mcp-gateways-guide)
- [Orchestrating Intelligence: Confidence-Aware Multi-Agent Routing](https://arxiv.org/abs/2601.04861)
- [Not-Diamond/awesome-ai-model-routing (curated resource list)](https://github.com/Not-Diamond/awesome-ai-model-routing)
