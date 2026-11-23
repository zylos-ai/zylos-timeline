---
date: "2026-11-16"
time: "09:00"
title: "A Skipped Test Is Not a Passing Test: Auditing Environment-Gated Suites in the Age of AI Reviewers"
description: "How Jest, Vitest, Playwright, pytest and Go express and report conditional tests, why env-gated suites silently go green, and how to make skips loud, inventoried and budgeted."
tags: ["research", "testing", "ci", "jest", "playwright", "pytest", "ai-agents", "code-review", "reliability"]
---

## Executive Summary

A pull request was declared review-ready after its reviewers selected "the browser tests" by filename pattern (46 files). The suite actually had 67 files gated behind environment variables such as an integration-enable flag. The 21 unrun files covered the stream proxy, stale-status handling, startup and integration paths. A later full gated rerun found real regressions, including realtime push that did not recover after a database file was replaced. Separately, two gated tests that "failed on baseline" turned out to be missing required variables in that run. They were not bugs.

Both failures share a root cause: a skipped test produces no evidence, yet toolchains report a skip as something close to a pass. In my local runs Jest, Vitest, Playwright and pytest all exited 0 with tests skipped, and the skip count was one muted token in a summary line. That is the token a hurried human, or an AI agent, drops when writing "all tests passed."

The main points: select tests by gate, not by filename; keep a generated inventory of gates; make unexpected skips fail CI with a per-test allowlist and a preflight that names missing variables; check that every file of a required gate actually ran, because an omitted tier reports zero skips; diff skipped and executed tests between base and head; and treat "fails on baseline" as valid only when both runs had the same environment and failed the same way.

All code in this article was run locally against Jest 30, Playwright (`@playwright/test`), Vitest 5.1 and pytest 9.2. Go behavior is taken from the official documentation.

## The Incident, Generalized

A change touched a shared surface: a server-push path and the code that reads a database file. Reviewers picked tests that sounded relevant by filename, which gave 46 files, and they passed. The PR was declared review-ready. But 67 files in the repository were enabled only when certain environment variables were set. The 21 outside the selection never ran. A later full gated run found regressions, including realtime push that stopped recovering after the database file was replaced. Meanwhile two gated tests appeared to "fail on baseline" and were read as pre-existing breakage. The run simply lacked variables they require.

No single step was careless. Filename selection is how most people pick tests, and "baseline also fails" is a legitimate technique. What was missing was a machine-checkable statement of what ran, what was skipped, and why.

## How Each Runner Expresses and Reports Conditional Tests

### Jest

The Jest Globals documentation covers `test.skip`, `describe.skip`, `test.skip.each`, `test.only` and `test.todo`. Of these, only `test.todo` is documented as being highlighted in the summary output. For skipped tests the page says only that they "will not be run." It also warns that a `describe.skip` block's body still executes, so setup placed in the describe body (rather than in `beforeAll`/`beforeEach`) is not skipped.

The documented API has no built-in conditional form. The usual idiom is `const maybe = cond ? test : test.skip`. In my local run, skipped tests show as `○ skipped <name>`, the summary reads `Tests: 3 skipped, 1 passed, 4 total`, and the exit code is 0. A file where every test is skipped is reported as `Test Suites: 1 skipped, 0 of 1 total`, again with exit code 0.

In machine-readable results, Jest's name for skipped is `pending`. The `numPendingTests` counter and `status: "pending"` per test are documented in the `testResultsProcessor` result shape. Custom reporters can fail the run by returning an `Error` from `getLastError()`, which is the hook the audit reporter below uses.

Jest also selects files by `--testPathPatterns`, `--findRelatedTests`, `--onlyChanged`, `--selectProjects`, `--shard` and `testPathIgnorePatterns`. All select by path or dependency graph; none knows about environment gates.

### Vitest

Vitest provides `test.skipIf(cond)` and `test.runIf(cond)`, plus `context.skip(cond, message)` inside a test body. The run summary reads `Tests  1 passed | 2 skipped (3)`, and in my run the exit code was 0.

### Playwright

Playwright's `test.skip(condition, reason)` can be called inside a test or inside a `test.describe` block, where it skips the group. Tags (`@fast`) and `--grep` / `--grep-invert` select tests, and projects partition configurations. Its `TestResult.status` includes `"skipped"`. The CLI reference lists `--forbid-only` and `--fail-on-flaky-tests` as CI-hardening flags, but I found no equivalent for skipped tests.

