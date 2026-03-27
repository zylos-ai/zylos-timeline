---
date: "2026-03-27"
title: "AI Agent Hooks and Middleware: Runtime Behavior Interception and Control Patterns"
description: "A comprehensive analysis of hooks, middleware chains, and event interception patterns in AI agent runtimes — from Claude Code's conditional hooks to LangChain callbacks and emerging declarative governance layers."
tags: ["ai-agents", "middleware", "hooks", "runtime-architecture", "governance", "claude-code", "tool-use"]
---

## Executive Summary

The shift from LLMs-as-assistants to LLMs-as-autonomous-agents has created an urgent need for behavior interception: developers and operators need to observe what an agent does, modify inputs and outputs at runtime, block dangerous operations, and enforce policy without forking the agent's core logic. The solution, borrowed wholesale from web framework design, is the hooks-and-middleware pattern. In 2025–2026, every major agent runtime — Claude Code, OpenAI Codex CLI, LangChain/LangGraph, Google ADK, AutoGen, and Semantic Kernel — has independently converged on some form of this pattern. This article is a cross-framework technical analysis aimed at practitioners building or operating agentic systems. We cover the full taxonomy of interception patterns, concrete APIs and configuration formats, real-world governance use cases, and the emerging trend of declarative policy-as-code.

---

## 1. The Hooks Pattern: From Web Frameworks to Agent Runtimes

The hooks-and-middleware concept is not new. Express.js popularized the request/response pipeline in 2010: every incoming HTTP request traverses an ordered stack of `app.use()` middleware functions, each able to read, mutate, or terminate the chain. Koa went further with its "onion model" — middleware wraps outward layers before _and_ after the core handler, allowing symmetric pre/post logic in a single function. ASP.NET Core's request pipeline formalizes this as `IMiddleware` with `InvokeAsync(ctx, next)`.

Agent runtimes face an analogous problem. A tool call is structurally equivalent to an HTTP request: it has an input (tool name + arguments), a handler (the tool itself), and an output (the result). The same interception needs apply — logging, rate limiting, permission checks, input sanitization, output validation. The difference is that agent pipelines add LLM reasoning steps between tool calls, and the "requests" are generated probabilistically rather than deterministically.

The core pattern maps directly:

```
[Agent Loop]
  User Prompt → [PrePrompt Hooks] → LLM Call → [PostLLM Hooks]
                                                    ↓
                    Tool Call ← [Plan/Decision]
                        ↓
              [PreToolUse Hooks] → Tool Execution → [PostToolUse Hooks]
                        ↓                                  ↓
              Block / Modify / Allow             Log / Validate / Block
```

### Three Fundamental Interception Points

Every framework, regardless of implementation language, exposes variations on three canonical hook positions:

1. **Pre-execution hooks** — run before an action; can read and modify inputs, or block execution entirely
2. **Post-execution hooks** — run after an action completes; can observe outputs, trigger side effects, or retroactively block the result from being fed back to the model
3. **Around hooks** (also called wrap-style hooks) — wrap execution, receiving both the input and a `next()` continuation, enabling symmetric pre/post logic and the ability to retry or replace the handler

---

## 2. Claude Code: The Most Expressive Hook System

Claude Code's hooks system (introduced at scale in v2.0.x, significantly expanded through v2.1.x) is among the most comprehensive hook architectures in any agent CLI. As of early 2026, it exposes **25 distinct hook event types** across five categories.

### 2.1 Hook Event Taxonomy

**Lifecycle events:** `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`, `StopFailure`

**Tool events (the core interception points):** `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`

**Agent coordination events:** `SubagentStart`, `SubagentStop`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`

**Environment events:** `FileChanged`, `CwdChanged`, `ConfigChange`, `InstructionsLoaded`

**Context/system events:** `Notification`, `PreCompact`, `PostCompact`, `WorktreeCreate`, `WorktreeRemove`, `Elicitation`, `ElicitationResult`

### 2.2 Configuration Format

Hooks are defined in JSON at three scope levels, following a standard hierarchy:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/validate-bash.sh",
            "timeout": 10,
            "statusMessage": "Validating command..."
          }
        ]
      },
      {
        "matcher": "mcp__.*__write.*",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:3000/validate",
            "headers": { "Authorization": "Bearer $AUTH_TOKEN" },
            "allowedEnvVars": ["AUTH_TOKEN"],
            "timeout": 15
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "prettier --write",
            "async": true
          }
        ]
      }
    ]
  }
}
```

