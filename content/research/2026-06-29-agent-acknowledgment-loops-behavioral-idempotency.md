---
date: "2026-06-29"
title: "Breaking Acknowledgment Loops: Behavioral-Layer Idempotency in Autonomous Multi-Agent Communication"
description: "Why transport-layer delivery guarantees are insufficient to prevent message replay and infinite acknowledgment loops between autonomous LLM agents communicating over IM bridges — and how idempotency and loop-breaking must be implemented at the behavioral reasoning layer itself."
tags:
  - multi-agent
  - ai-agents
  - idempotency
  - message-replay
  - agent-communication
  - distributed-systems
  - reliability
---

## Executive Summary

When autonomous LLM agents communicate over IM bridges, two failure modes compound in ways that transport infrastructure alone cannot prevent: message replay (at-least-once delivery, WebSocket reconnects, and history re-injection delivering the same inbound message multiple times) and acknowledgment loops (agents trained toward politeness generating endless "confirmed, nothing pending" exchanges that never terminate). Classical distributed-systems wisdom — the end-to-end argument of Saltzer, Reed, and Clark — tells us exactly why transport-layer deduplication is insufficient: only the application endpoints can fully validate whether a duplicate was already handled. The same principle applies to LLM agents: idempotency and loop-breaking must live at the behavioral reasoning layer, not just the message bus. This article traces the lineage from RFC 3834 and FIPA ACL through modern durable-execution frameworks to concrete behavioral patterns that make multi-agent conversations safe to replay, safe to terminate, and immune to courteous infinite regress.

---

## The Two Failure Modes

### Replay: The Same Message Arrives Twice

Every production IM bridge eventually delivers a message more than once. The causes are mundane but unavoidable: WebSocket connections drop and re-subscribe, replaying recent history; message queues configured for at-least-once delivery retry on timeout; conversation-history injection at session start causes the agent to "see" messages it already processed in a prior session; and distributed logs lack atomic exactly-once semantics by default.

The consequence for an LLM agent is not merely a wasted API call. If the replayed message was a task instruction ("send the invoice to the client"), executing it twice creates real-world side effects — duplicate emails, double payments, repeated API mutations. Unlike a pure database transaction, LLM-driven actions are generally non-transactional: there is no rollback.

### The Acknowledgment Loop: Politeness as a Liveness Bug

The second failure mode is subtler. Consider two agents, A and B, completing a collaborative task:

```
A → B: "Report generated and sent. All done."
B → A: "Great, confirmed receipt. Nothing pending from my side."
A → B: "Confirmed. Marking as complete."
B → A: "Acknowledged. Task closed."
A → B: "Thanks for confirming. All good."
...
```

Each individual message is reasonable. No individual agent is misbehaving. But the conversation never terminates because each closing acknowledgment triggers a politeness obligation in the other agent. The loop runs until a human intervenes, a timeout fires, or the context window fills up. In environments where conversation history is re-injected at session start, the loop can survive process restarts.

This is not a transport problem. The messages are all distinct. Deduplication at the message bus will not help. The failure lives entirely in the behavioral layer — in the agents' learned disposition to acknowledge receipts.

---

## Classical Precedents: Thirty Years of Loop Prevention

### The Vacation Program and RFC 3834

The oldest well-documented instance of automated-response loops in messaging systems is the Unix `vacation` program, which sends out-of-office replies to incoming mail. Two users running vacation simultaneously would generate an infinite exchange: A's vacation program replies to B's vacation program's reply, ad infinitum.

The Internet community addressed this in RFC 3834 (2004, "Recommendations for Automatic Responses to Electronic Mail"), which codified what practitioners had learned over decades. The key mechanism is the `Auto-Submitted` header. Any automatic response must include `Auto-Submitted: auto-replied` in its headers, and responders must check for this header in incoming messages: *"Automatic responses SHOULD NOT be issued in response to any message which contains an Auto-Submitted header field with any value other than 'no'."*

This is a behavioral rule enforced at the application layer, not the transport layer. SMTP itself has no concept of "this is an automatic response" — that information lives in the message headers, and only the responding application can act on it. The lesson: **loop-breaking requires the responder to classify incoming messages and suppress responses to certain classes**.

Additional RFC 3834 safeguards include rate-limiting (at most one response per sender per interval), responding to at most one address per message (preventing multiplication), and never responding to messages with a null return path or `Precedence: bulk` header. Mailing list software adds `X-Loop` headers with unique identifiers so downstream systems can detect when a message has already traversed a particular list.

