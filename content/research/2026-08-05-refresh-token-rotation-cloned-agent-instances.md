---
date: "2026-08-05"
title: "Refresh-Token Rotation and Reuse Detection in Cloned Agent Instances"
description: "What happens when an AI agent deployment is migrated, forked, or restored from backup while another live instance keeps refreshing the same OAuth session — provider-by-provider rotation semantics, the reuse-detection worst case, and custody patterns that make stale clones fail safe."
tags: ["oauth", "refresh-token-rotation", "agent-fleet", "credential-custody", "migration", "reliability"]
---

## Executive Summary

Migrating an agent to a new machine by copying its data directory feels natural — until the data directory contains a live OAuth session. Subscription-backed credentials (ChatGPT/Codex OAuth, Claude Code OAuth) use **single-use rotating refresh tokens**: every refresh invalidates the old token and issues a new one. The moment a deployment is migrated, forked into a replica, or restored from a backup, two copies of the same rotation chain exist — and only one of them is real.

The consequences depend on provider semantics, and they range from annoying to production-breaking:

- **Best case (most rotating providers):** the stale copy's refresh fails with `invalid_grant` — a clean, local failure that forces re-login.
- **Worst case (strict reuse detection):** the stale copy's refresh is treated as a *credential-theft signal*, and the provider revokes the **entire token family** — killing the live production session because someone revived an old test box.
- **Sneaky case (non-rotating providers, e.g. classic Google offline tokens):** both copies keep working indefinitely, leaving an unmonitored live credential sitting on a forgotten machine.

The fix is architectural, not provider-side: treat OAuth credential files as **single-owner resources with a monotonically advancing version**, never as copyable config. A restored or forked instance should presume its embedded credentials are stale and re-authenticate fresh, rather than gambling a blind refresh against reuse detection.

## The Failure Scenario

The shape of the incident is always the same:

1. An agent service runs on box A, holding an OAuth session (access token + rotating refresh token) in a credentials file.
2. The service is migrated to box B by copying the data directory. Box B goes live and starts refreshing — each refresh supersedes the previous refresh token.
3. Days later, box A's copy is revived — as a rollback test, a staging clone, or a restored backup.
4. Box A's access token has long expired, so its first real use triggers a refresh **with a refresh token that is now an ancestor of box B's live chain**.

Step 4 is where provider semantics decide the blast radius. This is structurally the same bug class as restoring an old database snapshot into a live cluster: the credential file is *data with a version*, and copying it without tracking which version is current is the root cause.

## What the Specs Actually Require

- **RFC 6749** defines refresh tokens but imposes *no* rotation requirement — rotation is authorization-server discretion.
- **RFC 9700** (the OAuth 2.0 Security BCP) is the operative modern standard: refresh tokens for public clients "MUST either be sender-constrained or be subject to refresh token rotation" (§4.14.2). The stated rationale is that rotation converts token theft into a *detectable collision*: if two parties hold the same superseded token, whichever uses it second reveals the compromise.
- **OAuth 2.1** (draft) folds the same must-rotate-or-sender-constrain requirement in. In practice, rotation is what implementers ship; sender-constraining (DPoP/mTLS) remains rare.

Note the framing: rotation-with-reuse-detection is a **security feature**. An ops mistake that replays a superseded token is, by design, indistinguishable from an attack.

## Provider-by-Provider Rotation Semantics

| Provider | Rotates every refresh | Reuse detection | Grace window | On stale-copy refresh |
|---|---|---|---|---|
| Auth0 | Yes (opt-in) | Yes — revokes **entire token family** | Configurable overlap period | Live session dies too |
| Okta | Yes | Yes — invalidates newest refresh + access tokens | 30s default (0–60s) | Live session dies too |
| Microsoft Entra | Old token replaced but not explicitly revoked | Not documented as family revocation | — | Usually tolerated |
| Google (classic offline) | **No** — reusable until revoked or 6 months idle | None (50-token cap per user/client) | — | Both copies stay live |
| GitHub Apps | Yes (opt-in expiring tokens) | Effectively yes | ~8h access / ~6mo refresh | Stale copy fails |
| OpenAI ChatGPT/Codex | **Yes — single-use** | Yes (`refresh_token_reused` / `invalid_grant`) | None documented | First refresher wins; others dead |
| Anthropic Claude Code | Yes — single-use | Yes (`invalid_grant` cascade) | None documented | Stale copy fails; races are a known bug |

Auth0 states the collision property plainly: "if a threat actor and the legitimate application are both using the token, they will inevitably overwrite each other. The first entity to use the token gets a new one, the second… tries to use the already revoked token."

## The Agent-CLI Reality: OpenAI and Anthropic

The two OAuth clients most relevant to agent fleets both document (or have open issues confirming) exactly this failure class.

