---
date: "2026-06-11"
title: "Cross-Platform Portability of AI Agent Runtime Infrastructure: The macOS vs Linux Divide"
description: "A deep technical analysis of the systemic differences between macOS and Linux that trip up autonomous agent platforms, grounded in a real production incident involving process liveness detection failures, npm git dependency corruption, and environmental drift."
tags: ["agent-infrastructure", "devops", "nodejs", "cross-platform", "macos", "linux", "pm2", "tmux"]
---

## Executive Summary

Self-hosted AI agent platforms that work flawlessly on Linux servers routinely fail in non-obvious ways when deployed on macOS—even by experienced engineers who anticipate platform differences. The gap is not primarily about missing APIs or incompatible system calls. It lies in the subtle, compounding divergences in process model semantics, init-system behaviour, package-manager internals, and the BSD userland that macOS inherits from FreeBSD rather than the GNU ecosystem most server software assumes.

This article dissects those divergences in depth, using a production incident in a self-hosted agent fleet as a running case study. The fleet ran a Node.js-based agent platform that supervised agent processes inside tmux sessions, watched over by a PM2-managed watchdog. On Linux it was solid. On a team member's Mac mini it failed in three independent ways simultaneously—and each failure was caused by a different layer of the stack. Understanding why those failures happened, and how the broader ecosystem has evolved to handle them, gives agent platform builders a practical foundation for shipping reliably to heterogeneous self-hosted fleets.

---

## 1. Process Model Divergence: How macOS and Linux Disagree About What a Process Is

### The `comm` field illusion

The most fundamental difference that tripped the production incident was in how `ps` reports the name of a running process.

On Linux, when you launch a Node.js CLI script via a shebang (`#!/usr/bin/env node`), the kernel's `exec` machinery replaces the process image with the Node interpreter, but the process title visible in `/proc/<pid>/comm` is derived from the **script filename** — the argument passed to the interpreter — not the interpreter itself. So `ps -o comm=` for a process started as `./my-agent-cli` returns `my-agent-cli` (truncated to 15 characters, a historical limitation of the proc filesystem that modern kernels have relaxed but that procps still observes by default).

On macOS there is no `/proc` filesystem at all. Process metadata is surfaced via the `sysctl` KERN_PROC interface and the `libproc` library, which exposes `proc_pidpath()` for the full executable path and `proc_pidinfo()` for detailed per-process data. When `ps -o comm=` is run on macOS, it returns the **interpreter name** — `node` — because the kernel records the executable image that was actually loaded, and the shebang argument is just an argv element, not the process identity. The result: a watchdog that checks whether `my-agent-cli` appears in `ps -o comm=` output will find nothing on macOS, conclude the agent is dead, and begin recovery actions — into the input of a perfectly healthy running agent.

The same divergence applies to thread naming. On Linux, the glibc `pthread_setname_np` call and `/proc/<pid>/task/<tid>/comm` expose per-thread names that tools like `htop` display. Node.js's libuv worker threads appear as named threads on Linux (you may see entries like `V8 WorkerThread` or, for some native modules, `MainThread`). On macOS, thread names exist via `pthread_setname_np` (Darwin variant takes only the name string, not a thread argument), but the naming is less consistently propagated and tools surface it differently.

### Why pgrep -f is not a complete solution — but is a much better one

`pgrep -f` matches against the full command-line string rather than the `comm` field alone. This is portable across macOS and Linux and sidesteps the interpreter-vs-script-name issue entirely. A watchdog that runs:

```bash
pgrep -f "node /absolute/path/to/my-agent-cli" > /dev/null 2>&1
```

will match correctly on both platforms because it is examining `argv`, not `comm`. The cost is false-positive risk if argument strings are similar across processes — which is why the full absolute path matters. On Linux you can also read `/proc/<pid>/cmdline` directly for zero-dependency argument inspection; on macOS the equivalent is `ps -p <pid> -o args=` or the `sysctl` KERN_PROCARGS2 call.

A more robust pattern used by production supervisors is to combine PID file tracking with signal-0 checks:

```bash
kill -0 $(cat /var/run/myagent.pid) 2>/dev/null
```

`kill -0` sends no signal but returns success only if the process exists and the caller has permission to signal it. It is POSIX-standard, available identically on macOS and Linux, and has no dependency on process name semantics.

### How PM2, VS Code, and Docker Desktop handle this portably

