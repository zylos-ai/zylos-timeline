---
date: "2026-11-24"
time: "09:00"
title: "Only the Tests It Can Break: Impact-Based Test Selection and What the Import Graph Misses"
description: "How to choose the tests a change can actually break without a full run, why static import graphs silently miss breakage in a Node.js multi-process codebase, and how to audit and measure the selection."
tags: ["research", "testing", "test-selection", "nodejs", "code-review", "ci", "regression-testing", "mutation-testing"]
---

## Executive Summary

Running only the tests a change can break is an old, well-studied idea, and the industrial systems cited here implement it in different ways. Google's TAP runs every test target its build system marks as affected, batched at milestones, and relies on build rules that declare every dependency. Microsoft's Test Impact Analysis selects from per-test dependency maps, falls back to all tests for changes it cannot reason about, and recommends a periodic full run. Meta selects with a learned model and backs it with a stage that runs all tests on the main branch every few hours. Our policy (no full run by default, reviewer-selected tests, one full run before release) is closest to the last two: a narrow selection plus a wider backstop. What the literature adds is a precise account of *where the selector goes blind* and *how to notice when it does*.

Three findings matter most for a Node.js agent runtime made of a CLI, PM2 daemons, SQLite, child processes and config-loaded modules.

1. **A JavaScript import graph is a lower bound on impact, not an estimate of it.** Jest's own documentation says `--onlyChanged` "requires a static dependency graph (ie. no dynamic requires)", and Vitest's `related` follows static imports only. In Legunsen et al.'s comparison of static selection with a dynamic tool on Java projects, reflection was the only cause of unsafety they found; the same authors name test-order dependence as an assumption of their tool, and external files and native code as further potential sources of unsafety. In a Node codebase the equivalent blind spots are broader: `spawn('node', [script])`, computed `require(path)`, config-driven plugin loading, files read at runtime (SQL, JSON, prompt templates), environment-variable branches, and anything that crosses a process boundary as a data format. None of these create an import edge.
2. **The industrial systems cited here do not trust the selector blindly; they fall back, override and re-run.** Microsoft's Test Impact Analysis runs all tests when it meets a file type it cannot reason about and recommends a periodic run-everything setting. Nx by default treats a lockfile change as affecting every task. Meta's predictive selection is paired with a "stabilization" stage that runs all tests on the main branch every few hours. The pattern is: *unknown means widen*.
3. **The selection must be auditable and measurable.** A reviewer-listed selection is only as good as its evidence. The practical loop is: record the reason for each selected test and each deliberately skipped batch, run the full suite on a schedule, log every failure that the selection would have missed as an "escape", and use each escape to add a mapping rule. Mutation testing of the changed code against the selected tests gives a direct, if imperfect, safety probe.

The rest of this article covers the established approaches, a Node-specific catalogue of misses with mitigations, a hand-followable procedure with a small script sketch (which I ran against a toy fixture; its limits are listed), and a measurement plan. Facts taken from sources are cited; statements of my own reasoning are labelled **(inference)**.

## 1. Established approaches and what they cost

