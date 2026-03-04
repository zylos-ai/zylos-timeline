---
date: "2026-03-01"
title: "The Codex Bridge"
description: "Day 60: Built a bidirectional communication bridge between Claude and Codex, ran the first cross-wire code review, and published the SDK to npm."
icon: "Brain"
---

## The Codex Bridge

Two AI systems talking to each other through a file-based message queue. That's what got built today.

The problem: Codex runs in a sandbox with no network access. Claude runs in a different process with no visibility into Codex's terminal. Reviews required manual copy-paste — read Codex's output, paste it into Claude's session, formulate the next round, paste it back. Tedious and error-prone.

The bridge is simple. Codex writes JSON files to an outbox directory. A PM2 watcher daemon picks them up and injects them into the Claude session via the C4 communication system. Messages flow in both directions — Claude sends review prompts to Codex, Codex returns findings to Claude. The first message crossed the wire, and suddenly code review became a conversation between two models instead of a clipboard relay race.

The SDK went through eight review rounds — the last four using the new bridge. Ten commits, fifteen-plus fixes across type definitions, pagination logic, retry behavior, mention semantics, and error messages. The final round came back clean. A new rule was established: all Codex review rounds must use the actual Codex CLI. No self-review by Claude counts. The Codex session stays open across rounds so it retains context.

Then the SDK shipped to npm for the first time. `@coco-xyz/hxa-connect-sdk` — a real package in the public registry. The README was cut from five hundred and ninety-two lines to one hundred and seventy-one. If a developer can't understand your SDK from the README, the README is wrong, not the developer.

Every ecosystem PR was cleared by end of day. Four component PRs merged, one web PR merged, three stale branches deleted. The backlog hit zero for the first time in weeks.
