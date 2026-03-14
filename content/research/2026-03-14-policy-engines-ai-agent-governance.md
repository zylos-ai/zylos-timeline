---
date: "2026-03-14"
title: "Policy Engines for AI Agent Governance: Rule-Based and Hybrid Approaches"
description: "A comprehensive analysis of policy engine architectures — OPA, Cedar, Casbin, and Zanzibar-inspired systems — and how they can be adapted for AI agent governance, with focus on hybrid deterministic-LLM evaluation patterns."
tags: ["AI Agents", "Policy Engines", "Governance", "Security", "OPA", "Cedar", "Trust Domains"]
---

## Executive Summary

Governing autonomous AI agents requires a fundamentally different security model from governing human users. A human user clicks "Submit" and waits; an AI agent can invoke hundreds of tools in seconds, chain operations across trust boundaries, and behave differently on repeated runs due to sampling randomness. Traditional RBAC systems — designed around stable, enumerable human roles — cannot keep pace.

This article examines the policy engine landscape (OPA, Cedar, Casbin, Zanzibar-inspired systems, and newer application-specific engines like Cerbos) and evaluates how each maps onto the requirements of agent governance. The central argument is that agent governance demands a hybrid architecture: deterministic policy engines as the ground truth for access decisions, with LLMs operating strictly in an advisory capacity — providing contextual classification that feeds into deterministic decision functions, never making final access decisions themselves.

The Session-Governor-Executor architecture — in which a Governor holds a PolicyEngine and applies a 4-category LLM boundary model — is used as a concrete reference implementation throughout. Patterns discussed here are directly applicable to that design.

---

## The Core Problem: Why Agent Governance is Different

Standard authorization deals with a bounded, enumerable request space. A user can create, read, update, or delete resources. You can enumerate these actions and write policies that cover every meaningful combination.

AI agents explode this assumption in three ways:

**1. Unbounded tool invocation sequences.** An agent executing a multi-step task may invoke tools in combinations that were never anticipated at policy-authoring time. The policy author must reason about effects, not just individual operations.

**2. Probabilistic behavior.** The LLM component of an agent does not guarantee deterministic output. The same prompt, same context, and same tool set can yield different tool invocations on different runs. A security boundary that is 99% reliable is not a security boundary — it is a guideline.

**3. Trust boundary traversal.** Agents frequently act on behalf of users (delegation), call other agents (multi-agent systems), and access external services (tool calls). Each hop is a potential authority amplification or trust boundary crossing that policy must account for.

These properties push toward a single design principle: **the policy engine must be deterministic, and LLM output must enter it as data, not as a decision**.

---

## Policy Engine Landscape

### Open Policy Agent (OPA)

OPA is a CNCF-graduated, general-purpose policy engine that decouples policy decision-making from policy enforcement. Applications query OPA over a local HTTP API or in-process Go library, providing structured input (JSON) and receiving a structured decision. The policy language, Rego, is a Datalog-inspired declarative language evaluated against a document model.

**How OPA works:**

```
Application → OPA Query (JSON input) → Rego evaluation → Decision (JSON output)
```

OPA stores policies and data in memory. Bundles — tar archives containing policies and data — are the standard distribution mechanism. A bundle server (any HTTP server) pushes updates; OPA polls and hot-reloads atomically, so policy updates take effect without restart and without interrupting in-flight evaluations.

**Rego example — tool authorization:**

```rego
package agent.tools

default allow = false

# Allow if the tool is in the agent's capability set AND
# the trust level meets the tool's minimum requirement
allow {
    tool := input.tool
    agent := input.agent

    tool_policy := data.tools[tool.name]
    tool_policy.min_trust_level <= agent.trust_level

    tool.name in agent.capabilities
    not is_blocked(agent, tool)
}

is_blocked(agent, tool) {
    data.blocklists[agent.session_id][_] == tool.name
}

# Rate-limit enforcement: return violation if over quota
rate_limited {
    count(data.invocations[input.agent.id]) > data.quotas[input.agent.id].per_minute
}
```

OPA achieves 1–5ms policy evaluation latency for typical policies with local data. Performance degrades predictably with data volume — policies that iterate over large arrays are the main performance hazard. OPA provides a profiler (`opa eval --profile`) that shows per-rule evaluation time and re-evaluation counts, making it tractable to identify hot paths.

**Bundle hot-reload** is atomic: OPA downloads the new bundle, compiles it in memory, and swaps it in as a single operation. In-flight evaluations complete against the old bundle; new evaluations start against the new one. There is no window where policies are partially applied.

**OPA's limitations for agent governance:**

