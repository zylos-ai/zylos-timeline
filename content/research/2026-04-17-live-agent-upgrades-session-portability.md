---
date: "2026-04-17"
title: "Live Agent Upgrades and Cross-Runtime Session Portability (2026)"
description: "How production AI agents upgrade harness, runtime, and model versions without losing context, identity, or in-flight work — state surface, migration strategies, and cross-runtime portability."
tags: ["ai-agents", "agent-infrastructure", "live-upgrade", "session-migration", "mcp", "agent-portability"]
---

## Executive Summary

- Long-running agents accumulate state across seven distinct surfaces — conversation transcript, tool-call history, persistent memory, scheduled-task ownership, credential bindings, background process handles, and behavioral conditioning — and all seven must survive a harness or model upgrade for the agent to continue work without regression.
- Claude Code's current upgrade path is a graceful-shutdown-plus-restart cycle with manual memory sync; GitHub issue #14114 documents the community push for an in-process `/upgrade` command that would serialize full session state, restart with the new binary, and restore in-place with zero quality loss.
- LangGraph's checkpointer abstraction (SQLite, Postgres, Redis, DynamoDB, CosmosDB) is the most mature production pattern for pause-serialize-resume; each super-step produces an immutable `StateSnapshot` keyed by `thread_id` + `checkpoint_id`, making replay across versions possible as long as the state schema is versioned.
- The SHADOW framework (2025) demonstrated zero-message-loss stateful microservice migration via the ShadowPod strategy: create a shadow from a CRIU checkpoint while the source continues serving, replay buffered messages, then exchange ownership through an ExchangeFence — translating directly to blue/green agent session handoffs.
- Cross-runtime portability hinges on two emerging standards: MCP as the tool-schema compatibility layer (adopted by Anthropic, OpenAI, and Google in 2025), and the AGNTCY SLIM protocol as the secure transport for carrying agent sessions across runtimes; both remain works-in-progress for full session migration.
- Persona drift after model upgrades is a documented and measurable risk — caused by attention-weight dilution of system-prompt tokens as context grows — and requires active countermeasures: memory anchoring, activation capping, and periodic persona-stability self-checks.
- The industry is converging on continuous delivery for agents: LLM providers update on a near-monthly cadence (Gartner, 2026), and teams that delay upgrades accumulate model-behavior debt faster than software version debt, but upgrading without a tested migration path triggers regressions that erode user trust.

---

## 1. The Problem: Upgrading Without Losing the Thread

Modern AI agents are not stateless request handlers. A long-running Claude Code session, a LangGraph workflow mid-execution, or a Letta agent that has been accumulating memory for weeks represents a significant investment of context. Upgrading any layer of the stack — the harness binary, the underlying model, or the runtime CLI — risks discarding that investment.

The stakes are concrete. A GitHub issue filed against Claude Code in early 2026 describes what happens when a user upgrades mid-session and resumes: "Claude Code is definitely dumber after the compaction. It doesn't know what files it was looking at and needs to re-read them. It will make mistakes you specifically corrected again earlier in the session." The issue proposes a `/upgrade` slash command that would serialize the full session state, restart with the new binary, and restore state in-place. This is the unsolved problem that the entire industry is circling.

Three upgrade triggers produce distinct risk profiles:

- **Harness upgrade** (e.g., `npm i -g @anthropic-ai/claude-code` to a new patch): lowest risk if the conversation format is stable, highest operational friction because it requires a process restart.
- **Model upgrade** (e.g., Claude Sonnet 4.5 → Claude Sonnet 4.6): medium risk to behavior, zero risk to persistent memory, but can cause persona drift and changed tool-call patterns.
- **Runtime migration** (e.g., Claude Code → Codex CLI → custom harness): highest risk; requires format conversion, credential remapping, and tool-schema translation.

---

## 2. The State Surface That Must Migrate

Before designing a migration strategy, it is necessary to enumerate what actually needs to move. Seven categories of state accumulate during a long-running agent session:

**Conversation transcript.** The raw sequence of user/assistant turns. Both the Anthropic Messages API (`/v1/messages`) and the OpenAI Chat Completions API (`/v1/chat/completions`) serialize this as a JSON array of role-keyed message objects; conversion between formats requires translating tool-use blocks, which differ significantly between the two schemas.

