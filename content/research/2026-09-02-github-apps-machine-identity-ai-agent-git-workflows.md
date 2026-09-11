---
date: "2026-09-02"
title: "GitHub Apps as Machine Identities for AI Agent Git Workflows"
description: "How autonomous coding agents should authenticate to GitHub — comparing PATs, machine users, deploy keys, App installation tokens, and OIDC; commit attribution mechanics for bot identities; industry practice from Copilot to Devin; and the contested conventions for marking AI-authored commits."
tags: ["github-apps", "machine-identity", "installation-tokens", "commit-attribution", "ai-agents", "security", "provenance"]
---

## Executive Summary

As AI coding agents move from suggesting diffs to autonomously cloning repositories, writing commits, and opening pull requests, the question of *how an agent authenticates to GitHub* has become a first-class security and governance decision, not an implementation afterthought. Five access patterns recur in machine-driven Git workflows — personal access tokens (classic and fine-grained), dedicated "machine user" accounts, deploy keys, GitHub App installations, and outward OIDC federation — and each carries different guarantees around scoping granularity, credential lifetime, attribution, rate limits, licensing, and auditability.

For agents that write code across repositories on an ongoing basis, the strongest default is **a GitHub App installation that mints short-lived (one-hour) installation access tokens server-side and acts through a distinct `<slug>[bot]` identity.** GitHub Copilot cloud agent, Cursor Cloud Agents, Claude Code Action's default GitHub connection, and Renovate's documented App deployment all demonstrate parts of this pattern. Personal access tokens remain useful for developer tooling and for API gaps that fine-grained tokens do not yet cover, but unattended automation should avoid tying broad, long-lived credentials to a human account. OIDC federation addresses the adjacent problem: letting a workflow reach clouds or supported registries without storing a second long-lived credential.

This report surveys the identity landscape, the mechanics of GitHub App token minting and commit attribution, how today's major AI coding agents implement (or fail to implement) clean machine identities, the security failure modes specific to bot-driven git workflows, and the nascent — and contested — conventions emerging for marking AI-authored commits (`Co-Authored-By`, `Assisted-by`, and proposals for dedicated provenance trailers).

## Identity Models on GitHub: A Comparative Landscape

GitHub recognizes several distinct ways for a non-interactive actor to authenticate and take action, and they are not interchangeable — each was designed for a different trust relationship.

**Personal access tokens (classic).** Classic PATs (prefix `ghp_`) are bearer credentials using broad OAuth-style scopes (`repo`, `workflow`, `admin:org`, etc.). Subject to organization authorization controls, a token with `repo` scope can reach repositories that its issuing user can access, so its blast radius follows that human account. Expiration is optional unless an organization or enterprise policy requires it. GitHub recommends fine-grained PATs whenever possible, while documenting remaining gaps — including multi-organization access, Packages, and the Checks API — where classic PATs may still be necessary.

**Personal access tokens (fine-grained).** Fine-grained PATs let the issuer select one resource owner, optionally restrict the token to specific repositories, and grant individual repository, organization, and account permissions. GitHub's creation flow accepts an expiry from 1 to 366 days or no expiration; an organization or enterprise policy can impose a shorter maximum. A user can create up to 50 fine-grained PATs. This materially reduces blast radius, but the token remains tied to a human account and must still be governed and rotated by the operator.

**Deploy keys.** An SSH key pair registered against a single repository, optionally read-only. Deploy keys authorize Git access over SSH to that repository; API operations such as opening PRs, commenting, or managing checks need a separate API credential. They are therefore a narrow, low-blast-radius option for single-repo pull/push automation. Deploy keys do not expire and must be manually revoked.

**Machine user accounts ("bot accounts").** A machine account is a regular GitHub account created by a human who accepts responsibility for its automated actions. It gives automation a stable identity separate from an engineer, but authentication still relies on that account's PAT or SSH key and its repository grants. GitHub's general Terms permit one free machine account in addition to a free personal account; paid organizations count the account when it occupies a member or private-repository collaborator seat. The legacy Corporate Terms additionally define a Machine Account as a `User` covered by a Subscription License. The result is a conventional collaborator identity with manual credential lifecycle, rather than an installation-scoped integration identity.