**Scope hierarchy** (inner overrides outer): user settings (`~/.claude/settings.json`) → project settings (`.claude/settings.json`) → local project settings (`.claude/settings.local.json`) → plugin hooks → session hooks.

**Matchers** are regex strings applied against context-specific values: tool name for `PreToolUse`/`PostToolUse`, file basename for `FileChanged`, config source for `ConfigChange`, error type for `StopFailure`. Using `"*"`, `""`, or omitting the `matcher` field matches all occurrences.

### 2.3 Four Handler Types

Claude Code offers four fundamentally different handler execution models:

| Handler Type | Execution | Input | Output | Use Case |
|---|---|---|---|---|
| `command` | Shell subprocess | JSON via stdin | JSON via stdout; exit code signals | Validation scripts, formatters, loggers |
| `http` | HTTP POST | JSON as body | JSON response body | External policy engines, audit systems |
| `prompt` | LLM call | JSON + prompt template | Yes/no decision | Semantic validation, context-aware checks |
| `agent` | Subagent with tools | JSON + prompt | Decision after tool use | File inspection, complex policy checks |

The `agent` type is particularly powerful: it spawns a Claude subagent with access to `Read`, `Grep`, and `Glob` tools, enabling the hook to inspect the codebase before deciding whether to allow an operation.

### 2.4 Decision Control: The Exit Code Protocol

For command hooks, Claude Code uses exit codes as the control signal:

- **Exit 0:** Success; stdout is parsed as JSON for structured output
- **Exit 2:** Blocking error; stderr is fed back to the model as a refusal reason
- **Any other exit code:** Non-blocking error; execution continues

This maps directly to HTTP status codes in web middleware — 200 means proceed, 4xx means client error (block), and non-2xx non-4xx means warn but continue.

For blocking a `PreToolUse`, the structured JSON output pattern is:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Destructive rm -rf blocked by safety policy"
  }
}
```

For input modification (available since v2.0.10), the `updatedInput` field allows the hook to silently rewrite tool arguments before execution — for example, automatically adding `--dry-run` to package manager commands:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "updatedInput": {
      "command": "npm install --dry-run react"
    }
  }
}
```

### 2.5 The PermissionRequest Hook