PM2 itself avoids the `comm` matching trap by maintaining an internal registry keyed on its own daemon socket, not by querying the OS process name table. The PM2 daemon tracks child PIDs it spawned and watches them via Node.js's `child_process` handle — the OS process name is irrelevant to its own management plane. Problems arise at the *boundary*: the `pm2 startup` command that generates init-system hooks must correctly locate the Node.js binary (which nvm, fnm, or volta may have placed in a user-local path) so the generated plist or unit file contains the right absolute path.

VS Code's process detection for its integrated terminal and extension host uses a combination of PID file tracking and the Node.js `process.pid` API, never relying on `comm` matching. Docker Desktop on macOS runs Linux containers inside a lightweight VM (Apple Virtualization Framework / HyperKit historically), so the container sees Linux `/proc` semantics and the host macOS process model is entirely isolated from the container — a clean abstraction that sidesteps the divergence at the cost of VM overhead.

---

## 2. Service Supervision: launchd vs systemd vs PM2 Cross-Platform Behaviour

### The architectural gulf

On Linux, systemd is PID 1. It manages service lifecycle, socket activation, environment injection, journald logging, and cgroup-based resource control in a single integrated system. Unit files are declarative and version-controlled. Services started by systemd inherit an environment that is explicitly specified in the unit file, making the environment reproducible regardless of who logs in or whether a login session exists.

On macOS, `launchd` is PID 1, but it handles two distinct domains: **LaunchDaemons** (`/Library/LaunchDaemons/`) run as system-level background services before any user logs in, analogous to systemd system services; **LaunchAgents** (`/Library/LaunchAgents/` or `~/Library/LaunchAgents/`) run in the context of a logged-in user session. When `pm2 startup` runs on macOS, it generates a LaunchAgent plist — not a LaunchDaemon — which means the agent only starts after a user logs in interactively. On a headless Mac mini in a server role, this distinction is critical: the agent may never start if the machine reboots unattended.

The environment available to LaunchAgent processes is a stripped-down session environment. It does **not** inherit the PATH modifications from `~/.zshrc`, `~/.bash_profile`, or nvm's shell hooks. The PM2 startup command's standard advice addresses this explicitly: you must prepend the absolute path to the Node binary:

```bash
sudo env PATH=$PATH:/Users/me/.nvm/versions/node/v20.0.0/bin \
  pm2 startup launchd -u me --hp /Users/me
```

Without this, PM2's plist contains a bare `node` reference that resolves only if `/usr/local/bin/node` (the Homebrew path) or another system-level binary exists — which it won't if the team exclusively uses nvm.

### App Nap: macOS energy management as an adversary

macOS's App Nap feature, introduced in OS X Mavericks, throttles background processes that the system determines are idle — specifically those that are not in the foreground, have no visible windows, and have not asserted an IOKit power management token. For terminal multiplexer sessions and daemon processes running inside tmux on macOS, App Nap can introduce severe CPU throttling that looks like process hangs or missed heartbeats from the watchdog's perspective.

Applications prevent App Nap by calling `[NSProcessInfo beginActivityWithOptions:reason:]` with the `NSActivityBackground` flag, or at the system level by creating an `IOPMAssertion` via `IOPMAssertionCreateWithName`. Node.js processes don't do this automatically. A workaround for long-running Node.js daemons is to disable App Nap for the specific application bundle via:

```bash
defaults write com.apple.dt.Xcode NSAppSleepDisabled -bool YES
# Or for a specific binary:
defaults write -g NSAppSleepDisabled -bool YES
```

The blanket global setting has system-wide power implications; the preferred production approach is to add an explicit `KeepAlive` key to the launchd plist and set the process's `ThrottleInterval` to 0, signalling to launchd that the process should be kept warm.

### PM2 cross-platform ecosystem file behaviour

PM2's `ecosystem.config.js` is platform-agnostic in its declaration, but platform-specific in what those declarations produce. The `interpreter` key must point to an absolute path on macOS if nvm is in use, because PM2 resolves it at daemon startup time in the launchd-launched non-login environment. The same config that works on Linux (where `/usr/bin/node` is typically a stable symlink to the system Node) silently fails on macOS where `/usr/bin/node` does not exist (System Integrity Protection prevents writing there) and the real binary is three symlink hops away in `~/.nvm/`.

---

