---
date: "2026-04-26"
time: "21:14"
title: "Contract Testing for Agent Tool Interfaces"
description: "How schemas, consumer contracts, golden traces, and compatibility gates keep AI agent tools stable as runtimes evolve."
tags:
  - research
  - ai-agents
  - testing
  - contracts
  - tooling
---

## Executive Summary

Production AI agents need contract testing at the tool boundary, not only end-to-end evals at the natural-language boundary. The fragile interface is where probabilistic planning turns into deterministic action: tool selection, generated arguments, command execution, structured results, error handling, retries, permissions, and state changes.

The practical pattern is a layered contract stack: machine-readable schemas for tool input and output, consumer-driven expectations for what the agent actually relies on, golden traces for workflow regression, and compatibility gates for runtime/API evolution. This is especially important for long-running coding and operations agents, where tool definitions, CLI behavior, provider SDKs, and model behavior can drift independently.

## Why Tool Contracts Are Different for Agents

Traditional API clients are deterministic programs. If a backend removes a field or changes an enum, the client usually fails in a direct, reproducible way. Agent clients are different: the "client" is a model-guided planner that infers which tool to call and how to call it from names, descriptions, schemas, previous messages, runtime state, and feedback from earlier tool results.

That changes what a contract must cover.

**Tool selection is part of the contract.** A normal API contract starts after the caller has already chosen an endpoint. An agent contract starts earlier: the tool name, description, schema, and surrounding context influence whether the model picks the right tool at all. A schema-compatible wording change can still cause a tool-selection regression.

**Valid JSON is not valid intent.** JSON Schema can prove that an argument is shaped correctly, but it cannot prove that the model chose the right candidate ID, path, query, branch, email recipient, or deletion target. Agent contract tests need semantic fixtures, not just syntax validation.

**Errors must be machine-interpretable.** Human-readable CLI errors are often enough for a developer at a terminal. They are weak for agents. A production agent needs stable error codes, retryability signals, partial-result markers, and clear "safe to continue" semantics.

**Runtime adapters are contracts too.** The same logical tool may be exposed through MCP, OpenAI function calling, Anthropic tool use, Gemini function calling, a local CLI, or an internal RPC layer. These formats are similar but not identical. Schema dialects, strictness, output support, parallel call behavior, and error representation vary by runtime.

**Long-running sessions preserve old assumptions.** Agents can cache tool schemas, hold plans across restarts, or resume from prior context. A change that looks safe for a fresh session may break a session already mid-task.

## The Current Foundation

### MCP Tool Schemas

The Model Context Protocol has become a central open interface for exposing tools to agents. MCP tool definitions include model-facing names and descriptions plus JSON Schema-based input contracts. The schema reference also defines structured tool results, including conventions for `structuredContent` and output schemas in newer versions of the specification.

MCP is a good discovery and invocation layer, but it is not a full contract-testing system. It answers "what tools exist and how do I call them?" It does not by itself answer "which fields do current agents depend on?", "which changes are breaking?", "which failures should be replayed in CI?", or "which model/runtime adapters preserve semantics?"

### JSON Schema and OpenAPI

JSON Schema remains the common denominator for structured tool parameters. OpenAPI 3.1 aligned its Schema Object with JSON Schema 2020-12, which makes OpenAPI a more useful source for generating HTTP-backed tools and validating request/response bodies.

For agent tools, the hard part is compatibility policy. Adding an optional field is usually backward-compatible for deterministic clients. For agents, even optional fields can change behavior if they affect the model-facing schema or description. Removing a field, narrowing an enum, changing default behavior, or altering an error meaning should be treated as a breaking tool contract change unless a compatibility layer preserves the old behavior.

### Provider-Specific Structured Outputs

Provider APIs have moved toward stricter structured generation. OpenAI's Structured Outputs added `strict: true` for schema adherence in function calling. Anthropic and Gemini also support tool/function declarations with schema-like inputs. These features reduce malformed arguments, but they do not eliminate contract risk.

Each provider supports a slightly different subset of schema behavior and surfaces tool calls differently. A runtime that claims provider portability needs conformance tests for its adapter layer: given the same logical tool descriptor, does each provider receive an equivalent definition, reject the same invalid schemas, and return equivalent call/result events?

### Consumer-Driven Contract Testing

Pact and consumer-driven contract testing provide the strongest prior art. The core idea is simple: consumers encode what they depend on, providers verify against those expectations, and compatibility is checked before deployment.

For agent systems, the consumer is not only application code. It is also the agent policy, prompt, runtime adapter, workflow graph, and evaluation harness that rely on a tool's behavior. A provider-owned schema is useful, but it is incomplete. The agent-side contract should record the exact fields, errors, ordering assumptions, side effects, and retry semantics that real workflows consume.

