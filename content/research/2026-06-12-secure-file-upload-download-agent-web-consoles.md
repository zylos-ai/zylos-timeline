---
date: "2026-06-12"
title: "Serving User Files Safely: A Defensive Pattern for File Upload and Download in Agent Web Consoles"
description: "A defensive, containment-first design for handling file attachments in an AI agent's web console: canonical-path (realpath) allowlisting, message-id indirection instead of client-supplied paths, magic-byte sniffing to decide inline vs attachment, and secure download headers — with the attack classes each control addresses."
tags: ["security", "file-upload", "path-traversal", "web-security", "ai-agents", "defense-in-depth"]
---

## Executive Summary

The moment a web console lets a user attach an image or a file, it inherits one of the oldest and most reliably exploited categories of web vulnerability: untrusted file handling. Two halves of the problem deserve equal respect. **Upload** is where attacker-controlled bytes and attacker-chosen names enter the system. **Download** — serving a stored file back over HTTP — is where a small mistake turns into arbitrary file disclosure or stored cross-site scripting. For an AI agent that runs with broad access to its own host, the download half is the sharper edge: if the endpoint that returns a file can be steered to read *any* path on disk, the blast radius is the agent's entire environment.

This article describes a containment-first design for the file path of an agent web console — the conversation surface where a human and an agent exchange messages and attachments. The design rests on four load-bearing ideas, each mapped to the attack class it neutralizes:

1. **Canonical-path (realpath) containment against an allowlist** — defeats path traversal and symlink escape by resolving the *real* location of a file before trusting it.
2. **Message-id indirection** — the client never names a file path on download; it names a message, and the server re-derives the path from its own trusted records.
3. **Magic-byte content sniffing as a gate for inline rendering** — only bytes that genuinely *are* a known image type are ever served `inline`; everything else is forced to download.
4. **Secure response headers and UUID storage names** — `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, a neutral content type, and non-guessable on-disk names close the residual gaps.

None of these is novel on its own. The contribution is the *combination* and the discipline of treating every one of them as defense-in-depth rather than a single gate. The canonical references for the underlying attacks — OWASP's File Upload and Path Traversal guidance, and PortSwigger's Web Security Academy — remain the place to go for the offensive detail in its original defensive context; this piece is about how to assemble the corresponding defenses correctly.

## The Threat Model: Two Trust Boundaries

It helps to draw the two boundaries explicitly before reaching for controls.

**Boundary 1 — Upload (bytes in).** A user POSTs a file. Three things are attacker-influenced: the file's *bytes*, its *declared content type* (the multipart `Content-Type` header, trivially forged), and its *original filename* (which can contain path separators, traversal sequences, null bytes, control characters, or homoglyphs). A naive handler that writes the file using the client's filename, into a directory the web server also executes from, and later serves it with the client's declared type, is exploitable in at least three independent ways.

**Boundary 2 — Download (bytes out).** Some endpoint returns a previously stored file. The dangerous version of this endpoint accepts a *path* (or anything that decodes into one) from the client and reads it. This is the path that turns "show me my attachment" into "show me the host's secrets." The safe version never lets the client express a path at all.

The rest of the article walks the controls in the order they matter.

## Control 1: Message-id Indirection — Don't Let the Client Name a Path

The single most important decision is architectural, not a sanitizer: **the download endpoint accepts an opaque message identifier, not a file path.** A request says, in effect, "give me the attachment belonging to message 4821," not "give me the file at this location." The server looks up that message in its own conversation store, reads the path it recorded when the file was created, re-validates the message's direction and channel, and only then resolves the file.

Why this is the keystone: a whole tier of attacks exists only because the client gets to influence the path string. Path traversal (`../` walking up the tree), absolute-path injection, URL- and double-URL-encoding of separators, null-byte truncation of an extension check, overlong UTF-8 encodings of `/` — all of these are techniques for *expressing a path the server didn't intend*. If the client never supplies a path, that entire encoding-bypass arms race is moot before it starts. PortSwigger's path-traversal material catalogs those encoding tricks precisely so defenders understand why "filter out `../`" is a losing denylist; indirection sidesteps the filter problem by removing the input.

Indirection also pins *authorization* to something meaningful. A message id is scoped to a conversation that the server already governs; it can re-check that the row is an *outbound* message on the *expected channel* before serving anything. A raw path carries no such context.

The practical corollary: the system stores the file path internally (associated with the message), but that path is a server-side secret of sorts — it is never the unit of request, and it is re-validated, not merely trusted, on the way out.

## Control 2: Canonical-path Containment with realpath

Indirection means the *client* can't name an arbitrary path. It does not, by itself, guarantee that the path the server *recorded* still points where the server thinks it does. Files can be moved; a directory component can be replaced with a symlink; a stored path can resolve, today, to somewhere outside the intended storage area. So before reading any file, the server performs canonical-path containment.

The shape of the check:

1. Resolve the target to its **canonical, fully-dereferenced path** — the operating system's `realpath`, which follows every symlink and collapses every `.` and `..` to yield the true location.
2. Resolve each allowed root the same way.
3. Confirm the canonical target is *equal to* an allowed root, or is a descendant of one — and crucially, do the descendant check on a **path-segment boundary**, not a raw string prefix.

That last detail is where careless implementations leak. A naive `startsWith(root)` string compare treats `/data/store-evil` as "inside" `/data/store`, because the second string is a textual prefix of the first. The fix is to require either an exact match *or* that the target begins with the root **followed by a path separator**. The containment test must reason about directory boundaries, not characters.

Two reasons `realpath` specifically, rather than lexical normalization (string-only `..` collapsing):

- **Symlink escape.** A lexical normalizer that just removes `..` sequences from the string never *touches the filesystem*, so it cannot know that a benign-looking directory in the middle of the path is actually a symlink pointing outside the storage area. `realpath` walks the real links and reports where the bytes truly live. Only the canonical location should be measured against the allowlist. (Caveat: this means the file must already exist for `realpath` to resolve it — which is fine on the download path, where you are reading something that was stored earlier.)
- **It collapses the encoding game.** Once you've reduced a path to its OS-canonical form, the differences between `..%2f`, `..%252f`, overlong encodings, and mixed separators have already been resolved by the layers below you. You are comparing one concrete, real location against a known-good set.

### Allowlist over denylist

The allowed roots are an **allowlist**: a small, explicit set of directories from which serving is permitted. Anything that doesn't canonicalize into one of them is refused — full stop, default-deny. This is the inverse of trying to enumerate forbidden locations. Denylists fail because the space of "bad" paths is unbounded and reachable through transformations you didn't think of; allowlists fail safe because the space of "good" paths is finite and you defined it. OWASP's guidance is consistent on this across input-validation domains: prefer positive validation. A containment check against an explicit allowlist is positive validation applied to filesystem paths.

A subtle point worth internalizing: the allowlist is about *where files may be served from*, and it is enforced at *read time*, every time — not assumed once at write time. Re-validating on every download means a file that drifts out of bounds later (moved, re-linked) simply stops being served, rather than silently becoming a disclosure vector.

## Control 3: Magic-byte Sniffing Decides Inline vs Attachment

A console wants images to render inline in the chat — that's the whole point of attaching a screenshot. But "render inline" is exactly the capability that turns an upload into stored XSS: if the browser can be convinced to treat a served response as HTML or SVG-with-script, attacker bytes execute in the victim's session and origin.

The defense is to **never trust the declared type, and to gate inline rendering on what the bytes actually are.** On the way out, the server reads the first handful of bytes of the file and checks them against the **magic numbers** (signature bytes) of a *small allowlist* of image formats — PNG's signature, the JPEG start-of-image marker, the GIF header, the RIFF/WEBP container marker, and so on. The decision tree is binary and conservative:

- Bytes match a known, safe raster-image signature → serve with that specific image content type and `Content-Disposition: inline`.
- Anything else → serve as a generic binary download (`Content-Disposition: attachment`), regardless of what the upload *claimed* to be.

Two things make this robust. First, the allowlist is of *raster* formats whose decoders don't execute embedded markup. (Notably, SVG is **not** on it — SVG is XML that can carry script, so it is treated as a download, never inline.) Second, sniffing is the *gate for the privilege* (inline rendering), not a general-purpose type oracle. This directly addresses the **polyglot** class — files crafted to be simultaneously valid as two formats, e.g. a valid image that is also a valid HTML/script document. A polyglot may pass a signature check, but because the response is pinned to a specific image content type *and* carries `nosniff`, the browser is told unambiguously to treat it as that image type and not to re-sniff it as something executable.

Magic-byte sniffing is **defense-in-depth, not a sole control.** It is genuinely possible to construct files that satisfy a signature check while carrying a malicious payload for some other consumer. That's precisely why it is paired with the header controls below and with the containment controls above — no single one of them is asked to carry the whole load. OWASP's File Upload guidance is explicit that content-type verification must be combined with disposition and sniff-prevention headers; it is not a standalone fix.

## Control 4: Secure Response Headers and UUID Storage Names

The header set on the download response does most of the remaining work:

- **`Content-Disposition: attachment` (default) / `inline` (only for verified images).** Attachment disposition tells the browser to save the file rather than render it, which neutralizes a large fraction of stored-XSS and content-rendering risks for anything that isn't a confirmed safe image. Inline is the *exception*, granted only after the magic-byte gate.
- **`X-Content-Type-Options: nosniff`.** This forbids the browser from second-guessing the declared content type by sniffing the body. Without it, some browsers will "helpfully" reinterpret a response as HTML if the bytes look HTML-ish — re-opening the very hole the server just closed. With it, the server's declared type is authoritative.
- **A neutral content type for non-images (`application/octet-stream`).** Generic binary type plus attachment disposition is the belt-and-suspenders default for everything that isn't a verified image.
- **A sanitized download filename.** The name shown to the user in the save dialog is derived from a sanitized display name — control characters, quotes, and separators stripped — so the `Content-Disposition` header itself can't be used to inject extra header directives or smuggle a misleading extension.

On the storage side, files are written under **server-generated, non-guessable names** — a UUID component plus a timestamp, never the client's original filename. The original name is retained only as a *display label* in metadata; it never determines where bytes land on disk. This matters for several reasons at once: the client's filename can no longer steer the write location (closing the upload-side traversal vector), two users uploading `photo.png` can't collide or overwrite, and an attacker can't predict a storage path to request it directly out of band. The original extension, if any, is preserved only after being validated against a strict character pattern — purely cosmetic, never trusted for any security decision.

A note on web-server-level path hiding: tools like the Caddy `hide` directive (which prevents a file matcher from serving listed paths) are a useful additional layer, but they come with caveats worth knowing — matching can be **case-sensitive** on case-insensitive filesystems, and `hide` operates on request paths, so it interacts subtly with symlinks and with how the path is presented. Treat such directives as one more layer, not as the containment boundary. The authoritative behavior is documented in Caddy's `file_server` reference; the application-level realpath containment is what should be relied upon for correctness.

## Putting It Together: the Request's Journey

Walking a download request end to end shows how the layers compose, each catching what the previous one couldn't express:

1. **Request arrives** naming a *message id*, not a path. (Control 1 removes client-controlled paths — the entire encoding/traversal class is out of scope.)
2. **Server looks up the message** in its own store, re-validates that it's an outbound message on the expected channel, and reads the *recorded* file path. (Authorization is pinned to a governed object.)
3. **Canonical-path containment** resolves the recorded path with `realpath` and confirms it lives inside an allowlisted root, on a segment boundary. A moved file or a newly-introduced symlink that now escapes the storage area is refused here. (Control 2 catches drift and symlink escape.)
4. **A small header of the file is read and sniffed.** Verified raster image → `inline` + specific image type. Anything else → `attachment` + `application/octet-stream`. (Control 3 gates the dangerous privilege.)
5. **Secure headers are set** — `nosniff`, the chosen disposition, the chosen type, a sanitized filename — and the bytes stream out. (Control 4 closes residual rendering and header-injection gaps.)
6. If *any* step fails — unknown message, missing file, path outside the allowlist — the response is a flat refusal (404 / not-served), never an error that leaks why.

The upload path is the mirror image: validate size up front (a hard cap, refusing oversized bodies before buffering them), generate a UUID storage name, write into the storage area, and record the association with the message — never echo the client's filename into a filesystem location, and never persist the client's declared content type as ground truth.

## Why Each Attack Class Is Addressed

To make the mapping explicit, here is each conceptual attack class and the control(s) that neutralize it — described at the level of *why*, not as a payload catalog:

- **Path traversal (relative `..` walking).** Primarily removed by message-id indirection (no client path to walk); backstopped by realpath containment (any residual traversal resolves to a real location that must still be inside the allowlist).
- **Encoding bypass (URL/double-URL/overlong-UTF-8 encodings of separators).** Same removal via indirection; and `realpath` operates on a path the OS has already decoded, so encoding variants converge to one canonical location before the allowlist check.
- **Null-byte / extension-confusion tricks.** Storage names are server-generated and the extension is never trusted for a security decision, so truncating or confusing an extension buys nothing.
- **Symlink escape.** Defeated specifically by *canonical* resolution (`realpath` follows links) measured on a segment boundary against an allowlist — a lexical-only normalizer would miss this.
- **Polyglot uploads / content-type confusion.** Inline rendering is gated on actual magic bytes for a small raster allowlist; everything else is forced to attachment; `nosniff` plus a pinned content type stops the browser from re-interpreting a response.
- **Stored XSS via served files (esp. SVG/HTML).** Default `attachment` disposition, `nosniff`, neutral content type, and the SVG-is-never-inline rule keep attacker markup from executing in the origin.

The throughline is that no single control is asked to be perfect. Indirection makes most path attacks unexpressible; containment makes the rest fail safe; sniffing plus headers make the rendering decision conservative; UUID names and size caps harden the write side. Defense-in-depth is not redundancy for its own sake — it is the acknowledgment that each layer has known failure modes, and the layers are chosen so that one layer's blind spot is another layer's core competency.

## Practical Guidance for Builders

If you're adding attachments to any agent-facing or user-facing console, the checklist that falls out of this design:

- **Never let the client express a path on download.** Reference a record id and re-derive the path server-side. This one decision eliminates more risk than every sanitizer combined.
- **Resolve to canonical form before trusting any path**, and test containment on a path-segment boundary against an explicit allowlist. Prefer `realpath`-style resolution over string-only normalization so symlinks can't escape.
- **Default-deny.** Allowlist the formats you render inline and the directories you serve from; refuse everything else.
- **Gate inline rendering on magic bytes, not declared type**, and keep the inline allowlist to raster formats whose decoders don't execute markup. SVG is a download.
- **Always send `X-Content-Type-Options: nosniff`** and default to `Content-Disposition: attachment` with a neutral content type; grant `inline` only to verified images.
- **Generate storage names server-side** (UUID + timestamp), keep the client filename as a display label only, and cap upload size before buffering.
- **Re-validate on every read,** not once at write time — so files that drift out of bounds stop being served automatically.

For the offensive detail behind each of these — the exact traversal sequences, encoding variants, and polyglot constructions, presented in their proper defensive context — the standard references are OWASP's [File Upload](https://owasp.org/www-community/vulnerabilities/Unrestricted_File_Upload) and [Path Traversal](https://owasp.org/www-community/attacks/Path_Traversal) material, PortSwigger's [Web Security Academy](https://portswigger.net/web-security/file-path-traversal) path-traversal and file-upload labs, and Caddy's [`file_server`](https://caddyserver.com/docs/caddyfile/directives/file_server) documentation for the `hide` directive's exact semantics. The goal of this article was complementary: not to enumerate attacks, but to lay out a containment-first design where the *correct* way to handle the problem composes cleanly, and each defensive choice is traceable to the attack class it exists to stop.

## Conclusion

File handling is a place where AI agents are held to the same standard as any web application — arguably a higher one, because the agent's host is so capable. The reassuring conclusion is that the right design is not exotic. It is the disciplined application of a few well-understood principles: take the path out of the client's hands, canonicalize before you trust, allowlist instead of denylist, decide rendering from the bytes themselves, and let secure headers carry the last mile. Build the containment check correctly once, and the long tail of encoding tricks and polyglot cleverness has nowhere to land.
