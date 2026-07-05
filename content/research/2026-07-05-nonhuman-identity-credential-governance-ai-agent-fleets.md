---
date: "2026-07-05"
title: "Non-Human Identity and Credential Lifecycle Governance for AI Agent Fleets"
description: "How production teams govern machine identities and credentials for autonomous AI agents, from OWASP's NHI Top 10 and SPIFFE/SPIRE workload identity to Microsoft Entra Agent ID, RFC 8693 delegation, and fork-aware secret hygiene."
tags:
  - ai-agents
  - non-human-identity
  - credential-management
  - identity-governance
  - zero-trust
  - secrets-management
---

## Executive Summary

Every AI agent that can call an API, push a commit, or read an inbox is a non-human identity (NHI) —
and in 2025-2026 the population of these identities exploded faster than the governance practices
meant to control them. Industry estimates put machine identities at 45:1 to 100:1 relative to human
identities in a typical enterprise, and IDC projects up to 1.3 billion AI agents in operation by
2028. GitGuardian's *State of Secrets Sprawl 2026* report found 28.65 million hardcoded secrets
added to public GitHub in 2025 alone (+34% YoY), with secrets tied to AI services up 81% and commits
co-authored by Claude Code leaking secrets at more than double the human-only baseline rate (3.2% vs
1.5%).

The security industry's response has crystallized around a few concrete moves: OWASP shipped a
dedicated **Non-Human Identities Top 10** (January 2025); a wave of vendors (Astrix, Oasis Security,
Entro, Aembit, Natoma) built products specifically for NHI discovery, lifecycle, and brokered auth;
Microsoft shipped **Entra Agent ID** (preview May 2025, expanded GA at Ignite November 2025) as
first-class IAM for agents; Google, Anthropic, and others extended workload identity federation so
agents authenticate via short-lived, federated tokens instead of static keys; and the IETF began
drafting agent-specific extensions to OAuth (token exchange, WIMSE, agentic JWTs) to handle
multi-hop delegation that classic service accounts never needed. Consolidation has started too —
Cisco moved to acquire Astrix (~$400M, reported), and Snowflake announced intent to acquire Natoma
(May 2026), signaling that agent identity is becoming a control-plane feature of larger platforms
rather than a standalone category.

The throughline across all of this: an AI agent that runs continuously, spawns copies of itself, and
acts with delegated human authority breaks assumptions that classic service-account governance
depended on — a fixed 1:1 mapping between credential and workload, infrequent creation/destruction
events, and a human always in the loop for anything sensitive. This article surveys the state of the
field as of mid-2026 and translates it into concrete practices for anyone operating a fleet of
persistent, autonomous agent instances.

## Why AI Agents Break the Classic Service-Account Model

A traditional service account is provisioned once, tied to one application, and rotated on a slow,
predictable cadence. AI agents violate nearly every one of those assumptions:

- **They're created and destroyed dynamically.** An orchestrator can spin up dozens of ephemeral
  agent instances per hour, each needing credentials fast enough that a manual provisioning workflow
  (ticket → approval → secret issuance) is structurally too slow. Static long-lived API keys get
  handed out as a shortcut, and that shortcut is precisely what accumulates as debt.
- **They act with delegated authority, not their own.** An agent reading a user's calendar or
  sending email on their behalf needs a way to express "acting as X, authorized by Y" — a delegation
  chain — not just "I am service account Z." Classic OAuth client-credentials grants don't carry
  that provenance.
- **They can be forked, cloned, or migrated.** Snapshotting a VM or container image that has
  decrypted secrets or an unlocked credential store baked in duplicates that credential store onto
  every clone. This is a known failure mode in traditional golden-image practice (Windows AMIs built
  without Sysprep, or Horizon "instant clone" gold images preserving embedded domain-join secrets),
  and it reproduces even more easily with agent runtimes that persist state across restarts and
  migrations.
- **They call each other.** Multi-agent workflows create delegation chains multiple hops deep (human
  → orchestrator agent → sub-agent → tool-calling agent → external API), and most existing token
  formats only carry point-to-point delegation metadata, not a verifiable end-to-end chain.
- **Attribution collapses under sharing.** When several agent instances share one identity (one
  GitHub bot account, one API key), an incident forensics team cannot tell *which* agent instance
  took a given action. Shared credentials, per multiple 2026 vendor analyses, "eliminate attribution
  and collapse incident response capability."

A February 2026 Cloud Security Alliance survey found that only 23% of organizations have a formal,
enterprise-wide strategy for agent identity, and 78% lack any policy for creating AI identities in
the first place — meaning most fleets are accumulating exactly the kind of undocumented credential
debt this article is written to address.

## The OWASP Non-Human Identities Top 10 (2025)

