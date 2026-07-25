---
date: "2026-07-25"
title: "Revocation Semantics for Bearer Credentials: Hard Delete, Tombstones, and Hash-at-Rest"
description: "What it actually means to revoke a capability URL — why deleting the row destroys your audit trail, why keeping it leaves a resurrectable credential, and why NIST says a fast unsalted hash is the correct answer for high-entropy tokens."
tags: ["security", "credential-management", "capability-urls", "audit-trails", "sqlite", "nist-800-63b", "ai-agents", "schema-design"]
---

## Executive Summary

"Revoke" sounds like one operation. In a database it is at least three, and most implementations pick one without noticing the other two exist.

The concrete case that motivated this piece: a small self-hosted document-sharing component issues passwordless share links — capability URLs of the form `/s/<token>`, where the token is a 16-byte random hex string. That token is stored verbatim as the primary key of a `shares` table. Revocation sets a `revoked` flag and keeps the row forever. Expiry does the opposite: an hourly job hard-deletes expired rows. So the same table is a complete ledger for revocations and amnesiac about expirations, and neither behavior was chosen deliberately — they accreted.

Both halves turned out to be wrong, in opposite directions, and the incident that exposed it was a recovery, not a breach: two permanent share links were revoked by accident and were brought back by flipping the flag to zero. The recovery worked because the plaintext credential was still sitting in the row. Which is another way of saying: revocation had never destroyed anything. It had posted a note asking the server not to honor a key that was still on the table.

This piece works through the three-way choice — hard delete, tombstone-with-plaintext, tombstone-with-hash — and lands on a result that is better sourced than I expected. The headline findings:

1. **The industry split is not about security posture, it's about one UX question**: can a user re-read the secret later? Every system that says yes stores plaintext or reversible ciphertext. Every system that says "shown once" hashes. GitHub, Stripe, Sentry, and Laravel Sanctum are on one side; Kubernetes' legacy ServiceAccount tokens and (historically) Django REST Framework and GitLab are on the other, and both of the latter treated it as a defect to fix.
2. **A fast, unsalted SHA-256 is the *correct* choice for a 128-bit random token** — not a compromise. NIST SP 800-63B draws an explicit line at 112 bits of entropy, and above it prescribes a plain approved one-way function rather than a salted KDF. Applying bcrypt to a random token is a category error that costs ~10,000× in lookup latency for no threat-model gain — GitLab is currently unwinding exactly that mistake in production.
3. **Keeping the row and destroying the secret is the standard reconciliation** of two pressures that look contradictory: SOC 2 auditors want durable evidence that revocation happened, and data-minimization wants the sensitive payload gone. Tombstone-plus-hash satisfies both. Hard delete satisfies neither.
4. **The migration is more dangerous than the design.** Rewriting a value that is a primary key referenced by another table is a landmine in SQLite specifically, because `PRAGMA foreign_keys` is off by default and scoped per connection — the orphaning happens silently, with no error.
5. **The better answer is to stop using the secret as the primary key at all.** Once the token lives in its own column behind a surrogate key, revocation never touches anything other tables point at, and the whole hazard class disappears.

## 1. Three operations wearing one name

Pull apart what "revoke this link" is being asked to do:

- **Stop honoring it.** A predicate at the auth check. This is the only part most implementations do.
- **Record that it happened.** A durable, queryable fact: this credential existed, pointed here, was revoked at this time. This is what auditors ask for and what a hard delete destroys.
- **Make it unusable even to someone holding the database.** Destroy the reusable secret, not just the permission.

These are independent. You can do the first without the second (hard delete: it stops working, and no trace remains). You can do the first two without the third (flag flip: it stops working, the record is durable, and the key is still in the drawer). Only the third requires touching the stored value.

The failure mode in the motivating case is worth stating precisely, because it is easy to wave away as theoretical. A revoked share link is not a deactivated account. It is a bearer credential whose entire content is a URL — one that, per the W3C TAG's own threat model, has probably already leaked into places nobody controls (more on this in §7). "Revoked but one UPDATE away from working again" means the blast radius of a single mistaken or malicious flag flip is every link ever issued, including ones whose URLs are sitting in a third party's log retention.

## 2. The industry split is a UX fork, not a security posture

Surveying how real systems store bearer credentials at rest, the pattern is sharper than "mature systems hash":

**Hash at rest:**

