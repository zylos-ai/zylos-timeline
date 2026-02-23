---
date: "2026-02-23"
title: "WebSocket Reliability Patterns for Multi-Agent Systems"
description: "A comprehensive reference guide covering heartbeat/keepalive, reconnection strategies, connection lifecycle, message delivery guarantees, scaling, security, and real-world implementations — oriented toward B2B agent communication servers."
tags:
  - websocket
  - reliability
  - multi-agent
  - real-time
  - networking
  - b2b
  - infrastructure
  - agent-communication
---

## Executive Summary

WebSocket sits at the foundation of nearly every real-time agent communication system, yet the protocol itself provides almost no reliability guarantees beyond ordered delivery within a single connection. Everything else — dead connection detection, auto-reconnect, message delivery guarantees, graceful shutdown, scaling across processes — must be built at the application layer.

This document covers the eight reliability domains that matter most when hardening a WebSocket-based agent hub for production:

1. Server-side heartbeat and dead connection detection
2. Client reconnection with backoff and state recovery
3. Connection lifecycle management (multiple connections, draining, migration)
4. Message delivery guarantees (at-least-once, ordering, buffering)
5. Horizontal scaling (per-process limits, sticky sessions, pub/sub)
6. Security (token rotation, per-message auth, avoiding URL tokens)
7. Real-world implementations (Slack, Discord, Phoenix, Socket.IO, Firebase)
8. Agent-specific considerations (A2A, Bedrock AgentCore, Cloudflare Durable Objects, Liveblocks)

The core insight across all eight domains is the same: WebSocket connections are long-lived and stateful. Every reliability property that HTTP gets "for free" from its stateless request/response model must be explicitly re-implemented for WebSocket.

---

## Server-Side Heartbeat and Keepalive

### Why TCP Keepalive Is Insufficient

TCP's own keepalive mechanism (the `SO_KEEPALIVE` socket option) operates at the OS level with default probe intervals of 2 hours on Linux and Windows. This is useless for detecting dead WebSocket connections in seconds or minutes — which is what real-time systems need.

Additionally, intermediate proxies (Nginx, HAProxy, AWS ALB, corporate firewalls) frequently terminate idle connections after 30–120 seconds without any notification to either endpoint. A connection that looks alive to both client and server may have been silently dropped at the network layer.

The WebSocket protocol defines ping (opcode `0x9`) and pong (opcode `0xA`) frames specifically for this purpose. When a server sends a ping frame, the peer must respond with a pong. If no pong arrives within the timeout window, the connection is dead.

### Protocol-Level vs. Application-Level Heartbeats

There are two approaches:

**Protocol-level ping/pong (RFC 6455):**
- Server sends a `PING` frame; client must automatically reply with `PONG`
- Browser JavaScript cannot send PING frames directly (`ws.send()` only sends data frames)
- Some proxies strip or ignore ping/pong frames
- The `ws` Node.js library provides direct access to protocol-level frames
- Automatic pong responses are handled by the library, not application code

**Application-level heartbeat (regular data frames):**
- Both sides send/receive normal text/binary messages (e.g., `{"type":"ping"}`)
- Works in all browsers and through all proxies
- Requires protocol design (both sides must implement it)
- More visible for debugging; appears in message logs

For production agent communication servers, **use both**: protocol-level ping/pong for connection health (catches dead TCP connections), and application-level heartbeats for semantic health (confirms the application itself is responsive).

### Reference Implementation (Node.js `ws` library)

```javascript
const WebSocket = require('ws');

const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds
const HEARTBEAT_TIMEOUT_MS = 10_000;  // 10 second pong deadline

const wss = new WebSocket.Server({ port: 8080 });

function setupHeartbeat(ws) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; }); // protocol-level pong

  // Optional: application-level ping handler
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      }
    } catch (_) {}
  });
}

// Heartbeat loop — runs server-wide
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      // Missed the last pong — terminate
      console.log('Terminating dead connection');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping(); // send protocol-level ping
  });
}, HEARTBEAT_INTERVAL_MS);

wss.on('connection', (ws) => {
  setupHeartbeat(ws);
  ws.on('close', () => { /* cleanup */ });
});

wss.on('close', () => clearInterval(heartbeatInterval));
```

### Recommended Timing Parameters

| Parameter | Recommended Value | Notes |
|-----------|------------------|-------|
| Heartbeat interval | 20–30 seconds | Balance between responsiveness and overhead |
| Pong timeout | 10 seconds | Declare dead after one missed pong |
| Proxy timeout | Must be < heartbeat interval | Configure `timeout tunnel` in HAProxy, `proxy_read_timeout` in Nginx |

### Proxy Configuration

Nginx drops WebSocket connections after 60 seconds by default (`proxy_read_timeout 60s`). TCP-level keepalive packets do **not** reset this timer — only actual data does. Set:

```nginx
location /ws {
    proxy_pass http://backend;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;   # 1 hour — heartbeat keeps it active
    proxy_send_timeout 3600s;
}
```

For HAProxy, the critical directive is `timeout tunnel`, which supersedes client/server timeouts for upgraded connections:

