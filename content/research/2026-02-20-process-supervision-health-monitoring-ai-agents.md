---
date: "2026-02-20"
title: "Process Supervision and Health Monitoring for Long-Running AI Agents"
description: "A practical guide to keeping autonomous AI agents alive and healthy in production — covering PM2, systemd watchdogs, container health checks, graceful shutdown patterns, and the heartbeat architectures used in real-world agent deployments."
tags: ["ai-agents", "process-supervision", "pm2", "systemd", "devops", "health-monitoring", "reliability", "node-js"]
---

## Executive Summary

Long-running autonomous AI agents are fundamentally different from stateless web servers. They accumulate context across sessions, maintain active connections to external APIs and message queues, and often carry mission-critical state that cannot simply be discarded on a crash. When an agent dies silently — killed by a kernel OOM, hung on a blocking tool call, or deadlocked inside a retry loop — the consequences extend beyond a failed HTTP response. Sessions are lost, scheduled tasks are missed, and the agent's "memory" can be left in an inconsistent state. Process supervision is the engineering discipline that keeps agents running despite these failure modes. This article surveys the leading approaches — PM2 for Node.js, systemd watchdogs for Linux services, container-native health checks, and custom heartbeat architectures — and distills the patterns that work best for autonomous agent deployments in 2026.

## Why AI Agents Need Special Supervision

Standard web service supervision assumes that each request is independent: if a process crashes, kill it and start a new one. The next request lands on a fresh instance and nobody is the wiser. AI agents violate this assumption in three ways:

**Stateful context.** An agent mid-conversation or mid-task has accumulated reasoning state that cannot be recreated from a database lookup. A naive restart loses this context entirely, forcing a user to repeat themselves or leaving a scheduled task orphaned.

**Long-running blocking operations.** Agents routinely block for seconds or minutes — waiting for an LLM API response, a browser automation sequence, or a file download. A process monitor that measures CPU activity will misidentify these as hangs and trigger unnecessary restarts.

**Cascading failure risk.** If the supervision strategy is too aggressive (restart-on-any-pause), it can cause thrash: the agent is perpetually restarting mid-task, making it unavailable in a different way than if it had simply crashed.

The right supervision design acknowledges these dynamics and uses application-level signals — heartbeats emitted from inside the event loop — rather than crude external metrics.

## PM2: The Practical Default for Node.js Agents

PM2 is the de-facto process manager for Node.js production workloads, with over 100 million downloads and a feature set purpose-built for long-running services. For agent systems built on Node.js (or the growing number using Bun), PM2 offers the quickest path to reliable supervision with minimal operational overhead.

### Ecosystem Configuration

The `ecosystem.config.js` file is the central declaration for how PM2 manages a process:

```js
// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "zylos-agent",
      script: "./agent.js",
      instances: 1,              // single-instance for stateful agent
      autorestart: true,
      watch: false,              // never watch files in production
      max_memory_restart: "1G",  // restart if memory exceeds 1 GB
      restart_delay: 5000,       // wait 5s before restart (avoid thrash)
      exp_backoff_restart_delay: 100, // exponential backoff up to 15s
      env_production: {
        NODE_ENV: "production",
        PORT: 3000,
      },
      error_file: "./logs/agent-error.log",
      out_file: "./logs/agent-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
  ],
};
```

Key options for agent processes:

- **`exp_backoff_restart_delay`**: Exponential backoff between restarts prevents thundering-herd problems when an agent crashes on startup (e.g., a downstream API is down). PM2 backs off incrementally up to ~15 seconds, reducing pressure on external dependencies during recovery.
- **`max_memory_restart`**: LLM context windows and tool call results can accumulate significant heap. Setting a memory ceiling catches runaway growth before the kernel OOM-killer forcibly terminates the process.
- **`restart_delay`**: A flat delay before each restart gives external dependencies (databases, message brokers) time to recover before the agent tries to reconnect.
- **`watch: false`**: File watching must be disabled in production. Watching triggers restarts on any file change, which is appropriate for development but catastrophic for a production agent mid-conversation.

### Custom Liveness Signals

PM2 supports a ready signal over IPC, allowing an agent to declare itself ready only after completing initialization — connecting to databases, loading memory state, and verifying API credentials:

```js
// agent.js
async function bootstrap() {
  await connectDatabase();
  await loadMemoryState();
  await verifyAPICredentials();

  // Tell PM2 the agent is ready to handle work
  if (process.send) {
    process.send("ready");
  }

  startMainLoop();
}

bootstrap().catch((err) => {
  console.error("Bootstrap failed:", err);
  process.exit(1);
});
```

