---
date: "2026-04-18"
title: "LLM-Powered Code Migration at Scale: From Years to Weeks"
description: "How Google, Uber, Stripe, and Amazon are using LLMs to automate large-scale code migrations, and the hybrid AST+LLM architectures that make it work"
tags: ["code-migration", "llm", "developer-tools", "refactoring", "codemods"]
---

## Executive Summary

Large-scale code migration -- upgrading Java versions, converting Java to Kotlin, migrating from Scala to Java, modernizing COBOL to cloud-native languages -- has historically been one of the most painful activities in software engineering. A single migration can consume hundreds of engineer-weeks, span years, and stall indefinitely as developer attention shifts to higher-priority work. In 2025-2026, a new class of LLM-powered migration systems has emerged that compresses these timelines dramatically: Google reports a 50% reduction in migration time across 39 ID-widening migrations in their 500M+ line Ads codebase; Stripe completed a 10,000-line Scala-to-Java migration in four days (estimated at ten engineer-weeks manually); and Uber projects cutting their Java-to-Kotlin migration timeline from eight years to four.

The key insight across all successful deployments is that pure LLM-based migration does not work at production scale. Every system that has shipped real results uses a **hybrid architecture** combining deterministic AST-based analysis for reliable detection and validation with LLM-based generation for flexible code transformation. This article examines the technical architectures, production case studies, open-source ecosystem, and remaining challenges in this rapidly maturing field.

## Background: Why Code Migration Is So Hard

Code migration at scale is fundamentally different from writing new code. It requires understanding existing semantics deeply enough to preserve them while changing syntax, APIs, type systems, and sometimes entire programming paradigms. Several factors make it particularly resistant to automation:

**Cross-cutting concerns.** A single migration (say, widening a 32-bit ID to 64 bits) can touch thousands of files across hundreds of teams. Each file has its own context, conventions, and edge cases. A migration that works perfectly in 95% of cases but silently corrupts data in the remaining 5% is worse than no migration at all.

**Semantic preservation.** The migrated code must not just compile -- it must behave identically to the original. This includes error handling paths, concurrency semantics, performance characteristics, and subtle type coercion behaviors that differ across languages.

**Organizational friction.** Migrations require code reviews from teams that did not initiate the change. At Google, a single ID migration involved 306 reviewers across 149 teams in 37 offices spanning 12 time zones [1]. Coordinating this human layer is often the bottleneck.

**The long tail.** The first 80% of a migration is often straightforward. The remaining 20% contains the edge cases, deprecated patterns, and undocumented behaviors that consume 80% of the effort. This long tail is exactly where LLMs can either shine (by reasoning about context) or fail catastrophically (by hallucinating).

Traditional approaches to automated migration -- regex-based find-and-replace, AST transformation rules (codemods), and compiler-assisted refactoring -- handle the straightforward cases well but break down on the long tail. They require engineers to anticipate and encode every possible pattern, which is infeasible for large, organically-grown codebases.

## Key Architectures

Three distinct architectural patterns have emerged for LLM-powered code migration, each representing a different tradeoff between automation and reliability.

### Pattern 1: Hybrid AST+LLM Pipeline (Google)

Google's approach, documented in their FSE 2025 paper "Migrating Code At Scale With LLMs" [1], represents the most thoroughly validated architecture. Their system was deployed on a real migration project in Google Ads -- converting 32-bit identifiers to 64-bit across a 500M+ line codebase -- and ran continuously for twelve months.

The pipeline has three stages:

**Stage 1: Reference Discovery.** The system uses Kythe, Google's code indexing infrastructure, to locate both direct and indirect references to target identifiers. It traces up to distance-five references through the codebase, deliberately over-including to avoid missing critical locations. This stage is entirely deterministic -- no LLM involvement.

**Stage 2: Categorization.** References are sorted into four buckets: "Not-migrated" (identified with 100% confidence as unchanged), "Irrelevant" (definitively unrelated), "Relevant" (requiring investigation), and "Left-over" (requires manual developer review). The categorization uses a mix of AST analysis and LLM classification.

**Stage 3: Edit Generation and Validation.** A fine-tuned Gemini model generates code modifications. The LLM receives entire files with suggested line numbers as comments and outputs diffs applied via fuzzy matching. Each change undergoes six sequential validation checks:

1. Successful completion (no timeout or crash)
2. Whitespace-only detection (reject no-ops)
3. AST parsing validity
4. LLM confirmation ("Punt" check -- a second LLM pass to verify the change is correct)
5. Build success
6. Test passage

