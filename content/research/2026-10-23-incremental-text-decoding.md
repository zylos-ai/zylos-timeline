---
date: '2026-10-23'
title: 'Incremental UTF-8 Decoding: Keeping Agent Streams Intact'
description: 'A reproducible experiment shows why decoding each byte chunk independently corrupts text, and how decoder lifetime, EOF policy, framing, and buffer limits fit together.'
tags: ['Unicode', 'Streaming', 'Node.js', 'Agent Engineering']
---

## Executive Summary

An agent can receive every byte of a tool's output and still display damaged text. The failure often begins when each incoming byte chunk is converted independently into a string. A read boundary can fall inside a UTF-8 sequence; decoding those fragments separately loses the original character before the strings are joined.

A small Node.js experiment below makes the problem visible: independent decoding corrupted 14 of 20 possible two-chunk splits, while two incremental decoders preserved all 20. The practical design is to keep one decoder per continuous byte stream, finalize it deliberately, and give record parsing and display segmentation their own state. These are proposed engineering practices, not claims about an existing agent implementation.

## Four Boundaries That Do Different Jobs

Consider a command emitting `中🙂é👩‍💻`. A pipe read supplies bytes in chunks. A UTF-8 decoder turns byte sequences into Unicode code points. A record parser identifies lines or protocol events. A renderer decides what to display together.

Those boundaries do not coincide. The accent in `é` is a separate combining code point. The final emoji includes a zero-width joiner linking multiple code points. Both can form extended grapheme clusters: the units commonly used when approximating user-perceived characters. Unicode's segmentation rules describe these boundaries, including combining marks and emoji sequences. They do not promise that a transport chunk ends at one. [Unicode UAX #29](https://www.unicode.org/reports/tr29/)

Consequently, a correct decoder may emit `e` now and its accent later. That preserves the text but may require a UI to repaint the preceding cluster. Splitting a JavaScript string with a numeric index adds another consideration: indices count UTF-16 code units, so slicing can bisect a surrogate pair. Byte integrity, record completeness, and visual stability need separate decisions.

## An Experiment That Can Expose the Bug

Save this as `decode.cjs` and run `node decode.cjs`. The deliberately broken implementation is a known-bad positive control: if every method passes, the sample has failed to exercise the boundary problem.

```js
const assert = require('node:assert/strict');
const { StringDecoder } = require('node:string_decoder');
const text = '中🙂e\u0301👩‍💻';
const bytes = Buffer.from(text);
let naiveFailures = 0;

for (let split = 1; split < bytes.length; split++) {
  const chunks = [bytes.subarray(0, split), bytes.subarray(split)];
  naiveFailures += chunks.map(b => b.toString('utf8')).join('') !== text;

  const sd = new StringDecoder('utf8');
  assert.equal(chunks.map(b => sd.write(b)).join('') + sd.end(), text);

  const td = new TextDecoder('utf-8', { fatal: true });
  assert.equal(
    chunks.map(b => td.decode(b, { stream: true })).join('')
      + td.decode(),
    text
  );
}
assert.equal(naiveFailures, 14);
console.log(process.version, {
  bytes: bytes.length, splits: bytes.length - 1, naiveFailures
});
```

Observed on Node.js v24.17.0:

```text
v24.17.0 { bytes: 21, splits: 20, naiveFailures: 14 }
```

Both assertion paths passed every cut. This is an exhaustive two-chunk test of one short fixture, not a benchmark or proof covering all malformed input. It isolates the effect of byte boundaries without depending on network timing.

Node's `StringDecoder.write()` holds incomplete multibyte sequences between calls; `end()` resolves remaining input, replacing incomplete UTF-8 sequences. That makes it convenient for readable tool logs where replacement is acceptable. [Node.js StringDecoder documentation](https://nodejs.org/api/string_decoder.html)

