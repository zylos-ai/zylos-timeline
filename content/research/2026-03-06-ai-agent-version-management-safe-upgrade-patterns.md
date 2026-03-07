---
date: "2026-03-06"
title: "AI Agent Version Management: Safe Upgrade Patterns for Production Systems"
description: "Strategies for managing AI runtime versions in production — version pinning, canary upgrades, rollback patterns, and testing approaches for AI agent infrastructure."
tags: ["ai-agents", "version-management", "devops", "production", "upgrades", "deployment"]
---

## Executive Summary

Managing AI agent runtime versions in production has become one of the most critical operational challenges of 2025-2026. Unlike traditional software dependencies, AI runtimes like Claude Code, Cursor, and GitHub Copilot CLI introduce a unique class of risks: behavioral changes that are difficult to detect, silent model updates that shift output quality, and upgrade-induced state desync that can break long-running agent sessions. Industry data shows that tool versioning causes 60% of production agent failures, and model drift accounts for another 40% — making version management the single largest reliability concern for production AI agent systems.

This article synthesizes current best practices across version pinning strategies, safe upgrade patterns (canary, blue-green, shadow deployments), dependency management, testing and evaluation frameworks, and configuration-driven upgrade policies. The focus is on actionable patterns with concrete implementation examples, drawn from real-world production deployments and recent incidents.

## Version Pinning Strategies for AI Agent Runtimes

### The Case for Pinning

AI runtimes update frequently — Claude Code ships multiple releases per month, Cursor maintains separate default and early-access channels, and GitHub Copilot updates its backend models without client-side version bumps. In a production agent system, an unexpected runtime update can cause:

- **Session state desync** — new versions may change how conversation state is serialized or restored
- **Behavioral regression** — tool-calling patterns, output formatting, or error handling may shift
- **Heartbeat deadlocks** — changes to process lifecycle management can break health-check mechanisms
- **Configuration incompatibility** — new versions may deprecate or rename configuration keys

### NPM Version Pinning

For Node.js-based AI tools like Claude Code, npm provides the primary version control mechanism:

```json
{
  "dependencies": {
    "@anthropic-ai/claude-code": "1.0.54"
  }
}
```

Key practices:

- **Use exact versions** (no `^` or `~` prefix) in `package.json` to prevent silent upgrades
- **Commit `package-lock.json`** to ensure deterministic installs across environments
- **Disable auto-updates** via environment variable: `export DISABLE_AUTOUPDATER=1`
- **Pin to specific versions** when installing globally: `npm install -g @anthropic-ai/claude-code@1.0.54`

### Native Installer Version Pinning

As of early 2026, Anthropic has deprecated npm installation for Claude Code in favor of a native installer. The version pinning syntax changes accordingly:

```bash
# npm style (deprecated)
npm install -g @anthropic-ai/claude-code@2.1.42

# Native installer with version pin
curl -fsSL claude.ai/install.sh | bash -s 2.1.42
```

### Docker Tag Strategies

For containerized agent deployments, Docker tags provide an additional version control layer:

```dockerfile
# Bad: mutable tag, content can change
FROM node:20-slim
RUN npm install -g @anthropic-ai/claude-code@latest

# Good: pinned versions with digest
FROM node:20.11.0-slim@sha256:abc123...
RUN npm install -g @anthropic-ai/claude-code@1.0.54
```

Best practices for container-based pinning:

- **Use immutable image digests** alongside version tags
- **Store agent images in a private registry** with semantic version tags
- **Never use `latest` tags** in production Dockerfiles or Kubernetes manifests
- **Include the runtime version in the image tag**: `my-agent:1.2.0-claude-1.0.54`

### Multi-Environment Version Matrix

Maintain a version matrix that maps environments to approved runtime versions:

```yaml
# version-policy.yaml
environments:
  development:
    claude-code: ">=2.1.0"      # Allow latest minor versions
    update-channel: "early-access"
  staging:
    claude-code: "2.1.42"       # Pin to specific version
    update-channel: "default"
  production:
    claude-code: "2.1.42"       # Exact match with staging
    update-channel: "default"
    auto-update: false
```

## Safe Upgrade Patterns

### Pre-Upgrade Checklist

Before upgrading any AI runtime in production, complete these steps:

1. **Verify current state**: Run `claude --version` and `claude doctor` for diagnostics
2. **Review the changelog**: Check release notes for breaking changes, deprecations, and behavioral shifts
3. **Back up configuration**: `cp -r ~/.claude ~/.claude.backup.$(date +%Y%m%d)`
4. **Back up state**: Preserve any persistent agent state (memory files, session data, tool configurations)
5. **Test in isolation**: Validate core workflows in a sandbox environment before broader deployment
6. **Coordinate timing**: Schedule upgrades during low-traffic periods; communicate with the team

### Canary Deployment for AI Agents

Canary deployments route a small percentage of traffic to the upgraded version while monitoring for degradation:

```json
{
  "strategy": { "mode": "loadbalance" },
  "targets": [
    { "virtual_key": "stable-agent-v2.1.42", "weight": 0.95 },
    { "virtual_key": "canary-agent-v2.2.0", "weight": 0.05 }
  ]
}
```

The recommended rollout cadence:

1. **5% traffic** — monitor for 24 hours, check error rates and latency
2. **10% traffic** — expand if metrics are stable, begin checking output quality
3. **25% traffic** — broader validation with diverse task types
4. **50% traffic** — near-parity testing
5. **100% traffic** — full rollout with continued monitoring

Rollback trigger thresholds:

- Error rate increase > 2x baseline
- P95 latency increase > 50%
- Token usage increase > 30% (indicates reasoning regression)
- Task success rate drop > 5%
- Any hallucination rate increase

### Blue-Green Deployment

Blue-green deployment maintains two complete environments:

```
                    ┌─────────────────┐
                    │   Load Balancer  │
                    └────────┬────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
    ┌─────────┴─────────┐       ┌──────────┴────────┐
    │   Blue (v2.1.42)  │       │  Green (v2.2.0)   │
    │   [ACTIVE]        │       │  [STANDBY]        │
    │                   │       │                   │
    │  Agent Runtime    │       │  Agent Runtime    │
    │  Agent Code       │       │  Agent Code       │
    │  Tool Configs     │       │  Tool Configs     │
    └───────────────────┘       └───────────────────┘
```

Key considerations for AI agent blue-green:

- **State migration**: Agent conversation state and memory must be portable between environments
- **Warm-up period**: New environment needs time to establish LLM API connections and load context
- **Shared resources**: External tools (databases, APIs) must support both versions simultaneously
- **Instant rollback**: Switch traffic back to blue if green shows any degradation

### Shadow Deployment (Dual-Run)

For high-risk upgrades, shadow deployment processes live traffic through both versions but only returns the stable version's response:

```
User Request
     │
     ├──► Stable Agent (v2.1.42) ──► Response to User
     │
     └──► Shadow Agent (v2.2.0)  ──► Log for Comparison
```

Shadow deployment enables:

- **Behavioral diff analysis**: Compare outputs between versions without user impact
- **Performance profiling**: Measure latency and resource differences under real load
- **Quality scoring**: Run automated evaluators on shadow outputs
- **Risk-free validation**: Validate the new version with production traffic patterns

This is the safest approach for major version upgrades or when the changelog includes significant behavioral changes.

### Staged Team Rollout

For development tools like Claude Code used by a team:

1. **Day 1-2**: Volunteer developers upgrade and test core workflows
2. **Day 3-5**: Broader team testing with performance benchmarking
3. **Day 6-7**: Full team rollout with monitoring
4. **Day 8+**: Review feedback, document issues, update version policy

## Dependency Management: Runtime vs. Agent Code

### The Two-Layer Problem

AI agent systems have a fundamental dependency management challenge: the agent code you write depends on an AI runtime whose behavior is partially non-deterministic and changes between versions in ways that are difficult to predict or test.

```
┌────────────────────────────────────┐
│        Your Agent Code             │  ← You control this
│  (prompts, tools, workflows)       │
├────────────────────────────────────┤
│        AI Runtime                  │  ← Vendor controls this
│  (Claude Code, Cursor, etc.)       │
├────────────────────────────────────┤
│        LLM API                     │  ← Provider controls this
│  (Claude API, GPT API, etc.)       │
├────────────────────────────────────┤
│        Infrastructure              │  ← Ops team controls this
│  (Node.js, Python, OS, Docker)     │
└────────────────────────────────────┘
```

