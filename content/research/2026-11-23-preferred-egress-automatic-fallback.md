---
date: "2026-11-23"
title: "Preferred Exit, Automatic Fallback — Health Checks, Flap Control and Fail-Closed Egress for Always-On Agents"
description: "How to route an always-on agent host through a preferred self-hosted egress and fall back to a commercial proxy pool automatically, without flapping and without silently leaking to a forbidden region or a direct connection, with notes on what mihomo, sing-box, Envoy, HAProxy and VRRP actually do."
tags: ["networking", "proxy", "reliability", "agent-infrastructure", "failover"]
---

## Executive Summary

An always-on agent host makes outbound calls all day: model APIs, package registries, web fetches, webhooks. Often those calls must leave from a particular region, because of provider terms, data-residency rules or simply because some endpoints only work from there. A common setup is a small self-hosted exit (a cheap box or VPN endpoint in the chosen region) as the preferred path, with a commercial proxy pool as the backup. The goal is simple: use the preferred exit when it works, switch to the pool when it does not, switch back when it is healthy again, and never send traffic anywhere that is not on the approved list.

Each part of that sentence hides a design problem. This article works through them using the official documentation of mihomo (Clash.Meta), sing-box, Envoy, HAProxy, keepalived and RFC 5798, plus a read of the current mihomo group source code. Where documentation is silent, we say so.

Main findings:

- **Proxy-client "fallback" groups are preemptive and nearly stateless.** In mihomo, a `fallback` group walks its `proxies` list in order and uses the first node whose most recent probe succeeded. In the source we read, a node's alive flag is overwritten by every probe, with no consecutive-failure or consecutive-success counter. One failed probe moves traffic away from the preferred exit, and one good probe moves it back. Flap control is therefore mostly your job.
- **Load balancers have the missing pieces.** HAProxy has `rise`/`fall` counters, separate check intervals while a server is in transition, and an explicit `backup` role. VRRP and keepalived have a preempt switch and a preempt delay. Envoy has ejection times that grow with repeated failures. These are good vocabulary for designing a flap-resistant egress policy even when your client lacks the knobs.
- **A passing health check proves little.** A probe URL reachable through a node proves the node forwards traffic to that one URL at that moment. It does not prove your real destinations accept that exit IP, nor that long streaming connections survive.
- **Fail-closed has to be designed in, not assumed.** The mihomo group code falls back to the first listed node when none is alive (a failed connection, not a leak), but an empty group defaults to a direct-type `COMPATIBLE` outbound. The leak paths are in what you did not think of: empty or filtered-down groups, a DIRECT rule, DNS, and applications that ignore proxy settings.
- **One controller per decision.** If a client group and an external watchdog both try to choose the active node, they will fight. Give each its own domain, and verify the actual exit IP independently of both.

## The Shape of the Problem

Picture the topology: agent processes on one host send all outbound traffic into a local proxy client. The client chooses one of several exits:

1. **Preferred exit.** A small self-hosted proxy in the chosen region. Cheap, predictable IP, fully under your control, but a single machine on a single network link.
2. **Fallback pool.** A commercial provider's nodes, restricted to the same approved region (or to a short list of approved regions). Many nodes, run by someone else, and churning.
3. **Nothing else.** In particular, no direct connection and no node in an unapproved region.

The failure modes are asymmetric. The preferred exit is more likely to have a total outage (one box, one link). The pool is more likely to have partial and noisy degradation. A direct connection is almost always "working", which is exactly why it is dangerous: any controller that optimises for "is the internet reachable" will happily choose it.

## How Proxy Clients Implement Failover

### mihomo (Clash.Meta) proxy groups

The mihomo wiki lists the group types Select, Url-Test, Fallback, Load-Balance and Relay. The common health-check fields on the proxy-groups page are:

