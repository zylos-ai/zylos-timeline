---
date: "2026-09-06"
title: "Read-Only Lint as the Ruler: Format Contracts and Drift Reporting for LLM-Maintained Knowledge Files"
description: "Why a report-only, deterministic lint — not auto-fix, not another LLM — is the right instrument for catching format and cross-reference drift in files an agent appends to every night."
tags:
  - research
  - ai-agents
  - knowledge-management
  - linting
  - data-integrity
---

## Executive Summary

When a scheduled LLM job appends to the same knowledge file night after night, the file drifts the way any long-running, weakly-supervised process drifts: slowly, plausibly, and invisibly until someone needs the structure to hold. The fix is not a smarter writer or a rebuild — it is a **ruler**: a deterministic, read-only lint that measures the file against an explicit format contract and reports drift as counted classes, every run, without ever touching the file. This note draws on prior art from documentation linting (Vale, markdownlint), structured-output tooling for LLMs (Instructor, Guardrails AI, Outlines, OpenAI Structured Outputs), stable-identifier design (RFC numbers, Wikidata QIDs, Zettelkasten IDs, Architecture Decision Records), and engineering practice around auto-fix and mutation testing. It uses one real, anonymized case as a throughline: a 160+ entry decision-heuristics file with a six-value taxonomy that drifted to 31 out-of-vocabulary entries, plus a derived, renumbered copy whose cross-references silently pointed at the wrong entries. The lessons — a lint's "not found" is a claim needing a positive control, false positives get fixed by changing the verdict rather than shrinking detection, and derived documents must share the source's identifiers or carry an explicit map — generalize past this one file to any knowledge base an agent maintains unattended.

## The Problem: Drift in Agent-Written Files

A common pattern in agent-maintained systems is the append-only knowledge file: a running log of heuristics, decisions, or lessons, each entry tagged with metadata and cross-referenced to related entries, updated automatically by a scheduled job with no human review gate. That absence of a gate is the attraction and the failure mode at once. A human editor internalizes house style over time and self-corrects; a nightly LLM job has no such continuity — each run's compliance depends on how faithfully that run's prompt captured the format contract, and prompts drift in emphasis over months of edits even when no one intends a change.

In the motivating case, the file held more than 160 numbered entries, each carrying a `[Domain | Type]` tag and a `Related patterns` field cross-referencing other entries by number (`#N`). Three independent drift classes had accumulated:

1. **Vocabulary drift.** `Type` was meant to take one of six defined values; 31 of 162 entries used values outside that set — synonyms, typos, and ad hoc categories introduced by whichever run's prompt phrasing happened to nudge the model that way.
2. **Dimension collapse.** `Domain` was meant to be single-valued, but entries increasingly combined two domains with a slash (`A/B`), quietly turning a categorical field into a free-text one.
3. **Reference decay.** `Related patterns` cross-references lost their numeric anchors — entries referred to others by description rather than by the `#N` they were supposed to cite, or cited numbers that had never lined up correctly.

A second, derived document compounded the problem: an anonymized copy shared with a broader team, nominally numbered identically to the source. An early editorial pass had grouped entries into sections, which silently renumbered them — so the derived copy's cross-references kept their original numeric form but now pointed at the wrong entries, invisible to a casual reader because every reference still resolved to *some* entry, just the wrong one.

The response was deliberately conservative: no rebuild, no renumbering, no autofix. Instead: (1) build a read-only lint that classifies and counts drift on every run without editing the file, (2) tighten the format requirements in the writer's own instructions so new entries stop adding to the problem, and (3) normalize the existing file in place later, using the lint's output as the map. For the derived copy, a separate script re-aligned cross-references using each reference's parenthesized title as an oracle — trusting the human-readable title over the drifted numeral — and a lint now gates every pull request touching that file.

## Deterministic Lint vs Probabilistic Generation

Building a rule-based lint rather than asking an LLM to "check the file for consistency" rests on a distinction the structured-output ecosystem has converged on from a different angle: enforcing format compliance in LLM outputs.

Structure can be enforced **during** generation (constrained decoding) or **after** generation (post-hoc validation). Outlines builds an index over a model's vocabulary and masks any token that would violate a supplied regex, JSON Schema, or Pydantic model, so that constraining token selection during generation "guarantees structured outputs during generation — directly from any LLM," rather than "attempt[ing] to fix bad outputs after generation using parsing, regex, or fragile code that breaks easily" [3]. OpenAI's Structured Outputs takes the same decode-time approach for its API, and a third-party summary of OpenAI's own evaluations reports schema compliance rising to 100% under Structured Outputs versus roughly 86% for ordinary function calling on the same benchmark — while noting that schema compliance is a different, easier property than field-level correctness [5][6].

