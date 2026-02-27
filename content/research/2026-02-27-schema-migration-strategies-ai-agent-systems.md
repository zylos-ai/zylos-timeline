---
date: "2026-02-27"
title: "Schema Migration Strategies for Evolving AI Agent Systems"
description: "Patterns and practices for safely evolving database schemas and tool contracts in production AI agent deployments without downtime."
tags: ["schema-migration", "database", "ai-agents", "devops", "sqlite", "multi-tenant"]
---

## Executive Summary

AI agent systems are not static — they evolve. New tools get added, memory structures change, multi-tenant requirements emerge, and the underlying data models shift as the agent's capabilities expand. This creates a fundamental engineering challenge: how do you change a live system without breaking it?

Schema migration is often treated as a solved problem in traditional web applications, but AI agent deployments present unique complications. Agents maintain persistent state across sessions, operate in embedded SQLite environments, expose tool contracts that LLMs depend on, and sometimes run in multi-tenant configurations where a bad migration can affect hundreds of users simultaneously. The cost of getting it wrong is high — corrupted memory, broken tool calls, and agent failures that are difficult to diagnose.

This article covers the patterns and tools for schema evolution in production AI agent systems: from the foundational expand-and-contract pattern to multi-tenant migration orchestration, tool schema versioning, and practical SQLite migration strategies for embedded agents like Zylos.

---

## The Schema Migration Problem in AI Agents

Traditional web applications deal with schemas that change infrequently and in well-understood ways: add a column, rename a table, create an index. AI agent systems face a more complex landscape.

**Persistent agent memory** means the database contains not just structured data but serialized state — conversation histories, learned preferences, task queues. A schema change that drops a column containing serialized JSON can silently corrupt weeks of accumulated memory.

**Tool contract evolution** introduces a second migration axis. When the schema defining an agent's tools changes — parameter names shift, new required fields appear, return types evolve — the LLM's internal representation of how to call those tools becomes stale. A renamed parameter that isn't handled backward-compatibly will cause structured outputs to fail in ways that look like model errors, not schema errors.

**Long-running agent processes** mean you can't simply restart the world. Unlike a stateless API server where rolling restart propagates schema changes cleanly, an agent that's mid-conversation with a user, mid-execution of a scheduled task, or holding open file handles needs the schema to remain stable under its feet.

**Embedded databases in single-process deployments** (SQLite in particular) eliminate some problems — no replication lag, no distributed transaction complexity — but introduce others: SQLite's extremely limited `ALTER TABLE` support means many migrations require table recreation, and there is no native zero-downtime path for those operations.

Understanding these constraints shapes which migration strategies apply.

---

## The Expand-and-Contract Pattern

The expand-and-contract pattern (also known as Parallel Change, coined by Martin Fowler) is the foundational technique for zero-downtime schema migrations. It decomposes a single breaking change into three non-breaking phases.

### Phase 1: Expand

Add new structures without removing existing ones. All additions must be backward compatible — the old application code must continue to work unchanged.

```sql
-- Old schema: users table with full_name
CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    full_name TEXT NOT NULL
);

-- Phase 1: Add new columns, keep old one
ALTER TABLE users ADD COLUMN first_name TEXT;
ALTER TABLE users ADD COLUMN last_name TEXT;
```

At the application layer, write to both old and new structures:

```typescript
async function updateUser(id: string, firstName: string, lastName: string) {
    await db.run(
        `UPDATE users SET
            full_name = ?,
            first_name = ?,
            last_name = ?
         WHERE id = ?`,
        [`${firstName} ${lastName}`, firstName, lastName, id]
    );
}
```

Deploy this version. Both old readers (using `full_name`) and new readers (using `first_name`/`last_name`) work correctly.

### Phase 2: Migrate

Run a background process to backfill historical records:

```typescript
async function migrateFullNames() {
    const rows = await db.all(
        `SELECT id, full_name FROM users WHERE first_name IS NULL`
    );

    for (const row of rows) {
        const parts = row.full_name.trim().split(' ');
        const first = parts[0];
        const last = parts.slice(1).join(' ') || '';

        await db.run(
            `UPDATE users SET first_name = ?, last_name = ? WHERE id = ?`,
            [first, last, row.id]
        );
    }
}
```

Process in batches to avoid locking. Verify completion before proceeding.

### Phase 3: Contract

Once all code reads from the new columns and the backfill is complete, drop the old column:

```sql
-- SQLite requires table recreation for DROP COLUMN (pre-3.35.0)
CREATE TABLE users_new (
    id INTEGER PRIMARY KEY,
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT ''
);

INSERT INTO users_new SELECT id, first_name, last_name FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
```

The key property of expand-and-contract: **each phase is independently deployable and independently rollbackable**. If phase 2 reveals a data quality problem, you roll back the application to phase 1 behavior and the database is unaffected.

---

## SQLite-Specific Migration Patterns

SQLite is the natural choice for embedded AI agent deployments. It requires no server process, performs well for single-agent workloads, and its WAL mode supports concurrent reads during writes. However, its schema modification limitations require specific strategies.

### What SQLite Supports Natively

SQLite's `ALTER TABLE` supports only:
- `ADD COLUMN` (with limitations: no `NOT NULL` without a default, no `UNIQUE`)
- `RENAME TABLE`
- `RENAME COLUMN` (since SQLite 3.25.0)
- `DROP COLUMN` (since SQLite 3.35.0, with restrictions)

Everything else — changing column types, adding constraints, modifying primary keys — requires the table-copy pattern.

### Table-Copy Migration

```typescript
async function migrateTable(db: Database) {
    await db.exec(`BEGIN TRANSACTION`);
    try {
        // Create new table with desired schema
        await db.exec(`
            CREATE TABLE messages_new (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
                content TEXT NOT NULL,
                metadata TEXT DEFAULT '{}',
                created_at INTEGER NOT NULL DEFAULT (unixepoch())
            )
        `);

        // Copy data, transforming as needed
        await db.exec(`
            INSERT INTO messages_new (id, session_id, role, content, created_at)
            SELECT id, session_id, role, content, created_at
            FROM messages
        `);

        // Atomic swap
        await db.exec(`DROP TABLE messages`);
        await db.exec(`ALTER TABLE messages_new RENAME TO messages`);

        await db.exec(`COMMIT`);
    } catch (err) {
        await db.exec(`ROLLBACK`);
        throw err;
    }
}
```

Wrap in a transaction for atomicity. SQLite guarantees the entire operation commits or rolls back as a unit.

### Schema Version Tracking

Track applied migrations in a dedicated table, not in application code:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL DEFAULT (unixepoch()),
    checksum TEXT NOT NULL
);
```

A minimal migration runner:

```typescript
interface Migration {
    version: number;
    name: string;
    up: (db: Database) => Promise<void>;
    down?: (db: Database) => Promise<void>;
}

async function runMigrations(db: Database, migrations: Migration[]) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at INTEGER NOT NULL DEFAULT (unixepoch()),
            checksum TEXT
        )
    `);

    const applied = new Set(
        (await db.all(`SELECT version FROM schema_migrations`))
            .map(r => r.version)
    );

    const pending = migrations
        .filter(m => !applied.has(m.version))
        .sort((a, b) => a.version - b.version);

    for (const migration of pending) {
        console.log(`Applying migration ${migration.version}: ${migration.name}`);
        await migration.up(db);
        await db.run(
            `INSERT INTO schema_migrations (version, name) VALUES (?, ?)`,
            [migration.version, migration.name]
        );
    }
}
```

### Handling SQLite WAL Mode During Migrations

If running with WAL mode (recommended for Zylos-style agents), be aware that large table recreations create a write checkpoint pressure. After major migrations, run `PRAGMA wal_checkpoint(TRUNCATE)` to compact the WAL file:

```typescript
async function postMigrationCleanup(db: Database) {
    await db.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
    await db.exec(`VACUUM`);
    await db.exec(`ANALYZE`);
}
```

---

## Tool Schema Versioning in LLM Agents

Beyond the database layer, AI agents have a second schema surface: the definitions of tools exposed to the LLM. These schemas — defined in OpenAI-compatible JSON Schema format — are part of the LLM's runtime context. When they change, the model's behavior can shift in subtle ways.

### The Tool Schema Contract

A tool definition contains:
- `name`: Must be stable; renames break the model's learned usage patterns
- `description`: Changes alter what the model infers the tool does
- `parameters`: Adding required parameters breaks existing prompts; removing parameters may confuse the model if it was trained with them

```typescript
interface ToolDefinition {
    name: string;
    description: string;
    input_schema: {
        type: "object";
        properties: Record<string, unknown>;
        required: string[];
    };
}
```

### Additive-Only Tool Evolution

Apply the same expand-before-contract principle to tool schemas. When adding a new parameter:

1. Add it as **optional** with a sensible default
2. Update the description to mention it
3. In a later version, make it required if truly needed

