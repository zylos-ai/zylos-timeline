---
date: "2026-08-07"
title: "View-Snapshot Binding: Anchoring Feedback to What Was Actually Shown"
description: "How code review, document collaboration, HTTP concurrency control, and event sourcing solve feedback silently binding to the wrong content version — and what AI agent approval workflows must borrow from them."
tags: ["ai-agents", "human-in-the-loop", "concurrency", "api-design", "event-sourcing", "security"]
---

## Executive Summary

A document review system renders a file to an approver (snapshot S1), the approver writes a comment, and the comment-create endpoint re-reads the file at write time (snapshot S2). If the document changed in between, the human's feedback is stored against content they never saw. This is not an edge case — it is the default failure mode of any system that treats "the current version of the document" as an implicit, mutable pointer rather than an explicit, immutable argument. The fix is structural, not cosmetic: the server must persist *which* rendered snapshot was actually served, bind every downstream artifact (comments, approvals, signatures) to that specific `view_snapshot_id`, and treat retries and concurrent edits with the same discipline used in payments APIs — idempotency keys plus compare-and-swap.

This problem has been solved, partially, in at least four adjacent fields: code review tooling (GitHub, Gerrit, Phabricator), collaborative document editing (Google Docs, CRDT/OT systems), web annotation standards (W3C Web Annotation, Hypothesis), and HTTP concurrency control (ETag/If-Match, idempotency keys). None of these fields calls the concept "view-snapshot binding," but all of them reinvented pieces of it. This article surveys that prior art, extracts the recurring design patterns, and argues that AI agent platforms — where content mutates at LLM-generation speed and a human "approval" click is often the only safety gate before an irreversible action — need to treat this as a first-class architectural concern, not an afterthought fixed with an `updated_at` timestamp check.

## The Problem: Feedback That Binds to the Wrong Version

The motivating case is simple. An approval workflow has three steps: (1) server renders document version N and serves it to a human reviewer; (2) reviewer reads it and composes a comment or approval decision; (3) reviewer submits, and the server's write path does `content = fetch_current(document_id)` before persisting the comment. If an agent (or another user) edited the document between steps 1 and 3, the comment is silently anchored to content the reviewer never laid eyes on. Nothing in the system state records that a mismatch occurred — there's no error, no warning, just a comment attached to the wrong text.

Two related failure modes compound this:

- **Retried writes forking state.** If the comment-submit request times out and the client retries, and the server has no idempotency key, the retry can be treated as a second, independent write — either creating a duplicate comment or, worse, racing with a concurrent edit to produce two different "current" states depending on which write wins.
- **"Replay what the reviewer saw" needing the full version, not an excerpt.** Even if you store the quoted text the reviewer highlighted, that's insufficient for audit or dispute resolution — you need the complete document state (or a diff-able reference to it) to reconstruct the review context, not just a fragment.

The unifying fix is to make "what was displayed" a durable, addressable fact — not a derived value recomputed at write time.

## Prior Art

### 1. Code Review Systems: Diff-Position Anchoring

Code review tools solved a narrower version of this problem two decades ago because diffs change constantly under active review, and comments must survive (or gracefully fail to survive) those changes.

