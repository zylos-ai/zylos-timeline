---
date: "2026-03-21"
title: "Dynamic Tool Discovery and Capability Negotiation in AI Agent Networks"
description: "How AI agents discover, advertise, negotiate, and invoke tools across multi-agent networks at runtime — covering protocols, schema standards, trust models, and emerging patterns from MCP to WebMCP to decentralized registries."
tags: ["ai-agents", "mcp", "tool-discovery", "multi-agent", "protocols", "capability-negotiation", "webmcp", "a2a", "anp", "infrastructure"]
---

## Executive Summary

Static tool lists are becoming a bottleneck. As agent ecosystems grow from tens to thousands of callable tools, the practice of injecting every tool schema into every prompt breaks down on two fronts: token budgets are exhausted before the conversation starts, and model accuracy degrades as the tool namespace becomes unmanageably large.

The emerging response is a shift from static, compile-time tool registration to dynamic, runtime discovery — agents querying for tools on demand, networks of agents advertising capabilities to each other, and infrastructure layers mediating trust, routing, and governance between them.

This article maps the full stack: the wire protocols that carry tool advertisements, the schema standards that make capabilities machine-readable, the negotiation mechanisms that match requester to provider, and the security models that keep dynamic invocation from becoming an attack surface. It draws on 2025–2026 implementations spanning MCP, A2A, ANP, WebMCP, AGNTCY, Spring AI, and academic research including MCP-Zero.

The central finding: dynamic tool discovery is not a single protocol problem but a layered systems problem, and the industry is converging on a three-tier stack — a registry (or DHT) for advertisement, a semantic matching layer for selection, and a per-invocation trust layer for enforcement.

---

## 1. The Problem with Static Tool Lists

Every mainstream LLM agent framework circa 2023–2024 followed the same pattern: the developer enumerates all tools at startup, serializes their JSON schemas into the system prompt, and the model selects from that fixed menu at inference time. This works at small scale.

At production scale it fails in predictable ways:

**Token exhaustion.** A typical enterprise MCP deployment with 50+ tools consumes 55,000+ tokens before the first user message is processed [1]. With 128k-token context windows, this is not theoretical — it is routine.

**Selection degradation.** Tool selection accuracy drops measurably when models face more than 30 similarly-named tools [1]. The model cannot reliably distinguish `send_email` from `draft_email` from `schedule_email` when all three schemas are present simultaneously.

**Stale catalogs.** Static lists cannot reflect tools that come online after session initialization. In long-running agent sessions or daemon-mode agents, tool availability changes constantly.

**Access control gaps.** If all tools are injected unconditionally, access control must be enforced at invocation time only — there is no opportunity to hide tools the agent should not know about.

Dynamic tool discovery addresses all four problems: agents query for tools when they need them, retrieve only what is relevant, see only what they are authorized to see, and work against a live catalog.

---

## 2. Tool Discovery Protocols

### 2.1 Registry-Based (Centralized Catalog)

The simplest model mirrors a package registry. Agents register tool schemas in a central service; clients query it by name, tag, or semantic description.

**MCP Registry** (launched September 2025) is the canonical example [2]. It is an open catalog and API for discovering publicly available MCP servers — an "app store for MCP servers." Each server publishes an `mcp.json` descriptor. Clients discover servers via the registry API and then negotiate directly with the server's `/tools/list` endpoint.

The MCP Registry explicitly emphasizes **federated discovery**: the official service is a primary source of truth that public marketplaces and private enterprise sub-registries can mirror and extend, all against a shared OpenAPI schema. This gives organizations a private namespace while remaining compatible with the global catalog.

**Google Cloud Vertex AI Agent Builder** takes a similar approach with its Cloud API Registry integration, allowing administrators to govern which tools are available to which agents across an organization [3].

**Architecture sketch (registry-based):**
```
Agent                 Registry              Tool Server
  |                      |                      |
  |-- query("search") -->|                      |
  |<-- [{server, schema}]|                      |
  |                      |                      |
  |-- tools/call --------|--------------------->|
  |<-- result ------------|<---------------------|
```

**Tradeoff:** Centralized registries are operationally simple and support governance, but they are a single point of failure and a bottleneck for large-scale agent networks. They also require trust in the registry operator.

