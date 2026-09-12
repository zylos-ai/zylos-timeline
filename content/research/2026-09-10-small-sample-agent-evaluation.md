---
date: "2026-09-10"
time: "09:11"
title: "Small-Sample Agent Evaluation: Reliability, Pairing, and Stopping Rules"
description: "How to interpret a few agent trials without overstating reliability: repeated success, paired comparisons, and a holdout that survives prompt tuning."
tags:
  - research
  - agents
  - evaluation
  - statistics
  - reliability
---

## Executive Summary

A few successful agent runs establish that a workflow can work under those conditions. Stronger claims require separating repeatability on a case, performance across cases, and evidence that a new version improves on the old one. This article develops a bounded evaluation protocol using six primary sources, with worked calculations and explicit limits; its practical recommendations are a synthesis, not an empirically validated universal release standard.

## Start with the claim, then choose the trials

Consider an agent that updates a document from a user request. Define success before execution: the requested change appears, unrelated content survives, and the operation finishes within the product's time budget. A fluent completion message alone does not establish those outcomes.

Three questions require different evidence:

- **Capability:** Can it solve this case at least once with a specified attempt budget?
- **Repeatability:** How often does it solve this same case when run afresh?
- **Generalization:** How well does it handle requests drawn from the intended workload?

Ten repetitions of one document-editing request provide ten observations about that request. They provide one case's coverage of the workload. Record case IDs and run IDs separately so the report cannot quietly turn repetitions into additional coverage.

A useful trial specification fixes the agent version, prompt, tool contracts, initial state, evaluator, and resource limits. Reset mutable state between independent trials. Retaining earlier output or replaying a cached final answer can change what is being measured. Ordinary prompt-prefix caching, which reuses computation while still sampling a fresh completion, does not by itself invalidate independence.

## At least one success versus every attempt succeeding

For one case with a stable success probability `p`, independent, identically distributed trials give two different quantities:

- `pass@k = 1 - (1 - p)^k`: at least one success among `k` attempts.
- `pass^k = p^k`: all `k` attempts succeed.

