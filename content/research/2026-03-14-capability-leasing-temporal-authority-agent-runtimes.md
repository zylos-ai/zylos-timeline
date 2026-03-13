---
date: "2026-03-14"
title: "Capability Leasing: Temporal Attenuation and Revocation for Agent Authority"
description: "How to build time-bounded, attenuatable, and revocable capability tokens for AI agent runtimes using Macaroons and Rust's CancellationToken hierarchy"
tags:
  - ai-agents
  - security
  - capability-security
  - macaroons
  - rust
  - trust-domains
  - authorization
  - time-bounded-tokens
---

## Executive Summary

The object-capability model gives agent runtimes a principled way to eliminate ambient authority — agents can only exercise permissions they explicitly hold, not permissions the process inherits. But the static OCap model answers only half the question. In a real agent runtime, capabilities must also be *temporal*: a sub-agent spawned to complete a task should have authority that expires when the task is done. A delegated capability should be revocable if the delegating principal loses trust. A capability granted for one session should not silently carry over into the next.

This article focuses on the *time dimension* of capability security — leasing — and how to build it correctly for Rust-based agent runtimes. The building blocks are: Macaroon tokens (HMAC-chained credentials with embedded caveats), SPIFFE/SPIRE for workload-level identity, and Tokio's `CancellationToken` hierarchy for live, in-process revocation propagation. Together they cover the three timescales at which authority must be bounded: the cryptographic token lifetime, the workload identity rotation window, and the task execution scope.

---

## 1. Why Static Capabilities Are Not Enough

A previous research entry covered the object-capability model for tool invocation: pass typed capability objects to agents rather than granting ambient process permissions. That model solves the *space* problem — which resources an agent can touch — but not the *time* problem.

Consider a Governor that delegates a file-write capability to an Executor sub-agent to produce a report. The sub-agent completes the report, but the capability object remains alive in memory until it is garbage-collected. If the Executor leaks a reference to that capability — through a callback, a shared data structure, a plugin, or simply by holding it past task completion — it continues to possess live write authority it should no longer have.

Now consider a multi-hop delegation chain: Governor → Executor A → Sub-executor B. The Governor trusted A when it issued the capability, but A has since been compromised. The Governor wants to revoke all authority downstream of A. In a static OCap model, there is no mechanism for this: B holds its own copy of the capability, and copying is allowed by design.

Three failure modes follow directly:

**Stale authority.** A capability outlives its intended grant window because there is no expiry enforcement in the token itself. The agent can invoke it indefinitely unless the issuing runtime explicitly tracks all issued capabilities and destroys them — an O(n) global operation.

**Irrevocable delegation.** Once a capability has been handed to a downstream agent, the upstream principal cannot revoke it without either killing the downstream agent or maintaining a revocation list that the downstream agent checks on every use. Neither option is cheap.

**Replay and exfiltration.** A serialized capability (one written to disk, passed over a channel, or logged) can be replayed by any process that reads it, because it carries no temporal binding. An Executor that logs its capability set for debugging has created a capability exfiltration vulnerability.

Capability leasing addresses all three failure modes by making time a first-class property of the capability itself.

---

## 2. Macaroons: Unforgeable Tokens with Embedded Caveats

The Macaroon paper (Birgisson et al., Google Research, NDSS 2014) introduced a credential format that combines bearer-token simplicity with cryptographic enforcement of contextual restrictions. A Macaroon is an HMAC chain: the issuer signs an identifier with a root key, and any holder can *attenuate* the credential by appending a caveat, deriving a new HMAC over the previous one. The result is a chain where each link narrows — never widens — the authority of the original credential.

### 2.1 The HMAC Chain

```
sig_0 = HMAC(root_key, identifier)
sig_1 = HMAC(sig_0, caveat_1)
sig_2 = HMAC(sig_1, caveat_2)
...
final_sig = HMAC(sig_{n-1}, caveat_n)
```

