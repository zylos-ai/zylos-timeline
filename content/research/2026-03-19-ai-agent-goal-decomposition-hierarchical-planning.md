---
date: "2026-03-19"
title: "AI Agent Goal Decomposition and Hierarchical Planning"
description: "How AI agents break down complex goals into executable sub-tasks: hierarchical task networks, plan-execute patterns, replanning strategies, and their application to multi-layer agent architectures"
tags:
  - ai-agents
  - planning
  - task-decomposition
  - hierarchical-planning
  - agent-architecture
---

## Executive Summary

- Goal decomposition is the foundational mechanism by which AI agents translate high-level user intent into sequences of executable actions — without it, LLMs remain reactive responders rather than autonomous agents
- Two primary execution patterns dominate: **Plan-then-Execute** (upfront planning, then isolated execution) and **Interleaved/ReAct** (reasoning and action woven together in a loop), each with distinct tradeoffs in predictability, adaptability, and security
- Hierarchical Task Networks (HTN) from classical AI are being rediscovered as a structuring principle for LLM agents — enabling localized replanning, parallel sub-task execution, and modular failure recovery
- Modern systems like OpenAI's o-series and Claude's extended thinking embed planning directly inside the model's inference loop, blurring the line between reasoning and planning
- Multi-layer architectures (Session / Governor / Executor) map naturally onto planning theory: the Governor layer performs intent classification and high-level decomposition, while the Executor operates within pre-approved capability envelopes

---

## Introduction

When a user says "prepare a competitor analysis report and schedule a briefing for the team," they are expressing a goal, not a procedure. Translating that goal into a concrete sequence of tool calls, API requests, file writes, and calendar events is the core problem of **AI agent planning**.

For single-turn LLM interactions, this gap rarely surfaces. The model generates a response and stops. But as agents take on tasks that span minutes, hours, or days — tasks requiring dozens of intermediate steps, conditional branches, and coordination across systems — the absence of an explicit planning layer becomes a critical failure mode.

The field has converged on a set of complementary techniques: task decomposition strategies that break goals into sub-tasks, hierarchical planning structures that organize those sub-tasks into manageable trees, execution patterns that govern how plans interact with real-world feedback, and replanning mechanisms that handle the inevitable divergence between plans and reality.

This article surveys the state of the art across all these dimensions, traces the evolution from early autonomous agents (AutoGPT, BabyAGI) through modern framework implementations, and examines the architectural implications for Governor-style approval layers in multi-tier agent systems.

---

## 1. Goal Decomposition: From Intent to Action

### The Decomposition Problem

A "goal" in the agent sense is any instruction too complex to satisfy with a single tool call. Decomposition is the act of recursively breaking such goals into sub-tasks until every leaf is an atomic, executable operation.

The challenge is that natural language goals are underspecified by default. "Prepare a competitor analysis" leaves open: which competitors, which dimensions of analysis, what output format, what time horizon. A planning agent must either ask for clarification (escalating back to the user) or make reasonable assumptions — and ideally, know which situations call for which response.

### Decomposition Strategies

**Sequential decomposition** is the simplest form: convert the goal into an ordered list of steps. Step 1 must complete before Step 2 begins. This is effective when steps have strict dependencies but leaves parallelism on the table.

**Directed Acyclic Graph (DAG) decomposition** represents sub-tasks as nodes in a dependency graph. Tasks with no shared dependencies can execute in parallel, dramatically reducing wall-clock time for complex workflows. The dependency structure also makes failure isolation cleaner: a failing node only invalidates its downstream dependents, not the entire plan.

**Hierarchical decomposition** produces a tree of goals and sub-goals. High-level objectives are recursively refined into mid-level tasks and then primitive actions. This maps naturally onto how humans think about complex work and enables localized replanning — if a leaf node fails, only its subtree needs revision.

**Dynamic decomposition** treats the task list as a live data structure rather than a frozen plan. New tasks are created, prioritized, and inserted as prior tasks complete and reveal new information. BabyAGI popularized this pattern with its three-agent loop: execute the current task, create new tasks based on the result, reprioritize the queue.

### The Role of LLMs in Decomposition

Pre-LLM decomposition required hand-crafted domain models. LLMs change this fundamentally: they can interpret arbitrary natural language goals and generate plausible decompositions without domain-specific programming. Research shows that explicit task decomposition improves tool use accuracy from approximately 72% to 94% compared to direct execution.

The remaining challenge is decomposition quality. LLMs can generate confident but subtly wrong decomposition trees — missing a prerequisite step, creating a circular dependency, or decomposing at the wrong granularity. Verification mechanisms (discussed in Section 5) address this gap.

---

## 2. Hierarchical Task Networks (HTN)

### Classical HTN Planning

Hierarchical Task Network (HTN) planning is a formalism from classical AI that predates LLMs by decades. In HTN, a planner maintains two types of tasks:

