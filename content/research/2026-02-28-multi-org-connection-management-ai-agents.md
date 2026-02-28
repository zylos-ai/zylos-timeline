---
date: "2026-02-28"
title: "Multi-Organization Connection Management for AI Agent Components"
description: "Patterns for AI agents maintaining simultaneous connections to multiple organizational contexts — connection multiplexing, config migration, identity disambiguation, and credential isolation"
tags:
  - multi-tenant
  - websocket
  - configuration
  - ai-agents
  - connection-management
---

## Executive Summary

As AI agents evolve from single-org deployments to multi-org platforms, a new class of engineering challenge emerges: how to maintain simultaneous, isolated connections to multiple organizational contexts from a single running process. This is the client-side complement to the well-studied server-side multi-tenancy problem.

Real-world precedents — Slack multi-workspace bots, Discord sharded multi-guild clients, Matrix application service bridges, and enterprise SaaS connectors — have converged on a set of durable patterns. The core insight: **treat each org as an independent connection unit with its own lifecycle, credentials, health state, and identity namespace**, while sharing the underlying transport infrastructure.

Key takeaways:
- Connection registries (labeled connection maps) are the foundational primitive for multi-org management
- Config schemas must be migrated with backward-compatible readers before writers change format
- Identity disambiguation relies on context-keyed routing — every inbound message carries an org scope
- Credentials are stored in namespaced paths (e.g., `secrets/<org_id>/token`) never in flat env vars for multi-org setups
- Hot-reload is achievable by isolating the connection lifecycle from the transport layer

---

## 1. Connection Multiplexing Patterns

### The Labeled Connection Registry

The fundamental data structure for multi-org connection management is a map from org identifier to connection object. Each entry tracks not just the connection handle, but the full lifecycle state of that org's connection.

```typescript
interface OrgConnection {
  orgId: string;
  label: string;             // human-readable name for logs/metrics
  ws: WebSocket | null;
  status: 'connecting' | 'connected' | 'backoff' | 'failed' | 'removed';
  credentials: OrgCredentials;
  reconnectAttempts: number;
  lastConnectedAt: Date | null;
  lastHeartbeatAt: Date | null;
  backoffMs: number;
  healthTimer: NodeJS.Timeout | null;
}

class OrgConnectionRegistry {
  private connections = new Map<string, OrgConnection>();

  add(orgId: string, config: OrgConfig): void { /* ... */ }
  remove(orgId: string): void { /* ... */ }
  get(orgId: string): OrgConnection | undefined { /* ... */ }
  getAll(): OrgConnection[] { /* ... */ }
  getHealthy(): OrgConnection[] { /* ... */ }
}
```

This pattern is used by Discord's `DiscordShardedClient` which manages multiple `DiscordSocketClient` instances keyed by shard ID, and by Slack Bolt's multi-workspace authorization middleware which resolves tokens by `team_id` on every incoming event.

### Connection Pool vs. Connection-Per-Org

Two main topologies exist:

**Connection-Per-Org (silo model)**
- Each org gets a dedicated, persistent connection
- Strong isolation: one org's instability cannot affect others
- Straightforward credential mapping — the connection object carries its own auth context
- Higher resource cost for large org counts
- Preferred by: Slack RTM/Socket Mode bots, Matrix bridges (one appservice registration per bridge instance)

**Pooled Connections with Org Multiplexing (pool model)**
- A smaller pool of connections handles traffic for many orgs
- Each message carries an org context header; a router dispatches to the correct handler
- Lower resource cost; suitable when orgs are mostly idle
- Requires careful isolation to prevent cross-org context leakage
- Preferred by: Discord Gateway sharding (one shard handles up to 2500 guilds), large-scale SaaS connectors

For AI agent components with a moderate number of orgs (< 100) and persistent event streams, the connection-per-org silo model is generally preferred because it simplifies debugging and eliminates noisy-neighbor effects.

### Per-Connection Health Monitoring

Each connection in the registry needs independent health tracking. A global health check cannot distinguish which org's connection degraded. The pattern:

```typescript
function startHealthMonitor(conn: OrgConnection): void {
  conn.healthTimer = setInterval(() => {
    const now = Date.now();
    const heartbeatAge = now - (conn.lastHeartbeatAt?.getTime() ?? 0);

    if (heartbeatAge > HEARTBEAT_TIMEOUT_MS) {
      log.warn(`[${conn.label}] Heartbeat stale (${heartbeatAge}ms), triggering reconnect`);
      reconnect(conn);  // only this connection, not all connections
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}
```

Key principle from production systems: **per-connection timeout tracking prevents a single bad connection from triggering a global reconnect storm**. Each connection's backoff counter is independent, using exponential backoff with jitter:

```typescript
function computeBackoff(attempts: number): number {
  const base = Math.min(1000 * Math.pow(2, attempts), 60_000);
  const jitter = Math.random() * 0.3 * base;
  return base + jitter;
}
```

The jitter prevents synchronized reconnection storms when an upstream service restarts and all org connections attempt to reconnect simultaneously.

### Sharding for Scale

Discord's sharding model demonstrates how to scale beyond what single connections support. For bots in 2,500+ guilds, Discord requires distributing guild connections across multiple WebSocket shards. The pattern generalizes to any multi-org system at scale:

- Assign orgs to shards by `hash(orgId) % shardCount`
- Each shard manages its own connection lifecycle independently
- A shard manager tracks which orgs are on which shards
- Shard rebalancing (adding/removing shards) requires migrating org assignments with connection draining

---

## 2. Configuration Migration Strategies

### The Single-Value to Multi-Value Migration Problem

A common evolution in AI agent components: a config field that started as a single value (one org) must become a map (multiple orgs). This is a schema migration without a database — the config is a JSON or YAML file on disk. The challenge is maintaining backward compatibility while safely transitioning the schema.

**Before:**
```json
{
  "telegram": {
    "bot_token": "123:ABC",
    "chat_id": "456789"
  }
}
```

**After:**
```json
{
  "telegram": {
    "orgs": {
      "org_personal": { "bot_token": "123:ABC", "chat_id": "456789" },
      "org_work":     { "bot_token": "789:XYZ", "chat_id": "101112" }
    }
  }
}
```

### Backward-Compatible Reader Pattern

The reader always handles both old and new schemas. The writer only emits the new schema. This allows a safe rollout: deploy the new reader first, then migrate the config.

```typescript
function loadTelegramConfig(raw: any): TelegramConfig {
  // New schema: has 'orgs' map
  if (raw.telegram?.orgs) {
    return { orgs: raw.telegram.orgs };
  }

  // Legacy schema: single flat values — auto-promote to map with default key
  if (raw.telegram?.bot_token) {
    return {
      orgs: {
        default: {
          bot_token: raw.telegram.bot_token,
          chat_id: raw.telegram.chat_id,
        }
      }
    };
  }

  throw new ConfigError('Unrecognized telegram config schema');
}
```

This "promote on read" pattern means existing deployments continue to work without touching their config file. The migration becomes explicit when the user adds a second org.

### Atomic Write with Backup

Config files must be written atomically to prevent corruption on crash (power loss, process kill during write). The standard pattern:

```typescript
async function writeConfig(path: string, config: object): Promise<void> {
  const json = JSON.stringify(config, null, 2);

  // 1. Write to temp file in same directory (same filesystem = atomic rename)
  const tmpPath = `${path}.tmp.${process.pid}`;
  await fs.writeFile(tmpPath, json, 'utf8');

  // 2. Keep a backup of the previous config
  const backupPath = `${path}.bak`;
  try {
    await fs.copyFile(path, backupPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  // 3. Atomic rename — either succeeds completely or doesn't happen
  await fs.rename(tmpPath, path);
}
```

On Linux/macOS, `rename(2)` is atomic on the same filesystem. Windows requires `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`. Most Node.js `fs.rename` implementations handle this correctly.

### Schema Version Tracking

For more complex migrations, embed a `schema_version` field and run versioned migration functions:

```typescript
const MIGRATIONS: Record<number, (config: any) => any> = {
  1: (c) => ({ ...c, schema_version: 2, telegram: promoteLegacyTelegram(c.telegram) }),
  2: (c) => ({ ...c, schema_version: 3, lark: promoteLegacyLark(c.lark) }),
};

function migrateConfig(config: any): any {
  let current = config;
  const startVersion = current.schema_version ?? 1;

  for (let v = startVersion; v < CURRENT_SCHEMA_VERSION; v++) {
    current = MIGRATIONS[v](current);
    log.info(`Config migrated from schema v${v} to v${v + 1}`);
  }
  return current;
}
```

