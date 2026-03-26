---
date: "2026-03-26"
title: "OpenAI Codex CLI Architecture and Multi-Runtime Agent Patterns"
description: "Deep dive into OpenAI Codex CLI's Rust-based architecture, sandbox model, tool system, and persistent memory — with a systematic comparison to Claude Code and patterns for building multi-runtime agent platforms."
tags: ["codex-cli", "claude-code", "ai-agent-runtime", "multi-runtime", "sandbox", "architecture"]
---

## Executive Summary

OpenAI's Codex CLI has evolved from a TypeScript prototype into a full Rust-based agent runtime with 67,000+ GitHub stars and an extremely active development cadence (10-15 commits/day as of March 2026). This article examines its architecture in detail — the bubblewrap sandbox, rule-based exec policy, two-phase persistent memory pipeline, and JSON-RPC app-server interface — and systematically compares it with Claude Code. For platforms like Zylos that support multiple LLM runtimes, we identify the key abstraction boundaries: tool invocation translation, permission model bridging, session lifecycle mapping, and the MCP compatibility surface that serves as the primary extension portability layer.

## Repository Overview

The `openai/codex` repository was created in April 2025 and has since undergone a complete rewrite from TypeScript to Rust. The legacy TypeScript codebase remains in `codex-cli/` as a Node.js wrapper that bundles the Rust binary, but the active development lives entirely in `codex-rs/`.

As of March 26, 2026:
- **67,782 stars**, 9,082 forks, 2,241 open issues
- Current version: `0.117.0-alpha.24` (alpha), `0.116.0` (stable)
- License: Apache-2.0
- Primary language: Rust
- Top contributors are OpenAI employees with 300-700+ commits each

The Rust rewrite is significant. It signals a commitment to performance, memory safety, and cross-platform sandbox integration that would be difficult to achieve in a scripting language. The binary ships as a single executable with embedded assets (Node.js kernel for REPL, Lark grammar for patch parsing).

## Core Architecture

### Session Model

Codex CLI's session model is built around three primitives:

- **Thread**: A persistent conversation backed by SQLite. Threads survive process restarts and can be resumed, forked, archived, or rolled back. This is a fundamental architectural difference from Claude Code, which has no built-in cross-session persistence.
- **Turn**: One round-trip cycle — user input triggers model inference, which produces tool calls, which produce results, which feed back into the model.
- **Item**: Granular events within a turn (agent messages, shell output, file edits, reasoning traces).

The central orchestration lives in `codex-rs/core/src/codex.rs`, with tool dispatch handled by a `ToolOrchestrator` that implements: approval check, sandbox selection, execution attempt, and retry-with-escalation-on-denial.

### Tool System

Tools are registered in a `ToolRegistry` and dispatched via `ToolRouter`. There are two kinds:

**First-party tools** (built-in):
- `shell` / `shell_command` — sandboxed shell execution with classic and `zsh_fork` backends
- `apply_patch` — structured file editing using a Lark grammar parser, supporting both freeform (text diff) and JSON (structured schema) modes
- `js_repl` — persistent Node.js kernel with a bundled `meriyah` parser for JavaScript REPL
- `list_dir` — paginated directory listing
- `view_image` — multimodal image loading with full-resolution support
- `tool_search` — BM25-powered semantic search over available tools (useful when MCP servers expose hundreds of tools)
- `spawn_agent` / `wait_agent` / `send_input` / `close_agent` — hierarchical multi-agent spawning
- `request_permissions` — mid-turn sandbox permission escalation
- `web_search` — live web search (model-gated, experimental)

**MCP tools**: Routed through an `McpHandler` that connects to external MCP servers via stdio or Streamable HTTP transport.

