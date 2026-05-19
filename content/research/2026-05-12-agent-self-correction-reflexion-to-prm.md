---
date: "2026-05-12"
title: "Agent Self-Correction: From Reflexion to Process Reward Models"
description: "How AI agents evaluate and fix their own outputs — a technical deep dive from verbal reinforcement to inference-time scaling with PRMs, including when self-correction works and when it fails."
tags: ["agents", "self-correction", "reflexion", "PRM", "inference-time scaling", "evaluation", "architecture"]
---

## Executive Summary

Self-correction — the ability of an AI agent to detect errors in its own outputs and revise them without human intervention — has evolved rapidly from a research curiosity into a first-class engineering concern. The core insight of Reflexion (NeurIPS 2023) was deceptively simple: store verbal self-critiques in memory, and let the agent retry with that context. It achieved 91% pass@1 on HumanEval, beating GPT-4's 80% baseline. But subsequent research revealed a fundamental limitation — LLMs cannot reliably correct *reasoning* errors without external signals. By 2025, the field has converged on a clearer picture: intrinsic self-correction (the model judging itself) is fragile, while grounded self-correction (anchored in execution results, structured critics, or process reward models) is where the real gains live.

This article traces the full arc: what self-correction is, why pure intrinsic approaches fail, what makes grounded approaches work, and how process reward models (PRMs) have emerged as the current frontier for inference-time self-improvement in agentic systems.

---

## What Is Agent Self-Correction?

Self-correction in an agent covers any mechanism where the agent assesses its own output and modifies subsequent behavior based on that assessment — without an external human in the loop. Three broad categories exist:

**Intrinsic self-correction**: The agent uses only its own weights and the prompt to critique and revise. No external signal beyond the model's internal priors. Example: "Critique the following response and improve it."

**Grounded self-correction**: The agent anchors its critique in observable outcomes — executing code and checking test results, querying a database to verify a claim, or running a search to confirm a fact. The correction signal comes from the environment, not model priors.

**Trained self-correction**: A separate critic model (or a reward model head on the same model) is explicitly trained to evaluate intermediate steps or final outputs, providing structured scores rather than free-form verbal critique.

The distinction matters enormously for reliability. Intrinsic approaches are cheap and generalizable but systematically biased. Grounded and trained approaches are more robust but require environment infrastructure or labeled training data.

---

## The Reflexion Architecture: Verbal Reinforcement

The foundational paper in agentic self-correction is Reflexion (Shinn et al., NeurIPS 2023). Its architecture has three components:

**Actor**: An LLM policy that generates text and actions conditioned on current observations plus a memory context.

**Evaluator**: Scores generated trajectories using task-appropriate metrics — exact-match for reasoning tasks, heuristic functions for sequential decision-making, or self-generated unit tests for code.

**Self-Reflection Module**: Takes the evaluator's signal (success/failure, score, error trace) and converts it into a detailed verbal summary — "I failed to check whether the variable was in scope before using it" — which is stored in long-term episodic memory and injected into the next trial's context.

The key insight is that sparse reward signals (pass/fail) are insufficient for correction. The self-reflection module translates these into *dense, actionable natural-language feedback*. This verbal summary acts as a form of episodic memory, allowing the agent to avoid repeating the same class of mistakes across multiple attempts.

### Benchmark Results

| Task | Metric | Baseline | Reflexion |
|------|--------|----------|-----------|
| AlfWorld (decision-making) | Success rate | ~50% | 97% (130/134 tasks) |
| HotPotQA (multi-hop QA) | EM | CoT baseline | +20% |
| HumanEval (Python coding) | pass@1 | 80% (GPT-4) | 91% |

These results are striking — particularly on AlfWorld, where the agent essentially keeps a running log of what didn't work in previous episodes and consults it before acting.

### The Memory Bottleneck

Reflexion's memory is bounded by context window size. In practice, this means retaining only the 1–3 most recent self-reflection summaries. For tasks requiring many trials or long episode histories, this is a meaningful constraint. The framework also assumes a reliable evaluator — when the evaluation signal itself is noisy or ambiguous, the verbal self-reflection compounds the error rather than correcting it.

---

## The Fundamental Limitation: Correlated Errors

A 2024 ICLR paper ("Large Language Models Cannot Self-Correct Reasoning Yet," Huang et al.) delivered an important corrective: when LLMs attempt to self-correct reasoning errors using only their own intrinsic capabilities, performance does not reliably improve — and sometimes degrades. The model that generated the wrong answer and the model asked to evaluate that answer are, in the pure intrinsic case, the same model. If the original failure was due to a systematic gap in the model's knowledge or a structural blind spot in its reasoning, the evaluator shares that exact blind spot.

A 2026 preprint from Preprints.org formalizes this with an information-theoretic argument: when generator and evaluator share correlated error modes, self-evaluation provides weak evidence of correctness. Iterative self-critique can amplify confidence without adding information — a coherence trap where the agent convinces itself with increasingly polished but still-wrong reasoning.