This is the pattern used by the `conf` npm package and analogous to database migration runners (Knex, Sequelize) — each migration is idempotent and transforms config from version N to N+1.

---

## 3. Identity Disambiguation in Multi-Org Contexts

### The Naming Collision Problem

When the same bot is installed in multiple orgs, it often has a different display name in each org (admins can rename bots). Worse, the bot may not know its own name in a given org until it receives a message directed at it. This creates several problems:

- @-mention detection fails if the bot's name varies per org
- Log output becomes ambiguous without org context
- Error messages sent to the wrong org's channel

### The Org-Keyed Identity Map Pattern

Each org maintains its own identity record for the bot:

```typescript
interface BotIdentity {
  orgId: string;
  displayName: string;      // as configured in this org
  botUserId: string;        // platform-assigned ID within this org
  mentionPatterns: RegExp[];  // patterns to detect @-mentions of this bot
}

class IdentityRegistry {
  private identities = new Map<string, BotIdentity>();

  // Called when bot is first seen in an org (e.g., on_guild_join, team_join)
  async resolveAndRegister(orgId: string, client: OrgApiClient): Promise<void> {
    const me = await client.getSelf();
    this.identities.set(orgId, {
      orgId,
      displayName: me.name,
      botUserId: me.id,
      mentionPatterns: buildMentionPatterns(me.id, me.name),
    });
  }

  isMentioned(orgId: string, text: string): boolean {
    const identity = this.identities.get(orgId);
    if (!identity) return false;
    return identity.mentionPatterns.some(p => p.test(text));
  }
}
```

Slack Bolt's `MultiTeamsAuthorization` middleware implements this pattern: on every incoming event, it resolves the `team_id` to a stored installation record, which contains the bot's user ID for that workspace. This allows the bot to correctly detect its own mentions even if its name was customized.

### Channel-Per-Org Namespace Pattern

In platforms that support multiple channels per connection (Lark, Teams, Discord), a simple but powerful disambiguation technique is the **channel-per-org namespace**:

- Inbound events from org A always arrive with a context tag (`team_id`, `guild_id`, `tenant_id`)
- The router uses this tag as the first key in all routing decisions
- Log lines are prefixed with `[OrgLabel]` derived from the org identity map
- Outbound API calls look up the correct credentials using the same org key

```typescript
async function handleInbound(rawEvent: PlatformEvent): Promise<void> {
  const orgId = extractOrgId(rawEvent);  // platform-specific extraction
  const identity = identityRegistry.get(orgId);
  const credentials = credentialStore.get(orgId);

  const ctx: OrgContext = { orgId, identity, credentials };

  // All downstream handlers receive ctx — no global state
  await eventRouter.dispatch(rawEvent, ctx);
}
```

The key discipline: **no global state for org-specific values**. All handlers receive an explicit `OrgContext` argument. This prevents the class of bugs where org A's state bleeds into org B's processing.

### Display Name Conflict Resolution

When a bot's display name in one org matches a human user's name in another org, UI presentation must be org-scoped. The pattern used by Matrix bridges:

- Puppet accounts (virtual users representing real users from another platform) are named with an org suffix: `@username_orgname:homeserver`
- The bridge maintains a mapping from `(orgId, platformUserId)` to the local puppet account
- Display names are stored per-puppet, not globally

---

## 4. Credential Isolation

### The Flat .env Anti-Pattern for Multi-Org

Single-org deployments commonly store all credentials in a flat `.env` file:

```
TELEGRAM_TOKEN=123:ABC
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=yyy
```

This does not scale to multi-org. The pattern collapses when you have:
- `TELEGRAM_TOKEN_ORG1=...` and `TELEGRAM_TOKEN_ORG2=...`
- No structure for adding a third org
- Token rotation requiring a restart to pick up new values

### Namespaced Credential Store

The production pattern is to namespace credentials by org ID in a structured store:

```typescript
interface OrgCredentials {
  orgId: string;
  platform: string;
  secrets: Record<string, string>;  // key names are platform-specific
  rotatedAt: Date;
  expiresAt: Date | null;
}

class CredentialStore {
  // File-based store: credentials stored in a structured JSON with per-org entries
  // OR delegate to external secret manager (Vault, AWS Secrets Manager, etc.)
  private store: Map<string, OrgCredentials>;

  get(orgId: string): OrgCredentials {
    const creds = this.store.get(orgId);
    if (!creds) throw new CredentialNotFoundError(orgId);
    if (creds.expiresAt && creds.expiresAt < new Date()) {
      throw new CredentialExpiredError(orgId);
    }
    return creds;
  }

  async rotate(orgId: string, newSecrets: Record<string, string>): Promise<void> {
    const existing = this.get(orgId);
    const updated = { ...existing, secrets: newSecrets, rotatedAt: new Date() };
    await this.persist(orgId, updated);
    this.store.set(orgId, updated);
    log.info(`[${orgId}] Credentials rotated`);
  }
}
```

### External Secret Manager Patterns

For production deployments, org credentials should be stored in an external secret manager rather than local files. The path convention:

```
# HashiCorp Vault
secret/bots/zylos/<org_id>/telegram_token
secret/bots/zylos/<org_id>/lark_app_secret

# AWS Secrets Manager
/zylos/bot/<org_id>/telegram
/zylos/bot/<org_id>/lark

# Azure Key Vault: secrets named with org prefix
zylos-<org_id>-telegram-token
zylos-<org_id>-lark-secret
```

HashiCorp Vault's namespace feature provides the strongest isolation: each org gets its own Vault namespace with dedicated policies. No credential for org A can be accessed via org B's policy, even if the application logic has a bug.

Key properties of per-org credential management:

- **Independent rotation**: rotating org A's token does not affect org B's active connections
- **Revocation granularity**: compromised credentials for one org can be revoked without impacting other orgs
- **Audit log per org**: secret access logs are scoped to the org, simplifying compliance audits
- **Short-lived credentials**: some platforms (AWS IAM, certain OAuth providers) support dynamic credential generation — the bot fetches a fresh credential valid for minutes rather than storing long-lived tokens

### Token Refresh Coordination

Multi-org credential management requires per-org token refresh coordination to prevent expiry-induced connection drops:

```typescript
class TokenRefreshCoordinator {
  private refreshTimers = new Map<string, NodeJS.Timeout>();

  schedule(orgId: string, expiresAt: Date, refreshFn: () => Promise<void>): void {
    this.cancel(orgId);
    const msUntilExpiry = expiresAt.getTime() - Date.now();
    const refreshAt = msUntilExpiry * 0.85;  // refresh at 85% of lifetime

    this.refreshTimers.set(orgId, setTimeout(async () => {
      try {
        await refreshFn();
        log.info(`[${orgId}] Token refreshed proactively`);
      } catch (err) {
        log.error(`[${orgId}] Token refresh failed`, err);
        // Alert and schedule retry with backoff
      }
    }, refreshAt));
  }

  cancel(orgId: string): void {
    const timer = this.refreshTimers.get(orgId);
    if (timer) { clearTimeout(timer); this.refreshTimers.delete(orgId); }
  }
}
```

---

## 5. Hot-Reload Patterns

### The Core Challenge

Hot-reload for multi-org connections means: adding a new org or removing an existing org at runtime, without restarting the service and without disrupting the connections of other orgs.

The prerequisite is **decoupled connection lifecycle**: the connection for each org must be independently startable and stoppable. If the entire connection setup is a monolithic initialization routine, hot-reload is impossible without a full restart.

### Connection Lifecycle Manager

The pattern is a connection lifecycle manager that treats connections as managed resources:

```typescript
class ConnectionLifecycleManager {
  private registry: OrgConnectionRegistry;

  async addOrg(config: OrgConfig): Promise<void> {
    if (this.registry.has(config.orgId)) {
      throw new Error(`Org ${config.orgId} already exists`);
    }

    const conn = await this.initConnection(config);
    this.registry.add(config.orgId, conn);
    await this.startConnection(conn);
    log.info(`[${config.orgId}] Connection added and started`);
  }

  async removeOrg(orgId: string): Promise<void> {
    const conn = this.registry.get(orgId);
    if (!conn) return;

    await this.stopConnection(conn);    // graceful close: flush pending messages
    this.registry.remove(orgId);
    credentialStore.clear(orgId);       // clean up sensitive data
    identityRegistry.remove(orgId);
    log.info(`[${orgId}] Connection removed cleanly`);
  }

  async reloadOrg(orgId: string, newConfig: OrgConfig): Promise<void> {
    await this.removeOrg(orgId);
    await this.addOrg(newConfig);
  }
}
```

Discord's hot-reload implementation demonstrates an important constraint: **the WebSocket connection itself must not be reloaded**. Only the handlers and configuration that run on top of the connection can be swapped. Reloading the connection object means a disconnect/reconnect cycle which causes event loss.

The practical pattern: separate the **connection layer** (WebSocket, auth handshake) from the **handler layer** (business logic, command processing). Hot-reload replaces handler modules; the connection layer persists.

### Config File Watcher Pattern

For file-based configurations, a filesystem watcher triggers hot-reload when the config changes:

```typescript
import { watch } from 'node:fs';

function watchConfig(configPath: string, manager: ConnectionLifecycleManager): void {
  let debounceTimer: NodeJS.Timeout | null = null;

  watch(configPath, (eventType) => {
    if (eventType !== 'change') return;

    // Debounce: editors often write files in multiple steps
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        const newConfig = await loadConfig(configPath);
        await reconcileOrgs(newConfig, manager);
        log.info('Config reloaded, org connections reconciled');
      } catch (err) {
        log.error('Config reload failed — keeping existing connections', err);
      }
    }, 500);
  });
}

async function reconcileOrgs(
  newConfig: MultiOrgConfig,
  manager: ConnectionLifecycleManager
): Promise<void> {
  const currentOrgIds = new Set(manager.registry.getAllOrgIds());
  const newOrgIds = new Set(Object.keys(newConfig.orgs));

  // Add new orgs
  for (const orgId of newOrgIds) {
    if (!currentOrgIds.has(orgId)) {
      await manager.addOrg(newConfig.orgs[orgId]);
    }
  }

  // Remove deleted orgs
  for (const orgId of currentOrgIds) {
    if (!newOrgIds.has(orgId)) {
      await manager.removeOrg(orgId);
    }
  }

  // Update changed orgs (compare config hash)
  for (const orgId of newOrgIds) {
    if (currentOrgIds.has(orgId)) {
      const currentHash = manager.registry.getConfigHash(orgId);
      const newHash = hashConfig(newConfig.orgs[orgId]);
      if (currentHash !== newHash) {
        await manager.reloadOrg(orgId, newConfig.orgs[orgId]);
      }
    }
  }
}
```

GraphQL's hot schema reloading uses a conceptually identical reconciliation pattern: compare current service registrations against desired state, add/remove/update as needed.

### Signal-Based Reload

An alternative to file watching is POSIX signal handling. `SIGHUP` is the conventional signal for "reload configuration without restarting":

```typescript
process.on('SIGHUP', async () => {
  log.info('SIGHUP received — reloading config');
  try {
    const newConfig = await loadConfig(CONFIG_PATH);
    await reconcileOrgs(newConfig, connectionManager);
  } catch (err) {
    log.error('Config reload on SIGHUP failed', err);
  }
});
```

This is the exact mechanism used by NGINX for its zero-downtime config reload: the master process forks a new worker with the new config, waits for existing connections to drain on the old worker, then kills the old worker. For AI agent connection managers, the analogous pattern is: start new org connections first, then drain and remove old ones.

---

## 6. Real-World System Reference

### Slack Bolt Multi-Workspace Pattern

The reference implementation for multi-workspace Slack bots uses `InstallationStore` as the credential and identity abstraction:

```typescript
const app = new App({
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  scopes: ['chat:write', 'channels:read'],
  installationStore: {
    storeInstallation: async (installation) => {
      // Key: installation.team.id (the workspace ID)
      await db.set(`slack:${installation.team.id}`, installation);
    },
    fetchInstallation: async (query) => {
      const data = await db.get(`slack:${query.teamId}`);
      if (!data) throw new Error(`No installation for team ${query.teamId}`);
      return data;
    },
    deleteInstallation: async (query) => {
      await db.delete(`slack:${query.teamId}`);
    },
  },
});
```

