---
date: "2026-05-23"
title: "Relation-Based Access Control (ReBAC) for Multi-Service AI Platforms"
description: "Implementing Google Zanzibar-inspired permission systems across microservices — relation tuples, hierarchical inheritance, cross-service authorization, and production patterns with SpiceDB and OpenFGA."
tags: ["security", "authorization", "rebac", "microservices", "zanzibar"]
---

## Executive Summary

Authorization is the hardest unsolved problem in distributed systems that nobody talks about until it breaks. Role-Based Access Control (RBAC) works fine when you have a handful of roles and flat resources. It breaks the moment you need "Alice can edit this document because she owns the project it belongs to, but only between 9am and 5pm her local timezone, and only if she hasn't been removed from the team in the last 10 minutes." That sentence is the normal operating condition for any production SaaS platform, and no amount of JWT claims or middleware guards expresses it cleanly.

Relation-Based Access Control (ReBAC), most famously instantiated by Google's Zanzibar system, resolves this by making *relationships* between objects first-class data — stored, queried, and propagated with the same care as your application records. The permission question "can subject S perform action A on object O?" becomes a graph traversal: does a path exist between S and O through the declared relation graph? This framing handles hierarchical inheritance, cross-object delegation, and temporal revocation naturally, without special-casing any of them in application code.

This article traces ReBAC from first principles through production deployment, with specific attention to multi-service AI platforms where the authorization surface spans knowledge bases, agent runtimes, billing entitlements, and user-generated content simultaneously.

---

## 1. ReBAC Fundamentals — The Zanzibar Model

### The Paper That Changed Authorization

Google published "Zanzibar: Google's Consistent, Global Authorization System" at USENIX ATC 2019. The system had already been running in production for several years, handling authorization for Google Drive, Docs, Photos, YouTube, and Maps — over 10 million authorization checks per second, with 99.999% availability, against a dataset of trillions of ACL tuples stored in Google Spanner. The paper described not just a system but a paradigm: permissions as a directed relationship graph, queryable in milliseconds across a globally distributed dataset.

### Relation Tuples: The Primitive Unit

Every permission in Zanzibar is expressed as a **relation tuple** of the form:

```
<namespace>:<object_id>#<relation>@<subject>
```

Where subject can itself be a userset — another object-relation pair, enabling delegation and group membership:

```
document:budget_q4#viewer@user:alice
document:budget_q4#viewer@group:finance#member
folder:reports#parent@document:budget_q4
```

The first tuple says Alice can view `budget_q4`. The second says any member of the `finance` group can view it. The third encodes the hierarchy: `budget_q4` belongs inside `reports`. These three tuples, combined with a namespace schema that says "viewer permission on a document is inherited from the parent folder's viewer permission," are sufficient to resolve "can Bob, who is a finance group member, view any document in the reports folder?" without any application code being involved.

### Namespace Configurations

A namespace configuration is the schema layer. It defines:

- **Object types** (e.g., `document`, `folder`, `organization`)
- **Relations** on each type (e.g., `owner`, `editor`, `viewer`, `parent`)
- **Userset rewrite rules** — the logic that derives computed permissions from stored relations

In SpiceDB's schema language (`.zed` format), a simple document namespace looks like:

```zed
definition user {}

definition folder {
  relation owner: user
  relation viewer: user | user:*

  permission view = viewer + owner
}

definition document {
  relation owner: user
  relation viewer: user
  relation parent: folder

  permission view = viewer + owner + parent->view
  permission edit = owner + parent->owner
}
```

The `parent->view` expression is the critical piece: it says "a user has `view` permission on this document if they have `view` permission on the document's parent folder." This is *derived* permission via relation traversal — not a copied ACL entry, but a live graph query.

### The Check Algorithm

A `Check(subject, permission, object)` call becomes a recursive graph traversal: expand the permission's userset rewrite rule, collect all candidate subjects (direct assignments plus computed ones), and determine if the queried subject appears in the resolved set. Zanzibar uses a parallel depth-first search with memoization to bound traversal cost, combined with a distributed cache keyed on `(object, permission, snapshot_token)`.

---

## 2. Open-Source Implementations: SpiceDB, OpenFGA, Keto, Permify

### The Landscape

