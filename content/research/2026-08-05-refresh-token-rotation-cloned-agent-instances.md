---
date: "2026-08-05"
title: "Refresh-Token Rotation and Reuse Detection in Cloned Agent Instances"
description: "How copied OAuth state can cause refresh failures or token-family revocation, why provider policies differ, and what single-writer custody can and cannot guarantee during migration and recovery."
tags: ["oauth", "refresh-token-rotation", "agent-fleet", "credential-custody", "migration", "reliability"]
---

## Executive Summary

Copying an agent's data directory can copy a live OAuth session along with its configuration. If two instances then use the same rotating refresh token, one may try to redeem a token already consumed by the other. The consequences depend on the provider's token policy, the client implementation, and any allowed reuse interval.

Three outcomes deserve separate treatment:

- **Local rejection:** a stale token fails, requiring that instance to recover or authenticate again.
- **Family revocation:** a provider detects reuse and invalidates descendant refresh tokens too. The active instance may lose the ability to renew its session.
- **Continued duplicate access:** a reusable token can keep both copies working until expiry, revocation, or another policy event. Absence of a rotation error does not prove the old copy is harmless.

Treat rotating credential state as a resource with one refresh owner, not as ordinary replicated configuration. A restored instance should establish whether it owns the current credential before using it. This is engineering guidance for reducing clone-induced failures, not a guarantee against all OAuth outages. Provider documentation below was rechecked on 2026-09-10.

## The Failure Scenario

Consider this **hypothetical** migration:

1. Box A holds an access token and a rotating refresh token.
2. Its data directory is copied to box B. Box B starts serving work and successfully refreshes, persisting a replacement token.
3. Box A is later revived from the old copy.
4. When its client next attempts refresh, it presents an ancestor of box B's current token.

Step 4 can invalidate more than the stale instance under reuse-detection policies. How soon it happens is a client question: access-token expiration, proactive refresh thresholds, and refresh-on-401 are different triggers. Time elapsed since copying is not by itself proof that rotation has occurred.

## What the Specs Require

