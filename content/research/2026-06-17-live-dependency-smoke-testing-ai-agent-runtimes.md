---
date: "2026-06-17"
title: "Live-Dependency Smoke Tests for AI Agent Runtimes: Engineering the Thin Layer That Fakes Cannot Replace"
description: "A technical guide to designing the opt-in, credential-gated integration test layer that sits above hermetic unit tests—covering skip-not-fail patterns, network egress diagnostics, secret injection, flakiness management, and bidirectional state coverage for AI agent runtimes."
tags: [testing, ci-cd, integration-testing, ai-agents, secrets-management, hermetic-testing, smoke-testing]
---

## Executive Summary

Most of an AI agent runtime's test suite should be hermetic: isolated, fast, fake-dependency-driven, and runnable without credentials or network access. This principle—enshrined in Google's test size taxonomy and its 70/20/10 unit/integration/E2E guidance—exists because hermetic tests are deterministic, cheap to run, and safe to execute in untrusted contexts such as fork pull requests. But hermetic tests have a blind spot: they can only be as accurate as the assumptions baked into the fakes. When your agent runtime invokes a real CLI binary, exchanges tokens with a live OAuth provider, or routes egress through a corporate proxy, no mock can fully replicate what happens in production.

The solution is a thin, deliberately opt-in layer of live-dependency smoke tests: a small set of tests that exercise the real external dependency, gated behind credential presence checks, excluded from blocking PR gates, and designed to skip gracefully—never fail—when the runtime environment lacks the required credentials. This article covers the engineering discipline around building and maintaining that layer for AI agent runtimes: the placement rationale, the skip-not-fail pattern, network egress diagnosis inside containers, secret injection without leaking, flakiness management, and bidirectional state-transition coverage.

---

## The Hermetic Baseline and Why It Is Not Enough

Google's 2010 "Test Sizes" post on the Testing Blog formalized what many teams had discovered empirically: the most important properties you want from a test suite are speed and determinism, and the fastest path to both is restricting what a test is allowed to touch. Small tests (their terminology for what others call unit tests) run entirely in-process, access no filesystem outside a hermetic in-memory implementation, make no network calls, and spawn no subprocesses. Medium tests relax some of these constraints. Large tests (end-to-end, integration) touch real networks and real services.

The 2012 "Hermetic Servers" post pushed this further into server testing: rather than pointing services at live backends during tests, you inject all downstream connections at runtime via dependency injection, so a test environment spins up a fully functional server wired entirely to in-process fakes. The 2015 "Just Say No to More End-to-End Tests" post made the cost of the opposite approach explicit: end-to-end tests are slow, flaky, expensive to debug, and tend to collapse under the weight of their own complexity.

For AI agent runtimes, the hermetic baseline maps naturally:

- **Fake CLI binaries via PATH prepending.** If your runtime shells out to `git`, `docker`, or a proprietary SDK CLI, your hermetic test suite should prepend a directory of shell-script fakes to `PATH`. The fake captures the call, validates arguments, and returns a canned response. The agent logic under test never knows the difference.
- **In-process mocks for LLM providers.** API calls to Claude, GPT-4, or any other model provider should be intercepted by a lightweight mock server or a recorded response fixture—never a live network call in a small/medium test.
- **Fixture auth tokens.** Anything that looks like a credential should be a static fixture string that your code accepts without validation.

This approach covers the vast majority of defect classes: logic bugs, prompt format errors, JSON parsing failures, tool dispatch mistakes, state machine transitions. The hermetic suite runs in seconds, produces no false positives from rate limits or network hiccups, and runs safely on every commit including fork pull requests.

But it cannot cover what is genuinely external:

- Whether the real CLI binary accepts the flags your agent constructs
- Whether the live OAuth flow produces a token your SDK can parse
- Whether a specific model's API responds to your tool-call schema as expected
- Whether egress from your container is actually allowed through your proxy configuration

These gaps are exactly what live-dependency smoke tests fill.

---

## Test Pyramid Placement: Where Live Smoke Tests Live