Google never open-sourced Zanzibar itself, but the 2019 paper spawned a generation of independent implementations. By 2025, four projects dominate the ReBAC OSS space.

### SpiceDB

- **Maintainer:** AuthZed (raised $26M Series A)
- **License:** Apache 2.0
- **Storage backends:** PostgreSQL, CockroachDB, MySQL, Spanner, etcd

SpiceDB is the most faithful Zanzibar implementation. Its schema language (`.zed`) closely mirrors Zanzibar's namespace configuration syntax. Key distinguishing features:

- **Caveats**: conditional relationships evaluated at check time using CEL (Common Expression Language). A caveat can encode "this relationship is only valid during business hours" or "only from this IP range," blending ABAC attributes into the ReBAC graph without losing its graph semantics.
- **Watch API**: streams relationship changes to consumers, enabling cache invalidation and secondary index maintenance. Critical for derived-permission caches.
- **Consistency tokens (ZedTokens)**: the SpiceDB equivalent of Zanzibar's zookies. Every write returns a token; read/check calls can specify a minimum-freshness bound, trading latency for consistency.
- **LookupResources / LookupSubjects**: reverse-direction graph queries — "what documents can Alice view?" or "who can view this document?" — essential for UI rendering without post-filtering.

### OpenFGA

- **Maintainer:** Auth0 / Okta (CNCF Sandbox project)
- **License:** Apache 2.0
- **Storage backends:** PostgreSQL, MySQL, SQLite (dev), in-memory

OpenFGA takes a more developer-ergonomic approach. Its authorization model is expressed in JSON DSL and the API surface is designed to integrate easily into existing Auth0 workflows.

Distinctive features:
- **Contextual tuples**: relationships that exist only for the duration of a single check call, not persisted to storage. Useful for expressing "user is accessing this resource via a temporary share link" without polluting the relationship store.
- **Conditions**: declarative ABAC attributes attached to relationship types, evaluated with CEL. More structured than SpiceDB caveats, with explicit parameter typing.
- **Token claims as contextual tuples**: a pattern where JWT claims are translated into ephemeral relationship tuples at check time, bridging traditional auth tokens into the ReBAC model without a separate write path.

OpenFGA has the broadest language SDK support (Go, Java, .NET, Python, JavaScript, Ruby) and is typically the recommended starting point for teams not already in the SpiceDB ecosystem.

### Ory Keto

- **Maintainer:** Ory (open source identity stack)
- **License:** Apache 2.0
- **Storage backends:** PostgreSQL, MySQL, SQLite, CockroachDB

Keto is simpler and more opinionated. It focuses on the core Zanzibar tuple store and check/list APIs, integrating tightly with Ory Kratos (identity management) and Ory Oathkeeper (API gateway proxy). Teams running the full Ory stack get seamless integration; teams not using Ory will find Keto's limited schema language and weaker consistency guarantees (it relies on the underlying database, not a purpose-built consistency model) to be limiting at scale.

Keto's sweet spot is smaller applications where operational simplicity outweighs the need for Zanzibar-grade consistency or complex schema features.

### Permify

- **Maintainer:** Permify (YC W23)
- **License:** AGPL-3.0 (core) / commercial
- **Storage backends:** PostgreSQL, MySQL, Memory

Permify targets developer experience and rapid iteration. Its YAML-based schema is more accessible than SpiceDB's `.zed` syntax. Notable features include a visual playground for modeling and testing permissions interactively, built-in data filtering (lookup queries at the application level), and OpenTelemetry integration out of the box.

The AGPL-3.0 license is the critical consideration: AGPL requires derivative works to also be open source if they interact with the licensed code over a network. Commercial deployments embedding Permify in a proprietary product need a commercial license or careful legal review.

### Comparison at a Glance

| Feature | SpiceDB | OpenFGA | Keto | Permify |
|---------|---------|---------|------|---------|
| Zanzibar fidelity | Highest | High | Moderate | High |
| Schema language | `.zed` (rich) | JSON DSL | Simple | YAML |
| ABAC hybrid | Caveats (CEL) | Conditions (CEL) | None | Attributes |
| Consistency tokens | Yes (ZedTokens) | Yes | DB-level | Yes |
| Watch API | Yes | Partial | No | No |
| License | Apache 2.0 | Apache 2.0 | Apache 2.0 | AGPL-3.0 |
| Best for | Zanzibar-purity | Auth0 ecosystem | Ory stack | Dev experience |

