---
date: "2026-06-18"
title: "Session Lifecycle Orchestration in AI Agent Runtimes"
description: "How agent runtimes coordinate startup hooks — error isolation, bounded execution, and the orchestrator pattern for reliable session bootstrap"
tags: ["ai-agents", "runtime", "session-management", "orchestration", "reliability"]
---

## Executive Summary

Every AI agent runtime faces the same bootstrap problem: before the model can respond usefully, a cluster of independent subsystems must initialize — memory must be injected, communication channels must register, monitoring processes must identify the new session, and pending work must be surfaced. Each of these steps can fail, hang, or produce output that the next step depends on. Do any of them wrong, and the session starts in a degraded state the model doesn't know about.

This is the session lifecycle problem. It is not a new problem — system administrators have managed multi-service startup ordering since the days of SysV init scripts, and the same failure modes recur in every generation. But agent runtimes add a dimension that older init systems don't have: some startup steps produce output that is injected directly into the model's context window, while others are pure side effects. Conflating the two types leads to confused diagnostics, silent failures, and a model that starts each session with a corrupted view of its own state.

This article examines how real systems — Claude Code's hook mechanism, VS Code extensions, systemd, Docker health checks, and production agent platforms — solve these problems. It develops the orchestrator pattern as the practical synthesis: a single entry point per lifecycle event that provides deterministic ordering, per-step error isolation, bounded total runtime, and type-correct output routing.

## The Session Lifecycle Problem

An AI agent session is not a single process. It is a coordinated ensemble:

- **Memory subsystem**: reads persisted identity, state, and reference files; formats them as context
- **Communication bridge**: queries message history since the last checkpoint; appends unsummarized conversations
- **Activity monitor**: registers the new session in a foreground-session record; starts heartbeat tracking
- **Scheduler/orchestrator**: surfaces tasks that were deferred to the next session

Each of these is independent. The memory subsystem does not need the communication bridge to succeed; the activity monitor does not need memory. But if any step hangs indefinitely, the entire session startup hangs, and the model never receives its first turn.

The failure surface is larger than it appears:

1. **Database locks.** If a prior session crashed without closing its SQLite connection, the new session's startup hook may block indefinitely on a write lock.
2. **Network dependencies.** Hooks that call external APIs during startup introduce unbounded latency. A 5-second timeout becomes a 5-second delay on every session start.
3. **Process crashes.** A startup hook that calls `process.exit(1)` may kill the entire hook runner depending on how the runtime executes child processes.
4. **stdin consumption conflicts.** In Claude Code, the runtime passes a JSON event payload to each hook via stdin. If two hooks in the same group both attempt to read stdin, the second one reads an empty stream — the first has already consumed it.
5. **Output type confusion.** Hooks that write to stdout produce text that gets injected into the model's context. A hook that accidentally writes to stdout as a side effect produces garbage in the model's initial context, which the model may attempt to interpret as instructions.

These failures are silent by default. Without instrumentation, the model starts each session not knowing whether its state was fully restored.

## How Existing Systems Solve It

### Claude Code: Hook Groups and Matcher-Based Routing

