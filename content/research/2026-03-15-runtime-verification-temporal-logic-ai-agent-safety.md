---
date: "2026-03-15"
title: "Runtime Verification and Temporal Logic for AI Agent Safety"
description: "How formal runtime verification techniques — from LTL monitors to behavioral contracts — are making AI agents provably safe without sacrificing autonomy."
tags: ["runtime-verification", "temporal-logic", "agent-safety", "formal-methods", "guardrails"]
---

## Executive Summary

As AI agents move from demos to production deployments in healthcare, finance, and infrastructure management, the question shifts from "can the agent do the task?" to "can we prove it will never do something dangerous?" Traditional guardrails — keyword filters, prompt engineering, output classifiers — operate on heuristics. They catch known-bad patterns but offer no guarantees about novel failure modes. Runtime verification, rooted in decades of formal methods research, offers a fundamentally different approach: specify what the agent *must* and *must not* do in temporal logic, synthesize a monitor from that specification, and enforce it at every decision point. This article surveys the rapid convergence of runtime verification with AI agent systems in 2025–2026, covering the theoretical foundations, emerging frameworks like AgentSpec and VeriGuard, and the practical implications for agent runtime architectures.

## The Problem: Heuristic Guardrails Hit a Ceiling

Most production AI agent systems today rely on layered heuristic defenses: input validators screen user prompts, output classifiers flag harmful content, and tool-use policies restrict which APIs an agent can call. These work well for known attack vectors — prompt injection, jailbreaks, data exfiltration via obvious channels — but they share a fundamental limitation: they reason about individual actions in isolation.

Consider an agent with access to a file system and a network API. No single action is dangerous: reading a file is fine, sending an HTTP request is fine. But reading `/etc/passwd` and then sending its contents to an external endpoint is a *sequence* that constitutes data exfiltration. Detecting this requires reasoning about temporal relationships between actions — exactly what heuristic guardrails cannot do.

The problem compounds in multi-agent systems. Agent A might be permitted to query a database, and Agent B might be permitted to send emails. Neither action alone is dangerous. But if Agent A passes sensitive query results to Agent B, which then emails them externally, the system has violated a confidentiality policy. The violation is distributed across agents and time steps, invisible to any single-action filter.

## Temporal Logic: A Language for Agent Behavior

Temporal logic provides the formal language needed to express these sequential and conditional safety properties. The two most relevant variants for agent systems are:

**Linear Temporal Logic (LTL)** reasons about properties that must hold along every possible execution path. Key operators include:

- **G** (Globally): a property must hold at every future step. `G(¬access_financial_data ∨ authenticated)` — the agent must never access financial data unless authenticated.
- **F** (Finally/Eventually): a property must hold at some future step. `G(request_submitted → F response_delivered)` — every request must eventually get a response (liveness).
- **U** (Until): a property must hold until another becomes true. `¬execute_trade U risk_assessment_complete` — do not execute trades until risk assessment is done.
- **X** (Next): a property must hold at the next step. Useful for specifying immediate post-conditions.

**Computation Tree Logic (CTL)** extends this to branching-time reasoning, where the agent's future is a tree of possible paths rather than a single line. This is relevant when an agent has non-deterministic choices and we need to verify that *all* possible choice sequences satisfy safety properties (universal quantification: `A`) or that *at least one* safe path exists (existential quantification: `E`).

For AI agents, LTL is typically sufficient and more practical. An LTL formula can be automatically compiled into a finite-state monitor (specifically, a Büchi automaton) that observes the agent's action stream and raises a violation the moment the specification is breached — or, in predictive variants, before the breach occurs.

## From Theory to Practice: Monitor Synthesis

The bridge between temporal logic specifications and running code is *monitor synthesis*: the automatic translation of a temporal formula into executable monitoring code.

The classical approach works as follows:

1. Express the safety property as an LTL formula φ.
2. Negate it to get ¬φ (the set of violating behaviors).
3. Convert ¬φ to a non-deterministic Büchi automaton (NBA).
4. Determinize and minimize the automaton.
5. Deploy the resulting deterministic monitor as a state machine that consumes the agent's action trace.

At each step, the monitor is in one of three states: **satisfied** (the property is guaranteed to hold regardless of future actions), **violated** (the property has been breached), or **inconclusive** (the verdict depends on future actions). This three-valued semantics is crucial for runtime verification because, unlike model checking which examines complete traces, runtime monitors observe prefixes of ongoing executions.

