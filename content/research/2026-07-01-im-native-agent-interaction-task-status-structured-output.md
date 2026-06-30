---
date: "2026-07-01"
title: "IM-Native Agent Interaction: Designing Task Status and Structured Output in Chat Interfaces"
description: "Design patterns for presenting AI agent task execution, long-running operations, and structured outputs within instant messaging chat interfaces"
tags: ["ai-agents", "ux-design", "im-integration", "chat-interfaces", "conversational-ux"]
---

## Executive Summary

Instant messaging platforms were designed for human-to-human conversation — short bursts of text flowing in real time. When AI agents enter that stream, they bring fundamentally different interaction demands: long-running tasks, structured data outputs, approval gates, multi-step progress, and error states that users need to understand and act on. Naively dumping agent output into chat produces information overload and broken workflows.

This article surveys how major IM platforms (Slack, Lark/Feishu, Microsoft Teams, Discord, and WeChat Work) have evolved their messaging primitives to support richer agent interactions, identifies cross-platform design patterns, and distills actionable guidance for building IM-native agent interfaces in systems like COCO Workspace — where all user-agent communication happens within a chat stream, with no dedicated status dashboard.

## The IM Constraint: Why Chat Is Both Powerful and Limiting

Chat-first interfaces have a fundamental property that makes them uniquely suited for agent interaction: they are always open. Users do not navigate to a page; the channel is just there. This lowers the engagement barrier dramatically — agents can surface information, ask questions, and deliver results without requiring context switches.

But the same linear stream creates hard constraints:

- **No persistent state view.** Users cannot glance at a dashboard to see five concurrent agent tasks and their statuses. Everything must be reconstructed from the message stream.
- **Scroll loss.** A status message posted ten minutes ago may be far above the current viewport. In-stream status is ephemeral in practice.
- **Rendering is limited.** Complex tables, nested forms, and rich data visualizations are hard to express in a message. Platforms differ wildly in what they support.
- **The flood problem.** An agent that posts a new message for every step it completes will rapidly drown the channel. Notification fatigue research shows that excessive alerts cause users to disengage and miss genuinely critical information.

Working within these constraints — rather than fighting them — is the discipline of IM-native agent design.

## Task Status Patterns

### In-Place Message Update

The most powerful primitive for long-running task status is the ability to mutate an already-posted message rather than posting a new one. Slack's `chat.update` method, keyed by the original message's `ts` timestamp, allows a bot to transform a "starting..." card into a "done" card with no new messages. Microsoft Teams uses its own update-message API to replace an interactive Adaptive Card with a static summary after an approval decision is made. This single pattern eliminates an entire class of status flood.

The key design rule: **post once, update in place.** When a task begins, post a status card. Update that card as state changes. Never post a new top-level message unless the task has completed and deserves a fresh notification.

Implementation considerations: Slack's `chat.update` cannot update ephemeral messages (those visible only to one user) except in response to an interaction with the message itself. Teams enforces a timeout window — typically 10–15 seconds — for synchronous invoke responses; for tasks that take longer, the pattern is to immediately acknowledge the invoke, then push an out-of-band message update once the work is done. Discord's `deferReply()` method explicitly encodes this: calling it within three seconds of a slash command triggers a "bot is thinking..." placeholder, buying 15 minutes for the actual response.

### Threading for Task Context

Threading is the right container for task detail. When an agent starts a complex multi-step job, the initial message in the main channel should be a high-level status card. All intermediate steps, debug logs, and sub-task progress should go into a thread reply on that message. This keeps the main channel readable and places the detail where it belongs — accessible to anyone who wants to drill in, invisible to everyone else.

Slack's threading model (using the `thread_ts` parameter on `chat.postMessage`) is the canonical reference implementation. Discord's follow-up messages in the 15-minute interaction window serve a similar function. The pattern maps to a two-level hierarchy: surface summary in channel, full context in thread.

For COCO Workspace: create a "task thread" on first execution. Post all agent status updates, tool call results, and intermediate outputs as thread replies. Reserve the main-channel card for the final status only.

### Progress Cards

For tasks with known stages — research, then synthesis, then output — a step-based progress card communicates status without a word of prose. Each completed step shows a checkmark; the active step pulses. Research on AI agent UX consistently shows that step indicators outperform text descriptions for tasks with uncertain duration, because they give users directional confidence ("it's still moving forward") without requiring comprehension of technical details.

Lark/Feishu's streaming card implementation (used in agent bridges like the Feishu-Claude-Code connector) demonstrates this well: a card transitions through states — `Thinking`, `Generating`, `Complete` — with real-time updates visible to all participants in the conversation. WeChat Work's `template_card` type supports structured progress layouts with title, subtitle, emphasis areas, and horizontal content lists, sufficient to represent a four-to-six step task pipeline.