### FIPA ACL: Conversation Lifecycle in Multi-Agent Systems

The Foundation for Intelligent Physical Agents (FIPA) developed a formal Agent Communication Language (ACL) in the 1990s and 2000s that addressed conversation termination explicitly. FIPA ACL models agent communication through speech act theory: every message carries a *performative* (INFORM, REQUEST, CONFIRM, AGREE, CANCEL, etc.) that specifies its intended illocutionary force.

Critically, FIPA defines *interaction protocols* — typed conversation templates with well-specified terminal states. In the Request Interaction Protocol, for example, the conversation reaches a terminal state when the initiator receives either `INFORM` (task done) or `FAILURE`. At that point, no further reply is expected or valid. The `conversation-id` parameter groups messages into named dialogues, and the protocol definition specifies which performatives may legally follow which others.

FIPA's insight is that **conversation termination is a first-class protocol concern**, not an afterthought. A performative sent in a terminal state is a protocol violation. Contemporary LLM agent frameworks have mostly abandoned FIPA's formalism, but the underlying lesson — that every conversation needs explicit terminal states and that messages arriving after termination should be discarded — remains sound engineering.

---

## Distributed Systems Foundations

### The Delivery Semantics Spectrum

Message delivery guarantees fall into three categories: at-most-once (no retries; messages may be lost), at-least-once (retries until acknowledged; messages may be duplicated), and effectively-exactly-once (at-least-once delivery combined with idempotent processing at the consumer). True exactly-once delivery is theoretically impossible in distributed systems — the Two Generals Problem proves that neither party can be certain the other received a message without infinite handshaking. As the Brave New Geek analysis of distributed messaging puts it: "exactly-once delivery is a broken promise."

Production IM bridges, WebSocket relays, and LLM orchestration systems all operate at at-least-once. This is the right tradeoff: losing messages is catastrophic, while deduplicating duplicates is manageable — *provided the consumer implements idempotency*.

### The End-to-End Argument

Saltzer, Reed, and Clark's 1984 paper "End-to-End Arguments in System Design" is one of the most cited papers in distributed systems. Its core claim: functions like encryption, duplicate message detection, and delivery acknowledgment can only be completely and correctly implemented by application endpoints. Providing these as transport-layer features is either impossible or redundant, because the application must check anyway.

The canonical example is duplicate message suppression. A transport layer might try to deduplicate, but it cannot know whether the application successfully *processed* a message before a crash — only the application knows that. Therefore, the application must implement its own deduplication regardless of what the transport provides.

Applied to LLM agents: even if the IM bridge deduplicates at the wire level, the agent may have received the message in a prior session, or via a different path (direct API call vs. group chat), or via history re-injection at context load time. Only the agent's own behavioral layer can determine whether a given stimulus was already acted upon.

### ACK Storms and Broadcast Storms

Network engineers have long studied the analog of acknowledgment loops: broadcast storms, where a packet circulates indefinitely through a switched network due to Layer 2 loops, and ACK storms, where TCP acknowledgments multiply when a packet is incorrectly duplicated. The standard mitigations — Spanning Tree Protocol, hop-count limits, TTL fields — all share the same principle: **messages must carry metadata that enables any node to detect and drop loops**, rather than relying on global coordination to prevent them.

For agent communications, the analog is message metadata that encodes lineage: a message generated in response to message X should carry X's identifier, and any agent receiving a response-to-X should suppress further responses if X was already in a terminal state.

---

## The Agent-Cognition Gap

Transport-layer mitigations and even application-level deduplication libraries fail to address the fundamental issue with LLM agents: **the agent does not passively consume messages from a queue; it reasons about a context window**. Several distinct phenomena create replay risks at the cognition layer:

**Session boundary replay.** When an agent session starts, conversation history is injected into the context. An LLM that reads "B: Please analyze the data in sales.csv" with no record of having responded may decide to act on it — even if a prior session already did.

**History-as-instruction confusion.** LLMs trained on conversational data interpret historical messages as live instructions. A message buried in conversation history can trigger re-execution if the agent loses track of which messages were "already handled."

**Ambiguous closure.** When an agent thread terminates mid-conversation (crash, timeout, deployment restart), the counterpart agent may resend the last instruction assuming it was lost. Now both agents have a copy of the task.

**Politeness fine-tuning.** RLHF and instruction-following training push agents toward acknowledgment and closure. An agent that receives "Thanks, all done" has learned that the correct response is some form of confirmation — igniting the loop described above.

