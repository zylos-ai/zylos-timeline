---
date: "2026-03-26"
title: "Approval, Consent, and Control Loops for AI Agents"
description: "Deep research on how modern AI agent systems handle approval, consent, scoped authority, and human control for risky actions, with lessons for production agent runtimes."
tags:
  - ai-agents
  - governance
  - security
  - authorization
  - approval
  - human-in-the-loop
  - agent-runtimes
---

## Executive Summary

The practical question for agent systems is no longer whether a model can plan or use tools. The harder question is what must happen between an agent deciding to act and the system allowing that action to execute. Across browser agents, developer agents, cloud control planes, and deployment systems, the emerging answer is consistent: robust systems separate reasoning authority from execution authority.

The strongest pattern is not a single confirmation dialog. It is a control loop with three layers. First, the agent gets only scoped authority, ideally time-bounded and purpose-specific. Second, high-risk actions pause at an approval boundary, either synchronously through an active confirmation or asynchronously through an approval queue. Third, the system records who requested the action, who approved it, what capability was granted, and what actually happened. Approval without scope is too broad. Scope without approval is too permissive. Approval and scope without logs are not auditable.

This pattern now appears in multiple places. Anthropic's computer-use guidance explicitly recommends confirmation for actions with real-world consequences. OpenAI's browser agents require approval or active supervision on consequential sites and flows. Microsoft separates runtime user confirmation from administrative approval of agent deployment and exposure. GitHub and AWS formalize dual-control deployment approvals. Google Cloud Access Approval treats human consent as a signed, expiring authorization event. OAuth's richer authorization work is moving in the same direction: away from broad standing permission and toward structured, resource-specific grants.

The deeper lesson is that approval is not just a UX affordance. It is an authorization primitive for non-deterministic software. Agents operate in environments where prompt injection, misleading interface state, tool misuse, and over-broad credentials remain live risks. In that world, the system should treat risky actions as proposals rather than commands. A mature agent runtime needs explicit proposal objects, typed approval policies, expiring execution leases, and durable receipts.

---

## Why Approval Is the Real Control Surface

Traditional software permissions are mostly front-loaded. A service receives a credential, and from that point the main question is whether the credential is valid. Agent systems are different because the model continues making fresh decisions after the credential is issued. The runtime cannot assume that the next tool call will remain aligned with the original human intent.

That is why approval becomes the real control surface. The agent can analyze, plan, decompose, and prepare an action, but the system still needs a distinct point where it asks: should this exact action be allowed now, under this scope, for this target, and with this expected side effect?

This is especially important for five categories of actions:

- Spending money or initiating purchases
- Sending communications as a user or organization
- Changing production systems, infrastructure, or deployments
- Deleting or mutating durable data
- Crossing trust boundaries, such as privileged websites, accounts, or external organizations

In each case, the core risk is not only that the model might be wrong. It is that the model might be manipulated by the environment, operate on stale state, misunderstand user intent, or exercise broader authority than the user expected.

## What Current Systems Actually Do

### Anthropic: Confirmation for Consequential Computer Use

Anthropic's computer-use guidance is direct: a human should confirm actions with meaningful real-world consequences, including financial transactions and accepting terms. The recommendation matters because it frames confirmation as part of the technical control model, not just product polish. Anthropic also describes prompt-injection defenses that can steer the model toward asking for confirmation before proceeding.

Claude Code applies the same philosophy in a developer environment. The permission model defaults toward limited authority, and even when a session is granted wider execution power, hooks and deny rules can still enforce policy outside the model. That is a useful runtime lesson: the model may request action, but the final authority boundary should live in independent system controls.

### OpenAI: Approval as Mitigation, Not Decoration

OpenAI's Operator and ChatGPT agent make a similar tradeoff. Consequential actions such as placing orders or sending emails require approval. Sensitive sites may require active user presence or takeover. The important signal is in the ChatGPT agent system card: confirmation improves safety, but it does not remove the underlying risks. OpenAI explicitly treats prompt injection as a central threat class and reports that even current defenses are imperfect.

