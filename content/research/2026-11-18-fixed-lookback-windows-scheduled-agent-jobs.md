---
date: "2026-11-18"
time: "09:00"
title: "The Newest 300 Is Not 'Since Last Time': Cursors, Coverage and Catch-Up for Scheduled Agent Jobs"
description: "Why scheduled agent jobs that read a fixed number of items or hours silently skip work, and how high-water marks, limit+1 probes, coverage reports and bounded catch-up fix it."
tags: ["research", "scheduled-jobs", "agent-runtime", "reliability", "pagination", "idempotency", "cron", "observability"]
---

## Executive Summary

Picture a persistent agent with a nightly job. Every night it reads the day's chat history, asks a model to extract recurring decision patterns, and saves the results. The query is simple: "give me the newest 300 messages." On a quiet day that is the whole day. On a busy day there are 800 messages. The job reads the newest 300, never sees the oldest 500, writes its results, and reports success. Nothing is wrong from the job's point of view. It did what it was told. Nobody finds out that 62% of the day was never looked at, and because the skipped messages are the *oldest* ones, they never come back into any later window either.

The same shape shows up everywhere. A digest that reads "the last 24 hours" runs three hours late, or not at all on Tuesday, and Monday evening falls into the gap. A triage script scans "the top 100 issues." A log tailer reads the last 1,000 lines. A cron job comes back after a day of downtime and processes only its usual slice.

**The conclusion:** "the newest N" and "the last T" are answers to the question "what is recent?", not to "what have I not processed yet?" Scheduled jobs need the second question. That means:

1. **Persist a cursor** (a high-water mark: "processed up to id X") and select `WHERE id > cursor ORDER BY id LIMIT n+1`. Advance the cursor only after the batch's output is durably written, and advance it only as far as you actually processed.
2. **Detect overflow explicitly.** Fetch one more row than you will process. If it comes back, there is more. Never let a page-size limit double as a coverage claim.
3. **Emit coverage with every result:** the range covered, items read, items known to be available, items deferred, and a status that is `complete` or `partial`. A partial run is a reported outcome, not a green check.
4. **Decide catch-up on purpose.** Schedulers differ widely in what they do after a missed run (some run once, some run every missed slot, some skip). Pick a policy per job, bound each run with a chunk size and a budget, and let the backlog drain over several runs.
5. **Make writes idempotent** so that overlapping windows, retries and catch-up runs cannot double-count.
6. **Test the boundary:** seed N+1 items, simulate a missed run, and assert that the output declares what it covered.

The SQLite snippets below were run on SQLite 3.45.1 against an 800-row table and produced the numbers quoted. Claims about third-party systems were checked against their current documentation, linked in the References section.

## Why Fixed Windows Fail Silently

A fixed window comes in two flavors: a count ("newest 300 messages", `LIMIT 100`, `tail -n 1000`) and a duration ("created in the last 24 hours", `now() - interval '1 day'`). Both are stateless. The job does not remember what it did last time, so the window itself has to guess what is new. It guesses correctly only when three assumptions hold: volume is predictable, the job runs exactly on schedule, and clocks agree. Each of these fails in ordinary operation.

### Failure 1: volume spikes (count windows)

With `ORDER BY id DESC LIMIT 300` the window always ends at "now" and extends backwards 300 rows. When more than 300 rows arrive between runs, the oldest ones fall off the back. Reproducing the opening scenario on SQLite with 800 rows:

```sql
SELECT count(*), min(id), max(id)
FROM (SELECT id FROM messages ORDER BY id DESC LIMIT 300);
-- 300 | 501 | 800     (rows 1..500 are never read)
```

This is the dangerous part: the output is *well-formed*. There is no error, no truncation marker, and the result for the 300 rows is correct. Only the missing coverage is wrong, and a missing thing is hard to notice.

### Failure 2: late or missed runs (duration windows)

A "last 24 hours" window is correct only if consecutive runs are exactly 24 hours apart. Suppose yesterday's run fired on time at 02:00 and covered the 24 hours before it. If today's run slips to 05:00 because the host was busy, its window starts at 05:00 yesterday, and the three hours from 02:00 to 05:00 yesterday belong to neither window. If a run is skipped entirely, a full day is never covered. If the window is wider than the interval for safety (say 26 hours), you trade gaps for duplicates and still fail after a two-day outage.

