---
date: "2026-03-11"
title: "Deterministic Governance in AI Agent Systems"
description: "Rule engines, state machines, and hybrid LLM-kernel architectures for building reliable, auditable agent governance layers"
tags: ["ai-agents", "governance", "state-machines", "rule-engines", "rust", "capability-security", "deterministic-systems"]
---

## Executive Summary

The central challenge in production multi-agent systems is that LLMs are probabilistic by nature — they reason through problems, not past them. When a system must make hard decisions (deny a capability, terminate a process, enforce a budget), probabilistic reasoning introduces unacceptable variance. Adversarial users can craft prompts that shift a model's judgment. Garbage-in reasoning corrupts the control plane. This is why a deterministic governance kernel — sitting *beneath* the LLM layer — is architecturally necessary for any agent system operating at production reliability standards.

The field is converging on a hybrid architecture: a deterministic kernel handles lifecycle, security, permissions, and scheduling using rule engines and state machines, while LLM advisors handle soft semantic decisions that require contextual judgment. The kernel enforces; the LLM advises. This separation of concerns maps cleanly to how operating systems are built — a privileged kernel with strict invariants, user-space processes that can fail without corrupting system state.

Two intellectual lineages inform this architecture most directly. First, the Erlang/OTP actor model — designed for telecoms in 1986, now being rediscovered by every Python agent framework independently — provides supervision trees, preemptive scheduling, process isolation, and fault recovery as first-class runtime primitives. Second, the object-capability security model (OCap) provides a rigorous mathematical basis for least-privilege enforcement: capabilities are unforgeable tokens that grant access, and holding a capability is the only way to exercise it. Rust's type system can enforce OCap constraints at compile time, eliminating entire classes of runtime permission violations.

For teams building Rust-based agent runtimes, the convergence of these ideas suggests a concrete architecture: a Tokio-based async runtime for scheduling, a statechart engine (W3C SCXML-derived) for process lifecycle, an OPA-equivalent policy engine embedded or sidecarred for runtime decisions, and capability types at the API boundary that are issued by a governor and verified at every tool invocation. The sections below ground each of these components in current research, production examples, and implementation patterns.

---

## 1. Rule Engines for Agent Governance

### The Problem Space

Agent governance requires policy evaluation at runtime: should this agent be allowed to call this tool? Has this request exceeded its budget? Does this output violate a safety policy? These decisions need to be fast, consistent, and auditable. Rule engines are the classical answer to this class of problem.

### Open Policy Agent (OPA) and Rego

OPA has emerged as the industry-standard framework for policy-as-code in cloud-native systems, and its model maps directly to agent governance. OPA decouples policy logic from application logic: the application sends a structured query ("is this agent allowed to call this tool with these arguments?"), and OPA evaluates against a policy written in Rego (a declarative language derived from Datalog) and returns a decision.

For agent governance, the key OPA deployment patterns are:

**Policy Decision Points (PDPs):** The rule engine that evaluates agent actions against policies before execution. Every tool call is intercepted, evaluated, and either permitted or denied. This is the enforcement point in the critical path.

**Policy Enforcement Points (PEPs):** Gatekeepers embedded in the agent runtime (API gateway, tool dispatcher, capability issuer) that consult the PDP and block execution on denial. In a Rust runtime, this would be a middleware layer wrapping every `Tool::execute()` call.

**Centralized vs. Distributed:** For low-latency enforcement, OPA can run as an in-process library (via the Rust `opa` bindings or WASM compilation of OPA policies) rather than a network sidecar. This eliminates the network round-trip for every policy evaluation — critical when agents invoke tools in tight loops.

A governance Rego policy for tool access might look like:

```rego
package agent.governance

default allow = false

allow {
    input.agent.capability_level >= required_capability_level[input.tool.name]
    not budget_exceeded
    not tool_in_blocklist[input.tool.name]
}

budget_exceeded {
    input.agent.tokens_consumed > data.budgets[input.agent.id].token_limit
}
```

The GitOps integration pattern is particularly powerful: policies are version-controlled, reviewed, and tested in CI before deployment. When a new security requirement emerges (e.g., "no agent may call filesystem tools unless in sandbox mode"), the policy is updated in a PR, reviewed, tested against a policy test suite, and deployed — with full audit history. This contrasts sharply with embedded rule logic scattered across agent code.

