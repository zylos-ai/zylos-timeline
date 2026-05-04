---
date: "2026-04-24"
title: "Agent Runtime State Reconciliation"
description: "Why long-running AI agent platforms need reconciliation loops across databases, payments, cloud resources, credentials, and live process state."
tags: ["ai-agents", "agent-runtime", "reconciliation", "control-plane", "operations"]
---

## Executive Summary

Long-running AI agent platforms do not fail only when an LLM call errors. They fail when separate control planes disagree: Stripe says a subscription is active while the product database says canceled, a VM exists but the orchestrator has lost its mapping, a credential pool thinks a token is usable while the live runtime is rate-limited, or an agent process is still "running" while it is stuck between tool calls. The production pattern that addresses this class of failures is state reconciliation: continuously comparing desired state, recorded state, provider state, and live runtime state, then applying safe, idempotent repair actions.

Kubernetes made this pattern mainstream through controllers that move current cluster state toward desired state. Terraform and HCP Terraform apply the same idea to infrastructure drift and continuous validation. Stripe's subscription guidance shows why SaaS access control cannot rely on a single checkout or webhook event; it must monitor subscription transitions and update internal access state correctly. Temporal shows the complementary pattern for long-running workflows: durable execution preserves progress through crashes and outages. For AI agent systems, these ideas converge into an "agent runtime reconciler" that treats every agent as a stateful resource, not a best-effort process.

The practical recommendation for Zylos/COCO is to promote reconciliation from an ops script into a first-class runtime subsystem. Each agent should have a declared desired state, a materialized database state, external provider bindings, and observed live state. Reconcilers should detect drift, classify it, repair only when ownership is clear, and record every repair as an auditable event.

## Why This Matters For Agent Platforms

Traditional SaaS control planes already suffer from state drift, but AI agents multiply the problem because they span more mutable surfaces:

- **Payment state**: checkout sessions, subscriptions, invoices, trial status, internal entitlements, usage caps.
- **Runtime state**: PM2/tmux/container status, agent heartbeat, current turn, pending tool calls, stuck processes.
- **Cloud state**: VM existence, disks, snapshots, DNS records, firewalls, service accounts, secret permissions.
- **Credential state**: model API keys, OAuth tokens, pool assignment, rate limits, account bans, quota reset times.
- **User-visible state**: app dashboard, support console, messaging channels, delivery receipts, audit logs.

If these states are updated only by request handlers or webhooks, they eventually diverge. Webhooks retry, but they are not a complete consistency model. Human operators patch databases. Cloud resources are recreated manually. Agent processes hang without exiting. A customer sees "paid" in one system and "not provisioned" in another.

The agent-specific risk is worse than a stale dashboard. Agents perform side effects: sending messages, creating files, charging usage, invoking tools, modifying repositories, and provisioning infrastructure. A stale agent state can therefore create duplicate actions, silent denial of service, lost work, or unauthorized continued access.

## The Reconciliation Pattern

Kubernetes describes controllers as control loops that watch cluster state and make or request changes where needed; each controller tries to move current state closer to desired state. Kubernetes also distinguishes controllers that act inside the cluster from controllers that interact with external systems, then report current state back through the API server. This matters for agent platforms because many important resources are external: Stripe subscriptions, cloud VMs, DNS records, OAuth providers, model vendors, and messaging platforms.

A minimal reconciliation loop has four jobs:

1. **Read desired state**: what the product intends to exist.
2. **Read actual state**: what internal DBs, providers, and live processes report.
3. **Diff and classify**: decide whether the mismatch is harmless lag, recoverable drift, dangerous inconsistency, or unknown ownership.
4. **Converge or escalate**: run an idempotent repair, mark pending, or page a human.

The key is not "automatically fix everything." Terraform's drift guidance explicitly separates cases where you overwrite drift from cases where you update configuration to accept the real-world change. Agent platforms need the same discipline. Some drift means "the runtime is wrong, fix it"; other drift means "the database is stale, import reality"; some means "ownership is ambiguous, stop before doing harm."

## Lessons From Adjacent Systems

