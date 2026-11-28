---
date: "2026-11-28"
title: "Find Candidates with Code, Judge with the Model: Blocking Before LLM Judgment in Agent Memory Consolidation"
description: "Entity-resolution research has split matching into cheap candidate generation (blocking) and expensive judgment for decades. This article applies that split to a persistent agent's markdown memory: what to block on, how to cap and audit candidates, what the agent should see, and when not to pre-gather at all."
tags: ["research", "ai-agents", "agent-memory", "entity-resolution", "blocking", "llm-judgment", "memory-consolidation", "retrieval", "context-engineering"]
---

## Executive Summary

A persistent agent that keeps long-term memory as markdown pages (project pages, decision pages, an INDEX with one row per page) accumulates near-duplicates over months. A periodic "tidy" job that hands the whole index to an LLM and says "find pages to merge" is unreliable: it misses pairs, burns tokens, and gives different answers on different runs. The remedy is old and well studied. Database researchers call it **blocking**: a cheap, deterministic step proposes candidate pairs, and an expensive matcher judges only those.

The main findings:

- **The split is the standard architecture.** The entity resolution (ER) literature treats "blocking and matching" as the mainstream pipeline. All-pairs comparison grows quadratically (one Splink guide puts 1 million records at about 500 billion pairs). At a few thousand pages all-pairs is trivial for code but impossible for an LLM, so the point of blocking in agent memory is to bound the number of *judgments*, not computations.
- **LLM matchers sit downstream of blockers.** Papers on LLM entity matching either run a conventional blocker first or take its candidates as given. LLM cost scales with the number of candidate pairs, and the blocker sets a recall ceiling: a pair never proposed is never judged.
- **Agent memory systems already do this for "update or create".** Mem0 retrieves the top similar memories by embedding, then the LLM chooses ADD, UPDATE, DELETE or NOOP. Zep/Graphiti gathers entity candidates by cosine search, full-text search and exact-name lookup before the LLM resolves duplicates. A-MEM and LangMem follow the same shape. None of the sources reviewed reports a measured recall for that retrieval step.
- **For a few hundred to a few thousand short pages, use a union of cheap keys:** IDF-weighted rare shared terms, extracted identifiers (PR or issue numbers), entity names, and optionally embedding neighbours. Cap candidates per page, purge stopword-like keys, and judge transitive clusters as a unit.
- **Measure the blocker, not just the agent.** Seed known duplicates, audit a sample of pairs the blocker did *not* propose, and log the candidate list so runs are reproducible and diffable.
- **Do not pre-gather when the need is not code-determinable.** Open-ended exploration is better served by search tools the agent drives itself.

## 1. Background: Blocking in Entity Resolution

### 1.1 Why all-pairs does not scale

Entity resolution (record linkage, deduplication) asks which records describe the same real-world thing. Comparing every record with every other costs n(n-1)/2 comparisons. Splink's documentation illustrates: one million records yield about 500 billion pairwise comparisons, "the vast majority" of which will not be matches ([Splink blocking guide](https://moj-analytical-services.github.io/splink/topic_guides/blocking/blocking_rules.html)).

Memory corpora are far smaller, but the arithmetic still bites once an LLM is the comparator: 500 pages give 124,750 pairs, 2,000 pages give 1,999,000. Code scores two million pairs in seconds; no LLM budget can read them, and an LLM asked to find them implicitly by reading an index will not do so reliably.

