---
date: "2026-09-20"
time: "09:11"
title: "Proxy Boundaries for Persistent Agents: Configuration, Routing, and Verifiable Egress"
description: "Why proxy environment variables express client intent rather than network policy, and how persistent agents can separate configuration, traffic capture, and egress enforcement."
tags: ["ai-agents", "networking", "proxy", "egress", "reliability", "security"]
---

## Executive Summary

Setting `HTTP_PROXY` does not place an agent behind a network boundary. It asks compatible clients to use a proxy, and different clients interpret that request differently. A persistent agent may also run across service managers, containers, subprocesses, browsers, and native tools, each with its own configuration lifetime and bypass rules.

The useful design separates three concerns: **application selection** decides whether a client cooperates with proxy settings, **traffic capture** decides which flows reach a proxy, and **egress enforcement** decides whether any other route remains possible. Reliability then depends on verifying the running process and its observed connections, not merely reading back a configuration file.

## “Use the proxy” is three different promises

Proxy discussions often collapse three independent mechanisms into one phrase:

| Layer | Mechanism | What it can establish | What it cannot establish alone |
|---|---|---|---|
| Application selection | Client option, dispatcher, or proxy environment variables | A cooperating client intends to send selected requests through a proxy | That every client, protocol, DNS query, or subprocess follows the same route |
| Traffic capture | Redirect, transparent proxy, policy routing, or TUN interface | Selected packets are intercepted below the application | That uncaptured protocols have no alternate route |
| Egress enforcement | Firewall, network namespace with constrained routing, or equivalent network policy | Direct destinations are unreachable except through allowed paths | That the proxy route itself is correctly configured or healthy |

These layers can be combined. Explicit application configuration is valuable because it records intent and produces understandable failures. Network-layer enforcement is valuable when bypass would violate a security or residency requirement. Treating either one as a substitute for the other produces misleading health reports.

Linux transparent proxying illustrates the distinction. The kernel's TPROXY documentation describes interception, packet marking, and policy routing, plus application support for transparent sockets. That is a capture mechanism, not a universal declaration that every packet on a host has been captured. The rule set, address families, protocols, interfaces, and route exceptions still define the actual boundary. [Linux TPROXY documentation](https://docs.kernel.org/networking/tproxy.html)

## Environment variables are a family of client contracts

There is no single cross-runtime contract for proxy environment variables. Even widely used clients differ at the first decision point:

- **curl** accepts lowercase `http_proxy` but deliberately rejects uppercase `HTTP_PROXY`, because CGI gateways can create `HTTP_PROXY` from an inbound `Proxy` header. Other scheme variables can be uppercase. curl also supports `ALL_PROXY`, while a scheme-specific value takes precedence. [curl proxy environment variables](https://everything.curl.dev/usingcurl/proxies/env.html)
- **Python `urllib`** scans proxy variables case-insensitively, prefers lowercase when both forms exist, and ignores uppercase `HTTP_PROXY` when `REQUEST_METHOD` indicates CGI. [Python `urllib.request`](https://docs.python.org/3/library/urllib.request.html#urllib.request.getproxies)
- **Go `x/net/http/httpproxy`** checks lowercase before uppercase, detects CGI through `REQUEST_METHOD`, and refuses the HTTP proxy value in that context. Its proxy function also bypasses `localhost` and loopback addresses as a special case. [Go `httpproxy` source](https://github.com/golang/net/blob/master/http/httpproxy/proxy.go)
- **Recent Node.js releases** provide built-in proxy support, currently marked Active Development, through the opt-in `--use-env-proxy` flag or `NODE_USE_ENV_PROXY=1`. The CLI flag is documented for Node 22.21.0 and 24.5.0 onward. When enabled, Node reads `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` during startup. Code using a different dispatcher or library may have a separate contract. [Node.js CLI documentation](https://nodejs.org/api/cli.html#--use-env-proxy)

The differences extend into `NO_PROXY`: implementations disagree about domain suffixes, ports, CIDR notation, wildcards, IPv6 syntax, and implicit loopback behavior. Docker's documentation explicitly notes that no standard defines this variable's exact format. A portable design should therefore maintain tested fixtures for every client family it actually runs, rather than publish one supposedly universal bypass string. [Docker client proxy configuration](https://docs.docker.com/engine/cli/proxy/)

This matters more for agents than for a single command-line program. An agent can call a Node SDK, spawn curl, invoke a Python helper, and open a browser in one task. A shared environment block may look consistent while those four paths make different routing decisions.

## Configuration has a lifecycle

The same text can exist in several configuration planes without reaching the process that performs the request:

| Plane | Typical consumer | When a change becomes effective | Evidence worth collecting |
|---|---|---|---|
| Interactive shell | Commands launched from that shell | Immediately for future children | Shell environment only |
| Service unit or supervisor | Processes launched by the manager | On a new process start, after any required manager reload | Effective unit definition and new process identity |
| Live process | Current runtime and its children | Fixed when the process starts, unless the application has its own dynamic configuration | Environment and command line of the actual network-making process |
| Docker daemon | Image pulls and registry access by the daemon | After daemon configuration takes effect and the daemon restarts | Daemon's effective environment/configuration |
| Docker container | Application inside the container | On container creation | Container configuration and in-container process state |
| Image build | Build steps | Per build invocation | Build arguments and observed build traffic |

This yields two common false positives. First, exporting a variable and observing curl succeed proves only the interactive shell path. Second, reloading a service manager proves that it reread definitions; it does not retroactively rewrite the environment of an already-running process.

Docker makes another split explicit. Daemon proxy settings affect the daemon. Client proxy settings in `~/.docker/config.json` populate variables and build arguments for **new** containers and builds; they do not change existing containers. Docker also warns against storing proxy credentials in image `ENV` instructions because those values become embedded in image metadata. [Docker daemon proxy configuration](https://docs.docker.com/engine/daemon/proxy/), [Docker client proxy configuration](https://docs.docker.com/engine/cli/proxy/)

For system services, `Environment=` and `EnvironmentFile=` provide configuration, but systemd warns that environment variables are not suitable for secrets. A better operational shape is a credential-free local proxy endpoint, with upstream authentication held by a narrowly scoped proxy service or credential mechanism. That avoids copying a password into every agent, child process, diagnostic dump, and container inspection result. [systemd.exec source](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml), [systemd credentials](https://systemd.io/CREDENTIALS/)

## DNS and non-HTTP traffic cross a separate boundary

An HTTP proxy normally receives an origin hostname in an absolute request target or a `CONNECT` request. A SOCKS proxy has different semantics. SOCKS5 can carry either an IP address or a domain name supplied by the client, so resolution can happen on the proxy side. The protocol also defines a UDP association, but client support is a separate matter. [RFC 1928](https://www.rfc-editor.org/rfc/rfc1928.html)

Chromium provides a concrete example of why the client matters: for SOCKS5 it resolves target hostnames on the proxy side, but uses that proxy only for TCP-based URL requests and does not relay UDP through it. A browser configured with SOCKS5 can therefore have different coverage from a generic SOCKS5-capable application. [Chromium proxy documentation](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md)

TUN and transparent modes can capture traffic without application cooperation, but they do not eliminate policy questions. DNS may be sent to a local stub, a private resolver, or a public resolver; private control-plane destinations may need direct routing; UDP and QUIC may follow different rules from TCP; and the proxy itself needs a route that does not loop back into its own capture path.

A useful design starts from traffic classes, not one global toggle:

- public upstream APIs that must use a controlled exit;
- private service discovery and control-plane traffic that must remain private;
- local loopback and proxy-management traffic that must not be recaptured;
- DNS queries, including which resolver is authoritative for each namespace;
- UDP-based protocols whose behavior differs from ordinary HTTP over TCP.

Each class needs an owner, a selected path, a fallback rule, and an observable test. `NO_PROXY` is only one application's expression of that policy; it is not the policy itself.

## A verification ladder for a persistent agent

A trustworthy acceptance test moves from declared intent to observed behavior. Every lower step can be green while a higher step is broken.

1. **Declared configuration:** read back the effective service, container, and application settings. Mask credentials. Detect conflicting upper- and lowercase values rather than assuming they are equivalent.
2. **Live process state:** identify the process that actually opens the connection, and confirm it started after the configuration change. Checking only the supervisor or parent process is insufficient when a worker or browser makes the request.
3. **Observed route:** correlate a real request with a connection to the proxy and, where available, a proxy-side rule or connection record. A successful HTTP response alone cannot distinguish proxied success from direct success.
4. **Real upstream behavior:** use the agent's actual client stack for a minimal upstream operation. An ad hoc curl check can validate reachability while missing the runtime that is broken.
5. **Restart persistence:** create a new process or container and repeat the route and upstream checks. This is where shell-only exports and stale supervisors are exposed.
6. **Positive controls:** deliberately point a canary at a dead proxy and require a visible failure. When testing the application-selection layer by itself, remove its proxy setting and require the observed route or exit identity to change. Do not expect that mutation to change the route when transparent capture is intentionally active beneath the application; test that layer by temporarily applying a safe, isolated rule mutation instead. These known-bad mutations prove that the checks can fail. If a canary still succeeds through an unapproved direct path, the system is fail-open.

The final status should keep mutation and evidence separate. “Configuration changed” is not “route verified,” and “route verified once” is not “survives restart.” A small status vocabulary such as `unchanged-and-verified`, `changed-and-verified`, `changed-but-unverified`, and `degraded` prevents an automation job from converting skipped checks into a healthy result.

## Design guidance

For a persistent agent, a robust default is:

- configure the primary HTTP client explicitly, so intent is visible in code or service configuration;
- use a local proxy endpoint without embedded credentials;
- define DNS, private-service, loopback, and control-plane routes independently;
- place network-layer enforcement beneath the process when direct egress must be impossible;
- keep per-runtime bypass fixtures and test them after runtime or library upgrades;
- verify the real process, route, upstream call, and restart behavior;
- run known-bad positive controls so a green result has discriminating power.

The central boundary is epistemic as much as technical: configuration describes what should happen, while traffic evidence describes what did happen. Persistent agents need both. Their network path spans more runtimes and survives more restarts than a one-shot command, so a proxy setting should be treated as versioned, testable operational behavior rather than a string copied into an environment file.

## Sources

- [curl proxy environment variables](https://everything.curl.dev/usingcurl/proxies/env.html)
- [Python `urllib.request`](https://docs.python.org/3/library/urllib.request.html)
- [Go `httpproxy` source](https://github.com/golang/net/blob/master/http/httpproxy/proxy.go)
- [Node.js CLI proxy support](https://nodejs.org/api/cli.html#--use-env-proxy)
- [Docker daemon proxy configuration](https://docs.docker.com/engine/daemon/proxy/)
- [Docker client proxy configuration](https://docs.docker.com/engine/cli/proxy/)
- [systemd.exec source](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml)
- [systemd credentials](https://systemd.io/CREDENTIALS/)
- [Linux transparent proxy support](https://docs.kernel.org/networking/tproxy.html)
- [RFC 1928: SOCKS Protocol Version 5](https://www.rfc-editor.org/rfc/rfc1928.html)
- [Chromium proxy documentation](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md)

*Primary documentation and source were checked on 2026-09-20. The three-layer model, verification ladder, status vocabulary, and design recommendations are engineering synthesis rather than guarantees made by any one source.*
