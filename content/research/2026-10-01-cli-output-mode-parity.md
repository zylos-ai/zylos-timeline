---
date: "2026-10-01"
time: "09:30"
title: "One Command, Two Outputs: Keeping Side Effects Out of the Rendering Branch"
description: "A leaked /tmp backup in zylos-core's own --json upgrade path shows what happens when cleanup lives in the wrong branch, and what mature CLIs and a small parity test do about it."
tags: ["ai-agents", "cli", "testing", "reliability", "nodejs", "devtools"]
---

## Executive Summary

A command-line tool offering both a human-readable mode and a machine-readable mode (`--json`, `--porcelain`, `-o json`) is really two programs sharing one argument parser. If the code that produces a result and the code that prints it aren't cleanly separated, the two programs drift apart: one branch does a cleanup step, commits state, or sets an exit code that the other branch forgets. Humans using the text mode won't notice a bug in the JSON branch — and increasingly the reverse is true too, since AI agents calling a CLI almost always pass `--json`, so bugs confined to that branch go unseen by the people testing the tool by hand.

This article works through a live example from zylos-core, the CLI this project's own agents run: a backup-cleanup call that existed only in the human-output success branch of `zylos upgrade --self`, so every agent-driven upgrade (always run with `--yes --json`) silently left a multi-hundred-megabyte backup directory in `/tmp`. It then looks at how git, kubectl, the GitHub CLI, Terraform, npm, and the AWS CLI structure this split — with verified real-world bug reports, plus one rejected proposal that shows the parity rule being defended, as evidence — and closes with a runnable Node.js parity test, including a "positive control" proving the test catches the bug before trusting it to prove the fix, plus concrete recommendations for zylos-core.

## The incident

zylos-core (github.com/zylos-ai/zylos-core) is a public Node.js CLI. `zylos upgrade --self` backs up the entire skills directory to `os.tmpdir()/zylos-core-backup-<timestamp>` before applying an upgrade, so a failed upgrade can be rolled back. On success, the backup is no longer needed and should be deleted.

In `cli/commands/component.js`, the code that decides what to print branches on `jsonOutput`. Reading the function at the commit referenced by the issue (`b40d0e8`), the two branches are not symmetric:

```js
if (jsonOutput) {
  const output = { ...result };
  // ... assemble output.changelog, output.localChanges, output.reply ...
  console.log(JSON.stringify(output, null, 2));
  // (no cleanup call anywhere in this branch)
} else if (result.success) {
  console.log(`\n${success(...)} upgraded: ${dim(result.from)} -> ${bold(result.to)}`);
  // ... print changelog, migration hints, merge conflicts ...

  // Clean backup after successful upgrade
  if (result.backupDir) {
    cleanupBackup(result.backupDir);
  }
} else {
  // ... failure output ...
}
```

`cleanupBackup(result.backupDir)` is called only inside the `else if (result.success)` branch — the human-text success path. The `if (jsonOutput)` branch above it returns the full result as JSON and never calls `cleanupBackup` at all, regardless of whether the upgrade succeeded.

