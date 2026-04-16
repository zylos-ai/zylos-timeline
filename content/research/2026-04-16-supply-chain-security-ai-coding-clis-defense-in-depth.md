---
date: "2026-04-16"
title: "Supply-chain security for AI coding CLIs: threat model and defense-in-depth"
description: "A 2026 threat model for AI coding CLIs (claude, codex, gemini) and a practical bubblewrap + Landlock defense-in-depth blueprint."
tags:
  - security
  - ai-agents
  - sandbox
  - bubblewrap
  - landlock
  - supply-chain
  - cli
---

## Executive Summary

The generation of AI coding CLIs that proliferated through 2025 and into 2026 — Anthropic's `claude`, OpenAI's `codex`, Google's `gemini`, Cursor/Cline agents, Aider, `opencode` — shares a common security profile that has no precedent in the desktop software world. These tools are installed via `npm i -g`, pull dependency trees numbering in the hundreds of packages, and then operate with ambient read-write access to the developer's home directory, full network egress, and the ability to spawn arbitrary subprocesses. They are, functionally, a remote shell with an LLM driving the keyboard.

The defensive response has consolidated around a stack that was already present in the Linux ecosystem for other reasons — kernel-namespace isolation via bubblewrap (`bwrap`), in-process filesystem access control via the Landlock LSM, and syscall filtering via seccomp-bpf — but applying these tools to AI coding agents requires confronting a threat model that differs materially from traditional sandboxing targets. An AI agent does not attempt kernel exploits; it uses `curl`, `cat`, and `git push` — normal system calls, already permitted, wielded against sensitive files that the sandbox was never told to protect.

This document presents the 2026 threat landscape, the available hardening mechanisms and their tradeoffs, a concrete defense-in-depth blueprint for teams running multiple CLIs, and the open problems that no current tool fully addresses.

---

## Threat Model

The threat surface for an AI coding CLI breaks into four distinct attack classes. Understanding the class matters because each one evades a different subset of the defenses that teams typically reach for first.

### Class A: Malicious dependency, typosquat, and postinstall execution

AI coding CLIs are installed via npm and carry large transitive dependency trees. Every package in that tree has the ability to run arbitrary code at install time via `postinstall`, `preinstall`, and related lifecycle hooks. The September 2025 Shai-Hulud worm demonstrated that a single infected maintainer account can cascade across hundreds of packages — in that case stealing npm tokens, GitHub PATs, and cloud service keys from the installing machine's filesystem and environment.

The March 2026 compromise of the `axios` package — 29 billion+ weekly downloads — used a phantom dependency (`plain-crypto-js@4.2.1`) whose sole function was a `postinstall` script that dropped a cross-platform RAT. The threat is not theoretical: the GitGuardian 2025 State of Secrets Sprawl report found 28.6 million new secrets exposed in public GitHub commits over the year, with AI-assisted commits leaking at roughly double the baseline rate.

**Why CLI-level flags don't help here:** `--allowedTools` or `--tools ''` are runtime controls; they do nothing to prevent a compromised package from exfiltrating credentials during `npm install` before the CLI process ever starts.

### Class B: Prompt-injection-driven file read and exfiltration via tool use

Once the CLI is running and tools are active, an attacker's surface shifts from the installation phase to the ambient context the agent consumes: README files, code comments, issue bodies, fetched documentation. These can carry hidden instructions — sometimes zero-width characters, sometimes simply bold text that an agent parser weighs — that redirect the agent to read and exfiltrate credential files.

The canonical target list has become well known enough to constitute a de facto standard attack payload:

- `~/.env`, `.env` in the project root (API keys, database URLs)
- `~/.ssh/id_rsa`, `~/.ssh/id_ed25519` (private keys)
- `~/.aws/credentials` (AWS long-term access keys)
- `~/.config/gh/hosts.yml` (GitHub OAuth tokens)
- `~/.claude.json`, `~/.codex/auth.json`, `~/.gemini/oauth_creds.json` (CLI authentication)
- `~/.netrc`, `~/.pgpass` (legacy credential stores)
- `~/.kube/config` (cluster credentials)