```
defaults
    timeout tunnel  1h
    timeout connect 5s
    timeout client  60s
    timeout server  60s
```

---

## Client Reconnection

### The Problem Space

When a WebSocket connection drops, a naive reconnect-immediately strategy causes a **reconnection storm** (the thundering herd problem): if thousands of clients disconnect simultaneously (server restart, network blip), they all attempt to reconnect at the same instant, flooding the server before it can process connections.

Three principles govern reliable reconnection:

1. **Exponential backoff**: double the wait time on each failed attempt
2. **Jitter**: add randomness to spread reconnection attempts across time
3. **Maximum cap**: set a ceiling to prevent multi-hour delays

### Backoff Algorithm

```javascript
class ReconnectingWebSocket {
  constructor(url, options = {}) {
    this.url = url;
    this.minDelay = options.minDelay ?? 1000;      // 1 second
    this.maxDelay = options.maxDelay ?? 30_000;    // 30 seconds
    this.multiplier = options.multiplier ?? 2;
    this.maxAttempts = options.maxAttempts ?? Infinity;
    this.attempt = 0;
    this.ws = null;
    this.connect();
  }

  getDelay() {
    // Full jitter: random value in [0, min(maxDelay, minDelay * 2^attempt)]
    const base = Math.min(this.maxDelay, this.minDelay * (this.multiplier ** this.attempt));
    return Math.random() * base;
  }

  connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      this.attempt = 0; // reset on success
      this.onOpen?.();
    };
    this.ws.onmessage = (e) => this.onMessage?.(e);
    this.ws.onclose = (e) => {
      if (!e.wasClean && this.attempt < this.maxAttempts) {
        const delay = this.getDelay();
        this.attempt++;
        console.log(`Reconnecting in ${Math.round(delay)}ms (attempt ${this.attempt})`);
        setTimeout(() => this.connect(), delay);
      }
    };
  }
}
```

### Jitter Strategies

AWS uses three jitter strategies for distributed systems. The most effective for reconnection storms is **"full jitter"** — entirely random within the exponential envelope:

```
delay = random(0, min(cap, base * 2^attempt))
```

This produces the best load distribution. "Decorrelated jitter" (where each delay is based on the previous) also performs well. Pure exponential backoff without jitter should be avoided in systems with many concurrent clients.

### State Recovery After Reconnect

Reconnection without state recovery causes the client to miss events that occurred during the outage. Patterns for state catchup:

**Offset-based resumption (Discord-style):**
The client stores the sequence number (or `sequence_id`) of the last received event. On reconnect, it sends this offset and the server replays missed events from its buffer.

```javascript
// Client sends on reconnect:
ws.send(JSON.stringify({
  type: 'resume',
  sessionId: storedSessionId,
  lastSeq: storedLastSequenceNumber
}));

// Server response: replays buffered events since lastSeq, then continues
```

**Snapshot + delta (Firebase-style):**
On reconnect, the client fetches the current full state snapshot, then subscribes to deltas from that point forward. Simpler to implement but uses more bandwidth.

**Optimistic local state:**
Queue actions locally during disconnect, replay them in order on reconnect. Requires idempotent server operations (each action carries a unique client-generated ID).

### Distinguishing Error Types

Not all close codes should trigger reconnect. Clients should inspect the WebSocket close code:

| Code | Meaning | Action |
|------|---------|--------|
| 1000 | Normal closure | Do not reconnect |
| 1001 | Going away (server shutdown) | Reconnect with backoff |
| 1006 | Abnormal closure (no close frame) | Reconnect with backoff |
| 1008 | Policy violation (auth rejected) | Do not reconnect; re-authenticate |
| 1011 | Server error | Reconnect with backoff |
| 4001 | App-level auth failure | Re-authenticate, then reconnect |

---

## Connection Lifecycle Management

### Tracking Multiple Connections Per Client

In multi-device scenarios (or when a client SDK creates a new connection before the old one fully closes), multiple connections from the same logical client may exist simultaneously. This creates several problems:

- **Duplicate event delivery**: the server sends each event to every connection
- **Race conditions on writes**: two connections submit conflicting state
- **Resource waste**: stale connections consume server resources and heartbeat bandwidth

**Deduplication strategies:**

```javascript
// Server-side: map from clientId to Set of connections
const clientConnections = new Map(); // clientId -> Set<WebSocket>

wss.on('connection', (ws, req) => {
  const clientId = authenticateAndGetClientId(req);

  if (!clientConnections.has(clientId)) {
    clientConnections.set(clientId, new Set());
  }
  clientConnections.get(clientId).add(ws);

  ws.on('close', () => {
    const conns = clientConnections.get(clientId);
    conns?.delete(ws);
    if (conns?.size === 0) clientConnections.delete(clientId);
  });

  // Optional: evict oldest connection when a new one arrives
  const conns = clientConnections.get(clientId);
  if (conns.size > MAX_CONNECTIONS_PER_CLIENT) {
    const oldest = conns.values().next().value;
    oldest.close(4009, 'Connection replaced by newer session');
    conns.delete(oldest);
  }
});
```

