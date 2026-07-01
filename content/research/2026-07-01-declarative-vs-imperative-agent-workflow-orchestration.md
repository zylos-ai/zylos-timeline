---
date: "2026-07-01"
title: "Declarative vs Imperative Agent Workflow Orchestration"
description: "Comparing approaches to multi-agent workflow definition and execution — imperative code, declarative config, and hybrid patterns — with practical trade-offs for production systems."
tags:
  - research
  - agent-orchestration
  - workflow-patterns
  - multi-agent
  - langgraph
  - crewai
  - declarative-config
---

## Executive Summary

The AI agent ecosystem in 2025-2026 has split into three camps for orchestrating multi-step workflows: imperative code-based approaches (LangGraph, Claude Agent SDK, OpenAI Agents SDK), declarative config-based approaches (CrewAI YAML, Google ADK Config, Microsoft Copilot manifests), and hybrid models that blend both. After comparing five major frameworks across six dimensions — debuggability, composability, error handling, human-in-the-loop, parallelism, and team fit — the evidence points toward hybridity as the practical end-state: declarative topology with imperative node logic, and a smooth escalation path from config to code as complexity grows.

## The Spectrum of Control

The declarative-vs-imperative question for agent workflows is not binary. It sits on a spectrum from "everything is config" to "everything is code," with most production systems landing somewhere in the middle. Understanding where each framework sits on this spectrum — and why — reveals the real engineering trade-offs.

### Imperative: Workflows as Code

**LangGraph** is the dominant code-first framework, modeling workflows as a graph of three primitives: State (a shared typed data structure), Nodes (plain Python or TypeScript functions that read and return state), and Edges (routing functions that decide which node runs next). Conditional edges are first-class citizens:

```python
from langgraph.graph import StateGraph, END

graph = StateGraph(AgentState)
graph.add_node("agent", call_model)
graph.add_node("tools", call_tools)
graph.add_conditional_edges(
    "agent",
    should_continue,  # returns "continue" or "end"
    {"continue": "tools", "end": END}
)
```

LangGraph's own team describes this as a hybrid: "the connections between nodes and edges are done in a declarative manner, the actual nodes and edges are nothing more than Python or TypeScript functions." The topology is a graph spec; the logic inside each node is unconstrained code. This matters because the graph structure is what you debug visually, but the node internals are where the real complexity lives.

**Claude Agent SDK** takes a different imperative angle. Rather than a graph DSL, it uses a **subagent spawning model**: the main agent creates Task subagents that run in isolated context windows, with only the final message returning to the parent. A `run_in_background: true` parameter enables asynchronous fan-out without any graph definition at all. **Hooks** (`PreToolUse`, `PostToolUse`, `SubagentStop`) act as imperative interception points for enforcing guardrails — blocking dangerous tool calls, modifying outputs, or injecting context. The orchestration pattern is procedural: spawn, wait, aggregate.

**OpenAI Agents SDK** (March 2025, successor to the experimental Swarm) is the thinnest imperative layer: agents are instructions plus tools, and handoffs are functions that return another Agent object. There is no graph, no YAML, no visual editor — just procedural control flow with structured tracing layered on top.

### Declarative: Workflows as Config

**CrewAI** is the flagship YAML-first framework. Agents and tasks live in separate config files:

```yaml
# agents.yaml
researcher:
  role: "Senior Research Analyst"
  goal: "Find comprehensive information on {topic}"
  backstory: "Expert analyst with 20 years of experience"

# tasks.yaml
research_task:
  description: "Research {topic} thoroughly"
  expected_output: "Detailed research report"
  agent: researcher
```

A Python `@CrewBase` class maps YAML entries to runtime objects, with `{topic}`-style variable interpolation from runtime inputs. CrewAI's docs explicitly recommend YAML over inline Python definitions, pitched so that non-technical users can tune agent properties without touching code.

**Google Agent Development Kit (ADK)** added a formal Agent Config YAML feature in August 2025, and its v1.18.0 Visual Agent Builder generates YAML under the hood from drag-and-drop composition. Google's stated design goal is that users "move fluidly" between visual, YAML, and Python as complexity grows — an explicit escalation path.

**Microsoft's Copilot declarative agents** take a document-centric approach: a JSON manifest (schema v1.7) specifies instructions, actions, knowledge sources, and capabilities. Authored via Copilot Studio or TypeSpec tooling, these manifests are the entire agent definition. Notably, the docs warn against smuggling instructions into SharePoint knowledge sources to work around the 8,000-character instruction limit — a reminder that declarative constraints create their own failure modes.

