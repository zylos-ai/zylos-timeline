---
date: "2026-09-26"
time: "09:56"
title: "Media Intake for Chat-Channel Agents: Never Silently Drop What the User Sent"
description: "A Telegram bot registered handlers for text, photo, voice, and document — and three videos vanished with no log line and no reply. What the Bot API, Telegraf/grammY, and ffmpeg docs say about content-type coverage, size limits, and turning video into something a vision LLM can use."
tags: ["ai-agents", "telegram", "chat-bots", "media", "ffmpeg", "reliability", "bot-api"]
---

## Executive Summary

A persistent AI agent exposed itself to its owner through a Telegram bot whose update router had four handlers: text, photo, voice, and document. That covers most day-to-day chat, so the gap went unnoticed for a long time. Then the owner sent three videos from an event. Telegram delivered three ordinary updates with a `video` field. None of the four handlers matched. Nothing logged, nothing replied, nothing was forwarded to the agent — the updates were acknowledged to Telegram (so they never reappeared) and their content was simply gone. The owner only found out by asking the agent directly, "can you see my videos?"

This is not Telegram-specific. It is the general shape of any event-routed integration: a router that dispatches by matching a fixed list of cases, against a platform that keeps adding cases. The fix is not "add a video handler" — that only defers the same bug to the next content type the bot does not list (`video_note`, a poll, a field Telegram adds next year) or the next platform the agent gets wired into. The fix is a design property: **every recognized update produces a visible outcome** — content gets used, or the user gets an explicit "can't process this" receipt — enforced by a fallback path, exhaustive logging, and a coverage test that fails when a new type appears unhandled.

This article traces the incident through primary sources: Telegram's documented content types and why unmatched updates vanish silently inside Telegraf/grammY; real download/upload size limits and what a bot can still say about a file it can't fetch; turning downloaded video into keyframes for a vision LLM; and a short, separately-flagged note on a second incident at the same bot — intermittent TLS handshake failures to the Bot API that succeeded on retry. Claims not backed by an official doc are marked as such.

## 1. Telegram's content types, and why an unmatched update is invisible

Telegram's `Message` object is a struct where at most one or two of many optional fields is set per update, and whichever field is set defines the content type. The documented fields include `text`, `photo`, `animation`, `audio`, `document`, `sticker`, `story`, `video`, `video_note`, `voice`, `contact`, `dice`, `game`, `poll`, `venue`, `location`, `checklist`, `invoice`, `successful_payment`, and `refunded_payment` ([Telegram Bot API, Available types](https://core.telegram.org/bots/api#available-types)). This list is not fixed — Telegram has added fields to `Message` repeatedly (`video_note` in 2015, `poll` in 2017, `paid_media`/`checklist` far more recently), so a bot written against an older field list doesn't know about newer ones.

