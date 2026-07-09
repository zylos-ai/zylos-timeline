---
date: "2026-07-09"
title: "Lightweight Agent Runtime Containers: Sharing Platform Infrastructure While Isolating Agent State"
description: "Design patterns for containerizing AI agent runtimes — what to isolate, what to share, and how to manage state, communication, and lifecycle in multi-agent fleets."
tags: ["ai-agents", "containers", "infrastructure", "multi-agent", "devops"]
---

## Executive Summary

A fleet of AI agents — each with its own name, memory, and communication channels — looks at first like a fleet of small applications, so the instinct is to give each one everything: its own OS user, its own copy of every service, its own full deployment. That instinct doesn't survive contact with agent number ten. The industry's converging answer, visible across Microsoft's new Execution Containers, Amazon Bedrock AgentCore, OpenHands' runtime split, and the sandbox architectures Anthropic and OpenAI shipped within days of each other in 2026, is to draw a much tighter boundary: the container holds only the agent runtime, its identity, and its session state. Everything expensive and shared — message routing, scheduling, databases, reverse proxies, observability — stays on the host and is multiplexed across every agent through tenant-scoped addressing. This article works through the five design questions that determine whether that boundary holds up in production: what belongs inside the container, how state survives restarts and upgrades, how messages find the right agent on a shared bus, how CPU/memory/cost gets attributed per agent, and how the container's lifecycle (mint, suspend, wake, monitor) stays fast enough to feel instant.

## The Problem With "One Agent, One Full Stack"

The naive approach — an OS-level user account per agent, each running its own copy of the runtime, its own database, its own web server — fails for reasons that are boring but decisive: it doesn't fit in memory, it takes many manual steps to provision, and it makes upgrades an N-times-repeated chore instead of a single rollout. Every gigabyte-plus stack is mostly the *same* gigabyte, copied. The two resources that actually differ per agent are small: identity (name, personality, credentials) and state (what happened so far). Everything else — the process that routes an inbound Telegram message to the right handler, the cron-like scheduler, the file server, the metrics pipeline — is infrastructure that doesn't care which agent it's serving. Recognizing that split is the whole design problem.

## Container Boundary Design: What Goes In, What Stays Out

### Inside the container: runtime, identity, session

Across every production pattern surveyed, the container payload converges on three things: the agent runtime process itself (the loop that calls the model, applies tools, and produces actions), an identity bundle (system prompt/personality file, credentials scoped to that agent, any fine-tuned config), and *live* session state (in-flight conversation buffer, working memory, scratch files for the current task). Nothing else needs to be duplicated per container.

Microsoft's Execution Containers (MXC), announced at Build 2026, formalize identity as a first-class container attribute rather than an application concern: each agent session is assigned either a local Windows identity or a cloud-provisioned Entra identity, and every file access or process action the agent takes is attributed to *that* identity rather than to the human user running the machine — the agent shows up as its own principal in Task Manager and in Defender's threat telemetry. That's the identity-in-container pattern taken to its logical conclusion: the container boundary and the identity boundary are the same boundary, enforced by the OS, not by application code.

OpenHands demonstrates the shared-service split from the other direction — a controller/sandbox architecture where a persistent controller process (Python server) owns the agent loop, LLM abstraction, and lifecycle coordination, while a Docker container is spawned per task purely as an execution sandbox that receives actions over a REST API and returns observations. The controller — the expensive, stateful, long-lived thing — lives outside the disposable per-task container. Only the sandboxed execution surface is duplicated.

### Outside the container: the sidecar / credential-proxy pattern

The piece that recurs most consistently in multi-tenant agent designs is a sidecar that mediates *all* outbound traffic so the agent container itself never holds raw secrets. In one documented pattern, an agent container has no outbound network access except to a sidecar reachable only over loopback; the sidecar injects authentication, forwards the request to the real service, and strips auth metadata on the way back, so a compromised or misbehaving agent process can't exfiltrate credentials even if it tries. A variant holds credentials in a sidecar running alongside each agent worker pod, proxying authenticated calls to external services rather than handing keys to the worker at all.

