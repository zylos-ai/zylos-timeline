---
date: "2026-04-09"
title: "Continual Learning and Catastrophic Forgetting Prevention in AI Agents"
description: "How long-running AI agents learn from ongoing experience without overwriting prior knowledge — architectures, techniques, and production realities in 2026."
tags:
  - continual-learning
  - catastrophic-forgetting
  - ai-agents
  - memory
  - llm
  - production
---

## Executive Summary

A fundamental tension sits at the heart of every long-running AI agent: the agent must adapt to new information to stay useful, yet every update risks overwriting the knowledge that made it useful in the first place. This is the catastrophic forgetting problem — and in 2025–2026, it has moved from an academic curiosity to a production engineering challenge as agents graduate from session-scoped chatbots to persistent, multi-month services.

The field has responded with a diverse toolkit. At the model-weight level, regularization methods like Elastic Weight Consolidation (EWC) and orthogonal subspace learning protect prior knowledge during fine-tuning. Parameter-efficient adapters (LoRA families) allow new capabilities to be grafted on without touching the base model at all. Replay-based methods borrow from neuroscience, scheduling strategic rehearsal of past experiences to counteract forgetting. And an entirely different approach — continual learning in token space — sidesteps weight updates entirely, managing what the model knows through intelligent memory curation in the context window.

Industry implementations are increasingly mixing these strategies. Letta's stateful agent architecture, Meta's sparse memory fine-tuning, Google's Titans architecture, and open-source frameworks like A-MEM all represent distinct points on the spectrum between "learn in context" and "learn in weights." Each comes with different tradeoffs around cost, latency, privacy, and the depth of learning achievable.

For teams building production agents in 2026, the practical question is no longer whether to support continual learning — users expect agents to remember and improve — but rather which strategy best matches their update frequency, privacy constraints, and acceptable compute budget.

## The Problem: Why Forgetting Happens

### Catastrophic Forgetting Defined

When a neural network is trained on a new task, gradient updates move weights toward the new objective. If those updates overwrite weights that were critical to a previous task, performance on the old task degrades sharply — often catastrophically, losing most of its capability with just a small amount of new training. This phenomenon, first formally characterized in the 1980s and rigorously studied since, remains one of the most persistent challenges in machine learning.

For transformer-based LLMs, the problem has a specific character. Knowledge is distributed across billions of weight parameters in a highly entangled way — there is no clean "module for French" or "register for user preferences" that can be updated in isolation. Every fine-tuning run reshapes the entire parameter landscape to some degree.

A 2025 comparative analysis (arxiv 2504.01241) confirmed that forgetting is both pervasive and model-dependent: the extent of forgetting varies significantly by model size, architecture, pre-training diversity, and the nature of the tasks being learned. Larger models generally forget less due to overcapacity, but no model is immune.

### The Agent-Specific Stakes

For AI agents, forgetting carries consequences that extend beyond benchmark degradation. A customer support agent that forgets product policies after a training update gives wrong answers to real customers. A coding assistant that unlearns programming conventions after being fine-tuned on a new language produces subtly broken code. A personal productivity agent that forgets a user's working style after adapting to a new task reverts to generic behavior that the user had spent weeks correcting.

Langchain's 2025 analysis of production agent deployments identified three recurring failure modes directly attributable to forgetting: agents giving outdated answers after policy updates, workflow bots missing newly introduced rules, and assistant agents forgetting established user preferences after capability expansions. Each case represents a real regression to users who experienced the agent as "breaking" after an update.

The continual learning problem is therefore not purely academic — it is a core reliability and user experience concern for any agent expected to improve over its lifetime.

## Taxonomy of Approaches

The research literature organizes continual learning strategies into three broad families: regularization-based methods, architecture-based methods, and replay-based methods. A fourth approach — context-window-based continual learning — has gained particular traction in LLM agent contexts.

### 1. Regularization-Based Methods