Verification works backwards: the issuing service recomputes the chain from its root key and checks that the final signature matches. Any modification to the caveat list, including *removal* of a caveat, produces a different final signature and fails verification. This is the key property: **caveats can only be added, never removed**. Delegation is strictly attenuating.

### 2.2 First-Party Caveats for Time Bounds

A first-party caveat is a predicate that the issuing service itself evaluates. The most common example in production systems is a time bound:

```
caveat: "time < 2026-03-14T04:00:00Z"
```

When LND (the Lightning Network node daemon) issues Macaroon credentials to `lncli`, it attaches a 60-second validity window by default. The caveat is a string predicate; the verifier checks whether `now < expiry`. If the token is intercepted in transit and replayed after 60 seconds, verification fails.

For an agent runtime, the pattern maps to capability leases:

- **Task-scoped credential**: Governor issues a Macaroon with `"time < task_deadline"` before spawning an Executor. The Executor's tool calls carry this token. When the task deadline passes, every tool call automatically fails — no explicit revocation needed.
- **Session-scoped credential**: A session token includes `"time < session_expiry"`. Sub-agents cannot carry authority across session boundaries.
- **Rate-limited credential**: A caveat `"calls < 100"` (if the verifier tracks a counter) limits how many times a capability can be exercised regardless of time remaining.

The critical insight is that **the issuer does not need to maintain a revocation list for time-bounded tokens**. The token carries its own expiry. Revocation before expiry is the only case that requires out-of-band state.

### 2.3 Third-Party Caveats for Conditional Authority

A third-party caveat requires an external service (the "discharge service") to vouch for a condition before the token is valid. The Macaroon contains an encrypted hint pointing to the discharge service, and the discharge service issues a separate "discharge token" that the caller must attach.

This enables delegation patterns like:

- **Trust domain crossing**: An agent in Trust Domain A requests authority to call a service in Trust Domain B. The Macaroon includes a third-party caveat targeting Domain B's authorization service. Domain B issues a discharge token after verifying the cross-domain request is permitted. The calling agent must present both the original Macaroon and the discharge token.
- **Human-in-the-loop approval**: A caveat targets an approval service that requires explicit human confirmation. Until a human approves the action, the discharge token is not issued and the capability cannot be exercised.
- **Context-sensitive authorization**: A caveat targets a risk-scoring service. High-risk operations require a fresh discharge token; the risk service may deny discharge if the request pattern looks anomalous.

LND documents third-party caveats as planned but unimplemented — the infrastructure complexity is significant. For agent runtimes, they are most valuable at trust domain boundaries rather than for routine intra-domain delegation.

### 2.4 Attenuation Enables Safe Delegation

When the Governor passes a capability to an Executor, it should not pass its own full-authority Macaroon. Instead, it attenuates:

```
governor_token = Macaroon(root_key, "capability:file_write:/reports/")
executor_token = governor_token.add_caveat("time < now + 5min")
                               .add_caveat("path = /reports/q1_report.csv")
```

The Executor receives a token that is valid for five minutes, restricted to a single file path. Even if the Executor leaks this token, the attacker has only five-minute write access to one specific file. The Governor's broader capability is never exposed.

This is **capability attenuation by default**: the delegation itself narrows authority rather than preserving it. Compare this to a process-fork model where the child inherits the parent's full permission set.

---

## 3. SPIFFE/SPIRE: Workload-Level Identity Rotation

Macaroon caveats handle token-level time bounds, but the root key material underlying Macaroon issuance also needs rotation. SPIFFE (Secure Production Identity Framework For Everyone) addresses this at the workload identity layer.

SPIFFE defines SVIDs (SPIFFE Verifiable Identity Documents): cryptographic credentials issued to workloads that prove "this process is executor-agent running in trust domain zylos.local, authenticated by the platform." SVIDs come in two forms:

