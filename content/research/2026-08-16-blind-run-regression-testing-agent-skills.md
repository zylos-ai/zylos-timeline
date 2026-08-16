---
date: "2026-08-16"
title: "Blind-Run Regression Testing for Agent Skills: Treating Prompt Artifacts as Testable Software"
description: "A skill file that reads well is not a skill that works. How blind subagent execution, held-out ground truth, generalization scenarios, and three-way failure triage turn codified agent workflows — SOPs, style guides, calibration logs — into artifacts you can actually regression-test."
tags: ["agent-skills", "prompt-testing", "regression-testing", "llm-as-judge", "eval-contamination", "style-fidelity", "calibration", "ai-agents"]
---

## Executive Summary

Agent "skills" — the SKILL.md files, cursor rules, AGENTS.md documents, and calibration logs that encode how an agent should perform a recurring task — are software. They have versions, they accumulate patches, they regress, and they interact with a runtime (the model) that changes underneath them. Yet almost everyone tests them the way nobody would test code: read it, decide it looks right, ship it.

The alternative has quietly converged into a recognizable pattern across 2026 tooling and research: **blind-run testing**. Give a fresh executor (a clean-context subagent) the skill plus neutral input material — never the answer key — and diff what it produces against ground truth: the outputs a human principal actually shipped. Run the same tasks with-skill and without-skill to isolate the skill's causal contribution. Add synthetic scenarios that share the *category* of a learned rule but not its content, to distinguish a rule that generalized from a rule that was memorized. When a run fails, triage three ways before touching anything — spec defect, executor non-compliance, or broken rubric — because each demands a structurally different fix.

This piece maps the current state of that practice: the tooling (promptfoo, DeepEval, OpenAI Evals, Anthropic's skill-creator), the methodology (golden sets, held-out corpora, contamination probes), the hard ceilings (LLMs still can't reproduce a person's *implicit* style, and judgment-heavy rules resist execution-contrast validation), and the open problems nobody has packaged yet — most notably, regression-testing an accumulated rule set against itself as it grows.

## The Problem: Skills Are Shipped Untested

A skill file occupies an odd position in the software stack. It is load-bearing — an agent following a ghostwriting skill sends messages under a human's name; an agent following a deploy skill touches production. But it is authored as prose, reviewed as prose, and "verified" by the author re-reading it. The review-versus-verification gap that software engineering closed decades ago with CI is wide open here.

The gap has a specific shape. A skill file distilled from real examples — say, a style guide extracted from the diff between an agent's drafts and what the human actually sent — *reads* correct almost by construction: it was written while looking at the evidence. What reading cannot tell you:

- whether a fresh executor, without the author's context, interprets the rules the way the author meant them;
- whether the rules cover the next case or only re-describe the last one;
- whether two rules added months apart now contradict each other;
- whether the underlying model, silently updated, still follows instructions it followed in March.

Anthropic's own taxonomy (from the March 2026 skill-creator update) splits skills into **capability-uplift** skills (teach the model something it can't reliably do) and **encoded-preference** skills (sequence existing capabilities according to a team's process or a person's taste). The second category — process SOPs, voice guides, calibration docs — is both the most common in practice and the hardest to test, because its correctness criterion lives in someone's head. That is precisely why it needs an external test: the author's re-read is the least reliable instrument available, since author and evaluator share the same blind spots.

## The Blind-Run Pattern

The emerging standard, documented independently by LangChain ("Evaluating Skills," March 2026), agentskills.io, and Anthropic's skill-creator, has four load-bearing properties:

**1. Clean-context execution.** Each test run starts a fresh subagent whose only inputs are the skill file and neutral task material. This ensures the run measures what the *skill text* communicates, not what the author's session context happens to contain. An author testing a skill inside their own session is contaminating the experiment with everything the skill was supposed to encode.

**2. Ground-truth diffing where ground truth exists.** For skills distilled from human behavior, the strongest available oracle is what the human actually did — the sent message, the merged commit, the approved document. The blind run's output is compared against it point-by-point along the dimensions the skill claims to govern. Where output is structured (files, JSON, commits), a mechanical diff beats an LLM judge; LangChain's harness diffs generated artifacts against expected ones and reserves model-graded evaluation for what scripts can't check.

**3. With/without contrast.** Run the same task with the skill and without it (and, on updates, with the previous version). This isolates the skill's causal effect from the model's baseline competence — a distinction that matters because a strong model passes many tests *without* the skill, and a test that passes in both conditions tells you nothing about the skill at all. The agentskills.io write-up makes the audit explicit: periodically hunt for assertions that always pass in both conditions (useless, score-inflating) and assertions that always fail in both (broken assertion, not a skill gap). SkillAudit (arXiv 2606.14239) formalizes the same idea as paired trajectory auditing: contrast the two runs to attribute behavioral differences to specific passages of the skill text.