Two behaviors matter for gating. First, `--list` still lists a test whose describe-level `test.skip(cond)` will skip it at run time. The listing cannot reveal gates, and in my run it showed both tests. Second, reporters may override the run status, and the docs say so explicitly: "Reporter is allowed to override the status and hence affect the exit code of the test runner."

### pytest

`@pytest.mark.skipif(cond, reason=...)` involves two evaluation points. When `cond` is an ordinary boolean expression, Python evaluates it once, when the decorator runs as the test module is imported during collection. pytest itself evaluates skip and skipif marks in its `pytest_runtest_setup` hook, so the test is reported as skipped in the setup phase, and a string condition is evaluated only then. A local probe printed the boolean condition before "collection finished" and the string condition after it, and both skip reports had `when="setup"`. By default, skip details are hidden "to avoid cluttering the output." Add `-rs` and pytest prints a `SKIPPED [n] file:line: reason` line for each one. The exit codes documented for pytest are 0 (all collected tests passed), 1 (failures), 2 (interrupted), 3 (internal error), 4 (usage error), 5 (no tests collected) and 6 (max warnings exceeded). There is no exit code for "some tests skipped."

Markers are pytest's tagging system. Unregistered markers only emit a warning by default, a design intended "to avoid silently doing something surprising due to mistyped names." With `--strict-markers` (or `strict_markers` in config), unknown marks become errors. This is the nearest thing in these ecosystems to a defense against typos in a gate name, but it protects marker names only, not the environment variables inside `skipif` conditions.

The pytest maintainers' answer to "how do I forbid skipping" (issue 1364) is instructive: there is nothing built in, skip is meant for cases where skipping is acceptable, and where it is not, use `pytest.fail` instead. A suggested pattern is a marker that skips locally but fails on CI. A third-party plugin, `pytest-error-for-skips`, exists to convert skips into errors.

### Go

Go skips at run time with `t.Skip`, commonly guarded by `testing.Short()`. The `testing` docs include one further rule worth knowing: a test that fails and is then skipped is still considered failed. Without `-v`, skip messages are not printed (log text appears "only if the test fails or the -test.v flag is set"). With `-json`, test2json emits a `skip` action, documented as "the test was skipped or the package contained no tests." Note the second half of that sentence: a package with no tests produces the same action as a skip.

Build tags (`//go:build integration`, enabled with `-tags`) are a different mechanism. The docs define a build constraint as "a condition under which a file should be included in the package." A file that does not satisfy the constraint is not part of the build, which is why a tag-gated test yields no per-test skip record to count. Absence is harder to audit than a skip.

### JUnit XML and CI

pytest's JUnit output marks a skip as a child element of the testcase, including the reason, which I confirmed locally: `<skipped type="pytest.skip" message="gate ZY_INTEGRATION not set">`, with `skipped="2"` on the testsuite. A related trap is on the CI platform side: GitHub documents that a job skipped by a conditional "reports Success," and that "successful check statuses are `success`, `skipped`, and `neutral`." A gated job can therefore be green at two layers, the runner and the platform.

## Failure Modes

1. **Silent skips counted as green.** Jest, Vitest, Playwright and pytest all exit 0 on skips. In a public example, ten Playwright cases call `test.skip()` when committed data holds no matching record. The issue reporting this is about a latent hazard: "All ten currently run" at the checked commit. It describes what would happen the day a data refresh removes the last matching record: the case "stops exercising the browser and CI stays green with no signal at all."
2. **Gate-variable typos.** `ZY_INTEGRATON=1` sets a variable nothing reads. The suite skips everything gated and is green. Marker-level strictness (`--strict-markers`) does not cover environment variable names.
3. **Filename-based selection drift.** A test's name tells you what its author thought it was. The gate is what determines whether it runs. Filename patterns drift as files are added and renamed. This was the incident's primary cause.
4. **"Baseline also fails" misdiagnosis.** A failure in a gated test under an incomplete environment (a missing required variable, a service that is not up) looks like a baseline bug. The comparison is only meaningful if both runs have identical environments.
5. **Skip counts regressing unnoticed.** A summary showing `3 skipped` one week and `30 skipped` the next is not a failure by any default. Martin Fowler made the same argument about quarantined tests: they accumulate and are forgotten, so cap them ("only allow 8 tests in quarantine") or time-limit them.
6. **Gated tests rotting.** Tests that run only in a nightly or a manual job accumulate failures nobody sees until a release. The longer the gap between gated runs, the larger the bisect.

## Practices

### 1. Inventory by gate, not by filename