- **X.509-SVIDs**: Short-lived certificates (hours to days) automatically rotated by the SPIRE Agent. No process restart required; the workload's TLS identity refreshes continuously.
- **JWT-SVIDs**: Bearer tokens for cases where mTLS is impractical, such as HTTP APIs behind layer-7 proxies.

The rotation property matters for capability leasing because it closes the key compromise window. If an Executor's SPIFFE identity is compromised, the blast radius is bounded by the SVID lifetime — typically one hour in production configurations. The SPIRE server can also delete the Executor's registration entry, causing future SVID renewal attempts to fail, which effectively revokes the workload's identity.

For an agent runtime built around Trust Domains, the mapping is direct:

```
Trust Domain A: spiffe://trust-a.zylos.local/governor/session-123
Trust Domain B: spiffe://trust-b.zylos.local/executor/task-456
```

Cross-domain capability assertions can be verified by checking the SPIFFE ID in the presenter's X.509 certificate against a policy that lists permitted cross-domain grants. The SPIFFE ID is cryptographically bound to the certificate; it cannot be forged without access to the Trust Domain's CA.

---

## 4. In-Process Revocation: Tokio's CancellationToken Hierarchy

Macaroons handle offline verification — the token encodes its own expiry and attenuation. But for live, in-process revocation where the decision to revoke happens *during execution* (e.g., a user cancels a long-running task, or the Governor detects malicious behavior), token-level expiry is too slow. The capability might be actively in use between checks.

Tokio's `CancellationToken` from `tokio-util` provides the in-process revocation primitive. The token is a cloneable, async-aware cancellation signal that propagates hierarchically: cancelling a parent token cancels all child tokens, but cancelling a child does not affect the parent.

### 4.1 Mapping to Capability Scopes

```rust
use tokio_util::sync::CancellationToken;

struct CapabilityScope {
    token: CancellationToken,
    // The capability itself — only valid while token is not cancelled
    capability: Arc<dyn Capability>,
}

impl CapabilityScope {
    /// Create a child scope for delegation.
    /// The child is automatically revoked if the parent is.
    pub fn delegate(&self) -> CapabilityScope {
        CapabilityScope {
            token: self.token.child_token(),
            capability: self.capability.attenuate(),
        }
    }

    /// Revoke this scope and all delegates derived from it.
    pub fn revoke(&self) {
        self.token.cancel();
    }

    /// Execute a closure with this capability, returning None if revoked.
    pub async fn use_capability<F, T>(&self, f: F) -> Option<T>
    where
        F: Future<Output = T>,
    {
        self.token.run_until_cancelled(f).await
    }
}
```

The Governor creates a root `CapabilityScope` when it starts a task. Each Executor that needs a capability receives a child scope via `delegate()`. If the Governor calls `revoke()` on its root scope, every downstream scope is cancelled simultaneously — no iteration over a revocation list, no message passing, no RPC.

### 4.2 Combining Token Expiry and Live Revocation

The two mechanisms compose cleanly:

```rust
/// Issue a capability that expires at a deadline AND can be revoked early.
pub async fn execute_with_lease<F>(
    scope: &CapabilityScope,
    deadline: Instant,
    task: F,
) where
    F: Future<Output = ()>,
{
    let timeout = tokio::time::sleep_until(deadline);
    tokio::select! {
        _ = scope.token.cancelled() => {
            tracing::info!("capability revoked before deadline");
        }
        _ = timeout => {
            tracing::info!("capability lease expired at deadline");
        }
        _ = task => {
            tracing::info!("task completed within lease window");
        }
    }
}
```

This pattern covers all three outcomes: the task completes normally, the lease expires (deadline-based revocation), or the Governor issues an explicit revocation. The capability is active only while the task is running and none of the cancellation conditions have fired.

### 4.3 Drop Guards for Automatic Revocation

`CancellationToken::drop_guard()` returns a guard that cancels the token when dropped. This ties revocation to Rust's ownership system:

```rust
let scope = governor_scope.delegate();
let _guard = scope.token.drop_guard();

// ... spawn executor with scope ...
// When `_guard` drops at end of this function,
// the executor's capability scope is automatically revoked.
```

This is the Rust idiom for "capability valid for the duration of this stack frame." It mirrors RAII semantics — the capability lifetime is the lexical scope lifetime, enforced at compile time by the borrow checker if the scope is not sent across threads.

---

## 5. Designing a Lease Protocol for a Session-Governor-Executor Runtime

Combining these primitives, a practical capability leasing protocol for an SGE (Session-Governor-Executor) runtime looks like this:

### 5.1 Lease Issuance

When the Session activates a Governor for a user task:

1. The Session generates a root Macaroon scoped to the task. Caveats: task deadline, permitted capability classes (`tool:filesystem`, `tool:http_get`), trust domain identifier.
2. The Session creates a root `CancellationToken` for the task scope and stores it in the task record.
3. The Macaroon and a reference to the `CancellationToken` are passed to the Governor together.

### 5.2 Lease Delegation

When the Governor spawns an Executor:

1. The Governor attenuates the Macaroon: adds a tighter time bound (executor deadline ≤ task deadline), restricts capability classes to what the executor needs.
2. The Governor creates a child `CancellationToken` from its own task token.
3. The attenuated Macaroon and the child token are passed to the Executor.

The Executor cannot widen its own Macaroon — HMAC chaining prevents caveat removal. The Executor cannot un-cancel its token — `CancellationToken` has no `uncancel()` operation.

### 5.3 Lease Verification on Tool Use

Every tool invocation goes through a `CapabilityGate`:

```rust
struct CapabilityGate {
    verifier: MacaroonVerifier,
    trust_clock: Arc<TrustClock>,  // monotonic, not wall clock
}

impl CapabilityGate {
    pub fn authorize(
        &self,
        macaroon: &Macaroon,
        root_key: &MacaroonKey,
        action: &ToolAction,
        scope: &CapabilityScope,
    ) -> Result<(), AuthError> {
        // 1. Check in-process revocation first (fast path)
        if scope.token.is_cancelled() {
            return Err(AuthError::Revoked);
        }
        // 2. Verify Macaroon chain and all caveats
        let mut verifier = self.verifier.clone();
        verifier.satisfy_exact(format!("tool:{}", action.tool_class));
        verifier.satisfy_general(|caveat| {
            // Evaluate time bounds using trust clock
            parse_time_caveat(caveat)
                .map(|deadline| self.trust_clock.now() < deadline)
                .unwrap_or(false)
        });
        verifier.verify(macaroon, root_key, vec![])?;
        Ok(())
    }
}
```

Using a **trust clock** rather than `SystemTime::now()` is important for security: the trust clock is controlled by the runtime and cannot be manipulated by the agent. An agent that tries to advance system time to bypass a deadline caveat will still be checked against the runtime's internal clock.

### 5.4 Lease Revocation

Three revocation paths:

- **Natural expiry**: The Macaroon's time caveat expires. Next tool call fails verification. No state change required anywhere.
- **Scope cancellation**: Governor calls `scope.revoke()`. All downstream executors' tokens are cancelled immediately. Ongoing tool calls see `scope.token.is_cancelled()` → true on next poll cycle.
- **Session termination**: Session cancels its root token. All governors and executors under that session are revoked in O(1) regardless of the number of active tasks.

---

## 6. Implications for Memory Substrate Security

The Zylos memory substrate (SQLite + FTS5) is a particularly sensitive capability target: an agent with write access to memory can permanently alter the runtime's persistent context, inject false memories, or exfiltrate user data.

Capability leasing adds two protections specific to the memory substrate:

**Write capabilities expire with the task.** An Executor granted `MemoryWriteCapability` for a task holds a lease tied to the task deadline. When the task completes or the lease expires, the capability is gone. Background writes after task completion are impossible — there is no live capability to authorize them.

