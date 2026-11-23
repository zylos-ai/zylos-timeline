---
date: "2026-11-19"
time: "09:00"
title: "Asking the Owner to Send It: Delegated Delivery Across Channel-Ownership Boundaries"
description: "How a multi-threaded agent can hand a message to the one thread allowed to send it, and what a confirmation does and does not prove, drawing on SMTP, Kafka, idempotency keys, sagas and the confused-deputy problem."
tags: ["research", "multi-agent", "delivery-semantics", "idempotency", "distributed-systems", "messaging", "agent-architecture", "security"]
---

## Executive Summary

It is 08:00. A coordinator thread of a persistent agent has just finished the owner's morning briefing and saved it to a file. The briefing has to reach the owner's private chat, but that chat belongs to a different thread of the same agent, the one that talks with the owner all day. The coordinator may not write to it directly. So it sends the owner thread a short internal request: the exact text, plus one line saying why. The owner thread decides whether to send it, sends it through its own channel, and replies with a receipt: the platform accepted one message at 08:07, here is the message ID it returned for the owner's chat, 3327 characters, matching the file exactly. A bare "done, exit 0" would not be enough, because it shows only that a command finished. Even the receipt proves less than it seems to. It shows the platform took the message, not that the owner has seen it. So the coordinator records the briefing as sent and may forward a copy elsewhere with a note saying when it was sent, but it records the owner as informed only after the owner acknowledges it, for example by replying.

This looks small, but it combines several old problems: single-writer ownership, acknowledgements that mean different things at different layers, faithful forwarding, duplicate and lost sends, delegated authority, and workflows that must not advance on an unconfirmed step. This article takes each in turn, using standards and engineering documentation that can be checked.

The short version:

- One owner per outbound address is the single-writer principle applied to chats. It buys ordering, one place for rate limits, and one holder of conversational context.
- "The relay request was queued" is not "the message was sent," and "the platform accepted it" is not "the owner read it." A confirmation is worth the evidence in it. The strongest a relayer can usually show is platform acceptance, proved by a message ID tied to the platform and the chat it was sent to.
- The relayer should treat the text as opaque payload and prove it did not change it, for example with a length and hash echo.
- The relayer claims each request ID once, in a single atomic write bound to the requester, destination, payload and send options. A duplicate sees that claim and does not send.
- A missing confirmation means the outcome is unknown, not failed. Do not resend automatically. Ask, then escalate.
- The relayer is a deputy, not a servant. It judges the request and may refuse, and a refusal is a first-class answer.
- Each downstream step waits for the evidence it needs: platform acceptance for "it was sent," the owner's own acknowledgement for "the owner knows." Because a send cannot be undone, it belongs late in the sequence.

A note on labels: "General practice" marks what standards and widely documented systems establish. "Design suggestion" marks this article's proposal for agent systems. Platform numbers come from the official documentation consulted for this article and can change.

## 1. Why One Thread Owns Each Address

Several threads of one agent can speak to the same human: a scheduled job, a long conversation, a background investigation. If each may write to the owner's chat, the human sees interleaved messages that nobody planned. Two threads answer the same question. A reply lands before the message it answers. One thread announces what another has just retracted.

**General practice: single writer.** Martin Thompson's Single Writer Principle says an item of data or a resource "should be owned by a single execution context for all mutations." He argues that "the single biggest limitation on scalability is having multiple writers contend for any item of data or resource" [1]. The actor model is a close relative: in the 1973 paper that introduced it, behaviour is defined in terms of sending messages to actors [2]. State belongs to one actor and others change it by asking.

Kafka applies the same shape to data. Each partition has a single leader and "All writes go to the leader of the partition," while followers copy its log in the same order [3]. A chat is a log a human reads in order, so the same logic applies.

Email separates roles in a similar way. RFC 6409 splits message submission, where a server accepts messages from a user's mail client, from relay between servers. Relays "are not supposed to alter the message text," and submission is where authentication and policy are applied [4]. There is one place where outbound messages enter the system and rules are enforced, and everything after it just carries the message.