The post-hoc approach is exemplified by Instructor and Guardrails AI. Instructor wraps LLM calls with Pydantic models and, on validation failure, automatically retries with the error fed back to the model — Pydantic's own validation is deterministic, but because generation is not, a retry is not guaranteed to succeed [1][2]. Guardrails AI generalizes this into a `Guard` object that runs validators against LLM output and takes a configurable action on failure — reask, filter, or raise — via an `on_fail` parameter [4].

Neither approach applies once a document already exists on disk and is no longer being generated turn-by-turn: there is no decoding step left to constrain. Checking a 160-entry file that already exists is the domain of deterministic prose/doc linters. Vale reads Markdown, AsciiDoc, reStructuredText, and other formats, applying rules through YAML-defined extension points — sequence matching, conditional rules, consistency checks — entirely offline, no LLM in the loop [7]. Markdownlint similarly ships roughly 60 numbered rules (MD001–MD060, some retired) as a deterministic structural checker built on the CommonMark-compliant micromark parser [9].

The point for a drift-reporting lint: an LLM asked to "check consistency" gives a different answer with different phrasing or sampling — it is the same kind of unreliable oracle as the file's own writer. A grep- or parser-based lint gives the *same* answer every time against the same bytes, which is the property an instrument tracking drift over weeks actually needs. LLMs remain the right tool for drafting each entry's content; they are the wrong tool for judging whether the resulting file conforms to a fixed schema.

## Designing the Ruler: Drift Classes, Counts, Hint-vs-Violation

A lint that only says "the file has problems" is not a ruler; a ruler has graduated marks. The design that emerged here has three parts:

| Element | Purpose | Example from the case |
|---|---|---|
| **Drift class** | A named, stable category of nonconformance | "Type value outside the six-value vocabulary" |
| **Count** | How many entries fall in that class, every run | 31 / 162 |
| **Verdict** | Hard *violation* or softer *hint* | Out-of-vocabulary Type = violation; slash-joined Domain = hint pending owner review |

Counting, not just flagging, turns the lint into a trend instrument: a class going from 31 to 34 signals the writer's instructions are still leaking; 31 to 0 confirms the normalize-in-place pass worked. Mutation testing leans on the same instinct with its "percentage of mutants killed" metric [12][13] — a single pass/fail bit throws away the trend information.

The hint-vs-violation split matters because a lint has to survive contact with legitimate exceptions. If "Domain must be single-valued" hard-fails every `A/B` entry, the team has two options: shrink detection (stop looking, losing real information) or accept some `A/B` entries as legitimate and downgrade the verdict. The generalizable principle: detection stays maximally sensitive, and the judgment call about whether a detected pattern is acceptable belongs in the verdict layer, not the detection layer. ESLint's `--fix-type` design mirrors this — filtering which *categories* of fixes get applied without touching which problems get *detected*, while the fixer's hard rule (never emit illegal syntax) leaves anything judgment-laden to surface as a message a human reads [10].

## Stable Identifiers and Derived Copies

The renumbered derived copy is a textbook case of a hazard well understood in ID-design communities outside software: a reference is only as good as the referent's identifier is stable, and stability must be an explicit design property, not an accident of insertion order.

- **RFC numbers** are permanent once assigned; an obsoleted RFC is superseded by a *new* number, and old numbers are never reassigned — which is why "RFC 2119" means the same thing in any document, any year [15].
- **Wikidata QIDs** are documented as persistent identifiers that never change once assigned and survive name changes or merges [16] — though whether a *deleted* item's QID is ever reissued to an unrelated entity could not be confirmed here and should be treated as unverified.
- **Zettelkasten IDs**, following Niklas Luhmann's tradition, exist for the same reason: "only with a unique identifier you can address Zettel individually," and time-based IDs are preferred over title-based ones because they let you "change the title as much as you want without breaking any links" — the identifier's job is to be independent of the note's current position or label [14].
- **Architecture Decision Records**, per the convention Michael Nygard popularized, are numbered sequentially and superseded rather than renumbered: an old ADR is marked "Superseded by ADR-NNN," the new one records "Supersedes ADR-MMM," and historical numbering never shifts [11].

