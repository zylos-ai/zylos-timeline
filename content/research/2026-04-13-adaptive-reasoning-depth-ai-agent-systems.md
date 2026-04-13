---
date: "2026-04-13"
title: "Adaptive Reasoning Depth in AI Agent Systems: When to Think Hard vs Think Fast"
description: "How production AI agents are learning to dynamically allocate reasoning compute — spending deep thinking tokens on hard steps and fast intuition on easy ones — cutting costs by 50-80% without sacrificing accuracy."
tags:
  - research
  - ai-agents
  - reasoning-models
  - test-time-compute
  - cost-optimization
  - adaptive-reasoning
  - inference-scaling
  - agent-architecture
---

## Executive Summary

The dominant pattern in AI agent systems today — route every step through the same reasoning model at the same depth — is as wasteful as hiring a PhD mathematician to calculate restaurant tips. A software engineering agent debugging a null pointer exception does not need the same cognitive depth as one designing a distributed consensus protocol. Yet most production agents apply uniform reasoning intensity to every step, burning tokens and latency on trivial operations while sometimes under-investing on genuinely hard ones.

A convergence of research from late 2025 through Q1 2026 is dismantling this rigidity. Frameworks like CogRouter (February 2026) and ARES (March 2026) demonstrate that agents trained to dynamically adapt reasoning depth per step achieve state-of-the-art task performance while using 50-62% fewer tokens. Provider APIs now expose explicit reasoning effort controls — Anthropic's adaptive thinking with effort levels, OpenAI's `reasoning.effort` parameter for o3/o4-mini, Google's thinking budget for Gemini Flash — giving production teams the levers to implement adaptive reasoning without model-level changes. And the theoretical foundations, formalized in the "Reasoning on a Budget" survey and UC Berkeley's compute-optimal scaling work, show that adaptive allocation can deliver 4x better efficiency than fixed-budget approaches.

For agent-first organizations, this is not an academic curiosity. Reasoning tokens are the most expensive tokens in the stack — billed at output token rates, often 4-8x the cost of input tokens, and consumed invisibly inside thinking blocks that users never see. A production agent that learns when to think hard and when to think fast can cut its inference bill by 50-80% while maintaining or improving task success rates. This article maps the research landscape, the production tooling, and the architectural patterns for building agents that reason adaptively.

## The Cost of Uniform Reasoning

### Why Agents Over-Think

Modern reasoning models — OpenAI's o3/o4-mini, Claude with extended thinking, Gemini with Deep Think — achieve their performance gains by generating internal chains of thought before producing a final answer. This "thinking" phase consumes tokens that are billed at output token rates. The cost structure creates a paradox: the feature that makes these models powerful is also what makes them expensive.

Consider a typical agentic coding workflow. The agent reads an error log (easy — pattern match), identifies the failing test (easy — string search), locates the relevant source file (medium — codebase navigation), diagnoses the root cause (hard — reasoning about data flow), writes a fix (hard — code generation with constraints), and verifies the fix passes tests (easy — command execution). Of these six steps, only two genuinely benefit from deep reasoning. Yet a uniformly-configured reasoning model will generate 2,000-10,000 thinking tokens per step regardless of difficulty.

The arithmetic is brutal. At Claude Opus 4.6 output pricing ($60/M tokens), 10,000 reasoning tokens per step across a 15-step agent loop costs $9 in thinking tokens alone — before counting the actual output. If only 4 of those 15 steps truly needed deep reasoning, the agent wasted roughly $5 on unnecessary thinking. Scale this across thousands of daily agent runs and the waste becomes a line item in the P&L.

### The Three-Token Economy

Production agents in 2026 operate in a three-tier token economy:

| Token Type | Typical Cost (Frontier) | Typical Cost (Efficient) | Visibility |
|-----------|------------------------|-------------------------|------------|
| Input tokens | $3-15/M | $0.10-0.25/M | Visible in prompt |
| Output tokens | $15-60/M | $0.40-1.50/M | Visible in response |
| Reasoning tokens | $15-60/M | $0.40-1.50/M | Hidden in thinking block |