- **Compound tasks**: High-level goals that must be decomposed into simpler sub-tasks using domain-defined *methods*
- **Primitive tasks** (operators): Leaf-level actions that can be directly executed when their preconditions are met

The planner recursively applies decomposition methods to compound tasks until only primitive tasks remain, producing an executable plan that respects domain constraints and task ordering.

### HTN + LLM Integration

The integration of HTN with LLMs yields a powerful hybrid. LLMs handle the open-ended, natural language interpretation side — converting ambiguous goals into structured compound tasks and suggesting decomposition methods. The HTN framework enforces soundness: it verifies that decomposition sequences are logically consistent and that primitive task preconditions are satisfied before execution.

Research has shown this combination can reduce LLM query frequency by up to 75% compared to fully reactive agents, since the HTN structure handles deterministic decomposition steps without consulting the LLM. LLM calls are reserved for the semantically complex decisions: interpreting novel goals, choosing between competing decomposition strategies, or handling situations the domain model didn't anticipate.

### Localized Replanning

One of HTN's most valuable properties in an agent context is **localized replanning**. When a primitive task fails, the planner doesn't need to restart from the root goal. It identifies the minimal subtree that must be revised, reruns decomposition for that subtree (potentially with updated context), and resumes execution. The rest of the plan remains intact.

This contrasts sharply with flat, linear plans where any step failure may invalidate everything downstream — a problem that compounds severely in long-horizon tasks.

### Recent Work

The 2025 paper *Enhancing LLM-Based Agents via Global Planning and Hierarchical Execution* (GoalAct) introduces a continuously updated global planning mechanism combined with a hierarchical execution strategy. It decomposes task execution into high-level skills (searching, coding, writing) that are then further refined into primitive tool calls, reducing planning complexity while maintaining global coherence.

A parallel paper, *Hierarchical LLM-Based Multi-Agent Framework* (2026), extends this to multi-agent settings where different agents own different levels of the hierarchy, with a coordinator maintaining the global plan and specialist agents owning subtrees.

---

## 3. Plan-then-Execute vs. Interleaved Execution

### The Core Tradeoff

The most fundamental design choice in agent planning is whether to separate planning from execution or interleave them.

**Plan-then-Execute (P-t-E)** generates the complete plan first — a frozen list of steps — and then executes each step in sequence, with the planner insulated from execution outputs. The plan is a contract: the executor follows it faithfully.

**Interleaved / ReAct** weaves reasoning and action together in a loop. After each action, the agent observes the result and reasons about what to do next. The "plan" is never fully materialized; it emerges step-by-step from the interaction with the environment.

### Plan-then-Execute in Depth

The P-t-E pattern, popularized by LangChain's planning agents, offers several structural advantages:

**Speed**: Once the plan is established, execution steps can run without additional planner LLM calls (or with cheaper, smaller models). The larger planning model is consulted only for (re-)planning and final synthesis.

**Cost efficiency**: Routing execution to cheaper models or deterministic code can reduce per-task costs dramatically. The Planner-Worker architecture has demonstrated up to 90% cost reduction by using frontier models only for planning and smaller models for execution.

**Predictability**: Because the plan is materialized before execution, users and governance layers can inspect it, approve it, or modify it before any real-world actions occur. This is essential for high-stakes tasks.

**Quality**: Forcing an explicit planning step causes the model to "think through" the full task before acting, which improves task completion rate versus reactive approaches.

The primary weakness of P-t-E is brittleness in dynamic environments. If the world changes between planning and execution — a resource becomes unavailable, an API returns unexpected data — the frozen plan may be incorrect or impossible to execute. This necessitates replanning triggers (see Section 5).

### ReAct: Interleaved Reasoning and Action

The ReAct framework (Yao et al., 2022) formalized the interleaved pattern. Its loop structure is:

1. **Thought**: The LLM generates an internal reasoning trace — analyzing the situation, evaluating the last step, strategizing the next
2. **Action**: Based on the thought, the LLM selects a tool call or final response
3. **Observation**: The tool result is returned to the LLM as grounding context
4. Repeat until task complete

ReAct's strength is adaptability. Each observation can change the course of action. The agent responds to a world that is always slightly different from expectations. Research shows ReAct reduces hallucinations compared to chain-of-thought alone, precisely because real-world observations ground the reasoning.

The weaknesses are equally significant. Because untrusted tool outputs directly influence future actions, ReAct agents are vulnerable to **prompt injection attacks** embedded in external content. A malicious web page's content, observed as a tool result, can redirect the agent into unintended actions. The interleaved nature also makes the control flow harder to audit and approve in advance.

### ReWOO: A Hybrid Approach

ReWOO (Reasoning WithOut Observation) separates the reasoning phase from the observation phase, generating all tool calls upfront (like P-t-E) but still allowing the plan to reference outputs from earlier steps symbolically. This achieves efficiency close to P-t-E while retaining some of the flexibility of interleaved execution. It reduces token consumption significantly because the planner doesn't need to process intermediate observations during planning.