- **GitHub.** The newer token formats (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`) are hashed, and the audit log is searchable by SHA-256 of the token via a `hashed_token:` qualifier rather than by the plaintext. The 2021 format redesign also added type prefixes and a Base62 checksum, which GitHub says "virtually eliminates false positives" for offline secret scanning, and raised entropy to 178 bits in the same change.
- **Stripe.** Secret keys are shown once — "you can only reveal a secret key once" — with rotation offering a grace window where old and new both work for up to seven days.
- **Sentry.** Explicit in the docs: the token value is shown once, copy it now.
- **Laravel Sanctum.** "API tokens are hashed using SHA-256 hashing before being stored in your database"; the plaintext is handed back exactly once at creation.
- **Django REST Knox.** Hashes with SHA-512 by default. Notably, this package exists *because* DRF's built-in `TokenAuthentication` stores tokens in clear text — an acknowledged gap tracked upstream for years.
- **GitLab.** Historically stored personal access tokens in plaintext, flagged as a security issue and since fixed.

**Plaintext at rest:**

- **Kubernetes legacy ServiceAccount tokens.** Ordinary `Secret` objects in etcd, which is not encrypted by default. What makes this instructive is the fix: Kubernetes did not add hashing. It moved to short-lived, audience-bound projected tokens that aren't persisted at all. When you can shorten the credential's life instead of protecting its storage, that dominates — no storage question to answer.

The dividing line is not how seriously each vendor takes security. It is whether the product promises you can see the secret again. Stripe, GitHub, and Sentry all decided "shown once" was an acceptable cost and got hashing for free. Systems that kept the re-read affordance kept plaintext, because you cannot have both.

That framing matters for the decision at hand, because it converts a security debate into a product question: **is re-reading an existing share link a feature we are keeping?** If yes, hash-from-creation is off the table, and the argument is over. If no, hash-from-creation is strictly better than anything else discussed here.

## 3. Hashing at rest turns inventory into fingerprints

Every system that hashes has the same downstream problem — the list view can no longer show the credential — and they all solve it the same way: display a **non-secret identifier** derived from or attached to the secret.

- GitHub's `ghp_`-style prefixes plus a public checksum suffix are designed to be safely visible and machine-recognizable.
- Stripe's prefixes (`pk_live_`, `sk_test_`, …) encode credential type *and* environment, and appear in dashboard listings while the secret does not.
- AWS goes furthest: the Access Key ID (`AKIA…`, `ASIA…`) is explicitly the public half of the pair — "a public identifier, like a username" — while the secret access key is retrievable only at creation.

Practitioner writing generalizes this into a rule of thumb: keys should carry a prefix so you can identify them and a checksum so a truncated copy-paste is detectable; store `prefix + hash`, return the full secret once.

This is a genuinely good pattern and it does **not** rescue the case in question. A prefix or last-4 lets you *identify* a credential in a list. It cannot *reconstruct* a working capability URL. If the requirement is "the inventory command must print links that people can click," fingerprints don't satisfy it — that requirement is only compatible with plaintext at rest, or with the hybrid discussed next.

## 4. Tombstone vs. hard delete: audit completeness against data minimization

Two forces pull in opposite directions here, and the resolution is more settled than the debate suggests.

**Pulling toward retention.** SOC 2 logical-access testing works by sampling: an auditor picks terminated users or revoked grants and asks for evidence that access was actually removed, and that the removal was recorded. That is a query against live data, not a log line that scrolled past. A table subjected to periodic hard deletion is structurally unable to answer it for the deleted population — which is exactly the state the hourly expiry job creates. SOC 2 sets no fixed retention number, but the observation window (typically twelve months) plus buffer needs to be retrievable.

**Pulling toward deletion.** Data minimization, and specifically GDPR's right to erasure. Here the relevant detail is Article 17(3): erasure is not absolute, and retention for legal claims or compliance obligations is exempt. Guidance consistently converges on *restricting processing* — archive it, stop using it — rather than physically destroying rows when audit obligations conflict.

The reconciliation practitioners land on, across CDC/streaming (Kafka tombstones), directory systems, and audit-trail design, is a single sentence: **retain the record of the event, destroy the reusable secret.**

That is precisely what hashing the token in place does, and precisely what neither alternative does. Hard delete destroys the record along with the secret. Flag-flip retains both. The tombstone-with-hash is the only one of the three that separates the two things that were never the same thing.

## 5. Why an unsalted fast hash is right here — and wrong for passwords

This is the question where I expected to find hand-waving and instead found a bright line drawn by a primary source.

**NIST SP 800-63B** defines a category called **look-up secrets**: high-entropy, randomly generated bearer secrets. A share token is structurally identical. The rule is entropy-gated:

> "Look-up secrets having at least 112 bits of entropy SHALL be hashed with an approved one-way function." Secrets with fewer than 112 bits "SHALL be salted and hashed using a suitable one-way key derivation function."

A 16-byte token is 128 bits, above the threshold. Under NIST's own framework it falls on the *plain approved hash* side — no KDF, no mandatory salt. The 112-bit threshold persists into Revision 4, finalized 31 July 2025, which superseded Rev. 3 on 1 August 2025.

The reasoning behind the line is worth internalizing, because it is the part people get backwards. Slow KDFs and per-secret salts exist to defeat *guessing*. They multiply the attacker's cost per attempt, which only pays off when the number of attempts needed is small enough to be walked — i.e. when the secret is low-entropy, like a human-chosen password. Salt defeats precomputation across a shared dictionary. Neither threat exists for a uniformly random 128-bit value: there is no dictionary to precompute, and the search space is 2^128 whether you attack the hash or the token itself. Applying bcrypt here does not make the token harder to guess. It makes every legitimate lookup slower.

This isn't theory. GitLab has an open issue proposing to move OAuth token hashing *from* PBKDF2 *to* SHA-512, on exactly this reasoning: the tokens are generated by `SecureRandom.urlsafe_base64(32)` (256 bits of entropy), "PBKDF2 is unnecessary for application-generated cryptographically random tokens" — a position they note was confirmed with their FedRAMP and Data Security teams — and dropping the KDF is worth roughly a 10,000× speedup on lookup. That is an organization discovering it had over-applied password-grade hashing to a token and correcting it once someone redid the entropy math.

There is a dissenting practitioner position — one widely-read blog recommends salt plus bcrypt/Argon2 for API keys regardless of entropy, and estimates SHA-256 tokens as crackable "within a month" on a large GPU cluster. That figure doesn't reconcile against the keyspace: 2^128 is not reachable by any cluster at any budget, so the estimate appears to assume a much smaller token. Treat it as an outlier, contradicted by both NIST and GitLab's engineering rationale — but treat it as a real signal about how easily this distinction gets lost, since the intuition "always salt, always use a slow hash" is otherwise good advice that most engineers have correctly internalized for passwords.

One caveat on sourcing: OWASP's Password Storage and Cryptographic Storage cheat sheets gesture at the reversible-encryption-vs-hashing question but do not explicitly draw the token/password distinction. NIST's look-up-secret category is the precise and authoritative source for this specific claim, and it is the one to cite.

## 6. Forensic reconciliation: why a *deterministic* hash

A random replacement value would also destroy the plaintext and also preserve the row. The reason to prefer a hash is the third property: given a token observed somewhere in the world — in a support ticket, a screenshot, an access log, a browser history export — you can hash it and find the row. Random values sever that link permanently; you would be holding a link you cannot identify.

This is a shipping pattern, not an invention. GitHub's audit log supports searching by `hashed_token:"<sha256>"` precisely so that an admin who learns a token was compromised can "understand the actions taken by the compromised token" by pulling every event associated with it.

Two honest qualifications:

- I could not confirm whether GitHub's hashed-token search still works *after* the underlying token is revoked or deleted on their side; the documentation describes the mechanism but is silent on post-revocation behavior. So the pattern of hash-keyed audit lookup is confirmed; the exact analogue to "the row outlives revocation forever" is not.
- The obvious counterargument is that **tokens should never be in logs in the first place**. OWASP's Secrets Management guidance is unambiguous that secrets must not be logged and must be masked if they transit logging paths. That's correct, and it means hash-keyed reconciliation should be understood as a backstop for when logging discipline has already failed — a screenshot in a chat, a URL in someone's browser sync — not as a reason to relax it.

## 7. The migration hazard is worse than the design question

Everything above is about which end state to want. The most concrete risk lives in getting there.

The proposal rewrites a value that is the table's **primary key**. If any other table has a foreign key referencing it, SQLite has a specific and well-documented trap: **`PRAGMA foreign_keys` is off by default, and it is scoped per connection, not per database.** Constraints declared in the schema are silently ignored on any connection that doesn't enable it. So an `UPDATE` that rewrites the PK — from the application, from a migration script, or from an ad-hoc `sqlite3` session someone opens to fix something — orphans the child rows with no error and no warning. The schema *says* the constraint exists. Nothing enforces it.

This is not exotic. It shows up repeatedly in tool bug trackers where a library assumed the pragma was on. And it is a nastier failure than a crash, because the corruption is invisible until something later depends on the join.

Even with the pragma enabled and `ON UPDATE CASCADE` declared, rewriting a primary key on every revocation is an unusual write pattern. Primary keys are conventionally immutable — general relational-design advice has argued for decades that natural keys are a mistake precisely because business values change and PKs shouldn't. A secret token is the most extreme case of a mutable natural key imaginable: it is a value whose entire lifecycle ends in deliberate destruction.

Which points at the better answer.

**Recommended shape:** a surrogate primary key (integer or UUID); a separate `token_hash` column with a unique index; optionally a non-secret `token_prefix` for listings, per §3. Foreign keys reference the surrogate key, never the secret. Revocation then touches only the `token_hash` column, which nothing points at, and the entire SQLite hazard class evaporates. This is more work than the one-line `UPDATE`, and it is the change that makes the one-line `UPDATE` safe to keep doing forever.

## 8. Capability URLs leak by design, which is the actual argument against reversible revocation

The W3C TAG's *Good Practices for Capability URLs* is the standard reference here. It is dated 2014 — old enough to flag, though no clear successor exists — and its leakage inventory is the part that matters:

- **Referer leakage.** Following a link to another site from a page reached via a capability URL can disclose that URL in the `Referer` header. Mitigations: `rel="noreferrer"`, `Referrer-Policy`, or moving the secret into the URL fragment.
- **Logs and history.** URLs "appear in plain text within application logs, such as within web servers and in browser history," and "hosted services that synchronise browser histories and browser plugin toolbars can easily get hold of URLs."
- **Revocation granularity.** The TAG recommends minting multiple capability URLs per resource so one can be revoked without affecting the others — a scoping recommendation, not a storage one.

The document says nothing about whether reversible revocation is acceptable; that is genuinely unaddressed in the literature I could find, and I'd rather name the gap than dress up an inference as a citation. But its own threat model supplies the argument. If a capability URL has plausibly already reached third-party log retention, browser-sync services, and chat-preview caches — all beyond your reach to purge — then "un-revoking" it doesn't restore a private link. It re-arms a credential that may already be sitting somewhere an attacker can reach later. Revocation being one `UPDATE` away from reversal is a property you would have to argue *for*, and nobody has.

## 9. The decision, laid out

| | Stop honoring | Durable record | Secret destroyed | Can re-print link | Can match a found token |
|---|---|---|---|---|---|
| **Hard delete** | ✅ | ❌ | ✅ | ❌ | ❌ |
| **Flag flip, keep plaintext** | ✅ | ✅ | ❌ | ✅ | ✅ |
| **Tombstone + hash on revoke** | ✅ | ✅ | ✅ | until revoked | ✅ |
| **Hash from creation** | ✅ | ✅ | ✅ (always) | ❌ | ✅ |

The last two rows are the real choice, and the deciding question is the product one from §2: does an inventory command need to print working links for *active* shares?

If yes — and for a share-management CLI whose whole purpose is answering "what passwordless links exist on this machine right now," it plausibly does — then hash-on-revoke is the ceiling. Active tokens stay readable; revoked and expired ones become fingerprints. The exposure that remains is honest and worth stating out loud: anyone with database read access can still reconstruct every *live* link. Hash-on-revoke closes the resurrection backdoor and the indefinite-accumulation problem. It does not make the database safe to hand out.

If no, hash-from-creation is cleaner, and the inventory degrades to counts, targets, and expiry dates — which, notably, is all you need to answer the question that motivated building the inventory in the first place ("what's exposed?"), just not the one you'd want later ("send me that link again").

## 10. What the evidence does not settle

Being explicit about the boundary, since half the value of a brief like this is knowing where it stops:

- **Whether reversible revocation is acceptable in general for capability URLs.** No source rules on it. The leakage literature argues against it in spirit; that's an inference, not a citation.
- **Whether rewriting a referenced primary key is worth the SQLite risk versus migrating to a surrogate key first.** This is an engineering trade-off about blast radius and effort. The literature converges on "don't use natural keys" from an orthogonal direction, but it isn't adjudicating your migration.
- **Retention duration for tombstoned rows.** SOC 2 implies "observation window plus buffer," roughly twelve months and change. There is no principled number for a self-hosted side project, and pretending otherwise would be false precision.
- **Unverified specifics**, flagged rather than smoothed over: whether GitHub's `hashed_token:` search survives token deletion; whether Slack hashes tokens at rest (only general encryption-at-rest guidance was found); and the exact wording of the look-up-secret clause in the finalized SP 800-63B-4 PDF, which was confirmed via secondary summary rather than quoted from the primary document.

The one thing I'd carry out of this beyond the specific decision: **"revoke" is not a verb the database understands.** It compiles down to some combination of a predicate, a record, and a destruction — and if you haven't decided all three explicitly, you have decided them accidentally. The share table described at the top had picked "predicate + record, no destruction" for revocation and "predicate + destruction, no record" for expiry, in the same table, without anyone choosing either.
