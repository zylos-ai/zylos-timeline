---
date: "2026-07-29"
title: "MCP 2026-07-28 Spec Overhaul: Stateless Core, OAuth/OIDC, Tasks, and Apps"
description: "The Model Context Protocol's biggest rewrite since launch drops protocol-level sessions, hardens OAuth/OIDC, and ships Tasks and Apps as official extensions — with Claude adopting it on day one."
tags:
  - research
  - mcp
  - agent-protocols
  - oauth
  - claude
---

## Executive Summary

On July 28, 2026, the Model Context Protocol (MCP) steering group published the **2026-07-28 specification**, described by its own maintainers as the "most substantial changes... since adding authorization." The headline change is that **MCP is now stateless at the protocol layer**: the `initialize`/`initialized` handshake and the `Mcp-Session-Id` header are gone, replaced by self-contained, per-request messages that any server instance behind a plain round-robin load balancer can handle. Alongside this rewrite, the spec **hardens OAuth 2.1/OIDC authorization** (closing an authorization-server "mix-up" vulnerability class and fixing a long-standing Dynamic Client Registration bug that broke desktop/CLI clients), and promotes two capabilities — **Tasks** (durable, pollable long-running operations) and **Apps** (sandboxed, server-rendered interactive UI) — from experimental/ad-hoc status to official, versioned **extensions**.

