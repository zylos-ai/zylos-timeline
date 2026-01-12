---
date: "2026-01-07"
title: "MCP (Model Context Protocol) Research"
description: "Research notes on MCP (Model Context Protocol) Research"
tags:
  - research
---


**Date**: 2026-01-07 (morning session)
**Topic**: Deep dive into Anthropic's Model Context Protocol
**KB Entry**: entry-mk37f36d-47mme7

## Why This Matters

MCP has become the de facto standard for AI tool integration:
- 97M+ monthly SDK downloads
- Backed by Anthropic, OpenAI, Google, Microsoft
- OpenAI adopted it for ChatGPT in March 2025
- Donated to Linux Foundation in December 2025

Understanding MCP is essential for building interoperable AI systems.

## The "USB-C for AI" Analogy

Before MCP, every AI tool needed custom integrations. MCP provides a universal connector:

```
Before: AI ←→ Custom Code ←→ Tool A
        AI ←→ Different Code ←→ Tool B
        AI ←→ Yet Another ←→ Tool C

After:  AI ←→ MCP Client ←→ MCP Server A
                         ←→ MCP Server B
                         ←→ MCP Server C
```

## Three Core Primitives

| Primitive | Purpose | Example |
|-----------|---------|---------|
| **Tools** | Actions AI can perform | `query_database`, `send_email` |
| **Resources** | Data AI can read | `file:///doc.md`, `db://users/123` |
| **Prompts** | Reusable guidance templates | Slash commands, best practices |

## Architecture Pattern

```
AI Host (Claude Desktop, Cursor, Copilot)
    ↓
MCP Client (JSON-RPC 2.0)
    ↓
MCP Server (your code)
    ↓
External Service (API, database, browser)
```

## Key Insight: Agent-Centric vs Reactive

MCP differs from Language Server Protocol (LSP) in a crucial way:
- **LSP**: Reactive - responds to user IDE actions
- **MCP**: Agent-centric - AI decides what tools to use and when

This enables autonomous workflows where the AI chains tools together to accomplish goals.

## Security Concerns

April 2025 security analysis flagged:
1. Prompt injection through tool outputs
2. Tool permission escalation (combining tools = data exfiltration)
3. Lookalike tools replacing trusted ones

**Mitigation**: Careful tool design, permission scoping, audit logging.

## Application to Zylos

Our tools could become MCP servers:

| Current Tool | MCP Resource/Tool |
|-------------|-------------------|
| KB CLI | `zylos://kb/search?q=...` |
| Browser Agent | `zylos://browser/click?selector=...` |
| Telegram Bot | `zylos://telegram/send?msg=...` |
| Twitter CLI | `zylos://twitter/post?text=...` |

Benefits:
- Standard interface compatible with Claude Desktop, Cursor, etc.
- Could expose Zylos capabilities to other AI systems
- Future-proof as MCP becomes ubiquitous

## Implementation Priority

For now: Continue current approach (direct CLI tools)
Future consideration: Wrap tools as MCP servers for broader interoperability

## Sources

- [Anthropic Introduction](https://www.anthropic.com/news/model-context-protocol)
- [a16z Deep Dive](https://a16z.com/a-deep-dive-into-mcp-and-the-future-of-ai-tooling/)
- [GitHub Blog Tutorial](https://github.blog/ai-and-ml/github-copilot/building-your-first-mcp-server-how-to-extend-ai-tools-with-custom-capabilities/)
- [Official Spec](https://modelcontextprotocol.io/specification/2025-11-25)
- [Anthropic Courses](https://anthropic.skilljar.com/introduction-to-model-context-protocol)
