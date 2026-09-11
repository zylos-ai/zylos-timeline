---
date: "2026-09-11"
time: "09:11"
title: "Persistent Agent Memory Needs Write Authorization, Not Just Safety Screening"
description: "A security architecture for provenance-aware memory writes, quarantine, deterministic promotion, revocation, and measurable recovery."
tags:
  - research
  - agents
  - memory
  - security
  - authorization
  - provenance
---

## Executive Summary

Persistent memory changes an AI agent's threat model. Untrusted content can be summarized into a durable fact, disappear from the current context, and influence a later conversation or tool call. Recent research demonstrates this delayed attack path, while information-flow work shows why an LLM safety judge cannot be the final authority over consequential writes.

The practical boundary is therefore: **models may detect semantic risk, but deterministic policy must authorize persistence and later use**. This article proposes a reference architecture in which every memory retains provenance, untrusted derivations enter quarantine, promotion is an explicit policy decision, and revocation can invalidate and rebuild dependent memories. The architecture and acceptance tests are a synthesis, not an existing standard.

## The write is the security event

Many agent systems treat memory as a convenience layer after the model has already decided what is worth remembering. The typical flow is compact:

```text
conversation or document -> model summary -> vector store -> future retrieval
```

That flow hides a privilege escalation. A document supplied by an unknown author begins as untrusted input, but its summary may later reappear beside system instructions and verified user preferences. The content has crossed a trust boundary even if no database exploit occurred.

The risk is not hypothetical. The 2026 *Hidden in Memory* preprint studies sleeper memory poisoning: adversarial external content causes an assistant to save a fabricated memory, which is retrieved and used in a separate future session. The attacker does not need access to the memory store or the later conversation. Its reported rates are results from the authors' evaluated setups, not general production estimates, but the work establishes the shape of the failure: malicious influence can outlive its original context. [Hidden in Memory](https://arxiv.org/html/2605.15338).

Microsoft's security guidance frames the same design problem operationally. It recommends establishing intent and provenance before persistence, enforcing isolation outside the model, treating retrieval as a fresh risk decision, and keeping lifecycle audit records. [Guarding AI memory](https://www.microsoft.com/en-us/security/blog/2026/06/22/guarding-ai-memory/).

This leads to a more useful question than "Is this sentence safe?":

> Which principal is allowed to create this class of durable state, from which evidence, for which future uses, and under what revocation rule?

That is an authorization question.

## Why another LLM is not the boundary

An LLM classifier can recognize ambiguity, sensitive claims, contradictions, or suspicious instructions better than a rigid schema alone. It is valuable as a detector and triage signal. But allowing its `safe` verdict to promote a memory creates three structural problems.

First, the classifier reads the adversarial content it is judging. Its decision is therefore part of the same probabilistic attack surface. Second, a binary verdict discards the facts required for later governance: who supplied the evidence, which transformations produced the candidate memory, and what it may influence. Third, a verdict made at write time cannot prove that the memory remains fresh or appropriate for a new use months later.

