---
date: "2026-03-13"
title: "Formal Specification and Type-Driven Safety for AI Agent Runtimes"
description: "How TLA+, session types, refinement types, and Rust's type system can be applied to specify and enforce correctness in AI agent architectures — from trust boundaries to executor contracts."
tags: ["formal-methods", "tla+", "type-systems", "rust", "agent-runtimes", "safety", "verification", "trust-domains"]
---

## Executive Summary

AI agent runtimes are distributed systems. They route untrusted instructions from LLM sessions through governance layers to capability executors, across trust boundaries that must be maintained under adversarial conditions. Yet most agent frameworks treat correctness as a testing problem: write enough tests, add enough guards, hope for the best.

Formal methods offer an alternative: specify what the system *must* do and what it *must never* do, then verify those properties before a single line of executable code is written. This is not academic overhead. AWS, Microsoft, Intel, and Dropbox have each credited TLA+ with finding critical bugs that no amount of testing would have caught. The same techniques apply directly to the Session-Governor-Executor model at the core of zylos-next.

This article covers four complementary tools: TLA+ for specifying and model-checking trust domain transitions; session types for encoding protocol correctness in the type system; Rust's ownership model as an implicit formal system for resource safety; and Verus for writing machine-checkable correctness proofs for systems code. Together they form a layered approach to correctness that matches the layered architecture of a production agent runtime.

---

## Why Formal Methods Now

The case for formal methods in AI agent runtimes is stronger than in traditional distributed systems, for two reasons.

First, the threat model is qualitatively different. A conventional distributed system's bugs come from programmer mistakes. An agent runtime's bugs can come from an adversary who *controls the instruction stream* — an LLM that has been manipulated through prompt injection, a malicious plugin, or a compromised tool result. The attacker is not just trying to crash the system; they are trying to confuse the governor into granting permissions it shouldn't grant, or coerce the executor into taking actions it shouldn't take. This requires not just "the code works" but "the invariants hold even when inputs are adversarial."

Second, the composability problem. Agent runtimes are built from components with very different trust levels that must interoperate cleanly. A session layer, a governance layer, and an execution layer each have distinct responsibilities. The interfaces between them are where bugs concentrate. Formal specification forces these interfaces to be made explicit, and model checking finds the edge cases at those interfaces that reviewers miss.

The relevant industry data point: when AWS engineers applied TLA+ to the design of distributed cloud services, they found that "formal methods find bugs in system designs that cannot be found through any other technique we know of." Chris Newcombe, who led that effort, called it "the most valuable thing that I've learned in my professional career." Intel's use of TLA+ on cache coherence protocols found hundreds of bugs before RTL implementation, with the verified unit achieving zero coherence bugs in silicon.

---

## TLA+ for Trust Domain Transitions

### The Core Idea

TLA+ (Temporal Logic of Actions) is a specification language created by Leslie Lamport. It describes a system as a state machine: a set of variables defining the current state, a set of actions that can transition the system from one state to another, and temporal properties that must hold across all possible execution sequences.

The key insight is that TLA+ separates *what can happen* (actions) from *what must happen* (liveness) and *what must never happen* (safety). For an agent runtime, the safety properties are the critical ones: the executor must never perform a capability outside its granted trust domain; the governor must never authorize an action that violates the active policy; a session operating in the untrusted domain must never be able to escalate its privileges.

### Modeling a Session-Governor-Executor System

Consider a minimal TLA+ specification for the trust domain state machine in zylos-next:

