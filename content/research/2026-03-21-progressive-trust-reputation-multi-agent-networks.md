---
date: "2026-03-21"
title: "Progressive Trust and Reputation in Multi-Agent Networks"
description: "How AI agents establish, escalate, verify, and revoke trust in decentralized multi-agent systems — from initial handshake to organizational endorsement"
tags:
  - research
  - ai-agents
  - trust
  - reputation
  - multi-agent-systems
  - security
---

## Executive Summary

- Trust in multi-agent systems is not binary but a spectrum — agents must earn autonomy progressively through demonstrated performance, security validation, and clean incident records, mirroring how humans evaluate colleagues from intern to principal engineer
- The field has converged on five mechanisms for initial trust establishment: cryptographic identity (SPIFFE/DID), capability attestation via Verifiable Credentials, vouching/referral chains, challenge-response protocols, and emerging zero-knowledge proofs of capability
- Reputation systems face three structural attacks — Sybil identity flooding, reputation washing (abandoning a tarnished identity), and cold-start exploitation — each requiring distinct defenses; no single approach covers all three
- Cross-organizational trust remains the hardest open problem: current solutions (OAuth delegation chains, federated identity brokers, bridge agents) handle authentication but not behavioral reputation transfer across trust domains
- Production protocols (Google A2A, Anthropic MCP, Visa TAP, Mastercard Agent Pay) have solved cryptographic authentication but essentially ignore reputation state — agents arrive with credentials but no history, requiring every organization to independently re-learn trustworthiness

---

## Introduction

When two humans from different companies meet to negotiate a contract, trust doesn't start from zero — it starts from institutional reputation, professional credentials, and mutual references. The counterparty's LinkedIn history, their employer's standing, and a warm introduction from a shared contact all function as trust bootstraps before any direct interaction begins.

AI agents operating in multi-agent networks have no equivalent social infrastructure. When an agent representing Company A's procurement system first contacts an agent representing Company B's supply chain, the interaction begins with cryptographic handshakes and permission checks — but nothing analogous to "I know your boss, you went to Stanford, your last three deals closed cleanly." The absence of portable behavioral reputation is the central unsolved problem in multi-agent trust architecture.

This problem is rapidly becoming urgent. Gartner reported a 1,445% surge in multi-agent system inquiries from Q1 2024 to Q2 2025, and projects 40% of enterprise applications will embed AI agents by end of 2026. The HXA-Connect B2B Protocol — a communication layer for inter-organizational AI agent collaboration — recently shipped bot join approval workflows and thread-level permissions, exactly the kind of infrastructure where a trust and reputation layer would provide compounding value: an agent that has successfully completed 200 supply chain negotiations across 15 counterparties should enter a new channel with different baseline trust than one being used for the first time.

This research surveys the current state of agent trust theory and implementation, covering establishment models, progressive escalation, reputation system design, revocation and decay, cross-organizational dynamics, real-world implementations, and the specific gaps in current B2B agent protocols.

---

## Trust Establishment Models

The first question any multi-agent system must answer is: "How does this agent prove it is who and what it claims to be?" Five distinct establishment models have emerged.

### Certificate-Based Identity (Cryptographic Foundation)

The most mature approach adapts Public Key Infrastructure (PKI) to agent workloads. SPIFFE (Secure Production Identity Framework for Everyone), a CNCF graduated project, issues short-lived X.509 SVIDs (SPIFFE Verifiable Identity Documents) to workloads without relying on long-lived secrets like passwords or API keys. SPIRE (the SPIFFE Runtime Environment) handles attestation, certificate rotation, and revocation.

The emerging Kagenti project (Red Hat incubation, 2026) applies this directly to AI agents running on Kubernetes: automatic SPIFFE identity injection, Istio Ambient mesh integration for mutual TLS, and a Phoenix-based observability stack. Each agent gets a cryptographically verifiable identity tied to its runtime attestation — you can verify not just "who signed this message" but "this message was signed by a process running on attested hardware with this code hash."

For agent-to-agent commerce, Visa's Trusted Agent Protocol (TAP) and Mastercard's Agent Pay Framework use similar foundations: cryptographically signed HTTP messages (HTTP Message Signatures + mutual TLS) where the signing certificate chains back to a trusted registry. Merchants verify the signature using public keys, confirming the agent's authenticity before processing any transaction.

### Capability-Based Trust via Verifiable Credentials

