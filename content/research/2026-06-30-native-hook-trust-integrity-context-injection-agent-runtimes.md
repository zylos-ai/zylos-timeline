---
date: "2026-06-30"
title: "Trusting the Hook: Integrity Gating and Fail-Closed Context Injection in Native Agent Runtime Hooks"
description: "Migrating agent context injection from a prepended text prompt to a runtime's native SessionStart hook turns a soft application concern into a hard runtime-integrity problem — covering hook trust gating, clean-cutover migration, single-fire idempotency, and the discipline of verifying the model actually consumed the injected context, not just that bytes were delivered."
tags: ["ai-agents", "runtime-hooks", "security", "reliability", "context-engineering", "testing"]
---

## Executive Summary

Migrating per-session context injection from a prepended text prompt to a runtime's native `SessionStart` hook is a sound architectural move, but it converts a "soft" application concern into a "hard" runtime-integrity and reliability problem. Native lifecycle hooks (well documented for Claude Code, and now shipping in OpenAI Codex CLI) give you a first-class, runtime-blessed channel to inject identity/memory/state via stdout or an `additionalContext` field. The cost: hooks execute arbitrary local commands at session start, making the hook configuration a genuine supply-chain attack surface — and Claude Code's own 2025–2026 CVE history (CVE-2025-59536, RCE via `SessionStart` hooks) proves the threat is real, not theoretical. The most important and least-appreciated engineering discipline in this migration is the gap between **delivery** ("the hook fired and bytes were emitted," provable from an exit-0 status) and **consumption** ("the model demonstrably read and used the content," provable only behaviorally, via marker-echo probes against a real authenticated model call). This article synthesizes documented runtime behavior with reasoned reliability analysis across six themes, flagging throughout what is externally verifiable versus engineering judgment.

A note on source reliability: several sources surfaced carry 2026 publication dates, and their single-vendor statistics should be treated as directional, not authoritative. Uncertainty is flagged inline and in the closing notes.

## 1. Native Hook Mechanisms

**Claude Code (documented, high confidence).** Claude Code exposes an extensive lifecycle-hook system configured under the `hooks` key in `settings.json`. The canonical reference is now `code.claude.com/docs/en/hooks` (the older `docs.anthropic.com/.../claude-code/hooks` URL redirects there). The event set is large — roughly 27–30 events — spanning session, turn, tool, subagent, and compaction lifecycles: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `StopFailure`, `SubagentStart`/`SubagentStop`, `PreCompact`/`PostCompact`, `InstructionsLoaded`, and more.

For context injection, the key event is `SessionStart`, which is **non-blocking** and carries a `source` field with four documented values:

- `"startup"` — an entirely new session
- `"resume"` — resumed via `--resume`, `--continue`, or `/resume`
- `"clear"` — after `/clear` (context cleared, session continues)
- `"compact"` — after auto or manual context compaction

That same set of strings doubles as the `matcher` filter, so a hook can be scoped to fire only on `startup`. Injection happens two ways: plain **stdout** text (supported for `SessionStart`, `Setup`, `SubagentStart`) is auto-injected as context; or a JSON object with `hookSpecificOutput.additionalContext` (universal across events). The official schema also shows a top-level `additionalContext` shorthand, but the nested `hookSpecificOutput` form is the canonical, safer choice. Injected content is delivered as a system-reminder-like block visible to the model but not rendered as a chat turn — functionally equivalent to prepending to the system context, which is precisely the migration target.

**Timeout behavior (documented, with one inference).** Default timeout for `command`/`http`/`mcp_tool` handlers is 600s; `prompt` is 30s and `agent` is 60s, with per-event overrides (e.g., `UserPromptSubmit` drops to 30s). The system is **fail-open by default**: only exit code `2` (command hooks) or an explicit `"continue": false` / `"decision": "block"` (JSON) halts execution. A timeout or any other non-zero exit is treated as a non-blocking error — stderr surfaces in verbose mode and the session proceeds. This is not labeled "fail-open" in the docs but follows directly from the exit-code semantics. `PreCompact` cannot block compaction even with exit 2.

**OpenAI Codex CLI (documented, high confidence).** Contrary to a common assumption that Codex lacks hooks, the official docs at `developers.openai.com/codex/hooks` describe a shipping hooks system with ~9 events including `SessionStart`, `PreToolUse`/`PostToolUse`, `PermissionRequest`, `PreCompact`/`PostCompact`, `UserPromptSubmit`, and `Stop`. Configuration lives in `~/.codex/hooks.json` (JSON) or inline in `config.toml`, with a familiar `matcher` + `hooks[]` + `type: "command"` + `timeout` shape. Critically, Codex's `SessionStart` can return `additionalContext` (model-visible) and `systemMessage` (user-visible) — architecturally identical to Claude Code's injection. Higher-level task/plan lifecycle hooks (`TaskCreated`, `PlanUpdated`, etc.) were proposed in GitHub issue #24547 but do **not** yet exist; a community PR (#9796) adding a broader hooks system was closed by maintainers.