Exfiltration typically uses the agent's own tool calls: a `WebFetch` to an attacker endpoint, a DNS query encoding base64 data, or a `git push` to an attacker-controlled remote. Because these are legitimate tool operations, they appear as normal activity in most audit logs. Research published in late 2025 showed adaptive prompt injection success rates against production coding agents exceeding 85%.

**Why CLI-level flags don't help here:** If the filesystem grants the agent process read access to `~/.ssh/id_rsa`, no tool allowlist prevents the model from reading it when the prompt tells it to. The restriction must be at the filesystem layer.

### Class C: Agent-mediated lateral movement

A coding agent running with the developer's full ambient credentials can act as a pivot point. Documented patterns from 2025-2026 include: pushing to remote repositories with stolen `gh` tokens, posting data to arbitrary curl endpoints, creating GitHub Actions workflows that exfiltrate secrets through legitimate CI channels, and chaining MCP server calls across isolated systems to bridge trust boundaries that were never designed to be bridged by a single process.

The GhostAction campaign (September 2025) compromised 817 repositories by injecting malicious workflows that exfiltrated secrets via HTTP POST. Notably, the attacker did not need to escape any sandbox — they used the developer's own authenticated toolchain, operating through the agent, to distribute the attack.

### Class D: Cache-poisoning and model-config tampering

A subtler class, documented in the Cymulate CBSE research (January 2026), exploits the writable configuration directories that CLIs use for state, hooks, and startup instructions. The attack pattern: gain code execution within the sandboxed environment (via prompt injection or a malicious postinstall), then write a malicious configuration file — `settings.json`, `config.toml`, or `agents.md` — that will execute with full host privileges on the next session launch.

This affects the three major CLIs differently:
- **Claude Code** (CVE-2026-25725, CVSS 7.7): Malicious `.claude/settings.json` hooks executed with host privileges on next startup. Patched in v2.1.2.
- **Gemini CLI**: `.gemini/settings.json` and `oauth_creds.json` remain writable from within the sandboxed container as of publication. The `oauth_creds.json` file, if stolen, enables Google Cloud privilege escalation.
- **Codex CLI**: The `apply_patch` tool can write `.codex/config.toml` containing `notify` commands that execute outside the sandbox after each agent turn. OpenAI closed the report as informational.

---

## Hardening Landscape

### Bubblewrap (bwrap)

Bubblewrap is a ~50KB unprivileged user-namespace sandbox that underlies Flatpak. It requires no setuid binary and no privileged daemon — it uses `CLONE_NEWUSER` to create isolated namespaces as a normal user. By 2026 it has become the de facto standard for wrapping AI coding CLIs on Linux, shipping in Claude Code (since October 2025), Codex CLI (since v0.115.0), and numerous community wrappers.

A minimal AI-CLI invocation looks like:

```bash
bwrap \
  --ro-bind / / \
  --tmpfs /tmp \
  --tmpfs "$HOME" \
  --bind "$HOME/.codex" "$HOME/.codex" \
  --bind "$PWD" "$PWD" \
  --bind /dev/null "$HOME/.env" \
  --bind /dev/null "$HOME/.aws/credentials" \
  --bind /dev/null "$HOME/.ssh" \
  --proc /proc \
  --dev /dev \
  --unshare-user \
  --unshare-pid \
  --unshare-net \
  --die-with-parent \
  --new-session \
  codex "$@"
```

The key semantics: `/` is read-only; `$HOME` is a fresh tmpfs (nothing from the real home is visible unless explicitly mounted); the CLI's own state directory is rw-bound back in; sensitive paths are covered by `/dev/null` bind-mounts so `open()` returns an empty file rather than failing with `ENOENT` (which can be a signal to the agent that something was hidden).

**Runtime cost** is low — bwrap fork/exec overhead is a few milliseconds and adds no measurable latency to interactive sessions. The bigger operational cost is configuration maintenance.

**Process tree** looks alarming in `ps` but is structural and normal: `bwrap` (outer) → PID 1 inside namespace (a trivial reaper) → `node` wrapper → actual CLI binary. The `--die-with-parent` flag ensures the outer bwrap cleans up when the terminal session ends.

