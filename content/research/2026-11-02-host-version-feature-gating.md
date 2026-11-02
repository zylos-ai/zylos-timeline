---
date: "2026-11-02"
time: "09:00"
title: "Does the Host Support This Yet? Version Gating vs Feature Detection for Plugins"
description: "How VS Code, npm, Chrome, Kubernetes, Terraform, LSP, Git, and clustered databases let a plugin decide whether an older or newer host supports a feature, and what that means for a component calling a CLI that rejects unknown flags."
tags: ["research", "compatibility", "versioning", "plugins", "feature-detection", "agent-platform", "upgrades"]
---

## Executive Summary

A component wants to pass a new flag to its host's command-line tool, but the installed host may be older than the component expects. If the host rejects unknown flags, a wrong guess loses the message. If the component never uses the flag, a newer host never gets the feature. The component needs a cheap, trustworthy answer to one question: does this host support feature X right now?

Mature ecosystems answer in three ways, and most combine them:

1. **Declared ranges.** The plugin states which hosts it works with (`engines.vscode`, `minimum_chrome_version`, `peerDependencies`). The host or a store enforces it at install time.
2. **Advertised capabilities.** The host says what it supports, and the plugin reads that list (LSP `initialize`, Git protocol v2, Kubernetes discovery).
3. **Version arithmetic at call time.** The plugin compares a version number to a table of minimums. This is the design we have chosen for Zylos.

Version arithmetic is the weakest signal in principle. A version is a proxy for capability, and the proxy breaks with backports, forks, prereleases, and mid-upgrade states. In our situation it is still a defensible choice, for a specific reason: the host rejects unknown flags, so "try and fall back" cannot be used safely. The design is sound if it is strict about what a version proves, fails closed whenever evidence is missing, and eventually moves toward host-advertised capabilities. This article gives the evidence for those conclusions and the places where our design is strong or limited.

## Three Ways a Plugin Learns What the Host Can Do

| Mechanism | Who decides | When checked | Examples | Main weakness |
|---|---|---|---|---|
| Declared range | Plugin author | Install or update time | VS Code `engines.vscode`, Chrome `minimum_chrome_version`, npm `engines` | Coarse; can be advisory only; says nothing about the moment of the call |
| Advertised capabilities | Host | Connection or call time | LSP `initialize`, Git protocol v2, Kubernetes discovery, Docker API negotiation | Requires the host to implement it; older hosts do not |
| Version comparison | Plugin author, using the host's version | Call time | Zylos component checking the installed Core version (our design) | Version is a proxy; breaks with backports, forks, prereleases |
| Try and fall back | Neither; the host reacts | Call time | Feature probing in browsers (`"geolocation" in navigator`) | Only safe if a rejected attempt has no side effects |

## Declared Compatibility Ranges

