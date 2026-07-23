---
date: "2026-07-21"
title: "Device Authorization Flow (RFC 8628) for Connecting Headless Agents to Consumer LLM Subscriptions"
description: "Engineering notes from wiring a server-side agent to a human's ChatGPT Pro subscription over RFC 8628 device flow instead of localhost-redirect OAuth — the exact endpoint sequence, a Cloudflare false alarm, a polling-loop failure mode shared with the official Codex CLI, how GitHub/Google/Microsoft/Docker/AWS/Slack each do (or don't do) the same flow, named 2025-2026 device-code phishing campaigns, and why the Model Context Protocol's own spec doesn't standardize on this at all."
tags:
  - research
  - oauth
  - rfc-8628
  - device-authorization-grant
  - ai-agents
  - authentication
  - non-human-identity
  - headless-infrastructure
  - mcp
  - protocol-comparison
---

## Executive Summary

Today we needed a server-side component (Rounds, our delegated voice-daily-report agent) to place
model calls against a human's personal ChatGPT Pro subscription, without touching that human's local
Codex CLI login. The two credential stores are governed by the same OAuth token family on OpenAI's
side, and importing or copying `~/.codex/auth.json` onto a server would put two independent processes
in a race to refresh the same rotating refresh token — whichever refreshed second would invalidate
the other's session. We needed the agent to hold its *own* token family, minted independently, that a
human could revoke from ChatGPT's device-management UI without touching their own CLI session.

That rules out the traditional loopback-redirect OAuth pattern (browser opens, waits for a callback to
`localhost:<port>`) as the primary path for a headless server: there is no local browser to receive
the redirect, and pasting a `localhost` URL back from a remote machine is exactly the kind of manual,
error-prone step that RFC 8628 — the OAuth 2.0 Device Authorization Grant — exists to eliminate. We
implemented the device flow against OpenAI's Codex/ChatGPT OAuth backend directly, hit one false-alarm
Cloudflare block that turned out to be a wrong-path mistake rather than a real bot-block, and found a
transient-network-error bug class in polling loops that we suspect also affects the official Codex
CLI, based on the shape of publicly reported issues. This article documents the concrete endpoint
sequence we used, grounds it in RFC 8628 and its known security tradeoffs (device-code phishing chief
among them), and generalizes the two operational lessons — because they apply to any team building
agent infrastructure that needs delegated access to a human's consumer subscription rather than a
provisioned API key.

## Why This Problem Exists: Agents Don't Have a Browser

Consumer LLM subscriptions (ChatGPT Plus/Pro, Claude Pro/Max) are licensed to a human, authenticated
via OAuth against a *user* identity, and priced against a person's monthly seat — not against an API
key billed by usage. Using that subscription's model access from an autonomous agent is attractive
when the economics or the entitlements (e.g., a Pro-tier reasoning model) are better through the
subscription than through the metered API, but subscriptions are built to be logged into by a human in
a browser, not called from a server process.

That mismatch surfaces as soon as the agent runs somewhere without an interactive display attached to
the OAuth client — a VPS, a container, an SSH session, a CI runner. The standard OAuth 2.0
Authorization Code flow (with PKCE, per current best practice) assumes the client can either receive a
browser redirect directly or spin up a **loopback listener** on `127.0.0.1` and catch the callback
locally. Both assumptions break the moment the process initiating the login and the browser completing
it are on different machines. This is not a hypothetical edge case for agent builders — it is close to
the default topology: the agent runs on infrastructure, the human approving access is wherever they
happen to be.

Three public trails independently confirm this is a live, widely felt gap rather than something
peculiar to our setup:

- OpenAI's own Codex CLI ships **two** sign-in methods for exactly this reason: standard browser OAuth
  with a `localhost` callback for local machines, and a device-code flow (`codex login --device-auth`)
  explicitly documented for "headless/remote environments" where "the browser-based login UI may not
  work."
