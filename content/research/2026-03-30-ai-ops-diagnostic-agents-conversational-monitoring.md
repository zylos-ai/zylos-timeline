---
date: "2026-03-30"
title: "AI Agent Diagnostic and Self-Healing Systems: Conversational Ops Agents for Production Monitoring"
description: "How production platforms build diagnostic agents that inspect and troubleshoot other AI agents. Covers Datadog Bits AI, PagerDuty multi-agent ops, container inspection tools, system prompt design for diagnostics, permission scoping, conversational UX patterns, and three-tier self-healing escalation."
tags: ["ai-agents", "ops", "monitoring", "diagnostics", "self-healing", "production-engineering", "observability"]
---

## Executive Summary

The pattern of "agents that monitor and diagnose other agents" has moved from experimental to production in 2025-2026. Datadog's Bits AI SRE (GA December 2025) maps agent decision graphs with interactive drill-down into tool calls and latency spikes. PagerDuty's multi-agent suite (expanded March 2026 with MCP integration) reports 50% faster incident resolution. The open-source n8n + Claude pattern delivers 30-second per-alert analysis via webhook-triggered LLM workflows. The key architectural insight: diagnostic agents should receive preprocessed execution DAGs rather than free-text runbooks, eliminating step-skipping and query hallucination. Permission scoping follows a three-model hierarchy with dedicated agent identity as the production standard. Self-healing follows a universal three-tier escalation: auto-heal (restarts, rollbacks) → alert-and-propose (human approves) → escalate (page on-call). The most critical safety mechanism is restart loop prevention — if a process oscillates faster than the cooldown window, escalate rather than continue restarting.

## Production Examples

### Datadog Bits AI SRE

The most fully-featured production diagnostic agent. Maps each monitored agent's decision graph — inputs, tool calls, calls to other agents, outputs — in an interactive visualization. Engineers drill into latency spikes, incorrect tool calls, and infinite loops. The AI Agents Console extends monitoring to any agent in the enterprise stack (Operator, Cursor, Copilot, internal agents), not just Datadog-instrumented ones.

### PagerDuty Multi-Agent Suite

Takes a dedicated-role approach with three specialized agents: SRE Agent (investigate and remediate), Scribe Agent (transcript and summary), and Insights Agent (proactive analytics). March 2026 expansion added MCP integration with 30+ DevOps tool APIs. Reported outcomes: 50% faster incident resolution.

### n8n + Claude (Open Source)

The most accessible implementation: webhook from Alertmanager → n8n orchestration → LLM agent with MCP tools (Grafana, Kubernetes, GitLab, Qdrant for runbook retrieval) → Slack thread. Approximately 30 seconds per alert analysis. Completely read-only; humans decide and act.

### Shadow Sentinel Pattern

An agent-that-monitors-agents: a dedicated 4th process running 13 health checks every 10 seconds against 3 other agents. Detection latency dropped from hours to 10 seconds; crash recovery from manual intervention to under 30 seconds automated.

## Container and Process Inspection Tools

The standard toolkit for diagnostic agents inspecting AI agent containers:

| Tool Category | Examples | What It Reveals |
|--------------|---------|-----------------|
| Process state | PM2 status, K8s pod events, Docker metrics | Is the agent alive, restarting, OOM? |
| Logs | KQL queries, Grafana Loki, structured search | What errors occurred, what was the agent doing? |
| Metrics | Prometheus time-series, rolling baselines | CPU/memory trends, anomaly detection |
| Agent-specific | tmux session capture, context window usage, tool call history | What the agent is actually doing right now |

The **agent-tmux-monitor (ATM)** project is directly relevant to Zylos-style agents: it hooks Claude Code's PreToolUse/PostToolUse events at approximately 300ms intervals via Unix socket, capturing context window usage, tool call history, active/idle state, and cost — with zero performance overhead on the monitored agent.

MCP is becoming the integration standard for diagnostic agent tooling — it provides natural permission scoping while giving access to Kubernetes, cloud APIs, CI/CD, and monitoring systems through a unified interface.

## System Prompt Design for Diagnostic Agents

Production implementations converge on a five-section structure:

1. **Role definition**: "You are an automated first-response diagnostic agent for AI employee infrastructure."
2. **Infrastructure context**: Service topology, ownership, SLAs — can be dynamically injected from a configuration database.
3. **Tool descriptions with sequencing guidance**: Not just what tools exist, but when to query each source and in what order (check process status before reading logs; check logs before querying metrics).
4. **Diagnostic workflow**: Sequential or conditional logic encoding SRE expertise. Encode as an execution DAG, not free text.
5. **Explicit guardrails**: "Never modify infrastructure. Never ask clarifying questions during automated triage. Deliver a diagnostic report."

