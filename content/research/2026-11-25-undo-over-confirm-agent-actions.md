---
date: "2026-11-25"
title: "Undo Over Confirm: Reversibility Tiers for Actions Taken by Always-On AI Agents"
description: "How an always-on agent runtime can classify actions by reversibility, add undo windows, soft deletes, checkpoints and delayed commits, and keep owner confirmation for the genuinely irreversible tier. Covers the UX case, chat-recall limits, existing mechanisms, window design and failure modes."
tags: ["research", "ai-agents", "reversibility", "undo", "safety", "human-in-the-loop", "ux", "agent-runtime"]
---

## Executive Summary

An always-on agent that edits files, runs shell commands, sends messages and manages repositories on behalf of an owner needs a rule for dangerous actions. The common rule is "ask first, wait for a reply". That rule is safe in a narrow sense and expensive in practice: every confirmation costs the owner attention, arrives asynchronously, and trains the owner to approve without reading. This article argues for a different default: **classify each action by how it can be taken back, make as many actions as possible reversible, and reserve confirmation for what remains.** Authority and consent models, async pause/resume protocols and rollback verification are covered in earlier articles on this site; this one is about the step before them, deciding which actions need a human gate at all.

Findings, in order of importance.

1. **The usability literature has said this for twenty years.** Nielsen Norman Group's third heuristic asks for a clearly marked "emergency exit"; their confirmation-dialog article says not to use confirmations for routine actions and to offer undo because some errors survive even the best confirmation; Aza Raskin's A List Apart essay argues that warnings are habituated away and undo is not. What changes for agents is that the actor making the mistake is no longer the person who would click the dialog.
2. **"Undo" in successful products is usually a delay or a soft delete, not a time machine.** Gmail's Undo Send holds the message for a short cancellation window (five seconds at its 2009 launch; 5, 10, 20 or 30 seconds, chosen by the user, per Google's current help page). Email in Raskin's example "sits in the trash". Both work because the irreversible step has not happened yet, or because the data was never destroyed.
3. **Reversibility is a property of an action plus the infrastructure under it, not of the tool.** The same `rm` is fully reversible for a tracked file whose current bytes git has stored (or the runtime captured first), loses the owner's newer edits for a tracked file with unstaged changes, is recoverable only through a trash directory you designed, and is gone for an untracked file. The runtime can therefore *promote* actions to a better tier by wrapping them: capture a pre-image or move to trash instead of delete, hold in an outbox instead of send, delay capture of an authorized payment.
4. **Existing tooling covers less than people assume.** Claude Code's checkpointing, per its documentation, does not track files changed only by Bash commands and does not capture most subagent edits. Chat platforms let a bot delete or edit its own messages under rules that differ per platform (Telegram: under 48 hours for delete; Slack: no stated window on the reference page, but bot tokens can delete only the bot's own messages; Feishu: a bot's own messages within a recall limit set by the enterprise admin, with batch sends and recalling others' messages under separate rules) and none of those rules can make a message unread.
5. **Undo has its own failure modes**: rewinding files but not the message that was already sent, an Undo that races the sender or a send whose result is unknown, an undo window longer than the substrate's retention, undoing action A after action B depended on it, trash that never empties, and compensations that fail. Each needs a design answer, given in sections 4.1 and 6.

The rest of this article gives a four-tier taxonomy (section 2), a source-verified survey of mechanisms (section 3), a design for the undo window (section 4), a way to make the remaining confirmations rarer and better (section 5), failure modes (section 6) and a playbook (section 7). Statements of my own reasoning are labelled **(inference)**. Where I could not verify a number or behaviour, I say so or leave it out.

## 1. The UX case: undo beats the question

### 1.1 What the usability sources say

Nielsen Norman Group's ten heuristics put "User Control and Freedom" third. People often act by accident, and the heuristic says they "need a clearly marked 'emergency exit' to leave the unwanted action without having to go through an extended process" ([NN/g heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/)). The same page offers a confirmation option as one way to prevent errors, so the heuristics do not forbid confirmation; they set it beside undo.

NN/g's dedicated article on [confirmation dialogs versus undo](https://www.nngroup.com/articles/confirmation-dialog/) is more specific:

- Confirmations belong before serious, hard-to-reverse actions: "consider a confirmation dialog before actions that cannot be undone", and the dialog must "be sufficiently specific that users know what they're agreeing to."
- Overuse defeats the purpose: "Do not use confirmation dialogs for routine actions." and "if you cry wolf too many times, people will stop paying attention to the question".
- Undo is the stronger net: the article says to "do try your best to offer undo", because some errors remain even after the best confirmation. Its example is YouTube's video deletion, where "it would be much better if the system provided resilience by keeping a backup copy of the deleted video around for a little time", so that the user could undo the deletion.

Aza Raskin's [Never Use a Warning When you Mean Undo](https://alistapart.com/article/neveruseawarning/) (A List Apart) makes the habituation argument sharply: "If an interface is to be humane, it must respect habituation." Louder warnings do not help because "as long as it's possible to habituate to dismissing the message, we'll habituate, and then we'll make mistakes." His rule for destructive actions: "when a user is deleting their work, you always mean undo." The article describes Gmail's delete-then-undo from the user's side without describing the implementation. Commenters on it propose the two implementation families that matter below: deferring the real action until later ("you defer the actual action until the next command is entered") and soft delete ("flagging content as deleted in the database").

### 1.2 Gmail Undo Send: a held message, not a recalled one