Each layer can change independently, and changes propagate upward unpredictably. A Claude API model update can change behavior even if your agent code and Claude Code version remain fixed.

### Treating the AI Runtime as a Managed Dependency

Best practices:

- **Pin the runtime version** just like any other dependency (see Version Pinning above)
- **Pin the model version** where the API supports it (e.g., `claude-sonnet-4-20250514` instead of `claude-sonnet-4-latest`)
- **Version your prompts** alongside your agent code — prompts are code, not configuration
- **Separate runtime upgrades from agent code changes** — never ship both in the same release
- **Maintain a compatibility matrix** documenting which agent code versions work with which runtime versions

### Lock File Strategy

```json
{
  "name": "my-ai-agent",
  "version": "1.5.0",
  "dependencies": {
    "@anthropic-ai/claude-code": "2.1.42",
    "@anthropic-ai/sdk": "0.39.0",
    "concurrently": "8.2.0"
  },
  "overrides": {
    "@anthropic-ai/claude-code": "2.1.42"
  }
}
```

Note the use of exact versions (no `^` or `~`) and `overrides` to prevent transitive dependency updates from pulling in a different version.

## Auto-Upgrade vs. Locked Versions

### When to Lock Versions

Lock versions when:

- **Running in production** with real users or critical workflows
- **Operating autonomous agents** that run without human supervision
- **Managing a team** where consistency across developer environments matters
- **After a known-bad release** while waiting for a fix
- **During critical project phases** where stability outweighs new features

### When Auto-Upgrade is Acceptable

Allow auto-upgrades when:

- **In development environments** where developers benefit from latest features
- **For security patches** that fix critical vulnerabilities (e.g., the CVE-2025-59536 arbitrary code execution vulnerability in Claude Code)
- **In sandbox/staging environments** that serve as early-warning systems
- **For non-critical tools** that do not affect production workflows

### Configuration Examples

```bash
# Disable auto-updates globally
export DISABLE_AUTOUPDATER=1

# Or per-project in .env
DISABLE_AUTOUPDATER=1
CLAUDE_CODE_VERSION=2.1.42
```

For Cursor, the update channel selection provides a similar control:

- **Default channel**: Thoroughly tested, stable releases — recommended for teams
- **Early Access channel**: Cutting-edge features, higher risk — suitable for individual developers
- **Team/Business accounts**: Restricted to Default channel for consistency

### Hybrid Approach: Controlled Auto-Upgrade

The most practical approach for many teams is a hybrid policy:

```yaml
upgrade-policy:
  # Auto-upgrade in dev, manual approval for production
  development:
    auto-upgrade: true
    channel: "early-access"
    notify-on-update: true
  staging:
    auto-upgrade: true
    channel: "default"
    run-tests-on-update: true
    block-on-failure: true
  production:
    auto-upgrade: false
    channel: "default"
    require-approval: true
    minimum-staging-soak: "48h"
```

## Testing AI Agent Upgrades

### The Evaluation Framework

Anthropic's engineering team recommends a layered evaluation approach inspired by the Swiss Cheese Model from safety engineering — multiple testing layers where each catches different failure modes:

1. **Automated evals on every code commit** — fast, catches obvious regressions
2. **Production traffic monitoring** — reveals real user behavior at scale
3. **A/B testing for significant changes** — requires days or weeks of data
4. **Manual transcript review** — weekly qualitative signal
5. **Systematic human studies** — for subjective or complex domains

### Regression Testing

Regression tests maintain a near-100% pass rate and exist to catch drift:

```python
# Example regression test suite for agent behavior
class AgentRegressionTests:
    """Tests that previously working behaviors continue to work."""

    def test_file_creation_workflow(self):
        """Agent can create and write to files."""
        result = run_agent("Create a file called test.txt with 'hello world'")
        assert file_exists("test.txt")
        assert file_content("test.txt") == "hello world"

    def test_multi_step_reasoning(self):
        """Agent handles multi-step tasks without losing context."""
        result = run_agent(
            "Read config.json, change the port to 8080, and verify the change"
        )
        assert result.steps_completed >= 3
        assert json.load("config.json")["port"] == 8080

    def test_error_recovery(self):
        """Agent recovers gracefully from tool failures."""
        result = run_agent("Read nonexistent.txt and handle the error")
        assert not result.crashed
        assert "not found" in result.output.lower() or "does not exist" in result.output.lower()
```