**GitHub** anchors pull request review comments to a specific `commit_id`, not "the current PR head." The `POST /repos/{owner}/{repo}/pulls/{pull_number}/comments` endpoint requires `commit_id`, `path`, and either a legacy `position` (offset from the diff hunk header) or the modern `line`/`side`/`start_line`/`start_side` parameters ([GitHub REST API docs](https://docs.github.com/en/rest/pulls/comments)). GitHub's own docs warn that using a stale commit SHA "may render your comment outdated if a subsequent commit modifies the line you specify as the position" — the platform's answer is not to silently rebind the comment to the new content, but to mark it **outdated** and keep it visibly anchored to the old commit, with a diff-to-latest view available on demand. Developer discussions confirm the mechanism is coarse: pushing *any* commit can mark file-level comments outdated even when the commented file wasn't touched ([community discussion #86527](https://github.com/orgs/community/discussions/86527)), and comments can become temporarily invisible in the "Files changed" view when their anchor line shifts ([community discussion #23138](https://github.com/orgs/community/discussions/23138)). The lesson: anchoring to an immutable commit SHA is right; the UX of surfacing staleness is still an unsolved, actively debated problem even at GitHub's scale.

**Gerrit** goes further by making the *patch set* the unit of immutability. Each amended commit becomes a new numbered patch set under the same change, and comments are tied to a specific patch set's diff. Gerrit's project news explicitly changed comment permalinks to point at "the diff between the comment's patchset vs. latest instead of the comment's patchset vs. base" specifically to help reviewers verify whether their feedback was addressed ([Gerrit Project News #10](https://www.gerritcodereview.com/2020-11-18-gerrit-news-jun-nov-2020.html)) — i.e., Gerrit treats "what the comment was about" (patch set N) and "what the comment should be checked against now" (latest patch set) as two distinct, separately trackable facts.

**Phabricator's** Differential tool states the principle most explicitly in its own bug tracker: inline comments are "bound to the exact diff they are left on ('line 17 of changeset 28942 on diff 1842'), not a mutable location like 'line 17 on file x/y.c on the most recent diff of revision 293'" ([Differential inline comments guide](https://secure.phabricator.com/book/phabricator/article/differential_inlines/); see also task [T9628](https://secure.phabricator.com/T9628), which explicitly asks that "the comment submitted should be against what was seen," and [T7447](https://secure.phabricator.com/T7447) on porting comments forward). Phabricator "ports" old comments onto new diffs as a best-effort UX convenience, rendered with a "ghostly" visual treatment and a jump-back link to original context — never silently rewriting the anchor.

The common shape across all three: **bind to an immutable content identifier (commit SHA / patch-set number / diff ID), never to "current"; treat re-anchoring as an explicit, visibly-marked best-effort operation, not a silent default.**

### 2. Document Collaboration: CRDT/OT Position Anchoring and Web Annotation

Google Docs solves a harder version of the same problem because, unlike code diffs, prose is edited character-by-character in real time. Google's Drive API documentation states that a comment anchor is created by calling `comments.create` with "a JSON anchor string containing the revision ID and region," and warns plainly that "anchors are immutable, and their position relative to the content of a document cannot be guaranteed between revisions" ([Manage comments and replies, Google Drive API](https://developers.google.com/workspace/drive/api/guides/manage-comments)). This is a direct admission of the same problem: the anchor is a snapshot-relative coordinate, and using it against a different revision is explicitly unsupported.

Real-time collaborative editors solve the finer-grained version of "where did this annotation point, now that the text moved" with two complementary techniques:

- **CRDT relative positions (Yjs).** Yjs represents every character/element as an `Item` with a globally unique ID (`client`, `clock`). A `RelativePosition` stores a reference to that ID rather than a numeric offset, so it "stays correct regardless of what other users do to the document" — insertions and deletions elsewhere don't invalidate it ([Y.RelativePosition docs](https://docs.yjs.dev/api/relative-positions)). This is structurally identical to anchoring a comment to a commit SHA: the anchor references an immutable unit, not a position that shifts.
- **OT step mapping (ProseMirror).** ProseMirror's transform library provides a `Mapping` abstraction that "collects a series of step maps and allows you to map through them in one go," letting a position captured against document version N be translated forward to its corresponding position in version N+k ([prosemirror-transform README](https://github.com/ProseMirror/prosemirror-transform/blob/master/src/README.md); see also Marijn Haverbeke's [Collaborative Editing in ProseMirror](https://marijnhaverbeke.nl/blog/collaborative-editing.html)). This is the "translate an old anchor forward" analogue to Phabricator's comment-porting — but done losslessly because every intervening step is known and composable, rather than fuzzy-matched.

Where the underlying content isn't a live-editable CRDT/OT document — e.g., annotating arbitrary web pages you don't control — the **W3C Web Annotation Data Model** formalizes "anchoring" via typed Selectors (`TextQuoteSelector`, `TextPositionSelector`, `FragmentSelector`, `RangeSelector`) that describe *how* to relocate a target within a document ([Web Annotation Data Model, W3C Recommendation](https://www.w3.org/TR/annotation-model/)). **Hypothesis** implements the pragmatic, degraded-content case: it stores three selectors per anchor (range, text-position, text-quote-with-32-chars-context) and falls back through them in order, using a Bitap/Myers-diff-based fuzzy text search when the page has changed enough that exact positions no longer resolve ([Fuzzy Anchoring, Hypothesis](https://web.hypothes.is/blog/fuzzy-anchoring/)). This is the annotation-layer equivalent of "best-effort re-anchoring with visible degradation" — the system tries hard to relocate the anchor, but never pretends the relocation is exact when it isn't.

### 3. HTTP-Layer Machinery: ETag/If-Match and Idempotency Keys

The general HTTP mechanism for "I observed version X, only act if it's still X" is conditional requests. RFC 9110 defines `ETag` as an opaque identifier for a specific response representation and `If-Match`/`If-Unmodified-Since` as preconditions that make a write fail with `412 Precondition Failed` if the resource changed since the client last read it ([RFC 9110 §8.8, §13](https://www.rfc-editor.org/rfc/rfc9110.html); overview at [MDN: HTTP conditional requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Conditional_requests)). This is optimistic concurrency control at the transport layer, and it is the most direct HTTP-native tool for view-snapshot binding: the ETag of the *served* representation, presented back as `If-Match` on the comment-create call, forces the write to fail loudly instead of silently binding to new content.

Two subtleties matter for this specific problem:

- **The ETag of a rendered body is not the same thing as the version of the source content.** A document renderer might inject a timestamp, a per-request nonce, or reviewer-specific UI chrome into the HTML it serves — producing a different byte-for-byte ETag on every request even when the underlying source content is unchanged. Conflating "ETag of what was rendered" with "content version" causes false-positive conflicts (harmless re-renders blocked) or false negatives (the ETag is stable/generic while the source semantically changed underneath it). The `view_snapshot_id` needs to be pinned to the *source* content version (e.g., a content hash or a monotonic revision number of the underlying document), independent of incidental rendering variance.
- **Idempotency keys solve a different but adjacent problem: safe retries, not staleness detection.** Stripe's model — client generates a UUID, sends it as an `Idempotency-Key` header, server persists the first response keyed by that value and replays it verbatim on retry — guarantees a retried write has exactly one effect ([Designing robust and predictable APIs with idempotency, Stripe](https://stripe.com/blog/idempotency); [Idempotent requests, Stripe API reference](https://docs.stripe.com/api/idempotent_requests)). Brandur Leach's widely-cited implementation notes the concrete schema: an `idempotency_keys` table with `locked_at`, a `recovery_point` state machine ("started" → "ride_created" → "finished"), and `SERIALIZABLE` transactions so that "if two different transactions both try to lock any one key, one of them will be aborted by Postgres" ([Implementing Stripe-like Idempotency Keys in Postgres](https://brandur.org/idempotency-keys)). Compare-and-swap (CAS) — read a version counter, write only if it still matches — is the general primitive underneath both idempotency-key locking and ETag/If-Match ([Compare-and-swap, Wikipedia](https://en.wikipedia.org/wiki/Compare-and-swap)). The two must compose: idempotency keys prevent a retry from *duplicating* a comment; CAS/If-Match against `view_snapshot_id` prevents a comment from silently *forking* onto a document version the reviewer never saw. A system needs both — they close different gaps.

### 4. Event-Sourcing and Audit: Served-Content Logs and Temporal Queries

Event sourcing treats every state change as an immutable, appended event, which makes "what was true at time T" a first-class query rather than a reconstruction exercise — you can "replay events up to that timestamp" to derive historical state ([Time Travel using Event Sourcing Pattern](https://medium.com/@sudipto76/time-travel-using-event-sourcing-pattern-603a0551d2ff)). The relevant extension for view-snapshot binding is a **served-content log**: an explicit event, `DocumentServed{document_id, snapshot_id, served_to, served_at}`, recorded synchronously with the render — not the document's own edit history, but a record of *distribution*, which the edit history alone cannot answer ("what did user X actually receive," not "what did the document contain").

**Bitemporal / system-versioned tables** (SQL:2011) give the SQL-native version of the same capability: a table with `PERIOD FOR SYSTEM_TIME`, queryable with `FOR SYSTEM_TIME AS OF <timestamp>` to reconstruct exactly what a row looked like at a given instant, or `BETWEEN`/`FROM...TO` to see all versions visible across a range ([Temporal tables, SQL Server / Microsoft Learn](https://learn.microsoft.com/en-us/sql/relational-databases/tables/temporal-tables?view=sql-server-ver17)). The event-sourcing vs. temporal-tables comparison is instructive: temporal tables "don't have business information and correlation to changes between tables out of the box" — they tell you *that* a row changed and *what* it changed to, but not *why*, and critically not *who was shown which version when* ([Are Temporal Tables an alternative to Event Sourcing?, Event-Driven.io](https://event-driven.io/en/temporal_tables_and_event_sourcing/)). For view-snapshot binding you need the "served to whom" fact explicitly, whichever storage substrate you use underneath it.

### 5. The AI-Agent Twist: TOCTOU as the General Frame, and Artifact Signing

The general security vocabulary for "a check and an action separated by a gap in which the checked thing can change" is **TOCTOU — time-of-check to time-of-use**, formalized as CWE-367: a weakness where "the product checks the state of a resource before using that resource, but the resource's state can change between the check and the use in a way that invalidates the results of the check" ([CWE-367](https://cwe.mitre.org/data/definitions/367.html); background at [Time-of-check to time-of-use, Wikipedia](https://en.wikipedia.org/wiki/Time-of-check_to_time-of-use)). The view-snapshot binding bug is a TOCTOU bug: "check" = render-and-display; "use" = write feedback against current content; the gap is however long the human takes to read and respond.

This framing matters specifically for AI agent platforms because the gap is no longer a UI-race curiosity — it's structural. A July 2026 systematization-of-knowledge paper surveying 39 papers on AI coding agent execution security places TOCTOU races alongside sandbox isolation, MCP threats, and identity delegation as one of 17 core categories of agent execution-security research, explicitly framing cases where "an agent validates a piece of external state... and then acts on a stale copy of that state after it has changed," including trust-boundary races where "execution occurs before a user's trust decision takes effect" ([The Balkanization of Execution-Security Research for AI Coding Agents, arXiv:2607.05743](https://arxiv.org/abs/2607.05743)). An agent that regenerates a document between a human's read and their approval click is the same shape of bug as a symlink-swap TOCTOU exploit, just at the application layer instead of the filesystem layer — and the standard TOCTOU mitigations translate directly: eliminate the gap (bind check and action atomically), or make the check-then-use sequence itself atomic via locking/CAS rather than time-based assumptions.

The adjacent solved problem is **software supply-chain artifact signing**. Sigstore issues short-lived certificates tied to OIDC identity, signs the artifact, and logs the signature in the Rekor transparency log, so that what gets deployed is cryptographically tied to exactly the artifact that was built and reviewed — not "whatever is currently at that path" ([Software Supply Chain Security Beyond SBOMs: Sigstore, SLSA, and Build Provenance](https://aquilax.ai/blog/supply-chain-artifact-signing-slsa)). SLSA's Build track (levels L0–L3) formalizes provenance guarantees about *which* build produced *which* artifact. The analogy to document review is exact: a human approval should sign (or at minimum durably reference) the specific content hash/snapshot ID, functioning as a lightweight, human-issued attestation over an immutable artifact — the same shape as a CI system attesting over a build output.

### 6. 2025–2026 Developments: MCP and Agent Control Planes

The Model Context Protocol's July 2026 release candidate makes the transport **stateless**, removing the `Mcp-Session-Id` header and protocol-level sessions entirely, with every request instead carrying explicit version/capability metadata in `_meta` ([2026-07-28 MCP Specification Release Candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/); [Key Changes changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)). This is directionally aligned with view-snapshot binding: rather than relying on implicit, stateful "current session" context (which is exactly the anti-pattern that causes S1/S2 drift), the protocol is pushing toward requests that self-describe their exact version context. It does not yet standardize a resource-content version identifier equivalent to an ETag for MCP `resources/read` responses — that remains a gap for MCP server implementers to fill themselves, and one an agent platform building approval workflows over MCP resources should not assume is handled for them.

On the agent-platform-governance side, current writing on production AI agent control planes describes risk-tiered approval requiring "policy version snapshot" and "policy snapshot binding" as part of the audit record for approval events ([The AI Agent Control Plane in 2026, Preloop](https://preloop.ai/resources/ai-agent-control-plane-2026)), and human-in-the-loop frameworks like LangGraph implement approval as an `interrupt()` that serializes full state to a checkpoint and resumes only on explicit human input tied to that `thread_id` ([Human-in-the-loop, LangChain docs](https://docs.langchain.com/oss/python/langchain/human-in-the-loop)). Both are converging on the same idea from the agent side that GitHub/Gerrit/Phabricator converged on from the code-review side: **the object of approval must be a pinned, addressable version, not a live pointer.**

## Design Patterns

**1. Served-View Persistence.** On every render, persist a row: `{view_snapshot_id, document_id, content_hash, served_to, served_at}`. All downstream writes (comments, approvals, rejections) carry `view_snapshot_id` as a required argument, never inferred. This is the direct fix for the motivating bug — it's cheap, requires no fancy math, and is the single highest-leverage change. *Trade-off:* requires plumbing an extra ID through every client call and API surface; retrofitting into an existing UI is a breaking change to comment-creation contracts.

**2. Anchor + Fallback Fuzzy Re-anchoring.** Store a precise anchor (offset, node ID, or CRDT relative position) plus a redundant fuzzy anchor (quoted text with surrounding context, à la Hypothesis's TextQuoteSelector). When the precise anchor no longer resolves against current content, fall back to fuzzy text search, and **visibly mark the comment as re-anchored/approximate** rather than silently repositioning it. *Trade-off:* good UX continuity for long-lived comment threads on evolving documents, but re-anchored comments are inherently uncertain — never treat a fuzzy-relocated comment as equivalent to a precisely-anchored one for compliance/audit purposes.

**3. Immutable Artifact Gating.** Content-address the document (hash the canonical bytes) and make that hash — not a mutable document ID + "latest" — the thing that gets rendered, reviewed, and approved. Approval binds to the hash. This borrows directly from Git's object model and Sigstore/SLSA provenance: the approved thing and the deployed thing are checked for byte-identity, not "same document_id, presumably still current." *Trade-off:* requires a content-addressed storage layer or at minimum a strong hash column; needs a clear policy for what happens when a newer version exists (block, re-request approval, or allow with a diff-visible warning).

**4. Idempotency-Key + CAS Write Discipline.** Every comment/approval submission carries a client-generated idempotency key (dedupes retries) *and* a CAS precondition — `If-Match: <view_snapshot_id or content ETag>` or an equivalent application-level version check (rejects writes against stale current-state, returning 409/412 rather than forking). These solve different problems and both are required: idempotency-key alone permits binding to the wrong version consistently on retry; CAS alone permits duplicate side effects on retry without the key. *Trade-off:* adds a `409 Conflict`/`412 Precondition Failed` path the client UI must handle gracefully (typically: "the document changed since you viewed it — reload and re-review").

**5. Outdated-but-Visible (Soft Invalidation).** When a document changes after a comment/approval was anchored, don't delete, don't silently rebind — mark the artifact "outdated relative to version N+1" and keep both the old anchor and a path to the diff against current, as GitHub and Phabricator do. This preserves the audit trail's integrity: the human's original judgment about version N remains a true fact even after N+1 exists. *Trade-off:* UI complexity in surfacing staleness without overwhelming reviewers (GitHub's own community routinely files bugs about outdated-comment visibility, suggesting this is a genuinely hard UX problem, not just an engineering afterthought).

**6. Point-in-Time Replay via Served-Content Log + Temporal Storage.** Combine pattern 1 with system-versioned/temporal tables (or an event-sourced document store) so that "replay exactly what the reviewer saw" is a first-class, ordinary query — `SELECT content FOR SYSTEM_TIME AS OF <served_at>` or equivalent — rather than a forensic exercise reconstructing state from scattered logs. *Trade-off:* storage/retention cost for full historical content, and a retention policy decision (how long must "what did they see" remain reconstructable — indefinitely for compliance-heavy domains, 24h–30d for most others, mirroring Stripe's guidance to recycle idempotency keys after a bounded horizon).

### Illustrative schema sketch

```sql
-- The core fix: persist what was served, don't recompute it at write time.
CREATE TABLE view_snapshots (
    view_snapshot_id   UUID PRIMARY KEY,
    document_id        UUID NOT NULL,
    content_hash        TEXT NOT NULL,   -- content-addressed: hash of canonical bytes
    revision_number     BIGINT NOT NULL, -- monotonic source revision, not render revision
    served_to           UUID NOT NULL REFERENCES users(id),
    served_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every downstream write requires the snapshot id explicitly.
CREATE TABLE comments (
    comment_id          UUID PRIMARY KEY,
    view_snapshot_id    UUID NOT NULL REFERENCES view_snapshots(view_snapshot_id),
    idempotency_key      UUID NOT NULL,
    body                 TEXT NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (idempotency_key)
);

-- Write path (pseudocode):
--   1. snapshot = view_snapshots.get(view_snapshot_id)              -- must exist
--   2. current  = documents.get(snapshot.document_id)
--   3. if current.revision_number != snapshot.revision_number:
--        return 409 Conflict  { "reason": "document_changed_since_view",
--                                "viewed_revision": snapshot.revision_number,
--                                "current_revision": current.revision_number }
--        -- pattern 5: do NOT silently rebind; surface the diff, let the human decide
--   4. insert comment with (view_snapshot_id, idempotency_key) — CAS via UNIQUE constraint
--   5. return 201, comment bound to snapshot.content_hash, not to "current"
```

The `409` path is the entire fix: it converts a silent data-integrity bug into a visible, recoverable UX moment — "the document changed since you looked at it, here's the diff, re-review or proceed knowingly" — which is exactly what GitHub does with outdated PR comments, what Google Docs' anchor API refuses to guarantee across revisions, and what Stripe's idempotency layer does for retried payments.

## Implications for AI Agent Platforms

Agent-generated content changes at a categorically different rate than human-edited documents — an agent can regenerate a full document in the seconds it takes a human to read the first paragraph. This makes the S1/S2 drift bug far more likely to trigger in practice than in human-only code review, where the analogous window (someone force-pushes while you're mid-review) is comparatively rare. Three consequences follow:

- **Human approval gates are only as meaningful as their binding.** An "approve" click that resolves against "current content" rather than a pinned `view_snapshot_id` is security theater: it looks like a human-in-the-loop control but doesn't actually constrain what gets acted on. This is the direct analogue of TOCTOU-vulnerable privilege checks — the approval is the "check," the agent's subsequent action is the "use," and if they're not atomically tied to the same state, the gate can be silently bypassed by ordinary concurrent activity, no attacker required.
- **"Review-to-deploy artifact equivalence" should be a platform invariant, not a per-feature choice.** Just as SLSA provenance ties a specific build to a specific source commit, agent platforms should be able to prove — not just claim — that the artifact a human approved is byte-identical to the artifact that was subsequently executed/published/deployed. Content-addressing plus a signed (or at minimum, logged and hash-pinned) approval record gives this for free.
- **MCP and similar agent-tool protocols currently leave resource-versioning as an implementer's problem.** With the 2026-07-28 MCP spec moving toward stateless, self-describing requests, platform builders integrating document/resource review over MCP should not assume the protocol gives them staleness detection — they need to add their own content-hash or revision-ID field to resource payloads and treat it as load-bearing, the same way they'd treat an ETag.

## Open Questions

- **Granularity of "snapshot."** Is a `view_snapshot_id` per full-document render sufficient, or does fine-grained agent-mediated collaboration (e.g., multiple agents editing different sections concurrently) require CRDT-style sub-document anchors even for approval workflows, not just for live co-editing?
- **Retention economics.** Full point-in-time replay (pattern 6) is expensive at scale. What's the right default retention window for "what was served" logs in regulated vs. unregulated domains, and should it differ from idempotency-key retention (typically 24h)?
- **UX for staleness, unsolved even by market leaders.** GitHub's own community continues to file friction reports about outdated-comment visibility years after the mechanism was built — suggesting "tell the human their feedback is now stale, without being annoying or lossy" is still an open interaction-design problem, not just a backend one.
- **Standardization gap.** No standard equivalent of RFC 9110's ETag/If-Match exists yet for "the version of the semantic content a human was shown," as distinct from "the version of the rendered representation." Should this be an MCP extension, a W3C Web Annotation profile, or an application-layer convention each platform reinvents?
- **Agent-as-reviewer.** Everything above assumes a human is the approver being protected from stale content. As agents themselves start approving other agents' outputs (agent-mediated review chains), does the same binding requirement apply symmetrically, and does an agent's "view" of a snapshot need the same immutability guarantee as a human's?

## References

- [REST API endpoints for pull request review comments — GitHub Docs](https://docs.github.com/en/rest/pulls/comments)
- ["File" comments all get outdated when you push anything — GitHub community discussion #86527](https://github.com/orgs/community/discussions/86527)
- [Review comments not shown in "Files changed" — GitHub community discussion #23138](https://github.com/orgs/community/discussions/23138)
- [Gerrit Project News #10: June–November 2020](https://www.gerritcodereview.com/2020-11-18-gerrit-news-jun-nov-2020.html)
- [Review UI — Gerrit Code Review documentation](https://gerrit-review.googlesource.com/Documentation/user-review-ui.html)
- [Differential User Guide: Inline Comments — Phabricator](https://secure.phabricator.com/book/phabricator/article/differential_inlines/)
- [T9628: comment submitted should be against what was seen — Phabricator](https://secure.phabricator.com/T9628)
- [T7447: Bring inline comments forward across revision updates — Phabricator](https://secure.phabricator.com/T7447)
- [Manage comments and replies — Google Drive API](https://developers.google.com/workspace/drive/api/guides/manage-comments)
- [Y.RelativePosition — Yjs Docs](https://docs.yjs.dev/api/relative-positions)
- [prosemirror-transform README — ProseMirror](https://github.com/ProseMirror/prosemirror-transform/blob/master/src/README.md)
- [Collaborative Editing in ProseMirror — Marijn Haverbeke](https://marijnhaverbeke.nl/blog/collaborative-editing.html)
- [Web Annotation Data Model — W3C Recommendation](https://www.w3.org/TR/annotation-model/)
- [Fuzzy Anchoring — Hypothesis blog](https://web.hypothes.is/blog/fuzzy-anchoring/)
- [HTTP conditional requests — MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Conditional_requests)
- [RFC 9110 — HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html)
- [Designing robust and predictable APIs with idempotency — Stripe](https://stripe.com/blog/idempotency)
- [Idempotent requests — Stripe API Reference](https://docs.stripe.com/api/idempotent_requests)
- [Implementing Stripe-like Idempotency Keys in Postgres — brandur.org](https://brandur.org/idempotency-keys)
- [Compare-and-swap — Wikipedia](https://en.wikipedia.org/wiki/Compare-and-swap)
- [Time Travel using Event Sourcing Pattern](https://medium.com/@sudipto76/time-travel-using-event-sourcing-pattern-603a0551d2ff)
- [Are Temporal Tables an alternative to Event Sourcing? — Event-Driven.io](https://event-driven.io/en/temporal_tables_and_event_sourcing/)
- [Temporal Tables — SQL Server, Microsoft Learn](https://learn.microsoft.com/en-us/sql/relational-databases/tables/temporal-tables?view=sql-server-ver17)
- [Time-of-check to time-of-use — Wikipedia](https://en.wikipedia.org/wiki/Time-of-check_to_time-of-use)
- [CWE-367: Time-of-check Time-of-use (TOCTOU) Race Condition](https://cwe.mitre.org/data/definitions/367.html)
- [The Balkanization of Execution-Security Research for AI Coding Agents — arXiv:2607.05743](https://arxiv.org/abs/2607.05743)
- [Software Supply Chain Security Beyond SBOMs: Sigstore, SLSA, and Build Provenance — AquilaX](https://aquilax.ai/blog/supply-chain-artifact-signing-slsa)
- [The 2026-07-28 MCP Specification Release Candidate — Model Context Protocol Blog](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
- [Key Changes — Model Context Protocol Changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [The AI Agent Control Plane in 2026 — Preloop](https://preloop.ai/resources/ai-agent-control-plane-2026)
- [Human-in-the-loop — LangChain Docs](https://docs.langchain.com/oss/python/langchain/human-in-the-loop)
