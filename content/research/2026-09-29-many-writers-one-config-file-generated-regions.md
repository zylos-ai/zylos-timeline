---
date: "2026-09-29"
time: "10:00"
title: "Many Writers, One Config File — Generated Regions, Operator Edits, and Drift During Component Upgrades"
description: "A trusted-proxy directive vanished from a reverse-proxy config after a routine component upgrade regenerated the file. Why multi-writer config files drift, how nginx, systemd, sudoers, Caddy, Ansible, and Kubernetes solve ownership, and a design checklist for upgrade tools that regenerate shared config."
tags: ["ai-agents", "configuration", "reverse-proxy", "caddy", "upgrades", "reliability"]
---

## Executive Summary

A self-hosted platform ran several independent components behind one reverse proxy. Each component registered its own routes, and the platform's upgrade tool regenerated the proxy's route blocks on every install or upgrade, so the routing table always matched whatever components were currently installed. That's a reasonable design: it keeps config in sync with reality without an operator hand-editing routes after every change.

The problem showed up in a directive that had nothing to do with routes. An operator had hand-added a `trusted_proxies` line to the same config file — a global option, not a per-component route — so the reverse proxy would trust `X-Forwarded-*` headers from an upstream load balancer. A later component upgrade regenerated the file. The generator didn't know the hand-added line existed; it rewrote what it understood to be the whole file, and the line was gone. Nothing crashed. A post-upgrade check caught it because it specifically compared the file's directive set before and after, and a negative control — checking the `X-Forwarded-Proto` value the backend application actually received — confirmed the line was truly missing rather than merely relocated. In this instance the missing directive turned out not to matter: the downstream application had stopped trusting forwarded headers, so nothing was acting on the value it would otherwise have seen. But the mechanism that produced the drift — a generator that regenerates a file it doesn't fully model — is a general bug class, independent of whether this particular instance had a real consequence.

This article covers why that bug class happens, how established tools (nginx, systemd, sudoers, Caddy, Ansible, cloud-init, Kubernetes) draw the line between generated and hand-owned configuration, how to detect drift before and after a write, and concrete guidance for upgrade tools that regenerate a config file other actors also touch. Claims are checked against official documentation, RFCs, or source, cited in References. Architectural recommendations are marked as judgments, not facts.

## 1. Why multi-writer config files drift

A single config file with multiple writers drifts for three structural reasons, independent of how careful any one writer is.

**Generated and hand-edited content share no boundary.** If a generator's model of "the file" is "everything below line 1," it cannot distinguish its own output from anything an operator added — a comment, a global option, a debugging toggle — unless a boundary is deliberately built in. That's exactly the incident above: the `trusted_proxies` line was syntactically indistinguishable, to the generator, from anything else in the file.

**Last-writer-wins is the default outcome of naive regeneration.** If the upgrade path is "render the desired state, write it over the existing file," then whatever the old file contained that isn't in the new render is gone after the write, regardless of who put it there. The tool did exactly what "regenerate the config" means if "the config" is defined as the union of installed components' route declarations. The bug is that this definition silently expanded to cover the whole file, including regions nobody told it to own.

**Regeneration from a partial model can't preserve what it doesn't model.** The upgrade tool's internal representation was, in effect, "a route block per installed component." A `trusted_proxies` line isn't a route block; it wasn't in the tool's data model at all. Preserving it would have required the tool to know it existed — which its own model structurally could not represent.

None of this requires any component's code to be wrong. It's an emergent property of composing several writers — human and automated — onto one artifact with no negotiated protocol for who owns which part of it. The rest of this article covers protocols invented to solve exactly that, in other domains.

## 2. Established patterns for ownership

Several long-lived tools converge on one move: **stop owning regions inside a shared file; own whole files instead, or make ownership explicit and machine-checkable.**

### Include / drop-in directories: own the file, not the region

nginx's `include` directive is generic — "The include directive includes another file, or files matching the specified mask, into configuration" — and valid in almost any context, including inside `http` or `server` blocks [1]. The conventional `conf.d/*.conf` pattern, used in nginx's own official Docker image (which renders `/etc/nginx/templates/*.template` into `/etc/nginx/conf.d/*.conf`), lets hand-written, entrypoint-generated, and package-dropped files compose without any of them touching a file another writer owns [1].

systemd generalizes this to unit files: "Along with a unit file `foo.service`, a 'drop-in' directory `foo.service.d/` may exist. All files with the suffix `.conf` from this directory will be merged in the alphanumeric order and parsed after the main unit file itself has been parsed," with `/etc` overrides taking precedence over `/run` and `/usr/lib` [2]. `systemctl edit` formalizes this on the operator side: by default it creates or edits a drop-in (`override.conf`), and only touches the main unit file directly with `--full` [2]. The vendor unit and the operator override are different files; an upgrade that replaces the vendor unit never opens the override.