### Drools and Forward-Chaining Inference

Drools (JBoss Rule Engine) uses the Rete algorithm for forward-chaining production rule evaluation. Where OPA excels at single-point policy decisions (allow/deny), Drools excels at complex event processing and multi-condition inference over stateful fact sets. For agent governance, this matters when decisions depend on accumulated history: "if this agent has called tool X more than 5 times in the last 60 seconds AND the last 3 calls returned errors, THEN suspend the agent and alert the supervisor."

Clara Rules (Clojure) applies the same Rete-based approach with a functional, immutable data model — an interesting fit for pure-function rule evaluation in agent pipelines.

### Rust-Native Rule Engines

The Rust ecosystem has several rule engine crates at varying maturity levels. The `rule-engine` crate provides a basic forward-chaining engine. For production use, the more pragmatic approach is to compile OPA policies to WASM and execute them via the Rust `wasmtime` runtime — this gives you OPA's full Rego expressiveness with zero network overhead and sandboxed execution. The WASM isolation also means a malformed policy cannot crash the host process.

---

## 2. State Machine Patterns for Agent Process Lifecycle

### Why State Machines Are the Right Model

An agent process is not a simple function call — it has a lifecycle: it is created, initialized, runs (potentially transitioning through idle, active, and waiting states), can be suspended and resumed, can block on external events, and eventually terminates (normally or by force). This lifecycle is exactly what finite state machines formalize. State machines make illegal state transitions unrepresentable, which is the strongest possible enforcement: the governor cannot accidentally put an agent into an invalid state because the type system refuses to compile such a transition.

### Hierarchical State Machines (HSMs) and Statecharts

Flat FSMs break down for complex lifecycles because they suffer from "state explosion" — the number of states grows combinatorially with the number of independent dimensions. Hierarchical State Machines (HSMs), as formalized in David Harel's statecharts (1987) and codified in W3C SCXML, solve this by allowing states to contain substates and inherit transitions.

For an agent process governor, a sensible statechart hierarchy looks like:

```
AgentProcess
├── Initializing
│   ├── CapabilityNegotiation
│   └── ResourceAllocation
├── Running
│   ├── Active       (currently executing a task)
│   ├── Idle         (awaiting a task)
│   └── Waiting      (blocked on external I/O)
├── Suspended        (paused by governor)
│   ├── UserPaused
│   └── BudgetExhausted
└── Terminated
    ├── Completed
    ├── Failed
    └── Killed
```

Transitions between states are events: `TaskAssigned` moves `Idle → Active`, `BudgetExceeded` moves `Active → BudgetExhausted` (a substate of `Suspended`), `Kill` moves any Running substate directly to `Terminated.Killed`. Entry and exit actions on states handle side effects: entering `Suspended` logs the event and freezes resource consumption, exiting `Terminated` releases capability tokens and notifies the supervisor.

### Rust Statechart Crates

Several Rust crates implement SCXML-derived statecharts:

- **`statechart`** (docs.rs/statechart): A document model and interpreter derived from W3C SCXML. Provides a full statechart executor with parallel states, history states, and event queuing.
- **`rustate`**: Inspired by XState (the dominant JavaScript statechart library), adapted for Rust idioms.
- **`obel_statechart`**: A direct port of XState concepts into Rust, useful if the team already thinks in XState terms.
- **`scdlang_xstate`**: A parser for the Scdlang statechart description language that can transpile to multiple targets including XState and Rust.

For a governor implementation, `statechart` or a bespoke implementation using Rust enums is the right starting point. Rust enums naturally model state machines — each variant is a state, transitions are `match` expressions on the enum, and the compiler enforces exhaustive handling:

```rust
enum AgentState {
    Initializing(InitContext),
    Running(RunContext),
    Suspended { reason: SuspendReason, since: Instant },
    Terminated(TerminationResult),
}

impl AgentProcess {
    fn apply_event(&mut self, event: GovernorEvent) -> Result<(), GovernanceError> {
        match (&self.state, event) {
            (AgentState::Running(_), GovernorEvent::BudgetExhausted) => {
                self.state = AgentState::Suspended {
                    reason: SuspendReason::BudgetExhausted,
                    since: Instant::now(),
                };
                self.emit_audit_event(AuditEvent::StateTrans { reason: "budget" });
                Ok(())
            }
            // ... other transitions
            (state, event) => Err(GovernanceError::InvalidTransition { state, event }),
        }
    }
}
```

