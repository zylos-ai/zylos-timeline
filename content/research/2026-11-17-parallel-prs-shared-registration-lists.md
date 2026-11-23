---
date: "2026-11-17"
time: "09:00"
title: "Many PRs, One List: Designing Registration Points That Don't Conflict and Can't Drift"
description: "Three independent pull requests collided on two hand-maintained test lists; a local git experiment shows why, and a runnable check plus convention-based discovery shows how to make the collision, and the silent drift behind it, structurally impossible."
tags: ["research", "git", "merge-conflicts", "ci", "testing", "ai-agents", "monorepo"]
---

## Executive Summary

When several pull requests each add one entry to the same hand-maintained list, they conflict even though the changes are logically independent. Git's three-way merge cannot tell that "add line A at the top" and "add line B at the top" commute; it only sees two edits at the same place. If the same fact is also recorded in a second list, there is a quieter failure: the lists drift apart, and a test file ends up run twice or not at all.

I reproduced this locally (git 2.43.0, Node.js v24.22.1, Jest 30.5.2) and tested the usual remedies. In order of strength:

1. **Remove the list.** Discovery by convention (a file-name suffix or a first-line pragma) turns "register a test" into "add one file", provided both runners apply the rule to the same set of files. Three branches that each added a file merged with zero conflicts.
2. **If a list must exist, keep one copy** and derive the others from it, so they cannot disagree.
3. **Add a CI check that every test file is claimed by exactly one runner.** A runnable script is below. It caught all four drift states I built. One state (file in the Jest ignore list but not in the node list) left both runners green, so without the check nothing fails.
4. **Mitigations are not fixes.** Sorted, one-per-line, trailing-comma lists still conflict when two entries land in the same gap. `merge=union` resolved a conflict but silently produced a syntax error in my test. Merge queues serialize CI; they do not resolve textual conflicts. `git rerere` replays a resolution when the identical conflicted hunk recurs, whichever branch produces it; branches that each add a different entry produce different conflicts.
5. **AI coding agents amplify the problem**: parallel branches from one base copy the same "add to the top" pattern, and a hand-resolved conflict can drop an entry silently. This is reasoning from the mechanism; I did not measure agent behavior.

Results I ran locally and results I took from documentation are marked throughout.

## The Incident Generalized

In a Node.js monorepo, three pull requests were developed in parallel by different AI coding agents. Each added one test file and had to register it in two hand-maintained places:

- A Jest config's `testPathIgnorePatterns` array, so Jest skips files that run under Node's built-in runner (`node:test`).
- A custom runner script's `ROOT_NODE_TESTS` array; a new directory also needed a `TEST_ROOTS` entry and a `startsWith(...)` line in an `isNodeTest()` predicate.

Every PR followed the nearest example and inserted at the head of each list, right after the opening bracket:

```diff
   testPathIgnorePatterns: [
+    '<rootDir>/test/process-check.integration.test.js',
     '<rootDir>/test/dashboard-sync.integration.test.js',
```

```diff
   ROOT_NODE_TESTS = [
+  'test/upgrade-output.integration.test.js',
   'test/dashboard-sync.integration.test.js',
```

Each PR is fine alone. Yet whichever merges second, and third, must rebase and hand-resolve conflicts. "The second merged rebases" was a reasonable plan, and it shows the cost: a shared list turns independent work into a queue. Two separate problems need separate fixes:

- **Conflict problem.** N PRs edit the same lines. Cost: rebases, CI re-runs, review noise.
- **Drift problem.** One fact ("this file runs under `node:test`") lives in two places. Cost: no conflict, no error, just a test that quietly does not run.

The same shape appears in route tables, plugin lists, feature manifests, `exports` maps, barrel files, changelogs, migration lists and CI matrices. I use the test-list case because it is runnable.

## Why Git Conflicts Here (With an Experiment)

Git compares each branch with the merge base and gets a set of changed regions ("hunks") per side. Hunks that do not touch are both applied; overlapping or adjacent hunks stop the merge, because git cannot know whether order matters. Head-of-list insertion is the worst case because every contributor picks the identical spot; tail insertion is the same problem at the other end. Everything below was run locally with git 2.43.0 (default `ort` strategy).

