---
date: "2026-08-17"
title: "Per-Resource Scoped Cookies for Coexisting Web Session Grants"
description: "One narrowly-named cookie per unlocked resource — how RFC 6265bis limits, real browser eviction behavior, cookie prefixes, and fail-closed parsing combine into a session design where independent grants coexist without becoming transferable."
tags: ["cookies", "web-security", "session-management", "rfc6265bis", "cookie-prefixes", "capability-urls", "fail-closed", "browser-limits"]
---

## Executive Summary

Browsers give every origin a cookie *jar*, not a single slot — RFC 6265bis explicitly models many cookies per domain and defines an eviction algorithm for when that jar overflows. This structural fact is what makes "one narrowly-scoped cookie per unlocked resource" a legitimate architecture rather than a hack: the standard already assumes a domain accumulates cookies from many purposes, and real browsers ship divergent but generous per-domain budgets (Chrome ~180, Firefox ~150, Safari ~50, all with a ~4096-byte per-cookie ceiling). A per-resource cookie design — one opaque, unguessable, narrowly-named cookie per grant (per share link, per document, per tenant) — sits inside that budget rather than fighting it, and buys something a single session cookie cannot: independent, non-transferable, co-existing authorizations in one browser, each individually revocable and evictable.

The pattern has real prior art, rarely under this name. AWS CloudFront's custom-policy signed cookies are inherently per-resource (a policy scoped to one path, delivered as its own cookie triad), and AWS's own docs concede multiple resource paths require multiple independent cookie sets with app-level routing logic. Cookie "chunking" (ASP.NET Core's `ChunkingCookieManager`, various JS libraries) establishes the broader precedent that one logical credential can legitimately be split across multiple named cookies under a defined naming/parsing convention — the same mechanical pattern a per-resource scheme reuses, keyed by resource ID instead of chunk index. Capability URLs (Tyler Close, W3C TAG) are the closest conceptual cousin — unguessable per-resource tokens instead of session state — and their tradeoffs (Referer leakage, hard revocation) map directly onto cookie-based grants.

The security literature is unambiguous that cookie *scoping* is fragile even when the *format* looks correct: `__Host-`/`__Secure-` prefixes exist precisely because attribute-based scoping (Domain, Path, Secure) is spoofable, while the prefix is carried in the name and enforced by the browser at parse time. But PortSwigger's "Cookie Chaos" research shows prefix enforcement is not uniform across browser/server parser pairs (Unicode whitespace normalization in Django, legacy `$Version=1` parsing in Tomcat/Jetty) — meaning name-prefix trust must be paired with strict, fail-closed server-side Cookie-header parsing, not just browser-side guarantees. This directly validates fail-closing on malformed, duplicate, or over-budget cookie sets instead of best-effort merging.

## Browser Cookie Limits and Standards Reality

RFC 6265bis (`draft-ietf-httpbis-rfc6265bis`, IETF HTTPBIS) sets these as implementation guidance, not hard mandates: user agents "SHOULD" support **at least 4096 octets** per cookie (name + value + attributes combined); the agent **MAY** evict once a domain's cookie count exceeds an implementation-defined bound (the draft's own illustrative example is 50, not a requirement); the total store may similarly be capped (illustratively ~3000). The **Storage Model** defines eviction in priority tiers — expired cookies first, then non-secure cookies on over-quota domains, then any cookies on over-quota domains, then the remaining pool — and **within a tie, the cookie with the earliest last-access-time is evicted first**, a defined LRU tiebreak. Two cookies sharing name+domain+path are replacement, not accumulation: a newer `Set-Cookie` silently evicts the older one. ([RFC 6265bis draft](https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-rfc6265bis-14), [HTTPWG issue #1340](https://github.com/httpwg/http-extensions/issues/1340))

Real browsers diverge from the draft's illustrative numbers and from each other:

| Browser | Per-cookie size | Per-domain count | Global count | Eviction |
|---|---|---|---|---|
| Chrome/Chromium | 4096 bytes | 180 (flexes up before purge) | 3300 | LRU by access-time; purges 30/domain, 300 globally on overflow; priority tiers (expired → low-priority non-secure → low-priority secure → medium → high); cookies touched in the last 30 days are protected from cross-site-triggered global purges |
| Firefox | ~4097 bytes | ~150 per domain | — | LRU-style, less formally documented |
| Safari (WebKit) | 4096 bytes | ~50 per domain | — | Script-set (`document.cookie`) cookies are additionally capped at 7-day lifetime by ITP; origins with no user interaction in 7 days have script-written data proactively evicted, on top of capacity eviction |

Sources: [Chromium cookie eviction internals (Yoav Weiss)](https://blog.yoav.ws/posts/how_chromium_cookies_get_evicted/), [Chrome blink-dev Intent to Ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/0N5BePVCPVo), [browser cookie limits table](http://browsercookielimits.iain.guru/), [Safari ITP cookie caps](https://www.simoahava.com/privacy/first-party-cookies-webkit-revisited/), [Ingest Labs survey](https://ingestlabs.com/browser-cookie-limitation-modern-browsers/).

**Implication:** Safari's ~50-cookie ceiling, not Chrome's 180, is the binding constraint for a many-cookies-per-mount design — a budget above ~40–45 risks silent client-side eviction on Safari before a server-defined budget is ever reached. A 16-cookie budget stays comfortably under every engine's limit. The 4096-byte ceiling is universal enough to treat as hard, and it counts attributes (`Path`, `Domain`, `Expires`, `SameSite`), not just `name=value` — rich per-resource claims can brush this ceiling faster than expected.

## Cookie Name Prefixes: `__Secure-` and `__Host-`

RFC 6265bis's "Cookie Prefixes" move a security guarantee out of forgeable attributes and into the cookie *name*, enforced by the browser before it accepts a `Set-Cookie` at all: **`__Secure-`** requires the `Secure` attribute over HTTPS but doesn't constrain `Domain`/`Path`; **`__Host-`** is strictly stronger, additionally **forbidding any `Domain` attribute** and **requiring `Path=/`**. ([MDN Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie))

The tradeoff that matters here: forcing `Path=/` means `__Host-` cookies are visible to *every* path on the host. That's fine for a single-mount deployment, but it directly conflicts with **multiple independent app mounts sharing one hostname** — a `__Host-` cookie set by any mount is sent to every other mount's handlers, expanding both cookie-budget contention and name-collision blast radius. A per-resource design that wants path-scoping (a share cookie sent only to requests under its own share path) can't use `__Host-` and must fall back to `__Secure-` plus an explicit `Path`, accepting that Path is a browser send-time hint, not a strict setting boundary — pushing the real defense back onto server-side parsing.

**Enforcement is not uniform.** PortSwigger's "Cookie Chaos" research showed prefix enforcement can be bypassed through server/browser parser disagreement rather than a browser bug: prepending Unicode whitespace to a cookie name makes the *browser* treat it as unrestricted, while frameworks that `.strip()` whitespace when parsing the Cookie header (Django was named) normalize it back to the protected name server-side — smuggling a forged `__Host-`/`__Secure-` cookie past the browser's own gate. A second technique abused legacy RFC 2965 (`$Version=1`) parsing still present in some Java servers (Tomcat, Jetty). ([PortSwigger: Cookie Chaos](https://portswigger.net/research/cookie-chaos-how-to-bypass-host-and-secure-cookie-prefixes)) The lesson: prefix guarantees are a browser-side property; a server that parses loosely can still accept what the browser itself would have rejected — the strongest available argument for strict, fail-closed server-side parsing of the recognized cookie namespace.

## Prior Art

Genuinely "one cookie per grant" write-ups are rare, but adjacent patterns are well established:

- **AWS CloudFront custom-policy signed cookies**: each policy is scoped to one resource/path pattern, delivered as its own cookie triad (`CloudFront-Policy`/`Signature`/`Key-Pair-Id`). AWS's docs state a single policy can't cover multiple distinct paths — the app must serve the right cookie set per request. ([AWS docs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-setting-signed-cookie-custom-policy.html), [AWS re:Post](https://repost.aws/questions/QUEFDu9ScTRfqXrFe7BWIjUA/support-multiple-resource-paths-in-aws-cloudfront-cookie))
- **Cookie chunking** (ASP.NET Core `ChunkingCookieManager`, JS libraries): production precedent that one credential can span multiple named cookies under a deterministic naming/parse grammar — the same mechanism a per-resource scheme reuses, keyed by resource ID instead of chunk index. ([Logto](https://blog.logto.io/cookie-size-exceeded), [Microsoft Learn](https://learn.microsoft.com/en-gb/dotnet/api/microsoft.aspnetcore.authentication.cookies.chunkingcookiemanager.appendresponsecookie))
- **Capability URLs** (Tyler Close / W3C TAG): the token-per-grant idea at the URL layer — an unguessable identifier *is* the authorization, naturally supporting many simultaneous grants since each is a bare string, not shared session state. TAG guidance on fragment placement (Referer suppression) is directly relevant: a per-resource cookie is essentially a capability token relocated into a scoped, `HttpOnly` cookie, trading fragment leakage for CSRF/SameSite exposure. ([W3C TAG](https://w3ctag.github.io/capability-urls/2014-07-23.html), [Neil Madden](https://neilmadden.blog/2019/01/16/can-you-ever-safely-include-credentials-in-a-url/))
- **Google multi-account sign-in**: a useful *negative* data point — Google multiplexes several identities behind shared cookie/session state plus an account-chooser UI, and published guidance notes cookies and session data can leak across multiplexed accounts. Same UX goal (many coexisting logins), but achieved without per-account cookie isolation, so it lacks the non-transferability property a per-resource design targets. ([Google Workspace: session binding](https://knowledge.workspace.google.com/admin/security/prevent-cookie-theft-with-session-binding))
- **GitHub multi-account support** explicitly avoids "any mixing of user permissions between saved accounts," closer in spirit though implementation details aren't public. ([GitHub Changelog](https://github.blog/changelog/2023-11-03-multi-account-support-on-github-com/))
- **Multi-tenant session isolation** (WorkOS): contrasts "session-per-org" (switching ends one session, starts another, tenant ID in a signed JWT claim) against "org switching within one session" (long-lived identity cookie, short-lived per-org access tokens). Both reinforce that **tenant/resource context must be a signed, server-asserted claim, never client-supplied** — and that the most common real failure is a handler that forgets to check the claim matches the resource requested. ([WorkOS](https://workos.com/blog/multi-tenant-session-management))

No major write-up documents exactly "namespaced per-resource cookies with a client+server budget and LRU eviction," but every component piece (per-resource signed grants, chunked/named cookie sets, capability tokens, fail-closed claim verification) is independently precedented.

## Security Analysis

**Non-transferability via name+secret binding.** Possessing cookie A (resource A) must grant no authority over resource B, even though both share the jar and are sent on every request. This needs binding at two layers: the cookie *name* encodes the opaque resource ID (a routing key only), and the *value* must be an unforgeable secret verified server-side — the name is visible on the wire and must never itself be trusted as authorization. Fail-closing on any recognized-name cookie whose value fails verification (rather than silently ignoring it) blocks downgrade attacks that plant a same-named cookie hoping for lenient fallback.

**Fail-closed parsing of adversarial Cookie headers.** The Cookie header has no native duplicate-rejection in the wire grammar — a client can send duplicate names, oversized headers, or names crafted to collide with the recognized pattern. Given that prefix guarantees can be undermined by server-side parser leniency (above), the robust posture is to parse with a strict grammar, reject rather than best-effort-merge on duplicates/malformed values/over-budget counts, and treat anything outside the recognized namespace as inert — consistent with RFC 6265bis's own replacement-not-merge semantics for duplicate name/domain/path.

**Cookie tossing and shadowing.** "Cookie tossing" is an attacker who controls a sibling subdomain (or an XSS foothold there) setting a same-name, same-path cookie, relying on the browser sending both to the target origin and the server picking or being confused by the wrong one. `__Host-` is the standard mitigation (uncrossable by subdomains), but its forced `Path=/` is unusable in multi-mount deployments (above). Where it's unavailable, mitigation falls to treating duplicates as fail-closed and never trusting Path as a setting-time security boundary. The 2023 USENIX paper "Cookie Crumbles: Breaking and Fixing Web Session Integrity" (Squarcina et al.) established session-integrity attacks via cookie injection/overwriting as a broad, systemic class across real sites, reinforcing that attribute scoping alone is an insufficient trust boundary. ([USENIX paper](https://www.usenix.org/system/files/usenixsecurity23-squarcina.pdf), corroborated via [PortSwigger](https://portswigger.net/research/cookie-chaos-how-to-bypass-host-and-secure-cookie-prefixes) and [HackTricks](https://hacktricks.wiki/en/pentesting-web/hacking-with-cookies/cookie-tossing.html))

**SameSite/CSRF.** Scoping to a resource rather than a session doesn't change SameSite mechanics: `Lax` (the modern default) permits top-level navigation GETs, adequate for share-link click-throughs; `Strict` suits flows with no such cross-site-navigation entry point. Per-resource cookies don't strictly need per-resource CSRF tokens if state-changing actions are separately gated, but more valid ambient-authority cookies in the jar arithmetically means more endpoints that must independently enforce that gate.

## Alternatives and Tradeoffs

| Approach | Coexistence | Non-transferability | Revocation | Wins when |
|---|---|---|---|---|
| Single session cookie + server grant set | Poor — logout/expiry evicts everything at once | Weak — one bearer token covers all granted resources | Simple, but all-or-nothing | "Log out" should mean everything's gone |
| Per-resource cookies | Good, within jar/server budgets | Strong, if name+value binding and fail-closed parsing hold | Granular; bulk-clear still available as override | Independent grants that shouldn't evict each other |
| localStorage/sessionStorage + Authorization header | Excellent, app-managed | Strong per-token, but any script on the page can read all of them (no HttpOnly equivalent) | Simple client deletion | API-first SPAs already avoiding ambient cookie auth, with controlled script surface |
| Capability URLs | Excellent — grant lives in the link | Strong (unguessable = authority), but leaks via Referer/history/logs unless mitigated | Hard — needs server-side invalidation, no client-side "forget" | Fire-and-forget sharing, no expected return visit |
| Service-worker-attached tokens | Good — SW can attach per-scope tokens | Strong if scoped correctly | App-level logic required; unsupported in some webview contexts | Apps already running a SW wanting to avoid cookies for other reasons |

Per-resource cookies win when access must survive reloads/new tabs without re-auth, resources are unlocked independently and asynchronously, the client is a plain browser tab with no script layer for manual token management, and `HttpOnly` protection against XSS exfiltration matters. They lose to capability URLs for no-return-visit sharing, to localStorage+Authorization for API-first apps that accept residual XSS risk, and to a single session cookie when "one account, one session" is the actual product model.

## Operational Concerns

**Budget/eviction consistency.** Two eviction economies run in parallel — the browser's jar limits (Safari's ~50/domain binds) and the server's own concurrent-session budget. If the server budget is smaller (e.g., 16 cookies/4096 bytes per mount), server-side LRU is what matters in practice, but it must actively invalidate the server-side session when it evicts a slot, or a stale client cookie can outlive its server record — or worse, collide with a re-issued slot if slots are keyed by rotating index rather than resource ID. Deterministic LRU keyed identically (by resource ID) on both sides is what keeps the two economies from diverging.

**Migration from a legacy singleton cookie.** A bounded rotate-on-use window (accept the legacy format, transparently re-issue namespaced on next use, stop accepting legacy after the window closes) avoids a hard cutover forcing simultaneous re-auth, while bounding how long dual-parsing logic — and dual attack surface — stays alive. The window must be a hard, enforced calendar boundary; indefinite dual-support is the same class of parser leniency the PortSwigger prefix-bypass research shows becomes a liability over time.

**Logout semantics across grants.** "Owner login clears all grants" is defensible as a blunt reassertion-of-control instrument, but it is a different operation from per-resource revocation, which should stay available without touching unrelated grants. The two need genuinely separate code paths (bulk-clear vs. single-cookie-expire) so a bug in one can't silently change the blast radius of the other.

## Practical Guidance

- Design to the tightest browser's ceiling (Safari, ~50 cookies/domain, ~4096 bytes/cookie), not Chrome's more generous numbers.
- Put the resource's opaque ID in the cookie *name* as a lookup key only; never treat the name itself as authorization — verify the *value* server-side.
- Fail closed on anything ambiguous in the Cookie header: duplicates, malformed values, cookies matching the recognized pattern but failing verification, over-budget counts. Never best-effort-merge.
- Use `__Secure-` by default; reserve `__Host-` for genuinely single-mount-per-host deployments, since its forced `Path=/` breaks path-scoped isolation between co-hosted mounts.
- Set SameSite deliberately per access pattern — `Lax` for link-click flows, `Strict` where no cross-site top-level navigation is expected.
- Key server-side eviction slots by resource ID, not array index, so a stale cookie can't collide with a re-issued slot for a different resource.
- Keep bulk-clear (owner login) and single-grant revocation as separate code paths, not one built as a loop over the other.
- Put a hard calendar bound on legacy-singleton migration windows and retire dual-format parsing on schedule.
- Treat Path as a browser send-time hint, not a setting-time security boundary; rely on server-side name/value verification instead.
- Reserve capability URLs for fire-and-forget sharing with no expected return visit; use cookies when repeat, no-re-auth access is the goal.
- Assume duplicate-name Cookie headers are attacker-reachable (no wire-format duplicate prevention exists) and parse defensively by default.

## Sources

- [draft-ietf-httpbis-rfc6265bis-14 — Cookies: HTTP State Management Mechanism](https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-rfc6265bis-14)
- [HTTP Extensions WG Issue #1340 — Clarification on cookie size limits](https://github.com/httpwg/http-extensions/issues/1340)
- [Chromium's cookies get evicted — Yoav Weiss](https://blog.yoav.ws/posts/how_chromium_cookies_get_evicted/)
- [Chrome blink-dev: Intent to Prototype and Ship — Cookie size limits](https://groups.google.com/a/chromium.org/g/blink-dev/c/0N5BePVCPVo)
- [Browser Cookie Limits comparison table](http://browsercookielimits.iain.guru/)
- [Ingest Labs — Understanding Cookie Size Limits in Modern Browsers](https://ingestlabs.com/browser-cookie-limitation-modern-browsers/)
- [Simo Ahava — Expiration Cap Removed From JavaScript Cookies In WebKit Browsers](https://www.simoahava.com/privacy/first-party-cookies-webkit-revisited/)
- [MDN — Set-Cookie header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie)
- [PortSwigger Research — Cookie Chaos: How to bypass __Host and __Secure cookie prefixes](https://portswigger.net/research/cookie-chaos-how-to-bypass-host-and-secure-cookie-prefixes)
- [USENIX Security 2023 — Cookie Crumbles: Breaking and Fixing Web Session Integrity](https://www.usenix.org/system/files/usenixsecurity23-squarcina.pdf)
- [HackTricks — Cookie Tossing](https://hacktricks.wiki/en/pentesting-web/hacking-with-cookies/cookie-tossing.html)
- [insecure.in — Cookie Tossing: Meaning, Example & Prevention](https://www.insecure.in/blog/cookie-tossing)
- [AWS Docs — Set signed cookies using a custom policy (CloudFront)](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-setting-signed-cookie-custom-policy.html)
- [AWS re:Post — Support multiple resource paths in AWS Cloudfront cookie](https://repost.aws/questions/QUEFDu9ScTRfqXrFe7BWIjUA/support-multiple-resource-paths-in-aws-cloudfront-cookie)
- [Logto — How to fix cookie size exceeded error by splitting cookies](https://blog.logto.io/cookie-size-exceeded)
- [Microsoft Learn — ChunkingCookieManager.AppendResponseCookie Method](https://learn.microsoft.com/en-gb/dotnet/api/microsoft.aspnetcore.authentication.cookies.chunkingcookiemanager.appendresponsecookie)
- [W3C TAG — Good Practices for Capability URLs](https://w3ctag.github.io/capability-urls/2014-07-23.html)
- [Neil Madden — Can you ever (safely) include credentials in a URL?](https://neilmadden.blog/2019/01/16/can-you-ever-safely-include-credentials-in-a-url/)
- [Google Workspace Help — Prevent cookie theft with session binding](https://knowledge.workspace.google.com/admin/security/prevent-cookie-theft-with-session-binding)
- [GitHub Changelog — Multi-account support on GitHub.com](https://github.blog/changelog/2023-11-03-multi-account-support-on-github-com/)
- [WorkOS Blog — Multi-tenant session management: Isolation patterns that actually work](https://workos.com/blog/multi-tenant-session-management)
