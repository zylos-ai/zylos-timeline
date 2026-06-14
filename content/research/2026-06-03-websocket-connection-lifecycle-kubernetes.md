---
date: "2026-06-03"
title: "WebSocket Connection Lifecycle in Kubernetes: Graceful Deployments for Stateful Real-Time Services"
description: "Production patterns for managing WebSocket connections during K8s pod restarts, rolling updates, and scaling events — connection draining, thundering herd mitigation, and split deployment architectures."
tags: ["kubernetes", "websocket", "graceful-shutdown", "real-time", "deployment"]
---

## Executive Summary

WebSocket connections break Kubernetes' core assumption: that workloads are stateless and request-response. A typical HTTP request lives for milliseconds; a WebSocket connection from a chat client can live for hours. When Kubernetes kills a pod — during a rolling update, a node eviction, or an HPA scale-down — every connection on that pod dies simultaneously unless the application and infrastructure have been explicitly designed to handle it. The resulting behavior is a wall of reconnect attempts, partial message loss, and client error dialogs. For IM and real-time collaboration services, this is not acceptable.

The good news is that the patterns for managing this well are established and battle-tested, even if they require threading together several layers: application-level SIGTERM handling, Kubernetes lifecycle hooks, ingress/load balancer connection draining, client-side reconnect logic, and a pub/sub backplane that decouples message routing from physical connection location. None of these layers alone is sufficient. Getting all of them right together is what separates a service that survives deployments cleanly from one that produces a flood of support tickets every release.

This article covers the full stack of concerns for deploying a WebSocket-heavy service — specifically a pattern like cws-comm (WebSocket + NATS + Redis on GKE) — including graceful shutdown sequencing, connection draining timing, sticky sessions vs. stateless routing trade-offs, thundering herd mitigation, PodDisruptionBudget configuration, health probe design, and the split deployment pattern that reduces connection churn during frequent API updates.

The central thesis: if your pub/sub backplane (NATS, Redis) handles cross-pod message routing, you do not need session affinity and you gain significant operational flexibility. If you rely on affinity, you pay for it with uneven load distribution, fragile autoscaling, and harder deployments. Choose the architecture before you tune the Kubernetes configuration.

---

## The Core Mismatch

Kubernetes models workloads as fungible: pods are interchangeable instances, updated by creating new ones and deleting old ones. Rolling updates work because any new request can go to any healthy pod. WebSocket connections break this: the upgrade handshake, authentication context, and any in-memory subscription state are all bound to a specific TCP connection on a specific pod.

When pod A is terminated during a rolling update, three things happen badly without intervention:

1. Active WebSocket connections are forcefully closed (TCP RST or silent drop depending on the proxy layer).
2. Clients receive either a `1006` (abnormal closure, no close frame) or a `1001` (going away) and start reconnecting.
3. All clients from that pod reconnect simultaneously to the remaining pods, which may themselves be in the middle of updating.

The result is a thundering herd hitting a service that is already under rolling-update churn. This section describes how to stop all three failure modes.

---

## Graceful Shutdown Sequencing

The Kubernetes pod termination sequence is more subtle than it appears. When a pod is evicted, the kubelet simultaneously sends `SIGTERM` to the container and begins removing the pod's endpoint from all Services. The endpoint propagation to kube-proxy, CoreDNS, and the ingress controller is not instantaneous — it can take 5–15 seconds depending on cluster size and endpoint slice controller lag. If the application shuts down immediately on SIGTERM, it will stop accepting connections before the proxy layer has stopped routing to it, producing a brief window of dropped requests.

The standard fix is a `preStop` sleep:

```yaml
lifecycle:
  preStop:
    exec:
      command: ["sleep", "10"]
terminationGracePeriodSeconds: 90
```

The `preStop` hook runs before `SIGTERM` is delivered, buying time for endpoint propagation to complete. With 10 seconds of preStop and a 90-second `terminationGracePeriodSeconds`, the application has 80 seconds after SIGTERM to drain connections before kubelet sends `SIGKILL`.

For a WebSocket server, the application's SIGTERM handler should:

1. **Stop accepting new WebSocket upgrades** — flip a readiness flag to `false` immediately so the readiness probe fails, which stops new traffic being routed in.
2. **Send close frames to active connections** — use WebSocket close code `1012` (Service Restart) which signals clients that reconnection is appropriate and expected.
3. **Wait for the drain window** — allow in-flight messages to complete and connections to close cleanly. 30–60 seconds is typical for chat services.
4. **Shut down the process** — exit cleanly after the drain window.

The close code matters. Code `1012` tells a well-behaved client to reconnect after a delay. Code `1001` (Going Away) is semantically correct but does not carry the "please reconnect" implication. Code `1006` should never appear during a graceful shutdown — it means the TCP connection was terminated without a close frame, which always indicates a configuration gap.

**GKE-specific note:** Google Cloud Load Balancer has its own connection draining timeout, configured through `BackendConfig`. For WebSocket services you need to set `drainingTimeoutSec` to match your application's drain window:

```yaml
apiVersion: cloud.google.com/v1
kind: BackendConfig
metadata:
  name: cws-comm-backend
spec:
  connectionDraining:
    drainingTimeoutSec: 60
```

Without this, GCP's load balancer will close existing connections to a deregistered backend immediately, regardless of what the application is doing.

---

## Session Affinity vs. Stateless Routing

The architectural question that most affects operational complexity is whether your WebSocket tier needs session affinity at all.

**With affinity (sticky sessions):** The ingress pins each client to a specific pod via a cookie or consistent hashing. Messages arrive on the right pod without any cross-pod forwarding. This works, but creates compounding problems: load becomes uneven as connection counts diverge between pods, new pods receive little traffic until old affinities expire, and autoscaling is less effective because adding a pod does not help if existing clients are pinned to older pods. During rolling updates, clients stuck to a terminating pod experience a forced reconnect regardless of how graceful the shutdown is.

**Without affinity (stateless routing with pub/sub):** Each incoming WebSocket connection can land on any pod. When pod A needs to deliver a message to a user whose connection is on pod B, it publishes to NATS or Redis Pub/Sub and pod B fans it out locally. With NATS or Redis Pub/Sub as the backplane, the WebSocket pods are effectively stateless at the routing level. Any pod can handle any reconnecting client.

For a service already using NATS (as in cws-comm), the stateless approach is the right call. The pub/sub backplane is already present; using it for cross-pod message routing removes the need for affinity entirely. The deployment implications are significant: rolling updates become straightforward, autoscaling works correctly, and the thundering herd problem on reconnect is far less severe because reconnecting clients spread across all available pods.

The tradeoff is that you need to ensure subscription state is rebuilt correctly when a client reconnects to a new pod. For NATS, this means re-subscribing to the appropriate subjects on behalf of the client during the reconnect handshake, restoring any per-user state from Redis.

---

## Thundering Herd Mitigation

When a pod with N active connections is terminated, all N clients reconnect within a tight time window. If N is 5,000 and each connection triggers auth, session restore, and NATS subscription setup, the remaining pods and backend services face a sudden spike.

Mitigation operates on two sides:

**Server side (admission control):** Rate-limit WebSocket upgrade requests. A token bucket at 500 upgrades/second per pod lets the system absorb reconnect waves without overwhelming downstream auth services. Kubernetes readiness probes provide a natural backpressure mechanism: if a new pod is still warming up (NATS subscriptions initializing, Redis connection pool building), it should not report ready yet.

**Client side (jitter + backoff):** The reconnect algorithm should add randomized jitter to break synchronization. A common formula:

```
delay = min(cap, base * 2^attempt) * random(0.5, 1.0)
```

With `base=500ms` and `cap=30s`, a client that disconnects will wait a random interval between 250ms and 30s on each attempt, depending on how many failures have accumulated. The critical property is that the jitter multiplier randomizes across the range — not just adding a fixed random offset — so that clients that disconnected at the same moment spread their reconnect attempts over a meaningful time window.

