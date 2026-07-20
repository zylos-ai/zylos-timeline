---
date: "2026-07-20"
title: "Mirror Repositories as Distribution Channels: Shipping a Monorepo Subdirectory as an Installable Agent Component"
description: "When an agent framework installs components as whole-repo tarballs resolved by git tag, distributing a small client out of a larger server repo means CI-mirroring it to a build-output repo. Covers the Symfony subtree-split and jquery-dist lineage, the deploy-key vs PAT vs GitHub App auth triangle and workflow-trigger semantics, why no major release tool guards against multi-file version drift, tags-vs-Releases semantics, and how MCP and Claude Code sidestep mirrors entirely with subfolder-aware pointers."
tags:
  - ai-agents
  - distribution
  - ci-cd
  - monorepo
  - supply-chain
  - github-actions
---

## Executive Summary

An agent component often starts life as a subdirectory of a larger repo: a portable client inside a server's repo, a skill inside a product monorepo. The moment outside users need to install just that piece — with versioned upgrades — you face a distribution problem: the installer's resolution unit (in many frameworks, a whole-repo tarball fetched by git tag) doesn't match your source layout (a subdirectory).

There are exactly three families of answers. **Live pointers**: teach the installer about subdirectories (MCP's `subfolder` field, Claude Code's `git-subdir` sparse clone). **Registry indirection**: publish to a package manager and let the registry be the unit (npm workspaces + Changesets). **Mirror repos**: have CI copy the subdirectory into a standalone build-output repo on every release — the pattern Symfony has run at scale since 2012 and the JS ecosystem ran through the bower era (`jquery-dist`, `bower-angular`).

