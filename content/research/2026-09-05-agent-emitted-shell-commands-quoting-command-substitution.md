---
date: "2026-09-05"
title: "Agent-Emitted Shell Commands: Quoting, Command Substitution, and Template-as-Data Discipline"
description: "Why an AI agent that prints a shell command containing untrusted text must treat that text as data through a proper quoter, not string interpolation, and how to prove it with an executing end-to-end test rather than a regex."
tags: ["research", "shell", "security", "agent-tooling", "testing", "command-injection", "quoting"]
---

## Executive Summary

An agent that *prints* a shell command is, functionally, a code generator. If the text it splices in came from an untrusted or semi-trusted source — a user prompt, a fetched document, a prior tool output — then printing it inside double quotes is not quoting at all: double quotes in POSIX shells still perform parameter expansion (`$`), command substitution (`` ` `` and `$()`), and backslash escaping [1][2][3]. A prompt that happens to contain a backtick span looks, to bash, exactly like an instruction to run a command and inline its output. This is not a bash bug; it is bash working as specified, applied by an author who modeled the string as "text to display" when the executor treats it as "code with one literal region."

This document reconstructs a real failure of that kind in a scheduling component, surveys shell word-expansion mechanics, the threat model when a command's *author* is an LLM and its *executor* is a human or another agent pasting it verbatim, the design patterns that eliminate the bug class, and why only an executing test proves correctness. The throughline: untrusted text bound for a shell must be treated as *data*, carried through one point of quoting discipline, and verified by execution — not by pattern-matching printed characters.

## Case Study

A scheduling component accepted a natural-language description of a recurring job and generated a registration command for a scheduler CLI, of the shape:

```bash
node cli.js add "<prompt>" --cron "0 9 * * *" --task daily
```

The `<prompt>` field was free text from an upstream agent step and, in the failing run, contained two backtick spans: `` `node extract.js fetch <url>` `` (a fetch instruction quoted as an example) and `` `--task daily` `` further along. The component built the line with ordinary double-quote interpolation — the shape a developer writes by hand constantly: `"add \"${prompt}\" --cron \"${cron}\""`.

Because the prompt sat inside a *double-quoted* shell string, none of `$`, backtick substitution, or backslash escapes were suppressed [1][2]. When the line was executed at registration time, three things happened silently: the first backtick span ran as command substitution — bash executed `node extract.js fetch <url>` **immediately, during argument construction**, replacing the span with its stdout, a private conversation transcript spliced into the persisted task prompt (exfiltration-by-substitution, structurally identical to a deliberate attack); the second span, `` `--task daily` ``, was *also* executed, failed silently since `--task` isn't a command, and the flag vanished from the persisted argv with no error surfaced; and inner double quotes were consumed by the shell's quote-removal pass instead of preserved literally.

None of this was visible to a reviewer reading the *printed* text, and no regex could detect it. The string `` `node extract.js fetch ...` `` reads, to a human or static matcher, as an inert quoted example — its danger is a property of the *shell that will later parse it*, not the string's static content: the same bytes are inert as a JSON value, inert inside single quotes, and live inside double quotes. Only executing the printed line — against a fake CLI recording its argv, and a trap that must never fire — revealed the substitution, the vanished flag, and the stripped quotes.

The fix single-quoted the prompt as literal data via the POSIX escaping transform (`'` → `'\''`), so the printed line became:

```bash
node cli.js add 'It'\''s a `node extract.js fetch ...` example with "quotes"' --cron '0 9 * * *' --task daily
```

Inside single quotes, POSIX guarantees no character retains special meaning except the single quote itself [2][4]. The team also added an end-to-end test running the printed command in `bash -c`, capturing argv from a fake `cli.js`, asserting byte-for-byte equality with the source prompt, and confirming an embedded trap never fires.

## Mechanics of Shell Quoting

**Word expansion order.** POSIX defines shell word expansion as an ordered pipeline per word: (1) tilde, parameter, command, and arithmetic expansion, in the order they appear; (2) field splitting of those results; (3) pathname expansion (globbing); (4) quote removal, always last [4][5]. Quoting marks spans so steps 1–2 skip them; quote removal then strips the quote characters. This is why quoting must be decided at *generation* time — by the time a human reads the printed string, expansion hasn't happened, but it has already been decided which characters sit inside which quotes.

**What double quotes suppress, and don't.** Double quotes suppress word splitting, pathname expansion, and most punctuation's special meaning — but `$` (parameter expansion, `$(...)` substitution, arithmetic), the backtick (legacy substitution), and `\` before `$`, `` ` ``, `"`, `\`, or newline retain full meaning [1][2][4]. `!` also retains history-expansion meaning interactively [1]. Double quotes are the wrong tool for untrusted or arbitrary content, which will eventually contain a `$` or a backtick.

**What single quotes do.** Single quotes suppress every character's special meaning, no exceptions — not even backslash [2][4]. The only complication: a single quote cannot appear literally inside one. The standard technique ends the quoted region, inserts an escaped literal quote outside quoting, and resumes: `'` becomes `'\''`. Wrapped around a whole string, this yields a token a POSIX shell parses back to the original bytes for *any* input — the guarantee regex-based "danger character" filtering can never offer.

**`$'...'` ANSI-C quoting**, a `ksh93`-derived extension, interprets C-style escapes (`\n`, `\t`, `\xHH`) inside single-quote-like semantics [6]. It is a *generation*, not *escaping*, tool — safe only if the generator itself escapes every needed byte.

**Heredocs** split the same way: `<<EOF` expands its body like double quotes; `<<'EOF'` suppresses all expansion [7]. An agent building a heredoc from untrusted text that forgets to quote the delimiter recreates the double-quote hazard.

**Built-in quoters.** Bash's `printf '%q'` prints an argument shell-quoted for reuse [8], and (≥4.4) `${var@Q}` does the same via expansion [9] — appropriate only when the generator itself is bash.

## Threat Model for Agent-Emitted Commands

The classical vulnerability class is CWE-78, OS Command Injection: constructing an OS command from externally-influenced input without neutralizing shell metacharacters [10]. Its canonical shape assumes a deliberate human attacker; the agent case generalizes it in two ways that make it easier to trigger by accident.

**The author is a generator, not a hand-typed script.** An LLM-driven component emits the *same textual shape* every time regardless of content; danger is a function of that content at one invocation — benign in every run a developer inspects, manifesting only once a prompt contains a backtick or `$(`. This mirrors GitHub Actions script injection: a `run:` step interpolating `${{ github.event.issue.title }}` directly is safe for ordinary titles and exploitable the moment one contains `"; malicious_command #` — GitHub's proof-of-concept title is `a"; ls $GITHUB_WORKSPACE"` [11][12]. Their fix — an intermediate environment variable, then reference `$VAR`, never interpolating directly — is the same "keep data out of code generation" move as single-quoting the prompt here, at a different layer [12].

**The executor may be a distinct entity.** In "prompt-in-shell" patterns, the vulnerable step is a downstream one treating the LLM's *text output* as shell code. Several MCP (Model Context Protocol) tool servers built shell commands by concatenating tool arguments into `child_process.exec()` calls, letting untrusted content the agent had read (e.g., a git commit message) smuggle `` $(id>/tmp/TEST) `` through a field that looked like ordinary data. CVE-2025-53107 (`git-mcp-server`) is concrete: `git_add`/`git_init`/`git_logs` built commands like `` git -C "${targetPath}" add -- ${filesArg} `` via `exec`, so any metacharacter — reachable via indirect prompt injection — was shell-interpreted; the fix was `execFile()`, which never invokes a shell [13]. Trail of Bits documents an adjacent pattern where allowlisting is defeated by *argument* injection — a "safe" command like `git show` or `rg` accepting a flag (`--output`, `--pre`) that itself causes execution — showing quoting the data is necessary but not sufficient [14].

**Prior art.** The same shape appears in npm `package.json` scripts, where contributor-controlled fields become `npm_package_*` environment variables — safe only if scripts consume them as variables, not by re-interpolating into shell text [15]. A string is code in one context and data in another; the boundary is decided by whoever writes the interpolation.

## Design Patterns

**Treat the payload as data.** The strongest fix is architectural — never print a shell line whose correctness depends on quoting untrusted text right, if there's an alternative:

1. **Skip the shell entirely.** Node's `execFile()`/`spawn()` (no `shell: true`) and Go's `os/exec.Command` pass argv as an array to the OS directly — no shell grammar, no quoting step to get wrong [16][17]; Go's docs call this a deliberate safety property [17]. Right whenever the agent itself executes the command.
2. **When a shell line must be displayed or persisted**, pass the payload through one well-tested quoting function (see Ecosystem Comparison below) and never re-touch it.
3. **Sidestep quoting entirely**: stdin via a heredoc with a *quoted* delimiter, a temp file whose path (not content) is interpolated, or a JSON/argument file the target reads.

**"Never re-wrap in double quotes."** Because the failure recurs when code re-interpolates an already-quoted token into a *new* double-quoted string "for readability," teams adopt a rule: the quoter's output is terminal, never re-wrapped — mirroring GitHub's guidance to route through one intermediate variable and stop [12].

**Prefer structured APIs over printed shell lines.** If a CLI can accept `--file config.json`, read stdin, or expose an RPC call, the bug class disappears entirely. A copy-pasteable command should be a convenience layered on an argv-safe path, not the primary mechanism.

**Agent CLIs face this in reverse.** Tools exposing a "run a shell command" tool execute the model's proposed string through one shell invocation they control, while independently allow-listing the command and flags — addressing CWE-78 on the input side while leaving the string's own shell semantics to the model, exactly why the case study needed its own fix.

## Testing Discipline

**Why text-level assertions are insufficient.** A regex or substring check over the *printed* text ("reject if it contains a backtick") tests a proxy for safety, not safety itself. It cannot tell an inert backtick (inside single quotes) from a live one (inside double quotes), and cannot see interactions between adjacent expansions. The only way to know what a shell will do with a string is to give it to that shell and observe — a check inferring behavior from static shape rather than execution can be green while the property is false.

**The fake-shell end-to-end pattern.** The technique that caught and fixed the case-study bug generalizes:

```bash
# fake cli.js: records argv instead of running anything
printf '%s\0' "$@" > "$RECORD_FILE"

# trap.sh: a canary that must never execute
echo "TRAP FIRED" >> "$TRAP_LOG"; exit 1

# harness
export PATH="$tmp/bin:$PATH"   # fake cli.js/extract.js shadow the real ones
export HOME="$tmp/home"        # isolate from real dotfiles
printed=$(node generate_registration_command.js "$malicious_prompt")
bash -c "$printed"
diff <(cat "$RECORD_FILE") <(expected_argv_bytes)   # byte-for-byte argv
[ ! -f "$TRAP_LOG" ]                                 # trap never fired
```

Essential elements: a fake target CLI on `PATH` that *records* rather than acts; a trapped script whose invocation unambiguously proves injection; `HOME`/`PATH` redirection for a hermetic shell; and byte-for-byte argv equality rather than "contains," since subtle truncation (the vanished `--task daily` flag) is exactly what a loose assertion misses.

**Property-based round-trip tests.** A quoter's correctness claim is universal — for *any* string, quote-then-parse returns the original — a natural fit for generative testing: generate arbitrary strings (empty, all-quotes, control characters, `$`, `` ` ``, `\`), quote each, feed the result through `bash -c 'printf "%s\n" "$1"' -- "$quoted"`, and assert equality. Failures shrink to a minimal reproducer, the same discipline used to find shell-parser bugs in interpreters [24].

**Negative controls.** A suite should include a deliberately *broken* quoter (the original double-quote interpolation) and confirm the harness detects injection — proof the test can fail. A suite never observed failing cannot be trusted to catch a regression.

## Ecosystem Comparison

| Language/tool | Safe argv-array API (no shell) | Built-in/stdlib quoter for shell text | Notable third-party quoter |
|---|---|---|---|
| Bash / POSIX sh | N/A (is the shell) | `printf '%q'`; `${var@Q}` (bash ≥4.4) [8][9] | — |
| Python | `subprocess.run([...])` (no `shell=True`) | `shlex.quote()`, `shlex.join()` (3.8+) [18] | — |
| Node.js | `child_process.execFile()`/`spawn()` without `shell: true` [16] | none in core | `shell-quote` [19], `shescape` (multi-shell) [20] |
| Rust | `std::process::Command` (argv array) | none in std | `shlex` crate [21], `shell-words` crate [22] |
| Go | `os/exec.Command(name, args...)` (deliberately shell-free) [17] | none in std, by design [17] | `github.com/alessio/shellescape` [23] |
| GitHub Actions | pass untrusted value via `env:` then reference `$VAR`, not `${{ }}` inline in `run:` [12] | n/a (YAML → shell boundary) | — |

Every ecosystem's mature answer is the same: the preferred fix is avoiding shell text generation via an argv-array API, not a better quoter. Quoting libraries are the second line of defense for when a shell string is genuinely the deliverable.

## Checklist

- **Default to argv arrays** — `execFile`/`spawn` (no `shell: true`), `subprocess.run([...])`, `os/exec.Command` — when the agent itself executes the command.
- **Quote at one point of construction** with a real POSIX quoter, and treat that output as terminal — never re-wrap it in double quotes "for readability."
- **Never trust double quotes to neutralize untrusted text** — they still evaluate `$`, `` ` ``, `$()`, backslash escapes.
- **Quote heredoc delimiters** (`<<'EOF'`) whenever the body holds untrusted content.
- **Prefer structured channels**: argument files, JSON, stdin, or a native API over shell text.
- **Validate the command's argument surface, not just the data** — a "safe" command can become an execution primitive via `-exec`, `--pre`, `-oProxyCommand`.
- **Test by execution, not pattern-matching** — real shell, fake target recording argv, a trap that must never fire, byte-for-byte assertions.
- **Include a negative control**: the harness must fail on the known-bad version before it's trusted to pass the fixed one.
- **Property-test the quoter**: round-trip arbitrary strings through quote → shell-parse → compare.
- **Route untrusted values through one indirection and stop**, never a direct interpolation.

## References

1. [Quotes - Greg's Wiki](https://mywiki.wooledge.org/Quotes)
2. [GNU Bash Reference Manual](https://www.gnu.org/software/bash/manual/bash.html)
3. [UNIX Shell Quotes tutorial](https://www.grymoire.com/Unix/Quote.html)
4. [POSIX.1-2024, Shell Command Language ch.2](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html)
5. [POSIX Shell Tutorial (Grymoire)](https://www.grymoire.com/Unix/Sh.html)
6. [Advanced Quoting in Shell Scripts – Scripting OS X](https://scriptingosx.com/2020/04/advanced-quoting-in-shell-scripts/)
7. [Bash Heredoc Guide | Linuxize](https://linuxize.com/post/bash-heredoc/)
8. [Bash printf Command | Linuxize](https://linuxize.com/post/bash-printf-command/)
9. [Bash Parameter Transformation ("@Q")](https://s0ands0.github.io/100-days-of-code/r000/048-bash-parameter-transformation/)
10. [CWE-78: OS Command Injection](https://cwe.mitre.org/data/definitions/78.html)
11. [GitHub Actions: Untrusted input | GitHub Security Lab](https://securitylab.github.com/resources/github-actions-untrusted-input/)
12. [Script injections - GitHub Docs](https://docs.github.com/en/actions/concepts/security/script-injections)
13. [git-mcp-server command injection, CVE-2025-53107](https://github.com/advisories/GHSA-3q26-f695-pp76)
14. [Prompt injection to RCE in AI agents - Trail of Bits](https://blog.trailofbits.com/2025/10/22/prompt-injection-to-rce-in-ai-agents/)
15. [Command Injection in package.json | Medium](https://medium.com/lift-security/bypassing-npm-ignore-scripts-with-command-injection-in-package-json-2c08ad7515ca)
16. [Child process | Node.js Documentation](https://nodejs.org/api/child_process.html)
17. [os/exec package - Go Packages](https://pkg.go.dev/os/exec)
18. [shlex — Python 3 documentation](https://docs.python.org/3/library/shlex.html)
19. [shell-quote - npm](https://www.npmjs.com/package/shell-quote)
20. [shescape - npm](https://www.npmjs.com/package/shescape)
21. [shlex - crates.io](https://crates.io/crates/shlex)
22. [shell-words - crates.io](https://crates.io/crates/shell-words)
23. [shellescape - Go Packages](https://pkg.go.dev/github.com/alessio/shellescape)
24. [ShellFuzzer: Grammar-based Fuzzing (arXiv)](https://arxiv.org/html/2408.00433v1)