## Structured Data in Chat

### Rich Cards and Attachments

Every major IM platform now ships a card system designed to break out of plain text:

- **Slack Block Kit**: JSON-composed layouts with sections, buttons, images, overflow menus, date pickers, and (recently announced) native data tables with real-time update support.
- **Lark/Feishu Cards**: Component-based cards supporting buttons, images, column layouts, confirmation dialogs, and form inputs. Interactive cards can call back to the bot server, enabling stateful multi-step forms within a single card.
- **Microsoft Teams Adaptive Cards**: Cross-platform JSON card schema (also supported in Outlook and Windows) with rich input controls — text fields, dropdowns, date pickers — and action types including `Action.Execute` for inline updates without re-posting.
- **Discord Embeds**: Simpler than card systems — title, description, fields, thumbnail, color bar — but effective for structured summaries. Discord's newer Components v2 system supports buttons and select menus but cannot coexist with the legacy embeds API in the same message.
- **WeChat Work Template Cards**: `text_notice` and `news_notice` card types with source icons, main title, quote areas, and jump link lists. Webhook-based delivery means interactivity is limited to external link navigation.

The practical hierarchy for choosing a presentation format: if data is a single number or short phrase, use inline text. If data is a list, render it as a bulleted list within the card. If data is a key-value collection (like task metadata), use a card field layout. If data is tabular (multiple rows and columns), use a Block Kit section with a table block or a Lark card with a column-set component. Never use a Markdown table in chat — they render inconsistently across clients and break on mobile.

### Approval and Action Flows

One of the most valuable things a card can do in an IM context is capture a decision without requiring the user to leave the conversation. Teams has built an entire approval workflow product on this primitive: an Adaptive Card posts in chat with Approve and Reject buttons; clicking either calls `Action.Execute`, the card updates in-place to reflect the decision, and a Power Automate flow proceeds with the result.

Lark interactive cards support the same pattern, with the additional capability to open a multi-field form modal (via `multi_url` or inline form components) for cases where a simple binary decision is insufficient. This is appropriate for agent operations that need configuration before proceeding: "I found these three files. Which should I modify? Select and confirm."

Design guidance for approval cards:
1. State the action being requested clearly in the card header — not in prose preceding it.
2. Show the consequence: "Clicking Approve will deploy to production" not just "Approve".
3. Disable buttons after one click and update the card to show who acted and when. Cards that remain interactive after a decision create confusion in group channels.
4. For destructive operations, add a confirmation step within the card rather than a second message.

## Error and Recovery UX

Error handling is where most agent-in-chat implementations fall down. Common failure modes include: posting a raw exception traceback, repeating the same error message on every retry, or silently stopping with no indication of failure.

The correct pattern has three layers:

**Layer 1 — Immediate acknowledgment.** When an error occurs, update the status card immediately. Do not wait for retry attempts. Change the card state from "running" to "error" with a human-readable description of what failed and why it matters to the user, not what line of code threw an exception.

**Layer 2 — Recovery options.** Every error card should offer at least one action the user can take: retry the operation, modify the input, escalate to a human, or cancel. Research by chatbot UX analysts confirms that chatbot errors disrupt a majority of user conversations, and that the presence of clear exit routes significantly improves satisfaction scores. Users who are trapped in a failed flow with no recovery path disengage permanently.

**Layer 3 — Contextual explanation.** For errors that recur or stem from system limitations, provide a brief plain-language explanation. "I couldn't access the file — I don't have permission to read that directory" is actionable. "Error 403" is not.

Confidence signaling is a related pattern for non-error uncertainty: attach a visible indicator to agent outputs that reflects how confident the agent is in the result. High-confidence outputs proceed without interruption; low-confidence outputs display a flag and pause for user review before any consequential action is taken.

## Multi-Task Management in Chat

A single-channel workspace where one user interacts with an agent handles task status cleanly: one conversation, one task at a time. But real workspaces involve multiple users, multiple ongoing tasks, and agents operating autonomously on background schedules. The linear chat stream becomes inadequate.

Several strategies address this at the IM layer:

**Named task threads**: When a task starts, post a top-level message with a human-readable task name and ID. All updates go to that thread. Users can find and filter by task name.

**Task ID reference in all messages**: Every status update, output card, and error message should include a short task identifier (e.g., `[TASK-42]`) that lets users correlate messages across a scrolling conversation.

**Consolidated daily summary**: Rather than posting individual completion notices throughout the day, queue them and post a single "What happened today" digest at a fixed time. This is especially appropriate for background agent operations that do not require immediate attention.

