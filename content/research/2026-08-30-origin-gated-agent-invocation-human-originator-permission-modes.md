---
date: "2026-08-30"
title: "Agent-to-Agent Invocation Is Not One Gate"
description: "A scoped comparison of receiver permissions, delegated identity, loop suppression, and local orchestration—and how to debug a callback that never starts."
tags: ["research", "ai-agents", "multi-agent", "authorization", "agent-platforms", "a2a"]
---

## Executive Summary

When Agent A starts Agent B but B cannot call A back, the failure may look like a dropped message. The first place to look is the **receiving agent's invocation policy**: permission is directional, so A→B succeeding says nothing about whether B→A is allowed.

That pattern does not imply that agent platforms share one universal “human must be in the chain” rule. The mechanisms surveyed here solve different problems: GitHub suppresses a narrow class of workflow recursion; A2A leaves authorization to each receiving server; SDK handoffs stay inside an application-controlled run; Slack and Discord expose bot-authored-message metadata but do not thereby define a cross-agent authorization model. Multica combines receiver-side permissions, server-trusted delegation lineage, and per-hop authorization.

The practical design is therefore layered: put grants on the receiver, preserve trustworthy lineage without inventing a human principal, re-authorize every hop, return a generic denial to the caller, keep diagnostic detail in a privileged audit, and bound permitted chains with budgets and TTLs.

## The Callback That Failed

The motivating incident followed a two-leg path:

1. Coordinator A invoked reviewer B successfully.
2. B finished and attempted to invoke A from its reply.
3. The second leg was denied because receiver A remained private and the callback did not carry a human originator accepted by A's policy.

The important fact is the direction of the failed edge. Changing B's inbound permissions repairs A→B, which already worked. The repair belongs on A, the receiver that rejected B→A. On a platform that supports named-agent grants, A should grant B; if both agents must initiate work in both directions, configure reciprocal grants explicitly. In the Multica implementation examined for this article, the applicable broader option was a workspace-scoped `public_to` target on A.

This distinction is easy to miss because the first successful leg makes the pair look connected. Invocation access is not a symmetric relationship unless the platform deliberately models it that way.

## Multica as of the Article Date

Two public Multica issues describe real historical gaps, but their issue bodies are not an accurate account of the code that existed on August 30, 2026:

- Issue #2120 described coordinator workflows that depended on a sub-agent remembering to notify the parent. PR #3055, merged May 22, added a platform-generated parent notification for child completion; the issue closed July 24.
- Issue #1290 described member-only checks blocking agent-driven backlog activation. PR #3270, merged May 26, allowed that transition while retaining a self-promotion guard; the issue closed May 29.