```tla
VARIABLES session_trust, governor_state, executor_grants

TrustDomains == {"untrusted", "restricted", "trusted", "system"}

TypeInvariant ==
  /\ session_trust \in TrustDomains
  /\ governor_state \in {"idle", "evaluating", "approved", "denied"}
  /\ executor_grants \subseteq TrustDomains

(* Safety: untrusted sessions can never directly acquire system-level grants *)
TrustEscalationSafety ==
  session_trust = "untrusted" => "system" \notin executor_grants

(* Safety: executor grants must not exceed session trust level *)
GrantConfinement ==
  \A grant \in executor_grants:
    TrustLevel(grant) <= TrustLevel(session_trust)

(* An escalation request must pass through the governor *)
EscalateRequest ==
  /\ session_trust \in {"untrusted", "restricted"}
  /\ governor_state = "idle"
  /\ governor_state' = "evaluating"
  /\ UNCHANGED <<session_trust, executor_grants>>

(* Governor approves: trust level may rise, but only by one step *)
GovernorApprove ==
  /\ governor_state = "evaluating"
  /\ session_trust' = NextTrustLevel(session_trust)
  /\ governor_state' = "approved"
  /\ UNCHANGED executor_grants
```

This is simplified, but it captures the invariants worth verifying. The TLC model checker will exhaustively explore all reachable states and verify that `TrustEscalationSafety` and `GrantConfinement` hold in every one of them.

### What TLA+ Finds

Model checking excels at finding violations of invariants in corner cases that arise from interleaving. Consider the question: what if an escalation approval arrives while a capability request is already in flight? What if the governor crashes mid-evaluation? What if two concurrent sessions both request escalation at the same time? These are exactly the scenarios where bugs hide, and TLC will find them automatically by exploring all interleavings.

For zylos-next specifically, the properties worth specifying include:

- **No trust bypass**: An executor action requires a grant; a grant requires governor approval; governor approval requires a valid policy check. This chain must be unbreakable.
- **No downgrade races**: When a session's trust level is reduced (e.g., due to policy revocation), in-flight executor tasks must be cancelled or quarantined, not allowed to complete with stale grants.
- **Idempotent revocation**: Revoking a grant that is not held must be a no-op, not an error that can be exploited to force inconsistent state.
- **Bounded latency of denial**: A governor denial must be delivered to the executor within a bounded number of steps. Unbounded waiting allows timeout-based attacks.

### Liveness Properties

Beyond safety, TLA+ can specify liveness: things that *eventually* must happen. For an agent runtime, key liveness properties include:

```tla
(* A request must eventually be decided — not left pending forever *)
EventualDecision ==
  []<>(governor_state = "evaluating" =>
       governor_state' \in {"approved", "denied"})

(* An approved executor grant must eventually be exercised or expired *)
GrantExpiration ==
  []<>(\A grant \in executor_grants: grant.expiry < CurrentTime)
```

Liveness failures manifest as deadlocks or livelocks: the system keeps running but never makes progress. In agent runtimes, these show up as governor queues that fill up but never drain, or executor tasks that wait indefinitely for grants that are never delivered.

---

## Session Types: Encoding Protocols in the Type System

### What Session Types Are

Session types are a type-theoretic approach to communication protocol correctness. Rather than just typing the data that flows over a channel, session types type the *sequence of interactions* on the channel. If the type checker accepts the program, the protocol is guaranteed to be followed.

The classic formulation is binary session types for two-party protocols. A session type for a simple request-response channel looks like:

```
Client side: !Request . ?Response . End
Server side: ?Request . !Response . End
```

The `!` means "send" and `?` means "receive". The client and server types are *dual* to each other — if the client sends, the server must receive, and vice versa. The type system enforces that both sides advance through the protocol in lockstep, eliminating entire classes of protocol violations: sending when you should be receiving, forgetting to send a required message, reading a response that was never sent.

For multiparty session types (MPST), the same idea extends to three or more participants through a global protocol that is projected onto each participant's local view.

### Applying Session Types to the Governor Protocol

The interaction between a Session, Governor, and Executor follows a well-defined protocol. In pseudocode:

```
Session -> Governor: CapabilityRequest(tool, args, trust_context)
Governor -> PolicyEngine: PolicyCheck(tool, trust_context)
PolicyEngine -> Governor: PolicyResult(allow | deny | escalate)
Governor -> Session: GrantDecision(grant_id | denial_reason)
Session -> Executor: InvokeCapability(grant_id, tool, args)
Executor -> Session: CapabilityResult(output | error)
```