The `PermissionRequest` hook (introduced in v2.0.45) is a higher-level interception point that fires when Claude Code's native permission system would normally show a confirmation dialog. This hook can programmatically approve, deny, or even add new permission rules to the session:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow",
      "updatedPermissions": [
        {
          "type": "addRules",
          "rules": [{ "toolName": "Bash", "ruleContent": "npm test" }],
          "behavior": "allow",
          "destination": "session"
        }
      ]
    }
  }
}
```

This pattern enables fully automated CI/CD pipelines where all permission prompts are pre-approved based on declarative rules, without requiring interactive human approval.

---

## 3. OpenAI Codex CLI: Approval Modes and Lifecycle Hooks

Codex CLI takes a different architectural stance: rather than a rich hooks DSL, it exposes a coarser-grained approval policy system that controls when the agent pauses for human input, combined with an emerging `hooks.json` lifecycle hook system.

### 3.1 Approval Modes

Three primary modes govern tool execution behavior:

- **`on-request`** (default): Codex pauses before any action outside sandbox boundaries, presenting the proposed command for human review
- **`untrusted`**: Read-only file operations run automatically; anything that mutates state requires approval
- **`never`**: All approvals suppressed (suitable for fully automated pipelines with other safeguards)

```toml
# ~/.codex/config.toml
approval_policy = "on-request"
sandbox_mode = "workspace-write"
```

### 3.2 Granular Approval Policies

For production deployments, Codex supports a structured granular policy that gives fine-grained control over which categories of approval prompts fire:

```toml
approval_policy = { granular = {
  sandbox_approval = true,      # Approve sandbox escapes
  rules = true,                 # Approve rule-based operations
  mcp_elicitations = true,      # Approve MCP tool input requests
  request_permissions = false,  # Auto-deny permission escalations
  skill_approval = false        # Auto-deny skill activations
} }
```

### 3.3 Destructive Annotations

Codex's MCP tool integration enforces a safety invariant at the protocol level: any MCP tool that advertises a destructive annotation will always require approval, regardless of the current `approval_policy` setting. This is an example of hard-coded policy that cannot be overridden by configuration — a safeguard that cannot be accidentally disabled.

### 3.4 The Emerging hooks.json System

Codex is developing a lifecycle hook system loaded from `hooks.json`, currently in development and off by default. The system aims to provide the same pre/post execution interception that Claude Code's `PreToolUse`/`PostToolUse` events offer. The `request_permissions` built-in tool allows running agents to request permission elevation at runtime, with a TUI approval flow that can be embedded in the hook chain.

---

## 4. LangChain/LangGraph: Middleware Chains for Agent Loops

LangChain 1.0 introduced a first-class `Middleware` abstraction that formalizes the "onion model" for agent loops. Where Claude Code's hooks operate on individual tool calls, LangChain middleware operates at the model-call boundary — the point where the agent's reasoning happens.

### 4.1 The Middleware Interface

Every LangChain middleware can implement three hooks:

```python
class AgentMiddleware:
    async def before_model(self, state, config):
        """
        Runs before each model invocation.
        Can update state or redirect to a different node.
        Return None to proceed normally.
        """
        pass

    async def modify_model_request(self, request, config):
        """
        Runs before model execution. Modifies the actual LLM request.
        Can change: tools, prompt, message list, model, settings, output format, tool_choice.
        """
        return request

    async def after_model(self, state, response, config):
        """
        Runs after model call, in REVERSE middleware order.
        Can update state or redirect flow.
        """
        pass
```

**Execution order:** `before_model` runs sequentially (first registered, first executed) on the way _in_ to the model. `after_model` runs in reverse order (last registered, first executed) on the way _out_ — the classic "onion" pattern familiar from Koa.js.

### 4.2 Built-in Middleware

LangChain ships several production-ready middleware implementations:

- **Human-in-the-loop middleware:** Uses `after_model` to inspect tool calls and inject an interrupt when the agent proposes an action that requires human confirmation. This is the clean middleware-based replacement for the old `interrupt_before` graph node approach.
- **Summarization middleware:** Uses `before_model` to detect when accumulated message history exceeds a threshold and compresses old turns into a summary, preventing context overflow.
- **Anthropic Prompt Caching middleware:** Uses `modify_model_request` to inject cache breakpoints into the request, reducing API costs on repeated calls.
- **Model call count tracking:** Enforces per-session limits on LLM invocations.
- **PII detection middleware:** Scans messages for personally identifiable information before they reach the model.
- **Model fallback middleware:** Catches model errors and retries with an alternative model.

### 4.3 Wrap-Style Hooks

For lower-level interception, LangChain also exposes wrap-style hooks:

```python
async def wrap_model_call(model_call, request, config):
    """Wraps the actual model call — enables retries, caching, circuit breaking."""
    try:
        response = await model_call(request)
        return response
    except RateLimitError:
        await asyncio.sleep(2)
        return await model_call(request)

async def wrap_tool_call(tool_call, tool_name, tool_input, config):
    """Wraps individual tool execution — enables per-tool rate limiting, logging."""
    start = time.time()
    result = await tool_call(tool_name, tool_input)
    metrics.record(tool_name, time.time() - start)
    return result
