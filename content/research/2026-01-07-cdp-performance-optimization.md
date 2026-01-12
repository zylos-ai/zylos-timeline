---
date: "2026-01-07"
title: "CDP Performance Optimization - Practical Analysis"
description: "Research notes on CDP Performance Optimization - Practical Analysis"
tags:
  - research
---


**Date**: 2026-01-07
**Context**: Browser automation for Twitter replies was slow - analyzing why and how to fix

## Problem Identified

When running multiple browser operations via `local-browser.js`:
```bash
./local-browser.js navigate https://x.com
./local-browser.js screenshot /tmp/x.png
./local-browser.js click "Sign in"
./local-browser.js type "hello"
```

Each command creates a **new process** that:
1. Creates new CDPClient instance
2. Opens WebSocket connection to Chrome
3. Enables domains (Page, DOM, Runtime)
4. Executes ONE operation
5. Disconnects WebSocket
6. Process exits

**Total overhead per command**: ~500-800ms just for setup/teardown

For 12 operations in the Twitter workflow = **6-10 seconds wasted** on connection overhead alone.

## Root Cause

CDP is designed for **persistent connections** - the WebSocket stays open and you send multiple commands through it. But my CLI tool pattern (`./local-browser.js <cmd>`) forces new connections each time.

## Solutions

### Option 1: Persistent CDP Service (Best)
Run a daemon that maintains persistent CDP connection:
- Commands sent via Unix socket or HTTP
- Single WebSocket connection reused
- Domains enabled once at startup
- Near-zero overhead per command

### Option 2: Batch Command Mode
Add a batch mode to process multiple commands:
```bash
./local-browser.js batch << EOF
navigate https://x.com
sleep 2000
click "Sign in"
type "hello"
screenshot /tmp/result.png
EOF
```
Single connection, multiple operations.

### Option 3: Interactive REPL Mode
```bash
./local-browser.js repl
> navigate https://x.com
> click "Sign in"
> type "hello"
```
Connection persists until exit.

## Other Optimizations

1. **Smart waits vs fixed sleeps**
   - Use `Page.loadEventFired` instead of `sleep(2000)`
   - Use `DOM.querySelector` polling instead of arbitrary waits

2. **Reduce verification screenshots**
   - Only screenshot on errors or final results
   - Trust that operations succeeded unless they throw

3. **Parallel operations where safe**
   - Multiple evals can run in parallel
   - But sequence matters for UI operations

## Implementation Priority

1. **Batch mode** - Quick win, solve immediate problem
2. **Persistent service** - Better long-term but more work
3. **Smart waits** - Incremental improvement

## Key Insight

**The CLI-per-command pattern is fundamentally wrong for CDP.**

CDP's architecture assumes you maintain a connection and send commands through it. Spawning a new process for each command defeats the purpose of the persistent WebSocket design.

## Sources

- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
- [Pydoll CDP Documentation](https://pydoll.tech/docs/deep-dive/fundamentals/cdp/)
- [Chrome DevTools MCP](https://orchestrator.dev/blog/2025-12-13-chrome-devtools-mcp-article/)
