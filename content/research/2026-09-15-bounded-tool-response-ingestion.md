---
date: "2026-09-15"
time: "09:05"
title: "Bounded Response Ingestion for AI Agents"
description: "Why token limits do not protect HTTP readers, and how to bound decompression, parsing, and incomplete tool results before they enter an agent's context."
tags: ["ai-agents", "http", "streaming", "resource-limits", "security", "python"]
---

## Executive Summary

An agent can receive a short tool result only after its runtime has downloaded, decompressed, decoded, and parsed a much larger response. Trimming the final text protects the model's context budget, but leaves every earlier allocation exposed. A safe reader needs limits at the transformations where size changes, plus an explicit rule for what a partial result means.

This article develops a response-ingestion design for agent tool adapters. Its core recommendation is to count encoded bytes before decompression, decoded bytes during decompression, and parser growth before constructing an unrestricted object graph. Streaming and backpressure help control flow; neither independently bounds total work. A small Python exercise demonstrates a decoded-byte ceiling and rejection of truncated gzip input. The design recommendations are engineering synthesis, not guarantees supplied by HTTP or a particular SDK.

## Follow one response through its transformations

Imagine a retrieval tool returning compressed JSON. The HTTP body is small enough to pass a header check. Decompression produces a large JSON string. Parsing creates strings, arrays, and dictionaries. The adapter extracts a few fields and returns a short answer to the model. By the time the final token counter runs, the expensive part has already happened.

There are at least five quantities to keep separate:

| Boundary | Quantity to bound | What it protects |
|---|---|---|
| Content reader | Encoded body bytes actually read | Input volume before decoding |
| Decompressor | Total decoded bytes produced | Compression amplification |
| Text decoder and parser | Buffered text, record size, depth, object growth | Intermediate representation growth |
| Tool-result builder | Retained fields and rendered output | Adapter memory and output size |
| Model context | Tokens in the accepted result | Context capacity and model cost |

Here, “encoded bytes” means content after HTTP transfer framing is removed but before content decoding. It does not mean all network traffic: TLS records, HTTP headers, and framing need separate transport controls if those resources matter.

RFC 9110 defines content coding as a transformation of representation data. `Content-Length` describes content length in octets; it is not a promise about decompressed size. Content can also arrive without that field. Use a declared excessive length for an early rejection, but enforce the ceiling against bytes actually observed. Support only the content codings the reader is designed to handle, and decode stacked codings in the appropriate reverse order. [RFC 9110 §§8.4–8.6](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.4)

The proposed policy for our example is deliberately narrow: accept identity encoding or one gzip coding, with separate encoded and decoded ceilings. Reject unfamiliar or stacked codings explicitly. Broader compatibility is possible, but every additional decoding stage needs its own bounded behavior; limiting only the final output can miss a large intermediate expansion.

## Put enforcement before the large allocation

A pattern such as `read_all(); decompress(); slice()` cannot enforce an ingestion memory ceiling. It discovers excess after paying for it. Even `for chunk in stream` can hide the same problem if a decoder constructs an enormous output chunk before the loop sees it.

