---
date: "2026-10-28"
time: "09:00"
title: "A Restored Mock Is Not a Restored Process: Module-Mock Leakage and Proving Cleanup in Node.js Test Suites"
description: "Experiments on Node 24.17 and a survey of Jest and Vitest docs show how mocks of built-in modules leak across tests, why the leaks depend on order and platform, and how tripwires and subprocess isolation prove cleanup."
tags: ["research", "testing", "nodejs", "test-isolation", "mocking", "agent-tooling", "ci"]
---

## Executive Summary

A test helper used Node's test runner to fake `spawnSync` from `node:child_process` for an ESM import, then called `restore()`. CommonJS code loaded later in the same process still received a fake that always returned `ETIMEDOUT`. On Linux that produced 6 failures. The author's macOS run looked clean. Skipping one unrelated, platform-conditional slow test made the Linux count jump from 6 to 61, because that test had incidentally re-established the real function. The fix that held was to run tests that need a fake built-in in a one-shot child process, and to have the parent assert afterwards that the real function is back (a "tripwire"). A smaller trap remained: after restore, `execSync('npm root -g')` from the formerly mocked surface returned a deleted temp path.

The general lesson: **`restore()` undoes what the mock framework knows it did. It does not prove the process is back to its pre-test state.** Anything that captured a reference while the mock was live, or any global the tests share, can outlive the restore. Pass counts say nothing about this unless order, platform and isolation are controlled.

I ran small experiments on **Node v24.17.0 (Linux)** and read the Node, Jest and Vitest docs. Where I did not reproduce the field report exactly, the article says so. Code marked "observed" was run; code marked "illustrative" was not.

## What `mock.module()` documents, and what it does not

`mock.module(specifier, options)` is Stability 1.0 (early development) and requires `--experimental-test-module-mocks`. The docs say it mocks ES modules, CommonJS modules, JSON modules and built-ins, and that "any references to the original module prior to mocking are not impacted." `options.cache` defaults to `false`: each `require()` or `import()` then generates a new mock module. With `true`, the mock is inserted into the CommonJS cache. For built-ins, `exports.default` becomes `module.exports`, and named exports are copied onto it. `namedExports` and `defaultExport` are deprecated in favour of `exports` (the runtime printed that deprecation warning on 24.17).

The `restore()` documentation is one sentence: "Resets the implementation of the mock module." Nothing there says what happens to modules that were loaded while the mock was active. That gap is where the leak lives.

## Observed behaviour on Node 24.17.0

All runs used `node --experimental-test-module-mocks --test --test-isolation=none` unless stated.

1. **The real built-in object is not mutated.** While the mock was active, `require('node:child_process')` returned a different object from the one captured before the mock, and the captured object's `spawnSync` was still the original. After `restore()`, `require('node:child_process')` returned the original object again, and a CJS file first loaded before the mock still saw the real function.
2. **Modules first loaded under the mock keep the fake.** A CJS file that did `const cp = require('node:child_process')` while the mock was active kept the mock's object after `restore()`. The same held for a file that destructured `spawnSync` at load time. Both were cached by `require`. A fresh load after clearing `require.cache` got the real function.
3. **ESM behaves the same way.** An ES module imported under the mock (`import { spawnSync } from 'node:child_process'`) stayed bound to the fake. Re-importing the same URL after `restore()` returned the same cached instance. A new specifier (a different query string) got the real function.
4. **`t.mock.module()` auto-restore does not change this.** A CJS file first required inside a test that used the context-scoped mock stayed fake for a later test in the same process.
5. **`cache: true`** gave one shared mock object across `require()` calls, and after `restore()` a new `require('node:child_process')` returned the real object.

```js
// observed (Node 24.17.0): restore() resets the mock, not modules that already captured it
const m = mock.module('node:child_process', { exports: { spawnSync: fake } });
const inside = require('./uses-cp.cjs');   // first load happens while mocked
m.restore();
require('node:child_process').spawnSync === realSpawnSync;  // true
inside.viaObj() === realSpawnSync;                          // false: cached with the fake
```

**What I did not reproduce:** a CJS module loaded for the first time *after* `restore()` received the real function in my runs. The field report described later-loaded CommonJS getting the fake. I cannot say from these experiments whether that came from a different Node version, a helper that also patched properties, `cache: true` interactions, or a module first loaded earlier than the author believed. The observable symptom is the same either way: a cached consumer holds the fake, and which tests hit it depends on load order. Because ESM `import` hoisting and loader caches make "first loaded" hard to see in a large suite, treat any module that might have been first loaded during a mock as contaminated.

