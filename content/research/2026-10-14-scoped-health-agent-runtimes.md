---
date: "2026-10-14"
title: "Health Has a Scope: Recovery Evidence for Multi-Runtime Agents"
description: "How to match health state to failure domains, prevent unrelated successes from clearing outages, and recover only on evidence that tests the failing path."
tags: ["research", "ai-agents", "reliability", "health-checks", "circuit-breakers", "distributed-systems"]
---

## Executive Summary

An agent platform can have a responsive supervisor, valid credentials, and one working model connection while another execution path remains unusable. A single green health flag hides those differences. Worse, it can turn success on the wrong path into permission to resume work on a failing one.

This article proposes a contract for recovery evidence: identify the failure domain, record what an observation actually tested, and accept it only for the current execution and failure episode. A runtime name is a useful starting point, but provider, credential context, endpoint, and resource may define different boundaries. Recovery should clear only the conditions that the new evidence addresses.

The proposal draws on established behavior in Envoy, Kubernetes, AWS SDKs, gRPC, and circuit breakers. The evidence schema and agent policies below are our synthesis, not features claimed for those projects. The central question is narrow: **which health decision is this observation entitled to change?**

## A Success That Fixes Nothing

Consider two workers. Both run the same agent executable, but one uses account A against endpoint East and the other uses account B against endpoint West. Account A cannot complete inference. Account B completes a short request.

If the supervisor stores health under the executable name, the second worker's success may erase the first worker's failure. If it stores one global platform flag, even a different runtime could erase that failure. Conversely, one account's throttling may stop unrelated workers that could still serve requests.

These are two errors caused by one modeling choice: the state key merges things that do not share a failure boundary. The remedy begins before retry intervals or dashboard colors. Write down the claim attached to each state entry and the population of requests it governs.

