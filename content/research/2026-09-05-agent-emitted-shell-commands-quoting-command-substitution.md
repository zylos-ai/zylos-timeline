---
date: "2026-09-05"
title: "Agent-Emitted POSIX Shell Commands: Preserve Data Across the Parse Boundary"
description: "How to keep untrusted text literal when an agent must emit a POSIX shell command, where quoting stops helping, and how to test the real parser boundary with byte-framed argv checks."
tags: ["research", "shell", "security", "agent-tooling", "testing", "command-injection", "quoting"]
---

## Executive Summary

An agent that emits a command for a POSIX-like shell is generating code. If it places externally influenced text inside double quotes, that text is not necessarily literal: `$()`, backticks, parameter expansion, and some backslash sequences remain active in double quotes [1][2]. A prompt containing a command example can therefore change the command that eventually runs.

The safest design is to avoid shell text: call a process API with an argument array, or pass the payload through stdin or a file. When POSIX/Bash source is the required output, encode each data argument for that exact shell parse boundary. Once bytes have reached a non-interactive POSIX shell parser, a portable single-quote encoder can represent every non-NUL string supported by the generator's runtime encoding: surround the value with single quotes and replace each embedded `'` with `'\''`.

That guarantee is deliberately narrow. It does not validate options, executable names, or nested commands; it does not carry automatically across a second `eval`, `sh -c`, SSH hop, or YAML-to-shell expansion; and it is not a Windows command-line quoting rule. Test the boundary that will actually parse the emitted text, with a fake target that records argv and a known-bad positive control that proves the test can fail.

## The Failure Shape

Consider a scheduler that prints a registration command:

```bash
node cli.js add "<prompt>" --cron "0 9 * * *" --task daily
```

The prompt is ordinary text to the scheduler, but it becomes shell source when someone pastes the line. If the generator substitutes this value:

```text
Summarize the output of `node extract.js fetch <url>`.
```

the backtick span is command substitution inside double quotes. Inside that substitution, `<url>` is tokenized as input redirection from `url` followed by an output-redirection operator with no operand before the closing backtick. The substitution is therefore syntactically incomplete: the shell fails before `node` runs or either redirection can touch the filesystem. Shell and caller behavior still differ. Bash can emit the substitution error, replace that span with empty text, continue the surrounding command, and ultimately return status 0; dash exits with status 2. A separate later backtick span such as `` `--task daily` `` normally emits a `command not found` diagnostic and substitutes an empty string; it is not the scheduler's outer `--task daily` option. Hiding stderr or checking only the outer Bash status can therefore leave mutated prompt content looking successful.

The important distinction is not whether a string *looks* like prose. It is whether a parser will consume those bytes as code. The same backticks are inert in a JSON string, inert inside POSIX single quotes, and active inside shell double quotes.

This is an instance of OS command injection, classified as CWE-78 [14]. It is not hypothetical in agent tooling: GitHub's advisory for CVE-2025-53107 documents an MCP server that passed unsanitized tool parameters to Node's `child_process.exec`, allowing injected commands to run, including through an indirect-prompt-injection path [15].

For a POSIX shell token, encode the prompt as data:

```bash
node cli.js add 'It'\''s a `node extract.js fetch <url>` example with "quotes"' \
  --cron '0 9 * * *' --task daily