Key metrics for non-deterministic agent behavior:

- **pass@k**: Probability of at least one correct solution in k attempts — measures capability
- **pass^k**: Probability that all k attempts succeed — measures consistency and reliability

### Shadow Testing Pipeline

```bash
# Run both versions against the same test suite
STABLE_RESULTS=$(run_test_suite --version=2.1.42 --runs=10)
CANARY_RESULTS=$(run_test_suite --version=2.2.0 --runs=10)

# Compare behavioral metrics
compare_results \
  --stable="$STABLE_RESULTS" \
  --canary="$CANARY_RESULTS" \
  --threshold-pass-rate=0.95 \
  --threshold-latency-increase=1.5 \
  --threshold-token-increase=1.3
```

### Post-Upgrade Validation Checklist

After upgrading, verify:

- **Basic functionality**: Version confirmation, diagnostic output (`claude doctor`)
- **Configuration preservation**: Settings, custom commands, MCP server connections
- **Tool operations**: File read/write, shell execution, search functionality
- **Performance baseline**: Response latency, memory usage, context window handling
- **State management**: Session persistence, memory file integrity, heartbeat stability
- **Integration points**: API connections, webhook delivery, scheduled task execution

### Building an Eval Suite from Failures

Anthropic recommends an 8-step roadmap for building evaluation suites:

1. Start with 20-50 tasks derived from real production failures
2. Convert manual debugging checks into automated test cases
3. Write unambiguous tasks with clear reference solutions
4. Build balanced problem sets with both positive and negative cases
5. Design robust test harnesses with isolated environments
6. Create thoughtful graders that avoid over-rigid path-checking
7. Review transcripts regularly to verify grader accuracy
8. Monitor for eval saturation and add harder benchmarks over time

## Real-World Incidents and Lessons

### Claude Code Security Vulnerabilities

Two critical CVEs demonstrate why version management matters:

- **CVE-2025-59536** (CVSS 8.7): Allowed arbitrary code execution through untrusted project hooks. Teams running older versions were exposed until they upgraded.
- **CVE-2026-21852** (CVSS 5.3): Allowed API key exfiltration when opening crafted repositories.

Both cases illustrate a tension: pinning versions protects against behavioral regression but can leave systems exposed to security vulnerabilities. The solution is a policy that allows security patches while blocking feature updates.

### Session State Desync After Upgrades

A common failure pattern observed across AI agent deployments: upgrading the runtime while agents have active sessions causes state desync. The new version may serialize session data differently, interpret configuration files with updated defaults, or change the heartbeat/liveness protocol. This manifests as:

- Agents appearing unresponsive despite running normally
- Loss of conversation context mid-session
- Tool configurations reverting to defaults
- Scheduled tasks failing silently

Mitigation: Always drain active sessions before upgrading, or implement session-version tagging so the system knows which runtime version created each session.

### Silent Model Updates

LLM providers occasionally update model weights behind a stable version identifier. Even with the runtime pinned, the underlying model behavior can shift. Teams have reported:

- Changes in output formatting that break downstream parsers
- Shifts in tool-calling patterns (different argument structures, different tool selection)
- Altered reasoning depth that affects task completion time and token costs

Mitigation: Pin model versions explicitly (e.g., `claude-sonnet-4-20250514`) and monitor behavioral metrics continuously, not just at upgrade time.

### The "Feels Worse But Can't Prove It" Problem

A widely reported pattern in late 2025 / early 2026: after a model or runtime upgrade, the agent "feels worse" to users — slower, less accurate, more verbose — but teams cannot prove it because they lack quantitative baselines. Without pre-upgrade eval scores, there is no objective way to measure regression.

Mitigation: Run evaluations continuously, not just during upgrades. Establish behavioral baselines before any version change.

## Semantic Versioning for AI Tools

### How Well AI Tools Follow Semver

The AI tooling ecosystem has varying semver discipline:

**LangChain** (good semver practices): Since 1.0, breaking changes only occur in major releases. Deprecated features continue working throughout the entire minor release series. Clear deprecation warnings with migration guidance.

**Claude Code** (evolving): Rapid release cadence with frequent minor bumps. Migration from npm to native installer represented a significant workflow change. Changelog is maintained but behavioral changes are not always flagged as breaking.

