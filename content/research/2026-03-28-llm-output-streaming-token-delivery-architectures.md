---
date: "2026-03-28"
title: "LLM Output Streaming and Real-Time Token Delivery Architectures"
description: "Deep dive into streaming protocols (SSE, WebSocket, gRPC), token delivery patterns across major providers, multi-model aggregation, buffering strategies, and production deployment patterns for AI agent systems."
tags: ["streaming", "SSE", "token-delivery", "latency", "agent-runtime", "production"]
---
## Executive Summary

LLM streaming is now a first-class concern for production AI systems. Server-Sent Events (SSE) over HTTP has emerged as the dominant transport for token delivery, adopted by Anthropic, OpenAI, and Google. The core design challenge is not the protocol itself—SSE is mature and well-understood—but the surrounding infrastructure: reverse proxy buffering, backpressure under slow consumers, partial structured output parsing, multi-model aggregation, and latency optimizations like prefill-decode disaggregation. Speculative decoding and KV cache reuse are closing the TTFT gap significantly. Agent runtimes have converged on async streaming pipelines with event-typed lifecycles. The emerging A2A and MCP protocols both use SSE for streaming, signaling that SSE over HTTP will remain the standard for at least the next 2–3 years until WebTransport matures.

---

## 1. Streaming Protocols and Transport

### 1.1 SSE — The Dominant Standard

Server-Sent Events is the protocol of choice for LLM token streaming across all major providers. Its dominance stems from a practical convergence of factors: it is pure HTTP (works through any compliant proxy), natively reconnects via the browser `EventSource` API, carries no bidirectional overhead, and requires no special server infrastructure.

The SSE wire format is deliberately minimal:

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}

event: message_stop
data: {"type":"message_stop"}

```

Each message is separated by `\n\n`. Fields are: `data:` (payload), `event:` (type), `id:` (reconnect cursor), `retry:` (reconnect delay in ms), and `:` (comment/heartbeat, ignored by parser). Multi-line data uses repeated `data:` prefixes, which the parser concatenates.

**Critical limitation of the browser `EventSource` API**: it only supports GET requests with no custom headers and no request body. LLM APIs use POST with JSON bodies and auth headers, which means `EventSource` cannot be used directly from browsers. Client code must use `fetch()` with `ReadableStream` consumption instead, manually parsing the SSE byte stream.

**Horizontal scaling advantage**: SSE connections are stateless HTTP requests held open. Unlike WebSockets, they require no sticky sessions or connection brokers. Standard load balancers (Nginx, HAProxy, AWS ALB) handle them correctly once buffering is disabled.

### 1.2 WebSockets

WebSockets establish a persistent, full-duplex TCP connection. For pure token streaming (server → client), this is architectural overkill: the bidirectional capability goes unused, and the stateful connection complicates horizontal scaling (requires sticky sessions or a shared connection store).

WebSockets become the right choice when the client needs to send data *during* streaming—for example:
- Sending voice audio while receiving transcription tokens
- Submitting real-time tool results that influence the running generation
- Canceling or steering a running generation mid-stream

vLLM's Realtime API (January 2026) uses WebSockets for its audio-in/text-out streaming endpoint precisely because bidirectionality is required. The WebSocket `ws.bufferedAmount` property must be monitored for backpressure: if it is non-zero, the sender must pause before writing additional tokens.

Production pattern (hybrid architecture): use SSE for the downstream data plane (token delivery to UI) and WebSocket for the control plane (cancellation, user feedback injection). This separates concerns and avoids the statefulness cost for the high-volume stream path.

### 1.3 gRPC / HTTP/2 Streaming

gRPC runs over HTTP/2 and uses Protocol Buffers for serialization. For service-to-service communication (e.g., orchestrator → model backend, or orchestrator → vector database), gRPC offers significant advantages:

- **Connection efficiency**: A single HTTP/2 connection multiplexes many concurrent streams. For 50 agents making 10 requests/minute, REST requires 500 new TCP connections/minute; gRPC maintains 50 persistent connections. This yields a 40–60% reduction in connection overhead.
- **Throughput**: 40–60% higher requests/second vs REST for high-frequency microservice traffic.
- **Streaming latency**: 25–35% lower for streaming workloads due to binary framing and eliminated connection establishment.
- **Bandwidth**: 60–70% reduction via Protobuf's binary serialization vs JSON (3–7x smaller payloads, 5–10x faster to parse).

**Head-of-line blocking caveat**: HTTP/2 runs multiple streams over a single TCP connection. A single dropped TCP packet blocks *all* streams on that connection until retransmission. For very high-throughput AI inference, this is a real concern. HTTP/3/QUIC addresses this by using independent QUIC streams; a lost packet only blocks its own stream.

**Recommended architecture**: SSE for browser-facing token delivery; gRPC for internal service mesh (orchestrator ↔ model backend, orchestrator ↔ vector DB). A transcoding gateway (e.g., Envoy with gRPC-Web, or a custom JSON/Protobuf bridge) translates at the boundary.

### 1.4 HTTP/3 / QUIC / WebTransport

HTTP/3 (QUIC-based) solves TCP head-of-line blocking and improves performance on unreliable networks. As of early 2026:

- HTTP/3 global adoption: ~35% (Cloudflare data)
- All major browsers support it by default
- HTTP/3 shows ~47% performance improvement over HTTP/2 in benchmarks

**WebTransport** (multiplexed streams and datagrams over QUIC/HTTP/3) is the long-term replacement for WebSockets. It offers independent streams (no head-of-line blocking), datagram support for low-latency fire-and-forget, and works through HTTP/3 infrastructure. However, production support is not yet mature: ~75% browser coverage, no major browser/server ships RFC 9220 (WebSocket-over-HTTP/3) production support as of early 2026. Expected viable window: 2–3 years.

### 1.5 Provider Implementations

| Provider | Protocol | Base URL | Streaming Parameter |
|----------|----------|----------|---------------------|
| Anthropic | SSE (typed events) | `POST /v1/messages` | `"stream": true` |
| OpenAI | SSE (inline JSON) | `POST /v1/chat/completions` | `"stream": true` |
| Google Gemini | SSE | `POST /v1beta/models/{model}:streamGenerateContent?alt=sse` | `alt=sse` URL param |

All return `Content-Type: text/event-stream`. Termination: OpenAI sends `data: [DONE]`; Anthropic and Google use explicit stop event types (`message_stop`, `finishReason`).

---

## 2. Token-by-Token Delivery Patterns

### 2.1 Anthropic: Content Block Streaming

Anthropic's streaming model uses a **typed event lifecycle** per content block. Every response is decomposed into typed content blocks (text, tool_use, thinking), each with its own start/delta/stop lifecycle.

**Full event sequence for a text response:**

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_01...","type":"message","role":"assistant","content":[],"model":"claude-opus-4-6","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":25,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: ping
data: {"type":"ping"}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"!"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":342}}

event: message_stop
data: {"type":"message_stop"}
```