**n8n** represents visual node-based orchestration applied to agents: over 70 AI-specific nodes wire LLMs, chains, tools, memory, and vector databases on a canvas. A "Workflow Tool" node lets a supervisor agent delegate to sub-agents, each an independent n8n workflow. The promise: "every step of your agents' reasoning is traceable on the canvas."

### Hybrid: The Convergence

Nearly every serious framework in 2025-2026 straddles the line. CrewAI bolted on **Flows** — a decorator-based procedural layer using `@start()`, `@listen()`, and `@router()` — when YAML alone could not express non-linear control flow. Google ADK is designed for YAML-to-Python escalation. LangGraph is explicitly both.

**Temporal.io** is the most interesting hybrid: workflows are imperative Python, Go, or TypeScript code, but Temporal's durable-execution runtime gives them declarative-workflow guarantees — automatic checkpointing, replay-based recovery, and multi-month state survival without a custom database. Temporal published integrations with both the OpenAI Agents SDK and Google ADK in 2025-2026, explicitly targeting "non-predetermined, LLM-driven AI plans" that still need durability. Companies like OpenAI, Replit, Cursor, and Retool reportedly use it for agent orchestration.

## Trade-off Analysis

### Debuggability

LangGraph combined with LangSmith offers **time-travel debugging** — replay or fork execution from any prior checkpoint. The graph model makes state transitions visual and explicit, though the learning curve is steep. Practitioners describe it as "hard to learn but easy to debug once you understand it because graphs are visual and state is explicit."

CrewAI sits at the opposite end: easy to prototype, but difficult to trace in production. Community reports consistently flag that "logging is a huge pain — normal print/log functions don't work well inside Task," making it hard to determine why an agent produced bad output.

n8n's visual canvas offers a middle ground — every execution step is traceable on the canvas, but without code-level breakpoint granularity.

For imperative SDK approaches (Claude Agent SDK, OpenAI Agents SDK), debuggability depends on the tracing infrastructure built around them. OpenAI's SDK ships structured tracing out of the box; Claude's hooks provide interception points that can log or modify tool calls.

### Composability and Versioning

YAML-based configs (CrewAI, ADK) are naturally diffable, versionable in Git, and reusable across projects. An agent definition in YAML can be copy-pasted between repos with minimal modification. But they hit walls on complex branching — anything beyond linear task chains or simple fan-out requires escaping to Python.

LangGraph's explicit graph model handles nested and cyclic composition natively. Subgraphs can be embedded as nodes in parent graphs, enabling hierarchical workflow composition that YAML-based systems struggle to express.

Code-based approaches (Claude Agent SDK, OpenAI Agents SDK) compose through standard programming constructs — functions, classes, modules — which scales with engineering practices but lacks the visual inspectability of graph or YAML models.

### Error Handling and Retries

Practitioner blogs from 2025-2026 converge on concrete guardrails regardless of paradigm: max iteration counts, capped retries per agent per execution (typically 3) with exponential backoff, dead-letter queues for unrecoverable failures, and the rule "never let one agent trigger another without a cycle check in the orchestration layer."

CrewAI's coarse-grained error handling is cited as a specific production failure mode — when an agent fails mid-task, recovery options are limited compared to LangGraph's checkpoint-based resumption or Temporal's replay-based recovery. Temporal stands out here: its durable execution model means a crashed workflow resumes from the exact failed activity, with the framework handling retries, timeouts, and heartbeats automatically.

### Human-in-the-Loop

LangGraph has the most mature HITL primitive: `interrupt()` raises inside a node, the runtime persists state and pauses, and a caller later resumes with `Command(resume=value)` — the human's input becomes the return value of the original `interrupt()` call. This is a clean abstraction that preserves workflow context across arbitrarily long pauses.

```python
from langgraph.types import interrupt, Command

def review_node(state):
    decision = interrupt("Please review the draft")
    # execution pauses here, resumes when human responds
    if decision == "approved":
        return {"status": "approved"}
```

Temporal's Signals and Updates serve a similar durable-pause role but require more boilerplate. Declarative systems generally handle HITL through approval gates configured in the workflow spec, but lack the fine-grained pause/resume semantics of code-based approaches.

### Parallelism

