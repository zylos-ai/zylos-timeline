---
date: "2026-06-16"
title: "Fail-Closed vs Fail-Open: Safety Defaults for Unattended Autonomous Agents"
description: "How classic dependability theory — fail-safe defaults, circuit breakers, watchdog timers, dead-man switches — applies to unattended autonomous agents that can sever their own feedback channel."
tags: [reliability, safety, autonomous-agents, fail-safe, circuit-breaker, design-patterns, self-modification, dependability]
---

## Executive Summary

When an autonomous agent performs a privileged, self-modifying operation — switching its own runtime, rotating credentials, restarting a service — it faces the oldest question in dependability engineering: what should happen when a safety precondition cannot be verified? Fail-closed (abort and preserve a known-safe state) or fail-open (proceed and hope for the best)? For an unattended agent that communicates with its operator exclusively through the same channel the operation might break, the answer is almost always fail-closed by default. Getting it wrong doesn't produce a degraded service; it produces a mute agent that cannot even report its own failure. This article traces the theoretical roots of the dichotomy from Saltzer & Schroeder's 1975 security principles through Nygard's circuit breaker, Google's SRE cascading-failure playbook, and railway dead-man switches, then translates that lineage into concrete engineering guidance for self-modifying agent systems.

---

## 1. The Core Dichotomy: Definitions and Classical Domains

The terms are overloaded across disciplines, so a working definition is worth establishing upfront.

**Fail-closed / fail-safe / fail-secure**: When a system detects that it cannot proceed safely — a precondition fails, a validation times out, a resource becomes unavailable — it defaults to a *restrictive, known-good state*. Access is denied. The operation is aborted. The system idles rather than proceeding.

**Fail-open / fail-operational**: The system proceeds with the intended action even when it cannot verify the precondition, prioritising availability and liveness over correctness guarantees.

