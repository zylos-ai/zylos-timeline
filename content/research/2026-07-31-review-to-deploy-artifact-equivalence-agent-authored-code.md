---
date: "2026-07-31"
title: Proving What Shipped Is What Was Reviewed, When an Agent Wrote It
description: A technical guide to content-addressable equivalence gating — using git tree hashes, reproducible builds, and SLSA/in-toto/Sigstore attestation to prove a deployed artifact is unchanged from what a human or reviewer agent approved, with a worked squash-merge example.
tags: ["supply-chain", "provenance", "reproducible-builds", "ai-agents", "git-internals", "slsa", "deployment-integrity", "sigstore"]
---

## Executive Summary

Code review approves a commit SHA; deployment ships a container image built from a different SHA, produced by a squash-merge, a tag, and a rebuild. Every one of those transformations is benign, but each breaks the naive assumption that "the SHA I reviewed" and "the SHA that's running" are the same identifier — commit hashes fold in metadata (parents, timestamps, committer) that changes on every rewrite, even when no file content changed. This gap has existed since Git adopted squash-merge workflows, but it sharpens once AI agents author the code and drive the merge-to-deploy pipeline with less continuous human attention at each hop. The fix is not to chase commit SHAs harder; it's to compare the right invariant. Git's tree object hashes file content independent of history, so `rev-parse <ref>^{tree}` is stable across squash and rebase and gives zero-drift proof for free. Pair that with reproducible/deterministic builds to extend the proof from source tree to built artifact, and with SLSA/in-toto/Sigstore attestation to make the chain independently verifiable. None of this validates that the reviewed code is *correct* — only that it is *unchanged*. This article covers the mechanics, a worked squash-merge-to-deploy example, the current state of the supporting standards, and a practical adoption ladder.

## The Review-to-Deploy Trust Gap

Code review's implicit contract: someone looks at a diff anchored to an identifier, approves it, and everyone downstream treats that identifier as a proxy for "reviewed and safe." The identifier almost everyone reaches for is the commit SHA, because it's what shows up in the URL bar.

That proxy breaks the moment the artifact moves through ordinary steps:

- **Squash merge**: collapses N commits into one new commit object with a new parent, new committer timestamp, and often a rewritten message. File content can be byte-identical to what was reviewed, but the commit SHA is necessarily new.
- **Rebase / merge commit**: same story — the commit hash covers history-plus-metadata, not content alone.
- **Tagging**: an annotated tag is its own object with its own SHA, one more layer removed from the reviewed commit.
- **Container rebuild**: produces a new image digest on each invocation unless the build is deliberately made deterministic — timestamps, file ordering, and compiler metadata routinely leak in.

Once any of these happens, "does the deployed SHA match the reviewed SHA?" is the wrong question — the honest answer is always no. Teams either give up on verifying the linkage, trusting the pipeline's say-so, or build brittle SHA-lineage tooling that breaks on the first force-push or cherry-pick.

This is old news for human-driven orgs, handled by convention and spot-checks. It sharpens with an AI agent as author: agents routinely regenerate a PR (amend, rebase, push a new commit) between approval and CI; an executor agent "addressing review comments" may re-run codegen that touches unrelated files; and agent-authored volume makes manual re-review of every SHA transition impractical. The question needs a cheap, automatable, cryptographic answer — not a process reminder.

## Why Commit-SHA Anchoring Breaks: The Git Object Model

Git's storage is a content-addressable Merkle DAG with four object types, each named by the SHA of its own contents:

| Object | Contains | Hash covers |
|---|---|---|
| **blob** | raw file bytes | file content only |
| **tree** | directory listing: names, modes, blob/tree hashes of entries | the file contents and paths below it |
| **commit** | tree hash, parent hash(es), author, committer, timestamps, message | tree hash **plus** history and metadata |
| **tag** (annotated) | target object hash, tagger, message | target hash plus tagging metadata |

A commit's hash covers the tree hash *and* the parent pointer(s), identity, and timestamps — change any of those, even with a byte-identical tree, and you get a new commit SHA. A tree's hash covers only the recursive content of files and directories: same files, same paths, same modes ⇒ same tree hash, regardless of who committed it, when, or through how many intermediate commits.

That's why a squash merge changes the commit SHA but can leave the tree SHA untouched: squashing rewrites history without necessarily touching a file. If the target branch was current at merge time and no conflict resolution altered content, the resulting tree equals the tree of the last reviewed commit, even though the wrapping commit object is entirely new.

