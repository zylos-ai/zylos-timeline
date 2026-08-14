---
date: "2026-07-25"
title: "Revocation Semantics for Bearer Credentials: Hard Delete, Tombstones, and Hash-at-Rest"
description: "What it actually means to revoke a capability URL — why deleting the row destroys your audit trail, why keeping it leaves a resurrectable credential, and why the entropy math (anchored by NIST's storage rule for high-entropy look-up secrets) points to a fast unsalted hash."
tags: ["security", "credential-management", "capability-urls", "audit-trails", "sqlite", "nist-800-63b", "ai-agents", "schema-design"]
---

## Executive Summary

"Revoke" sounds like one operation. In a database it is at least three, and most implementations pick one without noticing the other two exist.

The concrete case that motivated this piece: a small self-hosted document-sharing component issues passwordless share links — capability URLs of the form `/s/<token>`, where the token is a 16-byte random hex string. That token is stored verbatim as the primary key of a `shares` table. Revocation sets a `revoked` flag and keeps the row forever. Expiry does the opposite: an hourly job hard-deletes expired rows. So the same table is a complete ledger for revocations and amnesiac about expirations, and neither behavior was chosen deliberately — they accreted.

Both halves turned out to be wrong, in opposite directions, and the incident that exposed it was a recovery, not a breach: two permanent share links were revoked by accident and were brought back by flipping the flag to zero. The recovery worked because the plaintext credential was still sitting in the row. Which is another way of saying: revocation had never destroyed anything. It had posted a note asking the server not to honor a key that was still on the table.

This piece works through the three-way choice — hard delete, tombstone-with-plaintext, tombstone-with-hash — and lands on a result that is better sourced than I expected. The headline findings:

1. **The split among the systems surveyed here is not about security posture, it's about one UX question**: can a user re-read the secret later? A system that promises re-reading must keep plaintext or reversible ciphertext; hashing at rest is only available once that promise is given up. Among the issuers surveyed, GitHub and Laravel Sanctum are shown-once with a hash at rest. Stripe and Sentry are instructively mixed: each makes some key types shown-once and keeps others revealable, and the split runs along exactly this line, key type by key type. Kubernetes' legacy ServiceAccount tokens and Django REST Framework's built-in `TokenAuthentication` sit on the plaintext side — the former deprecated outright in favor of short-lived tokens, the latter a long-standing gap that Knox exists to route around.
2. **A fast, unsalted SHA-256 is a defensible choice for a 128-bit random token** — not a compromise. NIST SP 800-63B draws an explicit line at 112 bits of entropy for its *look-up secrets* — verifier-issued, single-use secrets such as recovery codes — and above that line prescribes a plain approved one-way function rather than a salted KDF. A reusable share token is not a look-up secret, and no source reviewed here prescribes storage for reusable bearer tokens directly; extending the entropy logic to them is our extrapolation, argued in §5. It is, however, the same reasoning GitLab applied in production: slow password-grade KDFs buy nothing against a high-entropy random token, and GitLab's own measurement puts plain SHA-512 at ~10,000× faster than the PBKDF2-SHA512 it is unwinding.
3. **Keeping the row and destroying the secret reconciles** two pressures that look contradictory: auditors want durable evidence that revocation happened, and data-minimization wants the sensitive payload gone. Hard delete destroys the secret but takes the audit record with it; flag-flip keeps the record but leaves the secret live. Neither can satisfy both at once. Tombstone-plus-hash does.
4. **The migration is more dangerous than the design.** Rewriting a value that is a primary key referenced by another table is a landmine in SQLite specifically, because `PRAGMA foreign_keys` is off by default and scoped per connection — the orphaning happens silently, with no error.
5. **The better answer is to stop using the secret as the primary key at all.** Once the token lives in its own column behind a surrogate key, revocation never touches anything other tables point at, and the whole hazard class disappears.

## 1. Three operations wearing one name

Pull apart what "revoke this link" is being asked to do:

- **Stop honoring it.** A predicate at the auth check. This is the only part most implementations do.
- **Record that it happened.** A durable, queryable fact: this credential existed, pointed here, was revoked at this time. This is what auditors ask for and what a hard delete destroys.
- **Make it unusable even to someone holding the database.** Destroy the reusable secret, not just the permission.

These are independent. You can do the first without the second (hard delete: it stops working, and no trace remains). You can do the first two without the third (flag flip: it stops working, the record is durable, and the key is still in the drawer). Only the third requires touching the stored value.

The failure mode in the motivating case is worth stating precisely, because it is easy to wave away as theoretical. A revoked share link is not a deactivated account. It is a bearer credential whose entire content is a URL — one that, per the W3C TAG's own threat model, has probably already leaked into places nobody controls (more on this in §8). "Revoked but one UPDATE away from working again" means the blast radius of a single mistaken or malicious flag flip is every link ever issued, including ones whose URLs are sitting in a third party's log retention.

## 2. The industry split is a UX fork, not a security posture

Surveying how real systems store bearer credentials at rest, the pattern is sharper than "mature systems hash":

**Hash at rest:**

- **GitHub.** The newer token formats (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`) are hashed, and the audit log is searchable by SHA-256 of the token via a `hashed_token:` qualifier rather than by the plaintext. The [2021 format redesign](https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/) also added type prefixes and a Base62-encoded checksum, which GitHub says "virtually eliminates false positives" for offline secret scanning, and raised entropy to 178 bits in the same change.
- **Laravel Sanctum.** Per [the docs](https://laravel.com/docs/11.x/sanctum): "API tokens are hashed using SHA-256 hashing before being stored in your database"; the plaintext is handed back exactly once at creation.
- **Django REST Knox.** Stores tokens only in non-recoverable form. Notably, this package exists *because* DRF's built-in `TokenAuthentication` stores tokens in clear text — [Knox's own docs](https://jazzband.github.io/django-rest-knox/) put the contrast bluntly: "DRF tokens are stored unencrypted in the database. This would allow an attacker unrestricted access to an account with a token if the database were compromised. Knox tokens are only stored in an encrypted form."
- **GitLab.** Hashes OAuth access tokens at rest — currently with PBKDF2-SHA512, a choice §5 returns to, because GitLab is in the middle of arguing itself down to plain SHA-512.

**Mixed — split by key type:**

- **Stripe.** Secret keys you create yourself are shown once — per [the API keys docs](https://docs.stripe.com/keys), "If you create a secret key yourself, you can't reveal it after you've seen it once" — and rotation offers a grace window where "both the old and new keys work for up to 7 days." But keys Stripe creates for you (the default secret key, or a key generated by a scheduled rotation) stay revealable in the live-mode dashboard afterward — and a key that can be revealed later cannot be sitting behind a one-way hash.
- **Sentry.** Splits the same way, by token type: [organization tokens](https://docs.sentry.io/account/auth-tokens/) "are only visible *once*, right after you create them," while "Currently, you can view personal tokens in the UI after creating them." Same product, both storage postures.

**Plaintext at rest:**

- **Kubernetes legacy ServiceAccount tokens.** Ordinary `Secret` objects in etcd — and Kubernetes' own docs note that ["By default, the API server stores plain-text representations of resources into etcd, with no at-rest encryption."](https://kubernetes.io/docs/tasks/administer-cluster/encrypt-data/) What makes this instructive is the fix: Kubernetes did not add hashing. It [deprecated the static tokens outright](https://kubernetes.io/docs/concepts/security/service-accounts/) — "This method is not recommended anymore, especially at scale, because of the risks associated with static, long-lived credentials" — in favor of short-lived, automatically rotating tokens requested via the TokenRequest API and mounted as projected volumes. When you can shorten the credential's life instead of protecting its storage, that dominates — no storage question to answer.
- **Django REST Framework's built-in `TokenAuthentication`.** Stores the token verbatim; see the Knox entry above. The fix never landed in core — it landed in a third-party package.

Among the vendors surveyed, the dividing line is not how seriously each takes security. It is whether the product promises you can see the secret again. (Eight systems is a sample, not the industry; the claim this survey supports is that the re-read promise predicts storage posture within it, not that no other explanation exists elsewhere.) GitHub and Sanctum decided shown-once was an acceptable cost and got hashing for free; Stripe and Sentry made the same decision for some key types and declined it for others, which is exactly why their storage posture is mixed. Any system that keeps the re-read affordance is keeping a recoverable secret, because you cannot have both.

That framing matters for the decision at hand, because it converts a security debate into a product question: **is re-reading an existing share link a feature we are keeping?** If yes, hash-from-creation is off the table, and the argument is over. If no, hash-from-creation is strictly better than anything else discussed here.

## 3. Hashing at rest turns inventory into fingerprints

Every system that hashes faces the same downstream problem — the list view can no longer show the credential — and the systems surveyed here all solve it the same way: display a **non-secret identifier** derived from or attached to the secret.

- GitHub's `ghp_`-style prefixes plus a public checksum suffix are designed to be safely visible and machine-recognizable.
- Stripe's prefixes (`pk_live_`, `sk_test_`, …) encode credential type *and* environment, and are safe to surface where the secret value is not.
- AWS goes furthest: the Access Key ID (`AKIAIOSFODNN7EXAMPLE` is [the documentation's own worked example](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html)) is the openly handled half of the pair, while for the other half, "The secret access key can be retrieved only at the time you create it."

These examples generalize into a rule of thumb — ours, extrapolating from the surveyed designs: keys should carry a prefix so you can identify them and a checksum so a truncated copy-paste is detectable; store `prefix + hash`, return the full secret once.

This is a genuinely good pattern and it does **not** rescue the case in question. A prefix or last-4 lets you *identify* a credential in a list. It cannot *reconstruct* a working capability URL. If the requirement is "the inventory command must print links that people can click," fingerprints don't satisfy it — that requirement is only compatible with plaintext at rest, or with the hybrid discussed next.

## 4. Tombstone vs. hard delete: audit completeness against data minimization

Two forces pull in opposite directions here, and they admit a reconciliation.

**Pulling toward retention.** SOC 2's logical-access criteria — the CC6 series of the [AICPA Trust Services Criteria](https://www.aicpa-cima.com/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022) — cover authorizing, modifying, and *removing* access, and a Type II report attests that those controls operated over a period. The TSC text does not prescribe testing mechanics; what follows is practitioner experience, not citation: auditors commonly test by sampling — pick terminated users or revoked grants, ask for evidence that access was actually removed and that the removal was recorded. That is a query against live data, not a log line that scrolled past. A table subjected to periodic hard deletion is structurally unable to answer it for the deleted population — which is exactly the state the hourly expiry job creates. Neither the TSC nor SOC 2 practice sets a fixed retention number, but evidence covering the report's observation window plus buffer needs to be retrievable.

**Pulling toward deletion.** Data minimization, and specifically GDPR's right to erasure. Here the relevant detail is [Article 17(3)](https://gdpr-info.eu/art-17-gdpr/): erasure is not absolute — paragraph 3 exempts processing necessary "for compliance with a legal obligation" (17(3)(b)) and "for the establishment, exercise or defence of legal claims" (17(3)(e)). Our inference from that structure, not a quoted rule: where an audit obligation genuinely requires the record, the resolution is to stop *using* the data rather than physically destroy it.

The reconciliation, in a single sentence: **retain the record of the event, destroy the reusable secret.**

That is precisely what hashing the token in place does, and precisely what neither alternative does. Hard delete destroys the record along with the secret. Flag-flip retains both. The tombstone-with-hash is the only one of the three that separates the two things that were never the same thing.

## 5. Why an unsalted fast hash is right here — and wrong for passwords

This is the question where I expected to find hand-waving and instead found a bright line drawn by a primary source — though the line is drawn for a neighboring category, so the transfer to reusable tokens has to be argued, not cited.

**[NIST SP 800-63B](https://pages.nist.gov/800-63-3/sp800-63b.html)** (§5.1.2) defines a category called **look-up secrets**: randomly generated secrets issued by a verifier, where "A given secret from an authenticator SHALL be used successfully only once" — the canonical example is a printed card or list of one-time recovery codes. A reusable share token is *not* one of these: it is presented repeatedly until expiry or revocation, and NIST defines no authenticator category that matches a long-lived reusable bearer token. What §5.1.2.2 does supply is an entropy-gated storage rule for the category it covers:

> "Look-up secrets having at least 112 bits of entropy SHALL be hashed with an approved one-way function." Secrets with fewer than 112 bits "SHALL be salted and hashed using a suitable one-way key derivation function."

A 16-byte token is 128 bits, above the threshold. Carrying that rule over to a reusable token is extrapolation, and it should be labeled as exactly that. Our reasoning for why the extrapolation holds: the gate discriminates on entropy alone, because entropy is what determines whether offline guessing against a stolen hash is feasible — and reusability changes how long a *leaked plaintext* token is dangerous, not how guessable its stored hash is. The threshold persists into [Revision 4](https://pages.nist.gov/800-63-4/sp800-63b.html), [finalized 31 July 2025](https://csrc.nist.gov/pubs/sp/800/63/b/4/final), which defines a look-up secret as "A secret issued by a verifier and used only once to prove possession of the secret" and requires that "All look-up secrets SHALL be stored in a hashed form using an approved hashing function," reserving the salted password-hashing-scheme treatment for "Look-up secrets that are shorter than the minimum security strength specified in the latest revision of [SP800-131A] (i.e., 112 bits as of the date of this publication)."

The reasoning behind the line is worth internalizing, because it is the part people get backwards. Slow KDFs and per-secret salts exist to defeat *guessing*. They multiply the attacker's cost per attempt, which only pays off when the number of attempts needed is small enough to be walked — i.e. when the secret is low-entropy, like a human-chosen password. Salt defeats precomputation across a shared dictionary. Neither threat exists for a uniformly random 128-bit value: there is no dictionary to precompute, and the search space is 2^128 whether you attack the hash or the token itself. Applying bcrypt here does not make the token harder to guess. It makes every legitimate lookup slower.

This isn't theory. GitLab has an [open issue](https://gitlab.com/gitlab-org/gitlab/-/issues/551165) proposing to move OAuth token hashing *from* PBKDF2 *to* SHA-512. The immediate trigger was compliance breakage, not philosophy: Ubuntu 22.04's FIPS-mode OpenSSL "enforces minimum 16-byte salt length for PBKDF2," and GitLab's implementation used an empty salt, so OAuth-authenticated operations started failing in FIPS environments. But the fix they chose — dropping the KDF entirely rather than adding a salt — rests on the entropy math: the tokens are generated by `SecureRandom.urlsafe_base64(32)` (256 bits of entropy), "PBKDF2 is unnecessary for application-generated cryptographically random tokens" — a position confirmed with their FedRAMP and Data Security teams — and "SHA512 is ~10,000x faster than PBKDF2 for token lookups." That is an organization discovering it had over-applied password-grade hashing to a token, and correcting it once a compliance break forced the entropy math back onto the table.

A note on the opposite intuition. "Always salt, always use a slow hash" is advice most engineers have correctly internalized for passwords, and it is regularly carried over to API tokens wholesale. For a uniformly random 128-bit token the carry-over does not survive the arithmetic — a 2^128 keyspace is not searchable by any GPU cluster at any budget, so a slow hash adds cost only to the defender's lookups — but the persistence of the instinct is a real signal about how easily the password/token distinction gets lost. (An earlier draft of this piece cited an unnamed practitioner blog making the salt-plus-bcrypt argument with a crack-time estimate; the post could not be re-located with its token-size assumptions intact, so the anecdote is withdrawn rather than argued against.)

One caveat on sourcing: OWASP's [Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) and [Cryptographic Storage](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html) cheat sheets gesture at the reversible-encryption-vs-hashing question — the latter states that "Passwords should not be stored using reversible encryption - secure password hashing algorithms should be used instead" — but neither explicitly draws the token/password distinction. The sources reviewed for this article do not establish a storage prescription for reusable bearer tokens; NIST's look-up-secret rule is the nearest authoritative anchor, and any use of it for tokens like these should be labeled as the extrapolation it is.

## 6. Forensic reconciliation: why a *deterministic* hash

A random replacement value would also destroy the plaintext and also preserve the row. The reason to prefer a hash is the third property: given a token observed somewhere in the world — in a support ticket, a screenshot, an access log, a browser history export — you can hash it and find the row. Random values sever that link permanently; you would be holding a link you cannot identify.

This is a shipping pattern, not an invention. [GitHub's audit log](https://docs.github.com/en/enterprise-cloud@latest/admin/monitoring-activity-in-your-enterprise/reviewing-audit-logs-for-your-enterprise/identifying-audit-log-events-performed-by-an-access-token) supports searching by `hashed_token:"<sha256>"` precisely so that an admin who learns a token was compromised can "understand the actions taken by the compromised token" by pulling every event associated with it.

Two honest qualifications:

- I could not confirm whether GitHub's hashed-token search still works *after* the underlying token is revoked or deleted on their side; the documentation describes the mechanism but is silent on post-revocation behavior. So the pattern of hash-keyed audit lookup is confirmed; the exact analogue to "the row outlives revocation forever" is not.
- The obvious counterargument is that **tokens should never be in logs in the first place**. OWASP's [Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html) is unambiguous: secrets should "Never be logged," with encryption or masking applied where they could transit logging paths. That's correct, and it means hash-keyed reconciliation should be understood as a backstop for when logging discipline has already failed — a screenshot in a chat, a URL in someone's browser sync — not as a reason to relax it.

## 7. The migration hazard is worse than the design question

Everything above is about which end state to want. The most concrete risk lives in getting there.

The proposal rewrites a value that is the table's **primary key**. If any other table has a foreign key referencing it, SQLite has a specific and well-documented trap: **`PRAGMA foreign_keys` is off by default, and it is scoped per connection, not per database.** [SQLite's own foreign-key documentation](https://www.sqlite.org/foreignkeys.html) states it directly: "Foreign key constraints are disabled by default (for backwards compatibility), so must be enabled separately for each database connection." Constraints declared in the schema are silently ignored on any connection that doesn't enable it. So an `UPDATE` that rewrites the PK — from the application, from a migration script, or from an ad-hoc `sqlite3` session someone opens to fix something — orphans the child rows with no error and no warning. The schema *says* the constraint exists. Nothing enforces it.

This is a nastier failure than a crash, because the corruption is invisible until something later depends on the join.

Even with the pragma enabled and `ON UPDATE CASCADE` declared, rewriting a primary key on every revocation is an unusual write pattern. Primary keys are conventionally immutable — the classic argument against natural keys is precisely that business values change and PKs shouldn't (a design convention, not a cited standard). A secret token is the most extreme case of a mutable natural key imaginable: it is a value whose entire lifecycle ends in deliberate destruction.

Which points at the better answer.

**Recommended shape:** a surrogate primary key (integer or UUID); a separate `token_hash` column with a unique index; optionally a non-secret `token_prefix` for listings, per §3. Foreign keys reference the surrogate key, never the secret. Revocation then touches only the `token_hash` column, which nothing points at, and the entire SQLite hazard class evaporates. This is more work than the one-line `UPDATE`, and it is the change that makes the one-line `UPDATE` safe to keep doing forever.

## 8. Capability URLs leak by design, which is the actual argument against reversible revocation

The W3C TAG's [*Good Practices for Capability URLs*](https://www.w3.org/TR/capability-urls/) is the standard reference here. It is dated 2014 — old enough to flag, though no clear successor exists — and its leakage inventory is the part that matters:

- **Referer leakage.** Following a link to another site from a page reached via a capability URL can disclose that URL in the `Referer` header. Mitigations: `rel="noreferrer"`, `Referrer-Policy`, or moving the secret into the URL fragment.
- **Logs and history.** URLs "appear within application logs, such as within web servers and in browser history," and "Hosted services that synchronise browser histories, and browser plugin toolbars can easily get hold of URLs for pages that someone using them visits."
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
- **Whether rewriting a referenced primary key is worth the SQLite risk versus migrating to a surrogate key first.** This is an engineering trade-off about blast radius and effort. The surrogate-key convention argues against natural keys from an orthogonal direction, but it isn't adjudicating your migration.
- **Retention duration for tombstoned rows.** SOC 2 implies "observation window plus buffer," with no fixed number attached. There is no principled number for a self-hosted side project, and pretending otherwise would be false precision.
- **Unverified specifics**, flagged rather than smoothed over: whether GitHub's `hashed_token:` search survives token deletion; whether Slack hashes tokens at rest (only general encryption-at-rest guidance was found); and Knox's exact default hash algorithm — its docs establish only that tokens are not stored in plaintext, without naming the function.

The one thing I'd carry out of this beyond the specific decision: **"revoke" is not a verb the database understands.** It compiles down to some combination of a predicate, a record, and a destruction — and if you haven't decided all three explicitly, you have decided them accidentally. The share table described at the top had picked "predicate + record, no destruction" for revocation and "predicate + destruction, no record" for expiry, in the same table, without anyone choosing either.

---

## References

1. [NIST SP 800-63B: Digital Identity Guidelines — Authentication and Lifecycle Management (Rev. 3), §5.1.2.2 Look-Up Secret Verifiers | NIST](https://pages.nist.gov/800-63-3/sp800-63b.html)
2. [NIST SP 800-63B-4: Digital Identity Guidelines — Authentication and Authenticator Management | NIST](https://pages.nist.gov/800-63-4/sp800-63b.html)
3. [SP 800-63B-4 publication record (final, 31 July 2025) | NIST CSRC](https://csrc.nist.gov/pubs/sp/800/63/b/4/final)
4. [Behind GitHub's new authentication token formats | GitHub Blog](https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/)
5. [Identifying audit log events performed by an access token | GitHub Docs](https://docs.github.com/en/enterprise-cloud@latest/admin/monitoring-activity-in-your-enterprise/reviewing-audit-logs-for-your-enterprise/identifying-audit-log-events-performed-by-an-access-token)
6. [Move OAuth Token Hashing from PBKDF2 to SHA512 (issue #551165) | GitLab](https://gitlab.com/gitlab-org/gitlab/-/issues/551165)
7. [Good Practices for Capability URLs (First Public Working Draft, 2014) | W3C TAG](https://www.w3.org/TR/capability-urls/)
8. [Laravel Sanctum | Laravel Documentation](https://laravel.com/docs/11.x/sanctum)
9. [API keys | Stripe Documentation](https://docs.stripe.com/keys)
10. [Auth Tokens | Sentry Documentation](https://docs.sentry.io/account/auth-tokens/)
11. [Manage access keys for IAM users | AWS IAM User Guide](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html)
12. [Service Accounts | Kubernetes Documentation](https://kubernetes.io/docs/concepts/security/service-accounts/)
13. [Encrypting Confidential Data at Rest | Kubernetes Documentation](https://kubernetes.io/docs/tasks/administer-cluster/encrypt-data/)
14. [django-rest-knox documentation | Jazzband](https://jazzband.github.io/django-rest-knox/)
15. [SQLite Foreign Key Support | SQLite Documentation](https://www.sqlite.org/foreignkeys.html)
16. [Art. 17 GDPR — Right to erasure ("right to be forgotten"), Regulation (EU) 2016/679 | gdpr-info.eu](https://gdpr-info.eu/art-17-gdpr/)
17. [2017 Trust Services Criteria (with Revised Points of Focus — 2022) | AICPA](https://www.aicpa-cima.com/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022)
18. [Secrets Management Cheat Sheet | OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
19. [Password Storage Cheat Sheet | OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
20. [Cryptographic Storage Cheat Sheet | OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)
