---
date: "2026-09-17"
title: "Conditional Writes for Agent Tools: Preserve Other Writers' Changes"
description: "Atomic revision checks, provider-specific preconditions, and a tested read-plan-write loop that prevents stale agent plans from overwriting concurrent changes."
tags:
  - research
  - ai-agents
  - concurrency
  - api-design
  - reliability
---

## Executive Summary

An agent reads a document, spends a minute preparing an edit, then saves it. During that minute, a person changes another field. Both requests succeed, but the agent's full-document write erases the person's update. Better reasoning cannot close this race: the resource owner must check the expected version and apply the mutation atomically.

Conditional writes provide that boundary. HTTP validators, Cloud Storage generation numbers, and Kubernetes resource versions expose related mechanisms with different contracts. They prevent an outdated write from silently succeeding; they do not decide how to reconcile the user's intent, authorize a revised plan, or resolve an unknown outcome after a timeout.

This article combines primary-source documentation with a small, executed SQLite experiment. The proposed agent loop is **read a coherent snapshot, derive a change, conditionally commit, and re-evaluate on conflict**. It is a design recommendation for agent platforms such as Zylos, not a claim about their current implementation. Provider behavior below was checked against documentation, not exercised against live cloud accounts.

## One edit, two writers

Consider a shared task record:

```json
{"title": "Draft", "owner": "A"}
```

Two writers read revision 1. The first changes the title to `Reviewed`. The second agent has been asked to assign the task to B and prepares a replacement containing `title: Draft, owner: B`. An unconditional replacement restores the obsolete title.

The second writer's intent was reasonable. Its replacement document was no longer valid. Reading again immediately before saving only shortens the interval in which another writer can intervene; it does not remove it. Even a local hash comparison is insufficient if the remote write happens afterward without an enforced condition.

Instead, the second write says: apply this replacement **only if the stored revision is still 1**. The storage operation observes revision 2 and rejects the mutation. The agent re-reads, reapplies the assignment to the new document, and conditionally saves revision 3 with both changes preserved.

This example uses a full replacement to expose the failure clearly. A narrow patch can avoid overwriting unrelated fields, but it still needs a condition when its meaning depends on a value read earlier. For example, changing a task from `ready` to `running` should not silently override a concurrent change to `cancelled`.

## Know exactly what the condition covers

HTTP `If-Match` compares a supplied entity tag against the current selected representation using **strong comparison**. Weak tags such as `W/"v1"` cannot satisfy an entity-tag match. `If-Match: *` checks existence, not equality to the version the agent read. `If-None-Match: *` supports create-if-absent writes; a failed condition on PUT produces 412. An unsuccessful `If-Match` normally also produces 412, with a narrowly defined success exception for a change already applied. Idempotent PUT semantics concern repeated identical requests; they do not protect a concurrent writer's update. These are distinct guarantees. [RFC 9110, §§9.2.2 and 13.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.1).