Claude Code's `settings.json` supports a `hooks` object keyed by lifecycle event name. Each event maps to an array of *hook groups*. A hook group contains a list of command-type hooks and an optional `matcher` string that filters which invocations trigger the group.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/zylos/.claude/skills/zylos-memory/scripts/session-start-inject.js",
            "timeout": 10000
          },
          {
            "type": "command",
            "command": "node ~/zylos/.claude/skills/comm-bridge/scripts/c4-session-init.js",
            "timeout": 10000
          },
          {
            "type": "command",
            "command": "node ~/zylos/.claude/skills/activity-monitor/scripts/session-foreground.js",
            "timeout": 5000
          },
          {
            "type": "command",
            "command": "node ~/zylos/.claude/skills/activity-monitor/scripts/session-start-prompt.js",
            "timeout": 5000
          }
        ]
      }
    ]
  }
}
```

The `matcher` field routes specific session start sources (`startup`, `clear`, `compact`, `resume`) to different hook sets — or to the same set with the same configuration, as in a typical autonomous agent deployment where the same bootstrap sequence applies regardless of how the session was initiated.

Two key properties of this design:

**Per-hook timeouts.** Each command specifies its own `timeout` in milliseconds. If `c4-session-init.js` exceeds 10 seconds, Claude Code kills it and moves on. The total startup time is bounded by the sum of all timeouts in the chain, not by whatever the slowest hook decides to do. In practice, with two 10-second and two 5-second hooks, the worst case is 30 seconds — bad, but bounded and observable.

**stdout injection.** Command-type hooks whose exit code is 0 have their stdout injected as context into the model's initial turn. This is how `session-start-inject.js` delivers memory: it reads three files and prints them as labelled sections to stdout. The runtime captures this output and prepends it to the model's context window automatically. No API calls, no database writes — the hook's only job is to print the right text.

The `async: true` flag present on most non-startup hooks (activity tracking, dashboard telemetry) inverts this: those hooks fire and are forgotten. The runtime does not wait for them and does not inject their stdout. This cleanly separates the two hook types: blocking-with-output hooks for context injection, async-fire-and-forget hooks for telemetry and side effects.

### VS Code Extensions: The activate/deactivate Contract

VS Code extension lifecycle is the closest analogue in mainstream developer tooling. The runtime calls `activate(context)` when an extension is first needed and `deactivate()` when the window closes. The critical constraint: if `activate()` throws or returns a rejected promise, the extension is disabled for the session.

VS Code does not impose a timeout on `activate()` by default, which is a known footgun. Extensions that await network calls during activation block their language features until the await resolves. The VS Code team's guidance is to make activation instant — defer any heavy initialization to a background promise, expose a `ready` accessor, and let callers await it lazily:

```typescript
let _ready: Promise<void>;

export function activate(context: vscode.ExtensionContext) {
  _ready = initializeAsync(context).catch(err => {
    console.error('Extension init failed:', err);
    // Degrade gracefully; don't rethrow
  });
  // Return immediately — activation complete
}