## 3. Packaging and Distribution: npm Git Dependencies and the Integrity Gap

### How npm installs git dependencies

When you specify a GitHub dependency in `package.json` using the git protocol — `"my-pkg": "github:org/repo#semver:^1.0.0"` or `"my-pkg": "git+https://github.com/org/repo.git"` — npm's install flow is fundamentally different from a registry tarball install:

1. npm clones the repository into a temp directory under `~/.npm/_cacache/tmp/git-clone-<hash>/`
2. It runs the package's `prepare` script (which may involve TypeScript compilation, native addon builds, or asset bundling)
3. It packs the result into a tarball and places it in the content-addressable cache
4. It installs from that cached tarball into `node_modules`

The key exposure: **the symlink from the installed package into `_cacache/tmp/git-clone-*` is sometimes not cleaned up correctly**, particularly on macOS where the filesystem's extended attribute handling and the different TMPDIR (`/var/folders/<hash>/T/`) can cause Git's cleanup hooks to leave the temp directory behind. When the temp directory is later purged by macOS's dirhelper daemon (which removes files in TMPDIR not accessed within 3 days), the symlink becomes dangling — and the package appears installed (`node -e "require('my-pkg')"` may work from cache), but direct file access to the package's own assets (config files, templates, bin scripts) fails with ENOENT.

This is precisely the failure pattern in the production incident: `npm ls my-pkg` reported the correct version; `node -e "require('my-pkg/package.json').version"` returned the right string (loaded from cache); but the CLI's own data files, which it loaded via `__dirname`-relative paths, were missing because `__dirname` resolved into the dangling symlink's former target.

### Why tarball installs are more robust

Installing from a GitHub archive tarball bypasses git entirely:

```json
"my-pkg": "https://github.com/org/repo/archive/refs/tags/v1.2.3.tar.gz"
```

npm downloads the archive, extracts it, and installs directly — no temp clone, no symlink, no `prepare` script execution (tarballs are assumed pre-built). This is the same path that registry publishes use, which is why registry installs are the most reliable. The tradeoff is that git protocol installs give you the ability to install from branches and run build steps, at the cost of this extra fragility.

The production incident's fix — switching from `git+https://` to a `tarball` URL pointing to a tagged archive — traded build-time flexibility for install-time reliability. For packages where the author publishes pre-built output to the repo, this is strictly better. For packages that require a build step on the consumer side (e.g., packages with native addons that aren't pre-built), neither approach is clean — and the real answer is proper registry publishing.

### The "version reports fine but files are missing" diagnostic

This failure mode is insidious because conventional integrity checks pass. `npm ls`, `npm audit`, and `require()` on the package's entry point all succeed. The gap is visible only when you inspect the physical filesystem:

```bash
# Check if installed package path is a broken symlink
ls -la node_modules/my-pkg
# If output shows -> /path/that/does/not/exist, you have a dangling symlink

# npm's own doctor pattern: verify the content-addressable cache
npm cache verify

# Manual check: does __dirname resolve to a real path?
node -e "const p = require.resolve('my-pkg'); const fs = require('fs'); \
  console.log(fs.realpathSync(require('path').dirname(p)))"
```

The `flutter doctor`, `expo doctor`, and `react-native doctor` patterns — and npm's own `npm doctor` command — address this by running a suite of environmental checks rather than relying on the package manager's own accounting. The `npm doctor` command specifically validates that cached tarballs have correct checksums and that the node_modules tree is consistent with package-lock.json. Agent platform CLIs should implement analogous self-diagnostics: walk their own installation directory, verify key file presence, check symlink validity, and report actionable errors rather than cryptic ENOENT failures at runtime.

---

## 4. Terminal and Session Infrastructure: tmux Portability

### Socket path divergence

tmux stores its server socket under `$TMUX_TMPDIR/tmux-<UID>/`, falling back to `$TMPDIR` and then `/tmp` if those variables are unset. On Linux, `TMPDIR` is typically unset in daemon contexts and `/tmp` is used — a stable, well-known path. On macOS, `TMPDIR` is set by the OS to a per-user ephemeral directory under `/var/folders/<hash>/<hash>/T/` that changes between boots and is managed by the dirhelper daemon.

This has two practical consequences for agent platforms:

1. **Cross-session tmux access fails.** A script that hardcodes `/tmp/tmux-1000/default` to attach to a named tmux session will work on Linux but silently fail on macOS where the socket is at a path like `/var/folders/zz/zyxvpxvq6csfxvn_n00008g80000011/T/tmux-501/default`. The portable fix is to always use `tmux -L <socket-name>` with an explicitly set `TMUX_TMPDIR` pointing to a stable per-application location (e.g., `~/.myapp/run/`).

2. **PM2's watchdog cannot find the tmux session.** If the watchdog script is launched by launchd in an environment where `TMUX_TMPDIR` and `TMPDIR` are inherited from the launchd plist rather than the user's shell session, it may look for sockets in `/tmp` while tmux placed them in `/var/folders/`.

### BSD userland vs GNU userland

macOS ships BSD versions of core utilities — sed, awk, ps, find, xargs — rather than the GNU versions installed on Linux distributions. The differences are numerous and under-documented:

- `sed -i` on macOS requires an explicit backup suffix argument: `sed -i '' 's/foo/bar/g' file.txt`. On GNU sed, `sed -i 's/foo/bar/g' file.txt` works without the empty string.
- `ps -o comm=` semantics differ as described above.
- `date` formatting flags differ: GNU `date -d` for date arithmetic is macOS-incompatible; the BSD equivalent is `date -v`.
- `find`'s `-regex` uses ERE on GNU and BRE by default on BSD.

Agent platform shell scripts that embed any of these patterns will fail silently or noisily on macOS. The portable solution is to either install GNU coreutils via Homebrew (`brew install gnu-sed coreutils`) and use the `g`-prefixed binaries (`gsed`, `gdate`), or restrict scripts to POSIX-only features and test on both platforms in CI.

### Shell initialization in tmux sessions

On Linux, the default shell is bash in most server contexts, and tmux inherits it. On macOS since Catalina, the default login shell is zsh. tmux by default spawns new windows with the user's login shell — but "login shell" in tmux's context depends on the `default-shell` configuration and whether tmux was started with `-l` (login) flag. An agent that depends on shell environment variables set in `~/.bashrc` will find them missing in a tmux pane on macOS where zsh is the default and `~/.bashrc` is not sourced. The production-safe pattern is to set environment variables required by the agent inside the tmux session explicitly using `tmux setenv` or by embedding them in the launchd plist's `EnvironmentVariables` dictionary.

---

## 5. Filesystem and Environment Differences

### APFS case insensitivity

APFS, the macOS default filesystem, is case-insensitive but case-preserving by default. Linux filesystems (ext4, XFS, btrfs) are case-sensitive. For agent platforms that load configuration files, plugins, or resources by filename, this creates a silent portability hazard: a module that works on macOS with mixed-case filename references will fail with ENOENT on Linux. The canonical manifestation is in `require()` calls or dynamic `import()` paths where the case used in code doesn't match the actual filename — which git may silently fail to track as a rename on macOS, delivering the wrong filename to Linux CI.

The mitigation is to enable case-sensitive volumes for development on macOS (`diskutil apfs addVolume disk0 APFS CaseSensitive DevWork`) and to run linting rules (e.g., `eslint-plugin-import` with `no-unresolved`) that catch case mismatches in imports at build time.

### Gatekeeper and the quarantine extended attribute

When a binary or script is downloaded on macOS (via a browser, curl with automatic quarantine-setting, or archive extraction), macOS sets the `com.apple.quarantine` extended attribute on the file. Gatekeeper then intercepts execution and presents a consent dialog — or outright blocks execution if the binary is unsigned. For agent platforms that distribute CLI binaries via GitHub releases (a `.tar.gz` with a compiled binary inside), the end user on macOS will encounter a Gatekeeper block on first execution.

The mitigation paths are:
1. **Code signing and notarization**: Apple's official path requires a paid developer account and the notarytool pipeline.
2. **Manual quarantine removal**: `xattr -d com.apple.quarantine ./my-agent-binary` — documented in installation guides.
3. **Distribute via Homebrew**: Homebrew's installation mechanism handles quarantine flags and code trust on behalf of the user.
4. **Distribute as an npm package**: npm-installed binaries in `node_modules/.bin/` do not have the quarantine attribute set because they are not downloaded as standalone executables.

The production incident avoided this issue because the agent was launched via node directly (not as a compiled binary), but teams distributing pre-compiled agents via Bun or Deno's compile output will encounter it.

