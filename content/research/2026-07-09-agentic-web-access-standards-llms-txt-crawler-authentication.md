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

Jeremy Howard, co-founder of Answer.AI and fast.ai, published the `llms.txt` proposal on September 3, 2024. The problem was straightforward: after releasing FastHTML, a Python web framework, Howard found that AI coding assistants could not help developers use it because the library postdated the models' training data cutoffs. His solution was a simple markdown file at `/llms.txt` that would provide an LLM-digestible summary of a site's content — titles, descriptions, and links to key pages — so that tools like Cursor, Claude Code, or GitHub Copilot could fetch up-to-date context at inference time.

The proposal also defined `/llms-full.txt`, a more comprehensive version containing the full text of documentation pages concatenated into a single file. The idea was pragmatic and narrowly scoped: help coding assistants understand documentation sites that postdate their training data.

### The Adoption Surge — and Its Misinterpretation

Adoption remained niche for months until November 2024, when Mintlify, a popular documentation hosting service, rolled out `llms.txt` support across all its hosted sites. Practically overnight, thousands of documentation pages got an `llms.txt`, including those for Anthropic's API docs and Cursor. By mid-2025, an SE Ranking study of 300,000 domains found a 10.13% adoption rate — roughly one in ten sites.

But this adoption surge came with a fundamental misinterpretation. The SEO and "Generative Engine Optimization" (GEO) community discovered `llms.txt` and recast it as something Howard never intended: a lever for visibility in AI-powered search results. Blog posts proliferated claiming that `llms.txt` would help sites rank in ChatGPT, Perplexity, and Google's AI Overviews, treating it as the new `sitemap.xml` for the AI era.

### The Reality Check

The data tells a different story. An OtterlyAI 90-day study found that only 84 out of 62,100 AI bot requests targeted `llms.txt` files — a 0.1% hit rate. The file performed three times worse than average content pages on the same domains for attracting AI crawler attention. Monitoring of over 500 million AI bot visits showed only 408 that targeted `llms.txt` directly.

More damning is the stance of the major LLM providers. Google's Gary Illyes confirmed in July 2025 that Google does not support `llms.txt` and has no plans to. Google's John Mueller compared it to the deprecated keywords meta tag — a self-curated signal too easily manipulated to be useful. No major LLM provider — OpenAI, Anthropic, Google, Meta, Mistral — has publicly committed to using `llms.txt` as a signal in their production search or answer pipelines.

The core criticism is structural: `llms.txt` represents self-curated content. Site operators control what appears, making it an unreliable signal for general-purpose AI systems that need to make trust and relevance judgments about web content. Implementing it would require extra processing steps — parsing, interpretation, retrieval adjustments — in pipelines already optimized through billions of dollars in infrastructure investment.

### Where llms.txt Actually Works

Despite the justified skepticism about its role in AI search, `llms.txt` has found genuine utility in exactly the use case Howard originally designed it for: IDE coding agents. Cursor, Windsurf, Claude Code, GitHub Copilot, Cline, and Aider all look for `/llms.txt` and `/llms-full.txt` when pointed at a documentation site. For developer tooling companies maintaining API documentation, creating an `llms.txt` file remains a practical investment. For everyone else, the evidence suggests it is, as one critic put it, "a dud" — at least for now.

## robots.txt in the AI Era: From Simple Exclusion to Complex Negotiation

### The Proliferation of AI User-Agent Tokens

The Robots Exclusion Protocol, standardized as RFC 9309 in 2022 after nearly three decades of informal use, was designed for a simpler world. A handful of search engine crawlers — Googlebot, Bingbot, Yahoo Slurp — needed basic access control. Today, a site administrator attempting to manage AI crawler access must contend with at minimum 10 to 15 distinct user-agent strings, and the list keeps growing.

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

The blocking trend has been dramatic. AI-blocking by reputable sites increased from 23% in September 2023 to nearly 60% by May 2025, with sites that block AI crawlers forbidding an average of 15.5 user-agent strings. But the aggregate numbers obscure an important distinction that is reshaping `robots.txt` strategy.

In Q1 2026, GPTBot was the most-blocked AI crawler, appearing in 5.52% of disallow rules, ahead of CCBot (5.08%), ClaudeBot (4.88%), Google-Extended (4.44%), and Bytespider (4.23%). However, GPTBot's allow share (5.84%) now sits above its disallow share for the first time — suggesting the web is leaning slightly toward allowing OpenAI's crawler, likely due to its commercial search partnerships.