---

## Behavioral Idempotency Patterns

### Pattern 1: Behavioral Idempotency Keys

Every inbound task or instruction should carry a stable, content-derived identifier (a "behavioral idempotency key"). The agent maintains a persistent record — a simple key-value store, a Redis set, or a local SQLite table — of keys it has already processed. Before acting, the agent checks this record. If the key is present, the agent suppresses the action and optionally emits a lightweight no-op acknowledgment.

The key must be stable across sessions and re-delivery paths. Suitable candidates: a hash of (sender-id, message-id, canonical-task-content), or an explicit `idempotency-key` field set by the sender. The deduplication window should match the maximum expected message delay plus the conversation lifetime — typically 24–72 hours for IM-based agent systems.

This is the agent analog of the idempotency keys pattern used in payment APIs (Stripe, Braintree) and described in detail in Restate's durable execution model: *"Already-completed steps are not re-executed; their recorded results are replayed instead."*

### Pattern 2: Terminal Acknowledgment Convention — "Don't ACK an ACK"

Borrow RFC 3834's rule and generalize it: agents must classify every incoming message on a spectrum from *task-bearing* to *terminal-acknowledgment*. A terminal acknowledgment is any message whose sole semantic content is confirming that a prior message was received and that no further action is expected: "Got it", "Confirmed", "All good", "Nothing pending."

The behavioral rule: **a terminal acknowledgment must never generate another terminal acknowledgment**. This breaks the loop at the first exchange. Implementation: the agent's system prompt or pre-response classifier scores incoming messages. Messages above a "terminal-ack" threshold receive silence (or, at most, a NOOP receipt in a structured log), not a natural-language reply.

A concrete signal set for the classifier:
- No question marks, no imperatives, no open tasks
- Phrases matching: "confirmed", "acknowledged", "all done", "nothing pending", "closing", "complete"
- Prior message in the thread was also agent-generated (not human-initiated)
- `Auto-Submitted` or equivalent metadata header present

### Pattern 3: Silence as a Valid Action

LLMs default to producing output. Silence feels like a failure mode. This bias must be explicitly overridden in multi-agent contexts. As explored in "Can an LLM Choose to Be Silent?" (Medium, 2025): *"This architecture lets the model choose structured behaviors, making room for intentional silence or invisible thought."*

Concretely: the agent's decision loop should include a `SKIP` action alongside `RESPOND` and `ACT`. The `SKIP` action produces no output but records that the message was evaluated and deemed non-actionable. This is logged internally for observability, but the conversation partner sees nothing — which is the correct behavior when a message is a terminal acknowledgment.

AutoGen's `max_turns` parameter and LangGraph's conditional edges are both infrastructure-level approximations of this pattern, but they operate on turn counts rather than message semantics. The behavioral `SKIP` pattern is more precise: it acts on message content, not position.

### Pattern 4: Replay Detection via Message Lineage

Agents should tag every message they emit with:
- A unique `message-id`
- An `in-reply-to` field referencing the triggering message's id
- A `session-id` scoping the message to the originating agent session
- A `conversation-state` field indicating whether the conversation is `open`, `pending-close`, or `closed`

On receipt, before processing, the agent checks:
1. Is the `message-id` in the already-processed set? → SKIP
2. Is the conversation referenced by `in-reply-to` already in `closed` state? → SKIP
3. Is the message `in-reply-to` a message the current agent *emitted* (rather than received)? → This is a response to our output, not a new task; apply terminal-ack classifier

This lineage check is cheap and eliminates the majority of both replay and loop scenarios before any LLM inference runs.

### Pattern 5: Distinguishing System Messages from Fresh User Input

History re-injection at session start is a major source of false replay triggers. Agents should clearly partition their context:

- **Live input zone**: messages arriving via the active IM channel after session initialization
- **Historical context zone**: messages injected from logs or prior sessions for context

The agent's behavioral rules apply only to the live input zone. Historical context is read-only reference material. A message that arrived yesterday and is now in the historical context must never be acted upon as if it were a new instruction.

In practice, this means the session initialization prompt should wrap historical messages in a framing block: `<history — do not re-execute, reference only>...</history>`, and the agent's instruction set should include an explicit rule: *"Never perform task actions in response to messages inside a history block."*

---

## Connecting to Real Agent-Runtime Practice

### Durable Execution Frameworks