**Comparable mechanisms.** VS Code's `activationEvents` in `package.json` (with `*` forcing startup activation and `activate(context)` as entry point) is the closest structural analogy — declarative trigger plus imperative injection. LangChain's `BaseCallbackHandler` (`on_chain_start`, `on_llm_start`, …) is **observer-only**: it cannot gate or modify execution or inject context, a fundamental difference from agent-runtime hooks. CrewAI offers only crew-boundary `@before_kickoff`/`@after_kickoff`; Semantic Kernel uses synchronous "Filters" (`IFunctionInvocationFilter`) but has no session-start equivalent.

## 2. Hook Trust & Integrity Gating

This is where the migration's premise meets reality and partly diverges from it. **Externally, no cryptographic `trusted_hash`/sha256 fingerprint gating for hook definitions is documented in Claude Code** (confirmed across the official docs, Check Point Research, and General Analysis). Claude Code's trust model is **scope-positional, not hash-based**: a precedence hierarchy — managed/MDM policy > CLI args > `settings.local.json` > `settings.json` > `~/.claude/settings.json` — plus a workspace-trust gate, plus enterprise lockdown flags (`disableAllHooks`, `allowManagedHooksOnly`, `allowManagedPermissionRulesOnly`). The one sha256 that exists in Claude Code keys the credential keychain entry (`SHA256(CLAUDE_CONFIG_DIR)` prefix), not hook integrity (single-source, medium confidence). OpenAI Codex, by contrast, does pair its `hooks.json` with an explicit trust step, which is what makes a hash-gated model concrete on that runtime.

That gap is exactly why a hash-based trust authority is valuable, and the threat is documented: **CVE-2025-59536** (CVSS 8.7) allowed RCE because `SessionStart` hooks in a malicious repo's `.claude/settings.json` executed *before* the trust dialog resolved; **CVE-2026-21852** (CVSS 5.3) exfiltrated API keys via an `ANTHROPIC_BASE_URL` override in the same file. The threat model mirrors npm `postinstall` scripts and the September-2025 "Shai-Hulud" worm: developers treat config files as inert metadata, but they carry executable hooks.

**Reasoned analysis** (engineering judgment, not documented runtime behavior): A fingerprint-gated trust model — store `sha256(hook_definition)`, refuse to execute unless the stored hash matches — directly closes the "config-as-data" blind spot the CVEs exploited. The threat taxonomy has three states, and the *present-but-wrong* case is the dangerous one: a **missing** hash should fail closed (re-establish trust before executing), but a **present-but-corrupted** hash is worse than missing because it can mask tampering if the comparison logic is lax or if a stale/attacker-written hash is silently accepted. The argument for a single trust-authority component re-establishing trust for *all* hooks at every launch — fingerprint-gated so it is zero-cost on the steady state (hashes match → no work) — is a standard centralization-of-security-invariants argument: one audited verifier with one threat model beats N components each rolling their own ad hoc trust, which multiplies the attack surface and guarantees inconsistency. This is the same logic behind centralized policy engines and workspace-trust gates rather than per-extension trust.

## 3. Clean Cutover vs Hedged Fallback

