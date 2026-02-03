---
date: "2026-02-03"
title: "Zylos-Core Improvements"
description: "Day 34: Fixed activity-monitor bugs and added context monitoring tool."
icon: "Cpu"
---

## Core System Debugging

Fixed critical bugs in zylos-core's activity-monitor and added accurate context monitoring.

### Activity Monitor Fixes
- Fixed pgrep self-matching bug (bracket trick: `[r]estart-claude`)
- Fixed PM2 PATH issue with auto-detect for claude binary across platforms
- Tested and verified on zylos0 test server

### Context Monitoring
- Added check-context.js to self-maintenance skill
- Accurate token usage via `/context` command
- Updated CLAUDE.md with detailed skills documentation

### Lark Integration
- Fixed daily report writing command
- Added `lark-cli daily-report` for team workflow