**Rate limits are per conversation, not per author thread.** Telegram's bot FAQ says to avoid more than one message per second in a single chat and that in a group bots cannot send more than 20 messages per minute [5]. Slack says apps may post no more than one message per second per channel, and warns that with bursts "there is no guarantee that messages will be stored or displayed to users" [6]. Lark lists 5 requests per second to a single user, and for a group the limit is shared by all bots in it [7]. Two threads that each respect a limit but share one chat can jointly exceed it. That is an inference from these numbers, not something the platforms state.

**Design suggestion: what ownership buys an agent.**

- **Order.** One thread decides what goes out next, so a briefing and a reply cannot race.
- **Context.** The owner thread knows what was said in this chat. It can hold a briefing while the human is mid-conversation, or notice the same content was already sent.
- **Pacing.** The thread that owns the connection is the natural home for one queue and one backoff policy.
- **Accountability.** If something odd was sent, exactly one thread's log needs reading.

**The safeguard.** A direct send to an address owned by another thread should be refused by the tool itself, not just discouraged in instructions, and the refusal should name the thread to ask. The wrong path then fails loudly and points to the right one. This is a design suggestion.

## 2. What a Confirmation Proves at Each Hop

Take the briefing and name the layers a "sent" could refer to:

- **Level 0:** the request was handed to the relay channel. Evidence: the queue accepted it. This says nothing about sending.
- **Level 1:** the owner thread read it and agreed to act. Evidence: its reply.
- **Level 2:** the platform accepted the message. Evidence: an API success with a platform message ID. Only the owner thread sees this.
- **Level 3:** the message reached the human's device. Bots usually cannot observe this.
- **Level 4:** the human read or acknowledged it. Evidence: a read receipt where a platform offers one, or the human's own reply or reaction in that chat.

"I asked the owner thread to send it" is Level 0 and cannot justify recording the briefing as sent. A Level 2 receipt justifies "sent" and nothing more. It cannot justify "the owner has read the briefing," which needs Level 4 evidence.

**General practice: email draws these lines carefully.** RFC 5321 says that once a server replies "250 OK" at the end of the message data, "a formal handoff of responsibility for the message occurs" [8]. Section 6.1 says the same of the "250 OK" reply: the receiver "is accepting responsibility for delivering or relaying the message" [8]. That is Level 2: acceptance with responsibility, not delivery to a person. Delivery status notifications (RFC 3461) distinguish "delivered", meaning the message was placed in the recipient's mailbox, from "relayed", meaning it was handed to a system that cannot confirm final delivery, in which case the notice says that unless delivery fails it will be the only one sent [9]. Disposition notifications (RFC 8098), the Level 4 analogue, are blunt about their limits: "There is no guarantee that the content has been read or understood," a mail client may silently ignore the request, and receipts "may be lost in transit" [10]. Each confirmation should say which claim it makes, and the next hop should not upgrade it.

**General practice: the end-to-end argument.** Saltzer, Reed and Clark made the point for networks in 1984: "What the application wants to know is whether or not the target host acted on the message," and the acknowledgement really wanted is "an end-to-end one, which can be originated only by the target application – 'I did it', or 'I didn't.'" [11] For the briefing, the owner thread performed the send, so its report is the end-to-end acknowledgement of the send. It is not an acknowledgement that the owner read the briefing. Only the owner can give that.

**Platform IDs are the best available evidence of acceptance.** They prove Level 2, not Level 3 or 4.

- Telegram's `sendMessage` returns the sent Message on success. The Message object documents `message_id` as a "Unique message identifier inside this chat," so the number identifies a message only together with the chat. The docs add that the server might schedule a message instead of sending it immediately, in which case the ID will be 0, so an ID of 0 is not evidence that the message was sent [12].
- Slack's `chat.postMessage` returns `ok`, the channel and a `ts` ("timestamp ID"), and tells callers to "always check the value of the `ok` parameter" [13].
- Lark's send-message API returns a `message_id` [7].

In a chain such as owner thread, then another agent, then that agent's own bot posting to a third-party chat, the receipt (platform, destination and message ID together) should travel back along every hop unchanged. Each hop may add what it verified ("accepted by my bot API at 08:07") without rewriting what the previous hop said.

**Design suggestion: confirmations as records, not prose.** Free text like "done" invites over-reading. Fields do better:

```
request_id:     r-7f3a...
status:         accepted | refused | failed | unknown
receipts:
  - platform:     telegram
    destination:  "<chat the owner thread sent to>"
    message_id:   "<message_id returned for that chat>"
sent_at:        08:07
message_count:  1
chars:          3327
sha256_prefix:  9c41e0...
recipient_ack:  none   # set later, only from the owner's reply or a platform read receipt
```