**GitHub App installations.** A GitHub App is registered independently of any user, with declared permissions and webhook subscriptions. An owner installs it on an organization or selected repositories, and actions performed with an installation token are associated with the app's `<slug>[bot]` identity. The app proves its identity with a short-lived JWT signed by its private key, then exchanges that JWT for an **installation access token that expires after one hour.** The token-mint request can further restrict the token to a subset of installed repositories and permissions. GitHub's May 2026 `X-GitHub-Stateless-S2S-Token` header changes only whether the returned token uses the newer stateless JWT format or the older opaque format; it does not add another permission boundary.

**OIDC federation.** OIDC is not a GitHub-side credential for authenticating *to* GitHub. It lets a GitHub Actions job authenticate *outward* without storing a long-lived cloud credential. GitHub generates a JWT unique to the workflow job; the remote provider evaluates claims such as repository, ref, workflow, run ID, and run attempt, then issues credentials under its own lifetime policy. Dependabot update jobs also support OIDC for private registries hosted on AWS CodeArtifact, Azure DevOps Artifacts, or JFrog Artifactory. GitHub Apps therefore solve "into GitHub," while OIDC solves "out to a federated service."

### Comparison Table

| Dimension | Classic PAT | Fine-grained PAT | Deploy Key | Machine User Account | GitHub App Installation Token | OIDC Federation |
|---|---|---|---|---|---|---|
| Scoping granularity | Broad OAuth scopes across resources visible to the user | One resource owner, selected repos, granular permissions | Single repo, read or read-write | Whatever the account is granted (collaborator/team) | Installation selection + App permissions; token mint can request a narrower subset | Unique per workflow job; external trust policy evaluates claims |
| Credential lifetime | Optional expiry unless policy requires one | 1–366 days or no expiry; policy may shorten | Indefinite until revoked | Depends on the account's PAT/SSH key | 1 hour (installation token); App private keys do not expire and require manual rotation | OIDC token is job-scoped; exchanged credential follows provider policy |
| Authenticated API actor | Issuing human account | Issuing human account | N/A; SSH credential only | Machine-account username | `<slug>[bot]` App identity | N/A (not a GitHub-side identity) |
| API access | Endpoints allowed by OAuth scopes and account access | Supported endpoints allowed by granular permissions and account access | None (git only) | Endpoints allowed by its credential and account access | Installation-token endpoints allowed by App permissions and repository selection | N/A — federates to external systems |
| Primary API limit | REST: 5,000 requests/hr; GraphQL: 5,000 points/hr | Same user buckets as classic PAT | N/A | Same user buckets as its credential | REST: 5,000–12,500 requests/hr, or 15,000 on GHEC; GraphQL: 5,000–12,500 points/hr, or 10,000 on GHEC | N/A |
| Licensing/seat cost | No additional seat beyond the issuing user | Same | None | Can consume a member/collaborator seat on paid organizations | No seat consumed | N/A |
| Renewal/rotation | Manual | Manual | Manual | Depends on its PAT/SSH key | Token expires and is re-minted; App private-key rotation remains manual | A fresh token is requested per job; external credential policy varies |
| Best fit | APIs not yet covered by fine-grained PATs; bounded legacy automation | Individual developer tooling and bounded scripts | Single-repo CD pull, no API needs | Integrations that truly require a regular collaborator identity | Unattended, multi-repo production automation | Workflow reaching federated clouds or supported registries |

## How GitHub Apps Attribute Commits and Pull Requests

GitHub represents an App in user-facing activity through a **bot account** named `<app-slug>[bot]`. That account has a numeric user ID distinct from the App ID in the App settings. Keeping those two identifiers separate matters when configuring commit attribution.

**The noreply email format.** GitHub's official `actions/create-github-app-token` examples configure the App's bot account as the Git author and committer with this address:

```
<BOT-USER-ID>+<app-slug>[bot]@users.noreply.github.com
```

The numeric prefix is *not* the App's registration ID: it is the bot account's user ID, retrievable via `GET /users/<app-slug>[bot]` (for example, `curl https://api.github.com/users/<app-slug>%5Bbot%5D`). Using the wrong ID can still produce a valid Git commit, but the email will not match the intended bot account. Signature verification is a separate property and should not be inferred from this metadata alone.

