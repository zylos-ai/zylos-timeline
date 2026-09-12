---
date: "2026-09-04"
title: "Orphaned-Claim Recovery in Single-Writer Job Queues"
description: "How deadlines, heartbeats, broker sessions, and database locks recover abandoned work—and which guarantees stop at the side-effect boundary."
tags: ["job-queues", "crash-recovery", "leases", "postgres", "distributed-systems", "message-queues", "visibility-timeout", "advisory-locks"]
---

## Executive Summary

A worker can claim a job and disappear before recording completion. Recovery then has two separate jobs: decide when the old claim no longer excludes another worker, and decide whether running the job again is safe.

Queue systems use several signals for the first decision:

- **Deadlines and renewable leases.** Amazon SQS visibility timeouts, beanstalkd TTR, Faktory reservations, and Temporal Activity timeouts make work eligible again after a clock expires.
- **Membership timeouts.** Kafka uses heartbeats and poll-progress limits to revoke partition ownership and rebalance it.
- **Owner-scoped resources.** RabbitMQ requeues unacknowledged deliveries when their channel closes. PostgreSQL releases transaction locks at transaction end and session advisory locks at session end.
- **Durable reconciliation.** Sidekiq Pro and Oban retain an in-progress record, then use periodic recovery logic to find work whose owner appears gone or whose execution is too old.

These mechanisms do not form a clean “timeout versus proof” split. A lock manager can make concurrent ownership precise, but learning that a remote process or connection has failed still takes time. Conversely, a timeout may be the intended correctness boundary rather than a crude fallback. The useful design distinction is: **which authority revokes ownership, what observation lets it do so, and what remains ambiguous after revocation?**

No reclaim mechanism makes external effects exactly once. A worker can send an email or charge a card and crash before acknowledging the job. Idempotency keys, durable result records, or a transactional outbox are still required at that boundary.

## Model the Claim Before Choosing Recovery

Consider a table-backed dispatcher that commits a durable state change before doing the work:

```sql
BEGIN;
SELECT id FROM jobs
WHERE state = 'pending'
ORDER BY created_at, id
FOR UPDATE SKIP LOCKED
LIMIT 1;

UPDATE jobs
SET state = 'running', claimed_by = :worker, claimed_at = now()
WHERE id = :id;
COMMIT;
```

After `COMMIT`, the row lock is gone but the durable `running` state remains. A later worker cannot use lock release alone to recover the job; it needs another rule for deciding that the durable claim is stale. By contrast, if the transaction stays open for the entire execution, the row lock itself is the live claim—but the design now holds a database transaction across arbitrary application work.

This yields four questions that should be answered independently:

1. **Ownership:** what prevents two workers from believing they own the same job now?
2. **Revocation:** what event makes the old ownership invalid—a deadline, missed heartbeat, channel close, transaction end, or reconciler decision?
3. **Rediscovery:** where does abandoned work become eligible again, and how quickly?
4. **Effects:** if the old worker resumes or had already produced an external effect, what prevents corruption or duplication?

“Single writer” helps only with ownership, and only while that invariant is enforced. A singleton process without an external lock can split during failover. Conversely, PostgreSQL row or advisory locks can arbitrate many concurrent workers safely; they do not require a single application writer.

## Deadline- and Heartbeat-Based Revocation

Amazon SQS makes a received message invisible for a [visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html), 30 seconds by default and configurable from 0 seconds to 12 hours. Deleting the message confirms success; otherwise it becomes visible again. A long-running consumer can renew the deadline with `ChangeMessageVisibility`. If processing outlasts the timeout, another consumer can receive the same message while the first is still running. AWS therefore documents standard queues as [at-least-once delivery](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues-at-least-once-delivery.html) and recommends idempotent consumers.

An SQS dead-letter queue is optional. When configured, its redrive policy supplies `maxReceiveCount`; it is not part of visibility-timeout recovery itself. AWS also warns that attaching a DLQ to a FIFO queue can break exact ordering, and that a standard-queue message received three or more times may move toward the back of the source queue when `maxReceiveCount` is greater than three ([DLQ documentation](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)).

