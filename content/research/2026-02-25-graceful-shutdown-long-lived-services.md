---
date: "2026-02-25"
title: "Graceful Shutdown Patterns for Long-Lived Services"
description: "Deep dive into shutdown sequencing, connection draining, and state persistence for WebSocket servers, AI agent processes, and services managed by PM2 or nginx"
tags:
  - graceful-shutdown
  - websocket
  - nodejs
  - nginx
  - pm2
  - infrastructure
  - reliability
  - ai-agents
---

## Executive Summary

Graceful shutdown is the discipline of stopping a service without breaking things that are already in flight. For short-lived HTTP request handlers the problem is largely solved: stop accepting, drain, exit. For long-lived services — WebSocket servers, AI agent loops, scheduler processes, reverse proxies holding thousands of persistent connections — the problem is significantly harder.

The failure modes are concrete: zombie nginx workers that hold memory for hours after a config reload, PM2 restarts that drop mid-conversation messages, LLM calls left hanging when a process receives SIGTERM, and upstream connections that never properly close. Every one of these has caused real incidents in production agent platforms.

This article systematically covers the shutdown problem from signal receipt to final process exit, with specific attention to Node.js WebSocket servers, PM2-managed processes, nginx upstream draining, and the unique challenges of AI agent workloads.

---

## Why Long-Lived Services Are Different

A standard HTTP request completes in milliseconds. A graceful shutdown window of even one second is generous. For long-lived services the math changes completely:

- A WebSocket connection can persist for hours or days
- An LLM API call may take 30–120 seconds (streaming responses)
- An agent task loop may be mid-execution with dirty state in memory
- A scheduler may have timers that need clean cancellation

The canonical three-phase shutdown — **stop accepting → drain → exit** — still applies, but "drain" now needs a timeout policy, a signaling mechanism to connected clients, and often a state-persistence step before exit.

---

## The Signal Chain

Understanding what signal arrives, when, and from what process is the prerequisite for everything else.

### SIGTERM vs SIGINT

| Signal | Sent by | Default behavior | Catchable? |
|--------|---------|-----------------|-----------|
| SIGTERM | OS, orchestrator, PM2 | Terminate | Yes |
| SIGINT | Ctrl+C, terminal | Interrupt | Yes |
| SIGKILL | OS force-kill | Kill immediately | No |

PM2 sends SIGINT by default (not SIGTERM) when you run `pm2 restart` or `pm2 stop`. This trips up engineers expecting SIGTERM. PM2's `kill_signal` option lets you override this per process. Always set it explicitly:

```json
{
  "apps": [{
    "name": "agent-server",
    "kill_signal": "SIGTERM",
    "kill_timeout": 10000
  }]
}
```

### The Timeout Countdown

The moment a termination signal is received, a countdown begins. If the process has not exited by the deadline, SIGKILL arrives and any in-flight work is lost.

- **Docker**: 10-second default (`docker stop --time=N` to override)
- **PM2**: 1600ms default `kill_timeout` — dangerously short for WebSocket services
- **Kubernetes**: 30-second `terminationGracePeriodSeconds` (configurable per pod)
- **nginx worker**: unbounded by default; use `worker_shutdown_timeout` to cap it

The implication: your shutdown timeout budget must be set longer than your longest expected in-flight operation. For services that forward LLM requests, this might be 90–120 seconds.

---

## Node.js WebSocket Graceful Shutdown

### Phase 1: Stop Accepting New Connections

The first action on receiving a shutdown signal is to stop accepting new connections. For an `http.Server` this means calling `server.close()`, which stops the listen socket. For a WebSocket server (`ws` library) built on top of an HTTP server, this is sufficient — new upgrade requests are rejected, but existing WebSocket connections remain open.

```javascript
process.on('SIGTERM', () => {
  console.log('SIGTERM received, starting graceful shutdown');
  server.close(() => {
    console.log('HTTP server closed (no longer accepting connections)');
  });
});
```

