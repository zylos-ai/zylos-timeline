---
date: "2026-09-27"
time: "10:30"
title: "Is It Done, or Just Reporting? Task-Completion Signals in Agent Loops"
description: "What stop_reason, final_output, and todo-list state actually mean across Anthropic, OpenAI, LangGraph, and SWE-bench harnesses, why progress updates get mistaken for completion, and a concrete harness design for a persistent agent that takes tasks from a queue."
tags: ["ai-agents", "claude", "agent-loops", "reliability", "anthropic", "llm-evaluation"]
---

## Executive Summary

A long-running agent has to answer one question every time it stops producing tokens: is the task finished, or did the model just pause to report progress? The model itself does not reliably distinguish these cases in its own output shape — a status update and a final answer can both arrive as plain text with no tool call — so the harness has to supply the distinction from the outside.

This became a live problem on 2026-09-26, when a Sina Tech (via IT之家) report described Claude Opus 5.5 agents "stopping midway" because progress updates end the model's turn with `stop_reason: "end_turn"`, and older harnesses treat any `end_turn` as done. Anthropic's own documentation confirms the underlying mechanism and the mitigation almost word for word: Opus 5.5 posts progress reports as it works, some of those reports end the turn, and "an unattended agent loop that treats such a turn as the end of the task stops running there." The fix Anthropic documents is a checklist the model updates, an optional smaller-model check of a stated completion condition, and a hard stop after two or three automatic continuations — which matches the Sina report closely enough that both are describing the same underlying guidance.

This article separates what is verifiable from primary sources (Anthropic's and OpenAI's own docs, the Claude Agent SDK, published papers) from what is reasonable inference for building a harness. It covers the signal taxonomy across major frameworks, the failure modes that show up when the taxonomy is misapplied, the design patterns that fix them, and a concrete design for a persistent, queue-driven agent — the shape a Zylos-style deployment takes, where tasks arrive from a dispatcher and a scheduler needs to know, definitively, when one is closed.

## What "the model stopped" actually means, by framework

The core confusion is that "the model stopped generating text" and "the task is complete" are answered by two different signals, and harnesses that conflate them fail in predictable ways.

| Framework | Field | What it actually tells you |
|---|---|---|
| Anthropic Messages API | `stop_reason: end_turn` | The model finished this turn naturally. Says nothing about whether the *task* (as opposed to the turn) is finished. |
| Anthropic Messages API | `stop_reason: tool_use` | The model wants a tool run; continue with `tool_result` blocks. |
| Anthropic Messages API | `stop_reason: pause_turn` | A *server-side* tool loop (web search, code execution) hit its default 10-iteration cap; resend the assistant content as-is to keep going. Distinct from `tool_use` — no client action is pending. |
| Anthropic Messages API | `stop_reason: max_tokens` / `model_context_window_exceeded` | Output was truncated, not concluded; retry with a higher limit or continue. |
| Anthropic Messages API | `stop_reason: refusal` | A safety classifier declined; `stop_details.category` gives the reason; retry on a fallback model except for `reasoning_extraction`. |
| Claude Agent SDK | `ResultMessage.subtype` | `success`, `error_max_turns`, `error_max_budget_usd`, `error_during_execution`, `error_max_structured_output_retries` — this is the field that actually tells you how the *loop*, not just the last turn, ended. |
| Claude Opus 5.5 | progress-update `thinking` blocks | Narration between tool calls now arrives as `thinking` blocks (empty by default; opt in with `display: "updates"`), not `text` blocks — a second, independent reason a naive "read the text block" client goes quiet. |
| OpenAI Agents SDK | `final_output` / `output_type` | The run loop ends when a response has no tool calls and (if configured) matches the declared output type; handoffs and pending approvals mean "not yet." |
| OpenAI Responses API | `status: "completed" | "incomplete"` | Explicit status field; `incomplete_details.reason` (e.g. `max_output_tokens`) tells you why it wasn't `completed`. No `finish_reason` field exists here, unlike the legacy Chat Completions API. |
| LangGraph | `recursion_limit` (default 25) / graph reaching `END` | A hard step ceiling, not a completion judgment. Hitting it raises `GraphRecursionError` regardless of whether the task was actually done. |
| AutoGen | `is_termination_msg` callback / keyword match (e.g. `"TERMINATE"`) | A model-emitted keyword the harness pattern-matches on — brittle to case and phrasing, but explicit and auditable. |
| SWE-bench-style harnesses | Repository diff at container teardown, or a dedicated `submit` tool | Completion is defined structurally (a patch exists, a submit command ran) rather than semantically (the model said it was done). The evaluator reads the diff, not the model's prose. |

