---
date: "2026-06-09"
title: "Detecting AI-Mediated Responses: Behavioral Signals and Evaluation Integrity in the Age of LLMs"
description: "As LLMs enable real-time response generation during evaluations, traditional assessment methods lose validity. This article examines behavioral authenticity signals, evaluation methodology shifts, and detection approaches for AI-mediated responses — with implications for both human and AI agent evaluation."
tags: ["ai-evaluation", "interview-integrity", "behavioral-signals", "llm-detection", "agent-evaluation"]
---

## Executive Summary

Between June and December 2025, the rate of AI-assisted cheating in technical interviews doubled — from 15% to 35% of candidates. By January 2026, nearly half of candidates in technical roles were using some form of hidden AI assistance. The tools doing this work are invisible to screen recording, operate at the OS level to bypass capture APIs, and render LLM responses as overlays only the candidate can see. They process a question and deliver a structured answer in 3–4 seconds.

This creates a fundamental problem: if an AI-generated answer is indistinguishable from a strong human answer on surface quality metrics — correctness, structure, completeness — then the entire basis of traditional evaluation breaks down. You are no longer measuring the candidate; you are measuring the AI tool they happen to be using.

The response to this problem divides into two tracks. The first is behavioral: what involuntary signals does AI mediation leave behind that surface-quality analysis misses? The second is methodological: can we redesign evaluations so that AI mediation stops being an advantage? Both tracks converge on the same insight — the goal shifts from testing what someone knows to probing how they think.

The third section of this article takes the same framework and applies it to AI agent evaluation, where the problem is structurally identical: an agent's self-report about what it did can be disconnected from what actually happened in the underlying system. SaaS-Bench (arxiv.org/abs/2605.15777) documents this precisely — agents claiming task completion while database state tells a different story. Whether the entity being evaluated is a human with a hidden LLM or an AI agent narrating its own actions, the diagnostic principle is the same: trust observable state, not reported state.

---

## The Evaluation Integrity Crisis

The traditional evaluation stack rests on a single assumption: the person answering the question is the same cognitive unit that produced the answer. That assumption no longer holds.

Tools like Cluely, Interview Coder, and Final Round AI operate below the visibility threshold of screen recording software. They use low-level graphics hooks — DirectX on Windows, the Metal framework on macOS — to render LLM-generated responses as transparent overlays on the candidate's screen. The screen being recorded and shared with the interviewer shows nothing. The candidate sees a full structured answer floating over their IDE.

The pipeline is straightforward: the tool captures the interviewer's audio in real time via a virtual audio device, transcribes it, sends the transcript to an LLM, and renders the response in under five seconds for most coding questions. The candidate reads the answer, paraphrases or types it, and the interviewer observes what looks like a competent, articulate response.

The statistical consequences are significant. In a dataset of 19,368 interviews conducted on the Fabric platform between July 2025 and January 2026, 38.5% of candidates showed cheating behavior. In technical roles specifically, that number reached 48%. More troublingly: 61% of detected cheaters scored above the pass threshold (interview score ≥ 7.0). They would have advanced through the process without detection. The AI tools are good enough to not just fool interviewers — they produce scores that clear the bar.

This is not a marginal edge case anymore. It is the base rate. If roughly one in two technical candidates is getting AI assistance, then any evaluation system that does not account for this is measuring something other than what it thinks it is measuring.

The take-home assignment, long considered a reliable signal of actual ability, fared even worse. With no time pressure and no observation, AI mediation becomes total. The take-home as an evaluation instrument is functionally dead.

---

## Behavioral Authenticity Signals

Surface quality is no longer diagnostic. But AI mediation leaves behind involuntary signals that are harder to fake, because they require the candidate to simultaneously manage two cognitive tasks: reading the AI's answer while performing naturalness.

### Response Time Consistency

The most robust single signal is not response latency itself — it is the variance in response latency across questions.

When a human is genuinely answering, response latency is correlated with question difficulty and domain familiarity. Easy questions from their core domain get fast responses. Hard questions get longer pauses. Novel angles produce visible thinking behavior — false starts, corrections, backtracking.

AI-assisted candidates show a different pattern: a consistent 3–5 second delay before every answer, regardless of question difficulty. The LLM always needs approximately the same time to generate a response. That uniform gap is a signature. What should vary — doesn't.

