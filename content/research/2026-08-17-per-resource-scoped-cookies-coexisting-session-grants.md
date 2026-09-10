---
date: "2026-08-17"
title: "Per-Resource Scoped Cookies for Coexisting Web Session Grants"
description: "One narrowly-named cookie per unlocked resource — how RFC 6265bis limits, real browser eviction behavior, cookie prefixes, and fail-closed parsing combine into a session design where independent grants coexist while limiting each bearer token to its intended resource."
tags: ["cookies", "web-security", "session-management", "rfc6265bis", "cookie-prefixes", "capability-urls", "fail-closed", "browser-limits"]
---

## Executive Summary

Browsers maintain a cookie store that can contain many cookies for a domain. One opaque, unguessable cookie per resource grant is therefore a viable application design, subject to shared storage and request-header budgets. Its benefit is narrower bearer authority: copying resource A's token must not authorize B. It does not prevent replay of a stolen A token against A. A single session cookie with a server-side grant set can also support independent grants and granular revocation; its bearer token represents the aggregate authority of that set.

Adjacent prior art helps explain the mechanics without proving this exact architecture is deployed elsewhere. CloudFront custom policies scope authorization to a resource pattern, but policy scoping alone does not create independent cookie slots. Cookie chunking demonstrates multiple named cookies with a defined parsing convention. Capability URLs carry per-resource bearer tokens in a different transport and support repeat access; both URL and cookie designs need explicit server-side invalidation when immediate revocation is required.

The security literature is unambiguous that cookie *scoping* is fragile even when the *format* looks correct: `__Host-`/`__Secure-` prefixes exist precisely because attribute-based scoping (Domain, Path, Secure) is spoofable, while the prefix is carried in the name and enforced by the browser at parse time. But PortSwigger's "Cookie Chaos" research shows prefix enforcement is not uniform across browser/server parser pairs (Unicode whitespace normalization in Django, legacy `$Version=1` parsing in Tomcat/Jetty) — meaning name-prefix trust must be paired with strict, fail-closed server-side Cookie-header parsing, not just browser-side guarantees. This directly validates fail-closing on malformed, duplicate, or over-budget cookie sets instead of best-effort merging.

## Browser Cookie Limits and Standards Reality