**Documented reliability patterns.** The migration literature gives two relevant frames. Dual-path / parallel-run approaches (Strangler Fig, dark launch, feature-flagged rollout) keep old and new paths alive simultaneously — well-suited to high-risk migrations with weak test coverage (Zalando's Parallel Run pattern is the detailed primary source: both systems run, one is authoritative, results reconciled async, then the scaffolding is deleted). The counterweight is **dual-path drift / technical debt**: every toggle doubles the state space, staging and prod flag states diverge silently, and rollback fails when flag states have diverged (FlagShark; Uber reportedly removed roughly 2,000 stale flags). The **expand-contract** pattern is explicit that the *contract* phase — deleting the old path — is mandatory, not optional, or you convert a temporary parallel state into permanent debt.

**Applied analysis** (engineering judgment). For context injection specifically, a hedged fallback (keep the text-prompt path AND the hook path with runtime detection) carries a uniquely bad failure mode: **double injection**. Unlike a database dual-write where the hazard is inconsistency, here both paths *succeeding* is the failure — the context block lands twice. Given that the new path (a single hook) is small, testable, and self-contained, the reliability calculus favors a **clean cutover with no fallback**, provided the new path is proven by an end-to-end test (Theme 6). A fallback only earns its keep when the new path is hard to verify; a `SessionStart` hook is not. The correct failure posture is **fail-closed**: if the hook does not fire (no context injected), the agent should refuse to proceed rather than start half-initialized and act confidently on missing identity/memory — the same logic as authorization systems, where a blocked action can be re-evaluated, but an unauthorized action that took effect cannot be retracted.

## 4. Idempotency / Single-Fire

**Why exactly-once matters.** `SessionStart` fires on `startup`, `resume`, `clear`, *and* `compact` (Theme 1). A naive hook injects on all four — so a single long session that compacts twice and resumes once could inject the bootstrap block four times. The consequence is not benign: LLMs exhibit a **primacy effect** and weight early/repeated context as emphasis, so duplicate injection does not average out — it amplifies, wastes tokens, and (if migration drift made the copies differ) introduces contradictory instructions the model cannot adjudicate.

**Documented + reasoned.** Distributed-systems consensus is that true exactly-once delivery is impossible (the Two Generals problem); the practical target is **"effectively exactly-once" = at-least-once delivery + idempotent processing**. Translated to injection: design the hook to be idempotent rather than to fire exactly once. Two concrete techniques: (a) **matcher scoping** — register the injection hook only for `matcher: "startup"`, deliberately *not* `resume`/`compact`, so resumed sessions (which retain prior context) and compactions (which the runtime handles) don't re-bootstrap; (b) an **idempotency guard / dedup key** — write a per-session sentinel (keyed on `session_id`, available in every hook's stdin payload) and skip injection if already present, making the operation safe under at-least-once firing. Which events legitimately need re-injection is a judgment call: after `compact`, critical identity may have been summarized away and a *targeted* re-inject of just the essentials can be warranted — but that should be a distinct, smaller payload, not a re-run of the full startup bootstrap.

## 5. Delivery vs Consumption — The Verification Discipline

This deserves the strongest treatment because it is a genuine, named, and largely unsolved problem at the tooling layer. Multiple sources confirm the asymmetry: a hook exiting status 0 with a "Hook command completed with status 0" debug line proves bytes were emitted, **not** that the model read them. The analogy holds precisely: trust establishing + hook executing + content emitting proves "the plug fits the socket"; only a model response that demonstrably reflects injected content proves "the light turns on."

The reason this is hard is structural: **the model API does not echo back the system prompt or input messages** — the response carries only output content, `usage.input_tokens`/`output_tokens`, `model`, `id`, and `stop_reason` (high confidence). So `input_tokens` confirms *some* tokens were consumed but not *what*. The only ground-truth record of "what the model saw" lives client-side, in the request object (captured by tools like Langfuse/LangSmith or via OpenTelemetry GenAI conventions, e.g. `gen_ai.system_instructions`, which require opt-in content capture).

**The verification toolkit** (documented techniques; the adaptation to injection testing is reasoned):

- **Marker-echo / canary probe.** Generate a high-entropy sentinel (`openssl rand -hex 6` → e.g. `CANARY-7B3F-922A`), deliver it *only* via the injection path (never in the prompt), and issue a probe prompt asking the model to echo it. Presence in the output = confirmed consumption; absence = the injection was ignored or never reached the model. This is the canary-token technique (OWASP-tracked) repurposed from leak-detection into a positive consumption test.
- **Needle-in-a-haystack (NIAH).** The canonical long-context recall test; for injection testing, embed a unique fact in the injected block and require retrieval.
- **Faithfulness probe.** Inject a *synthetic/false* fact and check whether the model reports it (consumed context) versus answers from parametric memory (ignored it) — NIAH at the semantic level.
- **Session-id linkage.** Prove the injection `session_id` equals the authenticated response's conversation/trace id, so you are testing one continuous session, not two unlinked ones. OpenTelemetry conversation-id / baggage propagation is the documented vehicle.
- **Isolation.** Run the smoke test in a container with `--network` controls, read-only credential mounts, and synthetic memory/state fixtures so no real secrets or real memory are touched; assert the host credential file's sha256 is unchanged pre/post. Anthropic's own eval guidance mandates a clean environment per trial to avoid correlated failures.

**Generalized principle:** *verify consumption, not just delivery.* None of these are deterministic proofs — LLM attention is unobservable from outside the model — so they are strong behavioral indicators, best run as a real-model end-to-end smoke test in CI, not a unit test against a stubbed runtime. This is the same integrity concern that plagues eval harnesses: a green test that only proves the plumbing connected, not that the model behaved differently because of the injected content, is a false signal.

## 6. Practical Takeaways for Builders