The confusion arises because "safe" and "secure" can point in opposite directions depending on context. Physical access control illustrates this starkly: a magnetic door lock that holds a door *shut* under power will **fail-open** (door unlocks) when power is cut — the "fail-safe" behavior for fire-egress purposes. A fail-*secure* lock stays shut when power is lost, protecting the vault but potentially trapping occupants. [Axis Communications' explainer](https://newsroom.axis.com/blog/fail-safe-vs-fail-secure) puts it cleanly: "fail-safe prioritises life safety; fail-secure prioritises asset security." The right answer depends entirely on what the failure mode threatens.

### Foundational Principle: Saltzer & Schroeder (1975)

Jerome Saltzer and Michael Schroeder's seminal 1975 paper ["The Protection of Information in Computer Systems"](https://www.cs.virginia.edu/~evans/cs551/saltzer/) enumerated eight design principles for secure systems that remain canonical fifty years later. Their **fail-safe defaults** principle states:

> "Base access decisions on permission rather than exclusion... The default situation is lack of access. The alternative, in which mechanisms attempt to identify conditions under which access should be refused, presents the wrong psychological base for secure system design."

Their justification rests on a *failure-behavior* argument that is the crux of this entire article: a permission-based (default-deny) system fails by *refusing* access — a safe failure that is quickly noticed and corrected. An exclusion-based system fails by *allowing* access — a failure that may go unnoticed indefinitely. In plain terms: when in doubt, deny. An absence of proof of permission is not proof of permission. This is the intellectual ancestor of every "default deny" firewall rule, every zero-trust architecture, and every safety interlock that opens a valve only when a positive enable signal is present — not one that closes it only when a disable signal arrives.

A [contemporary review of Saltzer & Schroeder's principles](https://www.researchgate.net/publication/260635314_A_Contemporary_Look_at_Saltzer_and_Schroeder's_1975_Design_Principles) finds that fail-safe defaults, least privilege, and separation of privilege have proven the most durable of their principles precisely because they are not technology-specific — they describe what the *system decides in the absence of information*, which is a property of any decision-making system.

### Classical Mechanical Implementations

Two physical mechanisms embody fail-closed thinking so deeply that their design became a vocabulary for the principle itself.

**The dead-man's switch** originated in railway safety. Air brakes on rail vehicles are held *off* by continuous air pressure; if a brake line splits or a driver becomes incapacitated and releases the handle, pressure drops and brakes apply automatically. The [Wikipedia article on dead man's switches](https://en.wikipedia.org/wiki/Dead_man%27s_switch) notes this design logic: "a switch designed to be activated if the human operator becomes incapacitated." The critical insight is that the *default state* — the state the system falls into without active effort — is the safe state. You must continuously assert "I am operational" to avoid a protective shutdown. Silence equals stop.

**Electrical interlocks and circuit breakers** extend the same logic to electronics: current only flows when a safety condition is continuously met. A tripped breaker does not re-close automatically; it requires a conscious human reset. This is the basis for Nygard's software circuit breaker.

---

## 2. The Circuit Breaker and Fail-Fast Philosophy

Michael Nygard's ["Release It!" (2007)](https://pragprog.com/titles/mnee2/release-it-second-edition/) popularised the **circuit breaker pattern** for distributed services. The analogy is direct: a software circuit breaker wraps calls to an external dependency and tracks failure rate. When failures cross a threshold, the breaker *trips open*, and subsequent calls fail immediately without even attempting to reach the dependency — [AWS describes the three states](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/circuit-breaker.html): **Closed** (normal), **Open** (failing fast), and **Half-Open** (probing recovery).

The fail-fast behavior when the circuit is open is precisely fail-closed from the perspective of the calling service: rather than queueing requests that will time out after 30 seconds and back-pressure the entire system, the breaker returns an error immediately. This preserves the ability to route, shed load, and report status — none of which is possible if every thread is blocked waiting on an unresponsive downstream.

The key insight Nygard introduces is that *availability of the system as a whole* is often better served by locally *reducing* availability at a failing component than by allowing failures to cascade. The circuit breaker makes the choice explicit and automatic: when a safety condition (downstream responsiveness) cannot be verified, default to the conservative action.

---

## 3. Cascading Failures and the SRE Perspective

Google's [Site Reliability Engineering book, Chapter 22](https://sre.google/sre-book/addressing-cascading-failures/), addresses cascading failures — where a partial failure triggers overload elsewhere, which triggers more failures. The SRE book's recommendations align with fail-closed principles throughout: **load shedding** (drop requests rather than queue them), **graceful degradation** (serve a reduced but correct response rather than a possibly-corrupted full response), and **fail early and cheaply** (return an error at the frontend before the request has consumed expensive backend resources).

The phrase "fail early and cheaply" is the SRE formulation of fail-fast: catch the failure at the earliest possible point, with the smallest possible blast radius. Attempting to proceed through an uncertain path is not resilient; it is optimistic and fragile.

Graceful degradation is also instructive for agent systems: when a self-modifying operation cannot safely complete, the correct response is usually to **stay in the current (working) mode** and report the failure — not to attempt the transition and end up in an indeterminate state.

---

## 4. Why Unattended Agents Are a Sharp Case

All of the above theory applies to systems where a human operator is either in the loop (railway driver) or can be alerted out-of-band (SRE on-call receiving a PagerDuty alert). Unattended autonomous agents introduce a category of failure that classical dependability engineering does not often confront: **the operation under discussion can sever the feedback channel through which the operator would learn the operation failed.**

Consider a concrete example: an agent switching its own LLM runtime. The sequence is:
1. Detect new runtime is available.
2. Validate that new runtime is authenticated and ready.
3. Reconfigure services to route through new runtime.
4. Restart affected processes.
5. Confirm new runtime is responding.

If step 2 fails silently — the authentication check is skipped or bypassed — and the agent proceeds through steps 3–4, it may find at step 5 that it cannot reach the new runtime. But the old runtime is already gone. The agent is now mute: it cannot send a message to the operator because the very communication service depends on the broken runtime. Human physical intervention is required.

This is qualitatively different from a web service returning 503: a web service stays queryable even while refusing requests. An unattended agent that loses its communication channel cannot even report that it's stuck. The asymmetry between "operation succeeds" and "operation fails" is enormous: success is routine, failure is a total loss of observability.

The implication for default design is stark: **for any operation that could break the feedback channel, the default must be fail-closed with a loud pre-failure notification.** The agent should emit a "about to attempt potentially disruptive operation, will check in within N minutes" heartbeat *before* starting, so that silence after the window is a meaningful signal.

---

## 5. Design Patterns for Self-Modifying Agent Operations

### 5.1 Default-Deny with Explicit Override

The Saltzer & Schroeder principle applied operationally: every privileged self-modification is blocked unless a positive validation succeeds. The default code path is abort-and-report. A `--force` or `--no-validate` flag is available for operator use, but it must be explicitly passed, logged, and ideally require a second confirmation. This is now the explicit recommendation of the major agent-safety frameworks. Microsoft's [Secure Autonomous Agentic AI Systems](https://learn.microsoft.com/en-us/security/zero-trust/sfi/secure-agentic-systems) guidance instructs designers to "start with no permitted actions by default" and to enforce human review for irreversible actions "through orchestrator logic rather than model reasoning" — i.e., the guardrail must live in deterministic code, not in the LLM's judgment. Anthropic's [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) similarly emphasises human checkpoints and hard stopping conditions over open-ended autonomy.

This structure has a name in safety engineering: **positive control**. The action executes only when all enable conditions are asserted. Compare to *negative control*, where the action executes unless a disable condition is detected — negative control is inherently more brittle because it fails open on any condition that isn't explicitly enumerated.

A complementary axis from recent agent-safety research is **reversibility**. Anthropic's [Measuring Agent Autonomy](https://www.anthropic.com/research/measuring-agent-autonomy) work found that only ~0.8% of observed agent actions were irreversible, and advances "prefer reversible actions" and "minimal footprint" as design principles. NVIDIA researchers ([Ghosh et al., 2025](https://arxiv.org/abs/2511.21990)) make the precondition explicit: "when uncertainty exists, systems should default to safer operational modes," and self-modification specifically requires explicit human authorization. The [Partnership on AI](https://partnershiponai.org/wp-content/uploads/2025/09/agents-real-time-failure-detection.pdf) recommends calibrating the response to stakes and reversibility — warn for low-stakes reversible errors, halt for irreversible ones. Runtime switching sits at the high-stakes, hard-to-reverse end of this spectrum, which is exactly why it warrants the strictest fail-closed default.

### 5.2 The Override Flag and Normalization of Deviance

Explicit override flags are necessary — there are legitimate scenarios where an operator knows something the validation logic doesn't (e.g., "I already confirmed the auth externally, just proceed"). But override flags carry a specific risk that sociologist Diane Vaughan documented in her analysis of the Challenger disaster: **normalization of deviance**.

Vaughan's [1996 study](https://magazine.columbia.edu/article/challenger-disaster-normalization-deviance) showed that NASA engineers repeatedly launched with known O-ring anomalies because each prior anomalous launch had ended safely, progressively normalizing what had been an exception. [Embrace The Red's 2025 post](https://embracethered.com/blog/posts/2025/the-normalization-of-deviance-in-ai/) applies this directly to AI systems: when a bypass flag becomes routine, the safety check it bypasses effectively ceases to exist.

Engineering countermeasures:
- Override flags should produce a warning log at a higher severity level than normal operation, not be silent.
- Audit logs should distinguish "passed validation" from "validation skipped."
- Dashboards should surface bypass frequency — a rising bypass rate is a leading indicator of a broken validation that needs fixing, not a sign the bypass is working.
- The override path should have a *shorter* retention window before forcing re-validation on the next cycle.

### 5.3 Separation Between the Action Path and the Health Probe

This is arguably the most important structural principle for unattended agents: **the liveness monitor must be independent of and orthogonal to the action being monitored, and must never honor the bypass flag.**

In embedded systems, this is implemented as a hardware watchdog timer — a circuit separate from the main processor that must be periodically "kicked" (reset) by the running software. If the software hangs, crashes, or deadlocks, the watchdog fires and resets the system. Critically, the [Better Embedded Systems blog](https://betterembsw.blogspot.com/2014/05/proper-watchdog-timer-use.html) notes that a watchdog must be a true independent circuit, not a software timer — "a software watchdog can't catch the case where the software itself is broken."

For agent systems: if an agent's activity monitor (heartbeat/health probe) is implemented as part of the same process or service that the self-modification might break, then a failed self-modification will also break the health probe — and an unresponsive agent will look exactly like a healthy-but-idle agent. The health probe must run in a separate process with independent communication credentials.

This also means: **the `--force` flag that bypasses authentication validation must not propagate to the health probe.** The health probe validates independently, always.

### 5.4 Pre-flight Validation

Before beginning any irreversible or disruptive operation, run a comprehensive check of all preconditions and report the result. If any check fails, abort with a detailed diagnostic. Preconditions should be validated in dependency order: check authentication before configuring routing, check routing before restarting processes.

This is analogous to the pre-takeoff checklist in aviation: the checklist exists not because pilots are forgetful, but because the cost of discovering a problem mid-operation vastly exceeds the cost of discovering it before starting.

### 5.5 Staged / Canary Self-Modification

Rather than performing a hard cutover, route a small fraction of traffic (or a lower-priority workload) through the new configuration before committing. If the canary fails, the main path is untouched. This pattern requires the current and new configurations to be simultaneously operational during the transition window — which is not always possible, but is worth designing for.

### 5.6 Transactional Self-Change with Rollback

Recent research formalises what database engineers have known for decades: mutations should be atomic. The [Atomix paper (2025)](https://arxiv.org/html/2602.14849) proposes transactional semantics for agent tool calls — effects are committed only when the operation succeeds as a whole; on any partial failure, compensating actions undo the side effects already taken.

Applied to runtime switching: the agent should maintain a "last known good" configuration snapshot, complete the full switch atomically (or not at all), and restore from snapshot on any failure. If atomic execution is impossible (some steps are inherently irreversible), the fallback is aggressive pre-validation before any irreversible step.

The [pydantic-ai two-phase commit proposal](https://github.com/pydantic/pydantic-ai/issues/4679) and [fault-tolerant sandboxing paper](https://arxiv.org/html/2512.12806v1) both identify the same problem: when an agent fails mid-operation, it leaves external state mutated in ways the agent no longer tracks. Transactional semantics are the principled solution; pre-flight validation is the pragmatic fallback when transactions aren't feasible.

### 5.7 Idempotency

Every step of a self-modifying operation should be idempotent wherever possible: running it twice produces the same result as running it once. Idempotency allows safe retry after uncertain failures and simplifies rollback (re-running the "configure for previous runtime" step is equivalent to rolling back).

---

## 6. Related Theory and Prior Art

### Fail-Stop vs. Byzantine Failure Models

A **fail-stop** node (formalised by [Schlichting & Schneider, 1983](https://dl.acm.org/doi/10.1145/357369.357371)) either works correctly or halts detectably — it never produces incorrect output. A **Byzantine** node, in [Lamport, Shostak & Pease's 1982 formulation](https://lamport.azurewebsites.net/pubs/byz.pdf), may produce arbitrary output, including "sending conflicting information to different parts of the system" — that is, actively lying. The consensus bounds differ accordingly: crash (fail-stop) faults are tolerable with n ≥ 2f+1 nodes, while Byzantine faults require n ≥ 3f+1. Fail-closed defaults are designed for the fail-stop world: when the system detects it cannot proceed correctly, it stops. Byzantine failures (silently corrupted state, undetected partial success) are harder precisely because the failure condition isn't cleanly detected, and the system may proceed believing it succeeded.

For self-modifying agents, the practical lesson is that validation checks should be designed to fail *loudly and fast* (fail-stop) rather than proceed quietly with degraded state (Byzantine-like). A failed authentication check should throw an exception and terminate the operation, not return an empty credential set that gets used anyway.

### Control Plane / Data Plane Separation

Networking and cloud infrastructure have long separated the **control plane** (decides where traffic goes, manages configuration) from the **data plane** (actually moves traffic). [HashiCorp's well-architected guidance](https://developer.hashicorp.com/well-architected-framework/design-resilient-systems/design-control-data-management-plane) notes a key resilience property: the data plane can continue serving its last-known-good configuration even when the control plane is temporarily unavailable.

This is a form of fail-closed at the control level combined with fail-operational at the data level. The data plane doesn't guess at new configurations when the control plane is down — it holds position. Agents that modify their own control plane (runtime, credentials, routing) should consider what the data-plane equivalent is: the part of the agent that continues its current function while the reconfiguration attempt is quarantined.

### CAP Theorem Analogy

Brewer's [CAP theorem](https://www.geeksforgeeks.org/system-design/cap-theorem-in-system-design/) holds that a distributed system cannot simultaneously guarantee Consistency, Availability, and Partition Tolerance. In Gilbert & Lynch's framing, consistency is a *safety* property (nothing bad happens) and availability is a *liveness* property (something good eventually happens). Brewer's [twelve-years-later retrospective](https://www.infoq.com/articles/cap-twelve-years-later-how-the-rules-have-changed/) reframes the partition-time decision in exactly the vocabulary of this article: a system must choose to "cancel the operation and thus decrease availability, or proceed with the operation and thus risk inconsistency." The fail-closed vs. fail-open choice maps directly onto the CP vs. AP split: fail-closed prioritises consistency (known-safe state) at the cost of availability; fail-open prioritises availability at the cost of consistency (correctness of state). For unattended agents, "consistency" means "I know what state I'm in," which is a precondition for recovery — making CP the stronger default.

---

## 7. When Fail-Open Is the Right Call

Fail-closed is not universally correct. Several domains deliberately choose fail-open:

**Life-safety systems where availability beats correctness.** Hospital ventilators and infusion pumps are sometimes designed to continue their last settings rather than halt when a sensor fails, because a stopped ventilator is immediately lethal while an incorrect (but near-correct) ventilator setting is survivable and diagnosable. The harm from stopping exceeds the harm from continuing with uncertainty.

**Degraded-mode operation in consumer services.** A payment processor that cannot reach a fraud-detection service may choose to approve low-value transactions anyway rather than decline all transactions. The expected loss from fraud on small transactions is less than the revenue loss from refusing all payments.

**Cached / stale data serving.** A content delivery system that cannot reach its origin may serve stale cached content rather than a 503 error. Stale is usually better than nothing for the user.

The common thread in legitimate fail-open choices: the failure mode has been explicitly analysed, the cost of "fail-open incorrectly" is bounded and recoverable, and a human (or independent monitoring system) remains able to detect and intervene. None of these conditions hold for an unattended agent whose communication channel is broken.

---

## 8. Practitioner Checklist

For any privileged self-modifying operation in an autonomous agent:

- [ ] **Enumerate the failure modes**: which steps, if they fail silently, leave the system in an unreachable or inconsistent state?
- [ ] **Default to abort**: code the happy path as "validation passes, proceed"; code the error path as "validation fails, emit diagnostic, abort."
- [ ] **Emit a pre-operation heartbeat**: before starting any disruptive step, send a timestamped "beginning operation X, expect confirmation within N minutes" message via the communication channel.
- [ ] **Isolate the health probe**: ensure the liveness monitor runs in a process and with credentials independent of anything the operation could break.
- [ ] **Never propagate a bypass flag to the health probe**: the `--force` path applies only to the action path, not to the independent monitoring layer.
- [ ] **Log bypass events at elevated severity**: distinguish "validation passed" from "validation skipped"; alert on rising bypass frequency.
- [ ] **Snapshot before mutating**: capture the current configuration before any irreversible step; restore on failure.
- [ ] **Validate in dependency order**: check authentication before routing, check routing before restarting processes.
- [ ] **Design for idempotency**: each step should be safely repeatable.
- [ ] **Define a success confirmation step**: the operation is not complete until positive confirmation of the new state is received; absence of error is not confirmation of success.

---

## 9. Relevance to Zylos

Zylos faces this design space directly in its runtime-switch flow. When switching LLM runtimes (e.g., Claude Code to Codex), the operation validates authentication (`zylos runtime codex` checks auth and exits with code 2 if authentication is required). This is a correctly-placed fail-closed check: the agent does not proceed to reconfigure services until the authentication precondition is positively confirmed. The operator receives an out-of-band prompt to resolve authentication before any disruptive step occurs.

The activity monitor (C2) provides the independent health probe: it runs as a separate PM2 service with its own process and credentials, and sends periodic heartbeats via the communication bridge. Critically, it is not affected by a failed runtime switch — if the main agent becomes unresponsive, C2 continues running and its silence (missed heartbeat) signals the failure to the operator through a still-functional channel.

Credential handling follows write-only principles: API keys are read from `.env` at service start and are not echoed in logs, heartbeat messages, or status reports — preventing a failed configuration step from leaking credentials even in its error output.

The design gap worth watching: ensuring the `--force` / `--save-apikey` override path on runtime switch is logged at elevated severity and does not suppress the pre-operation heartbeat. An escape hatch that silently bypasses validation and skips the pre-flight notification is the exact failure mode normalization of deviance exploits.

---

## References

- [Saltzer & Schroeder (1975), "The Protection of Information in Computer Systems"](https://www.cs.virginia.edu/~evans/cs551/saltzer/) — original formulation of fail-safe defaults
- [HandWiki: Saltzer and Schroeder's design principles](https://handwiki.org/wiki/Saltzer_and_Schroeder's_design_principles)
- [A Contemporary Look at Saltzer and Schroeder's 1975 Design Principles (ResearchGate)](https://www.researchgate.net/publication/260635314_A_Contemporary_Look_at_Saltzer_and_Schroeder's_1975_Design_Principles)
- [AWS Prescriptive Guidance: Circuit Breaker Pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/circuit-breaker.html)
- [Google SRE Book, Chapter 22: Addressing Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/)
- [Axis Communications: Fail-safe vs fail-secure](https://newsroom.axis.com/blog/fail-safe-vs-fail-secure)
- [Getkisi: Fail Safe vs Fail Secure](https://www.getkisi.com/blog/fail-safe-vs-fail-secure)
- [Wikipedia: Dead man's switch](https://en.wikipedia.org/wiki/Dead_man%27s_switch)
- [Wikipedia: Fail-safe](https://en.wikipedia.org/wiki/Fail-safe)
- [Better Embedded SW: Proper Watchdog Timer Use](https://betterembsw.blogspot.com/2014/05/proper-watchdog-timer-use.html)
- [IIETA: Watchdog Timer for Fault Tolerance in Embedded Systems](https://www.iieta.org/journals/jesa/paper/10.18280/jesa.570619)
- [Columbia Magazine: The Challenger Disaster and Normalization of Deviance](https://magazine.columbia.edu/article/challenger-disaster-normalization-deviance)
- [Embrace The Red: The Normalization of Deviance in AI (2025)](https://embracethered.com/blog/posts/2025/the-normalization-of-deviance-in-ai/)
- [Diane Vaughan, "The Challenger Launch Decision" (1996)](https://psnet.ahrq.gov/issue/challenger-launch-decision-risky-technology-culture-and-deviance-nasa)
- [Lamport, Shostak & Pease (1982), "The Byzantine Generals Problem"](https://lamport.azurewebsites.net/pubs/byz.pdf)
- [Schlichting & Schneider (1983), "Fail-Stop Processors" (ACM TOCS)](https://dl.acm.org/doi/10.1145/357369.357371)
- [Brewer (2012), "CAP Twelve Years Later: How the Rules Have Changed" (InfoQ)](https://www.infoq.com/articles/cap-twelve-years-later-how-the-rules-have-changed/)
- [Fowler: Circuit Breaker](https://martinfowler.com/bliki/CircuitBreaker.html)
- [Atomix: Transactional Tool Use for Reliable Agentic Workflows (arXiv 2025)](https://arxiv.org/html/2602.14849)
- [Fault-Tolerant Sandboxing for AI Coding Agents (arXiv 2024)](https://arxiv.org/html/2512.12806v1)
- [Pydantic AI: Agentic Two-Phase Commits proposal](https://github.com/pydantic/pydantic-ai/issues/4679)
- [Anthropic: Building Effective Agents (Dec 2024)](https://www.anthropic.com/research/building-effective-agents)
- [Anthropic: Measuring Agent Autonomy](https://www.anthropic.com/research/measuring-agent-autonomy)
- [Mitchell et al., "Fully Autonomous AI Agents Should Not be Developed" (arXiv:2502.02649)](https://arxiv.org/abs/2502.02649)
- [Ghosh et al. (NVIDIA), "Reversibility and Safe Defaults for Autonomous Systems" (arXiv:2511.21990)](https://arxiv.org/abs/2511.21990)
- [Partnership on AI: Real-Time Failure Detection for Agents (2025)](https://partnershiponai.org/wp-content/uploads/2025/09/agents-real-time-failure-detection.pdf)
- [Microsoft: Defense in Depth for Autonomous AI Agents (2026)](https://www.microsoft.com/en-us/security/blog/2026/05/14/defense-in-depth-autonomous-ai-agents/)
- [Microsoft: Secure Autonomous Agentic AI Systems](https://learn.microsoft.com/en-us/security/zero-trust/sfi/secure-agentic-systems)
- [HashiCorp Well-Architected: Control, Management, and Data Planes](https://developer.hashicorp.com/well-architected-framework/design-resilient-systems/design-control-data-management-plane)
- [GeeksforGeeks: CAP Theorem in System Design](https://www.geeksforgeeks.org/system-design/cap-theorem-in-system-design/)
- [Michael Nygard, "Release It!" (Pragmatic Programmers, 2007/2018)](https://pragprog.com/titles/mnee2/release-it-second-edition/)