---

## 4. Real-World Implementations

### AutoGPT

AutoGPT (2023) was one of the first widely-adopted demonstrations of autonomous goal decomposition. Given a high-level goal, AutoGPT uses GPT-4 to recursively break it into sub-tasks, then executes each sub-task using a toolkit (search, code execution, file I/O, API calls). Each iteration produces a new task list, updated based on the results of prior steps.

AutoGPT's architecture demonstrated both the promise and the problems of early autonomous agents. On well-defined goals, it could accomplish impressive multi-step tasks autonomously. On open-ended or ambiguous goals, it tended to generate circular decomposition trees, get stuck in loops, or hallucinate completed steps. These failure patterns drove the subsequent research into structured planning, HTN, and verification layers.

### BabyAGI

BabyAGI introduced a cleaner architectural separation: three dedicated agents (execution, task creation, task prioritization) running in a tight loop, with a vector database providing memory across iterations. The task creation agent explicitly generates new tasks based on execution results, implementing dynamic decomposition as a first-class architectural feature.

BabyAGI's loop is:
1. Pull the top-priority task from the task queue
2. Execute the task (execution agent)
3. Based on the result, generate new tasks (task creation agent)
4. Re-prioritize the full task queue (prioritization agent)
5. Repeat

This design made the replanning loop explicit and modular. The prioritization step also introduced the concept of **plan-level reasoning** — the agent doesn't just execute tasks in order, it continuously reassesses which tasks are most valuable to pursue.

### LangChain Plan-and-Execute

LangChain formalized the P-t-E pattern into a reusable framework component. The architecture uses:

- **Planner Agent**: Takes the user goal, generates an explicit step-by-step plan as a structured list
- **Executor Agents**: Take individual plan steps and execute them, optionally using tools
- **Replanner**: Monitors execution results and triggers plan revision when execution diverges from intent

LangGraph extended this into a stateful graph model, where the plan is represented as a graph of tasks with typed edges indicating dependencies, conditional branches, and parallel execution paths. This representation makes the plan inspectable, modifiable, and amenable to partial re-execution after failures.

### OpenAI o-Series Reasoning Models

OpenAI's o1 (released December 2024) and subsequent o3 models introduced a different paradigm: embedding planning inside the model's inference process via **extended reasoning tokens**. Before generating a visible response, the model uses a private "scratchpad" of reasoning tokens to think through the problem, explore multiple approaches, and self-correct.

For agent tasks, this means the planning phase happens implicitly before tool selection, rather than requiring explicit multi-turn planning conversations. The model can reason about which tools to use, in what order, and anticipate likely outcomes — all within a single forward pass. Reasoning depth is a tunable parameter: more reasoning tokens yield higher quality but higher latency and cost.

### Claude's Extended Thinking

Claude 3.7 Sonnet and Claude 4 models implement extended thinking as a visible feature. When enabled, Claude produces thinking blocks alongside its responses — exposing the intermediate reasoning process. In agentic contexts, thinking blocks capture step-by-step reasoning that leads to tool requests, and the reasoning state is preserved across tool calls.

This architecture enables a form of **persistent planning context**: when a tool result is returned, the model continues its reasoning from where it left off, rather than re-evaluating from scratch. The extended thinking budget can be adjusted per task, enabling cost-quality tradeoffs at query time.

---

## 5. Plan Verification, Validation, and Replanning

### Why Plans Fail

Even well-constructed plans fail for predictable reasons:

- **Missing preconditions**: A step assumes a resource or state that doesn't exist at execution time
- **Changed world state**: Conditions that held at planning time no longer hold at execution time
- **Hallucinated steps**: The planner confidently included a step that is semantically coherent but factually invalid
- **Cascading errors**: A subtask failure propagates incorrect outputs to downstream tasks, causing them to silently succeed but produce wrong results
- **Tool errors**: External APIs fail, return unexpected formats, or are temporarily unavailable

### Verification Strategies

**Self-critique / reflection**: The agent reviews its own plan or intermediate outputs, looking for logical inconsistencies, missing steps, or ambiguities. This typically uses a separate LLM call (or a chain-of-thought prompt directing the model to critique before acting). Research in 2025 shows that process reward models — giving agents feedback on each reasoning step, not just the final output — significantly improve self-checking behavior.

**Separate verifier models**: Rather than asking the same model to plan and verify, a distinct verifier model is used. The separation reduces confirmation bias and allows the verifier to apply a different evaluation perspective.

