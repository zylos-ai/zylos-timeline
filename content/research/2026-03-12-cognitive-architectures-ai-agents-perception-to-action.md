---
date: "2026-03-12"
title: "Cognitive Architectures for AI Agents: From Perception to Action"
description: "How classical cognitive science models inform modern AI agent design — mapping perception-decision-action frameworks to Session-Governor-Executor architectures"
tags: ["cognitive architecture", "AI agents", "perception-action", "agent design", "multi-agent systems", "metacognition"]
---

## Executive Summary

Every AI agent system embodies a theory of mind — whether its designers know it or not. The choices made about what perceives, what decides, and what acts encode assumptions about cognition that cognitive scientists have debated for decades. The difference today is that practitioners are making those architectural choices under production pressure, often rediscovering at scale what cognitive science established long ago: perception and action must be mediated by a decision layer, memory must be stratified by function, and metacognition — the system's ability to monitor its own reasoning — is not a luxury feature but a prerequisite for reliable behavior.

This article traces the line from classical cognitive architectures (ACT-R, Soar, LIDA, Global Workspace Theory) to the multi-layer agent designs emerging in 2025–2026, with particular attention to the Session-Governor-Executor pattern — a three-tier architecture where a constrained conversational layer (Session) feeds into a policy-and-orchestration layer (Governor), which delegates to a privileged execution layer (Executor). The mapping is not coincidental. It reflects the same functional decomposition that cognitive science has converged on across four decades of research into how intelligent systems — biological and artificial — turn perception into purposeful action.

---

## 1. The Classical Cognitive Architecture Landscape

Cognitive architecture research asks a foundational question: what is the minimum set of functional components that produces general intelligent behavior? The major frameworks from the 1980s through the 2000s answered this question differently but converged on a recognizable core.

### ACT-R: Procedural and Declarative Memory as First-Class Primitives

ACT-R (Adaptive Control of Thought — Rational), developed by John Anderson at Carnegie Mellon, models cognition as the interaction between procedural memory (production rules stored in a central executive) and declarative memory (chunks of factual knowledge with activation values). The central module arbitrates between competing production rules using utility calculations; perception and motor action happen through separate peripheral modules.

What makes ACT-R architecturally significant for agent builders is its explicit separation of *how to do things* (procedural) from *what is known* (declarative), and its treatment of memory retrieval as a probabilistic process governed by activation decay and associative spreading. This maps directly to modern LLM agent designs where tool selection logic (procedural) must be separated from knowledge retrieval (RAG, semantic search) — and where retrieval failures are a primary source of agent hallucination, just as they are a source of cognitive error in ACT-R models.

### Soar: Problem Spaces and the Impasse-Subgoal Mechanism

Soar (developed by John Laird, Allen Newell, and Paul Rosenbloom) is grounded in the Problem Space Hypothesis: all goal-directed behavior can be formalized as search through a state space. The key contribution of Soar is the *impasse* mechanism — when the system cannot select an operator to apply, it automatically creates a subgoal to resolve the impasse. This recursive subgoaling produces hierarchical problem decomposition as an emergent property of the architecture, rather than as an explicit programmer design.

Modern agent systems are rediscovering Soar's insight as the "orchestrator-subagent" pattern. When an orchestrator agent cannot determine the next action (an impasse in Soar's terminology), it spawns a specialist subagent to resolve the uncertainty. The 2025 paper "Applying Cognitive Design Patterns to General LLM Agents" by Wray, Kirk, and Laird explicitly maps the Soar observe-decide-act cycle onto the ReAct (Reasoning + Acting) pattern used in LLM agents, noting that ReAct lacks the explicit *commitment* step present in Soar — a gap that may explain some of the reasoning instability observed in ReAct implementations.

### LIDA: The Cognitive Cycle and Attention as a Bottleneck

LIDA (Learning Intelligent Distribution Agent), developed by Stan Franklin at the University of Memphis, is perhaps the closest classical architecture to how modern LLM agents actually behave in practice. LIDA builds directly on Global Workspace Theory (GWT) and structures cognition as a rapid cycle of three phases: *understanding* (perception builds a current situational model), *consciousness* (attention codelets compete to broadcast selected content to a global workspace), and *action selection* (behavior schemes are selected and executed).

The attention bottleneck in LIDA — where competing codelets fight for broadcast rights into the global workspace — has a direct analog in LLM agent attention mechanisms. The transformer's attention weights are literally a competition for representational priority. More practically, the LIDA model predicts that a system overloaded with perceptual input will make poorer decisions because low-salience but decision-relevant information fails to win the competition for broadcast. This is why context window management is not just an engineering concern in LLM agents — it is a cognitive architecture concern. Stuffing the context window degrades decision quality by diluting signal in exactly the way LIDA predicts.