### File watching: FSEvents vs inotify

Agent platforms that support hot-reload or config watching use platform filesystem event APIs under the hood. On Linux, inotify (or the newer fanotify) provides granular per-file event delivery. On macOS, FSEvents watches entire directory trees and aggregates rapid changes before delivering notifications — individual file events may be batched and coalesced, introducing latency. Libraries like `chokidar` (the Node.js ecosystem standard) abstract over both APIs but expose different tuning parameters per platform. The key operational difference for agents is that inotify can exhaust system limits (`fs.inotify.max_user_watches`, typically 65536) on large repos, while FSEvents has no such per-watch limit but can deliver false-positive change events during cache warming.

---

## 6. Industry Practice: How Major Tools Achieve Mac+Linux Parity

### GitHub Actions runner matrices

The standard industry approach to cross-platform validation is the CI matrix. GitHub Actions allows specifying `os: [ubuntu-latest, macos-latest]` to run the same test suite against both platforms in parallel. Node.js projects test against a matrix of OS × Node version combinations (e.g., Ubuntu 22.04, Ubuntu 24.04, macOS 14, macOS 15 across Node 18, 20, 22). Platform-specific step overrides use `if: runner.os == 'macOS'` conditional guards. This catches divergences at PR time rather than in production — but only if the test suite exercises the platform-sensitive paths (process detection, file watching, shell invocation).

### Tailscale's cross-platform Go strategy

Tailscale is written in Go, which produces statically linked binaries with no runtime dependency. The Go toolchain supports cross-compilation natively (`GOOS=darwin GOARCH=arm64 go build`) from any host. Tailscale's CI disables CGO (`CGO_ENABLED=0`) for most build targets to guarantee portability. The result is a single binary that behaves identically on Linux and macOS at the process and network layer. For agent platforms, this approach is an "escape hatch" from the interpreter-detection problem entirely: a Go or Rust binary appears in `ps` output as itself, not as a language interpreter.

### Bun and Deno compile as interpreter-escape

`bun build --compile` and `deno compile` both produce self-contained executables that embed the JavaScript runtime alongside the application code. The resulting binary, when listed in `ps`, appears as the binary's own name — not as `bun` or `deno` — because the OS records the executable image loaded, not the runtime embedded inside it. This directly solves the production incident's watchdog detection problem: a compiled agent binary named `my-agent` will appear as `my-agent` in `ps -o comm=` on both macOS and Linux. Cross-compilation is available in both tools (Bun since v1.1.5, Deno since early versions), allowing macOS-to-Linux builds from a single developer machine.

The trade-off is binary size (Bun-compiled binaries are smaller due to tree-shaking; Deno binaries are larger but include a broader standard library) and loss of dynamic `require()` at runtime — acceptable for most agent CLI use cases.

### Homebrew's dual-platform model

Homebrew runs on both macOS and Linux (the latter formerly as "Linuxbrew"), distributing pre-compiled bottles to avoid build-time differences. Its Linux installation targets `~/.linuxbrew` or `/home/linuxbrew/.linuxbrew` rather than `/usr/local` (macOS default) or `/opt/homebrew` (Apple Silicon). This prefix divergence is a microcosm of the broader problem: the same package, installed by the same tool, lives in different locations on different platforms and must be found by PATH or by absolute path. Homebrew's lesson for agent platforms is to use a stable, user-controlled prefix and document it explicitly rather than relying on ambient PATH configuration.

---

## 7. Practical Recommendations for Agent Platform Builders

### Checklist for heterogeneous fleet portability

**Process detection and supervision:**
- Never use `ps -o comm=` or `pgrep` without `-f` for liveness detection of Node.js processes started via shebang. Use `pgrep -f <full-command-line-pattern>` or PID file + `kill -0`.
- Write agent PIDs to a lockfile at startup; have the watchdog check the lockfile and validate via `kill -0` before declaring the process dead.
- Consider compiling the agent to a named binary (`bun build --compile`, `deno compile`, or Go/Rust) so `ps -o comm=` returns a deterministic, platform-consistent name.
- Set `process.title` in Node.js agents at startup to a unique, identifiable string — on Linux this writes to `/proc/<pid>/comm`; on macOS it updates the value visible via `ps -o comm=`. This is not a complete solution (truncation applies) but narrows the identity gap.

