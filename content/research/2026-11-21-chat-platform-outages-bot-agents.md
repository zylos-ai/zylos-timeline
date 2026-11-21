---
date: "2026-11-21"
title: "When the Chat Platform Goes Dark: Riding Out Bot API Outages Without Losing or Duplicating Messages"
description: "How a long-running AI agent that talks to people through Telegram, Slack, Discord, Lark/Feishu or WhatsApp bot APIs should classify an upstream outage, keep inbound and outbound messages safe, and tell people what happened afterwards."
tags:
  - research
  - ai-agents
  - telegram
  - slack
  - discord
  - reliability
  - idempotency
  - webhooks
---

## Executive Summary

An agent's Telegram bot API calls failed for about two hours overnight, then recovered. The agent noticed through a different owner channel. Afterwards it told the owner: "the bot API is answering again; if you sent anything during the outage window and got no reply, please send it again." This article asks what the bot should have done better, inbound and outbound, checked against primary platform documentation.

Conclusions:

1. **The "please resend" notice was probably unnecessary for inbound messages.** Telegram documents that updates are "stored on the server until the bot receives them either way, but they will not be kept longer than 24 hours." Two hours is well inside that. A polling loop that resumed from its last confirmed offset should have received the backlog. The notice was justified only if the bot drops stale updates, the gap exceeded the retention window, or the lost part was the bot's replies. The last is the likeliest, and the bot should have known which case applied.
2. **Build the notice from the bot's own records.** A bot with a durable inbox and outbox can say "I received 2 messages from you in that window and have now answered them" or "I have no record of anything from you in that window." Both are true and actionable.
3. **Do not mislabel the failure.** Local network trouble, a platform outage, a per-bot backend failure, a revoked token, a rate limit and a plain 5xx need different reactions. Public GitHub reports from November 2026 describe Telegram failures that hit individual bot IDs while other bots on the same hosts worked, and where rotating the token did not help.
4. **Outbound is the hard side.** Telegram's Bot API page documents no idempotency key. Discord has an optional `nonce`, Lark a `uuid` with a one-hour window; I found none for Slack or WhatsApp. After a timed-out send the state is unknown, and the outbox must record "unknown," not "failed."
5. **Alerting must not depend on the broken channel.** Noticing through another channel was luck. A dead-man switch, a canary, and an alert route that never equals the failing channel make it deliberate.
6. **Stale messages need a policy.** A two-hour-old "are you there?" deserves one coalesced answer. A two-hour-old "deploy now" should be confirmed, not executed.

Section 7 turns this into a checklist for a small self-hosted agent. "What I could not confirm" lists the claims I could not verify.

## 1. Telling apart failure kinds

The first job during an outage is classification. A wrong label causes a wrong action: rotating a healthy token, retrying a revoked one forever, or announcing "Telegram is down" when a local proxy is at fault.

| Kind | Typical signal | Right reaction |
|---|---|---|
| Local network or proxy | No platform response: DNS, connect or TLS error, silent timeout, or a non-JSON error page from your own proxy | Probe a second network path. Back off. Do not rotate credentials |
| Platform-wide outage | 5xx or hangs for many tokens or bots | Check status page and a canary. Keep inbox and outbox durable. Wait |
| Per-bot backend failure | Valid token fails or hangs while other tokens work from the same host | As above. Do not rotate the token first. Report it |
| Token revoked | HTTP 401 (Telegram, Discord) or a documented auth error (WhatsApp error code 0) | Stop retrying. Alert through another channel |
| Rate limiting | HTTP 429 with a wait value | Wait exactly as told, then slow down |
| 5xx | 500, 502, 503, 504 | Backoff with jitter and a cap |

### 1.1 Telegram signals

The Bot API page says responses are JSON with a Boolean `ok`. On failure `ok` is false and `description` explains it. "An Integer 'error_code' field is also returned, but its contents are subject to change in the future." Some errors carry `parameters` ("which can help to automatically handle the error"), including `retry_after`: "In case of exceeding flood control, the number of seconds left to wait before the request can be repeated."

