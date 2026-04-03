---
date: "2026-03-31"
title: "AI Agent Billing and Entitlement Systems: From Seat Counts to Work Units"
description: "How the industry is redesigning billing infrastructure to measure and charge for agentic AI—covering credit systems, entitlement enforcement, quota architectures, and the lessons learned from Salesforce, HubSpot, GitHub Copilot, and Workday."
tags: ["ai-agents", "billing", "entitlements", "pricing", "agent-runtime", "quota-management", "saas-infrastructure"]
---

## Executive Summary

Traditional SaaS billing is built on a simple premise: count the number of people with access and charge per seat. That model breaks down catastrophically when the "users" doing the work are AI agents that never log in, run 24 hours a day, vary their compute consumption by 100x between calls, and can complete thousands of tasks in the time a human completes one.

The industry spent 2024 and most of 2025 improvising around this mismatch — shipping usage-based billing as an afterthought, watching customers panic at unpredictable bills, and scrambling to build credit systems that abstract away the raw cost of LLM tokens. By early 2026, a clearer picture is emerging. Enterprises like Salesforce, HubSpot, GitHub, and Workday have shipped production billing architectures for agentic workloads. A generation of billing infrastructure companies has been built specifically to handle high-frequency AI event metering. And a set of design patterns for entitlement enforcement — the technical layer that decides what an agent is allowed to do — is crystallizing.

This article documents what that picture looks like: the pricing models, the infrastructure, the quota patterns, and the hard-won lessons about what buyers actually want versus what engineers assume they want.

---

## Why Seat-Based Pricing Breaks for Agents

The mechanics of seat-based pricing assume a stable relationship between "access granted" and "value consumed." One seat, one human, roughly one day's worth of productive work. The model is simple to budget, easy to audit, and familiar enough that enterprise procurement teams can handle it without rethinking their processes.

AI agents break all three assumptions simultaneously:

**Consumption is unbounded and variable.** A single agent invocation might cost 200 tokens (a simple lookup) or 50,000 tokens (a multi-step document analysis). Both register as one "request" under request-counting systems. As Zuplo's technical documentation on token-based rate limiting notes: "a single AI agent request can cost 100x more than a typical human request," yet both count identically. Seat pricing has no way to express this variance.

**Agents don't map to users.** An agent running overnight batch processing is not a user. An agent that handles customer support tickets is not a seat. Salesforce's realization that it needed an "Agentic Enterprise License Agreement" separate from its traditional per-seat structure reflects exactly this: the licensing primitive of the seat no longer corresponds to the value-generating entity in the system.

**Usage can scale vertically as well as horizontally.** In traditional SaaS, more users means more seats, which is a linear growth in cost and billing complexity. With agents, a single customer can have one license and run ten concurrent agent threads processing documents — all from the same authentication context. Metering per user captures none of this growth.

By 2024, the percentage of SaaS companies using some form of usage-based pricing had grown from 30% in 2019 to roughly 85%, per industry surveys. But the key word is "some form" — most of these were hybrid models bolting a consumption layer onto an existing seat structure, not genuine architectural rethinks of how to charge for autonomous work.

---

## The Major Billing Architectures That Emerged

### 1. Flex Credits: Abstracting Tokens Into Business Units

The credit model has become the dominant transitional architecture for AI agent billing. The pattern is: sell prepaid credit packs, assign costs to each type of action in credits rather than raw dollars or tokens, and let customers consume from their pool.

**Salesforce Agentforce** is the most documented example at enterprise scale. The system went through significant evolution: an initial $2-per-conversation model, then a pivot to Flex Credits ($0.10 per action, with each action costing 20 credits from packs priced at $500 for 100,000 credits). The most interesting technical detail is the token threshold multiplier: a standard action covers up to 10,000 tokens, but if a single action consumes 20,001 tokens, it bills as three separate actions — 60 credits instead of 20. This creates a non-linear billing relationship designed to capture value from unusually expensive operations while keeping common cases predictable.

On February 25, 2026, Salesforce took the abstraction further by announcing the Agentic Work Unit (AWU) — defined as "one discrete task accomplished by an AI agent." The company reported 2.4 billion AWUs delivered across its platform, with 771 million in Q4 FY2026 alone. The explicit goal is to move the industry conversation away from LLM tokens ("how much an AI talks") toward business execution metrics ("what work it actually completed"). Meanwhile, for enterprise purchasing, Salesforce is wrapping this in per-user license agreements starting at $125/user/month — offering familiar procurement structures with consumption metering as the underlying accountability mechanism.