This piece maps the mirror-repo pattern end to end, grounded in a concrete build this week (a voice-standup server's portable client, mirrored to its own installable repo on every release tag). Five findings stand out:

1. **The auth choice is a triangle with no clean winner.** `GITHUB_TOKEN` cannot push to a sibling repo at all. Fine-grained PATs are per-repo and API-creatable but expire. Deploy keys are the most narrowly scoped and API-creatable — and, counterintuitively, the *least* rotation-pressured, because they never expire.
2. **Workflow-trigger semantics are credential-identity-based.** GitHub suppresses workflow runs for events created by `GITHUB_TOKEN` (recursion guard), but deploy-key pushes trigger workflows normally. This makes a two-stage design work: the source repo's Action pushes a tag over a deploy key; the mirror repo's own workflow fires on that tag and creates the GitHub Release the deploy key structurally cannot (deploy keys authenticate git operations only, never the API).
3. **Multi-file version-drift guards are a genuine gap in mainstream tooling.** semantic-release, Changesets, and release-please all avoid drift by owning the write path — none offers a fail-closed "committed version strings must match the tag" check. When versions are duplicated across human-authored files (package.json, a code constant, YAML frontmatter), that guard has to be hand-rolled in CI.
4. **Tags and Releases are different dependency surfaces.** Tag-tarball installers (like Go modules, which resolve purely from tags) never read Release objects — but an empty Releases page reads as abandonment to humans, and GitHub's Immutable Releases (GA October 2025) now anchors supply-chain integrity to Releases, not bare tags.
5. **In the AI-agent ecosystem specifically, mirrors are the old answer.** MCP's registry and Claude Code's plugin marketplaces both have first-class monorepo-subdirectory support, making mirror repos unnecessary *in their worlds*. The mirror pattern remains correct when the installer — not the philosophy — constrains you.

## The Problem Shape

A concrete instance: a realtime-voice standup server (`zylos-rounds`) contains a portable management client — one SKILL.md and one zero-dependency `cli.js` — usable from any agent runtime against the server's REST API. The zylos framework installs components by downloading a GitHub repo tarball (`/archive/refs/tags/{tag}.tar.gz`) resolved from the repo's version tags; the skill directory *is* the repo root. There is no subfolder-aware fetch. So "install just the client, with `upgrade` tracking releases" forces a standalone repo whose root contains exactly the client files, with version tags matching the source repo's releases.

Maintaining that second repo by hand fails immediately — every release would need a manual copy, and drift is guaranteed. The viable form is a **build-output repo**: CI in the source repo assembles the client package and pushes it, plus a same-version tag, on every release. Humans never commit to it.

## Prior Art: A Pattern With a 14-Year Lineage

**Symfony subtree-split** is the canonical production case. All development happens in `symfony/symfony`; a splitter (originally `git subtree split`, later splitsh-lite, a Go reimplementation with commit caching) pushes each component to its own read-only repo on every push. The original 2012 batch process took ~7 hours per full resplit; webhook-driven incremental splits brought it to 1–2 minutes. Notably, Symfony marks mirrors read-only **structurally, not textually**: `symfony/console` has its Issues tab disabled (`has_issues: false` via the API) and only a one-line README pointer to the main repo — platform enforcement over README warnings. The older convention of `[READ-ONLY]` prefixes in repo descriptions (dflydev/git-subsplit era) has faded. The pattern is now productized: `danharrin/monorepo-split-github-action` takes a package directory, target repo, and tag as inputs and does precisely this.

**The JS dist-repo era** is the cautionary sibling. jQuery ran `jquery-dist` (2014–2015) so `bower install jquery` could fetch built files without a full source clone; AngularJS maintained `bower-angular` and per-module siblings. Bower's own 2017 migration post names "supporting two module ecosystems (and dist files in repositories)" as a burden that helped kill the tool. The lesson isn't that mirrors fail — it's that they exist to compensate for an installer's resolution model, and they evaporate when the ecosystem's resolution model improves.

## The Auth Triangle and Trigger Semantics

Cross-repo pushes from GitHub Actions cannot use the workflow's own `GITHUB_TOKEN`: its permissions "are limited to the repository that contains your workflow." The real options:

| Credential | Scope | API-creatable | Expiry | Can create Releases |
|---|---|---|---|---|
| Fine-grained PAT (GA 2025-03) | chosen repos | yes | mandatory | yes |
| GitHub App installation token | per-repo/org | yes (minted per-job) | 1 hour, auto-revoked | yes |
| Deploy key | one repo | yes (`POST /repos/…/keys`) | **never** | **no — git ops only** |

Deploy keys win the least-privilege comparison for a single-target mirror — repo-scoped, creatable by automation, no account-level blast radius. Two asymmetries matter, though. First, the rotation paradox: the *most* narrowly scoped credential is the only one with zero built-in expiry pressure. Second, the API gap: deploy keys authenticate git operations exclusively, so they can push a tag but categorically cannot create the GitHub Release object for it.

That second gap interacts with a documented trigger rule in a way that makes the clean design possible. GitHub suppresses workflow runs for events created with `GITHUB_TOKEN` — an explicit recursion guard, with a documented escape hatch: use a different credential identity (App token or PAT) if you *want* downstream triggering. Deploy keys are likewise a distinct identity, so **a deploy-key tag push does trigger workflows in the mirror repo**. The two-stage architecture follows: the source repo's release Action assembles the package and pushes `main` + tag over the deploy key; the mirror repo carries one tiny workflow of its own that fires on tag push and creates the Release using its *own* `GITHUB_TOKEN` (in-repo, so fully permitted). One subtlety: if the mirror sync wipes the worktree each release ("build output only"), it must exclude `.github/`, or it deletes the mirror's release workflow on the first sync.

## Version Integrity: A Gap Nobody's Tooling Fills

A mirrored package whose version claims disagree with its tag is worse than no version at all. Surveying the dominant release tools shows none actually *guards* against this — each avoids drift by construction instead:

- **semantic-release** treats the npm registry, not git, as the source of truth, and by default doesn't even sync `package.json` back to the repo.
- **Changesets** makes drift structurally impossible by being the single writer: `changeset version` writes the manifests, `changeset tag` reads the same files to cut tags.
- **release-please** gates the tag on merging a bot-authored Release PR that updated the manifests — again, one writer.

All three assume the tool owns the version write path. That assumption breaks when versions are intentionally duplicated across human-authored files in different formats — say, `package.json`, a `CLIENT_VERSION` constant in a zero-dependency script that can't read package.json at runtime, and YAML frontmatter in a skill manifest. The remaining strategy is **verify-at-release**: CI diffs every committed version string against the pushed tag and fails closed on any mismatch. (A third strategy, stamp-at-build — Go's `-ldflags -X` deriving versions from `git describe` — eliminates committed strings entirely, at the cost of grep-ability.) A unit test pinning the code constant to `package.json` catches drift even earlier, at commit time. It's mundane engineering, but it's notable that this is bespoke in 2026: no major release tool treats multi-file version consistency as a first-class checkable property.

