---
date: "2026-02-22"
title: "WebMCP: Browser-Native AI Agent Integration Standard"
description: "Deep dive into the W3C WebMCP specification — how browser-native Model Context Protocol enables AI agents to interact with web pages through standardized APIs"
tags: ["webmcp", "mcp", "browser", "w3c", "ai-agents", "web-standards"]
---

## Executive Summary

WebMCP (Web Model Context Protocol) is a browser-native API standard, incubated under the W3C Web Machine Learning Community Group, that enables websites to expose structured, callable tools directly to AI agents through the `navigator.modelContext` interface. Unlike Anthropic's backend-focused MCP protocol, WebMCP runs entirely client-side — the web page itself becomes the tool server, executing within the user's authenticated browser session. Chrome 146 Canary shipped the first implementation as an early preview in February 2026, with the specification published as a Draft Community Group Report on February 12, 2026. The standard represents a fundamental architectural shift in how AI agents interact with the web, moving from fragile vision-based DOM scraping to a precision structured-tool invocation model.

---

## Background: From MCP to WebMCP

### Anthropic's Model Context Protocol

The Model Context Protocol (MCP), introduced by Anthropic in late 2024, established a JSON-RPC-based standard for connecting AI models to external tools and data sources. The pattern is server-centric: an MCP server runs as a separate process or hosted service, and AI agent clients connect to it via stdio, HTTP with SSE, or similar transports. MCP quickly gained adoption across backend integration scenarios — connecting Claude or other LLMs to file systems, databases, APIs, and enterprise services.

The limitation of backend MCP is precisely its architecture. To automate a web application with MCP, a developer typically must build a dedicated backend service that wraps the application's API, or instruct the agent to drive the browser like a remote-controlled human: take a screenshot, run it through a vision model, identify coordinates, synthesize a click. This approach is slow, brittle, compute-intensive, and loses the user's authenticated session context.

### The Browser Automation Problem

Before WebMCP, AI agents interacting with web pages fell into two unsatisfying categories:

1. **Vision-based automation** (Playwright, Puppeteer, Computer Use): The agent sees the page as a rasterized image. It guesses UI locations, simulates mouse movements and keystrokes, and re-verifies state via fresh screenshots. Benchmark data cited in WebMCP documentation shows this approach carries approximately a 67% computational overhead penalty versus direct tool invocation.

2. **Custom MCP server wrappers**: Developers expose application functionality as backend MCP tools. This works but requires maintaining a parallel API surface that duplicates client-side business logic, bypasses the live authenticated session, and introduces deployment complexity.

### The WebMCP Insight

WebMCP's core insight is that the web page itself is already a live, authenticated, stateful runtime. The user is present. The session is active. The JavaScript executing in the tab already has access to every capability the application exposes. Rather than routing through a separate server, WebMCP asks: why not let the page declare its own tools directly to the browser, which mediates agent access?

The formal specification frames it this way:

> "Web pages that use WebMCP can be thought of as Model Context Protocol servers that implement tools in client-side script instead of on the backend."

The co-authorship by engineers from both Google and Microsoft — and incubation via the W3C Web Machine Learning Community Group — signals this is not a single-vendor experiment but a multi-stakeholder effort to standardize the agentic web interface layer.

---

## Specification Overview

### Specification Status

As of February 2026, the WebMCP specification exists as a **W3C Community Group Draft**, published by the Web Machine Learning Community Group. It is not yet a W3C Standard and is not on the formal W3C Standards Track. A December 2025 Working Group resolution committed to transitioning from the explainer phase to a formal Community Group spec draft during Q1 2026, which the February 12, 2026 publication fulfills.

The specification is actively evolving. Method implementations in the current draft are marked with algorithmic stubs ("TODO: fill this out"), indicating the API surface is stabilizing but implementation specifics are still being defined. Developers are explicitly cautioned against shipping to production: method names and parameter shapes may change between Chrome versions prior to stabilization.

### The `navigator.modelContext` API Surface

The WebMCP API extends the browser's `Navigator` interface with a single read-only attribute:

```javascript
navigator.modelContext
```

Access is restricted to **Secure Contexts** — HTTPS in production, with `localhost` and self-signed certificates permitted during development.

The `ModelContext` interface exposes four methods:

| Method | Description |
|---|---|
| `provideContext(options)` | Register a set of tools, atomically replacing all previously registered tools |
| `clearContext()` | Remove all registered tools for the current page |
| `registerTool(tool)` | Add a single tool without clearing existing registrations |
| `unregisterTool(name)` | Remove a specific tool by name |

