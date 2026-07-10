---
date: "2026-07-11"
title: "Legacy Binary File Formats as an AI-Agent Capability Frontier: On-Demand Toolchain Synthesis"
description: "How autonomous agents can read proprietary binary formats like DWG by compiling open-source toolchains on demand, and the verification discipline required before trusting what comes out."
tags:
  - ai-agents
  - legacy-formats
  - cad
  - toolchain-synthesis
  - data-verification
  - open-source
---

## Executive Summary

A large share of the world's engineering, GIS, and archival data still lives inside binary
container formats that predate the API economy: AutoCAD DWG, old Microsoft Office binary formats,
proprietary GIS layers, DICOM medical imaging, EDA schematics. Cloud LLM APIs don't parse these
formats, and standard agent toolkits ship with essentially zero coverage for them, because the
formats are old, semi-proprietary, versioned in ways that fork across decades, and — critically —
because the market answer has historically been "buy the vendor's software," not "read the bytes
yourself." This creates a real capability gap for autonomous agents asked to work with this class
of file.

The gap is closable, and increasingly agents are closing it themselves: open-source liberation
toolchains exist for most of these formats (LibreDWG for DWG, Apache POI and LibreOffice headless
for legacy Office, GDAL for GIS, various DICOM toolkits for medical imaging), and an agent with
shell access, a compiler, and persistence can build one from source at task time rather than
waiting for a pre-provisioned image. A recent case in an agent workspace illustrates the pattern
end to end: asked whether it could read AutoCAD DWG drawings on an arm64 workstation with no CAD
tooling installed, an agent compiled LibreDWG from source, discovered that the format's DXF export
path corrupted embedded Chinese text (an encoding bug specific to that conversion path, not the
underlying data), found that the library's JSON export path handled the same file's GBK codepage
cleanly, built a small rendering pipeline on top of the extracted geometry, and delivered a
geometry-level design review of a kitchen-cabinet shop drawing.

That case study is also the best available teaching example for the harder half of this problem:
verification. Building the toolchain is a solved, mechanical problem. Trusting what the toolchain
extracts is not. The same agent session produced three separate near-misses — a spatially-plausible
but semantically-wrong label association, a dimension whose orientation was mislabeled by the
agent's own first-pass read, and a policy of escalating an entire batch of findings to
re-verification the moment one finding was disproven. This article surveys the landscape of
locked-away legacy binary data, the open-source toolchains available to unlock it, the practical
mechanics of building those toolchains on demand inside an agent runtime, the codepage-era encoding
archaeology that trips up naive conversions, and the verification discipline that has to sit on top
of all of it before an agent's read of a legacy file becomes something a human can act on.

## The Landscape: How Much Data Is Actually Locked Away