OWASP published a dedicated Non-Human Identities Top 10 project in 2025 (methodology drawing on
breach data, surveys, and CVE records), the first attempt to standardize the NHI risk taxonomy the
way the classic OWASP Top 10 standardized web app risks. The ten risks:

1. **NHI1:2025 — Improper Offboarding.** Dormant, still-privileged identities (service accounts,
   keys, tokens) left active after the workload, project, or employee they served is gone. Orphaned
   but valid credentials are a favorite lateral-movement vector because nobody is watching them.
2. **NHI2:2025 — Secret Leakage.** Credentials landing in source code, config files, chat tools, or
   logs. GitGuardian's 2026 data point: 22% of organizations have at least one publicly exposed
   asset carrying a long-lived, still-valid vendor secret.
3. **NHI3:2025 — Vulnerable Third-Party NHI.** Risk inherited from a vendor's or integration
   partner's own NHI hygiene (a compromised SaaS-to-SaaS OAuth grant, for example).
4. **NHI4:2025 — Insecure Authentication.** Weak proof of identity for machine callers — shared
   secrets, missing mutual TLS, no attestation.
5. **NHI5:2025 — Overprivileged NHI.** Broad scopes granted "to be safe," rarely walked back.
6. **NHI6:2025 — Insecure Cloud Deployment Configurations.** Misconfigured IAM trust policies,
   exposed metadata endpoints, permissive federation rules.
7. **NHI7:2025 — Long-Lived Secrets.** Static keys and tokens with no expiry, the opposite of the
   short-lived credential model workload identity federation pushes toward.
8. **NHI8:2025 — Environment Isolation.** Failure to separate dev/staging/prod credentials, letting
   a lower-trust environment leak into production.
9. **NHI9:2025 — NHI Reuse.** The same identity/credential reused across applications or components
   — exactly the "one shared GitHub account for many agents" pattern that turns a single compromise
   into a fleet-wide one.
