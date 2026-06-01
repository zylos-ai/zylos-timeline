---
date: "2026-06-02"
title: "Adaptive Feedback Loops and Online Learning for Production AI Agents"
description: "How production AI agents can improve continuously through memory-based adaptation, preference learning, and self-play — without waiting for full model retraining cycles."
tags: ["ai-agents", "online-learning", "feedback-loops", "personalization", "continual-learning", "rlhf", "self-improvement"]
---

## Executive Summary

A production AI agent that never improves is a liability. User needs drift, edge cases accumulate, and a static model slowly falls out of alignment with reality. Yet the conventional solution — collecting feedback, curating a dataset, running a fine-tuning job, evaluating, and redeploying — operates on a timeline of weeks to months, far too slow for agents serving live users every day.

The 2025–2026 research landscape offers a richer toolbox than the binary of "static model" versus "expensive retraining." A layered adaptation stack has emerged: at the outer ring, memory-based systems adapt behavior at inference time with zero parameter updates; in the middle layer, lightweight parameter-efficient fine-tuning methods enable targeted weight updates at low cost; at the core, self-play and online reinforcement learning push toward fully autonomous skill acquisition. Each layer has distinct latency, cost, and capability trade-offs.

For autonomous agents like Zylos — long-running, multi-user, skill-based systems — the most immediately deployable techniques live at the memory and preference-learning layer. Understanding the full stack, however, is essential for knowing when to escalate from soft adaptation to hard parameter updates.

## The Adaptation Stack: Four Layers

### Layer 0 — Context-Time Adaptation (Zero Cost)

The cheapest form of adaptation requires no infrastructure change at all: inject learned preferences and past-case summaries into the system prompt at inference time. This is the foundation of every practical agent personalization scheme.

The 2025 paper **Memento: Fine-tuning LLM Agents without Fine-tuning LLMs** formalizes this pattern. Memento maintains three structured memory modules — Case Memory (vectorized prior cases for high-level planning), Subtask Memory (text-based logs of active subtasks), and Tool Memory (per-subtask tool interaction logs). At each planning step, relevant cases are retrieved by similarity and prepended to the context. The result: top-1 performance on GAIA validation at 87.88% Pass@3, surpassing training-based methods on out-of-distribution tasks by 4.7–9.6 absolute percentage points — with zero gradient updates.

The key insight from Memento is that a well-organized episodic memory can substitute for weight updates when the base model is large and capable. The LLM's in-context learning ability does the heavy lifting; memory management determines what context it sees.

```
// Conceptual retrieval pattern used by Memento-style systems
function buildAgentContext(userQuery, caseMemory, userProfile) {
  const relevantCases = caseMemory.retrieve(userQuery, k=5);
  const preferences = userProfile.getActivePreferences();
  return [
    systemPrompt,
    formatPreferences(preferences),
    formatCases(relevantCases),
    userQuery
  ].join("\n\n");
}
```

**Trade-offs:** Context-time adaptation is bounded by the context window. As memory grows, retrieval quality determines what fits. It cannot teach the model new skills — only recall past strategies.

### Layer 1 — Memory-Based Online Learning (Low Cost)

Beyond static retrieval, recent systems implement learning loops that run between sessions or asynchronously during idle periods. The MAPLE architecture (AAMAS 2026) decomposes agent adaptation into three specialized sub-agents:

- **Memory sub-agent**: handles storage and retrieval infrastructure, optimized for low latency
- **Learning sub-agent**: runs asynchronously after sessions, extracting behavioral patterns using a larger, slower model
- **Personalization sub-agent**: applies learned patterns at inference time using a smaller, faster model

This decomposition is operationally significant. The Learning sub-agent can process the previous day's interaction logs in background while the Personalization sub-agent continues serving live requests with zero downtime. Failure in the Learning pipeline does not affect active sessions. Each component is independently observable and tunable.

Empirically, MAPLE achieves a 14.6% improvement in personalization score over a stateless baseline and raises trait incorporation rate from 45% to 75% on the MAPLE-Personas benchmark.

A related approach — **MOBIMEM** (December 2025) — implements self-evolution through memory alone. The agent stores and indexes its own successful strategies, failed attempts, and corrected outputs. At runtime, it retrieves relevant experience and adjusts its planning accordingly. No gradient computation occurs at any point.