**Tool-call history.** The record of which tools were called, with what arguments, and what they returned. This is load-bearing: an agent that resumes after an upgrade needs to know which file edits have already been applied, which API calls have already been made (idempotency matters), and which side effects cannot be safely replayed.

**Persistent memory stores.** External knowledge accumulated by the agent — archival memory in Letta/MemGPT (vector-database-backed), CLAUDE.md and markdown files in Claude Code, `/memories` directory content in Anthropic's Memory Tool API (`memory_20250818`). These survive process restarts by definition, but schema migrations can break them if the agent's parsing logic changes.

**Scheduled-task ownership.** Cron and interval jobs registered with a scheduler (e.g., PM2, the Zylos C5 scheduler). On restart, tasks may execute against the old agent process, the new one, or neither if the task-ID mapping breaks.

**Background process handles.** References to background subagents, spawned child processes, or long-running tool calls. These are the hardest to migrate: handles are typically OS-level and do not survive process replacement.

**Credential and permission bindings.** API keys, OAuth tokens, and permission allowlists. Tool credentials must be present in the new runtime before first use or every tool call fails silently.

**Behavioral conditioning.** The most subtle surface. Over a long session, an agent accumulates implicit context: corrections the user made, patterns it learned not to repeat, mental models of the codebase. This lives only in the conversation transcript; summarization or compaction degrades it. The GitHub issue #14114 frames this as "behavioral state" — distinct from and harder to preserve than conversation text.

---

## 3. Migration Strategies

### 3.1 Pause-Serialize-Replay

The simplest strategy. The agent is halted at a quiescent point, all state is serialized to a durable store, and a new process is started that replays from the serialized state.

LangGraph implements this natively. Each graph super-step produces a `StateSnapshot`:

```json
{
  "values": { "messages": [...], "tool_results": {...} },
  "next": ["agent_node"],
  "config": {
    "thread_id": "session-abc",
    "checkpoint_ns": "",
    "checkpoint_id": "1ef9-..."
  },
  "metadata": { "source": "loop", "step": 42, "writes": {...} },
  "created_at": "2026-04-17T08:23:11Z",
  "parent_config": { "checkpoint_id": "1ef8-..." }
}
```

The `JsonPlusSerializer` default handles LangGraph primitives, datetimes, and enums; an `EncryptedSerializer` using AES (keyed via `LANGGRAPH_AES_KEY`) is available for sensitive payloads. Backends include SQLite (dev), Postgres (production), Redis (high-throughput), and DynamoDB (AWS-native). The critical constraint: state must be JSON-serializable. Complex objects like Pandas DataFrames require `pickle_fallback=True`, which breaks portability across Python versions.

Replay works by invoking the graph with a prior `checkpoint_id`. Nodes before the checkpoint are not re-executed; nodes after re-run, including LLM calls that may now return different results if the model has been upgraded. This is the behavioral drift window that requires testing.

### 3.2 Checkpoint-Plus-Version-Migration

Pause-serialize-replay breaks when the state schema changes between versions. The fix is schema versioning:

```python
STATE_VERSION = 3

def migrate_state(state: dict) -> dict:
    version = state.get("version", 1)
    if version < 2:
        state["tool_results"] = state.pop("results", {})
        state["version"] = 2
    if version < 3:
        state["scheduled_tasks"] = []
        state["version"] = 3
    return state
```

Every checkpoint must carry a `version` field, and every migration must be idempotent. LangGraph's Redis checkpoint library made a deliberate backward-incompatibility break in version 0.1.0 (new checkpoints use inline channel values; old format is unreadable without explicit migration). This caused production incidents for teams that updated the library without migrating existing checkpoints first.

Microsoft's Agent Framework addresses this with `FileCheckpointStorage` and a structured `WorkflowBuilder.checkpoint_storage` parameter, providing checkpointing that AutoGen's team abstraction lacks. The framework handles JSON serialization including datetime objects, which previously caused silent corruption when checkpoint blobs were deserialized.

### 3.3 Live Hot-Reload

A process-level variant where the new binary is loaded in-place without killing the existing process. nginx's `SIGHUP`-based config reload and PM2's graceful restart (`--wait-ready`) are the canonical models. For agents, this requires the harness to support signal-based state handoff: on SIGUSR1, serialize current state to a shared memory segment or named pipe; the new process reads and continues.

