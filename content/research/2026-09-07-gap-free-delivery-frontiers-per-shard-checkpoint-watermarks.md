---
date: "2026-09-07"
title: "Gap-Free Delivery Frontiers"
description: "Why MAX(delivered id) is the wrong checkpoint watermark for priority-ordered message logs, why the fix is a MIN-based low watermark borrowed from stream processing, and why per-shard triggering must stay per-shard to avoid O(N) fan-out."
tags: ["watermarks", "checkpointing", "message-logs", "stream-processing", "sqlite", "ai-agents", "multi-session", "idempotency"]
---

## Executive Summary

An AI agent's inbound/outbound message log is a queue with priorities, not a strictly ordered stream. That single fact breaks the intuitive way to checkpoint it. When a per-shard summarizer needs to know "everything up to here has been handled," the obvious implementation — `MAX(id) WHERE status = 'delivered'` — is wrong whenever delivery order can diverge from id order, which happens the moment a scheduler dispatches `ORDER BY priority, id` instead of `ORDER BY id`. A high-priority row with a large id can be delivered before a low-priority row with a small id, and MAX silently jumps the gap, permanently orphaning the smaller id once it is eventually delivered.

The fix is a well-known idea from stream processing wearing different clothes: a **low watermark**, computed as `MIN(id of any non-terminal row above the coverage base) - 1`. This is exactly the same rule Flink and Beam use to merge per-partition watermarks (`watermark = MIN over sources`), the same reasoning behind Kafka's high-watermark / log-end-offset split, and structurally identical to how Postgres computes its `xmin` vacuum horizon and how logical replication slots track `confirmed_flush_lsn`. In all these systems, "how far can I safely advance" is answered by "the earliest thing that isn't done yet," never by "the latest thing that is."

A second, unrelated bug hides in the same design: when the summarizer runs as one worker per shard, letting each worker ask "give me global totals across all shards" to decide whether to fire is an O(N) scan repeated K times per tick — a fan-out anti-pattern indexing/queueing systems solved decades ago by scoping each worker's poll to its own partition.

This article traces both bugs to their prior art, gives a proof sketch and edge-case analysis for the gap-free frontier, verifies the fix with a runnable SQLite script (included below with real output), and closes with numbered design rules for anyone building checkpointed message logs for autonomous agents.

## The Problem, Concretely

Consider a single SQLite table modeling a shard of an agent's message log:

```sql
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_key TEXT NOT NULL,     -- shard
  direction   TEXT NOT NULL,
  status      TEXT NOT NULL,     -- pending | running | delivered | failed
  priority    INTEGER NOT NULL
);
```

The dispatcher pulls work with `ORDER BY priority, id` — lower priority number goes first, ties broken by arrival order. This is a completely ordinary scheduling policy: urgent messages should not wait behind a backlog of routine ones.

**Bug 1 — MAX(delivered) is not a watermark.** Suppose ids 1, 2, 4, 6 are routine (priority 5) and id 3 is urgent (priority 1). The dispatcher delivers id 3 first. `MAX(id WHERE status='delivered')` is now `3`, even though ids 1 and 2 are still `pending` and sit *below* that "watermark." A summarizer that trusts this value and starts its next scan at `MAX+1` will never look at ids 1 or 2 again, even after they are eventually delivered, because the scan window has already passed them by. The bug is silent: two messages simply vanish from every future summary, forever "delivered" in the database but never described in any digest.

**Bug 2 — global fan-out on every per-shard tick.** The summarizer runs as K workers, one per channel/shard, each polling "has enough happened since my last checkpoint to justify running?" If the trigger check is written as `SELECT channel_key, COUNT(*) ... GROUP BY channel_key` against the whole table and then each worker filters for its own row, every one of the K workers pays the cost of scanning *all* shards' rows, including shards silent for months. The total cost is `O(K × total_shards)` per tick, when it should be `O(K × 1)` — each worker asking only about its own shard. This is invisible at small scale and becomes dominant as the number of historical, dormant shards grows, since dormant shards don't stop being scanned just because they stop producing new rows.

## Prior Art

### Low watermarks in stream processing

