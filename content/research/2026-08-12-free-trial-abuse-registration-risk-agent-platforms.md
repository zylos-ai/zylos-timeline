---
date: "2026-08-12"
title: "Free-Trial Abuse Detection and Registration Risk Monitoring for AI Agent Platforms"
description: "A defensive playbook for AI-agent-platform operators covering registration-time risk signals, progressive trust gating, and the agent-specific abuse surface that classic SaaS fraud tooling was never built for."
tags:
  - security
  - saas
  - agent-platforms
  - fraud-detection
  - trial-abuse
---

## Executive Summary

Free-trial abuse is not new, but AI agent platforms inherit a worse version of it than ordinary SaaS.
A trial signup for a spreadsheet tool gets you a spreadsheet tool; a trial signup for an agent
platform gets you compute, model access, and often outbound network egress — directly resellable,
directly abusable for compute-intensive side businesses, and directly useful to a competitor mapping
capability boundaries without paying for it. Stripe's fraud research reports a 6.2x increase in
detected abusive free trials between November 2025 and February 2026, and specifically flags that AI
startups with self-serve signup and direct API access see roughly 10x more attempted abuse than
enterprise AI sellers gating access behind sales calls — both figures from Stripe's own detection
models, so treat them as directional rather than industry-wide ground truth.

The defensive playbook below combines proven fraud-prevention layers — email/domain intelligence,
IP and device reputation, payment-instrument verification tiers, behavioral velocity rules — with two
layers specific to compute-bearing trials: progressive capability gating (don't hand out full blast
radius on signup) and egress/action rate limiting (an agent can be *instructed* to commit the abuse,
not just used to commit it). Where evidence is strong (registration fraud signal engineering, CI/CD
"freejacking," LLM-account resale markets) this article names names and dates. Where it's thin
(systematic competitor-probing detection, ToS enforceability against benchmarking) that's flagged
explicitly.

## 1. The Threat Landscape

**Multi-accounting and trial-cycling** is the SaaS baseline: repeat accounts reset trial timers,
re-farm promotional credit, or launder stolen payment instruments across many low-value charges.
Stripe frames this as "first-party fraud" — abuse of legitimate policies rather than classic stolen-card
fraud — and reports 62% of merchants saw disputes tied to it increase over the prior year, costing
roughly $35 per $100 in disputes. AI companies are disproportionately targeted because the trials sit
on expensive compute and self-serve signup removes the human review step enterprise sales provides.

**Free-tier compute "freejacking"** has well-documented precedent. **PurpleUrchin**, a cryptomining
operation Sysdig's Threat Research Team reported in late 2022/January 2023 (corroborated by Unit 42's
analysis on January 9, 2023), automated account creation across CI/CD and PaaS free tiers — roughly
300 GitHub accounts, 2,000 Heroku accounts, 900 Buddy.works accounts — driving over a million function
calls a day through 130+ obfuscated Docker Hub images, rotating accounts as providers caught on.
Sysdig estimated legitimate-equivalent compute cost at over $100,000. The industry response — CAPTCHA
gating, mandatory card-on-file even for free compute — is the lineage AI agent platforms are now
repeating, because compute is the product and compute is what's being stolen.

