---
date: "2026-09-08"
title: "Commitment Boundaries for Safe Retries in Streaming Agents"
description: "How to distinguish reconnecting, resuming, and replaying an agent request without duplicating output or tool effects, with verified SDK behavior and a local fault-injection experiment."
tags: ["streaming", "retries", "reliability", "idempotency", "agents", "http"]
---

## Executive Summary

A streaming request can fail after its work has already happened. A client that received no text may still have initiated model generation, incurred work, or dispatched a tool operation. Conversely, receiving a complete model response does not prove that every external tool operation completed. Safe recovery therefore depends on evidence about each operation, not just the HTTP status or the number of tokens displayed.

Three mechanisms need separate names: reconnecting restores a connection; resuming reads an existing operation through a documented cursor; replaying submits the work again. This research compares their contracts, checks official Python SDK implementations, and proposes a recovery decision table for agent developers. A local fault-injection experiment demonstrates why “nothing received” is not sufficient evidence for replay. The recommendations below are engineering synthesis, not additional provider guarantees.

## 1. Identify which operation is being repeated

An agent turn can contain a model request, a sequence of output events, several tool invocations, and delivery of the final answer. These are different operations. Repeating the model request might produce a different tool call; repeating that tool call might create a duplicate resource; redelivering an already-recorded event might only repeat text on a screen. A recovery policy must identify the operation it governs.

| Mechanism | What repeats | Contract needed |
|---|---|---|
| Reconnect | Establishing a transport connection | Connection/authentication rules; no implied preservation of work |
| Resume | Reading an existing operation after a position | Stable operation identity, retained events, documented cursor semantics |
| Replay | Submitting an operation again | Evidence it was never applied, or an applicable idempotency contract |
| Continue | A new generation informed by reconciled history | Complete enough context, explicit treatment of partial output and tool outcomes |

HTTP supplies a useful baseline. GET, HEAD, PUT and DELETE have idempotent semantics, while POST does not acquire them merely because the client wants retries. RFC 9110 permits automatic retries of a non-idempotent method when the client knows the particular operation is idempotent or can establish that the original was not applied. The same intended effect does not require an identical response body. [RFC 9110 §9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2)

An application can deliberately accept repeated model generation, including additional cost and different text. That is a product choice. It does not automatically authorize duplicate external writes performed by an agent using the model.

## 2. SSE reconnect is not application recovery

The browser `EventSource` API specifies reconnection behavior for eligible network failures. A final non-200 response or an incompatible content type instead fails the connection; these are not universal retry triggers. When applicable, the client sends its remembered `Last-Event-ID`. The server must implement meaningful handling of that position for it to help recover missed events. The protocol alone does not supply a durable application log, retention policy, or exactly-once effect execution. [WHATWG Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html)

Also distinguish an SSE wire format from the browser API. A Python HTTP client or a JavaScript `fetch` consumer parsing `data:` lines does not inherit `EventSource`'s reconnection algorithm. Its actual recovery behavior comes from the client implementation and the endpoint contract.