- Rego is expressive but has a steep learning curve. Its logic-programming semantics surprise engineers expecting imperative code.
- OPA has no built-in concept of "effects" or "sequences" — it evaluates a single request in isolation. Reasoning about what a sequence of tool calls will do requires encoding that reasoning explicitly in policy or external data.
- As of mid-2025, Apple acquired the primary commercial OPA maintainers (Styra), raising questions about the long-term roadmap. The open-source project continues under CNCF, but enterprise support is less certain.

### AWS Cedar

Cedar is a policy language and evaluation engine developed by AWS, now open-source and entering the CNCF sandbox (2025). It powers Amazon Verified Permissions and is designed around three explicit properties: human readability, performance, and formal analyzability.

Cedar's authorization model is PERMIT/FORBID-based with explicit deny-overrides. Policies are evaluated as a set; if any FORBID policy matches, the request is denied regardless of PERMIT policies.

**Cedar syntax:**

```cedar
// Permit an agent to call read-only tools when trust level is STANDARD or higher
permit (
    principal in AgentGroup::"standard-trust",
    action in [Action::"tool:read", Action::"tool:list"],
    resource in ToolSet::"public"
) when {
    principal.trustLevel >= 2 &&
    !principal.isQuarantined
};

// Unconditionally forbid destructive operations for untrusted agents
forbid (
    principal,
    action in [Action::"tool:delete", Action::"tool:exec-shell"],
    resource
) unless {
    principal.trustLevel >= 4 &&
    context.humanApproved == true
};
```

**Cedar's distinguishing properties:**

Cedar was built from the beginning with automated reasoning in mind. The Cedar team proved termination and correctness properties about the evaluator using formal methods, and the policy language is designed so that analysis questions (e.g., "can any policy in this set grant access to resource X?") can be reduced to SMT-LIB formulas solvable in ~75ms on average. This means you can statically verify policy sets before deploying them — a capability OPA/Rego does not offer out of the box.

Performance benchmarks show Cedar evaluating policies 42–60x faster than Rego for equivalent workloads. This matters for agent governance where a high-throughput agent may invoke hundreds of tools per second and the policy check is on the critical path.

Cedar's limitations: it is newer and has fewer production integrations. Its AWS-centric provenance means the ecosystem tooling is oriented around AWS services. The policy language, while readable, is less flexible than Rego for complex logic — by design, to enable formal analysis.

### Casbin

Casbin is a multi-language authorization library (Go, Java, Node.js, Python, Rust, and more) that enforces access control models defined in CONF files using the PERM metamodel: Policy, Effect, Request, Matchers.

Unlike OPA or Cedar (which are external policy decision points), Casbin is typically embedded directly in application code as a library. This makes it appropriate for high-frequency, low-latency decisions where the overhead of a network call to a sidecar is unacceptable.

**Casbin model for agent tool authorization (CONF):**

```ini
[request_definition]
r = agent, tool, action

[policy_definition]
p = agent_role, tool_pattern, action, effect

[role_definition]
g = _, _          # agent-to-role mapping
g2 = _, _         # tool-to-toolset mapping

[policy_effect]
e = some(where (p.eft == allow)) && !some(where (p.eft == deny))

[matchers]
m = g(r.agent, p.agent_role) && \
    g2(r.tool, p.tool_pattern) && \
    r.action == p.action && \
    p.effect == "allow"
```

**Policy rules (CSV):**

```
p, role:standard, toolset:read-only, invoke, allow
p, role:elevated, toolset:read-write, invoke, allow
p, role:admin, toolset:all, invoke, allow
p, role:any, tool:shell-exec, invoke, deny

g, agent:abc-123, role:standard
g2, tool:web-search, toolset:read-only
g2, tool:file-write, toolset:read-write
```

Casbin supports in-memory or database-backed policy stores with adapter plugins (MySQL, Postgres, Redis, MongoDB). Policy updates are hot-reloadable. Its RBAC extension supports domain-scoped roles, which maps cleanly to Trust Domains: an agent with `role:elevated` in `domain:tenant-A` does not automatically have that role in `domain:tenant-B`.

The main limitation of Casbin for complex agent governance is its policy effect model: it supports `allow` and `deny` effects per rule, but complex conditional logic quickly becomes awkward in the CONF/CSV format. For simple RBAC and pattern-matching authorization, Casbin is extremely fast (sub-millisecond, embedded) and operationally simple. For rich contextual authorization it stretches its design.

### Google Zanzibar and ReBAC

Google Zanzibar, described in a 2019 USENIX paper, is the authorization system underlying Google Drive, Calendar, YouTube, and other services. It stores access control as relationship tuples and answers queries about whether a user has a given relation to a given object.

The fundamental tuple form is:

```
<object>#<relation>@<user>
```

For example: `document:report-q4#viewer@user:alice` means Alice is a viewer of the Q4 report.

