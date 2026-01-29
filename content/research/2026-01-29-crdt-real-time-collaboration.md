---
date: "2026-01-29"
time: "14:18"
title: "CRDTs and Real-Time Collaboration: Building Conflict-Free Distributed Systems"
description: "A comprehensive guide to Conflict-free Replicated Data Types (CRDTs), their production use, modern implementations, and the trade-offs between CRDTs and Operational Transformation for building collaborative applications."
tags:
  - research
  - crdt
  - distributed-systems
  - real-time-collaboration
  - operational-transformation
  - yjs
  - automerge
  - local-first
---

## Executive Summary

Conflict-free Replicated Data Types (CRDTs) enable distributed systems to achieve eventual consistency without coordination. In 2026, CRDTs have become foundational for local-first software, powering collaborative applications from Figma to League of Legends chat. Modern implementations like Yjs and Automerge 2.0 have overcome historical performance challenges, with Automerge achieving **600ms processing time for 260,000 keystrokes** (down from 2 seconds per character) and Yjs handling **26K-156K operations per second**.

The CRDT vs Operational Transformation (OT) debate has evolved: **Google Docs uses OT** for centralized real-time editing with sub-millisecond latency, while **Figma switched from OT to CRDTs** in 2019 for offline-first capabilities. The consensus in 2026 is that the right choice depends on your architecture: use OT for reliable servers with centralized coordination, use CRDTs for offline-first, peer-to-peer, or distributed applications.

**Key Challenge**: The tombstone problem—where deleted elements persist as metadata—can cause files with 10 million tombstones to balloon to gigabytes. Production systems mitigate this through aggressive compaction, TTL policies, and hybrid architectures.

---

## What Are CRDTs?

Conflict-free Replicated Data Types (CRDTs) are data structures designed for distributed systems where:

1. **Replicas exist across multiple computers/devices**
2. **Updates happen independently without coordination**
3. **Conflicts are resolved automatically using mathematical properties**
4. **Replicas eventually converge to the same state**

CRDTs were formally defined in 2011 by Marc Shapiro, Nuno Preguiça, Carlos Baquero, and Marek Zawirski, initially motivated by collaborative text editing and mobile computing needs.

### Core Principle

With a CRDT, it is mathematically always possible to merge or resolve concurrent updates without conflicts or a central arbiter. This is achieved through algebraic properties (commutativity, associativity, idempotence) that guarantee convergence regardless of update order or network delays.

---

## CRDTs vs Operational Transformation

### How They Work

**Operational Transformation (OT)**:
- Transforms index positions to ensure convergence
- Requires central server for coordination
- Currently the de-facto standard for shared text editing
- OT approaches for distributed systems require too much bookkeeping to be viable in practice

**CRDTs**:
- Use mathematical models without index transformations
- Better suited for distributed systems
- Do not require central source of truth
- Can work offline and sync when reconnected

### Production Use Cases

| Company | Technology | Rationale |
|---------|-----------|-----------|
| **Google Docs** | OT | Centralized infrastructure, sub-millisecond SLOs, strong consistency |
| **Figma** | CRDTs (switched 2019) | Offline-first capabilities, decentralized collaboration |
| **Notion** | Hybrid | CRDT for structure, OT for text within blocks (fine-grained undo) |
| **Linear** | Hybrid | OT for issue descriptions, CRDTs for metadata (status, assignee, labels) |
| **League of Legends** | CRDTs (Riak) | Chat system: 7.5M concurrent users, 11K messages/second |

### When to Use Each

**Use Operational Transformation when:**
- You have reliable centralized servers
- Sub-millisecond latency is critical
- Compact representations are needed
- Coordinated synchronization is acceptable

**Use CRDTs when:**
- Clients must work offline
- Peer-to-peer sync is required
- Decentralized architecture is needed
- Data model complexity makes transformation functions unmanageable

### Performance Trade-offs

**OT Requirements:**
- Powerful servers (Google Docs runs on custom infrastructure)
- Network reliability and low latency
- Centralized coordination overhead

**CRDT Requirements:**
- Beefier client devices (pushes computation to clients)
- Larger bundle sizes (CRDT libraries: 100-200KB minified)
- Memory overhead from metadata (2-3x actual data in production)