**4. Generalization scenarios against answer leakage.** A skill distilled from examples and then tested on those same examples is the prompt-engineering version of train/test contamination — and the contamination literature says the effect size is real (5–15 points of score inflation across public benchmarks; ~40% of HumanEval flagged contaminated). The mitigation is structural, not disciplinary: hold out a slice of real examples that the skill's author (human or model) never saw, and generate *synthetic* scenarios that share a learned rule's category but not its content. If a rule was learned from editing one kind of message, test it on a structurally similar message about something else entirely. A skill that only passes on the examples it was distilled from has memorized, not generalized — and the "held-out gap" between the two scores is the measurable signature.

In our own practice, this pattern surfaced organically: after distilling a forwarding-message ghostwriting skill from real edit diffs, the principal's instruction was, in effect, *give a subagent basic material, have it write per the skill, check whether the output matches expectation, and adjust the skill until it works*. The blind runs — one against a case with ground truth, one against a fabricated scenario in a different domain — passed the structural rules but exposed three voice-level gaps the author's re-read had missed (over-anglicization of common words, embellished praise beyond the verified facts, a first-person-plural convention). All three were attributable to under-specified rules, not executor failure, and each became a new codified rule plus a calibration-log entry. One round of patch-and-rerun confirmed convergence. The notable part is not the specific gaps but the asymmetry: minutes of blind execution found what an author review could not, *because* the executor lacked the author's context.

## The Tooling Landscape

The generic prompt-testing layer is mature. **Promptfoo** (22k stars, 1.25M monthly downloads) is the de facto open-source harness: YAML-declared test matrices, assertion grading, CI integration that gates deploys on regressions. **DeepEval** positions itself as "pytest for LLM apps," with G-Eval as the standard LLM-as-judge pattern for criteria without a single ground truth. **OpenAI Evals** went agent-native in its 2026 revamp — multi-turn trace recording, separate grading for tool calls versus final answers, ten built-in grader types. **Braintrust** and **LangSmith** anchor the commercial eval-platform tier.

The skill-specific layer is younger but moving fast. Anthropic's skill-creator now bundles benchmark mode (pass rate, latency, token cost per test), multi-agent parallel evals with clean contexts, and blind A/B comparator agents judging skill versions against each other without knowing which is which. The agentskills.io methodology adds the operational discipline: an `evals/` directory per skill, every run producing outputs plus timing plus grading records, assertions written *after* observing first-round outputs (avoiding both vagueness and brittleness), and quoted evidence required for every PASS.

