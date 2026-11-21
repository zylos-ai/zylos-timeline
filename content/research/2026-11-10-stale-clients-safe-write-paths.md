---
date: "2026-11-10"
time: "09:00"
title: "Stale Tabs and Mixed-Version Clients: Keeping Write Paths Safe When a Dashboard's Read API Changes Shape"
description: "A read-only change to a list endpoint silently corrupted data through an old edit form. This article covers field-semantics changes, read-modify-write hazards, PATCH and ETag preconditions, version-skew detection in SPAs, how GitHub, Google, Stripe and Kubernetes handle it, and how to test old clients against new servers."
tags: ["research", "api-evolution", "dashboards", "version-skew", "reliability", "testing", "fleet"]
---

## Executive Summary

A dashboard's list endpoint was changed to return a short summary (about 200 characters) of each item's long prompt. To save effort, the summary reused the existing `prompt` field. The new frontend was written for that. The old frontend was not: it used the list item's `prompt` to pre-fill its edit form, then sent the whole form back with a PUT. A browser tab left open across an upgrade, or an older fleet controller viewing an upgraded instance, would therefore save the truncated text over the full original. No error, no warning, and a successful 200 response.

The review's fix had three parts: rename the field (`promptSummary`) so old clients no longer see a field they misinterpret; let the write path treat an empty `prompt` as "keep the original"; and have the new client detect old servers (the marker field is missing) and fall back to local behavior. That empty-value shim protected one unrelated-save path; it did not establish compatibility for the old editor or preserve intentional clears. This article distinguishes that limited mitigation from a safe migration contract.

Main points:

- **The dangerous change was a read-side change.** Nothing was removed, no type changed, and every field the old client read was still present. Yet the meaning of one field changed, and a write path closed the loop. Additive-change rules ("adding fields is safe") do not cover semantic reuse of an existing field name.
- **Any client that reads a representation, edits it and writes it back is a read-modify-write client.** It echoes every field it received, including ones it does not understand. Safe evolution therefore needs defenses on both sides of the boundary: servers should never reuse a name for different content and should make writes tolerant of stale echoes, and clients should detect skew rather than assume it away. Supported legacy editors must retain their original full-value reads and edit/clear behavior; otherwise restrict writes explicitly instead of claiming compatibility.
- **HTTP preconditions do not solve this alone.** An ETag stops lost updates from concurrent writers. It does not stop a single stale client from faithfully writing back content it was wrongly given. A safe editor must load the full values and validator together, and the server must require and atomically check its selected detail representation's strong validator. Even that cannot detect a client attaching a fresh token to stale summary-derived values.
- **Treat skew as permanent, not transitional.** Long-lived tabs, cached bundles and fleet controllers pinned to older releases make mixed-version operation the normal state. Test it in CI by running the previous frontend bundle against the new server, and the new frontend against the previous server.

This article does not repeat the general versioning landscape covered in earlier pieces on API versioning for multi-agent platforms, schema migration for agent systems, and safe agent upgrade patterns. Those cover version schemes, database expand-and-contract and rollout strategies. The angle here is narrower: what happens at the moment an already-loaded client writes, and what the server and the client can each do to make that moment safe.

## What Actually Broke: A Semantics Change Disguised as an Additive One

