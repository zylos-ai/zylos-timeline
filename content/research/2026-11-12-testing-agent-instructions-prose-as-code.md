---
date: "2026-11-12"
time: "09:00"
title: "Testing the Instructions You Give Agents"
description: "When a Markdown procedure is the agent's behavior, a green unit suite is weak evidence. A layered approach covering clause assertions, keyword negative checks, structural checks, judges, mutation review and sandboxed real-model acceptance, and which layer catches which failure."
tags: ["research", "testing", "prompts", "agents", "evals", "mutation-testing", "reliability"]
---

## Executive Summary

When an agent reads a Markdown file at runtime and acts on it, that file is the program. Editing it changes behavior, and prose has no compiler, type checker or obvious diff semantics. Cheap tests (regexes over the text) are necessary but weak. In our project they caught deleted clauses, but they missed three whole classes of failure:

1. **A withdrawn behavior re-introduced in new words.** Our negative checks matched four literal words, so edits like "ask once and wait for agreement" passed.
2. **Ambiguous placeholders.** A `<page>` placeholder led real workers to write wrong `--path` values.
3. **Missing links.** A doc that did not link the page-format spec led a worker to write an invalid status value, which would have silently dropped the page from an index.

The last two were found only by running real models in a sandbox.

The conclusion is a layered stack, each layer cheap enough to run at its natural frequency:

- **Always (milliseconds):** required-clause assertions, keyword negative assertions (a lexical heuristic, not a check of meaning), and structural checks (links resolve, placeholders are defined, examples parse).
- **On review (minutes):** a deliberate round of "mutants", meaning small prose edits that should make the suite fail. A surviving mutant is a candidate gap. It becomes a new test once you have established that it changes behavior in a way that matters, and equivalent survivors go on a watch list instead.
- **Only when a change can alter the agent's behavior (dollars):** real-model acceptance in a throwaway sandbox, triggered by changes to agent-facing text or to the loader, model, tools or harness that execute it. It uses fixed scenario fixtures and asserts on tool calls and the final state, with a hard cost cap and re-runs scoped to the scenarios the change can affect.

Hash pins on generated templates are a blunt fifth tool. They work as a "someone edited this" alarm but not as a behavior test.

## 1. Why instruction text is code

Three properties make agent-facing prose behave like code, and in some ways worse.

**It is executed.** A model reads the procedure on each run and turns it into tool calls. A changed sentence changes those calls. Anthropic's guidance on agent evals makes the same point from the other side: "When we evaluate 'an agent,' we're evaluating the harness and the model working together" ([Anthropic, Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)). The doc is part of the harness.