Each tool is described by a `ModelContextTool` dictionary:

```javascript
{
  name: "searchProducts",           // DOMString, required — unique identifier
  description: "Search the product catalog by keyword, category, and price range.",
  inputSchema: {                    // JSON Schema, optional
    type: "object",
    properties: {
      query: { type: "string" },
      category: { type: "string" },
      maxPrice: { type: "number" }
    },
    required: ["query"]
  },
  execute: async (inputs, client) => {   // ToolExecuteCallback, required
    const results = await searchCatalog(inputs.query, inputs.category, inputs.maxPrice);
    return { content: [{ type: "text", text: JSON.stringify(results) }] };
  },
  annotations: {
    readOnlyHint: true    // Advisory: this tool does not modify state
  }
}
```

The `execute` callback receives a `ModelContextClient` object as its second argument, which provides a `requestUserInteraction(callback)` method. This pauses tool execution and surfaces a confirmation prompt to the user — the primary human-in-the-loop gate for sensitive operations.

### Declarative API

The Declarative API requires no JavaScript. It works by annotating existing HTML `<form>` elements with new attributes that the browser uses to automatically generate tool registrations:

```html
<form
  id="support-ticket-form"
  toolname="createSupportTicket"
  tooldescription="File a new customer support ticket with issue description and severity"
  toolautosubmit="true"
>
  <input
    type="text"
    name="issueTitle"
    required
    toolparamtitle="Issue Title"
    toolparamdescription="Brief summary of the problem"
  />
  <textarea
    name="description"
    toolparamtitle="Description"
    toolparamdescription="Detailed description of the issue"
  ></textarea>
  <select name="severity">
    <option value="low">Low</option>
    <option value="high">High</option>
    <option value="critical">Critical</option>
  </select>
</form>
```

The key attributes are:

- `toolname` (required): Tool identifier the agent uses to invoke it
- `tooldescription` (required): Natural language description of what the tool does
- `toolautosubmit` (optional): When `true`, the browser auto-submits the form after the agent fills the inputs
- `toolparamtitle` / `toolparamdescription` per-input: Annotate individual fields for the schema

The spec also introduces a `SubmitEvent.agentInvoked` boolean flag that is set to `true` when a form submission originates from an agent invocation, allowing server-side handlers to differentiate between human-submitted and agent-submitted form data.

**Recommended adoption pattern**: The low implementation cost means every semantically meaningful form on a site should have declarative annotations. Well-structured forms with clear field labels require minimal additional markup.

### Imperative API

For actions that do not map to form submissions — logging out, triggering multi-step workflows, invoking custom business logic, navigating complex datasets — the Imperative API provides full programmatic control:

```javascript
// Register at page load or when the feature becomes available
navigator.modelContext.registerTool({
  name: "filterProducts",
  description: "Apply filters to the product listing by brand, rating, and availability.",
  inputSchema: {
    type: "object",
    properties: {
      brands: { type: "array", items: { type: "string" } },
      minRating: { type: "number", minimum: 0, maximum: 5 },
      inStockOnly: { type: "boolean" }
    }
  },
  execute: async ({ brands, minRating, inStockOnly }, client) => {
    // Tool executes in the page's JS context with full session access
    await applyProductFilters({ brands, minRating, inStockOnly });
    const count = document.querySelectorAll('.product-card').length;
    return {
      content: [{
        type: "text",
        text: `Filters applied. ${count} products match.`
      }]
    };
  },
  annotations: { readOnlyHint: false }
});
```

For operations that require user confirmation:

```javascript
execute: async (inputs, client) => {
  await client.requestUserInteraction(async () => {
    // This callback runs after user confirms
    await processCheckout(inputs.cartId);
  });
  return { content: [{ type: "text", text: "Checkout complete." }] };
}
```

### Declarative vs. Imperative: When to Use Each

| Scenario | Recommended Approach |
|---|---|
| Existing HTML form with well-defined inputs | Declarative |
| Form submission that triggers server action | Declarative with `toolautosubmit` |
| Non-form action (logout, navigation, custom trigger) | Imperative |
| Multi-step workflow with intermediate state | Imperative |
| Dynamic tool registration based on app state | Imperative |
| Maximum compatibility, minimum JS overhead | Declarative |