```typescript
// Version 1
const searchTool: ToolDefinition = {
    name: "search_memory",
    description: "Search agent memory for relevant information",
    input_schema: {
        type: "object",
        properties: {
            query: { type: "string", description: "Search query" }
        },
        required: ["query"]
    }
};

// Version 2: Add optional limit parameter (backward compatible)
const searchToolV2: ToolDefinition = {
    name: "search_memory",
    description: "Search agent memory for relevant information. Use limit to control result count.",
    input_schema: {
        type: "object",
        properties: {
            query: { type: "string", description: "Search query" },
            limit: {
                type: "integer",
                description: "Maximum results to return (default: 10)",
                default: 10
            }
        },
        required: ["query"]  // limit remains optional
    }
};
```

### Never Rename Tools

Renaming a tool is the most dangerous change. The LLM's system prompt, few-shot examples, and conversation history may all reference the old name. Instead, deprecate the old tool while introducing the new one:

```typescript
// Transitional period: expose both names
const tools = [
    searchToolNewName,    // new canonical name
    { ...searchToolNewName, name: "search_memory_v1", description: "[DEPRECATED] Use search_memory instead. " + searchToolNewName.description }
];
```

Route both to the same handler. Log calls to the deprecated name. Remove after confirming zero usage.

### Schema Compatibility in Multi-Model Deployments

When running multiple LLM models (e.g., a fast Claude Haiku for routing, Claude Sonnet for complex tasks), tool schemas are presented to each model independently. A schema change that's benign for one model may confuse another. Test tool schema changes against all models in use before deploying.

---

## Multi-Tenant Migration Orchestration

For AI agent platforms serving multiple users or organizations, schema migrations gain an additional dimension: coordinating changes across tenant namespaces while maintaining isolation guarantees.

### Shared Schema Pattern

Most practical multi-tenant deployments use a shared schema with a `tenant_id` discriminator column. Migrations in this model are straightforward — changes apply once to the shared schema:

```sql
-- Single migration applies to all tenants
ALTER TABLE conversations ADD COLUMN archived_at INTEGER;
CREATE INDEX idx_conversations_tenant_archived
    ON conversations(tenant_id, archived_at);
```

The tradeoff: the migration's lock window affects all tenants simultaneously. For large tables, use `CREATE INDEX CONCURRENTLY` (PostgreSQL) or time the migration during low-traffic windows.

### Schema Per Tenant Pattern

When using separate schemas per tenant (common for regulatory compliance), migrations must be applied to each tenant schema:

```typescript
async function migrateAllTenants(tenants: string[], migration: Migration) {
    const results = { success: [], failed: [] };

    for (const tenantId of tenants) {
        try {
            const db = await getTenantDatabase(tenantId);
            await migration.up(db);
            results.success.push(tenantId);
        } catch (err) {
            console.error(`Migration failed for tenant ${tenantId}:`, err);
            results.failed.push({ tenantId, error: err.message });
            // Continue to next tenant — partial success is better than full stop
        }
    }

    if (results.failed.length > 0) {
        console.error(`${results.failed.length} tenants failed migration`);
        // Alert operations team, do not mark migration complete
    }

    return results;
}
```

Key principles for multi-tenant migrations:
- **Never fail fast**: one tenant's migration failure should not block others
- **Track per-tenant versions**: each tenant database records its own migration history
- **Support mixed versions**: your application must handle tenants at different schema versions simultaneously
- **Canary tenant testing**: apply migrations to a test tenant first, verify, then batch-apply to production tenants

### Application-Level Version Gating

When tenants may be at different schema versions, gate features at the application layer:

```typescript
async function getTenantCapabilities(tenantId: string): Promise<Set<string>> {
    const version = await getTenantSchemaVersion(tenantId);
    const capabilities = new Set<string>();

    if (version >= 12) capabilities.add('archived_conversations');
    if (version >= 15) capabilities.add('conversation_search');
    if (version >= 20) capabilities.add('multi_model_routing');

    return capabilities;
}

async function handleRequest(tenantId: string, feature: string) {
    const caps = await getTenantCapabilities(tenantId);
    if (!caps.has(feature)) {
        return { error: 'Feature not yet available for this account' };
    }
    // proceed
}
```

This is the same pattern as feature flags but driven by schema version rather than a flag service.

---

## Migration Tools for Node.js and TypeScript Agents

Several mature tools exist for managing migrations in Node.js-based agent deployments.

### Prisma Migrate

Prisma's migration system derives migrations from a declarative schema file, making it well-suited for TypeScript-first projects:

```
// schema.prisma
model Conversation {
    id         String   @id @default(cuid())
    userId     String
    title      String?
    archivedAt DateTime?
    messages   Message[]
    createdAt  DateTime  @default(now())
}
```

Running `prisma migrate dev` generates SQL and tracks versions. In production, `prisma migrate deploy` applies pending migrations without interactive prompts — safe for CI/CD pipelines.

Prisma's documentation explicitly recommends the expand-and-contract pattern for complex data migrations: add new columns, backfill data in a separate step, then remove old columns across separate deployments.

### Knex.js Migrations

For lightweight Node.js agents that don't need a full ORM:

```typescript
// migrations/20260227_add_tool_invocations.ts
export async function up(knex: Knex) {
    await knex.schema.createTable('tool_invocations', table => {
        table.string('id').primary();
        table.string('session_id').notNullable().references('sessions.id');
        table.string('tool_name').notNullable();
        table.json('input').notNullable();
        table.json('output');
        table.integer('duration_ms');
        table.string('status').notNullable().defaultTo('pending');
        table.timestamp('created_at').defaultTo(knex.fn.now());
        table.index(['session_id', 'created_at']);
    });
}

export async function down(knex: Knex) {
    await knex.schema.dropTable('tool_invocations');
}
```

### better-sqlite3 with Custom Runner

For SQLite-specific deployments (Zylos uses SQLite for scheduler and session state), a custom migration runner integrated with startup is often the right choice:

```typescript
import Database from 'better-sqlite3';

const MIGRATIONS = [
    {
        version: 1,
        name: 'initial_schema',
        up(db: Database.Database) {
            db.exec(`
                CREATE TABLE sessions (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
                    last_active INTEGER NOT NULL DEFAULT (unixepoch())
                )
            `);
        }
    },
    {
        version: 2,
        name: 'add_session_metadata',
        up(db: Database.Database) {
            db.exec(`ALTER TABLE sessions ADD COLUMN metadata TEXT DEFAULT '{}'`);
        }
    }
];

function ensureSchema(db: Database.Database) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER NOT NULL,
            applied_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
    `);

    const current = db.prepare(`SELECT MAX(version) as v FROM schema_version`).get() as any;
    const currentVersion = current?.v ?? 0;

    const pending = MIGRATIONS.filter(m => m.version > currentVersion);

    for (const migration of pending) {
        const apply = db.transaction(() => {
            migration.up(db);
            db.prepare(`INSERT INTO schema_version (version) VALUES (?)`).run(migration.version);
        });
        apply();
        console.log(`Applied migration ${migration.version}: ${migration.name}`);
    }
}
```

Call `ensureSchema(db)` at application startup, before accepting any work. This idempotent pattern is safe to run on every restart.

---

## Rollback Strategies

Rollbacks in schema migrations are more nuanced than application rollbacks. There are two philosophies:

### Rollback-First (Classic)

Pre-write `down()` migrations that reverse each `up()` migration. When a deployment fails, run down migrations in reverse order.

Limitations:
- Destructive changes (`DROP COLUMN`) cannot be undone without data loss
- Data written by the new schema version may not be representable in the old schema
- Not supported in free tiers of tools like Flyway

### Fix-Forward (Preferred for Production AI Agents)

Rather than rolling back the schema, deploy a new migration that corrects the error. The database only ever moves forward through its version history.

This approach is preferred when:
- Data was written in the new schema format (rollback would lose writes)
- The migration involves multiple tables (partial rollback leaves inconsistent state)
- You have canary testing and caught the issue before full rollout

```typescript
// Bad migration that shipped to 10% of traffic before detection
const migration_15 = {
    version: 15,
    up: async (db) => {
        // BUG: wrong default value
        await db.exec(`ALTER TABLE messages ADD COLUMN priority INTEGER DEFAULT 100`);
    }
};

// Fix-forward: correct the data, don't roll back schema
const migration_16 = {
    version: 16,
    name: 'fix_message_priority_default',
    up: async (db) => {
        // Update records that got the wrong default
        await db.exec(`UPDATE messages SET priority = 0 WHERE priority = 100 AND created_at > ?`);
        // Continue forward — schema stays at v15, data is corrected
    }
};
```

### Point-in-Time Recovery as Safety Net

For either strategy, maintain database backups taken immediately before migrations. In SQLite:

```bash
# Backup before migration
cp agent.db agent.db.backup-$(date +%Y%m%d-%H%M%S)