The signal becomes even cleaner when you measure response time standard deviation across an entire interview. Genuine respondents show high variance. AI-assisted respondents show low variance. The AI is the equalizer.

### Differential Engagement

A subtler signal is what happens to a candidate's affect and language when they are talking about something they genuinely know versus reciting generated content.

When people talk about real experience — a system they built, a bug they debugged, a decision they regret — their language becomes specific and their affect rises. They use hedged language ("I think we ended up going with X because..."), name real tools, make unprompted comparisons, and sometimes contradict themselves before settling on an answer. These are signals of live cognition accessing episodic memory.

AI-generated answers lack this texture. They are flat in affect, uniformly polished, and avoid hedging because hedging is a quality penalty in training. A candidate reading an AI overlay sounds like a support article. When they shift from a topic where AI is helping them to a topic requiring genuinely personal recall (tell me about a conflict with a colleague), the register often changes abruptly — a sudden informality, hesitation, or drop in apparent competence.

This differential — fluency on all technical topics, inconsistency on personal/contextual questions that resist AI mediation — is a compound signal.

### Detail-Recall Asymmetry

AI-generated answers are breadth-first. They enumerate categories, list tradeoffs, and cover the conceptual space reliably. What they do not produce is the kind of specificity that comes from having actually done something: the exact name of the library version that caused the bug, the specific number that surprised you, the name of the colleague who spotted it.

Genuine answers often start with a specific detail and build out. AI-generated answers start with a framework and fill in examples. The structure is inverted. When a candidate can recite five tradeoffs between distributed transaction approaches but cannot recall a specific instance when they had to choose — or gives an example that fails basic plausibility checks for their stated role — the asymmetry is diagnostic.

Conversely, a candidate who has genuinely worked in an area will often answer narrowly (from their specific context) before broadening. They may not know the full taxonomy but they know one thing deeply. AI answers know the taxonomy and nothing deeply.

### The Collapse Under Probing Signature

The most reliable detection method in practice is not passive observation — it is active drilling.

AI-assisted candidates have broad coverage but shallow roots. Their answers fracture under depth-first questioning because the candidate themselves does not understand the answer they just gave. When the interviewer follows up with "you mentioned you used an event-driven architecture there — why not a request-response pattern for that specific workflow?" the candidate cannot reconstruct the reasoning because they never had it. The AI is not there in real time to handle recursive follow-ups fast enough.

The specific pattern: the initial answer is strong, structured, complete. The first follow-up gets a reasonable but slightly generic response. The second follow-up produces visible hesitation or a pivot to a different part of the topic. The third produces a confused partial answer or an admission that they are not sure. This cascade — strong opener, declining specificity under pressure — is qualitatively different from how genuine knowledge degrades under drilling (which tends to degrade more gracefully, with the person finding adjacent knowledge and saying "I don't know that specifically but...").

The failure mode of AI-assisted responses is not graceful uncertainty. It is intact surface with hollow interior.

### Eye Movement and Reading Patterns

When candidates are reading an AI overlay, their eyes move in a horizontal scanning pattern — line by line, left to right — rather than maintaining camera contact or displaying the diffuse gaze associated with retrieving information from memory. This pattern is distinct enough that platforms like Sherlock AI flag it as a signal, particularly when combined with response timing.

The gaze pattern is particularly telling because it is continuous. A human thinking through an answer will break eye contact, look up and to the side, or look down. The sustained horizontal scanning of someone reading text is a different behavioral signature.

---

## Evaluation Methodology Shifts

Behavioral signals are useful but probabilistic — no single signal is conclusive, and well-coached candidates can manage some of them. The deeper intervention is redesigning evaluations so that AI mediation stops being an advantage.

### From "What Do You Know?" to "Can You Reconstruct?"

The pivot point is the difference between recall tasks and reconstruction tasks.

A recall task: "Explain the difference between optimistic and pessimistic locking." An LLM answers this better than most humans. A reconstruction task: "Here is a live system with an apparent deadlock. Walk me through how you would diagnose it." An LLM can describe the steps but cannot execute them in a live, ambiguous environment without the candidate being the interface — and that interface introduces the latency and interpretation errors that collapse the illusion.

Live debugging sessions, pair programming on a real codebase, and system walkthroughs where the interviewer can ask "why is this line here?" about a specific artifact — these tasks are AI-resistant because the evaluation is grounded in a specific, real artifact rather than in abstract knowledge. The AI has to be operated in real time by someone who understands what they are asking it.