The invalid transition path is critical: the governor should never silently accept events that don't apply. Surfacing invalid transitions as errors (or panics in debug mode) catches bugs in the event dispatch logic early.

### LangGraph and AutoGen as Statechart Analogues

LangGraph (Python) models agent workflows as directed graphs with state machines — nodes are agent steps, edges define transitions, and conditional routing implements guard conditions. AutoGen v0.4 rebuilt its core as an event-driven actor framework. Both frameworks are independently rediscovering statechart patterns, but implementing them at the application layer without runtime-level guarantees. A Rust governor kernel provides those guarantees at a lower level, decoupled from whichever agent framework sits above it.

---

## 3. Hybrid LLM + Deterministic Kernel Architectures

### The Core Design Principle

The fundamental insight driving hybrid architectures is that LLM guardrails are behavioral suggestions, not enforcement mechanisms. They operate through learned patterns and are vulnerable to adversarial optimization. Deterministic guardrails are absolute: they operate outside language manipulation and cannot be jailbroken through clever prompting.

The production pattern, synthesized from multiple real-world deployments in 2025-2026, is:

```
User/External Request
        │
        ▼
┌───────────────────────┐
│  Deterministic Layer  │  ← Hard rules, zero tolerance
│  - Input validation   │     (OPA/Rego, type checking,
│  - Capability check   │      schema validation)
│  - Rate limiting      │
└───────────┬───────────┘
            │ (permitted)
            ▼
┌───────────────────────┐
│    LLM Advisor Layer  │  ← Semantic judgment, context
│  - Contextual eval    │     (model-level guardrails,
│  - Intent assessment  │      Constitutional Classifiers,
│  - Action planning    │      fine-tuned safety models)
└───────────┬───────────┘
            │ (advised action)
            ▼
┌───────────────────────┐
│  Deterministic Layer  │  ← Output validation, side-
│  - Output validation  │     effect authorization before
│  - Action gating      │     any external state change
│  - Audit logging      │
└───────────────────────┘
```

The LLM layer sits *between* two deterministic enforcement points. It cannot bypass the outer shell; it can only influence the action plan within the space of actions the deterministic layer permits.

### Anthropic's Constitutional Classifier Architecture

Anthropic's production safety architecture (ASL-3 Deployment Safeguards, 2025) illustrates the hybrid model at scale. The system uses a two-stage architecture:

1. **Lightweight probe** on every request that examines Claude's internal activations (not just token outputs) to screen for suspicious exchanges. This is a deterministic signal — a learned but fixed classifier, not a generative model — that runs at low cost (~1% additional compute).

2. **Escalation classifier** invoked on flagged exchanges — a more powerful model that examines both sides of a conversation to detect jailbreak attempts that evolve across turns.

The key design insight: the safety layer is architecturally separate from the response-generating model. Claude can be jailbroken at the model level, but the Constitutional Classifier catches outputs before they reach the user. The 2026 constitution update further separates *hardcoded behaviors* (absolute prohibitions — CBRN assistance, CSAM, undermining AI oversight) from *softcoded defaults* (operator-adjustable within defined limits). This is exactly the separation between governance kernel (hardcoded) and policy layer (softcoded).

### Control Plane Architecture

The CIO-documented "agent control plane" pattern wraps LLM agents in a rigid deterministic code layer that intercepts outputs before they touch enterprise systems:

```
LLM Agent Output
       │
       ▼
┌─────────────────────────────┐
│     Control Plane           │
│  1. Schema validation       │
│  2. Permission check        │  ← All deterministic
│  3. Rate limit check        │
│  4. Anomaly detection       │
│  5. Audit log write         │
└──────────┬──────────────────┘
           │ (all checks pass)
           ▼
    Execute Action
```

Only if all deterministic checks pass does the control plane execute the action against enterprise systems. This architecture means the LLM's output is treated as untrusted input — exactly as web application firewalls treat user input.

### Determinism-First in Mission-Critical Domains