**Tool use streaming:**
For `tool_use` content blocks, `content_block_delta` events carry `input_json_delta` type, streaming partial JSON strings:

```
event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01...","name":"get_weather","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"loc"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"ation\": \"New York\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}
```

Accumulate `partial_json` strings and parse only at `content_block_stop`.

**Extended thinking streaming:**
Thinking blocks (`type: "thinking"`) use `thinking_delta` events. A `signature_delta` event is emitted just before `content_block_stop`—this signature must be preserved for multi-turn continuity:

```
event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think about this..."}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"EqQBCgI..."}}
```

With `display: "omitted"`, thinking_delta events are suppressed and only the signature_delta is sent—improving time-to-first-text-token for latency-sensitive apps.

**Key behavior note**: When streaming with thinking enabled, text arrives in irregular "chunky" batches rather than smooth token-by-token delivery. This is expected—the streaming system batches thinking content for performance. Consumer code must not assume uniform chunk sizes.

### 2.2 OpenAI: Choice Delta Streaming

OpenAI uses a flat event structure: every chunk is an identical JSON object with a `choices` array containing a `delta` field:

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion.chunk",
  "created": 1694268190,
  "model": "gpt-5.2",
  "choices": [{
    "index": 0,
    "delta": {"content": "Hello"},
    "logprobs": null,
    "finish_reason": null
  }]
}
```

No event type field in the SSE `event:` line—all type information is embedded in the JSON payload itself.

**Tool call streaming**: Tool call arguments stream as partial JSON strings within `delta.tool_calls[].function.arguments`. Accumulation requires tracking by `delta.tool_calls[].index`:

```json
"delta": {
  "tool_calls": [{
    "index": 0,
    "id": "call_abc",
    "type": "function",
    "function": {"name": "get_weather", "arguments": "{\"loc"}
  }]
}
```

**Token usage**: Available only in the final chunk when `stream_options: {"include_usage": true}` is set. The final chunk carries `choices: []` (empty) plus a `usage` object.

**Termination**: `data: [DONE]` sentinel after the last data event.

### 2.3 Google Gemini: Chunk-Level Delivery

Gemini streams via `streamGenerateContent?alt=sse`. Each chunk is a `GenerateContentResponse`:

```json
{
  "candidates": [{
    "content": {"parts": [{"text": "Hello world"}], "role": "model"},
    "finishReason": null,
    "safetyRatings": [...]
  }],
  "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 5}
}
```

Notable difference: Gemini returns larger token chunks rather than single tokens, and includes `safetyRatings` in every chunk. The `finishReason` field appears in the final chunk.

### 2.4 Delta vs Full-State Updates

| Approach | Description | Used by | Trade-off |
|----------|-------------|---------|-----------|
| Delta updates | Only the new tokens/changes | Anthropic, OpenAI | Lower bandwidth, requires accumulation |
| Full-state updates | Entire response state per chunk | Some frameworks (LangGraph "updates" mode) | Easier to process, higher bandwidth |

Delta is universally preferred at the API transport layer. Full-state appears at the framework orchestration layer (e.g., LangGraph `stream_mode="updates"` emits the full state diff after each agent step, not individual tokens).

### 2.5 Structured Output Streaming

The fundamental tension: JSON is only valid at completion, but streaming delivers tokens incrementally.

**Grammar-constrained decoding** (supported by OpenAI, Gemini, vLLM): A transformer layer masks invalid token logits at generation time, guaranteeing that the output—once complete—matches the schema. This means the model can only generate tokens that would lead to a valid structure. Streaming delivery is identical to unstructured responses; clients still wait for completion before parsing, unless using incremental parsing.

**Incremental parsing with Tree-Sitter** (the `struct-strm` library): Tree-Sitter is an incremental parser designed for IDEs; it handles incomplete/partially-correct input gracefully. The `struct-strm` library wraps LLM streams and uses tree-sitter-json to parse JSON incrementally as tokens arrive, at ~0.5ms per parse operation. This enables:
- Rendering UI placeholders immediately as keys appear
- Triggering cascading operations mid-stream (e.g., starting a downstream fetch as soon as `url` field is parsed)
- Early-stop on schema violations without waiting for full response
- Reported improvement: first-paint latency from 30 seconds → ~1 second for complex UI elements

**Alternative: custom accumulation + partial parsing**: Accumulate the JSON string, attempt incremental parse after each chunk, catch and ignore parse errors until the structure closes. Works for simple use cases, brittle for complex nesting.

---

## 3. Multi-Model Streaming Aggregation

### 3.1 Sequential Chaining

The simplest pattern: model A streams → collect output → model B streams using A's output as context. No aggregation complexity; streaming happens independently per step. The challenge is that intermediate steps block pipeline progress.

**LangGraph implementation**: Define a graph where each node is an LLM call; use `stream_mode="messages"` to stream tokens from the currently-executing node. The framework emits `AgentUpdatedStreamEvent` when transitioning between nodes.

**Optimization**: Display tokens from each step incrementally while chaining. Do not wait for step N to fully complete before starting to display step N+1's tokens—pipeline the display.

### 3.2 Parallel Fan-Out with Merge

All sub-agents run concurrently; results are aggregated by a coordinating agent or logic layer.

**AWS scatter-gather pattern**:
1. Coordinator publishes subtasks to SNS topic
2. Worker Lambdas process independently (each may call different models)
3. Results written to shared store (SQS, S3, DynamoDB)
4. Aggregator waits for all workers (via polling or events), merges outputs

**Streaming challenge**: In true parallel streaming, each model generates tokens at its own pace. Naive approaches wait for all to complete before displaying (defeating streaming's purpose). Advanced approaches:
- **Priority-first display**: Stream tokens from the model expected to finish first; use others' results to augment the final answer
- **Progressive disclosure**: Display model 1's stream immediately; append model 2's results as they arrive
- **Consensus streaming** (used in duh/multi-model consensus engines): Stream challengers' tokens in real-time via WebSocket as each finishes, without batching for others

**Python asyncio fan-out pattern**:
```python
async def fan_out_stream(prompt: str, models: list[str]):
    tasks = [asyncio.create_task(stream_model(prompt, m)) for m in models]
    # Stream first completion immediately
    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for task in done:
        async for token in task.result():
            yield token
    # Gather remaining for aggregation
    remaining = await asyncio.gather(*pending)
    yield synthesize(remaining)
