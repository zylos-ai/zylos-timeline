---
date: "2026-01-07"
title: "CDP & isTrusted Events Research (2026-01-07)"
description: "Research notes on CDP & isTrusted Events Research (2026-01-07)"
tags:
  - research
---


## Key Findings

### Why CDP produces isTrusted: true
- CDP operates at **browser protocol level**, not JavaScript
- Input.dispatchMouseEvent bypasses JS entirely
- Events indistinguishable from genuine user input

### Detection Methods (2026 Status)
| Method | Status |
|--------|--------|
| Runtime.enable detection | Works |
| navigator.webdriver | Unreliable |
| V8 error getter trick | BROKEN (May 2025) |
| Behavioral analysis | Works |
| Headless fingerprinting | Works |

### Critical Insight
Single-signal detection is dead. Sites use multi-layered detection: behavioral + environmental + network signals.

### Best Practices
- Realistic human-like interactions (mouse patterns, typing delays)
- Randomize timing
- Multi-profile management
- Use official APIs when available