---

## 3. Hierarchical Permission Inheritance

### The Pattern

The most commercially important ReBAC pattern is hierarchical inheritance: permissions granted at a high-level container (organization, workspace, folder) automatically propagate to all child objects. This maps directly to how humans think about document systems: if you share a Google Drive folder with a team, every document in that folder is implicitly shared.

In tuple terms, the hierarchy is expressed via a `parent` (or `owner`, `container`) relation between object types:

```
organization:acme#member@user:alice
workspace:eng#parent@organization:acme
project:api_docs#parent@workspace:eng
document:spec_v2#parent@project:api_docs
```

The namespace schema declares that `viewer` permission on a `document` includes `parent->viewer`:

```zed
definition document {
  relation parent: project
  relation direct_viewer: user

  permission view = direct_viewer + parent->view
}

definition project {
  relation parent: workspace
  relation direct_viewer: user

  permission view = direct_viewer + parent->view
}
```

When Alice checks `view` on `spec_v2`, the traversal follows: `spec_v2 -> project:api_docs -> workspace:eng -> organization:acme -> member:alice`. One check call resolves four levels of hierarchy without any application code knowing the structure exists.

### Change Propagation

This is where ReBAC gets its correctness advantage over cached-role systems: there is no propagation step. The hierarchy lives in the relation tuples; the check algorithm traverses it live. When Alice is removed from `organization:acme`, the next check fails immediately — not after some cache expiry or background sync job completes.

The tradeoff is traversal depth. Deep hierarchies (org → workspace → project → folder → subfolder → document) require proportionally deeper graph traversal. Zanzibar addresses this via:
1. **Namespace-level caching**: caching resolved permission sets for `(object, permission)` pairs, not just individual tuples
2. **Consistency snapshots**: checks at a given snapshot timestamp can reuse cached results from the same snapshot
3. **Parallel expansion**: sibling branches of the userset rewrite are traversed concurrently

In practice, hierarchies deeper than 5–6 levels become performance-sensitive and warrant schema redesign (flattening via denormalized tuples, or introducing intermediate caching groups).

### The New Enemy Problem

Zanzibar's original paper named a specific correctness hazard: the **new enemy problem**. Scenario: Bob is removed from a document's access list, then Alice writes new content to the document. If the system uses a stale permission snapshot, Bob might still see the new content — the adversary who was supposed to be removed is now an unintended reader of fresh data.

The solution is zookies (consistency tokens): when Alice's write completes, the system returns a token encoding the transaction timestamp. When the document is next read, the application passes this token to the check call, instructing the authorization service to use a snapshot *at least as fresh as this write*. This guarantees that the access-removal is visible during the access check that guards the new content. SpiceDB's ZedTokens and OpenFGA's continuation tokens implement this same semantic.

---

## 4. ReBAC in Microservice Architectures

### The Cross-Service Problem

In a microservice architecture, authorization is naturally distributed: the knowledge base service owns document permissions, the billing service owns entitlement data, the agent runtime service owns execution permissions. A single user action may require checking permissions across three services simultaneously.

Naive implementations give each service its own authorization database. This produces inconsistency (the same user may appear "member" in service A and "suspended" in service B), duplicated logic (every service reimplements the same role-check middleware), and operationally fragile state (permission changes must be applied in N services with no atomicity guarantee).

ReBAC's graph model offers a clean architectural answer: a **centralized authorization service** becomes the single source of truth for all relationship data, and every microservice calls it for permission decisions.

### Centralized Authorization Service

The topology: every service in the platform contains no authorization logic. Instead, each service makes gRPC or HTTP calls to a shared authorization service (SpiceDB, OpenFGA, etc.) before performing sensitive operations.

```
┌─────────────────────────────────────────────────────┐
│                 Client Application                   │
└──────────────────────┬──────────────────────────────┘
                       │
              ┌────────▼────────┐
              │   BFF / Gateway  │
              └────────┬────────┘
          ┌────────────┼────────────┐
          │            │            │
   ┌──────▼─────┐ ┌───▼──────┐ ┌──▼───────────┐
   │  KB Service │ │  Agent   │ │  Billing Svc  │
   │             │ │  Runtime │ │               │
   └──────┬──────┘ └────┬─────┘ └──────┬────────┘
          │             │              │
          └─────────────┼──────────────┘
                        │
              ┌─────────▼─────────┐
              │  Authorization Svc  │
              │  (SpiceDB/OpenFGA)  │
              └─────────────────────┘
```