At commit [`3adc0061`](https://github.com/multica-ai/multica/commit/3adc0061a967e0cbdbd30e645bd6730235c64c9d) on August 21, Multica's invocation path had these properties:

- **The receiver owns the decision.** A private agent admits its owner only. A `public_to` agent evaluates its invocation targets.
- **Workspace scope is deliberately broader than member scope.** A workspace target admits workspace-internal agent and system principals even when no human originator resolves. A member target requires a matching human; team targets were reserved and inert in this revision.
- **Lineage is server-trusted.** Agent-authored comments record the authoring task from trusted task headers. Cross-issue comments preserve that task link rather than dropping it.
- **Human lineage is inherited, not substituted.** If a task already acts for a human, the chain carries that human forward. The implementation does not invent an owner fallback or adopt the target issue's originator.
- **Every hop is authorized again.** Preserving a human in the chain does not bypass the receiver's `canInvokeAgent` decision.
- **Denials have two audiences.** The caller-facing reason remains the generic `invocation_not_allowed`, which avoids revealing whether a private target exists or why it was denied. For an unattributed non-member denial, the operator log records the target, policy mode, actor, workspace, and missing-originator cause. Comment creation also returns per-target trigger outcomes, so an API caller can distinguish a blocked invocation from an accepted one without receiving protected configuration details.

The remaining failure is therefore not “Multica blocks all agent-originated work” or “the callback disappears without any machine-readable result.” A private receiver can still reject a callback, and an unattributed chain cannot satisfy a member-scoped grant; but workspace-scoped internal automation is an explicit exception, attributed chains survive agent hops, and a blocked explicit mention produces a generic outcome.

## Eight Mechanisms, Kept in Scope

| System | What the reviewed mechanism governs | What it establishes | What it does **not** establish |
|---|---|---|---|
| Multica | Whether a receiving agent may be invoked | Receiver policy, trusted originator lineage, per-hop checks, generic caller denial | A universal member-only gate or a requirement that every accepted chain contain a human |
| GitHub Actions | Events caused by a workflow's repository `GITHUB_TOKEN` | Most such events do not start another workflow run; dispatch events always create runs, while three pull-request activity types create approval-required runs | A general rule for all bots, GitHub Apps, PR authors, or agent-to-agent calls |
| Google A2A | Requests between an A2A client and server | The server authenticates each request and applies its own authorization policy | A protocol-wide human-origin requirement |
| Microsoft Copilot Studio / Entra Agent ID | Agent sharing, identity, tenant policy, and delegated authorization | Agents can be governed as identities and can participate in on-behalf-of flows | A verified product-wide peer-invocation rule comparable to Multica's |
| OpenAI Agents SDK | Handoffs and agents-as-tools inside an application run | The host application supplies the starting agent and input; a handoff is exposed as a tool | Structural proof that the input or top-level caller was human |
| Claude Code / Anthropic multi-agent research | Subagents, teams, and orchestrator-worker execution | Local coordination can improve results and materially increase token use | A cross-deployment peer authorization protocol |
| Slack | Events representing bot-authored messages | Apps can identify bot messages through the event subtype and `bot_id` | A platform-wide receiver permission for one bot waking another |
| Discord | Message authorship and mention parsing | Apps can identify bot authors; `allowed_mentions` controls notification parsing | An invocation authorization policy—mention delivery and permission to run are different concerns |

### GitHub's rule is event- and credential-scoped

GitHub documents a recursion guard for events caused by the repository's `GITHUB_TOKEN`, with two kinds of exception. `workflow_dispatch` and `repository_dispatch` events always create workflow runs. When a workflow using `GITHUB_TOKEN` creates or updates a pull request, the resulting `pull_request` events with the `opened`, `synchronize`, or `reopened` activity types create workflow runs in an approval-required state; other pull-request activity types do not. Other events caused by `GITHUB_TOKEN` do not create a new workflow run. This is a precise rule about one ambient credential and one automation system. A personal access token or GitHub App token has different consequences, and approval rules for untrusted pull requests or specific coding-agent workflows are separate controls. Treating all of these as one bot-origin gate obscures the actual boundary.

### A2A makes the receiver the authorization authority

At the last A2A repository commit before this article, the public Agent Card discovery path was `/.well-known/agent-card.json`. More importantly, the specification required the server to authenticate incoming requests and authorize them according to its own policy. Authorization failures must not reveal the existence of resources the client may not access.

`TASK_STATE_AUTH_REQUIRED` is an interrupted task state, not an authorization decision. A client may contact another human, agent, or service to fulfill the request, and the specification explicitly says the state transition alone must not be treated as permission for an operation. This is a per-request and in-task authorization model, not evidence that a human must sit at the root of every chain.

### SDK orchestration is not delegated network identity

OpenAI's Agents SDK lets the host application call a runner with a starting agent and application-supplied input. Handoffs are represented as tools within that run. It is reasonable to infer that the application owns the run boundary; it is not reasonable to infer that a human necessarily supplied the input. The SDK does not make human ancestry a structural invariant.

Claude Code subagents and teams are similarly local orchestration mechanisms rather than a standardized permission surface for independently deployed peers. Anthropic's research system is still useful evidence about economics: its orchestrator-worker design beat a single-agent baseline by 90.2% on an internal research evaluation, while multi-agent systems used about 15 times as many tokens as chat interactions. Those are first-party measurements from that system, not universal performance or cost constants.

### Messaging metadata is not an invocation policy

Slack's event schema identifies bot-authored messages using a bot-message subtype and `bot_id`. Discord's message object identifies bot users, while `allowed_mentions` controls which textual mentions are parsed into notifications. An application can use those fields to suppress loops, but that is application behavior. The reviewed official material did not establish a Slack- or Discord-wide rule equivalent to a receiving agent's invocation allowlist.

### Microsoft documents governance, not the same gate

Microsoft documents agent sharing, Entra-backed identities, registry/governance, and agent on-behalf-of OAuth. These are relevant building blocks for attribution and policy. In the reviewed primary material, however, no single rule was verified that maps directly to “Agent B may invoke Agent A only under these peer grants.” The correct conclusion is narrower: Microsoft supplies identity and governance mechanisms from which such policy can be built.

## Why Separate the Layers

Four concerns recur across the sources, but they lead to different controls:

- **Loop suppression:** Prevent one automated event from recursively generating another forever. GitHub's `GITHUB_TOKEN` rule is a narrow structural example; deduplication and hop limits are other options.
- **Receiver authorization:** Decide whether this caller may activate this receiver. This belongs to the receiver's policy and must be checked on every hop.
- **Delegation provenance:** Preserve who or what authorized a chain without trusting caller-supplied identity. RFC 8693's actor and delegation claims and agent on-behalf-of flows provide useful vocabulary, but a lineage claim still needs a trusted issuer and scoped authorization.
- **Resource control:** Bound even authorized collaboration. Anthropic's token measurements show why permitted fan-out still needs budgets, TTLs, and stop conditions.

Prompt-injection and confused-deputy risks make these layers security-relevant. The safe response is not to insist that every action has a human ancestor. It is to preserve trustworthy provenance, limit each actor to the receiver-authorized scope, and prevent authority from increasing as a request moves through the chain.

## A Safer Design for a Small Self-Hosted Platform

1. **Put the grant on the receiver.** Model an edge as `caller → receiver`. If a round trip is required, verify both directed edges rather than assuming reciprocity.

2. **Propagate only server-trusted lineage.** Derive the parent task and originator from authenticated server state. Never let a caller nominate an arbitrary human, fall back to the receiver's owner, or borrow the target issue's originator.

3. **Re-authorize at every hop.** Lineage is input to policy, not a transferable bypass. The receiving agent evaluates the effective principal and its own grants each time.

4. **Separate caller feedback from operator diagnostics.** Return a stable result such as `invocation_not_allowed` to the caller. Keep target existence, caller/callee identities, evaluated permission mode, and missing-lineage details in an access-controlled audit. Do not post those details into a shared thread that an unauthorized caller can influence or observe.

5. **Make the generic outcome observable.** A denied explicit invocation should have a machine-readable result, correlation ID, and timestamp. “Generic” protects information; it need not mean “silent.”

6. **Bound accepted chains.** Add a hop limit or TTL, an aggregate token/cost budget, deduplication or idempotency keys, and an explicit terminal condition. Receiver permission prevents unauthorized calls; these controls limit authorized runaway behavior.

7. **Keep mechanisms distinct in the data model.** Store caller identity, trusted lineage, receiver policy verdict, and resource budget separately. Collapsing them into one `is_human` flag makes legitimate automation impossible to express and makes failures hard to diagnose.

## Debugging Checklist

For A→B→A, inspect the failed B→A edge:

1. Read B's send result and confirm it attempted the invocation.
2. Inspect A's receiver-side grant; do not change B's inbound settings unless A→B is also failing.
3. Resolve the chain from server-owned task state and confirm whether a human originator is present, absent, or unexpectedly dropped.
4. Re-run A's authorization decision with the exact effective principal and target scope.
5. Match the caller's generic outcome to the privileged operator audit by correlation ID.
6. If the call was accepted, only then move downstream to queue, runtime, and delivery diagnostics.

This order separates “the platform refused to start work” from “accepted work failed later”—two failures that look similar from an idle coordinator but have different owners and remedies.

## Sources

- [Multica issue #2120 — coordinator notification gap](https://github.com/multica-ai/multica/issues/2120)
- [Multica PR #3055 — platform-owned parent notification](https://github.com/multica-ai/multica/pull/3055)
- [Multica issue #1290 — agent-driven task pickup](https://github.com/multica-ai/multica/issues/1290)
- [Multica PR #3270 — backlog-to-active trigger fix](https://github.com/multica-ai/multica/pull/3270)
- [Multica commit `3adc0061` — cross-issue originator lineage](https://github.com/multica-ai/multica/commit/3adc0061a967e0cbdbd30e645bd6730235c64c9d)
- [GitHub Docs — `GITHUB_TOKEN`](https://docs.github.com/en/actions/concepts/security/github_token)
- [GitHub Docs — triggering a workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
- [A2A specification at the pre-publication commit](https://github.com/a2aproject/A2A/blob/f63dbb48271940ca5bd421f87e27e4d6ec002795/docs/specification.md)
- [Microsoft Learn — share agents in Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-share-bots)
- [Microsoft Learn — Agent Registry convergence](https://learn.microsoft.com/en-us/entra/agent-id/agent-registry-convergence)
- [Microsoft Learn — agent on-behalf-of OAuth flow](https://learn.microsoft.com/en-us/entra/agent-id/agent-on-behalf-of-oauth-flow)
- [OpenAI Agents SDK — handoffs](https://openai.github.io/openai-agents-python/handoffs/)
- [OpenAI Agents SDK at the pre-publication commit](https://github.com/openai/openai-agents-python/tree/89c02c828ee8510fe9a84ee6675608193aa13b02)
- [Claude Code Docs — agent teams](https://code.claude.com/docs/en/agent-teams)
- [Anthropic Engineering — building a multi-agent research system](https://www.anthropic.com/engineering/built-multi-agent-research-system)
- [Slack Developer Docs — bot-message events](https://docs.slack.dev/reference/events/message/bot_message/)
- [Discord Developer Docs — message resource and allowed mentions](https://discord.com/developers/docs/resources/message)
- [Discord Developer Docs — user resource and bot marker](https://discord.com/developers/docs/resources/user)
- [RFC 8693 — OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693)
- [Cloud Security Alliance — confused-deputy attacks on autonomous agents](https://labs.cloudsecurityalliance.org/research/csa-research-note-ai-agent-confused-deputy-prompt-injection/)
