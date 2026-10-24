---
date: "2026-10-24"
time: "09:00"
title: "When Two Branches Carry the Same File: Keeping Duplicates Byte-Identical Across Parallel PRs"
description: "Reproduced Git experiments show how a duplicated helper silently drifts between in-flight PRs, why clean merges and cherry-pick detection are not proof of sameness, and which blob-hash, merge-tree and ownership checks an agent coordinator can apply."
tags: ["research", "git", "multi-agent", "pull-requests", "stacked-prs", "coordination", "verification"]
---

## Executive Summary

Two agents work on two pull requests. Both need the same helper, say a lock script. Agent A owns the change. Agent B's PR consumes it before A's PR merges, so B carries its own copy of the file. Both PRs are green. Can the coordinator conclude the two copies are the same?

No. A copy that was identical on Monday can differ on Tuesday after A pushes a fix, and Git will often hide the divergence: a three-way merge may succeed cleanly and produce a file that neither author wrote, a conflict resolved with `-X ours` may keep the stale side, and reverting A's PR can delete a file B still needs without any conflict. The reproduced cases below used Git 2.43.0 in throwaway repositories.

This article proposes a small contract for a coordinator: pick one owner per duplicated path, compare blob object IDs (`git rev-parse <rev>:<path>`) instead of eyeballing diffs, re-run the comparison whenever the owner pushes, dry-run the combined merge with `git merge-tree --write-tree` and check what the merged blob equals, and treat `cherry`, `patch-id` and `range-diff` as hints rather than gates. It is a proposal for coordination practice, not a description of how any existing agent platform behaves.

The central point: "the file is the same" is a claim about one object ID per path per branch tip. Verify that claim directly, at the tips that will actually merge, and re-verify when either tip moves.

## The Setup, and Why Duplication Is Tempting

The pattern is common whenever work is parallel and one change depends on another that has not landed yet:

- PR A adds or fixes `lock.sh`.
- PR B uses `lock.sh` and cannot be tested without it.
- B's author either waits, stacks on A, or copies the file into B.

Copying wins on speed. B's CI can pass today, and no human has to sequence merges. The cost is that the repository now has two histories claiming the same path, and Git has no built-in notion that they are supposed to stay equal.

The available strategies differ in what they promise:

| Strategy | What keeps copies equal | Failure it leaves open |
|---|---|---|
| Stacked PRs (B based on A's branch) | Shared ancestry: B's tree contains A's blob by construction | Rebase and restack after A changes or merges; every PR in the stack must be updated |
| Cherry-pick A's commit into B | Nothing after the pick | Silent drift when A is amended; the copy is a new commit with a different ID |
| Vendoring or copying the file | Convention only | Same as cherry-pick, plus no commit-level link at all |
| Single owner per file (CODEOWNERS or a coordinator rule) | Process: only the owner may change the path | Does not stop a copy from being stale; it only says who can fix it |
| Wait for A to merge, then rebase B | Linear history | Serializes the work, which is what duplication tried to avoid |

Stacked tooling exists precisely to make the first row cheap. [ghstack](https://github.com/ezyang/ghstack) submits each commit of a local stack as its own PR and keeps per-PR base and head branches. Its documentation notes that conflicts must be resolved in every PR of the stack and that the normal GitHub merge button works poorly, so landing goes through its own command. [spr](https://github.com/ejoffe/spr) uses one commit per PR, and its `merge` command combines the commits up to a chosen PR into one PR, merges that, and closes the intermediate PRs. Gerrit takes the dependency into the review UI: its [change screen](https://gerrit-review.googlesource.com/Documentation/user-review-ui.html) lists ancestors and open descendants, and flags a related change as "Not current" when its patch set is outdated. The common thread is that these tools make the dependency visible and force a rebase when the parent moves. A hand-copied file has none of that.

## What Identical Means: Compare Object IDs

Git stores file contents as blobs named by a hash of the content. Two paths on two commits are byte-identical in Git's sense exactly when their blob IDs are equal. The `<rev>:<path>` syntax in [`git rev-parse`](https://git-scm.com/docs/git-rev-parse) names that blob (or tree) in the given tree-ish:

```bash
git rev-parse pr-a:lock.sh pr-b:lock.sh
```

In the first experiment, A and B both held version 1 and printed the same ID, `2aa5e06609c3…`. After A pushed a second commit (a one-line fix to the release function), the same command printed `89a21505df91…` for A and still `2aa5e06609c3…` for B. A coordinator-friendly wrapper is a few lines:

```bash
same_blob() { # usage: same_blob <path> <rev> <rev> [<rev>...]
  path=$1; shift
  ref=$(git rev-parse "$1:$path") || return 2
  for r in "$@"; do
    [ "$(git rev-parse "$r:$path")" = "$ref" ] || { echo "DRIFT $r:$path"; return 1; }
  done
}
same_blob lock.sh origin/pr-a origin/pr-b
```

Why not diff? `git diff pr-a pr-b -- lock.sh` also works, and `--exit-code` or `--quiet` ([diff-tree options](https://git-scm.com/docs/git-diff-tree)) turn it into a gate. But a blob comparison does not depend on diff heuristics, whitespace options, or pager output, and it can compare any number of tips in one loop. For directories, `git ls-tree` ([docs](https://git-scm.com/docs/git-ls-tree)) with `-r` and `--object-only` lists the blob IDs of every file under a path, and a tree ID from `rev-parse <rev>:<dir>` summarizes the whole directory in one comparison.

Two cautions apply to hashing:

- Compare committed blobs, not working-tree files. Per the [gitattributes](https://git-scm.com/docs/gitattributes) manual, end-of-line conversion and filters mean the index holds normalized content while the working tree may hold something else, so `sha1sum` on a checkout can disagree with the stored blob for the same logical file. `git hash-object --path=<file>` applies the attribute rules for that path; `--no-filters` hashes the raw bytes. The [hash-object manual](https://git-scm.com/docs/git-hash-object) describes both.
- Compare the tips that will merge, not branch names in your local clone. Fetch first, then use remote-tracking refs (`origin/pr-a`), or you may certify a stale local copy.

## Four Ways Drift Stays Silent

Each case below was run in a scratch repository. The file was a ten-line shell helper; the point is not the helper but what Git reported.

### 1. A clean merge that produces a file nobody wrote

After A's second commit, B also made a small local edit to its copy of `lock.sh`, in a different part of the file from A's fix. This is common: the consuming agent tweaks a comment or a path while testing.

```bash
tree=$(git merge-tree --write-tree pr-a pr-b); echo "exit=$?"
git rev-parse "$tree:lock.sh" pr-a:lock.sh pr-b:lock.sh
```

The exit status was `0`: no conflict. The merged blob was `47cea0843fcc…`, which equals neither A's `89a21505df91…` nor B's `bfba42685…`. The result contained A's fix and B's tweak together. Whether that is acceptable is a judgment call, but it is a third version of the file that neither author reviewed or tested, and Git treats that as a successful merge.

[`git merge-tree --write-tree`](https://git-scm.com/docs/git-merge-tree) is the right dry-run tool: it performs the real merge machinery without touching the index or working tree, prints a tree ID on success, and exits with `1` on conflict. The same manual warns not to infer cleanliness from an empty conflicted-file list; use the exit status. The additional step this case adds is to compare the merged path's blob against the intended owner's:

```bash
tree=$(git merge-tree --write-tree origin/pr-a origin/pr-b) || { echo conflict; exit 1; }
[ "$(git rev-parse "$tree:lock.sh")" = "$(git rev-parse origin/pr-a:lock.sh)" ] \
  || echo "merged lock.sh differs from owner's copy"
```

When B's copy was merely stale (unmodified v1) rather than edited, the same test passed: the merge result equalled A's v2 blob, because only A had changed the file relative to the common base. So a stale but unmodified copy tends to heal on merge; an edited copy does not.

### 2. Conflict resolution picks the stale side

When both sides edited the same hunk, `merge-tree` exited `1` and named `lock.sh`. That is the good outcome. The bad one comes from how the conflict gets resolved. Merging A into a B branch that had edited the same hunk with `git merge -X ours pr-a` succeeded (exit 0) and the resulting `lock.sh` was B's `3ce80bcaaede…`, not A's `89a21505df91…`. The option told Git to prefer B's side for conflicting hunks, so the owner's fix was dropped without a marker.

Preference flags are blunt for a shared file. A rule that survives automation is: for a path with a declared owner, conflicts are resolved by taking the owner's blob wholesale, then re-applying any consumer-specific edit on top as a separate, visible commit:

```bash
git checkout origin/pr-a -- lock.sh   # take the owner's version
git diff --cached --stat -- lock.sh   # confirm what changed in B
```

[`git rerere`](https://git-scm.com/docs/git-rerere) deserves the same caution in a multi-agent setting. It replays earlier conflict resolutions and writes the result to the working tree without staging it; the manual tells users to inspect with `git diff` before `git add`. An agent that stages everything after a rerere replay can commit a resolution recorded against an older version of the owner's file.

### 3. Detectors report the wrong thing

[`git cherry`](https://git-scm.com/docs/git-cherry) marks a commit `-` when an equivalent exists upstream and `+` when it does not, comparing diffs after removing whitespace and line numbers. [`git patch-id`](https://git-scm.com/docs/git-patch-id) computes the identifier behind that comparison. In the second experiment, A and B each added the same `lock.sh` plus a different feature file. `git cherry -v pr-a pr-b` printed `+` for B's commit: not a duplicate, because the whole commit differs. Restricting the diff to the shared path changed the answer:

```bash
git diff main pr-a -- lock.sh | git patch-id --stable
git diff main pr-b -- lock.sh | git patch-id --stable
# both: 018ccdce3bba7482e7ddb180d18608b37248a104
```

The path-scoped patch IDs matched. This is useful, but note its limits. Patch ID identifies equal changes relative to their own parents; it does not prove the resulting files are equal. If the two branches started from different base versions of the file, equal patch IDs can still yield different results. The blob comparison is the stricter test, and patch ID is better treated as a way to find which commit introduced the duplicate.

[`git range-diff`](https://git-scm.com/docs/git-range-diff) compares two versions of a series: `=` for identical patches, `!` for matched but modified, `<` and `>` for removed and added commits. On the tiny test commit it did not match the pre-rebase and post-rebase B commits at all and reported a deletion plus an addition, because the diff-of-diffs was large relative to the patch size. The manual describes this matching heuristic and a `--creation-factor` option to tune it, and it also states the output is human-readable porcelain, "subject to change", not meant for scripts. Use `range-diff` to help a reviewer see what a rebase changed; do not use its output as a gate.

### 4. Reverting one PR deletes the other's dependency

Both PRs added an identical `lock.sh`. Merging A, then B, then reverting A's merge commit:

```bash
git merge --no-ff pr-a
git merge --no-ff pr-b
git revert -m1 --no-edit <merge-of-A>   # exit 0, no conflict
ls   # lock.sh is gone; b.txt (which needs it) remains
```

The revert succeeded and removed `lock.sh`, because the reverse patch (delete the file) applied cleanly to a file with matching content. B's feature, still present, now lacks its dependency. Neither Git nor a green merge button warns about this. The hazard has a mirror image in the official [revert-a-faulty-merge](https://git-scm.com/docs/howto/revert-a-faulty-merge) guidance: after reverting a merge, merging the same branch again can bring nothing in, because Git considers its commits already integrated; the documented remedy is to revert the revert. Both cases come from the same fact, that Git tracks changes and ancestry, not intent about shared files.

## Rebase and Squash Behavior That Helps, and Where It Stops

The good news from the experiments: Git's replay machinery tolerates exact duplicates well.

- After A was squash-merged into `main`, `git rebase --onto main pr-a b-stack` moved only B's own commit. The post-rebase `main:lock.sh` and `b-stack:lock.sh` blobs were equal. A plain `git rebase main` of a branch that still contained A's two commits printed `dropping … -- patch contents already upstream` for both, matching the manual's description that commits with an upstream equivalent are dropped automatically. The `--onto` form is the documented way to transplant only the commits you own; the [rebase manual](https://git-scm.com/docs/git-rebase) warns that the automatic-skip shortcut can resurrect commits in the "hard case" where upstream patch IDs changed because of conflicts or interactive edits.
- GitHub's [squash merge](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/about-pull-request-merges) collapses a PR to one commit, and "rebase and merge" creates new commits with new SHAs. The commit IDs B was based on disappear from the base branch's history, so identity by commit ID breaks; identity by blob ID does not. GitHub's own page also notes that continuing to use a head branch after a squash can reintroduce already-squashed commits and repeated conflicts.

So the safest invariant is stated at the content level: the blob at path P on the merged result equals the owner's final blob. It does not rely on commit lineage that squashing can erase.

## Ownership: Say Who Fixes It

Verification tells you a copy has drifted; ownership tells you whose version is right. [CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners) maps path patterns to owners, with the last matching pattern taking precedence; owners are requested for review when a PR touches their files, and branch protection can require their approval. Two details matter here. The file is read from the PR's base branch, and a draft PR does not trigger review requests until it is ready. For an in-flight dependency, that means CODEOWNERS only helps once the PR is on the main line and ready for review. Before then, the coordinator needs its own record, such as a line in the task description: "`scripts/lock.sh`: owner agent A, PR 41; PR 42 may carry a byte-identical copy until 41 merges."

A minimal ownership rule for agents:

1. One owner per shared path. Only the owner changes the file's content.
2. A consumer PR may include the file only as an exact copy of the owner's current tip, and must say so in its description, with the owner's PR number and the blob ID.
3. If the consumer needs a change, it asks the owner to make it, or it is made in a separate commit after the copy, never folded into the copy.
4. When the owner's PR merges, the consumer rebases with `--onto`, and the copy should vanish from the consumer's diff.

## Coordinator Checklist

Run this when a PR that carries a shared file is about to be merged, approved, or rebased, and again when the owner's PR gets a new commit. All commands assume refs are freshly fetched.

Before merging the consumer PR:

1. Identify the shared paths: `git diff --name-only origin/main...origin/pr-b` and intersect with the owner PR's list.
2. Equality: `git rev-parse origin/pr-a:<path> origin/pr-b:<path>` — IDs must match, or the PR description must justify and mark the difference.
3. Dry-run both orders: `git merge-tree --write-tree origin/pr-a origin/pr-b` and the reverse arguments. Exit `0` required; then compare `"$tree:<path>"` to the owner's blob, since exit `0` alone does not prove the path is unchanged.
4. Re-check after any push to either branch; record the owner tip SHA that the check ran against.
5. If a mismatch exists, resolve by taking the owner's blob (`git checkout origin/pr-a -- <path>`), not by `-X ours` or `-X theirs`, and confirm with step 2.

Around merge and rebase:

6. After the owner's PR merges, rebase the consumer with `git rebase --onto origin/main <old-owner-tip> pr-b`, then confirm `origin/main:<path>` equals `pr-b:<path>` or that the path no longer appears in `git diff origin/main...pr-b`.
7. Never resolve a rerere replay or a conflict in a shared path without `git diff` review of that path.

Before reverting either PR:

8. List every other open or merged PR that touched the same paths: `git log --oneline origin/main -- <path>` plus the open PR list. If a consumer exists, the revert needs a plan for the dependency, not just a green `git revert`.
9. After the revert, build or test at the consumer's tip to confirm the dependency still exists.

Evidence to record in the PR thread: the tip SHAs, the blob ID, the `merge-tree` exit status, and the merged-path blob. Those four facts let a later reader tell whether the claim was checked at the current tips.

## Limits of This Evidence

- All experiments were small and used one Git version (2.43.0). They show that the cases occur, not how often. The `range-diff` mismatch in particular depends on the tiny commit size.
- Blob equality proves the files are byte-identical, not that they behave correctly together. A semantic conflict between two edits in different hunks can pass every check here, so tests remain necessary.
- `git merge-tree --write-tree` with several merge bases is documented as unsupported with `--merge-base`; the dry run assumes a single natural merge base.
- Stacked PR tools were assessed from their documentation, not by running them. Claims about ghstack, spr, and Gerrit reflect those docs.
- Content filters and line-ending rules can make working-tree comparisons misleading; the checks above use committed objects for that reason.

## Sources

- Git documentation: [git-rev-parse](https://git-scm.com/docs/git-rev-parse), [git-ls-tree](https://git-scm.com/docs/git-ls-tree), [git-hash-object](https://git-scm.com/docs/git-hash-object), [git-merge-tree](https://git-scm.com/docs/git-merge-tree), [git-patch-id](https://git-scm.com/docs/git-patch-id), [git-cherry](https://git-scm.com/docs/git-cherry), [git-range-diff](https://git-scm.com/docs/git-range-diff), [git-rebase](https://git-scm.com/docs/git-rebase), [git-rerere](https://git-scm.com/docs/git-rerere), [git-diff-tree](https://git-scm.com/docs/git-diff-tree), [gitattributes](https://git-scm.com/docs/gitattributes), [revert a faulty merge](https://git-scm.com/docs/howto/revert-a-faulty-merge)
- Stacked review tooling: [ghstack](https://github.com/ezyang/ghstack), [spr](https://github.com/ejoffe/spr), [Gerrit change screen: related changes](https://gerrit-review.googlesource.com/Documentation/user-review-ui.html)
- GitHub: [About code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners), [About pull request merges](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/about-pull-request-merges)
