---
date: "2026-05-21"
title: "Stacked PR Workflows for AI Agent Collaboration"
description: "How stacked pull requests and git worktrees combine to keep AI-assisted development reviewable, incremental, and mergeable at scale."
tags: ["git", "pull-requests", "ai-agents", "code-review", "workflow", "devops"]
---

## Executive Summary

AI coding agents can generate substantial amounts of code in very short bursts — which means the bottleneck quickly becomes human review bandwidth, not generation speed. Stacked pull requests (stacked PRs) address this by decomposing large diffs into a chain of small, focused, independently-reviewable units. When combined with git worktrees for parallel agent isolation, stacked PRs form the structural backbone of maintainable AI-assisted development workflows.

## What Are Stacked PRs?

A stacked PR is a pull request that targets not `main`, but the branch of the PR below it in an ordered chain. Each PR in the stack represents one logical unit of change — it can be reviewed independently and makes sense on its own. Merging happens bottom-to-top: PR #1 merges into `main`, then PR #2 retargets `main`, and so on, cascading upward.

### Key metrics that motivate the approach

- PRs with 200–400 lines have **40% fewer defects** than larger ones (analysis of 1.5M PRs from top engineering teams)
- Small PRs (<200 lines) get approved **3× faster**
- Reviewers lose context and feedback quality drops on large PRs — stacked PRs let each reviewer focus on one coherent piece

### Merge strategy constraint

One critical limitation: you **cannot use squash-and-merge** on intermediate PRs in a stack. Squash merge rewrites commit history, breaking the commit references downstream PRs depend on. Use regular merge commits for all except the final PR.

## Native Platform Support (2026)

### GitHub gh-stack (April 2026)

GitHub shipped a native stacked PR extension — `gh-stack` — entering private preview on April 13, 2026. This closes a gap third-party tools like Graphite had filled for years.

Key capabilities:
- `gh stack sync` cascades a rebase across the entire stack and force-pushes each branch atomically
- The PR UI shows a **stack map** so reviewers can navigate between layers
- Branch protection rules are enforced against the **final target branch**, not just the direct base
- CI runs for every PR in the stack as if targeting the final branch
- Ships with an **AI agent integration**: `gh skill install github/gh-stack` teaches compatible AI coding agents (Codex, Claude Code, etc.) to create and manage stacks from the beginning of a task

### GitLab Stacked Diffs

GitLab has had stacked diffs support in development (issue #24528), with docs added via MR !156670. Like GitHub's approach, each MR in a stack targets the branch of the MR below it, and the UI surfaces the dependency chain for reviewers.

### Third-party ecosystem (Graphite, Aviator, Trunk)

Graphite (founded by former Meta engineers) pioneered the stack-aware merge queue: it batches and tests multiple stacked PRs in parallel, automatically rebases downstream PRs when an earlier one merges, and provides a web-based review interface alongside a CLI. Graphite's free tier includes CLI + stacking; paid plans start at $20/user/month. The recommended 2026 stack for most teams is a merge queue (Aviator, Trunk, or GitHub native) + AI review layer (CodeAnt AI or Graphite Agent) + dependency automation (Renovate/Dependabot).

## AI Agent Integration Patterns

### Stacked PRs as agent task boundaries

The core pattern emerging in 2026: a coordinating agent decomposes a feature into ordered subtasks, dispatches each to a worker agent, and the worker's output becomes one layer of the stack. Constraints recommended in practice:

- Each PR under 200 lines
- Each layer must "do one logical thing and make sense on its own"
- Upfront file ownership mapping — tasks that share files are sequenced, not parallelized

Joe Buza (LinkedIn, February 2026) documented prompting AI coding agents with explicit Graphite-style stack instructions to enforce these boundaries.

### Git worktrees for parallel isolation

Worktrees pair naturally with stacked PRs. Each worktree is a separate checkout of the repository with its own tracked branch. The recommended model is **worktree-per-task** (not worktree-per-agent): agents are assigned to worktrees, worktrees aren't permanently owned by agents. This prevents:

- Working directory conflicts between parallel sessions
- Mixing of unrelated edits across agent lanes
- Contaminated context from shared state

Teams report running 2–5 agents in parallel without dedicated infrastructure, and 10+ with tmux automation and an orchestrator agent on large codebases. The advice: start with 2–3, establish coordination patterns, then scale.

### The `codex-pr-body` skill pattern

A documented pattern (Daniel Vaughan, April 2026) has AI agents generate structured PR body content — description, test plan, stack context — at commit time using a skill/hook. When used with stacked PRs, each PR body includes a "stack position" section explaining what the layer does, what it depends on, and what depends on it. This dramatically reduces reviewer orientation time.

## Review Quality in an AI-Code World

### The approval-churning problem

Research published in January 2026 (*Early-Stage Prediction of Review Effort in AI-Generated Pull Requests*, arXiv 2601.00753) found that AI agents sometimes submit changes without resolving core issues, resulting in "approval churning" — multiple review cycles without convergence. Stacked PRs mitigate this by:

1. Reducing surface area per review cycle (easier to spot unresolved issues)
2. Forcing explicit sequencing so reviewers see dependencies
3. Enabling an AI reviewer (Graphite Agent, CodeAnt AI) per layer rather than one bulk review

### Stack-aware AI reviewers

Tools like Graphite Agent review stacks for type errors, race conditions, security issues, and optimization opportunities, with awareness of the stack's context. Smaller, coherent diffs give AI reviewers dramatically better signal than a 2,000-line monolithic PR.

## Implications for Zylos Dev Workflow

The Zylos project already uses worktrees (`git-worktree-parallel-ai-development.md`, Feb 2026). Stacked PRs are the natural next layer:

1. **Task decomposition first**: before any agent branch, map the dependency order of subtasks
2. **Stack discipline**: each agent branch targets the previous agent branch, not `main`
3. **Reviewer orientation**: use structured PR body templates (stack position, logical unit description, test evidence)
4. **Merge queue**: once GitHub's `gh-stack` exits waitlist, adopt `gh stack sync` for automated cascade rebases
5. **Independent review per layer**: route each stack layer to the Jinglever reviewer agent independently rather than reviewing the entire feature at once

The combination — worktrees for agent isolation, stacked PRs for reviewability, and a stack-aware merge queue — makes human oversight of AI-generated code sustainable as output velocity increases.

## Summary

Stacked PRs are the structural answer to the review-bandwidth problem created by AI coding agents. GitHub's native `gh-stack` (April 2026) brings first-class support to the platform, and the pattern maps directly onto multi-agent orchestration: each layer of the stack is one agent's well-scoped task. Combined with git worktrees for isolation and stack-aware merge queues for safe landing, this is the emerging standard workflow for teams shipping AI-assisted software at scale while maintaining engineering controls.