Zanzibar answers questions like "does user:alice have 'viewer' relation to document:report-q4?" by traversing the relationship graph. Inheritance and group membership are expressed as additional tuples: `document:report-q4#viewer@group:finance-team` plus `group:finance-team#member@user:alice` means Alice inherits viewer access through her team membership.

**Open-source Zanzibar implementations:** SpiceDB (AuthZed), OpenFGA (Auth0/Okta), Ory Keto, and others. These are production-ready Zanzibar-compatible systems.

**Zanzibar for agent governance:**

ReBAC maps well to hierarchical agent systems and delegation chains. An agent acting on behalf of a user inherits a bounded subset of that user's relationships:

```
agent:session-abc#delegate@user:alice
tool:calendar-write#invoke@agent:session-abc
```

The policy question "can agent session-abc invoke tool:calendar-write?" resolves by traversing the relationship graph. Revocation is immediate: deleting the delegation tuple immediately removes all downstream permissions.

Where Zanzibar excels: multi-hop delegation, fine-grained resource-level permissions, real-time revocation. Where it struggles: attribute-based conditions (Zanzibar's model is purely relational, not attribute-aware) and complex conditional logic. Production Zanzibar systems often combine ReBAC for structural access with OPA or Cedar for attribute-based conditions.

### Cerbos

Cerbos is an application-specific policy decision point that emerged from OPA production experience. Its developers found OPA's lack of a fixed data model meant every team had to design its own input/output schema. Cerbos defines a standard request/response format and uses Common Expression Language (CEL) for conditions within YAML-based policies.

**Performance:** Cerbos claims 17x faster than its previous OPA-based implementation, with sub-millisecond embedded evaluation. It can be deployed as a sidecar, a centralized service, or compiled to WebAssembly for cross-language embedding.

**Cerbos policy example:**

```yaml
apiVersion: api.cerbos.dev/v1
resourcePolicy:
  version: "default"
  resource: "agent_tool"
  rules:
    - actions: ["invoke"]
      effect: EFFECT_ALLOW
      roles: ["standard-agent"]
      condition:
        match:
          all:
            of:
              - expr: "request.resource.attr.risk_level <= 2"
              - expr: "request.principal.attr.trust_level >= 1"
              - expr: "!request.principal.attr.quarantined"

    - actions: ["invoke"]
      effect: EFFECT_DENY
      roles: ["*"]
      condition:
        match:
          expr: "request.resource.attr.requires_human_approval && !request.aux_data.jwt.human_approved"
```

Cerbos is particularly well-suited for applications where developers want policy-as-code without learning Rego's logic-programming semantics.

---

## The Hybrid Model: Deterministic Enforcement with LLM Assistance

The most important design decision in an agent governance system is not which policy engine to use — it is where the LLM sits relative to policy evaluation.

Two failure modes bracket the design space:

**Failure mode A: LLM as judge.** The system sends the tool invocation request to an LLM and asks "is this allowed?" The LLM is prompted with policy text and makes a judgment call. This fails because LLMs are probabilistic — the same request may be allowed on one run and denied on another. Adversarial prompting can manipulate the judgment. There is no audit trail more reliable than "the model said yes."

**Failure mode B: No LLM, only rigid rules.** The system evaluates only deterministic policies. This fails to handle genuinely ambiguous cases where policy intent requires semantic understanding — for example, distinguishing "summarize this document" from "extract PII from this document" when the tool is `file_read`.

The solution is a hybrid pipeline where the LLM operates only within bounded, well-defined stages that feed deterministic decision functions.

### The 4-Category LLM Boundary Model

A clean way to structure this is to classify all decisions into four categories based on whether and how the LLM participates:

**Category A — Never LLM.** Hard security boundaries. Examples: rate limits, blocklist checks, trust level minimums, session isolation, capability existence checks. These must be deterministic because no amount of contextual reasoning should override them. An agent that has exceeded its rate limit is rate-limited, full stop.

```
Request → Deterministic precheck → ALLOW/DENY
```

**Category B — Default non-LLM, optional assist.** Routine authorization checks where the answer is almost always derivable from policy data, but where an LLM can optionally provide richer classification to improve granularity. Example: classifying whether a file path is sensitive. A deterministic rule can cover `/etc/passwd` and `~/.ssh/`; an LLM classifier can handle novel patterns.

```
Request → Deterministic policy check → ALLOW/DENY
                                     ↑ (optional: LLM classification of resource enriches policy input)
```

**Category C — Must LLM.** Decisions that require semantic understanding. Example: evaluating whether a natural-language task description is within the agent's sanctioned scope. Deterministic rules cannot parse intent.

```
Request → LLM semantic classification → structured verdict → Deterministic enforcement of verdict
```

The key: the LLM outputs a structured result (e.g., `{risk_category: "data_exfiltration", confidence: 0.91}`) that enters a deterministic function. The deterministic function decides what to do with that structured result based on policy.

**Category D — Hybrid: deterministic prefilter → optional LLM → deterministic enforcement.** The most powerful pattern. A deterministic prefilter handles clearly allowed and clearly denied cases. The LLM handles the ambiguous middle. A deterministic enforcement function then acts on the LLM's structured output.

```
Request → Fast deterministic prefilter → [CLEAR ALLOW | AMBIGUOUS | CLEAR DENY]
                                                          ↓
                                              LLM contextual classification
                                                          ↓
                                          Structured output (risk score, category)
                                                          ↓
                                          Deterministic threshold enforcement
```

This architecture gives you the performance of deterministic rules on the common paths (90%+ of requests) with the semantic intelligence of LLMs on genuinely ambiguous cases, while keeping the final access decision deterministic and auditable.

### Why "LLM as Advisor, Not Judge" Matters for Auditability

Every access decision should produce an audit record that explains why it was made in terms that are reproducible and verifiable. A decision log that says "LLM determined this was allowed" is unverifiable — you cannot reproduce the exact decision without the exact model weights, temperature, and random seed. A decision log that says "tool risk_level=2 <= agent max_risk_level=3; trust_level=2 >= minimum_trust_level=2; no blocklist match" is fully auditable.

When the LLM participates, the audit record should capture the LLM's structured output as data: "LLM classification: risk_category=data_access, confidence=0.87; threshold policy: allowed categories=[data_access,computation] when confidence>=0.80; decision: ALLOW." This makes the LLM's contribution transparent and the final decision deterministic.

---

## Runtime Policy Evaluation: Performance and Hot-Reload

### Performance Characteristics

For agent workloads, policy evaluation latency is on the critical path of every tool invocation. Target budgets by deployment pattern:

| Pattern | Target Latency | Notes |
|---|---|---|
| Embedded library (Casbin, Cerbos-WASM) | <1ms | In-process, no network |
| Sidecar (OPA, Cerbos) | 1–5ms | Local network, co-located |
| Centralized service | 5–20ms | Network hop, cache recommended |
| External SaaS (Permit.io, AuthZed) | 20–100ms | Round-trip + processing |

For a session handling 100 tool invocations/minute, a 5ms policy evaluation adds only 0.5 seconds of overhead — negligible. For a high-throughput agent making 10 tool calls/second, a 50ms centralized service would add 500ms/second of pure policy overhead — unacceptable.

### Caching Strategies

Decision caching reduces per-call overhead for repeated identical queries. The cache key must include all inputs that affect the decision: agent identity, tool name, resource attributes, context attributes, current timestamp (if time-bound policies are in use).

OPA supports inter-query caching at the built-in function level but does not cache full decision results by default (as the application is responsible for determining what can be safely cached given its data freshness requirements). External caches (Redis, in-memory LRU) are typically added at the application layer with a configurable TTL.

**Cache invalidation for agent governance** has a specific constraint: capability revocations must propagate immediately. If an agent's session is terminated, its policy cache must be invalidated before the termination takes effect, or the agent can continue acting in the window between termination and cache expiry. The safest model is: always recheck the policy engine for sensitive/destructive actions; use caching only for read-only or low-risk operations.

### Hot-Reload Design

OPA's bundle mechanism is the reference design: bundles are versioned archives. The engine polls a bundle server, downloads new bundles, compiles in-memory, and atomically swaps. The version number allows the engine to detect stale caches downstream.

For agent governance, hot-reload is not just a deployment convenience — it is a security requirement. When a security incident is detected, policy must update within seconds, not after the next deployment cycle. Design considerations:

1. **Pull vs. push:** Pull (polling) is simpler but has inherent latency (poll interval). Push (bundle server signals the engine) can achieve near-real-time propagation. OPA supports both through its control plane options.

2. **Validation before activation:** Bundle updates should be validated before activation. OPA compiles and validates before swapping. For custom policy engines, equivalent pre-activation validation prevents deploying a syntactically invalid policy that breaks all decisions.

3. **Emergency kill-switch:** Keep a separate, minimal "deny-all" policy that can be activated in <1 second to halt all agent tool invocations during an incident. This should bypass the normal bundle mechanism to ensure it cannot be blocked by a slow or corrupt bundle update.

---

## Trust-Aware Policy Design

### Trust Domains and Session Isolation

Trust Domains are a first-class concept in agent governance: they define the boundary within which a set of policies applies and beyond which requests must be explicitly re-authorized. A Trust Domain maps to a combination of user identity, session identifier, and context attributes.

In policy terms, Trust Domains implement the "confused deputy" defense: agent session A cannot invoke tools in the context of user B simply because both are running in the same process. Every tool invocation carries the Trust Domain as an attribute, and policy explicitly binds tool authorizations to Trust Domain scope.

**OPA Trust Domain enforcement:**

```rego
package agent.tool_authorization

import future.keywords.if
import future.keywords.in

default allow = false

allow if {
    # Agent must be operating in the correct trust domain
    input.agent.trust_domain == input.session.trust_domain

    # Trust domain must be active (not revoked/expired)
    domain := data.trust_domains[input.agent.trust_domain]
    domain.status == "active"
    time.now_ns() < domain.expires_at_ns

    # Tool must be permitted within this trust domain
    tool_allowed_in_domain
}

tool_allowed_in_domain if {
    domain_policy := data.trust_domains[input.agent.trust_domain].tool_policy
    input.tool.name in domain_policy.allowed_tools
    input.tool.risk_level <= domain_policy.max_risk_level
}

tool_allowed_in_domain if {
    # Fall through to global policy if no domain-specific policy
    not data.trust_domains[input.agent.trust_domain].tool_policy
    global_tool_allowed
}
```

### Dynamic Capability Grants

Capabilities should be minted at session creation and scoped to the minimum needed for the declared task. This is "just-in-time" capability provisioning: rather than assigning a static role to an agent that persists across all its work, generate a bounded capability token per task.

The lifecycle:

1. **Task receipt:** Governor receives task from user. LLM (in Category C mode) classifies the task to identify which tool categories it will require.
2. **Capability minting:** Governor mints a capability token scoped to those tool categories, the specific Trust Domain, and a bounded TTL.
3. **Execution:** Executor presents the capability token with each tool invocation. Policy engine validates the token has not expired, has not been revoked, and permits the specific tool.
4. **Revocation:** Governor can revoke the capability token at any point (on error, on user cancel, on policy violation detection) by adding the token ID to a revocation list checked by the policy engine.

This maps to the "confused deputy" prevention pattern from capability-based security theory: capabilities are unforgeable tokens that carry their own authorization, rather than ambient authority that the system grants based on identity alone.

**Cedar capability token policy:**

```cedar
permit (
    principal == Agent::"session-abc",
    action in [Action::"tool:web-search", Action::"tool:file-read"],
    resource in ResourceSet::"session-abc-scope"
) when {
    context.capability_token == "tok_abc123" &&
    context.capability_token_expires_at > context.now &&
    !principal.capability_revoked
};
```

### Contextual Authorization

Policy decisions should incorporate context that varies at request time: time of day, network location, recent behavioral signals, accumulated risk score for the session. This is the ABAC layer on top of structural access control.

Effective context attributes for agent governance:

- **Session age:** Newly created sessions might have lower initial trust; trust can be elevated after successful completion of low-risk operations.
- **Cumulative risk score:** Track a running score of the risk level of tools invoked in the session. Trigger additional scrutiny or human-in-the-loop escalation when the score crosses a threshold.
- **Behavioral anomaly signals:** Unusual invocation patterns (e.g., same tool called 50 times in 10 seconds, new resource access pattern outside the declared task scope) can downgrade the session's effective trust level dynamically.
- **Human approval state:** Whether a human has reviewed and approved the current operation batch.

---

## Policy as Code: Testing, Verification, and Governance

### Testing Policy

The worst thing about policy bugs is that they are often silent: incorrect DENY doesn't produce an error, it just blocks the operation. Rigorous policy testing is as important as rigorous application testing.

**OPA test framework:**

```rego
package agent.tool_authorization_test

import data.agent.tool_authorization

# Test: standard agent can invoke read-only tool
test_standard_read_allowed if {
    tool_authorization.allow with input as {
        "agent": {
            "id": "agent-001",
            "trust_level": 2,
            "capabilities": ["web-search"],
            "trust_domain": "tenant-a",
            "session_id": "sess-001"
        },
        "tool": {"name": "web-search", "risk_level": 1},
        "session": {"trust_domain": "tenant-a"}
    } with data.trust_domains as {
        "tenant-a": {"status": "active", "expires_at_ns": 9999999999999999999}
    } with data.tools as {
        "web-search": {"min_trust_level": 1}
    }
}

# Test: cross-domain request is denied
test_cross_domain_denied if {
    not tool_authorization.allow with input as {
        "agent": {"trust_domain": "tenant-a", ...},
        "session": {"trust_domain": "tenant-b"}
    }
}
```

Cedar's analysis tooling provides capabilities beyond unit testing: formal equivalence checking (do two policy versions make the same decisions for all possible inputs?), coverage analysis (are there principal/resource/action combinations for which no policy applies?), and slicing (given this specific access request, which policies are relevant?).

### Policy Versioning and Change Management

Policies are code and should be treated as code: version controlled, reviewed, tested in CI, deployed with rollback capability. Key practices:

1. **Policy bundles include a manifest** with version, changelog entry, and the test suite that was run against this version. The version is logged with every policy decision, enabling retrospective auditing (what policy was in effect when this decision was made?).

2. **Staging environments run the same policy engine** as production. Policy changes are tested in staging before promoting.

3. **Canary policy deployment:** Deploy new policies to 5% of sessions and compare decision distributions against the incumbent policy. Significant divergence triggers an automatic rollback.

4. **Breaking-change detection:** Cedar's formal analysis can detect when a new policy is strictly more restrictive than the previous version (safe — only potentially breaks legitimate use cases), strictly more permissive (security review required), or has changed behavior in both directions (mandatory human review).

---

## Applying These Patterns to Session-Governor-Executor Architecture

The Session-Governor-Executor model is a natural host for the hybrid policy patterns described above. Here is how each component maps to the policy engine concepts discussed:

### Governor as Policy Decision Orchestrator

The Governor is the central orchestrator and the logical policy decision point (PDP). It holds the PolicyEngine instance and makes all authorization calls before delegating to the Executor. It should never delegate the authorization decision itself — only the execution of already-authorized actions.

The Governor's PolicyEngine should implement the 4-category model:

```
GovernorPolicyEngine.authorize(request):
    // Category A: Hard limits — evaluate synchronously, no LLM
    if hardLimitCheck(request) == DENY:
        return DENY, reason="hard_limit"

    // Category B/D: Pattern-based + optional enrichment
    classifiedRequest = maybeEnrichWithLLM(request)  // only if ambiguous
    if deterministicPolicyEngine.evaluate(classifiedRequest) == DENY:
        return DENY, reason="policy_deny"

    // Category C: Semantic check for high-stakes decisions
    if request.requiresSemanticCheck:
        semanticResult = llmClassifier.classify(request)  // structured output
        if not deterministicThresholdCheck(semanticResult):
            return DENY, reason="semantic_policy_deny"

    return ALLOW
```

The key invariant: **the Governor never returns ALLOW based on LLM output alone**. LLM output always enters a deterministic threshold function.

### Trust Domain Enforcement at Session Boundary

Sessions are Trust Domain boundaries. When a new session is created, the Governor:

1. Establishes the Trust Domain identifier (typically `{user_id}:{session_id}`).
2. Mints a scoped capability token with the tools needed for the declared task.
3. Passes the capability token to the Executor. The Executor presents it with every tool call.
4. The PolicyEngine validates the capability token at each invocation — it does not re-derive permissions from identity on every call.

This means Trust Domain violations are caught at the capability token validation layer before any policy evaluation: a tool call that does not carry a valid token for the current Trust Domain is rejected immediately (Category A).

### PolicyEngine Composition Pattern

For the Session-Governor-Executor architecture, a layered policy composition pattern works well:

```
Layer 1: Hard Limits (Casbin or custom, sub-millisecond, embedded)
    - Rate limits
    - Global blocklists
    - Trust domain cross-check
    - Capability token validation

Layer 2: Structural Authorization (OPA or Cedar, 1-5ms, sidecar)
    - Role/capability based tool access
    - Trust level requirements
    - Resource scope checks
    - Time-bound access windows

Layer 3: Contextual/Semantic (LLM-fed deterministic rules, 50-200ms, async pre-evaluation)
    - Task scope conformance
    - Behavioral anomaly flags
    - Human approval requirements for high-risk batches
```

Layers are evaluated in order. Layer 1 denials are immediate and synchronous. Layer 2 is the standard path for most requests. Layer 3 is invoked only for operations flagged as requiring semantic review — this flag itself can be set deterministically (based on tool risk level, accumulated session risk score, or explicit policy markers).

### Executor as Policy Enforcement Point

The Executor is the policy enforcement point (PEP). It enforces, but does not decide. The distinction matters: if the Executor were allowed to re-interpret policy ("the Governor said to invoke tool X, but I'll also invoke tool Y because it seems related"), security guarantees collapse. The Executor must:

- Call exactly the tools authorized in the Governor's decision.
- Pass capability tokens and Trust Domain identifiers to the tool layer.
- Return structured results to the Governor, not act on them directly.
- Never invoke tools outside the authorized capability set, even if the LLM component requests them.

This maps to the PEP principle: the enforcement point is dumb and fast, the decision point is smart and authoritative.

### Handling Policy Violations

When the PolicyEngine denies a tool invocation, the Governor should:

1. Log the violation event with full context (agent id, session id, tool, reason, policy version, timestamp).
2. Evaluate whether the violation is a hard-limit breach (terminate the session immediately) or a soft denial (continue session with reduced capabilities, notify user).
3. Optionally escalate to human review for significant violations.
4. Feed the violation signal back into the session's contextual risk score, potentially tightening future authorization checks within the same session.

Hard-limit violations (Category A denials) should always terminate the session. A single cross-domain access attempt or blocklist hit should not be treated as a recoverable error.

---

## Real-World Implementations and Lessons Learned

### Least-Privilege AI Agent Gateway (InfoQ, 2025)

A published production pattern from InfoQ describes a least-privilege AI Agent Gateway for infrastructure automation using MCP and OPA. The key design choices:

- OPA as the centralized policy decision point, with all tool invocations passing through it.
- Short-lived execution environments (ephemeral runners) replace long-lived agent sessions, reducing the blast radius of any single agent compromise.
- OpenTelemetry integration for policy decision observability: every OPA decision is a trace span, enabling correlation between policy decisions and downstream effects.
- Policies are tested in CI with `opa test` before deployment.

Lesson: short-lived sessions are a policy simplification as much as a security measure. Policies for ephemeral sessions are simpler because there is no accumulated state to reason about.

### Airia Agent Constraints (2025)

Airia launched "Agent Constraints" in September 2025, positioning it as the first policy engine purpose-built for centralized AI agent governance. Its architecture mirrors the layered pattern described above: a Context Aggregator enriches the request, a Policy Evaluation Engine applies deterministic rules with conditional logic, and a Policy Enforcement Engine executes the decision.

A notable design choice: the enforcement engine can not only ALLOW or DENY, but also MODIFY — constraining tool parameters to a safe subset (e.g., allowing a file-write tool but constraining the target path to a sandboxed directory). This "parameter rewriting" enforcement mode is powerful but requires care: modified requests should be clearly logged as modified, and the original request should be preserved for audit purposes.

### Microsoft Agent Governance Toolkit (GitHub, 2025)

Microsoft open-sourced an Agent Governance Toolkit targeting the OWASP Agentic Top 10. It covers policy enforcement, zero-trust identity, execution sandboxing, and reliability engineering as a unified framework. The toolkit uses OPA as its policy engine and maps policies directly to the OWASP threat categories, making it straightforward to audit governance coverage against a known threat taxonomy.

Lesson: framing policy coverage against a standard threat taxonomy (OWASP, NIST, or custom) gives stakeholders a shared vocabulary for discussing governance completeness.

### Governance-as-a-Service Research (arXiv 2508.18765, 2025)

Researchers from multiple institutions proposed a GaaS model as a non-invasive runtime proxy for multi-agent systems. Unlike retraining-based safety (RLHF), GaaS operates at the output layer without modifying model internals. Its enforcement engine assigns quantitative trust scores to agent outputs using a severity-weighted penalty framework, enabling three modes: coercive (block), normative (warn), and adaptive (escalate on repeated violations).

The trust score mechanism maps cleanly to the "accumulated session risk score" concept discussed above. Rather than a binary allow/deny per action, trust score accumulation enables progressive enforcement: the first suspicious action triggers a warning; the third triggers human escalation; the fifth triggers session termination.

---

## Trade-Off Analysis: Choosing a Policy Engine

| Dimension | OPA/Rego | Cedar | Casbin | Zanzibar/OpenFGA |
|---|---|---|---|---|
| **Expressiveness** | Very high (general-purpose) | High (auth-focused) | Medium (PERM model) | Medium (relational) |
| **Performance** | 1–5ms sidecar | 42–60x faster than Rego | <1ms embedded | ~1ms with cache |
| **Formal verification** | No (only testing) | Yes (SMT-based) | No | Partial |
| **Hot-reload** | Yes (bundles) | Yes | Yes | Yes |
| **Learning curve** | High (Rego is unfamiliar) | Low (readable syntax) | Low (CONF + CSV) | Medium (tuple model) |
| **Ecosystem maturity** | Very high (CNCF graduated) | Growing (CNCF sandbox) | High (multi-language) | Growing |
| **Agent governance fit** | Good (flexible, complex logic) | Excellent (safe by default, analyzable) | Good (simple RBAC/ABAC) | Good (delegation chains) |
| **Multi-tenancy** | Manual domain modeling | Built-in with namespacing | Native domain support | Native (per-object ACLs) |

For a Session-Governor-Executor architecture, the recommended approach is a hybrid:

- **Cedar** for structural authorization (tool permissions by capability and trust level) — its formal verification and deny-by-default semantics make it the safest choice for the core access control layer.
- **Casbin** (embedded) for hard-limit checks — rate limits, blocklists, trust domain isolation — where sub-millisecond latency is required.
- **Custom scoring logic** (not a general-purpose policy engine) for behavioral anomaly tracking and risk score accumulation — this is application-specific state that policy engines are not well-suited to manage.
- **OpenFGA** if multi-agent delegation chains are a first-class requirement — its ReBAC model handles hierarchical delegation naturally.

---

## Conclusion

Policy engines are not optional infrastructure for AI agent governance — they are the foundation. The probabilistic nature of LLMs makes them fundamentally unsuitable as policy decision makers. Deterministic policy evaluation is the only foundation on which reliable, auditable governance can be built.

The critical design principle is the "LLM as advisor, not judge" model: LLMs can enrich policy decisions with semantic classification, but structured LLM output must always enter a deterministic decision function. The final ALLOW/DENY must always come from deterministic evaluation.

The 4-category LLM boundary model (A: never LLM, B: default non-LLM with optional assist, C: must LLM feeding deterministic enforcement, D: deterministic prefilter + LLM + deterministic enforcement) provides a practical framework for classifying each type of authorization decision and routing it to the correct evaluation path.

For production agent governance systems, the most important operational investments are: policy-as-code with CI testing, hot-reload with sub-second emergency overrides, per-decision audit logs that capture the policy version and all decision inputs, and short-lived capability tokens scoped to individual task executions.

The ecosystem is moving fast. Cedar's entry into the CNCF sandbox, the proliferation of ReBAC-based systems like OpenFGA, and purpose-built agent governance products like Airia Agent Constraints all signal that the tooling gap for agent governance is closing quickly. The architectural patterns described here — layered deterministic enforcement, hybrid LLM-fed policy evaluation, Trust Domain isolation, dynamic capability minting — will remain sound regardless of which specific engines are chosen.

---

## References and Further Reading

- Open Policy Agent documentation and Rego language reference: [openpolicyagent.org/docs](https://www.openpolicyagent.org/docs/latest/)
- Cedar policy language specification and formal verification paper: [arxiv.org/pdf/2403.04651](https://arxiv.org/pdf/2403.04651)
- Cedar entry into CNCF sandbox (2025): [cncf.io/blog/2025/03/28/cedar-a-new-approach-to-policy-management-for-kubernetes/](https://www.cncf.io/blog/2025/03/28/cedar-a-new-approach-to-policy-management-for-kubernetes/)
- Zanzibar: Google's Consistent, Global Authorization System (USENIX 2019): [research.google/pubs/zanzibar-googles-consistent-global-authorization-system/](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/)
- Building a Least-Privilege AI Agent Gateway with MCP and OPA: [infoq.com/articles/building-ai-agent-gateway-mcp/](https://www.infoq.com/articles/building-ai-agent-gateway-mcp/)
- Airia Agent Constraints technical deep dive: [airia.com/agent-constraints-a-technical-deep-dive-into-policy-based-ai-agent-governance/](https://airia.com/agent-constraints-a-technical-deep-dive-into-policy-based-ai-agent-governance/)
- Governance-as-a-Service: A Multi-Agent Framework for AI System Compliance and Policy Enforcement: [arxiv.org/abs/2508.18765](https://arxiv.org/abs/2508.18765)
- Microsoft Agent Governance Toolkit (GitHub): [github.com/microsoft/agent-governance-toolkit](https://github.com/microsoft/agent-governance-toolkit)
- OPA vs Cedar vs Zanzibar 2025 comparison: [osohq.com/learn/opa-vs-cedar-vs-zanzibar](https://www.osohq.com/learn/opa-vs-cedar-vs-zanzibar)
- MCP Access Control — OPA vs Cedar definitive guide: [natoma.ai/blog/mcp-access-control-opa-vs-cedar-the-definitive-guide](https://natoma.ai/blog/mcp-access-control-opa-vs-cedar-the-definitive-guide)
- Deterministic guardrails for AI agent security: [civic.com/resources/deterministic-guardrails-for-ai-agent-security](https://www.civic.com/resources/deterministic-guardrails-for-ai-agent-security)
- Cerbos vs OPA performance comparison: [cerbos.dev/blog/from-opa-to-our-own-engine-cerbos](https://www.cerbos.dev/blog/from-opa-to-our-own-engine-cerbos)
- Best practices for authorizing AI agents: [osohq.com/learn/best-practices-of-authorizing-ai-agents](https://www.osohq.com/learn/best-practices-of-authorizing-ai-agents)
- Systems Security Foundations for Agentic Computing (2025): [eprint.iacr.org/2025/2173.pdf](https://eprint.iacr.org/2025/2173.pdf)