Volt Active Data's 2026 "Determinism-First" architecture for telco/fintech AI establishes ACID-compliant transactional decisioning as the baseline, with LLM reasoning layered on top. The pattern: deterministic stream processing handles state and sequencing (guaranteed order, at-most-once or exactly-once semantics), while LLMs handle classification and judgment within each transaction. If the LLM advisor is unavailable, the deterministic kernel falls back to conservative defaults — the system degrades gracefully rather than failing open.

---

## 4. Capability-Based Security Enforcement

### Object Capability Model (OCap) Fundamentals

The object-capability model is a security paradigm where authority to perform an action is represented by an unforgeable reference (a "capability") to an object that provides that action. The key properties:

- **No ambient authority:** A process cannot access any resource it wasn't explicitly given a capability for. There is no `open("/etc/passwd")` — only `file_handle.read()` where `file_handle` is a capability you were granted.
- **Principle of least privilege by construction:** You can only grant capabilities you already hold. Capabilities cannot be synthesized from nothing.
- **Attenuation:** You can grant a *restricted* version of a capability you hold. A governor can give an agent a file handle that is read-only, or rate-limited, or scoped to a specific directory.
- **Unforgeable:** Capabilities are opaque tokens. An agent cannot construct a capability to a resource it wasn't given one for — there is no "guess the path" attack.

### Rust Type System as Capability Enforcer

Rust's ownership and type system provides a natural substrate for compile-time capability enforcement. The pattern:

```rust
// Capabilities are zero-sized types or wrapper structs — unforgeable at compile time
pub struct FileReadCapability(PathBuf);
pub struct NetworkCapability { allowed_hosts: Vec<String> }
pub struct ToolCallCapability { tool_id: ToolId, rate_limit: RateLimit }

// Governor issues capabilities — the only way to construct them
impl Governor {
    pub fn issue_file_read(&self, path: PathBuf, agent: &AgentId) -> FileReadCapability {
        // Logs the issuance for audit trail
        self.audit_log.record(AuditEvent::CapabilityIssued { agent: *agent, cap: "file_read" });
        FileReadCapability(path)
    }
}

// Tools require specific capabilities — enforced at the type level
pub fn read_file(cap: &FileReadCapability, offset: u64, len: usize) -> Result<Vec<u8>, IoError> {
    // cap.0 is the allowed path — no capability means no call site
    std::fs::read(&cap.0)
}
```

An agent that doesn't hold a `FileReadCapability` cannot call `read_file` — the compiler refuses. There is no runtime check to bypass, no policy evaluation to circumvent — the capability either exists in the agent's context or it doesn't. This is the strongest possible enforcement: the attack surface is the capability issuance logic in the governor, not every individual tool call site.

### Cryptographic Capabilities for Distributed Enforcement

For distributed multi-agent systems, compile-time enforcement isn't sufficient — capabilities must cross process boundaries. Tenuo's approach (2025) uses cryptographic warrants with offline attenuation: a capability token is a signed JWT-like structure that encodes what the bearer can do. The governor signs the initial capability; agents can attenuate (restrict) and delegate capabilities to sub-agents without contacting the governor. The tool executor verifies the signature chain before executing. This enables least-privilege across distributed systems without a central authorization server in the hot path.

### Comparison with ACL-Based Approaches

| Property | ACL-Based | Capability-Based |
|---|---|---|
| Authority source | Identity + lookup table | Possession of capability token |
| Ambient authority | Common (filesystem, env vars) | None by design |
| Delegation | Requires ACL modification | Attenuate and hand off |
| Audit | Log access checks | Log capability issuance |
| Confused deputy attack | Vulnerable | Immune (no ambient authority) |
| Runtime overhead | Per-request ACL lookup | Token verification only |
| Compile-time enforcement | Not possible | Possible in Rust |

The confused deputy problem — where a privileged program is tricked into misusing its authority on behalf of a less-privileged requester — is structurally impossible in a capability system. An agent cannot cause the governor to act on its behalf beyond the capabilities it holds.

---

## 5. Deterministic Scheduling in Concurrent Agent Systems

### The BEAM Scheduler as a Reference Design

The Erlang/OTP BEAM virtual machine's scheduler is the most battle-tested reference implementation for deterministic process scheduling at scale. Its key properties:

