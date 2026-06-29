---
date: "2026-06-29"
title: "Anchoring and Contamination in Chained LLM Pipelines: How Upstream Scores Corrupt Downstream Reasoning"
description: "When LLM pipelines chain multiple stages, numeric scores and verdicts produced at one stage bleed into the context of downstream stages — and into the minds of human reviewers — systematically biasing outcomes even when no malicious prompt injection is involved. This article surveys 2024-2026 empirical evidence on anchoring, context contamination, and error cascade in multi-stage pipelines, and provides concrete engineering guidance for mitigating these effects."
tags:
  - ai-agents
  - llm
  - multi-agent-systems
  - cognitive-bias
  - pipeline-reliability
  - llm-evaluation
  - human-in-the-loop
  - context-engineering
---

## Executive Summary

A chained LLM pipeline — one where stage N's output feeds stage N+1's prompt — is not a neutral information relay. Each stage is a potential contamination source. A numeric score, a categorical verdict, or even the *order* in which evidence is presented can anchor every subsequent reasoning step. The problem is doubly compounded because human reviewers who consume the pipeline's final output are themselves subject to anchoring: they read the upstream judgment first and under-scrutinize the evidence that follows.

This is categorically different from asking whether a single LLM evaluator is reliable. The question here is about *propagation*: how bias introduced at stage 1 amplifies through stages 2, 3, and beyond, and how it infects the human who ultimately makes the decision. Recent empirical work establishes that this propagation is real, measurable, and not easily defeated by naive countermeasures. Understanding the mechanisms is the prerequisite for building pipelines that are structurally resistant to contamination.

---

## The Anatomy of a Contaminated Pipeline

Consider a two-stage pipeline that is now common in AI-assisted talent workflows. Stage 1 consumes a candidate document and emits a composite match score and a verdict label (e.g., "84 / highly-matched"). Stage 2 takes that score and verdict as part of its context, then generates a tailored output artifact — an interview question guide, a structured assessment template, or a hiring recommendation memo.

Two contamination channels open simultaneously:

**Channel A — machine-to-machine:** Stage 2's prompt now contains the numeric anchor "84 / highly-matched." The generative model producing the question guide is not a neutral reasoner; it is a context-conditioned next-token predictor. The presence of the anchor steers generation toward confirmatory content: questions that probe strengths telegraphed by the high score, fewer probes of gaps, softer framing throughout.

**Channel B — machine-to-human:** The human interviewer opens the guide and sees the score at or near the top of the document. Cognitive anchoring then works its classical effect: the first number seen establishes a reference point that distorts all subsequent judgments. The interviewer attends to evidence that confirms the "84/highly-matched" label and underweights disconfirming signals.

Neither channel requires any intentional manipulation. Contamination is the default behavior of a naively designed pipeline.

---

## Anchoring Bias in LLMs: The Empirical Evidence

The anchoring effect — where an irrelevant or preliminary numerical value disproportionately influences subsequent estimates — has been well-documented in human cognition for decades. The 2024-2026 literature establishes that LLMs exhibit the same bias, often to a comparable or greater degree.

Huang et al. (2025, "An Empirical Study of the Anchoring Effect in LLMs: Existence, Mechanism, and Potential Mitigations," arXiv:2505.15392) evaluated modern LLMs across two anchoring paradigms — semantic priming and numerical priming — and found that the anchoring effect is widespread across current models, including powerful reasoning-class models. LLMs produce A-Index values (a standardized measure of anchoring magnitude used in psychology, where the typical human range is around 0.4–0.6) that are in many cases comparable to human levels, with smaller models tending to show stronger effects. Critically, simply instructing a model to "ignore the anchor" or to apply Chain-of-Thought, Thoughts of Principles, or Reflection approaches was not sufficient to eliminate the bias.

An independent experimental study (Lou & Sun, arXiv:2412.06593) confirmed anchoring in LLMs across a range of numerical estimation tasks and noted that while advanced models tend to show milder anchoring than smaller ones, no tested model was immune.

A related but distinct mechanism — **context drag** — is documented in "Contextual Drag: How Errors in the Context Affect LLM Reasoning" (arXiv:2602.04288). This work shows that providing noisy or incorrect rationales in context significantly degrades model performance even when the model is explicitly instructed to critique the flawed reasoning. In pipeline terms: if stage 1 emits a flawed verdict with apparently confident supporting reasoning, stage 2 will drift toward that verdict even if tasked to challenge it.

A 2024 study on inference-time semantic contamination ("Emergent Inference-Time Semantic Contamination via In-Context Priming," arXiv:2604.04043) demonstrated that even injecting culturally loaded numbers as few-shot demonstrations before semantically unrelated prompts produces measurable distributional shifts in model outputs. The effect is not limited to directly numerical tasks.

