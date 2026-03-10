---
date: "2026-03-10"
title: "Actor Model and Communicating Agent Patterns for AI Multi-Agent Systems"
description: "How classic concurrency models — Actor Model, CSP, coroutines — apply to modern AI multi-agent architectures. Covers message-passing, supervision trees, agent lifecycle, fault tolerance, and real-world implementations."
tags:
  - research
  - multi-agent
  - actor-model
  - concurrency
  - architecture
---

## Executive Summary

The AI industry's shift toward multi-agent systems in 2025-2026 is not a novel engineering challenge — it is a rediscovery of problems that distributed systems research solved decades ago. The Actor Model (1973), Communicating Sequential Processes (1978), and supervision tree patterns from Erlang/OTP (1986) provide battle-tested blueprints for the exact problems AI agent frameworks now face: how agents communicate without corrupting shared state, how to recover when an agent crashes mid-task, how to suspend execution while waiting for human input, and how to coordinate thousands of concurrent agents without deadlocks.

This article maps the classical concurrency foundations onto modern AI agent architectures, comparing how frameworks like LangGraph, CrewAI, AutoGen, and Anthropic's orchestrator-worker pattern implement — or fail to implement — these proven patterns. The goal is practical: if you are designing a multi-agent system where agents need to escalate to parents, communicate with peers, and interact with external systems, understanding the Actor Model is not optional background reading — it is the engineering foundation.

Key findings:

- **Message-passing over shared state** is now the dominant pattern in production multi-agent systems, matching the Actor Model's core principle from 50 years ago
- **Supervision trees** from Erlang/OTP map directly to orchestrator-worker hierarchies in AI agent frameworks, but most frameworks lack proper fault recovery strategies
- **Durable execution** (suspend/resume with checkpointed state) is the critical missing piece — LangGraph's interrupt/resume and Restate's journaled execution are the closest implementations
- **Virtual actors** (Microsoft Orleans) offer the most promising model for AI agents that need managed lifecycle, automatic activation/deactivation, and location-transparent communication

## Classical Foundations

### The Actor Model

The Actor Model, proposed by Carl Hewitt in 1973 and formalized by Gul Agha in the 1980s, defines computation as a collection of independent entities ("actors") that interact exclusively through asynchronous message passing. Each actor has three fundamental capabilities:

1. **Send messages** to other actors it knows about
2. **Create new actors** (spawn)
3. **Define behavior** for the next message it receives (state transition)

The critical constraint: actors share nothing. No shared memory, no global state, no locks. All coordination happens through messages. This constraint, which seemed restrictive when competing with shared-memory threading models, turns out to be exactly what AI agent systems need.

```
Actor A                    Actor B
┌──────────┐              ┌──────────┐
│ State    │   message    │ State    │
│ Behavior │ ──────────>  │ Behavior │
│ Mailbox  │              │ Mailbox  │
└──────────┘              └──────────┘
     │                         │
     │  spawn                  │  send
     v                         v
┌──────────┐              ┌──────────┐
│ Actor C  │              │ Actor D  │
└──────────┘              └──────────┘
```

**Key properties:**

- **Location transparency**: An actor's address is opaque — the sender does not know (or care) whether the recipient is on the same machine, across the network, or has been migrated to a different node
- **Sequential message processing**: Each actor processes messages from its mailbox one at a time, eliminating concurrency bugs within a single actor without any locking
- **No return values**: Sending a message is fire-and-forget. If you need a response, the receiver sends a new message back. This decoupling is what enables true asynchrony

### Communicating Sequential Processes (CSP)

Tony Hoare's CSP model (1978) takes a different approach. Where actors are named entities with mailboxes, CSP uses anonymous processes that communicate through named channels.

| Property | Actor Model | CSP |
|---|---|---|
| Communication | Actor-to-actor (named recipient) | Through channels (named conduit) |
| Messaging | Asynchronous (non-blocking send) | Synchronous (sender blocks until receiver reads) |
| Identity | Actors have identity | Processes are anonymous |
| Buffering | Mailbox queues messages | Channel holds at most one message (unbuffered) |
| Distribution | Natural fit for distributed systems | Primarily single-machine |
| Error model | "Let it crash" + supervision | Channel closure propagation |