**Verified/signed commits.** There are two distinct paths to a green "Verified" badge:
1. *Git-level GPG/SSH signing*, where the pusher generates a key, registers the public half on the relevant account, and signs each commit locally before `git push`. This supports normal Git operations but requires ongoing key custody.
2. *API-authored commits via the GraphQL `createCommitOnBranch` mutation*, which GitHub documents as automatically GPG-signed and marked Verified. That path avoids a client-held signing key, but it is narrower than a normal local Git workflow. The REST Contents API may create commits, but GitHub's automatic-signing guarantee cited here is specifically for `createCommitOnBranch` and should not be generalized to every commit-creation endpoint.

**Co-authorship conventions layered on top.** Independent of git author and committer identity, a tool may append trailers to the commit message. GitHub recognizes `Co-authored-by: Name <email>` as co-author metadata, but whether an AI tool adds such a trailer — and whom it names — is product and workspace policy, not an identity guarantee. Current Codex code can inject `Co-authored-by: Codex <noreply@openai.com>` plus a PR marker when workspace attribution is enabled; that implementation landed in July 2026 and was refined in August. Claude Code Action exposes `includeCoAuthoredBy`, while its action prompt uses the triggering human as co-author when applicable. A trailer is disclosure metadata, not a substitute for the credential that authorized the push or the signature that verifies the commit.

## Installation Token Mechanics

The concrete flow that turns "an app is installed" into "an agent can `git push`" has four steps:

1. **Generate a JWT for the App itself.** Using the app's RS256 private key, construct a JWT with `iat` (issued-at, recommended to be set 60 seconds in the past to tolerate clock drift), `exp` (no more than 10 minutes into the future), and `iss` (the App's client ID or App ID). This JWT proves "I am App #X," not "I may act on repo Y" — it has no repository or permission scope of its own.
2. **Exchange the JWT for an installation access token.** `POST /app/installations/{installation_id}/access_tokens`, authenticated with `Authorization: Bearer <JWT>`. The request body can optionally pass a `repositories`/`repository_ids` array to scope the resulting token to a *subset* of the repos the installation covers, and a `permissions` object to request a *subset* of the App's declared permissions — both narrower-than-installed, never broader. A multi-tenant minting service should bind that requested subset to the caller's own authorization rather than exposing the installation's full reach.
3. **Receive a token that expires after one hour.** The response includes the token string and an `expires_at` timestamp; the caller generates another installation token when needed. Official libraries and `actions/create-github-app-token` can perform the minting flow, while custom integrations need their own expiry-aware cache or re-mint logic.
4. **Use the token for git and the API.** For the REST/GraphQL API, it's a standard `Authorization: token <token>` (or `Bearer`) header. For `git` itself over HTTPS, GitHub App installation tokens work as the password half of basic auth with the literal username `x-access-token`:
   ```
   git clone https://x-access-token:<INSTALLATION_TOKEN>@github.com/owner/repo.git
   git -C repo push https://x-access-token:<INSTALLATION_TOKEN>@github.com/owner/repo.git HEAD:main
   ```
   Community credential-helper implementations (e.g. `bdellegrazie/git-credential-github-app`) wrap this into a standard git credential helper, often combined with `useHttpPath = true` and `git-credential-cache`, so that per-repo remotes automatically resolve to the right installation without embedding a token in the remote URL at all — useful when an agent's workspace touches several repos under different installations.

When minting happens in a trusted service and the App private key is not exposed to the agent process, this flow separates long-term secret custody from the sandbox running agent-generated code. The sandbox then holds only an installation token that expires after one hour and is bounded by the installation plus any narrower repository and permission subset requested at mint time.

## Industry Practice: How AI Coding Agents Actually Do This Today

**Dependabot** is a GitHub-operated service acting as `dependabot[bot]`, so it is not evidence for how a third-party agent should custody a GitHub credential. Its OIDC support is relevant to the outward-authentication half of the design: update jobs can obtain short-lived credentials for supported private registries on AWS CodeArtifact, Azure DevOps Artifacts, and JFrog Artifactory.

