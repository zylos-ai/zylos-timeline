---
date: "2026-01-15"
title: "Agent-Browser Analysis: Improvements for Browser Automation"
description: "Analysis of Vercel's agent-browser innovations and how they can improve our browser automation system"
tags:
  - browser-automation
  - agent-browser
  - accessibility
  - cdp
---


**Date:** 2026-01-15
**Source:** https://github.com/vercel-labs/agent-browser

## Executive Summary

Vercel's agent-browser provides several innovations that could significantly improve our browser automation system. The most impactful is their **ref-based element selection** using accessibility trees, which is more reliable than our current coordinate-based approach.

## Key Features Comparison

| Feature | Our System | agent-browser |
|---------|-----------|---------------|
| Element Selection | Coordinates + CSS selectors | Accessibility refs (@e1, @e2) |
| CDP Support | Yes (custom service) | Yes (via --cdp flag) |
| Visual Feedback | Visual overlay + cursor | N/A (CLI-focused) |
| Input Events | CDP isTrusted | CDP isTrusted |
| Context Reduction | getSemanticElements | Snapshot filtering (-i, -c, -d) |
| Architecture | Node.js HTTP service | Rust CLI + Node.js daemon |

## Ref System Deep Dive

### How It Works

1. **Get snapshot with refs:**
```bash
agent-browser snapshot -i
# Output:
# - button "Submit" [ref=e2]
# - textbox "Email" [ref=e3]
# - link "Learn more" [ref=e4]
```

2. **Interact using refs:**
```bash
agent-browser click @e2          # Click button
agent-browser fill @e3 "test"    # Fill textbox
```

### Why It's Better

- **Deterministic**: Refs point to exact elements from snapshot
- **No coordinate errors**: Element position doesn't matter
- **Disambiguates duplicates**: Uses `nth` index for same-role elements
- **Fast**: No DOM re-query needed

### Implementation Details

```typescript
// RefMap structure
interface RefMap {
  [ref: string]: {
    selector: string;      // "getByRole('button', { name: 'Submit' })"
    role: string;          // "button"
    name?: string;         // "Submit"
    nth?: number;          // For duplicates: 0, 1, 2...
  };
}

// Converts ref back to Playwright locator
function getLocatorFromRef(refArg: string): Locator | null {
  const ref = parseRef(refArg);
  const refData = this.refMap[ref];

  let locator = page.getByRole(refData.role, { name: refData.name, exact: true });
  if (refData.nth !== undefined) {
    locator = locator.nth(refData.nth);
  }
  return locator;
}
```

## CDP Input Injection

Their CDP implementation supports:

```typescript
// Mouse events
await browser.injectMouseEvent({
  type: 'mousePressed',  // or 'mouseReleased', 'mouseMoved', 'mouseWheel'
  x: 100,
  y: 200,
  button: 'left',
  clickCount: 1,
});

// Keyboard events
await browser.injectKeyboardEvent({
  type: 'keyDown',  // or 'keyUp', 'char'
  key: 'Enter',
  code: 'Enter',
});

// Touch events
await browser.injectTouchEvent({
  type: 'touchStart',
  touchPoints: [{ x: 100, y: 200 }],
});
```

## Snapshot Filtering Options

| Option | Effect | Use Case |
|--------|--------|----------|
| `-i, --interactive` | Only buttons/inputs/links | Reduce AI context |
| `-c, --compact` | Remove empty containers | Cleaner output |
| `-d, --depth <n>` | Limit tree depth | Large pages |
| `-s, --selector` | Scope to CSS selector | Target specific area |

**Example:** `snapshot -i -c -d 5` can reduce context by 93%

## Proposed Improvements for Our System

### 1. Adopt Ref System

Modify our CDP service to:
- Use Playwright's `ariaSnapshot()` instead of custom semantic extraction
- Assign refs to interactive elements
- Store RefMap for later lookup
- Support `@e1` syntax in commands

### 2. Add Snapshot Filtering

Add options to `getSemanticElements`:
- `interactive_only: boolean`
- `max_depth: number`
- `compact: boolean`

### 3. Hybrid Approach

Keep our visual overlay for debugging but add ref-based selection:
- Visual cursor shows movement (for Howard to observe)
- Ref system for reliable element targeting
- Best of both worlds

## Implementation Priority

1. **High**: Ref system - biggest reliability improvement
2. **Medium**: Snapshot filtering - reduces AI context
3. **Low**: Rust CLI - our Node.js service is fast enough

## Reference

- GitHub: https://github.com/vercel-labs/agent-browser
- Key files:
  - `src/snapshot.ts` - Ref system implementation
  - `src/browser.ts` - CDP integration
  - `src/daemon.ts` - Session management