The emerging best practice is a split strategy: block training-focused crawlers (GPTBot, ClaudeBot, Meta-ExternalAgent, CCBot) while explicitly allowing search-and-answer bots that drive referral traffic (OAI-SearchBot, ChatGPT-User, PerplexityBot). This distinction between "crawling for training" and "crawling for search" maps onto the deeper legal distinction discussed later in this article.

### The Google-Extended Dilemma

Google-Extended illustrates the complexity. While 79% of news publishers block at least one AI training bot, only 46% block Google-Extended — Google's AI training crawler. This reluctance is strategic, not accidental: Google has merged its search and AI crawlers into overlapping infrastructure, making publishers fear that blocking Google-Extended could impact their traditional search rankings. Whether this fear is justified is debatable, but it gives Google significant leverage.

### The Traffic Impact Paradox

Rutgers and Wharton research published in December 2025 found that publishers blocking AI crawlers experienced a 23.1% total traffic decline without reliably reducing citation rates. Meanwhile, AI search visits grew 42.8% year over year, climbing from 15.6 billion to 27.4 billion between Q1 2025 and Q1 2026. Blocking the crawlers that feed AI search engines means removing a brand from a channel that increasingly rivals classic search — a genuine strategic risk.

### The Perplexity Controversy

The limits of `robots.txt` as an honor system were exposed by the Perplexity controversy. In mid-2024, Perplexity was accused of ignoring `robots.txt` directives. Cloudflare later published research documenting that Perplexity's bots used not only their declared user-agent but also a generic browser user-agent designed to impersonate Google Chrome on macOS — effectively circumventing access controls.

Cloudflare delisted Perplexity's bots from its verified bots list and deployed new blocking techniques. Perplexity called Cloudflare's report "a sales pitch" and disputed that the identified bot belonged to them. Reddit sent a cease-and-desist letter to Perplexity in May 2024; subsequently, the volume of Reddit data cited by Perplexity increased forty-fold. Reddit filed a federal lawsuit on October 22, 2025, naming Perplexity AI and several data-scraping companies for circumventing technological controls.

The Perplexity episode underscores a fundamental weakness of `robots.txt`: it relies on voluntary compliance. There is no enforcement mechanism built into the protocol itself. For sites that need actual enforcement rather than polite requests, the answer increasingly involves infrastructure-layer solutions — which is where Cloudflare enters the picture.

## Cloudflare's AI Crawl Control: The Infrastructure Layer Takes Charge

### From Blocking to Marketplace

Cloudflare has moved aggressively to position itself as the default control plane for AI crawler access. What began as simple bot-blocking tools has evolved into a comprehensive platform that Cloudflare calls AI Crawl Control — rebranded from its earlier "AI Audit" beta that launched in the first half of 2025 and reached general availability in August 2025.

The platform classifies AI crawlers into three categories: Search (bots that power AI-assisted search results), Agent (bots acting on behalf of individual users), and Training (bots scraping content for model training). Site owners can set policies for each category independently. Starting September 15, 2026, Cloudflare will implement new defaults: Training and Agent crawlers will be blocked by default on pages that display ads, while Search crawlers will remain allowed by default.

### The Pay-Per-Crawl Marketplace

The most consequential feature is pay-per-crawl. Rather than forcing a binary block-or-allow decision, Cloudflare enables site owners to set a per-request price for AI crawler access. When an unauthenticated crawler requests a paid URL, Cloudflare returns an HTTP 402 (Payment Required) response accompanied by a `crawler-price` header. Authenticated crawlers that agree to pay receive the content along with a `crawler-charged` header; Cloudflare aggregates billing events and distributes earnings to publishers.

The scale is already significant. On an average day, Cloudflare customers send over one billion HTTP 402 responses to AI crawlers. Early adopters of the marketplace include Conde Nast, Time, the Associated Press, BuzzFeed, Reddit, Pinterest, and Stack Overflow.

During Agents Week 2026 (April 13-17), Cloudflare consolidated the pay-per-crawl framework into a single operator console available across every plan tier, including free accounts. The company is also evolving the model toward "Pay Per Use" — charging AI companies when publisher content creates value in AI outputs, not just when a bot fetches it.

### Implications for Agent Developers

For developers building AI agents that need to access web content, Cloudflare's infrastructure creates several practical realities:

1. **User-agent honesty is non-negotiable.** Cloudflare's bot detection goes far beyond user-agent string checking. Agents using spoofed or generic user-agents will be identified and blocked.
2. **HTTP 402 is a real status code now.** Agents must handle 402 responses gracefully, either by paying the requested rate through Cloudflare's API or by accepting that the content is unavailable.
3. **Web Bot Auth integration means cryptographic identity will be required.** Cloudflare is integrating Web Bot Auth verification into its bot management stack, meaning agents that can prove their identity cryptographically will get preferential treatment.

## Machine-Readable Licensing: TDMRep and RSL

### TDMRep: The EU's Machine-Readable Rights Framework

The Text and Data Mining Reservation Protocol (TDMRep), developed by a W3C Community Group and finalized in its 1.0 specification in February 2024, provides a machine-readable way for rights holders to indicate whether they reserve their text and data mining (TDM) rights. Unlike `robots.txt`, TDMRep has direct legal backing under the EU's Digital Single Market (DSM) Directive of 2019 and the EU AI Act.

TDMRep declarations can be conveyed through three mechanisms: HTTP headers associated with resource fetching, a well-known file hosted on the origin server (similar to `robots.txt`), or HTML metadata within individual pages. The protocol uses a simple vocabulary: a `tdm-reservation` property indicates whether TDM rights are reserved, and a `tdm-policy` property points to a machine-readable license or terms document.

The practical impact of TDMRep has been limited by two factors. First, adoption outside the EU publishing industry remains sparse — the protocol was designed for the specific legal context of EU copyright law, and its relevance diminishes in jurisdictions without equivalent TDM exemptions. Second, AI companies have shown little enthusiasm for implementing TDMRep parsing in their crawlers, making the protocol's enforceability dependent on legal action rather than technical compliance.

### RSL: Really Simple Licensing

RSL (Really Simple Licensing), announced in September 2025 with its 1.0 specification finalized in December 2025, is the more ambitious attempt to move from binary access control to nuanced licensing. Created by RSS co-creator Eckart Walther and backed by major platforms including Reddit, Yahoo, Medium, and Quora, RSL extends `robots.txt` with machine-readable usage terms and licensing requirements.

RSL defines granular usage categories: `ai-all` (unrestricted AI use), `ai-input` (AI training), `ai-index` (AI-powered search indexing), and others, giving content owners fine-grained control over how their content may be used. The specification builds on the familiar `robots.txt` format, making adoption relatively straightforward for site administrators already managing crawler access.

The RSL Collective, a newly formed nonprofit rights organization, serves as a licensing platform designed to pool the rights of participating publishers and strengthen their negotiation power with AI companies. The model resembles music licensing collectives like ASCAP or BMI — a centralized entity that negotiates rates and distributes payments on behalf of many individual rights holders.

### The Gap Between Standards and Reality

Both TDMRep and RSL face the same fundamental challenge: they are supply-side standards. Publishers can declare their terms, but there is no technical mechanism forcing AI companies to read, parse, or respect those declarations. The enforcement mechanism is legal (copyright law, breach of contract, trespass to chattels) rather than technical. This makes infrastructure-layer enforcement — like Cloudflare's pay-per-crawl — a necessary complement to any licensing standard.

## Web Bot Auth: Cryptographic Identity for Bots

### The Problem with User-Agent Strings

The current system for identifying web bots relies on user-agent strings — self-declared text labels in HTTP headers. This mechanism is trivially spoofable: any bot can claim to be Googlebot, and any malicious scraper can impersonate a legitimate AI agent. Verification today depends on reverse DNS lookups and IP address range checking, both of which are fragile, slow, and increasingly impractical as AI agents proliferate.

### RFC 9421 and the Web Bot Auth Architecture

Web Bot Auth, an IETF proposal led by Cloudflare's Thibault Meunier and Google's Sandor Major, builds on RFC 9421 (HTTP Message Signatures), published in February 2024, to create a cryptographic identity layer for automated HTTP clients. The architecture has four components:

1. **Ed25519 key pairs.** Each bot operator generates a private key and publishes the corresponding public key.
2. **HTTP Message Signatures.** Every HTTP request from the bot includes a `Signature` header computed over the request's authority (target domain), a timestamp, and an expiration window, using the bot operator's private key.
3. **`Signature-Agent` header.** A new HTTP header pointing to the bot operator's domain, which hosts a JWKS (JSON Web Key Set) directory containing the public keys.
4. **Public key discovery.** Servers verify signatures by fetching the public key from the `Signature-Agent` domain's well-known JWKS endpoint.