There is concrete precedent. The [AWS SDK for Java 2.x retry guide](https://docs.aws.amazon.com/sdk-for-java/latest/developer-guide/retry-strategy.html) warns that adaptive retry assumes a client targets a single resource. Sharing that client across resources allows throttling or an outage on one to increase latency and failures for the others. The point here is the scope of shared feedback, not a recommendation to use adaptive mode everywhere.

## Choose Keys from Failure Domains

Our proposed representation separates several scopes instead of placing every error into a maximum-length tuple:

| Condition being tracked | Illustrative scope | Evidence that could address it |
|---|---|---|
| Local process unresponsive | Process incarnation | Response from that incarnation |
| Credential rejected | Provider and credential context | Credential accepted on the relevant protected path |
| Resource access denied | Credential context and resource | Authorized access to that resource |
| Resource throttled | Provider's documented quota domain | Qualifying request under that same quota domain |
| Endpoint transport failure | Endpoint and relevant network path | Successful exchange through that path |
| Inference unavailable | Configured execution path | Completed bounded inference on that path |

These are illustrative keys, not a universal provider taxonomy. A quota may apply to an organization, region, model, project, or another resource. Determine that from the provider contract and structured response, rather than inferring it from a runtime label or status code alone.

Overly broad keys spread disruption. Overly narrow keys hide shared disruption, duplicate probes, and can let each worker independently consume a shared retry budget. A practical design therefore keeps explicit dependency relationships: several workers may depend on one account-level condition while retaining separate process-level conditions. A recovered dependency does not automatically repair every worker.

[Envoy outlier detection](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/outlier) distinguishes locally originated failures, such as connection failures and resets, from externally generated transaction errors. Its optional `split_external_local_origin_errors` setting gives them separate counters. That is useful precedent for preserving failure categories. It does not mean that a client-side timeout proves the upstream server is broken; it records where the error was observed.

Keep the raw observation separate from the diagnosis. “Request timed out through endpoint East” is evidence. “All accounts on this provider are unavailable” is a broader hypothesis requiring additional support.

## Test the Condition You Intend to Clear

A process response establishes responsiveness. A credential check establishes something about credential acceptance. A completed inference establishes that one inference path worked at a particular moment. None alone proves that arbitrary future tasks will succeed.

The [Claude API error reference](https://platform.claude.com/docs/en/api/errors) distinguishes authentication, permission, rate-limit, and overloaded errors. It also documents errors that arrive during a streaming response after HTTP 200. Those distinctions explain why neither a recognized credential nor an initial successful HTTP status establishes completion of a model request.

This matters during recovery. Suppose an account previously failed to infer, but a local command now reports credentials present. That is a useful configuration observation, yet it has not exercised the failing request path. Record it without clearing inference failure. Similarly, a request that receives headers and then fails mid-stream has not completed the intended operation.

Envoy documents an especially direct version of this problem: a successful active health check can uneject a host and reset outlier counters, but a check that does not validate data-plane traffic can restore a still-failing endpoint prematurely. Its documentation describes a configuration option to disable successful active checks from unejecting the host. The lesson for our proposal is to define the strength of each observation explicitly, rather than letting every successful check perform the same reset. [Envoy's active-check interaction](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/outlier).

For an inference probe, a bounded request should use the intended credential context, endpoint, model or resource, and relevant request mode. It should avoid tools and user-visible effects and require the completion condition appropriate to that protocol. Its success is still a small sample, so restoration policy may require multiple observations or limited traffic before full admission.

## Health Decisions Have Different Consequences

[Kubernetes probes](https://kubernetes.io/docs/concepts/workloads/pods/probes/) distinguish restart-oriented liveness from readiness for traffic. The documentation warns that incorrect liveness probes can cause cascading failures. Our application-level inference is that an external provider outage should not automatically become a local-process restart decision: the failed condition and the proposed corrective action concern different resources.

The [gRPC health service](https://grpc.io/docs/guides/health-checking/) also supports named-service health, with an empty service name available for whole-server health. The application is responsible for updating that status. A health endpoint is therefore an interface for a judgment; its existence does not establish that the judgment is appropriately scoped.

For a heterogeneous agent supervisor, separate at least the following decisions: whether to restart a process, whether to admit a particular kind of task, and whether to attempt a recovery check. They may consume overlapping evidence, but should not share one unconditional transition to “healthy.”

For example, a live worker with an unavailable model path may continue exposing status and retaining queued work. Another worker with an independent path may remain eligible. Whether queued work may be rerouted depends on compatibility and authorization, which are separate from proving that the original path recovered.

## Bind Observations to an Execution and an Episode

Scope also has a temporal dimension. A probe can start on one worker, finish after that worker is replaced, and accidentally update its replacement. A familiar worker name is insufficient to distinguish those executions.

[Kubernetes object identity](https://kubernetes.io/docs/concepts/overview/working-with-objects/names/) illustrates the distinction: an object name can be reused after deletion, while a UID distinguishes historical object instances. Applying that principle here is our design choice. Assign each process incarnation an identity and carry it through the probe result.

An incarnation check alone is not enough. The same process can suffer a second failure while an earlier probe is still running. A late success from the earlier episode must not erase the newer failure. Our proposed evidence record therefore includes:

```text
observation = {
  scope_key,
  condition_tested,
  process_incarnation,
  health_episode,
  configuration_revision,
  probe_id,
  started_at,
  completed_at,
  outcome
}
```

The consumer validates these fields against current state before applying the result. It rejects observations from a replaced process, superseded episode, or changed configuration, and applies any configured freshness bound. A check that proves credential acceptance may update that condition but cannot silently reset a separate inference condition.

This is a logical acceptance rule, not a requirement for one particular database. The state comparison and update must nevertheless be atomic enough that a concurrent failure cannot slip between validation and the write. Logs should preserve why an observation was ignored; otherwise operators may mistake correct rejection for a broken monitor.

## Recovery Requires an Eligible Target

A runtime family may have no currently running instance on which an applicable probe can execute. There is then no new evidence about that path. An unrelated runtime's success cannot substitute for it.

Our conservative policy is to preserve the last failure, mark current recovery evidence unavailable, and wait for an eligible execution to exist under the normal lifecycle policy. If no failure was previously established, the state is unverified, not failed. “Unrecovered” describes the absence of clearing evidence after failure; it is not proof that the fault remains physically present.

Do not let the health loop silently turn this observation gap into a process-creation mandate. Starting a disposable probe worker may be a valid separately designed policy, but it has cost, credential, lifecycle, and concurrency implications. This proposal does not require it.

[Microsoft's circuit-breaker pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker) describes half-open operation as permitting a limited number of requests to test whether calls can succeed again. A timeout allows another test; it does not itself supply a successful result. Our extension is that the trial must also belong to the right scope and current episode. Explicitly define the event that will reconsider recovery when a suitable target appears, so “wait for evidence” does not become permanent neglect.

## A Small Model to Challenge the Contract

A synthetic in-memory experiment accompanying this research exercises the acceptance boundary without network calls, credentials, or worker processes. The model checks sixteen assertions and detects five deliberately incorrect variants: global health state, accepting an obsolete run, clearing all conditions on authentication success, attempting a probe without an eligible target, and accepting an obsolete failure episode within the same run.

These are model results, not a production reliability measurement. The episode guard is an in-memory illustration; it does not establish durable authority across a supervisor restart or atomic behavior under production concurrency. A successful trial clears only its targeted rate condition in this model. The reproduction should retain the broken variants because they demonstrate that the checks can reject the intended mistakes.

Save the following as `scope_experiment.py` and run `python3 scope_experiment.py` with Python 3 (without `-O`, which disables assertions). Only the standard library is required. The simplified scope is `(engine, account)`; configuration revision, freshness, and concurrent updates are outside this model. Authentication success is treated as a synchronous current event; delayed authentication results would also need the acceptance checks described above. The shared-scope assertion queries the same key twice, rather than simulating two workers.

```python
"""Deterministic model: synthetic events, no network, processes, or credentials."""
from collections import defaultdict
import json
import ast

class Health:
    def __init__(self, mutant=None):
        self.blocked = defaultdict(set)
        self.runs = {}
        self.epoch = defaultdict(int)
        self.probes = 0
        self.mutant = mutant

    def key(self, scope):
        return 'global' if self.mutant == 'global' else scope

    def fail(self, scope, reason):
        self.blocked[self.key(scope)].add(reason)
        self.epoch[self.key(scope)] += 1

    def allowed(self, scope):
        return not self.blocked[self.key(scope)]

    def auth_ok(self, scope):
        reasons = self.blocked[self.key(scope)]
        if self.mutant == 'auth-clears-all':
            reasons.clear()
        else:
            reasons.discard('auth')

    def start_probe(self, scope):
        target = next(((run, owner) for run, owner in self.runs.items()
                       if owner == scope), None)
        if target is None:
            if self.mutant == 'invent-target':
                self.probes += 1
            return None
        self.probes += 1
        return (scope, target[0], self.epoch[self.key(scope)])

    def probe_ok(self, observation):
        scope, run, epoch = observation
        if self.mutant != 'stale-ok' and self.runs.get(run) != scope:
            return False
        if self.mutant != 'old-epoch-ok' and self.epoch[self.key(scope)] != epoch:
            return False
        self.blocked[self.key(scope)].discard('rate')
        return True


def check(mutant=None):
    h = Health(mutant)
    a, b = ('engine-a', 'account-1'), ('engine-b', 'account-2')
    h.runs = {'run-a1': a, 'run-b1': b}
    h.fail(b, 'rate')
    assert h.allowed(a), 'unrelated scope blocked'
    assert not h.allowed(b), 'failed scope admitted'
    same_account_peer = b
    assert not h.allowed(same_account_peer), 'shared failure domain escaped gate'
    obs = h.start_probe(b)
    assert obs == (b, 'run-b1', 1), 'probe borrowed another scope'
    del h.runs['run-b1']
    h.runs['run-b2'] = b
    assert not h.probe_ok(obs), 'stale run cleared failure'
    assert not h.allowed(b), 'late result reopened scope'
    h.fail(b, 'auth')
    h.auth_ok(b)
    assert not h.allowed(b), 'auth success cleared rate limit'
    assert h.blocked[h.key(b)] == {'rate'}, 'auth evidence was not applied narrowly'
    del h.runs['run-b2']
    count = h.probes
    assert h.start_probe(b) is None, 'invented a probe target'
    assert h.probes == count, 'probe dispatched without a target'
    assert not h.allowed(b), 'absence of a target treated as recovery'
    h.runs['run-b3'] = b
    older = h.start_probe(b)
    h.fail(b, 'rate')
    assert not h.probe_ok(older), 'older episode cleared newer failure'
    assert not h.allowed(b), 'new failure lost to delayed success'
    current = h.start_probe(b)
    assert h.probe_ok(current), 'current probe not accepted'
    assert h.allowed(b), 'valid recovery did not reopen scope'
    assert h.allowed(a), 'recovery harmed unrelated scope'
    return True

check()
tree = ast.parse(open(__file__).read())
case = next(x for x in tree.body if isinstance(x, ast.FunctionDef) and x.name == 'check')
print(json.dumps({'baseline_assertions': sum(isinstance(x, ast.Assert) for x in ast.walk(case))}))
for mutant in ['global', 'stale-ok', 'auth-clears-all', 'invent-target', 'old-epoch-ok']:
    try:
        check(mutant)
    except AssertionError as e:
        print(json.dumps({'mutant': mutant, 'detected': True, 'reason': str(e)}))
    else:
        raise AssertionError('surviving mutant: ' + mutant)
```

Expected output:

```json
{"baseline_assertions": 16}
{"mutant": "global", "detected": true, "reason": "unrelated scope blocked"}
{"mutant": "stale-ok", "detected": true, "reason": "stale run cleared failure"}
{"mutant": "auth-clears-all", "detected": true, "reason": "auth success cleared rate limit"}
{"mutant": "invent-target", "detected": true, "reason": "probe dispatched without a target"}
{"mutant": "old-epoch-ok", "detected": true, "reason": "older episode cleared newer failure"}
```

A further integration test should delay a real adapter's response, change the active credential or endpoint configuration, then deliver the old response. The expected result is an ignored observation with an explicit reason, followed by a fresh decision under the current configuration. This is a suggested test, not a claimed measurement.

## What Operators Should Be Able to Explain

For every suppressed or resumed task, an operator should be able to identify the governing condition, its scope, the observation that changed it, and the next permitted recovery action. “Runtime healthy” is too ambiguous if it hides an account mismatch, an incomplete stream, or a stale execution.

The proposed design accepts slower recovery when no representative evidence is available. That cost is visible and adjustable through an explicit probe policy. Borrowing success from an unrelated path creates a less visible cost: the platform declares recovery without testing the condition that prevented useful work.