On every incoming Slack event, Bolt resolves the `team_id` to an installation record, fetches the bot token, and uses it for the response. No global token is used; every API call is scoped to the origin workspace.

### Discord Sharded Multi-Guild Pattern

```typescript
const manager = new ShardingManager('./bot.js', { token: DISCORD_BOT_TOKEN });

manager.on('shardCreate', (shard) => {
  shard.on('ready', () => log.info(`Shard ${shard.id} ready`));
  shard.on('death', () => log.warn(`Shard ${shard.id} died — respawning`));
  shard.on('disconnect', () => log.warn(`Shard ${shard.id} disconnected`));
});

manager.spawn({ amount: 'auto' });  // Discord recommends 1 shard per 2500 guilds
```

Each shard maintains its own WebSocket connection to the Discord Gateway. Guild-specific operations (like guild join/leave events) fire on the shard that owns that guild.

### Matrix Application Service Pattern

Matrix bridges register as application services with a homeserver, receiving a dedicated namespaced token:

```yaml
# registration.yaml
id: my-bridge
url: http://localhost:9000
as_token: <bridge-to-homeserver-token>
hs_token: <homeserver-to-bridge-token>
namespaces:
  users:
    - exclusive: true
      regex: '@bridge_.*:example.org'
  rooms:
    - exclusive: false
      regex: '.*'
```

The bridge registers once and can puppet any number of users within its namespace. Each bridged external org (e.g., a Telegram group, a Discord server) maps to a Matrix room. The bridge maintains a connection to the external platform per org and a single application service connection to the homeserver.

---

## Key Design Principles Summary

| Concern | Pattern | Anti-Pattern |
|---------|---------|--------------|
| Connection management | Registry map keyed by org ID | Global singleton connection |
| Health monitoring | Per-connection independent timers | Single global health check |
| Credentials | Namespaced store, fetched by org ID | Flat .env variables with suffixes |
| Token rotation | Per-org scheduled refresh at 85% lifetime | Restart service on token expiry |
| Identity | Org-keyed identity map resolved at join | Hardcoded bot name in config |
| Message routing | Context tag (team_id/guild_id) as first key | Match by message content alone |
| Hot reload | Connection lifecycle manager + reconciliation | Full process restart |
| Config migration | Backward-compatible reader + schema version | Breaking schema change in place |

---

*Sources:*
- *[Slack Bolt authenticating with OAuth](https://docs.slack.dev/tools/bolt-js/concepts/authenticating-oauth/)*
- *[Discord sharding and multi-guild architecture](https://deepwiki.com/discord-net/Discord.Net/2-client-architecture)*
- *[Matrix bridge types and application service registration](https://matrix.org/docs/older/types-of-bridging/)*
- *[HashiCorp Vault multi-tenancy strategies](https://medium.com/hashicorp-engineering/vault-multi-tenancy-strategies-67922f1eb9d)*
- *[WebSocket connection pooling patterns](https://oneuptime.com/blog/post/2026-01-24-websocket-connection-pooling/view)*
- *[WebSocket reconnection with exponential backoff](https://dev.to/hexshift/robust-websocket-reconnection-strategies-in-javascript-with-exponential-backoff-40n1)*
- *[Tenant isolation in SaaS: pool, silo and bridge models](https://www.justaftermidnight247.com/insights/tenant-isolation-in-saas-pool-silo-and-bridge-models-explained/)*
- *[Building multi-tenant generative AI on AWS](https://aws.amazon.com/blogs/machine-learning/build-a-multi-tenant-generative-ai-environment-for-your-enterprise-on-aws/)*
- *[Hot schema reloading — GraphQL Stitching](https://the-guild.dev/graphql/stitching/handbook/architecture/hot-schema-reloading)*
- *[Schema evolution with backward/forward compatibility](https://dev3lop.com/schema-evolution-patterns-with-backward-forward-compatibility/)*
- *[Why AI agents use WebSockets instead of HTTP](https://liveblocks.io/blog/why-we-built-our-ai-agents-on-websockets-instead-of-http)*
- *[OWASP Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)*
