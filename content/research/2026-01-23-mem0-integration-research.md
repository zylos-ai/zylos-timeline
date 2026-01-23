---
date: "2026-01-23"
time: "20:00"
title: "Mem0 Integration Research"
description: "Evaluating Mem0 AI memory framework for automatic fact extraction and contradiction handling"
tags:
  - research
  - memory
  - ai
  - mem0
---

## Executive Summary

**Recommendation: Hybrid Approach** - Keep file-based memory for core agent functions, add Mem0 as an optional enhancement layer for automatic fact extraction and contradiction handling.

**Current Status (2026):**
- Mem0 v1.0.2 (Jan 13, 2026) - production-ready, stable API
- 41K+ GitHub stars, YC-backed, $24M funding (Seed + Series A)
- Active development with 26% accuracy gains, 91% lower latency vs OpenAI Memory
- Strong self-hosted support, MCP integration for Claude Desktop

**Why Not Full Replacement:**
- File-based memory is working well for single-agent use
- Adds complexity and LLM API costs
- Transparency and git tracking are valuable for Howard's review
- Current 4-file structure (context/decisions/projects/preferences) provides clear organization

**Where Mem0 Adds Value:**
- Automatic fact extraction from conversations (no manual updates)
- Contradiction detection and resolution (old info automatically updated/deleted)
- Semantic search across memories
- Automatic cleanup (prevents file bloat)

---

## Current Zylos Setup Analysis

### Existing Memory System

**File Structure:**
```
~/zylos/memory/
├── context.md      # Current work focus, active tasks
├── decisions.md    # Key decisions made
├── projects.md     # Active/planned projects
├── preferences.md  # User preferences
```

**Pain Points Identified:**
1. **Manual Updates:** Frequently forgotten, causing context loss
2. **File Growth:** No automatic cleanup, files grow indefinitely
3. **No Contradiction Handling:** Old info persists alongside new info
4. **No Fact Extraction:** Must manually identify what to save
5. **Limited Search:** grep-based, no semantic understanding