Benefits: single source of truth, atomic permission changes, consistent audit trail, schema-enforced permission model. Cost: added network hop per authorization check, centralized failure point.

### Embedded PDP (Policy Decision Point)

For latency-sensitive paths, some architectures deploy a **local PDP** — a read-only replica of the authorization service running as a sidecar or in-process library. The local PDP caches a subset of the relationship graph and handles checks locally, syncing from the central service via the Watch API.

This is the pattern used in Zanzibar's own architecture: aclserver nodes replicate tuples from Spanner into memory and serve checks locally, using the Watch API to maintain freshness. SpiceDB Enterprise supports a similar pattern via its "dispatch" layer and headless caching node mode.

The tradeoff: eventual consistency windows. If the Watch stream lags by 200ms, permission revocations are visible to the central service but not yet to the local PDP. For most operations this is acceptable; for security-critical revocations (e.g., account suspension, document removal), the application must use a consistency token that forces a fresh check.

---

## 5. ReBAC + BFF Pattern

### BFF as the Authorization Boundary

The Backend for Frontend (BFF) pattern consolidates client-specific API composition behind a single entry point, typically one BFF per client type (web, mobile, external API). In a ReBAC architecture, the BFF is the natural place to enforce *coarse-grained* authorization: is this user allowed to call this BFF endpoint at all?

The BFF has two key responsibilities:

**1. Identity injection**: The BFF holds the authenticated session (or validates the JWT). Before calling downstream services, it injects the caller's canonical user identity into every request header — typically as a `X-User-ID` claim that downstream services trust without re-validating. This prevents each microservice from needing to run full token validation.

**2. Pre-check at the BFF**: For operations with clear authorization requirements, the BFF performs a `Check(user, permission, resource)` call against the authorization service before dispatching to downstream services, failing fast without making unnecessary downstream calls.

```typescript
async function handleDocumentEdit(req: Request): Promise<Response> {
  const userId = req.session.userId;
  const docId = req.params.id;

  // Pre-check: fail fast before touching downstream services
  const allowed = await authz.check({
    subject: `user:${userId}`,
    permission: 'edit',
    object: `document:${docId}`,
  });

  if (!allowed) return { status: 403 };

  // Downstream call with injected identity
  return await docService.edit(docId, req.body, { userId });
}
```

### Post-Filter for List Operations

Pre-check works for single-resource operations. For list operations — "show me all documents I can view in this workspace" — the pattern shifts to **LookupResources**: query the authorization service for the set of resources the user has permission on, then filter the downstream result set, or use the authorization service's response as the query filter directly.

```typescript
// Query authorization service for all viewable documents
const viewableDocIds = await authz.lookupResources({
  subject: `user:${userId}`,
  permission: 'view',
  objectType: 'document',
});

// Use result set as filter in downstream query
const docs = await docService.listByIds(viewableDocIds);
```

This is architecturally cleaner than fetching all documents and post-filtering client-side, but requires the authorization service to have low-latency LookupResources support. SpiceDB's `LookupResources` API is designed for exactly this use case.

### Contextual Tuples for BFF-Level Context

OpenFGA's contextual tuples enable a powerful BFF pattern: enriching authorization checks with context that lives in the session but not in the persistent relationship store. For example, if a user authenticates with a "read-only" OAuth scope, the BFF can inject a contextual tuple `token:session_xyz#scope@read_only` into the check call, causing the authorization service to evaluate a more restrictive permission without this scope ever being written to the persistent tuple store.

---

## 6. Performance: Graph Traversal, Caching, and Consistency

### Graph Traversal Complexity

A `Check` call in ReBAC is a graph reachability query. Worst-case complexity is O(E) where E is the number of edges (tuples) in the subgraph reachable from the queried object. For typical application graphs — shallow hierarchies, bounded group sizes — this is fast. For pathological cases — deeply nested groups, documents with thousands of direct ACL entries — traversal can become expensive.