---

## Modern CRDT Implementations

### 1. Yjs - The Performance Leader

Yjs is the fastest CRDT implementation for web-based applications, created by Kevin Jahns and optimized for text editing.

**Performance Characteristics**:
- 26K to 156K operations per second for text editing
- Most efficient encoding among web CRDTs
- Uses YATA (Yet Another Transformation Approach) algorithm
- Stores 100KB document in 160KB on disk or 3MB in memory

**Key Features**:
- Network agnostic (supports peer-to-peer)
- Rich editor bindings: CodeMirror, Monaco, Quill, ProseMirror
- Offline editing support
- Version snapshots and undo/redo
- Shared cursors for multiplayer editing

**Architecture**:
- Exposes internal data structure as shared types
- Uses columnar encoding (inspired by Martin Kleppmann)
- RLE (Run-Length Encoding) tricks for compression
- Sparse data structures (skip lists, B-trees) to avoid O(n) traversal

### 2. Automerge 2.0 - Rust-Powered Efficiency

Automerge focuses on JSON-like data structures with a clean API, designed to feel like working with regular JavaScript objects while providing automatic conflict resolution.

**Performance Evolution**:
- **Before 2.0**: Some single character inserts took 2 seconds CPU time
- **Automerge 2.0**: 260,000 keystrokes processed in 600ms
- **Automerge 3**: Achieved ~10x reduction in memory usage

**Implementation Details**:
- Core Rust implementation with WebAssembly bindings
- FFI exposure for JavaScript+WASM, C, and other languages
- Team: Alex Good, Orion Henry, Andrew Jeffery, Jason Kankiewicz
- Benchmark: 76,358ms (JS mode) → 8,491ms (WASM mode) on test workload

**Metadata Efficiency**:
- Columnar encoding compresses metadata to 4-6 bytes per character
- Still 40-60% overhead versus raw text
- Trade-off: Automatic conflict resolution for storage cost

### 3. Emerging Implementations (2025-2026)

**Diamond Types**:
- Claims to be "the world's fastest CRDT"
- Rust implementation for plain text editing
- Supports concurrent P2P editing without centralized server
- Plain text only (JSON-style data types in development)

**Loro**:
- Based on Replayable Event Graph architecture
- Supports rich text, lists, maps, and movable trees
- Implements Fugue CRDT algorithm (minimizes interleaving anomalies)
- Uses Event Graph Walker (Eg-walker) from Diamond Types
- Borrows RLE compression tricks from Yjs and Diamond Types
- Bindings: Rust, JavaScript (via WASM), Swift

---

## The Tombstone Problem: Production Challenges

### What Is the Tombstone Problem?

In sequence CRDTs (RGA, WOOT), every deleted element becomes a "tombstone" that must be retained indefinitely to resolve conflicts. A 1,000-character document with heavy editing can accumulate **50,000 tombstones internally**.

### Real-World Impact

**Figma's Experience (2019)**:
- Shortly after switching to CRDTs, discovered documents with 10+ million tombstones
- Each tombstone: 32 bytes
- Result: Files ballooning to gigabytes

### Mitigation Strategies

| Approach | Description | Impact |
|----------|-------------|--------|
| **Aggressive Compaction** | Create new CRDT snapshot when tombstones exceed threshold (e.g., 1M) | File sizes drop 90% |
| **TTL Policies** | Discard history older than N days (Figma uses 7 days) | Prevents unbounded growth |
| **Periodic Cleanup** | Compact tombstones once all replicas have seen removal | Safe removal without consistency issues |
| **Hybrid Architectures** | Separate versioning from data, optimize storage format | 4-5x memory reduction achieved in production |

**Production Parameters**:
- CloudKitchens: `crdt_tombstone_ttl` option to define time-to-live
- Figma: Threshold of 1 million tombstones triggers compaction
- Sets/maps: Automatic periodic compaction after all replicas acknowledge

---

## Memory Overhead and Optimization

### The Cost of Metadata

CRDTs trade coordination for metadata. In production systems:

- **Typical overhead**: Metadata exceeds actual data by 2-3x
- **Container-based CRDTs**: 1KB protobuf blob → 4-5KB with containers
- **Automerge encoding**: 4-6 bytes per character (40-60% overhead vs raw text)
- **Tombstones**: Can accumulate to 50,000+ for heavily-edited 1,000 character docs

### Optimization Techniques

**1. Columnar Encoding (Automerge, Yjs)**
- Compress metadata into columnar format
- Yjs: 100KB document in 160KB on disk
- Automerge 2.0: Achieved hundreds of times faster performance through encoding optimization

**2. Run-Length Encoding (RLE)**
- Compress consecutive similar operations
- Borrowed by Loro from Yjs and Diamond Types
- Significantly reduces memory for typical editing patterns

**3. Sparse Data Structures**
- Skip lists and B-trees instead of linear traversal
- Avoids O(n) costs for lookups
- Trade-off: Adds CPU overhead, increases complexity

**4. Operation-Based CRDTs**
- Transmit only update operations (typically small)
- Requires causal order delivery and no message loss
- More efficient than state-based replication for large datasets

---

## The Local-First Software Movement

### 2026 Ecosystem Overview

CRDTs are foundational to the **local-first software paradigm**, which emphasizes:
- Data ownership for users
- Offline-first capabilities
- Real-time collaboration without cloud dependency
- Enhanced security and privacy

**Motto**: "You own your data, in spite of the cloud"

### Key Players

**ElectricSQL**:
- Bridges backend Postgres and client SQLite
- Writes directly to Postgres using CRDTs for deterministic merging
- **TCC+ (Transactional Causal Consistency with CRDTs)**
- Rich-CRDT techniques maintain referential integrity
- Provides automated conflict resolution

**PowerSync**:
- Sends writes through application backend
- Allows customization with business logic, authorization, validations
- Serves as CRDT data provider for local storage
- Propagates changes with fine-grained control
- Useful when last-write-wins isn't sufficient (e.g., document editing)

**Broader Ecosystem Tools**:
- Automerge, Y.js (Yjs), Jazz, Fireproof
- DXOS, Zero, ElectricSQL, PowerSync
- Multiple P2P protocols and sync engines
- Collaborative editors and applications

### FOSDEM 2026

The FOSDEM 2026 conference features a dedicated track on "Local-First, sync engines, CRDTs", indicating mainstream adoption and active development in the ecosystem.

---

## Best Practices and Decision Framework

### Choosing the Right CRDT Type

**State-Based CRDTs**:
- Simpler to design and implement
- Only requires gossip protocol for communication
- Replicate entire state (larger network overhead)
- Better for smaller datasets or infrequent updates

**Operation-Based CRDTs**:
- Transmit only update operations (small messages)
- Requires: no dropped/duplicated operations, causal order delivery
- More efficient for large datasets with frequent updates
- Complex infrastructure requirements

### Common CRDT Types and Use Cases

| CRDT Type | Conflict Resolution | Use Case |
|-----------|---------------------|----------|
| **G-Counter** | Sum of increments | Distributed counters (likes, views) |
| **PN-Counter** | Sum of increments and decrements | Counters that can decrease |
| **LWW-Register** | Last-Write-Wins (timestamp) | Simple key-value updates |
| **MV-Register** | Multi-Value (preserves conflicts) | When conflicts need manual resolution |
| **OR-Set** | Observed-Remove (unique IDs) | Distributed sets, tag lists |
| **RGA/WOOT** | Sequence operations | Collaborative text editing |
| **Boolean Flag** | "True wins" | Feature flags, toggles |

### When NOT to Use CRDTs

**Avoid CRDTs if:**
1. **User interaction required for conflict resolution**: When business logic needs human decisions, CRDTs can't help
2. **Strong consistency is mandatory**: Financial transactions, critical systems requiring immediate consistency
3. **Static JSON operators insufficient**: Complex document changes that can't be represented as JSON operations
4. **Small dataset with centralized server**: OT may be simpler and more efficient

### Designing for CRDTs

