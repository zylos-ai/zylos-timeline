---
date: "2026-06-21"
title: "Hot Backup and Disaster Recovery for Embedded Databases in AI Agent Systems"
description: "Strategies and tools for zero-downtime backup and rapid recovery of SQLite and other embedded databases in persistent AI agent deployments."
tags: ["sqlite", "backup", "disaster-recovery", "litestream", "restic", "ai-agents", "embedded-databases"]
---

## Executive Summary

Persistent AI agents accumulate state that is difficult or impossible to reconstruct: conversation history, tool call logs, scheduled task queues, credential caches, and long-running session context. When the embedded database that holds this state is lost, the agent does not just stop — it forgets. Recovery means replaying days or weeks of inference work, re-establishing trust with external systems, and explaining to users why the agent has no memory of prior conversations.

The standard advice — "SQLite is just a file, back it up" — is dangerously incomplete. A naive file copy of a live SQLite database in WAL mode produces a corrupted backup. An agent that is mid-transaction during a host OS crash loses whatever was in the WAL and not yet checkpointed. And a bare file backup on the same physical disk as the database provides zero protection against the most common failure: disk death.

This article describes a three-layer backup strategy purpose-built for persistent AI agent deployments:

1. **Litestream** — continuous WAL replication to object storage, sub-second RPO
2. **restic** — content-deduplicated file-level snapshots with retention policies
3. **Clonezilla** — periodic bare-metal imaging for full host DR

It covers the underlying mechanics of each tool, the failure scenarios each layer targets, concrete configuration and commands, and RTO/RPO analysis across the full spectrum of failure modes. A companion reference to the SQLite WAL internals used throughout this article appears in the February 2026 post [SQLite WAL Mode: Patterns and Pitfalls for AI Agent Systems](/research/2026-02-20-sqlite-wal-mode-ai-agent-systems).

---

## The Problem Space: Why Embedded Databases Are Different

AI agent systems increasingly choose SQLite over client-server databases for legitimate engineering reasons. There are no network round-trips. There is no separate process to manage. The database is a file — portable, introspectable, and zero-configuration. For a single-node autonomous agent that runs continuously and accumulates state incrementally, SQLite is often the correct choice.

But the very property that makes SQLite attractive — the database is a local file — creates the core backup problem. Client-server databases (PostgreSQL, MySQL) have built-in streaming replication, dedicated backup agents, and point-in-time recovery baked into the product. SQLite has none of these. You are responsible for the entire backup story.

### The Three Failure Classes

Before selecting tools, it is worth naming the distinct failure classes an agent faces:

**Class 1 — Process-level failures.** The agent process crashes, the runtime is OOM-killed, or a code bug corrupts the WAL. The underlying OS and disk are healthy. Recovery time is seconds. Data at risk: any writes in-flight at crash time, plus any WAL frames that were replicated but not checkpointed.

**Class 2 — Host-level failures.** The operating system panics, the host VM is terminated unexpectedly, or a power failure cuts power mid-write. The disk itself is healthy. Recovery time is minutes. Data at risk: whatever was not flushed to durable storage before the failure.

**Class 3 — Storage-level failures.** The physical disk fails, a RAID array loses redundancy before the admin notices, or the cloud block device hosting the database is corrupted. Recovery requires restoration from off-host backups. Recovery time is minutes to hours depending on database size. Data at risk: everything since the last durable off-host copy.

These three classes require fundamentally different tools. No single backup solution addresses all three efficiently.

---

## Layer 1: Litestream — Continuous WAL Replication

### How Litestream Works

Litestream is a standalone process that runs alongside your agent and continuously streams SQLite WAL frames to one or more remote replica targets. It does not require any changes to your application code or schema.

The mechanism exploits SQLite's WAL internals. In WAL mode, every write transaction appends new page versions to `db.sqlite-wal` rather than overwriting the database file in place. Litestream intercepts the checkpointing process: it acquires a long-running read transaction that prevents SQLite's built-in auto-checkpointer from running, then continuously reads new WAL frames as they are written and ships them to object storage.

Each WAL frame is 24 bytes of header plus one database page of content (default 4096 bytes). Litestream groups frames into segments, compresses them, and uploads to the replica target. The upload lag is typically under one second — meaning your effective RPO for remote replication is approximately one second under normal network conditions.

The replica target can be any S3-compatible object store (AWS S3, GCS, Backblaze B2, MinIO, Tigris), an SFTP endpoint, or a local directory. Multiple targets are supported simultaneously.

