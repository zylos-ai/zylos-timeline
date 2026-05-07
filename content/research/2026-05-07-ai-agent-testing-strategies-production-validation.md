---
date: "2026-05-07"
title: "AI Agent Testing Strategies — From Unit Tests to Production Validation"
description: "Comprehensive testing pyramid for autonomous AI agents: deterministic unit tests, behavioral integration tests, chaos-driven recovery validation, and continuous production monitoring."
tags: ["agents", "testing", "quality", "production", "monitoring"]
---

## Executive Summary

The traditional testing pyramid — many fast unit tests at the base, fewer integration tests in the middle, a handful of slow end-to-end tests at the top — was designed for deterministic software. An agent isn't a function. It's a reasoning loop: it reads context, selects tools, executes actions, observes results, updates its model of the world, and decides what to do next. None of those steps produce a guaranteed output. Mocking the LLM returns a canned string; the real system might call three tools in an order your mock never anticipated.

This article maps the classical testing pyramid onto autonomous agent systems, layer by layer. It covers how to write fast, deterministic unit tests for agent components by isolating LLM calls behind test doubles; how integration tests must validate tool-call sequences and state transitions rather than string equality; and how end-to-end tests must measure behavioral outcomes — did the agent accomplish the goal? — rather than exact execution traces. Beyond the pyramid, it covers the disciplines that matter specifically for production agents: chaos engineering for recovery validation, canary deployments for prompt changes, and the 2025–2026 tooling landscape (DeepEval, Braintrust, Arize Phoenix, LangSmith, Promptfoo) that makes all of this tractable.

