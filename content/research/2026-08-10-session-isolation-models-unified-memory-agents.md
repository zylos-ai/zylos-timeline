---
date: "2026-08-10"
title: "Session Isolation Models for Single-Instance Conversational AI Agents"
description: "How separate conversation contexts, explicit turn scheduling, execution sandboxes, and scoped shared memory combine—and which guarantees each boundary actually provides."
tags: [ai-agents, architecture, memory, isolation, multi-session]
---

## Executive Summary

A conversational agent serving multiple conversations needs several different boundaries: which transcript a request can read, who may access that transcript, which turn may update it, where code executes, and which memories may cross between conversations. A session identifier solves addressing; it does not by itself establish authorization, serialize a complete turn, or isolate executable code.

The surveyed systems provide different combinations. LangGraph separates thread checkpoints from cross-thread stores. LangSmith Deployment adds explicit policies for overlapping runs. Google ADK records session events, but an event append is not a transaction covering read, model generation, and commit. AWS AgentCore Runtime assigns a dedicated microVM to a user session that can span multiple ordinary conversational invocations; this is distinct from its Code Interpreter tool. None of these facts establishes a universal FIFO or cost model for conversational agents.

Shared memory adds a separate concurrency and trust problem. Letta's legacy shared-block documentation recommends one heavy-rewrite owner with other agents appending, while documenting race and visibility caveats. This is a mitigation, not proof that all writers are serialized or every running context sees the same revision. The proposed design in this article combines isolated contexts, authenticated access, a chosen whole-turn scheduling policy, and explicitly scoped memory reads and writes. Its stronger guarantees require application mechanisms, not just framework terminology.

## 1. The Isolation Spectrum

### Prompt-level: tagged content in one context

If unrelated conversations are assembled into one model input and distinguished only by labels, the model receives all of that material. Labels can guide its response, but they do not provide an access-control boundary. A product that needs private conversations should filter and authorize the input before model invocation.

Several studies help explain why context composition deserves care, but their experimental boundaries differ:

- **Long-context behavior in a particular agent setup.** The [Gemini 2.5 technical report, pp. 17–18](https://storage.googleapis.com/deepmind-media/gemini/gemini_v2_5_report.pdf) credits a 100k-token context with helping its Pokémon agent use tools and maintain strategy. It also reports an explicitly anecdotal tendency toward repeated actions when that setup's context grew significantly beyond 100k. This is neither a general model threshold nor evidence of one user's conversation bleeding into another's.
- **Instructions distributed across turns.** [LLMs Get Lost In Multi-Turn Conversation](https://arxiv.org/html/2505.06120v1) studies instructions split into shards across turns of a task. Its abstract reports an average 39% performance drop across six generation tasks in the studied settings. It does not test mixed users, isolated sessions, or cross-session memory leakage. Extending its findings to a mixed-conversation architecture is a hypothesis requiring separate evaluation.
- **Cross-app poisoning within one chat.** [Confused ChatGPT: Cross-App Context Poisoning via First-Party APIs](https://arxiv.org/html/2606.00485) studies co-resident app principals sharing a single chat context. An app's injected material can persist across turns and influence behavior involving another app in that same conversation. The observed boundary is between app principals within a chat, not between isolated conversations or tenants.

These sources motivate careful context construction. They do not establish a general incidence rate for cross-conversation leakage, or that context quality predictably degrades at one token count.

### Session/thread-level: separate contexts, shared infrastructure

Separate histories and scratch state let an application select the context relevant to a conversation while sharing compute and storage infrastructure. The application must still authorize the selected identifier.

- **LangGraph** distinguishes a checkpointer for thread-scoped graph state from a store for longer-lived, cross-thread data. Store namespaces are application-defined; a `thread_id` is a persistence address, not proof that its caller owns the thread. See [Persistence](https://docs.langchain.com/oss/python/langgraph/persistence).
- **Managed Deep Agents** illustrates why identity configuration matters. Its currently published [identity guide](https://docs.langchain.com/langsmith/python/managed-deep-agents-identity) says default API-key access does not give each end user private threads; configured end-user authentication with Supabase provides that ownership separation. Do not infer private user scoping merely from the presence of sessions or an API key.
- **Google ADK** uses session services and events to maintain history and state. Its [InMemorySessionService source](https://github.com/google/adk-python/blob/main/src/google/adk/sessions/in_memory_session_service.py) expressly excludes multithreaded production use. Its `append_event()` updates event/state storage; it is not a lock held across an earlier state read, a model call, and the final write.
- **Claude Code** shows that separate contexts can coexist with explicit coordination. The currently published [agent-team documentation](https://code.claude.com/docs/en/agent-teams), describing v2.1.178, calls teams experimental and disabled by default. Teammates have separate context windows and can message each other; it also links cross-session messaging for independently run sessions. This documents a current opt-in mechanism, not its historical availability at the article's original date.

At this layer, distinct keys prevent accidental state overlap only when routing and authorization consistently enforce them. Shared files, tools, caches, and long-term stores need their own scopes; a separate transcript does not isolate those resources automatically.

### Execution-level: processes, containers, and microVMs

These environments are not equivalent. Processes and ordinary containers share a host kernel; microVMs introduce a virtual-machine boundary with a guest kernel. [Firecracker](https://firecracker-microvm.github.io/) is a user-space virtual-machine monitor using KVM. An execution boundary addresses a different problem from selecting a conversation transcript.

[AWS AgentCore Runtime's session documentation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html) explicitly describes dedicated microVM compute, memory, and filesystem resources per user session. Its example makes two conversational invocations with the same `runtimeSessionId`, retaining context between them. Runtime hosts the agent execution environment; it is not merely a Code Interpreter sandbox with all orchestration outside. The application remains responsible for the user-to-session mapping and lifecycle policy.

A session is not a turn. Reusing an environment across turns differs from allocating a new environment for every message. The choice between shared workers and per-session execution environments depends on the workload, lifetime, utilization, startup latency, risk, and state-sharing requirements. This survey provides no comparative cost benchmark that would justify calling conversational microVM use universally prohibitive.

Compute isolation also does not imply unrestricted confidence in network controls. [Unit 42's first-party report](https://unit42.paloaltonetworks.com/bypass-of-aws-sandbox-network-isolation-mode/) demonstrates DNS tunneling through AgentCore Code Interpreter's network-isolation mode. The breached boundary is network egress. The report separately discusses Runtime metadata/identity issues; the DNS result does not by itself demonstrate a guest-to-host kernel or memory escape, or access to another tenant's microVM. These findings call for different controls and should not be combined into a generic claim that Firecracker compute isolation was bypassed.

## 2. Whole-Turn Scheduling Is a Separate Contract

Consider two inputs for the same conversation. Both workers read revision N, generate answers independently, and then append events. Both appends may succeed while each answer was generated without seeing the other's input or result. Durable event storage alone does not choose the intended order of those turns.

The surveyed mechanisms have distinct semantics:

- **Erlang receive is selective.** It selects the first queued message matching a receive clause; unmatched earlier messages remain. Its [language reference](https://www.erlang.org/doc/system/expressions.html#receive) therefore does not justify describing every actor as processing all messages in strict arrival-order FIFO. A chosen actor protocol can serialize its own state, but shared external resources still need coordination.
- **LangSmith Deployment chooses an overlapping-run policy.** Its [double-texting documentation](https://docs.langchain.com/langsmith/double-texting) lists enqueue, reject, interrupt, and rollback. Enqueue lets a run finish before processing queued input; it is the documented default in Agent Server. The page explicitly distinguishes this deployment feature from the open-source LangGraph framework. Interrupt and rollback also require handling partial work and external side effects according to the application's contract.
- **Azure Service Bus sessions provide an ownership mechanism.** A session receiver holds an exclusive, renewable lock for that session's messages. The [official documentation](https://learn.microsoft.com/en-us/azure/service-bus-messaging/message-sessions) describes ordered processing and lock expiry. A worker must use that ownership correctly through processing and settlement; broker delivery alone does not make model calls and external writes one atomic operation.
- **ADK event append is narrower than turn serialization.** The session-service implementation cited above cannot establish that only one worker is performing the entire read→model→commit sequence. The deployment must choose and enforce the overlap policy separately.

For the proposed default here, choose **enqueue with one active turn per authorized session**. A durable queue records the order, and a coordinator holds exclusive session ownership until the turn's result is committed. If ownership can expire, the storage boundary must reject a stale owner's commit, for example by checking the current ownership-generation fencing token. A revision check can additionally detect intervening writes; revision equality alone does not prove that the worker still owns the session. External side effects require their own idempotency and recovery rules. This is a proposed application contract, not a claim that every framework already implements it.

Reject, interrupt, or speculative concurrency may be better for another product. Name the policy, its owner, and what happens after a crash or interrupted tool call. Independent sessions can run concurrently, but may still contend on shared memory, quotas, or tools. Neither global lock-free correctness nor universal FIFO follows from having session IDs.

## 3. The Shared-Memory Problem

### Separate conversation continuity from durable knowledge

[LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence) distinguishes checkpoints for thread continuity from stores for data needed across threads. [Deep Agents production guidance](https://docs.langchain.com/oss/python/deepagents/going-to-production) makes the boundary concrete: files are thread-scoped by default; a path can be routed through `StoreBackend` for cross-thread memory. The application selects which information crosses that boundary.

The original [MemGPT paper](https://arxiv.org/abs/2310.08560) proposes a hierarchy that moves information between limited model context and external memory. This is useful background for memory tiers, not a specification of every current Letta backend or a concurrency guarantee.

### Write completion, consolidation, and reader visibility

A synchronous memory write can complete before the caller continues. That does not update the prompt already assembled by another running turn, nor establish the storage system's consistency semantics. A reader may need to reload a particular revision before its next decision.

Background consolidation moves extraction and rewriting off the response path, introducing a delay before new knowledge becomes available. The product should define when readers refresh and what can remain stale. Facts needed to authorize an imminent action should be checked against their authoritative source at use time; they should not depend solely on an eventually refreshed conversational summary.

[Letta's legacy v1 shared-memory guide](https://docs.letta.com/v1-sdk/memory/shared-memory) documents full-block `memory_rethink` rewrites as last-writer-wins and recommends one heavy-edit owner while others use `memory_insert`. It labels appends concurrent-safe, but also documents completion/visibility troubleshooting and race mitigations such as separate sections or blocks. The guide now marks memory blocks as legacy; this is prior art, not a recommendation to adopt that API for new work.

One rewriter plus multiple appenders is still multiple writers. Ordinary text append order can affect meaning, and a rewrite based on an older value needs a defined relationship to intervening appends. This documented mitigation does not establish a globally consistent view for already-running agents or prove that `enable_sleeptime` serializes all writes. A stronger design needs a demonstrated storage contract: one queue for every mutation, revision-checked updates with conflict handling, or a merge rule valid for the actual data type.

## 4. Security: Keep the Observed Boundaries Separate

**Unauthorized context retrieval** occurs when an application selects another user's transcript or stored data without enforcing ownership. Authenticate outside the prompt and authorize each retrieval and write. Include the relevant access scope in cache design rather than treating a model-visible label as permission.

**Shared-context poisoning** is a different path. The [cross-app paper](https://arxiv.org/html/2606.00485) demonstrates a confused deputy within one ChatGPT conversation: one app influences the model's subsequent behavior involving another co-resident app. It does not demonstrate leakage across independently isolated conversations or a long-term-memory propagation path. A shared persistent store could extend poisoning across sessions if one principal can write material that another session later consumes as trusted instructions; that is a conditional architectural risk, not an observed result of that experiment. [Deep Agents' documentation](https://docs.langchain.com/oss/python/deepagents/going-to-production) explicitly warns about shared-memory prompt injection and recommends read-only shared policies or application validation of writes.

The [Burn-After-Use proposal](https://arxiv.org/abs/2601.06627) explores ephemeral contexts and tenant ownership boundaries with the goal of limiting leakage. Treat that as a proposed mitigation with the paper's evaluated scope, not a guarantee against all cross-session inference. Deleting a context also creates an explicit continuity and retention tradeoff for a memory-enabled product.

A separate-context subagent can limit the raw material entering a parent conversation. [Claude Code's native subagent documentation](https://code.claude.com/docs/en/sub-agents) describes separate context windows, tool access, permissions, and returned summaries. The summary remains another input to validate; context separation does not certify that returned content is trustworthy.

## 5. Design Recommendations

These recommendations synthesize the surveyed mechanisms. They are application design choices, not exact controls attributed to an external security standard.

1. **Authorize contexts before assembling prompts.** Resolve identity in a trusted application layer and verify ownership of session IDs, files, and memory namespaces. A thread identifier is an address, not a credential.
2. **Choose a whole-turn policy explicitly.** For an enqueue design, serialize the entire read→generate→commit interval with durable ordering and exclusive ownership; reject commits from workers that lost ownership. Event append and checkpoints are supporting mechanisms, not substitutes for this contract.
3. **Scope shared memory deliberately.** Default to a private user or tenant scope where appropriate. Broader knowledge stores need defined readers, writers, provenance, and rules preventing untrusted text from becoming policy.
4. **Specify every shared-write path.** A single rewrite owner is useful, but appends remain writes and can be order-sensitive. Choose serialization, revision checks, or a suitable merge contract; define when active readers refresh.
5. **Separate optional consolidation from action-critical truth.** Background extraction can reduce turn latency. Define its staleness behavior, and revalidate permissions or other action-critical state at the authoritative source before acting.
6. **Choose execution isolation by workload and threat model.** Shared workers and per-session microVMs are both relevant architectures; AWS Runtime demonstrates the latter for ordinary multi-turn conversations. Compare session lifetime, utilization, latency, and cost for the actual workload instead of equating a session with one turn.
7. **Test each boundary on its own terms.** Verify unauthorized-context denial, turn overlap/recovery, stale-writer rejection, and shared-memory visibility. Check egress—including DNS—separately from guest/host compute isolation and credential access. The Unit 42 finding supports an egress-control lesson, not a demonstrated microVM kernel escape.
8. **Make sharing understandable to users.** Expose which conversations or groups can contribute to shared knowledge, and what deletion or retention changes. A unified agent identity need not mean a global memory pool visible to every conversation.

Separate contexts, explicit scheduling, scoped memory, and execution isolation can compose into one logical agent serving many conversations. Each protects a different boundary, and the implementation must show where its promised guarantee is enforced. This survey includes no framework concurrency experiment, exploit reproduction, or comparative cost benchmark.
