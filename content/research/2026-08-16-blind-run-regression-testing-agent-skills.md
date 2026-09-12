---
date: "2026-08-16"
title: "Blind-Run Regression Testing for Agent Skills: Treating Prompt Artifacts as Testable Software"
description: "A practical testing proposal for agent skills: separate execution from author context, validate evaluators, distinguish regression cases from held-out evidence, and investigate failures before rewriting rules."
tags: ["agent-skills", "prompt-testing", "regression-testing", "llm-as-judge", "eval-contamination", "style-fidelity", "calibration", "ai-agents"]
---

## Executive Summary

A skill file can read clearly and still fail when an agent executes it. Testing should therefore preserve the artifact's version, run representative tasks, inspect the resulting outputs and actions, and rerun earlier cases after edits. This article proposes a workflow for doing that, especially for process instructions and writing preferences.

Clean execution contexts and with/without comparisons help examine what a skill contributes. They do not, by themselves, establish a causal effect or generalization. A failed test also does not identify whether the instructions, execution, environment, or evaluator caused the failure. Keep development and regression scores separate from results on material withheld from skill development.

## What a Blind Run Can Test

Here, a blind run means an executor receives the skill and legitimate task inputs without the author's development conversation or the evaluator's answer key. Check the actual context supplied by the runtime: a child agent that inherits the parent's conversation is not automatically a clean executor. Reset files, caches, permissions, and tool state where they affect the comparison, and document anything that cannot be reset.

