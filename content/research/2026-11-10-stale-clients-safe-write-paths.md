---
date: "2026-11-10"
time: "09:00"
title: "Stale Tabs and Mixed-Version Clients: Keeping Write Paths Safe When a Dashboard's Read API Changes Shape"
description: "A read-only change to a list endpoint silently corrupted data through an old edit form. This article covers field-semantics changes, read-modify-write hazards, PATCH and ETag preconditions, version-skew detection in SPAs, how GitHub, Google, Stripe and Kubernetes handle it, and how to test old clients against new servers."
tags: ["research", "api-evolution", "dashboards", "version-skew", "reliability", "testing", "fleet"]
---

## Executive Summary

A dashboard's list endpoint was changed to return a short summary (about 200 characters) of each item's long prompt. To save effort, the summary reused the existing `prompt` field. The new frontend was written for that. The old frontend was not: it used the list item's `prompt` to pre-fill its edit form, then sent the whole form back with a PUT. A browser tab left open across an upgrade, or an older fleet controller viewing an upgraded instance, would therefore save the truncated text over the full original. No error, no warning, and a successful 200 response.

The review's fix had three parts: rename the field (`promptSummary`) so old clients no longer see a field they misinterpret; let the write path treat an empty `prompt` as "keep the original"; and have the new client detect old servers (the marker field is missing) and fall back to local behavior. This article generalizes that case.

Main points:

- **The dangerous change was a read-side change.** Nothing was removed, no type changed, and every field the old client read was still present. Yet the meaning of one field changed, and a write path closed the loop. Additive-change rules ("adding fields is safe") do not cover semantic reuse of an existing field name.
- **Any client that reads a representation, edits it and writes it back is a read-modify-write client.** It echoes every field it received, including ones it does not understand. Safe evolution therefore needs defenses on both sides of the boundary: servers should never reuse a name for different content and should make writes tolerant of stale echoes, and clients should detect skew rather than assume it away.
- **HTTP preconditions do not solve this alone.** An ETag stops lost updates from concurrent writers. It does not stop a single stale client from faithfully writing back content it was wrongly given, unless the validator is bound to the specific representation the form was filled from.
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

A tiny model of the incident (a stored 900-character value, a list endpoint truncating to 200, and an old form that echoes `prompt`) was run to confirm the three fix elements work together. Node 24 results:

```text
1 buggy server + old client   -> stored prompt length 200
2 fixed server + old client   -> stored prompt length 900
3 new client sees v1 server   -> marker present? false -> fall back to detail fetch
```

Case 1 is the incident. In case 2 the renamed field means the old form's `item.prompt` is undefined, the old client sends an empty string, and the server treats empty as "keep." In case 3 the new client sees no marker and refuses to treat the list item's text as authoritative. The model is illustrative, not a replacement for a real integration test.

## Server-Side Defenses

### 1. Never reuse a field name for different content