**VS Code.** The extension manifest requires an `engines` object with a `vscode` key whose value says which VS Code versions the extension works with. The reference says the value "Cannot be `*`", and its example is that `^0.10.5` indicates a minimum version of `0.10.5` ([manifest reference](https://code.visualstudio.com/api/references/extension-manifest)). The publishing guide explains the purpose: the field exists to "ensure the extension only gets installed for clients that contain the API you depend on." It adds that a version requiring `>=1.9.0` is offered only to VS Code builds that meet it, so stable users get the update only when stable reaches that version ([publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)). The check is enforced by the marketplace and editor before code runs, not by the extension.

Two details matter later. First, VS Code's pre-release extension support says "We only support `major.minor.patch` for extension versions, `semver` pre-release tags are **not supported**", and recommends odd minor numbers for pre-releases. The ecosystem avoided prerelease-comparison problems by not allowing prerelease tags at all. Second, proposed APIs are an explicit opt-in to instability: they are "a set of unstable APIs" that are "subject to change" and "only available in Insiders", and the docs state "you should not publish extensions using the proposed API on the Marketplace" ([proposed API guide](https://code.visualstudio.com/api/advanced-topics/using-proposed-api)). Unstable features are fenced off from the normal compatibility promise.

**Chrome.** `minimum_chrome_version` blocks installs. On older Chrome the Web Store shows "Not compatible", and existing users "won't receive updates when the `minimum_chrome_version` is higher than their current browser version." The docs add: "This happens silently" ([Chrome docs](https://developer.chrome.com/docs/extensions/reference/manifest/minimum-chrome-version)). That is a fail-closed policy with a known cost: users stay on old code without knowing why.

**npm.** In `package.json`, `engines` "is advisory only and will only produce warnings when your package is installed as a dependency" unless the user enables `engine-strict`. `peerDependencies` express compatibility with a host tool or library, and `peerDependenciesMeta` can mark them optional ([package.json docs](https://docs.npmjs.com/cli/v10/configuring-npm/package-json)). Declared ranges are only as strong as their enforcement.

**Terraform.** Providers talk to Terraform core over a plugin protocol. Protocol version 5 is compatible with Terraform CLI 0.12 and later; version 6 with CLI 1.0 and later, and it adds nested attributes. The Registry "uses the protocol version as additional compatibility metadata" when selecting plugin versions ([protocol docs](https://developer.hashicorp.com/terraform/plugin/terraform-plugin-protocol)). The Terraform page describes registry metadata only. For the process-level handshake, HashiCorp's go-plugin guide shows the plugin printing a line of the form `CORE-PROTOCOL-VERSION|APP-PROTOCOL-VERSION|NETWORK-TYPE|NETWORK-ADDR|PROTOCOL` (for example `1|1|tcp|127.0.0.1:1234|grpc`), and states that a core protocol version other than the supported value "will cause your plugin to not load" ([go-plugin guide](https://github.com/hashicorp/go-plugin/blob/main/docs/guide-plugin-write-non-go.md)). The compatibility unit is a small integer protocol version, not the product version.

## Capability Advertisement

**LSP.** The language server protocol exchanges capabilities in the `initialize` request: "The set of capabilities is exchanged between the client and server during the initialize request." Unknown capabilities are tolerated in both directions. The spec says "Clients should ignore server capabilities they don't understand (e.g. the initialize request shouldn't fail in this case)", that "A missing property should be interpreted as an absence of the capability", and that servers receiving client capabilities with unknown properties "should ignore these properties." The client also "must not send any additional requests or notifications to the server" until the server has answered `initialize` ([LSP 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)). The design principle is that absence means no, and the unknown is ignored rather than rejected.

**Git protocol v2.** A server that chooses protocol v2 replies with a `version 2` line followed by a capability list, each capability being "a key with an optional value". The key rule: "Clients must ignore all unknown keys." The server then checks that the client's request "is comprised of a valid command as well as valid capabilities which were advertised" ([protocol-v2](https://git-scm.com/docs/protocol-v2)). The host publishes the menu, and both sides promise to tolerate items they do not know.

**Kubernetes discovery.** The API server publishes "a list of all group versions and resources supported via the Discovery API" at `/api` and `/apis`, with per-group-version documents at `/apis/<group>/<version>`; kubectl uses these endpoints to learn what a cluster supports. Aggregated discovery returns everything in two requests via a special `Accept` header ([API overview](https://kubernetes.io/docs/concepts/overview/kubernetes-api/)). A client asks what exists instead of inferring it from a release number.

**Docker.** Docker's Engine API supports version negotiation: a client that connects to an older engine "negotiates the highest version of the API supported by both the client and daemon." Setting `DOCKER_API_VERSION` "disables API version negotiation" ([Engine API docs](https://docs.docker.com/reference/api/engine/)). Negotiation yields one agreed version that both sides support, rather than relying on the client's own version alone.

All of these require the host to cooperate. A host that predates the mechanism cannot advertise anything, so the plugin falls back to version reasoning or assumes "no".

## Version Checks Versus Feature Detection

MDN defines feature detection as "working out whether a browser supports a certain block of code, and running different code depending on whether it does (or doesn't)", and calls browser sniffing "a terrible practice that should be discouraged at all costs" ([MDN](https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Testing/Feature_detection)). Its example, `"geolocation" in navigator`, works because probing is free and harmless.

That argument depends on a probe that has no consequence. A CLI that rejects unknown flags does not give you a free probe. argparse's `parse_args()` "exits and prints the error along with a usage message" on an unrecognized argument, and the documented exit status is 2; `parse_known_args()` is the lenient alternative that returns unknown arguments instead ([argparse docs](https://docs.python.org/3/library/argparse.html)). Commander.js is similarly strict by default: "By default, the option processing shows an error for an unknown option", relaxed only by `.allowUnknownOption()` ([Commander README](https://github.com/tj/commander.js)). If the call carries a message that must be delivered, trying the flag and retrying on failure is only safe if the host rejects the call before doing any work and the failure can be told apart from other errors. An exit status of 2 is a convention, not a guarantee. A component cannot assume it.

| Failure mode | What happens | Applies to |
|---|---|---|
| Backport | Fix or feature appears in an older version number, so a version check says "unsupported" when the feature exists | Distribution-patched packages. Red Hat notes that "Just looking at the version number of a package will not tell them if they are vulnerable or not" ([backporting](https://access.redhat.com/security/updates/backporting)) |
| Fork or custom build | Version number copied from upstream, but behavior differs | Any version check |
| Prerelease ordering | Prerelease sorts below the release but above earlier versions; range helpers may exclude it entirely | Semver comparison (see below) |
| Unknown flags rejected | A wrong "yes" loses the call | Strict CLI parsers |
| Unknown flags ignored | A wrong "yes" silently drops the feature, with no error to react to | Lenient parsers, protocols like LSP and Git v2 |
| Stale answer | The version was true when read, and false by the time of the call | Cached or startup-time checks |

The two rejection behaviors need different safeguards. If the host ignores unknown flags, sending too eagerly is harmless but invisible. If it rejects them, sending too eagerly is loud but destructive. That asymmetry is the argument for failing closed when delivery matters.

### Prerelease semver pitfalls, tested

The semver spec says "Pre-release versions have a lower precedence than the associated normal version" (`1.0.0-alpha < 1.0.0`), and that a pre-release "indicates that the version is unstable and might not satisfy the intended compatibility requirements" ([semver.org](https://semver.org/)). The `node-semver` README adds a rule for ranges: a prerelease version only satisfies a comparator set if some comparator with the same `[major, minor, patch]` tuple has a prerelease tag, because prereleases "frequently are updated very quickly, and contain many breaking changes" ([node-semver](https://github.com/npm/node-semver)).

We ran a short check with node-semver 7.8.5 against a minimum of `1.0.0-beta.1`:

| Installed | `gte(v, '1.0.0-beta.1')` | `satisfies(v, '>=1.0.0-beta.1')` |
|---|---|---|
| `1.0.0-beta.1` | true | true |
| `1.0.0-beta.2` | true | true |
| `1.0.0-rc.1` | true | true |
| `1.0.0` | true | true |
| `1.0.1-beta.1` | true | **false** |
| `2.0.0-beta.1` | true | **false** |

Direct comparison and range matching disagree for prereleases of a different version tuple. Other results from the same run: `coerce('1.0.0-beta.1')` returned `1.0.0`, which silently turns a beta into a release and passes a minimum it may not meet; `gt('1.0.0-beta.10', '1.0.0-beta.2')` is true (numeric identifiers compare as numbers) but `gt('1.0.0-beta10', '1.0.0-beta2')` is false (the dotless form compares as text); and a leading `v` as in `v1.0` returns null from `valid()`, an invalid result that must map to "unsupported". Practical rules: parse strictly, compare with an exact `gte` rather than ranges, never coerce, and test the table against concrete prerelease strings.

## Where the Version Comes From

Three choices matter: where the version is read, when, and how.

**Package metadata versus running `--version`.** Reading a file is cheap and has no side effects. Spawning the host to ask costs a process start, can hang, and can trigger the side effects of loading the host's configuration. A rough local measurement, with npm standing in for a host CLI: resolving the executable's real path and parsing its `package.json` took about 0.04 ms per call over 200 iterations, while spawning `npm --version` took about 49 ms per call over five runs. This is one machine and one tool, not a benchmark, but the two-orders-of-magnitude gap is the point. The tradeoff is trust: the package metadata describes what was installed, not necessarily what runs.

**PATH, symlinks, and multiple installs.** npm documents that global installs on Unix go to `{prefix}/lib/node_modules` and that "executables are linked into `{prefix}/bin`" ([folders docs](https://docs.npmjs.com/cli/v10/configuring-npm/folders)). So the path found on `PATH` is a symlink, and following it to the real package is the right way to find the version of the code that would run. Two installs on one machine (a global install and a development checkout, say) mean "the host" depends on PATH order. The component must resolve the same executable it then invokes. If it resolves one and runs another, the check is meaningless.

**Per call versus cached.** Caching a version at startup is risky for a long-lived component, because the host can be upgraded or downgraded beneath it (the upgrade docs above all treat version changes as a normal, ongoing event). A per-call read of a local file is cheap enough, per the timing above, that caching adds risk without much gain. This is our reasoning, not a rule from any of the cited projects.

## Behavior During Host Upgrades

The riskiest moment for any version check is the upgrade itself, when hosts are in transitional states.

**Kubernetes** builds this into policy. `kubectl` "is supported within one minor version (older or newer) of `kube-apiserver`". In HA clusters the newest and oldest API servers "must be within one minor version." `kubelet` "must not be newer than `kube-apiserver`" and may be up to three minor versions older. The skew policy dictates upgrade order, and `kube-apiserver` must not skip minor versions ([version skew policy](https://kubernetes.io/releases/version-skew-policy/)). The lesson: mixed versions are expected, bounded, and ordered.

**Elasticsearch** says "A mixed-version cluster is only valid during a rolling upgrade", "Elasticsearch does not support downgrading to an earlier version", and "Running more than two versions of Elasticsearch in the same cluster is not supported." It recommends an upgrade order by node role and warns that "earlier version nodes cannot always join a cluster with an upgraded master" ([Elasticsearch upgrade docs](https://www.elastic.co/docs/deploy-manage/upgrade/deployment-or-cluster/elasticsearch)).

**CockroachDB** separates installing a new binary from enabling its features. Until the upgrade is finalized, "these features and functions will not be available," and `SHOW CLUSTER SETTING version` "will return the previous version." Auto-finalization happens when all nodes have rejoined on the new binary, and before then "Rollbacks do not require finalization" ([upgrade docs](https://docs.cockroachlabs.com/docs/stable/upgrade-cockroach-version)).

**RabbitMQ** uses feature flags for the same purpose: they let nodes with different versions "determine if they are compatible", flags are enabled only after all nodes are upgraded, and "Once enabled, a feature flag cannot be disabled" ([feature flags](https://www.rabbitmq.com/docs/feature-flags)).

The shared principle is conservative gating: a new capability is switched on only after every participant that might see it is known to support it, and the "switch" can be held back. A client facing a host mid-upgrade has the same problem without the cluster protocol: it cannot tell which version will answer. The conservative answer is "not yet".

## Fail Closed or Fail Open

For optional features, the choice depends on the cost of each wrong answer:

| Wrong answer | Cost with strict-reject host | Cost with ignore host |
|---|---|---|
| Fail open, host actually lacks feature | Call rejected; message lost | Feature silently not applied |
| Fail closed, host actually has feature | Feature skipped; call succeeds | Feature skipped; call succeeds |

Fail closed has a cost that is bounded and visible in design: the feature is unavailable until evidence arrives. Fail open has a cost that can be unbounded and lands on the user's data. Chrome's silent update stop shows the downside of closed behavior: it should be visible somewhere, such as a log line stating why a feature is off, so the situation can be diagnosed.

## Design Guidance for a Zylos-Style Component and Host

The chosen design: on each call, resolve `zylos` on `PATH`, follow the real path to the installed package, read its `package.json` version, compare to a per-feature table of minimums keyed by major line (for example `sessionGroup: {1: '1.0.0-beta.1'}`), do not cache, do not spawn `zylos --version`, treat everything as unsupported if an upgrade-in-progress marker exists or cannot be checked, and treat an unreadable or invalid version as unsupported.

**Where it is strong**

- **It matches the cost of a wrong yes.** Because old hosts reject unknown flags, try-and-fall-back is unsafe and a wrong yes loses the message. Failing closed is consistent with the conservative gating CockroachDB and RabbitMQ use.
- **Reading metadata is cheap and side-effect free.** About 0.04 ms against about 49 ms in our measurement, with no hang risk and no host code executed.
- **No cache means no stale answer** for a long-lived PM2 process, and the cost of rereading is negligible.
- **Keying minimums by major line** follows the Terraform protocol-version idea: compatibility is a property of a generation. A `2.0.0-beta.1` host passes a bare `gte` against `1.0.0-beta.1` (see the table above), yet a new major version is where breaking changes are permitted under semver, so a flag from the 1.x line cannot be assumed to survive. With a table keyed by major, an unlisted major line is unsupported until someone adds it.
- **The upgrade marker covers the known mixed state** that version files cannot show. It is the component-level analogue of "do not enable until finalization."
- **Unreadable or invalid means unsupported** is the rule LSP encodes: "A missing property should be interpreted as an absence of the capability."

**Implementation details that decide whether it works**

- Compare with `semver.gte` on parsed versions within the matching major, not ranges (`satisfies` rejects `1.0.1-beta.1` against `>=1.0.0-beta.1`) and not `coerce`. Test the table with concrete strings: `1.0.0-alpha.9` (below), `1.0.0-beta.1`, `1.0.0-beta.2`, `1.0.0-rc.1`, `1.0.0`, `1.0.1-beta.1`, `2.0.0-beta.1` (no table entry), `v1.0`, and an empty string.
- Do not use `fs.existsSync` for the marker. Node documents it as returning `true` if the path exists and `false` otherwise ([fs docs](https://nodejs.org/docs/latest/api/fs.html)), and we confirmed locally that it returns `false` for a file inside a directory with permissions `000`, even though the file exists. The same path under `statSync` throws `EACCES`. Use `statSync` or `lstatSync` and treat only `ENOENT` as "absent"; every other error means "cannot determine", which is "unsupported".
- Resolve and invoke the same binary. Pass the resolved path to the process launcher, or verify that `PATH` resolution is identical at both points.

**Honest limits**

- **A version is a proxy.** Backports and forks can make a capable host look incapable, which fails closed and so is safe. The reverse, a version that meets the minimum but lacks the feature (a local development build, a downstream distribution), is not detected at all.
- **Check and use are separate steps.** An upgrade can start between the version read and the call. The marker narrows this window but cannot close it, and it only protects upgrades that cooperate by writing it.
- **Package metadata may not match the running code.** The `package.json` on disk describes what is installed. A host updated on disk but not restarted, or an install that is partly written, can show a different version than the code that will handle the call. We did not test npm's non-atomic update behavior, so treat this as an unverified risk, not an observed fact.
- **Closed-by-default needs visibility.** A new major line with no table entry silently disables features. Log one concise reason per decision so that "feature off" is diagnosable, as Chrome's silent update stop shows.
- **It does not handle downgrades or a partially applied rollback** any better than other version gates do; the marker is the only guard.

**A better long-term direction.** Add an advertised capability list to the host and read it with the same cheap file read: for example a documented `features` array in the host's package metadata or a small manifest shipped beside it. Treat the version table as the fallback for hosts that predate the field. This follows Git's and LSP's model, where the host publishes what it supports and the client ignores what it does not know, and it handles backports and forks directly. It also avoids the need to spawn the host. It does not remove the need for the fail-closed rules above: a missing or unreadable list must still mean "no".

## Conclusions

1. Declared ranges are install-time contracts. They do not tell a running component what the host can do right now.
2. Capability advertisement is the strongest runtime signal, but only when the host implements it and the plugin treats absence as "no".
3. Try-and-fall-back requires a harmless failed attempt, and a host that rejects unknown flags does not provide one.
4. If a version check is the only available signal, make it strict: parse exactly, compare within a major line, never coerce, fail closed on any uncertainty, and treat an in-progress upgrade as uncertain.
5. The practical next step is for the host to publish its features beside its version.

## Sources

Primary documentation:

- VS Code, [Extension manifest reference](https://code.visualstudio.com/api/references/extension-manifest), [Publishing extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension), [Using proposed APIs](https://code.visualstudio.com/api/advanced-topics/using-proposed-api)
- npm, [package.json: engines, peerDependencies, bin](https://docs.npmjs.com/cli/v10/configuring-npm/package-json) and [folders](https://docs.npmjs.com/cli/v10/configuring-npm/folders)
- Chrome for Developers, [minimum_chrome_version](https://developer.chrome.com/docs/extensions/reference/manifest/minimum-chrome-version)
- Kubernetes, [Version skew policy](https://kubernetes.io/releases/version-skew-policy/) and [Kubernetes API overview (Discovery API)](https://kubernetes.io/docs/concepts/overview/kubernetes-api/)
- HashiCorp, [Terraform plugin protocol](https://developer.hashicorp.com/terraform/plugin/terraform-plugin-protocol) and [go-plugin non-Go guide](https://github.com/hashicorp/go-plugin/blob/main/docs/guide-plugin-write-non-go.md)
- Microsoft, [Language Server Protocol 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)
- Git, [Protocol v2](https://git-scm.com/docs/protocol-v2)
- Docker, [Engine API](https://docs.docker.com/reference/api/engine/)
- CockroachDB, [Upgrade to a new version](https://docs.cockroachlabs.com/docs/stable/upgrade-cockroach-version)
- Elastic, [Upgrade Elasticsearch](https://www.elastic.co/docs/deploy-manage/upgrade/deployment-or-cluster/elasticsearch)
- RabbitMQ, [Feature flags](https://www.rabbitmq.com/docs/feature-flags)
- Semantic Versioning, [semver.org](https://semver.org/) and [node-semver README](https://github.com/npm/node-semver)
- MDN, [Feature detection](https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Testing/Feature_detection)
- Red Hat, [Backporting security fixes](https://access.redhat.com/security/updates/backporting)
- Python, [argparse](https://docs.python.org/3/library/argparse.html); Commander.js, [README](https://github.com/tj/commander.js)
- Node.js, [fs API](https://nodejs.org/docs/latest/api/fs.html)

Local checks (not benchmarks): node-semver 7.8.5 comparison table above; `fs.existsSync` versus `statSync` on an unreadable directory; and a read-versus-spawn timing using npm as a stand-in host CLI, all run on Node 24 on Linux.