The specification does not treat these as alternatives — a real-world implementation will use both. Declarative annotations cover the majority of standard interactions; the Imperative API handles the long tail.

---

## Current Implementation Status

### Chrome 146 (Early Preview)

Chrome 146 Canary, released in February 2026, ships WebMCP as a **DevTrial** accessible via:

```
chrome://flags → "Experimental Web Platform Features" → Enable
```

or by searching for `webmcp` or `model-context` in the flags interface. This is an early preview designation — not a stable feature flag — indicating the API remains subject to breaking changes.

The Chrome Platform Status entry for WebMCP (feature ID 6213121689518080) tracks the implementation's progress from Origin Trial eligibility toward Stable.

### Other Browsers

Firefox, Safari, and Microsoft Edge are participating in the W3C Web Machine Learning Working Group discussions but have not shipped implementations. Given that Microsoft co-authored the specification alongside Google, Edge implementation is widely anticipated as the second browser to ship support. Formal shipping announcements are expected at Google I/O or Google Cloud Next (mid-to-late 2026).

The MCP-B project (webmcp-org on GitHub) maintains a polyfill that implements the `navigator.modelContext` interface for browsers lacking native support, serving as both a compatibility layer and a reference implementation.

### Spec Maturity Timeline

| Date | Milestone |
|---|---|
| September 2025 | WebMCP formally accepted as W3C Community Group deliverable |
| December 2025 | WG resolves to transition from explainer to Community Group spec draft |
| February 12, 2026 | Published as Draft Community Group Report |
| February 2026 | Chrome 146 early preview ships |
| Q2–Q3 2026 | Expected formal browser announcements (Google I/O / Cloud Next) |
| 2026–2027 | Projected path toward W3C Working Group adoption |

---

## Key Technical Challenges

### Issue #104: Input Changed Event Lifecycle

Filed February 21, 2026 by contributor `schreiaj`, Issue #104 is the most recently opened issue in the repository as of this writing. It addresses a fundamental question about how input state changes should be managed within the WebMCP lifecycle — specifically, what events fire when an agent populates form fields versus a human doing the same, and whether the existing DOM event model (input/change events) is sufficient or whether WebMCP needs its own lifecycle hooks.

This matters because many JavaScript frameworks (React, Vue, Angular) intercept input events to manage controlled component state. If an agent fills a form field via WebMCP without correctly triggering the synthetic events these frameworks expect, form validation logic breaks, and the form becomes unsubmittable. The resolution of this issue will determine how framework-native apps need to structure their tool handlers.

### Issue #103: Interface Semantics and Agent IDL Alignment

Filed February 20, 2026, this issue raises the question of whether WebMCP's JavaScript interface should align with a broader Agent Interface Definition Language (Agent IDL) standard. As the agentic protocol stack assembles — MCP, A2A, NLWeb, WebMCP — standardizing the interface description layer across them reduces integration friction for developers maintaining both backend and frontend tool surfaces.

### Issue #102: Per-Tool Scopes

The current specification applies a single origin-based permission boundary to all tools registered by a page. Issue #102 proposes per-tool scope definitions, allowing fine-grained access control: a `readProductCatalog` tool might require no confirmation, while a `submitPayment` tool carries elevated scope requiring explicit user consent before any agent invocation.

### Issue #101: Tool Overwriting

Issue #101, filed by `beaufortfrancois`, highlights that `navigator.modelContext.provideContext()` atomically replaces all registered tools, and `registerTool()` can silently overwrite a previously registered tool with the same name. In composited applications (micro-frontends, iframes, independently loaded feature modules), multiple page components may independently attempt to register tools. Without a conflict resolution or namespacing mechanism, the last write wins — potentially unregistering tools that other components depend on.

### The Discovery Problem

No mechanism currently exists for an agent to discover which pages on a site expose WebMCP tools before navigating to them. The spec explicitly lists discoverability as a non-goal for v1, but the community has proposed a `.well-known/webmcp` manifest format as a future addition. Until solved, agents must navigate to pages and inspect `navigator.modelContext` post-load — analogous to discovering `<link rel="alternate">` only after fetching the document.

### Headless and Background Execution

WebMCP explicitly excludes headless scenarios from its v1 scope. The human-in-the-loop design principle assumes a user is present and can respond to `requestUserInteraction()` prompts. Background or fully autonomous agent workflows — where no human is watching the browser tab — are architecturally unsupported. This is a deliberate scoping decision, not an oversight, but it creates a hard boundary that systems like Zylos must work around.

