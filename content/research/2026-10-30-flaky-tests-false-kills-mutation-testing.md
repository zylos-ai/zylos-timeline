---
date: "2026-10-30"
title: "A Flaky Test Is Not a Kill: Making Mutation-Testing Verdicts Trustworthy"
description: "How one intermittently failing test produced seven fake mutation kills and hid three real survivors, what the research and the main mutation tools say about it, and a hardened protocol (repeat the control, confirm every kill, record the killer, isolate shared state) for trusting mutation verdicts."
tags: ["mutation-testing", "flaky-tests", "testing", "ai-agents", "code-review", "nodejs", "test-isolation", "research"]
---

## Executive Summary

**A mutant killed by a test that also fails without the mutant has not been killed. It has been coincidentally observed next to a failure.** Mutation testing turns "some test failed" into "the suite detects this change". That inference is only valid if the same test passes on the unmutated code, every time. When it does not, the kill is noise, and worse, it is noise that looks like success.

The case: a reviewer ran targeted mutation rounds on a pull request for an agent-runtime dashboard. The Node.js test runner executed each test file in its own child process, in parallel, but all files shared one temporary config directory chosen once per run. One file wrote `{"session_mode":"single"}` into the shared config file; another wrote `"multi"` and asserted that the dashboard read `multi`. When the two overlapped, the second one failed. That happened about once in five runs of the three-file combination, and full-suite runs happened to pass.

Three consequences followed.

- **Round one:** seven mutants were recorded as killed. Every one was "killed" by that one intermittently failing test. None were real kills.
- **Round two:** the control run (no mutation at all) itself failed. Three mutants then passed cleanly, which showed that nothing covered them. An earlier review note had reported all three as killed.
- **The fix:** the test got its own `mkdtemp` root, and the reviewer hardened the harness (repeat the control, confirm each kill by rerun, record the killer; details below). The three real survivors then got precise assertions, and all 13 targeted mutants were killed with confirmed reruns.

What the literature and tool documentation add: order dependence and shared state (including the file system) are leading causes of flakiness. Mutation testing assumes determinism, and that assumption fails in practice: Shi, Bell and Marinov (ISSTA 2019) measured mutation scores moving by four percentage points on average between repeated runs, and a 2024 study of 22 Java projects found that 19% of the mutants killed by flaky tests owed the kill to flakiness in at least one test. The mainstream tools I checked (PIT, StrykerJS, cargo-mutants, Cosmic Ray, mutmut) all require or establish a passing baseline, but in the documentation and source I read, that baseline is a single run, and none documents re-confirming kills.

The recommendation is four rules: gate on a repeated green control, confirm every kill by reproducing the same failing test, record the killer by name and sanity-check it on the clean tree, and remove shared mutable state between test files. Facts below come from sources I opened and read; inference is marked as such.

## The incident: one flaky test, three kinds of verdict

**The mechanism is ordinary shared state, not exotic nondeterminism.** The runner started one child process per test file, which isolates in-memory state between files. The config file, however, lived on disk in a directory whose path was decided once for the whole run and handed to every child. Two files therefore wrote to, and read from, the same file.

```text
shared config dir  (one per run)           config.json
-------------------------------------------------------------------------
file A (runtime switch)   write "single" -----+
file B (dashboard read)        write "multi" -+--- read -> expects "multi"
                                              ^
                          if A's write lands between B's write and B's read,
                          B sees "single" and fails
```

Run alone, each file passes. Run in parallel, the outcome depends on scheduling: the textbook shape of an order-dependent, resource-sharing flaky test.

**A mutation run produces more than "killed" and "survived".** Once a flaky test is in the suite, the same observable ("a test failed while the mutant was active") covers three different situations:

| Verdict | What happened | How to tell it apart | Counts as |
|---|---|---|---|
| Real kill | A test that is green on the unmutated tree fails because of the mutant, and fails again on rerun | Same test fails on every mutant run; same test is green on repeated clean runs | Killed |
| Survivor | Every test passes with the mutant active | Nothing fails | Survived (a test gap, or an equivalent mutant) |
| Flaky kill | A test failed while the mutant was active, but it also fails sometimes without the mutant | Failure does not reproduce on rerun, or the same test fails on the clean tree | Survived, labelled `FLAKY-KILL` |

**In the incident, the flaky kill category swallowed real information in both rounds.**

- In round one, seven mutants fell into the third row but were scored as the first. Their single killer was the intermittently failing test, so the score said nothing about the code under test.
- In round two, the control (unmutated) run itself failed, which is the loudest signal that a suite cannot be trusted. Three mutants passed cleanly: a readiness guard on a control target, a 5-second freshness window passed to a state reader, and a change that read account rate limits for the active runtime instead of hard-coding one runtime. No assertion noticed those changes, so those lines had never really been covered. An earlier review note had reported all three as killed.

**The lesson is about attribution.** "Was it killed?" is a yes/no question. "Which test killed it?" is the question that makes the yes/no answer checkable. A kill attributed to a test that fails without the mutant is evidence of nothing. A kill attributed to a test that was green on every clean run and red on every mutant run, and that covers the mutated code, is evidence.

## Why a flaky kill is worse than a survivor

**A survivor is a visible work item; a flaky kill is an invisible reassurance.** Both are errors in the mutation report, but they push the reader in opposite directions.

1. **It inflates the score and ends the investigation.** A survivor prompts someone to write an assertion. A kill prompts nobody to do anything, so a fake kill removes a to-do item that should exist.
2. **It repeats itself.** One noisy test fails on whatever mutants it happens to overlap with, so unrelated mutants share one killer. Seven kills by one test is a smell, but only if the report lists the killer.
3. **It propagates through summaries.** A note ("13/13 killed") gets cited by the next reviewer, the pull request description, or an automated agent that treats the previous round as ground truth. A false positive in a report becomes a premise.
4. **It is one-sided.** A spuriously failing test can only turn "all pass" into "some fail", so it can only make mutants look more detected (inference from the mechanism).
5. **It erodes trust in the real kills.** Google's testing team put the human side plainly: "It is human nature to ignore alarms when there is a history of false signals coming from a system" (Micco, 2016). Once readers learn that kills can be fake, they discount the real ones too.

The reverse error also exists. Shi et al. show that a test with nondeterministic coverage may not execute the mutated line on some runs, so a mutant can look "survived" for that run, or look "killed" by a test that never reached the mutated code. Their rule: a failing test that does not cover the mutant should not be credited with the kill.

## What the research says

**Flakiness is common, its causes are mostly mundane, and shared state is one of the top causes.**

- **Luo et al., FSE 2014**, "An Empirical Analysis of Flaky Tests", studied commits that fixed flaky tests in Apache projects. The three largest categories were async wait (74 of 161 classified commits, 45%), concurrency, and test order dependency (19 commits, 12%). Of the order-dependent tests, 47% were caused by dependence on external resources, and 74% were fixed by cleaning shared state. They also warn that rerunning has limits: "When the probability for a flaky test to change its outcome is low, rerunning it a few times may not be enough to manifest that it can change the outcome."
- **Gyori, Shi, Hariri and Marinov, ISSTA 2015**, "Reliable Testing: Detecting State-Polluting Tests to Prevent Test Dependency", describe dependencies that arise when tests read and write "some shared resource, e.g., the heap state in the main memory, file system, database, etc." Their tool PolDet flags tests that modify shared heap or file-system locations; on 26 projects (6,105 tests) it reported 324 polluting tests, of which the authors judged 194 relevant.
- **Lam et al., ICST 2019**, "iDFlakies", built a dataset of 422 flaky tests, 50.5% of them order-dependent. Such tests can "deterministically pass or fail depending on the order in which the tests are run" because of "some resource shared between the tests (e.g., the state in the main memory or on the file system)".
- **Gruber et al., ICST 2021**, studied 22,352 Python projects. Order dependency caused 59% of the 7,571 flaky tests found, and "a 95% confidence that a passing test case is not flaky on average would require 170 reruns."
- **Google** reported in 2016 that about 1.5% of all test runs were flaky, almost 16% of tests had some flakiness, and about 84% of observed pass-to-fail transitions involved a flaky test (Micco). In 2017, weekly flake rates were 0.5% for small tests, 1.6% for medium and 14% for large (Listfield). These are Google-specific figures, quoted only for scale. Google's mitigation was rerunning and marking known-flaky tests so they fail only after three consecutive failures, which Micco says "reduces false positives, but encourages developers to ignore flakiness".

