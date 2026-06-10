---
date: "2026-06-10"
title: "Failure Detection and Liveness for AI Agent Fleets"
description: "Why event-staleness timers falsely mark idle agents offline, and how classical failure detection theory — phi-accrual, SWIM, leases, and connection-based liveness — applies to monitoring fleets of long-running AI agents."
tags: ["ai-agents", "distributed-systems", "failure-detection", "observability", "sse", "monitoring"]
---

## Executive Summary

A fleet observability dashboard migrated remote-agent monitoring from 3-second HTTP polling to SSE push subscriptions — and remote agents started flapping to OFFLINE. The consumer kept a 10-second staleness timer from the polling era, but an idle agent only emits events every 30 seconds, so the timer false-fired for ~20 of every 30 seconds. The incident is a textbook instance of a problem distributed systems has studied for three decades: **silence is ambiguous**. A quiet producer may be healthy-but-idle or dead, and no staleness timer can tell the difference.

This article surveys what the field knows — heartbeat detectors and Chen's adaptive timeouts, the phi-accrual detector used by Cassandra and Akka, SWIM/Lifeguard gossip detection, lease-based liveness in Chubby/ZooKeeper/etcd/Kubernetes, and connection-oriented liveness in gRPC/WebSocket/SSE — and distills six design patterns for AI agent fleets, where agents are *legitimately idle* for minutes or hours. The core rule: **require positive evidence of failure (a closed connection, a failed probe), never the mere absence of success signals.** Liveness, freshness, and state are three independent properties; collapsing them into one traffic light is what produces false-offline flapping.

## The Motivating Incident

The setup: each agent runs a local dashboard process exposing `/api/stream` (SSE). A hub subscribes to every remote agent's stream and renders a fleet wall. Three constants, set independently, collided:

- The producer broadcasts `fleet_state` events **only when something changes**. On an idle agent the only regular trigger is a system-metrics collector ticking every **30 seconds**.
- The producer's SSE hub writes keepalive comments every **15 seconds** — but keepalives carry no events, so the consumer ignored them.
- The consumer marked any record OFFLINE when its last event was older than **10 seconds** — a constant tuned for the old 3-second polling loop, where it could never fire.

Result: an idle remote agent was displayed OFFLINE roughly two-thirds of the time, flipping back on every metrics tick, with stale-but-fresh-looking data still on the tile. Each component was locally reasonable; the *system* was misconfigured. Notably, two rounds of cross-agent code review missed it — the coupling between a producer emission cadence and a consumer timeout lives in no single diff.

## Classical Failure Detection in 5 Minutes

**The impossibility backdrop.** Chandra and Toueg (1996) formalized that in an asynchronous network no detector can be both *complete* (every crash eventually detected) and *accurate* (no false suspicion). Every practical detector picks a point on that trade-off curve.

**Fixed timeouts and Chen's adaptive detector.** A fixed timeout Δ false-fires whenever the network or producer is slower than Δ. Chen, Toueg, and Aguilera (DSN 2000) proposed tracking the observed inter-arrival distribution and setting Δ ≈ mean + k·stddev. The incident's 10s timer against a 30s emission period is a Chen misconfiguration by construction — the timeout sits at one-third of the heartbeat period, guaranteeing false positives.

**Phi-accrual (Hayashibara et al., SRDS 2004).** Rather than a binary verdict, output a continuous suspicion level:

```
φ(t) = -log10( P(heartbeat arrives later than t) )
```

computed from the historical inter-arrival distribution. φ = 1 means ~10% chance the silence is benign; φ = 8 (the default conviction threshold in both Cassandra and Akka) means ~10⁻⁸. Akka sends heartbeats every second and convicts around φ > 8; Cassandra convicts roughly 18 seconds after the last gossip at default settings. The elegance: the *application* chooses how paranoid to be, per use case, from one shared estimator.

**SWIM and Lifeguard.** SWIM (DSN 2002) scales detection by randomized probing: each period, ping one random member; on silence, ask k other members to probe indirectly; only then mark *Suspected* — and conviction follows only if the suspect fails to refute within a timeout. HashiCorp's Lifeguard extensions (used in Consul/Serf/memberlist) add self-awareness: a detector that is itself degraded (CPU-starved, congested) widens its own timeouts before accusing others. Lifeguard reports a 50× reduction in false positives at default settings. The lesson for agent fleets: *suspicion is a state, not a verdict* — and the detector's own health is part of the equation.