For AI agent systems, the monitor sits between the agent's decision engine and the execution environment. When the agent proposes an action, the monitor advances its state machine. If the new state is "violated," the action is blocked and a recovery procedure is triggered. This adds latency measured in microseconds to milliseconds — negligible compared to LLM inference times.

## AgentSpec: Domain-Specific Runtime Enforcement

AgentSpec, presented at ICSE 2026, represents the most mature framework for applying runtime enforcement to LLM agents. Rather than requiring users to write temporal logic formulas directly, it provides a domain-specific language (DSL) where rules are expressed as three-tuples: *(trigger, predicate, enforcement)*.

- **Trigger**: The event that activates the rule (e.g., `before_tool_call`, `after_observation`, `on_completion`).
- **Predicate**: A condition evaluated against the current agent state and action history.
- **Enforcement**: The action taken when the predicate is satisfied (e.g., `block`, `modify`, `alert`, `terminate`).

This design maps naturally onto the agent execution loop. At each decision point, the relevant triggers fire, predicates are evaluated, and enforcement actions execute — all before the agent's proposed action reaches the external world.

Key results from the AgentSpec evaluation:

- **Code execution agents**: Prevented unsafe executions in over 90% of cases across multiple agent frameworks.
- **Embodied agents**: Eliminated 100% of hazardous physical actions in simulation.
- **Autonomous driving**: Enforced 100% traffic law compliance.
- **Performance overhead**: Millisecond-scale latency, negligible compared to LLM inference.

Perhaps most significantly, AgentSpec includes automated rule generation: an LLM can read a natural-language safety policy and generate corresponding AgentSpec rules. Using OpenAI o1, this achieved 95.56% precision and 70.96% recall for embodied agent scenarios — suggesting that the gap between informal policies and formal specifications can be partially automated.

## VeriGuard: Offline Verification Meets Online Monitoring

Where AgentSpec focuses on runtime enforcement with user-defined rules, VeriGuard (Google Research, 2025) takes a dual-stage approach that combines offline formal verification with lightweight online monitoring.

**Stage 1 — Offline Verification**: Given a natural-language safety specification, VeriGuard synthesizes a behavioral policy as executable code. This policy is then subjected to both empirical testing (counterexample generation) and symbolic verification (formal proof of correctness). The iterative refinement loop continues until the policy is provably correct with respect to the specification.

**Stage 2 — Online Monitoring**: At runtime, each proposed agent action is checked against the pre-verified policy. Because the policy has already been proven correct, the runtime check is a simple function evaluation — no complex inference or LLM calls required.

This separation is architecturally elegant. The expensive formal verification happens once, offline. The runtime cost is minimal. On the Agent Security Bench (ASB), VeriGuard achieves a zero attack success rate while maintaining maximum task success rates — meaning safety comes without sacrificing capability.

## Agent Behavioral Contracts: Design-by-Contract for AI

The Agent Behavioral Contracts (ABC) framework, introduced in early 2026, brings the well-established Design-by-Contract paradigm from software engineering to autonomous AI agents. An ABC contract is a four-tuple `C = (P, I, G, R)`:

- **P (Preconditions)**: What must be true before the agent takes an action.
- **I (Invariants)**: What must remain true throughout the agent's execution.
- **G (Governance)**: Policy constraints on the agent's behavior (access control, rate limits, scope restrictions).
- **R (Recovery)**: What the agent must do when a contract violation is detected.

ABC is implemented in AgentAssert, a runtime enforcement library, and evaluated on AgentContract-Bench — a benchmark of 200 scenarios across 7 models from 6 vendors. The framework addresses a core problem: AI agents today operate on prompts and natural-language instructions with no formal behavioral specification, which is identified as the root cause of drift, governance failures, and project failures in agentic deployments.

A complementary framework, Agent Contracts by Ye and Tan (2026), focuses specifically on resource governance — formalizing constraints on token consumption, execution time, cost budgets, and delegation hierarchies. Together, these two contract frameworks cover both *behavioral* safety (what the agent does) and *resource* safety (what the agent consumes).

## Policy Cards: Machine-Readable Governance

Policy Cards extend the contract concept to organizational governance. A Policy Card is a versioned, machine-readable specification that defines:

- Operational rules and obligations
- Exception handling procedures
- Evidentiary requirements (what must be logged for audit)
- Assurance mappings (how compliance is demonstrated)