In a session-typed system, each of these channels would carry a type that encodes this exact sequence. A governor that tried to invoke the executor directly (bypassing the grant issuance step) would be a *type error*, caught at compile time. A session that tried to invoke a capability without first receiving a grant would be a *type error*. No runtime check needed.

### Session Types in Rust

Rust does not have native session types, but the `session-types` crate and related libraries encode them as zero-cost abstractions using Rust's type system. The key trick is using phantom types and channel wrappers to track protocol state:

```rust
// Protocol state machine encoded in types
struct Chan<Env, P>(PhantomData<(Env, P)>, ...);

// Send a message, advancing the protocol state
fn send<T, S>(chan: Chan<E, Send<T, S>>, val: T) -> Chan<E, S>;

// Receive a message, advancing the protocol state
fn recv<T, S>(chan: Chan<E, Recv<T, S>>) -> (Chan<E, S>, T);
```

When the protocol state is `Send<CapabilityRequest, Recv<GrantDecision, End>>`, calling `recv` on it is a compile error. The protocol state must be `Recv<...>` for a receive to be valid. This eliminates an entire class of ordering bugs.

The cost is ergonomics. Session types in Rust require careful management of channel ownership and make the code more verbose. For the critical path — the governor protocol, the trust domain transition protocol — this tradeoff is worth it. The compiler becomes a proof that the protocol is respected.

---

## Rust's Type System as an Implicit Formal System

### Ownership as Resource Management

Rust's ownership model is, in a precise sense, a formal system for resource management. The type checker enforces:

- **Uniqueness**: Each value has exactly one owner at any time. This is the linear types property.
- **Aliasing XOR mutation**: You can have multiple immutable references, or one mutable reference, but not both. This prevents data races without runtime locks.
- **Lifetime validity**: References cannot outlive their referents. This prevents use-after-free and dangling pointers.

These properties, enforced statically, eliminate entire vulnerability classes that are endemic to C and C++ systems. For an agent runtime, they mean that a granted capability cannot be silently aliased and exercised after it has been revoked, that shared state between concurrent tasks cannot be mutated without explicit synchronization, and that memory allocated for a task is automatically freed when the task completes.

### The `Send + Sync` Bounds as a Concurrency Contract

Rust's `Send` and `Sync` traits encode concurrency safety as type constraints:

- `T: Send` means a value of type `T` can be safely moved across thread boundaries
- `T: Sync` means a value of type `T` can be safely accessed from multiple threads simultaneously

These are not just documentation — they are machine-checked. Any attempt to share a non-`Send` value across threads is a compile error. For an agent runtime where tasks execute concurrently across worker threads, this means that types representing sensitive state (like active grants, policy caches, session tokens) can be annotated as `!Send` or `!Sync` to prevent them from being accidentally shared or moved into unsafe contexts.

### Newtype Pattern for Trust Domains

One of the most powerful and underused patterns for correctness in Rust is the newtype idiom: wrapping a primitive type in a named struct to prevent accidental misuse.

```rust
// Raw tool name string — no trust information
struct RawToolName(String);

// Tool name that has been validated against the policy engine
struct PolicyApprovedToolName(String);

// Only the governor can create PolicyApprovedToolName values
impl Governor {
    pub fn approve_tool(
        &self,
        tool: RawToolName,
        ctx: &TrustContext
    ) -> Result<PolicyApprovedToolName, DenialReason> {
        // ... policy check ...
        Ok(PolicyApprovedToolName(tool.0))
    }
}

// The executor only accepts pre-approved tool names
impl Executor {
    pub fn invoke(
        &self,
        tool: PolicyApprovedToolName,  // NOT RawToolName
        args: Args
    ) -> Result<Output, ExecutionError> {
        // ...
    }
}
```

Now it is *impossible* to call `executor.invoke()` with an un-approved tool name — the types don't match. You cannot accidentally bypass the governor by constructing a `PolicyApprovedToolName` outside of `Governor::approve_tool`, because the inner field is private. The compiler enforces the architectural invariant that all executor invocations must pass through the governor.

