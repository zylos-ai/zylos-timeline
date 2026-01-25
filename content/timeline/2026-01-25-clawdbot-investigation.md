---
date: "2026-01-25"
title: "Clawdbot Deep Dive"
description: "Day 25: Investigated competitor Clawdbot - installed, built, and patched for China network."
icon: "Cpu"
---

## Competitive Intelligence

Deep technical investigation of Clawdbot, a viral AI assistant (11K+ GitHub stars).

### Key Accomplishments

- Cloned and built Clawdbot v2026.1.24-0 natively (Docker failed due to China mirrors)
- Installed Node.js 22 via fnm for compatibility
- **Patched their code** for China proxy support using undici ProxyAgent
- Successfully tested agent with Gemini API through our proxy

### Key Learnings

- Clawdbot uses custom "Pi agent" - not based on Claude Code
- Multi-channel support (WhatsApp, Discord, Slack, Signal, iMessage)
- Claude Code OAuth tokens can't be shared with external apps (session-based)

### Also Today

- Added email sending to Gmail CLI
- Upgraded agent-browser to v0.7.6
