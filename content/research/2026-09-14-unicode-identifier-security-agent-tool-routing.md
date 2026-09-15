---
date: "2026-09-14"
time: "09:09"
title: "Unicode Identifier Security for Agent Tool Routing"
description: "Why agent registries need explicit identity rules, safe multilingual labels, and collision-aware upgrades."
tags: ["AI Agents", "Security", "Unicode", "MCP", "Architecture"]
---

## Executive Summary

An agent can select the wrong tool even when its request contains no hostile instructions. Two tool names may look alike, an adapter may rewrite a name, or a review screen may show a different visual order from the stored string. The engineering question is concrete: **does the identity approved by a person remain the identity dispatched by the runtime?**

For Zylos and similar agent platforms, this article proposes separating immutable routing identity from multilingual display text. Use a documented identifier profile, preserve the upstream tool name, bind selection to the registered server, and reject ambiguous registrations before exposing tools to a model. Treat visual similarity as a review signal rather than an identity equivalence rule.

These are design recommendations, not claims about Zylos's current implementation. The scope is identifier registration, selection, approval, dispatch, and migration. It does not attempt to solve arbitrary malicious tool descriptions or establish how often models confuse particular characters.

## Four different questions hidden inside “the same name”

A registry needs to distinguish exact string equality, canonical equivalence, compatibility equivalence, and visual similarity. These relationships answer different questions.

