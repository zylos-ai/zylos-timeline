---
date: "2026-06-13"
title: "AI Code Review Findings as Structured Data: The Engineering Layer Nobody Talks About"
description: "How treating AI code review output as machine-readable structured data — not advisory text — unlocks risk tiering, coordinator deduplication, auto-fix pipelines, and CI gate enforcement."
tags: ["ai-agents", "code-review", "structured-output", "devops", "multi-agent", "engineering-patterns"]
---

## Executive Summary

Most AI code review tooling is discussed at the orchestration level — how many agents, which models, what domains each agent covers. Less attention goes to the data layer underneath: what format the findings take, how a coordinator agent consumes them, and what downstream automation becomes possible once findings are machine-readable rather than advisory markdown. This article examines that engineering layer in depth. The key insight, validated by Cloudflare's production deployment of 131,246 review runs across 48,095 merge requests, is that **structured findings are the load-bearing component** of scalable multi-agent review. Without them, a coordinator cannot deduplicate, risk tiering cannot be computed, CI gates cannot act on severity, and auto-fix pipelines cannot target lines. With them, all of these become straightforward.

## The Text-to-Data Problem

Traditional code review tooling — both human and AI — produces natural language commentary. A reviewer leaves a comment like: "This function could throw a NullPointerException if `user` is nil before the guard clause." A developer reads it, understands it, and decides what to do. The communication channel is a human brain.

Multi-agent review systems break this assumption. When a security reviewer agent, a performance reviewer agent, and a code quality reviewer agent all produce output, something must consume those outputs and act on them — and that something is another agent (a coordinator) or a CI pipeline. Neither can reliably parse intent from free text. A coordinator agent that receives three separate markdown comment blocks and must decide which one is a blocker, which is a suggestion, and which one is a duplicate of another, is burning expensive tokens on a parsing problem rather than a reasoning problem.

The solution is obvious in retrospect: reviewer agents should produce structured output with explicit severity classification from the start.

## A Practical Finding Schema

Cloudflare's production architecture uses XML-tagged output with the following severity taxonomy:

- `critical` — causes an outage or is exploitable; blocks merge
- `warning` — measurable regression or concrete risk; requires human judgment before merge
- `suggestion` — improvement worth considering; informational only

Each finding carries: the reviewer's agent ID (which domain it came from), the file path, the starting and ending line numbers, a short title, a detailed explanation, and a proposed fix. In JSON terms:

```json
{
  "agent": "security-reviewer",
  "severity": "critical",
  "file": "src/auth/token.ts",
  "line_start": 47,
  "line_end": 52,
  "title": "JWT secret falls back to hardcoded default",
  "explanation": "When JWT_SECRET is unset, the fallback 'dev-secret' is used in all environments, including production. An attacker with knowledge of this default can forge arbitrary tokens.",
  "fix": "Remove the fallback entirely. Throw at startup if JWT_SECRET is missing."
}
```

This structure makes every downstream operation mechanical. Counting `critical` findings across all reviewers is a counter increment. Deduplication is a hash comparison on `(file, line_start, title)`. Risk scoring is a weighted sum. None of these require another LLM call.

## The Coordinator's Job Is Filtering, Not Reviewing

Once findings arrive as structured data, the coordinator agent's role becomes clearer. It is not a reviewer — it does not have opinions about the code. Its job is:

1. **Deduplication**: when the security agent and the code quality agent both flag the same nil-pointer dereference, retain the security agent's finding (higher authority) and drop the duplicate.
2. **Re-categorization**: if a performance issue landed in the code quality section, move it.
3. **Reasonableness filtering**: for any `critical` finding, the coordinator can optionally read the source file to verify the finding is not hallucinatory before it blocks a merge.
4. **Verdict assembly**: collapse the full finding set into a single approval decision — `approved`, `approved_with_suggestions`, `changes_requested`, or `significant_concerns`.