[RFC 6749 §6](https://datatracker.ietf.org/doc/html/rfc6749#section-6) allows the authorization server to issue a replacement refresh token; it does not require rotation on every refresh. If a new token is issued, the client must replace the old one.

[RFC 9700 §4.14.2](https://datatracker.ietf.org/doc/html/rfc9700#section-4.14.2) requires replay protection for public-client refresh tokens through sender constraint or rotation. With rotation, the server retains the relationship between tokens so reuse can reveal compromise. The server cannot determine which party is legitimate merely from two parties presenting the same bearer credential. A stale operational clone can therefore trigger the same protection as theft.

This does not make rotation a mistake: it changes the operational requirements for ownership, persistence, and recovery.

## Provider Policies: Rotation, Reuse, and Lifetime

A grace interval is the period during which an already-used token may still be accepted. It is distinct from the lifetime of a newly issued access or refresh token.

| Provider and credential type | Documented rotation/reuse behavior | Grace or lifetime details | Clone implication |
|---|---|---|---|
| [Auth0, rotation enabled](https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation) | Reuse detection invalidates the refresh-token family | [Configurable overlap](https://auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-rotation) permits reuse of the immediately previous token; older ancestors still trigger detection | A stale copy can prevent the active instance from obtaining its next access token |
| [Okta, `ROTATE` policy](https://developer.okta.com/docs/guides/refresh-tokens/main/) | Reuse invalidates the newest refresh token and access tokens issued since authentication | Rotation grace defaults to 30 seconds, configurable 0–60; `STATIC` is a separate policy | A stale copy outside the applicable allowance can affect the live session |
| [Microsoft Entra](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens) | Replacement does not itself revoke the old refresh token | Expiration and revocation rules still apply | An older copy can remain usable; replacement is not proof it was disabled |
| [Google, offline refresh tokens](https://developers.google.com/identity/protocols/oauth2#expiration) | Tokens are reusable while valid; expiry and revocation conditions apply | 100 refresh tokens per Google Account per OAuth client ID; another issuance at the limit invalidates the oldest | Both copies may work; issuing more tokens can also invalidate an older one |
| [GitHub Apps, expiring user tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens) | Refresh replaces both tokens; the used refresh token and old access token stop working | Access lifetime: 8 hours; refresh lifetime: 6 months. These are not grace windows | A consumed refresh token cannot be relied on by the clone; this source does not establish Auth0-style family revocation |

For Okta, check the actual application's rotation and lifetime settings; a blanket “all Okta tokens rotate on every refresh” is not a sufficient configuration description. For Google, six months of non-use is one documented invalidation condition, alongside user revocation, token limits, and other policies. “Non-rotating” does not mean permanent.

## Agent CLI Behavior: Documentation Versus Reports

**Codex-managed ChatGPT authentication.** The official [CI/CD authentication guide](https://learn.chatgpt.com/docs/auth/ci-cd-auth) says to give an `auth.json` to one runner or serialized workflow stream and preserve the refreshed file. Its described client checks whether `last_refresh` is older than about eight days, and also refreshes and retries on a 401. That is the guide's current client behavior, not a timeless provider contract or an access-token lifetime. It does not support a five-minute refresh cadence or a count of refreshes inferred from a multi-day interval. The guide applies to Codex-managed ChatGPT auth, not API keys or externally supplied token integrations. Let the supported client manage renewal rather than constructing a separate refresh loop from guessed timing.

**Claude Code interactive OAuth.** Public issue [#21765](https://github.com/anthropics/claude-code/issues/21765) reports copied credentials failing after access-token expiry. Issue [#25609](https://github.com/anthropics/claude-code/issues/25609) reports concurrent refresh races in versions 2.1.39/2.1.41. These are reports of particular environments, not a current server-side contract proving every Claude credential has identical rotation or family-revocation behavior.

**Claude Code setup tokens are a separate path.** The official [authentication documentation](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token) describes `claude setup-token` as generating a one-year OAuth token for `CLAUDE_CODE_OAUTH_TOKEN` in scripts and CI. That supplied token is not the same artifact as an interactive credentials bundle whose refresh token the client rotates. Its expiration and supported revocation procedures must be considered separately; a refresh-chain collision is not its lifetime rule. Local logout, web-session logout, and provider-side revocation of a particular credential are different operations. The cited race reports do not establish that remote revocation is impossible, and this article makes no such claim.

## Credential Custody and Its Limits

These patterns are an engineering synthesis, not a benchmarked comparison of production systems:

1. **Each process owns a separate credential.** This can isolate refresh chains if the provider supports independently issued sessions. Copying the same credential into each process defeats that separation.
2. **A broker holds a shared credential.** Consumers request service through it. Multiple broker replicas still need coordination; moving the file does not resolve ownership.
3. **One custodian serializes refreshes.** Within a controlled deployment, one writer refreshes and durably publishes the result. Waiting consumers re-read the state and reuse the refreshed result when valid, instead of immediately issuing another refresh. Ownership must hold across machines and failover, not only within one process.

The third pattern reduces concurrent refresh races, but **does not make refresh plus persistence an atomic transaction with the provider**. If the provider rotates successfully and the response is lost, the sole writer may still possess only the old token. A crash before durable persistence has the same consequence. Recovery needs a provider-supported retry allowance or another documented recovery path; where that cannot establish safe state, stop automatic refresh and obtain fresh authorization. Never assume a local lock makes blind replay safe.

Similarly, an old backup containing both credential state and a local “I am the owner” flag is not proof of current ownership. Verify against a current authority or require a new session before activating a restored clone.

Signal's [Double Ratchet specification](https://signal.org/docs/specifications/doubleratchet/) illustrates why state matters: receive processing advances state and deletes a consumed skipped-message key. Restoring a snapshot can restore the secrets that deletion was meant to remove. The protocol therefore must not be cited as making stale-clone replay cryptographically impossible after rollback. Any replay claim must account for whether the receiver preserved its advanced state.

## Takeaways for Agent-Fleet Operators

1. Inventory the **credential type and policy**, not just the vendor. Record whether it rotates, who owns refresh, how replacement is persisted, and how that credential is revoked.
2. During migration, establish one active refresh owner before enabling the destination. Prefer independent credentials for independent deployments where supported.
3. Fence restored instances from token refresh until current ownership and state are established. A reauthentication requirement is a visible recovery cost; a blind refresh can affect another instance.
4. Use the provider's documented automation authentication path and evaluate its scope, lifetime, and revocation behavior. Long-lived bearer tokens reduce some renewal work while increasing the consequences of an exposed copy.
5. Treat refresh rejection as an actionable fault. `invalid_grant` can have several causes, so it alone is not proof of theft or clone reuse. Stop uncontrolled retry loops, inspect the provider's specific error and audit events, and recover through its supported flow.