```

### 4.4 LangChain Callbacks: The Legacy Layer

Beneath the new Middleware API sits the older `BaseCallbackHandler` system, which predates LangGraph and remains widely used. The callback interface is event-based rather than middleware-style: handlers subscribe to events like `on_llm_start`, `on_llm_end`, `on_tool_start`, `on_tool_end`, `on_agent_action`, and `on_agent_finish`. Callbacks are primarily observational — they cannot block execution or modify inputs — making them appropriate for logging, tracing, and metrics but insufficient for policy enforcement.

---

## 5. Google ADK: Symmetric Callback Signatures

Google's Agent Development Kit takes a clean, symmetric approach to lifecycle hooks. Every major execution boundary exposes a matching before/after pair, each with a consistent signature pattern.

### 5.1 The Six Core Callbacks

```python
# Agent lifecycle
def before_agent_callback(ctx: CallbackContext) -> Optional[Content]:
    """Return Content to skip agent; None to proceed."""

def after_agent_callback(ctx: CallbackContext) -> Optional[Content]:
    """Return Content to replace output; None to use agent's result."""

# LLM boundary
def before_model_callback(ctx: CallbackContext, req: LlmRequest) -> Optional[LlmResponse]:
    """Modify req in-place, or return LlmResponse to bypass LLM entirely."""

def after_model_callback(ctx: CallbackContext, resp: LlmResponse) -> Optional[LlmResponse]:
    """Return modified LlmResponse to replace output; None to use LLM's result."""

# Tool boundary
def before_tool_callback(ctx: CallbackContext, req: ToolRequest) -> Optional[ToolResponse]:
    """Return ToolResponse to skip tool; None to execute normally."""

def after_tool_callback(ctx: CallbackContext, resp: ToolResponse) -> Optional[ToolResponse]:
    """Return modified ToolResponse to replace output; None to use tool's result."""
```

The return-value convention is elegantly consistent: returning `None` from any callback means "proceed normally," while returning a typed response object means "short-circuit and use this instead." This pattern avoids the exit-code confusion of shell-based hooks and the exception-as-control-flow anti-pattern common in older frameworks.

### 5.2 Practical Patterns

The ADK `before_model_callback` is the natural place for guardrails: inspect the LLM request, check for policy violations, and return a synthetic refusal response without ever hitting the API. The `before_tool_callback` handles permission checks and rate limiting at the tool level. The `after_model_callback` is the right layer for output sanitization — detecting PII, profanity, or policy violations in model responses before they propagate downstream.

---

## 6. AutoGen for .NET: LIFO Middleware Stacks

Microsoft's AutoGen framework (both the Python v0.4 event-driven version and the .NET version) implements middleware as a composable stack with explicit ordering semantics.

### 6.1 The MiddlewareAgent Pattern

AutoGen wraps any agent in a `MiddlewareAgent` that applies a stack of middleware functions during `GenerateReplyAsync`. Registration is via `.Use()` or `.RegisterMiddleware()`:

```csharp
var agent = new AssistantAgent("assistant", llmConfig: config);

// Add middleware — last registered executes first (LIFO)
var middlewareAgent = agent
    .RegisterMiddleware(new LoggingMiddleware())
    .RegisterMiddleware(new RateLimitMiddleware(maxCalls: 10))
    .RegisterMiddleware(new SafetyFilterMiddleware(policy));