Go's goroutines and channels are the most prominent CSP implementation today:

```go
// CSP: anonymous processes communicating through a named channel
results := make(chan SearchResult)

// Spawn anonymous workers — they have no identity
go func() { results <- searchWeb(query) }()
go func() { results <- searchDatabase(query) }()
go func() { results <- searchCache(query) }()

// Collect results through the channel
for i := 0; i < 3; i++ {
    result := <-results  // blocks until a result arrives
    process(result)
}
```

**Why this matters for AI agents:** CSP's synchronous channels provide natural backpressure — a fast producer cannot overwhelm a slow consumer. But the Actor Model's asynchronous mailboxes better match AI agent reality, where LLM calls take variable time and agents must remain responsive while waiting. Most AI agent frameworks have converged on actor-style async messaging, even when they do not explicitly reference the Actor Model.

### Coroutines and Cooperative Scheduling

Coroutines — functions that can suspend and resume execution — provide the third concurrency primitive relevant to AI agents. Unlike threads (preemptive) or actors (message-driven), coroutines yield control cooperatively at explicit suspension points.

Python's `async/await`, Kotlin's coroutines, and JavaScript's generators all implement this pattern. For AI agents, coroutines map naturally to the "tool call" cycle:

```python
async def agent_loop(task):
    while not task.complete:
        # Agent "thinks" — runs LLM inference
        action = await llm.generate(task.context)

        if action.type == "tool_call":
            # Suspend: agent yields while tool executes
            result = await execute_tool(action.tool, action.args)
            task.context.append(result)

        elif action.type == "escalate":
            # Suspend: agent yields, parent agent takes over
            result = await escalate_to_parent(action.reason, task)
            task.context.append(result)

        elif action.type == "delegate":
            # Spawn: create child agent for subtask
            child_result = await spawn_subagent(action.subtask)
            task.context.append(child_result)
```

The insight: an AI agent's execution is fundamentally a coroutine. It runs, hits an I/O boundary (LLM call, tool execution, human approval), suspends, and resumes when the result arrives. Frameworks that model agents as coroutines gain natural suspend/resume semantics.

## Erlang/OTP: The Blueprint That AI Agents Need

### Supervision Trees

Erlang's OTP framework introduced supervision trees — hierarchical structures where parent processes monitor and restart child processes on failure. This "let it crash" philosophy is the most important pattern that AI agent frameworks have yet to fully adopt.

```
                    Application Supervisor
                   /          |            \
           Agent Pool    Tool Executor    Memory Service
           Supervisor     Supervisor       Supervisor
          /    |    \        |    \            |
      Agent  Agent  Agent  Tool  Tool     State Store
        A      B      C    Exec  Exec
```

**Supervision strategies in Erlang/OTP:**

- **one_for_one**: If a child crashes, restart only that child. Use when siblings are independent.
- **one_for_all**: If any child crashes, restart all children. Use when siblings have interdependent state.
- **rest_for_one**: If a child crashes, restart it and all children started after it. Use for sequential dependencies.

**Mapping to AI agents:**

| Erlang Concept | AI Agent Equivalent |
|---|---|
| Supervisor | Orchestrator agent |
| Worker process | Subagent / tool executor |
| one_for_one restart | Retry failed subagent with same task |
| one_for_all restart | Restart entire agent group when shared context is corrupted |
| Escalation | Subagent reports failure to orchestrator for re-planning |
| Max restart intensity | Circuit breaker: stop retrying after N failures |

### The Mailbox Pattern

Every Erlang process has a mailbox — an ordered queue of incoming messages. The process selectively pattern-matches against messages, processing them one at a time. Messages that do not match remain in the mailbox for later processing.

This selective receive pattern is powerful for AI agents:

