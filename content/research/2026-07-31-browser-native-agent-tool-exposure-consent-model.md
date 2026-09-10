---
date: "2026-07-31"
title: "WebMCP's Unsolved Problem: Who Gets to See a Page's Agent Tools"
description: "A close reading of the WebMCP spec and its live cross-window tool-discovery debate (issue #227), distinguishing browser-enforced origin policy from the unresolved window-relationship and user-consent questions."
tags: ["webmcp", "browser-security", "ai-agents", "same-origin-policy", "consent", "agentic-web", "cross-origin", "w3c"]
---

## Executive Summary

WebMCP lets a web page register JavaScript "tools" — named, schema-typed, natural-language-described actions — that an AI agent can discover and invoke, turning ordinary pages into agent-actionable surfaces. The unresolved question is not whether a page's *own* agent can call its own tools; it's who *else* can: a cross-origin iframe, an opener or popup window, the browser's own built-in agent watching another tab. The historical draft's default is same-origin-only discovery plus an explicit per-tool `exposedTo` origin allowlist, modeled loosely on `postMessage()`. A live GitHub thread (webmachinelearning/webmcp#227, opened 2026-07-21, still active 2026-07-30) shows Google's spec editor proposing to widen tool discovery to a page's whole browsing-context group (openers, popups), and Mozilla and Google reviewers pushing back — not primarily because the scoping is wrong, but because a site that locks down `frame-ancestors` or embedding may wrongly believe it has also prevented its tools from being reached through a different window relationship it never considered. That gap — embedding controls do not replace the separate tool-exposure policy or specify consent for new window relationships — is the real subject of this piece. This is distinct from "MCP tool poisoning," where a malicious MCP *server* attacks an agent *client*; here the attacker surface is the browser's own multi-window, multi-origin model, and the victim can be a site that did nothing wrong except not anticipate how its tools would be reached.

## What WebMCP Actually Is

WebMCP (Web Model Context Protocol) is a proposal in the W3C Web Machine Learning Community Group, developed in the open at [github.com/webmachinelearning/webmcp](https://github.com/webmachinelearning/webmcp), with Chromium's Dominic Farolino (`domfarolino`) and Microsoft's Brandon Walderman as listed proposal authors/editors. It is *not* a browser binding of Anthropic's server-side Model Context Protocol — despite the name, Mozilla's reviewer bluntly noted "There is no MCP here" (more below). It is a browser-native way for a page to declare callable actions.

This article is a historical snapshot: API claims use [spec revision `3678f646`](https://github.com/webmachinelearning/webmcp/blob/3678f646fc0605ef37a76007c5567d31b6989e2c/index.bs), and issue-discussion observations stop at 2026-07-30. The publication date is 2026-07-31; later discussion is outside this snapshot. The examples below were checked against that draft’s IDL and algorithms, not executed in a browser. They are not a current-browser compatibility guide.

The draft API surface is:

```js
// On merchant.example.com; lookupOrder is application code, omitted here.
// Registration — note this historical draft uses `document`, not `navigator`
await document.modelContext.registerTool({
  name: "get-order-status",
  description: "Look up the status of the current user's order",
  inputSchema: {
    type: "object",
    properties: { orderId: { type: "string" } },
    required: ["orderId"]
  },
  annotations: {
    readOnlyHint: true,
    untrustedContentHint: false
  },
  execute: async ({ orderId }) => ({ status: await lookupOrder(orderId) })
}, {
  exposedTo: ["https://agent.example.com"] // registration options, not tool fields
});

// Discovery in an agent.example.com frame in the SAME top-level frame tree.
// Both documents must be allowed to use the "tools" Permissions Policy feature.
const tools = await document.modelContext.getTools({
  fromOrigins: ["https://merchant.example.com"]
});
```

```webidl
[Exposed=Window, SecureContext]
interface ModelContext : EventTarget {
  Promise<undefined> registerTool(ModelContextTool tool, optional ModelContextRegisterToolOptions options = {});
  Promise<sequence<RegisteredTool>> getTools(optional ModelContextGetToolOptions options = {});
  attribute EventHandler ontoolchange;
};

dictionary ToolAnnotations {
  boolean readOnlyHint = false;
  boolean untrustedContentHint = false;
};
```

Two corrections to common secondary-source claims: the object is `document.modelContext`, not `navigator.modelContext`; and this draft’s `ToolAnnotations` dictionary has exactly two fields, `readOnlyHint` and `untrustedContentHint` — it does *not* yet include the `destructiveHint`/`idempotentHint`/`openWorldHint` annotations from Anthropic's server-side MCP vocabulary. The whole API is gated behind a Permissions Policy feature named `"tools"` with a default allowlist of `'self'`.

WebMCP distinguishes browser-integrated agents from in-page JavaScript agents. The latter call the page APIs directly. For the former, the draft's **non-normative** “Page observations” section sketches infrastructure that a browser might use: a snapshot of tools and other page context delivered without the agent itself running page JavaScript. That illustrative model discusses observations across top-level browsing contexts, with timing left to the implementation. It is implementer guidance, not a normative cross-tab access grant or evidence of what Gemini, Copilot, Atlas, or any shipping browser agent can actually access. The cross-window debate below concerns the in-page discovery API; concrete native-agent access and consent behavior require separate implementation evidence.

**Status as of late July 2026**: Chrome shipped an origin trial in Chrome 149 (announced at Google I/O 2026), running through Chrome 156 with full shipping targeted for Chrome 157. Mozilla's standards-positions review (`mozilla/standards-positions#1412`) landed a **neutral** position on 2026-06-01. WebKit's review (`WebKit/standards-positions#670`) landed **opposed** on 2026-06-03. So the only browser actually running this in the field, with real sites, is Chrome — while the security model is still being argued over in the issue tracker.

## The Cross-Window Discovery Gap: Reading Issue #227

`getTools()` in the pinned draft enumerates the whole frame tree of the caller’s top-level traversable navigable. For a caller inside an iframe, the parent and sibling frames are candidates too, subject to the browser’s Permissions Policy and origin/exposure checks; discovery is not limited to the caller’s own subtree. It does not see tools registered by an opener, a popup it opened, or another top-level tab in the same browsing context group. On 2026-07-21, `domfarolino` opened [issue #227](https://github.com/webmachinelearning/webmcp/issues/227), arguing this exclusion "probably shouldn't" exist, and that within a browsing context group, `getTools()` should "collect tools from all top-level browsing contexts, including auxiliary top browsing contexts." The stated motivation (elaborated by commenter `Idan-Levin`): a flight-booking site that opens seat selection in a separate popup window should let its in-page agent invoke seat-picker tools there and then return to finish booking in the original window — a legitimate multi-window workflow that today's frame-tree-only scoping can't support.

Mozilla's `bvandersloot-mozilla` pushed back the same day and again on 2026-07-24, with a concrete threat model: a travel site where the user has an **Account Information** window open (tools with CRUD access to credit card, passport, name, email) alongside a separate window rendering user-submitted hotel/airline reviews — a page where prompt injection is far more likely to land. Quoting directly: *"Keeping consequential tools away from places where there is more likely to be prompt injection seems like a good principle... Page-locality of tools is a layer of the defense in depth."* They argued cross-window sharing should, at minimum, follow storage-style partitioning and be opt-in at registration time.

Google's `johannhof` then reframed the problem in a way that is the crux of this whole piece, on 2026-07-29: even granting a good use case, broadening `getTools()`'s reach risks giving site authors "not... sufficient granularity for deciding between iframe and opener exposure," such that **"sites could assume that a relatively liberal tool exposure policy combined with strict frame-ancestors is enough to prevent other sites from accessing their tools"** — and be wrong. `domfarolino` replied the same day, narrowing his proposal to scope discovery strictly to "windows that you already have `postMessage()` access to" — i.e., the browsing context group, no further — arguing this at least bounds the blast radius to relationships the page already navigates or opens. `johannhof`'s final reply, on 2026-07-30 (the last reply included in this snapshot), was that the narrower scoping **still** doesn't address the underlying concern: *"sites may not understand that embedding prevention only will not help them avoid exposure of their tools."* At the observation cutoff, the issue remained open, unresolved, with no consensus on whether — or how — `getTools()`'s reach should be widened at all.

A closely related, still-open thread is [issue #188](https://github.com/webmachinelearning/webmcp/issues/188), "Tool retrieval: wildcard or not," opened 2026-05-27. It asks whether `exposedTo` and `getTools()` should support a `"*"` wildcard for open sharing across all origins. `domfarolino`'s own framing draws the `postMessage()` parallel explicitly: *"The onus is on Victim.com to manually check the tool's origin to see if it trusts the vendor of the tool, just like `postMessage()`: the onus is on the recipient of the message, to vet the sender's origin."* He notes `exposedTo` is already "more secure than `postMessage()`'s `targetOrigin` since it doesn't allow `*`" — but that an unrestricted `getTools()` would be "just as secure as `onmessage` handlers, since the onus is on the tool retriever to vet the supplier." `johannhof` raised a CSRF concern about blanket `"*"` registration; Google's Yoav Weiss (`yoavweiss`) offered a real-shaped hypothetical (a `tools.shopify.com` iframe embedded across tens of thousands of merchant sites, where maintaining a static per-site allowlist doesn't scale) to argue wildcard exposure is sometimes legitimate on the *registering* side, while keeping the *retrieving* side's trust decision explicit. No resolution was recorded in the discussion examined through the observation cutoff.

Tellingly, the spec's own "Security and Privacy Considerations" section has a subsection titled "Violation of Same-Origin Boundaries" whose entire content, in the pinned revision, is: *"TODO: Document risks and implications of agents carrying state from one origin to another..."* The authors have flagged this as unfinished, not glossed over it.

## Why Origin and Embedding Controls Aren't Enough

The web platform already has tools for exactly this class of problem, and WebMCP reuses them — but each was designed for a narrower job than "who can invoke a high-agency action":

- **Same-origin policy** ([MDN](https://developer.mozilla.org/en-US/docs/Web/Security/Same-origin_policy)) governs whether script in one origin can read another origin's DOM/response data. It says nothing about whether origin A can *ask* origin B to perform an action on A's behalf if B explicitly agrees to be asked — which is exactly what `exposedTo` and cross-origin `getTools()` set up.
- **Permissions Policy** ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Permissions_Policy)), which WebMCP's `"tools"` feature uses, controls API access for top-level documents as well as embedded frames. The draft's registration and discovery algorithms check the caller's permission; discovery also filters target documents by permission. This is platform enforcement. It does not, by itself, express a separate tool-exposure grant for each opener/popup relationship. If #227 widened discovery, frame delegation alone would not describe that new relationship. Under the pinned draft, those separate top-level windows are outside `getTools()` discovery in the first place.
- **`frame-ancestors` / X-Frame-Options** stop a page from being *embedded*. As `johannhof` pointed out, a site can set these correctly and still be wrong to assume it has thereby closed off tool exposure via opener/popup relationships, which don't involve embedding at all.
- **Transient activation** ([MDN](https://developer.mozilla.org/en-US/docs/Web/Security/User_activation)) gates sensitive APIs (popups, fullscreen) behind a real, recent user gesture. It constrains *when* an action can start, not *who* is allowed to trigger it — largely orthogonal to the discovery question, though it's a natural ingredient in any consent prompt design (see below).

The common thread: every one of these primitives assumes the page author is reasoning about a single, well-understood relationship (embedder/embeddee, or same/cross origin data access). Tool exposure introduces a *third* relationship — window-to-window action delegation, potentially independent of both framing and origin — that none of them model directly, and which a site owner may not think to defend even if they've correctly locked down the other two.

## Prior Art: How the Platform Has Handled Capability Exposure Before

| Capability | Consent model | What made it tractable |
|---|------|---|
| Camera / microphone (`getUserMedia`) | Explicit per-origin prompt, persistent grant, visible in-use indicator, queryable via [Permissions API](https://developer.mozilla.org/en-US/docs/Web/API/Permissions_API) | Single well-defined origin asking; binary allow/deny; a human/mic/camera decision is intuitive to a lay user |
| Geolocation | Same pattern: per-origin prompt, persistent grant | Same as above; data-read only, not an action |
| Clipboard | Read requires permission + often transient activation; write often allowed on a user gesture without a prompt | Narrower blast radius (one piece of data); browsers still tightened it over time after abuse |
| `postMessage()` | No mandatory user-consent prompt; the browser enforces an explicit `targetOrigin`, while the receiver must check `event.origin` in its handler | Decades of real-world vulnerabilities trace to developers skipping the origin check; MDN's own docs carry a standing security warning |

The `postMessage()` comparison is useful for the responsibility to choose trusted origins, but it does not mean WebMCP's origin checks are merely a convention. In the pinned `getTools()` algorithm, the browser filters target origins using `fromOrigins` (with same-origin included) and checks whether each tool is exposed to the caller through `exposedTo`. A site chooses the policy; the platform enforces those checks. What the draft does not add here is a mandatory camera-style user-consent prompt or a distinct grant keyed to each window relationship. That is the narrower gap raised by the cross-window proposal.

Why is this harder than camera/mic? A camera prompt asks a human "should this site see you?" — a legible question. Tool exposure asks, transitively, "should this site let *that other window's agent* take actions using this site's authenticated session?" — a relationship the end user usually can't see and wouldn't know how to evaluate even if shown it. Camera/mic consent also concerns *data leaving the device*; tool invocation concerns *actions with side effects* (the spec's own examples include password resets and cart finalization) — closer to a payment authorization than a permission prompt.

## Design Options and Their Tradeoffs

| Option | Mechanism | Strength | Weakness |
|---|---|---|---|
| **Default-deny, same-origin only** (pinned draft default) | `getTools()` returns same-origin tools unless caller passes `fromOrigins`; `registerTool()` exposes to same-origin unless `exposedTo` is set | Restricts cross-origin discovery by default; matches existing SOP intuitions | Cross-origin widgets need opt-in; separate top-level windows remain outside discovery even with origin opt-in |
| **Explicit origin allowlists** (`exposedTo`, `fromOrigins`) | Site declares trusted origins; browser algorithms enforce the discovery and exposure checks | No platform prompt needed; developer stays in control | Policy choice still depends on the author identifying trusted origins and understanding that exposure is a separate control from framing; enforcement does not supply window-specific consent |
| **Wildcard exposure** (`"*"`, proposed in #188, not yet spec'd) | Tool provider opts every origin in | Solves the "thousands of embedding sites" scaling problem (Shopify-style widget) | Reintroduces CSRF-shaped risk `johannhof` flagged; shifts all vetting burden to the *retrieving* side, symmetric to unchecked `onmessage` handlers |
| **Capability tokens / explicit handoff** (not in the pinned draft; analogous to `MessageChannel` port-passing) | Instead of ambient discovery, a window explicitly hands a caller a reference to specific tools | Removes ambient "any same-group window can look" risk entirely; scopes exposure to an actual, traceable handoff | Requires more plumbing from developers; does not itself specify how a browser-integrated agent would obtain consent in the separate, illustrative observation model |
| **Richer tool annotations** (`readOnlyHint`, `untrustedContentHint` exist; a `bvandersloot-mozilla`-style "consequential" hint does not yet) | Let agents/user agents treat some tools (payments, account changes) as requiring stronger gating than others | Enables risk-proportionate consent — cheap for read-only tools, expensive for high-stakes ones | No behavioral verification that a tool's annotation matches its actual effect (the spec's own "Misrepresentation of Intent" section documents this gap with a deliberately ambiguous `finalizeCart` example) |
| **Platform-enforced consent prompt** (camera/mic pattern) | Browser chrome, not the page, mediates the grant | Cannot be bypassed by a misconfigured or malicious page; user sees who is asking | Doesn't fit: the "who is asking" is another *window's agent*, not legibly explainable to a lay user in a one-line prompt; also reintroduces the permission-fatigue problem at agent speed (see below) |

These rows are design comparisons, not a record of agreed next steps. The pinned draft combines rows one and two; the observed debate is precisely about whether and how far to move toward row three or four.

## The AI-Agent-Specific Stakes

The draft’s prompt-injection discussion and the observation model motivate three concerns. The automation/consent implication below is analysis, not a claim of measured browser behavior:

1. **Confused-deputy via prompt injection.** An in-page agent embedded on (or observing) a page with attacker-influenced content — a forum post, a poisoned tool description, a manipulated review — can be induced to call tools it discovers on a *different* window or origin. Widening `getTools()`'s reach, as #227 proposes, directly widens this attack surface: the reviews-page scenario `bvandersloot-mozilla` raised is a confused-deputy setup almost by construction — untrusted content sits where tools *aren't* consequential, but the agent reading it can, if scoping is broadened, reach a window where they are.
2. **Potential multi-tab automation and consent.** The non-normative observation example leaves observation timing and context selection to implementations. It motivates a design question: if an implementation supports rapid multi-tab orchestration, where should meaningful consent occur? The example alone establishes neither actual browser-agent access nor an interoperable security boundary.
3. **No behavioral contract behind the description.** WebMCP tool descriptions are natural language, not typed, verifiable contracts. The spec's own `finalizeCart` example — named and described ambiguously enough that an agent reasonably infers "preview my cart" when it actually triggers a real purchase — shows a perfectly scoped, correctly-consented call can still produce an unintended, consequential action. Cross-window exposure compounds this: the agent may be reasoning about a tool discovered in a window whose full visual context it never rendered.

Human-in-the-loop consent, the traditional mitigation, is hard to apply cleanly here for the same reason camera/mic prompts don't transfer: a prompt has to be answerable by a non-expert in under a second, but "should Origin A's agent be allowed to call Origin B's `finalizeCart` tool because B is open in another tab" is not a one-second question.

## State at the Historical Cutoff

In this snapshot published 2026-07-31, with discussion observed through 2026-07-30, WebMCP is a Chrome-only origin trial (Chrome 149–156, full ship targeted for Chrome 157), reviewed neutrally by Mozilla and opposed outright by WebKit — meaning cross-browser consensus on the API's existence, let alone its cross-origin security model, doesn't yet exist. Within the spec itself: `getTools()` enumerates the caller’s entire top-level frame tree, filtered by browser-enforced permissions and origins; issue #227 proposes widening that to the browsing-context group and remains open with the two most recent named commenters (`johannhof` and `domfarolino`) still disagreeing about whether a narrower scope actually solves the "sites don't realize they're exposed" problem; issue #188’s wildcard-exposure question is unresolved within the observed discussion; and the spec's own security section has an explicit, unfilled TODO for same-origin-boundary violations. The tool-annotation vocabulary (`readOnlyHint`, `untrustedContentHint`) exists but has no risk tier for "consequential" actions of the kind Mozilla's reviewer flagged by name. Nothing here is close to settled — which is the accurate way to characterize a spec still arguing, in public, about whether restricting embedding is sufficient to protect a site's tools, three months into a browser origin trial.

## Sources

- [WebMCP historical spec source — revision 3678f646 (IDL, discovery algorithms, Permissions Policy, non-normative observations)](https://github.com/webmachinelearning/webmcp/blob/3678f646fc0605ef37a76007c5567d31b6989e2c/index.bs)
- [WebMCP spec, rendered (live; may differ from this historical snapshot)](https://webmachinelearning.github.io/webmcp/)
- [Issue #227 — "Tool discovery should not be limited to a single traversable navigable"](https://github.com/webmachinelearning/webmcp/issues/227)
- [Issue #188 — "Tool retrieval: wildcard or not"](https://github.com/webmachinelearning/webmcp/issues/188)
- [PR #179 — "Toolchange event and permissions policy"](https://github.com/webmachinelearning/webmcp/pull/179)
- [Mozilla standards-positions #1412 — WebMCP (neutral position, bvandersloot-mozilla)](https://github.com/mozilla/standards-positions/issues/1412)
- [WebKit standards-positions #670 — WebMCP (opposed position, mwyrzykowski)](https://github.com/WebKit/standards-positions/issues/670)
- [Chrome for Developers — "Join the WebMCP origin trial"](https://developer.chrome.com/blog/ai-webmcp-origin-trial)
- [MDN — Same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Same-origin_policy)
- [MDN — Permissions Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Permissions_Policy)
- [MDN — Permissions API](https://developer.mozilla.org/en-US/docs/Web/API/Permissions_API)
- [MDN — User activation](https://developer.mozilla.org/en-US/docs/Web/Security/User_activation)
- [MDN — Window.postMessage()](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)
- [Invariant Labs — "MCP Security Notification: Tool Poisoning Attacks"](https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks) (server-side MCP tool poisoning, cited here only to distinguish it from WebMCP's browser-side cross-origin problem)