The public [Agent Skills evaluation guide](https://agentskills.io/skill-creation/evaluating-skills) describes separate contexts, with-skill and baseline runs, saved outputs, and evidence-backed grading. It also records duration and tokens, and cautions that variation statistics need repeated runs. These are useful harness ingredients; the guide's current contents are not evidence of a particular historical product release.

For a controlled comparison, record the skill revision, model identifier, sampling settings, system instructions, input fixtures, tools, and starting state. Compare the new skill with both its previous version and a no-skill baseline where useful. Repeat stochastic runs and report their distribution. An observed difference in a single pair is a result for that pair; isolating a skill's causal contribution requires controlling competing changes and accounting for variability.

A human-approved output can be a reference for a writing task, but need not be the only valid answer. State which properties are binding: factual content, audience, required action, tone, or format. Exact text equality may reject equally acceptable writing. Conversely, matching a few phrases can pass an output that misrepresents the facts.

## Validate the Evaluator Before Editing the Skill

The [Agent Skills guide's pattern-analysis section](https://agentskills.io/skill-creation/evaluating-skills#analyzing-patterns) asks evaluators to investigate assertions that fail in both conditions. That observation does not prove the assertion is broken. For example, a required attachment can be missing both without a skill and with an incomplete skill; the requirement remains valid.

Our proposed diagnostic procedure is:

- Test the evaluator on independently accepted outputs and known violations. A known-good output should pass; a deliberately invalid output should fail. Review the examples themselves before trusting this check.
- Check whether the task is feasible with the supplied inputs and tools. Distinguish a missing fixture or unavailable permission from faulty instructions.
- Read the execution trace and the resulting artifact together. A plan to create a file is not the file; a completed action is not necessarily a correct result.
- Keep important regression invariants even when both configurations pass them. Report skill uplift separately so those checks do not inflate a claim about added value.

Use scripts for precisely encoded properties such as schema validity or a required filename. General factual entailment and stylistic fidelity may still need semantic judgment. For subjective comparisons, hide version labels, vary presentation order, allow ties, and retain human review of disagreements. This is a proposed bias-control protocol, not a claim that pairwise judging always outperforms every absolute rubric.

## Calibration Cases Remain Regression Cases

The following split is a proposed harness policy, intended to prevent development success from being presented as independent validation:

| Case role | May inform skill edits? | May be scored? | What the score supports |
|---|---|---|---|
| Development/calibration | Yes | Yes | Progress on known examples |
| Historical regression | Yes, with changes recorded | Yes, after each relevant edit | Preservation of previously required behavior |
| Sealed holdout | No, until explicitly promoted | Yes | Performance on material withheld from this development process |

A correction learned from a real task should become a regression case. Excluding it from every scoring run would hide future regressions. Instead, exclude it from the holdout/generalization metric. When a holdout failure is inspected to design a repair, record its promotion into development and replenish the holdout with independent material before claiming fresh validation. Keep prior results attached to the revision and split that produced them.

Synthetic cases can explore a rule in a different setting, but a case written by the skill author may reproduce the same assumptions or accidentally reveal the desired answer. Label its provenance and do not treat a changed topic as proof of independence. A development/holdout gap is a reason to investigate distribution differences and overfitting; it is not a measurement of memorization by itself. Pretraining-contamination percentages from unrelated benchmarks cannot supply an expected inflation rate for this workflow.

## Failure Triage Is a Hypothesis, Not a Probability Table

[SkillAxe §3.3](https://arxiv.org/html/2606.10546v1#S3.SS3) separates adherence from instruction quality: an agent can ignore sound guidance, or faithfully execute weak guidance. Its wrong-shade-of-yellow example distinguishes a missing precise color specification from failure to obey an explicit color value. That is narrower than a complete taxonomy of every harness failure.

Building on that distinction, we propose four investigation branches: the skill, the executor, the evaluator, and the runtime/environment. These branches can overlap. Their number supplies no failure frequencies and no probability that editing the skill is the wrong response.

For a missing instruction, propose a rule change. For apparent noncompliance, inspect whether the instruction was actually available, applicable, and compatible with higher-priority constraints. For an evaluator defect, repair the grading contract and rerun its known-good and known-bad examples. For environmental drift, compare recorded versions and starting state. Moving or strengthening a rule is still a skill intervention and needs regression checks; it is not a way to avoid changing the artifact.

[REFLECT §3](https://arxiv.org/html/2606.09071v1#S3) provides a more specific diagnostic model: preserve the original execution prefix, apply a diagnosis-targeted repair, and verify the continuation. Its faithfulness gate checks whether replay follows that repair. A successful intervention supports sufficiency under the verification assumptions, not uniqueness or minimality. [Appendix R](https://arxiv.org/html/2606.09071v1#A18) limits replay in irreversible environments and notes multiple independent errors.

Applied here, a repair that does not change the outcome has not validated the hypothesis. It does not necessarily falsify it: the repair may be ineffective, ignored, or masked by another failure. Even a successful retry needs inspection for unrelated recovery or stochastic variation. Use resettable test environments; do not replay production side effects merely to obtain a diagnostic signal.

## Rule Compliance and Writing Fidelity Are Different Outcomes

[Catch Me If You Can? Not Yet](https://arxiv.org/html/2509.14543v1) studies selected models on four English datasets spanning email, blogs, news, and forums, with examples and generated writing from the same genre. Exemplars improve some measures, but nuanced personalization remains difficult and gains from additional demonstrations are limited in the tested settings. The paper notes that computational authorship measures do not fully capture human perceptions, and it does not include large-scale human evaluation.

That evidence supports measuring fidelity separately from explicit-rule compliance. It does not establish a permanent ceiling, prove that implicit preferences can never be articulated, or show that more examples are the only effective intervention. For a particular writing skill, changes to examples, rules, prompting, or models remain hypotheses to test on withheld material. Style embeddings and authorship classifiers are fallible instruments; a high similarity score is not a substitute for the intended reader's judgment.

## Start Small, Keep the Claim Small

A useful initial smoke test is one known reference case and one new scenario, followed by a targeted edit and rerun. In the development anecdote motivating this article, two such cases exposed apparent voice-rule gaps, and the patched rerun was judged improved. That is local development evidence. It does not establish stable convergence, prove the proposed attribution, or demonstrate that removing author context caused the discovery. Those stronger claims would require an explicit context comparison, repeated runs, and fresh post-patch cases.

For a reusable harness, store the case's provenance and split, output artifacts, trace, evaluator revision, and result together. Make invocation behavior a separate check from output quality: explicitly forcing a skill into a test says little about whether the runtime selects it appropriately. Record resource use alongside quality, and calibrate any release threshold to the consequences of failure rather than adopting a universal pass percentage.

As rules accumulate, use historical regression cases to look for interactions and add cases for newly identified conflicts. Test the judge against its own reference outputs when its prompt or model changes. These are practical safeguards, not claims that no existing tool offers them or that rerunning old cases is the only available defense. Release evidence should say which cases and conditions passed, which remained uncertain, and which material was still independent of development.