### What Mitigations Actually Work

Evidence on countermeasures is sobering. From Huang et al.:

- **CoT, Reflection, and explicit "ignore the anchor" instructions**: not sufficient in most tested models
- **Explicit debiasing prompts**: achieved only limited alleviation across tested models, with the paper reporting at most around 10% improvement — no model reached near-zero anchoring
- **Estimate-first prompting** (ask the model to produce its own estimate before seeing the anchor): theoretically sound, but in practice counterproductively increased bias magnitude in some models rather than reducing it

The implication is that **prompt-level anti-anchoring instructions are not a reliable architectural control.** Structural approaches — discussed in the mitigation section — are required.

---

## Error Cascade in Chained Pipelines

Anchoring is one mechanism through which early errors propagate. The broader phenomenon of **error cascade** in multi-stage pipelines is now well-documented.

"From Spark to Fire: Modeling and Mitigating Error Cascades in LLM-Based Multi-Agent Collaboration" (arXiv:2603.04474, 2026) evaluated six mainstream multi-agent frameworks (LangChain, MetaGPT, AutoGen, CAMEL, CrewAI, LangGraph) across three benchmark types covering code-centric, logic, and general knowledge tasks. The central finding: injecting a single error seed into a multi-agent dependency chain leads to widespread failure, with topological fragility impact factors of 6.29 to 10.31 measured across frameworks. The mechanism is straightforward: a model reading its own or another agent's prior output interprets the established pattern as ground truth and builds upon it. One wrong step degrades the epistemic context for every subsequent step.

The compounding dynamic has a social dimension in multi-agent settings: minor factual deviations get repeatedly cited and restated within the interaction chain. Over multiple rounds, inaccuracies converge into what the paper calls **false consensus** — a collective agreement on an incorrect position that becomes progressively harder to dislodge as it is reinforced by each additional citation.

From a pipeline architecture standpoint, the self-conditioning effect is the key insight: **a model's probability of producing further errors measurably increases when its context window contains prior errors.** This makes early-stage error hygiene critical, not just final-stage quality checks.

---

## Sycophancy, Framing, and Leading-Question Generation

A third contamination mechanism operates on the *generative* stage rather than the *evaluative* stage. When stage 2 is tasked with producing a document (questions, summaries, recommendations), the framing established by the upstream verdict steers generation toward confirmatory, sycophantic content.

"Prompt Sentiment: The Catalyst for LLM Change" (arXiv:2503.13510) demonstrates that sentiment-laden framing in prompts systematically shifts model outputs even when the underlying factual background is identical. A prompt framed positively produces favorable portrayals; a negatively framed prompt produces critical ones — not because the model has different information, but because the framing activates different generation tendencies.

"Source framing triggers systematic evaluation bias in LLMs" (arXiv:2505.13488) extends this to evaluation contexts: the same content attributed to different sources (prestigious vs. unknown) receives systematically different assessments. In a pipeline context, a "highly-matched" label acts as a prestige signal that makes the downstream model treat everything associated with the candidate more favorably.

Sycophancy as a general LLM property has been analyzed in "A Rational Analysis of the Effects of Sycophantic AI" (arXiv:2602.14270), which formalizes it as systematic over-updating toward user beliefs rather than rational Bayesian inference. "How RLHF Amplifies Sycophancy" (arXiv:2602.01002) traces the root cause to the reinforcement learning from human feedback training process: models learn that validating the apparent premise of a prompt earns reward. This is not a bug that can be patched by a single instruction — it is baked into the model's trained tendencies.

In a two-stage pipeline, the first stage's verdict *is* the apparent premise of the second stage's prompt. The downstream model will, by trained tendency, generate content that validates rather than scrutinizes.

---

## The Human-in-the-Loop Is Also Anchored

Perhaps the most consequential finding for agent-platform builders is that the contamination does not stop at the last LLM stage — it extends to the human reviewer who consumes the output.

"No Thoughts Just AI: Biased LLM Hiring Recommendations Alter Human Decision Making and Limit Human Autonomy" (arXiv:2509.04404, AAAI/ACM Conference on AI, Ethics, and Society, 2025) is one of the clearest direct studies of this effect. In controlled experiments, participants followed AI racial preference biases in hiring decisions almost without exception when the bias was moderate — a proxy for realistic everyday AI recommendations. Even in extreme bias conditions, approximately 90% of participants still preferred the AI-recommended candidate. The study characterizes this as a reduction in human autonomy: the AI recommendation does not merely inform the human decision, it supplants it.