The classical test pyramid puts unit tests at the base (fast, numerous, cheap), integration tests in the middle, and end-to-end tests at the apex (slow, few, expensive). Live-dependency smoke tests occupy a specific cell in the integration tier: they are not full end-to-end flows, but they do cross the real network or real auth boundary for a narrow, targeted assertion.

A well-designed live smoke test for an AI agent runtime has these characteristics:

- **Narrow scope.** It asserts one integration point—not a full agent workflow. "Can the runtime authenticate to provider X and receive a valid token?" not "Does the agent complete a full five-step task using provider X?"
- **Real dependency.** It uses the actual binary, actual network, actual credentials—not shims.
- **Fast and focused.** It should complete in under 30 seconds. If the real dependency call is inherently slow, the test is probably too broad.
- **Guarded by a presence check.** If the required credential is absent, the test skips. If the network is blocked, the test reports a diagnostic skip, not a failure.
- **Out of the blocking gate.** It runs on a schedule or as an opt-in trigger, not on every PR commit.

This placement reflects a principle from BrowserStack's testing pyramid guidance: integration tests against real dependencies exist to verify that your code and the external system agree on the contract—something no amount of unit-level mocking can prove.

---

## The Skip-Not-Fail Pattern: Why Exit 0 When Credentials Are Absent

The most important engineering decision in live smoke testing is what happens when the test runner encounters a missing credential. The answer must always be: **skip with a clear reason, exit 0, never fail**.

### Why This Matters

CI pipelines gate pull requests on test suite exit codes. If a live-smoke test fails because `OPENAI_API_KEY` is not set, every PR from a contributor who doesn't have that key will be blocked. Worse, fork pull requests in GitHub Actions are intentionally denied access to repository secrets—this is a deliberate security measure. As documented in GitHub's Actions security guidance, workflows triggered by `pull_request` events from forks receive a read-only `GITHUB_TOKEN` and no repository secrets at all, to prevent a malicious PR from printing your `MY_SECRET` to the job log and exfiltrating it.

If your live smoke tests do not implement skip-not-fail, you have exactly two bad options: exclude external contributors entirely, or expose credentials to fork workflows via `pull_request_target` (which carries serious security risks). Skip-not-fail sidesteps the problem entirely.

### Implementation in pytest

```python
import os
import pytest

# Declare credential requirements at the top of the test module
REQUIRE_ANTHROPIC_KEY = pytest.mark.skipif(
    not os.getenv("ANTHROPIC_API_KEY"),
    reason="ANTHROPIC_API_KEY not set — live smoke tests skipped"
)

REQUIRE_GITHUB_TOKEN = pytest.mark.skipif(
    not os.getenv("GITHUB_TOKEN"),
    reason="GITHUB_TOKEN not set — GitHub integration tests skipped"
)

@REQUIRE_ANTHROPIC_KEY
def test_live_model_api_reachable():
    """Smoke: can we get a minimal completion from the real API?"""
    import anthropic
    client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from env
    response = client.messages.create(
        model="claude-opus-4-5",
        max_tokens=10,
        messages=[{"role": "user", "content": "ping"}]
    )
    assert response.content is not None
```

The `skipif` condition evaluates at collection time. If the environment variable is absent, pytest marks the test as skipped, reports it with the reason string, and exits 0. The skip is visible in the test report—it's not silently omitted—so developers can see that live tests were bypassed and understand why.

### Per-Test vs. Suite-Level Gating

For suites with many live tests, a conftest-level fixture or module-level skip is cleaner than decorating every test:

```python
# conftest.py
import os
import pytest

def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "live: mark test as requiring real credentials and network"
    )

def pytest_collection_modifyitems(config, items):
    if not os.getenv("RUN_LIVE_TESTS"):
        skip_live = pytest.mark.skip(reason="RUN_LIVE_TESTS not set")
        for item in items:
            if "live" in item.keywords:
                item.add_marker(skip_live)
```

This pattern uses a single environment variable flag (`RUN_LIVE_TESTS=1`) to opt the entire suite in, rather than requiring every credential to be present. You can then layer specific credential checks inside tests that need them.

### Go and Other Runtimes