```

**LIFO ordering** means the last-registered middleware is the outermost wrapper — it intercepts first on the way in and last on the way out. This is the reverse of Express.js's FIFO ordering and the same as Koa's middleware stack. The practical implication: put your logging middleware last (so it wraps everything), your safety filter earlier (so safety runs closer to the core).

### 6.2 Built-in Middleware

AutoGen.Net ships `FunctionCallMiddleware` (enables tool/function invocation), `HumanInputMiddleware` (inserts human approval gates), and `OpenAIChatRequestMessageConnector` (adapts streaming message types). The pattern enables composable customization without subclassing the core agent.

### 6.3 AutoGen Python v0.4: Event-Driven Hooks

The Python v0.4 rewrite adopts an asynchronous, event-driven architecture rather than the synchronous middleware chain model. Agents communicate via typed messages over an event bus, and "hooks" become message interceptors registered with the runtime. The `process_message_before_send` hook on `ConversableAgent` enables message transformation before delivery. This model scales better for distributed multi-agent systems but sacrifices the familiar synchronous middleware composition.

---

## 7. Semantic Kernel: Nested Filter Pipeline

Microsoft's Semantic Kernel uses the term "filters" rather than "hooks" or "middleware," but the mechanism is identical. Filters wrap kernel function invocations in nested layers.

### 7.1 Filter Registration

```csharp
kernel.FunctionFilters.Add(new LoggingFilter());
kernel.FunctionFilters.Add(new SafetyFilter(policy));
kernel.PromptFilters.Add(new PiiDetectionFilter());
```

When multiple filters are registered, they are **nested**: function filters form the outer layer, prompt filters the inner layer. Each filter receives a context and a `next` delegate — the classic middleware signature.

### 7.2 Pipeline Events

SK exposes execution events at both function and prompt boundaries: `before_function_invocation`, `after_function_invocation`, `before_prompt_render`, `after_prompt_render`. The filter architecture applies automatically to all kernel functions, meaning any tool registered as a SK plugin inherits the safety and logging filters without additional configuration.

As of Q1 2025, the SK Agent Framework reached general availability, with the Process Framework (a durable workflow execution layer built on top of SK's filter pipeline) released from preview in Q2 2025.

---

## 8. Policy Enforcement: Hooks as a Governance Layer

The most compelling production use case for hooks is not logging or formatting — it is policy enforcement. As agents take on consequential actions (database writes, API calls, file system modifications, financial transactions), organizations need deterministic control planes that sit outside the agent's own reasoning.

### 8.1 The Governor Pattern

The "Governor" is an architectural pattern where a dedicated policy component intercepts all agent actions before execution. Unlike the agent itself (which is probabilistic), the Governor is deterministic: it evaluates each proposed action against a policy specification and returns allow/deny/modify.

Implementations vary:
- **Hook scripts** (Claude Code): Shell scripts that inspect `tool_input` JSON and exit with code 0 or 2
- **HTTP policy engines** (Claude Code HTTP hooks, LangChain custom middleware): External services implementing Open Policy Agent (OPA) or Cedar policies
- **Inline middleware** (LangChain, ADK, SK): Python/C# code registered in the middleware stack
- **Gateway-level interception** (AWS Bedrock AgentCore): Infrastructure-layer enforcement outside agent code entirely

### 8.2 AWS Bedrock AgentCore Policy (GA: March 2026)

Amazon's AgentCore Policy system, which reached general availability in March 2026, represents the most enterprise-grade implementation of the governance-via-hooks pattern. Its key innovation is that policy enforcement happens **at the infrastructure boundary** — the AgentCore Gateway intercepts all agent-to-tool traffic at the network level, not within the agent's code:

- Policies are written in Cedar (AWS's open-source policy language) or generated from natural language prompts
- Every request is evaluated against the policy engine before tool access is granted
- All enforcement decisions are logged to CloudWatch for audit trails
- Policies apply consistently across all agents using the gateway, regardless of agent implementation language or framework

This represents the endpoint of the evolution: hooks move from application code (LangChain callbacks, 2023) → CLI configuration (Claude Code settings.json hooks, 2024) → infrastructure enforcement (Bedrock AgentCore Gateway, 2026).

### 8.3 Policy-as-Code for Hooks

The broader "policy-as-code" movement (Open Policy Agent, Cedar, Sentinel) is converging with agent governance. The pattern:

1. Express authorization rules in a declarative DSL (Cedar, Rego, natural language → Cedar)
2. Store policies in a centralized policy engine (version-controlled, auditable)
3. Enforce at a gateway that intercepts agent traffic (AgentCore Gateway, custom HTTP hook endpoint)
4. Log every decision for compliance

A minimal OPA-based hook for Claude Code:

```bash
#!/bin/bash
# hooks/opa-validate.sh
INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name')
ARGS=$(echo "$INPUT" | jq -c '.tool_input')