Reasoning tokens are the silent cost driver. A complex query to o3 can generate 10,000-50,000 reasoning tokens that never appear in the final response. OpenAI's o3-pro, designed for maximum reasoning depth, costs $280/month in typical agent workloads — 3.6x more than o3 and 18x more than o4-mini — primarily due to reasoning token volume. The gap between "thinking about it" and "just doing it" is measured in dollars per task.

## The Research Frontier: Learning When to Think

### CogRouter: Cognitive Depth Adaptation Grounded in ACT-R

The most significant recent contribution is CogRouter, published in February 2026 by researchers building on ACT-R (Adaptive Control of Thought-Rational) cognitive architecture theory. CogRouter defines four hierarchical cognitive levels for agent steps:

1. **Level 0 — Instinctive Response:** Direct action without reasoning. Suitable for routine operations like opening a URL, clicking a known button, or executing a memorized command.
2. **Level 1 — Associative Recall:** Brief pattern matching against learned associations. Suitable for recognizing familiar error patterns or selecting from a known set of tools.
3. **Level 2 — Deliberate Analysis:** Structured reasoning about the current state. Suitable for diagnosing unfamiliar errors, planning multi-step operations, or evaluating trade-offs.
4. **Level 3 — Strategic Planning:** Deep, multi-hypothesis reasoning. Suitable for architectural decisions, complex debugging, or novel problem-solving.

The training pipeline has two stages. First, Cognition-aware Supervised Fine-tuning (CoSFT) teaches the model stable behavior patterns at each cognitive level. Then Cognition-aware Policy Optimization (CoPO) uses reinforcement learning with a novel confidence-aware advantage reweighting scheme — the key insight being that the appropriate cognitive depth should maximize the confidence of the resulting action.

The results are striking: CogRouter with Qwen2.5-7B achieves an 82.3% success rate on ALFWorld and ScienceWorld benchmarks, outperforming GPT-4o by 40.3 percentage points, OpenAI o3 by 18.3 points, and standard GRPO training by 14.0 points — all while consuming 62% fewer tokens. A 7-billion parameter model, when taught to reason adaptively, outperforms frontier models that think uniformly hard on every step.

### ARES: Per-Step Reasoning Effort Selection

Published in March 2026 by UC Santa Barbara's NLP group, ARES (Adaptive Reasoning Effort Selection) takes a complementary approach. Rather than training the agent model itself to vary reasoning depth, ARES adds a lightweight router that predicts the minimum reasoning effort needed for each step.