## Leases: Liveness as a Renewable Contract

Lease systems make liveness explicit instead of inferred:

- **Chubby** (Burrows, OSDI 2006): clients hold a session lease renewed by KeepAlive RPCs; expiry deletes ephemeral files and releases locks, with a 45-second client-side grace period for reconnection.
- **ZooKeeper**: session timeouts between 2× and 20× tickTime; ephemeral znodes vanish on expiry, notifying watchers — death is an *event*, not a poll result.
- **etcd**: leases with TTL ≥ 5s, renewed at ≥ TTL/3 cadence; expiry atomically deletes attached keys.
- **Kubernetes** (KEP-589): each kubelet renews a dedicated `Lease` object every 10s (lease duration 40s), decoupled from the heavyweight NodeStatus (every 5 minutes). The node controller distinguishes `NotReady` (reachable but reporting unhealthy) from `Unreachable` (no contact) — two different taints with different remediation.

The common thread: the liveness signal is a **dedicated, cheap, regular channel**, deliberately decoupled from the application payload. Kubernetes learned this the hard way — full NodeStatus heartbeats melted etcd at scale, so they split liveness (lease renewal) from state (status updates). An agent fleet that infers liveness from application events is re-coupling what mature systems deliberately separated.

## Connections as Liveness: Powers and Limits

An open SSE/WebSocket/gRPC stream is itself a lease-like liveness signal — but only if someone is writing to it.

- **TCP keepalive is not enough.** Linux defaults probe after 2 hours of idle; NAT gateways and load balancers silently drop flow state much earlier (AWS NLB: 350s; classic ELB: 60s; Azure LB: 4 min). A connection both ends believe is open may be a **half-open** corpse.
- **gRPC** formalizes both layers: HTTP/2 PING keepalives for the transport, and the `grpc.health.v1` service (`Check` unary for pollers, `Watch` streaming for push) for application health. Misconfigured ping rates earn a `GOAWAY too_many_pings` — even probing cadence is negotiated.
- **WebSocket** has protocol-level ping/pong (RFC 6455), but browsers hide it from JavaScript — browser clients needing heartbeat logic must use application-level messages.
- **SSE** uses comment lines (`: keepalive`) every 15–30 seconds. They defeat proxy idle timeouts *and* prove the server can still write the stream. A write failure tears the connection down — which is exactly the positive disconnect signal the consumer should key on.

So the correct semantics for a push consumer: **ONLINE while the connection is established and bytes (including keepalives) keep flowing; OFFLINE on disconnect, HTTP error, or auth failure; and a byte-level idle watchdog at ~3× the keepalive interval to catch half-open connections.** The watchdog watches the *connection*, never the event rate.

## Push vs Pull: Why Prometheus Synthesizes `up`

Prometheus's pull model resolves silence ambiguity structurally: every scrape either succeeds (`up=1` — the target is reachable, silence in the metrics means idle) or fails (`up=0` — positive evidence of unreachability). Staleness is handled with explicit markers — a reserved NaN sample written when a series disappears from a successful scrape — plus a 5-minute lookback fallback.

The Pushgateway documents the inverse failure mode, almost identical to our incident: pushed metrics are immortal, so a dead job's last success values are scraped forever, and `up` reflects the gateway, not the job. Prometheus's own guidance: use push only for batch jobs whose *last run outcome* is the question; long-running services should be pulled or must carry explicit keepalives. An event-driven SSE feed with a consumer staleness timer is the Pushgateway antipattern rebuilt on a socket.

## What Makes AI Agents Different

Traditional services emit continuous signal under load. Autonomous agents don't: a healthy agent may sit idle for hours between scheduled tasks, waiting on a human, or blocked on a long tool call. This makes event-staleness detectors structurally wrong, and it sharpens three requirements:

1. **Multi-layer liveness.** Process alive (PID exists) ≠ session alive (runtime connected, auth valid) ≠ agent productive (tasks completing, token spend within baseline). Connectivity monitoring answers the first two; only behavioral monitoring answers the third. An agent looping on a failed tool call is "alive" on every connectivity metric.
2. **False alarms are expensive.** Alarm-fatigue research quantifies the cry-wolf effect: operators delay or ignore subsequent alerts, and auto-remediation triggered by false offline (restart a healthy agent!) converts noise into real downtime. A monitor that is wrong two-thirds of the time is worse than no monitor — it actively trains operators to distrust the dashboard.
3. **Platforms are converging on the same split.** LangSmith Deployment exposes infra metrics + health endpoints; trace platforms (MLflow, AgentOps, Langfuse) cover behavior. The 2026 pattern is explicitly two-layer: connection-based reachability + behavioral evals. Neither subsumes the other.

## Six Design Patterns

1. **Separate liveness, freshness, and state.** Reachable? (connection) — How old is the data? (timestamp, *displayed*, not alarmed) — What is it doing? (last reported state). Kubernetes encodes this discipline as liveness/readiness/startup probes; a fleet tile should encode it as three independent visuals.
2. **Connection-based liveness with a byte-level watchdog.** Trust the open stream; require keepalive bytes at a known cadence; abort and re-probe after ~3 missed keepalives. Never time out on application events.
3. **Hysteresis on state transitions.** EventSource auto-reconnects in ~3s; a single blip should not flip the wall. Require N consecutive failures or a sustained disconnect before rendering OFFLINE — phi-accrual and SWIM's Suspected state are formalizations of the same instinct.
4. **Announce lifecycle, don't only infer it.** A graceful shutdown should push an explicit `shutdown` event before closing (the ephemeral-znode pattern). Then OFFLINE-expected and OFFLINE-unexpected are distinguishable, and only the latter pages anyone.
5. **Negotiate timing constants across versions.** The incident was a version-skew bug: producer cadence and consumer timeout evolved independently. Either advertise the keepalive interval in-band (header or initial SSE comment) and derive the watchdog from it, or remove the dependency entirely by keying on connection state.
6. **Positive evidence of failure.** "No event in X seconds → OFFLINE" is weak. "Connection closed / probe failed / auth rejected → OFFLINE" is strong. Every mature system in this survey — Prometheus `up=0`, SWIM's failed indirect probes, expired leases, closed streams — convicts on evidence, not silence.

## Closing

The fix for the motivating incident was small: delete the event-staleness timer, mark OFFLINE only on explicit connection or probe failure, and add a 45-second byte-idle watchdog (3× the 15-second keepalive) against half-open connections — the same semantics the single-agent frontend had used, proven, all along. The broader takeaway is that AI agent fleets are rediscovering distributed-systems liveness one incident at a time. The theory is thirty years old and directly applicable; what changes with agents is the prior — idleness is normal, so detectors that punish silence are wrong by default.

## References

- Hayashibara et al., "The φ Accrual Failure Detector" (SRDS 2004); Akka failure detector docs — https://doc.akka.io/libraries/akka-core/current/typed/failure-detector.html
- Cassandra `phi_convict_threshold` deep dive — https://digitalis.io/post/understanding-phi-convict-threshold-in-apache-cassandra-a-deep-dive-into-failure-detection
- Das, Gupta, Mostefaoui, "SWIM" (DSN 2002); explainer — https://www.brianstorti.com/swim/
- HashiCorp Lifeguard — https://www.hashicorp.com/en/blog/making-gossip-more-robust-with-lifeguard / https://arxiv.org/pdf/1707.00788
- Burrows, "The Chubby Lock Service" (OSDI 2006) — https://research.google.com/archive/chubby-osdi06.pdf
- Kubernetes node heartbeats, KEP-589 — https://github.com/kubernetes/enhancements/blob/master/keps/sig-node/589-efficient-node-heartbeats/README.md
- gRPC keepalive and health checking — https://grpc.io/docs/guides/keepalive/ / https://grpc.io/docs/guides/health-checking/
- WebSocket keepalive — https://websockets.readthedocs.io/en/stable/topics/keepalive.html
- SSE keepalive discussion — https://github.com/whatwg/html/issues/7571
- Prometheus staleness — https://www.robustperception.io/staleness-and-promql/ ; Pushgateway pitfalls — https://www.robustperception.io/common-pitfalls-when-using-the-pushgateway/
- AWS long-running TCP connections in VPC — https://aws.amazon.com/blogs/networking-and-content-delivery/implementing-long-running-tcp-connections-within-vpc-networking/
- Agentic AI monitoring — https://predictionguard.com/blog/agentic-ai-monitoring-observability-metrics