### (a) Two branches insert at the same spot: conflict

```sh
cd "$(mktemp -d)" && git init -q -b main .
cat > list.js <<'EOF'
module.exports = [
  'test/alpha.test.js',
  'test/bravo.test.js',
  'test/charlie.test.js',
];
EOF
git add -A && git commit -qm base
# each branch inserts one line right after the opening bracket
git checkout -q -b pr-a && sed -i "1a\  'test/new-a.test.js'," list.js && git commit -qam a
git checkout -q main && git checkout -q -b pr-b && sed -i "1a\  'test/new-b.test.js'," list.js && git commit -qam b
git checkout -q main && git merge -q pr-a
git merge pr-b
```

Output:

```text
Auto-merging list.js
CONFLICT (content): Merge conflict in list.js
Automatic merge failed; fix conflicts and then commit the result.
```

```js
module.exports = [
<<<<<<< HEAD
  'test/new-a.test.js',
=======
  'test/new-b.test.js',
>>>>>>> pr-b
  'test/alpha.test.js',
```

A third head-inserting branch conflicted the same way when rebased onto a main containing the first (see the `rerere` section). Two branches appending at the tail conflicted too.

### (b) Different positions: clean merge

Starting from a six-entry list, I created branches that each inserted one entry after a different existing entry (after `alpha`, after `delta`, after `foxtrot`). Merging all three produced no conflicts and this result:

```js
module.exports = [
  'test/alpha.test.js',
  'test/alpha-2.test.js',
  'test/bravo.test.js',
  'test/charlie.test.js',
  'test/delta.test.js',
  'test/delta-2.test.js',
  'test/echo.test.js',
  'test/foxtrot.test.js',
  'test/foxtrot-2.test.js',
];
```

The observed rule is mechanical: insertions merge cleanly only when at least one unchanged line separates them.

| Case | Result |
| --- | --- |
| Both insert in the same gap (head/head, tail/tail, or two sorted names between the same neighbours) | Conflict |
| Insert in gap `alpha`/`bravo` and gap `bravo`/`charlie` (one unchanged line between) | Clean |
| Gaps separated by several unchanged lines | Clean |
| Both branches add the identical line at the same spot | Clean, no duplicate (default driver) |

This is why "keep the list sorted" helps: entries land in different gaps, as in (b). It does not eliminate conflicts: `bravo` and `charlie`, both sorting between `alpha` and `echo`, conflicted in my test.

### Trailing commas and one item per line

One entry per line is what makes line-based merging useful at all; a one-line list is a single hunk. Trailing commas add a second benefit: without them, appending rewrites the previous last line (`'charlie'` becomes `'charlie',`), touching a line a neighbouring insertion may also touch. Test: one branch appended `delta` after `charlie`; another inserted `bravo-2` between `bravo` and `charlie`.

| List style | Result |
| --- | --- |
| No trailing comma (append rewrites the `'charlie'` line) | Conflict |
| Trailing comma (append only adds a line, leaving `'charlie',` unchanged) | Clean |

A formatter can enforce trailing commas (Prettier has a `trailingComma` option). Limits: JSON forbids trailing commas, and this does nothing for the same-gap case in (a).

### (c) The `merge=union` driver: resolves the conflict, with documented caveats

The `merge` attribute can select the built-in `union` driver. The gitattributes documentation says:

> Run 3-way file level merge for text files, but take lines from both versions, instead of leaving conflict markers. This tends to leave the added lines in the resulting file in random order and the user should verify the result. Do not use this if you do not understand the implications.

With `list.js merge=union` in `.gitattributes`, I merged three head-inserting branches in sequence: no conflicts, valid result (`new-a`, `new-b`, `new-c`, then the originals). But "take lines from both versions" knows nothing about syntax. Two failures I reproduced:

**Failure 1: a list without a trailing comma.** Two branches each appended a line (`'delta'` and `'echo'`) after `'charlie'`, rewriting that line to add a comma. The merge exited 0 with no warning. The file was:

```js
const L = [
  'alpha',
  'bravo',
  'charlie',
  'delta'
  'echo'
];
```

and `node --check` reported `SyntaxError: Unexpected string`.

**Failure 2: both branches edit the same line.** One branch changed `retries: 3` to `retries: 4`, the other to `retries: 5`. Without the attribute, git reported a conflict. With `merge=union`, git kept both lines:

```js
module.exports = {
  retries: 5,
  retries: 4,
  timeoutMs: 1000,
};
```

That is valid JavaScript; the last duplicate key wins (`4` here). Merging in the opposite direction gave `4` then `5`, so the effective value depended on merge direction. A real conflict became a silent, order-dependent choice.

Rule: `union` is defensible only on files where every line is independent and syntax is irrelevant, such as a plain one-path-per-line manifest, ideally with a duplicate/order check. It is wrong for code. I did not verify whether a hosted merge button honors the attribute like local git; test your host if you depend on it.

## Fixes (Structural)

Structural fixes remove the shared edit point, strongest first.

### 1. Discovery by convention instead of a list

If the answer to "which runner owns this file?" can be computed from the file itself, there is nothing to register. Two variants:

**Naming convention.** Files for the node runner end in `.node.test.js`. Jest ignores that suffix anywhere in the package; the node runner globs for it anywhere in the package. The two scopes must match: if Jest excludes the suffix everywhere but the node runner only looks under `test/`, a `.node.test.js` file elsewhere is claimed by neither. In a throwaway project with Jest 30.5.2 and Node v24.22.1:

```js
// jest.config.js
module.exports = {
  testEnvironment: 'node',
  testPathIgnorePatterns: ['/node_modules/', '\\.node\\.test\\.js$'],
};
```

```sh
# run from the package root, the directory that holds jest.config.js (Jest's <rootDir>)
node --test "**/*.node.test.js"
```