**Its semantics are fuzzy and sensitive.** There is direct evidence that wording alone can move results a lot. Sclar et al. found accuracy differences of up to 76 points across semantically equivalent prompt formats on one open model, and sensitivity persisted with larger models, more few-shot examples and instruction tuning ([Sclar et al., ICLR 2024](https://arxiv.org/abs/2310.11324)). PromptRobust, an arXiv technical report (v5; versions 1-4 were titled PromptBench), applied adversarial attacks to task prompts at character, word, sentence and semantic levels, designed to keep the prompts' meaning, and reported that "contemporary LLMs are not robust to adversarial prompts" ([Zhu et al., arXiv 2306.04528v5](https://arxiv.org/abs/2306.04528v5)). Both studies measured benchmark tasks, not procedure files. They justify caution, not a specific effect size for your document.

**Review is hard.** A diff that removes "never" or adds "unless the owner agrees" looks like a style edit. Reviewers read the new sentence, not the behaviors it permits. A withdrawn behavior can come back in a paraphrase and no line-level diff tool will flag it.

Our own case shows this. A procedure for reorganizing the agent's memory lives in Markdown that a background worker reads. Over several revisions we withdrew some behaviors: asking the owner for agreement before proceeding, treating recently updated sections as "in progress", and reading only a single session's state. The unit tests stayed green while reviewers kept finding that these behaviors could be written back in.

## 2. The layers of tests

### 2.1 Literal and required-clause assertions

The simplest test asserts that an important sentence or phrase is present, usually with a regex. This is the "deleted clause" detector, and it is good at that. If a reviewer deletes the line that tells the worker to run a validation step, the test fails.

Where it falls short:

- It tests the presence of text, not the behavior the text produces.
- It rewards keeping a sentence even when a later sentence contradicts it.
- It pushes toward over-literal patterns that freeze wording (see Pitfalls).

Write required-clause patterns around the *invariant*: the command name, the flag, the ordering constraint. Do not pin the surrounding prose.

### 2.2 Negative (forbidden-behavior) assertions: literal words vs. concept keywords

Negative checks say the doc must not instruct behavior X. The difference between matching a few literal words and matching a keyword list for the whole concept was the biggest lesson in our project. Both are lexical: they look for strings, not meaning.

Our first version matched four literal words. Reviewers' mutants that *deleted* required clauses were caught by the positive tests. Mutants that *re-introduced* withdrawn behavior survived, each one using different words:

| Re-introduced behavior | Mutant wording (generic) | Literal check | Concept keyword pattern |
|---|---|---|---|
| Owner gate | "ask the owner once and wait for agreement" | passes (no banned word) | `consent\|agree\|declin\|wait for (the )?owner` |
| Recency heuristic | "treat sections updated in the last 30 days as in progress" | passes | `30 days\|in progress\|progress page` |
| Single-session scope | "read only one session's state" | passes | patterns for scope-narrowing words around "session" |
| Manual checklist | "work through this checklist before each step" | passes | `checklist` |

The fix was to widen each negative pattern to the *concept's* vocabulary: stems (`agree`, `declin`) and the distinctive numbers or nouns (`30 days`, `checklist`, `progress page`), not only the exact phrase that was first removed. That caught the mutants reviewers had found. It does not make the check semantic. A paraphrase that avoids every listed keyword still passes, and an allowed sentence that uses one still fails. Running the owner-gate pattern above on two sentences shows both:

| Sentence | Should the check fail? | Owner-gate pattern |
|---|---|---|
| "obtain the operator's go-ahead before continuing" | Yes (reworded owner gate) | No match, so it passes |
| "proceed without a request for owner consent" | No (it forbids the gate) | Matches `consent`, so it fails |

Promptfoo documents the same primitive: every assertion type can be negated by prepending `not-` (for example `not-regex`, `not-contains`) ([promptfoo, assertions](https://www.promptfoo.dev/docs/configuration/expected-outputs/)). The tooling is there. The work is choosing keyword lists that cover the paraphrases you expect, knowing they cannot track meaning. Questions of meaning belong to a judge (section 2.5) or a real-model run (section 2.6).

Concept keyword checks also cost false positives. A pattern like `agree` also matches "disagree" and "agreed-upon format". Keep paraphrase controls in pairs with allowed sentences that contain the same words: a reworded withdrawn behavior the check must reject, next to a legitimate sentence using the same keyword that must still pass. A paraphrase the list cannot catch without banning allowed text is recorded as a known miss, not claimed as coverage. The pairs show the next editor where the boundary is.

### 2.3 Snapshot and hash pins

A pin stores a hash (or a golden copy) of a generated system template, and the test fails when the bytes change.

What it buys: any unreviewed edit is detected, including edits made by a generator, a merge, or an automated formatter.

What it costs:

- **Every legitimate edit must update the pin.** The test says "changed", not "changed wrongly".
- **Parallel PRs conflict on the pin.** Two branches each touching the same template both edit the same pin line, so the second to merge always conflicts, even when their text edits do not overlap.
- **It carries no information about behavior.** A reviewer who sees a pin update has to review the template diff anyway.

Use pins sparingly, as a tripwire on templates that should rarely change. If you keep them, make the pin update a separate, trivially mergeable file or a generated artifact, so the conflict can be resolved by regenerating.

### 2.4 Structural checks

These checks treat the doc as a program with references, and they are cheap and deterministic:

- **Links resolve.** Every relative link and file path in the doc exists. The missing page-format link in our case would have been caught by a rule such as "any doc that tells the worker to create a page must link the page-format spec".
- **Placeholders are resolved.** A placeholder such as `<page>` is either defined next to its use, or replaced by a concrete worked example. Our workers filled `<page>` with plausible but wrong paths.
- **Examples are copy-pasteable.** Extract each fenced command, substitute documented values, and run it with `--help`, a dry-run flag or a parser, so a wrong flag fails in CI and not in a worker.
- **Enumerations match the spec.** If the doc lists allowed values (a Status field, for instance), compare the list to the schema the indexer uses.
- **No destructive commands in examples** unless the procedure requires them. Two workers in our run created probe pages and removed them with `rm`. A structural rule such as "the doc names a sanctioned cleanup path and does not show a bare `rm`" is a cheap guard once someone has seen the failure.

Several of these rules came from real-model failures, which is the usual route. Structural checks are mostly lessons from earlier acceptance runs, encoded so they run for free.

### 2.5 LLM-as-judge checks of prose

A judge model reads the doc, or a transcript, and grades it against a rubric. Promptfoo offers `llm-rubric` for this, and DeepEval's `GEval` scores outputs against criteria written in plain language, using chain-of-thought and weighted token probabilities ([promptfoo](https://www.promptfoo.dev/docs/configuration/expected-outputs/), [DeepEval G-Eval](https://deepeval.com/docs/metrics-llm-evals)).

Judges help for questions a regex cannot answer, such as "does this section tell a reader to wait for approval before acting?" That is exactly the re-introduced-behavior question. Caveats, taken from the tools' own documentation and from Anthropic's guidance:

- Model graders are flexible but non-deterministic, cost more, and need calibration against human judgment ([Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)).
- DeepEval notes that scores can vary between runs when you supply only `criteria`, because the evaluation steps are regenerated each time. Fixing `evaluation_steps` and adding a rubric make results more stable ([DeepEval](https://deepeval.com/docs/metrics-llm-evals)).
- Anthropic recommends giving the judge an escape hatch ("Unknown") and using one judge per rubric dimension ([Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)).

A judge over prose is a *review aid*, not a gate. It should flag, and a person decides. A judge that gates merges needs its own regression test.

### 2.6 Real-model behavioral acceptance in sandboxes

This is the only layer that tests what the doc *does*. The shape that worked for us:

- **Scenario fixtures.** A small fixed workspace (seed pages, a seed state file) in a throwaway sandbox that is deleted after each trial.
- **Real worker, real doc.** The same model and harness used in production reads the real procedure file.
- **Assertions on tool calls and end state.** Check the arguments of the commands the worker ran (`--path` values, status values), and the resulting files. Anthropic distinguishes the *transcript* (every tool call and intermediate result) from the *outcome* (the final state of the environment), and advises that "it's often better to grade what the agent produced, not the path it took" ([Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)). Promptfoo supports tool-call and trajectory assertions such as `trajectory:tool-args-match` and `trajectory:tool-used` ([promptfoo](https://www.promptfoo.dev/docs/configuration/expected-outputs/)). A hand-rolled harness can do the same with a transcript parser.
- **Isolation per trial.** Anthropic's guidance is that each trial start from a clean environment, since leftover files and shared state cause correlated failures or inflated scores ([Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)).
- **Multiple trials for variance.** Outputs vary between runs. Anthropic defines pass@k (at least one success in k tries) and pass^k (all k succeed), and pass^k is the one to watch when reliability matters.
- **Cost cap.** Set a hard per-run token or dollar limit and abort on breach.

In our runs this layer found both real failures: the wrong `--path` values (the `<page>` placeholder) and the invalid Status value (the missing spec link). It also exposed the `rm` clean-up habit. None of these would fail a regex.

A caution on grading: read the transcripts. A failed trial can be a grader rejecting a valid path, and Anthropic's closing advice is "Read the transcripts!"

## 3. Mutation testing applied to prompts and docs

**What the literature says.** Mutation testing introduces small deliberate faults ("mutants") into a program and checks whether the test suite fails. A surviving mutant that changes behavior (a non-equivalent one) is a gap in the tests. The standard survey is Jia and Harman's [An Analysis and Survey of the Development of Mutation Testing](https://dblp.org/rec/journals/tse/JiaH11.html) (IEEE TSE, 2011). At Google, an analysis of almost 15 million mutants found that developers who saw mutants wrote more tests, and that mutants were coupled with real faults ([Petrović et al., ICSE 2021](https://arxiv.org/abs/2103.07189)). A related line of work argues that coverage alone is a weak proxy for suite quality: [Inozemtseva and Holmes (ICSE 2014)](https://dl.acm.org/doi/10.1145/2568225.2568271) found that once suite size is controlled for, the correlation between coverage and effectiveness is typically low to moderate. The prose analogue is that "the doc contains these sentences" is like line coverage. It says nothing about whether the suite notices a *wrong* sentence.

**What exists for prompts.** The most relevant preprint I could verify is AgentAssay ([Bhardwaj, arXiv 2603.02601](https://arxiv.org/abs/2603.02601)). Its abstract lists agent-specific mutation-testing operators, metamorphic relations, and statistical (PASS/FAIL/INCONCLUSIVE) regression verdicts for agent changes in prompts, tools, models or orchestration. It is a single-author preprint, and I could verify only the abstract, not the specific operator definitions. Treat it as an early signal, not an established method.

PromptRobust ([Zhu et al., arXiv 2306.04528v5](https://arxiv.org/abs/2306.04528v5)) perturbs instructions at character, word, sentence and semantic levels. Its purpose is measuring *model* robustness to prompt variation, not test-suite adequacy. Its four levels are still a useful vocabulary for the kinds of mutants worth trying.

I found no established, widely used tool that does classical mutation testing of Markdown procedure files. Promptfoo, DeepEval and OpenAI Evals ([repo](https://github.com/openai/evals)) provide assertions, graders and registries, not a mutate-and-check loop.

**A manual protocol that worked.** This is our practice, not a published method:

1. Take a doc that has green tests.
2. Produce mutants of three kinds: *delete* a required clause; *weaken* it ("must" to "may"); *re-introduce* a withdrawn behavior in different words.
3. Run the suite. A mutant that stays green is a candidate gap, not yet a missing test.
4. Establish whether the mutant changes behavior in a way that matters: does it permit a withdrawn behavior or drop a required step? Decide from the text, and from a real-model run when the text leaves it unclear. If it does, add a test for the *concept*, not the mutant's exact words, then re-run. If it does not, it is equivalent and goes on the watch list below.

Deletion and weakening mutants are usually caught. The re-introduction kind is the one that survives, because the test author wrote negative patterns from memory of the original wording. An LLM can generate such paraphrased mutants cheaply. That is my suggestion, and I did not find a source for it in this setting.

**The equivalent-mutant problem carries over.** In code, some mutants do not change behavior, and deciding that is hard (the survey above covers it). For prose, a paraphrase may or may not change what a model does. A mutant that survives the *static* suite and the *real-model* run is probably equivalent for that model. It may not be for the next one, so keep these mutants as a small "watch list".

## 4. Practical playbook

### Which layer catches which failure

| Failure class | Example | Literal clause | Keyword negative | Hash pin | Structural | LLM judge | Real-model run |
|---|---|---|---|---|---|---|---|
| Required clause deleted | Validation step removed | Catches | - | Catches | - | Maybe | Maybe |
| Withdrawn behavior, same words | "ask the owner" returns | - | Catches | Catches | - | Catches | Maybe |
| Withdrawn behavior, new words | "wait for agreement" | - | Only if the new words contain a listed keyword | Catches | - | Catches | Maybe |
| Any unreviewed edit to a template | Generator drift | - | - | Catches | - | - | - |
| Broken link / missing spec | Format spec not linked | - | - | - | Catches | Maybe | Catches |
| Ambiguous placeholder | `<page>` filled wrongly | - | - | - | Partly (flag unresolved placeholders) | Maybe | Catches |
| Invalid enumerated value | Bad Status, page dropped from index | - | - | - | Catches if the spec is parseable | - | Catches |
| Unsafe habit | Probe pages removed with `rm` | - | Partly | - | Partly | Maybe | Catches |
| Instructions interact badly with a model | Ordering confusion | - | - | - | - | - | Only this |

"Maybe" means the layer can catch it with a good rubric or scenario but does not reliably do so. The keyword-negative cells are conditional: a rewording outside the keyword list passes (section 2.2). Read the table as: no single column covers the rows, and the last two rows depend on the real-model layer.

### Keeping costs down

- **Trigger on behavior-affecting changes, not on schedule.** Run real-model acceptance when a change touches agent-facing text (procedure files, skill docs, generated system templates), and also when it changes what executes that text in a way that can invalidate a procedure's behavior: the loader that decides which docs reach the model, the model or its version, tool definitions or tool behavior, or the harness. The agent under test is the model and harness together (section 1), so an unchanged doc can behave differently, or stop being loaded at all, after such a change. A path filter in CI covers text-only changes; extend it to the loader, tool and harness paths and to the model setting. Re-run only the scenarios that exercise what changed. PRs that touch none of these skip it.
- **Narrow re-runs.** After a fix, re-run only the scenario that failed, plus one smoke scenario, not the full set. Anthropic suggests starting small: "20-50 simple tasks drawn from real failures is a great start."
- **Turn every real-model finding into a free test.** Missing link becomes a structural check. Wrong placeholder becomes a "no unresolved placeholders" check. Bare `rm` becomes a negative pattern. Over time the expensive layer finds fewer new classes.
- **Cheap model for smoke, production model for sign-off.** Wording sensitivity varies by model ([Sclar et al.](https://arxiv.org/abs/2310.11324)), so the sign-off must use the model you ship.
- **Cap and abort.** A hard cost limit per run, and a timeout per scenario.
- **Few trials, chosen by risk.** One trial for smoke. Several for the scenarios where silent failure is expensive (the dropped-page case).

### Suggested order of work for a new procedure file

1. Write 5-10 required-clause assertions on invariants only.
2. Write keyword negative patterns for every behavior you have ever withdrawn, covering the concept's vocabulary, each with paired controls: a reworded withdrawn behavior and an allowed sentence using the same words.
3. Add structural checks: links, placeholders, example commands.
4. Mutate once by hand (or with a model) and close the gaps that change behavior.
5. Run real-model acceptance on two or three fixtures. Read the transcripts. Convert findings into layers 1-3.

## 5. Pitfalls

- **Over-literal tests freeze wording.** If an assertion needs the exact sentence, every clarity edit fails the build and people stop improving the doc. Assert the invariant (command, flag, order), not the phrase.
- **Regexes so broad they ban legitimate words.** `agree` also matches "disagree", and `progress` matches "progress report" in an unrelated section. Scope patterns to the section where the behavior would live, and keep an allowlist test.
- **Negative patterns that check only the original wording.** This was our failure. Widen them to the concept's vocabulary, revisit them whenever a reviewer finds a new paraphrase, and remember that a keyword list still misses paraphrases outside it.
- **Hash pins as merge-conflict magnets.** Two PRs touching one template collide on one pin. Prefer targeted assertions, and if you keep pins, make them regenerable.
- **Treating a green unit suite as evidence the prose works.** Our suite was green when workers were writing wrong paths and invalid status values. Static tests check the text, and only real-model runs check the behavior.
- **LLM judges as silent gates.** They are non-deterministic and drift with the judge model. Use them to raise flags for a person.
- **Grading the path instead of the outcome.** Requiring exact tool-call order makes acceptance tests brittle, because agents find valid routes the test author did not foresee. Assert on state and on dangerous calls, not on a script.
- **Shared state between trials.** Leftover files make failures correlated and passes meaningless. Use a fresh sandbox each time.
- **Declaring victory after one run.** Single trials hide variance. For the high-stakes scenarios, repeat.

## Conclusion

Treat agent-facing prose as a program that happens to be written in English. Test it in layers: cheap and literal for invariants, keyword lists for forbidden behavior (lexical, so paired with controls), structural for references, a judge for second opinions, and real-model sandboxes for what the text actually causes. Use mutants to find holes in the cheap layers, and keep the expensive layer narrow, triggered by changes that can alter behavior: the agent-facing text, or the loader, model, tools and harness that run it, with re-runs scoped to the affected scenarios. The most reliable improvement we made was a habit: every failure found by a real run becomes a new static test.

## Sources

- Anthropic, [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents): grader types, transcript vs. outcome, pass@k and pass^k, isolation, starting small.
- Anthropic, [Define success criteria and build evaluations](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests): specific, measurable criteria and task-specific evals.
- promptfoo, [Assertions and metrics](https://www.promptfoo.dev/docs/configuration/expected-outputs/): deterministic, model-graded and trajectory assertions, and the `not-` negation prefix.
- DeepEval, [G-Eval](https://deepeval.com/docs/metrics-llm-evals): LLM-judged criteria, evaluation steps, run-to-run variance.
- OpenAI, [openai/evals](https://github.com/openai/evals): eval framework and registry. The repo points to the dashboard-based Evals product.
- Zhu et al., [PromptRobust: Towards Evaluating the Robustness of Large Language Models on Adversarial Prompts](https://arxiv.org/abs/2306.04528v5), arXiv 2306.04528v5, technical report (v5, July 2024; v1-v4 were titled "PromptBench: ..."): adversarial prompt attacks at character, word, sentence and semantic levels.
- Sclar et al., [Quantifying Language Models' Sensitivity to Spurious Features in Prompt Design, arXiv 2310.11324](https://arxiv.org/abs/2310.11324).
- Jia and Harman, [An Analysis and Survey of the Development of Mutation Testing](https://dblp.org/rec/journals/tse/JiaH11.html), IEEE TSE 2011.
- Petrović, Ivanković, Fraser and Just, [Does mutation testing improve testing practices?](https://arxiv.org/abs/2103.07189), ICSE 2021.
- Inozemtseva and Holmes, [Coverage is not strongly correlated with test suite effectiveness](https://dl.acm.org/doi/10.1145/2568225.2568271), ICSE 2014.
- Bhardwaj, [AgentAssay, arXiv 2603.02601](https://arxiv.org/abs/2603.02601): preprint, abstract only verified.
