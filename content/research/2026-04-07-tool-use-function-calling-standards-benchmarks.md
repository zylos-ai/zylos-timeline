---
date: "2026-04-07"
title: "Tool Use and Function Calling in AI Agents — Standards, Benchmarks, and Emerging Patterns"
description: "A comprehensive analysis of the current state of tool/function calling across major LLM providers, standardization efforts led by MCP, benchmark landscapes, emerging patterns like parallel tool calls and dynamic discovery, and security implications for agent platform builders."
tags:
  - tool-use
  - function-calling
  - mcp
  - benchmarks
  - agent-platforms
  - security
  - standardization
  - openai
  - anthropic
  - google
---

## Executive Summary

Tool use — the ability of an LLM to invoke external functions, APIs, and services during inference — has become the defining capability that separates conversational models from autonomous agents. What began in 2023 as OpenAI's experimental "function calling" feature has, by mid-2026, evolved into a rich, contested, and increasingly standardized landscape spanning every major provider, dozens of open-source models, and a fast-growing ecosystem of benchmarks and security frameworks.

Three forces are converging to reshape the space: **standardization** (led by Anthropic's MCP, now under vendor-neutral governance), **evaluation maturity** (BFCL V4 now scores agentic behavior, not just single-call accuracy), and **security pressure** (prompt injection ranks #1 on OWASP's 2025 LLM Top 10, with tool abuse as the primary attack surface). For builders of agent platforms, understanding all three is no longer optional — it is foundational.

---

## The Provider Landscape: Where Things Stand in 2026

### OpenAI: The Originator, Now Playing Catch-Up on Reliability

OpenAI introduced function calling in June 2023, establishing the basic pattern: define a JSON Schema tool description, let the model emit a structured call, execute it, and return the result. The original implementation relied on "best effort" schema adherence, meaning the model tried to match the schema but was not guaranteed to do so.

The pivotal upgrade came in **August 2024** with `gpt-4o-2024-08-06` and the launch of **Structured Outputs**: a `strict: true` parameter added to function definitions that combines constrained decoding with model training to guarantee 100% schema conformance. This closed the reliability gap that had plagued production deployments.

By **March 2025**, OpenAI released its production-grade **Agents SDK**, replacing the experimental Swarm framework with first-class primitives for multi-step tool chains, handoffs between agents, and a new **Responses API** designed explicitly for agentic loops. Parallel function calls — executing multiple tool invocations in a single model turn — became the default behavior.

OpenAI's tool ecosystem strength lies in its breadth: built-in tools for web search, code execution, and file management are bundled into the platform, lowering the barrier for common agentic patterns. The tradeoff is platform lock-in; OpenAI's tool format is not portable to other providers without schema translation.

Notably, in **March 2025**, OpenAI adopted the Model Context Protocol (MCP) across its Agents SDK, Responses API, and ChatGPT desktop — a significant signal that the industry was converging on a shared standard rather than fragmented proprietary formats.

### Anthropic: Built for Agents from Day One

Anthropic's tool-use interface was designed with agentic workflows as the primary use case. Claude's approach differs from OpenAI's in a key architectural way: rather than routing every intermediate reasoning step back through the model's context window, Claude can write code to chain tools together directly, behaving more like a developer who understands API composition than a model that needs to re-prompt itself for every step.

The **Tool Search Tool** pattern, pioneered by Anthropic's internal tooling and later formalized in Spring AI's MCP integration (December 2025), addresses a persistent scaling problem: loading hundreds of tool definitions into context is expensive and degrades reasoning quality. The pattern works by giving the model only a single "search for tools" capability initially; the model queries for relevant tool definitions on demand, and only those are expanded into context. In production benchmarks, this achieved **34–64% reduction in total token consumption** depending on the model and search strategy.

Anthropic's **Claude Agent SDK** (shipped alongside Claude 4.6 in early 2026) provides production primitives for multi-agent coordination, with tool calling tightly integrated into the execution model.

On benchmarks, **Claude Opus 4.1 ranks 2nd on BFCL V4 at 70.36%**, and **Claude Sonnet 4 ranks 3rd at 70.29%** — both outperforming GPT-5 (59.22%, 7th place) on function-calling accuracy. Anthropic's relative advantage on structured tool invocation reflects its agent-centric training emphasis.

### Google: Broad Ecosystem, Complex Surface Area

Google's function-calling story is complicated by three overlapping product surfaces — AI Studio, Vertex AI, and the raw Gemini API — creating friction for developers who must pick the right door before they can make their first call.