This has a direct structural implication: **displaying an AI-generated score or verdict at the top of any human-facing document is an anchor injection.** The score primes the human reader before they have processed any underlying evidence. The human then reads the evidence through the lens of the score rather than forming an independent assessment that could be subsequently calibrated against the score.

Classic anchoring research (Tversky & Kahneman; widely replicated) establishes that even arbitrary numbers — a roulette wheel spin — anchor subsequent numerical estimates. A number with apparent authority (an AI match score) anchors more strongly.

---

## Adjacent Failure Modes: Overproduction, Redundancy, and Position Bias

Beyond anchoring, chained generative pipelines exhibit several structural failure modes that degrade output utility:

**Overproduction (verbosity bias):** LLMs have a well-documented tendency to produce exhaustively long outputs when a focused, sparse output would be more useful. "Do Chatbot LLMs Talk Too Much? The YapBench Benchmark" (arXiv:2601.00624) and "Verbosity ≠ Veracity" (arXiv:2411.07858) establish that verbosity does not correlate with accuracy or utility — a model that produces 20 interview questions is not providing more value than one that produces 5 targeted ones; it is providing more noise. Downstream humans often treat a long list as comprehensive coverage when it is actually diluted coverage.

**Redundancy:** In a multi-round or multi-stage pipeline, concepts already covered in earlier stages reappear in later ones because the model lacks a precise accounting of what has been generated. Two questions that probe the same underlying competency from slightly different angles provide no incremental information but create the illusion of thoroughness.

**Position bias in evaluation stages:** When a pipeline includes an LLM evaluator or ranker, position bias (preferring the first or last item in a comparison) and verbosity bias (preferring longer responses) introduce systematic distortions. Position and verbosity bias in LLM-as-a-judge settings are documented phenomena; one systematic study across five judge models found that while position bias has diminished in modern frontier models (measured at ≤0.04), style and verbosity bias remain the dominant distortion sources ("Judging the Judges: A Systematic Evaluation of Bias Mitigation Strategies in LLM-as-a-Judge Pipelines," arXiv:2604.23178). Self-preference bias — models rating their own outputs higher than equivalent outputs from other models — is documented in arXiv:2410.21819 and further analyzed in arXiv:2604.22891.

---

## Mitigation Patterns: An Engineering Checklist

The following patterns address the contamination mechanisms described above. They are organized by the point in the pipeline where they intervene.

### Context Isolation (Information Blinding)

- **Never pass upstream scores or verdicts directly into the prompt of a generative downstream stage.** Pass raw evidence (the original document, structured fields, retrieved facts) and let the downstream model form its own assessment before being exposed to the upstream verdict.
- **For human-facing documents, defer score display.** If a score must be shown to a human, place it *after* the evidence sections, not before. Consider a UI/document structure where the human must explicitly "reveal" the AI score — forcing at least a nominal independent read before exposure. Research on anchoring in human-computer interaction consistently finds that the *order* of information presentation is as important as its presence.
- **Use separate context windows.** When stage 2 must know that stage 1 completed successfully, pass a completion signal (boolean, status code) rather than stage 1's full output narrative.

### Evidence-Grounded Context

- **Pass primary sources, not derived verdicts.** If stage 1 analyzed a document, pass the document (or its relevant excerpts) to stage 2. Do not pass stage 1's summary or interpretation as the sole context.
- **Include explicit provenance.** For any claim in the context, indicate what document or data point it derives from. This gives the downstream model a basis for independent assessment rather than delegated trust.

### Structural Output Constraints

- **Cap list lengths with explicit upper bounds in the system prompt.** "Produce between 4 and 6 questions" is more effective than "produce a comprehensive list." Explicit caps reduce overproduction and force the model to prioritize rather than enumerate.
- **Require prioritization metadata.** Instead of a flat list, require an ordered list with brief justification for priority ordering. This surfaces redundancy (two top-priority items that test the same thing become visible as duplicates).
- **Mandate de-duplication in the prompt.** Explicitly instruct: "Before finalizing the list, check that no two items assess the same underlying dimension. Merge or remove any duplicates."
- **Separate generation from evaluation.** Run a second LLM pass that takes only the generated output (no context about the candidate) and identifies redundancies, gaps, or leading framing. This de-anchors the evaluator.

### Anti-Sycophancy Framing