**Cursor** (channel-based): Uses update channels (Default, Early Access) rather than strict semver. Teams can control risk through channel selection. Pricing/feature changes have caused community friction.

### The Semver Gap for AI Tools

Traditional semver focuses on API contracts: if the function signature does not change, it is not a breaking change. AI tools have a broader surface area:

- **Output behavior** can change without API changes
- **Performance characteristics** (latency, token usage) can shift
- **Side effects** (file system operations, network calls) can differ
- **Default configurations** can change between minor versions

A version bump from 2.1.0 to 2.2.0 might technically be non-breaking by semver rules while fundamentally changing how the agent behaves in production. This is the core challenge of AI tool versioning.

### Recommendations

- Treat minor version bumps in AI tools with the caution you would give major bumps in traditional software
- Maintain your own changelog of behavioral observations per version
- Do not rely solely on the vendor's semver to gauge upgrade risk

## Configuration-Driven Upgrade Policies

### Feature Flag Integration

Use feature flags to control AI agent behavior independently of version deployments:

```javascript
// Feature flag configuration for AI agent capabilities
const agentConfig = {
  flags: {
    "agent.use-new-reasoning-model": {
      enabled: false,
      rollout: { percentage: 0 },
      environments: ["development"]
    },
    "agent.extended-context-window": {
      enabled: true,
      rollout: { percentage: 25 },
      environments: ["development", "staging"]
    },
    "agent.v2-tool-calling": {
      enabled: true,
      rollout: { percentage: 100 },
      environments: ["development", "staging", "production"]
    }
  }
};
```

### Per-Environment Configuration

```yaml
# agent-config.production.yaml
runtime:
  version: "2.1.42"
  auto-update: false
  update-channel: "default"

model:
  primary: "claude-sonnet-4-20250514"    # Pinned model version
  fallback: "claude-haiku-4-20250514"
  temperature: 0.7

upgrade-policy:
  require-staging-validation: true
  minimum-soak-time: "48h"
  require-team-approval: true
  auto-rollback-on-error-spike: true
  error-threshold: 2.0                   # 2x baseline

monitoring:
  eval-suite: "regression-v3"
  run-frequency: "hourly"
  alert-on-degradation: true
  metrics:
    - task-success-rate
    - p95-latency
    - token-usage-per-task
    - error-rate
    - hallucination-rate
```

### Gradual Rollout Pipeline

A complete upgrade pipeline combining the patterns above:

```yaml
# upgrade-pipeline.yaml
stages:
  - name: "Staging Deploy"
    action: deploy
    environment: staging
    version: "2.2.0"
    duration: "24h"
    gates:
      - eval-suite-pass-rate >= 0.98
      - error-rate <= baseline * 1.5
      - p95-latency <= baseline * 1.2

  - name: "Canary Production"
    action: canary
    environment: production
    version: "2.2.0"
    traffic: 5%
    duration: "24h"
    gates:
      - task-success-rate >= 0.95
      - no-new-error-types
      - token-usage <= baseline * 1.3

  - name: "Expand Canary"
    action: canary
    environment: production
    version: "2.2.0"
    traffic: 25%
    duration: "24h"
    gates:
      - all-previous-gates
      - user-satisfaction >= baseline

  - name: "Full Rollout"
    action: deploy
    environment: production
    version: "2.2.0"
    traffic: 100%
    monitoring: "7d"

  - name: "Rollback"
    trigger: any-gate-failure
    action: rollback
    target-version: "2.1.42"
    alert: team-channel
```

### Automated Rollback Configuration

```javascript
// Automated rollback trigger
const rollbackPolicy = {
  triggers: [
    {
      metric: "error_rate",
      condition: "greater_than",
      threshold: "2x_baseline",
      window: "15m",
      action: "immediate_rollback"
    },
    {
      metric: "task_success_rate",
      condition: "less_than",
      threshold: 0.90,
      window: "30m",
      action: "halt_rollout"
    },
    {
      metric: "p95_latency_ms",
      condition: "greater_than",
      threshold: 5000,
      window: "10m",
      action: "alert_and_pause"
    }
  ],
  rollback_steps: [
    "drain_active_sessions",
    "restore_previous_version",
    "restore_configuration_backup",
    "verify_health_checks",
    "resume_traffic",
    "notify_team",
    "create_incident_report"
  ]
};
```