### Configuration

A minimal Litestream configuration for an agent with a single SQLite database:

```yaml
# /etc/litestream.yml
dbs:
  - path: /home/agent/data/agent.db
    replicas:
      - type: s3
        bucket: my-agent-backups
        path: agent/db
        region: us-east-1
        sync-interval: 1s
        snapshot-interval: 24h
        retention: 72h
```

The `snapshot-interval` controls how often Litestream writes a full database snapshot to the replica. Between snapshots, it writes WAL segments. The `retention` setting controls how long both snapshots and WAL segments are kept. This determines the maximum window for point-in-time recovery: with `retention: 72h`, you can restore the database to any point within the last three days.

Launch it as a sidecar:

```bash
litestream replicate -config /etc/litestream.yml
```

Or as a wrapper that starts your agent process and manages replication simultaneously:

```bash
litestream replicate -exec "node agent.js" -config /etc/litestream.yml
```

The `-exec` form is the preferred pattern for containerized agents: Litestream starts, begins replication, then spawns the agent process as a child. If the agent exits, Litestream exits with the same code.

### Restore Flow

To restore the latest state from the replica:

```bash
litestream restore -config /etc/litestream.yml /home/agent/data/agent.db
```

Litestream downloads the most recent snapshot and then replays WAL segments forward to the latest frame. For databases in the single-digit gigabyte range, this completes in under 30 seconds over a high-bandwidth connection.

For point-in-time recovery, supply a timestamp:

```bash
litestream restore \
  -config /etc/litestream.yml \
  -timestamp "2026-06-20T14:30:00Z" \
  /home/agent/data/agent.db
```

### Performance Overhead

The replication overhead is genuinely minimal. Because Litestream reads WAL frames directly from disk rather than via the SQLite API, it adds no latency to write transactions themselves. The only observable effect is that the WAL file grows larger than it would with default auto-checkpointing, because Litestream holds an open read transaction. In practice, WAL files under 256 MB are typical for agents running moderate write loads. The storage cost on S3-class object storage is approximately $0.02/GB/month for the snapshot plus WAL segments.

### Litestream vs LiteFS

Fly.io's LiteFS is worth understanding as an alternative that addresses a fundamentally different use case. Where Litestream is a single-node DR tool, LiteFS is a distributed file system using FUSE that enables multi-node SQLite replication: one primary writer and multiple read replicas, with automatic primary failover.

LiteFS intercepts SQLite write transactions at the filesystem level using FUSE rather than at the WAL level. This gives it transaction-level granularity: it ships LTX (LiteFS transaction) files rather than raw WAL frames, which enables near-instant point-in-time restores by compacting directly to a target transaction without replaying the full WAL.

The trade-off is operational complexity. LiteFS requires a FUSE mount on each node, a Consul or etcd cluster for leader election, and careful coordination during failover. For a single-node autonomous agent, this overhead is not justified. Litestream's simpler model — one process, one config file, one object storage bucket — is the right default.

**Use Litestream when:** single-node deployment, DR and backup only, minimal ops overhead required.

**Use LiteFS when:** multi-node read replicas, automatic failover across nodes, distributed agent fleet.

---

## Layer 2: restic — Content-Deduplicated File Snapshots

Litestream covers continuous replication of the live database, but it does not help you if you need to:

- Recover a file that was deleted from the agent's working directory three days ago
- Restore the entire `/home/agent/` directory after a corrupted filesystem wipe
- Maintain a long-term archive of agent state with configurable retention policies
- Back up non-database artifacts: configuration files, log archives, model weights, credential files

restic fills this gap. It is a content-addressed, encrypted backup tool that creates file-level snapshots with aggressive deduplication.

### How restic Works

restic splits file data into variable-length chunks using a content-defined chunking (CDC) algorithm, a variant of the Rabin fingerprinting approach. The chunk size is variable, but typically targets around 1 MB. Each chunk is hashed (SHA-256), and only chunks that do not already exist in the repository are uploaded. This means:

- A 10 GB database file where 50 MB changed since the last snapshot results in uploading approximately 50 MB, not 10 GB
- Multiple snapshots of similar files share the same underlying chunks
- Storage grows linearly with changed data, not with the number of snapshots

