---
date: "2026-09-23"
time: "09:10"
title: "What Survives a Snapshot: Suspend and Restore for Agent Sandboxes"
description: "Pausing an agent sandbox saves compute, but a memory snapshot also freezes random state, clocks, sockets, and half-finished side effects. What platforms preserve, where clones go wrong, and a resume contract for agent runtimes."
tags: ["ai-agents", "sandboxes", "firecracker", "snapshots", "reliability", "security", "python"]
---

## Executive Summary

Agents spend most of their wall-clock time waiting on a model, a human, or a tool. That makes suspend and resume attractive for agent sandboxes: stop paying for CPU while nothing happens, then continue where the agent left off. The platforms differ sharply, though, in what "continue" means. Some keep the full memory image, some keep only the disk, and some destroy the environment after an idle timeout.

Keeping memory is the most convenient option and the one with the most subtle failure modes. A memory snapshot preserves a process's random-number state, its view of the clock, its open connections, its cached tokens, and any operation that was halfway through a side effect. Restoring it once is a pause. Restoring it twice is a clone, and a clone duplicates everything that was supposed to be unique.

This article summarizes what major sandbox platforms preserve across suspend, what the Firecracker, Lambda SnapStart, CRaC, CRIU, and gVisor documentation says about restore correctness, and two small Python experiments that make the hazards concrete. It ends with a resume contract an agent runtime can adopt regardless of platform. The contract and the mapping to agents are engineering synthesis; the platform behaviors are cited from vendor documentation as of September 2026.

## Three meanings of "resume"

Agent sandbox products fall into three groups according to what survives an idle period.

| Group | What survives | Examples (per vendor docs) |
|---|---|---|
| Memory + filesystem | Running processes, variables, open files, disk | E2B pause/resume; Modal sandbox memory snapshots (experimental, 7-day expiry, no GPU); Fly.io Machines suspend (Firecracker snapshot) |
| Filesystem only | Disk contents; processes restart | Daytona stop/archive; Runloop suspend; Vercel Sandbox; Grok Bot workspace; Cursor cloud agents (hibernate, then recycle) |
| Nothing (destroy) | Only what was stored externally | OpenAI Code Interpreter containers (expire after 20 minutes unused); OpenAI Agents API hosted sandbox (expires after 1 hour of inactivity) |

Amazon Bedrock AgentCore takes a different approach: one microVM per session with a configurable idle timeout (default 900 seconds, maximum lifetime 8 hours), CPU billing that drops to zero during I/O wait, and memory billed on peak usage. State does not survive session termination unless it is written to session storage or the Memory service.

