---
date: "2026-09-18"
title: "SSRF-Resistant Agent Fetching: Authorize the Endpoint You Actually Dial"
description: "How URL parsing, DNS rebinding, redirects, TLS identity, and proxies affect destination authorization, with a reproducible local transport experiment."
tags: ["ssrf", "agent-security", "http", "dns", "research"]
---

## Executive Summary

An agent that follows a URL found in a document turns untrusted text into an outbound network request. If its runtime can reach services the author cannot, the fetch tool can become a server-side request forgery (SSRF) bridge.

Checking a hostname before handing the original URL to an ordinary HTTP client is insufficient when the client can resolve it again or follow a redirect without authorization. The useful invariant is: **every attempted destination must be authorized before the connection is made, and every request must be authorized before it is sent.** Keep the logical hostname for HTTP and TLS identity while binding the connection to an approved address.

This research note explains that design boundary and includes a runnable Python experiment. Real local TCP connections demonstrate a preflight-check failure, successful address pinning, and the effect of refusing redirects. The resolver is mocked; TLS, proxies, IPv6, and connection pooling are discussed from documentation, not experimentally verified here. This is an engineering study, not a production fetch library.

## Start with the tool's authority

Consider a document summarizer that fetches a citation. The document author controls the URL and possibly its DNS and HTTP responses. The tool runs with the network reach of its host. An attacker does not need the model to reveal a password if the fetch itself can reach a privileged service.

Two policies are needed. Destination authorization decides where this tool may connect. Data authorization decides which query parameters, headers, or body it may send. A public address can still belong to an attacker; passing a network filter does not authorize sending secrets there.

For a fixed integration, prefer configured destinations and narrow operations. For a general research fetcher, arbitrary public destinations are part of the product, so a finite hostname allowlist may not fit. OWASP distinguishes these cases and recommends disabling automatic redirects to avoid bypassing input validation. Its guidance also covers checking all returned A and AAAA addresses. [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)

The rest of this article proposes a direct-fetch boundary for the second case. A deployment can instead put enforcement in a dedicated egress service; the component that actually opens the destination connection must enforce the address policy.

## Parse once into an explicit request policy