The `apply_patch` tool deserves attention. Rather than using simple string replacement (like Claude Code's `Edit` tool), it parses patches through a formal Lark grammar. This enables structured validation of edits before application, reducing the risk of malformed patches corrupting files.

### Model Routing

Codex CLI exclusively uses the **Responses API** (`/v1/responses`). The older Chat Completions wire format (`wire_api = "chat"`) has been removed and produces a hard error. Built-in providers include:

| Provider | Endpoint | Notes |
|----------|----------|-------|
| openai | api.openai.com | Default, with ChatGPT plan sign-in |
| ollama | localhost:11434 | Local model serving |
| lmstudio | localhost:1234 | Local model serving |

Custom providers are defined in `config.toml` with arbitrary `base_url`, environment variable for API key (`env_key`), custom HTTP headers, query parameters, bearer tokens, retry configuration, and stream timeouts. This is the extensibility surface that enables platforms to route Codex through proxies or to self-hosted models.

The default model is `gpt-5.3-codex` (272k context), with `gpt-5.1-codex-mini` used for background tasks like memory extraction.

## Sandbox and Security

The sandbox architecture is Codex CLI's most distinctive feature — significantly more sophisticated than Claude Code's approach.

### Linux: Bubblewrap

Since v0.115.0, the default Linux sandbox uses **bubblewrap** (`bwrap`):

- `--unshare-user` — private user namespace
- `--unshare-pid` — private PID namespace
- `--unshare-net` — private network namespace (completely isolates network when disabled)
- `--ro-bind / /` — entire filesystem mounted read-only by default
- Writable paths explicitly bound via `--bind <root> <root>`
- Protected subdirectories (`.git`, `.codex`) re-applied as `--ro-bind` even under writable roots
- `PR_SET_NO_NEW_PRIVS` and seccomp network filter applied in-process
- Fresh `/proc` mounted via `--proc /proc`

A managed proxy mode enables controlled network access: `--unshare-net` combined with an internal TCP-to-UDS-to-TCP bridge. After the bridge is live, seccomp blocks new `AF_UNIX` and `socketpair` syscalls for user commands, preventing sandbox escape through Unix socket creation.

### macOS: Seatbelt

Uses Apple's Sandbox framework (`/usr/bin/sandbox-exec`) with layered policy files for base restrictions, network rules, and read-only platform defaults.

### Windows: Desktop Isolation

Windows uses restricted tokens with optional elevation, running sandboxed processes on a private desktop (`Winsta0\Default` isolation) rather than namespace-based containment.

### Exec Policy: Rule-Based Command Approval

The `execpolicy` crate implements a DSL-based rule engine. Rules live in `~/.codex/rules/*.rules` and workspace `.codex/rules/*.rules`. Commands are matched against rules to determine whether they require approval.

Notably, several command categories are **hardcoded as banned** regardless of rules:
- Shell interpreters: `python`, `ruby`, `perl`, `lua`, `php`, `node -e`
- Shell wrappers: `bash -c`, `sh -c`, `zsh -lc`, `env`, `sudo`
- Bare `git` (without subcommand)

The rationale is that these are vectors for arbitrary code execution that bypass per-command review. This is a more paranoid stance than Claude Code, which allows shell commands through its `Bash` tool with user approval.

### Sandbox Modes

Four escalating levels:
1. `workspace-write` — CWD writable, rest read-only (default)
2. `read-only` — nothing writable
3. `full-disk-write-access` — unrestricted filesystem
4. `danger-full-access` — no sandbox at all

## Persistent Memory

Codex CLI implements a two-phase AI-driven memory pipeline:

**Phase 1 — Extraction** (runs at startup): Scans previous conversation threads, extracts raw memories using `gpt-5.1-codex-mini` with low reasoning effort. Processes up to 5,000 threads with a concurrency limit of 8.

**Phase 2 — Consolidation**: Uses `gpt-5.3-codex` with medium reasoning under a global lock to merge and deduplicate extracted memories into a coherent summary.

Memory is stored in `memory_summary.md` and injected into model instructions at session start, capped at 5,000 tokens. The pipeline state is tracked in a SQLite database with job ownership leases (1-hour expiry) and retry delays.

This is architecturally different from Claude Code, which has no built-in persistent memory. Platforms like Zylos that need cross-session memory must implement their own memory layer (as Zylos does with its memory skill).

## App-Server: The IDE Interface

`codex app-server` exposes a JSON-RPC 2.0 interface over stdio (NDJSON) or WebSocket. This is what powers the VS Code extension and other rich clients.

The API surface is extensive:

- **Thread lifecycle**: start, resume, fork, list, archive, rollback, compact
- **Turn lifecycle**: start, steer (mid-flight input injection), interrupt
- **Filesystem RPCs**: readFile, writeFile, createDirectory, readDirectory, watch
- **MCP management**: OAuth login, server reload, status listing
- **Skills/Plugins**: list, config, install, uninstall
- **Config**: read, write, batch write
- **Realtime** (experimental): voice session start, audio append

Schema can be exported as TypeScript types or JSON Schema via `codex app-server generate-ts` / `generate-json-schema`. A Python SDK is available for programmatic control.

Claude Code's equivalent is the Claude Code SDK, which is simpler but less feature-rich — it does not expose filesystem RPCs, thread management, or plugin lifecycle through its protocol.

## Hooks System

Codex CLI implements lifecycle hooks similar to Claude Code:

| Event | Description |
|-------|-------------|
| `session_start` | Session initialization |
| `pre_tool_use` | Before tool execution (can block) |
| `post_tool_use` | After tool execution |
| `stop` | Agent turn completion |
| `user_prompt_submit` | Before prompt reaches model (can modify/block) |

The `user_prompt_submit` hook (added in v0.116.0) is notable — it enables prompt augmentation or filtering before the model sees user input, enabling use cases like automated context injection or content policy enforcement.

Hooks are configured in `hooks.json` files and feature-flagged via `Feature::CodexHooks`.

## Multi-Agent System

Codex CLI has first-class multi-agent support through dedicated tools:

- `spawn_agent` — create a sub-agent with inherited config and optional role overlay
- `send_input` — send messages to a running sub-agent
- `wait_agent` — block until sub-agent completes
- `close_agent` — terminate a sub-agent

Sub-agents inherit the parent's effective configuration (provider, approval policy, sandbox, working directory). Default constraints: maximum depth of 1 (one level of sub-agents) and maximum 6 parallel agent threads.

Built-in agent roles include `awaiter` (polls until a condition is met, uses low reasoning) and `explorer` (investigation-focused).

This is comparable to Claude Code's `Task` tool for subagent spawning, though Codex's implementation is more structured with explicit lifecycle management and role-based configuration inheritance.

## Systematic Comparison: Codex CLI vs Claude Code

| Dimension | Codex CLI | Claude Code |
|-----------|-----------|-------------|
| **Core language** | Rust | TypeScript/Node.js |
| **Model coupling** | OpenAI Responses API; extensible via custom providers | Anthropic API; provider is fixed |
| **File editing** | `apply_patch` with Lark grammar (freeform + JSON) | `Edit` (string replacement), `Write`, `MultiEdit` |
| **Shell execution** | Sandboxed shell with rule-based exec policy DSL | `Bash` tool with user approval dialogs |
| **Sandbox** | bubblewrap/Seatbelt/Windows; namespace isolation | macOS Seatbelt; simpler model |
| **Permissions** | DSL rule files (`*.rules`) + approval modes | Per-session allow lists + `--dangerously-skip-permissions` |
| **Session persistence** | SQLite-backed threads with fork/rollback | In-session only (no built-in persistence) |
| **Memory** | Two-phase AI extraction + consolidation pipeline | No built-in persistent memory |
| **Multi-agent** | `spawn_agent`/`wait_agent`/`close_agent` with depth limits | `Task` tool (background or blocking subagents) |
| **IDE interface** | JSON-RPC 2.0 app-server (stdio/WebSocket) | Claude Code SDK (stdio) |
| **Config format** | TOML (`~/.codex/config.toml`) with JSON Schema | CLAUDE.md (Markdown) + settings JSON |
| **Project instructions** | AGENTS.md | CLAUDE.md |
| **Hooks** | 5 event types including `user_prompt_submit` | 4 event types (pre/post tool, session start, stop) |
| **Extension system** | Plugins (skills + MCP + apps bundles) + Skills (TOML) | MCP servers (first-class) |
| **Context management** | Auto-compaction via summarization model + manual compact | Manual `/compact` command + auto-compact |
| **Web search** | Built-in `web_search` tool (experimental) | `WebSearch` / `WebFetch` tools |
| **Voice/realtime** | Under active development (WebSocket) | Not present |

## Multi-Runtime Abstraction Patterns

For platforms that support both Claude Code and Codex CLI as interchangeable backends, several abstraction boundaries must be addressed:

### Tool Invocation Translation

The tool names and schemas differ completely:
- Codex `shell` maps to Claude Code `Bash`
- Codex `apply_patch` maps to Claude Code `Edit`/`Write`
- Codex `list_dir` maps to Claude Code `Glob` (roughly)
- Codex `view_image` maps to Claude Code `Read` (for images)

A runtime abstraction layer needs a tool translation table that maps between the two vocabularies. The translation is not always one-to-one — `apply_patch` in freeform mode produces unified diffs, while Claude Code's `Edit` uses exact string replacement.

### Permission Model Bridging

Codex uses a static, declarative model (rule files + sandbox modes). Claude Code uses a dynamic, interactive model (per-session approval dialogs). A multi-runtime platform must either:
1. Pre-configure Codex rules to match the platform's permission policy, or
2. Implement a permission proxy that translates Codex's approval requests into the platform's authorization flow

### Session Lifecycle Mapping

Codex threads persist across sessions; Claude Code sessions are ephemeral. A platform that needs session continuity must either:
- Use Codex's native thread persistence when running on Codex
- Implement external session persistence (as Zylos does with its memory system) when running on Claude Code
- Abstract both behind a unified session interface

### MCP as the Portability Layer

MCP (Model Context Protocol) is the primary compatibility surface between the two runtimes. Both support MCP servers with stdio and HTTP transports. Skills and tools exposed via MCP work identically on both runtimes without translation.

For maximum portability, platform-specific capabilities should be exposed as MCP servers rather than native tools. This enables a single implementation to work across both runtimes without modification.

### Configuration Reconciliation

Codex uses TOML; Claude Code uses Markdown + JSON. A multi-runtime platform needs a canonical configuration format that generates runtime-specific config files. Zylos addresses this with its `zylos runtime` command, which rebuilds instruction files and config when switching runtimes.

## Recent Development Velocity

The pace of Codex CLI development in March 2026 is remarkable:

**v0.115.0 (March 16)**: Bubblewrap as default sandbox, filesystem RPCs, Python SDK, Smart Approvals guardian subagent, realtime WebSocket v2.

**v0.116.0 (March 19)**: TUI unified on top of app-server, `user_prompt_submit` hook, plugin install elicitation, device-code auth in TUI.

**v0.117.0-alpha (March 17-26, ongoing)**: Plugin marketplace flags going live, `.codex/` directory sandbox protection, `bwrap` security hardening, app-server transport refactoring.

With 10-15 commits per day from a core team of 4-5 engineers, the cadence suggests OpenAI is treating Codex CLI as a strategic product, not a side project.

## Implications for Agent Platform Design

Several architectural decisions in Codex CLI represent the direction the industry is heading:

1. **Rust for agent runtimes**: The rewrite from TypeScript to Rust prioritizes startup speed, memory efficiency, and sandbox integration. As agents become long-running services rather than interactive tools, runtime performance matters more.

2. **Formal sandbox models**: The bubblewrap integration with namespace isolation, seccomp filters, and rule-based exec policies sets a higher bar for agent security. Expect this to become table stakes.

3. **Persistent threads with rollback**: The ability to fork, archive, and rollback conversation threads treats agent sessions as first-class version-controlled artifacts. This is useful for debugging, auditing, and reproducibility.

4. **AI-driven memory consolidation**: Using a lighter model for memory extraction and a stronger model for consolidation is a cost-effective pattern. The two-phase approach with job leasing and retry is production-grade.

5. **App-server as the integration surface**: Separating the agent core from the UI via a typed JSON-RPC protocol enables multiple frontends (CLI, IDE, web) without duplicating agent logic. This is the pattern to follow for extensible agent platforms.

## Conclusion

Codex CLI has matured into a serious agent runtime with architectural depth that rivals or exceeds Claude Code in several dimensions — particularly sandboxing, session persistence, and the app-server integration surface. Claude Code retains advantages in simplicity, the quality of its underlying model, and the pragmatism of its permission model.

For multi-runtime platforms, MCP is the clear portability layer. Everything else — tool schemas, permission models, session lifecycle, configuration — requires explicit translation. The cost of supporting both runtimes is non-trivial but manageable if the abstraction boundaries are drawn correctly: canonical config generation, tool invocation mapping, and a unified session persistence layer that works regardless of which runtime provides it natively.

## Sources

- [openai/codex GitHub repository](https://github.com/openai/codex) — source code, README, release notes
- [Codex CLI app-server README](https://github.com/openai/codex/tree/main/codex-rs/app-server) — JSON-RPC API reference
- [Codex CLI linux-sandbox README](https://github.com/openai/codex/tree/main/codex-rs/linux-sandbox) — bubblewrap sandbox documentation
- [Codex CLI config.schema.json](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json) — configuration schema
- [Codex CLI releases](https://github.com/openai/codex/releases) — v0.115.0, v0.116.0 changelogs