### Framework Coupling

React, Vue, and similar frameworks manage their own virtual DOM state, often bypassing native DOM event dispatching. A tool executing `document.getElementById('quantity').value = '5'` may not trigger React's synthetic event handlers, leaving the component state stale. The spec's guidance is to implement tool handlers within the application's own business logic layer (calling the same functions the UI calls) rather than manipulating the DOM directly — but this requires a clean separation of concerns that not all existing applications have.

---

## Security Model

WebMCP's security design rests on several layers:

### Secure Context Requirement

The `navigator.modelContext` API is only available in Secure Contexts (HTTPS). This prevents tools from being registered on plaintext HTTP pages, eliminating a class of network-level injection attacks.

### Same-Origin Isolation

Tools are scoped to the origin that registered them. An agent invoking a tool from `app.example.com` cannot access or modify tools registered by `malicious.example.net`. The browser enforces this at the API level, not the application level.

### Session Inheritance

The tool executes within the authenticated browser tab. This is both WebMCP's primary advantage and a security consideration: the agent inherits the user's authentication session without needing separate credentials. A misused or compromised tool can perform any action the logged-in user could perform.

### Human-in-the-Loop Gate

The `ModelContextClient.requestUserInteraction()` method provides the primary friction mechanism for high-stakes operations. When invoked, tool execution pauses and the user must explicitly confirm before the callback proceeds. The `readOnlyHint: true` annotation in tool metadata signals to the browser (and potentially to future permission UI) that a tool does not modify state — allowing the browser to skip confirmation for read-only tools while requiring it for write operations.

The `SubmitEvent.agentInvoked` flag allows server-side code to identify agent-originated requests and apply additional validation, rate limiting, or audit logging.

### Known Unresolved Vulnerabilities

Several attack surfaces are acknowledged in the specification and community discussions but not fully resolved:

**Prompt Injection**: A malicious or compromised web page could register tools with descriptions designed to manipulate agent behavior. An attacker with content injection capability on a page could add hidden tool registrations that exfiltrate data or perform unauthorized actions.

**Tool Chaining / Data Exfiltration**: The "lethal trifecta" pattern — a tool that reads private data, receives untrusted external input, and has a communication channel to an external service — can chain into an exfiltration pipeline. The specification's `readOnlyHint` is advisory and not enforced.

**Tool Poisoning**: In an environment where an agent operates across multiple WebMCP-enabled pages in sequence, a malicious page earlier in the session could attempt to poison the agent's context, influencing tool selection behavior on subsequent pages.

**Multi-Agent Conflicts**: The specification does not address what happens when multiple AI agents simultaneously attempt to invoke tools on the same page. A lock mechanism analogous to the Pointer Lock API has been proposed but is not yet in the spec.

The broader MCP ecosystem has demonstrated these risks in practice: Anthropic fixed three bugs in its official Git MCP server in early 2026 that could be chained via prompt injection to execute malicious code. WebMCP, as a client-side execution environment, inherits the same vulnerability classes plus additional browser-specific surface area.

---

## Implications for AI Agent Development

### End of Vision-Based Browser Automation (for WebMCP-Enabled Sites)

The vision-based automation model — take screenshot, identify elements, simulate mouse — is computationally expensive and brittle. Benchmark data cited in WebMCP documentation reports approximately a 67% reduction in computational overhead and approximately 98% task accuracy when switching from screenshot-based to WebMCP-based interaction. For agents deployed at scale against consumer web services, this is not a marginal improvement — it is a qualitative architectural change.

### The Parallel Interface Layer

WebMCP effectively creates a parallel interface layer for the web: one optimized for human visual consumption, one designed for machine invocation. The historical parallel is Schema.org structured data — websites that adopted machine-readable markup gained disproportionate search engine visibility during the 2010s. WebMCP plays an analogous role for the agentic era: sites that declare their tools will be preferentially operable by AI agents; those that do not will remain accessible only via brittle vision-based fallbacks.

### The Protocol Stack

WebMCP joins a rapidly assembling agentic protocol stack:

| Protocol | Layer | Author |
|---|---|---|
| MCP (Model Context Protocol) | Backend tool integration | Anthropic |
| A2A (Agent-to-Agent) | Agent-to-agent communication | Google |
| NLWeb | Natural language web content query | Microsoft |
| WebMCP | Client-side browser tool exposure | Google + Microsoft / W3C |