Zanzibar's published numbers: 95th percentile check latency of 3ms for a deployment handling 10 million QPS. This is achievable because most permission checks touch only a small subgraph. The key optimization is **namespace-level result caching**: cache the resolved permission set for a given object at a given consistency snapshot. When Alice's document is accessed by 1000 concurrent users, only the first check traverses the graph; subsequent checks hit the cache.

### Consistency Models

ReBAC systems offer a spectrum of consistency guarantees:

**Full consistency (snapshot isolation)**: every check reads data as of a specific transaction. Correct but expensive — requires routing to a replica that has the specified snapshot available, potentially waiting for replication lag.

**Minimize latency (best effort / eventual)**: checks may use slightly stale data. Fast (reads from the nearest replica) but subject to new-enemy-class correctness issues if revocations are recent.

**At-least-as-fresh (zookie/ZedToken)**: the production default. Callers pass a token encoding the minimum acceptable snapshot. The authorization service serves from any replica that has replicated at least to that snapshot. This balances correctness and performance: common reads use local replicas, security-critical checks use fresh snapshots.

SpiceDB documents this as three explicit consistency levels: `fully_consistent`, `at_least_as_fresh`, and `minimize_latency`. OpenFGA uses a similar distinction via its `consistency` parameter.

### The Watch API and Cache Invalidation

For deployments with local PDPs or application-level authorization caches, the Watch API is the invalidation mechanism. SpiceDB's Watch API streams a sequence of relationship change events (`TOUCH` / `DELETE`) starting from a specified token. Consumers maintain a local materialized view of the subgraph they care about, rebuilding derived caches on each change event.

This is also the mechanism for feeding downstream systems: a search index that needs to know which documents are publicly visible can subscribe to Watch, updating its visibility flags on every permission change in near-real-time.

---

## 7. Real-World Patterns: Google Docs, Notion, and Document Platforms

### Google Drive / Docs

Google Drive's authorization model is the direct inspiration for Zanzibar. A document has up to four permission levels: `owner`, `writer`, `commenter`, `viewer`. Sharing a folder grants the same level to all contained documents unless overridden. Organization-level settings (e.g., "anyone at acme.com can view") are expressed as userset entries in the document's ACL rather than as application-level logic.

The critical implementation detail: Google Drive supports link-based sharing (`anyone with the link can view`). In Zanzibar terms, this is a wildcard tuple: `document:X#viewer@user:*`. The wildcard subject matches any authenticated user during check traversal. SpiceDB explicitly supports wildcard subjects with the `user:*` syntax; OpenFGA uses the `user:*` form as well.

### Notion's Multi-Level Inheritance

Notion's permission model has three levels: workspace → teamspace → page, with blocks nested arbitrarily inside pages. A workspace member has access to all public teamspaces; a private teamspace restricts access to its explicit members. Pages inherit from their teamspace unless explicitly shared outside it.

The Zanzibar mapping:
- `workspace:X#member@user:alice`
- `teamspace:Y#parent@workspace:X` with a `viewer` permission that includes `parent->member` (unless teamspace is private, in which case the `parent->member` branch is absent from the schema)
- `page:Z#parent@teamspace:Y`
- `block:B#parent@page:Z`

Notion's block-level permissions are where the graph gets deep. A page with 500 nested blocks, each inheriting from the page, means a `Check` on a deeply nested block traverses up to the page level. Notion addresses this by materializing the effective permission at the page level and not re-traversing the block graph on each check — blocks inherit from their root page, not their immediate parent block, flattening traversal depth.

### AI Platforms: The Emergent Use Case

Multi-service AI platforms — knowledge bases, agent runtimes, tool registries, billing engines — have a permission surface that traditional RBAC cannot cleanly address:

- **RAG authorization**: a retrieval step should only surface documents the *querying agent's principal* has `view` permission on. This requires `LookupResources` at retrieval time, not post-filtering after the LLM has already seen the content.
- **Agent delegation**: an agent acting on behalf of user Alice should have at most Alice's permissions, typically expressed as a tuple `agent:session_xyz#delegate@user:alice` with the schema enforcing that `agent.view = delegate->user.view`.
- **Tool permissions**: an agent with `execute` permission on a tool should be checked against both the agent's identity and the tool's ACL, requiring a cross-namespace join: `tool:T#executor@agent:session_xyz` combined with `agent:session_xyz#owner@user:alice`.
- **Temporal entitlements**: billing-gated features expressed as caveats on relation tuples, enabling permissions that expire or activate based on subscription state without modifying the core relation graph.