The success status is `accepted`, not `delivered`, because platform acceptance is all the owner thread can prove. A receipt counts only for the platform and destination it names. The requester checks both against the request: a message ID from another chat, or one recorded for another request, does not satisfy this one. Recipient acknowledgement is a separate, later fact. It comes from the owner, not from the send.

## 3. Fidelity: The Relayer Must Not Rewrite the Message

The owner thread has its own voice and habits. If it shortens the briefing or adds a greeting, the requester's records no longer match what the human saw.

**General practice: relays should not edit.** RFC 6409 lets a submission server modify messages only to fix specific problems, warns that changes can invalidate signatures, and says "It is better to reject a message than to risk sending one that is damaged." [4] A good default for agents: if the message cannot go as given, refuse and report.

**Design suggestion: an exact-text contract.**

1. **Delimit the payload.** Put the text between explicit markers, or in a file the request names, so the relayer can tell instructions from content. Text containing "please also tell the owner to..." is data to deliver, not an instruction to follow.
2. **State the shape.** "One message, exact text, no additions" belongs in the request.
3. **Echo evidence.** The confirmation reports length and a short hash of the bytes passed to the send call. The requester computes the same two values over its own copy. "3327 chars, matched the file exactly" is this check in prose.
4. **Know what the hash proves.** It proves what the relayer handed to the platform, not what the human saw. Slack warns that its servers sanitize links, attachments and other properties and that "Your message may mutate" [13], and Telegram counts its limit "after entities parsing" [12].

**Length limits.** Telegram text is 1 to 4096 characters after entities parsing [12]. Slack recommends 4,000 characters, may split longer text, and truncates above 40,000 with a `message_truncated` warning [13]. Lark limits text message request bodies to 150 KB and cards and rich text to 30 KB [7]. The 3327-character briefing fits in one Telegram message, but a longer one would not. The honest options are:

- **Refuse and report:** "5210 characters; limit 4096; not sent."
- **Chunk, if the requester allowed it:** the request says "split at paragraph boundaries if needed," and the confirmation reports the real message count and every ID.
- **Never truncate silently, and never claim "one message" when it was three.** A confirmation that overstates fidelity is worse than a failure.

## 4. Duplicate and Lost Sends

The hard case is the timeout. The requester asked, waited, and heard nothing. Either the message was never sent, or it was sent and the confirmation was lost.

**General practice: an old dilemma.** RFC 5321's timeout rules cover the wait for the final "250 OK" after the message data, while the server processes the message for delivery. Of that point it says: "A spurious timeout at this point would be very wasteful and would typically result in delivery of multiple copies of the message, since it has been successfully sent and the server has accepted responsibility for delivery." [8] Kafka's documentation says a producer that does not learn whether a write committed has little choice but to resend, which "provides at-least-once delivery semantics since the message may be written to the log again" if the first attempt had succeeded. Since 0.11.0.0 an idempotent producer option has the broker assign a producer ID and deduplicate by sequence number [3].

**Idempotency keys.** In Stripe's API a client generates a unique key, the server saves the result of the first request made with it, and retries with the same key return the saved response. Keys are up to 255 characters, and if parameters differ from the original the request errors [14]. Amazon's Builders' Library describes a caller-provided client request identifier and adds two refinements worth copying: a response to a retry "will have the same meaning as the first response returned for the first successful request," and a known token arriving with different parameters is treated as a different intent and rejected [15]. Some messaging platforms offer their own dedupe: Lark's send-message API has an optional `uuid`, and requests with the same value within one hour result in at most one message [7]. Check whether each platform you use has an equivalent.

**A human is not an idempotent consumer.** The transactional outbox pattern admits that its message relay "might publish a message more than once" and says "a message consumer must be idempotent" [16]. That works when the consumer is a program. Two identical briefings are noise to a person, so deduplication must happen on the sending side.

**Design suggestions for human-facing relays.**