## Isolation modes and order

Node's runner defaults to `--test-isolation=process`: each test file runs in its own child process. With `--test-isolation=none`, files are imported into the runner process and top-level tests run with concurrency of one. The docs state that in this mode "it is possible for tests to interact with each other in ways that are not possible when isolation is enabled," for example through global state.

To check this I wrote a leaker (replaces `require('node:child_process').spawnSync`) and a victim (asserts the function is not the replacement). Observed:

| Mode | Result |
| --- | --- |
| `--test-isolation=process` | victim passes |
| `--test-isolation=none` | victim fails |
| `none` with `--test-randomize --test-random-seed=1..8` | passes for seeds 1 to 6, fails for 7 and 8 |

So the same code gives different verdicts by isolation and by seed.

`--test-randomize` and `--test-random-seed=<n>` are documented as added in **v24.16.0**, Stability 1.0; the runner prints the seed so a failing order can be replayed. The docs add that subtests awaited one by one keep declaration order. I did not check earlier Node majors.

## Jest and Vitest: scoped, but not hermetic

**Jest.** Per the configuration docs, each test file gets its own independent module registry; `resetModules` resets it before each test; `jest.isolateModules(fn)` creates a sandbox registry for modules loaded inside the callback. `restoreMocks` is equivalent to calling `jest.restoreAllMocks()` before each test, and the docs warn that `restoreAllMocks()` only works for mocks created with `jest.spyOn()` and properties replaced with `jest.replaceProperty()`; "other mocks will require you to manually restore them." ESM mocking uses `jest.unstable_mockModule`, which the ESM docs describe as applying to the file and its ESM dependencies. `--randomize` shuffles tests within a file, seeded by `--seed`, and only with the default jest-circus runner. Note the scope: within a file, not across files.

**Vitest.** `vi.mock` is hoisted above imports so the mock is registered before the import runs. Test isolation depends on `pool`: `threads` runs each file in a separate Worker, `forks` (the default) in a forked child process, `vmThreads` in a VM context on workers. `isolate` defaults to `true` and has no effect on the VM pools; the docs suggest disabling it only if the code "doesn't rely on side effects." `restoreMocks` restores spies from `vi.spyOn`; `unstubGlobals` and `unstubEnvs` undo `vi.stubGlobal` and `vi.stubEnv`. The docs warn that all three can break async *concurrent* tests, because one test's completion restores state another is using. Vitest shuffles with `--sequence.shuffle` and `--sequence.seed`.