Cloudflare's coordinator uses a "judge pass" where it re-reads source files to verify uncertain `critical` and `warning` findings. This is the only part of the pipeline that requires new LLM reasoning. The rest is deterministic data processing.

A critical implementation detail: the coordinator should process XML or JSON finding objects directly, not re-parse the free-text explanations. This is why the explanation field exists separately — it is for human consumption only, never for machine parsing.

## Risk Tiering: Paying for Review Proportional to Risk

Not every pull request needs seven specialized reviewers and a top-tier coordinator model. A one-line typo fix in documentation and a 400-line refactor of the authentication module do not warrant the same pipeline. Risk tiering solves this economically.

The Cloudflare system classifies each merge request before reviewers are dispatched:

| Tier | Threshold | Agents Dispatched | Coordinator Model |
|------|-----------|-------------------|-------------------|
| Trivial | ≤10 lines, ≤20 files | 2 (security + quality) | Sonnet |
| Lite | ≤100 lines, ≤20 files | 4 specialized agents | Standard model |
| Full | >100 lines or >50 files | All 7 agents | Opus |

Security-sensitive paths (`auth/`, `crypto/`, permission-related modules) override tier classification and always trigger a Full review regardless of size. This pattern — **path-based tier escalation** — is important for agent-built codebases where automated commits might touch critical files in small diffs.

The tiering computation itself is fully deterministic: lines changed (from the diff stat), file count, and a regex match against a sensitive-path list. No LLM involvement. The structured finding schema remains identical across tiers; the difference is only in how many agents produce findings.

## The Self-Approval Problem in Agent Teams

GitHub's branch protection model is built around a human-trust assumption: the person who writes code cannot approve their own merge request. When AI agents enter the picture, this assumption gets complicated in two ways.

**Problem 1: The author-reviewer identity collapse.** If an AI agent writes code and then reviews its own PR in the same session, the reviewer inherits the author's context, assumptions, and blind spots. This is the "echo chamber" problem documented in multi-model review research. The model that produced the code is too close to it — it reviews what it intended to write, not what it actually wrote. The structured finding from such a review tends to be a rephrased version of the author's own reasoning, not an independent audit.

**Problem 2: The GitHub approval gate.** GitHub's branch protection rules enforce that the author of a PR cannot be one of the required approvers. When AI agents operate as GitHub app accounts, this rule applies to them too. An agent that writes code and then approves the resulting PR violates the segregation of duties principle that the branch protection rule encodes.

The practical solution is architectural: the author agent and the reviewer agent must be different identities. This is not just a GitHub compliance detail — it is the reason multi-agent review catches more bugs than single-agent review. The key constraint is that the reviewer agent must not see the author agent's reasoning, only the output (the diff). This forces genuinely independent evaluation.

For teams running AI agents on GitHub, the implementation choices are:

- **Two bot accounts**: one for code-writing agents, one for review agents. The reviewer account cannot appear in the author list for any PR it approves.
- **GitHub App with separate installation**: the review app has the `pull_requests: write` scope to post review comments but cannot push commits. The coding app has push scope but no approve scope.
- **Branch ruleset bypass**: for fully automated flows where no human approval is required, the bypass actor list in branch rulesets can include specific app IDs. This should be audited carefully — it is a compliance exception, not a default setting.

The `exempt an approval requirement for automated account` discussion thread on GitHub's community forum shows teams actively wrestling with this. The emerging pattern is: AI reviewers comment freely (no privilege required), but the final merge approval must come from a human or from an agent account that did not author the code being merged.

## Structured Findings Enable Auto-Fix Pipelines

Once findings are machine-readable with file paths and line numbers, an additional automation tier becomes possible: automatic fix generation for `suggestion`-severity findings.

The pattern works as follows:

1. Reviewer agents produce structured findings.
2. Coordinator filters and categorizes. `critical` and `warning` findings are surfaced to developers as blocking or advisory. `suggestion` findings are passed to a fix-generation agent.
3. The fix agent receives the finding object (file, line range, proposed fix text) and generates a patch. Because it has the exact line range, it can make a targeted edit rather than re-reviewing the entire file.
4. The patch is committed to the PR branch, and the suggestion finding is marked `auto-resolved`.

This is the workflow that transforms AI code review from advisory (the reviewer posts a comment and waits) to transactional (the reviewer posts a finding, the pipeline acts on it). The distinction matters for agent-built codebases where the PR author is also an agent: there is no human checking comments. The fix must be mechanical and machine-initiated.

The risk in auto-fix pipelines is compounding errors — the fix agent applies a patch that is subtly wrong, the reviewer does not re-check it, and the error ships. Production deployments mitigate this by limiting auto-fix to a narrow class of findings: formatting, unused imports, obvious nil-check additions, and documentation completeness. Architectural changes, business logic, and security fixes always require human approval even if the initial finding came from an AI reviewer.

## Measuring Review Quality: Recall Over Precision

For AI code review, the precision-recall tradeoff has a non-obvious optimal point. Augment Code's benchmark of seven tools across 50 real-world pull requests found that most tools sacrifice recall to improve precision. The top performer (Augment) achieved 65% precision and 55% recall (59% F-score). The gap between first and seventh place was 34 F-score points.

The recall-first argument: once a structured finding passes through a coordinator filter before it reaches a human developer, false positives are manageable by software. A coordinator that drops low-confidence findings removes noise before it causes developer fatigue. A missed bug (false negative), by contrast, ships to production regardless of how good the filtering is.

This means the right metric for a reviewer agent is recall — how many real bugs did it detect? — while the coordinator's metric is precision of what it passes through. The two-layer architecture separates these concerns cleanly: reviewer agents optimize for breadth, coordinator agents optimize for signal quality.

In practice, teams should track:

- **Escaped defect rate**: bugs that reached production that were present in a reviewed PR. This measures recall failure.
- **Comment acceptance rate**: the fraction of AI review findings that resulted in code changes. This measures precision. A rate below 30% signals too much noise.
- **Time-to-first-review**: how quickly after PR creation the structured finding set arrives. For agent-built codebases with high PR volume, this should be under 5 minutes.

## Implications for Agent-Built Codebases

The patterns above were developed in the context of human developers who use AI as a review assistant. But AI agents now generate entire features, submit PRs, and merge code with minimal human involvement. This changes the stakes in two ways.

First, **volume**. A single AI agent with a task scheduler can open dozens of PRs per day. At that rate, human code review is not a viable gate — the only scalable review is automated review. The structured finding pipeline described here is not a productivity enhancement in this context; it is the only review that exists.

Second, **error correlation**. When the same AI agent (or the same model family) writes most of the code in a codebase, the errors tend to correlate. The agent has consistent blind spots — patterns it consistently misses across multiple PRs. A reviewer agent from the same model family will share those blind spots. This is the strongest argument for using a different model for review than for coding, and for periodic human audits of the "escaped defect" class.

The Cloudflare system's 93% R&D adoption rate and median review time of 3 minutes 39 seconds demonstrate that the structured approach is production-viable at scale. The $1.19 average cost per review is a rounding error compared to the cost of a production incident.

## Summary

The engineering lever that makes multi-agent code review production-viable is treating findings as structured data from the first step. A finding schema with explicit severity, file coordinates, agent source, and proposed fix enables: deterministic deduplication in the coordinator, risk-tiered agent dispatch, CI gate enforcement on `critical` findings, auto-fix pipelines for `suggestion`-class issues, and meaningful recall/precision metrics. The self-approval governance problem — ensuring the author agent and reviewer agent are different identities — is a structural requirement, not an optional compliance detail. Get the data model right and the orchestration layer becomes straightforward; leave it as free text and every downstream step requires expensive LLM parsing.