Claude Code's upgrade-claude skill approximates this: it enqueues `/exit` into the control queue, waits for idle detection, runs the native installer, and relies on the activity monitor (PM2) to restart the new binary. The gap is that state is not serialized between the old and new process — only what was written to memory files survives.

### 3.4 Dual-Runtime Shadow Deployment

The most robust pattern for high-stakes migrations. The new runtime runs in parallel, receiving a copy of all incoming messages, while the old runtime continues as primary. Outputs are compared; when confidence is sufficient, traffic shifts to the new runtime and the old one is decommissioned.

The SHADOW framework (published on arXiv in March 2026, targeting Kubernetes StatefulSets) formalizes this as the ShadowPod strategy: a shadow pod is created from a CRIU checkpoint image on the target node while the source pod continues serving traffic. The `ExchangeFence` mechanism handles the cutover: a temporary buffer queue captures messages during the ownership transfer, both source queues are drained before handoff completes, and the paper reports zero message loss across 280 experimental runs at message rates from 10 to 120 messages per second. Migration time decreased by up to 92% versus sequential stop-recreate approaches (from 38.5 seconds to 2.3–3.2 seconds).

For agents, the dual-runtime shadow pattern means: start the new model/harness version with an identical system prompt and memory snapshot; route a 5–10% canary of user traffic to it; compare tool-call patterns and output quality using an LLM judge; promote when divergence is within acceptable bounds.

### 3.5 Zero-Downtime Handoff via Message Queue

For multi-agent systems where individual agents are components, handoff can occur at the message-routing level. AutoGen's handoff pattern delegates tasks to other agents using a `UserTask` message published to a topic. The agent being replaced publishes a final message acknowledging handoff; the new agent subscribes to the same topic and continues. Session context consistency is the responsibility of the calling orchestrator.

CrewAI Flows supports a variant of this through the `@persist()` decorator, which saves state after every method execution to SQLite, PostgreSQL, or Redis. Each flow execution carries a UUID that persists across restarts: `self.state.id` remains constant through the flow's lifecycle, enabling external systems to track and resume specific executions.

---

## 4. Concrete Implementations in 2026

### Claude Code

Claude Code auto-updates natively (the npm installer is deprecated in favor of the native installer which updates in the background). The current upgrade path for active sessions: memory sync, send handoff summary to C4 conversation history so the session-init hook surfaces it on restart, enqueue `/exit`, wait for idle, run `curl -fsSL https://claude.ai/install.sh | bash`, and let the activity monitor restart. Version rollback is supported via `npm install -g @anthropic-ai/claude-code@2.4.1`. The community-requested `/upgrade` in-process command that preserves behavioral state has not shipped as of April 2026.

Anthropic's Memory Tool (`memory_20250818`) provides the closest thing to session-portable persistent state: a `/memories` directory that survives process restarts. The system prompt injected when the tool is enabled includes the instruction: "ASSUME INTERRUPTION: Your context window might be reset at any moment, so you risk losing any progress that is not recorded in your memory directory." Anthropic reports 84% token reduction in extended workflows and notes the tool pairs with compaction (server-side conversation summarization) to manage context across upgrade boundaries.

### OpenAI Codex CLI

Codex CLI (`@openai/codex`) upgrades via `npm i -g @openai/codex` or Homebrew. The CLI supports dynamic bearer tokens for model providers and MCP workflows, enabling session context to be declared externally rather than embedded in the process. April 2026 updates introduced Windows sandbox proxy-only networking and restored key MCP workflows after a regression. The underlying model series (GPT-5.3-Codex as of April 2026) upgrades independently of the CLI binary, meaning model behavior can change without a CLI restart.

### LangGraph

LangGraph's persistence layer is the most complete production implementation. The `get_state_history()` API returns the full checkpoint chain for any thread. Time-travel debugging allows rewinding to any prior `checkpoint_id`, editing state, and replaying forward — a pattern directly applicable to testing upgrades: replay historical sessions against the new model version and compare outputs. The LangGraph v1 migration (2025) was largely backward-compatible, with the main breaking change being the deprecation of `create_react_agent` in favor of `create_agent`.

### Letta (MemGPT)

