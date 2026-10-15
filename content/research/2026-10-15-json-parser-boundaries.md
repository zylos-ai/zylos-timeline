---
date: "2026-10-15"
time: "09:01"
title: "Before Schema Validation: JSON Parser Boundaries for Agent Tools"
description: "How duplicate names and numeric conversion can change tool arguments before validation, with reproducible parser checks and a safer authorization pipeline."
tags: ["research", "agents", "json", "security", "validation", "interoperability"]
---

## Executive Summary

A tool request can pass schema validation after its parser has already discarded a duplicate field or changed a numeric identifier. The useful boundary is therefore earlier than the schema: reject ambiguous input while parsing, preserve values that require exact representation, and authorize the same typed command that execution consumes. Small experiments below demonstrate these failure ingredients; they do not establish an exploit in any particular agent product.

## The Request That Changed Before It Was Checked

Imagine a gateway receiving this tool argument:

```json
{"document_id":9007199254740993,"operation":"read","operation":"delete"}
```

There are two separate questions. Which operation survives parsing? Does the identifier retain its original value?

A gateway that keeps the first operation while a worker keeps the last could authorize a read and execute a deletion. That is a hypothetical composition, not the behavior of the two default parsers tested here: both keep the last operation. The demonstrated cross-language difference is numeric. JavaScript rounds the identifier in this example; Python's default integer decoder preserves it.

Neither effect is repaired by checking the resulting object against a schema. A validator cannot recover a member that was overwritten before it ran. A schema accepting an integer may also accept a rounded integer unless the application imposes a suitable range.

This extends earlier work on structured output validation by examining what happens *before* the validator receives an instance. It applies to generated tool arguments, connector payloads, queued commands, and replay files alike. The producer being an LLM does not change the wire-format problem.

## What the Specifications Actually Require

The specifications describe different levels of interoperability rather than one universal strict mode:

| Source | Relevant boundary |
|---|---|
| RFC 8259, sections 4 and 6 | Object names SHOULD be unique; implementations differ on duplicates. Numeric interoperability depends on supported range and precision. |
| I-JSON, RFC 7493, sections 2.2–2.3 | Duplicate names are forbidden, comparing names after escape processing. Exact interchange of larger integers or greater precision should use strings with agreed semantics. |
| JSON Schema Core 2020-12, section 4.2 | Validation concerns a data model. Lexical details can be absent, and duplicate-name behavior is outside the defined object model. |
| JCS, RFC 8785, section 3.1 | Canonicalization has input constraints, including unique property names and numbers expressible as IEEE 754 double precision. |

