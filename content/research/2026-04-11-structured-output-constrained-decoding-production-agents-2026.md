---
date: "2026-04-11"
title: "Structured Output and Constrained Decoding for Production AI Agents (2026)"
description: "How production agents enforce JSON schemas, grammars, and structured responses — the layered stack from prompts to FSM token masking, 2026 provider landscape, latency/quality trade-offs, and practical recipes."
tags: ["structured-output", "constrained-decoding", "json-schema", "ai-agents", "outlines", "xgrammar", "tool-use", "reliability", "production", "grammar"]
---

## Executive Summary

- Structured output has matured from a fragile prompt engineering trick to a hard infrastructure guarantee: every major provider now ships constrained decoding under the hood, and open-source engines like XGrammar (CMU, 2024/2025) achieve token mask generation in under 40 microseconds with up to 100× speedup over prior methods.
- The "100% JSON schema reliability" claims from OpenAI, Anthropic, and Google are **syntactic guarantees only** — they say nothing about semantic correctness, hallucinated field values, or refusals dressed up as valid JSON.
- Constrained decoding can degrade reasoning quality when grammar constraints force the model away from high-probability token sequences; the CRANE paper (Feb 2025, ICML 2025) showed that alternating between constrained and unconstrained windows recovers up to 10 percentage points on symbolic reasoning benchmarks.
- The latency penalty of constrained decoding has largely been engineered away: XGrammar and Microsoft's llguidance (Rust) both achieve ~40–50 µs CPU overhead per token, making structured output effectively free compared to the model's own compute.
- For Zylos-style production agents, the practical takeaway is: use constrained decoding for all tool argument schemas and routing decisions, keep grammars flat and enumerable where possible, and never trust schema validity as a substitute for semantic validation.

---

## Why This Matters for Production Agents

The January 2026 piece on structured output covered the LLM layer: JSON mode, `response_format`, and schema enforcement for single-turn queries. Three months and several model generations later, the problem space has shifted.

Agents don't make single calls. They make dozens of calls per task — tool invocations, routing decisions, memory writes, sub-plan emissions, evaluator outputs. In that context, a 0.1% parse failure rate is not "nearly perfect" — it is a reliability tax that compounds across every step and eventually crashes the pipeline or silently corrupts state.

Production agents in 2026 lean on constrained decoding as a load-bearing guarantee, not a nice-to-have. The entire function-calling machinery of OpenAI, Anthropic, and Gemini is built on it. Understanding what it guarantees, where it breaks, and how to engineer around its failure modes is now a core infrastructure skill.

---

## The Layered Stack

Structured output is not a single technique. It is a hierarchy of increasingly strong guarantees:

**Layer 1 — Prompt-level structure.** The oldest approach: instruct the model in the system prompt to return JSON, use XML tags, follow a template. Cheapest to deploy, zero latency cost, but reliability is model-dependent and degrades under long contexts or complex schemas. Still valid as a fallback or for models that don't support deeper layers.

**Layer 2 — JSON mode.** A soft constraint: the model is told to produce syntactically valid JSON, but no schema is enforced. OpenAI's original `response_format: { type: "json_object" }`, Mistral's JSON mode, and DeepSeek's JSON mode all live here. Reliability is high (~95–99%) but field names and types remain model-generated. Sufficient for prototypes; not safe for production pipelines.

**Layer 3 — JSON schema enforcement.** The model is given an explicit JSON Schema and the inference system validates output against it, either post-hoc (with retry) or at the token level. OpenAI's `response_format: { type: "json_schema", strict: true }` (GA since gpt-4o-2024-08-06), Anthropic's `output_config.format` parameter, and Gemini's `response_schema` with `responseMimeType: "application/json"` all operate here. Reliability is advertised as 100% for syntactic compliance — but this is achieved by the layer below.

**Layer 4 — Grammar-constrained decoding.** The inference engine compiles the schema into a formal grammar (FSM, CFG, or PDA) and at each decoding step masks out tokens that would violate the grammar. The model physically cannot produce an invalid token. This is the mechanism behind all provider "100% reliability" claims. Open-source: Outlines, XGrammar, llguidance, llama.cpp GBNF.

**Layer 5 — FSM-level token masking.** The most precise form of layer 4: a finite-state machine is precomputed for the entire schema, and a bitmask over the vocabulary is applied at each step. XGrammar's key innovation is partitioning tokens into context-independent (~99% of vocabulary) and context-dependent (~1%) sets, precomputing the bitmask table for the former, and handling only the latter at runtime. Result: CFG-level expressiveness at near-FSM-level speed.