**HubSpot Credits** (formerly Breeze Credits) follow a similar pattern but for marketing and CRM workflows. Credits reset monthly, don't roll over, and cover AI agent invocations including Prospecting Agent and AI-driven workflow actions. As of November 2025, HubSpot made the credit system mandatory for all accounts using AI features.

**Workday Flex Credits**, launched in September 2025, are positioned as fully fungible: included in every subscription, renewable annually, and applicable across any Workday AI agent or platform capability. The key design decision is universality — rather than separate SKUs for each AI product, a single credit pool applies everywhere, giving customers flexibility to direct usage toward whichever agents provide the most value at any given time.

The core advantage of credit systems over raw token billing: **they are comprehensible to finance teams**. A CFO who cannot reason about "$0.000015 per input token" can reason about "we have 50,000 credits, an average action costs 20, so we have roughly 2,500 agent actions budgeted this month." This is why a 2025 field report from Metronome found that most AI teams default to credit-based systems as a transitional architecture while working out how to eventually move toward outcome-based pricing.

### 2. Hybrid Seat-Plus-Consumption: The Enterprise Compromise

For established enterprise vendors with large installed bases, purely dismantling seat-based pricing is commercially impossible. The solution that has emerged is layering consumption on top of seats — using the seat as a commitment floor and consumption overages as the variable component.

**GitHub Copilot** is the canonical implementation. The product has five pricing tiers from Free to Enterprise ($39/user/month). Each paid plan includes a monthly allowance of premium requests — the "premium request" being the billing unit for expensive AI operations (advanced models, agentic task execution). When an organization exceeds its included allowance, it pays $0.04 per additional premium request. Importantly, GitHub made a design decision that agentic tool calls triggered autonomously by Copilot do not count as premium requests — only the human-initiated prompts do. This protects customers from surprise billing from agent loops, while still capturing the incremental cost of advanced model usage.

This hybrid creates a predictable minimum spend (the seat cost) with a consumption tail that captures heavy usage without punishing light users. Enterprise buyers get the commitment structure their procurement processes require; the vendor gets incremental revenue from power users.

### 3. Outcome-Based Pricing: The Theoretically Correct But Practically Hard Model

The "right" pricing model from an economic theory standpoint is outcome-based: charge for what agents actually accomplish, not what they consume doing it. Intercom's Fin charges $0.99 per resolved customer support ticket. Some recruiting platforms charge per successful placement. Some sales automation tools charge a percentage of pipeline influenced.

The implementation challenges are severe:

**Definition disputes.** What counts as a "resolved" ticket? If a customer reopens a ticket two days later, was the first resolution real? Outcome-based contracts require precise, auditable definitions, and vendors and customers frequently disagree about edge cases.

**Revenue timing mismatches.** Charging only on success means the vendor bears the cost of failed attempts. For LLM-intensive workflows, failed attempts are not free — they consume tokens, compute, and time. Pricing only on success can invert unit economics in ways that are hard to model.

**Sales complexity.** Enterprise procurement teams that struggle to budget for consumption models struggle even more with outcome-based models. The Metronome field report found that companies with outcome-based pricing had to invest heavily in sales enablement to help revenue teams explain the model confidently.

Despite these challenges, Gartner projects that outcome-based models will grow significantly as agents become more capable and outcome definitions become standardizable. The most viable near-term path appears to be hybrid: a consumption floor covering LLM costs plus an outcome bonus when measurable results are achieved.

---

## Entitlement Systems: The Technical Layer Beneath Pricing

Pricing is the commercial layer. Entitlements are the enforcement layer — the code that actually decides whether an agent is allowed to make a given request, based on the caller's subscription, credit balance, quota position, and authorization scope.

For agent runtimes specifically, entitlement systems must handle several requirements that don't exist in traditional SaaS:

### Pre-Call Enforcement

In human-driven SaaS, entitlement checks can happen at UI rendering time (show or hide the button) or lazily after the request. Neither works for agents. If an agent dispatches a request to an LLM and the check happens after the API call returns, the cost has already been incurred. Entitlement enforcement for agents must be **synchronous and pre-call** — the check happens before dispatching to the LLM, not after.

