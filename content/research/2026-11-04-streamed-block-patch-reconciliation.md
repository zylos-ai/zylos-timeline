---
date: "2026-11-04"
title: "Applying Streamed Patches to Structured Chat Blocks Without Losing Them"
description: "How an agent chat client should reconcile live patches to interactive blocks (ask-user prompts, forms, tool cards) with later full-state snapshots, so a resolved block never keeps showing clickable options. Covers block-id scope, JSON Merge Patch and JSON Patch traps, version gates, stream/snapshot ordering, and a local Node experiment."
tags: ["agent-ui", "streaming", "json-patch", "state-sync", "react", "reconciliation", "ag-ui"]
---

## Executive Summary

An agent chat transcript is no longer a list of strings. Messages carry structured blocks: a multiple-choice prompt, a form, a tool-call card with an approval button. Those blocks change after they are first rendered. The user answers, the agent times out, another device resolves the prompt. The client hears about it through two unrelated channels: a live stream of patches, and a snapshot fetched later by a sync call. The failure users notice is concrete: the block is resolved on the server, but the screen still shows live, clickable options.

This article traces four independent ways that failure arises and shows each one reproducing in a small local Node experiment (real output in section 8):

1. **Identity collisions.** Block ids that are only unique inside one message (every message's first block is `b1`) collide when the client keys a store or a UI list by block id alone. Provider streaming protocols mostly scope their indices to a single message or response, so this is the expected shape of the input, not an edge case.
2. **Patch semantics and schema drift.** RFC 7396 merge patch replaces arrays wholesale and treats `null` as delete. RFC 6902 patches fail atomically when a path does not exist. A strict client decoder that rejects a server-side scalar-to-array change silently drops the whole patch, status change included.
3. **Version gates that the server does not honor.** A client that only accepts a snapshot row if its `rev` increased will skip a row the server updated without bumping `rev`.
4. **Ordering.** A patch can arrive before the snapshot it logically follows, and a slow older snapshot can arrive after a newer patch. A blind "snapshot replaces everything" rule regresses a resolved block to pending.

The recommended shape, which is engineering synthesis rather than any provider's documented contract, is: composite `(messageId, blockId)` keys everywhere including the UI layer; one monotonic per-entity sequence bumped on every mutation of that entity; apply-if-newer for both patches and snapshot rows; buffer patches that have no base; and treat decode or apply failure as a reason to mark the block stale and refetch, never as a reason to leave it interactive. Section 9 gives a checklist, a decision table, and a recommended regression test.

Related Zylos articles cover neighboring ground: the [protocol layers of agent frontends](/research/2026-05-03-agent-frontend-streaming-protocols-ag-ui-convergence), [user intent that must survive realtime guards](/research/2026-07-27-durable-user-intent-realtime-agent-uis), and [commitment boundaries for retries](/research/2026-09-08-streaming-agent-safe-retry-boundaries). This one is narrower: what the client does with a patch once it has arrived.

## 1. The failure, stated precisely

A block has an interactive phase and a terminal phase. In the interactive phase the UI offers actions (choose an option, submit, approve). In the terminal phase it should render a read-only summary. The invariant that matters to users is:

> Once the server considers a block resolved, no client path may re-enter the interactive phase for that block, and no client path may keep it there indefinitely.

The second half is the one that gets lost. Clients are usually tested for "do not regress", rarely for "do not stall". A dropped patch causes a stall, not a regression: the client simply never learns. The table below names the four mechanisms; each maps to a section.

| Mechanism | Symptom | Why it is quiet | Section |
|---|---|---|---|
| Key collision | Resolving one message's prompt resolves (or overwrites) another's; local UI state leaks between prompts | No error, or a dev-only console warning | 2 |
| Patch dropped by decoder or path error | Block stays pending after the server resolved it | Error is caught and logged; the reference AG-UI client returns "no update" | 3 |
| Version gate skip | Sync completes, block still pending | Sync succeeded; the row was just judged "not newer" | 4 |
| Ordering regress | Block flickers back to pending, or stays there after reconnect | Both inputs were individually valid | 5 |

## 2. Block identity: where the id is unique matters

### What the protocols actually scope

Several widely used streaming formats identify content by position or id within one message or response, not globally. Verified against primary sources:

- **Anthropic Messages streaming.** Each content block "has an `index` that corresponds to its index in the final Message content array", with `content_block_start`, one or more `content_block_delta`, and `content_block_stop` events. The index is a position in one message. Two messages both have a block 0. [Anthropic streaming docs]
- **OpenAI Responses streaming.** Events such as `response.output_item.added` carry an `output_index` ("The index of the output item that was added") and a `sequence_number` ("The sequence number of this event"), per the SDK types generated from the API spec. These are scoped to one response. [openai-python types]
- **Vercel AI SDK data parts.** A data part written with an `id` is reconciled: "When you write to a data part with the same ID, the client automatically reconciles and updates that part." In the client source, the lookup is `state.message.parts.find(...)` on matching `type` and `id`, so reconciliation is scoped to the message being assembled. On a match the code assigns `existingUIPart.data = dataChunk.data`: the data object is replaced, not deep-merged. Without an `id`, the part is appended. [Vercel AI SDK docs and source]
- **AG-UI activity messages.** An activity message "occupies the same id space as every other message, so its `messageId` must not be reused by a text or reasoning message". Here the id is message-scoped by construction, and the spec even defines what a client does on a cross-type collision: leave the activity message untouched. [AG-UI events]

None of this is a flaw. A per-message index is exactly right while a message is being streamed. The trap is that the client then adopts the same per-message id as its long-lived storage key. In a transcript with hundreds of messages, `b1` is not an identity.

### UI frameworks assume uniqueness within a list

- **React**: "Keys must be unique among siblings. However, it's okay to use the same keys for JSX nodes in different arrays." Keys must also not change. [React docs]
- **Jetpack Compose lazy lists**: provide "a stable and unique key for each item"; remembered state then moves with the item when positions change. The key type must be Bundle-saveable. [Android docs]
- **SwiftUI**: `ForEach` identifies rows through `Identifiable` or an explicit `id` key path. I did not find a sentence in the pages I read specifying behavior on duplicate ids, so what duplicate ids cause there is not verified here. Treat it as undefined and avoid it.

"Same key in different arrays is fine" is the subtle part. A transcript rendered as a flat virtualized list of blocks is one array. A transcript rendered as a list of messages, each rendering its own blocks, is many arrays and `b1` is legal inside each. The collision then appears at the next layer: a store, a memoization map, a focus tracker, an analytics or "already answered" cache keyed by block id.

### What the collision does (experiment, section 8)

Two messages, each with a first block `b1`, both pending:

- A store keyed by `blockId` ends with one entry out of two inserted. Resolving `m1/b1` yields `{"messageId":"m2","id":"b1","status":"resolved","via":"m1"}`. The surviving record is message 2's prompt, marked resolved because of message 1.
- In React (18.3.1, `react-test-renderer`), a component with local `clicked` state, keyed `b1`, was clicked while showing `m1/b1`. When the list window moved so that `m2/b1` rendered under the same key, React reused the instance. The output was `m2/b1:ANSWERED`: a prompt that was never answered, rendered as answered, because it inherited local state. With the key `messageId/blockId`, the result was `m2/b1:open`.
- Rendering both blocks in one array under key `b1` produced React's duplicate-key warning. The warning is emitted at development time; do not rely on it in production builds.

The reverse direction also hurts: the stale clickable option. If the resolved status lands on the wrong record, the correct record never receives it.

### Recommendation

Either make block ids globally unique at the source (a UUID or `msgId:blockId` generated server-side), or define the identity as a tuple and use the tuple at every layer: store, patch routing, list keys, test ids, analytics. If a string is needed, use an unambiguous encoding such as a JSON array or a length-prefixed pair rather than `a/b` joined with a separator that ids may contain (inferred best practice). Include the conversation id in the tuple if the client can show more than one conversation at a time. Patches must carry the full tuple. A patch addressed only to `b1` is unroutable in a scoped system, and a client should treat it as an error rather than guess.

## 3. Patch semantics and the traps that are specific to blocks

### RFC 7396 JSON Merge Patch

The processing rule in the RFC is short enough to reproduce: if the patch is an object, recurse member by member; a `null` member deletes the target member; anything that is not an object replaces the target outright. Consequences the RFC states itself:

- "it is not possible to patch part of a target that is not an object, such as to replace just some of the values in an array." An `options` array in a patch replaces the whole array.
- The format is suitable for documents "that primarily use objects for their structure and do not make use of explicit null values."

For interactive blocks the second sentence is the bite. A block whose state includes `selected: null` ("nothing selected yet") cannot be expressed: patching `{"state":{"selected":null}}` removes the key. In the experiment the key was absent afterwards. A client that distinguishes "absent" from "null" (a typed decoder with an optional vs a nullable field) can then behave differently from the server model.

The first sentence matters for multi-step edits: a patch that updates one option's label must resend the entire array, including the option the user already highlighted. Two concurrent patches to the same array are last-writer-wins on the whole array.

### Deep-merge libraries are not merge patch

A common shortcut is to deep-merge the incoming object into local state. Real output from `lodash@4.17.21` `merge`:

- Arrays merge by index. Merging `{options:[{b,"Cancel (new)"}]}` into `{options:[{a,"Deploy"},{b,"Cancel"}]}` gave `[{"id":"b","label":"Cancel (new)"},{"id":"b","label":"Cancel"}]`: position 0 was overwritten, so `a` vanished and `b` appeared twice.
- `null` assigns `null` rather than deleting; `undefined` is skipped. When a server serializes absent fields as JSON, `undefined` never reaches the wire anyway, so "clear this field" has no representation.

So "deep merge" and "RFC 7396" behave differently on both arrays and null. A client and server that each believe they speak "merge patch" with different implementations will diverge exactly on options lists and cleared fields. Spell out the semantics in the protocol, not in the library choice.

### RFC 6902 JSON Patch

JSON Patch addresses locations by JSON Pointer, so it can modify one array element (`/options/1/label`) and express `null` values. Its traps are different:

- `replace` and `remove` require the target to exist: "The target location MUST exist for the operation to be successful."
- Error handling is atomic: if an operation fails, "application of the entire patch document SHALL NOT be deemed successful."
- Array indices are positional. Concurrent patches that insert or remove elements shift the indices another patch was authored against. The RFC offers a `test` operation to guard on a value; indices need that or a stable id (inferred).

The AG-UI documentation describes its reference client behavior as applying deltas with `fast-json-patch`, atomically, and on failure "emitNoUpdate" after a warning. [AG-UI state docs] In the experiment, patch `[replace /b1/status "resolved", replace /b1/state/answer "a"]` against a document whose `state` had no `answer` threw `OPERATION_PATH_UNRESOLVABLE`, and the document stayed `{"b1":{"status":"pending","state":{}}}`. The status change, which was valid on its own, was lost with the failing operation. Using `add` for the second operation applied both. The lesson for the sender: pick `add` for fields that may not exist yet, because `add` on an object member creates or replaces.

### Schema drift: scalar on the client, array on the server

This is the quiet one. The server upgrades a prompt from single-select (`answer: "a"`) to multi-select (`answer: ["a","b"]`) for some messages. An older client has a decoder that says `answer` is a string. The patch `{status:"resolved", state:{answer:["a","b"]}}` fails decoding. If that failure is caught and logged, as the AG-UI reference does with its apply errors, the client keeps `{"status":"pending"}` and the options stay clickable. In the experiment the decoder threw `state.answer must be string` and the UI state remained pending.

Note that the status change in the same patch was perfectly decodable. The harm comes from coupling "status moved to resolved" to "every other field in the same patch decoded". Mitigations, in order of cheapness:

1. **Decode leniently on the terminal transition.** Apply `status` (and any field the UI needs for rendering a read-only state) independently of optional payload fields. Unknown or mistyped payload goes to a "raw" slot for display or diagnostics.
2. **Fail closed.** If a patch for a block cannot be applied, mark that block `stale` and disable its actions until a snapshot confirms its state. A disabled prompt costs a refresh; an enabled resolved prompt costs a duplicate action or a confusing error.
3. **Version the schema.** Send `schemaVersion` or capability flags so the server can avoid sending shapes the client cannot decode. Replicache's pull request carries a developer-defined `schemaVersion` for this purpose, so that the client "can correctly handle the data". [Replicache pull reference]
4. **Count the failures.** A decode-failure counter per block type turns silent drift into an alert.

## 4. Version gates: "only if newer" requires the server to say what newer means

A common sync rule is to replace local state with the snapshot row only if `row.rev > local.rev`. It is a sound rule if and only if every mutation of the entity increments `rev`. If the server updates a block's status through a code path that bumps a change-sequence or `updated_at` but not `rev`, the gate evaluates `3 > 3`, returns "not newer", and keeps the stale local row. The experiment reproduced this: a row at `rev 3` changed from `pending` to `resolved` with `changeSeq` moving from 10 to 11, and the rev-gated client kept `pending`.

Replicache's documentation states the needed discipline for its row-version backend strategy: each domain entity has a `version` field that is "Incremented each time this row is updated." It suggests Postgres's per-row `xmin` as one source of that number. [Replicache row version strategy] The document does not say anything about what a client should do if some writer forgets; the point is that the gate is only as good as the guarantee behind it.

| Option | What it gives | Cost or trap |
|---|---|---|
| Monotonic per-entity `version` incremented on every mutation | Cheap local compare; works per row | Every writer path must bump it. Enforce in the data layer (trigger or single write function), not in call sites |
| Global or per-space change sequence ("cursor") | Total order over changes; supports "give me everything after N" | Entity-level compare needs the entity's last-change sequence stored on the row |
| Content hash | Detects any difference, including missed bumps | No ordering: cannot tell old from new. Good as a repair check, bad as a gate. Experiment: hashes differed (`true`), which says "something changed", not which side is newer |
| Last-writer-wins by server timestamp | Simple; needs no counters | Resolution and clock skew; ties; two writes in the same tick. Server-assigned time only, never client time |
| Always replace from snapshot, no gate | Cannot skip a change | Can regress state if the snapshot is older than a live patch (section 5) |

My recommendation is to have the server derive the version from the database rather than rely on call-site discipline, and to carry a change-sequence cursor in snapshots so ordering can fall back on it. Where the version is untrusted, make the client gate `>` on the version but also compare a content digest on equal versions and refetch the row on mismatch, as a repair path (inferred design). This is cheap and catches the precise bug above.

A terminal-state shortcut is also worth adding. Interactive status is a small monotone progression (`pending` to `resolved` or `cancelled`). If the incoming row says terminal and the local row says pending, accept it regardless of version comparison unless the sequence says it is older than a known newer local terminal state. That makes the invariant from section 1 hold even if some version field is broken (inferred; resembles a state-based CRDT whose merge is a join over a lattice, see Shapiro et al.). Do not apply this to fields that legitimately move back and forth.

## 5. Ordering between the live stream and a snapshot

Two sources feed the same state:

- **Live**: patches, with some sequence.
- **Snapshot**: a fetched copy, taken at some moment, delivered after some latency.

Orderings that occur in practice:

| Arrival | Naive "replace on snapshot" | Required behavior |
|---|---|---|
| Patch first, then the snapshot it logically follows | Patch applied to nothing, lost or errors | Buffer the patch until a base exists, then replay in sequence order |
| Patch seq 11 applied, then a snapshot read at seq 10 | Regress to pending | Ignore rows whose sequence is not newer than local |
| Snapshot first, then replayed patches (reconnect) | Replays reapply old operations | Drop patches with `seq <= local.seq` |
| Duplicate delivery of the same patch | `add` or array patches double-apply | Idempotent by sequence |
| Gap (seq 11, then 14) | Missing 12 and 13 silently | Detect the gap and refetch |

AG-UI documents the shape of the problem and a coarse solution: snapshots are for the start of an interaction, after connection interruptions, and to establish a new baseline; "Frontends should replace their existing state model with the contents of this snapshot rather than trying to merge it with previous state"; deltas are applied "in sequence", and on inconsistency "the frontend may request a fresh `StateSnapshot`". [AG-UI events and state docs] That is correct when the snapshot is guaranteed to be the freshest view at the moment it is applied. It does not say what happens if an older snapshot arrives after a newer delta, because the protocol is a single ordered stream. In a client that also fetches snapshots over a separate HTTP call, that guarantee is gone, and applying the wholesale-replace rule to a late response is my inference of where the protocol's assumption would be violated, not a documented AG-UI behavior. The AG-UI `ActivitySnapshot` event does include a `replace` flag (default true; when false the snapshot is ignored if the message already exists), which is a protocol-level admission that "snapshot over existing state" is a decision, not a given.

Other systems answer the ordering question with explicit cursors. In Replicache, the pull request carries the `cookie` returned by the previous pull, and for its row-version strategy the server keeps an ordered `cvrVersion` per client group because "Replicache requires that cookies are ordered within a client group." Push mutations are checked against `lastMutationID`: already-processed mutations are skipped and mutations from the future are an error. [Replicache reset and row-version strategies] The relevant idea for chat UIs is not the whole sync engine but those two moves: an ordered cursor, and an idempotent skip of what has already been applied.

The experiment's store follows the same shape. Rows hold `{value, seq}` per composite key; `applyPatch` drops `seq <= local.seq` and buffers if there is no base; `applySnapshot` accepts a row only if its `seq` is newer, then drains buffered patches for that key. The log for the adversarial order (patch 11, snapshot 10, patch 11 replay, snapshot 10 duplicate) ended with `{"seq":11,"status":"resolved"}`.

A snapshot should also say what it is a snapshot as of. A single `asOfCursor` on the response, plus per-row sequences, lets the client reason about patches both older and newer than the snapshot without comparing wall-clock time.

## 6. How real systems compare

| System | Block or part identity | Update primitive | Ordering evidence | What the client does with a snapshot |
|---|---|---|---|---|
| Anthropic Messages streaming | `index` within a message | start, delta, stop events per block | Event order within one stream | Not applicable; final message is the complete value |
| OpenAI Responses streaming | `output_index` (and item ids) within a response | `added`, delta, `done` events | `sequence_number` on events | Not applicable inside the stream; resume semantics are provider specific and not verified here |
| Vercel AI SDK data parts | `type` plus `id` within a message | Same id replaces `data` wholesale | Arrival order | UI messages can be passed back in whole; no cross-fetch version gate in the code I read |
| AG-UI | Message id; activity `messageId` | `STATE_DELTA` and `ActivityDelta` as RFC 6902 | Stream order; no sequence field in the events I read | `STATE_SNAPSHOT` replaces; `MessagesSnapshot` is all-or-nothing per role for `activity` and `reasoning` |
| Replicache | Key in a key-value space | Server computes a diff from a cookie | Ordered cookie, `lastMutationID` | Reset or patch response; reset is an allowed strategy |

Observations that are verified from the sources above: all four streaming formats scope their per-block index or id to a message or response; only Vercel and AG-UI have an explicit "update an existing part" primitive, and Vercel's is replace-by-id, not merge; only the sync-engine style (Replicache) puts an ordered cursor and idempotence rules at the center. Inference: a chat client that combines a streaming protocol with a separate sync fetch is in the position of building the second kind of system out of the first kind of messages, and has to add the cursor itself.

I did not verify the internals of other sync engines (for example Linear's) against primary documentation, so I make no claims about them. CRDT-lite ideas are covered in the next section as a design option, not as what any named product does.

## 7. A cheap, CRDT-flavored core for blocks

A full CRDT is unnecessary for blocks that have one authoritative writer (the server). Three small ideas from the literature on convergent replicated types carry most of the value [Shapiro et al.]:

1. **Per-entity sequence as a version vector of one.** `seq` is assigned by the server on every mutation of that entity. Merge is `max` by `seq`. Patches and snapshot rows are the same kind of thing: "state at seq n".
2. **Monotone status lattice.** `pending` is below `resolved` and `cancelled`; terminal states are absorbing. A merge that takes the join can never resurrect an interactive prompt. If two terminal states conflict (answered on one device, cancelled on another), the server's single writer order decides and the client should not break the tie.
3. **Tombstones.** If blocks can be removed, keep a tombstone with a sequence, or a snapshot "as of N" that lacks the block will resurrect it when merged with an older local copy (inferred).

With those, the merge function over `(local, incoming)` is: ignore if `incoming.seq <= local.seq`; otherwise apply. The status lattice is a safety net for the case where sequence assignment itself is broken, and a signal worth logging when it fires.

## 8. Local experiment: the pitfalls, run for real

The script (about 135 lines, Node 24, `fast-json-patch@3.1.1`, `lodash@4.17.21`, `react@18.3.1`, `react-test-renderer@18.3.1`) transcribes the RFC 7396 algorithm and implements a small store. Key lines of output, unedited except for truncating one React warning string:

```text
=== 1. Merge patch traps ===
nested-only patch   : ..."state":{"selected":"a","note":"x"}}        # nested change preserved siblings
array patch         : ..."options":[{"id":"a","label":"Deploy (edited)"}],...   # array replaced wholesale, option b gone
null deletes field  : ..."state":{"note":"x"}}
  -> "selected" key present after patch? false

=== 2. Message-scoped ids: store keyed by blockId vs (messageId, blockId) ===
flat store size     : 1 (2 blocks went in)
flat: resolve m1/b1 => {"messageId":"m2","id":"b1","status":"resolved","via":"m1"}
composite           : m1/b1=resolved, m2/b1=pending

=== 3. React keying ===
3a before            : [ 'm1/b1:ANSWERED' ]
3a key=blockId, now showing m2 : [ 'm2/b1:ANSWERED' ]  <- m2 prompt inherits m1 local state
3a key=composite, now showing m2: [ 'm2/b1:open' ]
3b duplicate-key warning emitted: true | Warning: Encountered two children with the same key ... key=b1

=== 4. Scalar-vs-array drift and all-or-nothing patches ===
decoder threw, patch dropped silently: state.answer must be string
UI still shows      : {"id":"b1","status":"pending","state":{}}  <- status still pending => options remain clickable
applyPatch threw: OPERATION_PATH_UNRESOLVABLE - Cannot perform the operation at a path that does not exist
doc after failed patch (mutateDocument=false): {"b1":{"status":"pending","state":{}}}
using add instead of replace                  : {"b1":{"status":"resolved","state":{"answer":"a"}}}

=== 5. Version gates ===
rev-gated sync      : pending (server says resolved) <- STALE
changeSeq-gated     : resolved
content-hash differs: true (detects change, but gives NO order: cannot tell old from new)

=== 6. Stream/snapshot ordering with per-entity seq ===
patch m2/b1@11 buffered (no base)
snap m2/b1@10 applied
patch m2/b1@11 applied
patch m2/b1@11 ignored (local @11)
snap m2/b1@10 ignored (local @11)
patch m1/b1@5 buffered (no base)
final m2/b1 = {"m":"m2","b":"b1","seq":11,"status":"resolved"}
```

Separately, `lodash.merge` on `options` arrays produced `[{"id":"b","label":"Cancel (new)"},{"id":"b","label":"Cancel"}]`, and `merge({state:{selected:'a'}}, {state:{selected:null}})` gave `selected: null` while `undefined` left `'a'` unchanged.

What the experiment does not show: real browser rendering, concurrent editors, or an actual server. The version-gate and ordering sections use hand-built fixtures; they demonstrate the logic, not field frequency. The React result is for the 18.3.1 test renderer on a minimal component; reordering behavior in virtualized lists in other frameworks has different mechanics (Compose and SwiftUI were not run).

## 9. Checklist, decision table, and the regression test

### Checklist for agent-UI builders

1. Decide the identity of a block: globally unique id, or a tuple. Write it down and use it in the store, the patch router, the list key, and the test selectors.
2. Reject, do not guess, patches that lack the full identity.
3. Name the patch format and its null/array rules in the protocol. Do not let a library's `merge` define them.
4. Prefer replacing a small block wholesale (`id`-addressed, as Vercel data parts do) over fine-grained patches into arrays, unless you have stable ids on array elements.
5. When using RFC 6902, use `add` for optional fields, `test` as a guard when ordering matters, and address array elements by id, not index, where the format allows.
6. Make the terminal transition independent of optional payload decoding.
7. On any decode or apply failure: mark the block stale, disable its actions, and trigger a targeted refetch. Never swallow silently.
8. Give every entity a server-assigned monotonic `seq` that increments on every mutation, enforced in the data layer. Gate both patches and snapshot rows on `seq`.
9. Buffer patches without a base; drain on snapshot; detect gaps and refetch.
10. Snapshots carry an `asOfCursor`. Never let a snapshot with an older cursor than local overwrite newer rows.
11. Make terminal status absorbing in the client merge, and log when the lattice rescues a bad version.
12. Count decode failures, skipped-as-stale rows, buffered patches, and gap refetches per block type.

### Decision table

| Situation | Preferred approach | Avoid |
|---|---|---|
| Block ids are per-message | Composite key everywhere, or server-generated global id | `Map` or React `key` on bare block id |
| Small block, few fields | Replace the block by id; whole-block sequence | Deep-merge into arrays |
| Large state, frequent small edits | RFC 6902 with `test` guards and stable-id addressing | Positional indices across concurrent patches |
| Server may change field types | `schemaVersion` plus lenient terminal decode | Strict decode that discards the whole patch |
| Server writer paths are many | Version derived in the DB layer; cursor in snapshots | Call-site bumping of `rev` |
| Live stream plus separate fetch | Per-entity `seq`, apply-if-newer, buffer | "Last arrival wins" |
| Cross-device resolution | Server-authoritative terminal state, absorbing in client | Client timestamps for ties |

### The recommended test (small, fast, catches all four)

Build the fixture once and run it against whatever merge layer you use:

1. **Two messages, same block id.** Seed `m1/b1` and `m2/b1`, both pending. Send a patch that resolves `m1/b1`. Assert `m2/b1` is still pending and the UI instance for `m2/b1` has no local state from `m1/b1`.
2. **Nested-only patch.** Patch only `state.selected` (or the equivalent). Assert the block's `options` array and `status` are untouched, and that clearing a field is represented the way your protocol defines it.
3. **Array-typed field where a scalar is declared.** Send `answer: ["a","b"]` where the client expects a string, plus `status: "resolved"`. Assert the block is not interactive afterwards: either rendered resolved, or marked stale with actions disabled and a refetch scheduled.
4. **Silent server update.** Change a row's status on the server through every code path that can do it. Sync. Assert the client shows the new status, with whichever field your gate uses.
5. **Order permutations.** Take a log of `[snapshot@10, patch@11]` and run all interleavings, plus duplicates and a replay. Assert the final state is identical in every case.

Test 4 is the one most often missing, because it needs a server-side test that enumerates writers. Treat it as an invariant check on the data layer, not a UI test.

## Limits and applicability

The provider and protocol statements above were checked against current documentation or source at the commits and pages listed in the sources, and may change. AG-UI's event set is evolving; I read the concept docs, not the full schema, and I did not find a sequence field on state events in those pages, which is not a proof that none exists elsewhere in the SDK. SwiftUI duplicate-id behavior was not verified. Nothing here describes how any specific vendor's backend assigns versions; section 4 and 7 are design recommendations, marked inferred where they extend beyond what a source states. The experiment is a minimal model: it shows that each pitfall is real and that each mitigation fixes its pitfall in isolation, not that the combination is sufficient in a production client with offline edits or multiple writers per block.

## Sources

- RFC 7396, JSON Merge Patch: https://www.rfc-editor.org/rfc/rfc7396.html
- RFC 6902, JSON Patch (sections on `replace`, `test`, error handling): https://www.rfc-editor.org/rfc/rfc6902.html
- AG-UI protocol, Events concept page (StateSnapshot, StateDelta, MessagesSnapshot, ActivitySnapshot, ActivityDelta), file last changed in commit `92c8a0b` on 2026-08-28: https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/concepts/events.mdx
- AG-UI protocol, State Management concept page (fast-json-patch application, atomic apply, error handling): https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/concepts/state.mdx
- Vercel AI SDK, streaming custom data and data part reconciliation docs: https://github.com/vercel/ai/blob/main/content/docs/04-ai-sdk-ui/20-streaming-data.mdx
- Vercel AI SDK, `process-ui-message-stream.ts` (data part lookup by type and id within `state.message.parts`; `data` replaced wholesale), `main` at commit `17b6923`: https://github.com/vercel/ai/blob/main/packages/ai/src/ui/process-ui-message-stream.ts
- Anthropic, Messages streaming (content block `index`, start, delta, stop events): https://docs.anthropic.com/en/docs/build-with-claude/streaming
- OpenAI Python SDK, `ResponseOutputItemAddedEvent` type (`output_index`, `sequence_number`), file at commit `f38355e`: https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_output_item_added_event.py
- Replicache docs, Reset strategy (`lastMutationID`, skip processed mutations, cookie): https://doc.replicache.dev/strategies/reset
- Replicache docs, Row Version strategy (per-row `version` incremented on each update, ordered cvrVersion): https://doc.replicache.dev/strategies/row-version
- Replicache docs, Pull endpoint reference (`cookie`, `schemaVersion`): https://doc.replicache.dev/reference/server-pull
- React docs, Rendering lists (key rules): https://react.dev/learn/rendering-lists
- Android Developers, Lists and grids in Compose (stable and unique keys): https://developer.android.com/develop/ui/compose/lists
- Apple, SwiftUI `ForEach` documentation: https://developer.apple.com/documentation/swiftui/foreach
- Shapiro, Preguica, Baquero, Zawirski, "A comprehensive study of Convergent and Commutative Replicated Data Types", Inria RR-7506: https://inria.hal.science/inria-00555588
- Local experiment: Node 24.22.1 with `fast-json-patch@3.1.1`, `lodash@4.17.21`, `react@18.3.1`, `react-test-renderer@18.3.1`, run 2026-11-04.
