---
date: "2026-03-20"
title: "Adaptive Replanning in AI Agents: Strategies for Mid-Execution Plan Revision"
description: "How AI agents detect unexpected states and dynamically revise plans mid-execution without restarting from scratch"
tags: ["agent-planning", "replanning", "resilience", "multi-agent", "llm-agents"]
---

## Executive Summary

Static planning — where an agent formulates a full plan upfront and executes it linearly — breaks down in real-world environments where tool failures, unexpected state changes, and ambiguous outcomes are routine. The 2025-2026 research landscape has converged on a clear answer: agents need adaptive replanning, the ability to detect mid-execution deviations and revise only the affected portions of a plan without discarding work already completed.

This shift from reactive to proactive replanning is reflected in a growing body of papers that treat plan execution as a transaction graph rather than a linear script. Frameworks like ALAS, SagaLLM, and Plan-and-Act each take different approaches — stateful disruption recovery, saga-pattern compensation, and per-step Planner-Executor separation — but share the same core insight: plans must be treated as living artifacts, continuously validated against observed state and revised scoped to the point of failure.

For the Zylos agent project, these patterns have direct applicability. Long-running autonomous tasks already face the risk of silent failure midway through execution. Adopting structured replanning triggers, checkpoint-based state persistence, and scoped plan repair rather than full restart would materially improve reliability of multi-step scheduled tasks.

## The Problem: Why Static Plans Fail

The ReAct (Reason-Act) loop, dominant in production agents through 2024, interleaves reasoning and action at each step. While flexible, it has a structural weakness: a failure in one step propagates directly to the next, and the agent has no model of its overall progress relative to a goal. A single bad tool call can derail an 8-step plan at step 7.

Plan-then-Execute (P-t-E) architectures separate strategic planning from tactical execution — the Planner generates a structured step list, the Executor works through each step — but early implementations suffered from a different problem: the plan was generated once and treated as immutable. When the environment changed between plan generation and step execution, the Executor would attempt steps whose preconditions had already been invalidated.

Research from 2025 identifies four recurring failure modes that static plans cannot handle:

1. **Tool failure**: A required tool is unavailable or returns an error
2. **State drift**: The environment changes between plan generation and step execution
3. **Dependency violation**: A later step's precondition is invalidated by an earlier step's actual (vs. expected) outcome
4. **Context erosion**: In long multi-agent pipelines, accumulated outputs overflow context windows, causing the model to lose track of the overall plan state

## Core Replanning Strategies

### 1. Per-Step Dynamic Replanning (Plan-and-Act, UC Berkeley)

The Plan-and-Act framework (arXiv:2503.09572, ICML 2025) introduces the most straightforward form of adaptive replanning: after each Executor action, the Planner regenerates the remaining plan based on current observed state rather than stale initial assumptions.

Architecture: separate fine-tuned LLaMA-3.3-70B instances for Planner and Executor. After each Executor step, the Planner receives the current state, the complete action history, and the previous plan, and outputs a revised plan for remaining steps.

Results on WebArena-Lite: 57.58% success rate, with dynamic replanning accounting for a +34 percentage point improvement over baseline ReAct. The key finding is that plans generated at the start of a task are frequently wrong by step 3 or 4 — the world has changed, or the agent's model of it was incorrect.

Cost trade-off: per-step Planner invocations add latency and token cost. The paper recommends triggering the Planner only when the Executor detects a state mismatch or an action produces an unexpected result, rather than on every step.

### 2. Disruption-Aware Local Compensation (ALAS)

ALAS (arXiv:2505.12501, 2511.03094) addresses a specific failure in multi-agent pipelines: a disruption in one agent's domain should not force global replanning across all agents.

Core mechanism: each agent maintains a persistent state log. When a disruption occurs, the affected agent applies **history-aware local compensation** — it consults its own action history to identify compensating operations that restore consistency, without escalating to the Planner. Only when local compensation fails does the disruption propagate upward.

This "local-first" escalation model mirrors how distributed transaction systems handle failures: compensate locally, escalate only when compensation is impossible. On large-scale job-shop scheduling benchmarks, ALAS outperformed prior approaches in dynamic reactive scenarios, precisely because it avoided the cost and instability of full replanning for every disruption.

