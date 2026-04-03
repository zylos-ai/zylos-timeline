---
date: "2026-04-03"
title: "Dual-Layer State Machines for AI Agent Process Monitoring"
description: "How orthogonal state dimensions — activity state and health state — enable richer, more actionable monitoring for long-running AI agent processes."
tags:
  - research
  - ai
  - architecture
  - state-machines
  - monitoring
  - process-supervision
  - statecharts
---

## Executive Summary

Traditional process monitoring answers a single binary question: is the process running? For a web server, this is often sufficient. For a long-running AI agent, it is deeply insufficient. An agent can be running, passing all health checks, and consuming API credits at ten times the expected rate while producing no useful output — a failure mode invisible to conventional supervision.

The solution is not more metrics but a better state model. By decomposing a process's observable state into two orthogonal dimensions — **activity state** (what is the process doing right now?) and **health state** (is the process fit to continue?) — a monitor gains independently actionable signal. Each dimension drives different response policies: activity anomalies trigger alerting and throttling, health failures trigger restarts or isolation. Conflating the two into a single "up/down" signal produces ambiguous alerts and incorrect recovery actions.

This pattern is not new. Kubernetes has encoded it in its three-probe model (startup, liveness, readiness) since 2018. Statechart theory formalised it as orthogonal regions in the 1980s. Erlang/OTP's supervision model implicitly relies on it. What is new is the explicit application to AI agent runtimes, where the failure modes are subtler — zombie loops, context saturation, tool-call hangs, silent subagent failures — and where a restart is expensive in both cost and context.

Key takeaways:

- Activity state and health state are orthogonal concerns and should be modelled as parallel state machines, not a single boolean
- The "alive" signal from a process-level heartbeat does not imply "productive" — work-loop heartbeats are required to detect zombie agents
- Kubernetes's liveness/readiness separation is a real-world dual-layer model; the same logic applies inside AI agent runtimes
- Orthogonal statechart regions scale state-space compression: modelling N independent binary dimensions requires 2 states and N transitions per dimension, versus 2^N flat states
- Different state combinations drive different recovery actions: a healthy but idle agent is different from an unhealthy but active one
- Token consumption per cycle is a high-signal health indicator specific to LLM agents, absent from all generic monitoring frameworks

---

## The Problem With Single-Dimension Monitoring

Every process supervision framework starts from the same primitive: is the process alive? PM2 checks whether the Node.js process is running and restarts it on exit. Systemd watches the main PID and reruns the unit on failure. Kubernetes's earliest health model was a single liveness probe.

This works when process death is the dominant failure mode. For AI agents, it is not.

Consider the failure modes that do not kill the process:

**Zombie loops.** An agent enters a repair loop — parse LLM response, detect malformed output, ask LLM to fix it, receive the same malformed output — and cycles indefinitely. The process is running. The event loop is active. The health endpoint returns `200 OK`. Token consumption is 100× normal. No error is logged. From the outside, the agent looks healthy.

**Tool-call hangs.** An HTTP call to a downstream API stalls with no timeout configured. The agent's main coroutine suspends and never resumes. The process-level heartbeat, running on a background thread, continues firing. The supervisor sees a live process. The agent has stopped working.

**Subagent black holes.** A parent agent spawns child tasks and awaits their completion. The child tasks fail silently. The parent waits indefinitely, consuming no CPU, filing no errors, appearing dormant but not dead.

**Context saturation.** After thousands of turns, the agent's context window is full. Further reasoning is degraded or truncated. The process is alive. Each request returns a response. But the quality of the output has collapsed — a failure mode with no numeric signal in a flat monitoring model.

In each case, a binary "alive/dead" model produces a false negative. The agent is alive but not healthy, or healthy but not active, or active but not productive. A monitor that cannot distinguish these states cannot respond correctly.

---

## The Two Dimensions

A well-designed process monitor for an AI agent tracks two orthogonal dimensions.

### Activity State

Activity state describes what the process is currently doing. It is a coarse-grained workflow position:

- **Idle** — process is running, no work in progress
- **Processing** — actively executing a task
- **Waiting** — blocked on an external call (API, tool, subagent)
- **Draining** — completing in-flight work before shutdown
- **Initialising** — startup sequence not yet complete

Activity state transitions are driven by work events: task arrival, tool invocation, response receipt, shutdown signal. The monitor's job is to observe that these transitions happen within expected time bounds. An agent stuck in `Waiting` for more than the expected timeout has a problem. An agent that has been `Idle` for longer than its configured heartbeat interval may have lost its work source.

### Health State

Health state describes whether the process is fit to serve work:

- **Healthy** — all subsystems nominal
- **Degraded** — operating with reduced capability (context near limit, elevated error rate, dependency partially unavailable)
- **Unhealthy** — subsystem failure; should not receive new work
- **Unknown** — health cannot be determined (probe failure, silent startup)

Health state transitions are driven by probe results: heartbeat receipt, error rate thresholds, memory usage, token consumption per cycle. Health state does not depend on whether the process is currently active — a process can be `Healthy` and `Idle` simultaneously, or `Degraded` and `Processing`.

### Why Orthogonal?

These dimensions are orthogonal: each can take any value independently. A process can be:

- `Idle` and `Healthy` — normal standby
- `Processing` and `Healthy` — normal operation
- `Processing` and `Degraded` — working but signalling problems
- `Processing` and `Unhealthy` — must be interrupted
- `Idle` and `Unhealthy` — process has failed without dying
- `Waiting` and `Unhealthy` — a tool call is hung and health has collapsed

The recovery action depends on the combination, not on either dimension alone. An `Idle + Unhealthy` process needs a restart. A `Processing + Degraded` process needs an alert and a soft warning, but not interruption. A `Waiting + Unhealthy` process needs its in-flight call cancelled and a restart. None of these can be expressed with a single state variable.

---

## Statechart Theory: Orthogonal Regions

This design maps directly onto the UML statechart concept of **orthogonal regions**, introduced by David Harel in 1987 and standardised in UML 2.x.

An orthogonal composite state contains multiple regions that are all active simultaneously. Events arriving at the parent state are dispatched to all regions in parallel. Each region processes the event according to its own state.

```
┌──────────────────────────────────────────────────┐
│                  AgentProcess                    │
│                                                  │
│  ┌──── ActivityRegion ───┐  ┌── HealthRegion ──┐ │
│  │                       │  │                  │ │
│  │  Idle ──► Processing  │  │  Healthy         │ │
│  │            │          │  │    │             │ │
│  │       Waiting ◄──┘    │  │  Degraded        │ │
│  │            │          │  │    │             │ │
│  │         Draining      │  │  Unhealthy       │ │
│  └───────────────────────┘  └──────────────────┘ │
└──────────────────────────────────────────────────┘
```

The state space is the Cartesian product of the two regions: 5 activity states × 4 health states = 20 possible combined states. The statechart models this with 9 states and the appropriate transitions in each region, rather than 20 flat states and their combinatorial transition set.

Miro Samek formalised a related pattern — the **Orthogonal Component** — for embedded systems: rather than full orthogonal regions sharing a thread, independent state machines are composed as objects within a container that dispatches events to each in sequence. This produces the same modelling benefit with simpler implementation, at the cost of strict concurrency.

XState, the leading JavaScript statechart library, exposes this as `type: 'parallel'`. A parallel state node activates all its child regions simultaneously, and the state value becomes an object containing each region's current state:

```typescript
const agentMonitor = createMachine({
  type: 'parallel',
  states: {
    activity: {
      initial: 'idle',
      states: {
        idle: { on: { TASK_RECEIVED: 'processing' } },
        processing: {
          on: {
            TOOL_CALL: 'waiting',
            TASK_COMPLETE: 'idle',
          }
        },
        waiting: {
          on: {
            RESPONSE_RECEIVED: 'processing',
            TIMEOUT: '#agentMonitor.health.unhealthy',
          }
        },
        draining: {
          on: { DRAINED: 'idle' }
        }
      }
    },
    health: {
      initial: 'healthy',
      states: {
        healthy: {
          on: {
            HEARTBEAT_MISSED: 'degraded',
            TOKEN_SPIKE: 'degraded',
          }
        },
        degraded: {
          on: {
            HEARTBEAT_RESTORED: 'healthy',
            CONSECUTIVE_ERRORS: 'unhealthy',
          }
        },
        unhealthy: {
          type: 'final',
          entry: 'triggerRestart',
        }
      }
    }
  }
});
```

The composite state value at any moment is `{ activity: 'waiting', health: 'degraded' }` — unambiguous and directly actionable.

---

## Production Precedent: Kubernetes Probes

Kubernetes's health probe model is the most widely deployed dual-layer monitoring system in production. It was not designed for AI agents, but its architecture directly implements the same principle.

The three probe types represent independent state dimensions:

**Startup probe** answers: has the process completed initialisation? Until this probe succeeds, no other checks run. This prevents a healthy-but-slow-to-start process from being killed in a restart loop.

**Liveness probe** answers: is the process alive in a functional sense? This is not OS-level liveness (the kubelet already knows if the process exited) but application-level: can the process respond to a request? A failed liveness probe triggers a container restart.

**Readiness probe** answers: should this process receive traffic? This is independent of liveness. A process can be live but not ready (warming up a cache, reconnecting to a database, temporarily overwhelmed). A failed readiness probe removes the pod from the service's endpoint pool without restarting it.

The separation is precise:

| Dimension | Probe | Failure Action |
|-----------|-------|---------------|
| Initialised? | Startup | Block other probes; restart if exceeded |
| Alive? | Liveness | Restart container |
| Ready for work? | Readiness | Drain traffic; do not restart |

Two processes can have the same "alive" status but different "readiness" status. A cluster of pods can be partially ready during a rolling deployment. These states cannot be represented by a single health boolean.

Spring Boot 2.3+ exposes the same model via its `ApplicationAvailability` API, surfacing separate `/actuator/health/liveness` and `/actuator/health/readiness` endpoints, each independently controllable by the application. Components can publish readiness failures during graceful shutdown to drain traffic before the process exits.

---

## Applying the Model to AI Agents

The general pattern maps to AI agent specifics with modest adaptation.

### Work-Loop Heartbeats

The critical insight from production AI agent monitoring is that process-level heartbeats are insufficient. A heartbeat running on a background timer proves the event loop is alive, not that work is progressing.

The correct instrumentation is a **work-loop heartbeat**: a signal emitted from within the main processing loop, not from a background thread. If the main loop stalls — on a hung tool call, an unresolvable LLM response, a blocked subagent — the work-loop heartbeat stops. An external monitor comparing the work-loop heartbeat timestamp against the current time detects the stall within one heartbeat interval, regardless of whether the process appears alive from outside.

```typescript
// Background timer heartbeat — does NOT detect work-loop stalls
setInterval(() => heartbeatStore.write({ ts: Date.now() }), 5000);

// Work-loop heartbeat — detects stalls inside the main loop
async function processTask(task: Task) {
  heartbeatStore.write({ ts: Date.now(), phase: 'received' });

  const toolResult = await callTool(task.tool, task.params);
  heartbeatStore.write({ ts: Date.now(), phase: 'tool_complete' });

  const llmResponse = await llm.complete(toolResult);
  heartbeatStore.write({ ts: Date.now(), phase: 'llm_complete' });

  return llmResponse;
}
```

The external monitor checks time-since-last-heartbeat. If it exceeds the configured threshold, the activity state transitions to `Waiting` and health starts degrading.

### Token Consumption as Health Signal

For LLM agents, token usage per cycle is a high-signal health indicator with no analogue in generic monitoring frameworks. A zombie loop does not spike CPU (the agent is I/O-bound, waiting for LLM responses). It does not increase memory. It does not log errors. But it reliably increases token cost per completed unit of work by 10–100×.

