---
date: "2026-11-20"
time: "09:00"
title: "Did the Config Change Work? Judging Short Operational Trials on Noisy Daily Metrics for AI Agent Fleets"
description: "A practical guide to deciding, after about seven days, whether cost-saving settings in a long-running agent system really worked, using normalization, small-sample designs, pre-declared decision rules and quality guardrails."
tags: ["research", "experimentation", "agent-operations", "cost-optimization", "time-series", "switchback", "guardrails"]
---

## Executive Summary

An operator of a long-running, multi-session LLM agent system changes three settings to cut cost: a lower context-rotation threshold, less frequent background memory summarization, and a shorter idle-session reclaim timeout. Seven days later the daily bill is lower. Did the changes work?

Usually the honest first answer is "we do not know yet." Daily agent cost is driven by workload (one large review can double a day), other changes land mid-trial, and some days may not have run the intended configuration. A before/after comparison of daily totals mixes the settings' effect with all of that.

This article collects methods from clinical epidemiology, online experimentation and marketplace operations that fit this small-data situation. In short: measure cost per unit of work and by component; estimate normal noise before judging the trial; write the decision rule, guardrails and contaminated-day policy down before looking; prefer designs with a built-in comparison; and treat "inconclusive, extend or alternate" as a legitimate outcome.

This is a methods proposal. It does not report results from any specific system, and every number in the worked example is illustrative.

## Why Before/After Daily Totals Mislead

Campbell and Stanley's classic treatment of [experimental and quasi-experimental designs](https://academicweb.nd.edu/~rwilliam/ndonly/readings/Methods/01-Experimentation/Campbell_Stanley-Experimental_and_Quasi-Experimental_Designs_for_Research_1963.pdf) lists the standard threats to internal validity, including history and statistical regression. A one-week trial is exposed to several at once. Summaries of the interrupted-time-series literature note that for simple designs the main threat is history, meaning other forces that changed the outcome around the time the intervention was introduced ([Shadish, Cook and Campbell, ITS chapter](https://www.academicpeds.org/wp-content/uploads/gravity_forms/66-cffe81f82d0c22a20931a4634aea2e41/2023/03/Shadish-Cook-Cambell_2002_-ITS_Designs_OCR.pdf)).

For an agent fleet, the threats look like this:

- **Workload variation.** Cost scales with messages handled, tool calls, review rounds and context size. A quiet week looks like a successful trial. A week with a large review looks like a failure. Neither says much about the settings.
- **Regression to the mean.** Trials are often started because cost just spiked. [Barnett, van der Pols and Dobson](https://academic.oup.com/ije/article/34/1/215/638743) describe regression to the mean as a phenomenon that can make natural variation in repeated data look like real change: unusually large measurements tend to be followed by measurements closer to the mean. If the "before" window ends on a record-high day, the following days are likely lower with or without any change. The effect is larger when measurements are noisy.
- **Novelty and transition effects.** The first days after a change can behave differently from steady state. Lowering a rotation threshold, for example, may trigger a one-time wave of rotations. The ITS tutorial by [Lopez Bernal, Cummins and Gasparrini](https://pmc.ncbi.nlm.nih.gov/articles/PMC5407170/) says the implementation period should be well defined so it can be considered separately. Online-experiment guidance says to run at least one full weekly cycle and check for drift ([Kohavi, Tang and Xu](https://experimentguide.com/wp-content/uploads/TrustworthyOnlineControlledExperiments_PracticalGuideToABTesting_Chapter1.pdf), summarized in a [GrowthBook write-up](https://www.growthbook.io/blog/lessons-learned-from-ronny-kohavi-and-luke-sonnet-running-trustworthy-experiments)).
- **Concurrent changes and contamination.** A model upgrade or new scheduled job landing on day four is indistinguishable from the settings under test. A setting that silently did not take effect for half a day means "the treatment" was not one thing.

## Normalize First: Cost per Unit of Work

The first fix is to change the metric. Choose the unit of work that the system exists to produce and divide cost by it. Candidates, from finest to coarsest:

- cost per message handled,
- cost per completed task,
- cost per review round or per merged change.

Per-message cost penalizes a setting that reduces the turns needed; per-task cost needs a reliable definition of "task." Pick one primary unit before the trial and report one backup.

Cost is also not purely proportional to work. A fleet has a floor of background activity (idle sessions, scheduled summarization) that exists even on a quiet day. A simple model is `cost = fixed + rate × work`. If you have 14 or more days of history, you can fit this line and ask whether trial days sit above or below it. That is a one-variable regression adjustment, and it removes most of the workload noise without any more machinery.

## Decompose Cost Where Each Setting Acts

Total spend hides which setting did what. Break it into components that map to the subsystems under test.

LLM providers price token classes differently, so the split is natural. Anthropic's [prompt caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) states that cache writes cost 1.25 times the base input price for the default 5-minute lifetime and 2 times for the 1-hour lifetime, while cache reads cost 0.1 times the base input price, with a lower multiplier on some models. It also says the default cache lifetime is 5 minutes, refreshed at no extra charge each time the cached content is used. Check the pricing table for your own model before relying on these multipliers.

Those mechanics suggest where each setting should show up:

| Setting | Where the effect should appear | A component that should not move |
|---|---|---|
| Lower context-rotation threshold | Cache-read tokens per turn (shorter contexts), plus a cache-write bump at each rotation | Background summarization output |
| Less frequent background memory summarization | Tokens and spend attributed to the summarization subsystem | Foreground output tokens per message |
| Shorter idle-reclaim timeout | Idle-session count; cache writes when a reclaimed session is resumed after the cache lifetime has expired | Per-turn output tokens |

The right-hand column matters as much as the middle one. A component the setting should not affect works as a **negative control**: the ITS tutorial recommends a control outcome "which would not have been affected by the intervention." If foreground output tokens per message drop too, something other than your settings changed.

Attribute spend to subsystems at logging time; a shared meter cannot be decomposed after the fact.

## Estimate Noise Before Judging the Signal

Before reading the trial, measure how much the chosen metric moves when nothing changes. Online-experiment practitioners call this an A/A test, and [Kohavi's guidance](https://www.growthbook.io/blog/lessons-learned-from-ronny-kohavi-and-luke-sonnet-running-trustworthy-experiments) lists it among the top recommendations for checking that a pipeline does not manufacture false differences. For a fleet with no second copy, a cheap version is retrospective: take the last 14 to 28 days of the normalized metric and see how large a difference between two arbitrary 7-day windows tends to be.

Suppose, illustratively, the daily cost per message has a standard deviation of 12% of its mean. The standard error of the difference between two 7-day means is about 12% × √(2/7) ≈ 6.4% if days are independent. A difference needs to be roughly twice that, about 13%, to stand out. A real 5% saving would be invisible. This assumes independent days; positive autocorrelation makes it worse, so check it as the ITS tutorial advises.

If the settings are expected to save 5% combined, a 7-day before/after cannot confirm it. Knowing that in advance tells you to extend the trial or change the design.

## Designs That Work With Tiny n

### Interrupted time series (segmented regression)

Interrupted time series (ITS) uses many repeated observations before and after a clearly dated change. The standard segmented model, as corrected in the [2020 corrigendum](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7750921/), is `Y = β0 + β1·T + β2·X + β3·(T − T0)·X`, where β1 is the pre-change trend, β2 the level change and β3 the slope change.

Practical points from the tutorial:

- There is no fixed minimum number of points, but power rises with more of them; with few points the authors advise power simulation first.
- Specify the impact model (immediate level change, delayed, slope change) in advance; choosing it after seeing the data risks finding a chance effect.
- Check residual autocorrelation and seasonality; for a daily agent metric, day-of-week is the obvious seasonal term.
- ITS cannot by itself rule out co-interventions. The tutorial suggests a control series, staggered start times, or withdrawing the intervention to see if the effect reverses.

With about 7 days on each side, a full slope-and-level model is fragile. A defensible small-n version fits only a level change, adjusts for work volume and weekday, and reports a wide interval; this is the article's suggestion, not a published threshold.

### Switchback and alternating-day designs

When you control the setting, you can randomize it over time instead of changing it once. [DoorDash's engineering team](https://careersatdoordash.com/blog/switchback-tests-and-randomized-experimentation-under-network-effects-at-doordash/) describes switchback tests that randomize time-region units because ordinary user-level A/B tests are ineffective under network effects. [Lyft's engineers](https://eng.lyft.com/using-marketplace-marginal-values-to-address-interference-bias-a11aff6e670f) make a similar point: in a time-split experiment all units are exposed to one treatment at a time, which helps prevent interference. Lyft's earlier [introduction to marketplace experimentation](https://eng.lyft.com/experimentation-in-a-ridesharing-marketplace-b39db027a66e) discusses the trade-off against bucketing.

Three lessons transfer to a fleet trial:

1. **Alternate settings by day (or by multi-day block), in randomized order, and compare within the same window.** Interleaving means a drifting baseline or mid-trial launch affects both arms; a baseline-versus-trial comparison lacks that property.
2. **Carryover is the cost.** DoorDash notes that [switchback cannot capture learning effects](https://careersatdoordash.com/blog/balancing-network-effects-learning-effects-and-power-in-experiments/). In a fleet, long-lived sessions, caches and memory carry state across day boundaries. Use two-day blocks and discard the first day of each as a washout, or accept a blended effect. Do not flip daily on slow settings such as the reclaim timeout.
3. **Analyze at the level you randomized.** DoorDash reports that failing to account for correlation within time windows [inflates false positives](https://careersatdoordash.com/blog/cluster-robust-standard-error-in-switchback-experiments/). The fleet analogue: if days are the randomized unit, compare days, not thousands of messages pooled across them; messages in one day share workload.

With 7 days split 4/3, there are only 35 possible assignments, so even a perfectly consistent effect cannot produce a randomization-test p-value below about 0.03. Fourteen days split 7/7 gives 3,432 assignments. This shows how little a week can distinguish.

### Staggered rollout for several simultaneous changes

Changing three settings at once confounds them; if shipped together, the honest claim is about the bundle. For attribution, stagger the changes by a few days each (a multiple-baseline design in the ITS tutorial) and judge each on its own component.

## Pre-Declare the Decision Rule and Guardrails

[Nosek and colleagues](https://pubmed.ncbi.nlm.nih.gov/29531091/) argue that preregistration separates analyses and outcomes that result from predictions from those that result from postdictions. For an operator, the practical version is a short note written before the trial ends, with:

- the primary metric, its unit of work, and the baseline window,
- the minimum effect worth keeping (for example, "at least 5% lower cost per message"),
- the model or test, and how uncertainty will be reported,
- the guardrail metrics and the margin each may move,
- the rules for contaminated days,
- the three verdicts: keep, revert, or inconclusive (extend or alternate).

Anything analyzed afterward is labeled exploratory and cannot carry the verdict.

## Contaminated Days: Exclude or Intention-to-Treat, and Say Which

Suppose a setting did not take effect for half of day 3 because of a stale config. Two standard options exist.

- **Intention-to-treat (ITT):** analyze days as assigned, whatever actually happened. In clinical trials this means analyzing participants in the groups they were randomized to, ignoring protocol deviations, which preserves the balance randomization created ([LITFL overview](https://litfl.com/intention-to-treat-analysis/), [PMC review](https://pmc.ncbi.nlm.nih.gov/articles/PMC10718629/)). It answers: "what happens if we roll this out, imperfect deployment included?"
- **Per-protocol (exclude contaminated days):** keep only days where the setting verifiably applied. It answers: "what does the setting do when it works?" It risks bias if the reasons for contamination are related to the outcome.

Trial-analysis sources also note that ITT dilutes treatment effects, making it anti-conservative for harm outcomes. For guardrails, a diluted estimate can hide a real quality regression. A workable policy:

1. Decide contamination by cause and evidence, never by whether the cost looked odd. Use a recorded config-effective timestamp, not the bill.
2. State the primary analysis in advance, and report the other as a sensitivity check.
3. For guardrails, look at the verified-clean days too.
4. If the two analyses disagree on the verdict, the answer is inconclusive.

## Guardrails: Why "Cost Went Down" Is Not Success

A cheaper fleet that does worse work is not an improvement. In [Kohavi's taxonomy](https://www.goodreads.com/book/show/51635906-trustworthy-online-controlled-experiments), guardrails sit beside the goal metric and protect the business or the validity of the experiment. For the three example settings:

- **Reclaim timeout:** the rate at which a reclaimed session is reopened within a short window; a high rate means sessions were not really idle. Also track takeover overhead, meaning the tokens and seconds spent rebuilding context on resume, and latency to first useful response after resumption. A shorter timeout can cut idle costs while raising resume costs; measure the net.
- **Rotation threshold:** task completion rate, review rework (extra rounds), and signs of lost context such as repeated questions or re-reading the same files.
- **Summarization frequency:** memory freshness, such as how often a session starts without a fact an earlier session recorded.
- **All settings:** error rate and p95 response time.

Keep the list short, since each added metric adds a chance that one moves by luck. Give each a margin, and decide in advance that crossing it means revert or investigate regardless of cost.

## A Worked Example (Illustrative Numbers)

All numbers below are made up to show the mechanics.

| Window | Messages handled | Total cost (units) | Cost per message |
|---|---|---|---|
| Baseline, 7 days | 720 | 376 | 0.522 |
| Trial, 7 days | 560 | 331 | 0.591 |

The raw total fell by 12% (376 to 331), which looks like success. But volume fell by 22% (720 to 560), so cost per message rose by about 13%: the "saving" is workload. Reading that rise as a regression would also be premature, since with the earlier illustrative 12% daily noise a 13% difference is near the edge of what 7-day windows can distinguish. The verdict under a pre-declared rule would likely be "inconclusive." The decomposition then shows where to look, for example whether cache-write spend after rotations explains the increase while the summarization component fell as intended.

## A Seven-Day Trial Checklist

Before the trial:

1. Write the primary metric, unit of work and minimum worthwhile effect.
2. Pull 14 to 28 days of history; compute normal day-to-day noise and the smallest effect a 7-day window can detect.
3. Avoid starting right after an unusual day; if you must, use a longer baseline.
4. Set up a cost breakdown by subsystem and token class, and name at least one negative-control component.
5. Choose 3 to 5 guardrails with margins.
6. Define the effective-time evidence for each setting and the rules for contaminated days (primary analysis plus sensitivity).
7. Decide the design: before/after only as a last resort; prefer alternating blocks, staggered changes or a control series.
8. Record known concurrent changes and launch no others during the window.

During the trial:

9. Log when each setting actually took effect, and flag days where it did not; do not adjust thresholds mid-trial.

After the trial:

10. Compute the primary metric with work-volume adjustment and an uncertainty interval.
11. Check negative-control and guardrail metrics, and compare primary and sensitivity analyses.
12. Apply the declared rule and state one of three verdicts.

The verdict is **inconclusive** when any of these hold: the interval includes both "no change" and your minimum worthwhile effect; the estimate is smaller than the measured noise; primary and sensitivity analyses disagree; a guardrail is near its margin with a wide interval; or a concurrent change overlaps the window. The next step is to extend to a second weekly cycle, or to switch to alternating blocks so every later day has a concurrent comparison. A stated "inconclusive" beats a confident reading of noise.

## Validation Scope and Sources

I read the Anthropic prompt caching documentation, the ITS tutorial and the abstract of the Barnett et al. paper. Automated retrieval of the DoorDash and Lyft posts was blocked, so claims attributed to them are limited to what their published descriptions state. Statements on A/A tests, novelty and guardrails rest on secondary summaries of the Kohavi book and a practitioner write-up. Cache multipliers can change; verify against the current pricing page. The worked example, noise figures and small-n recommendations are illustrative or the author's own suggestions.

- Anthropic, [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- Lopez Bernal, Cummins, Gasparrini, [Interrupted time series regression for the evaluation of public health interventions: a tutorial](https://pmc.ncbi.nlm.nih.gov/articles/PMC5407170/) (Int J Epidemiol, 2017) and its [2020 corrigendum](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7750921/)
- Barnett, van der Pols, Dobson, [Regression to the mean: what it is and how to deal with it](https://academic.oup.com/ije/article/34/1/215/638743) (Int J Epidemiol, 2005)
- Campbell and Stanley, [Experimental and Quasi-Experimental Designs for Research](https://academicweb.nd.edu/~rwilliam/ndonly/readings/Methods/01-Experimentation/Campbell_Stanley-Experimental_and_Quasi-Experimental_Designs_for_Research_1963.pdf); Shadish, Cook, Campbell, [Interrupted time-series designs chapter](https://www.academicpeds.org/wp-content/uploads/gravity_forms/66-cffe81f82d0c22a20931a4634aea2e41/2023/03/Shadish-Cook-Cambell_2002_-ITS_Designs_OCR.pdf)
- DoorDash Engineering: [Switchback tests and randomized experimentation under network effects](https://careersatdoordash.com/blog/switchback-tests-and-randomized-experimentation-under-network-effects-at-doordash/); [Cluster robust standard error in switchback experiments](https://careersatdoordash.com/blog/cluster-robust-standard-error-in-switchback-experiments/); [Balancing network effects, learning effects, and power](https://careersatdoordash.com/blog/balancing-network-effects-learning-effects-and-power-in-experiments/)
- Lyft Engineering: [Experimentation in a ridesharing marketplace](https://eng.lyft.com/experimentation-in-a-ridesharing-marketplace-b39db027a66e); [Using marketplace marginal values to address interference bias](https://eng.lyft.com/using-marketplace-marginal-values-to-address-interference-bias-a11aff6e670f)
- Kohavi, Tang, Xu, [Trustworthy Online Controlled Experiments](https://experimentguide.com/wp-content/uploads/TrustworthyOnlineControlledExperiments_PracticalGuideToABTesting_Chapter1.pdf); [GrowthBook summary of Kohavi's recommendations](https://www.growthbook.io/blog/lessons-learned-from-ronny-kohavi-and-luke-sonnet-running-trustworthy-experiments)
- Nosek, Ebersole, DeHaven, Mellor, [The preregistration revolution](https://pubmed.ncbi.nlm.nih.gov/29531091/) (PNAS, 2018)
- Intention-to-treat background: [LITFL](https://litfl.com/intention-to-treat-analysis/); [PMC10718629](https://pmc.ncbi.nlm.nih.gov/articles/PMC10718629/)