**Preemptive scheduling via reductions:** BEAM switches between lightweight processes every 4,000 "reductions" (approximately function calls). No process can starve others — not even a tight infinite loop. In contrast, Python asyncio and Node.js use cooperative scheduling: a CPU-bound coroutine blocks the entire event loop until it yields. For agent systems where some tasks are CPU-intensive (tokenization, parsing) and some are I/O-bound, preemptive scheduling is critical for liveness.

**Per-process garbage collection:** BEAM garbage-collects each process independently with tiny, incremental pauses. Node.js and Python have stop-the-world GC pauses that affect all concurrent agents simultaneously. At 10,000 concurrent agent sessions, this difference is the difference between consistent latency and periodic latency spikes that cascade across all agents.

**Process isolation:** BEAM processes share no memory. A crash in one process cannot corrupt the heap of another. Agents that fail are restarted by their supervisor without affecting peers. This isolation is the foundation of fault tolerance — "let it crash" works because crashes are contained.

**Supervision restart strategies:** OTP supervisors implement restart strategies that govern recovery:
- `one_for_one`: Restart only the crashed process
- `one_for_all`: Restart all siblings if one crashes (for tightly coupled agents)
- `rest_for_one`: Restart the crashed process and all processes started after it (for ordered pipelines)
- `simple_one_for_one`: For dynamic pools of identical workers (e.g., a tool executor pool)

The governor in a Rust runtime should implement equivalent semantics.

### Tokio's Work-Stealing Scheduler

Tokio (the dominant Rust async runtime) uses a work-stealing scheduler across a thread pool sized to CPU count. Work-stealing means idle threads steal tasks from busy threads' queues, providing automatic load balancing without central coordination. For agent workloads:

- Each agent is a Tokio task (`tokio::spawn`)
- I/O-bound agents (waiting for LLM responses) park on futures and free their thread
- CPU-bound agent work should be dispatched to `tokio::task::spawn_blocking` to avoid blocking the async runtime's thread pool

The governor can enforce scheduling priorities via `tokio::task::Builder` (currently experimental) or by implementing a priority queue in front of the executor, dispatching tasks based on priority assigned at governance time.

### Budget Enforcement

Token budget enforcement is a fundamental governor responsibility. The pattern:

```rust
struct AgentBudget {
    token_limit: u64,
    tokens_consumed: AtomicU64,
    wall_clock_limit: Duration,
    started_at: Instant,
}

impl AgentBudget {
    fn check_and_consume(&self, tokens: u64) -> Result<(), BudgetError> {
        let consumed = self.tokens_consumed.fetch_add(tokens, Ordering::Relaxed);
        if consumed + tokens > self.token_limit {
            return Err(BudgetError::TokenLimitExceeded);
        }
        if self.started_at.elapsed() > self.wall_clock_limit {
            return Err(BudgetError::WallClockLimitExceeded);
        }
        Ok(())
    }
}
```

The `AtomicU64` allows concurrent budget checks from multiple async tasks without mutex overhead. The governor intercepts every LLM call, calls `check_and_consume` with the estimated token cost, and either permits the call or transitions the agent to `Suspended::BudgetExhausted`.

---

## 6. Real-World Examples and Reference Architectures

### Kubernetes Controllers as Deterministic Reconciliation Loops

Kubernetes controllers are the most widely deployed example of deterministic governance for distributed systems. The reconciliation loop pattern: observe current state, compare to desired state, take corrective action, repeat. This is intrinsically deterministic — the same observed state always produces the same action. Controllers are stateless (state lives in etcd), idempotent (running twice has the same effect as once), and level-triggered (react to state differences, not event sequences).

For agent governance, this pattern maps to a "desired state" model: the governor declares what state each agent should be in (running, suspended, terminated), continuously reconciles actual state against declared state, and takes corrective action (restart, suspend, kill) without human intervention. The audit trail is the sequence of desired-state declarations and the actions taken to achieve them.

### Elixir/Phoenix: Multi-Agent AI on BEAM

Multiple teams have shipped production multi-agent AI systems on Elixir/BEAM (Pypestream for enterprise conversational AI; Freshcode for agentic workflow orchestration). The reference architecture:

- Each conversation or agent instance is a `GenServer` process (~2KB memory overhead)
- Conversations are started under a `DynamicSupervisor` — crashed agents are automatically restarted
- Agent pools use `simple_one_for_one` supervisors sized to workload, scaling based on queue depth
- Message passing between agents is transparent across nodes in an Erlang cluster
- Hot code reloading allows updating agent prompts or tool implementations without dropping active sessions