Four deficits ALAS targets: (i) absence of self-verification, (ii) context erosion across long pipelines, (iii) next-token myopia (greedy step selection without plan-level awareness), (iv) lack of persistent state for recovery.

### 3. Transactional Saga Compensation (SagaLLM)

SagaLLM (arXiv:2503.11951, VLDB 2025) applies the Saga transaction pattern from distributed systems to multi-agent LLM planning. Each step in a plan is a compensable transaction: if it fails, a compensation operation is defined that can undo or mitigate its effects.

When a step fails, SagaLLM:
1. Identifies the failure type through an independent validation agent
2. Executes compensations for affected steps in reverse order using the dependency graph
3. Automatically replans the affected portion using preserved context and constraints
4. Falls back to human re-evaluation only if automatic replanning fails

The dependency graph is key: SagaLLM models inter-step dependencies, so it knows exactly which downstream steps are invalidated by a given failure and can limit replanning scope to that subtree rather than the whole plan.

This produces ACID-like guarantees for agent workflows: even when individual steps fail, the overall system reaches a consistent state (either completed or cleanly compensated).

### 4. Hierarchical Supervision (Reason-Plan-ReAct / RP-ReAct)

RP-ReAct (arXiv:2512.03560) targets a different failure mode: context window overflow in enterprise tasks with large tool outputs. It introduces a three-layer hierarchy — Reasoner, Planner, Executor — where the Reasoner (a large reasoning model) continuously supervises the Planner's step selection and the Executor's tool interactions.

When the Executor encounters a tool output that exceeds context capacity, it offloads to external storage rather than forcing it into the context window. The Planner then pulls only the relevant excerpts when formulating the next step.

Replanning is triggered at the Reasoner level when the Planner detects that its current step sub-sequence is no longer consistent with the task goal, given the Executor's actual outcomes. This multi-level separation means replanning happens at the right granularity: tactical adjustments stay at the Planner level; strategic course corrections escalate to the Reasoner.

### 5. Proactive Replanning via Precondition Monitoring

A 2025 paper on embodied agents (arXiv:2508.11286) introduces the concept of **proactive replanning**: rather than waiting for a step to fail, the agent continuously monitors whether preconditions for upcoming steps are still satisfied.

Using scene graph comparison in robotic settings, the agent compares the current observed environment state against what the plan expects the environment to look like at each decision boundary. When a mismatch is detected — even before the affected step is attempted — a lightweight reasoning module diagnoses the discrepancy and adjusts the plan.

This translates to software agent contexts as: continuously validate tool availability and external state against plan preconditions, and trigger scoped replanning before a step is attempted, not after it fails. The cost is more frequent validation calls; the benefit is avoidance of downstream cascade failures.

## Replanning Trigger Taxonomy

Research from 2025 identifies four distinct trigger classes:

| Trigger | Description | Replanning Scope |
|---|---|---|
| **Tool failure** | A tool returns an error or is unavailable | Single step + dependents |
| **Precondition violation** | Upcoming step's precondition not met | Subtree from violation point |
| **State drift** | Environment has diverged from plan's model | All affected steps |
| **Context overflow** | Agent loses track of plan due to long context | Full plan re-summary + continuation |

Cost-Bench (arXiv:2511.02734) evaluates agents specifically on their ability to generate and adapt cost-optimal plans under dynamic blocking events (tool failures, cost changes). Current LLMs score significantly below optimal, confirming that replanning under constraints is an open problem.

## Scoped vs. Full Replanning

A central tension in the field is the cost of replanning. Full replanning — generating an entirely new plan from scratch — is expensive (a full Planner invocation), may discard valid prior work, and introduces instability in the portions of the plan that were correct.

The consensus in 2025-2026 research is to prefer **scoped replanning**: identify exactly which steps are invalidated by the current failure (using the dependency graph), and replan only those steps while preserving the rest.

Scoped replanning trade-offs:
- Cheaper per replanning event than full restart
- Requires maintaining a dependency graph of the plan (structural overhead)
- May miss systemic issues where the overall goal has become unreachable — requiring a fallback to full replanning or human escalation