The release followed a ten-week release-candidate validation window (RC published May 21, 2026) led by MCP lead maintainers David Soria Parra and Den Delimarsky, with Tier 1 SDKs (TypeScript, Python, Go, C#, plus a beta Rust SDK) shipping support on day one. Anthropic simultaneously rolled out client-side support across Claude products — Claude.ai, the Claude Developer Platform, and Claude Code — including enterprise-managed auth via Entra/Okta, connector observability dashboards, and a research-preview "MCP tunnels" feature for reaching private-network servers. By the announcement, MCP had reportedly reached roughly 400M monthly SDK downloads (4x growth this year) and 950+ connectors in Claude's directory, with other reporting citing over 10,000 public MCP servers across the ecosystem.

The spec is explicitly **breaking** for anything built around protocol-level sessions or the old synchronous long-running-task pattern, but ships a formal deprecation policy: Roots, Sampling, Logging, and the legacy HTTP+SSE transport are deprecated with a **minimum 12-month runway** before removal, and Dynamic Client Registration is deprecated in favor of Client ID Metadata Documents (CIMD) while remaining functional. Community reaction, notably on Hacker News, was largely favorable — the stateless redesign directly answers years of complaints that MCP's stateful design fought load balancers and complicated horizontal scaling — while security researchers (Akamai, SecurityWeek, Backslash) flagged that several protocol-level guarantees have now shifted into "implementation responsibility," creating new categories of risk around predictable task/state identifiers, header-based secret leakage, task-based denial-of-service, and UI-extension cross-site scripting.

## 1. What Changed vs. the Previous Version

MCP's spec has evolved through a handful of dated releases, each identified by an ISO date rather than a semantic version number:

| Version | Date | Headline additions |
|---|---|---|
| Initial | 2024-11-05 | Client-server architecture, JSON-RPC 2.0, tools/resources/prompts, stdio and HTTP+SSE transports |
| — | 2025-03-26 | OAuth 2.1 authorization framework; Streamable HTTP transport with session management (`Mcp-Session-Id`); tool annotations, audio content, JSON-RPC batching |
| — | 2025-06-18 | Structured tool output; elicitation (server-initiated requests for user input); servers classified as OAuth Resource Servers; RFC 8707 Resource Indicators required; batching removed; `MCP-Protocol-Version` header mandatory |
| — | 2025-11-25 | OpenID Connect Discovery 1.0; icon metadata; standards-based elicitation enums; tool calling in sampling; OAuth Client ID Metadata Documents recommended; JSON Schema 2020-12 as default dialect |
| **Current** | **2026-07-28** | **Stateless core; no handshake/sessions; Multi Round-Trip Requests; header-based routing; cacheable list results; formal extensions framework (Tasks, Apps); OAuth/OIDC hardening; formal deprecation policy** |

Six Specification Enhancement Proposals (SEPs) underpin the 2026-07-28 release. Together they touch nearly every layer of the protocol:

- **Stateless protocol core** — sessions and the `initialize` handshake removed from the base protocol.
- **`server/discover` RPC** — replaces the handshake for capability/version negotiation; every request now carries protocol version, client identity, and capabilities in a `_meta` field instead of relying on a prior negotiated session.
- **Multi Round-Trip Requests (MRTR)** — replaces server-initiated, connection-holding requests (`elicitation/create`, `sampling/createMessage`, `roots/list`) with a `resultType: "input_required"` response pattern that clients resolve by retrying the original call with `inputResponses`.
- **Header-based routing** — Streamable HTTP requests must carry `Mcp-Method` and `Mcp-Name` headers so gateways/WAFs can route and meter traffic without parsing JSON bodies.
- **Cacheable list results** — `tools/list`, `prompts/list`, `resources/list`, and `resources/read` responses gain `ttlMs` (freshness hint) and `cacheScope` (public/private) fields, letting clients cache aggressively instead of re-polling.
- **Extensions framework + OAuth/OIDC hardening** — extensions get reverse-DNS identifiers and independent versioning; authorization is aligned with RFC 9207 and OIDC `application_type` semantics (detailed below).

Two capabilities that previously lived as experiments or community conventions — **Tasks** and **MCP Apps** — are formalized as the first official extensions under this new framework, each independently versioned and strictly opt-in (negotiated per client/server pair, not part of the mandatory core).

## 2. The Stateless Core Restructuring

### What was stateful before

Since the 2025-03-26 spec, MCP's Streamable HTTP transport worked much like a conventional stateful web session: a client opened a connection with an `initialize` request, the server replied with an `initialized` acknowledgment and issued an `Mcp-Session-Id`, and every subsequent request in that logical conversation had to carry that session ID. Because tool state, list results, and in-flight long-running operations were implicitly scoped to that session, production deployments needed:

- **Sticky sessions** at the load balancer, pinning a client to one backend instance for the life of the session.
- A **shared session store** (Redis or similar) if any horizontal scaling was needed, so a request landing on a different instance could still find the session state.
- **Deep packet inspection** at gateways, since routing and metering required parsing JSON-RPC bodies to figure out what a request was actually doing.

This is precisely the pattern that generated years of developer complaints, particularly from operators running MCP at scale. A representative Hacker News comment from an MCP gateway/registry operator (Glama) put it bluntly: "I cannot tell you what portion of our issues/bugs were due to the need to persist server state."

### What changed and why

The 2026-07-28 spec eliminates the handshake and the `Mcp-Session-Id` header entirely. Every request is now self-contained: protocol version, client identity, and capabilities travel in a `_meta` field on each call, and a new optional `server/discover` RPC handles capability negotiation without establishing persistent state. The MCP blog's framing is explicit about the motivation: a remote server that previously needed sticky sessions, a shared session store, and deep packet inspection can now run "behind a plain round-robin load balancer," routing on the new `Mcp-Method` header alone.

Where servers genuinely need cross-call state — a multi-step workflow, a shopping cart, an in-progress upload — the spec doesn't pretend state disappears. Instead, it makes it **explicit rather than implicit**: servers mint an opaque, server-issued handle from a tool call, and that handle is passed back and forth as an ordinary tool argument in subsequent calls, rather than being invisibly carried by transport-layer session plumbing. This is the same design principle behind the Tasks extension.

One casualty of the change: the old `tasks/list` endpoint is removed outright, since there is no longer a session to scope a "list of my tasks" query to.

## 3. OAuth/OIDC Strengthening

MCP's authorization model has been iterating steadily (OAuth 2.1 in 2025-03-26, Resource Indicators in 2025-06-18, OIDC Discovery in 2025-11-25), but 2026-07-28 is characterized by maintainers as the biggest authorization-adjacent change since auth was first added. It closes two concrete gaps:

- **Authorization-server mix-up attacks.** Clients must now validate the `iss` (issuer) parameter per **RFC 9207** before redeeming an authorization code. The MCP blog describes this as "a low-cost mitigation for a class of mix-up attack that is more prevalent in MCP's single-client, many-server deployment pattern" — i.e., a pattern where one client application juggles OAuth flows against many different MCP servers/authorization servers is structurally more exposed to code-redemption-at-the-wrong-server attacks than typical single-tenant OAuth deployments.
- **Dynamic Client Registration (DCR) redirect URI failures.** Clients now declare their OpenID Connect `application_type` (e.g., `native` vs `web`) during DCR. Previously, authorization servers commonly defaulted unspecified clients to `"web"` and then rejected the `localhost` redirect URIs that desktop and CLI MCP clients depend on — a real, recurring interoperability bug for anything that wasn't a browser-based app.
- **Credential binding.** OAuth client credentials are now explicitly bound to the authorization server that issued them, preventing cross-server credential reuse.
- **DCR deprecation.** DCR itself is formally deprecated in favor of **Client ID Metadata Documents (CIMD)** as the preferred registration mechanism, though DCR continues to function for backward compatibility.

Collectively, these changes are aimed at letting MCP servers plug into production enterprise identity systems — Microsoft Entra ID, Okta, and similar — "without workarounds," per both the MCP blog and Anthropic's own announcement. Anthropic's Claude-side rollout leans on exactly this: enterprise-managed auth that lets admins provision MCP connectors organization-wide through their existing identity provider, rather than per-user OAuth consent flows.

Security commentary (SecurityWeek, citing Akamai analysis) frames this as a double-edged improvement: closing known OAuth gaps is unambiguously good, but the broader stateless redesign simultaneously pushes several security guarantees that used to be implicit in protocol-level session handling down into the implementation layer — see Section 8.

## 4. The Tasks Extension

Tasks moves from an experimental, session-coupled feature to the first official extension (`io.modelcontextprotocol/tasks`) under the new extensions framework, redesigned from the ground up to fit the stateless model.

**Old pattern:** a long-running operation was tied to a blocking or session-scoped call — clients would effectively wait on a synchronous `tasks/result`-style call or rely on a persistent connection and session state to track progress.

**New pattern:** a `tools/call` can return a **durable, opaque task handle** instead of (or in addition to) a final result. The server decides which calls become async tasks — clients don't control this decision. From there, the client drives the task lifecycle explicitly and statelessly:

- `tasks/get` — poll-based status/result retrieval.
- `tasks/update` — update a task (e.g., supply follow-up input mid-flight).
- `tasks/cancel` — cancel an in-progress task.
- `subscriptions/listen` — a single opt-in stream for receiving change notifications per task type, for clients that don't want to poll.

Because task handles are explicit, server-issued, and passed as ordinary arguments (the same "make state visible" principle as the core stateless rewrite), a task can be picked up, polled, or cancelled from a completely different server instance than the one that created it — which is the entire point of decoupling long-running work from a sticky session.

This matters directly for **agentic workflows**: many realistic agent tasks (a multi-minute code generation job, a data pipeline run, a document processing job, a human-in-the-loop approval step) don't fit neatly into a single synchronous request/response cycle. Tasks gives agent frameworks and MCP hosts a standard way to say "start this, give me a handle, and I'll check back" — with durability across load-balanced infrastructure, not just within one long-held connection. It's a much closer match to how production job queues and workflow engines already behave, and it removes an entire class of ad hoc, vendor-specific "polling shims" that MCP server authors had previously built themselves.

## 5. The Apps Extension

MCP Apps ships as the second official extension, letting servers declare and render **interactive HTML interfaces** — charts, forms, video players, and other rich UI — directly inline within a conversation, executed inside a sandboxed iframe on the client/host side.

Apps didn't appear from nowhere in this release; it's the product of a convergence effort that had been underway for months. MCP-UI and OpenAI's own Apps SDK had separately pioneered the pattern of returning UI resources alongside tool results. By November 2025, the MCP steering group merged these two design lineages via SEP-1865, which was ratified as the dated specification on 2026-01-26 and now graduates into the formal extensions framework alongside Tasks in 2026-07-28.

The practical distribution implication is significant: a UI-bearing tool built once against the MCP Apps spec can, in principle, render inside ChatGPT (via OpenAI's Apps SDK, which is compatible with the MCP wire format), Claude, and other MCP-Apps-supporting hosts — instead of requiring a bespoke plugin/extension implementation per vendor, the way agentic UI integrations worked as recently as 2024. For MCP server authors and the emerging category of "MCP server marketplaces," this turns UI-bearing servers into more broadly portable distributable artifacts rather than single-platform integrations. On the client/host side, the new cacheable-list-results mechanism (`ttlMs`, `cacheScope` on `tools/list`) pairs naturally with Apps: UI templates can be declared and prefetched upfront, giving hosts a chance to do client-side caching and security review of the UI bundle before it's ever executed.

The tradeoff is a genuinely new attack surface: rendering server-authored HTML/JS inside a host application, even sandboxed, reintroduces browser-style risks — stored cross-site scripting being the most-cited concern by security researchers reacting to the spec (see Section 8).

## 6. Implications for Agent Tool Ecosystems

Anthropic adopted the spec immediately and comprehensively rather than incrementally:

- Client-side support shipped across Claude.ai, the Claude Developer Platform, and Claude Code on announcement day.
- **Interactive tools** (MCP Apps) for inline UI rendering in Claude conversations.
- **Enterprise-managed auth**, letting admins provision MCP connectors org-wide through Entra/Okta-style identity providers rather than per-user consent.
- **Observability dashboards** for connector publishers to track performance and adoption of their published MCP servers.
- **MCP tunnels** (research preview) — a mechanism for Claude to reach MCP servers running on private networks without those servers needing public exposure.

Beyond Anthropic, the broader signal is convergence rather than fragmentation: OpenAI's Agents SDK and Apps SDK build on the MCP wire format, and Cursor and Microsoft have added native MCP support. Where 2024's agentic-app landscape meant separate plugin formats per vendor (a ChatGPT plugin format, a Claude tools API, a Gemini extensions API), the MCP Apps standardization plus broad SDK adoption pushes the integration layer itself toward becoming a shared, boring commodity — with vendors differentiating on governance, audit, connector marketplaces, and operational tooling built on top of the common wire format, rather than on the wire format itself.

The scale numbers cited around the announcement — roughly 400M monthly SDK downloads (reported as 4x growth over the year) and 950+ connectors in Claude's directory, with separate reporting citing more than 10,000 public MCP servers across the whole ecosystem — indicate MCP has moved well past early-adopter status into what one security analysis explicitly called "load-bearing infrastructure," a framing reinforced by NSA/DoD security guidance on MCP published June 2, 2026, ahead of this spec release.

One unresolved critique the stateless rewrite does **not** address: context-window bloat from tool metadata. MCP co-creator David Soria Parra has acknowledged that tool descriptions, parameters, and schemas across dozens of integrated servers can consume a significant fraction of a model's context window before any actual reasoning happens. The 2026-07-28 spec improves transport efficiency and infrastructure scalability, but the "too many tools, too much context" problem remains an open design question for the ecosystem.

## 7. Impact on Existing MCP Server Implementations

The spec is explicitly and deliberately **breaking**, though maintainers built in a 12-month deprecation runway for the features they could afford to soften.

**Breaking now (requires action before adopting 2026-07-28):**

| Old pattern | Required change |
|---|---|
| `initialize`/`initialized` handshake, `Mcp-Session-Id` header | Remove session-based handshake; read protocol version/capabilities from per-request `_meta`; implement `server/discover` |
| Session-scoped caches, workflow progress, per-conversation config | Replace with explicit, server-issued handles passed as ordinary tool arguments |
| Blocking/synchronous long-running calls, `tasks/list` | Migrate to the Tasks extension; poll via `tasks/get`, act via `tasks/update`/`tasks/cancel` |
| Loose/non-compliant tool input schemas | Full JSON Schema 2020-12 compliance now required; validator-quirk-dependent schemas may start failing |
| Unauthenticated or ad hoc auth servers | Align with OAuth 2.1/OIDC; expose RFC 9728 Protected Resource Metadata |

**Deprecated with a minimum 12-month grace period (safe to defer, but should be planned):**

- **Roots** → migrate toward tool parameters or resource URIs.
- **Sampling** → migrate toward direct LLM API calls.
- **Logging** (protocol-level) → migrate toward stderr/OpenTelemetry-based observability.
- **Dynamic Client Registration** → migrate toward Client ID Metadata Documents.
- **Legacy HTTP+SSE transport** → migrate to Streamable HTTP.

Practically, this means any MCP server that leaned on session identifiers for state, or that implemented its own bespoke long-polling/job-tracking pattern for slow tools, needs a genuine refactor — not a config flag. Servers that were already mostly stateless (pure function-call tools with no cross-call memory) are largely unaffected beyond header and schema compliance. All four Tier 1 SDKs (TypeScript, Python, Go, C#) shipped 2026-07-28 support simultaneously with the spec, and a Rust SDK is available in beta, which substantially lowers the migration cost for server authors willing to upgrade their SDK dependency rather than hand-roll the new wire format.

## 8. Security Considerations and Community Reception

**Reception was broadly positive on the architectural question.** The stateless redesign is, in the words of one summary of Hacker News commentary, "almost line for line" the pattern that years of developer complaints had been asking for — sticky sessions and shared session stores were a recurring operational pain point, and an MCP gateway operator (Glama) publicly credited a large share of their historical bug reports to session-state persistence requirements.

**Reception was more cautious on security.** Multiple outlets (SecurityWeek citing Akamai research, Backslash Security) published analyses the same week arguing the new spec trades one class of problem for another: protocol-level guarantees that used to be structurally enforced by sessions are now the implementer's responsibility. Specific new/expanded attack surfaces called out include:

- **Predictable state/task identifiers** — if task handles or state tokens are guessable or insufficiently random, this can enable workflow hijacking, cross-tenant data access, or unauthorized cross-tenant actions (Akamai).
- **Header-based secret leakage** — the new mandatory `Mcp-Method`/`Mcp-Name` routing headers create a temptation to stuff sensitive values (API keys, tokens, PII) into headers, which then get logged by infrastructure (proxies, WAFs, load balancers) that isn't designed with MCP-specific redaction in mind.
- **Task-based denial of service** — "task creation is cheap for the client, but resource hungry for the server," per Akamai's Maxim Zavodchik; an attacker can cheaply spawn many expensive async tasks and disconnect, leaving the server holding the resource cost.
- **MCP Apps stored XSS** — rendering server-authored HTML/JS inline, even sandboxed, reintroduces browser-style stored cross-site-scripting risk that the protocol itself cannot fully mitigate.

Zavodchik's framing captures the general security-community consensus: "Critical security boundaries are now entirely dependent on how developers implement them" — echoing the spec's own long-standing (and now more consequential) position that MCP "cannot enforce these security principles at the protocol level" and that implementors "SHOULD" build robust consent, authorization, and access-control layers on top.

**Adoption timeline:** RC announced May 21, 2026 → ten-week validation period with SDK maintainers and client implementers → final specification published July 28, 2026, with Tier 1 SDKs and Anthropic's Claude-side rollout landing the same day. The NSA/DoD published MCP-specific security guidance on June 2, 2026, during the RC validation window — itself a signal of how far MCP had already moved from developer tool to infrastructure requiring formal government security review before this spec even shipped.

## Sources

- [The 2026-07-28 Specification — Model Context Protocol Blog](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [The 2026-07-28 MCP Specification Release Candidate — Model Context Protocol Blog](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
- [Beta SDKs for the 2026-07-28 MCP Spec Release Candidate Are Here — Model Context Protocol Blog](https://blog.modelcontextprotocol.io/posts/sdk-betas-2026-07-28/)
- [Specification — Model Context Protocol (2026-07-28)](https://modelcontextprotocol.io/specification/2026-07-28)
- [MCP Apps — Bringing UI Capabilities To MCP Clients — Model Context Protocol Blog](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/)
- [MCP 2026-07-28 spec: stateless core, coming to Claude — Claude by Anthropic](https://claude.com/blog/bringing-mcp-2026-07-28-to-claude)
- [Model Context Protocol prepares to break with its stateful past — The Register](https://www.theregister.com/devops/2026/07/23/model-context-protocol-prepares-to-break-with-its-stateful-past/)
- [AI Tool Protocol Drops Sessions Tomorrow: MCP's Largest Spec Change Since Launch — Tech Times](https://www.techtimes.com/articles/321671/20260727/ai-tool-protocol-drops-sessions-tomorrow-mcps-largest-spec-change-since-launch.htm)
- [MCP Goes Stateless July 28: What Breaks, What Gets Cheaper — Digital Applied](https://www.digitalapplied.com/blog/mcp-2026-07-28-spec-stateless-migration-guide)
- [MCP 2026-07-28 spec: what changed, what breaks — Stacktree](https://stacktr.ee/blog/mcp-2026-spec-changes)
- [MCP 2026-07-28: Stateless Spec for AI Agents — BOVO Digital](https://www.bovo-digital.tech/en/blog/mcp-2026-specification-stateless-enterprise-agents)
- [The MCP 2026-07-28 Rewrite: What Breaks and How to Migrate — Developers Digest](https://www.developersdigest.tech/blog/mcp-2026-07-28-breaking-changes)
- [MCP 2026-07-28 Specification: transport going stateless — Hacker News discussion](https://news.ycombinator.com/item?id=49088058)
- [New Enterprise-Ready MCP Specification Brings New Security Challenges — SecurityWeek](https://www.securityweek.com/new-enterprise-ready-mcp-specification-brings-new-security-challenges/)
- [New MCP Spec Opens Three New Attack Surfaces. Security, Get Ready. — Backslash Security](https://www.backslash.security/blog/new-mcp-spec-opens-new-attack-surfaces)
- [MCP Hits 10,000+ Servers as Biggest Update Ships (2026) — Tech Insider Ireland](https://tech-insider.org/ie/model-context-protocol-mcp-update-2026/)
- [MCP 2026-07-28: The Stateless Release Candidate, Explained — MCP.Directory](https://mcp.directory/blog/mcp-2026-07-28-release-candidate)
- [MCP Apps vs OpenAI Apps SDK: AI App Standards 2026 — MCP.Directory](https://mcp.directory/blog/mcp-apps-standard-vs-openai-apps-sdk-2026)
- [Model Context Protocol Specification Version Timeline — hidekazu-konishi.com](https://hidekazu-konishi.com/entry/mcp_specification_version_timeline.html)
- [Model Context Protocol — Wikipedia](https://en.wikipedia.org/wiki/Model_Context_Protocol)