**Key Principles**:
1. **Understand operation semantics**: All operations must be commutative, associative, and idempotent
2. **Version vectors for causality**: Track causal dependencies to prevent anomalies
3. **Merge determinism**: Same inputs must always produce same output
4. **Plan for tombstones**: Design cleanup strategy from day one
5. **Monitor metadata growth**: Set up alerts for unbounded growth patterns

---

## Production Deployment Checklist

### Performance Monitoring

- [ ] Track metadata-to-data ratio (alert if > 3x)
- [ ] Monitor tombstone accumulation (set thresholds)
- [ ] Measure merge operation latency
- [ ] Profile memory usage on client devices
- [ ] Monitor bundle size impact (web applications)

### Cleanup and Maintenance

- [ ] Implement tombstone compaction (automated)
- [ ] Define TTL policy for historical data
- [ ] Schedule periodic full snapshots
- [ ] Test compaction doesn't break active replicas
- [ ] Document recovery procedures for corruption

### Client-Side Considerations

- [ ] Ensure devices can handle CRDT libraries (100-200KB)
- [ ] Test offline-to-online sync scenarios
- [ ] Handle merge conflicts in UI gracefully
- [ ] Provide feedback during long sync operations
- [ ] Cache strategy for frequently accessed CRDTs

### Infrastructure Requirements

- [ ] Causal order delivery for operation-based CRDTs
- [ ] Gossip protocol for state-based CRDTs
- [ ] Backup strategy for CRDT state
- [ ] Version upgrade path (breaking CRDT changes)
- [ ] Monitoring and observability tools

---

## The Future of CRDTs (2026 and Beyond)

### Emerging Trends

**1. Hybrid Architectures Becoming Standard**
- Notion's approach (CRDT structure + OT text) is being adopted widely
- Linear's model (OT for content, CRDTs for metadata) shows pragmatic trade-offs
- Future: More frameworks will offer pluggable conflict resolution strategies

**2. Performance Continues to Improve**
- Diamond Types and Loro pushing CRDT performance boundaries
- Rust implementations with WASM bindings becoming standard
- Expected: Sub-millisecond merge operations even for large documents

**3. Local-First Goes Mainstream**
- Prediction: AI + local-first architectures will dominate 2026
- Speed and reliability of local-first combined with AI intelligence
- User data ownership becoming competitive advantage

**4. Rich-CRDTs and Semantic Guarantees**
- Beyond basic conflict-free properties
- ElectricSQL's TCC+ maintaining referential integrity
- Future: CRDTs that understand domain-specific constraints (e.g., calendar conflicts, inventory limits)

### Open Research Questions