**Precondition checking**: Before executing a plan step, check that its stated preconditions are actually met. This can be done symbolically (checking API status, file existence) or semantically (asking an LLM to verify that the current state satisfies the step's requirements).

**Simulation / sandboxing**: Run the plan in a simulated environment before executing in production. Particularly valuable for plans that modify state irreversibly (deleting files, sending messages, making payments).

### Replanning Strategies

When verification reveals that a plan has failed or become invalid, the agent has three broad options:

**Local replanning (backtracking)**: Identify the minimal subtree that must change, replan only that portion, and resume. Requires HTN-style hierarchical plan representation to be efficient. Most effective when the rest of the plan remains valid.

**Full replanning**: Discard the current plan and regenerate from scratch, incorporating updated world state. Expensive but necessary when failures propagate broadly or the plan structure is fundamentally flawed.

**Checkpoint and rollback**: Before executing high-impact steps, save checkpoints (state snapshots, reversible operation logs). On failure, roll back to the last good checkpoint and try an alternative strategy. This pattern is gaining traction in 2025-2026 as agents take on higher-stakes operations.

**Graceful degradation**: When replanning is not possible (no alternative exists, resources exhausted), complete what can be completed and report partial results rather than failing entirely.

### The "35-Minute Degradation Problem"

A significant empirical finding from 2025 deployments is what practitioners call the "35-minute degradation problem" — agents that perform reliably on tasks up to approximately 35 minutes of elapsed execution time tend to degrade sharply beyond that threshold. The causes are compound: context window saturation with accumulated tool outputs, error compounding across many steps, and the absence of robust checkpointing mechanisms. This is one of the core engineering challenges being addressed in 2026 long-horizon agent research.

---

## 6. Advanced Planning Techniques: ToT, GoT, MCTS

### Tree of Thoughts (ToT)

Tree of Thoughts (Yao et al., 2023) frames problem-solving as a tree search where each node is an intermediate reasoning state. Rather than committing to a single chain of thought, ToT generates multiple candidate next steps at each node, evaluates them using a scoring function (LLM-based or heuristic), and explores the most promising branches. This allows systematic exploration of the problem space and backtracking when a branch proves unproductive.

For agent planning, ToT enables deliberate exploration of alternative plan structures before committing to execution. The agent can reason "if I take approach A, the likely consequence is X; if I take approach B, the likely consequence is Y" and choose based on that analysis.

The cost of ToT is significant: multiple LLM calls per planning step, exponential branching in the worst case. The 2025 research on **cost-awareness in tree-search LLM planning** explicitly addresses this, showing that the choice between depth-first search (DFS), breadth-first search (BFS), and MCTS has large implications for the cost-quality frontier.

### Graph of Thoughts (GoT)

Graph of Thoughts extends the tree structure by allowing thoughts to merge, branch, and form cycles — representing more complex reasoning structures than a strict tree. A thought generated in one branch can be combined with thoughts from another branch, enabling synthesis reasoning that pure tree search cannot represent.

**ThoughtSculpt** (2025) is a representative implementation: it builds an interwoven network of thoughts with iterative self-revision, using MCTS to efficiently navigate the search space. This makes it particularly effective for tasks requiring creative synthesis (writing, design) where the "best" reasoning path isn't obvious in advance.

### Monte Carlo Tree Search (MCTS) for LLM Planning

MCTS, originally developed for game-playing AI (most famously AlphaGo), has found growing application in LLM agent planning. The four phases of MCTS map naturally onto agent planning:

- **Selection**: Choose which part of the plan tree to expand, guided by an upper confidence bound (UCB) formula balancing exploration and exploitation
- **Expansion**: Generate new candidate next steps at the selected node
- **Simulation / rollout**: Estimate the value of the new node via rollout (fast LLM simulation to a terminal state or using a learned value function)
- **Backpropagation**: Update node value estimates based on rollout results

**ToolTree** (2025) applies MCTS to tool selection in LLM agents, using dual feedback from execution results and plan coherence scoring to prune the search tree. The approach significantly outperforms both greedy tool selection and flat tree-of-thought approaches on complex multi-tool tasks.

**ReKG-MCTS** demonstrates MCTS applied to knowledge graph reasoning, conceptualizing KG traversal as a planning problem where MCTS explores paths while LLMs provide semantic guidance at each decision point.

The primary constraint of MCTS in agent contexts is latency: each rollout requires LLM inference, and meaningful MCTS exploration may require hundreds of rollouts. Practical deployments use learned value functions to replace expensive rollout simulations, or limit search depth to keep latency acceptable.

---

## 7. Intent Classification and Task Routing

### The Intent-to-Plan Bridge

Between user input and plan construction lies the intent classification step: determining what the user actually wants, at what level of abstraction, and which sub-system should handle it.

Intent classification in multi-agent systems is typically hierarchical, mirroring the plan structure it serves. A first-level classifier determines the broad domain (information retrieval, code generation, data processing, external communication). A second-level classifier determines the specific action class within that domain. At each level, a confidence threshold determines whether to proceed or escalate for clarification.

When the classifier's confidence falls below a threshold, the system faces a choice: ask the user for clarification (safe but disruptive), route to a fallback general-purpose agent (slower but handles ambiguity), or make a best-effort attempt with explicit uncertainty flagging.

### Semantic vs. Rule-Based Routing

**Rule-based routing** uses deterministic pattern matching — keyword detection, regex, explicit intent taxonomy. Fast and predictable, but brittle on novel inputs.

**Semantic routing** uses embedding similarity to match user intent against a library of known intent representations. More robust to paraphrase and novel phrasing, but requires maintaining an intent embedding library and is sensitive to semantic drift.

**LLM-based routing** asks an LLM to classify the intent. Highest flexibility and most graceful handling of ambiguity, but incurs full LLM inference cost and latency. Most practical for high-value, low-frequency routing decisions.

Production systems typically layer these: rule-based routing handles high-frequency, clearly-defined intents cheaply; semantic routing handles moderate-confidence cases; LLM-based routing is the fallback for the long tail.

### Task Routing in Practice

The **orchestrator-worker** pattern is the most common multi-agent routing architecture in production. A central orchestrator receives incoming requests, classifies intent, decomposes complex requests into sub-tasks, routes each sub-task to a specialized worker agent, and synthesizes results. This maps directly onto the Planner-Executor split in plan-and-execute systems.

Workers are specialized by capability domain: a search worker, a code execution worker, a data analysis worker, a communication worker. The orchestrator's routing decision is essentially a decomposition decision: it assigns sub-tasks to the worker most capable of executing them.

---

## 8. Failure Handling: When Plans Go Wrong

### Detection Before Correction

Effective failure handling begins with detection. Common failure detection strategies:

- **Output schema validation**: Check that tool outputs match expected formats; schema violations are immediate failure signals
- **Semantic plausibility checks**: Ask an LLM to evaluate whether a result "makes sense" given the task context
- **Confidence thresholds**: When an agent's action confidence score falls below a threshold, pause and verify before proceeding
- **Timeout detection**: If a step exceeds its expected duration, investigate rather than waiting indefinitely

Partnership on AI's 2025 report on real-time failure detection in AI agents emphasizes the importance of **continuous monitoring** rather than post-hoc review — catching failures mid-plan before they compound.

### Recovery Patterns

**Retry with backoff**: For transient errors (network failures, rate limits), retry the failed operation with exponential backoff. Simple and effective for infrastructure-level failures.

**Alternative tool selection**: If a specific tool fails, switch to an equivalent alternative. A web search agent that fails with one search API can retry with another.

**Checkpoint rollback**: Revert to the most recent valid checkpoint and try a different approach. Requires that operations were logged in reversible form.

**Partial result delivery**: Complete the sub-tasks that succeeded, return partial results with explicit acknowledgment of what failed and why, rather than failing the entire task.

**Human escalation**: When all automated recovery paths are exhausted, escalate to a human with a clear description of the failure state, what was attempted, and what decision is needed.

### The Backtracking vs. Replanning Decision

Backtracking (reverting to an earlier state and exploring an alternative) is appropriate when:
- The failure is isolated to a specific subtree
- Alternative decomposition strategies exist
- The rest of the plan remains valid

Full replanning is appropriate when:
- The failure reveals fundamental assumptions in the original plan were wrong
- The world state has changed enough that the original plan structure is no longer coherent
- The failure has cascaded across multiple parts of the plan

The decision logic is itself a planning problem — which is why the 2025 research trend toward **meta-level planning** is significant. Agents increasingly maintain a model of their own planning process, enabling them to reason explicitly about when to backtrack vs. replan.

---

## 9. Cost and Latency Tradeoffs in Planning Depth

### The Planning Depth Spectrum

Planning depth — how thoroughly an agent reasons before acting — sits on a spectrum from zero (reactive, action taken immediately) to deep (exhaustive search over alternative plans before any action). Real systems must choose a point on this spectrum based on task requirements, cost constraints, and latency tolerances.

Research consistently shows that increased planning depth improves task completion quality, but with **diminishing returns** and **increasing variance in latency**. A 2025 study on dynamic reasoning costs found that while agents improve accuracy with increased compute, they suffer from rapidly diminishing returns and widening latency variance — the same additional thinking tokens that improve one task may have no effect on another.

### Token Budgeting

Modern reasoning models expose planning depth as a directly tunable parameter through token budgets. Claude's extended thinking budget and OpenAI's reasoning token allocation allow developers to specify how much "thinking" the model should do before responding.

The practical guidance emerging from production deployments:

- **Low-stakes, high-frequency tasks**: Minimize planning depth; use fast reactive patterns; small cheap models
- **Medium-stakes tasks**: Use P-t-E with moderate planning; reserve frontier model calls for the planning step; use specialized models for execution
- **High-stakes, rare tasks**: Use deep planning (ToT/MCTS); invest in verification; build in human approval checkpoints; cost is secondary

Google's Gemini Robotics team formalizes this as a **flexible thinking budget** that routes queries by complexity: reactive tasks bypass the planning layer entirely (rule-based response), reasoning tasks invoke the full planning stack with an appropriate token budget.

### The Triangular Dilemma

Agent planning economics face a fundamental trilemma among computing power (token spend), time (latency), and quality (task completion rate). Optimizing for any two comes at cost to the third:

- High quality + low latency = high compute cost
- High quality + low cost = high latency (must use smaller models with more iterations)
- Low cost + low latency = lower quality (shallow reasoning, fewer verification passes)

Production systems manage this by decomposing tasks and applying different tradeoff configurations to different sub-tasks based on their contribution to overall task quality and their sensitivity to errors.

---

## 10. Implications for Multi-Layer Agent Architectures

### The Session-Governor-Executor Model

The Session-Governor-Executor (SGE) architecture partitions agent responsibilities across three layers with distinct capabilities and trust levels:

- **Session**: Handles user interaction, basic request parsing, immediate simple responses. Limited tool access.
- **Governor**: Approves task/intent escalation, classifies capability requirements, authorizes execution within pre-defined capability bundles. Does not approve specific tool calls.
- **Executor**: Autonomously selects and executes tools within the Governor-approved capability envelope.

Planning theory maps cleanly onto this architecture.

### Governor as the Planning Layer

The Governor layer is architecturally the planning layer. Its responsibilities directly correspond to planning functions:

**Intent classification**: Determine what the user wants and which capability domain it belongs to. This is the decomposition root — the starting node of the task tree.

**Capability bundle authorization**: Rather than approving specific tool calls (which would require the Governor to understand execution-level detail), the Governor approves a **capability bundle** — a pre-defined set of tools and permissions appropriate for the classified intent. This is analogous to authorizing a compound HTN task: the decomposition of that task into specific primitive actions is delegated to the Executor.

**Risk assessment**: Evaluate the plan's risk profile before authorizing execution. High-risk capability bundles (those touching irreversible operations, external communication, financial systems) trigger additional approval gates or human review.

**Replanning triggers**: If the Executor reports that execution diverged from intent (a sub-task failed, the world state didn't match expectations), the Governor decides whether to authorize a revised capability bundle, escalate to the user, or abort.

### Capability Bundles as Pre-authorized Plans

The capability bundle model is a form of **pre-authorized planning**. Rather than requiring the Governor to review every tool call in real time — which would serialize execution and defeat the purpose of autonomous execution — the Governor approves a package of permissions that bounds the Executor's action space.

This mirrors the tiered autonomy model emerging in enterprise AI governance literature (IBM, WitnessAI, 2026): full autonomy for routine, low-risk operations; supervised autonomy for medium-risk decisions; human-gated execution for high-risk, high-impact actions. The capability bundle is the formalization of the "autonomy tier" for a given task.

### Planning in the Governor: Intent-to-Bundle Decomposition

When the Governor receives an escalated intent from the Session layer, its planning process is:

1. **Intent classification**: Map the natural language intent to a structured task category
2. **Capability requirement analysis**: Determine what tools and permissions the task requires. This is the high-level decomposition step — not "call tool X with argument Y" but "this task needs read access to the filesystem, web search, and the ability to write to the workspace directory"
3. **Risk scoring**: Assess the risk profile of the required capability bundle given the task context
4. **Authorization decision**: Approve the bundle, request clarification, or escalate to a human
5. **Execution delegation**: Hand off to the Executor with the approved bundle and a high-level task description

The Executor then performs the full decomposition into specific tool calls — autonomously, within the boundary the Governor set.

### Separation of Planning and Execution Concerns

A key architectural insight from planning theory is that the Session-Governor-Executor model achieves a clean separation of planning concerns:

- **Strategic planning** (what to do, what's permitted, what's risky): Governor's responsibility
- **Tactical planning** (how exactly to do it, which specific tools to call in what order): Executor's responsibility

This separation has real security benefits. Because the Governor approves at the capability level rather than the action level, it is not exposed to the execution context where prompt injection attacks occur. A malicious tool output can manipulate the Executor's action selection, but cannot modify the capability envelope the Governor authorized — the Governor has already returned its decision before execution began.

### Replanning Flow in SGE

When the Executor encounters a failure that exceeds its recovery capabilities (all tools in the approved bundle have been exhausted, the task is impossible within the approved permission set), the failure is escalated back to the Governor. The Governor then:

1. Determines whether additional capability is genuinely required or whether the original bundle should have been sufficient (Executor error vs. authorization gap)
2. Authorizes an expanded capability bundle if appropriate (replanning at the strategic level)
3. Or escalates to the Session layer to inform the user and request new input

This creates a coherent replanning loop that respects the trust boundaries between layers.

---

## 11. Current Research Directions

### Test-Time Compute Scaling

The o-series and extended thinking models demonstrate that increasing inference-time compute (rather than training-time compute) improves planning quality. 2025-2026 research is focused on making this scaling controllable and predictable — developing better models of which task types benefit from additional reasoning tokens, and building routing systems that allocate compute proportionally to task complexity.

### Learned Value Functions for MCTS

A bottleneck in MCTS-based planning is the cost of rollout simulations. Research is converging on training dedicated value models that can estimate the long-run value of intermediate plan states without full simulation, making MCTS practical for real-time agent planning.

### Multi-Agent Planning Coordination

As agent deployments scale from single agents to networks of tens or hundreds of specialized agents, planning coordination becomes critical. Research on multi-agent HTN planning is exploring how shared planning state can be maintained across agents, how conflicts between concurrently executing plans are detected and resolved, and how to allocate tasks to agents with heterogeneous capabilities.

### Proactive Planning and Self-Scheduling

The most forward-looking research direction is agents that plan not just in response to user requests, but proactively — identifying future tasks, scheduling follow-up work, and maintaining long-running goal pursuit across context window boundaries. This requires agents to maintain planning state across sessions, which intersects deeply with memory architecture research.

### Formal Verification of Agent Plans

As agents take on higher-stakes tasks, formal verification of plan correctness (before execution, not just after) is gaining attention. Approaches include model checking (verifying that a plan satisfies a set of safety properties), symbolic execution (tracing all possible execution paths of a plan), and invariant monitoring (checking that global system invariants are maintained throughout plan execution).

---

## Conclusion

Goal decomposition and hierarchical planning are the enabling infrastructure for autonomous AI agents. Without them, LLMs are powerful but reactive tools; with them, they become systems capable of sustained, coherent pursuit of complex goals across extended time horizons.

The field has converged on a set of complementary techniques — HTN-structured decomposition, plan-and-execute patterns, reflection and verification loops, tree/graph search methods — that collectively address the core challenges: breaking down ambiguous goals, executing reliably in a world that differs from plan expectations, and recovering gracefully when plans fail.

For multi-layer agent architectures like Session-Governor-Executor, planning theory provides precise guidance on how to allocate responsibilities across layers. The Governor is the strategic planner: it classifies intent, assesses risk, and authorizes capability bundles that bound the action space. The Executor is the tactical planner: it decomposes authorized tasks into specific tool calls and manages local recovery. The Session handles the user-facing communication that wraps both layers.

This separation of planning concerns isn't just good architecture — it's a security boundary. The Governor's planning decisions are made before the Executor sees any untrusted external content, ensuring that prompt injection attacks in tool outputs cannot compromise the strategic authorization decision.

The 2026 research agenda — test-time compute scaling, learned value functions, multi-agent coordination, proactive planning — points toward agents with qualitatively greater planning capabilities. The architectural patterns established in this period will determine how much of that capability can be safely deployed in production systems.

---

## References

- [Long-Running AI Agents and Task Decomposition 2026 | Zylos Research](https://zylos.ai/research/2026-01-16-long-running-ai-agents)
- [Agentic AI frameworks for enterprise scale: A 2026 guide | Akka](https://akka.io/blog/agentic-ai-frameworks)
- [AI Agents vs. Agentic AI: A Conceptual Taxonomy | arXiv 2505.10468](https://arxiv.org/html/2505.10468v1)
- [LLM Agent Task Decomposition Strategies | apxml.com](https://apxml.com/courses/agentic-llm-memory-architectures/chapter-4-complex-planning-tool-integration/task-decomposition-strategies)
- [Breaking Down Tasks: Master Task Decomposition for AI Agents | Michael Brenndoerfer](https://mbrenndoerfer.com/writing/breaking-down-tasks-task-decomposition-ai-agents)
- [Enhancing LLM-Based Agents via Global Planning and Hierarchical Execution | arXiv 2504.16563](https://arxiv.org/abs/2504.16563)
- [Why Do LLM-based Web Agents Fail? A Hierarchical Planning Perspective | arXiv 2603.14248](https://arxiv.org/html/2603.14248)
- [Hierarchical LLM-Based Multi-Agent Framework | arXiv 2602.21670](https://arxiv.org/pdf/2602.21670)
- [Hierarchical Task Network Planning | Emergent Mind](https://www.emergentmind.com/topics/hierarchical-task-network-htn-planning-framework)
- [Hierarchical Planning Approaches for Agents | apxml.com](https://apxml.com/courses/agentic-llm-memory-architectures/chapter-4-complex-planning-tool-integration/hierarchical-planning-approaches)
- [Plan-Then-Execute Pattern | Awesome Agentic Patterns](https://agentic-patterns.com/patterns/plan-then-execute-pattern/)
- [Plan-and-Execute Agents | LangChain Blog](https://blog.langchain.com/planning-agents/)
- [Architecting Resilient LLM Agents: A Guide to Secure Plan-then-Execute Implementations | arXiv 2509.08646](https://arxiv.org/abs/2509.08646)
- [Plan-Then-Execute: An Empirical Study of User Trust | CHI 2025](https://dl.acm.org/doi/10.1145/3706598.3713218)
- [ReAct vs Plan-and-Execute: A Practical Comparison | DEV Community](https://dev.to/jamesli/react-vs-plan-and-execute-a-practical-comparison-of-llm-agent-patterns-4gh9)
- [ReAct: Synergizing Reasoning and Acting in Language Models | arXiv 2210.03629](https://arxiv.org/abs/2210.03629)
- [What is BabyAGI? | IBM](https://www.ibm.com/think/topics/babyagi)
- [AutoGPT vs BabyAGI: Which AI Agent Fits Your Workflow in 2025? | Sider.ai](https://sider.ai/blog/ai-tools/autogpt-vs-babyagi-which-ai-agent-fits-your-workflow-in-2025)
- [LLM Powered Autonomous Agents | Lil'Log](https://lilianweng.github.io/posts/2023-06-23-agent/)
- [Cost-Awareness in Tree-Search LLM Planning | arXiv 2505.14656](https://arxiv.org/html/2505.14656)
- [ToolTree: Efficient LLM Agent Tool Planning via Dual-Feedback MCTS | arXiv 2603.12740](https://arxiv.org/html/2603.12740)
- [ReKG-MCTS: Reinforcing LLM Reasoning on Knowledge Graphs | ACL 2025](https://aclanthology.org/2025.findings-acl.484/)
- [MCTS for Comprehensive Exploration in LLM-Based Heuristic Design | ICML 2025](https://icml.cc/virtual/2025/poster/45984)
- [Claude's Extended Thinking | Anthropic](https://www.anthropic.com/news/visible-extended-thinking)
- [Building with Extended Thinking | Anthropic API Docs](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
- [Introducing Claude 4 | Anthropic](https://www.anthropic.com/news/claude-4)
- [Intent Recognition and Auto-Routing in Multi-Agent Systems](https://gist.github.com/mkbctrl/a35764e99fe0c8e8c00b2358f55cd7fa)
- [AI Agent Routing: Tutorial & Best Practices | Patronus AI](https://www.patronus.ai/ai-agent-development/ai-agent-routing)
- [Enhancing Intent Classification and Error Handling in Agentic LLM Applications | Medium](https://medium.com/@mr.murga/enhancing-intent-classification-and-error-handling-in-agentic-llm-applications-df2917d0a3cc)
- [Multi-Agent AI Failure Recovery That Actually Works | Galileo](https://galileo.ai/blog/multi-agent-ai-system-failure-recovery)
- [Scene Graph-Guided Proactive Replanning for Failure-Resilient Embodied Agents | RSS 2025](https://semrob.github.io/docs/2025_rss_semrob.github.io_paper14.pdf)
- [Prioritizing Real-Time Failure Detection in AI Agents | Partnership on AI](https://partnershiponai.org/wp-content/uploads/2025/09/agents-real-time-failure-detection.pdf)
- [AI Agent Governance: The Architecture Layer Most Companies Skip | Hendricks AI](https://hendricks.ai/insights/ai-agent-governance-architecture)
- [Governing Multi-Agent AI Systems: An Enterprise Blueprint | Architecture & Governance Magazine](https://www.architectureandgovernance.com/app-tech/governing-multi-agent-ai-systems-an-enterprise-blueprint-for-scalable-autonomy-trust-and-control/)
- [The Hidden Economics of AI Agents: Managing Token Costs and Latency Trade-offs | Stevens Online](https://online.stevens.edu/blog/hidden-economics-ai-agents-token-costs-latency/)
- [The Cost of Dynamic Reasoning: Demystifying AI Agents and Test-Time Scaling | arXiv 2506.04301](https://arxiv.org/html/2506.04301v1)
- [AI Trends 2026: Test-Time Reasoning and the Rise of Reflective Agents | Hugging Face](https://huggingface.co/blog/aufklarer/ai-trends-2026-test-time-reasoning-reflective-agen)
- [Agentic AI: Autonomous Intelligence for Complex Goals — A Comprehensive Survey | IEEE Xplore](https://ieeexplore.ieee.org/document/10849561/)
- [Agentic AI: a comprehensive survey of architectures, applications, and future directions | Springer](https://link.springer.com/article/10.1007/s10462-025-11422-4)
- [Self-Evaluation in AI Agents With Chain of Thought | Galileo](https://galileo.ai/blog/self-evaluation-ai-agents-performance-reasoning-reflection)
- [What is AI Agent Planning? | IBM](https://www.ibm.com/think/topics/ai-agent-planning)
- [Agent Autonomy with Governance Constraints | Agility at Scale](https://agility-at-scale.com/ai/agents/agent-autonomy-with-governance-constraints/)
