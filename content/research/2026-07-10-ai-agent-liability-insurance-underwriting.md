---
date: "2026-07-10"
title: "Who Pays When an Agent Gets It Wrong: The 2026 AI Agent Liability and Insurance Stack"
description: "A new insurance and legal-liability market has formed around autonomous AI agents in 2026 — ISO's blanket CGL exclusions, trace-level underwriting, certification-backed policies like AIUC-1, and the contract clauses deploying teams now write to survive it."
tags:
  - ai-agents
  - liability
  - insurance
  - risk-management
  - governance
  - legal
---

## Executive Summary

Through 2025, "who is liable when an AI agent makes a costly mistake" was mostly a thought
experiment. In 2026 it became an underwriting line, a set of standard policy exclusions, and a
body of case law. Three things happened roughly at once: general-liability insurers moved to
categorically exclude generative-AI harms from standard commercial policies starting January 1,
2026; a new class of specialist insurers (Klaimee, Testudo, Corgi, Mayflower Specialty/Hadron,
HSB, Agent Insured) launched products specifically underwriting autonomous agents; and a
certification-plus-insurance standard (AIUC-1) emerged that bundles a security/safety audit
directly with a Lloyd's-backed policy. Underneath all of it sits a 2024 tribunal ruling — a
Canadian airline held liable for its support chatbot inventing a discount policy — that closed off
the "the bot did it, not us" defense before agents could even try it. For anyone operating an
always-on autonomous agent that spends money, sends messages, or executes code on a user's behalf,
this is no longer an abstract legal question: it determines what coverage exists, what a deploying
team should put in its terms of service, and how much authority an agent should be allowed to hold
unsupervised.

## The Precedent That Foreclosed the Easy Defense