DECISION=$(echo '{"input": {"tool": "'"$TOOL"'", "args": '"$ARGS"'}}' | \
  curl -s -X POST http://localhost:8181/v1/data/agent/allow -d @- | \
  jq -r '.result')

if [ "$DECISION" != "true" ]; then
  echo "Action blocked by policy engine" >&2
  exit 2
fi
exit 0
```

---

## 9. Design Trade-offs

### 9.1 Hook Ordering and Priority

Every framework faces the same fundamental ordering question: when multiple hooks match the same event, which executes first and what happens if they conflict?

Claude Code resolves this by executing hooks in the order they appear in the configuration array — earlier hooks in the same event group run first. If a hook blocks execution (exit 2), subsequent hooks do not run. This is predictable but requires careful configuration ordering.

AutoGen.Net's LIFO ordering is counterintuitive for developers familiar with Express.js but aligns with the "outermost wrapper runs first" mental model from object-oriented decorator patterns.

LangChain's `before_model` runs sequentially in registration order; `after_model` runs in reverse. This explicit asymmetry enables the symmetric onion pattern but can surprise developers who expect consistent ordering.

**Best practice:** Define a canonical hook ordering convention in your team's `preferences.md` or equivalent. For example: `[logging → rate-limiting → safety-filter → permission-check → audit-log]` with the understanding that safety blocks execution before reaching audit-log.

### 9.2 Error Handling in Hook Chains

What should happen when a hook itself fails? Options:

- **Fail-open:** Log the error and proceed (acceptable for non-blocking observability hooks)
- **Fail-closed:** Treat hook failure as a block signal (correct for security/safety hooks)
- **Retry:** Retry the hook with backoff (appropriate for transient HTTP hook failures)

Claude Code's non-exit-2 exit codes implement fail-open for non-critical hooks. The HTTP hook type automatically fails-open on connection failure — a deliberate design choice that avoids availability issues when policy servers are down, but means security hooks should not rely on HTTP transport unless an explicit decision payload (`{"decision": "block"}`) is also sent.

### 9.3 Performance Overhead

Every synchronous hook adds latency to the agent loop. For a simple shell-script `PreToolUse` hook, this overhead is typically 20-100ms — negligible for most workflows but significant for high-frequency tool calls in batch pipelines.

Mitigation strategies:
- Use `"async": true` for non-blocking hooks (logging, formatting) that don't need to block execution
- Cache hook decisions for repeated identical tool calls (especially for `PermissionRequest` hooks)
- Move heavy policy logic to a co-located HTTP service rather than a shell script (lower spawn overhead)
- Use the `timeout` field to prevent slow hooks from blocking indefinitely

### 9.4 Composability and the "Too Many Hooks" Anti-Pattern

The primary composability risk in hook systems is that each hook added increases cognitive complexity and reduces debuggability. When five different hooks each modify `tool_input`, understanding the final state requires tracing through all five in order. This is the agent equivalent of the "too many layers" anti-pattern in web middleware.

Indicators of over-hookification:
- Hooks that partially overlap in their concerns (multiple hooks checking for the same dangerous patterns)
- Hooks that depend on execution order in ways that aren't obvious from the configuration
- Hooks that modify the same fields of `tool_input` (last-write-wins creates subtle bugs)

Mitigations:
- **Consolidate related concerns** into a single hook script that handles multiple validation rules
- **Document hook responsibilities** explicitly — each hook should have a single, named responsibility
- **Use the `/hooks` introspection menu** (Claude Code) to audit all active hooks before debugging
- **Version-control hook scripts** alongside the agent configuration that references them

### 9.5 Testability

Well-designed hooks should be independently testable by feeding them synthetic JSON input. A hook that reads tool input from stdin and writes decisions to stdout is trivially testable:

```bash
# Test that rm -rf is blocked
echo '{"tool_name": "Bash", "tool_input": {"command": "rm -rf /"}}' | \
  ./hooks/validate-bash.sh
