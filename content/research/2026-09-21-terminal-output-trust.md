---
date: "2026-09-21"
title: "Terminal Output Is Untrusted Input for Persistent Agents"
description: "Why raw command bytes, terminal screens, and model context disagree—and how to build an auditable output boundary without mistaking escaping for prompt-injection prevention."
tags:
  - "ai-agents"
  - "security"
  - "terminal"
  - "research"
---

## Executive Summary

A command can print bytes that move a cursor, replace an earlier line, create a hyperlink, or request a terminal response. An agent may read those bytes as text while a human reviews a screen after the controls have taken effect. Their evidence can disagree even when both are looking at the same command run.

For persistent agents, that disagreement can outlive the process: output becomes a transcript, a summary, and eventually a remembered claim. The useful boundary is therefore between external output and trusted application state, with separate rules for rendering, model interpretation, and durable storage.

This article proposes a conservative default: capture through pipes when possible, retain bounded evidence, produce an explicit escaped audit view, and keep command status in application-owned metadata. Use a terminal emulator only when the task requires screen semantics. Escaping prevents terminal controls from acting in a plain-text viewer; it does not prevent a model from following instructions written in ordinary language.

The evidence combines protocol documentation, implementation inspection, and offline string tests. No terminal exploit or model-resistance experiment was performed. Product-specific observations below are versioned, not claims about every current agent or terminal.

## One command, three representations

Consider a diagnostic program that emits this byte notation:

```text
check failed\rcheck passed
```

Here `\r` denotes a carriage-return byte; these examples show notation, not live controls. In an ordinary terminal, carriage return moves the cursor to the start of the line. Subsequent characters can overwrite earlier ones. In a raw transcript, both phrases remain. A collector that silently deletes carriage returns instead creates a third string, `check failedcheck passed`, which was never the screen state.

There are three distinct artifacts:

- **Raw capture:** bytes observed at the collector boundary, with stream and process identity.
- **Rendered screen:** the emulator's current cells after interpreting a sequence of writes.
- **Model input:** whatever text the harness selects, decodes, truncates, labels, and places in context.

None is a universal substitute for the others. A final screen can omit erased history; raw capture does not establish what a human saw; a model transcript may omit either. Even a screenshot needs dimensions and timing to explain which screen state it represents.