For `TextDecoder`, pass `{ stream: true }` on intermediate calls and finish with `decode()`. The `fatal` option requests errors instead of replacement for malformed input. These are explicit parts of its streaming API. [WHATWG Encoding Standard](https://encoding.spec.whatwg.org/#interface-textdecoder)

## Decoder Lifetime Is Part of Correctness

Creating a decoder inside each chunk callback recreates the original bug. Keep it alongside the stream's other state. Conversely, do not let stdout, stderr, or unrelated subprocesses share one decoder: a trailing prefix from one source must never consume bytes from another.

A temporary absence of bytes in a tailed file is not a logical end of stream. Flushing at every poll would turn a partially written character into replacement text. Keep state while continuing the same byte sequence. If rotation, truncation, or a reconnect establishes a new byte sequence, explicitly resolve or discard the old pending tail under a documented policy and start fresh. Transport continuation should not be guessed from a reused filename.

For a clean EOF, deliver the decoder's final output to the record parser before completing the parser. For cancellation or transport failure, label the result incomplete even when the text decoded successfully. Valid UTF-8 cannot prove that a tool finished its response.

The following extension demonstrates why finalization matters:

```js
for (const fatal of [false, true]) {
  const td = new TextDecoder('utf-8', { fatal });
  console.log('pending', fatal,
    JSON.stringify(td.decode(Uint8Array.of(0xf0, 0x9f), { stream: true })));
  try { console.log('flush', fatal, JSON.stringify(td.decode())); }
  catch (e) { console.log('flush', fatal, e.name); }
}
```

Observed output:

```text
pending false ""
flush false "�"
pending true ""
flush true TypeError
```

A separate probe with byte `ff` threw during the streaming call itself. Therefore, strict error handling must cover both chunk processing and finalization. Already displayed text cannot be undone by a later decoding error; applications needing atomic acceptance should publish only after validating their chosen record boundary.

BOM behavior also deserves an explicit test. For bytes `ef bb bf 41`, the same runtime's default `TextDecoder` returned only `A`; with `ignoreBOM: true`, it returned U+FEFF followed by `A`. `StringDecoder` preserved U+FEFF. Despite its name, `ignoreBOM: true` therefore preserves the marker in output. Replacing one decoder with another can change the first parsed field unless that policy is intentional.

## Decoding Does Not Finish an Event

A custom server-sent events client still needs a parser after UTF-8 decoding. SSE accepts CRLF, lone CR, or LF line endings; an empty line triggers event dispatch processing. Multiple `data:` fields contribute lines to one event, comments do not become event data, and a single leading BOM is stripped. An unfinished event at EOF is discarded rather than dispatched. [HTML Standard: parsing and interpreting event streams](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream)

A simplistic `split('\n\n')` misses these cases. The parser needs state when CR and LF arrive separately, just as the decoder needs state when a multibyte sequence arrives separately. JSON parsing belongs after a complete application payload has been assembled; successful decoding alone is no reason to call `JSON.parse()`.

A useful integration fixture splits one SSE event inside an emoji, between CR and LF, and inside its JSON text. A correct pipeline yields the same single event for every transport split. Removing the terminating blank line should yield no dispatched event. This extends the byte experiment into a framing test without confusing the two guarantees.

## Keep Buffers Small Without Inventing Completeness

Incremental decoding removes the need to retain the entire raw output, but it does not bound the rest of the pipeline. A producer can send an indefinitely long line, a huge event, or data faster than the consumer can render.

Set separate limits for pending records and queued delivery, with explicit units such as input bytes or UTF-16 code units. Apply backpressure where possible. When a limit is exceeded, reject the record or mark a bounded preview as truncated; do not silently submit the preview as complete JSON or a complete tool result. Avoid retaining every decoded chunk in an array as the experiment does: that arrangement is for a finite assertion, not production ingestion.

Even display buffering needs a limit: a run of combining marks can keep extending a grapheme cluster. If a UI caps its pending display tail, the resulting truncation should be visible. Preserving valid text and admitting incomplete output is a more dependable contract than presenting damaged or partial data as a finished answer.