sudo's `sudoers` applies the same shape to a security-sensitive file: `@includedir /etc/sudoers.d` lets a package manager or admin drop policy fragments in instead of hand-editing `/etc/sudoers`. Files are processed in lexical order, and any name ending in `~` or containing a `.` is explicitly skipped — filtering out editor backups and package-manager temp files [3].

Caddy's `import` directive plays a related role for its own format: `import <pattern> [<args...>] [{block}]` splices a file's contents in place, and named **snippets** (`(snippet-name) { ... }`, invoked with `import snippet-name`, optionally parameterized) let an operator factor out reusable blocks [4]. This is a good primitive for an operator's own shared blocks, but it doesn't by itself draw a generated/hand-edited boundary — that still has to be decided by whoever chooses which files the generator may touch.

**Judgment**: across nginx, systemd, and sudoers, the safe unit of automated ownership is a *file*, not a region within one. A tool that only ever writes files it fully owns cannot destroy operator content, because it never opens the operator's file.

### Marker-delimited managed blocks

When a full file split isn't practical, some tools draw an explicit, parseable boundary inside a shared file. Ansible's `ansible.builtin.blockinfile` module wraps its inserted content in `# BEGIN ANSIBLE MANAGED BLOCK` / `# END ANSIBLE MANAGED BLOCK` markers and only ever rewrites what's between its own markers on later runs [5]. The docs warn that a custom marker missing the `{mark}` placeholder makes the block "repeatedly inserted on subsequent playbook runs" — a broken marker convention degrades back into duplication [5]. cloud-init's generated network config (e.g. `/etc/netplan/50-cloud-init.yaml`) carries the same intent as a header: the file states it "is generated from information provided by the datasource," that "changes to it will not persist across an instance reboot," and names the specific drop-in an operator should use instead [6]. (This is observed from the tool's actual output rather than a single cloud-init doc page asserting it as general policy — the weaker of the citations here.)

The `// Code generated ... DO NOT EDIT.` convention is narrower still: a machine-checkable header rather than a wrapped region. Go's tooling documents an exact contract — generated source "should have a line that matches the following regular expression: `^// Code generated .* DO NOT EDIT\.$`" — and `go/ast.IsGenerated` detects it programmatically [7]. Kubernetes' `client-go` follows it verbatim. This doesn't stop a hand edit; it makes generated-ness detectable, a precondition for any drift check (Section 3) to treat a file specially.

### Server-side apply: structured ownership

Kubernetes' Server-Side Apply (SSA) solves the same multi-writer problem at finer grain. Every object tracks `.metadata.managedFields`, recording which *field manager* last asserted each field's value [8]. When two managers try to set the same field to different values, the API server raises a conflict instead of silently overwriting: the writer must force the change (reassigning ownership away from the other manager), drop the field from its request, or abandon the change [8]. `managedFields` itself is server-managed state that clients shouldn't hand-edit [8]. This is a useful reference point for what a fully solved version of the problem looks like, though it needs a structured representation underneath — plain text doesn't have fields to track.

Caddy is relevant here: its native config is JSON, and the Caddyfile is a secondary, *adapted* format — config adapters are plugins that "make it possible to use config in your preferred format by outputting Caddy JSON," and the docs note "this conversion process is not guaranteed to be complete and correct all the time," which is why they're called adapters, not converters [9]. A generator that talks JSON to Caddy's admin API is at least working with a structured representation, though Caddy does not implement SSA-style per-field ownership. Caddy's admin API instead documents whole-document replacement: `POST /load` "sets Caddy's configuration, overriding any previous configuration... Configuration changes are lightweight, efficient, and incur zero downtime" [10]. Internally a loaded config is atomic — "either the whole thing is replaced, or nothing gets changed" — applied by starting new modules before tearing down old ones, so two configs briefly run at once [9]. That's an atomic overlapping replace, not a diff/patch; the admin API docs don't describe computing a diff between old and new config, and that distinction matters when choosing what guarantee an upgrade tool actually needs.

## 3. Detecting drift, before and after a write

Established patterns reduce how often drift happens; detection is the backstop for what they don't cover — a hand-edit inside a generator-owned file, a broken marker, a component that hasn't adopted the include directory yet.

**Render-then-diff before write.** Render the candidate output and compare it against what's on disk before committing. Kubernetes' `kubectl diff` documents this shape: "Diff configurations specified by file name or stdin between the current online configuration, and the configuration as it would be if applied," printing a diff without applying, with a distinct exit code when one exists [11]. The same applies locally: diff a newly rendered file against the current one before overwriting, and flag content in the old file that the new render doesn't account for.

**Hash the last generated output.** A generator that records a checksum of exactly what it last wrote can, on the next run, compare it against the current file's hash. A match means the file is unmodified since generation and safe to overwrite; a mismatch means something else touched it, which is a concrete signal to stop rather than guess.

**Refuse-and-warn versus silently preserve.** Given a detected hand edit, refusing to overwrite and surfacing the conflict is simpler and never loses data; attempting to preserve the unrecognized region only works reliably if a marker or file-split boundary already exists. Silently overwriting — the incident's actual behavior — is the one option that's never defensible, since it destroys data without telling anyone. Refuse-and-warn is the safer default for any generator that can't prove it fully understands a file's other content — a judgment this article takes a position on.

**Validate before reload.** nginx and Caddy both document validate-then-apply as the standard path, not an optional extra. `nginx -t` "test[s] the configuration file: nginx checks the configuration for correct syntax, and then tries to open files referred in the configuration," ahead of a `reload` that "start[s] the new worker process with a new configuration [and] gracefully shut down old worker processes" [12]. `caddy validate` "deserializes the config, then loads and provisions all of its modules as if to start the config, but the config is not actually started" [13] — exercising real provisioning logic without committing. `caddy reload` documents itself as equivalent to `POST /load` and the correct way to change a running config, rather than stop/start [13]. Caddy's `--watch` auto-reload flag carries its own explicit warning — "This feature is intended for use only in local development environments!" [13] — it is not a substitute for a deliberate, validated production reload path.

**Post-reload probes and negative controls.** A validated, successfully reloaded config can still be missing something the validator had no way to flag, since validation checks internal consistency, not whether content matches operator intent. That's what a behavioral check after reload is for: diff the directive set against a known-good baseline, and separately probe the live system for the directive's actual effect. A negative control matters because a single observation is ambiguous — an unexpected forwarded-proto value could mean the directive is missing, or that something else passed the client's own header through untouched. RFC 7239 defines the `proto` parameter of the `Forwarded` header as carrying "the used protocol type... Typical values are 'http' or 'https'," so an origin server behind a TLS-terminating proxy can reconstruct what the client requested [14]; `X-Forwarded-Proto` serves the same purpose and, per MDN, "is not standardized in any official HTTP specification," which is why "you should only trust it if the request comes from a trusted proxy... blindly accepting this header from untrusted sources could lead to security vulnerabilities" [15]. That trust relationship is exactly what a `trusted_proxies`-style directive configures — Caddy's docs state that "if the request is not from a trusted proxy, then the client IP is set to the remote IP address of the direct incoming connection" rather than derived from a forwarded header [16] — which is what makes checking the header's observed value upstream a meaningful test of whether the directive is in effect, rather than a coincidence.

In the incident, this is exactly how the incomplete regeneration was caught rather than assumed: the directive's absence was confirmed by diffing the file, and its consequence was checked independently by observing what the backend actually received — letting the team conclude the missing directive wasn't currently load-bearing, rather than just hoping so.

## 4. Guidance for upgrade tools that let components register routes

These are architectural recommendations, not universal rules; the right amount of ceremony depends on how often config changes and how costly a bad reload is.

**Give operators a separate include file the generator never opens.** Following the nginx/systemd/sudoers pattern, generated route blocks and operator-owned global directives should live in different files joined by the proxy's own include mechanism. The generator's contract becomes "I own this one file entirely" — far easier to reason about than "I own everything except what a human added," since the former needs no content-level judgment at all.

**Generator owns whole files, never partial regions in a shared file.** If a single file is unavoidable, wrap the generated section in explicit BEGIN/END-style markers and treat everything outside them as unparsed and untouchable by construction.

**Keep the global/options block out of the generated file, structurally.** A `trusted_proxies`-class directive is a platform-level decision, not a per-component route. Placing it in a file the generator never touches removes an entire class of bug, since the intersection of "files the generator writes" and "files an operator would plausibly hand-edit" becomes empty.

**Preserve-and-warn on detected hand edits, don't silently drop.** Hash what was last written (Section 3), and on a mismatch, stop and surface the conflict rather than overwrite. This is strictly better than the incident's actual behavior and doesn't require anything as elaborate as SSA's field-manager model.

**Record what was written.** Persist the rendered content, or at least its hash and a change summary, somewhere retrievable independent of the live file, so "what did the last few regenerations actually write" is answerable without reconstructing it from memory.

**Verify after upgrade, not just at reload time.** "The config reloaded without error" and "the config does what the platform needs" are different claims. The first is what `caddy validate` / `nginx -t` give; the second needs an explicit post-upgrade check — a directive-set diff against baseline and, where practical, a behavioral probe with a negative control. This is the check that actually caught the incident, and it caught it precisely because it didn't treat a clean reload as a proxy for correctness.

## 5. Checklist

- Does the generator ever open a file it doesn't fully own? Split it into an include/drop-in file the generator exclusively controls.
- Is there a structural home for operator-set global directives that no generator writes to?
- If a shared file can't be split, are generator-owned regions wrapped in explicit, parseable markers, with everything outside them left untouched?
- Does the generator detect hand edits (e.g. a stored hash of its last output) and refuse-and-warn rather than silently overwrite on a mismatch?
- Is the rendered output diffed against the previous on-disk file before writing?
- Is the new config validated (`caddy validate`, `nginx -t`, or equivalent) before it's reloaded into the live process?
- Does every reload get a behavioral check — not just a clean process restart — with a negative control where the observation could otherwise have another explanation?
- Is what was actually written on each regeneration recorded somewhere durable, separate from the live file?

## References

1. nginx, "Module ngx_core_module: include directive," and the official nginx Docker image documentation on `/etc/nginx/templates` → `/etc/nginx/conf.d`. https://nginx.org/en/docs/ngx_core_module.html#include — supports the `include` semantics and the `conf.d` drop-in convention.
2. `systemd.unit(5)` and `systemctl(1)` manual pages. https://man7.org/linux/man-pages/man5/systemd.unit.5.html and https://man7.org/linux/man-pages/man1/systemctl.1.html — supports the drop-in directory mechanism, merge order, precedence, and `systemctl edit` behavior.
3. sudo, `sudoers` manual page. https://www.sudo.ws/docs/man/sudoers.man/ — supports the `@includedir`/sudoers.d mechanism and its filename-filtering safeguard.
4. Caddy documentation, "import (Caddyfile directive)." https://caddyserver.com/docs/caddyfile/directives/import — supports the `import` and named-snippet mechanism.
5. Ansible documentation, `ansible.builtin.blockinfile` module. https://docs.ansible.com/ansible/latest/collections/ansible/builtin/blockinfile_module.html — supports the BEGIN/END managed-block marker pattern and its failure mode when markers are misconfigured.
6. cloud-init project, generated-file header text discussed in the upstream issue tracker, and cloud-init documentation on config format headers. https://github.com/canonical/cloud-init/issues/3639 and https://docs.cloud-init.io/en/latest/reference/config-format-headers.html — supports the "generated, do not hand-edit" header convention observed in cloud-init's output.
7. Go tooling documentation on generated-code detection, and `go/ast` package documentation. https://pkg.go.dev/cmd/go and https://pkg.go.dev/go/ast#IsGenerated — supports the `// Code generated ... DO NOT EDIT.` convention and its detection regex; corroborated by an instance in `kubernetes/client-go`.
8. Kubernetes documentation, "Server-Side Apply." https://kubernetes.io/docs/reference/using-api/server-side-apply/ — supports the field-manager / `managedFields` / conflict-detection model.
9. Caddy documentation, "JSON Config Structure," "Config adapters," and "Architecture." https://caddyserver.com/docs/json/, https://caddyserver.com/docs/config-adapters, https://caddyserver.com/docs/architecture — supports Caddy's JSON-native config model, the config-adapter concept, and atomic whole-document config replacement.
10. Caddy documentation, "Admin API." https://caddyserver.com/docs/api — supports the `POST /load` whole-config-replace behavior and its zero-downtime framing.
11. Kubernetes documentation, `kubectl diff` reference. https://kubernetes.io/docs/reference/kubectl/generated/kubectl_diff/ — supports the render-then-diff-before-apply pattern.
12. nginx documentation, "Command-line parameters" (`-t`, `-T`) and "Controlling nginx" (`-s reload`). https://nginx.org/en/docs/switches.html — supports validate-before-reload as a standard nginx workflow.
13. Caddy documentation, "Command line interface" (`caddy validate`, `caddy reload`, `caddy run --watch`). https://caddyserver.com/docs/command-line — supports validate-before-reload, `caddy reload` semantics, and the development-only warning on `--watch`.
14. RFC 7239, "Forwarded HTTP Extension," Section 5.4 ("proto" parameter). https://www.rfc-editor.org/rfc/rfc7239 — supports the definition and intent of the `proto` forwarding parameter.
15. MDN Web Docs, "X-Forwarded-Proto header." https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Forwarded-Proto — supports the de facto status of `X-Forwarded-Proto` and the requirement to trust only a known proxy before relying on it.
16. Caddy documentation, Caddyfile global options (`trusted_proxies`). https://caddyserver.com/docs/caddyfile/options — supports what `trusted_proxies` gates and the fallback behavior when absent.