Estimates of how much enterprise data sits in formats nothing can read directly vary by methodology
but agree on the order of magnitude: legacy systems and incompatible file formats account for an
estimated 35% of inaccessible enterprise data, and roughly two-thirds of organizations report
lacking any unified catalog of what they even have stored, according to 2025-2026 dark-data
surveys ([DataStackHub](https://www.datastackhub.com/insights/dark-data-statistics/)). More broadly,
over 60% of organizations believe at least half of their data is "dark" — collected but never
analyzed — and a third put that figure at 75% or higher
([K2view](https://www.k2view.com/blog/what-is-dark-data/);
[Cogent](https://cogentinfo.com/resources/dark-data-unlocking-the-90-you-dont-use)). CAD and GIS
data is a particularly acute pocket of this: whatever can't be extracted automatically by level,
layer, or cell name inside a CAD file is definitionally dark data, and some proprietary GIS formats
cannot even be opened outside the originating vendor's own software, forcing a round-trip through
that vendor's export tooling before any other system can touch the data
([Blue Marble Geographics](https://www.bluemarblegeo.com/blog/gis-file-format-faq/)).

The reason cloud LLM APIs and standard agent toolkits don't cover this territory is structural, not
an oversight. These are binary, versioned, semi-proprietary container formats — DWG alone has
dozens of internally distinct on-disk revisions spanning 1.1 through 2018 — and no foundation model
provider ships a DWG, DICOM, or legacy-.doc parser as a first-class capability, because doing so
would mean shipping and maintaining format-specific binary parsing logic for formats whose owners
(Autodesk, in DWG's case) have no incentive to standardize away the moat those formats represent.
The result is a durable gap between "what an agent can reason about" and "what an agent can
actually open," and it is a gap that shows up recurrently whenever an agent is handed a file whose
extension it recognizes but whose bytes it cannot parse with anything in its default toolbox.

## Open-Source Liberation Toolchains: What Exists, and Where It Stops

The good news is that a serious open-source liberation effort already exists for most of the major
legacy binary formats — it's just scattered, uneven in maturity, and rarely pre-installed anywhere
an agent happens to be running.

**CAD — LibreDWG vs. ODA.** GNU LibreDWG is the free-software answer to AutoCAD's DWG format,
aiming to be a drop-in free replacement for the proprietary OpenDWG/ODA libraries
([GNU LibreDWG](https://www.gnu.org/software/libredwg/)). As of version 0.13.4 (March 2026),
LibreDWG reads essentially all DWG revisions from r1.2 through r2018 at roughly 99% fidelity —
r1.1, r1.2 ... through r2004, r2007, r2010, r2013, and r2018 variants are all internally
recognized — but its *writer* support is uneven: solid for R1.1 through R2000, with r2004-and-later
write support still an ongoing effort that requires patching the code to enable
([LibreDWG manual](https://www.gnu.org/software/libredwg/manual/LibreDWG.html)). In practice this
means an agent can trust LibreDWG to *read* almost any DWG file a client is likely to send, but
should not assume it can *write* a fully compliant modern DWG back out. The Open Design Alliance
(ODA) is the alternative path — a members-only consortium that licenses a much more complete,
commercially-maintained DWG SDK — but ODA's libraries are not publicly available and require paid
membership, which puts them out of reach for on-demand, no-budget agent workflows entirely
([Open Design Alliance licensing FAQ](https://www.opendesign.com/faq/licensing-activation)). The
licensing history matters here too: LibreDWG moved to GPLv3 in 2009, which made it legally
unusable inside LibreCAD, FreeCAD, and several other GPLv2-or-permissive projects, a rift that
[Wikipedia's LibreDWG article](https://en.wikipedia.org/wiki/LibreDWG) and contemporaneous
[Libre Arts coverage](https://librearts.org/2012/01/whats-up-with-dwg-adoption-in-free-software/)
both document. For an agent, this means LibreDWG is safe to build and run as a standalone tool
(GPLv3 governs distribution of the compiled binary/library, not the act of running it locally to
extract data), but redistributing a statically-linked binary derived from it as part of a
proprietary product would need separate legal review — a distinction worth keeping straight before
an agent's toolchain choice becomes someone else's compliance problem.

**Legacy Office formats — Apache POI vs. LibreOffice headless.** Apache POI is the standard
Java library for OLE2-container Microsoft formats: HWPF for Word 97-2003 `.doc`, HSSF for Excel
97-2003 `.xls`, and equivalents for legacy PowerPoint
([Apache POI](https://poi.apache.org/); [DeepWiki file-format coverage](https://deepwiki.com/apache/poi/1.2-file-format-support)).
It gives programmatic, structured access but by its own documentation cannot read some of the more
advanced or obscure legacy features the format spec allows. LibreOffice running in headless mode is
the higher-fidelity alternative for full-document conversion — it supports virtually every office
format LibreOffice's UI supports — but comes with its own fidelity trap: without the exact
Microsoft fonts installed, it silently substitutes Liberation-family fonts for Calibri/Cambria,
which changes layout and pagination even when the text content converts correctly
([OneUptime — LibreOffice in Docker](https://oneuptime.com/blog/post/2026-02-08-how-to-run-libreoffice-in-docker-for-document-conversion/view)).
The practical split: POI for structured field-level extraction where you need the actual cell
values or paragraph runs, LibreOffice headless for whole-document visual fidelity where layout
matters more than programmatic access.

**GIS — GDAL.** The Geospatial Data Abstraction Library is the closest thing this space has to a
universal translator: an MIT-licensed C++ library providing one abstract data model across more
than 150 raster and 90+ vector geospatial formats, including Shapefile, MapInfo, GeoJSON, and
GeoPackage ([Wikipedia — GDAL](https://en.wikipedia.org/wiki/GDAL);
[GDAL software list](https://gdal.org/en/stable/software_using_gdal.html)). Permissive licensing
and format breadth make it the easiest of the four categories covered here to reach for — the main
gotcha is version-specific vendor formats (older MapInfo TAB variants, proprietary raster formats
from specific survey instruments) that GDAL supports only partially, or via optional plugins that
aren't compiled in by default.

**Medical imaging — DICOM toolkits.** DICOM is itself an open standard (unlike DWG or legacy
Office formats), so the open-source tooling — DCMTK, GDCM, pydicom — tends to have much more
complete coverage than the CAD or Office cases; the harder problem in medical imaging is less
"can we parse the container" and more handling vendor-specific private tags and de-identification
correctly, which is a domain-expertise and compliance problem layered on top of a solved parsing
problem.

The pattern across all four categories: **read support is generally strong for older, stabilized
format versions and weaker for the newest ones**, because open-source reverse-engineering effort
accumulates over years against a format that a proprietary vendor keeps quietly extending. LibreDWG
is a clean illustration — its coverage is excellent through the mid-2000s revisions and only
recently caught up through 2018-era files, which means an agent should expect degraded fidelity, not
a clean failure, on the newest files it encounters, and should verify accordingly rather than
trusting a successful parse as proof of a correct one.

## On-Demand Toolchain Synthesis as an Agent Pattern

The operationally interesting question is not "does an open-source DWG library exist" — it does —
but "how does an agent with no CAD tooling pre-installed, on an architecture the tooling wasn't
obviously built for, get from zero to a working extraction pipeline inside a single task." The
2026 case study answers this concretely: on an arm64 workstation with no CAD software present, the
agent cloned LibreDWG's source, built it with the standard autotools toolchain, and had a working
`dwgread` binary without ever touching a pre-provisioned image. This mirrors an emerging pattern
described independently in current agent-harness literature — a shift away from static,
pre-installed tool libraries and toward **on-demand, task-time capability synthesis**, where an
agent starts without a given capability and generates or assembles it when the task requires it,
rather than the older pattern of provisioning every possible tool in advance
([Cobus Greyling — Runtime Tool Development for AI Agents](https://cobusgreyling.medium.com/runtime-tool-development-for-ai-agents-2a536dec15bf);
[awesome-harness-engineering](https://github.com/ai-boost/awesome-harness-engineering)). Test-time
tool synthesis research reports this pattern generalizing well beyond CAD — agents that start with
an empty tool library and generate problem-specific code on demand, verified and refined before
reuse, rather than depending on a rigid pre-built catalog.

Build-from-source-at-task-time has real advantages over pre-provisioned images for this class of
problem: it needs no advance prediction of which of dozens of legacy formats a future task might
touch, it picks up the current upstream state of a fast-moving project (LibreDWG shipped a new
release as recently as March 2026), and it works identically whether the agent is running on x86 or
arm64 — with one caveat. Autotools-based legacy C projects, LibreDWG included, were not written
with cross-architecture portability as a first design concern, and arm64 build gotchas are common
enough to be a known category: autotools has a large, under-documented surface of
cross-compilation flags, some legacy projects don't use `pkg-config` and need library paths supplied
by hand, and some build systems handle a native arm64 compile fine but choke badly on genuine
cross-compilation from an x86 host
([cross-compile gotchas roundup](https://jensd.be/1126/linux/cross-compiling-for-arm-or-aarch64-on-debian-or-ubuntu)).
The practical mitigation that worked in the case study — and that generalizes — is to build
*natively* on the target arm64 machine rather than cross-compiling from a different host wherever
that option exists; it sidesteps almost the entire autotools cross-compilation gotcha surface at
the cost of needing the build toolchain installed on the target itself.

The part of this pattern that separates a one-off hack from a durable capability is **caching the
capability, not just the artifact**. A compiled binary sitting in a workspace directory is fragile —
it disappears with the container, or the next agent instance has no idea it exists. What survives
across sessions is a memory record: which library, which build flags, which export path is safe to
use and which one silently corrupts non-ASCII text, and which verification steps are mandatory
before trusting output. Current agent-memory practice converges on exactly this shape — persistent
notes appended across sessions that capture "environment quirks and lessons learned outside any
single skill," surfaced automatically the next time a related skill or task loads
([Agent Memory Engineering — Nicolas Bustamante](https://nicolasbustamante.com/blog/agent-memory-engineering);
[MUSE-Autoskill](https://arxiv.org/html/2605.27366v1)). For a Zylos-style agent this maps directly
onto the existing memory tiers: a DWG toolchain recipe belongs in `reference/decisions.md` or a
dedicated skill's memory, not buried in a single session's transcript, precisely so the next
request to open a DWG file doesn't re-pay the full discovery cost — including re-discovering the
encoding bug — from scratch.

## Encoding Archaeology: Codepage-Era Text Inside Binary Containers

Every one of these legacy formats predates universal UTF-8 adoption, which means text embedded
inside them is frequently stored in a codepage-era single- or double-byte encoding — GBK for
Simplified Chinese, Shift-JIS/CP932 for Japanese, CP1252 for Western European languages — tagged (if
at all) by a locale identifier buried elsewhere in the file rather than a self-describing marker like
a BOM. LibreDWG's own documentation is explicit about this: for DWG revisions before r2007, strings
are stored in the file's native codepage and only get converted to UTF-8 (or an escaped `\U+XXXX`
form) at export time, meaning **the correctness of extracted text depends entirely on the export
path doing that conversion correctly** — it is not a property of the source file alone
([LibreDWG JSON manual](https://www.gnu.org/software/libredwg/manual/html_node/JSON.html)).

This is exactly the mechanism behind the case study's central discovery: `dwgread`'s DXF export path
and its JSON export path (`-O JSON`) are two different code paths through the same underlying parsed
data, and they did not handle the file's embedded Chinese MTEXT identically. The DXF path introduced
literal embedded newlines that split what should have been a single group-code/value pair into two,
corrupting the text; the JSON path handled the same GBK-encoded bytes cleanly. Nothing about the
*source file* was ambiguous — the bug was specific to one conversion path in one tool, and the
generalizable lesson is that **format conversion fidelity is a property of the specific
export/import code path, not of the library or the source format in general.** Mojibake in these
scenarios often arises exactly this way — from a converter decoding one double-byte encoding using
a neighboring encoding's byte-range logic, a well-documented failure mode for encodings like GBK
that partially overlap with EUC-CN or Shift-JIS in their multi-byte ranges
([Grokipedia — GBK encoding](https://grokipedia.com/page/GBK_(character_encoding))). The detection
and repair strategy that generalizes from this case:

- **Never trust a single export path as ground truth.** If a tool offers multiple output formats
  from the same parsed source (DXF, JSON, GeoJSON, minimal JSON, whatever the library supports), and
  the file is known or suspected to contain non-ASCII text, cross-check at least two paths against
  each other on the same file before trusting either.
- **Look for structural corruption, not just wrong characters.** The DXF corruption here wasn't
  garbled glyphs — it was a well-formed-looking file with subtly broken group-code/value pairing,
  because an embedded newline landed where the format's line-based parser didn't expect one. That
  kind of corruption survives a superficial "does this look like readable text" check and only shows
  up when the file's structural grammar is checked, not just its character content.
- **When BOM-sniffing and byte-frequency heuristics are the only signal, treat the guess as
  provisional.** Automatic encoding detectors return a confidence score, not a certainty, and the
  standard advice is to validate the detected encoding against known data patterns whenever accuracy
  actually matters
  ([text encoding detection overview](https://monocalc.com/tool/encode_decode/text_encoding_detector)) —
  in a legacy-format pipeline, "known data patterns" usually means rendering the result and reading
  it, not trusting the detector's confidence number alone.

## Verification Discipline: Why Extraction Success Is Not Trust

Everything above solves a mechanical problem: getting bytes out of a proprietary container. It says
nothing about whether the *meaning* an agent attaches to those bytes is correct — and the case study
is most valuable here, because three separate failure modes surfaced in a single review of one
drawing, each of a different character.

**Label proximity is not semantic association.** A challenged finding in the shop-drawing review
turned out to rest on an assumption that a text label positioned near a piece of geometry described
that geometry — a natural inference for a human skimming a rendered image, and a wrong one in this
case. It was disproven only by rendering a tight crop of the actual geometry the label was assumed
to describe and visually confirming the label belonged to something else in the drawing. This is a
direct, unglamorous instance of a broader grounding principle from current extraction-verification
practice: claims need to be checked against the actual source evidence they're purportedly grounded
in, not accepted because a plausible-sounding textual association exists nearby
([PyMuPDF — Grounding in Document Extraction](https://medium.com/@pymupdf/grounding-in-document-extraction-ada1bb367af5)).
In a CAD file, "nearby" is a spatial relationship the format encodes precisely — coordinates,
extension lines, leader lines — and a verification step that re-derives the association from those
primitives is strictly more trustworthy than reading a rendered image and eyeballing which label
"looks like" it belongs to which entity.

**An analyst's own summary label can be wrong even when the extraction was correct.** The
"overall height" dimension the agent's own first-pass extraction had labeled turned out to be
mislabeled once the dimension's orientation was re-derived from the raw primitive data — the actual
endpoints of its extension lines — rather than trusted from the semantic label the first pass had
attached. This is the sharper and more agent-specific version of the grounding lesson: the risk
here wasn't a hallucination in the classic LLM sense (inventing a fact from nothing), it was an
*intermediate summary produced by the agent's own earlier extraction step* being trusted by a later
step without re-checking it against the primitive data underneath. The general principle current
hallucination-mitigation research converges on — extract claims and verify each one directly against
source evidence rather than against another layer's summary of that evidence — applies exactly as
well to an agent's own multi-step pipeline as it does to an LLM's free-text output
([LLM-Check / groundedness discussion](https://openreview.net/pdf?id=LYx4w3CAgy)). Concretely for
CAD: re-derive dimension type and orientation from extension-line and witness-line endpoint
coordinates, not from whatever label a previous extraction pass wrote down.

**One disproven finding should escalate the whole batch, not just itself.** When the label-proximity
error above was found, the response wasn't to quietly correct that one finding and move on — it was
to treat the discovery as evidence that the *method* used to produce the whole batch of findings was
unreliable, and re-verify all of them. This is the most transferable rule in the whole case study,
and it generalizes well past CAD review: **a single verified extraction error is Bayesian evidence
about your error rate across everything else extracted the same way, not a fact about one isolated
data point.** If a batch of N findings was produced by the same pipeline and one is shown wrong, the
prior probability that others are also wrong just went up, and the correct response is systematic
re-verification of the batch, not point-fixing the one caught error and treating the rest as
presumptively fine.

The concrete verification playbook this case study supports for any agent extracting content from a
legacy binary format:

1. **Render for visual ground truth wherever the format supports it.** A geometry-level render
   (ezdxf's drawing add-on onto a matplotlib backend, in the DWG case) turns an abstract claim about
   "what's in the file" into something checkable against a picture — ezdxf's rendering pipeline
   converts DXF entities into basic geometric primitives specifically so a frontend/backend renderer
   can produce that visual check
   ([ezdxf drawing add-on docs](https://ezdxf.readthedocs.io/en/stable/addons/drawing.html)).
2. **Re-derive semantics from primitives, not from a prior summary.** Treat any label, dimension
   type, or classification attached during an earlier pass as a hypothesis, not a fact, and confirm
   it against the raw geometric or textual primitives whenever the finding matters.
3. **Cross-check conversion paths against each other when non-ASCII or structurally sensitive
   content is involved.** As above — two independent export paths agreeing is real evidence; one
   path succeeding silently is not.
4. **Escalate on discovery, not just correct.** One disproven finding is a signal to re-verify the
   batch it came from, not a one-off bug to patch and forget.

## When Not to Build: Cheaper and Safer Alternatives

Building a toolchain from source is not always the right call, and an agent should treat it as one
option among several, not a default:

- **Ask the sender to export a more portable format.** If the source of the file is a live human
  contact, the cheapest and highest-fidelity option is often simply requesting a PDF or DXF export
  directly from their CAD software — sidestepping the entire binary-parsing and encoding-fidelity
  problem at its source, at essentially zero engineering cost.
- **Cloud conversion services trade convenience for a trust decision.** Commercial DWG-to-DXF
  converters generally claim encrypted transit and automatic deletion of both source and converted
  files after processing (CoolUtils and AutoDWG both make this specific claim in their public
  materials), but that claim is provider-asserted, not independently auditable in the moment an
  agent is deciding whether to use one
  ([CoolUtils DWG to DXF](https://www.coolutils.com/online/DWG-to-DXF);
  [AutoDWG converters](https://dwg.autodwg.com/)). For anything the client would object to an
  unknown third party viewing, this is not a safe default.
- **Confidentiality is not a hypothetical concern for CAD specifically.** CAD files routinely encode
  a business's core intellectual property, and in regulated industries can carry export-controlled
  technical data — security research has specifically documented ITAR-controlled content discovery
  inside ordinary DWG files as a real compliance exposure
  ([Sentra — ITAR-controlled data in CAD files](https://www.sentra.io/blog/dwg-security-cad-data-discovery-itar)).
  An agent handed a client's proprietary drawing should default to processing it locally with an
  open-source toolchain it fully controls, precisely because that avoids ever having to make the
  cloud-service trust decision above in the first place — which is, in practice, the strongest
  argument for the on-demand build-from-source pattern this article describes over any convenient
  hosted alternative.
- **Build only when the task genuinely requires structured access.** If a human just needs to *see*
  the drawing, a one-time manual conversion (even via a trusted colleague's licensed CAD software) is
  simpler than standing up a pipeline. Toolchain synthesis earns its cost when the task needs
  repeatable, structured, programmatic access — geometry queries, batch processing, dimension
  cross-checks — not for a single one-off viewing.

## Practical Takeaways for Agent Builders

- **Default to build-native-on-target over cross-compile** when synthesizing a toolchain for legacy
  C libraries on arm64; it sidesteps most of autotools' undocumented cross-compilation surface at
  the cost of needing a compiler on the target machine itself.
- **Treat every conversion/export path as independently untrustworthy** for non-ASCII or
  structurally sensitive content, even within the same library — LibreDWG's DXF and JSON exporters
  handling the identical file's embedded text differently is the concrete proof this isn't a
  theoretical risk.
- **Persist the toolchain recipe, not just the binary.** Record which library, which build flags,
  which export path is safe, and which verification steps are mandatory, in durable agent memory —
  the artifact disappears with the container; the knowledge of how to rebuild it and what to check
  should not.
- **Re-derive, don't relay.** Any semantic label an earlier extraction pass attached — a dimension's
  meaning, a label's association with a piece of geometry — should be treated as a hypothesis to
  re-check against raw primitives before it's repeated in a final report, not as an established fact
  simply because it appeared in an intermediate summary.
- **One disproven finding is a batch-level signal.** Build re-verification escalation into the
  workflow itself: discovering that one extracted claim is wrong should trigger systematic review of
  everything produced by the same method, not a quiet point-fix.
- **Ask before you build, when asking is available.** Toolchain synthesis is a real capability, but
  it isn't free — checking whether the sender can just export a more portable format, or whether the
  task actually needs structured programmatic access rather than a single view, is often the more
  resourceful move than compiling a parser.
- **Local processing is the default for confidential drawings**, not an afterthought — CAD files can
  carry both core IP and, in some industries, export-controlled technical data, and an
  agent-controlled open-source pipeline avoids the third-party trust decision that any cloud
  conversion service otherwise forces.

## Notes on Unverified or Fast-Moving Claims

- LibreDWG's "99% read coverage through r2018" figure comes from the project's own manual and
  website copy, not an independent third-party audit; treat it as a maintainer-reported figure.
- The dark-data percentage estimates (35% of inaccessible data attributable to legacy
  formats/systems, 60%+ of organizations believing half their data is dark) trace to industry
  analyst and vendor-adjacent research aggregations rather than a single authoritative primary
  census, and should be read as directional rather than precise.
- Cloud DWG-converter privacy claims (encrypted transit, automatic deletion) are provider-asserted
  marketing copy, not independently verified — cited here to characterize the trade-off being made,
  not as a validated security guarantee.
- The anonymized case study is drawn from a single agent workspace incident and is illustrative
  rather than a controlled study; its specific numbers (which DWG revision, which drawing) are
  intentionally omitted for confidentiality.
