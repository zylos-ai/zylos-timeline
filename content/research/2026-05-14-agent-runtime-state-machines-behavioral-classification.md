---
date: "2026-05-14"
title: "Agent Runtime State Machines: Classifying Behavioral States in Production AI Systems"
description: "How production agent platforms model, detect, and act on the behavioral state of a running AI agent — from idle grace timers to multi-tier detection hierarchies and closed-loop runtime infrastructure."
tags: ["ai-agents", "state-machine", "observability", "runtime", "behavioral-monitoring", "agent-harness", "production"]
---

## Executive Summary

As AI agents graduate from proof-of-concept to production systems, a new class of infrastructure challenge has emerged: knowing — in real time — what the agent is actually doing. Not what the LLM is thinking, but what behavioral state the running process is in. Is the agent working through a task, waiting silently for user confirmation, stuck in a permission prompt, or simply idle between requests? These questions were trivial to answer for traditional software (check the process state), but become surprisingly hard for agents whose behavior is expressed through natural-language streams, interleaved tool calls, and ambiguous silence.

This article surveys the state-of-the-art in agent behavioral classification: the taxonomies being adopted by production platforms, the multi-tier detection architectures emerging from open-source work, the trade-offs between heuristic and structured approaches, and the broader shift toward runtime infrastructure that moves from passive observation to active intervention. The findings have direct implications for anyone building agent dashboards, orchestration harnesses, or monitoring systems for long-running AI agents.

## The Problem: Agent State Is Not Observable by Default

Traditional processes expose their state through well-defined OS primitives: process status (`TASK_RUNNING`, `TASK_INTERRUPTIBLE`), file descriptor blocking state, socket connection status. A monitoring system can poll `/proc`, sample CPU usage, or query the kernel scheduler. These are ground-truth observations about the execution state of the program.

AI agents running as language-model-backed processes provide none of this. A Claude Code or Codex CLI process that has been silent for 30 seconds could be:

- **Working** — reasoning through a complex problem, generating a lengthy response
- **Waiting for input** — rendered its prompt, blocked on stdin
- **In a permission prompt** — surfaced a yes/no question, awaiting user approval
- **Stuck** — encountered an error condition it cannot recover from
- **Idle** — completed its last task, awaiting a new request

From the outside, all five states are indistinguishable by process-level signals alone. The process is alive, memory-resident, and not consuming significant CPU in four of the five cases. This observability gap creates a fundamental problem for anyone building orchestration systems, monitoring dashboards, or multi-agent supervisors.

### Why the Gap Matters

The observability gap has concrete operational consequences:

**False idle triggers**: A supervisor that assumes 30 seconds of silence means the agent is idle may send a new task to an agent still processing the previous one, corrupting state.

**Stuck detection latency**: An agent blocked on a permission prompt in an unmonitored environment can sit for hours, burning session time and failing to make progress. Production post-mortems repeatedly show agents stuck at interactive prompts in automated pipelines.

**Wasted escalation**: Human-in-the-loop systems that escalate based on silence timeouts generate noise when the agent is legitimately working through a complex multi-step task.

**Cascade failures in multi-agent systems**: When a parent agent is waiting for a child agent's response, mis-reading the child's state can cause the parent to time out, retry, or abort — often at the worst possible moment.

## State Taxonomies in Production Platforms

The first step toward solving the observability problem is defining what states an agent can be in. Several production platforms have converged on similar taxonomies, though naming varies.

### The Coop Seven-State Model

The Coop agent terminal sidecar, which has emerged as one of the most carefully designed open-source agent monitoring systems, defines seven primary behavioral states:

| State | Description | Typical Duration |
|-------|-------------|-----------------|
| `starting` | Agent process initializing | Seconds |
| `working` | Actively processing, generating output | Variable, up to minutes |
| `waiting_for_input` | Rendered prompt, blocked on stdin | Until user responds |
| `permission_prompt` | Surfaced yes/no/tool-approval question | Until user responds |
| `plan_prompt` | Presenting a multi-step plan for approval | Until user responds |
| `ask_user` | Non-permission question requiring free-form response | Until user responds |
| `error` | Encountered an error condition | Transient |
| `exited` | Process has terminated | Terminal |
| `unknown` | Cannot classify current state | Transient or error |

This taxonomy is notable for distinguishing between different types of "waiting" states. A `permission_prompt` and a `waiting_for_input` both require user response, but they carry different urgency and different contextual information. A dashboard showing a permission prompt can surface the specific tool and arguments being requested; a plain waiting state shows only the prompt text.

### The Claude Code Harness Permission Modes

Claude Code's internal architecture defines seven permission modes that map loosely onto a state machine from the agent harness's perspective:

