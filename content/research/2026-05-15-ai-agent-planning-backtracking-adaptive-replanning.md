---
date: "2026-05-15"
title: "AI Agent Planning, Backtracking, and Adaptive Replanning"
description: "How modern AI agents handle plan revision, dead-ends, and recovery in complex multi-step tasks — from tree search algorithms to production-ready replanning patterns."
tags:
  - agents
  - planning
  - tree-search
  - replanning
  - reliability
  - MCTS
  - inference-time-scaling
---

## Executive Summary

The dominant failure mode of deployed AI agents is not hallucination or missing capability — it is brittle planning. Agents that commit to a linear action sequence and cannot revise it when reality diverges from expectation account for the majority of production failures. Research and engineering practice in 2025-2026 have converged on a common insight: robust agents must internalize the ability to backtrack, explore alternative paths, and replan dynamically. This article surveys the state of the field across three layers — search-based planning algorithms, architectural replanning patterns, and production-level failure recovery — and draws lessons for agent platforms like Zylos.

## The Fundamental Problem: Linear Plans in a Nonlinear World

Traditional LLM agents operate as ReAct loops: observe, reason, act, repeat. This works for tasks that are essentially linear and tolerant of dead-ends. For any task that requires navigating a state space — fixing a real bug in a large codebase, booking a complex multi-leg trip, orchestrating a multi-step data pipeline — linear execution breaks down quickly.

A process-centric analysis of agentic software systems on SWE-bench (published late 2025) found that unsuccessful agent runs are "full of inefficiencies, with graphs of unresolved issues consistently larger than resolved ones, showing more repetitions and inefficient patterns." The study showed agents entering loops where they patch the same file repeatedly with slight variations, never testing whether the patch actually worked, and never considering that the root cause might be elsewhere.

The core failure modes are:

- **Commitment bias**: Once an agent starts down a path, it continues even when early signals indicate the path is wrong.
- **Context drift**: The plan was generated against initial observations; as execution produces new information, the plan becomes stale but is never updated.
- **Lack of exploration**: A greedy agent always takes the locally best action and misses globally better solutions that require a temporary cost.
- **Replanning loops**: Naive replanning without step caps or convergence checks causes agents to add steps indefinitely without meaningful progress.

## Research Thread 1: Tree Search for Agent Planning

### Language Agent Tree Search (LATS)

The LATS framework (published at ICML 2024, widely cited into 2025-2026) was the first unified treatment of reasoning, acting, and planning as a tree search problem. LATS adapts Monte Carlo Tree Search (MCTS) to language agents, using the LLM as both a generator (to propose next actions) and an evaluator (to score nodes via self-reflection).

The key insight is that MCTS allows a principled balance between **exploration** (trying new branches) and **exploitation** (deepening promising branches). Backtracking becomes natural: the search algorithm can abandon a subtree and pursue a sibling branch without any special-case logic. The LLM's self-reflection mechanism generates critiques of failed trajectories and adds them as context for subsequent search iterations — turning failures into training signal at inference time.

LATS achieves 94.4% on HumanEval (GPT-4) and demonstrates significant improvements on WebShop web browsing tasks, showing that structured backtracking beats greedy approaches even when the cost per node (one LLM call) is higher.

### SWE-Search: Tree Search for Software Engineering

SWE-Search (ICLR 2025) applies MCTS specifically to repository-level software engineering tasks. It addresses the central limitation of prior software agents: "current LLM-based software agents often follow linear, sequential processes that prevent backtracking and exploration of alternative solutions."

The framework uses three specialized agents:
- **SWE-Agent**: performs adaptive exploration over the codebase, generating candidate actions
- **Value Agent**: scores each candidate state using a hybrid function combining quantitative numerical evaluation and qualitative natural language assessment
- **Discriminator Agent**: facilitates multi-agent debate to select the best branch for deeper exploration

The critical design innovation is the hybrid value function. Pure numerical scoring (did the tests pass?) is too coarse — partial progress matters. Pure qualitative scoring is unreliable. The combination allows the agent to recognize when it has moved closer to a solution even before achieving it, enabling more efficient search and earlier backtracking from truly hopeless branches.