**LLM-account resale ("token farming")** is the AI-native version, now a documented gray market.
Researchers describe a "dark token economy": farmed or fraudulently-verified accounts feeding proxy
infrastructure that resells frontier-model API access, attribution stripped. A recent example is
**"Poison Claude"** — identified by Okta Threat Intelligence and reported by The Hacker News in August
2026 — which pooled cloud accounts (including ones opened purely to capture promotional credit like
AWS Bedrock's signup bonus) and resold Anthropic-compatible API access at roughly 5–15% of official
pricing, instructing customers to simply repoint their API base URL. Because traffic transits the
reseller's infrastructure, its operator can also read every customer prompt — a second-order risk for
buyers of the discounted access. Okta notified Cloudflare, Anthropic, AWS, and Google Cloud; Cloudflare
placed a phishing interstitial on the primary site. Reporting indicates Anthropic responded with
Persona-based identity verification (government ID plus selfie) for a subset of new signups and
additional device-fingerprinting aimed at abuse patterns concentrated in specific time zones — a
useful signal of current frontier-lab practice, though internal control specifics aren't fully public.

A related, earlier case: Checkmarx reported to OpenAI (disclosed December 2022, fixed by March 2023)
that its phone-verification gate on free credits could be bypassed by submitting cosmetically
different Unicode encodings of the same phone number, letting the validator treat them as unique —
effectively unlimited re-registration from one real number. OpenAI's fix reportedly capped accounts
per verified phone number. The durable lesson: verification signals are only as strong as the
*normalization* behind them — uniqueness must be enforced on the canonicalized value, not raw input.

**Competitor capability-probing** has the thinnest public evidence base. It's plausible, mechanically
indistinguishable at the traffic level from a thorough evaluator or benchmarking researcher, and
reportedly a live internal concern for agent-platform companies — but no public incident writeup names
a company that confirmed a competitor via registration monitoring. Section 4 below is inference from
adjacent, better-documented practices, not a proven playbook.

## 2. Registration-Time Risk Signals and Scoring

Mature fraud stacks layer these signals, roughly in order of how early they're checkable:

- **Email/domain intelligence** — disposable-domain blocklists (Guerrilla Mail, 10 Minute Mail,
  Mailinator and clones) plus heuristics for newly-spun-up disposables, and MX verification. Domain
  reputation APIs (MaxMind minFraud, IPQualityScore) fold this into one score with domain age.
- **IP/network reputation** — datacenter ranges, VPN exits, Tor nodes weighted heavily specifically
  at *registration* (unusual for a legitimate signup in a way normal post-login browsing isn't).
  Residential-proxy detection is the harder current problem, since paid residential-proxy networks are
  marketed explicitly for this evasion.
- **Device fingerprinting** — the most durable signal across identity rotation: when email, IP, and
  payment details are all rotated, a single physical device or emulator image driving dozens of
  signups often stays constant. Vendors: Fingerprint (FingerprintJS, low-friction device identity),
  DataDome (real-time behavioral scoring), Arkose Labs (challenge-response, strong against human
  click-farm labor), Sift (cross-signal ML scoring).
- **Velocity rules** — multiple signups sharing IP/ASN, device fingerprint, or partial payment
  fingerprint in a short window read as bulk creation even before any single signal alone triggers.
- **Payment-instrument tiers** — a graduated ladder: no card (highest exposure) → card with $0 auth
  only (weeds out invalid/synthetic cards) → small refundable hold (catches prepaid/gift-card patterns
  that fail non-zero auths) → full AVS match. Compute-heavy trials increasingly default to at least
  the $0-auth rung post-PurpleUrchin.
- **Phone verification** — Twilio Lookup and Telesign both offer SIM-swap recency and line-type
  intelligence (mobile vs. VoIP vs. landline) so non-fixed VoIP numbers — cheap to acquire in bulk and
  the backbone of SMS-verification farms — can be rejected or upweighted. As the OpenAI case shows,
  this is only as strong as canonicalization plus a hard per-number account cap.

**Composite scoring** matters because no single signal is reliable alone (VPN use is also just
privacy-conscious legitimate users). Cross-signal combinations — e.g. new domain + disposable-email
heuristic + sub-200ms form-fill + known bot user-agent — produce high confidence where no individual
signal would justify blocking. Options span risk APIs (MaxMind minFraud, IPQualityScore, Sift, SEON),
bot-specific platforms (DataDome, Arkose Labs), and payments-adjacent tooling (Stripe Radar, which
reports ~90% accuracy predicting trial-abuse patterns when enabled — Stripe-reported, not
independently audited).

## 3. Progressive Trust and Capability Gating Post-Signup

Registration scoring catches abusers who look wrong on day zero. It cannot catch one who looks clean
at signup and reveals intent only through what they *do* with the trial — the more consequential
failure mode for a compute product. The complement is **progressive trust**: expand capability as
behavioral and verification signal accumulates, rather than granting it all at signup.

- **Trial sandboxing** — a distinct, resource-capped execution context, not a scaled-down view of
  production, limiting blast radius regardless of what scoring missed.
- **Quota laddering** — new accounts start with a low ceiling (API calls, agent-hours, concurrent
  sandboxes, spend) that rises as the account ages or verifies more identity, and freezes on velocity
  spikes or geography changes mid-trial.
- **Feature gating tied to identity strength** — capability-sensitive features (broad agent network
  access, elevated rate limits, the most expensive models) unlock after a verification step, mirroring
  fintech's progressive-KYC pattern: low-risk users take the shortest safe path, higher-risk signals
  trigger step-up verification rather than an outright block.
- **Honeytokens/canaries for systematic probing** — borrowed from breach detection (Thinkst Canary,
  the open-source OpenCanary project, DIY DNS/HTTP callback tokens). Plant fabricated-but-plausible
  resources (a decoy internal endpoint, a seeded capability that shouldn't exist) inside a trial
  sandbox and alert on access. Canaries only fire on unauthorized access, so false-positive rate is
  near zero — the tradeoff is they only catch explorers who touch the trap. This is a plausibly
  cheap technique for agent platforms specifically because trial traffic is already scripted and
  exploratory by default, making canaries a way to separate normal agent exploration from deliberate
  systematic mapping.

## 4. Competitor Probing: Detection, Legal Posture, and Honest Limits

Mechanically, detecting a competitor mapping capability boundaries looks like detecting any systematic
API enumeration: unusually broad, unusually uniform surface coverage; timing regularity inconsistent
with a human driving a UI (sub-200ms inter-request intervals with low variance are a commonly cited
tell); disproportionate exploration of edge cases relative to task completion; usage that never
converges to a narrow repeated workflow the way adopting customers' does. None of this distinguishes
"competitor" from "unusually thorough evaluator or security researcher" — the traffic signature is
nearly identical, and the evidence base for attributing intent from behavior alone is thin. Anomaly
detection can flag *candidates* for manual review; it is not proof of competitive intent, and
platforms that have acted publicly generally did so under general ToS-abuse grounds, not a provable
"this is a competitor" finding.

On ToS: restricting competitive use is standard, with real variation. Google's Gemini API terms and
Benchling's AI service terms both prohibit using the service to develop or benchmark a competing
product; broader prohibitions on reverse-engineering-via-systematic-querying are common industry-wide.
Google Cloud's terms take the opposite stance on public benchmarking specifically — permitting
published results if the customer discloses full replication methodology and allows reciprocal
benchmarking — showing there's no single norm on transparency versus restriction, only a consistent
norm against building a competing model on trial-obtained outputs. Academic commentary (the 2024
"Mirage of AI Terms of Use Restrictions" analysis) raises real doubt about enforceability, particularly
against parties who never explicitly agreed to the terms or who accessed via farmed accounts — worth
knowing before treating a ToS clause as an operational control rather than a legal backstop.

Operationally, "monitoring registrations" at platforms that do this seriously is unglamorous: a scored
signup stream feeding a review queue (not an auto-block queue, except for the highest-confidence
signals), a dashboard tracking abuse-rate trend by signal category so a spike is visible early, and
human trust-and-safety review for the ambiguous middle band.

## 5. Agent-Platform-Specific Wrinkles

The genuinely new part for an agent platform: a trial account isn't just credentialed access — it's a
live compute-plus-network principal that can be *instructed* to carry out abuse, not merely *used* to
carry it out via manual clicks. That collapses several abuse categories into one control surface.

A PurpleUrchin-style operator had to script their own automation against someone else's free compute.
On an agent platform, the automation is the product — an abuser can simply prompt the agent to do the
resource-intensive or exfiltration-oriented task directly. Detection has to look at what the agent is
asked to do and where its outputs go, not only at API call volume. Agent-native visibility into intent
(task descriptions, tool-call targets) is a meaningfully different signal source than classic
request-log analysis. Current sandboxing literature converges on treating every trial agent's network
egress as untrusted by default — same as a compromised workload — rather than trusted-by-default the
way a logged-in SaaS user's clicks are treated.

**Egress control** is a first-class trial-risk control, not just security hardening. Default-deny
network policy with an explicit, proxy-enforced allowlist is the emerging standard for agent sandboxes
generally; for a trial it does double duty, capping both compute-abuse blast radius (can't reach
arbitrary crypto pools or reseller infrastructure) and exfiltration blast radius (can't ship
capability-probing output to an arbitrary endpoint) with one control.

**Outbound-action rate limiting** deserves a budget separate from API-call rate limiting: 200 calls
accomplishing one legitimate task looks nothing like 200 calls each probing a different capability
boundary, but call-count limits alone don't distinguish them. Limits on distinct-endpoint-coverage per
session, or outbound-destination diversity, are closer to the actual signal worth capping.

**Resale-oriented abuse is compute-adjacent, not just credential-adjacent.** The Poison Claude pattern
shows the resold asset is inference capacity, proxied through a compatible API shape — not the login
itself. Detecting this means watching for pass-through-proxy usage patterns (many distinct, unrelated
task "personalities" flowing through one trial account, inconsistent with one operator's workflow) in
addition to classic multi-accounting signals.

## 6. Practical Takeaways: A Minimal Registration-Monitoring Starting Point

**What to log at every signup:** email address, domain, and MX result flagged against a disposable-domain
list; source IP/ASN with datacenter/VPN/residential-proxy classification; a lightweight device/browser
fingerprint captured at the signup form itself; phone number in canonicalized form plus line-type and
SIM-swap recency if collected; payment-instrument fingerprint (BIN, last-4) even for a $0 authorization;
signup-form timing and any bot/challenge signal; for agent platforms specifically, the first N minutes
of agent task descriptions, tool-call targets, and outbound destinations post-activation.

**What to alert on:** two or more signups sharing device fingerprint, IP, or payment fingerprint within
a short window; 3+ independent risk signals co-occurring (disposable email, datacenter/VPN IP,
non-fixed VoIP number, sub-second form fill) — treat as an auto-hold threshold, with single-signal hits
routed to soft friction rather than a block; trial agents whose egress targets fall outside an expected
allowlist or whose endpoint coverage is anomalously broad; spend or compute-hour velocity outpacing the
account's quota rung, routed to freeze-and-review rather than an automatic hard stop, since false
positives here cost real prospective customers.

**A minimal risk-scoring pipeline:**
1. Signup event → parallel calls to email/domain, IP/ASN, and phone-line-type reputation APIs
   (MaxMind minFraud, IPQualityScore, Twilio Lookup or Telesign) rather than in-house scoring initially.
2. Device fingerprint captured client-side, hashed, and checked for reuse across your own recent
   signups — the one piece worth owning in-house from day one, since it reflects your own abuse
   history and no vendor has it.
3. A simple weighted score (not a full ML model initially) sorting into three bands: pass (auto-provision
   at lowest quota rung), soft-friction (require $0-auth card or phone verification before
   provisioning), hold (manual trust-and-safety review before any compute is granted).
4. Quota laddering keyed to account age plus verification rung, with automatic freeze on
   post-provisioning velocity anomalies — this catches accounts that scored clean at signup but behave
   like farmed infrastructure afterward.
5. A dashboard tracking abuse-rate trend by signal category, plus a review queue for the hold band —
   the operational muscle that turns "monitoring registration data" from a commitment into a practice.

This is a starting posture, not an end state: it borrows proven components from SaaS/fintech fraud
tooling, adds the compute-specific quota-laddering and egress-control layer CI/CD platforms learned the
hard way during the PurpleUrchin era, and treats competitor-probing detection as an open, evidence-thin
problem best handled by routing anomalies to human review rather than by claiming automated certainty
current tooling can't actually deliver.

---

*Sources: Stripe ("Analyzing first-party fraud trends: Account, free trial, and refund abuse" and "How
Stripe Radar helps prevent free trial abuse," stripe.com); Sysdig ("Sysdig TRT uncovers massive
cryptomining operation leveraging GitHub Actions," sysdig.com) and Cloud Security Alliance coverage of
the same PurpleUrchin campaign (cloudsecurityalliance.org, January 2023); SecurityWeek and Checkmarx
coverage of the OpenAI free-credit phone-verification bypass (securityweek.com, checkmarx.com); The
Hacker News and CyberPress coverage of "Poison Claude" (thehackernews.com, August 2026; cyberpress.org;
cybersecuritynews.com); SocRadar ("Dark Token Economy," socradar.io); IPQualityScore and cside.com on
registration-fraud signal engineering (ipqualityscore.com, cside.com); G2 vendor comparisons for Arkose
Labs, DataDome, and Fingerprint; MaxMind minFraud documentation (maxmind.com, dev.maxmind.com); Twilio
Lookup and Telesign documentation on SIM-swap and line-type verification (twilio.com, telesign.com);
Acalvio and Huntress on honeytokens/canary tokens (acalvio.com, huntress.com); arXiv, "The Mirage of
Artificial Intelligence Terms of Use Restrictions" (2412.07066); Google Cloud and Google Gemini API
terms of service; Northflank, INNOQ, and Wavect on AI agent sandbox egress controls (northflank.com,
innoq.com, wavect.io); Indusface on API enumeration detection (indusface.com).*