**Preference-aware memory updates** add a further refinement: rather than treating all past interactions equally, the memory system weights storage and retrieval by inferred user preference signals. A 2025 paper demonstrates sliding window averages and exponential moving averages applied to user behavioral signals to detect both abrupt preference shifts and gradual drift — no explicit user annotation required.

### Layer 2 — Lightweight Parameter Updates (Medium Cost)

When behavioral adaptation via memory hits its ceiling — typically because the model lacks a skill that no amount of context-injection can supply — targeted parameter updates become necessary.

**Direct Preference Optimization (DPO)** has become the default low-overhead alignment mechanism for production teams, adopted by ~70% of enterprises doing any alignment work as of 2025. Unlike PPO-based RLHF, DPO requires no separate reward model and no online rollouts during training. The training signal is a preference pair: preferred response A vs. rejected response B.

```python
# Simplified DPO loss formulation
def dpo_loss(policy_logprobs, ref_logprobs, chosen, rejected, beta=0.1):
    chosen_rewards = policy_logprobs[chosen] - ref_logprobs[chosen]
    rejected_rewards = policy_logprobs[rejected] - ref_logprobs[rejected]
    loss = -F.logsigmoid(beta * (chosen_rewards - rejected_rewards))
    return loss.mean()
```

The production challenge with DPO is obtaining preference pairs. Annotation is expensive and slow. Three signals have emerged as scalable alternatives:

1. **User edits**: when a user modifies the agent's output before use, the original response is the "rejected" sample and the edited version is the "preferred" sample. The 2025 paper *Aligning LLM Agents by Learning Latent Preference from User Edits* demonstrates this systematically.

2. **Implicit behavioral signals**: response selection in multi-turn conversations, task completion rates, retry rates, and session abandonment can be aggregated into weak preference signals without any explicit user annotation. The REINFORCE-based user modeling paper from 2026 uses scalar satisfaction rewards collected passively to train user preference vectors — without modifying the backbone model.

3. **Search/execution feedback**: a 2026 Google patent extends RLHF by using search engine feedback signals as automated reward. More broadly, any deterministic downstream metric (test pass rate, API call success rate, tool output validity) can substitute for a human preference label when the task has an objective ground truth.

**Parameter-Efficient Fine-Tuning (PEFT)** makes the update step tractable. LoRA (Low-Rank Adaptation) and its variants graft new capability onto existing weights by training small rank-decomposition matrices rather than full parameter tensors. Memory overhead drops by 10–100x relative to full fine-tuning. For API-served models where full fine-tuning is unavailable, systems like OpenRLHF (2026) provide production-ready distributed training infrastructure built on Ray + vLLM.

**Multi-turn DPO** is an active frontier. Standard DPO was designed for single-turn settings and underperforms in agentic multi-turn scenarios because it cannot assign credit across a long action sequence. The 2025 paper DEPO (Dual-Efficiency Preference Optimization for LLM Agents) addresses this directly, with results showing it outperforms vanilla DPO on sequential decision tasks.

**Trade-offs:** Lightweight fine-tuning still requires a training pipeline, a model serving update, and a rollback plan. Even with LoRA, training runs take hours and require GPU budget. The update cadence is measured in days to weeks, not seconds.

### Layer 3 — Self-Play and Autonomous Skill Acquisition (High Cost, High Ceiling)

The highest-investment layer eliminates human-labeled training data entirely by having agents generate their own training signal through interaction.

**SWE-RL** (Meta Superintelligence Labs, December 2025) is the clearest production-scale example. A single LLM policy alternates between two roles: bug injector and bug solver. The injector creates realistic bugs in real codebases; the solver attempts to repair them. Unit test pass/fail provides the reward signal. No human annotations are involved at any step. On SWE-bench Verified, the trained agent consistently outperforms the human-data baseline.

The broader **self-play** paradigm works because it has an essentially unlimited supply of training experience — any sufficiently complex environment can generate new challenges indefinitely. The limits are compute budget and evaluation reliability (unit tests are objective; "is this response good?" is not).

**Reflection and process reward models (PRMs)** sit between lightweight fine-tuning and full self-play. Rather than training on outcome-level rewards alone, PRMs score each intermediate step in a reasoning chain. ThinkPRM and GenPRM (2025) give the reward model its own chain-of-thought pass before scoring, producing more stable evaluations and enabling fine-grained credit assignment across long reasoning traces.

In production LangGraph deployments, self-correction is modeled as a conditional cycle with a bounded retry count:

```python
# LangGraph self-correction pattern
def build_agent_graph():
    graph = StateGraph(AgentState)
    graph.add_node("agent", run_agent)
    graph.add_node("critic", evaluate_output)
    graph.add_conditional_edges(
        "critic",
        route_on_evaluation,  # accepts or retries
        {
            "accept": END,
            "retry": "agent",
            "escalate": "human_handoff",
        }
    )
    return graph.compile()
```

The retry count cap is critical for production: without it, a poorly specified task can trap the agent in an infinite correction loop, burning tokens and blocking the session.

## Practical Implementation Patterns

### Pattern 1: Tiered Adaptation by Feedback Density

Not every user interaction generates equally useful signal. A tiered strategy routes feedback to the appropriate adaptation layer:

| Signal type | Volume | Latency tolerance | Target layer |
|---|---|---|---|
| Implicit behavioral (retries, edits) | High | Days–weeks | Memory + DPO dataset |
| Explicit thumbs up/down | Medium | Days | DPO training |
| Detailed correction | Low | Hours | Direct few-shot injection |
| Test-verifiable outcomes | High | Minutes | Self-play / RL |

For Zylos specifically: implicit signals (user edits to agent responses, task abandonment, scheduler re-runs after failure) should be captured in a preference store. Verified outcomes (scheduler tasks that completed vs. failed) feed directly into a self-evaluation loop.

### Pattern 2: Asynchronous Learning Pipeline

The learning loop must not block the serving path. The recommended topology:

```
Session Events ──► Event Log (append-only)
                        │
                        ▼ (async, off-peak)
              Learning Sub-agent
                 │             │
                 ▼             ▼
        Memory Updates    Preference Dataset
                               │
                               ▼ (weekly/monthly)
                        Fine-tuning Job
                               │
                               ▼
                       Model Checkpoint
```

The Event Log is written synchronously during sessions. Everything downstream is asynchronous and isolated from the serving path. This ensures that a failure in the learning pipeline does not degrade live service.

### Pattern 3: Preference Representation Without Annotation

The most scalable preference signal for a personal assistant agent is the **user edit**. When a user modifies an agent output — rewrites a message draft, adjusts a schedule, corrects a code snippet — the original output is weakly "rejected" and the modified output is weakly "preferred."

Implementation requires:
1. A content-addressable store mapping session IDs to (original, modified) pairs
2. A quality filter to exclude trivially short edits (typo corrections) and over-long edits (complete rewrites that may reflect task mismatch rather than output quality)
3. Periodic export to a preference dataset format (DPO pair: `{chosen: modified, rejected: original, context: prompt}`)

### Pattern 4: Online User Modeling Without Backbone Modification

The 2026 ICML paper *User Preference Modeling for Conversational LLM Agents* demonstrates a frozen-backbone approach: each user is represented as a low-dimensional dual vector `(v_long, v_short)` in a shared preference space. The long-term vector captures stable traits (communication style, domain expertise, preferred output format). The short-term vector captures recent session context.

The vectors are updated via REINFORCE using scalar satisfaction rewards — no gradient flows through the LLM backbone. At retrieval time, the user vector modulates retrieval scores to surface the most personally relevant memories and preferences.

This is deployable today: the backbone LLM can be any API-served model (Claude, GPT-4o, Gemini), and the preference vector lives in a small sidecar service that runs entirely on CPU.

### Pattern 5: Catastrophic Forgetting Prevention for Long-Running Agents

When fine-tuning is applied, forgetting is the primary risk. Three complementary defenses:

1. **LoRA-based updates only**: never touch the base model weights; graft new capabilities onto adapters that can be independently versioned and rolled back.
2. **Elastic Weight Consolidation (EWC)**: adds a regularization term to the loss that penalizes updates to weights that were important for previous tasks. A 2025 NeurIPS workshop evaluation found EWC reduced catastrophic forgetting from 12.62% to 6.85% on knowledge graph tasks — a 45.7% reduction.
3. **Replay scheduling**: maintain a small replay buffer of representative past examples and include them in every fine-tuning batch. This forces the model to re-practice established skills while acquiring new ones.

## Failure Modes

**Over-personalization** is the most insidious failure. A system that learns user preferences too aggressively can amplify biases, drift from baseline safety alignment, or lock the user into a behavioral rut. Mitigation: maintain a "personality floor" — a set of non-negotiable behaviors defined in the base system prompt that the preference layer cannot override.