Tracking tokens-per-task-completion, and alerting when this exceeds a configurable multiple of the rolling baseline, catches zombie loops that all other signals miss. This belongs in the health dimension — it indicates whether the agent is operating efficiently, not whether it is alive.

### Context Saturation

An agent approaching its context limit is in a `Degraded` health state. It is alive, it is processing, but its reasoning quality is declining. The appropriate response is soft: log a warning, consider summarising or truncating the context, route new tasks to a fresh instance if available. It should not trigger a restart.

Context saturation maps cleanly to the `Degraded` health state: operational but impaired. Monitoring systems that collapse all failure modes into a binary fail to represent this state at all.

### Recovery Decision Matrix

The value of the dual-layer model is that it produces unambiguous recovery decisions:

| Activity | Health | Response |
|----------|--------|----------|
| Idle | Healthy | Normal — no action |
| Processing | Healthy | Normal — no action |
| Processing | Degraded | Alert; emit warning; do not interrupt |
| Waiting | Degraded | Alert; start timeout countdown |
| Waiting | Unhealthy | Cancel in-flight call; restart |
| Idle | Unhealthy | Restart (process has failed without dying) |
| Processing | Unhealthy | Graceful interrupt; restart |
| Draining | Degraded | Monitor; allow drain to complete |
| Draining | Unhealthy | Force restart; accept in-flight loss |

No row in this matrix can be handled correctly by a single-state monitor. The combination is what determines the action.

---

## Implementation Patterns

### Pattern 1: Externalised State Store

The activity state and health state should be written to an external store — a file, a Redis key, a SQLite table — not held only in process memory. When the monitor is an external process (a watchdog, a Kubernetes probe, a PM2 module), it cannot read the supervised process's memory.

An external state store also enables restarts to read the last known state, supporting resumable agents that pick up from their last activity rather than restarting cold.

```typescript
interface AgentState {
  activityState: 'idle' | 'processing' | 'waiting' | 'draining';
  healthState: 'healthy' | 'degraded' | 'unhealthy';
  lastHeartbeat: number;        // Unix ms
  lastWorkLoopHeartbeat: number; // Unix ms — distinct from process heartbeat
  currentTaskId: string | null;
  tokensThisCycle: number;
  errorCountWindow: number;
}
```

### Pattern 2: Guardian as Observer

The external monitor (Guardian, watchdog, supervisor) should be a pure observer of the state store. It does not produce state — it reads state and decides actions. This decouples the supervised process from the monitoring logic and allows the Guardian to restart without losing state knowledge.

```typescript
class Guardian {
  async evaluate(state: AgentState): Promise<Action> {
    const heartbeatAge = Date.now() - state.lastWorkLoopHeartbeat;

    if (heartbeatAge > UNHEALTHY_THRESHOLD_MS) {
      return { type: 'restart', reason: 'work-loop-stall' };
    }

    if (heartbeatAge > DEGRADED_THRESHOLD_MS) {
      return { type: 'alert', severity: 'warning', reason: 'slow-work-loop' };
    }

    if (state.tokensThisCycle > TOKEN_BUDGET_MULTIPLIER * rollingAvg.tokens) {
      return { type: 'alert', severity: 'critical', reason: 'token-spike' };
    }

    if (state.activityState === 'waiting' && state.healthState === 'unhealthy') {
      return { type: 'cancel_and_restart', reason: 'hung-tool-call' };
    }

    return { type: 'no_op' };
  }
}
```

### Pattern 3: State-Driven Message Routing

Activity state can drive message routing decisions. A router that knows the agent is `Draining` can buffer incoming tasks rather than delivering them to a shutting-down agent. A router that sees the agent is `Processing` can apply backpressure or queue depth limits. This separates routing policy from agent implementation.

---

## Pitfalls

**Collapsing dimensions under operational pressure.** The most common mistake is merging activity and health into a single `status` field with values like `running`, `degraded`, `stopped`. This loses the orthogonality. A `degraded` status is ambiguous: is the process active but unhealthy, or unhealthy and idle? Recovery actions differ.