For the server operator, the practical defense is ensuring that `terminationGracePeriodSeconds` is long enough that connections are shut down with proper close frames (code `1012`) rather than via SIGKILL. A client that receives `1012` should apply a brief initial delay before reconnecting (1–5 seconds), while a client that received `1006` (abnormal) may reconnect immediately and aggressively. Controlling the close code controls client reconnect behavior.

---

## PodDisruptionBudget and Rolling Update Strategy

For a WebSocket service, the Deployment rolling update strategy and the PodDisruptionBudget work in conjunction but are enforced independently. The Deployment strategy controls how the scheduler handles rollouts; the PDB constrains voluntary disruptions (node drain, cluster autoscaler scale-down).

**Deployment strategy for connection-heavy pods:**

```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxUnavailable: 0
    maxSurge: 1
```

`maxUnavailable: 0` ensures that new pods are fully ready before old ones are terminated. For a 10-replica deployment, this means you momentarily run 11 pods during the rollout. The cost is extra compute during deployments; the benefit is that active connections are never forcibly closed by a premature termination.

**PodDisruptionBudget:**

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: cws-comm-pdb
spec:
  minAvailable: "80%"
  selector:
    matchLabels:
      app: cws-comm
```

`minAvailable: "80%"` means the cluster autoscaler and node drain operations can only evict pods while at least 80% remain. For a 10-pod deployment, this limits simultaneous voluntary disruptions to 2 pods at a time. Combined with the application's drain logic, this prevents mass eviction from compressing too many reconnects into a short window.

One important caveat from production experience at Statsig and others: the Deployment's `maxUnavailable` and the PDB's constraints are enforced separately. During a rolling update, the Deployment controller uses its own `maxUnavailable` value regardless of the PDB. The PDB only applies to voluntary disruptions from external actors (node drain, cluster autoscaler). Set both explicitly.

---

## Health Check Design

Readiness and liveness probes for WebSocket services require careful design. The most common mistake is including active connection count in readiness checks. The reasoning is understandable — a pod with 10,000 connections is more "loaded" than one with 100. But connection count is a load metric, not a health metric. Including it in readiness causes two problems:

1. A heavily loaded but healthy pod gets marked unready, removing it from the load balancer and dumping all its connections onto already-loaded peers — exactly the wrong outcome.
2. A new pod with zero connections always appears more ready than an old pod, skewing traffic toward it before it has fully warmed up.

**Liveness probe** (does the process need to be restarted?): Check that the event loop is not deadlocked and the NATS/Redis connections are alive. An HTTP endpoint that returns `200` when the process is functional and `503` when it detects a deadlock or permanent upstream failure.

**Readiness probe** (is this pod ready to accept new traffic?): Check that NATS subscription setup is complete, Redis connection pool is healthy, and the graceful-shutdown flag is not set. Do not include connection count.

```yaml
livenessProbe:
  httpGet:
    path: /healthz/live
    port: 8080
  initialDelaySeconds: 10
  periodSeconds: 10
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /healthz/ready
    port: 8080
  initialDelaySeconds: 5
  periodSeconds: 5
  failureThreshold: 2
```

The readiness endpoint returns `503` in two cases: during startup before NATS and Redis are connected, and after SIGTERM is received (the graceful shutdown window). This flips the pod out of the load balancer rotation promptly on both ends of its lifecycle.

---

## HPA Considerations

Scaling a WebSocket service on CPU and memory alone is often insufficient. A pod handling 10,000 idle WebSocket connections may show low CPU but be approaching file descriptor limits or memory pressure from connection buffers. Custom metrics via the Prometheus adapter give HPA accurate signal.

A useful Prometheus adapter rule for WebSocket connection density:

```yaml
rules:
- seriesQuery: 'websocket_active_connections{namespace!="",pod!=""}'
  resources:
    overrides:
      namespace: {resource: "namespace"}
      pod: {resource: "pod"}
  name:
    matches: "websocket_active_connections"
    as: "websocket_connections_per_pod"
  metricsQuery: 'avg_over_time(websocket_active_connections{<<.LabelMatchers>>}[2m])'
```

The HPA then scales on this metric:

```yaml
metrics:
- type: Pods
  pods:
    metric:
      name: websocket_connections_per_pod
    target:
      type: AverageValue
      averageValue: "5000"