- `url`: the health-check address (the examples use a `generate_204` URL). The docs note it checks only the group's own `proxies` field, not proxies pulled in through `use` providers.
- `interval`: if not 0, periodic testing is on, in seconds.
- `timeout`: health-check timeout in milliseconds.
- `lazy`: defaults to `true`; if the group is not currently selected, no testing is performed.
- `max-failed-times`: maximum failures before a forced health check, default 5.
- `expected-status`: a node counts as available only when the status code matches; the default is `*` (anything). Syntax uses `/` between values and `-` for ranges, for example `200/302` or `400-503`.

The three automatic types differ in how they choose:

- **`fallback`**: "If the current node times out, the first available node will be selected in the order of proxies." Order is priority. This is the natural fit for "preferred exit, then backups".
- **`url-test`**: picks by measured latency. `tolerance` is documented as the switch tolerance in milliseconds. The wiki page is thin on the rule, but the source (see below) shows it is a hysteresis band.
- **`load-balance`**: spreads connections; strategies are `round-robin`, `consistent-hashing` (same target address to the same node) and `sticky-sessions` (same source and target to the same node, cached for 10 minutes per the docs). Wrong shape for "preferred exit", and it deliberately mixes your egress IPs.

Reading the Go source of the `Meta` branch (behaviour may change between versions, so treat this as an observation, not a contract):

- `Fallback.findAliveProxy` iterates the members in order and returns the first for which `AliveForTestUrl` is true. If none is alive it returns `proxies[0]`, the first member. It re-evaluates on each use, so the moment the preferred node's last probe is good again, new connections go back to it. That is preemptive failback with no hold-down.
- A node's alive flag is set in `URLTest` from the outcome of that single probe. There is a history queue of ten records, but the alive decision is the latest result only.
- The `url-test` selection keeps the current node unless it is dead, or another node's last delay is lower by more than `tolerance`. That is real hysteresis, but on latency, not on failures.
- Dial failures feed `max-failed-times`: repeated dial failures within the test timeout trigger an immediate extra health check, and a "connection refused" triggers one at once. This accelerates detection of a dead node but does not add smoothing.
- `empty-fallback` (default `COMPATIBLE`) is the outbound used when a group ends up with no members. In the source `COMPATIBLE` is constructed as a Direct adapter. A group whose `filter` matches nothing, for example after a provider update drops the approved nodes, can therefore quietly become a direct connection unless you override `empty-fallback`. The wiki says the field accepts a proxy name, not a group. Pointing it at the built-in `REJECT` should fail closed, but verify that on your build.

### sing-box

sing-box has two relevant outbound types:

- **`urltest`** with `outbounds`, `url` (default `https://www.gstatic.com/generate_204`), `interval` (default `3m`), `tolerance` (default `50` ms), `idle_timeout` (default `30m`) and `interrupt_exist_connections`.
- **`selector`** with `outbounds`, `default` (the first outbound if empty) and `interrupt_exist_connections`. The docs say it "can only be controlled through the Clash API currently".

`interrupt_exist_connections` is documented as "Interrupt existing connections when the selected outbound has changed", applying to inbound connections only; internal connections are always interrupted. The example sets it to `false`. The docs we read describe no ordered-priority `fallback` type. To get "preferred first" in sing-box you would use a selector driven by an external controller, or a `urltest` whose tolerance is wide enough that the preferred node usually wins. Check the version you run.

### Envoy

Envoy is an L7 proxy rather than a client-side egress tool, but its model is the most complete:

- **Active health checking** supports HTTP (a 200 is expected by default, other codes configurable), gRPC, L3/L4 (connect-only, or send-and-expect-echo), Redis and Thrift. Thresholds for failures-before-unhealthy and successes-before-healthy are configurable.
- **Passive health checking** is outlier detection. Hosts returning consecutive 5xx are ejected, inline. The ejection time is the base ejection time multiplied by the number of consecutive ejections, so repeat offenders stay out longer, capped by `max_ejection_time`. The multiplier decreases when the host is healthy at a check. The docs call out `max_ejection_percent` so that a bad signal cannot eject the whole cluster.
- The docs recommend a long active-check interval when outlier detection is also in use, to avoid check traffic.
- **Panic threshold.** By default (50%), when too few hosts are healthy, Envoy ignores health status and balances across all hosts. This is a deliberate fail-open. The docs state it can be disabled by setting the threshold to 0%, after which an all-unhealthy cluster returns "503 - no healthy upstream". That is the fail-closed choice.