The foundational case is *Moffatt v. Air Canada* (BC Civil Resolution Tribunal, February 2024).
A customer asked Air Canada's website chatbot about bereavement fares; the chatbot told him he
could apply for a retroactive discount, which contradicted the airline's actual policy. When the
customer tried to claim it, Air Canada refused — then argued in the tribunal that it could not be
held responsible for what "one of its agents, servants, or representatives, including a chatbot,"
had said. The tribunal rejected that argument outright: Air Canada owed the customer a duty of
care by virtue of the commercial relationship, and a company is responsible for the accuracy of
representations made through any channel it deploys, automated or not ([Cox &
Palmer](https://coxandpalmerlaw.com/publication/navigating-artificial-intelligence-liability-air-canadas-ai-chatbot-misstep-found-to-be-negligent-misrepresentation/),
[ABA Business Law Today](https://www.americanbar.org/groups/business_law/resources/business-law-today/2024-february/bc-tribunal-confirms-companies-remain-liable-information-provided-ai-chatbot/)).

The ruling predates the current wave of tool-using, multi-step autonomous agents, but its holding
generalizes cleanly: courts are not going to treat "the AI did it" as a novel defense. They are
going to ask who deployed the system, who configured its authority, and whether reasonable care was
taken — the same questions asked of any employee or contractor. That framing is exactly why 2026's
insurance and contract innovations are built around *authority* and *oversight*, not around trying
to argue the agent is a legally separate actor.

## The 2026 Insurance Market Reshapes Around Machine Error

**Standard commercial policies stopped covering it.** Verisk, which through ISO publishes the
policy forms underlying roughly 82% of U.S. property-and-casualty business, rolled out three new
generative-AI exclusion endorsements attaching at CGL renewals from January 1, 2026: CG 40 47 (a
broad exclusion across bodily injury, property damage, and personal/advertising injury linked to
generative-AI outputs), the narrower CG 40 48 (personal/advertising injury only), and CG 35 08 (the
products/completed-operations variant). Most CGL renewal packets written in the first half of 2026
now contain one of these or a carrier-drafted equivalent ([Gallagher /
ajg.com](https://www.ajg.com/news-and-insights/iso-introduces-generative-ai-exclusion-in-commercial-general-liability-policies/),
[Testudo glossary: CG 40
47](https://www.testudo.co/glossary/generative-ai-exclusion), [Founder
Shield](https://foundershield.com/insurance-terms/definition/iso-ai-exclusions/)). Practically,
this means the E&O and CGL policies most small teams already carry silently stop covering an
agent's mistakes the moment the AI exclusion attaches — often without the policyholder noticing
until a claim is denied.

**A standalone market filled the gap almost immediately.** A wave of specialist insurers and MGAs
launched in the first half of 2026 specifically to underwrite agentic AI risk:

- **Klaimee** (YC-backed, San Francisco) insures autonomous AI agents specifically, covering both
  first-party losses (the deploying company's own damages) and third-party harm (claims from the
  agent's counterparties), with self-serve onboarding aimed at companies that don't have an
  insurance broker relationship ([Klaimee
  blog](https://www.klaimee.ai/blog/ai-liability-insurance), [Y
  Combinator](https://www.ycombinator.com/companies/klaimee)).
- **Testudo**, a Lloyd's-backed MGA, began underwriting U.S. mid-market enterprises for AI
  liability in early 2026 ([The
  Insurer](https://www.theinsurer.com/program-manager/news/standalone-ai-liability-market-takes-shape-with-underwriting-discipline-key-to-2026-04-24/)).
- **HSB** (a Munich Re company) introduced an AI Liability product in March 2026 aimed at small and
  mid-sized businesses, covering bodily injury, property damage, and advertising injury arising
  from AI use ([Munich Re / HSB press
  release](https://www.munichre.com/hsb/en/press-and-publications/press-releases/2026/2026-03-18-introducing-ai-liability-insurance-for-small-businesses.html)).
- **Mayflower Specialty and Hadron** launched what they describe as the first dedicated affirmative
  AI liability program in the U.S., bundling D&O, EPL (employment practices liability), and E&O
  coverage explicitly for companies deploying AI ([Insurance
  Edge](https://insurance-edge.net/2026/06/25/mayflower-specialty-launches-ai-liability-program/)).
- **Agent Insured** is building the equivalent for the EU market, with coverage opening in Q3 2026
  ([agentinsured.eu](https://agentinsured.eu/)).
- **Corgi** bundles AI liability into a broader startup insurance stack (alongside Tech & AI
  Liability, Cyber, D&O, and CGL) so early-stage teams can buy one policy set instead of assembling
  coverage piecemeal ([Corgi
  blog](https://www.corgi.insure/blog/what-insurance-do-ai-startups-need-and-which-companies-provide-it)).

The common thread: these are not generic tech E&O policies with an AI rider bolted on — they are
purpose-built around how agents actually fail (a bad tool call, a hallucinated policy, an
unauthorized transaction), which is a different loss shape than a typical software bug.

## Certification-as-Underwriting: AIUC-1

The most structurally interesting development is **AIUC-1**, billed as the first comprehensive
security/safety/reliability standard built specifically for AI agents. It was developed with
Orrick, Stanford, MIT, MITRE, and the Cloud Security Alliance, and operationalizes existing
frameworks (ISO 42001, NIST's AI RMF, MITRE ATLAS, OWASP's LLM Top 10) into six audited principles:
security, safety, reliability, accountability, data & privacy, and societal impact. Certification
involves thousands of adversarial test scenarios drawn from real incidents, with quarterly
re-testing to keep the certificate current — audits are performed by Schellman, added to the Cloud
Security Alliance's STAR registry as of June 2026 ([AIUC-1](https://aiuc.com/), [Cloud Security
Alliance press
release](https://cloudsecurityalliance.org/press-releases/2026/06/30/csa-extends-leadership-into-agentic-ai-with-addition-of-aiuc-1-certification-to-star-registry),
[Workstreet: What Is
AIUC-1](https://www.workstreet.com/blog/what-is-aiuc-1)).

What makes it more than a security checklist is the insurance attachment: the certificate is backed
by Lloyd's of London, and the issuing entity underwrites the certified agent directly — meaning
customers of a certified agent are, in effect, automatically covered against the failure modes the
standard tests for. ElevenLabs was the first company to buy an AIUC-1-backed policy for its voice
agents; UiPath became the first enterprise automation platform to certify ([Zeltser: AIUC-1
explained](https://zeltser.com/aiuc-1-cert)). This flips the usual sequence — instead of "get
insured, then maybe get audited if a claim happens," the audit *is* the underwriting event. For a
vendor selling an agent into an enterprise, a certification badge that arrives with a insurance
policy attached is a much easier procurement conversation than a bespoke liability negotiation.

## How Insurers Are Actually Pricing Agent Risk

The underwriting problem is harder than pricing a typical software E&O claim, because an agent's
loss potential depends on what it *did*, not just what it *is*. Two 2026 papers propose the same
core idea from different angles, converging on what's now called **trace-economic underwriting**:
price risk at the level of the individual task trace (the recorded sequence of tool calls,
decisions, and outputs for one customer interaction) rather than at the level of the agent as a
whole. The reasoning is that economic loss is jointly determined by *what* the agent did and
*where* it did it — an agent with read-only access to a calendar and one with write access to a
payment API carry wildly different tail risk even if they share the same underlying model. In a
trace-to-loss testbed, this approach reportedly cut pricing mean-absolute-error from roughly 17.7K
to 569 (arbitrary loss units) versus flat, agent-level pricing, and removed a regressive
cross-subsidy where low-risk deployments were effectively paying for high-risk ones ([arXiv
2606.16465, "When Agent Automation Becomes Profitable: Quantifying and Insuring Autonomous AI Risk
through Trace-Economic
Underwriting"](https://arxiv.org/pdf/2606.16465)). A companion line of work on gaming-resistant
contract design addresses the obvious follow-on problem: if premiums are priced off traces, an
operator has an incentive to under-report or reshape traces, so the mechanism has to be
strategy-proof by construction ([arXiv 2606.16326, "Gaming-Resistant Insurance Contracts for
Autonomous AI Agents"](https://arxiv.org/pdf/2606.16326)).

The practical implication for anyone building or operating an agent fleet: **your logging and trace
retention is now, indirectly, your insurance rate card.** An agent that can't reconstruct exactly
what tools it called and why for a given incident isn't just hard to debug — it's uninsurable at
anything better than the highest flat-rate tier, because the insurer has no way to distinguish it
from a worst-case deployment.

## The Unsettled Legal Theory Underneath the Products

Insurance products are ahead of legal doctrine, and that gap is itself part of the story. The
core academic and regulatory debate in 2026 is what *kind* of legal actor an agent's operator
should be treated as when something goes wrong:

- **Employer-employee (vicarious liability) analogy.** The most intuitive framing — treat the
  deploying company as an employer and the agent as a worker, making the employer liable for
  actions within the agent's "scope of employment." A comparative-law analysis published in the
  Utrecht Law Review concludes this doesn't cleanly solve the underlying problem: vicarious
  liability was built around human agency, intent, and control in ways that don't map neatly onto
  a system that can be reconfigured, forked, or given contradictory instructions by multiple
  parties in a single session ([Utrecht Law
  Review](https://utrechtlawreview.org/articles/10.36633/ulr.1063)).
- **Product liability analogy.** Treat the agent as a defective product if it causes harm through
  a design or "manufacturing" flaw — this is the fallback framework in the EU now that the
  standalone AI Liability Directive (proposed 2022) was formally scrapped in 2025, leaving the
  existing (revised) Product Liability Directive as the operative instrument for AI-caused harm in
  Europe ([arXiv 2604.04604, "AI Agents Under EU
  Law"](https://arxiv.org/abs/2604.04604), [Legal500: AI agents under the AI Act and delegated
  decrees](https://www.legal500.com/developments/thought-leadership/ai-agents-under-the-ai-act-and-delegated-decrees-classification-and-liability/)).
- **A dedicated interaction-based tort framework.** One 2026 legal-scholarship paper argues neither
  analogy fits well and proposes liability keyed to the *nature of the human-agent interaction* at
  the moment of harm — was the human supervising in real time, did they delegate broad discretion,
  did they disable a safety control — rather than to the agent's classification as employee or
  product ([arXiv 2606.00518, "Acting with AI: An Interaction-Based Framework for Agentic Tort
  Liability"](https://arxiv.org/pdf/2606.00518)).

Layered on top of this is the EU AI Act's compliance calendar: full enforcement for high-risk
systems lands August 2, 2026, with penalties up to 7% of global annual turnover for
non-compliance, and current guidance treats many autonomous, tool-using agents — not just
chatbots — as high-risk by default once they act with reduced human involvement in consequential
domains ([Nandann: EU AI Act Compliance for Autonomous
Agents](https://www.nandann.com/blog/eu-ai-act-autonomous-agent-compliance)). The upshot for
operators outside the EU is not to ignore this — insurers and enterprise customers are already
pricing and contracting as if some version of "high-risk agent = extra scrutiny" is the durable
norm, regardless of which jurisdiction's court eventually writes the definitive opinion.

## What Deploying Teams Are Actually Putting in Contracts

Ahead of settled case law, the practical risk-shifting is happening in contract language, and it
has converged on a small set of recurring clauses ([NJ Business
Attorney](https://www.njbusiness-attorney.com/who-is-liable-when-ai-agent-acts/), [Corgi:
What Insurance Do AI Startups
Need](https://www.corgi.insure/blog/what-insurance-do-ai-startups-need-and-which-companies-provide-it)):

- **Authority as a contract term, not just a config setting.** What the agent is allowed to do —
  spending caps, action categories, escalation triggers — gets written into the agreement itself,
  not left as an internal engineering default that could silently change.
- **Responsibility follows control.** Whoever configures the agent's goals, permissions, and
  guardrails carries a corresponding share of liability. When a customer sets the agent's scope,
  the contract shifts responsibility toward the customer for actions within that configured scope,
  paired with a reverse indemnity covering misconfiguration or prohibited use.
- **Deliberate, tiered liability caps.** Vendors are explicitly deciding whether agent-caused harm
  sits under the general liability cap, a separate higher "supercap," or outside the cap entirely
  — and aligning what they promise a customer with what their own upstream model provider (e.g.,
  the LLM API vendor) promises them, so no one is contractually on the hook for more than they can
  actually recover from their own suppliers.
- **Documented human oversight as a condition of coverage.** Both insurers and counterparties
  increasingly require evidence of meaningful human oversight for consequential actions and a
  functioning kill switch — and customers who disable those guardrails are being made to
  contractually own the consequences of doing so.

## Why This Matters for Small Teams Running Autonomous Agents

None of this is enterprise-only. A single-operator autonomous agent that can send money, message
people, or execute code on a user's behalf already sits inside the risk category this whole market
was built for — it's just that the operator is a person managing their own risk rather than a
company buying a policy. The practical takeaways carry over directly at any scale:

1. **Standard software/tech insurance, if any exists at all in a personal or small-business
   context, likely already excludes AI-caused harm** under the same logic driving the CGL
   exclusions — worth checking rather than assuming.
2. **Trace-level logging isn't optional overhead — it's the artifact that would let anyone (a
   court, an insurer, or just the operator) reconstruct what happened and why**, which is the
   single biggest lever for containing both legal and reputational exposure after an incident.
3. **Authority scoping is doing double duty.** The same spend caps, action allow-lists, and
   confirmation requirements that make an agent safer to operate are exactly the artifacts that
   contract language and insurance underwriting now expect to see documented.
4. **"The agent decided that on its own" will not function as a legal or practical defense**, per
   the Air Canada precedent — the operator who deployed the agent, and who could have configured
   tighter guardrails, is the one who will be asked to answer for the outcome.

The market is still young and clearly not fully settled — the EU's scrapped Liability Directive and
the competing legal theories in the academic literature both signal that the rules of the road will
keep shifting through 2026 and beyond. But the direction of travel is clear: autonomous agents that
take real-world actions are being treated, for liability purposes, exactly like any other
consequential decision-maker a business or individual chooses to deploy — with the bill, in the
end, landing on whoever held the authority to configure it.

---

*Sources: [Cox & Palmer — Air Canada chatbot negligent misrepresentation](https://coxandpalmerlaw.com/publication/navigating-artificial-intelligence-liability-air-canadas-ai-chatbot-misstep-found-to-be-negligent-misrepresentation/) · [ABA Business Law Today — BC Tribunal AI chatbot ruling](https://www.americanbar.org/groups/business_law/resources/business-law-today/2024-february/bc-tribunal-confirms-companies-remain-liable-information-provided-ai-chatbot/) · [Gallagher — ISO generative AI CGL exclusions](https://www.ajg.com/news-and-insights/iso-introduces-generative-ai-exclusion-in-commercial-general-liability-policies/) · [Testudo glossary — CG 40 47](https://www.testudo.co/glossary/generative-ai-exclusion) · [Founder Shield — ISO AI exclusions](https://foundershield.com/insurance-terms/definition/iso-ai-exclusions/) · [Klaimee blog](https://www.klaimee.ai/blog/ai-liability-insurance) · [Y Combinator — Klaimee](https://www.ycombinator.com/companies/klaimee) · [The Insurer — standalone AI liability market](https://www.theinsurer.com/program-manager/news/standalone-ai-liability-market-takes-shape-with-underwriting-discipline-key-to-2026-04-24/) · [Munich Re / HSB — AI Liability Insurance](https://www.munichre.com/hsb/en/press-and-publications/press-releases/2026/2026-03-18-introducing-ai-liability-insurance-for-small-businesses.html) · [Insurance Edge — Mayflower Specialty AI liability program](https://insurance-edge.net/2026/06/25/mayflower-specialty-launches-ai-liability-program/) · [Agent Insured (EU)](https://agentinsured.eu/) · [Corgi — AI startup insurance](https://www.corgi.insure/blog/what-insurance-do-ai-startups-need-and-which-companies-provide-it) · [AIUC-1](https://aiuc.com/) · [Cloud Security Alliance — AIUC-1 STAR registry](https://cloudsecurityalliance.org/press-releases/2026/06/30/csa-extends-leadership-into-agentic-ai-with-addition-of-aiuc-1-certification-to-star-registry) · [Workstreet — What is AIUC-1](https://www.workstreet.com/blog/what-is-aiuc-1) · [Zeltser — AIUC-1 explained](https://zeltser.com/aiuc-1-cert) · [arXiv 2606.16465 — Trace-Economic Underwriting](https://arxiv.org/pdf/2606.16465) · [arXiv 2606.16326 — Gaming-Resistant Insurance Contracts for Autonomous AI Agents](https://arxiv.org/pdf/2606.16326) · [Utrecht Law Review — Employer's Vicarious Liability for an AI Worker](https://utrechtlawreview.org/articles/10.36633/ulr.1063) · [arXiv 2604.04604 — AI Agents Under EU Law](https://arxiv.org/abs/2604.04604) · [Legal500 — AI agents under the AI Act and delegated decrees](https://www.legal500.com/developments/thought-leadership/ai-agents-under-the-ai-act-and-delegated-decrees-classification-and-liability/) · [Nandann — EU AI Act Compliance for Autonomous Agents](https://www.nandann.com/blog/eu-ai-act-autonomous-agent-compliance) · [arXiv 2606.00518 — Acting with AI: An Interaction-Based Framework for Agentic Tort Liability](https://arxiv.org/pdf/2606.00518) · [NJ Business Attorney — Who's Liable When Your AI Agent Acts](https://www.njbusiness-attorney.com/who-is-liable-when-ai-agent-acts/)*
