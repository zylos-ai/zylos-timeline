---
date: "2026-06-17"
title: "Native Module ABI Compatibility in Containerized Node.js Agent Runtimes"
description: "How NODE_MODULE_VERSION mismatches silently corrupt Docker images, why pluggable-skill AI agents are especially exposed, and the layered mitigations that make native-dep builds reproducible."
tags:
  - nodejs
  - docker
  - native-modules
  - abi-compatibility
  - ai-agents
  - node-gyp
---

## Executive Summary

Node.js native addons are compiled against a specific Application Binary Interface (ABI) version encoded as `NODE_MODULE_VERSION`. When a Docker image is built with `COPY . .` and a `.dockerignore` that only excludes the root `node_modules`, host-compiled `.node` binaries for nested skill directories leak into the image unchanged. If the host and the container run different Node major versions — a common scenario during version migrations — every load of a mismatched binary throws at runtime, not at build time. The failure is invisible during `docker build` and only surfaces when the skill is first invoked. This article explains the ABI model in depth, shows exactly how binaries leak and why slim base images cannot recover from a forced source rebuild, and provides a layered set of mitigations from `.dockerignore` hygiene through N-API adoption.

## The ABI Model: NODE_MODULE_VERSION and N-API

### What an ABI is in the Node context

A Node.js native addon is a shared library (`.node` file, a renamed `.so`/`.dll`) loaded by `process.dlopen`. The addon calls into Node's runtime — V8, libuv, the Node C++ API — via a set of C symbol addresses and struct layouts that are collectively the ABI. If the addon was compiled against Node 24's layout and is loaded into Node 22, the struct offsets are different, the symbol addresses differ, and the result is a segfault or, more commonly, an early rejection by Node's own version check.

To make this rejection clean and immediate rather than a crash, Node encodes the expected ABI version as a 32-bit integer in the `.node` file's metadata and checks it on load. That integer is `NODE_MODULE_VERSION`.

### NODE_MODULE_VERSION table (recent Node majors)

| Node major | NODE_MODULE_VERSION | V8 major | Release status (2026-06) |
|---|---|---|---|
| 18 | 108 | 10.2 | Maintenance LTS |
| 20 | 115 | 11.3 | Active LTS |
| 21 | 120 | 11.8 | EOL |
| 22 | 127 | 12.4 | Active LTS |
| 23 | 131 | 12.9 | EOL |
| 24 | 137 | 13.0 | Current |

The jump from 127 (Node 22) to 137 (Node 24) is large because Node 24 landed V8 13 with breaking C++ API changes. Any addon compiled on a Node 24 host that enters a Node 22 container produces the canonical error:

```
Error: The module '.../better_sqlite3.node'
was compiled against a different Node.js version using
NODE_MODULE_VERSION 137. This version of Node.js requires
NODE_MODULE_VERSION 127. Please try re-compiling or re-installing
the module (for instance, using `npm rebuild` or `npm install`).
```

The error message is accurate about the cause but misleading about the fix: `npm rebuild` only works if the container has a C++ compiler toolchain.

### N-API: the ABI-stable alternative

N-API (now called Node-API) is a C API layer maintained by the Node.js team that provides a stable ABI across all Node major versions. Addons written against Node-API do not embed `NODE_MODULE_VERSION` in the same way; they use a `NAPI_MODULE` macro that accepts any Node version that supports Node-API at or above the addon's declared minimum level.

```c
// Traditional nan/V8 addon — version-locked
NODE_MODULE(addon, InitFunction)

// Node-API addon — ABI-stable
NAPI_MODULE(addon, InitFunction)
```

A Node-API addon compiled on Node 18 can be loaded in Node 24 without recompilation. This is the single most impactful architectural choice for agents that need to survive Node version changes.

`better-sqlite3` as of v9+ ships Node-API bindings. However, because it also ships prebuilt binaries, the binary you get via `npm install` is tagged for the *exact* Node version that ran the install — it is a Node-API binary but still architecture/platform/Node-version-tagged by the prebuild tooling. The prebuilt index (stored in the npm package) maps `NODE_MODULE_VERSION` → tarball URL. This is why re-running `npm install` inside the correct container resolves the problem even though the module is Node-API: the prebuild download selects the right platform-specific binary.