Letta's memory architecture is explicitly designed for agent continuity. Three tiers:
- **Core memory** (in-context, analogous to RAM): immediately accessible structured blocks with defined character limits.
- **Recall memory** (conversation history searchable via embedding): persists to database.
- **Archival memory** (processed external knowledge in vector/graph store): survives agent restarts and model upgrades.

The MemGPT-to-Letta migration guide notes that official state migration is supported only with PostgreSQL backends; SQLite-based deployments are not guaranteed to migrate correctly across major versions. The new Letta V1 architecture drops the `send_message` tool and heartbeat pattern in favor of native model reasoning, which is a behavioral breaking change — agents migrated from MemGPT to V1 require prompt and tool-schema review.

### Semantic Kernel

Semantic Kernel (v1.35.0+) ships `ChatHistoryTruncationReducer` and `ChatHistorySummarizationReducer`. The summarization reducer truncates older turns, summarizes them using the LLM, and reinserts the summary as a single message — a lossy but context-preserving compression that survives model upgrades as long as the summary prompt is version-stable. The `ChatHistoryReducer` is a subclass of `ChatHistory`, making it drop-in compatible anywhere a history object is accepted.

### Google A2A Protocol

The A2A v1.0 specification (early 2026) adds `contextId` as a first-class field: "an identifier that logically groups multiple Task and Message objects, providing continuity across a series of interactions." The `historyLength` parameter on `GetTask` allows clients to reconstruct conversation state after disconnection. Full task migration between agent systems is not yet standardized — context and task IDs are server-generated per agent instance. Signed Agent Cards (cryptographic verification of agent identity) and version negotiation (backward-compatible migration from v0.3 to v1.0) are the v1.0 headline features.

### AGNTCY SLIM

SLIM (Secure Low-latency Interactive Messaging), donated to the Linux Foundation in July 2025 by Cisco with support from 65+ organizations, provides a transport layer for A2A and MCP traffic. Its session layer handles reliable delivery, end-to-end MLS (Messaging Layer Security) encryption, and group membership management. The SLIM-MCP integration bridges MCP protocol semantics over SLIM transport, enabling agents behind organizational firewalls to communicate with MCP servers using enterprise-grade security. A formal IETF draft specification exists at `datatracker.ietf.org/doc/draft-slim-protocol/`. SLIM does not yet specify session transfer semantics at the agent-state level; it is a transport, not a migration protocol.

---

## 5. Cross-Runtime Portability

Migrating a session between Claude Code, Codex CLI, and a custom harness requires solving three independent problems.

**Tool-schema compatibility.** MCP is the de facto solution. Adopted by Anthropic (November 2024), OpenAI (2025), and Google (2025), MCP defines tools in JSON Schema in a format that all three model families understand. An MCP server built once works with Claude, GPT-5, and Gemini without rewriting. LiteLLM acts as a translation proxy for the API wire format: it converts the Anthropic Messages API format (`/v1/messages`) to OpenAI's Chat Completions format (`/v1/chat/completions`) automatically. Tool results and tool-use blocks require mapping, particularly around multi-turn tool flows where the two formats diverge.