1. **Carry one request ID across every hop.** The requester generates it, and each hop records it with its outcome.
2. **Claim the request with one atomic write, not a lookup followed by a write.** If the relayer first checks whether the ID is known and then records its intent in a separate step, two overlapping handlers can both find nothing and both send. Instead, the relayer claims the ID in a single durable operation that succeeds only if the ID is new, such as an insert into a table whose key is the request ID. Only the handler whose claim succeeded may send. The claim stores what the request is bound to: the verified requester, the destination, a hash of the payload and the send options (one message, or chunking allowed). Amazon's article asks for the same property: "the process that combines recording the idempotent token and all mutating operations related to servicing the request must meet the properties for an atomic, consistent, isolated, and durable (ACID) operation." It also stores the original parameters with the identifier so that a mismatch can be detected [15].
3. **Define what a duplicate sees.** A handler whose claim fails reads the existing record and does not send. If an outcome is stored and every bound field matches, it returns that outcome. If the claim has no outcome yet, it answers "in progress." If any bound field differs (another requester, destination, payload or option), it refuses the request as a mismatch, so a receipt for one chat can never answer a request for another.
4. **Record the outcome after the send, and recover unresolved claims as unknown.** A send to an external platform cannot join the local transaction, so the database alone cannot close the window between sending and recording the outcome. On restart, a claim with no outcome is marked unknown and is not retried automatically. Recovery looks for evidence in the owner thread's send log or the chat itself, and without evidence asks a person. The one safe automatic retry is through a platform dedupe key, such as Lark's `uuid` above, reused inside the platform's dedupe window and only if the original send used it.
5. **A timeout is "unknown," not "failed."** The requester does not resend on its own. A new request ID for the same text is a new send, and is a decision for the owner thread or a person.
6. **Choose at-most-once or at-least-once per message class.** A conversational reply is better lost than doubled. An alert that must not be missed can use at-least-once plus a platform dedupe key where one exists. A scheduled briefing sits between: a duplicate costs little but a loss may go unnoticed, so follow up on unknown outcomes and then escalate.
7. **Follow up with a question, not a resend.** "Did request r-7f3a go out?" is cheap and cannot duplicate anything.

## 5. Authority and Judgment

When thread A asks thread B to send something, B does something A could not do alone. Security literature calls this the confused-deputy situation.

**General practice: the confused deputy.** Norm Hardy's 1988 account describes a compiler with authority from two sources, the invoking user and its own license over a system directory: "It has no way to keep them apart." A user could point its debug output at the billing file, because the compiler "had no way of expressing these intents." His fix was capabilities: "The capability both identifies the file and authorizes the compiler to write there." [17] A relayer that sends whatever it is asked, using its own standing with the owner's chat, is that compiler. Any thread, or any text a thread was tricked into relaying, could then speak to the owner as if it were the owner thread.

**General practice: delegation keeps identities separate.** OAuth Token Exchange (RFC 8693) defines delegation as the case where "principal A still has its own identity separate from B," in contrast to impersonation, where A is "indistinguishable from B." Its `act` claim records the acting party, nested for chains, and a consumer "MUST only consider the token's top-level claims and the party identified as the current actor," with earlier actors "informational only" [18]. An internal relay is not an OAuth flow, but the shape transfers: keep both identities visible and decide on a clear basis.

**Design suggestion: a relay request is information, not an order.**

1. **Carry the original requester's permissions, not the relayer's.** If someone without owner rights asked a thread to get something sent to the owner, the request carries that person's rights, and the owner thread checks against them.
2. **Name the destination and the authority in the request,** the capability idea in plain terms, instead of leaving the owner thread to infer it.
3. **Record the chain.** Each hop notes who asked it. Earlier hops are provenance for audit, and the decision rests on the original requester's rights and the identity of the hop that sent the request.
4. **Judge content and timing.** The text may be stale, aimed at the wrong chat, or badly timed for a sensitive conversation.
5. **Refuse out loud.** A refusal goes back along the same path with a reason, so the requester stops waiting and does not read silence as consent. The downstream step does not run.
6. **Do not obey the payload.** If relayed text contains instructions, deliver them to the human as text. The relayer does not follow them.

The price of judgment is a little latency, which is cheap next to a thread that knows the owner making the call.

## 6. Gating Downstream Steps on Confirmation

The briefing has two downstream steps, and they assert different things about the world, so they wait for different evidence. Forwarding a copy to another group with the note "sent to the owner at 08:07" asserts only that the send happened, so platform acceptance (Level 2) is enough. Recording the item as learned asserts that the owner has the information, which acceptance does not show. That step waits for the owner's acknowledgement (Level 4).