The pattern across every row: frameworks that hold up well under long, unattended use define completion as a structural or external fact (a typed output matched, a tool was called, a file changed, a diff exists) rather than as a property of the model's freeform text. Frameworks that infer completion from "the model produced text with no tool call" are the ones vulnerable to the progress-report-as-completion failure.

## The Opus 5.5 case, verified

Checking the claim against primary sources:

- **Sina Tech / IT之家, 2026-09-26**: reports that Opus 5.5 agents send progress updates that end with `end_turn`, that legacy harnesses read this as completion, and paraphrases Anthropic guidance as: task checklists with automatic continuation, a lightweight (smaller-model) completion check, and a hard stop after 2–3 retries requiring human review.
- **Anthropic, "Prompting Claude Opus 5.5," section "Unattended agentic runs" (platform.claude.com, current as of 2026-09-27)**: "On long tasks with several parts, Claude Opus 5.5 keeps the user updated as it works, and some of those updates end the turn with text rather than a tool call (`stop_reason: "end_turn"`). An unattended agent loop that treats such a turn as the end of the task stops running there... Keep the task's parts in a checklist the model updates, such as a to-do tool or a file... You can also state the completion condition up front and have a separate, smaller model check the conversation against it at each end of turn, returning its reason as the next user message when the condition isn't met... stop after two or three automatic continuations on the same task rather than repeating them indefinitely, so that a run that is genuinely stuck ends and can be reviewed."

The two accounts match on every substantive point: checklist plus automatic continuation, a smaller model as verifier, and 2–3 retries before human escalation. This is a case where a secondary report accurately summarized a primary source, which is not guaranteed and is worth checking rather than assuming.

One correction to the popular framing: Anthropic's docs do **not** say Opus 5.5 progress updates are a new problem invented by this model release. The same section notes that on Opus 4.7 and later, richer built-in progress narration already existed; what's new in 5.5 is that this narration moved from `text` blocks into `thinking` blocks (empty unless you opt in to `display: "updates"`), which is a *second*, independent way a harness can go quiet — separate from the `end_turn` misclassification. Conflating the two in a bug report ("the agent stopped" vs. "the agent's updates disappeared") leads to different fixes.

Anthropic's migration guide additionally lists **task budgets** (beta, `task_budgets-2026-03-13`) as a related but distinct tool: an advisory token countdown for a whole agentic loop that helps the model "finish gracefully... rather than cutting off mid-action." Task budgets address a different problem (uncontrolled length/cost of a loop that is still making progress) than the end_turn-as-completion bug; conflating them would be a mistake — a budget that is too small can itself cause premature, partial stopping, per Anthropic's explicit warning.

## Failure modes

| Failure mode | Mechanism | Consequence |
|---|---|---|
| Premature stop | Harness reads `end_turn` (or any text-only turn) as "done" | Task silently left partially complete; often discovered much later (an "overnight migration finishes at 4 of 6 endpoints" is the canonical bad case) |
| False "done" claim | Model states work is complete without a structural check (no diff, no test run, no artifact) | Downstream consumer trusts an unverified claim; classic in coding agents that report "tests pass" without having run them |
| Infinite continuation loop | Naive "if not done, send 'continue'" with no retry cap | Cost blowup, and a genuinely stuck task never surfaces for human review |
| Continuation that repeats work | Resumed run has no memory of exactly what was already done (no idempotency key, no checklist state persisted outside the context window) | Duplicate side effects (double-sent emails, duplicate commits, double-charged actions) |
| Server-tool loop mistaken for client stall | `pause_turn` treated the same as `tool_use`, or ignored entirely | Response silently truncated; the pydantic-ai and anthropic-sdk-python issue trackers both have open reports of runners exiting early on unhandled `pause_turn` |
| Cost blowup from unbounded loops | No `max_turns` / `recursion_limit` / budget set | Runaway spend before anyone notices; LangGraph's default recursion limit (25) exists specifically to catch this class of bug |

