---
date: "2026-06-01"
title: "Real-Time Message Delivery Guarantees in Distributed IM Systems"
description: "How production instant messaging systems — from WhatsApp and Slack to AI-native communication bridges — architect reliable, ordered, multi-device message delivery, and what these patterns mean when the message consumer is an AI agent."
tags: ["distributed-systems", "messaging", "real-time", "ai-agents", "websocket", "reliability", "architecture"]
---

## Executive Summary

Instant messaging looks simple from the outside: you type, the other person sees. Under the hood, a production IM system is one of the most demanding categories of distributed system to get right. It must deliver messages in order, survive network partitions, handle millions of concurrent connections, fan out to multiple devices, recover gracefully from disconnection, and do all of this with perceived latency under 500ms. Failure modes are user-visible in a way that most backend systems never are: out-of-order messages, missing messages after a reconnect, or duplicate delivery all undermine trust in the platform instantly.

These problems have been solved — imperfectly but pragmatically — by WhatsApp, Telegram, Slack, Discord, and a generation of enterprise messaging platforms. Their architectural choices encode hard-won lessons about what guarantees are actually achievable at scale and at what cost. At-most-once delivery is cheap but lossy. Exactly-once is theoretically attractive but practically impossible across the full message path. At-least-once with client-side deduplication is the pragmatic middle ground that all serious IM platforms converge on.

The problem is gaining new relevance in 2026 because AI agents are becoming first-class IM participants, not just consumers. Systems like Zylos receive messages from Telegram, Lark, Discord, and web consoles; produce responses routed back through those channels; and must themselves make delivery guarantees to the humans and other agents they communicate with. When a human types a message, a lost reply is annoying. When an autonomous agent is acting on a scheduled task, a missed delivery or duplicated execution can have real consequences. The delivery guarantees that WhatsApp built for human-to-human communication must now be understood and applied in human-to-agent and agent-to-agent contexts.

This article covers the core architectural building blocks of reliable IM delivery: the transport layer choices, the sequence number and cursor model, the inbox/outbox pattern, fan-out to multiple devices and channels, offline queuing, reconnection sync, and the specific challenges that emerge when the message consumers are AI agents running asynchronously.

## The Delivery Guarantee Spectrum

Every messaging system must choose where it sits on the delivery guarantee spectrum. The choice is not just technical — it determines system complexity, infrastructure cost, and failure behavior.

**At-most-once delivery** means a message may be lost but will never be delivered more than once. This is what you get from UDP, raw Redis Pub/Sub, and fire-and-forget HTTP. It is acceptable for metrics, heartbeats, and real-time telemetry where occasional loss is tolerable. It is not acceptable for IM: users will notice missing messages.

**At-least-once delivery** means a message will always eventually be delivered, but may be delivered multiple times if failures occur between send and acknowledgment. This is the default for Kafka (prior to transactions), SQS standard queues, and most message broker implementations. It is the right baseline for IM systems — you add idempotency at the consumer to handle duplicates, but you never lose messages.

**Exactly-once delivery** means a message is delivered precisely once, with no loss and no duplication. It is achievable within tightly bounded subsystems — Kafka's exactly-once semantics work within a Kafka transaction, for instance — but not across the full path from sender client to recipient client. The network between sender and broker, and between broker and recipient, always has a window where failure after send but before acknowledgment forces a retry. Production IM systems do not claim exactly-once across the full path; they claim at-least-once delivery with deduplication making the user experience effectively-once.

The practical implication: every serious IM architecture is built around at-least-once delivery plus idempotent consumers. The engineering complexity lies in implementing idempotency correctly, not in achieving a theoretically impossible guarantee.

## Transport Layer: WebSocket, SSE, and Long Polling

The choice of transport protocol determines how messages flow from server to client in real time.

### WebSocket

WebSocket is the dominant protocol for bidirectional IM. It establishes a persistent TCP connection with a single HTTP upgrade handshake, after which either side can send frames at any time with minimal overhead (~2 bytes for small frames versus ~800 bytes for HTTP headers). WhatsApp, Slack, and Discord all use WebSocket as the primary real-time transport.

