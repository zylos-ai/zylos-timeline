---
date: "2026-06-19"
title: "Prepaid Credit Billing for AI SaaS Platforms in China"
description: "Architectural and business requirements for credit-based billing when building LLM gateway and AI agent SaaS for the Chinese domestic market — covering credit ledger design, WeChat Pay/Alipay integration, VAT invoice workflows, real-name verification gates, and multi-model credit routing."
tags:
  - billing
  - ai-gateway
  - china
  - saas
  - credit-systems
  - llm-gateway
  - payment-integration
---

## Executive Summary

Western AI platforms default to Stripe subscriptions with monthly caps. Chinese AI SaaS runs on prepaid credit — structurally, not just as a preference. Corporate card infrastructure is thin; procurement flows through bank transfer; VAT invoice obligations are non-negotiable; and real-name verification is a regulatory requirement before any paid quota is activated. For teams building an AI gateway or LLM-powered SaaS for the Chinese domestic market, this means fundamentally rearchitecting billing — not merely localizing payment methods. This piece covers the full stack: credit model mechanics, payment integration, regulatory gates, ledger architecture, and multi-model routing with differentiated credit rates.

## How Chinese AI Platforms Structure Credits

The major Chinese LLM platforms (Baidu ERNIE, Alibaba Tongyi/Qwen, Moonshot Kimi, Zhipu ChatGLM, ByteDance Doubao, DeepSeek) share a common pattern: consumption is measured in tokens, but no platform exposes raw yuan-per-token pricing at the point of payment. Instead, they interpose a credit layer — developers top up an RMB balance, which is debited at per-model rates.

DeepSeek is a partial exception worth studying: it publishes raw RMB/token pricing and maintains two distinct wallet buckets — a "topped-up balance" from the user, and a "granted balance" of promotional credits, with granted credits consumed first. This two-bucket design is a useful reference implementation: it cleanly separates promotional liability from recognized revenue while letting users experience a seamless single balance.

**Free trial grants** are universal and generous enough to complete full integration testing without payment commitment:
- Zhipu ChatGLM: 25 million free tokens on first login
- Baidu AI Studio: 1 million free tokens per model (90-day expiry)
- DeepSeek: 5 million tokens at signup, no card required
- Alibaba Tongyi: previously 70M+ tokens on new accounts

**Credit expiry** creates accounting complexity. Free trial credits typically expire in 90 days. Paid top-ups generally do not expire, or expire on a 12-month rolling basis. These must be tracked in separate ledger buckets: unexpired paid credits are deferred revenue liabilities; expired credits are recognized revenue. An accounting system that conflates them creates compliance problems.

**Pricing tiers** follow a consistent two-tier pattern across all major platforms — a cheap Flash/Turbo/Lite tier for routine inference and a Pro/Max tier for complex reasoning. Aggressive prompt caching discounts (DeepSeek: 98% off on cache hits; Moonshot Kimi: 83% off) drive architecture decisions for multi-tenant platforms: shared prompt prefixes across customers can dramatically reduce per-request costs.

## Payment Integration Stack

For Chinese B2B SaaS, the viable payment channels are WeChat Pay, Alipay, and bank transfer (对公转账). Stripe cannot process RMB payments without a domestic payment processor license.

**WeChat Pay** for B2B uses Native Pay (merchant QR code) and JSAPI Pay (inside a Mini Program or H5 page). The critical limitation: WeChat Pay does not support corporate bank accounts as the funding source — enterprise employees pay via personal accounts and reimburse internally. This creates friction for large purchases and makes WeChat Pay suitable primarily for top-ups under ¥500–1000. Requires a registered Chinese legal entity with a WeChat Pay merchant account.

**Alipay Enterprise** (`alipay.trade.page.pay` for web, `alipay.trade.app.pay` for mobile) is better suited for larger B2B flows. Alipay supports recurring debit for subscription-adjacent models and provides sandbox environments for integration testing. For enterprise customers already on Alipay business accounts, this is often the preferred channel.

