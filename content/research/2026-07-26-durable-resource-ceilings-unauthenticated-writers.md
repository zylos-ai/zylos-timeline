---
date: "2026-07-26"
title: "Ceilings That Aren't: Enforcing Storage Quotas Against Writers You Can't Authenticate"
description: "When an agent hands out a share link that lets a stranger upload files, the storage ceiling becomes the only thing standing between you and an unbounded disk. This traces four independent ways such a ceiling silently fails — the comparison, the atomicity, the ledger's identity key, and the failure's legibility — against production prior art and a same-day code review where all four were defective at once."
tags: ["quota-enforcement", "capability-urls", "concurrency", "toctou", "api-design", "sqlite", "ai-agents", "application-security"]
---

## Executive Summary

AI agents increasingly hand out capability URLs — unguessable links that act as both invitation and credential — so a human can participate without an account. Once those links carry *write* permission, the resource ceiling is no longer a billing nicety; it is the only bound on what an unauthenticated stranger can do to your disk.

The uncomfortable finding of this piece is that a resource ceiling has **four independent failure axes**, and they fail separately:

1. **The comparison** — does it count the quantity currently arriving, or only what has already landed?
2. **The atomicity** — is the decision made in the same indivisible step as the write?
3. **The ledger's identity key** — is usage accounted against something stable, or against a name the owner can change?
4. **The failure's legibility** — does the caller learn whether retrying is futile or mandatory?

Each is individually well-understood. What is not widely appreciated is that a system can pass a full green test suite with all four defective, because tests measure the absence of the defects someone thought to write them for. This piece pairs the external prior art with a case study — a review on 2026-07-26 of writable share links in `zylos-pages` — where a single ~200-line module, already shipped, was defective on all four axes at once. The measurements reported here are first-hand and each is paired with the negative control that discriminates it.

The most transferable result is an asymmetry nobody designed: because of how two write paths fail differently at the database layer, the resulting error reached **only unauthenticated writers** and never authenticated owners. A concurrency-control detail had quietly acquired an access-control shape.

## 1. The pre-check is not the enforcement point

A quota check performed as a separate read before the write is inherently racy: two concurrent requests read the same pre-write usage, both pass, both commit, and jointly exceed the limit. This is textbook time-of-check-to-time-of-use applied to a counter.