## How Binaries Leak Into Images

### The COPY / .dockerignore trap

A typical Dockerfile for a Node agent:

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY . .
RUN npm install
CMD ["node", "index.js"]
```

And the accompanying `.dockerignore`:

```
node_modules
.git
.env
```

This `.dockerignore` excludes the root `node_modules`. It does **not** exclude `skills/*/node_modules`, `plugins/*/node_modules`, or any nested dependency tree. The glob `node_modules` without a leading `**` only matches the top-level directory.

When `COPY . .` runs, Docker sends the entire build context to the daemon. Every `.node` file under every nested `node_modules` is transferred and copied into the image verbatim. The host-compiled binaries — built for NODE_MODULE_VERSION 137 — are now baked into a Node 22 image.

The subsequent `RUN npm install` at the root installs root-level dependencies correctly (or skips if a lockfile is used with `npm ci`). It does not touch nested `skills/*/node_modules` that already exist. There is no error during build. The binary mismatch is only discovered at runtime.

### Why the failure is invisible at build time

Docker does not execute any JavaScript during build. `COPY` is a filesystem operation. The `module.exports` machinery, `process.dlopen`, and the `NODE_MODULE_VERSION` check all happen inside the Node process — which only runs when `CMD` or `RUN node ...` is invoked. A `RUN node -e "require('./skills/db/node_modules/better-sqlite3')"` health-check line would catch it at build time, but almost nobody adds this.

### Multi-stage builds and bind mounts

Multi-stage builds do not automatically protect against this. If the builder stage uses the same `COPY . .` pattern and the final stage copies `--from=builder /app /app`, the binaries are still present unless the builder stage runs `find . -name '*.node' -delete` before copying, or the final COPY explicitly excludes native files — neither of which is obvious.

Development bind mounts in `docker compose` (mounting the host workspace into the container) surface the same problem in reverse: the container's Node version governs what runs, but the host's `node_modules` tree is mounted read-only and contains host-compiled binaries.

## Prebuilt Binaries vs Source Compilation

### The prebuild ecosystem

Modern native Node packages avoid forcing users to compile from source by shipping prebuilt binaries. The three dominant tools are:

**prebuild-install** (used by `better-sqlite3`, `leveldown`, others): Downloads a platform-specific tarball from GitHub Releases during `npm install`. The tarball URL is constructed from `node abi`, `platform`, `arch`, and `libc` tags. If a matching tarball exists, no compiler is needed.

**node-gyp-build** (same family, slightly different resolution logic): Looks in `prebuilds/<platform>-<arch>/` directories within the package, then falls back to `build/Release/`. This allows the prebuilds to be bundled inside the npm tarball itself rather than fetched from GitHub.

**prebuildify**: A build-time tool (run by the package author) that compiles binaries for all supported platforms and embeds them into the npm tarball. Packages using prebuildify are fully self-contained — `npm install` copies the right binary from the tarball without any network request.

```
# What better-sqlite3's install does internally:
# 1. Check if a prebuilt binary exists for this (node_abi, platform, arch, libc)
# 2. If yes: download and extract — done, no compiler needed
# 3. If no: invoke node-gyp to compile from source (requires toolchain)
```

### What slim and alpine images lack

`node:22-slim` is a Debian slim image: it has glibc, the Node binary, and little else. It lacks:
- `python3` (required by node-gyp)
- `make`
- `g++` / `gcc`
- Development headers

`node:22-alpine` lacks glibc entirely (uses musl libc). This is significant: prebuilt binaries compiled against glibc will fail with `Error loading shared library libstdc++.so.6: No such file or directory` or similar. Alpine-compatible prebuilts must be compiled against musl, and not all packages ship them.

When `npm install` falls back to source compilation in a slim image, the error is:

```
gyp ERR! find Python
gyp ERR! not ok
npm ERR! code 1
npm ERR! path /app/skills/db/node_modules/better-sqlite3
npm ERR! command failed
```

The module ends up absent from the image. The skill silently fails — or fails noisily at first invocation — rather than at build time.

### npm rebuild vs npm ci semantics

`npm rebuild` recompiles all native addons in the current `node_modules` tree against the running Node version. It requires a compiler and triggers a fresh `node-gyp build` (source compile) or a fresh prebuild download, depending on the package's `install` script.

`npm ci` performs a clean install from `package-lock.json`, deleting any existing `node_modules` first. It is the correct tool for reproducible builds. Critically, `npm ci` in the container will re-run the install scripts including prebuild-install, selecting the correct binary for the container's Node version — as long as `node_modules` was absent (i.e., not leaked from the host via `COPY`).

## Detection and Diagnosis

### The error signature

The canonical mismatch error is deterministic:

```
Error: The module '/path/to/addon.node'
was compiled against a different Node.js version using
NODE_MODULE_VERSION <HOST_NMV>. This version of Node.js requires
NODE_MODULE_VERSION <CONTAINER_NMV>.
```

For the Zylos case: `NODE_MODULE_VERSION 137` (host, Node 24) vs `NODE_MODULE_VERSION 127` (image, Node 22).

### Inspecting a .node file's target ABI

Without running JavaScript, you can inspect a `.node` file's target ABI using:

```bash
# Method 1: node --print (loads the file and checks)
node -e "require('/path/to/addon.node')" 2>&1 | grep NODE_MODULE_VERSION

# Method 2: strings extraction (no execution needed)
strings /path/to/better_sqlite3.node | grep NODE_MODULE_VERSION
# Output: NODE_MODULE_VERSION=137

# Method 3: using the 'file' command to confirm it's an ELF shared lib
file /path/to/better_sqlite3.node
# better_sqlite3.node: ELF 64-bit LSB shared object, x86-64, ...

# Method 4: readelf for embedded node metadata
readelf -p .comment /path/to/better_sqlite3.node 2>/dev/null
```

The `strings` approach is the most portable and works inside a container without the full Node toolchain.

### Listing all .node files in a Docker image

```bash
# Inside the container or via docker exec:
find /app -name '*.node' -exec sh -c \
  'echo "--- $1"; strings "$1" | grep -E "NODE_MODULE_VERSION|napi_module"' _ {} \;
```

### Build-time health gates

Add a smoke-test `RUN` layer to the Dockerfile that catches the problem during `docker build`:

```dockerfile
FROM node:22-slim AS runtime
WORKDIR /app

# Correct: exclude ALL node_modules from COPY
COPY . .
# At this point no .node files should be present:
RUN find . -name '*.node' | sort && \
    echo "--- native binary count above, expected 0 before install ---"

# Install per-skill deps
RUN for d in skills/*/; do \
      if [ -f "$d/package.json" ]; then \
        echo "Installing $d" && npm ci --prefix "$d" --omit=dev; \
      fi; \
    done