### HAProxy

HAProxy's `server ... backup` is the closest direct match to "preferred exit, then fallback". The configuration manual says a backup server "is only used in load balancing when all other non-backup servers are unavailable" and, by default, only the first operational backup server is used unless `option allbackups` is set.

Its health-check parameters are the cleanest statement of rise/fall semantics:

- `fall <count>`: server considered dead after that many consecutive failed checks, default 3.
- `rise <count>`: considered operational after that many consecutive successes, default 2.
- `inter`: default 2000 ms; `fastinter` applies while a server is transitioning ("going down" or "going up") or unchecked; `downinter` applies while fully down.
- `on-marked-down shutdown-sessions`: terminate all connections to a server the moment it is marked down. The manual gives the use case of a stuck database where waiting for timeouts would make the service unresponsive.
- `on-marked-up shutdown-backup-sessions`: when a primary recovers, kill sessions on backup servers to force traffic back. The manual warns that doing so "can cause more trouble than it tries to solve", for example incomplete transactions.

The last two are worth remembering. Both "kill in-flight connections on state change" options are opt-in and carry a warning.

## What a Health Check Actually Proves

Most egress health checks are "fetch a tiny URL through the node and compare the status". The usual probe is a `generate_204`-style endpoint: a server that returns an empty HTTP 204. Captive-portal detection uses the same idea: a plain 204 means no interception, while a 200 or 302 suggests something in the path is rewriting responses.

That tells you:

- The client can reach the node, authenticate and complete its protocol handshake.
- The node can resolve and reach the probe host.
- If the probe is HTTPS, the tunnel plus TLS works to that host.

It does **not** tell you:

- **Your real destinations accept the exit IP.** Geo-blocks, IP reputation, per-IP rate limits and anti-abuse systems operate per destination. A probe host owned by a large CDN is tolerant of almost everything.
- **Sustained throughput and long-flow health.** A 204 takes milliseconds. A streaming response can run minutes.
- **DNS and routing for other protocols.** A TCP probe says nothing about UDP or QUIC.

Practical consequences:

1. **Probe through the exit, not at the exit host.** A TCP ping or ICMP to the exit's address proves the box is up. It says nothing about whether it forwards. mihomo and sing-box probes already go through the node; in a custom watchdog, send the probe through the local proxy port while that node is selected.
2. **Tighten `expected-status`.** mihomo's default `*` accepts any status, so an interception page returning 200 or 302 counts as alive. For a 204 endpoint, set it to `204`. For an authenticated API, an unauthenticated request returning a known status such as 401 is a useful, free, "real destination" probe; choose `expected-status` accordingly (illustrative; check what your provider returns).
3. **Use a destination-representative probe, plus a generic one.** One check against a neutral endpoint answers "is the node alive"; one against a real dependency answers "can I still do my job from this exit". Do not let the second drive failover alone, since the dependency can be down for reasons unrelated to the exit.
4. **Prefer HTTPS probes** so an in-path device cannot answer for the destination.
5. **Keep intervals proportionate.** Short intervals make the failure signal faster but noisier, and on a commercial pool they generate probe traffic for every node. Envoy's docs even recommend a long active interval when passive detection is in use.

## Flapping Control

Failover has two thresholds: when to leave the preferred path and when to return. Flapping happens when either is too eager, or when the signal is noisy near the boundary.

The vocabulary from the sources:

- **Consecutive-failure and consecutive-success counts.** HAProxy's `fall` (3) and `rise` (2) defaults are asymmetric: it takes more evidence to declare a server dead than alive by default. For an egress that affects every in-progress request, consider the opposite: leave quickly on clear failure, return slowly.
- **Transitional check speed.** `fastinter` shortens the interval while a server is on the edge, so decisions during uncertainty are made with more samples.
- **Hold-down and preempt delay.** keepalived's `preempt_delay` is documented as seconds after startup (newer man pages also say after seeing a lower-priority master) before preemption, range 0 to 1000, and requires the initial state to be BACKUP. `nopreempt` lets the lower-priority node keep the master role even when a higher-priority node returns. keepalived's `vrrp_script` also has its own `rise` and `fall`.
- **Growing penalty for repeat offenders.** Envoy's ejection time multiplies with each consecutive ejection and decays after healthy checks.
- **Latency hysteresis.** mihomo `url-test` `tolerance` and sing-box `urltest` `tolerance` (default 50 ms) stop two near-equal nodes trading places.

### Preemptive versus non-preemptive failback

RFC 5798 (VRRP version 3) is explicit that this is a policy choice. `Preempt_Mode` "controls whether a (starting or restarting) higher-priority Backup router preempts a lower-priority Master router", with True as the default. The one exception: the address owner (priority 255) always preempts. The RFC also notes that "it may be useful to support an override of the immediate convergence to the preferred path." Note that RFC 5798 is marked obsoleted by RFC 9568; the preemption concept is unchanged in what we read, but check the newer text for details. VRRP also shows how to take failure detection time seriously: a backup declares the master down after `Master_Down_Interval = (3 * Master_Adver_Interval) + Skew_Time`, which is about three advertisement intervals plus a small priority-dependent skew.

For an agent host the trade-off looks like this:

- **Preemptive** (mihomo `fallback` default): traffic returns to the preferred exit as soon as it probes alive. The exit identity is predictable, and you stop paying for the pool. Risk: a box that is up for ten seconds out of every minute will cause constant switching, and every switch is a mid-session IP change for stateful destinations.
- **Non-preemptive**: stay on the pool until the next natural break (a maintenance window, a manual action, or a long period of clean checks). Stable and boring. Risk: you may sit on the fallback for days without noticing, which is why the observability section below insists on alerting.

A reasonable middle: leave the preferred exit after several consecutive failures, and return only after it has been continuously healthy for a hold-down period much longer than the check interval. If your client cannot express that natively (mihomo cannot, as far as we can tell), implement it outside, as described in the watchdog section.

One more warning from the mihomo source: pinning a node on a `fallback` group through the API sets a `selected` value that is cleared the first time the pinned node is found dead, after which the group is back to preemptive ordering. Do not read a manual pin as "non-preemptive for good".

## Fail-Closed Versus Fail-Open

The most important property is the one a naive failover system does not have: **when everything approved is down, the answer is "fail", not "go somewhere else".**

### Make the allowlist structural

- **Fallback only inside an approved set.** Build the fallback group from nodes filtered to the allowed region. mihomo provides `filter` and `exclude-filter` (regular expressions on node names) for provider-sourced and `include-all-proxies` nodes. Because the filter is a name match, a provider renaming nodes can silently change membership. Monitor group membership, not just the active node.
- **No DIRECT in the proxy path.** Do not list DIRECT in any group the agent traffic uses. Keep a separate, explicit rule for local-network destinations, and reviewed as a security decision.
- **Choose what an empty group does.** In mihomo override `empty-fallback`. The default is a direct-type adapter.
- **Choose what "all down" does.** mihomo's `fallback` returns the first member when none is alive: connections fail through the preferred exit rather than leak. Envoy's panic mode is the opposite: by default it ignores health and uses all hosts; set it to 0% for fail-closed. HAProxy returns a 503 when no server is available.
- **Do not trust "the proxy is configured" at the application layer.** Environment-variable proxy settings are honoured only by programs that read them. If the property matters, add a host firewall rule that drops outbound traffic from the agent's user except to the local proxy port (and any intentionally allowed LAN ranges), so a direct connection cannot succeed even by mistake. That is a design suggestion, not something the proxy docs provide.
- **Mind DNS.** Resolving names outside the proxy path can reveal destinations to the local network and can return region-specific answers. How DNS is handled depends on your client's mode; check it explicitly rather than assuming.