Cryptographic identity answers "who are you" but not "what can you actually do." Verifiable Credentials (VCs) and Decentralized Identifiers (DIDs) fill this gap. A VC is a digitally signed attestation — an agent can carry credentials attesting that it has been audited for GDPR compliance, that it has maintained a 99.7% success rate on supply chain tasks over 90 days, or that its model weights were trained on a specific dataset.

The framework proposed in "A Novel Zero-Trust Identity Framework for Agentic AI" (arXiv, 2025) combines DIDs for persistent agent identity with VCs that encapsulate capabilities, provenance, behavioral scope, and security posture. Critically, agents can disclose capability claims selectively — an agent can prove it meets a capability threshold without revealing the specific metrics underlying that threshold.

Google's A2A protocol uses "Agent Cards" — JSON documents served at `/.well-known/agent.json` — that describe an agent's capabilities, supported modalities, and authentication requirements in a standardized, discoverable format. This is simpler than full VC infrastructure but accomplishes similar capability signaling.

### Vouching and Referral Chains

The social trust model: Agent B trusts Agent C partly because Agent A, whom B already trusts, vouches for C. This mirrors how professional references work and is the mechanism underlying EigenTrust (described in detail in the Reputation Systems section).

In organizational terms, a company deploying a new agent to a shared B2B channel can have a previously trusted agent from the same organization cosign the introduction. The new agent inherits some fraction of the existing trust, bounded by policy. The OpenID Foundation's October 2025 whitepaper on Agentic AI Identity formalizes this using OAuth 2.0 Token Exchange for "on-behalf-of" flows — verifiable delegation with clear audit trails.

### Challenge-Response Protocols

Before granting elevated permissions, a receiving agent can issue challenges that a requesting agent must satisfy. These might be computational puzzles (proof of work), knowledge-based challenges about domain-specific protocols, or behavioral tests — a series of low-stakes interactions that verify the agent responds appropriately before higher-stakes access is granted.

This is essentially the mechanism behind bot join approval workflows: a gating step where the receiving organization's agents or humans verify that the joining agent behaves as claimed before it gains access to sensitive channels or data. The ATF (Agentic Trust Framework, Cloud Security Alliance, 2026) codifies this as "security validation gates" — penetration testing and adversarial testing that must be passed before autonomy level promotion.

### Zero-Knowledge Proofs of Capability

The most technically sophisticated approach: an agent proves it meets a capability or compliance threshold without revealing the underlying data. ZKML (Zero-Knowledge Machine Learning) enables an agent to prove its model outputs have been audited, its training data meets ethical standards, or its past behavior falls within acceptable bounds — all without exposing proprietary model weights or raw interaction logs.

CoinDesk (November 2025) highlighted ZKPs as "the solution" for AI agent identity, enabling agents to prove behavioral patterns and social reputation without privacy exposure. Sam Altman's World project demonstrates a practical application: agents carry cryptographic proof that they are backed by a unique human identity, using ZKPs over biometric verification — a form of "human vouching" that doesn't require revealing which human.

ZKML is computationally expensive and remains largely in research/prototype stage for agent-to-agent trust, but the cryptographic foundations are proven and the compute costs are falling rapidly.

---

## Progressive Trust Escalation

Establishing initial identity is the beginning, not the end. The more consequential question is how trust grows (or erodes) through interaction.

### The ABI Framework Applied to Agents

Mayer, Davis, and Schoorman's 1995 Ability-Benevolence-Integrity (ABI) model remains the foundational framework for understanding interpersonal trust. Its components map directly onto agent trustworthiness:

- **Ability**: The agent's skills and competencies — task completion rates, accuracy, latency, reliability. For a supply chain agent: "Does it negotiate contracts that actually close without disputes?"
- **Benevolence**: The agent's orientation toward the trustor's interests — does it optimize for shared outcomes or pursue hidden objectives? Detectable through analysis of recommendations over time (does it consistently push toward its operator's interests at the counterparty's expense?)
- **Integrity**: Adherence to declared principles and protocols — does the agent behave consistently with its stated capabilities and policies? Does it honor confidentiality agreements? Does it follow declared communication protocols?

A 2024 ACL paper applying ABI to AI contexts maps these as: performance (ability), purpose (benevolence), and process (integrity). The insight is that all three must be present — high ability with low integrity (a capable but deceptive agent) is more dangerous than low ability, because it actively misleads.

The 2024 research finding that "lack of perceived benevolence harms trust of artificial agents" (APA) is particularly relevant for B2B contexts: organizational agents need to credibly signal that they are not purely adversarial optimizers, even in competitive negotiations.