The cheapest and strongest rule: if the meaning, completeness or derivation of a value changes, give it a new name. Kubernetes enforces a strong form of this for its API: once an element is added to an API group version, it cannot be removed or have its behavior significantly changed (Rule 1), and objects must round-trip between versions without information loss (Rule 2) ([Kubernetes deprecation policy](https://kubernetes.io/docs/reference/using-api/deprecation-policy/)). Few dashboards need that rigor, but the principle transfers: a derived or truncated view of data is a different field from the data itself.

Choose names that make the lossy nature obvious (`promptSummary`, `promptPreview`, `promptTruncated: true`), and keep the full-content field only on the detail endpoint that edit forms use.

### 2. Make the write path tolerant of "I did not edit this"

Principle: a write should only change what the user meant to change. Options, from least to most invasive:

- **Empty or absent means keep.** This is what the fix did for old clients. It is cheap and backward compatible, but it overloads a legitimate value: an empty string can no longer mean "clear this field." Document the sentinel, and provide an explicit way to clear (for example a dedicated flag or a null) if clearing is a real operation. Choose this as a transitional shim, not a permanent API design.
- **Partial update (PATCH) with explicit field presence.** Only fields present in the request change. Google's convention requires an `update_mask` listing the fields being updated, treats an omitted mask as "all populated fields" and an empty mask as a no-op; `*` means full replacement ([AIP-134](https://google.aip.dev/134)). The mask makes intent explicit, so an old client that sends a field it did not edit is the only way that field is changed, rather than an accident of echoing a whole form.
- **Dirty-field submission on the client.** A client that sends only fields the user changed gets PATCH semantics even over PUT-shaped endpoints. This helps new clients but cannot protect against old ones, so it complements rather than replaces server rules.

### 3. JSON Merge Patch: useful, with specific traps

RFC 7396 defines `application/merge-patch+json`: the patch document is a partial representation merged into the target, and null values mean "remove this member" ([RFC 7396](https://www.rfc-editor.org/rfc/rfc7396)). Two limits matter for dashboards:

- **Arrays are replaced wholesale.** The RFC states that it is not possible to patch part of a non-object target such as some values in an array. Applying the RFC's algorithm locally (Python) to `{"a":"b","tags":[1,2,3]}` with patch `{"tags":[9],"a":null}` produced `{"tags": [9]}`: the array was replaced and `a` was deleted.
- **Null is a delete, so you cannot store null.** The RFC notes the format suits JSON that does not use explicit nulls.

Merge patch also does not rescue the "empty string" case: `{"prompt": ""}` sets the field to the empty string (the local run confirms `{'prompt': ''}`), which is exactly what a stale client would send. Patch formats reduce accidental overwrites by shrinking what is sent; they do not make a wrong value right.

RFC 5789 adds an important caution: collisions between PATCH requests can be more dangerous than PUT collisions because some patch formats operate from a known base point, and clients using them SHOULD use a conditional request, for example a strong ETag in If-Match ([RFC 5789](https://www.rfc-editor.org/rfc/rfc5789)).

### 4. Optimistic concurrency: what ETags do and do not give you

RFC 9110 says If-Match is most often used with state-changing methods to prevent accidental overwrites when multiple user agents might act in parallel, that is, the "lost update" problem. The server must use strong comparison, because the client intends the precondition to fail if there have been any changes to the representation data ([RFC 9110, section 13.1.1](https://www.rfc-editor.org/rfc/rfc9110.html#name-if-match)). A server can insist on it: status 428 (Precondition Required) exists to require conditional requests and avoid the case where a client GETs, modifies and PUTs while a third party changed the state ([RFC 6585](https://www.rfc-editor.org/rfc/rfc6585)). Kubernetes uses the same idea through `resourceVersion`: a PUT with a stale version gets 409 Conflict ([Kubernetes API concepts](https://kubernetes.io/docs/reference/using-api/api-concepts/)).

The important limit for our case: the stale tab was not racing another writer. Its copy matched the server's current state at the time of the write; it simply held the wrong *representation* of that state. An ETag derived from the resource's version would have matched and the bad write would have succeeded. Preconditions help only if the validator identifies the representation the form was filled from. Concretely:

- Fill edit forms from a detail GET that returns the full value and its own ETag, never from list items.
- Make the ETag of a summary representation differ from that of the full representation (strong ETags are representation-specific), so a PUT carrying the summary's validator is rejected with 412.
- Treat 412/409 as a UI state ("this changed or was loaded in a different form; reload"), not an error toast.

Preconditions are the right defense for concurrent editors and are worth adding; they are a second layer for skew, not the first.

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
- **Service workers add their own skew.** A new service worker waits until the old one is no longer controlling clients; refreshing does not end the wait, because the old worker controls the client during a refresh. `skipWaiting()` activates immediately but can mean a page loaded under the old version is served by the new worker mid-session. The same article suggests calling `registration.update()` on an interval for long-lived tabs and building your own update notification from lifecycle events ([web.dev: Service worker lifecycle](https://web.dev/articles/service-worker-lifecycle)). For a write-heavy dashboard, a "new version available, reload" prompt gated on form state (do not interrupt unsaved edits; do not allow saves from a known-stale bundle without confirmation) is safer than silent `skipWaiting`.
- **Platform-level version locking.** Vercel's Skew Protection pins framework-managed requests to the deployment that served the page by sending a deployment ID, with a maximum age (12 hours on Pro and one day on Enterprise by default), and its own docs say dashboards and monitoring tools with long-open tabs may want a larger window ([Vercel: Skew Protection](https://vercel.com/docs/skew-protection)). Note the caveat in that documentation: custom `fetch()` calls are not pinned in some frameworks unless configured. Version locking is expensive to build yourself and does not exist for a self-hosted fleet; the lower-tech equivalent is explicit version negotiation.

## Why Fleets Make This Harder

An agent-platform dashboard is rarely one frontend and one backend. A controller UI may manage many instances, each upgraded on its own schedule. That has three consequences:

1. **The server version is a per-request variable, not a per-deploy constant.** The same page may call instance A (new) and instance B (two minor versions old) minutes apart. A "reload to update" prompt does not help; the controller is already the newest thing in the system.
2. **Both directions of skew occur at once.** An old controller bundle can see a new instance (the incident), and a new controller can see an old instance (the marker-field fallback).
3. **The fleet controller is a client, not just a UI.** Any server-side code that proxies to instances is subject to the same rules as a browser tab.

Kubernetes provides a good reference model: it publishes explicit supported skew, such as kubectl supported within one minor version, older or newer, of kube-apiserver, and a defined upgrade order starting with the API server ([Kubernetes version skew policy](https://kubernetes.io/releases/version-skew-policy/)). The lesson for a dashboard fleet is to write down the supported window (for example, the controller supports instances from N-2 to N), enforce it with a handshake on first contact, and display degraded or read-only states beyond it. GitHub and Stripe handle the same problem with version pinning: GitHub supports previous versions for at least 24 months after a new one is released, with an explicit `X-GitHub-Api-Version` header and 410 Gone for unsupported versions ([GitHub](https://docs.github.com/en/rest/about-the-rest-api/api-versions)); Stripe pins an account to the latest version on its first request and allows per-request overrides through `Stripe-Version`, with new monthly releases carrying no breaking changes ([Stripe](https://docs.stripe.com/api/versioning); [Stripe engineering blog](https://stripe.com/blog/api-versioning)). Pinning gives the *client* control over when its view changes, which neutralizes the problem at its source, but it requires the server to keep old shapes alive. Both companies pair pinning with strict rules about what counts as breaking, which is the same discipline this article argues for.

## Expand and Contract for Read Shapes

Fowler's description of parallel change (expand, migrate, contract) says to add the new version alongside the old, move clients incrementally, then remove the old; for external clients, migration is "the longest phase" ([Parallel Change](https://martinfowler.com/bliki/ParallelChange.html)). Applied to the incident:

1. **Expand.** Add `promptSummary` (and a marker). Keep `prompt` in the list response with its original full content for the supported-skew window. The review chose to stop returning the truncated value under `prompt`; whether to keep returning the full value under the old name depends on payload size and the supported window. If full prompts are large, returning the field as empty or absent and relying on write-side "keep" is a defensible compromise, as long as it is documented and tested.
2. **Migrate.** Ship the new frontend, switch edit forms to the detail endpoint, and make the write path tolerant.
3. **Contract.** Only after telemetry shows no remaining old controllers or bundles (see the checklist), remove the compatibility behavior. Use observed version headers, not a calendar date, as the trigger.

The difference from a database migration is that you do not control when clients load the new bundle, and the "contract" step is gated by the slowest tab or instance. The existing article on schema migration strategies for agent systems covers the storage side of this pattern.

## Testing for Skew in CI

Most test suites exercise one version of the frontend against one version of the server. The incident passed every such test. These are the strategies that would have caught it:

- **Run the previous frontend bundle against the new server.** Build the last released frontend once (cache it as an artifact) and run its end-to-end edit flow against the candidate server: open an item, change one unrelated field, save, and assert that the long field is byte-identical afterwards. This is the single highest-value test for the class of bug described here.
- **Run the new frontend against the previous server.** Same flow, reversed; assert that marker detection triggers the fallback and that nothing is saved from a summary.
- **Make "round trip preserves untouched fields" a property test.** For each editable resource, create it with maximal values, load it through the list and detail representations as the old and new clients would, save without changes and assert equality. Kubernetes states round-trip fidelity as a policy ([Rule 2](https://kubernetes.io/docs/reference/using-api/deprecation-policy/)); a test is how you enforce it.
- **Consumer-driven contracts.** In Pact, contracts are generated from consumer tests and cover only the parts of the provider that consumers actually use ([Pact docs](https://docs.pact.io/)). The Pact Broker's `can-i-deploy` check decides whether a version is safe for an environment by looking for successful verification results between that version and the versions deployed there ([Pact: can-i-deploy](https://docs.pact.io/pact_broker/can_i_deploy)). The caveat: contract tests describe reads and writes the consumer *exercised*. They would catch the bug only if the old consumer's contract included "load list item, then save", and a pure response-shape contract would pass because the field was still a string. Include write interactions that depend on read values.
- **Unknown-field strictness in test environments.** Kubernetes' `fieldValidation` modes (Strict rejects unknown or duplicate fields, Warn is the default, Ignore drops them) show a useful pattern: be lenient in production, strict in CI, so typos and unexpected fields are loud before release.
- **Version matrix for the fleet.** Keep at least the previous release and the oldest supported release of the instance running in a test harness, and run the controller against all of them.

## Checklist

**Reviewing a change to a read endpoint**

- [ ] Does any client use this response (or a field in it) to pre-fill a form or build a write request? Search frontends, CLI tools and fleet code, not just the current UI.
- [ ] Is any existing field changing content (truncated, derived, redacted, reformatted, defaulted)? If yes, give the new meaning a new name.
- [ ] Is the full-content field still available from a detail endpoint with its own validator?
- [ ] Is a marker field or capability flag present so newer clients can detect the new shape?
- [ ] Is the change recorded as "semantic" in the changelog even though the schema diff is additive?

**Hardening a write endpoint**

- [ ] Prefer PATCH or field-mask semantics; if a PUT-shaped endpoint must stay, define what absent and empty values mean, and provide an explicit way to clear a field.
- [ ] Require If-Match (428 when missing) for resources edited by more than one actor; return 412 or 409 and handle them in the UI.
- [ ] Bind the validator to the representation used to fill the form.
- [ ] Log (and consider rejecting) writes whose values equal a known summary or are implausibly short compared with the stored value.
- [ ] Log the client build/version of each write so that old clients can be identified before contraction.

**Client behavior**

- [ ] Fill edit forms from the detail representation; send only changed fields where the API allows it.
- [ ] Detect server shape by marker or capability, in one adapter, with a safe fallback (re-fetch detail, or read-only).
- [ ] Compare the bundle's build ID to a server-provided one; on mismatch, block or confirm saves and offer reload without discarding unsaved edits.
- [ ] Handle dynamic import failures and service worker updates deliberately; do not use `skipWaiting` without considering mid-session mixing.

**Fleet and release process**

- [ ] State the supported controller-to-instance skew window and enforce it with a handshake.
- [ ] Record the last-seen bundle and instance versions; contract compatibility shims only when those drop to zero or the window has passed.
- [ ] Add CI jobs: previous-frontend against new-server, new-frontend against previous-server, and an untouched-field round-trip test.
- [ ] Keep a rollback plan that tolerates both shapes. A rolled-back server meets new-shape clients.

## Limits of This Analysis

The case study is summarized from a code review and described generically; no production data loss is claimed beyond the mechanism. The Node and Python snippets are small local models (Node 24.22.1, a Python 3 implementation of the RFC 7396 algorithm), not benchmarks, and they do not model concurrency, caching or real browsers. Details of third-party documentation (GitHub support windows, Stripe's release cadence, Vercel's defaults, Kubernetes policies) were read from the cited pages on the date of writing and may change. The recommendations about version headers, sentinel values and write-rejection heuristics are engineering judgment rather than standardized practice, and each has trade-offs that should be evaluated for your API.

## Sources

- Fowler: [Parallel Change](https://martinfowler.com/bliki/ParallelChange.html) (Danilo Sato, 2014) and [Tolerant Reader](https://martinfowler.com/bliki/TolerantReader.html) (2011).
- IETF: [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html) (PUT, ETag, If-Match, 412), [RFC 5789](https://www.rfc-editor.org/rfc/rfc5789) (PATCH), [RFC 7396](https://www.rfc-editor.org/rfc/rfc7396) (JSON Merge Patch), [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585) (428 Precondition Required), [RFC 9413](https://www.rfc-editor.org/rfc/rfc9413) (Maintaining Robust Protocols).
- Google: [AIP-134 Update](https://google.aip.dev/134), [AIP-180 Backwards compatibility](https://google.aip.dev/180).
- Kubernetes: [Deprecation policy](https://kubernetes.io/docs/reference/using-api/deprecation-policy/), [API concepts](https://kubernetes.io/docs/reference/using-api/api-concepts/), [Version skew policy](https://kubernetes.io/releases/version-skew-policy/).
- GitHub: [REST API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions). Stripe: [API versioning](https://docs.stripe.com/api/versioning), [APIs as infrastructure](https://stripe.com/blog/api-versioning).
- Version skew and SPAs: [Malte Ubl, Version Skew](https://www.industrialempathy.com/posts/version-skew/), [Vercel Skew Protection](https://vercel.com/docs/skew-protection), [Vite load error handling](https://vite.dev/guide/build#load-error-handling), [web.dev service worker lifecycle](https://web.dev/articles/service-worker-lifecycle).
- Testing: [Pact](https://docs.pact.io/), [Pact can-i-deploy](https://docs.pact.io/pact_broker/can_i_deploy). Hyrum's Law: [hyrumslaw.com](https://www.hyrumslaw.com/).