```erlang
% Erlang-style selective receive for an AI agent
agent_loop(State) ->
    receive
        {task, Task} ->
            NewState = process_task(Task, State),
            agent_loop(NewState);

        {escalation_response, ParentDecision} ->
            NewState = apply_parent_decision(ParentDecision, State),
            agent_loop(NewState);

        {peer_message, FromAgent, Content} ->
            NewState = handle_peer_communication(FromAgent, Content, State),
            agent_loop(NewState);

        {tool_result, ToolName, Result} ->
            NewState = incorporate_tool_result(ToolName, Result, State),
            agent_loop(NewState);

        shutdown ->
            cleanup(State),
            ok
    after 30000 ->
        % Timeout: no messages for 30s, agent can do housekeeping
        agent_loop(maybe_checkpoint(State))
    end.
```

The selective receive allows an agent to prioritize certain message types — for instance, always processing escalation responses before new tasks, or handling shutdown signals immediately regardless of queue depth.

### Process Lifecycle

Erlang processes have a well-defined lifecycle that maps cleanly to AI agents:

1. **Spawn**: Process is created with initial state and behavior. (Agent is instantiated with a system prompt, tools, and initial context.)
2. **Running**: Process consumes messages from its mailbox. (Agent processes tasks, makes LLM calls, uses tools.)
3. **Waiting**: Process blocks on `receive`, consuming no CPU. (Agent is suspended, waiting for external input — human approval, tool result, peer response.)
4. **Linked/Monitored**: Process is connected to its supervisor. (Agent reports status to its orchestrator; failures propagate up.)
5. **Terminated**: Process exits normally or crashes, supervisor is notified. (Agent completes task or fails; orchestrator handles the outcome.)

## Modern AI Agent Implementations

### Anthropic's Orchestrator-Worker Pattern

Anthropic's multi-agent research system provides the clearest bridge between actor model theory and AI agent practice. The architecture uses a lead agent (orchestrator) that spawns 3-5 specialized subagents in parallel:

```
User Query
    │
    v
┌─────────────────────┐
│   Lead Agent (Opus)  │  ← Orchestrator / Supervisor
│   - Analyzes query   │
│   - Develops strategy │
│   - Decomposes tasks  │
└─────┬───┬───┬────────┘
      │   │   │  spawn (parallel)
      v   v   v
   ┌────┐┌────┐┌────┐
   │Sub ││Sub ││Sub │  ← Worker actors
   │ A  ││ B  ││ C  │
   └──┬─┘└──┬─┘└──┬─┘
      │     │     │  return findings
      v     v     v
┌─────────────────────┐
│   Lead Agent         │  ← Synthesize, maybe spawn more
│   - Evaluates results│
│   - Identifies gaps  │
│   - Final synthesis  │
└─────────────────────┘
```

**Actor Model alignment:**

- Each subagent has its own context window (isolated state — no shared memory)
- Communication is through structured messages (task descriptions down, findings up)
- The lead agent acts as a supervisor: if a subagent's results are insufficient, it can spawn replacement agents
- Subagents have no knowledge of each other (no peer-to-peer communication in this architecture)

**What is missing from the Actor Model:**

- No formal supervision strategy (no automatic restart on failure)
- Subagents currently execute synchronously from the lead's perspective — true async execution is planned but not yet implemented
- No mailbox pattern — subagents cannot receive messages after initial task assignment

### Anthropic's Six Composable Patterns

Anthropic defines six building-block patterns for AI agents that map to concurrency primitives:

1. **Prompt Chaining** — Sequential pipeline (CSP channel chain)
2. **Routing** — Message dispatch by type (actor pattern matching / selective receive)
3. **Parallelization** — Fan-out/fan-in (actor spawn + collect)
4. **Orchestrator-Worker** — Dynamic supervision tree
5. **Evaluator-Optimizer** — Feedback loop (cyclic message passing between two actors)
6. **Autonomous Agent** — Self-directed actor with goal-seeking behavior loop

The orchestrator-worker pattern is the most actor-like: the orchestrator dynamically decides which tasks to create and which workers to activate, rather than following a fixed workflow graph.

### LangGraph: State Machines with Checkpoints

LangGraph models agent workflows as directed graphs where nodes are processing steps and edges are transitions. Its key innovation for the actor model comparison is its checkpoint and interrupt system:

```python
from langgraph.graph import StateGraph
from langgraph.checkpoint.postgres import AsyncPostgresSaver

# Define agent as a state machine
graph = StateGraph(AgentState)
graph.add_node("research", research_agent)
graph.add_node("review", human_review)
graph.add_node("synthesize", synthesis_agent)

# Add edges (transitions)
graph.add_edge("research", "review")
graph.add_edge("review", "synthesize")

# Compile with checkpointing — enables suspend/resume
checkpointer = AsyncPostgresSaver(conn)
app = graph.compile(checkpointer=checkpointer, interrupt_before=["review"])

# Execute — graph pauses before "review" node
thread = {"configurable": {"thread_id": "research-42"}}
result = await app.ainvoke(initial_state, thread)
# Agent is now suspended, state persisted to Postgres

# ... hours later, human provides input ...
from langgraph.types import Command
result = await app.ainvoke(
    Command(resume="Approved with edits: ..."),
    thread
)
# Agent resumes from checkpoint
```

**Actor Model mapping:**

- **Nodes** are actors with defined behavior
- **Graph state** is the shared mailbox (but writable by all nodes — this violates actor isolation)
- **Checkpoints** provide the persistence that Erlang processes get from OTP's state recovery
- **Interrupts** implement cooperative suspension (coroutine yield points)
- **Thread IDs** provide actor identity for resumed execution

**The gap:** LangGraph agents communicate through a shared mutable state object, not through messages. This is fundamentally a shared-memory model, not a message-passing model. It works well for linear workflows but becomes harder to reason about as the number of concurrent nodes grows.

### OpenAI Agents SDK: Handoffs as Message Routing

The OpenAI Agents SDK (successor to Swarm) implements a handoff pattern that mirrors actor-style message routing:

```python
from agents import Agent, handoff

# Define specialized agents
refund_agent = Agent(
    name="Refund Specialist",
    instructions="Handle refund requests...",
)

sales_agent = Agent(
    name="Sales Agent",
    instructions="Handle sales inquiries...",
)

# Triage agent routes to specialists via handoffs
triage_agent = Agent(
    name="Triage",
    instructions="Route customer to the right specialist.",
    handoffs=[
        handoff(refund_agent),
        handoff(sales_agent),
        handoff(
            agent=escalation_agent,
            on_handoff=lambda ctx: log_escalation(ctx),
        ),
    ],
)
```

**Actor Model mapping:**