This article pins its standards discussion to **draft-ietf-httpbis-rfc6265bis-14**, not an assertion that every current browser implements it identically. Section 5.5 rejects a cookie when the combined **name and value exceed 4096 octets**, and separately ignores an attribute whose **value exceeds 1024 octets**. This is not a 4096-byte limit on name + value + all attributes. Section 6.1 recommends support for at least 50 cookies per domain and 3000 total, but permits eviction at any time; these minimum-capacity recommendations reserve no slots for an application. ([draft-14](https://www.ietf.org/archive/id/draft-ietf-httpbis-rfc6265bis-14.txt))

The storage model uses priority tiers for eviction: expired cookies, then non-secure cookies on over-quota domains, then cookies on over-quota domains, then the remaining pool, with earliest last-access-time as the tie-break. Replacement requires matching **name, domain, host-only flag, and path**. Different cookie coordinates can still yield duplicate names in a request; the server does not receive those coordinates in the Cookie header.

Browser-specific evidence must retain its scope:

| Evidence | What it establishes | Design consequence |
|---|---|---|
| Firefox upstream preferences | `maxPerHost=180`, `quotaPerHost=150` (the post-purge target), `maxNumber=3000` | 150 is not the maximum per-host count; preferences are implementation evidence, not a cross-browser contract |
| Cookie Crumbles §4.3, releases tested January 2021–January 2023 | The study reports no per-site count limit for Safari in that historical sample | This neither establishes unlimited current Safari nor supports a timeless 50-cookie Safari ceiling |
| WebKit tracking-prevention guidance | Script-created cookies and other script-writeable storage are deleted after seven days **without user interaction**; home-screen web-app domains are exempt from that removal rule | This is inactivity removal, not unconditional seven-day lifetime expiry; link-decoration and cloaking expiry rules have separate scopes |

Sources: [Firefox preferences](https://github.com/mozilla-firefox/firefox/blob/main/modules/libpref/init/all.js), [Cookie Crumbles](https://www.usenix.org/system/files/usenixsecurity23-squarcina.pdf), [WebKit tracking prevention](https://webkit.org/tracking-prevention/).

**Application budgeting:** A cap such as 16 grants per mount is a product policy, not guaranteed browser capacity. Other mounts and unrelated cookies compete for storage, and the browser may discard a cookie before that cap is reached. Separately budget the total Cookie request header accepted by the application and its proxies; `Set-Cookie` attributes are not returned in that header. Keep bearer values compact, validate supported browser versions, and handle missing cookies as loss of the local credential rather than assuming retention.

## Cookie Name Prefixes: `__Secure-` and `__Host-`

RFC 6265bis's "Cookie Prefixes" move a security guarantee out of forgeable attributes and into the cookie *name*, enforced by the browser before it accepts a `Set-Cookie` at all: **`__Secure-`** requires the `Secure` attribute over HTTPS but doesn't constrain `Domain`/`Path`; **`__Host-`** is strictly stronger, additionally **forbidding any `Domain` attribute** and **requiring `Path=/`**. ([MDN Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie))

The tradeoff that matters here: forcing `Path=/` means `__Host-` cookies are visible to *every* path on the host. That's fine for a single-mount deployment, but it directly conflicts with **multiple independent app mounts sharing one hostname** — a `__Host-` cookie set by any mount is sent to every other mount's handlers, expanding both cookie-budget contention and name-collision blast radius. A per-resource design that wants path-scoping (a share cookie sent only to requests under its own share path) can't use `__Host-` and must fall back to `__Secure-` plus an explicit `Path`, accepting that Path is a browser send-time hint, not a strict setting boundary — pushing the real defense back onto server-side parsing.

**Enforcement is not uniform.** PortSwigger's "Cookie Chaos" research showed prefix enforcement can be bypassed through server/browser parser disagreement rather than a browser bug: prepending Unicode whitespace to a cookie name makes the *browser* treat it as unrestricted, while frameworks that `.strip()` whitespace when parsing the Cookie header (Django was named) normalize it back to the protected name server-side — smuggling a forged `__Host-`/`__Secure-` cookie past the browser's own gate. A second technique abused legacy RFC 2965 (`$Version=1`) parsing still present in some Java servers (Tomcat, Jetty). ([PortSwigger: Cookie Chaos](https://portswigger.net/research/cookie-chaos-how-to-bypass-host-and-secure-cookie-prefixes)) The lesson: prefix guarantees are a browser-side property; a server that parses loosely can still accept what the browser itself would have rejected — the strongest available argument for strict, fail-closed server-side parsing of the recognized cookie namespace.

## Prior Art

The following sources illustrate adjacent patterns and their limits:

- **AWS CloudFront custom-policy signed cookies**: the policy's `Resource` constrains authorization, while the fixed `CloudFront-Policy`, `CloudFront-Signature`, and `CloudFront-Key-Pair-Id` names occupy cookie slots determined by their name/domain/host-only/path coordinates (current docs also describe an optional hash-algorithm cookie). Changing `Resource` while keeping those coordinates replaces the prior values. Coexisting sets would need distinct cookie paths with routing that selects the appropriate set; a policy URL pattern is not the cookie's `Path`. This is scoped-policy precedent, not automatic per-resource cookie coexistence. ([AWS docs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-setting-signed-cookie-custom-policy.html))
- **Cookie chunking** (ASP.NET Core `ChunkingCookieManager`): precedent that one credential can span multiple named cookies under a deterministic naming/parse grammar. Independent grants use distinct resource keys rather than chunk indices and need their own verification rules. ([Microsoft Learn](https://learn.microsoft.com/en-gb/dotnet/api/microsoft.aspnetcore.authentication.cookies.chunkingcookiemanager.appendresponsecookie))
- **Capability URLs**: an unguessable per-resource token carried in a URL can be retained and revisited, used for repeated API calls or calendar subscriptions, and separately revoked if the server implements that operation. The cited W3C TAG document is an Editor's Draft, not a normative standard. URL history, logs, forwarding and Referer exposure depend on placement and handling; moving a token into an `HttpOnly` cookie reduces direct script readability but introduces ambient-cookie/CSRF considerations. ([TAG draft](https://w3ctag.github.io/capability-urls/2014-07-23.html))
- **Google device-bound sessions**: Google describes theft and replay of session cookies on another device, and device binding as mitigation. Its multi-account note concerns log visibility for the primary account, not cross-account permission leakage. This illustrates why resource scope alone does not make bearer tokens non-replayable. ([Google Workspace](https://knowledge.workspace.google.com/admin/security/prevent-cookie-theft-with-session-binding))
- **GitHub multi-account support**: the announcement explicitly states that saved accounts do not mix user permissions. This is a product-level isolation claim; it does not establish a per-account or per-resource cookie implementation. ([GitHub Changelog](https://github.blog/changelog/2023-11-03-multi-account-support-on-github-com/))

These examples support individual mechanisms, not a claim that this precise combination is standard practice. In the proposed design, every handler must derive tenant/resource authority from a verified token or authoritative server record and check it against the requested resource. A client-supplied resource ID is only a lookup key; an opaque token does not require an embedded signed tenant claim when the server record supplies that binding.

## Security Analysis

**Resource-bound authority via name+secret binding.** Possessing cookie A (resource A) must grant no authority over resource B, even when both share a path and are sent together on matching requests. This needs binding at two layers: the cookie *name* encodes the opaque resource ID (a routing key only), and the *value* must be an unforgeable secret verified server-side — the name is visible on the wire and must never itself be trusted as authorization. Fail-closing on any recognized-name cookie whose value fails verification (rather than silently ignoring it) blocks downgrade attacks that plant a same-named cookie hoping for lenient fallback.

**Fail-closed parsing of adversarial Cookie headers.** The Cookie header has no native duplicate-rejection in the wire grammar — a client can send duplicate names, oversized headers, or names crafted to collide with the recognized pattern. Given that prefix guarantees can be undermined by server-side parser leniency (above), the robust posture is to parse with a strict grammar, reject rather than best-effort-merge on duplicates/malformed values/over-budget counts, and treat anything outside the recognized namespace as inert — an application policy distinct from the browser's storage replacement algorithm. Different domain/path/host-only coordinates can legitimately produce same-name request cookies; this design deliberately rejects ambiguity in its recognized namespace.

**Cookie tossing and shadowing.** "Cookie tossing" is an attacker who controls a sibling subdomain (or an XSS foothold there) setting a same-name, same-path cookie, relying on the browser sending both to the target origin and the server picking or being confused by the wrong one. `__Host-` is the standard mitigation (uncrossable by subdomains), but its forced `Path=/` cannot provide per-mount send-path scoping (above). Where it's unavailable, mitigation falls to treating duplicates as fail-closed and never trusting Path as a setting-time security boundary. The 2023 USENIX paper "Cookie Crumbles: Breaking and Fixing Web Session Integrity" (Squarcina et al.) established session-integrity attacks via cookie injection/overwriting as a broad, systemic class across real sites, reinforcing that attribute scoping alone is an insufficient trust boundary. ([USENIX paper](https://www.usenix.org/system/files/usenixsecurity23-squarcina.pdf), corroborated via [PortSwigger](https://portswigger.net/research/cookie-chaos-how-to-bypass-host-and-secure-cookie-prefixes) and [HackTricks](https://hacktricks.wiki/en/pentesting-web/hacking-with-cookies/cookie-tossing.html))

**SameSite/CSRF.** Scoping to a resource rather than a session doesn't change SameSite mechanics: `Lax` (the modern default) permits top-level navigation GETs, adequate for share-link click-throughs; `Strict` suits flows with no such cross-site-navigation entry point. Per-resource cookies don't strictly need per-resource CSRF tokens if state-changing actions are separately gated, but more valid ambient-authority cookies in the jar arithmetically means more endpoints that must independently enforce that gate.

## Alternatives and Tradeoffs

| Approach | Coexistence | Bearer scope and exposure | Revocation | Wins when |
|---|---|---|---|---|
| Single session cookie + server grant set | Good: session S can map to {A, B} | Theft of S exposes its aggregate grant set | Remove A from the set while retaining B; destroying S is a separate bulk operation | Central session state and one browser credential are convenient |
| Per-resource cookies | Good, subject to shared jar and application budgets | A verified A token authorizes only A, but remains replayable for A; HttpOnly limits script reading | Invalidate A server-side, then expire its local cookie; bulk invalidation is also possible | Independently acquired grants with narrower per-token authority |
| localStorage/sessionStorage + Authorization header | App-managed; persistence differs between storage types | Per-token scope is possible, but same-origin scripts can read stored tokens | Server invalidation stops copied tokens; local deletion only forgets this copy | Script-managed API clients accept the storage/XSS tradeoff |
| Capability URLs | Good; retained links support return visits and repeated use | Per-resource authority with URL retention/forwarding and possible history/log/Referer exposure | Server invalidation stops copied links; removing a bookmark/history entry does not | Portable links and intentional sharing are useful |
| Service-worker-attached tokens | App-managed, subject to worker/storage lifecycle | Depends on token scope and how credentials are stored/exposed | Server invalidation plus appropriate local cleanup | Apps already manage a worker-based request layer |

Per-resource cookies are useful when a plain browser should retain independently acquired grants across reloads and tabs, without script-managed token attachment, and `HttpOnly` protection matters. Retained capability URLs can also support repeat access without login; the choice is about exposure, forwarding, retention and ambient authority, not whether a second visit is possible. A single session plus a grant set remains a valid alternative for the same coexistence requirement.

## Operational Concerns

**Independent eviction systems.** The browser controls its shared cookie store; the server controls its grant ledger and application budget. Resource IDs provide stable identity, not synchronized LRU. Draft-14 §5.8.3 updates last-access-time for every cookie returned in a request: if A and B share a path, a request for A can refresh both browser timestamps while the server records use of A alone. Unrelated cookies and independent eviction add more divergence. Keep the server ledger authoritative, invalidate any server-evicted credential, and recover gracefully when a browser cookie is missing. Use unguessable values and verify resource binding on every request; stable resource IDs alone do not prevent stale-token reuse. No live browser-retention or attack experiment is claimed here.

**Migration from a legacy singleton cookie.** A bounded rotate-on-use window (accept the legacy format, transparently re-issue namespaced on next use, stop accepting legacy after the window closes) avoids a hard cutover forcing simultaneous re-auth, while bounding how long dual-parsing logic — and dual attack surface — stays alive. The window must be a hard, enforced calendar boundary; indefinite dual-support is the same class of parser leniency the PortSwigger prefix-bypass research shows becomes a liability over time.

**Logout semantics across grants.** Per-resource revocation invalidates the chosen grant in the authoritative server state; bulk revocation invalidates the intended set. Expiring matching local cookies is cleanup after either operation and does not invalidate copies held elsewhere. A purely self-contained signed token needs a revocation mechanism (such as a checked grant version or denylist) for immediate invalidation, or remains usable until expiry. Keep single and bulk operations explicit and test their blast radius; they may share implementation helpers. An owner-login bulk reset is a product choice, not a necessary property of either session or per-resource cookies.

## Practical Guidance

- Choose an application grant cap and a separate request-header byte budget; neither reserves browser storage. Check supported browser versions and tolerate early cookie loss.
- Put the resource's opaque ID in the cookie *name* as a lookup key only; never treat the name itself as authorization — verify the *value* server-side.
- Fail closed on anything ambiguous in the Cookie header: duplicates, malformed values, cookies matching the recognized pattern but failing verification, over-budget counts. Never best-effort-merge.
- Prefer `__Host-` when host-wide sending is acceptable; use `__Secure-` with an explicit Path when per-mount send-path scoping is required, and keep server-side authorization authoritative.
- Set SameSite deliberately per access pattern — `Lax` for link-click flows, `Strict` where no cross-site top-level navigation is expected.
- Use stable resource IDs for server lookup and validate each token's binding and live grant state; IDs neither synchronize browser LRU nor invalidate old bearer values.
- Define single and bulk server revocation separately from local cookie expiration, and verify that copied revoked credentials are rejected while unrelated grants survive.
- Put a hard calendar bound on legacy-singleton migration windows and retire dual-format parsing on schedule.
- Treat Path as a browser send-time hint, not a setting-time security boundary; rely on server-side name/value verification instead.
- Compare retained capability URLs with cookies on exposure, forwarding, HttpOnly and ambient-authority behavior; both support repeat access and both need server revocation to invalidate copied credentials.
- Assume duplicate-name Cookie headers are attacker-reachable (no wire-format duplicate prevention exists) and parse defensively by default.

## Sources

- [draft-ietf-httpbis-rfc6265bis-14 — Cookies: HTTP State Management Mechanism](https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-rfc6265bis-14)
- [HTTP Extensions WG Issue #1340 — Clarification on cookie size limits](https://github.com/httpwg/http-extensions/issues/1340)
- [MDN — Set-Cookie header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie)
- [PortSwigger Research — Cookie Chaos: How to bypass __Host and __Secure cookie prefixes](https://portswigger.net/research/cookie-chaos-how-to-bypass-host-and-secure-cookie-prefixes)
- [USENIX Security 2023 — Cookie Crumbles: Breaking and Fixing Web Session Integrity](https://www.usenix.org/system/files/usenixsecurity23-squarcina.pdf)
- [HackTricks — Cookie Tossing](https://hacktricks.wiki/en/pentesting-web/hacking-with-cookies/cookie-tossing.html)
- [AWS Docs — Set signed cookies using a custom policy (CloudFront)](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-setting-signed-cookie-custom-policy.html)
- [Logto — How to fix cookie size exceeded error by splitting cookies](https://blog.logto.io/cookie-size-exceeded)
- [Microsoft Learn — ChunkingCookieManager.AppendResponseCookie Method](https://learn.microsoft.com/en-gb/dotnet/api/microsoft.aspnetcore.authentication.cookies.chunkingcookiemanager.appendresponsecookie)
- [W3C TAG — Good Practices for Capability URLs](https://w3ctag.github.io/capability-urls/2014-07-23.html)
- [Neil Madden — Can you ever (safely) include credentials in a URL?](https://neilmadden.blog/2019/01/16/can-you-ever-safely-include-credentials-in-a-url/)
- [Google Workspace Help — Prevent cookie theft with session binding](https://knowledge.workspace.google.com/admin/security/prevent-cookie-theft-with-session-binding)
- [GitHub Changelog — Multi-account support on GitHub.com](https://github.blog/changelog/2023-11-03-multi-account-support-on-github-com/)
- [Firefox upstream cookie preferences](https://github.com/mozilla-firefox/firefox/blob/main/modules/libpref/init/all.js)
- [WebKit — Tracking Prevention](https://webkit.org/tracking-prevention/)
