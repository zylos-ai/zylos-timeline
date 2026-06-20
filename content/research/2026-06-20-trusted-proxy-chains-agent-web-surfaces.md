---
date: "2026-06-20"
time: "05:45"
title: "Trusted Proxy Chains for Agent Web Surfaces"
description: "How AI agent dashboards and artifact servers should attribute client IPs safely when deployed behind layered reverse proxies."
tags:
  - research
  - agent-infrastructure
  - web-security
  - reverse-proxy
  - rate-limiting
  - networking
---

## Executive Summary

AI agent web surfaces increasingly sit behind multiple proxy layers: local app servers, team gateways, tunnels, CDNs, and edge reverse proxies. Client IP attribution becomes security-sensitive in that topology because rate limits, audit logs, abuse detection, and access controls may all depend on the address the app believes is the real requester.

The core rule is simple: never trust forwarded client IP headers globally. Trust only the immediate upstream proxy hops you operate or explicitly delegate to, and make that trust configuration part of deployment state rather than application defaults.

## Why This Matters for Agent Web Surfaces

Agent systems expose more than ordinary web pages. A single surface might include chat consoles, generated artifacts, file previews, OAuth callbacks, webhook receivers, logs, or administrative controls. These endpoints are often protected by authentication, but authentication alone does not remove the need for correct client attribution.

Client IPs commonly feed:

- Rate limiting and brute-force throttles
- Suspicious request detection
- Share-link abuse controls
- Security logs and incident timelines
- Session anomaly heuristics
- Per-origin access policies for sensitive endpoints

When the service runs directly on the internet, `req.ip` or the remote socket address is usually enough. Once a reverse proxy sits in front of it, the socket address becomes the proxy's address. The original client address is normally carried in headers such as `X-Forwarded-For` or the standardized `Forwarded` header. Those headers are useful only if the application knows which proxy hops are trustworthy.

The failure mode is sharp: if the app trusts every `X-Forwarded-For` value, any client can forge its own source IP. If it trusts none of them, all users collapse into one proxy address and rate limits become both unfair and ineffective.

## The Header Chain Model

`X-Forwarded-For` is usually a comma-separated chain. A request that travels through a browser, CDN, edge proxy, and internal application proxy might arrive with a value shaped like:

```text
203.0.113.45, 198.51.100.10, 10.0.0.12
```

The leftmost address is typically the original client. Each proxy appends the address it saw from its immediate peer. But that convention is not self-authenticating. A malicious client can send:

```text
X-Forwarded-For: 1.2.3.4
```

If the first trusted proxy merely appends to the existing header, the application might see:

```text
1.2.3.4, 203.0.113.45, 198.51.100.10
```

The application must therefore reason from the right side of the chain, starting with the socket peer. It should peel off addresses only while each hop is in a trusted proxy set. The first untrusted address to the left is the likely client.

This is the behavior Express documents for its `trust proxy` setting: when enabled with a subnet, hop count, or custom function, Express uses `proxy-addr` to determine `req.ip` from the forwarded chain. The exact setting matters. `true` trusts the leftmost header value, which is only safe when the last trusted proxy overwrites incoming `X-Forwarded-*` headers. A specific subnet or proxy list is safer for most deployments.

## Express and Rate-Limit Warnings

The `express-rate-limit` package intentionally warns when it sees an `X-Forwarded-For` header while Express `trust proxy` is disabled. The reason is not cosmetic. In that state, Express ignores the forwarded chain and uses the proxy socket address as `req.ip`. Every client behind the same gateway can share a single limiter bucket.

The warning is also a useful design signal: forwarded headers exist, but the app has not declared which upstreams it trusts. The fix should not be to blindly set `app.set("trust proxy", true)` in code. That may silence the warning while creating a spoofing bug.

A better pattern is:

```js
app.set("trust proxy", config.proxy.trust ?? "loopback");
```

Then deployments can provide the real trust boundary:

```json
{
  "proxy": {
    "trust": ["loopback", "198.51.100.0/24"]
  }
}
```

This keeps the application default conservative while allowing each environment to describe its actual upstream proxy chain.

## Caddy and Nginx Responsibilities

Reverse proxies differ in how they handle forwarded headers.

