---
date: "2026-08-21"
title: "Documentation-Contract Drift Detection in Evolving Agent Systems"
description: "Techniques for detecting and preventing documentation drift when agent system configs, APIs, and schemas evolve faster than their docs"
tags: ["documentation", "contract-testing", "agent-tooling", "developer-experience", "ci-cd"]
---

## Executive Summary

Documentation is a claim about the system's behavior, made in a format the system cannot check. Code that references `workspace_slug` and a README that still says "collect the `workspace_id` from the API" are both syntactically valid — nothing crashes, no test fails, no linter fires — yet one of them is lying. This is **documentation-contract drift**: the gap that opens when a system's actual interface (config keys, API fields, CLI flags, onboarding steps) changes but the natural-language description of that interface does not change with it.

Today's motivating case is small but representative: onboarding docs instructed users to fetch a `workspace_id` through an API call, but the underlying code had migrated to `workspace_slug` — visible directly in the URL, no API call needed — two versions earlier. Every automated check in the pipeline was green. A cross-agent review caught it by doing something no linter does: reading the README's *claim*, then reading the SKILL.md and `hooks/configure.js` that actually implement onboarding, and noticing the two didn't describe the same world.

This article surveys drift detection — schema-doc cross-referencing, config-key extraction plus grep, dead-reference linting, OpenAPI contract linting, doc-tests, and LLM-based diff review — and explains a shared boundary: tools can prove a *reference* is broken when it violates a rule they actually encode, but cannot prove an arbitrary natural-language claim is stale merely because it is well formed. `workspace_id` was once a real field; catching its stale onboarding use requires a generated-docs pipeline, a custom correspondence check, an executable instruction with an asserted outcome, or a reviewer that compares the doc with the current implementation. In *Articulate but Wrong* (arXiv:2605.21537), a separate judgment call by the same model that produced short Python 2→3 candidates missed 83 of 262 semantic failures (31.7%); the judge was not told it had authored the candidate. The study contains no independent-review comparison and leaves multi-model review open, so it motivates independent peer or cross-agent review as an engineering recommendation rather than measuring its superiority for documentation drift.

## The Motivating Case, Generalized

Reduce the incident to its shape and it recurs constantly in agent systems specifically, for a structural reason: agent codebases change their *interface surface* — config schemas, tool parameter names, API endpoints, environment variables — at a much higher rate than traditional application code, because the interface *is* the product. A parameter rename that would be a minor internal refactor in a monolith is a breaking onboarding change in an agent framework, because onboarding docs, SKILL.md files, hook scripts, and README quickstarts all encode the same interface independently, in prose, with no compiler checking any of them against the others.

The pattern has three ingredients, all present in the `workspace_id` → `workspace_slug` case:

1. **A migration that is locally correct.** The code change (switch from an API-fetched ID to a URL-visible slug) was almost certainly a good simplification, shipped and tested on its own merits.
2. **No single artifact records "this replaces that."** The commit changed code; it did not necessarily touch every doc surface that described the old interface, and nothing forced it to.
3. **The stale doc is not malformed.** `workspace_id` was a real, working field two versions ago. A schema validator, a link checker, and a spell-checker all see well-formed text pointing at a once-real concept. The only way to know it's wrong now is to know what the *current* code does — which means either running the code, or reading it and comparing.

This is why the bug survived to a cross-agent review instead of being caught earlier: every tool with the job of gatekeeping the codebase was looking at the code in isolation (does it compile, does it lint, do tests pass) or at the docs in isolation (are the links live, is the prose well-formed) — never at the *correspondence* between the two.

## Static Detection Techniques

### Schema-doc cross-referencing