Sources: [E2B persistence](https://docs.e2b.dev/sandbox/persistence), [Modal sandbox snapshots](https://modal.com/docs/guide/sandbox-snapshots), [Fly.io suspend/resume](https://fly.io/docs/reference/suspend-resume/), [Daytona persistence](https://www.daytona.io/docs/en/persistence/), [Runloop suspend/resume](https://docs.runloop.ai/docs/tutorials/running-agents-on-sandboxes/suspend-resume-workflow), [Vercel Sandbox concepts](https://vercel.com/docs/sandbox/concepts), [Grok Bot computer and apps](https://docs.x.ai/grok-bot/computer-and-apps), [Cursor cloud agent security](https://cursor.com/docs/cloud-agent/security), [OpenAI Code Interpreter](https://developers.openai.com/api/docs/guides/tools-code-interpreter), [OpenAI hosted environments](https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted), [AgentCore lifecycle settings](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-lifecycle-settings.html), [AgentCore pricing](https://aws.amazon.com/bedrock/agentcore/pricing/).

The billing pattern is broadly consistent: compute billing pauses, while storage (and on some platforms provisioned memory) keeps accruing. Fly.io stops compute billing while a Machine is suspended but charges for root filesystem storage. Cloudflare Containers bill memory and disk on provisioned capacity even while idle, with CPU billed on usage. E2B documents pause taking roughly 4 seconds per GiB of RAM and resume about 1 second; Fly.io reports resume in "a few hundred ms" against roughly 2 seconds for a cold start and recommends suspend for Machines with 2 GB of RAM or less. Memory size is therefore a direct input to both snapshot cost and pause latency. ([Cloudflare Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/))

The practical consequence for an agent runtime: **decide which group you are in before you design your state model.** In the filesystem-only and destroy groups, the runtime already has to rebuild in-memory state from something durable — a session log, a checkpoint file, a database. In the memory group, the runtime can skip that rebuild, and that is exactly where the hidden assumptions creep in.

## A memory snapshot is a copy of everything

Firecracker, the microVM monitor behind several of these products, defines a snapshot as guest memory plus emulated hardware state, with the disk managed separately by the user. Its documentation is unusually direct about the limits:

- Network connectivity is "not guaranteed to be preserved after resume", and vsock connections are closed.
- A snapshot must be resumed on an identical software and hardware configuration.
- On uniqueness: "we consider resuming execution from the same state more than once insecure."

The last point is the important one. After a restore, every clone starts with the same kernel entropy pool, the same `boot_id`, and the same user-space generator state. Firecracker added support for the Virtual Machine Generation ID device (VMGenID) on x86_64 and aarch64: before resuming vCPUs it updates a 16-byte generation ID and notifies the guest. Linux 5.18 and later handle that notification in the `vmgenid` driver, which reseeds the kernel CRNG ("crng reseeded due to virtual machine fork").

That fixes the kernel. It does not fix the application. Firecracker's own random-for-clones document states that state "other than the guest kernel entropy pool, such as unique identifiers, cached random numbers, cryptographic tokens, etc will still be replicated", and notes a window between vCPU resume and the reseed.

Sources: [Firecracker snapshot support](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md), [Firecracker random for clones](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/random-for-clones.md), [Linux RNG 5.17/5.18 changes](https://www.zx2c4.com/projects/linux-rng-5.17-5.18/), [QEMU VMGenID spec](https://www.qemu.org/docs/master/specs/vmgenid.html).

AWS Lambda SnapStart, which restores functions from Firecracker snapshots at scale, turns this into a developer rule: "you must generate unique content after initialization. This includes unique IDs, unique secrets, and entropy." Lambda reseeds the kernel RNG on restore and provides `beforeCheckpoint`/`afterRestore` runtime hooks (via the CRaC API on Java) so application code can refresh what the kernel cannot. ([SnapStart uniqueness](https://docs.aws.amazon.com/lambda/latest/dg/snapstart-uniqueness.html), [SnapStart runtime hooks](https://docs.aws.amazon.com/lambda/latest/dg/snapstart-runtime-hooks-java.html))

## Experiment 1: a clone without a notification

A VM restore can be simulated inside one machine. `fork()` copies a process's memory, which is the same kind of event from the application's point of view. The difference is whether the application is told. CPython registers at-fork handlers and reseeds the `random` module in the child when you call `os.fork()`. Calling libc's `fork()` directly through `ctypes` copies memory without running those handlers — the unnotified clone that a snapshot restore looks like to user space.

```python
import ctypes, os, random, secrets
libc = ctypes.CDLL(None, use_errno=True)
random.seed(12345)                       # state captured "in the snapshot"

def run(label, forker, reseed=False):
    outs = []
    for tag in ("A", "B"):
        r, w = os.pipe()
        pid = forker()
        if pid == 0:
            os.close(r)
            if reseed: random.seed(os.urandom(32))     # explicit after-restore hook
            msg = f"{random.getrandbits(64):016x} secrets={secrets.token_hex(4)}"
            os.write(w, msg.encode()); os._exit(0)
        os.close(w); outs.append(os.read(r, 200).decode()); os.close(r); os.waitpid(pid, 0)
    same = outs[0].split()[0] == outs[1].split()[0]
    print(f"{label:34s} A={outs[0]}  B={outs[1]}  random_identical={same}")

run("os.fork (hooks run)", os.fork)
run("libc fork (no hooks)", libc.fork)
run("libc fork + explicit reseed", libc.fork, reseed=True)
```

Output on Python 3.12.3, Linux 6.17:

```
os.fork (hooks run)          A=0580214339886322 secrets=cb13dfa5  B=0b33091c82913481 secrets=6458ea85  random_identical=False
libc fork (no hooks)         A=bb91433a6aa79987 secrets=3e7f1498  B=bb91433a6aa79987 secrets=2429fc3e  random_identical=True
libc fork + explicit reseed  A=80a76e7fcd1e78ae secrets=06a766a0  B=ea4164745dfff071 secrets=57574dd5  random_identical=False
```

The unnotified clones produce identical `random` output. Anything derived from that generator in an agent — retry jitter, sampled IDs, temporary file names, a hand-rolled request ID — would collide across clones. An explicit reseed after restore fixes it.

Read the `secrets` column carefully. It differs in every row here, but only because `secrets` reads from the host kernel, which was not cloned in this experiment. Inside a VM restored twice from one snapshot, the guest kernel's CRNG is also duplicated unless VMGenID (or an equivalent) triggers a reseed before the application draws from it. The experiment isolates the user-space layer; it is not evidence that kernel randomness is safe after a VM clone.

## Clocks: the process sleeps, the world does not

A suspended sandbox does not experience the gap. Firecracker's snapshot documentation says the guest wall clock is not corrected automatically; the guest should update it after resume, or the host can use an optional `clock_realtime` flag at snapshot load, in which case the clock "will appear to suddenly jump." Firecracker v1.16.0 also fixed a bug on x86_64 hosts running Linux 5.16 or later where kvm-clock caused the guest *monotonic* clock to jump forward on restore by the wall-clock time elapsed since the snapshot was taken — a violation of the `CLOCK_MONOTONIC` contract that it is not affected by discontinuous jumps. ([Firecracker CHANGELOG](https://github.com/firecracker-microvm/firecracker/blob/main/CHANGELOG.md), [clock_gettime(2)](https://man7.org/linux/man-pages/man2/clock_gettime.2.html))

For an agent, the clock matters in places that are easy to miss:

- **Token expiry.** An OAuth access token cached with "expires in 3600 s, fetched at monotonic t0" looks valid after a two-hour suspend if the monotonic clock did not advance, and is rejected by the server.
- **Leases and locks.** A process holding a distributed lock may still believe it owns the lease after resume, while another worker has already acquired it.
- **Timeouts and schedules.** A tool call started before suspend may have a deadline measured on a clock that did or did not include the gap, depending on platform and kernel.
- **Reasoning about "now".** An agent that stamped "current time" into its working context before suspend will reason with a stale date after resume unless it re-reads the clock.

The safe rule is to treat every time-derived belief as invalid after resume and recompute it against a clock that was re-synchronized.

## Experiment 2: pooled connections die during the pause

The network peer keeps running while the sandbox is frozen. The second experiment stops a client with `SIGSTOP` for 3 seconds while it holds a keep-alive connection to a server whose idle timeout is 1 second, then resumes it.

```
before pause: pong:1
after resume: EOF (peer closed while we were paused)
after reconnect: pong:3
paused for ~3.0s, server idle timeout 1.0s
```

The client's connection object looks healthy after resume; the first read reveals that the peer has closed it. A fresh connection works. Real HTTP clients hit the same pattern with pooled connections, and the documented behavior matches: Fly.io notes stale TCP connections fail with `ECONNRESET` after resume, Modal notes open TCP connections close, gVisor's checkpoint/restore cannot save host sockets, and Lambda's SnapStart guidance says to "always re-establish your network connections when your function resumes from a snapshot." CRIU can carry established TCP connections across a checkpoint, but only with `--tcp-established`, `TCP_REPAIR`, and a network lock to stop the kernel sending resets. ([gVisor checkpoint/restore](https://gvisor.dev/docs/user_guide/checkpoint_restore/), [SnapStart best practices](https://docs.aws.amazon.com/lambda/latest/dg/snapstart-best-practices.html), [CRIU TCP connection](https://criu.org/TCP_connection))

For an agent this includes the model API client, MCP server connections over HTTP or WebSocket, database pools, browser DevTools sessions, and any streaming response that was mid-flight at suspend time.

## Half-finished side effects

The hardest case has no platform-level fix. None of the Firecracker, CRIU, CRaC, or gVisor documentation discusses business-level idempotency; that responsibility stays with the application.

Consider an agent that sent a "create pull request" request and was suspended before reading the response. After resume, the connection is gone. Did the pull request get created? The agent cannot tell from its own memory. If it retries blindly, it may create a duplicate. If the snapshot is restored twice — for example, to fork an agent into two exploration branches — both branches carry the same "about to send" state and may both send.

Lambda's SnapStart guidance names the related risk: warm-up code that runs before the snapshot must not initiate business transactions, because that work would be replayed by every restore. The standard mitigation outside snapshots is the idempotency key: a client-generated key sent with the request so the server can recognize a retry. That pattern carries over, with one twist — **the key must be generated and persisted before the request, and it must not come from a generator that clones duplicate.** An idempotency key drawn from an unreseeded PRNG after restore would be identical across clones, which turns the safety mechanism into a collision.

## A resume contract for agent runtimes

The following checklist is a synthesis of the sources above, framed for an agent runtime rather than a generic service. It assumes nothing about which platform group the sandbox is in.

1. **Detect the event.** Treat any restore as a possible clone. Prefer a platform signal (VMGenID change, `afterRestore` hook, a platform resume callback); if there is none, compare a stored `boot_id`, generation counter, or host-provided restore token at the start of each turn.
2. **Reseed before anything else runs.** Refresh user-space PRNGs, regenerate instance IDs and nonces, and discard any pre-generated random pools. Do this before issuing any request that carries an identifier.
3. **Re-derive time.** Re-read wall-clock time, recompute token expiry and lease ownership from the server's view, and refresh the agent's own notion of "now" in its context.
4. **Drop and rebuild connections.** Close pooled HTTP connections, MCP transports, WebSockets, and database pools rather than probing them. Re-authenticate if credentials were time-bounded.
5. **Reconcile in-flight side effects.** Record intent before each external action (tool name, arguments, idempotency key) and outcome after it. On resume, any intent without an outcome is queried against the external system or retried with the same key — never re-issued with a new one.
6. **Refuse to fork what is not fork-safe.** If the platform allows restoring one snapshot into multiple sandboxes, clear credentials and pending intents in the clones, or require them to re-acquire both.
7. **Prefer rebuild-from-log when the log exists.** A runtime that already persists a session log can resume by replaying it into a fresh process. That trades a slower resume for none of the problems above, and it is the only option on filesystem-only and destroy platforms anyway.

The last point is a design choice rather than a rule. Memory snapshots are valuable when rebuilding state is expensive — a warmed-up browser, a loaded dataset, a long-running language server. For the agent's own conversational state, a durable session log plus rebuild tends to be simpler and survives every platform group. A reasonable split is: snapshot the expensive environment, rebuild the agent.

## Takeaways

- "Pause" means three different things across agent sandbox platforms: memory preserved, disk preserved, or environment destroyed. Know which one you run on.
- A memory snapshot restored more than once is a clone. VMGenID reseeds the guest kernel; application-level randomness, identifiers, and tokens still need an explicit after-restore step. A short Python experiment shows an unnotified clone reproducing the same random stream.
- Clocks, pooled connections, and cached credentials all go stale during suspend. Re-derive them on resume instead of probing them.
- Half-completed side effects are the application's problem. Persist intent and an idempotency key before acting, and generate that key from a source that clones cannot duplicate.