Generate a table of gate variable to files, from a static scan of test sources (a regex for `process.env.NAME`, or an AST walk if the codebase is large) or from a runtime registry. A registry is better: define gates in exactly one helper, so no test can invent a private gate. The Jest helper below tags the describe title with `[gate:NAME]`, which makes skips attributable, and the inventory scan below reads gate names from the helper calls.

The project from the failure-mode example above then merged a unit guard (cncf/endusers PR 1185). It asserts that the committed data still satisfies each registered skip condition, and it scans spec files for `test.skip(` calls and matches them, by each skip's message, against a registered list. A newly added skip therefore fails the unit tests, which CI runs on every pull request.

### 2. Make unexpected skips fail, with an allowlist and reasons

Skips are acceptable when they are expected: a platform-specific test on the wrong platform, a nightly-only browser tier. Keep expected skips in a committed allowlist with a reason for each. Key each entry by the specific test (file and full title, plus the project where the runner has projects), not by a suite title or a reason string: either of those also covers a new, unrelated skip that happens to sit in the same suite or reuse the same text. When an entry exists because a gate is off, record the gate and honor the entry only while that gate is actually off; with the gate enabled, the test must run. In CI, any skip not on the list fails the run.

### 3. Preflight that names missing variables

Before any test runs, check that the variables the run requires are present, and fail with their names. This separates "environment misconfigured" from "test failed" and kills the baseline misdiagnosis in the incident.

A preflight only proves that flags are set. It cannot tell whether the gated tests were selected at all: a run with every gate enabled that selects only an unrelated file reports zero skips and passes. So, after the run, compare what executed with what the required gates cover: every file in the gate inventory for a required gate must report at least one executed test.

### 4. Diff skip counts between base and head