**Policy options:**
- **Reject new**: keep the existing connection, reject the incoming one with close code 4009
- **Evict old**: terminate the existing connection, accept the new one (better for reconnect scenarios)
- **Allow multiple**: permit N concurrent connections per client (useful for multi-tab desktop apps)

For B2B agent hubs, where SDK clients may not cleanly close old connections before opening new ones (especially on reconnect), the evict-old strategy is generally more robust.

### Graceful Shutdown and Connection Draining

Abrupt process termination (`SIGKILL`) without draining connections leaves clients with broken pipes, triggering immediate reconnect storms and potential data loss. A proper graceful shutdown sequence:

```javascript
async function gracefulShutdown() {
  console.log('Starting graceful shutdown...');

  // 1. Stop accepting new connections
  wss.close();

  // 2. Notify all clients they should reconnect elsewhere
  const closePromises = [];
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1001, 'Server going away — please reconnect');
      closePromises.push(new Promise((resolve) => ws.on('close', resolve)));
    }
  }

  // 3. Wait for all connections to close (with timeout)
  await Promise.race([
    Promise.all(closePromises),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Drain timeout')), 30_000))
  ]);

  // 4. Shutdown cleanly
  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
```

**Batched draining for large connection counts:**

When a server has tens of thousands of connections, closing them all simultaneously triggers a thundering herd of reconnections. Spread the drain:

```javascript
async function batchedDrain(clients, batchSize = 1000, intervalMs = 3000) {
  const clientArray = [...clients];
  for (let i = 0; i < clientArray.length; i += batchSize) {
    const batch = clientArray.slice(i, i + batchSize);
    batch.forEach(ws => ws.close(1001, 'Server draining'));
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
```

### Zero-Downtime Deployments

**Kubernetes rolling update approach:**

1. Mark the pod as unready (remove from service endpoints) via readiness probe failure
2. Load balancer stops routing new connections to the pod
3. Pod waits for `preStop` hook delay (allow LB propagation)
4. Application receives SIGTERM, begins graceful shutdown
5. Clients reconnect to healthy pods

```yaml
lifecycle:
  preStop:
    exec:
      command: ["/bin/sh", "-c", "sleep 10"]  # allow LB to drain
terminationGracePeriodSeconds: 60
```

**Client-signaled reconnect:**
The server sends a custom close code (`4010: Planned maintenance`) before shutdown. Well-behaved SDK clients can show a "reconnecting..." UI state rather than an error.

### Connection Migration

WebSocket connections are TCP connections — they are tied to a specific server IP. When a client's IP changes (mobile network handoff: WiFi → 4G), the TCP connection is broken and must be re-established. There is no standard connection migration at the WebSocket layer.

The practical approach: implement reconnection as if it were a new connection, using session resumption to recover state. Systems that need true connection continuity across network changes must look to QUIC-based transports (HTTP/3), which support connection migration natively.

---

## Message Delivery Guarantees

### What WebSocket Natively Provides

WebSocket (over TCP) guarantees:
- **Ordered delivery**: messages arrive in the order they were sent, within a single connection
- **Reliable delivery** (within the connection): TCP retransmits lost segments

What WebSocket does **not** provide:
- Delivery across connection drops
- Deduplication
- Acknowledgment that the application processed the message (only that TCP delivered it)

The moment a connection drops, any in-flight messages are lost. This is the core reliability gap.

### At-Least-Once Delivery

Achieves the guarantee that every message is delivered at least once, at the cost of possible duplicates (which the receiver must handle via deduplication).

**Client-to-server pattern:**

```javascript
class ReliableMessageSender {
  constructor(ws) {
    this.ws = ws;
    this.pending = new Map(); // msgId -> { payload, retries, timer }
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.type === 'ack') this.handleAck(msg.msgId);
    });
  }

  send(payload, maxRetries = 3, timeoutMs = 5000) {
    const msgId = crypto.randomUUID();
    const attempt = () => {
      if (!this.pending.has(msgId)) return; // acked
      const { retries } = this.pending.get(msgId);
      if (retries >= maxRetries) {
        this.pending.delete(msgId);
        throw new Error(`Message ${msgId} undeliverable after ${maxRetries} attempts`);
      }
      this.ws.send(JSON.stringify({ msgId, ...payload }));
      const timer = setTimeout(attempt, timeoutMs);
      this.pending.set(msgId, { payload, retries: retries + 1, timer });
    };
    this.pending.set(msgId, { payload, retries: 0, timer: null });
    attempt();
    return msgId;
  }

  handleAck(msgId) {
    const entry = this.pending.get(msgId);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(msgId);
    }
  }
}
```

**Server-side deduplication:**

```javascript
const processedIds = new LRUCache({ max: 10_000, ttl: 1000 * 60 * 5 }); // 5 min TTL

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (processedIds.has(msg.msgId)) {
    // Duplicate — still ack it so the client stops retrying
    ws.send(JSON.stringify({ type: 'ack', msgId: msg.msgId }));
    return;
  }
  processedIds.set(msg.msgId, true);
  processMessage(msg);
  ws.send(JSON.stringify({ type: 'ack', msgId: msg.msgId }));
});
```

### Server-to-Client Delivery (Offline Buffering)

When a client is temporarily disconnected, events sent by the server are lost by default. Solutions:

**In-memory event buffer (short outages):**

```javascript
const eventBuffers = new Map(); // clientId -> circular buffer of events

function sendToClient(clientId, event) {
  const ws = getActiveConnection(clientId);
  event.seq = nextSeq(clientId); // monotonic sequence number

  // Always buffer recent events
  getBuffer(clientId).push(event);

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
  // If client is offline, buffer holds the event for replay on reconnect
}

// On reconnect, client sends lastSeq
ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.type === 'resume') {
    const missed = getBuffer(clientId).since(msg.lastSeq);
    missed.forEach(e => ws.send(JSON.stringify(e)));
  }
});
```

**Database-backed persistence (long outages):**
Store events in a database (PostgreSQL, Redis Stream) keyed by client ID and sequence number. On reconnect, query `WHERE seq > lastSeq`. This handles outages longer than the in-memory buffer window and survives server restarts.

### Message Ordering Across Multiple Senders

TCP guarantees ordering within a single connection. When **multiple server-side producers** write to the same connection concurrently, application code can interleave messages out of logical order.

Safe pattern: serialize all writes through a single queue:

```javascript
class OrderedSender {
  constructor(ws) {
    this.ws = ws;
    this.queue = [];
    this.sending = false;
  }

  enqueue(data) {
    this.queue.push(data);
    if (!this.sending) this.flush();
  }

  async flush() {
    this.sending = true;
    while (this.queue.length > 0) {
      const msg = this.queue.shift();
      await new Promise((resolve, reject) => {
        this.ws.send(msg, (err) => err ? reject(err) : resolve());
      });
    }
    this.sending = false;
  }
}
```

---

## Scaling WebSocket Systems

### Per-Process Connection Limits

Node.js practical limits in production (commodity hardware, typical message sizes):

| Metric | Practical Limit per Process | Notes |
|--------|-----------------------------|-------|
| Concurrent connections | 10,000–30,000 | Event loop contention above this |
| Memory per connection | 20–100 KB | Depends on buffer sizes and per-connection state |
| Open file descriptors | Set `ulimit -n 65536` | Default OS limit is often 1024 |
| CPU per heartbeat cycle | Scales with connection count | Profile at target connection count |

Increase OS file descriptor limits before scaling:

```bash
# /etc/security/limits.conf
* soft nofile 65536
* hard nofile 65536

# Or in systemd service:
LimitNOFILE=65536
```

### Sticky Sessions

WebSocket connections are stateful — if connection state (subscriptions, in-flight messages, session data) is stored in process memory, all messages for a client must route to the same process. This is sticky sessions (session affinity).

**Nginx IP-hash:**
```nginx
upstream websocket_backend {
    ip_hash;  # route same IP to same backend
    server ws1:8080;
    server ws2:8080;
    server ws3:8080;
}
```

**Limitation:** IP-hash breaks when clients are behind NAT (corporate proxies) — thousands of clients share one IP, all routed to the same backend. Cookie-based affinity is more reliable:

**HAProxy cookie-based:**
```
backend websocket_servers
    balance roundrobin
    cookie WS_SRV insert indirect nocache
    server ws1 10.0.0.1:8080 check cookie ws1
    server ws2 10.0.0.2:8080 check cookie ws2
    server ws3 10.0.0.3:8080 check cookie ws3
```

**Limitation of sticky sessions:** a backend process restart loses all its connections (they reconnect elsewhere), and that single process becomes a hot spot if clients are unevenly distributed.

### Redis Pub/Sub for Cross-Process Messaging

When server-side code needs to push a message to a client whose connection lives on a different process, pub/sub decouples the routing:

```javascript
// Publisher (any process):
redis.publish(`ws:client:${clientId}`, JSON.stringify(event));

// Each WebSocket process subscribes to all clients it serves:
redisSubscriber.subscribe(`ws:client:${clientId}`, (message) => {
  const ws = localConnections.get(clientId);
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(message);
  }
});
```

**Architecture:**

```
                    ┌─────────────────┐
                    │   Redis Pub/Sub  │
                    └────────┬────────┘
               ┌─────────────┼─────────────┐
               ▼             ▼             ▼
          ┌─────────┐  ┌─────────┐  ┌─────────┐
          │  WS     │  │  WS     │  │  WS     │
          │ Server 1│  │ Server 2│  │ Server 3│
          └─────────┘  └─────────┘  └─────────┘
               │             │             │
          Clients A-D   Clients E-H   Clients I-L
```

**Scaling Redis itself:** Redis Cluster partitions channels across nodes. For very high throughput, consider NATS JetStream or Kafka as the pub/sub backbone — they offer persistence and replay that Redis pub/sub does not.

### Load Balancer Considerations

- **Layer 4 (TCP) LBs** (HAProxy in TCP mode, AWS NLB): best for WebSocket — connection-aware, low overhead, support long-lived connections naturally
- **Layer 7 (HTTP) LBs** (Nginx, AWS ALB): can proxy WebSocket but add parsing overhead; must disable HTTP/2 for WebSocket upgrade paths
- **Health checks**: WebSocket servers need liveness probes that verify the heartbeat system is running, not just that the HTTP port responds