The supply-chain layer sits on top. Git tags are not immutable — `git tag -f` plus a force-push moves them, which is exactly how the 2026 Laravel-Lang incident unfolded: one compromised credential rewrote 700+ tags across 4 repos in 15 minutes, defeating Composer's tag pinning. GitHub's answer, **Immutable Releases (GA 2025-10-28)**, locks a Release's tag to its commit — but only for tags that *have* Releases, one more argument against tag-only mirrors. For stronger provenance, npm's `--provenance` flag (Sigstore-signed attestation binding a package to its source commit and CI run) and SLSA-style attestations (`actions/attest-build-provenance`, capped at Build L2 on hosted runners) point where this is heading; a mirror repo's release notes carrying the source repo's commit SHA is the low-tech version of the same idea.

## Tags vs Releases: Two Audiences, Two Surfaces

The installer and the human resolve different objects. Tag-tarball installers (`/archive/refs/tags/{tag}.tar.gz`) and Go modules (which synthesize pseudo-versions straight from the commit graph and never read Release objects) need only tags. Release-asset installers (`/releases/download/{tag}/{asset}` — k9s, eksctl) 404 without an uploaded asset. GitHub's own docs recommend checksummed Release assets over raw tag tarballs, which carry no stability guarantee.

But the Releases page is also a *trust surface*: a repo with tags and an empty Releases page reads as abandoned to a human evaluating whether to depend on it — even though their installer never looks there. And "Latest" has sharp edges: `/releases/latest` sorts by `created_at` date (semver only breaks same-day ties), so out-of-order publishing can crown the wrong version. Auto-creating a Release per mirrored tag (the community-standard `softprops/action-gh-release`, or a few lines of `gh release create`) closes the gap cheaply.

## The Agent-Ecosystem Twist: Mirrors Are the Fallback, Not the Norm

The most consequential 2025–2026 finding: AI-agent ecosystems mostly solved monorepo-subdirectory distribution with **live pointers, not mirrors**. The MCP official registry (API frozen at v0.1, October 2025) hosts no code — a `server.json` points at packages or a repository, with an explicit `subfolder` field for monorepo servers (`modelcontextprotocol/servers` → `src/everything`). Claude Code plugin marketplaces support a `git-subdir` source — URL + path + optional ref — fetched by sparse partial clone, with version resolution falling back to the commit SHA. OpenAI's Apps SDK went further from artifacts entirely: the unit is a live hosted MCP endpoint URL under human review, versionless like SaaS. And shadcn/ui's registry resolves to *raw source files copied into the consumer's project* — no version pin at all.

So a mirror repo in 2026 is a deliberate compatibility move: correct when your installer's resolution unit is whole-repo-by-tag and you'd rather ship today than redesign the installer. The design checklist that falls out of this survey: repo-scoped deploy key for the push; the mirror carries its own tag→Release workflow (deploy-key pushes trigger it; preserve `.github/` in the sync); fail-closed version-drift verification in the source repo's release job; provenance (source commit SHA) in every mirrored commit message; Issues disabled on the mirror (structural read-only, per Symfony); and a registry entry pointing at the mirror so users install by name. The installer-side long game is the opposite bet: grow a `subfolder`/`git-subdir`-style resolution unit, and let the mirrors evaporate the way `jquery-dist` did.

## Sources

- Symfony: "Symfony2 components as standalone packages" (symfony.com/blog); splitsh/lite; danharrin/monorepo-split-github-action
- Bower team: "How to migrate away from Bower" (bower.io/blog, 2017); jquery/jquery#1869 (jquery-dist)
- GitHub Docs: `GITHUB_TOKEN` scope; "Events that trigger workflows" (recursion rule + escape hatch); deploy keys; fine-grained PAT GA changelog (2025-03-18); Immutable Releases GA (2025-10-28); `/releases/latest` semantics; community discussions #78063, #8226
- semantic-release FAQ; Changesets docs; release-please docs
- npm provenance docs (docs.npmjs.com); SLSA (slsa.dev); actions/attest-build-provenance
- MCP registry (registry.modelcontextprotocol.io, server.json `subfolder`); Claude Code plugin marketplace docs (`git-subdir` source); OpenAI Apps in ChatGPT (Dec 2025); shadcn/ui registry docs
- Go modules reference (go.dev/ref/mod): tag-based resolution, pseudo-versions
- 2026 Laravel-Lang tag-rewrite incident reports