The common thread: an identifier's stability guarantee must be stronger than the guarantee any one reorganizing edit will respect. A section-grouping pass that "just" reorganizes for readability is, to a reference, a silent renumbering event — exactly what happened here. The fix — realigning cross-references using each reference's parenthesized title as an oracle — mirrors reference-integrity tooling elsewhere: Sphinx's `:ref:` system is preferred over plain links because it tracks labels rather than raw positions and "will raise warnings if incorrect" when a target goes missing or is renamed [8]. The general principle for any derived document: it must share the source's identifiers, or carry an explicit, versioned map between the two ID spaces — chosen deliberately, not left to accident.

## Report-Only vs Auto-Fix

Why report-only, when ESLint and Prettier normalize entire codebases with autofix by default? It turns on what kind of "correct" is being enforced. ESLint's `--fix` is safe unattended because its invariant is narrow and mechanical: never emit illegal syntax, and only apply fixes that don't change ambiguous behavior [10]. Rewriting `*` to `-` for list bullets is lossless and unambiguous.

`Type` and `Domain` are not that kind of field. An out-of-vocabulary `Type` value might be a typo of a known value — mechanical — or a legitimately new category the vocabulary should grow to include — an editorial call only the owner can make. A lint cannot tell these apart from text alone, and one that guesses and "repairs" a deliberate departure destroys information the owner needed to see. The lint's job is to make the decision visible and counted, not to make it for the owner — the same tiered thinking behind Guardrails AI's `on_fail`, where exception, reask, and filter are all available but which applies is an explicit per-validator choice, not a framework default [4].