**Where leaks survive in both:** per-file registries do not isolate state that is not in a module registry. That includes `process.env`, `process.cwd()` (worker threads cannot `chdir`; Vitest's docs say so for `threads`), signal handlers, timers, open sockets, native addons shared in-process, and anything stored on built-in singletons. The Vitest docs also note that some native-language libraries segfault under `threads`. Process-level pools (`forks`) are the stronger boundary; thread and VM pools share one OS process.

## Why leaks look random

A leak needs three things: a writer that changes shared state, a reader that depends on it, and an order that puts the writer first. Everything that perturbs order perturbs the verdict: file discovery order, concurrency, shard assignment, `--test-isolation`, a platform-conditional `skip`, a filter (`-t`, `--test-name-pattern`), a developer running one file at a time. The 6-to-61 jump is the same effect running in reverse: a test that incidentally re-assigned the real function was acting as an unintended cleanup. When that test is skipped on one platform, the cleanup disappears, and the leak becomes visible, or invisible, depending on where you run.

A green run on one machine is a statement about one ordering.

## Patterns that prove cleanup

**1. Prefer dependency injection to module mocking.** Pass `spawnSync` (or an `exec` function, a clock, a filesystem) into the code under test. No module cache is involved, so there is nothing to restore. Reserve module mocks for code you cannot change.

**2. Run built-in fakes in a one-shot child process.** The test spawns `node --experimental-test-module-mocks fake-run.mjs`, the child installs the mock and exercises the code, and the child exits. The fake dies with the process. This is what I ran (observed, passes on 24.17.0):

```js
// parent test: the fake is confined to the child
const r = spawnSync(process.execPath,
  ['--experimental-test-module-mocks', '--no-warnings', 'sub.mjs'], { encoding: 'utf8' });
assert.equal(JSON.parse(r.stdout).error.code, 'ETIMEDOUT');
```

**3. Add a tripwire.** After the isolated tests, assert in the parent that the real implementation is back. Check identity and also shape, so a replaced-by-another-fake case is caught:

```js
const real = require('node:child_process').spawnSync;   // captured at file top, before any mock
test('tripwire: real spawnSync is back', async () => {
  assert.equal((await import('node:child_process')).spawnSync, real);
  assert.equal(require('node:child_process').spawnSync, real);
  assert.match(Function.prototype.toString.call(real), /^function spawnSync/);
  assert.equal(spawnSync('echo', ['ok'], { encoding: 'utf8' }).stdout, 'ok\n'); // behaviour, not identity
});
```

A tripwire only guards what it names. A broader version snapshots, before and after each file: key built-in function identities, `process.env`, `process.cwd()`, `process.listeners('SIGINT')`, and `process.getActiveResourcesInfo()` (available on Node 24.17; listed in the process docs). Diff the snapshots and fail on drift.

**4. Run negative controls.** A guard that has never failed is unproven. Reintroduce the leak on purpose (skip the child process, or overwrite the property) and confirm the suite fails. I ran a small version: replace `cp.spawnSync`, then assert that the tripwire's comparison throws, then restore in `finally` (observed, passes). In CI, keep one permanent negative control or run it as a mutation step when the isolation helper changes.

**5. Use the leak detectors you have.** `jest --detectOpenHandles` reports handles keeping Jest from exiting; the `why-is-node-running` package prints active handles for a plain Node process. Neither detects a replaced function; they catch timers, sockets and child processes.

**6. Run the whole suite on every target OS in CI, with randomization.** Run `--test-randomize` (Node 24.16+), `jest --randomize` or `vitest --sequence.shuffle` with a printed seed on at least one job, and keep one unshuffled job.

**7. Treat "0 failures" as a claim to reproduce.** Ask for the exact command, Node version, OS, isolation mode, and seed. A different platform or one deleted skip can change the number.

## Why this matters for AI-written tests

Agents reach for module mocks readily, because a failing path (a timeout, a missing binary) is easy to fake that way, and they tend to verify by running only the file they just wrote, which hides cross-file effects. Reviewers should look beyond the pass count:

- Does the mock restore *and* does anything cache a reference first loaded under it?
- Does the test run under `--test-isolation=none` or a thread pool anywhere?
- Is there a platform skip whose absence would change other results?
- Is there a tripwire or snapshot diff, and a negative control showing it can fail?
- Did the author run the suite with a randomized order on the CI platform, not just the one file locally?

The leftover `npm root -g` trap is a reminder that fakes also leave data behind: a temp directory a fake pointed at may be deleted while real code still holds the path. Tests that fake external commands should clean up what the fake returned and assert no later code reads it.

## Checklist

- [ ] Prefer injected functions; use module mocks only for code you can't change.
- [ ] Run built-in fakes in a one-shot child process (or at minimum with process-level isolation).
- [ ] Capture real built-ins at file load and add a tripwire that asserts identity and behaviour.
- [ ] Add a negative control for each guard; confirm it can fail.
- [ ] Snapshot env, cwd, signal listeners, active resources before and after files.
- [ ] Run randomized order with a recorded seed on CI; keep one deterministic job.
- [ ] Run the full suite on every supported OS; do not rely on one developer machine.
- [ ] Review mock scope, skip conditions and isolation mode, not only the pass count.
- [ ] Reproduce any "0 failures" claim with Node version, OS, command and seed.

## References

- Node.js test runner, `mock.module()`, `MockModuleContext.restore()`, execution model, randomization: https://nodejs.org/docs/latest-v24.x/api/test.html
- Node.js `process.getActiveResourcesInfo()`: https://nodejs.org/docs/latest-v24.x/api/process.html
- Jest object (`isolateModules`, `restoreAllMocks`, `resetModules`): https://jestjs.io/docs/jest-object
- Jest configuration (`restoreMocks`, `resetModules`): https://jestjs.io/docs/configuration
- Jest CLI (`--randomize`, `--seed`, `--detectOpenHandles`): https://jestjs.io/docs/cli
- Jest ECMAScript modules (`unstable_mockModule`): https://jestjs.io/docs/ecmascript-modules
- Vitest `pool`: https://vitest.dev/config/pool
- Vitest `isolate`: https://vitest.dev/config/isolate
- Vitest `restoreMocks`, `unstubGlobals`, `unstubEnvs`: https://vitest.dev/config/restoremocks , https://vitest.dev/config/unstubglobals , https://vitest.dev/config/unstubenvs
- Vitest `sequence` (shuffle, seed): https://vitest.dev/config/sequence
- Vitest module mocking (hoisting): https://vitest.dev/guide/mocking/modules
- why-is-node-running: https://github.com/mafintosh/why-is-node-running