**GitHub Copilot cloud agent** operates under its own bot identity. GitHub documents its commits as signed and Verified, with each commit message linking to the session log. The agent is limited to the repository selected for the task and one branch: an existing PR branch when invoked there, or otherwise a new `copilot/` branch. It cannot push directly to the default branch, receives only secrets and variables explicitly assigned to the `copilot` environment, and remains subject to repository rulesets and branch protection. Incompatible rules can block the agent; adding it as a bypass actor is an explicit administrator choice, not its default entitlement.

**Renovate** documents GitHub App authentication alongside PAT modes. App deployments separate the integration from an individual user's lifecycle and can use installation-scoped permissions. Renovate's GitHub documentation also shows configuring `gitAuthor` with the bot account's noreply address, illustrating that authentication identity and commit metadata still need to be wired together deliberately.

**Devin** uses an organization-wide GitHub App connection as its primary integration and optionally lets individual users link their GitHub accounts so PR authorship can follow the initiating user. Its documentation recommends a dedicated GitHub user only for a particular GPG-signing setup, where one account owns both the commit identity and push credential. That signing recipe should not be mistaken for Devin's overall authentication model.

**Cursor Cloud Agents** connect repositories through the Cursor GitHub App. Cursor's security documentation states that every agent commit is signed with an HSM-backed Ed25519 key and appears Verified. That establishes signature behavior; repository-level disclosure metadata remains a separate design question.

**Claude Code Action** uses a short-lived, repository-scoped token from the Claude GitHub App when no custom `github_token` is supplied. Its current security documentation is explicit that commits are **unsigned by default**. Operators can opt into API-backed signing with `use_commit_signing: true`, or configure an SSH signing key when they need normal Git operations such as rebasing or cherry-picking.

**OpenAI's Codex** has separate workstreams for runtime agent identity and git attribution. The `use_agent_identity` work provisions a ChatGPT-derived runtime identity, while the current git-attribution extension injects commit and PR disclosure instructions according to a workspace setting. These are product-level identity and policy mechanisms; neither by itself changes which GitHub credential authorizes a push.

## Security Considerations

**Blast radius of a leaked credential** is the dominant axis separating these identity types. A leaked classic PAT with broad scopes can expose every matching resource the issuing human can access, and may have no expiry. A fine-grained PAT is bounded by its resource owner, selected repositories, permissions, and any lifetime policy, but can still be long-lived. An installation token expires after one hour and cannot exceed the App installation or the narrower repository/permission subset requested at mint time. The durable secret is therefore the App private key, which should remain in the trusted token-minting service rather than an agent sandbox.

**Confused-deputy risk** shows up specifically around token minting: a service that mints installation tokens on behalf of many callers or tenants must make sure it hands out a token scoped to *that caller's* authorized repositories, not the full breadth of what the installation is permitted to touch. Otherwise workspace A's agent can be tricked — or can simply err — into acting on workspace B's repository through a technically valid token. GitHub provides `repositories`/`repository_ids` and `permissions` as narrowing controls; binding those controls to tenant authorization is an operator responsibility.

**Private-key custody** is the App's durable trust anchor. GitHub permits up to 25 keys, says private keys do not expire and must be revoked manually, and requires generating a replacement before deleting the App's only key. Multiple keys make rotation without downtime possible. GitHub recommends a key vault with sign-only access; an environment variable is explicitly described as weaker because a compromised environment can read the key.

**Branch protection and rulesets** need explicit interplay design. GitHub rulesets can name GitHub Apps as bypass actors, and multiple rulesets can apply at once. One possible operator design is to put an App on the bypass list of a narrow checks ruleset while leaving force-push and deletion protected by another ruleset with no App bypass. That layering is a derived design recommendation, not a GitHub-prescribed pattern. The safer default is simpler: keep the agent off default-branch bypass lists, require a PR, and let normal reviews and checks gate merge.

**Audit-log correlation** is available in GitHub Enterprise audit logs through `hashed_token`, a SHA-256 hash of the credential used for authentication. GitHub documents this for installation tokens as well as PATs and OAuth tokens, and lets an enterprise search retained events by that hash. This supports incident correlation without recording the raw token. It does not imply that every event exposes a revocable token ID: an installation token can revoke itself through `DELETE /installation/token`, while broader containment may require rotating App keys, suspending or uninstalling the App, or changing its repository access.