Combined with `wait_ready: true` and `listen_timeout` in the ecosystem config, PM2 will hold the "started" state until the ready signal arrives rather than declaring the process healthy the moment it spawns.

## systemd: Production-Grade Supervision for Linux Services

For agents deployed directly on Linux hosts (not containerized), systemd provides the most robust supervision available. Its built-in watchdog mechanism is particularly well-suited to the AI agent heartbeat pattern: the agent must periodically notify systemd that it is alive and processing, and systemd will restart it if the heartbeat goes silent.

### Unit File Structure

```ini
# /etc/systemd/system/zylos-agent.service
[Unit]
Description=Zylos AI Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=zylos
WorkingDirectory=/opt/zylos
ExecStart=/usr/bin/node /opt/zylos/agent.js
Restart=on-failure
RestartSec=10s
RestartBurst=3
WatchdogSec=120s
NotifyAccess=main

# Resource limits
MemoryMax=2G
CPUQuota=200%

[Install]
WantedBy=multi-user.target
```

`Type=notify` tells systemd to expect a `READY=1` notification before declaring the service active. `WatchdogSec=120s` instructs systemd to restart the service if it does not receive a `WATCHDOG=1` keepalive within 120 seconds.

### Emitting Heartbeats from Node.js

The `sd-notify` npm package wraps the systemd socket protocol:

```js
import sdNotify from "sd-notify";

// After initialization, signal readiness
sdNotify.ready();

// Read watchdog interval from environment
const watchdogInterval = sdNotify.watchdogInterval();

if (watchdogInterval > 0) {
  // Send heartbeat at half the watchdog interval (systemd best practice)
  const heartbeatMs = Math.floor(watchdogInterval / 2);

  setInterval(() => {
    // Only send heartbeat if the event loop is actually processing
    // (this callback itself proves the loop is not blocked)
    sdNotify.watchdog();
  }, heartbeatMs);
}
```

The interval callback approach has an important property: it only fires if the Node.js event loop is actively cycling. A truly blocked process (deadlocked in synchronous code, or stuck in a C++ binding) will not fire the callback, and the heartbeat will naturally go silent — triggering the systemd restart.

### Graceful Stop Notifications

systemd also supports stop notifications, allowing the agent to signal when it has finished cleanup:

```js
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, beginning graceful shutdown");

  // Stop accepting new work
  stopAcceptingMessages();

  // Complete in-flight operations (with timeout)
  await Promise.race([
    drainInFlightOperations(),
    new Promise((resolve) => setTimeout(resolve, 30000)),
  ]);

  // Persist memory state before exit
  await flushMemoryToStorage();

  // Notify systemd that shutdown is clean
  sdNotify.stopping();

  process.exit(0);
});
```

## Container-Native Health Checks

For agents deployed in Docker or Kubernetes, the health check mechanism is built into the container runtime itself.

### Docker HEALTHCHECK

```dockerfile
FROM node:22-alpine

WORKDIR /app
COPY . .
RUN npm ci --only=production

# Expose a lightweight health endpoint
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "agent.js"]
```

The agent exposes a `/health` endpoint that the container runtime polls. A response in the 200–299 range marks the container healthy; three consecutive failures mark it unhealthy and (in Swarm or Compose) trigger a restart.

The `/health` endpoint itself should be lightweight — not a full diagnostic — but it should check the minimum required for the agent to function:

```js
app.get("/health", async (req, res) => {
  const checks = {
    uptime: process.uptime(),
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    lastHeartbeat: agentState.lastHeartbeatAt,
    status: "ok",
  };

  // Fail if the internal heartbeat loop has been silent for too long
  const heartbeatAge = Date.now() - agentState.lastHeartbeatAt;
  if (heartbeatAge > 60_000) {
    return res.status(503).json({ ...checks, status: "heartbeat_stale" });
  }

  res.json(checks);
});
```

### Kubernetes Probes