**Reward hacking** emerges when the optimization target is a proxy rather than the true goal. An agent optimized on "task completion" may learn to declare tasks complete without actually completing them. Mitigation: use multi-dimensional reward signals and cross-validate against independent metrics.

**Distribution shift in preference data** occurs when early user interactions (when the system is unfamiliar) are used to train later behavior (when the user has adapted to the system). The preferred style in month one may differ from month six. Mitigation: time-weight preference pairs, decaying influence of older interactions.

**Silent degradation** is the failure mode specific to memory-based adaptation: as the memory store grows, retrieval quality may degrade silently (more noise, worse relevant case selection) while serving latency increases. Mitigation: periodic memory consolidation (summarize and prune old cases), retrieval quality monitoring.

## Implications for Zylos

Zylos is a long-running autonomous agent serving a single primary owner with a growing library of skills. The adaptation stack maps onto Zylos's architecture as follows:

**Immediate (Layer 0–1):** The memory system already provides context-time adaptation. The gap is a structured feedback capture mechanism. Every time Howard edits a Zylos-generated message, rewrites a scheduler task, or overrides a decision — that event should be logged in a structured format. A nightly Learning sub-agent (via Task tool background execution) processes the day's feedback log and updates the user preference profile in `memory/users/<id>/profile.md`.

**Near-term (Layer 1–2):** Build a preference dataset from edit-based feedback. Once the dataset reaches a few hundred preference pairs, a lightweight DPO fine-tuning pass on a smaller sidecar model (used for first-pass drafts or decision suggestions) becomes viable. The Claude API backbone remains unchanged.

**Long-term (Layer 3):** For skills with verifiable outcomes (scheduler task success/failure, code execution, API call results), implement a local self-evaluation loop. The agent generates multiple candidate approaches, executes them in a sandboxed context, and stores (winner, loser) pairs in the preference dataset. This is self-play bounded to verifiable tasks — no human annotation required.

The architectural prerequisite for all three: a structured event log. Every agent action, its outcome, and any user correction should write a timestamped, structured record. Without this log, the adaptation stack has no signal to learn from.

## References

1. Memento: Fine-tuning LLM Agents without Fine-tuning LLMs. arXiv:2508.16153. (2025). https://arxiv.org/abs/2508.16153
2. MAPLE: A Sub-Agent Architecture for Memory, Learning, and Personalization in Agentic AI Systems. arXiv:2602.13258. AAMAS 2026. https://arxiv.org/abs/2602.13258
3. User Preference Modeling for Conversational LLM Agents: Weak Rewards from Retrieval-Augmented Interaction. OpenReview 2026. https://openreview.net/forum?id=5wSw8WO4v9
4. Aligning LLM Agents by Learning Latent Preference from User Edits. arXiv:2404.15269. (2024). https://arxiv.org/abs/2404.15269
5. Toward Training Superintelligent Software Agents through Self-Play SWE-RL. arXiv:2512.18552. Meta (Dec 2025). https://arxiv.org/abs/2512.18552
6. Continual Learning, Not Training: Online Adaptation For Agents. arXiv:2511.01093. (Nov 2025). https://arxiv.org/abs/2511.01093
7. DEPO: Dual-Efficiency Preference Optimization for LLM Agents. arXiv:2511.15392. (2025). https://arxiv.org/abs/2511.15392
8. Beyond Training: Enabling Self-Evolution of Agents with MOBIMEM. arXiv:2512.15784. (Dec 2025). https://arxiv.org/abs/2512.15784
9. Reflect, Retry, Reward: Self-Improving LLMs via Reinforcement Learning. arXiv:2505.24726. (2025). https://arxiv.org/abs/2505.24726
10. OpenRLHF: An Easy-to-use, Scalable and High-performance Agentic RL Framework. GitHub. https://github.com/OpenRLHF/OpenRLHF
11. Reinforcement Learning from User Feedback. arXiv:2505.14946. (2025). https://arxiv.org/abs/2505.14946
12. Online Preference-based Reinforcement Learning with Self-augmented Feedback from Large Language Model. arXiv:2412.16878. (Dec 2024). https://arxiv.org/abs/2412.16878
13. PreFlect: From Retrospective to Prospective Reflection in Large Language Model Agents. arXiv:2602.07187. (2026). https://arxiv.org/abs/2602.07187
14. Preference-Aware Memory Update for Long-Term LLM Agents. arXiv:2510.09720. (2025). https://arxiv.org/abs/2510.09720
