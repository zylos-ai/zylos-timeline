---
date: "2026-03-10"
title: "AI Agent Fork-Merge Patterns: Parallel Cognition and Result Convergence"
description: "How AI agents fork into parallel cognitive streams and merge results back — patterns, frameworks, challenges, and the path toward elastic cognition."
tags: ["ai-agents", "multi-agent", "parallel-processing", "fork-merge", "cognitive-architecture", "distributed-systems"]
---

## Executive Summary

The dominant mental model of an AI agent — a single, sequential reasoner that processes one thought at a time — is rapidly giving way to something richer. Modern agent frameworks increasingly allow a single agent identity to split into parallel cognitive streams, each pursuing an independent line of reasoning or execution, and then reconverge into a unified result. This fork-merge pattern is not a novelty; it is the same fundamental structure that made MapReduce scale web-sized datasets, that powers multi-core processors, and that underlies the human brain's parallel perceptual systems. What is new is its application to autonomous language-model agents operating over open-ended reasoning tasks.

The payoff is significant. Anthropic's internal research system demonstrated a 90.2% performance improvement over a single Claude Opus 4 instance by deploying a lead agent that spawns 3–5 parallel subagents, each with its own isolated context window. OpenAI's Agents SDK supports fan-out/fan-in patterns via `asyncio.gather`. Devin 2.0 allows one AI software engineer to dispatch parallel sub-tasks to sibling instances. These are not experiments — they are production systems shipping today. The pattern has crossed the line from research curiosity to engineering practice.

Yet fork-merge architectures introduce their own class of problems. Context windows balloon. Costs scale superlinearly with agent count. Divergent reasoning paths produce results that must be reconciled without a ground truth. And the deeper question — how do you merge not just outputs but the intermediate reasoning state that produced them — remains largely unsolved. The field has strong forking primitives and weak merging primitives.

This article maps the current landscape: where fork-merge patterns come from, how they manifest in agent architectures today, what frameworks support them, what problems remain open, and where the research trajectory points. The goal is to give practitioners a clear-eyed view of both the power and the limits of parallel cognition for AI agents.

---

## The Fork-Merge Paradigm

### Origins in Distributed Computing

Fork-merge is one of the oldest ideas in parallel computing. Unix's `fork()` system call, introduced in 1969, creates an identical copy of a running process that then executes independently. MapReduce, published by Google in 2004, formalized the pattern for large-scale data: a **map** phase distributes work across independent workers, and a **reduce** phase aggregates their outputs into a final result. The key insight — that many problems can be expressed as embarrassingly parallel map operations followed by a single aggregation — proved so powerful that it scaled to petabytes of data and became the architectural backbone of the modern web.

The actor model, developed by Carl Hewitt in 1973, offers a complementary framing: computation is organized as independent actors with private state, communicating only by message passing. No shared memory, no direct coupling. Microsoft's AutoGen framework adopted this model explicitly, allowing agent instances to live on different machines and communicate asynchronously through an event bus — solving what the AutoGen team calls the "spaghetti code problem" of direct agent-to-agent wiring.