**Gemini 2.x** models support parallel function calls natively and offer unique capabilities unavailable elsewhere: video as an input modality enables tool calls triggered by visual context, and deep integration with Google Search, Google Workspace, and Cloud services provides a ready-made tool ecosystem.

**Google ADK** (Agent Development Kit), launched April 2025, provides a code-first Python and TypeScript framework optimized for Gemini that is also model-agnostic. ADK supports four tool types: custom `FunctionTool` definitions, `AgentTool` (using other agents as callable tools), built-in capabilities (code execution, Google Search), and external APIs. In April 2025, **Google DeepMind's Demis Hassabis confirmed MCP support** in upcoming Gemini models, and the **Interactions API** (launched in 2025 beta) provides a unified endpoint purpose-built for agentic loops — an alternative to the `generateContent` endpoint with primitives for persistent state and multi-step execution.

On the AN Score benchmark measuring agent execution reliability, Google AI scores **7.9 vs. Anthropic's 8.4 and OpenAI's 6.3**, suggesting Google's models perform well in practice despite the product complexity overhead.

### Open-Source Models: Closing the Gap

The open-source ecosystem has made dramatic progress on tool calling capability in 2025–2026:

- **Llama 3.1/3.2** (Meta): Native tool calling support added in 2024; production-ready via Ollama for basic use cases and vLLM for advanced workloads requiring parallel invocation and streaming tool calls.
- **Qwen 3 / Qwen3 Coder**: Excels at long-horizon reasoning, complex tool usage, and recovery from execution failures — a notable benchmark for open models on agentic tasks.
- **Mistral**: Tool calling available via Ollama integration with full OpenAI-compatible interface.
- **Command R (Cohere)**: 128K context window with native tool use optimized for complex RAG + tool workflows.
- **FunctionGemma**: Google's lightweight open model built specifically as a foundation for fine-tuning function-calling specialists.

Key limitation: Ollama's API does not yet support streaming tool calls or the `tool_choice` parameter as of 2025, meaning you cannot force a specific tool or receive streaming tool call responses — gaps that vLLM fills for production deployments.

---

## Standardization: MCP Emerges as the Protocol Layer

### The Protocol Problem

Before MCP, every agent framework defined its own tool description format, invocation protocol, and result schema. LangChain tools were not compatible with AutoGen tools; OpenAI function schemas required manual translation to work with Anthropic's format. Building a multi-provider agent meant writing adapter layers for every tool against every model.

### MCP's Ascent

Anthropic announced the **Model Context Protocol (MCP)** in November 2024 as an open standard for connecting AI assistants to data systems — content repositories, business tools, and development environments. The protocol defines a JSON-RPC-based communication layer with four primitives: **Tools** (callable functions), **Resources** (data sources), **Prompts** (reusable templates), and **Sampling** (model invocation through the server).

Adoption velocity was extraordinary:

- **November 2024**: Launch; ~100,000 MCP server downloads
- **April 2025**: Downloads exceed 8 million — an 8,000% surge in five months
- **March 2025**: OpenAI adopts MCP across Agents SDK, Responses API, and ChatGPT desktop
- **April 2025**: Google DeepMind confirms MCP support for Gemini
- **December 2025**: MCP donated to the **Agentic AI Foundation (AAIF)**, ensuring vendor-neutral governance under Linux Foundation oversight
- **December 2025**: Python and TypeScript SDK combined monthly downloads reach **97 million**

By early 2026, analysts project that **75% of API gateway vendors will add MCP features**, and 60% of Fortune 500 companies are projected to adopt MCP-like protocols for scalable AI integration.

### MCP's Current Specification (2025-11-25)

The MCP spec has evolved from its initial release with key additions: **OAuth 2.1** authentication (June 2025 update), **Streamable HTTP** as a transport alternative to SSE for enterprise deployments, and a **Registry API** (donated to AAIF alongside the core protocol) for dynamic tool discovery.

### Interoperability Reality

MCP has won the protocol war for tool definition and transport, but **model-level incompatibilities remain**. Anthropic's Tool Search Tool pattern is not replicable in OpenAI's or Google's native interfaces without custom wrappers. Gemini's video-triggered tool calls have no equivalent elsewhere. True plug-and-play portability across all three providers requires an abstraction layer (LangChain, LlamaIndex, or a custom router) that handles per-provider schema translation — and accepts some capability loss in exchange for portability.

---

## Benchmarks: Measuring What Actually Matters

### BFCL — Berkeley Function Calling Leaderboard

