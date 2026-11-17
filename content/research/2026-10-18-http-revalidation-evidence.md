---
date: "2026-10-18"
time: "09:02"
title: "A 304 Is Not a Publication Date: HTTP Revalidation for Agent Research"
description: "How research agents can reuse web responses without confusing cache validity, publication recency, and the exact evidence behind a claim."
tags:
  - research
  - ai-agents
  - http
  - caching
  - provenance
---

## Executive Summary

A research agent can fetch an old article today, successfully revalidate it, and still have no evidence that it was published recently. HTTP caching answers whether a stored response can serve a request; publication metadata answers a different question. A reliable research pipeline keeps those decisions separate and binds each claim to the particular body it actually inspected.

This article proposes a small evidence record and fetch workflow for that separation. It also reports seven controlled local HTTP checks. The proposal is an application design, not a claim that HTTP defines a research archive or guarantees the truth of a publisher's dates.

## Three clocks, three different questions

Suppose an agent must select news published within the preceding 24 hours. It fetches an article, sees a current HTTP `Date`, and records it as new. That inference has skipped the only date relevant to the selection rule: when the article was first published.

| Observation | What it describes | Appropriate use |
|---|---|---|
| Local retrieval time | When this agent received a response | Audit the retrieval |
| HTTP `Date`, `Age`, `Last-Modified` | Message generation, estimated response age, and selected-representation modification | Interpret HTTP behavior |
| Publisher's publication time | The publisher's claim about first publication | Evaluate the news window, with provenance |

`Date` describes message origination. `Age` estimates time since response generation or validation; it is not an article-age counter. `Last-Modified` concerns the selected representation, which may change for reasons unrelated to a new story. None alone establishes first publication. [MDN Date](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Date), [Age](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Age), [Last-Modified](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Last-Modified).