**Dedicated task channels or group threads**: For long-running projects, create a dedicated thread or (on platforms that support it) a dedicated sub-channel for that project's agent activity. Slack's Canvas and Lark's Docs features integrate alongside the chat stream and can serve as persistent task status boards without requiring a separate application.

UIST 2025 research on "Morae: Proactively Pausing UI Agents for User Choices" highlights a key principle for multi-task environments: agents should not keep running past decision points when the user needs to be consulted. Pausing at checkpoints — and making those pauses visible in the chat — prevents runaway agent execution and keeps users in control without requiring them to monitor a separate dashboard.

## Message Flood Mitigation

The message flood problem is a primary failure mode for chatbot integrations. An agent that posts a message for each tool call, each intermediate result, and each completion event will make a channel unusable within days. Research on notification fatigue shows that users become desensitized to high-frequency notifications and miss genuinely important signals.

Five proven mitigations:

1. **Aggregate, don't stream.** Collect intermediate results and post a single summary card when a logical unit of work completes. If streaming is needed (e.g., code generation), stream into a single updating card, not a sequence of new messages.

2. **Use ephemeral messages for transient status.** Slack's `chat.postEphemeral` posts a message visible only to the invoking user and no one else. This is appropriate for "working on it..." indicators — they are useful in the moment and should not pollute the channel's persistent history.

3. **Prefer thread replies over top-level messages.** Intermediate output belongs in threads. Only task completion and errors requiring team attention belong at the top level.

4. **Respect quiet hours and batching windows.** Background agent tasks should not post completion notices at 3 AM. Queue non-urgent notifications and deliver them during working hours, or in a scheduled batch.

5. **Allow users to configure verbosity.** Provide at minimum a "verbose" and "summary" mode. Power users doing active debugging want fine-grained step output; busy managers want a single completion ping.

## Platform Design Comparison

| Capability | Slack | Lark/Feishu | Teams | Discord | WeChat Work |
|---|---|---|---|---|---|
| In-place message update | `chat.update` (ts) | Card patch API | Update message | Edit message / followup | Not natively supported |
| Interactive card callbacks | Block Kit Actions | Card callback URL | Adaptive Card `Action.Execute` | Component interactions (3s window) | External link only |
| Threading | Full threading | Thread replies | Reply chains | Forum channels / threads | Group mention only |
| Ephemeral messages | Yes (1 user) | Limited | No | Ephemeral slash responses | No |
| Native table rendering | Announced (2026) | Column-set layout | Adaptive Card table | Embeds + fields | Template card lists |
| Approval flow UX | Button + update | Button + modal | Power Automate native | Buttons + followup | External link |

## Design Principles for IM-Native Agent Interfaces

Building on the platform survey and UX research, seven principles emerge for agents that live entirely within a chat stream:

**1. One message per task, not one message per step.** Post a task card when work starts. Update that card as state changes. Thread the detail.

**2. Structure over prose for data.** When output has structure — a list, a key-value set, a table — render it as structure. Plain prose is the last resort for data, not the first.

**3. Every error card has an exit.** No user should ever be left facing an error message with no action to take. At minimum: a retry button and a cancel button.

**4. Confirmation before consequence.** Any card that triggers a write, deploy, delete, or send must require an explicit confirmation step within the card itself. Buttons that fire immediately without confirmation are not appropriate for consequential operations.

**5. Keep the main channel for signals, threads for noise.** The main channel is the signal bus. Threads are the debug log. Respect this distinction.

**6. Agent identity in every card.** In multi-agent workspaces, cards should clearly identify which agent produced them. This is critical for accountability and debugging.

**7. Design for the flood case first.** Before implementing happy-path messaging, design the notification strategy for sustained agent activity over hours and days. What does the channel look like after 100 tasks? That is the real test of whether the design scales.

## Conclusion

IM-native agent interaction is not a simplified version of a full UI — it is a distinct interaction paradigm with its own constraints and affordances. The platforms that have gone furthest (Lark's streaming cards, Teams' Adaptive Card approval flows, Slack's in-place Block Kit updates) share a common strategy: they accept the linear message stream as the ground truth and build rich, stateful, interactive primitives within that stream rather than escaping to separate applications.

For COCO Workspace and similar IM-first agent platforms, this means the core engineering investment is not in a separate dashboard but in making the card layer expressive enough to handle status, structured output, approval, and error recovery — and in establishing clear conventions around threading, update-in-place, and flood mitigation. When these primitives are in place, the chat stream becomes not a limitation but a feature: a persistent, searchable, shareable record of everything the agent did and every decision the user made.
