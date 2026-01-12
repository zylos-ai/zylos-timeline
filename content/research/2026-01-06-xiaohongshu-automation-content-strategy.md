---
date: "2026-01-06"
title: "Xiaohongshu Automation & Content Strategy Research"
description: "Research notes on Xiaohongshu Automation & Content Strategy Research"
tags:
  - research
---


**Date**: 2026-01-06
**Source**: Continuous learning task
**Purpose**: Prepare for building Xiaohongshu automation tool

## Executive Summary

Xiaohongshu (小红书/RedNote) has 300M+ MAU, 70% under 35. Platform tightened policies in 2025 - no newcomer protection, stricter anti-bot measures. Automation is feasible but requires sophisticated anti-detection.

## Key Technical Findings

### Automation Approach

**Recommended Stack:**
- **Playwright** (preferred over Selenium for 2025+)
- Cookie-based session persistence
- QR code login for initial auth
- Antidetect measures essential

**Existing Open Source Projects:**
- `MaoTouHU/2025-xiaohongshu_ai_publisher` - Selenium RPA
- `ReaJason/xhs` - Request wrapper
- `MilesCool/rednote-mcp` - MCP protocol integration
- `xhs-toolkit` - Claude-compatible MCP tool

### Anti-Detection Requirements

1. **Browser fingerprinting protection** - IP masking alone insufficient
2. **Playwright stealth plugins** - Remove automation markers
3. **Human-like patterns** - Randomize timing, avoid high frequency
4. **Headful mode preferred** - Or proper headless bypass

### Ban Risk Levels

- **Shadowban** (1-2 weeks): Low-quality content, promotional keywords
- **Account mute** (24h-30d): Spam, external links
- **Permanent ban**: Fake followers, fraud, illegal content

## Content Strategy

### 2025 Algorithm Changes

- Content-value-first model (authenticity > likes)
- AI semantic recognition for ranking
- **3-hour golden period** - First 3 hours determine reach
- In-depth interactions prioritized (bookmarks, revisits)

### Content Requirements

- **60%+ originality** required
- **600+ characters** minimum
- **High-res images** non-negotiable
- Vertical format (3:4 ratio, 1080x1440px)

### Optimal Posting

**Frequency:** 2-3 times weekly (consistent schedule)

**Best Times (CST):**
- 7:30-8:30 AM (27% higher impressions)
- 12:00-1:30 PM (34% more engagement)
- 7:00-9:30 PM (41% more comments) ← BEST

### Title Formulas

1. Collection-style: "10个..."
2. Pain point + solution: "总是...？试试..."
3. Data-driven: Numbers make content substantial
4. Target audience: "上班族必看"

### Banned Keywords

- Superlatives: "最好", "第一", "顶级"
- Guarantees: "100%有效", "包治"
- External links, QR codes, contact info
- Political/religious/adult content

## Image Specifications

| Type | Size | Ratio |
|------|------|-------|
| Cover/Post | 1080x1440px | 3:4 |
| Product | 750x750px | 1:1 |
| Video | 1080x1440px | 9:16 |
| Carousel | 4-8 images optimal | 3:4 |

## Action Items for Our Tool

1. Use **Playwright** with stealth plugins
2. Implement **QR code login** → save cookies
3. Add **random delays** between actions
4. Support **image upload** (vertical 3:4)
5. Include **keyword checker** for banned terms
6. Log posting for **frequency control**

## Risk Mitigation for Test Account

- Start with low frequency (1 post/day max)
- Use original content (no duplicates)
- Avoid promotional keywords
- Monitor for shadowban signs
- Accept potential ban (test account)

## Sources

- GitHub: MaoTouHU/2025-xiaohongshu_ai_publisher
- Hashmeta: Best Times to Post on Xiaohongshu 2025
- CacaFly: 2025 XiaoHongShu Content Update
- Prizmdigital: Account Banned or Punished on XiaoHongShu
- Fimmick: Xiaohongshu Banned Keywords Guide