Mainstream API guidance treats added response fields as safe. GitHub's REST API documentation lists adding a response field, optional parameter, response header or enum value as non-breaking, and says breaking changes (removing or renaming a field, adding a required parameter) ship in a new API version ([GitHub: API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions)). Stripe's engineering write-up names two backward-compatible changes: adding an endpoint and adding a field that was never present before ([Stripe: APIs as infrastructure](https://stripe.com/blog/api-versioning)).

The incident above matches neither category. The field already existed and its type was unchanged (string to string). Google's API Improvement Proposal on backward compatibility is explicit about this class: changing the format or construction of an existing field's value is breaking even if the type stays the same, and APIs must not change visible behavior in ways likely to break reasonable code, even when that behavior was never documented ([AIP-180](https://google.aip.dev/180)). That is Hyrum's Law in practice: "With a sufficient number of users of an API, it does not matter what you promise in the contract: all observable behaviors of your system will be depended on by somebody" ([hyrumslaw.com](https://www.hyrumslaw.com/)). The old frontend depended on one observable behavior: the field named `prompt` contains the full prompt.

A useful classification of read-API changes for review purposes:

| Change | Typical label | Risk to a stale read-only consumer | Risk to a stale read-modify-write consumer |
| --- | --- | --- | --- |
| New field, new name, new meaning | Additive | None | None, if the client ignores it and the server does not require it |
| Existing field, same meaning, more values | Additive | Low (strict parsers may fail) | Low |
| Existing field, **narrower/derived/truncated content** | Often mislabeled "non-breaking" | Display quality | **Data loss on next save** |
| Existing field, changed format or units | Breaking | Misrendering | Corrupt writes |
| Field removed or renamed | Breaking | Missing data | Writes that clear or omit the field |

The third row is the trap. A reviewer scanning for removed or retyped fields sees nothing. The only way to catch it is to ask of every changed read shape: does any client write this value back?

## The Read-Modify-Write Hazard

A form-based editor follows the pattern GET, edit locally, send everything back. It has three properties that matter here.

1. **It echoes what it was given.** Fields the user did not touch are transmitted back as if the user had set them. The server cannot distinguish "the user typed this" from "the client carried it along."
2. **PUT means replace.** RFC 9110 defines PUT as replacing the state of the target resource with the enclosed representation ([RFC 9110, section 9.3.4](https://www.rfc-editor.org/rfc/rfc9110.html#name-put)). A server that implements it literally will faithfully store whatever echoed value arrives.
3. **Clients drop or mangle what they do not understand.** Kubernetes' documentation on update mechanisms lists this drawback of whole-object PUT explicitly: a client that decodes an object locally may drop fields it does not recognize ([Kubernetes API concepts](https://kubernetes.io/docs/reference/using-api/api-concepts/)). Google's update guidance makes the same point from the server side: PUT is discouraged because adding a field to a resource can cause a PUT from an older client to wipe data that client did not know about ([AIP-134](https://google.aip.dev/134)).

Our case is the mirror image: the old client did not lose a field it did not know; it kept a field whose meaning had changed. The effect is identical. The payload that arrives at the write endpoint is syntactically valid, passes schema validation, and is wrong.

A tiny model of the incident (a stored 900-character value, a list endpoint truncating to 200, and an old form that echoes `prompt`) illustrated the limited data-preservation effect of the three fix elements. Node 24 results:

```text
1 buggy server + old client   -> stored prompt length 200
2 fixed server + old client   -> stored prompt length 900
3 new client sees v1 server   -> marker present? false -> fall back to detail fetch
```

Case 1 is the incident. In case 2 the renamed field means the old form's `item.prompt` is undefined, the old client sends an empty string, and the server treats empty as "keep." In case 3 the new client sees no marker and refuses to treat the list item's text as authoritative. Case 2 only checks stored length on an unrelated save: the old editor can now be blank, and intentional clearing is silently ignored. It does not prove editor compatibility. A stricter caller can also reject a missing field. The model is illustrative, not a replacement for a real integration test.

## Server-Side Defenses

### 1. Never reuse a field name for different content

The cheapest and strongest rule: if the meaning, completeness or derivation of a value changes, give it a new name. Kubernetes enforces a strong form of this for its API: once an element is added to an API group version, it cannot be removed or have its behavior significantly changed (Rule 1), and objects must round-trip between versions without information loss (Rule 2) ([Kubernetes deprecation policy](https://kubernetes.io/docs/reference/using-api/deprecation-policy/)). Few dashboards need that rigor, but the principle transfers: a derived or truncated view of data is a different field from the data itself.

Choose names that make the lossy nature obvious (`promptSummary`, `promptPreview`, `promptTruncated: true`), and make the detail endpoint authoritative for new edit forms. During a supported legacy-editor window, retain the old full-content field wherever those editors expect it, including list responses. Removing it is a behavioral change, even if a write shim prevents some data loss.

### 2. Make the write path tolerant of "I did not edit this"

Principle: a write should only change what the user meant to change. Options, from least to most invasive:

- **Empty or absent means keep.** The incident's shim preserves stored text on the tested unrelated save, but is not backward compatible for an editor that reads full text or clears with an empty string. Preserve original read and edit/clear semantics for any editor still declared supported. Otherwise label the route as limited: the safe restricted route considered here accepts unrelated partial saves only when `prompt` is omitted, and rejects every prompt-bearing request, including edits, echoed values and empty clears, with an upgrade/read-only response before mutation. An old whole-form client therefore cannot save through this restricted route; do not report success while dropping its requested change. This route is not a replacement for an old PUT contract.
- **Partial update (PATCH) with explicit field presence.** Only fields present in the request change. Google defines an optional `update_mask` listing paths to update, treats an omitted mask as the non-empty populated fields and an empty mask as a no-op; `*` means full replacement ([AIP-134](https://google.aip.dev/134)). The client must supply the actual edited paths in the mask; a populated echoed body value alone does not communicate intent. The omitted-mask fallback is separate: it includes non-empty populated fields, so an echoed prompt can still be written. An explicit mask containing `prompt` can express an intentional empty clear; the omitted-mask fallback cannot infer that intent.
- **Dirty-field submission on the client.** A client that sends only fields the user changed gets PATCH semantics even over PUT-shaped endpoints. This helps new clients but cannot protect against old ones, so it complements rather than replaces server rules.

### 3. JSON Merge Patch: useful, with specific traps

RFC 7396 defines `application/merge-patch+json`: the patch document is a partial representation merged into the target, and null values request member removal ([RFC 7396](https://www.rfc-editor.org/rfc/rfc7396)). Two limits matter for dashboards:

- **Arrays are replaced wholesale.** The RFC states that it is not possible to patch part of a non-object target such as some values in an array. Applying the RFC's algorithm locally (Python) to `{"a":"b","tags":[1,2,3]}` with patch `{"tags":[9],"a":null}` produced `{"tags": [9]}`: the array was replaced and `a` was deleted.
- **Null is a delete, so you cannot store null.** The RFC notes the format suits JSON that does not use explicit nulls.

Merge patch also does not rescue the "empty string" case: `{"prompt": ""}` sets the field to the empty string (the local run confirms `{'prompt': ''}`), which is exactly what a stale client would send. Patch formats reduce accidental overwrites by shrinking what is sent; they do not make a wrong value right.

RFC 5789 adds an important caution: collisions between PATCH requests can be more dangerous than PUT collisions because some patch formats operate from a known base point, and clients using them SHOULD use a conditional request, for example a strong ETag in If-Match ([RFC 5789](https://www.rfc-editor.org/rfc/rfc5789)).

### 4. Optimistic concurrency: what ETags do and do not give you

RFC 9110 says If-Match is most often used with state-changing methods to prevent accidental overwrites when multiple user agents might act in parallel, that is, the "lost update" problem. The server must use strong comparison, because the client intends the precondition to fail if there have been any changes to the representation data ([RFC 9110, section 13.1.1](https://www.rfc-editor.org/rfc/rfc9110.html#name-if-match)). A server can insist on it: status 428 (Precondition Required) exists to require conditional requests and avoid the case where a client GETs, modifies and PUTs while a third party changed the state ([RFC 6585](https://www.rfc-editor.org/rfc/rfc6585)). Kubernetes uses the same idea through `resourceVersion`: a PUT with a stale version gets 409 Conflict ([Kubernetes API concepts](https://kubernetes.io/docs/reference/using-api/api-concepts/)).

The important limit for our case: the stale tab was not racing another writer. Its values came from the wrong *representation*. A token derived only from the resource revision would have matched and the bad write would have succeeded. The proposed edit contract is:

- Fill each edit form with full values and the strong ETag from the **same authoritative detail GET**. A separate token refresh must never bless values already seeded from a list summary; reload the values too and reconcile actual user edits.
- At the edit target, require a concrete detail validator for this contract: return 428 when it is missing. An existence-only `If-Match: *` does not satisfy this project requirement for a revision token. Check the selected detail representation using strong comparison; reject a stale, weak or summary validator with 412. These are the HTTP precondition results; Kubernetes' version-field 409 is a different API convention.
- Perform revision comparison and mutation in one transaction or compare-and-swap. A check followed by an unguarded write leaves a race between the two. A concurrent change must make the conditional mutation fail without changing stored data.
- An old caller that cannot satisfy this contract must use an explicitly supported compatibility contract, or receive upgrade/read-only before mutation. The restricted legacy route above accepts only prompt-omitting unrelated partial saves; it does not waive the guard for a prompt write.
- Treat 428/412 as recoverable UI states: explain the need to reload authoritative detail and preserve unsaved user edits for reconciliation.

A current detail token attached to an old summary body still passes If-Match. No standard validator proves how a client constructed its payload; neither a build-ID confirmation nor a fresh token makes that payload safe. The same-fetch client rule, actual dirty-field submission and explicit legacy restrictions provide the representation-safety layer; preconditions provide concurrency protection.

### 5. Defense in depth: reject implausible destructive writes

Where a field has an invariant, enforce it at the boundary. A write that would shorten a long value to exactly the length of a known summary limit, or that sets a field to a value equal to its own summary, is a strong signal. Rejecting with a clear error is often better than silently accepting. Use this sparingly, since heuristics produce false positives, and log rejections so the pattern can be investigated.

## Client-Side Defenses

### Tolerant reader, and its limit

Martin Fowler's Tolerant Reader pattern advises consuming only the data a client needs and ignoring the rest so providers can add fields without breaking consumers; it pairs this with the provider-side "Magnanimous Writer" and notes the coupling is reduced, not eliminated ([Fowler, Tolerant Reader](https://martinfowler.com/bliki/TolerantReader.html)). It protects against *unknown* fields. It does nothing against a *known* field with new semantics, which is the failure here. The IAB's guidance on robust protocols adds a general warning that silently tolerating faulty or ambiguous input tends to let problems accumulate and entrench ([RFC 9413](https://www.rfc-editor.org/rfc/rfc9413)). For write paths, the right posture is: read tolerantly, write conservatively, and verify capability before relying on a field.

### Detect the server's shape, do not infer it from the client build

The fix's marker-field approach is sound: the new client checks for a field that exists only in the new shape (here the renamed summary field) and falls back to old behavior when it is missing. Principles:

- **Detect capability, not version numbers, when possible.** A marker field or an explicit capability list on a status/info endpoint survives backports and partial rollouts better than comparing semver strings.
- **Decide once, near the data boundary.** Convert wire shapes into one internal model in a single adapter (the same containment Fowler recommends for payload parsing). Components should never branch on server version.
- **Fall back to a safe read before write.** If the server is old, either re-fetch the full detail before filling the form, or disable edit and say why.
- **Never treat an absent marker as an error on a read-only view.** Mixed-version fleets are normal; degrade the feature, not the page.

### Detecting that the loaded bundle itself is stale

Skew has two directions. The server can be newer than the page, as in the incident, and the server can be *older* than the page (a controller upgraded before an instance). Malte Ubl's overview of version skew lists exactly these sources: non-atomic rollouts, old tabs, cached or long-lived clients, persisted data, and config/flags ([Version Skew, Industrial Empathy](https://www.industrialempathy.com/posts/version-skew/)). He quotes the reality that users "might keep the browser tab open for days or even weeks." Practical detection mechanisms:

- **Build identifier in every response.** Include a header (for example `X-App-Version` or a build hash) on API responses. The client compares it with the version baked into its bundle. A mismatch before a write is a reason to pause the write and offer a reload. This is a project convention rather than a standard; the header name is yours to choose.
- **Poll or push a version manifest.** Fetch a small, uncached version file periodically and on tab focus; compare against the loaded build.
- **Handle chunk-load failures.** Vite fires `vite:preloadError` when a dynamic import fails, typically because a deploy removed old assets; the documented example reloads the page, and the docs advise `Cache-Control: no-cache` on the HTML file so new deploys are discovered ([Vite: building for production](https://vite.dev/guide/build#load-error-handling)).
- **Service workers add their own skew.** A new service worker waits until the old one is no longer controlling clients; refreshing does not end the wait, because the old worker controls the client during a refresh. `skipWaiting()` activates immediately but can mean a page loaded under the old version is served by the new worker mid-session. The same article suggests calling `registration.update()` on an interval for long-lived tabs and building your own update notification from lifecycle events ([web.dev: Service worker lifecycle](https://web.dev/articles/service-worker-lifecycle)). For a write-heavy dashboard, a "new version available, reload" prompt gated on form state (do not interrupt unsaved edits; pause saves from a known-stale bundle until its write contract is supported or authoritative detail is reloaded; confirmation alone is insufficient) is safer than silent `skipWaiting`.
- **Platform-level version locking.** Vercel's Skew Protection pins framework-managed requests to the deployment that served the page by sending a deployment ID, with a maximum age (12 hours on Pro and one day on Enterprise by default), and its own docs say dashboards and monitoring tools with long-open tabs may want a larger window ([Vercel: Skew Protection](https://vercel.com/docs/skew-protection)). Note the caveat in that documentation: custom `fetch()` calls are not pinned in some frameworks unless configured. Version locking is expensive to build yourself and does not exist for a self-hosted fleet; the lower-tech equivalent is explicit version negotiation.

## Why Fleets Make This Harder

An agent-platform dashboard is rarely one frontend and one backend. A controller UI may manage many instances, each upgraded on its own schedule. That has three consequences:

1. **The server version is a per-request variable, not a per-deploy constant.** The same page may call instance A (new) and instance B (two minor versions old) minutes apart. A "reload to update" prompt does not help; the controller is already the newest thing in the system.
2. **Both directions of skew occur at once.** An old controller bundle can see a new instance (the incident), and a new controller can see an old instance (the marker-field fallback).
3. **The fleet controller is a client, not just a UI.** Any server-side code that proxies to instances is subject to the same rules as a browser tab.

Kubernetes provides a good reference model: it publishes explicit supported skew, such as kubectl supported within one minor version, older or newer, of kube-apiserver, and a defined upgrade order starting with the API server ([Kubernetes version skew policy](https://kubernetes.io/releases/version-skew-policy/)). The lesson for a dashboard fleet is to write down the supported window (for example, the controller supports instances from N-2 to N), check it on first contact and enforce the accepted write contract at every write, displaying degraded or read-only states beyond it. A handshake alone cannot cover a tab that sleeps through the support cutoff. GitHub and Stripe handle the same problem with version pinning: GitHub supports previous versions for at least 24 months after a new one is released, with an explicit `X-GitHub-Api-Version` header and 410 Gone for unsupported versions ([GitHub](https://docs.github.com/en/rest/about-the-rest-api/api-versions)); Stripe pins an account to the latest version on its first request and allows per-request overrides through `Stripe-Version`, with new monthly releases carrying no breaking changes ([Stripe](https://docs.stripe.com/api/versioning); [Stripe engineering blog](https://stripe.com/blog/api-versioning)). Pinning gives the *client* control over when its view changes, which neutralizes the problem at its source, but it requires the server to keep old shapes alive. Both companies pair pinning with strict rules about what counts as breaking, which is the same discipline this article argues for.

## Expand and Contract for Read Shapes

Fowler's description of parallel change (expand, migrate, contract) says to add the new version alongside the old, move clients incrementally, then remove the old; for external clients, migration is "the longest phase" ([Parallel Change](https://martinfowler.com/bliki/ParallelChange.html)). Applied to the incident:

1. **Expand.** Add `promptSummary` (and a marker). Keep `prompt` with its original full content wherever supported legacy editors read it, for the supported-skew window. Empty or absent `prompt` plus write-side keep only protects a particular save path; it changes editor behavior. If the full read cannot be retained, explicitly withdraw editor support and reject incompatible saves as described above.
2. **Migrate.** Ship the new frontend, fill forms from one detail values-and-token fetch, submit actual edited paths, and require atomic write preconditions. Test legacy unrelated saves, deliberate edits and clears against the declared compatibility contract.
3. **Contract.** Quiet telemetry or elapsed time alone cannot authorize removal: dormant tabs are invisible. Keep the server guard after telemetry goes quiet. Before retiring a compatibility route, enforce an explicit support cutoff at every write: unsupported or unidentifiable contracts receive upgrade/read-only before mutation, including a dormant editor's first returning request. Missing preconditions on the modern route still get 428; mismatched ones get 412. The cutoff response is a project policy, not a status prescribed by those RFCs.

Rollback must preserve the cutoff and conditional-write boundary too. A prior release that would accept an unsupported write unguarded is not a safe rollback target: retain the rejecting boundary, or disable writes until a compatible server is restored. Do not simply roll the guard back with the application.

The difference from a database migration is that you do not control when clients load the new bundle; contraction needs an enforced server boundary for clients that return after support ends. The existing article on schema migration strategies for agent systems covers the storage side of this pattern.

## Testing for Skew in CI

Most test suites exercise one version of the frontend against one version of the server. The incident passed every such test. These are the strategies that would have caught it:

- **Run the previous frontend bundle against the new server.** Build the last released frontend once (cache it as an artifact) and run its end-to-end edit flow against the candidate server: open an item, change one unrelated field, save, and assert that the long field is byte-identical afterwards. This is the single highest-value test for the class of bug described here.
- **Run the new frontend against the previous server.** Same flow, reversed; assert that marker detection triggers a full-detail fallback or read-only and that nothing is saved from a summary. For rollback, verify that the rejecting boundary remains in force; do not assume the old server implements it.
- **Make "round trip preserves untouched fields" a property test.** For each editable resource, create it with maximal values, load it through the list and detail representations as the old and new clients would, save without changes and assert equality. Kubernetes states round-trip fidelity as a policy ([Rule 2](https://kubernetes.io/docs/reference/using-api/deprecation-policy/)); a test is how you enforce it.
- **Consumer-driven contracts.** In Pact, contracts are generated from consumer tests and cover only the parts of the provider that consumers actually use ([Pact docs](https://docs.pact.io/)). The Pact Broker's `can-i-deploy` check decides whether a version is safe for an environment by looking for successful verification results between that version and the versions deployed there ([Pact: can-i-deploy](https://docs.pact.io/pact_broker/can_i_deploy)). The caveat: contract tests describe reads and writes the consumer *exercised*. They would catch the bug only if the old consumer's contract included "load list item, then save", and a pure response-shape contract would pass because the field was still a string. Include write interactions that depend on read values.
- **Unknown-field strictness in test environments.** Kubernetes' `fieldValidation` modes (Strict rejects unknown or duplicate fields, Warn is the default, Ignore drops them) show a useful pattern: be lenient in production, strict in CI, so typos and unexpected fields are loud before release.
- **Exercise the guard and its limits.** Check missing token → 428; stale, weak and summary token → 412; concurrent mutation → failed compare-and-swap with no write. Include current detail token plus stale summary values: show that preconditions alone accept it, then verify that the supported editor loads values and token together and that unsupported legacy prompt writes are rejected. Test unrelated legacy saves, edits and clears separately, and a dormant tab returning after cutoff in both upgrade and rollback directions.
- **Version matrix for the fleet.** Keep at least the previous release and the oldest supported release of the instance running in a test harness, and run the controller against all of them.

## Checklist

**Reviewing a change to a read endpoint**

- [ ] Does any client use this response (or a field in it) to pre-fill a form or build a write request? Search frontends, CLI tools and fleet code, not just the current UI.
- [ ] Is any existing field changing content (truncated, derived, redacted, reformatted, defaulted)? If yes, give the new meaning a new name.
- [ ] Are full values and a strong validator returned together from detail, and are original full reads retained for supported legacy editors? If support is withdrawn, are incompatible saves explicitly rejected?
- [ ] Is a marker field or capability flag present so newer clients can detect the new shape?
- [ ] Is the change recorded as "semantic" in the changelog even though the schema diff is additive?

**Hardening a write endpoint**

- [ ] Prefer PATCH or actual edited-path masks; document omitted-mask fallback separately. Preserve supported legacy edit/clear semantics, or declare the limited route and reject unsupported changes before mutation.
- [ ] Require the concrete detail If-Match token at the modern edit boundary (428 when missing, 412 on strong-comparison mismatch), with comparison and mutation in one transaction or compare-and-swap.
- [ ] Bind the validator to the selected detail representation; fetch values and token together. Test that a fresh token alone does not detect a summary-derived payload.
- [ ] Log (and consider rejecting) writes whose values equal a known summary or are implausibly short compared with the stored value.
- [ ] Log the client build/version of each write so that old clients can be identified before contraction.

**Client behavior**

- [ ] Fill edit forms with full values and token from the same detail fetch; send actual changed fields where the API allows it, including intentional clears.
- [ ] Detect server shape by marker or capability, in one adapter, with a safe fallback (re-fetch detail, or read-only).
- [ ] Compare the bundle's build ID to a server-provided one; on mismatch, pause saves and offer authoritative-detail reload without discarding unsaved edits. Confirmation or a fresh token alone cannot repair a lossy payload.
- [ ] Handle dynamic import failures and service worker updates deliberately; do not use `skipWaiting` without considering mid-session mixing.

**Fleet and release process**

- [ ] State the supported write-contract window, check it at handshake and enforce it on every write, including requests from dormant tabs.
- [ ] Record last-seen versions for planning; retire shims only behind a persistent server guard or an enforced cutoff that rejects unsupported/missing write contracts. Quiet telemetry and elapsed time are insufficient.
- [ ] Add CI jobs for both skew directions, untouched fields, intentional edits/clears, atomic preconditions and dormant returns after cutoff.
- [ ] Keep the rejecting write boundary during rollback; disable writes if the rollback target cannot enforce it. Test dormant old and new clients against that boundary.

## Limits of This Analysis

The case study is summarized from a code review and described generically; no production data loss is claimed beyond the mechanism. The Node and Python snippets are small local models (Node 24.22.1, a Python 3 implementation of the RFC 7396 algorithm), not benchmarks, and they do not model concurrency, caching or real browsers. Details of third-party documentation (GitHub support windows, Stripe's release cadence, Vercel's defaults, Kubernetes policies) were read from the cited pages on the date of writing and may change. An additional isolated Python policy model exercised stale and missing validators, the current-token/bad-value limitation, two writers sharing one revision, restricted legacy unrelated saves/edits/clears, dirty-mask versus omitted-mask behavior, and dormant returns after cutoff with and without a retained rollback guard. It is illustrative policy logic, not implementation or browser/fleet integration evidence. The recommendations about version headers, sentinel values and write-rejection heuristics are engineering judgment rather than standardized practice, and each has trade-offs that should be evaluated for your API.

## Sources

- Fowler: [Parallel Change](https://martinfowler.com/bliki/ParallelChange.html) (Danilo Sato, 2014) and [Tolerant Reader](https://martinfowler.com/bliki/TolerantReader.html) (2011).
- IETF: [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html) (PUT, ETag, If-Match, 412), [RFC 5789](https://www.rfc-editor.org/rfc/rfc5789) (PATCH), [RFC 7396](https://www.rfc-editor.org/rfc/rfc7396) (JSON Merge Patch), [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585) (428 Precondition Required), [RFC 9413](https://www.rfc-editor.org/rfc/rfc9413) (Maintaining Robust Protocols).
- Google: [AIP-134 Update](https://google.aip.dev/134), [AIP-180 Backwards compatibility](https://google.aip.dev/180).
- Kubernetes: [Deprecation policy](https://kubernetes.io/docs/reference/using-api/deprecation-policy/), [API concepts](https://kubernetes.io/docs/reference/using-api/api-concepts/), [Version skew policy](https://kubernetes.io/releases/version-skew-policy/).
- GitHub: [REST API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions). Stripe: [API versioning](https://docs.stripe.com/api/versioning), [APIs as infrastructure](https://stripe.com/blog/api-versioning).
- Version skew and SPAs: [Malte Ubl, Version Skew](https://www.industrialempathy.com/posts/version-skew/), [Vercel Skew Protection](https://vercel.com/docs/skew-protection), [Vite load error handling](https://vite.dev/guide/build#load-error-handling), [web.dev service worker lifecycle](https://web.dev/articles/service-worker-lifecycle).
- Testing: [Pact](https://docs.pact.io/), [Pact can-i-deploy](https://docs.pact.io/pact_broker/can_i_deploy). Hyrum's Law: [hyrumslaw.com](https://www.hyrumslaw.com/).
