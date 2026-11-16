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

The main points: select tests by gate, not by filename; keep a generated inventory of gates; make unexpected skips fail CI with an allowlist and a preflight that names missing variables; diff skips between base and head; and treat "fails on baseline" as valid only when both runs had the same environment.

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

`@pytest.mark.skipif(cond, reason=...)` is evaluated at collection time. By default, skip details are hidden "to avoid cluttering the output." Add `-rs` and pytest prints a `SKIPPED [n] file:line: reason` line for each one. The exit codes documented for pytest are 0 (all collected tests passed), 1 (failures), 2 (interrupted), 3 (internal error), 4 (usage error), 5 (no tests collected) and 6 (max warnings exceeded). There is no exit code for "some tests skipped."

Markers are pytest's tagging system. Unregistered markers only emit a warning by default, a design intended "to avoid silently doing something surprising due to mistyped names." With `--strict-markers` (or `strict_markers` in config), unknown marks become errors. This is the nearest thing in these ecosystems to a defense against typos in a gate name, but it protects marker names only, not the environment variables inside `skipif` conditions.

The pytest maintainers' answer to "how do I forbid skipping" (issue 1364) is instructive: there is nothing built in, skip is meant for cases where skipping is acceptable, and where it is not, use `pytest.fail` instead. A suggested pattern is a marker that skips locally but fails on CI. A third-party plugin, `pytest-error-for-skips`, exists to convert skips into errors.

### Go

Go skips at run time with `t.Skip`, commonly guarded by `testing.Short()`. The `testing` docs include one further rule worth knowing: a test that fails and is then skipped is still considered failed. Without `-v`, skip messages are not printed (log text appears "only if the test fails or the -test.v flag is set"). With `-json`, test2json emits a `skip` action, documented as "the test was skipped or the package contained no tests." Note the second half of that sentence: a package with no tests produces the same action as a skip.

Build tags (`//go:build integration`, enabled with `-tags`) are a different mechanism. The docs define a build constraint as "a condition under which a file should be included in the package." A file that does not satisfy the constraint is not part of the build, which is why a tag-gated test yields no per-test skip record to count. Absence is harder to audit than a skip.

### JUnit XML and CI

pytest's JUnit output marks a skip as a child element of the testcase, including the reason, which I confirmed locally: `<skipped type="pytest.skip" message="gate ZY_INTEGRATION not set">`, with `skipped="2"` on the testsuite. A related trap is on the CI platform side: GitHub documents that a job skipped by a conditional "reports Success," and that "successful check statuses are `success`, `skipped`, and `neutral`." A gated job can therefore be green at two layers, the runner and the platform.

## Failure Modes

1. **Silent skips counted as green.** Jest, Vitest, Playwright and pytest all exit 0 on skips. In a public example, a Playwright suite called `test.skip()` when committed data held no matching record. The issue states the consequence directly: the case "stops exercising the browser and CI stays green with no signal at all."
2. **Gate-variable typos.** `ZY_INTEGRATON=1` sets a variable nothing reads. The suite skips everything gated and is green. Marker-level strictness (`--strict-markers`) does not cover environment variable names.
3. **Filename-based selection drift.** A test's name tells you what its author thought it was. The gate is what determines whether it runs. Filename patterns drift as files are added and renamed. This was the incident's primary cause.
4. **"Baseline also fails" misdiagnosis.** A failure in a gated test under an incomplete environment (a missing required variable, a service that is not up) looks like a baseline bug. The comparison is only meaningful if both runs have identical environments.
5. **Skip counts regressing unnoticed.** A summary showing `3 skipped` one week and `30 skipped` the next is not a failure by any default. Martin Fowler made the same argument about quarantined tests: they accumulate and are forgotten, so cap them ("only allow 8 tests in quarantine") or time-limit them.
6. **Gated tests rotting.** Tests that run only in a nightly or a manual job accumulate failures nobody sees until a release. The longer the gap between gated runs, the larger the bisect.

## Practices

### 1. Inventory by gate, not by filename