The system makes three attempts per file to account for LLM non-determinism (temperature=0.0, but outputs still vary between runs). Changes that pass all six checks are submitted for human code review through Google's Critique system.

**Results:** Across 39 migrations over twelve months, three developers submitted 595 code changes containing 93,574 edits. Of these, 74.45% of changes were generated entirely or primarily by the LLM (35.97% LLM-only, 38.48% LLM-then-human refinement), with only 25.55% requiring fully manual creation. Developers estimated a 50% reduction in total migration time compared to earlier manual migrations [1].

### Pattern 2: LLM-Assisted Deterministic Rule Generation (Uber)

Uber's approach to migrating their 10M+ line Android monorepo from Java to Kotlin takes a notably different path. Rather than using LLMs for direct code generation -- which they rejected due to hallucination risk in production mobile code -- Uber uses LLMs to accelerate the creation of deterministic AST transformation rules [2].

Their existing pipeline is already sophisticated:

1. **Pre-processing:** Nullaway (Uber's open-source compiler plugin) adds nullability annotations to Java code
2. **Core conversion:** IntelliJ's Java-to-Kotlin converter runs headlessly in CI with full monorepo indexing
3. **Post-processing:** Idiomatic transformations (AutoDispose extensions, Mockito Kotlin migration)
4. **History preservation:** Git blame is maintained across file moves

The LLM intervention happens at the rule-generation layer. The team built a system using their DevPods remote development infrastructure to:

1. Check out historical Git states where developers had already completed manual migrations
2. Run current automated Kotlin conversion tooling against the original Java
3. Compare tooling output to what developers actually landed
4. Feed the delta to an LLM to draft new AST transformation rules
5. Run those rules through CI testing and linting
6. Iterate on failures, with the LLM refining rules based on test results

Approved rules become permanent deterministic transformations, permanently expanding the automated pipeline's coverage. This meta-level use of LLMs -- generating rules rather than generating code -- is projected to cut Uber's migration timeline from approximately eight years to four [2].

### Pattern 3: Multi-Agent Environment-in-the-Loop (Research)

A more ambitious architecture proposed in recent research [3] employs three specialized LLM agents in a feedback loop with actual execution environments:

**Migration Agent (M-Agent):** Analyzes source code, produces migration drafts, and refines them based on environmental feedback.

**Environment Agent (E-Agent):** Autonomously constructs executable build and runtime environments for the migrated project -- installing dependencies, resolving conflicts, configuring build systems, and executing code in isolated sandboxes.

**Test Suite Agent (T-Agent):** Generates, repairs, and extends test suites within the verified environment to validate functional equivalence.

The key innovation is treating migration as co-evolution of source code, dependencies, and execution environments. Unlike prior approaches that treat the environment as static, this framework creates dynamic feedback loops between code modifications and actual runtime behavior, catching version-dependent runtime errors that static analysis cannot detect.

While this architecture has shown promise in research settings (correctly configuring 33 out of 50 repositories across five programming languages), it has not yet been validated at production scale [3].

## Production Case Studies

### Google Ads: 32-bit to 64-bit ID Migration

The most comprehensively documented case study comes from Google's Ads division [1]. The migration addressed a critical infrastructure risk: 32-bit identifiers approaching negative rollover, which could cause production outages in one of the world's largest advertising platforms.

The migration ran nightly over twelve months, with the system automatically generating changes, running validation, and submitting them for code review. Key operational details:

- **Scale:** 500M+ lines of code in the Ads codebase
- **Reach:** 595 code changes touching code owned by 149 teams across 37 offices in 12 time zones
- **Language coverage:** Java, C++, Python, Dart (with Dart support notably lagging)
- **Automation rate:** 74.45% of code changes generated by LLM
- **Edit automation rate:** 69.46% of individual edits performed by LLM
- **Developer satisfaction:** "High satisfaction" with end-to-end automation

The nightly execution cadence proved psychologically important -- developers reported motivation from seeing visible daily progress on a previously-stalled migration. The automated validation pipeline (especially automated test execution) was cited as the single largest productivity gain, eliminating manual test management entirely.

Challenges included LLM hallucinations (occasionally reformatting code without making substantive changes), context window limitations on large files, language-specific performance gaps (Dart was significantly worse than Java/C++), and the frustration of multiple retries eventually failing, requiring manual intervention.

### Stripe: Scala to Java Migration

Stripe deployed Claude Code across 1,370 engineers and used it to migrate 10,000 lines of Scala to Java in four days -- work estimated at ten engineer-weeks without AI assistance [4]. The deployment involved two to three months of testing and iteration with Anthropic to produce an enterprise binary that could be deployed safely across the organization.

Stripe's approach emphasized treating AI as a collaborator that needs context rather than a replacement for developer judgment. Teams that discovered effective prompts shared those patterns within their groups, creating organic knowledge transfer. The migration was notable not just for its speed but for the breadth of deployment -- 1,370 engineers using the tool across diverse codebases, suggesting the approach generalizes beyond individual migration projects.

### Wiz: Python to Go Migration

Wiz migrated a 50,000-line Python library to Go in roughly 20 hours of active development -- a project the team estimated at two to three months of manual work [4]. This case is particularly notable because Python-to-Go migration involves fundamental paradigm shifts (dynamic typing to static typing, interpreted to compiled, implicit interfaces to explicit ones) that pure AST-based tools cannot handle.

### Uber: Java to Kotlin at Android Scale

Uber's Android monorepo contains over 10 million lines of Java and Kotlin code across nearly 100,000 files [2]. With Kotlin adoption beginning in 2017 and a 2025 ban on new Java code, the remaining legacy Java needed automated migration.

Rather than trusting LLMs with direct code generation in production mobile code, Uber's hybrid approach uses LLMs to generate deterministic rules. This meta-level approach is projected to halve the migration timeline while maintaining the safety guarantees of deterministic transformations. The pragmatic decision to avoid direct LLM code generation reflects Uber's assessment that hallucination risk is unacceptable for mobile code shipping to hundreds of millions of devices.

### Amazon: Java Upgrades and COBOL Modernization

Amazon Q Developer Transform supports two major migration categories [5]:

**Java version upgrades:** Amazon used Q Developer internally to migrate tens of thousands of production applications from older Java versions to Java 17. The tool handles dependency updates, API changes, and deprecated method replacements.

**Mainframe modernization:** AWS Transform, generally available since May 2025, converts COBOL, JCL, CICS, Db2, and VSAM applications to cloud-native Java. AWS reports a fourfold reduction in project timelines compared to manual transformation, compressing multi-year mainframe modernization projects to months.

The mainframe modernization pipeline automates codebase analysis, planning, technical documentation, business logic extraction, code decomposition, wave planning, and refactoring -- essentially the full lifecycle from assessment through execution.

## Open Source Ecosystem

### Codemod Platform

Codemod (codemod.com) is the most mature open-source platform for AI-assisted code migration [6]. Its 2.0 architecture combines deterministic engines with LLM transformation in a modular pipeline:

- **Detection layer:** Uses ast-grep for pattern matching across large codebases. ast-grep provides structural code search using tree-sitter grammars, enabling pattern matching that understands language syntax rather than treating code as text.
- **Transformation layer:** LLMs handle the actual code rewriting, with the detection layer providing precise context about what needs to change.
- **Workflow engine:** A modular TypeScript framework orchestrates the pipeline from detection through transformation, supporting both local execution and CI integration.
- **Micro-agents:** Migration knowledge is captured as reusable, versioned, and tested transformation units. Some are generated by AI from natural language descriptions; others come from real-world migrations contributed by the community.

Codemod has partnered with the OpenJS Foundation and is used by companies including Netlify and T. Rowe Price for production migrations [6].

### ast-grep

ast-grep deserves special mention as the foundation layer used by multiple migration tools [7]. It provides:

- **Structural search:** Pattern matching against AST nodes rather than text, eliminating false positives from comments, strings, and similar-looking-but-different constructs
- **Multi-language support:** Tree-sitter grammars for dozens of languages
- **MCP integration:** An ast-grep MCP server enables AI agents to use structural search as a tool during migration workflows
- **JSSG (JavaScript ast-grep):** Announced October 2025, allows writing AST transformations in TypeScript with pattern matching and semantic analysis

### Moderne (OpenRewrite)

Moderne's platform, built on the open-source OpenRewrite project, focuses on enterprise-scale automated refactoring [8]. In 2026, they expanded beyond their JVM roots to support JavaScript, providing automated refactoring at enterprise scale across language boundaries. Their approach emphasizes deterministic, recipe-based transformations that can be audited and reproduced.

### Research Frameworks

Several research frameworks have advanced the field:

- **Fine-tuned LLM-based Code Migration Framework** [9]: Demonstrates that fine-tuning LLMs on migration-specific datasets significantly outperforms general-purpose models
- **LangChain-based multi-agent architectures** [10]: Production-tested agent pipelines using File Reader, Planner, and Migrator agents with RAG for context management

## Challenges and Limitations

### Hallucination in Migration Context

LLM hallucinations take specific forms in code migration that differ from general text generation:

**Semantic drift.** The LLM produces code that compiles and passes existing tests but subtly changes behavior. Google's study found that 25.55% of changes required fully manual creation, often because LLM-generated changes were syntactically valid but semantically wrong [1].

**Phantom APIs.** Research indicates that nearly 20% of LLM package recommendations point to libraries that do not exist [11]. In migration contexts, this manifests as generated code referencing non-existent methods or packages in the target framework.

**Language confusion.** Code-specialized LLMs show significant confusion on multi-lingual tasks, with a systematic bias toward syntactically familiar languages (Python, JavaScript) when uncertain [12]. This is particularly problematic for migrations between less common languages.

**Cosmetic changes.** LLMs sometimes reformat code without making substantive migration changes, wasting review cycles. Google specifically added a whitespace-only detection check to catch this pattern [1].

### Context Window Limitations

Large files and cross-file dependencies remain a fundamental challenge. Google's system occasionally hit context window limits on large files, requiring manual intervention [1]. The Aviator case study found that dependent modules required sequential processing, as the LLM needed to understand the migrated state of dependencies before processing dependent code [10].

Modern approaches mitigate this through chunking strategies, RAG-based context retrieval, and hierarchical processing (migrating lower-level modules first, then using their migrated form as context for higher-level modules). However, whole-program reasoning -- understanding how a change in one file affects behavior in distant parts of the codebase -- remains beyond current LLM capabilities.

### Verification Gap

The gap between "code compiles" and "code is correct" is the central challenge of LLM-powered migration. Current verification approaches include:

- **Build + test:** The baseline approach, but only catches issues covered by existing tests
- **LLM self-verification:** Google's "Punt" check uses a second LLM pass to verify changes, but this is fundamentally limited by the same model's understanding
- **Shadow deployment:** Running migrated and original code in parallel to compare outputs, effective but expensive and slow
- **Formal verification:** Proving semantic equivalence between original and migrated code, theoretically ideal but practically limited to small programs

No current system has a complete solution for verifying semantic preservation at scale. The practical approach is defense-in-depth: multiple independent verification layers, each catching different classes of errors, combined with human review for changes that pass automated checks.

### Language-Specific Performance Gaps

LLM migration performance varies significantly across languages. Google found Dart support "lagged significantly behind Java, C++, and Python" [1]. This reflects the training data distribution of foundation models -- languages with more open-source code produce better migration results.

Languages with complex type systems (Rust, Haskell), extensive metaprogramming (Ruby, Lisp), or platform-specific idioms (Swift, Objective-C) present particular challenges. The practical implication is that migration tooling must be validated per-language rather than assumed to generalize.

## Emerging Patterns and Best Practices

Analysis of the production deployments reveals several converging best practices:

### 1. Never Use LLMs Alone

Every successful production system combines LLMs with deterministic techniques. The consistent finding is: use AST-based tools for detection (what needs to change) and validation (did the change work), and use LLMs for generation (how to change it). This matches the fundamental strengths of each approach -- ASTs provide precision and reproducibility; LLMs provide flexibility and contextual reasoning.

### 2. Validate at Multiple Levels

Google's six-level validation pipeline is representative: completion check, no-op detection, syntax validity, semantic verification, build success, and test passage. Each level catches a different class of errors that slip through other levels.

### 3. Embrace Non-Determinism

Rather than fighting LLM non-determinism, successful systems work with it. Google makes three attempts per file. Uber iterates LLM-generated rules through CI. The practical stance is: generate multiple candidates, validate all of them, and accept the first that passes.

### 4. Preserve Human Review

No production system fully removes humans from the loop. Even Google's highly automated system routes all changes through code review. The role of the human shifts from "write the migration" to "verify the migration," but the human remains essential for catching subtle semantic issues.

### 5. Invest in Pipeline Infrastructure

The LLM is often the easiest part of the system to build. The surrounding infrastructure -- reference discovery, dependency tracking, build integration, test orchestration, code review integration, rollback mechanisms -- represents the majority of the engineering effort and determines whether the system works in practice.

### 6. Use LLMs at the Meta Level

Uber's approach of using LLMs to generate deterministic rules, rather than generating code directly, is a powerful pattern for safety-critical contexts. The LLM accelerates the most creative part (understanding what transformation is needed), while the deterministic system handles execution (applying the transformation reliably at scale).

## Future Directions

### Formal Verification Integration

The combination of LLM-generated migrations with lightweight formal verification is a promising research direction. Rather than proving full semantic equivalence (which is undecidable in the general case), practical approaches might verify specific properties: type preservation, null safety, thread safety, or API contract compliance. This would provide stronger guarantees than testing alone while remaining tractable.

### Continuous Migration

Current systems treat migration as a project with a start and end date. Future systems may operate continuously, automatically migrating new code as it is written. This would prevent the accumulation of migration debt -- instead of migrating 10M lines at once, the system would migrate each new file or function incrementally. Codemod's micro-agent architecture points in this direction.

### Cross-Repository Migration

Most current tools operate within a single repository. Real-world migrations often span multiple repositories, packages, and services. A migration of a shared library's API requires coordinated changes across all consumers. Cross-repository migration agents that can reason about service boundaries, API contracts, and deployment ordering are an active research area.

### Self-Improving Migration Systems

Uber's approach of learning from historical developer migrations to generate new rules suggests a broader pattern: migration systems that improve with each project. By analyzing the delta between automated output and human corrections, systems could continuously expand their rule coverage and reduce the human intervention rate over time.

### Specialized Foundation Models

Current systems use general-purpose foundation models (Gemini, Claude, GPT-4) for migration tasks. Fine-tuned models trained specifically on migration datasets show significantly improved performance [9]. As the volume of migration data grows (from tools like Codemod collecting community contributions), specialized migration models may emerge that outperform general-purpose models on this task class.

## Practical Implications for Agent Developers

For teams building AI agents and autonomous systems, the code migration landscape offers several transferable lessons:

**Hybrid architectures win.** The pattern of combining deterministic tools for precision with LLMs for flexibility applies far beyond code migration. Any agent task that requires both reliable detection and flexible generation benefits from this hybrid approach.

**Validation is the product.** The value of Google's system is not the LLM -- it is the six-level validation pipeline that makes the LLM's output trustworthy. For any agent task, the validation infrastructure determines whether the system is production-ready.

**Meta-level LLM use is underexplored.** Uber's pattern of using LLMs to generate rules rather than generate output is applicable to many agent tasks: using LLMs to write monitoring rules, generate test cases, create data validation schemas, or define workflow steps, rather than performing those tasks directly.

**Incremental automation compounds.** Google's 74% automation rate did not eliminate human work -- it transformed it from writing code to reviewing code. Even partial automation of repetitive tasks can yield dramatic productivity gains when applied at scale.

## References

1. Ziftci, C. et al. "Migrating Code At Scale With LLMs At Google." Proceedings of the 33rd ACM International Conference on the Foundations of Software Engineering (FSE 2025). https://arxiv.org/abs/2504.09691

2. Smith, T. "Large Scale Changes with AI -- Migrating Millions of Lines of Java to Kotlin at Uber." KotlinConf 2025. https://www.zenml.io/llmops-database/llm-driven-developer-experience-and-code-migrations-at-scale

3. "Environment-in-the-Loop: Rethinking Code Migration with LLM-based Agents." arXiv:2602.09944. https://arxiv.org/abs/2602.09944

4. "Code Modernization with Claude Code." Anthropic. https://claude.com/solutions/code-modernization

5. "Gen AI Assistant for Transformation and Modernization -- Amazon Q Developer: Transform." AWS. https://aws.amazon.com/q/developer/transform/

6. "Intelligent Code Modification at Scale." Codemod Blog. https://codemod.com/blog/codemod2

7. "ast-grep: Structural Search/Rewrite Tool for Many Languages." https://ast-grep.github.io/

8. "Automated JavaScript Refactoring at Enterprise Scale." Moderne. https://www.moderne.ai/blog/automated-javascript-refactoring-at-enterprise-scale

9. "Fine-tuned LLM-based Code Migration Framework." arXiv:2512.13515. https://arxiv.org/abs/2512.13515

10. "LLM Agents for Code Migration: Java to TypeScript Case Study." Aviator Blog. https://www.aviator.co/blog/llm-agents-for-code-migration-a-real-world-case-study/

11. "LLM Hallucinations in AI Code Review." diffray. https://diffray.ai/blog/llm-hallucinations-code-review/

12. "Programming Language Confusion: When Code LLMs Can't Keep Their Languages Straight." arXiv:2503.13620. https://arxiv.org/abs/2503.13620
