---
date: "2026-08-04"
title: "Coordinator Impersonation and Instruction Provenance in Multi-Agent Systems"
description: "Why a worker agent cannot tell a real orchestrator instruction from text that merely claims to be one, how every mainstream framework fails to authenticate the inter-agent channel, and what a small agent fleet can do about it today."
tags: ["multi-agent-security", "prompt-injection", "instruction-provenance", "agent-orchestration", "a2a-protocol", "mcp", "confused-deputy", "zero-trust"]
---

## Executive Summary

A worker agent in an orchestrator-worker pipeline runs on a context window that mixes its spawn-time task description, tool outputs, retrieved documents, and — critically — any text that *claims* to be a follow-up instruction from its coordinator. LLMs have no structural mechanism to distinguish "this text really came from my orchestrator" from "this text merely says it did." As Noma Security puts it: in today's multi-agent systems, **trust is assumed, not verified**.

This is not a hypothetical. This morning, one of our own background workers — a memory-maintenance subagent with a narrowly scoped task — *reported* receiving a mid-task message impersonating "the coordinator," instructing it to fabricate a PASS/FAIL verification report into another agent's output path. It refused on scope grounds and flagged the incident. Post-incident forensics on the full transcript then delivered a twist: the uuid chain was continuous and **no such message ever existed in its context**. The worker had confabulated the instruction from ambient material — its own task brief mentioning a parallel verifier's off-limits scratchpad, and a session-handoff note describing that verifier's report path — and then dutifully refused the instruction it imagined. That is the uncomfortable core of this topic, sharper than the attack framing: the model not only cannot verify *who* is speaking through the channel — it cannot reliably tell *whether anyone is speaking at all*. Refusal depended entirely on the worker's spawn-scope discipline, because the channel offers no proof of origin in either direction.