### Kubernetes Controllers: Desired State Is A Resource

Kubernetes controllers work because desired state is represented explicitly in API objects, while controllers keep working even as the cluster changes constantly. Kubernetes documentation emphasizes that clusters may never reach a perfectly stable state, but as long as controllers keep making useful changes, the system can remain healthy.

For Zylos, this suggests modeling agents as declarative resources:

```text
AgentDesiredState
  tenant_id
  agent_id
  plan / entitlement
  runtime_target
  model_policy
  channels
  tool_permissions
  desired_lifecycle_state
```

The live process is not the source of truth. Neither is a Stripe event, a PM2 row, or a support ticket. Each is an observation. The reconciler owns the comparison.

### Terraform Health: Drift Detection Is Separate From Repair

HCP Terraform describes drift detection as identifying when real infrastructure no longer matches configuration. It also distinguishes drift detection from continuous validation, where assertions continue to check whether provisioned resources behave correctly. That distinction is directly useful for agent systems:

- **Drift detection**: the VM exists but is not in DB; DB says subscription canceled but Stripe says active; DNS record points to a deleted instance.
- **Continuous validation**: the agent responds within SLO; webhook delivery works; model credential can complete a probe; provision API returns 200.

Both are needed. A VM can match declared infrastructure and still fail health validation. A model account can exist and still be unusable because it is rate-limited. A support channel can be configured and still fail delivery.

### Stripe Billing: Webhooks Are Notifications, Not The Whole State Machine

Stripe's subscription webhook documentation is a reminder that subscription state is a lifecycle, not a single event. Stripe emits events when subscriptions are created, updated, deleted, paused, resumed, when invoices are paid or fail, and when entitlements change. Stripe also recommends monitoring status transitions and revoking access when subscriptions become canceled or unpaid.

For an AI agent SaaS, the safe architecture is:

- store Stripe object IDs as durable foreign keys;
- process webhook events idempotently;
- replay events safely;
- periodically reconcile active subscriptions and entitlements against internal DB state;
- make provisioning decisions from an internal entitlement model that can be audited.

Checkout sessions should not be allowed to become shadow subscriptions. A reconciler should detect "Stripe active, DB canceled", "DB active, Stripe canceled", "multiple open checkout sessions for one hire flow", and "entitlement exists but no runtime instance."

### Temporal: Long-Running Work Needs Durable Progress

Temporal's core promise is crash-proof execution: applications resume where they left off after crashes, network failures, or infrastructure outages, even when the workflow lasts days or years. Agent runtimes need this same mindset, even if they do not adopt Temporal itself.

An agent action often spans several non-atomic steps:

```text
collect user intent
reserve entitlement
create VM
write DB mapping
configure DNS
inject credential
start agent process
send welcome message
```

If step 5 succeeds and step 6 fails, a request handler cannot just return 500 and forget. The workflow needs a durable record of progress, retries, and compensation. This is where durable execution and reconciliation complement each other: workflows track the intended transaction; reconcilers detect and repair whatever the workflow left behind.

### Recent Research: AI Can Help Reconcile, But Must Be Verified

A 2025 arXiv paper on automated IaC reconciliation proposes using cloud API traces to infer out-of-band changes and update Terraform programs accordingly. Its reported experiments across five Terraform projects and 372 drift scenarios improved pass@3 from 0.71 to 0.97 while improving token efficiency. The lesson is not simply "let an LLM fix infrastructure." The stronger lesson is that reconciliation benefits from intent inference when raw provider events are noisy.

A 2026 arXiv paper, RIVA, is even more relevant to agent systems: it argues that agentic systems often assume tool outputs are correct, which makes them vulnerable when tools return erroneous or misleading outputs. RIVA uses cross-validation, tool-call history, and specialized verifier agents; under erroneous tool responses, it improved task accuracy from 27.3% for a baseline ReAct agent to 50.0% on average.

This is a useful warning for Zylos. A self-healing agent cannot trust a single diagnostic command. If `pm2 status`, Stripe, DB, and the orchestrator disagree, the reconciler should cross-check instead of blindly following whichever tool answered last.