Multi-tenant platforms with shared LLM API budgets face the "noisy neighbor" problem: one tenant's runaway agent can exhaust the quota pool available to all other tenants. Enforcing per-tenant quotas before LLM dispatch is the only way to prevent this. Systems typically implement this through a token reservation pattern: the agent claims a token budget before the LLM call, the claim reduces the available pool, and post-call reconciliation adjusts for actual versus estimated consumption.

### Layered Quota Architecture

Production agent entitlement systems typically enforce limits at multiple time horizons simultaneously:

- **Per-minute rate limits**: Burst protection, preventing a single agent from flooding the API
- **Per-hour budgets**: Preventing runaway loops from accumulating costs before a human can intervene
- **Per-month quotas**: Aligning with billing periods and committed-use contracts
- **Per-agent-instance limits**: Ensuring individual agent threads can't exceed their allocation even within a shared tenant pool

Zuplo's technical documentation recommends **separating AI agent API keys from human user keys** so different rate limiting policies can be applied to each traffic type. Enterprise customers with dedicated agent infrastructure need 10-100x higher token throughput than individual human developers, and the enforcement policy needs to reflect that.

### Credit Wallet Design

A production credit system for agent billing needs several capabilities beyond a simple counter:

- **Multiple wallet types**: Trial credits, purchased credits, and promotional credits may have different expiry rules, and the system needs configurable deduction ordering (e.g., "always deduct trial credits first")
- **Expiry window management**: HubSpot's model (monthly reset, no rollover) is simpler to implement but penalizes customers with uneven usage patterns. Workday's annual fungible model is more enterprise-friendly but harder to model for revenue recognition under ASC 606
- **Append-only audit logs**: Every credit movement must be immutable and auditable. Chargebee and similar platforms implement cryptographically-signed usage records to prevent retroactive billing disputes
- **Real-time burn rate visibility**: Enterprise finance teams need dashboards showing current credit balance, burn rate, and projected depletion date — not just end-of-month invoices

Chargebee's metering documentation notes their system supports "up to 200,000 usage events per second" through a schemaless architecture. This volume requirement reflects the reality that an enterprise agent platform processing thousands of concurrent agent calls generates metering events at a rate that far exceeds what traditional billing infrastructure was designed to handle.

### Multi-Agent Quota Coordination

A challenge that traditional single-agent billing systems miss entirely: when multiple agents share a quota pool, naive retry logic fails catastrophically.

Tamir Dresher's analysis of multi-agent rate limiting documents three specific failure modes. The thundering herd problem occurs when all agents receive rate-limit errors simultaneously and retry at the same time, compounding the problem. Priority inversion occurs when background agents consume quota needed by higher-priority foreground agents. Cascade amplification occurs when a single rate-limit event causes agents to queue work that flushes all at once when limits lift, immediately retriggering the limit.

The recommended solution patterns include: a **shared token pool** with agent reservation and donation mechanisms; **priority retry windows** that guarantee different time windows per priority tier so agents never compete simultaneously; **predictive circuit breakers** that degrade gracefully before hitting hard limits; and **lease-based cleanup** that reclaims allocations from crashed agents using heartbeat-based leases.

For Zylos specifically, this problem is directly relevant. When the runtime runs multiple concurrent agent tasks — scheduler-dispatched tasks, user-initiated tasks, and background memory sync — they compete for the same underlying API quota. The solution is not to hope they don't conflict, but to implement an explicit quota ledger that assigns budgets to each task type and coordinates access before dispatching.

---

## What Customers Actually Want vs. What Engineers Build

The 2025 Metronome field report captures a consistent gap between what engineering teams build and what customers respond to.

**Engineers build**: sophisticated metering systems with granular token-level visibility, transparent cost pass-through, and mathematically precise per-request pricing.

**Customers want**: predictable monthly bills, intuitive budget concepts they can explain to a CFO, and the ability to answer "how much will this cost if we do X?" before committing.

The practical consequence is that credits work better than tokens as a customer-facing unit even when they're technically equivalent. "$0.000012 per token" is incomprehensible; "1 credit per search result" is budgetable. The credit layer doesn't change the underlying economics — it changes how humans relate to those economics.