This doesn't mean self-correction never works intrinsically. A 2024 EMNLP paper ("Large Language Models Can Self-Correct with Key Condition Verification") showed that masking a key condition from the question, generating a response, then asking the model to predict the masked condition can surface inconsistencies the model wouldn't otherwise catch. This structured approach partially escapes the correlation problem by forcing the model to approach the same content from a different angle. But it's task-specific and doesn't generalize cleanly.

### The Practical Rule of Thumb

Self-correction without external grounding is reliable only when:
1. The error is *surface-level* (formatting, style, grammar) rather than reasoning
2. A different prompting angle genuinely creates an independent evaluation (as in key-condition masking)
3. The task has a well-defined, externally verifiable criterion (e.g., code that must pass tests)

For open-ended reasoning, knowledge-intensive tasks, or tasks where the model's training data doesn't cleanly encode correctness, intrinsic self-correction is not a reliable quality gate.

---

## Grounded Self-Correction: Anchoring in the Environment

The most effective self-correction systems use the environment as a source of ground truth. This shifts the question from "does the model think this is right?" to "does the world confirm this is right?"

### Code Execution Feedback

In software engineering agents, test execution is the gold standard evaluator. The agent generates code, executes it, and receives concrete error traces: `TypeError at line 14: unsupported operand type`. This feedback is both precise and credibly external — the interpreter has no bias toward validating the agent's output. Reflexion demonstrated this on HumanEval: the agent generates unit tests itself, executes them, and uses the failure messages as the reflection input.

A 2025 paper, "Verify Before You Fix" (arxiv 2604.10800), extends this to cross-language code analysis: agents run verification passes before applying corrections, substantially reducing cases where "fixes" introduce new bugs. Across 590 errors, agents self-correct 70.3% of the time when execution-based verification feedback is enabled.

### Tool-Use Verification

Agents with access to retrieval tools, calculators, or database queries can verify factual claims rather than trusting model recall. Self-RAG (Asai et al., 2024) formalized this with special reflection tokens: `[Retrieve]`, `[IsRel]`, `[IsSup]`, `[IsUse]`. At inference time, the model predicts whether retrieval would be useful, evaluates retrieved passages for relevance, and assesses whether the final output is grounded in those passages. This creates a structured self-evaluation loop embedded directly in the generation process.

The GSAR framework (2026) extends this to multi-agent settings with typed grounding: each agent claim is tagged with its evidence type (retrieved document, tool output, model inference), and cross-agent critiques are limited to claims in categories where the critiquing agent has verification access. This prevents hallucinated critiques from degrading grounded claims.

---

## Process Reward Models: Self-Correction at Scale

The current frontier combines self-correction with trained evaluator models that provide step-level, not just outcome-level, feedback.

### Outcome vs. Process Supervision

**Outcome Reward Models (ORMs)**: Score only the final answer. Simple to train (requires only final ground-truth labels), but provide no signal about *which step* in a multi-step chain went wrong. A 2025 paper on agentic RAG found ORMs achieved only 66.77% accuracy in multi-step search scenarios — the reward is too sparse to guide correction.

**Process Reward Models (PRMs)**: Score each intermediate step. More expensive to train (requires step-level human annotation or synthetic labels), but provide actionable diagnostic signals. In agentic contexts, PRMs can flag a flawed search query before it propagates through the rest of the reasoning chain.

### AgentPRM

AgentPRM (NeurIPS 2025, arxiv 2511.08325) is specifically designed for agentic decision-making, evaluating each action based on two signals:

- **Promise**: How close does this action bring the agent to the goal?
- **Progress**: How much improvement does this action make relative to the current state?

These two signals together avoid a common PRM failure mode — rewarding steps that look locally good but lead to dead ends. AgentPRM is reported to be over 8× more compute-efficient than baselines while showing robust improvement when test-time compute is scaled up.

### Inference-Time Scaling with PRMs

The deep connection between PRMs and self-correction is test-time compute scaling. Instead of committing to a single generated answer, the system samples multiple candidate continuations at each step, scores them with a PRM, and follows the highest-scoring path. This is a form of self-correction without explicit critique: trajectories that accumulate low process rewards are pruned, and the agent effectively backtracks to explore better branches.

R-PRM (EMNLP 2025) adds a self-evolving loop: the PRM itself improves through preference optimization over its own predictions, without additional human annotation. The three-phase pipeline — supervised cold-start, meta-optimization, inference-time scaling — allows the evaluator to sharpen its own calibration over time.

ThinkPRM and GenPRM (2025) take this further by giving the reward model itself a chain-of-thought reasoning pass before scoring, producing more stable and interpretable evaluations. ThinkPRM uses an internal "thinking" loop to simulate generative reflection before assigning a score.

---

## Implementation Patterns for Production Agents

### The Critic-in-the-Loop Pattern

In LangGraph (the current consensus framework for production agentic AI), self-correction is modeled as a conditional cycle: the agent node outputs a result, a critic node evaluates it, and a router node either accepts the result or sends it back to the agent with the critique. The cycle has a configurable maximum retry count to prevent infinite loops.