I added three `test/*.integration.node.test.js` files without touching any config; `jest --listTests` listed only the one Jest-owned file and the node runner ran the other three. Then I added a deliberately failing `orphan.node.test.js` at the package root. The node runner executed it and exited 1. With a narrower glob, `node --test "test/**/*.node.test.js"`, the same file was skipped by both runners and both exited 0: the silent omission this article is about. A failing `*.node.test.js` inside `node_modules/` was not run by the package-wide glob in my test. (Node's docs say glob patterns "should be enclosed in double quotes on the command line to prevent shell expansion".) Tradeoffs: the convention must be known and enforced; renaming existing files is churn.

**Pragma in the file.** The first lines of a test file say `// @runner node:test`. One module reads the pragma and exports the list; Jest and the node runner both consume it (code below). Names stay unchanged and the fact sits next to the code it describes, at the cost of a small discovery module you own.

Either way a new test is one new file. Three branches that each added a test file merged in sequence with no conflict:

```text
merge a ok
merge b ok
merge c ok
```

Note: per the Node docs, plain `node --test` matches broad patterns including `**/*.test.js` and `**/test/**/*.js`, which overlap with Jest's files. That is why each runner needs explicit discovery rules.

### 2. One-file-per-entry registries

When the registry is data rather than discoverable code (release notes, plugin manifests, config snippets), split it into a directory where each entry is its own file, and assemble at build or runtime.

- **Changelog fragments.** towncrier's documentation states the motivation directly: "Rather than reading the Git history, or having one single file which developers all write to and produce merge conflicts, towncrier reads 'news fragments'." Each PR adds its own fragment file. Changesets (documented in its project README) takes a similar approach: contributors declare how their changes should be released, and the tool later consumes those declarations to update versions and changelogs.
- **`conf.d`-style directories.** Many Unix services read every file in a directory such as `something.d/` in lexical order. Adding a feature is adding a file. This is a general pattern I am citing from common practice, not from a specific source here.

Tradeoffs: ordering becomes implicit (usually lexical file name order, so numeric prefixes can appear), many tiny files can be harder to review as a set, and you need a loader plus a clear rule for name collisions. Name fragments after something unique (a PR number, a slug) so two branches never create the same file path; if they do, that is a real conflict worth seeing.

### 3. Generated registries checked by CI

If a single registry file must exist (a barrel, a route table), generate it from directory contents and have CI regenerate and fail on a diff ("generated file is up to date"). This removes manual editing but not the conflict: two PRs that each commit the regenerated file still collide on the generated lines. Cleanest is to not commit it and build it instead; otherwise have a bot regenerate it after merge, or resolve its conflicts by re-running the generator, never by hand.

### 4. A single source of truth

The incident's two lists describe the same set of files, so derive one from the other, or both from a third module. Jest's config is JavaScript, so `testPathIgnorePatterns` (per the Jest docs, regexp pattern strings matched against the full path, with a `<rootDir>` token) can be computed at load time from a shared module that exports "the files owned by the node runner", which the runner also imports. Then they cannot disagree. The pragma example below does exactly this. Jest's `projects` option is a related structure, but it does not by itself make Jest skip files another runner owns; I did not experiment with it.

### 5. A check that each test file has exactly one owner

Whatever you choose, add a check. It is cheap and catches the failure that does not announce itself, including conflict resolutions that drop an entry. It compares all test files on disk with what Jest will run and what the node runner will run, and reports:

- **ORPHAN**: no runner claims it (silently never runs).
- **DUPLICATE**: both claim it (runs twice, often fails in Jest).
- **WRONG RUNNER**: the file imports `node:test` but is claimed only by Jest.
- **STALE**: a registered entry points at a file that no longer exists.

To avoid re-implementing Jest's regex semantics (unanchored patterns, unescaped dots), the script asks Jest with `jest --listTests --json`, which the CLI docs describe as listing "all test files that Jest will run given the arguments, and exits."

## Fixes (Process)

### Merge queues

GitHub's docs say a merge queue helps by "automating pull request merges into a busy branch and ensuring the branch is never broken by incompatible changes", testing each PR against the latest target branch plus the PRs ahead of it. GitLab's merge trains docs make the same point: "Two merge requests can each pass their own pipeline, but their combined changes can still conflict." Mergify and bors-ng offer comparable queueing (references; not reviewed in depth).

Queues close the window between "green on my branch" and "green on main after the others landed". They do not resolve textual conflicts. GitHub's docs say that if a grouped PR has "failed required status checks or conflicts with the base branch, the pull request will be removed from the queue." A queue serializes verification; it does not rebase your list edit. In the incident, the second PR would be ejected and someone would still rebase by hand. I did not run a merge queue; this is from documentation.

### `git rerere`

`rerere` ("reuse recorded resolution") records how you resolved a conflict and replays it. The git docs give the motivation: "In a workflow employing relatively long lived topic branches, the developer sometimes needs to resolve the same conflicts over and over again." It needs `rerere.enabled`.

Test with head insertions and `rerere.enabled=true`: rebasing `pr-b` onto a main containing `pr-a` conflicted and git printed `Recorded preimage for 'list.js'`. I resolved it, finished the rebase, then reset `pr-b` and rebased again from the original commit:

```text
CONFLICT (content): Merge conflict in list.js
Resolved 'list.js' using previous resolution.
```

So `rerere` helps when the same conflict recurs, such as one branch rebased repeatedly while awaiting review. Reuse follows the recorded conflict, not the branch: the docs describe the replay as happening "after seeing the same conflicted automerge". In a second control, a distinct branch `pr-other` (its own commits, plus an unrelated file) inserted the same `new-b` line at the head; rebasing it onto the same main printed `Resolved 'list.js' using previous resolution.` and produced the `new-a`, `new-b` list I had resolved for `pr-b`. In the incident, though, each PR adds a different entry, and different entries are different conflicts: rebasing `pr-c`, whose entry differs, onto the same main recorded a fresh preimage and left the conflict to me. So across PRs it helps only when two PRs produce the identical conflicted hunk, which distinct list entries do not. State is also local to each clone, so it does not travel to teammates or to an agent in a fresh container.

### Rebasing order

If you accept the conflict, order matters. With N PRs sharing a hotspot, rebasing each only when it is next to merge costs N-1 rebases total; rebasing every waiting PR after each merge costs up to 1 + 2 + ... + (N-1) = N(N-1)/2 (three instead of two at N=3), each with a CI run. Rebase once, at your turn. This reduces cost; it does not remove it.

## Code

### The ownership check

The script I ran (Node 20+ for recursive `readdirSync`). It assumes a layout like the incident: a Jest config and a runner module exporting `isNodeTest(rel)` and `ROOT_NODE_TESTS`. Adapt the `require` and file pattern.

```js
#!/usr/bin/env node
// Verify every test file is claimed by exactly one runner.
// Usage: node tools/check-test-claims.js [rootDir]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Canonicalize both sides: Jest reports real paths, so a symlinked root
// spelling would otherwise make every Jest-listed file look unclaimed.
const root = fs.realpathSync(path.resolve(process.argv[2] || process.cwd()));
const toRel = (p) => path.relative(root, fs.realpathSync(p)).split(path.sep).join('/');

// 1. Everything that looks like a test file.
const all = fs.readdirSync(root, { recursive: true })
  .filter((f) => /\.test\.js$/.test(f) && !/(^|[\\/])(node_modules|\.git)[\\/]/.test(f))
  .map((f) => f.split(path.sep).join('/')).sort();

// 2. What Jest would run: ask Jest itself instead of re-implementing its regex rules.
const jest = spawnSync('npx', ['jest', '--listTests', '--json'], { cwd: root, encoding: 'utf8' });
if (jest.status !== 0) { console.error(jest.stderr); process.exit(2); }
const jestSet = new Set(JSON.parse(jest.stdout).map(toRel));

// 3. What the node:test runner would run: the runner owns this predicate.
const { isNodeTest, ROOT_NODE_TESTS } = require(path.join(root, 'scripts/run-node-tests.js'));

const problems = [];
for (const rel of all) {
  const claims = [];
  if (jestSet.has(rel)) claims.push('jest');
  if (isNodeTest(rel)) claims.push('node:test');
  if (claims.length === 0) { problems.push(`ORPHAN    ${rel}  (no runner will execute it)`); continue; }
  if (claims.length > 1) { problems.push(`DUPLICATE ${rel}  (claimed by: ${claims.join(', ')})`); continue; }
  // Content signal: a file that loads node:test must be claimed by node:test.
  // Detects string-literal require('node:test'), import ... from 'node:test',
  // import 'node:test' and import('node:test'); not computed specifiers or helpers.
  const src = fs.readFileSync(path.join(root, rel), 'utf8');
  const usesNodeTest = /\b(?:require\s*\(\s*|import\s*\(\s*|import\s+|from\s+)['"]node:test['"]/.test(src);
  if (usesNodeTest && claims[0] !== 'node:test') {
    problems.push(`WRONG RUNNER ${rel}  (imports node:test but is claimed only by ${claims[0]})`);
  }
}
// 4. Stale registrations: listed but no longer on disk.
for (const rel of ROOT_NODE_TESTS) {
  if (!fs.existsSync(path.join(root, rel))) problems.push(`STALE    ${rel}  (listed in ROOT_NODE_TESTS, file missing)`);
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} problem(s) across ${all.length} test file(s).`);
  process.exit(1);
}
console.log(`ok: ${all.length} test files, each claimed by exactly one runner.`);
```

The runner module must export what the script requires and must not start tests on `require` (guard with `if (require.main === module)`).

Two details matter. First, paths are canonicalized on both sides. Jest returned real paths, so when I passed a symlink spelling of the package root to the earlier version of this script (which used the root as given), it marked the Jest-owned unit test `ORPHAN`; with `realpathSync` the same invocation reported `ok`. Second, the `WRONG RUNNER` detector is deliberately scoped to the four string-literal forms in the comment. An earlier version that matched only `require(` and `from` returned `ok` for a Jest-owned file that did `await import('node:test')`; this version reports it as `WRONG RUNNER`. It matches only the `node:`-prefixed specifier, because Node's docs say "This module is only available under the node: scheme." It does not see a computed specifier or a helper module that re-exports the test API, so a file that loads `node:test` that way and is claimed only by Jest is not flagged.

### Catching drift: what I ran

The fixture had a Jest-owned unit test, a node:test file registered in both lists, and a new node:test file `c.integration.test.js` that I registered in different ways. Actual results with the script above, invoked through a symlink to the package root:

| Registration state of the new file | Check output | Exit |
| --- | --- | --- |
| In neither list | `WRONG RUNNER test/c.integration.test.js (imports node:test but is claimed only by jest)` | 1 |
| In the Jest ignore list only | `ORPHAN    test/c.integration.test.js (no runner will execute it)` | 1 |
| In the node list only | `DUPLICATE test/c.integration.test.js (claimed by: jest, node:test)` | 1 |
| In both lists | `ok: 3 test files, each claimed by exactly one runner.` | 0 |
| File deleted, entry left in node list | `STALE    test/c.integration.test.js (listed in ROOT_NODE_TESTS, file missing)` | 1 |

The second row is the dangerous one. Without the check, with the file in the Jest ignore list but absent from the node list, `jest` reported `Test Suites: 1 passed, 1 total` (exit 0) and the node runner reported `tests 1 / pass 1`. Both green; the file never ran. That is what a conflict resolution keeping only one side's lines looks like from CI.

The "in neither list" state does fail in Jest here (`Your test suite must contain at least one test.`), loud but misleading; the check names the actual cause.

### Single source of truth with a pragma

This is the derived-list version, also run locally. One module decides ownership; both consumers import it.

```js
// scripts/test-discovery.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PRAGMA = /^\s*\/\/\s*@runner\s+node:test\s*$/m; // first lines of the file

const allTests = () => fs.readdirSync(ROOT, { recursive: true })
  .filter((f) => f.endsWith('.test.js') && !/(^|[\\/])(node_modules|\.git)[\\/]/.test(f))
  .map((f) => f.split(path.sep).join('/')).sort();

const isNodeTest = (rel) =>
  PRAGMA.test(fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').slice(0, 5).join('\n'));

const nodeTests = () => allTests().filter(isNodeTest);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = { ROOT, allTests, nodeTests, isNodeTest, escapeRe };
```

```js
// jest.config.js
const { nodeTests, escapeRe } = require('./scripts/test-discovery');
module.exports = {
  testEnvironment: 'node',
  testPathIgnorePatterns: ['/node_modules/', ...nodeTests().map((f) => '<rootDir>/' + escapeRe(f) + '$')],
};
```

```js
// scripts/run-node-tests.js
const { spawnSync } = require('node:child_process');
const { ROOT, nodeTests } = require('./test-discovery');
const files = nodeTests(); // paths relative to ROOT, so run the child there
if (files.length === 0) { console.log('no node:test files'); process.exit(0); }
const run = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, stdio: 'inherit' });
process.exit(run.status ?? 1);
```

Results: with two pragma-marked files, `jest --listTests` listed only the Jest-owned file and the node runner ran two tests. The `cwd: ROOT` matters because discovery returns paths relative to the package root. Without it, the runner worked only when started inside the package: invoked from the parent directory as `node pkg/scripts/run-node-tests.js`, it failed with `Could not find 'test/probe.test.js'`. With it, the same invocation from the parent directory and from `/` ran the marked test while `jest --listTests` (run in the package) listed only the Jest-owned file; a deliberately failing marked test made the runner exit 1 from the parent directory. After adding a third pragma file and editing nothing else, Jest still listed one file and the node runner ran three. A file that used `node:test` but forgot the pragma failed in Jest (`Your test suite must contain at least one test.`), so keep a content-sniffing check like `WRONG RUNNER` in CI. For this layout, the ownership check above works with one line changed: take `isNodeTest` from `scripts/test-discovery.js` and use an empty `ROOT_NODE_TESTS` (there is no list to go stale). I ran it that way: `ok` on the fixture, and `WRONG RUNNER` for a `node:test` file without the pragma. The `$` anchor and `escapeRe` matter: the patterns are regexes and unanchored, unescaped ones can match more files than intended.

## Why AI Agents Are Especially Exposed

This is reasoning from the incident's mechanism, not a measurement.

- **Same base, same example.** Parallel agents typically branch from one commit, see the same list and recent diffs, and copy the most recent addition's pattern. All three put the line at the head. Humans scatter their choices a little; agents following an example do not.
- **Cheap parallelism raises N.** Conflict cost grows faster than the PR count (see the rebase arithmetic above).
- **Hand-resolved conflicts can lose entries.** A quick "keep ours" or "keep theirs" drops the other side's entry; keeping both can break syntax. The result is the orphan state above, with CI green. A failure mode to expect, not one I measured.
- **Rules in a README are weaker than rules in CI.** An agent can follow "register new tests in these two lists" faithfully and still be caught when the other list changes underneath it. A machine-checked invariant holds regardless of who resolved the conflict.
- **Briefings help, but the design should not need them.** "Insert in sorted position, not at the top" reduces collisions; the structural fix makes it unnecessary.

## Checklist

1. **Can the entry be discovered** from a file's name, location or first lines? Use that instead of a list.
2. **If a list must exist, is it the only copy?** Derive any second list from it.
3. **Is there a CI check for the invariant** (every test file claimed by exactly one runner, no stale entries)? Ask the tool itself (`jest --listTests`) rather than re-implementing its rules, and make the check a required status.
4. **Is the list one entry per line, with trailing commas, sorted?** Enforce with a formatter or lint rule, so the nearest example is the right example. This reduces conflicts; it does not remove them.
5. **Is `merge=union` used on code?** Do not. At most, use it on plain one-item-per-line text files with a duplicate/order check.
6. **Is the registry generated?** Prefer not committing it; otherwise regenerate in CI and resolve its conflicts by re-running the generator.
7. **Merge queue?** Good for keeping the target branch green; do not expect it to resolve list conflicts.
8. **Long-lived branches?** Enable `git rerere` for repeated rebases of the same branch. Across PRs it replays only an identical conflicted hunk, so PRs that each add a different entry get no help.
9. **Re-run the ownership check after any runner-config change**, not only after test additions.

## Conclusion

The three colliding PRs were a design problem, not a coordination problem: a central list made every contributor edit the same lines, and a duplicated fact let two lists drift apart. Git did what it should with those inputs.

In order of leverage: let each test file declare its runner; failing that, derive both lists from one source; always guard the invariant in CI, because the worst drift state (registered in one list, not the other) left both runners green. Sorting, trailing commas, `merge=union`, merge queues and `rerere` only make the remaining conflicts cheaper.

Verified locally: conflict, clean-merge, trailing-comma, `union` and `rerere` behavior (git 2.43.0); convention and pragma discovery, the Jest behavior and all ownership-check results (Node.js v24.22.1, Jest 30.5.2). Taken from documentation, not run: GitHub merge queue and GitLab merge train behavior, towncrier and Changesets descriptions, Prettier's option, the `jest --listTests` description, Node's default discovery patterns.

## References

- git-scm, gitattributes (the `merge` attribute and built-in `union` driver): https://git-scm.com/docs/gitattributes
- git-scm, git-rerere: https://git-scm.com/docs/git-rerere
- Pro Git book, Rerere: https://git-scm.com/book/en/v2/Git-Tools-Rerere
- GitHub Docs, Managing a merge queue: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue
- GitLab Docs, Merge trains: https://docs.gitlab.com/ci/pipelines/merge_trains/
- Mergify, Merge Queue: https://docs.mergify.com/merge-queue/
- bors-ng: https://github.com/bors-ng/bors-ng
- Jest, Configuration (`testPathIgnorePatterns`, `projects`): https://jestjs.io/docs/configuration
- Jest, CLI options (`--listTests`): https://jestjs.io/docs/cli
- Node.js, Test runner (default file patterns, glob arguments): https://nodejs.org/api/test.html
- towncrier documentation (news fragments): https://towncrier.readthedocs.io/en/stable/
- Changesets: https://github.com/changesets/changesets and https://changesets.dev
- Prettier, Options (trailing commas): https://prettier.io/docs/options