**Prompt format conversion.** Claude's system prompt can contain structured markdown, XML tags, and CLAUDE.md conventions. OpenAI's system prompt is a plain message. Gemini's instruction format is closer to OpenAI's. A cross-runtime migration requires a format adapter that preserves semantic intent without relying on format-specific features (e.g., Claude's `<thinking>` tags are not meaningful to GPT-5).

**Session ID portability.** Each runtime generates its own conversation ID space. A thread in LangGraph has a `thread_id`; a Claude Code session has a session ID stored in C4's conversation history; a Codex CLI session is ephemeral by default. Cross-runtime portability requires an application-level session ID that maps to runtime-specific IDs and a registry that can resolve "continue session X" across runtimes.

**MCP session resumability.** As of April 2026, MCP's Streamable HTTP transport identifies sessions via an `Mcp-Session-Id` header, but the spec has no standard mechanism for resuming a session after server restart or pod rescheduling. The 2026 roadmap targets this: "defining how sessions are created, resumed, and migrated so that server restarts and scale-out events are transparent to connected clients." The spec enhancement proposals (SEPs) are targeted for Q2 2026. Until they land, MCP sessions are effectively single-node-sticky.

---

## 6. Identity Preservation Across Upgrades

An agent's identity — its name, personality, communication style, and operational principles — is encoded in the system prompt. After a model upgrade, this encoding behaves differently: the new model weights interpret the same system prompt tokens differently, and the relationship between system-prompt assertions and output behavior shifts.

Research published in December 2025 identifies the mechanism: "as sequence length grows, the model's self-descriptive embeddings receive less weight compared to recent context tokens." Larger models exhibit greater identity drift. A blog post on context compaction published in 2026 names the practical consequence: "persona drift isn't an access control problem — it's a memory problem," caused by how summarization dilutes persona-specific details.

Three mitigation techniques are in active use:

**Memory anchoring.** Core identity assertions (name, principles, communication rules) are stored in a persistent memory file and reloaded at session start, not left solely in the system prompt. Anthropic's Memory Tool pattern explicitly supports this: the agent checks `/memories/identity.md` before any task. Zylos implements this via `memory/identity.md` which is always injected at session start.

**Periodic self-consistency checks.** The agent is prompted to describe itself at regular intervals; outputs are compared to the baseline system prompt using an LLM judge. Significant divergence triggers a system-prompt re-injection or a restart.

**Activation capping.** An inference-time intervention described in 2025 research measures typical "assistant-ness" projections and clamps activations to prevent the assistant identity component from dropping below a threshold. This requires model-level access (not available via standard APIs) but is available in self-hosted deployments.

---

## 7. Failure Modes

**Half-migrated state.** A migration that fails mid-process leaves the agent with inconsistent state: new process running, old memory store pointing to deprecated schema fields, new tool versions expecting fields that don't exist. The fix is transactional migration: write new state to a staging area, atomically swap pointers, and roll back if the new process fails health checks within a timeout window.

**Tool handle leaks.** Background processes spawned by the old agent instance (web scrapers, build watchers, browser sessions) continue running after the old process exits. The new process has no handles to these processes and cannot clean them up. The mitigation is a pre-upgrade hook that inventories all spawned processes, sends SIGTERM to each, and confirms exit before the upgrade proceeds.

**Orphaned scheduled jobs.** A scheduler that maps task IDs to the agent's process ID will route tasks to the now-dead process after upgrade. The new process must either re-register all tasks or use a task-ID scheme that is process-independent (e.g., agent-ID based rather than PID-based).

**Permission and credential mismatches.** A new harness version may add required permissions or change credential formats. If the `.env` or credential store has not been updated before the new binary starts, every credentialed tool call fails on first invocation.

**Model-behavior drift.** Even with identical system prompts and memory, a model upgrade changes behavior. Examples: a new model may be more likely to ask clarifying questions (increasing latency), less likely to produce verbose tool calls (changing API patterns), or more conservative about file writes (breaking automation scripts that rely on implicit consent). The only reliable detection is behavioral regression testing against golden sessions.

**Clock and timezone consistency.** Long-running agents may have scheduled tasks, timestamp comparisons, or time-dependent logic. After a restart, if the system timezone has changed or the scheduler's clock is not synchronized, scheduled tasks fire at wrong times. All timestamps in persistent state should be stored as UTC ISO 8601.

---

## 8. Testing Strategies

**Golden-session replay.** Record a representative set of agent sessions (inputs, expected tool calls, expected outputs) during baseline operation. Before each upgrade, replay all inputs against the new version and compare outputs. The Sakura Sky deterministic replay framework (2025) provides the full primitive set: a `TraceWriter` that records LLM calls and tool calls as append-only JSONL events, a `ReplayLLMClient` that returns recorded responses verbatim, and a regression test harness that uses historical traces as behavioral baselines.

**LLM-as-judge verification.** Where outputs are not deterministic, a separate LLM (ideally a different model family to avoid correlated errors) evaluates whether the new output is semantically equivalent to the golden output. Calibration: the judge is first aligned to human reviewers on a small labeled dataset, then deployed at scale. Scores include task completion, argument correctness, tool-call ordering, and policy compliance.

**Canary upgrade.** Ship the new version to a 5–10% traffic slice while keeping the old version as primary. Monitor error rate, latency, and user negative-feedback signals for 24–48 hours. Promote to 100% only after metrics are stable. For single-agent deployments (no traffic splitting), this requires running both old and new versions simultaneously — which requires the dual-runtime shadow infrastructure described above.

**Schema migration dry-runs.** Before applying a state-schema migration in production, run it against a copy of the production checkpoint store in a staging environment. Verify that all checkpoints deserialize correctly with the new schema and that spot-checked sessions replay with expected behavior.

---

## 9. The Economics of Upgrading (and Delaying)

Teams delay agent upgrades for three reasons: fear of behavioral regression breaking production workflows, the operational overhead of the migration procedure, and the absence of testing infrastructure to validate safety before cutover.

The cost of delay is rising. In 2026, Gartner projects that LLM providers are updating on a near-monthly cadence and that over 40% of enterprise AI projects will be canceled by 2027 due to inadequate governance — a figure that includes projects where stale model versions produced degraded outcomes that teams attributed to the technology rather than the maintenance gap.

The cost of upgrading without preparation is also real. A model upgrade that changes tool-call verbosity or consent patterns can break automation scripts silently. A harness upgrade that changes the memory file format can cause the agent to start every session from a blank slate.

The industry is trending toward continuous delivery for agents — treating model and harness upgrades as routine releases rather than exceptional events. This requires: automated golden-session regression tests that run on every upgrade candidate, canary infrastructure, schema-versioned persistent state, and a documented handoff procedure for in-flight sessions. Teams that have invested in LangGraph's checkpointer, Letta's tiered memory, or the Anthropic Memory Tool are building toward this capability. Teams using ephemeral in-memory state are one upgrade away from losing everything.

---

## 10. Implications for Zylos

Zylos already has more of this infrastructure than most teams: PM2-managed restarts, the upgrade-claude skill with graceful shutdown via control queue, C4 conversation history as a session-handoff channel, and a structured memory system (`identity.md`, `state.md`, `references.md`) that loads at session start. Six specific refinements emerge from this research:

**1. Add a `version` field to every persistent memory file.** Currently, `state.md` and related files have no schema version. If the memory format changes (e.g., adding a new field to the state structure), there is no migration path. Add a `schema_version: 1` frontmatter field to all memory markdown files and write a migration script for each major change. This costs almost nothing to implement and prevents silent corruption on upgrade.

**2. Implement pre-upgrade process inventory.** The upgrade-claude skill's pre-upgrade checklist covers background Task agents but not OS-level child processes. Add a step that runs `ps aux | grep zylos` (or equivalent), logs all child processes to `logs/upgrade.log`, and sends SIGTERM to non-essential ones before the `/exit` enqueue. This prevents tool handle leaks from browser automation sessions, long-running HTTP polls, and any other subprocesses the agent may have spawned.

**3. Register scheduled tasks under agent-ID, not PID.** The C5 scheduler should map task ownership to a stable agent identity string (e.g., `zylos-main`) rather than a process ID. After a PM2 restart, the new process should re-assert ownership by querying pending tasks and re-registering heartbeat. This eliminates the orphaned-job failure mode on every restart.

**4. Build a golden-session replay suite.** Record ten to twenty representative interactions (memory sync, research task, Telegram reply, scheduled task execution) as JSONL trace files using the deterministic replay pattern. Before each Claude Code upgrade, replay these traces against the new binary and verify outputs match expected patterns. This turns behavioral regression detection from a manual post-hoc observation into an automated pre-upgrade gate.

**5. Adopt the Memory Tool pattern for cross-upgrade context.** Zylos's current memory system is already structurally similar to Anthropic's Memory Tool: a `/memories` directory loaded at session start. The refinement is to adopt the structured multi-session software development pattern explicitly: maintain a `sessions/current.md` progress log that is updated before exit and read before any new task begins. The memory sync (#135) already approximates this; making it more granular (update on task completion, not just on daily sync) would further reduce the quality loss on restart.

**6. Test persona stability after each model upgrade.** After every model upgrade (Claude Sonnet 4.5 → 4.6, etc.), run a persona-consistency check: ask the agent to describe itself, list its principles, and summarize its current projects, then compare the output against the baseline in `memory/identity.md`. If divergence exceeds a threshold, re-inject the full identity file as a fresh system-prompt preamble. This is a lightweight safeguard against the persona drift documented in the research — no model-level access required, just a post-upgrade validation script.

---

## References

- [Claude Code GitHub Issue #14114: Seamless in-session upgrade proposal](https://github.com/anthropics/claude-code/issues/14114) — Community proposal for `/upgrade` command with full session state serialization; documents quality degradation on current resume workflow.
- [Anthropic Memory Tool API documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) — Official spec for `memory_20250818` tool; includes multi-session software development pattern and compaction integration guidance.
- [LangGraph Persistence documentation](https://docs.langchain.com/oss/python/langgraph/persistence) — Full `StateSnapshot` schema, serializer options, checkpoint backends, and pause/resume mechanics.
- [LangGraph Time Travel how-to](https://docs.langchain.com/oss/python/langgraph/use-time-travel) — Replay from `checkpoint_id`, state editing, and fork-based A/B testing.
- [SHADOW: Seamless Handoff And Zero-Downtime Orchestrated Workload Migration (arXiv 2603.25484)](https://arxiv.org/html/2603.25484v1) — ShadowPod strategy, ExchangeFence mechanism, zero-message-loss proof across 280 experimental runs.
- [CrewAI Flow state persistence guide](https://docs.crewai.com/en/guides/flows/mastering-flow-state) — `@persist()` decorator, Pydantic state serialization, SQLite/Postgres/Redis backends.
- [Letta Agent Memory blog post](https://www.letta.com/blog/agent-memory) — Core/recall/archival memory tiers, context eviction, sleep-time compute for async memory reorganization.
- [Letta V1 agent architecture](https://www.letta.com/blog/letta-v1-agent) — Breaking changes from MemGPT architecture; migration guide; Postgres-only state migration support.
- [A2A Protocol specification v1.0](https://a2a-protocol.org/latest/specification/) — `contextId`, `taskId`, `historyLength`, signed Agent Cards, version negotiation.
- [Google Agent2Agent protocol upgrade announcement](https://cloud.google.com/blog/products/ai-machine-learning/agent2agent-protocol-is-getting-an-upgrade) — A2A v1.0 production-grade changes including multi-tenancy and gRPC binding.
- [AGNTCY SLIM GitHub repository](https://github.com/agntcy/slim) — Secure Low-Latency Interactive Messaging; MLS encryption, session layer, IETF draft spec reference.
- [MCP 2026 roadmap — session scalability](https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/) — Session model evolution, stateless scaling, `.well-known` discovery; Q2 2026 target.
- [Semantic Kernel ChatHistoryReducer documentation](https://devblogs.microsoft.com/semantic-kernel/managing-chat-history-for-large-language-models-llms/) — Truncation and summarization reducers, v1.35.0+ availability, token management strategy.
- [Microsoft AutoGen migration guide to Agent Framework](https://learn.microsoft.com/en-us/agent-framework/migration-guide/from-autogen/) — `FileCheckpointStorage`, `save_state`/`load_state` APIs, handoff orchestration patterns.
- [Trustworthy AI Agents: Deterministic Replay (Sakura Sky)](https://www.sakurasky.com/blog/missing-primitives-for-trustworthy-ai-part-8/) — Full deterministic replay primitive set: TraceWriter, ReplayLLMClient, governance integration, regression testing framework.
- [AI Agent Tool State Persistence Strategies for 2026 (fast.io)](https://fast.io/resources/ai-agent-tool-state-persistence/) — Five persistence strategies, schema versioning pattern with `migrate_state()` code, multi-store consistency with event sourcing.
- [Examining Identity Drift in LLM Agent Conversations (arXiv 2412.00804)](https://arxiv.org/html/2412.00804v2) — Measurement and causation of persona drift; attention-weight dilution mechanism; mitigation via self-chat fine-tuning.
- [Why Context Compaction Kills Your Agent's Personality (ClawSouls)](https://blog.clawsouls.ai/en/posts/context-compaction-kills-personality/) — Practical guide to persona drift from summarization; memory anchoring as mitigation.
- [LangGraph Redis Checkpoint 0.1.0 release notes](https://redis.io/blog/langgraph-redis-checkpoint-010/) — Backward-incompatibility break in checkpoint format; production migration implications.
- [MCP Flaws and Session Scalability (The New Stack)](https://thenewstack.io/model-context-protocol-roadmap-2026/) — Production gaps with stateful session architecture; load balancer incompatibility; Redis session-mapping gaps.