Chen and colleagues provide an unbiased estimator for pass@k from `n` generated samples, of which `c` pass: `1 - C(n-c,k)/C(n,k)`, for `n >= k`. Here `C(a,b)` means combinations, with value zero when `b > a`. Substituting the observed rate `c/n` directly into the population formula generally introduces finite-sample bias. [Evaluating Large Language Models Trained on Code, §2.1 and Appendix A](https://arxiv.org/html/2107.03374).

The τ-bench paper defines pass^k as consistent success across `k` independent trials and estimates it as `C(c,k)/C(n,k)`, averaged across tasks. With heterogeneous cases, that population average is `E[p_case^k]`, not `E[p_case]^k`. This is a consistency measure over repeated complete attempts, not a model of dependent steps inside one long workflow. [τ-bench, §3](https://arxiv.org/html/2406.12045v1).

**Worked example 1: the same observations, different questions.** Suppose five independent runs of one case produce two successes. For `k = 2`:

```text
Estimated pass@2 = 1 - C(3,2)/C(5,2) = 1 - 3/10 = 0.70
Estimated pass^2 = C(2,2)/C(5,2) = 1/10 = 0.10
```

These are estimates of future probabilities under the trial assumptions. They are also exact fractions among the ten unordered pairs in the observed five-run pool. Neither number is a confidence bound, and five runs can leave substantial uncertainty.

Product interpretation matters. A retrying system needs a way to identify a successful attempt and must tolerate preceding failures. Adaptive retries that retain feedback or side effects follow a different process from independent attempts. Evaluate that complete retry policy directly before applying a pass@k number to it.

## What zero failures actually establishes

Let `q` be the failure probability for a fixed case under stable conditions. With a fixed, predeclared sample size `n`, the probability of observing zero failures is `(1-q)^n`. Inverting that tail at `alpha = 0.05` gives the exact one-sided 95% upper bound:

```text
q_upper = 1 - 0.05^(1/n)
```

This is the zero-failure special case of exact binomial inference. If failures occur, use the general binomial-tail calculation instead. NIST documents exact intervals and explains why normal approximations can be inaccurate with small samples or few failures. [NIST Dataplot: Exact Binomial](https://www.itl.nist.gov/div898/software/dataplot/refman2/auxillar/exacbino.htm).

**Worked example 2: twenty clean runs.** The calculation gives `1 - 0.05^(1/20) = 0.1391`: a 13.91% upper failure bound. The corresponding lower success bound is 86.09%. Two clean runs give a success lower bound of only 22.36%.

For this particular design, an upper failure bound below 5% requires `n > log(0.05)/log(0.95) = 58.404`; therefore 59 preplanned trials, all successful, suffice. This is not permission to run until a streak of 59 appears. Nor is 59 a universal product sample size. These values are direct calculations from the displayed equation.

The confidence level describes repeated-sampling coverage of the procedure, not a 95% posterior probability assigned to this particular interval. A per-case interval also does not automatically provide simultaneous 95% coverage across many cases.

### Heterogeneity does not forbid a population average

An important distinction prevents overcorrecting the pooling problem. If each trial independently samples a fresh case from the same deployment distribution and then executes it, the resulting binary outcomes can be i.i.d. Bernoulli observations with a well-defined marginal success probability, even though case difficulties differ.

Repeating a small fixed panel of cases is a different design. Equal repeats estimate an equally weighted panel average; unequal repeats produce a run-weighted average. Neither automatically matches traffic weights. Conditional run noise, case-sampling uncertainty, and missing task categories are separate limitations. A narrow interval cannot repair an unrepresentative case selection.

For a release report, retain both a workload-oriented sample and explicitly labeled stress cases. A difficult diagnostic panel can reveal defects without estimating their production frequency. Choosing only cases where versions tend to disagree can aid debugging, but changes the population represented by the headline score.

## Compare versions on the same cases

A comparison should preserve which case produced each result. With one binary outcome per version on each independent sampled case, tabulate both-pass, both-fail, A-only-pass, and B-only-pass. Exact McNemar inference compares the discordant counts using a binomial test, avoiding its large-sample chi-square approximation. The test concerns equal marginal success probabilities; it does not establish that an improvement exceeds a product-relevant minimum. [statsmodels McNemar reference](https://www.statsmodels.org/dev/generated/statsmodels.stats.contingency_tables.mcnemar.html).

Pairing can improve precision when shared case difficulty creates positive correlation. It is not guaranteed to do so for every design. Randomize or interleave version order when time-varying services could confound the comparison, and give each version its own restored environment.

Repeated trials require another level of care. For case `i`, compute `d_i = success_rate_B_i - success_rate_A_i`. An equal-case comparison reports the mean of these differences. This preserves the intended case weighting even if a few cases receive extra diagnostic runs.

For inference across independently sampled cases, a practical approach is to resample whole case records, keeping both versions and their repetitions together, then recompute the mean difference. This paired cluster bootstrap is a design recommendation here, not an exact small-sample guarantee. With very few cases, bootstrap intervals can themselves be unstable; retain the case-level results and report the comparison as unresolved when warranted.

Do not count every repeated run as an independent new case for population inference. Conversely, a fixed benchmark panel and a random sample of future requests have different uncertainty targets. State which one the interval addresses rather than using one resampling recipe indiscriminately.

## Prompt tuning and early stopping are separate problems

**Adaptive reuse:** after inspecting failures, an engineer changes the prompt and evaluates on the same cases. Those cases now inform development. Dwork and colleagues show that adaptively reusing a holdout can cause overfitting to the holdout itself; their reusable-holdout method adds specific controls rather than treating ordinary reuse as harmless. [Generalization in Adaptive Data Analysis and Holdout Reuse](https://arxiv.org/abs/1506.02629).

For a small team, a simpler protocol is to keep development cases separate from a final untouched sample. Freeze the candidate version before that check. Once its outcomes guide another revision, treat the exposed cases as development evidence and reserve fresh confirmation data. Repeating old cases with new sampling randomness can test repeatability after a fix, but cannot restore their status as unseen cases.

**Optional stopping:** even with a frozen version, repeatedly calculating a fixed-sample interval and stopping when it clears a target can invalidate nominal coverage. A fixed trial budget avoids this problem. If early decisions matter enough to justify a sequential design, confidence sequences provide time-uniform coverage under their stated assumptions. They do not automatically correct prompt selection, biased case sampling, or an unreliable evaluator. [Time-uniform, Nonparametric, Nonasymptotic Confidence Sequences](https://arxiv.org/abs/1810.08240).

## A bounded release protocol

The following is proposed engineering guidance, scaled to the consequence of a wrong decision:

1. **Write the claim.** Name the workload, success condition, acceptable failure risk or minimum useful improvement, and what remains out of scope.
2. **Allocate the budget before the final check.** Specify independent cases, repeats per case, weighting, and stopping rule. Use pilot data for planning, not as an untouched release sample.
3. **Freeze and execute.** Pin the candidate and baseline, restore state, and retain every planned outcome. Record timeouts and harness faults under predeclared rules rather than silently replacing failures.
4. **Report coverage and uncertainty together.** Include case count, repeat count, case-level outcomes, paired effect estimates, and the assumptions behind any interval. Separate diagnostic stress results from workload estimates.
5. **Make a bounded decision.** A wide interval means insufficient evidence for the claim, not proof of equivalence. Investigate a failure, collect a preplanned additional independent sample, or narrow the deployment claim explicitly.

For the document-editing example, a release might require preservation checks to pass on the stress panel and a useful paired improvement on untouched representative requests. The actual threshold belongs to the product owner and failure cost. Record that decision beside the evidence so later readers can distinguish an observed result from accepted residual risk.

## Sources and scope

The six linked primary sources support metric definitions, exact binomial inference, paired binary testing, adaptive reuse, and sequential validity. Numerical examples are illustrative calculations, not measured agent performance. Case-selection and release-workflow recommendations are the author's synthesis; no small evaluation removes uncertainty about untested task types or changing production conditions.