**Health endpoint on a separate thread.** A health HTTP endpoint that runs on its own thread will continue returning `200 OK` after the main work loop stalls. This is the most common source of false health signals in production. The liveness probe must ultimately derive its signal from the work loop, not a background responder.

**Over-triggering restarts.** A degraded agent is not an unhealthy agent. Restarting on first degradation signals throws away valuable context and resets the agent's warm state. The health dimension should model gradations and only trigger restarts at `unhealthy`, not `degraded`.

**Not accounting for startup.** An agent that needs thirty seconds to initialise should not be liveness-probed until initialisation is complete. Kubernetes solved this with the startup probe; the equivalent in an internal monitor is an `initialising` activity state that suppresses health action until the agent signals readiness.

---

## Conclusion

The dual-layer state model — orthogonal activity and health dimensions — is not a novel theoretical contribution. It is a well-established pattern that process supervision frameworks have independently converged on: Kubernetes probes, Spring Boot availability states, XState parallel regions, Erlang/OTP's separation of process liveness from application health. What is notable is how infrequently AI agent monitors apply it.

Most agent monitoring systems today still report a single status. Agents are "running" or "stopped." When an agent silently loops, consumes budget, and produces nothing, the monitor sees "running" and does nothing. The fix requires three things: a second state dimension, work-loop heartbeats distinct from process-level heartbeats, and a recovery decision matrix that maps state combinations to response policies.

For systems like Zylos's Activity Monitor — where the supervised process is an AI agent with a long-lived context and expensive restart costs — the dual-layer model is not optional engineering. It is the minimum viable monitoring architecture.

---

## References

1. [Liveness, Readiness, and Startup Probes — Kubernetes](https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/) — canonical documentation on Kubernetes's three-probe health model and its design rationale
2. [Parallel States — Stately/XState](https://stately.ai/docs/parallel-states) — XState's implementation of orthogonal regions in statecharts
3. [Parallel State — Statecharts Glossary](https://statecharts.dev/glossary/parallel-state.html) — conceptual definition and state-space compression argument
4. [Scheduler Agent Supervisor Pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/scheduler-agent-supervisor) — distributed systems pattern separating scheduling, execution, and health supervision
5. [Liveness and Readiness Probes with Spring Boot — spring.io](https://spring.io/blog/2020/03/25/liveness-and-readiness-probes-with-spring-boot/) — Spring Boot's dual-state availability model and Kubernetes integration
6. [Why Your AI Agent Health Check Is Lying to You — DEV Community](https://dev.to/clevagent/why-your-ai-agent-health-check-is-lying-to-you-2ib1) — practical failure modes and the work-loop heartbeat pattern for AI agents
7. [How AI Agents Handle Stalled Tasks — DEV Community](https://dev.to/bobrenze/how-ai-agents-handle-stalled-tasks-and-timeouts-lessons-from-my-production-failure-1jj9) — production case study: zombie tasks, checkpoint heartbeats, and externalised state
8. [The Agentic Heartbeat Pattern — Medium](https://medium.com/@marcilio.mendonca/the-agentic-heartbeat-pattern-a-new-approach-to-hierarchical-ai-agent-coordination-4e0dfd60d22d) — hierarchical heartbeat coordination across agent trees
9. [UML State Machine — Wikipedia](https://en.wikipedia.org/wiki/UML_state_machine) — orthogonal regions, Harel statecharts, and the formal basis for concurrent state modelling
10. [Orthogonal Regions — miros](https://aleph2c.github.io/miros/html/othogonalregions.html) — orthogonal component pattern implementation reference
11. [gen_statem Behaviour — Erlang/OTP](https://www.erlang.org/doc/apps/stdlib/gen_statem.html) — Erlang's state machine behaviour supporting complex state data as multiple independent dimensions
12. [PM2 Restart Strategies](https://pm2.keymetrics.io/docs/usage/restart-strategies/) — exponential backoff restart policy and process-level health monitoring