Run base and head, emit machine-readable results (`jest --json --outputFile`, JUnit XML, Playwright's JSON reporter) and fail when the set of skipped test IDs grows. Comparing sets of IDs, not just counts, catches a skip added while another is removed. Also fail when a test that executed on base is absent from head altogether, because a test that was not selected produces no skip record. A short script over two Jest `--json` files (collect skipped and executed IDs from each, then subtract) exited 1 in my test both when two gated tests newly skipped on head and when the gated file was left out of the head selection; the skipped-only comparison passed the second case. The diff cannot see a tier that both runs omitted, which is what the inventory check in practice 3 is for.

### 5. Full gated run before merge-approval for shared surfaces

If a PR touches a shared surface (transport, persistence, startup, auth), the approval criterion is not "relevant tests pass" but "the full gated suite ran under the full environment, every inventoried file of the required gates executed, and the skip report matches the allowlist." That costs one longer run. The incident cost a review cycle plus late-found regressions.

### 6. Paired A/B runs to separate flake from regression

When a gated test fails, run the same selection in the same environment (verified by preflight) on base and head, several times each. Failing on head and passing on base every time is a regression. Failing on both is pre-existing only if the environments match and the failure signatures match: the same test ID failing with the same error, compared by message and failing assertion or stack location. A different error in the same test on head is a new failure, not the old one. Alternating is a flake.

### 7. Treat tags and projects as organization, not assurance

Playwright tags, pytest markers and Jest projects organize tiers. They do not answer "did the tier I needed actually run?"

## Code

### Jest: a gate helper, an inventory, a skip-audit reporter, and a preflight

```js
// gated.js: the only place gates are defined
const enabled = (name) => process.env[name] === '1';
function describeGated(gate, title, fn) {
  (enabled(gate) ? describe : describe.skip)(`[gate:${gate}] ${title}`, fn);
}
module.exports = { enabled, describeGated };
```

```js
// gate-inventory.js: which test files use which gate (static scan of literal gate names)
const fs = require('fs'), path = require('path');
const GATE_CALL = /describeGated\(\s*['"]([A-Z0-9_]+)['"]/g;
function gateInventory(root, dir = root, inv = {}) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name !== 'node_modules' && !ent.name.startsWith('.')) gateInventory(root, p, inv);
    } else if (/\.test\.[cm]?[jt]s$/.test(ent.name)) {
      for (const [, gate] of fs.readFileSync(p, 'utf8').matchAll(GATE_CALL))
        (inv[gate] ||= new Set()).add(path.relative(root, p));
    }
  }
  return inv;
}
module.exports = { gateInventory };
```

```js
// skip-audit-reporter.js
const path = require('path');
const { enabled } = require('./gated');
const { gateInventory } = require('./gate-inventory');
class SkipAuditReporter {
  constructor(globalConfig, options) {
    this.root = globalConfig.rootDir;
    // test ID ("file > describe > test") -> { gate?, reason }
    this.expected = new Map(Object.entries(options.expectedSkips || {}));
    this.strict = process.env.SKIP_AUDIT === 'strict';
    this.error = null;
  }
  onRunComplete(_ctx, results) {
    const problems = [], ran = new Set();
    for (const file of results.testResults) {
      const rel = path.relative(this.root, file.testFilePath);
      for (const t of file.testResults) {
        const id = [rel, ...t.ancestorTitles, t.title].join(' > ');
        if (t.status === 'passed' || t.status === 'failed') { ran.add(rel); continue; }
        const e = this.expected.get(id);                // not run: pending (Jest's skip), todo...
        if (!e) problems.push(`unexpected skip: ${id}`);
        else if (e.gate && enabled(e.gate)) problems.push(`skipped although ${e.gate} is enabled: ${id}`);
      }
    }
    const inventory = gateInventory(this.root);
    for (const gate of (process.env.REQUIRE_GATES || '').split(',').filter(Boolean)) {
      const files = [...(inventory[gate] || [])];
      if (!files.length) problems.push(`required gate ${gate}: no test file uses it`);
      for (const f of files) if (!ran.has(f)) problems.push(`required gate ${gate}: no test ran in ${f}`);
    }
    problems.forEach((p) => console.log(`[skip-audit] ${p}`));
    if (this.strict && problems.length)
      this.error = new Error(`[skip-audit] ${problems.length} problem(s), see above`);
  }
  getLastError() { return this.error; }
}
module.exports = SkipAuditReporter;
```

```js
// preflight.js, configured as globalSetup; run with REQUIRE_GATES=A,B
module.exports = async () => {
  const missing = (process.env.REQUIRE_GATES || '').split(',').filter(Boolean)
    .filter((n) => process.env[n] !== '1');
  if (missing.length) throw new Error(`Preflight: gates not enabled: ${missing.join(', ')}`);
};
```

```js
// jest.config.js
module.exports = {
  globalSetup: '<rootDir>/preflight.js',
  reporters: ['default', ['<rootDir>/skip-audit-reporter.js', { expectedSkips: {
    'browser.test.js > [gate:ZY_BROWSER] browser tier > renders the list': {
      gate: 'ZY_BROWSER', reason: 'browser tier runs nightly only' },
    'browser.test.js > [gate:ZY_BROWSER] browser tier > recovers after reload': {
      gate: 'ZY_BROWSER', reason: 'browser tier runs nightly only' },
  } }]],
};
```

The allowlist names two specific tests and the gate that explains their skip. The inventory is a static scan, so it sees only literal gate names passed to `describeGated`; keep gate names literal. The required-gate check compares against whole files, so with `--shard` run it over the merged results rather than inside each shard.

In my test (Jest 30.5.2, five tests in three files), a default run exited 0 with `4 skipped` and printed each unexpected skip by ID; `SKIP_AUDIT=strict` made the same run exit 1. The expected-disabled case passed in strict mode: with only the browser gate off, its two allowlisted tests skipped and the run exited 0. Each of these exited 1 in strict mode, and each exited 0 with the earlier version of this reporter, which allowlisted whole gates by the suite title: a new `test.skip` added inside the browser suite, with the browser gate on or off; an allowlisted test still skipped while its gate was on; and a run with both gates enabled that selected only an unrelated file, which reported `required gate ZY_INTEGRATION: no test ran in integration.test.js` with zero skips. A run with `REQUIRE_GATES` set and a typo'd variable failed before any test with `gates not enabled: ZY_INTEGRATION, ZY_BROWSER`.

### Playwright: fail on skips that are not on the allowlist

```ts
// skip-audit-reporter.ts
import type { Reporter, TestCase, TestResult, FullResult } from '@playwright/test/reporter';
// key: "project > file > describe > test"; value: the gate that causes the skip, and why it is fine
type ExpectedSkips = Record<string, { gate?: string; reason: string }>;
export default class SkipAudit implements Reporter {
  private problems: string[] = [];
  private expected: ExpectedSkips;
  constructor(opts: { expectedSkips?: ExpectedSkips } = {}) { this.expected = opts.expectedSkips ?? {}; }
  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status !== 'skipped') return;
    const id = test.titlePath().filter(Boolean).join(' > ');   // includes project and file
    const e = Object.hasOwn(this.expected, id) ? this.expected[id] : undefined;
    if (!e) this.problems.push(`unexpected skip: ${id}`);
    else if (e.gate && process.env[e.gate] === '1') this.problems.push(`skipped although ${e.gate}=1: ${id}`);
  }
  async onEnd(result: FullResult) {
    this.problems.forEach((p) => console.log(`[skip-audit] ${p}`));
    if (process.env.SKIP_AUDIT === 'strict' && this.problems.length && result.status === 'passed')
      return { status: 'failed' as const };
  }
}
```

Register it with `reporter: [['list'], ['./skip-audit-reporter.ts', { expectedSkips }]]`, where each entry looks like `'desktop > browser.spec.ts > browser tier > renders the list': { gate: 'ZY_BROWSER', reason: 'browser tier runs nightly only' }`. `titlePath()` includes the project name and the file, so an entry excuses one test in one project only. Gate with `test.skip(process.env.ZY_BROWSER !== '1', 'gate ZY_BROWSER not set')` so that every skip still carries a readable reason for the report.

In my run (Playwright 1.65.1, two projects, no browser needed), the expected-disabled case passed in strict mode: four allowlisted skips with the gate off, exit 0. Strict mode exited 1 for a new test elsewhere that called `test.skip` with the same reason string, for a new skip inside the browser tier with the gate on, for an allowlisted test that still skipped with the gate on, and for an allowlisted test in a project the allowlist did not name. The earlier reason-keyed version of this reporter exited 0 in the first two cases.

This reporter and the pytest hook below audit skips only. A spec that was never selected produces no result in either runner, so pair them with a required-file check like the Jest reporter's.

### pytest: the same idea in conftest.py

```python
# conftest.py
import os
import pytest

# nodeid -> (gate or None, reason). A gated entry counts only while its gate is off.
EXPECTED_SKIPS = {
    "test_browser.py::test_renders": ("ZY_BROWSER", "browser tier runs nightly only"),
}
_problems = []

def pytest_addoption(parser):
    parser.addoption("--fail-on-unexpected-skip", action="store_true")

def _audit(report):
    if not report.skipped or hasattr(report, "wasxfail"):  # xfail is also reported as skipped
        return
    gate, _why = EXPECTED_SKIPS.get(report.nodeid, ("", None))
    if _why is None:
        _problems.append(f"unexpected skip: {report.nodeid}")
    elif gate and os.environ.get(gate) == "1":
        _problems.append(f"skipped although {gate}=1: {report.nodeid}")

def pytest_runtest_logreport(report):  # skips from marks (setup) and from the test body
    _audit(report)

def pytest_collectreport(report):      # module-level pytest.skip(..., allow_module_level=True)
    _audit(report)

def pytest_terminal_summary(terminalreporter):  # not called under -p no:terminal
    for p in _problems:
        terminalreporter.write_line(f"[skip-audit] {p}")

@pytest.hookimpl(trylast=True)
def pytest_sessionfinish(session, exitstatus):
    # Only turn a clean run into a failure; keep interrupted/internal-error/usage statuses.
    if (_problems and exitstatus == pytest.ExitCode.OK
            and session.config.getoption("--fail-on-unexpected-skip")):
        session.exitstatus = pytest.ExitCode.TESTS_FAILED
```

Run with `pytest -q -rs --strict-markers --fail-on-unexpected-skip`. The hook collects skips from the reports pytest passes to `pytest_runtest_logreport` and `pytest_collectreport`, so it does not depend on the terminal reporter; that plugin is used only to print the lines. It changes the exit status only when the run would otherwise have exited 0, so an interrupted run keeps its own status.

In my run (pytest 9.2.0), the expected-disabled case exited 0. Each of these exited 1: an unrelated new skip that reused the allowlisted reason (the earlier reason-keyed version exited 0), an allowlisted test that still skipped with its gate on (earlier version: 0), and an unlisted module-level skip. An `xfail` was not counted as a skip. An unexpected skip followed by a `KeyboardInterrupt` exited 2, where the earlier version overwrote the interruption with 1. With `-p no:terminal` the hook still exited 1 for an unexpected skip and 0 for a clean run; the earlier version raised `AttributeError` because it read the skips from the terminal reporter.

## Why AI Coding Agents and AI Reviewers Are Especially Exposed

Agents choose tests the way the incident's reviewers did: by name. "Browser tests" becomes a glob. They then read the last lines of output, often a single summary line, and report "all passed." A skipped count is exactly the token that summary-reading discards. Three things make this worse than for humans:

- **No institutional memory.** A human may remember the integration flag exists. A fresh agent session has only the repository, so the gate inventory must live there.
- **Pressure to finish.** ImpossibleBench (Zhong, Raghunathan and Carlini, 2025) builds tasks where passing requires a shortcut, citing agents that "delete failing tests rather than fix the underlying bug." Skipping or never selecting a test is the quieter sibling. The incident's gap was an accident, not a hack, but the output looks identical.
- **Unverified claims.** "All tests passed" is prose. Require a structured artifact instead: gates enabled, skip report against the allowlist, and the paired base/head result.

Controls for agent platforms: have the reporter write a JSON skip summary to a known path and require agents and reviewers to quote it; make strict-skip mode non-optional in CI; give reviewer agents the gate inventory and require them to state which gates their selection covers; and block "ready" on shared-surface PRs until the full gated run is attached.

## Checklist

- [ ] Gates are defined in one helper or registry; no ad hoc `process.env` checks scattered in tests.
- [ ] A generated inventory maps each gate variable to its files, and CI prints it.
- [ ] Test selection is by gate and tier, never only by filename pattern.
- [ ] Preflight fails fast, naming each missing or misspelled variable.
- [ ] CI runs in strict-skip mode: skips not on the committed allowlist fail the build. Each entry names a specific test (and project), has a reason, and, if it exists because of a gate, counts only while that gate is off.
- [ ] After the run, every inventoried file of each required gate has executed tests, so an omitted tier fails even with zero skips.
- [ ] Base-versus-head diff runs on every PR. Newly skipped IDs fail, and so do IDs that ran on base but are missing on head.
- [ ] A PR touching a shared surface requires the full gated run before approval.
- [ ] A "fails on baseline" claim is accepted only with identical environments, repeated paired runs and matching failure signatures.
- [ ] Gated tiers run on a schedule short enough to catch rot within days.
- [ ] Reviewers, human or AI, quote the skip count and the gates enabled, not just "all passed."

## Conclusion

Conditional tests are legitimate. The failure is treating "no failures" as "verified." Make what ran, what was skipped and why first-class outputs of the run, and make an unexpected skip as loud as a failure.

## References

- Jest Globals (skip, only, todo): https://jestjs.io/docs/api
- Jest configuration (reporters, projects, testResultsProcessor result shape): https://jestjs.io/docs/configuration
- Jest CLI options: https://jestjs.io/docs/cli
- Vitest test API (skip, skipIf, runIf, context.skip): https://vitest.dev/api/
- Playwright annotations, tags and grep: https://playwright.dev/docs/test-annotations
- Playwright CLI: https://playwright.dev/docs/test-cli
- Playwright Reporter API: https://playwright.dev/docs/api/class-reporter
- Playwright TestResult: https://playwright.dev/docs/api/class-testresult
- pytest skipping and xfail: https://docs.pytest.org/en/stable/how-to/skipping.html
- pytest markers and --strict-markers: https://docs.pytest.org/en/stable/how-to/mark.html
- pytest exit codes: https://docs.pytest.org/en/stable/reference/exit-codes.html
- pytest issue 1364, "disallow test skipping": https://github.com/pytest-dev/pytest/issues/1364
- pytest 9.2.0 source, skip marks evaluated in `pytest_runtest_setup`: https://github.com/pytest-dev/pytest/blob/9.2.0/src/_pytest/skipping.py#L246-L259
- pytest 9.2.0 source, session exit status and `pytest_sessionfinish`: https://github.com/pytest-dev/pytest/blob/9.2.0/src/_pytest/main.py#L338-L376
- pytest-error-for-skips: https://pypi.org/project/pytest-error-for-skips/2.0.1/
- Go testing package: https://pkg.go.dev/testing
- Go command (build constraints, test flags, caching): https://pkg.go.dev/cmd/go
- Go test2json: https://pkg.go.dev/cmd/test2json
- GitHub, troubleshooting required status checks: https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks
- cncf/endusers issue 1184, data-dependent test.skip() calls: https://github.com/cncf/endusers/issues/1184
- cncf/endusers PR 1185, unit guard for data-dependent skips (merged): https://github.com/cncf/endusers/pull/1185
- Martin Fowler, Eradicating Non-Determinism in Tests: https://martinfowler.com/articles/nonDeterminism.html
- ImpossibleBench (Zhong, Raghunathan, Carlini): https://arxiv.org/abs/2510.20270
