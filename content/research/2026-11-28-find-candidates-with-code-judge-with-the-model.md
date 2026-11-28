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
- **Agent memory systems already do this for "update or create".** Mem0 retrieves the top similar memories by embedding, then the LLM chooses ADD, UPDATE, DELETE or NOOP. The Zep paper gathers entity candidates by cosine and full-text search before an LLM resolves duplicates; the current Graphiti code uses identity-property, exact-name and cosine lookups, applies deterministic rules, and sends only unresolved nodes to the LLM. A-MEM and LangMem follow the same shape. None of the sources reviewed reports a measured recall for that retrieval step.
- **For a few hundred to a few thousand short pages, use a union of cheap keys:** IDF-weighted rare shared terms, extracted identifiers (PR or issue numbers), entity names, and optionally embedding neighbours. Purge stopword-like keys, enforce per-page and per-run bounds on the pairs actually judged (a per-page top-k list alone does not bound them), and queue deferred pairs so they advance. Connected components of accepted pairs are evidence to review, not authority to merge.
- **Measure the blocker, not just the agent.** Report duplicate precision against independent labels, separately from how often the agent merged or linked; seed known duplicates and audit a sample of pairs the blocker did *not* propose. Log the candidate universe and each run's dispatch batch so runs are reproducible and diffable.
- **Do not pre-gather when the need is not code-determinable.** Open-ended exploration is better served by search tools the agent drives itself.

## 1. Background: Blocking in Entity Resolution

### 1.1 Why all-pairs does not scale

Entity resolution (record linkage, deduplication) asks which records describe the same real-world thing. Comparing every record with every other costs n(n-1)/2 comparisons. Splink's documentation illustrates: one million records yield about 500 billion pairwise comparisons, "the vast majority" of which will not be matches ([Splink blocking guide](https://moj-analytical-services.github.io/splink/topic_guides/blocking/blocking_rules.html)).

Memory corpora are far smaller, but the arithmetic still bites once an LLM is the comparator: 500 pages give 124,750 pairs, 2,000 pages give 1,999,000. Code scores two million pairs in seconds; no LLM budget can read them, and an LLM asked to find them implicitly by reading an index will not do so reliably.