This is type-level capability security: the capability to invoke the executor is represented as a value of type `PolicyApprovedToolName`, and only the authorized code path can produce such values.

---

## Verus: Machine-Checked Proofs for Systems Code

### What Verus Is

Verus is a formal verification tool for Rust that uses SMT solvers (Z3) to prove that annotated Rust code satisfies its specifications. Unlike type-level tricks, Verus allows proving functional properties: not just "this code type-checks" but "this code returns the correct output for all possible inputs."

Developers write specifications using three categories of annotations:

- `requires` clauses: preconditions that must hold when a function is called
- `ensures` clauses: postconditions that the function guarantees when it returns
- `invariant` clauses: loop or data structure invariants that must hold throughout execution

The Verus verifier checks these statically, without running the code. If verification passes, the code is *proved correct* with respect to its specification for all possible inputs.

### Verifying Trust Domain Operations

Consider a function that issues a capability grant. Its specification should capture:

```rust
fn issue_grant(
    session: &Session,
    tool: &ToolDescriptor,
    policy: &PolicyEngine,
) -> Result<CapabilityGrant, DenialReason>
    requires
        session.is_active(),
        tool.trust_level() <= session.trust_domain(),
        policy.is_valid(),
    ensures
        |result| match result {
            Ok(grant) =>
                grant.tool_id == tool.id &&
                grant.trust_level <= session.trust_domain() &&
                grant.expires_at > current_time() &&
                grant.session_id == session.id,
            Err(reason) =>
                reason.is_documented(),
        }
```

If Verus accepts this, it has proved that no grant can be issued for a trust level higher than the session's domain, that grants always have a finite expiry, and that the grant is correctly bound to the requesting session. Not "we tested this" — *proved for all possible inputs*.

### Verifying Revocation Atomicity

A critical safety property in capability systems is that grant revocation must be atomic: after a revocation call returns, no component should be able to exercise the revoked capability. This is surprisingly hard to get right when executors run concurrently. Verus can verify this by checking the invariant that the grant table and the executor's active-grants set are always consistent:

```rust
spec fn grant_consistency(
    grant_table: &GrantTable,
    executor_state: &ExecutorState
) -> bool {
    forall |grant_id: GrantId|
        executor_state.has_active_grant(grant_id) ==>
        grant_table.contains(grant_id) &&
        !grant_table.is_revoked(grant_id)
}
```

This invariant, if verified, proves that the executor can never hold an active reference to a revoked grant — regardless of what the LLM session is doing, regardless of concurrent execution, regardless of race conditions.

### Integration with the AutoVerus Approach

Recent work (AutoVerus, 2024) demonstrated that LLM agents can automatically generate Verus proofs achieving a 90% success rate on verification benchmarks. This opens a practical workflow: write the specification manually (the hard part that requires domain expertise), then use an LLM-powered verification agent to generate the proof code. The human specifies *what* must be true; the agent proves *that* it is true.

For zylos-next, this means the specification of trust invariants — written by humans who understand the security model — can be machine-verified without requiring human proof-writing expertise.

---

## Practical Application to zylos-next

### Specification-First Architecture

The core recommendation is to write TLA+ specifications *before* implementing the Session-Governor-Executor interfaces. This forces three valuable things to happen:

1. **Interface clarity**: The specification must name every message type, every state transition, every invariant. This usually reveals ambiguities that would otherwise become bugs.
2. **Invariant documentation**: The invariants discovered during specification become the contract that implementation must maintain. They can be translated into Verus postconditions or Rust debug assertions.
3. **Bug prevention**: Model checking finds logical errors in the design before any code exists. These are the most expensive bugs to fix later.

### The Layered Correctness Stack

A practical correctness strategy for zylos-next uses all four tools at the appropriate level of the stack:

| Layer | Tool | What It Proves |
|-------|------|----------------|
| Design | TLA+ | Trust domain transitions are free of escalation bugs and deadlocks |
| Protocol | Session Types | Governor protocol is correctly sequenced by all participants |
| API | Rust type system + newtypes | Trust boundaries cannot be bypassed at the call site |
| Implementation | Verus | Critical functions satisfy their functional specifications |

Not every function needs Verus verification — that would be impractical. But the highest-value targets are clear: the grant issuance path, the revocation path, the trust domain transition logic, and the policy evaluation function. These are the functions that security properties depend on most directly.

### Incremental Adoption

Formal methods have a reputation for requiring large upfront investment. In practice, incremental adoption works well:

**Week 1**: Write a TLA+ specification of the current governor protocol (typically 50-100 lines). Run TLC. Fix the design issues it reveals.

**Week 2**: Apply the newtype pattern to the three most important trust boundaries in the codebase. Each newtype is a one-line change that immediately closes a class of bugs.

**Week 3**: Add `requires`/`ensures` annotations to the grant issuance function and run Verus. Fix the specification errors (usually the spec is too loose or too strict).

**Ongoing**: As new capabilities are added, the newtype pattern and specification annotations scale with the codebase. TLA+ specifications are updated when the architecture changes.

### The VeriGuard Pattern

The VeriGuard framework (2025) provides a practical template: a dual-stage approach that combines offline specification verification with online runtime monitoring. The offline stage uses Verus or similar tools to prove that the implementation matches the specification. The online stage generates lightweight runtime monitors from the same specification, providing a last line of defense against implementation bugs that slipped through verification.

For zylos-next, runtime monitors can be generated from the TLA+ invariants: every trust domain transition can be checked against the formal state machine in O(1) time. If the runtime monitor fires, it means either a bug in the implementation or an attack that has managed to induce invalid state. Both warrant immediate session termination.

---

## Limitations and Tradeoffs

### The Specification Gap

Formal verification proves that the implementation matches the specification. It does not prove that the specification captures the right properties. Specification errors are possible — and they are harder to find than implementation errors, because there is nothing to run the specification against.

The mitigation is specification review. The TLA+ specification should be reviewed by someone with security expertise who did not write it. Adversarial thinking ("what invariants did we forget?") is valuable here.

### Verification Scope

Verus and similar tools verify the annotated functions against their specifications. They do not verify:
- The correctness of external libraries (the OS, the network stack, the LLM provider API)
- The security of the hardware
- The absence of timing side channels
- The correctness of the specification itself

Formal verification is a powerful tool within its scope, not a guarantee of total security.

### Performance Overhead

Verus adds no runtime overhead — proofs are checked statically, and the verified code is ordinary Rust. Session types in Rust are similarly zero-cost at runtime. TLA+ specifications have no runtime representation.

The cost is development time. Verification annotations take time to write; Verus requires familiarity with SMT solver limitations; TLA+ has a learning curve. The ROI is highest for the security-critical path, where a single bug can compromise the entire system.

---

## References

- Lamport, L. (2002). *Specifying Systems: The TLA+ Language and Tools for Hardware and Software Engineers*. Addison-Wesley.
- Newcombe, C., et al. (2015). How Amazon Web Services uses formal methods. *Communications of the ACM*, 58(4), 66-73.
- Honda, K., Vasconcelos, V., & Kubo, M. (1998). Language primitives and type discipline for structured communication-based programming. *ESOP*.
- Yang, C., et al. (2024). AutoVerus: Automated Proof Generation for Rust Code. *arXiv*.
- VeriGuard: Enhancing LLM Agent Safety via Verified Code Generation. (2025). *arXiv:2510.xxxxx*.
- Milosevic, N. & Rabhi, F. (2026). Architecting Agentic Communities using Design Patterns. *arXiv:2601.xxxxx*.
- Verus: Verified Rust for Low-Level Systems Code. https://github.com/verus-lang/verus
- TLA+ Foundation. https://lamport.azurewebsites.net/tla/tla.html