WebSocket's reliability properties are important to understand precisely. Within a single uninterrupted connection, WebSocket guarantees ordered delivery — TCP's ordering guarantee means messages arrive in the order they were sent over that connection. But this guarantee evaporates the moment a connection drops. When a client reconnects, it opens a new TCP connection. Messages sent during the outage or during reconnect are not automatically replayed. The application layer must implement gap detection and sync.

WebSocket also has operational complexity at scale. Load balancers need sticky sessions or connection-aware routing because WebSocket connections are long-lived and stateful. Proxies and CDNs that terminate connections or have short timeout defaults will kill connections unexpectedly. The `Connection: Upgrade` header must be forwarded correctly through every proxy in the path.

### Server-Sent Events (SSE)

SSE is a unidirectional protocol built on HTTP/1.1 where the server streams events over a long-lived response. It is simpler operationally than WebSocket: it works through every proxy and CDN, uses standard HTTP authentication, and the browser's `EventSource` API implements automatic reconnection with a `Last-Event-ID` header that tells the server where the client left off.

That `Last-Event-ID` mechanism is a built-in gap detection feature. If the server assigns monotonically increasing IDs to events, a reconnecting client automatically requests replay from its last known position. No application-level gap detection logic is required. This makes SSE attractive for systems where the server pushes notifications and the client sends commands via separate HTTP requests — the pattern used by MCP (Model Context Protocol) in its HTTP+SSE transport variant.

SSE's limitation is unidirectionality. For full-duplex IM where both parties send messages at any time, the client must pair SSE (for receiving) with regular HTTP POST requests (for sending). This works but adds round-trip overhead compared to WebSocket's framing model.

### Long Polling

Long polling is the legacy fallback: the client makes an HTTP request that the server holds open until it has data to send, then the client immediately issues another request. It works everywhere but is inefficient at scale — each held request consumes a server thread or connection slot. Modern IM systems use long polling only as a last-resort fallback for environments where WebSocket is blocked.

### Transport Choice in 2026

For AI agent communication bridges, the emerging pattern is:
- **WebSocket** for persistent agent sessions requiring bidirectional real-time messaging
- **SSE** for event streaming where the agent receives structured events and sends responses via REST
- **HTTP polling with cursor** as the reliable fallback when persistent connections are unavailable or impractical

The selection depends on the consumer's connection stability. A mobile Telegram client benefits from WebSocket's low latency; a background agent polling for scheduled messages works fine with cursor-based HTTP polling.

## Sequence Numbers and the Cursor Model

The foundational mechanism for reliable message ordering and gap detection is the sequence number: a monotonically increasing integer assigned to each message at the server before persistence.

WhatsApp assigns a sequence number per conversation. Clients track their "last seen" sequence number. On reconnection, the client sends this cursor to the server, which replays all messages with a sequence number greater than the cursor. This gives the client exactly the messages it missed, in order, without needing to request specific message IDs.

Slack uses a similar pattern with channel cursors and a `next_cursor` pagination token for catching up on missed events. The client maintains a per-channel position and uses the channels history API to fill gaps.

The sequence number model has several important properties:

**Gap detection is O(1).** If the client's last sequence number is N and it receives a message with sequence N+3, it knows it missed N+1 and N+2. It does not need to scan storage or maintain complex state — the gap is structurally visible.