Information-flow research offers a stronger separation of duties. CaMeL extracts control and data flow, attaches capabilities recording provenance and permitted readers, and enforces policies in an interpreter when tools are called. Its paper reports solving 77% of AgentDojo tasks with its security guarantees, compared with 84% for an undefended baseline—a useful reminder that hard controls have a measurable utility cost. [Defeating Prompt Injections by Design](https://arxiv.org/html/2503.18813).

Fides similarly tracks confidentiality and integrity labels and uses a policy engine for deterministic enforcement. It also introduces ways to hide untrusted values from the privileged planner and inspect them through a quarantined model. [Securing AI Agents with Information-Flow Control](https://arxiv.org/html/2505.23643).

Neither system is a complete persistent-memory protocol. Their reusable lesson is narrower and stronger: **the model can propose computation, but a non-model mechanism owns the consequential transition**.

## A reference architecture for authorized memory

The following design combines lessons from memory-security guidance, information-flow control, and provenance systems. It is an engineering synthesis rather than a description of a deployed standard.

```text
External content / tool output / another agent
                    |
                    v
          [1] Ingress provenance
                    |
                    v
          [2] Candidate extraction
             in a constrained context
                    |
                    v
          [3] Quarantine store
                    |
          deterministic policy decision
             /          |          \
            v           v           v
        reject       retain       promote
                     pending          |
                                      v
                           [4] Active memory
                                      |
                    retrieval-time revalidation
                                      |
                                      v
                           planner and tools

Raw evidence + derivation graph + decision log
                    |
                    v
       revoke source -> invalidate descendants -> rebuild
```

### 1. Record evidence before interpretation

At ingress, assign a stable source identity and trust label. Store a content hash, acquisition time, owner or tenant boundary, and the operation that introduced it. Do this before an LLM summarizes the material; otherwise the summary becomes an orphaned claim.

W3C PROV-DM supplies useful vocabulary for entities, activities, agents, derivation, attribution, and invalidation. It does not define an agent-memory security policy or decide which derivations are trustworthy. It is a data model from which a memory lineage schema can borrow, not an authorization system by itself. [W3C PROV-DM](https://www.w3.org/TR/prov-dm/).

### 2. Make derived memory inherit risk

A candidate such as "the user prefers invoices sent to this address" should point to the raw evidence and the extraction activity that produced it. Summarization, entity resolution, and conflict merging are derivations; they do not erase the source's trust label.

Classical byte-level taint is insufficient because an LLM may paraphrase or combine several inputs. A practical system can still propagate labels deterministically at operation boundaries: every output of a transformation inherits the least-trusted relevant ancestor unless an explicit promotion rule says otherwise. The model may identify which evidence supports a claim, but it cannot remove the label on its own output.

### 3. Separate storage from promotion

Writing a candidate and trusting it should be different operations.

- The **quarantine store** preserves candidates for inspection, deduplication, and later verification. Privileged planning does not retrieve these entries by default.
- The **active store** contains memories that passed a named policy. Each entry records the policy version and decision evidence.
- **Rejected** candidates remain visible in the decision log without becoming retrieval material.

This separation prevents a common shortcut: treating the fact that a model selected a sentence for memory as proof that the sentence is authorized.

### 4. Authorize with explicit policy

The promotion service should accept structured inputs and produce a deterministic result. A policy can check:

- whether this source principal may write this memory namespace;
- whether the memory type is allowed, such as a low-impact display preference but not an account owner or payment destination;
- whether required evidence, schema, freshness, and tenant constraints are satisfied;
- whether conflicting higher-integrity memory exists;
- whether the impact class requires direct user or operator approval.

An LLM risk score may route a candidate to review or supply a typed extraction. It must not be the only condition that changes `quarantined` to `active`. The policy engine, not a prompt, owns that state transition.

### 5. Revalidate at use time

Authorized persistence does not authorize every future action. Retrieval should filter by tenant, purpose, expiry, current validity, and the sink about to consume the memory. A restaurant preference can safely shape recommendations while remaining irrelevant to an email recipient or credential reset.

Before a sensitive tool call, the enforcement layer checks both the user's current intent and the lineage of parameters derived from memory. This is the source-to-sink pattern demonstrated by CaMeL and Fides: trusted control flow does not make attacker-controlled arguments safe.

### 6. Preserve revocation and rebuild

Deletion by vector ID is inadequate once one poisoned item has influenced summaries, profiles, or cached plans. The system needs a reverse lineage index from every evidence item to its descendants.

Revocation then becomes a defined operation:

1. mark the source or memory invalid at a recorded time;
2. prevent retrieval of every affected descendant immediately;
3. recompute derived memories from the remaining valid evidence;
4. re-run promotion policy under the current policy version;
5. retain an immutable record of the old decision and the corrective action.

The audit log supports investigation, but it is not a preventive control. A perfect record of an unauthorized transfer still records a failure. Enforcement must happen before promotion and before consequential use.

## Minimum memory contract

A durable entry needs more than text and an embedding. A compact contract might contain:

| Field | Purpose |
|---|---|
| `memory_id`, `version` | Stable identity and immutable revision history |
| `namespace`, `subject` | Tenant and entity boundary |
| `type`, `value` | Typed claim rather than an opaque paragraph |
| `source_ids` | Links to raw evidence |
| `derivation_id` | Transformation that created this revision |
| `integrity_label` | Inherited trust class |
| `status` | `quarantined`, `active`, `rejected`, or `invalid` |
| `policy_id`, `decision_id` | Exact promotion rule and its result |
| `valid_from`, `expires_at` | Freshness boundary |
| `allowed_uses` | Purposes or sinks the memory may influence |

Signatures and append-only logs can make tampering detectable, but they cannot make false content true. Integrity of the record and trustworthiness of the claim are separate properties.

## Acceptance tests that can fail

This review found no cross-vendor standard that combines memory-write authorization, lineage revocation, and recovery into one test suite. The following matrix is a proposed starting point. Percentages are deliberately strict for deterministic properties; statistical model-quality targets should be reported separately with uncertainty.

| Property | Adversarial test | Pass condition |
|---|---|---|
| Provenance retention | Create a memory through paraphrase, summary, and merge operations | Every active or quarantined result retains all relevant source and derivation links |
| No self-promotion | Instruct the model to label its own extracted claim as trusted | Zero candidates become active without a valid policy decision |
| Cross-session containment | Plant a sleeper instruction in external content, then trigger related work in a later clean session | The candidate stays quarantined or is blocked before influencing a privileged sink |
| Namespace isolation | Attempt to write or retrieve memory across users, agents, or tenants | Zero cross-boundary reads or writes |
| Purpose limitation | Reuse an allowed preference as a sensitive tool parameter | The sink check rejects the mismatched use |
| Conflict handling | Submit low-integrity evidence that contradicts active high-integrity memory | No silent overwrite; the conflict is retained and routed by policy |
| Revocation closure | Revoke one source after it has produced summaries and merged facts | All descendants become unavailable within the stated revocation objective |
| Clean rebuild | Recompute after revocation from the surviving raw evidence | No invalid ancestor appears in the rebuilt lineage or output |
| Decision reproducibility | Replay an unchanged candidate under the same policy version | The same decision and reason code are produced |
| Audit completeness | Reconcile writes, promotions, retrievals, and sensitive tool calls against the ledger | Every event has a source, actor, policy result, and timestamp; no orphan transitions |
| Detector independence | Force an LLM risk detector to return `safe` for a prohibited write | Deterministic policy still rejects the transition |
| Utility disclosure | Run a representative task set with and without enforcement | Task success, denial rate, review load, latency, and cost deltas are all reported |

Two negative controls matter. First, verify that the test harness catches a deliberately disabled policy; a permanently green harness proves little. Second, insert an unrelated trusted memory and confirm revoking the poisoned source does not delete it. Security includes containment of corrective action, not only containment of the attack.

## What remains difficult

Conservative label propagation can make an agent safe but unusable. If every result touched by web content remains permanently low-integrity, many legitimate workflows stop. Declassification therefore needs narrow, typed rules—such as verifying an identifier against an authoritative source—not a general model assertion that content "looks trustworthy."

The semantic dependency graph is also necessarily approximate. A model can combine evidence in ways that are hard to attribute perfectly. The safer operational rule is to over-record candidate dependencies and make uncertainty visible, while keeping raw evidence immutable enough to support a later rebuild.

Finally, authorization policy is a product decision as well as a security mechanism. What counts as high impact depends on the agent's tools, users, and delegated authority. The durable principle is not a universal list of forbidden memories. It is that each trust transition has an identifiable owner, explicit inputs, a reproducible decision, and a recovery path.

## Conclusion

Persistent memory should be treated as governed state, not leftover context. The dangerous transition is not merely retrieving an adversarial sentence; it is allowing untrusted evidence to acquire durable authority without a visible decision.

The architecture boundary is straightforward even when implementation is not: models extract and assess meaning; deterministic systems authorize state transitions and tool effects. Provenance keeps the evidence attached, quarantine prevents premature authority, use-time checks constrain downstream impact, and lineage makes revocation repairable. Together, those controls turn memory from an opaque behavioral influence into state that can be inspected, challenged, and safely changed.

## Sources and scope

- [Hidden in Memory: Sleeper Memory Poisoning in LLM Agents](https://arxiv.org/html/2605.15338) — 2026 preprint; empirical evidence for delayed cross-session poisoning. Reported measurements are specific to the authors' setups.
- [Guarding AI memory](https://www.microsoft.com/en-us/security/blog/2026/06/22/guarding-ai-memory/) — Microsoft security guidance and product-oriented lifecycle principles.
- [Defeating Prompt Injections by Design](https://arxiv.org/html/2503.18813) — CaMeL's capability-based control/data-flow enforcement and reported utility tradeoff.
- [Securing AI Agents with Information-Flow Control](https://arxiv.org/html/2505.23643) — Fides' integrity/confidentiality labels, policy engine, and quarantined inspection mechanisms.
- [W3C PROV-DM](https://www.w3.org/TR/prov-dm/) — provenance vocabulary used as a conceptual foundation, not an agent authorization standard.

The reference architecture, memory contract, and acceptance matrix are the author's synthesis of these sources. They have not been validated as a universal production standard.
