---
date: "2026-09-12"
title: "Routing Work by Agent Capability Profiles: From Claims to Evidence"
description: "A production routing loop that treats capability profiles as discovery claims, then verifies them with live state, observed outcomes, and policy constraints."
tags: ["research", "ai-agents", "multi-agent-systems", "task-routing", "capability-profiles", "observability", "security"]
---

## Executive Summary

An agent profile is useful for finding candidates, but it is not proof that an agent can complete a particular task now. A production router should treat profile fields as claims, combine them with observed task outcomes and current operating state, enforce authorization as a hard boundary, and record enough evidence to explain every assignment.

The resulting design is a closed loop: discover, shortlist, verify, assign, and learn. Semantic matching narrows the search space; calibrated outcome evidence estimates likely quality; live signals establish present feasibility; policy removes unsafe candidates; and post-task evaluation updates the next decision. This is more work than matching a task description to a skill description, but it is the difference between a directory and a routing system.

## A Profile Is a Discovery Contract, Not a Competence Certificate

The Agent2Agent protocol makes capability-based discovery concrete. An [A2A Agent Card](https://a2a-protocol.org/latest/topics/agent-discovery/) can publish identity, endpoints, protocol features, authentication requirements, and skills with descriptions, input modes, output modes, and examples. A client can use those fields to determine whether an agent appears suitable and how to call it.

That is valuable interoperability metadata. It still leaves several questions unanswered:

- Did the agent produce acceptable results on similar tasks?
- Was that evidence collected against the current agent version?
- Is the agent healthy, available, and within its concurrency limit now?
- Can it finish before this task's deadline and within its budget?
- May it access the required data and perform the required effects?
- Is its description honest, current, and safe to feed into a model-based router?

The same distinction prevents a common protocol mix-up. During initialization, [MCP clients and servers negotiate protocol capabilities](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), such as whether a server exposes tools, resources, or prompts. That negotiation determines which protocol features may be used on one connection. It does not certify that a remote agent is good at tax analysis, incident response, or code review. MCP capability negotiation and agent-level competence routing solve different problems.

A useful profile therefore contains facts of different authority:

1. **Declared contract:** identity, version, skills, supported modalities, interfaces, and resource requirements.
2. **Verified configuration:** approved tools, data classes, regions, models, and maximum authority.
3. **Observed evidence:** task-family outcomes, evaluator provenance, cost, latency, and failure history.
4. **Live state:** health, queue depth, current leases, rate limits, and freshness timestamps.

Keeping those layers separate matters. A profile owner may author the declared contract. It should not be able to overwrite independent evaluation history or manufacture a healthy heartbeat.

## The Five-Step Routing Loop

### 1. Discover and Normalize Profiles

Collect profiles from well-known endpoints, curated registries, or explicit configuration. A2A deliberately standardizes the Agent Card while leaving curated-registry APIs to implementations, so a deployment still needs to choose its registry, refresh, and trust model.

Normalize descriptions into a controlled schema before retrieval. Preserve the original text for audit, but extract fields such as task families, required inputs, produced artifacts, languages, tool dependencies, and risk class. Version every profile and record its source and fetch time.

Treat all free-form metadata as untrusted data. This is not only a registry-integrity problem: if an LLM performs routing, a malicious skill description can become an indirect instruction. [OWASP's prompt-injection guidance](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) recommends separating and clearly identifying external content and restricting model privileges. In practice, profile text should be delimited, length-limited, normalized, and excluded from the router's governing instructions.

### 2. Retrieve a Shortlist

Retrieval should be broad enough to avoid excluding an unfamiliar but suitable agent. Combine structured filters with semantic retrieval:

- Structured filters remove incompatible input and output modes, missing mandatory tools, and unsupported task classes.
- Semantic retrieval compares the task representation with normalized capability descriptions and representative examples.
- Diversity rules keep more than one plausible strategy or provider when the task permits it.

This stage optimizes recall, not final assignment quality. A July 2026 preprint, [Adapting Embedding Models for Agent Capability Retrieval](https://arxiv.org/abs/2607.17347), reports that fine-tuning general retrieval models on capability profiles improved transfer to two unseen catalogs. It is early evidence rather than an established production recipe, but it supports treating capability retrieval as its own measurable problem instead of assuming generic embeddings are sufficient.

### 3. Verify Evidence and Live Feasibility

For each shortlisted agent, join the declared profile with evidence that the agent does not control:

- Success and evaluator scores for comparable task families
- Sample size, recency, agent version, and evaluation conditions
- Timeout, retry, refusal, and partial-completion rates
- Actual cost and latency distributions, not only advertised averages
- Current heartbeat, queue depth, concurrency, and dependency health

Self-reported confidence may be one feature, but only after calibration against outcomes. The 2026 preprint [Agora](https://arxiv.org/abs/2607.09600) proposes allocating reasoning steps through confidence-calibrated auctions rather than raw confidence. Another early study, [OI-MAS](https://arxiv.org/abs/2601.04861), routes across agent roles and model scales using task state and confidence. These papers are useful design signals, not proof that one scoring method generalizes to every workload.

Historical evidence also needs uncertainty. Ten successes on the current version should usually outweigh one perfect result; old evidence should decay or be segmented after material changes; and a task far outside the evidence distribution should trigger exploration, escalation, or human review rather than a falsely precise score.

### 4. Apply Policy, Then Assign Scoped Authority

Eligibility and utility are different. Authorization, residency, data handling, required human approval, and effect risk should be hard constraints. An agent that violates them is ineligible even if it is faster and cheaper.

Only after policy filtering should the router compare eligible candidates. A decision contract might be written as:

```text
eligible(agent, task) =
  contract_compatible
  AND live_state_fresh
  AND required_data_allowed
  AND requested_effects_within_policy

utility(agent, task) =
  quality_weight   * calibrated_success_probability
  + deadline_weight * probability_of_finishing_on_time
  - cost_weight     * predicted_cost
  - uncertainty_weight * evidence_uncertainty
```

The formula is not universal. Its value is that each term names an observable input, its provenance, and the policy version used. Store the eligible set, rejected candidates and reasons, feature snapshot, chosen agent, score version, and fallback plan with the assignment.

Delegation should grant only the authority needed for that task. [OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693) defines delegation and supports issuing a token more narrowly scoped for a downstream service. The exact mechanism may differ, but the design principle is stable: do not pass the orchestrator's ambient credentials to the selected agent. Bind authority to the task, resources, allowed effects, and a short lifetime.

This boundary is becoming part of the standards agenda rather than remaining an application detail. [NIST's 2026 AI Agent Standards Initiative](https://www.nist.gov/news-events/news/2026/02/announcing-ai-agent-standards-initiative-interoperable-and-secure) names agent security and identity as one of its three pillars, alongside interoperable standards and open protocol development.

### 5. Observe, Evaluate, and Update

Execution telemetry should connect the routing decision to the resulting work. Record the task family, profile and agent versions, assignment features, tool and agent calls, cost, latency, completion status, and evaluator result under one correlation identifier.

[OpenTelemetry's GenAI agent span conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md) provide developing schemas for operations including agent creation, agent invocation, workflows, planning, and tool execution. They are a useful interoperability base, but they remain marked Development. More importantly, a trace says what ran; it does not by itself say whether the result was good. Quality labels need a separate, versioned evaluation process with human, rule-based, or model-based provenance.

Outcome updates should be task-family specific. A strong research record should not silently become evidence of safe production deployment. Preserve raw outcomes, derive calibrated summaries reproducibly, and make rollback possible when an evaluator or taxonomy changes.

## What Routing Research Already Establishes

Model-routing research provides a useful lower-dimensional analogy. [RouteLLM](https://arxiv.org/abs/2406.18665) trains routers from preference data to choose between a stronger and a weaker model. Its authors reported more than twofold cost reduction in some evaluations without reducing response quality; their accompanying results also show that performance depends on the benchmark and training distribution. On MMLU, routers trained only on Arena data performed near random until augmented with in-domain labels.

That distribution result is more important than any headline saving. A router's quality is conditional on its evidence. Capability profiles can improve candidate discovery, but they cannot replace task-relevant outcome data.

[RouterArena](https://arxiv.org/abs/2510.00202) makes the evaluation problem explicit with roughly 8,000 queries across 9 domains and 44 categories, three difficulty levels, and metrics for accuracy, cost, routing optimality, robustness, and router overhead. No single scalar captures the deployment trade-off. Agent routing adds even more dimensions: tool access, stateful collaboration, authority, side effects, and multi-step recovery.

Routing can also be sequential. [Router-R1](https://arxiv.org/abs/2506.09033) formulates model routing and aggregation as a multi-round decision process in which the router can reason, call models, incorporate responses, and decide again. Agent orchestration similarly needs explicit reassignment and escalation paths rather than assuming every task is a one-shot dispatch.

## Failure Modes to Design For

### Stale Profiles and Live-State Confusion

A cached card may accurately describe an agent's interface while the agent is overloaded or unavailable. Keep capability metadata and live state on separate freshness budgets. An expired heartbeat should affect present eligibility; it should not erase long-term competence evidence.

### Self-Reported Skill Inflation

An agent can claim broad expertise or emit high confidence. Claims can seed exploration, but repeated assignments should depend increasingly on independently scored outcomes. New agents need explicit cold-start policy so that a lack of history does not mean either automatic trust or permanent exclusion.

### Metadata Injection

Names, examples, and skill descriptions can contain instructions aimed at a model-based router. Parse them as data, never as governing prompts. Use deterministic validation before LLM ranking, isolate raw text, and keep irreversible policy checks in code.

### Cost Gaming

Advertised price can omit retries, tool calls, review cycles, or long outputs. Score realized task cost and completion cost, not only invocation price. Prevent the candidate from writing its own billing or success record.

### Cascading Delegation

Agent A may be authorized for a task and then delegate to Agent B. Without an explicit delegation chain, B can inherit authority that the original policy never evaluated. Record every hop, attenuate credentials at each hop, cap depth, and require the same policy gate for sub-assignment.

### Feedback Loops and Starvation

Always choosing the current leader concentrates evidence on that agent and starves alternatives, making the ranking self-reinforcing. Reserve a bounded exploration budget for low-risk tasks, use shadow evaluation where possible, and never let exploration bypass safety policy.

### Proxy Metrics Becoming Targets

If agents optimize for evaluator scores, latency, or cheap completion, they may learn shortcuts that lower real task value. Retain sampled human review, rotate adversarial cases, monitor score-to-outcome drift, and make the router's objective a versioned governance artifact.

## A Pragmatic Starting Point

The minimum useful implementation does not need an auction or reinforcement learning system.

1. Define a small, versioned task taxonomy and profile schema.
2. Store declared profiles separately from verified configuration, outcome evidence, and live state.
3. Retrieve several candidates by structured filters plus semantic similarity.
4. Enforce policy as eligibility rules before scoring.
5. Rank with a transparent score using calibrated quality, deadline probability, realized cost, and evidence uncertainty.
6. Assign task-scoped authority and a fallback deadline.
7. Trace the execution, attach an independent outcome label, and update task-family evidence.
8. Regularly replay historical tasks against new routing policies before promotion.

Start with conservative defaults: abstain when no candidate has adequate evidence, escalate high-impact actions, and log why each candidate was included or rejected. More sophisticated methods become useful only after the system has trustworthy task labels, live-state semantics, and an auditable decision ledger.

## Evidence and Limits

This analysis cross-checks protocol behavior against current A2A, MCP, OAuth, OpenTelemetry, OWASP, and NIST materials, then uses primary research papers for routing and retrieval results. Protocol documents establish available fields and security mechanisms; they do not establish that the proposed five-step loop is the only correct architecture.

The 2026 capability-retrieval, auction-routing, and confidence-aware multi-agent results are recent preprints. They are labeled here as early evidence and should be reproduced on a deployment's own task distribution before they influence production policy. RouteLLM, RouterArena, and Router-R1 evaluate model-routing problems, not the full authority and state surface of autonomous agents; their results motivate components of the design rather than validate the system as a whole.

## Open Questions

- How should capability taxonomies evolve without making old outcome evidence incomparable?
- What calibration method remains reliable when agents, models, tools, and evaluators all change?
- How much exploration is enough to avoid incumbent lock-in without wasting expensive or risky tasks?
- Which live signals belong in a shared interoperability protocol, and which should remain scheduler-local?
- How should a router value complementary teams when no individual agent covers the whole task?
- What evidence is sufficient for automated delegation, and when should abstention be mandatory?

The durable design rule is simple: **route on verified, current evidence—not on profile prose alone**. Profiles make an agent discoverable. Policy, live state, observed outcomes, and scoped authority make an assignment defensible.

---

*Sources: [A2A agent discovery](https://a2a-protocol.org/latest/topics/agent-discovery/), [MCP lifecycle and capability negotiation](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), [OWASP LLM01: Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/), [RouteLLM](https://arxiv.org/abs/2406.18665), [RouterArena](https://arxiv.org/abs/2510.00202), [Router-R1](https://arxiv.org/abs/2506.09033), [Agora](https://arxiv.org/abs/2607.09600), [OI-MAS](https://arxiv.org/abs/2601.04861), [Adapting Embedding Models for Agent Capability Retrieval](https://arxiv.org/abs/2607.17347), [OAuth 2.0 Token Exchange (RFC 8693)](https://www.rfc-editor.org/rfc/rfc8693), [OpenTelemetry GenAI agent span conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md), [NIST AI Agent Standards Initiative](https://www.nist.gov/news-events/news/2026/02/announcing-ai-agent-standards-initiative-interoperable-and-secure).*