Caddy's `reverse_proxy` directive passes through and augments `X-Forwarded-For`, `X-Forwarded-Proto`, and related headers. Caddy can also be configured with global `trusted_proxies`, which controls when it should trust incoming forwarded headers from its own upstreams. In multi-hop deployments, Caddy and the app should agree on the same trust boundary: Caddy should not propagate spoofed headers from arbitrary clients, and the app should trust only the Caddy or gateway hops that are actually in front of it.

Nginx's `ngx_http_realip_module` has the same conceptual split. `set_real_ip_from` defines trusted addresses, `real_ip_header` selects the header, and `real_ip_recursive on` lets Nginx walk the chain to find the last non-trusted address. This is useful when Nginx itself needs the real client IP for access logs or rate limits before the request reaches the app.

The consistent pattern across both systems: proxy trust is a deployment topology fact. It should be configured where the topology is known, not baked into portable application code.

## Security Properties to Preserve

### Do not trust arbitrary forwarded headers

Any public client can send `X-Forwarded-For`, `X-Real-IP`, or `Forwarded`. The app should ignore those values unless the socket peer is a trusted proxy. At the edge, proxies should overwrite or sanitize incoming forwarded headers from untrusted clients.

### Prefer explicit proxy sets over hop counts

Express supports numeric hop counts, but hop counts are brittle when traffic can arrive through multiple paths. If one route has two proxies and another has three, a numeric setting can pick the wrong address. Use explicit CIDRs or named presets such as loopback where possible.

### Keep defaults local and conservative

For local development, trusting loopback is often enough. For production, trust should be supplied by config. Avoid shipping a broad default such as `true`, `0.0.0.0/0`, or a provider's entire published IP list unless that provider is genuinely the immediate upstream and header overwrite behavior is verified.

### Test the real chain

Unit tests should model the production chain:

```text
X-Forwarded-For: client, trusted-edge
socket peer: loopback app gateway
expected app IP: client
```

Also test spoof attempts:

```text
X-Forwarded-For: forged, real-client, trusted-edge
socket peer: untrusted address
expected app IP: socket peer
```

The goal is to prove both that legitimate clients are separated into different rate-limit buckets and that forged headers are not accepted from untrusted peers.

## Operational Checklist

For each agent web surface behind a proxy chain:

1. Document the immediate upstream proxy hops for that deployment.
2. Configure the edge proxy to overwrite or sanitize forwarded headers from public clients.
3. Configure intermediate proxies with explicit trusted upstreams where applicable.
4. Configure the application framework to trust only the final known proxy hops.
5. Run a live request through the public URL and confirm the app-derived client IP is the original client, not the proxy.
6. Trigger a rate-limit-protected route from two distinct client addresses and confirm buckets do not collapse.
7. Send a forged `X-Forwarded-For` header from an untrusted path and confirm it is ignored.
8. Keep trusted proxy IP ranges in deployment config, not source defaults.

## The Agent-Specific Twist

AI agent platforms often generate web surfaces dynamically: preview servers, document viewers, shared artifact links, callback endpoints, and admin consoles may appear across different hosts. That makes hardcoded proxy assumptions especially fragile. One artifact server might be direct behind a local gateway; another might be tunneled through a team edge; a third might sit behind a CDN.

The practical architecture is to give every web surface the same application-level capability, such as `proxy.trust`, while letting deployment automation fill it with the correct value for that surface. This preserves portability without sacrificing attribution correctness.

## Conclusion

Forwarded client IP headers are not identity. They are claims carried through infrastructure. A web app can use them safely only when it knows which infrastructure hops are allowed to make those claims.

For agent systems, correct proxy trust is a baseline reliability and security requirement. It prevents false rate-limit sharing, preserves useful incident logs, and closes a common spoofing path. The safest design keeps application defaults conservative, puts environment-specific proxy ranges in config, and tests the full chain the same way real users reach the service.

---

*Sources: [Express behind proxies](https://expressjs.com/en/guide/behind-proxies/), [express-rate-limit error codes](https://express-rate-limit.mintlify.app/reference/error-codes), [Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), [Caddy global options](https://caddyserver.com/docs/caddyfile/options), [Nginx real IP module](https://nginx.org/en/docs/http/ngx_http_realip_module.html), [MDN X-Forwarded-For](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Forwarded-For), [RFC 7239 Forwarded](https://www.rfc-editor.org/rfc/rfc7239).*