Each protocol addresses a different integration surface. They are complementary: a complex workflow might use MCP to connect to a database, A2A to coordinate sub-agents, and WebMCP to interact with a third-party web interface — all within a single task execution.

### Developer Adoption Dynamics

The declarative API's minimal implementation cost — adding `toolname` and `tooldescription` to existing form elements — sets a very low adoption floor. A competent frontend developer can make a well-structured web application's primary forms discoverable by AI agents in an afternoon. This positions WebMCP adoption similarly to `alt` text or ARIA labels: a semantic annotation practice with direct accessibility and discoverability benefits, requiring minimal architectural change for well-structured applications.

The imperative API's adoption is gated by application architecture. Apps with tight UI/business logic coupling — where form submit handlers reach directly into component state rather than calling discrete service functions — will require refactoring before tool handlers can be written cleanly.

---

## What This Means for Zylos and Similar Projects

Zylos operates as a browser-capable AI agent (via the `zylos-browser` component) that currently relies on DOM interaction and Playwright-style automation. WebMCP introduces a path toward a fundamentally cleaner integration model for sites that adopt it.

### Near-Term Practical Impact

Once Chrome 146 Canary flags can be enabled programmatically in the browser context Zylos uses, WebMCP-enabled sites become first-class tool surfaces. Instead of a Playwright script that locates form fields by CSS selector and simulates typing, a Zylos task against a WebMCP-enabled site can call `navigator.modelContext` directly, discover available tools, invoke them with validated JSON arguments, and receive structured responses — without any visual parsing.

This changes the reliability profile of browser tasks significantly. A form's CSS selector might change across deployments; a tool's `name` declared by the application developer is semantically stable.

### Architecture Implications

WebMCP's human-in-the-loop requirement is a friction point for Zylos-style autonomous operation. The `requestUserInteraction()` mechanism is designed for a present user to confirm actions. In headless or background-agent scenarios — which is Zylos's default operating mode — this gate is either impossible to satisfy or would require synthetic confirmation that defeats the security purpose.

The practical implication: WebMCP is best suited for tasks where Zylos is operating as an assistant in a tab the user is actively monitoring. For fully autonomous background tasks against web services, backend MCP integrations or authenticated API calls remain the more reliable path. This maps naturally to Zylos's existing architecture: WebMCP-enabled browser tasks become a tool in the toolkit for interactive sessions, not a replacement for service-level API integrations.

### Tool Discovery Strategy

The unresolved discovery problem — no standard mechanism to identify WebMCP-enabled pages before visiting them — means Zylos would need to probe for `navigator.modelContext` availability at page load and gracefully fall back to standard automation if the API is absent. A reasonable implementation pattern:

```javascript
async function getAvailableTools(page) {
  const hasWebMCP = await page.evaluate(() =>
    typeof navigator.modelContext !== 'undefined'
  );
  if (hasWebMCP) {
    return await page.evaluate(() =>
      // enumerate registered tools if an enumeration API is added
      // (currently not in spec; watch Issue tracker)
      navigator.modelContext.getTools?.() ?? []
    );
  }
  return []; // Fall back to DOM automation
}
```

When the `.well-known/webmcp` discovery manifest is eventually standardized, Zylos's HTTP component could pre-fetch it before launching a browser session, enabling the agent to plan tool invocations before navigating.

### Security Posture for Zylos

Operating Zylos against WebMCP-enabled pages requires careful handling of the session inheritance model. Because tools execute within the authenticated browser session, an incorrectly trusted tool registration on a page Zylos visits could perform actions under the user's identity. Zylos should:

1. Validate that pages being automated are expected (URL, TLS certificate) before invoking tools
2. Log all tool invocations with their arguments for audit review
3. Treat `readOnlyHint: false` tools as requiring explicit task-level authorization before invocation
4. Stay current with WebMCP security advisories — the spec's security model is actively evolving

---

## Conclusion / Looking Ahead

WebMCP is the most significant architectural change to the browser platform for AI integration since the introduction of the Web Speech API. Its specification reflects a clear-eyed understanding of what has made earlier AI browser automation fragile: the impedance mismatch between interfaces designed for human visual consumption and the structured, reliable invocation model AI agents require.

The core bet is sound. If developers adopt WebMCP's declarative and imperative registration patterns at scale, the web becomes natively operable by AI agents with none of the fragility of vision-based automation. The combination of Google Chrome's early implementation and Microsoft's spec co-authorship gives the standard sufficient multi-vendor credibility to expect broad adoption — the same combination that drove WebGPU from experimental to ubiquitous across all major browsers by 2025.