The most widely cited benchmark, now in **V4** (announced July 2025), evaluates tool calling in real-world agentic settings rather than just single-call accuracy. BFCL V4 consists of real-world question-function-answer pairs across multiple languages (Python, Java, JavaScript, REST APIs) and uses **Abstract Syntax Tree (AST) evaluation** to assess structural correctness.

**V4 Scoring Formula:**
```
Overall = (Agentic × 40%) + (Multi-Turn × 30%) + (Live × 10%) + (Non-Live × 10%) + (Hallucination × 10%)
```

The 40% weight on agentic behavior marks a fundamental shift: a model that aces single-turn function calls but fails at multi-hop reasoning with tool context is no longer considered state-of-the-art.

**Representative BFCL V4 Results (2025–2026):**
| Model | Overall Score | Rank |
|-------|--------------|------|
| Claude Opus 4.1 | 70.36% | 2nd |
| Claude Sonnet 4 | 70.29% | 3rd |
| GPT-5 | 59.22% | 7th |

Key finding: top models still struggle with **memory across long conversations**, **dynamic decision-making** (knowing when *not* to use a tool), and **format sensitivity** (breaking when API schemas are presented differently).

### MCP-AgentBench (September 2025)

A benchmark specifically engineered to assess language agent capabilities in MCP-mediated tool interactions. It includes:
- 33 operational MCP servers
- 188 distinct tools
- 600 systematically designed queries across 6 categories

This is the first benchmark designed to evaluate the full MCP stack — server discovery, tool invocation, result handling, and error recovery — rather than isolated function-calling capability.

### ToolBench and Evolution

The original **ToolBench** (from Chinese academia, widely cited since 2023) consists of diverse software tools for real-world tasks. In 2025, Reflection-empowered LLMs (Tool-MVR) set new records on the benchmark: **+24% accuracy** over baseline ToolLLM and **Error Correction Rate (ECR) of 58.9%**. Virtual API server infrastructure has matured to enable stable, reproducible automated assessment.

### API-Bank and AgentBench

**API-Bank** covers multi-turn and multi-call dialogues, evaluating both API calls and their responses across three distinct tool usage abilities — a useful complement to BFCL's single-turn depth.

**AgentBench** (ICLR 2024, maintained through 2025) evaluates LLMs-as-agents across 8 diverse environments, moving beyond tool calling to assess full agent behavior including planning, memory, and environment interaction.

### TRAJECT-Bench (October 2025)

A trajectory-aware benchmark that evaluates per-step correctness across entire agent runs, not just final outcomes. For each tool call, human/LLM annotation marks the correctness of the reasoning (Thought), tool choice (Action), and parameterization (Action Input) — enabling fine-grained diagnosis of failure modes.

---

## Emerging Patterns

### Parallel Tool Calls

All three major providers (OpenAI, Anthropic, Google) now support parallel tool invocation — executing multiple tool calls in a single model turn. A February 2026 paper ("Scaling Parallel Tool Calling for Efficient Deep Research Agents", arXiv:2602.07359) demonstrated that scaling along the width dimension — making many tool calls per step — can achieve **4x speedup** in agentic search tasks compared to sequential execution.

The key coordination advantage: because all parallel tool calls are reasoned about in the same model turn, the model can coordinate between them (e.g., avoid redundant searches) in ways that sequential calls cannot.

### Interleaved Thinking

Models that expose an internal "thinking" or "scratchpad" step between tool calls enable more sophisticated chaining. After receiving a tool result, the model can reason about it before deciding on the next tool call, rather than immediately emitting the next invocation. This pattern is foundational to Claude's extended thinking and to OpenAI's o-series reasoning models.

### Tool Search Tool (Dynamic Discovery)

Rather than loading all tool definitions upfront (which consumes tokens and degrades reasoning quality at scale), the Tool Search Tool pattern gives agents a meta-tool: the ability to search a registry for relevant tools on demand. Spring AI's implementation (December 2025) demonstrated **34–64% token reduction** in production. The pattern requires a tool registry (MCP Registry, Kong Konnect, or a custom vector-indexed store) and an agent that understands when to query it.

### Dynamic Tool Registration

MCP's runtime update capability enables tool definitions to change without restarting the agent. Spring AI's MCP integration demonstrated this in May 2025: `ToolCallbackProvider#getToolCallbacks` always retrieves the current list from the server, so tool additions, removals, and schema updates propagate to running agents instantly. This makes it possible to build agent platforms where tools are added by users or automated pipelines at runtime without any session restart.