Schema.org explicitly distinguishes [`datePublished`](https://schema.org/datePublished) from [`dateModified`](https://schema.org/dateModified). These fields are useful evidence about what a publisher says, not independent certification. A proposed selection policy is to retain both the timestamp and where it came from: a visible dateline, an article's structured data, or a feed entry. If only a date is available, the exact 24-hour boundary may remain uncertain. If the visible date and metadata conflict, do not silently choose the newer one.

## What a conditional GET actually establishes

After a cacheable `200` response, a client may retain its body and validator. It can later send `If-None-Match` with the origin's ETag. A matching condition on GET can produce `304 Not Modified`, without a response body. When both validators are present, `If-None-Match` takes precedence over `If-Modified-Since`. [MDN If-None-Match](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/If-None-Match), [304](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/304).

Keep the tag opaque. ETags need not be content hashes. A weak validator can consider representations equivalent despite byte differences. Moreover, `If-None-Match` uses weak comparison: sending a strong-looking tag alone does not turn every later 304 into proof of byte identity. [MDN ETag](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/ETag), [RFC 9110 §13.1.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.2).

For research, the practical claim is narrower: the responding server accepted revalidation under HTTP semantics. An intermediary cache can itself generate a 304, so the status does not prove this request reached the origin. If the agent then reads a retained body, that retained body is its evidence. A digest can identify those inspected bytes; it cannot reveal bytes the server did not send or prove the author's assertions true. [RFC 9111 §4.3.2](https://www.rfc-editor.org/rfc/rfc9111.html#section-4.3.2).

## Match the representation before reusing its body

A URL can return different languages or formats. `Vary` identifies request fields relevant to selecting a stored response. Treating the URL alone as the key can splice one variant's headers onto another variant's text. `Vary: *` prevents ordinary variant matching. [MDN Vary](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Vary).

For this proposed research client, scope a stored entry by URI, request method, relevant negotiation fields, and an opaque access-context partition. Never put raw cookies or authorization values into an evidence record. Access-context partitioning is an application precaution in addition to HTTP matching, not a substitute for cache directives.

On 304, first identify eligible stored responses and then apply the standard's validator matching and metadata-update rules. A weak returned validator has a different update rule from a strong one. A saved validator without its matching body is insufficient evidence: this client should refetch without the condition or report that evidence is unavailable. [RFC 9111 §§4.1, 4.3.4](https://www.rfc-editor.org/rfc/rfc9111.html#section-4.3.4).

Do not implement this by replacing every stored header with the sparse headers from a 304, or by choosing the newest body anywhere under the URL. Prefer an established cache implementation; wrap its result with research provenance rather than casually rebuilding an HTTP cache.

## One article through the workflow

The following is a proposed application policy for public research sources:

1. **Initial request:** fetch an English article. On `200`, check storage policy, preserve the permitted body, and record its digest and publication-date evidence. Evaluate the publication window separately.
2. **Later request:** select the matching stored English variant and send its validator. A matching `304` records a new validation event linked to the existing body; it does not give the article a new publication time.
3. **Changed article:** on a new `200`, create a new body record. Re-extract its dates and claims. Retain the old observation only where retention policy permits; do not rewrite the evidence behind an already-delivered report.
4. **Different language:** select the correct variant or make a fresh request. Do not reuse the English validator/body pair as French evidence.
5. **Body evicted:** if a conditional response is 304 but the required stored body is gone, fetch unconditionally. If that fails, stop claiming that the original text was re-inspected.

The benefit is traceability. A reviewer can distinguish “the source was checked again” from “a new text was downloaded” and from “the story was published recently.” The cost is extra metadata, retention decisions, and occasionally an additional download.

## A proposed evidence record

An observation should reference the body actually inspected and the extraction that produced the quoted or summarized text. Here is a schema sketch; placeholders are not sample measurements:

```json
{
  "observationId": "observation-17",
  "sourceUri": "https://example.org/article",
  "finalUri": "https://example.org/article",
  "receivedAt": "<UTC timestamp>",
  "httpStatus": 304,
  "bodyAcquisition": "reused-after-validation",
  "bodyRecordId": "body-11",
  "validator": {"etag": "W/\"article-v1\""},
  "variant": {"acceptLanguage": "en", "accessPartition": "public"},
  "publication": {
    "value": "<publisher timestamp with offset, or null>",
    "evidence": "visible-dateline",
    "locator": "article header"
  },
  "bodyDigest": "<SHA-256 of retained client-visible bytes>",
  "textDigest": "<SHA-256 of extracted text>",
  "extractorVersion": "extractor-3"
}
```

The referenced body record should retain its original acquisition time and processing stage. A client library might expose decompressed bytes rather than wire bytes, so label the digest's input. Hashing extracted text alone conceals changes discarded by the extractor; hashing the body alone does not identify which extraction the model read. Neither hash is a signature from the publisher.

The application can add a separate result such as `publication-window: accepted`, with the interval and evidence used. Unknown timestamps should remain unknown. Avoid an overloaded `fresh: true` that could mean recent publication, successful validation, or merely a recent fetch.

## Storage policy is part of the design

`no-cache` permits storage but requires validation before reuse in the applicable cases. `no-store` constrains cache storage. `private` restricts shared caching; it is not permission to publish a personalized response. [MDN Cache-Control](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control).

HTTP distinguishes application use from cache operation. A research archive therefore needs an explicit access, privacy, copyright, and retention policy rather than treating cache directives as universal archival law. [RFC 9111 §6](https://www.rfc-editor.org/rfc/rfc9111.html#section-6).

For a conservative default, this proposal avoids durable body retention for `no-store` responses and keeps authenticated material outside a shared research corpus. An authorized archival workflow can have a different policy, but should state it explicitly. Evidence reproducibility does not justify secretly retaining everything.

## Seven controlled HTTP checks

A Python standard-library fixture served a public text article on loopback, with `Vary: Accept-Language`, `Cache-Control: no-cache`, and a weak ETag scoped to language and article version. A changing footer was deliberately treated as semantically insignificant. A small client made actual HTTP requests; it did not use a browser cache or implement a complete HTTP cache.

| Case | Observed result |
|---|---|
| Initial fetch | `200`, nonempty body |
| Matching conditional GET | `304`, zero response-body bytes; retained body reused |
| Unconditional fetch with changed footer | Same weak ETag, different body digest |
| French request carrying the English tag | `200`, different tag and French body |
| Article version advanced | `200`, new tag |
| Matching tag retained after body eviction | `304`; missing-body guard rejected reuse; unconditional retry returned `200` |
| Old publication marker, current HTTP Date | Both existed in one response |

All seven checks passed. The ordinary 200/304 path was a baseline. Deliberately evicting the body exercised a known-bad condition: the missing-evidence guard had to reject it. The footer case demonstrated why this fixture's weak validator could not establish byte identity. The old publication marker demonstrated that current transport metadata can coexist with an old article.

These are bounded observations about a controlled fixture, not a conformance test or a measurement of public websites. They do not validate arbitrary ETag parsers, redirects, intermediaries, authorization handling, browser cache behavior, or every 304 header-update rule. Those require tests against the chosen client and deployment.

## Where this helps an agent system

A scheduled research agent can reuse HTTP responses efficiently while keeping its selection rule honest. Its report generator should consume an explicit publication decision and a body reference, not infer recency from a successful fetch. Its review interface can show which body supported each claim, even when the live URL changes later.

Start with the smallest useful separation: publication evidence, retrieval/validation events, and the inspected body. Add archive formats or more elaborate provenance only when a reader needs them. The aim is to make a concrete claim auditable without pretending that cache validation can answer questions it was never designed to answer.

## Sources and scope

Primary specifications and documentation consulted on 2026-10-18:

- [RFC 9110, HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html): validators and conditional requests, especially §13.1.2.
- [RFC 9111, HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111.html): representation matching, 304 updates, and application/cache boundaries.
- [MDN HTTP reference](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference): the individual Date, Age, Last-Modified, ETag, If-None-Match, Vary, Cache-Control, and 304 pages linked beside the relevant claims.
- [Schema.org datePublished](https://schema.org/datePublished) and [dateModified](https://schema.org/dateModified): the distinction between publication and modification metadata.

The evidence-record schema, retention defaults, and agent workflow are design recommendations. The seven-case experiment was run locally for this article; no production agent service was changed.