The Pact lesson that matters most is restraint: assert what the consumer depends on, not every incidental byte. Agent contracts that require exact transcripts or rigid step sequences become noisy. Contracts that assert stable typed artifacts are much more durable.

### Schema Registries and Breaking-Change Gates

Schema registry ecosystems show mature compatibility patterns. Confluent Schema Registry defines backward, forward, and full compatibility modes for evolving schemas. Buf applies breaking-change detection to Protocol Buffers in CI. The same principle belongs in agent tool registries.

Each tool descriptor should be versioned. CI should compare new descriptors against published versions and block changes that remove fields, rename tools, narrow accepted values, change output semantics, or alter side-effect classes without a migration path.

### Golden Traces and Agent Regression

OpenTelemetry's GenAI semantic conventions define spans for GenAI operations and agent/tool execution. These traces are useful not just for observability, but also as raw material for regression fixtures. A failing production trace can be redacted, minimized, and promoted into a contract test.

Agent regression research is also moving toward trace-first testing. AgentAssay, published in March 2026, proposes token-efficient regression testing for non-deterministic agent workflows using execution traces, behavioral fingerprints, mutation operators, and statistical PASS/FAIL/INCONCLUSIVE gates. The important shift is away from exact output comparison and toward structured behavior comparison.

## A Contract Stack for Agent Tools

No single test type is enough. A useful production setup has several layers.

### Tool Descriptor Contract

Every tool should have a versioned descriptor that includes:

- Stable tool name and namespace
- Human-readable description
- Input schema
- Output schema
- Structured error schema
- Side-effect class, such as read-only, idempotent write, external send, or destructive mutation
- Timeout and cancellation behavior
- Auth scope or permission bundle
- Idempotency key behavior for writes
- Deprecation status and replacement path

Descriptions should be treated as model-facing contract text. They are not comments. If wording changes how a model selects or fills a tool, it is behavior.

### Runtime Adapter Contract

Each runtime adapter should be tested separately from the tool implementation. A logical descriptor should round-trip into every supported exposure format:

- MCP tool definition
- OpenAI function/tool schema
- Anthropic tool schema
- Gemini function declaration
- CLI command contract
- Internal RPC or queue message

The adapter contract should validate supported schema dialects, required metadata, error mapping, output normalization, and provider-specific restrictions.

### Consumer Contract

The agent side should declare what it actually depends on. For example:

- This workflow expects `status` to be one of `completed`, `failed`, or `partial`
- This retry loop depends on `retryable: true`
- This delete operation depends on idempotent behavior when the target is already absent
- This list operation depends on stable pagination order
- This raw-content reader depends on a machine-readable not-found code

These contracts are more valuable than broad provider-owned specs because they encode real usage.

### Golden Trace Contract

Golden traces should be structured event graphs, not raw chat transcripts. A good trace fixture captures:

- Root task metadata
- Tool definitions visible to the agent
- Tool call sequence, with partial-order assertions where possible
- Argument shape and selected semantic values
- Structured tool results
- Exit codes or error classes
- State transitions
- External side-effect receipts
- Model/provider/runtime version metadata

The test should avoid brittle assertions on incidental prose. It should assert the deterministic artifacts that matter.

### Compatibility Gate

Before a tool/runtime change merges, CI should run:

- Schema diff against the previous published descriptor
- Provider adapter conformance tests
- Consumer contract verification
- Golden trace replay against deterministic mocks
- Negative tests for malformed inputs, permission denial, timeout, partial result, and stale data
- A small live smoke test for the highest-risk integration paths

This gate should fail closed for destructive tools and fail with warnings for low-risk read-only additions, depending on the side-effect class.

## Design Rules for Long-Running Agents

**Version tools like APIs.** Patch releases should preserve behavior. Minor releases can add backward-compatible fields or capabilities. Major releases can break behavior, but only with explicit migration and deprecation windows.

**Keep old contracts executable.** A tool registry should retain previous descriptors and fixtures long enough to verify compatibility with sessions and runtimes that have not upgraded yet.

**Prefer stable error envelopes.** A useful error payload has `code`, `message`, `retryable`, `safe_to_continue`, `user_action_required`, and `details`. The human-readable message can change; the code should not change casually.

**Separate schema validity from semantic validity.** Validate shape at the boundary, but test semantic examples in fixtures. For a coding agent, that means branch names, file targets, patch formats, exit codes, and permission states need scenario coverage.

**Record side effects as receipts.** For tools that send messages, write files, create PRs, modify calendars, or delete resources, the contract should include an observable receipt. This lets the agent and the test harness distinguish "requested" from "actually completed."

**Use deterministic mocks for contract tests.** Full agent behavior is stochastic. Tool contract tests should minimize variance by fixing tool responses, model settings where possible, and runtime state. Use statistical evals for full workflow behavior, not for low-level schema compatibility.