The router receives the same input context as the agent — task description, interaction history, current observation — and classifies the step into low, medium, or high effort categories. The classification maps directly to the reasoning effort parameters now exposed by major providers (Claude's effort levels, OpenAI's `reasoning.effort`, Gemini's thinking budget).

ARES's training pipeline is methodical:

1. **Trajectory Collection:** Gather successful agent trajectories with minimal step counts.
2. **Effort Annotation:** For each step in each trajectory, empirically determine the minimum reasoning effort that still produces a correct action.
3. **Rationale Generation:** A teacher LLM generates natural-language explanations for why each effort level was chosen — "this step requires only URL navigation, no complex reasoning" or "this step involves parsing a complex table to extract specific values."
4. **Supervised Fine-tuning:** The router is fine-tuned to jointly predict rationales and effort labels.

Across TAU-Bench (tool use), BrowseComp-Plus (deep research), and WebArena (web navigation), ARES reduces reasoning token usage by up to 52.7% with minimal degradation in task success rates. The router adds negligible latency — it runs a single forward pass through a small model before the main agent processes each step.

### Cognitive Decision Routing (CDR)

A parallel line of work, Cognitive Decision Routing, frames the problem through the lens of Kahneman's System 1/System 2 theory. CDR trains a decision router that classifies incoming queries along two dimensions: cognitive demand (how much reasoning is needed) and domain specificity (how specialized the knowledge requirements are).

Results show a 34% reduction in computational costs with a 23% improvement in consistency for professional judgment tasks. The key insight is that domain specificity matters as much as difficulty — a query that is simple but requires specialized domain knowledge should route to a knowledgeable model at low reasoning effort, not to a general-purpose reasoner at high effort.

## Provider-Level Reasoning Controls

### Anthropic: Adaptive Thinking and Effort Levels

Anthropic's Claude API now provides the most granular reasoning controls in the industry. The `thinking.type: "adaptive"` setting lets Claude evaluate each request's complexity and determine whether and how deeply to engage extended thinking — automatically. Combined with the `effort` parameter, teams get four distinct levels:

- **Low effort:** Fastest response, minimal thinking. Suitable for classification, simple extraction, and high-volume pipelines.
- **Medium effort (recommended default):** Balanced reasoning. Suitable for agentic coding, tool-heavy workflows, and most production use cases.
- **High effort:** Thorough reasoning for Sonnet 4.6-class tasks requiring careful analysis.
- **Max effort:** Unconstrained thinking for tasks requiring the deepest analysis — the model may use thousands of reasoning tokens.

Critically, adaptive thinking enables *interleaved thinking* — Claude can think between tool calls in agentic workflows, not just before the first response. This means an agent can reason deeply before a complex tool call, then switch to fast mode for a routine follow-up, all within a single conversation turn. The `effort` parameter replaces the older `budget_tokens` approach for Opus 4.6 and Sonnet 4.6, providing a more intuitive control surface.

### OpenAI: Reasoning Effort for o-Series Models

OpenAI's `reasoning.effort` parameter for o3 and o4-mini supports low, medium, and high settings. Lower effort favors speed and token economy; higher effort favors thoroughness. The parameter can be set per-request, enabling dynamic routing within agent loops.

The o4-mini model is particularly relevant for adaptive architectures: at $0.55/$2.20 per million tokens (input/output), it outperforms o3-mini on every benchmark while costing half as much. For agent systems implementing effort routing, o4-mini at high effort handles complex steps, while o4-mini at low effort handles routine steps — same model, dramatically different cost profiles.

### Google: Gemini Thinking Budget

Gemini 3 Flash offers a `thinkingBudget` parameter that sets the maximum number of thinking tokens. Setting it to 0 disables thinking entirely; setting it to -1 allows dynamic allocation. Gemini 3 Flash with thinking enabled is designed specifically for agentic workflows — it combines Pro-class reasoning with Flash-class latency and cost when thinking is not needed.

Google's approach also includes "thought signatures" in Gemini 3 Pro, which maintain reasoning state across multi-turn interactions to prevent context drift during long-horizon agentic tasks.

## Architectural Patterns for Production

### Pattern 1: Static Effort Routing

The simplest production pattern: classify steps by type and assign fixed effort levels.

```
Navigation steps    → low effort
Data extraction     → low effort  
Tool selection      → medium effort
Error diagnosis     → high effort
Code generation     → high effort
Verification        → medium effort
```

This requires no ML infrastructure — just a mapping table maintained by the engineering team. It captures the 80/20 of reasoning optimization: most agent frameworks have a small number of step types, and effort requirements are predictable by type. The limitation is that it cannot adapt to unusual instances within a step type (an "easy" error diagnosis vs a "hard" one).

### Pattern 2: Lightweight Router (ARES-Style)

Add a small classifier (fine-tuned small LM or even an MLP on the agent's hidden states) that predicts effort level per step. The router sees the same context as the agent and runs in ~10ms, adding negligible overhead while enabling instance-level adaptation.

The ARES paper demonstrates that a LoRA-fine-tuned classifier on raw question text achieves strong effort prediction accuracy. In practice, teams can bootstrap this by:

1. Running the agent at max effort for a sample of tasks
2. Replaying each step at decreasing effort levels to find the minimum sufficient level
3. Training the router on the resulting (context, minimum_effort) pairs

This approach requires a modest upfront investment in data collection but pays for itself within days at production scale.

### Pattern 3: Confidence-Based Escalation

Use the agent's own output confidence as a real-time signal. When the model produces a high-entropy response (low confidence in the next action), escalate to higher reasoning effort and re-process the step. When confidence is high, proceed at the current effort level.

This pattern has the advantage of being fully online — no pre-training of routers, no labeled data. The disadvantage is that it requires an initial inference at low effort to measure confidence, adding latency on steps that do escalate. Research shows this approach works best when combined with a static baseline: start at the effort level predicted by the step type, escalate only when confidence falls below a threshold.

### Pattern 4: Multi-Model Cascade with Reasoning Tiers

Rather than varying effort within a single model, route steps to entirely different models based on expected difficulty:

- **Tier 0 (trivial):** Gemini 3.1 Flash Lite ($0.25/M input) or DeepSeek V3.2. No thinking mode. For template-filling, URL construction, simple parsing.
- **Tier 1 (routine):** Claude Sonnet 4.6 at low effort or o4-mini at low effort. Light reasoning. For standard tool selection, familiar error patterns, structured extraction.
- **Tier 2 (complex):** Claude Opus 4.6 at medium effort or o3 at medium effort. Full reasoning. For diagnosis, planning, code generation.
- **Tier 3 (frontier):** Claude Opus 4.6 at max effort or o3 at high effort or Gemini 3 Deep Think. Maximum reasoning depth. For novel problems, architectural decisions, complex multi-step planning.

The AgentTTS framework (2026) formalizes this by using an LLM agent to autonomously search for compute-optimal allocations across subtasks. Its key finding: different subtasks exhibit distinct preferences between large and small models, and the compute allocated to earlier subtasks influences the scaling dynamics of downstream subtasks.

### Pattern 5: Adaptive Thinking with Interleaved Control

The most sophisticated pattern leverages Anthropic's interleaved thinking to vary reasoning depth *within* a single agent turn. The agent reasons deeply before a complex tool call, receives the result, then proceeds with minimal thinking for the next action if the result is straightforward.

This eliminates the overhead of per-step routing entirely — the model itself decides how much to think at each point. The `thinking.type: "adaptive"` setting handles this automatically. The trade-off is less control: the model's difficulty assessment may not always match the team's preferences, and costs are less predictable than with explicit effort routing.

## Test-Time Compute Scaling: The Theoretical Foundation

### The Compute-Optimal Scaling Result

The theoretical foundation for adaptive reasoning comes from UC Berkeley's seminal work on test-time compute scaling (Snell et al., 2024, presented as an ICLR 2025 Oral). The core finding: the effectiveness of different test-time compute strategies varies critically depending on problem difficulty, and a "compute-optimal" strategy that allocates budget adaptively per problem achieves 4x better efficiency than a fixed-budget approach.

Specifically, on easy problems, the compute-optimal strategy matches best-of-N performance using 4x less compute (16 generations instead of 64). On hard problems, additional compute is well-spent — the scaling curve is steep. On medium problems, the returns are moderate. The implication for agent systems is clear: most steps in an agent loop are easy or medium, meaning most reasoning compute in a uniform-effort system is wasted.

### Test-Time Scaling Makes Overtraining Compute-Optimal

A remarkable April 2026 paper ("Test-Time Scaling Makes Overtraining Compute-Optimal") shows that the classical compute-optimal training paradigm (Chinchilla scaling laws) changes when test-time compute is available. When you can think harder at inference time, it becomes optimal to *overtrain* smaller models — investing more training compute into a compact model and then scaling test-time compute adaptively. This validates the production pattern of using a smaller, cheaper model with dynamic reasoning depth rather than a larger model at fixed depth.

### The "Reasoning on a Budget" Taxonomy

The comprehensive "Reasoning on a Budget" survey (Alomrani et al., July 2025) introduces a two-tiered taxonomy:

- **L1-Controllability:** Methods that operate under fixed compute budgets — the user or system sets a maximum reasoning token count, and the model works within it.
- **L2-Adaptiveness:** Methods that dynamically scale inference based on input difficulty or model confidence — the system decides how much to think.

Production systems typically need both: L1 controls as guardrails (hard budget caps to prevent runaway reasoning) and L2 adaptiveness for efficiency (the system allocates within the budget optimally). The survey benchmarks leading proprietary models and finds that no single test-time scaling strategy universally dominates — the optimal strategy depends on the model, the task domain, and the difficulty distribution.

## Model-Level Innovations

### Inner Thinking Transformer (ITT)

At the architecture level, the Inner Thinking Transformer (February 2026) demonstrates that adaptive reasoning depth can be built into the model itself, not just layered on top. ITT uses Adaptive Token Routing to allocate more transformer layer passes to "difficult" tokens — tokens where the model's internal representations show high gradient variance — while routing easy tokens through fewer layers.

The result: ITT achieves equivalent performance to a 466M-parameter standard transformer using only 162M parameters, saving 43.2% of training compute. For agent systems, this suggests a future where the models themselves are natively adaptive, eliminating the need for external routing infrastructure.

### Mixture-of-Recursions (MoR)

A complementary approach, Mixture-of-Recursions, reuses shared layer stacks across recursion steps with lightweight routers that assign different recursion depths to individual tokens. This achieves parameter efficiency while maintaining the ability to reason deeply on difficult tokens — a promising direction for on-device agent models where parameter count directly constrains deployment.

## Production Economics

### Cost Modeling: Uniform vs Adaptive

Consider a production agent processing 10,000 tasks per day, averaging 12 steps per task:

**Uniform high-effort (baseline):**
- Average 8,000 reasoning tokens per step
- 12 steps × 8,000 tokens = 96,000 reasoning tokens per task
- At $60/M tokens (Opus 4.6 output rate): $5.76 per task
- Daily cost: $57,600

**Adaptive effort (ARES-style routing):**
- 3 high-effort steps: 8,000 tokens each = 24,000
- 4 medium-effort steps: 2,000 tokens each = 8,000
- 5 low-effort steps: 200 tokens each = 1,000
- Total: 33,000 reasoning tokens per task (65.6% reduction)
- At $60/M tokens: $1.98 per task
- Daily cost: $19,800
- **Annual savings: $13.8M**

Even at smaller scales (100 tasks/day), the savings are $138K annually — enough to fund the engineering effort to build an adaptive routing system many times over.

### The Efficient Frontier: Model Selection Interacts with Reasoning Depth

The cost calculus changes further when model selection is combined with reasoning depth. o4-mini at high effort ($2.20/M output) often matches o3 at medium effort ($60/M output) on routine agent steps, at 27x lower cost. Claude Sonnet 4.6 at medium effort handles 80% of steps that would otherwise go to Opus 4.6 at high effort. DeepSeek V3.2 at $0.40/M output achieves 90% of GPT-5.4's performance on straightforward tasks.

The production-optimal configuration is not one model at one effort level — it is a portfolio of models at varying effort levels, with a routing layer that selects the cheapest option that meets the quality threshold for each step.

## Challenges and Open Problems

### Difficulty Prediction Is Imperfect

All adaptive routing systems face a fundamental challenge: predicting step difficulty before the step is executed. A step that looks routine ("read the config file") may reveal an unexpected complexity ("the config uses an unfamiliar templating language"). Misclassifying a hard step as easy leads to agent failures; misclassifying an easy step as hard wastes tokens but doesn't hurt quality. This asymmetry suggests that production systems should err on the side of over-allocation, with confidence-based escalation as a safety net.

### Cascading Effects in Multi-Step Tasks

The AgentTTS research highlights that compute allocation in earlier steps affects downstream steps. An agent that reasons shallowly about a task plan may produce a suboptimal plan that makes every subsequent step harder. Conversely, investing heavily in the planning step can simplify all downstream execution. The optimal allocation is not independently determined per step — it is a joint optimization problem over the full trajectory.

### Evaluation Is Hard

Measuring whether an adaptive system is "better" requires comparing task success rates at multiple cost points, not just peak performance. A system that achieves 95% success at $2/task may be superior to one achieving 98% at $8/task, depending on the application. Standard benchmarks (SWE-bench, WebArena) report only success rate, not cost-efficiency frontiers. The field needs benchmarks that jointly evaluate accuracy and compute efficiency.

### Reasoning Token Observability

Most providers treat reasoning tokens as opaque — teams see a total token count but cannot inspect what the model thought about. Without visibility into reasoning content, teams cannot determine whether the model is over-thinking (wasting tokens on obvious steps) or under-thinking (skipping critical analysis). Anthropic provides some visibility through thinking blocks in the API response, but the content is summarized rather than complete in multi-turn contexts.

## Implications for Agent-First Organizations

For teams building production AI agents, adaptive reasoning depth is transitioning from research concept to engineering requirement. The immediate actions are:

1. **Instrument reasoning token usage.** Before optimizing, measure. Add per-step reasoning token tracking to your observability stack. Most teams are surprised by how much reasoning compute goes to trivial steps.

2. **Start with static effort routing.** Classify your agent's step types and assign effort levels based on empirical testing. This captures the majority of savings with zero ML infrastructure.

3. **Adopt provider adaptive controls.** Claude's `thinking.type: "adaptive"` with effort levels, OpenAI's `reasoning.effort`, and Gemini's `thinkingBudget` are production-ready today. Set medium as default and override per step type.

4. **Build toward instance-level routing.** As you accumulate execution traces, train a lightweight router (ARES-style) to predict per-step effort. The ROI is strong for any agent processing more than 100 tasks per day.

5. **Design for escalation, not perfection.** The safest architecture starts at low effort and escalates when confidence is low, rather than starting high and trying to skip thinking. Failed-then-escalated steps cost more than correctly-routed steps, but far less than uniformly high-effort execution.

The broader trend is clear: inference-time compute is becoming a first-class resource to be allocated strategically, not spent uniformly. The agents that thrive in production will be those that think hard when it matters and think fast when it doesn't.

## References

- **CogRouter — Think Fast and Slow:** Fanghua Ye et al., "Think Fast and Slow: Step-Level Cognitive Depth Adaptation for LLM Agents," arXiv:2602.12662 (February 2026)
- **ARES:** UCSB NLP Group, "Ares: Adaptive Reasoning Effort Selection for Efficient LLM Agents," arXiv:2603.07915 (March 2026). Code: github.com/UCSB-NLP-Chang/Ares
- **Cognitive Decision Routing:** "Cognitive Decision Routing in Large Language Models: When to Think Fast, When to Think Slow," arXiv:2508.16636
- **Compute-Optimal Scaling:** Snell et al., "Scaling LLM Test-Time Compute Optimally can be More Effective than Scaling Model Parameters," ICLR 2025 Oral, arXiv:2408.03314
- **Test-Time Scaling Survey:** "The Art of Scaling Test-Time Compute for Large Language Models," arXiv:2512.02008 (December 2025)
- **Reasoning on a Budget:** Alomrani et al., "Reasoning on a Budget: A Survey of Adaptive and Controllable Test-Time Compute in LLMs," arXiv:2507.02076 (July 2025)
- **AgentTTS:** "AgentTTS: Large Language Model Agent for Test-time Compute-optimal Scaling Strategy in Complex Tasks," arXiv:2508.00890
- **Inner Thinking Transformer:** "Inner Thinking Transformer: Leveraging Dynamic Depth Scaling to Foster Adaptive Internal Thinking," arXiv:2502.13842 (February 2026)
- **Test-Time Scaling Makes Overtraining Compute-Optimal:** arXiv:2604.01411 (April 2026)
- **Anthropic Adaptive Thinking Docs:** platform.claude.com/docs/en/build-with-claude/adaptive-thinking
- **OpenAI Reasoning Models Guide:** platform.openai.com/docs/guides/reasoning
- **Gemini Thinking Docs:** ai.google.dev/gemini-api/docs/thinking