Beanstalkd gives each reserved job a TTR (“time to run”). Its [protocol](https://github.com/beanstalkd/beanstalkd/blob/master/doc/protocol.txt) returns an expired reservation to `ready`; `touch` restarts the TTR countdown, while `DEADLINE_SOON` warns a connection that one of its reserved jobs is within roughly one second of expiry. Priority and delay determine which ready job is selected, so recovery should not be described as restoring an original FIFO position.

Faktory calls the same boundary a reservation. In its [protocol specification](https://github.com/contribsys/faktory/blob/main/docs/protocol-specification.md), `reserve_for` defaults to 1,800 seconds and defines how long a worker may hold a job before the server considers it failed. `ACK` completes the job; `FAIL` schedules retry or moves an exhausted job to the dead set according to retry policy.

Kafka is related but claims partitions rather than individual records. With the classic group protocol, `session.timeout.ms` detects missing heartbeats; in Kafka 4.1 the documented client default is 45 seconds. Separately, `max.poll.interval.ms` defaults to five minutes and bounds the delay between `poll()` calls. Exceeding either boundary can cause reassignment, but the details differ for static members and for the newer consumer group protocol. The [Kafka 4.1 consumer configuration](https://kafka.apache.org/41/generated/consumer_config.html) is the authoritative place to check those branches. Rebalancing preserves the partition log's record order, but a replacement consumer resumes from the committed offset, so records processed after the last successful commit may be processed again.

Temporal does not directly detect a crashed Activity worker. Its Go SDK states this explicitly: a running Activity is detected as failed through Start-to-Close expiry, or sooner through a configured Heartbeat Timeout when the Activity records heartbeats ([Activity options](https://github.com/temporalio/sdk-go/blob/main/internal/activity.go)). Sticky Workflow Task queues are separate. Their worker-specific identity changes across restarts, and a default five-second sticky schedule-to-start timeout moves an unclaimed task back to the normal queue ([sticky-queue architecture](https://github.com/temporalio/sdk-rust/blob/main/arch_docs/sticky_queues.md)). Mixing Activity failure detection with sticky Workflow Task fallback obscures two different mechanisms.

## Owner-Scoped Resources

PostgreSQL provides precise exclusion inside the database. Row locks acquired by `SELECT ... FOR UPDATE` are released at transaction end, and `SKIP LOCKED` lets other transactions ignore currently locked rows. PostgreSQL describes this as useful for multiple consumers accessing a queue-like table, while warning that it presents an inconsistent view unsuitable for general-purpose reads ([`SELECT` documentation](https://www.postgresql.org/docs/current/sql-select.html)).

That guarantee is narrower than “a worker crash instantly requeues the job.” It says conflicting database ownership ends when the transaction ends. A lost client connection eventually makes the server end the session and roll back its transaction, but detection latency depends on the connection path and failure mode. More importantly, if the application committed a `running` marker before doing the work, transaction-end lock release does not undo that marker.

PostgreSQL advisory locks have application-defined meaning. A session-level advisory lock remains until explicitly unlocked or the database session ends; a transaction-level advisory lock ends with its transaction. PostgreSQL notes that session locks ignore transaction rollback and that all advisory-lock users must follow the same application convention ([explicit-locking documentation](https://www.postgresql.org/docs/current/explicit-locking.html)).

The Ruby queue [Que](https://github.com/que-rb/que) uses PostgreSQL advisory locks so a job held by a terminated database session becomes available to another worker. [GoodJob](https://github.com/bensheldon/good_job) also defaults to advisory locking and offers `:skiplocked` and hybrid strategies. Its documentation makes the operational boundary concrete: session-level state requires a persistent connection and is incompatible with PgBouncer transaction mode, while `:skiplocked` mode can work there when LISTEN/NOTIFY and advisory-lock heartbeat features are disabled. That is a compatibility boundary, not evidence that a pooler will silently preserve a dead client's lock forever.

RabbitMQ binds manual delivery acknowledgements to a channel. If the channel or connection closes before acknowledgement, the broker [automatically requeues the delivery](https://www.rabbitmq.com/docs/confirms). This is an exact broker-side transition once closure is known, but RabbitMQ cautions that detecting an unavailable client takes time. Heartbeats help detect dead TCP peers. RabbitMQ also has a delivery-acknowledgement timeout with a 30-minute default; in RabbitMQ 4.3 that timeout is supported for quorum queues and can be configured or disabled ([consumer documentation](https://www.rabbitmq.com/docs/consumers)). Requeue placement is the original position when possible, otherwise closer to the queue head under concurrent delivery and acknowledgement; it is not a universal FIFO guarantee.

## Durable Reconciliation Is Still Time-Based

Sidekiq's basic fetch removes a job from Redis, so a process crash can lose it. Sidekiq Pro `super_fetch` instead uses `LMOVE` to keep work in a per-process private queue until completion. The durable private queue makes recovery possible, but startup alone is not proof that every other private queue is orphaned. The official [Sidekiq reliability guide](https://github.com/sidekiq/sidekiq/wiki/Reliability) requires an expired process heartbeat and a one-minute guard before startup recovery, and performs a complete Redis `SCAN` at most once an hour. Its documented recovery time can range from minutes to hours. This is durable ownership plus timeout-based reconciliation, not a clock-free fast path.

Oban likewise persists an `executing` state. During orderly shutdown, queues stop fetching and allow running jobs a configurable grace period, 15 seconds by default. Jobs still executing after a hard shutdown may remain orphaned ([Oban troubleshooting](https://oban.hexdocs.pm/troubleshooting.html)). The base [Oban Lifeline](https://oban.hexdocs.pm/Oban.Lifeline.html) periodically moves old `executing` jobs back to `available`; it is explicitly time-based, defaults to rescuing after one hour, and warns that a genuinely running job can be rescued and executed twice. Oban Pro offers more accurate node-liveness tracking, but that is a different mechanism and should not be inferred from the base plugin.

These examples expose a recurring pattern: a durable in-progress record prevents loss, while a separate liveness or age signal makes the record recoverable. Persisting owner identity improves diagnosis and can narrow the recovery set, but does not by itself prove that an owner is dead.

## Where “No False Positives” Stops

An owner-scoped lock can guarantee that only one current database session or broker channel holds a particular claim. It cannot guarantee that only one execution has affected the outside world.

Suppose worker A charges a payment, then loses its database connection before committing the job result. PostgreSQL releases A's lock and worker B legitimately acquires it. Both lock decisions are correct, yet B may charge the payment again. The ambiguity lies between the external effect and the durable completion record, not inside the lock manager.

Network partitions also separate application liveness from authority. A worker may still be computing after its lease expires, its Kafka partitions are revoked, or its database session is closed. The recovery authority may correctly allow a successor to proceed, while the old worker has not physically stopped. A generation number or fencing token can make stale writes rejectable at a cooperating storage service, but cannot fence an arbitrary API that does not validate the token.

Therefore use narrower claims:

- Transaction and session locks provide mutually exclusive ownership while the authoritative lock exists.
- Deadlines bound how long ownership survives without renewal, at the cost of possible overlap with slow or partitioned workers.
- Heartbeats reduce failure-detection latency but remain timeout observations.
- Durable reconciliation prevents abandoned records from becoming permanently invisible, but its precision depends on the owner-liveness signal.
- Exactly-once effects require cooperation from the effect sink or an atomic protocol around it.

## Choosing a Recovery Authority

Use a renewable deadline when workers are remote, processing duration is bounded or heartbeatable, and the broker cannot observe a stronger ownership primitive. Size the initial deadline from a conservative execution bound, renew it during legitimate long work, and measure expiries and redeliveries. Do not treat a global default as workload tuning.

Use transaction- or session-scoped locks when the database can remain the ownership authority for the full claim lifetime. Decide explicitly whether holding a transaction open across job execution is acceptable. If the durable state is committed before work begins, add a recovery rule for that state rather than assuming the former row lock still protects it.

Use broker channel ownership when delivery and acknowledgement already live inside that broker, as with RabbitMQ. Configure heartbeats and acknowledgement timeouts with the slowest valid handler in mind, and expect redelivery after connection failure.

Use durable per-owner in-progress records when losing a job is worse than delayed recovery. Store enough identity to reconcile narrowly, but document the heartbeat expiry, scan cadence, and poison-job policy as part of the recovery contract.

For every approach, make the business operation retry-safe. Prefer an idempotency key accepted by the downstream service. When database state must cause an external message, use a transactional outbox and make the consumer idempotent. When a downstream store supports fencing, pass a monotonically increasing generation and reject stale generations there.

## Design Checklist

- What exact object represents ownership: a deadline, group generation, broker delivery tag, row lock, advisory lock, or durable owner record?
- Which component is authoritative for revocation, and what observation causes it to revoke?
- Can the old worker continue computing after revocation? If so, which writes can be fenced?
- Is recovery latency bounded by a documented timeout, heartbeat expiry, scan interval, or database connection detection path?
- Does completing or abandoning work atomically update the same object that grants ownership? If not, what reconciles the gap?
- Does the handler use a downstream idempotency key, unique result record, transactional outbox, or another effect-level deduplication mechanism?
- What happens to ordering on redelivery for this exact queue type and configuration?
- Are `claimed_at` and heartbeat timestamps control inputs or only observability signals? Name one authority rather than allowing two independent reclaimers to race.
- Which negative test proves the mechanism works: kill after the external effect but before acknowledgement, partition the worker from the authority, hold work past its deadline, and restart during recovery.

The durable lesson is not that restart beats timeout. Recovery becomes understandable only when ownership, revocation, rediscovery, and external effects are modeled separately. Locks can make ownership exact. Timeouts can make recovery bounded. Neither one, alone, closes the side-effect gap.

---

*Sources: [Amazon SQS visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html), [Amazon SQS at-least-once delivery](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues-at-least-once-delivery.html), [Amazon SQS dead-letter queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html), [beanstalkd protocol](https://github.com/beanstalkd/beanstalkd/blob/master/doc/protocol.txt), [Faktory protocol specification](https://github.com/contribsys/faktory/blob/main/docs/protocol-specification.md), [Kafka 4.1 consumer configuration](https://kafka.apache.org/41/generated/consumer_config.html), [Temporal Activity options](https://github.com/temporalio/sdk-go/blob/main/internal/activity.go), [Temporal sticky-queue architecture](https://github.com/temporalio/sdk-rust/blob/main/arch_docs/sticky_queues.md), [PostgreSQL `SELECT`](https://www.postgresql.org/docs/current/sql-select.html), [PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html), [Que](https://github.com/que-rb/que), [GoodJob](https://github.com/bensheldon/good_job), [RabbitMQ acknowledgements](https://www.rabbitmq.com/docs/confirms), [RabbitMQ consumers](https://www.rabbitmq.com/docs/consumers), [Sidekiq reliability](https://github.com/sidekiq/sidekiq/wiki/Reliability), [Oban troubleshooting](https://oban.hexdocs.pm/troubleshooting.html), [Oban Lifeline](https://oban.hexdocs.pm/Oban.Lifeline.html).*