The lesson for Rust runtimes: the process isolation, fault recovery, and scheduling properties that make BEAM ideal for agent systems are not magic — they are design choices that can be replicated with Tokio tasks, structured supervision logic, and careful state isolation. The Rust equivalents trade the GC-free heap isolation of BEAM processes for Rust's compile-time memory safety guarantees.

### Governance-as-a-Service (GaaS) Architecture

The 2025 paper "Governance-as-a-Service: A Multi-Agent Framework for AI System Compliance and Policy Enforcement" (arXiv:2508.18765) formalizes a modular governance layer that regulates agent outputs at runtime without altering model internals or requiring agent cooperation. Key design principles:

- **Independence:** The governance layer is decoupled from agent implementation — agents don't need to be "governance-aware"
- **Modularity:** Policy modules can be added, removed, or updated independently
- **Runtime enforcement:** Decisions are made at execution time, not at training time
- **Coordination transparency:** Agent-to-agent interactions are logged and monitored, not just agent-to-user interactions

This last point is particularly important for multi-agent systems. Current governance approaches focus on agent outputs to users; as agents increasingly coordinate with each other, the coordination layer itself becomes an attack surface and a compliance gap.

### AutoGen's Orchestrator Pattern

AutoGen v0.4's Core Layer provides event-driven actor semantics: agents communicate via typed messages, the orchestrator maintains workflow state as an explicit data structure, and lifecycle management (instantiation, execution, retirement) is handled by the framework rather than embedded in agent logic. This is statechart-adjacent reasoning — the orchestrator transitions agents through lifecycle states based on task completion signals.

---

## 7. Security Threat Model for Agent Governors

### What the Governor Must Defend Against

**Prompt injection:** A malicious document or tool response contains instructions that attempt to override the agent's behavior. Deterministic enforcement is immune: the governor evaluates capability checks, budget checks, and output validation against hard rules, not model reasoning. A jailbroken model output is caught at the output validation layer before any external action is taken.

**Capability escalation:** An agent attempts to acquire capabilities beyond its grant. In the OCap model, this is structurally impossible — capabilities cannot be synthesized. In a type-safe Rust implementation, the compiler enforces this. In a distributed system, cryptographic signing of capability tokens provides the same guarantee.

**Budget exhaustion attacks:** An agent (or an attacker controlling an agent) deliberately consumes maximum resources. The governor's atomic budget counter and hard limits prevent this from affecting sibling agents, and the `BudgetExhausted` transition suspends the agent immediately.

**Confused deputy:** A trusted agent is tricked into using its capabilities on behalf of an untrusted caller. The capability model prevents this — the agent can only grant capabilities it holds, and the governor audit log records every delegation.

**Coordination attacks:** Multiple agents collude to collectively exceed limits that would block any individual agent. The governor must maintain cross-agent state (shared rate limits, resource pools) and enforce limits at the aggregate level, not per-agent.

---

## Implications for Agent Runtime Design

For a Rust-based agent runtime with a deterministic Governor component, the research suggests the following architectural decisions:

**1. Statechart-based process lifecycle.** Model agent states as a W3C SCXML-compatible hierarchical state machine. Use Rust enums for state representation and implement the transition function as a pure function on (state, event) → (new_state, side_effects). Side effects (audit log writes, supervisor notifications, metric increments) are executed after the state transition, not during.

**2. Capability types at the API boundary.** Every tool in the tool registry should declare the capability it requires as a type parameter or trait bound. Capability issuance is the governor's exclusive responsibility. Agents receive capability sets at initialization and cannot acquire new capabilities without governor approval. Revocation is achieved by transitioning the agent to `Suspended` — the capability tokens become irrelevant because the agent cannot execute.

**3. OPA-via-WASM for policy evaluation.** Embed OPA policies compiled to WASM via `wasmtime` for zero-latency, sandboxed policy evaluation in the critical path. Policies live in a version-controlled directory, with a reload signal allowing policy updates without runtime restart. The WASM sandbox ensures a malformed policy cannot crash the governor process.

**4. Atomic budget accounting.** Maintain per-agent and per-tenant budget counters as `AtomicU64` values. Check and decrement atomically before every LLM call and tool invocation. Budget exhaustion triggers a state transition event, not a panic. The governor is the only writer of budget state; agents are read-only consumers.

