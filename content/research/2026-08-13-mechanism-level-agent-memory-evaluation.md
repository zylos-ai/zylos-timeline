---
date: "2026-08-13"
title: "Mechanism-Level Agent Memory Evaluation: Decoupling the Memory Layer from the Generation Model"
description: "What an Add/Search evaluation controls, how adapter fidelity and dataset provenance limit its conclusions, and why answer quality needs separate cost and task-level measurements."
tags: ["agent-memory", "evaluation", "benchmarks", "leaderboards", "memory-systems", "retrieval", "anti-gaming", "ai-agents"]
---

## Executive Summary

A shared memory interface can make comparisons more interpretable by holding downstream answering and scoring conditions fixed. The resulting answer score still depends on the evaluation pipeline; it does not isolate an intrinsic property of retrieval or prove that one memory architecture is universally better. Architecture comparisons also need component ablations, an account of what an adapter preserves, and measurements on the tasks the deployed agent actually performs.

This article examines the Agent Memory Leaderboard (AML) alongside primary reports that expose different measurement pitfalls. Published results are attributed to their authors; no benchmark was reproduced for this article. Later AML documentation is identified by repository revision below and is not treated as a reconstruction of its August 13 launch-era contract.

## What a Controlled Memory Interface Buys

At [AML repository revision `1b8142b`](https://github.com/AML-memory/agent-memory-leaderboard/blob/1b8142bfe0f20f1c5218d6b554aa0012de34e504/README.md), participants provide **Add**, which ingests history, and **Search**, which returns relevant memory evidence. AML controls answer generation, evaluation, aggregation, and orchestration. Comparable results require a matching versioned contract covering the benchmark bundle, pipeline, model configuration, and scoring rules. This revision names LoCoMo-Refined among its textual benchmarks.

The appropriate interpretation is **answer quality conditional on the submitted memory evidence and the specified generation/judging pipeline**. A correct passage can still yield a wrong answer; an incomplete passage may receive credit from a permissive judge. Calling the final score “retrieval-only” hides those interactions.

For an architectural claim, a shared harness is the beginning of the analysis. If two submissions differ in extraction, embeddings, indexing, and query planning, a score difference cannot identify which change caused it. To answer that narrower question, vary one component while preserving the rest of the comparison.

The [MemDelta study, v1, §4.3](https://arxiv.org/html/2606.29914v1#S4.SS3) illustrates this distinction. Across 500 LongMemEval-S questions, changing the embedder while keeping the retrieval code, chunking, data, answer model, and judge fixed moved accuracy from 47.2% to 53.4%: a 6.2-percentage-point difference. That result supports controlling embeddings before attributing a gain to memory architecture.

## An Adapter Is Possible; Its Fidelity Must Be Explained

An Add/Search service can wrap files, a vector index, a graph, or an agent that performs multiple internal retrieval steps. The interface alone does not make file-curated memory impossible to evaluate. The substantive question is whether the submitted adapter preserves the behavior for which the live system is being chosen.

Consider an agent that learns a repair procedure only after a tool failure, revises it after a successful retry, and later selects it while solving another task. A harness that only backfills conversation history and then asks recall questions may preserve the final stored text while omitting the feedback that produced it. An adapter could recreate some of those interactions, but that requires an explicit mapping from the workload to the live memory process. This is an evaluation-design example, not a finding that AML forbids such behavior.

A useful adapter report would identify:

- Which observations reach Add, and whether their order and task context match live operation.
- Which write, revision, and consolidation decisions remain inside the submitted system.
- Whether Search preserves iterative queries and tool feedback, or replaces them with a different procedure.
- Which behaviors require a separate interactive task evaluation.

The systems paper [*Are We Ready For An Agent-Native Memory System?*, v1](https://arxiv.org/html/2606.24775v1) supports examining components, updates, workload fit, and operating costs. Its stated scope is memory-centric systems; it excludes task-specific agent frameworks where memory is auxiliary. It does not establish a theorem that agent-curated files cannot expose Add/Search. The adapter-fidelity concern here is an inference about what a particular test exercises, rather than an impossibility result established by the paper.

### What Letta's Filesystem Result Actually Tested

[Letta's August 12, 2025 experiment](https://www.letta.com/blog/benchmarking-ai-agent-memory/) reports 74.0% LoCoMo accuracy with GPT-4o-mini. Attached conversation files were automatically parsed and embedded; tools included semantic search and grep. Tool rules required the agent to begin with `search_files`, continue searching, and finish with `answer_question`, while allowing it to choose queries and the number of tool calls.

The comparator was **Mem0's reported 68.5% for its graph variant**, not a separately rerun comparator established by this post. The experiment therefore evaluates a particular file-backed, search-enabled agent configuration. It does not show that bare files eliminated retrieval infrastructure, nor that a fixed interface cannot accommodate iterative retrieval. Its practical lesson is to describe the agent, tool rules, and comparator provenance along with the storage format.

## Data Provenance and Judge Behavior Are Separate Questions

AML's pinned README says its public repository omits corpora, held-out questions, gold answers, and rubrics. That is a publication boundary, not proof that nobody has seen the evaluation material. Organizers, participants, public source datasets, and private derivatives have different exposure histories. Establishing test secrecy requires evidence about the specific release and access controls; repository exclusion alone cannot supply it. [AML repository scope](https://github.com/AML-memory/agent-memory-leaderboard/blob/1b8142bfe0f20f1c5218d6b554aa0012de34e504/README.md#repository-scope).

A separate [LoCoMo-10 audit, revision `9493fb4`](https://github.com/dial481/locomo-audit/blob/9493fb4b4af4256ed17a18e8fd0b3cfdeec29539/AUDIT_REPORT.md) reports 99 score-corrupting issues among 1,540 non-adversarial questions, plus 57 citation-only issues. The report identifies the audited dataset by SHA-256 and describes an LLM audit with human review. These are the audit's classifications, not independently re-annotated results here.

Its approximate 93.6% ceiling requires every affected correct answer to be rejected and every unaffected answer to receive credit. It is not an unconditional bound on observed scores: a system can match a wrong gold answer, and a lenient judge can accept answers despite label defects. The rate cannot be transferred to AML without establishing equivalent corpus versions and scoring behavior; the pinned AML documentation instead names LoCoMo-Refined.

The same repository's [adversarial plausibility test](https://github.com/dial481/locomo-audit/blob/9493fb4b4af4256ed17a18e8fd0b3cfdeec29539/ap-baseline/README.md) generated deliberately wrong answers using the answer key. Its vague-but-topical strategy received 62.81% under GPT-4o-mini at temperature zero, using the EverMemOS evaluation judge prompt and averaging three judge calls per question. This probes that prompt-and-answer setup. Sharing a model name does not establish the same failure rate in another leaderboard.

[LoCoMo-Plus, v1](https://arxiv.org/html/2602.10715v1) addresses a different limitation: retaining and applying latent constraints when a later request is semantically disconnected from the original cue. It introduces cognitive-memory tasks and constraint-consistency evaluation. It should not be described as merely a corrected answer key for LoCoMo.

## Corrections Must Preserve the Metric and Configuration

[MemPalace's canonical history at revision `f9297a2`](https://github.com/MemPalace/mempalace/blob/f9297a228586ebbfc5ac37763793d6c89ef69104/docs/HISTORY.md) distinguishes several corrections. Its April 7, 2026 note corrects compression claims and the attribution of a retrieval improvement to the “palace” structure, while retaining 96.6% Recall@5 on LongMemEval in raw mode. The April 14 entry removes tables that mixed retrieval recall with competitors' end-to-end QA accuracy, and removes a test-tuned 100% reranking headline from public comparison tables.

This was not a withdrawal of the raw-mode 96.6% result within 48 hours. The history reports reproductions, but consulting that record is not performing one. The methodological lesson is narrower and more useful: **retrieval recall, answer accuracy, compressed mode, raw mode, and test-tuned reranking are different claims**. A corrected comparison must keep those identities intact.

## Cost and Task Outcomes Need Their Own Denominators

MemDelta's [§4.4 comparison](https://arxiv.org/html/2606.29914v1#S4.SS4) is separate from its 500-question embedding ablation. It compares 88 successful instances from the first 100, excluding 12 Mem0 API failures; only two of six question types are represented. Mem0 scored 72.7% and cloud-embedding RAG 73.9%, with a 90% difference interval of −10.8 to +8.4 percentage points. The nonsignificant result does not prove equivalence, and excluding failures may favor Mem0.

The approximately 50× figure comes from a **five-instance write-path cost pilot**: $0.50+ versus $0.01 per instance. It is neither an equal-budget comparison nor a full-lifecycle cost ratio. These restricted results do not establish general extraction value across the untested question types.

For coding tasks, [Stompy's report](https://www.stompy.ai/deep-dive) compares memory conditions on its own system and codebase and explicitly identifies one run per cell as a pilot, not statistical proof. It tracks quality, cost, and turns, demonstrating a useful measurement structure. Its detailed tables require reconciliation: Table 4 lists Task 3 costs of $3.52 with Stompy and $3.18 without memory, while Table 6 labels that task as a 22% cost saving. This article therefore does not adopt its headline savings ranges. Neither general production savings nor a universal complexity threshold follows from this pilot.

A production evaluation should instead define its own task population and report failure-inclusive completion rates, answer or code quality, write costs, query costs, latency, and maintenance overhead. Keep recurring costs separate from one-time ingestion, and report repeat-run variability before interpreting small differences. These are proposed evaluation requirements, not results established by the cited pilot.

## Practical Takeaways

- Read a score as a result under a named contract. Preserve the dataset release, judge prompt, model configuration, metric, and population when comparing figures.
- Use component ablations to investigate why systems differ. A fixed answering pipeline does not by itself isolate the contribution of each memory mechanism.
- Evaluate an adapter's fidelity before generalizing its score to a deployed agent. Add/Search compatibility and coverage of task-conditioned memory behavior are separate questions.
- Verify exposure history and judge behavior independently. A repository withholding data does not establish universal blindness, and an audit of one corpus does not quantify errors in another.
- Pair controlled answer evaluation with repeated interactive tasks and explicit cost accounting. This provides evidence for a deployment decision without turning a narrow benchmark or vendor pilot into a universal verdict.

---

*Sources: Direct primary links accompany the claims above. Repository references are pinned to the revisions inspected; arXiv references specify v1. Letta's dated experiment and Stompy's live report retain their stated experimental scope. No independent benchmark reproduction or production trial was performed.*