- **Instruct the model to steelman objections.** For any generative stage that might produce confirmatory content, include an explicit instruction: "Before finalizing, identify the two strongest arguments against the assessment above." This does not eliminate framing effects but has been shown to increase the diversity of generated content.
- **Use adversarial role assignment.** Assign the downstream stage an adversarial role ("You are a skeptical second reviewer whose job is to find gaps the first reviewer missed") rather than a confirmatory one. Research on representation engineering suggests role assignment shifts activations in measurable ways.
- **Temperature and sampling diversity:** For critical pipelines, generate multiple independent completions under different seeds and synthesize, rather than accepting a single generation. This partially offsets sycophantic convergence on a single response.

### Independent and Adversarial Verification

- **Multi-LLM verification pipelines:** Route the same task to at least two different models (preferably different families) without sharing inter-model reasoning. Agreement across models increases confidence; disagreement surfaces uncertainty that should be flagged to the human reviewer.
- **Cross-context review:** "Cross-Context Review: Improving LLM Output Quality by Separating Production and Review Sessions" (arXiv:2603.12123) demonstrates that having a different model session review output without access to the production session's context measurably improves quality — the reviewer is not contaminated by the producer's reasoning.
- **Provably traceable pipelines:** Emerging work on audit agents (e.g., arXiv:2512.17259) suggests that observable, logged reasoning trails enable post-hoc detection of where contamination entered a pipeline.

### Human Factors Engineering

- **Separate score from evidence in human-facing reports.** Scores belong in appendices or behind explicit disclosure actions, not in document headers.
- **Provide uncertainty bounds, not point estimates.** A score of "84 ± 15" anchors less strongly than "84" — the wide interval signals epistemic uncertainty and invites independent evaluation.
- **Train reviewers on AI anchoring effects.** Studies show that making humans consciously aware of their susceptibility to AI-driven bias (analogous to an implicit-association test) can reduce the effect by ~13%. This is small but non-zero, and training costs are low relative to decision quality improvements.
- **Require independent assessment before score disclosure as a process control.** Make reviewers document at least one key concern or open question about the subject before they see the AI score. This forces some degree of independent reasoning before anchoring exposure.

---

## Where This Matters in Agent Architectures

Any pipeline that chains LLM calls where stage N's output enters stage N+1's prompt is subject to these dynamics. Common patterns with elevated risk:

- **Screening → Generation pipelines:** Classifier or scorer at stage 1 feeds a generative document producer at stage 2 (interview guides, recommendation memos, prioritized backlogs)
- **Summarizer → Reasoner chains:** A summarization stage compresses a long document and the compressed summary enters a reasoning stage. The summarizer's framing choices propagate as if they were facts.
- **Multi-agent debates with shared context:** When agents share a conversation history and build on each other's outputs, false consensus can emerge and compound (arXiv:2603.04474).
- **RAG pipelines with retrieved snippets:** The order in which retrieved chunks appear in context affects downstream reasoning through position effects that persist even with explicit normalization instructions.
- **Agentic loops with self-reflection:** When an agent reads its own prior output and refines it, self-preference bias and contextual drag make the refinement systematically conservative — it converges toward its own initial position rather than exploring genuine alternatives.

The systematic error amplification documented for multi-agent pipeline architectures (arXiv:2603.04474) — with topological fragility impact factors reaching into the range of 6 to 10 across major frameworks — is the most concrete quantification of pipeline contamination at scale. For production pipelines making high-stakes decisions, this is not a theoretical concern — it is the expected behavior of a naively constructed chain.

---

## Implications for Agent Platform Builders

Three structural principles follow from this body of evidence:

**1. Treat inter-stage interfaces as trust boundaries.** The contract between pipeline stages should specify what information flows across and in what form. Derived judgments (scores, verdicts, summaries) should be treated as potentially contaminating and should be withheld from downstream generative stages by default, passed only when explicitly required and with appropriate structural isolation.

**2. Design for human independent assessment, not human rubber-stamping.** A pipeline that presents AI outputs for human "review" but structures those outputs so that the human necessarily sees the verdict before the evidence is not a human-in-the-loop system — it is a human-in-the-approval-loop system. The distinction matters enormously for decision quality and accountability.

**3. Monitor for cascade signatures, not just endpoint accuracy.** Standard quality evaluation that checks the final output against ground truth cannot distinguish between an accurate pipeline and a contaminated pipeline that happened to produce the right answer for the wrong reasons. Instrumentation should log intermediate stage outputs and track agreement rates between independently reasoned stages — high agreement combined with high anchoring exposure should trigger review, not just endpoint error rates.

The research summarized here is recent (2024–2026) but the underlying cognitive phenomena are not new. What is new is that we now have the quantitative evidence to treat anchoring and context contamination as engineering problems with measurable severity and actionable mitigation patterns, rather than as vague concerns about AI reliability.