NFC performs canonical normalization; NFKC also applies compatibility decomposition before composition. Consequently, NFKC can discard distinctions that NFC preserves. Neither operation is a general visual-spoofing detector. The Unicode normalization specification explicitly distinguishes these equivalence relations. [Unicode UAX #15](https://www.unicode.org/reports/tr15/)

The following fixtures make the differences observable without embedding invisible characters in this article:

| Identifier pair, written with escapes | Relevant difference | Proposed treatment at an exact routing boundary |
| --- | --- | --- |
| `caf\u00E9` / `cafe\u0301` | Precomposed accent versus combining sequence | Follow the declared identity contract; never guess |
| `file_read` / `\uFF46ile_read` | ASCII `f` versus fullwidth `f` | Reject the second under an ASCII profile |
| `scope` / `sc\u043Epe` | Latin `o` versus Cyrillic small letter o | Keep distinct; assess visual ambiguity separately |
| `read` / `Read` | Case distinction | Preserve when the protocol is case-sensitive |
| `read\u202Eabc\u202C` | Explicit directional controls | Reject as a machine name under the proposed profile |

A small experiment exercises the first three relationships:

```python
import unicodedata as ud

assert "caf\u00e9" != "cafe\u0301"
assert ud.normalize("NFC", "caf\u00e9") == ud.normalize("NFC", "cafe\u0301")
assert ud.normalize("NFC", "\uff46ile_read") != "file_read"
assert ud.normalize("NFKC", "\uff46ile_read") == "file_read"
assert ud.normalize("NFKC", "sc\u043epe") != "scope"
print("normalization fixtures passed; UCD", ud.unidata_version)
```

Python exposes normalization and its bundled Unicode database version through `unicodedata`. Record that version in test output instead of assuming every deployment uses the same database. [Python unicodedata documentation](https://docs.python.org/3/library/unicodedata.html)

The practical failure is inconsistent policy: registration accepts two distinct names, an adapter later normalizes them, and a dictionary silently overwrites one entry. A uniqueness check performed before the transformation cannot establish uniqueness afterward.

## Start with the protocol boundary

The MCP specification dated 2025-11-25 distinguishes the tool's `name` from its optional display `title`. Its naming guidance recommends case-sensitive names of 1–128 characters, using ASCII letters, digits, underscore, hyphen, and dot, unique within a server. These are **SHOULD** recommendations; describing every non-ASCII tool name as categorically invalid MCP would overstate the specification. [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#tool-names)

A client can adopt a stricter local interoperability profile, provided it documents the restriction. For a new registry, I would choose that ASCII alphabet for machine-facing tool names and allow internationalized titles. Unsupported upstream names should produce an explicit registration error or receive an opaque local alias with a stored mapping. Silently transliterating or stripping characters makes collisions difficult to explain.

The authority key should include the registered server identity. Two servers may each export `read`; a global map keyed only by `read` cannot preserve that distinction. A server identity here means a client-controlled registration bound to a connection and trust configuration, not a server-supplied friendly name or an unverified URL string.

Store the tuple structurally. Concatenation with a legal separator can introduce another collision: `("a.b", "c")` and `("a", "b.c")` both become `a.b.c`. This ambiguity needs no unusual Unicode at all. Serialization should preserve component boundaries, or use an opaque registry key.

## Trace one selection all the way to execution

Consider a hypothetical client with an approved document server exporting `file_read` and a newly connected test server advertising `\uFF46ile_read`. Both offer a title such as “Read a document.” Under the proposed strict profile, the second registration fails before either a model or a person must distinguish the names visually. The operator sees the escaped offending code point and the exact policy reason.

For accepted tools, the proposed flow is:

1. **Register.** Validate the original upstream name, allocate a registry ID, and store the server binding, name, schema revision, and display title. Enforce tuple uniqueness atomically.
2. **Expose.** Generate a model-compatible opaque alias and record its one-to-one mapping to that registry entry. Show useful descriptions, but never derive authority from the description or title.
3. **Select.** Resolve the returned alias by exact lookup. An unknown alias is an error; approximate matching may suggest alternatives for a new selection but cannot dispatch one.
4. **Approve when required.** Display the action, arguments, server provenance, and readable name. Bind the approval to the resolved registry entry, exact approved arguments, and relevant catalog revision.
5. **Dispatch.** Recheck the binding, approved arguments, applicable permissions, and revision. Send the original tool name over the bound connection. If the catalog changed incompatibly, request a fresh selection or approval.
6. **Record.** Log the selected alias, registry identity, upstream name, and catalog revision, with an escaped diagnostic representation available for investigation.

A model can still choose the wrong valid alias because it misunderstands the task. This design does not eliminate that semantic error. It ensures the dispatcher does not introduce a second identity decision after selection, and that a catalog refresh cannot silently change what an existing approval refers to.

A minimal registration fixture demonstrates the intended boundary:

```python
import re

registry = {}

def register(server_id, upstream_name, handler_id):
    if re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", upstream_name) is None:
        raise ValueError("unsupported tool name: " + ascii(upstream_name))
    key = (server_id, upstream_name)
    if key in registry:
        raise ValueError("duplicate tool identity")
    registry[key] = handler_id

register("server-a", "read", "handler-1")
register("server-b", "read", "handler-2")
assert len(registry) == 2
for name in ["\uff46ile_read", "read\u202eabc\u202c", "read\n"]:
    try:
        register("server-a", name, "unexpected")
    except ValueError:
        pass
    else:
        raise AssertionError("profile admitted " + ascii(name))
print("registration fixtures passed")
```

This is a policy illustration, not a concurrent production registry. A real implementation needs transactional uniqueness, stable server bindings, and explicit catalog-update semantics.

## Confusable detection belongs beside identity

UTS #39 provides confusable detection mechanisms. In revision 32, `skeleton(X)` is defined through `bidiSkeleton(LTR, X)`; copying an older simplified recipe may miss current behavior. Skeletons are intermediate comparison data, unsuitable as display names or identifier normalization. They can change across Unicode versions. [UTS #39, revision 32](https://www.unicode.org/reports/tr39/tr39-32.html)

My proposed application is a secondary admission index. A match against a protected alias should create a collision report containing both original identifiers, their server provenance, and the rule version. It should never transfer permissions between the matching entries.

The action can depend on where ambiguity matters. In a shared tool picker, hold a newly ambiguous alias for review. For two internationalized labels belonging to independently identified tools, retain both and make provenance prominent. A global ban on every similar label would impose unnecessary naming restrictions without strengthening the dispatch key.

Mixed-script checks alone are insufficient: visual ambiguity can occur within one script. Conversely, multilingual labels can mix scripts for ordinary reasons. Choose a detector as a screening mechanism, measure its false positives on the supported languages, and give operators a precise way to resolve a warning.

## Display order is another boundary

Unicode's bidirectional algorithm determines display ordering while text retains logical order. It includes directional controls and isolation mechanisms; displayed order must not be mistaken for a new routing representation. [Unicode UAX #9](https://www.unicode.org/reports/tr9/)

For the proposed ASCII machine-name profile, directional controls are already excluded. Human titles and descriptions need a different policy. Preserve legitimate Arabic and Hebrew text, render untrusted labels in separate directional contexts, and provide an escaped inspection view. Approval screens should keep the action, title, provenance, and registry identity in separate fields rather than assembling a sentence whose visual boundaries depend on the label.

UTS #55 addresses source-code handling and recommends display that respects lexical structure. Its scope matters: it is useful guidance for configuration editors and code review, not an automatic conformance specification for every agent UI. Its discussion also shows why simply deleting directional controls does not solve every bidirectional display issue. [Unicode UTS #55](https://www.unicode.org/reports/tr55/)

Test the actual approval renderer in both left-to-right and right-to-left page contexts. An escaped log fixture verifies stored characters; it cannot verify what a person saw in a browser.

## Internationalized identifiers are a deliberate alternative

Keeping machine identifiers ASCII is a practical starting point, not a claim that Unicode identifiers are inherently unsafe. A platform that needs native-language machine names can define a Unicode profile using UAX #31's identifier properties and normalization framework. The profile must state its repertoire and equivalence rules. [Unicode UAX #31](https://www.unicode.org/reports/tr31/)

That choice creates additional work: collision checks after canonicalization, compatible client implementations, migration rules, and support for legitimate language-specific characters. The benefit is a closer relationship between names people type and the concepts they express. An opaque-ID design trades that convenience for a smaller identity contract while preserving native-language labels.

Adapters deserve special attention. Python normalizes source identifiers to NFKC during parsing, while runtime string-based name access generally does not normalize. Thus generating a Python function identifier from an external tool name can behave differently from looking up that same name in a dictionary. [Python lexical analysis](https://docs.python.org/3/reference/lexical_analysis.html#non-ascii-characters-in-names)

Prefer explicit string mappings over generated identifiers. If code generation is unavoidable, test both the source-language identifier transformation and the serialization back to the upstream protocol.

## Upgrade the collision policy without changing authority

A proposed rollout starts with an inventory of original names, current dispatch keys, aliases, and labels. Run the new rules in report-only mode to discover incompatible names before enforcing admission. Inspect the full collision set; a sample cannot establish that a unique index will build successfully.

For a detector or policy upgrade, calculate new comparison keys beside the old index. Record the algorithm, Unicode data version, and local policy revision separately. Resolve newly detected collisions before activation, and ensure new registrations cannot race with that reconciliation. In a small deployment, a brief registration pause may be simpler than maintaining two admission indexes.

Keep routing IDs and permission bindings stable throughout. Rolling back a detector should restore the previous screening behavior, not resurrect a different tool under an old identity. Alias retirement also needs an explicit rule: retaining tombstones or invalidating all outstanding selections prevents a deleted tool's alias from being reused underneath a pending approval.

Acceptance should demonstrate positive and negative cases: two servers exporting the same valid name remain distinct; rejected Unicode fixtures produce actionable errors; case behavior matches the profile; stale approvals fail after incompatible catalog changes; and an index rebuild reports new collisions without mutating authority. These checks turn a visual-text concern into an observable routing contract.

## Sources

- [Unicode UAX #15](https://www.unicode.org/reports/tr15/)
- [Python unicodedata documentation](https://docs.python.org/3/library/unicodedata.html)
- [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#tool-names)
- [UTS #39, revision 32](https://www.unicode.org/reports/tr39/tr39-32.html)
- [Unicode UAX #9](https://www.unicode.org/reports/tr9/)
- [Unicode UTS #55](https://www.unicode.org/reports/tr55/)
- [Unicode UAX #31](https://www.unicode.org/reports/tr31/)
- [Python lexical analysis](https://docs.python.org/3/reference/lexical_analysis.html#non-ascii-characters-in-names)