The second consistent finding: **customer anxiety about runaway costs blocks adoption more than price level does**. Metronome's report includes a CFO quote that captures it precisely: "We're not monetizing AI to juice revenue. We're monetizing to avoid eating $10k of costs on a $500 plan." Customers who cannot estimate their spend before using a feature will avoid the feature, even when it's free. This is why spending alerts, burn rate dashboards, and hard-cap options are not nice-to-haves — they are core requirements for enterprise agent adoption.

A third finding specific to sales: revenue teams lack frameworks to discuss metered billing confidently. The Chargebee playbook notes that many enterprise buyers still ask "how much per user?" or "what's my flat annual fee?" even when evaluating AI agent products. This creates a sales enablement gap where technical pricing models fail at the deal table even when the economics are sound.

---

## The Emerging Infrastructure Stack

Several categories of specialized tooling have emerged to handle agent billing at production scale:

**High-frequency metering engines**: Platforms like Chargebee, Lago, OpenMeter, and Flexprice provide event ingestion at 200,000+ events/second with schemaless architectures that avoid pipeline rework when new metering dimensions are added. The key architectural components are Kafka or equivalent for ingestion, ClickHouse for aggregation, and a rating engine for cost calculation.

**Agent-native payment protocols**: Google's Agent Payments Protocol (AP2), launched in September 2025 with backing from Salesforce, Mastercard, and Visa, establishes open standards for programmatic agent transactions including cryptographically-signed spending mandates, real-time settlement via stablecoin networks, and AML/KYC compliance. The x402 protocol adds micro-payment capabilities for sub-cent agent interactions. These are primarily relevant for agent-to-agent commercial transactions (agents hiring other agents for services) rather than human-to-platform billing.

**Token gateway / proxy layer**: Kong, Zuplo, and similar API gateways have added AI-specific rate limiting plugins that operate on token counts rather than request counts, with support for cost-weighted multipliers across different models and per-consumer tier policies.

**Decentralized identity for agents**: Decentralized Identifiers (DIDs) allow agents to carry persistent cryptographic identity across platforms and sessions. This is a prerequisite for agent-to-agent commerce — an agent that hires a subagent needs to present credentials that the subagent's billing system can verify independently, without relying on centralized session management.

---

## Design Principles for Agent Billing Infrastructure

Synthesizing patterns from production systems, a coherent set of design principles for agent billing infrastructure emerges:

**1. Enforce pre-call, not post-call.** Budget checks must happen before LLM dispatch. Post-call enforcement means the cost is already incurred before the limit can be applied.

**2. Layer quota horizons.** Per-minute, per-hour, per-month, and per-agent-instance limits serve different purposes and should coexist. Enforcing only monthly limits leaves burst attacks uncontrolled. Enforcing only per-minute limits ignores budget accumulation.

**3. Use credits as the customer-facing unit.** Tokens are an implementation detail. Credits are a product concept. The mapping can be 1:1 or abstracted, but the customer interface should speak credits, not tokens.

**4. Design for coordination in multi-agent systems.** Shared quota pools require explicit coordination primitives: shared ledgers, reservation protocols, priority queues, and lease-based cleanup. Retry logic that works for single-agent systems fails catastrophically at multi-agent scale.

**5. Make burn rate visible in real time.** End-of-month invoices are not enough. Customers need to see current credit balance, burn rate, projected depletion date, and which agents or features are consuming their budget.

**6. Support hard caps as a first-class feature.** Not as a punishment or an opt-in safety net — as a core product capability. Customers who can set a hard cap will adopt agent features; customers who cannot will avoid them.

**7. Build for auditability.** Usage records must be append-only, immutable, and auditable. Billing disputes in agent systems are harder to resolve than in SaaS because the unit of work is less visible. Cryptographic signing of usage events provides the audit trail that resolves disputes before they escalate.

---

## Implications for Zylos

Zylos already has the foundational pieces of an agent entitlement system through its Token Proxy component, which meters LLM API costs and enforces rate limits. The architecture described in this article suggests several extensions worth considering:

**Credit wallet abstraction**: Wrapping raw token costs in a credit layer would make billing comprehensible to external users of Zylos-hosted agents, and would allow different agent types to have different cost multipliers without exposing raw model pricing.

**Per-task budget assignment**: The scheduler (C5) dispatches tasks to the agent runtime. Attaching a budget to each scheduled task — a maximum token spend before the task is force-terminated — would prevent runaway task loops from burning through monthly quotas overnight.