Generate a table of gate variable to files, from a static scan of test sources (a regex for `process.env.NAME`, or an AST walk if the codebase is large) or from a runtime registry. A registry is better: define gates in exactly one helper, so no test can invent a private gate. The Jest helper below tags the describe title with `[gate:NAME]`, which makes skips attributable.

One public project guards its skips with a unit test that scans spec files for `test.skip(` calls and matches them, by message, against a registered list, so any newly added skip fails the build.

### 2. Make unexpected skips fail, with an allowlist and reasons

Skips are acceptable when they are expected: a platform-specific test on the wrong platform, a nightly-only browser tier. Keep expected skips in a committed allowlist with a reason for each. In CI, any skip not on the list fails the run.

### 3. Preflight that names missing variables

Before any test runs, check that the variables the run requires are present, and fail with their names. This separates "environment misconfigured" from "test failed" and kills the baseline misdiagnosis in the incident.

### 4. Diff skip counts between base and head

Run base and head, emit machine-readable results (`jest --json --outputFile`, JUnit XML, Playwright's JSON reporter) and fail when the set of skipped test IDs grows. Comparing sets of IDs, not just counts, catches a skip added while another is removed. A ten-line script over two Jest `--json` files (collect tests with `status: "pending"`, subtract the base set) did this in my test and exited 1 when two gated tests newly skipped.

### 5. Full gated run before merge-approval for shared surfaces

If a PR touches a shared surface (transport, persistence, startup, auth), the approval criterion is not "relevant tests pass" but "the full gated suite ran under the full environment and the skip report matches the allowlist." That costs one longer run. The incident cost a review cycle plus late-found regressions.

### 6. Paired A/B runs to separate flake from regression

When a gated test fails, run the same selection in the same environment (verified by preflight) on base and head, several times each. Failing on head and passing on base every time is a regression. Failing on both is pre-existing, but only if the environments match. Alternating is a flake.

### 7. Treat tags and projects as organization, not assurance

Playwright tags, pytest markers and Jest projects organize tiers. They do not answer "did the tier I needed actually run?"

## Code

### Jest: a gate helper, a skip-audit reporter, and a preflight

```js
// gated.js: the only place gates are defined
const enabled = (name) => process.env[name] === '1';
function describeGated(gate, title, fn) {
  (enabled(gate) ? describe : describe.skip)(`[gate:${gate}] ${title}`, fn);
}
module.exports = { describeGated };
```

```js
// skip-audit-reporter.js
const GATE_RE = /\[gate:([A-Z0-9_]+)\]/;
class SkipAuditReporter {
  constructor(_g, options) {
    this.allowed = new Set(options.allowedSkippedGates || []);
    this.strict = process.env.SKIP_AUDIT === 'strict';
    this.error = null;
  }
  onRunComplete(_ctx, results) {
    const byGate = {}, ungated = [];
    for (const file of results.testResults)
      for (const t of file.testResults) {
        if (t.status !== 'pending') continue;            // Jest's word for skipped
        const name = [...t.ancestorTitles, t.title].join(' > ');
        const m = GATE_RE.exec(name);
        if (m) (byGate[m[1]] ||= []).push(file.testFilePath); else ungated.push(name);
      }
    for (const [g, files] of Object.entries(byGate))
      console.log(`[skip-audit] ${g}: ${files.length} skipped in ${new Set(files).size} file(s)`);
    const unexpected = Object.keys(byGate).filter((g) => !this.allowed.has(g));
    if (this.strict && (unexpected.length || ungated.length))
      this.error = new Error(`[skip-audit] unexpected skips: gates=${unexpected.join(',') || '-'} ungated=${ungated.length}`);
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
  reporters: ['default', ['<rootDir>/skip-audit-reporter.js', { allowedSkippedGates: [] }]],
};
```

In my test, a default run exited 0 with `3 skipped`. With `SKIP_AUDIT=strict` it exited 1. With the gate variables set it exited 0 with no skips. A run with `REQUIRE_GATES` set and a typo'd variable failed before any test with `gates not enabled: ZY_INTEGRATION, ZY_BROWSER`.

### Playwright: fail on skips that are not on the allowlist

```ts
// skip-audit-reporter.ts
import type { Reporter, TestCase, TestResult, FullResult } from '@playwright/test/reporter';
export default class SkipAudit implements Reporter {
  private skipped: { title: string; reason: string }[] = [];
  private allowed: Set<string>;
  constructor(opts: { allowedReasons?: string[] } = {}) { this.allowed = new Set(opts.allowedReasons ?? []); }
  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status !== 'skipped') return;
    const reason = test.annotations.find((a) => a.type === 'skip')?.description ?? '(no reason)';
    this.skipped.push({ title: test.titlePath().filter(Boolean).join(' > '), reason });
  }
  async onEnd(result: FullResult) {
    const bad = this.skipped.filter((s) => !this.allowed.has(s.reason));
    console.log(`[skip-audit] skipped=${this.skipped.length} unexpected=${bad.length}`);
    bad.forEach((s) => console.log(`  UNEXPECTED SKIP: ${s.title} (${s.reason})`));
    if (process.env.SKIP_AUDIT === 'strict' && bad.length && result.status === 'passed')
      return { status: 'failed' as const };
  }
}
```

Register it with `reporter: [['list'], ['./skip-audit-reporter.ts', { allowedReasons: [] }]]`. Gate with `test.skip(process.env.ZY_INTEGRATION !== '1', 'gate ZY_INTEGRATION not set')` so that every skip carries a reason string. In my run, the strict mode turned an exit code of 0 into 1.

### pytest: the same idea in conftest.py

```python
# conftest.py
import pytest
EXPECTED_SKIP_REASONS = {"gate ZY_BROWSER not set": "browser tier runs nightly only"}

def pytest_addoption(parser):
    parser.addoption("--fail-on-unexpected-skip", action="store_true")

@pytest.hookimpl(trylast=True)
def pytest_sessionfinish(session, exitstatus):
    tr = session.config.pluginmanager.get_plugin("terminalreporter")
    skipped = tr.stats.get("skipped", [])
    reason = lambda r: r.longrepr[2].removeprefix("Skipped: ")
    bad = [(r.nodeid, reason(r)) for r in skipped if reason(r) not in EXPECTED_SKIP_REASONS]
    tr.write_line(f"[skip-audit] skipped={len(skipped)} unexpected={len(bad)}")
    for nodeid, why in bad:
        tr.write_line(f"  UNEXPECTED SKIP: {nodeid} ({why})")
    if session.config.getoption("--fail-on-unexpected-skip") and bad:
        session.exitstatus = pytest.ExitCode.TESTS_FAILED
```

Run with `pytest -q -rs --strict-markers --fail-on-unexpected-skip`. The reason string is stable text from the `skipif` marker, so the allowlist doubles as documentation.

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
- [ ] CI runs in strict-skip mode: skips not on the committed allowlist fail the build, and each entry has a reason.
- [ ] Base-versus-head skip diff runs on every PR. Newly skipped IDs fail.
- [ ] A PR touching a shared surface requires the full gated run before approval.
- [ ] A "fails on baseline" claim is accepted only with identical environments and repeated paired runs.
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
- pytest-error-for-skips: https://pypi.org/project/pytest-error-for-skips/2.0.1/
- Go testing package: https://pkg.go.dev/testing
- Go command (build constraints, test flags, caching): https://pkg.go.dev/cmd/go
- Go test2json: https://pkg.go.dev/cmd/test2json
- GitHub, troubleshooting required status checks: https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks
- cncf/endusers issue 1184, data-dependent test.skip() calls: https://github.com/cncf/endusers/issues/1184
- Martin Fowler, Eradicating Non-Determinism in Tests: https://martinfowler.com/articles/nonDeterminism.html
- ImpossibleBench (Zhong, Raghunathan, Carlini): https://arxiv.org/abs/2510.20270