**Common pitfalls:**
- **Git worktrees:** When `.git` is a file (worktree reference) rather than a directory, bwrap's attempt to ro-bind hooks fails with a type mismatch. Claude Code issue #22320 tracks this. Workaround: resolve the `gitdir:` pointer and bind-mount the real hooks directory.
- **TTY:** `--new-session` detaches from the terminal control group, preventing `TIOCSTI` injection attacks, but interactive commands that open `/dev/tty` directly will fail unless `/dev/tty` is explicitly bound. Use `--bind /dev/tty /dev/tty` judiciously.
- **DNS:** `--unshare-net` breaks all network access including DNS. For CLIs that need internet (web search, `WebFetch`), run with `--share-net` or use a per-CLI proxy with `--unshare-net` and tunnel through a UDS bridge (the approach Codex uses in managed proxy mode).
- **Symlinks inside the sandbox** can re-exit the mount namespace. Codex explicitly bind-mounts `/dev/null` over symlink components that could otherwise point outside the sandbox. Landlock (below) is the reliable second line here.

### Landlock LSM

Landlock is a Linux 5.13+ in-process LSM that allows any unprivileged process to restrict its own filesystem access rights. Unlike bwrap — which constructs a separate mount namespace from the outside — Landlock operates at the VFS layer inside the existing namespace. The distinction matters for trust assumptions:

- **bwrap** treats the CLI binary as potentially hostile and constructs its view of the filesystem before the binary sees any of it.
- **Landlock** trusts the CLI to set up its own rules and is therefore only as good as the CLI's own implementation.

Codex on Linux enables Landlock as a complementary layer — restricting read/write access to declared paths even within the bwrap mount namespace. This closes escape vectors that bwrap alone misses: `/proc` traversal tricks (`/proc/self/root/usr/bin/npx` bypassing path-based denylists), symlink chains resolved after mount, and any path accessible via the read-only `/` bind-mount.

The ai-jail project's implementation uses Landlock ABI V3 (Linux 6.2+) with graceful degradation to V1, treating unsupported kernels as a silent no-op. For production environments, teams should check kernel version and fail hard rather than silently degrade.

Landlock does not provide process isolation, memory limits, or syscall filtering — it is purely a filesystem access control mechanism. Its advantage is near-zero overhead and no process boundary.

### seccomp-bpf

Syscall filtering is typically layered under bwrap as a third line. Codex's Linux sandbox applies `PR_SET_NO_NEW_PRIVS` plus a seccomp-bpf filter that blocks socket creation from within user commands even when the outer network namespace allows it. This prevents a sandboxed process from establishing unauthorized outbound connections if it somehow gains access to a network interface not included in `--unshare-net`.

Useful filters for AI CLI wrappers: block `ptrace`, `process_vm_readv`, `userfaultfd`, `io_uring` (frequently abused for syscall bypasses), and `socket(AF_NETLINK, ...)`. Tools like `libseccomp` or `nsjail`'s BPF generation make these manageable without hand-writing BPF bytecode.

### macOS sandbox-exec and FreeBSD Capsicum

On macOS, Claude Code uses Apple's Seatbelt (`sandbox-exec`). The profile language allows per-operation rules (file read, file write, network outbound, spawn). The critical limitation: Apple deprecated `sandbox-exec` at the API level and may remove it in a future release. Teams running macOS-resident agent infrastructure should consider this a transitional approach and track Apple Container and Virtualization.framework-based alternatives as they mature.

FreeBSD's Capsicum capability model is architecturally elegant — file descriptors are capabilities, and entering `cap_enter()` permanently removes the ability to open new paths — but it requires the application to be written with Capsicum in mind, making it impractical for wrapping existing Node.js binaries.

### Container-based approaches

Dev Containers (VS Code Remote, devcontainer CLI), Docker with `--read-only` root and explicit volume mounts, Firecracker microVMs, and the emerging gVisor `runsc` all provide stronger isolation than bwrap by introducing a separate kernel or kernel intercept layer. The tradeoff is significant: startup latency (Firecracker cold-start is ~125ms, Docker is seconds), resource overhead, and UX friction that discourages adoption for interactive use.