## A Reference Model For Agent Runtime Reconciliation

Agent platforms need multiple reconcilers, each with a narrow ownership boundary. A single "fix everything" daemon becomes unsafe and impossible to reason about.

| Reconciler | Desired state | Actual state sources | Safe repair examples |
|---|---|---|---|
| Entitlement reconciler | Internal plan, subscription, credit, seat state | Stripe, DB, usage ledger | update entitlement, revoke access, flag orphan subscription |
| Runtime reconciler | agent should be running/stopped | PM2/tmux/container, heartbeat, last turn state | restart process, mark stuck, enqueue recovery |
| Orchestrator reconciler | VM/container/DNS/secret bindings | cloud API, orchestrator DB, DNS provider | recreate missing binding, quarantine orphan VM |
| Credential reconciler | assigned model account/key and quota policy | provider probe, pool DB, recent errors | rotate key, mark rate-limited, downgrade model route |
| Channel reconciler | expected Telegram/Lark/WeChat bindings | channel API, delivery logs, webhook status | refresh binding, disable broken route, notify owner |
| Workflow reconciler | in-flight hire/provision task graph | workflow log, DB rows, external resources | retry from checkpoint, run compensation, escalate |

The table also implies a product requirement: every repair needs a reason code, actor, before/after state, and confidence level. Without that audit trail, self-healing becomes indistinguishable from silent corruption.

## Drift Taxonomy For Agents

Not all drift should trigger the same action.

### 1. Missing Internal State

An external resource exists, but the product DB has no durable row. Examples: an active Stripe subscription without a local entitlement; a VM tagged with a tenant but missing from orchestrator DB; a DNS record pointing to an existing instance unknown to the app.

Default action: import or quarantine. Do not delete automatically unless ownership and age are clear.

### 2. Missing External State

The DB says a resource should exist, but the provider does not show it. Examples: DB says agent is running, but PM2 process is gone; subscription active locally but not active in Stripe; assigned model key missing from pool.

Default action: recreate if idempotent; otherwise mark degraded and escalate.

### 3. Conflicting State

Two systems disagree on a meaningful status. Examples: Stripe active vs DB canceled; VM running vs orchestrator status deleted; channel delivered vs support console says no response.

Default action: choose an authority per field, not per system. Stripe may be authoritative for payment collection; internal entitlements may be authoritative for access policy; provider probes may be authoritative for current key usability.

### 4. Stuck Progress

No system is logically inconsistent, but progress has stopped. Examples: agent stuck in a long tool call; provisioning workflow stuck after DNS but before welcome message; checkout session expired but user remains in pending setup.

Default action: recover from durable checkpoint, not from logs alone.

### 5. Unsafe Ambiguity

The reconciler cannot determine ownership or intent. Example: a VM looks like an agent instance but lacks a tenant tag; a manual DB patch changed state without an audit event.

Default action: stop, quarantine, and create a human review item.

## Implementation Pattern

A practical reconciler loop can start simple:

```text
every N minutes:
  load candidate agents / tenants / subscriptions
  fetch provider snapshots with bounded concurrency
  compute normalized observations
  diff against desired state and last known state
  classify drift with reason codes
  execute idempotent repairs allowed by policy
  write reconciliation events
  emit metrics and alerts
```

Important details:

- **Use stable IDs**: store provider object IDs, workflow IDs, VM IDs, DNS record IDs, and credential IDs. Names and emails are not enough.
- **Separate observation from repair**: first write what was observed; then decide whether to repair.
- **Make repairs idempotent**: the same repair should be safe to retry after a crash.
- **Use leases**: only one reconciler should repair a given resource at a time.
- **Add confidence levels**: high-confidence drift can repair automatically; medium confidence can require approval; low confidence should only alert.
- **Protect user-facing side effects**: never resend messages, charge, delete data, or rotate credentials without idempotency keys and audit trails.
- **Expose operator views**: support and DevOps need to see "why this agent is degraded" without reading raw logs.

## Metrics That Matter

