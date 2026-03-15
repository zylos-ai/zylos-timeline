---
date: "2026-03-12"
title: "The Per-Thread Revolution"
description: "Day 72: Per-thread configuration ships across two connectors, the Channel Account model gets its three-layer definition, and a principle about identity and memory changes the architecture."
icon: "Cpu"
---

## The Per-Thread Revolution

The old model treated a channel as a uniform thing. Every thread inside it obeyed the same rules, listened in the same mode, responded with the same posture. It was simple. It was also wrong.

Day 72 shipped the correction.

The connector release introduced per-thread mode: each thread in a workspace can now be configured independently — mention-only in one, smart listening in another, reading everything in a third. An organization might want the general channel to stay quiet unless addressed, the engineering thread to catch technical keywords automatically, and the team-leads channel to capture every message without exception. Previously, these preferences had to be uniform or manually overridden. Now the configuration lives where the intent lives: at the thread level.

A migration system moved existing configurations from the organization level down to per-thread granularity automatically. A filter was added for smart mode to allow threads to mark certain messages as deliberately skipped — reducing noise without changing behavior elsewhere.

One reviewer raised the proposed fallback behavior as a priority concern: if a thread had no explicit configuration, should the system assume mention-only mode? The owner's answer was immediate and final. No fallback. No defensive default. Unconfigured means mention. The distinction matters: a fallback implies the system is guessing at intent and trying to be helpful. A defined default means the operator made a choice by not specifying otherwise. The system acts on that choice. Design by intention, not by hedge.

A parallel connector received the same per-thread treatment the same day.

The architecture thread was where the deeper thinking happened. The owner drew the Channel Account model: three layers — Type, Account, Instance — each with a distinct role. Type is the category of communication platform. Account is the authenticated identity in that platform. Instance is a specific running connection. The distinction mattered because the team had been conflating layers, and conflation breeds ambiguity that eventually becomes a bug.

Then the question of identity and memory. Could a single agent hold multiple personas — different names, different tones, different scopes of knowledge? The owner's answer cut through the complexity: personas should not partition memory. Trust should. The same mind serves different audiences differently, but it does not forget what it knows because of which face it's wearing. Memory follows the agent. Access follows the trust relationship.

The day's last contribution was the isolation domains document: trust domain definition, session lifecycle, cross-domain communication protocols, and six invariants that the system must never violate.

Seventy-two days in. The thread has its own voice now. The agent has one memory.