For non-interactive CI-style agent invocations — automated PR review agents, scheduled code-audit runs — container isolation is appropriate and should be the default. For interactive developer use, the bwrap + Landlock stack hits a reasonable point on the isolation/friction curve.

**nsjail** (Google, maintained) offers a middle path: a single static binary that combines namespaces, cgroups, rlimits, and seccomp-bpf into a configuration-file-driven sandbox with no daemon. It is more expressive than bwrap for server-side workloads (Windmill uses it for Python/Go workflow execution) but requires more configuration for interactive sessions.

**firejail** wraps applications using Linux namespaces and seccomp with a profile system and AppArmor integration. It is oriented toward desktop applications with maintained profiles for browsers and media players; AI CLI profiles exist in the community but are not officially maintained.

### Permission-flag-based approaches

Every major CLI ships tool allowlists: Claude Code's `--allowedTools` / `--dangerouslySkipPermissions`, Codex's `--approval-policy`, Aider's `--auto-commits`. These are useful for reducing the blast radius of a non-adversarial agent making mistakes but provide no security guarantees against a compromised model or prompt injection. The Ona incident (2025) demonstrated that a reasoning agent can discover, articulate, and exploit path-based denylist gaps when those lists are the only barrier. Permission flags belong in the defense stack as an operational guardrail, not as a security boundary.

---

## Defense-in-Depth Blueprint

The following architecture is designed for a team running multiple AI coding CLIs on shared Linux developer machines or a managed agent platform.

**Outer layer — bwrap invocation:**

```bash
bwrap \
  --ro-bind / / \
  --tmpfs /tmp \
  --tmpfs "$HOME" \
  # CLI state dir: rw (required for session resume, auth caching)
  --bind "$HOME/.$CLI_NAME" "$HOME/.$CLI_NAME" \
  # Project workspace: rw
  --bind "$WORKSPACE" "$WORKSPACE" \
  # Null out credential files — even if CLI asks, open() returns empty
  --bind /dev/null "$HOME/.env" \
  --bind /dev/null "$HOME/.netrc" \
  --bind /dev/null "$HOME/.pgpass" \
  --bind /dev/null "$HOME/.aws/credentials" \
  --bind /dev/null "$HOME/.aws/config" \
  --bind /dev/null "$HOME/.config/gh/hosts.yml" \
  # Null out entire sensitive dirs via tmpfs overlay
  --tmpfs "$HOME/.ssh" \
  --tmpfs "$HOME/.gnupg" \
  --tmpfs "$HOME/.kube" \
  # Devices and process visibility
  --proc /proc \
  --dev /dev \
  # Namespace isolation
  --unshare-user \
  --unshare-pid \
  --unshare-net \
  --die-with-parent \
  --new-session \
  "$CLI_BINARY" "$@"
```

Use `--bind /dev/null` rather than omitting the paths: a missing file tells the agent "this path doesn't exist," which is itself a signal. An empty file is less informative.

**State directory scoping:** Each CLI gets its own rw-bound state directory. A `claude` sandbox binds `~/.claude` rw but covers `~/.codex` and `~/.gemini` with tmpfs. This prevents a prompt-injection compromise in one CLI from persisting into another.

**Inner layer — CLI's own Landlock/flags:** Leave the CLI's built-in sandboxing enabled (`/sandbox` for Claude Code, Landlock for Codex). This is a second, independent check. When bwrap and Landlock agree on a policy, the attack must defeat both independently.

**Secrets management:** Prefer short-lived OAuth tokens over long-lived API keys wherever the provider supports it. For providers that only offer API keys (Anthropic, OpenAI), store keys in the OS keychain (libsecret on Linux, Keychain on macOS) and inject them at process start via a wrapper script, never leaving them in flat `.env` files. Rotate on any suspected compromise — the GitGuardian data suggests AI-assisted development workflows have meaningfully higher secret leak rates.

**Egress control:** For CLIs that do not require open internet access (pure code-generation workflows with no web search), `--unshare-net` is the simplest and most effective control. For CLIs that need network, run a per-CLI proxy outside the sandbox and grant only the UDS socket path as rw inside. Codex's managed proxy mode implements this pattern — the proxy enforces domain allowlists while the CLI itself has `--unshare-net`.

