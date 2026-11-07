---
date: "2026-11-07"
time: "09:00"
title: "Byte-Identical, Except the Disk: Golden-Output Tests When CLI Output Contains Live System Readings"
description: "A status command's byte-for-byte test failed because free disk space moved by 1 GiB between two calls. This article surveys golden and snapshot practice, the ambient inputs that make CLI output nondeterministic, and concrete Node.js techniques: injected probes, scrubbers, structural comparison, invariant assertions, and a triage routine for flaky versus real failures."
tags: ["research", "testing", "snapshot-testing", "golden-files", "nodejs", "cli", "flaky-tests", "agent-tooling"]
---

## Executive Summary

A status command prints a handful of lines, one of them a live reading: `Disk: 40 GiB available`. A test asserts that the full text output is byte-identical before and after a configuration repair, to prove the repair changed nothing the user can see. The feature was correct. Yet in a parallel test suite the test failed once, because other tests were writing temporary files and the free-space figure crossed a 1 GiB boundary between the two calls. A rerun in isolation passed.

The lesson is not "snapshot tests are flaky." It is that a whole-output equality assertion silently signs a contract the author never intended: *every byte of this output is a pure function of the thing under test.* Any line that reads the clock, the disk, the process table, the terminal, the locale, or the filesystem layout breaks that contract.

This article surveys how Jest, Go, Node's built-in runner, ApprovalTests, Verify and insta handle the problem, then turns it into a decision order for Node.js CLI and agent-tooling projects:

1. **Make the input deterministic** (inject probes and a clock, pin the environment). This is preferred because the golden file stays exact.
2. **Normalize what you cannot inject** (scrubbers, redactions, serializers), and make the placeholder visible in the golden file.
3. **Compare structure, not text**, when the output is really data (`--json`).
4. **Assert the invariant you care about** instead of the whole output. "The repair changed nothing except fields on a named allowlist" is a better test than "all bytes equal."
5. **Triage failures with evidence**: rerun the single test in isolation, replay the order, diff against a baseline, and only then call it flaky.

Local experiments (Node v24.22.1, Linux, one NVMe filesystem) are included to put numbers on the problem. They show that a quantized disk reading flakes at roughly `churn / granularity`, which is rare enough to survive review and common enough to wreck a busy CI day.

## Anatomy of the Failure

The test looked like this in spirit:

```js
const before = renderStatus(config);
repairConfig(config);
const after = renderStatus(config);
assert.equal(after, before); // "nothing visible changed"
```

`renderStatus` does `fs.statfs`, floors the available bytes to GiB, and prints it. Between the two calls, anything else on the same filesystem that allocates or frees blocks can move the number. Because the output is quantized to whole GiB, the flip happens only when free space crosses a GiB boundary during the gap.

That quantization is what makes this class of bug hard to diagnose. A reading that changes on every call fails immediately and gets fixed on day one. A reading that changes with probability `delta / 1 GiB` passes for weeks.

A small simulation makes the arithmetic concrete. It calls the renderer, appends 1 MiB to a file with `fsync`, and calls it again, 3,000 times:

| Pairs | Churn between calls | Disk line changed | Observed | Predicted (1 MiB / 1 GiB) |
|---|---|---|---|---|
| 3,000 | 1 MiB | 3 | 0.10% | 0.10% |

Scale that up. A parallel suite whose neighbors write tens or hundreds of MiB inside the window sees a per-pair rate near 1 to 10%, and with hundreds of assertions of this shape a run fails regularly. Delayed allocation matters too: in a first attempt, buffered `writeFileSync` calls without `fsync` produced zero visible change, which is consistent with the filesystem not having allocated blocks yet (an inference; not checked further). The number you print reflects the filesystem's accounting, not your program's intent.

The same experiment surfaced a second, unplanned flake source. The naive test also printed an ISO timestamp with millisecond precision, and the pure-equality version failed in 2 of 10 repeated runs from the clock line alone. The fix for the disk line would not have been enough.

## What the Tools Say

### Snapshot and golden-file practice