## Practical Recommendations

### For Small Teams (1-5 Agents)

1. Pin your AI runtime to exact versions in `package.json` or equivalent
2. Disable auto-updates in production: `DISABLE_AUTOUPDATER=1`
3. Maintain configuration backups before every upgrade
4. Test upgrades manually in a sandbox before rolling out
5. Keep a simple rollback script: restore the previous version and configuration backup
6. Run a basic regression test suite (20-50 cases) after each upgrade

### For Medium Teams (5-20 Agents)

All of the above, plus:

1. Implement canary deployments with 5% initial traffic
2. Maintain separate staging and production version policies
3. Build automated eval suites that run on every upgrade
4. Establish behavioral baselines and monitor continuously
5. Use feature flags to decouple feature rollouts from version upgrades
6. Document upgrade decisions and outcomes for team learning

### For Large Deployments (20+ Agents)

All of the above, plus:

1. Implement shadow deployments for major version upgrades
2. Build a version compatibility matrix (agent code x runtime x model)
3. Use ring-based deployment: inner ring (test), middle ring (trusted users), outer ring (full rollout)
4. Automate rollback triggers based on metric thresholds
5. Invest in production traffic replay for offline upgrade validation
6. Maintain a dedicated upgrade pipeline with stage gates

### Universal Principles

- **Never upgrade production on a Friday** (or before any period of reduced team availability)
- **Never upgrade the runtime and agent code simultaneously** — isolate changes
- **Always have a rollback plan** that has been tested, not just documented
- **Monitor for at least 48 hours** after any production upgrade
- **Treat AI runtime upgrades as infrastructure changes**, not routine dependency bumps

---

*Sources:*

- [Why Versioning AI Agents is the CIO's Next Big Challenge — CIO](https://www.cio.com/article/4056453/why-versioning-ai-agents-is-the-cios-next-big-challenge.html)
- [Safe Upgrade Procedures — Developer Toolkit](https://developertoolkit.ai/en/claude-code/version-management/upgrade-procedures/)
- [Staying Current with Claude Code — Developer Toolkit](https://developertoolkit.ai/en/claude-code/version-management/)
- [Versioning, Rollback and Lifecycle Management of AI Agents — NJ Raman](https://medium.com/@nraman.n6/versioning-rollback-lifecycle-management-of-ai-agents-treating-intelligence-as-deployable-deac757e4dea)
- [Canary Testing for LLM Apps — Portkey](https://portkey.ai/blog/canary-testing-for-llm-apps/)
- [Demystifying Evals for AI Agents — Anthropic Engineering](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- [AI Agent Evaluations: The Complete 2025-2026 Guide — Efficient Coder](https://www.xugj520.cn/en/archives/ai-agent-evaluations-guide-2025.html)
- [AI-Powered Progressive Delivery: Feature Flags in 2026 — Azati](https://azati.ai/blog/ai-powered-progressive-delivery-feature-flags-2026/)
- [LLM Feature Flags: Safe Rollouts of AI in Apps — WP Pluginsify](https://wppluginsify.com/blog/llm-feature-flags-safe-rollouts-of-ai-in-apps/)
- [From Prototype to Production: Deploying AI Agents in the Enterprise — Brian Curry](https://medium.com/@brian-curry-research/from-prototype-to-production-a-practical-guide-to-deploying-ai-agents-in-the-enterprise-e942920cd877)
- [Deploying AI Agents to Production — Machine Learning Mastery](https://machinelearningmastery.com/deploying-ai-agents-to-production-architecture-infrastructure-and-implementation-roadmap/)
- [Self-Healing Rollouts with Agentic AI and Argo Rollouts — Carlos Sanchez](https://blog.csanchez.org/2025/10/15/self-healing-rollouts-automating-production-fixes-with-agentic-ai-and-argo-rollouts/)
- [Claude Code Releases — GitHub](https://github.com/anthropics/claude-code/releases)
- [AgentOps: End-to-End Lifecycle Management for Production AI Agents — Microsoft](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/from-zero-to-hero-agentops---end-to-end-lifecycle-management-for-production-ai-a/4484922)
- [Release Policy — LangChain](https://docs.langchain.com/oss/python/release-policy)
- [State of AI Agents — LangChain](https://www.langchain.com/state-of-agent-engineering)