Regularization methods add penalty terms to the training loss that discourage large changes to weights that were important for previous tasks, without requiring storage of old data.

**Elastic Weight Consolidation (EWC)**, introduced in DeepMind's landmark 2017 PNAS paper and still a major reference point in 2025, computes the Fisher Information Matrix over the previous task's data to identify which parameters were most important, then adds a quadratic penalty that resists moving those weights during new training. A 2025 NeurIPS workshop evaluation found that EWC reduced catastrophic forgetting from 12.62% to 6.85% on knowledge graph link prediction — a 45.7% reduction over naive sequential training.

**Orthogonal Subspace Learning (O-LoRA)**, a 2024–2025 development from the parameter-efficient fine-tuning space, trains new task adapters in directions orthogonal to the gradient space of prior tasks. Because updates for new tasks are mathematically constrained not to interfere with prior task directions, knowledge is preserved by construction. O-LoRA outperforms prior state-of-the-art on standard continual learning benchmarks and avoids the data privacy concerns of replay methods (since no stored data is needed). It also better preserves generalization to unseen tasks — an important property for general-purpose agents.

**Function Vector Guided Training** (2025) identifies a different root cause: forgetting in LLMs primarily stems from biases in function activation rather than direct overwriting of task-processing functions. The method protects task activation patterns from being destroyed during fine-tuning using targeted regularization, achieving more surgical preservation than weight-level penalties.

**Low-Perplexity Token Learning** offers a data-centric complement to weight-level regularization: masking high-perplexity tokens during fine-tuning (those that are "hard" for the model to predict) reduces interference with established knowledge. Fine-tuning on LLM-generated data rather than raw ground truth achieves similar preservation effects.

### 2. Architecture-Based Methods

Architecture-based methods prevent interference by keeping old and new knowledge in separate parameter spaces.

**Progressive Neural Networks (PNNs)** allocate a new neural network column for each new task, with lateral connections transferring relevant knowledge forward without modifying previous columns. This fully prevents forgetting by architectural isolation, but at the cost of linear parameter growth — a scaling problem for agents that learn many tasks over time.

**LoRA Adapter Composition** takes a more practical approach: new capabilities are encoded as lightweight LoRA adapters (~0.1–1% of base model parameters) rather than into the base model itself. The base model, which holds general knowledge, is never modified. Task-specific or domain-specific behavior is handled by selecting and composing the appropriate adapter.

Several 2025 papers advance this paradigm:
- **I-LoRA** enables iterative merging of new adapters without being influenced by task order, allowing incremental capability accumulation.
- **L-MoE** (Lightweight Mixture of Experts) trains a gating network to dynamically compose adapter outputs for each input token, allowing multiple specialized adapters to contribute simultaneously.
- **Adaptive Minds** (October 2025) frames each domain of knowledge as a distinct LoRA adapter, with semantic routing selecting the best-suited adapter(s) at inference time. This allows single-backbone multi-domain agents.
- **LoRA-Based Continual Learning with Critical Parameter Constraints** (April 2026) adds an explicit constraint mechanism to prevent updates from overwriting parameters identified as critical to prior adapters.

The main limitation of accumulating adapters is parameter growth. As the number of tasks increases, storing and composing hundreds of distinct adapters becomes unwieldy. Doc-to-LoRA and Text-to-LoRA (Sakana AI, 2025) address the creation side by allowing adapters to be generated from documentation or task descriptions without gradient-based training — but the storage and routing problem persists.

**Titans Architecture** (Google Research, December 2024 / NeurIPS 2025) takes the most fundamental architectural approach: introducing a dedicated neural long-term memory module alongside the attention mechanism. Attention handles short-term context; the long-term memory module stores historical context in its own parameters and learns to memorize at test time through surprise-based prioritization (storing information proportional to how unexpected it is). Experimental results show Titans outperforms standard transformers on tasks requiring recall from 2M+ token contexts, with higher accuracy than linear recurrent models on needle-in-haystack evaluations.