### Global Workspace Theory: Consciousness as a Broadcast Network

Bernard Baars' Global Workspace Theory proposes that conscious experience corresponds to information being broadcast from a central "global workspace" to a large number of specialized, otherwise-isolated processors. The workspace is a bottleneck: only one coherent representation can occupy it at a time, but that representation is broadcast widely, enabling coordination among modules that otherwise cannot communicate directly.

GWT provides the strongest theoretical basis for understanding why single-threaded, turn-based LLM interaction produces surprisingly capable behavior despite its apparent limitations. The LLM context window acts as a global workspace: information entered into it becomes "consciously available" to all the model's processing, while information outside the context remains in implicit long-term weight storage. The broadcast step corresponds to the model's forward pass. The specialization of recipient modules corresponds to the diverse downstream behaviors (tool calls, reasoning, response generation) that the single context window coordinates.

Recent research at the intersection of GWT and AI (including a 2024 paper arguing that language agent architectures may already satisfy GWT conditions for phenomenal consciousness) underscores that the analogy is not loose — the computational structures are genuinely isomorphic.

---

## 2. The Perception-Decision-Action Loop in Modern Agents

Modern agent frameworks have independently converged on a three-phase loop that maps closely to the classical architectures: perceive the environment, reason about what to do, execute an action, observe the result, repeat. The 2026 state of the art treats this loop as the basic unit of agent design, with variations primarily in how the decision phase is implemented.

### From Observe-Orient-Decide-Act to LLM Agent Loops

The military decision-making model OODA (Observe, Orient, Decide, Act), developed by John Boyd, predates LLM agents but anticipates their structure. The *orient* phase — where raw observation is contextualized against existing knowledge and mental models — corresponds to the retrieval and context-building step in RAG-augmented agents. The *decide* phase, often collapsed into the LLM's single forward pass in naive implementations, is increasingly being separated into a distinct planning or reasoning step.

The key architectural insight from classical cognitive science is that the *orientation* step is the critical one. Errors in how raw perception is translated into a working representation propagate through the entire loop. An agent that receives an ambiguous tool output and fails to resolve the ambiguity before acting is making the same error as a human who misreads a situation — the cognitive cycle has advanced past understanding into action selection with a corrupt situational model.

### Dual Process Theory: System 1 and System 2 in Agent Design

Kahneman's distinction between System 1 (fast, automatic, pattern-matching) and System 2 (slow, deliberate, rule-following) has become a design framework for agent architectures. LLMs in their base form are closer to System 1 — they produce fast, fluent responses from statistical patterns without explicit reasoning. Chain-of-thought prompting, extended thinking modes, and explicit planning layers push toward System 2 behavior.

The 2025 DPT-Agent framework makes this decomposition explicit: System 1 uses a finite-state machine for fast, deterministic decisions on routine inputs; System 2 uses an LLM with Theory of Mind reasoning for novel or high-stakes decisions. This hybrid maps directly onto what production systems have discovered empirically: the most efficient agent architectures do not route everything through an expensive LLM. They use fast, deterministic paths for pattern-matched cases and reserve LLM inference for genuine ambiguity.

---

## 3. Memory Architecture: Stratification as Cognitive Necessity

Every major cognitive architecture stratifies memory. This is not a design choice — it is a constraint imposed by the different information-theoretic properties of immediate context, recent experience, and long-term knowledge. LLM agents face the same constraints and have developed the same stratified solutions.

### The Four-Layer Memory Model

The mapping from cognitive science to LLM agent practice is direct:

| Cognitive Science | LLM Agent Analog | Function |
|---|---|---|
| Sensory buffer | Input preprocessing | Raw perception before interpretation |
| Working memory | Context window | Active reasoning substrate |
| Episodic memory | Session logs, vector store | What happened, when, in what order |
| Semantic memory | RAG knowledge base, model weights | General facts and relationships |
| Procedural memory | Tool definitions, system prompt rules | How to do things |

The context window's role as working memory is the source of the most important design constraint in LLM agent systems: working memory in biological systems is limited to approximately 7±2 items; LLM context windows are limited to tens or hundreds of thousands of tokens, but the quality of reasoning *within* that window still degrades as utilization approaches capacity. This is the "lost in the middle" problem — relevant information positioned in the middle of a long context receives less attention weight than information at the edges, analogous to the serial position effects (primacy and recency) observed in human working memory.