**The mutation-specific literature is smaller, and it agrees on the point.**

- **Shi, Bell and Marinov, ISSTA 2019**, "Mitigating the Effects of Flaky Tests on Mutation Testing": "Traditional mutation testing implicitly assumes that test behavior is deterministic while rerunning the same tests on different mutants." Mutation scores varied by four percentage points on average between repeated executions, and 9% of mutant-test pairs had an unknown status. They modified PIT to record whether each test actually executes the mutated bytecode, to rerun a test that should have covered a mutant but did not (up to 16 times), and to escalate isolation between reruns. That cut "unknown" mutants by 79.4% across 30 projects. Two cautions. Their "unknown" status is mainly about nondeterministic coverage, a close cousin of the outcome flakiness in the incident rather than the same defect. And extreme isolation is costly: one JVM per mutant-test pair was about 52 times slower per pair than one per mutation unit.
- **Alshammari, Ammann, Hilton and Bell, ICST 2024 (Mutation workshop)**, "A Study of Flaky Failure De-Duplication to Identify Unreliably Killed Mutants", ask this article's question directly: "When a flaky test 'kills' a mutant, does it reliably kill it, or does it only incidentally kill it due to flakiness?" Across 22 Java projects, 19% of the mutants killed by flaky tests result from flakiness introduced by at least one test. De-duplicating failures approximates the number of reliably killed mutants with far less computation than rerunning each test for each mutant.
- **Cordy et al., 2019**, "FlakiMe", seeded controlled flakiness into suites and found that a 5% rate of flaky failures is enough to affect the mutation score, with a modest effect size (2% to 4%). (Inference: the aggregate can move a little while individual mutants flip, so per-mutant attribution matters more than the headline percentage.)

Rerunning is an established mitigation and it is imperfect; what you rerun and what you compare matter more than the raw count.

## What Node's test runner isolates, and what it does not

**Process isolation protects in-memory state. It does not protect anything the operating system shares between processes.**

The Node.js documentation (v24) states that with process-level isolation, "each matching test file is executed in a separate child process", up to `--test-concurrency` at a time. With isolation disabled, tests can modify each other's global state. In isolation mode, "all other Node.js options from command line arguments, environment variables, and configuration files are inherited by the child processes."

From these facts I infer the following (operating-system behaviour and my reproduction below, not a Node.js statement):

- A directory path derived from the inherited environment (a home or config directory, a temp prefix) is the same in every child unless a test overrides it.
- All children see the same file system, so two files writing the same path race. Ports, sockets, lock files and fixed log paths are shared the same way.
- Which child finishes first depends on scheduling, load and `--test-concurrency`. That is how "the full suite passed" can coexist with "the three-file combination fails one run in five": the full suite may order or space the files differently.

**A toy reproduction (not the original project).** To check that this mechanism behaves as described, I wrote two tiny test files on Node v24.22.1. Each reads and writes `config.json` under a directory taken from an environment variable that is created once per run. One file writes `single`, the other writes `multi`; each sleeps a random 0 to 20 ms and then asserts it reads back what it wrote. I ran `node --test` over both files:

| Setup | Failing runs |
|---|---|
| Shared directory, files run in parallel (default) | 30 of 50 in the first batch; 20 of 30 in a second batch |
| Shared directory, `--test-concurrency=1` (files run one after another) | 0 of 30 |
| Each file creates its own directory with `fs.mkdtempSync` | 0 of 50 |

The failure rate in the toy is far higher than the roughly one in five of the real case because I made the overlap window large on purpose; it shows the mechanism, not the rate. Two takeaways. Running the files serially hides the symptom but leaves the bug, so a green serial run is not evidence of isolation. And giving each file its own `mkdtemp` directory, which creates "a unique temporary directory" (Node `fs` documentation), removes the failure by removing the sharing.

Node also provides tools for finding this class of problem. `--test-randomize` randomises the order of test files and tests within a file "to help detect order-dependent tests", prints the seed it used, and `--test-random-seed=<n>` replays that order. The docs mark it "Stability: 1.0 - Early development" and "Added in: v24.16.0", so check your Node version. `--test-rerun-failures` is a poor fit for kill confirmation: it persists run state and only runs tests that have not yet passed, and the docs say to use it when tests run in a deterministic order. For confirmation, rerun the relevant files from scratch.

## How mutation tools treat the baseline

**Every tool I checked insists on a passing baseline. None of the documentation I read describes repeating it, or confirming kills.** That is a statement about the documentation and, for StrykerJS, the dry-run source file, not a full audit of every code path.

| Tool | Baseline | What the docs say about timeouts and states | Flake handling I found |
|---|---|---|---|
| PIT (pitest) | Suite must be green under PIT's own runner. The FAQ lists causes when "PIT says the suite isn't green", including "The tests have a hidden order dependency that is not revealed during the normal test run" | Timed Out is its own outcome, from `normal time * x + y`. The FAQ admits PIT can be "thinking an infinite loop has occurred, but being wrong" and suggests raising `--timeoutConst` | None in the FAQ; the ISSTA 2019 work above was a research modification of PIT |
| StrykerJS | An initial dry run without mutants; the source throws a `ConfigError` ("There were failed tests in the initial test run.") when any test fails | Timeout counts as Detected; Runtime error is Invalid. `dryRunTimeoutMinutes` bounds the initial run; `timeoutMS` and `timeoutFactor` bound mutant runs | One dry run. With `coverageAnalysis: "perTest"` the docs state "Your tests should be able to run independently of each other and in random order" |
| cargo-mutants | Builds and tests the unmutated tree in a temporary directory first, "to make sure that your tests are in fact all passing" | Default test timeout is 5 times the baseline test time, minimum 20 seconds | A single baseline. The docs warn that with `--baseline=skip` and failing tests, "cargo-mutants will probably report that all or most mutations were caught, but the test failures were not because of the mutations" |
| Cosmic Ray | A `baseline` command runs the suite on unmutated code and reports "Baseline failed" with the errors | Not checked | A pattern catalogue shows a filesystem-dependent flaky test where both mutants are reported killed by baseline-style failures, yet one of them survives when the test is run cleanly |
| mutmut | Collects stats by running the suite, then forks one worker per mutant | Timeout per mutant is calculated as `(duration_of_original_tests + timeout_constant) * timeout_multiplier` seconds, listed under "Unstable configs" | None in the documentation I read |

Three observations.

1. **The cargo-mutants warning describes the incident's failure mode.** If the baseline is wrong, failures get attributed to mutations. These guards catch a baseline that is red once; none catch a baseline that is green once and red one run in five. The Cosmic Ray pattern catalogue shows the same trap: a test that ignores "the interaction with the filesystem" gets mutants reported killed through "unrelated failures".
2. **Timeouts are another door for false kills.** Stryker classes Timeout as Detected, and PIT's FAQ admits timeouts can be wrongly flagged when run order or load changes timing. Running many mutants in parallel on a busy machine invites exactly that. PIT at least reports Timed Out separately from Killed.
3. **Test selection assumes independence.** Stryker's `perTest` mode and PIT's per-mutant test choice are only sound when tests do not depend on one another. Shared mutable state breaks that quietly.