# Or use SQLite's online backup API
sqlite3 agent.db ".backup agent.db.backup"
```

The backup provides a last-resort restore path if both the migration and the fix-forward fail.

---

## Integration with CI/CD Pipelines

Schema migrations should be first-class citizens in the deployment pipeline, not afterthoughts.

### Pre-Deployment Validation

Before applying migrations to production:

1. **Syntax check**: run migrations against a local SQLite/PostgreSQL instance
2. **Backward compatibility check**: verify the new schema works with the previous application version
3. **Estimate duration**: for large tables, estimate migration time and plan for lock contention

```yaml
# GitHub Actions workflow excerpt
- name: Run migration dry-run
  run: |
    cp production.db.snapshot /tmp/test.db
    node scripts/migrate.js --db /tmp/test.db --dry-run
    node scripts/migrate.js --db /tmp/test.db
    node scripts/validate-schema.js --db /tmp/test.db

- name: Test with previous app version
  run: |
    git stash  # temporarily revert app code
    node scripts/smoke-test.js --db /tmp/test.db
    git stash pop
```

### Migration in Startup vs. Separate Step

Two deployment models:

**Startup-time migration** (simpler, suitable for single-instance agents):
- Agent runs `ensureSchema()` on startup
- Simple, no separate migration job needed
- Risk: if migration is slow, startup is slow; if migration fails, agent fails to start

**Separate migration job** (safer for production):
- Migration runs as a separate Kubernetes job or pre-deploy step
- Application only starts after successful migration
- Enables parallel migration across multiple agent instances

For Zylos-class single-instance agents, startup-time migration is appropriate. For fleet deployments, prefer the separate migration job pattern.

---

## Observability for Schema Migrations

Migrations are high-risk operations that warrant explicit observability.

### Migration Duration Tracking

```typescript
async function runMigrationWithObservability(
    db: Database,
    migration: Migration
) {
    const start = Date.now();
    try {
        await migration.up(db);
        const duration = Date.now() - start;
        console.log(JSON.stringify({
            event: 'migration_applied',
            version: migration.version,
            name: migration.name,
            duration_ms: duration,
            timestamp: new Date().toISOString()
        }));
    } catch (err) {
        console.error(JSON.stringify({
            event: 'migration_failed',
            version: migration.version,
            name: migration.name,
            error: err.message,
            timestamp: new Date().toISOString()
        }));
        throw err;
    }
}
```

### Schema Version in Health Checks

Expose the current schema version in your agent's health check endpoint:

```typescript
app.get('/health', async (req, res) => {
    const version = db.prepare(
        `SELECT MAX(version) as v FROM schema_migrations`
    ).get() as any;

    res.json({
        status: 'ok',
        schema_version: version?.v ?? 0,
        uptime: process.uptime()
    });
});
```

This enables deployment orchestrators to verify that a new instance completed its migrations before routing traffic to it.

---

## Practical Guidelines for Zylos-Style Agent Systems

Synthesizing the above into actionable guidance for single-instance, SQLite-based AI agent deployments:

1. **Always track schema versions in the database**, not in code. A version table created if not exists is idempotent and safe.

2. **Run migrations at startup, before any worker starts**. This guarantees the schema is current before any query touches it.

3. **Use transactions for multi-step migrations**. SQLite's transaction model guarantees atomicity even for table-copy operations.

4. **Follow expand-then-contract for breaking changes**. Never drop a column or rename a field in a single deployment.

5. **Back up before every migration run**. For SQLite, a file copy is sufficient and takes milliseconds.

6. **Apply the same discipline to tool schemas** as to database schemas. Tool parameter renames are breaking changes.

7. **Log every migration event** with version, name, duration, and outcome. Migrations are infrequent enough that verbose logging is appropriate.

8. **Test migrations against a copy of production data** before applying. Schema logic that passes with test fixtures often fails against real data patterns.

These principles apply whether you're managing a single embedded agent or a fleet — the difference is orchestration complexity, not foundational discipline.

---

## Summary

Schema migration is not just an infrastructure concern — it is core to the long-term viability of an AI agent system. Agents accumulate state, their tools evolve, and their deployment footprint grows. The strategies presented here — expand-and-contract, SQLite-specific table-copy patterns, tool schema versioning, multi-tenant coordination, and fix-forward rollback — form a coherent approach to evolving production AI agent systems safely.

The cost of a botched migration is measured in corrupted memory, broken sessions, and debugging sessions that consume hours. The cost of disciplined migration practice is measured in a few extra lines of code and a slightly more deliberate deployment process. The trade is overwhelmingly worth making.