Gmail's 2009 Labs launch post describes the mechanism directly. Clicking Undo means "we'll grab the message before it's sent and take you right back to compose", and the feature "can't pull back an email that's already gone; it just holds your message for five seconds so you have a chance to hit the panic button" ([Official Gmail Blog](https://gmail.googleblog.com/2009/03/new-in-labs-undo-send.html)). The same post adds that if the browser closes or crashes during those seconds, "we'll still send your message": the hold does not depend on the client staying up, and a held send that becomes due is still sent. The current help page keeps the pattern and makes the window a setting: right after sending "you can retract it", and you can choose "a Send cancellation period of 5, 10, 20, or 30 seconds" ([Gmail Help](https://support.google.com/mail/answer/1284885)).

The design lesson: a cancellation window of seconds to tens of seconds turns an irreversible action (delivery to someone else's mailbox) into a reversible one by delaying the irreversible step. Nothing is recalled. That is the cheapest and strongest form of undo, and it is the form an agent runtime can copy.

### 1.3 Why this matters more for agents

For a person at a keyboard, a confirmation dialog interrupts a flow they are watching. For an always-on agent working through chat, a confirmation is a message the owner must notice, read, understand and answer later, possibly hours later, while the agent waits or parks the task. **(inference)** Three costs follow: latency (the task stalls), attention (the owner reads many requests that were fine to approve), and a worse signal (a stream of nearly identical approvals makes the one dangerous request look like the rest). Raskin's habituation argument applies directly, with the extra problem that the approver is looking at a text summary of an action, not the action.

Undo shifts the cost. The agent acts, the owner sees what happened in the same channel, and attention is spent only when something is wrong. This is only acceptable when the action truly can be taken back, which is what the next section classifies.

## 2. A reversibility taxonomy for agent actions

Classify by what the runtime can do *after* the action, using four tiers. The tier belongs to a concrete action instance on a concrete system, not to a tool name.

| Tier | Meaning | Typical mechanism | Examples |
|---|---|---|---|
| 1. Fully reversible | The prior state can be restored exactly, with no outside observer | A captured copy of the actual pre-action bytes: checkpoint, commit or stash, snapshot, worktree | Edit a file whose current content is committed or was captured first; commit locally; change a version-controlled config file with no uncommitted edits |
| 2. Reversible within a window | The destructive or outward step has not yet happened, or the data still exists in a holding area | Soft delete, trash, outbox with delay, delayed capture | Move a file to trash; queue a message to another person; delay the capture of an authorized payment |
| 3. Compensatable | An inverse action exists, but someone or something may already have observed or reacted to the original | Delete or edit a sent message; refund; revert commit that was pushed | Remove a chat message that others may have read; refund a charge (fees may not return); revert a deployed change |
| 4. Irreversible | No inverse action recovers the prior state | None (only prevention, or damage limitation) | Disclosure of a secret; external email already delivered; physical-world actions; deleting data with no retained copy |

Three points make this useful in practice.

**Tiers are promotable.** An agent that runs `rm` on an untracked file is in tier 4; so are a tracked file's unstaged edits, because git can restore only the index or committed version (section 3.2). The same intent expressed as "move to a trash directory with a record" is tier 2. A message sent immediately is tier 3 at best; the same message put in an outbox for 30 seconds is tier 2 until the window closes. The runtime's job is to route actions through wrappers that move them up a tier before asking whether a human is needed.

**Tiers depend on what is observed.** An action's side effects matter as much as its direct effect. Rewinding a file edit whose pre-image was captured is tier 1; the message the agent sent afterwards that quoted the file is a separate tier 3 action. Reversibility of a *chain* is the worst tier in it.

**Tier 3 is where honesty matters most.** A compensating action produces a new state that looks like the old one, but the world has moved. The next subsection shows what the chat APIs actually offer.

### 2.1 Chat recall: what the platform APIs actually say

All three platforms below let the sender (or a privileged user) remove or edit a message. None of the pages I read says anything about whether recipients already saw it, because no API could change that.

**Telegram Bot API** ([Bot API](https://core.telegram.org/bots/api))

- Delete (`deleteMessage`): "A message can only be deleted if it was sent less than 48 hours ago." "Bots can delete outgoing messages in private chats, groups, and supergroups." A bot that is a group administrator can delete any message there; in supergroups and channels the `can_delete_messages` right does the same. Dice messages in private chats have a separate rule.
- Edit (`editMessageText`): the method states a 48-hour limit only for business messages not sent by the bot that lack an inline keyboard; I found no other time limit there.

**Slack** ([chat.delete](https://docs.slack.dev/reference/methods/chat.delete))

- Delete: a bot token "may delete only messages posted by that bot"; a user token can delete what that user can delete in Slack. The page states no time window; its only listed limit is the rate-limit tier.
- Edit: not checked.

**Feishu / Lark** ([recall](https://open.feishu.cn/document/server-docs/im-v1/message/delete), [edit](https://open.feishu.cn/document/server-docs/im-v1/message/update))

- Recall: a bot can recall its own messages, and a group owner can recall messages in the group. The recall must meet the time limit set by the enterprise administrator, otherwise error 230009. Messages sent through the batch-send API need the separate batch-recall API. A bot recalling *other people's* messages in a group must be the group's owner, an administrator or its creator, and the message must be at most one year old.
- Edit: text and rich-text (post) messages only; sender only; at most 20 edits per message; editable time set by the enterprise administrator (error 230075 when exceeded); secret-chat groups unsupported.

Two consequences. First, a chat "undo" cannot be assumed to exist for the whole life of a message: Telegram's 48-hour bound is explicit, Feishu's bound is configured by the customer's admin and is therefore unknown to the agent unless it probes, and Slack's reference page is silent on time (workspace settings may impose limits, but I did not verify that, so I make no claim). Second, none of these is a recall of an *effect*: a person who read the message, or an integration that consumed it, keeps what they got. **(inference)** So outbound chat messages to other people belong in tier 3 after sending, and are worth moving into tier 2 by holding them first.

Native delayed-send exists on at least one platform. Slack's `chat.scheduleMessage` posts at a future time, accepts schedules up to 120 days ahead, caps scheduled messages at 30 per 5-minute window per channel, and the scheduled message id can be passed to `chat.deleteScheduledMessage` "to delete the message before it is sent" ([Slack docs](https://docs.slack.dev/reference/methods/chat.scheduleMessage)). Telegram's `sendMessage` description lists no scheduling parameter among its parameters as of the page I fetched today, so on Telegram a delay has to live in the runtime. I did not check scheduling for Feishu.

### 2.2 Payments are not simply "irreversible"

Payments are often filed under irreversible. The primary sources say it depends on the stage. Stripe's [authorize-then-capture](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method) flow reserves funds first and captures later; an uncaptured authorization can be cancelled, and funds are released if it expires. The page gives typical validity windows (for card-not-present payments, 5 to 7 days depending on card brand and transaction type). After a payment succeeds, a [refund](https://docs.stripe.com/refunds) is a compensation: Stripe's page says the original processing fees are not returned, a refund can fail, and a PaymentIntent cannot be cancelled after it has succeeded. The authorization itself is not invisible, though. It holds the amount "on the customer's payment method", and Stripe notes that card statements from some issuers "don't always distinguish between authorizations and captured (settled) payments" (same page). So classify the two steps separately: placing the hold is already an external effect on the customer (tier 3: cancellable, but the funds were reserved and the customer may have seen it), and it needs whatever authority a charge needs; the delayed capture is tier 2 until it runs; a captured payment is tier 3 (refundable at a cost) and the cost of that move is explicit. An agent that can only call "charge" has no tier 2 at all; designing the capability set is part of the safety design.

## 3. Existing mechanisms, and what each does not cover

### 3.1 Agent-level checkpoints: Claude Code

Claude Code's [checkpointing](https://code.claude.com/docs/en/checkpointing) tracks file edits made through its editing tools. Each prompt that starts a turn creates a checkpoint; snapshots are kept for the 100 most recent checkpoints in a session; `/rewind` (alias `/undo`) offers restoring code, conversation or both. The documentation lists its own limits clearly:

| Not covered | What the docs say |
|---|---|
| Files changed only by shell commands | "A file that only Bash commands changed isn't tracked and stays as it is." Once Claude has edited a file with its editing tools, later Bash changes to that file are undone by rewind |
| Subagent edits | Usually not captured; only a foreground forked skill is restored as usual |
| External changes | "Checkpointing only tracks files that have been edited within the current session." Manual edits and other concurrent sessions are normally not captured |
| Symlinked and hard-linked paths | Skipped on restore |
| Retention | Only the 100 most recent checkpoints keep snapshots; discarding an older one deletes snapshot files no remaining checkpoint references (except each file's first). Snapshots are also removed in a retention sweep, by default about 30 days after the session last saved one; `cleanupPeriodDays` extends it |
| Role | "Checkpoints are designed for quick, session-level recovery." The page points to version control for permanent history |

The page lists limits about files. It does not mention effects outside the file system, such as messages, API calls or processes, so a rewind there is a file rewind and nothing more; I found no statement that it tracks them, and the page's own limits section implies it does not. For an agent runtime that runs many shell commands, the first row matters most: shell is the main way agents modify things.

Claude Code also exposes the interception point a runtime needs. Its [hooks](https://code.claude.com/docs/en/hooks) reference describes a `PreToolUse` event that fires "Before a tool call executes. Can block it", with the tool name and tool input on standard input. **(inference)** That is where a runtime can take a pre-image (a snapshot of the files a command will touch, or a stash of the working tree) before the command runs, independent of the agent's own checkpoint feature. The docs also warn that a timed-out hook does not block the call by default, so an undo hook that fails silently turns into no undo at all.

### 3.2 Git as an undo log

Git gives tier 1 for the versions it has stored, which is less than everything it tracks. `git restore` takes content from the index by default, or from `HEAD` or another commit ([git-restore](https://git-scm.com/docs/git-restore)); it has no copy of a tracked file's unstaged edits. If the agent deletes or overwrites such a file, git brings back the staged or committed version and the owner's newer bytes are lost. Exact file undo therefore needs the actual pre-action version captured first (a commit, a stash, or a copy). A reflog records, in the words of its documentation, "when the tips of branches and other references were updated in the local repository" ([git-reflog](https://git-scm.com/docs/git-reflog)), so a bad reset or amend can be undone by moving the branch back to a prior position. The retention is finite: per the [git-gc](https://git-scm.com/docs/git-gc) documentation `gc.reflogExpire` defaults to 90 days and `gc.reflogExpireUnreachable` to 30 days, and unreachable loose objects are pruned after the `gc.pruneExpire` grace period, which defaults to 2 weeks.

The limit is what git never saw. `git clean` removes "files that are not under version control" ([git-clean](https://git-scm.com/docs/git-clean)); **(inference)** since those files were never committed, no git history holds a copy of them. A runtime that wants git to cover an agent's work must capture the working tree before risky operations, or treat the working directory as a snapshot target (below). With [git-stash](https://git-scm.com/docs/git-stash), `-u` adds untracked files but only `-a`/`--all` also takes ignored ones (often build outputs and local configuration), so use `--all` when ignored files are in scope. Note that `stash push` also rolls the working tree back to `HEAD`, so a capture step has to re-apply the stash or copy the files instead. Git's own `git clean -n` dry run shows the other mitigation: show what would be removed before removing.

Worktrees are the cheapest isolation primitive. A [linked worktree](https://git-scm.com/docs/git-worktree) shares everything except per-worktree files such as `HEAD` and `index`, so an agent can do a task on a separate branch in a separate directory and the owner's checkout is untouched; undo is "do not merge" or remove the worktree. Note that `git worktree remove` refuses to remove a worktree with untracked files or modified tracked files unless forced, which doubles as a small guard against throwing away uncommitted agent work. Worktrees isolate files only; they do not isolate databases, ports or outbound messages.

### 3.3 Filesystem snapshots

Copy-on-write filesystems give whole-directory undo below the tool layer, so shell side effects are covered. Btrfs documents that a snapshot is a subvolume with a given initial content and that, once dirty data has been flushed, "the snapshot is instantaneous and only creates a new tree root copy in the metadata", but also that snapshots are not recursive into nested subvolumes and that "A snapshot is not a backup" ([btrfs docs](https://btrfs.readthedocs.io/en/latest/Subvolumes.html)). OpenZFS `zfs rollback` discards everything changed since the snapshot ("all data that has changed since the snapshot is discarded"), and rolling back past newer snapshots requires `-r`, which destroys those newer snapshots ([zfs-rollback](https://openzfs.github.io/openzfs-docs/man/master/8/zfs-rollback.8.html)). I did not verify APFS details and make no claim about it.

Snapshots are tier 1 for the whole subvolume and therefore coarse: rolling back to undo one agent action also rolls back the owner's other changes made in the same period. **(inference)** They suit "before a large batch task" checkpoints, not per-action undo.

### 3.4 Databases and cloud resources

| Mechanism | What it gives | What it does not | Source |
|---|---|---|---|
| Application soft delete (a deleted flag, trash table) | Row-level, per-action undo | Needs the application to do it; reads must filter it out; data stays until purged | Raskin commenters; design choice |
| PostgreSQL point-in-time recovery | Restore to any time since a base backup, given a continuous WAL archive | Whole cluster only: "this method can only support restoration of an entire database cluster, not a subset." Also not configuration files | [PostgreSQL docs](https://www.postgresql.org/docs/current/continuous-archiving.html) |
| GCS soft delete | Deleted objects retained and restorable during a retention period; default 7 days, customizable between 3 and 90 days; 0 disables. A retention change applies only to objects deleted afterwards | "Soft-deleted objects continue to accrue storage charges until their retention period expires and they're permanently deleted"; the page says that during retention the object cannot be permanently deleted | [Cloud Storage docs](https://docs.cloud.google.com/storage/docs/soft-delete) |
| S3 Versioning | A delete inserts a delete marker "instead of removing the object permanently"; overwrites create versions; restore a prior version | Off by default; once enabled a bucket "can never return to an unversioned state" (it can be suspended); every version is stored and billed; permanent removal needs a lifecycle rule or explicit version delete | [S3 docs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html) |
| Compute Engine deletion protection | A delete request on a protected VM fails | It does not cover stopping, resetting or suspending the VM, shutdown from inside the VM, or removal on project termination; and a user with a role holding `compute.instances.create` can reset the flag | [Compute Engine docs](https://docs.cloud.google.com/compute/docs/instances/preventing-accidental-vm-deletion) |
| RDS deletion protection and final snapshot | Deletion blocked while protection is on (on by default for console-created instances); a final snapshot or retained automated backups allow restore | Final snapshot is optional (`--skip-final-snapshot`); automated backups not retained are deleted; retained backups restore only within their retention period; they bill until removed | [RDS docs](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_DeleteInstance.html) |

Two observations connect these to agent design. Protection flags are speed bumps, not locks: the GCE page names who can flip the flag, and an agent running with that permission can flip it. **(inference)** An agent's credentials should simply not hold the permission to remove protection or skip the final snapshot; the flag is only as strong as the IAM around it. And every retention feature here has an expiry, which is both its cost control and the point at which undo ends (section 6).

### 3.5 Trash as a specification

The freedesktop.org [Trash specification](https://specifications.freedesktop.org/trash/latest/) is a small, concrete design for tier 2 on files. A trash directory has `files` and `info` subdirectories; each trashed item has an `.trashinfo` file with a `Path` key for the original location and a `DeletionDate`. That is a pre-image record in a dozen bytes: where it came from, and when it was deleted. On cleanup the spec is deliberately loose: "Automatic trash cleaning may, and probably eventually should, be implemented", and it adds that "the implementation should be somehow known to the user". A runtime copying this design must decide the expiry itself.

## 4. Designing the undo window for an agent

### 4.1 Hold-then-commit or act-then-compensate

Two patterns give tier 2 and tier 3.

- **Hold-then-commit (outbox).** The agent records an intent instead of doing it. A commit worker executes the intent after a delay unless it was cancelled. Undo is a state change on a database row, free and exact. Use it when the outward effect cannot be reliably taken back, when the target has no native undo (Telegram messages), or when the effect is visible to other people. Cost: latency on every held action, and the agent must not assume the effect exists yet (it cannot read back the message it "sent"). The hold is a chance to cancel, not an approval: a send that needs the owner's approval (section 5.1) waits without a send time until the owner approves, and no reply means it is not sent.
- **Act-then-compensate.** The action happens now and the record carries the inverse. Undo runs the inverse. Use it when delay is unacceptable or the system gives a cheap exact inverse (move file back from trash, restore a branch pointer, restore a prior object version). Cost: the inverse can fail, and in the meantime others may have observed the state.

| Question | If yes | If no |
|---|---|---|
| Can another person or system observe the action immediately? | Prefer hold-then-commit | Act-then-compensate is fine |
| Does the target offer its own delay or hold (Slack scheduled messages, payment authorization)? | Use the native hold; it survives your own runtime restarting | Hold in your own outbox |
| Is there an exact, cheap inverse that does not depend on others? | Act and record the inverse | Hold, or confirm |
| Would a delay of the window length hurt the owner's goal? | Shrink the window or act directly if the action is tier 1 | Hold |

An outbox row needs few fields, and the hold needs one rule above all: **the send and the Undo compete for the same row, and exactly one of them may win.** A sender that reads the `held` rows, sends, and then marks them loses that race: the owner can press Undo between the read and the send, be told "undone", and the message still goes out. Making the claim and the cancellation the same kind of conditional update closes it. The sketch is SQLite.

```sql
CREATE TABLE action_log (
  id            TEXT PRIMARY KEY,
  session       TEXT NOT NULL,     -- which conversation or job asked for it
  kind          TEXT NOT NULL,     -- send_message, delete_path, git_reset, ...
  tier          INTEGER NOT NULL,  -- 1..4, decided by the runtime, not the model
  state         TEXT NOT NULL,     -- holds: held, sending, sent, unknown, failed, undone
                                   -- act-then-compensate: done, reverted, expired
  commit_after  INTEGER,           -- earliest send time; NULL = waits for owner approval
  undo_until    INTEGER,           -- actual expiry of the pre-image (section 6.2)
  payload       TEXT NOT NULL,     -- what to do (or what was done), as JSON
  provider_key  TEXT,              -- idempotency key, only where the target honors one
  provider_ref  TEXT,              -- e.g. the sent message id, for a later compensation
  pre_image_ref TEXT,              -- trash path, commit hash, snapshot name, object version id
  inverse       TEXT,              -- JSON of the inverse operation, if one exists
  depends_on    TEXT,              -- id of an earlier action this one builds on
  created_at    INTEGER NOT NULL,
  finished_at   INTEGER            -- set when the row reaches a final state
);

-- Sender: claim a due row; call the provider only if changes() = 1.
UPDATE action_log SET state = 'sending'
 WHERE id = :id AND state = 'held' AND commit_after <= :now;
-- Then: 'sent' (with provider_ref, finished_at) on success, 'failed' on a
-- definite rejection, 'unknown' on a timeout or lost reply.

-- Owner's Undo: wins only while the row is still held.
UPDATE action_log SET state = 'undone', finished_at = :now
 WHERE id = :id AND state = 'held';
-- changes() = 0: too late; report the row's current state instead.

-- Startup, before the (single) sender runs: a row left in 'sending' may
-- already have reached the provider, so it is never sent again blindly.
UPDATE action_log SET state = 'unknown' WHERE state = 'sending';

-- Sweeper: final rows only. A held row, however overdue, stays for the sender.
DELETE FROM action_log
 WHERE state IN ('sent', 'undone', 'failed', 'reverted', 'expired')
   AND finished_at < :now - :keep;
```

Three rules come with it.

- **Due is not expired.** When `commit_after` passes, the row stays `held` and eligible for the sender until it is claimed; a runtime that was down past the window sends it on restart, as Gmail's launch post promises after a browser crash. Garbage collection touches only final rows and recovery data (trash files, snapshots) past their expiry, so a sweep can never race the sender and drop a message unsent.
- **An ambiguous send is a state, not a retry.** The provider can accept a message whose reply is lost, or the worker can crash before recording `sent`; sending again duplicates it. A row id passed as an idempotency key prevents that only where the provider honors such a key for that operation and for the retry interval. Stripe (API v1) returns the saved response for a retried key, but keys can be pruned once they are at least 24 hours old, and a reused key after pruning makes a new request ([Stripe](https://docs.stripe.com/api/idempotent_requests)). Telegram's `sendMessage` has no idempotency or deduplication parameter in its parameter list ([Bot API](https://core.telegram.org/bots/api#sendmessage)). So an `unknown` row is reconciled where the provider allows it (a retry with the same key inside the key's lifetime, or a lookup where the API offers one) and otherwise reported to the owner as "may have been sent", not sent again.
- **Undo after the claim is a different action.** When the Undo update changes no row, the answer follows the state: `sending` or `unknown` means too late to cancel, with the result pending or unknown; `sent` means the message is out, and the remaining option is a tier 3 compensation (delete it, within the limits in section 2.1), offered as a separate action.

I replayed these statements in SQLite 3.45 with an in-memory provider stub that counts deliveries, against a read-then-send variant (select due `held` rows, send, mark them, and a sweeper that deletes rows past `undo_until`). The variant let an Undo report success while the message was delivered, delivered twice after a lost reply, and deleted an overdue message unsent when the sweep ran first after a restart. With the statements above, whichever of claim and Undo ran first won and the other changed no row; the lost reply ended as `unknown` with one delivery when the stub had no key, or `sent` with one delivery when it honored the key (a retry after the stub's 24-hour key lifetime delivered twice, which is why the retry interval matters); and the overdue row was sent.

### 4.2 How long should the window be

No source gives a universal number, and I will not invent one. The documented anchors differ by orders of magnitude: Gmail's user-chosen 5 to 30 seconds, git's reflog 30 or 90 days, GCS soft delete 7 days by default and configurable from 3 to 90, payment authorizations of a few days. They reflect what each system's *observer* needs. **(inference)** For an agent the relevant clock is the time the owner needs to notice. An owner who reads chat in bursts needs minutes to hours; a 30-second window protects against the agent's slip, not against the owner's delayed notice. A reasonable split is a short hold (seconds to minutes) for outward messages where the owner is probably watching a live conversation, and a long retention (days) for local data, where holding costs only disk. Make the number a per-tier setting, and record it in the action log so the owner can see it.

A hard constraint is that **the window must not exceed the retention of whatever backs it**. A hold on a payment cannot outlive the authorization window; a "restore within 30 days" promise cannot rest on a store that sweeps at 14 days. Section 6 repeats this because it is the commonest silent failure.

### 4.3 Put the undo control where the owner saw the action

Undo that lives in a log file nobody reads is not an emergency exit. The report of what happened should be the message the owner sees, in the channel they used, with the way to take it back attached. On Telegram, an inline keyboard "appears right next to the message it belongs to" ([Bot API](https://core.telegram.org/bots/api)) and button presses arrive as callback queries answered with `answerCallbackQuery`, so an "Undo" button on the action report is a native pattern there. For a held message to someone else, the pending notice and its Undo belong in the owner's channel; the recipient's chat shows nothing until the message is released, so a cancelled message was never visible to them. For platforms without buttons, a reply keyword works if it names the action ("undo 4f2a") and the agent echoes the outcome. Whatever the channel, the report should contain: what was done, what the effect was, until when it can be undone, and what undoing will and will not restore.

Two design details follow from the UX literature. The control must be available for long enough that the owner who notices late can still use it (Raskin's argument is that habituation defeats warnings; **(inference)** an undo control works with habit instead of against it, because it does not depend on the person pausing to think first). And once the window passes, the control must be removed or answer honestly, as section 4.5 says.

### 4.4 What the agent must record

To undo an action later the runtime needs, at action time, something the model's memory cannot be trusted to supply. **(inference)** The minimum:

- **A pre-image or a handle to it**, taken from the actual pre-action state (unstaged edits included): a trash location, a commit hash, a snapshot name, an object version id. The trashinfo format shows how small this can be.
- **The inverse operation**, as data, not as prose. If no inverse exists, record `null` and let that decide the tier.
- **An idempotency key** on every outward call whose target honors one, so a retried commit or a retried undo does not repeat the effect; where the target has none, a send with an unknown result is reported, not retried (section 4.1). Stripe's [idempotency](https://docs.stripe.com/api/idempotent_requests) documentation (API v1) says retries with the same key return the saved response, that parameters are compared and a mismatch errors, and that keys may be removed after they are at least 24 hours old. So an undo token that outlives the target's idempotency memory needs its own deduplication.
- **Dependencies**: which earlier action this one used as input, so the runtime can warn before undoing one that others built on (section 6.3).
- **The decision about the tier and who made it**, so a later review can ask whether the classification was right.

The action log is also the audit log. Writing it before the action, not after, is what makes it useful after a crash.

### 4.5 Honest expiry

When the window ends, do what the system says. Soft-deleted data that has passed its retention should be really deleted, not left in trash because someone might want it. GCS says soft-deleted data is permanent after the retention period; S3 versioning needs a lifecycle rule to remove old versions; the freedesktop spec leaves cleaning to the implementation. **(inference)** A runtime that keeps its own trash must run its own sweeper, and should tell the owner both ways: when the action is reported ("can be undone until 18:00 today") and when the undo is refused ("this was deleted for good at 18:00, it cannot be restored"). The second message matters because the common failure is somebody assuming a copy exists, or assuming none does. The AI Incident Database entry on a 2025 incident in which a coding assistant deleted a production database during a code freeze records that the agent "incorrectly claimed rollback was impossible" ([incident 1152](https://incidentdatabase.ai/cite/1152/)). The model's statements about what can be undone are not a source of truth; the action log is.

## 5. When confirmation is still required, and how to make it rarer and better

### 5.1 The residual set

Confirmation belongs where undo cannot help. From the taxonomy:

1. **Tier 4 actions**: nothing restores the prior state. Examples: deleting data with no retained copy, anything physical, releasing information that cannot be recalled.
2. **Actions that affect other people, unless the owner already authorized them**: even with a hold window, the owner is not the only stakeholder. **(inference)** An undo window is not an authorization, so the two are decided separately. A send the owner already authorized (the owner asked for this message to this recipient, or a standing rule the owner set covers this recipient and this kind of message) is released automatically when its hold ends. A message to a colleague, a change to a shared repository or a post in a group that the agent initiates itself, or whose recipient or substance the owner did not specify, needs approval before release: it waits in the outbox with no send time, and no reply means it is not sent. Placing a payment authorization belongs here too, since the hold already reaches the customer (section 2.2).
3. **Credential or secret exposure**: disclosure is tier 4. Rotation after the fact limits future use of the secret, but nothing un-discloses it, so it is a damage-limiting compensation, not an undo.
4. **Actions that remove the safety net itself**: turning off deletion protection, skipping the final snapshot, shrinking retention, emptying trash early.
5. **Tier 3 with a known cost**: a refund that loses fees, a force-push that others may have fetched. The confirmation states the cost.

Everything else, ideally the bulk of actions, should be allowed with an undo record. NN/g's advice ("Do not use confirmation dialogs for routine actions.") is the guide for what to remove from the confirmation list.

### 5.2 Better confirmations

A confirmation that says "are you sure?" gets approved by habit. The same NN/g article says dialogs must "be sufficiently specific that users know what they're agreeing to." For an agent that translates into a fixed shape:

- **State the consequence in the owner's terms**: not "delete the directory" but "permanently delete 214 files in the project folder; no copy is kept; 12 of them were changed today".
- **State what is not undoable and what is**: "A message to this group cannot be recalled after 48 hours" is better than "send message?" (the 48-hour number is Telegram's, per its Bot API; use the platform's figure, or say it is unknown).
- **State the default if there is no reply**: the safe default is "do nothing". Say so, so a missing reply is not a stall.
- **Offer a cheaper alternative where one exists**: "move to trash for 7 days instead?" A confirmation that proposes the tier 2 version often turns a tier 4 request into a tier 2 action. A dry run is the analogue for scripts: git's `clean -n` shows what would be removed without removing it.
- **Batch and scope**: one confirmation for a named, bounded set of actions ("these 5 files") beats five confirmations. An approval should name its scope, which ties to the scoped authority model covered in the earlier article on approval and consent.

**(inference)** Track the approval rate per confirmation type. If an owner approves nearly 100 percent of one kind, that kind is a candidate for promotion to an undo window; if they reject often, the agent is asking about the wrong things. This is a tuning loop, not a published benchmark; no source here supplies target numbers.

## 6. Failure modes

**6.1 Undo that does not cover the side effects.** The checkpointing page lists what a file rewind will not do (Bash-only changes, most subagent edits, other sessions, symlinks). The deeper form is the *mismatch of scope*: files rewound, but the message that quoted them is still out there; branch restored, but the deployment already went out. Mitigation: the undo report lists what was restored and what was not, and the action log groups actions that belong to one task so "undo task" names every member and flags those that are tier 3 or 4.

**6.2 Window longer than retention.** Examples from the sources: Claude Code's default snapshot sweep of about 30 days; git's 2-week prune grace for unreachable objects; GCS's 7-day default (configurable from 3 to 90); payment authorizations of a few days. If the agent tells the owner "undo available for 30 days" and the substrate keeps 7, the promise is false from day 8. The minimum of the nominal settings is not a deadline either. The backing record may already be partway through its retention (Claude Code's sweep counts from when the session last saved a snapshot, not from the action), a GCS object keeps the retention that was in force when it was deleted, and some stores evict by count: Claude Code keeps snapshots only for the 100 most recent checkpoints, and rewinding to one whose snapshots are gone "can fail with No files were restored." Mitigation: set `undo_until` from the pre-image's actual expiry where the backend exposes it (for GCS, deletion time plus the retention then in force), take the earliest across every system it lives in, and read it at action time instead of hard-coding. Where a store evicts by count, promise no date ("while the checkpoint exists"), and record early eviction and a failed purge as outcomes of their own, distinct from "expired".

**6.3 Stacked actions.** Undoing A after B built on A can break B or restore a stale state. ZFS makes the structure explicit: rolling back to an older snapshot requires destroying the newer ones. PostgreSQL's PITR is whole-cluster, so undoing one agent mistake also discards unrelated writes after that time. Mitigation: a `depends_on` link; refuse or warn when a dependent action is live; prefer per-object undo (restore this file, this object version) over global rollbacks (snapshot, PITR) except as a last resort; keep global rollbacks for "before a large batch" checkpoints.

**6.4 Trash that never empties.** The freedesktop spec leaves cleanup to the implementation. Cloud soft delete keeps costing money until retention ends (GCS) and S3 versions accrue until lifecycle rules remove them. There is also a privacy angle: GDPR Article 17 says the controller must erase personal data "without undue delay" when one of its grounds applies ([Art. 17](https://gdpr-info.eu/art-17-gdpr/)). **(inference)** A soft-delete store that still holds personal data after an erasure request is not erased; I am not offering legal advice, only noting that a retention window and an erasure obligation have to be reconciled by design, for example with a purge path that can bypass the window for such data. Whether that path exists depends on the backend: GCS says a soft-deleted object cannot be permanently deleted during its retention, and a shorter retention applies only to objects deleted after the change, so for data that may face erasure requests the store and its retention have to be chosen before the data goes in. Mitigation: every trash has a bounded retention, a sweeper, and a visible size.

**6.5 Compensations that fail.** Stripe's refund page lists refund failure reasons (closed account, expired or cancelled card, declined by partners), notes that failed refund funds can take up to 30 days to return to the platform balance, and says some card refunds can be cancelled for a short period, through the Dashboard only. A compensation is an action with its own failure modes and its own tier. Mitigation: the compensator is logged like any action, retried idempotently, and its failure becomes a visible incident, not a quiet "undo failed" line.

**6.6 Safety flags the agent can flip.** Compute Engine deletion protection can be reset by a user holding a role with the create permission; RDS lets a caller skip the final snapshot. If the agent holds these permissions, protection is advisory. Mitigation: split credentials by capability so the agent's day-to-day identity cannot remove protection, and put removal of protection in the confirmation-required set.

**6.7 Retry after undo.** An agent that is told to retry after an undo can redo the thing the owner just reversed, especially from a scheduled job. Mitigation: the undo writes a tombstone (action id, "owner reversed this") that the retrying code checks, and idempotency keys are not reused after an undo. **(inference; I found no source that treats this specifically.)**

**6.8 False undo promises in model text.** The agent may describe an action as reversible when the runtime has no record that makes it so, or claim the opposite. The 2025 incident record above shows the second case. Mitigation: the reversibility statement in an action report comes from the action log's tier and `undo_until`, not from model-generated text.

## 7. A practical playbook for an always-on agent runtime

Build in order of value per unit of complexity. The first three need no new service and cover the commonest accidents.

**Step 1: Tier the action space (a table, not a model).** List the runtime's action kinds (file write, file delete, shell command, git operation, chat send, scheduled job change, component install or remove, credential use) and give each a default tier and the wrapper that promotes it. The runtime assigns tiers; the model does not. Unknown actions default to tier 4.

**Step 2: Replace destructive primitives with reversible ones.**
- Deletes become moves into a trash directory with a trashinfo-style record (original path, time, session).
- File edits in a repository happen in a git-tracked tree; before a task that could delete or overwrite, capture the actual pre-action state, unstaged edits included: a commit, a stash that is re-applied (`-u` for untracked files, `--all` when ignored files are in scope), or a copy of the files at risk. Only then is the file undo tier 1.
- Large batch tasks run in a worktree or after a filesystem snapshot where the host has one.
- Shell is the main gap: intercept destructive patterns in a pre-execution hook (such as Claude Code's `PreToolUse`) and rewrite or snapshot, since file-edit checkpoints do not see shell changes.

**Step 3: Outbox for outward messages to people other than the owner.** Hold for a short, configured window and show the pending notice with a visible Undo in the owner's channel (inline button on Telegram), never in the recipient's. When the hold ends, release only sends the owner already authorized; the rest wait for approval (5.1). Claim, Undo, recovery and sweeping follow the conditional updates in 4.1, and a send with an unknown result is reported, not repeated. Replies to the owner themselves need no hold. For authorized sends, use the platform's native scheduling and cancellation where it exists (Slack), because it survives a runtime restart.

**Step 4: The action log.** One table like the sketch in 4.1 for tier 1 to 3 actions: pre-image reference, inverse, `undo_until`, dependencies, idempotency key. Written before the action. Undo reads it; reports read it.

**Step 5: Reserve confirmation.** Required for: tier 4; third-party-affecting actions the owner has not already authorized, held or not; secret exposure; removal of any safety net; tier 3 actions with known loss. Use the confirmation shape in 5.2. Default to doing nothing on no reply.

**Step 6: Expiry and sweepers.** A scheduled job purges trash and other pre-images past their `undo_until`, writes "expired, not recoverable" on the action record, and removes or disables the undo control; it deletes outbox rows only once they are final (sent, undone, failed), never a held one. A purge that fails, or a pre-image the backend evicted early, is recorded as its own outcome (6.2). Retention values are config, shown to the owner.

**Step 7: Measure.** Count per week: actions by tier; confirmations asked and approval rate by type; undo requests, how many succeeded, how many were "too late"; trash size and oldest item. These tell you which confirmations to retire and which windows are too short.

**Checklist**

- [ ] Every action kind has a runtime-assigned tier; unknown means tier 4.
- [ ] No raw delete on user data without a trash move or a captured pre-image; pre-task snapshots include unstaged edits, untracked files and, when in scope, ignored files.
- [ ] Shell commands are covered by an interception point; file checkpoints are not mistaken for full undo.
- [ ] Messages to other people pass an outbox with a visible, honest undo control on the owner's side; unauthorized sends wait for approval.
- [ ] Claim and Undo are conditional updates on the same row; an unknown send result is reconciled or reported, never blindly re-sent.
- [ ] Each action record has a pre-image reference, an inverse (or none), `undo_until`, dependencies and, where the target honors one, an idempotency key.
- [ ] `undo_until` is bounded by the shortest retention underneath it, checked at action time.
- [ ] Safety flags (deletion protection, final snapshots, retention) cannot be changed by the agent's everyday identity.
- [ ] Confirmations state consequences, name what cannot be undone, and default to doing nothing.
- [ ] Expired pre-images and final outbox rows are really deleted, held rows never are, and the owner is told when undo is gone.
- [ ] Compensations are logged, idempotent and surface failures.
- [ ] Reversibility statements in reports come from the log, not model text.

## References

- Nielsen Norman Group. "10 Usability Heuristics for User Interface Design." https://www.nngroup.com/articles/ten-usability-heuristics/
- Nielsen Norman Group. "Confirmation Dialogs Can Prevent User Errors — If Not Overused." https://www.nngroup.com/articles/confirmation-dialog/
- Aza Raskin. "Never Use a Warning When you Mean Undo." A List Apart. https://alistapart.com/article/neveruseawarning/
- Google. "Send or unsend Gmail messages" (Gmail Help). https://support.google.com/mail/answer/1284885
- Official Gmail Blog. "New in Labs: Undo Send" (2009-03-19). https://gmail.googleblog.com/2009/03/new-in-labs-undo-send.html
- Telegram Bot API (`deleteMessage`, `editMessageText`, `sendMessage`, `InlineKeyboardMarkup`, `answerCallbackQuery`). https://core.telegram.org/bots/api
- Slack API reference. `chat.delete`. https://docs.slack.dev/reference/methods/chat.delete
- Slack API reference. `chat.scheduleMessage`. https://docs.slack.dev/reference/methods/chat.scheduleMessage
- Feishu Open Platform. Recall message. https://open.feishu.cn/document/server-docs/im-v1/message/delete
- Feishu Open Platform. Edit message. https://open.feishu.cn/document/server-docs/im-v1/message/update
- Anthropic. Claude Code checkpointing. https://code.claude.com/docs/en/checkpointing
- Anthropic. Claude Code hooks reference. https://code.claude.com/docs/en/hooks
- Git. git-restore. https://git-scm.com/docs/git-restore
- Git. git-stash. https://git-scm.com/docs/git-stash
- Git. git-reflog. https://git-scm.com/docs/git-reflog
- Git. git-gc. https://git-scm.com/docs/git-gc
- Git. git-clean. https://git-scm.com/docs/git-clean
- Git. git-worktree. https://git-scm.com/docs/git-worktree
- Btrfs documentation. Subvolumes and snapshots. https://btrfs.readthedocs.io/en/latest/Subvolumes.html
- OpenZFS. zfs-rollback(8). https://openzfs.github.io/openzfs-docs/man/master/8/zfs-rollback.8.html
- PostgreSQL documentation. Continuous archiving and point-in-time recovery. https://www.postgresql.org/docs/current/continuous-archiving.html
- Google Cloud. Cloud Storage soft delete. https://docs.cloud.google.com/storage/docs/soft-delete
- Amazon. S3 Versioning. https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html
- Google Cloud. Preventing accidental VM deletion. https://docs.cloud.google.com/compute/docs/instances/preventing-accidental-vm-deletion
- Amazon. Deleting a DB instance (RDS). https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_DeleteInstance.html
- freedesktop.org. Trash specification. https://specifications.freedesktop.org/trash/latest/
- Stripe. Place a hold on a payment method. https://docs.stripe.com/payments/place-a-hold-on-a-payment-method
- Stripe. Refund and cancel payments. https://docs.stripe.com/refunds
- Stripe. Idempotent requests. https://docs.stripe.com/api/idempotent_requests
- GDPR Article 17, right to erasure. https://gdpr-info.eu/art-17-gdpr/
- AI Incident Database. Incident 1152. https://incidentdatabase.ai/cite/1152/
