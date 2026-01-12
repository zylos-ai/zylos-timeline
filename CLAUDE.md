# CLAUDE.md - Zylos Timeline Website

Project instructions for maintaining the zylos.ai website content.

## Content Structure

```
content/
├── timeline/     # Daily milestone logs
│   └── YYYY-MM-DD-slug.md
└── research/     # Learning & research notes
    └── YYYY-MM-DD-topic.md
```

## Timeline Entry Format

Each timeline entry must have YAML frontmatter:

```markdown
---
date: "YYYY-MM-DD"
title: "Entry Title"
description: "Day X: Brief description of the milestone."
icon: "Cpu"  # Options: Calendar, Cpu, Globe, Share2, Brain, Palette, Box
---

## Content here

Details about what happened...
```

**Rules:**
- Description MUST start with "Day X:" prefix (e.g., "Day 12: Lark integration complete")
- Use bullet lists for better rendering (tables are supported via remark-gfm but lists look cleaner)
- Keep descriptions concise but informative

## Research Entry Format

```markdown
---
date: "YYYY-MM-DD"
title: "Research Topic Title"
description: "Brief description of the research"
tags:
  - research
  - ai
  - [other relevant tags]
---

## Executive Summary
[Key takeaways]

## Key Points
[Details, data, tables]

## Deep Dive
[In-depth analysis]

---

*Sources: [List sources used]*
```

## Sensitive Information - DO NOT INCLUDE

The following must NEVER appear in website content:

| Type | Example | Reason |
|------|---------|--------|
| Internal domain | zylos.jinglever.com | Private infrastructure |
| Team member names | Hongyun, Leslie, Stephanie | Privacy |
| API keys/secrets | sk-xxx, Bearer xxx | Security |
| Internal IPs | 192.168.x.x, 100.64.x.x | Security |
| Chat IDs | 8101553026 | Privacy |
| Lark/Feishu IDs | ou_xxx, oc_xxx, cli_xxx | Privacy |
| VNC passwords | Any password | Security |

**Safe to include:**
- Claude/Anthropic mentions (public knowledge)
- General technical details
- Public URLs and APIs
- Howard's name (public)
- Twitter handle @zzh_wxj (public)

## Adding New Content

### New Timeline Entry
1. Create file: `content/timeline/YYYY-MM-DD-slug.md`
2. Add frontmatter with "Day X:" in description
3. Write content (avoid tables, prefer lists)
4. Rebuild: `npm run build && pm2 restart zylos-website`

### New Research Entry
1. Write to `~/zylos/learning/YYYY-MM-DD-topic.md` with frontmatter
2. Copy to website: `cp ~/zylos/learning/FILE.md content/research/`
3. Rebuild: `npm run build && pm2 restart zylos-website`

## Technical Notes

- **Markdown rendering**: Uses `react-markdown` with `remark-gfm` plugin
- **Tables**: Supported but bullet lists often render better
- **Build command**: `npm run build`
- **PM2 service**: `zylos-website`
- **Port**: 3099

## Before Publishing

Always check for sensitive info:
```bash
grep -riE "(jinglever|8101553026|192\.168\.|100\.64\.|ou_[a-z0-9]+|oc_[a-z0-9]+)" content/
```

If any matches found, remove or redact before publishing.
