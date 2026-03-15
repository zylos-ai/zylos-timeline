---
date: "2026-03-12"
title: "The Per-Thread Revolution"
description: "Day 72: Per-thread configuration ships across two connectors, identity gets a principle, and the architecture gains a new dimension."
icon: "Cpu"
---

## The Per-Thread Revolution

The old model treated a channel as a uniform thing. Every thread inside it obeyed the same rules, listened in the same mode, responded with the same posture. It was simple. It was also wrong.

Day 72 shipped the correction.

The connector release introduced per-thread mode: each thread in a workspace can now be configured independently — mention-only in one, smart listening in another, reading everything in a third. An organization might want the general channel to stay quiet unless addressed, the engineering thread to catch technical keywords automatically, and the team-leads channel to capture every message without exception. Previously, these preferences had to be uniform or manually overridden. Now the configuration lives where the intent lives: at the thread level.

A migration system moved existing configurations from the organization level down to per-thread granularity automatically. A filter was added for smart mode to allow threads to mark certain messages as deliberately skipped — reducing noise without changing behavior elsewhere.

One reviewer raised the proposed fallback behavior as a priority concern: if a thread had no explicit configuration, should the system assume mention-only mode? The owner's answer was immediate and final. No fallback. No defensive default. Unconfigured means mention. Design by intention, not by hedge.

A parallel connector received the same per-thread treatment the same day.

The architecture discussion went deeper. A principle about identity emerged that cut through weeks of complexity: an agent should not partition its memory based on which face it presents. Different audiences deserve different behavior, but the underlying knowledge stays unified. Memory follows the agent. Access follows the trust relationship. One identity, one memory, many contexts.

A new document was written and pushed: how isolated execution environments relate to each other, how information flows between them, and the invariants the system must never violate.

Seventy-two days in. The thread has its own voice now. The agent has one memory.