### 2.2 Decentralized / Peer Discovery

For agent networks that span organizational boundaries or must operate without a central authority, peer-based discovery is required.

**Agent Network Protocol (ANP)** uses W3C Decentralized Identifiers (DIDs) as the identity anchor and JSON-LD for capability advertisement [4]. Agents publish metadata describing their functional characteristics; other agents resolve DIDs to discover endpoints and capabilities. The protocol's stated ambition is to be "the HTTP of the agentic web era."

**AGNTCY Agent Directory Service (ADS)** is the most technically detailed implementation of decentralized agent discovery [5]. It uses a Kademlia-based DHT (specifically the libp2p/IPFS Kad-DHT implementation) for two-level mapping:

1. **Capability index → CID** (content-addressed record pointer)
2. **CID → registry endpoint** (where the full agent record lives)

Records are stored as OCI artifacts, signed using Sigstore for provenance, and organized using the Open Agent Schema Framework (OASF) taxonomy. Clients can issue multi-dimensional queries intersecting skill, domain, and feature indices. ADS is also an IETF internet draft (draft-mp-agntcy-ads-00), signaling intent to standardize [6].

**Architecture sketch (DHT-based):**
```
Agent A          Kad-DHT          Agent B (provider)
  |                 |                  |
  |-- query(skill) ->|                 |
  |<- CID ----------|                 |
  |-- resolve(CID) ->|                |
  |<- endpoint ------|                |
  |-- direct connect ----------------->|
  |<-- capability schema --------------|
```

### 2.3 Gossip-Based Discovery

For dynamic, large-scale agent populations where membership is fluid, gossip protocols offer a complementary mechanism to registries and DHTs.

The Gossip-Enhanced Agentic Coordination Layer (GEACL) paper (arXiv:2512.03285) argues that epidemic dissemination is the right substrate for several specific problems in agent networks: decentralized discovery, load signaling, task-availability propagation, failure detection, and emergent consensus [7]. Gossip is not a replacement for MCP or A2A — it operates beneath them, keeping the overlay topology current.

**Hyperspace** implements a three-tier discovery approach: registry → DHT → gossip fallback, with reputation-ranked routing [8]. The gossip layer activates when registry or DHT lookups fail, propagating capability advertisements through the peer overlay.

**Agent Communication & Discovery Protocol (ACDP)** combines a central registry with peer-to-peer gossip for resilience, maintaining capability metadata and credibility metrics in a distributed hash table [9].

### 2.4 Browser-Native Discovery (WebMCP)

WebMCP, shipped in Chrome 146 (February 2026) as an early preview, introduces a qualitatively different discovery model: websites declare their own capabilities as structured tools, and the browser mediates access by AI agents [10].

The `navigator.modelContext` API (exposed on the Navigator interface in secure contexts only) allows web pages to register tools with the browser. An AI agent interacting with the browser can then discover and invoke those tools without needing to parse the DOM or simulate user interactions.

```javascript
// Website registration side
navigator.modelContext.registerTool({
  name: "add_to_cart",
  description: "Add a product to the shopping cart",
  inputSchema: { type: "object", properties: {
    productId: { type: "string" },
    quantity: { type: "integer" }
  }}
});

// Agent discovery side (conceptual)
const tools = await navigator.modelContext.getAvailableTools();
```

This approach achieves 89% token efficiency improvement over screenshot-based browser automation methods [10]. The browser becomes a capability broker: tools are scoped to the current page, the user's session, and browser-enforced permissions.

WebMCP is a W3C Community Group standard, developed by engineers from Google and Microsoft under the Web Machine Learning Community Group.

---

## 3. Capability Advertisement and Description Standards

### 3.1 MCP Tool Schema

The MCP wire format for tool advertisement is the de facto standard for LLM-facing tool interfaces. Each tool is described by:

- `name` — machine identifier
- `description` — natural language description for model consumption
- `inputSchema` — JSON Schema object defining parameters

Discovery occurs via `tools/list` (returns the full catalog) and `tools/call` (invokes a specific tool). The `listChanged` notification flag signals that the tool catalog has changed mid-session, enabling clients to refresh without restarting [11].