```

This keeps average connection density below 5,000 per pod. The `avg_over_time` smoothing prevents scale-thrash from transient reconnect spikes (e.g., during a rolling update).

One limitation to be aware of: the Prometheus adapter updates its metric cache every 10 minutes by default. During a sudden reconnect surge, HPA may lag in its scaling response. Consider setting `--metrics-relist-interval=30s` in the adapter configuration for faster reaction.

---

## The Split Deployment Pattern

The most durable architectural decision for a service like cws-comm is separating WebSocket gateway pods from HTTP API pods into distinct Kubernetes Deployments.

```
┌─────────────────────┐     ┌─────────────────────────┐
│  cws-comm-gateway   │     │  cws-comm-api            │
│  (WebSocket pods)   │     │  (HTTP REST/internal)    │
│  replicas: 6        │◄────│  replicas: 4             │
│  updates: rare      │     │  updates: frequent       │
│  drain: 60s         │     │  drain: 5s               │
└──────────┬──────────┘     └─────────────────────────┘
           │ NATS / Redis Pub/Sub
           ▼
    ┌────────────┐
    │   Clients  │
    └────────────┘
```

The key insight is that WebSocket gateway pods and HTTP API pods have very different update frequencies. HTTP API pods change with every feature release — multiple times per day. WebSocket gateway pods should change rarely, only when the connection handling code itself changes. By separating them:

- API deployments do not touch WebSocket pods. Connection churn from API releases drops to near zero.
- Gateway pods can have aggressive drain windows (60s) and conservative PDBs without slowing down API iteration.
- Gateway pods can be sized for connection density (many connections, low CPU). API pods can be sized for request throughput (fewer connections, higher CPU).

The NATS backplane is what makes this split viable. The gateway pods do not need to know anything about API business logic; they just maintain connections, route messages to NATS subjects, and fan out messages from NATS to the right clients. The API pods handle all stateful business logic and publish results to NATS.

In practice, implementing this split also simplifies observability: `websocket_active_connections` is a metric on gateway pods only, making the HPA signal clean. API pod HPA can use standard CPU/memory.

---

## Production Checklist

For teams deploying a WebSocket service to GKE with NATS + Redis:

**Application layer**
- SIGTERM handler flips readiness to false immediately
- SIGTERM handler sends WS close code `1012` to all active connections
- Drain window of 45–60 seconds before process exit
- Reconnect logic on client uses exponential backoff with ±50% jitter

**Kubernetes configuration**
- `preStop: sleep 10` on gateway pods
- `terminationGracePeriodSeconds: 90` (preStop + drain + buffer)
- `maxUnavailable: 0, maxSurge: 1` in Deployment strategy
- `PodDisruptionBudget: minAvailable: 80%`

**GKE / load balancer**
- `BackendConfig.connectionDraining.drainingTimeoutSec: 60`
- Ingress upgrade annotations: `nginx.ingress.kubernetes.io/proxy-read-timeout: 3600`
- WebSocket path does not have idle connection timeout shorter than client heartbeat interval

**Health probes**
- Liveness: process alive + NATS/Redis connections functional
- Readiness: startup complete AND shutdown flag not set — no connection count
- Startup probe: longer initial delay (30s) to account for NATS subscription initialization

**Scaling**
- Custom metric: `websocket_connections_per_pod` via Prometheus adapter
- HPA target: average value appropriate to pod memory budget
- Prometheus adapter `--metrics-relist-interval: 30s`

**Architecture**
- Split WebSocket gateway and HTTP API into separate Deployments
- No session affinity — rely on NATS pub/sub for cross-pod routing
- Client reconnect state (subscriptions, auth) rebuilt on reconnect handshake from Redis

Getting this right is a one-time investment that pays forward on every subsequent deployment. The teams operating real-time infrastructure at scale — Discord, Ably, and others — have all converged on variants of this pattern: decouple connection affinity from message routing, drain gracefully with correct close codes, and protect the reconnect window with jitter. For a service like cws-comm, the NATS architecture already provides the foundation. The remaining work is plumbing the Kubernetes configuration to match.