The practical design implication: agents should treat the context window as working memory and architect explicitly for the three forms of long-term memory. Context compression, episodic retrieval, and semantic indexing are not optional optimizations — they are the necessary external scaffolding for a working memory system that cannot internally consolidate.

### Long-Term Memory and the Consolidation Problem

In human cognition, memory consolidation — the transfer of episodic experience into semantic knowledge — happens during sleep. In LLM agents, this consolidation must be engineered explicitly. An agent that only maintains episodic logs (session histories) never develops semantic generalizations from experience. An agent that only updates model weights (fine-tuning) cannot rapidly incorporate new episodic context.

Effective agent memory architectures handle this by maintaining both: an episodic store for verbatim recent context (with decay and archiving), and a semantic update mechanism (structured knowledge bases, preference files, decision logs) that distills episodic experience into generalizable facts. This is the architecture underlying systems like Mem0 and the broader "agent memory" tooling category that emerged in 2024–2025.

---

## 4. Metacognition: The Monitoring Layer That Makes Agents Reliable

Metacognition — cognition about cognition — is what allows intelligent systems to detect and correct their own errors. Classical cognitive architectures handle this through dedicated monitoring modules. In LLM agents, metacognition is an emergent and fragile capability that must be explicitly architected to be reliable.

### What Metacognition Does in Agent Systems

A metacognitive agent monitors: *confidence* (am I certain enough about this to act?), *competence* (do I have the skills and information needed for this task?), *progress* (am I making headway toward the goal?), and *validity* (are my conclusions logically sound?). Failures in any of these dimensions should trigger a qualitatively different response — more information gathering, goal decomposition, or escalation — rather than proceeding with the current plan.

Research in 2025 showed that LLM metacognitive capability is strongly correlated with model scale. Small models show minimal introspective accuracy — they cannot reliably predict when they will make errors. Larger models show emergent metacognitive behavior, including the ability to report uncertainty and recognize knowledge gaps. This creates a practical design tension: the cheapest model capable of handling a routine task may be metacognitively blind, making it unreliable for autonomous operation.

### The Reflection Loop as Explicit Metacognition

The self-reflection loop — where an agent critiques its own output and revises it before returning a response — is the most widely deployed metacognitive mechanism in LLM agent systems. Research has demonstrated significant performance improvements on complex tasks when agents are given structured reflection prompts. The SOFAI architecture (System One / Fast AI) implements a learnable metacognitive mechanism that selects between fast and slow solvers based on task characteristics, providing a principled alternative to always-on chain-of-thought.

For agent builders, the key design principle is: metacognition must be a *first-class architectural component*, not an afterthought. The reflection loop, confidence calibration, and impasse detection should be explicit stages in the agent loop, with defined behaviors for each failure mode. An agent that proceeds confidently when it should be uncertain is not just wrong — it is wrong in a way that resists correction.

---

## 5. Permission Separation as Cognitive Architecture

The most direct mapping between cognitive science principles and modern agent security architecture is the concept of *cognitive boundary* — the structural separation between what a system perceives and what it can do. In biological cognition, this boundary is enforced anatomically and neurochemically: sensory processing and motor output are physically distinct systems mediated by the central executive. In agent systems, this boundary must be enforced architecturally.

### Why Perception Cannot Safely Imply Action Authority

In classical cognitive architectures, the perceptual layer has no direct access to the motor system. Raw sensory input cannot trigger action without passing through working memory, goal evaluation, and the decision-making process. This is not just a computational organization — it is a safety invariant. A system where perception directly triggers action (a pure reactive architecture) is vulnerable to perceptual deception: cause the system to perceive X, and you cause it to do Y, with no intervening opportunity for goal-check or policy evaluation.

LLM agents that collapse perception and action into a single model call reproduce this vulnerability. An agent that reads a tool output and immediately acts on its instructions, without checking whether those instructions are consistent with its goals and constraints, is architecturally equivalent to a pure reactive system — and equally vulnerable to prompt injection. The "AI agents are becoming authorization bypass paths" pattern observed in enterprise deployments in early 2026 is exactly this failure: the conversational perception layer was granted action authority it should never have had.

### The Session-Governor-Executor Model

The three-tier architecture that addresses this problem directly mirrors the cognitive architecture principle of mediated action:

**Session (Perception/Expression Layer):** A constrained LLM with conversational presence. It perceives user input, formulates interpretations, and generates responses. It has no direct tool access — its only output channel is a structured intent representation passed to the Governor. This corresponds to the perceptual + working memory stage in classical architectures, bounded by the context window (global workspace) and unable to directly trigger motor output.

