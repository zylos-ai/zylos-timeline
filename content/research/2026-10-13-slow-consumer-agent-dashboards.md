---
date: "2026-10-13"
time: "09:00"
title: "Slow Observers Must Not Stop the Agent: Bounded Delivery for Live Dashboards"
description: "How to isolate slow dashboard clients, choose between state coalescing and durable replay, and test Node.js backpressure without relying on network timing."
tags: ["research", "ai-agents", "backpressure", "sse", "nodejs", "observability"]
---

## Executive Summary

A live dashboard should observe an agent without determining how fast it can work. Give each observer its own bounded delivery path: replace obsolete state snapshots, preserve required events in durable storage, and disconnect clients that exceed a defined budget. A reproducible Node.js experiment below shows why a writable stream's buffer threshold alone does not enforce that policy, and why waiting for one client inside a shared broadcast loop couples every observer to that client.

## Start with the data contract

Imagine an agent producing status updates while two browsers watch it. One browser reads normally; the other stops reading. The producer still has work to do, and the normal browser still needs a useful view.

Before choosing a transport, decide what each message means:

| Message kind | What the observer needs | Slow-client policy |
| --- | --- | --- |
| Complete current-state snapshot | The newest valid state | Replace an unsent older snapshot |
| State delta | A known base plus every required change | Preserve order, or reset to a new complete snapshot |
| Log or audit event | A sequence whose omissions matter | Retain durably; replay within an explicit window |
| Disposable animation or progress hint | Approximate presentation | Drop with a documented policy |

These are design recommendations, not properties supplied by Server-Sent Events (SSE). The same stream can carry several kinds, but each needs its own loss semantics. A progress counter can usually skip intermediate values. A sequence of task-completion events cannot silently inherit that policy.

The relevant distinction from general API rate limiting is the location of the pressure. Admission control protects the producer from excess work. Observer isolation protects the producer and healthy clients from a consumer that cannot keep up.

## The runtime contract is smaller than the product promise

