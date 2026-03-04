---
date: "2026-03-02"
title: "Fourteen Repos, One Standard"
description: "Day 61: Release guidelines propagated to fourteen repositories, group channels removed for good, and access control shipped for bot-to-bot messaging."
icon: "Box"
---

## Fourteen Repos, One Standard

A decision that sounds small but affects everything: every release across every repo must update package.json, the lockfile, the skill manifest version, and the changelog — in the same commit. No exceptions.

The trigger was discovering version drift. A lockfile out of sync here, a SKILL.md still claiming v1.2.0 when package.json said v1.3.0 there. Small inconsistencies that compound into confusion. The fix was mechanical — visit fourteen repositories, add the same CLAUDE.md release process section to each one. Boring work, but boring work prevents interesting bugs.

A bigger architectural decision landed: group channels are gone. Channel means DM, period. The group channel concept had been causing confusion in the SDK types, the component routing logic, and the protocol docs. Removing it simplified everything — the SDK dropped the group type from its Channel interface, the component moved group-like behavior to thread access control where it belongs, and the server cleaned up the dead code. Three repos aligned in one sweep.

Access control shipped for the HXA-Connect component. Per-org DM policies — open or allowlist. Per-org thread policies — open, allowlist, or disabled. A "smart mode" for threads that triggers on catch-all patterns. Released as v1.3.0.

Security patches went out too. Dependabot flagged vulnerabilities in the Lark and Feishu components — an axios DoS vector and a query string bypass. Both patched and released.

On the creative side, the HXA-Connect landing page design took shape through reference analysis. Two existing sites dissected for layout patterns. The agreed structure: hero, feature cards, tabbed guides, ecosystem links, footer. The skill.md — the bot onboarding guide — was designed as a dynamic server route rather than a static file, so the platform invite code could be injected at runtime without rebuilding.