### Failure 3: clocks, time zones and DST

Wall-clock windows inherit every wall-clock problem. The crontab(5) man page states that cron examines entries every minute and that jobs scheduled in non-existent times, such as the "missing hours" during a daylight saving conversion, "will never match", while times that occur twice will "cause matching jobs to be run twice". Kubernetes CronJobs interpret a schedule in the kube-controller-manager's local time zone unless `.spec.timeZone` is set, and the controller's own warning for too many missed schedules tells you to "check clock skew". If the row timestamps come from another system (a chat platform's server clock, say) and "now" comes from your host, any skew shifts the window edges. A cursor over a monotonically increasing id sidesteps most of this.

### Failure 4: page-size defaults and API limits

Many jobs do not choose their window; an API does. If your code calls a list endpoint once and treats the response as "everything", the page size is your window.

| API | Page size behavior (from the docs) | How "there is more" is signaled |
|---|---|---|
| GitHub REST | `per_page` max is 100 for most endpoints; values above the max are silently reduced; List repository issues defaults to 30 | `Link` header with `rel="next"` / `rel="last"`; the `last` link "won't be included if it can't be calculated" |
| Stripe | `limit` defaults to 10, range 1-100 | `has_more` boolean; cursors via `starting_after` / `ending_before` |
| Slack Web API | `conversations.history` `limit` defaults to 100 and fewer items "may be returned, even if the end of the conversation history hasn't been reached" | `has_more` and `response_metadata.next_cursor`; an empty `next_cursor` means the end |
| Telegram Bot API | `getUpdates` `limit` 1-100, default 100; unconfirmed updates are kept at most 24 hours | `offset` must be one greater than the highest `update_id` already received; calling with a higher offset confirms earlier updates |
| Kafka consumer | `max.poll.records` default 500 per `poll()` call | Committed offsets; `auto.offset.reset` default `latest` |

Two details are worth underlining. GitHub's List repository issues also returns pull requests (every pull request is an issue), so "the first 30 results" may contain fewer real issues than you think. And Slack's `limit` is a ceiling, not a promise: a short page does not prove you reached the end. Stripe's `has_more` and Slack's empty `next_cursor` are the only authoritative end-of-data signals; a page shorter than the limit is not.

Telegram's `getUpdates` builds the high-water mark into the protocol: you confirm updates by asking for `offset = last update_id + 1`. The cost is 24-hour retention, so a consumer that is down longer loses updates, a bounded and documented loss rather than a silent one.

Kafka looks cursor-like and still has a silent-skip default. When no committed offset exists or it is out of range, `auto.offset.reset` decides: `latest` (the default) jumps to the end of the log, `earliest` restarts from the beginning, and only `none` throws. Also, `enable.auto.commit` defaults to `true`, committing offsets in the background regardless of whether your processing finished. For a job whose output matters, commit after processing.

## The Alternative: A Cursor (High-Water Mark)

The fix is to make the job stateful in the smallest possible way. Persist one value per job: the position up to which input has been successfully processed. Each run starts from that position.

```sql
CREATE TABLE job_state (
  job       TEXT PRIMARY KEY,
  last_id   INTEGER NOT NULL,        -- processed through this id
  updated_at INTEGER NOT NULL
);

-- Read the next batch, one extra row as an overflow probe
SELECT id, ts, body
FROM messages
WHERE id > (SELECT last_id FROM job_state WHERE job = 'nightly')
ORDER BY id ASC
LIMIT 301;           -- batch size 300, plus 1
```

Key design rules:

- **Order ascending, by a monotonic key.** An autoincrement id or a (timestamp, id) pair. This is keyset (seek) pagination, the same idea Stripe's `starting_after` and Slack's `next_cursor` expose. Do not use `OFFSET`: rows inserted between calls shift it.
- **Advance after success, and only to what you processed.** If you read 300 rows, set the cursor to the id of row 300, not to the id of the probe row and not to "now". If the model call fails halfway, do not advance at all.
- **Make the advance a conditional write.** `UPDATE job_state SET last_id = :new WHERE job = :job AND last_id = :old` returns one changed row for the caller that owns the advance, and zero for a stale or replayed caller. In the test run, the first call reported 1 change and a replay reported 0.
- **Persist the cursor transactionally with the output when you can.** If the results and the cursor live in the same SQLite database, write both in one transaction. If they live in different systems, write results first (idempotently, see below) and the cursor second; a crash between the two causes a re-run of one batch, not a gap.

The result is "at-least-once with idempotent writes": the cursor can lag the truth by one batch after a crash, but it can never lead it. Compare that with the fixed window, where after a crash there is no record of anything at all.

### The scheduler's cursor is not your cursor

Existing schedulers persist a form of cursor, but a different one. systemd timers with `Persistent=true` store "the time when the service unit was last triggered" on disk; anacron keeps timestamp files in `/var/spool/anacron`. Those answer "did the trigger fire?", which tells the scheduler whether a slot was missed but not which data the last run covered. Airflow passes each run a data interval and its best-practices guide says: "Read and write in a specific partition. Never read the latest available data in a task," because "someone may update the input data between re-runs, which results in different outputs." Your cursor must answer "did the data get processed?". A job that depends only on the first answer has the gap described above.

## Detecting Overflow and Reporting Coverage

### The limit+1 probe

To know whether more rows exist without a separate `COUNT(*)` (which can be slow, and racy), ask for one more than you will process:

```js
const BATCH = 300;
const rows = db.all(
  `SELECT id, ts, body FROM messages
   WHERE id > ? ORDER BY id ASC LIMIT ?`,
  [cursor, BATCH + 1]
);
const hasMore = rows.length > BATCH;
const batch = hasMore ? rows.slice(0, BATCH) : rows;
```

On the 800-row table this returned 301 rows for the first run (ids 1-301), so `hasMore` was true and the batch was ids 1-300. After the cursor advanced to 300, the next run again returned 301 rows (ids 301-601). That is the same idea as Stripe's `has_more` and Slack's `has_more`, applied to your own table. If the source is an external API, use its own signal (`has_more`, `next_cursor`, `Link: rel="next"`) rather than inferring from page length.

When a cheap count is available, record it too. "Read 300 of 800 available" is more useful than "more exist".

### Coverage is part of the output

Treat coverage as a first-class output field, written next to the results:

```json
{
  "job": "nightly-patterns",
  "run_id": "2026-11-18T02:00:03Z",
  "status": "partial",
  "covered": { "from_id": 1, "to_id": 300, "from_ts": "2026-11-17T00:00:04Z", "to_ts": "2026-11-17T06:12:41Z" },
  "items_read": 300,
  "items_available": 800,
  "items_deferred": 500,
  "next_cursor": 300,
  "reason": "batch_limit"
}
```

Rules for this record:

- **`status` is `complete` only if the cursor reached the head** (`hasMore === false` and nothing was dropped for budget reasons). Anything else is `partial`.
- **A partial run is surfaced.** Send it to wherever the job's other outcomes go: the log line, the run summary, the digest's first line ("covers messages 1-300 of 800; remaining 500 queued for next run"). The failure mode we are avoiding is that the information exists in the job's head and nowhere else.
- **Consumers of the output can check it.** If a downstream step builds "the day's patterns" from this run, it should know the day was only 37% covered. Put the coverage in the output file's header, not just in a log.
- **Alert on trends, not single runs.** A backlog that shrinks each night is healthy catch-up. A backlog that grows (`items_deferred` rising for several runs) means batch size or schedule frequency is wrong. Record the cursor lag (head id minus cursor) as a metric.

## Catch-Up Semantics: What Happens After a Missed Run

Once a job has a cursor, a missed run costs time, not data: the next run simply finds more rows. But you still have to decide how the *scheduler* behaves, and schedulers disagree.

| Scheduler | Missed-run behavior (from the docs) | Knob |
|---|---|---|
| cron (crontab(5)) | The man page covers matching against the current time, and does not describe running jobs missed while the daemon was down | Use anacron or a persistent timer if you need it |
| systemd timer | With `Persistent=true`, the unit triggers immediately on activation if at least one trigger was missed, subject to `RandomizedDelaySec=`; several missed elapses lead to a single activation; only applies to `OnCalendar=` timers; default `false` | `Persistent=`, `RandomizedDelaySec=`, `AccuracySec=` (default 1 min) |
| anacron | Runs a job if it has not run in n days or more; delay parameter and `-n` to skip the delay | `/etc/anacrontab` |
| Kubernetes CronJob | `startingDeadlineSeconds` is the allowed lateness; a Job that misses the deadline is skipped and treated as failed; unset means no deadline. If more than 100 schedules were missed, the controller records a `TooManyMissedTimes` warning and (in current docs) still starts a Job for the most recent missed schedule | `startingDeadlineSeconds`, `concurrencyPolicy` (`Allow` default, `Forbid`, `Replace`) |
| Airflow | Default `catchup=False`: missed intervals since `start_date` are not backfilled; with `catchup=True` a run is created for every missed interval; backfill reruns a historical range on demand | `catchup`, backfill CLI/UI with max-active-runs |
| Temporal Schedules | Catchup Window controls how late an Action can be taken (default one year, minimum ten seconds); manual triggers and Backfills are not restricted by it; overlap policies `Skip` (default), `BufferOne`, `BufferAll`, `CancelOther`, `TerminateOther`, `AllowAll` | `catchupWindow`, `overlap` |

The Kubernetes row deserves a comment: the wording around the 100-missed-schedules case has changed between documentation versions (older text said the controller did not start a Job), so read the page for the version you run. The docs' own summary of the whole area is also worth taking literally: "the scheduling is approximate because there are certain circumstances where two Jobs might be created, or no Job might be created... the Jobs that you define should be idempotent."

I looked for missed-tick behavior in Dagster's schedule guide and did not find it described there, so I make no claim about it.

### Which policy fits a cursor-based job

A useful way to think about it is that there are three possible meanings of "catch up":

- **Run every missed slot** (Airflow `catchup=True`, Temporal `BufferAll` or a long catchup window). Right for jobs whose unit of work is a time partition, because each run is a bounded, idempotent task for one interval. Wrong for a job that reads "now", since Airflow's docs say to leave catchup off if the Dag is "not limited to the interval, but instead to `Now`".
- **Run once, as soon as possible** (systemd `Persistent=true` collapses many missed elapses into one activation; `anacron`). Right for cursor-based jobs: one run with a cursor reads everything since the last good run, so ten missed slots do not need ten runs.
- **Skip stale slots** (Kubernetes `startingDeadlineSeconds`). Right when the output is only useful on time ("a backup taken any later wouldn't be useful", as the docs put it). For a cursor-based pattern-extraction job the data is still valid late, so a tight deadline would only *discard* a run and delay the catch-up.

For an agent's nightly extraction job, the practical combination is: a persistent timer (or equivalent) so a run after downtime fires once; no tight lateness deadline; `Forbid`/`Skip`-style overlap so two runs do not race on the same cursor; and a cursor so that the single catch-up run knows exactly what it owes.

```ini
# nightly-patterns.timer  (systemd)
[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
```

```yaml
# Kubernetes equivalent: one run, no overlap, explicit time zone
apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly-patterns
spec:
  schedule: "0 2 * * *"
  timeZone: "Asia/Singapore"
  concurrencyPolicy: Forbid
  # startingDeadlineSeconds deliberately unset: a late run is still useful,
  # the cursor decides what it covers
```

Note that these scheduler settings never replace the cursor. `Persistent=true` makes the job *start*; it does not tell the job what it missed.

## Bounding the Backlog: Chunks, Budgets and LLM Cost

After a long outage or a spike, the cursor might be 5,000 items behind. Reading them all in one go has its own failure modes, especially for LLM-based processing.

**Context limits and quality.** A model call has a context window, and even within it, quality varies with position. The "Lost in the Middle" study (Liu et al., TACL 2023) found that accuracy was highest when relevant information sat at the beginning or end of the input and "significantly degrades" when it sat in the middle, even for explicitly long-context models. Stuffing 800 messages into one prompt is not a safe fix for the 300-message limit; it replaces a visible truncation with a quiet quality loss.

**Chunking by the cursor.** Process the backlog in bounded chunks, each a cursor-advance unit:

1. Read up to `BATCH` items after the cursor (+1 probe).
2. Run the model over that chunk (the "map" step) and write a chunk-level result keyed by the chunk's id range.
3. Advance the cursor to the chunk's last id.
4. Repeat until the head is reached or the budget is hit.
5. A final "reduce" step merges chunk results (dedupe, rank, summarize) and can be re-run from stored chunk outputs without re-reading raw input.

Because each chunk's result is stored and the cursor advances per chunk, a crash on chunk 4 of 6 resumes at chunk 4.

**Budgets that report.** LLM calls cost money and hit rate limits, so a run needs caps: maximum chunks per run, maximum tokens, a wall-clock limit. The important property is what happens at the cap. Stopping is fine; stopping *quietly* is the bug. When the budget is hit, finish the current chunk, advance the cursor to it, mark the run `partial` with `reason: "budget"`, and report `items_deferred`. The next run (tomorrow, or an extra catch-up trigger) picks up from there. Spread large backlogs across several runs instead of letting one night's run consume an unbounded bill.

**Tell the reader which part of the day they are looking at.** If the output summarizes the covered range only, say so in the first line. A summary titled "Patterns from 2026-11-17" that covers the first third of that day is mislabeled; "Patterns from messages 1-300 (00:00-06:12), 500 pending" is accurate.

## Idempotency and Overlapping Windows

Cursors move forward, but real jobs still re-read data: a crash after output but before the cursor write, a retry, a manual re-run, or a deliberate overlap to catch late-arriving rows. All of those are safe only if the output is idempotent.

- **Dedup keys.** Give each output record a deterministic key derived from its inputs (for example, a hash of the pattern text plus the source id range, or the source message id for per-message records). Write with upsert (`INSERT ... ON CONFLICT(key) DO UPDATE`), not plain `INSERT`. Airflow's best-practices page says this directly: "Do not use INSERT during a task re-run, an INSERT statement might lead to duplicate rows in your database. Replace it with UPSERT."
- **Replace the partition instead of appending.** For chunked output, delete-then-insert for the chunk's id range inside one transaction, so a re-run replaces rather than adds.
- **Deliberate overlap for late data.** If rows can arrive out of order (a message with an older timestamp inserted later), a cursor over `id` handles it, because ids are assigned at insert. A cursor over a source timestamp does not: Slack's own docs describe `oldest`/`latest` as timestamps and note that messages sharing a timestamp with the boundary are excluded unless `inclusive` is set. If you must cursor on a source timestamp, re-read a small overlap (for example, the last few minutes) and rely on the dedup key.
- **Overlap control for runs.** Two runs working the same cursor can double-process or race on the advance. Use the scheduler's non-overlap setting (`concurrencyPolicy: Forbid`, Temporal `Skip` or `BufferOne`) plus the conditional `UPDATE ... WHERE last_id = :old` as the last line of defense.

## Testing for Coverage

The original bug survives because the happy-path test is "seed 50 messages, run the job, check the output." The tests that would have caught it are about boundaries and missing runs:

```js
test('declares partial coverage when input exceeds batch size', async () => {
  seedMessages(db, 801);                       // BATCH is 300
  const out = await runJob({ batch: 300, maxChunks: 1 });
  assert.equal(out.status, 'partial');
  assert.equal(out.items_read, 300);
  assert.equal(out.items_deferred, 501);
  assert.equal(getCursor(db), 300);            // advanced only to what was processed
});

test('exactly BATCH items is complete, not partial', async () => {
  seedMessages(db, 300);
  const out = await runJob({ batch: 300 });
  assert.equal(out.status, 'complete');        // the probe row did not exist
});

test('a missed run is absorbed by the next one', async () => {
  seedMessages(db, 100); await runJob();       // day 1
  seedMessages(db, 100);                       // day 2: run skipped
  seedMessages(db, 100);                       // day 3
  const out = await runJob();
  assert.equal(out.covered.from_id, 101);      // starts at the cursor, not at "24h ago"
  assert.equal(out.covered.to_id, 300);
});

test('failure does not advance the cursor', async () => {
  seedMessages(db, 50);
  await assert.rejects(runJob({ modelFails: true }));
  assert.equal(getCursor(db), 0);
});

test('re-running the same batch does not duplicate output', async () => {
  seedMessages(db, 50);
  await runJob({ crashAfterWriteBeforeCursor: true }).catch(() => {});
  await runJob();
  assert.equal(countOutputRows(db), 50);
});
```

Four properties are being checked: **N+1 yields `partial`**, **exactly N yields `complete`** (the off-by-one around the probe row), **a skipped day is covered by the next run**, and **failures and replays neither skip nor duplicate**. Add a test that runs the job against a clock set across a DST transition if your window is time-based, and a test that a coverage record is actually written when the job has *zero* new items (empty is a valid, reportable result).

## A Practical Checklist for Agent Builders

Before shipping a scheduled job that reads "recent" data, check:

1. **Progress unit.** A monotonic id, offset or sequence number exists (add one at ingest if not).
2. **Cursor.** One row per job, advanced only after durable output, only to the last processed item, with a conditional write.
3. **Overflow probe.** The query asks for limit+1, or uses the API's `has_more` / `next_cursor` / `Link rel="next"`. A short page is never read as "the end".
4. **Coverage.** Every run writes covered range, items read, items available or deferred, and `complete` or `partial` next to its result, even when there were zero new items.
5. **Visibility.** Partial runs go to the same channel as errors, and the output headline states the covered range.
6. **Downtime policy.** Run-once, run-all or skip is chosen deliberately and the matching knob is set (`Persistent=`, `catchup`, `startingDeadlineSeconds`, catchup window), plus overlap handling.
7. **Bounds.** Chunk size, max chunks, token and time budgets; hitting a cap yields `partial` and a deferred count.
8. **Idempotent writes.** Deterministic keys, upserts, replace-by-range.
9. **One clock.** One time source and an explicit time zone; prefer ids over timestamps for the cursor.
10. **Tests.** Seed N+1, skip a run, crash mid-run, and assert coverage.

If a job cannot do all of this yet, start with items 3 and 4: add the probe row and print the coverage line. That alone turns a silent gap into a visible one.

## References

- systemd.timer manual (`Persistent=`, `OnCalendar=`, `RandomizedDelaySec=`, `AccuracySec=`): https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html
- Kubernetes CronJob (startingDeadlineSeconds, concurrencyPolicy, missed schedules, time zones, idempotency): https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/
- Apache Airflow Dag runs (catchup, data intervals, backfill): https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dag-run.html
- Apache Airflow best practices (idempotent tasks, UPSERT, never read the latest available data): https://airflow.apache.org/docs/apache-airflow/stable/best-practices.html
- Temporal Schedules (catchup window, overlap policies, pause): https://docs.temporal.io/schedule
- anacron(8) man page: https://man7.org/linux/man-pages/man8/anacron.8.html
- crontab(5) man page (clock changes, DST): https://man7.org/linux/man-pages/man5/crontab.5.html
- Stripe API pagination (`limit`, `has_more`, `starting_after`): https://docs.stripe.com/api/pagination
- GitHub REST API pagination: https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api
- GitHub REST API, list repository issues (`per_page` default 30, `since`, pull requests as issues): https://docs.github.com/en/rest/issues/issues#list-repository-issues
- Slack Web API cursor-based pagination: https://docs.slack.dev/apis/web-api/pagination
- Slack `conversations.history` (`limit`, `oldest`, `latest`, `inclusive`, `has_more`): https://docs.slack.dev/reference/methods/conversations.history
- Telegram Bot API, `getUpdates` (`offset`, `limit`, 24-hour retention): https://core.telegram.org/bots/api#getupdates
- Apache Kafka consumer configs (`auto.offset.reset`, `enable.auto.commit`, `max.poll.records`): https://kafka.apache.org/41/configuration/consumer-configs/
- Liu et al., "Lost in the Middle: How Language Models Use Long Contexts": https://arxiv.org/abs/2307.03172