Blocking is the standard answer. A comprehensive survey describes it as grouping potentially matching entities into common blocks and comparing only within blocks, often repeating block building with several schemes "to achieve a more robust performance in the context of highly noisy data" ([Papadakis et al., 2020](https://arxiv.org/abs/1905.06167)). Christen's survey describes indexing techniques as reducing the comparisons in the matching step by discarding pairs that are obviously not matches, without sacrificing matching quality ([Christen, 2012](https://doi.org/10.1109/TKDE.2011.127)).

### 1.2 Families of blocking

- **Standard blocking.** Records sharing a computed key (for example a normalized title prefix) form a block. Weakness: depends heavily on the key's frequency distribution; skewed keys give huge blocks, and typos split true matches.
- **Sorted neighbourhood.** Sort by key and compare within a sliding window of size w ([Hernández and Stolfo, 1995](https://dl.acm.org/doi/abs/10.1145/568271.223807)). Weakness: small w gives low recall, large w low efficiency.
- **Token blocking.** One block per distinct token anywhere in a record. Weakness: very high completeness, but very low pairs quality and reduction ratio unless blocks are cleaned.
- **Q-gram / suffix.** Blocks over character n-grams or suffixes. Weakness: robust to spelling variation, but more comparisons.
- **MinHash + LSH.** Similar set signatures collide in at least one band. Weakness: probabilistic; misses pairs near the threshold.
- **Embedding nearest neighbour.** Index vectors and take the k nearest per record. Weakness: needs an embedding model; k is a recall/cost dial.

(Weaknesses for the first four families follow [Papadakis et al.](https://arxiv.org/abs/1905.06167).)

**Token blocking and its stopword problem.** Token blocking pairs records that share any token. The survey notes that large blocks "are typically produced by lazy schema-agnostic techniques and correspond to stop words," and describes *block purging* (discard blocks above a size limit) and *block filtering* (keep each entity only in its smallest blocks). This is the ER ancestor of IDF weighting: a token shared by thousands of records says little, one shared by two says a lot.

**Meta-blocking.** The co-occurrence structure becomes a graph whose edges (candidate pairs) are weighted by evidence, such as the number of common blocks, and weak edges are pruned. Cardinality Node Pruning "retains the top-k weighted edges in each node neighborhood", while reciprocal variants keep only edges "satisfying the pruning criteria in both adjacent node neighborhoods" ([Papadakis et al.](https://arxiv.org/abs/1905.06167)). The difference matters for capping (Section 4.2): an edge kept because it ranks in either endpoint's top k does not bound how many edges a node ends up with, while requiring both endpoints does.

**MinHash/LSH.** Items are reduced to shingle sets and minhash signatures, split into b bands of r rows. Two items become a candidate pair if they collide in any band; the probability at Jaccard similarity s is 1 - (1 - s^r)^b, an S-curve whose threshold (where it rises most steeply) is approximately (1/b)^(1/r) ([Mining of Massive Datasets, ch. 3, §3.4.2](https://web.archive.org/web/20241117104301/http://infolab.stanford.edu/~ullman/mmds/ch3n.pdf); book site [mmds.org](http://www.mmds.org/)). For a few thousand pages this is likely more machinery than needed.

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

The cost papers supply the end-to-end framing. Fan et al. (ICDE 2024) write that "An end-to-end ER system consists of a blocker and a matcher" and leave blocking design out of scope, using a standard blocking method to produce the candidate pairs (Section II-A of the [arXiv version](https://arxiv.org/abs/2312.03987)). Their introduction (Example 1) prices the unblocked case: a table of 1,000 records needs about 500,000 predictions, and at about 90 tokens per pair, standard prompting with 3 demonstrations and 1 question costs $1,800 at GPT-4's then price of $0.01 per 1K tokens. Their experiments then judge blocked candidate sets, for example 9,575 pairs on Abt-Buy (Table II). The dollar figure is dated; the structure holds: cost is pairs times tokens per pair, so the blocker's output size is the budget.

A 2026 retrieval-augmented matching paper reuses blocking groups as batching units, splitting any group larger than a maximum batch size (6 pairs by default). Its batch-size sensitivity study, which varies that maximum for batch *retrieval* over 2, 4, 6 and 8, finds 4 or 6 the best balance of F1 against retrieval calls (§5.5). A separate token-cost comparison finds that batch *generation*, one prompt answering every pair in a batch, cuts output to about 90 tokens per pair and total cost roughly 4.5 times (§5.3.2), while the efficiency analysis warns that it can lower precision through "cross-pair coupling" (§5.3). On blocking, exact token-based blocking "can fragment near-duplicates into different blocks", and Q-gram methods beat standard blocking on most datasets (§5.4.2) ([CE-RAG4EM](https://arxiv.org/abs/2602.05708)).

### 2.2 Judging a candidate list, not isolated pairs

Wang et al. compare pairwise matching, comparing, and *selecting* the match from an anchor's candidate list. Across 8 ER datasets and 10 LLMs, selecting beat standalone pairwise matching and was often the most cost-effective, but selection accuracy varied significantly with the position of the true match in the list (position bias). They note that "the recall-oriented blocking step often generates a considerable number of potential matches for each record, exceeding the context length that LLMs can effectively reason" (§3.4), so they propose a medium model to rank and filter, and a stronger one to select among the top few ([COLING 2025](https://arxiv.org/abs/2405.16884)). Lesson: show the agent a small, ordered or shuffled candidate set, not whatever the blocker spills out. This echoes findings that models use the start and end of long inputs better than the middle ([Liu et al., 2024](https://arxiv.org/abs/2307.03172)); handing the agent a whole index is the worst case.

### 2.3 The blocker caps recall

End-to-end recall is bounded by the blocker's pair completeness; a pair never proposed receives no judgment however capable the model. Consequences: measure blocker recall (Section 4.3); prefer several redundant keys over one clever key, since schema-aware keys are "quite parameter-sensitive" and when poorly chosen leave "most duplicates" in no common block, while schema-agnostic redundancy gives robustness ([Papadakis et al.](https://arxiv.org/abs/1905.06167)); and accept low reduction ratio, then clean candidates (purging, per-node top-k) to recover efficiency.

## 3. How Agent Memory Systems Handle Consolidation Today

Does code retrieve candidate memories before the LLM decides? We checked papers and source code. Where the mechanism is published, yes.

- **Mem0** ([paper](https://arxiv.org/abs/2504.19413)). *Code:* retrieves the top s similar memories by vector embedding (s = 10 in the paper's experiments). *LLM:* chooses ADD, UPDATE, DELETE or NOOP via a tool call; no separate classifier.
- **Zep, as described in the paper** ([paper](https://arxiv.org/abs/2501.13956), §2.2.1). *Code:* cosine similarity search over existing entity nodes plus a separate full-text search on entity names and summaries. *LLM:* an entity-resolution prompt over those candidates; when it finds a duplicate, the paper says the system generates an updated name and summary.
- **Graphiti, as implemented** ([node_operations.py at commit 869c1b2](https://github.com/getzep/graphiti/blob/869c1b279e01a2767a464581e1cb657ce0e39271/graphiti_core/utils/maintenance/node_operations.py)). *Code:* identity-property lookup, exact-name lookup and cosine similarity search per extracted node, merged and deduplicated; deterministic identity and similarity rules then resolve what they can. *LLM:* for each still-unresolved node, returns the ID of the duplicate candidate or -1 for none. The resolution code acts on that ID; summaries come from a separate summarization path.
- **A-MEM** ([paper](https://arxiv.org/abs/2502.12110)). *Code:* cosine similarity of the new note against all notes, top-k (k = 10 in the paper). *LLM:* which links to create, and whether to update neighbours' context, keywords and tags.
- **LangMem** ([concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/); [source](https://github.com/langchain-ai/langmem/blob/main/src/langmem/knowledge/extraction.py)). *Code:* the store manager runs semantic search by embedding windows of recent messages (query_limit default 5), or an LLM-written query; it dedupes and keeps top results. *LLM:* the memory manager receives existing memories plus the conversation and returns updates.
- **Letta** ([docs](https://docs.letta.com/guides/agents/memory)). *Code:* the documentation reviewed describes agents editing memory blocks via tools and no automated candidate retrieval for dedup. *LLM:* the agent decides.

Three observations.

**The pattern is retrieval-then-judge, with "retrieval" meaning similarity search.** Mem0 and A-MEM use dense embeddings alone. The Zep paper combines embeddings with full-text search, and the Graphiti code combines embeddings with exact-name and identity-property lookups: in both, the hybrid redundancy the ER literature recommends. The Graphiti code also lets deterministic rules resolve what they can and sends only the remaining unresolved nodes to the LLM (its resolver's docstring: "identity rule, similarity rule, then LLM"). Candidates, rules, then judgment: that three-stage shape suits a memory tidy.

**These designs are per-item at write time, not whole-corpus at tidy time.** They answer "does this new fact already exist?" over a small, query-driven candidate set. A periodic "which pages overlap?" job is a self-join, a classic deduplication problem for which the ER blocking literature is the better guide.

**Retrieval quality is rarely reported on its own.** The Mem0 paper evaluates question answering, latency and tokens, not the recall of its candidate-retrieval step; we found no measured pair completeness for that stage in any source above. Adopters should measure it.

## 4. A Practical Design for a Markdown Memory of a Few Hundred to a Few Thousand Pages

At this size any blocker finishes instantly. The problem is (a) recall, (b) a small, stable number of LLM judgments, and (c) giving the agent evidence instead of a blank search task. What follows is design advice built on the sources above; items marked "our suggestion" are not published results.

### 4.1 Blocking keys for short titles and index rows

Index rows are short, which favours token- and identifier-level keys over character-level or whole-document ones.

- **Rare shared terms (IDF-weighted)** catch pages using the same distinctive words. Compute document frequency over index rows; keep terms under a df cap or weight pairs by summed IDF. This is token blocking plus block purging.
- **Extracted identifiers** (PR or issue numbers, ticket IDs, commit hashes, file paths, URLs). Exact match, very high precision; extract from bodies, not only index rows.
- **Entity names** (people, services, repositories). Normalize case and punctuation. A name on a hundred pages is a stopword.
- **Normalized-title similarity** catches near-identical titles with small edits. A cheap Q-gram or sorted-neighbourhood pass restores recall that exact tokens lose to spelling variants (cf. Q-gram versus standard blocking in [CE-RAG4EM](https://arxiv.org/abs/2602.05708)).
- **Embedding neighbours** catch paraphrases and renames with no shared words. Embed title plus summary; take the top k per page above a similarity floor. Exact search suffices at this size.

Take the union ([DeepBlocker](http://vldb.org/pvldb/vol14/p2459-thirumuruganathan.pdf) and [Splink](https://moj-analytical-services.github.io/splink/topic_guides/blocking/blocking_rules.html) both support it) and record which key produced each candidate: it is evidence for the agent and diagnostic data for you.

### 4.2 Capping the candidate count

1. **Purge flooding keys.** Drop terms whose block exceeds a size limit, or keep only each page's few rarest keys (block purging and filtering). Check the largest blocks every run.
2. **Weight and rank pairs** by distinct keys shared, summed IDF, embedding cosine and identifier matches, as meta-blocking weights edges.
3. **Bound the selected pair set, not only each page's list.** A per-anchor top-k (each page keeps its k best partners) is not a bound on the pairs touching a page, because the union of all lists can give a hub many pairs: in a four-page star where each of the three leaves ranks the hub first, top-1 per anchor still selects three pairs, all incident to the hub. If a per-page bound is wanted, enforce it on the selected set (our suggestion): admit pairs in dispatch order (item 4) and skip a pair once either page already has k admitted pairs this run; a skipped pair stays queued, or keep only pairs in both pages' top k (the reciprocal pruning above). Add a global per-run cap so cost is predictable. No numbers are given here; choose them from the audit in 4.3.
4. **Queue what the caps defer** (our suggestion). The queue holds every pair that survived purging and scoring but was not dispatched, with its evidence and the content hashes of both pages. A pair leaves the queue only when it is judged or dropped on re-scoring. Dispatch order must advance: take queued pairs oldest first (by the run that first queued them), breaking ties by weight, so that even with a cap of one each run judges a different pair and none is starved by a stronger newcomer; a pair whose judgment fails is re-queued as if new, behind the others. An edit to either page changes its hash and invalidates the queued evidence: re-score the pair at the next blocking pass, drop it if it no longer qualifies, and otherwise keep its original queue age.
5. **Remember decisions** (our suggestion): key each verdict ("keep separate", "link") on the content hashes of both pages, so a judged pair leaves the candidate stream and returns only after either page changes. Without this, a cap of one would re-rank the same unchanged set each run and dispatch the same top pair forever.

As Splink advises, print the candidate count and largest blocks first in the job log.

### 4.3 Measuring blocker recall and precision cheaply

Recall cannot be computed exactly, the same circularity the survey notes. Precision can, on a sample, but only against the right labels.

- **Duplicate precision (PQ).** The share of proposed pairs that are true duplicates according to labels assigned independently of the agent's action: a human or a separate judge labels a random sample of proposals as duplicate, related but distinct, or unrelated. Report it next to **action yield**, the shares the agent merged and linked, given separately. Action yield is not precision: link-only is a legitimate disposition for related, distinct pages (Section 4.4), so a batch of such pages could all be linked and score 100% action yield with zero duplicate precision.
- **Seeded duplicates.** Mine history for pages that were merged or deleted as duplicates, and add synthetic ones (copy a page, retitle, paraphrase the summary, rename an entity). Report the share proposed, broken down by which key caught each. This measures recall on the chosen seeds; synthetic edits may be easier or harder to catch than organic drift, so it can be biased in either direction.
- **Sample audit of the unproposed.** Sample pairs the blocker did not propose, stratified by embedding-similarity band (high-similarity unproposed pairs are where misses hide), and have an LLM or a human judge them. Report counts and sample size, not a bare percentage.
- **A loose second blocker as referee** (our suggestion; no cited source validates it here). Periodically run a generous blocker (top-30 embedding neighbours, no purging) and judge only pairs it proposes that production did not. Duplicates found there are a diagnostic: a lower bound on production's misses. They say nothing about pairs both blockers miss, so this is not a recall estimate.

Report recall at two points: **before pruning** (share of known duplicates in the scored candidate universe, before purging and caps) and **as dispatched** (share actually sent for judgment, per run or within a stated number of runs given the queue). Low duplicate precision means the keys or cap are too loose; low seeded recall before pruning means a key is missing; a gap between the two recall figures means purging, caps or the queue are dropping or delaying duplicates.

### 4.4 What the agent sees per candidate

Put in the input everything code can determine, so the agent spends effort on judgment:

- **Both pages' identifying text**: title, index summary, and the full page if short or headings plus first section if long.
- **Why the pair was proposed**: shared rare terms, matching identifiers, similarity score, which keys fired. This helps the agent spot coincidences ("both cite the same tool").
- **Last-updated dates and status.** Many apparent duplicates are an old page superseded by a newer one: archive-and-link, not merge.
- **Existing links between the two pages**, and any prior decision on this pair.
- **A fixed decision menu**: merge (naming the surviving page), keep separate (with the distinguishing reason), or link only, with supporting quotes required.

Keep prompts small and mind position effects ([Wang et al.](https://arxiv.org/abs/2405.16884); [Liu et al.](https://arxiv.org/abs/2307.03172)): judge one candidate or small cluster per call, or shuffle order across runs.

### 4.5 Failure modes

- **Stopword-like terms flood candidates.** Cause: the project's own name is on most pages. Mitigation: block purging by document frequency, IDF weighting, a largest-block check ([Papadakis et al.](https://arxiv.org/abs/1905.06167)).
- **Synonyms and renames missed.** Cause: lexical keys need shared words. Mitigation: embedding neighbours, alias lists from past renames, identifier keys that survive renames.
- **Identifier false positives.** Cause: two unrelated pages cite the same large PR as context. Mitigation: treat identifiers as evidence to review, not grounds to auto-merge.
- **Transitive clusters.** Cause: A–B and B–C are accepted, so connected components put A, B and C together even when A–C is a known non-match (a prior "keep separate" verdict or a cannot-link rule). A size cap or a cut at the weakest edge can leave such a small component intact. Mitigation (our suggestion): use components only to present evidence, showing the agent every page in the component with all pairwise verdicts and known non-matches. Merge only on a consistent cluster-level decision: no proposed merge group may contain a known non-matching pair, and pairs inside a group that were never judged must be judged first.
- **Agent rubber-stamps merges.** Cause: the framing implies candidates are probably duplicates, with no explicit default. Mitigation: make "keep separate" the stated default, require quotes, seed known non-duplicate control pairs and monitor how often they get merged (our suggestion), gate destructive merges.
- **Recall silently capped.** Cause: over-strict keys, or caps that drop pairs. Mitigation: the audit in 4.3; prefer more redundant keys.
- **Anchoring.** Cause: told "only these", the agent stops looking. Mitigation: a small budgeted escape hatch to report extra related pairs; treat reports as blocker-miss data.

### 4.6 Reproducible, diffable runs

Log two things with each run, because they have different inputs. The **candidate universe** (every pair that survives purging and scoring, with page IDs, scores and firing keys) is a function of the memory and the blocker config alone: two runs on the same memory and config produce the same universe, and a change in it maps to a change in one of those two. The **dispatch batch** (the pairs actually sent for judgment) also depends on the queue backlog and on prior verdicts, so it is not reproducible from the memory alone; log the queue state and verdict-store version with it. Then a changed batch over an unchanged universe is explained by backlog and verdict state, and a changed decision on an unchanged pair with unchanged evidence is model variance, which you can estimate by judging a sample twice. The seeded gold set can run as a small regression check on every blocker change, and cost is known before any model call. None of this holds when the agent scans the index itself, because its candidate set is an unlogged side effect of attention.

## 5. When Not to Pre-Gather

Pre-gathering fits needs that code can determine: an item's identifying terms, the identifiers it mentions, the pages sharing them. It is the wrong tool when:

- **The need depends on what the agent discovers.** In open-ended exploration ("why did this design drift over the quarter?") each question depends on the last answer; give the agent search tools.
- **No key exists for the relationship.** For conceptual relations ("which pages contradict each other's assumptions?") a lexical blocker will systematically not propose the pairs, and embeddings only partly help: similar pages are not necessarily contradictory ones.
- **The corpus fits in context.** A few dozen pages can simply be read in full.
- **A miss is far costlier than an extra judgment and you cannot audit recall.** For a one-off cleanup a careful full scan may be safer, with the blocker reserved for the routine job.
- **An independent look is the point.** Evidence anchors conclusions; a reviewer meant to find what the candidate list omitted should work without it.

A workable compromise is layered: deterministic rules first, a blocker-fed judge for the routine job, a periodic loose-blocker referee, and an escape hatch for the agent to say "this looks related to something not on my list."

## Conclusion

Entity resolution has always separated candidate generation from matching, and the LLM-matcher literature keeps that split: the model improves the matcher, while the blocker still bounds cost and recall. Agent memory systems that publish their mechanisms retrieve existing memories by code before the model decides. A periodic tidy of a markdown memory is a deduplication self-join and should borrow the same discipline: a union of cheap keys, purging of flooding keys, per-page and per-run bounds enforced on the pairs actually judged, a queue that lets deferred pairs advance, duplicate precision and recall measured against labels, per-candidate evidence, and clusters used as evidence rather than merge authority. The model keeps what it is good at, judging whether two pages are the same thing, and stops silently enumerating pairs.

## References

1. G. Papadakis, D. Skoutas, E. Thanos, T. Palpanas. [A Survey of Blocking and Filtering Techniques for Entity Resolution](https://arxiv.org/abs/1905.06167). arXiv:1905.06167 (v4, 2020).
2. P. Christen. [A Survey of Indexing Techniques for Scalable Record Linkage and Deduplication](https://doi.org/10.1109/TKDE.2011.127). IEEE TKDE 24(9), 2012.
3. M. Hernández, S. Stolfo. [The Merge/Purge Problem for Large Databases](https://dl.acm.org/doi/abs/10.1145/568271.223807). SIGMOD 1995.
4. J. Leskovec, A. Rajaraman, J. Ullman. [Mining of Massive Datasets, Chapter 3: Finding Similar Items](https://web.archive.org/web/20241117104301/http://infolab.stanford.edu/~ullman/mmds/ch3n.pdf) (archived copy of the Stanford chapter PDF; book site [mmds.org](http://www.mmds.org/)).
5. Splink documentation. [Blocking rules topic guide](https://moj-analytical-services.github.io/splink/topic_guides/blocking/blocking_rules.html).
6. dedupe. [dedupeio/dedupe on GitHub](https://github.com/dedupeio/dedupe).
7. pyJedAI. [AI-team-UoA/pyJedAI on GitHub](https://github.com/AI-team-UoA/pyJedAI).
8. S. Thirumuruganathan et al. [Deep Learning for Blocking in Entity Matching: A Design Space Exploration](http://vldb.org/pvldb/vol14/p2459-thirumuruganathan.pdf). PVLDB 14(11), 2021.
9. N. Zeakis, G. Papadakis, D. Skoutas, M. Koubarakis. [Pre-trained Embeddings for Entity Resolution: An Experimental Analysis](https://arxiv.org/abs/2304.12329). PVLDB 16(9), 2023.
10. A. Narayan, I. Chami, L. Orr, S. Arora, C. Ré. [Can Foundation Models Wrangle Your Data?](https://arxiv.org/abs/2205.09911) PVLDB 16(4), 2023.
11. R. Peeters, A. Steiner, C. Bizer. [Entity Matching using Large Language Models](https://arxiv.org/abs/2310.11244). EDBT 2025.
12. T. Wang et al. [Match, Compare, or Select? An Investigation of Large Language Models for Entity Matching](https://arxiv.org/abs/2405.16884). COLING 2025.
13. M. Fan et al. [Cost-Effective In-Context Learning for Entity Resolution: A Design Space Exploration](https://arxiv.org/abs/2312.03987). ICDE 2024; figures cited from arXiv:2312.03987v1.
14. [Cost-Efficient RAG for Entity Matching with LLMs: A Blocking-based Batch Processing Framework](https://arxiv.org/abs/2602.05708) (CE-RAG4EM). arXiv:2602.05708, 2026.
15. P. Chhikara et al. [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/abs/2504.19413). arXiv:2504.19413, 2025.
16. [Zep: A Temporal Knowledge Graph Architecture for Agent Memory](https://arxiv.org/abs/2501.13956). arXiv:2501.13956, 2025; and the open-source [Graphiti node_operations.py at commit 869c1b2](https://github.com/getzep/graphiti/blob/869c1b279e01a2767a464581e1cb657ce0e39271/graphiti_core/utils/maintenance/node_operations.py).
17. W. Xu et al. [A-MEM: Agentic Memory for LLM Agents](https://arxiv.org/abs/2502.12110). arXiv:2502.12110 (NeurIPS 2025).
18. LangMem. [Conceptual guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/) and [knowledge/extraction.py](https://github.com/langchain-ai/langmem/blob/main/src/langmem/knowledge/extraction.py).
19. Letta. [Memory documentation](https://docs.letta.com/guides/agents/memory).
20. N. Liu et al. [Lost in the Middle: How Language Models Use Long Contexts](https://arxiv.org/abs/2307.03172). TACL 2024.