Regression test selection (RTS) has one defining trade-off. A technique is *safe* if it never omits a test that the change could make fail, and *precise* if it selects only tests that are actually affected. Legunsen, Shi and Marinov state these definitions directly in the STARTS tool paper, and report that static class-level RTS is less precise than dynamic RTS and can be unsafe ([STARTS, ASE 2017](https://www.cs.cornell.edu/~legunsen/pubs/LegunsenETAL17STARTS.pdf)). Everything below is a different point on that trade-off.

### 1.1 Static dependency-graph selection

**What it gives.** Build a graph from the source, reverse it, and select every test that transitively depends on a changed file. It needs no history and no instrumentation, and it is deterministic.

| Tool | Mechanism (from docs) | Documented limit |
|---|---|---|
| Jest `--findRelatedTests`, `--onlyChanged`, `--changedSince` | "Find and run the tests that cover a space separated list of source files"; `--changedSince` runs tests related to changes since a branch or commit and "behaves similarly to `--onlyChanged`" ([Jest CLI](https://jestjs.io/docs/cli)) | `--onlyChanged` "requires a static dependency graph (ie. no dynamic requires)". Jest issues note `--findRelatedTests` "might not always be smart enough, depending on project setup" ([#9211](https://github.com/jestjs/jest/issues/9211)) |
| Vitest `related`, `--changed` | Runs tests that cover listed files; by default relies on the static module graph ([Vitest CLI](https://vitest.dev/guide/cli.html)) | Follows static imports, not computed dynamic ones. Optional `experimental.recordDependencies` records what each test file actually loaded; a test file with no record always runs. The `--since-last-run` mode documents that files a test did not load last time (for example a new `.env` or `__mocks__` file) are not detected |
| Nx / Turborepo "affected" | A task is selected when a changed file is among its declared inputs ([Nx affected](https://nx.dev/ci/features/affected)) | Correctness depends on declared inputs. Without `^production`-style inputs, a dependent project's tests are not selected when a dependency changes; a lockfile change by default affects every task |
| Bazel `rdeps` | `rdeps(u, x)` returns reverse dependencies of `x` within universe `u` ([Bazel query guide](https://bazel.build/query/guide)) | Sound only because the build is hermetic: Bazel hashes declared inputs, so an action that reads something undeclared may be wrongly skipped ([hermeticity](https://bazel.build/basics/hermeticity)) |
| Google TAP | Uses build rules to "create a reverse dependency structure" and run all test targets that transitively depend on modified files; these are called AFFECTED targets ([Memon et al., ICSE-SEIP 2017](https://research.google.com/pubs/pub45861.html)) | Needs a build system that knows every edge |

The key observation (Meta's paper makes it explicitly) is that *the safety of build-dependency selection is a property of the build system, not of the algorithm*: Meta writes that "strict build isolation enforced by the build system guarantees this technique identifies all tests that could possibly be impacted" ([Machalica et al.](https://arxiv.org/abs/1810.05286); full text read from the PDF). A Node repository with no hermetic build has no such guarantee. **(inference)** Jest, Vitest and a regex script are all "best-effort Bazel without the hermeticity", and the difference is exactly the set of blind spots in section 2.

**Safety and precision in practice.** In the limitations section of the STARTS tool paper, the authors summarise their earlier study, which compared static RTS with the dynamic tool Ekstazi: "We also found that reflection was the only cause of unsafety of SRTS when compared with Ekstazi", and STARTS "can be unsafe when the path between tests and changed types can only be reached via reflection" ([STARTS §V](https://www.cs.cornell.edu/~legunsen/pubs/LegunsenETAL17STARTS.pdf); FSE 2016 study [slides](https://www.cs.cornell.edu/~legunsen/slides/FSE-2016.pdf)). That result is bounded by that comparison. The same section says "STARTS also assumes that there is no test-order dependence", and lists as open work making static RTS safer "with respect to other potential sources of unsafety (such as dependency of tests on external files or native code)". On 32 Maven projects, STARTS selected on average 35.2% of tests, for an end-to-end runtime (offline mode) of 81.0% of running all tests, so selection saved test count far more than wall-clock. **(inference)** In that evaluation the observed unsafety came from one dynamic construct. It does not show that static selection is nearly safe in general. In Node, the section 2 blind spots are the counterparts of reflection, and runtime-read files and test order matter here as well.

**Cost.** Static selection is cheap but over-selects. Meta reports that selecting every test that transitively depends on a change gives "in the order of 10^4" tests per change even though most changes touch few files, and that almost 99.9% of those selected test targets pass.

### 1.2 Coverage-based and dynamic selection

**What it gives.** Record, per test, which files (or classes, or lines) it actually touched; select tests whose recorded footprint intersects the change. This sees through reflection, dynamic loading and (if instrumentation extends that far) file reads.

- **Ekstazi** (Gligoric, Eloussi, Marinov, ISSTA 2015) tracks per-test dynamic *file* dependencies for Java and JUnit: both `.class` files and external resources such as configuration files. It was evaluated on 615 revisions of 32 open-source projects and reduced end-to-end testing time by 32% on average, and 54% for longer-running suites, versus running all tests ([ACM](https://dl.acm.org/doi/10.1145/2771783.2771784)). The authors chose files rather than classes because tests depend on external files; they note no special support for non-file dependencies such as databases, and that whole-file tracking of configuration can over-select ([paper](https://users.ece.utexas.edu/~gligoric/papers/GligoricETAL15Ekstazi.pdf)). Their safety argument is by reduction to proven class-level RTS rather than a new formal proof.
- **Microsoft Test Impact Analysis** collects a per-test dependency map for managed code and runs tests that had changed source files in their map. Its documented scope: managed code, single-machine topology; not supported for multi-machine topology, data-driven tests, .NET Core or UWP ([Microsoft Learn](https://learn.microsoft.com/en-us/azure/devops/pipelines/test/test-impact-analysis)). Three features are worth copying in spirit: a **safe fallback** ("for commits and scenarios that TIA can't understand, it falls back to running all tests", e.g. HTML/CSS changes), **configurable periodic full runs** (recommended), and **user-supplied dependency mappings** that "can even be approximate" for other languages.
- **Per-test JS coverage** is feasible in Node with V8 coverage (`NODE_V8_COVERAGE`, used by c8; [Node CLI docs](https://nodejs.org/api/cli.html), [c8](https://github.com/bcoe/c8)). Whether spawned `node` child processes contribute is not stated in the c8 README; the environment variable is inherited by children by default **(inference, verify on your setup)**. Coverage only records executed code; it does not record "this test reads `schema.sql`" unless you add file-access tracking.

**Cost.** A map has to be built, stored and kept fresh. Meta's authors explicitly decline dynamic analysis, saying that "maintaining per-test code coverage information accurate enough to drive the test selection process is impractical in large monolithic repositories", and that all dynamic methods are approximate because it is "fundamentally impossible to know control flow of a test execution before the test is exercised" on the new version.

### 1.3 Learned / predictive selection

- **Meta** trains a model on historical test outcomes and change features to choose tests per change. The abstract's claims: it reduces the infrastructure cost of testing changes "by a factor of two" while still reporting "over 95% of individual test failures" and "over 99.9% of faulty changes" ([arXiv 1810.05286](https://arxiv.org/abs/1810.05286)). Note the second number is per *faulty change*, not per failure; one failing test among several is enough to flag a change. Meta's pipeline keeps a "stabilization" stage in which all tests run on the main branch every few hours, which, in the paper's words, "aims to catch any breakages that slipped through prior stages". Meta also stresses that its approximation "needs not be conservative" because diff-time and land-time testing are not the last line of defence.
- **Google** studied TAP data over a four-week period covering over 5.5 million affected test targets; only 63K of them ever failed, and of all executions only 1.23% found a breakage or a fix ([Memon et al.](https://research.google.com/pubs/archive/45861.pdf), read from the PDF). A simulation limiting runs to tests close to the change in the dependency graph (MinDist at most 10) executed 61% of test targets and, per the paper, "we did not miss a single breakage or fix" in that dataset. That is evidence that proximity matters, **not** evidence that a small repository can skip distant tests.
- **Launchable** is a commercial service that, per its docs, "uses machine learning to select the right tests to run for a specific code change", based on past test runs and the change under test ([docs](https://help.launchableinc.com/features/predictive-test-selection/)). I could not retrieve its confidence-target documentation, so I make no claim about its numbers.

**Cost.** Learned selection needs a large, clean history (and handling of flaky tests) and cannot give a guarantee. **(inference)** For a small runtime with a few hundred tests and low commit volume, the history is too thin to learn from, and the engineering cost is not justified. The useful transferable ideas are the safeguards, not the model.

## 2. Where import-graph selection misses in a Node codebase

An import graph links file A to file B when A statically names B. A test's behaviour depends on many things that are not statically named. The table lists the misses specific to our architecture; the sections after it explain the less obvious ones. "Documented" means a source above says so; the rest is my analysis **(inference)** based on how Node loads code.

| Blind spot | Why the graph misses it | Mitigation |
|---|---|---|
| Computed `require(x)` / `import(x)` | Specifier is a runtime value. Jest/Vitest document static-only analysis | Grep for non-literal `require(`/`import(`; for each site, write an explicit mapping from the loader file to the set of loadable modules |
| `spawn('node', [script])`, `fork(script)`, `execFile` | The child is a separate process; the script path is a string argument, not an import | Add regex edges for literal spawn targets (see sketch); treat computed targets as blind spots to resolve by hand |
| Config-driven module loading (path in JSON/env, loaded by the runtime) | Edge lives in data, not in code | Maintain a map: config key to modules; changed config or changed module widens to the loader's tests and to each configured module's tests |
| Files read at runtime (SQL, JSON, templates, prompts, fixtures) | `fs.readFile` is not an import | Rule per directory: change under `db/`, `prompts/`, `templates/` selects the tests of the readers, or the module batch (fallback) |
| Environment-variable branches | Same file, different behaviour per env; test setup sets the variable, the import graph sees one file | Select tests that set the variable (grep test sources and CI config for the variable name) |
| Shared mutable state: SQLite schema and migrations | Many modules depend on the schema without importing it; tests may use a fixture DB created elsewhere | "Always run" tier: any change under schema/migration paths runs every test that opens a database |
| Test helpers, fixtures, global setup | A helper is imported by test files (graph handles that), but setup files configured in `jest.config.js` / runner flags are not imported by anything | Treat setup/teardown files and config as "run the whole runner batch" |
| `package.json`, lockfile, Node version | Dependency changes affect every importer of that package, including transitive | Dependency change: select by package name (grep importers); lockfile-only: widen to the batch of every module importing a changed package, or all |
| Cross-process contracts (JSON on stdout, messages through a queue or a DB table) | Producer and consumer share a format, not a module | Contract map: producer file to consumer tests; run the integration test on that boundary |
| Hooks invoked by an external runtime | Entry point is called by a process outside the repo, with no importing test | Map hook scripts to the integration test that invokes them (or add a smoke test) |
| Test-order or shared-global dependence | Tests pass because of what ran earlier | Run the batch, not the single file, when a test touches global or filesystem state |

### 2.1 Dynamic require and import

Jest states the limitation plainly for `--onlyChanged` ("no dynamic requires"), and the Jest issue tracker shows users asking for a manual hint such as a `@relatedTests` docblock because the resolver cannot always infer the relationship ([#9211](https://github.com/jestjs/jest/issues/9211)). A Jest PR ([#9303](https://github.com/jestjs/jest/pull/9303)) improved resolution of template-literal requires when a mapping exists, but only to avoid errors, not to make computed paths visible. Vitest treats `import('./index.js')` as supported but not computed paths.

For us this matters because the runtime loads modules by path from config. The graph sees the loader, not the loaded module. A change to a plugin module then selects only the plugin's own test, never the loader's test that verifies the integration contract. **(inference)**

### 2.2 Spawned child processes

Test A requires `daemon.js`; `daemon.js` runs `spawn('node', ['worker.js'])`. The import graph from the test to `worker.js` has no edge. A coverage tool might see the child if it propagates `NODE_V8_COVERAGE`, but a static selector cannot. Our regex edge from `daemon.js` to `worker.js` fixes literal cases (verified on a fixture below). Anything computed remains a blind spot: a command, script path or args-array element that is a variable, a concatenation or a template literal (`spawn('node', [script])`, `spawn(process.execPath, ['w.js'])`, `fork('./workers/' + name)`). The script reports the calling file instead of ignoring it, and the reviewer resolves it by hand or widens. Shell strings passed to `exec`/`execSync` are not parsed at all; section 3.4 gives the follow-up.

### 2.3 Runtime-read files

This is the Ekstazi lesson in another language. The Ekstazi authors tracked external files precisely because "tests can depend on external files" and collecting only classes is unsafe. A Node test that reads `prompts/system.txt`, a migration `*.sql`, or `fixtures/state.json` depends on it just as much as on any `require`d file. Microsoft's TIA reaches the same conclusion in the conservative direction: an unknown file type triggers a full run, and users who know a file type is irrelevant can opt out with an ignore filter. **(inference)** The cheapest transferable rule is: *a non-JS file with no explicit rule widens to the batch of the directory's owning module*, never to nothing.

### 2.4 Shared mutable state and schemas

The graph cannot represent "everything that opens the database depends on this migration". Bazel avoids this class of problem by making inputs declared and hermetic; Nx documents that if an output folder is missing from `outputs`, tasks that read it are not selected. Neither exists here. The safe approach is a short, explicit "always run" tier (schema, migrations, DB-access layer tests, the integration test that applies all migrations to a fresh database). Because a schema change alters every consumer, this tier is also where Meta's observation applies: dependency-based selection over-selects in the common case, but for this tier the over-selection is the point.

### 2.5 `package.json` and lockfile

Nx's default is that a lockfile change affects every task; it offers `projectsAffectedByDependencyUpdates: "auto"` to narrow this to projects whose resolved dependencies actually changed ([Nx](https://nx.dev/ci/features/affected)). That is the right shape for us: start wide, narrow only with evidence. In practice: a change that edits `scripts`, `engines`, `type` (CommonJS versus ESM) or the test command changes how *every* test loads, so widen to all runner batches; a version bump of one package is narrower, and you can select importers of that package, but lockfile resolution of transitive packages is not visible to a regex.

### 2.6 Cross-process data formats

Two daemons that exchange rows through SQLite, JSON over stdout, or a message queue share a contract that no import expresses. The graph selects the producer's tests when the producer changes, and the consumer's tests only if the consumer imports the producer, which it should not. Microsoft's TIA documents the analogous gap in a different form: it is scoped to single-machine topology, and unsupported for multi-machine. **(inference)** Treat every inter-process contract as an explicit map entry from the producer path to the consumer's tests and the boundary integration test, and prefer contract tests (producer output validated against the consumer's parser) so that one test names both sides.

## 3. A practical procedure for a reviewer

This procedure assumes no test CI, as in our case. It is designed to be followed by hand or by a small script, and to leave an audit trail.

### 3.1 Steps

1. **List changed files.** Use the diff against the merge base; include renames, deletions and non-code files (`git diff --name-status -M <base>` lists the old path of a rename). Deleted files matter: their former importers break. A deleted file, or the old path of a rename, has no node in the head checkout's graph, so its former importers can only be found on the base: check the merge base out separately (`git worktree add <dir> <base>`), run step 3 there for those old paths, and add the result to the head run's selection. The script lists such paths under `needsHumanDecision` so they cannot be dropped silently.
2. **Classify each changed file** into one of: JS source, test, test helper or fixture, non-JS runtime data (SQL, JSON, prompts, templates), config, dependency manifest, schema or migration, runner config.
3. **Compute reverse dependencies for JS files.** Build the reverse import map (script below), walk it transitively to fixpoint, and keep every test reached. This is the "including importers of importers" step; one level of dependents is not enough.
4. **Add non-import edges.** Apply the checked-in mapping file: spawn targets, config-loaded modules, data-file readers, contract producers/consumers. Resolve each "blind spot" the script reports by reading the flagged lines.
5. **Apply always-run tiers.** Schema or migration, runner config or setup, package manifest, shared DB-access layer: run the matching tier regardless of the computed set.
6. **Decide widening.** Widen to the whole top-level module batch if any of these holds: the change touches a file the graph could not fully resolve (non-literal loads in the changed file or its importers); the change is to a shared utility imported by more than N modules **(N is a local judgement)**; the change modifies a process boundary; the selected set for the module is already more than about half the batch (the remaining tests are probably cheap). Widen to the entire suite only via step 8.
7. **Add the PR's own new or changed tests** and the integration or e2e case on each affected boundary, even if the graph did not select them.
8. **Escalate to a full run** (needing the approval your policy requires) if any of: a lockfile or Node version change; a test runner or global setup change that cannot be scoped; a change to a file that every test loads; a failure in the selected set that looks unrelated to the diff (an unexplained failure suggests shared state, which selection cannot bound); or a selection that you cannot justify in writing.
9. **Write the selection record** (3.2) in the PR.

### 3.2 What an auditable selection record contains

A reviewer reading the PR should be able to re-derive the selection. **(inference, drawing on TIA's advice to "manually validate the selection" with the report)** Include:

| Field | Example |
|---|---|
| Base and head commit | `abc123..def456` |
| Changed files by class | 3 JS, 1 SQL, 0 config |
| Reverse-import result | `src/store.js` reached `test/store.test.js`, `test/daemon.test.js` (depth 2) |
| Non-import edges applied | `db/001.sql` -> store batch by mapping rule `db/`; `daemon.js` spawns `worker.js` |
| Blind spots found | `daemon.js` has a computed `require` -> widened to daemon batch |
| Tiers | Schema tier triggered, 2 tests |
| New or changed tests | `test/store.migration.test.js` |
| Not run, with reason | CLI batch: no path from changed files, no mapping rule |
| Result | Pass counts, plus any pre-existing failures noted |
| Escalation decision | No full run: no lockfile, runner or shared-state change |

The "not run, with reason" row is the most valuable one. It makes omissions an explicit claim that can later be checked against an escape.

### 3.3 A small script sketch

The script below builds a reverse import map with regular expressions, follows it transitively, adds checked-in mapping rules, and reports what it cannot see. I ran it with Node 24 on a toy fixture: a store module, a test that `require`s it, a daemon that spawns a worker that requires the store, a test that only does a side-effect `import '../src/store.cjs'`, a module that runs `spawn('node', [script])` with a computed `script`, a `.sql` file covered by a mapping rule, a computed `require`, and an unrelated module with its own test. Results:

| Control | Result |
|---|---|
| Change the store module | Selected its direct test, the side-effect-import test, and the daemon test (through the `spawn` edge) |
| Change the `.sql` file | Selected the test named by the `db/` mapping rule |
| Computed `spawn('node', [script])`, computed `require` | Both files listed in `graphBlindSpots`; the test behind the computed spawn is not selected, so it must be resolved by hand |
| Change `README.md` (no rule) | Listed in `needsHumanDecision` |
| Delete the store module, or rename it, and pass the old path | Head run: old path listed in `needsHumanDecision`, nothing selected. Same script on a base checkout (step 1): all three store tests selected |
| Change the unrelated module | Selected only that module's test |

An earlier version of this sketch dropped three of these silently: the side-effect import, the computed spawn and the deleted path. It is a sketch for a reviewer, not a tool to trust without the caveats below.

```js
#!/usr/bin/env node
// impact.mjs <repoRoot> <changedFile>...   (Node >= 18)
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, extname } from 'node:path';

const root = resolve(process.argv[2]);
const changed = process.argv.slice(3).map(f => relative(root, resolve(root, f)));
const SKIP = new Set(['node_modules', '.git', 'coverage']);
const JS = ['.js', '.mjs', '.cjs'];
const isTest = f => /(^|\/)(test|tests|__tests__)\//.test(f) || /\.(test|spec)\.[cm]?js$/.test(f);

const walk = (d, out = []) => {
  for (const n of readdirSync(d)) {
    if (SKIP.has(n)) continue;
    const p = join(d, n);
    statSync(p).isDirectory() ? walk(p, out) : out.push(relative(root, p));
  }
  return out;
};

// Literal specifiers only. Entries 3+ are spawn/fork edges (path relative to cwd or caller).
const RE = [
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\b(?:from\s+|import\s*)['"]([^'"]+)['"]/g,                    // `... from './x'` and `import './x'`
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\b(?:spawn|spawnSync|execFile|execFileSync)\(\s*['"][^'"]*node[^'"]*['"]\s*,\s*\[\s*(?:['"]-[^'"]*['"]\s*,\s*)*['"]([^'"]+)['"]/g,
  /\bfork\(\s*['"]([^'"]+)['"]/g,
];
const EXT = ['', '.js', '.mjs', '.cjs', '.json', '/index.js'];
const resolveSpec = (from, spec, viaSpawn) => {
  if (!spec.startsWith('.') && !viaSpawn) return null;           // bare = package; lockfile rule
  const bases = viaSpawn ? [resolve(root, spec), resolve(root, dirname(from), spec)]
                         : [resolve(root, dirname(from), spec)];
  for (const b of bases) for (const e of EXT)
    if (existsSync(b + e) && statSync(b + e).isFile()) return relative(root, b + e);
  return null;
};

const rdeps = new Map(), blind = [];
for (const f of walk(root).filter(f => JS.includes(extname(f)))) {
  const src = readFileSync(join(root, f), 'utf8');
  RE.forEach((re, i) => { for (const m of src.matchAll(re)) {
    const t = resolveSpec(f, m[1], i >= 3);
    if (t) (rdeps.get(t) ?? rdeps.set(t, new Set()).get(t)).add(f);
  } });
  // Report what the regexes cannot follow.
  if (/\b(require|import)\(\s*(?:[^'"`\s)]|(?:'[^']*'|"[^"]*")\s*[+,]|`[^`]*\$\{)/.test(src))
    blind.push(`${f} (computed require/import)`);
  // Command, script or any args-array element that is not a plain string literal.
  if (/\b(?:spawn|fork|execFile)\w*\(\s*(?:[^'"\s)]|['"][^'"]*['"]\s*(?:\+|,\s*(?:[^\[\s]|\[(?:\s*['"][^'"]*['"]\s*,)*\s*(?:[^'"\s\]]|['"][^'"]*['"]\s*\+))))/.test(src))
    blind.push(`${f} (computed spawn/fork)`);
}

// Non-import edges: { "pathPrefix/": ["tests/or/dirs"] }, checked into the repo.
const mapFile = join(root, 'test-impact-map.json');
const MAP = existsSync(mapFile) ? JSON.parse(readFileSync(mapFile, 'utf8')) : {};

const seen = new Set(), queue = [...changed], hit = new Set(), why = [];
while (queue.length) {                                           // transitive closure
  const f = queue.pop();
  if (seen.has(f)) continue;
  seen.add(f);
  if (isTest(f)) hit.add(f);
  for (const up of rdeps.get(f) ?? []) queue.push(up);
}
for (const f of changed) for (const [prefix, tests] of Object.entries(MAP))
  if (f.startsWith(prefix)) { tests.forEach(t => hit.add(t)); why.push(`${f} -> rule ${prefix}`); }

const unknown = changed.filter(f => !JS.includes(extname(f)) &&
  !Object.keys(MAP).some(p => f.startsWith(p)));                 // non-JS with no rule: human decides
// Deleted or renamed-away paths have no node in this checkout's graph: their importers
// can only be found on the base checkout (see 3.1 step 1).
const gone = changed.filter(f => !existsSync(join(root, f)))
  .map(f => `${f} (not in this checkout: run this script on the base checkout for it)`);
console.log(JSON.stringify({ changed, selected: [...hit].sort(), mapRules: why,
  needsHumanDecision: [...unknown, ...gone], graphBlindSpots: blind }, null, 2));
```

The mapping file is intentionally boring:

```json
{
  "db/": ["test/store.test.js", "test/migrations.test.js"],
  "prompts/": ["test/prompt-loader.test.js"],
  "package-lock.json": ["*ALL*"]
}
```

(The sketch treats a map value as a literal test path; implementing `*ALL*` or directory expansion is left to the local version.)

### 3.4 Known limits of the sketch

- **Regex parsing**, not an AST. It *matches* `require`/`import` text inside comments and strings, so a commented-out import still creates an edge (over-selection, which costs time, not safety). It misses template strings spanning lines, aliased `require` (`const r = require; r('./x')`), and TypeScript path aliases. A real parser (Acorn, es-module-lexer) or Jest/Vitest's own resolver (`jest --listTests --findRelatedTests`, which resolves aliases and `moduleNameMapper`) is more accurate; I would use the script as the fallback and for non-import edges, and Jest's resolver for the import edges where Jest is in use.
- **Re-exports and barrels** are followed when the barrel re-exports with a literal form the regexes match (`export ... from './x'`, `require('./x')`). Every importer of the barrel then becomes a reverse dependency, which over-selects. A barrel that re-exports through a computed load or an unmatched form under-selects like any other blind spot.
- **Computed loads** are reported, not resolved; the reviewer must resolve each flagged file. A computed spawn is reported at the file that makes the call. If that file is a wrapper such as `runScript(name)`, the scripts its callers pass are not edges, so resolving the flag means listing those callers' arguments.
- **Deleted and renamed paths** are reported, not resolved, because the head checkout has no graph node for them; run the script on the base checkout for those paths (3.1 step 1). If a base checkout is not practical, widen to the batch of every module whose files mention the old path.
- **Forms with no edge and no report.** Shell strings (`exec('node ' + script)`, `execSync`), `worker_threads` `new Worker(...)`, and calls through an aliased `child_process` function are neither followed nor flagged. Conservative follow-up: before trusting the selection, grep the changed files and their importers for `exec`, `Worker(` and `child_process`, and widen to the module batch for any hit the script did not list.
- **Package-level edges** (bare specifiers) are ignored by design; a dependency bump needs a separate grep.
- **Node resolution subtleties** (conditional exports, `package.json#imports`, symlinks) are not modelled.
- **Test identification** is path-based; a test helper named `helper.js` under `test/` is treated as a test file and would be selected for execution. For a naming convention that does not match, adjust `isTest`.
- **Static only.** It does not see environment-variable branches, files read at runtime without a mapping rule, shared state, or order dependence.

**(inference)** The script should be treated as an aid to listing candidates. The reviewer's recorded decisions (widening, tiers, escalation) are what make the selection defensible.

## 4. Measuring whether the selection is safe

A selection policy is a prediction: "no test outside this set will fail because of this change". Predictions need feedback.

### 4.1 Periodic full runs as the backstop

Meta and Microsoft's TIA each have one. Google's TAP, as described in its paper, relies instead on running every affected target at each milestone, with completeness coming from declared build dependencies. Meta's "stabilization" stage runs all tests on main every few hours, specifically to catch breakages that "slipped through prior stages". Microsoft's TIA exposes a configurable periodicity for running all tests and calls setting it "recommended". Microsoft also suggests a calibration method: run the impacted tests (T1) and then all tests (T2) in sequence; if T1 failed, confirm T2 reports the same set of failures, and manually validate the selection with someone who knows how the system and tests are architected. For a repository with no CI, the equivalent is a scheduled job or an owner-triggered run on a cadence you can afford (nightly if cheap, otherwise per release and on a sampling of merged PRs), run against merged code with results attached to the PR that introduced the change.

### 4.2 Recording escapes

An **escape** is a test failure found by a full or later run that the PR's selection would not have included. Record, per escape: PR, changed files, the failing test, which blind-spot class from section 2 explains it, and whether a mapping rule now covers it. Then compute two simple numbers over a window: *escape rate* (PRs with at least one escape divided by PRs merged under selection) and *escape class distribution*. Neither needs more than a spreadsheet. **(inference)** The class distribution is the useful part: if most escapes are "runtime-read file", add a directory-level rule; if they are "shared global state", the tests need isolation, not better selection. Meta's results are a reminder of the shape of the numbers (over 99.9% of faulty changes caught, but not all), and also that even a heavily engineered system accepts a tail, because backstops exist.

### 4.3 Mutation testing of the selection

Research evaluates RTS safety with mutants. Shi et al. note that real faults are scarce, so the standard approach is mutants as a proxy, and that a safe RTS "cannot miss any change-related fault that the full test suite can find" ([Shi et al., comparing and combining test-suite reduction and selection](https://mir.cs.illinois.edu/marinov/publications/ShiETAL15ReductionSelection.pdf)). A study of change-based test selection used per-class mutation scores of the reduced set against the full suite, cautioning that mutation coverage is not an exact measure of test quality ([Change-based test selection: an empirical evaluation](https://www.researchgate.net/publication/283684584_Change-based_test_selection_an_empirical_evaluation)).

A lightweight adaptation for a reviewer, with the procedure listed so it can be audited:

1. For a sample of merged PRs, restrict mutation to the changed lines (commit-relevant mutants).
2. Run the mutants against the **selected** set and against the **full** suite.
3. A mutant killed by the full suite but not by the selected set is a *selection miss*; its killing test and the path from mutant to test tell you which edge was missing.
4. Treat the miss rate as an estimate with wide error bars; mutants are not faults. **(inference)** Because the policy here limits heavy runs, do this offline on a sample, not per PR, and keep the harness outside the repo as a temporary tool.

This is also the cheapest way to *test the mapping rules themselves*: inject a mutant in a SQL file or prompt template and check that the rule selects a test that kills it.

## 5. Recommendations and checklist

**Principles**

- Treat the import graph as a **lower bound**. Everything it cannot see must be covered by an explicit rule or a deliberate widening. Unknown means widen. (This is the TIA and Nx default.)
- Keep **safety checks cheaper than the cost of an escape**: the audit table and escape log cost minutes; a missed breakage in a daemon costs much more.
- Prefer **tests that name both sides of a contract** over trusting selection to connect them.

**Checklist for each change**

- [ ] Changed files listed against the merge base, including deletions and renames, each classified; deleted and old renamed paths run against a base checkout.
- [ ] Reverse imports computed to fixpoint (importers of importers), not one level.
- [ ] Spawn/fork targets, config-loaded modules, data-file readers and cross-process contracts added from the mapping file.
- [ ] Every non-literal `require`/`import`/`spawn` in a changed file or its direct importers resolved by hand or widened, plus any `exec`/`Worker` site the script does not report.
- [ ] Non-JS changes (SQL, JSON, prompts, templates) have a rule; if none, widened to the owning module batch.
- [ ] Always-run tiers applied: schema and migrations, DB-access layer, runner config or setup files, package manifest.
- [ ] The PR's new tests and the boundary integration/e2e test included.
- [ ] Batch widening decision recorded with the reason.
- [ ] Escalation triggers checked (lockfile or Node version, shared setup, unexplained failure, unjustifiable selection); full-run approval requested if triggered.
- [ ] Selection record posted in the PR, including "not run, with reason".

**Checklist for the repository (once, then maintained)**

- [ ] A checked-in mapping file (`test-impact-map.json` or similar) owned by the team, updated whenever someone adds a spawn, plugin loader, runtime-read file or inter-process format.
- [ ] A lint-style grep (CI-free) that lists non-literal `require`/`import`/`spawn` sites, so the blind spots are a known, shrinking list.
- [ ] A scheduled or release-gated full run with results attributed to merged PRs.
- [ ] An escape log with blind-spot class, reviewed monthly; each escape produces a rule, a test, or a refactor that removes the blind spot.
- [ ] A sampled mutation check of selection and mapping rules, run offline.
- [ ] Where reasonable, **reduce the blind spots at the source**: load plugins from a static registry file rather than computed paths, spawn child scripts through a single helper with a literal table, keep SQL migrations behind one DB module that tests import, and give each inter-process contract a shared schema module that both sides import. Each of these turns a hidden edge into an import edge that any selector can see. **(inference)**

## Sources

- Machalica, Samylkin, Porth, Chandra. "Predictive Test Selection." Meta/Facebook. [arXiv:1810.05286](https://arxiv.org/abs/1810.05286) (abstract numbers; stabilization-stage and dynamic-analysis discussion from the [PDF](https://arxiv.org/pdf/1810.05286))
- Memon et al. "Taming Google-Scale Continuous Testing." ICSE-SEIP 2017. [Google Research page](https://research.google.com/pubs/pub45861.html), [PDF](https://research.google.com/pubs/archive/45861.pdf)
- Gligoric, Eloussi, Marinov. "Practical Regression Test Selection with Dynamic File Dependencies" (Ekstazi). ISSTA 2015. [ACM](https://dl.acm.org/doi/10.1145/2771783.2771784), [paper PDF](https://users.ece.utexas.edu/~gligoric/papers/GligoricETAL15Ekstazi.pdf)
- Legunsen, Shi, Marinov. "STARTS: STAtic Regression Test Selection." ASE 2017. [PDF](https://www.cs.cornell.edu/~legunsen/pubs/LegunsenETAL17STARTS.pdf)
- Legunsen, Hariri, Shi, Lu, Zhang, Marinov. "An Extensive Study of Static Regression Test Selection in Modern Software Evolution." FSE 2016. [Slides](https://www.cs.cornell.edu/~legunsen/slides/FSE-2016.pdf)
- Shi et al. "Comparing and Combining Test-Suite Reduction and Regression Test Selection." [PDF](https://mir.cs.illinois.edu/marinov/publications/ShiETAL15ReductionSelection.pdf)
- "Change-based test selection: an empirical evaluation." [ResearchGate](https://www.researchgate.net/publication/283684584_Change-based_test_selection_an_empirical_evaluation)
- Microsoft Learn. "Use Test Impact Analysis" (Azure Pipelines). [Docs](https://learn.microsoft.com/en-us/azure/devops/pipelines/test/test-impact-analysis)
- Jest CLI documentation. [jestjs.io/docs/cli](https://jestjs.io/docs/cli); Jest issues [#9211](https://github.com/jestjs/jest/issues/9211), [#14000](https://github.com/jestjs/jest/issues/14000) and PR [#9303](https://github.com/jestjs/jest/pull/9303)
- Vitest CLI documentation (`related`, `--changed`, `experimental.recordDependencies`). [vitest.dev/guide/cli.html](https://vitest.dev/guide/cli.html)
- Nx. "Run only tests affected by a PR." [nx.dev/ci/features/affected](https://nx.dev/ci/features/affected)
- Bazel. [Query guide (rdeps)](https://bazel.build/query/guide); [Hermeticity](https://bazel.build/basics/hermeticity)
- Launchable. [Predictive Test Selection](https://help.launchableinc.com/features/predictive-test-selection/)
- Node.js CLI documentation (`NODE_V8_COVERAGE`, `--experimental-test-coverage`). [nodejs.org/api/cli.html](https://nodejs.org/api/cli.html); [c8](https://github.com/bcoe/c8)