---

## Security

### Never Put Tokens in the URL

The most common WebSocket authentication mistake is appending the token as a query parameter:

```
wss://api.example.com/ws?token=eyJ...  // WRONG
```

URLs appear in:
- Web server access logs
- Proxy logs
- Browser history
- Referrer headers when the page navigates
- Error reports, analytics SDKs

The correct patterns:

**1. Cookie-based (best for browser clients):**
The HTTP upgrade handshake sends cookies automatically. Validate the session cookie in the handshake handler.

```javascript
wss.on('headers', (headers, req) => {
  // Session validation happens here — before the upgrade completes
  const sessionId = parseCookie(req.headers.cookie)?.sessionId;
  if (!validateSession(sessionId)) {
    // Reject with 401 — send before the WebSocket upgrade
    headers.push('HTTP/1.1 401 Unauthorized');
  }
});
```

**2. First-message authentication (best for non-browser SDK clients):**
Client opens the WebSocket, then immediately sends credentials as the first message. Server discards any other messages until authentication succeeds.

```javascript
ws.on('message', (data) => {
  if (!ws.authenticated) {
    const { token } = JSON.parse(data);
    const identity = validateToken(token);
    if (!identity) {
      ws.close(4001, 'Authentication failed');
      return;
    }
    ws.authenticated = true;
    ws.identity = identity;
    ws.send(JSON.stringify({ type: 'auth_ok', sessionId: identity.sessionId }));
    return;
  }
  // Handle normal messages
});
```

**3. Short-lived one-time token:**
Client makes an authenticated HTTP POST to `/ws-token`, gets a short-lived (30-second TTL) single-use token, then uses it in the WebSocket URL. Server invalidates it immediately on first use.

```javascript
// Client
const { wsToken } = await fetch('/ws-token', { method: 'POST', headers: { Authorization: `Bearer ${longLivedToken}` } }).then(r => r.json());
const ws = new WebSocket(`wss://api.example.com/ws?t=${wsToken}`);
// Token is now invalid and cannot be replayed
```

### Token Rotation for Long-Lived Connections

JWT access tokens typically expire in 15–60 minutes. WebSocket connections last hours or days. Three strategies:

**Application-level token refresh:**
```javascript
// Client: send new token before it expires
setInterval(async () => {
  const newToken = await refreshToken();
  ws.send(JSON.stringify({ type: 'auth_refresh', token: newToken }));
}, TOKEN_REFRESH_INTERVAL_MS);

// Server: accept and validate mid-session token refresh
if (msg.type === 'auth_refresh') {
  const newIdentity = validateToken(msg.token);
  if (!newIdentity || newIdentity.sub !== ws.identity.sub) {
    ws.close(4001, 'Token refresh failed');
    return;
  }
  ws.identity = newIdentity;
}
```

**Scope enforcement on every message:**
WebSocket connections authenticate once but the token's scopes may be revoked mid-session (user downgraded, API key invalidated). Check authorization on each operation, not just at handshake:

```javascript
ws.on('message', (data) => {
  const msg = JSON.parse(data);
  // Re-check scopes on every action
  if (!hasScope(ws.identity, requiredScopeFor(msg.action))) {
    ws.send(JSON.stringify({ type: 'error', code: 403, message: 'Insufficient scope' }));
    return;
  }
  handleAction(msg);
});
```

**Session invalidation push:**
When a token is revoked server-side (user logs out, API key deleted), proactively close the WebSocket:

```javascript
// Subscribe to a revocation event stream
revokeEvents.on(clientId, () => {
  const ws = getConnection(clientId);
  ws?.close(4001, 'Session revoked');
});
```

### Additional Security Controls

- **Origin validation**: check `req.headers.origin` against an allowlist in the upgrade handler (prevents cross-site WebSocket hijacking)
- **Rate limiting**: limit message rate per connection (protect against message flood attacks)
- **Input validation**: treat every WebSocket message as untrusted — validate schema before processing
- **TLS (wss://)**: always; plain `ws://` in production is unacceptable — credentials, message content, and session tokens are in the clear
- **CSRF**: WebSocket connections are not subject to the Same-Origin Policy for connections (only browsers enforce it for WebSocket), so always validate the `Origin` header server-side

---

## Real-World Implementations

### Discord Gateway

Discord's Gateway is one of the most thoroughly documented WebSocket reliability implementations available publicly. Key design decisions:

**Heartbeat with sequence tracking:**
- Server sends `Opcode 10 Hello` immediately on connect, containing `heartbeat_interval`
- Client sends `Opcode 1 Heartbeat` at the specified interval, including the sequence number of the last received event
- Server responds with `Opcode 11 Heartbeat ACK`
- If no ACK arrives before the next heartbeat, the connection is "zombied" — client must terminate and resume

**Session resumption:**
- On `Opcode 0 Ready` (first event after login), client stores `session_id` and `resume_gateway_url`
- On disconnect, client connects to `resume_gateway_url` (session-specific URL) and sends `Opcode 6 Resume` with `session_id` and last received `seq`
- Server replays all missed events since `seq` from a bounded replay buffer
- If the replay buffer is exhausted (too long offline), server sends `Opcode 9 Invalid Session` — client must do a full re-identify

