---
date: "2026-06-12"
title: "HTTP Content Negotiation Pitfalls in Agent Proxy Layers — Why curl Passes but Browsers Fail"
description: "A deep dive into the header-stripping bug class that silently breaks browser clients when proxies built on fetch-based HTTP clients sit between browsers and CDN-fronted origins."
tags:
  - http
  - proxy
  - agent-infrastructure
  - debugging
  - content-encoding
  - networking
---

## Executive Summary

A class of bugs in reverse-proxy and API-gateway code is uniquely dangerous because it is systematically invisible to the most common form of API verification — a curl command. The failure mode is this: a proxy built on a modern fetch-based HTTP client (Node.js undici, node-fetch, browser Fetch API) sits between browser clients and an upstream origin. The fetch client auto-decompresses gzip or brotli responses — correct behavior for a browser context — but leaves the `Content-Encoding` response header intact on the outbound reply to the downstream browser. The browser receives a plaintext body accompanied by a header asserting the body is still compressed. It attempts to decompress, finds nothing recognizable, and throws `ERR_CONTENT_DECODING_FAILED`. The detail page shows only default empty values. The product appears broken.

The verification gap is the cruelest part: a developer runs `curl http://api/endpoint`, sees a valid JSON response, and concludes the upstream is fine and the proxy is fine. The curl request succeeded because curl does not send an `Accept-Encoding` header by default. The upstream — often behind Cloudflare or another CDN that compresses opportunistically — saw no compression request and returned a plain body with no `Content-Encoding` header. The proxy forwarded it unchanged. The bug was present the entire time, dormant until a real browser made the request.

This article traces the full anatomy of this failure, from the RFC-level semantics of hop-by-hop and end-to-end headers through the decompression behavior of five HTTP client libraries, the role of CDN-forced compression in activating latent bugs, and the systematic verification gap that makes the bug class hard to find in testing. It then generalizes to a family of related proxy-layer content-negotiation pitfalls — SSE buffering, `Content-Length` mismatch, `Vary`/`ETag` invalidation, range request incompatibility, and HTTP/2 connection-header prohibition — before closing with a concrete checklist for building correct proxy layers over fetch-based clients.

The underlying design principle that emerges: when a proxy's HTTP client performs any transformation on the body (decompression, transcoding, buffering), the proxy must audit and repair every header whose value was made false by that transformation. Headers are contracts; a proxy that mutates the body but not the metadata that describes it ships a contradiction.

## The Incident: FleetProxy and the Cloudflare Activation Event

An agent fleet dashboard uses a proxy architecture sometimes called the FleetProxy pattern: the browser connects to a local dashboard server, which in turn proxies HTTP requests to individual remote agent instances. This indirection is common — it resolves CORS issues, adds authentication, and lets the dashboard server fan-out requests across a heterogeneous fleet without exposing each agent's origin URL to the browser client.

The proxy was written in Node.js and used `undici` `fetch()` to call upstream agents. An early pass over security and correctness had produced a `stripHopByHop()` function that removed the standard set of connection-management headers from both incoming requests and outgoing responses before forwarding: `Connection`, `Keep-Alive`, `Transfer-Encoding`, `TE`, `Trailer`, `Upgrade`, and `Proxy-*` variants. This list is correct and standard.

The fleet ran a mix of agent implementations. Most were served directly from bare Node.js or Caddy processes with no compression. One agent was migrated behind Cloudflare. Cloudflare, when it detects that the downstream client sends `Accept-Encoding: gzip, deflate, br` — which the undici `fetch()` inside the proxy does, automatically — begins compressing responses on behalf of the origin. The origin itself need not serve gzip; Cloudflare compresses transparently.

From that point, the proxy behavior changed in a way the original author never anticipated:

1. The browser sends a request to the dashboard proxy.
2. The proxy's `fetch()` call to the agent adds `Accept-Encoding: br, gzip, deflate` automatically.
3. Cloudflare compresses the origin's JSON response, sets `Content-Encoding: gzip`, and returns it to the proxy.
4. undici's `fetch()` auto-decompresses the body. The `Response.body` stream is now plaintext JSON.
5. The proxy's `stripHopByHop()` function does not touch `Content-Encoding` — it is not a hop-by-hop header by RFC definition.
6. The proxy forwards the plaintext body with `Content-Encoding: gzip` intact.
7. The browser receives plaintext JSON, sees `Content-Encoding: gzip`, attempts to gunzip, fails, and throws `ERR_CONTENT_DECODING_FAILED`.

