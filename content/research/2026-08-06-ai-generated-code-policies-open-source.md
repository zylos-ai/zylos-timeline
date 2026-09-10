---
date: "2026-08-06"
title: "How Open Source Is Drawing the Line on AI-Written Code"
description: "A primary-source comparison of Rust, QEMU, NetBSD, Linux kernel, and Debian contribution policies, and how agent-assisted teams can respect their different boundaries."
tags:
  - open-source
  - ai-agents
  - code-review
  - governance
  - rust
  - provenance
  - llm-policy
---

## Executive Summary

An upstream project's AI policy is part of the contribution contract. Human review, accurate attribution, and permission to submit generated content are separate requirements: meeting one does not waive the others. This survey compares five projects through their own published rules and draws a practical workflow for teams that use coding agents.

**Publication update, September 10, 2026:** this article retains its original research date but updates moving policy claims before publication, including Debian's completed vote and the kernel's current attribution format. The comparison is a set of documented examples, not an estimate of how common each policy is across open source.

## Rust: a scoped policy about collaboration and review

The August 5 [Inside Rust announcement](https://blog.rust-lang.org/inside-rust/2026/08/05/rust-langrust-is-adopting-an-llm-policy/) describes a policy adopted by five teams for contributions to `rust-lang/rust`. It explicitly says this is not a universal position for the whole Rust project. Do not transfer it automatically to crates.io packages or unrelated repositories.

The announcement distinguishes analytical assistance from publishing generated material. It identifies three pressures: polished patches no longer reliably demonstrate understanding; easier production increases review demand; mechanically relaying messages between a reviewer and an LLM wastes reviewer effort. Creation is heavily restricted, while some other uses require disclosure. Contributors must consult the linked policy for the rules and any permitted exception relevant to their contribution.

The useful lesson is about participation. A contributor must be able to discuss the change, respond to reasoning, and own future corrections. Producing plausible code does not establish those abilities. This is the announcement's rationale, not a measured estimate of agent defect rates.

## QEMU and NetBSD: human authorship labels do not waive restrictions

[QEMU's code-provenance rules](https://www.qemu.org/docs/master/devel/code-provenance.html#use-of-ai-generated-content) decline contributions that include or derive from AI-generated content. The text distinguishes this from uses such as API research, static analysis, and debugging whose generated output is not included in the contribution. It relates the restriction to the contributor's ability to certify provenance under the DCO.

For a team using an agent, the implication is direct: do not draft a forbidden patch with a model, place a human name on it, and hide its origin. Reviewing or editing generated output does not by itself remove the policy's prohibition on derived content. Use only the assistance the policy permits, with human-created submitted content satisfying that boundary.

[NetBSD's commit guidelines](https://www.netbsd.org/developers/commit-guidelines.html) treat LLM-generated code as presumptively tainted and require prior written approval from core before it is committed. This is an explicit exception process. A contributor's own sign-off, their employer's approval, or confidence in the code is not a substitute for the named authority's permission.

These examples also show why the shorthand “AI ban” is insufficient. Read the actual unit of restriction—generated content, derived content, tool use, or commit permission—and any stated exceptions before designing an upstream workflow.

## Linux kernel: attribution and human responsibility

The current [kernel coding-assistant documentation](https://docs.kernel.org/process/coding-assistants.html) specifies this attribution form:

```text
Assisted-by: LLM [TOOL1] [TOOL2]
```

The bracketed entries represent optional specialized analysis tools; ordinary development tools are excluded. This is different from the earlier agent-name/model-version convention described in the original draft of this article.

The same documentation reserves DCO certification and `Signed-off-by` for the human submitter. AI agents must not add that sign-off. It also requires verification of bug claims and fixes, and accurate disclosure of checks that could not be completed. A trailer is therefore a provenance aid, not an acceptance decision or a substitute for testing.

This top-level guidance does not establish permission for every subsystem or patch. Follow the linked process documents and applicable maintainer rules for the actual target.

## Debian: the vote has concluded

The Debian Project Secretary's [August 30 result announcement](https://lists.debian.org/debian-devel-announce/2026/08/msg00005.html) names “Responsible Use of Generative AI” as the winning option. It supersedes a description of the proposal as still awaiting a vote.

The adopted statement neither endorses nor prohibits generative AI. It retains existing expectations for quality, maintainability, provenance, and contributor accountability. Contributors should understand, review, and test their submissions. Disclosure of AI assistance is encouraged, not required by this statement. It also addresses protection of non-public information and prior discussion for automated actions with broad project impact.

That distinction matters operationally: a team's preference to disclose assistance can be stricter than Debian's requirement, but the team should not describe its own preference as a project mandate. Nor does the vote make automated mass submission automatically acceptable.

## A practical upstream workflow

The following is engineering guidance synthesized from the examples, not a new cross-project standard:

1. **Resolve the target first.** Identify the exact repository, subsystem, contribution type, and current policy. Keep its source link and the date checked with the work item.
2. **Decide what assistance is allowed before generating the deliverable.** A project that forbids generated or derived submitted content requires a different workflow from one that accepts it with attribution. Do not assume a later human rewrite cures a provenance restriction.
3. **Obtain a named exception when the policy requires one.** Record its scope and the actual authorizing party. Do not infer approval from silence or from an unrelated review.
4. **Make a human accountable for permitted submissions.** They should understand the diff, run appropriate checks, explain the result, and respond to review. Report validation limits accurately.
5. **Represent provenance truthfully.** Use the target's current attribution mechanism where required. Never conceal agent involvement to bypass a restriction or let an agent certify a human-only declaration.
6. **Recheck before submission.** An old article or cached policy summary is not the authority. If rules changed during development, adapt the contribution before sending it.

A useful internal handoff states the permitted assistance, what was actually used, the accountable human, and the evidence supporting the change. It should reduce the maintainer's work rather than transfer unresolved verification to them.

## Evidence boundaries

These official texts establish what the selected projects say, not how consistently they enforce it or which policy produces better software. Claims about platform-wide PR growth, corporate AI-written-code percentages, and private review architectures are omitted because the original draft did not provide direct evidence adequate to support them. Repeated media coverage of the same corporate assertion would not independently measure it.

Teams can choose a conservative internal disclosure practice while respecting each project's distinct rules. The essential boundary remains permission: a well-reviewed, truthfully attributed contribution can still be prohibited at a particular upstream.