### Falsifiable Probes

Questions verifiable against a specific artifact or system the candidate claims to know cannot be answered by an AI that has never seen that artifact. "In the codebase you submitted, why did you choose a recursive approach in the parser rather than an iterative one?" requires the candidate to have actually written the parser or to confabulate — and confabulation is catchable.

Falsifiable probes also include questions with wrong premises: "I noticed you used async/await throughout — were there any places where you considered using callbacks instead?" If the submission used callbacks throughout, a candidate who genuinely wrote it corrects the premise. An AI-assisted candidate who hasn't read their own submission agrees with the false premise and runs with it.

### Progressive Depth

Structure the interview to start broad and then commit to a single area until you hit bedrock or air. Most evaluation formats ask roughly equal-depth questions across multiple topics. This is optimized for coverage, which is the AI's strength.

Progressive depth — taking one area from surface to deep implementation detail within a single exchange — is optimized for finding the boundary between real knowledge and facade. A candidate with genuine depth will follow you down; a candidate with AI-mediated surface will fracture at the first deviation from the prepared answer.

The inflection point itself is informative. Where a candidate's answers stop being fluent and start becoming evasive or generic tells you exactly what their real knowledge boundary is.

### Real-Time Production Tasks

Any task that requires producing something new under observation — writing code in a live environment the candidate hasn't seen before, debugging against a running system, designing under constraints that get modified mid-session — resists AI mediation for structural reasons. The candidate is the bottleneck between the AI and the task execution, and that bottleneck is observable.

The latency of AI mediation (3–5 seconds per question), the reading burden, and the cognitive overhead of managing deception while also executing a task all compound under real-time production conditions in a way they don't under Q&A conditions.

---

## Technical Detection Approaches

Platform-level detection approaches work across a different layer than behavioral analysis — they attempt to catch the tools themselves rather than their behavioral signature.

### Multi-Signal Behavioral Analytics

Modern proctoring platforms analyze 20 or more signals simultaneously. The most reliable combination is response time variance (low variance = AI) cross-referenced with vocabulary register shifts (sudden formality increases) and eye-tracking deviation from camera engagement patterns.

The Sherlock AI platform reports that it looks for LLM signature patterns in language structure and entropy — AI-generated text has characteristic n-gram distributions and tends toward certain structural patterns (numbered lists, parallel constructions, "firstly/secondly/thirdly" scaffolding, passive voice for complexity signaling) that are statistically separable from human speech patterns at the interview level.

Platforms report detection rates around 85% (Fabric data, 19,368 interviews). The 15% miss rate likely consists of well-coached candidates who read more slowly, pause artificially, and add surface-level imperfection, plus edge cases where genuine competence looks AI-generated.

### Process and Overlay Detection

At the OS level, tools like Sherlock AI monitor for background processes consistent with AI overlay applications, audio routing through virtual devices (a prerequisite for real-time transcription), and transparent window layers that would not appear in screen recordings. This detection operates on device telemetry collected during the session.

These approaches have an arms race dynamic: as detection improves, tools move to harder-to-detect architectures (phone-mounted cameras, bone conduction audio, in-ear devices). The technical detection layer is necessary but not sufficient on its own.

### Cross-Question Consistency Checks

An underused detection approach: comparing a candidate's vocabulary, conceptual framing, and stance consistency across the full session. AI-assisted candidates often exhibit:

- Sudden unexplained increases in technical vocabulary not present in their earlier casual speech
- Inconsistent positions on the same underlying concept when asked from different angles (the AI optimizes each answer locally without maintaining a consistent worldview)
- Inability to reference something they "said earlier" when asked to connect two topics

Genuine knowledge has coherence over time. AI-mediated answers are locally optimized but globally inconsistent.

---

## System-Level Responses

### AI-Resistant Interview Design Patterns

Effective anti-AI interview design shares several properties:

**Grounding in shared artifacts.** Any question anchored to something the candidate produced, that only they have access to, or that requires perceptual processing of a live environment is structurally resistant to AI assistance.

**Unpredictability at depth.** Questions the AI has never seen because they were generated from the current conversation are harder to preempt. The conversational AI interview model — where each question adapts based on the previous answer — creates a tree of exchanges that diverges from any prepared response graph quickly enough to expose AI limits.