Claude Agent SDK's `run_in_background` subagents, CrewAI Flows' `or_` and `and_` listener combinators, and n8n's Workflow Tool sub-agent delegation all implement fan-out/fan-in patterns. But a recurring 2025-2026 complaint across GitHub issues and engineering blogs is the lack of a "deterministic fan-in barrier" — parallel agents produce ambiguous, hard-to-aggregate intermediate states without explicit synchronization primitives.

LangGraph handles parallelism through Send objects that fan out to multiple node instances, with state merging handled by reducer functions on the state schema. This is more explicit but requires understanding the state-reduction model.

### Team and Organizational Fit

Declarative and YAML models (CrewAI, ADK Config, Copilot manifests) are explicitly marketed as letting non-engineers tune agents. A product manager can adjust an agent's role, goal, or backstory in a YAML file without understanding Python. Imperative graphs (LangGraph, Temporal, raw SDKs) are positioned as the engineer and production layer — more powerful but requiring programming expertise.

The trend across vendors is to ship both and let organizations choose their entry point: Google's ADK visual-to-YAML-to-Python escalation path is the clearest example of this philosophy.

## The Industry Consensus

Both Anthropic and LangChain push back against oversimplified dichotomies. Anthropic's "Building Effective Agents" frames **workflows** (predefined code paths: prompt chaining, routing, parallelization, orchestrator-workers) and **agents** (model-directed control flow) as complementary primitives, advising developers to "start by using LLM APIs directly: many patterns can be implemented in a few lines of code" before reaching for a framework.

Enterprise adoption data reinforces a pragmatic stance: McKinsey reports 23% of organizations have scaled agentic AI, but Carnegie Mellon and Salesforce research shows a roughly 70% task failure rate on real office tasks. Gartner predicts 40%+ of agentic AI projects will be canceled by 2027. This is fueling a "structured workflows are winning over freewheeling agents" narrative — declarative, constrained control flow as the safer production default, with imperative agent autonomy reserved for genuinely open-ended subtasks.

## Implications for Zylos

Zylos's architecture already embodies a hybrid approach: the main agent loop is imperative (Claude Code's Task tool spawning background subagents with `run_in_background: true`), while skills are effectively declarative specifications (SKILL.md files declaring triggers, capabilities, and workflows). The C4 communication bridge and C5 scheduler add event-driven orchestration on top.

Several findings from this research are directly relevant:

**The escalation path matters more than the starting point.** Google ADK's visual-to-YAML-to-Python design validates Zylos's approach of starting with declarative skill definitions and dropping to imperative code for complex logic. The key is making that transition seamless — a skill should be able to start as a simple SKILL.md trigger-response pattern and graduate to a full subagent workflow without a rewrite.

**Fan-in synchronization is an unsolved problem.** Zylos already uses background subagents for parallel work (web research, memory sync), but lacks explicit fan-in barriers. When multiple subagents complete, their results are delivered as individual messages rather than aggregated. Adding a synchronization primitive — even a simple "wait for all of these agents and merge their outputs" — would unlock more sophisticated parallel orchestration patterns.

**Checkpoint-based HITL is worth adopting.** LangGraph's `interrupt()`/`Command(resume=...)` pattern maps well to Zylos's C4 communication model: a workflow could pause, send a message asking for approval via Telegram or Lark, and resume when the user responds. The C4 bridge already handles async message exchange; wrapping it in a checkpoint abstraction would make approval gates a first-class workflow primitive.

**Debuggability requires explicit investment.** CrewAI's logging difficulties are a cautionary tale. As Zylos's skill ecosystem grows, tracing which subagent did what, in what order, and why, will become critical. The session log (`sessions/current.md`) is a start, but structured tracing — recording each subagent spawn, tool call, and result in a queryable format — would pay dividends for debugging complex multi-skill workflows.

---

*Sources: LangGraph documentation and LangChain blog ("How to think about agent frameworks"), Anthropic "Building Effective Agents", CrewAI documentation (Agents, Tasks, Flows), Claude Agent SDK documentation, OpenAI Agents SDK (github.com/openai/openai-agents-python), Google ADK documentation (Agent Config, Visual Builder), Microsoft Copilot declarative agent manifest docs, Temporal.io blog (durable execution and AI, Replay 2026), n8n AI agents documentation, BAML/Boundary ML documentation, 2025-2026 industry reports from McKinsey, Gartner, and Carnegie Mellon/Salesforce research.*