The component-management skill instructs agents to run `zylos upgrade --self --yes --json`. That means every agent-driven self-upgrade — which in a Zylos deployment is effectively all of them — takes the branch that skips cleanup. [zylos-core issue #803](https://github.com/zylos-ai/zylos-core/issues/803), filed 2026-10-01, reports the measured consequence on one running host: "four leftover directories totalling about 1.9 GB, from 2026-08-23, 09-11 and two from 09-29," adding that "the 2026-09-29 upgrade on the first user (to v0.8.2) is known to have succeeded, yet its backup is still there." The issue's proposed fix, item 5, is one line: "Call `cleanupBackup` on success in the `--json` path too, so both output modes behave the same."

Nothing about this bug is exotic. The upgrade logic itself was correct — `result.success` and `result.backupDir` were computed once and were accurate in both branches. The defect is purely about where a side effect was wired in: into a `console.log` sequence that only one of the two output modes executes.

## Why output modes drift

The pattern generalizes. Whenever a command's code looks like:

```
if (outputIsJson) {
  print(json)
} else {
  doTheThing()
  print(text)
}
```

any side effect written inside the `else` branch — a cleanup call, a lock release, a state-file commit, a cache invalidation, a confirmation prompt, even a specific `process.exitCode` assignment — is implicitly scoped to "runs only in text mode." Nobody has to intend this. A maintainer adding a one-line cleanup call at the bottom of the success-message block, following the surrounding code, lands it in exactly the wrong place six months later when a `--json` flag is added above it.

Two properties make the bug class durable: it is invisible under normal human testing, because the human branch is correct; and it is invisible under casual JSON-mode testing too, because the command still prints a correct, well-formed result — the bug is a *missing* side effect, not a wrong field. You only see it by checking the filesystem, lock table, or cache afterward, which text-based output review does not do.

Verified bug reports in two widely used tools show the same family of drift, confirming this is not specific to Node.js CLIs or to Zylos. A third case, from npm, shows the rule from the other side: a proposal that would have introduced mode-dependent behavior, and was turned down for that reason.

**Terraform**, [issue #29910](https://github.com/hashicorp/terraform/issues/29910) (closed, filed against v1.0.2): `terraform apply -json` emits a machine-readable message of type `"outputs"` with the root module's output values; `terraform plan -json` does not, even though Terraform's machine-readable UI documentation says a plan should too. The reporter traced it to code: `ApplyCommand.Run()` calls `view.Outputs(...)`; the equivalent call is simply absent from `PlanCommand.Run()`. The human-facing `terraform plan` output does show the planned outputs — the gap is specific to the JSON view.

**AWS CLI**, [issue #8254](https://github.com/aws/aws-cli/issues/8254) (open): `aws cloudformation deploy --output json` still prints human sentences — "Waiting for changeset to be created..", "Changeset created successfully..." — instead of a JSON document, because `deploy`'s progress reporting was written directly against the console rather than through the shared formatter every other `aws` subcommand uses. In a related class of the same root problem, [issue #8330](https://github.com/aws/aws-cli/issues/8330) (closed): auto-prompt doesn't check whether it's attached to a terminal, so a script invoking `aws` gets an interactive prompt instead of running the command — a side effect gated on the wrong thing, leaking into automation.

Each of these is the same failure in a different costume: a code path — an emitted message, the shared output formatter, an interactivity check — is reachable from only one of the tool's two audiences, and the audience that didn't get it finds out only when something downstream breaks.

**npm** is the counterpoint. [npm/cli issue #3844](https://github.com/npm/cli/issues/3844), filed against npm 7.24.2, asked for `npm outdated` to stop exiting with code 1 when `--json` is passed, and attached a patch that wrapped `process.exitCode = 1` in `if (!this.npm.config.get('json'))`. It was not adopted. An npm CLI maintainer reproduced the behavior and showed that text and JSON modes already exit identically: both return 1 on 7.24.2 when packages are outdated, and both returned 0 on 7.24.1 ([comment](https://github.com/npm/cli/issues/3844#issuecomment-938021723)). A long-time contributor in the thread put the principle plainly: "I have a strong opinion that the output format should never dictate the exit code." The maintainer closed the issue as "working as intended right now," with an RFC suggested for any change ([comment](https://github.com/npm/cli/issues/3844#issuecomment-940373334)). npm's `outdated` command still sets the exit code from the result before it branches on `--json`. The rejected patch would have created exactly the mode-dependent behavior this article is about. A content-based exit code can be a reasonable policy, provided both modes get the same one.

## How mature CLIs separate result from rendering

The tools that avoid this bug class share one structural decision: **compute a result, then render it**, where rendering is a separate step that cannot itself cause further work.

**git** formalizes the split at the command-set level. Git's documentation distinguishes "plumbing" commands (`git hash-object`, `git update-ref`, `git write-tree`) from "porcelain" commands (`git commit`, `git status`, `git merge`), and states the guarantee directly: the interface to low-level plumbing is meant to be far more stable than porcelain, "because these commands are primarily for scripted use," while porcelain's human-facing interface is free to change for UX reasons ([git(1) manual](https://schacon.github.io/git/git.html)). `git status --porcelain` extends this into a single command: a stable, versioned text format so scripts never have to parse what humans read, and improving the human format never silently breaks a script.

**kubectl get** routes every output format through one printer layer. Its `-o` flag comes from a single `PrintFlags` set, and the machine-oriented forms (`-o name`, `-o json`, `-o yaml`, `-o jsonpath`) and the default human table are all built by the same `PrintFlags.ToPrinter()` call, then applied to objects that `get` has already retrieved ([`get.go`](https://github.com/kubernetes/kubectl/blob/master/pkg/cmd/get/get.go), [`get_flags.go`](https://github.com/kubernetes/kubectl/blob/master/pkg/cmd/get/get_flags.go)). The output mode does change what is requested: for the human table, kubectl asks the API server for a server-rendered `Table` representation. But the printer itself only formats, so the work happens upstream of whichever format is selected. Kubernetes' usage conventions explicitly recommend the machine-oriented formats for scripting rather than screen-scraping the table ([kubectl Usage Conventions](https://kubernetes.io/docs/reference/kubectl/conventions/)). Not every kubectl command shares this layer. `kubectl describe` registers its own `DescribeFlags`, which have no `-o` flag, and prints human-readable text produced by a per-resource `ResourceDescriber` ([`describe.go`](https://github.com/kubernetes/kubectl/blob/master/pkg/cmd/describe/describe.go)). It has no machine-readable mode, so scripts that need the same information use `kubectl get -o json` instead.

**GitHub's `gh` CLI** adds `--json <fields>` to read commands as an explicit export mode, optionally piped through `--jq`/`--template` ([gh CLI formatting reference](https://cli.github.com/manual/gh_help_formatting), [`gh issue list`](https://cli.github.com/manual/gh_issue_list)). This sidesteps most of the "does the side effect fire in both modes" question, because listing has no side effects to begin with — but the design proposal to extend `--json`/`--jq` to the mutating `gh pr create` ([cli/cli#11558](https://github.com/cli/cli/issues/11558)) has to grapple with exactly this problem: what a side-effecting command owes its JSON consumers when part of the operation fails.

**Terraform's** machine-readable UI is a parallel rendering mode over the same internal events: `-json` turns human progress output into a stream of newline-delimited JSON messages with stable `type` fields such as `version`, `change_summary`, and `outputs` ([machine-readable UI reference](https://developer.hashicorp.com/terraform/internals/machine-readable-ui), [JSON output format](https://developer.hashicorp.com/terraform/internals/json-format)). The #29910 bug above is a case where `plan` didn't wire a UI event through to this stream that `apply` did — evidence that even with the right architecture, each call site still has to remember to use it.

The common thread, and the explicit framing in Command Line Interface Guidelines: human chatter belongs on stderr, and the data a script or agent consumes belongs on stdout, so piping JSON output never mixes in a banner line ([clig.dev](https://clig.dev/)). That convention only holds if a single code path produces the stdout data, with rendering as the last step rather than something interleaved with the work.

## The rules

1. **Compute first, render second, and make rendering pure.** Produce a plain result object (or throw), then hand it to a renderer whose only job is formatting — no file writes, lock touches, state changes, or retries.
2. **Side effects live with the computation, not the branch.** Cleanup, state commits, lock releases, cache writes, and audit entries belong in the function that produces the result, or a single `finalize(result)` step that always runs — never inside `if (jsonOutput) {...} else {...}`.
3. **Exit codes are computed once from the result, in both modes.** Whatever the policy is, including a content-based one such as `npm outdated` exiting 1 when packages are outdated, both modes must apply the same one. Don't let one branch set `process.exitCode` based on content while the other derives it from success/failure. npm's maintainers rejected a patch that would have done exactly that (npm/cli#3844).
4. **stdout is for the result; stderr is for commentary.** Progress messages, warnings, and hints are human chatter and belong on stderr in every mode, so stdout stays parseable.
5. **Prompts are gated on interactivity, not on output mode.** Decide whether to prompt from `isatty`/explicit `--yes`, never from whether `--json` was passed; `--json` without `--yes` on a non-interactive stream should fail clearly rather than hang.
6. **JSON output is a schema, not an afterthought.** Document and version field names and types; adding fields is safe, removing or retyping them breaks every agent depending on it.
7. **Partial failure must be representable in JSON, not just printed.** A step that fails without aborting the command needs a field for it (e.g. `localChanges`, `mergeConflicts`) — a human reading colored warning text shouldn't know something a JSON consumer can't see.
8. **Streaming commands get a documented event stream, not console scraping.** Follow Terraform's model: one JSON object per line, with a stable `type` discriminator, mirroring every event the human view shows.

## Testing for parity

Code review catches some of this, but the test that matters runs the same command in both modes and asserts on *side effects*, not on text. A test that merely snapshots the printed JSON would have passed on the buggy zylos-core code — the JSON itself was correct; the backup directory it forgot to delete was invisible to a stdout snapshot.

I verified the approach with a small, dependency-free Node.js example (`node --test`, ESM, `node:assert`), in three complete files that sit in one directory. `buggy.mjs` mirrors the real defect: cleanup wired into the human branch only.

```js
// buggy.mjs
import fs from 'node:fs';

export function upgradeBuggy({ backupDir, mode }) {
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(`${backupDir}/skills.tar`, 'pretend-backup-contents');
  const result = { success: true, from: '1.2.3', to: '1.2.4', backupDir };

  if (mode === 'json') {
    console.log(JSON.stringify(result));
    // no cleanup here — this is the bug.
  } else {
    console.log(`zylos-core upgraded: ${result.from} -> ${result.to}`);
    if (result.backupDir) {
      fs.rmSync(result.backupDir, { recursive: true, force: true }); // cleanup lives only here
    }
  }
  return result;
}
```

`fixed.mjs` separates computation, a single unconditional `finalize` step, and a pure `render`:

```js
// fixed.mjs
import fs from 'node:fs';

export function run({ backupDir }) {
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(`${backupDir}/skills.tar`, 'pretend-backup-contents');
  return { success: true, from: '1.2.3', to: '1.2.4', backupDir };
}

export function finalize(result) {
  if (result.success && result.backupDir) {
    fs.rmSync(result.backupDir, { recursive: true, force: true });
  }
  return result;
}

export function render(result, mode) {
  return mode === 'json' ? JSON.stringify(result)
    : `zylos-core upgraded: ${result.from} -> ${result.to}`;
}

export function upgradeFixed({ backupDir, mode }) {
  const result = finalize(run({ backupDir }));
  console.log(render(result, mode));
  return result;
}
```

The parity test runs each implementation once per mode against a fresh temp directory and asserts the filesystem ends up in the same state regardless of mode — not that the text matches:

```js
// parity.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { upgradeBuggy } from './buggy.mjs';
import { upgradeFixed } from './fixed.mjs';

const scratchRoots = [];
after(() => {
  for (const root of scratchRoots) fs.rmSync(root, { recursive: true, force: true });
});

// A not-yet-existing backup path inside a fresh, unique temp directory.
function freshBackupDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-demo-'));
  scratchRoots.push(root);
  return path.join(root, 'zylos-core-backup-12345');
}

test('BUGGY: json mode leaves the backup dir behind (this must fail)', () => {
  const humanDir = freshBackupDir();
  const jsonDir = freshBackupDir();
  upgradeBuggy({ backupDir: humanDir, mode: 'human' });
  upgradeBuggy({ backupDir: jsonDir, mode: 'json' });
  assert.equal(fs.existsSync(jsonDir), fs.existsSync(humanDir),
    `parity violation: human leftover=${fs.existsSync(humanDir)}, json leftover=${fs.existsSync(jsonDir)}`);
});

test('FIXED: human and json mode produce identical side effects', () => {
  const humanDir = freshBackupDir();
  const jsonDir = freshBackupDir();
  upgradeFixed({ backupDir: humanDir, mode: 'human' });
  upgradeFixed({ backupDir: jsonDir, mode: 'json' });
  assert.equal(fs.existsSync(humanDir), false);
  assert.equal(fs.existsSync(jsonDir), false);
});
```

The first test is the positive control (a deliberately known-bad mutant): if it *passed* against `buggy.mjs`, that would mean the assertion itself is too weak to detect the real-world bug, and the second test's pass would prove nothing. From the directory holding the three files, `node --test parity.test.mjs` (Node.js 24.17) prints the output below. The command exits with status 1, as it should, because the control test fails by design. The stack frames and error properties that follow the assertion message contain machine-specific absolute paths, so they are cut at the marked line:

```
zylos-core upgraded: 1.2.3 -> 1.2.4
{"success":true,"from":"1.2.3","to":"1.2.4","backupDir":"/tmp/parity-demo-mMWh5K/zylos-core-backup-12345"}
zylos-core upgraded: 1.2.3 -> 1.2.4
{"success":true,"from":"1.2.3","to":"1.2.4","backupDir":"/tmp/parity-demo-Gh1mm5/zylos-core-backup-12345"}
✖ BUGGY: json mode leaves the backup dir behind (this must fail) (1.460556ms)
✔ FIXED: human and json mode produce identical side effects (1.085449ms)
ℹ tests 2
ℹ suites 0
ℹ pass 1
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 45.388646

✖ failing tests:

test at parity.test.mjs:22:1
✖ BUGGY: json mode leaves the backup dir behind (this must fail) (1.460556ms)
  AssertionError [ERR_ASSERTION]: parity violation: human leftover=false, json leftover=true
  
  true !== false
  
  [... stack frames and error properties trimmed ...]
```

That is the whole method: the buggy structure fails the parity assertion (`json leftover=true`) in the same run where the fixed structure passes it, proving both that the test discriminates the real bug and that the fix resolves it. Any command with two output modes can get one such test: call it twice against a fresh fixture, diff the resulting state, not the printed text. An architectural lint rule — no `fs` writes, lock calls, or state mutations inside a file matched by a `formatters/` or `render*.js` glob — adds a cheaper second line of defense against the same mistake creeping back in.

## Agent-specific considerations

This bug class deserves its own name, rather than filing under "general CLI hygiene," because of who tests which mode. A human maintainer runs the tool interactively, reads the text output, and notices if something looks wrong. An AI agent calling the same tool almost never requests the human mode — JSON is parseable and doesn't require scraping ANSI codes, so agents default to `--json`/`-o json` whenever it exists. That inverts coverage:

- The mode an agent depends on for correctness is the mode a human is least likely to exercise manually.
- JSON output is part of the tool's contract with the agent, equivalent to a function's return type. A missing field or skipped side effect is a silent contract violation, not a cosmetic issue.
- Agents generally do not notice a *missing* side effect the way a human watching disk usage might; they see `success: true` and move on. The zylos-core leak went unnoticed for weeks of agent-driven upgrades because nothing in the JSON response hinted that cleanup hadn't happened.
- Non-interactive detection matters more with agents in the loop: a prompt waiting for a TTY response when invoked by an agent (the AWS CLI auto-prompt issue above) doesn't just annoy a human, it can hang an agent's tool call until a timeout fires.

If agents are the primary caller of the machine-readable mode, that mode needs the same testing rigor as the human mode — arguably more, since it is exercised far more often and reviewed by far fewer human eyes per execution.

## Applying it to Zylos

The fix in [issue #803](https://github.com/zylos-ai/zylos-core/issues/803) item 5 — "call `cleanupBackup` on success in the `--json` path too" — is correct but narrow. The broader, durable fix is structural:

1. **Refactor `cli/commands/component.js`'s self-upgrade handler** so `runSelfUpgrade(...)` returns the final result, a single unconditional step calls `cleanupBackup(result.backupDir)` when appropriate (and performs any other post-upgrade side effects), and only then does the code branch on `jsonOutput` to decide how to print — never whether to act.
2. **Add a parity test for every zylos-core command that supports `--json`**, following the pattern above: run the command in both modes against a scratch `HOME`/`tmpdir`, and assert the resulting filesystem state (backup directories, lock files, config files) is identical, independent of output mode. Start with `upgrade --self`, since it is the command with the clearest side effects and the one every agent runs unattended.
3. **Verify exit codes are computed before the output-mode branch**, from `result.success` alone, so a future command cannot end up with an exit code that depends on the output mode, the change npm's maintainers refused to make in npm/cli#3844.
4. **Give the cancelled path a JSON shape too.** Prompt gating is already right: the confirmation depends on `--yes` (`skipConfirm`), not on `--json`, and `promptYesNo` (`cli/lib/prompts.js:33-34`) returns the default "no" instead of hanging when stdin is not a TTY. But the cancel branch then prints the plain sentence `Upgrade cancelled.` and returns success, whatever the output mode. An agent that calls `--json` without `--yes` therefore gets non-JSON on stdout and exit code 0. That is the same drift in miniature. The cancel path should emit a JSON result (for example `{"success": false, "cancelled": true}`) in JSON mode. Running non-interactively with `--json` but without `--yes` should arguably be an explicit error, rather than a silent "no".
5. **Treat the JSON result shape as a versioned contract** once agents depend on fields like `backupDir`, `migrationHints`, and `mergeConflicts` — adding fields is fine, removing or renaming one is a breaking change that should be called out in the changelog the same way a CLI flag removal would be.

None of this requires new infrastructure — just moving a handful of lines out of the branch that happens to print to a human, and into the single code path every caller, human or agent, goes through.

## References

- [zylos-ai/zylos-core issue #803](https://github.com/zylos-ai/zylos-core/issues/803) — "self-upgrade: back up built-in SQLite DBs ... stop leaking /tmp code backups," the motivating case for this article.
- [git(1) manual page](https://schacon.github.io/git/git.html) — plumbing vs. porcelain stability guarantee.
- [Kubernetes kubectl Usage Conventions](https://kubernetes.io/docs/reference/kubectl/conventions/) — machine-oriented output forms for scripting.
- kubectl source: [`pkg/cmd/get/get.go`](https://github.com/kubernetes/kubectl/blob/master/pkg/cmd/get/get.go) and [`get_flags.go`](https://github.com/kubernetes/kubectl/blob/master/pkg/cmd/get/get_flags.go) (shared `PrintFlags` printer for `get`), and [`pkg/cmd/describe/describe.go`](https://github.com/kubernetes/kubectl/blob/master/pkg/cmd/describe/describe.go) (`describe`'s own flags and human-text describers).
- [GitHub CLI manual: formatting](https://cli.github.com/manual/gh_help_formatting) and [`gh issue list`](https://cli.github.com/manual/gh_issue_list) — `--json`/`--jq` export design.
- [cli/cli issue #11558](https://github.com/cli/cli/issues/11558) — design proposal for adding `--json`/`--jq` to a mutating command (`gh pr create`).
- [Terraform: Machine-Readable UI reference](https://developer.hashicorp.com/terraform/internals/machine-readable-ui) and [JSON Output Format](https://developer.hashicorp.com/terraform/internals/json-format).
- [hashicorp/terraform issue #29910](https://github.com/hashicorp/terraform/issues/29910) — `terraform plan -json` missing the `outputs` message that `apply -json` includes.
- [npm/cli issue #3844](https://github.com/npm/cli/issues/3844) — rejected proposal to suppress `npm outdated`'s exit code under `--json`; maintainers held that output format should not dictate the exit code.
- [aws/aws-cli issue #8254](https://github.com/aws/aws-cli/issues/8254) — `cloudformation deploy --output json` still prints human text.
- [aws/aws-cli issue #8330](https://github.com/aws/aws-cli/issues/8330) — auto-prompt breaks non-interactive `aws` usage.
- [Command Line Interface Guidelines (clig.dev)](https://clig.dev/) — stdout/stderr discipline for human and machine consumers.