### Agent-as-Tool

A recursive pattern: an entire agent (with its own tool access, memory, and planning loop) is exposed as a callable tool to another agent. Google ADK formalizes this with `AgentTool`; Anthropic's Agent SDK and OpenAI's Agents SDK support equivalent patterns. This enables hierarchical agent architectures where a coordinator agent delegates to specialist agents through the same tool-calling interface.

---

## Security Considerations

### Prompt Injection: The #1 Threat

**OWASP's 2025 Top 10 for LLM Applications** ranks prompt injection as the most critical vulnerability, appearing in over 73% of production AI deployments. In agentic systems with tool access, the stakes are dramatically higher: a successful injection can trigger arbitrary tool calls, not just generate malicious text.

**Indirect prompt injection (IPI)** is the dominant attack vector in tool-using agents: malicious instructions arrive through tool results (web pages fetched, documents read, API responses parsed) rather than direct user input. The attacker does not need access to the user's interface — they only need to control data that the agent will consume.

**Real-world CVEs (2025):**
- **CVE-2025-53773**: GitHub Copilot remote code execution via prompt injection — potentially compromising millions of developer machines
- **CVE-2025-32711 ("EchoLeak")**: CVSS 9.3; Microsoft patched server-side, but the vulnerability class remains open
- **CVE-2025-59944**: Case sensitivity bug in Cursor's agentic path filtering, escalating to remote code execution via injected configuration file

OpenAI has acknowledged that prompt injection "may never be fully solved," characterizing it as analogous to social engineering on the web — manageable through layered defense but not eliminable.

### Permission Models and Least Privilege

The most pervasive misconfiguration in 2026: agents run with the same permissions as the service account that launched them — often including filesystem write access, network egress, code execution, and database admin credentials — even when the agent only needs a fraction of that access.

OWASP's Top 10 explicitly identifies **Excessive Agency** as a core risk category. Best practices now codified across IBM, AWS Well-Architected (Generative AI Lens), and the OWASP AI Agent Security Cheat Sheet:

1. **Least privilege per tool**: Each tool gets only the permissions it needs for its specific function
2. **Separate read/write**: Never bundle read and write permissions unless the task explicitly requires both
3. **Explicit user confirmation for high-risk actions**: Writes, deletions, network sends, and code execution should require human-in-the-loop confirmation
4. **Path scoping for filesystem tools**: MCP server path traversal vulnerabilities found in 2025 showed that 82% of tested servers were vulnerable when filesystem permissions were not scoped to specific paths
5. **Code execution in sandboxes**: Any tool with code execution capability must run in an isolated environment

### Tool Call Validation

The confused deputy problem is central to tool security: an LLM trusts anything that sends it convincing tokens. Defense requires architectural enforcement, not prompt-level instructions:

- **Input validation at the tool layer**: Tools must validate and sanitize inputs before execution, independent of what the model sent
- **Output verification**: Tool results should be validated before being injected back into model context
- **Strict schema enforcement**: Using `strict: true` in OpenAI, or equivalent schema validation in Anthropic/Google, prevents malformed tool calls from reaching execution
- **Runtime interception**: Microsoft's Agent Governance Toolkit (released April 2026) provides an Agent OS — a stateless policy engine that intercepts every agent action before execution at sub-millisecond latency (<0.1ms p99), supporting YAML rules, OPA Rego, and Cedar policy languages

---

## Implications for Agent Platforms

**1. MCP is the infrastructure bet that has paid off.** The combination of Anthropic's open-sourcing, vendor-neutral governance under AAIF, and OpenAI/Google adoption has made MCP the clear choice for tool definition and transport in new platforms. Building on a proprietary tool protocol in 2026 is a strategic liability.

**2. Tool discovery at scale requires a registry.** As agent platforms grow beyond dozens of tools, the naive approach (all tools in context) fails on cost, latency, and reasoning quality. Investing in a tool registry — whether MCP Registry, a vector-indexed store, or a gateway like Kong — is necessary infrastructure for production-scale platforms.

**3. Benchmark performance is not production performance.** BFCL V4 top performers (Claude Opus 4.1 at 70.36%) still fail on multi-turn memory and format sensitivity. Production platforms must add their own error recovery, retry logic, and result validation layers regardless of the underlying model.

**4. Parallel invocation is a latency lever, not just a feature.** For platforms with tool-heavy workflows (research agents, data enrichment, multi-source lookup), enabling parallel tool calls can cut end-to-end latency by 4x. This requires both model support and orchestration infrastructure that can fan out concurrent calls and aggregate results.

