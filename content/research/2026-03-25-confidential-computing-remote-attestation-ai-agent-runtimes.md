---
date: "2026-03-25"
title: "Confidential Computing and Remote Attestation for AI Agent Runtimes"
description: "A practical architecture guide for using TEE attestation (RATS/EAT) to gate secrets, tool authority, and workload trust in production AI agent systems across AWS, Azure, GCP, and Confidential Containers."
tags:
  - ai-agents
  - confidential-computing
  - remote-attestation
  - security
  - tee
  - rats
  - eat
  - runtime-architecture
---

## Executive Summary

- Confidential computing without attestation is incomplete. TEEs protect data-in-use, but attestation is what lets a relying party prove the workload and platform are trustworthy *before* releasing secrets or high-risk permissions.
- The IETF RATS model has matured into a practical interoperability layer: **Attester** produces evidence, **Verifier** appraises it, and **Relying Party** makes an authorization decision. This separates trust evaluation from application logic and maps cleanly to agent runtime control planes.
- EAT (RFC 9711, April 2025) provides a standardized claims container for attestation results. Claims like `eat_nonce`, `dbgstat`, and nested `submods` support replay resistance, debug-state gating, and layered components.
- Cloud implementations are converging on the same pattern with different mechanics:
  - AWS Nitro Enclaves binds KMS access to measured PCR values via signed attestation documents.
  - Azure Attestation evaluates enclave evidence against policy and returns signed tokens, with verification material discoverable via OpenID metadata.
  - Google Cloud Attestation exposes RATS/EAT-aligned claims and supports OIDC-style or PKI-style verification paths.
- For AI agent systems, the highest-leverage pattern is: **Attestation-verified identity -> policy evaluation -> scoped secret/tool release**. This should gate model keys, outbound credentials, and privileged tools at runtime, not just at deploy time.

---

## Why This Matters for Agent Runtimes

Most production agent systems have already adopted some isolation controls (sandboxing, scoped filesystems, separate worker processes). But many still perform secret provisioning with static trust assumptions: if a process is "the worker," it receives credentials.

That approach breaks down in three common scenarios:

1. **Compromised host or orchestrator path:** The worker process is alive but running in an untrusted configuration.
2. **Configuration drift:** Debug mode, insecure boot, or image mismatch changes the trust posture silently.
3. **Cross-domain delegation:** A downstream service (KMS, API gateway, partner agent) must decide trust remotely and independently.

Remote attestation exists to solve these exact problems.

---

## The RATS Model: Roles Before Tools

RFC 9334 defines a role-based architecture for remote attestation rather than a single protocol. The core entities are:

- **Attester**: Produces evidence about its own state
- **Verifier**: Appraises evidence under policy and emits attestation results
- **Relying Party**: Uses attestation results to make access decisions

It also defines two important topological patterns:

- **Passport Model**: Attester obtains attestation results and presents them to relying parties
- **Background-Check Model**: Relying party consults verifier directly

This abstraction is useful for agent architectures because you can decide trust boundaries explicitly:

- "Session/Governor" components typically behave as relying parties.
- TEE-capable executors behave as attesters.
- A dedicated attestation service (internal or cloud-managed) acts as verifier.

Design implication: do not couple verifier logic into each tool adapter. Treat verifier as a control-plane primitive.

---

## EAT as the Claims Contract

RFC 9711 (April 2025) standardizes the Entity Attestation Token (EAT) as a claims set for attestation, encoded as CWT or JWT.

Key properties relevant to agent runtimes:

- **Claim extensibility**: platform-specific and workload-specific claims can coexist.
- **`eat_nonce` semantics**: supports replay protection; RFC 9711 defines entropy and size constraints.
- **`submods` support**: nested claim sets for layered/composite systems.

This matters operationally: instead of vendor-specific ad hoc payload parsing in every service, runtimes can normalize around EAT-like claim handling and only specialize on platform-specific claim subsets.

---

## Cloud Implementation Patterns

### AWS Nitro Enclaves

AWS documents a direct policy-binding model:

- Enclave requests a signed attestation document from Nitro Hypervisor.
- External service validates enclave measurements against policy.
- AWS KMS can ingest attestation docs and gate sensitive operations.

Nitro measurements include PCR values tied to image, kernel/bootstrap, and parent-instance context. AWS also notes that enclaves launched in debug/attach-console mode produce all-zero PCR values, which is a clear policy deny signal in production.

Practical takeaway: a good baseline policy is to deny secret release when PCRs indicate debug posture or measurement mismatch.

### Azure Attestation

Azure Attestation supports multiple TEE environments (TPM, SGX, VBS enclaves), evaluates evidence against customer policy, and returns signed tokens to relying parties.

Two platform-level details are useful for runtime engineers:

- Azure explicitly pushes quote validation, policy evaluation, and token signing into a TEE path to reduce trusted surface.
- Verification material is exposed through OpenID metadata endpoints, enabling verifier-key rotation without brittle key pinning in each client.

Practical takeaway: use OIDC discovery + key rotation aware verifiers for attestation tokens; do not hardcode long-lived signing keys.

### Google Cloud Attestation

Google describes a unified attestation service across Confidential VM/Space/GKE nodes, with explicit RATS role mapping and EAT-aligned claims output.

Notable operational features:

- Claims can be validated using either public-key OIDC-style flow or PKI-style path (supports offline scenarios).
- Token claims include fields such as `hwmodel`, `eat_nonce`, `exp`, `iss`, and debug/security boot related posture fields.
- Reference values and endorsements are managed centrally by the service, reducing verifier complexity for consumers.

Practical takeaway: for agent gateways and key brokers, OIDC mode is easiest for online services; PKI mode is useful for isolated or regulated environments.