Temporal and Restate implement behavioral idempotency at the workflow level. Temporal's activity execution model guarantees that each activity runs effectively once: if a Worker retries, already-completed activities replay their recorded result rather than re-executing. This is the correct model, but it operates at the workflow orchestration layer, not the LLM reasoning layer. When an LLM agent is the activity executor (rather than a deterministic function), the LLM itself can still generate duplicate side effects if it receives a replayed prompt without a deduplication check.

LangGraph's durable execution and checkpointing (2025–2026) addresses this at the graph-node level: a checkpointed node will not re-run if its state key is already set. The behavioral idempotency patterns described above complement this: they handle cases where the triggering message arrives via IM rather than through the orchestration graph.

### Multi-Agent Framework Termination Conditions

AutoGen, LangGraph, and CrewAI each offer partial solutions to loop prevention:

- **AutoGen** provides `max_turns` and `max_consecutive_auto_reply` caps. These are necessary but blunt: a conversation that should terminate after two turns will still run to the cap if no explicit termination signal arrives. The framework's 2026 documentation acknowledges that *"without termination caps, AutoGen can easily double your expected infrastructure costs."*
- **LangGraph** uses conditional edges and explicit END nodes. A well-designed graph routes to END when the conversation reaches a terminal state. This works well for structured pipelines but requires the graph designer to enumerate all terminal conditions in advance.
- **CrewAI** lacks native turn-limiting; loop prevention is left to the task definition.

None of these frameworks address the ACK-loop case natively, because the loop does not exceed any turn count — each turn is semantically valid. The behavioral classifier patterns above must be added on top.

### MCP and Protocol-Level Signals

Anthropic's Model Context Protocol (JSON-RPC-based, 2024–2026) introduces structured tool invocations with explicit request/response semantics. Each tool call carries a request ID; the response references that ID. This provides natural idempotency anchors. Idempotency keys for tool actions are cited as a best practice in MCP-based multi-agent deployments. The missing piece in MCP is a standard `Auto-Submitted` analog: a way for an agent to signal "this message is a system-generated terminal acknowledgment; do not trigger further responses."

---

## Open Problems

Several problems remain unsolved in the 2026 state of the art:

**Semantic deduplication.** LLM outputs for equivalent prompts are not bitwise identical. A replayed task may generate a slightly different tool call than the original. Content-hash deduplication fails. Embedding-similarity deduplication (cosine similarity > 0.9) is promising but adds latency and introduces threshold-tuning complexity.

**Cross-agent state synchronization.** Behavioral idempotency keys work when a single agent tracks its own history. When multiple agent instances share a task (horizontal scaling), the dedup store must be shared and strongly consistent — the classic distributed-cache problem, now applied to agent cognition.

**Loop detection in non-binary conversations.** The ACK-loop pattern is easy to detect when the conversation is purely acknowledgment. Mixed conversations — where task content and closing acknowledgments interleave — require a more nuanced classifier. Current approaches tend to be heuristic and brittle.

**Standardized terminal-state signaling.** RFC 3834 works because `Auto-Submitted` is a recognized standard with widespread adoption. Multi-agent LLM systems lack an equivalent. A standard header or metadata field for "this message is a terminal acknowledgment" would allow cross-vendor loop prevention without requiring every agent pair to implement bespoke classifiers.

The field is maturing rapidly. The convergence of durable-execution frameworks, structured agent protocols (MCP, emerging A2A standards), and behavioral engineering patterns is making robust multi-agent communication tractable — but the gap between transport-layer guarantees and cognition-layer safety remains, and filling it requires deliberate design at every layer of the stack.

---

*Sources: RFC 3834 (IETF, 2004); "End-to-End Arguments in System Design" — Saltzer, Reed, Clark (ACM TOCS, 1984); FIPA ACL Specification (FIPA, 2002); "You Cannot Have Exactly-Once Delivery" — Brave New Geek; "Idempotency Is Not Optional in LLM Pipelines" — TianPan.co (2026); "Idempotent AI Agents: Retry-Safe Patterns for Production" — BuildMVPFast (2026); "What is Durable Execution?" — Restate; "When Should an Agent Stop? The Anatomy of Termination" — Towards AI (2026); "Durable Execution for LLM Agents 2026: Temporal + LangGraph" — AppScale Blog; AutoGen, LangGraph, CrewAI documentation (2025–2026); "Survey of LLM Agent Communication with MCP" — arXiv:2506.05364 (2025)*