# Expect exit code 2
```

For middleware in Python frameworks (LangChain, ADK), the callback/middleware interface is testable with mock `CallbackContext` objects — the key is that middleware functions are pure-ish transformations of typed objects, not tightly coupled to the framework's internals.

---

## 10. Emerging Patterns

### 10.1 Declarative Hook Configuration

The trend is clearly toward declarative, data-driven hook configuration rather than imperative code. Claude Code's `settings.json` format is already declarative for the routing layer (which events trigger which handlers) while remaining imperative for the handler logic (shell scripts, Python). The next step is declarative handler logic:

```yaml
# Hypothetical declarative hook policy
hooks:
  PreToolUse:
    - matcher: "Bash"
      policy:
        block_if:
          command_contains: ["rm -rf", "sudo rm", "dd if=", "> /dev/"]
        require_approval_if:
          command_matches: "^npm (install|uninstall)"
        allow_always:
          command_matches: "^(git status|npm test|ls)"
```

AWS AgentCore's Cedar-based policies are the current high-water mark for declarative agent governance. Cedar's policy language expresses authorization rules as readable text that is also machine-verifiable:

```cedar
permit(
  principal == Agent::"my-agent",
  action == Action::"tool:call",
  resource in ResourceGroup::"read-only-tools"
);
forbid(
  principal == Agent::"my-agent",
  action == Action::"tool:call",
  resource == Tool::"bash"
) when { context.command like "*rm -rf*" };
```

### 10.2 Hook Sharing and Composition

Claude Code's plugin/skill system enables distributable hook bundles — a collection of hook scripts plus their `settings.json` configuration, installable as a unit. This is the foundation for a hook marketplace: teams can publish "safety packs," "audit logger packs," or "company-policy packs" as installable plugins.

The equivalent in the Python framework world is pip-installable middleware classes. LangChain's built-in middleware (summarization, PII detection, human-in-the-loop) are effectively a curated "hook marketplace" — community-maintained, versioned, and composable.

### 10.3 Cross-Agent Hook Propagation

Multi-agent systems introduce a new problem: when an orchestrator spawns a subagent, should the subagent inherit the orchestrator's hooks? If the orchestrator has a `PreToolUse` safety hook, does the subagent also get it?

Claude Code's `SubagentStart`/`SubagentStop` hooks enable the orchestrator to observe subagent lifecycle events. Configuration-level hooks defined in `settings.json` automatically apply to all subagents spawned in the same project — this is inheritance by configuration scope.

The emerging A2A (Agent-to-Agent) protocol takes a different approach: each agent publishes its capability and constraint manifest, and the orchestrator uses this to determine what governance the subagent provides internally versus what must be enforced at the handoff boundary. This shifts from hook inheritance to contract-based governance.

### 10.4 Observability Integration

The convergence of agent hooks with OpenTelemetry is accelerating. LangChain's callback system already produces spans compatible with distributed tracing backends. Claude Code's `PostToolUse` hooks provide the raw data; teams are building OpenTelemetry exporters as hook handlers. The goal is agent execution traces that integrate seamlessly with existing APM tools (Datadog, Honeycomb, Grafana).

---

## 11. Framework Comparison

| Framework | Hook Abstraction | Config Format | Blocking? | Input Mutation? | Multi-Framework? |
|---|---|---|---|---|---|
| Claude Code | 25 event types, 4 handler kinds | JSON (settings.json) | Yes (exit 2) | Yes (updatedInput) | No |
| Codex CLI | Approval policies + hooks.json (dev) | TOML + JSON | Yes (approval) | No | No |
| LangChain 1.0 | Middleware (before/after/modify) | Python code | Yes (redirect flow) | Yes (modify_model_request) | LangGraph-only |
| LangChain Callbacks | Event-based callbacks | Python code | No (observe only) | No | Any chain |
| Google ADK | 6 symmetric callbacks | Python code | Yes (return response) | Yes (modify request) | ADK-only |
| AutoGen.Net | LIFO middleware stack | C# code | Yes (short-circuit) | Yes (modify message) | AutoGen-only |
| AutoGen Python v0.4 | Event-driven interceptors | Python code | Yes | Yes | AutoGen-only |
| Semantic Kernel | Nested filter pipeline | C#/Python code | Yes | Yes | SK-only |
| AWS AgentCore | Infrastructure gateway + Cedar | Cedar DSL | Yes (deny) | No | Framework-agnostic |

---

## 12. Conclusion

The hooks-and-middleware pattern has become the dominant extensibility mechanism for AI agent runtimes. What started as simple logging callbacks has matured into a full governance layer capable of policy enforcement, input transformation, and audit compliance. The trajectory is clear: hooks are moving from optional developer ergonomics features toward mandatory enterprise infrastructure.

Three forces are driving this evolution:

1. **Autonomy demands control:** As agents gain longer planning horizons and take more consequential actions, the need for deterministic interception points grows. The agent's own reasoning is insufficient as a safety layer; external hooks provide the necessary separation of concerns.

2. **Operations demands observability:** Distributed tracing, cost accounting, and debugging all require structured event streams from the agent loop. Hooks are the natural instrumentation point.

3. **Compliance demands auditability:** Regulated industries need tamper-evident records of what agents proposed, what was blocked, and what was approved. Gateway-level enforcement (Bedrock AgentCore) provides the strongest audit guarantees because it operates outside agent code.

The design space is converging on a common vocabulary — pre/around/post hooks at tool, model, and agent boundaries — even as implementations diverge in their specifics. Developers building production agent systems should invest in their hook architecture early: the patterns you establish for logging, safety filtering, and policy enforcement will determine how governable your agent infrastructure is as autonomy increases.

---

## Sources

- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) — Official documentation for Claude Code's 25-event hook system
- [Automate Workflows with Hooks](https://code.claude.com/docs/en/hooks-guide) — Claude Code hooks guide
- [Claude Code Hooks — DataCamp Tutorial](https://www.datacamp.com/tutorial/claude-code-hooks) — Practical walkthrough
- [Agent Middleware — LangChain Blog](https://blog.langchain.com/agent-middleware/) — LangChain 1.0 middleware announcement
- [Agent Hooks Middleware in LangChain](https://medium.com/@danushidk507/agent-hooks-middleware-in-langchain-3a7eff9d78f6) — Technical deep-dive (Feb 2026)
- [Codex CLI Agent Approvals & Security](https://developers.openai.com/codex/agent-approvals-security) — OpenAI Codex CLI approval mechanisms
- [Codex CLI Configuration Reference](https://developers.openai.com/codex/config-reference) — hooks.json and config.toml reference
- [Google ADK Callbacks — Types](https://google.github.io/adk-docs/callbacks/types-of-callbacks/) — ADK callback type reference
- [AutoGen Middleware Overview](https://microsoft.github.io/autogen-for-net/articles/Middleware-overview.html) — AutoGen for .NET middleware architecture
- [Semantic Kernel Roadmap H1 2025](https://devblogs.microsoft.com/semantic-kernel/semantic-kernel-roadmap-h1-2025-accelerating-agents-processes-and-integration/) — SK GA announcement
- [AWS Bedrock AgentCore Policy GA](https://aws.amazon.com/about-aws/whats-new/2026/03/policy-amazon-bedrock-agentcore-generally-available/) — AgentCore Policy general availability (March 2026)
- [The New Stack: AWS AgentCore Policy Layer](https://thenewstack.io/aws-new-policy-layer-in-bedrock-agentcore-makes-sure-ai-agents-cant-give-away-the-store/) — Analysis of AgentCore's governance model
- [AI Agent Orchestration Patterns — Azure](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns) — Microsoft's agent design pattern catalog
- [Extensibility in AI Agent Frameworks](https://www.gocodeo.com/post/extensibility-in-ai-agent-frameworks-hooks-plugins-and-custom-logic) — Cross-framework extensibility comparison
- [Trustworthy AI Agents: Policy-as-Code Enforcement](https://www.sakurasky.com/blog/missing-primitives-for-trustworthy-ai-part-4/) — Policy-as-code for agent governance
