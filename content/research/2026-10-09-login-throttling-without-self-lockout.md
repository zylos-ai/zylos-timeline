---
date: "2026-10-09"
time: "09:30"
title: "Login Throttling That Doesn't Lock Everyone Out"
description: "Why IP-based brute-force lockout becomes a self-inflicted denial of service behind proxies and tunnels, and how to throttle password-only agent consoles correctly."
tags: ["ai-agents", "security", "authentication", "rate-limiting", "reverse-proxy", "reliability"]
---

## Executive Summary

A small, self-hosted web console protected by a single shared password — no
username — sat behind a reverse proxy. The server's client-IP logic only
trusted the `X-Forwarded-For` header when the direct TCP peer was loopback;
in production the direct peer was the proxy's internal address, which did
not match, so the server silently fell back to treating every request as
coming from the proxy itself. Every visitor collapsed onto one apparent
source address. An operator testing a login made a handful of wrong-password
attempts. The IP-based lockout rule fired — and because every public visitor
now shared that one "IP," the lockout logic locked out the entire site for
ten minutes, for everyone, not just the operator.

This is not an exotic bug. It is the generic failure mode of any
brute-force defense whose key is "the request's apparent source address" in
an environment where that address is not reliably attributable to one
client — which includes essentially every deployment behind a reverse proxy,
CDN, corporate NAT, carrier-grade NAT (CGNAT), or tunnel. When attribution
collapses, a defense meant to slow down one attacker instead hands any
attacker (or any confused script) a free, self-service denial-of-service
switch against the whole user base. For a password-only console — one with
no account/username dimension to fall back on — the problem is structurally
worse, because the only two available lockout keys are "the IP" and
"everyone."

This article covers why lockout key choice matters, how shared-source
collapse happens and how to detect it, why hard lockouts are the wrong
primitive for this threat model, the correct way to derive a client IP
behind proxies, the OWASP "device cookie" pattern as a practical bypass
mechanism, and a concrete checklist for agent platforms that expose
password-only web consoles.

## Why Lockout Key Choice Matters

Every throttle or lockout mechanism needs a *key* — the identifier it counts
failures against. The standard options, in decreasing order of precision:

- **Per-account**: count failures against the username/account being
  attacked. This is what the [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
  recommends as the default: "the counter of failed logins should be
  associated with the account itself, rather than the source IP address, in
  order to prevent an attacker from making login attempts from a large
  number of different IP addresses." It is precise against distributed
  (many-IP) attacks on one account, but on its own it lets an attacker who
  merely wants to deny service to a *known* user lock that user out from a
  single IP with a handful of guesses — which is exactly the denial-of-service
  pattern OWASP warns about in the same document: "care must be taken to
  prevent [lockout] from being used to cause a denial of service by locking
  out other users' accounts."
- **Per-(account, IP)**: django-axes, for example, supports
  `AXES_LOCKOUT_PARAMETERS = ['username', 'ip_address']`, locking only the
  combination of a specific account attempted from a specific source rather
  than the account globally or the source globally. This is the sweet spot
  when you have both dimensions available: an attacker spraying one
  password across many accounts from one IP gets IP-scoped throttling; an
  attacker grinding one account from many IPs gets account-scoped
  throttling; nobody else is affected by either.
- **Per-IP**: count failures against the apparent source address, full
  stop. This is the fallback when there is no account dimension, and it is
  exactly where password-only consoles land, because there is no username
  to key on.
- **Global**: count failures against the service as a whole. Rarely
  intentional — it's usually what per-IP *degrades into* when the IP
  signal collapses, as in the incident above.

A single shared password with no username is a deliberately minimal
authentication surface — appropriate for a small internal tool — but it
removes the account dimension entirely. The lockout key then has nowhere to
go but IP, and if IP attribution is wrong, nowhere to go but global. This is
the structural reason the incident wasn't a one-off coding mistake so much
as an inevitable consequence of the design: password-only + IP-keyed lockout
+ broken proxy trust = global lockout, deterministically.

## The Shared-Source Collapse Failure

"Per-IP" throttling implicitly assumes one IP address is a reasonable proxy
for "one client" — close enough in intent, if not in strict identity, that
punishing the address doesn't collaterally punish strangers. That assumption
breaks down in several common, non-adversarial topologies, and can be
*deliberately* triggered by an adversary in others:

- **Reverse proxies / tunnels** (the incident's actual cause): the server
  sees the proxy's or tunnel endpoint's IP as the TCP peer for every
  request. Cloudflare Tunnel, Tailscale Funnel, ngrok, and plain nginx/HAProxy
  reverse proxies all terminate the public connection and open a new one (or
  multiplex) to the origin. If the origin doesn't correctly read the
  forwarded-client header from a *trusted* hop, every request looks
  identical from the origin's point of view.
- **CGNAT**: mobile carriers and some ISPs put thousands of unrelated
  subscribers behind one or a few public IPv4 addresses. The [SIDN writeup on CGNAT](https://www.sidn.nl/en/news-and-blogs/cgnat-frustrates-all-ip-address-based-technologies)
  notes this breaks IP-address-based technologies generally — rate limiting
  and abuse blocking among them — because "the malicious activities of an
  individual user can lead to a large number of users who share that IP
  address all being blocked."
- **Corporate NAT / campus networks**: the same collapse at smaller scale —
  an entire office or university department can present as one address.
- **IPv6 /64 rotation**: a single residential customer can be assigned an
  entire /64 and rotate addresses within it, which breaks the *opposite*
  assumption (one client, many apparent IPs) and defeats naive per-IP
  throttling from the other direction.
- **Deliberate collapse as an attack**: because this is a predictable
  failure mode, any attacker who can identify that a target sits behind a
  proxy that mis-trusts `X-Forwarded-For` can trigger the same global
  lockout on purpose, at near-zero cost, by failing a login a few times.
  Academic work on this class of attack ([Characterizing and Preventing Account Denial-of-Service Attacks](https://web.cs.wpi.edu/~cshue/research/securecomm.19.lockouts.pdf))
  found some lockout-DoS attacks fully effective with on the order of 13
  KB/second of attack traffic — i.e., trivial for anyone.

The mirror-image attack is also worth naming: an attacker who distributes
guesses against *one* account across a large rotating or botnet IP pool
never accumulates enough failures on any single IP to trip a per-IP
throttle, which is why the [OWASP Credential Stuffing Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Credential_Stuffing_Prevention_Cheat_Sheet.html)
is explicit that IP blocking "should not be used as the sole or primary
defense due to the ease in circumvention" — credential-stuffing toolkits
routinely ship built-in proxy-network support "to distribute requests across
a large volume of unique IP addresses," defeating both IP blocklists and
rate limiting in the other direction.

### Detecting collapse before it bites

The fix starts with noticing the collapse, not just configuring around it
after the fact. Two cheap checks, suitable for a startup self-test or a
background sanity check at runtime:

```js
// Illustrative, not production code.
// Runtime self-check: if an overwhelming share of recent requests
// appear to originate from one address, something upstream of us
// is not forwarding real client IPs — warn loudly rather than
// silently throttling everyone as "one client."
function checkSourceConcentration(recentRequestIps, { windowSize = 500, warnRatio = 0.6 }) {
  const counts = new Map();
  for (const ip of recentRequestIps.slice(-windowSize)) {
    counts.set(ip, (counts.get(ip) || 0) + 1);
  }
  const [topIp, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || [];
  if (topCount / recentRequestIps.length > warnRatio) {
    console.warn(
      `[security] ${((topCount / recentRequestIps.length) * 100).toFixed(0)}% of the last ` +
      `${recentRequestIps.length} requests appear to come from ${topIp}. ` +
      `If this is a proxy/tunnel address, X-Forwarded-For is probably not being trusted correctly.`
    );
  }
}
```

```js
// Illustrative. A second, cheaper self-check: if the direct TCP peer
// is a known proxy/tunnel address (or simply not loopback/private)
// but X-Forwarded-For is being ignored, that's a misconfiguration,
// not a security posture — flag it instead of silently degrading.
function checkProxyTrustSanity(directPeerIp, xForwardedForHeader, trustedProxyCidrs) {
  const peerLooksLikeProxy = trustedProxyCidrs.some((cidr) => ipInCidr(directPeerIp, cidr));
  if (xForwardedForHeader && !peerLooksLikeProxy) {
    console.warn(
      `[security] Received X-Forwarded-For (${xForwardedForHeader}) from untrusted peer ` +
      `${directPeerIp}. Either add this peer to the trusted proxy list, or this header is ` +
      `being spoofed/ignored incorrectly.`
    );
  }
}
```

`express-rate-limit` ships essentially this idea as a built-in, mandatory
validation rather than an optional helper: it refuses to treat `trust proxy:
true` as a safe production value, raising `ERR_ERL_PERMISSIVE_TRUST_PROXY`
because that setting "could cause the rate limiter to use the wrong IP
address" — a leftmost `X-Forwarded-For` entry that is attacker-controlled —
and separately raises `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` when a
`X-Forwarded-For` header is present but `trust proxy` is `false` (the
default), which "usually indicates a configuration issue that will cause
express-rate-limit to apply its limits globally rather than per-user" — the
exact failure in the motivating incident, caught automatically at the
library level. It also validates the RFC 7239 `Forwarded` header path
separately (`ERR_ERL_FORWARDED_HEADER`), since Express's own `trust proxy`
setting doesn't parse that header format. These checks are a good model:
treat "my rate limiter and my proxy disagree about trust" as a loud startup
or first-request warning, not a silent fallback.

## Hard Lockout vs. Progressive Delay vs. Token Bucket

Once the key is sorted out, the next decision is what happens when a client
exceeds the threshold. Three broad strategies, in order of how much of a
denial-of-service lever they hand to an attacker:

**Hard lockout.** Block authentication entirely for a fixed window once a
threshold is crossed. Simple to implement, simple to reason about — and the
most weaponizable, because it converts "attacker fails N logins" into "a
window of complete denial," whether of one account, one IP, or (as in the
incident) everyone. OWASP's mitigation for the single-account version of
this is to keep an *alternate* path open during lockout — e.g. "allow the
use of the forgotten password functionality to log in, even if the account
is locked out" — but a password-only console with no account recovery flow
has no equivalent escape hatch for its users once locked.

**Progressive delay / exponential backoff.** Instead of a binary
locked/unlocked state, each additional failure increases the response delay
for that key: unauthenticated-but-slow, rather than unauthenticated. NIST SP
800-63B-4 (finalized July 31, 2025) explicitly favors this family of
controls alongside the hard "100 consecutive failed attempts" ceiling it
sets for authenticator disabling: it recommends bot-detection challenges
before authentication attempts and progressive delays — it gives an example
range of roughly 30 seconds up to an hour as failures approach the limit —
plus risk-based signals (IP, geolocation, timing, browser metadata) as
alternatives to flatly denying access. Critically, 800-63B-4 also says the
100-attempt figure is an upper bound that organizations may set lower, not a
target to allow, and that a verifier "SHOULD disregard any previous failed
attempts" once authentication succeeds, so a legitimate user who eventually
gets the password right isn't penalized for earlier typos.

**Token bucket / rate limiting without lockout.** Treat login attempts as a
metered resource: each key gets a bucket of tokens that refill over time;
an attempt consumes a token; an empty bucket means "try again slightly
later," with no persistent locked state at all. This degrades gracefully
under shared-source collapse, because the *cost* of being wrong about
attribution is "legitimate users occasionally wait a few seconds," not
"legitimate users are locked out for ten minutes." It is the general
mechanism `express-rate-limit`, Rack::Attack's `throttle`, and most modern
rate limiters implement by default, as distinct from `fail2ban`-style
banning.

**Tarpitting.** A close cousin of progressive delay applied at the
connection or response level rather than the account level — deliberately
slow the response to a failed attempt (without revealing why) so that
automated guessing throughput drops, while a human mistyping a password once
barely notices the extra second.

```js
// Illustrative progressive delay, keyed by whatever identifier
// you've determined is safe to use (ideally account; IP only as
// a secondary signal, never as the sole key for a password-only
// console without the mitigations described in this article).
function delayForAttempt(failureCount, { baseMs = 500, capMs = 60_000 } = {}) {
  // 500ms, 1s, 2s, 4s, ... capped — not a hard lock, just friction.
  const delay = baseMs * 2 ** Math.max(0, failureCount - 1);
  return Math.min(delay, capMs);
}

async function handleLogin(key, attempt, store) {
  const failures = await store.getFailureCount(key);
  await sleep(delayForAttempt(failures));
  const ok = await verifyPassword(attempt);
  if (ok) {
    await store.clearFailures(key); // NIST 800-63B-4: disregard prior failures on success
  } else {
    await store.incrementFailures(key, { ttlSeconds: 600 });
  }
  return ok;
}
```

The common thread across NIST's and OWASP's guidance is: prefer mechanisms
whose failure mode under misattribution is "a bit slower," not "completely
blocked." A hard lockout has no safe failure mode when the key turns out to
be wrong.

### The device cookie pattern

A complementary mechanism worth borrowing directly for a password-only
console is the **device cookie** pattern documented by OWASP in ["Slow Down Online Guessing Attacks with Device Cookies"](https://owasp.org/www-community/Slow_Down_Online_Guessing_Attacks_with_Device_Cookies).
The idea: on a *successful* login, issue the client a cookie containing
`LOGIN,NONCE,SIGNATURE`, where the signature is an HMAC over the login
identifier and nonce under a server-held secret, and mark the cookie
`Secure` and `HttpOnly`. On subsequent login attempts:

1. If a valid device cookie is present (correct format, valid HMAC, login
   matches), failed attempts from that request count against the *device's*
   own counter, not the shared/global or IP counter — a client that has
   proven itself once gets its own leash rather than being thrown in with
   every anonymous visitor.
2. If no cookie is present (or it's invalid), the attempt is treated as
   coming from an untrusted client and counts toward the stricter,
   shared/account-wide lockout counter.
3. If a device's own failure count exceeds a threshold, that specific
   cookie is placed on a lockout list and reverts to untrusted status — so a
   stolen or brute-forced cookie doesn't get indefinite extra attempts (the
   original OWASP writeup notes this does mean a cookie-holding client can
   accumulate up to roughly double the normal threshold across the two
   phases, which it treats as an acceptable tradeoff given `Secure`/
   `HttpOnly` protections against casual cookie theft).

Applied to a shared-password console, this is directly useful: an operator
or regular user whose browser has a valid device cookie from a prior
successful login can be exempted from (or given a much higher threshold
than) the IP-keyed or global lockout that protects everyone else — meaning
one operator fat-fingering a password a few times doesn't even need to
touch the defense meant for anonymous strangers, because their own browser
already proved itself. It is not a defense against a determined attacker
with no prior access (they have no cookie to present), but it directly
neutralizes the "trusted operator trips the same gate as a potential
attacker" problem that caused the original incident.

## Correct Client-IP Derivation Behind Proxies

If any part of the defense still keys on IP (and for a password-only
console, some part likely will), getting the client IP right is not
optional. The common bugs, and the fixes:

- **Trusting only loopback.** The incident's root cause: client-IP logic
  that only honored `X-Forwarded-For` when the direct peer was `127.0.0.1`.
  Correct behavior requires an explicit, configurable **trusted proxy
  list** — specific IPs or CIDR ranges, not just loopback — and the logic
  must actually consult it, not silently fall back when the peer doesn't
  match. The right shape is: use the connection peer by default, and
  honor forwarding headers only when that peer is on the configured
  trusted-proxy list, so clients cannot spoof their way past the throttle.
  That list has to include the actual proxy's actual address, and the
  behavior when it doesn't match should be loud, not a
  silent degrade to "trust nothing, treat the proxy as the client."
- **Trusting the leftmost `X-Forwarded-For` entry.** `X-Forwarded-For` is
  a comma-separated list; each proxy appends the address of the peer it
  received the request from. Only the
  *rightmost* entries, up to the number of hops you actually trust, were
  added by infrastructure you control; everything to the left can be
  supplied by the original client and is therefore spoofable. This is
  precisely what `express-rate-limit`'s `ERR_ERL_PERMISSIVE_TRUST_PROXY`
  check guards against: `trust proxy: true` makes Express return the
  *leftmost* entry, "which could be set by the proxy or a malicious
  client." The fix is to trust an exact hop count or explicit address/CIDR
  list (e.g., `app.set('trust proxy', 1)` for exactly one known proxy hop)
  and walk from the right:

```js
// Illustrative rightmost-untrusted-hop walk.
function clientIpFromXff(xForwardedForHeader, directPeerIp, trustedProxies) {
  // trustedProxies: Set of addresses of proxies you operate.
  // Only believe the header if the request reached you via one of them.
  if (!trustedProxies.has(directPeerIp) || !xForwardedForHeader) return directPeerIp;
  const chain = xForwardedForHeader.split(",").map((s) => s.trim());
  // Each proxy appended the peer it saw, so walk from the right and
  // skip entries that are themselves trusted proxies (multi-hop chains).
  // The first untrusted address is the client; anything left of it may
  // have been forged by the client and is ignored.
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!trustedProxies.has(chain[i])) return chain[i];
  }
  return chain[0]; // every hop was a trusted proxy
}
```

- **Ignoring the `Forwarded` header.** RFC 7239 standardizes a `Forwarded`
  header (`for=`, `by=`, `host=`, `proto=` parameters) as a structured
  alternative to the de-facto `X-Forwarded-For`. Some proxies emit this
  instead of or in addition to XFF; a client-IP function that only parses
  XFF will silently miss it — which is why `express-rate-limit` raises
  `ERR_ERL_FORWARDED_HEADER` when it detects a `Forwarded` header it can't
  use with the default key generator, rather than silently ignoring it.
- **Double proxies / unexpected hop counts.** A tunnel in front of a
  reverse proxy in front of the app adds two hops, not one; a trusted-hop
  count or trusted-CIDR list that assumes a single hop will again collapse
  attribution, just one layer further in. `real_ip_recursive on` in nginx's
  `ngx_http_realip_module` exists for exactly this case: it walks back
  through a chain of trusted proxy addresses rather than assuming the
  immediately-adjacent one is the only hop. The general nginx pattern is
  `set_real_ip_from <trusted CIDR>;` plus `real_ip_header X-Forwarded-For;`
  — and the same rule as everywhere else applies: only addresses actually
  listed are trusted, so the list must match the real deployment topology,
  including tunnel egress addresses, not just internal load-balancer IPs.
- **PROXY protocol.** Where proxies sit at the TCP layer rather than
  speaking HTTP (common for TLS-passthrough or non-HTTP protocols), the
  equivalent problem is solved with the PROXY protocol header instead of an
  HTTP header, and needs the same trusted-source discipline: only decode it
  from connections originating at a configured, trusted proxy address.

## Operational Concerns

Getting the key and the algorithm right is necessary but not sufficient.
Several operational details determine whether the fix actually survives
production:

- **Lockout state storage.** In-memory counters reset on every process
  restart — convenient for not accidentally persisting a bad lockout, but
  it also means a restart is a free unlock for an attacker, and in a
  multi-instance deployment, each instance maintains its own counter,
  silently multiplying the effective threshold (and multiplying the blast
  radius of shared-source collapse, since the correct fix needs to be
  applied in every instance, not just one). A shared store (Redis, a
  database) gives consistent counting across instances and survives
  restarts, at the cost of needing its own availability story — don't let
  the throttle become unavailable in a way that fails closed and blocks all
  logins when the store itself is down.
- **Operator escape hatch.** However the primary defense is keyed, keep an
  independent way in that doesn't depend on it: a loopback-only or
  local-network-only unlock endpoint, a CLI command that clears a specific
  key's counters (`axes_reset` exists in django-axes for exactly this), or
  an administrative bypass gated on something other than the thing that
  might be broken (the HTTP-layer lockout itself).
- **Logging and alerting on lockout events.** A lockout firing should be
  visible, not silent — log the key that triggered it, the apparent source
  IP(s) and hop chain, and the threshold crossed, and alert if a lockout's
  duration or frequency looks anomalous (e.g., the same key relocking
  immediately after every cooldown, which is both a sign of a live attack
  and a sign of exactly the misattribution bug described here).
- **Testing the throttle without locking production.** The single most
  useful regression test for this class of bug is a negative control: drive
  two distinct simulated client IPs through the *real* proxy path (not a
  direct connection to the app) and assert that they accumulate independent
  failure counters. If they collapse onto one counter in the test, they
  will collapse onto one counter — and one shared lockout — in production.
  This test should run against the actual reverse-proxy/tunnel
  configuration, since the bug lives in the interaction between the proxy
  and the app, not in either component alone.

## Design Checklist for Password-Only Agent Consoles

1. **Never use a hard, instance-wide lockout keyed on IP alone** for a
   console with no account dimension. Prefer progressive delay or a token
   bucket whose failure mode under misattribution is "slower," not
   "blocked."
2. **Maintain an explicit trusted-proxy list** (specific IPs/CIDRs, not
   just loopback) and fail loudly — log and alert — when a request arrives
   with forwarding headers from a peer not on that list, or without
   forwarding headers from a peer that is.
3. **Walk `X-Forwarded-For` from the right**, trusting exactly as many hops
   as you operate; never trust the leftmost entry or `trust proxy: true`.
   Handle the RFC 7239 `Forwarded` header explicitly if any upstream
   component might emit it instead.
4. **Run a startup/runtime self-check for source concentration**: if an
   abnormal share of recent requests appear to share one source address,
   warn immediately rather than letting it silently degrade defenses.
5. **Issue a device cookie on successful authentication** and give
   cookie-holding clients their own failure counter, separate from and more
   lenient than the one applied to unauthenticated/anonymous clients —
   this specifically prevents an operator's own typos from tripping the
   defense meant for strangers.
6. **Disregard prior failures after a success**, per NIST SP 800-63B-4, so
   a user who eventually enters the right password isn't penalized for
   earlier mistakes.
7. **Keep an operator escape hatch independent of the HTTP-layer lockout**
   — a local-only unlock path or CLI reset — so a misattribution bug cannot
   take down the only way to fix it.
8. **Store throttle state in a shared backend** if running multiple
   instances, and decide explicitly what happens to logins if that backend
   is unavailable (fail open with reduced protection vs. fail closed and
   lock everyone out — the latter recreates the original incident by a
   different path).
9. **Log every lockout/throttle event** with the key, source chain, and
   threshold, and alert on patterns consistent with either an attack or a
   misconfiguration.
10. **Test with a negative control through the real proxy path**: two
    distinct client IPs must produce two independent counters end-to-end,
    not just in a unit test against the app alone.

## Open Questions

- How should a password-only console (no account, often no persistent user
  identity at all) implement anything like NIST's "SHOULD disregard any
  previous failed attempts" on success, when there's no account record to
  attach that state to besides the device cookie itself? The device-cookie
  approach answers this at the client level, but it's worth being explicit
  that it's a different unit of trust (the browser/device) than the
  account-centric model most guidance assumes.
- What's the right default when the trusted-proxy self-check fires in
  production — degrade to a conservative token-bucket-only mode
  automatically, or merely alert and keep the existing (possibly broken)
  behavior until a human intervenes? Automatic degradation is safer but
  risks masking the misconfiguration indefinitely if the alert is ignored.
- For CGNAT and IPv6 /64 rotation specifically, is there a meaningfully
  better per-IP granularity available (e.g., keying partially on subnet
  rather than exact address) that doesn't just move the collapse point
  rather than fixing it? This likely has no clean general answer and
  probably argues for leaning more heavily on device cookies and
  progressive delay rather than any IP granularity.
- Is there published, independent data on how often the specific
  failure mode in this article — proxy trust misconfiguration causing
  global lockout — actually occurs in the wild, versus the better-documented
  CGNAT/shared-IP collateral-blocking problem? The academic lockout-DoS
  literature found focuses mostly on deliberate attacks against specific
  accounts rather than this accidental, proxy-driven global collapse.

## References

- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [OWASP Credential Stuffing Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Credential_Stuffing_Prevention_Cheat_Sheet.html)
- [OWASP: Slow Down Online Guessing Attacks with Device Cookies](https://owasp.org/www-community/Slow_Down_Online_Guessing_Attacks_with_Device_Cookies)
- [NIST SP 800-63B-4, Digital Identity Guidelines: Authentication and Authenticator Management (final, July 31, 2025)](https://csrc.nist.gov/pubs/sp/800/63/b/4/final)
- [NIST SP 800-63-4 web edition, Authenticators section](https://pages.nist.gov/800-63-4/sp800-63b/authenticators/)
- [express-rate-limit: Error Codes reference (ERR_ERL_PERMISSIVE_TRUST_PROXY, ERR_ERL_UNEXPECTED_X_FORWARDED_FOR, ERR_ERL_FORWARDED_HEADER)](https://express-rate-limit.mintlify.app/reference/error-codes)
- [django-axes documentation](https://django-axes.readthedocs.io/en/latest/4_configuration.html)
- [Rack::Attack README](https://www.rubydoc.info/gems/rack-attack/5.4.2)
- [RFC 7239: Forwarded HTTP Extension](https://datatracker.ietf.org/doc/html/rfc7239)
- [nginx ngx_http_realip_module documentation](https://nginx.org/en/docs/http/ngx_http_realip_module.html)
- [Characterizing and Preventing Account Denial-of-Service Attacks (SecureComm '19)](https://web.cs.wpi.edu/~cshue/research/securecomm.19.lockouts.pdf)
- [SIDN: CGNAT frustrates all IP address-based technologies](https://www.sidn.nl/en/news-and-blogs/cgnat-frustrates-all-ip-address-based-technologies)
- [Auth0: Brute-Force Protection documentation](https://auth0.com/docs/secure/attack-protection/brute-force-protection)