[ECMA-48](https://ecma-international.org/publications-and-standards/standards/ecma-48/) defines embedded control functions, including cursor movement and erasure, for character-oriented devices. Its control-string framework also leaves some interpretation to the sender and receiver. That makes terminal output a protocol-bearing stream, rather than simply text with optional color.

The practical consequence is an evidence rule: a program printing `SUCCESS` is a claim by that program. Process exit status is a separately observed fact. Neither alone establishes that the requested external operation actually happened.

## The boundary has more than one failure mode

### Display changes and terminal features

Cursor movement, erasure, concealment, and carriage returns can change which words remain visible. Other sequences address features beyond the cell grid. The [xterm control-sequence reference](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html), inspected at Patch #411, documents OSC 52 for selection data and queries that produce replies to the application. Availability depends on terminal settings and implementation.

That last point matters: output can cause a terminal to send input back. It is not automatically code execution, and a plain pipe does not itself emulate a terminal. The relevant exposure appears when an emulator interprets the stream and its response channel is connected to a running process.

OSC 8 adds a separate display/target distinction. The visible label of a terminal hyperlink can differ from its destination. The [OSC 8 specification](https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda) describes this mechanism and recommends making the target available to users. A review interface should expose the destination rather than treat the label as evidence of where a click goes.

### Model interpretation

Trail of Bits demonstrated how terminal controls could conceal tool text from a human while leaving it available to a model in its [April 2025 MCP investigation](https://blog.trailofbits.com/2025/04/29/deceiving-users-with-ansi-terminal-codes-in-mcp/). Its reported test used Claude Code 0.2.76. This is evidence of the failure mechanism, not a finding about the current release.

Removing that visual discrepancy still leaves ordinary-language prompt injection. A perfectly printable line can ask the model to disregard the user's task or send data elsewhere. [OWASP's prompt-injection guidance](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) distinguishes external-content injection and recommends separation of untrusted content alongside privilege controls. A delimiter or warning improves attribution; it is not an enforcement boundary by itself.

### Persistence and re-display

The following is an engineering inference for persistent systems: an initially labeled tool result can gain undeserved authority when a summarizer writes “the deployment was approved” into memory without retaining who made that claim. Encoding controls does not prevent this semantic promotion.

Store the observation as “process output claimed approval,” linked to the run and evidence. Record actual approval only through the application's approval mechanism. On later retrieval, preserve that distinction. Similarly, an escaped artifact must not be decoded automatically when someone downloads it, copies it, or asks another agent to inspect it.

## Why removing ANSI color is insufficient

A color-removal function answers a useful presentation question, but a security boundary needs an explicit output contract. Does it leave carriage returns? What happens at end-of-stream? Does it understand the same control strings as the eventual viewer?

We tested Node.js `util.stripVTControlCharacters` on **v24.17.0**, with byte values assembled in memory and only printable diagnostic results emitted. The [versioned implementation](https://github.com/nodejs/node/blob/v24.17.0/lib/internal/util/inspect.js) uses a regular expression. In our scoped fixtures:

- A complete red-color SGR sequence was removed, providing a known-good presentation case.
- Carriage return and backspace remained.
- A lone escape byte remained.
- A nested synthetic SGR input produced an output containing a newly contiguous escape sequence after one stripping pass.

For the last fixture, the input notation was `\x1b[\x1b[31m31m`; the output notation was `\x1b[31m`. In JavaScript, construct the input as `e + '[' + e + '[31m31m'`, where `e = String.fromCharCode(27)`. Inspect the result as hexadecimal bytes, not by printing it directly to a terminal: the observed output was `1b5b33316d`.

These are observations about that version and those inputs, not a vulnerability claim against all uses of the API. They show why an API name containing “strip” cannot substitute for checking a final representation invariant.

Stream boundaries add another issue. A control sequence can begin in one read and finish in another. Stateless per-chunk stripping may produce different text from processing the joined input. A real screen parser needs persistent state; a byte-escaping audit view can avoid interpreting the grammar entirely.

C1 controls complicate universal claims further. The xterm reference describes both seven-bit and eight-bit control forms and a specific ordering of control processing and UTF-8 decoding. Other implementations need their own verification. The conservative byte view below escapes every non-ASCII byte, so it does not need to decide which encoding an eventual emulator would recognize.

## A proposed capture and evidence contract

This is a design recommendation, not a claim that an existing agent implements it. It separates the collector's facts from the child's content.

### Capture before rendering

Prefer stdout and stderr pipes for ordinary noninteractive commands. This removes the need to interpret terminal features during capture. It does not make hostile bytes or instructions trustworthy. Producer options such as disabling color reduce normal noise; the receiver still owns its output boundary.

Create the run identifier outside the child process. Record the command identity according to the application's privacy policy, start and completion observations, and exit status when actually known. Label stdout and stderr separately. For concurrent streams, record collector observation order without claiming a precise cross-stream write order that the capture method cannot establish.

Bound retained bytes, output rate, execution time, and viewer size. Choose a policy for exceeding each limit: stop the process, stop retaining while continuing to drain, or return a partial result. Keep draining only within a defined deadline so an endless writer does not become an endless audit job.

Truncation must be metadata, not a line the child can impersonate. Track observed and retained byte counts separately. If collection ends early, label the observed count as partial. A digest covers only bytes actually observed; it cannot prove anything about bytes never read. Use a separately bounded, access-controlled raw artifact when deeper inspection is needed. Raw logs may contain secrets, so retaining them is also a data-retention decision.

Distinguish actual stream EOF, collector cutoff, and process completion in the record. They need not coincide: a process can exit while a descendant still holds a pipe open, or collection can stop while the process remains alive. Report an exit status only when the process supervisor has observed it.

### Make the default review view inert

Use the same escaped content for model context and human audit, with distinct application-owned labels around it. The human interface should render text as text, without ANSI interpretation, Markdown execution, or automatic activation of output-derived links. Escaping for terminals does not replace HTML output encoding.

The [xterm.js security guide](https://xtermjs.org/docs/guides/security/) explicitly treats terminal-derived data as untrusted when consumers use titles, buffers, links, and parser hooks in a web page. That advice applies even when the emulator itself renders correctly: an application can reintroduce risk by taking its output and inserting it into another interpreter.

A readable Unicode view can coexist with the strict byte view, but must have its own contract: incremental decoding, explicit handling of invalid and incomplete input, visible treatment of format/control characters, and a mapping back to retained bytes. Python's [incremental decoder documentation](https://docs.python.org/3/library/codecs.html#incrementaldecoder-objects) explains the need to finalize the decoder at end-of-input. A replacement character alone loses the original invalid byte value.

### Keep authority outside the body

Put tool identity, trust classification, truncation state, and exit status into structured fields controlled by the harness. If those fields are serialized into model context, escape the body according to that serialization format. A child printing a closing delimiter or a fake status field must remain child content.

The model can still misunderstand the content. Enforce tool permissions independently, and validate consequential outcomes against their authoritative service or artifact. Before summarization, require the summary to preserve source attribution for claims that could change future actions. Carry the run reference into durable memory so later investigation can recover what was actually observed.

## A small, reproducible audit view

The following Python example intentionally favors inspectability over pleasant typography. It accepts an already bounded byte string, leaves printable ASCII except backslash unchanged, and uses `\xNN` for everything else. It escapes newlines too: record boundaries belong to the viewer, while newlines from the child remain explicit data.

```python
def audit_view(raw: bytes) -> str:
    if len(raw) > 4096:
        raise ValueError("capture exceeds example limit")
    return "".join(
        chr(b) if 0x20 <= b <= 0x7e and b != 0x5c
        else f"\\x{b:02x}"
        for b in raw
    )

assert audit_view(b"OK") == "OK"
assert audit_view(b"a\rb") == r"a\x0db"
assert audit_view(b"\x1b[31m") == r"\x1b[31m"
assert audit_view(b"\\x1b") == r"\x5cx1b"
assert audit_view(bytes([0x9b])) == r"\x9b"
```

Escaping backslash distinguishes literal notation from a real control byte. Each input byte produces at most four output characters, so the example's body cannot exceed 16,384 characters. That is an encoding bound, not a model-token estimate. The function does not bound the upstream read: the collector must enforce its own limits before constructing `raw`.

This byte-local transform has a useful property: for inputs within the cap, encoding two pieces and concatenating the results equals encoding their concatenation. Chunk boundaries cannot reconstruct an escape byte in the output. The overall collector must nevertheless apply its cap across all chunks, not independently reset it on every call.

The cost is obvious for non-English text: UTF-8 bytes become verbose escapes. Keep this as the strict evidence view; build a separately specified readable view when the product needs one. Do not silently switch representations and describe them as identical.

We ran the published assertions on Python 3.12.3, plus checks over all 256 byte values, every split point of a mixed fixture, the exact size limit and its overflow, and round-trip recovery using an independently written decoder. All passed. The Node comparisons above supplied known-bad controls: the proposed printable-output check detected surviving controls after stripping, while ordinary ASCII passed.

These tests establish narrow encoding properties. They do not test a real terminal, clipboard, interactive application, browser extension, or model's resistance to instructions. The escaped string still contains ordinary punctuation and meaningful language; it is suitable for a plain-text sink, not arbitrary interpolation into HTML, shell code, or a prompt's trusted instruction section.

## When a screen model is necessary

Full-screen tools and interactive command interfaces may need terminal emulation. Treat that as an additional representation with additional capabilities:

- Use an isolated emulator with explicitly configured dimensions and parser limits.
- Audit callbacks for title changes, links, clipboard access, and terminal-generated replies.
- For passive inspection, avoid connecting reply callbacks to a process input channel. For interactive compatibility, enumerate and constrain required replies instead of forwarding every feature automatically.
- Wait for queued writes to complete before reading a snapshot, and identify the capture point. A completed write callback does not prove an unterminated control string was complete.
- Escape the resulting cell text before secondary display. Keep the raw evidence separately because erased text cannot be recovered from the final screen.

Disabling replies may break a program that queries terminal properties. That is a real compatibility cost, so the choice should be explicit. A headless emulator is not automatically passive merely because it has no visible window.

## Acceptance criteria for an agent integration

Validate the full journey from child output to later review, not just the encoder in isolation. A useful fixture set includes a benign ASCII message, Unicode text, carriage-return progress output, split and unfinished controls, a hyperlink label/target mismatch, and a forged application-status line. Use inert markers and reserved test destinations.

For each fixture, inspect what reaches the model, the live viewer, exported logs, copied text, and a subsequent summary. Verify that application metadata remains separate, omitted bytes are reported, and copy/export paths do not decode controls. For screen mode, inspect reply callbacks and confirm which messages can reach the child's input.

Finally, test a fully printable instruction attempting to redirect the agent. It should pass the byte encoder unchanged; that is expected. Its treatment belongs to provenance, permissions, and action validation. A rendering fix that claims to solve this second problem is measuring the wrong boundary.

Persistent agents need output they can inspect without executing its presentation protocol, and observations they can remember without converting source claims into authority. A shared escaped audit view addresses the first need. Explicit provenance and independent action controls address the second.