The same pattern applies in Go via `t.Skip()`:

```go
func TestLiveAPIReachable(t *testing.T) {
    key := os.Getenv("ANTHROPIC_API_KEY")
    if key == "" {
        t.Skip("ANTHROPIC_API_KEY not set — skipping live test")
    }
    // ... real API call
}
```

In both cases, the test runner's exit code remains 0 for a skipped test, preserving CI health.

---

## Secret Injection Without Leaking

Live smoke tests require real credentials at runtime. Doing this safely is not trivial.

### The Three Injection Surfaces

**Environment variables** are the most portable mechanism. CI systems (GitHub Actions, GitLab CI, CircleCI) all support repository-level secret stores that inject values as environment variables at job start. The risk: verbose test output, error messages, or CLI subprocesses may print environment variables to logs. GitHub Actions automatically masks secret values if they appear verbatim in log output, but masking has limits—it doesn't protect against base64-encoded variants or values printed character-by-character.

**Credential files on disk** are required by some tools that refuse to read credentials from environment variables—certain auth SDKs and CLI tools look for a credentials file at a hardcoded path (`~/.config/gcloud/application_default_credentials.json`, `~/.aws/credentials`, etc.). In CI, these files should be written from a secret in a pre-test setup step and deleted in a post-test teardown step (even on failure, via `finally` blocks or CI job cleanup hooks). These files must be gitignored and should never be committed—a `.gitignore` entry for `*.credential.json`, `*.pem`, `.env.live`, and similar patterns is essential.

**Secrets managers at runtime** (HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager) represent the most robust approach for production CI: credentials are never stored in the CI system's secret store at all; instead, the job authenticates to the secrets manager (via OIDC workload identity, for example) and fetches the credential just-in-time. This eliminates long-lived credential exposure in the CI environment entirely.

### The gitignore Seed Pattern

For local development, a common pattern is a gitignored seed file:

```
# .gitignore
.env.live
tests/fixtures/live-credentials.json
*.service-account.json
```

Developers who want to run live tests locally populate this file from a team password manager or their own credentials. The file is never committed. CI pipulates it from the secret store. The test runner loads it via a fixture:

```python
# conftest.py
from dotenv import load_dotenv
import os

def pytest_configure(config):
    # Load live credential overrides from gitignored file if present
    load_dotenv(".env.live", override=False)
```

The `override=False` ensures that real CI environment variables (injected by the secret store) take precedence over any local seed file.

---

## Network Egress Inside Containers: The Preflight Trap

One of the subtlest failure modes in containerized live smoke tests is the preflight-passes-but-request-fails pattern. A network connectivity preflight check (often a simple DNS resolution or a TCP connect to port 443) succeeds, leading the test to believe egress is working—but the actual API call returns 403 or times out.

This happens because network-level access and application-level authorization operate at different layers:

- **The DNS lookup succeeds** because the proxy allows DNS egress on port 53
- **The TCP handshake completes** because the proxy allows HTTPS on port 443
- **The API call gets a 403** because the API provider blocks the IP range your container egress originates from (common with cloud provider IP ranges) or because the proxy strips the `Authorization` header

### Proxy Forwarding

Corporate CI environments often route all outbound traffic through an HTTP proxy. Docker containers do not inherit proxy settings by default. You must explicitly forward the proxy environment variables:

```yaml
# docker-compose.yml for test environment
services:
  test-runner:
    environment:
      - HTTP_PROXY=${HTTP_PROXY}
      - HTTPS_PROXY=${HTTPS_PROXY}
      - NO_PROXY=${NO_PROXY}
      - http_proxy=${http_proxy}
      - https_proxy=${https_proxy}
      - no_proxy=${no_proxy}
```

Note that some tools read `http_proxy` (lowercase) and others read `HTTP_PROXY` (uppercase). Pass both. The `NO_PROXY` / `no_proxy` variable is equally critical: it prevents internal service calls from being routed through the proxy unnecessarily.

### Diagnosing Credential vs. Network Failures

When a live smoke test fails with a 403 or similar, the diagnostic sequence matters:

1. **Check if the request reaches the provider at all.** A 403 from the provider itself (visible in response body) is different from a 403 from an intermediary proxy. Inspect response headers for proxy signatures (`Via`, `X-Cache`, `X-Forwarded-For`).
2. **Test from outside the container.** If the same credential works from the CI runner's host OS but fails from inside the container, it's a container network configuration problem, not a credential problem.
3. **Check IP allowlists.** Many API providers maintain allowlists or geographic restrictions. Cloud provider IP ranges (AWS, GCP, Azure) are sometimes explicitly blocked or throttled. If your container egresses from a cloud NAT gateway, the provider may see a data center IP and apply stricter rules.
4. **Verify header propagation.** Some proxies strip `Authorization` headers or add `X-Forwarded-For` headers that change the provider's routing decisions.

A concrete diagnostic script to run inside the container:

```bash
#!/bin/bash
# Diagnose: can we reach the API and does auth work?
echo "=== DNS check ==="
nslookup api.anthropic.com

echo "=== TCP connect ==="
curl -sv --connect-timeout 5 https://api.anthropic.com/v1/messages \
  -H "x-api-key: ${ANTHROPIC_API_KEY}" \
  -H "content-type: application/json" \
  --max-time 10 \
  -d '{"model":"claude-haiku-4-5","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}' \
  2>&1 | head -50

echo "=== Response body ==="
# The response body (not headers) will tell you if it's auth vs. network
```

If the DNS resolves and TCP connects but you get a 403, read the response body carefully: a provider auth error looks different from a proxy interception error.

---

## Flakiness Management and the Opt-In Architecture

Real-dependency tests are inherently flakier than hermetic tests. Provider rate limits, transient network failures, auth token expiry, and API breaking changes are all outside your control. The engineering response to this is not to eliminate the tests, but to structure them so their flakiness cannot corrupt your CI signal.

### Separate Workflow, Separate Gate

Live smoke tests should run in a workflow that is explicitly not a required status check for PR merges. In GitHub Actions, this means a separate workflow file that runs on a `schedule` (nightly or weekly) or on `workflow_dispatch` (manual trigger):

```yaml
# .github/workflows/live-smoke.yml
name: Live Dependency Smoke Tests
on:
  schedule:
    - cron: '0 2 * * *'   # 2am UTC nightly
  workflow_dispatch:       # manual trigger from Actions UI

jobs:
  live-smoke:
    runs-on: ubuntu-latest
    environment: live-testing   # GitHub Environment gates secret access
    steps:
      - uses: actions/checkout@v4
      - name: Run live smoke tests
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          RUN_LIVE_TESTS: "1"
        run: pytest tests/live/ -v --tb=short
```

Using a GitHub Environment (`environment: live-testing`) adds an additional layer of protection: you can require manual approval before the environment's secrets are released, and you can restrict which branches can access the environment.

### Quarantine and Ownership

The Gradle blog's approach to flaky tests generalizes cleanly: annotate live tests with a `@flaky` or `@quarantine` marker, run them in a separate non-blocking job, and assign each flaky test an explicit owner and fix-by date. Quarantine without ownership is just documented accumulation—tests sit there forever and nobody fixes them.

The key insight from Datadog's flaky test research is that flaky tests consume roughly 20% of CI time in aggregate across engineering organizations. For live smoke tests, the cost is even higher because they touch real APIs that may have rate limits or quota costs. Keep the live smoke suite small—a dozen focused tests, not a hundred—so flakiness is contained.

### Retry Policy

A limited retry (two attempts with a brief backoff) is appropriate for live tests where transient network failures are expected:

```python
import time
import pytest

def test_live_api_with_retry():
    last_exc = None
    for attempt in range(2):
        try:
            # ... API call
            return
        except Exception as exc:
            last_exc = exc
            time.sleep(2 ** attempt)
    pytest.fail(f"Live test failed after retries: {last_exc}")
```

Do not implement open-ended retry loops—they mask real failures and make the test suite non-terminating under sustained outages.

---

## Bidirectional State-Transition Coverage