```

The four-character shell source sequence `'\''` works by ending the single-quoted region, adding one escaped quote, and reopening the region. After one POSIX/Bash parse, the target receives the original apostrophe as data [1][2].

## What the Shell Actually Does

POSIX describes token recognition, expansions, field splitting, pathname expansion, and quote removal as distinct parts of shell processing [2]. The practical consequences are:

- **Unquoted text** may undergo parameter, command, and arithmetic expansion, field splitting, and pathname expansion.
- **Double-quoted text** suppresses field splitting and pathname expansion but still permits `$`-based expansions and backtick command substitution [1][2].
- **Single-quoted text** preserves the literal value of every character between the quotes; a literal single quote must be represented outside that region [1][2].
- **Quote characters are syntax**, removed before the program receives argv. The target process never sees the protective outer quotes.

Bash also provides `$'...'`, `printf %q`, and `${value@Q}`. `$'...'` is part of POSIX.1-2024, while `printf %q` and the `@Q` parameter transformation are Bash-specific output formats [1][3][4]. A generator may use them only when the eventual consumer is known to parse the matching dialect. A command advertised as portable `sh` should use a POSIX-compatible representation instead.

One more boundary matters: Unix argv elements cannot contain NUL bytes. A quoter must reject NUL rather than claim to preserve it. The executable test below covers JavaScript strings encoded to UTF-8 and passed through non-interactive Bash on Unix; it is not a proof for arbitrary invalid UTF-8 byte sequences. An interactive terminal and its line editor add another input boundary: control characters may become signals, end-of-file, or editing actions before Bash parses them. A tool that promises human copy-paste should reject such characters or use stdin, a file, or a structured API instead.

## One Parse Boundary, One Encoding Decision

Quoting is not a property permanently attached to a value. It is an encoding for one grammar at one syntactic position.

Suppose a generator quotes a prompt correctly, but the result is later inserted into another shell string:

```bash
inner="node cli.js add 'literal payload'"
ssh host "sh -c \"$inner\""
```

The exact chain is: the local shell parses the invocation; OpenSSH constructs the remote command string by joining the command arguments with spaces, which is serialization rather than parsing [16]; the remote user's login shell parses that string; then the explicit `sh -c` parses its command-string argument again. Each actual parser has its own grammar and quoting context, while the serialization step can discard argv boundaries before the next parse. The first correct encoding does not make later interpolation safe. The same warning applies to `eval`, nested `sh -c`, Make recipes, CI YAML expressions, and templating systems.

The useful rule is therefore:

> Keep values structured for as long as possible. If text must cross a shell parse boundary, encode each value exactly once for that boundary and syntax position, then do not parse the resulting command again.

This is why an argv-array API is stronger than a shell quoter. It removes the shell grammar from that boundary rather than trying to escape it perfectly.

## Safer Design Patterns

### 1. Skip the shell

Use APIs that take the executable and arguments separately:

```js
import { spawn } from 'node:child_process';