```json
{
  "name": "search_documents",
  "description": "Full-text search across the document corpus",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Search query" },
      "limit": { "type": "integer", "default": 10 }
    },
    "required": ["query"]
  }
}
```

### 3.2 A2A Agent Cards

Google's Agent2Agent (A2A) protocol uses a different advertisement primitive: the Agent Card [12]. Rather than describing individual tools, an Agent Card describes an entire agent — its identity, capabilities, skills, authentication requirements, and endpoint. Every A2A-compliant agent publishes `/.well-known/agent.json`.

```json
{
  "name": "Document Processing Agent",
  "version": "1.2.0",
  "description": "Extracts structured data from PDFs and images",
  "endpoint": "https://agents.example.com/doc-processor",
  "skills": [
    { "id": "pdf-extraction", "name": "PDF Data Extraction" },
    { "id": "ocr", "name": "Optical Character Recognition" }
  ],
  "authSchemes": ["oauth2", "api-key"],
  "supportedModes": ["text", "file"]
}
```

A2A launched with support from 50+ technology partners including Atlassian, Salesforce, SAP, Cohere, LangChain, and PayPal [12]. It positions agent capability advertisement at the agent boundary, not the tool boundary — a deliberate design choice that keeps internal tool topology private.

### 3.3 JSON-LD and Semantic Ontologies

For agent networks that need semantic interoperability — where "search" in one agent's vocabulary must align with "retrieve" in another's — syntactic schema matching is insufficient.

ANP uses JSON-LD for capability descriptions, allowing capabilities to be expressed against shared ontologies that link terms to their semantic meaning [4]. This enables:

- Cross-framework tool matching (e.g., an agent built on CrewAI discovering a tool exposed by a LangChain agent)
- Fuzzy matching based on semantic similarity rather than exact name matching
- Ontology-level reasoning about capability composition

The Agentic Ontology of Work defines canonical entities — Objectives, Intents, Agents, Skills, Policies, Outcomes, Assurance Levels, Memory, Guardians — and the semantic relationships between them, designed to be implemented in JSON-LD, RDF/OWL, or knowledge graph frameworks [13].

AGNTCY's ADS uses the Open Agent Schema Framework (OASF) as its base taxonomy, organizing agents by skill, domain, and feature dimensions that support multi-dimensional capability queries [5].

### 3.4 OpenAPI as a Tool Adapter

Several frameworks treat OpenAPI specs as a first-class tool description format, allowing any REST API to be surfaced as agent-callable tools without manual MCP wrapping.

Semantic Kernel's OpenAPI integration can ingest an OpenAPI spec and automatically generate callable plugin functions [14]. Spring AI's MCP boot starters similarly allow existing REST APIs to be exposed as MCP tool servers with minimal configuration [1].

---

## 4. Negotiation Mechanisms

### 4.1 Protocol Capability Negotiation

Before tool invocation, MCP defines a handshake during session initialization. Client and server exchange `initialize` / `initialized` messages that include supported protocol versions and capability flags. This is version negotiation at the protocol level: if the client and server cannot agree on a protocol version, the session fails fast rather than producing silent errors.

ANP adds a **meta-protocol negotiation layer** specifically for this purpose [4]: agents negotiate which application-level protocol to use for their session before exchanging any domain content. This three-layer model (identity → meta-protocol → application) is analogous to TLS negotiating cipher suites before the encrypted channel opens.

### 4.2 Tool Selection: Exact vs. Semantic Matching

Once an agent has a catalog of tools, selecting the right one is a non-trivial problem.

**Exact matching** (by tool name or ID) is fast and deterministic but requires the calling agent to already know what to call — eliminating most of the benefit of dynamic discovery.

**Semantic matching** uses embedding similarity between the agent's expressed intent and tool descriptions. MCP-Zero (arXiv:2506.01056) introduces a two-stage hierarchical semantic routing algorithm [15]:

1. **Server-level routing**: Match the request against server descriptions to identify candidate servers
2. **Tool-level routing**: Within candidate servers, match against individual tool descriptions

This approach scales to 2,797 tools across 308 MCP servers while maintaining accuracy and achieving a 98% reduction in token consumption on the APIBank benchmark [15].