```bash
# Show a commit's object graph: tree, parent, author, message
git cat-file -p <commit-sha>

# Extract the tree hash a ref points to
git rev-parse <ref>^{tree}      # equivalently: git rev-parse <ref>:

# Compare two commits' trees directly — empty output means zero file drift
git diff <sha-A>^{tree} <sha-B>^{tree}
```

These are plumbing commands operating on Git's object model directly, so they behave predictably under scripting. `git diff A^{tree} B^{tree}` with no output is the strongest cheap statement available: not "these commits look similar" but "these trees hash to the same content" (barring a hash collision — one reason Git and hosting providers have hardened against known SHA-1 attacks and are moving toward SHA-256 object storage).

## Tree-Hash Equivalence: The Worked Example

**1. Agent opens a PR at commit `X`.** A coding agent pushes a branch; CI runs; a human or reviewer-agent approves the diff at exactly commit `X`. The approval and CI run are anchored to `X`'s tree, `T1`.

**2. Squash-merge to `main` produces commit `Y`.** The platform computes a new tree from the squash (identical to `T1` if `main` hadn't moved and the merge was clean), assigns a new committer, timestamp, and parent. `Y ≠ X`, but `Y`'s tree may still be `T1`.

**3. A verifier gate checks tree equivalence before release**, instead of the always-false `Y == X`:

```bash
REVIEWED_TREE=$(git rev-parse X^{tree})
MERGED_TREE=$(git rev-parse Y^{tree})

if [ "$REVIEWED_TREE" = "$MERGED_TREE" ]; then
  echo "OK: zero file drift between reviewed and merged commit"
else
  echo "FAIL: merged tree diverges from what was reviewed" >&2
  git diff X^{tree} Y^{tree}   # exact diff of what changed
  exit 1
fi
```

If this passes, every byte of every file in `Y` is provably identical to what the reviewer saw — the squash's history rewriting is irrelevant, because tree hashing doesn't see history. If it fails, you get an exact diff: either a benign merge-conflict resolution needing re-review, or something that shouldn't be there.

**4. A release tag is cut on `Y`.** `git tag -a v2.7.0 Y` creates a new tag object, but the check already ran against `Y`'s tree — the tag is a durable pointer to an already-verified tree. The tag's own SHA is irrelevant to the equivalence proof.

**5. Deploy checks out the tag, builds, and pins by digest**, not tag name:

```bash
git rev-parse v2.7.0^{tree}    # must equal $MERGED_TREE from step 3

IMAGE_DIGEST=$(docker buildx build --push -t registry/app:v2.7.0 . \
  --metadata-file meta.json && jq -r '."containerimage.digest"' meta.json)

kubectl set image deployment/app app=registry/app@${IMAGE_DIGEST}
```

A tag is a mutable pointer that can be retargeted, accidentally or maliciously; a digest is the content hash of the image manifest. Deploying by digest means "exactly this image, byte for byte," the same guarantee tree-hash comparison gives for source. The proof chain: reviewed tree → merged tree (equal, proven) → tagged tree (equal, proven) → built image digest (deployed, pinned) → running workload (re-verifiable by digest at any time).

Most CI pipelines that try to enforce "review == deploy" today compare commit SHAs, branch pointers, or PR numbers — porcelain identifiers that don't survive a squash or cherry-pick without deliberate lineage tooling. Tree-hash comparison sidesteps this by operating one layer down, on Git's actual content model, where "same content" has one unambiguous, checkable answer.

## Extending the Proof Through the Build: Reproducible Builds

Tree-hash equivalence proves the *source* is unchanged; it says nothing about the *build*. Two builds of an identical tree can produce different bytes for uninteresting reasons — embedded timestamps, filesystem walk order, absolute paths in debug info — making output comparison impossible even when the inputs matched.

Reproducible builds solve this. The Reproducible Builds project (originating in Debian, now spanning F-Droid, Arch, Google, and others) defines it precisely: *"A build is reproducible if given the same source code, build environment, and build instructions, any party can recreate bit-by-bit identical copies of all specified artifacts."* Verification is mechanical: hash and compare.

Documented sources of nondeterminism include timestamps embedded in metadata or build-time strings; unsorted filesystem/input ordering that changes archive member order; locale/environment leakage into output; absolute build paths baked into debug symbols; and parallelism-dependent interleaving. The standard fix for timestamps is `SOURCE_DATE_EPOCH`, a widely adopted environment variable (usually the last relevant commit's date) that build tools consume instead of wall-clock time. Full reproducibility also typically requires pinned toolchain versions and base images, and normalized archive ordering.

When a build is genuinely reproducible, deploy-side verification becomes trivial: rebuild independently from the same verified tree and pinned toolchain, diff the output hash against what was deployed. A match extends the equivalence proof from source all the way to the running artifact. Reproducibility is genuinely hard beyond small, self-contained builds — dependency resolution, codegen nondeterminism, and native bindings are real obstacles — so treat it as an incremental target (pin toolchain and base images first, normalize timestamps/ordering next, full bit-for-bit last), not a binary switch.

## The Attestation Layer: SLSA, in-toto, Sigstore

Tree-hash equivalence and reproducible builds give you the mechanism; attestation gives you a standardized, independently verifiable *record* that it was followed — needed once "trust the CI script" isn't enough for an auditor or an outside consumer.

**in-toto** (CNCF graduated) defines a signed-envelope format for verifiable claims about supply-chain steps: who performed a step, what inputs/outputs it had, how it relates to the rest of the chain. It's the technical substrate other frameworks build on.

**SLSA** (Supply-chain Levels for Software Artifacts, v1.2) is a maturity framework built on in-toto attestations, with two tracks approved as of v1.2 (November 2025):

| Track | Certifies | Levels |
|---|---|---|
| **Build** | how an artifact was built | L0 none → L1 provenance exists (unsigned) → L2 signed provenance, hosted platform → L3 hardened/isolated platform, signing secrets inaccessible to build steps |
| **Source** | how the source revision came to exist | L0 none → L1 version control → L2 change history + per-revision provenance → L3 org controls enforced/recorded → L4 mandatory two-person review |

The Source Track is directly relevant: it requires that if additional changes are made *during* review, those changes must be reviewed too — codifying, as a formal control, the exact "review must cover the final revision" problem this article addresses. L4 requires two trusted parties to agree before a change lands on a protected branch, with a defined "Trusted Robot" exception for automation like dependency bots.

**Sigstore** provides the signing/transparency infrastructure making these attestations trustworthy: **Fulcio** issues short-lived certificates bound to an OIDC identity (no long-lived key management); **Rekor** is an append-only transparency log timestamping every signing event, making forged or backdated attestations detectable; **cosign** is the CLI tying both together for signing and verifying artifacts.

**GitHub artifact attestations** (`actions/attest`) operationalize this for GitHub Actions: a workflow generates an in-toto/SLSA provenance attestation after build, signs it via Sigstore, and stores it queryable by digest:

```bash
gh attestation verify oci://ghcr.io/ORG/IMAGE:tag -R ORG/REPO
```

This cryptographically confirms the digest was produced by a specific workflow run in a specific repository.

None of these layers substitutes for the others: tree-hash equivalence is the fast, mandatory, zero-infrastructure check; reproducible builds extend the proof to build output but require real engineering investment; attestation doesn't prove equivalence itself — it proves *who* claimed *what*, non-repudiably, verifiable by someone outside the pipeline. A pragmatic stack: tree-hash gating on every merge, reproducible builds as a stretch goal for high-value artifacts, attestation for external auditability.

## The AI-Agent-Specific Risk Surface

- **Regenerate-between-review-and-merge.** An executor agent told to "address review comments" may regenerate a larger diff than warranted, or re-run a codegen/formatting pass touching unrelated files, after a human approved an earlier tree. Tree-hash gating catches this automatically, forcing a conscious re-review instead of a silent pass-through.
- **Executor/reviewer separation of duty.** When both authoring and merging can be agent-driven, SLSA Source Track's two-party model is a useful frame: define the "uploader" (authoring agent) versus "reviewer" (human, or a separately-scoped reviewer agent without branch write access), and bind the approval event to a specific tree hash — not a PR number — so a reviewer that approves text without re-hashing the current tree isn't a meaningless rubber stamp.
- **Agents as CI participants.** If an agent can trigger rebuilds or push follow-up commits, treat it like SLSA Build L3 treats build workers: isolated, no access to signing secrets, no ability to alter provenance after the fact. Guidance from CISA/NSA/Five Eyes on AI coding agents (May 2026) recommends treating them as untrusted components by default — an argument for hard gates over policy-only controls.
- **Volume changes the economics.** Agent PR volume can make manual SHA spot-checks, merely inconvenient at human scale, impractical at agent scale — the real argument for automating the check rather than relying on convention.

## Practical Adoption Ladder

1. **Tree-hash gate on merge (do this first).** A CI check comparing `rev-parse <reviewed-sha>^{tree}` against `rev-parse <merged-sha>^{tree}`, failing with a diff on mismatch — a shell script and a CI hook, no new infrastructure.
2. **Deploy by digest, not tag.** Resolve to the immutable content digest at deploy time; stop deploying `image:latest` or even a version tag.
3. **Record who approved which tree**, not just which PR number — makes step 1 auditable and is a lightweight precursor to formal Source Track attestations.
4. **Adopt build provenance attestation** (GitHub artifact attestations, or self-hosted in-toto/Sigstore) once consumers need to verify provenance without trusting your CI's word.
5. **Invest in reproducible builds** for the highest-value artifacts last — the most expensive step, with the biggest payoff for widely-consumed or security-critical components.

## Limits: What This Does and Does Not Guarantee

- **Proves "unchanged," not "correct."** A reviewer who approved buggy or malicious code gets a solid guarantee that the same buggy or malicious code shipped — the gate can't detect that the code was wrong to approve. That's still the job of review itself.
- **Proves file identity, not build or runtime identity**, unless paired with reproducible builds and digest pinning.
- **Doesn't cover build-time inputs outside the tree**, such as the *resolved* dependency graph, unless that resolution is itself reproducible.
- **Attestation proves who signed what, not that it was good.** Sigstore/SLSA answer "did this claim come from this identity, unmodified, at this time" — not whether the claim's content was sound.
- **Hash collision resistance is a background assumption**, not an absolute guarantee — the equivalence proof inherits whatever collision resistance the underlying hash function has.
- **Process discipline still matters.** A two-person-review control is only as strong as the boundary between "uploader" and "reviewer" identities — if the same agent (or human, wearing two hats) can satisfy both roles, the control is theater regardless of the cryptography underneath.

Content-addressable equivalence gating converts "trust that nothing changed" from an assumption into a cheap, mechanically checkable fact — a meaningfully stronger property than most pipelines have today, but one link in a longer chain. Correctness, dependency integrity, and role separation all still need their own controls.

## References

- [Git Internals - Git Objects](https://git-scm.com/book/id/v2/Git-Internals-Git-Objects) — blob/tree/commit object model
- [git-rev-parse Documentation](https://git-scm.com/docs/git-rev-parse) — `<rev>^{tree}` and `<rev>:` tree-hash syntax
- [Git Tools - Revision Selection](https://git-scm.com/book/en/v2/Git-Tools-Revision-Selection)
- [Save the precious build minutes! Reusing build outputs with Git Tree Hash](https://dev.to/taskworld/save-the-precious-build-minutes-reusing-build-outputs-with-git-tree-hash-k61) — practical tree-hash usage pattern
- [Reproducible Builds — Definitions](https://reproducible-builds.org/docs/definition/) — canonical definition of a reproducible build
- [Reproducible Builds — SOURCE_DATE_EPOCH](https://reproducible-builds.org/docs/source-date-epoch/)
- [Reproducible Builds — Variations in the build environment](https://reproducible-builds.org/docs/env-variations/) — sources of nondeterminism
- [SLSA Specification v1.2](https://slsa.dev/spec/v1.2/) — Build Track and Source Track overview
- [SLSA Source Track Requirements](https://slsa.dev/spec/v1.2/source-requirements) — L0–L4, two-person review requirement
- [SLSA and in-toto](https://slsa.dev/blog/2023/05/in-toto-and-slsa) — relationship between the two frameworks
- [in-toto Attestation Framework](https://github.com/in-toto/attestation) — attestation envelope/predicate spec
- [in-toto project](https://in-toto.io/)
- [Sigstore Cosign — Signing Overview](https://docs.sigstore.dev/cosign/signing/overview/)
- [Sigstore Security Model](https://docs.sigstore.dev/about/security/) — Fulcio, Rekor, keyless signing
- [sigstore/cosign on GitHub](https://github.com/sigstore/cosign)
- [Using artifact attestations to establish provenance for builds — GitHub Docs](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds)
- [actions/attest-build-provenance](https://github.com/actions/attest-build-provenance)
- [Container Image Digests vs Tags: Pin by Digest](https://safeguard.sh/resources/blog/container-image-digests-vs-tags-why-pinning-matters) — digest immutability vs tag mutability
- [Using container image digests in Kubernetes manifests — Google Cloud Docs](https://docs.cloud.google.com/kubernetes-engine/docs/tutorials/using-container-image-digests-in-kubernetes-manifests)
- [Merkle trees in Git and Bitcoin — Initial Commit](https://initialcommit.com/blog/git-bitcoin-merkle-tree) — content-addressable Merkle DAG framing