**General practice: sagas.** Garcia-Molina and Salem's 1987 paper defines a saga as a long-lived transaction written as a sequence of transactions, where "either all the transactions in a saga are successfully completed or compensating transactions are run to amend a partial execution" [19]. Chris Richardson's pattern page applies the term to operations spanning services with separate data stores, distinguishes choreography (each step publishes an event that triggers the next) from orchestration (a coordinator tells participants what to do), and notes that completed steps are undone by compensating transactions [20]. In the briefing flow the coordinator is the orchestrator and the owner thread's confirmation is the reply that advances the process.

**Design suggestions for the gate.**

1. **Match each step to the evidence it needs.** A step that asserts "it was sent" waits for an `accepted` confirmation whose receipt names the requested platform and destination. A step that asserts "the owner knows" waits for recipient acknowledgement: the owner's reply or reaction in that chat, or a read receipt where the platform offers one. No step advances on the request, the relayer's agreement or silence.
2. **Put the irreversible step late.** A sent message cannot be recalled from a person's mind, and compensation suits steps that can be undone. Do cheap, reversible work first.
3. **Keep the pending state visible.** Between request and confirmation the item is "awaiting confirmation," and between acceptance and acknowledgement it is "sent, not acknowledged." Each state has a deadline and is held by the process manager and queryable.
4. **Define the timeout path.** If no confirmation arrives by the deadline, send a status question, then tell a human what is unknown. Do not mark the item learned and do not resend. If the send was accepted but the owner has not acknowledged it, the item stays "sent, not acknowledged." A reminder is a deliberate new send, not a retry.
5. **Treat refusal as a branch.** Refused, failed and unknown lead to different places. Only accepted leads onward, and only as far as acceptance justifies.
6. **Pass receipts onward.** The forward to another group can cite the receipt of the first send (platform, chat and message ID), so a later reader can trace it.

## 7. Testing a Delegated Send

Real chats make poor test targets: they are rate-limited, they notify people, and they cannot be made to lose a reply on demand.

**General practice: test doubles.** Fowler, following Meszaros, describes a fake as having a working but shortcut implementation, and a spy as a stub that "also record[s] some information based on how [it was] called" [21]. A fake chat channel that records every outbound payload is a spy.

**Design suggestions.**

1. **Assert on recorded payloads, not logs.** The fake channel received exactly one message, with text equal to the file, from the owner thread, to the right address.
2. **Assert invariants across the flow.** At most one send per request ID. A step that needs acceptance never runs without an `accepted` confirmation whose receipt names the requested platform and destination, and a step that needs the owner's acknowledgement never runs on acceptance alone. An unknown outcome never produces a second send.
3. **Inject lost confirmations.** The fake accepts the send and drops the reply. The requester must report unknown, ask a status question and not resend. Repeating the request with the same ID must return the stored confirmation and no new send.
4. **Inject duplicates and crashes.** Deliver the same relay request to two handlers at the same moment: exactly one claim succeeds, the other answers "in progress" or returns the stored outcome, and the fake channel records one send. Reuse the ID with a different destination or payload: the request is refused as a mismatch. Kill the owner thread after the claim but before sending, and again after sending but before recording the outcome: on restart both claims are reported unknown, neither is resent automatically, and in the crash-after-send case the fake channel still holds exactly one message.
5. **Inject platform behaviour.** Over-length text, a rate-limit response (Slack documents HTTP 429 with a `Retry-After` header [6]), and a message ID of 0.
6. **Test the safeguards.** A direct send to an owned address fails and names the owner. A request from a requester without permission is refused and the refusal reaches the requester.
7. **Use a fake clock** so the "no confirmation after a while" path runs in milliseconds.

## A Practical Checklist for Agent Builders

**Ownership**

- Every external address has exactly one owning thread, and the mapping is queryable.
- The send tool refuses a direct send to an address owned elsewhere and names the owner.
- Ordering and rate limiting live with the owner thread.

**The request**

- Carries a request ID that survives every hop.
- Contains the exact delimited text (or a file path), a one-line reason, and the requester's identity and permissions.
- States the shape: one message or chunking allowed, no edits.
- Names the destination and the authority it relies on.