Policy Cards bridge the gap between human-readable compliance documents and machine-enforceable runtime policies. An organization's legal team writes the policy in structured natural language; the Policy Card format ensures it can be parsed and enforced by the agent runtime. This is particularly relevant for regulated industries where agent deployments must satisfy external audit requirements.

## Implications for Agent Runtime Architecture

These developments point toward a convergence in agent runtime design. The emerging architecture pattern includes several distinct layers:

**Specification Layer**: Safety properties expressed in temporal logic, behavioral contracts, or policy cards. These are authored by domain experts, potentially with LLM assistance for translation from natural language.

**Verification Layer**: Offline analysis of specifications — model checking for finite-state properties, theorem proving for more complex invariants, and test generation for empirical validation.

**Monitor Layer**: Lightweight runtime monitors synthesized from specifications. These sit on the critical path between agent decisions and action execution, operating at microsecond to millisecond latency.

**Enforcement Layer**: The mechanism that intercepts violations — blocking actions, triggering recovery procedures, alerting operators, or gracefully degrading capabilities.

**Audit Layer**: Complete action traces annotated with monitor verdicts, enabling post-hoc analysis and compliance reporting.

For systems like Zylos that employ a Session-Governor-Executor architecture, runtime verification maps naturally onto the Governor role. The Governor already mediates between high-level session goals and low-level executor actions; adding temporal logic monitors to this mediation layer provides formal guarantees without architectural disruption. The Governor becomes not just an orchestrator but a *verified* orchestrator — one that can prove, at every decision point, that the system's behavior satisfies its safety specification.

## Challenges and Open Problems

Despite rapid progress, several challenges remain:

**Specification Completeness**: Formal verification only guarantees properties that are specified. If the specification misses a safety concern, the monitor will not catch it. The automated rule generation in AgentSpec partially addresses this, but achieving high recall remains difficult.

**State Space Explosion**: As agent capabilities grow and action spaces expand, the state machines underlying monitors grow exponentially. Compositional verification — breaking properties into independent sub-properties that can be monitored separately — is essential but not always possible.

**Natural Language to Formal Logic**: The gap between how humans express safety requirements ("the agent should be careful with sensitive data") and formal temporal logic formulas remains significant. LLM-assisted translation shows promise but introduces its own reliability concerns — who verifies the verifier?

**Multi-Agent Composition**: Verifying individual agents is hard; verifying compositions of agents is harder by orders of magnitude. Strategic logics (ATL, ATL*) extend temporal logic to multi-agent settings, but practical tooling for LLM-based multi-agent systems is still nascent.

**Dynamic Environments**: Classical temporal logic assumes a fixed set of propositions. Real-world agent environments are open — new tools appear, APIs change, contexts shift. Adaptive monitoring that can update specifications without full re-verification is an active research frontier.

## Practical Takeaways

For teams building AI agent systems today, the research suggests several actionable strategies:

1. **Start with safety-critical sequences, not individual actions.** If your guardrails only look at one action at a time, you are missing the most dangerous failure modes. Identify multi-step sequences that constitute violations and encode them explicitly.

2. **Separate specification from enforcement.** Write your safety properties in a declarative format (AgentSpec rules, behavioral contracts, or even structured JSON) rather than embedding them in agent code. This enables review, versioning, and automated verification.

3. **Layer your monitoring.** Use lightweight runtime monitors for hard safety properties (must never be violated) and statistical monitoring for soft properties (should usually hold). Not every constraint needs formal verification.

4. **Invest in the audit trail.** Even if you cannot formally verify all properties today, logging complete action traces with monitor verdicts creates the foundation for post-hoc analysis and future verification as tooling matures.

5. **Watch the AgentSpec and ABC ecosystems.** These frameworks are rapidly maturing and represent the most practical path from research to production for runtime verification of AI agents.

## Conclusion

The convergence of runtime verification with AI agent systems represents a qualitative shift in how we think about agent safety. Rather than asking "does this agent usually behave well?" — the heuristic guardrail question — we can begin asking "can we prove this agent will always satisfy these properties?" — the formal verification question. The gap between these two questions is the gap between hoping and knowing, and the frameworks emerging in 2025–2026 are closing it faster than most practitioners realize.

The most important insight is architectural: runtime verification is not a bolt-on safety layer but a design principle. Agent systems built with temporal specifications from the ground up — where the Governor enforces verified behavioral contracts, where every action passes through a synthesized monitor, where the audit trail captures formal verdicts — are fundamentally different from systems where safety is an afterthought. As AI agents take on higher-stakes tasks, this difference will increasingly separate production-grade systems from prototypes.
