---
date: "2026-02-18"
title: "AI Agent Session Continuity: Maintaining State Across Restarts and Crashes"
description: "Practical patterns for keeping autonomous AI agents running reliably in production — checkpointing, crash recovery, context reconstruction, and the anti-patterns that kill 24/7 deployments."
tags:
  - research
  - ai-agents
  - production
  - infrastructure
  - reliability
---

## Executive Summary

Running an AI agent in production is not like running a stateless API. An agent accumulates context, makes decisions over time, and interacts with users who expect continuity across sessions. When that agent crashes or restarts — and it will — the question is not whether to handle it, but how well.

The industry has converged on a layered approach: durable execution frameworks handle low-level step recovery, memory systems reconstruct semantic context, and message queues prevent any inbound work from disappearing during gaps. The agents that do this well are invisible to users. The ones that don't silently reset, repeat themselves, or spiral into crash loops.

This article covers the practical patterns — what the best frameworks do, how to build it yourself, and what mistakes to avoid.

---

## The Problem Space

A long-running AI agent faces four distinct failure scenarios, each requiring a different recovery strategy:

- **Planned restarts**: Deployments, config changes, scheduled maintenance. The agent knows it is shutting down.
- **Process crashes**: Out-of-memory, unhandled exceptions, infrastructure failures. No warning, no cleanup.
- **Context overflow**: The conversation history grows until it exceeds the model's context window. The session must be trimmed or rolled over.
- **Hang/timeout**: The agent is alive but stuck — waiting on an external call, a model response, or a loop that never exits.

The underlying challenge is the same across all four: the next session must pick up where the last one left off, without confusing the model, without losing pending work, and ideally without the user noticing anything happened.

---

## Session State Persistence Patterns

### The Checkpoint Model

The gold standard for agent durability is the checkpoint: saving enough state at each meaningful step that recovery can replay from the last known-good point rather than from zero.

LangGraph makes this explicit with its `checkpointer` API. Every node execution in a LangGraph workflow writes a checkpoint to a configured store — SQLite for development, PostgreSQL or DynamoDB for production. On restart, the graph replays from the last checkpoint, skipping steps whose outputs are already persisted.

```python
from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.graph import StateGraph

checkpointer = PostgresSaver.from_conn_string(os.environ["DB_URL"])

graph = StateGraph(AgentState)
# ... add nodes and edges ...
app = graph.compile(checkpointer=checkpointer)

# Every invocation is tied to a thread_id
config = {"configurable": {"thread_id": "session-abc-123"}}
result = await app.ainvoke({"messages": [...]}, config=config)
```

LangGraph supports two durability modes:
- **`sync`**: State is written to the store before the next step begins. Maximum durability, slight performance cost.
- **`async`**: State is written concurrently with execution. Better throughput, small window of exposure during a crash between steps.

For 24/7 production agents, `sync` mode is the right default. The latency overhead is small compared to the cost of replaying a failed multi-step task from scratch.

### DBOS: Database-Native Durable Execution

DBOS takes a more fundamental approach: it stores every step's inputs and outputs directly in PostgreSQL as part of the execution model, not as an afterthought. On restart, DBOS scans for workflows with a `PENDING` status and automatically resumes them.

```python
from dbos import DBOS, workflow, step

@workflow()
def research_agent_workflow(query: str) -> str:
    # Each @step is idempotent — if it already completed,
    # DBOS returns the stored result without re-executing
    search_results = search_web(query)
    analysis = analyze_results(search_results)
    return format_report(analysis)

@step()
def search_web(query: str) -> list[dict]:
    # This will not re-run if the workflow restarts after completion
    return call_search_api(query)
```

The key insight from DBOS is that the execution log *is* the state. There is no separate checkpoint format to design — the workflow history in PostgreSQL is both the audit trail and the recovery mechanism.

### Graceful Shutdown Handoffs

When a restart is planned, agents should write a structured handoff document before shutting down. This is distinct from a checkpoint (which is a machine-readable state snapshot) — a handoff is a human-readable summary optimized for context injection into the next session.

A useful handoff format:

```markdown
## Session Handoff — 2026-02-18T14:32:00Z

### Current State
Working on: User research report for Q1 planning
Progress: Completed data collection (3/5 sources), halfway through synthesis

### Critical Context
- User asked specifically to focus on APAC markets, not global
- Draft stored at: workspace/q1-research-draft.md
- One source (Gartner) returned a 429 — needs retry

### Immediate Next Steps
1. Retry the Gartner data fetch
2. Complete synthesis section
3. Send draft to user for review before finalizing

### Decisions Made
- Excluded EU data (user confirmed out of scope)
- Used 2025 fiscal year boundaries, not calendar year
```