spawn(process.execPath, ['cli.js', 'add', prompt, '--cron', cron, '--task', 'daily'], {
  shell: false,
  stdio: 'inherit',
});
```

Node's `execFile()` and `spawn()` run a program without a shell unless shell use is explicitly requested [5]. Python's `subprocess.run([...], shell=False)`, Go's `exec.Command`, and Rust's `std::process::Command` follow the same structured-argv model [6][7][8].

This removes shell metacharacter interpretation, but it does **not** make every call safe. An attacker-controlled executable name is still dangerous, and a data value beginning with `-` can become an option unless the target supports and receives an end-of-options marker such as `--`. Some legitimate options themselves invoke programs. Validate the command and its argument surface separately from quoting.

### 2. Use stdin or a file for large payloads

If the target supports stdin, stream the prompt directly. Otherwise, write it to a file and pass only the safely constructed path. JSON or an argument file is often easier to audit than a long copy-paste command.

Do not treat a quoted heredoc delimiter as a universal arbitrary-data channel. `<<'EOF'` suppresses expansion in the body, but a payload line exactly equal to `EOF` still terminates the heredoc [2]. Prefer direct process stdin or a file. If generated heredoc source is unavoidable, generate a delimiter, verify that it does not occur as a complete body line, and test a deliberate collision case.

### 3. Quote for the declared shell

For a command explicitly targeting POSIX sh or Bash, a small encoder is enough:

```js
function quotePosix(value) {
  if (value.includes('\0')) {
    throw new TypeError('POSIX argv cannot contain NUL');
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
```

Apply it independently to every data argument. Do not quote the entire command as one token, and do not use the result as an option validator.

### 4. Keep CI expressions out of generated scripts

GitHub recommends assigning potentially untrusted expression values to an intermediate environment variable instead of expanding `${{ ... }}` directly into a `run:` script [9]. The shell-specific read still matters:

```yaml
- env:
    TITLE: ${{ github.event.issue.title }}
  run: printf '%s\n' "$TITLE"       # Bash runner
```

In PowerShell, the corresponding reference is `$env:TITLE`, not `$TITLE` [10]. This indirection prevents the workflow expression from generating new script source. It does not prevent option injection if the script later passes the value into a command's option position.

## Executing End-to-End Test

A useful test must exercise the emitted command with the real parser and observe the target's argv. The following self-contained Bash harness creates a fake Node CLI, generates a command file, runs it, and compares NUL-framed bytes. NUL framing preserves empty arguments and embedded or trailing newlines without relying on command substitution.

```bash
#!/usr/bin/env bash
set -euo pipefail

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export RECORD_FILE="$tmp/argv.bin"
export TRAP_LOG="$tmp/trap.log"

cat >"$tmp/fake-cli.js" <<'JAVASCRIPT'
const fs = require('node:fs');
const chunks = process.argv.slice(2).flatMap(value => [
  Buffer.from(value, 'utf8'),
  Buffer.from([0]),
]);
fs.writeFileSync(process.env.RECORD_FILE, Buffer.concat(chunks));
JAVASCRIPT

cat >"$tmp/generate.js" <<'JAVASCRIPT'
const fs = require('node:fs');

function quotePosix(value) {
  if (value.includes('\0')) throw new TypeError('NUL is not representable in argv');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const [target, promptFile, outputFile] = process.argv.slice(2);
const prompt = fs.readFileSync(promptFile, 'utf8');
const args = [target, 'add', prompt, '--cron', '0 9 * * *', '--task', 'daily'];
fs.writeFileSync(outputFile, ['node', ...args.map(quotePosix)].join(' ') + '\n');
JAVASCRIPT

cat >"$tmp/expected.js" <<'JAVASCRIPT'
const fs = require('node:fs');
const [promptFile, outputFile] = process.argv.slice(2);
const args = ['add', fs.readFileSync(promptFile, 'utf8'),
  '--cron', '0 9 * * *', '--task', 'daily'];
fs.writeFileSync(outputFile, Buffer.concat(args.flatMap(value => [
  Buffer.from(value, 'utf8'), Buffer.from([0]),
])));
JAVASCRIPT

printf '%s' 'literal $(touch "$TRAP_LOG"), `touch "$TRAP_LOG"`, "double", ' \
  >"$tmp/prompt"
printf "'single', glob *, newline\nand trailing newline\n" >>"$tmp/prompt"

node "$tmp/generate.js" "$tmp/fake-cli.js" "$tmp/prompt" "$tmp/command.sh"
node "$tmp/expected.js" "$tmp/prompt" "$tmp/expected.bin"
bash --noprofile --norc "$tmp/command.sh"
cmp "$tmp/expected.bin" "$RECORD_FILE"
test ! -e "$TRAP_LOG"
printf 'PASS: argv preserved; injected commands did not run\n'
```

The heredocs above contain fixed, author-controlled JavaScript source. They are not a transport for the untrusted prompt; the prompt travels in a file. The test would be weaker if it captured argv in newline-delimited text, because empty values and trailing newlines would become ambiguous.

## Property Test and Known-Bad Positive Control

The next test repeatedly feeds a quoter's output back into Bash source and compares the raw stdout buffer, including its NUL terminator. It covers empty input, newlines, trailing newlines, shell metacharacters, Unicode, control characters other than NUL, and generated ASCII strings. Save it as `quote-test.mjs` and run `node quote-test.mjs` with a Node version that supports `String.prototype.replaceAll`.

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function quotePosix(value) {
  if (value.includes('\0')) throw new TypeError('NUL is not representable in argv');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const cases = [
  '', '\n', 'trailing\n', "'", '"', '$HOME', '$(false)', '`false`',
  'space tab\tglob * ? [x]', 'line 1\nline 2', '你好, shell',
];

let seed = 0x513;
for (let i = 0; i < 1000; i += 1) {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  const length = seed % 80;
  let value = '';
  for (let j = 0; j < length; j += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    value += String.fromCharCode(1 + (seed % 127)); // excludes NUL
  }
  cases.push(value);
}

for (const value of cases) {
  const result = spawnSync('/bin/bash', [
    '--noprofile', '--norc', '-c', `printf '%s\\0' ${quotePosix(value)}`,
  ]);
  assert.equal(result.status, 0, result.stderr.toString());
  assert.deepEqual(result.stdout, Buffer.concat([
    Buffer.from(value, 'utf8'), Buffer.from([0]),
  ]));
}

assert.throws(() => quotePosix('a\0b'), /NUL/);

// Positive control: the original double-quote mutant must trigger the canary.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-quote-control-'));
const marker = path.join(dir, 'fired');
const payload = `$(printf fired > ${quotePosix(marker)})`;
const mutant = `"${payload}"`; // deliberately broken
const control = spawnSync('/bin/bash', [
  '--noprofile', '--norc', '-c', `printf '%s\\0' ${mutant}`,
]);
assert.equal(control.status, 0, control.stderr.toString());
assert.equal(fs.readFileSync(marker, 'utf8'), 'fired');
assert.notDeepEqual(control.stdout, Buffer.concat([
  Buffer.from(payload, 'utf8'), Buffer.from([0]),
]));
fs.rmSync(dir, { recursive: true, force: true });

console.log(`PASS: ${cases.length} round trips; known-bad mutant detected`);
```

This is behavioral evidence for the tested Bash/runtime boundary, not a proof about every shell or every byte sequence. Static parsers, linters, and taint analysis can also find suspicious code construction; they remain useful. Execution adds evidence about the exact parser and end-to-end argv behavior that text inspection alone may miss.

## Ecosystem Boundaries

| Runtime | Structured process API | Shell-text support and scope |
|---|---|---|
| POSIX sh / Bash | The shell itself operates on words | Portable single-quote encoding for one POSIX shell token; Bash also has `printf %q` and `${value@Q}` [1][3][4] |
| Python | `subprocess.run([...], shell=False)` [6] | `shlex.quote()` / `shlex.join()` are documented for Unix shells only [11] |
| Node.js | `spawn()` / `execFile()` without `shell: true` [5] | No cross-shell quoter in core; on Windows, `.bat` and `.cmd` require a terminal, `shell: true`, or `cmd.exe` [5] |
| Rust | `std::process::Command` [8] | No stdlib shell quoter; `shlex` and `shell-words` document Unix/POSIX-oriented parsing [12][13] |
| Go | `os/exec.Command` [7] | `os/exec` deliberately does not invoke a shell or expand glob patterns [7] |

Windows is not another row in a universal quoting table. PowerShell, `cmd.exe`, the Microsoft C runtime's argv decoding, and application-specific parsers have different rules. Even APIs that normally avoid a shell can have batch-file exceptions on Windows; use the platform/runtime documentation and test the exact consumer [5][6].

## Review Checklist

- Prefer a structured process API, stdin, or a file over generated shell source.
- Name the actual parser and every parse boundary; do not say “shell-safe” without a dialect and syntax position.
- Reject NUL and state the runtime encoding covered by the quoter and tests.
- Encode each data argument independently for the immediate POSIX/Bash boundary.
- Validate executable names, options, and end-of-options handling separately from quoting.
- Treat GitHub Actions `env:` indirection as protection against direct script generation, not as option validation.
- Do not use a fixed heredoc delimiter for arbitrary untrusted body data.
- Compare NUL-framed argv bytes so empty values and trailing newlines remain observable.
- Run the emitted command against a fake target, and include a known-bad positive control that must trigger the harness.
- Scope conclusions to the tested shell, platform, runtime encoding, number of parse boundaries, and non-interactive or interactive transport.

## References

1. [GNU Bash Reference Manual: Quoting](https://git.savannah.gnu.org/cgit/bash.git/plain/doc/bashref.html#Quoting)
2. [POSIX.1-2024: Shell Command Language](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html)
3. [GNU Bash Reference Manual: Bash Builtins (`printf %q`)](https://git.savannah.gnu.org/cgit/bash.git/plain/doc/bashref.html#Bash-Builtins)
4. [GNU Bash Reference Manual: Shell Parameter Expansion (`@Q`)](https://git.savannah.gnu.org/cgit/bash.git/plain/doc/bashref.html#Shell-Parameter-Expansion)
5. [Node.js documentation: Child processes](https://nodejs.org/api/child_process.html)
6. [Python documentation: `subprocess`](https://docs.python.org/3/library/subprocess.html)
7. [Go documentation: `os/exec`](https://pkg.go.dev/os/exec)
8. [Rust documentation: `std::process::Command`](https://doc.rust-lang.org/std/process/struct.Command.html)
9. [GitHub Docs: Secure use reference — use an intermediate environment variable](https://docs.github.com/en/actions/reference/security/secure-use#use-an-intermediate-environment-variable)
10. [Microsoft Learn: About environment variables in PowerShell](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_environment_variables)
11. [Python documentation: `shlex`](https://docs.python.org/3/library/shlex.html)
12. [`shlex` crate documentation](https://docs.rs/shlex/latest/shlex/)
13. [`shell-words` crate documentation](https://docs.rs/shell-words/latest/shell_words/)
14. [CWE-78: Improper Neutralization of Special Elements used in an OS Command](https://cwe.mitre.org/data/definitions/78.html)
15. [GitHub Advisory GHSA-3q26-f695-pp76](https://github.com/advisories/GHSA-3q26-f695-pp76)
16. [OpenBSD manual: `ssh(1)`](https://man.openbsd.org/ssh.1)