**Key insight:** The `resume_gateway_url` is session-specific and differs from the main gateway URL. This allows Discord to route resumptions to the shard that holds the session state.

### Slack Socket Mode

Slack's Socket Mode routes events through a WebSocket instead of requiring a public HTTP endpoint.

Key reliability features:
- The WebSocket URL is generated at runtime via `apps.connections.open` API call and refreshes periodically
- Slack's SDK automatically handles reconnection and heartbeat
- Events have an `envelope_id` — Slack expects the SDK to acknowledge each event within 3 seconds, otherwise Slack resends it (at-least-once delivery from server to SDK)
- Slack maintains over 5 million simultaneous WebSocket sessions at peak, served by a geo-distributed caching layer ("Flannel") that pre-warms team metadata to reduce reconnect latency

### Phoenix Channels (Elixir)

Phoenix Channels leverage the Erlang VM's actor model for WebSocket reliability:

- Each channel subscription maps to a lightweight Erlang process (millions can run concurrently with minimal overhead)
- The Erlang VM handles process isolation — a crash in one channel cannot affect others
- **Presence** is built-in: Phoenix Presence tracks which users are connected across a cluster using a CRDT (Conflict-free Replicated Data Type), enabling accurate presence without a central coordinator
- Transport fallback: if WebSocket fails, Phoenix falls back to long-polling automatically
- Distribution is handled natively by the Erlang distribution protocol — no Redis needed for cross-node pub/sub

Phoenix's reliability advantage over Node.js-based systems is fundamental: each connection is a supervised process. Crashes are isolated, supervised, and restarted automatically.

### Socket.IO

Socket.IO adds a reliability layer on top of raw WebSocket:

**Delivery guarantees (v4.6+):**
```javascript
// Client: at-least-once with retries
const socket = io({
  retries: 3,          // retry up to 3 times
  ackTimeout: 10_000   // 10 second ack deadline
});

socket.emit('event', payload); // automatically retried until server acks
```

- Same `msgId` is reused across retries for server-side deduplication
- Default is "at most once" (fire and forget) — retries must be explicitly configured
- **There is no server-side offline buffer**: events sent while a client is disconnected are lost unless the application implements persistence

**Scaling:** Requires the `socket.io-redis` adapter for multi-process deployments. Each process publishes events to a Redis channel; all other processes subscribe and forward to local connections.

### Firebase Realtime Database

Firebase takes a different philosophical approach — the client subscribes to a data path, not a message stream:

- On reconnect, the client automatically receives the current value of subscribed paths (snapshot + delta)
- No message buffering needed: the data model is the buffer
- Offline SDK queues writes locally; on reconnect, writes are replayed with conflict resolution
- Suitable for collaborative state; less suitable for one-time event delivery (e.g., notifications)

Firebase's reliability comes from treating the server as the source of truth and the WebSocket as a sync transport, not a message pipe.

### Cloudflare Durable Objects

Cloudflare Durable Objects provide a novel approach to WebSocket state management:

**WebSocket Hibernation:**
- When no messages are being processed, the Durable Object (and its JavaScript runtime) can hibernate
- The WebSocket TCP connection remains open; the client is unaware of hibernation
- Incoming ping frames are automatically ponged during hibernation without waking the DO
- When a message arrives, the DO wakes up (constructor is re-called), restoring state from `serializeAttachment`

```javascript
export class MyDurableObject {
  async webSocketMessage(ws, message) {
    // Only called when a message arrives — DO is active
    const state = ws.deserializeAttachment();
    // ... process message
    ws.serializeAttachment({ ...state, lastActive: Date.now() });
  }
}
```

**Key constraint:** Hibernation only works for incoming WebSocket connections. Outgoing WebSockets from a DO do not hibernate.

**Reliability benefit:** Hibernation allows maintaining millions of idle-but-connected WebSocket sessions at near-zero cost, as idle DOs are not billed.

---

## Agent-Specific Considerations

### Google A2A Protocol (Agent2Agent)

Google's A2A protocol (April 2025) chose **Server-Sent Events (SSE) over WebSocket** for real-time streaming. The rationale:
- Agent-to-agent communication is often **primarily unidirectional** (orchestrator pushes tasks, agent streams results)
- SSE is firewall-friendly (standard HTTP; many firewalls block WebSocket upgrades)
- SSE is simpler to implement and debug
- SSE has native reconnection (`retry:` field) and event IDs for resumption built into the protocol

**Limitation:** A2A built on HTTP/SSE lacks automatic flow control, message persistence, pub/sub patterns, and the bidirectional signaling that WebSocket enables. Enterprise use cases (long-running tasks, human-in-the-loop, multi-agent coordination) push beyond what SSE provides.

For BotsHub-style bidirectional agent communication (where agents push results AND send control signals back), WebSocket remains the right transport.

### Amazon Bedrock AgentCore Runtime

AgentCore uses WebSocket for bidirectional streaming between orchestrators and agent containers:

- Agents implement a WebSocket endpoint at `/ws` on port 8080
- Authentication: AWS SigV4, pre-signed URLs, or OAuth Bearer tokens
- `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` header routes to an isolated session
- Message frame size limit: 32 KB — larger payloads must be chunked
- Connection is automatically closed on rate limit violations
- The agent can start responding while still receiving input (true bidirectional)

Key pattern for agent platforms: use `session_id` to provide connection affinity. All connections carrying the same `session_id` route to the same runtime session, enabling state continuity even if the client reconnects.

### Liveblocks (People + AI Collaboration)

Liveblocks chose WebSocket over HTTP for AI agents specifically because:

1. **UI-first copilots**: frontend components can subscribe to agent state and receive live streaming updates
2. **Resumable streams**: if the WebSocket drops mid-agent-run, the client reconnects and immediately receives the latest buffered agent output
3. **Multi-device broadcast**: agent results broadcast to all connected tabs/devices without polling
4. **Confirmation flows**: agent can send a "waiting for approval" message; user responds over the same connection

Liveblocks' sync engine (open-sourced 2025) uses WebSocket as a sync transport with CRDT-based conflict resolution — treating agent state as shared mutable data rather than a message stream.

### Design Principles for Agent Communication Platforms

Based on the above real-world implementations, the following patterns emerge as essential for B2B agent hubs:

**1. Session identity separate from connection identity**

```
sessionId (stable) → N connections (transient)
```

A session survives reconnections. A connection is a single TCP lifetime. The server must map session → active connection, not assume they are the same.

**2. Sequence numbers on all events**

Every event sent to a client must carry a monotonically increasing sequence number scoped to the session. This enables replay on reconnect without redesigning the message format later.

**3. Server-side event buffer**

Buffer the last N events (or T seconds worth) per session in memory. On reconnect, replay from `lastSeq`. For long-running agent tasks (hours), back this with a database.

**4. Explicit connection replacement policy**

When a client reconnects, the old connection may still be alive (race condition during reconnect). Implement explicit eviction: accept the new connection, replay buffered events, then close the old connection with a `4009 Replaced` code.

**5. Graceful shutdown signals**

Before a process shuts down, send each client a `4010 Planned shutdown` close code. Clients can display a "reconnecting..." state rather than treating it as an error. Use batched draining to avoid reconnection storms.

**6. Per-action authorization**

Authentication happens at handshake time. Authorization must be re-checked on every action, because:
- Token scopes may have changed since connection open
- Agents may attempt to access resources outside their declared scope
- Connection hijacking can redirect an authenticated session to unauthorized actions

---

## Implementation Checklist

### Server

- [ ] Protocol-level heartbeat (ping/pong) with configurable interval (default: 30s)
- [ ] Pong timeout detection — terminate connections that miss a pong
- [ ] Application-level heartbeat for end-to-end health confirmation
- [ ] Per-session event sequence numbers
- [ ] In-memory event buffer per session (ring buffer, fixed size)
- [ ] Reconnect event replay from lastSeq
- [ ] Multiple-connection-per-client tracking and eviction policy
- [ ] Graceful shutdown with `1001 Going Away` and batched drain
- [ ] `SIGTERM` handler with drain timeout
- [ ] Per-action authorization checks (not just handshake)
- [ ] Origin header validation
- [ ] Message rate limiting per connection
- [ ] Input validation on all received messages

### Client SDK

- [ ] Exponential backoff with full jitter
- [ ] Maximum retry cap (e.g., 30 seconds)
- [ ] Close code inspection (distinguish auth failure from network failure)
- [ ] `lastSeq` persistence across reconnects (localStorage for browsers, disk for Node.js)
- [ ] `resume` message on reconnect with `lastSeq`
- [ ] Outbound message queue (hold messages while disconnected)
- [ ] Token refresh before expiry (not on reconnect — proactive)
- [ ] Auth token in first message or cookie, not URL

### Infrastructure

- [ ] Nginx/HAProxy `proxy_read_timeout` / `timeout tunnel` set > heartbeat interval
- [ ] Sticky sessions configured (cookie-based preferred over IP-hash)
- [ ] Redis pub/sub adapter for cross-process message delivery
- [ ] File descriptor limits raised (`ulimit -n 65536`)
- [ ] Health check verifies WebSocket heartbeat system, not just HTTP port
- [ ] Connection drain configured in load balancer deregistration delay

---

## Sources

