---
date: "2026-02-22"
title: "TypeScript SDK Design Patterns for AI Agent Platforms"
description: "A deep dive into how leading AI platforms design their TypeScript SDKs, covering authentication, type safety, streaming, error handling, and developer experience patterns applicable to agent-to-agent communication platforms."
tags: ["typescript", "sdk-design", "ai-agents", "developer-experience", "api-design"]
---

## Executive Summary

The TypeScript SDK ecosystem for AI agent platforms has matured rapidly through 2025 into a recognizable set of converging design patterns. What was once a patchwork of bespoke client libraries has crystallized into consistent conventions: resource-based client hierarchies, unified streaming via async iterators, Zod-backed runtime validation, middleware chains for cross-cutting concerns, and agent-first abstractions that treat multi-step orchestration as a first-class primitive.

This article examines the design choices made by the most influential SDKs in the space — Anthropic, OpenAI, Vercel AI SDK, LangChain.js, Mastra, and the Model Context Protocol — and distills the patterns that are most applicable to building robust agent-to-agent communication platforms in TypeScript. Where these patterns converge, they represent emerging community consensus. Where they diverge, the differences reveal genuine trade-offs worth understanding before designing your own SDK surface.

---

## Client Initialization and Authentication

### The Configuration Object Pattern

All modern AI SDKs have converged on accepting a single configuration object at construction time rather than multiple positional parameters. This makes initialization readable, extensible without breaking changes, and easy to document.

```typescript
// Anthropic SDK pattern
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,   // falls back to env automatically
  baseURL: 'https://custom-proxy.example.com',
  maxRetries: 3,
  timeout: 60_000,                          // milliseconds
  dangerouslyAllowBrowser: false,
});

// OpenAI SDK — same pattern
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  organization: 'org-...',
  project: 'proj-...',
  baseURL: process.env.OPENAI_BASE_URL,
});
```

The key insight is that the constructor should have sensible environment-variable fallbacks for sensitive values like API keys. This lets the most common use case (a single key from the environment) require zero configuration while still supporting advanced scenarios through the options object.

### Cloud Provider Adapter Pattern

Anthropic's SDK illustrates how to extend a base client for cloud-specific authentication without forking the entire library:

```typescript
// @anthropic-ai/bedrock-sdk
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';

const client = new AnthropicBedrock({
  // Credentials from AWS environment automatically
  awsRegion: 'us-east-1',
});

// @anthropic-ai/vertex-sdk
import AnthropicVertex from '@anthropic-ai/vertex-sdk';

const client = new AnthropicVertex({
  projectId: 'my-project',
  region: 'us-central1',
});
```

Each adapter extends `BaseAnthropic`, which handles the HTTP mechanics, and only overrides the authentication and endpoint resolution layer. This is the right abstraction boundary: authentication is a concern of client construction, not of individual API method calls.

### Lazy Environment Resolution

A subtle but important DX detail: API keys should be resolved at call time rather than at construction time in browser environments. This supports usage patterns where the key is injected asynchronously (e.g., from a secrets manager) after the client is constructed.

---

## Resource-Based API Organization

Both Anthropic and OpenAI organize their APIs as a tree of resource classes hanging off the root client:

```typescript
// Hierarchical resource accessors
client.messages.create(...)
client.messages.batches.create(...)
client.models.list(...)
client.beta.messages.stream(...)
client.beta.messages.toolRunner(...)
```

This organization mirrors the HTTP URL structure and gives the IDE auto-complete a natural discovery surface. Typing `client.` in an editor surfaces all available resource groups; typing `client.messages.` surfaces all message operations.

The practical implication for SDK design is: **group operations by the noun (resource) they act on, not by the verb**. `client.messages.create()` is better than `client.createMessage()` at scale because it keeps a flat root namespace.

---

## Type Safety Architecture

### Exported Parameter and Response Types

The Anthropic SDK exports named types for every request parameter object and every response shape:

```typescript
import type { MessageCreateParams, Message, Usage } from '@anthropic-ai/sdk';

const params: MessageCreateParams = {
  model: 'claude-opus-4-6',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
};

const response: Message = await client.messages.create(params);
const usage: Usage = response.usage;
```

This is essential for TypeScript codebases that pass request objects between functions. Without exported parameter types, users are forced to use `Parameters<typeof client.messages.create>[0]` which is fragile and opaque.

### Discriminated Unions for Response Variants

AI SDK responses commonly contain variant content types. Discriminated unions make these safe to handle:

```typescript
// Anthropic message content block
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'thinking'; thinking: string };

// Type-safe narrowing
for (const block of message.content) {
  switch (block.type) {
    case 'text':
      console.log(block.text);      // TypeScript knows .text exists
      break;
    case 'tool_use':
      console.log(block.name);      // TypeScript knows .name exists
      break;
  }
}
```

The `type` literal discriminant is the load-bearing property. Every response variant union in a well-designed SDK should carry one. The Zod `.safeParse()` return value is a canonical example from the ecosystem:

```typescript
const result = schema.safeParse(data);
if (result.success) {
  result.data;  // typed as the schema's output
} else {
  result.error; // typed as ZodError
}
```

### Zod Integration for Runtime Validation

TypeScript types are erased at runtime. Any data crossing an I/O boundary — API responses, user input, webhook payloads — is `unknown` until validated. Zod has become the de facto solution for bridging this gap, and SDK authors have adopted it deeply.

The Anthropic SDK exposes a `betaZodTool` helper that converts a Zod schema directly into a tool definition:

```typescript
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

const searchTool = betaZodTool({
  name: 'web_search',
  description: 'Search the web for current information',
  inputSchema: z.object({
    query: z.string().describe('The search query'),
    num_results: z.number().int().min(1).max(10).default(5),
  }),
  run: async (input) => {
    // input is fully typed: { query: string; num_results: number }
    return await search(input.query, input.num_results);
  },
});
```

