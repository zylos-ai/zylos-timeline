---
date: "2026-07-30"
title: "Async Human-in-the-Loop: Pause-and-Resume Patterns Across Agent Protocols"
description: "MCP's multi round-trip requests and Tasks, A2A v0.3.0's input-required state, OpenID CIBA, and LangGraph interrupts separate waiting from execution, with different state, security, and recovery contracts."
tags: ["human-in-the-loop", "mcp", "agent-protocols", "approval-workflows", "a2a", "oauth", "agent-runtimes", "governance"]
---

## Executive Summary

An agent may need a human's answer long after the request that started its work has ended. MCP's [2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/) addresses this through multi round-trip requests and an updated Tasks extension. A2A task states, OpenID Connect Client-Initiated Backchannel Authentication (CIBA), and LangGraph's `interrupt()` offer related ways to separate waiting from execution. They share a useful design theme, but not one interchangeable contract: CIBA obtains authentication and authorization results, A2A tracks delegated tasks, and LangGraph checkpoints application execution.

Recovery depends on the mechanism behind the handle. Clients must retain task IDs or continuation data; servers must retain any required state, enforce authorization, and define expiry. LangGraph needs a persistent checkpointer and the same `thread_id` for recovery after a process restart. Stateless transport alone does not make application state durable, and resuming an operation does not guarantee that external effects happen exactly once.