Result: 23% relative improvement across five models on SWE-bench compared to standard open-source agents without MCTS.

### Tree-GRPO: Combining Tree Search with Reinforcement Learning

The most recent research (Tree-GRPO, ICLR 2026 Workshop) extends tree search beyond inference-time planning into the training loop. Tree-based Group Relative Policy Optimization (Tree-GRPO) uses tree search during RL training to generate more efficient rollouts.

Standard GRPO generates independent chain rollouts for each training step. Tree-GRPO instead samples rollouts as a tree, where each node is a complete agent interaction step. By sharing common prefixes between branches, Tree-GRPO achieves the same number of effective rollouts as chain-based GRPO while consuming only **one quarter of the token budget**.

The tree structure also enables a key capability: natural process supervision. Because the tree explicitly represents divergence points (the same prefix leads to two different action choices), it generates step-level preference data automatically from outcome rewards alone, without requiring human annotation of intermediate steps. This makes process reward models tractable to train from simple outcome labels.

Experiments across 11 datasets and 3 QA task types show Tree-GRPO outperforms chain-based RL methods at equivalent or lower cost.

### Adaptive Branching MCTS (AB-MCTS)

AB-MCTS generalizes the choice between "wider" search (more candidate responses at a given depth) and "deeper" search (extending a promising partial trajectory). Classical MCTS applies a fixed exploration/exploitation formula; AB-MCTS makes this adaptive based on external feedback signals from the environment.

In agent settings, this means: if test execution returns a meaningful error message, go deeper (the current branch has information content). If execution returns a generic failure, go wider (the current approach is probably wrong). The feedback signal guides where to spend the next unit of compute, making search substantially more efficient than fixed-strategy alternatives.

## Research Thread 2: Architectural Replanning Patterns

### Plan-and-Execute with Replanning Trigger

The plan-and-execute pattern separates two phases: an **upfront planning** phase where the LLM generates a complete plan, and an **execution phase** where steps are carried out sequentially. Replanning is triggered only on failure, not after every step.

The replanning node receives:
1. The original goal
2. All completed steps and their outputs so far
3. The specific failure details of the triggering step

It then produces a revised plan for remaining steps, discarding steps that are now known to be unnecessary or incorrect. This is significantly cheaper than full replanning at every step, while preserving adaptivity.

Key production safeguards:
- **Step caps**: never allow more than N total steps (typically 25-30); surface partial results to a human if the cap is hit
- **Replanning thresholds**: trigger replanning after K consecutive step failures, not on every single failure (transient errors should be retried first)
- **Plan versioning**: maintain a log of plan versions to enable rollback if a replanning decision makes things worse
- **Contradiction detection**: detect when a step's output contradicts an assumption in the remaining plan, and trigger replanning proactively rather than waiting for failure

### KAIJU Executive Kernel

KAIJU (published April 2026) represents a more sophisticated approach: intent-gated execution with real-time plan grafting. Tools execute in parallel "waves"; a reflection mechanism fires between waves while other branches may still be pending. A micro-planner can graft new nodes onto the live execution graph without stopping execution.

This is structurally equivalent to dynamic DAG construction during execution: the plan is not a static sequence but a growing graph that the agent expands as it learns. Observers (running in orchestrator mode) evaluate individual results as they arrive and inject follow-up nodes immediately, without waiting for the whole wave to complete.

This approach collapses the distinction between planning and execution: the agent is always doing both simultaneously, with plan revisions responding to observations at sub-step granularity.

### RAC: Robust Agent Compensation

Robust Agent Compensation (RAC, published May 2026) takes a fundamentally different approach. Rather than improving the agent's ability to plan its way out of failures, RAC ensures that failures never leave the system in an inconsistent state.

RAC is a log-based recovery paradigm implemented as an architectural extension compatible with most existing agent frameworks (including LangGraph). It supports three recovery strategies:
- **Retry**: re-execute the failed step with the same inputs
- **Alternative**: substitute a different tool or approach for the failed step
- **Compensation**: undo the side effects of steps that already executed before the failure, then retry from a clean state