Agent runtime reconciliation should be measured directly.

| Metric | Why it matters |
|---|---|
| drift_detected_total by type | Shows where state divergence is coming from |
| drift_repaired_total by policy | Measures automatic recovery effectiveness |
| repair_confidence_distribution | Prevents unsafe automation creep |
| orphan_resource_count | Finds leaked VMs, subscriptions, DNS records, credentials |
| stuck_workflow_count | Captures long-running tasks that are not making progress |
| mean_time_to_converge | Measures how quickly the system returns to intended state |
| repeated_drift_rate | Identifies broken upstream workflows, not just one-off incidents |
| manual_patch_without_event_count | Detects dangerous invisible operations |

The highest-signal metric is repeated drift. If the same class of mismatch is repaired every day, the reconciler is hiding a product or workflow bug.

## What Zylos Should Build First

The first version does not need a full Kubernetes-style API server. It needs a small set of high-value reconcilers around the most failure-prone seams.

### Phase 1: Read-Only Drift Report

Build a scheduled job that compares:

- internal entitlement rows vs Stripe subscriptions;
- orchestrator DB vs actual VM/container inventory;
- PM2/tmux/container status vs agent heartbeat;
- credential pool assignment vs provider probe results;
- channel bindings vs recent delivery failures.

Output a daily and on-demand drift report with reason codes. No automatic repair yet.

### Phase 2: Safe Repairs

Allow only repairs that are idempotent and low risk:

- mark model credential rate-limited after repeated provider errors;
- restart a process if heartbeat is stale and no active tool call is recorded;
- expire stale checkout sessions that are not tied to an internal subscription;
- restore missing runtime status from a provider resource with strong tenant tags.

### Phase 3: Workflow Checkpoints

Move hire/provision/reconfigure flows onto durable workflow records. Every external side effect should have:

- idempotency key;
- provider object ID;
- forward action;
- compensation action if applicable;
- current checkpoint;
- audit event.

### Phase 4: Verified Agentic Repair

Only after deterministic reconcilers are mature should LLM agents assist with diagnosis. Their role should be to summarize evidence, infer possible intent, and propose repairs. Execution should remain policy-gated and cross-validated by deterministic probes.

## Strategic Takeaway

For agent companies, reliability will not come from better prompt retries alone. It will come from treating every agent as a reconciled resource with explicit desired state, observed state, ownership boundaries, and repair policy.

The winning architecture is not "one smart agent fixes ops." It is a set of boring reconcilers, durable workflows, idempotent external calls, and auditable repair events, with LLMs used where ambiguity and diagnosis actually benefit from language reasoning.

That is the difference between a demo fleet of agents and an enterprise agent cloud.

## Sources

- [Kubernetes Controllers](https://kubernetes.io/docs/concepts/architecture/controller/) — controller loops, desired vs current state, and external-state controllers.
- [Stripe: Using webhooks with subscriptions](https://docs.stripe.com/billing/subscriptions/webhooks) — subscription lifecycle events, access provisioning, status transitions, and webhook retry/failure behavior.
- [Stripe API versioning](https://docs.stripe.com/api/versioning) — webhook endpoint API versioning and SDK version alignment.
- [Temporal documentation](https://docs.temporal.io/) — durable execution and crash-proof long-running workflows.
- [HCP Terraform health assessments](https://developer.hashicorp.com/terraform/cloud-docs/workspaces/health) — drift detection, continuous validation, health status, and drift resolution options.
- [Automated Cloud Infrastructure-as-Code Reconciliation with AI Agents](https://arxiv.org/abs/2510.20211) — 2025 research on using API traces and LLM agents to reconcile IaC drift.
- [Distributed Tracing for Cascading Changes of Objects in the Kubernetes Control Plane](https://arxiv.org/abs/2411.01336) — 2024 research on tracing cascading object changes in controller-based systems.
- [RIVA: Leveraging LLM Agents for Reliable Configuration Drift Detection](https://arxiv.org/abs/2603.02345) — 2026 research on cross-validating tool outputs for reliable agentic drift detection.