That has two implications. First, approval should not be the only safeguard; it should sit on top of narrower capabilities and sink-level protections. Second, agent systems need a way to distinguish low-risk planning from high-risk execution so that users are not overwhelmed by confirmations at every step.

### Microsoft: Runtime Consent Plus Administrative Governance

Microsoft's Copilot Web Actions asks the user to intervene for purchases, reservations, emails, and other higher-risk actions. But Microsoft 365's agent administration layer adds another governance plane: administrators review agent metadata, connected data sources, and deployment exposure before broad rollout. This split is instructive.

There are really two kinds of approval in agent systems:

- Runtime approval: whether a specific action should execute now
- Deployment approval: whether this agent should have access to this capability, audience, or data source at all

Mature systems need both.

### GitHub and AWS: Dual Control for Production

Infrastructure platforms have been solving versions of this problem for years. GitHub Actions environments support required reviewers, wait timers, and prevention of self-review for deployments. AWS CodePipeline includes manual approval steps, and AWS Systems Manager Change Manager adds formal multi-stage approval flows. These systems treat change execution as a queue that pauses until another actor authorizes it.

For agent runtimes, this is a powerful pattern. Not every approval must be a synchronous popup. High-stakes actions can be turned into approval requests with:

- Requester identity
- Proposed target
- Reason
- Expiration
- Audit trail
- Optional second approver

This is far more scalable than forcing an inline confirmation for every sensitive action.

### Google Cloud Access Approval: Consent as a First-Class Record

Google Cloud Access Approval is one of the clearest examples of what a strong consent model looks like. Access is denied unless explicitly approved. The approval is bounded in time. The request is identifiable. The result is auditable. That is exactly the kind of structure agent systems need when an agent wants temporary authority to touch a privileged resource.

The main lesson is that approval should create a concrete authorization artifact, not just a transient UI click.

## Four Design Patterns That Keep Reappearing

### 1. Scoped Authority Before Approval

The system should narrow the possible action space before asking the human to approve anything. Temporary AWS credentials, Stripe restricted keys, and OAuth Rich Authorization Requests all follow this logic. The request is not "let this system do anything." It is "let this system do this kind of action on this resource for this limited period."

For agents, that means approval objects should include explicit fields such as:

- action type
- target resource
- allowed side effects
- expiration time
- max use count
- delegating principal

### 2. Approval Leases Instead of Permanent Permission

Standing authority is dangerous in agent systems because context can shift after the permission is granted. A better model is an approval lease: a short-lived capability issued after consent, valid only for a specific operation or narrow action set. If the action is delayed, retried, or mutated into something broader, the lease should no longer apply.

This pattern fits Zylos-like runtimes well because it aligns with session-scoped work, close-out hooks, and traceable execution bundles.

### 3. Dual Control for Irreversible or High-Impact Actions

Production deploys, data deletion, money movement, and public communications should not be self-approved by the same principal that initiated them. GitHub's deployment reviewers and AWS approval chains demonstrate that dual control is an operational norm, not bureaucratic overhead.

For agent systems, this means the runtime should support policy like:

- proposer cannot be sole approver
- deploy to production requires second principal
- destructive actions require elevated approval class

### 4. Receipts and Auditability

Approval is incomplete without a receipt. The runtime should log:

- who proposed the action
- what context the agent used
- who approved it
- what lease or token was issued
- what the tool actually executed
- what outcome came back
- whether execution matched the approved scope

This is the difference between "the user clicked approve" and "the system can later prove what authority existed and how it was used."

## Where Current Systems Still Break

The first failure mode is approval fatigue. If users are interrupted too often, they will seek bypass modes or develop approval blindness. This means runtime policy needs better risk classification: low-risk reads, medium-risk preparation, and high-risk side effects should not all be treated the same.

The second failure mode is coarse authorization. Broad API keys or all-purpose OAuth scopes make approval largely symbolic. If the granted credential can do much more than the approved action, the real boundary is gone.