**Jest** states the responsibility plainly: "You're responsible for making sure your generated snapshots do not include platform specific or other non-deterministic data." Its [snapshot guide](https://jestjs.io/docs/snapshot-testing) offers three levers: mock the source (`Date.now = jest.fn(() => 1_482_363_367_071)`), replace the random part of a string before snapshotting, or use *property matchers*, where an asymmetric matcher such as `expect.any(Date)` is checked before the snapshot is written or compared and stored as `Any<Date>`. Non-matcher values are still compared exactly. The same page insists on treating snapshots as code, and warns against "the habit of regenerating snapshots when test suites fail instead of examining the root causes." Jest's [`--ci` flag](https://jestjs.io/docs/cli) fails on a missing snapshot rather than writing it silently, which closes one more route for unreviewed baselines.

**Go golden files** live in `testdata/` (ignored by the standard tools), are compared byte-for-byte, and are refreshed with an `-update` flag. [goldie](https://pkg.go.dev/github.com/sebdah/goldie/v2) documents exactly that: "The actual response data will be byte compared with the golden file and the test will fail if there is a difference." It also supports `AssertWithTemplate`, where the golden file contains template fields such as `{{ .Type }}` filled from test data. This is a useful middle path: the volatile token stays *in the golden file* as an explicit hole, not as an invisible regex in the test.

**Node's built-in runner** has had snapshot testing since v22.3.0 and it left experimental status in v23.4.0. `t.assert.snapshot(value, { serializers })` runs the value through the serializer chain and compares it to a `<testfile>.snapshot` file; `node --test-update-snapshots` regenerates. According to the [Node test runner documentation](https://nodejs.org/api/test.html), the last serializer's result is coerced to a string. This makes a serializer a natural scrubber slot.

**ApprovalTests and Verify** are built around the same idea (approve a rendered result, fail on difference) and treat scrubbing as a first-class step. The [ApprovalTests.cpp guide](https://github.com/approvals/ApprovalTests.cpp/blob/master/doc/how_tos/ScrubNonDeterministicOutput.md) shows custom lambda scrubbers, regex scrubbers, and a GUID scrubber that assigns numbered placeholders (`guid_1`), reusing the same placeholder for repeats so *identity relationships survive scrubbing*. Verify's [scrubber docs](https://github.com/VerifyTests/Verify/blob/main/docs/scrubbers.md) add line-level scrubbing and note that text is newline-normalized (`\r\n` and `\r` to `\n`) before scrubbers run, which also removes a cross-platform diff source.

**insta (Rust)** distinguishes several [redaction kinds](https://insta.rs/docs/redactions/): static (replace a value with a fixed token such as `"[uuid]"`), dynamic (a callback that can *assert the value has the expected shape* and then replace it), sorted (sort a map or sequence to remove ordering nondeterminism), and rounded (round floats to N places). Plain-text output has a separate filters feature. The dynamic-redaction idea is the most transferable: scrubbing should not erase the evidence that a field exists and is well-formed.

### Why determinism beats scrubbing when you can get it

Martin Fowler's [Eradicating Non-Determinism in Tests](https://martinfowler.com/articles/nonDeterminism.html) lists the usual causes (lack of isolation, asynchrony, remote services, time, resource leaks) and the remedy for time: "Always wrap the system clock, so it can be easily substituted for testing." Disk space is the same species of dependency: an ambient, shared, mutable resource read through a global API. His second recommendation, quarantining a nondeterministic test so it does not erode trust in the rest, is the right short-term move while you fix the cause.

Go has pushed this furthest with [`testing/synctest`](https://pkg.go.dev/testing/synctest), which gives a "bubble" its own fake clock (starting at 2000-01-01 UTC) that advances only when every goroutine in the bubble is durably blocked. Sleeps cost no real time and the result is the same on every run. The principle generalizes: the best fix for a nondeterministic input is to own the input.

### Flaky versus real

Google's [Testing Blog post on flaky tests](https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html) defines a flaky result as one that both passes and fails on the same code, reports that flaky results were around 1.5% of runs with most pass-to-fail transitions involving a flaky test, and describes automatic rerun of failing tests as a mitigation. Reruns tell you *that* a test is flaky; they do not fix it, and they hide the cause if used as policy. The failure above is a good example: a rerun passes, so the bug looks gone, but the assertion still claims something false.

## Catalogue of Ambient Inputs in CLI Output

Before choosing a technique, list what the output actually reads. A status or doctor command in a Node.js tool typically includes several of these:

| Input | Typical source | Why it is unstable | Preferred handling |
|---|---|---|---|
| Free disk / memory | `fs.statfs`, `os.freemem()` | Shared with every other process and test | Inject a probe; assert shape or threshold |
| Wall clock, durations, "5s ago" | `Date.now()`, `new Date()`, `performance.now()` | Changes every call | Inject a clock; or mock `Date` |
| PIDs, ports, uptime | `process.pid`, ephemeral ports | Differ per run | Scrub, or inject |
| Absolute paths, temp dirs, home | `os.tmpdir()`, `mkdtemp`, `$HOME` | Random suffixes, machine-specific | Normalize to `<TMP>`, `<HOME>` |
| Locale, number/date formatting | `Intl`, `toLocaleString`, `LANG` | Differs per machine and CI image | Pin `LC_ALL`/`TZ`, or format explicitly |
| Terminal width, TTY, color | `process.stdout.columns`, `isTTY` | Absent in CI, varies in terminals | Set explicit width; honor `NO_COLOR` |
| Ordering | `readdir`, `Set`/`Map` iteration, async completion | Not specified or timing-dependent | Sort before printing |
| Environment and version strings | `process.version`, package version | Change with upgrades | Scrub or exclude from the golden |
| Line endings | `\r\n` vs `\n` | Platform | Normalize before comparison |

Two notes on this table. First, `fs.statfs` returns `bavail` as "free blocks available to unprivileged users" and you multiply by `bsize` for bytes ([Node fs docs](https://nodejs.org/api/fs.html)); whether you use `bavail` or `bfree` is itself a source of machine-to-machine difference. POSIX [`df -P`](https://pubs.opengroup.org/onlinepubs/9699919799/utilities/df.html) defines the "Available" column as the space available to unprivileged users and rounds values up to the next unit, so even cross-tool comparison depends on rounding rules. Second, [`NO_COLOR`](https://no-color.org/) says that when the variable is present and not an empty string, ANSI color should not be added; the [CLI guidelines](https://clig.dev/) add checking TTY status separately for stdout and stderr and treat `TERM=dumb` as a no-color signal. In tests, set these explicitly instead of relying on the runner's environment.

## Techniques for Node.js CLIs

### 1. Inject probes and the clock (preferred)

Give the renderer a small set of probe functions with live defaults. Production passes nothing; tests pass fixed values.

```js
// status.mjs
import { statfsSync } from 'node:fs';
const GiB = 1024 ** 3;

export const liveProbes = {
  diskAvailableBytes(path) {
    const s = statfsSync(path, { bigint: true });
    return Number(s.bavail * s.bsize);
  },
  now: () => new Date(),
};

export function renderStatus(cfg, probes = liveProbes) {
  const gib = Math.floor(probes.diskAvailableBytes(cfg.dir) / GiB);
  return [
    `Config: ${cfg.ok ? 'valid' : 'repaired'}`,
    `Dir: ${cfg.dir}`,
    `Disk: ${gib} GiB available`,
    `Checked: ${probes.now().toISOString()}`,
  ].join('\n') + '\n';
}
```

```js
const fixed = (bytes) => ({
  diskAvailableBytes: () => bytes,
  now: () => new Date('2026-01-01T00:00:00Z'),
});
const p = fixed(40 * 1024 ** 3);
assert.equal(renderStatus(afterRepair, p), renderStatus(beforeRepair, p)); // exact, stable
```

This keeps the byte-for-byte assertion honest: with the probes pinned, the *only* thing that can differ is the code under test. For clocks without a refactor, Node's [`mock.timers`](https://nodejs.org/api/test.html) with `apis: ['Date']` and a `now` option fixes `Date.now()`, and `t.mock` scopes the mock to a single test so it is restored automatically. Note the documented limitation: destructured imports of timer functions are not mocked.

Add a boundary test for the probe-to-text conversion itself, since that is where the original surprise lived. In the experiment, `40 GiB` and `40 GiB - 1 byte` produced different disk lines and otherwise identical output, which is exactly the property you want pinned:

```js
const a = renderStatus(cfg, fixed(40 * GiB));
const b = renderStatus(cfg, fixed(40 * GiB - 1));
assert.notEqual(a, b);                 // the quantization is real...
assert.equal(scrub(a), scrub(b));      // ...and confined to the disk line
```

### 2. Scrub what you cannot inject

When the reading comes from deep inside a dependency, or you are testing a real process end to end, normalize the output with a scrubber. In Node's runner it fits the serializer slot:

```js
const scrub = (s) => String(s)
  .replace(/^Disk: .*$/m, 'Disk: <n> GiB available')
  .replace(/^Checked: .*$/m, 'Checked: <ts>');

test('status golden', (t) => {
  t.assert.snapshot(renderStatus(cfg), { serializers: [scrub] });
});
```

The generated snapshot (verified with `--test-update-snapshots`, then re-run without the flag) contains `Disk: <n> GiB available` and `Checked: <ts>`. Guidelines drawn from the tools above:

- **Anchor the pattern to the field** (`^Disk: ...$`), not to a bare number. A greedy `\d+` scrubber hides real regressions in unrelated lines.
- **Keep placeholders readable** in the stored file, so a reviewer can see what was normalized. This is the property that Jest's `Any<Date>` and goldie's template fields share.
- **Preserve identity.** If the same temp dir appears three times, map it to the same `<TMP>` each time; use numbered placeholders (`<PID_1>`, `<PID_2>`) as ApprovalTests does for GUIDs.
- **Validate before you erase.** insta's dynamic redactions can assert a value's format before replacing it. A scrubber that also checks `Disk: \d+ GiB available` matched at least once will fail if the line disappears, instead of silently comparing two outputs that both lack it.
- **Normalize newlines first**, as Verify does.
- Never scrub in the *production* renderer to make a test pass. Scrubbing belongs in the test harness.

### 3. Compare structure, not text

If the command has a `--json` mode, assert on the parsed object. The [CLI guidelines](https://clig.dev/) recommend a `--json` flag for structured data and note that human-facing output is generally free to change, unless it is treated as an interface. That gives a clean split:

- Test the **JSON contract** strictly: schema, required keys, types, and equality on the stable fields.
- Test the **human text** loosely, or via a small number of scrubbed goldens.

With parsed data you can drop volatile keys with a simple allowlist/denylist and compare the rest with `assert.deepStrictEqual`. Sort arrays whose order is unspecified before comparing (insta's sorted redaction does the equivalent), and keep numeric tolerance explicit (insta's rounded redaction; or `Math.abs(a - b) <= tolerance`).

### 4. Assert the invariant, not the whole output

The original test wanted to prove one thing: *the repair did not change visible status.* "All bytes equal" over-approximates that claim and drags in every volatile line. State the invariant directly:

```js
const volatile = new Set(['disk', 'checkedAt']);
const strip = (o) => Object.fromEntries(
  Object.entries(o).filter(([k]) => !volatile.has(k)));

assert.deepStrictEqual(strip(after), strip(before));
assert.ok(Number.isInteger(after.disk) && after.disk >= 0); // shape, not value
```

Two practical benefits. The volatile set is an explicit, reviewable list, so adding a new live field to the output forces a conscious choice. And the test can be split by purpose: one assertion about the repair's effect, one about the output format, one about the probe formatting. When a snapshot fails you learn *which* contract broke instead of getting a diff of a 30-line blob.

Use whole-output goldens where the output *is* the product (help text, error messages, rendered tables) and the inputs are pinned. Keep them small and focused, as the Jest guide advises.

### 5. Determinism under parallel runners

Node's runner, per its [documentation](https://nodejs.org/api/test.html), runs each matching test file in its own child process by default; `--test-concurrency` caps how many files run at once (default `os.availableParallelism() - 1`), and tests inside one file run in a single thread. So parallelism is across files, and processes in different files share the same machine, the same temp directory, the same filesystem, and the same free-space counter. Practical rules:

- **Never assert on machine-global readings** (free disk, free memory, load, process counts) across a time gap.
- **Isolate filesystem state per test**: `fs.mkdtemp` under `os.tmpdir()`, and do not share fixtures between files.
- **Pin the environment** in a helper that spawns the CLI: `env: { LC_ALL: 'C', TZ: 'UTC', NO_COLOR: '1', COLUMNS: '80' }` and a fixed locale-independent formatter inside the code.
- **Use unique ports** (`listen(0)`) and scrub them.
- **Randomize order on a schedule.** Node's runner has `--test-randomize` and `--test-random-seed` (documented as early-development stability, so check your Node version) to surface order dependence, printing the seed so a failure can be replayed.
- **Run the suite at reduced concurrency as a diagnostic**, equivalent to Jest's `--runInBand`/`-i` (all tests serially in the current process) or `--maxWorkers`. If a failure disappears serially, a shared resource is implicated.

## Telling a Flaky Assertion from a Real Regression

A failing golden test has two explanations: the code changed behavior, or the assertion depended on something other than the code. Procedure:

1. **Read the diff before anything else.** Does the differing text correspond to a volatile input? A one-line difference in `Disk:` or a timestamp is a strong hint. A diff in a field the change touched is not.
2. **Rerun the single test in isolation**, with the same seed. For Node: `node --test --test-name-pattern="status golden" path/to/file.test.mjs`. Pass in isolation but fail in the full run points to a shared-state or timing cause.
3. **Rerun the full suite with reduced concurrency** (`--test-concurrency=1`). Disappearance of the failure suggests contention.
4. **Replay the order.** If you ran with `--test-randomize`, rerun with the printed `--test-random-seed`. Node also has `--test-rerun-failures <file>`, which persists run state and reruns only tests that have not yet passed, but its own documentation warns it should be used when tests run in a deterministic order.
5. **Compare against a baseline.** Run the same test on the parent commit (or `git stash`) several times under the same load. A real regression fails every time on the new code and never on the old; a flaky assertion fails on both at some rate. For quantized readings, estimate the rate you expect (`churn / granularity`), then check the observed frequency against it.
6. **Loop it.** Run the failing test 50 to 200 times under artificial load; one failure in a loop proves nondeterminism but not its source, so pair it with step 1.
7. **Decide, then fix the cause.** Quarantine briefly if needed, as Fowler suggests, but record why. Do not "fix" it by regenerating the golden or by retrying until green: Jest's guidance about not regenerating snapshots without understanding the failure applies equally to retries.

A rerun that passes is evidence of flakiness, not of correctness. Say so in the commit message or report: "Failure was in the disk line; passes in isolation; assertion replaced with X."

For agent runners specifically, treat a test failure like any other tool outcome that needs evidence. Record the failing diff, the isolated rerun result, and the conclusion. A report that says "flaky, reran, green" without the diff is indistinguishable from a model papering over a real failure.

## A Decision Checklist

When adding or reviewing a golden or snapshot test for a CLI:

1. List every ambient input the output reads (use the table above).
2. For each: can it be injected? If yes, inject it and keep the golden exact.
3. If not: is a scrubber with an anchored pattern and a visible placeholder acceptable? Add a check that the line is still present.
4. If the output is data, add a `--json` path and assert on parsed fields.
5. Ask what you are really claiming. If it is an invariant ("repair changes nothing visible", "output stays within 80 columns"), assert that instead of whole-text equality.
6. Pin `LC_ALL`, `TZ`, `NO_COLOR`, width, and temp dirs in the spawn helper.
7. Never read machine-global state twice and assert equality.
8. Keep snapshot files small, named by intent, reviewed like code, and never regenerated blindly (`--ci` in Jest, a deliberate `--test-update-snapshots` in Node).
9. Occasionally run with randomized order and reduced concurrency.
10. When a failure appears, follow the triage procedure and record the evidence.

## Limits of This Study

The experiments are small and local: Node v24.22.1 on Linux, one NVMe-backed filesystem, synthetic churn of 1 MiB per pair, 3,000 pairs for the disk simulation and ten repeated suite runs for the clock observation. They illustrate the quantization arithmetic and are not a measurement of any particular CI system. Filesystem accounting differs across ext4, XFS, btrfs, ZFS, tmpfs, and container overlays, and reservations or snapshots can make free space move without your process writing anything. Details of some libraries (Verify's default date and GUID scrubbers, insta's regex filters) were not confirmed from primary documentation here and should be checked against the current docs before relying on them. The Google flakiness figures are quoted from the 2016 blog post's summary and may not reflect current numbers. Node's randomized ordering is documented as early development, and API names or stability can change between releases.

## Sources

- Jest: [Snapshot testing](https://jestjs.io/docs/snapshot-testing) (property matchers, non-deterministic data, snapshots as code); [CLI options](https://jestjs.io/docs/cli) (`--ci`, `--runInBand`, `--maxWorkers`).
- Go: [goldie](https://pkg.go.dev/github.com/sebdah/goldie/v2) (golden files, `-update`, templates); [`testing/synctest`](https://pkg.go.dev/testing/synctest) (fake-time bubbles).
- Node.js: [Test runner](https://nodejs.org/api/test.html) (snapshots, `mock.timers`, concurrency and isolation, randomization, rerun failures); [`fs.statfs`](https://nodejs.org/api/fs.html) (`bavail`, `bfree`, `bsize`).
- Approval testing: [ApprovalTests](https://approvaltests.com/); [ApprovalTests.cpp scrubbing guide](https://github.com/approvals/ApprovalTests.cpp/blob/master/doc/how_tos/ScrubNonDeterministicOutput.md); [Verify scrubbers](https://github.com/VerifyTests/Verify/blob/main/docs/scrubbers.md).
- Rust: [insta redactions](https://insta.rs/docs/redactions/).
- Test reliability: Martin Fowler, [Eradicating Non-Determinism in Tests](https://martinfowler.com/articles/nonDeterminism.html); Google Testing Blog, [Flaky Tests at Google and How We Mitigate Them](https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html).
- CLI conventions: [Command Line Interface Guidelines](https://clig.dev/); [NO_COLOR](https://no-color.org/); POSIX [`df`](https://pubs.opengroup.org/onlinepubs/9699919799/utilities/df.html).