**When to use which layer:**
- Prototyping with a capable model → Layer 1 or 2
- Extraction pipelines where some retry is acceptable → Layer 3 (hosted providers)
- Agent tool arguments, routing, plan emission → Layer 4 (hosted) or Layer 4–5 (self-hosted)
- High-throughput inference at 10k+ req/s → Layer 5 with XGrammar or llguidance

---

## 2026 Provider Landscape

### OpenAI

`response_format: { type: "json_schema", json_schema: { name: "...", schema: {...}, strict: true } }` is the production default for data extraction and agentic workflows. Strict mode is generally available across all GPT-4o and o-series models. As of May 2025, OpenAI migrated the underlying engine to **llguidance** (Microsoft's Rust-based constrained decoding library), expanding JSON Schema feature coverage and improving performance. The `strict: true` flag is what activates token-level masking; without it, OpenAI falls back to best-effort.

**What `strict: true` enforces:** All required fields present, no extra properties (when `additionalProperties: false`), correct types, valid enum values. **What it does not enforce:** Semantic correctness, string content accuracy, numeric ranges expressed as `minimum`/`maximum` annotations (these are advisory, not enforced by the grammar engine), or refusal suppression.

### Anthropic

Structured outputs reached general availability on the Claude API for Claude Opus 4.6, Sonnet 4.6, Sonnet 4.5, Opus 4.5, and Haiku 4.5 (also on Amazon Bedrock; beta on Microsoft Foundry; not yet on Google Cloud Vertex AI). The API surface is `output_config.format` for JSON outputs and `strict: true` on tool definitions for tool use. Both compile the schema into a grammar that constrains token generation at inference time.

The Claude Agent SDK exposes the same guarantee: define schemas in Pydantic (Python) or Zod (TypeScript), and the SDK handles conversion to the wire format. The structured output feature qualifies for Zero Data Retention (ZDR) with limited technical retention for grammar compilation caching.

### Google Gemini

Gemini's controlled generation is activated via `response_schema` + `responseMimeType: "application/json"`. As of 2025, Gemini added full JSON Schema keyword support including `anyOf`, `$ref`, and `enum`, and property ordering is now preserved in output (output field order matches schema definition order — useful for streaming consumers). Available across all Gemini 2.5 models and the OpenAI compatibility endpoint. The Vertex AI structured output API follows the same pattern.

### Azure OpenAI

Mirrors OpenAI's Structured Outputs API with `strict: true` support. Known issue: the Responses API variant has had intermittent schema rejection bugs reported in early 2026; use the Chat Completions API path for production. Azure applies the same llguidance engine as OpenAI proper.

### Mistral and DeepSeek

Both support JSON mode (layer 2) but not full JSON schema constrained decoding at the token level. For schema enforcement with these models, use Outlines or llguidance at the self-hosted layer, or Instructor's retry-based approach for hosted endpoints.

---

## Open-Source Techniques Compared

| Library | Backend | Grammar Type | Startup Cost | Per-token Cost | vLLM/SGLang Integration | Notes |
|---|---|---|---|---|---|---|
| **Outlines** | Python/FSM | Regex, JSON Schema, CFG | 40s–10min for complex schemas | ~1ms | Plugin-based | Pioneered FSM precomputation; compilation latency can be high for large enum schemas |
| **XGrammar** | C++/Python | CFG/PDA via GBNF | Milliseconds | <40 µs | Default in vLLM and SGLang | Context-independent/dependent split; 100× over prior methods; MLSys 2025 |
| **llguidance** | Rust | CFG, JSON Schema, regex | ~2 ms | ~50 µs | vLLM (via lm-format-enforcer), OpenAI production | Microsoft; now powers OpenAI's structured output engine |
| **Guidance** | Python (llguidance backend) | Interleaved generation + constraints | ~2 ms | ~50 µs | Partial | High-level DSL for mixing generation and constraints |
| **vLLM guided decoding** | XGrammar (default) / lm-format-enforcer / outlines | Configurable | Depends on backend | Depends on backend | Native | `--guided-decoding-backend xgrammar` is current default |
| **SGLang** | XGrammar + compressed FSM | JSON Schema, regex | Milliseconds | <40 µs | Native | RadixAttention + compressed FSM = 2× latency reduction, 2.5× throughput vs uncompressed |
| **llama.cpp GBNF** | C++ | GBNF (EBNF variant) | Near-instant for simple grammars | Low | Via llama-server | Converts JSON Schema subset to GBNF; full server support for `response_format` |
| **LMQL** | Python | SQL-like constraints | High | Medium | None native | Academic origin; powerful but niche production adoption |
| **AICI** | Rust WASM | Arbitrary WASM programs | Medium | Low | Experimental | Most flexible; allows arbitrary compute at each token step |

**Practical guidance:** For self-hosted open-weight models in 2026, default to XGrammar (already the vLLM and SGLang default). For hosted models, use provider-native structured outputs. For grammar engineering that requires complex interleaving (e.g., reasoning traces with embedded structured blocks), reach for Guidance.

---

## Reliability: What "100% JSON" Actually Guarantees

The "100% reliability" claim deserves precise unpacking. What providers guarantee is this: **the output will be parseable JSON that validates against the supplied schema**. That is all.

The guarantee does **not** cover:

- **Semantic correctness.** A schema with `"confidence": { "type": "number" }` will always return a number — but there is no constraint preventing `0.9999` when the correct answer is `0.3`. Enum fields prevent creative values, but free-form strings remain model-generated.
- **Refusal-as-valid-JSON.** Claude and GPT-4o will both, under certain conditions, produce a schema-valid JSON response where a string field contains a refusal message: `{ "answer": "I cannot assist with that request." }`. The grammar is satisfied; the downstream pipeline is not.
- **Hallucinated but valid values.** If your schema has `"country": { "type": "string" }` rather than an enum, the model can confidently return `"Nether Netherlands"` or any other plausible string that happens not to exist.
- **Numeric range constraints.** JSON Schema `minimum`, `maximum`, `minLength`, `maxLength` annotations are **not enforced by the constrained decoding layer** in most implementations. They are advisory schema documentation. The grammar engine enforces structural type, not value ranges.
- **Context-length truncation.** If the model hits a token limit mid-structure, the grammar engine will attempt to force a valid closing — different engines handle this differently. XGrammar and llguidance attempt graceful completion; naive implementations emit truncated invalid JSON.

The practical implication: structured output removes the parse-error failure mode entirely, but replaces it with a semantic validation responsibility you must own. Add an application-layer validator (Pydantic, Zod, custom) that checks value plausibility after the schema check passes.

---

## Latency and Quality Trade-offs

### The Latency Picture (Good News)

Early constrained decoding implementations (Outlines, 2023) had severe startup costs — compiling complex JSON schemas to FSMs could take 40 seconds to over 10 minutes for schemas with large enums or deeply nested `oneOf`. This was the primary barrier to production adoption.

By 2025–2026, this is largely solved:

- **XGrammar**: <40 µs per token, millisecond-scale grammar compilation. The context-independent token precomputation (covering ~99% of the vocabulary) means the runtime hot path barely touches the grammar engine.
- **llguidance (Rust)**: ~50 µs CPU per token, ~2 ms startup. Now powers OpenAI's production engine.
- **SGLang + XGrammar**: Combines compressed finite-state machines with RadixAttention KV cache reuse. For structured generation workloads with shared prefixes (e.g., same system prompt + schema across 1000 requests), SGLang achieves 2× latency reduction and 2.5× throughput improvement over uncompressed approaches.

The net result: for hosted providers and modern self-hosted stacks, constrained decoding overhead is 1–5% of total inference time — effectively within measurement noise.

One counterintuitive win: structured outputs often **reduce total latency** compared to unconstrained generation, because the model generates no conversational filler, stops immediately when the JSON closes, and eliminates the retry logic that unstructured approaches require.

### The Quality Picture (Nuanced)

The latency story is simple. The quality story is not.

**The core tension:** Constrained decoding works by masking invalid tokens. If the model's top-10 predicted tokens are all grammatically invalid at a given position, it must choose from lower-probability alternatives. This can produce syntactically correct but semantically degraded output — correct structure, wrong content.

**The "constrained decoding hurts reasoning" finding:** Multiple 2025 papers empirically observed that strict grammar constraints reduce functional correctness for tasks requiring multi-step reasoning. The proposed mechanism: reasoning models build coherent token chains; interrupting the natural token probability distribution mid-chain degrades the reasoning quality of later tokens.

**CRANE's solution (Feb 2025, ICML 2025):** Rather than applying constraints to the entire generation, CRANE alternates between unconstrained windows (for reasoning steps, chain-of-thought) and constrained windows (for structured output blocks). A grammar tag (`<json>...</json>`) delimits where constraints activate and deactivate. Results: up to 10 percentage points improvement over pure constrained decoding on GSM-Symbolic and FOLIO symbolic reasoning benchmarks.

**Practical implication for agents:** For simple extraction or classification tasks, full schema constraint is fine — the "reasoning" required is minimal. For complex reasoning tasks (multi-step plans, evaluations, tool selection with nuanced context), consider CRANE-style architectures: let the model reason freely, then constrain the final structured output block. This is actually how tool-use is implemented in most frontier models — the model reasons in natural language in a scratchpad, then emits a constrained tool call.

---

## Grammar Engineering in Practice

### Schema Patterns That Work Well

**Flat objects with enum fields.** The grammar is simple, compilation is fast, and enum constraints dramatically improve output quality by eliminating hallucination on categorical fields. `"action": { "type": "string", "enum": ["route_to_billing", "route_to_support", "escalate"] }` is one of the highest-value uses of constrained decoding.

**Discriminated unions via `oneOf` with literal discriminators.** Most grammar engines handle this well when the discriminator field is the first property in the schema.

**Arrays with `maxItems`.** Keeps grammar state bounded. Arrays with unbounded `maxItems` or recursive schemas can cause exponential state growth in FSM-based engines — use XGrammar (PDA-based) for those cases.

**Required fields declared explicitly.** Never rely on the model to infer required vs optional; declare everything that must be present in `required`. The constraint engine will enforce it.

### Schema Patterns That Cause Degradation

**Large `enum` arrays (100+ values).** FSM-based engines like Outlines compile each enum value as a parallel branch — 100 values means 100 branches per transition. Compilation time blows up. Use XGrammar or a tiered approach (constrain to a category enum, then free-string for the item within that category).

**Unbounded recursive schemas.** Avoid `$ref`-based recursion in grammars unless your engine is PDA-based. Most FSM engines cannot represent recursive grammars at all.

**Complex `anyOf`/`oneOf` with overlapping types.** Grammar engines struggle with ambiguous grammars — the same token can be valid for multiple branches. This forces backtracking or speculative execution. Prefer discriminated unions with explicit discriminator fields.

**Deep nesting (>4 levels).** Each nesting level multiplies the grammar state space. Flatten schemas where possible for both compilation performance and model compliance (deeply nested schemas also tend to produce worse model outputs).

**String fields with `minLength`/`maxLength`.** These annotations are not enforced by most grammar engines — don't rely on them for correctness.

### Streaming-Compatible Grammar Design

When streaming is required, grammars need to produce valid partial output at every checkpoint. JSON lends itself well to streaming validation — each closing brace/bracket produces a parseable partial structure. Libraries like `partial-json` (Python) can parse streaming fragments. However, interruptible generation mid-structure requires the grammar engine to maintain and expose its FSM state — not all engines do this. Outlines saves FSM state between chunks explicitly. XGrammar's checkpoint API supports this. llama.cpp's server handles streaming JSON natively.

---

## Agent-Specific Use Cases

### Tool Argument Validation

The highest-value application. Every time an agent invokes a tool, the arguments must match the tool's parameter schema. Without constrained decoding, the agent can generate `{"path": "/home/user/file.txt", "mode": "reed"}` — syntactically fine, semantically wrong (enum typo). With a schema `"mode": { "enum": ["read", "write", "append"] }`, the grammar engine prevents the typo entirely.

This is not hypothetical: a 2025 survey of agentic failures found that malformed tool arguments were among the top three causes of multi-step agent pipeline failures, alongside context length overflow and incorrect tool selection.

### Routing and Dispatcher Decisions

In multi-agent systems, a router model decides which downstream agent or tool handles a request. Schema: `{ "target": { "enum": [...all agent names...] }, "priority": { "enum": ["high", "normal", "low"] }, "reason": { "type": "string" } }`. The enum constraint on `target` makes misrouting syntactically impossible — the model cannot name an agent that isn't in the schema.

### Plan Emission

Long multi-step plans benefit from structured output for the plan skeleton (steps, dependencies, expected outputs) while leaving the reasoning scratchpad unconstrained. A CRANE-style architecture fits perfectly: reason freely → emit structured plan object.

Example schema pattern for a plan step array:

```json
{
  "type": "array",
  "items": {
    "type": "object",
    "required": ["step_id", "action", "tool", "depends_on"],
    "properties": {
      "step_id": { "type": "integer" },
      "action": { "type": "string" },
      "tool": { "enum": ["bash", "web_search", "file_write", "memory_update"] },
      "depends_on": { "type": "array", "items": { "type": "integer" }, "maxItems": 5 }
    }
  },
  "maxItems": 20
}
```

### Memory Write Schemas

Structured output is especially valuable for memory writes, where silent semantic drift is dangerous. A memory write schema that includes `"confidence": { "enum": ["high", "medium", "low"] }`, `"category": { "enum": ["fact", "preference", "event", "decision"] }`, and `"overwrites_prior_id"` forces the model to be explicit about what it's doing and why.

### Evaluator Outputs (LLM-as-Judge)

See the April 10 piece on LLM-as-judge. The short version: evaluator outputs should always use constrained decoding. `"verdict": { "enum": ["pass", "fail", "partial"] }`, `"score": { "type": "integer", "minimum": 1, "maximum": 5 }` (note: minimum/maximum not enforced at grammar level — add a range validator). Structured evaluator output makes automated evaluation pipelines tractable.

---

## Failure Modes in Production

### Schema Drift Across Provider Versions

When a provider updates their model (silently, as is standard practice), behavior can shift. A schema that the old model handled gracefully may hit edge cases on the new model — particularly around `oneOf` disambiguation and optional field handling. Mitigation: pin model versions in production (`gpt-4o-2024-08-06` not `gpt-4o-latest`), add version fields to your structured output, and run regression suites against output schemas after any model bump.

### Semantic Validity vs Syntactic Validity

The most common source of confusion: the schema constraint passes, but the output is wrong. A routing agent returns `{ "target": "memory_agent" }` when the correct answer was `{ "target": "search_agent" }`. Both are schema-valid. Only one is correct. Never use "schema validates" as the sole indicator of correctness. Add semantic assertions at the application layer.

### Refusal-as-Valid-JSON

Both GPT-4o and Claude will occasionally produce schema-valid responses where string fields contain refusal content. Detection pattern: check free-text fields for refusal signatures (`"I cannot"`, `"I'm unable to"`, `"I don't have"`) and handle them as a separate error class. This is especially relevant for evaluator schemas where a `"reason"` string field may contain a refusal instead of an evaluation.

### Streaming Tool Arguments with Incomplete JSON

When streaming is enabled and the connection drops mid-generation, the grammar engine has produced a valid prefix but not a complete structure. Most client libraries surface this as a `StreamInterruptedError` or return a partial object. Handle explicitly: don't feed partial tool arguments to tool execution. Anthropic's API returns `stop_reason: "max_tokens"` when truncation occurs — check for this.

### Grammar Compilation Cache Misses

Grammar compilation (especially for Outlines-style FSM approaches) can be expensive on first invocation. In a high-throughput system, a cache miss during a traffic spike can cause a cascade of slow schema compilations. Mitigate by pre-warming the grammar cache at startup with all schemas your agent uses. XGrammar and llguidance are fast enough that cold starts are rarely an issue, but Outlines-based systems need explicit warming.

### Enum Explosion

A schema with `"country_code": { "enum": [248 ISO country codes] }` can cause compilation times in the minutes range for FSM-based engines. Debug signal: grammar compilation hangs or is very slow on first call. Fix: switch to XGrammar, or restructure the schema to use a string type with post-validation.

---

## Tool-Use as Constrained Decoding (The Hidden Layer)

A detail rarely spelled out in documentation: **function calling and tool-use are implemented as constrained decoding at every major provider.**

When you pass a tool definition to the API, the provider compiles the tool's parameter schema into a grammar and constrains the model's output to that grammar when it decides to emit a tool call. The model's "decision to call a tool" is itself part of this process — a special FSM state representing "begin tool call" is added to the grammar, and the model's probability of transitioning to that state reflects its learned tool-use behavior.

This has several implications:

- **Tool calling IS structured output.** The `strict: true` flag on Anthropic tool definitions and OpenAI's `strict` on function schemas both activate full constrained decoding for tool arguments. Without it, you get best-effort schema following.
- **The scratchpad is unconstrained.** Frontier models (Claude, GPT-4o, Gemini) emit a reasoning trace or inner monologue before the tool call structure. This is unconstrained text. The constraint only applies to the tool call itself. This is why tool-use doesn't degrade reasoning — the model reasons freely, then emits a constrained call.
- **Open-weight function calling is a trained behavior + constrained decoding.** Models like Llama 3 and Mistral instruct variants are fine-tuned to emit tool calls in a specific format (e.g., `[TOOL_CALL]{ "name": "...", "arguments": {...} }[/TOOL_CALL]`), and the serving framework constrains the argument object to the provided schema. The trained behavior provides the semantic intent; the constraint provides the syntactic guarantee.
- **Parallel tool calls.** When a model emits multiple tool calls in a single turn, each call is a separate constrained block. The grammar engine interleaves the constraints.

---

## Practical Recipes for Zylos-Style Agents

These patterns assume a Zylos-style agent: Claude as the primary model, Node.js/Python orchestration, mix of hosted tool calls and self-invoked subagents.

**Recipe 1: Tool argument schemas — always strict.**
```javascript
const tool = {
  name: "route_task",
  input_schema: {
    type: "object",
    required: ["target", "priority"],
    properties: {
      target: { type: "string", enum: ["memory_agent", "search_agent", "exec_agent"] },
      priority: { type: "string", enum: ["high", "normal", "low"] },
      reason: { type: "string", maxLength: 200 }
    },
    additionalProperties: false
  }
};
// Pass to Claude API with strict: true
```
The `additionalProperties: false` plus explicit `required` array is the minimum for meaningful constraint. Without both, the model can add unexpected fields or omit required ones.

**Recipe 2: Evaluator outputs — structured + range-validate.**
Define the verdict and score as enum/integer in the schema, then validate numeric ranges in your application code. Don't rely on `minimum`/`maximum` annotations.

**Recipe 3: Plan emission — CRANE-style.**
Instruct the model to reason in a `<thinking>` block (unconstrained) before emitting the structured plan (constrained). Claude's extended thinking feature integrates naturally here — the thinking token budget handles free-form reasoning, and the final response is constrained to the plan schema.

**Recipe 4: Memory writes — version-stamp schemas.**
Include a `schema_version` integer field in all memory write schemas. When you evolve the schema, bump the version. This makes schema drift explicit and queryable in your memory store.

**Recipe 5: Fallback to unconstrained + validator for complex schemas.**
If your schema has >50 enum values, deep recursion, or complex `anyOf` patterns, consider: emit unconstrained JSON, parse it, validate with Pydantic/Zod, and retry once on failure. For most complex schemas, one retry reduces effective error rate to near zero at lower grammar engineering cost than forcing a perfect constrained grammar.

**Recipe 6: Pre-warm grammars at startup.**
For any schema you use more than once per session, make a warm-up call at startup (or trigger grammar compilation at module load time). In Outlines, call `outlines.generate.json(model, schema)` at startup. In llguidance, the 2ms startup cost means this matters less but is still good hygiene.

**Recipe 7: Monitor refusal-in-valid-JSON.**
Add a lightweight post-parse check for refusal signatures in string fields. Log schema-valid-but-semantically-refused responses as a separate metric. A rising rate of these indicates a prompt that's hitting content policy edges and needs adjustment.

---

## Sources

1. XGrammar paper: Dong et al., "XGrammar: Flexible and Efficient Structured Generation Engine for Large Language Models," arXiv:2411.15100 (MLSys 2025). [https://arxiv.org/pdf/2411.15100](https://arxiv.org/pdf/2411.15100)

2. XGrammar MLC Blog: "Achieving Efficient, Flexible, Portable Structured Generation with XGrammar," MLC Blog, Nov 2024. [https://blog.mlc.ai/2024/11/22/achieving-efficient-flexible-portable-structured-generation-with-xgrammar](https://blog.mlc.ai/2024/11/22/achieving-efficient-flexible-portable-structured-generation-with-xgrammar)

3. XGrammar GitHub: mlc-ai/xgrammar. [https://github.com/mlc-ai/xgrammar](https://github.com/mlc-ai/xgrammar)

4. CRANE paper: Beurer-Kellner et al., "CRANE: Reasoning with Constrained LLM Generation," arXiv:2502.09061 (ICML 2025). [https://arxiv.org/abs/2502.09061](https://arxiv.org/abs/2502.09061)

5. OpenAI Introducing Structured Outputs: [https://openai.com/index/introducing-structured-outputs-in-the-api/](https://openai.com/index/introducing-structured-outputs-in-the-api/)

6. OpenAI Structured Outputs Docs: [https://developers.openai.com/api/docs/guides/structured-outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

7. Anthropic Structured Outputs Docs: [https://platform.claude.com/docs/en/build-with-claude/structured-outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

8. Anthropic Agent SDK Structured Outputs: [https://platform.claude.com/docs/en/agent-sdk/structured-outputs](https://platform.claude.com/docs/en/agent-sdk/structured-outputs)

9. Google Gemini Structured Output Docs: [https://ai.google.dev/gemini-api/docs/structured-output](https://ai.google.dev/gemini-api/docs/structured-output)

10. Google Blog: "JSON Schema and implicit property ordering in Gemini API": [https://blog.google/technology/developers/gemini-api-structured-outputs/](https://blog.google/technology/developers/gemini-api-structured-outputs/)

11. llguidance GitHub: guidance-ai/llguidance. [https://github.com/guidance-ai/llguidance](https://github.com/guidance-ai/llguidance)

12. llguidance "Making Structured Outputs Go Brrr": [https://guidance-ai.github.io/llguidance/llg-go-brrr](https://guidance-ai.github.io/llguidance/llg-go-brrr)

13. Guidance GitHub: guidance-ai/guidance. [https://github.com/guidance-ai/guidance](https://github.com/guidance-ai/guidance)

14. vLLM Structured Outputs (Red Hat Developer): [https://developers.redhat.com/articles/2025/06/03/structured-outputs-vllm-guiding-ai-responses](https://developers.redhat.com/articles/2025/06/03/structured-outputs-vllm-guiding-ai-responses)

15. SGLang GitHub: sgl-project/sglang. [https://github.com/sgl-project/sglang](https://github.com/sgl-project/sglang)

16. SqueezeBits: "Guided Decoding Performance on vLLM and SGLang": [https://blog.squeezebits.com/guided-decoding-performance-vllm-sglang](https://blog.squeezebits.com/guided-decoding-performance-vllm-sglang)

17. llama.cpp GBNF Grammar README: [https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md)

18. Constrained Decoding Guide (Aidan Cooper): [https://www.aidancooper.co.uk/constrained-decoding/](https://www.aidancooper.co.uk/constrained-decoding/)

19. "How Structured Outputs and Constrained Decoding Work" (Let's Data Science): [https://www.letsdatascience.com/blog/structured-outputs-making-llms-return-reliable-json](https://www.letsdatascience.com/blog/structured-outputs-making-llms-return-reliable-json)

20. "LLM Structured Output in 2026: Stop Parsing JSON with Regex" (DEV Community): [https://dev.to/pockit_tools/llm-structured-output-in-2026-stop-parsing-json-with-regex-and-do-it-right-34pk](https://dev.to/pockit_tools/llm-structured-output-in-2026-stop-parsing-json-with-regex-and-do-it-right-34pk)

21. "Generating Structured Outputs from Language Models: Benchmark and Studies" (arXiv:2501.10868): [https://arxiv.org/html/2501.10868v1](https://arxiv.org/html/2501.10868v1)

22. SGLang NeurIPS 2024 Paper: [https://proceedings.neurips.cc/paper_files/paper/2024/file/724be4472168f31ba1c9ac630f15dec8-Paper-Conference.pdf](https://proceedings.neurips.cc/paper_files/paper/2024/file/724be4472168f31ba1c9ac630f15dec8-Paper-Conference.pdf)

23. Anthropic Structured Outputs Launch (TechBytes): [https://techbytes.app/posts/claude-structured-outputs-json-schema-api/](https://techbytes.app/posts/claude-structured-outputs-json-schema-api/)

24. "LLM Structured Outputs: Schema Validation for Real Pipelines (2026)" (Collin Wilkins): [https://collinwilkins.com/articles/structured-output](https://collinwilkins.com/articles/structured-output)

25. CMU XGrammar MarkTechPost: [https://www.marktechpost.com/2024/11/24/cmu-researchers-propose-xgrammar-an-open-source-library-for-efficient-flexible-and-portable-structured-generation/](https://www.marktechpost.com/2024/11/24/cmu-researchers-propose-xgrammar-an-open-source-library-for-efficient-flexible-and-portable-structured-generation/)
