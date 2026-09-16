---
date: "2026-09-16"
title: "Pagination Consistency for AI Agent Scans"
description: "Why reaching the last API page does not prove a complete inventory, and how agent adapters can preserve scope, snapshot semantics, and honest completion status."
tags: ["ai-agents", "api-design", "pagination", "data-consistency", "reliability"]
---

## Executive Summary

An agent asked to inspect every open task can successfully fetch every page and still miss tasks. If the underlying collection changes between requests, an offset may shift, a sort key may move behind the cursor, or an unseen record may disappear. Deduplicating the results repairs repeated identities; it cannot recover an identity that was never returned.

Pagination has two separate contracts: how to advance, and which version of the collection is being traversed. Opaque tokens address the first without necessarily guaranteeing the second. This research compares documented API contracts and develops a proposed adapter policy for Zylos-like systems: preserve the query scope, follow the provider's termination rule, checkpoint accepted data with its continuation, and report traversal completion separately from snapshot completeness. A local SQLite exercise demonstrates four failure boundaries; it is not a live test of the cited services.

## Start with the claim the agent must support

Consider a request: “Review every open task and tell me which ones have no owner.” The adapter reads two tasks at a time. Before the second request, another worker closes an earlier task. The server returns a valid second page, followed eventually by an end marker. The agent announces that every task has been checked.

That conclusion needs a definition of “every.” There are several possible reader expectations:

| Intended result | Required evidence |
|---|---|
| Tasks encountered during a live traversal | Valid pages and the provider's end marker, with the scan interval disclosed |
| All matching tasks at a particular snapshot | An explicit snapshot contract, unchanged query scope, and successful traversal within its lifetime |
| Current state maintained after initialization | A baseline plus a provider-supported change stream or delta protocol with documented gap handling |

The third is a separate synchronization problem. This article focuses on the first two. A snapshot also remains scoped to the endpoint, filters, and authorized view: it is not proof of organization-wide visibility. When a later action depends on current state, re-read or conditionally update the target according to that API's contract.

## Separate order from visibility