- **Efficient rich text CRDTs**: Minimizing interleaving anomalies (Loro's Fugue is promising)
- **Schema evolution**: How to safely upgrade CRDT types in production
- **Cross-CRDT transactions**: Atomic updates across multiple CRDT instances
- **Security and access control**: Fine-grained permissions in decentralized CRDTs
- **AI-assisted conflict resolution**: Using LLMs to propose merge strategies for complex conflicts

---

## Recommendations for AI Agent Systems

For systems like Zylos building collaborative features:

**1. Start Simple**
- Begin with last-write-wins (LWW-Register) for most fields
- Use OR-Set for collections (tags, lists)
- Graduate to sequence CRDTs only when needed

**2. Choose Based on Architecture**
- **Centralized + Real-time**: Consider OT (simpler, proven)
- **Distributed + Offline-first**: Use CRDTs (Yjs or Automerge)
- **Hybrid**: Mix strategies like Notion and Linear

**3. Monitor from Day One**
- Tombstone accumulation is inevitable
- Memory overhead will grow over time
- Plan compaction strategy before launch

**4. Leverage Existing Libraries**
- **Web applications**: Yjs (best performance, mature ecosystem)
- **Cross-platform (mobile/desktop)**: Automerge (clean API, multiple bindings)
- **Bleeding edge**: Watch Loro and Diamond Types for future adoption

**5. Local-First for Agent Collaboration**
- Multiple AI agents editing shared state = perfect CRDT use case
- Offline-first enables agents to work independently
- Eventual consistency fits agent collaboration model

---

## Conclusion

CRDTs have matured from academic research to production-ready technology powering real-time collaboration at massive scale. In 2026, the choice between CRDTs and Operational Transformation is no longer ideological but architectural: centralized systems benefit from OT's efficiency, while distributed and offline-first applications demand CRDTs' conflict-free guarantees.

The tombstone problem remains a fundamental challenge, but production systems have developed effective mitigation strategies through aggressive compaction, TTL policies, and hybrid architectures. Modern implementations like Yjs and Automerge 2.0 have overcome historical performance barriers, making CRDTs viable even for demanding applications.

As the local-first software movement gains momentum, CRDTs are positioned as foundational infrastructure for the next generation of collaborative applications. For AI agent systems requiring multi-agent coordination, CRDTs offer a mathematically sound approach to achieving eventual consistency without centralized control.

**Key Takeaway**: There is no universal "best" CRDT—only CRDTs suited to different problems. Success lies in understanding your system's requirements (offline vs online, centralized vs distributed, text vs structured data) and choosing the CRDT type and implementation that matches your constraints.

---

*Sources:*
- [Conflict-free replicated data type - Wikipedia](https://en.wikipedia.org/wiki/Conflict-free_replicated_data_type)
- [About CRDTs • Conflict-free Replicated Data Types](https://crdt.tech/)
- [The CRDT Dictionary: A Field Guide to Conflict-Free Replicated Data Types](https://www.iankduncan.com/engineering/2025-11-27-crdt-dictionary/)
- [CRDTs solve distributed data consistency challenges - Ably](https://ably.com/blog/crdts-distributed-data-consistency-challenges)
- [Diving into Conflict-Free Replicated Data Types (CRDTs) - Redis](https://redis.io/blog/diving-into-crdts/)
- [CRDTs vs. Operational Transformation: How Google Docs Handles Collaborative Editing](https://systemdr.substack.com/p/crdts-vs-operational-transformation)
- [I was wrong. CRDTs are the future - Joseph Gentle](https://josephg.com/blog/crdts-are-the-future/)
- [GitHub - yjs/yjs: Shared data types for building collaborative software](https://github.com/yjs/yjs)
- [CRDT Implementation Guide - Velt](https://velt.dev/blog/crdt-implementation-guide-conflict-free-apps)
- [How Figma's multiplayer technology works - Figma Blog](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)
- [List CRDT Benchmarks - JSON Joy](https://jsonjoy.com/blog/list-crdt-benchmarks)
- [Introducing Automerge 2.0](https://automerge.org/blog/automerge-2/)
- [Automerge 2.0 - Hacker News](https://news.ycombinator.com/item?id=34586433)
- [Outperforming Industry Standard CRDT Implementations - CloudKitchens](https://techblog.cloudkitchens.com/p/protocol-buffer-crdts-outperforming)
- [An introduction to Conflict-Free Replicated Data Types: Tombstones](https://lars.hupel.info/topics/crdt/05-tombstones/)
- [The Architecture Shift: Why I'm Betting on Local-First in 2026](https://dev.to/the_nortern_dev/the-architecture-shift-why-im-betting-on-local-first-in-2026-1nh6)
- [ElectricSQL (Legacy) Vs PowerSync](https://www.powersync.com/blog/electricsql-vs-powersync)
- [Local-first sync for Postgres from the inventors of CRDTs - ElectricSQL](https://electric-sql.com/blog/2023/09/20/introducing-electricsql-v0.6)
- [GitHub - josephg/diamond-types: The world's fastest CRDT](https://github.com/josephg/diamond-types)
- [GitHub - loro-dev/loro: Make your JSON data collaborative](https://github.com/loro-dev/loro)
- [CRDT Algorithms - Loro Dev](https://deepwiki.com/loro-dev/loro/6.1-crdt-algorithms)
- [Understanding CRDTs and Their Role in Distributed Systems - TiDB](https://www.pingcap.com/article/understanding-crdts-and-their-role-in-distributed-systems/)
- [Introducing Rich-CRDTs - ElectricSQL](https://electric-sql.com/blog/2022/05/03/introducing-rich-crdts)
- [FOSDEM 2026 - Local-First, sync engines, CRDTs](https://fosdem.org/2026/schedule/track/local-first/)