### 3. Replay-Based Methods

Replay methods maintain a buffer of representative past examples and periodically re-expose the model to them during training, preventing the model from forgetting by ensuring past tasks remain in the training distribution.

**Contextual Experience Replay (CER)** (ICLR 2025) adapts this idea for language agents: instead of storing raw training examples, the agent maintains a dynamic memory buffer of natural language summarizations and concrete trajectory examples from past tasks. These are injected into the context window during new learning without any gradient updates. On VisualWebArena, CER achieved a 31.9% success rate — surpassing tree search baselines — and improved GPT-4o agent performance on WebArena by 36.69% relative.

**SuRe: Surprise-Driven Prioritized Replay** (November 2025) addresses the question of which past experiences to keep: the agent prioritizes storage of surprising experiences — outcomes that deviated significantly from expectations. This neurologically-inspired heuristic selects the most informative examples for rehearsal rather than sampling uniformly from a fixed buffer. SuRe is architecture-agnostic and combines naturally with parameter-efficient fine-tuning methods like LoRA.

**FOREVER: Forgetting Curve-Inspired Memory Replay** (January 2026) draws directly from Ebbinghaus's forgetting curve: a model-centric measure of "how fast is this fact being forgotten?" drives both when to replay and how strongly to regularize. By grounding replay decisions in parameter update dynamics, FOREVER jointly optimizes replay scheduling and regularization strength, showing strong forgetting mitigation across diverse language tasks.

**Self-Distillation Fine-Tuning (SDFT)** (MIT / ETH Zurich, 2025) takes a different angle: instead of replaying stored data, the model distills its own existing knowledge into the new learning signal. By leveraging the model's in-context learning abilities to generate self-consistent training examples, SDFT allows a single model to accumulate multiple skills over time without performance regression on earlier capabilities, consistently outperforming traditional supervised fine-tuning.

### 4. Continual Learning in Token Space

This fourth category is specific to LLM-based agents and sidesteps the weight-update problem entirely: rather than changing model parameters, the agent continuously curates what knowledge lives in its context window or external memory stores.

Letta's 2025 blog post "Continual Learning in Token Space" articulates the core thesis: the full continual learning problem — maintaining and refining knowledge across months or years of operation — can be addressed at the memory management layer rather than the parameter layer. MemGPT (now Letta) treats the context window as a constrained memory resource like CPU RAM, with external stores as disk, and gives the agent tools to read, write, and reorganize its own memory. Unlike append-then-summarize (which defers representational work to inference time and is lossy), Letta's approach maintains curated, structured representations in editable core memory.

**A-MEM: Agentic Memory** (February 2026) pushes this further: memory operations (store, retrieve, update, summarize, discard) are exposed as callable tools via a three-stage reinforcement learning pipeline with step-wise GRPO. The agent learns non-obvious memory strategies through experience, including preemptive summarization before context overflow, selective forgetting of redundant entries, and proactive linking of related concepts. The agent's memory system itself becomes adaptive.

**Just-In-Time Reinforcement Learning** (January 2026) demonstrates continual learning without gradient updates at all: agents improve by dynamically constructing experience-rich prompts from accumulated interaction logs, achieving RL-like adaptation entirely through context manipulation.

## Industry Implementations

### Letta (MemGPT)

Letta is the most mature open-source production implementation of context-space continual learning. The architecture maintains three memory tiers: core memory (in-context, directly editable by the agent), archival memory (external vector store, semantically searchable), and recall memory (conversation history, indexed for retrieval). The agent controls its own memory through tool calls — writing facts to core memory, offloading to archival, and recalling as needed. The February 2026 launch of `letta-ai/learning-sdk` packages this as a drop-in SDK for adding continual learning and long-term memory to any LLM agent.

### Mem0