An API can require conditional requests and use **428 Precondition Required** when that requirement is unmet. This differs from **412 Precondition Failed**, where the supplied condition fails. The server should explain how to form an acceptable conditional request. [RFC 6585, §3](https://www.rfc-editor.org/rfc/rfc6585.html#section-3).

For a tool author, the main question is not whether a response contains an ETag. It is whether the mutation endpoint enforces a validator covering the state on which the plan depends. A validator for `/documents/A` is not automatically meaningful when sent to a different target such as `/documents/A/comments`. A custom tool can instead accept `expected_revision`, provided its server verifies that revision in the same transaction as the mutation.

Do not attach a freshly fetched version to an old body merely to make a conflict disappear. That converts a visible refusal into an authorized-looking overwrite of state the agent has not reconsidered.

## Three provider contracts worth keeping separate

### Amazon S3: object ETags and operation-specific failures

S3 documents conditional writes for operations including `PutObject` and `CompleteMultipartUpload`. A create-only write uses `If-None-Match: *`; an ETag match uses `If-Match`. For competing create-only writes, the first completion wins and subsequent writes fail with 412. Concurrent operations can also produce 409, while a concurrent deletion can make an `If-Match` write return 404. Multipart failure recovery depends on the operation: some races require starting a new upload. The condition is checked at completion; an upload in progress is not a reservation of the object name. [S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html).

Keep the ETag supplied by S3. It is not universally an MD5 digest: encryption and multipart-upload cases change that relationship. A tool should not reconstruct an ETag by hashing local bytes. [S3 integrity checks](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html).

The agent-level implication is to preserve structured error details. A deleted target may require a new user decision; translating every 404, 409 and 412 into an automatic re-upload can recreate something another actor intentionally removed.

### Google Cloud Storage: pair identity and metadata conditions

Cloud Storage offers `ifGenerationMatch` and `ifMetagenerationMatch`, with 412 on mismatch. For object requests, its guidance is to pair a metageneration condition with a generation condition so a metadata version cannot accidentally match a different object generation. `ifGenerationMatch=0` permits an object-data write only when there is no live object at that name. The documentation recommends generation/metageneration over ETags, and notes that XML API multipart uploads do not support these preconditions. [Cloud Storage request preconditions](https://cloud.google.com/storage/docs/request-preconditions).

This illustrates an important distinction for a generic connector: the version of some metadata and the identity of the object carrying it may be separate values. An adapter that keeps only one can lose a guarantee exposed by its provider.

### Kubernetes: updates, field tests, and object identity

Kubernetes PUT updates carry the observed `resourceVersion`; stale updates return 409. Conditional PATCH can also detect lost updates, and JSON Patch tests can guard particular values. Pass resource versions back unmodified. Current documentation permits ordering under specified same-resource-type conditions and includes a Kubernetes 1.35 conformance rule, with caveats for extension API servers. This article's update loop needs only equality, not ordering or arithmetic on tokens. [Kubernetes API concepts](https://kubernetes.io/docs/reference/using-api/api-concepts/#updates-to-existing-resources).

Kubernetes UIDs distinguish historical objects that reuse a name. If an agent's authorization refers to a particular object instance, retain and enforce that identity as well as freshness. [Object names and IDs](https://kubernetes.io/docs/concepts/overview/working-with-objects/names/).

More generally, equal content is not necessarily the same history. A representation can move from A to B and back to A. A content-based validator may suffice for an edit concerned only with the current representation; a workflow concerned with object incarnation or intervening transitions needs a stronger application contract. Do not infer historical identity from an ETag alone.

## A proposed tool boundary

The following contract is a design synthesis rather than a universal API standard:

```text
read(resource) -> snapshot, version, instance_identity

mutate(resource, expected_version, intended_change,
       expected_instance?, operation_id?)
  -> applied(new_version)
   | conflict
   | missing_precondition
   | target_missing_or_replaced
   | unknown_outcome
```

The read must return a snapshot and validator that describe the same state. A cached coherent snapshot may be stale, but an enforced conditional write can reject it. Mixing a cached body with an unrelated newer validator defeats that protection.

The storage boundary owns the atomic comparison. A client-side check followed by an unconditional remote write is not equivalent. Every writer must follow the versioning discipline: a maintenance script that updates the body without updating the revision can invalidate the scheme.

Use the narrowest condition that covers **all** facts relevant to the decision. A field-level test can reduce conflicts caused by unrelated edits, but checking only `owner` is insufficient if the assignment decision also depended on `status` and `capacity`. Whole-object checks cost more retries; narrower checks cost more careful dependency analysis.

On a definite conflict, re-read and compare the assumptions behind the plan. The agent may mechanically reapply an independent assignment, but a changed price, permission boundary, or cancellation can invalidate the intended operation. Existing authorization can still cover a routine rebase; a materially different consequential action may require a new decision. Bound retries and surface repeated contention instead of forcing an unconditional write.

## A reproducible lost-update experiment

The following uses Python's standard library and an in-memory database. It deliberately schedules two stale reads before the writes, so reproducing the race does not depend on thread timing. Save it as `cas_demo.py` and run `python3 cas_demo.py`.

```python
import json
import sqlite3

def run(guarded):
    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE doc(id TEXT PRIMARY KEY, rev INTEGER, body TEXT)")
    initial = {"title": "Draft", "owner": "A"}
    db.execute("INSERT INTO doc VALUES ('x', 1, ?)", (json.dumps(initial),))

    def read():
        rev, raw = db.execute("SELECT rev, body FROM doc WHERE id='x'").fetchone()
        return rev, json.loads(raw)

    def write(rev, body):
        sql = "UPDATE doc SET rev=rev+1, body=? WHERE id='x'"
        args = [json.dumps(body)]
        if guarded:
            sql += " AND rev=?"
            args.append(rev)
        with db:
            return db.execute(sql, args).rowcount

    rev_a, body_a = read()
    rev_b, body_b = read()
    body_a["title"] = "Reviewed"
    body_b["owner"] = "B"
    assert write(rev_a, body_a) == 1
    accepted = write(rev_b, body_b)
    if guarded:
        assert accepted == 0
        assert read() == (2, {"title": "Reviewed", "owner": "A"})
        fresh_rev, fresh_body = read()
        fresh_body["owner"] = "B"
        assert write(fresh_rev, fresh_body) == 1
        # Replay after a hypothetical lost response keeps the old condition.
        assert write(fresh_rev, fresh_body) == 0
        assert read() == (3, {"title": "Reviewed", "owner": "B"})
    else:
        assert accepted == 1
        assert read() == (3, {"title": "Draft", "owner": "B"})
    result = read()
    db.close()
    return result

print("unguarded:", run(False))
print("guarded + replan:", run(True))
```

Executed output:

```text
unguarded: (3, {'title': 'Draft', 'owner': 'B'})
guarded + replan: (3, {'title': 'Reviewed', 'owner': 'B'})
```

The unguarded variant is a known-bad positive control: it demonstrates the lost update that the guarded case must detect. The guarded case asserts rejection, preservation of the first edit, successful reapplication of intent, and refusal of a replay with the old revision. The SQL predicate and update occur in one statement. The experiment uses one connection and a fixed interleaving; it is not a load test, a proof of HTTP compliance, or a validation of any cloud provider. It also does not model deletion/recreation or a durable operation ledger.

## A timeout is not a conflict

A successful commit can lose its response. Retrying that request with its old condition may then fail because **the first attempt itself** advanced the version. Consequently, a later 412 or 409 does not prove that some other writer won, and an unknown network outcome should not immediately trigger another business operation.

For consequential commands, pair the conditional mutation with a provider-supported idempotency or operation-status contract where available. In a service you control, one option is a durable operation record committed transactionally with the mutation. Scope its key to the authorized actor and operation, bind it to the request parameters, and return the recorded result for an authenticated matching replay. A new plan is a new request, not permission to reuse an old key with different content.

A request ID embedded in a resource can help correlate a write, but later updates may erase it. A returned version helps only if the client actually received and retained it. Merely observing the desired content afterward cannot establish which operation produced it. If reliable attribution is unavailable, report the current state and the unresolved outcome separately.

Likewise, protecting one write does not make a two-resource workflow atomic. Updating a task and emitting a notification remains two effects unless a stronger transactional arrangement covers both. Some provider operations support conditions on several inputs—for example, Cloud Storage composition—but that does not turn arbitrary writes into a general multi-object transaction. A controller can reconcile partial completion; reconciliation is not all-or-nothing commit.

## What to verify before adopting the pattern

Use a real adapter test environment to check the boundary the local experiment cannot cover:

- Two clients read the same revision; one commits; the other's stale mutation is rejected without changing the first result.
- Missing conditions produce the endpoint's documented response, rather than silently falling back to overwrite.
- An intentionally removed condition makes the lost-update test fail: the test must discriminate the unsafe implementation.
- Re-reading and reapplying intent preserves an unrelated concurrent edit; merely refreshing the token does not count as a correct rebase.
- Lost responses, replay, and operation lookup produce an honest final status without duplicating a consequential command.
- Deletion/recreation and changes to another decision-relevant field invalidate the operation when the chosen identity and dependency contract requires it.

For a Zylos-like platform, a useful first adoption target is one shared-resource editing tool whose API already exposes an enforceable version condition. Measure conflicts, replan attempts, unresolved outcomes and forced-overwrite requests. This yields evidence about coordination cost before expanding the pattern across connectors.

## Scope and related research

The research inventory contained 593 Markdown entries on the main branch when this topic was selected. The earlier [artifact-mutability study](/research/2026-04-22-artifact-mutability-multi-agent-workflows/) discussed version pinning broadly; this article revisits the narrower storage commit boundary with provider contracts and an executable experiment. Recent [view-snapshot binding](/research/2026-08-07-view-snapshot-binding-anchoring-feedback/) concerns the content a human reviewed, while [fencing and drain protocols](/research/2026-09-03-fencing-tokens-drain-protocols-agent-session-pools/) concern stale worker authority. Those controls complement a write precondition and do not replace it.

Research and local verification were performed on 2026-09-17. Standards and provider claims are linked at the point of use; the tool contract, recovery recommendations and adoption path are engineering synthesis. No production system was changed or provider benchmark claimed.