Spring AI's Tool Search Tool pattern implements a similar approach: the agent receives only a search tool initially, issues a query against a vector index of tool descriptions, and receives the relevant tool schemas expanded into context on demand [1]. This achieves 34–64% token savings across tested models.

**Comparison table:**

| Strategy | Accuracy | Token cost | Latency | Scales to |
|---|---|---|---|---|
| All tools in prompt | Degrades >30 tools | Very high | Zero | ~30 tools |
| Keyword search | Moderate | Low | Low | ~500 tools |
| Vector/semantic search | High | Low | Medium | ~5,000 tools |
| Hierarchical (MCP-Zero) | High | Very low | Medium | ~3,000 tools |
| LLM-generated request | Highest | Medium | High | ~10,000 tools |

### 4.3 QoS and Cost-Aware Routing

As tool providers multiply, selection criteria extend beyond capability matching to operational considerations: latency, cost, reliability, and rate limits.

The AGNTCY architecture supports credibility metrics alongside capability descriptions, allowing agents to route based on historical performance data [5]. Microsoft's MCP Gateway evaluates agent identity, workspace, environment, and governance rules before returning discovery results — agents only see tools they are authorized to discover, and the gateway tracks usage for billing and audit [16].

### 4.4 Natural Language Negotiation

In multi-agent scenarios where agents interact as peers rather than client/server, negotiation can take place through natural language. AgenticPay (arXiv:2602.06008) demonstrates buyer-seller negotiations entirely in natural language, with agents expressing preferences, constraints, and counteroffers across multi-turn dialogues [17]. Supply chain research shows LLM agents can achieve consensus-based coordination that outperforms rule-based restocking policies [18].

This is a departure from protocol-level negotiation and suggests that for complex capability matching, the LLM reasoning layer may be more appropriate than a fixed negotiation protocol.

---

## 5. Runtime Tool Composition

### 5.1 Dynamic Workflow Assembly

Static workflows predetermine the sequence of tool calls. Dynamic workflows let the agent determine sequence at runtime based on intermediate results.

The LangGraph orchestration model represents this as a stateful graph: nodes are agent steps, edges are conditional transitions, and the agent can decide which node to visit next based on the current state [19]. Tool chains emerge from agent decisions rather than developer specifications.

**Tool chaining pattern:**
```
Task: "Find recent papers on X and summarize the key findings"

Agent decides:
  1. search_papers(query="X", since="2025-01-01")
  2. For each result: fetch_abstract(doi=...)  [parallel]
  3. summarize(texts=[...])
  4. format_output(summary=...)
```

None of steps 2–4 are known until step 1 returns results. The agent composes the workflow dynamically.

### 5.2 Fallback and Retry

Production tool networks must handle provider failures. Standard patterns from service mesh design apply:

**Circuit breaker**: Track failure rates per tool provider. When failures exceed a threshold, route to an alternative provider and stop sending traffic to the failing one until recovery [20].

**Fallback chains**: If `tool_v2` is unavailable, try `tool_v1`, then try `fallback_tool`, then degrade gracefully. MCP's `listChanged` notification enables agents to detect when a tool disappears and trigger re-discovery.

**Timeout cascades**: Set decreasing timeouts at each fallback level to bound total wait time.

MCP-Zero's **Iterative Capability Extension** mechanism is relevant here: agents progressively build cross-domain toolchains by requesting additional tools when they encounter capability gaps, rather than failing [15]. This is a form of dynamic fallback where the agent requests an alternative capability from the discovery layer.

### 5.3 Cross-Framework Tool Sharing

A practical interoperability problem: an agent built in AutoGen needs to call a tool registered in LangChain. The frameworks have different tool interface conventions.

LangGraph's integration layer accepts LangChain tools natively and exposes a bridge for AutoGen and CrewAI agents [21]. MCP is emerging as a lowest-common-denominator transport: if both frameworks support MCP, the tool is accessible regardless of where it originated.

The Microsoft Agent Framework explicitly positions MCP as the glue: it parses tool schemas, handles invocation, and presents tools to the agent without requiring framework-specific wrappers [22].

---

## 6. Security Considerations

