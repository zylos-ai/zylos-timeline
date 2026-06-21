---
date: "2026-06-21"
title: "Structured Output Validation in Multi-Agent Workflows"
description: "How schema enforcement at agent handoff boundaries prevents cascading failures, and the libraries, patterns, and performance considerations that make it practical in production."
tags: ["multi-agent", "structured-output", "validation", "pydantic", "json-schema", "llm"]
---

## Executive Summary

In a single-agent system, a validation failure is a local exception. In a multi-agent pipeline, one agent's output is another agent's input — errors propagate silently, accumulate apparent legitimacy through repeated citation, and arrive at the final step dressed as confirmed fact. The fix is treating inter-agent schemas as contracts enforced at every handoff boundary, not documentation that exists for developer reference. This article covers how constrained decoding, schema gates, and orchestrator-level circuit breakers combine to make multi-agent output validation both reliable and fast.

## Why Multi-Agent Pipelines Amplify Errors

Consider a four-agent pipeline: planner → executor → compliance → reporting. If the planner hallucinates a structurally valid but semantically wrong field — say, a price of `$100,0` where `$1,000` was intended — each downstream agent validates that number within its local context without interrogating its source. By the time reporting runs, the value has been implicitly confirmed three times. Financial services teams have documented this exact pattern: a 5% error rate at extraction reduced to 0.3% only after schema validation was inserted at each ingestion point, not just the terminal output.

The numbers on LLM schema compliance without enforcement are sobering: GPT-4 produces schema-conformant output less than 40% of the time when asked informally. With `strict: true` enforced at the provider level, that becomes 100% for structural validity. GPT-4 produces invalid responses for complex extraction tasks at an 11.97% rate without strict mode. Adding schema gates at handoff points in a multi-step workflow has been shown to improve end-to-end accuracy from 10% to 70% in some configurations. Structural guarantees are a prerequisite for semantic ones — you cannot reason meaningfully about a field whose presence is uncertain.

## Three Tiers of Validation

Production multi-agent validation typically operates at three distinct layers that complement rather than duplicate each other.

**Tier 1 — Constrained Decoding at the LLM Boundary**

At generation time, the provider constrains token sampling so that only tokens keeping the output schema-valid can be selected. This is the deepest guarantee: the model cannot emit malformed JSON, missing required fields, or additional properties not declared in the schema, because those token sequences are removed from the sampling distribution entirely.

OpenAI's `strict: true` (released August 2024) applies this automatically when you use `.parse()` with a Pydantic model. Anthropic supports it via tool use with `"strict": True` and `"additionalProperties": false` in the input schema. Gemini requires `response_mime_type="application/json"` plus a `response_json_schema`. Self-hosted deployments via vLLM, SGLang, or TensorRT-LLM default to XGrammar as the constrained decoding backend.

Important caveats per provider: Anthropic strict mode does not support recursive `$ref`, limits you to 20 strict tools per request and 16 union branches per field. Optional fields must be typed as `T | null` rather than omitted — the model must emit explicit `null`. Gemini silently ignores unsupported JSON Schema keywords; always test your exact schema against the target deployment before relying on it. Anthropic compiles grammar artifacts on first request and caches them for 24 hours from last use — schema changes invalidate the cache, so use the same schema object across all instances of a given agent type to maximize hit rates.

**Tier 2 — Schema Gates at Agent Boundaries**

Constrained decoding guarantees structural validity, not semantic correctness. A confidence classifier can return 0.99 on every input including gibberish; a planning agent can hallucinate a "30% discount" that is syntactically valid but factually wrong. Tier 2 catches these with domain-specific validators that run after the LLM returns:

```python
from jsonschema import validate, ValidationError
from pydantic import BaseModel, Field, field_validator

class OrderExtraction(BaseModel):
    order_id: str = Field(pattern=r"^ORD-\d{6}$")
    amount: float = Field(ge=0, le=10000)

    @field_validator("amount")
    def no_negative(cls, v):
        if v < 0:
            raise ValueError("amount cannot be negative")
        return v
```

`additionalProperties: false` is the single highest-impact constraint — it rejects hallucinated extra fields that pass structural JSON validation but were never declared. Pydantic `@field_validator` and `@model_validator` then apply domain logic: range checks, pattern matching, cross-field consistency.

One non-obvious schema design rule: field ordering affects model accuracy. Placing an `answer` field before a `reasoning` field causes the model to commit to a conclusion before thinking through the problem, producing measurable accuracy degradation. Reasoning fields must appear first.

**Tier 3 — Orchestrator-Level Circuit Breakers**

The orchestrator manages the overall pipeline and can halt propagation before a bad value reaches a critical path. Patterns here include:

- **Confidence-gated handoffs**: agents attach a `confidence` float to their output; the orchestrator pauses for human review when confidence falls below a threshold.
- **Independent consensus**: route the same input to two independent agents and compare structured outputs before proceeding. Disagreement on key fields triggers escalation rather than arbitrary tie-breaking.
- **Message lineage tags**: every inter-agent message carries source metadata identifying which upstream agent generated the root value. When Agent D reasons from Agent A's output without any transformation, lineage tagging makes that traceable — preventing the situation where multiple agents appear to corroborate each other but are actually citing the same contaminated source.

## The Validate-Repair-Retry Loop