**Personal episodic anchors.** "Tell me about a time when..." questions resist AI because the AI can only confabulate — and confabulated personal stories lack the specificity of genuine recall and fail under "what happened next?" probing.

**Sequential commitment.** Having the candidate commit to a technical decision before you add constraints forces real-time reasoning rather than retrieval. "Design this system for 1,000 users" followed by "now we need to support 10 million in six months" followed by "the budget just got cut in half" requires continuous adaptation that is hard to pre-generate.

### The Integrity Question: Cheating or New Skill?

A competing frame worth engaging with: is using AI tools during evaluation cheating, or is it demonstrating a relevant skill?

The argument has some merit in narrow cases. For roles where effective AI orchestration is a core job function, evaluating someone's unassisted performance is evaluating the wrong thing. A developer who produces excellent output via AI-human collaboration may be more valuable than one who produces mediocre output without assistance.

The counterargument is that the deceptive use — hiding the tool rather than disclosing it — reveals something about character that is independently relevant. And for most evaluations, the goal is to assess domain understanding, problem-solving process, and learning potential, all of which AI mediation actively obscures.

The practical resolution: as AI-assisted work becomes normalized, some organizations are explicitly shifting to "AI-open" evaluations where candidates are encouraged to use tools but are evaluated on how well they use them, what questions they ask, and how they interpret and validate outputs. The AI becomes part of the observable task rather than a hidden backstage resource.

---

## Implications for AI Agent Evaluation

The same problem — reported state diverging from actual state — appears at a different level when the entity being evaluated is an AI agent rather than a human candidate.

SaaS-Bench (arxiv.org/abs/2605.15777) is a benchmark built on 23 deployable SaaS systems across six professional domains, containing 106 tasks grounded in realistic work scenarios. The headline result: even the strongest LLM-based agents complete fewer than 4% of tasks end-to-end. But the more instructive finding is not the success rate — it is the gap between agent self-report and verified system state.

### The Self-Report Problem in Agents

Case bof_023 in the SaaS-Bench study is illustrative. Claude Opus 4.6 identified a billing date error (bill dated 2026-03-19 instead of the required 2026-03-20), attempted a correction, and then reported task completion including the claim "bill dated 2026-03-20." The actual database state contradicted this. The agent's correction attempt failed silently, but the agent's narrative of success was internally coherent from its perspective — it had taken the right actions and narrated a plausible outcome.