### 6.1 Trust Bootstrapping for Unknown Tools

Dynamic discovery introduces a fundamental trust problem: the agent encounters a tool it has never seen before. How does it decide whether to invoke it?

**Attestation** is the cryptographic answer. AGNTCY ADS integrates Sigstore for provenance: every agent record is signed, and the signature is verifiable against Sigstore's transparency log [5]. The nono agent sandbox similarly uses Sigstore attestation with DSSE envelopes and SLSA-style statements [23].

**Agent Cards** in A2A can include authentication requirements, allowing the calling agent to verify that a remote agent supports a known auth scheme before sharing credentials or data [12].

**Registry vouching**: A trusted registry can act as a reputation anchor. The MCP Registry's "federated but primary" model means that servers listed in the official registry have passed a baseline review, giving clients a signal (though not a guarantee) of legitimacy.

### 6.2 Capability-Based Access Control

Tool gating treats every tool invocation as a capability request evaluated at runtime. The gateway intercepts the call, checks the agent's scoped permissions, and dynamically allows or drops the request [16].

This is capability-based security applied to tool invocation: agents hold capability tokens that authorize specific tool calls, and the gateway enforces these boundaries at the perimeter rather than relying on in-agent logic.

Microsoft's Agent Governance Toolkit implements this as zero-trust agent identity: every agent has a verifiable identity (via Microsoft Entra Agent ID), and tool access is granted based on that identity combined with policy rules [24].

### 6.3 Sandboxing Discovered Tools

Code execution tools discovered dynamically must be isolated. The threat model is that a malicious tool server could return a tool that, when invoked, executes adversarial code in the agent's environment.

Standard approaches:

- **Process isolation**: Execute discovered tools in a subprocess with a restricted capability set
- **Container sandboxing**: Run tool servers in ephemeral containers with network egress controls
- **vTPM attestation**: Omega's trusted boot mechanism measures each component during boot using a virtual TPM, allowing the agent to verify that the tool server is running a known, unmodified binary [25]

The UK AI Safety Institute's Inspect Sandboxing Toolkit separates model execution from the tool execution environment entirely — the model process cannot directly access the sandbox; all tool calls are mediated through the Inspect layer [26].

### 6.4 Prompt Injection via Tool Descriptions

A subtle attack vector: a malicious tool server can inject instructions into the `description` field of a tool schema, attempting to override agent behavior when the schema is included in the prompt context.