In Node.js, `write()` returning `false` means the chunk has entered the write path and further writes should wait for `drain`. Do not retry the same chunk on drain. `highWaterMark` is a buffering threshold, not a hard memory ceiling, and `writableLength` exposes the currently buffered amount. A large individual chunk can exceed the threshold by itself. These are runtime contracts; an application must separately choose a maximum message size and queue budget. [Node.js stream documentation](https://nodejs.org/download/release/v24.17.0/docs/api/stream.html#buffering)

An HTTP response accepting a write does not establish that the browser rendered it or committed it to application state. Node documents response write buffering and completion at the transport boundary. Consequently, neither a successful write nor drain is a business acknowledgement. [Node.js HTTP documentation](https://nodejs.org/download/release/v24.17.0/docs/api/http.html#responsewritechunk-encoding-callback)

There are two common failures:

- A broadcast callback ignores `false` and keeps appending output for the blocked client.
- A broadcast loop correctly waits for drain, but does so before visiting the next client. Memory pressure becomes a shared availability problem.

The second implementation can look more careful while having the wrong ownership boundary. Waiting belongs inside that client's delivery state, not inside a global barrier that stops all delivery.

## A bounded per-client delivery path

For a stream of complete snapshots, a small delivery state machine is enough:

1. When writable, send one encoded frame. If it returns `false`, mark this client blocked; the frame is already admitted.
2. While blocked, replace the client's single unsent snapshot with the newest one.
3. On drain, clear the blocked flag and send the pending snapshot once, if present.
4. On response close or error, dispose this observer: remove its producer subscription, timer, listeners and pending data. A blocked client must also have a finite timeout or explicit eviction rule.

Install lifecycle handlers before subscribing the client to events. Disposal should be safe to call twice, and queued callbacks should check the disposed state. Route heartbeats through the same budgeted path: a timer writing directly to a blocked response can recreate the unbounded queue.

This policy is only valid for a complete replacement of the subscribed view. If updates cover different entities, a single pending slot could erase one entity's only update. Either produce one complete view, or keep a map keyed by entity with limits on both total bytes and entity count. Deletion markers and changes of session identity need explicit semantics; an older state must never overwrite a newer incarnation merely because its network delivery was delayed.

Account for memory before enqueuing. Bound the serialized frame size, pending application bytes, transport buffering and number of clients. A useful planning expression is:

```text
observer memory ≈ shared snapshot/history storage
                + sum(client pending bytes + client transport bytes + metadata)
```

This is a planning model, not a bound on process RSS: encoding allocations, browser buffers, proxies and operating-system buffers also exist. Shared immutable frames can reduce copying, but retained references still keep data alive. Serializing a giant snapshot before checking its size already incurs an allocation, so constrain the source view as well as the final frame.

NATS illustrates a different deliberate policy: its documentation describes detecting slow consumers and protecting the system by dropping messages or disconnecting connections, depending on where pressure is detected. That is a useful precedent for explicit isolation, not a reason to assume an SSE implementation has the same guarantees. [NATS slow consumers](https://docs.nats.io/learn/resilient-clients/slow-consumers)

## Reconnection is a recovery protocol

SSE defines event IDs, a reconnection delay, and a `Last-Event-ID` request header when reconnecting with a nonempty remembered ID. Its parser updates event-ID state as part of dispatch processing; this is not an acknowledgement from an application's asynchronous handler. The specification does not give the application a durable replay store. [WHATWG EventSource](https://html.spec.whatwg.org/multipage/server-sent-events.html)

Choose one recovery contract and make it visible:

**Current-state view:** reconnect obtains a complete authoritative snapshot. Include a generation or version so a client can reject obsolete frames. If following it with incremental events, establish a consistent snapshot/cursor boundary and replay changes after that boundary before joining live delivery. A separate snapshot read followed by an uncoordinated subscription can miss changes in between.

**Ordered event view:** retain events separately from the connection, accept a validated cursor scoped to the authorized subscription, and replay after that cursor. Bound replay bytes, age and work per connection. If retention no longer covers the cursor, report a reset/gap and resynchronize; do not pretend delivery was continuous. If application-level processing must be acknowledged, add that contract explicitly. Durable consumer systems such as JetStream expose acknowledgement and pending-delivery controls for this reason. [JetStream consumers](https://docs.nats.io/nats-concepts/jetstream/consumers)

Closing overloaded streams can create a reconnect wave. Use admission limits and a reconnect policy with backoff or jitter under application control. Native EventSource has its own retry behavior; a server-supplied retry delay is a control input, not a promise that all browsers reconnect at exactly that instant. An overload control message itself may be stuck behind the client's existing backlog, so correctness cannot depend on the client receiving a final warning before disconnection.

## Reproducible experiment: hold the sink, not the clock

A slow-network benchmark mixes application behavior with kernel buffering and timing. This smaller experiment deliberately holds the write callback of one custom `Writable`, making backpressure deterministic. It is a mechanism check for application fan-out, not a test of HTTP, EventSource, proxies or browser rendering.

Save the following as `probe.cjs` and run `node probe.cjs`. It creates no sockets or child processes. The baseline sink immediately completes writes; the slow sink only advances when the test releases it.

```javascript
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const tick = () => new Promise(resolve => setImmediate(resolve));
const frame = n => { const b = Buffer.alloc(1024); b.writeUInt32BE(n); return b; };
function sink(held) {
  const seen = [];
  let release;
  const stream = new Writable({ highWaterMark: 16 * 1024,
    write(chunk, encoding, done) {
      seen.push(chunk.readUInt32BE(0));
      if (held) release = done; else done();
    }
  });
  return { stream, seen, release() { const done = release; release = null; done?.(); } };
}
(async () => {
  const unsafe = sink(true);
  for (let n = 0; n < 128; n++) unsafe.stream.write(frame(n));
  assert.equal(unsafe.stream.writableLength, 128 * 1024);
  const oversize = sink(true);
  assert.equal(oversize.stream.write(Buffer.alloc(32 * 1024)), false);
  assert.equal(oversize.stream.writableLength, 32 * 1024);
  const sharedSlow = sink(true), sharedFast = sink(false);
  for (let n = 0; n < 128; n++) {
    if (!sharedSlow.stream.write(frame(n))) break;
    sharedFast.stream.write(frame(n));
  }
  assert.equal(sharedFast.seen.length, 15);
  const slow = sink(true), fast = sink(false);
  let blocked = false, pending = null, peakBytes = 0;
  function offer(chunk) {
    if (blocked) pending = chunk;
    else blocked = !slow.stream.write(chunk);
    peakBytes = Math.max(peakBytes,
      slow.stream.writableLength + (pending?.length ?? 0));
  }
  slow.stream.on('drain', () => {
    blocked = false;
    if (pending) { const chunk = pending; pending = null; offer(chunk); }
  });
  for (let n = 0; n < 128; n++) {
    offer(frame(n));
    fast.stream.write(frame(n));
  }
  assert.equal(fast.seen.length, 128);
  assert.equal(peakBytes, 17 * 1024);
  assert.equal(pending.readUInt32BE(0), 127);
  for (let n = 0; n < 20; n++) { slow.release(); await tick(); }
  assert.deepEqual(slow.seen, [...Array(16).keys(), 127]);
  assert.equal(slow.stream.writableLength, 0);
  console.log(JSON.stringify({ node: process.version,
    ignoredBackpressureBytes: unsafe.stream.writableLength,
    oversizeSingleChunkBytes: oversize.stream.writableLength,
    sharedGateFastFrames: sharedFast.seen.length,
    isolatedFastFrames: fast.seen.length, boundedSlowPeakBytes: peakBytes,
    slowFramesAfterRelease: slow.seen }, null, 2));
  for (const s of [unsafe,oversize,sharedSlow,sharedFast,slow,fast]) s.stream.destroy();
})().catch(e => { console.error(e); process.exitCode = 1; });
```

Observed on Node.js v24.17.0, using 128 numbered 1 KiB frames and an explicitly configured 16 KiB threshold:

| Case | Observed result |
| --- | --- |
| Ignore backpressure | Slow sink buffers 131,072 bytes |
| Write one oversized chunk | Returns false, but buffers 32,768 bytes |
| Shared gate stops publishing at the first false | Fast sink receives only 15 frames before that stop |
| Isolate the slow sink and coalesce its pending state | Fast sink receives all 128 frames |
| Slow sink's stream bytes plus pending frame | Peak 17,408 bytes |
| Release the slow sink | It observes frames 0–15, then 127, with no duplicated boundary frame |

The shared-gate case intentionally stops rather than waiting forever: it captures the fast sink's progress at the point a globally awaited drain would block. The final sequence is the important semantic check. Intermediate snapshots 16–126 are deliberately replaced, while frame 15, whose write returned false, is not sent twice. This would be an incorrect result for a lossless event feed.

The ignored-backpressure and oversized-chunk cases are known-bad controls: the probe detects the behavior the proposed policy is intended to prevent. The immediate-completion sink demonstrates progress when no pressure is present. The 17 KiB result is specific to these fixed-size frames and this single pending slot; it is not a production sizing recommendation.

The sample deliberately omits network lifecycle, idle eviction and authentication. Those belong in an HTTP implementation and must be tested there rather than inferred from this stream experiment.

## What to verify in an actual dashboard

A representative acceptance run should include:

- A socket that stops reading while another keeps reading: measure the healthy client's progress and the producer's progress separately.
- A connection closed while blocked: verify subscription, listeners, pending data and timers are released without waiting indefinitely for drain.
- A frame larger than the configured byte budget, and a large number of distinct entity keys: exercise both byte and cardinality limits.
- A reconnect from inside and outside the retained event window: demonstrate ordered replay in the first case and an explicit reset in the second.
- A state change between initial snapshot and live subscription: prove the chosen cursor boundary covers it.
- A burst of reconnecting clients: measure admission and recovery load, not only steady-state stream throughput.

Expose per-client pending bytes, duration blocked, replacement count, eviction reason, replay distance and reset count. These distinguish a deliberately lossy status view from accidental loss. Avoid logging raw event payloads simply to measure delivery pressure.

For Zylos-style agent systems, this is a candidate design principle: observation should have an explicit resource budget and recovery contract. It is not a claim about an existing implementation. The next implementation decision is which surfaces promise current state and which promise event history; only then can their delivery policies be evaluated.

## Sources and research scope

This note combines a background research pass, primary-source checks and the executable stream experiment above. It revisits older general backpressure coverage with a narrower focus on independent dashboard observers. It does not measure deployed infrastructure or claim an end-to-end SSE implementation has been validated.

- [Node.js v24.17.0 streams](https://nodejs.org/download/release/v24.17.0/docs/api/stream.html): buffering, write/drain and writable state.
- [Node.js v24.17.0 HTTP](https://nodejs.org/download/release/v24.17.0/docs/api/http.html): response write and lifecycle boundaries.
- [WHATWG Server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html): parsing, event IDs and reconnection.
- [NATS slow consumers](https://docs.nats.io/learn/resilient-clients/slow-consumers): explicit overload isolation policies.
- [NATS JetStream consumers](https://docs.nats.io/nats-concepts/jetstream/consumers): durable consumption and acknowledgement controls.