```

### 3.3 Priority-Based Model Selection with Streaming Fallback

Route to primary model; if TTFT exceeds threshold, fall back to faster secondary model and stream from there.

Implementation pattern:
1. Launch both primary and secondary model requests simultaneously
2. Race them with a timeout (e.g., 500ms)
3. If primary produces a token first, cancel secondary and stream primary
4. If secondary wins the race (or primary exceeds timeout), cancel primary, stream secondary, note the degradation

**Circuit breaker integration**: Track failure rate per model. After N failures within window W, open the circuit and route directly to fallback without attempting primary. Prevents timeout storms in degraded conditions.

### 3.4 Google ADK Bidirectional Multi-Agent Streaming

Google's Agent Development Kit introduces `LiveRequestQueue` as a core abstraction for multi-modal streaming agents. The queue:
- Accepts `text`, `audio`, and video blobs asynchronously
- Decouples input reception from LLM processing
- Enables simultaneous user inputs with model streaming outputs

Tools are implemented as `AsyncGenerator` primitives that yield multiple results over time and access the `LiveRequestQueue` for direct user input streams. This enables streaming-native tool behavior where the tool itself generates incremental updates during long-running operations.

---

## 4. Buffering and Backpressure Strategies

### 4.1 Backpressure Fundamentals

Backpressure occurs when the model generates tokens faster than the network can deliver them or the client can consume them. Without backpressure management, intermediate buffers fill up, memory spikes, and frames are eventually dropped.

**Node.js HTTP response backpressure**:
```javascript
async function streamTokens(res, tokenStream) {
  for await (const token of tokenStream) {
    const data = `data: ${JSON.stringify({delta: token})}\n\n`;
    const canContinue = res.write(data);
    if (!canContinue) {
      // Buffer full — wait for drain before writing more
      await new Promise(resolve => res.once('drain', resolve));
    }
  }
  res.end();
}
```

**WebSocket backpressure**:
```javascript
if (ws.bufferedAmount > MAX_BUFFER) {
  await new Promise(resolve => setTimeout(resolve, 10)); // yield
}
ws.send(token);
```

### 4.2 Buffer Strategies

| Strategy | Description | Best for |
|----------|-------------|---------|
| Bounded buffer + drain wait | Fixed-size write buffer; block on full | Standard SSE/HTTP streams |
| Token window flushing | Flush every N tokens OR T ms | Balancing throughput vs latency |
| Drop policy | Discard for consistently slow clients | High-volume, non-critical streams |
| Dynamic chunk sizing | Larger chunks under load, smaller when idle | Adaptive network conditions |

**Heartbeat pattern** (prevents timeout-triggered disconnections during long thinking/tool-call pauses):
```javascript
const heartbeat = setInterval(() => {
  res.write(': heartbeat\n\n'); // SSE comment line, ignored by parser
}, 15000);
req.on('close', () => clearInterval(heartbeat));
```

### 4.3 Tool Call Buffering

When a model invokes a tool, the stream enters a transitional state: the model has stopped generating text tokens and is waiting for tool execution results. This creates a gap where no tokens flow to the client, which can cause the client to believe the connection has stalled.

**Anthropic's lifecycle for tool use**:
```
content_block_start (type: tool_use)
→ content_block_delta (input_json_delta events stream the arguments)
→ content_block_stop
→ message_delta (stop_reason: "tool_use")
→ message_stop
[Client must now execute tool and submit a new message]
→ [New stream starts for model's response to tool result]
```

**Client-side implementation**: On `stop_reason: "tool_use"`, the client must:
1. Accumulate all `input_json_delta` strings for each tool_use block
2. Execute the tools (potentially concurrently for multiple tool calls)
3. Submit a new message with `tool_result` content blocks
4. Open a new stream

During tool execution, display a progress indicator to the user. The "pause" in streaming is expected and can be 100ms–several seconds.

**Buffering for partial JSON accumulation**: Never attempt JSON.parse() on accumulated `partial_json` strings until `content_block_stop`. Use try/catch for defensive partial parsing in UI contexts only.

### 4.4 Reconnection and Resume

SSE's `id:` field enables cursor-based resume. Server tracks the last event ID sent per session:

```
id: evt-0042
event: content_block_delta
data: {"index":0,"delta":{"type":"text_delta","text":"Hello"}}
```

On reconnection, the client sends `Last-Event-ID: evt-0042`. The server resumes from that point.

**Limitation**: LLM responses cannot be cheaply resumed from an arbitrary token position (the model has already generated and potentially discarded intermediate KV cache states). In practice:
- For short responses: re-generate from scratch on reconnection (most providers)
- For long responses: buffer the full generated text server-side and replay from the last event ID
- For agent sessions: use session IDs (Anthropic Agent SDK v2 `resumeSession()`) which replay from stored session state

**Exponential backoff for reconnection**:
```javascript
const delays = [1000, 2000, 4000, 8000, 16000];
let attempt = 0;
function reconnect() {
  const delay = delays[Math.min(attempt++, delays.length - 1)];
  setTimeout(connectSSE, delay);
}
```

---

## 5. Streaming in Agent Runtimes

### 5.1 Anthropic SDK Architecture

The TypeScript SDK's streaming pipeline: `Response.body (byte chunks)` → `LineDecoder` (buffers into complete lines) → `SSEDecoder` (accumulates `event:` and `data:` fields into structured messages) → `Stream<MessageStreamEvent>` (async iterable with JSON parsing) → `MessageStream` (high-level helper with event emitters).

**Two levels of streaming access**:

Low-level (raw events):
```typescript
const stream = client.messages.stream({ stream: true, ... });
for await (const event of stream) {
  // Typed MessageStreamEvent objects
}
```

High-level (convenience helpers):
```typescript
const stream = client.messages.stream({ ... });
stream.on('text', (text) => process.stdout.write(text));
stream.on('thinking', (thinking) => { /* handle thinking block */ });
const finalMessage = await stream.finalMessage(); // accumulates all events
```

**Agent SDK V2 (unstable preview)**: Separates send/stream into distinct steps, enabling logic between turns:
```typescript
await using session = unstable_v2_createSession({ model: "claude-opus-4-6" });
await session.send("Hello!");
for await (const msg of session.stream()) {
  if (msg.type === "assistant") {
    // render tokens
  }
}
// Session carries context automatically across turns
await session.send("Follow-up question");
for await (const msg of session.stream()) { /* ... */ }
```

`resumeSession(sessionId)` enables persistence across restarts.

### 5.2 LangChain/LangGraph Streaming

LangGraph provides three streaming modes:

1. **`stream_mode="messages"`**: Token-by-token from any LLM node as `(token, metadata)` tuples. `metadata["langgraph_node"]` identifies the source node. Tool arguments stream as `tool_call_chunk` content blocks with partial JSON strings.

2. **`stream_mode="updates"`**: Full state diff after each agent step. Higher-level; shows what changed after a node executed (including completed tool calls).

3. **`stream_mode="custom"`**: User-defined signals via `get_stream_writer()`. Enables tools to emit progress:
   ```python
   writer = get_stream_writer()
   for i in range(100):
       writer({"progress": f"Fetched {i+1}/100 records"})
   ```

**Multi-mode**: `stream_mode=["messages", "updates"]` emits both token-level and step-level events in the same stream, each with a `type` discriminator.

**Reasoning token streaming**: Filter for `type: "reasoning"` content blocks:
```python
for token, metadata in agent.stream(input, stream_mode="messages"):
    reasoning = [b for b in token.content_blocks if b["type"] == "reasoning"]
```

### 5.3 OpenAI Agents SDK Streaming

Three event categories:
- `RawResponsesStreamEvent`: Raw API events (`response.output_text.delta` etc.)
- `RunItemStreamEvent`: Higher-level completion events (`tool_called`, `handoff_requested`, `reasoning_item_created`, `mcp_approval_requested`)
- `AgentUpdatedStreamEvent`: Fires when agent handoffs occur

```python
async with Runner.run_streamed(agent, input) as result:
    async for event in result.stream_events():
        if isinstance(event, RawResponsesStreamEvent):
            if event.data.type == "response.output_text.delta":
                print(event.data.delta, end="", flush=True)
```

The stream is not complete until the iterator ends. Interrupted runs (tool approval required) expose `result.interruptions`.

### 5.4 vLLM Streaming Architecture

vLLM's async engine (`AsyncLLM`) uses asyncio queues:
- `outputs_queue`: receives computed tokens from engine core
- `process_outputs_socket` task: communicates between engine worker processes
- `output_handler` task: propagates tokens to the FastAPI/OpenAI-compatible endpoint

The OpenAI-compatible endpoint sets `Content-Type: text/event-stream; charset=utf-8` and `Transfer-Encoding: chunked`, delivering tokens via standard SSE format.

**Continuous batching interaction with streaming**: The scheduler runs iteration-level scheduling. Each `step()` call processes the current batch and emits the new token for each sequence. Streaming clients receive each token as soon as its step completes—no artificial batching delay. The step includes: schedule → forward pass → postprocessing (token append, stop check) → push to output queues → flush to SSE endpoint.

### 5.5 Terminal Rendering

Claude Code, Codex CLI, and similar terminal agents use incremental write to stdout:
```python
print(text, end="", flush=True)  # Python
process.stdout.write(delta)       # Node.js
```

For progress indicators (file operations, tool calls), agents use ANSI control codes to overwrite the current line:
- `\r` (carriage return) resets cursor to line start for in-place updates
- `\033[2K` clears the current line
- Rich/Ink libraries provide higher-level terminal rendering with streaming support

Cursor IDE (VS Code fork) uses the extension host architecture to pipe streaming tokens directly into the editor buffer via LSP/custom protocol. Each chunk triggers an editor diff update, making code appear to "type itself" in real-time.

---

## 6. Cost and Latency Optimization

### 6.1 Streaming vs Non-Streaming: Billing

**Streaming and non-streaming are billed identically.** Both Anthropic and OpenAI charge per input and output token; the delivery mechanism does not affect cost. The choice between streaming and non-streaming is purely a UX and implementation decision.

| Model | Input ($/M tokens) | Output ($/M tokens) |
|-------|-------------------|-------------------|
| Claude Opus 4.6 | $5.00 | $25.00 |
| Claude Sonnet 4.6 | $3.00 | $15.00 |
| Claude Haiku 4.5 | $1.00 | $5.00 |
| GPT-5.2 | $1.75 | $14.00 |
| GPT-5 mini | $0.25 | $2.00 |

**Cache pricing (Anthropic)**: Cache reads cost $0.30/M tokens vs $3.00/M for fresh tokens—a 90% discount. This is the most impactful cost lever for agents with large repeated system prompts.

### 6.2 TTFT Optimization

**Time-to-First-Token** is the delay from request submission to the first streaming token arriving. It is dominated by the prefill phase (processing the input sequence).

**Key techniques in 2025–2026**:

1. **Prompt caching / KV cache reuse**: The most impactful optimization for agent workloads. Cache the KV matrices for the system prompt + static context. On cache hit, prefill is skipped for the cached prefix. Anthropic: up to 85% latency reduction for long prompts; cache entries held for 5–10 minutes (automatic) or explicitly controlled. OpenAI GPT-5.1+ series: automatic 24-hour cache retention with KV tensors offloaded to GPU-local SSDs.

2. **Prefill-decode disaggregation**: Separate cluster of GPUs handles prefill (compute-bound); another handles decode (memory-bandwidth-bound). Since prefill determines TTFT and decode determines inter-token latency (ITL), optimizing them independently yields major gains. In production (Meta, LinkedIn, DeepSeek-V3, Kimi/Mooncake), P/D disaggregation is now standard. Performance: SGLang on 96 H100s with P/D disagg: 52.3k input tokens/s and 22.3k output tokens/s per node.

3. **Speculative decoding**: A lightweight draft model proposes N tokens; the target model verifies them in a single forward pass. Verified tokens are accepted; rejected tokens are resampled from the target distribution. No quality loss with correct rejection sampling. Key metrics:
   - Token acceptance rate α: higher α → fewer target model passes → lower latency
   - EAGLE-3 (2025): attached autoregressive prediction head on target model's internal layers; no separate draft model needed; 2.8x–5.8x wall-time speedup
   - Mirror-SD: 30% average relative improvement over EAGLE-3
   - Production: NVIDIA H200 shows 3.6x throughput improvement; vLLM and TensorRT-LLM include native support

4. **LayerKV cache management**: Proactive offloading of non-critical KV cache layers to CPU memory. Achieves up to 69x average TTFT reduction for memory-contended scenarios.

5. **TokenFlow (buffer-aware scheduling)**: Frames streaming like video delivery—generate slightly faster than consumption rate with a token buffer; dynamic preemption during bursts. Reported results: 82.5% higher effective throughput, 80.2% lower P99 TTFT.

### 6.3 TTFT vs Total Generation Time

For streaming applications, TTFT matters more than total generation time from a UX perspective. Users tolerate longer total generation if the first token appears quickly (perceived responsiveness). A model taking 10s total with 200ms TTFT feels faster than a model taking 4s total with 3s TTFT.

Typical production TTFT values:
| Scenario | TTFT |
|----------|------|
| Cloud API, short prompt, no cache | 300–500ms |
| Cloud API, long system prompt, cache hit | 50–150ms |
| Self-hosted vLLM, small model | 100–300ms |
| Self-hosted vLLM, large model (70B+) | 500–2000ms |
| Self-hosted, P/D disaggregated | 50–200ms |

### 6.4 Streaming with Caching

Cache-warmed requests stream faster not only because TTFT drops (prefill skipped), but because the decode phase starts immediately from the cache hit rather than after full prefill computation. The effect is multiplicative for prompts with large cached prefixes.

**Critical for agent loops**: System prompts, tool schemas, and retrieved context (RAG) are ideal candidates for caching. Structure prompts as: `[static system prompt + static tools] + [dynamic retrieved context] + [conversation history]`—keeping the stable prefix as long as possible to maximize cache hit rate.

---

## 7. Production Patterns

### 7.1 Nginx Configuration

Default Nginx behavior buffers upstream responses before forwarding to clients. This must be disabled for SSE/streaming to work:

```nginx
upstream llm_backend {
  server localhost:8000;
  keepalive 32;  # maintain 32 idle keepalive connections
}

server {
  location /v1/ {
    proxy_pass http://llm_backend;
    proxy_http_version 1.1;

    # CRITICAL: disable buffering for streaming
    proxy_buffering off;
    proxy_cache off;

    # Required for HTTP/1.1 keepalive and chunked encoding
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Accel-Buffering no;

    # Extended timeouts for long-running generations
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_connect_timeout 10s;

    # WebSocket upgrade headers (if needed)
    proxy_set_header Upgrade $http_upgrade;
    # proxy_set_header Connection $connection_upgrade;  # only for WebSocket
  }
}
```

**`proxy_buffering off`** is the single most critical directive. Without it, clients receive no tokens until Nginx's buffer fills or the response completes. Also set `X-Accel-Buffering: no` in the response header from the application for defense-in-depth.

### 7.2 Caddy Configuration

```caddy
reverse_proxy /v1/* localhost:8000 {
  flush_interval -1  # CRITICAL: immediate flush for SSE

  transport http {
    compression off          # never compress streaming responses
    response_header_timeout 10m
    dial_timeout 10s
    keepalive 2m
  }

  header_up Host localhost:8000
}
```

`flush_interval -1` tells Caddy to flush immediately rather than buffering. Without it, streaming does not work. Caddy's default keepalive duration of 2 minutes may cause "connection reset by peer" if the upstream's keepalive timeout is shorter; align both.

### 7.3 CDN Considerations

CDNs are problematic for streaming. Default behavior caches and buffers responses.

**Cloudflare**:
- Default idle timeout for client connections: 400 seconds
- Proxy Read Timeout for requests >100s: requires Enterprise plan
- HTTP/2 connection pooling: Cloudflare pools many requests into fewer TCP connections to origin, keeping up to 900 seconds of idle connection before closing
- SSE connections count against concurrent connection limits; verify limits for your plan

**CloudFront**:
- Default origin read timeout: 30–60 seconds. For LLM streaming, this is almost certainly too short
- Setting `origin_read_timeout = 300` requires a quota increase request to AWS Support
- Default keep-alive: 5 seconds; maximum configurable: 60 seconds
- For Kubernetes stacks, the full timeout chain must be aligned: CloudFront (300s) → ALB (300s) → Nginx ingress (300s)

```hcl
# Terraform: CloudFront origin settings for LLM streaming
origin_read_timeout    = 300
origin_keepalive_timeout = 60
```

```yaml
# Kubernetes ALB annotation
alb.ingress.kubernetes.io/load-balancer-attributes: idle_timeout.timeout_seconds=300
```

**Recommendation**: For production LLM streaming behind a CDN, use Cloudflare or AWS CloudFront with carefully tuned timeouts, and consider whether the CDN adds meaningful value for streaming endpoints (it does not provide caching benefits; the primary value is DDoS protection and edge termination).

### 7.4 Connection Pooling

For high-throughput agent systems making many LLM calls:

- Maintain persistent connections to the LLM backend using HTTP keepalive
- HTTP/2 connection pooling (gRPC or HTTP/2-native clients) multiplexes concurrent requests over one connection
- For REST/SSE over HTTP/1.1: use connection pools sized to expected concurrency (Nginx `keepalive 32` for 32 idle connections)
- Monitor connection reuse ratios; a low ratio indicates pool exhaustion or misconfigured keepalive

### 7.5 Rate Limiting and Resilience for Streaming

LLM provider rate limits operate on tokens (TPM) and requests (RPM). Streaming requests count against both limits identically to non-streaming.

**Layered resilience pattern**:

1. **Retries with exponential backoff**: For 429 (rate limit) and 5xx responses; use delays of 1s, 2s, 4s, 8s. Do not retry on 4xx client errors.

2. **Circuit breaker**: After N consecutive failures within window W, stop sending requests to the failing provider and immediately route to fallback. Avoids retry storms. Reset after a configurable recovery period.

3. **Streaming-specific considerations**:
   - Mid-stream failures (connection reset after some tokens delivered) cannot be cleanly retried without re-generating from scratch or maintaining a server-side buffer of sent content
   - Detect mid-stream failure by checking if `message_stop` (Anthropic) or `[DONE]` (OpenAI) was received; if connection closes without it, the stream was interrupted
   - For critical workflows, buffer all streamed tokens server-side and expose a replay endpoint

4. **Model fallback during streaming**: If you receive an error *before* the first token (TTFT), fall back transparently. If the error occurs *mid-stream*, you must decide: show partial response + error indicator, or silently re-generate from a fallback model. The latter requires discarding the partial response and re-rendering, which is jarring. Prefer showing partial + error.

### 7.6 Observability for Streaming

Key metrics to track:

| Metric | Description | Alert threshold |
|--------|-------------|-----------------|
| TTFT (p50/p95/p99) | Time from request to first token | p99 > 2s (tune per model) |
| Inter-Token Latency (ITL) | Time between consecutive tokens | p99 > 200ms |
| Stream completion rate | % of streams that end with `message_stop` | < 99% |
| Stream duration | Wall time from request to final token | Histogram |
| Connection reset rate | Streams closed without proper termination | > 0.5% |
| Cache hit rate | % of requests hitting prompt cache | Track trend |

Prometheus implementation:
```javascript
const ttftHistogram = new Histogram({
  name: 'llm_ttft_seconds',
  help: 'Time to first token',
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10]
});
const streamCompletionCounter = new Counter({
  name: 'llm_stream_completions_total',
  labelNames: ['status'] // 'complete', 'interrupted', 'error'
});
```

### 7.7 Emerging Standards: MCP and A2A

Both new agent interoperability protocols use SSE for streaming:

**Model Context Protocol (MCP)** (Anthropic, donated to Linux Foundation AAIF December 2025): uses JSON-RPC 2.0 over stdio or SSE. As of February 2026: 97M monthly SDK downloads; adopted by all major AI providers.

**Agent-to-Agent Protocol (A2A)** (Google, April 2025; donated to Linux Foundation June 2025): uses HTTP + JSON-RPC + SSE. When streaming is required between agents, SSE provides the transport for partial Artifact delivery and live status updates during long-running tasks.

Both protocols being SSE-based signals that SSE will remain the standard streaming transport for agent-to-agent and tool-to-agent communication for the foreseeable future.

---

## Data Points

| Metric | Value | Source | Confidence |
|--------|-------|--------|------------|
| gRPC vs REST connection overhead | 40–60% reduction | Medium/Hannecke | Medium |
| gRPC throughput vs REST | 40–60% higher RPS | Medium/Hannecke | Medium |
| gRPC streaming latency vs REST | 25–35% lower | Medium/Hannecke | Medium |
| Protobuf vs JSON payload size | 3–7x smaller | Multiple | High |
| Protobuf vs JSON parse speed | 5–10x faster | Multiple | High |
| Anthropic cache latency reduction | Up to 85% for long prompts | Anthropic docs | High |
| Anthropic cache pricing | $0.30/M (hit) vs $3.00/M (fresh) | Anthropic docs | High |
| OpenAI cache retention (GPT-5.1+) | 24 hours | PromptHub | Medium |
| LayerKV TTFT reduction | Up to 69x average | emergentmind | Medium |
| TokenFlow TTFT improvement | 80.2% lower P99 | Medium/QuarkAndCode | Medium |
| TokenFlow throughput improvement | 82.5% higher | Medium/QuarkAndCode | Medium |
| EAGLE-3 speedup | 2.8x–5.8x wall-time | Apple ML Research | High |
| Mirror-SD vs EAGLE-3 | 30% relative improvement | Apple ML Research | High |
| NVIDIA H200 speculative decoding | 3.6x throughput | NVIDIA | High |
| vLLM continuous batching vs static | 2–5x throughput improvement | Multiple | High |
| vLLM prefix caching + batching | 5x throughput, 1–2s lower latency | Medium/Ammarab | Medium |
| HTTP/3 vs HTTP/2 performance | ~47% improvement | DebugBear | Medium |
| HTTP/3 global adoption | ~35% (Oct 2025) | Cloudflare | High |
| CloudFront default timeout | 30–60 seconds | AWS docs | High |
| CloudFront max configurable timeout | 300 seconds (with support request) | AWS/release.com | High |
| MCP monthly SDK downloads | 97M (Feb 2026) | Multiple | High |
| Tree-Sitter incremental parse latency | ~0.5ms per operation | Medium/Blackburn | Medium |
| struct-strm first-paint improvement | 30s → ~1s | Medium/Blackburn | Medium |

---

## Contradictions and Open Questions

- **gRPC vs SSE for LLM**: The "REST to gRPC" migration article claims 25–35% streaming latency reduction and 40–60% throughput gain. However, the panel discussion and SSE advocacy articles note that SSE over HTTP/2 achieves similar multiplexing benefits to gRPC without the operational overhead. The truth is workload-dependent: gRPC wins for high-frequency small-message traffic (>1000 RPM); SSE wins for browser-facing and simpler deployments.

- **Mid-stream failure handling**: No sources provide authoritative guidance on handling provider-side mid-stream failures (connection drops after N tokens). Industry practice appears to be: accept partial responses in UI contexts; retry from scratch in agent pipeline contexts. This is an open area for standardization.

- **WebTransport timeline**: Sources agree WebTransport is the long-term WebSocket replacement but disagree on the timeline. "2–3 years" is the consensus estimate for production viability, but this may shift rapidly if a major browser/server ships production support.

- **Speculative decoding quality**: While quality neutrality is guaranteed by the rejection sampling mathematics, some practitioner sources note subtle distribution shifts for very long outputs. The theoretical guarantee holds for independent token generation; auto-regressive dependencies across long sequences may introduce minor distributional drift not captured in short-benchmark evaluations.

---

## Sources

- [Streaming Messages — Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Streaming API Reference (Anthropic)](https://docs.anthropic.com/en/api/messages-streaming)
- [Building with Extended Thinking — Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
- [TypeScript SDK V2 Interface (Preview)](https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview)
- [Comparing the streaming response structure for different LLM APIs (Percolation Labs/Medium)](https://medium.com/percolation-labs/comparing-the-streaming-response-structure-for-different-llm-apis-2b8645028b41)
- [How streaming LLM APIs work — Simon Willison's TILs](https://til.simonwillison.net/llms/streaming-llm-apis)
- [SSE's Glorious Comeback: Why 2025 is the Year of Server-Sent Events](https://portalzine.de/sses-glorious-comeback-why-2025-is-the-year-of-server-sent-events/)
- [Streaming LLM Responses at Scale — Dani Akabani/Medium](https://medium.com/@daniakabani/how-we-used-sse-to-stream-llm-responses-at-scale-fa0d30a6773f)
- [The Complete Guide to Streaming LLM Responses in Web Applications (Dev.to)](https://dev.to/pockit_tools/the-complete-guide-to-streaming-llm-responses-in-web-applications-from-sse-to-real-time-ui-3534)
- [Streaming at Scale: SSE, WebSockets & Designing Real-Time AI APIs](https://learnwithparam.com/blog/streaming-at-scale-sse-websockets-real-time-ai-apis)
- [SSE for LLM Apps: SSE vs WebSockets (Hivenet)](https://compute.hivenet.com/post/llm-streaming-sse-websockets)
- [The Streaming Backbone of LLMs: Why SSE Still Wins in 2026 (Procedure Tech)](https://procedure.tech/blogs/the-streaming-backbone-of-llms-why-server-sent-events-(sse)-still-wins-in-2025)
- [Streaming AI Responses with WebSockets, SSE, and gRPC (Medium)](https://medium.com/@pranavprakash4777/streaming-ai-responses-with-websockets-sse-and-grpc-which-one-wins-a481cab403d3)
- [AI's Real-Time Engine: gRPC, WebSockets, or SSE? — GRPCConf India](https://tldrecap.tech/posts/2025/grpconf-india/ai-protocols-hybrid-approach/)
- [HTTP vs. WebSockets vs. gRPC for AI Model Inference (Baseten)](https://www.baseten.co/blog/http-vs-websockets-vs-grpc/)
- [Scaling LLM Inference: From REST to gRPC (Medium/Hannecke)](https://medium.com/@michael.hannecke/scaling-llm-inference-from-rest-to-grpc-to-gain-performance-in-production-0190b0469f4c)
- [Beyond Request-Response: Architecting Real-Time Bidirectional Streaming Multi-Agent System (Google Developers Blog)](https://developers.googleblog.com/en/beyond-request-response-architecting-real-time-bidirectional-streaming-multi-agent-system/)
- [Parallelization and Scatter-Gather Patterns (AWS Prescriptive Guidance)](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-patterns/parallelization-and-scatter-gather-patterns.html)
- [Streaming — LangChain Docs](https://docs.langchain.com/oss/python/langchain/streaming/overview)
- [Streaming — OpenAI Agents SDK](https://openai.github.io/openai-agents-python/streaming/)
- [Streaming Examples — anthropic-sdk-typescript (DeepWiki)](https://deepwiki.com/anthropics/anthropic-sdk-typescript/7.1-streaming-examples)
- [Inside vLLM: Anatomy of a High-Throughput LLM Inference System](https://vllm.ai/blog/anatomy-of-vllm)
- [Streaming Requests & Realtime API in vLLM (vLLM Blog)](https://vllm.ai/blog/streaming-realtime)
- [Structured Output Streaming for LLMs — Preston Blackburn/Medium](https://medium.com/@prestonblckbrn/structured-output-streaming-for-llms-a836fc0d35a2)
- [vLLM Continuous Batching (Johal.in)](https://www.johal.in/vllm-continuous-batching-high-throughput-serving-for-long-contexts-2025/)
- [Prefill-Decode Disaggregation — BentoML LLM Handbook](https://bentoml.com/llm/inference-optimization/prefill-decode-disaggregation)
- [Disaggregated Inference: 18 Months Later (Hao AI Lab @ UCSD)](https://haoailab.com/blogs/distserve-retro/)
- [Speculative Decoding — BentoML LLM Handbook](https://bentoml.com/llm/inference-optimization/speculative-decoding)
- [Speculative Streaming — Apple ML Research](https://machinelearning.apple.com/research/llm-inference)
- [Mirror Speculative Decoding — Apple ML Research](https://machinelearning.apple.com/research/mirror)
- [Speculative Decoding — vLLM Docs](https://docs.vllm.ai/en/latest/features/spec_decode/)
- [LLM Streaming Latency: Cut TTFT, Smooth Tokens (Medium/QuarkAndCode)](https://medium.com/@QuarkAndCode/llm-streaming-latency-cut-ttft-smooth-tokens-fix-cold-starts-f2be60d26b89)
- [Prompt Caching Infrastructure — Introl](https://introl.com/blog/prompt-caching-infrastructure-llm-cost-latency-reduction-guide-2025)
- [Prompt Caching with OpenAI, Anthropic, and Google (PromptHub)](https://www.prompthub.us/blog/prompt-caching-with-openai-anthropic-and-google-models)
- [Ollama Behind Reverse Proxy with Caddy or Nginx (Glukhov.org)](https://www.glukhov.org/llm-hosting/ollama/ollama-behind-reverse-proxy/)
- [NGINX Reverse Proxy for Ollama/vLLM (getpagespeed.com)](https://www.getpagespeed.com/server-setup/nginx/nginx-reverse-proxy-ollama-vllm)
- [Configuring 5-Minute Timeout in CloudFront → ALB → Nginx (release.com)](https://release.com/blog/configuring-5-minute-timeout-cloudfront-alb-nginx-ingress)
- [Cloudflare Connection Limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/)
- [Retries, Fallbacks, and Circuit Breakers in LLM Apps (Portkey.ai)](https://portkey.ai/blog/retries-fallbacks-and-circuit-breakers-in-llm-apps/), [getmaxim.ai](https://www.getmaxim.ai/articles/retries-fallbacks-and-circuit-breakers-in-llm-apps-a-production-guide/)
- [MCP vs A2A: Complete Guide to AI Agent Protocols in 2026 (Dev.to)](https://dev.to/pockit_tools/mcp-vs-a2a-the-complete-guide-to-ai-agent-protocols-in-2026-30li)
- [What Is Agent2Agent (A2A) Protocol? (IBM)](https://www.ibm.com/think/topics/agent2agent-protocol)
- [SSE Deep Dive (Agent Factory)](https://agentfactory.panaversity.org/docs/TypeScript-Language-Realtime-Interaction/async-patterns-streaming/server-sent-events-deep-dive)
- [Google Gemini Streaming API Reference](https://ai.google.dev/api/generate-content)
- [Gemini API streamGenerateContent (Apidog)](https://gemini-api.apidog.io/api-16240702)

---

## Methodology

- Research angles: streaming protocols & transport, token delivery patterns, multi-model aggregation, buffering/backpressure, agent runtimes, cost/latency optimization, production patterns
- Web searches conducted: 18
- Pages fetched: 24
- Sources consulted: 45+
- Date of research: 2026-03-27