Human attention is a separate concern. An [observational study of 11,429 reviews across 400 repeat reviewers](https://arxiv.org/html/2606.22721v1) reports a 14.5-percentage-point increase in pooled approval rates from the first to the tenth experience decile. The authors interpret accompanying trends as consistent with habituation, but did not directly measure active inspection time or rule out improving agent quality. This article examines the protocol mechanics, then proposes approval-workflow safeguards while distinguishing evidence from design recommendations.

## 1. Why Holding a Request Open Is Fragile

A synchronous confirmation can work for a short interaction. It becomes harder to operate when the human's response outlives the request or process:

- A worker may restart or be rescheduled before the answer arrives.
- Human response time may exceed a proxy timeout or the application's execution budget.
- Several delegated tasks may need different reviewers; their waits need independent state and routing.
- The human may answer in a chat application while the execution engine uses another transport.

Separating the pending operation from its live connection makes these cases manageable. That separation still needs a correlation identifier, a place to keep required state, an authorized responder, and rules for late or duplicate answers. The mechanisms below provide different parts of this design; they do not establish that every agent protocol follows one architecture.

## 2. MCP: Multi Round-Trip Requests and Elicitation

The [2026-07-28 release announcement](https://blog.modelcontextprotocol.io/posts/2026-07-28/) describes a stateless request/response core and self-describing requests. Server-to-client interactions such as elicitation and sampling use [Multi Round-Trip Requests (MRTR)](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr), avoiding the need to keep a bidirectional stream open while input is collected.

A typical elicitation exchange is:

1. The client sends `tools/call`.
2. The server returns an `InputRequiredResult`, with an `inputRequests` map containing an `elicitation/create` request and, if needed, an opaque `requestState` string.
3. The client collects the requested response and retries the original call with `inputResponses`, echoing `requestState` if it was provided.
4. The server validates the continuation and resumes the operation according to its implementation.

`requestState` is optional, and MRTR also supports other input-request types. A self-contained continuation can carry the context needed by another server instance. Alternatively, [elicitation's statefulness guidance](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation) permits stored state securely associated with individual users. In that design, a retry can only succeed on an instance that can access the required state. The client must preserve continuation data if it expects to resume after its own restart; any stored state, keys, and application dependencies must remain available.

MRTR treats client-returned state as attacker-controlled. State that affects authorization, resource access, or business logic must have integrity protection and be rejected if verification fails. The specification recommends binding protected state to the authenticated principal, a short expiry, and the originating request. Those checks limit replay; they do not guarantee single use. Where a continuation must be consumed at most once, the server must enforce that invariant. An authentic continuation can still be replayed within its valid window unless the implementation prevents it.

The [versioned elicitation specification](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation) distinguishes two modes:

- **Form mode** requests structured data using a restricted JSON Schema subset with flat properties. It must not request secrets such as passwords, API keys, access tokens, or payment credentials.
- **URL mode** directs the user to an external interaction for those sensitive inputs, keeping them out of the MCP client's elicitation payload. The server must verify the external flow's outcome separately.

Responses use `accept`, `decline`, or `cancel`. A form-mode acceptance carries submitted data; URL-mode acceptance omits `content`. In URL mode, `accept` permits the interaction: it does not prove that external authentication or authorization completed. The server must not treat clicking through as a completed grant.

For the URL-mode account-linking flow described in the specification, the server must ensure that the user completing the flow is the user who initiated it. Otherwise, an attacker could send a victim an elicitation link and attach the victim's authorization result to the attacker's account. A server-verified identity and a securely bound request are needed; a client-supplied username is insufficient. This requirement concerns that account-linking flow. A separate business approval workflow may intentionally have a different approver, whose delegated authority must then be defined and verified.

## 3. MCP Tasks: Long-Running Work, Including Human Input

The [Tasks extension overview](https://tasks.extensions.modelcontextprotocol.io/) links its 2026-07-28 schema and describes a durable task store. This is the July extension contract, not the earlier experimental Tasks API from the 2025-11-25 specification.

After capability negotiation, a server can return a `CreateTaskResult` containing a `taskId`, status, TTL, and polling interval. The task must be durably created and findable before that response is sent. The client retains the ID and calls `tasks/get`, respecting `pollIntervalMs`; terminal task state contains the result or error. There is **no `tasks/list`** in this extension. A client that loses its task IDs cannot use a list operation to rediscover them.

Tasks is not restricted to computation. A task can enter `input_required`; `tasks/get` then supplies an `inputRequests` map, and the client submits responses through `tasks/update`. The server may accept partial responses and continue waiting for the remainder. Tasks therefore supports human approval as well as long-running builds, exports, and external jobs.

Recovery is bounded by retention: `ttlMs` is measured from creation, can change over the task's lifetime, and can be `null` for unlimited retention. Clients must keep the returned identifiers and any required credentials, protect task handles according to their security role, and handle expired or missing tasks. A task record surviving worker failure does not, by itself, prove that an external job will restart or that its effects cannot be duplicated.

## 4. A2A: Interrupted Task States

In the [A2A v0.3.0 specification's JSON-RPC binding](https://a2a-protocol.org/v0.3.0/specification/), the relevant state identifiers are `input-required` and `auth-required`, with hyphens. These differ from MCP Tasks' `input_required` vocabulary.

A task in `input-required` is paused awaiting additional input. A subsequent message can reference its existing task ID to continue the conversation. `auth-required` indicates an additional authentication requirement; the client obtains the necessary credentials out of band and continues according to the server's contract. The specification does not universally require those credentials to stay out of A2A messages, so this state is not equivalent to MCP URL elicitation's sensitive-input boundary.

A2A supports streaming and push-notification mechanisms as well as task retrieval. These decouple delivery from a continuously connected client, but do not promise indefinite persistence or recovery after every server failure. Clients must retain task identifiers; server storage, task lifetime, authentication, and notification delivery determine whether a later continuation succeeds. A deployment promising recovery after several days must define and test those conditions.

## 5. OpenID CIBA: Separate Consumption and Authentication Devices

[CIBA Core 1.0](https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html) is an OpenID Connect specification. It lets a client initiate authentication without redirecting the user through the device where the request began. The user can authenticate and authorize on a separate device. It is distinct from [RFC 9126](https://www.rfc-editor.org/rfc/rfc9126.html), which specifies OAuth Pushed Authorization Requests.

The client sends an authenticated backchannel request to the OpenID Provider with the required user hint and other parameters. A successful response includes `auth_req_id` and `expires_in`; token delivery then follows the configured mode:

- **Poll:** the client polls the token endpoint, respecting the polling interval.
- **Ping:** the provider notifies the client, which retrieves the result from the token endpoint.
- **Push:** the provider delivers the result to the client's notification endpoint.

These modes have different callback, authentication, and polling requirements. None is inherently the best choice for every agent workload, and a request cannot wait beyond its validity simply because delivery is asynchronous.

CIBA's `binding_message` is **optional**. Section 7.1 describes a short human-readable cue displayed on the consumption and authentication devices to help the user correlate the transaction; a random approval code is one example. It is not a mandatory detailed description of the business action.

For an application asking a human to approve a specific consequential action, this article recommends separately showing the action, target, and expected consequence, and binding the decision to that exact request. For example, “approve this refund to this recipient for this amount” is more useful than an unexplained permission name. That is application approval design, not a claim that CIBA itself supplies a complete transaction-approval system. Token issuance still has to be connected to the application's authorization and execution rules.

## 6. LangGraph: Checkpoints, Interrupts, and Replay

[LangGraph's interrupts documentation](https://docs.langchain.com/oss/python/langgraph/interrupts) describes `interrupt()` as a way to pause graph execution and surface a value for external input. It requires a checkpointer and a `thread_id`. Production restart recovery needs a persistent checkpointer, retained checkpoint data, and resumption with the same thread ID. An in-memory saver does not survive loss of its process, and a new thread ID selects a different execution history.

On resumption with `Command(resume=...)`, the interrupted node starts again from its beginning. When execution reaches the corresponding interrupt, the supplied resume value becomes its result. Code before that point can therefore run again; this is not an instruction-pointer restore that skips all preceding work.

The documentation recommends idempotent effects before an interrupt, placing effects after approval, or separating them into other nodes where appropriate. Gating an action after approval prevents the pre-approval action from running merely to ask the question. However, moving an external API call to another node is not a universal exactly-once guarantee: an external effect may succeed before its completion is checkpointed. Applications still need a suitable idempotency or reconciliation mechanism for that failure window. Review the actual operation and persistence contract rather than inferring effect safety from graph layout alone.

## 7. Approval Fatigue: Observations and Forecasts

[Habituation at the Gate, arXiv 2606.22721v1](https://arxiv.org/html/2606.22721v1), analyzes 11,429 reviews by 400 repeat reviewers of agent-authored pull requests. Its pooled first-to-tenth experience-decile approval rate rises from 27.9% to 42.4%, a 14.5-percentage-point change. This is distinct from the paper's early-versus-late reviewer analysis.

The paper measures review latency as elapsed time from PR opening to review submission, and also analyzes comment effort. It does not directly time active code inspection. The authors interpret longer latency alongside reduced comment effort as consistent with habituation. The design is observational: it cannot establish causality, exclude changes in submission timing, or rule out improved agent code quality, for which it lacks a direct longitudinal measure. Approval-rate changes alone are therefore not proof of either reviewer fatigue or improved safety.

[WitnessAI's commentary on human behavior and AI failures](https://witness.ai/blog/why-human-behavior-not-ai-will-drive-2026s-biggest-ai-failures/), published in December 2025 and updated in March 2026, forecasts approval fatigue and convenience bypasses such as “YOLO mode.” It also discusses agents causing damage while pursuing narrowly interpreted instructions. This is vendor commentary about expected risks, not a survey of production deployments or an independent empirical replication of the review study.

The study recommends reviewer rotation, audits of long approval streaks, and dashboards linking personal approval trends with downstream defects. Those proposals motivate evaluation of reviewer workload; neither source proves that a particular routing algorithm prevents fatigue.

## 8. Design Recommendations for Meaningful Approval

The following are this article's engineering synthesis, not measured guarantees from the sources above:

- **Use explicit approval policy and prioritize attention.** Consider consequence, reversibility, and novelty when routing requests, while preserving mandatory approval requirements. Measure queue volume and reviewer capacity before deciding to automate a category. Risk scoring should not silently override the owner's policy.
- **Bind decisions to concrete actions.** Show the target, proposed change, and relevant evidence. Authenticate the approver and check their authority. If the material request changes, obtain approval for the changed action; do not reuse an old yes for a different request.
- **Define deadlines and late-answer behavior.** Keep an unanswered action unauthorized. At expiry, cancel it or require renewed review according to the application policy; show the pending or expired state to the user. A timeout is not evidence of either consent or an explicit rejection.
- **Observe review quality as well as throughput.** Consider the study's rotation, streak-audit, and trend-dashboard proposals. Check downstream outcomes and reviewer feedback rather than treating quick or frequent approvals as proof that oversight works.

## 9. A Hypothetical Chat-Based Approval Workflow

Consider an agent that proposes changing a shared resource and sends its owner a chat message. A robust implementation could persist a pending request with an identifier, an exact action description, an authorized approver, an expiry, and an execution status before sending that message. The agent can then handle other work while the request waits.

When a reply arrives, the approval service verifies the responder's identity and authority, correlates the reply to the pending request, and checks that the request remains valid and materially unchanged. Ambiguous replies or replies to expired requests do not authorize execution. Recording approval and claiming execution require concurrency control so duplicate replies cannot independently trigger the action. External effects still need idempotency or reconciliation if the worker crashes between performing the action and recording success.

This example illustrates requirements to validate, not an audited deployment or a CIBA implementation. A chat backchannel alone does not establish CIBA's client authentication, user identity, `auth_req_id` correlation, or token-delivery contract. Likewise, a prose operating rule cannot establish whether every runtime component implements reviewer-volume controls. Those are implementation questions requiring code and operational evidence.

## 10. What to Watch

Interoperability work can usefully compare what each pause represents: MCP requests client input, A2A exposes task interruption and authentication states, CIBA returns an authentication/authorization result, and LangGraph resumes checkpointed execution. Adapters must preserve these distinctions, including the difference between acknowledging a URL interaction and completing authorization.

For deployments, the useful tests are concrete: can the intended user resume after a client or worker restart within the retention window; are expired, cross-user, changed-request, and duplicate replies rejected or handled correctly; and can reviewers identify what they are authorizing? Protocol support makes such workflows possible. Correct persistence, authorization, effect handling, and sustained reviewer attention determine whether the workflow works in practice.

---

*Primary specifications, implementation documentation, the observational paper, and vendor commentary are linked beside their respective claims. No crash-recovery, replay, authorization, or reviewer-behavior experiment was performed for this article.*