MACI (arXiv:2501.16689) operationalizes this via a meta-planner that generates a dependency graph at plan-creation time, which a runtime monitor then uses to scope replanning when needed.

## Implementation Patterns for Practice

Synthesizing the 2025-2026 research, several concrete patterns emerge for production agent systems:

**Checkpoint-based state persistence**: Save plan state (completed steps, observed outcomes, remaining steps) at each step boundary. When a failure occurs, resume from the last checkpoint rather than restarting. This is table stakes for any agent handling multi-minute tasks.

**Dependency-tagged plans**: When the Planner generates a step list, have it also generate a dependency graph: which steps depend on which prior steps' outputs. Use this graph to scope replanning to only the affected subtree.

**Tiered escalation**: Local fallback (retry with alternative parameters) → Scoped replanning (affected subtree only) → Full replanning (new plan from current state) → Human escalation. Each tier is triggered only when the previous tier fails.

**Validator separation**: Use an independent model (or rule-based checker) to validate step outputs against expected postconditions, separate from the Executor. This mirrors the SagaLLM pattern and prevents the Executor from "convincing itself" that a failed step succeeded.

**Scoped replanning prompts**: When issuing a replanning call, provide the Planner with: completed steps and their actual outcomes, the failed step and observed error, the remaining plan, and the overall goal. Explicitly instruct the Planner to preserve completed steps and revise only the remaining portion.

## Relevance to Zylos

Zylos's scheduler enables long-running autonomous tasks that may span dozens of tool calls over extended time periods. Several current failure modes map directly to the research above:

- Scheduled tasks that fail midway leave no checkpoint for recovery — a full restart is required
- Tool errors (HTTP failures, API rate limits) currently surface as task failure rather than triggering local retry or scoped replanning
- Multi-step Claude Code sessions have no structured plan representation, making it difficult to determine which subsequent steps are invalidated by a mid-session failure

Near-term improvements: add structured plan output to multi-step task prompts (enabling dependency scoping), implement step-level checkpointing in the scheduler, and define a tiered error escalation policy (retry → scoped replan → user notification).

## References

1. Plan-and-Act: Improving Planning of Agents for Long-Horizon Tasks (arXiv:2503.09572, ICML 2025) - https://arxiv.org/abs/2503.09572
2. ALAS: A Stateful Multi-LLM Agent Framework for Disruption-Aware Planning (arXiv:2505.12501) - https://arxiv.org/abs/2505.12501
3. ALAS: Transactional and Dynamic Multi-Agent LLM Planning (arXiv:2511.03094) - https://arxiv.org/abs/2511.03094
4. SagaLLM: Context Management, Validation, and Transaction Guarantees for Multi-Agent LLM Planning (arXiv:2503.11951, VLDB 2025) - https://arxiv.org/abs/2503.11951
5. Reason-Plan-ReAct: A Reasoner-Planner Supervising a ReAct Executor for Complex Enterprise Tasks (arXiv:2512.03560) - https://arxiv.org/abs/2512.03560
6. Scene Graph-Guided Proactive Replanning for Failure-Resilient Embodied Agent (arXiv:2508.11286) - https://arxiv.org/abs/2508.11286
7. MACI: Multi-Agent Collaborative Intelligence for Adaptive Reasoning and Temporal Planning (arXiv:2501.16689) - https://arxiv.org/abs/2501.16689
8. CostBench: Evaluating Multi-Turn Cost-Optimal Planning and Adaptation in Dynamic Environments for LLM Tool-Use Agents (arXiv:2511.02734) - https://arxiv.org/abs/2511.02734
9. Architecting Resilient LLM Agents: A Guide to Secure Plan-then-Execute Implementations (arXiv:2509.08646) - https://arxiv.org/abs/2509.08646
10. AI Agents Planning in 2026: The Complete Blueprint for Autonomous Enterprise AI - https://gleecus.com/blogs/ai-agents-planning-2026/
11. Plan-Then-Execute: An Empirical Study of User Trust and Team Performance (CHI 2025) - https://dl.acm.org/doi/10.1145/3706598.3713218