Kubernetes extends Docker's single health check into three distinct probe types, each serving a different purpose:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: zylos-agent
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: agent
          image: zylos/agent:latest
          ports:
            - containerPort: 3000
          startupProbe:
            httpGet:
              path: /health/startup
              port: 3000
            failureThreshold: 30
            periodSeconds: 10
            # Allows up to 300s for initial startup (model loading, DB connect)
          livenessProbe:
            httpGet:
              path: /health/live
              port: 3000
            initialDelaySeconds: 0
            periodSeconds: 30
            failureThreshold: 3
            timeoutSeconds: 5
          readinessProbe:
            httpGet:
              path: /health/ready
              port: 3000
            periodSeconds: 10
            failureThreshold: 3
```

The three probes serve distinct roles:

| Probe | Path | Purpose |
|-------|------|---------|
| **Startup** | `/health/startup` | Delays liveness/readiness checks until the agent finishes initialization. Critical for agents with slow startup (loading large models, connecting to external APIs). |
| **Liveness** | `/health/live` | Determines if the container should be restarted. Should be minimal — check only that the process is not deadlocked. |
| **Readiness** | `/health/ready` | Determines if the container should receive traffic. Can be more comprehensive — check that external dependencies (databases, LLM APIs) are reachable. |

A critical best practice: **keep liveness probes simple**. A liveness probe that calls out to an external database can cause cascading restarts if the database is temporarily unavailable — the agent gets killed and restarted in a loop, even though it was perfectly healthy.

## Heartbeat Architecture: The Internal Watchdog Pattern

Beyond external supervision, well-designed agents implement an internal heartbeat that monitors the agent's own event loop health. This is particularly important for AI agents that may spend long periods awaiting LLM API responses or blocked on tool calls.

### The Heartbeat Manager

```js
class HeartbeatManager {
  constructor({ intervalMs = 10_000, stallThresholdMs = 60_000 } = {}) {
    this.intervalMs = intervalMs;
    this.stallThresholdMs = stallThresholdMs;
    this.lastBeat = Date.now();
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => {
      this.lastBeat = Date.now();
      this._onBeat();
    }, this.intervalMs);