AI agent runtimes often have explicit runtime switching—transitioning between Claude Code and Codex, between local and remote execution, between different model providers. When the transition is bidirectional (A→B and B→A), testing only one direction leaves a whole class of bugs uncovered: state that is correctly written during A→B may be incorrectly read when you go B→A, or cleanup that runs during B→A may corrupt the state needed for a subsequent A→B.

### Designing Bidirectional Scenarios

State transition testing formalized this in the "n-switch coverage" model: 0-switch coverage exercises individual states, 1-switch coverage exercises pairs of consecutive transitions, and full bidirectional coverage requires testing both the forward and reverse path. Applied to runtime switching:

```
Test scenario A: Start in runtime A → switch to B → verify B is operational
Test scenario B: Start in runtime B → switch to A → verify A is operational
Test scenario C: A → B → A round-trip → verify final state matches initial state
```

The third scenario (round-trip) is particularly valuable because it catches state accumulation bugs—where each switch leaves a residue that degrades behavior over time.

### Implementation Considerations

For a live smoke test of runtime switching, the test must actually invoke the real switch mechanism (the real CLI, the real config file update, the real process restart) and assert against the observable result, not an internal state variable. A runtime that reports "switched" but fails to actually change behavior on the next invocation is a bug that only a live test can catch.

```python
@REQUIRE_RUNTIME_SWITCHING_ENABLED
def test_runtime_switch_bidirectional():
    """Verify A→B and B→A transitions produce correct observable state."""
    initial_runtime = get_current_runtime()  # reads real config

    # A → B
    switch_runtime(target="codex")
    assert get_current_runtime() == "codex"
    assert codex_is_operational()  # real liveness check

    # B → A
    switch_runtime(target="claude-code")
    assert get_current_runtime() == "claude-code"
    assert claude_code_is_operational()  # real liveness check

    # Verify final state matches initial
    assert get_current_runtime() == initial_runtime
```

The credential guard here (`REQUIRE_RUNTIME_SWITCHING_ENABLED`) should check not just for credential presence but for the environmental conditions required to run a real switch (e.g., the target runtime is installed).

---

## Concrete Recommendations

**For teams building AI agent runtimes, the recommended structure is:**

1. **Keep 90%+ of tests hermetic.** Use PATH-prepended fake binaries for CLI tools, mock servers for LLM providers, fixture tokens for auth. These tests run on every commit, on every fork PR, in seconds.

2. **Define a `tests/live/` directory** as the explicit home for live-dependency smoke tests. Never mix live and hermetic tests in the same test file.

3. **Implement skip-not-fail universally.** Every test in `tests/live/` must check for its required credentials at the start and call `pytest.skip()` (or equivalent) if they are absent. Exit code must remain 0 for skipped tests.

4. **Use a `RUN_LIVE_TESTS` environment variable as the master gate.** Individual credential checks are a second layer; the master gate prevents accidental execution in hermetic CI contexts.

5. **Wire live tests to a nightly schedule and `workflow_dispatch`.** Do not add them to PR required checks. Use a GitHub Environment with secret protection.

6. **Keep the live suite small.** Fewer than 20 tests covering the critical integration boundaries: auth token acquisition, API reachability, CLI binary invocation, proxy egress.

7. **Diagnose network failures systematically.** When a live test fails in CI, distinguish between credential errors (HTTP 401/403 with provider-specific body) and network errors (connection refused, SSL errors, proxy 407) before concluding the code is wrong.

8. **Cover both directions of every state transition.** If your runtime can switch A→B, you must also test B→A and the round-trip.

9. **Assign ownership to live tests.** Flaky live tests without owners accumulate. Each live test file should have a comment naming the team or engineer responsible.

10. **Rotate and scope credentials.** CI credentials for live tests should be scoped to the minimum permissions needed (read-only where possible), rotated regularly, and distinct from production credentials.

The investment in this thin live-smoke layer pays for itself the first time it catches a breaking API change, a proxy misconfiguration, or a CLI version mismatch that the hermetic suite—by design—cannot detect. Keep it small, keep it opt-in, and keep it honest.