**5. Supervision tree with configurable restart strategies.** Implement OTP-style supervision: every agent process has a supervisor, restart strategies are configurable per-process-type, and the supervision hierarchy mirrors the agent task hierarchy. Root-level supervisor failures are escalated to human operators via alerting.

**6. Immutable audit log.** Every state transition, capability issuance, policy decision, and budget event is written to an append-only audit log before the action is taken. The log is the ground truth for governance compliance. Structure it for OpenTelemetry export to enable integration with existing observability infrastructure.

**7. Deterministic kernel, pluggable LLM advisor.** The governor makes all hard decisions deterministically. For soft decisions requiring semantic judgment (e.g., "is this agent's behavior anomalous?"), the governor can consult an LLM advisor, but the advisor's recommendation is subject to the same deterministic validation as any other input. The advisor cannot override the kernel.

---

## References

- [Governance-as-a-Service: A Multi-Agent Framework for AI System Compliance and Policy Enforcement](https://arxiv.org/abs/2508.18765) — arXiv 2025
- [Why Agentic AI Requires a "Determinism-First" Architecture](https://www.voltactivedata.com/blog/2026/02/agentic-ai-determinism-first-architecture/) — Volt Active Data, Feb 2026
- [You need deterministic guardrails for AI agent security](https://www.civic.com/resources/deterministic-guardrails-for-ai-agent-security) — Civic, 2025
- [The agent control plane: Architecting guardrails for a new digital workforce](https://www.cio.com/article/4130922/the-agent-control-plane-architecting-guardrails-for-a-new-digital-workforce.html) — CIO, 2025
- [Agent Governance at Scale: Policy-as-Code Approaches in Action](https://www.nexastack.ai/blog/agent-governance-at-scale) — NexaStack, 2025
- [Your Agent Framework Is Just a Bad Clone of Elixir](https://georgeguimaraes.com/your-agent-orchestrator-is-just-a-bad-clone-of-elixir/) — George Guimarães, 2026
- [Orchestrating AI Agents with Elixir's Actor Model for Reliable Agentic Workflows](https://www.freshcodeit.com/blog/why-elixir-is-the-best-runtime-for-building-agentic-workflows) — Freshcode, 2025
- [Reference Architecture: Building Multi-Agent AI Systems on Elixir and Bare Metal](https://openmetal.io/resources/blog/multi-agent-ai-elixir-bare-metal/) — OpenMetal, 2025
- [Coordination transparency: governing distributed agency in AI systems](https://link.springer.com/article/10.1007/s00146-026-02853-w) — AI & Society, Springer, 2026
- [TRiSM for Agentic AI: Trust, Risk, and Security Management in LLM-based Multi-Agent Systems](https://arxiv.org/html/2506.04133v2) — arXiv 2025
- [Anthropic ASL-3 Deployment Safeguards Report](https://www.anthropic.com/asl3-deployment-safeguards) — Anthropic, 2025
- [Anthropic Next-Generation Constitutional Classifiers](https://www.anthropic.com/research/next-generation-constitutional-classifiers) — Anthropic, 2025
- [Open Policy Agent Documentation](https://www.openpolicyagent.org/docs) — OPA, 2025
- [Awesome Object Capabilities and Capability-based Security](https://github.com/dckc/awesome-ocap) — dckc, GitHub
- [statechart — Rust crate](https://docs.rs/statechart/latest/statechart/) — docs.rs
- [Tokio — An asynchronous Rust runtime](https://tokio.rs/) — tokio.rs
- [SAFE-MCP: A Community-Built Framework for AI Agent Security](https://thenewstack.io/safe-mcp-a-community-built-framework-for-ai-agent-security/) — The New Stack, 2025
- [Building AI Agents with LLMs and Custom ML Models](https://blog.davemdavis.net/2026/01/21/building-ai-agents-with-llms-and-custom-ml-models-the-blueprint-for-enterprise-ready-autonomy/) — Dave Davis, Jan 2026
- [AI Agents in 2026: Practical Architecture for Tools, Memory, Evals, and Guardrails](https://andriifurmanets.com/blogs/ai-agents-2026-practical-architecture-tools-memory-evals-guardrails) — Andrii Furmanets, 2026