```
agent → critic → [accept | revise → agent]
```

The critic can be implemented at multiple fidelity levels:
- **Light**: Simple heuristic checks (schema validation, length bounds, keyword presence)
- **Medium**: LLM-as-judge with a structured rubric
- **Heavy**: Execution-grounded verification (run the code, query the database)
- **Trained**: A dedicated PRM or critic model with learned calibration

Choosing the right fidelity level is a cost-latency-reliability trade-off. Light critics add milliseconds; heavy critics can add seconds per cycle.

### Multi-Agent Reflexion

When a single agent reflects on its own failures, it risks local optima — the same blind spot that caused the failure evaluates the failure. Multi-Agent Reflexion (MAE, 2025) addresses this with three co-evolving agents instantiated from the same base model but operating in different roles:

- **Proposer**: Generates questions or tasks to test the system
- **Solver**: Attempts solutions
- **Judge**: Evaluates the solver's outputs

Because each role uses different prompts and operates over different content, their error modes are partially decorrelated. MAE consistently outperforms single-agent Reflexion on HotPotQA and HumanEval-Python.

### Self-Correction Budget

A practical concern in production: how many correction cycles are acceptable before falling back to human escalation or returning a low-confidence response? The right answer depends on task criticality and latency constraints, but a common pattern is:

1. Attempt 1: Generate with standard prompt
2. Attempt 2: Add targeted critique ("The previous response lacked X; please include it")
3. Attempt 3: Switch to a more capable model or a different generation strategy
4. Escalate: Flag for human review

Logging every correction attempt with the critique used and final outcome creates a dataset that can improve both the base agent and the critic over time.

---

## Trade-offs and When to Use Each Approach

| Approach | Reliability | Cost | Latency | When to Use |
|----------|-------------|------|---------|-------------|
| Intrinsic self-critique | Low–Medium | Minimal | Low | Surface-level formatting/style issues |
| Key-condition masking | Medium | Low | Low | Structured reasoning tasks with verifiable conditions |
| Execution-grounded | High | Medium | Medium | Code generation, data analysis, tool-use tasks |
| LLM-as-judge critic | Medium | Medium | Medium | Open-ended generation with rubric-defined quality |
| Process Reward Model | High | High (training) | Medium | Long-horizon tasks, inference-time compute scaling |
| Multi-agent reflexion | High | High | High | Tasks where single-agent bias is a known risk |

---

## Key Takeaways

- **Intrinsic self-correction is unreliable for reasoning**: The model that made the mistake evaluates the mistake with the same blind spots. Don't rely on it as a quality gate for knowledge-intensive or multi-step reasoning tasks.
- **Grounding is the differentiator**: Execution feedback, database queries, and retrieval verification make self-correction dramatically more reliable by introducing an external truth signal.
- **Process reward models generalize Reflexion**: PRMs provide step-level feedback that scales to long-horizon tasks and enables inference-time compute scaling — backing off bad partial trajectories before they fully play out.
- **Diverse evaluators partially solve correlation**: Multi-agent setups with distinct roles decorrelate error modes, catching failures that a single evaluator would miss.
- **Production requires a correction budget**: Unbounded retry loops are an availability risk. Design correction cycles with maximum attempts and a human escalation path.

---

## References

- Shinn, N. et al. (2023). [Reflexion: Language Agents with Verbal Reinforcement Learning](https://arxiv.org/abs/2303.11366). NeurIPS 2023.
- Huang, J. et al. (2024). [Large Language Models Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798). ICLR 2024.
- Asai, A. et al. (2024). Self-RAG: Learning to Retrieve, Generate, and Critique Through Self-Reflection. [Analytics Vidhya overview](https://www.analyticsvidhya.com/blog/2025/01/self-rag/).
- AgentPRM (2025). [Process Reward Models for LLM Agents via Step-Wise Promise and Progress](https://arxiv.org/abs/2511.08325). NeurIPS 2025 / ACM Web Conference 2026.
- R-PRM (2025). [Reasoning-Driven Process Reward Modeling](https://aclanthology.org/2025.emnlp-main.679/). EMNLP 2025.
- [Process vs. Outcome Reward: Which is Better for Agentic RAG Reinforcement Learning](https://arxiv.org/html/2505.14069v1). 2025.
- [A Survey of Process Reward Models](https://arxiv.org/html/2510.08049v3). 2025.
- [When Can LLMs Actually Correct Their Own Mistakes? A Critical Survey](https://direct.mit.edu/tacl/article/doi/10.1162/tacl_a_00713/125177/). TACL 2024.
- [Verify Before You Fix: Agentic Execution Grounding](https://arxiv.org/html/2604.10800v1). 2026.
- [GSAR: Typed Grounding for Hallucination Detection in Multi-Agent LLMs](https://arxiv.org/html/2604.23366). 2026.
- [Agentic AI Frameworks 2026: LangGraph vs CrewAI vs OpenAI SDK](https://uvik.net/blog/agentic-ai-frameworks/). Uvik, 2026.
