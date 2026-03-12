---
date: "2026-03-12"
title: "Capability-Based Security for AI Agent Tool Invocation"
description: "How the object-capability model solves privilege escalation, confused deputy attacks, and over-permissioning in multi-agent systems"
tags: ["ai-agents", "security", "capability-security", "ocap", "least-authority", "tool-use", "multi-agent", "rust"]
---

## Executive Summary

Every AI agent eventually needs to act on the world: write a file, call an API, spawn a subprocess, query a database. The interface through which it does this — the tool layer — is simultaneously the agent's greatest capability and its most dangerous attack surface. Current agent frameworks mostly bolt security on as an afterthought: a list of allowed tools in a config file, a middleware check, a human-in-the-loop confirmation. These approaches share a fundamental flaw — they rely on *identity-based* access control, where the agent is trusted because it *is* the agent, not because it *holds a specific right* to perform the specific action it is about to take.

The object-capability (OCap) model offers a more rigorous alternative. Rather than asking "who is this agent, and what is it allowed to do?", the OCap model asks "does this agent possess an unforgeable token that grants exactly this action?" The distinction sounds philosophical but has concrete engineering consequences: it eliminates ambient authority, prevents the confused deputy attack, enables fine-grained delegation and attenuation, and supports capability revocation without requiring a global policy update. For multi-agent runtimes — where a Governor hands work to Executors, Executors call tools, and tool calls may trigger further sub-agents — the OCap model maps almost directly onto the control flow graph.

---

## 1. The Problem with Ambient Authority

Most agent frameworks today operate under *ambient authority*: the agent inherits whatever permissions the process it runs in possesses. If the runtime process has filesystem read/write access, so does every tool call the agent makes. If a tool handler can reach the network, every network call is equally permitted regardless of which agent initiates it.

This model has three failure modes that matter for agent systems.

**Over-privileged defaults.** An agent designed to answer questions about a codebase shouldn't need write access to that codebase, but ambient authority gives it write access for free. When a prompt injection attack convinces the agent to overwrite a file, the runtime provides no resistance — the agent has the authority, it just shouldn't be using it in this context.