## A hardened mutation protocol

**The protocol has four parts: gate on a repeated green control, confirm every kill, attribute every kill to a named test, and remove shared state.** The reviewer in the incident used the first three; the fourth is the root-cause fix.

### 1. Gate on a repeated control

Run the unmutated suite N times (the reviewer used N=3) under exactly the invocation you will use for mutants: same files, same concurrency, same environment. Require every run to be green before testing any mutant. If any run fails, stop, and treat the failing test as a defect to fix or quarantine, not as a result.

This catches flakes that fire often. It does not catch rare ones, and the arithmetic is unforgiving. Assuming runs are independent (an assumption; real flakes often cluster by load), a test with per-run flake probability p slips through n clean controls with probability (1 - p)^n:

| Per-run flake rate p | n = 3 | n = 10 | n = 20 |
|---|---|---|---|
| 20% (the incident) | 48.8% detected | 89.3% detected | 98.8% detected |
| 5% | 14.3% detected | 40.1% detected | 64.2% detected |

For the incident's rate, three control runs of the three-file combination catch the flake about half the time. Gruber et al.'s figure of about 170 reruns for 95% confidence on a single test is far beyond what anyone will spend on a whole suite per mutation round. That is why the later steps exist.

### 2. Confirm every kill by reproducing the same failing test

For each mutant that appears killed, rerun the mutated tree and require that the same new failing test fails again. If it does not reproduce, mark the mutant `FLAKY-KILL` and count it as survived. Counting it as survived is deliberate: the conservative error costs a reviewer a few minutes, while the opposite error hides a gap.

Compare test identity (file plus test name), not just "something failed". A different test failing on the rerun is a sign of a flaky suite, not a reproduced kill.

### 3. Attribute every kill to a named test, and sanity-check the killer on the clean tree

Record, for each mutant, the test or tests whose failure caused the kill. This makes three checks possible:

- **Spot a repeat offender.** If one test "kills" many unrelated mutants, check it against the clean tree first. In the incident, seven mutants had one killer.
- **Check the killer alone, on the clean tree, many times.** A rerun of the mutant only shows that the failure repeats under the mutant. Running the named killer repeatedly on the unmutated tree, with the same invocation shape, tests the claim that it is not flaky. The arithmetic above applies: 5 runs catch a 20% flake about two times in three, 10 runs about nine times in ten. Running only the killer is far cheaper than running the full suite.
- **Does the killer reach the mutated code?** Shi et al. require that a test cover the mutated code before it is credited. A cheap approximation (my suggestion, not a tool feature) is to read the failure message: a freshness-window mutant "killed" by an assertion about a config value is suspicious on its face. The 2024 de-duplication study builds on a related idea, that failures already seen on clean runs identify flaky failures.

### 4. Remove shared state; do not rely on detection alone

Detection reduces the risk; isolation removes it. For Node.js test files:

- Give every file its own temporary root with `fs.mkdtemp`, and derive config, data and cache paths from it. Do not read a "home" or "config" directory from the environment inside a test unless the test sets it first.
- Set environment variables inside the test or a per-file helper, and restore them. Use ephemeral ports and avoid fixed lock and log paths.
- Run the suite periodically with `--test-randomize` and different seeds and `--test-concurrency` values to find hidden coupling before a mutation round does.
- Treat "passes serially" as a diagnostic, not as proof. The toy reproduction above passes serially every time and still contains the bug.

### The confirm-kill logic in code

This sketch implements steps 1 to 3. `runSuite(tree, only)` is whatever your harness uses to run the tests against `'clean'` or a named mutant (optionally only certain tests) and return the set of failing test ids, such as `file::test name`. I ran this against mock runners to check that it returns `KILLED` for a stable kill, `FLAKY-KILL` for a failure that does not reproduce, `FLAKY-KILL` for a killer that also fails on the clean tree, and `SURVIVED` when nothing fails.

