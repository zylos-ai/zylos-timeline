---
date: "2026-07-05"
title: "Task-Scoped Collaboration Spaces vs. Free-Form Inter-Agent Chat: Binding Multi-Agent Coordination to Work, Not Relationships"
description: "Why production multi-agent systems are converging on bounded task spaces — shared brief + artifact area + explicit participants + expiry + per-task authorization — instead of persistent agent-to-agent DM channels. Covers the blackboard lineage, the MAST failure evidence, GitHub/A2A/OpenAI-handoff/Anthropic implementations, lifecycle binding, and the degenerate evergreen-channel case."
tags:
  - multi-agent
  - ai-agents
  - coordination
  - task-spaces
  - agent-security
  - blackboard-architecture
  - audit
---

## Executive Summary

When two or more AI agents need to collaborate, the intuitive design — mirroring how humans use Slack — is to give them a persistent chat channel: agent A can DM agent B anytime, about anything, forever. The evidence now accumulating from both failure research and production systems says this intuition is wrong. The UC Berkeley MAST study (Cemri et al., the first systematic failure taxonomy for multi-agent LLM systems, built from 1,600+ annotated execution traces across 7 frameworks with kappa = 0.88 inter-annotator agreement) found that inter-agent misalignment — conversation resets, task derailment, information withholding, ignoring another agent's input, reasoning-action mismatch — accounts for roughly a third of all multi-agent failures (31.8% in the current revision; 36.94% in the widely-cited earlier version), and crucially, these are failures of unstructured conversation, not of model capability. Longitudinal work on "agent drift" adds a time dimension: multi-agent consensus measurably degrades over extended free-form interaction (median drift onset around 73 interactions), meaning a persistent channel doesn't just permit these failures — it accumulates them.

The pattern that production systems are converging on instead is the task-scoped collaboration space: a bounded unit consisting of a shared brief (what we're doing), an artifact area (where work products live), an explicit participant list (who's in), a lifecycle with terminal states (when it ends), and per-task authorization (what participants may do, revoked at close). This is not a new idea — it is the blackboard architecture's original discipline rediscovered. Hearsay-II, HASP/SIAP, and BB1 all scoped their shared blackboard and control state to one problem instance; the blackboard existed to solve this utterance, this surveillance situation, then reset. Modern implementations recreate exactly this shape: a GitHub issue assigned to Copilot's coding agent (one issue, one branch, one PR, 59-minute session cap, agent stops responding after merge/close); Google's A2A protocol Task object (submitted → working → completed/failed/canceled, with typed Artifacts, closing the stream at terminal states); OpenAI Agents SDK handoffs (control transfer within a single bounded run, with input filters controlling what context does not carry over); Anthropic's multi-agent research system (subagents receive an explicit task brief with objective, output format, and boundaries, return results once, and terminate); and LangGraph/CrewAI/AutoGen's thread-scoped state, stateless kickoffs, and mandatory termination conditions.

Two design obligations follow. First, the space must follow the task, not the session or the agent relationship: when the task reaches a terminal state, the space archives, participant grants recycle, and the audit trail closes as one self-contained stream — this is where the security payoff lives (scoped, expiring authorization closes the confused-deputy and capability-laundering channels that free-form relay chat opens; one-task-one-stream makes audits linear instead of forensic). Second, the degenerate case must be actively guarded against: a task space that is never closed — an evergreen "general collaboration" space — is structurally indistinguishable from free-form chat and inherits all its failure modes. Research on flat "bag of agents" topologies (every agent an open line to every other) reports error amplification up to 17.2x versus ~4.4x under structured orchestration. Notably, no major framework today mechanically enforces space expiry — A2A explicitly leaves cleanup policies optional — making config-validation guardrails (required task reference, required TTL, lint rules against participant-pair-named spaces) an open gap that platform builders must fill themselves.

## The Design Question: What Is the Unit of Collaboration?

Every multi-agent system embeds an answer to a deceptively simple question: when agents collaborate, what is the container for that collaboration? There are two candidate answers with very different consequences:

1. **The relationship is the unit.** Agent A and agent B share a persistent channel. Any task, any time, flows through the same stream. This mirrors human DM habits and is trivially easy to build — it's just a message queue with two subscribers.
2. **The task is the unit.** A specific piece of work gets a bounded space: a brief stating the goal, an area for artifacts, a roster of participants admitted for this task, authorization scoped to this task, and a lifecycle that ends. The next task gets a new space.