**5. Security requires the platform layer, not the model.** No model-level instruction reliably prevents prompt injection via tool results. Platforms must enforce permissions at the tool execution layer (not the prompt layer), sandbox code execution, scope filesystem access to specific paths, and require human confirmation for high-risk operations — independent of what the model says.

**6. The "agent-as-tool" pattern enables composition without complexity.** Exposing specialist agents as tools to coordinator agents — rather than building monolithic super-agents — distributes complexity, enables independent testing of each agent, and maps naturally to team structures. All three major SDKs (OpenAI Agents SDK, Anthropic Agent SDK, Google ADK) support this pattern natively.

**7. Dynamic tool registration changes the deployment model.** Platforms that support runtime tool updates (via MCP's live reload capability) can evolve their tool ecosystems without agent restarts — enabling continuous deployment of new capabilities and user-defined tool extensions.

---

## References

- [Berkeley Function Calling Leaderboard V4](https://gorilla.cs.berkeley.edu/leaderboard.html)
- [BFCL: From Tool Use to Agentic Evaluation (MLIR 2025)](https://proceedings.mlr.press/v267/patil25a.html)
- [Function Calling and Agentic AI in 2025 — Klavis AI](https://www.klavis.ai/blog/function-calling-and-agentic-ai-in-2025-what-the-latest-benchmarks-tell-us-about-model-performance)
- [MCP Specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [A Year of MCP: 2025 Review — Pento](https://www.pento.ai/blog/a-year-of-mcp-2025-review)
- [2026: The Year for Enterprise-Ready MCP Adoption — CData](https://www.cdata.com/blog/2026-year-enterprise-ready-mcp-adoption)
- [Why the Model Context Protocol Won — The New Stack](https://thenewstack.io/why-the-model-context-protocol-won/)
- [MCP Spec Updates from June 2025 — Auth0](https://auth0.com/blog/mcp-specs-update-all-about-auth/)
- [Scaling Parallel Tool Calling for Deep Research Agents (arXiv:2602.07359)](https://arxiv.org/html/2602.07359)
- [Smart Tool Selection: 34-64% Token Savings with Spring AI's Dynamic Tool Discovery](https://spring.io/blog/2025/12/11/spring-ai-tool-search-tools-tzolov/)
- [Dynamic Tool Updates in Spring AI's MCP](https://spring.io/blog/2025/05/04/spring-ai-dynamic-tool-updates-with-mcp/)
- [MCP-AgentBench (arXiv:2509.09734)](https://arxiv.org/pdf/2509.09734)
- [TRAJECT-Bench: Trajectory-Aware Benchmark (arXiv:2510.04550)](https://arxiv.org/pdf/2510.04550)
- [LLM01:2025 Prompt Injection — OWASP Gen AI Security Project](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)
- [AI Agent Security Cheat Sheet — OWASP](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html)
- [AI Agent Attacks in Q4 2025 Signal New Risks for 2026 — eSecurity Planet](https://www.esecurityplanet.com/artificial-intelligence/ai-agent-attacks-in-q4-2025-signal-new-risks-for-2026/)
- [Microsoft Agent Governance Toolkit (April 2026)](https://opensource.microsoft.com/blog/2026/04/02/introducing-the-agent-governance-toolkit-open-source-runtime-security-for-ai-agents/)
- [Introducing Structured Outputs — OpenAI (2024)](https://openai.com/index/introducing-structured-outputs-in-the-api/)
- [Google ADK Documentation](https://google.github.io/adk-docs/)
- [LLM APIs for AI Agents: AN Score Comparison — DEV Community](https://dev.to/supertrained/llm-apis-for-ai-agents-anthropic-vs-openai-vs-google-ai-an-score-data-3e1j)
- [Function Calling & Tool Use: Complete Guide 2026 — Ofox.ai](https://ofox.ai/blog/function-calling-tool-use-complete-guide-2026/)
- [Building a Least-Privilege AI Agent Gateway with MCP, OPA — InfoQ](https://www.infoq.com/articles/building-ai-agent-gateway-mcp/)
- [Why Agentic AI Forces a Rethink of Least Privilege — Strata.io](https://www.strata.io/blog/why-agentic-ai-forces-a-rethink-of-least-privilege/)
- [Leveraging MCP Registry in Kong Konnect for Dynamic Tool Discovery](https://konghq.com/blog/engineering/mcp-registry-dynamic-tool-discovery)