### Execution DAGs Over Free-Text Runbooks

Research from StepFly (academic paper on automated ops agents) found that preprocessing runbooks into execution DAGs dramatically improves diagnostic accuracy. The agent receives only the current DAG node plus execution history, preventing step-skipping and out-of-order execution. Pre-extracting query templates (KQL, PromQL) at preprocessing time rather than letting the agent generate them at runtime eliminates a major hallucination failure mode.

## Permission Scoping

Three models exist, with dedicated agent identity as the production standard:

| Model | Description | Use Case |
|-------|------------|----------|
| Shared service account | Single credential for all agents | Read-only prototypes only |
| Delegated user access | Agent inherits user's permissions | Personal assistant agents |
| **Dedicated agent identity** | Agent has its own identity and scoped permissions | Production ops agents |

Environment-based autonomy tiers (from the Rootly pattern): Development environments allow auto-implementation of approved changes. Staging requires team lead approval. Production requires engineering review before any write operation.

Critical principle: if an agent only has read rights, write tools should not be offered in its tool registry at all — not just blocked at execution, but absent from the tool list entirely. Enforce scope at runtime, not just configuration time.

## Conversational Diagnostics UX

The shift from dashboards to chat-native ops is driven by three factors:

**Conversation as incident record**: When the ops agent lives in the Slack or Lark incident channel, the conversation thread automatically captures every action, alert, finding, and decision. No separate ticketing system needed; postmortem reconstruction comes for free.

**Reduced cognitive load**: Dashboard monitoring requires engineers to synthesize multiple signals. The diagnostic agent synthesizes and presents conclusions; the engineer decides. Measured as 4.87 hours saved per incident on average (SolarWinds 2025 study).

**Action cards in conversation**: Beyond text replies, agents dynamically render interactive option cards in the conversation thread for binary decisions (restart service, rollback deployment, escalate to human), eliminating typing overhead during high-stress incidents.

## Self-Healing Patterns

### Three-Tier Escalation (Universal Pattern)

**Tier 1 — Auto-heal**: Process restart, task rollback, log rotation, scaling within predefined limits. Rate-limited by cooldown window. No human involvement.

**Tier 2 — Alert and propose**: Send diagnostic report with proposed remediation to the responsible human. Human approves or rejects. Agent executes only after approval.

**Tier 3 — Escalate**: Page on-call with full diagnostic context. Block further auto-healing until a human explicitly clears the incident.

### Restart Loop Prevention

The most important safety mechanism: if a process oscillates between online and errored states faster than the cooldown window, the system must escalate rather than continue restarting. Track restart count per time window; reset the counter only after the process survives one full health check cycle after recovery.

### Phased Deployment

Consistently recommended across all documented systems: start with read-only monitoring → add safe and reversible auto-remediations (restarts, scale-up) → expand gradually as each action type proves reliable in production. Never deploy write capabilities before read-only has been validated.

## Implications for AI Employee Platforms

1. **Start with a read-only diagnostic agent** that can inspect container state, read tmux sessions, check process health, and review logs. Read-only is safe and immediately valuable.

2. **Use execution DAGs** for diagnostic workflows rather than free-text instructions. Pre-extract query patterns. This dramatically reduces diagnostic hallucination.

3. **Dedicated agent identity** with explicit tool scoping. The ops agent should have its own identity visible in audit trails, separate from the AI employees it monitors.

4. **Conversation-native entry point** — embed the diagnostic agent in the same interface where users manage their AI employees. The conversation becomes the incident record.

5. **Restart loop prevention is non-negotiable** as a safety mechanism before enabling any auto-remediation. Without it, a flapping agent can consume unbounded resources.

6. **MCP as the tool integration layer** — diagnostic agents need access to diverse systems (process managers, log stores, metrics, cloud APIs). MCP provides the unified permission-scoped interface.

## Sources

- Datadog: Bits AI SRE and AI Agents Console documentation
- PagerDuty: AI Agent Suite and March 2026 MCP expansion
- n8n: Building an AI-Powered SRE Agent with MCP Tools
- StepFly: Execution DAG preprocessing for ops agents (arXiv)
- Shadow Sentinel: Agent-monitoring-agents pattern documentation
- agent-tmux-monitor (ATM): Claude Code inspection via Unix socket
- Rootly: Environment-based autonomy tiers for ops agents
- SolarWinds: 2025 incident resolution time study