### Phase 2: Notify and Drain WebSocket Clients

Existing WebSocket connections need to be closed properly. Simply calling `ws.terminate()` is a hard kill — it does not send a close frame and the client sees an unexpected disconnection. Instead, send a close frame with an appropriate status code:

- **1001 Going Away**: server is shutting down, client should reconnect elsewhere
- **1012 Service Restart**: server will restart, client may reconnect to new instance

```javascript
const activeConnections = new Set();

wss.on('connection', (ws) => {
  activeConnections.add(ws);
  ws.on('close', () => activeConnections.delete(ws));
});

async function closeAllConnections(timeoutMs = 5000) {
  const closePromises = [...activeConnections].map((ws) => {
    return new Promise((resolve) => {
      ws.once('close', resolve);
      ws.close(1001, 'Server shutting down');
    });
  });

  // Force-terminate any connections that don't close within timeout
  const forceTimer = setTimeout(() => {
    activeConnections.forEach((ws) => ws.terminate());
  }, timeoutMs);

  await Promise.allSettled(closePromises);
  clearTimeout(forceTimer);
}
```

### Phase 3: Wait for In-Flight Operations

If the service is proxying LLM requests or running agent tasks, you need to track in-flight operations separately from WebSocket connections. A connection can be open without an active request, and a request can outlive its WebSocket if the client disconnected mid-stream.

```javascript
let inFlightCount = 0;
let isShuttingDown = false;

function trackRequest(fn) {
  if (isShuttingDown) throw new Error('Server is shutting down');
  inFlightCount++;
  return fn().finally(() => {
    inFlightCount--;
    if (isShuttingDown && inFlightCount === 0) {
      process.emit('drain-complete');
    }
  });
}

async function waitForDrain(timeoutMs = 30000) {
  if (inFlightCount === 0) return;
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    process.once('drain-complete', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
```

### Phase 4: Persist State and Cleanup

Before exiting, flush any buffered state:

- Pending database writes
- Message queue acknowledgments
- In-memory session data
- Scheduler state

Cleanup order matters. Database connections should be closed *after* all writes complete, not before.