# Smoke test: require each native dep and confirm it loads
RUN node -e " \
  const Database = require('./skills/db/node_modules/better-sqlite3'); \
  const db = new Database(':memory:'); \
  db.close(); \
  console.log('better-sqlite3 OK'); \
"
```

This makes the image build fail fast if the module is missing or mismatched.

### CI checks before docker build

```bash
# In CI, before docker build, verify .dockerignore covers nested node_modules:
grep -q '\*\*/node_modules' .dockerignore || {
  echo "ERROR: .dockerignore missing **/node_modules glob"
  exit 1
}

# Check for .node files that would be included in the build context:
git ls-files --others --cached --exclude-standard | grep '\.node$' | while read f; do
  echo "WARNING: tracked or unignored .node binary: $f"
done
```

## Mitigation Patterns

### 1. The decisive fix: `**/node_modules` in .dockerignore

```
# .dockerignore — correct form
**/.git
**/.env
**/node_modules
**/npm-debug.log
**/*.node
```

The `**/node_modules` glob uses Docker's recursive glob syntax (which follows `.gitignore` rules). It matches `node_modules` at any depth in the build context. The additional `**/*.node` rule adds defense-in-depth against stray compiled binaries outside of `node_modules`.

This single change prevents the entire class of problem: no host-compiled binary reaches the image, so the container's `npm install` or `npm ci` starts from scratch and downloads the correct prebuilt binary for the container's Node version.

### 2. Per-skill npm ci inside the image

For agents with a plugin/skill architecture, each skill directory has its own `package.json` and `node_modules`. The Dockerfile must install each independently:

```dockerfile
FROM node:22-slim
WORKDIR /app

# Copy source without any compiled artifacts
COPY . .

# Root install
RUN npm ci --omit=dev

# Per-skill install — iterates every skill with a package.json
RUN find skills -maxdepth 2 -name 'package.json' \
      -not -path '*/node_modules/*' \
      -exec sh -c 'dir=$(dirname "$1"); echo "Installing $dir"; npm ci --prefix "$dir" --omit=dev' _ {} \;
```

Using `npm ci` rather than `npm install` is critical for reproducibility: it respects the lockfile exactly, fails on mismatch, and never adds unexpected upgrades.

### 3. Pin Node versions across dev / build / runtime

The failure requires two Node versions to diverge. Pinning prevents the divergence:

```dockerfile
# .nvmrc / .node-version (dev tooling)
22.15.0

# Dockerfile — pin to exact image digest, not just major
FROM node:22.15.0-slim
```

In a monorepo with engines declared in each skill's `package.json`:

```json
{
  "engines": {
    "node": ">=22.0.0 <23.0.0"
  }
}
```

This makes `npm install` warn or fail (`--engine-strict`) if run under the wrong Node version, providing an early signal.

### 4. Multi-stage build with a builder stage

When source compilation is necessary (no prebuilts for the target platform), use a multi-stage build to keep the compiler out of the runtime image:

```dockerfile
# Stage 1: builder — has the full toolchain
FROM node:22-bullseye AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y \
    python3 make g++ \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY skills/ ./skills/
RUN find skills -maxdepth 2 -name 'package.json' \
      -not -path '*/node_modules/*' \
      -exec sh -c \
        'dir=$(dirname "$1"); npm ci --prefix "$dir" --omit=dev' _ {} \;

# Stage 2: runtime — slim, no compiler
FROM node:22-slim
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/skills ./skills
COPY . .

CMD ["node", "index.js"]
```

The `COPY --from=builder` brings across only the compiled artifacts, built in the correct Node environment.

### 5. Prefer N-API modules

When evaluating native dependencies, prefer modules that declare `"napi": true` in their `binary` field (in `package.json`) or advertise Node-API support:

```bash
# Check if a package uses Node-API:
cat node_modules/better-sqlite3/package.json | jq '.binary.napi'
# true

# Or check the .node file itself:
strings node_modules/better-sqlite3/build/Release/better_sqlite3.node \
  | grep -c 'napi_'
# > 0 means Node-API usage
```

N-API modules compiled from source once will survive across Node major upgrades without recompilation. Combined with prebuild tooling, they also eliminate the need for a compiler in most scenarios.

### 6. musl / Alpine compatibility

If the runtime image must be Alpine-based for size reasons, verify that prebuilt binaries are available for `linux-musl`:

```bash
# Check available prebuilds in a package's GitHub releases:
# better-sqlite3 ships: linux-x64, linux-musl-x64, darwin-x64, darwin-arm64, win32-ia32, win32-x64

# Force prebuild-install to use musl target:
npm_config_target_libc=musl npm install better-sqlite3

# Or in package.json install script:
# "install": "prebuild-install --libc musl || node-gyp rebuild"
```

The `node-gyp-build` package auto-detects musl at runtime by checking `/lib/libc.musl-x86_64.so.1`. If the prebuilt index doesn't include a musl binary, the install will fall through to source compilation — which requires `apk add python3 make g++` in the builder stage.

### 7. Lockfile discipline

A `package-lock.json` at lockfile version 3 (npm 7+) records `resolved` URLs and `integrity` SHA-512 hashes for all dependencies including prebuilt binary tarballs. `npm ci` verifies these hashes. This prevents supply-chain substitution and ensures the exact binary that was tested in CI is the binary that runs in production.

```bash
# Verify lockfile is present and committed:
git ls-files package-lock.json | grep -q package-lock.json || {
  echo "ERROR: package-lock.json not committed"
  exit 1
}
```

### 8. npm rebuild as emergency recovery

If the container does have a toolchain and an ABI mismatch is discovered at runtime, `npm rebuild` is the fastest recovery path:

```bash
# Inside a running container with build tools available:
npm rebuild --build-from-source

# For a specific skill:
npm rebuild --prefix skills/db --build-from-source
```

This is a recovery mechanism, not a design strategy. Relying on it implies the runtime image has developer tools — a security and size concern.

## Relevance to AI Agent Runtimes Specifically

### The pluggable-skill architecture amplifies exposure

A standard Node.js application has one `node_modules` tree and one set of native binaries. An AI agent with a pluggable skill system — like Zylos — has N skill directories each with their own `node_modules`. Each skill is independently authored, may ship at different times, and can depend on different native packages. The surface area for ABI mismatch scales with the number of skills.

Worse, skills are often installed incrementally via a package manager CLI (`zylos add <skill>`) rather than declared up-front in a root `package.json`. This means a freshly built image may be correct on day zero, but skills added post-build via volume mount or live install will use whatever Node version is running at install time — which may differ from the image's build-time Node version if the agent is upgraded in place.

### Runtime switching and golden workspace images

Some agent platforms support switching between LLM runtimes (Claude Code, Codex, etc.) while preserving workspace state. If the workspace is a Docker volume or a baked image, the native binaries it contains are stamped to the Node version that was running when they were installed. Switching to a new runtime that uses a different Node version will break every native addon in the workspace.

The mitigation is to treat native binaries as ephemeral, non-persisted artifacts:
- Store only source code and lockfiles on the persistent volume
- Rebuild native deps on container startup using a startup script (`npm ci` or `npm rebuild`)
- Or pin the Node version across all runtime variants

```bash
# startup.sh — run before the agent starts
#!/usr/bin/env bash
set -euo pipefail

echo "Rebuilding native dependencies for Node $(node --version)..."
find /workspace/skills -maxdepth 2 -name 'package.json' \
  -not -path '*/node_modules/*' \
  -exec sh -c 'dir=$(dirname "$1"); npm ci --prefix "$dir" --omit=dev 2>&1' _ {} \;
echo "Done."
```

### Diagnostic tooling for agent platforms

An agent health-check endpoint should include native module status:

```javascript
// health.js — included in agent startup diagnostics
const NATIVE_SKILLS = [
  { name: 'db', mod: 'better-sqlite3' },
  // ...
];

async function checkNativeModules() {
  const results = [];
  for (const { name, mod } of NATIVE_SKILLS) {
    try {
      require(`./skills/${name}/node_modules/${mod}`);
      results.push({ skill: name, status: 'ok' });
    } catch (err) {
      results.push({ skill: name, status: 'error', message: err.message });
    }
  }
  return results;
}
```

Running this at container startup turns a silent runtime failure into a loud boot-time failure — the best possible outcome for a CI gate or health probe.

### The tension between image size and native correctness

`node:22-slim` produces smaller images and has a smaller attack surface than `node:22-bullseye`. But the absence of a compiler toolchain means the image is entirely dependent on prebuilt binaries. This is fine when prebuilts exist for all native deps on all target platforms. It becomes a problem when:

1. A skill adds an obscure native dependency without official prebuilts.
2. The target platform (ARM, Alpine/musl) lacks a prebuilt index entry.
3. A security vulnerability forces an emergency upgrade to a Node patch version for which no prebuilt is yet available.

The architectural answer is to separate the concerns: use a multi-stage build with a `builder` stage that has the full toolchain, produce compiled artifacts, and copy them into a slim runtime. The runtime image stays small and secure; the builder image exists only during CI and is never deployed.

## Reference: Quick Diagnosis Checklist

```bash
# 1. What NODE_MODULE_VERSION does this container require?
node -e "console.log(process.versions.modules)"

# 2. What is compiled into a .node file?
strings /path/to/addon.node | grep NODE_MODULE_VERSION

# 3. Find all .node files in the project (should be 0 before install):
find . -name '*.node' -not -path '*/build/*'

# 4. Verify .dockerignore covers nested node_modules:
grep '\*\*/node_modules' .dockerignore

# 5. Check if a package ships prebuilts for this platform:
node -e "
  const { platform, arch } = process;
  const pkg = require('./node_modules/better-sqlite3/package.json');
  console.log(pkg.binary);
"

# 6. Force a clean reinstall for one skill:
rm -rf skills/db/node_modules && npm ci --prefix skills/db
```