### Verify the actual exit continuously

Configuration says what should happen; only a live check says what did.

- On a schedule, and after every switch, send a request through the same local proxy port the agents use to an endpoint that echoes the caller's IP or country, and compare to the approved set. For the preferred exit you know the IP. For a commercial pool, node IPs change, so compare country or network (ASN), not just the address, and remember that geolocation databases disagree at the edges.
- Alert on mismatch, and take the stricter action: stop the agent's outbound traffic (or reject at the group) until corrected. An alert alone leaves the leak open.
- Test the checker itself. Periodically feed it a known-bad answer and confirm it raises the alarm.

## In-Flight Connections at Switch Time

A proxy client chooses the outbound when a connection is established. What happens to connections already open depends on the client:

- **mihomo.** The group code we read has no connection-interrupt hook. Connections stay on the outbound chosen at dial time. The external controller can list and close connections (`GET`/`DELETE /connections`, `DELETE /connections/:id`), so you can implement "drain" or "reset" yourself. We did not find an interrupt-on-switch setting in the general-settings page.
- **sing-box.** `interrupt_exist_connections` controls it, default shown as `false`.
- **HAProxy.** Opt-in via `on-marked-down shutdown-sessions` and `on-marked-up shutdown-backup-sessions`, with the manual's warnings about the second.

That gives these cases for an agent:

1. **Preferred exit dies while a streaming LLM response, SSE feed or WebSocket is open.** The flow breaks when the exit stops forwarding (a reset, or a stall until a timeout). The new path only helps new connections. Application-level timeouts, keep-alives and retries are what really handle this, so set them deliberately rather than relying on the proxy.
2. **Preferred exit recovers.** New connections move back; old ones stay on the fallback until they close. That is usually right: it is a natural drain. Killing sessions to "force" return (HAProxy's own manual advises caution) trades an orderly drain for dropped work.
3. **Region-bound sessions.** If a destination ties a session to the source IP, a mid-session switch may log you out or trigger a security check. This is another reason to prefer slow, deliberate failback and few switches.

### Idempotency and retries

When a connection dies mid-request, the client does not know whether the server applied it. RFC 9110 section 9.2.2 defines idempotent methods (PUT, DELETE and safe methods) and says a client "SHOULD NOT automatically retry a request with a non-idempotent method unless it has some means to know that the request semantics are actually idempotent" or can detect the original was not applied. A proxy "MUST NOT automatically retry non-idempotent requests."

For an agent whose tools make POSTs (create a ticket, send a message, trigger a deploy):

- Use **idempotency keys** where the API supports them. Stripe's API documents the pattern: the server saves the status code and body of the first request made with a key and returns the saved response on retries (keys up to 255 characters, prunable after at least 24 hours in API v1).
- For **SSE**, the WHATWG spec has a reconnection mechanism: the client reconnects after a delay, and sends the `Last-Event-ID` header if it has one. Servers may tune the delay with `retry`. Only works if the server implements resume.
- For **streaming LLM calls**, which generally cannot be resumed mid-stream, retrying means a fresh request with new cost. Count retries per task so a flapping exit does not burn budget unnoticed.
- Keep **retry budgets** and jittered backoff at the tool layer, so a switch event does not trigger a synchronized retry storm.

## Observability

A silent fallback is worse than a loud outage: you discover it only when the pool gets rate-limited or the bill arrives. Required signals:

- **Which exit is active now.** mihomo's controller returns the current selection as `now` on a group (`GET /proxies/<name>`); the same API supports group delay tests, connection lists, and WebSocket streams for `/logs` and `/traffic`. Poll `now` yourself and export it as a gauge, with a label for "preferred" or "fallback".
- **Switch events.** Log each change with timestamp, from, to, and the probe results that triggered it. A change counter plus a "seconds since last switch" gauge shows flapping immediately. The count over a day is the best flap metric.
- **Time on fallback.** The alert that matters most is "running on fallback for longer than N". Choose N from the cost of the fallback path (rate limits, price, quality), not from the check interval. Keep it separate from the "preferred exit is down" alert: the second may page, the first is often a ticket.
- **Verified egress.** Export the result of the egress IP and country check as its own metric.
- **Probe health.** Failure rate, latency per node, and the timestamp of the last successful probe. A probe loop that has silently stopped looks like perfect health.
- **Controller liveness.** Alert if the proxy client or the watchdog stops reporting. Silence is not good news.

Do the same exercise the AWS Builders' Library recommends for fallback in general: it argues that fallback code paths run only in a crisis are hard to test and tend to carry latent bugs, and that you should exercise them regularly in production. For egress: regularly stop the preferred exit on purpose, or run a small fraction of non-critical traffic through the pool continuously, so you know the fallback path is credentialed, un-throttled and in the right region.

## External Watchdog Versus Client Groups

Many deployments add a small script or systemd timer beside the proxy client that polls health, re-selects among allowed nodes, and enforces an invariant. That helps, but two controllers writing to the same state cause oscillation. Typical failure: the group's own health check moves to node B, the watchdog sees B is not its favourite and moves back to A, and every cycle resets the other.

Principles:

1. **One writer per decision.** Either the client group decides and the watchdog only reads and alerts, or the group is a plain `select` and the watchdog is the sole decision-maker. A hybrid is fine if the domains are disjoint: for example, a `fallback` group chooses between "preferred exit" and "pool", while the watchdog only chooses which allowed node the pool selector points to.
2. **The watchdog enforces invariants, not preferences.** Its first duty is "the active exit is inside the allowlist and passes the egress check". If it cannot find a legal node, it does nothing except alert, or blocks traffic. It never picks something illegal to restore connectivity.
3. **Give the watchdog hysteresis too.** Keep counters on disk: consecutive failures before switching, a minimum dwell time after any switch, a limit on switches per hour. Without them it reimplements the flapping problem.
4. **Make runs non-overlapping and observable.** With a systemd timer, `OnBootSec=` plus `OnUnitActiveSec=` gives a recurring interval. Remember `AccuracySec` defaults to one minute, so set it lower if timing matters, and take a lock inside the service so a slow run cannot overlap the next one. Write every decision to the journal.
5. **Mind what the API write means.** On mihomo, selecting a node on a `select` group is a durable choice; on a `fallback` or `url-test` group, we saw in the source that a selection is a "fixed" override that auto-clears under some conditions (and the group-delay endpoint is documented to clear a fixed selection on automatic groups). Know which kind you are writing to.
6. **Do not let a node-list refresh reset the policy.** Provider updates can add nodes, rename them or empty a filter. Validate the allowlist after each refresh.

## Illustrative Configuration

The sketch below uses only keys documented on the mihomo wiki pages cited above. It is **illustrative**: node names, the region filter and numbers are placeholders, `REJECT` as an `empty-fallback` target should be verified on your build, and nested-group liveness (how a group listed inside a `fallback` group is probed) is something we did not verify, so test it.

```yaml
proxy-groups:
  - name: pool-approved-region        # approved-region commercial nodes only
    type: url-test
    use: [commercial-provider]        # provider defined elsewhere; per the docs this group's url
                                      # checks only its own `proxies`, so give the provider its own
                                      # health-check settings too
    filter: "(?i)<approved-region-pattern>"
    url: "https://<neutral-probe-host>/generate_204"
    expected-status: 204              # do not accept portal/intercept pages
    interval: 120
    timeout: 5000
    tolerance: 100
    empty-fallback: REJECT            # never fall through to a direct-type outbound

  - name: egress
    type: fallback                    # order is priority: preferred first
    proxies: [preferred-exit, pool-approved-region]
    url: "https://<neutral-probe-host>/generate_204"
    expected-status: 204
    interval: 60
    timeout: 5000
    empty-fallback: REJECT

rules:
  - MATCH,egress                      # no DIRECT in the agent path
```

Remember this gives preemptive failback with no counters; hold-down and the egress-IP check belong in the watchdog described above.

## Practical Checklist for Agent Hosts

1. Decide the allowed set (preferred exit plus approved region nodes) as an explicit allowlist, written down.
2. Structure it as an ordered group: preferred exit first, then an approved-region pool group. No DIRECT in this path; set the empty-group behaviour to reject.
3. Probe through the exit with HTTPS and a strict expected status (for example 204), at an interval you can justify. Add one destination-representative probe for diagnostics.
4. Decide the failback policy explicitly: preemptive with a hold-down, or non-preemptive. If your client cannot hold down, implement it in a watchdog with consecutive-success counts and a dwell time.
5. Block direct egress at the host firewall for the agent user, so proxy misconfiguration cannot leak.
6. Verify the real exit continuously (IP/country/network against the allowlist), and treat mismatch as a stop condition.
7. Do not kill in-flight connections on switch by default; let them drain. Handle broken flows with application timeouts and retry budgets.
8. Make retried writes idempotent (keys, preconditions), and cap retries per task.
9. Export the active exit, switch count, time on fallback and verified-egress result; alert on fallback duration separately from preferred-exit-down.
10. Keep one controller per decision, and write down which one it is.
11. Rehearse: take the preferred exit down on purpose on a schedule, and confirm the switch, the egress check, the alert, and the return all behave as designed.

## Sources

- mihomo wiki, proxy groups (common fields, health check, expected-status, empty-fallback): https://wiki.metacubex.one/en/config/proxy-groups/
- mihomo wiki, fallback group: https://wiki.metacubex.one/en/config/proxy-groups/fallback/
- mihomo wiki, url-test group: https://wiki.metacubex.one/en/config/proxy-groups/url-test/
- mihomo wiki, load-balance group: https://wiki.metacubex.one/en/config/proxy-groups/load-balance/
- mihomo wiki, general settings: https://wiki.metacubex.one/en/config/general/
- mihomo wiki, external controller API: https://wiki.metacubex.one/en/api/
- mihomo source (`adapter/outboundgroup/fallback.go`, `urltest.go`, `groupbase.go`, `parser.go`; `adapter/adapter.go`; `adapter/outbound/direct.go`), Meta branch as read on 2026-11-23: https://github.com/MetaCubeX/mihomo
- sing-box urltest outbound: https://sing-box.sagernet.org/configuration/outbound/urltest/
- sing-box selector outbound: https://sing-box.sagernet.org/configuration/outbound/selector/
- Envoy outlier detection: https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/outlier
- Envoy health checking: https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/health_checking
- Envoy panic threshold: https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/panic_threshold
- HAProxy 3.0 configuration manual (server `backup`, `rise`, `fall`, `inter`, `on-marked-down`, `on-marked-up`): https://docs.haproxy.org/3.0/configuration.html
- RFC 5798, Virtual Router Redundancy Protocol version 3 (obsoleted by RFC 9568): https://www.rfc-editor.org/rfc/rfc5798
- keepalived.conf(5) (`nopreempt`, `preempt_delay`, `vrrp_script`): https://linux.die.net/man/5/keepalived.conf and https://www.mankier.com/5/keepalived.conf
- RFC 9110, HTTP Semantics, section 9.2.2 Idempotent Methods: https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2
- Stripe API, idempotent requests: https://docs.stripe.com/api/idempotent_requests
- WHATWG HTML Standard, server-sent events: https://html.spec.whatwg.org/multipage/server-sent-events.html
- Amazon Builders' Library, Avoiding fallback in distributed systems: https://builder.aws.com/content/3EuS9Sakq7L3VLQIF3qzfMfke1Y/avoiding-fallback-in-distributed-systems
- systemd.timer(5): https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html
- Background on `generate_204` captive-portal probes (secondary sources, not official Android docs): https://www.purple.ai/en-us/blogs/captive-portal-detection and https://en.wikipedia.org/wiki/Captive_portal
