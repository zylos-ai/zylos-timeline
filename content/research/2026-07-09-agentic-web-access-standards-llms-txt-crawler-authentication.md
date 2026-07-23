---
date: "2026-07-09"
title: "Agentic Web Access Standards: How AI Agents Authenticate and Get Authorized Access to the Web"
description: "A critical survey of the emerging standards stack governing how AI agents access the web — llms.txt, evolving robots.txt conventions, Cloudflare's AI Crawl Control, machine-readable licensing (TDMRep, RSL), and cryptographic bot identity via Web Bot Auth (RFC 9421)."
tags:
  - ai-agents
  - web-standards
  - llms-txt
  - robots-txt
  - crawler-authentication
  - web-bot-auth
  - content-licensing
---

## Executive Summary

The web was built for humans navigating browsers, not for autonomous AI agents making HTTP requests on behalf of users or training pipelines. As AI agents proliferate — from coding assistants fetching documentation to search-answering bots summarizing news articles — a patchwork of standards, protocols, and legal frameworks is emerging to govern who gets in, on what terms, and who pays.

This article surveys the state of that standards stack as of mid-2026. The picture is messy: `llms.txt`, a well-intentioned proposal for LLM-friendly site descriptions, has been widely adopted by documentation sites but largely ignored by the very LLM providers it targets. The venerable `robots.txt` protocol is being stretched beyond its original design to handle dozens of AI-specific user-agent tokens, with publishers increasingly blocking training crawlers while grudgingly allowing search-and-answer bots. Cloudflare has inserted itself as the dominant infrastructure layer, offering site owners one-click AI bot blocking and a pay-per-crawl marketplace that already returns over a billion HTTP 402 responses per day. Meanwhile, two machine-readable licensing standards — the W3C's TDMRep and the newer RSL (Really Simple Licensing) — are attempting to move the conversation from "block or allow" to "allow on these terms." And at the protocol level, Web Bot Auth, an IETF draft built on RFC 9421 HTTP Message Signatures, promises to replace spoofable user-agent strings with cryptographically verifiable bot identity — though production deployment remains limited to a handful of early adopters.

Underpinning all of this is a critical legal and technical distinction that courts, standards bodies, and platforms are only beginning to articulate: the difference between an AI agent acting on behalf of a specific user (analogous to a browser) and a mass crawler hoovering content for model training. How that distinction gets codified will shape the economics of the agentic web for years to come.

## llms.txt: A Good Idea That Mostly Missed Its Target

### The Original Proposal