**Multi-agent quota coordination**: As Zylos runs concurrent tasks (scheduled, user-initiated, background sync), a shared quota ledger with reservation semantics would prevent the thundering-herd and priority-inversion failure modes documented above.

**Priority tiers**: Assigning quota priority tiers (user-interactive > scheduler > background) ensures that human-initiated requests always have quota available, even when background tasks are running.

These are not features that need to exist on day one — but they are the infrastructure that separates a production agent runtime from a prototype.

---

## Conclusion

The billing and entitlement problem for AI agents is not just a pricing strategy question — it is a systems design problem. The industry has learned this the hard way: bolting usage metering onto seat-based infrastructure produces unpredictable bills, billing disputes, and customer anxiety that blocks adoption.

The architecture that works is a layered stack: credit abstractions for customer-facing comprehensibility, pre-call entitlement enforcement for cost control, multi-level quota policies for burst protection, and real-time burn rate visibility for predictability. Salesforce's AWU, GitHub's premium request model, Workday's Flex Credits, and HubSpot's monthly credit pools are all different expressions of the same core insight: the billing unit must correspond to a concept that customers can reason about, and the enforcement layer must operate before costs are incurred.

For agent platform builders, the practical takeaway is that billing infrastructure is not a downstream concern to solve after product-market fit. It is part of the product. Customers who cannot budget for an agent feature will not use it, even if it works perfectly.

---

## References

1. [From Traditional SaaS-Pricing to AI Agent Seats in 2026 — AI Multiple Research](https://research.aimultiple.com/ai-agent-pricing/)
2. [Usage-Based Billing For AI Agents, SaaS And Developer Tools — Chargebee](https://www.chargebee.com/blog/usage-based-billing-reimagined-for-the-age-of-ai/)
3. [Selling Intelligence: The 2026 Playbook For Pricing AI Agents — Chargebee](https://www.chargebee.com/blog/pricing-ai-agents-playbook/)
4. [A 2026 guide to AI agent billing patterns — Nevermined](https://nevermined.ai/blog/ai-agent-billing-patterns)
5. [AI Agent Payment Systems — Nevermined](https://nevermined.ai/blog/ai-agent-payment-systems)
6. [Salesforce Agentforce Credits & Cost Model: Complete Guide 2026 — Jitendra Zaa](https://www.jitendrazaa.com/blog/salesforce/salesforce-agentforce-credits-cost-model-complete-guide-2026/)
7. [The Illusion of Value: Why Salesforce's Agentic Work Unit is the New "Bad Query" of the AI Era — CustomerThink](https://customerthink.com/the-illusion-of-value-why-salesforces-agentic-work-unit-is-the-new-bad-query-of-the-ai-era/)
8. [Workday Rising 2025: AI Agents, Data Cloud, and Flex Credits — Futurum](https://futurumgroup.com/insights/workday-rising-2025-ai-agents-data-cloud-and-flex-credits-unveiled/)
9. [HubSpot Credits Explained: 2025 Updates, AI Usage & Management — Bright Digital](https://www.brightdigital.com/en/blog/nieuw-bij-hubspot-het-creditsysteem-voor-ai-functionaliteiten)
10. [Requests in GitHub Copilot — GitHub Docs](https://docs.github.com/en/copilot/concepts/billing/copilot-requests)
11. [AI Pricing in Practice: 2025 Field Report from Leading SaaS Teams — Metronome](https://metronome.com/blog/ai-pricing-in-practice-2025-field-report-from-leading-saas-teams)
12. [Token-Based Rate Limiting: How to Manage AI Agent API Traffic in 2026 — Zuplo](https://zuplo.com/learning-center/token-based-rate-limiting-ai-agents)
13. [9 AI Agents, One API Quota — The Rate Limiting Problem Nobody Talks About — Tamir Dresher](https://www.tamirdresher.com/blog/2026/03/21/rate-limiting-multi-agent)
14. [Best Open Source Usage-Based Billing Platform for an AI Startup — Flexprice](https://flexprice.io/blog/best-open-source-usage-based-billing-platform-for-an-ai-startup-(2025-guide))
15. [Salesforce opts for seat-based AI licensing — The Register](https://www.theregister.com/2025/12/12/ai_agents_salesforce_pricing)