**Promote incidents into fixtures.** When a real failure occurs, redact it, reduce it to the minimal event graph, and add it to the contract suite. Production-derived fixtures are often better than synthetic happy paths.

**Treat descriptions as executable surface area.** Description rewrites should run tool-selection and argument-generation tests, even if the JSON Schema is unchanged.

**Design for provider divergence.** Maintain a supported-schema profile per provider/runtime. If one adapter cannot express a constraint, either reject that tool for the provider or add a compensating runtime validator.

## Failure Modes to Test

Agent tool contracts should include negative cases by default:

- Unknown tool name
- Missing required argument
- Extra argument when strict mode is enabled
- Wrong enum value
- Semantically invalid but schema-valid ID
- Timeout
- Cancellation
- Permission denied
- Partial result
- Empty result
- Stale cache result
- Duplicate write with same idempotency key
- Duplicate write without idempotency key
- Malformed provider response
- Tool result that is valid JSON but missing expected semantic fields
- Runtime adapter rejecting a schema that another provider accepts

These cases are not edge details. They are where agents most often fall out of alignment with their tools.

## Risks and Tradeoffs

**Schema false confidence.** JSON Schema is necessary, but it only proves shape. A valid tool call can still be the wrong action.

**Brittle golden traces.** Exact step-by-step trace matching can punish valid improvements in planning. Prefer typed assertions, partial ordering, and semantic invariants.

**Compatibility drag.** Backward-compatible shims accumulate. Use telemetry to see when old contracts are no longer exercised, then remove them on a published schedule.

**Provider divergence.** Schema and tool-call behavior differs across LLM providers. A portability layer needs real conformance tests, not just type definitions.

**Trace privacy.** Golden traces can capture secrets, private text, paths, customer data, or credentials. Redaction must happen before persistence and before any fixture is shared.

**Unclear ownership.** Tool providers, runtime maintainers, prompt authors, and workflow owners may all think someone else owns compatibility. Consumer-driven contracts work only when review ownership is explicit.

**Over-testing model prose.** Natural-language outputs are often too unstable for low-level contracts. Use them sparingly and keep deterministic artifacts as the primary assertions.

## Practical Minimum Viable Setup

A small team does not need a large platform to start. The useful minimum is:

1. JSON Schema for every tool input and output.
2. A stable structured error envelope.
3. A contract fixture for each important tool use case.
4. A golden trace for each critical workflow and each major incident.
5. A schema-diff CI check.
6. Runtime adapter tests for each provider or transport.
7. A redaction process for turning production failures into regression fixtures.

The payoff is not only fewer runtime failures. It is operational confidence: when a tool, model, provider SDK, or runtime adapter changes, the team can see whether existing agent workflows still mean the same thing.

## Sources

- [Model Context Protocol schema reference](https://modelcontextprotocol.io/specification/draft/schema)
- [Anthropic: Introducing the Model Context Protocol](https://www.anthropic.com/news/model-context-protocol)
- [OpenAI Agents SDK: MCP](https://openai.github.io/openai-agents-python/mcp/)
- [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12)
- [OpenAPI Specification 3.1.0](https://spec.openapis.org/oas/v3.1.0.html)
- [OpenAI: Introducing Structured Outputs in the API](https://openai.com/index/introducing-structured-outputs-in-the-api/)
- [Anthropic docs: Implement tool use](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use)
- [Gemini API docs: Function calling](https://ai.google.dev/gemini-api/docs/function-calling)
- [Pact documentation: Specification](https://docs.pact.io/getting_started/specification)
- [Pact documentation: Consumer tests](https://docs.pact.io/consumer)
- [Martin Fowler: Consumer-Driven Contracts](https://martinfowler.com/articles/consumerDrivenContracts.html)
- [PactFlow documentation: Compatibility checks](https://docs.pactflow.io/docs/bi-directional-contract-testing/compatibility-checks)
- [Confluent documentation: Schema evolution and compatibility](https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html)
- [Buf documentation: Breaking change detection](https://buf.build/docs/breaking/)
- [OpenTelemetry GenAI semantic conventions: agent and framework spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/)
- [OpenTelemetry GenAI semantic conventions: events](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-events/)
- [OpenAI: Evaluation best practices](https://platform.openai.com/docs/guides/evaluation-best-practices)
- [OpenAI Cookbook: Regression evals](https://cookbook.openai.com/examples/evaluation/use-cases/regression)
- [LangChain blog: Regression testing with LangSmith](https://www.langchain.com/blog/regression-testing)
- [AgentAssay: Token-Efficient Regression Testing for Non-Deterministic AI Agent Workflows](https://arxiv.org/abs/2603.02601)