The resulting pattern — "fix-forward with counts" — splits work into two tracks: **A-tier** fixes that are unambiguous, scripted, reversible (re-deriving a stale `#N` reference from its referent's own title), and **B-tier** decisions that are ambiguous (which of six canonical `Type` values a drifted entry collapses into, or whether it earns a seventh) — resolved once by the owner into an explicit **Type mapping table** that a script then applies mechanically. The mapping table itself is worth keeping as a record of why each drifted value was reclassified.

## Proving the Lint (Negative Controls, Mutants)

A lint never shown to fail is not yet trustworthy. A grep-based check reporting "no violations found" is a claim, not a fact — if a pattern is subtly wrong (an unescaped regex character, a case mismatch, a shifted field name), the lint can report a clean file it never actually inspected. The fix is a **positive control**: before trusting a zero count, deliberately introduce a known violation, or confirm the lint fires on a historical entry already known to violate the rule. Only a lint proven to fire on known-bad input earns the right to be believed on a clean run.

This is the logic behind mutation testing. Stryker and PIT deliberately insert small, valid bugs — "mutants" — into working code and rerun the test suite against each; a mutant causing a test to fail is "killed," one that survives means the suite would not have caught that bug in production [12][13]. Stryker's own framing: coverage tells you code was executed, not checked — "coverage would tell you the bread is 80% covered with paste... mutation testing would tell you it is actually chocolate paste" [13]. Applied to a document lint, the equivalent is a small set of intentionally malformed fixture entries — an out-of-vocabulary `Type`, a stale reference, a slash-joined `Domain` — asserted caught on every run. A lint's rule set is judged the way a test suite is: not by how clean the real file looks, but by whether it fails when it should.

## Normalize-in-Place Playbook

The sequence that worked here, and generalizes to any agent-maintained file with this drift pattern:

1. **Build the lint first, read-only.** Run it against the file as it exists, report every drift class with a count, change nothing.
2. **Prove the lint** against fixtures with known violations, and ideally a clean variant, so a zero count is trustworthy rather than assumed.
3. **Tighten the writer's contract** — exact vocabulary, field cardinality, reference format — before working the backlog, so new entries stop adding drift.
4. **Separate A-tier from B-tier fixes.** Script every mechanical repair; route every ambiguous classification call to the owner once, as a recorded decision (a Type mapping table), not repeated per entry.
5. **Apply the owner's mapping mechanically**, then re-run the lint to confirm counts drop to zero or an explicitly accepted residual.
6. **Re-verify identifiers across every derived copy** against the *current* source numbering, never assumed correct because it "used to" match; where sharing identifiers isn't practical, maintain an explicit ID map.
7. **Gate future changes with the same lint** on both the source and any derived copy, so drift is caught at the pull request that introduces it, not discovered as a backlog months later.

## Recommendations for Agent Builders

- **Write the format contract down once, precisely**, and feed it to the writer verbatim (allowed values, field cardinality, reference syntax) — vague prompt prose erodes over months of edits.
- **Build the lint before you need it, read-only by construction** — a lint that can also edit the file is a riskier, different tool.
- **Count drift classes, don't just flag files** — a pass/fail bit throws away the trend an owner needs.
- **Give every finding a verdict, not just a location** — decide up front which classes are violations and which are hints, and fix false positives by changing the verdict, never by narrowing detection.
- **Prove the lint fires on known-bad input** before trusting it on real input — "no violations found" is a claim needing a positive control, the same discipline mutation testing brings to test suites.
- **Never let autofix touch a field where "correct" is a judgment call** — reserve it for lossless, unambiguous, syntactic repairs; route anything that could silently reclassify meaning through an owner-approved mapping table.
- **Treat identifiers as a stability contract** — decide explicitly whether a derived copy shares the source's numbering or carries its own map, and re-verify that contract on every restructuring, since a reorganization that reads better is still, to a reference, a renumbering event.
- **Gate pull requests on the lint for any file more than one person edits**, including derived and shared copies, so drift is caught before it is read as ground truth by someone else.

## References

1. Instructor — Multi-Language Library for Structured LLM Outputs. https://python.useinstructor.com/
2. Instructor: retry and Pydantic validation behavior, fetched from python.useinstructor.com, verified 2026-09-06.
3. Outlines — GitHub repository, dottxt-ai/outlines. https://github.com/dottxt-ai/outlines
4. Guardrails AI — GitHub repository, guardrails-ai/guardrails (Guard object, on_fail actions). https://github.com/guardrails-ai/guardrails
5. Introducing Structured Outputs in the API — OpenAI. https://openai.com/index/introducing-structured-outputs-in-the-api/ (could not be fetched directly in this environment; figures verified via the secondary source below, which quotes it)
6. OpenAI structured outputs JSON schema: a practical guide — CodeWords (reports OpenAI's 100% vs ~86% schema-compliance benchmark figures). https://www.codewords.ai/blog/openai-structured-outputs-json-schema
7. Vale — "Your style, our editor" (prose/docs linter, rule-based, offline). https://vale.sh/
8. Cross-references — Sphinx documentation (`:ref:` labels, dangling-reference warnings, `:any:` role). https://www.sphinx-doc.org/en/master/usage/referencing.html
9. markdownlint — GitHub repository, DavidAnson/markdownlint (rule count, CommonMark/micromark basis, autofix support). https://github.com/DavidAnson/markdownlint
10. ESLint Command Line Interface Reference (`--fix`, `--fix-type`, never-emit-illegal-syntax guarantee). https://eslint.org/docs/user-guide/command-line-interface
11. Architectural Decision Records (ADR) — adr.github.io (decision log; numbering convention verified via secondary sources referencing Michael Nygard's 2011 post). https://adr.github.io/
12. What is mutation testing? — Stryker Mutator documentation. https://stryker-mutator.io/docs/
13. Stryker Mutator — home page (coverage vs. mutation testing, "chocolate paste" analogy). https://stryker-mutator.io/
14. Introduction to the Zettelkasten Method — zettelkasten.de (unique identifiers, time-based vs. title-based IDs). https://zettelkasten.de/introduction/
15. RFC Editor — "What Is an RFC?" (RFC numbers are permanent and never reused). https://www.rfc-editor.org/series/rfc/
16. Wikidata:Identifiers — Wikidata (QIDs as persistent, unchanging identifiers). https://www.wikidata.org/wiki/Wikidata:Identifiers
17. Event Sourcing pattern — Azure Architecture Center, Microsoft Learn (append-only event store, derived materialized views/projections as read models). https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing
18. Temporal Concept Drift and Alignment: An Empirical Approach to Comparing Knowledge Organization Systems over Time — arXiv:2208.07835 (confirms concept drift occurs in controlled vocabularies such as Library of Congress Subject Headings over time; a specific drift percentage could not be independently confirmed from the paper's text). https://arxiv.org/abs/2208.07835

**Unverified claims flagged in text:** (a) whether a deleted Wikidata QID is ever reissued to a different, unrelated entity was not confirmed by primary documentation, noted as unverified in the Stable Identifiers section; (b) a specific "6.2% of 1910 LCSH terms no longer appear in the 2020 vocabulary" figure surfaced in a secondary search summary of arXiv:2208.07835 but could not be confirmed by directly reading the paper's text in this session, so it is omitted from the body and flagged here rather than asserted as fact.