The second agent on plain Caddy (no compression) never triggered the bug. All existing curl-based integration tests passed. The difference: `curl` does not negotiate compression, so Cloudflare never compressed for those test requests, and the bug's activation condition was never met.

The fix required two changes. First, add `content-encoding` to the response-side strip list — because the proxy's fetch client had already decoded the body, the header was a lie. Second, add `accept-encoding` to the request-side strip list — by blocking the proxy's client from advertising compression support, the proxy becomes a transparent byte-forwarding layer with deterministic decompression behavior: none. The upstream controls whether to compress; the proxy does not intervene. A regression test using a local gzip-encoding fixture confirmed the fix and prevents recurrence.

## RFC Semantics: Hop-by-hop vs End-to-end Headers

Understanding why `Content-Encoding` is not in the standard strip list requires a brief tour of HTTP header classification.

[RFC 9110](https://www.rfc-editor.org/rfc/rfc9110), the current HTTP semantics standard, defines two categories. **End-to-end headers** are intended for the ultimate recipient and must be forwarded by proxies. **Hop-by-hop headers** are meaningful only for the immediate connection and must not be forwarded.

Crucially, RFC 9110 modernized this mechanism away from the static enumerated list in the old [RFC 2616](https://www.rfc-editor.org/rfc/rfc2616). The list is now dynamic: any header name listed in a `Connection` header becomes hop-by-hop for that connection and must be stripped. [Section 7.6.1](https://www.rfc-editor.org/rfc/rfc9110#section-7.6.1) states:

> "Intermediaries MUST parse a received Connection header field before a message is forwarded and, for each connection-option in this field, remove any header or trailer field(s) from the message with the same name as the connection-option, and then remove the Connection header field itself."

Beyond the dynamic `Connection` mechanism, RFC 9110 also calls out five headers that proxies SHOULD remove regardless of whether they appear in `Connection`: `Keep-Alive`, `TE`, `Transfer-Encoding`, `Upgrade`, and `Proxy-Connection`. `Transfer-Encoding` handling in proxies is further addressed in [RFC 9112](https://www.rfc-editor.org/rfc/rfc9112) (HTTP/1.1 message syntax), which requires removal before forwarding over a different protocol version.

`Content-Encoding`, by contrast, is explicitly classified as end-to-end in [RFC 9110 Section 8.4](https://www.rfc-editor.org/rfc/rfc9110#section-8.4):

> "Unlike Transfer-Encoding, the codings listed in Content-Encoding are a characteristic of the representation; the representation is defined in terms of the coded form, and all other metadata about the representation is about the coded form unless otherwise noted."

The spec envisions no proxy stripping of `Content-Encoding` — because in the spec's mental model, a proxy forwards bits unchanged. The spec does not contemplate a proxy whose HTTP client decodes the body as a side-effect of reading it. When a proxy actually processes the body — for security inspection, logging, or because a fetch API decoded it automatically — the proxy is no longer just forwarding; it is transforming. And transformed bodies require updated metadata.

The practical rule for fetch-based proxies therefore diverges from the spec-driven hop-by-hop list. Proxies must additionally strip any header that was made factually incorrect by what their HTTP client did to the body. `Content-Encoding: gzip` is a lie when the body has already been decompressed. `Content-Length: 4096` is a lie when the body expanded to 18 KB during decompression. Forwarding lies produces broken clients.

## Auto-Decompression Behavior Across HTTP Clients

HTTP client libraries diverge significantly in whether they strip the headers they invalidate after decompressing a response. Understanding these behaviors is essential for any developer building a proxy.

### Node.js undici / Web Fetch API

[undici](https://undici.nodejs.org/) is the HTTP client underpinning Node.js's built-in `fetch()`. When the response carries `Content-Encoding: gzip`, `x-gzip`, `deflate`, `br` (brotli), or `zstd`, undici's fetch path decompresses automatically. The body stream is plaintext by the time the caller reads it. However, the `Content-Encoding` header is not removed from the `Response.headers` object. This is the source of the bug class.

The issue was filed as [nodejs/undici#2514](https://github.com/nodejs/undici/issues/2514) with the precise framing: "Headers are proclaiming that the body is compressed, but the body is decompressed! When proxying this response back to a client without adapting the headers, this means the body stream will be longer than the content-length header proclaimed, and an invalid HTTP message is sent." Maintainers declined to fix it in the core `fetch()` path because the [WHATWG Fetch specification](https://fetch.spec.whatwg.org/) — written for browsers, not proxies — does not require removal. The argument: `fetch()` is a browser API; proxying is out of scope. A separate opt-in `DecompressInterceptor` added in [PR #4317](https://github.com/nodejs/undici/pull/4317) (2025) does strip both `content-encoding` and `content-length` after decompression, but it is not part of the default `fetch()` path.

On the request side, undici's `fetch()` automatically adds `Accept-Encoding: br, gzip, deflate` for HTTPS connections and `Accept-Encoding: gzip, deflate` for HTTP connections. When a `Range` header is present, it downgrades to `Accept-Encoding: identity`. This automatic negotiation is what triggers CDN compression in the first place.

The same issue has surfaced independently in framework-level proxying code: [sveltejs/kit#12197](https://github.com/sveltejs/kit/issues/12197), [nuxt/nuxt#33598](https://github.com/nuxt/nuxt/issues/33598), and [chimurai/http-proxy-middleware#691](https://github.com/chimurai/http-proxy-middleware/issues/691) all document `ERR_CONTENT_DECODING_FAILED` in proxy scenarios tracing back to the same root cause.

### Go net/http Transport

Go's `http.Transport` represents the opposite design decision — and the correct one. The [`DisableCompression`](https://pkg.go.dev/net/http#Transport) field controls whether Transport adds `Accept-Encoding: gzip` to outgoing requests that lack an explicit encoding preference. When Transport adds the header itself and receives a gzip response, it decompresses transparently and, crucially, removes the now-false headers:

```go
if rc.addedGzip && ascii.EqualFold(resp.Header.Get("Content-Encoding"), "gzip") {
    resp.Body = &gzipReader{body: body}
    resp.Header.Del("Content-Encoding")
    resp.Header.Del("Content-Length")
    resp.ContentLength = -1
    resp.Uncompressed = true
}
```

The key invariant Go maintains: it only strips headers when it was the one that triggered compression in the first place (`addedGzip` flag). If the caller manually set `Accept-Encoding`, Transport assumes the caller wants raw bytes and does not interfere. This makes the behavior deterministic and composable. A Go-based proxy that pipes `Transport.RoundTrip` output directly to the downstream client without reading the body will forward compressed bytes with correct `Content-Encoding` headers, because Transport never decoded it. A proxy that does read the body will find it already decoded only if Transport set `addedGzip`, in which case the headers were already cleaned up.

### Python requests and httpx

Python's [requests](https://requests.readthedocs.io/) library decompresses gzip, deflate, and brotli automatically and removes the `Content-Encoding` header from `response.headers` after decoding. The `.content` attribute always returns decoded bytes. This matches the correct behavior: the header is stripped because the decoding happened. [httpx](https://www.python-httpx.org/) follows the same pattern, controlled by the `headers` property of `Response` which reflects post-decoding state.

### axios (Node.js / Browser)

[axios](https://axios-http.com/) in Node.js uses the built-in `http`/`https` modules, which auto-decompress. axios does not explicitly manage `Content-Encoding` on the response object; the Node.js core handles decompression before axios sees the body. In a proxy scenario using axios to fetch upstream and then piping to a response, developers must similarly audit and strip the encoding headers manually.

## CDN-Fronted Origins and the Compression Activation Event

Many developers test against origin servers directly and only encounter this bug class after placing a CDN in front of the origin. [Cloudflare](https://developers.cloudflare.com/speed/optimization/content/compression/) is the most common activator.

Cloudflare supports three compression formats to downstream clients: gzip, brotli, and zstd. When the downstream client's request includes an appropriate `Accept-Encoding` header, Cloudflare compresses the response if the origin did not already compress it. The origin can be serving entirely uncompressed JSON; Cloudflare will transparently compress on its behalf. Any feature that causes Cloudflare to process the response body — Automatic HTTPS Rewrites, Email Obfuscation, Polish image optimization, Rocket Loader, Cloudflare Fonts — forces a full decompress-then-recompress cycle before the response reaches the downstream.

Cloudflare advertises only `br, gzip` to upstream origins (not `zstd`), so origin-side compression is either brotli or gzip. Pass-through of origin-compressed content is the default when no body-modifying feature is active, but this is a fragile assumption: enabling a single Cloudflare feature changes the entire response pipeline.

The implication for the FleetProxy bug: the bug was dormant for months because neither the test suite nor the second agent triggered CDN compression. Moving one agent behind Cloudflare made Cloudflare's auto-compression visible to the proxy's `Accept-Encoding` advertisement, which activated the latent header inconsistency.

Operators can suppress Cloudflare compression with `Cache-Control: no-transform` on origin responses, but this is a workaround rather than a proxy fix. The proxy layer must be correct regardless of what intermediate infrastructure does.

## The Verification Gap: Why curl Systematically Misses This

This is the most operationally significant finding. The bug is invisible to the most common API verification tool not by accident but by systematic design.

[curl](https://curl.se/) does not send an `Accept-Encoding` header by default. From the official [libcurl documentation for `CURLOPT_ACCEPT_ENCODING`](https://curl.se/libcurl/c/CURLOPT_ACCEPT_ENCODING.html):

> "Set CURLOPT_ACCEPT_ENCODING to NULL to explicitly disable it, which makes libcurl not send an Accept-Encoding: header and not decompress received contents automatically."

The default is `NULL`. Compression negotiation is opt-in via `--compressed`. This design is deliberate: curl is a developer inspection tool and raw byte transfer utility; it should not silently transform response bodies without explicit instruction. But it creates a fundamental mismatch with browser behavior.

Every browser — Chrome, Firefox, Safari, Edge — sends `Accept-Encoding: gzip, deflate, br, zstd` (or a subset) on every HTTP request. The Fetch API inherits this behavior. The verification gap is therefore structural: a developer testing an API with curl tests a code path where CDN compression is never activated. The bug only manifests when a browser or fetch-based client makes the request.

The gap extends to other verification patterns:

- **HTTP client libraries with compression off by default**: Go with `DisableCompression: true`, Python's `requests.get(url, headers={"Accept-Encoding": "identity"})`.
- **Postman without "Send no-cache header" / without automatic encoding**: varies by version and settings.
- **Integration tests that use `fetch()` directly against the origin** (bypassing the proxy): these test the origin's response, not the proxy's transformation.
- **Health checks and synthetic monitoring** that hit endpoint URLs directly and check for HTTP 200: a 200 with a broken body still passes a status check.

Only one class of test reliably catches this: tests that send traffic through the full proxy stack using a client that sends `Accept-Encoding` as browsers do, and that verify response body decodability. In practice, this means either Playwright/Puppeteer end-to-end tests that load real pages through the proxy, or integration tests that explicitly include `Accept-Encoding: gzip, deflate, br` in requests and then verify the response body can be decoded.

The broader engineering lesson: the verification tool must reproduce the header behavior of the production client. Any proxy or header-modifying middleware should have its test suite include at least one request path that exercises the full content negotiation pipeline.

## Related Pitfalls in the Same Bug Class

The content-encoding mismatch is one instance of a general failure mode: a proxy that mutates the body or the transport but does not update the descriptive metadata. Several related pitfalls share the same root cause.

### SSE and Compression/Buffering

Server-Sent Events rely on a persistent HTTP connection where the server sends a stream of newline-delimited events. Two proxy behaviors break SSE silently:

**Compression**: SSE responses must not be compressed. Compression is inherently buffering — a compressor cannot emit output until it has accumulated enough input to fill a compression block, or the connection closes. A proxy that requests compressed upstream responses (`Accept-Encoding: gzip`) and decompresses before forwarding will buffer events rather than streaming them. From the browser's perspective, the event stream hangs. The fix is identical to the content-encoding fix: strip `Accept-Encoding` from SSE upstream requests.

**Proxy buffering**: Many reverse proxies (nginx, Apache, CDNs) buffer response bodies before forwarding. For SSE, this causes events to accumulate until the buffer flushes. nginx's [`proxy_buffering`](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering) must be set to `off` for SSE routes, or the upstream can set the `X-Accel-Buffering: no` response header to signal nginx to disable buffering for that response. A proxy that forwards upstream headers without stripping `X-Accel-Buffering` must ensure the downstream nginx also sees and respects it.

### Content-Length Mismatch After Decompression

A proxy that decompresses the body but forwards the original `Content-Length` sends the client a stream that is longer than the declared length. Behavior varies: some clients truncate the read at `Content-Length` bytes (losing data), some flag a protocol error, some (particularly HTTP/1.1 with keep-alive) corrupt the connection framing because the next response starts arriving mid-body-read. The fix is to either strip `Content-Length` (forcing chunked transfer encoding) or recalculate it after decompression. Stripping is simpler and correct.

### ETag and Vary Header Interactions

Content negotiation is supposed to be transparent to caches: the [WHATWG Fetch specification](https://fetch.spec.whatwg.org/) and [RFC 9110 Section 12.5.5](https://www.rfc-editor.org/rfc/rfc9110#section-12.5.5) define `Vary: Accept-Encoding` as the mechanism by which caches store separate representations for compressed and uncompressed responses. A proxy that decompresses and forwards without stripping `Vary: Accept-Encoding` tells downstream caches that the response varies by encoding — but the proxy has made the response encoding-invariant. Downstream caches will store multiple copies that are actually identical, wasting storage, or will fail cache hits because the browser's `Accept-Encoding` doesn't match the recorded vary key.

`ETag` values computed over compressed bytes are different from ETags over uncompressed bytes. A conditional request (`If-None-Match`) sent by a browser after receiving a decompressed response (with an ETag computed over compressed bytes by the origin) will fail to match, causing the origin to return a full 200 instead of a 304, defeating caching entirely.

### Range Requests and Compression Incompatibility

[RFC 9110](https://www.rfc-editor.org/rfc/rfc9110#section-15.3.7) notes that byte ranges are defined over the content-encoded representation, not the decoded bytes. A proxy that decompresses a range response and forwards it with `Content-Range` intact has shifted the byte offsets. Browsers requesting ranges for media playback or resumable downloads will misinterpret where they are in the stream. CDNs generally refuse to serve compressed responses to range requests precisely because of this incompatibility — undici's `fetch()` handles this correctly by downgrading to `Accept-Encoding: identity` when a `Range` header is present.

### HTTP/2 Connection-Specific Header Prohibition

[RFC 9113](https://www.rfc-editor.org/rfc/rfc9113#section-8.2.2) (HTTP/2) prohibits the use of connection-specific headers in HTTP/2 frames. Sending `Connection`, `Keep-Alive`, `Transfer-Encoding`, or `Upgrade` headers over an HTTP/2 connection is a protocol error; endpoints MUST treat it as a stream error of type `PROTOCOL_ERROR`. A proxy that correctly strips these headers for HTTP/1.1 connections but fails to strip them when the downstream or upstream connection upgrades to HTTP/2 will produce cryptic protocol errors. The strip list must be applied regardless of protocol version.

## Recommendations: A Correct Proxy Header Policy for Fetch-Based Clients

The following is a practical checklist for building proxy layers on top of Node.js `fetch()` (undici) or any fetch-based HTTP client.

**Request-side strip list (before forwarding to upstream):**

- Standard hop-by-hop: `connection`, `keep-alive`, `te`, `trailer`, `transfer-encoding`, `upgrade`, `proxy-authenticate`, `proxy-authorization`, `proxy-connection`
- `accept-encoding` — strip this to prevent the proxy's fetch client from triggering compression it may not correctly demux. Let the upstream decide whether to compress based on its own negotiation with the proxy. This makes the proxy's decompression behavior deterministic: none.

**Response-side strip list (before forwarding to downstream browser):**

- Standard hop-by-hop: same list as above
- `content-encoding` — strip because the fetch client already decoded the body; the header is now false
- `content-length` — strip because the decoded body length differs from the compressed length; let the downstream receive chunked transfer encoding instead

**Alternative: byte-pipe instead of fetch**

If the proxy does not need to inspect or transform the response body, avoid using `fetch()` at all. Use a raw TCP/HTTP pipe (`http.request` with `res.pipe(proxyRes)` in Node.js, or a streaming proxy like [http-proxy](https://github.com/http-party/node-http-proxy)) that forwards bytes without decoding. In this architecture, `Content-Encoding` passes through unchanged and remains correct. Hop-by-hop headers must still be stripped, but the encoding-mismatch problem does not arise because no decoding occurs.

**Regression test: gzip upstream fixture**

Add an integration test that:

1. Starts a local HTTP server that serves a known JSON body compressed with gzip and with `Content-Encoding: gzip` set.
2. Sends a request through the full proxy stack with `Accept-Encoding: gzip` in the request headers.
3. Asserts that the proxy response body is valid, decodable JSON (i.e., the body is NOT double-gzipped or otherwise corrupt).
4. Asserts that the proxy response does NOT include `Content-Encoding: gzip` (because it decoded it).

This test will fail before the fix and pass after. Run it in CI on every change to request/response header handling code.

**Browser-level verification as a release gate**

For any change to proxy or middleware code that touches headers, require at least one Playwright or Puppeteer test that loads a real page through the proxy and verifies that dynamically loaded API data renders correctly. curl-only verification is insufficient for this class of change. A synthetic check that fetches the page URL with `Accept-Encoding: gzip, deflate, br` and verifies the response body is well-formed JSON (not a decompression failure) is a lighter-weight alternative.

**CDN deployment checklist**

When moving any upstream behind a CDN or enabling a CDN feature (Polish, Rocket Loader, Email Obfuscation, Cloudflare Fonts, etc.):

- Verify that the proxy's request-side `accept-encoding` stripping is in place.
- Run the gzip upstream fixture test against the CDN-fronted origin.
- Perform a browser smoke test through the full proxy → CDN → origin stack before completing the migration.

**SSE-specific additions**

- For SSE routes, explicitly set `Accept-Encoding: identity` on the upstream request (or rely on request-side stripping to prevent compression negotiation).
- Confirm that `proxy_buffering off` (nginx) or equivalent is set for SSE routes.
- Do not strip `X-Accel-Buffering: no` from upstream responses if the downstream also uses nginx.

## Conclusion

The FleetProxy content-encoding incident is a clean case study in how a correct-by-spec design decision — `Content-Encoding` is an end-to-end header and should not be stripped by intermediaries — produces incorrect behavior when the proxy's HTTP client decompresses the body as a side effect of reading it. The RFC's assumption is that proxies forward bits; modern fetch-based HTTP clients violate that assumption silently and by design.

The verification gap makes this bug class particularly costly. Engineers who test APIs with curl and see correct responses have genuine, reproducible evidence that the upstream works — and completely correct evidence, from curl's perspective. The bug lives in the mismatch between curl's no-encoding-negotiation default and the browser's always-on `Accept-Encoding` advertisement. Closing this gap requires tests that reproduce browser-class header behavior, routed through the full proxy stack.

The fix pattern — strip `content-encoding` from responses and `accept-encoding` from requests at the proxy boundary — is simple once the root cause is understood. The difficulty is understanding that the fetch client's auto-decompression creates an obligation the spec does not: every header that was made false by the client's behavior must be corrected before the response is forwarded. Go's `http.Transport` gets this right. undici's `fetch()` does not, by deliberate spec-compliance choice. Proxy authors building on undici must compensate in their header filter.

The broader principle: headers are contracts between the sender and the receiver. A proxy that breaks the body-to-metadata correspondence is not a transparent intermediary; it is a source of corruption. Treating the header strip list not as a static RFC-derived constant but as a dynamic function of what the proxy's HTTP client actually did to the body is the mental model that prevents this class of bugs.

---

*Sources: [RFC 9110 — HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110), [RFC 9112 — HTTP/1.1](https://www.rfc-editor.org/rfc/rfc9112), [RFC 9113 — HTTP/2](https://www.rfc-editor.org/rfc/rfc9113), [undici documentation](https://undici.nodejs.org/), [nodejs/undici#2514](https://github.com/nodejs/undici/issues/2514), [nodejs/undici PR#4317](https://github.com/nodejs/undici/pull/4317), [sveltejs/kit#12197](https://github.com/sveltejs/kit/issues/12197), [nuxt/nuxt#33598](https://github.com/nuxt/nuxt/issues/33598), [chimurai/http-proxy-middleware#691](https://github.com/chimurai/http-proxy-middleware/issues/691), [Go net/http Transport — DisableCompression](https://pkg.go.dev/net/http#Transport), [libcurl CURLOPT_ACCEPT_ENCODING](https://curl.se/libcurl/c/CURLOPT_ACCEPT_ENCODING.html), [everything.curl.dev — Compression](https://everything.curl.dev/http/response/compressed), [Cloudflare Compression documentation](https://developers.cloudflare.com/speed/optimization/content/compression/), [nginx proxy_buffering](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering), [MDN — Content-Encoding](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Encoding), [WHATWG Fetch specification](https://fetch.spec.whatwg.org/)*