The Zylos Activity Monitor refactor (PR #545) illustrates what this looks like in practice: 33 integration scenarios, full-chain tests that inject failures into tmux panes, verify HealthEngine state detection, trigger Guardian restarts, and measure recovery time in seconds. That level of coverage is achievable — but it requires rethinking what "a test" means for an agent system.

---

## The Agent Testing Pyramid

The classical pyramid assumes every component has a deterministic interface. The agent pyramid must accommodate a fundamentally different reality: some components are probabilistic, most components interact through state (not function calls), and the "correct" behavior of the whole system cannot be inferred by testing parts in isolation.

```
              ┌─────────────────────────┐
              │   Production Monitors   │  ← Synthetic probes, canary deployments
              └─────────────────────────┘
            ┌───────────────────────────────┐
            │     End-to-End / Behavioral   │  ← Did the agent achieve the goal?
            └───────────────────────────────┘
          ┌─────────────────────────────────────┐
          │         Integration Tests           │  ← Tool-call sequences, state transitions
          └─────────────────────────────────────┘
        ┌───────────────────────────────────────────┐
        │              Component Tests              │  ← Parsers, routers, tool wrappers
        └───────────────────────────────────────────┘
      ┌───────────────────────────────────────────────┐
      │       Unit Tests (LLM-Free / Mocked)          │  ← Pure logic, prompt builders, formatters
      └───────────────────────────────────────────────┘
```

The key principle: **push LLM dependency as high as possible**. Most agent logic — routing decisions, context formatting, tool output parsing, error classification — can be tested without a real LLM if the boundaries are designed correctly.

---

## Layer 1: Unit Tests — LLM-Free and Mocked Components

### What belongs at this layer

Unit tests cover all logic that does not require an actual language model response:

- **Prompt builders**: given a user message + memory context, does the rendered prompt contain the right fields in the right structure?
- **Response parsers**: given a raw LLM string, does the parser correctly extract tool calls, JSON payloads, or structured fields?
- **Context window managers**: does the trimming/summarization logic preserve the right tokens when context exceeds the limit?
- **Tool wrappers**: does the filesystem tool correctly sandbox paths, does the HTTP tool correctly set timeouts?
- **Routing logic**: given a detected intent, does the dispatcher select the right sub-agent?

All of this is deterministic. None of it requires a real LLM call. These tests should run in milliseconds, require no network, and have no external dependencies.

### Mocking LLM APIs

For the thin layer of code that does interact with the LLM, use test doubles. The five classical forms all apply:

- **Stub**: returns a hardcoded string for any input. Use this to test parsing code that wraps LLM output.
- **Fake**: a lightweight in-process LLM that returns canned responses keyed by input hash. Faster than a stub but supports multiple scenarios.
- **Spy**: wraps a real (or stub) LLM and records what was sent, so you can assert on the prompts your code constructs.
- **Mock**: asserts on specific call patterns ("the LLM should be called exactly once with a system prompt containing the word 'JSON'").
- **Record/replay fixture**: captures real API responses once and replays them on subsequent runs (see vcrpy below).

In Python with `unittest.mock`:

```python
from unittest.mock import patch, MagicMock

def test_agent_calls_search_tool_on_question():
    mock_response = MagicMock()
    mock_response.content = '[{"type": "tool_use", "name": "web_search", "input": {"query": "weather today"}}]'
    
    with patch("myagent.llm_client.messages.create", return_value=mock_response):
        result = agent.run("What is the weather today?")
    
    assert result.tool_calls[0].name == "web_search"
    assert "weather" in result.tool_calls[0].input["query"]
```

In TypeScript with Jest:

```typescript
jest.mock("@anthropic-ai/sdk", () => ({
  Anthropic: jest.fn().mockImplementation(() => ({
    messages: {
      create: jest.fn().mockResolvedValue({
        content: [{ type: "tool_use", name: "read_file", input: { path: "/tmp/test.txt" } }]
      })
    }
  }))
}));
```

### VCR-style cassette recording for LLM calls

The `vcrpy` library was designed for HTTP API testing: it records real HTTP interactions on the first run and replays them on subsequent runs, making tests fast, free, and deterministic. The same pattern applies directly to LLM API calls, since those are HTTP requests under the hood.

```python
import vcr

@vcr.use_cassette("fixtures/cassettes/health_check_query.yaml")
def test_health_query_routes_to_guardian():
    response = agent.query("What is the current system health?")
    assert response.routed_to == "guardian"
    assert response.confidence > 0.8
```

The cassette file stores the full request and response. If your prompt changes in a way that would alter the API request, the cassette comparison fails — which is a useful regression signal, not just a bug. The `vcr-langchain` library extends this pattern to LangChain-based agents. For teams using OpenAI-compatible endpoints, `pytest-recording` provides a decorator-based interface compatible with pytest fixtures.

The trade-off: cassettes become stale when the model, the API schema, or the prompt structure changes. Treat cassette updates as a deliberate step requiring review — not an automated fix.

---

## Layer 2: Component Integration Tests — Tool Use and Workflow Validation

### What belongs here

Integration tests verify that multiple components work together correctly. For agents, the critical integration points are:

- **Tool call → tool execution → result parsing**: does the agent correctly parse its own tool call, execute the tool, and incorporate the result into the next reasoning step?
- **State transitions**: does the agent's internal state machine (if any) transition correctly under different tool outcomes?
- **Memory read/write**: does retrieved context actually influence the agent's next decision?
- **Error handling paths**: when a tool returns an error, does the agent attempt a retry, fall back, or escalate?

At this layer, the LLM is still mocked — but the tools are real (or lightly faked). You're testing the plumbing, not the reasoning.

### Testing tool-call sequences

The most common pattern is to provide a sequence of LLM responses (one per reasoning step) and verify the sequence of tool calls that result:

```python
# Provide scripted LLM responses for each reasoning step
llm_responses = [
    '{"tool": "list_files", "args": {"path": "/data"}}',
    '{"tool": "read_file", "args": {"path": "/data/report.csv"}}',
    '{"response": "Found 42 records in the dataset."}'
]

with mock_llm_sequence(llm_responses):
    result = agent.run("Summarize the data directory")

assert executed_tools == ["list_files", "read_file"]
assert "42 records" in result.final_answer
```

This pattern is supported natively by LangSmith's trajectory evaluation framework, which records the full sequence of tool calls and reasoning steps for post-hoc analysis.

### The 33-scenario integration suite pattern

The Zylos Activity Monitor refactor (PR #545) established a model for comprehensive integration coverage: enumerate every meaningful state transition the agent can experience, then write one test per scenario. For a health monitoring agent, that might look like:

```
Scenario 01: Service starts healthy → health check passes → no action
Scenario 02: Service CPU spikes → threshold crossed → alert fired
Scenario 03: Service becomes unresponsive → watchdog detects → restart triggered
Scenario 04: Restart succeeds in <30s → recovery recorded → alert cleared
Scenario 05: Restart fails → retry with backoff → escalate after N attempts
Scenario 06: False positive suppression → transient spike ignored below window
...
Scenario 33: Full chain — tmux pane inject → HealthEngine detection → Guardian restart → recovery measured
```

Each scenario tests a specific path through the agent's decision tree. The full-chain test at the end (Scenario 33 in the example, recovering in 14 seconds) validates that all the individually-tested components compose correctly under real conditions.

---

## Layer 3: Behavioral End-to-End Tests — Did the Agent Succeed?

### Outcome assertions, not trace assertions

End-to-end tests for agents must answer: did the agent accomplish the goal? They should not assert on how the agent got there — the exact sequence of tool calls, the specific phrasing of intermediate reasoning, or the number of LLM turns consumed. Those are implementation details. A better agent might accomplish the same goal in fewer steps, using different tools, with different phrasing.

This distinction is critical. Teams that write E2E tests asserting on execution traces create tests that break every time the agent improves.

**Wrong:** `assert trace[2].tool_name == "web_search"` (brittle, breaks on refactors)

**Right:** `assert "Paris" in result.final_answer` (outcome-focused)

**Better:** `assert eval_answer_relevance(question, result.final_answer) > 0.85` (semantic)

### Non-deterministic output testing

For outputs that legitimately vary run-to-run, three complementary strategies work:

**1. Structural assertions**: assert on the schema of the output, not its content.

```python
import jsonschema

schema = {
    "type": "object",
    "required": ["status", "action_taken", "confidence"],
    "properties": {
        "status": {"type": "string", "enum": ["healthy", "degraded", "critical"]},
        "action_taken": {"type": "string"},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1}
    }
}

result = agent.assess_system_health(metrics)
jsonschema.validate(result, schema)  # Never fails due to phrasing variation
```

**2. Semantic similarity assertions**: verify the output captures the right meaning, not the right words.

```python
from sentence_transformers import SentenceTransformer, util

model = SentenceTransformer("all-MiniLM-L6-v2")

def assert_semantically_similar(actual: str, expected: str, threshold: float = 0.80):
    emb_actual = model.encode(actual, convert_to_tensor=True)
    emb_expected = model.encode(expected, convert_to_tensor=True)
    similarity = util.cos_sim(emb_actual, emb_expected).item()
    assert similarity >= threshold, f"Semantic similarity {similarity:.2f} below threshold {threshold}"

assert_semantically_similar(
    actual=agent.summarize("The CPU is at 95% for 5 minutes"),
    expected="CPU is critically overloaded and requires immediate action"
)
```

**3. LLM-as-judge assertions**: use a second LLM call to evaluate the output, removing exact-match constraints entirely.

```python
def llm_judge(question: str, answer: str, criteria: str) -> float:
    """Returns a 0-1 score for how well the answer meets the criteria."""
    prompt = f"""
    Question: {question}
    Answer: {answer}
    Criteria: {criteria}
    
    Rate how well the answer meets the criteria on a scale of 0-10.
    Return only the number.
    """
    score = int(call_llm(prompt).strip())
    return score / 10.0

score = llm_judge(
    question="What should I do about high CPU?",
    answer=agent.respond("CPU is at 95%"),
    criteria="The answer identifies the problem and suggests at least one actionable remediation step"
)
assert score >= 0.7
```

This pattern is the foundation of frameworks like DeepEval and Ragas, which wrap LLM-as-judge into reusable metric classes (faithfulness, answer relevancy, hallucination detection).

### The Aggregated Oracle pattern

Because LLM outputs vary, a single run is insufficient to establish correctness. The Aggregated Oracle runs the same test case N times and asserts on the distribution:

```python
def run_repeated(agent_fn, input, n=5):
    results = [agent_fn(input) for _ in range(n)]
    return results

results = run_repeated(agent.classify_severity, "CPU at 95% for 10 min", n=10)
critical_count = sum(1 for r in results if r.severity == "critical")
assert critical_count >= 8, f"Expected critical ≥8/10 runs, got {critical_count}/10"
```

This catches agents that are "mostly right" but fail unpredictably under load — a problem invisible to single-run tests.

---

## Layer 4: Health and Recovery Testing — Chaos Engineering for Agents

### Why agents need chaos testing

Traditional chaos engineering injects infrastructure failures: kill a pod, partition a network, corrupt a disk. Agent systems need an additional category: **cognitive chaos** — failures in the agent's reasoning environment.

The failure modes unique to agent systems include:

- **LLM API errors**: 429 rate limits, 503 service unavailability, timeout, malformed JSON in the response
- **Tool execution failures**: file not found, permission denied, network timeout during tool call
- **Context corruption**: memory retrieval returns stale or incorrect data
- **Reasoning loops**: the agent gets stuck in a cycle and never terminates
- **Auth failures**: API key expiry, token rotation mid-session
- **Model degradation**: the model responds correctly but slowly enough to trigger downstream timeouts

### Fault injection patterns

A fault injector for agent systems intercepts at the LLM call boundary and at the tool execution boundary:

```python
class FaultInjector:
    def __init__(self, llm_client, fault_config):
        self.client = llm_client
        self.config = fault_config
        self.call_count = 0

    def create(self, *args, **kwargs):
        self.call_count += 1
        fault = self.config.get(self.call_count)
        if fault == "rate_limit":
            raise RateLimitError("429 Too Many Requests")
        elif fault == "timeout":
            time.sleep(30)  # Force timeout
        elif fault == "malformed_json":
            return MockResponse('{"broken": json here}')
        return self.client.create(*args, **kwargs)

# Test: agent recovers from rate limit on call #2
injector = FaultInjector(real_client, {2: "rate_limit"})
with patch("agent.llm_client", injector):
    result = agent.run("Analyze system health")
    assert result.status == "completed"  # Should recover and retry
    assert injector.call_count > 2  # Confirmed it retried
```

### Measuring recovery time

For self-healing agents, recovery time is the primary quality metric. The test should capture it explicitly:

```python
import time

def test_guardian_recovery_within_sla():
    """Agent must restart a failed service and confirm health within 30 seconds."""
    start = time.monotonic()
    
    # Inject: kill the monitored service
    kill_service("activity-monitor")
    
    # Wait for agent to detect, restart, and confirm recovery
    wait_until(lambda: service_is_healthy("activity-monitor"), timeout=30)
    
    elapsed = time.monotonic() - start
    assert elapsed < 30, f"Recovery took {elapsed:.1f}s, SLA is 30s"
```

The Zylos PR #545 integration tests achieved a 14-second recovery time for the full chain: tmux pane inject → HealthEngine state detection → Guardian restart → health confirmation. This kind of measured SLA test is more valuable than a binary pass/fail — it gives you a performance regression signal as the system evolves.

### AI-driven chaos in 2025–2026

Recent research shows AI-driven chaos engineering achieves a 28% improvement in fault detection accuracy and 35% reduction in recovery time compared to static fault injection schedules. The key advance is dynamic fault injection: the chaos agent observes system state and injects faults at the moments most likely to reveal real failure modes — not on a fixed schedule, but guided by learned vulnerability patterns.

Tools like the `chaosync-org/awesome-ai-agent-testing` collection catalog these patterns and provide reference implementations for common agent failure scenarios.

---

## Layer 5: Continuous Production Validation

### Canary deployments for agent changes

Agent deployments are not like binary deployments. There are three distinct types of change, each requiring a different rollout strategy:

| Change Type | Risk Level | Rollout Strategy |
|-------------|------------|------------------|
| Tool implementation | Low–Medium | Standard canary (5% → 25% → 100%) |
| Prompt modification | Medium–High | Shadow + canary with eval gates |
| Model version upgrade | High | Shadow mode first, then staged traffic |
| Agent architecture change | Very High | Side-by-side A/B with human review gate |

**Prompt changes must be treated as deployments**, not configuration changes. A prompt modification can change agent behavior as dramatically as a code change — more so, often, since reasoning is harder to predict than logic.

The recommended flow for prompt canary deployment:

```
1. Shadow mode (0% production traffic, 100% shadow)
   └─ Run candidate prompt on all requests
   └─ Compare outputs against current prompt using eval metrics
   └─ No user sees candidate output
   
2. Canary gate (require eval metrics above threshold to proceed)
   └─ answer_relevance ≥ 0.85
   └─ hallucination_rate ≤ 0.05
   └─ tool_error_rate ≤ 0.02
   
3. Staged rollout (5% → 25% → 100%)
   └─ Monitor latency, cost, task completion rate
   └─ Auto-rollback on regression
```

### Shadow mode testing

Shadow mode runs the new agent version on real production traffic without users seeing its responses. The shadow agent's outputs are evaluated offline:

```python
class ShadowAgent:
    def __init__(self, production_agent, candidate_agent, evaluator):
        self.prod = production_agent
        self.candidate = candidate_agent
        self.evaluator = evaluator

    def handle(self, request):
        prod_response = self.prod.handle(request)
        
        # Fire-and-forget shadow call
        threading.Thread(
            target=self._shadow_eval,
            args=(request, prod_response)
        ).start()
        
        return prod_response  # User only sees production response

    def _shadow_eval(self, request, prod_response):
        candidate_response = self.candidate.handle(request)
        score = self.evaluator.compare(prod_response, candidate_response)
        metrics.record("shadow_comparison", score)
```

A recent tianpan.co article on LLM gradual rollout describes replaying last week's production traffic through candidate models and using a judge LLM to compare outputs against current-model responses — a powerful offline evaluation that requires no live user exposure.

### Synthetic probe agents

Production smoke tests for agent systems take the form of synthetic probes: scripted users that send known requests and assert on response properties. Unlike traditional health checks that ping an endpoint, synthetic probes exercise the full agent reasoning path:

```python
class SyntheticProbe:
    """Runs every 5 minutes to validate agent end-to-end functionality."""
    
    PROBE_SCENARIOS = [
        {
            "input": "What is the current system health?",
            "assert": lambda r: r.contains_health_status(),
            "sla_seconds": 5
        },
        {
            "input": "List the last 3 alerts",
            "assert": lambda r: r.is_list_with_length(3),
            "sla_seconds": 8
        },
        {
            "input": "Run diagnostics on the activity monitor",
            "assert": lambda r: r.tool_called("run_diagnostics"),
            "sla_seconds": 15
        }
    ]
    
    def run(self):
        for scenario in self.PROBE_SCENARIOS:
            start = time.monotonic()
            result = agent.handle(scenario["input"])
            elapsed = time.monotonic() - start
            
            assert scenario["assert"](result), f"Probe failed: {scenario['input']}"
            assert elapsed < scenario["sla_seconds"], f"Probe SLA breach: {elapsed:.1f}s"
```

---

## The 2025–2026 Tooling Landscape

### Framework overview

The agent testing ecosystem matured significantly between 2025 and 2026. Key frameworks:

**DeepEval (Confident AI)**: The pytest-native evaluation framework with 50+ built-in metrics. Integrates directly into existing pytest suites — `assert_test(result, [AnswerRelevancyMetric(threshold=0.8)])`. Supports LLM-as-judge, semantic similarity, hallucination detection, and custom metrics. Best choice for teams that want broad metric coverage with minimal setup.

**Braintrust**: Full eval lifecycle management — dataset versioning, CI/CD gates, production monitoring, and automated prompt optimization on a single platform. The strongest competitor to DeepEval for teams that need evaluation to gate CI/CD pipelines. OpenAI acquired Promptfoo for $86M in March 2026, signaling the commercial value of evaluation tooling.

**Arize Phoenix**: The only major platform built entirely on OpenTelemetry with no proprietary tracing layer. Fully self-hostable. Ideal for teams requiring vendor-neutral instrumentation and data sovereignty. Integrates with any agent framework that supports OTel spans.

**LangSmith**: Deep integration with LangChain/LangGraph. Captures full trajectory of tool calls, reasoning steps, and intermediate decisions. Native support for trajectory evaluation — scoring intermediate decisions, not just final outputs. CI/CD integration via pytest and GitHub Actions.

**Promptfoo** (pre-acquisition): CLI-first, configuration-driven evaluation and red-teaming. YAML-defined test cases, native GitHub Actions integration, and security-focused adversarial testing. Widely adopted for systematic prompt regression testing.

**Ragas**: The standard for RAG-specific evaluation. Metrics include context precision, context recall, faithfulness, and answer relevance — without requiring ground-truth labels. Pairs well with DeepEval or LangSmith for the RAG layer of hybrid agent systems.

**AgentOps**: Production monitoring and cost tracking for agent deployments. Records session replays, tool call sequences, token usage, and latency per agent step. Less focused on offline evaluation, more focused on production observability.

### CI/CD integration pattern

A well-structured agent CI/CD pipeline looks like this:

```yaml
# .github/workflows/agent-eval.yml
name: Agent Evaluation

on: [pull_request]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - run: pytest tests/unit/ --no-real-llm  # Fast, mocked, <2min

  integration-tests:
    runs-on: ubuntu-latest
    needs: unit-tests
    steps:
      - run: pytest tests/integration/ --vcr-record=none  # Cassette replay, <5min

  eval-gate:
    runs-on: ubuntu-latest
    needs: integration-tests
    steps:
      - run: |
          deepeval test run tests/evals/ \
            --min-success-rate 0.90 \
            --model gpt-4o-mini  # Cheap judge model
      # Blocks merge if eval pass rate < 90%

  shadow-deploy:
    if: github.ref == 'refs/heads/main'
    needs: eval-gate
    steps:
      - run: deploy-shadow.sh  # Route 0% traffic, 100% shadow
      - run: wait-shadow-eval.sh --min-hours 1 --threshold 0.85
      - run: promote-canary.sh --percent 5
```

---

## Testing Multi-Agent Systems

### Why single-agent tests are insufficient

The MAEBE (Multi-Agent Emergent Behavior Framework) research finding from 2025 is unambiguous: single agent performance does not reliably predict multi-agent system behavior. Phenomena like peer pressure (agents changing their answers when they perceive group consensus), role diffusion (agents adopting behaviors that weren't specified in their system prompt), and coordination failures (agents talking past each other and both attempting the same action) are only visible in ensemble testing.

### Isolation vs. ensemble testing strategy

The recommended approach is a two-phase strategy:

**Phase 1 — Isolation tests**: Test each agent independently with mock implementations of the other agents it communicates with. This localizes failures and makes debugging tractable.

```python
# Test the Orchestrator agent in isolation
# Mock the Worker agents it delegates to
mock_worker = MockAgent(responses=["Task completed: wrote 42 lines"])
orchestrator = OrchestratorAgent(workers={"coder": mock_worker})

result = orchestrator.delegate("Write a sorting function")
assert mock_worker.received_task is not None
assert "sorting" in mock_worker.received_task.description
```

**Phase 2 — Ensemble tests**: Test the actual multi-agent composition. Focus on:

- **Message routing correctness**: does each message arrive at the right agent?
- **State consistency**: when two agents modify shared state, does the result converge correctly?
- **Coordination protocols**: does the system handle concurrent tool calls without conflict?
- **Emergent failure modes**: does a degraded Agent A cause cascading failures in Agents B and C?

```python
def test_multi_agent_health_chain():
    """Full ensemble: Monitor detects issue → Orchestrator coordinates → Worker fixes → Monitor confirms."""
    system = MultiAgentSystem([monitor, orchestrator, worker])
    
    # Inject: service failure
    inject_failure("database", "connection_refused")
    
    # Assert: chain completes correctly
    wait_until(lambda: system.get_state() == "recovered", timeout=60)
    
    # Assert: each agent played the right role
    assert monitor.alerts_fired == 1
    assert orchestrator.tasks_delegated == 1
    assert worker.actions_taken == ["restart_database", "verify_connection"]
    assert monitor.all_clear_sent == True
```

### Testing multi-agent security

Multi-agent systems introduce attack surfaces invisible in single-agent deployments. The 2025 paper "Open Challenges in Multi-Agent Security" identifies steganographic communication (agents establishing covert channels through tool outputs) and coordinated prompt injection (malicious content in one agent's context corrupting another's reasoning) as real threats that only emerge in ensemble testing.

Security-focused ensemble tests should include:

- Injecting adversarial content into one agent's tool results and verifying it does not propagate to other agents' reasoning
- Testing that agents cannot exfiltrate data through timing side-channels or encoded output formats
- Verifying that role boundaries hold under adversarial prompting

---

## Practical Implementation Roadmap

For a team building a production agent system today, the order of implementation matters:

**Week 1: Foundation**
- Set up pytest with a mock LLM fixture (`conftest.py` with a `mock_llm` fixture that returns configurable responses)
- Write unit tests for all non-LLM components (parsers, formatters, routers)
- Configure vcrpy for any tests that need real LLM responses to be recorded once

**Week 2: Integration coverage**
- Map every meaningful state transition in the agent (the "33 scenarios" exercise)
- Write one integration test per transition using scripted LLM response sequences
- Add structural assertions (JSON schema validation) for all structured agent outputs

**Week 3: Behavioral evals**
- Set up DeepEval or Braintrust with a small golden dataset (20–50 representative inputs)
- Configure at least three metrics: answer relevancy, hallucination rate, task completion
- Connect eval run to CI/CD as a non-blocking gate initially (measure, don't block)

**Week 4: Production validation**
- Deploy synthetic probes for top 3–5 critical user journeys
- Implement shadow mode for next major change (model upgrade or prompt refactor)
- Set eval gate thresholds based on Week 3 baseline measurements
- Add chaos fault injection for the most critical recovery paths

The most important shift is cultural: **treat prompt changes as deployments, evaluate continuously, and measure recovery time as a first-class metric**. The testing pyramid provides the structure; the tools above provide the infrastructure. The discipline of shipping with confidence in a non-deterministic system comes from both.

---

*Sources: [Agentic Evals Pyramid — rwilinski.ai](https://rwilinski.ai/posts/evals-pyramid/) · [Anthropic: Demystifying Evals for AI Agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) · [LangSmith Trajectory Evaluations](https://docs.langchain.com/langsmith/trajectory-evals) · [Langfuse: Testing LLM Applications](https://langfuse.com/blog/2025-10-21-testing-llm-applications) · [Confident AI: AI Agent Evaluation Guide](https://www.confident-ai.com/blog/definitive-ai-agent-evaluation-guide) · [DEV Community: Non-Deterministic Software Testing](https://dev.to/aws/beyond-traditional-testing-addressing-the-challenges-of-non-deterministic-software-583a) · [MAEBE Framework — arXiv](https://arxiv.org/pdf/2506.03053) · [AI-Driven Fault Injection Testing — journalajrcos.com](https://journalajrcos.com/index.php/AJRCOS/article/view/675) · [TianPan.co: LLM Gradual Rollout](https://tianpan.co/blog/2026-04-09-llm-gradual-rollout-shadow-canary-ab-testing) · [Braintrust: DeepEval Alternatives 2026](https://www.braintrust.dev/articles/deepeval-alternatives-2026) · [Arize Phoenix](https://www.goodeyelabs.com/articles/top-ai-agent-evaluation-tools-2026) · [VCR-LangChain](https://github.com/amosjyng/vcr-langchain) · [Eliminating Flaky Tests with VCR for LLMs](https://anaynayak.medium.com/eliminating-flaky-tests-using-vcr-tests-for-llms-a3feabf90bc5) · [Open Challenges in Multi-Agent Security — arXiv](https://arxiv.org/html/2505.02077v1) · [Chaosync Awesome AI Agent Testing](https://github.com/chaosync-org/awesome-ai-agent-testing) · [MarkTechPost: Safe ML Deployment Strategies](https://www.marktechpost.com/2026/03/21/safely-deploying-ml-models-to-production-four-controlled-strategies-a-b-canary-interleaved-shadow-testing/)*