This maps directly onto the "shared platform, isolated agent" split: the sidecar (or, at fleet scale, a single shared gateway process) *is* the shared infrastructure — message routing, credential handling, external API access — while the container next to it is just the reasoning loop plus that agent's own memory. Anthropic's own May 2026 sandbox release adopts a similarly explicit five-component decomposition — Harness, Tools, Session, Sandbox, Orchestration — that moves the execution plane inside the customer's own perimeter while keeping orchestration and auth outside the sandbox boundary. OpenAI's parallel move — decoupling a "Harness" (control flow, memory, tool routing) from a "Compute" layer of isolated sandboxes for file I/O and code execution — makes the same argument from the opposite direction: OpenAI's own guidance states plainly that running the harness *inside* the sandbox is fine for a prototype but wrong for production, because it collapses the trust boundary and lets model-controlled filesystem access reach orchestration, auth, or recovery state. Whatever you call the pieces, the boundary is the same: reasoning and execution stay in the small, disposable container; routing, auth, and orchestration stay on the host.

### Docker vs. Podman notes

None of the surveyed patterns are Docker-specific in principle — Podman's rootless-by-default model and lack of a central daemon are a natural fit for the "many small per-agent containers on one host" shape, since a compromised agent container doesn't inherit a root daemon socket. But the ecosystem tooling (OpenHands' runtime client, most sidecar proxy examples, firecracker-containerd) is documented and battle-tested primarily against Docker/containerd, which is the pragmatic default unless rootless isolation is a hard requirement.

## State Management Across Restarts and Upgrades

### Volume-mounted state directories

The simplest pattern, and the one most agent frameworks land on, is a single well-known directory inside the container — mounted from a host volume — that holds everything the agent needs to survive a restart: memory files, session history, per-skill data. Agent Zero, for example, isolates all user-modifiable data under `/a0/usr` inside the container and volume-mounts that path to the host, so users "can preserve their data independently of container lifecycle events." The container itself becomes fully disposable — kill it, rebuild the image, start a new one — because nothing that matters lived inside the container filesystem in the first place. This is the direct analogue of the identity/state split argued above: the container image is pure runtime; the volume is pure state.

### External state stores vs. stateful containers

Volume mounts work well for a single host but don't survive a host failure or support horizontal scaling. The alternative is pushing state into an external store — Redis for hot session state, a StatefulSet-with-attached-storage pattern in Kubernetes so the same agent session always lands on the same pod, or a durable database for long-term memory. A useful mental model that recurs in the literature: stateless agents "treat every interaction like a stranger's first conversation, answering then forgetting" — which is fine for a single tool call, but wrong for anything that needs to remember a user across sessions. The practical takeaway for a fleet: treat conversation memory as durable data that lives in a shared database keyed by agent ID, not as container filesystem state — the container should be rebuildable from zero at any time without data loss, with the volume mount (or external store) as the only thing that needs to persist.

### Snapshot-restore as a third option

A third pattern, borrowed from serverless infrastructure, sidesteps the volume-vs-database choice for *fast* restarts specifically: snapshot the running container/microVM's full memory and disk state, then resume new instances from that snapshot instead of cold-booting. AWS Lambda's MicroVM-based sandboxes do exactly this — a running microVM retains memory, disk, and running processes across a session, can be suspended with state intact during idle periods, and resumed near-instantly when traffic arrives. Applied to an agent fleet, this means an idle agent's container doesn't have to be torn down and state reloaded from a database on next contact — it can be frozen and thawed, which is both faster and simpler than a save/restore protocol.

## Inter-Agent Communication on a Shared Message Bus

### The addressing problem

Once N agents share one Telegram bot process, one Lark integration, or one webhook receiver, every inbound message needs to resolve to exactly one agent instance. This is the same problem multi-tenant SaaS webhook systems solve, and the failure mode is well documented: without an explicit addressing scheme, "webhooks currently always route to the default agent regardless of session configuration, with no way to route different webhook paths to different agents." The fix pattern is consistent across the systems surveyed: attach a `tenant_id` (or `agent_id`) at the point messages enter the system — on the endpoint, on the event, or on the session key — and use it for routing everywhere downstream, monitoring included.

### Gateway/proxy routing to per-agent containers

Layered on top of tenant-ID addressing is a routing tier — effectively an API gateway — that owns the mapping from tenant ID to the specific container/process instance currently serving that agent, and that slices latency and error monitoring by tenant so one noisy agent doesn't hide in aggregate metrics. This gateway is itself shared infrastructure — one reverse proxy in front of many agent containers — and is a natural place to also enforce per-agent rate limits and to log which agent handled which request for audit purposes.

### Isolation even on a shared bus

Some multi-tenant deployments go further and give each tenant a fully separate resource set behind the same gateway — "every tenant gets their own Pod with all their resources completely isolated from other pods" in one email-agent platform's design — trading some infrastructure sharing for stronger blast-radius containment. Whether to go this far is a cost/isolation trade-off: a shared runtime process serving all tenants is cheaper and simpler operationally but requires airtight in-process tenant-context propagation, while dedicated per-tenant runtimes cost more but make cross-tenant leakage structurally harder.

## Resource Isolation and Cost Attribution

### cgroups v2 as the enforcement primitive

Every container resource limit — Docker's `--memory`, Kubernetes' resource requests/limits, systemd's `MemoryMax=` — ultimately compiles down to Linux cgroups v2, the unified hierarchy that has been the default since kernel 5.x. Two files matter most for an agent container: `cpu.max`, which accepts a `quota period` pair in microseconds (e.g., `echo "500000 1000000" > cpu.max` caps a cgroup at 50% of one core), and `memory.max`/`memory.high` — a hard OOM-triggering ceiling and a soft "start reclaiming aggressively" threshold, respectively. Pressure Stall Information files (`cpu.pressure`, `memory.pressure`, `io.pressure`) add a second axis: not just "did the agent hit its cap" but "how much time did it spend stalled waiting for a resource," which is a better early-warning signal than raw utilization for deciding whether an agent's budget needs to grow.

### Per-agent budgets and cost attribution

Because every agent container is tagged with a cgroup and (in the addressing scheme above) a tenant/agent ID, the same labels that route messages can drive cost attribution: CPU-seconds and memory-seconds consumed per cgroup, joined against agent ID, produce a per-agent cost line without any extra instrumentation inside the agent process itself. Kubernetes formalizes this at the pod level through `resources.requests`/`resources.limits`, letting an operator give every agent pod a guaranteed floor and a hard ceiling simultaneously.

### GPU sharing

For agents that need local inference or embedding compute rather than pure API calls, GPU budgets are the harder problem — GPUs don't natively support the same fine-grained time-slicing as `cpu.max`. In practice this pushes fleets toward either (a) no local GPU at all, with agents calling out to a shared inference service, which sidesteps per-container GPU isolation entirely, or (b) MIG/vGPU-style hard partitioning where the sharing granularity is much coarser than CPU/memory. Given the platform-services-are-shared theme running through this whole design, routing agent inference calls to one shared, appropriately-scaled inference service — rather than giving every agent container its own GPU slice — is the pattern most consistent with the rest of the architecture.

## Lifecycle Management: Mint, Suspend, Wake, Monitor

### Fast mint via snapshot-restore

A cold-boot Linux container is not slow by conventional standards, but "fast" for an agent fleet increasingly means sub-30-second and ideally sub-second. Firecracker microVMs, the isolation layer underneath AWS Lambda and Fargate, boot cold in under 125ms per the original NSDI '20 paper, and with snapshot-restore — resuming a suspended VM's memory and disk image rather than booting fresh — that drops to roughly 28ms. `firecracker-containerd` lets containerd manage Firecracker microVMs directly, so the same container image and orchestration tooling used for ordinary Docker containers can target microVM isolation without a parallel toolchain. For a fleet where "mint a new avatar" needs to feel instantaneous to the person requesting it, snapshot-restore is the mechanism that gets there — pre-warm a snapshot of "runtime booted, waiting for identity file," and minting an agent becomes "resume snapshot, inject identity, done."

### Graceful shutdown and on-demand wake

The suspend/resume mechanics above double as the idle-agent story: rather than tearing an idle agent's container down and paying full cold-boot cost on its next message, suspend it with memory and disk state intact and resume when a message arrives. This is strictly better than the "start fresh, reload state from the database" pattern for agents that are idle for minutes-to-hours rather than days, since it avoids both the boot cost and the state-reload round trip. For agents idle long enough that holding a suspended snapshot in memory isn't worth it, falling back to full teardown with state flushed to the volume/database (the pattern from the State Management section) is the right escalation.

### Health monitoring

Because the shared platform — not the agent container — owns message routing and scheduling, the natural place for liveness/health monitoring is also the shared layer: a heartbeat or watchdog process on the host side that tracks whether each agent container is responsive, restarts it on failure, and reports gaps without needing any agent-specific logic. This is the same principle as the sidecar pattern applied to observability instead of credentials — one shared component watching many disposable containers, rather than N copies of a monitoring stack.

## Real-World Examples

**OpenHands** demonstrates the controller/sandbox split cleanly: a persistent controller manages the agent loop and LLM calls while a Docker container is spawned per task purely for sandboxed code execution, communicating over a REST API.

**Amazon Bedrock AgentCore** takes the container-per-agent-identity approach at cloud scale: agent implementations are containerized, stored in ECR, and deployed to AgentCore Runtime, wired to AgentCore Identity for credential scoping — the AWS-native version of the "identity travels with the container, everything else is a managed service" pattern.

**Microsoft Execution Containers (MXC)**, shipping in Windows and WSL, push identity-per-container down to the OS level: each agent session gets its own local or Entra-backed identity, with process isolation restricting file/network access and session isolation walling the agent off from the human user's desktop, clipboard, and input devices.

**Anthropic's self-hosted sandbox architecture and OpenAI's Harness/Compute split**, both shipped within about a week of each other in 2026, converge on the same conclusion from different vendors: orchestration, auth, and control flow belong outside the sandboxed execution boundary, not inside it.

## Applying This to a Zylos-Style Fleet

Mapped onto a system like Zylos, the boundary this research points to is narrow and specific. Inside each agent's container: the runtime process, the identity bundle (name, personality file, model config, scoped credentials), and the active session buffer. Everything else — the C4 message router that currently dispatches Telegram/Lark/WeChat messages, the C5 scheduler, the shared reverse proxy and web hosting, the observability/dashboard layer, and the durable memory store — stays on the host as shared infrastructure, addressed per-agent via a tenant ID carried on every message, exactly as the webhook-dispatcher and API-gateway patterns above describe. Long-term memory (identity.md, state.md, reference/ files) is the volume-mounted or externally-stored state that must survive container rebuilds; it should never live only inside a container's ephemeral filesystem. And the 12-manual-step, full-OS-user-per-agent deploy that doesn't scale collapses, in this model, into: mint a container from a pre-warmed runtime image (or snapshot), inject an identity bundle, mount or point at the agent's state volume, and register its tenant ID with the shared router and scheduler — a handful of automatable steps instead of twelve manual ones, and a memory footprint measured in the runtime process plus session state rather than a full duplicated stack per agent.

## Conclusion

The pattern this research converges on — small, disposable, identity-bearing containers around a durable agent loop, wrapped by shared platform services addressed through per-agent tenant IDs — isn't unique to any one vendor; it's the same shape independently arrived at by OpenHands' engineering team, AWS's AgentCore designers, Microsoft's Windows platform group, and Anthropic and OpenAI's sandbox architects within the same few months of 2026. The common thread across all of them is a refusal to duplicate anything that doesn't need duplicating: message routing, scheduling, databases, and reverse proxies are platform services that scale sublinearly with agent count when shared correctly, while identity and state are the only things that must be per-agent — and even those don't need to live inside the container itself, just addressable from it. Building a fleet on this boundary is what turns "one more agent" from a fresh deployment project into a container mint that takes seconds.