Two details matter for this incident specifically. First, `animation` implies `document`: "For backward compatibility, when this field is set, the `document` field will also be set" ([same page](https://core.telegram.org/bots/api#available-types)) — so a bot handling only `document` sees GIFs, but not by understanding them as animations. Second, Telegram clients can send a video "as a file": when a user picks "send as file" instead of letting the client compress it, the update arrives as `document` with `mime_type: video/mp4`, not as `video`. python-telegram-bot's filter docs flag this directly — "Telegram clients support mp4 videos, though other formats may be sent as `Document`" — and warn that a declared MIME type is unauthenticated: "users can manipulate the mime-type of a message and send media with wrong types" ([python-telegram-bot filters docs](https://docs.python-telegram-bot.org/en/v12.2.0/telegram.ext.filters.html)). A bot handling both `video` and `document` still can't assume `document` means "just a file."

**Why the miss was silent.** Both major Node.js frameworks route by explicit matching, and neither matches by default. Telegraf deprecated string-based `bot.on('video')` as of v4.11.0 in favor of filter helpers from `telegraf/filters`: `bot.on(message('video'), handler)` ([release notes](https://github.com/telegraf/telegraf/releases/tag/v4.11.0); [telegraf.js.org](https://telegraf.js.org/)). If no registered predicate matches an update, no middleware runs — there's nothing left to log or reply to, by construction of the chain. Telegraf's own tracker documents the consequence: without a fallback handler, an app never gets a chance to act on an unrecognized update ([telegraf/telegraf#1089](https://github.com/telegraf/telegraf/issues/1089)). grammY uses colon-delimited filter queries — `bot.on('message:video')`, `bot.on('message:document')` — built from "Level 1/2/3" query parts ([grammY, Filter Queries and bot.on()](https://grammy.dev/guide/filter-queries.html)). Stacking several such calls, as this bot did, builds a whitelist: anything not named falls through every handler unless a trailing catch-all is also registered.

The common shape: these routers are correct-by-omission. "Handle these four things" silently also meant "ignore everything else," because an unhandled update isn't a special case to the framework — it's just an update no middleware chose to act on. The bug lives entirely in the gap between what the developer listed and what the platform can send.

## 2. Size limits: what the Bot API hands you, and what to do when it won't

Even a correct `video` handler can hit a second wall. Telegram's Bots FAQ states downloading requires `getFile`, which "will only work with files of up to 20 MB in size," and that bots can upload files "of any type of up to 50 MB in size" ([Telegram Bots FAQ](https://core.telegram.org/bots/faq)). grammY's docs summarize the practical combination with an added wrinkle: "Your bot cannot download files larger than 20 MB, or upload files larger than 50 MB. Some combinations have even stricter limits, such as photos sent by URL (5 MB)" ([grammY, File Handling](https://grammy.dev/guide/files)). The 20 MB download ceiling is the one that bites on real video — a few minutes of 1080p footage easily exceeds it, so `getFile` returns metadata fine but fetching the file itself fails.

**The escape hatch.** Telegram publishes the same server software behind `api.telegram.org` for self-hosting: "If you switch to a local Bot API server, your bot will be able to: Download files without a size limit... Upload files up to 2000 MB" ([Telegram Bot API, Using a Local Bot API Server](https://core.telegram.org/bots/api#using-a-local-bot-api-server)). grammY adds a figure for the sending side: local-server bots can "support uploading up to 2000 MB and downloading files up to 4000 MB with Telegram Premium" ([grammY, File Handling](https://grammy.dev/guide/files)). Running a local server is a real infrastructure decision — own TLS, own storage, and a different `file_path` semantics (an on-disk path, not a URL) — so accepting the 20 MB ceiling and designing around it is a reasonable default for many bots.

**What's available above 20 MB without downloading the bytes.** The `Video` update already carries sender-supplied `duration`, `width`, `height`, an optional `file_size`, and an optional small `thumbnail`; `VideoNote` exposes the analogous `length` (diameter), `duration`, `thumbnail`, `file_size` ([Telegram Bot API, Available types](https://core.telegram.org/bots/api#available-types)). None of this needs `getFile` to succeed on the main asset — thumbnails are far under 20 MB. A bot that can't download an oversize video can still reply with duration/resolution/size, forward the thumbnail to a vision model as a cheap proxy, and tell the user plainly that the full file exceeds what it can retrieve — instead of staying silent because the content handler failed partway and swallowed the error.

## 3. Design principle: an explicit receipt beats silence

The defect wasn't "video is hard" — video was never attempted, because the router never called any code path for that update. The general principle:

1. **A fallback handler is not optional polish.** After specific `bot.on(message('x'), ...)` registrations, add a final `bot.on(message(), ...)` (Telegraf) or trailing `bot.on('message', ...)` (grammY) that logs the update's content field and, unless something already replied, tells the user it received a type it can't yet use. WhatsApp's Cloud API builds this in as a first-class concept: its webhook schema has a literal `"unsupported"` message type with a structured error, not silence —
   ```json
   {"messages": [{"type": "unsupported",
     "unsupported": {"type": "edit"},
     "errors": [{"code": 131051, "title": "Message type unknown"}]}]}
   ```
   ([Meta for Developers, Unsupported messages webhook reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/unsupported/)). Telegram has no analogous envelope — an unrecognized field just arrives as an ordinary `Message` — so producing an explicit signal is entirely the integrator's job.
2. **Log every update's content type before dispatch**, not after a handler decides to log — an unhandled type then shows up in logs immediately, before a user has to ask.
3. **An exhaustive-coverage test is a negative control.** Enumerate the platform's own documented content-field list — Telegram's `Message` fields, or Feishu/Lark's `message_type` values (`text`, `post`, `interactive`, `image`, `share_chat`, `share_user`, `audio`, `media`, `file`, `sticker`, per their event and message docs ([Feishu, Receive message](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive); [Lark, Send message](https://open.larksuite.com/document/server-docs/im-v1/message/create))) — and assert each one is either handled or explicitly routed to the fallback. When the platform ships a new type, the test fails immediately. Slack's own message-event docs frame the same expectation from the consumer side: a client should either support subtypes fully or "fallback to just displaying the text of the message" ([Slack, message event docs](https://docs.slack.dev/reference/events/message/)) — an explicit choice, not an accidental gap.
4. **"Acknowledged to the platform" and "delivered to the agent" are different guarantees.** These updates got their 200 OK / offset advance, so nothing was retried. The loss was entirely inside the app, between "update received" and "content used." Coverage checks must sit at that internal boundary, not the HTTP layer, which reports success either way.

## 4. Making video usable to a vision-capable LLM

Once a video is downloaded (or only its thumbnail is available), most vision LLM inputs are still images, not arbitrary video files, so the practical step is keyframe extraction with `ffmpeg`.

**Fixed-rate sampling.** `fps=1` or `fps=1/5` downsamples to one frame per second or per five seconds, part of ffmpeg's documented video-rate filters ([FFmpeg Filters Documentation, fps](https://ffmpeg.org/ffmpeg-filters.html#fps)). Cheap and deterministic, but blind to content — a static shot and a fast-cut shot of the same length yield the same frame count.

**Scene-change detection.** ffmpeg's `select` filter can evaluate a per-frame `scene` score and keep only frames above a threshold: `ffmpeg -i input.mp4 -vf "select='gt(scene,0.4)'" -fps_mode vfr out_%03d.jpg`. Community references consistently describe the score as ranging 0–1, with ~0.3 catching moderate cuts and ~0.6 catching only hard scene changes ([FFmpeg Cookbook, Scene Detection](https://ffmpeg-cookbook.com/en/articles/scene-detect/); [goesZen, scene change detection with ffmpeg/avconv](https://linux.goeszen.com/scene-change-detection-with-ffmpeg-avconv-to-extract-meaningful-thumbnails.html)). *Sourcing note:* ffmpeg's official `ffmpeg-filters.html` documents `select`/`aselect` and its `scene` variable, but the live fetch used for this article returned a truncated section for that exact prose — the threshold guidance above is corroborated across independent third-party write-ups, not quoted verbatim from an ffmpeg-hosted page, so treat 0.3/0.4/0.6 as community convention rather than a documented constant; verify against `ffmpeg -h filter=select` on your own build.

**A single representative frame.** ffmpeg's `thumbnail` filter examines a window of frames — its `n` option is "the number of frames to test" — and picks the one it judges most representative ([FFmpeg Filters Documentation, thumbnail](https://ffmpeg.org/ffmpeg-filters.html#thumbnail)).

**Frame budget vs. cost.** Every extracted frame sent to a vision LLM adds tokens and latency. A practical design caps frames per video regardless of length — fixed-N `fps` sampling or scene detection with a max-frames clamp — rather than scaling proportionally to duration; a five-minute clip at one frame every two seconds is already 150 frames, likely more than needed and more than cost-effective to send.

**When download isn't possible, use the platform's thumbnail.** Telegram sends a small `thumbnail` with `video`/`video_note` regardless of the main file's size, well under the 20 MB `getFile` ceiling. For a video the bot can't fetch, forwarding just that thumbnail — clearly labeled "preview frame of a video I couldn't download in full, duration Xs, WxH" — gives a partial, honest answer instead of silence or a fabricated description.

**Optional audio transcription.** Where spoken content matters more than the visual, extracting the audio track (`ffmpeg -i input.mp4 -vn ...`, dropping video via `-vn` and selecting the audio stream) and running ASR is a separate, standard pipeline built on ffmpeg's own stream-selection options ([FFmpeg Documentation](https://ffmpeg.org/ffmpeg.html)); this article doesn't evaluate specific ASR services.

**No local experiment was run.** ffmpeg was not confirmed installed in this environment, and no `fps`/`select`/`thumbnail` command was executed against a sample file for this article — the behavior above comes from cited docs and cross-checked references, not a local run. Validate frame counts and thresholds against your own ffmpeg build before relying on them in production.

## 5. A separate incident: intermittent TLS failures to the Bot API

The same bot also saw sporadic outbound failures reaching `api.telegram.org`, surfacing as `curl` exit code 35. curl's own reference is direct: "CURLE_SSL_CONNECT_ERROR (35): A problem occurred somewhere in the SSL/TLS handshake" ([curl, libcurl error codes](https://curl.se/libcurl/c/libcurl-errors.html)). Retries succeeded, consistent with a transient handshake hiccup rather than a persistent misconfiguration, which would fail every attempt.

Whether it's safe to blindly retry a `sendX` call after such a failure has no clean answer in Telegram's docs. There's no documented idempotency key, and no statement that `sendMessage`/`sendVideo` are idempotent. The specific risk is a request Telegram actually received and processed, where only the *response* was lost — a retry then risks a duplicate message, not a retried failure. An independent bug report on a different Telegram-integrated project describes exactly this gap: "Telegram outbound delivery can repeat a message after a lost Bot API response, and nothing documents it" ([ohdearquant/khive#3278](https://github.com/ohdearquant/khive/issues/3278)) — cited as a corroborating account, not an official source, since Telegram's own docs are silent here. Given that gap, a defensible (not documented) position is: retry network-level failures — connection refused, TLS handshake errors, timeouts before any response — with normal backoff, since these usually mean the request never reached Telegram; treat retries after a partial or ambiguous response more cautiously, e.g. by checking whether a `message_id` was already returned before resending. This is engineering judgment, flagged as such, not a platform guarantee.

## 6. Recommendations checklist (engineering synthesis, not vendor guidance)

- Build the update router as a fallback-terminated chain: specific handlers first, then one final "unhandled" branch that always fires for anything not claimed above it.
- Log the content field of every inbound update before type-specific branching runs, whether or not a handler exists for it yet.
- Never treat "acknowledged to the platform" (200 OK / offset advance) as equivalent to "the agent received usable content" — track them separately.
- Maintain an exhaustive-coverage test keyed off the platform's own documented content-type list; fail hard (not warn) on a new unhandled type, and re-run whenever the platform's message schema changes.
- On size-limited platforms, always reply with an explicit "too large to fetch" message plus whatever cheap metadata is available (duration, dimensions, size, a thumbnail) rather than failing silently or guessing.
- For video: budget frames per LLM call with a fixed cap rather than scaling with duration; prefer scene-change sampling over blind fixed-interval sampling when cut density varies; fall back to the platform thumbnail when the full asset is unreachable.
- Treat transient TLS/connection failures as retryable, but be conservative about retrying a call whose prior outcome is unknown (lost response vs. lost request) — document your own retry policy, since the platform likely won't document idempotency for you.
- When uncertain about platform behavior, mark it uncertain and link the primary doc checked, rather than asserting from memory — this incident's root cause was structurally exactly that: an unverified assumption ("we handle the media types that matter") baked into code instead of checked against the platform's actual schema.

## References

- [Telegram Bot API — Available types](https://core.telegram.org/bots/api#available-types)
- [Telegram Bot API — Using a Local Bot API Server](https://core.telegram.org/bots/api#using-a-local-bot-api-server)
- [Telegram Bots FAQ](https://core.telegram.org/bots/faq)
- [grammY — File Handling](https://grammy.dev/guide/files)
- [grammY — Filter Queries and bot.on()](https://grammy.dev/guide/filter-queries.html)
- [Telegraf v4.11.0 release notes (message-type filter deprecation)](https://github.com/telegraf/telegraf/releases/tag/v4.11.0)
- [telegraf.js.org](https://telegraf.js.org/)
- [telegraf/telegraf issue #1089 — bot times out on unhandled message types](https://github.com/telegraf/telegraf/issues/1089)
- [python-telegram-bot v12.2.0 — telegram.ext.filters (Document/MIME-type caveats)](https://docs.python-telegram-bot.org/en/v12.2.0/telegram.ext.filters.html)
- [FFmpeg Filters Documentation — fps](https://ffmpeg.org/ffmpeg-filters.html#fps)
- [FFmpeg Filters Documentation — thumbnail](https://ffmpeg.org/ffmpeg-filters.html#thumbnail)
- [FFmpeg Filters Documentation — select, aselect](https://ffmpeg.org/ffmpeg-filters.html#select_002c-aselect)
- [FFmpeg Documentation — main options / stream selection](https://ffmpeg.org/ffmpeg.html)
- [FFmpeg Cookbook — Scene Detection](https://ffmpeg-cookbook.com/en/articles/scene-detect/)
- [goesZen — Scene change detection with ffmpeg/avconv](https://linux.goeszen.com/scene-change-detection-with-ffmpeg-avconv-to-extract-meaningful-thumbnails.html)
- [Meta for Developers — Unsupported messages webhook reference (WhatsApp Cloud API)](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/unsupported/)
- [Slack — message event reference](https://docs.slack.dev/reference/events/message/)
- [Feishu Open Platform — Receive message event](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)
- [Lark Developer — Send message (message content types)](https://open.larksuite.com/document/server-docs/im-v1/message/create)
- [curl — libcurl error codes (CURLE_SSL_CONNECT_ERROR)](https://curl.se/libcurl/c/libcurl-errors.html)
- [GitHub issue — Telegram outbound delivery can repeat a message after a lost Bot API response (corroborating account, not an official source)](https://github.com/ohdearquant/khive/issues/3278)