The convergence of these requirements makes ReBAC not just a convenience for AI platforms but an architectural necessity. The alternative — bespoke permission checks scattered across microservices — breaks down the moment a security audit asks "can you prove that no agent can access a document its owner hasn't shared with it?"

---

## Operational Considerations

### Schema Migration

ReBAC schemas, like database schemas, require migration discipline. Adding a new relation type is safe. Removing or renaming a relation requires first ensuring no tuples reference it, then updating application code that writes those tuples, then updating the schema. SpiceDB's schema validation tooling (`zed validate`) and OpenFGA's model version system both support staged migrations.

### Audit Trail

Every tuple write should be logged with the actor (who created/deleted the relationship) and the timestamp. This is the authorization audit trail: it answers "when did Alice gain edit access to this document?" Zanzibar's changelog (backed by Spanner's commit timestamps) provides this natively. Open-source implementations vary: SpiceDB's Watch API can be used to build an external audit log; Permify has built-in audit trail support.

### Observability

Authorization systems must be observable. Key metrics:
- Check latency (p50, p95, p99) per namespace and permission type
- Cache hit rate by object type
- Watch lag (difference between relationship write time and Watch event delivery)
- Tuple store size growth rate by namespace

SpiceDB exposes Prometheus metrics; OpenFGA has OpenTelemetry integration.

---

## Conclusion

ReBAC is the right authorization model for any platform where permissions are relational, hierarchical, or shared across services. The Google Zanzibar paper made the model concrete and the 2019–2026 open-source ecosystem made it deployable. SpiceDB and OpenFGA together cover the vast majority of production requirements, with SpiceDB for teams that want Zanzibar-faithful semantics and OpenFGA for teams in the Auth0/CNCF orbit.

The architectural payoff is significant: a centralized ReBAC service replaces ad-hoc permission checks scattered across a microservice fleet with a uniform, auditable, schema-enforced permission graph. The BFF layer handles coarse-grained pre-checks and identity injection; downstream services call the authorization service for fine-grained decisions; the Watch API keeps caches consistent. Hierarchical inheritance is free — it falls out of the schema definition rather than requiring propagation infrastructure.

For multi-service AI platforms specifically, ReBAC is no longer optional. The combination of cross-service relationships (user → agent → tool → document), temporal entitlements (billing gates), and retrieval-time authorization (RAG access control) requires a model that can express and evaluate these relationships at query time, not at write time. ReBAC, backed by SpiceDB or OpenFGA, is the only general solution currently production-proven at scale.

---

*Sources:*
- *[Google Zanzibar: Google's Consistent, Global Authorization System — USENIX ATC 2019](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/)*
- *[AuthZed: What is Google Zanzibar?](https://authzed.com/learn/google-zanzibar)*
- *[OpenFGA Documentation — Contextual Tuples](https://openfga.dev/docs/interacting/contextual-tuples)*
- *[SpiceDB Schema Language Reference](https://authzed.com/docs/spicedb/concepts/schema)*
- *[WorkOS: Top 5 Google Zanzibar Open-Source Implementations in 2024](https://workos.com/blog/top-5-google-zanzibar-open-source-implementations-in-2024)*
- *[Aserto: How Google Drive Models Authorization](https://www.aserto.com/blog/google-zanzibar-drive-rebac-authorization-model)*
- *[PkgPulse: OpenFGA vs Permify vs SpiceDB 2026](https://www.pkgpulse.com/guides/openfga-vs-permify-vs-spicedb-zanzibar-authorization-2026)*
- *[AuthZed: Consistency is the Key to Performance and Safety](https://authzed.com/blog/consistency-is-the-key-to-performance-and-safety)*
- *[Oso: ReBAC in Microservices](https://www.osohq.com/microservices-glossary/re-bac-in-microservices)*
- *[Microservices.io: Authentication and Authorization in a Microservice Architecture](https://microservices.io/post/architecture/2025/04/25/microservices-authn-authz-part-1-introduction.html)*