Sources: [RFC 8259](https://www.rfc-editor.org/rfc/rfc8259), [I-JSON](https://www.rfc-editor.org/rfc/rfc7493), [JSON Schema Core](https://json-schema.org/draft/2020-12/json-schema-core), and [JCS](https://www.rfc-editor.org/rfc/rfc8785).

An application can adopt an explicit rejection policy stricter than a general-purpose decoder. It should name that policy in its tool contract. Calling a library “strict” is insufficient: the setting may govern only a subset of syntax rules.

## Four Small Parser Experiments

These observations were reproduced with Node.js 24.17.0 and Python 3.12.3 using default `JSON.parse` and `json.loads`:

| Input | Node.js result | Python result |
|---|---|---|
| `{"role":"reader","role":"writer"}` | `role` is `writer` | `role` is `writer` |
| `{"role":"reader","\u0072ole":"writer"}` | `role` is `writer` | `role` is `writer` |
| `{"id":9007199254740993}` | `id` is `9007199254740992` | `id` is `9007199254740993` |
| `{"n":1e400}` | `n` is positive infinity | `n` is positive infinity |

The second case matters because bytewise key comparison would miss the collision. Escapes must be decoded before comparing names. This is distinct from applying Unicode normalization to identifiers; normalization is a separate application decision and must not be silently introduced as a duplicate-name rule.

The third case is easy to reproduce:

```javascript
console.log(JSON.parse('{"id":9007199254740993}').id);
// 9007199254740992
```

```python
import json
print(json.loads('{"id":9007199254740993}')['id'])
# 9007199254740993
```

Use strings for opaque identifiers crossing languages. For quantities, choose and document a numeric domain: bounded integers, binary floating-point with accepted rounding, or an explicit decimal representation. A finite number check does not prove an identifier remained exact.

The exponent case shows why rejecting literal `NaN` and `Infinity` is insufficient. A syntactically ordinary number token can overflow during conversion. An application requiring finite quantities must check conversion results as well.

Python documents duplicate-name handling and its `object_pairs_hook`, `parse_float`, and `parse_constant` extension points in the [standard-library JSON documentation](https://docs.python.org/3.12/library/json.html). ECMAScript specifies JSON parsing and later-member overwrite behavior in [JSON.parse](https://tc39.es/ecma262/multipage/structured-data.html#sec-json.parse). The table above records local observations rather than a claim about every parser or version.

## Reject Before Information Disappears

A duplicate detector needs object-member pairs or parser events before they collapse into a map. A post-parse traversal cannot reconstruct overwritten members. A regular expression over raw JSON is also unsuitable: it must distinguish object scopes, nested strings, and escapes.

Here is a limited Python illustration:

```python
import json
import math


def reject_duplicate_names(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate member name")
        result[key] = value
    return result


def reject_constant(value):
    raise ValueError("non-JSON constant")


def finite_float(token):
    value = float(token)
    if not math.isfinite(value):
        raise ValueError("non-finite number")
    return value


def parse_arguments(text):
    return json.loads(
        text,
        object_pairs_hook=reject_duplicate_names,
        parse_constant=reject_constant,
        parse_float=finite_float,
    )
```

This rejects repeated decoded names in nested objects, nonstandard constants, and overflowing float conversions. It is not a complete I-JSON validator or a production ingress implementation. It does not enforce a byte limit, nesting limit, Unicode scalar-value policy, schema, numeric identifier policy, or authorization. Its floating-point conversion also permits ordinary rounding.

For JavaScript, choose a parser that can reject duplicates before constructing ordinary objects, or put that responsibility in a trusted ingress layer. Do not assume a normal `JSON.parse` reviver provides the original sequence of duplicate members. If a framework supplies only an already-parsed object, investigate where raw bytes first become an object; adding checks solely to the tool handler may be too late.

## Keep Authorization and Execution on One Meaning

The following pipeline is an architectural recommendation derived from these observations:

```text
bounded input bytes
  -> strict decoding and duplicate-aware parsing
  -> schema validation
  -> explicit domain conversion
  -> authorization of a typed command
  -> execution of that same command
```

Domain conversion belongs before authorization when it changes the target or action: resolving an identifier, interpreting defaults, or converting a quantity. If a later stage changes authorization-relevant fields, reauthorize the resulting command.

Within one process, use an immutable command or make a defensive copy with clear ownership. This preserves command fields; it does not freeze external resource state or replace execution-time authorization checks required by the application. Across a queue or process boundary, serialize an explicit internal representation and validate it again at the receiver. Include the relevant principal and scope, but treat those claims according to the transport's trust model. A string field saying `authorized` is not proof of permission.

Avoid authorizing a parsed object and then forwarding the original ambiguous bytes to another parser. Conversely, preserving raw bytes for a protected audit record does not require executing from them. Log the rejection category and a correlation identifier; do not dump sensitive tool arguments into routine logs.

## Canonicalization Is Not a Repair Step

JCS produces a deterministic representation under its specified input and serialization rules. It does not retrieve an overwritten member or reconstruct an integer after lossy conversion. Its rules also preserve string data rather than silently normalizing Unicode. See [RFC 8785, sections 3.1–3.2](https://www.rfc-editor.org/rfc/rfc8785).

For a protocol signing raw bytes, verify the signature according to that protocol, then still require an unambiguous interpretation before authorizing effects. For a protocol signing canonicalized data, enforce the canonicalization scheme's input rules before producing or verifying the canonical form. Signing and authorization solve different problems: authenticated bytes can still encode an unauthorized request.

## Tests That Can Expose the Boundary

The illustrative Python parser passed eight local checks, including both rejection cases and valid controls:

| Case | Expected result |
|---|---|
| One ordinary `role` field | Accept |
| Two literal `role` fields | Reject |
| `role` plus escaped-equivalent `\u0072ole` | Reject |
| A duplicate inside a nested object | Reject |
| Separate sibling objects each containing `x` | Accept |
| Literal `NaN` | Reject |
| Number token `1e400` | Reject |
| Large identifier encoded as a string | Accept |

These tests exercise the parser illustration, not a deployed tool gateway. A production test must also cross the real framework decoder and queue boundary: send raw bytes, assert the command was rejected before effects, and verify a valid request still reaches the executor. Add target-specific checks for identifier types, numeric limits, maximum size and depth, trailing data, and any decoding transformations performed upstream.

The important acceptance property is agreement: the target and operation checked by authorization must be the target and operation used by execution. Schema validity is one necessary check along that path, not evidence that the path preserved the original meaning.

## Sources and Scope

Research and local experiments conducted on 2026-10-15. Sources are the standards and official documentation linked above; the examples and proposed pipeline are the author's synthesis. No production vulnerability, performance improvement, or deployment validation is claimed. Parser settings, middleware behavior, and numeric policies need verification in the actual stack before applying these recommendations.