Two practices from this tooling deserve wider adoption. First, **cost is a test dimension**: a skill that improves quality 5% while tripling token spend is a different decision than a strict improvement, and harnesses that don't record tokens/duration can't surface the tradeoff. Second, **trigger testing is separate from output testing**: a skill that produces perfect output when invoked but fails to activate on the prompts that should trigger it (or activates on ones that shouldn't) fails in a way output evals never see.

## Checkable Rules and Judgment Rules Need Different Tests

The single most useful research finding for harness designers comes from SkillAudit's evaluation across 89 tasks: **what evolves well is governed by observability, not domain**. Skills encoding checkable content — APIs, formulas, formats, required sections, banned phrases — improved under automated evolution to ~80% task reward. Skills encoding judgment-heavy procedure with no mechanically observable trace plateaued around 69%.

The design consequence is to split every skill into two testing layers:

- **Checkable layer** → scripted assertions. Structure, ordering, presence/absence of required elements, forbidden vocabulary, format compliance, factual claims against source material. Scripts are deterministic, cheap, and — unlike judges — cannot be flattered into passing something. A Medium practitioner write-up ("test the artifacts, not the prose") pushes this to its limit with four assertion levels: trigger checks, execution-order trace checks, artifact freshness checks, and hard invariants ("never runs destructive commands").
- **Judgment layer** → blind comparison, human spot-checks, and honesty about noise. "Does this sound like the principal" has no reliable mechanical check. LLM judges are measurably better at *pairwise* blind ranking (A/B with positional bias controlled by order-swapping) than at absolute scoring, so the harness should frame judgment-layer checks as comparisons — new version versus old, output versus ground truth — rather than rubric scores in isolation.

The uncomfortable corollary: the rules most worth writing down — the judgment-heavy calibration a principal actually cares about — are exactly the rules least amenable to automated validation. The highest-value content and the hardest-to-verify content are the same content. A harness that quietly narrows its test suite to what scripts can check will optimize the skill toward its most trivial layer.

## The Style-Fidelity Ceiling

For voice and ghostwriting skills specifically, one 2025 finding sets expectations: LLMs still fail to reproduce the *implicit* stylistic markers of individual writers — the unconscious patterns a person doesn't know they have and therefore can never state as a rule (arXiv 2509.14543). A skill file is, by construction, a set of *explicit* rules, mostly distilled from corrections the principal was able to articulate. It follows that a skill can pass every explicit-rule assertion and still produce text a blind reader would not attribute to the principal.

This gap is measurable if you want to measure it. The rigorous instrument is content-independent style embeddings (StyleDistance, NAACL 2025, trained specifically to strip topic leakage out of style similarity); the classic statistical baseline is Burrows' Delta; the practical protocol is blind attribution — mix generated and authentic pieces and ask reviewers *which are real*, a discrimination task explicitly harder to game than any rubric.

The right posture is to treat the explicit/implicit gap as a monitored property rather than a bug to fix. A calibration loop that keeps feeding the principal's edit diffs back into the rule set will asymptotically capture everything the principal can *say* about their voice. What remains is the residual only more ground-truth exposure — not more rules — can shrink. Knowing which side of that line a failure sits on prevents a lot of futile rule-writing.

## When a Blind Run Fails: Triage Before Patching

The reflexive response to a failed run — edit the skill — is wrong roughly two times out of three, because the failure has three possible owners, named crisply by SkillAxe (arXiv 2606.10546):

1. **Specification defect** — the skill's instructions are wrong or missing. Fix: edit the skill.
2. **Execution failure** — the instructions were fine; the executor didn't follow them. Fix: strengthen the instruction's force or placement, or accept stochastic non-compliance and re-run; do *not* rewrite a correct rule.
3. **Evaluation defect** — the rubric or judge is broken; the output was actually fine. Fix: recalibrate the rubric, not the skill.

Misattribution compounds: rewriting a correct spec because the rubric was broken produces a worse skill that the broken rubric now scores higher — and judge-hacking dynamics documented in 2026 (verbosity bias, sycophancy, format preference, RL policies learning to please the judge while true quality plateaus) make evaluation defects common, not exotic. REFLECT (arXiv 2606.09071) adds the confirmation discipline: an attribution is only trusted once a *targeted fix at that point actually flips the outcome* — replay the run with the hypothesized repair injected; if the outcome doesn't change, the diagnosis was wrong. And TRAIL's benchmark result — frontier models topping out at 0.546 accuracy on locating errors in agent traces — is the standing caution against assuming any judge can reliably tell you *where* a skill failed. For genuinely ambiguous failures, a human reading the trace is still the instrument of last resort.

One more triage input deserves first-class status: **the model is a dependency**. Prompt drift — same artifact, silently changed model behavior — is a documented 2026 phenomenon, from a silently retuned consumer model breaking downstream prompts to a well-publicized coding-agent quality regression caused by three stacked product-layer changes with the model weights untouched. A skill that regresses after a runtime update has a fourth failure owner that no amount of skill-editing addresses. The mitigations are the boring ones from dependency management: pin dated model versions where possible, and re-run the full suite on every version change, exactly like a library bump triggering CI.

## Open Problems

Four gaps in current practice, in rough order of how soon a working team will hit them:

**Accumulated-rule-set regression.** Calibration-log skills grow monotonically — every principal correction adds a rule. No tool found in this research tests whether rule #47 contradicts, shadows, or subtly re-scopes rule #12. The closest analogy is schema migration testing, and nothing like it exists for prompt artifacts. Until it does, the practical mitigation is periodic full-suite re-runs against the *entire* historical ground-truth corpus (not just the newest case), so an old case broken by a new rule surfaces as a regression.

**Judge regression suites.** If the rubric/judge is part of the harness, it needs its own tests — canonical pass/fail outputs it must classify correctly before its verdicts count. The 2026 frontier response (applying Item Response Theory to judges, treating judge reliability as a measured property) has not yet been packaged into any off-the-shelf tool.

**Enforced held-out splits.** ML infrastructure automated train/test separation a decade ago; prompt tooling still relies on the practitioner remembering not to test on the distillation examples. The discipline should be structural — a harness that refuses to score a case tagged as calibration-source.

**Cheap objective style metrics.** Everything below research-grade stylometry reduces to "ask a judge" or "ask a human to blind-guess." Both work; both have known ceilings; neither is cheap enough to run on every commit.

## Relevance to Zylos

Zylos agents accumulate skills as a primary mechanism of capability growth — recurring task types get a skill, not just a memory entry — and several of those skills are exactly the encoded-preference kind this research says is hardest to verify: ghostwriting in a principal's voice, review checklists carrying an owner's engineering principles, communication SOPs with per-channel conventions. The blind-run pattern is a near-perfect fit for this architecture because the runtime already provides its ingredients: clean-context subagents, cheap parallel execution, and — thanks to calibration logs that record the principal's actual sent versions — ground truth with provenance.

The findings that should shape the standing practice: test every new calibration-type skill with at least one ground-truth case and one synthetic generalization scenario before trusting it; write scripted assertions for the checkable layer instead of asking a judge; treat every principal edit that arrives *after* skill deployment as both a new calibration entry and a new regression test case; and when a blind run fails, run the three-way triage before touching the skill file. The accumulated-rule-set problem is worth watching closely — a calibration log that works beautifully at 10 rules has no guarantee at 50, and re-running the full historical corpus after each new rule is the only defense currently available.

The broader thesis is the one this codebase keeps re-learning in different domains: review is not verification. It was true for code, then for infrastructure config, and it is true for prose that programs an agent. A skill that has never been executed blind against ground truth is not a tested skill — it is a plausible one.