10. **NHI10:2025 — Human Use of NHI.** Humans borrowing a machine identity's credentials for
    convenience (or agents borrowing a human's), blurring the audit trail in both directions.

Every one of these maps directly onto AI agent fleets, but three matter most for autonomous,
long-running agents: **improper offboarding** (an agent gets replaced or migrated and its old
credentials are never revoked), **NHI reuse** (multiple agent instances sharing one identity), and
**long-lived secrets** (static keys instead of rotating, short-lived, federated tokens).

## The NHI Vendor Landscape: Who Does What

The purpose-built NHI security market crystallized in 2025-2026 around a handful of vendors, each
with a distinct point of entry into the problem. Knowing which lane a vendor occupies matters when
evaluating tools for an agent fleet, because "NHI security" spans discovery, brokered auth, and
everything between:

| Vendor | Primary angle | Notes as of mid-2026 |
|---|---|---|
| **Astrix Security** | Discovery and posture for SaaS-to-SaaS OAuth grants, API key sprawl across business apps | Widely described as the most established pure-play NHI platform; subject of a reported Cisco acquisition (~$250M-$400M reported, unconfirmed) to fold into Cisco Identity Intelligence, Duo, and Secure Access |
| **Oasis Security** | Full lifecycle — discovery, posture, rotation, decommissioning in one workflow | Positioned for teams that want governance and remediation, not just a dashboard of what exists |
| **Entro Security** | Secrets-in-context discovery and enrichment, developer-friendly (avoids forcing workflow changes) | Claims to classify 1,000+ NHI types; won a 2026 industry "startup of the year" award per vendor's own materials |
| **Aembit** | Replaces credentials rather than governing them — a policy-based identity broker issuing short-lived, workload-to-workload auth | Explicitly rejects the "discover and rotate secrets" model in favor of eliminating long-lived secrets outright |
| **Natoma** | MCP-specific gateway: centralizes identity, policy, and audit at the tool-call level for agents connecting to enterprise data/tools | Acquired (announced) by Snowflake, May 27 2026, to govern agents accessing Snowflake data; reports finding an average of 225 "shadow AI" MCP connections per enterprise before onboarding |
| **1Password (Unified Access)** | Credential vaulting extended from humans to agents, with scoped/audited runtime access | Launched March 20, 2026; partners named include Anthropic, OpenAI, GitHub, Cursor, Vercel |
| **Microsoft (Entra Agent ID)** | IAM-platform-native agent identity, folded into existing Zero Trust/Conditional Access machinery | Not a standalone vendor play — the strategy is to make agent identity a feature of the IAM platform an org already has |

The market is consolidating quickly (Cisco/Astrix, Snowflake/Natoma) rather than staying a long list
of independent point solutions, which suggests agent identity governance is being absorbed into
broader security and data platforms rather than remaining a permanent standalone product category.
The global NHI access management market itself was estimated at roughly $11.3B in 2025, projected
near $12.2B in 2026 — a signal of how much budget is now chasing this problem, even as most
organizations (per the CSA's 78% figure above) still lack a basic policy for creating agent
identities in the first place.

## Credential-Per-Agent vs. Shared Credentials: What the Platforms Recommend

The consistent recommendation across identity providers, cloud platforms, and AI vendors in
2025-2026 is **one verifiable identity per agent instance**, not one shared identity per fleet or
per team. The rationale is blast radius and revocability: if agent instance #47 is compromised or
misbehaving, you need to be able to kill its credential without affecting the other 200 running
instances, and you need logs that attribute an action to instance #47 specifically rather than to
"the bot."

Concrete platform guidance:

- **GitHub**: fine-grained personal access tokens can be scoped to specific repositories and
  specific permissions (least privilege), but GitHub's own docs steer any real automation workload
  toward **GitHub Apps** instead of PATs tied to a human or shared bot account — a GitHub App is not
  associated with an individual user who might leave, gets its own installation-scoped token, and is
  explicitly designed for "building automations." A fine-grained PAT is still bounded (there's a
  50-token limit per user), and organization owners can require approval for any fine-grained PAT
  targeting the org. The shared-machine-user-account pattern (one login used by many
  agents/services) is exactly what GitHub's guidance is steering people away from.
- **Cloud IAM (AWS/GCP/Azure)**: the standard is workload-scoped roles/service accounts assumed via
  short-lived, federated credentials (AWS IAM Roles Anywhere/OIDC federation, GCP Workload Identity
  Federation, Azure Managed Identity) rather than long-lived access keys checked into config. A role
  can be attached narrowly to one workload's identity claims, so compromise of one workload's
  federated identity doesn't hand over a durable static key usable elsewhere.
- **SPIFFE/SPIRE**: the open-source workload identity standard issues each workload a short-lived,
  cryptographically verifiable **SVID** (SPIFFE Verifiable Identity Document) based on runtime
  attestation, not a static secret. As of mid-2026, production reference architectures deploy SPIRE
  as an enterprise workload identity authority with every agent container receiving an SVID on
  startup via SPIRE's attestation API, rotating roughly hourly. The tradeoff: SPIRE needs real
  infrastructure (attestation nodes, registration servers, a CA), and X.509 issuance latency can be
  a poor fit for very ephemeral, fast-spawning agents. Critically, **SPIFFE identifies the workload
  but doesn't authorize the action** — teams pair it with a relationship-based authorization layer
  (OpenFGA, SpiceDB) to evaluate delegation chains and task-scoped permissions on top of the
  verified identity.
- **AI-provider-level identity**: Anthropic added native Workload Identity Federation to the Claude
  API — any OIDC-capable identity provider can be registered as a federation issuer in the Anthropic
  Console, mapped via a federation rule to a service account, so a workload presents a JWT and
  receives a short-lived Claude access token instead of a static `sk-ant-...` key ever touching
  disk. This directly targets the "static provider API key checked into a config file or shared
  across agent instances" failure mode that GitGuardian's leak data shows is common.

The consistent architectural direction is: **replace long-lived, shared, static secrets with
short-lived, individually-scoped, attested credentials**, whether the mechanism is a cloud IAM role,
a SPIFFE SVID, a GitHub App installation token, or a federated OIDC exchange. Aembit markets this
position most explicitly, describing its approach as replacing discovered/governed credentials with
a policy-based identity broker that authenticates workloads to each other "without long-lived
secrets" at all.

## Agent Identity Lifecycle: Provisioning, Attestation, Rotation, Retirement

Treat an agent identity as having a lifecycle with defined stages, the same discipline applied to
human joiners/movers/leavers (JML) processes — several 2026 vendor guides (Oasis Security, IBM,
Entro) explicitly frame NHI governance as "JML for machines":

1. **Provisioning (minting).** An identity should be created *with* its metadata, not after the
   fact: owner, purpose, environment, TTL, and the specific scopes it needs — not scopes "to be
   safe." Emerging guidance treats owner/purpose/environment/TTL as mandatory fields at creation
   time, stored as tags on the secret rather than embedded in the secret value, precisely so a
   credential's provenance survives even if the person who created it leaves.
2. **Attestation.** Before an identity is trusted, the platform should verify *what* is asking for
   it — SPIFFE/SPIRE does this via node and workload attestation (verifying container/pod identity
   claims against a trust domain); cloud workload identity federation does it via OIDC token claims
   from a known issuer; Microsoft's Entra Agent ID does it by binding the agent identity to a
   registered, governed entry in an "Agent Registry."
3. **Rotation.** Static keys should have a maximum age and an automatic rotation schedule (a
   commonly cited baseline in 2026 guidance is 90 days for anything that can't be made fully
   short-lived), with immediate rotation on suspected compromise or personnel change. Where
   possible, replace rotation with statelessness: short-lived tokens that expire in minutes to hours
   make "rotation" a non-event because there's nothing long-lived to rotate.
4. **Retirement/decommissioning.** This is the stage most fleets get wrong, and it's OWASP's
   #1-ranked NHI risk for a reason. When an agent is retired, migrated, or replaced, its credentials
   must be actively revoked — not just left to expire on their own schedule, and not merely "hoped"
   to time out. An orphaned but valid credential from a decommissioned agent is a textbook
   lateral-movement path.
5. **Forking/cloning (the special case).** This deserves explicit handling because it's a known,
   documented failure mode outside the AI-agent world and an easy trap inside it: cloning a VM,
   container image, or agent runtime snapshot that has an unlocked credential store or decrypted
   secrets baked in duplicates that entire credential store onto every clone. Classic virtualization
   guidance is blunt about this — golden Windows AMIs built without running Sysprep leave secrets
   and machine identity embedded in every instance spun up from them; VMware Horizon "instant clone"
   gold-image workflows have documented the same problem with domain-join credentials, producing
   duplicate computer accounts and "authentication chaos" when a gold image is cloned without first
   stripping domain secrets. AWS's own prescriptive guidance for building golden images explicitly
   calls out removing embedded secrets and instead granting runtime access via an **instance
   profile** (identity-based, assumed at boot) rather than a baked-in access key, precisely so a
   clone gets a fresh, scoped identity instead of a duplicated static one. The AI-agent equivalent —
   snapshotting or migrating a running agent instance and having its full unlocked secret store come
   along for the ride, live on two hosts at once — is the same category of mistake with a faster
   blast radius, because agents run continuously and act autonomously rather than waiting for a
   human to notice the duplicate.

The practical rule that follows: **credentials should never be part of what gets cloned.** An agent
instance's identity should be bound to attested runtime facts (which host, which attestation token,
which registration record) that a clone cannot simply inherit — so a duplicated instance either
fails to authenticate until it's explicitly re-provisioned, or (better) is denied by design because
the SPIRE/IAM/federation layer issues a fresh identity per attested workload rather than trusting
whatever secret happens to be sitting on disk.

## Delegated and Custodial Access: Agents Acting on Behalf of Humans

The hardest governance problem in this space is not agent-to-service auth — it's an agent acting
*as* a human, with that human's mailbox, calendar, or accounts. Three mechanisms dominate in
2025-2026:

- **OAuth 2.0 Token Exchange (RFC 8693).** This is the base primitive for on-behalf-of (OBO) flows:
  a service presents an existing token and exchanges it for a new one scoped to a different
  audience, carrying delegation semantics via an `act` claim ("principal A is acting on behalf of
  principal B"). The chain human → agent A → service B is representable and `act` claims can nest to
  represent longer chains. The catch, acknowledged in the spec itself: those prior-actor claims are
  **informational, not cryptographically verifiable as a chain** — RFC 8693 delegation is
  point-to-point (each hop mints a new token), so a genuinely multi-hop
  agent-calls-agent-calls-agent scenario doesn't get you a single artifact you can verify
  end-to-end. This has motivated 2026-era proposals for append-only delegation chains carried in one
  token rather than reconstructed from a sequence of exchanges.
- **Google Workspace Domain-Wide Delegation (DWD).** DWD lets an admin authorize a service account's
  client ID to impersonate *any* user in the domain for specific OAuth scopes, without per-user
  consent — which is exactly the shape of custodial access an agent needs to read a human's email or
  calendar, and exactly the shape that turns one compromised or over-scoped service-account key into
  domain-wide account takeover. The "DeleFriend" vulnerability (disclosed by Hunters, later covered
  by Palo Alto Unit 42) demonstrated attackers could alter DWD authorizations without holding
  Workspace Super Admin, and Google's own best-practice guidance is unusually direct: request the
  minimum scope, avoid administrative scopes, periodically audit which client IDs actually have DWD
  grants, and **delete delegation entries the moment a purpose (e.g., a migration tool) is
  complete** rather than leaving them provisioned "just in case" — advice that maps precisely onto
  why leftover custodial grants from decommissioned tools are a recurring source of audit findings.
- **Microsoft Entra Agent ID.** Announced in preview at Microsoft Build in May 2025 and expanded to
  public preview at Ignite in November 2025, Entra Agent ID gives AI agents first-class identity
  objects inside Entra — the same Zero Trust machinery (Conditional Access, real-time risk
  detection, lifecycle management) applied to human and workload identities now applies to agents,
  using standard protocols (OAuth 2.0, MCP, A2A). Its **Agent Registry** is the notable governance
  primitive: an extensible metadata repository giving a unified inventory view of every agent
  deployed across an org — directly answering the "how many agents do we even have, and who owns
  each one" question that most fleets currently cannot answer.

The auditing implication for custodial access to a human's personal accounts: least-privilege
scoping is necessary but not sufficient. You also need (a) a registry entry that names the human
being acted for, the purpose, and an expiry, (b) periodic review of which delegations are still
needed (Google's own guidance explicitly calls for this), and (c) logs that distinguish "the agent
acting as the human" from "the human acting directly" — otherwise a compromised or misbehaving
agent's actions are indistinguishable from the human's own, which defeats incident response before
it starts.

## Inventory, Attribution, and Audit as the Governance Baseline

Every framework surveyed converges on the same starting point: **you cannot govern what you haven't
inventoried.** Before rotation policies or scoping rules matter, an organization needs a live answer
to "what machine identities and credentials exist, what do they access, and who owns each one." Some
grounding points:

- GitGuardian's 2026 report frames NHI sprawl as *the* primary infrastructure security risk for the
  year, not a subcategory of it — driven by the finding that ~28% of leaked-secret incidents
  originate outside code entirely (collaboration tools, chat, documents) where automations and
  agents also read credentials, and that 46% of critical secrets get missed when prioritization
  relies on validity-checking alone rather than exposure context.
- Ownership as first-class metadata is the recurring fix proposed across NHI vendors (Entro, Oasis,
  IBM's NHI guidance): mandatory owner/purpose/environment/TTL fields at credential creation, stored
  as tags rather than folded into the secret value, so a credential's provenance survives personnel
  turnover. The stated failure mode is blunt — "a service credential without an owner still slows
  every remediation step that follows," because nobody can authoritatively say whether it's safe to
  revoke.
- Rediscovery and enrichment tooling (Entro claims to analyze 1000+ NHI types; Astrix/Oasis offer
  similar discovery-plus-posture products) exists specifically because credential debt accumulates
  faster than manual tracking can keep up — this is the product category built for exactly the
  "we're not sure who owns this key anymore" state that most fleets drift into.
- Validity-testing alone isn't remediation: GitGuardian found that credentials leaked back in 2022
  still had a 64%+ validity rate when retested in January 2026 — meaning discovery without a forcing
  function to actually revoke stale-but-valid secrets just produces a very well-documented pile of
  live risk.

The practical governance loop is: **discover → attribute an owner → assess whether access is still
needed → rotate or revoke → re-verify** on a recurring cadence, not a one-time cleanup project.

## Emerging Standards for Agent Identity (2025-2026)

The standards landscape is moving fast and is only partially settled as of mid-2026:

- **OWASP NHI Top 10** (January 2025) — covered above; the closest thing to a settled risk taxonomy
  for this space.
- **IETF drafts (early 2026).** Four Internet-Drafts specifically targeting agent identity have
  emerged: **AIMS**, which proposes composing WIMSE, SPIFFE, and OAuth together rather than
  inventing a new stack; **WIMSE** (Workload Identity in Multi-System Environments), which
  introduces a "Dual-Identity Credential" concept; an **Agentic JWT** extension carrying
  agent-specific claims (distinguishing the agent's own identity from the principal it acts for);
  and a **SCIM for agents** proposal addressing provisioning/lifecycle (the same problem SCIM
  already solves for human user provisioning, extended to agent identities). These are early-stage
  drafts, not ratified standards — worth tracking, not yet safe to build a production architecture
  around exclusively.
- **MCP Authorization spec.** The Model Context Protocol's authorization model has moved toward
  standard OAuth 2.1: an MCP server acts as an OAuth 2.1 resource server, an MCP client as an OAuth
  2.1 client, and clients must implement **RFC 8707 Resource Indicators** (a `resource` parameter
  identifying the target MCP server) in both authorization and token requests. A large MCP spec
  revision — described as the biggest since the protocol's launch, aligning authorization more
  closely with mainstream OAuth/OIDC deployments — was in release-candidate form as of late July
  2026, with client registration favoring OAuth Client ID Metadata Documents over the
  now-deprecated-for-this-purpose Dynamic Client Registration (RFC 7591). GitGuardian separately
  found 24,008 unique secrets exposed specifically in MCP configuration files in its 2026 dataset —
  a reminder that a protocol-level auth model doesn't prevent credential leakage if implementers
  still hardcode tokens into MCP config files.
- **RFC 8693 (OAuth 2.0 Token Exchange)** — the delegation primitive underlying most current
  on-behalf-of designs; see the discussion above for its multi-hop limitation.
- **AWS Agentic AI Security Scoping Matrix** (November 21, 2025) — not an identity standard per se,
  but a widely cited governance framework that scopes agentic systems into four levels of agency (no
  agency → prescribed → supervised → full agency) across six security dimensions including Identity
  Context, giving teams a shared vocabulary for "how much autonomy does this agent have, and what
  identity controls does that autonomy level require."
- **Cloud Security Alliance.** CSA published the **Digital Identity Recognition Framework (DIRF)**
  for agentic AI systems in August 2025, and expanded its agentic AI governance work considerably
  through early-to-mid 2026 — including an **Agentic Trust Framework** (a maturity model explicitly
  aligned with AWS's Scoping Matrix), a STAR-for-AI catastrophic-risk annex, and CVE Numbering
  Authority status via MITRE. CSA's own February 2026 survey data (78% of organizations lack any
  AI-identity creation policy; only 23% have a formal strategy) is a useful benchmark for where the
  field actually stands versus where the standards aspire to take it.
- **Vendor and platform moves as de facto standards.** Microsoft's Entra Agent ID, Anthropic's
  Workload Identity Federation for the Claude API, and 1Password's Unified Access (launched March
  20, 2026, partnering with Anthropic, OpenAI, GitHub, Cursor, and Vercel to manage credentials for
  AI agents alongside humans with least-privilege controls and audit trails) are shipping products,
  not proposals — worth distinguishing from the still-draft IETF work above.

## Common Failure Patterns in Agent Fleets (and Why They Recur)

Across the vendor writeups, breach reports, and standards documents surveyed, the same handful of
failure patterns show up repeatedly in fleets of persistent, autonomous agents — regardless of
industry or scale. None of these are exotic; they're the predictable result of moving fast with
identity as an afterthought:

- **The shared-bot-identity pattern.** Multiple agent instances authenticate as one machine identity
  (one GitHub account, one API key, one service login) because provisioning individual identities
  felt like unnecessary overhead early on. This is OWASP's NHI9 (reuse) in its purest form. The cost
  is invisible until an incident: logs show "the bot did X," not "instance #12 did X," and revoking
  the credential to contain a problem takes every instance offline at once instead of just the
  compromised one.
- **The snapshot/migration duplication pattern.** A machine hosting an agent (or its full runtime
  state, including an unlocked credential store or decrypted secrets) is cloned, snapshotted, or
  migrated as part of routine infrastructure work — and the clone or migration target ends up as a
  second live instance holding a full copy of credentials that were only ever meant to back one.
  This mirrors the well-documented golden-image failure mode from traditional virtualization
  (embedded domain-join secrets surviving into every clone), except a duplicated *agent* can start
  acting autonomously on both copies immediately, rather than sitting inert until someone provisions
  it.
- **The orphaned-legacy-token pattern.** A component, integration, or tool is uninstalled or
  replaced, but the credentials it used (API keys, OAuth grants, service account keys) are never
  revoked because nobody owns the decommissioning step. This is OWASP's #1-ranked risk (improper
  offboarding) and the single most commonly cited NHI failure across every source reviewed for this
  article — dormant-but-valid credentials sitting unmonitored, waiting to be found by an attacker or
  simply never noticed again by anyone on the team.
- **The unclear-ownership pattern.** A credential or agent identity exists, still works, and nobody
  currently on the team can say with confidence who created it, why, or whether it's safe to revoke.
  This is less a discrete incident than a standing tax on every future remediation: as vendor
  guidance puts it, a credential without a named owner "slows every remediation step that follows,"
  because revoking it requires someone to first prove a negative (that nothing still depends on it).
- **The custodial-creep pattern.** An agent is granted standing access to a human's personal
  accounts (email, calendar, files) for a specific task, and the grant outlives the task — because
  nobody set an expiry or built in a review point. Google's own domain-wide delegation guidance
  calls this out directly, recommending deletion of delegation entries "the moment a purpose is
  complete" specifically because this pattern is so common in practice.

None of these patterns require malicious action to occur — they are the default outcome of treating
identity provisioning as a one-time setup cost rather than a lifecycle with an equally important
teardown step. That asymmetry (easy to create, no forcing function to retire) is the single biggest
structural reason credential debt accumulates in agent fleets faster than in traditional IT estates,
where change management processes at least nominally require sign-off before infrastructure changes
ship.

## Implications for Agent Fleet Operators

Translating the above into a concrete operating checklist for anyone running a fleet of persistent,
autonomous agent instances:

- **Credential-per-agent, not credential-per-fleet.** Every agent instance should have its own
  identity — its own GitHub App installation or bot identity, its own scoped IAM role, its own SVID
  or federated token — never a shared login used by "the bots" collectively. If two instances
  currently share one GitHub identity, that's an NHI9 (reuse) finding: split it before it becomes an
  incident where you can't tell which instance did what.
- **Inventory first, controls second.** Build (or buy) a live inventory of every credential in the
  fleet — provider keys, GitHub tokens, cloud IAM roles, OAuth grants, custodial delegations to
  human accounts — with owner, purpose, environment, and expiry as mandatory fields, before
  investing further in rotation tooling. A rotation policy for credentials you haven't inventoried
  just rotates some of your risk and leaves the rest.
- **Fork/migrate-aware secret hygiene.** Treat any machine migration, snapshot, or instance
  duplication as a credential event, not just an infrastructure event. Before cloning or migrating a
  running agent, strip or re-mint anything in its credential store — the same discipline
  golden-image practice already requires (no baked-in domain secrets, runtime-injected credentials
  via instance profile/Secrets Manager instead of embedded keys). If a migration duplicates a live
  credential store onto two hosts, treat both instances' credentials as compromised-by-definition
  until re-provisioned, not merely "duplicated but probably fine."
- **Prefer short-lived and federated over long-lived and static.** Wherever a provider offers
  workload identity federation (Anthropic's Claude API, AWS/GCP/Azure IAM, SPIFFE/SPIRE), use it
  instead of a static key — it collapses rotation into a non-event and makes revocation immediate
  rather than "wait for the next scheduled rotation."
- **Custodial access needs its own registry entry.** Any agent with standing access to a human's
  personal accounts (email, calendar, documents) should have that grant explicitly recorded — who it
  acts for, what scopes, why, and an expiry/review date — mirroring Google's own DWD guidance to
  delete delegation entries the moment their purpose is served, not leave them live "just in case."
  Periodically ask, for every custodial grant: is this still needed, and would we notice if it were
  misused?
- **Write a retirement checklist and actually run it.** When an agent instance, component, or
  integration is decommissioned: (1) revoke its credentials at the provider (don't just stop calling
  it), (2) remove it from any registry/inventory as "active," (3) confirm no other instance was
  sharing that credential (if one was, it now needs its own), (4) check for custodial delegations
  tied to that instance and revoke them explicitly, (5) log the decommission so a future audit
  doesn't rediscover it as an unexplained orphaned credential. This directly targets OWASP's
  #1-ranked NHI risk — improper offboarding.
- **Make ownership a required field, not an afterthought.** Every credential and every agent
  identity should have a named owner at creation time. "Nobody knows who owns this key" should be a
  state that triggers an immediate review, not a permanent condition a fleet quietly operates in.
- **Reassess ratio-of-autonomy to ratio-of-governance.** Use something like AWS's Scoping Matrix to
  be explicit about how much agency each agent actually has, and make sure its identity controls
  (scope breadth, credential lifetime, custodial reach) are proportionate — a Scope 4 (full agency)
  agent holding Scope 1-grade static, broad, unreviewed credentials is the mismatch that produces
  the worst incidents.

## Sources

- [OWASP Non-Human Identities Top 10 (2025)](https://owasp.org/www-project-non-human-identities-top-10/2025/top-10-2025/)
- [OWASP NHI Top 10 — CSA introduction](https://cloudsecurityalliance.org/blog/2025/06/30/introducing-the-owasp-nhi-top-10-standardizing-non-human-identity-security)
- [GitGuardian — The State of Secrets Sprawl 2026](https://www.gitguardian.com/state-of-secrets-sprawl-report-2026)
- [GitGuardian — 2026 report summary, AI-service leaks surge 81%](https://blog.gitguardian.com/the-state-of-secrets-sprawl-2026/)
- [Help Net Security — 29 million leaked secrets in 2025, AI agent credentials out of control](https://www.helpnetsecurity.com/2026/04/14/gitguardian-ai-agents-credentials-leak/)
- [Cisco Blogs — Announces intent to acquire Astrix Security](https://blogs.cisco.com/news/cisco-announces-intent-to-acquire-astrix-security)
- [SecurityWeek — Cisco moves to acquire Astrix Security](https://www.securityweek.com/cisco-moves-to-acquire-astrix-security-to-tackle-non-human-identity-risks/)
- [Snowflake — Announces intent to acquire Natoma](https://www.snowflake.com/en/news/press-releases/snowflake-announces-intent-to-acquire-natoma-providing-secure-connectivity-for-the-agentic-enterprise/)
- [Astrix Security — Identity Security for AI Agents & NHIs](https://astrix.security/)
- [Oasis Security — Non-Human Identity Management Platform](https://www.oasis.security/)
- [Oasis Security — Non-Human Identity Management Guide](https://www.oasis.security/blog/non-human-identity-management)
- [Entro Security — Non-human identities discovery and inventory](https://entro.security/blog/non-human-identities-discovery-and-inventory/)
- [Aembit — Everyone wants SPIFFE, almost no one can afford to build it right](https://aembit.io/blog/everyone-wants-spiffe-almost-no-one-can-afford-to-build-it-right/)
- [Aembit — AI Agent Identity: The Multi-Protocol Authentication Gap](https://aembit.io/blog/ai-agent-identity-security/)
- [Stacklok — Agentic identity explained: SPIFFE and relationship-based auth for AI agents in 2026](https://stacklok.com/blog/agentic-identity-explained-how-to-apply-spiffe-and-relationship-based-authorization-to-ai-agents-in-2026/)
- [SPIFFE — SPIRE Concepts](https://spiffe.io/docs/latest/spire-about/spire-concepts/)
- [GitHub Blog — Introducing fine-grained personal access tokens](https://github.blog/security/application-security/introducing-fine-grained-personal-access-tokens-for-github/)
- [GitHub Docs — Setting a PAT policy for your organization](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization)
- [RFC 8693 — OAuth 2.0 Token Exchange](https://datatracker.ietf.org/doc/html/rfc8693)
- [WorkOS — AI agents and the multi-hop delegation problem](https://workos.com/blog/oauth-multi-hop-delegation-ai-agents)
- [Microsoft Learn — What is Microsoft Entra Agent ID?](https://learn.microsoft.com/en-us/entra/agent-id/what-is-microsoft-entra-agent-id)
- [Microsoft Tech Community — Announcing Microsoft Entra Agent ID](https://techcommunity.microsoft.com/blog/microsoft-entra-blog/announcing-microsoft-entra-agent-id-secure-and-manage-your-ai-agents/3827392)
- [Microsoft Learn — Entra Ignite 2025 key announcements](https://learn.microsoft.com/en-us/entra/fundamentals/whats-new-ignite-2025)
- [Hunters Security — DeleFriend: design flaw in Domain-Wide Delegation](https://www.hunters.security/en/blog/delefriend-a-newly-discovered-design-flaw-in-domain-wide-delegation-could-leave-google-workspace-vulnerable-for-takeover)
- [Palo Alto Unit 42 — Critical risk in Google Workspace's Domain-Wide Delegation](https://unit42.paloaltonetworks.com/critical-risk-in-google-workspace-delegation-feature/)
- [Google Workspace Admin Help — Domain-wide delegation best practices](https://knowledge.workspace.google.com/admin/apps/domain-wide-delegation-best-practices)
- [AWS Security Blog — The Agentic AI Security Scoping Matrix](https://aws.amazon.com/blogs/security/the-agentic-ai-security-scoping-matrix-a-framework-for-securing-autonomous-ai-systems/)
- [Cloud Security Alliance — Enhancing the Agentic AI Security Scoping Matrix](https://cloudsecurityalliance.org/blog/2025/12/16/enhancing-the-agentic-ai-security-scoping-matrix-a-multi-dimensional-approach)
- [Cloud Security Alliance — The Agentic Trust Framework: Zero Trust governance for AI agents](https://cloudsecurityalliance.org/blog/2026/02/02/the-agentic-trust-framework-zero-trust-governance-for-ai-agents)
- [THE Journal — Cloud Security Alliance expands agentic AI governance work](https://thejournal.com/articles/2026/05/06/cloud-security-alliance-expands-agentic-ai-governance-work.aspx)
- [Model Context Protocol — Authorization specification (draft)](https://modelcontextprotocol.io/specification/draft/basic/authorization)
- [Model Context Protocol Blog — The 2026-07-28 MCP Specification Release Candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
- [dasroot.net — The New MCP Authorization Specification](https://dasroot.net/posts/2026/04/mcp-authorization-specification-oauth-2-1-resource-indicators/)
- [DEV Community — Entra Agent ID and Anthropic's Workload Identity Federation](https://dev.to/astaykov/your-ai-agent-doesnt-need-an-api-key-entra-agent-id-and-anthropics-workload-identity-federation-el0)
- [1Password — Introducing 1Password Unified Access](https://1password.com/blog/introducing-1password-unified-access)
- [1Password — Credential management for AI agents](https://1password.com/blog/credential-management-for-ai-agents)
- [IBM — The Practitioner's Guide to Non-Human Identities](https://www.ibm.com/think/insights/non-human-identity-guide)
- [AWS Prescriptive Guidance — Golden image procedure](https://docs.aws.amazon.com/prescriptive-guidance/latest/iot-greengrass-golden-images/procedure.html)

## Notes on Unverified or Fast-Moving Claims

A few figures in this article could not be independently confirmed against a primary source and
should be treated as reported-but-unconfirmed:

- The **Cisco–Astrix deal value** (reported between $250M–$400M across outlets) is based on press reporting; neither company had confirmed exact deal terms in the sources reviewed.
- The **MCP 2026-07-28 specification** was described as a release candidate as of the search date (July 2026) — its "largest revision since launch" framing and final publication date should be treated as pending until the spec is finalized.
- The specific **IETF draft names (AIMS, WIMSE Dual-Identity Credential, Agentic JWT, SCIM for agents)** came from secondary summaries of early-2026 Internet-Drafts rather than a direct read of the draft text; treat the framing of what each draft "proposes" as a paraphrase of search-result summaries, not a verified reading of the drafts themselves.
- **IDC's "1.3 billion AI agents by 2028"** and the **45:1 / 100:1 machine-to-human identity ratio** are widely cited across vendor content in the sources reviewed but trace back to vendor/analyst marketing materials rather than a single verifiable primary report.