Two consequences. A JSON reply from `api.telegram.org` means your network path to Telegram works; one issue reporter reasoned the same way ("so the network path to Telegram works"). HTML, an empty body or a connection error points at your side. And branch on HTTP status and `ok`, keeping `error_code` for logs, since the docs say it may change.

### 1.2 A November 2026 failure pattern: per-bot backends

Several issues on the public `tdlib/telegram-bot-api` tracker, opened in November 2026, match the motivating incident closely. They are user reports, not Telegram statements, and the ones I read were closed by a maintainer with no explanatory comment in the issue text. Common features:

- Every Cloud Bot API method for one bot ID hangs or returns `{"ok":false,"error_code":502,"description":"Bad Gateway"}`, typically after about 15 seconds (#916 opened 2026-11-03; #963 on 2026-11-14).
- Other bots of the same owners answered `getMe` in a fraction of a second from the same hosts, and independent networks reproduced the failure.
- Revoking the token in BotFather and issuing a new one did not help (#916, #1015, #1026).
- A control probe recurs: a request with a deliberately wrong secret but the affected bot ID also hangs or returns 502, while a wrong secret with a different bot ID returns 401 within a second or two. Reporters conclude the request is stuck on the backend serving that bot ID. That is their inference.
- Duration varied. #1025 reports about four days of continuous 502 that cleared with no change on the reporter's side. #1001 reports a recurring 2 to 5 minute window around 01:12 UTC each night, with 502 and then 504 after exactly 120 seconds.
- #938 reports `getWebhookInfo` answering a few times with `pending_update_count` between 45,000 and 100,000, then 429 "retry after 5," then 502 on everything. A 429 can appear as a symptom inside an outage and must still be honored.
- One commenter on #916 wrote that "incoming webhook updates still arrive" while API calls failed. One report only, but a reminder that inbound and outbound can fail independently.

I cannot say whether the motivating incident was part of this pattern.

### 1.3 A probe ladder

An ordered, cheap probe sequence avoids mislabeling. Thresholds are my suggestions.

1. Any HTTP response at all? If not, the failure is below HTTP: DNS, TCP, TLS or proxy.
2. Is the response platform-formatted (Telegram JSON with `ok`, Slack or Discord JSON)? Then you reached the platform.
3. Try a second network path (bypass the local proxy, or use another host). If it works and the first does not, the problem is local.
4. Call `getMe`, which the docs call "a simple method for testing your bot's authentication token." Success means the token is valid and the backend answers. 401 means a bad token. A hang or 502 means platform side.
5. Call `getMe` with an unrelated canary bot token you own. Canary works and your bot fails: suspect a per-bot failure. Both fail: platform-wide or local. Use deliberately invalid tokens sparingly. Discord documents that 401, 403 and 429 responses count as invalid requests, and that an IP making 10,000 in 10 minutes is temporarily restricted. I found no Telegram equivalent.
6. Read the status page if one exists (section 5). A per-bot failure will likely not appear on it.

### 1.4 Other platforms

Slack returns 429 with a `Retry-After` header, scoped per method and workspace ("Calls to other methods on behalf of this workspace are not restricted"). Discord returns 429 with JSON `retry_after` and a `global` boolean, and says to "rely on the Retry-After header or retry_after field." WhatsApp error 130429 means "Cloud API message throughput has been reached," and authorization error 0 typically means the token "has expired, been invalidated." Lark limits send-message to 50 per second for the API and 5 per second per user.

When the platform says how long to wait, believe it. Jittered backoff is for cases where it does not (5xx, timeouts). The AWS Architecture Blog reports that un-jittered exponential backoff does worse than jittered variants, and that "Full Jitter" and "Equal Jitter" use about the same number of calls.

## 2. Inbound during the outage

### 2.1 Telegram long polling

The two ways to receive updates are mutually exclusive. For both, "Incoming updates are stored on the server until the bot receives them either way, but they will not be kept longer than 24 hours."

For `getUpdates`:

- `offset` "must be greater by one than the highest among the identifiers of previously received updates." By default, "updates starting with the earliest unconfirmed update are returned."
- "An update is considered confirmed as soon as getUpdates is called with an offset higher than its update_id."
- A negative offset retrieves from the end of the queue, and "all previous updates will be forgotten."
- `limit` is 1 to 100; the FAQ says the method returns "the earliest 100 unconfirmed updates."
- "In order to avoid getting duplicate updates, recalculate offset after each server response."

Confirmation happens on the next call, so a crash after receiving a batch causes redelivery. It also means the bot controls the loss window. Two patterns lose messages: advancing the offset while the previous batch exists only in memory, and using a negative offset or any "skip to latest" shortcut after an outage, which silently forgets everything before it. With neither, a two-hour outage is survivable without user action: the bot resumes from its last offset and drains the backlog, 100 per call. The retention limit that matters is 24 hours.

One subtlety: "If there are no new updates for at least a week, then identifier of the next update will be chosen randomly instead of sequentially." A rule like "ignore anything not above the highest id seen" can therefore discard fresh updates after a quiet week (my inference). Prefer a bounded set of recent ids.

### 2.2 Telegram webhooks

With a webhook Telegram POSTs each update. On failure, "we will repeat the request and give up after a reasonable amount of attempts." The attempt count and schedule are not documented on the page I read. `getWebhookInfo` returns `pending_update_count` ("Number of updates awaiting delivery"), `last_error_date` and `last_error_message`, the best diagnostics for whether Telegram is trying to reach you and failing. If Telegram is the broken side, your server sees nothing. While a webhook is set, "it's not possible to get updates via long polling."

Two traps. `setWebhook` has `drop_pending_updates` ("Pass True to drop all pending updates"). A startup script that sets it erases the backlog on every restart. And if the bot replies inside the webhook response, "it's not possible to know that such a request was successful or get its result," so important sends should use a separate API call from an outbox.

### 2.3 Other platforms

| Platform | What the docs say about missed events |
|---|---|
| Slack Events API (HTTP) | Respond 2xx "within three seconds." After failure, "we'll retry three times, backing off exponentially": nearly immediately, after 1 minute, after 5 minutes. Opt-in "Delayed Events" adds hourly retries for 24 hours. "The Events API is a best-effort system." By default Slack will not "attempt to deliver an event that is more than two hours late." |
| Slack Socket Mode | Events carry an `envelope_id` to acknowledge "so that Slack knows whether to retry." Retention across a disconnect is not stated |
| Discord Gateway | If you Resume in time, "the Gateway will send the missed events in order, finishing with a Resumed event." If you do not reconnect in time you get Invalid Session, "your app should disconnect" and re-Identify, with no replay described. The time window is not stated in the section I read |
| Lark/Feishu | Respond 200 "within 3 seconds." Retries "at intervals of 15 seconds, 5 minutes, 1 hour, and 6 hours, with a maximum of 4 retries." Deduplicate by `event_id` (v2.0) or `uuid` (v1.0) |
| WhatsApp Cloud API | On non-200 or other failure, "Meta retries delivery with decreasing frequency until the request succeeds, for up to 7 days." "These retries can result in duplicate webhook notifications." |

Points to draw out:

- **Retention differs by orders of magnitude.** Telegram: up to 24 hours. Slack HTTP: minutes by default, 24 hours with the opt-in. Lark: about 7 hours (15 s + 5 min + 1 h + 6 h). WhatsApp: up to 7 days. Discord: a short, unspecified resume window. One "please resend" rule across channels would be wrong for most of them.
- **Slack's two-hour default sits right at a two-hour outage.** Events may not be redelivered unless Delayed Events was enabled beforehand.
- **Meta's generic webhooks differ.** Its "Get started with webhooks" page says unacknowledged responses "will be dropped after 36 hours," while the WhatsApp page says up to 7 days. I found no explanation.
- **An open issue shows the cost of ignoring this.** A community issue in `TencentCloud/octop-gateway` (opened 2026-11-04) reports a Feishu deployment re-answering hours-old questions. Duplicates clustered at +1h05m and +7h05m, matching the documented schedule. In-memory dedupe was wiped by restarts, and the message's own age was never checked. Each redelivery caused a full model run and a duplicate reply. I did not verify the issue independently.

### 2.4 Was "please resend" necessary?

My inference for the motivating incident:

- Long polling that resumed from its last confirmed offset: the messages should be redelivered, and a resend request invites duplicates.
- Bot skipped to latest, dropped stale updates, or advanced the offset before durable storage: the bot lost messages by its own policy. Remove that loss.
- Replies failed because the API was unreachable for its token (the likelier case): the user need not resend. The bot needs to send.
- Gap beyond 24 hours, or a webhook receiver down past the sender's retry window: resend is justified, for a precisely named window.

## 3. Duplicates and ordering after recovery

### 3.1 Idempotency by platform identifier

Telegram gives `update_id`, handy "to ignore repeated updates." Slack gives `event_id`, "globally unique across all workspaces." Lark gives `event_id` (v2.0) or `uuid` (v1.0) and recommends "idempotency logic for all messages," since duplicates can arrive "even when the event is successfully received." WhatsApp warns of duplicates but names no dedupe field; its payload `id` (a `wamid.` value) is a natural key by my inference, as are Discord message ids.

Write the id to durable storage in the same transaction as the intake record, under a uniqueness constraint, and treat a conflict as "duplicate, skip." Keep dedupe state in the store, not in memory, as the Feishu issue shows.

### 3.2 Persist the offset only after durable intake

For Telegram long polling:

1. Call `getUpdates(offset=N)`.
2. In one transaction, insert every update into the inbox by `update_id` (ignore conflicts) and store `N' = max(update_id) + 1`.
3. Commit, then start handling, and use `N'` on the next call.

A crash before step 3 yields redelivery, which the unique key absorbs. A crash after it is safe because unprocessed inbox rows are picked up on start. For webhooks: write to the inbox, then return 200. Slack states the principle: "implement a queue to handle inbound events after they are received." A slow model call in the handler makes Slack retry, which creates duplicates.

### 3.3 The backlog burst

Telegram gives 100 updates per call, and #938 reports a pending count of 45,000 to 100,000 for a busy group bot. Answering every item as new hits reply limits (Telegram's FAQ: "In a single chat, avoid sending more than one message per second," in a group "not … more than 20 messages per minute"; Slack warns that in bursts "there is no guarantee that messages will be stored or displayed to users"), costs a model call per message, and reads as noise.

My suggested rule: group the backlog by chat, process in `update_id` order, and send one reply per chat that acknowledges the window and answers the content. Handle individually only explicit action requests.

### 3.4 Stale messages

Telegram's `Message.date` is the "date the message was sent in Unix time." Slack has `event_time`, and the Feishu issue suggests the message's `create_time`. Compute age at handling time and apply a policy:

| Message kind | Stale (older than your threshold) |
|---|---|
| Social ("are you there?") | One short combined reply that mentions the delay |
| Question | Answer, and say it was received at the original time |
| Side-effect request ("restart X", "send this") | Do not run silently. Echo the request and timestamp and ask for a yes |

The threshold is policy, and I know no documented number; decide it before the outage. Also tell the model the outage window, or it may answer "what's the status?" from pre-outage information.

## 4. Outbound during the outage

### 4.1 Durable outbox and retries

Anything the agent wants to send goes first into an outbox table, then to the API. This is the standard transactional-outbox pattern, my recommendation, not a platform requirement.

- **429:** wait the platform's value (Telegram `retry_after`, Slack `Retry-After`, Discord `Retry-After` or `retry_after`).
- **5xx, timeouts, connection errors:** exponential backoff with full jitter and a cap.
- **401:** stop and alert through another channel. On Discord this also protects your IP (section 1.3).

### 4.2 Expiry per message

A reminder due at 03:00 and delivered at 05:10 is not late, it is wrong. Each row needs a deadline after which sending is worse than not sending. My suggestions: user replies keep for hours and say they are delayed; time-bound reminders expire when useless and are listed in the recovery notice; progress edits keep only the latest per target.

WhatsApp has a platform-side expiry you cannot configure. Free-form service messages go only "during a customer service window," a 24-hour timer that starts when the user messages you, and "when the window closes, you can only send pre-approved template messages." A reply queued across a long outage may become unsendable as free text. I found no similar rule for Slack, Discord, Telegram or Lark.

### 4.3 Unknown versus failed

A **failed** send is one where you know the platform did not accept the message: a clear 4xx rejection or a connection failure before the request was written. An **unknown** send is one where the request went out and the response was lost: a client timeout, a reset after the body, or a gateway 5xx.

For unknown sends, retrying risks a duplicate and not retrying risks a loss. Slack's `chat.postMessage` error table says of `internal_error` and `fatal_error` that "it's possible some aspect of the operation succeeded before the error was raised." RFC 9110 says a client "SHOULD NOT automatically retry a request with a non-idempotent method" unless it can know the semantics are idempotent or "detect that the original request was never applied."

### 4.4 Avoiding duplicates when you cannot tell

| Platform | Idempotency for sending, from the pages I read |
|---|---|
| Telegram | None documented; the Bot API page has no "idempot" at all. `sendMessage` returns the sent `Message`. I found no method that reads chat history, so you cannot ask whether an earlier send landed |
| Slack | None in the `chat.postMessage` page. `client_msg_id` appears only inside two error names, and I could not tell what mechanism they belong to |
| Discord | Partial. `nonce` (up to 25 characters) with `enforce_nonce: true` is "checked for uniqueness in the past few minutes. If another message was created by the same author with the same nonce, that message will be returned and no new message will be created." It covers fast retries, not retries after a two-hour outage |
| Lark/Feishu | Yes. The `uuid` field: requests with the same uuid send at most one message within 1 hour (my translation of the Chinese text), max 50 characters |
| WhatsApp Cloud API | None found in the send, messages-reference and error-code pages I fetched |

For Telegram, an unknown outcome leaves trade-offs: at-most-once for low-value messages (mark `unknown`, do not resend); at-least-once for important ones (resend, accept a possible duplicate, and make the repeat recognizable with a short reminder id); and edits instead of new sends for status, since an edit ends in the same state however often it repeats (I did not check how Telegram treats an edit that changes nothing, so test it). Whichever you choose, keep `unknown` as its own state, because the notice needs to say "I tried to answer you at 03:12 and do not know whether it arrived."

## 5. Detection and alerting when the alert channel is the broken one

**Route alerts away from the failing channel.** The agent in the incident was noticed through another owner channel. Make that a rule: the alert for "channel X is failing" must not go through X, and must not queue behind it. With a single channel, use an out-of-band route such as email or a separate push app.

**Measure the round trip, not the process.** In the November 2026 reports the bot processes were healthy; one reporter wrote that "the application and database are operational, but no new updates are received." Watch the age of the last successful `getUpdates` return (empty ones count), the last successful send, and a periodic `getMe` canary.

**Use a dead-man switch.** A broken system may not manage to report that it is broken, so invert the logic: it reports that it is fine, and silence raises the alarm. Healthchecks.io documents the pattern: it "keeps silent as long as pings arrive on time. It raises an alert as soon as a ping does not arrive on time," with a configurable "Grace Time." The agent pings only after a full cycle of receive, record and send-probe succeeds. This is an example of the pattern, not a product recommendation.

**Status pages.** Discord has `discordstatus.com` (its JSON endpoint returned "All Systems Operational" when I called it). Slack's `slack-status.com/api/v2.0.0/current` returned `status: ok` with no active incidents. `metastatus.com` covers Meta business products including the WhatsApp Business API, per its own description. Lark has `status.larksuite.com`. I found no official Telegram status page; the FAQ points to "@BotSupport." These show platform-wide incidents only, and the reports in section 1.2 describe single bot IDs while others worked, so a green page does not rule out a problem (inference).

## 6. Communicating with users after recovery

### 6.1 What a good notice contains

1. **The window,** with a time zone.
2. **What was received and what was done,** from your inbox.
3. **What was not processed and why:** expired items, stale requests awaiting confirmation, sends of unknown status.
4. **What the user should do,** often nothing. If a resend is needed, name the unrecoverable range.
5. **One sentence of cause, only if known.** Do not claim "Telegram was down" if you only know your bot's calls failed.

Example when records exist:

> My messaging connection was unavailable from 02:05 to 04:10 SGT. I received two messages from you during that time (02:40 and 03:15) and have now answered both. One 03:00 reminder was not sent because it was no longer useful. Nothing needs to be resent.

When the inbox shows nothing: "I have no record of any message from you in that period. If you sent something then, it did not reach me, so please send it again." That wording is justified only after checking the inbox.

### 6.2 When to stay silent

- **Blips with no effect:** nothing received or sent in the window, no outbox item expired. Log it.
- **Chats with nothing at stake:** notify only chats with inbound activity in the window or expired or unknown outbound items. Announcing an outage to 50 groups makes a second incident.
- **Before recovery is verified:** a notice into a degraded channel may itself end up `unknown`.
- **Repeats:** send once per incident, keyed by an incident id.

My rule: notify when a user message arrived late, an outbound message expired or is unknown, or the window was long enough to notice. Otherwise stay silent. This is policy, not platform guidance.

## 7. A design checklist for a small self-hosted agent

The setting: one process per channel, one SQLite file, one owner or a few users.

**Intake**

- [ ] Inbox table keyed by platform event id, with platform timestamp, raw payload, received time and status (`new`, `handled`, `skipped_stale`).
- [ ] Insert inbox rows and advance the stored cursor (Telegram offset) in one transaction, then poll with the new offset. Webhooks: write, then return 200.
- [ ] Never use a negative offset or `drop_pending_updates` at startup. Dedupe with a bounded recent-id set, not a pure high-water mark.
- [ ] Acknowledge fast and process from a queue. Slack: decide on Delayed Events deliberately. Discord: store `session_id`, `resume_gateway_url` and last `s`.

**Outbox**

- [ ] Table with local id, target, payload, `expires_at`, `attempts`, `next_attempt_at`, `state` (`pending`, `sending`, `sent`, `unknown`, `failed`, `expired`) and platform message id.
- [ ] Commit `sending` before the API call. After a crash, `sending` rows become `unknown`, not `pending`.
- [ ] 429: sleep for the platform's value. 5xx and timeouts: full-jitter backoff with a cap. 401: stop and alert.
- [ ] Per-kind expiry, per-chat coalescing and pacing, platform dedupe where it exists (Discord `nonce`, Lark `uuid`).

**Health, alerting and recovery**

- [ ] Per-channel health row (last good round trip, consecutive failures, classification) and an `incident` row (start, end, counts of affected inbox and outbox rows). Use the probe ladder from section 1.3.
- [ ] Alert route never equals the failing channel. Heartbeat to an external dead-man switch only after a full successful cycle.
- [ ] On recovery: drain by chat, coalesce, apply the stale policy, hold old side-effect requests for confirmation, tell the model the outage window, and send one notice built from the incident, inbox and outbox, only if the silence rule says so.

**Tests (keep them few)**

- [ ] Kill the process between inbox commit and handling: no loss, no duplicate.
- [ ] Time out a send after the body is written: the row ends `unknown`, not resent blindly.

## Why this matters for AI agent runtimes

Agents differ from ordinary bots in three ways that raise the stakes.

1. **Handling is expensive and has side effects.** A duplicate delivery to a classic bot costs a duplicate reply. To an agent it costs a model run, possibly tool calls, and possibly an action taken twice, as the Feishu issue reports.
2. **The agent's account of events comes from its own memory.** "I replied to you" is only as good as the outbox. An unknown-state send must not be summarized as "sent." The recovery notice is an agent-authored claim to a human, so it needs ground truth in storage, not in the model's recollection.
3. **Agents run long and unattended.** The incident happened overnight. The more autonomy the agent has, the more silent its failures; round-trip health signals, a second alert channel and a dead-man switch make silence visible.

Inference only: users read a missing reply as "the agent ignored me," not "the network failed," so accurate recovery messaging is part of the product.

## What I could not confirm

- **Telegram's webhook retry count and schedule.** The docs say only "a reasonable amount of attempts."
- **What Telegram retains during a per-bot backend failure.** The 24-hour rule is documented generally. #938 shows a large `pending_update_count` during a failure, which suggests queuing, but no document says this failure mode keeps the queue intact.
- **The cause of the November 2026 per-bot 502 reports.** The issues I read were closed by a maintainer with no explanatory comment in the issue text. I do not know whether Telegram explained them elsewhere, or whether the motivating incident was part of the pattern.
- **Telegram's lack of an idempotency key.** It rests on the term's absence from the Bot API page I fetched, not an explicit statement.
- **Telegram's error codes (401, 403, 409).** The page does not enumerate them. My claims about 401 for invalid tokens come from community reports and general practice.
- **Slack Socket Mode redelivery across disconnects**, and **catch-up through history APIs** (Slack, Discord, Feishu). I did not find or fetch these, so any catch-up suggestion is unverified.
- **Discord's resume window and `nonce` window.** The docs say "in time" and "the past few minutes," with no numbers.
- **WhatsApp:** the exact retry schedule, dedupe guidance, and any send idempotency feature. A third-party site said Meta uses exponential backoff; Meta's own page says only "decreasing frequency."
- **Lark/Feishu pages are single-page apps.** I read them through a page-summarizing fetch tool, so quotes there (including my translation of the Chinese `uuid` text) should be re-checked against the live page.
- **All thresholds and policies** in sections 3 to 6 (stale age, expiry, alert timing, silence rule) are my suggestions, not platform guidance.

## Sources

Primary platform documentation (fetched):

- Telegram Bot API reference: https://core.telegram.org/bots/api
- Telegram Bots FAQ: https://core.telegram.org/bots/faq
- Slack Events API: https://docs.slack.dev/apis/events-api/
- Slack Socket Mode: https://docs.slack.dev/apis/events-api/using-socket-mode
- Slack Web API rate limits: https://docs.slack.dev/apis/web-api/rate-limits
- Slack chat.postMessage: https://docs.slack.dev/reference/methods/chat.postMessage
- Discord Gateway: https://discord.com/developers/docs/events/gateway
- Discord Message resource: https://discord.com/developers/docs/resources/message
- Discord rate limits: https://discord.com/developers/docs/topics/rate-limits
- Feishu Open Platform, Event overview: https://open.feishu.cn/document/server-docs/event-subscription-guide/overview?lang=en-US
- Lark Developer, Event overview (found via search; text not directly confirmed): https://open.larksuite.com/document/server-docs/event-subscription/overview-of-event-subscription
- Lark Developer, Send message API: https://open.larksuite.com/document/server-docs/im-v1/message/create
- WhatsApp Cloud API, set up webhooks: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks/
- Meta Graph API, webhooks getting started: https://developers.facebook.com/docs/graph-api/webhooks/getting-started
- WhatsApp Cloud API, send messages and service messages: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages/
- WhatsApp Cloud API, messages reference: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages/
- WhatsApp Cloud API, error codes: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/

General references (fetched):

- RFC 9110, HTTP Semantics: https://datatracker.ietf.org/doc/html/rfc9110
- AWS Architecture Blog, Exponential Backoff and Jitter: https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
- Healthchecks.io documentation: https://healthchecks.io/docs/

Status pages (called on 2026-11-21): https://discordstatus.com/api/v2/status.json, https://slack-status.com/api/v2.0.0/current, https://metastatus.com/, https://status.larksuite.com/

Community reports (read through the GitHub API; user reports, not vendor statements):

- https://github.com/tdlib/telegram-bot-api/issues/916
- https://github.com/tdlib/telegram-bot-api/issues/938
- https://github.com/tdlib/telegram-bot-api/issues/963
- https://github.com/tdlib/telegram-bot-api/issues/1001
- https://github.com/tdlib/telegram-bot-api/issues/1015
- https://github.com/tdlib/telegram-bot-api/issues/1025
- https://github.com/tdlib/telegram-bot-api/issues/1026
- https://github.com/TencentCloud/octop-gateway/issues/51