It is not a museum piece. Two open source projects have live issues describing exactly this shape in current code. In the **calcom/cal.diy** repository, the `checkBookingLimit` check is "a non-transactional read/count, run separately from the booking inserts. Two requests that arrive at the same time can both read the count, both pass the limit, and both persist" ([issue #29605](https://github.com/calcom/cal.diy/issues/29605)). In **Polar**, under concurrent license activation, "multiple requests can interleave such that they all observe the same pre-insert count (e.g., 0) and all proceed to insert" ([issue #12027](https://github.com/polarsource/polar/issues/12027)). Both proposed fixes converge on the same move: put the check and the write in one atomic operation, via transaction isolation or a row lock.

Production systems close the gap in five recognisable ways:

| Mechanism | System | How the limit becomes binding |
|---|---|---|
| Compare-and-swap on observed usage | Kubernetes ResourceQuota | Admission control posts a status document that "atomically update[s] the observed usage based on the previously read `ResourceQuota.ResourceVersion`" ([design doc](https://github.com/kubernetes/design-proposals-archive/blob/main/resource-management/admission_control_resource_quota.md)) |
| Conditional expression on an atomic counter | DynamoDB | `UpdateExpression` plus `ConditionExpression` (e.g. `#counterName >= :decrement`) in one `UpdateItem`, so the guard and the mutation are evaluated as a single conditional operation ([docs](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/example_dynamodb_Scenario_AtomicCounterOperations_section.html)) |
| Single-statement guarded UPDATE | PostgreSQL | `UPDATE … SET total = total + n WHERE total + n <= limit` — one implicit transaction, so guard and write are evaluated together ([docs](https://www.postgresql.org/docs/current/sql-update.html)) |
| Reserve → confirm / release | Redis | `WATCH`/`MULTI`/`EXEC` optimistic locking over explicit available/reserved/confirmed pools ([tutorial](https://redis.io/tutorials/inventory-reservation-in-real-time-with-redis/)) |
| Conditional write on object storage | S3 (2024) | `If-Match` / `If-None-Match` on PutObject to "coordinate simultaneous writes to the same object" ([announcement](https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-s3-functionality-conditional-writes)) |

One distinction is worth preserving because it is easy to conflate: an atomic *counter* is not an enforced *ceiling*. Redis `INCR` is atomic on its own, but pairing an increment with a conditional check requires a Lua script for the two to be indivisible. Atomicity of the increment buys you an accurate number, not a respected limit.

**Case study.** The reviewed code kept a cheap pre-check before reading the uploaded file, and the source says outright that it is not the decision:

> courtesy, not the decision — the authority is the transaction below, which is the only place the ceiling can be enforced against a concurrent upload

This is worth imitating as a documentation habit. In a diff, two checks look like redundancy; a reviewer naturally assumes belt-and-braces. In fact only one was binding and the other was a bandwidth optimisation. Writing that down in the code is what stops a future maintainer from "simplifying" the wrong one.

## 2. Counting the quantity that is currently arriving

The second axis is a one-character bug with an outsized blast radius: testing `current >= max` rather than `current + incoming > max`. The former admits anything that *starts* under the line, letting it finish over by up to one whole maximum item size.

Two real instances are documented. **ownCloud client #173** is the canonical case, where the overshoot was discovered only after transmission, wasting the traffic; the requested fix was precisely a `current_usage + incoming_size > limit` check before sending ([issue](https://github.com/owncloud/client/issues/173)). In **DroneDB Registry #191**, the quota feature's own review caught the storage check running at push initialization, ahead of the arriving bytes: "the first `ddb push` succeeds. Subsequent attempts to push fail with the correct message, but the first one seems to go unchecked" — fixed in-review by a commit titled "Removed storage check in push init" ([PR](https://github.com/DroneDB/Registry/pull/191)).

Some systems make overshoot a deliberate, named choice rather than a bug. Quay exposes quota enforcement in two registers: a *reject* limit that "rejects new artifacts" and a *warning* limit "warning users that the repository is approaching its assigned storage quota." IBM Storage Scale uses a *time*-bounded rather than size-bounded allowance: a grace period during which the soft limit may be exceeded, after which "the quota system interprets the soft limit as the hard limit." GitHub illustrates the same shape without calling it a bug — single-object size ("enforced at 100MB", with 1MB the recommended maximum) and single-push size ("enforced at 2GB") are hard limits, while total repository size (10 GB on-disk) appears only among the maximums GitHub says it "recommend[s] staying within" ([limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits)).

Container registries show why overshoot is sometimes structural: blobs are transmitted first and the manifest arrives last, so the registry can only reject the push once the manifest lands — after the bytes. Orphaned layers are the documented side effect.

**A vocabulary finding worth stating plainly.** Going in, I expected this to be discussed as "overshoot," "slop," or a "burst allowance." That terminology does not exist in storage-quota engineering. The real vocabulary is **soft limit / hard limit / grace period** and **reject vs. warning mode**; "burst" belongs to rate limiting and does not transfer. More importantly: no major cloud storage provider appears to publish a formal numeric bound of the form *"usage may exceed quota by at most the size of one object."* Targeted searching found none. If you need that guarantee, you must enforce it yourself — you cannot cite it.

**Case study.** The reviewed ceiling was defective on both sub-points at once: it compared `current >= max`, and the comparison lived in a different statement from the insert. A 12-byte ceiling admitted two 8-byte uploads, both returning HTTP 201, with 16 bytes actually stored.

The negative control is the part I would want a reader to copy. After fixing it to `total + sizeBytes > max` inside the transaction, reverting just that comparison fails **exactly two** tests — "an upload that starts under the ceiling cannot finish over it" and "a rejected insert writes no row" — while the other three stay green. That specificity is the evidence the test discriminates this defect rather than a vague family of neighbours. A test that goes red when you break anything is nearly worthless as a diagnostic.

## 3. The ledger's identity key

The third axis is the subtlest and, in my experience, the most likely to survive review. Usage is accounted against a *mutable name* — a path, slug, URI, filename — while permissions and identity are keyed against a *stable internal id*. Rename the object and the ledger resets: a fresh allowance, plus old bytes stranded under the old name, invisible to listing, deletion, and totals while still consuming disk.

The principle underneath is old and well grounded. POSIX separates name from identity: `unlink(2)` specifies that a file persists while any process holds it open even after its last name is gone, so lifetime is governed by link and descriptor counts rather than by the name. `rename(2)` is atomic only within one filesystem and fails with `EXDEV` across mount points, because it merely rebinds a name to an existing inode. And `quotacheck(8)` exists precisely because quota ledgers drift from reality: it "builds a table of current disk usage, and compares this table against that recorded in the disk quota file," fixing inconsistencies. Ledger-versus-ground-truth divergence is old enough to have a dedicated repair tool.

Content-addressed storage is the structural escape. IPFS derives identity from bytes — "any difference in the content will produce a different CID" — and deliberately pushes mutable naming into a separate layer (IPNS) because CIDs cannot express it. Git keys objects by content hash and blobs do not store filenames at all; a rename is a new tree entry pointing at the same blob, so the object store has no orphaned-name problem.

Object storage shows the failure in first-party documentation. S3 has no in-place rename for standard buckets — AWS instructs you to "rename objects by copying them and deleting the original ones." The load-bearing detail is what happens in a *versioned* bucket: the delete step writes a delete marker and "all versions remain in the bucket," so the old key's bytes persist as noncurrent versions until explicitly purged. That is a documented case of rename leaving orphaned bytes under the dead name. A true atomic rename arrived only in June 2025, and only for S3 Express One Zone directory buckets.

Real bugs of exactly this shape:

- **GitLab container registry #60789** — renaming a project updates the path in the database while the registry backend still holds blobs under the old path, so garbage collection fails with "unknown repository" ([issue](https://gitlab.com/gitlab-org/gitlab-foss/-/issues/60789)).
- **ownCloud #13391** — renaming a 48.7 GB folder left the bytes on disk but "all database entries are gone"; the folder became invisible to non-admin users, and recovery needed an admin rescan to rebuild the tracking rows ([issue](https://github.com/owncloud/core/issues/13391)).
- **ownCloud #14298** — quota reported 4.3 GB used against ~17 GB on disk, traced to storage-identifier drift leaving stale `filecache` rows tied to a deprecated key ([issue](https://github.com/owncloud/core/issues/14298)).
- **Nextcloud** ships a standing `occ` command to list "objects in the object store that have no matching entry in the file cache database" — first-party tooling implies the class is common enough to need a permanent broom.

The general answer, everywhere it has been solved, is reconciliation on a grace window rather than a promise of perfection: an S3 lifecycle rule aborts incomplete multipart uploads and clears their stranded parts; `git gc` prunes unreachable objects after a default window of "2 weeks ago," overridable via `gc.pruneExpire`; Postgres `VACUUM` sweeps dead tuples that hold space until reclaimed.

**Case study.** The share grant followed the page's stable `page_id`, so a link survived a rename. Attachment rows, byte totals, and on-disk directories were keyed by the page's *current URI*. So a rename reset the ceiling, stranded the old bytes, and let subsequent share writes continue against a brand-new ledger.

Two things about this are worth passing on. First, the fix is a sentence, not a technique: *one identity for the page, used by the grant, the listing, the quota, and the files.* Second — and this is the part I got wrong — my initial write-up implied an unauthenticated link holder could trigger the reset. A reviewer corrected it: only an authenticated owner can rename. The accurate mechanism is owner-triggered ledger reset and file orphaning, after which share writes continue under the new ledger. The severity was unchanged; the actor attribution was simply wrong. **Getting the severity right and getting the actor right are separate obligations**, and a vulnerability narrative that inflates the actor is still a defective narrative even when the fix is identical.

## 4. Migrating a re-keyed ledger

Re-keying a ledger implies a migration, and a migration over an empty table proves almost nothing.

In the case study the live table had **zero rows** and the attachments directory was empty across 93 pages. Shipping the migration therefore demonstrated only that it does not crash on emptiness; every property that mattered was unverified. The remedy was to seed the pre-migration world — a uri-keyed table, directories named by URI, and one orphan row whose page no longer existed — and then assert re-keying, directory carry-over with files still readable, orphan rows dropped *and counted in the log*, legacy table cleanup, and idempotent re-initialisation.

Two details generalise. **Assert log visibility on the actual output.** "Visible instead of silent" is a claim about what gets emitted, so the test intercepts stderr and parses the emitted record, rather than asserting that a code path was reached. **Run your negative controls instead of predicting them.** I had written in the test header that deleting the re-keying insert would fail four assertions including file placement. Run, it failed three, and the file-placement test stayed green — because the directory-move loop reads the legacy join rather than the new rows, so metadata accounting and byte accounting fail *independently* of file movement. That is a structural fact about the migration I would not have learned from a passing suite, and it came from being wrong in writing and checking.

## 5. When the write loses the race: legibility

Suppose you have done everything above correctly. The check is atomic, so under contention somebody must lose. What does the loser get told?

This turns out to be the least settled area in the whole topic, and the disagreement is between authorities, not between good and bad engineers.

On the durable side, RFC 9110 defines 413 in terms of request *size* rather than account quota, though it is widely reused for the latter. RFC 4918 defines 507 Insufficient Storage — and MDN frames 507 as "considered temporary," explicitly contrasting it with 413. Neither code says anything about whether the condition is the caller's to fix. Production APIs then go their own ways:

| API | Quota exceeded | Transient contention | How a client tells them apart |
|---|---|---|---|
| Google Drive | 403 `storageQuotaExceeded` — "occurs when the user reaches their storage limit" | 429 / 403 `userRateLimitExceeded` — "Use exponential backoff to retry the request" | Same status; only the JSON `reason` distinguishes |
| Dropbox | `WriteError` body with an `insufficient_space` reason | — | Body error tag (a typed union in the SDKs) |
| Box | 403, body `storage_limit_exceeded` | — | Body code |
| GitHub | 403 or 429 interchangeably | same | `Retry-After` and `x-ratelimit-*` headers |
| Stripe | — | 429 for both real rate limiting and `lock_timeout` serialization | Body `type`/`code`; SDKs auto-retry only the latter |
| AWS API Gateway | 429 for plan quota (durable until reset) | 429 for short-term throttle | Message text only |

Notably, **no reviewed production API uses 507 for per-account quota**; it appears reserved for genuine server-disk-full conditions.

The one real consensus is a design instruction rather than a code assignment: automated clients should key retry logic off explicit machine-readable fields — `Retry-After`, a body `reason`/`type`/`code`, rate-limit headers — and **not off the bare status code**, because multiple first-party APIs demonstrably reuse one code for both durable and transient conditions. Google's AIP-194, its guidance on automatic retries, makes the underlying point sharply: `RESOURCE_EXHAUSTED` "may be a signal that quota is exhausted. Retries therefore may not be expected to work for several hours; meanwhile the retries may have billing implications. If `RESOURCE_EXHAUSTED` is used for other reasons than quota and the expected time for the resource to become available is much shorter, it may be retryable." The same code, two opposite client behaviours, disambiguated only in the payload. Azure's Throttling pattern draws the cleanest available line: 429 when "the caller exceeds a configured request rate over a defined window," 503 when "the service can't handle the request right now" — and in either case, "include a `Retry-After` HTTP header so that the client can pick a retry strategy."

**Case study, and the asymmetry.** Here the atomic path produced a database-level contention error that carried no HTTP status, so the handler's `err.statusCode || 500` fallback turned it into a generic 500 with the body replaced by "Internal Server Error." The practical consequences:

- A quota rejection (409) delivered the real explanation to the user.
- A write collision (500) delivered nothing actionable — no hint that retrying would simply work.

The client, for its part, never retried automatically, never branched on status code, and did not read `Retry-After`; it wrote the error message into a status line for a human to read. Yet the *same route* already answered share writers with **429 plus `Retry-After`** for write rate limiting. A retryable-transient idiom existed in that very file and the contention path did not use it.

Then the measurement that reframed the whole thing. The two write paths fail with different error *classes*:

| Path | Caller | Error | Busy handler participates? |
|---|---|---|---|
| Deferred transaction: reads, then writes | Share link (rationed) | `SQLITE_BUSY_SNAPSHOT`, immediate | **No** |
| Autocommit single INSERT | Authenticated owner | `SQLITE_BUSY` after the full timeout | **Yes** — succeeds once the lock clears |

Measured: with a 150 ms timeout the autocommit path errored after 152 ms, and the identical insert succeeded as soon as the lock released; production `busy_timeout` reads back 5000.

SQLite's own documentation explains why. A deferred transaction that reads and later writes attempts a snapshot promotion, and `SQLITE_BUSY_SNAPSHOT` "occurs on WAL mode databases when a database connection tries to promote a read transaction into a write transaction but finds that another database connection has already written to the database and thus invalidated prior reads" ([result codes](https://www.sqlite.org/rescode.html)). Sleeping cannot help: the read transaction's snapshot is pinned for its duration, so the only remedy is rollback and a fresh `BEGIN` — which is why the busy handler, whose entire model is wait-and-retry, is the wrong instrument. A SQLite maintainer puts it directly: the connection *can* obtain the writer lock, but "it cannot write to the database because its transaction is open on an old snapshot" ([forum](https://sqlite.org/forum/info/8e7842120abccd1b92e905766ea654f6585c848ec572288abd01366d43ea45c7)). The standard mitigation is `BEGIN IMMEDIATE`, taking write intent up front.

So the failure reached **only unauthenticated share writers**. Owners were shielded by the busy handler, because their path never held a read snapshot to promote. Nobody designed that; it fell out of which code path happened to need a transaction. A concurrency detail had acquired an access-control shape, and it landed on precisely the population that could least interpret a 500.

Two caveats I want to keep honest. First, the deployment is a single fork-mode process with one module-global connection, so the service does not race itself; two CLIs open the same database file, making a second connection real, but **I did not verify** that either CLI commits a write inside the upload's read-write window — so the trigger chain is unconfirmed rather than demonstrated. Second, a documentation subtlety: `SQLITE_BUSY_SNAPSHOT` is an *extended* result code, and SQLite returns primary codes by default unless `sqlite3_extended_result_codes()` is enabled — which would normally mean an application sees only a plain `SQLITE_BUSY` and cannot distinguish stale-snapshot from ordinary contention. My measurement resolves that for this binding: better-sqlite3 surfaced `SQLITE_BUSY_SNAPSHOT` in `err.code` with no opt-in on my part, so it evidently enables extended codes itself. Worth checking on your own driver before relying on the distinction. (Our earlier [SQLite WAL research](/research/2026-02-20-sqlite-wal-mode-ai-agent-systems) had already flagged the non-retryability of this code five months ago — I rediscovered it by measurement, which is a reasonable argument for re-reading your own corpus before instrumenting.)

## 6. What a retry costs: idempotency

If you are going to tell a client to retry, you owe it an answer about duplicates.

This is well-solved territory. **Stripe** popularised the client-supplied `Idempotency-Key` header, cached at least 24 hours, where the same key with different body parameters is an error so accidental reuse surfaces loudly. **tus** makes the created upload's `Location` its identity, uses `HEAD` to report the current `Upload-Offset`, and returns 409 on a mismatched offset rather than silently accepting misaligned bytes. **S3 multipart** scopes each part to `(UploadId, PartNumber)` so re-uploading a part overwrites it, and the object does not exist until completion — though abandoned uploads never expire on their own, which is why the documented mitigation is an `AbortIncompleteMultipartUpload` lifecycle rule. **Content-hash dedup** (IPFS, Git) makes the question disappear by construction.

The gap case is formalised: RFC 9110 considers a method idempotent "if the intended effect on the server of multiple identical requests with that method is the same as the effect for a single such request," grants that property to "PUT, DELETE, and safe request methods," and pointedly excludes POST — so automatic retry safety is not extended to it. AWS EC2's `ClientToken` documents the consequence bluntly: "if the original request and the subsequent retries are successful, the operation is completed multiple times… you might create more resources than you intended." The IETF is standardising the pattern in [draft-ietf-httpapi-idempotency-key-header](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/07/), currently a draft at -07. A lighter-weight alternative is to make creation a `PUT` to a client-chosen id, turning it into an idempotent insert-if-absent.

**Case study.** Uploads carried no idempotency key — the attachment id was server-generated per request with no content-hash dedup — so a retry after a *successful* write would duplicate the object. On the contention path specifically that hazard was absent: the transaction rolled back and the handler's catch unlinked both the temporary and the final file, so zero partial state remained and retrying was both safe and the only way to complete. The general shape is worth naming: *the safety of a retry is a property of the specific failure, not of the endpoint.* A blanket "uploads are not idempotent, don't auto-retry" is too coarse to be useful, and a blanket "just retry" is wrong for the other paths.

## 7. Why unauthenticated writers change the calculus

All of the above is ordinary engineering when the writer has an account. Bearer-link writers remove the thing every mitigation implicitly assumes: an identity to attribute usage to, throttle, warn, or ban.

The W3C TAG's [Good Practices for Capability URLs](https://www.w3.org/2001/tag/doc/capability-urls) remains the authoritative treatment, and it already separates read from write — capability URLs "should be used within an appropriate HTTP verb to enable a relevant action. For example, an HTTP `GET` on a capability URL should not result in side effects such as the deletion of a resource" — while mandating revocation, expiry, rate-limiting of the capability namespace, and hardening against leakage via `Referer`, history, and email. OWASP's IDOR guidance insists access control cannot rest on unguessability and must cover "read, create, update, delete, export, and administrative actions." Schneier himself judged unguessable share URLs "a perfectly valid security measure, although unsettling to some"; it is the discussion on his post that names the structural weaknesses — no revocation, no expiry, leakage through ordinary browser plumbing.

The abuse record for anonymous write is not theoretical. **Firefox Send** was suspended and then killed in 2020 after Mozilla admitted the feature "started being abused to send malware and conduct spear-phishing attacks." **Anonfiles** shut down in 2023 with its operators citing "the extreme volumes of people abusing it." And storage exhaustion via unauthenticated upload has named CVEs: **CVE-2026-55450** in Langflow (CVSS 9.3) states "unauthenticated users can upload any amount of data to the server without any limitations"; **CVE-2026-25242** in Gogs warns that "Repeated uploads can exhaust disk space" and that a default install can be "abused as a public file host." The shape of the Gogs remedy is instructive — the advisory titles the flaw "Unauthenticated file upload" and resolves it with a patched release (0.14.0), a fix in the register of authentication rather than finer per-token ceilings.

AWS presigned URLs are the closest production analogue, and AWS is explicit that they "are public resources that do not authenticate users, and anyone in possession of a valid S3 presigned URL can access the associated resource." Its documented mitigations map onto what an agent-issued write link needs: tight expiry, because a still-valid URL "can be reused"; signature condition keys in bucket policy and network-path restriction; and integrity checking via a `Content-MD5` digest supplied with the upload. What is notable is what the reviewed guidance does not offer: a per-URL byte ceiling. **Capping how much a presigned writer can store is left to the application** — which is exactly the ceiling this piece is about.

Two honest gaps. No source found names "per-capability-link storage ceiling" as an established term of art; the nearest authoritative articulation is the W3C TAG's expiry and namespace rate-limiting advice. And while "denial of wallet" is a named, ATT&CK-mapped category, every concrete write-up describes the *egress* variant against already-stored objects — no source documents an upload-side billing incident with a byte or dollar figure. Applying the DoW frame to anonymous writes is a reasonable extrapolation from the egress literature plus the fixed-disk CVEs above, but it is an extrapolation, and should be labelled as one rather than cited.

## 8. Design guidance

Synthesising the prior art with the case study, for anyone letting an agent hand out write-capable links:

1. **Make the database the enforcement point.** A guarded single-statement write, a conditional expression, or a check inside the same transaction as the insert. If the check can be read in isolation from the write, it is advisory.
2. **Count what is arriving.** `current + incoming > max`, not `current >= max`. Then break it on purpose and confirm precisely which tests go red.
3. **Key the ledger to whatever identity your permissions use.** If a grant follows a stable id, the quota must too. Divergent keys mean a rename mints a fresh allowance and strands bytes.
4. **Assume the ledger will drift, and schedule reconciliation.** Every mature system has a broom: `quotacheck`, `git gc`, `VACUUM`, lifecycle rules, Nextcloud's orphan-listing command. Grace window plus sweep beats a promise of perfect bookkeeping.
5. **Separate "you are over the limit" from "you lost a race."** Different codes, and a machine-readable body field, because your automated caller cannot parse prose. Where a retryable idiom already exists in your codebase (`429` + `Retry-After`), reuse it rather than falling through to 500.
6. **Never let a contention failure fall through to a generic 500.** It is the one failure where retrying is both safe and sufficient, and a 500 is precisely the signal that discourages it.
7. **Give a write-capable link its own ceilings, expiry, and revocation**, on the token rather than the account — the token is the only principal you actually have.
8. **Test the migration against seeded data, not an empty table.** Zero rows in production makes a migration feel risk-free; it only makes it unmeasured.

The meta-lesson is about evidence rather than quotas. The reviewed module shipped with a full green suite, and the suite was honest — it verified the properties someone had thought to encode. Four independent defects lived in the space nobody had written a test for. What surfaced them was breaking each fix deliberately and checking that exactly the expected assertions failed, which twice contradicted what I had confidently written down. A green test proves the absence of one anticipated defect. Only a control that could have failed tells you the test measures anything at all.

## Sources

**TOCTOU and atomic enforcement**: [calcom/cal.diy #29605](https://github.com/calcom/cal.diy/issues/29605) · [Polar #12027](https://github.com/polarsource/polar/issues/12027) · [Kubernetes ResourceQuota admission design](https://github.com/kubernetes/design-proposals-archive/blob/main/resource-management/admission_control_resource_quota.md) · [DynamoDB atomic counters](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/example_dynamodb_Scenario_AtomicCounterOperations_section.html) · [PostgreSQL UPDATE](https://www.postgresql.org/docs/current/sql-update.html) · [Redis reservation pattern](https://redis.io/tutorials/inventory-reservation-in-real-time-with-redis/) · [Redis INCR](https://redis.io/docs/latest/commands/incr/) · [S3 conditional writes](https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-s3-functionality-conditional-writes)

**Overshoot and limit modes**: [ownCloud client #173](https://github.com/owncloud/client/issues/173) · [DroneDB Registry #191](https://github.com/DroneDB/Registry/pull/191) · [Project Quay quota management](https://docs.projectquay.io/manage_quay.html) · [Red Hat Quay quota management](https://docs.redhat.com/en/documentation/red_hat_quay/3.7/html/manage_red_hat_quay/red-hat-quay-quota-management-and-enforcement) · [IBM Storage Scale quotas](https://www.ibm.com/docs/en/storage-scale/5.2.2?topic=considerations-enabling-quotas) · [GitHub repository limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits)

**Identity keying and orphaned bytes**: [IPFS content addressing](https://docs.ipfs.tech/concepts/content-addressing/) · [Git internals](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects) · [S3 copy-object](https://docs.aws.amazon.com/AmazonS3/latest/userguide/copy-object.html) · [S3 delete markers](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManagingDelMarkers.html) · [S3 Express atomic rename](https://aws.amazon.com/about-aws/whats-new/2025/06/amazon-s3-express-one-zone-atomic-renaming-objects-api) · [unlink(2)](https://man7.org/linux/man-pages/man2/unlink.2.html) · [rename(2)](https://man7.org/linux/man-pages/man2/rename.2.html) · [quotacheck(8)](https://man7.org/linux/man-pages/man8/quotacheck.8.html) · [GitLab #60789](https://gitlab.com/gitlab-org/gitlab-foss/-/issues/60789) · [ownCloud #13391](https://github.com/owncloud/core/issues/13391) · [ownCloud #14298](https://github.com/owncloud/core/issues/14298) · [Nextcloud occ files](https://docs.nextcloud.com/server/stable/admin_manual/occ_files.html) · [S3 incomplete-multipart lifecycle](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpu-abort-incomplete-mpu-lifecycle-config.html) · [git-gc](https://web.mit.edu/git/git-doc/git-gc.html)

**Status semantics**: [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html) · [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585.html) · [MDN 507](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/507) · [Google AIP-193](https://google.aip.dev/193) · [AIP-194](https://google.aip.dev/194) · [Azure Throttling pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/throttling) · [Microsoft Graph throttling](https://learn.microsoft.com/en-us/graph/throttling) · [Google Drive error handling](https://developers.google.com/workspace/drive/api/guides/handle-errors) · [Dropbox WriteError](https://dropbox.github.io/dropbox-sdk-java/api-docs/v2.1.x/com/dropbox/core/v2/files/WriteError.html) · [Box storage limits](https://support.box.com/hc/en-us/articles/360044193293-API-Uploads-Account-Storage-Limit-Reached) · [GitHub rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) · [Stripe rate limits](https://docs.stripe.com/rate-limits)

**Idempotency**: [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests) · [tus resumable upload](https://tus.io/protocols/resumable-upload) · [S3 multipart overview](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html) · [EC2 API idempotency](https://docs.aws.amazon.com/ec2/latest/devguide/ec2-api-idempotency.html) · [IETF Idempotency-Key draft-07](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/07/)

**Capability-URL write abuse**: [W3C TAG capability URLs](https://www.w3.org/2001/tag/doc/capability-urls) · [OWASP IDOR cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/Insecure_Direct_Object_Reference_Prevention_Cheat_Sheet.html) · [Schneier on unguessable URLs](https://www.schneier.com/blog/archives/2015/07/googles_unguess.html) · [Firefox Send discontinued](https://www.securityweek.com/mozilla-discontinues-firefox-feature-abused-malware-phishing-attacks/) · [Anonfiles shutdown](https://www.bleepingcomputer.com/news/security/file-sharing-site-anonfiles-shuts-down-due-to-overwhelming-abuse/) · [CVE-2026-55450 Langflow](https://advisories.gitlab.com/pypi/langflow/CVE-2026-55450/) · [CVE-2026-25242 Gogs](https://github.com/gogs/gogs/security/advisories/GHSA-fc3h-92p8-h36f) · [S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html) · [Securing presigned URLs](https://aws.amazon.com/blogs/compute/securing-amazon-s3-presigned-urls-for-serverless-applications) · [Storage denial-of-wallet](https://threats.wiz.io/all-techniques/storage-denial-of-wallet-amplification-attack)

**SQLite**: [Result codes](https://www.sqlite.org/rescode.html) · [BEGIN/transaction semantics](https://www.sqlite.org/lang_transaction.html) · [busy_handler](https://www.sqlite.org/c3ref/busy_handler.html) · [WAL mode](https://www.sqlite.org/wal.html) · [Forum: snapshot promotion](https://sqlite.org/forum/info/8e7842120abccd1b92e905766ea654f6585c848ec572288abd01366d43ea45c7) · [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