Mem0 emerged in 2025 as a widely adopted memory layer for AI agents, with benchmarks showing up to 26% accuracy gains over plain vector retrieval. Its approach combines semantic consolidation (merging related information, resolving conflicts, pruning redundancy) with intelligent forgetting (de-prioritizing stale or low-relevance entries). Unlike pure vector stores that grow indefinitely, Mem0 maintains a curated, coherent knowledge base. It handles the multi-user isolation problem by maintaining per-user memory graphs while allowing cross-user factual knowledge to be shared without leaking private context.

### Meta's Sparse Memory Fine-Tuning

Meta FAIR's October 2025 paper introduced a memory layer with many addressable slots, where only a small subset activates on each forward pass. When fine-tuning on new knowledge, only the slots most strongly associated with the new content are updated — leaving the vast majority of parameters untouched. This achieves targeted knowledge injection with dramatically lower forgetting risk than full fine-tuning. The approach is particularly suited to knowledge update scenarios (factual corrections, new domain expertise) rather than behavior change.

### Google's Titans + MIRAS

Google Research's Titans architecture (NeurIPS 2025) introduced neural long-term memory as a first-class component, with the companion MIRAS system enabling surprise-based memory consolidation. The system identifies which information is worth memorizing by measuring how much it deviates from model predictions — highly surprising content (new facts, unusual patterns) gets committed to long-term memory; predictable content is not stored. This echoes the hippocampal role in human memory consolidation and provides a principled mechanism for selective retention.

### Red Hat's Subspace Sculpting

Red Hat's April 2025 paper "Sculpting Subspaces: How We Solved Continual Learning in LLMs" demonstrated that careful management of the parameter subspace during fine-tuning — keeping new learning constrained to dimensions orthogonal to prior task representations — achieves near-zero forgetting on standard benchmarks. The approach generalizes across model families and was validated on production-scale models used in Red Hat's enterprise AI platform.

### Langchain's Production Recommendations

Langchain's 2025 analysis settled on a pragmatic framework for production deployments: use context-window and external memory management for user-specific adaptation (personalizing to individual users' patterns and preferences), and reserve weight-level fine-tuning for genuine capability changes (adding new domains, languages, or task types) with careful regularization. This hybrid approach separates the fast-changing (user preferences) from the slow-changing (core capabilities), applying the right tool for each.

## Evaluation: Measuring What Matters

The past year has seen significant investment in benchmarks specifically designed for continual learning in LLM agents — moving beyond static leaderboards to multi-turn, accumulative evaluation.

**MemoryAgentBench** (accepted ICLR 2026, Huazhong University) evaluates four competencies: accurate retrieval, test-time learning, long-range understanding, and selective forgetting. It reformats existing datasets into incremental multi-turn interaction streams that simulate realistic accumulation over weeks of agent use — closer to production conditions than single-session benchmarks.

**MemoryBench** (October 2025) is the first benchmark designed to evaluate continual learning from user feedback logs — making it the most production-realistic evaluation to date. It captures the specific challenge of agents that learn from implicit signals (which responses users accepted, corrected, or ignored) rather than explicit training examples.

**Evo-Memory** (November 2025) structures evaluation as a sequential task stream, testing whether agents can search, adapt, and evolve their memory representation after each interaction. It explicitly measures both forward transfer (does new learning help future performance?) and backward transfer (does new learning hurt past performance?).

**MemRL: Self-Evolving Agents via Runtime Reinforcement Learning on Episodic Memory** evaluates whether agents can improve their memory policy — not just memory content — through experience, probing whether agents learn how to remember, not just what to remember.

The consensus from these benchmarks: current systems handle accurate retrieval well (retrieval-augmented approaches), struggle with long-range understanding across many sessions, and mostly fail at principled selective forgetting. The hardest problem in the benchmark suite is the same as in production: knowing what to forget.

## Key Challenges

### The Plasticity-Stability Dilemma

Every continual learning system must balance plasticity (ability to learn new things) against stability (retention of prior knowledge). There is no free lunch: more aggressive weight updates allow faster adaptation but risk more forgetting; stronger regularization reduces forgetting but limits what can be learned. In rapidly changing environments, the optimal balance shifts over time — and maintaining a dynamic balance is itself an unsolved research problem.