- Anthropic's Claude Code has an open feature request, [issue #22992 on
  anthropics/claude-code](https://github.com/anthropics/claude-code/issues/22992), titled "Support
  device-code authentication flow (RFC 8628) for Pro/Max subscription users in headless environments"
  — filed precisely because Claude Code's OAuth callback (`localhost:54545` by default) doesn't work
  over SSH, and a related issue (#44028) documents that on macOS the credential store is the Keychain,
  which is flatly inaccessible from an SSH session, leaving Pro/Max subscribers with SSH port-forwarding
  as their only documented workaround.
- Independent open-source tooling exists solely to patch this gap for other CLIs — e.g.
  [`opencode-openai-device-auth`](https://github.com/tumf/opencode-openai-device-auth), a small
  project that bolts OpenAI's device-code flow onto OpenCode specifically to enable "ChatGPT Plus/Pro
  OAuth in headless environments (SSH, Docker, remote servers)" where loopback redirect has no path to
  succeed.

## Loopback/PKCE vs. Device Flow: What Actually Differs

Both flows exist to get an OAuth authorization code into the hands of a public client (one that can't
hold a confidential secret) without a static credential ever touching disk. Where they diverge is in
*who talks to the authorization server's browser-facing endpoint*.

**Loopback redirect with PKCE** (RFC 7636 PKCE + RFC 8252 native-app best practice): the client
generates a random `code_verifier`, derives a `code_challenge` from it, opens the system browser to the
authorization endpoint with that challenge, and binds an ephemeral HTTP listener to
`127.0.0.1:<port>` to catch the redirect. The authorization code exchange only succeeds if the caller
also presents the original `code_verifier`, so an intercepted code alone is useless. This is the flow
behind both the Codex CLI's default `codex login` (callback on `localhost:1455` in practice) and
Claude Code's default login (callback on `localhost:54545`). It is well proven, cryptographically
tight, and completely dependent on the browser and the listener being reachable from the same host.

**Device Authorization Grant** (RFC 8628): the client has no way to receive an inbound redirect at
all — it may not even be able to open a browser. Instead of directing a redirect back to itself, the
client asks the authorization server for a pair of codes: a long, high-entropy `device_code` it keeps
secret, and a short, human-typeable `user_code` it displays. The human takes the `user_code` to a
**verification URL** on *any* device with a browser — a phone, a laptop, whatever's in reach — logs
in there, and approves. Meanwhile the original client polls the token endpoint with the `device_code`
until the server reports success. No inbound network path to the client is required at any point; the
only thing that crosses back to the headless machine is the fully-issued token, over the same
outbound polling connection the client already opened.

For a genuinely headless, remote, or cross-device scenario, device flow is strictly better — it needs
no local browser, no listener, no port to forward, and no "copy this localhost URL and paste it back"
step. WorkOS's practical comparison of the two flows for CLI tooling lands on this same split: PKCE for
"user on their own machine with a browser," device flow for "SSH session / container / cloud IDE,"
mirroring almost exactly the tradeoff we hit.

## The Endpoint Sequence We Observed

Against OpenAI's Codex/ChatGPT OAuth backend, the device flow resolves to four calls. (Endpoint paths
and field names below reflect what we observed live against the production backend; treat exact field
names as implementation detail that can change without notice, since this is not a published public
API contract the way the RFC 8628 abstract flow is.)

1. **Request a user code.**
   `POST {issuer}/api/accounts/deviceauth/usercode` with `{ client_id }`.
   Returns `{ device_auth_id, user_code, interval, expires_at }`. In our run, `expires_at` gave the
   code roughly a 15-minute window — consistent with the 15-minute expiry publicly documented for
   Codex's device-code flow.

2. **Human approves.**
   The human is sent to `{issuer}/codex/device` (the human-facing verification page — publicly
   documented as `https://auth.openai.com/codex/device` for the standard product flow) and enters the
   `user_code` there, on whatever device they have a browser open on. Nothing about this step touches
   the server running the agent.

3. **Poll for approval.**
   `POST {issuer}/api/accounts/deviceauth/token` with `{ device_auth_id, user_code }`, repeated on the
   returned `interval`. While the human hasn't yet approved, this returns 403/404. Once approved, it
   returns a short-lived `authorization_code` plus a PKCE `code_verifier` — the device flow and PKCE
   composing together here rather than being pure alternatives: the device-code exchange itself hands
   back a PKCE-bound authorization code rather than tokens directly.

4. **Exchange for tokens.**
   `POST {issuer}/oauth/token` with `grant_type=authorization_code`, `redirect_uri={issuer}/deviceauth/callback`,
   and the PKCE verifier from step 3. Returns `access_token`, `refresh_token`, `id_token`, and a field
   we're calling `earliest_refresh_at` for lack of a public spec name — a hint field indicating the
   soonest sensible time to refresh, presumably to discourage refresh-storming the token endpoint.

The resulting token family is completely independent from anything already sitting in
`~/.codex/auth.json` on the human's own machine. It has its own `device_auth_id` lineage, its own
refresh token, and — critically for the governance question that motivated the whole exercise — it
shows up as its own entry in ChatGPT's account-level device/session management, so the human can revoke
the agent's access on their own schedule without logging out their own CLI.

This maps directly onto RFC 8628's abstract protocol (Section 3): a Device Authorization Request/Response
pair, a human-interaction step at a `verification_uri`, and a Device Access Token polling loop using
`grant_type=urn:ietf:params:oauth:grant-type:device_code` against the token endpoint. OpenAI's concrete
implementation adds an authorization-code-plus-PKCE hop in between polling and final token issuance
rather than returning tokens straight out of the device-code poll — a reasonable extension, since it
lets the same token endpoint and PKCE verification code path serve both the loopback and device flows.

## The Same Pattern, Different Providers

OpenAI's implementation is not a one-off. RFC 8628 has become the standard answer wherever a CLI or
headless client needs a human to approve access without a reachable browser on the same host, and it's
worth laying the concrete details side by side, because they vary more than the RFC's abstract flow
suggests:

| Provider | Confirmation URL | Code format | Default or fallback |
|---|---|---|---|
| GitHub (`gh auth login`) | `github.com/login/device` | 8 chars, hyphenated (e.g. `WDJB-MJHT`) | Fallback (PAT/browser also offered) |
| Google (`gcloud`, TV/limited-input apps) | `google.com/device` | server-issued short code | Fallback for headless/TV clients |
| Microsoft (`az login --use-device-code`, Graph) | `microsoft.com/devicelogin` | short alphanumeric code | Fallback (browser login is default) |
| GitHub Copilot CLI | opens automatically; code auto-copied to clipboard | one-time code | **Default** for interactive use |
| OpenAI Codex CLI | `auth.openai.com/codex/device` | e.g. `ABCD-EFGHI` | Fallback; must be admin-enabled for Workspace accounts |
| Docker Hub (`docker login`) | `login.docker.com/activate` | hyphenated (e.g. `LNFR-PGCJ`) | **Default** interactive path |
| AWS (`aws sso login`) | IAM Identity Center-issued verification URL | server-issued code | Fallback via `--use-device-code` — CLI 2.22 (May 2026) flipped the *default* to browser + PKCE instead |
| Vercel CLI | Vercel-hosted device page | server-issued code | Adopted as the new default, replacing an older email-link flow |

Two things stand out. First, device flow's status keeps flipping between "the default" and "the
fallback" depending on who's implementing it and when — Docker and GitHub Copilot CLI lead with it,
while AWS just moved the other direction: version 2.22 of the AWS CLI demoted device flow behind an
explicit flag, citing the same phishing exposure covered below, and made browser + PKCE the default
instead. Second, device flow has become common but not universal: Slack's CLI login is a proprietary
in-app challenge-code exchange over a Slack channel rather than an OAuth device grant at all, and
Netlify's and Heroku's CLIs still authenticate via a browser-opened grant page or a stored token rather
than any code-entry step. The pattern this article documents for OpenAI is representative of an
industry norm, not an OpenAI-specific mechanism — but it's a norm every provider is still free to
opt out of, and at least one major one just partially did.

## Lesson 1: A Blocked Endpoint Doesn't Mean the Datacenter Is Bot-Blocked

Our first probe against what we assumed was the device-authorization endpoint came back with a
Cloudflare interstitial: HTTP 403, HTML body starting "Just a moment...", and a `cf-mitigated:
challenge` response header. The natural — and wrong — conclusion to jump to is "our server's IP range
or ASN is getting bot-fingerprinted by Cloudflare, and we need residential IPs, a browser-shaped TLS
fingerprint, or a challenge solver to get through."

The actual cause was much more mundane: we had probed `/deviceauth/usercode`, not the correct
`/api/accounts/deviceauth/usercode`. The moment we hit the right path, a plain server-side HTTP client
— no browser emulation, no residential proxy, no special headers — passed cleanly with no challenge at
all.

The general lesson, worth carrying into any integration work against a provider sitting behind
Cloudflare (which by 2026 is nearly every consumer-facing SaaS): **a single failed probe against a
guessed or slightly-wrong path is not evidence that your infrastructure is being bot-blocked.** Many
providers put aggressive bot mitigation in front of their marketing site and HTML-rendered routes —
exactly the kind of page a browser-shaped crawler would otherwise scrape — while leaving their JSON API
subpaths, meant to be called by their own official CLI or app from arbitrary server infrastructure,
comparatively permissive. Cloudflare's own challenge mechanism is triggered by heuristics tied to the
specific route's configured security level, not a blanket per-IP or per-ASN judgment, so two paths on
the same hostname can produce completely different outcomes for the same caller. Before concluding "the
provider is blocking us" and reaching for IP rotation, browser fingerprint spoofing, or a
challenge-solving service, verify: (1) the exact path, character-for-character, against the vendor's
own CLI or SDK source if you have it, (2) whether the failing path is a marketing/HTML route versus a
`/api/...` JSON route, and (3) whether an unmodified, plain HTTP client hits the same wall on the
*correct* path before assuming anything about the network path itself needs fixing. In our case, steps
1–3 collapsed a problem that looked like it needed proxy infrastructure into a one-character typo.

## Lesson 2: Device-Flow Polling Loops Are Long-Lived — Transient Errors Are Not Optional to Handle

A device-code's lifetime is measured in minutes (15 in this case, per RFC 8628's `expires_in` field and
matching OpenAI's documented 15-minute window), and the client is expected to keep an open polling loop
running the entire time, sleeping `interval` seconds (RFC 8628 defaults this to 5 if the server omits
it) between calls. That is a long time, in networking terms, for a single logical operation to stay
alive uninterrupted — long enough that a naive implementation that treats *any* request failure as
fatal will eventually die to a garden-variety transient blip: a single `ECONNRESET`, a TLS session
getting torn down mid-handshake through a proxy, a load balancer cycling a backend. That is exactly
what happened to our first poller — one dropped connection through a proxy hop killed the whole login
attempt, forcing the human to restart the flow and get a fresh code.

This is not a device-flow-specific quirk; it's the general "long-lived polling loop" problem, and it
shows up anywhere a client holds a connection open across many seconds-to-minutes-scale iterations:
token refresh loops, streaming API reconnects, and — visibly, in public bug trackers — the official
CLIs for both major agent coding tools. OpenAI's Codex CLI has multiple open issues describing
persistent "Reconnecting" loops and stream failures that don't recover cleanly from transient network
loss (e.g. [openai/codex#6191](https://github.com/openai/codex/issues/6191),
[#8703](https://github.com/openai/codex/issues/8703), and a feature request,
[#25308](https://github.com/openai/codex/issues/25308), asking Codex to *pause* retries while the local
network is down rather than burning through a fixed retry budget). Anthropic's Claude Code has the
mirror-image bug reports: ECONNRESET putting an active session into "a completely unrecoverable state"
([anthropics/claude-code#24614](https://github.com/anthropics/claude-code/issues/24614),
[#13657](https://github.com/anthropics/claude-code/issues/13657)). None of these are device-flow
polling loops specifically, but they establish that the underlying failure class — a transient,
mid-operation network error killing a long-lived client loop that should have just retried — is a
demonstrated, recurring defect pattern in exactly this category of tool, which makes it very plausible
that a device-flow poller sharing the same HTTP stack inherits the same fragility. Treat "tolerate a
single dropped connection without aborting the whole login" as mandatory for any device-flow client,
not an edge case to defer: a login that silently dies 8 minutes into a 15-minute window, after the
human has already gone and typed in their code, is a materially worse experience than one that
transparently retries and succeeds a few seconds later. The fix is unglamorous — catch
connection-reset/timeout-class errors in the polling loop distinctly from RFC 8628's own
`authorization_pending`/`slow_down` application-level responses, retry those with a short backoff
instead of surfacing them as `access_denied` or aborting, and reserve actual failure handling for the
codes RFC 8628 defines as terminal (`expired_token`, `access_denied`).

The same discipline applies downstream, after login succeeds: the resulting refresh-token loop is also
long-lived (it runs for the life of the integration, not just 15 minutes), and the current best-practice
pattern — proactive refresh well before expiry (a commonly cited threshold is refreshing once a token
has consumed 70-80% of its lifetime) backed by reactive refresh-on-401 as a fallback — needs the same
transient-vs-terminal error triage. A refresh call that fails on a network blip should retry with
backoff, not immediately treat the token as invalid and force a full re-login.

## Security Considerations: Why This Is Not a Free Lunch

RFC 8628's own Security Considerations section (Section 5) is worth reading directly before shipping a
device-flow integration, because the tradeoffs it documents are exactly the ones that matter for
delegated subscription access:

- **User-code brute-forcing (5.1).** The `user_code` needs "enough entropy that, when combined with
  rate-limiting... brute-force attack becomes infeasible" — the RFC's own worked example is an
  8-character base-20 code, which under reasonable rate-limiting needs only about 5 guesses to hit a
  2^-32 success bound. Short, human-typeable codes are inherently lower-entropy than the `device_code`
  itself, which is why the RFC pairs them with rate-limiting and a short expiry rather than length
  alone.
- **Device-code brute-forcing (5.2).** The `device_code`, which is never shown to a human and therefore
  has no usability constraint, "SHOULD" use very high entropy — asymmetric protection matching the
  asymmetric exposure of the two codes.
- **Remote phishing (5.4) — the single biggest real-world risk with this flow.** This is not
  theoretical: **device-code phishing is an active, growing attack class as of 2025-2026.** The attack
  pattern (documented independently by Microsoft/Securelist, Proofpoint, Huntress, and Push Security)
  is: an attacker initiates a legitimate device-authorization request against a real provider, then
  sends the victim a real verification URL and a real code through a plausible pretext (a fake meeting
  invite, a fake IT prompt). The victim visits the provider's actual login page — no fake domain, no
  spoofed branding, often already logged in and past MFA — types in the attacker's code, and approves
  it, unknowingly handing the attacker a valid token for their own account. Because the phishing page
  the victim visits is the *real* authorization server, this bypasses the usual "check the URL" defense
  that credential phishing training relies on, and Microsoft's own guidance now recommends enterprises
  be able to block the device-authorization grant entirely via Conditional Access where it isn't
  needed. This is precisely why OpenAI requires a Workspace admin to explicitly opt in to device-code
  login for Workspace (business) accounts — device flow is officially treated as "more susceptible to
  social engineering attacks than browser redirects," and gating it behind an admin decision is the
  mitigation. It also explains the standard, blunt warning that ships with every device-code UI:
  **never share your device code with anyone** — the code is the entire attack surface, and unlike a
  password, sharing it feels harmless because it's short, temporary, and looks like a normal
  cross-device sign-in step.

  Named campaigns show this operating at real scale, not as a theoretical footnote. Microsoft Threat
  Intelligence published the pattern under the name **Storm-2372** (Feb 13, 2025) — a moderate-confidence
  Russia-aligned actor active since August 2024, using fake Microsoft Teams meeting invites against
  government, NGO, defense, and energy targets across Europe, North America, Africa, and the Middle
  East, then using Microsoft Graph post-compromise to search mailboxes for terms like "password" and
  "credentials." Volexity independently reported a parallel cluster (**UTA0352/UTA0355**, April 22,
  2025) running the same play against European political officials and Ukrainian diplomats via fake
  private-video-call invites. By March 2026, a Cloud Security Alliance research note put the wave's
  scale at **340+ compromised Microsoft 365 organizations across five countries and over 7 million
  device-code attack attempts in a single four-week window**; a Microsoft follow-up the next month
  described a newer variant using generative AI to hyper-personalize the phishing *lure* itself
  (invoice/RFP-themed messages tailored to the victim's role) — notably, the AI there is crafting the
  bait, not impersonating the account being connected. RFC 8628's Security Considerations section
  named this exact threat class in the abstract back in 2019 (§5.4); the IETF's concrete follow-up has
  been a dedicated successor document, `draft-ietf-oauth-cross-device-security`, which formally splits
  it into Cross-Device Consent Phishing and Cross-Device Session Phishing and catalogs mitigations
  RFC 8628 itself doesn't specify — proximity/co-location checks, one-time/limited-use codes, and
  sender-constrained tokens. As of this writing that draft is still at revision -15, not a published
  RFC, which is a reasonable proxy for how unsettled the "correct" fix still is industry-wide six years
  after the base spec shipped.
- **Session/shoulder-surfing (5.5).** The RFC also flags plain physical observation — someone reading a
  user code off a screen in a public or shared setting — as a risk vector distinct from phishing,
  recommending the display mechanism account for the operating environment.
- **Non-confidential clients (5.6).** Device clients are public clients by construction — they cannot
  keep a client secret confidential — so they should be treated (and scoped) accordingly, the same
  assumption PKCE makes for native apps.

None of this makes device flow unsafe to use; it makes it a flow whose primary residual risk moved from
"can an attacker guess or brute-force a code" (well mitigated by entropy and rate-limiting) to "can an
attacker socially engineer a human into approving *the attacker's* login" (mitigated only by user
awareness and, where available, policy controls that disable the flow for populations that don't need
it). For an autonomous agent's *own* device-flow login — the case this article is about — that
phishing risk is largely inverted in the agent's favor: the agent is the party requesting the code and
displaying it to its owner through a controlled, already-trusted channel (in our case, delegated
straight to the human who owns the subscription, not relayed through an untrusted third party), so the
attack surface that matters in production is "could someone intercept or relay the code the agent
generated," not "did the human get tricked into approving someone else's request." That distinction —
who initiates the request and how the code reaches the approving human — is the actual security
boundary to defend, not the flow itself.

## Why MCP Didn't Standardize on This

Given how load-bearing device flow already is for headless AI tooling, it's worth flagging a
counterintuitive fact: the Model Context Protocol's own authorization specification does not build on
RFC 8628 at all. The current MCP spec (2025-11-25) frames its Authorization flow entirely around OAuth
2.1 Authorization Code plus mandatory PKCE, with a sequence diagram that assumes a browser opens
directly on the authorizing client's own machine; STDIO-transport clients are told to skip OAuth
entirely and read credentials from the environment instead. RFC 8628 is not named anywhere in the core
specification text.

Device Authorization Grant support does exist for MCP, but only as an optional, independently
versioned extension in the `modelcontextprotocol/ext-auth` repository, scoped explicitly to "clients
with limited input capabilities (e.g., CLI tools, IoT devices)... authentication via a separate device
with a full browser." A community proposal (GitHub Discussion #298, "Non-Interactive OAuth Flows for
Headless & Limited-Input MCP Clients") to have MCP formally add device grant and CIBA support for
headless clients has been open without a spec-level resolution. The practical effect: an MCP client
that's genuinely headless — the exact case this whole article is about — has no first-class,
spec-mandated path today, the same gap Claude Code's own open feature request (#22992, cited above) is
asking Anthropic to close for its own CLI, independent of MCP entirely. A small industry of agent-auth
broker platforms (Nango, Composio, Arcade.dev) has emerged partly to paper over exactly this gap,
presenting a single "Connect" UI that abstracts whichever underlying flow — device code, browser
redirect, or a stored API key — a given provider actually requires, rather than waiting for MCP or any
one provider to converge on a single pattern.

## The Delegated-Subscription-Access Pattern, More Generally

Standing back from the specific endpoint sequence, what we actually built is a small instance of a
pattern that's becoming common across agent infrastructure: **an autonomous agent holding its own,
independently-revocable, delegated credential against a human's personal account**, rather than either
(a) sharing the human's own local credential store, or (b) requiring the organization to provision a
metered API key for every agent that needs model access. A few observations from comparable systems:

- **OpenClaw**, an agent runtime that manages multiple provider logins per agent, treats its
  credential store as what its own documentation calls a "token sink": each agent's auth profiles are
  isolated per-agent specifically so that "if a secondary agent reads an inherited main-agent OAuth
  profile, the refresh writes back to the main agent store" rather than forking a refresh token into
  two independently-rotating copies — the same failure mode we were avoiding by not importing
  `auth.json` directly. OpenClaw's default connection mechanism for OpenAI is still loopback-redirect
  PKCE (with manual URL-paste as a headless fallback, not true device flow), which is a reasonable
  illustration of how common the loopback-first default still is even among agent-specific runtimes —
  device flow is the more headless-native answer, but it's not yet the default most tooling reaches for
  first.
- **The refresh-token-family conflict we set out to avoid is a documented, real problem, not a
  theoretical one.** A GitHub issue against `cc-switch` (a Codex/Claude credential-switching tool)
  describes exactly this failure mode by name: after a Codex OAuth token refresh, "the managed OAuth
  store may contain a newer refresh token, while the provider DB still keeps an older refresh
  token/access/id token," producing false "session expired" errors purely from two stores drifting out
  of sync on what should be one linear rotation. Any design that lets two independent processes refresh
  the same underlying refresh token is exposed to this class of bug; minting a wholly separate token
  family per consumer (as device flow naturally does) sidesteps it rather than needing to solve
  synchronization after the fact.
- **The instantiation of "one identity per agent instance"** that the credential-governance literature
  argues for (see, for instance, OWASP's Non-Human Identities Top 10 treatment of NHI9 "reuse") applies
  just as much to a consumer subscription as to a cloud IAM role: an agent that authenticates through
  its own device-flow login, rather than a copied human credential, gets its own attributable identity
  in the provider's own account-security surface (ChatGPT's device/session list, in our case) — so a
  human reviewing "what has access to my account" sees the agent as a distinct, nameable, revocable
  entry, not an invisible rider on their own session.

The practical takeaway for anyone building agent infrastructure that needs delegated access to a
person's consumer LLM subscription: reach for device flow first if the agent is headless, mint a fresh
token family per delegation rather than reusing or importing the human's own local credential store, and
build the polling and refresh loops to survive transient network failure from day one — because by the
time you notice the loop is fragile, it has already cost a human a repeated, and avoidable,
sign-in.

## Sources

- [RFC 8628 — OAuth 2.0 Device Authorization Grant](https://datatracker.ietf.org/doc/html/rfc8628)
- [OAuth.net — RFC 8628: OAuth 2.0 Device Authorization Grant](https://oauth.net/2/device-flow/)
- [WorkOS — PKCE vs Device Flow: Which OAuth flow is best for CLI auth?](https://workos.com/blog/pkce-vs-device-flow-cli-auth)
- [ChatGPT Learn — Authentication (Codex CLI: OAuth, device code, API keys)](https://learn.chatgpt.com/docs/auth)
- [GitHub — tumf/opencode-openai-device-auth](https://github.com/tumf/opencode-openai-device-auth)
- [GitHub — anthropics/claude-code issue #22992: Support device-code authentication flow (RFC 8628) for Pro/Max subscription users in headless environments](https://github.com/anthropics/claude-code/issues/22992)
- [GitHub — anthropics/claude-code issue #44028: OAuth login flow unusable over SSH on macOS](https://github.com/anthropics/claude-code/issues/44028)
- [GitHub — anthropics/claude-code issue #24614: ECONNRESET kills session — needs auto-retry/reconnect](https://github.com/anthropics/claude-code/issues/24614)
- [GitHub — anthropics/claude-code issue #13657: ECONNRESET errors — Unable to connect to API despite healthy network](https://github.com/anthropics/claude-code/issues/13657)
- [GitHub — openai/codex issue #6191: Codex CLI error "Reconnecting"](https://github.com/openai/codex/issues/6191)
- [GitHub — openai/codex issue #8703: Not able to connect to codex, says "Reconnecting"](https://github.com/openai/codex/issues/8703)
- [GitHub — openai/codex issue #25308: Pause Codex retries while local network is unavailable](https://github.com/openai/codex/issues/25308)
- [GitHub — openai/codex issue #9253: Codex CLI cannot log in on headless environments unless Device Code auth is enabled by workspace admin](https://github.com/openai/codex/issues/9253)
- [GitHub — farion1231/cc-switch issue #4474: Codex OAuth refresh token rotation does not sync back to provider DB, causing false session expired](https://github.com/farion1231/cc-switch/issues/4474)
- [OpenClaw Docs — OAuth](https://docs.openclaw.ai/concepts/oauth)
- [ScaleKit — How to Handle Token Refresh for AI Agents in Production](https://www.scalekit.com/blog/how-handle-token-refresh-ai-agents)
- [Proofpoint — Access granted: phishing with device code authorization for account takeover](https://www.proofpoint.com/us/blog/threat-insight/access-granted-phishing-device-code-authorization-account-takeover)
- [Proofpoint — Device Code Phishing is an Evolution in Identity Takeover](https://www.proofpoint.com/us/blog/threat-insight/device-code-phishing-evolution-identity-takeover)
- [Huntress — We Need to Talk About Device Code Phishing](https://www.huntress.com/blog/tradecraft-tuesday-device-code-phishing-explained)
- [Huntress — Oh-Auth 2.0: Device Code Phishing in Google Cloud and Azure](https://www.huntress.com/blog/oh-auth-2-0-device-code-phishing-in-google-cloud-and-azure)
- [Securelist — When checking the URL isn't enough: a Device Code Phishing attack via a Microsoft website](https://securelist.com/microsoft-device-code-phishing-attack/120350/)
- [Push Security — Analyzing the rise in device code phishing attacks in 2026](https://pushsecurity.com/blog/device-code-phishing)
- [SpyCloud — Device Code Phishing: The New AiTM Attack Bypassing MFA](https://spycloud.com/blog/device-code-phishing-the-new-aitm-attack-bypassing-mfa/)
- [Microsoft Security Blog — Storm-2372 conducts device code phishing campaign (Feb 13, 2025)](https://www.microsoft.com/en-us/security/blog/2025/02/13/storm-2372-conducts-device-code-phishing-campaign/)
- [Volexity — Phishing for Codes: Russian Threat Actors Target Microsoft 365 OAuth Workflows (Apr 22, 2025)](https://www.volexity.com/blog/2025/04/22/phishing-for-codes-russian-threat-actors-target-microsoft-365-oauth-workflows/)
- [Cloud Security Alliance — Research Note: OAuth Device Code Phishing Targeting M365 (Mar 25, 2026)](https://labs.cloudsecurityalliance.org/research/csa-research-note-oauth-device-code-phishing-m365-20260325-c/)
- [Microsoft Security Blog — AI-enabled device code phishing campaign (Apr 6, 2026)](https://www.microsoft.com/en-us/security/blog/2026/04/06/ai-enabled-device-code-phishing-campaign-april-2026/)
- [IETF Datatracker — draft-ietf-oauth-cross-device-security](https://datatracker.ietf.org/doc/draft-ietf-oauth-cross-device-security/)
- [GitHub CLI Docs — Authorizing OAuth Apps (device flow)](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
- [Google Identity — OAuth 2.0 for TV and Limited-Input Device Applications](https://developers.google.com/identity/protocols/oauth2/limited-input-device)
- [Microsoft Entra — OAuth 2.0 device authorization grant flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code)
- [GitHub Docs — Authenticate GitHub Copilot CLI (device flow as default)](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)
- [Docker Docs — docker login (device flow default)](https://docs.docker.com/reference/cli/docker/login/)
- [AWS CLI Docs — sso-oidc start-device-authorization](https://docs.aws.amazon.com/cli/latest/reference/sso-oidc/start-device-authorization.html)
- [AWS Developer Blog — AWS CLI adds PKCE-based authorization for SSO, demoting device code to `--use-device-code`](https://aws.amazon.com/blogs/developer/aws-cli-adds-pkce-based-authorization-for-sso/)
- [Vercel Changelog — New Vercel CLI login flow (device flow adopted as default)](https://vercel.com/changelog/new-vercel-cli-login-flow)
- [Slack Docs — Authorizing the Slack CLI (proprietary in-app challenge code, not RFC 8628)](https://docs.slack.dev/tools/slack-cli/guides/authorizing-the-slack-cli/)
- [Model Context Protocol — Authorization specification, 2025-11-25 (Authorization Code + PKCE only; no RFC 8628)](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [Model Context Protocol — ext-auth extensions overview (Device Authorization Grant as an optional extension)](https://modelcontextprotocol.io/extensions/auth/overview)
- [GitHub — modelcontextprotocol/modelcontextprotocol Discussion #298: Non-Interactive OAuth Flows for Headless & Limited-Input MCP Clients](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/298)

## Notes on Unverified or Fast-Moving Claims

- The exact endpoint paths and JSON field names in the "Endpoint Sequence We Observed" section
  (`/api/accounts/deviceauth/usercode`, `/api/accounts/deviceauth/token`, `/oauth/token`,
  `earliest_refresh_at`, etc.) reflect our own direct observation against the live backend on
  2026-07-21, not a published, versioned API contract — OpenAI could change these without notice, and
  the field name `earliest_refresh_at` is our own label for an observed response field rather than a
  confirmed public name.
- The claim that the official Codex CLI's polling/refresh implementation is "vulnerable to the same"
  transient-network-error class we hit is an inference from the shape and volume of public bug reports
  describing similar unrecoverable-on-transient-error behavior in the same tools' request loops, not a
  direct code read of Codex's device-auth polling implementation — treat it as a well-grounded but
  unconfirmed hypothesis, not a verified defect report against that specific code path.
- OpenClaw's OAuth documentation describes loopback-redirect with manual-paste fallback as its
  mechanism for OpenAI logins as of the version of its docs fetched for this article; if OpenClaw adds
  native device-flow support in a future release, this comparison would need updating.
- Docker's and AWS's official docs do not publish a numeric default polling `interval` or code
  `expires_in` the way GitHub's and Microsoft's docs do — the provider comparison table reports what
  each vendor documents, and silence on a field should be read as "undocumented," not "identical to
  RFC 8628's own defaults."
- The MCP `ext-auth` Device Authorization Grant extension's exact spec text and maturity status (draft
  vs. stable) is described here from the extension-overview page and repository listing, not a direct
  read of the extension's full specification document — treat the characterization as directionally
  correct but verify current wording before citing it as a settled spec quote.