This document gets injected into the next session's system prompt or initial context. The model reads it as working memory rather than conversation history, which means it does not consume the full context budget that replaying the entire conversation would.

---

## Crash Recovery Strategies

### Detecting Crashes vs. Planned Exits

A process crash leaves no cleanup code running. The recovery system needs to detect this externally. Three common approaches:

**Heartbeat monitoring**: The agent writes a timestamp to a shared store every N seconds. A watchdog process checks for stale heartbeats. If the last heartbeat is older than 2× the interval, the agent is presumed dead.

```python
async def heartbeat_loop(store: Redis, agent_id: str, interval: int = 30):
    while True:
        await store.setex(f"heartbeat:{agent_id}", interval * 2, time.time())
        await asyncio.sleep(interval)
```

**Process supervision**: PM2, systemd, or Kubernetes restart the process automatically. The recovery logic runs at startup rather than being triggered externally.

**Execution record status**: DBOS and similar systems mark workflows as `RUNNING`. If the process dies without updating the status to `COMPLETED` or `FAILED`, the next startup finds `RUNNING` workflows and resumes them. This is the cleanest approach because detection and recovery are the same mechanism.

### Avoiding Restart Loops

A crashed agent that immediately crashes again creates an infinite restart loop. This is one of the most damaging production failure modes because it generates noise, burns API quota, and may spam users with repeated notifications.

Required safeguards:

- **Exponential backoff**: First restart after 5s, then 30s, then 2m, then 10m. Never immediate retry on a fresh crash.
- **Crash counter with TTL**: Track restarts in the last hour. If more than N crashes occur, pause and alert rather than continuing to restart.
- **Input isolation**: If the same input causes every crash, the agent must not reprocess it automatically. Route it to a dead-letter queue for human review.

```python
CRASH_THRESHOLD = 3
CRASH_WINDOW_SECONDS = 3600

async def safe_restart(agent_id: str, store: Redis):
    crash_key = f"crashes:{agent_id}"
    crash_count = await store.incr(crash_key)
    if crash_count == 1:
        await store.expire(crash_key, CRASH_WINDOW_SECONDS)

    if crash_count >= CRASH_THRESHOLD:
        await alert_team(f"Agent {agent_id} has crashed {crash_count} times in 1h — pausing")
        return  # Do not restart

    delay = min(5 * (2 ** crash_count), 600)  # Cap at 10 minutes
    await asyncio.sleep(delay)
    await start_agent(agent_id)
```

---

## Context Reconstruction on Startup

### The Startup Sequence

A resuming agent session needs to reconstruct its working context before it can act. The startup sequence matters — loading in the wrong order wastes tokens or produces a confused model state.

A reliable startup order:
1. **Identity and capabilities**: Who the agent is, what tools it has, what it must never do.
2. **Persistent memory**: Long-term facts about users, the environment, and prior decisions.
3. **Current task state**: What was in progress at shutdown — the handoff document or checkpoint summary.
4. **Recent conversation**: The last N turns of user interaction, not the full history.
5. **Pending queue**: Any messages or tasks that arrived during the downtime.

Steps 1 and 2 are usually static or near-static and can be cached. Steps 3-5 are dynamic and must be fetched fresh on every startup.

### Context Compaction

Even without crashes, a long-running session will eventually overflow its context window. The right response is not to truncate from the front (which drops the oldest context, often the most important setup) but to compact.

Compaction involves using the model itself to summarize the oldest N turns of conversation into a compressed summary, then replacing those turns with the summary. This preserves semantic content while freeing context budget.

```python
async def compact_context(messages: list[dict], threshold: int = 80_000) -> list[dict]:
    total_tokens = estimate_tokens(messages)
    if total_tokens < threshold:
        return messages

    # Keep the most recent 20 messages intact
    recent = messages[-20:]
    to_compress = messages[:-20]

    summary_prompt = f"""
    Summarize the following conversation history concisely.
    Preserve: key decisions, user preferences, task state, any explicit facts stated.
    Omit: pleasantries, repeated clarifications, intermediate reasoning steps.

    History:
    {format_messages(to_compress)}
    """

    summary = await llm.complete(summary_prompt)

    return [
        {"role": "system", "content": f"[Context summary from earlier in this session]\n{summary}"},
        *recent
    ]
```