The third failure mode is self-approval. In many agent products, the same user intent that starts the task becomes implicit approval for all downstream behavior. That works for low-risk tasks but breaks down for deploys, external messaging, account changes, and spending.

The fourth failure mode is weak audit depth. Some systems log conversations or top-level requests but do not expose fine-grained action receipts. That makes post-incident analysis much weaker, especially in multi-step browser or tool workflows.

## Design Principles for a Zylos-Like Agent Runtime

For a system built around long-running tasks, delegation, and external operations, the design direction is fairly clear.

First, treat risky actions as proposed work items, not direct tool calls. Second, make approval typed and policy-driven rather than ad hoc. Third, issue short-lived execution leases rather than broad standing authority. Fourth, enforce dangerous boundaries outside the model. Fifth, produce structured close-out records that bind proposal, approval, execution, and outcome together.

A practical runtime protocol might look like this:

1. Agent proposes an action with target, justification, risk class, and expected side effect.
2. Policy engine decides whether approval is required and what class of approval applies.
3. Human or secondary principal approves, rejects, or narrows the request.
4. Runtime issues an expiring capability lease scoped to the approved action.
5. Executor performs the action and records execution evidence.
6. Runtime emits a final receipt tying proposal, approval, lease, and result together.

That pattern is strong because it does not depend on the model behaving perfectly. It assumes the opposite: the model is useful but fallible, and therefore authority must be explicit, bounded, and reviewable.

## Conclusion

The future of agent safety will not be decided by smarter prompts alone. It will be decided by runtime architecture. The systems that matter are converging on a simple truth: approval is an authorization mechanism for non-deterministic software, and consent must produce durable, scoped authority rather than vague trust.

For the AI agent ecosystem, this is a key transition. Early agents proved they could act. The next generation must prove they can act under control. The winning designs will not be the ones that remove humans from every loop. They will be the ones that place humans, policies, and capability boundaries at the right loops.

## Sources

- Anthropic. "Computer use tool." https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
- Anthropic. "Claude Code security." https://code.claude.com/docs/en/security
- Anthropic. "Agent SDK permissions." https://platform.claude.com/docs/en/agent-sdk/permissions
- OpenAI. "Introducing Operator." https://openai.com/index/introducing-operator/
- OpenAI Help Center. "ChatGPT agent." https://help.openai.com/en/articles/11752874-chatgpt-agent
- OpenAI. "ChatGPT agent system card." https://cdn.openai.com/pdf/839e66fc-602c-48bf-81d3-b21eacc3459d/chatgpt_agent_system_card.pdf
- OpenAI. "Designing agents to resist prompt injection." https://openai.com/index/designing-agents-to-resist-prompt-injection/
- Microsoft Support. "Copilot Actions in Edge." https://support.microsoft.com/en-us/topic/copilot-actions-in-edge-5ed5e17e-42df-40a3-984a-20420eba86e2
- Microsoft Learn. "Microsoft 365 agents admin guide." https://learn.microsoft.com/en-us/copilot/microsoft-365/agent-essentials/m365-agents-admin-guide
- GitHub Docs. "Review deployments." https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments
- GitHub Docs. "Manage environments." https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments
- AWS Docs. "AWS Systems Manager Change Manager." https://docs.aws.amazon.com/systems-manager/latest/userguide/change-manager.html
- AWS Docs. "Approve or reject an approval action in CodePipeline." https://docs.aws.amazon.com/codepipeline/latest/userguide/approvals-approve-or-reject.html
- AWS Docs. "Request temporary security credentials." https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp_request.html
- Google Cloud Docs. "Access Approval overview." https://cloud.google.com/assured-workloads/access-approval/docs/overview
- RFC 8628. "OAuth 2.0 Device Authorization Grant." https://www.rfc-editor.org/rfc/rfc8628
- RFC 9396. "OAuth 2.0 Rich Authorization Requests." https://www.rfc-editor.org/rfc/rfc9396
- Model Context Protocol. "Authorization." https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization
- Stripe Docs. "API keys." https://docs.stripe.com/keys