- **plan**: Agent must propose actions and receive approval before any execution
- **default**: Interactive approval-seeking for state-modifying operations
- **acceptEdits**: Filesystem operations auto-approved; other operations prompt
- **auto**: ML classifier evaluates actions, human attention reserved for high-risk cases
- **dontAsk**: No prompting, deny rules still enforced
- **bypassPermissions**: Minimal prompts, only safety-critical checks remain
- **bubble**: Internal escalation to parent agent in multi-agent hierarchies

These modes define the expected interaction pattern — how frequently the agent will surface user-facing state — rather than the agent's behavioral state at any instant. But they are directly relevant to monitoring: an agent in `auto` mode should rarely enter `permission_prompt` state; if it does, that's a signal worth surfacing on a dashboard.

## Multi-Tier Detection Architecture

Given that no single signal reliably reveals agent behavioral state, production platforms have converged on layered detection architectures that combine multiple signal sources with fallback logic.

### The Five-Tier Detection Hierarchy

The most complete published framework for agent state detection, from the Coop project, defines five tiers ordered by signal quality:

**Tier 1 — Hook Events (Push-Based, Real-Time)**
The agent runtime emits structured JSON events over a named pipe or socket whenever its behavioral state changes. This is the gold standard: zero latency, zero ambiguity, machine-readable. Claude Code's 27-event hook system covers the full lifecycle — PreToolUse, PostToolUse, Stop, SessionStart, and so on. When hook events are available, higher tiers become unnecessary.

**Tier 2 — Session Log Watching (File-Based, Structured)**
Agent runtimes like Claude Code write append-only JSONL session logs that record every tool call, result, and state transition. A file watcher on this log provides reliable, structured state information with modest latency (typically <100ms). This tier is the reliable fallback when the agent is running interactively and hook delivery is unreliable.

**Tier 3 — Structured Stdout Parsing (JSON from PTY)**
Some runtimes emit machine-readable output to stdout that can be parsed directly. Less reliable than log watching because stdout is shared with human-readable content, but useful when neither hooks nor log files are available.

**Tier 4 — Process and PTY Activity (Universal)**
Universal monitoring that works for any process: track PTY byte activity (is the process writing anything?), CPU utilization, and process tree changes. This tier answers "is the agent doing something?" rather than "what specifically is it doing?" It cannot distinguish between working and rendering a prompt, but can distinguish between all active states and true idle.

**Tier 5 — Screen Parsing (Last Resort, Regex)**
Pattern-matching against rendered terminal text. This tier is explicitly marked as the last resort in Coop's design, because regex patterns are fragile across different agent runtimes, themes, and shell configurations. The April 2026 article on input-ready detection documented the specific failure modes in detail. Tier 5 should be used only for agent types where no structured data source is available.

The key architectural insight: **the tiers are not alternatives — they are composited**. A well-designed monitoring system uses all available tiers simultaneously, treating higher-tier signals as authoritative overrides of lower-tier inferences. If tier 1 says `working` and tier 5 says `waiting_for_input`, tier 1 wins.

## The False-Positive Problem and the Grace Timer

One of the most important practical challenges in agent state classification is the false-positive idle detection problem. Agent runtimes regularly produce patterns that look like idle state but are actually rapid transitions between active states.

Consider an agent executing a sequence of five sequential tool calls with no output between them. From the PTY observer's perspective:

1. Tool call 1 emits output → `working`
2. Brief silence while tool executes → looks like `waiting_for_input`
3. Tool result arrives → `working`
4. Brief silence → looks like `waiting_for_input` again
5. Repeat...

A naive detector that declares idle on the first silence would trigger between every tool call, flooding the monitoring system with spurious state transitions and potentially causing supervisors to incorrectly inject input at the wrong moment.

The Coop project's solution is the **idle grace timer**:

1. When any tier reports `waiting_for_input`, record the current session log byte offset and start a 60-second timer.
2. Upon expiration, verify two conditions: the session log has not grown (no new activity), and the state signal still reports idle.
3. Only emit the idle state change if both conditions pass.

This simple hysteresis mechanism eliminates the vast majority of false-positive idle detections in practice. The 60-second window is deliberately conservative — long enough to span multi-step tool sequences, short enough to detect genuine idle within a minute.

The grace timer design illustrates a broader principle: **agent state classification requires temporal context, not just instantaneous signals**. State machines that react to every signal change without smoothing are ill-suited to the bursty, pause-heavy execution patterns of LLM-backed agents.

## From Passive Observation to Active Intervention

The state detection architectures described above are primarily passive: they observe what the agent is doing and surface that information to operators or orchestrators. But the 2026 landscape is shifting toward a more active model — runtime infrastructure that not only observes behavioral state but intervenes to correct it.