**Bank transfer (对公转账)** is the de facto channel for purchases above approximately ¥10,000. Enterprise finance initiates a corporate bank transfer to your 对公账户 with an order number in the transfer memo; you reconcile and credit the account via an offline recharge workflow. All major Chinese AI platforms expose this as a dedicated console option. Implementing it requires: a unique per-transaction reference number, a bank statement reconciliation job (typically daily), and a manual review queue for transfers that fail automated matching. Under-building this flow is a common mistake — enterprise customers will use it immediately and the operational overhead is real.

**VAT invoice (增值税发票) workflows** are mandatory for enterprise retention and must be built from day one, not retrofitted. Every B2B client will request a 增值税专用发票 (special VAT invoice) for input tax credit recovery. Requirements:
- You must be registered as a 一般纳税人 (general VAT taxpayer) — 小规模纳税人 cannot issue 专票
- Since 2023, all VAT invoices must be issued through the national 全电发票 platform
- Invoices are typically issued at time of top-up (not at time of consumption) because customers need the 专票 before the payment posts to their books
- Build: invoice request form (税号, company name, bank account), status tracking, PDF delivery via email, re-issuance workflow for errors

Platforms that cannot provide timely VAT invoices lose enterprise accounts regardless of technical quality. This is a hard business-critical requirement.

## Regulatory Architecture

**ICP licensing** is a prerequisite for any paid AI SaaS in mainland China. An ICP Filing (ICP备案) takes 2–4 weeks and permits operating a website. An ICP Commercial License (互联网信息服务许可证) takes 60–90 working days and is required for commercial services. Both require a registered Chinese legal entity. Operating commercially without the commercial license while accepting payment is an enforcement risk.

**Real-name verification (实名认证)** is mandatory under the Cybersecurity Law and the CAC's 2023 Interim Measures for the Management of Generative AI Services. The implementation pattern: new accounts receive a short trial window with rate-limited access; full quota requires passing real-name verification. For individual users: name + ID number validated against the national identity database via a third-party API (Alibaba Cloud Identity Verification, iFlytek, etc.). For enterprise accounts: business license verification (营业执照核验) — typically automated against the SAMR database. Rate limits remain constrained until verification passes. This functions as both a regulatory gate and fraud prevention — do not design around it.

**Data residency**: CAC regulations require that inference logs for services offered to Chinese users be stored on servers within mainland China. Billing records, usage logs, and identity verification data must not be stored on overseas infrastructure. This affects multi-region deployments: if you have a global platform, the China instance must have a separate data plane with no cross-border data egress for these record types.

## Credit Ledger Design

The most important architectural decision for credit billing is **append-only ledger vs. mutable balance column**. Use append-only.

Every credit event — purchase, grant, deduction, refund, expiry — is written as an immutable row:

```
event_id    | UUID, primary key
account_id  | FK
event_type  | ENUM(purchase, grant, deduction, refund, expiry, reservation, reservation_release)
amount      | DECIMAL (positive = credit, negative = debit)
model_id    | nullable, for deduction events
request_id  | nullable, for deduction events
source_ref  | payment order ID, grant campaign ID, etc.
created_at  | TIMESTAMPTZ
expires_at  | nullable, for grant events
```

Current balance is the sum of all non-expired events for an account. This provides complete audit trails, enables point-in-time balance reconstruction, simplifies debugging, and aligns with Chinese accounting requirements for financial record retention (10 years for electronic records). The performance concern — summing all events — is addressed by a periodic snapshot table that stores the last verified balance checkpoint.

**Streaming response deduction** is the main implementation complexity. Token count is unknown until the stream completes, but you cannot let the balance go negative. The standard pattern is **speculative pre-deduction**: reserve the model's configured `max_tokens` at request initiation, execute the stream, and on completion issue a reconciliation event refunding the difference between reserved and actual tokens. Two ledger writes per request, but balances never go negative.