The `Signature-Input` header specifies which request components are signed, along with creation and expiration timestamps and a key ID (a JSON Web Key Thumbprint). The `tag` field is set to `web-bot-auth` to distinguish these signatures from other uses of RFC 9421.

For example, Google Search publishes its signing keys at `crawler.search.google.com`, OpenAI's Operator service at `operator.openai.com`, and Cloudflare Workers at `workers.dev`. A receiving server can cryptographically verify that a request claiming to come from Google-Agent was actually signed by a key published at Google's domain — eliminating the spoofability of user-agent strings.

### Deployment Status: Early but Real

The IETF httpbis working group chartered Web Bot Auth in early 2026, with a standards-track specification milestone in April 2026 and a best-current-practice document targeted for August 2026. The core architecture is documented in `draft-meunier-web-bot-auth-architecture-05`, published March 2, 2026.

Production deployment is real but limited. Cloudflare activated Web Bot Auth verification at its edge in March 2026 and integrated it into its Verified Bots Program, available on Free and Pro tiers. OpenAI's Operator service signs its requests. Google's AI-browsing `Google-Agent` user-agent signs requests, though notably, Google's main Googlebot indexing crawler does not — illustrating that even among major players, adoption is selective. Amazon's Bedrock AgentCore Browser can automatically sign requests. Anthropic's Claude and Perplexity are listed as supporting agents.

Cloudflare provides open-source tooling for implementation: an npm package (`web-bot-auth`), a Go plugin for Caddy server, TypeScript reference implementations on Cloudflare Workers, a Chrome extension for testing, and a debug server at `http-message-signatures-example.research.cloudflare.com`.

### Limitations

Web Bot Auth solves identity verification, not authorization. It tells a server who is knocking, but not whether to open the door. A verified signature from ClaudeBot does not mean the site owner wants ClaudeBot to access the content — that decision still depends on `robots.txt`, TDMRep/RSL declarations, Cloudflare AI Crawl Control settings, or contractual relationships. Web Bot Auth is the authentication layer; the authorization layer is everything else discussed in this article.

Additionally, as one analysis noted, Web Bot Auth "does nothing for — and is not meant for — collecting public data as an ordinary visitor." An agent browsing the web with a standard browser user-agent, not declaring itself as a bot, remains outside the protocol's scope. This means Web Bot Auth addresses declared bots but does nothing about stealth scraping.

## Agent-on-Behalf-of-User vs. Mass Scraping: The Critical Legal Distinction

### The Emerging Framework

The most consequential distinction being drawn across technical standards and legal cases is between two fundamentally different modes of AI web access:

1. **Agent-on-behalf-of-user.** An AI agent acting at the direction of a specific human user — browsing a page, completing a form, making a purchase. Analogous to a browser. Examples: Google-Agent activated by a user via Project Mariner, ChatGPT's browsing mode when a user asks it to read a specific URL, an AI shopping agent checking product availability.

2. **Mass training crawls.** Automated systems scraping large portions of the web to build training datasets for model development. No specific user request. Examples: GPTBot indexing millions of pages for training data, CCBot crawling for Common Crawl datasets.

Google's introduction of the `Google-Agent` user-agent on March 20, 2026 — explicitly described as a "user-triggered fetcher" that "only activates when a person directs an AI assistant to perform a specific task" — codifies this distinction at the protocol level. Cloudflare's three-category classification (Search, Agent, Training) does the same at the infrastructure level.

### The Legal Landscape

The distinction matters enormously in court. Over 70 copyright infringement cases have been filed against AI companies as of late 2025, more than doubling the total from the end of 2024. Key cases illustrate how courts are treating different types of access:

**Anthropic v. Authors (settled September 2025):** The court found that AI training on copyrighted books constituted fair use, but that storing pirated copies from shadow libraries did not. The case settled for $1.5 billion, with estimated payouts of approximately $3,000 per work. The decision created a significant precedent: the method of acquisition matters as much as the use.

**Reddit v. Anthropic (filed June 2025):** Reddit alleges that Anthropic circumvented its licensing process to scrape training data without compensation, bypassing technological controls including `robots.txt` directives and IP rate limits. The claims include breach of contract, trespass to chattels, and unfair competition — theories that hinge on the unauthorized, automated nature of the access.

**New York Times v. OpenAI (ongoing):** The Times alleges OpenAI and Microsoft copied millions of articles to train ChatGPT, seeking billions in statutory damages. Discovery is ongoing with summary judgment scheduled for April 2026.