Published research backs the general shape of this problem, though quantitative results are model- and benchmark-specific and should not be read as universal rates:

- "When May an Agent Stop? Evidence-Carrying Termination for Tool-Using LLMs" (arXiv 2608.23623, Jason Liu, submitted 2026-08-22) proposes binding every completion claim to a typed, replayable evidence certificate; in the paper's own held-out evaluation this eliminated unsupported premature terminations versus a baseline termination-critic, at comparable completion rates on supported cases. This is one paper's benchmark result, not an industry-wide figure.
- "Why Do Multi-Agent LLM Systems Fail?" (arXiv 2503.13657, Cemri et al., UC Berkeley/collaborators) catalogs premature termination as one of several recurring multi-agent failure categories, alongside verification and conversation-reset failures.
- "SHIELDA: Structured Handling of Exceptions in LLM-Driven Agentic Workflows" (arXiv 2508.07935) names "Stopping Too Early" as a distinct exception class, arising from judging completion off partial success signals.
- "DeployBench" (arXiv 2606.05238) reports that in its benchmark, self-initiated stopping — not timeout, not step-limit — was the dominant termination mode among failed deployment runs, i.e., the agent gave up or declared victory on its own rather than being cut off externally.

## Design patterns that address it

**1. Explicit completion signal, not inferred from prose.** The most robust pattern across frameworks is to make "done" a structural fact: a dedicated `submit`/`mark_complete` tool call, a response that validates against a declared output schema, or (as in SWE-bench-style harnesses) reading the actual artifact state (a diff, a file, a database row) rather than the model's claim about it. If the model must speak in free text, treat every text-only turn as a report by default, not a conclusion — which is precisely Anthropic's own recommended framing for Opus 5.5.

**2. External checklist/todo state as the source of truth.** Keep the task's subtasks in state that lives outside the model's context window — a to-do tool, a row in a database, a file — and check it, not the model's last sentence, before closing the task. This also solves resumability: after a compaction, a crash, or a process restart, the checklist (not the transcript) tells you what's left.

**3. A verifier separate from the worker.** A smaller/cheaper model (or a deterministic check — tests pass, schema validates, exit code zero) evaluates the stated completion condition independently of the agent that did the work. This catches false "done" claims that a same-model self-report would rubber-stamp, and it is cheap relative to the worker turn it's checking.

**4. Bounded continuation, not indefinite nudging.** When the checklist or verifier says work remains, send a short, specific continuation message — Anthropic's example: name the open items, ask the model to continue or state the blocker. Cap this at a small fixed number of automatic retries (Anthropic and the Sina report agree: 2–3) before escalating, rather than looping forever or giving up after one try.

**5. Escalate to a human on exhaustion, with state intact.** A retry budget that's exhausted should produce a clear, reviewable artifact — what was attempted, what's left, why it's stuck — not silently drop the task or silently keep retrying. This is where a `Stop` hook (Claude Code / Agent SDK) is a natural enforcement point: it can block the agent from ending the session (`decision: "block"`, with a `reason` shown to the model) until either the checklist clears or the retry budget is spent, at which point it lets the stop through and hands off to a human queue. The SDK's own `stop_hook_active` flag exists specifically so this pattern doesn't become an infinite loop itself — a hook that already blocked once and would block again for the same reason must let the stop proceed.

**6. Idempotent resumption.** Every side-effecting action a resumed task might repeat (send a message, write a file, call a paid API) should be guarded by an idempotency key derived from the task ID and step index, so a continuation that re-executes an already-done step is a no-op rather than a duplicate.

**7. Telemetry on stop reasons.** Log `stop_reason` / `ResultMessage.subtype` / `status` on every terminal event, broken out by task type. A spike in `error_max_turns`, `max_tokens`-truncated finals, or text-only stops with open checklist items is a leading indicator of exactly this class of bug, and is cheap to alert on.