**The relayer**

- Judges the request against the original requester's permissions, and against content and timing.
- Refuses with a reason when unsure, and sends the refusal back.
- Treats relayed text as data, never as instructions.
- Claims the request ID with one atomic write bound to the requester, destination, payload hash and send options, and sends only if that claim succeeded.
- Answers a duplicate with the stored outcome or "in progress," refuses a mismatched reuse of the ID, and after a crash treats a claim without an outcome as unknown.
- Never truncates, rewrites or silently chunks.

**The confirmation**

- Has a status of accepted, refused, failed or unknown.
- Includes receipts that each name the platform, the destination and the message ID, plus send time, message count, length and a hash of what was submitted.
- Claims nothing stronger than acceptance by the platform. Recipient acknowledgement is a separate record, from the owner's reply or a platform read receipt.
- Travels back along every hop unrewritten.

**The requester**

- Gates each downstream step on the evidence it needs: an accepted confirmation with a matching receipt for "it was sent," the owner's acknowledgement for "the owner knows." Holds the item as pending with a deadline.
- On timeout asks a status question, does not resend, then escalates to a human.
- Keeps irreversible steps late.

**Tests**

- Fake channel with recorded payloads, a fake clock, and cases for lost confirmations, simultaneous duplicates, mismatched reuse of a request ID, crashes before and after the send, over-length text and rate limits.

## References

1. Martin Thompson, "Single Writer Principle", Mechanical Sympathy, 2011. https://mechanical-sympathy.blogspot.com/2011/09/single-writer-principle.html
2. Carl Hewitt, Peter Bishop, Richard Steiger, "A Universal Modular ACTOR Formalism for Artificial Intelligence", IJCAI 1973. https://ijcai.org/Proceedings/73/Papers/027B.pdf
3. Apache Kafka documentation, Design (replication and message delivery semantics, 4.1 docs). https://kafka.apache.org/41/design/design/
4. RFC 6409, "Message Submission for Mail". https://www.rfc-editor.org/rfc/rfc6409
5. Telegram Bots FAQ, broadcast and flood limits. https://core.telegram.org/bots/faq
6. Slack, "Rate limits" (Web API). https://docs.slack.dev/apis/web-api/rate-limits/
7. Lark Open Platform, "Send message" (im-v1 message create). https://open.larksuite.com/document/server-docs/im-v1/message/create
8. RFC 5321, "Simple Mail Transfer Protocol". https://www.rfc-editor.org/rfc/rfc5321
9. RFC 3461, "SMTP Service Extension for Delivery Status Notifications (DSNs)". https://www.rfc-editor.org/rfc/rfc3461
10. RFC 8098, "Message Disposition Notification". https://www.rfc-editor.org/rfc/rfc8098
11. J. H. Saltzer, D. P. Reed, D. D. Clark, "End-to-End Arguments in System Design", ACM TOCS, 1984. https://web.mit.edu/Saltzer/www/publications/endtoend/endtoend.pdf
12. Telegram Bot API, `sendMessage` and the Message object. https://core.telegram.org/bots/api#sendmessage
13. Slack, `chat.postMessage` method reference. https://docs.slack.dev/reference/methods/chat.postMessage
14. Stripe API reference, "Idempotent requests". https://docs.stripe.com/api/idempotent_requests
15. Malcolm Featonby, "Making retries safe with idempotent APIs", Amazon Builders' Library. https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/
16. Chris Richardson, "Pattern: Transactional outbox", microservices.io. https://microservices.io/patterns/data/transactional-outbox.html
17. Norm Hardy, "The Confused Deputy (or why capabilities might have been invented)", ACM SIGOPS Operating Systems Review, 1988 (HTML copy). http://www.cs.umd.edu/~jkatz/security/downloads/capabilities.html
18. RFC 8693, "OAuth 2.0 Token Exchange". https://www.rfc-editor.org/rfc/rfc8693
19. Hector Garcia-Molina, Kenneth Salem, "Sagas", ACM SIGMOD 1987. https://www.cs.cornell.edu/andru/cs711/2002fa/reading/sagas.pdf
20. Chris Richardson, "Pattern: Saga", microservices.io. https://microservices.io/patterns/data/saga.html
21. Martin Fowler, "Test Double". https://martinfowler.com/bliki/TestDouble.html