**Governor (Cognitive Control Layer):** The policy-and-orchestration layer. It receives structured intents from the Session layer and makes authorization and routing decisions: is this intent within policy? What executor should handle it? What constraints should apply? This corresponds to the central executive / goal evaluation stage in ACT-R and Soar — the layer that matches intentions against goals, applies procedural rules, and selects the appropriate response. The Governor operates deterministically (rule engines, state machines) wherever possible, reserving LLM inference for soft semantic decisions that require contextual judgment.

**Executor (Action Layer):** Full permissions, tool access, and external API calls. It receives authorized, structured task specifications from the Governor and executes them. It does not interpret user intent — it executes well-specified subtasks. This corresponds to the motor output modules in cognitive architectures: specialized, high-capability, but operating strictly within the envelope defined by the control layer above it.

**Independent Modules (Memory, Security, Scheduler, MetaCognition):** Orthogonal to the perception-action stack, these modules are accessible to the Governor but structurally isolated from both the Session and Executor layers. Memory modules persist information across cognitive cycles; the scheduler enables proactive behavior (autonomous triggering of cognitive cycles, analogous to biological circadian and alerting systems); the metacognition module monitors the system's own performance and flags anomalies for Governor-level intervention.

This architecture enforces the cognitive boundary computationally. The Session layer cannot grant itself execution authority, because it has no channel to the Executor that bypasses the Governor. Prompt injection into the Session layer becomes an attempt to subvert the cognitive control layer — detectable because the intent representations passed to the Governor are structured, policy-evaluable artifacts rather than raw natural language fed directly into an action executor.

---

## 6. The Ambient Presence Problem

Classical cognitive architectures were designed to model episodic, task-bounded cognition — a human performing a specific task in a specific context. They do not naturally model what might be called *ambient presence*: the continuous background monitoring and contextual awareness that a persistent agent must maintain even when not actively engaged in a task.

### What Ambient Presence Requires

An ambient agent (always-on, event-driven, monitoring streams of signals rather than responding to discrete requests) has cognitive requirements that differ fundamentally from a request-response agent. It must:

- Maintain a continuously updated world model (the Current Situational Model in LIDA terminology) even when no explicit task is active
- Detect conditions that warrant initiating a new cognitive cycle (the "attention codelet" function in LIDA)
- Manage cognitive load: not every event warrants a full deliberative cycle; most should be handled by fast, cheap pattern-matching
- Preserve conversational context across long gaps while managing memory decay and relevance degradation

This maps to LIDA's continuous cognitive cycle architecture: the system is always in some phase of the sense-attend-act loop, even when outward behavior is quiescent. The Governor layer in a Session-Governor-Executor architecture becomes an event-driven scheduler in the ambient case — continuously evaluating incoming signals against attention thresholds and triggering Session or Executor processes only when a threshold is crossed.

### The Dual-Mode Challenge

A persistent agent often needs to switch between ambient (passive monitoring) and interactive (active conversation) modes. This mode switch is cognitively expensive in biological systems — it requires reorientation, context restoration, and goal reset. In agent systems, it requires context loading, session state restoration, and potentially re-establishing the user's intent from a cold start.

Production ambient agents handle this by maintaining a lightweight, continuously updated context buffer (distinct from the full session context) that captures key signals from ambient monitoring and is injected into the context window when an interactive session begins. This is analogous to the human experience of waking up and reviewing what happened overnight before engaging with the day — a compressed episodic integration that sets the cognitive starting state for the new interactive session.

---

## 7. LLM Agents vs. Classical Architectures: Key Differences

Despite the strong structural mappings, LLM agents differ from classical cognitive architectures in ways that matter for design:

**Knowledge encoding:** Classical architectures separate declarative knowledge (explicit facts that can be inspected, updated, and deleted) from procedural knowledge (production rules). LLM knowledge is distributed across billions of weights — it is implicit, cannot be reliably updated without retraining, and cannot be inspected or deleted selectively. This means LLM agents require external declarative memory (the RAG+episodic architecture) as a prosthetic for the explicit declarative memory that classical architectures provide natively.

**Coordination mechanism:** In classical multi-agent systems, coordination is achieved through explicit protocols (message formats, handshake sequences, shared ontologies). In LLM multi-agent systems, coordination is primarily achieved through natural language — agents literally talk to each other. This is more flexible but less reliable: natural language instructions can be misinterpreted, ignored, or manipulated in ways that explicit protocol messages cannot be.