The compensation mechanism is the novel contribution. Without it, a failed halfway-complete agent workflow can leave databases modified, emails sent, and files changed in ways that make the task harder to restart than if nothing had been done. RAC's logging tracks every state-changing tool call, enabling rollback with explicit undo operations.

Compared to LLM-based recovery approaches (where the agent itself reasons about how to recover), RAC achieves 1.5-8x better latency and token economy. This is because recovery decisions are deterministic: no LLM call needed to decide whether to retry or compensate.

## Research Thread 3: Evaluation and Production Reliability

### REALM-Bench

REALM-Bench was designed specifically to test agent reliability under unexpected events: equipment failures, resource shortages, timing conflicts, and environmental changes that require dynamic replanning. This represents a departure from static task benchmarks (SWE-bench, HumanEval) toward **adversarial reliability evaluation**.

Key insight: most agent benchmarks evaluate performance on the happy path. REALM-Bench systematically injects disruptions and measures whether the agent can replan successfully. Agents that perform well on static benchmarks show significant degradation under adversarial conditions, revealing that their "planning" is often pattern-matching against training distribution rather than genuine adaptive reasoning.

### SWE-Bench Pro: Long-Horizon Tasks

SWE-Bench Pro (2025) extends the benchmark to multi-day software engineering tasks that require sustained planning across many sessions, file changes, and code review cycles. Standard agents that perform well on individual issue resolution fail significantly on these long-horizon tasks because their plans assume a fixed environment that changes between steps (other engineers merge PRs, CI configurations change, dependencies update).

The benchmark reveals a new failure mode: **temporal plan invalidation**, where a valid plan becomes invalid not because the agent made a mistake, but because the environment changed. This motivates replanning systems that can detect external changes, not just internal failures.

### Towards a Science of Agent Reliability

A February 2026 arxiv paper proposes a formal framework for agent reliability with three dimensions:
- **Correctness**: does the agent produce the right output on the happy path?
- **Robustness**: does performance degrade gracefully under distribution shift and adversarial inputs?
- **Recoverability**: when the agent fails, can it return to a working state with minimal human intervention?

Current industry focus is overwhelmingly on correctness. The paper argues that robustness and recoverability are the bottlenecks to production deployment: a 95%-correct agent that fails catastrophically and requires manual cleanup on 5% of runs is often less valuable than an 85%-correct agent that degrades gracefully.

## Inference-Time Compute Scaling and Search

A cross-cutting theme in 2025-2026 research is the relationship between planning quality and inference-time compute. Key findings:

**Search consistently outperforms sampling at scale.** For complex tasks, spending the same token budget on tree search (exploring multiple branches) outperforms spending it on a single deeper chain. The intuition: LLMs have high variance on hard tasks. Multiple trajectories with backtracking catches variance; a single trajectory amplifies it.

**Beam search is suboptimal for reasoning.** Despite its name, beam search was designed for sequence generation, not agent planning. On complex reasoning and agent tasks, Adaptive Variable Granularity Search (VG-Search) achieves accuracy gains of up to 3.1% over beam search while reducing FLOPs by over 52%. The key: adaptive granularity means the algorithm can apply fine-grained search where it matters and coarse search elsewhere.

**Process rewards enable better search.** Value functions that score intermediate states (not just final outcomes) allow the search algorithm to prune dead ends early rather than executing them to completion. Tree-GRPO's finding that tree-structured rollouts generate process supervision signal for free is significant: it makes process reward models practical to train.

**The 4x inference budget rule.** Across multiple benchmarks, spending 4x the baseline inference compute on search-based planning typically yields performance comparable to using the next-generation model (e.g., moving from GPT-4 to GPT-4o-level performance). For agents operating in high-value domains, this is often cost-effective.

## Production Engineering Patterns

### When to Replan vs. Retry

A practical decision tree for production agent systems:

1. **Transient error** (network timeout, rate limit, temporary unavailability): **retry** with exponential backoff, no replanning needed
2. **Deterministic error with clear alternative** (tool returns "not found", file doesn't exist): **local adaptation** — substitute the specific step, no full replan needed
3. **Contradicting observation** (step succeeded but result invalidates plan assumptions): **trigger replanning** with full context
4. **K consecutive failures on the same step**: **escalate** to human or abort with clean compensation
5. **External environment change detected**: **trigger replanning** with fresh environment state

### State Isolation and Compensation

The most underappreciated production challenge is side-effect management. When an agent writes to a database, sends an API call, or creates a file, backtracking cannot undo those effects. Three strategies:

- **Write-ahead logging**: record all state changes before executing them, enabling rollback (RAC's approach)
- **Optimistic execution with checkpoints**: take snapshots at plan boundaries; rollback to the nearest checkpoint on failure
- **Deferred commit**: stage all changes locally and commit only when the entire plan succeeds (viable for database transactions; not viable for external APIs)

For agents interacting with external APIs (email, payment systems), compensation is the only option: issue an explicit undo operation (cancel the email, refund the payment). This requires every tool call to be paired with a compensation tool call, which is a significant implementation burden but the correct long-term architecture.

### Replanning Loop Prevention

The most common failure mode in replanning systems is infinite loops: the agent replans, executes the new plan, hits a different failure, replans again, indefinitely. Prevention requires:

1. **Hard step cap**: abort after N total steps regardless of state (surface results to human)
2. **Replan budget**: limit the number of replan events per task
3. **Progress detection**: measure whether the agent is converging (files modified, tests passing) or cycling; abort if no measurable progress after M steps
4. **Semantic deduplication**: detect when a new plan is semantically equivalent to a previous plan that already failed; refuse to execute it again

## Implications for Zylos

Several patterns from this research are directly relevant to the Zylos agent platform:

**Replanning in long-running tasks.** Zylos already handles long-horizon work via the scheduler. Tasks that span multiple sessions need a replanning mechanism that detects when external state has changed since the task was last checkpointed. The equivalent of REALM-Bench's adversarial conditions occurs naturally in Zylos's real environment (files change, APIs evolve, credentials rotate).

**RAC-style compensation for tool calls.** When a task fails halfway through, Zylos currently has no automatic mechanism to undo completed steps. Implementing a lightweight compensation log — even just recording which tool calls were made with what arguments — would enable clean recovery and reduce the need for manual cleanup.

**Step caps and escalation.** The current Zylos scheduler marks tasks done or failed, but does not distinguish between "failed and cannot recover" vs. "making no progress and needs human input." Adding a "stuck" state with automated escalation to Howard via Telegram would implement the production pattern of surfacing partial results when the step cap is hit.

**Inference-time search for high-value tasks.** For tasks where quality matters more than cost (writing research articles, complex code changes), spending more inference compute on search-based planning is cost-effective. The 4x compute / next-model-generation equivalence is a useful heuristic for budgeting.

## Key Takeaways

1. **Backtracking is not an edge case** — it is the norm for complex tasks. Agents without explicit backtracking mechanisms will fail on any task with meaningful branching.

2. **Tree search at inference time is practical.** SWE-Search's 23% improvement on SWE-bench demonstrates that MCTS is not just a theoretical construct; it works at the token budgets available today.

3. **Process rewards make search cheaper.** Tree-structured rollouts generate step-level supervision signal automatically, making value functions practical to train without human annotation.

4. **Replanning needs guardrails.** Naive replanning without step caps and progress detection creates replanning loops that are worse than no replanning at all.

5. **Compensation is necessary for external side effects.** Backtracking inside the agent context does not undo API calls. Production agents need explicit compensation mechanisms for every state-changing tool.

6. **Robustness and recoverability are underinvested.** Industry evaluation focuses on correctness; the production bottlenecks are robustness (graceful degradation) and recoverability (clean failure modes). Measuring and improving these is the highest-leverage area for deployed agent systems in 2026.