The unresolved questions are real but tractable: discovery via `.well-known` manifests, per-tool permission scopes (Issue #102), input event lifecycle consistency (Issue #104), multi-agent conflict resolution. These are the kinds of issues that get resolved through working group iteration over 12-18 months, not fundamental design flaws.

For developers building AI agent systems today, the strategic posture is:

1. **Instrument your web applications now** with declarative annotations on forms — the cost is minimal and the benefit begins as soon as any agent (browser copilot, Zylos, third-party assistant) gains WebMCP support
2. **Design imperative tool handlers against your service layer**, not the DOM, to ensure clean execution context
3. **Do not ship to production against Chrome 146 Canary** — the API will change; use this period for architectural prototyping
4. **Implement graceful fallback** to DOM automation for browsers without WebMCP support

The agentic web is assembling its protocol stack faster than most infrastructure transitions. WebMCP is the client-side piece that connects a user's authenticated browser session to the structured tool model AI agents need. When it stabilizes and ships in stable Chrome, every well-instrumented website becomes a first-class tool server for any agent operating in the browser.

---

## References

- [WebMCP Specification (W3C Community Group Draft)](https://webmachinelearning.github.io/webmcp/) — February 12, 2026
- [GitHub: webmachinelearning/webmcp](https://github.com/webmachinelearning/webmcp) — Official W3C repository
- [GitHub: webmcp README.md](https://github.com/webmachinelearning/webmcp/blob/main/README.md) — Primary documentation
- [WebMCP is available for early preview — Chrome for Developers](https://developer.chrome.com/blog/webmcp-epp) — Official Chrome announcement
- [WebMCP: Official W3C Standard for AI Agent Browser Interaction](https://webmcp.link/) — Community landing page
- [Google Chrome ships WebMCP in early preview — VentureBeat](https://venturebeat.com/infrastructure/google-chrome-ships-webmcp-in-early-preview-turning-every-website-into-a) — February 2026
- [WebMCP just landed in Chrome 146. Here's what you need to know — Bug0](https://bug0.com/blog/webmcp-chrome-146-guide) — Technical implementation guide
- [What is WebMCP and how to use it — Codely](https://codely.com/en/blog/what-is-webmcp-and-how-to-use-it) — Code examples and adoption patterns
- [WebMCP Is Coming: How AI Agents Will Reshape the Web — Ivan Turković](https://www.ivanturkovic.com/2026/02/15/webmcp-is-coming-how-ai-agents-will-reshape-the-web/) — Ecosystem analysis
- [Google AI Introduces WebMCP — MarkTechPost](https://www.marktechpost.com/2026/02/14/google-ai-introduces-the-webmcp-to-enable-direct-and-structured-website-interactions-for-new-ai-agents/) — February 14, 2026
- [WebMCP: Making Every Website a Tool for AI Agents — Arcade.dev](https://www.arcade.dev/blog/web-mcp-alex-nahas-interview) — Developer interview
- [WebMCP: Making the web AI-agent ready — iO Digital Tech Hub](https://techhub.iodigital.com/articles/web-mcp-making-the-web-ai-agent-ready) — Technical overview
- [WebML WG F2F Meeting Minutes — November 2025](https://www.w3.org/2025/11/09-webmachinelearning-minutes.html) — W3C Working Group record
- [WebML WG Teleconference Minutes — December 18, 2025](https://www.w3.org/2025/12/18-webmachinelearning-minutes.html) — W3C Working Group record
- [Web Machine Learning Community Group Charter](https://webmachinelearning.github.io/charter/) — Group scope and deliverables
- [MCP Security Vulnerabilities: Prompt Injection and Tool Poisoning — Practical DevSecOps](https://www.practical-devsecops.com/mcp-security-vulnerabilities/) — Security threat landscape
- [Anthropic quietly fixed flaws in Git MCP server — The Register](https://www.theregister.com/2026/01/20/anthropic_prompt_injection_flaws/) — January 2026
- [GitHub: WebMCP-org/mcp-ui-webmcp](https://github.com/WebMCP-org/mcp-ui-webmcp) — MCP-B polyfill and reference implementation
- [WebMCP in Early Preview: Google Prepares for the Era of Agentic AI — Delante](https://delante.co/webmcp-in-early-preview/) — Agentic SEO implications
