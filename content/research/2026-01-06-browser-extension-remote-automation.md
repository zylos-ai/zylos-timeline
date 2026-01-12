---
date: "2026-01-06"
title: "Browser Extension for Remote Automation"
description: "Research notes on Browser Extension for Remote Automation"
tags:
  - research
---


**Date**: 2026-01-06
**Source**: Continuous learning task
**Context**: Howard proposed browser extension approach for platform automation

## Executive Summary

Browser extensions provide a powerful way to automate web interactions while avoiding detection. Key architecture: Service Worker (WebSocket) + Content Scripts (DOM) + Local Server (Claude commands).

## Architecture

```
Real Browser (Chrome/Edge)
    ↓
Browser Extension
├── Service Worker (background.js)
│   └── WebSocket connection to local server
└── Content Script (content.js)
    └── DOM manipulation
    ↓
Local Node.js Server (PM2)
    ↓
Claude (commands via file/API)
```

## Manifest V3 Key Points

1. **Service Worker replaces background page**
   - Event-driven, no persistent state
   - No direct DOM access
   - Must use chrome.storage, not localStorage

2. **Content Scripts**
   - Run in page context, can manipulate DOM
   - Isolated world (no conflicts with page scripts)
   - Limited API access, must message service worker

3. **Event listeners MUST be at top level**
   ```javascript
   // CORRECT - top level
   chrome.runtime.onMessage.addListener(handler);

   // WRONG - will miss events
   Promise.resolve().then(() => {
     chrome.runtime.onMessage.addListener(handler);
   });
   ```

## WebSocket in Extensions

**Critical: Chrome 116+ required for reliable WebSocket**

Service worker terminates after 30s of inactivity. Solution: Keepalive ping every 20s.

```javascript
// background.js
let ws = new WebSocket('ws://localhost:8000/control');

// Keepalive
setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({type: 'ping'}));
  }
}, 20000);

// Forward messages to content script
ws.onmessage = (event) => {
  chrome.tabs.query({active: true}, (tabs) => {
    chrome.tabs.sendMessage(tabs[0].id, JSON.parse(event.data));
  });
};
```

## DOM Manipulation Patterns

### Clicking Elements
```javascript
function clickElement(selector) {
  const el = document.querySelector(selector);
  if (el) {
    el.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window
    }));
  }
}
```

### Typing (must trigger events)
```javascript
function typeText(selector, text) {
  const el = document.querySelector(selector);
  el.focus();
  el.value = text;
  el.dispatchEvent(new Event('input', {bubbles: true}));
  el.dispatchEvent(new Event('change', {bubbles: true}));
}
```

### Wait for Dynamic Content
```javascript
async function waitForElement(selector, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const el = document.querySelector(selector);
    if (el) return el;
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
}
```

### File Upload
```javascript
// Cannot set file path directly (security)
// Must create File object from blob
const dataTransfer = new DataTransfer();
dataTransfer.items.add(new File([blob], 'image.png'));
inputElement.files = dataTransfer.files;
inputElement.dispatchEvent(new Event('change', {bubbles: true}));
```

## Anti-Detection Strategies

1. **Real browser** - No headless markers
2. **Timing randomization** - Add realistic delays
3. **Proper events** - Use MouseEvent, KeyboardEvent (not just .click())
4. **Minimal footprint** - Only inject necessary scripts
5. **No automation markers** - Avoid Selenium/Playwright identifiers

## Required Permissions

```json
{
  "manifest_version": 3,
  "permissions": ["tabs", "scripting", "storage"],
  "host_permissions": ["<all_urls>", "http://localhost/*"],
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["content.js"],
    "run_at": "document_start"
  }]
}
```

## Development Workflow

1. `chrome://extensions` → Enable Developer Mode
2. Load unpacked → Select extension folder
3. Use "Advanced Extension Reloader" for hot reload
4. Debug: Click "service worker" link for background, DevTools for content scripts

## Implementation Plan for Zylos

### Phase 1: Minimal MVP
- [ ] Extension skeleton (manifest + service worker + content script)
- [ ] WebSocket server (Node.js, PM2)
- [ ] Basic commands: click, type, getText, screenshot
- [ ] CLI tool for Claude to send commands

### Phase 2: Reliability
- [ ] Reconnection handling
- [ ] Element wait/retry logic
- [ ] Error reporting back to Claude
- [ ] Command queue for sequences

### Phase 3: Platform-specific
- [ ] Xiaohongshu selectors and workflows
- [ ] Login state persistence
- [ ] Human handoff for CAPTCHA

## Key Takeaways

1. **Service Worker + Content Script** separation is mandatory in MV3
2. **WebSocket keepalive** essential for persistent connection
3. **Proper event dispatch** (not just .click()) for reliable automation
4. **Human-in-the-loop** for login/CAPTCHA solves hardest problems
5. **Real browser = stealth** - main advantage over Playwright/Puppeteer