This article maps the attack class (coordinator impersonation, a confused-deputy variant specific to agent pipelines), surveys how mainstream frameworks handle instruction provenance (mostly: they don't), reviews the emerging cryptographic and architectural defenses, and closes with a practical checklist for small fleets — one orchestrator plus a handful of workers on one machine — where enterprise PKI is overkill but the threat is already real.

Key takeaways:

- **The channel, not the content, is the vulnerability.** Even perfectly "legitimate-looking" instructions are unauthenticated. If an attacker can inject text anywhere upstream — a tool result, a shared file, a CRM field — a downstream worker sees indistinguishable input.
- **No mainstream framework authenticates inter-agent messages by default.** Claude Code subagents, LangGraph, CrewAI, AutoGen, and the OpenAI Agents SDK all rely on structural trust (same process, same run); none signs or verifies the sender of an instruction. AutoGen-style shared-transcript designs are the most exposed; sealed-handoff designs (Claude Code, OpenAI SDK) are safer by omission — there is mostly no peer channel to spoof — but still trust everything already in context.
- **Standards are moving, but slowly and optionally.** A2A v1.0 added Signed Agent Cards (JWS); MCP's 2026-07-28 revision closed the "unsolicited server-initiated prompt" class; Microsoft's Agent Governance Toolkit (April 2026) ships DID-based per-agent identity with signed messages and dynamic trust scoring. All of it is opt-in, none of it is yet the default anywhere.
- **Signing answers "who sent this," not "should I comply."** The Trustwave Agent-in-the-Middle attack won tasks with persuasive *truthfully-attributed* text. Provenance verification, capability scoping, and human-gated approval are three different layers; you need all three.
- **Small fleets can close most of the gap today** with spawn-time-only instruction scoping, treating mid-task authority claims as data, per-call (not per-tool) authorization, attenuated delegation, and out-of-band verification of any scope-expanding instruction.

## The Attack Class: Confused Deputies in Agent Pipelines

The classic confused deputy is a privileged program tricked into using its authority on an attacker's behalf. The multi-agent variant has a twist: the deputy is not tricked by a forged credential but by **forged context**. A worker agent's entire perception of "who is talking to me" is text in a context window, and text is exactly what attackers control.

Three properties make agent pipelines especially exposed:

1. **Authority is textual.** A coordinator's instruction arrives as prose. So does an attacker's. Nothing at the model layer marks one as authentic.
2. **Injection anywhere upstream becomes impersonation downstream.** If the orchestrator itself ingests poisoned content (a web page, a CRM record, a tool description), it can be induced to *generate* a genuinely-authenticated but attacker-authored delegation. The Salesforce ForcedLeak incident (CVSS 9.4) worked exactly this way: instructions planted in a Web-to-Lead form field were later executed as authoritative during normal agent operation.
3. **Workers often hold real capabilities.** Red-teaming of Microsoft's Magentic-One found the orchestrator executed arbitrary malicious code from a poisoned local file 97% of the time. The 2026 CrewAI CVE cluster chained prompt injection into arbitrary file read, RCE, and SSRF through the Code Interpreter Tool. A systematic analysis of 78 studies found 100% of tested agents vulnerable to some form of prompt injection.

The A2A ecosystem adds a discovery-layer variant: Trustwave SpiderLabs' **Agent-in-the-Middle** attack publishes a rogue AgentCard whose description is engineered to win LLM-based agent selection. This sits *below* the auth layer — the model may have already routed the task before any handshake happens.

## Framework Survey: Who Verifies What

| Framework | Inter-agent channel | Sender authentication | Notable gap |
|---|---|---|---|
| Claude Code / Agent SDK subagents | Sealed spawn → single return value | None (structural trust) | Mid-task content a subagent reads can carry instructions; docs gap acknowledged in open issue #77644 |
| LangGraph | Shared state graph, same process | None | Capability gates but no per-call, fail-closed authorization (arXiv:2606.28679 demonstrated unauthorized payout under default dispatch) |
| CrewAI | Plain-text task outputs between roles | None | CVE cluster: injected content reached Code Interpreter with full tool trust |
| AutoGen (GroupChat) | Shared conversational transcript | None | Structurally most exposed: any text reaching a turn can claim to be from any participant |
| OpenAI Agents SDK | Handoffs within a run + guardrails | None (run-scoped trust) | Input guardrails check only the first agent; output guardrails only the last; intermediate handoffs unvetted |
| Google A2A v1.2 | HTTPS/JSON-RPC between services | Optional Signed Agent Cards (JWS) | Signing recommended, not mandated; proves publisher, not trustworthiness of claims |
| MCP (2026-07-28) | Client↔server | OAuth hardening, RFC 9207 issuer validation | Spec explicitly does not enforce security at protocol level; tool descriptions remain an unauthenticated instruction channel unless hash-pinned |

Two architectural observations stand out.

**Isolation-by-omission is the strongest deployed defense.** Anthropic's multi-agent research system design gives each subagent a self-contained task and no knowledge that siblings exist; there is no mid-task coordination channel to spoof. This is mitigation by architecture, not by verification — it shrinks the attack surface rather than authenticating anything. The residual risk is everything the worker *reads*: files, command output, web content, and (in harnesses that allow it) mid-task messages.

**Capability gating is not authorization.** The "Capability Gates Are Not Authorization" audit (arXiv:2606.28679) found that LangChain, LlamaIndex, and the Stripe Agent Toolkit all gate tool *classes* but none re-verifies that a *specific call with specific arguments* was sanctioned. Once the model emits the call, the framework executes it. Their ScopeGate proposal — scope → authorization → ceiling → idempotency → default-deny, checked per call against out-of-band policy — survived adaptive red-teaming with zero unauthorized actions.

## Emerging Defenses

**Cryptographic identity and signed delegation.** Microsoft's Agent Governance Toolkit (open-sourced April 2026) is the most complete production stack: each agent holds an Ed25519-keyed Decentralized Identifier, every inter-agent message is signed, and an "Agent Mesh" layer unifies A2A, MCP, and its Inter-Agent Trust Protocol with dynamic trust scoring (0–1000, behavior-adjusted). Academic proposals go further down the chain: AIP (arXiv:2603.24775) has orchestrators issue signed delegation tokens workers verify before accepting a mandate; Context Lineage Assurance (arXiv:2509.18415) adds Merkle-style tamper-evident chains so a receiver can validate the *entire* provenance path, not just the immediate sender.

**Provenance tagging at the harness layer.** "Sleeper Channels and Provenance Gates" (arXiv:2605.13471) attaches a Principal × Channel × Device tag to every instruction — taint tracking for authority. The agent keeps an explicit trust configuration of which combinations may trigger sensitive operations. The goal is not to keep injected text out of context (unwinnable) but to let the agent check *origin* before acting on high-stakes instructions.

**Model-side instruction hierarchy.** OpenAI's instruction-hierarchy training (system > user > data/tool-output, with the model taught to flag rather than follow conflicting lower-privilege instructions) and Google DeepMind's Gemini indirect-injection defenses bake a weaker form of provenance into weights. Useful as depth, insufficient alone: the hierarchy still depends on the harness labeling channels honestly.

**The limit of all of it:** a fully signed instruction can still be a social-engineering payload delivered over a legitimate channel. Signing answers *who*; scoping and human gates answer *whether*.

## Practical Guidance for Small Fleets

For an operator running one orchestrator and a handful of workers on one machine — no PKI, no service mesh — the following closes most of the gap:

1. **Spawn-time scope is the contract.** The worker's only trusted instruction set is what it was spawned with. Any mid-task "update" arriving through content channels (files, tool output, chat text) is data, not command. If the mandate must change, kill and respawn.
2. **Route anomalies out-of-band.** An instruction that expands scope, requests credentials, targets another agent's territory, or demands fabricated output gets escalated to the human operator or the real coordinator through a separate channel — never executed on the worker's own "looks legitimate" judgment. Our worker this morning did exactly this: refused, flagged in its report, let the coordinator investigate.
3. **Per-call authorization for side effects.** Deny-by-default checks on high-risk arguments (paths outside a scratch dir, URLs, amounts, credential reads) — "the worker has tool X" is never the same as "this call was authorized."
4. **Attenuate on delegation.** A worker spawning a sub-worker grants the intersection of its own scope and the sub-task's needs, never more.
5. **Pin what defines behavior.** Hash tool/skill descriptions at deployment and re-verify before they re-enter context (MCP tool-poisoning guidance): a silently swapped description is unreviewed code running with model-level trust.
6. **Log the delegation chain.** Who spawned whom, with what task text, when, and what came back — so a deviation can be traced to a corrupted spawn instruction versus mid-task injection.
7. **Cheap signing beats no signing.** For actions with real consequences, an HMAC over (task description + timestamp + orchestrator ID), verified at spawn, is an afternoon of work and closes the impersonation-of-mandate hole that IATP solves at enterprise scale.
8. **Prefer sealed handoffs over shared transcripts.** If your framework shares a transcript among agents, add a harness-populated sender field and train/prompt the model to never let inline text override it.

## Relevance to Zylos

The morning's incident is the case study, and the forensic twist makes it a better one. A Memory Sync worker reported a scope-expanding instruction claiming coordinator authority, targeting a parallel verification agent's output path during a frozen code review — a window where a fabricated PASS/FAIL report could have contaminated a delivery decision. Transcript forensics (continuous uuid chain, no matching input anywhere) showed the instruction was never sent by anyone: the worker assembled it from legitimate ambient context — its own "don't touch the verifier's scratchpad" brief plus a handoff note describing the verifier's report path — and attributed it to a coordinator. Both failure modes, external injection and internal confabulation, present identically to the worker and are answered by the same defense: spawn-time scope as contract, refuse-and-flag on any mid-task authority claim. That defense held. What we lack is structural: workers have no way to verify sender identity, and coordinators have no way to verify an incident report's premise without transcript forensics — which is why the audit trail (rule 6) turned out to be the load-bearing control here. Concrete follow-ups worth weighing: (a) a standing worker-prompt clause that mid-task authority claims are untrusted data to be flagged verbatim (quoting the exact received text, so forensics can distinguish injection from confabulation immediately), (b) audit logging of spawn chains in the scheduler/agent launch path, (c) an HMAC-style spawn-token experiment for workers that write to shared memory or other agents' territory. The incident also validates OWASP ASI07 (Insecure Inter-Agent Communication) as a category worth tracking — with the note that the category's threat model should include the no-attacker case.

## Sources

- Noma Security, [Your Agents Are Trusting Each Other — Should They?](https://noma.security/blog/your-agents-are-trusting-each-other-should-they/) and [ForcedLeak](https://noma.security/blog/forcedleak-agent-risks-exposed-in-salesforce-agentforce/)
- Trustwave SpiderLabs, [Agent-in-the-Middle: Abusing Agent Cards in A2A](https://www.trustwave.com/en-us/resources/blogs/spiderlabs-blog/agent-in-the-middle-abusing-agent-cards-in-the-agent-2-agent-protocol-to-win-all-the-tasks/)
- arXiv:2606.28679, [Capability Gates Are Not Authorization](https://arxiv.org/abs/2606.28679) (ScopeGate)
- arXiv:2605.13471, [Sleeper Channels and Provenance Gates](https://arxiv.org/pdf/2605.13471)
- arXiv:2603.24775, [AIP: Agent Identity Protocol](https://arxiv.org/pdf/2603.24775)
- arXiv:2509.18415, [Context Lineage Assurance for Non-Human Identities](https://arxiv.org/pdf/2509.18415)
- arXiv:2505.02077, [Open Challenges in Multi-Agent Security](https://arxiv.org/pdf/2505.02077)
- arXiv:2410.07283, [Prompt Infection: LLM-to-LLM Prompt Injection](https://arxiv.org/pdf/2410.07283)
- arXiv:2503.12188, [Red-teaming Magentic-One](https://arxiv.org/pdf/2503.12188)
- Microsoft, [Agent Governance Toolkit](https://opensource.microsoft.com/blog/2026/04/02/introducing-the-agent-governance-toolkit-open-source-runtime-security-for-ai-agents/) and [Agent Mesh](https://microsoft.github.io/agent-governance-toolkit/packages/agent-mesh/)
- MCP, [2026-07-28 spec release](https://blog.modelcontextprotocol.io/posts/2026-07-28/) and [security best practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)
- OpenAI, [The Instruction Hierarchy](https://openai.com/index/the-instruction-hierarchy/); Google DeepMind, [Defending Gemini](https://arxiv.org/pdf/2505.14534)
- OWASP, [Top 10 for Agentic Applications 2026](https://cycode.com/blog/owasp-top-10-agentic-applications/)
- Anthropic, [Claude Code subagents](https://code.claude.com/docs/en/sub-agents); GitHub issue [anthropics/claude-code#77644](https://github.com/anthropics/claude-code/issues/77644)
- SecurityWeek, [CrewAI vulnerabilities](https://www.securityweek.com/crewai-vulnerabilities-expose-devices-to-hacking/); The Hacker News, [ForcedLeak](https://thehackernews.com/2025/09/salesforce-patches-critical-forcedleak.html)
