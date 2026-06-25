---
date: "2026-06-26"
title: "Agent Subprocess Isolation: Nested Sandboxing, Runtime Adapters, and Process Supervision Patterns"
description: "How production AI agent systems manage LLM subprocesses inside sandboxed environments — covering nested bwrap/SRT conflicts, runtime adapter abstractions, process supervision with timeout escalation, CLI-vs-API tradeoffs, and filesystem isolation patterns."
tags:
  - ai-agents
  - subprocess-management
  - sandboxing
  - bwrap
  - process-supervision
  - runtime-adapters
  - isolation
  - security
---

## Executive Summary

Production AI agent systems that spawn LLM subprocesses face a trilemma: security isolation, tool functionality, and operational reliability. When an orchestrator runs `claude -p` or `codex exec` inside a sandboxed runtime environment, nested containerization creates permission conflicts that silently break inner tool operations (Edit, Write, file manipulation). Meanwhile, 10+ minute generation times demand robust process supervision with proper timeout escalation and orphan cleanup. This article provides a deep technical treatment of sandbox nesting architecture, runtime adapter abstractions, process supervision patterns, and the CLI-vs-API tradeoff space, drawn from real-world implementations in systems like Flatpak, Codex's linux-sandbox, Claude Code's SRT, and Docker-in-Docker deployments.

The core insight: rather than nesting sandboxes, production systems should adopt single-layer isolation with capability passthrough, or decompose the problem into an outer filesystem policy layer and an inner network/process policy layer that do not conflict on namespace creation. For process management, the combination of process groups (`setsid`), tiered signal escalation (SIGTERM then SIGKILL), and activity-based timeouts provides the most resilient supervision model for long-running AI calls.

---

## Sandbox Nesting Architecture

### How Nested Containerization Creates Permission Conflicts

When a production agent system wraps an LLM subprocess in a sandbox, and that subprocess itself attempts to create a sandbox for its tool operations, you get a "sandbox-in-sandbox" conflict. The fundamental problem is that unprivileged Linux sandboxing relies on user namespaces, and the kernel imposes strict rules on nesting them.

The typical failure chain:

```
Orchestrator (host)
  └─ Outer Sandbox (bwrap --unshare-user --unshare-pid --unshare-net)
       └─ claude -p  (wants to create inner sandbox for Edit tool)
            └─ Inner bwrap --unshare-user  ← FAILS: Permission denied
```

The inner `bwrap` call fails because the outer sandbox has already consumed the ability to create further user namespaces. The process inside the outer namespace does not hold `CAP_SETUID` in the parent namespace, which is required to write UID/GID maps for a nested user namespace.

Observed error messages from real deployments:

```
bwrap: setting up uid map: Permission denied
bwrap: No permissions to create new namespace, likely because the kernel
       does not allow non-privileged user namespaces
unshare: write failed /proc/self/uid_map: Operation not permitted
bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
```

### Bubblewrap Internals: User Namespaces, Seccomp, and Bind Mounts

Bubblewrap (`bwrap`) is the unprivileged sandboxing tool used by Flatpak, GNOME, and increasingly by AI agent runtimes (Codex linux-sandbox, Claude Code SRT). Understanding its internals is essential for diagnosing nesting failures.

**Namespace creation sequence:**

1. `clone(CLONE_NEWUSER)` creates a new user namespace where the caller gets a full capability set
2. UID/GID maps are written to `/proc/self/uid_map` and `/proc/self/gid_map` (one-time write, max 340 lines since Linux 4.16)
3. Additional namespaces (PID, NET, IPC, UTS, cgroup) are created within the new user namespace
4. Filesystem view is constructed via bind mounts, tmpfs, procfs, and devtmpfs mounts
5. Optional seccomp filters restrict available syscalls

**Key bwrap mount options:**

| Option | Effect |
|--------|--------|
| `--bind SRC DEST` | Read-write bind mount |
| `--ro-bind SRC DEST` | Read-only bind mount |
| `--tmpfs DEST` | Fresh tmpfs at DEST |
| `--dev DEST` | New devtmpfs |
| `--proc DEST` | New procfs |
| `--perms OCTAL` | Set permissions (modifier, precedes --tmpfs/--dir) |
| `--size BYTES` | Set tmpfs size limit |
| `--die-with-parent` | Kill sandbox when parent dies |
| `--new-session` | `setsid()` for terminal session isolation |
| `--disable-userns` | Prevent nested user namespace creation |