```js
async function gateControl(runSuite, n = 3) {
  for (let i = 0; i < n; i++) {
    const { failed } = await runSuite('clean');
    if (failed.size) throw new Error(`control ${i + 1}/${n} failed: ${[...failed]}`);
  }
}

async function judge(mutant, { runSuite, reruns = 1, cleanRepeats = 5 }) {
  const first = await runSuite(mutant);          // control is known green,
  if (!first.failed.size) return { verdict: 'SURVIVED' }; // so any failure is new

  let stable = new Set(first.failed);            // the SAME test must fail again
  for (let i = 0; i < reruns; i++) {
    const again = await runSuite(mutant);
    stable = new Set([...stable].filter((t) => again.failed.has(t)));
  }
  for (const t of [...stable]) {                 // killer must stay green when unmutated
    for (let i = 0; i < cleanRepeats; i++) {
      if ((await runSuite('clean', [t])).failed.has(t)) { stable.delete(t); break; }
    }
  }
  return stable.size
    ? { verdict: 'KILLED', killedBy: [...stable] }
    : { verdict: 'FLAKY-KILL', countsAs: 'SURVIVED', sawFailing: [...first.failed] };
}
```

Two details matter. Clean-tree reruns of a killer must use the same invocation shape as the mutant run (the same files in parallel), because an overlap-only flake passes serially. And the report should keep `killedBy` and `sawFailing`, not just the verdict, so the next reader can audit it.

## A checklist for reviewers and agents

Use this when you run a mutation round or read someone else's report. An agent that writes "13/13 killed" without these items has made a claim, not provided evidence.

- [ ] The control ran at least 3 times with the same invocation and concurrency as the mutant runs, all green, and the report says so (with runner version and concurrency).
- [ ] Test files do not share a mutable directory, environment-derived path, fixed port or lock file; if they do, that is fixed or recorded as a known risk first.
- [ ] Every mutant has one verdict: `KILLED`, `SURVIVED`, `FLAKY-KILL` (scored as survived), or a separate timeout or crash label. A timeout is not silently a kill.
- [ ] Every `KILLED` names its killing test(s), the same test failed again on rerun, and the killer ran several times green on the unmutated tree.
- [ ] The killer's failure message is plausibly about the mutated behaviour, and no single test kills a suspiciously large share of mutants without having been checked.
- [ ] Survivors are listed with the missing assertion, not just counted; after a fix, the mutant was rerun and the new killer confirmed the same way.
- [ ] Any earlier "killed" claim you build on was re-verified, not copied.

## Limitations

**This protocol makes false kills rarer; it does not make them impossible.**

- **Rare flakes slip through.** A test that fails one run in a hundred will usually pass three controls and one rerun. The arithmetic assumes independent runs; real flakes cluster with load, so back-to-back repeats may all pass or all fail together. More repeats on the specific killer, at a different time and load, help.
- **A reproduced kill can still be a deterministic confound.** A failure that repeats on every mutant run could come from the mutant run's environment (a leftover file from the previous mutant, a stale build). The clean-tree check reduces this and resetting state between mutants removes it. Shi et al. discuss "mutant-order dependencies" of this kind.
- **Rerunning costs time.** Mutation testing is already slow; Shi et al. note it is "typically not performed as part of the continuous integration process". Overhead is bounded: the control is a fixed cost, only kills need confirmation, and the clean-tree check runs only the named killer. For large suites, the de-duplication approach of the 2024 study is a cheaper approximation, which I have not evaluated.
- **Survivors need triage.** Equivalent mutants (changes that do not alter behaviour) also survive, and counting `FLAKY-KILL` as survived adds to the pile a human must read. That is the right trade, but it costs review time.
- **Flakiness can also hide kills.** A test with nondeterministic coverage can miss a mutated line on some runs. Shi et al. require coverage of the mutated code; the sketch above does not implement that.
- **Evidence limits.** Tool claims come from documentation and, for Stryker, one source file; I did not audit every code path, and behaviour changes between versions. The toy reproduction shows a mechanism on one machine and one Node version, not a rate. The incident's numbers (one in five, seven mutants, three survivors, 13 mutants) are from the reviewer's account and were not re-measured.

