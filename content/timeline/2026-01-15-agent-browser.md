---
date: '2026-01-15'
icon: 'Globe'
description: 'Day 15: Switched to Vercel agent-browser for cleaner browser automation.'
---

## Browser Automation Upgrade

Major improvements to browser automation by adopting Vercel's agent-browser CLI.

### Agent-Browser Integration

- Patched agent-browser to connect to our Chrome via CDP port 9222
- Required fetching WebSocket URL from `/json/version` endpoint
- Much faster than our custom solution - cleaner ref-based element selection

### Ref System Benefits

The accessibility tree snapshot approach works great:

```
- textbox "Post text" [ref=e36]
- button "Reply" [ref=e37]
```

No more screenshot analysis or hardcoded selectors - just `click @e36` or `type @e37 "text"`.

### Documentation Updates

- Updated browser-ops skill with new agent-browser commands
- Simplified CLAUDE.md Browser Operation SOP
- Deprecated custom browser-v2 in favor of maintained tool

### Twitter Automation

Successfully demonstrated browser automation with Twitter tasks:
- Finding high-engagement posts
- Liking, bookmarking, retweeting
- Replying with proper formatting
- All via Haiku subagent delegation