String matching is a poor substitute for URL parsing. The WHATWG IPv4 parser accepts some non-decimal representations, including hexadecimal and octal components; certain validation errors do not make parsing fail. A check for a literal prefix therefore does not necessarily classify the host that a client will use. [WHATWG URL Standard](https://url.spec.whatwg.org/#ipv4-number-parser)

Choose a documented parsing model compatible with the requester. For a small HTTPS research tool, a reasonable application policy is to accept only HTTPS, reject user information, constrain ports, and authorize the normalized host. If HTTP is needed, permit it explicitly. Reject unsupported or ambiguous inputs instead of passing the original string into another parser and hoping both agree. These restrictions are proposed application choices, not universal URL-standard requirements.

Numeric classification also needs a declared policy. Cover loopback, private, link-local, unspecified, multicast, and deployment-specific destinations; do not equate “not RFC 1918” with “safe.” IPv4-mapped IPv6 addresses contain an embedded IPv4 address, so classification must account for that representation. [RFC 4291, section 2.5.5.2](https://www.rfc-editor.org/rfc/rfc4291.html#section-2.5.5.2)

Pin and test the classifier version. Python documents changes to `is_private` and `is_global`, and shared address space is an example where both are false. Those predicates describe library classifications; they do not encode an application's entire network policy. [Python ipaddress documentation](https://docs.python.org/3/library/ipaddress.html)

## Close the gap between DNS validation and connection

The vulnerable sequence is straightforward:

1. Resolve a hostname and approve the answer.
2. Give the original hostname to the HTTP client.
3. Let the client resolve it independently and connect to a different answer.

A DNS cache might hide this failure in a particular run. It does not bind the validation result to the connection. The local experiment below forces the two answers to differ so the mechanism can be observed deterministically.

One implementation strategy is to resolve, validate the returned candidate set, and dial a selected approved numeric address. A conservative mixed-answer policy rejects the whole resolution if any candidate is disallowed. Another strategy can filter candidates or check each actual dial, provided no fallback, retry, or parallel connection attempt can use an unchecked address. “Exactly one DNS lookup forever” is not the security requirement; binding every connection attempt to authorization is.

For HTTPS, retain the original hostname for SNI and certificate verification, plus HTTP `Host` or `:authority`. Replacing the URL hostname with an IP and merely adding a Host header does not by itself preserve TLS verification against the intended name. Libcurl's `CURLOPT_CONNECT_TO` documents this separation: the connection target changes while the TLS and application identities stay associated with the original request. [CURLOPT_CONNECT_TO](https://curl.se/libcurl/c/CURLOPT_CONNECT_TO.html)

Libcurl's `CURLOPT_RESOLVE` supplies DNS-cache entries for host-and-port pairs. It can support pinning, but is not an allowlist for every possible destination: an unrelated redirect target is a different pair. Its normal entries do not expire, while entries prefixed with `+` use ordinary DNS-cache expiry. Policy and cache lifetime therefore need explicit ownership. [CURLOPT_RESOLVE](https://curl.se/libcurl/c/CURLOPT_RESOLVE.html)

## Treat redirects as new requests

The simplest policy is to return the redirect response without following it. If following is required, resolve a relative Location against the current URL, then repeat scheme, authority, port, address, and data authorization before sending the next request. Bound hop count and total elapsed time. An allowed first hop grants no authority to its redirect target.

RFC 9110 describes how automatic redirects replace the target URI, update automatically generated fields, and consider removing caller-supplied sensitive headers. Its normative wording here is SHOULD, not a blanket MUST to strip every credential. An agent tool should define its own stricter credential-forwarding policy where appropriate. Redirect status also matters: 307 and 308 preserve the method; 301 and 302 permit changing POST to GET. A generic fetch capability is easier to constrain when it does not carry ambient credentials or arbitrary request bodies. [RFC 9110, section 15.4](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.4)

## Account for proxies and reused connections

With a forward proxy, the client's socket may terminate at the proxy. A local dial check then authorizes that proxy connection, not necessarily the eventual destination. If a hostname is sent in CONNECT, destination resolution can happen on the proxy side. Enforce target policy there, or use a verified arrangement that requests an approved numeric endpoint while preserving end-to-end TLS identity. CONNECT establishes a tunnel identified by its request target. [RFC 9110, section 9.3.6](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.6)

Proxy behavior is client-specific. Libcurl documents that a differing CONNECT_TO destination switches an HTTP proxy request into tunnel mode. Thus “all proxies defeat pinning” is too broad; what matters is who chooses and connects to the final address. Audit proxy configuration, including environment-derived settings, as part of the deployed request path. [CURLOPT_CONNECT_TO proxy behavior](https://curl.se/libcurl/c/CURLOPT_CONNECT_TO.html)

Connection reuse is also not automatically unsafe. A socket already connected to an approved address does not jump to another address when DNS changes. But a new request can reuse it without invoking a dial hook; Go explicitly documents this possibility for `Transport.DialContext`. Keep request authorization separate from connection authorization, scope pools to compatible identities and policies, and decide how policy changes invalidate old connections. [Go HTTP Transport](https://pkg.go.dev/net/http#Transport)

## Reproduce the transport boundary locally

Save the following code as `transport_probe.py` and run `python3 transport_probe.py` without `-O`, which disables assertions. It uses only the standard library and was run on Linux with Python 3.12.3. It requires two available loopback addresses. Both servers are owned by the test, share an ephemeral port, and close in `finally`.

The fixture policy allows one loopback address and forbids the other. This intentionally differs from a production public-fetch policy, which would normally forbid both. Only fixture hostnames are intercepted by the resolver mock; connections use real sockets. No real DNS server is queried for the fixture names.

The four observed outcomes were:

- Naive preflight: the second resolution reached the forbidden fixture.
- Pinned connection: only the approved fixture received the request, with the original Host header.
- Redirect refused: the allowed server returned 302 and the forbidden server received no HTTP request.
- Positive control: explicitly following the target without authorization reached the forbidden fixture, demonstrating that the sink was reachable.

The redirect check asserts HTTP request counts; it is not a general packet-level proof that no TCP handshake occurred. The code does not implement an authorized redirect-following loop. It also does not test mixed DNS answers, TLS, IPv6, proxy routing, or pool reuse. Those need separate tests before adopting a production client.

```python
"""Local-only transport experiment; NOT a production SSRF client."""
import http.client
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

hits = []
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        hits.append((self.server.server_address[0], self.path, self.headers['Host']))
        if self.path == '/redirect':
            self.send_response(302)
            self.send_header('Location', f'http://blocked.test:{self.server.server_port}/')
            self.end_headers()
        else:
            self.send_response(200)
            self.end_headers()
            self.wfile.write(self.server.server_address[0].encode())
    def log_message(self, *args):
        pass

allowed = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
port = allowed.server_port
blocked = ThreadingHTTPServer(('127.0.0.2', port), Handler)
servers = [allowed, blocked]
for server in servers:
    threading.Thread(target=server.serve_forever, daemon=True).start()
real_resolve = socket.getaddrinfo
calls = []
def changing_resolver(host, service, *args, **kwargs):
    # Numeric addresses retain real socket semantics; only fixture names vary.
    if host == 'fetch.test':
        calls.append(host)
        host = '127.0.0.1' if len(calls) == 1 else '127.0.0.2'
    elif host == 'blocked.test':
        host = '127.0.0.2'
    return real_resolve(host, service, *args, **kwargs)

def request(conn, path='/'):
    try:
        conn.request('GET', path, headers={'Host': f'fetch.test:{port}'})
        response = conn.getresponse()
        return response.status, response.getheader('Location'), response.read()
    finally:
        conn.close()

class Pinned(http.client.HTTPConnection):
    def __init__(self, ip):
        super().__init__('fetch.test', port, timeout=2)
        self.ip = ip
    def connect(self):
        self.sock = socket.create_connection((self.ip, self.port), self.timeout)

try:
    with patch('socket.getaddrinfo', changing_resolver):
        # Deliberately simplified fixture policy: only 127.0.0.1 is permitted.
        vetted = socket.getaddrinfo('fetch.test', port, type=socket.SOCK_STREAM)[0][4][0]
        assert vetted == '127.0.0.1'
        naive = request(http.client.HTTPConnection('fetch.test', port, timeout=2))
        assert naive[2] == b'127.0.0.2' and len(calls) == 2
        print('naive preflight: forbidden fixture reached after second resolution')
        hits.clear(); calls.clear()
        vetted = socket.getaddrinfo('fetch.test', port, type=socket.SOCK_STREAM)[0][4][0]
        pinned = request(Pinned(vetted))
        assert pinned[2] == b'127.0.0.1' and len(calls) == 1
        assert hits == [('127.0.0.1', '/', f'fetch.test:{port}')]
        print('pinned dial: approved fixture only; original Host preserved')
        hits.clear()
        redirect = request(Pinned(vetted), '/redirect')
        assert redirect[0] == 302 and redirect[1] == f'http://blocked.test:{port}/'
        assert len(hits) == 1 and hits[0][0] == '127.0.0.1'
        print('redirect disabled: one allowed request, zero forbidden requests')
        # Positive control: following without reauthorization reaches the sink.
        followed = request(http.client.HTTPConnection('blocked.test', port, timeout=2))
        assert followed[2] == b'127.0.0.2'
        print('unguarded redirect control: forbidden fixture reached')
finally:
    for server in servers:
        server.shutdown(); server.server_close()
```

## Applying the result

For an agent connector, start by tracing every outbound path from tool arguments to socket creation. Select a client or egress service whose resolution, redirects, TLS identity, and proxy behavior can be controlled and tested. Fail closed when the policy cannot authorize a destination; return a clear tool error so the agent does not silently retry through an unrestricted client.

The practical review question is concrete: after approving this request, can a later resolver, redirect handler, retry, proxy, or alternate client choose a destination outside that approval? The local experiment exposes two such transitions. It supplies evidence for those cases, not a claim that a complete agent runtime is SSRF-proof.

*Research provenance: background research used Claude Sonnet 5; its model-usage record also includes a Haiku helper. The final synthesis, source checks, and local transport experiment were completed separately in Codex. Public documentation was checked on 2026-09-18. No production runtime was changed.*