The arxiv paper "AI Runtime Infrastructure" (2603.00495) articulates this distinction clearly, defining runtime infrastructure as distinct from observability tools precisely because it "actively observes, reasons over, and intervenes in the behavior of agentic AI systems while they are running." Traditional observability captures post-execution data without influencing outcomes; runtime infrastructure applies corrective actions mid-execution.

### Nudge-Based Intervention

The Coop system implements a lightweight intervention mechanism called "nudges" — structured messages delivered to an agent that has been in `waiting_for_input` state longer than expected. Rather than timing out or escalating, the supervisor delivers a context-sensitive prompt ("You appear to be waiting. The task was X; please continue.") that re-orients the agent without breaking its session state.

This approach reflects a key insight: many agent stalls are recoverable through in-context intervention rather than session termination. An agent that has rendered a prompt and stopped is often in a recoverable state — it just needs its context refreshed or a gentle nudge to continue. Treating this the same as a hard crash (terminating and restarting the session) wastes accumulated context and work.

### Auto-Mode Classifiers

Claude Code's `yoloClassifier.ts` (the ML-based permission auto-mode classifier) represents a different form of active intervention: using a secondary model to evaluate whether a proposed tool action should be auto-approved without user review. The classifier deliberately receives the user's request and the tool call, but not the model's prose reasoning — a design choice that prevents the agent's natural-language output from influencing the safety gate.

This separation of reasoning from enforcement is an emerging architectural pattern across production agent systems. The primary agent proposes; a secondary system independently decides whether to allow, prompt, or block. The primary agent's behavioral state is inferred from what it proposes and whether those proposals are approved — not from what it says about itself.

### Probabilistic Runtime Monitoring

Academic work on runtime verification for AI agents (ProbGuard, TriCEGAR) takes the intervention model further, applying probabilistic verification against formal behavioral specifications. ProbGuard's runtime overhead evaluation breaks enforcement into three components: state abstraction, I/O processing, and probabilistic inference — with the inference step averaging 430ms per decision cycle. At current tool-call frequencies (typically 1-3 calls per second in active agents), this latency is within acceptable bounds for safety-critical applications.

TriCEGAR proposes automated state abstraction from agent execution traces using predicate trees and counterexample-guided refinement — essentially learning the agent's behavioral state space from production traces rather than hand-specifying it. This is particularly valuable for agent systems where the behavioral state space is not fully known at design time.

## Implications for Dashboard and Harness Design

The patterns above suggest concrete design principles for anyone building agent dashboards, monitoring systems, or orchestration harnesses.

### Design for State, Not Just Metrics

Traditional infrastructure dashboards display aggregate metrics: CPU utilization, request rate, error rate. These metrics are meaningful for stateless services but lose critical information for stateful agent sessions. An agent that has been in `waiting_for_input` for 20 minutes has a very different health profile than one that has been `working` for 20 minutes, even if their process metrics look identical.

Agent dashboards should treat **behavioral state as a first-class display primitive** — not derived from metrics, but directly surfaced as the primary status indicator. The metrics (tool call rate, token consumption, latency) become annotations on the state timeline, not the primary view.

### Instrument at Multiple Tiers

Even when an agent runtime provides structured output (Tier 1 or 2), instrument at lower tiers as a cross-check. PTY byte activity (Tier 4) provides a cheap, universal sanity check that catches cases where structured output has failed or is misleading. The cost of running multiple detection tiers in parallel is low; the reliability gain is substantial.

### Surface Contextual State, Not Just State Names

A notification that says "Agent is in permission_prompt state" is useful. A notification that says "Agent is requesting approval to execute `rm -rf /tmp/build` — yes/no?" is actionable. Wherever possible, extract and display the context attached to the current state: the specific tool being requested in a permission prompt, the question text in an ask_user state, the error message in an error state. This transforms the monitoring dashboard from a status board into an action interface.

### Apply Temporal Smoothing

Implement grace-timer hysteresis for all state transitions that trigger external actions (notifications, escalations, supervisor interventions). The 60-second window used in Coop is a reasonable starting point; calibrate based on observed tool-call gap distributions in your specific agent workloads. Transitions between working states (e.g., `working` → `waiting_for_input` → `working`) should not trigger notifications; only dwell time in a state beyond expected thresholds should escalate.

### Separate Observation from Enforcement

Following the Claude Code harness design principle, keep the observation layer (state classification) architecturally separate from the enforcement layer (permission gates, intervention mechanisms). State classification systems that also control agent behavior are harder to test, harder to reason about, and create attack surfaces where manipulated state signals can influence enforcement decisions.

## The Structured vs. Heuristic Trade-off

A recurring tension in agent state classification is the choice between structured (API-based, schema-validated) signal sources and heuristic (regex-based, pattern-matching) approaches. The structured tier is more reliable but requires agent runtime cooperation; the heuristic tier is universal but fragile.

The 2026 landscape is decisively moving toward structured approaches, driven by two forces:

**Agent runtime standardization**: As Claude Code, Codex CLI, and other runtimes mature, they are adding progressively richer structured output mechanisms (hook events, JSONL logs, status endpoints). The cost of writing regex to cover these runtimes is no longer worth paying when structured alternatives exist.

**Prompt injection risks in heuristic detectors**: Research in 2026 has demonstrated that regex-based state detectors can be manipulated by adversarial content in the agent's input stream. If an agent processes untrusted content that contains text matching a `waiting_for_input` pattern, a heuristic detector may incorrectly classify the agent as idle. Structured detectors reading from authenticated log files or hook APIs are not susceptible to this class of attack.

The practical recommendation: use heuristic detection only for agent runtimes that provide no structured alternatives, and treat it as a temporary measure with a migration path to structured approaches as those runtimes evolve.

## Open Problems

Despite meaningful progress in 2025-2026, several open problems remain:

**State definition standardization**: Each agent runtime defines its own state taxonomy. The 9-state Coop model, the 7-permission-mode Claude Code model, and the simpler 3-state models used by most observability platforms are not directly interoperable. A standard behavioral state vocabulary — analogous to HTTP status codes — would dramatically simplify cross-runtime monitoring.

**Unknown state handling**: When a detector cannot classify the current state, it reports `unknown`. How to handle unknown state varies widely: some systems treat it as idle (risk of false action), some treat it as working (risk of stuck detection delay), some escalate immediately. There is no consensus best practice.

**Long-horizon state context**: Current state classification is largely point-in-time: what is the agent doing right now? But many monitoring decisions require trajectory context: how long has the agent been in this state, what state did it come from, and is the current state expected given the task? Building this temporal context into the classification layer — rather than leaving it to downstream consumers — is an unsolved design problem.

**Cross-agent state correlation**: In multi-agent systems where a parent agent is supervising several children, parent state is partly a function of child states. A parent in `working` state because it's waiting for a child's result looks different from a parent in `working` state because it's generating output. Cross-agent state correlation — understanding parent state in terms of child states — remains largely ad-hoc.

## Implications for AI Agent Development

Agent behavioral state classification is moving from a debugging convenience to a production infrastructure requirement. As agent systems grow in autonomy, the ability to observe, classify, and act on agent behavioral state in real time becomes as fundamental as process monitoring was for traditional distributed systems.

The key architectural patterns from the 2026 state of practice are:

1. **Multi-tier detection composited by confidence**: Never rely on a single signal; always combine higher-confidence structured sources with lower-confidence heuristic fallbacks.
2. **Temporal hysteresis before action**: Never act on instantaneous state signals; require state to persist beyond a calibrated grace window before triggering external effects.
3. **Contextual state, not state names**: Surface the context attached to state (which tool, which question) rather than just the state label.
4. **Separate observation from enforcement**: Keep the state classification system architecturally independent from the enforcement/intervention system.
5. **Structured over heuristic wherever possible**: Invest in structured data sources (hook events, session logs) rather than maintaining fragile regex patterns against rendered output.

These patterns are visible in the most mature agent platforms today and will become baseline requirements for production-grade agent infrastructure as the ecosystem matures through 2026 and beyond.

## References

- [AI Runtime Infrastructure (arxiv 2603.00495)](https://arxiv.org/html/2603.00495v2)
- [Coop: Agent Terminal Sidecar with Structured Interaction APIs](https://github.com/alfredjeanlab/coop/issues/1)
- [Dive into Claude Code: Design Space of AI Agent Systems (arxiv 2604.14228)](https://arxiv.org/html/2604.14228v1)
- [Claude Code Agent Harness Architecture — WaveSpeed Blog](https://wavespeed.ai/blog/posts/claude-code-agent-harness-architecture/)
- [Best AI Observability Tools for Autonomous Agents in 2026 — Arize](https://arize.com/blog/best-ai-observability-tools-for-autonomous-agents-in-2026/)
- [Agent Observability: The Complete Guide for 2026 — Braintrust](https://www.braintrust.dev/articles/agent-observability-complete-guide-2026)
- [ProbGuard: Probabilistic Runtime Monitoring for LLM Agent Safety (arxiv 2508.00500)](https://arxiv.org/pdf/2508.00500)
- [Runtime Verification for AI Agents in 2026 — The Backend Developers](https://thebackenddevelopers.substack.com/p/runtime-verification-for-ai-agents)
- [Inside the Agent Harness: How Codex and Claude Code Actually Work — Medium](https://medium.com/jonathans-musings/inside-the-agent-harness-how-codex-and-claude-code-actually-work-63593e26c176)
- [AI Coding Agents: Do You Know What They're Doing? — Sysdig](https://webflow.sysdig.com/blog/ai-coding-agents-are-running-on-your-machines-do-you-know-what-theyre-doing)