```javascript
async function shutdown() {
  isShuttingDown = true;

  // 1. Stop accepting
  server.close();

  // 2. Notify clients
  await closeAllConnections(5000);

  // 3. Wait for in-flight work
  await waitForDrain(30000);

  // 4. Persist state
  await sessionStore.flush();
  await scheduler.persistState();

  // 5. Close infrastructure connections
  await db.close();
  await redisClient.quit();

  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

---

## The nginx Zombie Worker Problem

This is one of the most common and frustrating production issues with WebSocket-heavy services.

### What Happens During nginx Reload

When `nginx -s reload` (or `systemctl reload nginx`) is called:

1. Master process reads new config
2. New worker processes are spawned and start accepting connections
3. Old workers receive SIGQUIT (graceful quit)
4. Old workers stop accepting new connections
5. Old workers wait for active connections to close
6. Old workers exit

For HTTP/1.1 keep-alive connections, step 5 resolves quickly. For WebSocket connections — which can last hours — old workers stay alive indefinitely. Every config reload accumulates more zombie workers. Memory usage climbs. The old processes never exit because WebSocket clients have no reason to disconnect.

### Solution 1: worker_shutdown_timeout

```nginx
worker_shutdown_timeout 10s;
```

This directive caps how long a shutting-down worker will wait for connections to drain. After the timeout, remaining connections are forcibly closed. This is the simplest fix but involves client disruption.

### Solution 2: Periodic Server-Side Connection Reset

If worker_shutdown_timeout is too aggressive, an alternative is to periodically close WebSocket connections from the application side, before they become ancient. A connection that's been alive for 30 minutes resets cleanly; clients reconnect transparently.

```javascript
// Close and let clients reconnect every 20 minutes
setInterval(() => {
  activeConnections.forEach((ws) => {
    ws.close(1001, 'Scheduled reconnect');
  });
}, 20 * 60 * 1000);
```

Combined with client-side auto-reconnect, this means no connection is ever more than 20 minutes old, and nginx reloads drain within that window.

### Solution 3: Upstream Keepalive Configuration

For services that don't need persistent WebSocket connections everywhere, replacing WebSocket with HTTP/2 server-sent events (SSE) or HTTP long-polling avoids the zombie worker problem entirely. nginx handles HTTP connections more cleanly during reload.

---

## PM2-Specific Patterns

PM2's default shutdown window is 1600ms — appropriate for a web API, completely inadequate for a WebSocket server or AI agent process. Critical PM2 settings:

```json
{
  "apps": [{
    "name": "agent-server",
    "script": "src/server.js",
    "kill_signal": "SIGTERM",
    "kill_timeout": 30000,
    "listen_timeout": 5000,
    "wait_ready": true
  }]
}
```

**`kill_timeout`**: How long PM2 waits after sending the kill signal before escalating to SIGKILL. Set this to the sum of: connection drain time + state persistence time + a safety buffer.

**`wait_ready`**: PM2 waits for `process.send('ready')` from the application before routing traffic. During startup, the app initializes connections, runs migrations, and only signals ready when genuinely able to serve.

**`listen_timeout`**: How long PM2 waits for the ready signal. If the app takes longer to start than this, PM2 marks the restart as failed.

The `ready` signal pattern:

```javascript
async function start() {
  await db.connect();
  await scheduler.initialize();
  server.listen(PORT, () => {
    if (process.send) process.send('ready');
    console.log(`Server listening on port ${PORT}`);
  });
}
```

---

## AI Agent-Specific Challenges

AI agent workloads create shutdown challenges that standard web services don't face.

### Long-Running LLM Calls

An LLM streaming response can take 90+ seconds. During that time, a SIGTERM arrives. Options:

1. **Abort the call**: Use `AbortController` to cancel the LLM request. The client receives an error. Acceptable for stateless requests; not acceptable for agent tasks with side effects.

2. **Let it finish**: Block shutdown until the LLM call completes. Requires a generous timeout and may delay deployments.

3. **Checkpoint and resume**: Save enough state that the agent task can be re-enqueued and restarted on the new process. More complex but enables clean rolling deployments.

The right choice depends on whether the operation is idempotent. LLM generation calls are generally idempotent (same input → same output). Agent tasks that take external actions (sending messages, writing files) are not.

```javascript
const abortController = new AbortController();
const activeRequests = new Set();

async function callLLM(prompt) {
  const controller = new AbortController();
  activeRequests.add(controller);

  try {
    const response = await openai.chat.completions.create(
      { model: 'claude-sonnet-4-6', messages: [...] },
      { signal: controller.signal }
    );
    return response;
  } finally {
    activeRequests.delete(controller);
  }
}

async function shutdownLLMCalls() {
  activeRequests.forEach((ctrl) => ctrl.abort());
}
```

### Scheduler State

Autonomous task schedulers (like a cron-based agent wake-up system) need to persist their queue state before shutdown. Tasks that were "running" at shutdown time need to be marked appropriately — either re-queued, marked failed, or checkpointed — so they aren't lost or double-executed after restart.

A safe pattern:

1. Stop the scheduler from dispatching new tasks
2. Wait for currently-running tasks to finish (with timeout)
3. For tasks that didn't finish: mark status as `interrupted`
4. Persist the queue to disk
5. Exit

On startup, the scheduler checks for `interrupted` tasks and either re-runs them or logs them for human review.

### Session Continuity

When a WebSocket connection drops mid-conversation due to a server restart, the agent loses conversational context unless it's been persisted. This makes stateless session storage (Redis, SQLite) a prerequisite for graceful restart rather than an optimization.

---

## Shutdown Sequencing: The Dependency Order

Getting the order right is as important as getting the individual steps right. A common mistake is closing the database before flushing pending writes.

Correct order:

```
1. Stop accepting new connections / requests
2. Signal connected clients (WebSocket close frames, SSE disconnect)
3. Wait for in-flight application logic to complete
4. Flush buffered state to persistent storage
5. Drain message queue acknowledgments
6. Close database connection pool
7. Close cache / Redis connections
8. Close any remaining file handles
9. Exit with code 0
```

Steps that write data (4, 5) must complete before closing the storage they write to (6, 7).

---

## Health Check Integration

Graceful shutdown should be coordinated with health checks so that load balancers stop routing traffic before shutdown begins. The pattern:

1. **On SIGTERM received**: Set a flag that causes `/health` to return 503
2. Wait for the load balancer to detect the 503 and stop routing (1–2 probe cycles)
3. Then proceed with connection draining

```javascript
let isHealthy = true;