For concurrency, atomic compare-and-swap at the database layer:
```sql
UPDATE credit_accounts
SET reserved = reserved + :amount
WHERE account_id = :id
  AND (balance - reserved) >= :amount
```
Zero rows affected = insufficient balance, reject the request. At high throughput, move the balance check to Redis (atomic DECRBY returning the new value; reject if negative, INCRBY to roll back) with the authoritative ledger written asynchronously. Do not block the hot request path on a synchronous ledger write.

**Failed request refunds** must flow through the same event log with idempotency keys to prevent double-refunds on retry. Implement a dead-letter queue for refund events that fail to write.

## Multi-Model Credit Routing

When a single platform routes requests across multiple models (OpenAI GPT, Claude, Qwen, DeepSeek, Doubao), each with different per-token costs, expose a normalized internal credit unit to customers rather than per-model pricing complexity.

```
1 credit = ¥0.001 (or any chosen normalization)
```

Maintain a `model_credit_rates` table:
```
model_id | token_type (input/output/cache_hit) | credits_per_1k_tokens
```

The gateway resolves the credit rate at request time, performs speculative deduction in credits, and customers see a single balance usable across all models. Rate table updates (when upstream providers change pricing) take effect immediately for new requests without requiring any account migration.

**Enterprise credit pools** allow a parent organization to hold a single balance with sub-account allocation:
- `accounts.parent_account_id` FK for hierarchy
- `credit_allocations` table: per-sub-account limits drawn from the parent pool
- Balance enforcement: check both the sub-account's remaining allocation AND the parent pool's remaining balance; enforce the more restrictive
- Sub-accounts can have independent rate limits (RPM/TPM) even when pool credits remain — department-level budget controls without separate top-up flows

Credit transfer between accounts is legally sensitive: freely transferable credits begin to resemble a stored-value instrument subject to PBOC payment license requirements. Limit transfers to within a single corporate entity (inter-department only) and log all transfers with full audit trail.

## Quota Enforcement Architecture

Credit balance enforcement and rate limiting are separate concerns enforced at different layers:

- **Rate limiting (RPM/TPM)**: token-bucket algorithm at the API gateway layer (Nginx, Kong, or custom middleware), enforced in microseconds without hitting the database
- **Credit balance**: enforced via the ledger service with slightly higher latency (Redis fast path + async ledger write)

The gateway should reject over-limit requests with HTTP 429 before the credit check; only requests that pass rate limiting proceed to balance verification. This ordering reduces ledger load under traffic spikes.

**Grace credits** are a service continuity mechanism for balance-zero scenarios: instead of hard-blocking at zero, issue a small automatic grace credit (¥5–10 equivalent) that allows in-flight requests to complete and gives users a short top-up window. Grace credits should be time-limited (24–72 hours), non-stackable, and non-refundable. Enterprise SLAs typically require proactive low-balance alerts at 20% and 5% thresholds, delivered via email and webhook.

## Key Implementation Priorities

For teams building a new China-market AI SaaS platform, the four most consequential decisions that are difficult to retrofit:

1. **VAT invoice workflows before launch** — enterprise sales stall immediately without them; the tax registration and 全电发票 integration takes weeks to establish
2. **Real-name verification as a hard gate from day one** — regulatory requirement, not optional; build it into the onboarding flow, not as an afterthought
3. **Append-only ledger from the start** — migrating from a mutable balance column to an event log while live is painful; the schema decision is load-bearing for audit compliance
4. **All billing and identity data on mainland infrastructure** — CAC regulations prohibit cross-border egress of these record types; architecture decisions that mix global and China data planes become expensive to untangle later

The prepaid credit model is not just a localization decision — it is a structural adaptation to the Chinese enterprise procurement landscape where recurring auto-charge is technically and culturally constrained. Designing the billing layer around this reality from the start is cheaper than retrofitting a subscription system that customers will not use.