The pattern converts a Zod schema to JSON Schema (for the LLM to understand the tool's shape), and then validates the LLM's output against the same schema before passing it to `run`. This eliminates an entire class of runtime errors where a hallucinating model produces invalid tool arguments.

The Vercel AI SDK and OpenAI Agents SDK follow the same pattern. LangChain.js makes Zod-based tool definitions the primary recommended path:

```typescript
// LangChain.js tool with Zod schema
import { tool } from '@langchain/core/tools';

const calculatorTool = tool(
  async ({ expression }) => {
    return eval(expression).toString();
  },
  {
    name: 'calculator',
    description: 'Evaluate a mathematical expression',
    schema: z.object({
      expression: z.string().describe('Mathematical expression to evaluate'),
    }),
  }
);
```

### Infer Types from Zod Schemas

The canonical Zod usage pattern eliminates type duplication entirely:

```typescript
const AgentConfigSchema = z.object({
  model: z.enum(['claude-opus-4-6', 'claude-sonnet-4-6', 'gpt-4o']),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().positive().default(4096),
  systemPrompt: z.string().optional(),
});

// Single source of truth: schema drives both runtime validation AND TypeScript type
type AgentConfig = z.infer<typeof AgentConfigSchema>;

function createAgent(config: AgentConfig) { /* ... */ }

// Validate at the entry point, trust inside
const rawConfig = JSON.parse(process.env.AGENT_CONFIG ?? '{}');
const config = AgentConfigSchema.parse(rawConfig);  // throws on invalid
createAgent(config);  // config is fully typed
```

---

## Streaming Architecture

### Async Iterator as the Universal Interface

All major SDKs have standardized on async iterators (`for await...of`) as the primary streaming consumption interface. This pattern composes naturally with Node.js streams, is supported natively in modern browsers, and requires no extra dependencies.

```typescript
// Anthropic: two paths, same result
// Path 1: streaming with helper events
const stream = client.messages.stream({
  model: 'claude-opus-4-6',
  max_tokens: 2048,
  messages: [{ role: 'user', content: prompt }],
});

stream.on('text', (delta) => process.stdout.write(delta));
const final = await stream.finalMessage();

// Path 2: raw SSE iteration
const rawStream = await client.messages.create({
  model: 'claude-opus-4-6',
  max_tokens: 2048,
  messages: [{ role: 'user', content: prompt }],
  stream: true,
});

for await (const event of rawStream) {
  if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
    process.stdout.write(event.delta.text);
  }
}
```

The dual-path design is instructive: a high-level helper API for common cases (get all text deltas, then the complete message) layered over a low-level raw iterator for advanced use cases (custom event types, tool streaming, progress tracking).

### TransformStream for Middleware Pipelines

The Vercel AI SDK's middleware system uses `TransformStream` to intercept streaming chunks — a pattern worth understanding for any platform that needs to instrument or modify streams:

```typescript
// Logging middleware implementation
const loggingMiddleware: LanguageModelMiddleware = {
  wrapStream: async ({ doStream, params }) => {
    console.log('Stream started:', params.prompt);
    const { stream, ...rest } = await doStream();

    let fullText = '';
    const transformStream = new TransformStream<LanguageModelStreamPart>({
      transform(chunk, controller) {
        if (chunk.type === 'text-delta') {
          fullText += chunk.textDelta;
        }
        controller.enqueue(chunk);  // pass through unchanged
      },
      flush() {
        console.log('Stream complete. Total text:', fullText.length, 'chars');
      },
    });

    return { stream: stream.pipeThrough(transformStream), ...rest };
  },
};
```

Applying middleware through composition:

```typescript
const wrappedModel = wrapLanguageModel({
  model: anthropic('claude-opus-4-6'),
  middleware: [loggingMiddleware, cachingMiddleware, guardrailMiddleware],
  // Applied in order: logging → caching → guardrails → model
});
```

### Cancellation and Backpressure

Well-designed streaming SDKs expose explicit cancellation:

```typescript
const stream = client.messages.stream({ /* ... */ });

// Consumer-side abort
const timeoutId = setTimeout(() => stream.controller.abort(), 30_000);

for await (const event of stream) {
  process(event);
}

clearTimeout(timeoutId);

// Or use break — the SDK cleans up automatically
for await (const chunk of stream) {
  if (shouldStop(chunk)) break;  // SDK calls .abort() internally
}
```

---

## Error Handling

### Typed Error Hierarchies

Good SDK error hierarchies let callers handle errors at the right level of specificity:

```typescript
// Anthropic error hierarchy
AnthropicError
  ├── APIError
  │     ├── AuthenticationError (401)
  │     ├── PermissionDeniedError (403)
  │     ├── NotFoundError (404)
  │     ├── RateLimitError (429)
  │     ├── InternalServerError (500, 529)
  │     └── APIConnectionError (network failures)
  └── ToolError  (tool execution failures)

// Usage
try {
  const message = await client.messages.create(params);
} catch (err) {
  if (err instanceof Anthropic.RateLimitError) {
    await sleep(err.headers?.['retry-after-ms'] ?? 5000);
    return retry();
  }
  if (err instanceof Anthropic.AuthenticationError) {
    throw new Error('Invalid API key — check ANTHROPIC_API_KEY');
  }
  throw err;  // re-throw unexpected errors
}
```

The `instanceof` check works across module boundaries only if the error classes are exported from the package root. Always export your error classes.

### Automatic Retry with Exponential Backoff

All major SDKs handle transient failures transparently. The pattern:

- Retry on: 408 (request timeout), 409 (conflict), 429 (rate limit), 500/502/503/529 (server errors)
- Do not retry: 400 (bad request), 401 (authentication), 403 (forbidden), 404 (not found)
- Backoff strategy: exponential with jitter, respecting `Retry-After` and `X-RateLimit-Reset-Requests` headers

```typescript
const client = new Anthropic({
  maxRetries: 2,      // 0 = no retries, default = 2
  timeout: 60_000,    // per-attempt timeout, not total
});

// Override per-request
const response = await client.messages.create(params, {
  maxRetries: 5,
  timeout: 120_000,
});
```

---

## Agent Orchestration Patterns

### The Agent as Configuration Object

Modern agent SDKs have converged on defining agents as declarative configuration objects rather than classes with methods. This separates the "what the agent is" from "how it runs":

```typescript
// Vercel AI SDK 6
const weatherAgent = new ToolLoopAgent({
  model: anthropic('claude-opus-4-6'),
  instructions: 'You are a weather assistant. Use tools to answer weather questions.',
  tools: {
    getWeather: weatherTool,
    getForecast: forecastTool,
  },
  callOptionsSchema: z.object({
    userId: z.string(),
    units: z.enum(['celsius', 'fahrenheit']).default('celsius'),
  }),
});

// OpenAI Agents SDK
const triageAgent = new Agent({
  name: 'Triage Agent',
  instructions: 'Route customer requests to the appropriate specialist.',
  tools: [searchKnowledgeBase],
  handoffs: [billingAgent, technicalAgent, salesAgent],
});
```

### Handoff Pattern for Multi-Agent Systems

The handoff pattern — where an agent can delegate the entire conversation to a specialist — cleanly solves the problem of routing complex requests through a hierarchy of agents without building custom orchestration logic:

```typescript
// OpenAI Agents SDK handoff pattern
import { Agent, run } from '@openai/agents';

const billingAgent = new Agent({
  name: 'Billing Specialist',
  instructions: 'Handle all billing questions and disputes.',
});

const techAgent = new Agent({
  name: 'Technical Support',
  instructions: 'Diagnose and resolve technical issues.',
});

const routerAgent = new Agent({
  name: 'Customer Service Router',
  instructions: 'Identify the customer need and hand off to the right agent.',
  handoffs: [billingAgent, techAgent],
});

// Execution — the SDK handles handoff transitions automatically
const result = await run(routerAgent, 'I was double charged last month');
console.log(result.finalOutput);  // answer from whichever agent handled it
```

### Graph-Based Workflow Orchestration (LangChain/Mastra)

For workflows that need deterministic branching rather than LLM-driven routing, graph-based models are more appropriate:

```typescript
// Mastra workflow pattern
import { createWorkflow, createStep } from '@mastra/core';

const parseInput = createStep({
  id: 'parse-input',
  execute: async ({ context }) => ({
    query: context.triggerData.rawInput.trim(),
    timestamp: Date.now(),
  }),
});

const classifyIntent = createStep({
  id: 'classify-intent',
  execute: async ({ context }) => {
    const { query } = context.getStepResult('parse-input');
    const intent = await llm.classify(query);
    return { intent };
  },
});

const pipeline = createWorkflow({ name: 'request-pipeline', triggerSchema: z.object({ rawInput: z.string() }) })
  .then(parseInput)
  .then(classifyIntent)
  .branch([
    [({ context }) => context.getStepResult('classify-intent').intent === 'billing', billingStep],
    [({ context }) => context.getStepResult('classify-intent').intent === 'technical', techStep],
  ]);
```

---

## WebSocket Management for Agent Platforms

Agent-to-agent communication platforms often require persistent bidirectional connections. Well-designed SDKs handle the complexity of connection lifecycle so application code remains clean.

### Reconnection with Exponential Backoff and Jitter

```typescript
class AgentConnection {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private readonly baseDelay = 1000; // ms

  async connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        resolve();
      };

      this.ws.onclose = (event) => {
        if (!event.wasClean) {
          this.scheduleReconnect(url);
        }
      };

      this.ws.onerror = (error) => {
        if (this.reconnectAttempts === 0) reject(error);
      };
    });
  }

  private scheduleReconnect(url: string): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit('max-reconnects-reached');
      return;
    }

    const exponentialDelay = this.baseDelay * Math.pow(2, this.reconnectAttempts);
    const jitter = Math.random() * 1000;  // prevent thundering herd
    const delay = Math.min(exponentialDelay + jitter, 30_000);

    this.reconnectAttempts++;
    setTimeout(() => this.connect(url), delay);
  }
}
```

### Message Sequencing and Resume

For agent-to-agent platforms, tracking message sequence numbers enables stream resumption after reconnection:

```typescript
interface AgentMessage {
  seq: number;
  type: 'task' | 'result' | 'heartbeat' | 'ack';
  payload: unknown;
  timestamp: number;
}

class SequencedChannel {
  private lastAckedSeq = 0;
  private pendingMessages = new Map<number, AgentMessage>();

  send(message: Omit<AgentMessage, 'seq' | 'timestamp'>): void {
    const seq = ++this.lastAckedSeq;
    const full: AgentMessage = { ...message, seq, timestamp: Date.now() };
    this.pendingMessages.set(seq, full);
    this.ws.send(JSON.stringify(full));
  }

  onReconnect(): void {
    // Re-send all unacknowledged messages in order
    const pending = [...this.pendingMessages.values()].sort((a, b) => a.seq - b.seq);
    for (const msg of pending) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  acknowledge(seq: number): void {
    // Clear all messages up to and including this seq
    for (const [key] of this.pendingMessages) {
      if (key <= seq) this.pendingMessages.delete(key);
    }
  }
}
```

### Heartbeat Implementation

SDKs for long-lived agent connections must implement heartbeats to detect silent disconnections:

```typescript
class HeartbeatManager {
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private heartbeatTimeout: NodeJS.Timeout | null = null;
  private readonly intervalMs = 30_000;
  private readonly timeoutMs = 10_000;

  start(send: () => void, onTimeout: () => void): void {
    this.heartbeatInterval = setInterval(() => {
      send();
      this.heartbeatTimeout = setTimeout(onTimeout, this.timeoutMs);
    }, this.intervalMs);
  }

  pong(): void {
    // Clear the timeout when a pong is received
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
  }

  stop(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
  }
}
```

---

## Middleware and Plugin Architecture

### The Language Model Middleware Pattern

The Vercel AI SDK's middleware system is the most mature example in the ecosystem. It follows the decorator pattern: a middleware wraps a model to produce a new model with enhanced behavior. Crucially, the wrapped model is a drop-in replacement for the original — it implements the same interface:

```typescript
interface LanguageModelMiddleware {
  transformParams?: (options: {
    params: LanguageModelCallOptions;
    type: 'generate' | 'stream';
  }) => Promise<LanguageModelCallOptions>;

  wrapGenerate?: (options: {
    doGenerate: () => Promise<GenerateResult>;
    params: LanguageModelCallOptions;
  }) => Promise<GenerateResult>;

  wrapStream?: (options: {
    doStream: () => Promise<StreamResult>;
    params: LanguageModelCallOptions;
  }) => Promise<StreamResult>;
}
```

This interface is minimal and focused. Three hook points cover the full request lifecycle without requiring middleware authors to understand the full model interface.

### RAG Middleware Example

The middleware pattern is particularly powerful for RAG (Retrieval-Augmented Generation) because it keeps retrieval logic out of application code:

```typescript
const ragMiddleware: LanguageModelMiddleware = {
  transformParams: async ({ params }) => {
    const userMessage = params.messages.findLast((m) => m.role === 'user');
    if (!userMessage) return params;

    const query = extractText(userMessage.content);
    const documents = await vectorStore.search(query, { topK: 5 });

    if (documents.length === 0) return params;

    const contextBlock = {
      type: 'text' as const,
      text: `Relevant context:\n\n${documents.map((d) => d.content).join('\n\n')}`,
    };

    return {
      ...params,
      messages: params.messages.map((message) =>
        message === userMessage
          ? { ...message, content: [contextBlock, ...(Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }])] }
          : message
      ),
    };
  },
};
```

### Caching Middleware

```typescript
const responseCache = new Map<string, GenerateResult>();

const cachingMiddleware: LanguageModelMiddleware = {
  wrapGenerate: async ({ doGenerate, params }) => {
    const cacheKey = JSON.stringify(params);

    if (responseCache.has(cacheKey)) {
      return responseCache.get(cacheKey)!;
    }

    const result = await doGenerate();
    responseCache.set(cacheKey, result);
    return result;
  },
};
```

---

## Pagination Patterns

Long-running agent platforms that accumulate data need ergonomic pagination. The async iterator pattern again:

```typescript
// Auto-paginating iterator (from the Fern/Stainless generated SDK pattern)
const page = await client.runs.list({ agentId: 'agent_123', limit: 50 });

// Option 1: iterate all pages automatically
for await (const run of page) {
  console.log(run.id, run.status);
  // SDK fetches subsequent pages transparently
}

// Option 2: manual page control
let current = page;
while (current.hasNextPage()) {
  current = await current.getNextPage();
  for (const run of current.data) {
    process(run);
  }
}

// Option 3: collect all items (memory-aware APIs only)
const allRuns = await page.allPages();
```

The `Page<T>` wrapper implementing `AsyncIterable<T>` is the cleanest pattern because it makes the common case (iterate everything) trivially simple, while still exposing manual page navigation for use cases with large datasets.

---

## Testing Patterns

### Bundled Mock Utilities

The best-in-class SDKs ship testing utilities alongside the main package. The `msw` (Mock Service Worker) pattern combined with Vitest has become the standard for testing SDK-consuming code:

```typescript
// Using msw for SDK testing
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

const server = setupServer(
  http.post('https://api.anthropic.com/v1/messages', () => {
    return HttpResponse.json({
      id: 'msg_test_123',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello! I am Claude.' }],
      model: 'claude-opus-4-6',
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 8 },
    });
  })
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

test('agent responds to greeting', async () => {
  const response = await myAgent.processMessage('Hello');
  expect(response.text).toContain('Hello');
});
```

### Testing Streaming Responses

```typescript
// Mock a streaming SSE response
server.use(
  http.post('https://api.anthropic.com/v1/messages', () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const events = [
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":", world!"}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ];
        for (const event of events) {
          controller.enqueue(encoder.encode(event));
        }
        controller.close();
      },
    });

    return new HttpResponse(stream, {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  })
);
```

### Vitest over Jest for New Projects

The 2025-2026 consensus is clear: Vitest for new TypeScript projects. Key advantages:

- Native ESM support without transpilation workarounds
- First-class TypeScript support
- `vi.mock()` with the same API surface as `jest.mock()`
- Browser mode for testing WebSocket code against actual browser APIs
- 2-5x faster than Jest on most TypeScript-heavy codebases

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
```

---

## Model Context Protocol (MCP) as Interoperability Layer

MCP has emerged as the key interoperability standard for the agent ecosystem. Its TypeScript SDK demonstrates several important patterns for agent platform SDK design:

### Transport Abstraction

MCP separates protocol logic from transport completely:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const server = new McpServer({ name: 'my-tools', version: '1.0.0' });

// Register tools once — transport-agnostic
server.tool('get_weather', { location: z.string() }, async ({ location }) => ({
  content: [{ type: 'text', text: `Weather in ${location}: 72°F, sunny` }],
}));

// Plug in any transport at runtime
if (process.env.TRANSPORT === 'http') {
  const transport = new StreamableHTTPServerTransport({ port: 3000 });
  await server.connect(transport);
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

This pattern — protocol logic in the server object, transport as a pluggable adapter — is excellent for agent platforms that need to support multiple connectivity modes (stdio for local tools, HTTP for remote services, WebSocket for real-time bidirectional communication).

### Client-Side MCP Integration

The Anthropic SDK's MCP helpers show how a platform SDK can integrate with external tool servers as a first-class pattern:

```typescript
import { mcpTools } from '@anthropic-ai/sdk/helpers/beta/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

const mcpClient = new Client({ name: 'claude-client', version: '1.0' });
await mcpClient.connect(transport);

const { tools } = await mcpClient.listTools();

const response = await client.beta.messages.toolRunner({
  model: 'claude-opus-4-6',
  max_tokens: 4096,
  messages: [{ role: 'user', content: userMessage }],
  tools: mcpTools(tools, mcpClient),  // adapter converts MCP tools to Anthropic format
});
```

---

## Developer Experience Practices

### Auto-Completion Through Type Exports

A well-designed SDK makes the full set of options discoverable through type annotations. Instead of requiring developers to read documentation to discover valid model names:

```typescript
// Weak: runtime error if typo
const model = 'claude-opus-4-6-typo';  // no IDE warning

// Strong: IDE autocomplete + compile error on typo
import type { Model } from '@anthropic-ai/sdk';
const model: Model = 'claude-opus-4-6';  // red underline if wrong
```

Export literal union types for every enumerable field. This also makes refactoring safe when model names or API versions change.

### Request ID Tracking

The OpenAI SDK adds `_request_id` to every response object from the `x-request-id` header. This small feature is invaluable for debugging in production:

```typescript
const response = await client.chat.completions.create({ /* ... */ });
logger.info('OpenAI call', {
  requestId: response._request_id,
  model: response.model,
  usage: response.usage,
});
// When something goes wrong, report this ID to the API provider
```

### Structured Logging Integration

Production SDKs should emit structured events that logging infrastructure can consume, not just string messages. Design your logging hooks to accept structured context objects:

```typescript
const client = new MyAgentPlatformClient({
  logger: {
    debug: (msg, ctx) => logger.debug(msg, ctx),  // ctx is typed
    info: (msg, ctx) => logger.info(msg, ctx),
    warn: (msg, ctx) => logger.warn(msg, ctx),
    error: (msg, ctx) => logger.error(msg, ctx),
  },
});
```

---

## Emerging Patterns: 2025-2026 Trends

### Effect-TS for Production-Grade Error Handling

While not yet mainstream in AI SDKs, Effect-TS adoption is growing among teams that need sophisticated error handling, dependency injection, and resource management. Its approach to typed errors is particularly relevant for agent platforms:

```typescript
import { Effect, Layer } from 'effect';

// Errors are typed, not thrown
const callModel = (prompt: string): Effect.Effect<Message, RateLimitError | AuthError | NetworkError> =>
  Effect.tryPromise({
    try: () => client.messages.create({ /* ... */ }),
    catch: (error) => categorizeError(error),  // maps to typed union
  });

// Compose with retry, timeout, fallback — all type-safe
const robustCall = callModel(prompt).pipe(
  Effect.retry({ times: 3, schedule: Schedule.exponential('1 second') }),
  Effect.timeout('30 seconds'),
  Effect.catchTag('RateLimitError', () => fallbackModel(prompt)),
);
```

### Generated SDKs Closing the Quality Gap

Tools like Fern, Speakeasy, and Stainless now generate TypeScript SDKs from OpenAPI specs that are nearly indistinguishable from handwritten ones. Key capabilities:

- Idiomatic async/await and `for await` patterns
- Proper `Page<T>` pagination wrappers
- Typed error hierarchies
- Automatic retry and timeout logic
- Zod-based response validation

The implication: for new platforms, starting with a generated SDK and customizing it is now more productive than writing from scratch, provided the generator handles the full feature set your API exposes.

### Provider Abstraction as Standard Expectation

The Vercel AI SDK's provider abstraction — one function call that works with OpenAI, Anthropic, Google, and 30+ other models — has set a new baseline expectation. Developers building on agent platforms increasingly expect to be able to swap the underlying model without changing application code.

```typescript
// This should just work regardless of provider
const { text } = await generateText({
  model: process.env.AI_MODEL === 'anthropic'
    ? anthropic('claude-opus-4-6')
    : openai('gpt-4o'),
  prompt: userMessage,
  tools: myTools,
});
```

Platform SDKs that lock users to a single model provider will face pressure. The clean design is to make the model an injectable dependency.

---

## Summary: Design Checklist

When building a TypeScript SDK for an AI agent platform, apply these patterns:

**Client Design**
- Configuration object constructor with sensible env-var defaults
- Resource-based API hierarchy matching URL structure
- Typed error hierarchy exported from the package root
- `maxRetries` and `timeout` configurable at both client and request level

**Type Safety**
- Export named types for all parameter objects and response shapes
- Use discriminated unions (with a `type` literal) for all variant responses
- Provide Zod schema helpers for tool/function definitions
- Infer TypeScript types from Zod schemas — one source of truth

**Streaming**
- Implement `AsyncIterable` for all streaming endpoints
- Provide high-level event-emitter helpers layered over raw iteration
- Expose `controller.abort()` for cancellation
- Handle `TransformStream` composition for middleware pipelines

**Agent Orchestration**
- Model agents as configuration objects (declarative, not imperative)
- Support handoffs for multi-agent routing
- Implement both deterministic (graph-based) and LLM-driven routing

**WebSocket / Real-Time**
- Exponential backoff with jitter for reconnection
- Heartbeat mechanism to detect silent disconnections
- Message sequence numbers for deduplication and resume

**Testing**
- Use Vitest for new projects
- Test HTTP interactions with `msw`
- Export testing utilities and mock factories from the package

**DX**
- Export literal union types for all enumerable fields
- Include `_request_id` on every response
- Provide structured logging hooks
- Generate and co-locate TypeDoc from source

---

Sources:
- [GitHub - anthropics/anthropic-sdk-typescript](https://github.com/anthropics/anthropic-sdk-typescript)
- [AI SDK by Vercel - Introduction](https://ai-sdk.dev/docs/introduction)
- [AI SDK 6 - Vercel Blog](https://vercel.com/blog/ai-sdk-6)
- [AI SDK Core: Language Model Middleware](https://ai-sdk.dev/docs/ai-sdk-core/middleware)
- [OpenAI Agents SDK for TypeScript](https://openai.github.io/openai-agents-js/)
- [GitHub - openai/openai-agents-js](https://github.com/openai/openai-agents-js)
- [GitHub - modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- [GitHub - mastra-ai/mastra](https://github.com/mastra-ai/mastra)
- [GitHub - langchain-ai/langchainjs](https://github.com/langchain-ai/langchainjs)
- [Introducing Agent Development Kit for TypeScript - Google Developers Blog](https://developers.googleblog.com/introducing-agent-development-kit-for-typescript-build-ai-agents-with-the-power-of-a-code-first-approach/)
- [Zod - TypeScript-first schema validation](https://github.com/colinhacks/zod)
- [9 Best Practices for Using Zod in 2025](https://javascript.plainenglish.io/9-best-practices-for-using-zod-in-2025-31ee7418062e)
- [Vitest vs Jest - Speakeasy](https://www.speakeasy.com/blog/vitest-vs-jest)
- [Best SDK generation tools 2025 - Fern](https://buildwithfern.com/post/best-sdk-generation-tools-multi-language-api)
- [Auto Pagination - Fern](https://buildwithfern.com/learn/sdks/capabilities/auto-pagination)
- [TypeScript and WebSockets: client-side engineering challenges - Ably](https://ably.com/topic/websockets-typescript)
- [GitHub - Effect-TS/effect](https://github.com/Effect-TS/effect)
- [Top 5 TypeScript AI Agent Frameworks for 2026](https://techwithibrahim.medium.com/top-5-typescript-ai-agent-frameworks-you-should-know-in-2026-5a2a0710f4a0)