app.get('/health', (req, res) => {
  if (!isHealthy) return res.status(503).json({ status: 'shutting_down' });
  res.json({ status: 'ok' });
});

process.on('SIGTERM', async () => {
  isHealthy = false;

  // Wait for LB to stop routing (assuming 5s probe interval)
  await sleep(10000);

  // Now drain safely
  await shutdown();
});
```

This pattern prevents the race condition where the load balancer routes a new connection to an instance that's already started shutting down.

---

## Testing Graceful Shutdown

Graceful shutdown code is easy to write and hard to validate. Most teams discover it's broken during an incident. Practical testing approaches:

- **Chaos testing**: Use tools like `kill -SIGTERM <pid>` during active load tests and verify no requests fail
- **Slow shutdown test**: Add artificial delays in the shutdown handler to verify timeout escalation behaves correctly
- **Connection leak test**: Verify that all WebSocket connections are properly closed and not left in CLOSE_WAIT state (`ss -an | grep CLOSE_WAIT`)
- **State integrity test**: Restart the service mid-operation and verify that state was persisted correctly and resumed on startup

---

## Summary: Key Decisions

| Decision | Recommendation |
|----------|---------------|
| PM2 kill_timeout | Set to max(LLM timeout, task timeout) + 10s buffer |
| PM2 kill_signal | SIGTERM (not default SIGINT) |
| nginx worker_shutdown_timeout | 30–60s, or use periodic connection cycling |
| WebSocket close code | 1001 (going away) for planned shutdown |
| LLM call handling | Abort if idempotent; checkpoint if stateful |
| Health check during shutdown | Return 503 before draining begins |
| Shutdown test cadence | Test in staging on every deploy |

Graceful shutdown is a cross-cutting concern that touches the reverse proxy, the process manager, the application server, and the data layer simultaneously. Each layer has its own timeout budget, its own signal semantics, and its own notion of "done." Getting them aligned — with appropriate timeouts at each layer and a clear dependency order for cleanup — is what separates a service that degrades gracefully from one that leaves corrupted state and disconnected clients behind.

---

*Sources: [How to Handle Graceful Shutdown for WebSocket Servers](https://oneuptime.com/blog/post/2026-02-02-websocket-graceful-shutdown/view) · [PM2 Graceful Shutdown Documentation](https://pm2.io/docs/runtime/best-practices/graceful-shutdown/) · [nginx worker_shutdown_timeout](https://nginx.org/en/docs/control.html) · [Kubernetes Pod Graceful Shutdown](https://devopscube.com/kubernetes-pod-graceful-shutdown/) · [Fixing Hung Nginx Workers](https://stelfox.net/blog/2019/10/fixing-hung-nginx-workers/) · [Node.js Graceful Shutdown](https://oneuptime.com/blog/post/2026-01-06-nodejs-graceful-shutdown-handler/view) · [Graceful Shutdown in Go](https://victoriametrics.com/blog/go-graceful-shutdown/)*