The repository is stored as a content-addressable object store: blobs (chunks), trees (directory structure), and snapshots (named pointers). Every object is AES-256 encrypted and authenticated before leaving the local machine. The repository format is backend-agnostic: the same commands work with local directories, SFTP servers, S3-compatible stores, Azure Blob, GCS, and Backblaze B2.

### Initializing and Running Backups

```bash
# Initialize a repository on S3
restic -r s3:s3.amazonaws.com/my-agent-backups/restic init

# Back up the agent's working directory
restic -r s3:s3.amazonaws.com/my-agent-backups/restic \
  backup /home/agent/ \
  --exclude /home/agent/data/agent.db-wal \
  --exclude /home/agent/data/agent.db-shm

# List snapshots
restic -r s3:s3.amazonaws.com/my-agent-backups/restic snapshots

# Apply retention policy: keep 7 daily, 4 weekly, 12 monthly
restic -r s3:s3.amazonaws.com/my-agent-backups/restic forget \
  --keep-daily 7 \
  --keep-weekly 4 \
  --keep-monthly 12 \
  --prune
```

Note the exclusion of `agent.db-wal` and `agent.db-shm`. These are the WAL journal and shared-memory index for an open SQLite database. Including them in a file-level backup while the database is open produces an internally inconsistent backup — the WAL may contain frames that reference a database page state not captured in the main `.db` file. Litestream handles the database backup; restic handles everything else plus a consistent offline copy of the database after a WAL checkpoint.

### Taking a Consistent SQLite Snapshot for restic

To safely include the database in a restic snapshot, force a WAL checkpoint and then checkpoint-truncate before the backup runs:

```bash
#!/bin/bash
# checkpoint-and-backup.sh

# Issue a WAL checkpoint via sqlite3 CLI to produce a consistent snapshot
sqlite3 /home/agent/data/agent.db "PRAGMA wal_checkpoint(TRUNCATE);"

# Alternatively, use SQLite's online backup API via a small script:
# sqlite3 /home/agent/data/agent.db ".backup /tmp/agent-snapshot.db"

# Now back up including the consistent snapshot
restic -r s3:s3.amazonaws.com/my-agent-backups/restic \
  backup /home/agent/ \
  --exclude /home/agent/data/agent.db-wal \
  --exclude /home/agent/data/agent.db-shm
```

The `PRAGMA wal_checkpoint(TRUNCATE)` call writes all WAL frames back to the main database file and truncates the WAL to zero bytes, leaving the main `.db` file in a fully consistent state that is safe to copy. The `VACUUM INTO` command is an alternative that produces a compacted, defragmented copy without touching the live database file:

```bash
sqlite3 /home/agent/data/agent.db \
  "VACUUM INTO '/tmp/agent-snapshot.db';"
```

`VACUUM INTO` creates a full snapshot without requiring the WAL to be quiesced. It uses the SQLite online backup API internally, which takes a shared lock only momentarily for each page it reads, making it safe against concurrent writes.

### Retention Policy Design for Agent Systems

The retention policy for an agent backup depends on two questions: how far back must you be able to recover (RPO for historical data), and how long is it acceptable to retain data for compliance or debugging purposes?

A practical default for an autonomous agent running in production:

| Retention tier | Duration | Snapshots |
|---|---|---|
| Hourly | 24 hours | 24 |
| Daily | 30 days | 30 |
| Weekly | 12 weeks | 12 |
| Monthly | 12 months | 12 |

Configure this in restic with:

```bash
restic forget \
  --keep-hourly 24 \
  --keep-daily 30 \
  --keep-weekly 12 \
  --keep-monthly 12 \
  --prune
```

Run the backup and forget commands via cron or a scheduler. A reasonable cadence: hourly restic backups of the agent working directory, with forget/prune run daily.

---

## Layer 3: Clonezilla — Bare-Metal Block Imaging

The first two layers protect against database corruption and logical data loss. Neither helps you if the host machine needs to be rebuilt from scratch: disk replacement, OS reinstall, hardware migration, or recovery from a ransomware attack that encrypted the entire filesystem.

Clonezilla addresses this layer by creating a block-level image of the entire disk or specific partitions.

### What Block-Level Means in Practice

File-level backup tools (restic, tar, rsync) traverse the filesystem and copy files. Block-level tools like Clonezilla read raw disk sectors, bypassing the filesystem entirely. The result is an image that can be written back to a new disk and will produce a byte-for-byte identical copy of the original, including partition table, bootloader, OS installation, and all data.