- [Keepalive and Latency — websockets Python library docs](https://websockets.readthedocs.io/en/stable/topics/keepalive.html)
- [Understanding Ping Pong Frame WebSocket (2025) — VideoSDK](https://www.videosdk.live/developer-hub/websocket/ping-pong-frame-websocket)
- [How to Configure WebSocket Heartbeat/Ping-Pong — OneUptime](https://oneuptime.com/blog/post/2026-01-24-websocket-heartbeat-ping-pong/view)
- [WebSocket Architecture Best Practices — Ably](https://ably.com/topic/websocket-architecture-best-practices)
- [WebSocket Reconnect: Strategies for Reliable Communication — APIDog](https://apidog.com/blog/websocket-reconnect/)
- [How to Implement Reconnection Logic for WebSockets — OneUptime](https://oneuptime.com/blog/post/2026-01-27-websocket-reconnection-logic/view)
- [Implementing Retry Strategies for WebSocket Reconnections — Peerdh](https://peerdh.com/blogs/programming-insights/implementing-retry-strategies-for-websocket-reconnections-in-real-time-applications-1)
- [Deal with Reconnection Storm — Two Strategies — Amir Soleimani (Medium)](https://amirsoleimani.medium.com/deal-with-reconnection-storm-two-strategies-4a835d0457f6)
- [How to Handle Graceful Shutdown for WebSocket Servers — OneUptime](https://oneuptime.com/blog/post/2026-02-02-websocket-graceful-shutdown/view)
- [Delivery Guarantees — Socket.IO v4 docs](https://socket.io/docs/v4/delivery-guarantees)
- [WebSocket Reliability in Realtime — Ably](https://ably.com/topic/websocket-reliability-in-realtime-infrastructure)
- [Guarantee Message Deliveries for Real-Time WebSocket APIs with Serverless on AWS — Medium](https://mohdizzy.medium.com/guarantee-message-deliveries-for-real-time-websocket-apis-with-serverless-on-aws-89ae60a7491d)
- [WebSockets Guarantee Order — So Why Are My Messages Scrambled? — Sitong Peng](https://www.sitongpeng.com/writing/websockets-guarantee-order-so-why-are-my-messages-scrambled)
- [How to Scale WebSocket — Horizontal Scaling — TSH.io](https://tsh.io/blog/how-to-scale-websocket)
- [How to Scale WebSockets for High-Concurrency Systems — Ably](https://ably.com/topic/the-challenge-of-scaling-websockets)
- [WebSockets at Scale — Production Architecture — WebSocket.org](https://websocket.org/guides/websockets-at-scale/)
- [WebSocket Scale in 2025 — VideoSDK](https://www.videosdk.live/developer-hub/websocket/websocket-scale)
- [Scaling Pub/Sub with WebSockets and Redis — Ably](https://ably.com/blog/scaling-pub-sub-with-websockets-and-redis)
- [WebSocket Security — OWASP Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)
- [Essential Guide to WebSocket Authentication — Ably](https://ably.com/blog/websocket-authentication)
- [Authentication — websockets Python library docs](https://websockets.readthedocs.io/en/latest/topics/authentication.html)
- [WebSocket Authentication in 2025 — VideoSDK](https://www.videosdk.live/developer-hub/websocket/websocket-authentication)
- [How Netflix, Slack, and Discord Really Handle Billions of WebSocket Connections — Medium](https://medium.com/@sanjeevanibhandari3/how-netflix-slack-and-discord-really-handle-billions-of-websocket-connections-1a84b6d840cd)
- [Slack Socket Mode — Slack Developer Docs](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [Discord Gateway — Discord Developer Docs](https://docs.discord.com/developers/events/gateway)
- [Gateway Connection Lifecycle — DeepWiki](https://deepwiki.com/discord-userdoccers/discord-userdoccers/8.1-gateway-connection-lifecycle)
- [Phoenix Channels — HexDocs](https://hexdocs.pm/phoenix/channels.html)
- [Socket.IO and Phoenix Channels: A Comparative Analysis — Joe Koski](https://www.joekoski.com/blog/2023/10/03/socket-io.html)
- [Announcing the Agent2Agent Protocol (A2A) — Google Developers Blog](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)
- [A2A for Enterprise-Scale AI Agent Communication — HiveMQ](https://www.hivemq.com/blog/a2a-enterprise-scale-agentic-ai-collaboration-part-1/)
- [Bi-directional Streaming for Real-Time Agent Interactions — Amazon Bedrock AgentCore — AWS Blog](https://aws.amazon.com/blogs/machine-learning/bi-directional-streaming-for-real-time-agent-interactions-now-available-in-amazon-bedrock-agentcore-runtime/)
- [Use WebSockets — Cloudflare Durable Objects docs](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [WebSocket Hibernation — Cloudflare Durable Objects docs](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/)
- [Why We Built Our AI Agents on WebSockets Instead of HTTP — Liveblocks](https://liveblocks.io/blog/why-we-built-our-ai-agents-on-websockets-instead-of-http)
- [WebSockets for Cloudflare Agents — Cloudflare Agents docs](https://developers.cloudflare.com/agents/api-reference/websockets/)
- [HAProxy WebSocket Configuration — HAProxy docs](https://www.haproxy.com/documentation/haproxy-configuration-tutorials/protocol-support/websocket/)
- [Nginx WebSocket Configuration Guide — WebSocket.org](https://websocket.org/guides/infrastructure/nginx/)
- [Zero-Downtime WebSocket Deployment Strategies with FastAPI — HexShift (Medium)](https://hexshift.medium.com/zero-downtime-websocket-deployment-strategies-with-fastapi-2e2df9ebfe3d)
- [Mitigating the Thundering Herd Problem — Exponential Backoff with Jitter — Medium](https://medium.com/@avnein4988/mitigating-the-thundering-herd-problem-exponential-backoff-with-jitter-b507cdf90d62)
- [Twilio TaskRouter SDK Reconnect Logic — Twilio Docs](https://www.twilio.com/docs/taskrouter/js-sdk-v2/reconnect)