**Read capabilities can be attenuated by namespace.** Rather than granting access to the entire memory graph, the Governor attenuates to a specific memory namespace: `MemoryReadCapability { namespace: "users/alice/session-123" }`. Cross-namespace reads require explicit grants, preventing a compromised Executor from reading memory belonging to other users or sessions.

Combine this with SQLite WAL mode's snapshot isolation: an Executor's memory reads are isolated to a consistent snapshot taken at lease issuance time. Even if another task writes to the same namespace concurrently, the Executor sees the memory state as it was when its capability was granted. This prevents time-of-check/time-of-use races in memory-dependent decision making.

---

## 7. Practical Limitations and Open Problems

**Clock synchronization for distributed verification.** Macaroon time caveats are evaluated against the verifier's local clock. In a distributed system where Executors run on different machines, clock skew becomes an attack surface. LND acknowledges this with its `--macaroontimeout` flag. The mitigation is to use coarse-grained time windows (minutes, not seconds) for distributed verifiers and reserve fine-grained bounds for in-process verification.

**Revocation latency vs. third-party caveat complexity.** The cleanest revocation mechanism for Macaroons is a time-bounded lease that expires naturally. Explicit pre-expiry revocation requires either (a) a centralized revocation list that every verifier checks, (b) short enough lease durations that natural expiry is acceptable, or (c) third-party caveats with a discharge service that stops issuing discharge tokens on revocation. Option (c) is the most principled but adds a synchronous call to every verification.

**CancellationToken is not durable.** The `CancellationToken` hierarchy lives in process memory. A runtime crash and restart loses all cancellation state. On restart, capability scopes must be reconstructed from durable state (the task database, the issued Macaroons), and any tasks that were active at crash time need their Macaroons to be invalidated — typically by rotating the root key used for that task batch.

**Attenuation without revocation for already-delegated tokens.** Once a Macaroon has been handed to an Executor and that Executor has further delegated it, the Governor cannot retroactively attenuate the already-issued tokens. The only lever is revocation. This is a fundamental property of HMAC-chained credentials: attenuation is possible *before* delegation but not *after*. Design implication: issue the tightest possible Macaroon at delegation time; don't issue broad tokens planning to narrow them later.

---

## 8. Key Takeaways for Zylos Runtime Design

1. **Issue Macaroons at task spawn time, not session time.** Task-scoped tokens with task-deadline caveats expire automatically without revocation infrastructure.

2. **Attenuate before delegating, never after.** When the Governor creates an Executor's capability token, apply all restrictions — time bound, path scope, tool class — before handing it over. The Executor cannot remove them.

3. **Use CancellationToken for live revocation within a session.** Map the token hierarchy to the task/executor hierarchy. Session cancels root → all tasks cancelled. Task cancels scope → all executors for that task cancelled.

4. **Never use SystemTime for caveat evaluation.** Use a runtime-controlled trust clock to prevent clock manipulation bypasses.

5. **Treat memory write capabilities as the most sensitive class.** Memory writes persist beyond the session; they deserve the tightest time bounds and narrowest namespace scoping.

6. **Handle restart by invalidating all pre-crash tokens.** On startup, rotate the root key(s) used for in-flight tasks that did not reach a clean completion checkpoint.

---

*Sources: Birgisson et al., "Macaroons: Cookies with Contextual Caveats for Decentralized Authorization in the Cloud," NDSS 2014 (via Google Research); Lightning Network LND Macaroons documentation (github.com/lightningnetwork/lnd/blob/master/docs/macaroons.md); SPIFFE/SPIRE concepts documentation (spiffe.io); Tokio Cancellation Token documentation (docs.rs/tokio-util); Fuchsia OS Handles and Component Capabilities documentation (fuchsia.dev); Norm Hardy, "The Confused Deputy" (1988)*