**Confused deputy in multi-agent chains.** The confused deputy problem (originally described by Norm Hardy in 1988 in the context of a compiler program being tricked into writing to a file it had authority to access but the caller didn't) appears in modern multi-agent systems as follows: a low-trust user message is processed by a high-trust orchestrator agent, which then delegates to an executor with broad filesystem permissions. The executor doesn't know that its authority is being exercised on behalf of an untrusted principal — it just sees a tool call request from the orchestrator, which it trusts. The orchestrator has been confused into deputizing its authority to accomplish something the original user couldn't do directly.

**No compositional security.** When you compose two agents — an email agent and a calendar agent — the composed system has the union of their permissions. There is no way to express "this composition should only have read access to email, not send access" without modifying the individual agents.

---

## 2. Object Capabilities: Core Mechanics

The OCap model resolves these problems through three principles:

**Reference as authority.** The only way to exercise authority over a resource is to possess an unforgeable reference (a capability) to it. There is no way to name a resource without already having been granted access to it. There are no global names that can be guessed, no environment variables that leak permissions, no ambient privilege registers.

**Only connectivity begets connectivity.** A new capability can only be created by an entity that already holds it, and only granted to an entity that the grantor can directly reach. This prevents privilege escalation through indirection.

**No ambient authority.** No implicit permissions are inherited from the execution environment. A function can only access what is explicitly passed to it.

The practical implementation for agent runtimes looks like this: when a Governor spawns an Executor to handle a task, it does not give the Executor a process with inherited permissions. It gives the Executor a set of *capability objects* — each one a typed, unforgeable handle that encapsulates exactly one permission. A `FileWriteCapability { path: "/tmp/output.txt" }` permits writing to that specific path and nothing else. A `HttpGetCapability { base_url: "https://api.example.com" }` permits GET requests to that origin and nothing else. The Executor can only use these capabilities; it cannot construct new ones.

When the Executor needs to call a tool, the tool invocation carries the appropriate capability as a parameter. The tool handler verifies capability possession — not agent identity — before executing. If the capability wasn't passed, the call fails, regardless of which agent made it.

---

## 3. Attenuation and Delegation

One of OCap's most powerful properties is *attenuation*: an entity can grant a *weaker* form of a capability it holds, but never a stronger one. This maps directly to agent delegation patterns.

A Governor that holds `DatabaseCapability { access: ReadWrite, tables: ["*"] }` can delegate `DatabaseCapability { access: ReadOnly, tables: ["users"] }` to a sub-agent. The sub-agent cannot escalate beyond what it was given. If it tries to write, it fails. If it tries to access the `payments` table, it fails. Critically, it cannot grant another sub-agent more access than it received itself — even if it wanted to.

This property is what makes multi-agent hierarchies safe. Each layer in the delegation chain can only operate within the authority it was explicitly granted by the layer above. The attack surface of a deep agent call tree does not expand as the tree grows — it is bounded by what the root Executor was given, and each subtree is bounded by its parent's delegation.

Attenuation also enables *read-only proxies*: an agent that processes user-uploaded documents and sends them to an LLM for summarization should hold only a read capability for the upload directory. If the LLM is compromised via prompt injection in a document, the injected instructions can at most read the files the agent was already going to read. They cannot exfiltrate credentials, write malware, or spawn network connections — because those capabilities were never granted.

---

## 4. Capability Revocation

Ambient authority systems revoke permissions by modifying global ACLs or restarting processes. Both are coarse-grained and disruptive. OCap revocation can be surgical.

The standard pattern is the *revocable forwarder*: rather than granting a capability directly, the grantor wraps it in a forwarder object. The grantee receives a reference to the forwarder, which proxies all calls to the underlying capability. When the grantor wants to revoke access, it destroys the forwarder. All subsequent invocations through that forwarder fail immediately, without affecting other holders of the underlying capability.

For agent runtimes, this enables task-scoped capabilities: an Executor receives a set of capabilities for the duration of a specific task, wrapped in a revocable forwarder tied to the task's lifetime. When the task completes — or is cancelled, or times out — the Governor revokes the forwarders. The Executor's tools are immediately neutered, regardless of what state the Executor is in. This is particularly valuable for long-running agents where graceful shutdown cannot be guaranteed.

---

## 5. Implementation Patterns in Rust

Rust's type system makes OCap constraints statically verifiable, which eliminates an entire class of runtime permission violations.

**Capability types.** Define capabilities as distinct types that are not `Clone` and not constructable outside the issuing module:

```rust
pub struct FileWriteCapability {
    path: PathBuf,
    // Private field prevents construction outside this module
    _private: (),
}

impl FileWriteCapability {
    // Only the Governor can call this
    pub(crate) fn new(path: PathBuf) -> Self {
        FileWriteCapability { path, _private: () }
    }
}
```

A function that requires file write authority takes `&FileWriteCapability` as a parameter. If the caller doesn't have one, the code doesn't compile. There is no runtime check to bypass, no identity lookup to spoof.

**Linear types for single-use capabilities.** Some operations should only be performed once (e.g., deleting a file, sending a webhook). Making the capability non-`Copy` and consuming it in the function that uses it enforces single-use at compile time.

**Capability sets.** An Executor receives a `CapabilitySet` struct containing the specific capabilities it was granted. Tool dispatch routes through this set, ensuring only granted tools are reachable.

---

## 6. Mapping to the Session-Governor-Executor Architecture

The OCap model fits cleanly onto a three-tier agent runtime:

- **Session layer** holds the root capabilities for a user's session: their authorized integrations, data scopes, and budget limits. These are issued at session initialization based on the user's trust level.

- **Governor** acts as the capability broker. When it decomposes a task into subtasks, it issues attenuated capability subsets to each Executor — only what that specific subtask requires. The Governor maintains the revocable forwarders and tears them down on task completion.

- **Executor** operates with only the capabilities it was explicitly given. Its tool calls carry capability proofs. It cannot self-escalate. If it is compromised by an adversarial input, the damage is bounded by its capability set.

This architecture makes trust domain boundaries concrete and enforceable rather than declarative. A "low-trust domain" isn't a label in a config file — it's a capability set that literally cannot reach sensitive resources.

---

## 7. Comparison with Current Practice

| Approach | Ambient Authority Problem | Confused Deputy | Attenuation | Revocation |
|---|---|---|---|---|
| Allowlist (config-based) | Persists | Vulnerable | Not possible | Full restart or config reload |
| Middleware checks | Persists | Vulnerable | Ad-hoc | Global policy update |
| RBAC/ABAC | Persists | Vulnerable | Approximate | Role modification |
| Object Capabilities | Eliminated | Prevented | First-class | Surgical, O(1) |

The OWASP LLM Top 10 identifies "Excessive Agency" (LLM08) as a critical risk — agents granted broader permissions than needed for their task. The OCap model is structurally the correct solution to this risk class, because the problem is not just misconfiguration but the entire ambient-authority model that makes over-permissioning the path of least resistance.

---

## 8. Practical Implications

Several production systems already approximate OCap patterns:

- **Deno** implements a capability model for JavaScript runtimes: every permission (file, network, env, subprocess) must be explicitly granted at invocation time. The model is coarser than full OCap but demonstrates the deployment pattern is viable in production.

- **WebAssembly Component Model** is standardizing capability-based imports: a Wasm component cannot access host resources unless the embedding explicitly passes capability handles at instantiation.

- **MCP (Model Context Protocol)** tool schemas declare capabilities per-server, and clients negotiate which capabilities to expose to the model. This is an application-level approximation of capability scoping.

For teams building agent runtimes in 2026, the minimal viable OCap implementation is: (1) define capability types at the API boundary, (2) issue capabilities from the Governor at task spawn time, (3) make tool handlers accept capabilities as parameters rather than checking agent identity, and (4) tie capability lifetimes to task lifetimes via RAII or explicit revocation. The full theoretical OCap model is not required to get most of the security benefits.

---

*Sources: Spritely Institute OCap research (files.spritely.institute); CHERI capability hardware model (cl.cam.ac.uk); Deno permission model (docs.deno.com); OWASP LLM Top 10 (owasp.org); MCP resource specification (modelcontextprotocol.io); W3C Permissions Policy specification (w3c.github.io)*