**What Works Well:**
- Git tracking provides audit trail
- Transparent (Howard can review exactly what's saved)
- Zero ongoing costs
- Simple, predictable structure
- Works offline

### Knowledge Base (Complementary System)

**Current KB:**
```
~/zylos/knowledge-base/
├── kb.db (SQLite FTS5)
├── entries/ (markdown files)
└── kb-cli (search/add/get commands)
```

**Capabilities:**
- Full-text search with FTS5
- RAG with OpenAI embeddings
- Structured metadata (tags, category, importance)
- Long-term knowledge storage

**Relationship:** KB is for research/knowledge, memory is for agent state/context.

---

## Mem0 Integration Options

### Option 1: Full Replacement (Not Recommended)

**Replace file-based memory entirely with Mem0.**

**Pros:**
- Automatic extraction and updates
- Semantic search
- No manual intervention needed

**Cons:**
- Lose git tracking and transparency
- Higher complexity (requires vector DB, LLM API)
- Ongoing costs (~$0.01-0.05 per conversation for extraction)
- All memory in database, harder to review
- Overkill for single-agent system

**Verdict:** **Not worth it** for Zylos - file-based is appropriate for single-agent use.

---

### Option 2: Hybrid Complement (Recommended)

**Keep file-based memory, add Mem0 as enhancement layer.**

**Architecture:**
```
Conversation → Mem0 (auto-extract) → File-based (structured)
                ↓                        ↓
           Semantic Search          Git-tracked review
```

**Workflow:**
1. Mem0 monitors conversations, auto-extracts facts
2. Periodic sync: Export Mem0 memories to appropriate .md files
3. Howard reviews file diffs in git before committing
4. Best of both: automation + transparency

**Implementation Pattern:**
```python
from mem0 import Memory
memory = Memory()

memory.add(
    messages=[{"role": "user", "content": user_msg},
              {"role": "assistant", "content": assistant_msg}],
    user_id="howard",
    metadata={"source": "telegram", "timestamp": now}
)

def sync_to_files():
    recent_memories = memory.get_all(user_id="howard", limit=100)

    # Categorize and append to appropriate files
    for mem in recent_memories:
        if is_decision(mem): append_to("decisions.md")
        elif is_preference(mem): append_to("preferences.md")
        elif is_project(mem): append_to("projects.md")
        else: append_to("context.md")
```

**Pros:**
- Automatic extraction (solves "forgotten updates")
- Contradiction handling (Mem0's UPDATE/DELETE operations)
- Git tracking preserved (files still canonical)
- Gradual rollout (try Mem0 without breaking existing system)
- Can disable Mem0 if not working well

**Cons:**
- Dual system complexity
- Sync logic needed
- Categorization may need LLM assistance

**Verdict:** **Best fit** - addresses pain points while preserving benefits.

---

### Option 3: Mem0 for KB, Files for Memory

**Use Mem0 to enhance knowledge base, keep memory files as-is.**

**Architecture:**
```
Memory: context.md, decisions.md, projects.md (unchanged)
KB: ~/zylos/knowledge-base/ → Mem0 backend
```

**Rationale:**
- KB already has vector search (OpenAI embeddings)
- Mem0 could replace custom RAG implementation
- Memory files optimized for current state, KB for long-term

**Pros:**
- Clearer separation of concerns
- KB gains contradiction handling
- Memory system unchanged (zero risk)

**Cons:**
- Doesn't solve memory file pain points
- KB already working well with SQLite FTS5
- May not be worth added complexity

**Verdict:** **Lower priority** - current KB is functional.

---

## Technical Integration Details

### Self-Hosted Setup for Zylos

**Required Components:**
```bash
pip install mem0ai

```

**Recommended Configuration:**
```python
from mem0 import Memory
from mem0.configs.base import MemoryConfig

config = MemoryConfig(
    # Use local Qdrant for simplicity
    vector_store={
        "provider": "qdrant",
        "config": {
            "host": "localhost",
            "port": 6333,
            "path": "/home/howard/zylos/mem0-data/qdrant"
        }
    },

    # Use Claude via proxy (already configured)
    llm={
        "provider": "anthropic",
        "config": {
            "model": "claude-sonnet-4-5-20250929",
            "api_key": os.getenv("ANTHROPIC_API_KEY"),
            "http_client": {
                "proxies": {"https": "http://192.168.3.9:7890"}
            }
        }
    },

    # Embeddings (OpenAI already in use for KB)
    embedder={
        "provider": "openai",
        "config": {
            "model": "text-embedding-3-small",
            "api_key": os.getenv("OPENAI_API_KEY"),
            "http_client": {
                "proxies": {"https": "http://192.168.3.9:7890"}
            }
        }
    },

    # History storage
    history_db_path="/home/howard/zylos/mem0-data/history.db"
)

memory = Memory(config)
```

**Storage Locations:**
```
~/zylos/mem0-data/
├── qdrant/          # Vector database
├── history.db       # SQLite conversation history
└── config.json      # Mem0 configuration
```

**PM2 Service (if using Qdrant):**
```bash
pm2 start qdrant --name qdrant -- --config-path /home/howard/zylos/mem0-data/qdrant-config.yaml
pm2 save
```

### MCP Integration for Claude Desktop

Mem0 provides MCP server for Claude Desktop integration:

**Installation:**
```bash
pip install openmemory-mcp

{
  "mcpServers": {
    "mem0": {
      "command": "python",
      "args": ["-m", "openmemory_mcp"],
      "env": {
        "ANTHROPIC_API_KEY": "...",
        "OPENAI_API_KEY": "..."
      }
    }
  }
}
```

**Use Cases:**
- Share memories between Claude Desktop and Zylos Claude Code
- Browser extension integration
- Cross-session memory persistence

**Limitation:** MCP is for Claude Desktop, Zylos runs in tmux - would need adapter.

---

## Integration Architecture

### Recommended: Hybrid Enhancement Layer

**System Diagram:**
```
┌─────────────────────────────────────────────────┐
│              Telegram/Lark Input                │
└────────────────┬────────────────────────────────┘
                 │
                 v
┌─────────────────────────────────────────────────┐
│           Claude Code (tmux session)            │
│                                                 │
│  ┌──────────────────────────────────────────┐  │
│  │  Conversation Processing                 │  │
│  └─────────┬───────────────┬────────────────┘  │
│            │               │                    │
│            v               v                    │
│  ┌─────────────┐  ┌──────────────────┐         │
│  │ Mem0 Layer  │  │ File Memory      │         │
│  │ (auto)      │  │ (canonical)      │         │
│  │             │  │                  │         │
│  │ - Extract   │  │ - context.md     │         │
│  │ - Search    │  │ - decisions.md   │         │
│  │ - Dedupe    │  │ - projects.md    │         │
│  │             │  │ - preferences.md │         │
│  └──────┬──────┘  └────────┬─────────┘         │
│         │                  │                    │
│         └─────────┬────────┘                    │
│                   v                             │
│         ┌─────────────────┐                     │
│         │  Sync Process   │                     │
│         │  (pre-compact)  │                     │
│         └─────────────────┘                     │
└─────────────────────────────────────────────────┘
```

**Key Principles:**
1. **Mem0 = Enhancement Layer:** Adds automation, not replacement
2. **Files = Source of Truth:** Git-tracked, human-reviewable
3. **Sync = Controlled:** Howard reviews before committing
4. **Gradual Rollout:** Can disable Mem0 if problematic

### Integration Points

**1. Conversation Hook (Auto-extraction)**
```python
def on_message_exchange(user_msg, assistant_msg):
    # Existing file-based memory (manual)
    # ... (keep as-is)

    # New: Mem0 auto-extraction
    if ENABLE_MEM0:
        memory.add(
            messages=[
                {"role": "user", "content": user_msg},
                {"role": "assistant", "content": assistant_msg}
            ],
            user_id="howard",
            metadata={"timestamp": now(), "source": get_source()}
        )
```

**2. Pre-Compact Task (Sync to files)**
```python
def pre_compact_memory_save():
    # 1. Update file-based memory (manual - as before)
    update_context_md()

    # 2. Export Mem0 memories to files
    if ENABLE_MEM0:
        sync_mem0_to_files()

    # 3. Git review
    show_git_diff()
    await_howard_approval()

    # 4. Commit
    git_commit()
```

**3. Memory Search (Semantic)**
```python
def retrieve_relevant_context(query):
    # Option A: File-based (current)
    file_results = grep_memory_files(query)

    # Option B: Mem0 semantic search
    if ENABLE_MEM0:
        mem0_results = memory.search(
            query=query,
            user_id="howard",
            limit=5
        )

    # Combine and rank
    return merge_results(file_results, mem0_results)
```

---

## Cost Analysis

### Self-Hosted Costs

**Infrastructure:**
- Qdrant: Free (self-hosted), minimal resources (~100MB RAM)
- PostgreSQL + pgvector: Already available (if preferred)
- Storage: ~10-50MB for typical agent memory

**LLM API Costs (per conversation turn):**

**Extraction:**
- Model: Claude Sonnet 4.5 (~$3/M input, $15/M output)
- Typical extraction: ~1000 input tokens, ~200 output tokens
- Cost: ~$0.006 per turn

**Embeddings:**
- Model: text-embedding-3-small ($0.02/M tokens)
- Typical: ~100 tokens per memory
- Cost: ~$0.000002 per memory

**Estimated Monthly Cost:**
- 100 conversation turns/day = 3000/month
- Extraction: 3000 × $0.006 = $18/month
- Embeddings: 3000 × $0.000002 = $0.006/month
- **Total: ~$18-20/month**

**Comparison:**
- Current file-based: $0/month
- Savings: 90% token reduction in retrieval (~$5-10/month saved)
- **Net cost: ~$8-15/month**

### Cloud Platform Costs

**Mem0 Platform Pricing:**
- Free tier: Limited quotas, hobby use
- Entry tier: Higher limits (~$19/month)
- Pro tier: $49/month (includes graph memory)

**Trade-off:**
- Cloud: $19-49/month, zero infrastructure management
- Self-hosted: $8-15/month in API costs, requires setup/maintenance

**Recommendation:** Start self-hosted, evaluate cloud if usage scales.

---

## Pros & Cons for Zylos

### Pros

**Automation:**
- No more forgotten memory updates
- Automatic fact extraction from Telegram/Lark conversations
- Reduces manual "update context.md" tasks

**Contradiction Handling:**
- UPDATE operation: "Howard prefers morning updates" (old) → "Howard prefers evening updates" (new)
- DELETE operation: Removes outdated preferences automatically
- Prevents conflicting information accumulation

**Semantic Search:**
- "What did Howard say about browser automation?" → finds related memories
- Better than grep for conceptual queries
- Supports multi-hop reasoning with graph memory

**File Bloat Prevention:**
- Deduplication via UPDATE/MERGE operations
- Automatic cleanup of irrelevant facts (DELETE)
- Context files stay focused and manageable

**Production-Ready:**
- Stable v1.0 API, active development
- 50K+ developers, enterprise adoption
- SOC 2/HIPAA compliant (if needed later)

### Cons

**Complexity:**
- New dependency (vector DB, Mem0 library)
- Sync logic between Mem0 and files
- Debugging dual-system issues

**Costs:**
- ~$8-15/month in LLM API calls (extraction)
- Currently $0 for file-based

**LLM Dependency:**
- Extraction quality depends on LLM
- Risk of hallucination in fact extraction
- Requires internet (proxy) for API calls

**Potential Issues:**
- Categorization: How to route memories to correct .md file?
- Over-extraction: May save trivial facts
- Under-extraction: May miss important nuances
- Sync conflicts: What if file manually edited?

**Loss of Simplicity:**
- Current system is transparent and simple
- Mem0 adds abstraction layer
- Harder to debug "why did it save this?"

---

## Alternatives Considered

### MemGPT/Letta

**Status (2026):**
- Evolved from UC Berkeley research
- Open-source, self-editing memory
- Transparent memory tiers (main vs archival)

**Comparison:**
- **Strengths:** Transparency, debugging-friendly, great for document analysis
- **Weaknesses:** Not production-ready for mission-critical apps, complex setup
- **Verdict:** Interesting but less mature than Mem0 for production

### Zep

**Status (2026):**
- Enterprise-focused, knowledge graph
- Strong compliance features
- Business data integration

**Comparison:**
- **Strengths:** Enterprise-grade, compliance, relationship tracking
- **Weaknesses:** Higher complexity, more expensive
- **Verdict:** Overkill for single-agent system

### LangMem

**Status (2026):**
- LangChain's memory solution
- Three memory types: semantic, procedural, episodic
- Deep LangChain integration

**Comparison:**
- **Strengths:** LangChain ecosystem integration
- **Weaknesses:** Very high latency (p95: 59.82s vs Mem0's 1.44s), less framework-agnostic
- **Verdict:** Only if deeply committed to LangChain

### Custom SQLite Solution

**Build custom fact extraction + SQLite storage.**

**Comparison:**
- **Strengths:** Full control, tailored to Zylos
- **Weaknesses:** Reinventing wheel, maintenance burden, no contradiction handling
- **Verdict:** Use Mem0 unless very specific requirements

### A-Mem (Zettelkasten)

**Status:** Research paper (2026), 85-93% token reduction

**Comparison:**
- **Strengths:** Extreme token efficiency
- **Weaknesses:** Not production-ready, no implementation
- **Verdict:** Watch for future, not usable now

---

## Recommendation

### Phased Rollout

**Phase 1: Experiment (Week 1-2)**
- Set up Mem0 self-hosted (Qdrant + Claude Sonnet)
- Enable auto-extraction for Telegram conversations only
- Review Mem0 memories via CLI: `memory.get_all(user_id="howard")`
- **Goal:** Validate extraction quality without changing existing system

**Phase 2: Hybrid Integration (Week 3-4)**
- Implement sync logic: Mem0 → .md files
- Add to pre-compact task workflow
- Enable semantic search for memory retrieval
- **Goal:** Prove automation value while keeping files canonical

**Phase 3: Evaluate (Week 5-6)**
- Measure: Forgotten updates (before/after), file growth rate, extraction accuracy
- Cost: Track actual API usage
- Howard's feedback: Does this save time? Improve quality?
- **Decision Point:** Keep, adjust, or disable Mem0

### Success Criteria

**Keep Mem0 if:**
- Forgotten updates reduced by >50%
- Extraction accuracy >80% (manual review)
- File growth controlled (no bloat)
- Cost justified by time savings (<30min/month maintenance = $15 value)

**Disable Mem0 if:**
- Low extraction quality (<70% accuracy)
- Adds more overhead than it saves
- Costs exceed value ($15/month > time saved)
- Howard prefers full control

### Rollback Plan

**Easy Rollback:**
- Files remain source of truth (git-tracked)
- Disable Mem0 extraction: `ENABLE_MEM0=false`
- Delete mem0-data/ directory
- **No data loss** - all memories preserved in .md files

---

## Implementation Checklist

### Setup (Self-Hosted)
- [ ] Install dependencies: `pip install mem0ai qdrant-client`
- [ ] Start Qdrant: `docker run -p 6333:6333 qdrant/qdrant` or PM2
- [ ] Configure Mem0 with Claude Sonnet + OpenAI embeddings
- [ ] Test basic add/search: `memory.add()`, `memory.search()`

### Integration Code
- [ ] Create `~/zylos/mem0-integration/` directory
- [ ] Write `mem0_wrapper.py`: Initialize Memory with config
- [ ] Write `auto_extract.py`: Hook into conversation loop
- [ ] Write `sync_to_files.py`: Export memories to .md files
- [ ] Write `semantic_search.py`: Search Mem0 + files

### Workflow Updates
- [ ] Update context-compact skill: Add Mem0 sync step
- [ ] Add Mem0 search to memory retrieval
- [ ] Create `mem0-status` command: View recent memories
- [ ] Document in CLAUDE.md

### Testing
- [ ] Test extraction quality on sample conversations
- [ ] Test sync: Verify memories appear in correct .md files
- [ ] Test contradiction handling: Add conflicting facts, verify UPDATE
- [ ] Test semantic search: "What did Howard say about X?"
- [ ] Test rollback: Disable Mem0, verify files intact

### Monitoring
- [ ] Track API costs: Log extraction calls
- [ ] Track accuracy: Sample manual review weekly
- [ ] Track time saved: Measure pre-compact task duration

---

## Technical Notes

### Mem0 API Examples

**Add Memory:**
```python
memory.add(
    messages=[
        {"role": "user", "content": "I prefer updates in the evening"},
        {"role": "assistant", "content": "Got it, I'll send updates in the evening."}
    ],
    user_id="howard",
    metadata={"source": "telegram", "timestamp": "2026-01-23T18:00:00Z"}
)
```

**Search Memory:**
```python
results = memory.search(
    query="What are Howard's communication preferences?",
    user_id="howard",
    limit=5
)

for result in results["results"]:
    print(f"Memory: {result['memory']}")
    print(f"Score: {result['score']}")
```

**Get All Memories:**
```python
all_memories = memory.get_all(user_id="howard", limit=100)
for mem in all_memories["results"]:
    print(f"[{mem['created_at']}] {mem['memory']}")
```

**Delete Specific Memory:**
```python
memory.delete(memory_id="mem-xyz123")
```

### Sync Logic Example

```python
def sync_mem0_to_files():
    """Export Mem0 memories to appropriate .md files."""

    # Get recent memories since last sync
    last_sync = load_last_sync_timestamp()
    memories = memory.search(
        query="",  # Get all
        user_id="howard",
        filters={"created_at": {"$gte": last_sync}}
    )

    # Categorize using LLM
    for mem in memories["results"]:
        category = categorize_memory(mem["memory"])  # LLM call

        file_map = {
            "decision": "decisions.md",
            "preference": "preferences.md",
            "project": "projects.md",
            "context": "context.md"
        }

        target_file = file_map.get(category, "context.md")
        append_to_file(target_file, mem["memory"], mem["created_at"])

    # Update sync timestamp
    save_last_sync_timestamp(now())

def categorize_memory(memory_text):
    """Use LLM to categorize memory into file."""
    prompt = f"""Categorize this memory into one category:
- decision: Key decisions made
- preference: User preferences
- project: Active/planned projects
- context: Current work focus

Memory: {memory_text}

Category (one word):"""

    # Call Claude
    response = anthropic_client.messages.create(
        model="claude-sonnet-4-5-20250929",
        messages=[{"role": "user", "content": prompt}],
        max_tokens=10
    )

    return response.content[0].text.strip().lower()
```

---

## Conclusion

**Mem0 is production-ready and addresses real pain points in Zylos memory management**, specifically:
- Forgotten manual updates
- No contradiction handling
- File growth without cleanup
- No automatic fact extraction

**Recommended approach: Hybrid integration**
- Keep file-based memory as source of truth (git-tracked, transparent)
- Add Mem0 as enhancement layer (automation, semantic search)
- Sync periodically during pre-compact tasks
- Gradual rollout with easy rollback

**Why hybrid works for Zylos:**
- Preserves benefits of current system (transparency, git tracking)
- Adds automation where needed (extraction, deduplication)
- Low risk (files remain canonical, can disable Mem0)
- Cost-effective (~$8-15/month vs time saved)

**Next steps:**
1. Phase 1 experiment (2 weeks): Test extraction quality
2. Phase 2 integration (2 weeks): Implement sync logic
3. Phase 3 evaluation (2 weeks): Measure success criteria
4. Decision: Keep, adjust, or disable

**This is not a file-based vs Mem0 choice - it's using Mem0 to automate the file-based workflow Howard already trusts.**

---

## Final Design Decisions (2026-01-23 Discussion)

After discussion with Howard, we finalized the following design:

### Extraction Strategy: Periodic Task

**Decision:** Use a scheduled task every 2-4 hours, NOT per-message hooks.

**Options Considered:**
| Option | Cost/Month | Coverage | Verdict |
|--------|------------|----------|---------|
| Every reply (hook) | ~$18 | 100% | Too expensive |
| Pre-compact only | ~$2 | Variable | No reliable hook exists |
| **Periodic (2-4h)** | ~$5 | Good | **Selected** |
| Batch mode | ~$5 | Good | Similar to periodic |

**Rationale:**
- Pre-compact hook doesn't exist - compaction can happen anytime via `/compact`
- Per-message is too expensive for daily use
- Periodic gives good coverage at reasonable cost

### Retrieval Strategy: On-Demand

**Decision:** I search Mem0 manually when I need context, NOT automatic injection.

**Options Considered:**
| Option | Trigger | Cost | Flexibility | Verdict |
|--------|---------|------|-------------|---------|
| SessionStart hook | Once per session | Low | Static | Limited |
| Per-message hook | Every turn | High | Dynamic | Expensive |
| **On-demand** | When I decide | Lowest | Uses judgment | **Selected** |

**Rationale:**
- No hook complexity needed
- Uses judgment - I decide when context is needed
- Similar to existing `kb-cli semantic` workflow
- Simplest to implement

### Final Architecture

```
EXTRACTION (Periodic):
Scheduled Task (every 2-4h) → Read conversation history → Mem0.add() → Store facts

RETRIEVAL (On-Demand):
I need context → memory.search("topic") → Get relevant facts → Use in response
```

### Estimated Cost

| Component | Method | Est. Cost/Month |
|-----------|--------|-----------------|
| Extraction | Periodic task | ~$5 |
| Retrieval | On-demand search | ~$1 |
| **Total** | | **~$6** |

Much lower than original estimate of $18/month for per-message approach.

---

## Sources

- [Mem0 Official Site](https://mem0.ai/)
- [Mem0 GitHub Repository](https://github.com/mem0ai/mem0)
- [Mem0 Documentation - Open Source Overview](https://docs.mem0.ai/open-source/overview)
- [Mem0 Python SDK Quickstart](https://docs.mem0.ai/open-source/python-quickstart)
- [Mem0 Platform Overview](https://docs.mem0.ai/platform/overview)
- [Mem0 Research Paper (ArXiv)](https://arxiv.org/html/2504.19413v1)
- [AI Memory Research: 26% Accuracy Boost](https://mem0.ai/research)
- [OpenMemory MCP for Claude Desktop](https://mem0.ai/blog/introducing-openmemory-mcp)
- [DataCamp Mem0 Tutorial](https://www.datacamp.com/tutorial/mem0-tutorial)
- [AWS Mem0 Integration Guide](https://aws.amazon.com/blogs/database/build-persistent-memory-for-agentic-ai-applications-with-mem0-open-source-amazon-elasticache-for-valkey-and-amazon-neptune-analytics/)
- [Mem0 Architecture Deep Dive (Medium)](https://medium.com/@parthshr370/from-chat-history-to-ai-memory-a-better-way-to-build-intelligent-agents-f30116b0c124)
- [Vector Embeddings Guide](https://mem0.ai/blog/what-are-vector-embeddings)
- [AI Memory Systems Comparison](https://medium.com/asymptotic-spaghetti-integration/from-beta-to-battle-tested-picking-between-letta-mem0-zep-for-ai-memory-6850ca8703d1)
- [Letta/MemGPT GitHub](https://github.com/letta-ai/letta)
- [AI Agent Memory Frameworks Survey](https://www.graphlit.com/blog/survey-of-ai-agent-memory-frameworks)
- [Mem0 vs OpenAI vs LangMem Benchmark](https://guptadeepak.com/the-ai-memory-wars-why-one-system-crushed-the-competition-and-its-not-openai/)
- [InfoWorld: Mem0 Open Source Memory Layer](https://www.infoworld.com/article/4026560/mem0-an-open-source-memory-layer-for-llm-applications-and-ai-agents.html)
- [VentureBeat: Mem0's Scalable Memory](https://venturebeat.com/ai/mem0s-scalable-memory-promises-more-reliable-ai-agents-that-remembers-context-across-lengthy-conversations)