This approach is used by production systems like the Google ADK, which calls this pattern "Context Compaction" — triggered at a configurable token threshold, writing the summary back into the session store before pruning raw events.

### User Notification on Restart

Silent restarts that change agent behavior without informing the user erode trust. Users notice when an agent "forgets" what they discussed, but if they are not told a restart occurred, it reads as the agent being unreliable or inattentive.

Best practice: notify the user when a restart happens and what context was recovered.

```
System restarted after an interruption. I've restored context from your previous
session — we were working on the Q1 research report. I'll pick up from where we
left off. Let me know if anything looks wrong.
```

This is a small message but a meaningful one. It sets correct expectations and gives the user a chance to correct the recovered context if it is wrong.

---

## Message Queue Integration

### Why In-Memory Queues Fail

Most agentic frameworks process incoming messages from in-memory queues or live webhook connections. If the agent restarts, all messages in flight are lost. For low-volume or non-critical agents this is acceptable. For production 24/7 systems it is not.

The minimum viable approach: use a persistent message queue with at-least-once delivery semantics. Redis Streams, RabbitMQ, and AWS SQS all provide this. The key properties required are:

- Messages survive process restarts (written to disk or replicated)
- Messages are only acknowledged after successful processing
- Unacknowledged messages are redelivered after a timeout

```python
# Redis Streams pattern for durable message delivery
async def process_messages(redis: Redis, stream: str, group: str, agent_id: str):
    while True:
        # Read messages assigned to this agent, including unacknowledged ones from crashes
        messages = await redis.xreadgroup(
            groupname=group,
            consumername=agent_id,
            streams={stream: ">"},  # ">" = new messages only; "0" = pending (unacked)
            count=1,
            block=5000
        )

        for stream_name, entries in messages:
            for msg_id, data in entries:
                try:
                    await handle_message(data)
                    await redis.xack(stream, group, msg_id)  # Only ack on success
                except Exception as e:
                    # Message stays pending — will be redelivered on restart
                    log.error(f"Failed to process {msg_id}: {e}")
```

On startup, the agent should also claim and process any pending messages from before the crash:

```python
# Recover unacknowledged messages from before the crash
pending = await redis.xautoclaim(stream, group, agent_id, min_idle_time=60_000)
```

---

## How Frameworks Handle This

### LangGraph

LangGraph's checkpointer is the most mature solution in the open-source ecosystem. The `PostgresSaver` backend provides thread-safe, crash-safe persistence. Each `thread_id` represents a logical conversation that can be resumed across any number of process restarts. The graph framework also handles human-in-the-loop interrupts as a first-class feature — an interrupt is just a checkpoint with a flag that says "wait for human input before continuing."

**Strength**: Deep integration with the graph execution model — no boilerplate required.
**Gap**: Context compaction must be implemented by the user; LangGraph does not manage context window limits automatically.

### Temporal

Temporal approaches the problem from the other direction: the workflow engine, not the agent framework, is responsible for durability. A Temporal workflow is a function that is guaranteed to execute to completion regardless of infrastructure failures. Workers can restart freely — Temporal replays the workflow history to reconstruct state.

```python
@workflow.defn
class AgentWorkflow:
    @workflow.run
    async def run(self, user_id: str, task: str) -> str:
        # Each activity is retried automatically on failure
        context = await workflow.execute_activity(
            load_user_context, user_id, start_to_close_timeout=timedelta(seconds=30)
        )
        result = await workflow.execute_activity(
            run_agent_task, (context, task), start_to_close_timeout=timedelta(minutes=10)
        )
        return result
```

**Strength**: Proven at scale, handles long-running workflows (days/weeks) natively.
**Gap**: Adds operational complexity; requires running the Temporal service alongside your application.

### DBOS

DBOS offers a middle path — durable execution without a separate orchestration service. It stores workflow state in PostgreSQL (which you likely already run) and automatically recovers `PENDING` workflows at startup. It integrates with OpenAI Swarm and Pydantic AI natively.

**Strength**: Minimal infrastructure overhead; crash recovery is automatic with no configuration.
**Gap**: Less mature than Temporal; primarily Python.

### CrewAI and AutoGen

Both frameworks support persistent memory via SQLite or external vector stores, but neither provides first-class checkpoint/resume for multi-step workflows. AutoGen in particular requires external persistence to be bolted on — the framework itself has no checkpoint mechanism. CrewAI's shared crew store provides some continuity for inter-agent state but does not resume interrupted tasks.