### Whose Data to Learn From

Multi-user agents face a fundamental privacy tension: learning from user A's interactions could improve responses for user B, but only by mixing A's private experience into shared weights. Separate per-user models eliminate this risk but are computationally and operationally infeasible at scale. The field has not converged on a solution; current best practices use per-user external memory (keeping private facts private) combined with anonymized aggregate signal for weight-level updates.

### Compute and Infrastructure Costs

Even parameter-efficient fine-tuning carries non-trivial costs when done continuously. Most production teams find that true online learning (updating weights after every interaction) is impractical — scheduled periodic retraining (daily, weekly) is the actual deployment pattern. This means agents operate with a knowledge lag: they know they don't know what happened yesterday. Managing user expectations around this lag is an underappreciated UX problem.

### Machine Unlearning and the Right to Be Forgotten

As agents accumulate user data through continual learning, deletion requests become complicated. Standard fine-tuning entangles information across all weights — removing a specific user's contribution requires approximate unlearning algorithms that may leave residual traces, or exact retraining from scratch. A 2025 ICML workshop dedicated specifically to machine unlearning underscores how active this problem is. Current approximate unlearning methods (weight rewinding, gradient ascent on target data) satisfy most regulatory requirements in practice, but certified provable unlearning remains computationally expensive. Research from late 2025 identified a disturbing property: unlearned models may still retain residual vulnerabilities that can be reactivated by subsequent fine-tuning — meaning deletion is not always durable.

### Evaluation Lag

Benchmark performance on static datasets does not reliably predict continual learning behavior in production. A model that achieves state-of-the-art on MemoryBench may still degrade badly when deployed to real users whose feedback patterns differ from benchmark construction assumptions. The field lacks production-grade evaluation infrastructure — tools that instrument real agent deployments for forward/backward transfer measurement, rather than synthetic test streams.

## Future Directions

### Biologically-Inspired Consolidation

The neuroscience of human memory offers a roadmap. Human memory consolidation involves sleep-dependent replay — hippocampal experiences replayed to neocortex during slow-wave sleep, gradually integrating episodic memories into semantic knowledge. The FOREVER framework's forgetting curve-inspired approach is an early application of this insight, but more sophisticated sleep-like offline consolidation phases for deployed agents are an active research direction. The 2026 ICLR Workshop on Memory for LLM-Based Agentic Systems (MemAgents) explicitly calls out hippocampal-neocortical consolidation mechanisms as an open research problem.

### Learned Memory Policies

Rather than hand-designing what to remember and forget, RL-trained memory management (as in A-MEM's agentic memory approach) allows agents to discover optimal memory policies from experience. Early results suggest agents find non-obvious strategies that outperform human-designed heuristics. As RL training for language agents matures (building on GRPO and related methods), learned memory management is likely to become the default for production systems — with the memory policy itself as a continuously improving component.

### Modular Knowledge Architectures

The trend toward LoRA adapters and sparse memory modules reflects a deeper architectural direction: separating "what I know" (knowledge modules) from "how I reason" (base model) and "what I remember about you" (user memory). This modular architecture allows each layer to be updated independently at different rates and with different strategies. Future agents may maintain dozens of hot-swappable knowledge modules — product information, user preferences, domain expertise — that can be updated, replaced, or deleted without touching the reasoning layer.

### Formal Continual Learning Standards

The field currently lacks standard interfaces for continual learning components — each framework invents its own memory APIs, training triggers, and forgetting mechanisms. As agent platforms mature, standardization pressure will grow. The emerging A2A (Agent-to-Agent) protocol and MCP's tool interface specifications could naturally extend to cover memory operations and knowledge transfer between agents — enabling a future where agents can share learned knowledge in a privacy-preserving way.

### Test-Time Training at Scale

Google's Titans architecture demonstrated that models can update their long-term memory parameters during inference — learning while generating, not just between generations. Scaling this to production requires careful management of compute costs and consistency guarantees (two simultaneous users shouldn't produce conflicting updates). But the direction is clear: the boundary between inference and training is dissolving. The 2026 research roadmap paper "The Future of Continual Learning in the Era of Foundation Models" identifies test-time training as one of three transformative directions alongside modular architectures and biologically-inspired consolidation.