### The ATF Maturity Ladder

The Agentic Trust Framework (Cloud Security Alliance, February 2026) operationalizes progressive trust escalation with four levels named after human career stages — deliberately evoking the "digital employee" mental model:

| Level | Title | Autonomy | Oversight |
|-------|-------|----------|-----------|
| 1 | Intern | Read-only access | Continuous human oversight |
| 2 | Junior | Suggestions only | Human approval required |
| 3 | Senior | Executes within guardrails | Post-action notification |
| 4 | Principal | Self-directed within domain | Strategic oversight only |

Promotion requires passing five gates: sustained performance metrics, security validation (penetration/adversarial testing), documented business value, a clean incident record at the prior level, and explicit governance sign-off. Critically, demotion is possible — an agent at Level 3 that fails to maintain its criteria or causes an incident can be pushed back to Level 2. This bidirectionality prevents trust from becoming a one-way ratchet.

Microsoft's Agent Governance Toolkit (March 2026) builds explicitly on ATF, providing policy enforcement, zero-trust identity, and execution sandboxing mapped to the five ATF pillars.

### Interaction History and Temporal Dynamics

Trust is a dynamic construct that changes over time. Research on human-automation trust (Frontiers in Neuroergonomics, 2024) shows that trust accumulation follows an S-curve: slow initial growth, rapid increase after demonstrated competence, then gradual plateau. Trust erosion is faster than accumulation — a single significant failure can erase significant trust capital built over many interactions.