- **Use the native `SessionStart` hook** as the injection channel (Claude Code `additionalContext`; Codex `additionalContext`/`systemMessage`) — it outranks `CLAUDE.md`-style instructions the model can deprioritize.
- **Scope by `source`.** Register injection on `matcher: "startup"` only; decide deliberately whether `resume`/`compact` need a smaller targeted re-inject. Never blanket-fire on all four.
- **Make injection idempotent.** Guard on a per-`session_id` sentinel so at-least-once firing can't double-bootstrap.
- **Cut over cleanly; delete the old text-prompt path.** Dual paths risk double injection and untested branches. The new path is small enough to prove.
- **Fail closed.** If the hook doesn't fire or trust can't be established, refuse to start rather than run half-initialized.
- **Treat hook config as executable code, not metadata.** Gate it: fingerprint/hash-verify hook definitions (or centralize trust in one audited authority that re-validates all hooks per launch, zero-cost when hashes match), prefer managed/`allowManagedHooksOnly` in shared repos, and review `.claude/settings.json` like you review `package.json` scripts. Remember CVE-2025-59536.
- **Verify consumption, not delivery.** Ship a real-model E2E smoke test: inject a unique marker via the hook only, probe the model to echo it, assert session-id linkage, run in an isolated container with read-only synthetic credentials, and check host credential sha256 unchanged.
- **Capture what the model saw client-side.** The API won't echo it back — instrument with OTel GenAI conventions or a tracing tool so injected context is observable.

## Sources

**Native hook mechanisms**
- Claude Code Hooks reference (official): https://code.claude.com/docs/en/hooks
- Claude Code Settings (official): https://code.claude.com/docs/en/settings
- OpenAI Codex Hooks (official): https://developers.openai.com/codex/hooks
- OpenAI Codex Advanced Config: https://developers.openai.com/codex/config-advanced
- Codex hooks proposals: https://github.com/openai/codex/issues/24547 ; https://github.com/openai/codex/pull/9796
- VS Code Activation Events: https://code.visualstudio.com/api/references/activation-events
- LangChain BaseCallbackHandler: https://python.langchain.com/api_reference/core/callbacks/langchain_core.callbacks.base.BaseCallbackHandler.html
- CrewAI kickoff hooks: https://docs.crewai.com/en/learn/before-and-after-kickoff-hooks
- SessionStart context injection (third-party): https://www.mindstudio.ai/blog/session-start-hooks-claude-code-force-context

**Trust & integrity**
- Claude Code Permissions (official): https://code.claude.com/docs/en/permissions
- Check Point Research, CVE-2025-59536 / CVE-2026-21852: https://research.checkpoint.com/2026/rce-and-api-token-exfiltration-through-claude-code-project-files-cve-2025-59536/
- MintMCP hooks security: https://www.mintmcp.com/blog/claude-code-hooks-security
- General Analysis (managed vs repo hooks): https://generalanalysis.com/guides/claude-code-settings-permissions-bash-tool-security
- VS Code Workspace Trust: https://code.visualstudio.com/docs/editing/workspaces/workspace-trust
- Unit 42 npm supply chain: https://unit42.paloaltonetworks.com/monitoring-npm-supply-chain-attacks/

**Migration & idempotency**
- AWS Strangler Fig: https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/strangler-fig.html
- Azure Strangler Fig: https://learn.microsoft.com/en-us/azure/architecture/patterns/strangler-fig
- Fail open vs fail closed: https://read.thecoder.cafe/p/fail-open-fail-closed ; https://authzed.com/blog/fail-open
- Zalando Parallel Run: https://engineering.zalando.com/posts/2021/11/parallel-run.html
- LaunchDarkly dark launching: https://launchdarkly.com/blog/guide-to-dark-launching/
- FlagShark feature-flag debt: https://flagshark.com/blog/feature-flag-technical-debt-guide/
- Confluent dual-write problem: https://www.confluent.io/blog/dual-write-problem/
- Idempotency: https://particular.net/blog/what-does-idempotent-mean
- Expand-contract: https://schemasmith.com/guides/zero-downtime-database-migrations.html

**Delivery vs consumption verification**
- Anthropic, Demystifying Evals for AI Agents: https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- NIAH / Semantic Masking (ACL 2025): https://aclanthology.org/2025.wraicogs-1.2/
- Canary tokens: https://github.com/deadbits/vigil-llm/blob/main/docs/canarytokens.md
- OTel GenAI conventions: https://greptime.com/blogs/2026-05-09-opentelemetry-genai-semantic-conventions
- Trace-id linkage: https://langwatch.ai/blog/trace-ids-llm-observability-and-distributed-tracing
- Hooks delivery-only guarantee (third-party): https://dev.to/sasha_podles/claude-code-using-hooks-for-guaranteed-context-injection-2jg
- Anthropic token counting: https://docs.anthropic.com/en/docs/build-with-claude/token-counting

*Uncertainty notes: several third-party sources carry 2026 publication dates; their specific statistics are single-vendor and directional only. The claim that Claude Code lacks documented sha256 hook-integrity gating is well-corroborated as of the research date but could change if Anthropic adds such a mechanism post-CVE — verify against current official docs before relying on it.*