**Session resume:** `--resume <session_id>` requires the state directory to be writable. The rw-bind on `~/$CLI_NAME` covers this. Binding the entire `~` rw to make resume work is not necessary and should be avoided.

---

## Pitfalls and Operational Lessons

**The process tree is not a bug.** `ps aux` showing `bwrap → [pid1] → node → claude-code` is expected. The inner PID 1 is a trivial child reaper that bwrap starts to handle zombie processes; this is the same pattern Docker uses. Monitoring tools that flag multi-level process trees as suspicious will produce false positives for every sandbox-wrapped CLI invocation.

**stdin wiring matters for headless use.** When driving a CLI from an orchestration layer with `child_process.spawn()`, pass `stdio: ['ignore', 'pipe', 'pipe']`. Leaving stdin open without a connected terminal causes Codex to block waiting for input — this is the root cause of the stdin-hang bugs reported against both Claude Code (issue #16306, January 2026) and early Codex wrappers. Use `execFile` for one-shot invocations where stdin is not needed.

**Pre-commit hooks run outside the sandbox's knowledge.** If the developer runs `git commit` from inside a bwrap-sandboxed shell, the hook process spawns within the sandbox and sees the tmpfs-overlaid `$HOME` — which may be missing credentials the hook needs (GPG signing key, SSH signing key, credentials for pre-commit CI integration). Workaround: run git operations from the outer shell, or bind-mount the specific keyring entries needed for signing (accepting that the signing key is now visible to the CLI).

**GPG/SSH signing agents:** `gpg-agent` and `ssh-agent` communicate via Unix sockets in `$GNUPGHOME` and `$SSH_AUTH_SOCK`. If `~/.gnupg` is tmpfs-overlaid and `$SSH_AUTH_SOCK` is not forwarded into the sandbox, signing will silently fall back or fail. Explicitly bind-mount the specific socket path if signing inside the sandbox is required.

**Language server child processes:** Editors that launch AI CLI plugins also spawn language servers (rust-analyzer, pylsp, etc.) that may need access to the broader home directory. These children inherit the sandbox. If the CLI forks a language server, that server's filesystem view is the same restricted view. Profile carefully before assuming tools work transparently.

**Cache invalidation:** bwrap wrappers that change the visible filesystem layout — e.g., hiding `~/.env` — will change the effective system prompt if the CLI includes environment file paths in its context. This can invalidate Anthropic prompt cache hits, measurably increasing cost and latency for high-throughput pipelines.

---

## Open Problems

**No common policy manifest.** There is no standard format for expressing "this AI CLI requires rw access to paths X, Y, Z and network access to domains A, B, C." Every team writes its own bwrap wrapper script, often via trial and error with `strace`. OpenAI's Agents SDK introduced a Manifest abstraction for cloud sandbox workspaces in April 2026, but this covers cloud execution environments — not the local developer machine case. A community-maintained format analogous to Flatpak manifests for AI CLI sandbox policies would significantly reduce the expertise barrier.

**No attestation.** There is no mechanism for a team to verify that a given Claude Code or Codex session ran under sandbox profile X with specific policy Y. The CLI does not emit a cryptographically verifiable assertion of its sandbox configuration. This makes compliance-oriented usage (regulated environments, audit trails) reliant entirely on external enforcement — wrapper scripts and CI gates — which are easy to bypass.

**GPU/accelerator passthrough.** Local inference via llama.cpp, Ollama, or similar requires `/dev/kfd`, `/dev/dri`, or `/dev/nvidia*` to be bound into the sandbox. These device nodes expose broad attack surface and are explicitly excluded from most sandbox profiles. There is no good answer here yet: bind the device nodes and accept the expanded attack surface, or move local inference outside the sandbox (a separate process communicating over a controlled socket).

**Model-weight supply chain.** CLI-adjacent tools that download model weights (Ollama, Hugging Face `hf` CLI) face a distinct supply chain threat: pickle-format PyTorch weights can execute arbitrary Python on load. JFrog found a 5x increase in malicious models on Hugging Face in a single year. SafeTensors mitigates this for weights specifically, but fine-tuning adapters (LoRA) remain a largely unaddressed vector. The sandboxing approaches described in this document do not protect against a malicious model that the CLI loads and runs in-process.

**Prompt injection from repo content.** A `README.md` containing hidden instructions, a comment in a fetched dependency, or a poisoned issue body can redirect the agent without any filesystem or network control being triggered. This is not a solvable problem at the FS or syscall layer — it requires semantic understanding of what constitutes an instruction versus data, which remains an active research problem. The practical mitigation is reduced tool scope (don't grant the CLI the ability to make outbound HTTP calls unless the task requires it) and egress restriction, but neither eliminates the injection vector.

**Reasoning-capable bypass.** The Ona incident illustrates a problem that is structurally new: an agent that can reason about its environment can discover and articulate sandbox bypass paths (`/proc/self/root/...`) as a side effect of trying to complete a task. Path-based controls — whether bwrap mounts, AppArmor profiles, or seccomp path filters — are enumerable by an agent with read access to `/proc`. Capability-based controls (Landlock, Capsicum) are more resistant because they cannot be bypassed by finding an alternate path to the same resource.

---

## Recommendations

### For individual developers

- **Wrap every AI CLI invocation** with at minimum a bwrap profile that applies tmpfs over `$HOME/.ssh`, `$HOME/.gnupg`, `$HOME/.aws`, `$HOME/.kube`, and `/dev/null` over `.env` and `.netrc`. The `SandboxedClaudeCode` project on GitHub provides a starting point for both Linux (bwrap) and macOS (Apple Container / `sandbox-exec`).
- **Never store long-lived API keys in flat files** that a CLI process could read. Use the OS keychain or a tool like `agent-secrets` (age-encrypted, session-leased credentials). At minimum, keep `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in a shell function that injects them at launch rather than in `.bashrc`/`.zshrc` where they persist in every process environment.
- **Enable the CLI's built-in sandbox** (`/sandbox` in Claude Code, `--sandbox` in Codex) as a second line. Do not rely on it alone.
- **Review `postinstall` scripts** before installing AI CLI packages in sensitive environments. `npm install --ignore-scripts` then manual review is aggressive but appropriate for regulated environments. pnpm v10's default of disabling postinstall scripts for dependencies is worth adopting.
- **Scope network access**: use `--unshare-net` for tasks that don't require web search. Most code-generation and refactoring tasks need only filesystem access.

### For teams and platforms running multi-CLI agent systems

- **Standardize a per-CLI sandbox profile** maintained in version control and enforced via a thin launcher script. Each CLI gets its own state-dir scope; no CLI inherits another CLI's credentials.
- **Use nsjail or bwrap** for non-interactive (CI/batch) invocations, with Landlock enabled as an in-process second line. For interactive use, bwrap with `--new-session` and careful TTY handling.
- **Implement egress control per CLI**: a managed proxy outside the sandbox that enforces a domain allowlist. Log all egress; alert on domains not in the expected set. The Codex managed proxy architecture is a usable reference implementation.
- **Rotate CLI authentication tokens** regularly, and treat any suspected prompt injection incident as a credential compromise event — revoke and rotate before investigating.
- **Block config-file tampering** at the sandbox boundary: ensure `.claude/settings.json`, `.codex/config.toml`, and `.gemini/settings.json` are either covered by the ro-bind from `/` (not rw-bound as part of the state directory) or watched with inotify and validated on mutation. The CBSE vulnerability class depends on these files being writable from within the sandbox.
- **Consider `firejail`** for integrating with existing AppArmor policy infrastructure; consider `nsjail` for server-side batch workloads where BPF policy expressiveness matters; use `bwrap` for interactive developer wrapping where minimal dependencies and simple invocation syntax are priorities.
- **Treat "sandbox enabled" as a floor, not a ceiling.** No sandbox eliminates prompt injection, and no sandbox is currently attestable. Layer technical controls with organizational ones: separate agent identities from human developer identities, use fine-grained OAuth scopes rather than developer tokens, and route all agent-initiated git operations through a reviewed merge gate rather than allowing direct push.