**Amazon v. Perplexity:** Perplexity has argued that its AI agents are "not scrapers," attempting to draw exactly the distinction between agent-on-behalf-of-user access and mass crawling. Courts have not yet definitively ruled on this distinction, but the argument is being taken seriously.

A conjunctive standard for "authorization" is forming — requiring both user authorization (the human directed the agent) and platform authorization (the site permits this type of access). Platforms enforce this through terms of service clauses prohibiting bots, automated access, credential sharing, and use of content for machine learning.

### Why Standards Bodies Are Paying Attention

The legal landscape is pushing standards bodies to formalize the technical distinction. An arxiv paper from June 2026 titled "The Agentic Web Requires New Normative Infrastructure" argues that existing web standards were designed for a bilateral model (server and browser) and are inadequate for the trilateral model (server, agent, and user-on-whose-behalf-the-agent-acts). The paper calls for new normative infrastructure that can express and verify the delegation chain from user to agent.

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

With over a billion HTTP 402 responses per day across Cloudflare's network, your agent will encounter pay-per-crawl paywalls. Implement 402 handling: parse the `crawler-price` header, decide whether the content is worth the cost for the user's query, and either pay through Cloudflare's API or gracefully fall back to alternative sources. Do not retry-loop against 402 responses.

### Handle 403 and 429 Responsibly

A 403 (Forbidden) means the site does not want your agent there. Respect it. A 429 (Too Many Requests) means you are rate-limited — implement exponential backoff. Do not switch IP addresses or user-agents to circumvent these responses. Courts have treated technical circumvention of access controls as strong evidence in scraping lawsuits.

### Check Machine-Readable Licensing

If your agent uses content in ways beyond simple display to the user (summarization, training, indexing), check for TDMRep headers and RSL declarations. While enforcement is currently legal rather than technical, ignoring declared rights reservations weakens your legal position if challenged.

### Distinguish User-Triggered from Autonomous Access

If your agent is fetching content because a specific user asked it to, make that clear in your request context. If your agent is autonomously crawling for indexing or training, respect the higher access restrictions that apply. This distinction will only become more important as courts and standards bodies formalize the agent-on-behalf-of-user category.

## The Road Ahead

The agentic web access standards landscape in mid-2026 is characterized by rapid, somewhat chaotic development. Multiple overlapping standards address different parts of the problem: `robots.txt` for basic access control (strained but enduring), `llms.txt` for LLM-friendly content description (useful in its niche, overhyped elsewhere), TDMRep and RSL for machine-readable licensing (legally grounded but adoption-limited), Web Bot Auth for cryptographic identity verification (technically sound, deployment nascent), and Cloudflare's AI Crawl Control for infrastructure-layer enforcement and monetization (the most immediately impactful).

Several trends seem likely to continue:

**Consolidation around Web Bot Auth.** Cryptographic bot identity is clearly superior to user-agent strings and IP-based verification. The IETF standardization process, combined with deployment by Cloudflare, Google, Amazon, and OpenAI, suggests this will become the baseline for declared bot traffic within the next year or two.

**Pay-per-crawl becoming the default.** Cloudflare's marketplace, combined with RSL's licensing framework and the settlement economics of copyright lawsuits (Anthropic's $1.5 billion settlement sets a clear price signal), is pushing toward a world where AI companies pay for content access rather than scrape it for free. The HTTP 402 status code, dormant for decades, has found its purpose.

**Legal clarification of the agent-on-behalf-of-user distinction.** The Amazon v. Perplexity case and Google's `Google-Agent` user-agent are early indicators. Courts and standards bodies will need to formalize when an AI agent's web access is analogous to a user's browser and when it is something else entirely.

**The death of the honor system.** `robots.txt` was an honor system. The Perplexity controversy, Cloudflare's infrastructure-layer enforcement, and the proliferation of copyright lawsuits all point in the same direction: the web is moving from trust-based access control to verified, enforced, and monetized access control. For legitimate agent developers, this is ultimately good news — it creates a framework in which honest actors can be distinguished from scrapers. For the web as a whole, the outcome depends on whether the emerging standards remain open and interoperable or calcify into walled gardens controlled by a few infrastructure gatekeepers.

The standards are being written right now. Agent developers, publishers, and platform operators who engage with these processes — IETF working groups, W3C community groups, Cloudflare's marketplace — will shape the rules. Everyone else will live with whatever gets decided.