**OpenAI Codex / ChatGPT OAuth.** Official CI/CD guidance is explicit: *"Use one `auth.json` per runner or per serialized workflow stream. Do not share the same file across concurrent jobs or multiple machines."* The sanctioned pattern is seed-once-then-single-owner: the runner that refreshes must persist the refreshed file back and own the chain from then on. A live instance refreshes frequently (a ~5-minute near-expiry window, matching ChatGPT web's cadence), so over any multi-day window a copied token is superseded many times over. Community incident reports confirm the symptom: copying `auth.json` between machines yields refreshes that appear to run but sessions that stay rejected — "refresh tokens are effectively single-use; once one instance refreshes, other copies become invalid." Even *sibling clients on the same machine* (CLI vs IDE extension sharing one `auth.json`) consume each other's refresh tokens.

**Anthropic Claude Code OAuth.** The exact multi-machine scenario is on record: credentials copied to a second machine hard-fail with a 401 once the access token expires, rather than silently recovering via the refresh token (closed "not planned"). Concurrent sessions on one machine race on refresh — first wins, the rest get `invalid_grant` with no automatic recovery. Anthropic's own workaround, `claude setup-token`, mints a **long-lived non-rotating credential** specifically for headless/multi-instance use — an implicit acknowledgment that the rotating flow is not multi-instance-safe. Worth noting: there is no remote revocation for these CLI tokens; "log out of all sessions" on the web does not touch them, so a forgotten credential on an old box stays live until rotation collides with it.

## Custody Patterns That Actually Work

Fleet tooling and identity-platform engineering converge on the same three-tier picture:

1. **Agent-owns-credential** (tokens in process memory/env/file, each instance refreshes for itself). Fastest to build; produces exactly the box-A/box-B collision plus intra-host races. Multi-agent frameworks have shipped real bugs here — concurrent refreshes clobbering each other's writes, and in one observed case a stale access token silently persisted back into the shared store, causing minutes of silent message drops.
2. **Broker-owns-credential** (an MCP server or sidecar holds the token). Moves the problem out of the agent process, but the same races and stale-copy failures just relocate to the broker.
3. **Vault/custodian-owns-credential** — the pattern that solves the class: exactly **one writer** performs HTTP refreshes; every other consumer waits on a lock and then *adopts* the already-refreshed credential instead of calling the token endpoint itself. N racing refreshes collapse into 1 real refresh + (N−1) cheap re-reads. Revocation is surfaced as an explicit signal (webhook/alert), not a silent failure.

The single-writer rule generalizes directly to migration and restore: **a revived replica should never independently refresh.** It should verify freshness against the custodian — or simply force a fresh interactive login — before its first token-endpoint call, because a blind refresh risks the family-revocation worst case rather than a local failure.

Other systems make instructive contrasts. Tailscale surfaces duplicate node keys as an explicit, named warning rather than an opaque auth error. Kubernetes bootstrap tokens shrink the blast radius by being short-lived and auto-cleaned. Signal's Double Ratchet goes further than detection: single-use message keys make stale-clone replay cryptographically impossible. OAuth rotation sits in the middle — detection after the fact, with the detector unable to tell ops mistakes from attacks.

## Takeaways for Agent-Fleet Operators

1. **Never copy raw OAuth credential files in a migration/backup/fork workflow** without transferring *ownership of the refresh chain*. Treat `auth.json`-class files like a live DB connection, not static config.
2. **Adopt a single-writer/custodian pattern** for any subscription OAuth credential shared across replicas: one refresher, everyone else adopts the result.
3. **Make revived instances fail safe, not fail silent.** On startup after a restore or fork, treat embedded OAuth material as presumptively stale; re-authenticate rather than blind-refresh. The downside of an unnecessary re-login is seconds; the downside of a reuse-detection trip can be a production outage.
4. **Prefer non-rotating, revocation-scoped credentials for fleet/CI use where offered** (long-lived setup tokens, API keys). Rotation's security benefit becomes an ops liability the moment more than one instance can legitimately hold the credential.
5. **Alert on `invalid_grant`/`refresh_token_reused` as a first-class signal.** It is indistinguishable between "stale clone woke up" and "credential theft" — triage it like a security event even when the mundane explanation is likelier, and never auto-retry it into silence.

## Sources

- RFC 6749 — The OAuth 2.0 Authorization Framework: https://datatracker.ietf.org/doc/html/rfc6749
- RFC 9700 — OAuth 2.0 Security Best Current Practice: https://datatracker.ietf.org/doc/rfc9700/
- OAuth 2.1 draft: https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-10
- Auth0 — Refresh Token Rotation / reuse detection: https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation
- Okta — Refresh token rotation and grace period: https://developer.okta.com/docs/guides/refresh-tokens/main/
- Microsoft Entra — Refresh tokens: https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens
- Google Cloud — Token types and lifetimes: https://cloud.google.com/docs/authentication/token-types
- GitHub Apps — Refreshing user access tokens: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens
- OpenAI Codex — CI/CD auth guidance: https://learn.chatgpt.com/docs/auth/ci-cd-auth
- openai/codex issues #15502, #15410, #31459; PRs #17825, #23546
- anthropics/claude-code issues #21765, #25609
- NousResearch/hermes-agent issue #22903 (sibling-client token consumption)
- openclaw/openclaw issue #3611 (multi-agent refresh race)
- Scalekit — Credential ownership patterns for agent tool-calling: https://www.scalekit.com/blog/credential-ownership-agent-tool-calling-patterns
- Tailscale — Key management: https://tailscale.com/blog/tailscale-key-management
- Kubernetes — Bootstrap tokens: https://kubernetes.io/docs/reference/access-authn-authz/bootstrap-tokens/
- Signal — Double Ratchet specification: https://signal.org/docs/specifications/doubleratchet/
