---
date: "2026-01-10"
title: "Browser Automation Deep Dive: Code Analysis & Visualization"
description: "Research notes on Browser Automation Deep Dive: Code Analysis & Visualization"
tags:
  - research
---


*Research Date: 2026-01-10*

## Executive Summary

Deep analysis of Browser Use and comparable projects reveals key patterns for reliable browser automation: hybrid DOM+accessibility+vision detection, paint-order filtering for obscured elements, and real-time visual overlays. Best practices for visualization include CDP Overlay domain for highlighting, custom cursor animations, and status panels showing AI reasoning.

## Key Projects Comparison

| Project | Stars | Approach | Key Strength |
|---------|-------|----------|--------------|
| **Browser Use** | 71.4k | DOM+Accessibility+Vision | Paint-order filtering, demo mode |
| **Skyvern** | 15k+ | Vision+DOM hybrid | Enterprise features, multi-agent |
| **Stagehand** | 10k+ | Accessibility tree + caching | 70% cost reduction |
| **LaVague** | 8k+ | Modular architecture | Local model support |
| **AgentQL** | - | Semantic query language | Self-healing selectors |

## Deep Dive: Browser Use Architecture

### Core Architecture

**Three-component system:**
1. **Agent** (`agent/service.py`): Main loop, LLM coordination, state management
2. **Browser Session** (`browser/session.py`): Lifecycle, watchdogs, CDP client
3. **Tools/Controller** (`tools/service.py`): Action registry, 20+ browser actions

**Event Bus Pattern:**
```python
# Event-driven coordination
event = browser_session.event_bus.dispatch(ClickElementEvent(node=node))
await event
result = await event.event_result(raise_if_any=True)
```

### Element Detection (Key Innovation)

**Three-tier detection:**
1. **DOM Snapshot** - Full document structure
2. **Accessibility Tree** - Roles, labels, focusability
3. **Visual Layout** - Paint order, bounding boxes

**Clickable Element Scoring:**
- Tag-based: `button`, `input`, `select`, `a`
- ARIA roles: `role="button"`, `role="link"`
- Event handlers: `onclick`, `onmousedown`
- CSS cursor: `cursor: pointer`

**Paint Order Filtering (Unique):**
```python
# Removes elements visually obscured by overlays
# Uses CDP's includePaintOrder to detect z-index stacking
PaintOrderRemover(simplified_tree).calculate_paint_order()
```

This significantly reduces false positives by eliminating elements hidden under modals/overlays.

### Action Execution Pipeline

```
LLM Decision → Action Model → Event Dispatch → CDP Execution
```

**CDP Commands Used:**
- Click: `DOM.scrollIntoViewIfNeeded` + `Input.dispatchMouseEvent`
- Type: `DOM.focus` + `Input.insertText`
- Navigate: `Page.navigate`

### Demo Mode Visualization

Browser Use injects a **JavaScript overlay panel** showing:
- 💭 Thinking process
- ▶️ Actions taken
- ✅ Successes
- ❌ Errors

```javascript
// Persistent panel using CustomEvent API
// Session-scoped to avoid conflicts
```

## Visualization Best Practices

### 1. Element Highlighting

**CDP Overlay Domain (Most Robust):**
```javascript
// Chrome DevTools Protocol
Overlay.highlightNode({ nodeId, highlightConfig })
Overlay.highlightRect({ x, y, width, height })
```

**JavaScript Injection (Cross-browser):**
```javascript
const overlay = document.createElement('div');
overlay.style.position = 'fixed';
overlay.style.border = '2px solid red';
overlay.style.pointerEvents = 'none'; // Don't block clicks
overlay.style.zIndex = '999999';
```

### 2. Cursor Visualization

**Custom cursor with animation:**
```javascript
document.addEventListener('pointermove', (e) => {
  cursor.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
});
// Add click ripple effects with CSS animations
```

### 3. Status Display

**Approaches:**
- Semi-transparent overlays (`rgba(0,0,0,0.5)`)
- Status badges showing action type
- Conversational overlays showing AI reasoning

### 4. Real-Time Streaming

| Method | Use Case | Latency |
|--------|----------|---------|
| VNC/noVNC | Live browser view | Zero |
| Screenshot + annotation | Recorded playback | Per-frame |
| Chrome viewport streaming | Skyvern approach | Low |

### 5. Recording & Replay

**Playwright Trace Viewer (Best):**
- Time-travel debugging
- DOM snapshots (interactive, not just screenshots)
- Network panel
- Console logs

## Effective Techniques Summary

### What Works Best

1. **smartClick with role+text** - More reliable than coordinates
2. **Accessibility tree** - 80-90% data reduction vs raw DOM
3. **Paint-order filtering** - Eliminates obscured elements
4. **Visual overlay** - Shows AI reasoning in real-time
5. **Human handoff signals** - For CAPTCHA/verification

### What to Avoid

- ❌ Hardcoded CSS selectors
- ❌ Coordinate-only clicking (unreliable)
- ❌ Text-only matching (multiple matches)
- ❌ Heavy DOM manipulation (performance)

## Recommendations for Our System

### Immediate Improvements

1. **Add paint-order filtering** to our element detection
2. **Enhance status panel** to show AI reasoning steps
3. **Implement role+text+near** as primary click strategy (done!)

### Future Enhancements

1. **Accessibility tree parsing** - More robust element detection
2. **Auto-caching** (Stagehand pattern) - Reduce LLM calls
3. **Trace recording** - For debugging failed automations
4. **Vision fallback** - Screenshot analysis when DOM fails

## Code References

**Browser Use key files:**
- `agent/service.py` - Main agent loop
- `dom/serializer/clickable_elements.py` - Element detection logic
- `dom/serializer/paint_order.py` - Obscured element filtering
- `browser/demo_mode.py` - Visual overlay (800 lines JS)
- `tools/service.py` - Action implementations

**Visualization patterns:**
- CDP Overlay domain: `highlightNode`, `highlightRect`
- Playwright: `locator.highlight()`
- noVNC: WebSocket-based browser streaming

---

*Deep code analysis of Browser Use, Skyvern, Stagehand, LaVague, AgentQL*