Blocking is the standard answer. A comprehensive survey describes it as grouping potentially matching entities into common blocks and comparing only within blocks, often repeating block building with several schemes "to achieve a more robust performance in the context of highly noisy data" ([Papadakis et al., 2020](https://arxiv.org/abs/1905.06167)). Christen's survey frames indexing as reducing the number of pairs compared "by removing obvious non-matches, while keeping matching quality high" ([Christen, 2012](https://dl.acm.org/doi/10.1109/TKDE.2011.127)).

### 1.2 Families of blocking

| Family | How candidates are produced | Typical weakness |
|---|---|---|
| Standard blocking | Records sharing a computed key (for example a normalized title prefix) form a block | Depends heavily on key frequency distribution; skewed keys give huge blocks, typos split true matches |
| Sorted neighbourhood | Sort by key, compare within a sliding window of size w ([Hernández and Stolfo, 1995](https://dl.acm.org/doi/abs/10.1145/568271.223807)) | Small w gives low recall, large w low efficiency |
| Token blocking | One block per distinct token anywhere in a record | "Very high" completeness but "very low" pairs quality and reduction ratio without cleaning |
| Q-gram / suffix | Blocks over character n-grams or suffixes | Robust to spelling variation, but more comparisons |
| MinHash + LSH | Similar set signatures collide in at least one band | Probabilistic; misses pairs near the threshold |
| Embedding nearest neighbour | Index vectors, take k nearest per record | Needs an embedding model; k is a recall/cost dial |

(Weaknesses for the first three and the Q-gram row follow [Papadakis et al.](https://arxiv.org/abs/1905.06167).)

**Token blocking and its stopword problem.** Token blocking pairs records that share any token. The survey notes that large blocks "are typically produced by lazy schema-agnostic techniques and correspond to stop words," and describes *block purging* (discard blocks above a size limit) and *block filtering* (keep each entity only in its smallest blocks). This is the ER ancestor of IDF weighting: a token shared by thousands of records says little, one shared by two says a lot.

**Meta-blocking.** The co-occurrence structure becomes a graph whose edges (candidate pairs) are weighted by evidence, such as the number of common blocks, and weak edges are pruned. Cardinality Node Pruning "retains the top-k weighted edges in each node neighborhood" ([Papadakis et al.](https://arxiv.org/abs/1905.06167)), which is the "cap candidates per page" move used below.

**MinHash/LSH.** Items are reduced to shingle sets and minhash signatures, split into b bands of r rows. Two items become a candidate pair if they collide in any band; the probability at Jaccard similarity s is 1 - (1 - s^r)^b, steepest near (1/b)^(1/r) ([Mining of Massive Datasets, ch. 3](http://infolab.stanford.edu/~ullman/mmds/ch3n.pdf)). For a few thousand pages this is likely more machinery than needed.

**Embedding blocking.** Zeakis et al. index vectors (for example FAISS/HNSW) and issue a k-nearest-neighbour query per entity ([Zeakis et al., 2023](https://arxiv.org/abs/2304.12329)). The DeepBlocker study defines the goal as maximizing recall |C∩G|/|G| with a small candidate set, finds both rise with K, and reports that unioning the best deep-learning blocker with a strong non-deep-learning blocker "significantly increases recall" with modest growth in output ([Thirumuruganathan et al., 2021](http://vldb.org/pvldb/vol14/p2459-thirumuruganathan.pdf)). That is the strongest published support for combining lexical and embedding keys.

### 1.3 Metrics: completeness versus reduction

The survey formalizes three measures ([Papadakis et al.](https://arxiv.org/abs/1905.06167)):

- **Pair Completeness (PC)**: blocking's recall, the share of true duplicate pairs sharing at least one block.
- **Pairs Quality (PQ)**: blocking's precision, the share of proposed comparisons that are real duplicates.
- **Reduction Ratio (RR)**: 1 - ||B|| / ||E||, the fraction of brute-force comparisons avoided.

There is "a clear trade-off between the effectiveness and the efficiency of a blocking scheme." PC is also optimistic, since it presumes an oracle for true duplicates, and the true duplicates are what ER is trying to find, so blocking is "typically treated as an engineering task" tuned to the data at hand.

With an LLM matcher, PQ and RR are priced in tokens (every false candidate costs a judgment), while PC has no price tag because misses are silent. That asymmetry is why Section 4 spends time on auditing recall.

### 1.4 Tools

- **Splink** calls blocking rules "the single most important determinant of how quickly your linkage runs." Its advice generalizes: "It's usually better to use a longer list of strict blocking rules, than a short list of loose blocking rules"; count comparisons before running ("to make sure you don't accidentally generate trillions of pairs"); inspect the largest blocks (`n_largest_blocks`). A pair is generated if it satisfies at least one rule, so several strict keys act as a union ([Splink](https://moj-analytical-services.github.io/splink/topic_guides/blocking/blocking_rules.html)).
- **dedupe** "uses machine learning to perform fuzzy matching, deduplication and entity resolution" and derives rules from human training data ([README](https://github.com/dedupeio/dedupe)).
- **JedAI / pyJedAI** is an open-source ER toolkit. A 2026 paper used its blocking step with Q-gram, Extended Q-gram and Standard Blocking ([CE-RAG4EM](https://arxiv.org/abs/2602.05708)); see also the [pyJedAI project](https://github.com/AI-team-UoA/pyJedAI).

## 2. LLMs as the Matcher After Cheap Blocking

### 2.1 What the papers show

Narayan et al. showed few-shot GPT-3 matching or beating fine-tuned PLM matchers on several benchmark datasets ([VLDB 2023](https://arxiv.org/abs/2205.09911)). Peeters, Steiner and Bizer found top LLMs "require no or only a few training examples" to match PLMs fine-tuned on thousands, with "no single best prompt" across models and datasets ([EDBT 2025](https://arxiv.org/abs/2310.11244)). Both evaluate the pairwise decision on pre-built pairs: judgment, not finding the pairs.

The cost papers supply the end-to-end framing. The ICDE 2024 study states that "an end-to-end ER system consists of a blocker and a matcher," treats blocking as out of scope, and gives an illustrative calculation: about 10,000 blocker-output pairs on Abt-Buy, queried with GPT-4 under standard prompting with demonstrations at then-current pricing, come to $110 ([Fan et al.](https://doi.org/10.1109/ICDE60146.2024.00284)). The dollar figure is dated; the structure holds: cost is pairs times tokens per pair, so the blocker's output size is the budget.

A 2026 retrieval-augmented matching paper reuses blocking groups as batching units (batch size capped at 6 by default, best at 4 to 6). Batched generation cut output to roughly 90 tokens per pair, about 4.5 times cheaper, at the price of "cross-pair coupling" that can lower precision; exact token blocking could split near-duplicates into different blocks, so Q-gram blocking did better ([CE-RAG4EM](https://arxiv.org/abs/2602.05708)).

### 2.2 Judging a candidate list, not isolated pairs

Wang et al. compare pairwise matching, comparing, and *selecting* the match from an anchor's candidate list. Across 8 ER datasets and 10 LLMs, selecting beat standalone pairwise matching and was often the most cost-effective, but selection accuracy varied significantly with the position of the true match in the list (position bias). Recall-oriented blockers "often generate a considerable number of potential matches for each record, exceeding the context length that LLMs can effectively reason," so they propose a medium model to rank and filter, and a stronger one to select among the top few ([COLING 2025](https://arxiv.org/abs/2405.16884)). Lesson: show the agent a small, ordered or shuffled candidate set, not whatever the blocker spills out. This echoes findings that models use the start and end of long inputs better than the middle ([Liu et al., 2024](https://arxiv.org/abs/2307.03172)); handing the agent a whole index is the worst case.

### 2.3 The blocker caps recall

End-to-end recall is bounded by the blocker's pair completeness; a pair never proposed receives no judgment however capable the model. Consequences: measure blocker recall (Section 4.3); prefer several redundant keys over one clever key, since schema-aware keys are "quite parameter-sensitive" and when poorly chosen leave "most duplicates" in no common block, while schema-agnostic redundancy gives robustness ([Papadakis et al.](https://arxiv.org/abs/1905.06167)); and accept low reduction ratio, then clean candidates (purging, per-node top-k) to recover efficiency.

## 3. How Agent Memory Systems Handle Consolidation Today

Does code retrieve candidate memories before the LLM decides? We checked papers and source code. Where the mechanism is published, yes.

| System | Code before the LLM | The LLM decides | Source |
|---|---|---|---|
| Mem0 | Top s similar memories by vector embedding (s = 10 in the paper's experiments) | ADD, UPDATE, DELETE or NOOP via tool call; no separate classifier | [paper](https://arxiv.org/abs/2504.19413) |
| Zep / Graphiti | Cosine search over entity nodes plus full-text search on names and summaries; in open-source code also identity-property and exact-name lookups, merged and deduplicated, then deterministic identity and similarity rules | For still-unresolved nodes, whether the new node duplicates a candidate, and the preferred name and summary | [paper](https://arxiv.org/abs/2501.13956); [source](https://github.com/getzep/graphiti/blob/main/graphiti_core/utils/maintenance/node_operations.py) |
| A-MEM | Cosine similarity of the new note against all notes, top-k (k = 10 in the paper) | Which links to create, and whether to update neighbours' context, keywords and tags | [paper](https://arxiv.org/abs/2502.12110) |
| LangMem | Store manager runs semantic search by embedding windows of recent messages (query_limit default 5), or an LLM-written query; dedupes and keeps top results | The memory manager receives existing memories plus the conversation and returns updates | [concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/); [source](https://github.com/langchain-ai/langmem/blob/main/src/langmem/knowledge/extraction.py) |
| Letta | The documentation reviewed describes agents editing memory blocks via tools and no automated candidate retrieval for dedup | The agent | [docs](https://docs.letta.com/guides/agents/memory) |

Three observations.

**The pattern is retrieval-then-judge, with "retrieval" meaning similarity search.** Mem0 and A-MEM use dense embeddings alone. Graphiti and Zep combine embeddings, full-text search and exact-name or identity lookup, the hybrid redundancy the ER literature recommends. Graphiti also lets deterministic rules resolve what they can, so "only nodes that are still unresolved go to the LLM": candidates, rules, then judgment. That three-stage shape suits a memory tidy.

**These designs are per-item at write time, not whole-corpus at tidy time.** They answer "does this new fact already exist?" over a small, query-driven candidate set. A periodic "which pages overlap?" job is a self-join, a classic deduplication problem for which the ER blocking literature is the better guide.

**Retrieval quality is rarely reported on its own.** The Mem0 paper evaluates question answering, latency and tokens, not the recall of its candidate-retrieval step; we found no measured pair completeness for that stage in any source above. Adopters should measure it.

## 4. A Practical Design for a Markdown Memory of a Few Hundred to a Few Thousand Pages

At this size any blocker finishes instantly. The problem is (a) recall, (b) a small, stable number of LLM judgments, and (c) giving the agent evidence instead of a blank search task. What follows is design advice built on the sources above; items marked "our suggestion" are not published results.

### 4.1 Blocking keys for short titles and index rows

Index rows are short, which favours token- and identifier-level keys over character-level or whole-document ones.

| Key | Catches | Notes |
|---|---|---|
| Rare shared terms (IDF-weighted) | Pages using the same distinctive words | Compute document frequency over index rows; keep terms under a df cap or weight pairs by summed IDF. This is token blocking plus block purging. |
| Extracted identifiers | PR or issue numbers, ticket IDs, commit hashes, file paths, URLs | Exact match, very high precision; extract from bodies, not only index rows. |
| Entity names | People, services, repositories | Normalize case and punctuation. A name on a hundred pages is a stopword. |
| Normalized-title similarity | Near-identical titles with small edits | Cheap Q-gram or sorted-neighbourhood pass; restores recall that exact tokens lose to spelling variants (cf. Q-gram versus standard blocking in [CE-RAG4EM](https://arxiv.org/abs/2602.05708)). |
| Embedding neighbours | Paraphrases, renames with no shared words | Embed title plus summary; top-k per page above a similarity floor. Exact search suffices at this size. |

Take the union ([DeepBlocker](http://vldb.org/pvldb/vol14/p2459-thirumuruganathan.pdf) and [Splink](https://moj-analytical-services.github.io/splink/topic_guides/blocking/blocking_rules.html) both support it) and record which key produced each candidate: it is evidence for the agent and diagnostic data for you.

### 4.2 Capping the candidate count

1. **Purge flooding keys.** Drop terms whose block exceeds a size limit, or keep only each page's few rarest keys (block purging and filtering). Check the largest blocks every run.
2. **Weight and rank pairs** by distinct keys shared, summed IDF, embedding cosine and identifier matches, as meta-blocking weights edges.
3. **Per-page top-k plus a global per-run cap**, so cost is predictable. No numbers are given here; choose them from the audit in 4.3.
4. **Carry over the backlog** (our suggestion): store pairs the cap truncated and take them next run, so truncation delays rather than drops.
5. **Remember decisions** (our suggestion): key a "keep separate" verdict on a content hash of both pages so the pair returns only after either changes.

As Splink advises, print the candidate count and largest blocks first in the job log.

### 4.3 Measuring blocker recall cheaply

Recall cannot be computed exactly, the same circularity the survey notes. Three proxies:

- **Seeded duplicates.** Mine history for pages that were merged or deleted as duplicates, and add synthetic ones (copy a page, retitle, paraphrase the summary, rename an entity). Report the share proposed, broken down by which key caught each. This is an optimistic PC estimate, like PC itself.
- **Sample audit of the unproposed.** Sample pairs the blocker did not propose, stratified by embedding-similarity band (high-similarity unproposed pairs are where misses hide), and have an LLM or a human judge them. Report counts and sample size, not a bare percentage.
- **A loose second blocker as referee** (our suggestion; no cited source validates it here). Periodically run a generous blocker (top-30 embedding neighbours, no purging) and judge only pairs it proposes that production did not. The duplicate yield estimates what production misses, in the manner of capture-recapture.

Report these with PQ (the share of proposals the agent merged or linked). Very low PQ means the cap is too loose; low seeded PC means a key is missing.

### 4.4 What the agent sees per candidate

Put in the input everything code can determine, so the agent spends effort on judgment:

- **Both pages' identifying text**: title, index summary, and the full page if short or headings plus first section if long.
- **Why the pair was proposed**: shared rare terms, matching identifiers, similarity score, which keys fired. This helps the agent spot coincidences ("both cite the same tool").
- **Last-updated dates and status.** Many apparent duplicates are an old page superseded by a newer one: archive-and-link, not merge.
- **Existing links between the two pages**, and any prior decision on this pair.
- **A fixed decision menu**: merge (naming the surviving page), keep separate (with the distinguishing reason), or link only, with supporting quotes required.

Keep prompts small and mind position effects ([Wang et al.](https://arxiv.org/abs/2405.16884); [Liu et al.](https://arxiv.org/abs/2307.03172)): judge one candidate or small cluster per call, or shuffle order across runs.

### 4.5 Failure modes

| Failure mode | Cause | Mitigation |
|---|---|---|
| Stopword-like terms flood candidates | The project's own name is on most pages | Block purging by document frequency, IDF weighting, largest-block check ([Papadakis et al.](https://arxiv.org/abs/1905.06167)) |
| Synonyms and renames missed | Lexical keys need shared words | Add embedding neighbours, alias lists from past renames, identifier keys that survive renames |
| Identifier false positives | Two unrelated pages cite the same large PR as context | Treat identifiers as evidence to review, not auto-merge |
| Transitive clusters | A matches B, B matches C, but A and C differ | Form connected components of accepted pairs, present clusters as a unit, cap size, cut big components at the weakest edge. Selecting among candidates jointly beat isolated pairs in [Wang et al.](https://arxiv.org/abs/2405.16884) |
| Agent rubber-stamps merges | Framing implies candidates are probably duplicates; no explicit default | Make "keep separate" the stated default, require quotes, seed known non-duplicate control pairs and monitor how often they get merged (our suggestion), gate destructive merges |
| Recall silently capped | Over-strict keys | The audit in 4.3; prefer more redundant keys |
| Anchoring | Told "only these", the agent stops looking | A small budgeted escape hatch to report extra related pairs; treat reports as blocker-miss data |

### 4.6 Reproducible, diffable runs

Write the candidate list (page IDs, scores, firing keys) to a file kept with the run's log. Then two runs on the same memory give the same candidates, so variation is confined to judgments; a change in candidates maps to a change in the memory or blocker config, while a changed decision on an unchanged pair is model variance, which you can estimate by judging a sample twice. The seeded gold set can run as a small regression check on every blocker change, and cost is known before any model call. None of this holds when the agent scans the index itself, because its candidate set is an unlogged side effect of attention.

## 5. When Not to Pre-Gather

Pre-gathering fits needs that code can determine: an item's identifying terms, the identifiers it mentions, the pages sharing them. It is the wrong tool when:

- **The need depends on what the agent discovers.** In open-ended exploration ("why did this design drift over the quarter?") each question depends on the last answer; give the agent search tools.
- **No key exists for the relationship.** For conceptual relations ("which pages contradict each other's assumptions?") a lexical blocker will systematically not propose the pairs, and embeddings only partly help: similar pages are not necessarily contradictory ones.
- **The corpus fits in context.** A few dozen pages can simply be read in full.
- **A miss is far costlier than an extra judgment and you cannot audit recall.** For a one-off cleanup a careful full scan may be safer, with the blocker reserved for the routine job.
- **An independent look is the point.** Evidence anchors conclusions; a reviewer meant to find what the candidate list omitted should work without it.

A workable compromise is layered: deterministic rules first, a blocker-fed judge for the routine job, a periodic loose-blocker referee, and an escape hatch for the agent to say "this looks related to something not on my list."

## Conclusion

Entity resolution has always separated candidate generation from matching, and the LLM-matcher literature keeps that split: the model improves the matcher, while the blocker still bounds cost and recall. Agent memory systems that publish their mechanisms retrieve existing memories by code before the model decides. A periodic tidy of a markdown memory is a deduplication self-join and should borrow the same discipline: a union of cheap keys, purging of flooding keys, per-page and per-run caps, a measured recall estimate, and per-candidate evidence. The model keeps what it is good at, judging whether two pages are the same thing, and stops silently enumerating pairs.

## References

1. G. Papadakis, D. Skoutas, E. Thanos, T. Palpanas. [A Survey of Blocking and Filtering Techniques for Entity Resolution](https://arxiv.org/abs/1905.06167). arXiv:1905.06167 (v4, 2020).
2. P. Christen. [A Survey of Indexing Techniques for Scalable Record Linkage and Deduplication](https://dl.acm.org/doi/10.1109/TKDE.2011.127). IEEE TKDE 24(9), 2012.
3. M. Hernández, S. Stolfo. [The Merge/Purge Problem for Large Databases](https://dl.acm.org/doi/abs/10.1145/568271.223807). SIGMOD 1995.
4. J. Leskovec, A. Rajaraman, J. Ullman. [Mining of Massive Datasets, Chapter 3: Finding Similar Items](http://infolab.stanford.edu/~ullman/mmds/ch3n.pdf).
5. Splink documentation. [Blocking rules topic guide](https://moj-analytical-services.github.io/splink/topic_guides/blocking/blocking_rules.html).
6. dedupe. [dedupeio/dedupe on GitHub](https://github.com/dedupeio/dedupe).
7. pyJedAI. [AI-team-UoA/pyJedAI on GitHub](https://github.com/AI-team-UoA/pyJedAI).
8. S. Thirumuruganathan et al. [Deep Learning for Blocking in Entity Matching: A Design Space Exploration](http://vldb.org/pvldb/vol14/p2459-thirumuruganathan.pdf). PVLDB 14(11), 2021.
9. N. Zeakis, G. Papadakis, D. Skoutas, M. Koubarakis. [Pre-trained Embeddings for Entity Resolution: An Experimental Analysis](https://arxiv.org/abs/2304.12329). PVLDB 16(9), 2023.
10. A. Narayan, I. Chami, L. Orr, S. Arora, C. Ré. [Can Foundation Models Wrangle Your Data?](https://arxiv.org/abs/2205.09911) PVLDB 16(4), 2023.
11. R. Peeters, A. Steiner, C. Bizer. [Entity Matching using Large Language Models](https://arxiv.org/abs/2310.11244). EDBT 2025.
12. T. Wang et al. [Match, Compare, or Select? An Investigation of Large Language Models for Entity Matching](https://arxiv.org/abs/2405.16884). COLING 2025.
13. M. Fan et al. [Cost-Effective In-Context Learning for Entity Resolution: A Design Space Exploration](https://doi.org/10.1109/ICDE60146.2024.00284). ICDE 2024.
14. [Cost-Efficient RAG for Entity Matching with LLMs: A Blocking-based Batch Processing Framework](https://arxiv.org/abs/2602.05708) (CE-RAG4EM). arXiv:2602.05708, 2026.
15. P. Chhikara et al. [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/abs/2504.19413). arXiv:2504.19413, 2025.
16. [Zep: A Temporal Knowledge Graph Architecture for Agent Memory](https://arxiv.org/abs/2501.13956). arXiv:2501.13956, 2025; and the open-source [Graphiti node_operations.py](https://github.com/getzep/graphiti/blob/main/graphiti_core/utils/maintenance/node_operations.py).
17. W. Xu et al. [A-MEM: Agentic Memory for LLM Agents](https://arxiv.org/abs/2502.12110). arXiv:2502.12110 (NeurIPS 2025).
18. LangMem. [Conceptual guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/) and [knowledge/extraction.py](https://github.com/langchain-ai/langmem/blob/main/src/langmem/knowledge/extraction.py).
19. Letta. [Memory documentation](https://docs.letta.com/guides/agents/memory).
20. N. Liu et al. [Lost in the Middle: How Language Models Use Long Contexts](https://arxiv.org/abs/2307.03172). TACL 2024.