The most direct technique is to extract the current config/API surface programmatically (from JSON Schema, an OpenAPI document, a Pydantic/Zod model, or CLI `--help`) and map it to identifiers extracted from the relevant prose. The custom mapping supplies two possible checks: **doc → schema/code** for stale references and **schema/code → doc** for undocumented fields. Existing tools own narrower pieces. [`oasdiff`](https://github.com/oasdiff/oasdiff) compares one OpenAPI specification with another and reports changes between those specs; it does not cross-reference arbitrary README prose. [`tfplugindocs`](https://github.com/hashicorp/terraform-plugin-docs) generates Terraform provider documentation from provider schema, reducing manually duplicated reference material. A `workspace_id`-style prose gate still needs a project-specific extractor and correspondence rule that identifies which narrative tokens map to which authoritative fields.

### Config key extraction + doc grep

A lighter-weight version, tractable for projects without a formal schema, parses config-loading code (or a config example) for recognized keys, separately extracts identifier-shaped tokens from the docs, then applies an explicit mapping/allowlist to compare them. This is the custom check that could catch `workspace_id`. `ast-grep` can make the code-extraction half language-aware, for example by finding each `config.get('...')` call by AST shape ([ast-grep Configuration Reference](https://ast-grep.github.io/reference/yaml)). LinkML's linter is a different scoped example: it checks one LinkML schema against configured schema-quality rules. It does not extract application config or establish correspondence with arbitrary README identifiers; using it alone would not implement this prose gate ([LinkML Schema Linter](https://linkml.io/linkml/schemas/linter.html)).

### Dead-reference and link linting

The narrowest but cheapest layer: check that every URL, internal anchor, and cross-file reference in the docs still resolves. `markdown-link-check` walks a Markdown corpus and reports dead hyperlinks, with a JUnit-compatible reporter for CI integration ([markdown-link-check GitHub](https://github.com/tcort/markdown-link-check)). `lychee`, written in Rust for speed, does the same for Markdown, HTML, and plain text and is commonly wired in as a GitHub Action, scanning hundreds of links in about a minute ([lychee-action GitHub](https://github.com/lycheeverse/lychee-action), [lychee docs](https://lychee.cli.rs/overview/)). This layer catches a *different* failure mode than the motivating case — a link, not a claim — but it's worth naming because teams often believe "we lint our docs" covers drift when it only covers link rot.

### Prose and style linting

Vale is the closest thing the industry has to "ESLint for prose": a markup-aware linter for Markdown, AsciiDoc, reStructuredText, and HTML that enforces vocabulary, terminology, and style-guide rules (Microsoft's or Google's writing guides, or a custom ruleset), runnable in CI via GitHub Actions ([Vale](https://vale.sh/), [Vale docs](https://vale.sh/docs), [Datadog: How we use Vale](https://www.datadoghq.com/blog/engineering/how-we-use-vale-to-improve-our-documentation-editing-process/)). Vale is valuable — Datadog, Grafana's Writers' Toolkit, and Meilisearch all run it in production doc pipelines — but it operates purely on the text, with no view into the code. It can catch "you used the deprecated term X" only if X is in a maintained terminology list; it cannot infer on its own that `workspace_id` is now deprecated, because that fact lives in the code, not the prose ([Grafana Writers' Toolkit: Lint prose with Vale](https://grafana.com/docs/writers-toolkit/review/lint-prose/), [Meilisearch: Prose linting with Vale](https://www.meilisearch.com/blog/prose-linting-with-vale)).

### OpenAPI/API contract linting

Spectral, from Stoplight, draws the sharpest available line between *validation* (is this valid OpenAPI?) and *linting* (is this a good API description by our house rules?) — it ships default OpenAPI/AsyncAPI rulesets and lets teams write custom rules enforcing naming, structure, and governance policy, runnable both locally and in CI/CD ([Spectral, Stoplight](https://stoplight.io/open-source/spectral), [Spectral OpenAPI Linting Guide, QASkills](https://qaskills.sh/blog/spectral-openapi-linting-guide-2026)). This is the state of the art for keeping an API *spec* internally consistent, but by design it says nothing about whether prose documentation elsewhere (a README, a getting-started guide) still matches that spec — that's a separate cross-referencing problem, which is what schema-doc diffing and generated docs (below) exist to close.

## Generated Docs: Making the Doc a Build Artifact, Not a Belief

The most robust structural fix is to stop hand-writing the parts of the docs that describe the interface, and generate them from the same source the code reads. If the reference table is a build output, "the docs disagreed with the code" becomes a type error, not a lapse in diligence.

- **terraform-docs** generates module documentation (inputs, outputs, providers) directly from `.tf` schema and can inject it into a README in place, configured via a checked-in `.terraform-docs.yml` — the reference tables cannot drift because they're regenerated, not retyped ([terraform-docs.io](https://terraform-docs.io/reference/), [terraform-docs GitHub](https://github.com/terraform-docs/terraform-docs/blob/master/docs/reference/terraform-docs.md)).
- **JSON Schema → Markdown/HTML generators** — `json-schema-for-humans`, Adobe's `jsonschema2md`, `wetzel`, `json-schema-docs` — turn a config's JSON Schema directly into a human-readable reference, so the schema is the single edit point ([json-schema-for-humans](https://github.com/coveooss/json-schema-for-humans), [adobe/jsonschema2md](https://github.com/adobe/jsonschema2md), [CesiumGS/wetzel](https://github.com/CesiumGS/wetzel)).
- **Contract-first API documentation** goes further: the OpenAPI/GraphQL/protobuf contract is authored *before* implementation and becomes the source both code and docs generate from — "the schema serves as the single source of truth from which tests, mock servers, client SDKs, server stubs, and documentation are generated," per Postman's 2025 State of the API report, which puts API-first adoption at 82% of organizations, up from 66% two years prior ([Contract-First APIs: How OpenAPI Becomes Your Single Source of Truth, HackerNoon](https://hackernoon.com/contract-first-apis-how-openapi-becomes-your-single-source-of-truth); [Schema-First API Development and Testing Strategy](https://totalshiftleft.ai/blog/schema-first-api-development-testing-strategy); [Contract shock therapy, Evil Martians](https://evilmartians.com/chronicles/contract-shock-therapy-the-way-to-api-first-documentation-bliss)). Hosted doc platforms have converged on the same idea for hosted docs specifically: GitBook and Mintlify regenerate reference pages automatically whenever a linked OpenAPI spec changes, with zero CI configuration required on the team's part ([Best code documentation tools 2026, GitBook Blog](https://www.gitbook.com/blog/best-code-documentation-tools)).

The trade-off is scope: generation works cleanly for *reference* material (fields, types, defaults) that has a 1:1 structural source. It does not by itself generate *narrative* documentation — the onboarding guide's prose explaining *why* you visit a URL to get the slug, in what order, alongside what other steps — which is exactly the register the motivating bug lived in. Generated reference docs would not, by themselves, have caught a stale sentence in an onboarding walkthrough; they only guarantee the reference tables are honest.

## Docs as Tests: Executable Documentation

A second structural fix, orthogonal to generation, is to make documentation's *examples* fail the build when they stop working, the same way code fails a build when it breaks a test.

- **Python's `doctest`** treats any interactive-session-shaped snippet inside a docstring as an assertion: it executes the snippet and fails if the real output diverges from the shown output, and is commonly run in CI via `pytest --doctest-modules` positioned after unit tests and before deployment — "if docs examples fail, docs don't ship" ([Real Python: doctest](https://realpython.com/python-doctest/), [Python docs: doctest](https://docs.python.org/3/library/doctest.html)).
- **`markdown-doctest`** dynamically executes fenced blocks labeled `JavaScript`, `js`, or `es6`, except blocks explicitly marked to skip. Bash, Python, JSON, unlabeled, and other fences are outside its parser's execution set. A block passes when it raises no synchronous exception; an expected-output comment is not automatically asserted, so examples whose result matters need an explicit observable assertion ([Widdershin/markdown-doctest](https://github.com/Widdershin/markdown-doctest)).
- **Doc Detective** generalizes further, to non-code instructions: it's an open-source documentation-testing framework where tests can be written in JSON/YAML or embedded inline in Markdown, and it can drive CLI commands, API calls, and UI actions exactly as a user following the doc would — "performs your instructions step-by-step, just like your users would, and reports what works and what doesn't," across Windows/Mac/Linux and multiple browsers, runnable in CI ([Doc Detective intro](https://doc-detective.com/docs/get-started/intro), [Doc Detective tests](https://doc-detective.com/docs/get-started/tests)). This is the closest existing tool to what would have caught the motivating bug directly: a Doc Detective test encoding "follow the onboarding steps, confirm the described API call/URL pattern actually works" would fail the moment the described `workspace_id` API call stopped matching reality — because it would actually *try* the step, not just check that it's referenced somewhere sane.

Docs-as-tests catches a category static linting cannot: an *instruction* that is well-formed prose, references real (if outdated) concepts, and is simply wrong about what to do. It's the direct executable analogue of what the cross-agent reviewer did manually — actually check whether following the instruction works — just automated and run on every merge instead of depending on a reviewer noticing.

## Where Static Tooling Stops: The Semantic Gap

Every technique above shares a boundary. Link checkers, schema-diff tools, prose linters, and even doc-tests all detect **violations of a checkable rule**: a URL that 404s, a field absent from the current schema, a banned term, a code snippet that throws. None of them detect **a claim that is individually well-formed but no longer true**, unless that claim happens to be phrased as one of those checkable things. "Collect the `workspace_id` via the API" is a well-formed English sentence. If nothing in the doc explicitly names the API endpoint as a JSON-Schema-typed reference the tooling tracks, and no doc-test actually exercises that exact sentence's instruction, it passes every static gate that exists.

This is precisely the gap the cross-agent review closed: the reviewing agent read the README's *claim* ("collect `workspace_id` via API") against the SKILL.md and `hooks/configure.js` that constitute ground truth, and recognized the two didn't describe the same system — a semantic comparison, not a rule violation.

Research on artifact-conflict review quantifies both promise and limits under controlled conditions. TRACE holds a fixed blind, artifact-symmetric prompt and injects faults into Javadoc (`DocBug`), the method under test (`MutBug`), or both. Its reported +54.8–76.5 percentage points are net conflict-detection gains above each model's clean false-positive rate, not conventional net accuracy. The 21–43 point asymmetry concerns fault origin—`MutBug` versus both-changed—not a prompted/unprompted comparison or natural code evolution where changed code is automatically authoritative ([Measuring LLM Trust Allocation Across Conflicting Software Artifacts, arXiv](https://arxiv.org/pdf/2604.03447)). The `workspace_id` migration is therefore an analogy to artifact conflict, not an instance of TRACE's experiment. A companion study, *Articulate but Wrong*, evaluates 1,980 Python 2→3 modernization attempts across 11 models. Among 262 semantically broken candidates, a separate judgment call by the same producing model missed 83 (31.7%); the judge was not told it authored the candidate. The paper has no independent-review arm, and its result should not be read as a measured cross-agent advantage ([Articulate but Wrong, arXiv:2605.21537](https://arxiv.org/html/2605.21537)).

The practical conclusion is narrower: explicit artifact comparison is useful, while same-producing-model judgment showed a substantial miss rate in one modernization setting. That motivates **independent, cross-agent or human peer review** as an engineering layer, but the cited studies do not measure independent documentation review against self-review. CodeX-Verify provides adjacent code-verification evidence on only 29 hand-curated ablation samples: four heterogeneous specialist single-agent configurations average 32.8%, `Correctness` alone scores 75.9%, the full four-agent configuration scores 72.4%, and the best `C+P` pair scores 79.3% ([Multi-Agent Code Verification via Information Theory, arXiv:2511.16708](https://arxiv.org/html/2511.16708)). Those controls rule out describing 72.4% as a universal gain over a matched single-reviewer baseline or as an effect purely of structural diversity. Independent doc/code comparison remains a risk-informed recommendation, supported here by the motivating review outcome rather than a cross-agent documentation experiment.

## Emerging LLM-Assisted CI Approaches

A newer category sits between pure static linting and manual cross-agent review: wire an LLM into the CI pipeline itself, triggered on merge, to read the diff and the docs together and propose an update — closer to "always-on cross-agent review" than to a fixed rule set.

The pattern documented by dosu.dev pairs `anthropics/claude-code-action` with a repository `CLAUDE.md` file that maps source directories to the documentation pages they affect; on merge, the workflow extracts the diff, gives the agent read/grep/edit access scoped to docs, and lets it either open a follow-up doc-update PR or explain why none is needed, posting a job summary either way ([How to Catch Documentation Drift with Claude Code and GitHub Actions, dosu.dev](https://dosu.dev/blog/how-to-catch-documentation-drift-claude-code-github-actions)). The same source cites a 2025 GetDX study finding new hires take two to three months longer to become productive against stale documentation, and that developers lose three to ten hours a week hunting for answers that should already be documented — the economic argument for automating this check rather than relying on someone noticing. This approach's own documented limitation matters: it performs surface-level diff-to-doc matching driven by an explicit mapping table, and its authors are explicit that it "does not understand" that a variable rename might signal an architectural shift requiring a deeper doc rewrite — it catches the mechanical cases well and needs the mapping table kept current to catch anything else.

Mintlify's "Update from code changes" workflow takes a narrower, product-integrated version of the same idea: it watches specific user-facing surfaces (API endpoints, parameters, SDK methods, CLI flags, config options, response shapes), drafts an update when one of them changes, and opens it as a reviewable PR rather than auto-publishing, deliberately skipping internal refactors that don't change public behavior ([How to Stop Documentation Drift, Mintlify](https://www.mintlify.com/library/how-to-stop-documentation-drift)).

Both approaches are meaningfully closer to catching a `workspace_id`-shaped bug than any purely static tool, because they compare meaning, not just structure — but both also depend on either an accurate mapping table or a well-scoped "user-facing surface" list to know where to look, which is itself a maintained artifact that can drift.

## Patterns for Preventing Drift: A Synthesis

Ordered roughly from cheapest/narrowest to most structural/expensive:

1. **Dead-reference linting** (lychee, markdown-link-check) — catches broken links and citations; cheap, runs in seconds, catches nothing semantic.
2. **Config-key extraction + doc grep** (ast-grep-based or hand-rolled scripts) — catches exactly the `workspace_id` class of bug *if* the stale term is a literal identifier and the extraction script stays current with where config is defined. This is the highest-leverage cheap check for the specific bug in today's case.
3. **Schema/API contract tooling** (Spectral for spec quality/governance, `oasdiff` for spec-to-spec change detection, `tfplugindocs` for schema-derived provider docs) — strong within formal, machine-readable interfaces; narrative prose needs separate extraction and correspondence logic.
4. **Prose/terminology linting** (Vale) — enforces consistent, current vocabulary if the terminology list itself is maintained as ground truth; otherwise just enforces style.
5. **Doc-tests / executable docs** (doctest, markdown-doctest, Doc Detective) — bounded dynamic validation for the examples and steps actually executed. The guarantee is no stronger than the parser's inclusion rules and the observable assertions encoded; successful execution without an exception is not proof that the documented outcome occurred.
6. **Generated reference docs** (terraform-docs, JSON-Schema-to-Markdown, contract-first OpenAPI pipelines) — eliminates drift structurally for reference material by making the doc a build artifact; doesn't cover narrative/onboarding prose, which still has to be hand-maintained and hand-checked.
7. **LLM-in-CI diff review** (Claude Code + GitHub Actions, Mintlify Workflows) — catches semantic drift on the specific surfaces it's configured to watch, continuously, without waiting for a human or agent reviewer to pick up the PR.
8. **Independent cross-agent (or human peer) review** — an engineering backstop for semantic comparisons that the configured mechanical rules do not express. It caught today's bug, but the cited research does not quantify its advantage for this documentation failure mode.

None of these is a substitute for the others; they cover different, overlapping slices of "the docs might be lying." A mature setup for an agent codebase realistically wants layer 2 or 3 as a cheap CI gate (it would have caught the `workspace_id` reference directly, fast, on every PR), a thin layer of 5 for onboarding-critical instructions specifically (because those are exactly the doc surfaces users hit first, with zero context to self-correct), and layer 8 as the catch-all for the semantic cases the mechanical layers can't reach by construction — reserved for changes that touch onboarding, config schemas, or public interfaces, rather than run on every PR.

## Trade-offs: Maintenance Cost vs. Drift Cost

Doc-tests and generated docs are not free. Test-automation literature broadly finds maintenance, not initial authoring, dominates the lifetime cost of any automated check: teams report spending 30–40% of total testing effort on maintaining existing tests rather than writing new ones, with 49% citing maintenance as their single biggest automation challenge, and returns diminishing sharply once the most important flows are covered ([The True Cost of Test Maintenance, Diffie](https://diffie.ai/blog/true-cost-of-test-maintenance)). The same dynamic applies directly to doc-tests: an executable onboarding walkthrough that hits a real API will need updating every time that API's auth flow, rate limits, or response shape shifts for reasons unrelated to the doc's actual claim, which is exactly the kind of churn that erodes trust in a check and gets it disabled rather than fixed.

That cost has to be weighed against the cost of *not* catching drift, which is asymmetric and back-loaded: a broken onboarding instruction is cheapest to fix at review time (a diff comment, a two-line edit) and most expensive at the point a new user hits it cold, with no context to recognize "the docs are wrong" versus "I'm doing something wrong" — the GetDX finding that stale docs add two to three months to new-hire ramp time, cited above, is one measurement of that back-loaded cost, and the same mechanism applies to external users onboarding to an API or agent framework.

A pragmatic allocation for small, fast-moving projects — which is the exact profile of most agent codebases — follows from where each technique's cost/benefit ratio is best:

- **Always cheap, always on:** link checking and config-key/doc-grep cross-referencing. These run in seconds, need almost no maintenance once written, and directly catch the `workspace_id` class of bug.
- **Reserve doc-tests for the doc surfaces new users hit with zero context** — onboarding, quickstart, first-API-call — where the cost of a wrong instruction is highest and a human is least equipped to self-correct. Don't doc-test every code example in every reference page; that's where maintenance cost outpaces drift cost fastest, per the same diminishing-returns pattern seen in general test-automation research.
- **Use generated reference docs wherever the interface is already machine-readable** (config schema, OpenAPI spec) — the cost is a one-time pipeline setup, and it eliminates an entire category of drift going forward rather than detecting it after the fact.
- **Put cross-agent or peer review specifically on PRs that touch onboarding docs, config schemas, or renamed public identifiers** — this is a targeting decision, not a blanket policy; running deep semantic review on every doc typo fix is waste, but skipping it on a PR that renames a field users are told to collect is how the motivating bug happened.

## A Practical Checklist

For a team wiring this into an agent codebase's CI:

1. Write a script that extracts every recognized config key / API field / CLI flag from the code (not the docs) — treat this extraction as the one place drift-detection ground truth lives.
2. Grep the docs corpus (README, SKILL.md, onboarding guides, changelogs) for identifier-shaped tokens not in that extracted set; fail CI on any match that isn't explicitly allowlisted (e.g., deliberately-documented deprecated aliases).
3. Add link/reference checking (lychee or markdown-link-check) as a fast, independent CI job — it catches a different failure mode (rot) at near-zero cost.
4. For onboarding and quickstart docs, write executable tests for critical instructions and assert an observable result—not merely "the snippet did not throw"—so the check measures the promised outcome. State which languages, fences, commands, and UI/API steps the runner actually includes.
5. Where the interface is already schema-defined, generate the reference tables (terraform-docs– or JSON-Schema-to-Markdown–style) instead of hand-maintaining them, and fail CI if the generated output differs from what's checked in.
6. Add an LLM-in-CI diff-review step (a Claude Code Action or equivalent) scoped by an explicit code-to-docs mapping file, to catch semantic drift on merges the mechanical checks above don't cover — understanding it will miss architectural-shift-shaped drift that isn't on its mapping.
7. For any PR that renames a public identifier, changes a config schema, or touches onboarding flow, require an independent reviewer (agent or human) explicitly tasked with comparing the doc's claims against the current implementation — not just reading the diff, but reading the *doc* and the *code path it describes* side by side.
8. Periodically run a **positive control** on your drift detectors: introduce a known-stale reference on purpose (rename a documented field and don't update one doc) and confirm your pipeline actually catches it. A check that has never been observed to fail is not yet proven to work.

## Key Takeaways

- Documentation drift is structurally different from most bugs: the stale artifact is individually well-formed, which means every checkable-rule-based tool (link checkers, schema linters, prose linters) can pass cleanly while the doc actively misleads the reader.
- Config-key extraction plus doc-grep is the cheapest technique that directly targets the `workspace_id`-shaped bug class — a renamed or removed identifier still mentioned in prose — and belongs in CI for any project with a config schema, however informal.
- Doc-tests provide bounded dynamic evidence for the examples and instructions they execute. Their value depends on explicit observable assertions and documented inclusion rules; `markdown-doctest`, for example, does not execute every fence or validate expected-output comments automatically.
- Generating reference docs from schema (terraform-docs, JSON-Schema-to-Markdown, contract-first OpenAPI pipelines) eliminates an entire category of drift structurally, but only covers reference material — narrative onboarding prose still needs a different defense.
- TRACE shows model behavior under a fixed blind conflict prompt with injected `DocBug`, `MutBug`, and both-changed faults; its gains and asymmetries should not be relabeled as prompted/unprompted natural evolution. *Articulate but Wrong* found an 83/262 same-producing-model miss rate in a narrow Python-modernization judgment setting, without an independent-review arm.
- Independent cross-agent or human peer review is therefore a motivated engineering recommendation, not a superiority result established by those studies. In today's case it worked because the reviewer compared the README claim with SKILL.md and `hooks/configure.js`; that outcome is case evidence, not a general measured effect.
- No single technique covers the whole problem. A realistic setup layers cheap mechanical checks (link checking, config-grep) as always-on CI gates, doc-tests and generation where the cost is justified by user impact, and independent review as the catch-all for changes that touch public interfaces — reserved for those changes, not run on every PR, to keep the expensive layer's cost proportionate to the risk.

## References

- [How to Catch Documentation Drift with Claude Code and GitHub Actions, dosu.dev](https://dosu.dev/blog/how-to-catch-documentation-drift-claude-code-github-actions)
- [How to Stop Documentation Drift: Keeping Docs in Sync as Your Code Changes, Mintlify](https://www.mintlify.com/library/how-to-stop-documentation-drift)
- [Doc Drift Detection in CI: Catching Stale Docs on Every Merge, Just Understanding Data](https://understandingdata.com/posts/doc-drift-detection-ci/)
- [API Schema Drift Detection Tools Compared (2026), DEV Community](https://dev.to/flarecanary/api-schema-drift-detection-tools-compared-2026-1ib4)
- [Vale: markup-aware prose linter](https://vale.sh/)
- [Vale documentation](https://vale.sh/docs)
- [Datadog: How we use Vale to improve our documentation editing process](https://www.datadoghq.com/blog/engineering/how-we-use-vale-to-improve-our-documentation-editing-process/)
- [Grafana Writers' Toolkit: Lint prose with the Vale linter](https://grafana.com/docs/writers-toolkit/review/lint-prose/)
- [Doc Detective: documentation content testing framework](https://doc-detective.com/docs/get-started/intro)
- [Doc Detective: Tests](https://doc-detective.com/docs/get-started/tests)
- [Spectral: Open Source API Description Linter, Stoplight](https://stoplight.io/open-source/spectral)
- [Spectral OpenAPI Linting Guide: Govern API Specs in CI (2026), QASkills](https://qaskills.sh/blog/spectral-openapi-linting-guide-2026)
- [ast-grep: Configuration Reference](https://ast-grep.github.io/reference/yaml)
- [LinkML Schema Linter](https://linkml.io/linkml/schemas/linter.html)
- [oasdiff — OpenAPI specification diff](https://github.com/oasdiff/oasdiff)
- [HashiCorp terraform-plugin-docs (`tfplugindocs`)](https://github.com/hashicorp/terraform-plugin-docs)
- [markdown-link-check GitHub](https://github.com/tcort/markdown-link-check)
- [lychee-action: GitHub Action for broken link checking](https://github.com/lycheeverse/lychee-action)
- [terraform-docs reference](https://terraform-docs.io/reference/)
- [How to Document Custom Terraform Providers, OneUptime](https://oneuptime.com/blog/post/2026-02-23-how-to-document-custom-terraform-providers/view)
- [json-schema-for-humans GitHub](https://github.com/coveooss/json-schema-for-humans)
- [adobe/jsonschema2md GitHub](https://github.com/adobe/jsonschema2md)
- [CesiumGS/wetzel: Generate Markdown documentation from JSON Schema](https://github.com/CesiumGS/wetzel)
- [Real Python: doctest](https://realpython.com/python-doctest/)
- [Python docs: doctest — Test interactive Python examples](https://docs.python.org/3/library/doctest.html)
- [Widdershin/markdown-doctest GitHub](https://github.com/Widdershin/markdown-doctest)
- [Contract-First APIs: How OpenAPI Becomes Your Single Source of Truth, HackerNoon](https://hackernoon.com/contract-first-apis-how-openapi-becomes-your-single-source-of-truth)
- [Schema-First API Development and Testing Strategy (2026 Playbook)](https://totalshiftleft.ai/blog/schema-first-api-development-testing-strategy)
- [Contract shock therapy: the way to API-first documentation bliss, Evil Martians](https://evilmartians.com/chronicles/contract-shock-therapy-the-way-to-api-first-documentation-bliss)
- [Best code documentation tools 2026, GitBook Blog](https://www.gitbook.com/blog/best-code-documentation-tools)
- [Measuring LLM Trust Allocation Across Conflicting Software Artifacts, arXiv](https://arxiv.org/pdf/2604.03447)
- [Articulate but Wrong: Self-Review Failures in LLM-Based Code Modernization, arXiv:2605.21537](https://arxiv.org/html/2605.21537)
- [Multi-Agent Code Verification via Information Theory, arXiv:2511.16708](https://arxiv.org/html/2511.16708)
- [Multi-Agents: What's Actually Working, Cognition](https://cognition.com/blog/multi-agents-working)
- [The True Cost of Test Maintenance (And How to Cut It), Diffie](https://diffie.ai/blog/true-cost-of-test-maintenance)
- [What is Consumer-Driven Contract Testing (CDC)?, Pactflow](https://pactflow.io/what-is-consumer-driven-contract-testing/)
- [Pact Docs: Introduction](https://docs.pact.io/)