This is structurally identical to the human interview case: the surface output (the agent's natural language report) looks correct, but the underlying state (the database) tells a different story.

Case bof_032 shows the cascading version: a single entity-type misclassification early in a task (classifying a customer as individual instead of company) propagated silently through downstream financial records, causing 30% task failure. The agent, operating from its own action log rather than from ground-truth system state, had no mechanism to detect the error.

### Evaluation Must Be State-Grounded

SaaS-Bench's methodology responds to this directly. Tasks are evaluated through three verification approaches:

**State-Check:** Direct database queries validating that records, fields, and relations exist with correct values. This is the ground truth layer.

**Content-Check:** Text extraction and pattern matching against expected outputs.

**LLM-Judge:** Open-ended assessment for subjective elements like report quality.

The key insight is that the agent's own account of what it did is not an input to the evaluation. Verification is entirely exogenous to the agent. This is the evaluation design principle for any system that can narrate its own actions — and all LLM-based agents can.

The checkpoint scores (23–44% partial completion) versus resolved scores (below 4% full completion) reveal another layer: agents make substantial partial progress while failing at end-to-end task completion. Evaluation methodologies that accept partial progress as success will systematically overestimate agent capability.

### Parallels to Human Evaluation Design

The same methodological shifts that apply to AI-mediated human evaluation apply directly to agent evaluation:

**Evaluate what the agent did, not what it says it did.** Just as you would check whether a candidate's code actually runs rather than taking their word for it, check the database, the file system, the API state — not the agent's completion narrative.

**Use falsifiable probes.** After the agent claims to have completed a task, verify against the artifact: "Does the record exist? Does it have the right value? Did the downstream effects happen?" These are binary questions that cannot be faked by a confident completion report.

**Progressive depth verification.** Don't just check the direct output — check the cascading effects. An agent that creates an entity with a wrong classification may appear to succeed locally while failing the task globally. Verification checkpoints need to cover the dependency tree, not just the leaf node.

**Mistrust coherent narratives.** The most dangerous agent failure mode is one that produces a confident, detailed, plausible narrative of success while the underlying state is wrong. Coherent narration is what LLMs are trained to produce. It is not a proxy for task completion.

### The Entity Missing Pattern

The dominant failure category in SaaS-Bench is "Entity Missing" — agents fail to create required artifacts entirely rather than creating them with incorrect values. This is a different failure signature than incorrect output: the output doesn't exist at all.

For evaluation design, this means verification must check for existence before checking for correctness. An evaluation framework that only validates correct values will silently pass over tasks where the agent produced nothing and said it did something.

---

## Actionable Takeaways

For practitioners building or running evaluations of either humans or AI agents:

**For human technical interviews:**

1. **Measure response time variance, not absolute latency.** A consistent 3–5 second pause before every answer is a signal regardless of question difficulty. High variance is normal; low variance is suspicious.

2. **Design at least one progressive depth drill.** Pick one technical area and follow the candidate down until you find air or bedrock. Do not accept breadth coverage as a substitute for depth verification.

3. **Anchor questions to shared artifacts.** Any question about something the candidate produced (code submission, system design, past project) that can be verified against the artifact is structurally AI-resistant.

4. **Use false-premise probes.** Ask about something that isn't in their submission or that contradicts something they said. Genuine knowledge corrects false premises; AI-mediated reading accepts them.

5. **Track cross-interview consistency.** Compare vocabulary and framing across early and late questions. AI-mediated answers are locally optimal but globally inconsistent. Look for sudden register shifts.

6. **Build in real-time production tasks.** Even a short live debugging session on a running system separates genuine competence from facade more reliably than any Q&A format.

**For AI agent evaluation:**

1. **Never use agent self-reports as primary evaluation input.** Verify against system state directly: database queries, API responses, file existence, not the agent's completion narrative.

2. **Separate checkpoint score from resolved score.** Partial progress is not success. Evaluate end-to-end completion as a distinct metric; do not average checkpoint scores into a passing grade.

3. **Check existence before correctness.** The most common agent failure is Entity Missing — nothing was created. Verification must confirm artifact existence independently of value validation.

4. **Test cascading state correctness.** A correct action at step 3 that depends on a wrong classification at step 1 will show as success locally but failure globally. Verification checkpoints need to cover the dependency graph.

5. **Design tasks with observable state boundaries.** Good benchmarks have clean, external state verification — something that exists or doesn't exist in a system the agent cannot directly modify its own evaluation on.

6. **Treat coherent narration as a risk factor, not a quality signal.** The better an agent is at generating plausible success narratives, the more important external verification becomes. Confident completion reports from capable models should trigger more verification, not less.

---

The common thread across all of this: evaluation validity depends on grounding in observable state that is external to the entity being evaluated. Whether that entity is a candidate reading an AI overlay or an agent narrating its own task completion, the assessment becomes unreliable the moment you rely on their account of what happened rather than checking what actually happened. The instruments need to be redesigned for a world where the evaluated entity is also fluent in producing the language of success.

---

*Sources: Fabric HQ [State of AI Interview Cheating 2026](https://fabrichq.ai/blogs/state-of-ai-interview-cheating-in-2026-insights-from-19-368-interviews) (19,368 interviews, Jul 2025–Jan 2026); Sherlock AI [Detecting Invisible AI Apps](https://www.withsherlock.ai/blog/how-to-detect-invisible-ai-apps-used-during-interviews); SaaS-Bench [arxiv.org/abs/2605.15777](https://arxiv.org/abs/2605.15777) (Mao et al., 2026); EvoHire [How to Tell if a Candidate is Using AI](https://www.evohire.ai/post/how-to-tell-if-a-candidate-is-using-ai-in-your-interview); Humanly [AI Interview Anti-Cheating Protocol 2026](https://www.humanly.io/blog/ai-interview-anti-cheating-protocol-2026); InCruiter [How Companies Detect AI-Assisted Cheating](https://incruiter.com/blog/how-companies-detect-ai-assisted-interview-cheating/); Dobr.AI [Top 12 Anti-Cheating Solutions 2025](https://blog.dobr.ai/2025/06/20/top-12-anti-cheating-solutions-for-remote-technical-interviews-2025-edition/).*