When Tier 2 validation fails, the standard recovery is not to raise an exception and halt the pipeline — it is to format the validation error as a natural-language correction prompt and resubmit to the model. The Instructor library (11,000+ GitHub stars, 3 million+ monthly downloads) implements this automatically for Python, TypeScript, Go, and Ruby across 15+ provider backends:

```python
import instructor
import anthropic

client = instructor.from_anthropic(anthropic.Anthropic())
result = client.chat.completions.create(
    model="claude-sonnet-4-6",
    response_model=OrderExtraction,
    max_retries=3,
    messages=[{"role": "user", "content": "Extract the order details..."}]
)
```

When `field_validator` raises `ValueError`, Instructor catches it, generates a correction prompt explaining what went wrong, and resubmits. The standard cap is 2-3 retries — if a schema consistently requires more than two correction cycles, the right fix is to revise the prompt or simplify the schema, not raise the retry cap. High retry rates are a signal that the schema is fighting the model's output style rather than complementing it.

## Library Landscape

**Instructor** remains the pragmatic default for teams that want structured output without building validation infrastructure from scratch. Its `create_partial()` method returns a generator of partially-populated Pydantic objects as streaming chunks arrive, enabling routing logic to fire before generation completes — if `intent` is the first schema field, you can dispatch the request before the model has finished generating `evidence`.

**Pydantic AI** (16,000+ stars, stable since late 2025) is a full agent framework built around structured types as a first-class primitive. Its `result_type=MyModel` parameter makes every agent interaction schema-enforced by default, and Logfire integration gives per-field failure telemetry.

**Outlines** and **Guidance** (Microsoft) target self-hosted deployments where you control the sampling loop. Outlines rewrote its core in Rust for O(1) valid token lookup; Guidance uses context-free grammars rather than finite-state machines, which is necessary for schemas with recursive structures.

**XGrammar** (MLSys 2025, now the default in vLLM, SGLang, and TensorRT-LLM) achieves up to 100x throughput improvement over naive constrained decoding through vocabulary partitioning: context-independent tokens are precomputed once; context-dependent tokens are computed at runtime. It also handles recursive schemas where FSM-based approaches require fallbacks to CFG mode.

**Marvin 3.0**, built on Pydantic AI, provides the highest-level interface: `marvin.extract()`, `marvin.cast()`, and `marvin.classify()` for teams that need simple extraction without framework overhead.

## Schema Versioning Across Agent Boundaries

In a long-lived multi-agent system, agents evolve independently. Agent B may be updated to emit a new field before Agent C's consumption code is updated to handle it. Schema versioning at handoff boundaries prevents silent breakage:

```python
class HandoffPayload(BaseModel):
    schema_version: Literal["2.1"]
    status: Literal["success", "partial", "needs_review"]
    agent_id: str
    timestamp: datetime
    data: AgentSpecificData
```

The `schema_version` field acts as a discriminator: Agent C checks the version before processing and routes to a compatibility shim if it receives a version it does not natively support. No universal standard for inter-agent schema versioning exists as of 2026; teams use semantic versioning per-pipeline and treat breaking schema changes like API version bumps.

## Performance Profile

Constrained decoding is faster than unconstrained generation for most schema shapes — by eliminating invalid tokens at each step, the model converges in fewer tokens. The latency cost of schema compilation at first request is real but bounded: Anthropic caches grammar artifacts for 24 hours, so the overhead amortizes quickly in steady-state operation. The main exception is large enums (50+ values), which can cause compilation timeouts in some backends. XGrammar handles these better than Outlines; a two-stage hierarchical classification approach (coarse category first, then fine-grained within category) sidesteps the issue entirely.

Semantic validation that calls a second LLM — Instructor's `llm_validator` decorator — adds a full inference roundtrip per field. The mitigation is a tiered strategy: type validation runs first, then deterministic rule-based checks, and only unresolvable cases escalate to an LLM validator. Use a smaller model (Haiku, gpt-4o-mini) for the validation step while the primary model handles generation — the validation model needs only to assess conformance, not to generate complex outputs.

## Execution Tracing for Validation Observability

Validation failures across a multi-agent system are only actionable if they are observable. The minimum useful telemetry per agent invocation:

- Input text hash (to trace which source data a failure originates from)
- Prompt template version and model identifier with snapshot date
- Validation outcome: pass, retry count, final failure
- Latency and token counts per attempt

Storing this as JSONL enables SQL-based monitoring: which fields fail most often, which prompt templates have the highest retry rates, which model versions introduced new failure modes after an upgrade. Schema compliance tests run against a new model version before promotion to production are the production analogue of unit tests — pin model snapshots for production agents and treat model upgrades with the same scrutiny as dependency upgrades.

## Practical Takeaways

Structured output validation is not a single technique — it is a stack. Constrained decoding at the LLM boundary eliminates structural errors. Domain validators at the agent boundary catch semantic errors deterministically. Orchestrator circuit breakers prevent propagation of values that passed local validation but are suspicious in context. The validate-repair-retry loop handles the residual cases that strict mode and domain validators cannot catch ahead of time.

The field ordering rule is easy to overlook and measurably consequential: reasoning before conclusion, always. The `additionalProperties: false` constraint is the single-highest-impact schema property for catching hallucinated fields. Schema versioning at handoff boundaries is optional until your first silent breaking change — after which it becomes non-negotiable. Start with Instructor or Pydantic AI for Python, enforce `strict: true` at every provider call, and add semantic validators only for fields where domain constraints cannot be expressed in JSON Schema. The result is a pipeline where errors are loud and local rather than silent and compounding.