**Reasoning process:** Classical architectures reason through explicit symbolic manipulation — the operator application and state transformation in Soar, the production rule firing in ACT-R. LLM reasoning is statistical pattern completion. The LLM does not *apply* a rule; it *predicts* what comes after a reasoning chain. This makes LLM reasoning more general (it can handle informal, contextual situations that resist formalization) but less auditable (you cannot trace which rule fired) and less reliable on novel inputs that don't match training patterns.

**Memory consolidation:** Classical architectures have explicit mechanisms for moving information between memory types — chunking in Soar, activation strengthening in ACT-R. LLMs consolidate via gradient descent on training data, which happens offline and in bulk. Online consolidation (learning during deployment) is a research area, not a production capability. This means LLM agents must use external scaffolding (memory files, databases, knowledge graphs) to simulate the online consolidation that classical architectures provide natively.

---

## 8. Practical Implications for Agent Builders

The cognitive science literature converges on a set of design principles that translate directly to implementation guidance:

**Separate perception from action authority.** Never give the conversational layer direct access to execution tools. The Governor (or equivalent policy layer) must be the only path from intent to action. This is the architectural principle behind the Session-Governor-Executor model and behind the OWASP AI Agent Security guidance on permission boundaries.

**Stratify memory explicitly.** Design for working memory (context window), episodic memory (session logs, recent events), and semantic memory (knowledge bases, preference files) as distinct subsystems with explicit interfaces. Do not rely on the context window alone for persistence — it is working memory, not long-term storage.

**Make metacognition a first-class layer.** Implement explicit confidence calibration, impasse detection, and reflection loops as architectural components, not as prompting tricks. The metacognition layer should be able to halt execution and escalate to a human or to a more capable model when uncertainty exceeds a threshold.

**Design for the ambient-interactive transition.** If your agent needs persistent presence, architect the context initialization explicitly. What information from ambient monitoring should be injected into the Session context when an interactive session begins? How long should ambient context survive before it is treated as stale?

**Use deterministic control wherever possible.** The Governor layer should use rule engines and state machines for lifecycle management, permission enforcement, and budget tracking. Reserve LLM inference for decisions that require contextual judgment — and design the boundary between deterministic and LLM-mediated decisions as an explicit architectural choice, not a default.

**Design for cognitive load.** Context window utilization above roughly 60–70% degrades reasoning quality in most production models. Implement context compression, sliding window summarization, and proactive archiving as first-class concerns in any long-running agent. This is not a performance optimization — it is a reliability requirement.

The cognitive science models described in this article were built to explain biological intelligence. Their convergent rediscovery in AI agent design is not coincidence — it reflects constraints imposed by the nature of goal-directed behavior in a complex, uncertain world. Whether the substrate is wetware or transformer weights, the functional requirements of perception, deliberation, action, and memory impose the same architectural solutions.

---

*Sources:*
- [Applying Cognitive Design Patterns to General LLM Agents (arXiv 2505.07087)](https://arxiv.org/abs/2505.07087)
- [A Case for AI Consciousness: Language Agents and Global Workspace Theory (arXiv 2410.11407)](https://arxiv.org/abs/2410.11407)
- [LIDA: A Computational Model of Global Workspace Theory](https://ccrg.cs.memphis.edu/assets/papers/LIDA%20paper%20Fall%20AI%20Symposium%20Final.pdf)
- [Can A Cognitive Architecture Fundamentally Enhance LLMs? (arXiv 2401.10444)](https://arxiv.org/abs/2401.10444)
- [Leveraging Dual Process Theory in Language Agent Framework (arXiv 2502.11882)](https://arxiv.org/abs/2502.11882)
- [Position: Truly Self-Improving Agents Require Intrinsic Metacognitive Learning (OpenReview)](https://openreview.net/forum?id=4KhDd0Ozqe)
- [Soar Cognitive Architecture (Wikipedia)](https://en.wikipedia.org/wiki/Soar_(cognitive_architecture))
- [Global Workspace Theory (Wikipedia)](https://en.wikipedia.org/wiki/Global_workspace_theory)
- [Agentic Artificial Intelligence: Architectures, Taxonomies, and Evaluation (arXiv 2601.12560)](https://arxiv.org/html/2601.12560v1)
- [Beyond the Chat Window: Ambient AI Agents (Microsoft Community Hub)](https://techcommunity.microsoft.com/blog/linuxandopensourceblog/beyond-the-chat-window-how-change-driven-architecture-enables-ambient-ai-agents/4475026)
- [Systems Security Foundations for Agentic Computing (IACR)](https://eprint.iacr.org/2025/2173.pdf)
- [Fast, slow, and metacognitive thinking in AI (npj Artificial Intelligence)](https://www.nature.com/articles/s44387-025-00027-5)
