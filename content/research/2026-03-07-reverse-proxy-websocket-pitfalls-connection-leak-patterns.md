---
date: "2026-03-07"
title: "Reverse Proxy WebSocket Pitfalls: Connection Leak Patterns and Production Remedies"
description: "A deep investigation into how reverse proxies like Nginx and OpenResty handle WebSocket connections, common pitfalls that cause connection leaks in production, and proven remediation strategies including heartbeat architectures and observability patterns."
tags: ["websocket", "reverse-proxy", "nginx", "openresty", "connection-management", "production", "debugging"]
---

## Executive Summary

WebSocket connections passing through reverse proxies represent one of the most insidious sources of production incidents in real-time systems. Unlike HTTP request-response cycles that are self-cleaning by nature, WebSocket connections are long-lived, stateful, and depend on both endpoints (plus every intermediary) to agree on connection liveness. When a reverse proxy like Nginx or OpenResty sits between client and server, it introduces a termination boundary that can silently create ghost connections -- connections the server believes are alive but that have no living client behind them.

This article examines the architectural mechanics behind these failures, contrasts transparent proxying with terminating proxy behavior, analyzes how different heartbeat strategies interact with proxy layers, and provides concrete production patterns for detection and remediation. The findings are drawn from real-world debugging of multi-proxy WebSocket architectures and current industry best practices from frameworks like Socket.IO and Phoenix Channels.

## The Termination Boundary Problem

### Why Reverse Proxies Break WebSocket Assumptions

A fundamental tension exists between HTTP reverse proxying and WebSocket connections. HTTP was designed as a stateless request-response protocol, and reverse proxies like Nginx were built around that model. The `Upgrade` header that initiates a WebSocket handshake is a hop-by-hop header -- it is not automatically forwarded from client to proxied server. This means WebSocket support in reverse proxies requires explicit configuration:

```nginx
location /ws {
    proxy_pass http://backend;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

Without this configuration, the proxy treats the upgrade request as standard HTTP traffic and the connection silently fails or degrades. But even with correct configuration, the proxy creates a termination boundary: it maintains two separate TCP connections (client-to-proxy and proxy-to-backend) and bridges data between them. This architecture introduces three failure modes that do not exist in direct client-server connections.

### Failure Mode 1: Asymmetric Connection Death

When a client disconnects abruptly (network failure, browser tab close, mobile network switch), the client-to-proxy TCP connection dies. However, the proxy-to-backend connection may remain alive for an extended period. The proxy may not immediately detect the client-side failure, especially if TCP keepalive is disabled or configured with long intervals (the OS default is often 2 hours). The backend server sees an apparently healthy connection that will never receive another message.

This creates a "half-open" or "ghost" connection. The server allocates memory, maintains state, and potentially sends messages into a void. At scale, hundreds or thousands of ghost connections accumulate, consuming resources and distorting metrics.

### Failure Mode 2: Silent Timeout Disconnection

Nginx's `proxy_read_timeout` defaults to 60 seconds. If no data flows through the WebSocket connection for 60 seconds, Nginx closes both the client and backend connections without sending a WebSocket close frame. The backend receives a TCP RST or FIN, which many WebSocket libraries report as error code 1006 (abnormal closure) rather than a clean close.

The critical subtlety: TCP-level keepalive packets do not reset this timeout. Nginx's `proxy_read_timeout` operates at the application data level. Even if TCP keepalive is active and passing empty packets, Nginx will still terminate the connection after 60 seconds of no application data. This catches many teams off guard -- they enable TCP keepalive thinking it solves the problem, but connections continue to drop.

### Failure Mode 3: Proxy-Terminated Ping/Pong Frames

WebSocket protocol-level ping and pong frames (opcodes 0x9 and 0xA) are designed for connection health checking. However, their behavior through reverse proxies is inconsistent. Some proxy configurations intercept and respond to ping frames at the proxy layer without forwarding them to the backend. When this happens, the client receives pong responses and believes the connection is healthy, while the proxy-to-backend connection remains idle and eventually times out.

This behavior is particularly common with OpenResty when using the `lua-resty-websocket` library in proxy mode rather than standard `proxy_pass`. The library terminates the WebSocket protocol at the proxy layer, creating independent client-side and server-side WebSocket sessions. Ping/pong frames on one side have no relationship to the other side.

## OpenResty vs. Nginx: Two Proxy Architectures

### Standard Nginx proxy_pass (Byte-Transparent)

With standard `proxy_pass` and the upgrade headers configured, Nginx operates as a byte-transparent bridge. After the initial HTTP upgrade handshake, Nginx copies bytes between the client and backend connections using `io.Copy` (or equivalent). It does not parse WebSocket frames, does not understand ping/pong, and does not inspect message content. The only intelligence it applies is the timeout: if no bytes flow for `proxy_read_timeout` seconds, it kills the connection.

This approach is predictable. WebSocket ping/pong frames pass through to the backend. Application-level heartbeat messages pass through. Any data resets the timeout. The failure modes are limited to the timeout issue and asymmetric death described above.

### OpenResty lua-resty-websocket (Protocol-Terminating)

OpenResty's Lua WebSocket library takes a fundamentally different approach. It implements a full WebSocket server on the client-facing side and a full WebSocket client on the backend-facing side. The proxy receives WebSocket frames from the client, decodes them in Lua, and can inspect, modify, or drop frames before re-encoding and forwarding them to the backend.

This architecture offers powerful capabilities -- frame-level inspection, message transformation, routing logic, and connection pooling. Kong's `lua-resty-websocket-proxy` library extends this further with frame aggregation support.

However, it creates a double-termination architecture where client and backend connections are fully independent:

- **Independent timeouts**: Each side has its own idle timeout. Activity on the client side does not reset the backend-side timeout, and vice versa.
- **Independent ping/pong**: A ping from the client is handled by the proxy's server-side code. It never reaches the backend. The backend must receive its own heartbeat traffic, or the proxy must implement explicit forwarding logic.
- **Independent close handling**: A client disconnect triggers the proxy's server-side close handler. The proxy must then explicitly close the backend-side connection. If the close handler has bugs or the proxy process crashes, the backend connection leaks.
- **Connection pooling pitfalls**: OpenResty's cosocket connection pool (per-worker, not per-server) can keep backend connections alive after clients disconnect, creating orphaned connections that consume backend resources.

### The Diagnostic Signature

The difference between these architectures produces a clear diagnostic signal. In a system where the same application code runs behind standard Nginx (byte-transparent) and behind OpenResty (protocol-terminating), connection leak rates will differ dramatically. A test environment without OpenResty may show 2-3 stale connections over 17 hours, while the same code behind OpenResty in production accumulates over 1,500 stale connections in a similar period. The code is identical; the proxy architecture is the variable.

## The Three-Layer Heartbeat Architecture

Production WebSocket systems must implement heartbeats at multiple layers, each serving a distinct purpose. Relying on a single layer is the most common mistake.

### Layer 1: TCP Keepalive

TCP keepalive sends empty ACK packets at the TCP level to detect dead connections. It is a transport-level mechanism.

**Strengths**: Works without application involvement. Detects connections where the remote host has crashed or the network path has failed.

**Weaknesses**: Disabled by default on most operating systems. Default interval when enabled is typically 2 hours -- far too long for real-time applications. Does not reset proxy-level timeouts. Cannot detect application-level deadlocks where the process is alive but unresponsive.

**Configuration guidance**: Enable with a short interval (30-60 seconds) as a safety net, but never rely on it as the primary health mechanism.

### Layer 2: WebSocket Protocol Ping/Pong

WebSocket ping (opcode 0x9) and pong (opcode 0xA) frames are part of the WebSocket specification (RFC 6455, Section 5.5.2-5.5.3). Either endpoint can send a ping, and the recipient must respond with a pong containing the same payload.

**Strengths**: Standardized. Lightweight (2-byte overhead for empty ping). Handled automatically by most WebSocket libraries. Resets Nginx `proxy_read_timeout` when the proxy is byte-transparent.

**Weaknesses**: Browser JavaScript cannot initiate ping frames -- only the browser's native WebSocket implementation can respond to server-initiated pings. Terminating proxies may intercept pings without forwarding them. Some corporate firewalls and proxies strip ping/pong frames.

**Important limitation**: Because browsers cannot send ping frames, server-to-client ping/pong alone cannot detect a dead server from the client's perspective. The client needs an independent mechanism.

### Layer 3: Application-Level Heartbeat

Application-level heartbeats use regular WebSocket text or binary messages (not control frames) to implement health checking. The server sends a message like `{"type":"server_ping","ts":1709827200}` and expects the client to reply with `{"type":"client_pong","ts":1709827200}`.

**Strengths**: Works through any proxy, firewall, or intermediary -- they are indistinguishable from regular messages. Resets all proxy timeouts. Visible in application logs. Can carry diagnostic payload (timestamps, sequence numbers, client state). Browser JavaScript can both send and receive them. Works identically through byte-transparent and protocol-terminating proxies.

**Weaknesses**: Higher overhead than protocol-level pings. Requires explicit implementation in both client and server code. Must be filtered from business message processing.

### Why Application-Level Heartbeat Wins

The industry has converged on application-level heartbeats as the primary mechanism, with protocol-level ping/pong as a secondary layer. The reason is proxy transparency:

- **Socket.IO**: Implements a ping/pong cycle at the Engine.IO layer using regular messages. The server sends a ping packet at a configurable interval (`pingInterval`, default 25 seconds), and the client must respond with a pong within `pingTimeout` (default 20 seconds). If the server does not receive a pong, it considers the connection dead. The client applies the same logic in reverse.

- **Phoenix Channels**: Uses a "heartbeat" event on the "phoenix" topic, sent as a regular WebSocket message. The default interval is 30 seconds. The server expects heartbeat replies and closes connections that miss them.

- **SignalR**: Implements keep-alive pings at the application protocol level, with configurable intervals and timeout detection on both sides.

All three frameworks chose application-level heartbeats over WebSocket ping/pong precisely because of intermediary transparency. This is the battle-tested approach.

## Stale Connection Detection and Sweeping

Even with heartbeats, connections can become stale. A robust system needs both active health checking and passive stale detection.

### Active Health Checking Pattern

The server maintains a `lastActivity` timestamp for each connection, updated on any inbound message (including heartbeat responses). A periodic sweep runs every N seconds (typically 2-3x the heartbeat interval) and terminates connections whose `lastActivity` exceeds a threshold:

```
heartbeat_interval = 30 seconds
sweep_interval = 60 seconds
stale_threshold = 90 seconds (3 missed heartbeats)
```

The sweep must perform a clean WebSocket close (sending a close frame with an appropriate status code like 4000 for stale connection) followed by TCP-level socket destruction if the close handshake does not complete within a timeout.

### Passive Detection Signals

Beyond heartbeat failures, several signals indicate a stale connection:

- **Write errors**: Attempting to send a message and receiving EPIPE or ECONNRESET indicates the connection is dead. Some libraries silently swallow these errors.
- **Buffer backpressure**: If the send buffer for a connection grows beyond a threshold, the client is likely not reading. This can indicate a dead connection or an overwhelmed client.
- **Monotonically increasing connection count**: If `connections_opened - connections_closed` grows over time without stabilizing, connections are leaking.

### The Client-Side Responsibility

Stale connection detection is not solely a server concern. The client must also detect server failure. If no server message (including heartbeat pings) arrives within `heartbeat_interval + grace_period`, the client should:

1. Close the existing connection
2. Apply exponential backoff (starting at 1 second, capping at 30 seconds)
3. Reconnect and re-authenticate
4. Resume subscription state

This bidirectional health checking ensures that neither endpoint accumulates ghost connections.

## Observability for WebSocket Connection Health

### Essential Metrics

A production WebSocket system should expose these metrics, ideally via Prometheus:

- **`ws_connections_active`** (gauge): Current number of open WebSocket connections. This is the primary leak indicator. A monotonically increasing value signals a leak.
- **`ws_connections_opened_total`** (counter): Cumulative connections opened since process start.
- **`ws_connections_closed_total`** (counter): Cumulative connections closed, labeled by close reason (clean, timeout, stale_sweep, error).
- **`ws_heartbeat_latency_seconds`** (histogram): Time between sending a heartbeat ping and receiving the pong. Increasing latency predicts connection failures.
- **`ws_heartbeat_timeouts_total`** (counter): Number of connections terminated due to missed heartbeats.
- **`ws_connection_duration_seconds`** (histogram): How long connections live before closing. Bimodal distributions (many short + many very long) can indicate leak patterns.
- **`ws_stale_connections_swept_total`** (counter): Connections terminated by the stale sweep. A non-zero sustained rate indicates an ongoing leak source.

### Diagnostic Endpoints

Beyond metrics, a health endpoint that exposes connection breakdown data is invaluable for debugging:

```json
{
  "total_connections": 1551,
  "connections_by_age": {
    "0-1h": 45,
    "1-6h": 120,
    "6-12h": 380,
    "12-24h": 1006
  },
  "connections_by_last_activity": {
    "active_last_60s": 42,
    "idle_1-5min": 3,
    "idle_5min+": 1506
  }
}
```

A healthy system should show most connections in the "active" bucket. If the majority of connections have been idle for minutes or hours, they are almost certainly stale.

### Alerting Rules

Key alerts for connection leak detection:

- **Rate of change alert**: If `ws_connections_active` increases by more than 100 per hour without a corresponding increase in authenticated users, trigger an investigation.
- **Stale ratio alert**: If `idle_5min+ / total_connections > 0.5`, the system has a leak.
- **Sweep rate alert**: If `ws_stale_connections_swept_total` rate exceeds expected churn, the leak source is active.

## Production Remediation Playbook

### Immediate Response (When Leaking Now)

1. **Quantify the leak**: Check `ws_connections_active` or call the diagnostic endpoint. Compare with expected user count.
2. **Identify the proxy layer**: If possible, compare connection counts at each layer -- client-to-proxy, proxy-to-backend. The layer with the highest discrepancy is the source.
3. **Enable stale sweep**: If not already active, deploy an application-level stale connection sweep with a conservative threshold (e.g., 5 minutes of inactivity).
4. **Do not restart blindly**: Restarting the backend drops all connections (including healthy ones) and triggers a reconnection storm. Fix the leak mechanism first.

### Architectural Remediation

1. **Implement application-level heartbeats**: Server sends a typed heartbeat message every 25-30 seconds. Client must reply within 20 seconds. Server terminates non-responsive connections.
2. **Configure proxy timeouts**: Set `proxy_read_timeout` to 2-3x the heartbeat interval (e.g., 90 seconds if heartbeat is 30 seconds). This provides a safety net while allowing heartbeats to keep connections alive.
3. **Audit proxy architecture**: Determine whether the proxy is byte-transparent or protocol-terminating. If protocol-terminating (OpenResty with lua-resty-websocket), ensure explicit heartbeat forwarding or implement independent heartbeats on both sides of the proxy.
4. **Add connection lifecycle logging**: Log connection open (with client IP, user agent, auth identity), heartbeat failures, and connection close (with reason code). This creates an audit trail for post-incident analysis.
5. **Externalize connection state**: Store connection metadata (user ID, connected_at, last_activity) in Redis or an equivalent store. This enables fleet-wide connection visibility and cross-node stale detection.

### Testing the Fix

After implementing heartbeats and stale sweeps:

1. **A/B test with and without proxy**: Run the same application code with direct connections and through the proxy. Connection leak rates should converge.
2. **Simulate client death**: Kill client processes without clean disconnect and verify the server detects and cleans up within the expected timeout.
3. **Long-duration soak test**: Run under realistic load for 24+ hours and verify `ws_connections_active` stabilizes rather than growing.
4. **Proxy restart test**: Restart the proxy and verify all backend connections are properly cleaned up, not orphaned.

## Lessons from the Field

Several hard-won lessons emerge from production WebSocket debugging:

**Always gather empirical data before theorizing.** One well-designed A/B test (same code, different proxy configurations) provides more signal than hours of code review. The proxy configuration is often the variable, not the application code.

**Don't trust TCP-level keepalive to solve application-level problems.** TCP keepalive operates at a different layer with different semantics. It will not reset proxy timeouts and cannot detect application-level unresponsiveness.

**Browser limitations shape architecture.** The inability of browser JavaScript to send WebSocket ping frames is not a minor detail -- it is an architectural constraint that forces application-level heartbeats for any system with browser clients.

**Terminating proxies require explicit attention.** When a proxy terminates the WebSocket protocol (as OpenResty with lua-resty-websocket does), it creates two independent connection lifecycles. Every health mechanism must be implemented on both sides, or the proxy must explicitly bridge them.

**Connection leaks are slow-motion incidents.** Unlike crash failures that trigger immediate alerts, connection leaks accumulate over hours or days. They manifest as gradually increasing memory usage, degrading response times, and eventually resource exhaustion. By the time someone notices, thousands of ghost connections may exist. Proactive monitoring with clear alerts on connection count trends is the only reliable defense.

## Conclusion

WebSocket connection management through reverse proxies is a domain where small configuration differences create dramatic production outcomes. The choice between byte-transparent proxying (standard Nginx `proxy_pass`) and protocol-terminating proxying (OpenResty `lua-resty-websocket`) fundamentally changes how heartbeats, timeouts, and connection lifecycle events propagate. Teams deploying WebSocket systems behind reverse proxies must understand which architecture they are operating in, implement application-level heartbeats that work through any intermediary, deploy stale connection sweeps as a safety net, and instrument comprehensive observability to detect leaks before they become incidents. The industry consensus -- demonstrated by Socket.IO, Phoenix Channels, and SignalR -- is clear: application-level heartbeats over regular WebSocket messages are the only reliable mechanism for maintaining connection health across arbitrary proxy topologies.