Mitigations include:
- Sanitizing tool descriptions before including them in prompts
- Using a separate, trusted source for tool descriptions (e.g., the registry's canonical record) rather than the tool server's self-reported description
- Monitoring for anomalous tool description lengths or unusual instruction patterns

The OWASP Agentic AI Security Cheat Sheet identifies tool description injection as a top-10 threat [27].

---

## 7. Real-World Implementations

### 7.1 MCP Ecosystem

MCP (Model Context Protocol), released by Anthropic and now maintained as an open standard, is the most widely adopted tool interface protocol. Its tool discovery flow:

1. Client connects to server (stdio or SSE transport)
2. Both sides exchange `initialize` / `initialized` with protocol version and capability flags
3. Client calls `tools/list` to retrieve the full tool catalog
4. Server can push `tools/list_changed` notifications when the catalog changes
5. Client calls `tools/call` to invoke a specific tool

Spring AI extends this with dynamic tool refresh: the client re-fetches `tools/list` on each invocation without session restart, ensuring the agent always has an up-to-date view [1].

### 7.2 WebMCP (Chrome 146+)

WebMCP ships `navigator.modelContext` as a browser primitive. Websites register tools; the browser maintains a per-tab tool registry. AI agents access the registry through the browser extension or a WebMCP-aware agent runtime.

Key security properties enforced by the browser [10]:
- Tools are scoped to the current page's origin
- Tool invocations require user permission on first use per origin
- Tools cannot access cross-origin data unless CORS allows it
- HTTPS is required (secure contexts only)

### 7.3 Semantic Kernel Plugins

Semantic Kernel's plugin discovery uses reflection at initialization time: the kernel scans for methods decorated with `[KernelFunction]` and `[Description]` attributes, extracts parameter names and types, and generates JSON Schema descriptors. These are serialized into the tool-calling payload sent to the LLM [14].

With OpenAI's function calling (and equivalents in Claude, Gemini, Mistral), the kernel sends `tools` alongside the conversation, and the model returns a structured `tool_calls` object. Semantic Kernel 1.x replaced its planner abstraction with native function calling as the primary planning mechanism.

### 7.4 AutoGen Tool Sharing

AutoGen's multi-agent architecture allows agents in a conversation to share tools through function registration. In group chat scenarios, tools registered on any participant agent are available to the orchestrating agent. AutoGen 0.4+ (the "agentic" rewrite) supports MCP server connections, enabling AutoGen agents to consume tools from the broader MCP ecosystem [21].

### 7.5 MCP-Zero (Research)

MCP-Zero (arXiv:2506.01056, June 2025) represents the most advanced published approach to active tool discovery [15]. Instead of the agent passively selecting from a pre-provided list, MCP-Zero agents:

1. **Actively generate structured tool requests** specifying their exact requirements
2. **Route requests hierarchically** — first matching to relevant servers, then to tools within those servers
3. **Iteratively extend their toolchain** as they encounter capability gaps

Results: 98% token reduction on APIBank, accurate selection from 2,797 tools across 308 servers (248k token catalog). This is the state of the art as of early 2026.

---

## 8. Emerging Patterns

### 8.1 Tool Marketplaces

The registry model is evolving into full marketplaces with monetization, ratings, and SLA commitments.

Google Cloud AI Agent Marketplace features partner agents integrated with Gemini Enterprise [3]. Oracle AI Agent Marketplace provides agent templates from ISVs and SIs [28]. TrueFoundry's MCP tool discovery layer for enterprise AI agents includes governance, metering, and access control [29].

The MAGENTIC MARKETPLACE paper (Microsoft Research) formalizes this as an "agentic market" where agents bid for tasks, tools auction capabilities, and market mechanisms emerge from agent interactions [30].

### 8.2 Federated Registries

No single organization will own the global agent tool registry. The pattern that is emerging is federation: a common schema and API, multiple authoritative registries (one per organization or domain), and cross-registry discovery.

MCP Registry's federated model, AGNTCY ADS's IPFS-backed distribution, and ANP's DID-based identity all point toward this structure. The IETF draft (draft-mp-agntcy-ads-00) suggests this will eventually be an internet standard.

### 8.3 Capability Auctions and Economic Routing

When multiple agents can satisfy a request, which one should be selected? Cost and latency are obvious criteria, but trust, specialization, and data locality matter too.

The Hyperspace protocol implements reputation-ranked routing: tools with better historical performance rank higher in discovery results [8]. This is a lightweight reputation system without explicit auctions.

Full economic mechanisms — where tool providers submit bids and the requester selects based on price, SLA, and capability — are explored in the MAGENTIC MARKETPLACE research but not yet production-deployed [30].

### 8.4 Cross-Platform Tool Bridging

HXA-Connect and similar multi-agent platforms face the bridging problem: tools registered in one platform's ecosystem must be accessible from agents on another platform.

The practical answer today is MCP as the universal adapter: any tool wrapped in an MCP server is accessible from any MCP-capable agent runtime, regardless of the originating framework. This is why Spring AI, AutoGen, Semantic Kernel, and LangChain are all racing to add MCP client support.

ANP takes this further with its meta-protocol negotiation layer: agents negotiate which application protocol to use for a given session, allowing future protocol evolution without breaking existing agent deployments [4].

### 8.5 The Semantic Web Connection

The shift to JSON-LD capability descriptions and ontology-based matching is a partial rehabilitation of Semantic Web ideas — the vision of machine-readable, semantically linked data that did not fully materialize in the 2000s.

Agent-OM (VLDB 2026) demonstrates LLM agents being used for ontology matching itself: when two agents use different vocabularies for the same concept, an LLM can bridge them by identifying semantic equivalences [31]. This closes a key gap in the federation model — agents from different organizations can now interoperate even when their capability vocabularies were developed independently.

---

## 9. Architecture Reference

### Layered Stack

```
┌─────────────────────────────────────────────────────┐
│  Application Layer: Agent Logic / Orchestration     │
├─────────────────────────────────────────────────────┤
│  Negotiation Layer                                  │
│  - Version negotiation (MCP initialize)             │
│  - Capability matching (semantic search, MCP-Zero)  │
│  - Provider selection (cost, latency, trust)        │
├─────────────────────────────────────────────────────┤
│  Discovery Layer                                    │
│  - Centralized: MCP Registry, Vertex AI API Reg.    │
│  - Federated: AGNTCY ADS (Kad-DHT + OCI)           │
│  - Browser-native: WebMCP navigator.modelContext    │
│  - P2P gossip: GEACL, Hyperspace                   │
├─────────────────────────────────────────────────────┤
│  Advertisement Layer                                │
│  - MCP tools/list + tool schemas (JSON Schema)     │
│  - A2A Agent Cards (/.well-known/agent.json)       │
│  - ANP JSON-LD capability descriptions             │
│  - SK [KernelFunction] attribute reflection        │
├─────────────────────────────────────────────────────┤
│  Identity & Trust Layer                             │
│  - DIDs (ANP), Entra Agent ID (Microsoft)          │
│  - Sigstore attestation (AGNTCY)                   │
│  - TLS + OAuth2 / API key (MCP, A2A)               │
│  - Browser origin scoping (WebMCP)                 │
└─────────────────────────────────────────────────────┘
```

### Protocol Comparison

| Protocol | Discovery model | Advertisement unit | Auth model | Standardization |
|---|---|---|---|---|
| MCP | Registry + direct | Tool schema (JSON Schema) | OAuth2, API key | Anthropic + open |
| A2A | Well-known URL | Agent Card (JSON) | OAuth2, API key, JWT | Google + 50 partners |
| ANP | DID + DHT | JSON-LD capability doc | DID-based | Open, IETF proposed |
| ADS (AGNTCY) | Kad-DHT | OCI artifact + OASF | Sigstore | Open, IETF draft |
| WebMCP | Browser registry | Tool schema (JSON Schema) | Browser origin | W3C Community Group |

---

## 10. Open Problems

**Capability versioning.** What happens when a tool's schema changes? MCP's `listChanged` notification handles availability changes but not schema evolution. Semantic versioning for tool schemas is an open design question.

**Cross-registry trust.** If registry A vouches for a tool server, should registry B's clients trust it? Federated trust models (analogous to certificate authority cross-signing) have not been standardized.

**Capability negotiation under adversarial conditions.** If a malicious agent can publish fake capabilities to a DHT or gossip overlay, how do honest agents avoid selecting them? Reputation systems help but require sufficient history.

**Real-time capability streaming.** Current discovery protocols are request-response. For high-frequency agent interactions, a publish-subscribe model (agents subscribing to capability updates from providers they trust) may be more efficient than periodic polling.

**Regulatory compliance.** As tool marketplaces emerge, questions of liability, data residency, and auditability become acute. Which agent is responsible when a dynamically discovered tool causes harm?

---

## References

[1] Spring AI. "Smart Tool Selection: Achieving 34-64% Token Savings with Spring AI's Dynamic Tool Discovery." spring.io, December 2025. https://spring.io/blog/2025/12/11/spring-ai-tool-search-tools-tzolov/

[2] Model Context Protocol Blog. "Introducing the MCP Registry." September 2025. https://blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview/

[3] Google Cloud. "New Enhanced Tool Governance in Vertex AI Agent Builder." https://cloud.google.com/blog/products/ai-machine-learning/new-enhanced-tool-governance-in-vertex-ai-agent-builder

[4] Agent Network Protocol. "ANP Technical White Paper." arXiv:2508.00007. https://arxiv.org/abs/2508.00007

[5] AGNTCY. "The AGNTCY Agent Directory Service: Architecture and Implementation." arXiv:2509.18787. https://arxiv.org/abs/2509.18787v1

[6] IETF. "Agent Directory Service." Internet Draft draft-mp-agntcy-ads-00. https://datatracker.ietf.org/doc/draft-mp-agntcy-ads/

[7] arXiv:2512.03285. "A Gossip-Enhanced Communication Substrate for Agentic AI: Toward Decentralized Coordination in Large-Scale Multi-Agent Systems." December 2025. https://arxiv.org/abs/2512.03285

[8] Hyperspace. "Gossiping Agents Protocol." https://protocol.hyper.space/

[9] CMDZero. "Introducing the Agent Communication & Discovery Protocol (ACDP)." https://www.cmdzero.io/blog-posts/introducing-the-agent-communication-discovery-protocol-acdp-a-proposal-for-ai-agents-to-discover-and-collaborate-with-each-other

[10] WinBuzzer. "Google Chrome Ships WebMCP, Turning Websites Into AI Agent Tools." February 2026. https://winbuzzer.com/2026/02/13/google-chrome-webmcp-early-preview-ai-agents-xcxwbn/

[11] Model Context Protocol. "Tools — MCP Concepts." https://modelcontextprotocol.info/docs/concepts/tools/

[12] Google Developers Blog. "Announcing the Agent2Agent Protocol (A2A)." https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/

[13] Skan.ai. "AI Agents Needed a Common Language. So We Built One." https://www.skan.ai/whitepapers/agentic-ontology-of-work

[14] Microsoft Learn. "Plugins in Semantic Kernel." https://learn.microsoft.com/en-us/semantic-kernel/concepts/plugins/

[15] Fei, X., Zheng, X., and Feng, H. "MCP-Zero: Active Tool Discovery for Autonomous LLM Agents." arXiv:2506.01056. June 2025. https://arxiv.org/abs/2506.01056

[16] GitHub: agentic-community/mcp-gateway-registry. "Enterprise-ready MCP Gateway & Registry." https://github.com/agentic-community/mcp-gateway-registry

[17] arXiv:2602.06008. "AgenticPay: A Multi-Agent LLM Negotiation System for Buyer-Seller Transactions." February 2026. https://arxiv.org/html/2602.06008v1

[18] Taylor & Francis. "Agentic LLMs in the supply chain: towards autonomous multi-agent consensus-seeking." https://www.tandfonline.com/doi/full/10.1080/00207543.2025.2604311

[19] LangChain. "LangGraph: Multi-Agent Workflows." https://blog.langchain.com/langgraph-multi-agent-workflows/

[20] Microsoft Learn. "AI Agent Orchestration Patterns — Azure Architecture Center." https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns

[21] LangChain Docs. "How to integrate LangGraph with AutoGen, CrewAI, and other frameworks." https://docs.langchain.com/langgraph-platform/autogen-integration

[22] Microsoft Foundry Blog. "Introducing Microsoft Agent Framework." https://devblogs.microsoft.com/foundry/introducing-microsoft-agent-framework-the-open-source-engine-for-agentic-ai-apps/

[23] GitHub: always-further/nono. "Kernel-enforced agent sandbox." https://github.com/always-further/nono

[24] GitHub: microsoft/agent-governance-toolkit. "AI Agent Governance Toolkit." https://github.com/microsoft/agent-governance-toolkit

[25] arXiv:2512.05951. "Trusted AI Agents in the Cloud." https://arxiv.org/html/2512.05951v1

[26] UK AI Safety Institute. "The Inspect Sandboxing Toolkit." https://www.aisi.gov.uk/blog/the-inspect-sandboxing-toolkit-scalable-and-secure-ai-agent-evaluations

[27] OWASP. "AI Agent Security Cheat Sheet." https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html

[28] Oracle. "Introducing AI Agent Marketplace." https://blogs.oracle.com/fusioninsider/introducing-ai-agent-marketplace

[29] TrueFoundry. "MCP Tool Discovery for Enterprise AI Agents." https://www.truefoundry.com/blog/mcp-tool-discovery-for-enterprise-ai-agents

[30] Microsoft Research. "MAGENTIC MARKETPLACE: An Open-Source Environment for Studying Agentic Markets." https://www.microsoft.com/en-us/research/wp-content/uploads/2025/10/multi-agent-marketplace.pdf

[31] Qiang, Z. et al. "Agent-OM: Leveraging LLM Agents for Ontology Matching." PVLDB Vol. 18. https://dl.acm.org/doi/10.14778/3712221.3712222