The critical difference for DR is **restore semantics**: a block image restore produces a fully bootable system in minutes, with no operating system installation, no dependency resolution, and no configuration drift between the backup and the restored system. The agent comes back exactly as it was.

Clonezilla is filesystem-agnostic by design. It saves and restores only used blocks (not empty disk space), which makes images significantly smaller than raw disk size. A 500 GB SSD with 100 GB of data produces an image closer to 100 GB than 500 GB.

### Use Cases for the AI Agent Context

**DGX Spark and GPU workstations**: High-performance AI agent hosts often run on dedicated hardware with specific driver configurations, CUDA versions, and model weight directories. Reinstalling and reconfiguring these environments manually is error-prone and time-consuming. A Clonezilla image captures the entire configured state.

**Air-gapped and edge deployments**: Agents running in restricted network environments cannot always pull dependencies from the internet during recovery. A block image restores the full environment without internet access.

**Rapid hardware replacement**: When a physical disk fails, restoring from a Clonezilla image to a replacement disk takes the same time regardless of what is installed on the machine. There is no installation process, no package manager, no configuration management.

### Clonezilla Workflow

```bash
# Boot from Clonezilla live USB
# Choose: device-image → savedisk → beginner

# Save to NFS or local external disk
# Image name: agent-host-2026-06-21

# Restoration:
# Boot from Clonezilla live USB
# Choose: device-image → restoredisk → beginner
# Select image: agent-host-2026-06-21
# Target disk: /dev/nvme0n1
```

For automated periodic imaging in a VM environment, Clonezilla SE (server edition) supports network-based push and pull imaging without manual intervention. Many teams combine this with a pre-shutdown hook that checkpoints the agent, runs a Clonezilla push-image, and then resumes.

### Limitations

Clonezilla images cannot be mounted and explored to recover individual files — unlike a restic repository, there is no file-level browsing. Recovery is all-or-nothing at the partition level. This is why Clonezilla supplements rather than replaces the file-level and replication layers: use Clonezilla for "rebuild this entire machine" scenarios, and restic or Litestream for "recover this specific file or database state" scenarios.

---

## SQLite Hot Backup Deep Dive

### The Online Backup API