export function ready(): Promise<void> {
  return _ready;
}
```

This pattern — "start init in background, expose a readiness signal, degrade gracefully on failure" — is the same principle that systemd encodes at the OS level.

### systemd: Type=notify and Startup Dependencies

systemd models service startup as a state machine with explicit readiness signaling. A service with `Type=notify` is considered started only after it calls `sd_notify(3)` with `READY=1`. Until that signal arrives, dependent services wait. If it never arrives, `TimeoutStartSec` fires (default: 90 seconds) and the service is marked failed.

The dependency graph (`After=`, `Requires=`, `Wants=`) encodes ordering and failure semantics separately:

- `Requires=`: hard dependency — if A fails, B fails
- `Wants=`: soft dependency — if A fails, B starts anyway
- `After=`: ordering only — B starts after A is started (or tried), regardless of outcome

This distinction between ordering and failure propagation is exactly what agent runtime hook systems need but rarely implement explicitly. In practice, most hook systems use implicit hard dependencies (sequential execution stops on first failure) when what they want is `Wants=`-style behavior: try each step, continue regardless, log failures.

systemd also provides `ExecStartPre=` for pre-start checks that must succeed before the main process launches, and `ExecStartPost=` for post-start initialization that runs after readiness. The hook chain maps cleanly to this model: memory injection is `ExecStartPre=`, communication bridge initialization is `ExecStartPre=`, activity monitor registration is `ExecStartPost=`.

### Docker and Init Systems: PID 1 and Signal Forwarding

Docker containers run as PID 1 by default, which creates a subtle lifecycle problem: PID 1 is responsible for reaping zombie processes (calling `wait()` on exited children). Most application processes are not written to do this. When a session-start script forks child processes that exit, those zombies accumulate without cleanup.

The solution is a minimal init system — `tini` or `dumb-init` — that runs as PID 1, forwards signals to the actual application process, and reaps zombie children:

```dockerfile
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "orchestrator.js"]
```

The same principle applies in hook orchestrators: a parent process that forks child hooks should explicitly `wait()` for each, collect their exit codes, and not leave zombie processes in the process table. Node.js handles this automatically for `execFileSync` and `spawnSync`, but async `spawn()` without a `close` handler leaks.

## Hook Output Types: A Critical Distinction

The most important architectural decision in session lifecycle design is separating hooks by output type before writing any code.

**Context-injection hooks** write to stdout. Their output becomes part of the model's initial context. They must:
- Exit with code 0 on success
- Write only valid, formatted text to stdout
- Write diagnostic messages to stderr (not stdout)
- Complete within their declared timeout

**Side-effect hooks** produce no output the model sees. They register sessions, update databases, enqueue messages. They can:
- Run asynchronously (`async: true`) without blocking session start
- Fail silently without affecting the model's context
- Write diagnostic data to dedicated log files

Mixing these types — for example, a memory injection hook that also tries to enqueue a control message — creates two problems. First, the hook's I/O logic becomes entangled: any error in the enqueue path risks corrupting the stdout output that the runtime is trying to capture. Second, the hook's failure characteristics change: a network error in the enqueue should be best-effort, but if it panics and writes an error to stdout, that error appears in the model's context as if it were memory.

The clean separation is: one hook, one type. Memory injection hooks read files and print text. Communication bridge hooks read a database and print formatted conversation history. Session registration hooks write a JSON file and print nothing.

## The Orchestrator Pattern

In systems with more than three or four startup hooks, flat arrays of independent commands become difficult to manage. The orchestrator pattern consolidates them into a single entry point with explicit control over ordering, error isolation, timing, and output routing.

A minimal orchestrator for session startup:

```javascript
#!/usr/bin/env node
/**
 * Session start orchestrator.
 * Runs context-injection steps sequentially, collecting stdout.
 * Runs side-effect steps after, ignoring failures.
 * Enforces a total budget of 25 seconds.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const TOTAL_BUDGET_MS = 25_000;
const startMs = Date.now();

// Force exit after total budget regardless of what's still running
const killTimer = setTimeout(() => {
  console.error(`[orchestrator] budget exceeded (${TOTAL_BUDGET_MS}ms), exiting`);
  process.exit(0); // exit 0 so runtime doesn't treat this as hook failure
}, TOTAL_BUDGET_MS);
killTimer.unref();

async function runStep(name, command, timeoutMs) {
  const stepStart = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync('node', [command], {
      timeout: timeoutMs,
      encoding: 'utf8'
    });
    if (stderr.trim()) {
      console.error(`[${name}] ${stderr.trim()}`);
    }
    const duration = Date.now() - stepStart;
    console.error(`[orchestrator] ${name} ok (${duration}ms)`);
    return { ok: true, stdout };
  } catch (err) {
    const duration = Date.now() - stepStart;
    console.error(`[orchestrator] ${name} failed (${duration}ms): ${err.message}`);
    return { ok: false, stdout: '' };
  }
}

async function runSideEffect(name, command, timeoutMs) {
  // Fire and forget — don't await, don't block
  execFileAsync('node', [command], { timeout: timeoutMs })
    .catch(err => console.error(`[${name}] side-effect error: ${err.message}`));
}

async function main() {
  const contextParts = [];

  // Phase 1: context injection — sequential, output collected
  const memResult = await runStep(
    'memory-inject',
    '~/zylos/.claude/skills/zylos-memory/scripts/session-start-inject.js',
    10_000
  );
  if (memResult.ok && memResult.stdout.trim()) {
    contextParts.push(memResult.stdout);
  }

  const c4Result = await runStep(
    'c4-session-init',
    '~/zylos/.claude/skills/comm-bridge/scripts/c4-session-init.js',
    10_000
  );
  if (c4Result.ok && c4Result.stdout.trim()) {
    contextParts.push(c4Result.stdout);
  }

  // Phase 2: side effects — async, failures ignored
  runSideEffect(
    'session-foreground',
    '~/zylos/.claude/skills/activity-monitor/scripts/session-foreground.js',
    5_000
  );

  // Write all collected context to stdout in one atomic write
  if (contextParts.length > 0) {
    process.stdout.write(contextParts.join('\n\n') + '\n');
  }

  const totalDuration = Date.now() - startMs;
  console.error(`[orchestrator] startup complete (${totalDuration}ms)`);
  clearTimeout(killTimer);
}

main().catch(err => {
  console.error(`[orchestrator] fatal: ${err.message}`);
  process.exit(0);
});
```

This orchestrator collapses four hooks into one settings.json entry:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/zylos/.claude/skills/orchestrator/session-start.js",
            "timeout": 30000
          }
        ]
      }
    ]
  }
}
```

The total budget timer (`setTimeout(..., 25_000)` with `.unref()`) is the key safety mechanism. Even if one of the child processes hangs despite its own timeout, the orchestrator will exit after 25 seconds. The `.unref()` call ensures the timer does not prevent Node.js from exiting normally if everything completes early. The outer hook timeout (30 seconds) provides a final backstop at the runtime level.

## The stdin Fan-Out Problem

Claude Code passes the session start event as JSON on stdin to each hook:

```json
{
  "type": "event",
  "event": "session_start",
  "session_id": "abc123",
  "source": "startup"
}
```

When a hook group contains multiple commands, each command receives its own stdin stream — the runtime forks a new process for each command. This is safe. The problem arises when you replace multiple hooks with a single orchestrator that needs to forward the payload to child processes: the orchestrator reads stdin once, and must explicitly pass the data to each child.

The pattern for forwarding:

```javascript
// Read stdin before spawning children
let stdinData = '';
process.stdin.setEncoding('utf8');
await new Promise(resolve => {
  process.stdin.on('data', chunk => { stdinData += chunk; });
  process.stdin.on('end', resolve);
  setTimeout(resolve, 500); // don't block if stdin is already closed
});

// Pass to children via environment variable (avoids stdin fork complexity)
const env = { ...process.env, HOOK_PAYLOAD: stdinData };
await execFileAsync('node', [childScript], { env, timeout: 5000 });
```

Passing the payload via an environment variable is simpler than wiring up stdin pipes to each child process and avoids the pitfall of `execFileSync` with `stdio: 'inherit'` consuming the orchestrator's own stdin.

## Failure Modes and Mitigations

### Exit Code Propagation

A hook that calls `process.exit(1)` in Node.js exits with code 1. Claude Code interprets a non-zero exit from a hook as a hook failure. Depending on the runtime version, this may suppress context injection from the hook's stdout or may surface an error to the user. The orchestrator pattern mitigates this: the orchestrator always exits 0, regardless of what individual steps did. Step failures are logged to stderr and recorded in timing logs, but they do not bubble up as hook failures to the runtime.

The exception is catastrophic failures — if the orchestrator itself throws before writing any output, exiting 0 is still correct. An empty stdout injection is a no-op; a non-zero exit may produce a worse user experience than a missing context injection.

### Timing Diagnostics

Hook timing logs are the primary tool for identifying performance regressions. A simple append-only log written by each hook (or by the orchestrator for all steps) provides a running record:

```
[2026-06-16 06:03:49] hook=session-start-inject duration=5ms
[2026-06-16 06:03:49] hook=c4-session-init duration=6ms
[2026-06-16 06:03:49] hook=session-start-prompt[clear] duration=45ms
[2026-06-16 06:58:40] hook=session-start-prompt[startup] duration=130ms
```

A startup hook that took 5ms on Monday and 1800ms on Wednesday is a diagnostic signal: something changed — a dependency added a blocking call, a database grew large enough to make a query slow, or a network dependency was introduced. Without this log, the regression is invisible until a user complains that sessions are slow to start.

The log rotation pattern (truncate to 50% of lines when file exceeds 100KB) keeps the file from growing indefinitely while preserving recent history for diagnosis.

### Critical vs. Best-Effort Steps

Not all startup steps are equally critical. A useful classification:

| Step | Failure consequence | Classification |
|------|-------------------|----------------|
| Memory injection | Model starts with no identity or state context | Critical |
| Communication bridge | Model misses recent conversation context | Important |
| Session foreground registration | Activity monitor may misidentify active session | Best-effort |
| Startup prompt enqueue | Model doesn't receive a "resume work" prompt | Best-effort |

Critical steps should run first, be given longer timeouts, and their failure should be logged prominently. Best-effort steps should run last or asynchronously, and their failures should be recorded but not surfaced to the user.

The orchestrator pattern makes this classification explicit in code: critical steps are awaited sequentially in Phase 1, best-effort steps are fire-and-forget in Phase 2. Without the orchestrator, all steps look equivalent in a flat settings array.

## Comparison Across Runtimes

| System | Startup ordering | Per-step timeout | Error isolation | Output types | Total budget |
|--------|-----------------|-----------------|----------------|--------------|--------------|
| Claude Code hooks | Sequential per group | Yes (per command) | Partial (async flag) | stdout injection + side effects | Sum of timeouts |
| VS Code activate() | Single async function | No (caller responsibility) | Manual try/catch | N/A (imperative) | Indefinite by default |
| systemd | DAG with After=/Wants= | TimeoutStartSec | Wants= vs Requires= | N/A (service processes) | Per-service |
| Docker HEALTHCHECK | Interval-based | --timeout flag | Independent | Exit code only | N/A (ongoing) |
| Custom orchestrator | Explicit in code | Per execFileAsync call | try/catch per step | stdout collected + stderr diagnostic | Total budget timer |

The custom orchestrator scores best on all five dimensions because it is purpose-built for the problem. The cost is an additional layer of indirection: the orchestrator script must be maintained and tested. The benefit is that all five lifecycle properties are visible in one file rather than scattered across runtime configuration, hook scripts, and implicit platform behavior.

## Practical Recommendations

**Separate hook types before wiring hooks.** Before adding any hook, classify it: does it produce context (stdout injection) or does it produce state (file write, database update, queue push)? Never mix the two in one hook script. Keep stdout clean for the runtime.

**Instrument from day one.** Add hook timing logs in the first version. The cost is five lines of code per hook; the benefit is a permanent record of performance regressions. Use stderr for diagnostic output so it doesn't corrupt stdout context injection.

**Use a total budget timer in any orchestrator.** Individual step timeouts are necessary but not sufficient. A bug in the timeout logic, an unhandled promise, or a zombie subprocess can still cause the orchestrator to hang. A `setTimeout` that calls `process.exit(0)` after a hard deadline is the last line of defense.

**Model graceful degradation explicitly.** Decide upfront which steps are critical and which are best-effort. Run best-effort steps asynchronously. Log their failures but do not surface them as errors. A session that starts without activity monitor registration is better than a session that doesn't start.

**Test hook chains end-to-end, not just unit.** Hook integration bugs — stdin consumption conflicts, exit code propagation, stdout/stderr routing — only manifest when the full chain runs as the runtime will invoke it. Write integration tests that spawn the orchestrator as a subprocess with a fake payload on stdin and assert on the stdout output and exit code.

Session lifecycle orchestration is infrastructure code: unglamorous, rarely changed, catastrophic when broken. The patterns that make it reliable — bounded execution, type separation, error isolation, and diagnostic logging — are not novel. They are the same patterns systemd, VS Code, and Docker discovered independently. The agent runtime context adds the stdout-injection dimension, but the underlying structure is the same problem engineers have been solving in production systems for decades.

---

*Sources: Claude Code settings.json hook configuration (production Zylos deployment), Claude Code hook timing logs (2026-06-16 to 2026-06-17), Zylos session-start hook scripts (session-start-inject.js, c4-session-init.js, session-foreground.js, session-start-prompt.js), VS Code Extension API documentation, systemd.service(5) man page, Docker HEALTHCHECK documentation, tini and dumb-init project documentation.*