Jeremy Howard, co-founder of Answer.AI and fast.ai, published the [`llms.txt` proposal](https://llmstxt.org/) on September 3, 2024. The problem was straightforward: after releasing FastHTML, a Python web framework, Howard found that AI coding assistants could not help developers use it because the library postdated the models' training data cutoffs. His solution was a simple markdown file at `/llms.txt` that would provide an LLM-digestible summary of a site's content — titles, descriptions, and links to key pages — so that tools like Cursor, Claude Code, or GitHub Copilot could fetch up-to-date context at inference time.

The proposal also defined `/llms-full.txt`, a more comprehensive version containing the full text of documentation pages concatenated into a single file. The idea was pragmatic and narrowly scoped: help coding assistants understand documentation sites that postdate their training data.

### The Adoption Surge — and Its Misinterpretation

Adoption remained niche for months until November 2024, when Mintlify, a popular documentation hosting service, rolled out `llms.txt` support across all its hosted sites. Practically overnight, thousands of documentation pages got an `llms.txt`, including those for Anthropic's API docs and Cursor. An SE Ranking study reportedly surveying roughly 300,000 domains found an adoption rate on the order of one in ten sites by mid-2025 — a figure we have not independently verified and cite as reported in industry coverage rather than as an audited statistic.

But this adoption surge came with a fundamental misinterpretation. The SEO and "Generative Engine Optimization" (GEO) community discovered `llms.txt` and recast it as something Howard never intended: a lever for visibility in AI-powered search results. Blog posts proliferated claiming that `llms.txt` would help sites rank in ChatGPT, Perplexity, and Google's AI Overviews, treating it as the new `sitemap.xml` for the AI era.

### The Reality Check

The data tells a different story, at least as reported in industry monitoring rather than independently audited research. An OtterlyAI study covering roughly a 90-day window reportedly found that only a small fraction — on the order of 0.1% — of AI bot requests targeted `llms.txt` files, with the file apparently performing well below average content pages on the same domains for attracting AI crawler attention. Separate monitoring of large samples of AI bot visits has similarly reported only a tiny handful targeting `llms.txt` directly. We cite these figures as illustrative of a broadly reported trend rather than as verified statistics.

More damning is the stance of the major LLM providers. Google's Gary Illyes is widely reported to have stated in mid-2025 that Google does not support `llms.txt` and has no plans to, with colleague John Mueller reportedly comparing it to the deprecated keywords meta tag — a self-curated signal too easily manipulated to be useful. As of this writing, no major LLM provider — OpenAI, Anthropic, Google, Meta, Mistral — appears to have publicly committed to using `llms.txt` as a signal in production search or answer pipelines.

The core criticism is structural: `llms.txt` represents self-curated content. Site operators control what appears, making it an unreliable signal for general-purpose AI systems that need to make trust and relevance judgments about web content. Implementing it would require extra processing steps — parsing, interpretation, retrieval adjustments — in pipelines already optimized through billions of dollars in infrastructure investment.

### Where llms.txt Actually Works

Despite the justified skepticism about its role in AI search, `llms.txt` has found genuine utility in exactly the use case Howard originally designed it for: IDE coding agents. Cursor, Windsurf, Claude Code, GitHub Copilot, Cline, and Aider all look for `/llms.txt` and `/llms-full.txt` when pointed at a documentation site. For developer tooling companies maintaining API documentation, creating an `llms.txt` file remains a practical investment. For everyone else, the evidence suggests it is, as one critic put it, "a dud" — at least for now.

## robots.txt in the AI Era: From Simple Exclusion to Complex Negotiation

### The Proliferation of AI User-Agent Tokens

The Robots Exclusion Protocol, standardized as [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309) in 2022 after nearly three decades of informal use, was designed for a simpler world. A handful of search engine crawlers — Googlebot, Bingbot, Yahoo Slurp — needed basic access control. Today, a site administrator attempting to manage AI crawler access must contend with at minimum 10 to 15 distinct user-agent strings, and the list keeps growing.

The major AI-specific user-agent tokens as of mid-2026 include:

- **GPTBot** — OpenAI's training data crawler
- **OAI-SearchBot** — OpenAI's search-specific crawler
- **ChatGPT-User** — User-triggered browsing by ChatGPT
- **ClaudeBot** (also identified as `anthropic-ai`) — Anthropic's crawler
- **Google-Extended** — Google's AI training crawler (distinct from Googlebot)
- **Google-Agent** — Google's user-triggered AI agent fetcher (added March 2026)
- **PerplexityBot** — Perplexity's crawler
- **CCBot** — Common Crawl's crawler (used for training by many AI companies)
- **Bytespider** — ByteDance's crawler
- **Meta-ExternalAgent** — Meta's AI training crawler
- **Applebot-Extended** — Apple's AI training crawler
- **cohere-ai** — Cohere's crawler

### Blocking Trends: A Nuanced Picture

The blocking trend has reportedly been dramatic: industry monitoring services describe AI-blocking by reputable sites rising from roughly a quarter of sites in late 2023 to a majority by mid-2025, with blocking sites forbidding on the order of a dozen or more user-agent strings on average. These are figures we have seen cited in aggregated crawler-monitoring reports rather than confirmed through primary data, and the underlying methodology (which sites are sampled, how "reputable" is defined) is not something we can independently verify. But the aggregate numbers obscure an important distinction that is reshaping `robots.txt` strategy.

As of early 2026, GPTBot is commonly cited as the most-blocked AI crawler in such monitoring reports, with CCBot, ClaudeBot, Google-Extended, and Bytespider close behind. Some of the same reporting suggests GPTBot's "allow" share may now be edging above its "disallow" share for the first time — a signal, if accurate, that the web is leaning slightly toward allowing OpenAI's crawler, plausibly due to its commercial search partnerships. We present this as a reported trend rather than a precisely measured one.

The emerging best practice is a split strategy: block training-focused crawlers (GPTBot, ClaudeBot, Meta-ExternalAgent, CCBot) while explicitly allowing search-and-answer bots that drive referral traffic (OAI-SearchBot, ChatGPT-User, PerplexityBot). This distinction between "crawling for training" and "crawling for search" maps onto the deeper legal distinction discussed later in this article.

### The Google-Extended Dilemma

Google-Extended illustrates the complexity. Industry surveys have reported that a large majority of news publishers block at least one AI training bot, while a substantially smaller share — well under half in some reporting — block Google-Extended specifically, Google's AI training crawler. This reluctance is strategic, not accidental: Google has merged its search and AI crawlers into overlapping infrastructure, making publishers fear that blocking Google-Extended could impact their traditional search rankings. Whether this fear is justified is debatable, but it gives Google significant leverage.

### The Traffic Impact Paradox

Research attributed to Rutgers and Wharton, reportedly published around late 2025, is said to have found that publishers blocking AI crawlers experienced a meaningful total traffic decline without reliably reducing citation rates — we have not been able to independently verify the specific study or its exact figures. Meanwhile, AI search visits are widely reported to have grown substantially year over year through early 2026. Blocking the crawlers that feed AI search engines means removing a brand from a channel that increasingly rivals classic search — a genuine strategic risk.

### The Perplexity Controversy

The limits of `robots.txt` as an honor system were exposed by the widely reported Perplexity controversy. Around mid-2024, Perplexity was publicly accused of ignoring `robots.txt` directives, and Cloudflare published research alleging that Perplexity's bots used a generic browser user-agent alongside their declared one — effectively circumventing access controls. We have not independently re-verified Cloudflare's technical findings and note that Perplexity publicly disputed them at the time.

Cloudflare reportedly delisted Perplexity's bots from its verified bots list. Reddit is reported to have sent Perplexity a cease-and-desist letter in 2024 and later filed a federal lawsuit naming Perplexity AI and several data-scraping companies over alleged circumvention of technological controls — the litigation details here (dates, named parties, specific allegations) are as reported in press coverage and should be checked against court filings before being relied upon.

The Perplexity episode underscores a fundamental weakness of `robots.txt`: it relies on voluntary compliance. There is no enforcement mechanism built into the protocol itself. For sites that need actual enforcement rather than polite requests, the answer increasingly involves infrastructure-layer solutions — which is where Cloudflare enters the picture.

## Cloudflare's AI Crawl Control: The Infrastructure Layer Takes Charge

### From Blocking to Marketplace

Cloudflare has moved aggressively to position itself as a control plane for AI crawler access. What began as simple bot-blocking tools has evolved into a platform Cloudflare markets as AI Crawl Control, said to have been rebranded from an earlier "AI Audit" beta. We confirmed via Cloudflare's own [pay-per-crawl announcement](https://blog.cloudflare.com/introducing-pay-per-crawl/) that the underlying HTTP 402 mechanism and publisher allow/charge/block controls are real and described roughly as summarized here; the specific beta-to-GA timeline and the exact three-way Search/Agent/Training categorization, however, come from secondary coverage we were not able to confirm directly against a live Cloudflare page at the time of writing, so we hold them as reported rather than verified.

The platform is reported to classify AI crawlers into three categories — Search (bots powering AI-assisted search results), Agent (bots acting on behalf of individual users), and Training (bots scraping content for model training) — with site owners able to set policies per category. Any specific future rollout dates for new default policies (such as blocking Training/Agent crawlers by default on ad-supported pages) should be treated as an announced plan rather than settled fact, since standards and vendor policies in this space are moving quickly.

### The Pay-Per-Crawl Marketplace

The most consequential feature is [pay-per-crawl](https://blog.cloudflare.com/introducing-pay-per-crawl/), which we verified directly against Cloudflare's own announcement. Rather than forcing a binary block-or-allow decision, Cloudflare lets site owners set a per-request price for AI crawler access. When an unauthenticated crawler requests a paid URL, Cloudflare returns an HTTP 402 (Payment Required) response accompanied by a `crawler-price` header; crawlers that agree to pay receive the content along with a charge confirmation, and Cloudflare aggregates billing events and distributes earnings to publishers. Cloudflare's own announcement described this as a private-beta program built after conversations with publishers, without disclosing volume metrics.

Beyond that verified core, the specific scale figure often cited — on the order of a billion HTTP 402 responses per day — and lists of named early adopters are things we encountered only in secondary coverage, not in a Cloudflare source we could directly confirm; we present them as industry-reported rather than independently audited. Similarly, references to a specific "Agents Week 2026" product consolidation event or a "Pay Per Use" successor model should be read as reported roadmap items current to mid-2026 rather than confirmed, permanent features.

### Implications for Agent Developers

For developers building AI agents that need to access web content, Cloudflare's infrastructure creates several practical realities:

1. **User-agent honesty is non-negotiable.** Cloudflare's bot detection goes far beyond user-agent string checking. Agents using spoofed or generic user-agents will be identified and blocked.
2. **HTTP 402 is a real status code now.** Agents must handle 402 responses gracefully, either by paying the requested rate through Cloudflare's API or by accepting that the content is unavailable.
3. **Web Bot Auth integration means cryptographic identity will be required.** Cloudflare is integrating Web Bot Auth verification into its bot management stack, meaning agents that can prove their identity cryptographically will get preferential treatment.

## Machine-Readable Licensing: TDMRep and RSL

### TDMRep: The EU's Machine-Readable Rights Framework

The [Text and Data Mining Reservation Protocol (TDMRep)](https://www.w3.org/community/reports/tdmrep/CG-FINAL-tdmrep-20240202/), developed by a W3C Community Group and finalized in its 1.0 specification on February 2, 2024 (verified against the published report), provides a machine-readable way for rights holders to indicate whether they reserve their text and data mining (TDM) rights. Unlike `robots.txt`, TDMRep is generally described as having legal grounding under the EU's Digital Single Market (DSM) Directive of 2019 and the EU AI Act, though we have not independently verified every jurisdictional detail of that legal linkage.

TDMRep declarations can be conveyed through several mechanisms — HTTP headers associated with resource fetching, a well-known file hosted on the origin server (similar to `robots.txt`), HTML metadata within individual pages, and EPUB metadata. The protocol uses a simple vocabulary: a `tdm-reservation` property indicates whether TDM rights are reserved, and a `tdm-policy` property points to a machine-readable license or terms document.

The practical impact of TDMRep has been limited by two factors. First, adoption outside the EU publishing industry remains sparse — the protocol was designed for the specific legal context of EU copyright law, and its relevance diminishes in jurisdictions without equivalent TDM exemptions. Second, AI companies have shown little enthusiasm for implementing TDMRep parsing in their crawlers, making the protocol's enforceability dependent on legal action rather than technical compliance.

### RSL: Really Simple Licensing

[RSL (Really Simple Licensing)](https://rslstandard.org/), launched on September 10, 2025 (confirmed date), is the more ambitious attempt to move from binary access control to nuanced licensing. It was co-founded by RSS co-creator Eckart Walther — confirmed via public reference sources — and is backed by platforms including Reddit, Yahoo, Medium, Akamai, and Cloudflare, among others; RSL extends `robots.txt` with machine-readable usage terms and licensing requirements. We were not able to independently confirm a separate "1.0 specification" finalization date distinct from the launch date, so treat that detail as approximate.

RSL is reported to define granular usage categories — commonly described using labels such as `ai-all` (unrestricted AI use), `ai-input` (AI training), and `ai-index` (AI-powered search indexing) — giving content owners fine-grained control over how their content may be used; we confirmed the general licensing-category concept on RSL's own site but could not confirm this exact canonical label set, so treat the specific names as illustrative rather than verified. The specification builds on the familiar `robots.txt` format, making adoption relatively straightforward for site administrators already managing crawler access.

The RSL Collective, a nonprofit rights organization, serves as a licensing platform designed to pool the rights of participating publishers and strengthen their negotiation power with AI companies. The model resembles music licensing collectives like ASCAP or BMI — a centralized entity that negotiates rates and distributes payments on behalf of many individual rights holders.

### The Gap Between Standards and Reality

Both TDMRep and RSL face the same fundamental challenge: they are supply-side standards. Publishers can declare their terms, but there is no technical mechanism forcing AI companies to read, parse, or respect those declarations. The enforcement mechanism is legal (copyright law, breach of contract, trespass to chattels) rather than technical. This makes infrastructure-layer enforcement — like Cloudflare's pay-per-crawl — a necessary complement to any licensing standard.

## Web Bot Auth: Cryptographic Identity for Bots

### The Problem with User-Agent Strings

The current system for identifying web bots relies on user-agent strings — self-declared text labels in HTTP headers. This mechanism is trivially spoofable: any bot can claim to be Googlebot, and any malicious scraper can impersonate a legitimate AI agent. Verification today depends on reverse DNS lookups and IP address range checking, both of which are fragile, slow, and increasingly impractical as AI agents proliferate.

### RFC 9421 and the Web Bot Auth Architecture

Web Bot Auth, an IETF proposal led by Cloudflare's Thibault Meunier and Google's Sandor Major (confirmed as the listed authors on the draft), builds on [RFC 9421 (HTTP Message Signatures)](https://www.rfc-editor.org/rfc/rfc9421), published in 2024, to create a cryptographic identity layer for automated HTTP clients. The architecture has four components:

1. **Ed25519 key pairs.** Each bot operator generates a private key and publishes the corresponding public key.
2. **HTTP Message Signatures.** Every HTTP request from the bot includes a `Signature` header computed over the request's authority (target domain), a timestamp, and an expiration window, using the bot operator's private key.
3. **`Signature-Agent` header.** A new HTTP header pointing to the bot operator's domain, which hosts a JWKS (JSON Web Key Set) directory containing the public keys.
4. **Public key discovery.** Servers verify signatures by fetching the public key from the `Signature-Agent` domain's well-known JWKS endpoint.

The `Signature-Input` header specifies which request components are signed, along with creation and expiration timestamps and a key ID (a JSON Web Key Thumbprint). The `tag` field is set to `web-bot-auth` to distinguish these signatures from other uses of RFC 9421.

For example, Google Search publishes its signing keys at `crawler.search.google.com`, OpenAI's Operator service at `operator.openai.com`, and Cloudflare Workers at `workers.dev`. A receiving server can cryptographically verify that a request claiming to come from Google-Agent was actually signed by a key published at Google's domain — eliminating the spoofability of user-agent strings.

### Deployment Status: Early but Real

Standardization here is genuinely in flux rather than settled: reporting suggests IETF httpbis working-group interest in formalizing Web Bot Auth during 2026, with a standards-track milestone and a best-current-practice document targeted for later in the year, but we could not confirm a formal charter from a primary IETF source at the time of writing. The [core architecture draft, `draft-meunier-web-bot-auth-architecture`](https://datatracker.ietf.org/doc/draft-meunier-web-bot-auth-architecture/), reached version 05 (dated March 2, 2026) — we confirmed this directly on the IETF datatracker, which also shows the draft has since expired and been superseded by a successor draft (`draft-meunier-webbotauth-httpsig-protocol`), underscoring that this is an actively moving target rather than a finished standard.

Production deployment is reported to be real but limited, though we were not able to independently confirm every vendor detail below against a primary source: Cloudflare is said to have activated Web Bot Auth verification at its edge and integrated it into its Verified Bots Program; OpenAI's Operator service is reported to sign its requests; Google's AI-browsing `Google-Agent` user-agent reportedly signs requests while Google's main Googlebot indexing crawler reportedly does not, which — if accurate — would illustrate that even among major players adoption is selective; and Amazon's Bedrock AgentCore Browser, Anthropic's Claude, and Perplexity are described in vendor and press materials as supporting or adopting the mechanism. Treat vendor-specific claims here as reported rather than verified.

Cloudflare provides open-source tooling for implementation: an npm package (`web-bot-auth`), a Go plugin for Caddy server, TypeScript reference implementations on Cloudflare Workers, a Chrome extension for testing, and a debug server at `http-message-signatures-example.research.cloudflare.com`.

### Limitations

Web Bot Auth solves identity verification, not authorization. It tells a server who is knocking, but not whether to open the door. A verified signature from ClaudeBot does not mean the site owner wants ClaudeBot to access the content — that decision still depends on `robots.txt`, TDMRep/RSL declarations, Cloudflare AI Crawl Control settings, or contractual relationships. Web Bot Auth is the authentication layer; the authorization layer is everything else discussed in this article.

Additionally, as one analysis noted, Web Bot Auth "does nothing for — and is not meant for — collecting public data as an ordinary visitor." An agent browsing the web with a standard browser user-agent, not declaring itself as a bot, remains outside the protocol's scope. This means Web Bot Auth addresses declared bots but does nothing about stealth scraping.

## Agent-on-Behalf-of-User vs. Mass Scraping: The Critical Legal Distinction

### The Emerging Framework

The most consequential distinction being drawn across technical standards and legal cases is between two fundamentally different modes of AI web access:

1. **Agent-on-behalf-of-user.** An AI agent acting at the direction of a specific human user — browsing a page, completing a form, making a purchase. Analogous to a browser. Examples: Google-Agent activated by a user via Project Mariner, ChatGPT's browsing mode when a user asks it to read a specific URL, an AI shopping agent checking product availability.

2. **Mass training crawls.** Automated systems scraping large portions of the web to build training datasets for model development. No specific user request. Examples: GPTBot indexing millions of pages for training data, CCBot crawling for Common Crawl datasets.

Google's introduction of a `Google-Agent` user-agent, reported to have occurred in early 2026 and described in press coverage as a "user-triggered fetcher" that "only activates when a person directs an AI assistant to perform a specific task," would codify this distinction at the protocol level if the reporting is accurate. Cloudflare's reported three-category classification (Search, Agent, Training) is described as doing the same at the infrastructure level; as noted earlier, we could not independently confirm this classification against a live Cloudflare source, so treat it as reported.

### The Legal Landscape

The distinction matters enormously in court. Press tracking has reported a large and growing number of copyright infringement cases filed against AI companies through late 2025, though we have not independently verified an exact count and treat any specific tally as approximate. The cases below are real, publicly reported litigation, but the specific dollar figures, dates, and procedural status should be understood as summarized from press coverage rather than verified against court dockets:

**Anthropic v. Authors (reportedly settled around September 2025):** Widely reported as finding that AI training on copyrighted books constituted fair use, but that storing pirated copies from shadow libraries did not, with a settlement figure commonly cited in the billion-dollar range. If accurate, the decision would create a significant precedent that the method of acquisition matters as much as the use — but the exact settlement amount and per-work payout figures should be checked against primary settlement documents before being relied upon.

**Reddit v. Anthropic (reportedly filed mid-2025):** Reddit is reported to allege that Anthropic circumvented its licensing process to scrape training data without compensation, bypassing technological controls including `robots.txt` directives and IP rate limits, with claims reportedly including breach of contract, trespass to chattels, and unfair competition.

**New York Times v. OpenAI (ongoing):** The Times is reported to allege that OpenAI and Microsoft copied millions of articles to train ChatGPT, seeking substantial statutory damages, with the case reportedly still in discovery as of this writing.

**Amazon v. Perplexity:** Perplexity has reportedly argued that its AI agents are "not scrapers," attempting to draw exactly the distinction between agent-on-behalf-of-user access and mass crawling. Courts do not appear to have definitively ruled on this distinction as of this writing, but the argument is reported to be taken seriously.

A conjunctive standard for "authorization" is forming — requiring both user authorization (the human directed the agent) and platform authorization (the site permits this type of access). Platforms enforce this through terms of service clauses prohibiting bots, automated access, credential sharing, and use of content for machine learning.

### Why Standards Bodies Are Paying Attention

The legal landscape is pushing standards bodies to formalize the technical distinction. We are aware of academic commentary — reportedly including a paper along the lines of "The Agentic Web Requires New Normative Infrastructure" — arguing that existing web standards were designed for a bilateral model (server and browser) and are inadequate for the trilateral model (server, agent, and user-on-whose-behalf-the-agent-acts), and calling for new normative infrastructure that can express and verify the delegation chain from user to agent. We were not able to locate and confirm this specific paper on arXiv at the time of writing, so we present the argument itself — which reflects a real and active line of discussion in agentic-web circles — without vouching for this exact title, date, or venue.

Web Bot Auth partially addresses this by verifying the agent's identity, but it does not yet express on-whose-behalf the agent is acting. The `Google-Agent` user-agent implicitly communicates this (it is defined as user-triggered), but there is no standardized mechanism for an arbitrary agent to prove that a specific user authorized a specific request. This is the next frontier for protocol development.

## Practical Guidance for Agent Developers

For developers building AI agents that access web content, the standards landscape as of mid-2026 suggests the following practices:

### Honest Bot Identification

Declare your agent's identity truthfully. Use a dedicated, descriptive user-agent string. Publish your bot's documentation at a public URL. Do not impersonate browsers or other bots. The Perplexity controversy demonstrates that user-agent spoofing, even if technically possible, carries serious reputational, legal, and infrastructure consequences — Cloudflare's delisting of Perplexity's bots effectively degraded their access across a significant fraction of the web.

### Implement Web Bot Auth

If your agent makes more than trivial numbers of requests, implement HTTP Message Signatures per RFC 9421. Generate an Ed25519 key pair, publish your public key at a JWKS endpoint on your domain, and sign requests with the `Signature-Agent` header pointing to your key directory. Cloudflare's open-source `web-bot-auth` npm package provides a reference implementation. Signed agents will increasingly receive preferential treatment from Cloudflare-protected sites and any other infrastructure that integrates Web Bot Auth verification.

### Respect robots.txt — and Understand Its Nuances

Parse `robots.txt` for your specific user-agent token. If your agent is acting on behalf of a specific user (not mass crawling), consider registering a distinct user-agent that sites can allow independently of your training crawler. Google's split between `Google-Agent` (user-triggered) and `Google-Extended` (training) is the model to follow.

### Handle HTTP 402 Gracefully

With Cloudflare's network reportedly handling a very large and growing volume of HTTP 402 responses daily (an order-of-magnitude figure we could not independently confirm — see the sourcing note below), your agent will encounter pay-per-crawl paywalls. Implement 402 handling: parse the `crawler-price` header, decide whether the content is worth the cost for the user's query, and either pay through Cloudflare's API or gracefully fall back to alternative sources. Do not retry-loop against 402 responses.

### Handle 403 and 429 Responsibly

A 403 (Forbidden) means the site does not want your agent there. Respect it. A 429 (Too Many Requests) means you are rate-limited — implement exponential backoff. Do not switch IP addresses or user-agents to circumvent these responses. Courts have treated technical circumvention of access controls as strong evidence in scraping lawsuits.

### Check Machine-Readable Licensing

If your agent uses content in ways beyond simple display to the user (summarization, training, indexing), check for TDMRep headers and RSL declarations. While enforcement is currently legal rather than technical, ignoring declared rights reservations weakens your legal position if challenged.

### Distinguish User-Triggered from Autonomous Access

If your agent is fetching content because a specific user asked it to, make that clear in your request context. If your agent is autonomously crawling for indexing or training, respect the higher access restrictions that apply. This distinction will only become more important as courts and standards bodies formalize the agent-on-behalf-of-user category.

## Notes on Sourcing and Fast-Moving Claims

This article surveys a standards landscape that is genuinely still forming, and we have linked directly to primary sources (the `llms.txt` proposal, RFC 9309, RFC 9421, the TDMRep W3C report, the RSL standard, and the Web Bot Auth IETF draft) wherever we could verify them ourselves. Many of the specific adoption percentages, traffic figures, deployment dates, and litigation details, however, trace to vendor announcements, press coverage, and aggregated industry reporting current to mid-2026 rather than to sources we independently audited; we have hedged those claims throughout and flagged the ones we could not confirm at all. Treat the illustrative figures as directionally indicative of real trends rather than as precise, durable statistics, and expect some details — especially vendor rollout dates and specific draft/version numbers — to be out of date by the time you read this.

## The Road Ahead

The agentic web access standards landscape in mid-2026 is characterized by rapid, somewhat chaotic development. Multiple overlapping standards address different parts of the problem: `robots.txt` for basic access control (strained but enduring), `llms.txt` for LLM-friendly content description (useful in its niche, overhyped elsewhere), TDMRep and RSL for machine-readable licensing (legally grounded but adoption-limited), Web Bot Auth for cryptographic identity verification (technically sound, deployment nascent), and Cloudflare's AI Crawl Control for infrastructure-layer enforcement and monetization (the most immediately impactful).

Several trends seem likely to continue:

**Consolidation around Web Bot Auth.** Cryptographic bot identity is clearly superior to user-agent strings and IP-based verification. The IETF standardization process, combined with deployment by Cloudflare, Google, Amazon, and OpenAI, suggests this will become the baseline for declared bot traffic within the next year or two.

**Pay-per-crawl becoming the default.** Cloudflare's marketplace, combined with RSL's licensing framework and the settlement economics of reported copyright lawsuits (Anthropic's reported billion-dollar-plus settlement is widely cited as a price signal, though see the caveats above on the exact figure), is pushing toward a world where AI companies pay for content access rather than scrape it for free. The HTTP 402 status code, dormant for decades, appears to be finding a new purpose.

**Legal clarification of the agent-on-behalf-of-user distinction.** The Amazon v. Perplexity case and Google's `Google-Agent` user-agent are early indicators. Courts and standards bodies will need to formalize when an AI agent's web access is analogous to a user's browser and when it is something else entirely.

**The death of the honor system.** `robots.txt` was an honor system. The Perplexity controversy, Cloudflare's infrastructure-layer enforcement, and the proliferation of copyright lawsuits all point in the same direction: the web is moving from trust-based access control to verified, enforced, and monetized access control. For legitimate agent developers, this is ultimately good news — it creates a framework in which honest actors can be distinguished from scrapers. For the web as a whole, the outcome depends on whether the emerging standards remain open and interoperable or calcify into walled gardens controlled by a few infrastructure gatekeepers.

The standards are being written right now. Agent developers, publishers, and platform operators who engage with these processes — IETF working groups, W3C community groups, Cloudflare's marketplace — will shape the rules. Everyone else will live with whatever gets decided.