A third ancestor is speculative execution, a CPU optimization technique where a processor begins executing instructions before confirming they are actually needed. If the speculation is correct, latency is hidden; if not, the work is discarded. This concept reappears in modern AI agent research as **speculative actions** — having a faster, cheaper model predict and tentatively execute the next steps while a slower, more powerful model verifies them in parallel (see [Speculative Actions, arXiv 2510.04371](https://arxiv.org/abs/2510.04371)).

### Why Fork-Merge Matters for Agents

Sequential reasoning has a hard latency floor: each step must complete before the next begins. For complex tasks — research across many documents, multi-codebase analysis, multi-hypothesis scientific reasoning — this is prohibitive. Parallelism breaks the floor.

But agents are not simple functions. They carry **context**: conversation history, tool call logs, intermediate reasoning. Forking an agent is not just spawning a process — it implies copying or partitioning that context. And merging agents is not just concatenating outputs — it may require reconciling divergent beliefs, facts, and plans accumulated during independent execution. This makes agent fork-merge qualitatively harder than distributed batch processing, and qualitatively more interesting.

---

## Forking Patterns for AI Agents

### 1. Task-Parallel (Fan-Out / Fan-In)

The most common and well-understood pattern. An orchestrator agent decomposes a task into independent sub-tasks and assigns each to a separate worker agent. Workers execute concurrently. The orchestrator collects their outputs and synthesizes a final response.

```
Orchestrator
    ├── SubAgent A: "research topic X"
    ├── SubAgent B: "research topic Y"
    └── SubAgent C: "research topic Z"
         ↓ (all complete)
Orchestrator: synthesize A + B + C → final answer
```

This is the architecture behind Anthropic's multi-agent research system ([how we built it](https://www.anthropic.com/engineering/multi-agent-research-system)), where a lead Claude Opus 4 agent spawns 3–5 Claude Sonnet subagents, each exploring a different facet of a research query. Each subagent has its own isolated context window, preventing the cross-contamination that would occur if all agents shared a single context. The orchestrator receives only the subagents' distilled outputs — not their full reasoning traces — keeping the orchestrator's context manageable.

OpenAI's Agents SDK makes this pattern explicit with its fan-out/fan-in documentation: run multiple specialized agents simultaneously with `asyncio.gather`, then pass all results to a final synthesis agent. The cookbook example uses portfolio analysis: a market analyst, a fundamental analyst, and a sentiment analyst run in parallel, and their outputs flow into a final recommendation agent ([Parallel Agents with the OpenAI Agents SDK](https://cookbook.openai.com/examples/agents_sdk/parallel_agents)).

### 2. Debate / Adversarial Forking

Rather than decomposing a task spatially, debate patterns fork an agent into multiple instances that independently reason about the **same** problem and then argue toward convergence. The canonical paper is ["Improving Factuality and Reasoning in Language Models through Multiagent Debate"](https://arxiv.org/abs/2305.14325) (Du et al., 2023), which showed that having multiple LLM instances propose answers, then read and critique each other's responses over several rounds, consistently improved factuality and reasoning quality over single-agent baselines.

Key variants include:

- **Homogeneous debate**: identical model instances start with the same prompt and diverge through stochastic sampling. Useful for finding consensus among equivalent reasoners.
- **Heterogeneous debate**: different models or differently-prompted instances bring genuinely different perspectives. [Adaptive heterogeneous multi-agent debate (A-HMAD)](https://link.springer.com/article/10.1007/s44443-025-00353-3) extends this with dynamic debate strategies across specialized agents.
- **Adversarial / FREE-MAD**: [FREE-MAD](https://arxiv.org/abs/2509.11035) departs from consensus-seeking entirely, instructing agents to update their beliefs only when they have clear evidence they are wrong, rather than socially converging toward whatever the majority believes. This combats "sycophantic convergence" where agents simply agree to agree.

The challenge with debate patterns is distinguishing productive disagreement from noise, and knowing when to stop. [Multi-Agent Debate with Adaptive Stability Detection](https://arxiv.org/abs/2510.12697) addresses this with a time-varying Beta-Binomial mixture model that detects when the debate has stabilized and halts it automatically.

### 3. Speculative / Hypothesis Forking

Inspired by speculative execution in hardware, hypothesis forking runs multiple continuations of an agent's reasoning in parallel without knowing in advance which is correct. The winning branch is selected — and the losing branches are discarded — based on evaluation criteria that may only become available later.

This appears in reasoning frameworks as **Tree of Thoughts** (ToT, [Yao et al., 2023](https://www.promptingguide.ai/techniques/tot)), where a language model explores multiple reasoning branches simultaneously and uses a value function to prune inferior paths. ToT is strictly hierarchical — branches never exchange information laterally. **Graph of Thoughts** (GoT, [Besta et al., AAAI 2024](https://ojs.aaai.org/index.php/AAAI/article/view/29720)) generalizes this by allowing thoughts to have multiple parents (merge) and multiple children (fork), enabling dynamic-programming-style reasoning where subproblem solutions are shared across branches.

The [Adaptive Graph of Thoughts](https://arxiv.org/abs/2502.05078) (2025) goes further, dynamically switching between chain, tree, and graph topologies at test time based on problem complexity — an early step toward the elastic cognition vision described later.

At the agent-level (rather than token-level), speculative actions ([arXiv 2510.04371](https://arxiv.org/abs/2510.04371)) use a fast draft agent to predict and tentatively execute the most likely next actions while a more powerful verifier agent catches up asynchronously. The analogy to speculative decoding in LLM inference is exact: both trade work on discarded branches against reduced end-to-end latency on correct ones.

### 4. Hierarchical Delegation

In hierarchical patterns, a manager agent recursively delegates subtasks to sub-managers, which in turn delegate to workers. This creates a tree of agents where parallelism is available at every level. LangGraph supports this via its subgraph primitive — a subgraph is itself a stateful graph that can be embedded as a node in a parent graph, enabling nested parallelism with independent checkpointing at each level.

Devin 2.0's multi-agent architecture ([Cognition AI](https://cognition.ai/blog/devin-2)) exemplifies hierarchical delegation in practice: a top-level Devin instance plans a software project, dispatches parallel sub-tasks to sibling Devin instances (each with its own cloud IDE), monitors their progress, and integrates their outputs — effectively turning one AI software engineer into an engineering manager overseeing a parallel team.

---

## Memory and Context Merging

Forking is the easy half. The hard half is merging — reconciling divergent state accumulated by agents that have been operating independently.

### The Divergence Problem

When an agent forks, its context forks with it. Over time, each branch accumulates different tool call results, different intermediate beliefs, different facts retrieved from the world. At merge time, these beliefs may be:

- **Consistent but additive**: each agent found different facts about the same topic. Union is the right operation.
- **Overlapping with redundancy**: multiple agents found the same facts. Deduplication is required.
- **Contradictory**: agents drew incompatible conclusions from different evidence. Conflict resolution is required.
- **Incomparable**: agents reasoned about entirely different aspects of the problem. No merging is necessary — just concatenation.

Most production systems handle only the first and last cases well. The middle two — especially contradiction — remain engineering challenges.

### Merging Strategies

| Strategy | Mechanism | Best For | Weakness |
|---|---|---|---|
| Orchestrator synthesis | Orchestrator reads all subagent outputs and synthesizes | Open-ended tasks | Puts burden on orchestrator LLM |
| Voting / majority | Each agent votes; majority wins | Classification, factual Q&A | Fails when majority is wrong |
| Confidence-weighted merge | Agents report confidence; higher confidence wins | Tasks with natural confidence signal | Confidence calibration is hard |
| Blackboard / shared memory | Agents write to a shared workspace; conflict resolver adjudicates | Long-running collaborative tasks | Coordination overhead |
| CRDT-style | Merge function guaranteed to converge regardless of order | Distributed, eventually consistent | Limited to CRDT-compatible data structures |
| Adversarial debate | Agents argue until convergence | High-stakes factual correctness | Slow; risk of sycophantic convergence |

**Blackboard architecture** ([arXiv 2507.01701](https://arxiv.org/abs/2507.01701), [arXiv 2510.01285](https://arxiv.org/abs/2510.01285)) is particularly interesting for long-running fork-merge workflows. A central shared memory stores all agent-generated messages, intermediate inferences, and interaction histories. A dedicated **conflict-resolver agent** detects contradictions, triggers private debate between the conflicting agents, and writes the resolved conclusion back to the blackboard. A separate **cleaner agent** removes redundant messages to manage token costs. This is closer to a full merge protocol than simple output aggregation.

**CRDT-inspired approaches** are theoretically attractive but practically limited. CRDTs (Conflict-free Replicated Data Types) guarantee that any two replicas, updated independently, can always be merged to the same final state — as long as operations are commutative, associative, and idempotent ([crdt.tech](https://crdt.tech/)). For structured agent outputs — lists of findings, sets of conclusions, version-tracked beliefs — CRDT semantics can be applied directly. But LLM-generated free text is not a CRDT, so this approach requires imposing structured output schemas on agents before they fork.

### Context Budget Management

A critical practical constraint: merging many agents' full context histories into an orchestrator's context window is catastrophically expensive. Anthropic's engineering team found that multi-agent systems use approximately 15x more tokens than single-agent chat interactions ([context window problem](https://factory.ai/news/context-window-problem)). Communication complexity grows roughly as O(n²) with agent count.

The standard mitigation is **summarization before return**: each subagent summarizes its findings into a compact structured output before returning to the orchestrator. The orchestrator never sees the subagent's internal reasoning trace — only its conclusions. This is analogous to a function returning a value, not its stack frame. The Claude Agent SDK implements this explicitly: subagents "send only relevant information back to the orchestrator, making them ideal for tasks that require sifting through large amounts of information" ([Claude Agent SDK docs](https://platform.claude.com/docs/en/agent-sdk/subagents)).

---

## Existing Frameworks and Implementations

### LangGraph

[LangGraph](https://docs.langchain.com/langgraph-platform/autogen-integration) represents agent workflows as nodes in a directed graph, with edges that can be conditional or parallel. Its core fork-merge primitive is the **fan-out / fan-in** pattern: a node can send to multiple downstream nodes in parallel, and a downstream "join" node waits for all upstream results before executing. Each subgraph maintains independent checkpointed state, enabling fault-tolerant parallel execution with resume capability. LangGraph is the most explicit about workflow topology among current frameworks — you specify the graph structure declaratively and LangGraph handles parallelism automatically.

### AutoGen (Microsoft)

[AutoGen](https://github.com/microsoft/autogen) implements the actor model: agents are independent actors with private state communicating via asynchronous message passing. This makes it natural to distribute agents across machines and run them in parallel. AutoGen Core provides low-level control over agent topology; AutoGen Studio provides a higher-level interface. The actor model means AutoGen handles network partitions gracefully — agents continue executing independently when communication is interrupted, then catch up when connectivity restores.

### CrewAI

[CrewAI](https://www.crewai.com/) takes a role-based approach: agents are defined by role, goal, and backstory, and organized into crews with sequential or parallel task execution. Parallel execution in CrewAI is at the task level — tasks marked as independent run concurrently. CrewAI's higher-level abstraction makes it easy to build role-differentiated teams but provides less control over forking topology than LangGraph.

### OpenAI Agents SDK

[OpenAI's Agents SDK](https://openai.github.io/openai-agents-python/) supports two multi-agent patterns: **agent-as-tool** (a central agent calls sub-agents as tools) and **handoff** (agents transfer control to each other). Parallel execution is achieved through Python's `asyncio.gather`, which the SDK explicitly supports. Parallel tool calling — where the model requests multiple tool calls simultaneously and they execute concurrently — is enabled by default. This is a clean primitive for fork-merge at the tool level.

### LLMxMapReduce (THUNLP)

[LLMxMapReduce](https://arxiv.org/abs/2410.09342) is perhaps the most direct translation of classical MapReduce to LLM agents. The framework divides long documents into chunks, processes each chunk with a separate LLM instance (map), and aggregates intermediate answers with a structured information protocol and confidence calibration mechanism (reduce). Version 2 introduces entropy-driven convolutional scaling to improve global coherence across chunks. Version 3 extends to a fully self-organized multi-agent system for academic survey generation. This framework excels at the specific problem of processing documents longer than any single context window.

### Anthropic's Multi-Agent Research System

[Anthropic's research system](https://www.anthropic.com/engineering/multi-agent-research-system) is the most documented production fork-merge deployment. Architecture: one Claude Opus 4 lead agent, 3–5 Claude Sonnet 4 subagents running in parallel, each with isolated context. Subagents receive a structured brief (objective, output format, tool guidance, task boundaries) and return a structured report. The lead agent synthesizes. Two levels of parallelism: inter-agent (multiple subagents) and intra-agent (each subagent makes 3+ tool calls in parallel). Result: 90.2% improvement over single-agent Opus 4 on internal research evaluations.

### Speculative Actions Framework

[Speculative Actions](https://arxiv.org/abs/2510.04371) (2025) applies speculative execution to agentic tasks. A fast draft agent predicts and tentatively executes the most likely next actions; a slower, more accurate verifier catches up. Correct predictions reduce latency by hiding verification time. Wrong predictions require rollback — the framework tracks reversible vs. irreversible actions and applies speculation only to reversible ones. This is fork-merge at the single-step level, happening continuously throughout an agent's execution.

---

## Challenges and Open Problems

### 1. Context Explosion

The most immediate production problem. A naive fork-merge system propagates full context from parent to child and child back to parent. With 5 subagents each accumulating 50k tokens of history, the orchestrator's merge step processes 250k tokens of subagent output on top of its own history. Token costs at $15/M tokens become prohibitive quickly. Current mitigations — summarization, structured output schemas, context pruning — help but introduce their own problems: summarization loses detail, schemas constrain agent flexibility, pruning may discard evidence that later proves important.

### 2. Merge Conflicts and Consistency

When two agents make factual claims that contradict each other, who is right? Simple heuristics — prefer higher confidence, prefer more recent information, prefer the agent with domain-specific instructions — fail in cases where both agents are plausibly correct about different facets of an ambiguous question. The blackboard conflict resolver approach is promising but adds coordination overhead. There is no general solution yet.

### 3. Rollback and Fault Isolation

If a subagent fails mid-execution — due to a tool error, rate limit, or hallucination spiral — the orchestrator needs a recovery strategy. Options: retry the subagent, substitute a cached result, proceed with partial output, or abort and re-plan. LangGraph's checkpointing provides restart capability, but decisions about what to retry and when are application-specific. Speculative Actions' distinction between reversible and irreversible actions is a step toward principled fault handling, but the general problem of transactional semantics for agent workflows remains open.

### 4. Consistency Guarantees

In distributed databases, systems choose between strong consistency (all reads see the latest write, at the cost of coordination overhead) and eventual consistency (replicas converge over time, at the cost of stale reads). Agent fork-merge systems face an analogous tradeoff. Debate-based convergence is a form of eventual consistency — agents will eventually agree, but may act on inconsistent beliefs in the interim. Orchestrator-gated synthesis is stronger but serializes the merge step.

### 5. Cost Superlinearity

Communication complexity in a fully-connected agent network grows as O(n²). Even in hub-and-spoke topologies (one orchestrator, n workers), orchestration overhead grows with n. Production deployments at Anthropic found that multi-agent systems use ~15x more tokens than chat, and the cost multiplier grows with task complexity and agent count. This creates a practical ceiling on fork width — beyond 5–10 parallel agents, costs frequently outpace the value of additional parallelism for most tasks.

### 6. The Shadow Clone Problem

There is no clean abstraction for an agent forking a copy of **itself** — its full identity, reasoning style, memory, and current context — as opposed to spawning a specialized subagent with a different role. The "shadow clone" mental model (分身, bunsin) implies the clone is a true peer, not a subordinate, and that its accumulated experience during parallel execution should be fully reintegrated at merge time. This requires context merge, not just output merge. Nobody has solved this cleanly for long-running agents with rich internal state.

---

## Toward Elastic Cognition

The ultimate vision is an agent whose cognitive resources scale dynamically to task complexity — expanding to many parallel cognitive streams for hard problems, contracting to a single stream for simple ones. Call it **elastic cognition**: the agent treats its own parallelism as a tunable parameter, not a fixed architectural choice.

The ingredients are visible in current research even if no system assembles them fully yet:

**Dynamic topology selection**: [Adaptive Graph of Thoughts](https://arxiv.org/abs/2502.05078) (2025) already switches between chain, tree, and graph reasoning topologies at test time. The extension to agent-level topology — dynamically choosing between a single agent, a debate pair, a parallel fan-out, or a hierarchical tree — is a natural next step.

**Speculative over-generation with selective commitment**: Rather than planning a fork topology in advance, an agent could speculatively spawn multiple parallel continuations and commit only to the one that proves most valuable, discarding the rest. This is expensive but feasible when tasks are high-value and the winning branch can be identified cheaply.

**Adaptive compute routing**: Similar to mixture-of-experts models that activate only relevant expert sub-networks per input token, agent orchestrators could route tasks to different fork-merge topologies based on estimated complexity — lightweight single-agent for simple queries, full parallel fan-out for complex research. The [Adaptive and Resource-efficient Agentic AI Systems](https://arxiv.org/abs/2510.00078) survey (2025) explores this direction for mobile and edge deployments.

**Memory-efficient forking via copy-on-write**: Rather than copying full context at fork time, a system could use copy-on-write semantics — forked agents share context read-only until they diverge, at which point only the deltas are stored. This is conceptually clean but requires vector databases or structured memory systems that support diff-based storage, not the flat token sequences that current LLMs consume.

**Convergence as a first-class operation**: Current frameworks treat merging as an afterthought — dump outputs into an orchestrator prompt and hope the LLM synthesizes well. A mature elastic cognition system would have a dedicated merge layer with type-aware conflict resolution, CRDT semantics for structured data, debate protocols for contested factual claims, and confidence propagation from source to synthesis.

The economic constraint is real but not permanent. As inference costs continue to fall — consistent with historical trends in compute pricing — the cost-benefit calculation for wide parallel fork-merge shifts. Tasks that are today too expensive to run with 10 parallel agents may be routine with 50 agents in three years.

---

## Implications for Agent Architecture

### Design Principles

**Design for isolated context from the start.** Each subagent should have a bounded, purposeful context window — a structured brief, not a dump of the orchestrator's history. The subagent's output should be a structured report, not a raw response. Define the interface between forked and joined agents as explicitly as you would an API.

**Prefer reversible actions in speculative branches.** When forking speculatively, restrict early branches to actions that can be rolled back: reads, computations, drafts. Commit irreversible actions (writes, API mutations, communications) only after the branch is confirmed by the join step.

**Make merge the primary design decision.** It is tempting to focus on fork topology — how many agents, what specializations — because that is where the performance gains are visible. But the merge strategy determines the quality of the final output. Decide your merge strategy first: synthesis by orchestrator, voting, blackboard, debate. Then design your fork topology to produce outputs that your merge strategy can handle.

**Budget tokens at the architecture level.** Token costs are a first-class architectural constraint, not an afterthought. For each fork level, compute the expected token cost of subagent execution plus the orchestrator's merge cost. Structure subagent outputs to be as compact as possible consistent with the information the orchestrator needs. Consider whether the orchestrator needs subagent reasoning traces or just conclusions.

**Use debate for high-stakes, synthesis for throughput.** Debate patterns are expensive and slow but improve correctness for contested factual claims. Synthesis (orchestrator reads all outputs and writes a final answer) is faster and cheaper but depends heavily on the orchestrator model's judgment. Choose based on the error tolerance of your application.

### Architectural Patterns Summary

| Pattern | When to Use | Merge Strategy | Key Risk |
|---|---|---|---|
| Fan-out / fan-in | Independent subtasks, time-critical | Orchestrator synthesis | Context explosion at merge |
| Debate | High-stakes factual correctness | Consensus / voting | Sycophantic convergence |
| Speculative fork | Uncertain next step, reversible actions | Winner-take-all | Wasted compute on losing branches |
| Hierarchical delegation | Complex multi-stage tasks | Level-by-level synthesis | Coordination overhead multiplied across levels |
| Blackboard | Long-running, many agents, structured data | Conflict resolver agent | Requires schema discipline |
| MapReduce (LLMxMapReduce) | Document-length inputs exceeding context | Structured reduce with confidence calibration | Chunk boundary artifacts |

---

## References

- Du, Y., et al. (2023). [Improving Factuality and Reasoning in Language Models through Multiagent Debate](https://arxiv.org/abs/2305.14325). arXiv:2305.14325.
- Yao, S., et al. (2023). [Tree of Thoughts: Deliberate Problem Solving with Large Language Models](https://www.promptingguide.ai/techniques/tot). NeurIPS 2023.
- Besta, M., et al. (2024). [Graph of Thoughts: Solving Elaborate Problems with Large Language Models](https://ojs.aaai.org/index.php/AAAI/article/view/29720). AAAI 2024.
- Besta, M., et al. (2024). [Demystifying Chains, Trees, and Graphs of Thoughts](https://arxiv.org/abs/2401.14295). arXiv:2401.14295.
- Chen, Z., et al. (2024). [LLM×MapReduce: Simplified Long-Sequence Processing using Large Language Models](https://arxiv.org/abs/2410.09342). arXiv:2410.09342. [GitHub](https://github.com/thunlp/LLMxMapReduce).
- Anonymous. (2025). [Speculative Actions: A Lossless Framework for Faster Agentic Systems](https://arxiv.org/abs/2510.04371). arXiv:2510.04371.
- Anonymous. (2025). [Adaptive Graph of Thoughts: Test-Time Adaptive Reasoning Unifying Chain, Tree, and Graph](https://arxiv.org/abs/2502.05078). arXiv:2502.05078.
- Anonymous. (2025). [Multi-Agent Debate for LLM Judges with Adaptive Stability Detection](https://arxiv.org/abs/2510.12697). arXiv:2510.12697.
- Cui, Y., et al. (2025). [FREE-MAD: Consensus-Free Multi-Agent Debate](https://arxiv.org/abs/2509.11035). arXiv:2509.11035.
- Anonymous. (2025). [Exploring Advanced LLM Multi-Agent Systems Based on Blackboard Architecture](https://arxiv.org/abs/2507.01701). arXiv:2507.01701.
- Anonymous. (2025). [LLM-based Multi-Agent Blackboard System for Information Discovery in Data Science](https://arxiv.org/abs/2510.01285). arXiv:2510.01285.
- Anonymous. (2025). [Stop Wasting Your Tokens: Towards Efficient Runtime Multi-Agent Systems](https://arxiv.org/abs/2510.26585). arXiv:2510.26585.
- Anonymous. (2025). [Adaptive and Resource-efficient Agentic AI Systems for Mobile and Embedded Devices](https://arxiv.org/abs/2510.00078). arXiv:2510.00078.
- Anthropic Engineering. (2025). [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system).
- Anthropic. (2025). [Subagents in the Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/subagents).
- OpenAI. (2025). [Parallel Agents with the OpenAI Agents SDK](https://cookbook.openai.com/examples/agents_sdk/parallel_agents).
- Cognition AI. (2025). [Devin 2.0](https://cognition.ai/blog/devin-2).
- Kleppmann, M. (2016). [Conflict resolution for eventual consistency](https://martin.kleppmann.com/2016/11/03/code-mesh.html).
- crdt.tech. [About CRDTs — Conflict-free Replicated Data Types](https://crdt.tech/).
- Factory.ai. (2025). [The Context Window Problem: Scaling Agents Beyond Token Limits](https://factory.ai/news/context-window-problem).
- LangChain Docs. [How to integrate LangGraph with AutoGen, CrewAI, and other frameworks](https://docs.langchain.com/langgraph-platform/autogen-integration).
- Frontiers in Psychology. (2022). [Dual Process Theory: Embodied and Predictive; Symbolic and Classical](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2022.805386/full).