**The `--disable-userns` flag** (bubblewrap 0.8.0+) explicitly sets `user.max_user_namespaces` to 1 inside the sandbox, preventing any nested namespace creation. Flatpak adopted this (PR #5084) to close sandbox escape vectors via recursive user namespaces. This replaced an older seccomp-based approach with a kernel-level restriction.

### Why Nested Bwrap Fails: Unprivileged User Namespace Restrictions

The Linux kernel (since 3.11) allows up to 32 levels of nested user namespaces, but the practical limit for unprivileged nesting is almost always 1 level, due to capability propagation rules:

1. **UID map writing requires parent capabilities.** To write `/proc/self/uid_map` in a child namespace, you need `CAP_SETUID` in the parent namespace. Inside an already-unprivileged user namespace, these capabilities do not propagate outward.

2. **The `setgroups` control is irreversible.** Writing "deny" to `/proc/[pid]/setgroups` blocks all `setgroups()` calls permanently and propagates to all child namespaces. Once denied, it cannot be re-enabled.

3. **Distribution-level restrictions.** Many distributions add additional barriers:
   - Debian: `kernel.unprivileged_userns_clone` sysctl (0 = disabled)
   - Ubuntu 24.04+: AppArmor-based per-binary control via `kernel.apparmor_restrict_unprivileged_userns`
   - RHEL/Fedora: `user.max_user_namespaces=0` disables namespace allocation system-wide

4. **Security motivation.** Research from Edera (2026) quantified the attack surface expansion: unprivileged user namespaces increase reachable kernel attack surface by 3.4x (from 8 of 40 kernel operations to 27 of 40). Over 40 CVEs from 2020-2025 exploited this expanded surface, concentrated in netfilter/nf_tables.

**Verification command:**
```bash
# Inside a sandbox, this should print PASS (nested namespace denied)
unshare -Ur true && echo FAIL || echo PASS
```

### Solutions: Single-Layer Isolation and Shared Namespace Approaches

**Solution 1: Two-Layer Complementary Isolation**

Instead of nesting identical sandboxes, split responsibilities between layers that do not conflict on namespace creation:

```
Outer bwrap: filesystem visibility + process isolation
  (--unshare-pid --unshare-uts --unshare-ipc, but NOT --unshare-user or --unshare-net)
Inner sandbox (Claude Code/Codex): network policy + additional restrictions
  (can create its own user namespace because outer didn't consume the capability)
```

Real-world example from the Esokia Labs two-layer approach:

```bash
bwrap \
  --unshare-pid \
  --unshare-uts \
  --unshare-ipc \
  --new-session \
  --die-with-parent \
  --clearenv \
  --setenv HOME "$HOME" \
  --setenv PATH "$PATH" \
  --setenv TERM "$TERM" \
  --ro-bind /usr /usr \
  --ro-bind /etc/resolv.conf /etc/resolv.conf \
  --ro-bind /etc/ssl /etc/ssl \
  --ro-bind "$HOME/.local/bin" "$HOME/.local/bin" \
  --ro-bind "$HOME/.local/share/claude" "$HOME/.local/share/claude" \
  --bind "$PROJECT_DIR" "$PROJECT_DIR" \
  --bind "$HOME/.claude" "$HOME/.claude" \
  --bind "$HOME/.claude.json" "$HOME/.claude.json" \
  --perms 0555 --dir "$HOME" \
  --tmpfs /tmp \
  --proc /proc \
  --dev /dev \
  claude
```

The critical detail: `--unshare-user` is intentionally omitted from the outer layer, leaving the inner sandbox free to create its own user namespace for seccomp and network isolation.

**Solution 2: Weaker Inner Sandbox**

Both Claude Code and Codex support degraded sandbox modes for nested operation:

- **`enableWeakerNestedSandbox`** (Claude Code): When running inside an unprivileged container, bwrap cannot mount a fresh `/proc`. This setting makes the inner sandbox bind-mount the container's existing `/proc` instead of creating a new one. The docs explicitly note this "considerably weakens security."
- **`sandbox_mode = "none"`** (Codex): Completely disables the inner sandbox when the outer container provides sufficient isolation.

**Solution 3: Single-Layer with Capability Passthrough**

Eliminate nesting entirely. The orchestrator's sandbox provides all isolation, and the inner process runs unsandboxed:

```
┌──────────────────────────────────────────────┐
│  Orchestrator Sandbox (bwrap)                │
│  ┌────────────────────────────────────────┐  │
│  │  claude -p (no inner sandbox)          │  │
│  │  --dangerously-skip-permissions        │  │
│  │  Full Read/Edit/Write within sandbox   │  │
│  └────────────────────────────────────────┘  │
│  Filesystem policy: ro-bind /, rw-bind /tmp  │
│  Network policy: --unshare-net (no network)  │
└──────────────────────────────────────────────┘
```

This is the most practical approach for production AI agent systems where the outer sandbox is already well-defined.

### Real Examples: Flatpak and Docker-in-Docker Pitfalls

**Flatpak:** The canonical case of nested sandbox failure. Flatpak uses bwrap for application sandboxing and explicitly prevents nested namespace creation. As documented in their wiki: "You can't run bubblewrap nested, as sandboxed applications don't have permission to create namespaces." The workaround is XDG Desktop Portal, which mediates between sandbox and host through a controlled API rather than allowing arbitrary namespace creation.

**Docker-in-Docker (DinD):** The original DinD creator (Jpetazzo) published a widely-cited warning against it, identifying four critical problems:

1. **Privileged container requirement:** DinD needs `--privileged`, granting host-equivalent capabilities
2. **Storage driver conflicts:** AUFS cannot stack on AUFS; BTRFS nesting fails on subvolume removal; Device Mapper is not namespaced
3. **LSM conflicts:** Inner Docker's AppArmor/SELinux profiles interfere with outer Docker's security mechanisms
4. **Build cache corruption:** Sharing `/var/lib/docker` between Docker instances causes unpredictable failures

The production solution is Sysbox (now Docker-owned), an OCI runtime that enables DinD without `--privileged` via UID remapping:

```bash
docker run --runtime=sysbox-runc --name dind-syscont -d docker:dind
```

---

## Runtime Adapter Pattern

### Abstracting CLI Subprocess, HTTP API, and SDK Backends

A production agent system must support multiple LLM backends without coupling business logic to a specific invocation method. The runtime adapter pattern provides this abstraction:

```
┌─────────────────────────────────────────────────┐
│              Agent Orchestrator                  │
│                     │                            │
│            ┌────────┴────────┐                   │
│            │  RuntimeAdapter  │  (interface)     │
│            └────────┬────────┘                   │
│     ┌───────────────┼───────────────┐            │
│     ▼               ▼               ▼            │
│ ┌────────┐   ┌────────────┐  ┌───────────┐      │
│ │CLI Proc│   │ HTTP API   │  │ SDK Direct│      │
│ │Adapter │   │ Adapter    │  │ Adapter   │      │
│ └────┬───┘   └─────┬──────┘  └─────┬─────┘      │
│      │             │               │             │
│  claude -p    POST /messages   anthropic.        │
│  codex exec                    messages.create   │
└─────────────────────────────────────────────────┘
```

### Capability Declaration Per Backend

Each backend supports different capabilities. The adapter must declare what it can do:

```typescript
interface RuntimeCapabilities {
  supportsStreaming: boolean;
  supportsToolUse: boolean;
  supportedTools: ('Read' | 'Edit' | 'Write' | 'Bash' | 'WebSearch')[];
  maxOutputTokens: number;
  supportsExtendedThinking: boolean;
  supportsPromptCaching: boolean;
  sandboxCompatible: boolean;     // Can run inside bwrap
  requiresFilesystemAccess: boolean;
  startupOverheadMs: number;      // Typical cold start time
}

interface RuntimeAdapter {
  readonly name: string;
  readonly capabilities: RuntimeCapabilities;

  execute(request: GenerationRequest): Promise<GenerationResult>;
  stream(request: GenerationRequest): AsyncIterable<GenerationChunk>;
  abort(): Promise<void>;
  healthCheck(): Promise<boolean>;
}
```

### Example Interface Design in TypeScript/Node.js

```typescript
// --- Types ---

interface GenerationRequest {
  systemPrompt: string;
  userMessage: string;
  model?: string;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
  tools?: ToolDefinition[];
  timeout?: number;
  allowedPaths?: string[];  // Filesystem access for tool-using models
}

interface GenerationResult {
  content: string;
  usage: { inputTokens: number; outputTokens: number };
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'timeout';
  durationMs: number;
  backend: string;
}

interface GenerationChunk {
  type: 'text' | 'tool_use' | 'thinking' | 'error';
  content: string;
  index: number;
}

// --- CLI Subprocess Adapter ---

class CLISubprocessAdapter implements RuntimeAdapter {
  readonly name = 'claude-cli';
  readonly capabilities: RuntimeCapabilities = {
    supportsStreaming: true,
    supportsToolUse: true,
    supportedTools: ['Read', 'Edit', 'Write', 'Bash', 'WebSearch'],
    maxOutputTokens: 128000,
    supportsExtendedThinking: true,
    supportsPromptCaching: false,  // Managed internally by CLI
    sandboxCompatible: false,      // Nested sandbox issues
    requiresFilesystemAccess: true,
    startupOverheadMs: 3000,
  };

  async execute(request: GenerationRequest): Promise<GenerationResult> {
    const args = this.buildArgs(request);
    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,  // New process group for clean cleanup
      env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL: '1' },
    });

    // Feed prompt via stdin
    child.stdin.write(request.userMessage);
    child.stdin.end();

    return this.collectOutput(child, request.timeout);
  }

  private buildArgs(request: GenerationRequest): string[] {
    const args = ['-p', '--output-format', 'stream-json'];
    if (request.model) args.push('--model', request.model);
    if (request.maxTokens) args.push('--max-tokens', String(request.maxTokens));
    if (request.allowedPaths) {
      for (const p of request.allowedPaths) {
        args.push('--allowedTools', `Edit:${p}`, '--allowedTools', `Write:${p}`);
      }
    }
    return args;
  }
}

// --- HTTP API Adapter ---

class APIAdapter implements RuntimeAdapter {
  readonly name = 'claude-api';
  readonly capabilities: RuntimeCapabilities = {
    supportsStreaming: true,
    supportsToolUse: true,
    supportedTools: [],  // No filesystem tools — API runs remotely
    maxOutputTokens: 128000,
    supportsExtendedThinking: true,
    supportsPromptCaching: true,
    sandboxCompatible: true,  // No subprocess, no sandbox conflict
    requiresFilesystemAccess: false,
    startupOverheadMs: 0,
  };

  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async execute(request: GenerationRequest): Promise<GenerationResult> {
    const startTime = Date.now();
    const response = await this.client.messages.create({
      model: request.model ?? 'claude-sonnet-4-20250514',
      max_tokens: request.maxTokens ?? 8192,
      system: request.systemPrompt,
      messages: [{ role: 'user', content: request.userMessage }],
    });

    return {
      content: response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join(''),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      stopReason: response.stop_reason as GenerationResult['stopReason'],
      durationMs: Date.now() - startTime,
      backend: this.name,
    };
  }
}
```

### Streaming vs Batch Output Handling

The CLI subprocess adapter has a critical difference from the API adapter in how it handles output:

**CLI (`--output-format stream-json`):** Output arrives as newline-delimited JSON on stdout. Each line is a complete JSON object with a `type` field. The stream must be parsed line-by-line and reassembled:

```typescript
async *stream(request: GenerationRequest): AsyncIterable<GenerationChunk> {
  const child = spawn('claude', this.buildArgs(request), {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdin.write(request.userMessage);
  child.stdin.end();

  const rl = readline.createInterface({ input: child.stdout });
  for await (const line of rl) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          yield { type: block.type, content: block.text ?? '', index: 0 };
        }
      }
    } catch { /* skip malformed lines */ }
  }
}
```

**API (SSE streaming):** The Anthropic SDK provides a high-level streaming interface with typed events:

```typescript
async *stream(request: GenerationRequest): AsyncIterable<GenerationChunk> {
  const stream = this.client.messages.stream({
    model: request.model ?? 'claude-sonnet-4-20250514',
    max_tokens: request.maxTokens ?? 8192,
    system: request.systemPrompt,
    messages: [{ role: 'user', content: request.userMessage }],
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') {
        yield { type: 'text', content: event.delta.text, index: event.index };
      }
    }
  }
}
```

The SSE stream follows a well-defined event sequence: `message_start` -> `content_block_start` -> `content_block_delta` (repeated) -> `content_block_stop` -> `message_delta` -> `message_stop`. Each delta carries typed content (`text_delta`, `input_json_delta`, `thinking_delta`, `signature_delta`).

---

## Process Supervision for AI Calls

### Spawning Long-Running LLM Processes with Proper Stdio Handling

AI subprocess calls routinely run for 60-600+ seconds. Standard subprocess patterns (spawn, wait, collect) are inadequate. The key requirements:

1. **Process group isolation** via `setsid` / `detached: true`
2. **Non-blocking stdout consumption** to prevent pipe buffer deadlock
3. **Activity monitoring** to detect hung processes
4. **Clean shutdown** with signal escalation

**The pipe buffer deadlock problem:** Linux pipe buffers are 64KB by default. When a subprocess writes more data than the pipe buffer can hold, it blocks until the parent reads. If the parent is waiting for the child to exit before reading, you get a deadlock. Node.js `exec()` buffers all output in memory with a default `maxBuffer` of 1MB and throws `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` if exceeded. More subtly, `spawn()` has an undocumented behavior where execution pauses when stdout exceeds ~200KB and is not being consumed, caused by Node.js's stream backpressure (highWaterMark threshold). The fix: always attach a data listener to stdout, even an empty one (`child.stdout.on('data', () => {})`), or call `child.stdout.resume()`.

**The shell kill problem (Node.js #2098):** When spawning through a shell (`sh -c "command"`), calling `child.kill()` only kills the shell process, not the command running inside it. The inner command becomes an orphan. This is why `detached: true` combined with negative PID killing is mandatory:

```typescript
import { spawn, ChildProcess } from 'child_process';

class SupervisedProcess {
  private child: ChildProcess | null = null;
  private pgid: number | null = null;
  private lastActivity: number = Date.now();
  private outputChunks: Buffer[] = [];
  private totalOutputBytes: number = 0;
  private readonly maxOutputBytes: number;

  constructor(
    private command: string,
    private args: string[],
    private options: {
      wallClockTimeoutMs: number;
      activityTimeoutMs: number;
      maxOutputBytes: number;
      onActivity?: (chunk: string) => void;
    }
  ) {
    this.maxOutputBytes = options.maxOutputBytes;
  }

  async run(stdin?: string): Promise<{ stdout: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      this.child = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,  // Create new process group
      });

      this.pgid = this.child.pid;

      // Feed stdin and close
      if (stdin) {
        this.child.stdin?.write(stdin);
      }
      this.child.stdin?.end();

      // Consume stdout without blocking
      this.child.stdout?.on('data', (chunk: Buffer) => {
        this.lastActivity = Date.now();
        this.totalOutputBytes += chunk.length;

        if (this.totalOutputBytes <= this.maxOutputBytes) {
          this.outputChunks.push(chunk);
        }
        // Beyond max: keep updating lastActivity but drop data (OOM prevention)

        this.options.onActivity?.(chunk.toString());
      });

      // Consume stderr (prevent buffer deadlock)
      this.child.stderr?.on('data', () => {
        this.lastActivity = Date.now();
      });

      // Set up timeout watchers
      const wallClockTimer = setTimeout(() => {
        this.killTree('Wall clock timeout');
        reject(new Error(`Wall clock timeout after ${this.options.wallClockTimeoutMs}ms`));
      }, this.options.wallClockTimeoutMs);

      const activityChecker = setInterval(() => {
        const idleMs = Date.now() - this.lastActivity;
        if (idleMs > this.options.activityTimeoutMs) {
          clearInterval(activityChecker);
          this.killTree('Activity timeout');
          reject(new Error(`Activity timeout: no output for ${idleMs}ms`));
        }
      }, 5000);

      this.child.on('exit', (code) => {
        clearTimeout(wallClockTimer);
        clearInterval(activityChecker);
        const stdout = Buffer.concat(this.outputChunks).toString();
        resolve({ stdout, exitCode: code ?? 1 });
      });

      this.child.on('error', (err) => {
        clearTimeout(wallClockTimer);
        clearInterval(activityChecker);
        reject(err);
      });
    });
  }

  private killTree(reason: string): void {
    if (!this.pgid) return;
    console.warn(`Killing process tree (pgid=${this.pgid}): ${reason}`);

    try {
      // SIGTERM to entire process group (negative PID)
      process.kill(-this.pgid, 'SIGTERM');
    } catch { /* already dead */ }

    // Escalate to SIGKILL after grace period
    setTimeout(() => {
      try {
        process.kill(-this.pgid!, 'SIGKILL');
      } catch { /* already dead */ }
    }, 5000);
  }
}
```

### Timeout Strategies: Wall Clock vs Activity-Based

Three timeout strategies serve different failure modes:

| Strategy | Detects | Configuration |
|----------|---------|---------------|
| **Wall clock** | Runaway generation, infinite loops | Hard cap: 600s for complex tasks, 120s for simple |
| **Activity-based** | Hung process, network stall | No stdout/stderr for 60s triggers kill |
| **Token-based** | Cost control, output bloat | Monitor streamed token count, abort at threshold |

The most robust approach combines all three:

```typescript
const timeoutConfig = {
  simple: { wallClockMs: 120_000, activityMs: 30_000, maxTokens: 8192 },
  complex: { wallClockMs: 600_000, activityMs: 60_000, maxTokens: 32768 },
  generation: { wallClockMs: 900_000, activityMs: 120_000, maxTokens: 128000 },
};
```

### Signal Handling: SIGTERM -> Wait -> SIGKILL Escalation

Linux process termination requires a disciplined escalation sequence:

```
1. SIGTERM (-15) to process group  →  "Please shut down gracefully"
2. Wait 5 seconds                  →  Allow cleanup, flush buffers
3. Check if still alive            →  Read /proc/<pid>/status
4. SIGKILL (-9) to process group   →  "Forcefully terminate now"
5. waitpid() to reap zombies       →  Prevent zombie accumulation
```

The critical detail is using **negative PID** to target the entire process group:

```bash
# Kill process group led by PID 12345
kill -TERM -12345    # SIGTERM to all processes in group
sleep 5
kill -KILL -12345    # SIGKILL if still alive
```

In Node.js:

```typescript
// child was spawned with { detached: true }
// child.pid is the process group leader
process.kill(-child.pid, 'SIGTERM');

setTimeout(() => {
  try {
    // Check if process still exists
    process.kill(-child.pid, 0);  // Signal 0 = existence check
    // Still alive, escalate
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Already dead, good
  }
}, 5000);
```

### Process Subreaping: Capturing Orphans Before PID 1

Rather than scanning `/proc` for orphans after the fact, the Linux kernel (3.4+) provides `PR_SET_CHILD_SUBREAPER`, which lets a supervisor intercept orphaned descendants before they reach PID 1:

```c
#include <sys/prctl.h>
prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0);
```

When a process marked as subreaper is running, any orphaned descendant (at any depth) is reparented to the subreaper instead of init. The subreaper receives `SIGCHLD` for these orphans and must call `wait()` to reap them. This is the mechanism used by Docker/containerd, Chrome, and systemd to track multi-generational process hierarchies.

Key properties:
- The subreaper flag is NOT inherited by children via `fork()`/`clone()`
- It IS preserved across `execve()`
- Reparenting walks up the ancestor chain: first to the nearest subreaper, then to PID 1

In Node.js, this can be set via a native addon or by spawning through a wrapper that calls `prctl`:

```bash
# prctl-subreaper wrapper (C)
# Compile: gcc -o subreaper subreaper.c
# Usage: ./subreaper node orchestrator.js
#include <sys/prctl.h>
#include <unistd.h>
int main(int argc, char **argv) {
    prctl(PR_SET_CHILD_SUBREAPER, 1);
    execvp(argv[1], &argv[1]);
}
```

### Signal Escalation Across Supervisors

The SIGTERM-wait-SIGKILL pattern is universal across process supervision systems, but with varying defaults:

| Supervisor | Default Grace Period | Kill Target | Notes |
|-----------|---------------------|-------------|-------|
| **systemd** | 90 seconds | cgroup (all processes in unit) | `KillMode=control-group` is default |
| **Docker** | 10 seconds | Container PID namespace | `docker stop --time=N` |
| **Kubernetes** | 30 seconds | Pod | `terminationGracePeriodSeconds` |
| **PM2** | 1.6 seconds | Process + children | `kill_timeout` setting |

For AI agent subprocesses, the PM2 default of 1.6s is far too short (a Claude CLI process may need 5-10s to flush output). Kubernetes' 30s is reasonable for most AI calls. For generation-heavy workloads (600+ seconds), a custom grace period of 15-30s is appropriate since the subprocess is unlikely to produce meaningful additional output after SIGTERM.

### PM2 Integration for Agent Process Supervision

PM2 provides crash loop prevention that is directly useful for AI agent supervisors:

```javascript
// ecosystem.config.js for AI agent subprocess manager
module.exports = {
  apps: [{
    name: 'agent-supervisor',
    script: './supervisor.js',
    min_uptime: '10s',           // Must run 10s to count as stable
    max_restarts: 10,            // Stop after 10 rapid crashes
    exp_backoff_restart_delay: 100, // 100ms → 150ms → 225ms → ... → 15s max
    max_memory_restart: '500M',  // Kill if OOM (LLM output buffering)
    kill_timeout: 15000,         // 15s for graceful shutdown
    listen_timeout: 8000,        // 8s to declare "ready"
    autorestart: true,
  }]
};
```

PM2's exponential backoff restart delay (100ms base, 15s max, reset after 30s stable uptime) prevents rapid crash loops when an API is down, while ensuring fast recovery from transient failures.

### Orphan Detection Using /proc

When a supervisor crashes (or subreaping is not available), child processes become orphans reparented to PID 1. Detect and clean these up:

```typescript
import { readdirSync, readFileSync } from 'fs';

function findOrphanedAgentProcesses(markerEnvVar: string): number[] {
  const orphans: number[] = [];
  const procs = readdirSync('/proc').filter(f => /^\d+$/.test(f));

  for (const pid of procs) {
    try {
      const environ = readFileSync(`/proc/${pid}/environ`, 'utf-8');
      if (environ.includes(markerEnvVar)) {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
        const ppid = parseInt(stat.split(' ')[3]);
        if (ppid === 1) {
          // Parent is init — this is an orphan
          orphans.push(parseInt(pid));
        }
      }
    } catch { /* permission denied or process exited */ }
  }
  return orphans;
}

// Usage: mark agent subprocesses with environment variable
spawn('claude', ['-p'], {
  env: { ...process.env, ZYLOS_AGENT_MARKER: 'subprocess-v1' },
  detached: true,
});

// Periodic cleanup
setInterval(() => {
  const orphans = findOrphanedAgentProcesses('ZYLOS_AGENT_MARKER');
  for (const pid of orphans) {
    console.warn(`Cleaning up orphaned agent process: ${pid}`);
    process.kill(pid, 'SIGKILL');
  }
}, 60_000);
```

### Buffering Large Outputs Without OOM

LLM outputs can be enormous (100K+ tokens of generated code or HTML). Naive buffering with `Buffer.concat()` risks OOM. Strategies:

1. **Capped buffer with tail retention:** Keep the first N bytes and last N bytes, discarding the middle:

```typescript
class CappedBuffer {
  private head: Buffer[] = [];
  private tail: Buffer[] = [];
  private headBytes = 0;
  private totalBytes = 0;
  private readonly headCap: number;
  private readonly tailCap: number;

  constructor(headCap: number = 1_000_000, tailCap: number = 100_000) {
    this.headCap = headCap;
    this.tailCap = tailCap;
  }

  append(chunk: Buffer): void {
    this.totalBytes += chunk.length;
    if (this.headBytes < this.headCap) {
      this.head.push(chunk);
      this.headBytes += chunk.length;
    } else {
      this.tail.push(chunk);
      // Trim tail to stay within cap
      while (this.tailSize() > this.tailCap && this.tail.length > 1) {
        this.tail.shift();
      }
    }
  }

  private tailSize(): number {
    return this.tail.reduce((sum, b) => sum + b.length, 0);
  }

  toString(): string {
    const headStr = Buffer.concat(this.head).toString();
    const tailStr = Buffer.concat(this.tail).toString();
    if (this.totalBytes > this.headCap) {
      return `${headStr}\n\n... [${this.totalBytes - this.headBytes} bytes truncated] ...\n\n${tailStr}`;
    }
    return headStr;
  }
}
```

2. **Stream to disk:** Write output to a temporary file and read back only what is needed:

```typescript
const tmpFile = `/tmp/agent-output-${child.pid}.jsonl`;
const outputStream = createWriteStream(tmpFile);
child.stdout.pipe(outputStream);

child.on('exit', () => {
  outputStream.end();
  // Read only the final result from the file
  const result = extractFinalResult(tmpFile);
  unlinkSync(tmpFile);
});
```

---

## CLI Subprocess vs Direct API Tradeoffs

### Startup Overhead

CLI subprocesses carry significant initialization cost:

| Phase | CLI Subprocess | Direct API |
|-------|---------------|------------|
| Process spawn | 50-200ms | 0ms |
| Node.js/runtime init | 500-1500ms | 0ms (already loaded) |
| Config loading (CLAUDE.md, settings) | 200-500ms | 0ms |
| Authentication | 100-300ms | Per-request header |
| MCP server discovery | 500-2000ms | N/A |
| **Total cold start** | **~3-5 seconds** | **~50ms** |

Each CLI subprocess also inherits the entire global configuration. Measurements show ~50K tokens per turn consumed by system prompt, project instructions, plugin descriptions, and MCP server tool definitions, before any actual work begins. Over 5 turns, this accumulates to ~250K tokens. The four-layer isolation solution (scoped working directory, git boundary, empty plugin directory, restricted settings sources) reduces this to ~25K tokens total -- a 10x improvement.

### Credential Isolation Benefits of CLI

The CLI subprocess model has a significant security advantage: credentials never transit through the orchestrator's memory space. The CLI reads API keys from its own config files (`~/.claude.json`, environment variables) and manages authentication independently. This means:

- The orchestrator does not need to handle or store API keys
- Credential rotation happens at the CLI level without orchestrator changes
- Each subprocess can use different credentials (useful for multi-tenant systems)
- Credential leakage via orchestrator memory dumps is impossible

### Sandbox Compatibility Differences

This is the most impactful practical difference:

| Aspect | CLI Subprocess | Direct API |
|--------|---------------|------------|
| Needs filesystem access | Yes (for Edit, Write, Bash tools) | No |
| Creates inner sandbox | Yes (bwrap for tool isolation) | No |
| Nested sandbox conflicts | Yes (the core problem) | N/A |
| Network access required | Yes (API calls to Anthropic) | Yes |
| Can run in --unshare-net | No (needs HTTPS) | Only with network proxy passthrough |

For sandboxed environments, the API adapter eliminates nested sandbox conflicts entirely because there is no subprocess to sandbox. The orchestrator makes HTTP calls directly, which works even inside bwrap with network access.

### Partial Output Salvage on Crash

When a CLI subprocess crashes mid-generation, partial output may be recoverable from the stdout pipe buffer. When an API call fails mid-stream, partial output from received SSE events is already in the caller's memory:

```typescript
// API adapter: partial output is inherently available
let partialContent = '';
try {
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      partialContent += event.delta.text;
    }
  }
} catch (error) {
  // partialContent has everything received before the crash
  return { content: partialContent, partial: true, error: error.message };
}

// CLI adapter: must reconstruct from collected chunks
child.on('exit', (code, signal) => {
  if (signal === 'SIGKILL' || code !== 0) {
    const partialOutput = Buffer.concat(outputChunks).toString();
    // Parse any complete JSON lines from stream-json output
    const lines = partialOutput.split('\n').filter(Boolean);
    const validResults = lines.map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    // Reconstruct partial result from valid events
  }
});
```

---

## Filesystem Isolation for Tool-Using Agents

### allowRead/allowWrite/denyRead Layering

Production agent systems need fine-grained filesystem policies. The pattern is a three-layer permission model:

```
┌─────────────────────────────────────────┐
│ Layer 3: denyRead / denyWrite           │
│  Explicit blocks (credentials, secrets) │
├─────────────────────────────────────────┤
│ Layer 2: allowWrite                     │
│  Explicit writable paths (project, tmp) │
├─────────────────────────────────────────┤
│ Layer 1: allowRead (default)            │
│  Broad read access (system libs, etc.)  │
└─────────────────────────────────────────┘
```

Deny rules take precedence over allow rules. In bwrap, this layering is achieved through mount order (later mounts overlay earlier ones):

```bash
bwrap \
  --ro-bind / /                           \  # Layer 1: everything read-only
  --bind /home/user/project /home/user/project \  # Layer 2: project writable
  --bind /tmp/agent-workspace /tmp        \  # Layer 2: tmp writable
  --ro-bind /home/user/.env /home/user/.env \  # Layer 3: secrets read-only
  --ro-bind /home/user/.ssh /home/user/.ssh \  # Layer 3: SSH keys read-only
  command
```

### Temp Directory Management

Each agent subprocess should get an isolated `/tmp` to prevent cross-agent data leakage and filesystem interference:

```bash
# Create per-agent tmpfs
bwrap \
  --perms 0700 --size 104857600 \  # 100MB limit, owner-only
  --tmpfs /tmp \
  --setenv TMPDIR /tmp \
  agent-command
```

The `--size` parameter is critical for preventing a runaway agent from filling the host's memory with tmpfs data.

For cases where the agent needs to output files that the orchestrator can read:

```bash
# Shared output directory with per-agent isolation
AGENT_ID=$(uuidgen)
AGENT_OUTPUT="/var/lib/agent-outputs/$AGENT_ID"
mkdir -p "$AGENT_OUTPUT"

bwrap \
  --tmpfs /tmp \
  --bind "$AGENT_OUTPUT" /output \
  agent-command --output-dir /output

# Orchestrator reads from $AGENT_OUTPUT after agent exits
```

### Auth State Passthrough

Agent subprocesses often need read-only access to credentials for API calls, without being able to modify or exfiltrate them:

```bash
bwrap \
  --ro-bind /usr /usr \
  --ro-bind /etc/ssl /etc/ssl \          # TLS certificates
  --ro-bind /etc/resolv.conf /etc/resolv.conf \  # DNS resolution
  --ro-bind "$HOME/.claude.json" "$HOME/.claude.json" \  # Auth (read-only)
  --ro-bind "$HOME/.claude" "$HOME/.claude" \  # Session data (read-only)
  --bind "$PROJECT_DIR" "$PROJECT_DIR" \  # Project files (read-write)
  --tmpfs /tmp \
  --unshare-net \                        # No network (unless needed)
  claude -p
```

The critical pattern: credentials are `--ro-bind` mounted, making them readable but not writable or deletable by the sandboxed process.

### Preventing Data Exfiltration While Enabling Tool Functionality

The tension: tool-using agents need filesystem write access to be useful, but write access enables data exfiltration (write secrets to a file, then read that file later from a different context). Mitigation strategies:

1. **Network isolation (`--unshare-net`):** The agent can write anywhere within its sandbox, but cannot send data out. Combined with `--die-with-parent`, the sandbox and all its contents are cleaned up when the orchestrator terminates.

2. **Seccomp syscall filtering:** Block specific syscalls that enable exfiltration:

```bash
# Block socket creation (prevents network even if namespace not isolated)
# Block ptrace (prevents reading other processes' memory)
# Block mount (prevents escaping filesystem restrictions)
bwrap \
  --seccomp 10 \  # FD 10 has the seccomp filter
  ...
```

3. **Output validation:** The orchestrator inspects the agent's output before using it, checking for embedded credentials or unexpected data patterns.

### The Codex Linux Sandbox Mount Strategy

OpenAI's Codex linux-sandbox provides an instructive real-world example of sophisticated mount layering:

```
1. --ro-bind / /                    (entire filesystem read-only)
2. --bind <root> <root>             (writable project roots layered on top)
3. --ro-bind .git .git              (re-protect subpaths under writable roots)
4. --ro-bind .codex .codex          (re-protect config under writable roots)
5. /dev/null on problematic symlinks (neutralize symlink-based escapes)
```

The pattern of "broad read-only base, selective writable overlay, then re-protection of sensitive subpaths" is the most robust approach for tool-using agents that need both broad read access and targeted write access.

---

## Production Patterns

### Circuit Breakers for AI Calls

AI API calls have unique failure characteristics that require adapted circuit breaker configuration:

- **Long response times** (30-120s normal) mean timeout-based breakers must have high thresholds
- **Rate limits (429)** are expected behavior, not failures -- they should trigger backoff but not open the circuit
- **Streaming connections** may fail mid-stream, requiring partial-result handling

```typescript
import CircuitBreaker from 'opossum';

const aiCircuitBreaker = new CircuitBreaker(callAI, {
  timeout: 120_000,                  // 2 minutes (AI calls are slow)
  resetTimeout: 60_000,              // Try half-open after 1 minute
  errorThresholdPercentage: 60,      // Open at 60% failure rate
  volumeThreshold: 3,                // Need at least 3 calls before opening
  rollingCountTimeout: 300_000,      // 5 minute rolling window
  errorFilter: (error) => {
    // Don't count rate limits as failures — they are expected
    if (error.status === 429) return true;  // true = don't count as failure
    // Don't count client errors as failures
    if (error.status >= 400 && error.status < 500) return true;
    return false;  // Count everything else (5xx, network errors)
  },
});

aiCircuitBreaker.on('open', () => {
  console.warn('AI circuit breaker opened — switching to fallback backend');
});

aiCircuitBreaker.fallback(() => {
  // Fall back to a different model or backend
  return callFallbackAI();
});
```

### Retry with Runtime Fallback

A tiered fallback strategy that escalates through backends:

```typescript
class ResilientAIClient {
  private adapters: RuntimeAdapter[];

  constructor(adapters: RuntimeAdapter[]) {
    // Order: preferred first, fallbacks after
    this.adapters = adapters;
  }

  async execute(request: GenerationRequest): Promise<GenerationResult> {
    let lastError: Error | null = null;

    for (const adapter of this.adapters) {
      // Check if this adapter supports required capabilities
      if (request.tools?.length && !adapter.capabilities.supportsToolUse) {
        continue;
      }

      const maxRetries = 2;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const result = await adapter.execute(request);
          return result;
        } catch (error: any) {
          lastError = error;

          // Non-retryable errors: skip to next adapter
          if (error.status === 400 || error.status === 401 || error.status === 403) {
            break;
          }

          // Rate limit: respect Retry-After header
          if (error.status === 429) {
            const retryAfter = parseInt(error.headers?.['retry-after'] ?? '10');
            const backoff = Math.max(retryAfter * 1000, 1000 * Math.pow(2, attempt));
            const jitter = Math.random() * backoff * 0.3;
            await sleep(backoff + jitter);
            continue;
          }

          // Server error: exponential backoff
          if (error.status >= 500 || error.code === 'ECONNREFUSED') {
            const backoff = 1000 * Math.pow(2, attempt);
            const jitter = Math.random() * backoff * 0.3;
            await sleep(backoff + jitter);
            continue;
          }

          // Unknown error: don't retry, try next adapter
          break;
        }
      }
    }

    throw new Error(`All adapters exhausted. Last error: ${lastError?.message}`);
  }
}

// Usage: CLI preferred, API fallback, cheaper model last resort
const client = new ResilientAIClient([
  new CLISubprocessAdapter(),
  new APIAdapter(process.env.ANTHROPIC_API_KEY!, 'claude-sonnet-4-20250514'),
  new APIAdapter(process.env.ANTHROPIC_API_KEY!, 'claude-haiku-4-20250414'),
]);
```

### Session Resume and Prompt Caching

For expensive operations that may need to be retried, prompt caching dramatically reduces cost:

```typescript
// API adapter with prompt caching
async execute(request: GenerationRequest): Promise<GenerationResult> {
  const response = await this.client.messages.create({
    model: request.model ?? 'claude-sonnet-4-20250514',
    max_tokens: request.maxTokens ?? 8192,
    system: [
      {
        type: 'text',
        text: request.systemPrompt,
        cache_control: { type: 'ephemeral' },  // Cache the system prompt
      },
    ],
    messages: [{ role: 'user', content: request.userMessage }],
  });

  // Log cache performance
  console.log(`Cache: ${response.usage.cache_read_input_tokens} read, ` +
              `${response.usage.cache_creation_input_tokens} created`);

  return this.formatResult(response);
}
```

For CLI subprocesses, the `--resume` flag and session IDs enable continuation without resending full context:

```bash
# First call: establish session
claude -p --output-format stream-json --session-id "task-42" < prompt.txt

# Retry or continuation: resume session (prompt cache intact)
claude -p --resume --session-id "task-42" < follow_up.txt
```

### Effort and Model Tiering Per Scenario

Not every AI call needs the most capable model. A tiering strategy reduces cost and latency:

```typescript
interface TaskTier {
  model: string;
  effort: 'low' | 'medium' | 'high';
  maxTokens: number;
  timeout: number;
  description: string;
}

const TASK_TIERS: Record<string, TaskTier> = {
  classification: {
    model: 'claude-haiku-4-20250414',
    effort: 'low',
    maxTokens: 256,
    timeout: 10_000,
    description: 'Quick classification, routing, yes/no decisions',
  },
  summarization: {
    model: 'claude-sonnet-4-20250514',
    effort: 'medium',
    maxTokens: 4096,
    timeout: 30_000,
    description: 'Content summarization, extraction, formatting',
  },
  generation: {
    model: 'claude-sonnet-4-20250514',
    effort: 'high',
    maxTokens: 32768,
    timeout: 120_000,
    description: 'Code generation, complex analysis, long-form writing',
  },
  complex_reasoning: {
    model: 'claude-opus-4-20250918',
    effort: 'high',
    maxTokens: 65536,
    timeout: 300_000,
    description: 'Multi-step reasoning, architecture design, debugging',
  },
};
```

The tool use token overhead also varies by model and should factor into tier selection:

| Model | Token overhead (auto) | Token overhead (forced tool) |
|-------|-----------------------|-----------------------------|
| Claude Opus 4.8 | 290 tokens | 410 tokens |
| Claude Opus 4.6 | 497 tokens | 589 tokens |
| Claude Sonnet 4.6 | 497 tokens | 589 tokens |
| Claude Haiku 4.5 | 496 tokens | 588 tokens |

For high-volume classification tasks using Haiku, the 496-token overhead per call is significant and may make batch API calls more cost-effective than individual tool-use calls.

---

## Conclusion

Building production AI agent systems that spawn LLM subprocesses requires careful navigation of three interrelated challenges: sandbox nesting, process supervision, and backend abstraction.

**Sandbox nesting** is best avoided entirely. The two-layer complementary approach -- outer bwrap for filesystem policy without `--unshare-user`, inner sandbox for network/process policy -- eliminates the nested user namespace conflict that causes silent tool failures. When nesting cannot be avoided, the `enableWeakerNestedSandbox` or `sandbox_mode = "none"` escape hatches exist but trade security for functionality.

**Process supervision** for AI calls demands a combination of wall-clock timeouts, activity-based liveness detection, and disciplined SIGTERM-then-SIGKILL escalation targeting process groups (negative PID). Orphan detection via `/proc` scanning with environment variable markers provides the final safety net. Output buffering must be capped to prevent OOM from large generations.

**Runtime adapter abstraction** enables the fallback chains (CLI -> API -> alternate model) that make production systems resilient. The adapter pattern with capability declarations allows the orchestrator to intelligently route requests based on sandbox compatibility, required tools, and performance characteristics. Circuit breakers with AI-appropriate thresholds (high timeout, rate-limit-aware error filtering) prevent cascade failures.

The most important practical insight from real-world deployments: when a CLI subprocess's Edit tool fails silently with exit code 1 inside a nested sandbox, the root cause is almost always a user namespace conflict. The fix is not to debug the nesting -- it is to restructure the isolation architecture so nesting is unnecessary.

---

## References

1. Bubblewrap (bwrap) man page. Debian Testing. https://manpages.debian.org/testing/bubblewrap/bwrap.1.en.html
2. Flatpak PR #5084: Use new --disable-userns bubblewrap feature. https://github.com/flatpak/flatpak/pull/5084
3. Codex Issue #17969: apply_patch fails inside sandbox on Ubuntu 25.10. https://github.com/openai/codex/issues/17969
4. Codex Issue #16018: Default bubblewrap sandbox incompatible with restricted containers. https://github.com/openai/codex/issues/16018
5. Jpetazzo. "Using Docker-in-Docker for CI? Think twice." 2015. https://jpetazzo.github.io/2015/09/03/do-not-use-docker-in-docker-for-ci/
6. Nestybox. "Secure Docker-in-Docker with System Containers." 2019. https://blog.nestybox.com/2019/09/14/dind.html
7. user_namespaces(7) Linux manual page. https://www.man7.org/linux/man-pages/man7/user_namespaces.7.html
8. Edera. "User Namespaces Are Not a Security Boundary." 2026. https://edera.dev/stories/user-namespaces-are-not-a-security-boundary
9. Ubuntu Blog. "Restricted unprivileged user namespaces." https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces
10. Esokia Labs. "Sandboxing Claude Code CLI on Linux with bubblewrap." https://labs.esokia.com/post/sandboxing-claude-code-cli-linux-bubblewrap/
11. Codex linux-sandbox README. https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md
12. Claude Code Sandboxing Documentation. https://code.claude.com/docs/en/sandboxing
13. Opossum Circuit Breaker Documentation. https://nodeshift.dev/opossum/
14. CallSphere. "Retry Strategies for LLM API Calls." https://callsphere.ai/blog/retry-strategies-llm-api-calls-exponential-backoff-jitter-tenacity
15. Portkey. "Retries, Fallbacks, and Circuit Breakers in LLM Apps." https://portkey.ai/blog/retries-fallbacks-and-circuit-breakers-in-llm-apps/
16. Anthropic. "Streaming." Claude API Docs. https://platform.claude.com/docs/en/docs/build-with-claude/streaming
17. Anthropic. "Tool Use Overview." Claude API Docs. https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
18. Anthropic. "Advanced Tool Use." https://www.anthropic.com/engineering/advanced-tool-use
19. DEV Community. "Claude CLI vs API for Code Review." https://dev.to/fole/claude-cli-vs-api-for-code-review-same-model-wildly-different-results-1oai
20. DEV Community. "Why Claude Code Subagents Waste 50K Tokens Per Turn." https://dev.to/jungjaehoon/why-claude-code-subagents-waste-50k-tokens-per-turn-and-how-to-fix-it-41ma
21. ArchWiki. "Bubblewrap/Examples." https://wiki.archlinux.org/title/Bubblewrap/Examples