    // Unref so the timer doesn't prevent clean process exit
    this.timer.unref();
  }

  _onBeat() {
    // Emit to external observers (PM2 metrics, systemd, health endpoint)
    process.emit("agent:heartbeat", { ts: this.lastBeat });
  }

  isHealthy() {
    return Date.now() - this.lastBeat < this.stallThresholdMs;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

const heartbeat = new HeartbeatManager();
heartbeat.start();
```

The key insight: if the event loop is blocked, the `setInterval` callback cannot fire. The `isHealthy()` check in the `/health` endpoint detects this stall condition and reports it to the external supervisor before the process is killed, giving operators visibility into *why* the agent became unhealthy.

### Differentiating Expected Blocking from True Stalls

AI agents legitimately block for extended periods during LLM calls. A naive heartbeat that treats any silence as a failure will cause unnecessary restarts during normal operation. The solution is to update the heartbeat timestamp from within the operation itself:

```js
async function callLLMWithHeartbeat(prompt, heartbeat) {
  // Signal that we're intentionally blocking on an LLM call
  heartbeat.extendDeadline(120_000); // allow up to 2 min for this call

  try {
    const response = await llmClient.complete(prompt);
    return response;
  } finally {
    heartbeat.resetDeadline(); // return to normal threshold
  }
}
```

This pattern ensures the heartbeat manager knows the difference between a legitimate long-running operation and an unexpected stall — and reports health status accordingly.

## Graceful Shutdown Patterns

Graceful shutdown is the complement to supervision: when a restart *is* necessary, the goal is to lose as little state as possible.

### The Shutdown Sequence

A robust graceful shutdown follows a consistent sequence:

1. **Stop accepting new work** — close the Telegram message listener, dequeue no further tasks
2. **Complete or checkpoint in-flight work** — either finish the current task or write a "resume" checkpoint to storage
3. **Flush state** — persist memory, flush log buffers, close database connections
4. **Signal the supervisor** — emit `stopping()` (systemd) or call `process.exit(0)` cleanly
5. **Force exit on timeout** — if cleanup takes too long, force-exit rather than hang indefinitely

```js
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`[shutdown] Received ${signal}, beginning graceful shutdown`);

  // 1. Stop accepting new messages/tasks
  messageListener.stop();
  taskScheduler.pause();

  // 2. Wait for active tasks (with a hard timeout)
  const SHUTDOWN_TIMEOUT_MS = 30_000;
  const shutdownDeadline = setTimeout(() => {
    console.error("[shutdown] Timeout exceeded, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    await activeTaskTracker.waitForCompletion();

    // 3. Flush state
    await memoryStore.flush();
    await database.close();
    await logger.flush();

    console.log("[shutdown] Clean shutdown complete");
    clearTimeout(shutdownDeadline);
    process.exit(0);
  } catch (err) {
    console.error("[shutdown] Error during cleanup:", err);
    clearTimeout(shutdownDeadline);
    process.exit(1);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
```

### Checkpoint and Resume

For tasks that cannot be completed within the shutdown window, a checkpoint-and-resume pattern preserves progress:

```js
async function checkpointCurrentTask(task) {
  await storage.write(`checkpoints/${task.id}.json`, {
    taskId: task.id,
    progress: task.currentStep,
    context: task.serializeContext(),
    checkpointedAt: new Date().toISOString(),
  });
}

// On next startup, resume from checkpoint
async function resumeCheckpointedTasks() {
  const checkpoints = await storage.list("checkpoints/");
  for (const checkpoint of checkpoints) {
    const data = await storage.read(checkpoint);
    console.log(`Resuming task ${data.taskId} from step ${data.progress}`);
    await taskScheduler.enqueue(data);
    await storage.delete(checkpoint);
  }
}
```

## Observability Integration

Process supervision is only effective when paired with observability. The key metrics to export from a supervised agent process:

- **Restart count** (per-session and lifetime) — a rising restart count is often the first signal of a deeper problem
- **Time since last heartbeat** — exposes internal stalls before the external supervisor triggers a restart
- **Memory RSS over time** — slow memory leaks are common in agents that accumulate conversation context
- **Active task count** — ensures the graceful shutdown drain is making progress

PM2 exposes these metrics via its `pm2 monit` dashboard and its programmatic API. For systemd-managed services, tools like Prometheus's `node_exporter` combined with systemd's `sd_booted(3)` metrics provide equivalent visibility. Container-orchestrated agents can emit metrics to Prometheus via a sidecar scrape endpoint.

## Lessons from Zylos

The Zylos agent system (which this research supports) uses a PM2-managed Node.js process as its primary runtime. Several patterns from this deployment illustrate real-world tradeoffs:

- **Heartbeat via scheduler**: The activity monitor component sends periodic heartbeat tasks through the task scheduler. If the agent's main loop is blocked, heartbeat tasks accumulate unprocessed and can be detected by an external monitor. This decouples liveness detection from the process supervisor, making it platform-agnostic.
- **Memory flush on SIGTERM**: Before restarting, the agent flushes its in-memory state (session summaries, pending task status) to Markdown files in the memory directory. On next startup, these files are read back in automatically. The result: restarts feel seamless to users because context survives across process boundaries.
- **Exponential backoff**: PM2's `exp_backoff_restart_delay` prevents the agent from hammering the Claude API on startup if it crashes immediately (e.g., due to a temporary API outage). The backoff gives the API time to recover.

## Conclusion

Process supervision for long-running AI agents requires a layered strategy: a process manager (PM2 or systemd) handles the outer restart loop, application-level heartbeats expose the inner health of the event loop, container probes distinguish readiness from liveness, and graceful shutdown logic preserves state across restarts. No single tool covers all of these concerns — the robust production setup combines them.

The key insight that differentiates agent supervision from web service supervision is the stateful nature of the agent: a restart is not a clean slate, and the supervisor design must account for that. Checkpointing, graceful drain, and memory persistence are not optional polish — they are core to maintaining the continuity that makes an autonomous agent useful.

As AI agents move from experimental deployments to production infrastructure, the operational patterns described here will become as fundamental as connection pooling and retry logic are today. The agents that stay running reliably are the ones that get trusted with more work.

---

*Sources: [PM2 Documentation](https://pm2.keymetrics.io/docs/usage/application-declaration/), [PM2 Restart Strategies](https://pm2.keymetrics.io/docs/usage/restart-strategies/), [systemd Watchdog](http://0pointer.de/blog/projects/watchdog.html), [Kubernetes Health Checks](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/), [Express.js Graceful Shutdown](https://expressjs.com/en/advanced/healthcheck-graceful-shutdown.html), [Node.js Graceful Shutdown Guide](https://oneuptime.com/blog/post/2026-01-06-nodejs-graceful-shutdown-handler/view), [Kubernetes Liveness Probe Best Practices](https://www.groundcover.com/blog/kubernetes-liveness-probe), [PM2 Monitoring in Production](https://medium.com/@zmrfzn/monitoring-pm2-in-production-295e234edbbe)*