## Implications for Agent Platform Design

For teams building AI agent platforms in 2026, continual learning is moving from a nice-to-have to a core architectural concern. Several design decisions made early in platform development either enable or foreclose later continual learning capabilities:

**Context management is a prerequisite.** Effective continual learning in token space requires explicit, structured context management — the ability to read, write, organize, and selectively discard information from the agent's accessible state. Platforms built on stateless request-response patterns cannot be retrofitted for this without significant rearchitecting.

**Memory isolation must be designed in.** Multi-tenant platforms that commingle user data in shared context or shared fine-tuning batches create privacy problems that are hard to remediate later. Per-user memory isolation should be a first-class design constraint.

**Weight-level and context-level learning require different infrastructure.** Context-level learning (updating external memory, curating prompts) can run in the same process as inference with minimal overhead. Weight-level learning (fine-tuning, adapter training) requires a separate training pipeline, evaluation infrastructure, and deployment workflow. Building both as first-class capabilities requires investment; retrofitting one approach after shipping with the other is costly.

**Evaluation must be continuous.** A model that improves on new tasks while quietly regressing on old ones will erode user trust faster than a model that never improves. Continuous backward transfer evaluation — checking that existing capabilities are preserved after every update — is the runtime health check that continual learning requires.

The fundamental promise of continual learning is agents that get better with use — that genuinely accumulate expertise over their operational lifetime rather than remaining static snapshots of their training date. Delivering on that promise in production is the defining engineering challenge of the 2026 generation of AI agent platforms.

---

## References

