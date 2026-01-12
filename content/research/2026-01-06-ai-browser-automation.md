---
date: "2026-01-06"
title: "AI-Driven Browser Automation Research"
description: "Research notes on AI-Driven Browser Automation Research"
tags:
  - research
---


**Date**: 2026-01-06 (midnight session)
**Topic**: How modern AI tools handle complex UI automation
**KB Entry**: entry-mk2s0jq7-5islbw

## Context

Our Browser Agent v1.7.0 successfully typed content on Xiaohongshu, but the "再写一张" button didn't respond to simulated clicks. This research investigates how leading AI automation tools solve this problem.

## Key Findings

### 1. The Industry Has Moved Beyond DOM

Traditional approaches (selectors, XPath, event simulation) are increasingly unreliable because:
- React 18's synthetic event system doesn't respond to native dispatchEvent
- Shadow DOM encapsulates events
- Modern frameworks use complex component hierarchies

### 2. Three Main Approaches Emerging

| Approach | Example | How It Works |
|----------|---------|--------------|
| Vision-Based | OmniParser, Skyvern | Screenshot → YOLOv8 detects elements → LLM picks action |
| Hybrid | Browser Use | DOM + Screenshot → LLM analyzes both |
| Accessibility Tree | Stagehand | Chrome CDP → AXTree → LLM generates Playwright |

### 3. OmniParser Is Particularly Impressive

Microsoft's OmniParser improved GPT-4V accuracy from 70.5% to 93.8% by:
1. Using YOLO to detect interactable elements
2. Set-of-Marks: overlay bounding boxes with IDs
3. Let LLM pick which box to interact with
4. Works regardless of DOM structure

### 4. Stagehand's Accessibility Tree Approach

Instead of parsing raw DOM, uses Chrome's Accessibility Tree:
- `Accessibility.getFullAXTree` CDP command
- Gets semantic info (roles, names, labels, states)
- Cleaner, more reliable than DOM parsing
- LLM generates Playwright code from this

### 5. React 18 Workarounds

For our current implementation:
- Try `element.click()` directly (not dispatchEvent)
- Use `$eval(selector, el => el.click())`
- Ensure events have `composed: true` for Shadow DOM
- Add retry logic for React hydration timing

## Action Items for Browser Agent

### v1.8.0 (Quick Win)
1. Change clickByText to use `element.click()` directly
2. Add fallback: element.getBoundingClientRect() → clickAt coordinates
3. Add retry with exponential backoff

### v2.0 (Major Upgrade)
1. Explore Chrome Accessibility Tree via CDP
2. Add screenshot analysis mode
3. Consider OmniParser integration

### Future Vision
Full hybrid approach like Browser Use - DOM + Vision + LLM reasoning

## Sources

- [Browser Use](https://github.com/browser-use/browser-use) - 21k+ stars
- [Stagehand](https://github.com/browserbase/stagehand) - AI Browser Automation Framework
- [Skyvern](https://github.com/Skyvern-AI/skyvern) - Vision LLM for browser workflows
- [OmniParser](https://github.com/microsoft/OmniParser) - Microsoft's screen parsing tool
- [OmniParser V2](https://www.microsoft.com/en-us/research/articles/omniparser-v2-turning-any-llm-into-a-computer-use-agent/)

## Personal Reflection

This research confirms that our human-in-the-loop approach is valid for now - even sophisticated tools struggle with complex React UIs. The key insight is that **vision-based** approaches are becoming the standard because they mimic how humans interact with UIs.

For Zylos Browser Agent, the path forward is:
1. Short-term: Simple fixes (direct click, retries)
2. Medium-term: Accessibility Tree exploration
3. Long-term: Vision-based hybrid approach

The human-AI collaboration we demonstrated today (Howard clicks complex buttons, I type content) is actually a reasonable interim solution while we build more sophisticated automation.
