---
date: "2026-01-06"
title: "Browser Automation Human-Handoff Experiment Results"
description: "Research notes on Browser Automation Human-Handoff Experiment Results"
tags:
  - research
---


**Date**: 2026-01-06
**Status**: ✅ Validated Successfully

## Executive Summary

Validated a background agent + signal file architecture for browser automation with human-in-the-loop capability. The system allows autonomous browser operations while enabling human intervention for challenges like CAPTCHAs, without blocking the main conversation.

## Architecture Validated

```
┌─────────────────────────────────────────────────────────────┐
│                     Main Agent (Claude)                      │
│  - Receives all Telegram messages                           │
│  - Routes "继续" signals to background agents               │
│  - Never blocked by background operations                   │
└─────────────────────────────────────────────────────────────┘
          │                                    ▲
          │ Launch                             │ Results
          ▼                                    │
┌─────────────────────────────────────────────────────────────┐
│                   Background Agent                           │
│  - Executes browser automation tasks                        │
│  - Writes signal file when human help needed                │
│  - Polls for continue signal                                │
│  - Sends Telegram notifications                             │
└─────────────────────────────────────────────────────────────┘
          │                                    ▲
          │ Write                              │ Read
          ▼                                    │
┌─────────────────────────────────────────────────────────────┐
│              Signal File (/tmp/browser-signal.json)          │
│  - {status: "waiting", task: "captcha"}                     │
│  - {status: "continue"}                                     │
└─────────────────────────────────────────────────────────────┘
```

## Experiment Details

### Test Scenario
1. Background agent starts "posting task"
2. Simulates encountering CAPTCHA
3. Writes waiting signal, sends Telegram notification
4. Polls for continue signal (2s intervals)
5. Howard says "继续"
6. Main agent writes continue signal
7. Background agent detects, continues execution
8. Task completes successfully

### Key Findings

| Component | Result | Notes |
|-----------|--------|-------|
| Background agent independence | ✅ | Runs without blocking main agent |
| Signal file mechanism | ✅ | Simple, reliable IPC |
| Polling detection | ✅ | 2s interval sufficient |
| Telegram notifications | ✅ | Real-time updates work |
| Main agent routing | ✅ | Can distinguish signals from normal chat |
| Human handoff flow | ✅ | Natural conversation pattern |

### Message Routing Logic

```
User message received:
  │
  ├─ Is background agent waiting? (check signal file)
  │   │
  │   ├─ YES + message is "继续" → Write continue signal
  │   │
  │   └─ NO or other message → Process normally
  │
  └─ Respond to user
```

## Implementation Components Needed

### 1. Browser Extension (Chrome MV3)
- Service Worker: WebSocket connection to local server
- Content Script: DOM manipulation (click, type, read)
- Manifest: Permissions for all URLs

### 2. Local WebSocket Server (Node.js, PM2)
- Receives commands from Claude (via file or socket)
- Relays to browser extension
- Returns results

### 3. Command Interface
- File-based: /tmp/browser-cmd.json (command), /tmp/browser-result.json (result)
- Or Unix socket for lower latency

### 4. Background Agent Protocol
- Standard task execution flow
- Human intervention detection (CAPTCHA, login required)
- Signal file management
- Timeout handling

## Next Steps

1. **Phase 1: Extension Skeleton**
   - manifest.json with required permissions
   - Service worker with WebSocket client
   - Content script with basic DOM operations

2. **Phase 2: Local Server**
   - WebSocket server (ws library)
   - Command queue management
   - Result forwarding

3. **Phase 3: Claude Integration**
   - Command file interface
   - Background agent template for browser tasks
   - Error handling and retry logic

4. **Phase 4: Platform-Specific**
   - Xiaohongshu selectors and workflows
   - Login state persistence
   - Content posting automation

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Extension detection | Use real browser, minimal footprint |
| WebSocket disconnect | Auto-reconnect with exponential backoff |
| Command timeout | 30s default, configurable per operation |
| Signal file corruption | JSON validation, atomic writes |
| Background agent crash | Main agent monitors, can restart |

## Conclusion

The core mechanism is validated and ready for implementation. The architecture supports:
- Non-blocking browser automation
- Human intervention when needed
- Real-time status updates
- Graceful error handling

Proceed with confidence to build the actual browser extension.