1. Kirkpatrick, J. et al. (2017). "Overcoming Catastrophic Forgetting in Neural Networks." *PNAS*. https://www.pnas.org/doi/10.1073/pnas.1611835114
2. Arxiv (2403.05175). "Continual Learning and Catastrophic Forgetting." https://arxiv.org/abs/2403.05175
3. Arxiv (2504.01241). "Catastrophic Forgetting in LLMs: A Comparative Analysis Across Language Tasks." https://arxiv.org/abs/2504.01241
4. Arxiv (2511.01093). "Continual Learning, Not Training: Online Adaptation For Agents." https://arxiv.org/abs/2511.01093
5. Arxiv (2501.07278). "Lifelong Learning of Large Language Model based Agents: A Roadmap." https://arxiv.org/abs/2501.07278
6. Behrouz, A. et al. (2025). "Titans: Learning to Memorize at Test Time." *NeurIPS 2025*. https://arxiv.org/abs/2501.00663
7. Google Research. "Titans + MIRAS: Helping AI Have Long-Term Memory." https://research.google/blog/titans-miras-helping-ai-have-long-term-memory/
8. Wang et al. (2025). "CSUR 2025: Continual Learning of Large Language Models: A Comprehensive Survey." https://github.com/Wang-ML-Lab/llm-continual-learning-survey
9. Red Hat Developer. "Sculpting Subspaces: How We Solved Continual Learning in LLMs." https://developers.redhat.com/articles/2025/04/04/sculpting-subspaces-how-we-solved-continual-learning-llms
10. OpenReview (RXvFK5dnpz). "Contextual Experience Replay for Continual Learning of Language Agents." ICLR 2025. https://openreview.net/forum?id=RXvFK5dnpz
11. Arxiv (2511.22367). "SuRe: Surprise-Driven Prioritised Replay for Continual LLM Learning." https://arxiv.org/pdf/2511.22367
12. Arxiv (2601.03938). "FOREVER: Forgetting Curve-Inspired Memory Replay for Language Model Continual Learning." https://arxiv.org/html/2601.03938v1
13. Arxiv (2510.15416). "Adaptive Minds: Empowering Agents with LoRA-as-Tools." https://arxiv.org/html/2510.15416v1
14. Arxiv (2510.25093). "Continual Low-Rank Adapters for LLM-based Agents." https://arxiv.org/pdf/2510.25093
15. Arxiv (2504.13407). "LoRA-Based Continual Learning with Constraints on Critical Parameter Changes." https://arxiv.org/html/2504.13407v1
16. Sakana AI. "Instant LLM Updates with Doc-to-LoRA and Text-to-LoRA." https://pub.sakana.ai/doc-to-lora/
17. Arxiv (2502.12110). "A-MEM: Agentic Memory for LLM Agents." https://arxiv.org/abs/2502.12110
18. Arxiv (2601.18510). "Just-In-Time Reinforcement Learning: Continual Learning in LLM Agents Without Gradient Updates." https://arxiv.org/html/2601.18510
19. Arxiv (2512.13564). "Memory in the Age of AI Agents: A Survey." https://arxiv.org/abs/2512.13564
20. Arxiv (2603.07670). "Memory for Autonomous LLM Agents: Mechanisms, Evaluation, and Emerging Frontiers." https://arxiv.org/html/2603.07670v1
21. Arxiv (2507.05257). "Evaluating Memory in LLM Agents via Incremental Multi-Turn Interactions (MemoryAgentBench)." ICLR 2026. https://arxiv.org/abs/2507.05257
22. Arxiv (2510.17281). "MemoryBench: A Benchmark for Memory and Continual Learning in LLM Systems." https://arxiv.org/abs/2510.17281
23. Arxiv (2511.20857). "Evo-Memory: Benchmarking LLM Agent Test-Time Learning with Self-Evolving Memory." https://arxiv.org/html/2511.20857v1
24. Langchain Blog. "Continual Learning for AI Agents." https://blog.langchain.com/continual-learning-for-ai-agents/
25. Letta Blog. "Continual Learning in Token Space." https://www.letta.com/blog/continual-learning
26. Letta GitHub. "learning-sdk: Drop-in SDK for Continual Learning and Long-Term Memory." https://github.com/letta-ai/learning-sdk
27. Arxiv (2512.12818). "Hindsight is 20/20: Building Agent Memory that Retains, Recalls, and Reflects." https://arxiv.org/html/2512.12818v1
28. OpenReview (U51WxL382H). "ICLR 2026 Workshop Proposal MemAgents: Memory for LLM-Based Agentic Systems." https://openreview.net/pdf?id=U51WxL382H
29. Arxiv (2512.18035). "Towards Benchmarking Privacy Vulnerabilities in Selective Forgetting with Large Language Models." https://arxiv.org/html/2512.18035
30. Cameron Wolfe. "Continual Learning with RL for LLMs." https://cameronrwolfe.substack.com/p/rl-continual-learning
31. Arxiv (2506.03320). "The Future of Continual Learning in the Era of Foundation Models: Three Key Directions." https://arxiv.org/html/2506.03320v1
32. Beam.ai. "What is Continual Learning (and Why It Powers Self-Learning AI Agents)." https://beam.ai/agentic-insights/what-is-continual-learning-(and-why-it-powers-self-learning-ai-agents)
33. Adaline Labs. "The AI Research Landscape in 2026: From Agentic AI to Embodiment." https://labs.adaline.ai/p/the-ai-research-landscape-in-2026
34. Yodaplus Technologies. "Continual Learning in Agent Workflows: Methods and Challenges." https://yodaplus.com/blog/continual-learning-in-agent-workflows-methods-and-challenges/
35. Technology.org. "Building Self-Improving AI Agents: Techniques in Reinforcement Learning and Continual Learning." https://www.technology.org/2026/03/02/self-improving-ai-agents-reinforcement-continual-learning/