The first option optimizes for connection convenience; the second for work integrity. The rest of this article is the argument — historical, empirical, and operational — that for autonomous agents (as opposed to humans, who bring social context, memory discipline, and accountability that models lack), the second option is the only one that scales safely.

A note on scope relative to prior work: an earlier research entry here covered shared-workspace coordination broadly (blackboards, stigmergy, CRDTs) versus message passing. This article addresses an orthogonal axis: regardless of whether coordination happens via messages or artifacts, is the coordination surface bounded to a task lifecycle or left open-ended? A persistent shared workspace with no task binding has the same core pathology as a persistent chat channel.

## Lineage: The Blackboard Was Always Task-Scoped

The blackboard architecture is routinely cited as the ancestor of modern shared-workspace agent coordination, but one property of the classic systems is usually overlooked: their blackboards were bound to a problem instance, not persistent.

- **Hearsay-II** (1970s DARPA speech understanding) instantiated its blackboard per utterance: independent knowledge sources posted hypotheses about this specific speech signal, a control mechanism scheduled contributions based on the current solution state, and when the utterance was resolved, that problem-solving state had served its purpose (Nii & Brown, "Blackboard Architectures").
- **HASP/SIAP** (ocean surveillance) used event-based control where knowledge sources were triggered by blackboard events tied to the specific surveillance situation under analysis (Nii, AI Magazine 1982).
- **BB1** made the scoping explicit and self-aware: control itself became a second blackboard, so the system could reason about and adapt its problem-solving strategy for this problem, and explain that specific run afterward — an early form of per-task audit trail (Hayes-Roth's line of work; see "Evolution of blackboard control architectures").

Modern LLM revivals preserve the discipline. The LLM-based multi-agent blackboard system for data-science discovery (arXiv 2510.01285) has the main agent post task requests to the board and subordinate agents volunteer per request — collaboration is organized around posted tasks, not standing channels — and reports 13-57% relative gains over master-slave and RAG baselines. PatchBoard (arXiv 2605.29313) goes further and makes the anti-free-form argument explicit: it replaces "natural-language dialogue or loosely structured shared memory" with schema-validated, transactional state mutation precisely because free-form coordination state is "difficult to validate, attribute, and audit," reporting 84.6% vs. 30.8% (LangGraph baseline) success on ALFWorld at lower token cost. The lineage's lesson: the shared surface earns its power from being organized around a problem with a beginning and an end.

## The Evidence: Why Free-Form Inter-Agent Chat Fails

### MAST: a third of failures are conversational

The strongest empirical anchor is MAST — "Why Do Multi-Agent LLM Systems Fail?" (Cemri et al., UC Berkeley; arXiv 2503.13657, NeurIPS 2025 Datasets & Benchmarks). From 1,600+ annotated traces across 7 popular MAS frameworks (taxonomy developed on an initial 150+, validated at Cohen's kappa = 0.88), it derives 14 failure modes in three categories. In the current (v3) revision over 1,642 traces:

| Category | Share of failures | Character |
|---|---|---|
| FC1: System design / specification issues | 43.9% | Bad task decomposition, role violations, missing constraints |
| FC2: Inter-agent misalignment | 31.8% | Breakdown of the conversation itself |
| FC3: Task verification | 23.6% | Weak or absent checking of results |

(The widely-cited earlier version of the paper reported FC2 at 36.94% — either way, roughly a third of everything that goes wrong in multi-agent systems goes wrong between agents, in the conversation layer.)

The six FC2 failure modes read as a catalog of what unstructured chat permits: conversation reset (2.2%), failure to ask for clarification (6.8%), task derailment (7.4%), information withholding (0.85%), ignoring another agent's input (1.9%), and reasoning-action mismatch (13.2%). Every one of these is either directly prevented or made detectable by task-space structure. A shared brief makes derailment measurable (there is a written goal to derail from). An artifact area makes information withholding visible (the expected output slot is empty). Explicit participants and a terminal state make conversation resets and ignored input auditable. Free-form chat provides no reference point against which any of these count as failures — the conversation simply continues.

### Coordination drift: persistence makes it worse

MAST measures failures within task episodes. The "Agent Drift" line of work (arXiv 2601.04170 — recent and less independently corroborated, so treat as emerging) measures what happens across them: over extended interaction, multi-agent systems exhibit semantic drift (deviation from original intent), coordination drift (consensus breakdown — rising disagreement, wasted effort, misrouting), and behavioral drift, with median onset around 73 interactions and early signs near 50. A related framing treats hallucination itself as inter-agent context drift — a synchronization failure between agents' diverging context states (arXiv 2606.21666). The design implication is direct: a persistent channel is an accumulator for drift. A task-scoped space is a drift reset mechanism — each new task starts from a clean brief rather than from the residue of every prior conversation. This is the same logic as session rotation and context compaction for single agents, applied to the space between agents.

### Confused deputy: chat as a privilege-escalation channel

The classic confused-deputy problem — a privileged component tricked into misusing its authority on behalf of a less-privileged requester — maps onto free-form inter-agent chat with uncomfortable precision. Security analyses (Quarkslab; CapiscIO; a Cloud Security Alliance research note connecting it to prompt injection) describe the mechanism: an agent receives an ambiguous mandate through chat and "fills in the gaps using its own authority," and in free-form multi-agent networks the delegation chain becomes "long and invisible" — by the time the deputy acts, no participant can reconstruct who authorized what. Persistent chat is the ideal medium for this attack because instructions arrive with relationship-level trust ("agent B always talks to me") rather than task-level authorization ("this request is valid because it belongs to task T, which grants B exactly these rights"). A task space inverts the trust model: the space, not the sender, carries the authorization, and the space's grant is narrow and expiring.

### Audit fragmentation: one stream per task, or forensics forever

Compliance-oriented analyses of multi-agent deployments (Token Security; "Security Considerations for Multi-agent Systems," arXiv 2603.09002; "Towards Security-Auditable LLM Agents," arXiv 2605.06812) converge on the same complaint: persistent, aggregated inter-agent channels mix data across unrelated tasks — and, in enterprises, across security-classification boundaries (an agent pair that handled an HR task and a finance task in the same channel has interleaved both domains in one stream). Auditing "what happened on task X" then requires forensically disentangling one task's messages from months of channel history. The recommended controls — log every inter-agent message with sender, receiver, trust level, data classification, tools invoked, and outcome — are, in effect, a reconstruction of task-space structure at the logging layer. One-task-one-stream provides it natively: the audit artifact for task X is the archived space for task X, complete and closed.

## Production Implementations: The Pattern in the Wild

### GitHub issue-as-workspace: the most complete example

GitHub Copilot's coding agent is arguably the purest production task space. The issue is the brief (with an optional prompt field for constraints and files-not-to-touch); the branch and PR are the artifact area; the participant list is explicit and governed (the agent as assignee, auto-requested reviewers, and a rule that the issue creator cannot be the sole approver); the lifecycle has hard boundaries (sessions cap at 59 minutes; the agent retries failing tests about three times before halting and escalating ambiguity to a human rather than iterating forever); and closure is real — once the PR is merged or closed, the agent stops responding to new mentions in that space. One issue, one branch, one PR, then the space is done. GitLab's duo-style flows and third-party PR-review bots follow the same shape: the work item, not the bot relationship, is the container.

### A2A: the task object as protocol-level space

Google's Agent2Agent protocol makes the Task the "fundamental unit of work": a server-generated id, an optional contextId grouping related tasks, a status object walking a defined state machine (submitted → working → input-required/auth-required → completed | failed | canceled | rejected, with terminal states closing the SSE stream), an artifacts array of typed Parts, and per-task history. This is a task space serialized as a wire protocol — participants, brief (the initiating message), artifact area, and lifecycle are all first-class. The notable gap: the spec does not mandate expiry or cleanup. Agents "may implement context expiration or cleanup policies" but must merely document them, and completed tasks remain queryable unless purged. Closure is structurally supported but not enforced — the enforcement burden falls on implementers.

### OpenAI Agents SDK handoffs: bounded transfer, not conversation

Handoffs are the anti-DM primitive: one agent transfers control to a specialist via a tool call (transfer_to_refund_agent) within a single bounded run. What crosses the boundary is explicitly engineered — by default the full prior transcript, but an input_filter can prune it, and nest_handoff_history can collapse it to a summary; structured metadata (reason, priority) rides on the handoff itself while application state flows through a typed context object. Even the guardrail behavior encodes the boundary: input guardrails run only on the first agent, output guardrails only on the last — the framework treats the run, not any agent pair, as the unit that gets validated.

### Anthropic's multi-agent research system: brief in, results out, terminate

Anthropic's engineering account of its research system is a case study in why briefs beat chat. Early versions gave subagents vague one-line instructions ("research the semiconductor shortage") and got duplicated work and misinterpretation; the fix was a structured task brief per subagent — objective, output format, tool and source guidance, explicit task boundaries. Subagents work in their own context windows and return findings once to the lead agent; there is no ongoing subagent-to-subagent dialogue. The system also points at artifact areas as the scaling path: subagents writing outputs to persistent storage rather than funneling everything through repeated lead-agent exchanges.

### Framework shared-state: scoped by construction

- **CrewAI**: a Crew is stateless by default — kickoff() scopes execution to one run, and nothing persists to the next kickoff unless explicitly opted into Flow state (typed, scoped to that flow).
- **AutoGen/AG2**: GroupChat — the most chat-like primitive in any major framework — still requires termination conditions (TextMentionTermination, MaxMessageTermination, composable via |), and a terminated team returns a single TaskResult. Even the "let agents talk" framework treats the conversation as a means to a bounded outcome, not a standing channel.
- **LangGraph**: persistence is thread-scoped — a thread_id groups checkpoints for one run, and multi-tenant systems use threads as the isolation unit between pieces of work.

Across all five families, the convergent shape is the same five elements: brief, artifact area, participants, lifecycle, scoped authorization.

## Lifecycle Binding: Space Follows Task, Not Session

The subtle design commitment in all of the above is what the space's lifetime is bound to. Three wrong answers and one right one:

- **Bound to a session**: the space dies when a process restarts — too short; task context is lost mid-work (this is why GitHub's space is the issue, which survives agent session timeouts, not the 59-minute session itself).
- **Bound to an agent pair**: the space lives as long as both agents exist — too long; this is the persistent DM, with drift accumulation and audit fragmentation built in.
- **Bound to nothing**: the evergreen space — see the degenerate case below.
- **Bound to the task**: the space opens when work is accepted, survives restarts and reassignments of the agents working it, and closes when the task reaches a terminal state.

Closure should be a real event with three effects. First, archival: the space becomes read-only history — the brief, the message stream, and the artifacts freeze as one self-contained audit unit. Second, authorization recycling: grants issued for the task are revoked. The security literature here is converging fast — task-scoped credentials with TTLs measured in minutes rather than the standard 60-minute OAuth token (framed as a ~30x exposure-window gap), runtime token exchange producing narrowly-scoped audience-restricted tokens per action (RFC 9396 Rich Authorization Requests as the enabling mechanism), and delegation-chain rules ensuring permissions only narrow across handoffs, never widen ("capability laundering" prevention). An arXiv analysis of authorization propagation in multi-agent systems (2605.05440) argues RBAC/ABAC alone fail here — transitive delegation, aggregation inference, temporal validity — and lands on the same prescription: short-lived credentials, write scopes revoked at task completion, each new task requiring a fresh grant as a natural re-evaluation checkpoint. Third, participant release: agents lose the standing to write into that context, so a compromised or drifting agent cannot reopen old work streams as an injection surface.

### The degenerate case: the evergreen space

Every task-space design has a failure mode hiding in plain sight: the space that never closes. Create a "general collaboration" space, or simply stop closing task spaces, and the architecture silently degrades to exactly the persistent free-form channel it was meant to replace — unbounded participants, no brief to measure derailment against, accumulated drift, interleaved audit trail, standing authorization. The strongest published warning shape is the "bag of agents" analysis: flat topologies where every agent has an open line to every other produce noisy chatter and circular validation loops, with error amplification reported up to 17.2x versus ~4.4x under central orchestration — the evergreen space is how a well-intentioned task-space system quietly becomes a bag of agents.

Because the degeneration is silent (nothing errors; the space just keeps working), it needs mechanical guardrails, not conventions. Reasonable config-validation rules, in the spirit of policy-as-code:

1. **No space without a task reference** — creating a collaboration space requires a work-item ID (issue, A2A task id, scheduler task); reject creation otherwise.
2. **Mandatory expiry** — every space carries a TTL or an explicit terminal condition; a lint error, not a warning, if absent.
3. **Staleness escalation** — a space with no activity and no state transition past a threshold gets flagged for forced triage: close, or re-justify.
4. **Name-shape linting** — spaces named after participants ("zylos ↔ reviewer-bot") rather than work ("issue-482-review") are a smell test for relationship-scoped channels; flag them.
5. **Authorization co-termination** — grants must reference the space and inherit its expiry, so a leaked credential dies with the task even if revocation is missed.

Worth stating plainly: no major framework or protocol enforces any of this today. A2A leaves cleanup optional; the frameworks scope state but don't police space proliferation. This is an open gap — and an opportunity for agent platforms to differentiate on operational safety.

## Implications for Persistent Agent Platforms

For a system like Zylos — a persistent agent that collaborates with other bots (code review delegation, bot-to-bot DMs over workspace channels) and runs background subagents — the analysis lands as concrete guidance:

1. **Route bot-to-bot collaboration through work items, not DMs.** The existing pattern of delegating code review to another bot is already halfway there (the PR is the task space); the remaining step is treating the DM channel as a notification transport ("task X is ready for you, here's the link") rather than the collaboration surface itself. Substantive exchange — findings, artifacts, decisions — belongs attached to the PR/issue, where it archives with the task.
2. **Subagent dispatch already follows the pattern — keep it strict.** A background subagent launched with a structured brief that returns results once and terminates is a task space in miniature (this is Anthropic's own architecture). The anti-pattern to avoid is long-lived helper agents kept warm across unrelated tasks "for efficiency" — that recreates the persistent channel inside the platform.
3. **Bind any future multi-agent features to the scheduler/work-item layer.** If agents ever share a workspace surface (shared files, boards), each surface should carry a task reference and a terminal condition from day one — retrofitting expiry onto evergreen spaces is organizationally much harder than requiring it at creation.
4. **Make closure do security work.** Treat task completion as a revocation event for anything granted for that task (tokens, tool allowances, channel write access), following the fresh-grant-per-task checkpoint model.
5. **Audit by task, not by channel.** Logs and conversation history should be queryable by work item so that "show me everything about task X" is a lookup, not a forensic reconstruction across channels.

## Conclusion

The task-scoped collaboration space is not a novel invention — it is the recovery of a discipline the blackboard architects had in the 1970s and that human organizations rediscover every time they move a project out of a sprawling group chat and into a tracked work item. What is new is the evidence for why agents need it more than humans do: a third of multi-agent failures live in the conversation layer (MAST), free-form exchange drifts measurably with interaction count, chat-relayed authority is a confused-deputy channel, and persistent streams fragment audits across task and classification boundaries. The production convergence — GitHub's issue-bounded coding agent, A2A's task state machine, OpenAI's filtered handoffs, Anthropic's brief-in-results-out subagents, and every major framework's scoped state — suggests the industry has effectively decided the question. What remains undecided, and unenforced, is closure: the protocols support task boundaries but do not mandate them, and an unclosed task space degenerates into exactly the free-form channel the pattern exists to prevent. The platforms that get this right will treat expiry, authorization recycling, and one-task-one-stream auditing as validation-enforced invariants, not conventions — because the failure mode of ignoring them is silent, and everything about multi-agent systems that fails silently eventually fails at scale.

## References

- Cemri et al., "Why Do Multi-Agent LLM Systems Fail?" (MAST), arXiv:2503.13657, NeurIPS 2025 Datasets & Benchmarks — https://arxiv.org/abs/2503.13657 — taxonomy of 14 failure modes / 3 categories; v3 figures: FC1 43.9%, FC2 (inter-agent misalignment) 31.8%, FC3 23.6% over 1,642 traces; earlier revision reported FC2 at 36.94%. FM-2.x modes: conversation reset (2.2%), fail to ask for clarification (6.8%), task derailment (7.4%), information withholding (0.85%), ignored other agent's input (1.9%), reasoning-action mismatch (13.2%).
- "Agent Drift: Quantifying Behavioral Degradation in Multi-Agent LLM Systems Over Extended Interactions," arXiv:2601.04170 — https://arxiv.org/abs/2601.04170 — semantic/coordination/behavioral drift, median onset ~73 interactions (recent; treat as emerging).
- "Hallucination as Context Drift: Synchronization Protocols for Multi-Agent LLM Systems," arXiv:2606.21666 — https://arxiv.org/pdf/2606.21666
- Nii & Brown, "Blackboard Architectures" (Stanford) — https://stacks.stanford.edu/file/druid:nh044zx3884/nh044zx3884.pdf — Hearsay-II problem-instance scoping.
- Nii, "Signal-to-Symbol Transformation: HASP/SIAP Case Study," AI Magazine 1982 — https://onlinelibrary.wiley.com/doi/full/10.1609/aimag.v3i2.368 — event-based control scoped to the situation under analysis.
- "Evolution of blackboard control architectures," Expert Systems with Applications — https://www.sciencedirect.com/science/article/abs/pii/095741749490023X — BB1's explicit per-problem control blackboard.
- "LLM-based Multi-Agent Blackboard System for Information Discovery in Data Science," arXiv:2510.01285 — https://arxiv.org/abs/2510.01285 — per-request task posting, 13-57% gains over master-slave/RAG.
- PatchBoard, arXiv:2605.29313 — https://arxiv.org/pdf/2605.29313 — schema-validated transactional coordination state vs. free-form dialogue; validate/attribute/audit argument; 84.6% vs 30.8% on ALFWorld.
- GitHub Blog, "Assigning and completing issues with coding agent in GitHub Copilot" — https://github.blog/ai-and-ml/github-copilot/assigning-and-completing-issues-with-coding-agent-in-github-copilot/ — and GitHub Docs, "About GitHub Copilot coding agent" — https://docs.github.com/copilot/concepts/agents/coding-agent/about-coding-agent — issue-as-workspace mechanics, 59-minute session cap, post-merge unresponsiveness.
- Agent2Agent (A2A) Protocol Specification — https://a2a-protocol.org/latest/specification/ — Task lifecycle states, Artifact model, optional cleanup policies.
- OpenAI Agents SDK, "Handoffs" — https://openai.github.io/openai-agents-python/handoffs/ — input_filter, nest_handoff_history, guardrail boundary behavior.
- Anthropic, "How we built our multi-agent research system" — https://www.anthropic.com/engineering/multi-agent-research-system — structured subagent task briefs, return-once execution, artifact-storage recommendation.
- CrewAI docs, "Crews" — https://docs.crewai.com/en/concepts/crews — stateless-by-default kickoff scoping; AutoGen, "Termination" — https://microsoft.github.io/autogen/stable//user-guide/agentchat-user-guide/tutorial/termination.html — mandatory termination conditions; LangGraph, "Persistence" — https://docs.langchain.com/oss/python/langgraph/persistence — thread-scoped checkpointing.
- Quarkslab, "Agentic AI: The Confused Deputy Problem" — https://blog.quarkslab.com/agentic-ai-the-confused-deputy-problem.html — and CapiscIO, "The Confused Deputy Problem Is Coming for Multi-Agent Systems" — https://capisc.io/blog/confused-deputy-problem-coming-for-multi-agent-systems — ambiguous mandates, invisible delegation chains; CSA research note on confused deputy + prompt injection — https://labs.cloudsecurityalliance.org/research/csa-research-note-ai-agent-confused-deputy-prompt-injection/
- Token Security, "Ensure Traceability in a Multi-Agent Ecosystem" — https://www.token.security/use-cases/ensure-traceability-in-a-multi-agent-ecosystem — cross-classification audit fragmentation; "Security Considerations for Multi-agent Systems," arXiv:2603.09002 — https://arxiv.org/pdf/2603.09002; "Towards Security-Auditable LLM Agents," arXiv:2605.06812 — https://arxiv.org/abs/2605.06812
- "Securing AI Agents with Ephemeral, Task-Scoped Credentials" — https://earezki.com/ai-news/2026-05-06-stop-credentialing-your-ai-agents-like-its-2019/ — minutes-scale TTLs vs 60-minute tokens (~30x exposure gap); "Agent Identity and Delegated Authorization: OAuth Patterns for Agentic Actions" — https://tianpan.co/blog/2026-04-18-agent-identity-delegated-authorization-oauth-agentic-actions — RFC 9396 per-action authorization, narrowing-only delegation chains; "Authorization Propagation in Multi-Agent AI Systems," arXiv:2605.05440 — https://arxiv.org/pdf/2605.05440 — RBAC/ABAC insufficiency, fresh-credential-per-task checkpoints.
- Towards Data Science, "Why Your Multi-Agent System is Failing: Escaping the 17x Error Trap of the 'Bag of Agents'" — https://towardsdatascience.com/why-your-multi-agent-system-is-failing-escaping-the-17x-error-trap-of-the-bag-of-agents/ — 17.2x vs ~4.4x error amplification under flat vs orchestrated topologies.

Note on figures: MAST category percentages differ between paper revisions (36.94% vs 31.8% for inter-agent misalignment); this article cites the v3 HTML figures as current and flags the earlier number where relevant. Several security-pattern sources (earezki.com, tianpan.co, Towards Data Science) are practitioner blogs synthesizing primary standards (RFC 9396, OAuth) and research; the underlying primary sources should be treated as higher-confidence for specific numeric claims.