**Replay is bounded.** The server needs only to store messages up to some retention horizon (30 days in WhatsApp's inbox design). Replay queries are simple range scans: `WHERE seq > last_seen_seq ORDER BY seq ASC`.

**Multi-device sync falls out naturally.** Each device maintains its own cursor. A newly added device starts at cursor 0 (or the current sequence minus some history window) and catches up independently. Devices do not need to coordinate; they just each maintain their own position in the shared stream.

**Distributed sequence assignment is the hard part.** A single chat server can assign sequences from a local counter. A distributed system with multiple chat servers cannot guarantee sequence ordering without coordination. WhatsApp routes all messages in a conversation through the same server for sequence assignment, accepting that this creates a hotspot. Slack and similar systems use database-level sequences with careful sharding to avoid the coordination bottleneck.

## The Inbox/Outbox Pattern

The inbox/outbox pattern is how production IM systems ensure durability across the sender-to-recipient path.

**The outbox** lives on the sender side. When a user sends a message, the chat server writes the message to its outbox table within the same database transaction as any business logic updates. A background relay process reads from the outbox and publishes to the messaging infrastructure (Kafka, NATS, or a message broker). If the relay crashes after publishing but before marking the message as sent, it will republish on restart — hence at-least-once semantics. The relay only marks a message as sent after receiving a durable acknowledgment from the broker.

**The inbox** lives on the recipient side. Incoming messages from the broker are written to the recipient's inbox table before delivery is attempted. The inbox is the durable store of undelivered messages. Delivery (pushing via WebSocket) is attempted after the inbox write. If delivery fails (user offline, connection dropped), the message remains in the inbox until delivery succeeds or the retention window expires.

The separation of inbox write from delivery acknowledgment is the key insight. WhatsApp's design makes this explicit: "the Chat Server delivers a message via WebSocket, the client sends an ACK to the Chat Server, and the Chat Server deletes the message from the Inbox table." The inbox entry is the durability guarantee; the WebSocket push is best-effort. If the push fails, the inbox survives and the message will be delivered on reconnect.

This pattern directly informs the design of AI agent communication bridges. An agent's message queue is structurally identical to a user's inbox. Messages from external channels (Telegram, Lark, web console) arrive into a durable inbox. The agent reads from the inbox, processes, and ACKs. The ACK triggers deletion (or archival). If the agent crashes mid-processing, the unACKed message remains in the inbox for redelivery — providing exactly the at-least-once guarantee the agent runtime needs.

## Fan-Out: Multi-Device and Multi-Channel Delivery

A modern IM user may have three devices: a phone, a tablet, and a desktop. A message sent to them must be delivered to all three. This fan-out requirement adds significant complexity to the delivery model.

### Fan-Out Approaches

**Fan-out on write** means that when a message is sent, the system immediately writes a copy to each recipient's inbox on each device. This is fast for reads (each device has its own pre-computed inbox) but expensive on write — sending a message to a group of 1,000 members requires 1,000 inbox writes. WhatsApp uses this approach for 1:1 messages; group messages above a threshold switch to fan-out on read.

**Fan-out on read** means the message is stored once and each device reads from the shared store with its own cursor. Reads are more expensive because each device performs its own range scan, but writes are O(1) regardless of group size. Large-scale group messaging systems (Slack channels, Discord servers) favor this approach.

**Hybrid fan-out** uses fan-out on write for small groups and fan-out on read for large groups, with the threshold determined by empirical cost analysis. Facebook Messenger reportedly uses a similar hybrid approach.

### Cross-Channel Fan-Out for AI Agents

AI agent communication bridges face a variant of this problem. An agent may need to deliver a response to the same user on Telegram (where the request originated), log it to a Lark group channel, and persist it to a web console. Each delivery target is a different channel with different transport semantics.

The clean architecture for this is an event bus between the agent runtime and the channel adapters. The agent emits a "response ready" event. Each channel adapter subscribes to events for its registered users/channels and handles delivery independently. Channel adapters own their own delivery acknowledgment logic: Telegram's `sendMessage` API returns success or an error code; the adapter retries on failure. The agent runtime is decoupled from the specifics of each channel's delivery semantics.

This is structurally what the C4 Communication Bridge in Zylos implements: a routing layer that takes agent outputs and dispatches them to the correct channel adapter, with each adapter responsible for reliable delivery within its platform's constraints.

## Offline Delivery and Message Persistence

When a recipient is offline, messages must be durably stored until the recipient reconnects. The parameters of this storage determine the user experience.

**Retention window** determines how long messages are held. WhatsApp holds undelivered messages for 30 days. After 30 days, messages to an offline recipient are dropped. This is a pragmatic bound on storage cost; most reconnecting users have been offline for minutes or hours, not weeks.

**Push notification as a wakeup signal** decouples the delivery notification from the message payload. When a message arrives for an offline user, the system sends a push notification (APNs, FCM) with a summary or badge update. The notification wakes the device, the app opens, the client reconnects via WebSocket, and the inbox sync delivers the full message. The push notification itself is best-effort — it can be dropped by the OS without affecting message delivery, as long as the message is in the inbox.

**Fetch-on-reconnect** is the reconciliation step. When a client reconnects, it sends its current cursor to the server: "I have seen messages up to sequence N." The server responds with all messages from N+1 to the current head. This single round-trip delivers all missed messages in order, regardless of how many there were. The cursor model makes this efficient — no complex state diffing is required.

### Offline Delivery for AI Agents

AI agents have different offline characteristics than human users. Agents may be deliberately stopped for upgrades, may crash unexpectedly, or may be intentionally paused. Messages sent while the agent is offline must survive and be delivered on restart.

The key difference from human IM: the agent does not need push notifications to wake up. The agent either polls its inbox on a schedule or subscribes to the inbox via a persistent connection when running. The retention window should match the longest expected agent downtime — for planned maintenance windows, hours are sufficient; for disaster recovery scenarios, days may be needed.

The agent's inbox is effectively a durable work queue. The delivery semantics are at-least-once: the agent processes each message, performs its work, and ACKs. If the agent crashes before ACKing, the message is redelivered on restart. Idempotency in the agent's action handlers ensures that redelivery produces correct outcomes.

## Connection Management and Reconnection

WebSocket connections are not permanent. Mobile networks drop connections on cell tower handoff. Laptops sleep and wake. Server restarts terminate all active connections. A robust IM system must handle disconnection and reconnection transparently.

### Heartbeat Ping/Pong

WebSocket's built-in ping/pong mechanism is used to detect dead connections. The server sends periodic pings (typically every 30-60 seconds); if the client does not respond with a pong within a timeout window, the connection is considered dead and closed. The client, detecting that its connection has been closed, initiates reconnection.

Client-side heartbeats serve a complementary role: detecting server-side failures. If the client does not receive a ping from the server for longer than the expected heartbeat interval, it proactively closes the connection and reconnects. This covers the case where the server process crashes but the TCP connection remains half-open.

### Reconnection with Exponential Backoff

On disconnection, clients should not immediately hammer the server with reconnection attempts. Exponential backoff with jitter prevents thundering herds when a server restarts and thousands of clients attempt to reconnect simultaneously. A typical policy: wait 1 second, then 2, then 4, then 8, with random jitter of ±50%, capped at 60 seconds.

### Inbox Sync on Reconnect

After reconnection, the first message the client sends to the server is its current cursor position: "I last saw sequence N." The server responds with the missed message batch. This sync step must happen before the client reports itself as "online" to avoid displaying stale state.

For AI agent runtimes, this sync step is the `dispatch-on-reconnect` loop: scan the inbox for messages received since the agent's last ACK, dispatch them in sequence order, ACK each one after processing. The agent must process them in order (not in parallel) to avoid out-of-order side effects.

## Message Deduplication and Idempotency

At-least-once delivery means the system will sometimes deliver the same message twice. At the application layer, this is handled through two mechanisms: client-generated message IDs and server-side deduplication windows.

### Client-Generated Message IDs

When a sender submits a message, it includes a client-generated UUID. If the HTTP POST or WebSocket send times out without a response, the client retries. The server checks whether it has already stored a message with that client-generated ID; if so, it returns the stored result without creating a duplicate. The client ID is the idempotency key.

This handles the common failure mode: the message was stored successfully but the acknowledgment was lost in transit. The retry safely returns the existing message rather than creating a duplicate.

### Server-Side Deduplication Windows

For broker-level delivery (Kafka, SQS), the consumer maintains a short-lived deduplication window: a set of recently processed message IDs, held in memory or a fast cache (Redis). On receiving a message, the consumer checks this window. If the ID is present, the message is skipped as a duplicate. The window can be bounded in time (e.g., keep 5 minutes of processed IDs) because legitimate duplicates from at-least-once delivery are typically delivered within seconds of the original.

### Idempotent Agent Handlers

AI agent tool invocations are often non-idempotent by default (sending a message to an external API, writing a file, making a payment). When an agent's task handler runs twice due to at-least-once delivery, the second execution must produce the same observable outcome as the first.

The practical patterns are:
- **Check-then-act**: Before executing a side effect, check whether it has already been executed (e.g., query an external system or a local state store for a completion record).
- **Idempotency keys on external calls**: Include the message ID as an idempotency key on outbound API calls that support them (Stripe, Twilio, and most modern payment/messaging APIs do).
- **Tombstone records**: After completing a task, write a small completion record keyed by message ID. Before executing, check for the tombstone.

## Ordering Across Distributed Nodes

Sequence numbers solve ordering within a single conversation routed through a single server. They become more complex in distributed deployments where multiple servers handle messages for the same conversation.

### Logical Clocks

Lamport timestamps and vector clocks are the theoretical foundations for ordering events in distributed systems without synchronized physical clocks. In practice, production IM systems avoid them for message ordering because they add complexity and the resulting ordering is not intuitive to users.

### Server-Assigned Timestamps with NTP Sync

WhatsApp uses server-assigned timestamps from NTP-synchronized servers. Messages are displayed in timestamp order. Clock drift between servers is typically less than 10ms, which is imperceptible in a chat interface. Occasional out-of-order delivery (two messages from different senders appearing slightly out of order) is accepted as a known limitation.

### Causal Ordering

Some systems (particularly group collaboration tools) implement causal ordering: a message can reference the message it replies to, creating an explicit dependency. The client holds a message until all messages it causally depends on have been received. This ensures that a reply is never displayed before the message it replies to. It does not guarantee total ordering but does guarantee the intuitive "replies appear after their parents" invariant.

### Sharding Strategy

The dominant production approach for ordering at scale is conversation-level routing: all messages in a conversation are processed by the same server (or database shard), which assigns sequence numbers from a local counter. This avoids coordination across servers at the cost of creating hotspots for popular conversations. Load balancing is done at the conversation level, not the message level.

## AI Agent-Specific Considerations

When the message consumer is an AI agent rather than a human, several properties of the delivery model change.

### No Perceptual Smoothing

Human users tolerate slight out-of-order message display because the overall conversation flow remains comprehensible. AI agents processing messages programmatically require strict ordering to maintain correct context. An agent receiving message N+2 before N+1 may produce a response that contradicts the not-yet-seen N+1. The agent's inbox must enforce ordered delivery.

### Bounded Processing Time

A human reading messages takes variable time; a fast agent might process a message in 200ms, a slow agent (with tool calls) might take 60 seconds. The inbox must accommodate this variability without assuming constant throughput. ACK-based flow control (don't send message N+1 until N is ACKed) is one approach; it simplifies the agent's state management at the cost of throughput.

### Channel-Multiplexed Inboxes

An agent serving multiple channels (Telegram, Lark, Discord) receives messages from each channel into a shared inbox. Each message carries a channel identifier and user identifier. The agent must route responses back to the originating channel — a different kind of fan-out from multi-device delivery, where the same content goes to multiple destinations. Here, different responses go to different channels.

The clean model is a per-channel inbox with a unified dispatcher, rather than a single inbox with channel tags. This allows per-channel flow control and avoids a noisy Telegram channel blocking Lark delivery.

### Heartbeat as Liveness Signal

For AI agent runtimes, the heartbeat pattern serves a dual purpose: it keeps the WebSocket connection alive (as in human IM) and it serves as a liveness signal for the process supervisor. If the agent fails to ACK heartbeat messages within a timeout, the process monitor can restart it. This integrates delivery-level health checks with process-level health checks.

## Practical Architecture for an AI Communication Bridge

Combining these patterns, the architecture of a production AI communication bridge looks like this:

**Inbound path**: Platform webhooks (Telegram, Lark) or polling loops → channel adapter → write to inbox table (with idempotency key = platform message ID) → emit "message received" event to agent dispatcher.

**Dispatcher**: Reads messages from inbox in sequence order → dispatches to agent runtime with at-most-one-in-flight per conversation → waits for ACK → advances inbox cursor.

**Agent runtime**: Processes message → performs tool calls → produces response(s) → writes response(s) to outbox table → ACKs dispatcher.

**Outbound path**: Outbox relay reads from outbox → routes to correct channel adapter → calls platform API with platform-specific idempotency key → marks outbox entry as sent → updates delivery status.

**Reconnection**: On agent restart → load last-ACKed cursor per conversation → replay unACKed messages from inbox → re-dispatch in order.

This architecture provides end-to-end at-least-once delivery with idempotency at every boundary, ordered delivery per conversation, and clean separation between the agent's processing concerns and the channel-specific delivery concerns. It is essentially the inbox/outbox pattern from microservices architecture, applied to the specific problem of AI agent communication.

## Current Trends and Open Problems

**Message broker standardization**: Enterprise platforms are converging on Kafka or Redpanda for the broker layer between inbound channels and agent inboxes. The at-least-once delivery and replay capability of offset-based commit logs is well-matched to AI agent delivery requirements.

**Delivery receipts for agent actions**: Human IM has delivery receipts (one checkmark = sent, two = received, two blue = read). Agent IM is evolving equivalent conventions: "dispatched to agent", "agent processing", "agent responded". Users interacting with AI agents want to know whether their message is in the agent's queue, being processed, or has been acted upon.

**Cross-agent message routing**: As multi-agent systems grow more complex, messages must flow between agents as well as between humans and agents. The same inbox/outbox/sequence patterns apply, but the fan-out topology is more complex and the trust model requires additional validation — an agent receiving instructions from another agent must verify the source before acting.

**Exactly-once side effects via workflow engines**: Systems like Temporal and Restate are gaining adoption for AI agent task execution precisely because they provide durable execution with exactly-once side effect semantics across distributed components. They solve the idempotency problem at the framework level, removing it from individual handler implementations.

**Latency vs. durability trade-offs at the edge**: Mobile and edge AI deployments push the delivery boundary to the device. Messages may need to be stored locally when the device is offline and synced to the cloud on reconnect — the full inversion of the cloud-inbox model. Solutions like Electric SQL and local-first sync frameworks (Liveblocks, Automerge) are being applied to this problem.

## Conclusion

Real-time message delivery in distributed IM systems is a solved problem in the sense that proven patterns exist — at-least-once delivery with idempotent consumers, sequence-number-based gap detection, inbox persistence for offline delivery, heartbeat-based connection management, and fan-out architectures that scale to millions of concurrent users. It remains an unsolved problem in the sense that every new deployment must choose carefully among these patterns, the choices interact in non-obvious ways, and the constraints of AI agent consumers differ meaningfully from human IM users.

The key insight for AI-native IM systems is that the message delivery layer is not a concern that the language model can or should handle. It must be built into the infrastructure before the agent runtime receives a single message. An agent that processes messages from a lossy, unordered stream will produce incorrect, inconsistent, and unpredictable behavior regardless of how capable the underlying model is. Reliable delivery is a prerequisite for reliable agents.

The patterns described here — transactional inbox writes, cursor-based replay, per-conversation sequence assignment, outbox relay with idempotency keys, heartbeat-driven liveness — form the baseline for any serious AI communication bridge. They are not novel; they are directly adapted from a decade of production IM engineering at WhatsApp, Slack, and their successors. The novelty in 2026 is applying them to a new class of consumer: agents that must process messages reliably, respond through multiple channels, and maintain correct state across restarts, with no human in the loop to catch delivery failures.