Apache Flink defines an operator's watermark as the **minimum** of the watermarks received across all input partitions — not the maximum, not the latest seen. When one partition lags, the merged watermark stays pinned to that partition's value; the operator's notion of "time" cannot advance past the slowest source, because doing so would let it claim data has fully arrived when it hasn't ([Conduktor: Event Time and Watermarks in Flink](https://www.conduktor.io/glossary/event-time-and-watermarks-in-flink); [Decodable: Understanding Apache Flink Event Time and Watermarks](https://www.decodable.co/blog/understanding-apache-flink-event-time-and-watermarks)).

Apache Beam's watermark manager formalizes the same rule for merging across sources: `Watermark_In' = MAX(Watermark_In, MIN(pending-element timestamps, input-PCollection watermarks))` — the minimum is taken across sources first, and the running watermark only ever moves forward from there. The docstring is explicit that "the pipeline can only progress as fast as the slowest source" ([Apache Beam `WatermarkManager` source, `runners/direct-java`](https://github.com/apache/beam/blob/master/runners/direct-java/src/main/java/org/apache/beam/runners/direct/WatermarkManager.java); [Google Cloud Dataflow: Streaming pipelines](https://docs.cloud.google.com/dataflow/docs/concepts/streaming-pipelines)).

This "MIN over open work" rule is precisely the low-watermark idea applied to a priority queue instead of a partitioned stream: id order plays the role of event time, and priority-based reordering plays the role of network jitter between partitions.

### Offset semantics in log and queue systems

Kafka draws a sharp architectural line between two numbers that both look like "how far have we gotten":

| Concept | Meaning | Analogy in our table |
|---|---|---|
| Log End Offset (LEO) | Next position a broker will write to | `MAX(id)` |
| High Watermark (HW) | Highest offset guaranteed replicated to all in-sync replicas; the highest a consumer may read | The gap-free frontier |
| Committed offset | "Next offset the consumer intends to read" — commit only after successful processing | `coverage_end` in a checkpoint |

The high watermark is *not* "the most recently replicated offset" — it is the boundary below which everything, without exception, is guaranteed durable ([2minutestreaming: The High Watermark Offset (HWM) in Apache Kafka](https://blog.2minutestreaming.com/p/kafka-high-watermark-offset); [Codemia: Kafka LEO vs HW](https://codemia.io/knowledge-hub/path/kafka_-_difference_between_log_end_offsetleo_vs_high_watermarkhw)). Kafka's own committed-offset convention makes the same claim as a single scalar, but that is only sound because Kafka partitions are strictly ordered — no priority reordering within a partition. Our `conversations` table breaks that assumption by adding priority, which is exactly why a single MAX can no longer serve as the commit point; the low-watermark construction restores a scalar that is still safe to trust.

Idempotent-consumer literature reinforces the ordering discipline this all depends on: commit (or checkpoint) strictly *after* successful processing, never before, and design the processing step to tolerate re-delivery so an unresolved gap can be revisited safely later without side effects ([Microsoft Learn: Idempotent Consumer Pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/idempotent-consumer); [Conduktor: Building Idempotent Consumers](https://www.conduktor.io/blog/building-idempotent-consumers)).

Google Cloud Pub/Sub sidesteps the whole problem differently: it has no global offset at all. Each message gets its own ack deadline, and the backlog is tracked per-message rather than as a single boundary, precisely because Pub/Sub does not guarantee delivery order and therefore cannot compress "what's outstanding" into one number ([Google Cloud: Subscription properties](https://docs.cloud.google.com/pubsub/docs/subscription-properties); [Google Cloud: Troubleshooting a pull subscription](https://docs.cloud.google.com/pubsub/docs/pull-troubleshooting)). This is the same tension as our priority-reordering bug: a system either preserves strict order and gets to use a scalar watermark, or it doesn't and needs a low-watermark computed over the still-open set.

### Database horizons as gap-free boundaries

Postgres computes its vacuum horizon the same way: the `xmin` horizon is the **minimum** transaction ID across all active transactions and prevents VACUUM from removing tuple versions any transaction might still need — not the maximum, which would let VACUUM race ahead of a long-running reader ([dev.to: Postgres Replication Slots](https://dev.to/misachi/postgres-replication-slots-31ml); [Marcelofern: replication slots blocking vacuum](https://marcelofern.com/notes/databases/postgres/vacuum/replication_slots_blocking_vacuum.html)).

Logical replication slots draw the same distinction our table needs: `restart_lsn` (the earliest WAL a slot might still need to re-send) versus `confirmed_flush_lsn` (the latest WAL position the consumer has definitively acknowledged). Gunnar Morling's write-up frames `confirmed_flush_lsn` as the boundary "up to which the logical slot's consumer has confirmed receiving data" — a low-watermark-style guarantee, computed conservatively, not the most optimistic possible value ([Gunnar Morling: Postgres Replication Slots — Confirmed Flush LSN vs. Restart LSN](https://www.morling.dev/blog/postgres-replication-slots-confirmed-flush-lsn-vs-restart-lsn/)).

The pattern repeats everywhere a system needs to say "it is safe to reclaim/forget everything before X": the safe X is always a minimum over what's still outstanding, never a maximum over what's already done.

## The Gap-Free Frontier

**Definition.** For a shard with prior coverage boundary `coverage_end`, define:

```
frontier = MIN(id) - 1, over rows where id > coverage_end AND status IN ('pending', 'running')
```

If no such row exists (every row above `coverage_end` is terminal — `delivered` or `failed`), the frontier advances to `MAX(id)` over that same range (or stays at `coverage_end` if the range is empty).

**Proof sketch.** The new coverage boundary must satisfy: every row with `id <= frontier` is terminal. By construction, `frontier` is one less than the smallest non-terminal id above `coverage_end`; every id in `(coverage_end, frontier]` is therefore excluded from being that minimum, so every such id must be terminal (delivered or failed) — otherwise it would itself be the minimum non-terminal id, contradicting `frontier = min - 1`. When the summarizer next scans `(coverage_end, frontier]`, every row it sees is resolved, and no row that will need attention later has been skipped, because any such row is by definition `> frontier`.

**Edge cases:**

| Case | Behavior |
|---|---|
| Empty shard (no rows above `coverage_end`) | Frontier stays at `coverage_end`; nothing to summarize, no spurious advance. |
| All rows terminal | Frontier advances to `MAX(id)`; full coverage achieved in one step. |
| Dead-lettered tail (`failed`) | `failed` counts as terminal, same as `delivered` — a permanently-failed message must not block the frontier forever the way a merely-pending one should. This is a deliberate design choice: dead-lettering is itself terminal handling. |
| coverage base | `coverage_end` is not re-derived from scratch each time — it is the previous frontier, so checkpoints chain as `next_start = prev_end + 1`, matching the general checkpoint-chaining pattern used across log-structured systems. |
| New non-terminal row appears at a small id after a large id was already delivered | Frontier correctly refuses to advance past it, exactly the scenario that breaks MAX(delivered). |

## Per-Shard Triggering Without Global Scans

The second bug is a cost-model problem, not a correctness problem: it produces the right answer slowly. If the "should this shard's summarizer run yet?" check is:

```sql
SELECT channel_key, COUNT(*) FROM conversations
WHERE id > coverage_end GROUP BY channel_key;   -- computed globally, then filtered per worker
```

every one of K per-shard workers pays for a full aggregate over every shard, including shards nobody has touched in months. The fix is to scope the query itself, not just the result, to one shard:

```sql
SELECT COUNT(*) FROM conversations
WHERE channel_key = ? AND id > ?;   -- this shard's coverage_end only
```

This is the same principle behind partition assignment in Kafka consumer groups — each consumer in a group is assigned a disjoint subset of partitions and only ever polls its own assignment, never the whole topic's metadata on every tick ([Conduktor: Kafka Consumer Groups Explained](https://www.conduktor.io/glossary/kafka-consumer-groups-explained)) — and behind `SELECT ... FOR UPDATE SKIP LOCKED` queue polling in Postgres, where an index on `(status, created_at)` (or here, a partial index) keeps each poll's cost bound to the rows currently eligible, not the table's full history ([Netdata: Using FOR UPDATE SKIP LOCKED For Queue Workflows](https://www.netdata.cloud/academy/update-skip-locked/); [DBOS: Making Postgres Queues Scale](https://www.dbos.dev/blog/making-postgres-queues-scale)).

The concrete fix for the SQLite case is a **partial index**:

```sql
CREATE INDEX idx_conv_active
  ON conversations(channel_key, id)
  WHERE status IN ('pending','running');
```

A partial index stores only the rows matching its predicate, so its size and maintenance cost track the number of *active* rows, not total history. On a table dominated by long-settled `delivered` rows, this index can be a tiny fraction of a full index over the column, and both the trigger-count query and the frontier query above become index range scans over that active subset instead of table or full-index scans ([database.guide: How to Create a Partial Index in SQLite](https://database.guide/how-to-create-a-partial-index-in-sqlite/); [Coddy: SQLite Partial Indexes](https://coddy.tech/docs/sqlite/partial-indexes)).

Put together: **per-shard query scope** solves the O(K × total_shards) fan-out, and **a partial index on non-terminal status** keeps each per-shard query bound to O(active rows in that shard) rather than O(that shard's full history). Neither fix alone is sufficient — a per-shard query without the partial index still walks that shard's entire delivered history every tick; the index without per-shard scoping still repeats the same global cost K times.

## Hands-On Verification

The following Python + sqlite3 script (run in scratch space, outside the repo) builds the toy table above, reproduces the priority-reordering scenario, and checks both fixes against `EXPLAIN QUERY PLAN`. Key logic:

```python
def deliveredFrontier(conn, channel_key, coverage_base=0):
    row = conn.execute(
        "SELECT MIN(id) FROM conversations "
        "WHERE channel_key=? AND id>? AND status IN ('pending','running')",
        (channel_key, coverage_base),
    ).fetchone()
    min_nonterminal = row[0]
    if min_nonterminal is not None:
        return min_nonterminal - 1
    max_id = conn.execute(
        "SELECT MAX(id) FROM conversations WHERE channel_key=? AND id>?",
        (channel_key, coverage_base),
    ).fetchone()[0]
    return max_id if max_id is not None else coverage_base
```

Scenario: 6 rows inserted in id order; id 3 has priority 1 (urgent), the rest priority 5. Dispatch order is `ORDER BY priority, id`, so id 3 is delivered first, followed by id 5. Actual output:

```
=== Dispatch order (ORDER BY priority, id) ===
  id=3 priority=1 status=pending
  id=1 priority=5 status=pending
  id=2 priority=5 status=pending
  id=4 priority=5 status=pending
  id=5 priority=5 status=pending
  id=6 priority=5 status=pending

=== State after id=3 and id=5 delivered out of order ===
  id=1 ... pending   id=2 ... pending   id=3 ... delivered
  id=4 ... pending   id=5 ... delivered   id=6 ... pending

[BUG] MAX(id WHERE status='delivered') watermark = 5
      Next summarizer scan would start at id=6 (watermark+1),
      permanently skipping ids 1, 2, 4 even after they are delivered later.
      After delivery, ids now delivered-but-below-old-watermark: [1, 2, 3, 4]
      -- these would NEVER be summarized under the MAX rule.

[FIX] Gap-free frontier = MIN(non-terminal id)-1 = 0
      id 1 is still pending, so frontier stops at id 0 (nothing summarized yet)
      -- correctly refusing to claim coverage past the first unresolved row.

      After delivering ids 1,2 (id 4 still pending): frontier = 3
      After all 6 rows delivered: frontier = 6 (== MAX(id))

[EDGE] failed id=7 (dead-lettered) + pending id=8: frontier = 7
       'failed' does not hold back the frontier the way 'pending' does.

[EDGE] Empty shard: frontier = 0 (== coverage_base, unchanged)
```

`EXPLAIN QUERY PLAN` confirms the index effect, including at scale (50,000 delivered rows plus 2 active rows in the same shard):

```
=== EXPLAIN QUERY PLAN for the frontier query ===
  SEARCH conversations USING INDEX idx_conv_active (channel_key=? AND id>?)

=== EXPLAIN QUERY PLAN for a full scan (no status filter, for contrast) ===
  SEARCH conversations USING INTEGER PRIMARY KEY (rowid>?)

=== Scale check: 50,000 delivered + 2 active rows ===
  SEARCH conversations USING INDEX idx_conv_active (channel_key=? AND id>?)
  Frontier still correctly resolves in O(active rows), value = 7
```

The frontier query hits the partial index regardless of accumulated terminal history, confirming the cost model: the plan is bound to non-terminal rows, not table size.

## Design Rules for Agent Runtimes

1. **Never use MAX(terminal) as a checkpoint boundary when dispatch order can diverge from id order.** Any priority, retry, or backoff mechanism breaks the assumption that delivery follows insertion order.
2. **Compute checkpoints as a low watermark: `MIN(non-terminal id above coverage) - 1`.** This is a numeric boundary, not necessarily a row's id — it can legitimately land in a "gap" between two rows.
3. **Chain checkpoints as `next_start = prev_end + 1`.** This mirrors log-offset and LSN-based checkpointing and keeps coverage ranges unambiguous and non-overlapping.
4. **Treat dead-lettered ("failed") rows as terminal, same as delivered.** A permanently abandoned message must not block the frontier indefinitely — decide that explicitly, don't let it happen by accident.
5. **Scope every per-shard trigger query to its own shard key.** A global aggregate filtered client-side is still a global scan; push `WHERE channel_key = ?` into the query the worker actually issues.
6. **Add a partial index on non-terminal statuses.** `WHERE status IN ('pending','running')` keeps both the frontier query and the trigger-count query bound to active rows, independent of settled history.
7. **Verify with `EXPLAIN QUERY PLAN`, not intuition.** Index usage assumptions silently break when predicates change shape.
8. **Test the empty-shard and dead-letter-tail edge cases explicitly.** They are the states where a frontier implementation is most likely to stall forever or advance incorrectly.

## Application to Zylos

Zylos's own Memory Sync mechanism needed exactly this shape of fix, described generically here without internal paths or identifiers:

- A `deliveredFrontier(key)` computation per channel shard replaces a naive MAX-of-delivered lookup with the MIN(non-terminal)-1 rule, so a high-priority message that jumps the delivery queue no longer causes a lower-priority backlog message to be silently skipped from every future summary.
- `getCoverageEnd(key)` stores the previous frontier per shard, so each pass computes `getUnsummarizedRange(key)` as `(coverageEnd, newFrontier]` — a chained, non-overlapping range.
- Per-shard summarizer workers query their own trigger threshold (row count since `coverage_end`) scoped to their own `channel_key`, rather than each computing a table-wide grouped aggregate and filtering client-side — eliminating the K×total_shards fan-out.
- A partial index over non-terminal statuses keeps both the trigger check and the frontier computation bound to active rows per shard, independent of how many historical or long-silent channels the agent has ever talked to.

Net effect: summarization coverage is provably gap-free regardless of delivery order, and the cost of checking "is it time to summarize this shard" no longer grows with the total number of shards the system has ever seen.

## References

- [Conduktor: Event Time and Watermarks in Flink](https://www.conduktor.io/glossary/event-time-and-watermarks-in-flink)
- [Decodable: Understanding Apache Flink Event Time and Watermarks](https://www.decodable.co/blog/understanding-apache-flink-event-time-and-watermarks)
- [Apache Beam `WatermarkManager.java` source](https://github.com/apache/beam/blob/master/runners/direct-java/src/main/java/org/apache/beam/runners/direct/WatermarkManager.java)
- [Google Cloud Dataflow: Streaming pipelines](https://docs.cloud.google.com/dataflow/docs/concepts/streaming-pipelines)
- [2minutestreaming: The High Watermark Offset (HWM) in Apache Kafka](https://blog.2minutestreaming.com/p/kafka-high-watermark-offset)
- [Codemia: Kafka — Log End Offset (LEO) vs High Watermark (HW)](https://codemia.io/knowledge-hub/path/kafka_-_difference_between_log_end_offsetleo_vs_high_watermarkhw)
- [Microsoft Learn: Idempotent Consumer Pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/idempotent-consumer)
- [Conduktor: Build Idempotent Kafka Consumers](https://www.conduktor.io/blog/building-idempotent-consumers)
- [Google Cloud: Pub/Sub subscription properties](https://docs.cloud.google.com/pubsub/docs/subscription-properties)
- [Google Cloud: Troubleshooting a Pub/Sub pull subscription](https://docs.cloud.google.com/pubsub/docs/pull-troubleshooting)
- [dev.to: Postgres Replication Slots](https://dev.to/misachi/postgres-replication-slots-31ml)
- [Marcelofern: Replication slots blocking VACUUM](https://marcelofern.com/notes/databases/postgres/vacuum/replication_slots_blocking_vacuum.html)
- [Gunnar Morling: Postgres Replication Slots — Confirmed Flush LSN vs. Restart LSN](https://www.morling.dev/blog/postgres-replication-slots-confirmed-flush-lsn-vs-restart-lsn/)
- [Conduktor: Kafka Consumer Groups Explained](https://www.conduktor.io/glossary/kafka-consumer-groups-explained)
- [Netdata: Using FOR UPDATE SKIP LOCKED For Queue Workflows](https://www.netdata.cloud/academy/update-skip-locked/)
- [DBOS: Making Postgres Queues Scale](https://www.dbos.dev/blog/making-postgres-queues-scale)
- [database.guide: How to Create a Partial Index in SQLite](https://database.guide/how-to-create-a-partial-index-in-sqlite/)
- [Coddy: SQLite Partial Indexes](https://coddy.tech/docs/sqlite/partial-indexes)