Check which representation the HTTP API exposes. Fetch's HTTP processing includes handling content codings, so an application's response stream can sit downstream of decompression. A counter attached there is a decoded-body counter, not evidence that compressed input was measured. Inspect the actual client and version; an adapter may need a lower-level body interface to own both boundaries. [Fetch Standard, HTTP-network fetch](https://fetch.spec.whatwg.org/#http-network-fetch)

Backpressure solves a different problem: coordinating producers and consumers. Node documents `highWaterMark` as a buffering threshold rather than a strict memory ceiling; transform streams also have readable and writable buffers. A pipeline can honor backpressure while processing unlimited bytes over time, and one permitted chunk can exceed the threshold. [Node.js stream buffering](https://nodejs.org/api/stream.html#buffering)

For an agent service, I would combine per-response ceilings with a concurrency limit and a shared capacity budget. Ten individually acceptable responses may still overwhelm a worker when their parsers and output buffers coexist. Account for temporary copies, decoder state, library queues, and retained objects when sizing the process. A decoded-byte cap is a useful invariant, not a claim that resident memory equals that cap.

Compression-ratio alarms can supplement this design, but a universal safe ratio would be misleading. Legitimate repetitive content compresses very well; ratios also behave awkwardly near the beginning of a stream. Choose an absolute decoded limit first. Add elapsed-time and CPU controls where needed: a byte counter alone cannot stop a slow sender or interrupt a long synchronous decoder call.

## A small bounded gzip exercise

The following Python standard-library example accepts exactly one complete gzip member. It returns the complete bytes only after validation, never a partial prefix. Save the whole block as a Python file and run it locally; fixtures stay small and make no network requests.

Python's `zlib` API exposes a maximum output length for each decompression call, retained unconsumed input, and an `eof` flag that distinguishes completion from truncation. The special value `max_length=0` removes the output restriction. The extra byte below detects overflow while avoiding that trap when the remaining budget is zero. `flush(length)` is not a substitute: its argument sets an initial buffer size, not a maximum output size. [Python zlib documentation](https://docs.python.org/3/library/zlib.html)

```python
import gzip
import zlib

class Rejected(ValueError):
    pass

def read_gzip(chunks, encoded_limit=65536, decoded_limit=8192):
    """Accept exactly one complete gzip member; return no partial result."""
    if encoded_limit < 0 or decoded_limit < 0:
        raise ValueError("limits must be non-negative")
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
    encoded = 0
    result = bytearray()
    for chunk in chunks:
        encoded += len(chunk)
        if encoded > encoded_limit:
            raise Rejected("encoded_limit")
        if decoder.eof and chunk:
            raise Rejected("trailing_data")
        pending = chunk
        while pending:
            # +1 detects overflow and avoids max_length=0 (unlimited).
            remaining = decoded_limit - len(result)
            part = decoder.decompress(pending, remaining + 1)
            if len(part) > remaining:
                raise Rejected("decoded_limit")
            result.extend(part)
            if decoder.unused_data:
                raise Rejected("trailing_data")
            pending = decoder.unconsumed_tail
    if not decoder.eof:
        raise Rejected("incomplete_gzip")
    return bytes(result)

def pieces(data):
    return (data[i:i + 7] for i in range(0, len(data), 7))

normal = gzip.compress(b"hello", mtime=0)
assert read_gzip(pieces(normal), decoded_limit=5) == b"hello"
assert read_gzip(pieces(gzip.compress(b"", mtime=0)), decoded_limit=0) == b""
for data, limit, reason in [
    (gzip.compress(b"x" * 100000, mtime=0), 8192, "decoded_limit"),
    (normal[:-4], 8192, "incomplete_gzip"),
    (normal + normal, 8192, "trailing_data"),
]:
    try:
        read_gzip(pieces(data), decoded_limit=limit)
    except Rejected as error:
        assert str(error) == reason
        print(reason)
    else:
        raise AssertionError("fixture unexpectedly accepted")
print("exact-boundary and empty-member checks passed")
```

Expected output:

```text
decoded_limit
incomplete_gzip
trailing_data
exact-boundary and empty-member checks passed
```

The first rejected fixture is only 100,000 repetitive bytes before compression. It demonstrates amplification without a dangerous workload. The truncated fixture is more subtle: useful plaintext can already have appeared even though the compressed stream has not completed. Treating that prefix as a successful result would conceal missing validation.

The function deliberately rejects a second gzip member and all trailing bytes. That is an application policy, not a definition of valid gzip: RFC 1952 permits a sequence of members. A reader that supports multiple members must carry one aggregate decoded counter across them, rather than resetting the budget for every member. The format's `ISIZE` footer stores size modulo 2³²; it cannot replace counting actual output. [RFC 1952 §§2.2–2.3.1](https://www.rfc-editor.org/rfc/rfc1952.html)

This is an illustrative decoding primitive, not a production HTTP client. Its caller has already allocated each incoming chunk, so upstream chunk sizes and buffering must be bounded separately. It retains the accepted body and creates a final bytes copy; peak memory can exceed the decoded ceiling. Malformed gzip can raise `zlib.error`, which a real adapter should translate into its typed failure result. The function neither closes a network response nor manages deadlines, retries, or HTTP message completeness.

## Text and parsers need their own contracts

Network and decompression chunks do not align with UTF-8 characters. Decoding each chunk independently can reject a valid split character or silently replace bytes. Use a stateful incremental decoder with a deliberate error policy, then finalize it at actual end of input. Python's incremental decoder contract requires finalization to resolve buffered bytes and report incomplete sequences according to that policy. [Python incremental decoders](https://docs.python.org/3/library/codecs.html#incrementaldecoder-objects)

For strict machine-readable tool output, I recommend rejecting malformed UTF-8. For a human preview, replacement may be acceptable if labeled; do not quietly apply that policy to structured fields used for decisions. Finalizing text decoding also does not prove the surrounding JSON or HTTP message is complete.

A streaming parser is helpful only if its retained state is bounded. For newline-delimited records, set a maximum record length before waiting for the next delimiter. Otherwise one never-ending line recreates the whole-body buffer. For JSON, constrain nesting, string length, and retained items with a parser that actually exposes those controls, or accept only a small byte-bounded document and use ordinary parsing within a conservatively sized worker. Python explicitly warns that untrusted JSON can consume significant CPU and memory and recommends input-size limits. [Python JSON documentation](https://docs.python.org/3/library/json.html)

These controls have different meanings. A maximum number of emitted records does not limit bytes spent finding them. Selecting three fields after building the entire tree does not bound tree construction. A parser's advertised streaming interface needs a test with one oversized scalar or deeply nested value, not merely a long list of small, friendly records.

## Failure must remain visible to the agent

For a bounded adapter, a useful completion contract distinguishes `complete`, `preview`, and `rejected`. A complete result passed the transport, content-decoding, character-decoding, and document-validation checks that its media type requires. A preview is an explicitly incomplete excerpt suitable only for tasks that allow incomplete evidence. Rejected means the adapter must not pass an apparently successful tool payload onward.

I would include a stable reason such as `decoded_limit`, the applicable limit, observed counters with their units, and whether anything was already exposed. A detection counter may be only a lower bound on the full response size: after cancellation, the reader does not know how much more would have arrived. Avoid reporting that lower bound as the response's actual total size.

On a limit failure, stop the producer as well as the consumer. Undici warns against leaving response-resource release to garbage collection and recommends consuming or canceling bodies. For an oversized untrusted body, choose cancellation through the active reader/request API rather than an unbounded drain performed merely to preserve connection reuse. Whether a connection remains reusable is implementation-dependent. [Undici response lifecycle guidance](https://github.com/nodejs/undici#garbage-collection)

Partial structured data must not trigger actions as if the document were complete. Keep it provisional until the chosen commitment boundary, or define independent record-level validation and effects explicitly. Cancellation is also not proof that a remote operation did nothing; ingestion failure does not authorize blind replay of a mutating tool call.

## Verify the boundary that can actually fail

The exercise checks exact-limit acceptance, empty output, amplification, truncation, and concatenated-member rejection. Production verification should add oversized encoded input, bad checksums, byte-by-byte UTF-8 splits, malformed final UTF-8, an oversized record without delimiters, stacked codings, absent length headers, slow responses, and cancellation while the body is active.

For each rejection, observe that downstream parsing or action execution did not continue and that transport resources were released. Test the real client integration because a decoder unit test cannot reveal automatic HTTP decompression or hidden buffering. Resource ceilings become trustworthy when the test reaches the allocation boundary, and incomplete data stays visibly incomplete all the way to the agent.

---

*Primary sources: [HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110.html), [Fetch](https://fetch.spec.whatwg.org/), [Node streams](https://nodejs.org/api/stream.html), [Python zlib](https://docs.python.org/3/library/zlib.html), [gzip format](https://www.rfc-editor.org/rfc/rfc1952.html), [Python codecs](https://docs.python.org/3/library/codecs.html), [Python JSON](https://docs.python.org/3/library/json.html), [Undici](https://github.com/nodejs/undici). Documentation checked 2026-09-15; recommendations and the exercise are the author's synthesis.*