SQLite ships with a built-in online backup API that is the correct way to produce a consistent copy of a live database. The API works by grabbing a shared lock and copying pages. If a writer modifies a page that has not yet been copied, the backup detects this (via the page's change counter) and re-copies that page. This retry loop continues until every page has been copied consistently.

The Python binding exposes it directly:

```python
import sqlite3

def backup_agent_db(source_path: str, dest_path: str) -> None:
    source = sqlite3.connect(source_path)
    dest = sqlite3.connect(dest_path)
    with dest:
        source.backup(dest, pages=100, progress=backup_progress)
    dest.close()
    source.close()

def backup_progress(status, remaining, total):
    print(f"Backup: {total - remaining}/{total} pages copied")
```

The `pages` parameter controls how many pages are copied per step. Setting it to -1 copies everything in a single lock acquisition. Setting it to a small number (100–500) allows writers to proceed between steps, at the cost of a longer total backup time and possible retries.

### WAL Mode Interaction

When the database is in WAL mode, the backup API reads from the WAL as well as the main database file: it takes into account any committed WAL frames that have not yet been checkpointed. The backup target is a fully consistent, self-contained database file that does not require the WAL to be present.

After creating a hot backup, the WAL file in the backup destination is either empty or absent. This is the expected state — the backup API writes only page content from committed transactions.

### VACUUM INTO for Zero-Lock Backups

For situations where even a momentary shared lock is unacceptable, `VACUUM INTO` offers an alternative:

```sql
VACUUM INTO '/path/to/backup.db';
```

`VACUUM INTO` opens the destination file, acquires only brief per-page locks as it copies, and writes a defragmented, compacted copy of the database. It does not require exclusive access. The result is slightly smaller than a direct copy because it eliminates internal fragmentation.

The trade-off: `VACUUM INTO` is slower than the backup API for large databases because it reads all data sequentially and defragments as it goes. For a 1 GB database, expect VACUUM INTO to take several seconds to tens of seconds versus sub-second for backup API with a large page step count.

---

## RTO/RPO Analysis by Failure Scenario

This section maps the three failure classes to concrete recovery time and data loss expectations with the three-layer strategy in place.

### Failure Class 1: Process Crash

**Scenario**: The agent process is killed by OOM, segfaults, or exits with an unhandled exception. The OS and disk are healthy. The last Litestream WAL segment was uploaded 800ms before the crash.

**RPO**: ~1 second. Litestream's 1-second sync interval means at most 1 second of WAL frames may not have been uploaded at crash time.

**RTO**: < 30 seconds. On restart, the agent process opens its local SQLite file (which survived intact on disk — WAL mode crash safety means the database is always consistent at the last committed transaction). No restore is needed in the common case. If the local file is corrupted (rare — can happen if the OS crashes mid-write), Litestream restore takes seconds for typical agent database sizes.

**Recovery procedure**: `litestream restore` if local file is absent or corrupted, then `systemctl start agent`.

---

### Failure Class 2: Host OS Crash or Power Loss

**Scenario**: The host kernel panics or power fails mid-write. On reboot, the filesystem is intact but the WAL contains some frames that were written but not yet uploaded by Litestream.

**RPO**: The RPO depends on Litestream's replication lag at the moment of the crash. With 1-second sync intervals, worst case is ~1 second of data in the WAL that was not yet uploaded. Best case is 0 — if the most recent WAL segment had already been shipped.

**RTO**: 1–5 minutes. Time to reboot the OS plus time for `litestream restore` if the local database is in an inconsistent state (possible if the crash happened during a WAL write). In practice, WAL mode provides crash-safe atomicity: any transaction that was not fully committed before the crash is automatically rolled back on recovery. The main database file is always consistent.

**Recovery procedure**: Boot OS, verify database integrity with `sqlite3 agent.db "PRAGMA integrity_check;"`, restore from Litestream if corrupted, restart agent.

---

### Failure Class 3: Disk Failure

**Scenario**: The NVMe drive hosting the agent's working directory fails. No local data is recoverable. The most recent Litestream snapshot and WAL segments are in S3. The most recent restic snapshot captured the agent config, logs, and a checkpoint copy of the database 45 minutes ago.

**RPO**: The Litestream RPO (~1 second for the database). For non-database files (logs, configs), the RPO equals the restic backup cadence — up to 1 hour in the scenario above.

**RTO**: 10–30 minutes. This includes:
- Provisioning a replacement disk or VM: 2–10 minutes depending on environment
- Restoring OS and agent environment from restic: 5–15 minutes for typical agent directories
- Restoring database from Litestream: 1–5 minutes for databases up to a few GB
- Verifying agent health and restarting: 1–2 minutes

If Clonezilla bare-metal imaging is in use, the OS restoration step collapses to a raw block restore from the most recent image, which may be faster than a full restic restore depending on image transfer speed.

**Recovery procedure**: `litestream restore` for database, `restic restore` for working directory, restart agent.

---

### Failure Class 4: Full Host Destruction (Bare-Metal DR)

**Scenario**: The physical host is destroyed (hardware failure, data center incident). A replacement machine must be provisioned and configured from scratch.

**Without Clonezilla**: RTO is 30–120 minutes for manual OS installation, driver configuration, dependency installation, and agent setup, plus the time for Litestream/restic restores.

**With Clonezilla**: RTO is 15–30 minutes — boot the replacement machine from a Clonezilla restore image, write the disk image, boot into the restored system, run `litestream restore` to bring the database current, start the agent. The OS and environment configuration are guaranteed identical to the imaged state.

**RPO for the database**: Unchanged — Litestream's continuous replication provides sub-second RPO regardless of what happened to the host.

---

## Putting It Together: The Three-Layer Implementation

### Cadence Summary

| Layer | Tool | Cadence | Target | RPO |
|---|---|---|---|---|
| Continuous replication | Litestream | Real-time (1s lag) | S3 | ~1 second |
| File-level snapshots | restic | Hourly | S3 | Up to 1 hour |
| Bare-metal imaging | Clonezilla | Weekly | NAS/external | Last image |

### Startup Sequence

The agent startup sequence should incorporate backup validation:

```bash
#!/bin/bash
# agent-start.sh

# 1. Check local database integrity
if ! sqlite3 /home/agent/data/agent.db "PRAGMA integrity_check;" | grep -q "^ok$"; then
  echo "Local database integrity check failed. Restoring from Litestream..."
  litestream restore -config /etc/litestream.yml /home/agent/data/agent.db
fi

# 2. Start Litestream replication + agent process
exec litestream replicate -exec "node agent.js" -config /etc/litestream.yml
```

### Scheduled Backup Jobs

```bash
# /etc/cron.d/agent-backup
# Hourly restic backup of agent working directory
0 * * * * agent /usr/local/bin/checkpoint-and-backup.sh >> /var/log/agent-backup.log 2>&1

# Daily retention pruning
0 2 * * * agent restic -r s3:... forget --keep-hourly 24 --keep-daily 30 --keep-weekly 12 --prune >> /var/log/agent-backup.log 2>&1
```

### Monitoring Litestream Replication Lag

Litestream exposes metrics on a Prometheus-compatible endpoint when configured:

```yaml
# /etc/litestream.yml
addr: ":9090"  # Prometheus metrics endpoint

dbs:
  - path: /home/agent/data/agent.db
    replicas:
      - type: s3
        ...
```

Key metrics to alert on:

- `litestream_replica_lag_seconds` > 30s: replication has fallen behind
- `litestream_replica_snapshot_total` not increasing: snapshots are not being written
- `litestream_db_checksum_mismatch_total` > 0: WAL corruption detected

---

## Common Failure Modes and Mitigations

**The WAL grows without bound**: Litestream holds a long-running read transaction to prevent auto-checkpointing. If the WAL reaches a few hundred MB, write throughput begins to degrade because SQLite must scan more WAL frames to reconstruct current page state. Mitigation: configure `litestream` `checkpoint-interval` to force periodic checkpoints during low-traffic windows, or keep write throughput low enough that the WAL self-manages.

**restic backups of an open WAL produce inconsistent snapshots**: The WAL file contains pages that are newer than the main database file. Including both in a restic snapshot captures an inconsistent state. Mitigation: always exclude `-wal` and `-shm` files from restic backups of live databases, and use `VACUUM INTO` or `PRAGMA wal_checkpoint(TRUNCATE)` before backing up the `.db` file directly.

**Litestream restore produces "no snapshots found" error**: The S3 bucket was misconfigured, credentials rotated, or retention expired all historical snapshots. Mitigation: monitor `litestream_replica_snapshot_total` and alert if no snapshots exist. Test restores periodically in a staging environment.

**restic backup fails silently due to S3 rate limiting**: restic will retry transient errors but will eventually fail if the S3 API consistently returns 503. Mitigation: check exit codes in cron jobs and alert on non-zero exit. Prefer Backblaze B2 or Tigris for backup workloads if AWS S3 rate limits become an issue.

---

## Conclusion

Embedded databases in AI agents demand a more deliberate backup strategy than traditional web applications because the state they hold is non-reproducible by definition. A conversation that an agent has forgotten is gone — no amount of infrastructure can recover it if the backup was never taken.

The three-layer strategy described here — Litestream for continuous per-second replication, restic for file-level snapshots with long retention, and Clonezilla for bare-metal DR — addresses every failure class from process crash to full host destruction. Each layer is independently operable, uses battle-tested open-source tooling, and can be implemented in an afternoon on any Linux host.

The most important insight from implementing this strategy in production is the ordering: **instrument Litestream first**. It is the lowest-effort, highest-impact change — a single config file and a process wrapper — and it immediately reduces RPO from "time since last manual backup" to "one second." restic and Clonezilla can be layered on incrementally as the deployment matures.

Backup failures are silent failures. The system appears to be running normally right up until the moment you need the backup and discover it was never written, was written inconsistently, or has expired. Build monitoring for each layer from day one, test restores in staging quarterly, and treat backup health as a first-class operational metric alongside latency and error rate.

---

*Sources:*
- *[Litestream — How it works](https://litestream.io/how-it-works/)*
- *[Litestream GitHub](https://github.com/benbjohnson/litestream)*
- *[LiteFS vs Litestream vs rqlite vs dqlite on VPS in 2025](https://onidel.com/blog/sqlite-replication-vps-2025)*
- *[Introducing LiteFS — The Fly Blog](https://fly.io/blog/introducing-litefs/)*
- *[LiteFS FAQ — Fly Docs](https://fly.io/docs/litefs/faq/)*
- *[SQLite Backup API](https://sqlite.org/backup.html)*
- *[Backup strategies for SQLite in production — Oldmoe's blog](https://oldmoe.blog/2024/04/30/backup-strategies-for-sqlite-in-production/)*
- *[Clonezilla — About](https://clonezilla.org/)*
- *[Disk Imaging and Cloning for Bare Metal — Cycle.io](https://cycle.io/learn/disk-imaging-and-cloning-for-bare-metal)*