---

## Hardware/TEE-Specific Notes

### Intel TDX

Linux kernel documentation describes TDX attestation in two phases:

1. TDREPORT generation
2. Quote generation

Measurements include build/runtime registers (MRTD/RTMR), and TDREPORT incorporates user-provided report data (typically nonce/challenge material). This maps well to challenge-based freshness checks in secret-release workflows.

### AMD SEV-SNP

AMD positions SEV-SNP as adding memory integrity protections against replay/remap-style hypervisor attacks and supporting guest attestation.

AMD’s attestation ecosystem also includes VCEK certificate and KDS interfaces, and deployment guides (e.g., VirTEE/SEV flows) that show both standard and extended attestation paths with certificate chain handling.

### GPU Attestation (NVIDIA)

NVIDIA’s Attestation Suite (NRAS, RIM, OCSP) extends trust establishment to GPU infrastructure, not just CPU enclave state.

For agent workloads with confidential inference/training, this closes a common gap: CPU TEE attestation alone does not prove accelerator firmware/stack trust. If sensitive model material or inputs touch GPU memory, GPU attestation should be part of the relying-party policy.

---

## Open Runtime Integration Pattern

Confidential Containers + Trustee documentation provides a concrete composable pattern:

- Guest-side attestation agent collects evidence.
- Key Broker Service (KBS) validates via attestation service against reference values.
- Secrets are conditionally released only after successful appraisal.

This architecture is directly portable to agent runtimes:

1. **Executor startup**: collect TEE evidence.
2. **Verifier call**: obtain signed attestation result token.
3. **Governor policy check**: evaluate result + workload policy (tenant, task class, debug posture, expiry).
4. **Capability issuance**: release short-lived secrets/tool scopes.
5. **Continuous checks**: re-attest on lease renewal, not only at boot.

---

## Recommended Policy Model for AI Agents

A practical minimum policy for production:

- **Freshness**: require nonce-bound attestations and strict `exp` handling.
- **Debug posture**: reject debug-enabled environments for privileged tasks.
- **Measurement binding**: allowlist image/firmware measurements for specific runtime roles.
- **Identity binding**: bind attested identity to workload/service account identity before issuing credentials.
- **Scope minimization**: secret/tool leases should be task-scoped and time-bound.
- **Re-attestation triggers**: renew secrets only if attestation remains valid; force re-attestation after runtime restart, policy change, or long idle windows.

Inference from the sources: the best reliability/security tradeoff is to treat attestation as a *continuous authorization input*, not a one-time bootstrap ceremony.

---

## Anti-Patterns

- **"Attested once at deploy"** and then unlimited credential reuse.
- **Verifier bypass paths** for emergency modes that become permanent defaults.
- **Ignoring debug indicators** (`dbgstat`, zeroed measurements, debug boot).
- **No nonce/freshness discipline**, enabling replay of stale but validly signed artifacts.
- **Hardcoding verifier keys** instead of consuming published metadata/PKI rotation.

---

## Adoption Roadmap (30/60/90)

### 30 days

- Identify all secret release points in the agent runtime (model keys, external API credentials, signing keys).
- Introduce verifier abstraction and attestation result parsing.
- Enforce freshness (`nonce`, `exp`) on one high-risk secret path.

### 60 days

- Expand policy to debug/measurement posture checks.
- Bind attestation result to workload identity and task class.
- Add observability for attestation failures by reason code.

### 90 days

- Move to default-deny for privileged operations without valid attestation.
- Add periodic re-attestation on lease renewal.
- Include accelerator attestation checks where GPU trust is in scope.

---

## Closing

The ecosystem has reached a useful inflection point: standards (RATS/EAT) and managed services (AWS/Azure/GCP) are now mature enough that remote attestation can be treated as a normal control-plane building block, not bespoke cryptography work.

For AI agent platforms, this is strategically important. Agent systems increasingly combine autonomous decisions, mutable execution chains, and access to powerful external tools. The question is no longer "can the agent do the task"; it is also "can we prove this exact runtime context is trustworthy before we let it act." Attestation is the missing link that makes that proof operational.

---

## References

- RFC 9334: Remote ATtestation procedureS (RATS) Architecture (IETF)
  - https://www.rfc-editor.org/rfc/rfc9334
- RFC 9711: The Entity Attestation Token (EAT) (IETF, April 2025)
  - https://www.rfc-editor.org/rfc/rfc9711
- AWS Nitro Enclaves: Cryptographic attestation
  - https://docs.aws.amazon.com/enclaves/latest/user/set-up-attestation.html
- Intel TDX in Linux kernel docs (attestation section)
  - https://www.kernel.org/doc/html/latest/arch/x86/tdx.html
- Azure Attestation overview
  - https://learn.microsoft.com/en-us/azure/attestation/overview
- Google Cloud Attestation
  - https://cloud.google.com/confidential-computing/docs/attestation
- Google Confidential VM token claims
  - https://cloud.google.com/confidential-computing/confidential-vm/docs/token-claims
- AMD Secure Encrypted Virtualization (SEV) developer docs
  - https://www.amd.com/en/developer/sev.html
- AMD SEV-SNP Platform Attestation Using VirTEE/SEV
  - https://www.amd.com/content/dam/amd/en/documents/developer/58217-epyc-9004-ug-platform-attestation-using-virtee-snp.pdf
- Confidential Containers: Attestation with Trustee
  - https://confidentialcontainers.org/docs/attestation/
- Confidential Containers: Design overview (attestation flow)
  - https://confidentialcontainers.org/docs/architecture/design-overview/
- NVIDIA Attestation Suite docs
  - https://docs.nvidia.com/attestation/index.html
