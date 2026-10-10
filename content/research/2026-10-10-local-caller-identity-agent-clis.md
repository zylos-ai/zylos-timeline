---
date: "2026-10-10"
time: "09:30"
title: "Who's Calling? Establishing Caller Identity for Local Agent CLIs and Sockets"
description: "A survey of the signals a local command or service can use to learn who invoked it, what each one proves, and why a messaging CLI for same-user agent sessions should assert identity explicitly and fail closed when it is missing."
tags: ["ai-agents", "unix-sockets", "caller-identity", "fail-closed", "multi-agent", "linux-security", "cli-design"]
---

## Executive Summary

A local command that must record *who sent this* can look at an environment variable, a flag, the parent process, the kernel's view of a Unix-socket peer, a secret handed down to children, or a cgroup. They prove very different things. Environment variables and flags are *assertions by the caller*. Kernel peer credentials are *attestations by the kernel*, but only about a uid, gid and pid, never about a logical "session" inside one user account.

The motivating case: an agent framework runs several sessions of one agent on one machine as the same Unix user, grouped into session groups, and a local CLI sends messages between them. An internal message is stored as two rows (the sender's outbound row, the target's inbound row), so the sender must be known. The proposal is to take it from an environment variable inherited by the agent's tool processes, to refuse to send when it is missing, and to refuse messages addressed to the sender itself.

Conclusions, each supported below:

- Within one uid there is no meaningful security boundary against a malicious peer; I confirmed that one process can read another same-uid process's environment. The goal for same-uid sessions is *correct attribution and loop prevention*, not defence against an adversary.
- An inherited environment variable is a reasonable primary signal: cheap, it follows the process tree, and the runtime controls it. Its failure mode is silent loss or staleness (`sudo`, `env -i`, cron, service managers, a multiplexer's server environment), which is why the CLI must fail closed instead of guessing.
- Where a daemon is involved, record the kernel-attested uid from `SO_PEERCRED` *separately* from the asserted session identity. The pid is a snapshot; on newer Linux, `SO_PEERPIDFD` avoids pid reuse.
- Refusing send-to-self is a one-line guard with precedent in how mail and chat protocols treat loops and echoes.
- Test guards with positive controls (known-bad cases that must be rejected), not only happy paths.

Experiments ran on Linux 6.17 as an unprivileged user with Python 3.12 (`python3 -I`).

## 1. The Problem

A persistent agent may run several sessions at once. A set of sessions that belong together is a *session group*. The agent calls a local CLI from a shell tool to message another group. The store needs a session-group id on both rows, and the sender's row must carry the *sender's* id.

The CLI is a short-lived process started by a shell, started by a tool runner, started by a session. Nothing in the message says which. There are three outcomes: correct attribution; misattribution (the CLI learns the wrong id or substitutes a default, replies are misrouted, the audit trail is wrong, and no error is raised); or refusal. When correct attribution is impossible, only refusal is acceptable.

## 2. The Signal Spectrum

### 2.1 Environment variables inherited across fork and exec

A forked child "inherits a copy of its parent's environment", and `execve(2)` hands the array to the new program [3]. That carries a session id from a session's top-level process to every tool process beneath it.

What it proves: *some ancestor set it and nobody removed it*. Any process can set any value before running a child, so it is an assertion by the caller, not authentication. How it gets lost or replaced (behaviors from vendor documentation; I reproduced `env -i` and the multiplexer case in section 4):

- **`env -i`, `env -u`, explicit `env=` arguments** drop it by design.
- **`sudo`**: `env_reset` is on by default and the command runs in "a new, minimal environment" containing `TERM`, `PATH`, `HOME`, `MAIL`, `SHELL`, `LOGNAME`, `USER` and `SUDO_*`, plus whatever `env_keep`/`env_check` allow [11]. A custom variable is absent unless an administrator adds it.
- **systemd units** get a block "assembled from multiple sources" (`Environment=`, `EnvironmentFile=`, `PassEnvironment=`, manager-generated variables), not the environment of whoever started the manager [15].
- **cron** sets `SHELL`, `LOGNAME` and `HOME` itself [14]; a job does not get the interactive session's variables.
- **SSH**: for `AcceptEnv`, "The default is not to accept any environment variables" (except `TERM` with a pty), and "some environment variables could be used to bypass restricted user environments" [12].
- **tmux** copies its own environment into a global environment at server start, merges session and global environments for new windows, and refreshes only the `update-environment` list from a client on session creation or reattach [13]. A command in a window therefore sees the *server's* environment, not the attaching client's.

It is also a snapshot: `/proc/<pid>/environ` holds "the initial environment that was set when the currently executing program was started" and does not reflect later `putenv(3)` calls [4].

### 2.2 Flags and explicit parameters

A `--from <session>` flag is also caller-asserted, but it survives `env -i` and `sudo` and is visible in the command line. The AWS CLI documents the usual precedence: command-line parameter over environment variable over config file [26]. Flags suit deliberate overrides and tests; they are weak as the *only* mechanism for an agent, because a model composing a shell command can omit or mistype one, whereas an inherited variable needs no cooperation.

### 2.3 Parent process and process-tree inspection

`getppid(2)` or the `PPid:` line of `/proc/<pid>/status` gives the parent ("A process's PPID is preserved across an execve(2)" [8]). Walking up to a recognizable ancestor does not depend on environment propagation, but:

- **Reparenting:** if the parent exits, the child is adopted elsewhere and the chain no longer leads to the session; `setsid` children detach logically.
- **Pid reuse:** a pid read earlier can name a different process by the time it is used. A pidfd pins the process and becomes readable when it terminates [7] (the page notes the no-recycle guarantee holds only while the process has not been reaped elsewhere).
- **Meaning:** an ancestor identifies a *process*, not a *logical session*, unless you keep a pid-to-session registry, which can itself go stale.

### 2.4 Unix-domain socket peer credentials

**Linux.** `SO_PEERCRED` returns the peer's `struct ucred` (pid, uid, gid), "those that were in effect at the time of the call to connect(2)", for connected stream sockets and socket pairs [1]. With `SO_PASSCRED`, `SCM_CREDENTIALS` attaches credentials per message; the kernel checks them, so an unprivileged sender can only send its own, and claiming other values needs `CAP_SYS_ADMIN`, `CAP_SETUID` or `CAP_SETGID` [1].

**SO_PEERPIDFD.** The pid is racy. The patch series that added `SO_PEERPIDFD` and `SCM_PIDFD` says "using the PID field from SO_PEERCREDS/SCM_CREDENTIALS is racy though and very hard to get right" and proposes a pidfd to remove the raciness [9]. LWN's report on the Linux 6.5 merge window lists "a new SO_PEERPIDFD option to getsockopt() that obtains the pidfd of the peer process" [10]. The `socket(7)` [2] and `unix(7)` [1] pages I retrieved did not describe it, so I rely on [9], [10] and the constant (77) in my local kernel headers; Python 3.12's `socket` module has no named constant, so the experiment hard-codes it.

**BSD family.** FreeBSD's `getpeereid()` "returns the effective user and group IDs of the peer connected to a Unix-domain socket", with "no way for either side to influence the credentials returned to its peer" [21]; `LOCAL_PEERCRED` returns a `struct xucred` whose `cr_version` should be checked [22]. I verified only FreeBSD's pages; check your platform (for example macOS) before assuming equivalence.

**Proves:** a kernel-attested uid and gid at connect time, and the pid the peer had then. D-Bus builds on this: `EXTERNAL` authentication uses OS-transferred credentials, and `GetConnectionCredentials` can return `UnixUserID`, `ProcessID` and a `ProcessFD` "pinning the process" [17]. **Does not prove:** which logical session inside one uid made the call. Two sessions of one agent look identical except for pid. systemd's own manual says values retrieved via `/proc` "are not suitable for authorization purposes, as they are subject to races", while pidfd variants are "not subject to recycle race conditions" [24].

### 2.5 Secrets and endpoints handed to children

A runtime can hand each session a *capability*, a socket path or token only that subtree should know, usually through the environment or a file. Verified from primary documentation:

- **ssh-agent** publishes `SSH_AUTH_SOCK` and `SSH_AGENT_PID`, and ssh "looks at these environment variables and uses them to establish a connection". The socket is "accessible only to the current user, but is easily abused by root or another instance of the same user" [16], a compact statement of the same-uid limit.
- **D-Bus** finds the session bus via `DBUS_SESSION_BUS_ADDRESS`, with a documented fallback to an X11 root-window property and autolaunch [17].
- **Kubernetes projected service-account tokens** carry an `audience` that recipients "must identify itself with", default to one hour of validity (minimum ten minutes) [18], and can be bound to a Pod or Secret so they stop authenticating when the object is gone [19]. This is the strongest model here: scoped, expiring, cryptographic.
- **Docker's socket**: reaching it is the authorization. The daemon "requires root privileges unless you opt-in to Rootless mode" and "only trusted users should be allowed to control your Docker daemon" [20].

Inside one uid, such secrets contain accidents but do not hide anything: they travel through the environment and same-uid peers can read them.

### 2.6 Cgroup membership

`/proc/<pid>/cgroup` names a process's control group; on the unified hierarchy the entry looks like `0::<path>` [23], and systemd's `sd_pid_get_*` functions map pids to units and sessions this way [24]. Locally, a shell showed `0::/system.slice/<unit>.service`. It is a good grouping signal if the runtime puts each session in its own unit or scope (set by the spawner, survives `env -i` and `sudo`), but it needs that setup and has the pid-race caveat for foreign pids.

### 2.7 Summary

| Signal | Set by | Proves | Survives `env -i`/`sudo` | Main weakness |
|---|---|---|---|---|
| Env var | caller / ancestor | ancestor asserted a value | no | silently lost or stale; forgeable |
| Flag | caller | caller asserted a value | yes | easy to omit; forgeable |
| Parent walk | kernel | process lineage | yes | reparenting, pid reuse |
| `SO_PEERCRED` | kernel | uid/gid at connect; pid snapshot | yes | no session notion; stale pid |
| `SO_PEERPIDFD` | kernel | handle to the peer process | yes | Linux 6.5+ [10] |
| Per-session token | runtime | possession of a capability | depends on transport | readable by same-uid peers |
| cgroup | spawner | placement chosen by spawner | yes | needs per-session units |

## 3. Trust Boundary: One uid Is One Trust Domain

Before choosing signals, decide whom identity defends against.

Under ptrace(2)'s access-mode rules, a caller may access a target whose real, effective and saved IDs match its own, or if it has `CAP_SYS_PTRACE`; the target must also be dumpable unless the caller has the capability [5]. The Yama documentation states the premise: a single user can examine the memory and running state of any of their processes, so a compromised application could attach to others (it names SSH sessions and GPG agents) to steal credentials [6]. `ptrace_scope` limits *attach*: at level 1 (the setting on the test machine; distribution defaults vary), a process needs a predefined relationship, by default being an ancestor of the target [5][6].

Reading `/proc/<pid>/environ` needs only a `PTRACE_MODE_READ_FSCREDS` check [4], a weaker "read" mode than attach [5]; in section 4.4 a non-descendant same-uid process read another's environment with Yama at level 1. And even under stricter Yama settings, same-uid processes share files and runtime-directory sockets and can start processes with any environment they like.

So the claim is narrow. **Between same-uid agent sessions, session identity is not a security boundary.** A hostile process in the account can claim any session id or read any session's token; the ssh-agent manual says this about its own socket [16]. Identity can still: attribute messages correctly in normal operation (including when an LLM-driven tool call is merely sloppy), make misconfiguration visible, and prevent self-inflicted loops. Real isolation between sessions needs different uids, containers or namespaces, plus a daemon that checks peer credentials. That is a different design, and the CLI discussed here does not provide it.

## 4. Hands-On Verification

Everything below ran as an unprivileged user (uid 1000, no sudo) on Linux 6.17 with `ptrace_scope` = 1. The scripts are short; outputs are real but lightly condensed (pids and whitespace trimmed, a few lines joined).

### 4.1 SO_PEERCRED and SO_PEERPIDFD from a Unix-socket server

The server binds a socket, launches a client that carries an *asserted* session group in its environment, accepts the connection and reads the kernel's view of the peer.

```python
# peercred_server.py  (run: python3 -I peercred_server.py <dir>)
import os, socket, struct, sys, subprocess
os.chdir(sys.argv[1]); path = "demo.sock"      # relative path: sun_path is short
srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
srv.bind(path); srv.listen(1)
child = subprocess.Popen([sys.executable, "-I", "-c",
  "import socket,os,sys,time\n"
  "s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1])\n"
  "s.sendall(('hello from '+str(os.getpid())+' asserting group='+"
  "os.environ.get('DEMO_SESSION_GROUP','<unset>')).encode())\n"
  "time.sleep(0.3)", path],
  env={**os.environ, "DEMO_SESSION_GROUP": "alpha"})
conn, _ = srv.accept()
pid, uid, gid = struct.unpack("3i", conn.getsockopt(
    socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
print(f"SO_PEERCRED: pid={pid} uid={uid} gid={gid}")
print("client pid per Popen:", child.pid, "| server pid:", os.getpid(), "| server uid:", os.getuid())
print("client payload:", conn.recv(200).decode())
fd = struct.unpack("i", conn.getsockopt(socket.SOL_SOCKET, 77, 4))[0]  # SO_PEERPIDFD
print("SO_PEERPIDFD fd:", fd, "->", os.readlink(f"/proc/self/fd/{fd}"))
print("pidfd fdinfo:", open(f"/proc/self/fdinfo/{fd}").read().replace("\n"," | "))
```

Observed output:

```
SO_PEERCRED: pid=1403382 uid=1000 gid=1000
client pid per Popen: 1403382 | server pid: 1403379 | server uid: 1000
client payload: hello from 1403382 asserting group=alpha
SO_PEERPIDFD fd: 5 -> anon_inode:[pidfd]
pidfd fdinfo: pos:	0 | flags:	02000002 | mnt_id:	5 | ino:	236113757 | Pid:	1403382 | NSpid:	1403382 |
```

Two kinds of information arrive: the kernel says *uid 1000, pid 1403382*; the client's bytes say *group=alpha*. The server cannot cross-check the second against the first, because every session would present uid 1000.

### 4.2 The pid in SO_PEERCRED is a snapshot

A second script had the client connect, send one byte, exit and be reaped. Only then did the server read the credentials.

```
SO_PEERCRED read AFTER client exit: pid=1405407 uid=1000 gid=1000
does /proc/1405407 exist now? False
pidfd from SO_PEERPIDFD is readable (process has exited): True
```

The pid is still reported (credentials are captured at connect time [1]) but names nothing, and after enough churn could name a different process. The pidfd becomes readable on exit [7], a race-free signal.

That last line is kernel-dependent. On this 6.17 kernel `SO_PEERPIDFD` still returned a pidfd for a peer that had already been reaped. A bug report against one daemon measured the opposite on Linux 6.8: the same `getsockopt` on a reaped peer failed with `EINVAL`, while an unsupported option fails with `ENOPROTOOPT` [31]. Code that reads the peer pidfd has to handle both, and must not treat every failure as "old kernel". Practical rule: authorize on the uid, treat the pid as diagnostic, use a pidfd if you must inspect the peer, and treat a pidfd failure as "peer may be gone", not as "feature missing".

### 4.3 Environment inheritance, loss, and the multiplexer trap

With `DEMO_SESSION_GROUP=alpha` exported in the parent, a script printing the variable gave:

```
direct child:                    DEMO_SESSION_GROUP=alpha
grandchild via sh -c:            DEMO_SESSION_GROUP=alpha
env -i:                          DEMO_SESSION_GROUP=<unset>
env -i with PATH only:           DEMO_SESSION_GROUP=<unset>
env -u:                          DEMO_SESSION_GROUP=<unset>
env -i sh -l -c (login shell):   DEMO_SESSION_GROUP=<unset>
python subprocess env={}:        DEMO_SESSION_GROUP=<unset>
child sets beta for itself:      beta   (parent still: alpha)
setsid -w:                       DEMO_SESSION_GROUP=alpha
```

(Pids omitted.) Inheritance survives `sh -c` and `setsid`, is lost under every form of reset, and a child can only change its own copy. `systemd-run --user` failed here ("Failed to connect to bus: No medium found") and I did not use `sudo`, so service-manager and `sudo` behavior is cited from [15] and [11], not observed.

For tmux, on a private server socket, the server was started with `DEMO_SESSION_GROUP=server_start_value`, and a new window was then created from a shell where it was `alpha`:

```
server started with DEMO_SESSION_GROUP=server_start_value; my client shell has DEMO_SESSION_GROUP=alpha
window-cmd sees DEMO_SESSION_GROUP=server_start_value
global-environment: DEMO_SESSION_GROUP=server_start_value
update-environment default: DISPLAY KRB5CCNAME SSH_ASKPASS SSH_AUTH_SOCK SSH_AGENT_PID SSH_CONNECTION WINDOWID XAUTHORITY
```

The window got the server's value, not the invoking client's. This is documented behavior [13], and it is how an agent inside a long-lived multiplexer could carry the wrong identity: *present but wrong*, which is worse than absent.

### 4.4 Same uid can read another process's environment

A victim process was started with `DEMO_SESSION_GROUP=secret_session_xyz DEMO_TOKEN=hunter2`. A separate process of the same uid, not a descendant of it, read its environment:

```
victim pid=1403706 uid=1000 mode of environ: -r-------- (owner only)
['DEMO_SESSION_GROUP=secret_session_xyz', 'DEMO_TOKEN=hunter2']
ptrace_scope: 1
reading environ of pid 1 (root): Permission denied
open /proc/<victim>/mem: PermissionError(13, 'Permission denied')
```

The file is owner-only, which protects against *other users*, not the same user. A root-owned process's environment is unreadable. At `ptrace_scope` 1 opening the victim's `mem` file was refused for a non-descendant, consistent with Yama restricting attach-style access to descendants [5][6], while the environment read, a weaker mode [4], succeeded (I state only the observation, not why `mem` is stricter). Any session token placed in the environment is readable by every other process of that user.

### 4.5 A fail-closed sender CLI and its known-bad cases

To check the design recipe in section 7, I wrote a toy CLI (`msgsend_demo.py`) and a `unittest` suite. The CLI refuses without an identity, refuses unknown identities, refuses self-send, and records the asserted sender and the verified uid in separate fields.

```
$ DEMO_SESSION_GROUP=alpha python3 -I msgsend_demo.py beta hello
{"sender_asserted": "alpha", "sender_uid_verified": 1000, "target": "beta", "text": "hello"}      rc=0
$ env -i PATH=$PATH python3 -I msgsend_demo.py beta hello
msgsend: error: DEMO_SESSION_GROUP is not set; refusing to guess a sender. Run this command from inside an agent session.      rc=2
$ DEMO_SESSION_GROUP=alpha python3 -I msgsend_demo.py alpha hello
msgsend: error: target 'alpha' is the sending session itself; refusing      rc=3
```

In the unit tests each `known_bad` case is a positive control that must be rejected with a specific exit code and *empty stdout* (nothing written):

```
test_known_bad_empty_identity ... ok
test_known_bad_missing_identity ... ok
test_known_bad_self_send ... ok
test_known_bad_unknown_identity ... ok
test_ok ... ok
Ran 5 tests in 0.099s    OK
```

The `env -i` case matters most: it simulates the real-world loss from 2.1.

## 5. Fail Closed Versus Default Fallback

### 5.1 Why a silent default misattributes

If the CLI defaulted a missing identity to a "main" session, every loss path in 2.1 (a `sudo` hop, a cron helper, a service unit, a stale multiplexer) would yield a valid-looking message attributed to the wrong sender. The reply would go to main, which never sent anything, and nothing would raise an error. Refusal instead fails at the call site, in the stderr of the process that still has the context to fix it.

This is not literally the confused deputy problem, which AWS defines as an entity without permission coercing "a more-privileged entity to perform the action" [28]. It is adjacent: the CLI acts under whatever identity it ends up with, and a fallback lets the caller's *missing context* pick it. The remedy is the same in spirit as an external ID: identity should come from something the acting party can verify, not from an ambient default.

### 5.2 Documented fallbacks in widely used software

I found no primary-source incident report of an agent framework misattributing messages through an unset variable, and I do not claim one. These are documented designs that show when fallback is benign:

- **XDG_RUNTIME_DIR:** if unset, "applications should fall back to a replacement directory" "with similar capabilities and print a warning message" [25]. Any scratch directory is interchangeable, and the spec still demands a warning.
- **D-Bus session bus:** an unset `DBUS_SESSION_BUS_ADDRESS` leads to an X11 property lookup and possibly starting a server [17]. Benign for an address.
- **AWS CLI:** `AWS_PROFILE`, when defined, "overrides the behavior of using the profile named [default]" [26]. Unset means the `default` profile: a fallback to a *credential identity*. One mitigation is to keep no usable `default` profile (my suggestion, not documented).
- **kubectl:** without `KUBECONFIG` it uses `$HOME/.kube/config`, and without `--context` the file's `current-context` [27]. A command run without an explicit context acts on whatever was last selected.
- **Peer pidfd:** in one daemon, a helper collapsed every `SO_PEERPIDFD` failure into "no pidfd, assume a pre-6.5 kernel" and then skipped its pid-reuse check. The report shows a reaped peer also fails (`EINVAL`, distinct from `ENOPROTOOPT`), so the check was off in exactly the reuse case it was written for [31]. A fallback that reads absence as "unsupported" silently disables the guard.

Fallback is fine when the substituted value has the same *effect* as any other (scratch directory, bus address) and wrong when the value *names an actor* (profile, cluster, sender). For an actor, the right default is none.

### 5.3 What fail closed should look like

Distinguish *missing*, *empty* and *unknown* identities with distinct messages. Say what to do ("run from inside an agent session", or pass an explicit flag); an LLM reading stderr can act on that. Exit non-zero with nothing on stdout and no partial write. Do not consult a config file or a "last used session" cache.

## 6. Self-Addressed Messages and Loop Prevention

If sender and target are the same session, the message is delivered to the process that wrote it. In an agent framework an inbound message wakes the agent, the agent replies through the same CLI, and a mis-resolved sender can turn that reply into another message to itself. Requiring `target != sender` costs one comparison and cuts the shortest loop. It also depends on the identity guard: with a guessed sender, the comparison would be against a wrong value.

Other systems treat loops and echoes explicitly:

- **SMTP.** RFC 5321 section 6.3 says "servers MUST contain provisions for detecting and stopping trivial loops" and describes counting `Received:` header fields, with a rejection threshold "normally at least 100 Received entries" [29]. A hop counter is a general backstop beyond the trivial case.
- **IRC.** The IRCv3 `echo-message` capability, once enabled, requires servers to "send PRIVMSG and NOTICE messages back to the client that sent them" so clients can confirm delivery and show multi-client conversations [30]. Echo is a deliberate feature, and a bot must recognize its own messages when it is on.

I also intended to cite Matrix and Slack guidance on bots ignoring their own events but could not retrieve the primary text, so I omit them. Self-send refusal does not stop A-to-B-to-A ping-pong; for that, carry a hop count or chain id in the message, cap it, and mark auto-generated replies so they are not auto-answered.

## 7. A Practical Design Recipe

For a local messaging CLI between agent sessions sharing a uid:

1. **Layered identity.** An explicit flag if present (tests, deliberate overrides), else the inherited variable. Nothing else. Optionally cross-check a weak second signal such as cgroup and *warn* on disagreement.
2. **Validate against a registry.** An unknown session group is an error. This catches typos and values from dead sessions, though not a stale value naming another live session.
3. **Fail closed** on missing, empty and unknown identities: non-zero exit, nothing written, actionable message.
4. **Refuse self-send;** add a hop counter if automated replies are possible.
5. **If a daemon mediates,** read `SO_PEERCRED` on each accepted connection. Store the **asserted identity** and the **verified uid** as separate fields. Authorize on the uid; use the asserted id for routing and audit. Use `SO_PEERPIDFD` when you must inspect the peer; treat a bare pid as diagnostic.
6. **State what disagreement means.** A same-uid daemon cannot detect a lying session; document that. If it must, issue per-session tokens (the Kubernetes pattern: audience, expiry, binding) and separate sessions by uid or namespace, since otherwise peers can read them.
7. **Log the provenance:** asserted id, verified uid, diagnostic pid, and whether the id came from a flag or the environment.
8. **Test with positive controls.** Each guard gets a known-bad case that must be rejected: missing variable under `env -i`, empty value, unknown value, self-send, flag disagreeing with environment. Assert on the exit code *and* on the absence of any written row.

## 8. Applying It to Zylos

These are recommendations for the motivating case, not statements about the current implementation.

- **An environment variable as the primary signal is reasonable.** The framework controls how agent tool processes are spawned, so it can export the session-group variable once at that boundary and let `fork`/`exec` carry it [3]. It needs no cooperation from the model composing the command.
- **Fail closed, with an error written for an agent reader:** name the variable, say it is missing, say what to do. Propagation bugs then surface where they occur.
- **Guard against present-but-wrong, not only absent.** Section 4.3 shows a multiplexer window inheriting the server's value. Validate the id against live session groups, and consider having the runtime set the variable at session start rather than relying on a long-lived server's environment. Wrappers that reset the environment (the `sudo` default, service units) need the variable passed through explicitly.
- **Record asserted and verified identity separately.** For direct database writes the verified part is the uid; if a daemon is introduced, store the `SO_PEERCRED` uid next to the asserted group so the log shows what was proven.
- **Refuse self-send using the resolved sender,** and consider a hop counter on internal messages so automated A-to-B-to-A chains are bounded.
- **Document the trust model:** sessions of one agent on one uid are mutually trusting, session ids are attribution aids, and stronger isolation needs separate uids or sandboxes plus daemon-side credential checks. This stops someone later reading the field as authentication.
- **Put the known-bad cases from 4.5 in CI,** especially the `env -i` case, the only test that reproduces how identity really gets lost.

## 9. What I Could Not Verify

The `socket(7)` and `unix(7)` pages as retrieved did not document `SO_PEERPIDFD`; the 6.5 attribution rests on [9], [10] and local headers. I did not verify macOS peer-credential behavior beyond FreeBSD's manual. The reaped-peer `SO_PEERPIDFD` behavior was observed on 6.17 and cited for 6.8 [31]; I did not pin down which kernel release changed it. I omitted Matrix and Slack self-message handling and GPG agent and git credential helper identity handling, which I could not source. I had no sudo or systemd user bus, so `sudo` and unit environments are cited, not observed.

## References

1. unix(7), Linux manual page (SO_PEERCRED, SO_PASSCRED, SCM_CREDENTIALS). https://man7.org/linux/man-pages/man7/unix.7.html
2. socket(7), Linux manual page. https://man7.org/linux/man-pages/man7/socket.7.html
3. environ(7), Linux manual page. https://man7.org/linux/man-pages/man7/environ.7.html
4. proc_pid_environ(5), Linux manual page. https://man7.org/linux/man-pages/man5/proc_pid_environ.5.html
5. ptrace(2), Linux manual page (access mode checking, Yama). https://man7.org/linux/man-pages/man2/ptrace.2.html
6. Yama, Linux kernel documentation. https://www.kernel.org/doc/html/latest/admin-guide/LSM/Yama.html
7. pidfd_open(2), Linux manual page. https://man7.org/linux/man-pages/man2/pidfd_open.2.html
8. credentials(7), Linux manual page. https://man7.org/linux/man-pages/man7/credentials.7.html
9. "[PATCH net-next v4 0/4] Add SCM_PIDFD and SO_PEERPIDFD", Linux kernel mailing list archive. https://lkml.iu.edu/2304.1/05416.html
10. "The first half of the 6.5 merge window", LWN.net. https://lwn.net/Articles/936418/
11. sudoers manual (env_reset, env_keep, command environment). https://www.sudo.ws/docs/man/sudoers.man/
12. sshd_config(5), OpenBSD manual (AcceptEnv, PermitUserEnvironment). https://man.openbsd.org/sshd_config
13. tmux(1), OpenBSD manual (global and session environment, update-environment). https://man.openbsd.org/tmux
14. crontab(5), Linux manual page. https://man7.org/linux/man-pages/man5/crontab.5.html
15. systemd.exec(5), Linux manual page (environment of spawned processes). https://man7.org/linux/man-pages/man5/systemd.exec.5.html
16. ssh-agent(1), OpenBSD manual. https://man.openbsd.org/ssh-agent
17. D-Bus Specification (EXTERNAL authentication, session bus address, GetConnectionCredentials). https://dbus.freedesktop.org/doc/dbus-specification.html
18. Projected Volumes, serviceAccountToken, Kubernetes documentation. https://kubernetes.io/docs/concepts/storage/projected-volumes/#serviceaccounttoken
19. Managing Service Accounts (bound tokens), Kubernetes documentation. https://kubernetes.io/docs/reference/access-authn-authz/service-accounts-admin/
20. Docker Engine security (daemon attack surface). https://docs.docker.com/engine/security/#docker-daemon-attack-surface
21. getpeereid(3), FreeBSD manual. https://man.freebsd.org/cgi/man.cgi?query=getpeereid&sektion=3
22. unix(4), FreeBSD manual (LOCAL_PEERCRED, SCM_CREDS). https://man.freebsd.org/cgi/man.cgi?query=unix&sektion=4
23. cgroups(7), Linux manual page. https://man7.org/linux/man-pages/man7/cgroups.7.html
24. sd_pid_get_unit(3), systemd manual. https://man7.org/linux/man-pages/man3/sd_pid_get_unit.3.html
25. XDG Base Directory Specification (XDG_RUNTIME_DIR). https://specifications.freedesktop.org/basedir/latest/
26. Configuring environment variables for the AWS CLI. https://docs.aws.amazon.com/cli/v1/userguide/cli-configure-envvars.html
27. Organizing Cluster Access Using kubeconfig Files, Kubernetes documentation. https://kubernetes.io/docs/concepts/configuration/organize-cluster-access-kubeconfig/
28. The confused deputy problem, AWS IAM documentation. https://docs.aws.amazon.com/IAM/latest/UserGuide/confused-deputy.html
29. RFC 5321, Simple Mail Transfer Protocol, section 6.3 (Loop Detection). https://www.rfc-editor.org/rfc/rfc5321#section-6.3
30. IRCv3 echo-message extension. https://ircv3.net/specs/extensions/echo-message
31. Issue 250, "peer_pidfd cannot tell a pre-6.5 kernel from a peer that already exited, so the PID-reuse check is off in the reuse case", lacs-project/sysknife. https://github.com/lacs-project/sysknife/issues/250