**Service supervision:**
- For macOS production deployments, generate a LaunchDaemon (not LaunchAgent) if the service must survive without user login; accept the complexity of running as a dedicated service account.
- Embed absolute Node.js binary paths in all init-system configurations. Never rely on PATH resolution at daemon startup time.
- Add `KeepAlive: true` and `ThrottleInterval: 0` to launchd plists for agent processes to suppress App Nap throttling.
- Maintain separate `ecosystem.config.js` or init-system templates per platform, generated by a bootstrap script that detects `process.platform` and resolves the Node binary via `which node` at setup time.

**Packaging and install integrity:**
- Prefer GitHub release tarball URLs over `git+https://` dependencies for stable external packages.
- Implement a `doctor` command in the agent CLI that checks: symlink validity in `node_modules`, presence of key data files via `fs.existsSync()` with realpathSync resolution, Node.js version compatibility, and disk space headroom.
- Use `npm ci` (not `npm install`) in automated/CI contexts — it performs strict lockfile validation and will fail rather than silently install corrupted packages.
- For native addon dependencies, pre-build platform-specific binaries and distribute them as GitHub release assets; use `node-pre-gyp` or `prebuildify` patterns to select the correct binary at install time.

**Terminal and shell environment:**
- Always set `TMUX_TMPDIR` to a stable application-controlled path (e.g., `~/.myapp/run/`) before starting the tmux server. Never rely on OS-default `TMPDIR`.
- Use `tmux -L <name>` with a fixed socket name for all attach/send-keys operations.
- Set `default-shell` in `.tmux.conf` to an explicit absolute path rather than relying on `$SHELL` inheritance.
- Declare all environment variables required by the agent in the init-system config, not in shell dotfiles.

**Filesystem and environment:**
- Run development on case-sensitive APFS volumes to catch case-mismatch bugs before they reach Linux CI.
- Handle the Gatekeeper quarantine attribute in distribution documentation; for pre-compiled binary distribution, invest in code signing and notarization or route through Homebrew.
- Use `chokidar` or `@parcel/watcher` (cross-platform FSEvents/inotify abstraction) for file watching; tune `awaitWriteFinish` options for FSEvents' batch-coalescing behaviour on macOS.

**CI and observability:**
- Run the full agent test suite on both `ubuntu-latest` and `macos-latest` in GitHub Actions with a matrix strategy. Include integration tests that exercise the watchdog's liveness detection, tmux session management, and package install paths.
- Emit platform telemetry at startup (`process.platform`, `os.release()`, Node.js version, nvm/system Node, tmux version, disk usage) to a log sink. When incidents occur in heterogeneous fleets, this context is the first thing you need.
- Track platform-specific failure rates separately in your monitoring stack — a 2% error rate on macOS that is zero on Linux is invisible when aggregated.

---

## Conclusion

The macOS vs Linux divide for autonomous agent platforms is not a single gap — it is a layered accumulation of inherited BSD semantics, energy management heuristics, filesystem defaults, init-system architecture differences, and package manager internals that each independently behave correctly but compose into surprising failure modes. The production incident described here failed in exactly three of these layers simultaneously, and each failure required different expertise to diagnose.

The most durable long-term mitigation is to compile agents to named platform binaries (eliminating interpreter-detection ambiguity), declare all environmental dependencies explicitly in init-system configuration (eliminating shell-environment drift), and ship a `doctor` command that performs structural integrity checks at runtime (catching install-time corruption before it becomes a runtime mystery). These three principles, combined with a CI matrix that treats macOS as a first-class target rather than an afterthought, close the majority of the portability gap that currently sends "works on my Linux server, broken on my Mac" incident reports to engineering teams.

---

## References