For production use, CrewAI and AutoGen are typically paired with LangGraph or Temporal as the durability layer, with the framework handling the agent interaction patterns.

---

## Anti-Patterns

### Cold Start Without Context

The most common mistake: restarting an agent with no memory of the previous session. The agent greets users as if it has never met them, re-asks for preferences it already knows, and cannot continue in-progress tasks. This is not just bad UX — it can cause real harm if the agent is managing ongoing work (monitoring a system, executing a multi-day plan, running an experiment).

**Fix**: Always load at minimum: user profile, current task state, last N conversation turns.

### Silent Restarts

Restarting without informing the user. The user sees subtly different behavior (the agent forgot something, repeated a question, lost track of context) but has no explanation. This reads as flakiness, not infrastructure.

**Fix**: Send a restart notification. Even a short one. Users are forgiving of restarts; they are not forgiving of unexplained confusion.

### Aggressive Context Recovery (Context Stuffing)

Injecting the entire conversation history into the new session to "fully restore context." This burns the context budget immediately, leaves less room for the actual new work, and often confuses the model with stale or contradictory information.

**Fix**: Use a handoff summary, not a history replay. Summarize what matters; discard what does not.

### No Dead-Letter Handling

A message that causes a crash will be redelivered, cause another crash, be redelivered again. Without a dead-letter queue and crash counter, this loop continues indefinitely.

**Fix**: After N failed delivery attempts, move the message to a dead-letter queue and alert a human.

### Trusting Process Uptime as Proxy for Session Continuity

The process being alive does not mean the session is coherent. Context windows overflow, state drifts, in-memory caches go stale. Agents need health checks that verify semantic coherence (does the agent still know what it is supposed to be doing?), not just process liveness.

---

## Practical Architecture for a 24/7 Agent

Combining the patterns above, a production-grade session continuity architecture looks like this:

1. **Execution layer**: DBOS or LangGraph with PostgreSQL checkpointing — every step's output is durable.
2. **Message layer**: Redis Streams or SQS — messages survive restarts, unacknowledged messages are redelivered.
3. **Memory layer**: Structured memory files (identity, state, active tasks) loaded at session start; handoff summary written at shutdown.
4. **Compaction**: Token-budget monitoring with automatic context summarization when approaching 80% of the context window.
5. **Supervision**: PM2 or systemd with exponential backoff restart policy and a crash counter that pages on repeat failures.
6. **User notification**: First message after restart acknowledges the interruption and summarizes recovered state.

No single tool covers all six layers. The frameworks handle layers 1 and 4; the infrastructure handles layer 5; the agent code handles layers 2, 3, and 6. The agents that run reliably 24/7 are the ones that treat all six as requirements, not optional enhancements.

---

*Sources:*
- [LangGraph Durable Execution — LangChain Docs](https://docs.langchain.com/oss/python/langgraph/durable-execution)
- [Durable Execution for Crashproof AI Agents — DBOS](https://www.dbos.dev/blog/durable-execution-crashproof-ai-agents)
- [Persistence in LangGraph — Medium](https://medium.com/@iambeingferoz/persistence-in-langgraph-building-ai-agents-with-memory-fault-tolerance-and-human-in-the-loop-d07977980931)
- [Build Durable AI Agents with LangGraph and Amazon DynamoDB — AWS](https://aws.amazon.com/blogs/database/build-durable-ai-agents-with-langgraph-and-amazon-dynamodb/)
- [Temporal + LangGraph: A Two-Layer Architecture — anup.io](https://www.anup.io/temporal-langgraph-a-two-layer-architecture-for-multi-agent-coordination/)
- [Architecting Efficient Context-Aware Multi-Agent Framework for Production — Google Developers](https://developers.googleblog.com/architecting-efficient-context-aware-multi-agent-framework-for-production/)
- [Session Management — Strands Agents](https://strandsagents.com/latest/documentation/docs/user-guide/concepts/agents/session-management/)
- [Deep Dive into State Persistence Agents in AI — SparkCo](https://sparkco.ai/blog/deep-dive-into-state-persistence-agents-in-ai)
- [How to Add Persistence and Long-Term Memory to AI Agents — The New Stack](https://thenewstack.io/how-to-add-persistence-and-long-term-memory-to-ai-agents/)
- [Mastering LangGraph Checkpointing: Best Practices — SparkCo](https://sparkco.ai/blog/mastering-langgraph-checkpointing-best-practices-for-2025)