OpenAI documents a more specific mechanism: start a Responses operation with `background: true` and `stream: true`, capture the response ID and event sequence, then retrieve that response with streaming and `starting_after`. This reads the existing response rather than creating another one. The documented retention and data-handling constraints of background mode still apply. [OpenAI background mode](https://developers.openai.com/api/docs/guides/background)

The official Python example demonstrates `responses.retrieve(response_id=..., stream=True, starting_after=10)` following an interrupted read. It establishes a usable API primitive, not an automatic crash-recovery guarantee for every SDK application. [OpenAI background streaming example](https://github.com/openai/openai-python/blob/be928151372e4b62adb4a1571cda52ad759b38be/examples/responses/background.py)

For a durable consumer, the recovery cursor should represent events safely recorded or applied, not simply the largest sequence observed on the socket. Advancing it before processing creates a loss window. Processing before advancing can create duplicates after a crash, so the consumer also needs idempotent application or a transaction that couples application and cursor advancement. This is a client design recommendation.

## 3. SDK retries do not establish server idempotency

A source audit must follow a value all the way to the request sent over the wire. Finding an internal function named `_idempotency_key()` is insufficient.

At the inspected OpenAI Python commit, the base client can generate an internal key once and reuse it inside a call's retry loop. But `_idempotency_header` is initialized to `None`, and header emission is conditional on a configured header name. The ordinary client at the same commit does not override that setting. This code therefore does not substantiate a claim that the standard client sends an idempotency header or that the server deduplicates generation. [OpenAI base client](https://github.com/openai/openai-python/blob/be928151372e4b62adb4a1571cda52ad759b38be/src/openai/_base_client.py), [OpenAI client](https://github.com/openai/openai-python/blob/be928151372e4b62adb4a1571cda52ad759b38be/src/openai/_client.py)

The inspected Anthropic client has the same distinction: internal key plumbing exists, but the default header name is unset and emission is gated. This is why implementation evidence needs both the base class and the configured concrete client. [Anthropic base client](https://github.com/anthropics/anthropic-sdk-python/blob/62de60b27d04f0927a0ccf0f2610597fafcfab6a/src/anthropic/_base_client.py), [Anthropic client](https://github.com/anthropics/anthropic-sdk-python/blob/62de60b27d04f0927a0ccf0f2610597fafcfab6a/src/anthropic/_client.py)

Both clients document two automatic retries by default—up to three attempts—for connection failures and selected HTTP failures including 408, 409, 429 and server errors. Configuration and explicit server retry hints can alter behavior. That transport policy is separate from recovery after an application has started consuming streamed events. [OpenAI retry documentation](https://github.com/openai/openai-python/blob/be928151372e4b62adb4a1571cda52ad759b38be/README.md#retries), [Anthropic retry documentation](https://github.com/anthropics/anthropic-sdk-python/blob/62de60b27d04f0927a0ccf0f2610597fafcfab6a/README.md#retries)

A real endpoint idempotency contract specifies scope, parameter matching, retention and concurrent-request behavior. Stripe, for example, documents retaining the first executed result under a key, returning it on repeat requests, rejecting mismatched parameters, and treating reuse after pruning as a new request. Validation failures and concurrent conflicts have their own rules. These guarantees apply to Stripe's documented endpoints; copying the header name into another API does not copy the guarantees. [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests)

For an agent harness, account for nested retries as well: an application-level retry can multiply attempts already made by the SDK. One visible “retry” button is not necessarily one network attempt. Log both logical-operation identity and individual attempt identity, with separate budgets for generation and external effects.

## 4. Authentication recovery is a separate decision

An initial HTTP 401 and an error event inside an HTTP 200 stream are different observations. Once the response has begun, the server cannot replace its HTTP status with 401; it can emit a protocol error or terminate the stream. Anthropic explicitly documents errors delivered inside SSE streams after the initial successful HTTP response. [Claude API errors](https://platform.claude.com/docs/en/api/errors)

For OAuth bearer tokens, `invalid_token` can mean expiration, revocation, malformed input or another invalidity. RFC 6750 permits obtaining a new access token and retrying. It does not make local expiry the prerequisite, nor guarantee that a refresh grant remains valid. An access token becoming invalid does not, by itself, prove its refresh credential is unusable. [RFC 6750 §3.1](https://www.rfc-editor.org/rfc/rfc6750.html#section-3.1)

A practical policy for an integration that actually supports refresh is one bounded forced refresh after the appropriate authentication failure, even if the cached expiry is still in the future. Permanent refresh failure should surface a reconnection requirement; transient refresh failure should retain its distinct classification. Whether to replay the original operation remains a second question: an explicit authentication rejection at the gate is different from an ambiguous disconnect after work may have begun. API-key integrations must follow their own credential contract rather than inventing an OAuth refresh flow.

## 5. Record observations without overstating what they prove

The following table is a proposed client model. Its rows describe available evidence, not universal server execution stages.

| Observation | What remains uncertain | Recovery decision |
|---|---|---|
| Transport proves this request was never transmitted | No remote execution from this attempt | Send, subject to the normal budget |
| Request may have been sent; no response arrived | Acceptance, generation, hosted-tool effects | Use supported operation lookup or idempotency; otherwise retain an ambiguous outcome |
| HTTP 200 and stream headers received | Whether output or effects already exist beyond the client | Capture any operation identity; prefer supported retrieval/resumption |
| Partial text or tool-call data received | Remaining output; hosted effects; downstream consumers' progress | Preserve partial data; resume, or plan an explicit continuation after reconciliation |
| A client tool invocation was dispatched | Whether that tool committed its effect | Reconcile or retry that tool under its own operation contract |
| A successful model terminal event was received | Whether separate tool work and local persistence are complete | Record model completion; settle other operations independently |
| EOF or error without successful terminal evidence | Whether the generation finished elsewhere | Mark interrupted or unknown; do not turn iterator exhaustion into success |

Three consequences are easy to miss. First, dispatch is not proof of commitment. Second, partial text is not proof that no hosted tool has run. Third, a model's terminal event does not certify all downstream work.

Anthropic's documented interrupted-text recovery constructs a new continuation request. Its guidance differs by model generation and excludes partial recovery of tool-use and thinking blocks. Such continuation is useful, but it is not cursor-based resumption of the same generation or a guarantee against repeating already-executed tools. [Claude streaming recovery](https://platform.claude.com/docs/en/build-with-claude/streaming#error-recovery)

Only execute validated, complete tool invocations under the applicable protocol. Keep a durable record linking the tool's logical operation, normalized parameters and outcome. If a regenerated model turn proposes another call ID for the same business action, blindly using the new ID as a fresh idempotency key can still duplicate the effect. Tool-call identity and business-operation identity require an explicit mapping.

## 6. A recovery decision function, not a generic retry loop

This pseudocode expresses policy, not a provider API. Each predicate must be backed by observed state or an explicit endpoint contract.

```text
recover(record, failure):
    if record.model_success_durably_recorded:
        return settle_remaining_tools_and_delivery
    if record.tool_effect_unknown:
        return reconcile_tool_operation
    if failure.proves_request_never_transmitted:
        return bounded_send
    if failure.is_auth_rejection and auth_contract.supports_refresh:
        return bounded_refresh_then_reclassify_original_operation
    if record.operation_id and contract.supports_resume(record):
        return resume_after_durably_applied_cursor
    if contract.guarantees_replay(record.key, record.parameters):
        return bounded_replay_with_same_key
    return preserve_partial_result_and_report_ambiguous_outcome
```

Successful completion requires the provider's successful terminal evidence and local persistence of the necessary result. EOF, a failed terminal event, an incomplete outcome, and user cancellation each need their own handling. Cancellation should not silently become permission to launch a replacement operation. [OpenAI Responses streaming event reference](https://platform.openai.com/docs/api-reference/responses-streaming)

Persisting a client operation ID before sending helps correlate attempts, but cannot alone solve the interval between server acceptance and learning the server's response ID. Save that ID as soon as it is actually received. If the process dies first, recovery still requires server-supported lookup or idempotency; the client must not manufacture certainty from its own journal.

## 7. Local fault injection: no response, two effects

A synthetic Python HTTP server was exercised locally during this research. Its POST handler incremented an in-memory effect counter, then deliberately closed the connection before sending any HTTP response. A second request without a key incremented the counter again. With an operation key, the server retained and returned the first result. A separate GET read existing operation events after a fixed simulated cursor (the slice after the first event).

| Experiment | Observed effect count |
|---|---|
| Unkeyed POST, disconnect before response, repeat POST | 2 effects |
| Same failure with a stable operation key and explicit server deduplication | 1 additional effect across both attempts |
| Retrieve the keyed operation's remaining events | 0 additional effects |

The unkeyed case is a positive control: the test actually detects duplication. The keyed comparison changes server semantics, not merely client headers. No model provider or production service was contacted. This experiment establishes that the failure mechanism is possible; it does not measure a vendor's billing or hosted-tool behavior.

The essential server logic is small:

```python
# Synthetic single-threaded model; intentionally not durable production code.
def execute(key, drop_response):
    global effect_count
    if key is None or key not in results:
        effect_count += 1
        result = {"effect": effect_count, "events": ["accepted", "done"]}
        if key is not None:
            results[key] = result
    else:
        result = results[key]
    if drop_response:
        return CLOSE_CONNECTION_WITHOUT_RESPONSE
    return result
```

In the actual probe, the sentinel above was implemented by returning from an HTTP handler with the connection set to close; the client observed `RemoteDisconnected`. Real deduplication additionally requires durable storage, atomic arbitration between concurrent attempts, parameter checks and a retention policy. An in-memory dictionary proves none of those properties.

## 8. Failure-injection acceptance matrix

These are proposed integration tests, beyond the local experiment already run.

| Fault | Required assertion |
|---|---|
| Proven DNS/connect failure before transmission | A new send is allowed even when the operation includes tools |
| Connection closes after server acceptance but before headers | Client preserves uncertainty; no unsupported replay |
| Access token rejected while cached expiry is in the future | Supported bounded refresh remains eligible; no expiry-only veto |
| SSE error after HTTP 200 | Error payload is classified; initial HTTP success does not mask failure |
| Stream ends after a text delta without a terminal event | Partial text is retained; generation is not marked successful |
| Crash after recording an event but before advancing the cursor | Redelivery does not repeat its application or tool effect |
| Tool commits, then its response is lost | Reconciliation/same-key retry yields one effect, or uncertainty stays explicit |
| Crash before receiving the server operation ID | Client ID alone does not unlock a fictitious resume path |
| Same operation key reused with different parameters | Local/server contract rejects the mismatch |
| User cancels while a recovery timer is pending | No automatic replacement generation starts |

## Limits and applicability

The SDK observations are pinned to the linked commits, not promised for every future release or every language client. Hosted-tool execution and charging after an ambiguous disconnect require provider-specific evidence; the local experiment deliberately makes no such claims. Response retention can expire, so a documented resume API is not unlimited recovery storage. Finally, resuming model output cannot make a separate tool API transactional.

For Zylos-style agent runtimes, a useful implementation boundary is one recovery owner per logical operation: the transport layer classifies connection failures, the generation adapter understands terminal events and provider cursors, and the tool executor owns external effects. Share evidence between those layers. Do not let each independently replay the whole turn.
