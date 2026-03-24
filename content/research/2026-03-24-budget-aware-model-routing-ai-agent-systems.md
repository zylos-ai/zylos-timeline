---
date: "2026-03-24"
title: "Budget-Aware Model Routing for AI Agent Systems"
description: "A practical guide to model routing for AI agents, covering cascades, preference-trained routers, contextual-bandit adaptation, and budget-aware per-step routing for production agent runtimes."
tags: ["ai-agents", "llm-routing", "cost-control", "model-selection", "agent-runtime", "token-proxy", "inference"]
---

## Executive Summary

Most teams still think about model routing as a prompt-time optimization problem: send easy requests to a cheap model, hard requests to an expensive model, and try to cut API bills without hurting quality. That framing is already incomplete for chatbots, and it is fundamentally insufficient for agent systems.

Agents do not make one model call. They execute sequences: interpret the request, decide whether to search, call tools, summarize results, ask follow-up questions, synthesize a plan, and sometimes loop through the whole process again. In that world, model selection is no longer a one-shot classification problem. It becomes a runtime control problem: which model should be used at each step, under which budget, with what fallback path, and based on what evidence?

This is why budget-aware routing is becoming one of the most important infrastructure capabilities for serious agent platforms in 2026. The core research direction is now clear:

- [FrugalGPT](https://arxiv.org/abs/2305.05176) established the baseline intuition that cascades and approximations can cut cost dramatically while preserving quality
- [RouteLLM](https://arxiv.org/abs/2406.18665) showed that preference data can train practical routers that choose between strong and weak models
- [Adaptive LLM Routing Under Budget Constraints](https://aclanthology.org/2025.findings-emnlp.1301.pdf) reframed routing as an online contextual bandit problem that learns from partial feedback under budget pressure
- [Budget-Aware Agentic Routing via Boundary-Guided Training](https://arxiv.org/abs/2602.21227) extended the problem to long-horizon agents, where routing decisions are sequential and early mistakes compound
- [Amazon Bedrock Intelligent Prompt Routing](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-routing.html) shows that major cloud vendors now treat routing as a first-class production primitive, not just a research idea

For Zylos and similar agent runtimes, the implication is straightforward: **Token Proxy should not be a passive billing shim. It should become a routing governor.** Its job is not merely to count tokens after the fact, but to shape agent behavior during execution: assign budgets, choose models step-by-step, observe quality and cost signals, and degrade gracefully before the system burns money on the wrong reasoning path.

The practical takeaway is that production-grade routing for agents should be built in three layers:

1. **Prompt-level routing** for simple single-shot tasks
2. **Step-level routing** inside agent workflows
3. **Task-level budget governance** across the full episode

Teams that stop at layer 1 get a cheaper chatbot. Teams that implement all three get an economically viable agent platform.

---

## Why Routing Becomes a First-Class Problem in Agent Systems

There are three structural reasons routing matters more for agents than for plain chat.

### 1. Cost compounds across steps, not prompts

A support bot answering one question can often tolerate a suboptimal model choice. An agent that executes six reasoning steps, three tool calls, and two retries cannot. If every step defaults to the strongest model, cost scales almost linearly with workflow depth. Once you have many concurrent agents, this becomes a platform problem rather than a feature problem.

The recent agentic-routing literature makes this explicit. The 2026 paper on Budget-Aware Agentic Routing argues that the main challenge is no longer “pick the best model for this prompt,” but “operate under strict per-task budgets in a sequential environment where early choices change later states.” That distinction matters. Static routing mistakes are local. Agentic routing mistakes accumulate.

### 2. Wrong cheap calls can be more expensive than right expensive calls

Routing is often described as a cost minimization exercise. In practice it is a **cost-quality frontier** problem. A cheap model that misclassifies the task, uses the wrong tool, or returns a flawed plan can trigger retries, extra context assembly, human escalation, or rollback work. The apparent savings from the cheaper call disappear quickly.

This is one of the deeper lessons from FrugalGPT. The original contribution was not merely “use smaller models sometimes.” It was that properly structured cascades can preserve or even improve quality relative to always calling the strongest model, because the system learns when to escalate and when not to.

### 3. Agents generate their own future workload

In ordinary inference systems, input arrives from users. In agent systems, today’s model output often determines tomorrow’s workload within the same task. A verbose plan creates more context. A weak tool selection creates more verification. An uncertain answer generates follow-ups. Routing therefore affects not only immediate inference cost, but downstream branching factor.

This is the key reason model routing should live inside the runtime, not just at the API gateway. The runtime can observe the evolving task state. A stateless proxy usually cannot.

---

## The Evolution of Routing: From Cascades to Agentic Controllers

The field has moved through four increasingly practical formulations.

### Stage 1: Cascades and approximation

FrugalGPT framed the problem in a simple but influential way: large models are expensive, model APIs have heterogeneous pricing, and there are straightforward strategies to reduce spend, including prompt adaptation, approximation, and cascades. The important operational idea is the cascade:

- try a cheaper path first
- escalate only when confidence or quality conditions fail
- preserve the performance of the strongest model at much lower average cost

This remains the mental starting point for routing systems. If a team cannot articulate its escalation conditions, it does not have a routing strategy, only a cost hope.

### Stage 2: Preference-trained routers

RouteLLM pushed the field closer to production by training routers on preference data rather than trying to infer complexity heuristics by hand. The key practical insight is that routing does not need a perfect symbolic definition of “hard query.” It can learn a decision surface from observed strong-vs-weak model preferences and then act as a drop-in replacement for a single-model API.

That matters for product teams because preference data is often easier to get than full labels. If users, reviewers, or internal evaluators can say “response A is better than response B,” a router can be trained.

This fits agent platforms well. Many agent tasks already produce pairwise review artifacts:

- did the smaller model produce the same plan as the larger model?
- was the tool call sequence acceptable?
- did the stronger model materially improve the final answer?

These are router-training signals hiding in plain sight.

### Stage 3: Online adaptive routing under budget constraints

The next problem is that offline datasets age. Query distributions shift. New models appear. Task mix changes. A router trained once can drift.

The 2025 EMNLP Findings paper on adaptive routing addresses this by treating routing as a **contextual bandit** problem. Instead of requiring full labels for all model choices, the system learns from the feedback it receives on the model it actually chose. This is much closer to real deployment conditions. In production you rarely run all models on all queries forever; you observe partial feedback and must improve online.

The paper’s second major contribution is equally relevant: cost is not an afterthought. It formalizes online budget allocation as a constrained decision problem, not just a logging metric.

For agent runtimes, this suggests a robust architecture:

- train the initial router offline using preference or benchmark data
- adapt online using task outcome and human correction signals
- enforce task-level budget caps at runtime

### Stage 4: Budget-aware agentic routing

Single-turn routing still assumes the unit of decision is the request. Agent systems break that assumption. The 2026 agentic-routing paper addresses the real problem directly: choose between small and large models **at each step** of a long-horizon workflow, under a fixed task budget, with sparse rewards and path dependence.

This is the most important conceptual shift in the field.

Prompt routing asks:

> Which model should answer this request?

Agentic routing asks:

> Given the current task state, remaining budget, prior errors, and expected downstream value, which model should handle the next step?

Those are different systems.

---

## What Cloud Providers Are Standardizing

Research tells us what is possible. Cloud products tell us what is becoming operationally normal.

Amazon Bedrock’s Intelligent Prompt Routing is a useful signal. It offers a single endpoint that predicts relative response quality across models within the same family and routes to the best quality-cost combination. It also exposes operationally important constraints:

- routers are configured over exactly two models in a family
- routing uses a response-quality-difference criterion plus a fallback model
- users are expected to monitor cost and performance continuously
- effectiveness depends on the vendor’s training distribution and may not fit specialized tasks
- at least in current docs, it is optimized for English prompts only

This is not yet full agentic routing, but it shows where the market is heading. Model routing is moving from custom orchestration code into a managed control plane concept. For agent-platform builders, that means the bar rises: users will increasingly expect routing to be configurable, inspectable, and measurable.

The limitation is equally instructive. Vendor prompt routers are usually optimized for single requests, not multi-step workflows with internal state. That gap is exactly where agent runtimes need their own routing governor.

---

## A Practical Routing Architecture for Zylos

Zylos already has the right conceptual anchor: Token Proxy sits between the runtime and model providers. The mistake would be to stop there and treat it as a metering gateway. The more defensible design is to turn Token Proxy into a **routing and budget control subsystem**.

### Layer 1: Prompt Router

This is the easiest layer and the first one most teams build.

Input:

- user prompt
- task type hint
- channel
- trust domain

Output:

- selected model
- initial budget reservation
- routing rationale

This layer handles cases like:

- short factual reply → cheap fast model
- code generation request → stronger coding model
- policy-sensitive approval draft → stronger aligned model

Useful signals here include prompt length, retrieval count, requested tool category, and known domain tags. This layer can borrow heavily from RouteLLM-style offline preference training.

### Layer 2: Step Router

This is where agent platforms differentiate themselves.

The step router should run **inside** the task loop, not only at task start. It should consider:

- current step type: planning, extraction, tool selection, summarization, verification
- context window pressure
- number of retries already used
- confidence from prior step
- remaining task budget
- observed error signals: malformed tool arguments, repeated loops, self-corrections

Example policy:

- planning and decomposition may start on a strong model
- repetitive extraction or classification can downgrade to a cheaper model
- tool-argument validation can use a cheap verifier
- final synthesis can re-upgrade if intermediate confidence is low

This is where “agentic routing” stops being theory and becomes runtime behavior.

### Layer 3: Budget Governor

Every task should carry an explicit budget ledger.

Recommended fields:

```yaml
task_budget:
  total_dollars: 0.08
  max_input_tokens: 40000
  max_output_tokens: 12000
  reserve_for_final_synthesis: 0.02
  reserve_for_human_handoff: 0.01
  hard_stop_after_retries: 2
```

The governor’s job is not only to deny overspend. It should actively reshape execution:

- lower the model tier when budget burn is ahead of plan
- compress context before the next step
- skip optional enrichment actions
- require human confirmation before another expensive branch
- abort cleanly when expected value no longer justifies spend

Without this layer, routing decisions remain locally rational but globally expensive.

---

## Routing Signals That Actually Matter

A lot of routing systems overfit on prompt text alone. For agents, that is too narrow. The best routing signals are runtime signals.

### 1. Step semantics

Not all steps are equal. A useful split is:

- **control steps**: planning, branching, delegation
- **execution steps**: extraction, transformation, drafting
- **verification steps**: self-check, policy check, tool-argument validation
- **presentation steps**: summarize, format, translate

Control steps usually deserve stronger models because mistakes propagate. Presentation steps are often the cheapest place to save money.

### 2. Recovery pressure

If the task has already retried twice, or if the previous step produced a malformed tool call, the router should upgrade rather than keep gambling on cheap inference. This is an example of path dependence. The right routing decision depends on what already happened.

### 3. Remaining budget, not just total budget

The important question is rarely “Is this task cheap or expensive?” It is “How much budget remains, and what still has to happen?” Budget should therefore be tracked as a dynamic state variable, not a static class.

### 4. Confidence and disagreement signals

Confidence can come from multiple sources:

- explicit verifier model
- self-consistency across cheap samples
- tool schema validity
- prior task success rates for similar contexts
- disagreement between small-model draft and strong-model spot checks

The key is not to trust any single confidence score as ground truth. Routing should aggregate signals.

### 5. Human correction feedback

The contextual-bandit literature is important because production systems rarely have exhaustive labels. Human corrections, overrides, and thumbs-up/down interactions are enough to improve a router over time. Agent platforms should capture these events as first-class training data.

---

## Anti-Patterns to Avoid

### Anti-pattern 1: One router decision per task

This is acceptable for short Q&A. It is weak for agents. A long task should be able to move between model tiers as the task evolves.

### Anti-pattern 2: Cost-only downgrade rules

If routing only optimizes for dollars, the system learns to fail cheaply. The objective must be a cost-success frontier, not raw spend minimization.

### Anti-pattern 3: No fallback reserve

If an agent spends the entire task budget early, it has no capacity left for final synthesis, verification, or human handoff. Reserve budgets are mandatory.

### Anti-pattern 4: Router as a black box

Operators need to know:

- which model was selected
- what alternative was considered
- how much budget remained
- why the router chose to upgrade or downgrade

If routing cannot be explained in logs and dashboards, it cannot be trusted in production.

### Anti-pattern 5: Using benchmark-only training data forever

Benchmark routing is useful for initialization, but production traffic drifts. Adaptive learning from real usage is necessary.

---

## A Concrete Zylos Roadmap

If Zylos wants Token Proxy to matter strategically, the roadmap should evolve in stages.

### Phase 1: Metering and offline routing

- unified model call logging
- per-task token accounting
- simple route policies by task type
- replay evaluation on historical traces

Deliverable:

An offline router that can answer, “What would we have spent and how would quality likely have changed if we had routed differently?”

### Phase 2: Runtime step routing

- step taxonomy in the runtime
- task budget ledger
- model switching within one task
- fallback and reserve policies

Deliverable:

A step-aware routing controller with hard budget enforcement.

### Phase 3: Online adaptation

- collect human override and correction events
- train router updates from partial feedback
- maintain per-domain routing profiles
- run safe exploration on a fraction of traffic

Deliverable:

A contextual-bandit-style adaptive router for live traffic.

### Phase 4: Trust-domain-aware routing

Different trust domains should have different routing rules. Internal engineering agents can tolerate more aggressive cost optimization than customer-facing finance or legal workflows.

Deliverable:

Routing policy as governance policy, not just performance policy.

---

## Strategic Implication

The routing problem is becoming a proxy for something larger: **who controls the economics of intelligence inside the runtime**.

If the runtime cannot decide when to spend on a strong model, when to save on a weaker model, and when to stop entirely, then the economics of the agent platform are effectively outsourced to defaults. That is not sustainable for a company trying to run large numbers of agents or mix self-hosted and external models.

In that sense, model routing belongs in the same category as memory management, permissions, and observability. It is not an optimization feature. It is a systems primitive.

The self-hosted LLM initiative makes this even more important. Once a platform operates both proprietary and self-hosted models, the router becomes the economic scheduler across the whole model fleet. It is the component that decides whether a task should use:

- a low-cost self-hosted model
- a premium external model
- a hybrid path where cheap models handle intermediate steps and strong models handle control points

That is the real future of Token Proxy: not proxying tokens, but allocating intelligence.

---

## Implementation Checklist

For teams building this now, the minimum viable checklist is:

- define task-level budgets explicitly
- classify step types inside the runtime
- log routing decisions and alternatives
- preserve reserve budget for verification and handoff
- capture human corrections as router feedback
- maintain offline replay datasets for router evaluation
- treat routing changes as production changes, with rollback and observability

If even one of these is missing, the router will usually look better in benchmarks than it behaves in production.

---

## Conclusion

The field has moved quickly from “use smaller models when possible” to “learn which model to use,” and now to “control model choice throughout an agent’s full execution trajectory under explicit budgets.” That progression mirrors the maturation of agent systems themselves.

For ordinary chat apps, prompt routing may be enough. For agent runtimes, it is only the entry point.

The durable lesson from recent work is this:

> the right unit of routing is not the prompt, but the evolving task.

Once you accept that, the architecture changes. Routing moves inside the runtime. Budget becomes a control variable. Human feedback becomes router training data. And Token Proxy becomes part of the platform’s core governor layer.

That is where serious agent infrastructure is going.

---

## References

- Chen, Zaharia, Zou. [FrugalGPT: How to Use Large Language Models While Reducing Cost and Improving Performance](https://arxiv.org/abs/2305.05176)
- Ong et al. [RouteLLM: Learning to Route LLMs with Preference Data](https://arxiv.org/abs/2406.18665)
- Panda et al. [Adaptive LLM Routing Under Budget Constraints](https://aclanthology.org/2025.findings-emnlp.1301.pdf)
- Zhang et al. [Budget-Aware Agentic Routing via Boundary-Guided Training](https://arxiv.org/abs/2602.21227)
- AWS. [Understanding intelligent prompt routing in Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-routing.html)