## Emerging Standards and Discussion

Attribution conventions for AI-assisted commits are contested. GitHub documents platform semantics for `Co-authored-by`, which makes it convenient, but some projects reject using a human co-authorship field for an LLM. Current policy files in pip, Requests, and attrs explicitly disallow listing LLM products or bots as co-authors and instead require the human contributor to take responsibility for the change. Custom trailers such as `Assisted-by:` or tool/model fields can express a repository's own convention, but they do not inherit GitHub's documented co-author semantics.

At the cryptographic layer, **Sigstore's `gitsign`** provides keyless Git signing with an OIDC identity, Fulcio-issued short-lived certificates, and Rekor transparency-log verification. Verification must currently use `gitsign verify`; the project explicitly notes that GitHub does **not** show gitsign signatures as Verified because GitHub does not trust the Sigstore CA root or validate the ephemeral certificate through Rekor. **GitHub artifact attestations** solve a different problem: they bind a released artifact to a repository, workflow, commit SHA, triggering event, and OIDC claims, and can provide SLSA Build Level 2 or, with an appropriate reusable-workflow design, Level 3. They do not attest that an AI authored a source commit. A sound provenance model therefore keeps three layers distinct: push authority, human-readable disclosure, and cryptographic verification of the commit or resulting build artifact.

## Key Takeaways for Agent Builders

- **Default to GitHub App installations for unattended repository-writing agents, not a shared PAT.** They combine one-hour installation tokens, per-mint repository and permission narrowing, an App identity independent of a human account, scalable rate limits, and no GitHub seat consumption. A machine user remains appropriate only when the workflow genuinely requires regular-user semantics.
- **Mint installation tokens outside the agent's own sandbox.** Keep the App's private key in a secrets manager behind a trusted minting service, and bind each token's requested `repositories`/`permissions` subset to that workspace's authorization. This limits a leaked token by time and by the scope actually requested; it does not guarantee a one-repository boundary unless the minter asks for one.
- **Use the bot user ID, not the App ID, in the recommended commit email.** Configure `<bot-user-id>+<app-slug>[bot]@users.noreply.github.com`, with the numeric ID read from `GET /users/<app-slug>[bot]`. Treat author metadata, push authorization, and signature verification as separate layers.
- **Use `createCommitOnBranch` when GitHub-managed commit signing fits the workflow.** GitHub documents automatic GPG signing and Verified status for this GraphQL mutation. Do not assume the same guarantee for the REST Contents API; use local GPG/SSH signing when full Git operations are required.
- **Require PRs, don't bypass-list the agent.** Keep agent identities off branch-protection/ruleset bypass lists for default branches; let normal required reviews and checks gate merges, and scope any bypass privileges narrowly (agent-owned working branches only) if granted at all.
- **Make disclosure configurable per repository.** Some projects accept `Co-Authored-By`; pip, Requests, and attrs explicitly reject LLM co-authors. A custom trailer may be clearer, but no GitHub or Git standard currently gives it platform semantics.
- **Treat OIDC as the answer to the adjacent problem, not a substitute.** GitHub Apps authenticate the agent *into* GitHub; OIDC federation is how the agent's CI/runtime authenticates *out* to clouds, registries, and secrets managers without a second static credential to leak.
- **Use a one-way token fingerprint as an incident-response correlation key.** GitHub Enterprise can search retained audit events by `hashed_token`; the minting service can record the same SHA-256 hash with workspace and issuance metadata, without storing the token value. Revoke the current installation token through `DELETE /installation/token` and use App-level containment controls when the token itself is no longer available.

## References