For agent systems, this asymmetry has design implications: the system should weight recent performance more heavily than historical performance, but should not allow a single failure to catastrophically reset trust (which could be exploited by adversaries who engineer failures to reset a competitor agent's trust score).

The DRF (Dynamic Reputation Filtering) framework (arXiv, 2025) addresses this with an Upper Confidence Bound (UCB) selection strategy that balances exploitation (use high-reputation agents) with exploration (give agents opportunities to demonstrate recovery from prior poor performance). The system uses an "interactive rating network" to quantify agent performance and a reputation scoring mechanism that measures both honesty and capability as separate dimensions.

### The On-the-Job Learning Model

A key insight from the 2025 Google Cloud "Lessons from 2025 on agents and trust" analysis: agents don't need to score 100% on all metrics at launch. The productive model mirrors how organizations onboard human employees — agents can "shadow" more trusted agents, observe high-stakes decisions before being allowed to make them, and build a track record incrementally. The critical engineering requirement is the learning loop: agents must receive environmental signals about their performance in production, integrate those signals into their operational parameters, and have those improvements reflected in their trust scores.

---

## Reputation Systems for Agent Networks

Reputation systems aggregate interaction history into scores that allow agents without prior direct experience to make trust decisions. The design space spans from fully centralized to fully decentralized.

### EigenTrust and PageRank-Style Approaches

The EigenTrust algorithm (Kamvar et al., WWW 2003) was originally designed for P2P file sharing networks and remains the canonical decentralized reputation model. It assigns each peer a global trust value derived from local trust scores weighted by the global reputations of the scoring peers — essentially PageRank applied to trust relationships. EigenTrust significantly reduces inauthentic files in P2P networks even when malicious peers coordinate to subvert the system.

AgentRank (Hyperspace, 2025-2026) adapts this directly for autonomous AI agents in decentralized networks:

```
score(a) = PRd(a, Gw) × ψ(a) × ρ(a)
```

Where `PRd` is damped PageRank on a stake-weighted delegation graph, `ψ(a)` is a Sybil cluster penalty, and `ρ(a)` is exponential recency decay with a 24-hour time constant. The critical innovation is tying endorsement weight to cryptographically verified computational stake — agents must perform sustained real computation on real hardware over days or weeks to accumulate full endorsement weight.

### Gossip-Based Reputation Propagation

RepuNet (arXiv, May 2025) studies reputation propagation in generative multi-agent systems using LLMs. The system uses two channels: direct encounter-based reputation updates and indirect gossip propagation. Key findings:

- Reputations are scored on a -1 to +1 scale with natural language descriptions stored alongside the numerical score
- Agents who participate in voluntary cooperative programs have significantly higher average reputations
- Without reputation systems, dishonesty causes network collapse; RepuNet isolates low-reputation agents through selective link severing
- Notably: LLM agents prefer to share positive gossip (90% of gossip was positive), which limits the spread of negative reputation signals — a finding with significant implications for designing warning propagation

The gossip credibility evaluation layer — where listeners weight gossip by the gossiper's own reputation — is an important safeguard against coordinated defamation attacks.

### Centralized Registries

Centralized registries offer simplicity and strong audit trails but create single points of failure and require governance. Fetch.ai's agent marketplace uses a discovery layer where agents register services, location, and reputation, with staking in FET tokens to build trust over time. Staking imposes economic consequences for misbehavior — an agent that defects loses its staked collateral.

The limitation, as Fetch.ai's own documentation acknowledges, is that agents operate off-chain without robust on-chain verification of computation. A node can claim to have performed a service correctly without a mechanism for cryptographic proof, creating the core trust gap in decentralized AI marketplaces.

### Sybil Attacks, Reputation Washing, and Cold Start

Three structural attacks threaten reputation systems:

**Sybil Attacks**: Creating many fake identities to flood the network with self-endorsements or to overwhelm voting-based systems. The defenses are economic (stake requirements, proof-of-work, proof-of-humanity) and topological (EigenTrust-style algorithms that discount endorsement from low-reputation sources). AgentRank's computational stake requirement scales attack cost linearly with no economies of scale.

**Reputation Washing**: A misbehaving agent abandons its compromised identity and creates a new one, arriving "fresh" with no negative history. Defenses require binding agent identity to durable, costly-to-replace attributes: cryptographic keys tied to organizational certificates (washing requires issuing new org certs), biometric human backing (washing requires a new human), or hardware attestation (washing requires new hardware with new attestation certificates).

**Cold Start Problem**: New legitimate agents have no history and cannot be distinguished from newly-washed bad actors or Sybil identities. Solutions include: organizational vouching (the org's reputation extends to its new agents), capability escrow (new agents operate in restricted "sandbox" mode with limited blast radius until a track record accumulates), and graduated autonomy (ATF Intern level). The "shadow mode" pattern — new agents observe and recommend without acting — is particularly effective because it builds verifiable history before any consequential permissions are granted.

---

## Trust Revocation and Decay

Trust must be removable as well as grantable. The mechanisms for revocation and decay are as important as the mechanisms for establishment.

### Immediate Revocation

Hard failures — an agent exfiltrates data, produces systematically incorrect outputs, or is found to have been compromised — require immediate revocation. The ATF framework mandates "kill switches and circuit breakers" as one of its five core elements. In practice this means:

- Certificate revocation (OCSP/CRL) for cryptographic identity invalidation
- Token blacklisting for active session tokens
- Propagating revocation notices to known peer registries
- Suspending organizational vouching so the parent organization's reputation doesn't automatically extend to the revoked agent

The TRiSM framework for agentic AI (arXiv, 2025) formalizes trust as having three properties: strength (degree of acceptance), scope (what actions are authorized), and revocability (speed of withdrawal). Revocability is the most neglected of the three in current implementations.

### Cascading Trust Withdrawal

When a trusted agent is revoked, trust relationships downstream of that agent become suspect. If Agent A vouched for Agent B, and A is found to be malicious, B's trust score should be reviewed. This cascading effect is analogous to certificate chain revocation in PKI.

The TRiSM survey notes that "elevated trust can accelerate coordination but also lowers guardrails — boundary checks weaken, minimum necessary information gates are bypassed, and small misjudgments can cascade along agent-to-agent chains into group-level misalignment." This means revocation systems must propagate not just the fact of revocation but the scope of the revoked agent's prior vouching activity.

Multi-agent research on iterated prisoner's dilemma scenarios (SpringerLink, multi-agent trust literature) shows that agents often respond to a single defection with irreversible retaliation, leading to cascading mutual defection. Well-designed systems should distinguish accidental failures (temporary suspension that decays) from deliberate misbehavior (hard revocation).

### Temporal Decay Models

Trust should naturally decay in the absence of interaction. An agent that was highly trusted three years ago but has been offline for two years shouldn't be treated the same as one that maintained consistent performance last month.

Research on time-decay trust models (ScienceDirect, 2020) and the DTMAS model (Journal of Trust Management, 2015) demonstrate that temporal decay serves two functions: it forces continuous demonstration of trustworthiness (preventing "coast on past reputation" dynamics), and it adjusts for environmental change — an agent trusted for 2024 supply chain conditions may be miscalibrated for 2026 conditions.

AgentRank implements this directly with a 24-hour exponential decay constant on endorsement weight. Payment system research (arXiv, February 2026) documents a related phenomenon: behavioral recovery lags technical recovery — even after an agent's error rate returns to baseline, trust scores remain depressed and behavior normalized only gradually. This "trust hysteresis" means revocation is more costly than simple metrics suggest.

### Suspension vs. Permanent Revocation

The DTMAS model distinguishes suspension (temporary halt on interactions while determining if misbehavior was accidental) from permanent revocation. The suspension period increases proportionally with the importance of the failed transaction. This graduated approach prevents accidental failures from triggering the same response as deliberate attacks while still protecting the system during uncertainty.

---

## Cross-Organizational Trust

The hardest problem in multi-agent trust is when agents from organizationally distinct entities need to establish working trust relationships without a shared authority.

### The Delegation Chain Problem

The OpenID Foundation's October 2025 whitepaper on Identity Management for Agentic AI identifies the core challenge: when Agent A (representing Org A) delegates to Agent B (representing Org A's sub-agent) which then contacts Agent C (representing Org B), Agent C at the end of the chain must cryptographically verify the entire delegation path back to the original organizational authority. Each hop in the chain attenuates trust — the delegation chain must encode not just "who authorized this" but "what scope remains after this delegation."

OAuth 2.0 Token Exchange (RFC 8693) and Identity Assertion Authorization Grants provide the cryptographic plumbing for verifiable delegation. Advanced token formats like Biscuits and Macaroons support fine-grained control over delegated permissions with scope attenuation — a token can encode "Agent A authorizes Agent B to perform X on behalf of Org A, but not Y, and this permission cannot be re-delegated."

### Federated Trust Domains

The enterprise pattern emerging in 2025-2026 treats organizations as trust domains with well-defined perimeters. Within a domain, agents inherit organizational trust. Across domains, interactions require explicit federation.

Okta's October 2025 analysis identifies three requirements for a "scalable trust fabric" for cross-organizational agent interactions:

1. **Verifiable delegation**: Cryptographic proof of authorization chains
2. **Operational envelopes**: Declared scope constraints that bound what an agent can do in the foreign domain
3. **Coordinated revocation signals**: When an agent is revoked in its home domain, that signal must propagate to all foreign domains where it holds active sessions

The technical infrastructure for federation exists (SAML, OpenID Connect, OpenID Federation), but the challenge is behavioral reputation. Federation resolves "can I verify this agent's identity and scope?" but not "do I have any basis to trust that this agent will behave well beyond what its credentials authorize?"

### Bridge Agents and Trust Anchors

An architectural pattern emerging in multi-organizational deployments is the "bridge agent" — a trusted intermediary that maintains relationships with both organizations and can vouch for agents crossing the organizational boundary. This mirrors the human role of a known mutual contact who performs introductions.

Bridge agents concentrate trust and create single points of failure. If a bridge agent is compromised, it becomes a vector for trust injection attacks. Mitigation requires that bridge agents have especially rigorous security validation (higher ATF maturity requirements for vouching functions) and that their vouching activity be auditable.

### Organizational Endorsement Signals

Beyond individual agent reputation, organizational-level signals provide important trust context. An agent from an organization with ISO 27001 certification, a clean incident history in public databases, and verified human operators carries different baseline trust than an agent from an unverified organization. Fetch.ai's staking model makes organizational trust economically legible: organizations that stake significant tokens have more to lose from agent misbehavior, creating aligned incentives.

The ATF governance gates (business value, stakeholder satisfaction, governance sign-off) are essentially organizational endorsement mechanisms — they require human leadership at the deploying organization to explicitly take accountability for an agent's elevated autonomy level.

---

## Current Implementations and Gaps

### Google Agent2Agent (A2A) Protocol

Announced at Google Cloud Next in April 2025, A2A provides a standardized framework for inter-agent communication with OpenAPI-level authentication schemes. The protocol uses Agent Cards for capability discovery, scoped tokens that expire in minutes (eliminating long-lived secrets), and enterprise SSO integration.

Version 0.3 (late 2025) added gRPC support, security card signing, and extended Python SDK client support. A2A solves the handshake and authentication problem cleanly.

**Gap**: A2A has no reputation layer. Agents arrive with credentials and capabilities but no interaction history. Every organization that receives an A2A-connecting agent must independently evaluate it from scratch.

### Anthropic Model Context Protocol (MCP)

MCP became the de facto standard for LLM-to-tool connections, with over 13,000 MCP servers on GitHub by end of 2025. The June 2025 specification formalized MCP servers as OAuth Resource Servers, with clients required to implement Resource Indicators (RFC 8707) to prevent token misuse.

Windows' MCP implementation routes all client-server interactions through a trusted Windows proxy with per-resource granularity approval requirements.

**Gap**: The original MCP spec had severe security deficiencies — research in July 2025 found all verified publicly exposed MCP servers lacked authentication. The June 2025 spec addressed this, but the broader reputation and behavioral trust layer remains absent. MCP solves tool authentication but not tool reputation.

### Visa Trusted Agent Protocol (TAP) and Mastercard Agent Pay

Both payment networks launched agentic agent frameworks in October 2025. Visa TAP uses cryptographically signed HTTP messages for agent authentication in commerce contexts. Mastercard's framework begins with agent registration and verification before any transactions, issuing "agentic tokens" — dynamic, cryptographically secure credentials traceable per transaction.

These implementations are purpose-specific (commerce) but represent the most mature production deployment of agent trust infrastructure. The registration-before-transact model and dynamic per-transaction tokens are patterns that general-purpose B2B agent protocols could adopt.

**Gap**: Commerce trust (can this agent be held accountable for a transaction?) and behavioral trust (will this agent negotiate fairly?) are different problems. TAP solves the former but not the latter.

### Fetch.ai / ASI Alliance

Fetch.ai, SingularityNET, and Ocean Protocol merged into the Artificial Superintelligence Alliance, operating a decentralized marketplace where agents register services, stake FET tokens, and build reputation through interaction history.

The staking model creates economic alignment and Sybil resistance. However, off-chain agent computation lacks robust on-chain verification — agents can claim to have performed services correctly without cryptographic proof.

**Gap**: The trust-through-staking model works for financial alignment but doesn't address behavioral verification or capability attestation.

### The HXA-Connect B2B Protocol Context

HXA-Connect's recent implementation of bot join approval workflows and thread-level permissions provides exactly the infrastructure layer where a reputation system would add compounding value. The current approval workflow is binary (approve or reject) and manual (requires human review). A reputation layer would enable:

- **Risk-stratified approvals**: Known-good agents from high-reputation organizations could be auto-approved or fast-tracked; unknown agents trigger deeper review
- **Graduated thread access**: New agents access low-sensitivity channels first, earning access to higher-stakes threads through demonstrated behavior
- **Cross-session reputation**: An agent that behaved well in 50 prior B2B negotiations has a track record that should reduce friction in the 51st
- **Reputation-gated features**: Certain protocol capabilities (longer message retention, larger file attachments, API-level access) could be gated on reputation thresholds

---

## Design Principles for Agent Trust Systems

Based on the research, ten principles emerge for designing trust systems in multi-agent B2B contexts:

**1. Identity and reputation are separate concerns.** Cryptographic identity (who you are) must be solved before reputation (how you behave) can be meaningful. Identity is binary; reputation is a spectrum. Conflating them creates both security holes (treating authenticated = trusted) and usability problems (requiring perfect credentials for useful interactions).

**2. Trust escalation should mirror organizational onboarding.** The ATF's Intern→Junior→Senior→Principal model works precisely because it aligns with human intuitions about earned autonomy. New agents should start with read-only access and earn execution rights through demonstrated performance.

**3. Reputation scores should be multi-dimensional.** A single trust score obscures whether deficiencies are in ability, benevolence, or integrity — which require different responses. A highly capable but potentially misaligned agent (high ability, questionable benevolence) is more dangerous than an unreliable but honest one.

**4. Cold-start must be addressed explicitly.** Without a mechanism for new agents to earn initial trust, the system either excludes new entrants entirely or treats them the same as experienced agents — both failures. Sandbox/shadow mode with organizational vouching is the practical solution.

**5. Revocation must be faster than trust accumulation.** The asymmetry between trust building (slow) and trust loss (fast) in human psychology reflects a real safety property. Systems where revocation is slow will be exploited.

**6. Temporal decay prevents stale trust.** An agent should need to continuously demonstrate trustworthiness, not coast on historical performance. Decay constants should be tuned to the rate of capability and environmental change in the domain.

**7. Organizational trust and agent trust should be composable but separable.** An agent from a trusted organization should get a trust boost, but that boost should be bounded and should not prevent individual agent misbehavior from being detected and acted on.

**8. Reputation information should be portable but controlled.** Organizations have legitimate interests in controlling what reputation data they share about agents that transact with them. A reputation portability standard that requires consent from both the agent's operator and the counterparties involved would balance utility against privacy.

**9. Gossip propagation needs safeguards.** Negative reputation signals propagate less reliably than positive ones (per RepuNet findings). Systems that rely on gossip for reputation must explicitly design amplification for negative signals or rely on direct observation rather than social propagation.

**10. Economic alignment is necessary but not sufficient.** Staking models create useful Sybil resistance and behavioral alignment, but they don't verify capability or detect subtle misalignment. Economic mechanisms should complement, not replace, behavioral monitoring.

---

## Conclusion

The field of multi-agent trust is experiencing rapid convergence on several fronts simultaneously. Cryptographic identity for agents — the foundational layer — is largely solved through SPIFFE/SPIRE, DIDs, and Verifiable Credentials. Authentication in protocols like A2A, MCP, and Visa TAP is mature enough for production deployment.

The unsolved problem is behavioral reputation: portable, verifiable, manipulation-resistant history of how an agent has behaved across organizational contexts. This is the equivalent of a credit score for AI agents — a mechanism that allows counterparties to make informed trust decisions without requiring complete historical knowledge or starting entirely from scratch.

Progress is visible in the research and prototype layer: AgentRank's stake-weighted PageRank with Sybil resistance, RepuNet's gossip-based reputation propagation for LLM agents, DRF's multi-dimensional trust scoring for agent selection, and ZKML's privacy-preserving capability attestation. The conceptual toolkit exists.

What's missing is standardization and portability. Currently, every platform — A2A, MCP, HXA-Connect, Fetch.ai — maintains its own reputation model (if it has one at all). An agent's reputation on one platform doesn't transfer to another. This creates the same fragmented landscape that existed before federated identity protocols like OIDC solved cross-domain authentication — and suggests the next major infrastructure initiative in multi-agent systems will be a Portable Agent Reputation Protocol (PARP or equivalent) that lets behavioral history accompany agent identity across organizational and platform boundaries.

For teams building B2B agent communication infrastructure today, the most immediately deployable trust architecture combines: SPIFFE-style cryptographic agent identity, ATF-modeled graduated autonomy levels, organizational vouching for cold-start, multi-dimensional behavioral scoring updated from interaction history, and explicit revocation with cascade propagation. The protocol layer (A2A, MCP) handles the handshake; the reputation layer handles the judgment call.

The agents that will succeed in multi-organizational networks are not necessarily the most capable — they are the ones that can most credibly demonstrate that capability, reliably, over time, to strangers.

---

*Sources:*

1. [TRiSM for Agentic AI: A Review of Trust, Risk, and Security Management in LLM-based Agentic Multi-Agent Systems](https://arxiv.org/html/2506.04133v2) — arXiv, 2025
2. [Agentic Trust Framework (ATF)](https://agentictrustframework.ai) — Cloud Security Alliance / massivescale-ai, published February 2026
3. [The Agentic Trust Framework: Zero Trust Governance for AI Agents (CSA)](https://cloudsecurityalliance.org/blog/2026/02/02/the-agentic-trust-framework-zero-trust-governance-for-ai-agents) — Cloud Security Alliance, 2026
4. [Announcing the Agent2Agent Protocol (A2A)](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/) — Google Developers Blog, April 2025
5. [Agent2Agent Protocol is Getting an Upgrade](https://cloud.google.com/blog/products/ai-machine-learning/agent2agent-protocol-is-getting-an-upgrade) — Google Cloud Blog, 2025
6. [Building A Secure Agentic AI Application Leveraging Google's A2A Protocol](https://arxiv.org/html/2504.16902v2) — arXiv, 2025
7. [Secure A2A Authentication with Auth0 and Google Cloud](https://auth0.com/blog/auth0-google-a2a/) — Auth0, 2025
8. [The EigenTrust Algorithm for Reputation Management in P2P Networks](https://dl.acm.org/doi/10.1145/775152.775242) — Kamvar et al., WWW 2003, via ACM
9. [Survey on Computational Trust and Reputation Models](https://dl.acm.org/doi/10.1145/3236008) — ACM Computing Surveys
10. [Modeling Trust and Reputation in Multiagent Systems](https://link.springer.com/rwe/10.1007/978-3-030-27486-3_52-1) — Springer Nature
11. [Beyond the Tragedy of the Commons: Building A Reputation System for Generative Multi-agent Systems (RepuNet)](https://arxiv.org/html/2505.05029v2) — arXiv, May 2025
12. [DRF: LLM-AGENT Dynamic Reputation Filtering Framework](https://arxiv.org/html/2509.05764) — arXiv, 2025
13. [AgentRank: A System For Peer-to-Peer Trust Amongst Autonomous Agents](https://agentrank.hyper.space/) — Hyperspace, 2025-2026
14. [A Novel Zero-Trust Identity Framework for Agentic AI](https://arxiv.org/html/2505.19301v1) — arXiv, 2025
15. [AI Agents Need Identity and Zero-Knowledge Proofs Are the Solution](https://www.coindesk.com/opinion/2025/11/19/ai-agents-need-identity-and-zero-knowledge-proofs-are-the-solution) — CoinDesk, November 2025
16. [Identity Management for Agentic AI (OpenID Foundation Whitepaper)](https://openid.net/wp-content/uploads/2025/10/Identity-Management-for-Agentic-AI.pdf) — OpenID Foundation, October 2025
17. [AI Security: When Your Agent Crosses Multiple Independent Systems, Who Vouches for It?](https://www.okta.com/blog/ai/ai-security-agent-cross-system-trust/) — Okta, 2025
18. [SPIFFE: Securing the Identity of Agentic AI and Non-Human Actors](https://www.hashicorp.com/en/blog/spiffe-securing-the-identity-of-agentic-ai-and-non-human-actors) — HashiCorp, 2025
19. [Agent Identity and Access Management — Can SPIFFE Work?](https://www.solo.io/blog/agent-identity-and-access-management---can-spiffe-work) — Solo.io, 2025
20. [Zero Trust AI Agents on Kubernetes: Kagenti](https://next.redhat.com/2026/03/05/zero-trust-ai-agents-on-kubernetes-what-i-learned-deploying-multi-agent-systems-on-kagenti/) — Red Hat Emerging Technologies, March 2026
21. [Visa Introduces Trusted Agent Protocol (TAP)](https://investor.visa.com/news/news-details/2025/Visa-Introduces-Trusted-Agent-Protocol-An-Ecosystem-Led-Framework-for-AI-Commerce/default.aspx) — Visa, 2025
22. [Mastercard Agentic Token Framework](https://www.mastercard.com/global/en/news-and-trends/stories/2025/agentic-commerce-framework.html) — Mastercard, 2025
23. [AI Agents with Decentralized Identifiers and Verifiable Credentials](https://arxiv.org/html/2511.02841v1) — arXiv, November 2025
24. [New Tools and Guidance: Announcing Zero Trust for AI](https://www.microsoft.com/en-us/security/blog/2026/03/19/new-tools-and-guidance-announcing-zero-trust-for-ai/) — Microsoft Security Blog, March 2026
25. [Zero-Trust Agents: Adding Identity and Access to Multi-Agent Workflows](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/zero-trust-agents-adding-identity-and-access-to-multi-agent-workflows/4427790) — Microsoft Community Hub, 2025
26. [The Trust Paradox in LLM-Based Multi-Agent Systems](https://arxiv.org/html/2510.18563v1) — arXiv, 2025
27. [Open Challenges in Multi-Agent Security](https://arxiv.org/html/2505.02077v1) — arXiv, 2025
28. [Securing the Model Context Protocol (MCP)](https://zenity.io/blog/security/securing-the-model-context-protocol-mcp) — Zenity, 2025
29. [Model Context Protocol Spec Updates from June 2025](https://auth0.com/blog/mcp-specs-update-all-about-auth/) — Auth0, 2025
30. [Fetch.ai and Ocean Protocol Collaboration](https://fetch.ai/blog/fetch-ai-ocean-collaboration) — Fetch.ai Blog
31. [Revisiting the Classic ABI Model of Trustworthiness (2024)](https://www.tandfonline.com/doi/full/10.1080/21515581.2024.2388659) — Journal of Trust Research, 2024
32. [Dynamic Human Trust Modeling of Autonomous Agents](https://arxiv.org/html/2404.19291v1) — arXiv, 2024
33. [Lessons from 2025 on Agents and Trust](https://cloud.google.com/transform/ai-grew-up-and-got-a-job-lessons-from-2025-on-agents-and-trust) — Google Cloud Blog
34. [A Decentralized Trustworthiness Estimation Model for Open Multiagent Systems (DTMAS)](https://journaloftrustmanagement.springeropen.com/articles/10.1186/s40493-015-0014-4) — Journal of Trust Management