## References

All links below were opened and read while preparing this article, except where noted.

**Flaky tests**

- Luo, Hariri, Eloussi, Marinov. "An Empirical Analysis of Flaky Tests." FSE 2014. PDF (author-hosted copy): https://huang.isis.vanderbilt.edu/cs8395/paper/flakytest.pdf
- Gyori, Shi, Hariri, Marinov. "Reliable Testing: Detecting State-Polluting Tests to Prevent Test Dependency." ISSTA 2015. https://mir.cs.illinois.edu/gyori/pubs/issta15pollution.pdf
- Lam, Oei, Shi, Marinov, Xie. "iDFlakies: A Framework for Detecting and Partially Classifying Flaky Tests." ICST 2019. https://mir.cs.illinois.edu/winglam/publications/2019/LamETAL19iDFlakies.pdf
- Gruber, Lukasczyk, Kroiß, Fraser. "An Empirical Study of Flaky Tests in Python." ICST 2021. https://icst2021.icmc.usp.br/details/icst-2021-papers/15/An-Empirical-Study-of-Flaky-Tests-in-Python
- Micco. "Flaky Tests at Google and How We Mitigate Them." Google Testing Blog, 27 May 2016. https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html
- Listfield. "Where do our flaky tests come from?" Google Testing Blog, 17 April 2017. https://testing.googleblog.com/2017/04/where-do-our-flaky-tests-come-from.html

**Flaky tests and mutation testing**

- Shi, Bell, Marinov. "Mitigating the Effects of Flaky Tests on Mutation Testing." ISSTA 2019. Program page: https://conf.researchr.org/details/issta-2019/issta-2019-Technical-Papers/9/Mitigating-the-Effects-of-Flaky-Tests-on-Mutation-Testing ; paper PDF: https://mir.cs.illinois.edu/marinov/publications/ShiETAL19FlakyMutation.pdf
- Alshammari, Ammann, Hilton, Bell. "A Study of Flaky Failure De-Duplication to Identify Unreliably Killed Mutants." Mutation 2024 (ICST workshop). https://conf.researchr.org/details/icst-2024/mutation-2024-papers/5/A-Study-of-Flaky-Failure-De-Duplication-to-Identify-Unreliably-Killed-Mutants (abstract read; full paper not read)
- Cordy, Rwemalika, Papadakis, Harman. "FlakiMe: Laboratory-Controlled Test Flakiness Impact Assessment." arXiv 2019. https://arxiv.org/abs/1912.03197 (abstract read; full paper not read)
- "Mutant killed due to flaky test." Mutation Testing in Patterns (Cosmic Ray example). https://mutation-testing-patterns.readthedocs.io/en/latest/python/example_02/README.html

**Mutation tool documentation**

- PIT FAQ: https://pitest.org/faq/ and basic concepts: https://pitest.org/quickstart/basic_concepts/
- StrykerJS mutant states and metrics: https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/
- StrykerJS configuration: https://stryker-mutator.io/docs/stryker-js/configuration/
- StrykerJS dry-run executor source: https://github.com/stryker-mutator/stryker-js/blob/master/packages/core/src/process/3-dry-run-executor.ts
- cargo-mutants baseline tests: https://mutants.rs/baseline.html and hangs and timeouts: https://mutants.rs/timeouts.html
- Cosmic Ray CLI (baseline command): https://github.com/sixty-north/cosmic-ray/blob/master/src/cosmic_ray/cli.py
- mutmut documentation: https://mutmut.readthedocs.io/en/latest/

**Node.js**

- Node.js test runner (v24): https://nodejs.org/docs/latest-v24.x/api/test.html
- Node.js `fs.mkdtemp` (v24): https://nodejs.org/docs/latest-v24.x/api/fs.html