- [PS Command: Process status in macOS — ss64.com](https://ss64.com/mac/ps.html)
- [ps(1) Linux manual page — man7.org](https://man7.org/linux/man-pages/man1/ps.1.html)
- [Shebang (Unix) — Wikipedia](https://en.wikipedia.org/wiki/Shebang_(Unix))
- [Retrieving the full path of a process on macOS (libproc exploration) — ops.tips](https://ops.tips/blog/macos-pid-absolute-path-and-procfs-exploration/)
- [macOS Alternative to /proc — MacRumors Forums](https://forums.macrumors.com/threads/alternative-to-the-proc.1532864/)
- [libproc-rs: Rust library for process info on Mac and Linux — GitHub](https://github.com/andrewdavidmackenzie/libproc-rs)
- [PM2 Startup Script documentation — pm2.keymetrics.io](https://pm2.keymetrics.io/docs/usage/startup/)
- [PM2 startup launchctl issue on macOS — GitHub Issue #4318](https://github.com/Unitech/pm2/issues/4318)
- [Process Manager Comparison 2026 — Oxmgr](https://oxmgr.empellio.com/blog/process-manager-comparison)
- [npm git dependency .gitignore missing in tmp clone — GitHub Issue #2144](https://github.com/npm/cli/issues/2144)
- [npm symlinks missing for local modules — GitHub Issue #3185](https://github.com/npm/cli/issues/3185)
- [npm install from GitHub: Practical Guide 2026 — thelinuxcode.com](https://thelinuxcode.com/install-npm-packages-directly-from-github-a-practical-2026-guide/)
- [npm prepare script not called for git dependencies — GitHub Issue #17646](https://github.com/npm/npm/issues/17646)
- [npm-doctor documentation — docs.npmjs.com](https://docs.npmjs.com/cli/v11/commands/npm-doctor/)
- [Platform Compatibility — tmux DeepWiki](https://deepwiki.com/tmux/tmux/8.2-platform-compatibility)
- [tmux(1) Linux manual page — man7.org](https://www.man7.org/linux/man-pages/man1/tmux.1.html)
- [macOS App Nap documentation — Apple Developer Library](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/AppNap.html)
- [macOS Gatekeeper / Quarantine / XProtect — HackTricks](https://hacktricks.wiki/en/macos-hardening/macos-security-and-privilege-escalation/macos-security-protections/macos-gatekeeper.html)
- [macOS FS vs Linux FS: case sensitivity — p3ld3v blog](https://blog.p3ld3v.dev/macos-fs-vs-linux-fs-case-sensitivity)
- [FSEvents vs inotify: fswatch cross-platform monitor — GitHub](https://github.com/emcrisostomo/fswatch)
- [BSD/macOS sed vs GNU sed vs POSIX — RIP Tutorial](https://riptutorial.com/sed/topic/9436/bsd-macos-sed-vs--gnu-sed-vs--the-posix-sed-specification)
- [GNU sed vs BSD sed — Baeldung on Linux](https://www.baeldung.com/linux/gnu-bsd-stream-editor)
- [BSD vs GNU vs Busybox incompatibilities — HackMD](https://hackmd.io/@maelvls/bsd-vs-gnu-vs-busybox-incompat)
- [GitHub Actions macOS runner changes 2025 — roundfleet.com](https://www.roundfleet.com/blog/github-actions-macos-runners-changes-2025)
- [GitHub Actions matrix strategy — GitHub Docs](https://docs.github.com/actions/writing-workflows/choosing-what-your-workflow-does/running-variations-of-jobs-in-a-workflow)
- [Tailscale CI/CD pipeline and cross-platform strategy — DeepWiki](https://deepwiki.com/tailscale/tailscale/8.5-installation-and-distribution)
- [Bun cross-compile executable binaries — Mamezou Developer Portal](https://developer.mamezou-tech.com/en/blogs/2024/05/20/bun-cross-compile/)
- [Deno compile: self-contained executables — deno.com](https://deno.com/blog/deno-compile-executable-programs)
- [Homebrew on Linux documentation — docs.brew.sh](https://docs.brew.sh/Homebrew-on-Linux)
- [macOS /var/folders and TMPDIR — Apple Developer Forums](https://developer.apple.com/forums/thread/71382)
- [nvm: Node Version Manager — GitHub](https://github.com/nvm-sh/nvm)
- [Unix Shell initialization (pyenv wiki) — GitHub](https://github.com/pyenv/pyenv/wiki/Unix-Shell-initialization)
- [flutter doctor command guide — flutterfever.com](https://flutterfever.com/flutter-doctor-command/)
- [react-native doctor diagnostic tool — Medium](https://aravindmnair.medium.com/meet-the-new-diagnostic-tool-for-react-native-react-native-doctor-b3b0df20eec7)
- [pgrep command in Linux — Linuxize](https://linuxize.com/post/pgrep-command-in-linux/)
- [How to Write Portable Shell Scripts — oneuptime.com](https://oneuptime.com/blog/post/2026-01-24-portable-shell-scripts/view)