- Agents are actors with named identity
- Handoffs are typed messages that transfer conversation context (like Erlang's process migration)
- The triage agent acts as a router/dispatcher — a common actor pattern
- Escalation handoffs with callbacks implement the supervisor notification pattern

**What is novel:** The handoff transfers the entire conversation context to the receiving agent, which is closer to process migration than message passing. In a pure actor model, you would send a message containing the relevant context, not transfer the entire process state.

### AutoGen: Conversational Actor Groups

Microsoft's AutoGen (now merged with Semantic Kernel as of October 2025) models agents as participants in group conversations — an asynchronous message-passing system:

```python
from autogen import AssistantAgent, GroupChat, GroupChatManager

# Agents as actors with distinct roles
researcher = AssistantAgent("researcher", llm_config=llm_config)
analyst = AssistantAgent("analyst", llm_config=llm_config)
writer = AssistantAgent("writer", llm_config=llm_config)

# Group chat as a message bus
group_chat = GroupChat(
    agents=[researcher, analyst, writer],
    messages=[],
    max_round=12,
)

# Manager as supervisor / orchestrator
manager = GroupChatManager(groupchat=group_chat, llm_config=llm_config)
```

AutoGen's group chat is the closest implementation to actor-style message passing in current AI frameworks. Each agent maintains its own state, receives messages asynchronously, and can address messages to specific peers or broadcast to the group. The GroupChatManager acts as a supervisor, deciding which agent speaks next.

### CrewAI: Role-Based Actor Assignment

CrewAI takes a role-based approach where agents are defined by their expertise, tools, and delegation capabilities:

```python
from crewai import Agent, Task, Crew

researcher = Agent(
    role="Senior Researcher",
    goal="Find comprehensive data on the topic",
    tools=[search_tool, scrape_tool],
    allow_delegation=True,  # Can spawn/delegate to other agents
)

writer = Agent(
    role="Technical Writer",
    goal="Produce clear, accurate content",
    tools=[write_tool],
    allow_delegation=False,  # Leaf worker — no spawning
)

crew = Crew(
    agents=[researcher, writer],
    tasks=[research_task, writing_task],
    process="sequential",  # or "hierarchical" with a manager agent
)
```

In hierarchical mode, CrewAI adds a manager agent that acts as a supervisor — decomposing tasks, delegating to specialists, and synthesizing results. The `allow_delegation` flag determines whether an agent can spawn subtasks to peers, creating a partial supervision tree.

## Critical Patterns for Agent Communication

### Pattern 1: Escalation (Child to Parent)

When a subagent encounters a situation beyond its capabilities, it must escalate to its supervisor. This is the actor model's supervisor notification, inverted:

```
Subagent encounters unknown situation
    │
    ├─ Option A: Fail fast ("let it crash")
    │   └─ Supervisor detects failure, decides restart strategy
    │
    ├─ Option B: Explicit escalation message
    │   └─ Subagent sends {escalate, Reason, Context} to supervisor
    │   └─ Supervisor re-plans and may reassign or handle directly
    │
    └─ Option C: Handoff with context transfer
        └─ Subagent transfers full state to a more capable agent
```

In Anthropic's system, subagents return their findings along with confidence signals, and the lead agent decides whether the results are sufficient or whether additional research is needed. This is implicit escalation through result quality — the lead agent evaluates rather than the subagent explicitly requesting help.

OpenAI's handoff pattern provides explicit escalation: an agent can hand off to an "Escalation Agent" with a structured reason, which gets logged for audit trails.

### Pattern 2: Peer Communication (Sibling to Sibling)

Most current AI agent frameworks do not support direct peer communication. Agents communicate through a shared state (LangGraph), through a group chat manager (AutoGen), or not at all (Anthropic's orchestrator-worker). This is a significant gap.

In actor systems, peer communication is fundamental — any actor can send a message to any other actor whose address it knows. For AI agents, peer communication enables:

- **Information sharing**: A research agent discovers context relevant to a writing agent's task
- **Coordination**: Multiple agents working on overlapping subtasks negotiate to avoid duplication
- **Negotiation**: Agents with conflicting conclusions engage in structured debate

```
┌──────────┐  "I found relevant data"  ┌──────────┐
│ Research  │ ───────────────────────>  │ Writing  │
│ Agent    │                            │ Agent    │
└──────────┘  <───────────────────────  └──────────┘
               "Can you verify source X?"
```

AutoGen's group chat comes closest, allowing agents to address messages to specific peers within a shared conversation. But this is mediated by the GroupChatManager (a supervisor), not direct peer-to-peer messaging.

### Pattern 3: External I/O (Agent to World)

Agents interact with external systems through tool calls — API requests, database queries, file operations, browser automation. In actor model terms, these are messages to external actors (services) with asynchronous response patterns.

The critical challenge is **blocking**: an LLM call takes seconds to minutes, a human approval might take hours or days. During this wait, the agent should not consume compute resources.

**Solutions from classical concurrency:**

- **Non-blocking I/O with futures** (Akka pattern): Agent sends request, receives a future, continues processing other messages. When the future resolves, a result message arrives in the mailbox.
- **Suspend/resume** (coroutine pattern): Agent execution suspends at the I/O point and resumes when the result is available. LangGraph's interrupt/resume implements this.
- **Durable execution** (Restate pattern): The I/O call is journaled. If the agent crashes during the wait, it resumes from the journal without re-executing completed steps.

```typescript
// Restate's durable execution: crash-safe tool calls
const toolResult = await restate_ctx.run("web_search", async () => {
    return await searchAPI.query(searchTerm);
});
// If agent crashes here and restarts, toolResult is replayed
// from the journal — the search is not re-executed

const llmResult = await restate_ctx.run("llm_call", async () => {
    return await llm.generate(prompt + toolResult);
});
// Same: LLM call result is persisted and replayed on recovery
```

### Pattern 4: Lifecycle Management (Spawn/Suspend/Resume/Terminate)

A complete agent lifecycle model, synthesized from actor model patterns and current framework capabilities:

```
                    ┌─────────┐
           spawn    │         │  terminate
        ┌──────────>│ Created │──────────────┐
        │           │         │              │
        │           └────┬────┘              │
        │                │ initialize        │
        │                v                   │
        │           ┌─────────┐              │
        │    ┌─────>│         │──────┐       │
        │    │      │ Running │      │       │
        │    │      │         │      │       │
        │    │      └────┬────┘      │       │
        │    │           │           │       │
        │  resume   suspend     escalate     │
        │    │           │           │       │
        │    │      ┌────v────┐      │       │
        │    │      │         │      │       v
        │    └──────│Suspended│      │  ┌─────────┐
        │           │         │      │  │         │
        │           └─────────┘      └─>│Completed│
        │                               │         │
   ┌────┴─────┐                         └─────────┘
   │Supervisor│
   │ (Parent) │
   └──────────┘
```

**State transitions:**

| Transition | Trigger | Actor Model Equivalent |
|---|---|---|
| Created -> Running | Supervisor spawns agent with task | `spawn_link(Module, init, Args)` |
| Running -> Suspended | Waiting for tool/human/LLM result | Process blocks on `receive` |
| Suspended -> Running | External result arrives | Message delivered to mailbox |
| Running -> Completed | Task finished successfully | Process exits normally |
| Running -> Completed (error) | Unrecoverable failure | Process crashes, supervisor notified |
| Completed -> Created | Supervisor restarts agent | Supervisor restart strategy |

## Virtual Actors: The Most Promising Model for AI Agents

Microsoft Orleans introduced the **virtual actor** model, which addresses the lifecycle management problem that traditional actors leave to the developer. In Orleans, actors ("grains") are:

- **Always conceptually alive**: You never explicitly create or destroy a grain. You reference it by identity, and the runtime activates it on demand.
- **Automatically deactivated**: When a grain has been idle, the runtime removes it from memory. When a new message arrives, it is transparently reactivated.
- **Location-transparent**: The runtime decides which server hosts a grain. If a server fails, grains are automatically reactivated on surviving servers.
- **Single-activation guaranteed**: Only one instance of a grain (per identity) exists at any time, eliminating distributed state conflicts.

This model maps remarkably well to AI agents:

```
Traditional Actor Model          Virtual Actor Model (Orleans)
─────────────────────────        ──────────────────────────────
Developer manages lifecycle      Runtime manages lifecycle
Explicit spawn/terminate         Reference by ID, auto-activate
Manual failover                  Automatic failover
Memory consumed while idle       Deactivated when idle
Location must be known           Location-transparent
```

For a system where thousands of AI agents need to exist — some active, some waiting for human input, some dormant until a scheduled trigger — virtual actors eliminate the operational burden of lifecycle management. An agent referenced by `agent("research-task-42")` would automatically activate when a message arrives, process it, and deactivate if idle, without any orchestration code.

## Fault Tolerance Strategies

### The "Let It Crash" Philosophy

Erlang's signature philosophy — do not write defensive code inside a process; instead, let it crash and have the supervisor handle recovery — is counterintuitive but powerful for AI agents.

**Why it works for AI agents:**

- LLM calls are inherently non-deterministic. A retry often produces a better result than defensive error handling.
- Tool calls can fail for transient reasons (rate limits, network issues). A clean restart with retry is more reliable than complex error recovery logic.
- Agent state can become corrupted (hallucinated context, contradictory information). Restarting with a clean state and the original task is often the best recovery.

**Implementation pattern:**

```python
class AgentSupervisor:
    def __init__(self, max_restarts=3, restart_window=60):
        self.max_restarts = max_restarts
        self.restart_window = restart_window
        self.restart_history = []

    async def supervise(self, agent_factory, task):
        while True:
            agent = agent_factory(task)
            try:
                result = await agent.run()
                return result  # Success
            except AgentError as e:
                self.restart_history.append(time.time())
                # Prune old restarts outside window
                cutoff = time.time() - self.restart_window
                self.restart_history = [
                    t for t in self.restart_history if t > cutoff
                ]
                if len(self.restart_history) > self.max_restarts:
                    # Too many restarts — escalate to parent
                    raise EscalationError(
                        f"Agent failed {self.max_restarts} times: {e}"
                    )
                # Otherwise, let it crash and restart
                log.warning(f"Agent crashed, restarting: {e}")
                continue
```

### Durable Execution for Long-Running Agents

For agents that run for hours or days (research tasks, approval workflows, monitoring), crash recovery must not lose progress. Restate's durable execution pattern journals every side effect:

- Each tool call result is persisted before the agent continues
- On crash, the agent replays from the journal, skipping already-completed steps
- Pending external calls (human approvals, scheduled triggers) survive agent restarts
- The runtime guarantees exactly-once semantics for side effects

This is the distributed systems equivalent of a database transaction log, applied to agent execution.

### Circuit Breakers and Backpressure

When an external service fails repeatedly, agents need circuit breaker patterns to avoid wasting tokens on doomed requests:

```python
class ToolCircuitBreaker:
    CLOSED = "closed"      # Normal operation
    OPEN = "open"          # Failures detected, reject calls
    HALF_OPEN = "half_open"  # Testing if service recovered

    def __init__(self, failure_threshold=5, reset_timeout=60):
        self.state = self.CLOSED
        self.failure_count = 0
        self.failure_threshold = failure_threshold
        self.reset_timeout = reset_timeout
        self.last_failure_time = None

    async def call(self, tool_fn, *args):
        if self.state == self.OPEN:
            if time.time() - self.last_failure_time > self.reset_timeout:
                self.state = self.HALF_OPEN
            else:
                raise CircuitOpenError("Tool unavailable, try later")

        try:
            result = await tool_fn(*args)
            if self.state == self.HALF_OPEN:
                self.state = self.CLOSED
                self.failure_count = 0
            return result
        except Exception as e:
            self.failure_count += 1
            self.last_failure_time = time.time()
            if self.failure_count >= self.failure_threshold:
                self.state = self.OPEN
            raise
```

Backpressure — the ability to slow down message producers when consumers are overwhelmed — is naturally handled by CSP's synchronous channels but requires explicit implementation in actor systems. For AI agents, this means: if the orchestrator spawns more subagents than the system can handle (LLM rate limits, memory constraints), there must be a mechanism to queue or reject new agent requests rather than degrading the entire system.

## Practical Implications for Multi-Agent Architecture Design

### Communication Topology Recommendations

Based on the analysis of classical patterns and current implementations:

**For hierarchical tasks (research, analysis, content creation):**
- Use the orchestrator-worker pattern (Anthropic's approach)
- Orchestrator acts as supervisor with one-for-one restart strategy
- Subagents are isolated workers with no peer communication
- Results flow up; tasks flow down

**For collaborative tasks (debate, code review, planning):**
- Use AutoGen-style group chat with a manager/supervisor
- Enable peer communication through the managed channel
- Manager handles turn-taking, conflict resolution, and termination
- Consider adding explicit escalation paths to a human supervisor

**For long-running workflows (approval chains, monitoring, scheduled tasks):**
- Use LangGraph-style state machines with checkpointing
- Implement suspend/resume at every external I/O boundary
- Persist state to durable storage (Postgres, not in-memory)
- Design for resume-after-days: the agent should reconstruct full context from the checkpoint

**For high-scale agent pools (thousands of concurrent agents):**
- Consider the virtual actor model (Orleans-style)
- Agents activate on demand, deactivate when idle
- Runtime handles placement, migration, and failover
- Identity-based addressing eliminates the need for service discovery

### What Current Frameworks Get Wrong

1. **Shared mutable state instead of message passing.** LangGraph's shared graph state is convenient but violates actor isolation. As the number of concurrent nodes grows, reasoning about state mutations becomes difficult.

2. **No formal supervision strategies.** Most frameworks have ad-hoc error handling. None implement Erlang-style supervision trees with configurable restart strategies, max restart intensity, or escalation chains.

3. **Synchronous subagent execution.** Anthropic's orchestrator-worker and many LangGraph implementations wait for all subagents to complete before proceeding. True actor systems allow the supervisor to process results as they arrive.

4. **Missing backpressure.** No current framework limits the rate of agent spawning based on system capacity. An orchestrator can spawn 50 subagents hitting the same LLM API, causing cascading rate limit failures.

5. **Weak lifecycle management.** Agents are either running or done. The suspended state (waiting for external input without consuming resources) is only partially implemented in LangGraph and Restate, and absent from CrewAI and AutoGen.

### Designing a Communicating Agents Architecture

For a system where agents need escalation, peer communication, and external I/O — like a "shadow clone" architecture where the main agent spawns specialized workers — the recommended design combines patterns from multiple sources:

```
┌───────────────────────────────────────────────┐
│              Message Bus / Event Stream         │
│  (Kafka, Redis Streams, or in-process queue)   │
└──────┬──────────┬──────────┬─────────┬────────┘
       │          │          │         │
  ┌────v────┐┌────v────┐┌───v────┐┌───v────┐
  │Supervisor││  Agent  ││ Agent  ││External│
  │  Agent   ││  Pool   ││ Pool   ││  I/O   │
  │          ││(Research)││(Action)││ Bridge │
  └────┬─────┘└────┬────┘└───┬────┘└───┬────┘
       │           │          │         │
       │     ┌─────v──────┐   │    ┌────v─────┐
       │     │  Subagent   │  │    │  Tools   │
       │     │  Subagent   │  │    │  APIs    │
       │     │  Subagent   │  │    │  Human   │
       │     └─────────────┘  │    └──────────┘
       │                      │
       └─── Supervision ──────┘
            (restart, escalate,
             terminate)
```

**Key design decisions:**

1. **Message bus for all communication.** No shared state. Agents send typed messages through a central bus. This enables logging, replay, and debugging of all agent interactions.
2. **Supervision hierarchy.** Every agent has a supervisor. Supervisors implement configurable restart strategies. Escalation flows up the tree.
3. **Agent pools with backpressure.** Worker agents are pooled. The pool supervisor limits concurrency based on available resources (LLM rate limits, memory, cost budget).
4. **External I/O bridge.** All external interactions go through a dedicated bridge that handles retries, circuit breaking, and durable execution.
5. **Virtual actor lifecycle.** Agents activate on message receipt and deactivate when idle. State is checkpointed to durable storage for resume-after-crash.

## Conclusion

The AI industry is building multi-agent systems by trial and error, when 40 years of distributed systems research has already mapped the territory. The Actor Model provides the communication and isolation primitives. Erlang/OTP provides the supervision and fault tolerance patterns. CSP provides backpressure and synchronization. Durable execution frameworks provide crash recovery for long-running agents. Virtual actors provide lifecycle management at scale.

The frameworks that will win the multi-agent race are not the ones with the best LLM integration — they are the ones that correctly implement these proven concurrency patterns. The current generation (LangGraph, CrewAI, AutoGen, OpenAI Agents SDK) each implement fragments of the actor model. The next generation needs to implement it completely: isolated state, asynchronous message passing, supervision trees with configurable strategies, durable execution with checkpointing, and virtual actor lifecycle management.

For practitioners designing multi-agent systems today, the actionable advice is: study Erlang/OTP before studying LangChain. The patterns you need were invented in 1986.

---

*Sources: Anthropic Engineering Blog, Akka Documentation, Erlang/OTP Design Principles, Microsoft Orleans Documentation, Restate Developer Documentation, LangGraph Documentation, OpenAI Agents SDK Documentation, Carl Hewitt's Actor Model papers, Tony Hoare's Communicating Sequential Processes*