Offset pagination asks the server to skip a number of rows in the current result. If a row before that position disappears, the remaining rows shift left. A later offset can jump over an unseen row. Inserting a row before the offset can instead repeat a previously returned row. Even without concurrent changes, deterministic ordering matters: PostgreSQL documents that `LIMIT` and `OFFSET` require an ordering that constrains the result to a unique order, and that large offsets still require the server to compute skipped rows. [PostgreSQL LIMIT and OFFSET](https://www.postgresql.org/docs/current/queries-limit.html)

Keyset pagination expresses a position using ordered values, for example:

```sql
SELECT id, created_at
FROM tasks
WHERE (created_at, id) > (:last_created_at, :last_id)
ORDER BY created_at, id
LIMIT :page_size;
```

The unique tie-breaker matters when timestamps collide. This is an illustrative query, assuming non-null fields and consistent comparison rules. The index, field types, sort direction, and null handling must match the actual schema.

Keyset traversal avoids the positional shift in the deletion example, but it does not freeze membership or values. A task sorted by mutable priority can move behind the saved position before it is read. A task can stop matching `status = 'open'`. Even an immutable increasing ID cannot return an unseen row deleted before the next request. These are consequences of reading a changing collection, not malformed cursor handling.

A captured upper bound such as `id <= initial_max_id` can exclude later larger IDs. It is not a snapshot: it does not preserve deleted rows, earlier field values, or membership in a mutable filter. Late insertion of smaller keys also needs an explicit model. Use a high watermark only for the narrower guarantee its data model supports.

## Read the provider's actual continuation contract

The following are documentation findings, not claims that all endpoints from these vendors behave identically.

**Google AIP-158 describes pagination conventions.** A page may contain fewer items than requested, including zero, before the end. Its end signal is an empty `next_page_token`. Tokens are opaque; parameters other than page size are expected to remain unchanged across continuation requests. The guidance also separates tokens from authorization and allows expiration. This is an API design guide, not evidence that an arbitrary API implements snapshot isolation. [AIP-158](https://google.aip.dev/158)

**Microsoft Graph returns continuation URLs.** Its paging guide instructs clients to use the complete `@odata.nextLink`, rather than extract and transplant a skip token. It also warns that paging behavior varies between APIs, and that custom request headers may need to be supplied again on subsequent directory-resource requests. An adapter must preserve the documented request context as well as the URL. These traversal rules alone do not establish a snapshot guarantee. [Microsoft Graph paging](https://learn.microsoft.com/en-us/graph/paging)

**Kubernetes explicitly documents a snapshot for chunked lists.** The collection's `resourceVersion` stays consistent across the continuation sequence; changes after that version do not alter the snapshot being listed. Continuation tokens expire, and an unavailable continuation can produce `410 Gone`. For a report requiring one coherent snapshot, restart enumeration instead of silently concatenating an old prefix with a new list. A completed list covers the requested resource collection and selectors, not a simultaneous snapshot across unrelated APIs. [Kubernetes API concepts: retrieving large result sets](https://kubernetes.io/docs/reference/using-api/api-concepts/#retrieving-large-results-sets-in-chunks)

**Elasticsearch distinguishes position from preserved search state.** Its documentation warns that refreshes between `search_after` requests can change ordering. A point in time (PIT) preserves index state across searches. It also documents tie-breakers and using the latest returned PIT identifier for subsequent requests. This makes the distinction concrete: sort values advance through results, while PIT supplies the preserved view. Search failures or partial shard results still need checking before a client claims success. [Elasticsearch pagination](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/paginate-search-results)

Opaque continuation, stable ordering, and snapshot visibility are therefore separate properties. An adapter should record which ones its endpoint actually promises.

## A proposed scan protocol for agent adapters

The following is engineering synthesis for discussion, not a description of an implemented Zylos feature.

Give each scan an identity and a fixed scope: provider, API version, resource collection, filter, ordering, and authorized principal or tenant. Store the continuation token outside the model's editable prose. Use documented continuation URLs intact, with destination validation appropriate to the provider before attaching credentials; token opacity does not authorize arbitrary destinations.

Separate machine-speed enumeration from model analysis. First validate and persist bounded pages to a staging dataset; then let the model inspect the staged result. This reduces the chance that model reasoning pauses exhaust a short snapshot lifetime. It does not remove the need for page, byte, storage, and elapsed-time budgets. A budget stop produces an incomplete scan, not an empty answer.

Checkpoint each accepted page and its *next* continuation together in a local transaction where possible. If they cannot commit atomically, persist the page before advancing progress and make replay safe. Saving the next cursor first risks permanent omissions after a crash. Replaying a page requires a deliberate conflict rule: repeated identity can mean a duplicate delivery, a newer version, or an inconsistent live view. An upsert policy must not quietly relabel mixed-time data as one snapshot.

Keep completion and consistency separate in the result:

```json
{
  "traversal": "finished",
  "consistency": "live",
  "snapshot_ref": null,
  "scope_ref": "saved-query-7",
  "pages_accepted": 4,
  "unique_items": 7,
  "stop_reason": "provider_end_marker"
}
```

This is an illustrative result, not experimental output. `finished/live` says the documented traversal ended, while making no point-in-time completeness claim. An expired token, parser failure, repeated continuation, authorization failure, or exhausted budget should instead produce an explicit interrupted or failed outcome. A valid snapshot reference plus successful termination supports `finished/snapshot` only if the provider's full contract and response checks remain satisfied.

On snapshot expiration, start a new scan identity and keep prior staging data distinguishable. Do not merge two generations and describe their union as a single snapshot. A best-effort union may be useful for discovery, but it requires its own stated semantics. For live scans, reaching the end still cannot establish that no relevant item existed during the entire scan interval.

Finally, enumeration completion does not guarantee exactly-once downstream actions. If pages trigger messages or mutations, those effects need their own idempotency and reconciliation rules. Prefer deciding from a completed staged dataset when the task requires a whole-set comparison.

## Reproduce the failure boundaries locally

Run the following with Python 3 and its standard-library SQLite module. Each scenario starts with IDs 1 through 6. The experiment deliberately changes data between queries; it does not benchmark a database or emulate vendor token implementations. The frozen Python list represents a fully materialized ID set, not a claim about SQLite transaction isolation or a snapshot of every row field.

```python
import sqlite3


def database():
    db = sqlite3.connect(':memory:')
    db.execute('CREATE TABLE items(id INTEGER PRIMARY KEY, rank INTEGER)')
    db.executemany('INSERT INTO items VALUES (?, ?)', [(i, i) for i in range(1, 7)])
    return db


def ids(db, sql, args=()):
    return [r[0] for r in db.execute(sql, args)]


baseline = list(range(1, 7))
db = database()
first = ids(db, 'SELECT id FROM items ORDER BY id LIMIT 2')
db.execute('DELETE FROM items WHERE id=1')
offset = first + ids(db, 'SELECT id FROM items ORDER BY id LIMIT -1 OFFSET 2')
keyset = first + ids(db, 'SELECT id FROM items WHERE id>? ORDER BY id', (2,))
assert offset == [1, 2, 4, 5, 6] and keyset == baseline
print('deleted prefix: offset=', offset, 'keyset=', keyset)

db = database()
first = ids(db, 'SELECT id FROM items ORDER BY rank,id LIMIT 2')
db.execute('UPDATE items SET rank=0 WHERE id=5')
mutable = first + ids(db, 'SELECT id FROM items WHERE (rank,id)>(?,?) ORDER BY rank,id', (2, 2))
assert mutable == [1, 2, 3, 4, 6]
print('unseen row moves behind cursor: missing=', sorted(set(baseline)-set(mutable)))

db = database()
snapshot = ids(db, 'SELECT id FROM items ORDER BY id')
first = snapshot[:2]
high = max(snapshot)
db.execute('DELETE FROM items WHERE id=5')
db.execute('INSERT INTO items VALUES (7,7)')
bounded = first + ids(db, 'SELECT id FROM items WHERE id>? AND id<=? ORDER BY id', (2, high))
frozen = first + snapshot[2:]
assert bounded == [1, 2, 3, 4, 6] and frozen == baseline
print('high watermark with deletion:', bounded, 'materialized snapshot:', frozen)

pages = {None: ([1, 2], 'a'), 'a': ([], 'b'), 'b': ([3], None)}
cursor, seen = None, []
while True:
    values, cursor = pages[cursor]
    seen.extend(values)
    if cursor is None:
        break
assert seen == [1, 2, 3]
print('empty intermediate page: terminal-token scan=', seen)
print('PASS: four discriminating scenarios')
```

Observed locally on the research date:

```text
deleted prefix: offset= [1, 2, 4, 5, 6] keyset= [1, 2, 3, 4, 5, 6]
unseen row moves behind cursor: missing= [5]
high watermark with deletion: [1, 2, 3, 4, 6] materialized snapshot: [1, 2, 3, 4, 5, 6]
empty intermediate page: terminal-token scan= [1, 2, 3]
PASS: four discriminating scenarios
```

The first comparison exposes an offset failure that the keyset query avoids. The next two prevent overgeneralizing that success. The final case checks a client that follows continuation through an empty page; stopping on item count would lose ID 3. Whole-set comparisons expose missing identities even when every returned identity is unique.

Before using an adapter for exhaustive reports, extend the acceptance cases to timestamp ties, inserts before the cursor, mutable filters, token expiration, interrupted page persistence, repeated continuation, and changes in authorization. These are proposed follow-up tests; only the four scenarios above were executed for this article.

## Research scope and confidence

The topic was checked against the local research inventory and the fetched main-branch inventory. Recent work covered response-size limits and delivery watermarks, but not API pagination consistency as its central subject. This article concerns membership and visibility across reads, rather than message acknowledgment or payload truncation.

Research used a background Sonnet worker across ordering, provider contracts, and recovery design, with parent-session checks of the five linked primary sources and a local executable experiment. The official pages were consulted on 2026-09-16; this date describes the research, not a claim that the mechanisms were newly released. Documentation contracts and the local outputs have direct evidence. Their application to an agent adapter is a proposed design, and no Kubernetes, Graph, or Elasticsearch deployment was exercised.

The main open question for an implementation is endpoint-specific: does the provider preserve a snapshot, offer a bounded export or change feed, or only support best-effort live traversal? Answer that before allowing an agent to turn “no more pages” into “nothing was missed.”