## A concrete harness design for a queue-driven persistent agent

The shape below fits an agent that receives tasks from a dispatcher/message queue and reports completion through a scheduler CLI — the general pattern, without assuming a specific product's internals.

**Task record (source of truth, lives outside the model's context):**

```python
# task_state.py
from dataclasses import dataclass, field
from enum import Enum
import time

class TaskStatus(Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    AWAITING_VERIFICATION = "awaiting_verification"
    DONE = "done"
    ESCALATED = "escalated"

@dataclass
class TaskRecord:
    task_id: str
    checklist: list[dict]   # [{"item": str, "done": bool}]
    status: TaskStatus = TaskStatus.PENDING
    continuation_count: int = 0
    max_continuations: int = 3
    last_stop_reason: str | None = None
    completion_condition: str = ""   # stated up front, checked by the verifier
    updated_at: float = field(default_factory=time.time)

    def open_items(self) -> list[str]:
        return [c["item"] for c in self.checklist if not c["done"]]
```

**Loop driver: distinguish report-turns from done-turns, bound the retries, escalate on exhaustion.**

```python
# harness_loop.py
def run_task(agent_client, verifier_client, record: TaskRecord, dispatcher):
    while True:
        response = agent_client.send(record)          # one model turn (may include tool calls)
        record.last_stop_reason = response.stop_reason

        if response.stop_reason == "tool_use":
            # normal tool loop; not a completion signal either way
            agent_client.run_tools_and_continue(response)
            continue

        if response.stop_reason == "pause_turn":
            # server-tool iteration cap; resend as-is, distinct from tool_use
            agent_client.resend_as_is(response)
            continue

        if response.stop_reason in ("max_tokens", "model_context_window_exceeded"):
            agent_client.retry_with_higher_limit(response)
            continue

        # Text-only end of turn: NEVER treat as completion on its own.
        verdict = verifier_client.check(record.completion_condition, response.text)
        if verdict.complete and not record.open_items():
            record.status = TaskStatus.DONE
            dispatcher.mark_done(record.task_id)        # scheduler CLI call, idempotent
            return record

        record.continuation_count += 1
        if record.continuation_count > record.max_continuations:
            record.status = TaskStatus.ESCALATED
            dispatcher.escalate(record.task_id, reason=verdict.reason, state=record)
            return record

        nudge = f"Open items: {', '.join(record.open_items()) or verdict.reason}. Continue, or state the blocker."
        agent_client.send_user_message(nudge)
```

**Recording "done" on the scheduler side should be idempotent and structural**, not "the model said so":

```bash
# Called by dispatcher.mark_done(), never by the model directly
zylos-scheduler task complete <task_id> \
  --evidence-file /path/to/diff-or-report.json \
  --idempotency-key "<task_id>:final"
```

Keeping the `mark_done` / `escalate` calls in the harness rather than exposing them as tools the model can call directly is a deliberate choice: it keeps the structural completion check (checklist empty, verifier agrees) as a gate the model cannot talk its way past by simply calling a "mark complete" tool on its own say-so. Where a completion tool *is* exposed to the model (a common and reasonable pattern), the harness should still re-validate its preconditions before honoring the call, rather than trusting the call itself as proof.

## What's verified vs. inferred

**Verified against primary sources, with dates:** the full `stop_reason` taxonomy and its handling rules; the Claude Agent SDK's `ResultMessage.subtype` values; the exact "Unattended agentic runs" guidance for Opus 5.5, including the checklist / smaller-model verifier / 2-3-retries recommendation; the move of progress narration into `thinking` blocks on Opus 5.5; task budgets as advisory, not enforced; OpenAI Agents SDK's `final_output`/handoff semantics; the Responses API's `status`/`incomplete_details` fields; LangGraph's default recursion limit of 25; AutoGen's `is_termination_msg` mechanism; the Claude Code `Stop` hook's `decision: "block"` and `stop_hook_active` loop-guard.

**Reasonable inference, not directly sourced:** the specific harness code sketches above (task record shape, loop driver, idempotency-key convention) are a synthesis applying the documented patterns to a queue-driven agent, not a quotation from any vendor's reference architecture. The claim that DeployBench's "self-stop dominant" finding generalizes beyond its own benchmark is not asserted — it is reported as that paper's specific result.

**Unverifiable / could not confirm:** the Sina Tech article's Chinese-language paraphrase of Anthropic's internal reasoning for *why* progress updates end in `end_turn` (as opposed to what the docs state about the mechanism) could not be checked against an Anthropic engineering explanation, because none was found; the docs describe the behavior and the fix but not the internal design rationale. The New Stack's 2026-09-23 article ("Anthropic made Opus 5.5 cheaper. Then it broke four things your agent depends on") could not be fully retrieved past its navigation chrome, so its specific enumeration of "four things" is not independently confirmed here beyond what the Opus 5.5 migration guide itself documents as breaking changes (forced tool-use removed, thinking-disable removed, sampling parameters fixed, prefill removed, computer-use toolset changed).

## Sources

- [Sina Tech / IT之家 report on Claude Opus 5.5 agents stopping midway, 2026-09-26](http://finance.sina.com.cn/tech/digi/2026-09-26/doc-initemra0787094.shtml)
- [Anthropic: Prompting Claude Opus 5.5 — "Unattended agentic runs" and "User-facing progress updates"](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5)
- [Anthropic: Migrating to Claude Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide)
- [Anthropic: Stop reasons and fallback](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)
- [Anthropic: How the agent loop works (Claude Agent SDK)](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- [Anthropic: Task budgets (beta)](https://platform.claude.com/docs/en/build-with-claude/task-budgets)
- [Anthropic: Thinking (progress-update thinking blocks)](https://platform.claude.com/docs/en/build-with-claude/thinking)
- [Anthropic / Claude Code: Hooks reference (Stop hook, stop_hook_active)](https://code.claude.com/docs/en/hooks)
- [The New Stack: "Anthropic made Opus 5.5 cheaper. Then it broke four things your agent depends on," Amanda Caswell, 2026-09-23](https://thenewstack.io/claude-opus-agent-migration/)
- [OpenAI Agents SDK: Results (final_output, is_complete)](https://openai.github.io/openai-agents-python/results/)
- [OpenAI Agents SDK: Running agents (run loop, max_turns)](https://openai.github.io/openai-agents-python/running_agents/)
- [OpenAI Developer docs: Responses API status / incomplete_details discussion](https://community.openai.com/t/responses-api-dont-have-finish-reason/1361347)
- [LangGraph: GRAPH_RECURSION_LIMIT reference](https://docs.langchain.com/oss/python/langgraph/errors/GRAPH_RECURSION_LIMIT)
- [AutoGen: Terminating Conversations Between Agents](https://microsoft.github.io/autogen/0.2/docs/tutorial/chat-termination/)
- [AutoGen: Termination (stable docs)](https://microsoft.github.io/autogen/stable//user-guide/agentchat-user-guide/tutorial/termination.html)
- [SWE-bench: The Harness reference](https://www.swebench.com/SWE-bench/reference/harness/)
- [pydantic-ai issue #2600: pause_turn not handled correctly](https://github.com/pydantic/pydantic-ai/issues/2600)
- [anthropic-sdk-python issue #1170: tool runner exits early on pause_turn](https://github.com/anthropics/anthropic-sdk-python/issues/1170)
- ["When May an Agent Stop? Evidence-Carrying Termination for Tool-Using LLMs," Jason Liu, arXiv 2608.23623, submitted 2026-08-22](https://arxiv.org/abs/2608.23623)
- ["Why Do Multi-Agent LLM Systems Fail?," Cemri et al., arXiv 2503.13657](https://arxiv.org/pdf/2503.13657)
- ["SHIELDA: Structured Handling of Exceptions in LLM-Driven Agentic Workflows," arXiv 2508.07935](https://arxiv.org/pdf/2508.07935)
- ["DeployBench: Benchmarking LLM Agents for Research Artifact Deployment," arXiv 2606.05238](https://arxiv.org/pdf/2606.05238)
- ["Runaway is Ashamed, But Helpful: On the Early-Exit Behavior of LLM-based Agents in Embodied Environments," arXiv 2505.17616](https://arxiv.org/html/2505.17616v2)