- [Deciding when to build a GitHub App — GitHub Docs](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/deciding-when-to-build-a-github-app)
- [Authenticating as a GitHub App installation — GitHub Docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
- [Generating a JSON Web Token for a GitHub App — GitHub Docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)
- [Generating an installation access token for a GitHub App — GitHub Docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [Managing private keys for GitHub Apps — GitHub Docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)
- [Best practices for creating a GitHub App — GitHub Docs](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)
- [actions/create-github-app-token — official repository](https://github.com/actions/create-github-app-token)
- [git-credential-github-app — official repository](https://github.com/bdellegrazie/git-credential-github-app)
- [GitHub App installation-token format override — GitHub Changelog](https://github.blog/changelog/2026-05-15-github-app-installation-tokens-per-request-override-header/)
- [Managing personal access tokens — GitHub Docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [Managing deploy keys — GitHub Docs](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys)
- [GitHub Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)
- [People who consume a license in an organization — GitHub Docs](https://docs.github.com/en/billing/reference/github-license-users)
- [GitHub Corporate Terms of Service (legacy contracts)](https://docs.github.com/en/site-policy/github-terms/github-corporate-terms-of-service)
- [Rate limits for the REST API — GitHub Docs](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [Rate limits and query limits for the GraphQL API — GitHub Docs](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)
- [A simpler API for authoring commits (`createCommitOnBranch`) — GitHub Changelog](https://github.blog/changelog/2021-09-13-a-simpler-api-for-authoring-commits/)
- [Creating a commit with multiple authors — GitHub Docs](https://docs.github.com/en/pull-requests/how-tos/commit-changes/creating-a-commit-with-multiple-authors)
- [OpenID Connect — GitHub Docs](https://docs.github.com/en/actions/concepts/security/openid-connect)
- [Dependabot OIDC authentication — GitHub Changelog](https://github.blog/changelog/2026-02-03-dependabot-now-supports-oidc-authentication/)
- [Application card: GitHub Copilot coding agent — GitHub Docs](https://docs.github.com/en/copilot/responsible-use/agents)
- [Available rules for rulesets — GitHub Docs](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- [Identifying audit-log events performed by an access token — GitHub Docs](https://docs.github.com/en/enterprise-cloud@latest/admin/monitoring-activity-in-your-enterprise/reviewing-audit-logs-for-your-enterprise/identifying-audit-log-events-performed-by-an-access-token)
- [Revoke an installation access token — GitHub REST API](https://docs.github.com/en/rest/apps/installations#revoke-an-installation-access-token)
- [GitHub and GitHub Enterprise Server — Renovate Docs](https://docs.renovatebot.com/modules/platform/github/)
- [GitHub integration — Devin Docs](https://docs.devin.ai/integrations/gh)
- [GitHub integration — Cursor Docs](https://cursor.com/docs/integrations/github)
- [Cloud Agent security — Cursor Docs](https://cursor.com/docs/cloud-agent/security)
- [Claude Code Action security](https://github.com/anthropics/claude-code-action/blob/main/docs/security.md)
- [Claude Code Action inputs](https://github.com/anthropics/claude-code-action/blob/main/action.yml)
- [Claude Code base-action settings](https://github.com/anthropics/claude-code-action/blob/main/base-action/README.md)
- [Codex git-attribution implementation](https://github.com/openai/codex/blob/main/codex-rs/ext/git-attribution/src/world_state.rs)
- [Initial Codex git-attribution change](https://github.com/openai/codex/commit/ab816f3ca0fea858a4fc012e1bed826050d82961)
- [Codex pull-request attribution change](https://github.com/openai/codex/commit/40d226e39821fc5e22d068cb4f12cbaa297c580e)
- [Codex app-created commit attribution change](https://github.com/openai/codex/commit/9946da9af1829410271f6b76f9159961f7281e0a)
- [Codex agent-identity change](https://github.com/openai/codex/pull/19049)
- [pip AI policy](https://github.com/pypa/pip/blob/main/AI_POLICY.md)
- [Requests AI policy](https://github.com/psf/requests/blob/main/.github/AI_POLICY.md)
- [attrs AI policy](https://github.com/python-attrs/attrs/blob/main/.github/AI_POLICY.md)
- [gitsign — official repository](https://github.com/sigstore/gitsign)
- [Artifact attestations — GitHub Docs](https://docs.github.com/en/actions/concepts/security/artifact-attestations)
- [Using artifact attestations and reusable workflows for SLSA Build Level 3 — GitHub Docs](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/increase-security-rating)
