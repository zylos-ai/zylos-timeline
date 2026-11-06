---
date: "2026-11-06"
time: "09:00"
title: "Install Hooks With Implicit Targets: Why a Package Install Must Not Guess Which Instance It Changes"
description: "A package's install-time script that picks its target from an env var with a HOME-relative default will eventually rewrite the wrong instance on a multi-instance host; this article surveys how npm, pnpm, Yarn, Debian, RPM, Homebrew, pip and Nix constrain install-time side effects, and sets out design patterns, a sandbox test and a checklist for agent-framework maintainers."
tags: ["research", "packaging", "npm", "postinstall", "multi-instance", "agent-infrastructure", "reliability"]
---

## Executive Summary

An AI-agent framework ships as a global npm package. Its `postinstall` script syncs bundled skills into the agent's data directory, and picks that directory with `process.env.AGENT_DIR || ~/agent`. On a test machine hosting several agent instances side by side, each selected by its own env var, an operator installed a candidate build to try a new instance. They ran `npm install -g` without the env var. The postinstall silently rewrote 32 skill files and 3 upgrade scripts in the default instance, an unrelated older instance that was under test. Its database and config were untouched, so the instance was left half-upgraded. No backup existed, nothing was logged where the operator would look, and reinstalling the old package would probably restore the files but could not prove that nothing else had drifted.

The main findings of this research are:

- **Install hooks are the one place where code runs with the installer's authority before any human has looked at what it does.** Every mature packaging ecosystem has therefore moved toward narrowing what install-time code may touch. Nix runs builds in a sandbox. Python wheels are unpacked, not executed. pnpm, Yarn and (since npm 12) npm stop running dependency scripts by default. Debian and RPM policy demand idempotent, non-interactive maintainer scripts that never clobber local configuration.
- **None of these mechanisms protects a script from itself.** `postinstall` of the package you explicitly asked for still runs on `npm install -g`, as an ordinary process with your user's privileges and `HOME`. Where its writes land is entirely the script author's decision.
- **The "implicit target" failure class** (env var with a default, HOME-relative paths) is correct in the common case and silently wrong in the rare one. It is wrong exactly when more than one candidate target exists.
- **The fix is structural, not a better default.** Install the code at install time. Deploy into an instance with an explicit command that names its target, prints a plan, backs up, stamps versions, and refuses to guess when more than one candidate exists. An opt-out env var is weaker than opt-in because the failure mode of opt-out is the operator forgetting something.
- **It is cheap to test.** Install into a sandbox `HOME` that contains a decoy default instance, fingerprint it before and after, and fail the build if anything changed. I ran a minimal version of this harness during research to confirm the mechanics (see section 4).

## 1. The incident, abstracted

The relevant code was probably 10 lines:

```js
// postinstall.js (illustrative reconstruction of the pattern, not the real source)
const target = process.env.AGENT_DIR || path.join(os.homedir(), 'agent');
syncSkills(bundledSkillsDir, path.join(target, 'skills'));
syncUpgradeScripts(bundledUpgradeDir, path.join(target, 'upgrades'));
```

Three facts combined into the incident:

1. The host had **several** instances, each addressed by its own env var. The default path was therefore one real instance among many, not a harmless empty fallback.
2. `npm install -g` is a package-level action. The operator's mental model was "install the candidate build for instance B". The package's model was "sync into whatever `AGENT_DIR` or the default says".
3. The sync was partial. It rewrote code-like assets (skills, upgrade scripts) but not state (database, config), producing a version-skewed instance: new skills reading an old schema.

The damage is not the 35 files. It is the loss of provenance: with no manifest or backup, nobody can say what the instance looked like before. This is the same shape as a destructive-default bug, even though here the action was a write rather than a delete.

## 2. How install-time hooks work across ecosystems, and where side effects land

### npm

The npm docs list the hooks that run on `npm install`: `preinstall`, `install`, `postinstall`, `prepublish`, `preprepare`, `prepare` and `postprepare`. The scripts page states "These also run when you run `npm install -g <pkg-name>`", and that "Scripts are run from the root of the package folder" ([npm scripts](https://docs.npmjs.com/cli/v10/using-npm/scripts)). The same page says "The only valid use of `install` or `preinstall` scripts is for compilation", which makes a skills-syncing postinstall off-label by the docs' own standard. It also carries a relevant piece of guidance: scripts should "Inspect the env to determine where to put things", and its example is that if `npm_config_binroot` is set then "don't try to install executables into `/usr/local/bin`", because "the user probably set it up that way for a reason."

What npm guarantees about *where* side effects land: only that the package files go under `{prefix}/lib/node_modules` for global installs ([npm folders](https://docs.npmjs.com/cli/v10/configuring-npm/folders)). The script is an ordinary child process. The docs say that when npm runs as root, scripts run "with the effective uid and gid of the working directory owner" ([npm scripts](https://docs.npmjs.com/cli/v10/using-npm/scripts)), and nothing confines their filesystem writes.

`--ignore-scripts` (the `ignore-scripts` config, default `false`) makes npm skip scripts defined in `package.json` files ([npm config](https://docs.npmjs.com/cli/v10/using-npm/config)). It is a blunt tool: it turns off *all* hooks, including legitimate native-module builds.

**The npm 12 shift (check your version).** The npm CLI documentation for v11 now documents an `allow-scripts` config and a `strict-allow-scripts` config, and describes `allow-scripts` as "meant for one-off and global contexts such as `npm exec`, `npx`, and `npm install -g`" ([npm config, v11](https://docs.npmjs.com/cli/v11/using-npm/config)). Secondary reports say npm 12 (reported as released 8 July 2026) makes dependency install scripts opt-in via `allowScripts` ([InfoQ](https://www.infoq.com/news/2026/08/npm-12-released/); [DEV Community report](https://dev.to/mr_manushukla/npm-12-shipped-on-8-july-2026-with-install-scripts-off-by-default-the-ci-fix-5289)). I could not read InfoQ's full text. Neither those sources nor the docs I read say whether the *top-level* package of a global install is blocked by default. I tested this locally. On npm 11.19.1, `npm install -g` of a tiny package with a `postinstall` printed an `install-scripts` warning ("Run `npm install -g --allow-scripts=demo-agent` to allow these scripts once...") and **still ran the script**. So on that version it is warning-mode, not blocking. Whether npm 12 changes this for the top-level global package is unverified here. Either way, a design that relies on the package manager's policy to prevent a wrong-target write is relying on a control that its own users can switch off with one flag.

### pnpm

pnpm 10.0.0 made a breaking change, quoted from its release notes: "Lifecycle scripts of dependencies are not executed during installation by default!" Packages needing scripts are listed in `pnpm.onlyBuiltDependencies` ([pnpm v10.0.0 release](https://github.com/pnpm/pnpm/releases/tag/v10.0.0)). The current pnpm settings reference says `onlyBuiltDependencies` and related keys "have been removed in v11 and replaced by `allowBuilds`", with `strictDepBuilds` defaulting to `true` so installs exit non-zero when there are unreviewed build scripts ([pnpm build settings](https://pnpm.io/settings/build)). Note the scope: this governs *dependencies'* scripts. It is a supply-chain control, not a guarantee about what an allowed script does.

### Yarn Berry

Yarn's `enableScripts` is documented as "Define whether to run postinstall scripts or not." and says that when false, Yarn will not execute `postinstall` scripts "from third-party packages". Workspaces are exempt because they are treated as trusted ([Yarn config](https://yarnpkg.com/configuration/yarnrc)). Per-package control uses `dependenciesMeta`.

### Debian

Debian policy is the most mature statement of install-script discipline:

- "It is necessary for the error recovery procedures that the scripts be idempotent" ([Debian Policy ch. 6](https://www.debian.org/doc/debian-policy/ch-maintainerscripts.html)).
- Scripts "must be able to fall back to noninteractive behavior if no controlling terminal is available" (same chapter).
- `postinst` is called as `postinst configure <most-recently-configured-version>`, so the script knows which version it is upgrading from. "No attempt is made to unwind after errors during configuration" (same chapter).
- Config files must live in `/etc`, and maintainer scripts "must not overwrite or otherwise mangle the user's configuration without asking" and must not modify conffiles ([Debian Policy ch. 10](https://www.debian.org/doc/debian-policy/ch-files.html)). dpkg handles the upgrade by comparing with the shipped version and prompting when the admin has changed a conffile.

The relevant guarantee is the *convention*: package-owned files go in package-owned paths, and admin-owned state is never rewritten silently. Debian does not enforce this technically. Debian Policy as I read it does not say maintainer scripts must avoid users' home directories (I checked; it is not stated).

### RPM

The RPM scriptlet documentation specifies that scripts receive an instance count as `$1` ("1 on initial install, and 0 on final removal"; other values indicate upgrade), that "Scriptlets should be designed to always return with zero exit code" since RPM cannot roll back, and that "Scriptlets cannot be interactive, and should not rely on their output to be seen by users" ([RPM scriptlets](https://rpm-software-management.github.io/rpm/man/rpm-scriptlets.7)). It recommends keeping scriptlets to package-specific actions. The "should not rely on output being seen" line is the RPM-world version of the incident's "nothing logged where the operator would look".

### Homebrew

Homebrew's cookbook describes the install sandbox: write failures mean the formula "tried to write to the disk outside of your sandbox area. This is enforced on macOS by `sandbox-exec`" ([Formula Cookbook](https://docs.brew.sh/Formula-Cookbook)). The current cookbook says new formulae must declare post-install work with `post_install_steps`, which the cookbook describes as running under "the same post-install sandbox policy", with literal arguments only and a fixed vocabulary (`mkdir_p`, `write_file`, `symlink`, and so on). Targets other than the keg must be named explicitly through `base:` options such as `etc` or `var`; the legacy free-form `post_install` is described as deprecated and rejected by audits. Homebrew has, in effect, replaced "arbitrary code with an implicit target" with "declarative steps whose target is named in each step."

### Python

`python setup.py` as a command-line tool is deprecated, and setuptools' role is "reduced to the role of a build backend" ([Python Packaging: setup.py deprecated](https://packaging.python.org/en/latest/discussions/setup-py-deprecated/)). PEP 517 separates build frontends from backends and says frontends should create "an isolated environment for each build" ([PEP 517](https://peps.python.org/pep-0517/)). Wheels are installed in two notional phases, "Unpack" and "Spread", by unpacking into destinations defined by `sysconfig` ([wheel spec](https://packaging.python.org/en/latest/specifications/binary-distribution-format/)). My inference, not stated by the spec: installing a wheel does not need to execute package-supplied code at all, and that is the structural reason pip installs of wheels cannot do what a `postinstall` does.

### Nix

Nix's `sandbox` setting, when true, runs builds "isolated from the normal file system hierarchy", so that a build sees its Nix-store dependencies, a temporary build directory, and listed `sandbox-paths`. It defaults to true on Linux, false elsewhere ([Nix conf-file](https://nix.dev/manual/nix/stable/command-ref/conf-file.html)). A Nix build physically cannot write into `~/agent`. This is the strongest guarantee in the survey, and it is bought by giving up the ability to do the thing the postinstall was trying to do.

### Summary table

| Ecosystem | Install-time code? | Where may side effects land? | Enforcement |
|---|---|---|---|
| npm | yes (`postinstall`, also on `-g`) | anywhere the user can write | none beyond uid; policy opt-in/out flags |
| pnpm / Yarn | dependencies: off by default | same, if allowed | allowlist |
| Debian | maintainer scripts | convention: package paths, `/etc` conffiles | policy, review |
| RPM | scriptlets | convention | policy, no rollback |
| Homebrew | declarative post-install steps | named `base:` directories | sandbox + audit |
| pip (wheels) | none | `sysconfig` schemes | format |
| Nix | build only | `$out` in the store | OS sandbox |

## 3. The implicit-target failure class

### What it is

A script resolves *where to act* by a rule instead of by a statement from the caller. Common forms:

- `process.env.X || ~/default` (the incident).
- `os.homedir()`. Node documents that on POSIX it "uses the `$HOME` environment variable if defined," and only otherwise looks up the effective UID ([Node os.homedir](https://nodejs.org/api/os.html#oshomedir)). So "home" depends on the *environment of the process*, which npm inherited from the shell.
- The current working directory, or `INIT_CWD`. The npm docs say scripts run from the package folder, while `INIT_CWD` "holds the full path you were in when you ran `npm run`" ([npm scripts](https://docs.npmjs.com/cli/v10/using-npm/scripts)).
- "The only instance", discovered by globbing or by a well-known path.

### Why the default is right 99% of the time, and why that is the problem

On a single-instance machine the rule and the caller's intent coincide, so it works for years and nobody writes a test for the other case. The failure needs a second candidate to exist, and it is then silent because the script is doing precisely what it was written to do. The cost is asymmetric: saving the operator one env var in the common case, versus corrupting an instance in the rare one. This is an inference from the incident and from general reasoning, not a measured frequency, and the "99%" is rhetorical.

### Variants that make the guess worse

- **sudo / HOME confusion.** `sudo`'s default `env_reset` initialises `HOME` "based on the target user" ([sudoers manual](https://www.sudo.ws/docs/man/sudoers.man/)). But Ubuntu historically patched sudo to keep the caller's `HOME`, tracked in [Launchpad bug 1556302](https://blueprints.launchpad.net/bugs/1556302), and the behaviour can be changed with `env_keep` or `always_set_home`. I could not confirm from release notes exactly which Ubuntu release changed this default. The practical outcome is that `sudo npm install -g` may write into root's home or into the invoking user's home depending on distribution and configuration, which is exactly the sort of ambiguity an install hook must not resolve by guessing.
- **CI versus dev.** Containers often run as root with an unrelated `HOME`, or with no env vars set at all, so the "default" path is created fresh and the bug never shows. The same package on a multi-instance dev host hits a real instance.
- **Env var set in one shell, not another.** The incident exactly: the variable existed for running instances and was absent for the one-off install.
- **Empty or unset variables.** The best-known cautionary tale is not a packaging one but belongs to the same family. In January 2015 a user reported that Steam for Linux deleted everything owned by the user after he moved the Steam directory; commenters traced it to `rm -rf "$STEAMROOT/"*` in `steam.sh` with `STEAMROOT` apparently empty ([ValveSoftware/steam-for-linux#3671](https://github.com/ValveSoftware/steam-for-linux/issues/3671)). It was an unset-variable-selects-the-target bug. The mechanism (a computed or defaulted path nobody confirmed) is the same as the incident's, with a more destructive verb.

### The other reason install hooks are scrutinised

Install scripts are the preferred delivery vector in npm supply-chain attacks. The hijacked `ua-parser-js` releases (0.7.29, 0.8.0, 1.0.0, 22 October 2021) carried a `preinstall.js` that dropped a Monero miner and, on Windows, a password-stealing DLL ([CERT-EU advisory 2021-057](https://www.cert.europa.eu/publications/security-advisories/2021-057/)). The 2025 "Shai-Hulud" npm worm was widely reported to run its payload from a `postinstall` hook in its first wave (secondary coverage only; I did not reach the CISA text, see [Flashpoint's write-up](https://flashpoint.io/blog/shai-hulud-worm-targeting-npm-supply-chains/)). This is why ecosystems are turning scripts off by default (section 2). It also means that a legitimate package that relies on postinstall to deploy state is fighting the direction of travel: the more your users harden their installs, the more often your deploy step will silently not run, or run in an environment you did not expect.

## 4. Design patterns

### 4.1 Separate "install the code" from "deploy into an instance"

Make the postinstall do nothing to any instance. At most it should print a notice. Provide an explicit command, for example `agent upgrade --instance <path>`, that names its target. Compare Debian's split: the package manager unpacks files in package-owned locations, and the maintainer script is passed the previous version so it can reason about an upgrade. Homebrew's split is similar: the keg is separate from `etc`/`var` state. For an agent framework, "bundled skills inside the package" and "skills deployed into instance X" are two different artefacts with two different lifecycles.

```bash
# the install step
npm install -g agent-framework@2.4.0      # touches only the global prefix
# the deploy step, which names its target and has a plan phase
agent upgrade --instance ~/agents/b --plan   # prints what would change
agent upgrade --instance ~/agents/b --apply  # does it, with backup
```

### 4.2 Refuse to guess when more than one candidate exists

If the tool must infer a target, it should do so only when the inference is unambiguous: exactly one candidate, discovered from a registry or marker file, not from a bare default. With zero or several candidates, exit non-zero (for a CLI) or skip with a clear message (for a hook).

```js
function resolveTarget(env, home) {
  if (env.AGENT_DIR) return env.AGENT_DIR;               // explicit
  const found = discoverInstances(home);                 // dirs containing instance.json
  if (found.length === 1) return found[0];               // unambiguous
  throw new Error(found.length === 0
    ? 'No instance found; pass --instance or set AGENT_DIR.'
    : `Multiple instances found:\n  ${found.join('\n  ')}\nPass --instance explicitly.`);
}
```

In an install hook the equivalent of "throw" must not fail the install (a failing postinstall aborts npm's process, per [the npm docs](https://docs.npmjs.com/cli/v10/using-npm/scripts)): print the message and exit 0 without touching anything. A plain missing env var should mean "do nothing and say so", not "fall back to home".

### 4.3 Dry-run plus manifest diff

Ship a manifest of the package's deployable files (path, sha256, size). `--plan` computes the diff against the target: added, changed, removed, and *locally modified since last sync* (a file whose hash matches neither the old nor the new package version). This is the dpkg conffile idea applied to your own assets: the third state is what stops silent clobbering of operator edits ([Debian Policy ch. 10](https://www.debian.org/doc/debian-policy/ch-files.html)).

### 4.4 Backup and journal before mutating

Before writing, copy every file that will change into `<instance>/.backups/<timestamp>-<from>-to-<to>/` and write a journal line per file. If the backup cannot be made, do not proceed. RPM's own documentation concedes it "cannot undo or roll back a transaction" ([RPM scriptlets](https://rpm-software-management.github.io/rpm/man/rpm-scriptlets.7)), and Debian describes the "point of no return" in upgrades ([Debian Policy ch. 6](https://www.debian.org/doc/debian-policy/ch-maintainerscripts.html)); an application-level sync has neither safety net unless you build it.

### 4.5 Idempotent, version-stamped sync

Keep a marker in the *instance*, not just in the package, saying which package version last wrote which files:

```json
// <instance>/.deploy-state.json
{ "package": "agent-framework", "version": "2.4.0",
  "files": { "skills/web.md": { "sha256": "…", "from": "2.4.0" } },
  "schema": 7 }
```

Rules that follow: re-running the same version is a no-op (the Debian idempotency requirement); **skip, and warn, when the instance's recorded version is newer than or incompatible with the package** (downgrade or cross-line sync); and upgrade code and state together or not at all. In the incident, the files and the database/config diverged because the sync updated one half. A single `schema` stamp that the deploy step checks both before and after makes that detectable and, ideally, refused.

### 4.6 Opt-in beats opt-out

An env var such as `AGENT_SKIP_POSTINSTALL=1` lets careful users protect themselves, but the people who are hurt are the ones who did not know to set it. A control that must be remembered fails at the moment attention is elsewhere. This is the same reasoning behind pnpm and npm moving dependency scripts from opt-out to opt-in (section 2). Opt-out flags remain useful for CI and for people running several instances, as a belt-and-braces layer, but the default behaviour must already be safe.

### 4.7 Print exactly what changed, somewhere durable

Write the plan and result to stdout *and* to a log file inside the instance. Be aware that npm runs `prepare` in the background and hides output unless `--foreground-scripts` is set ([npm scripts](https://docs.npmjs.com/cli/v10/using-npm/scripts)); npm's `foreground-scripts` config shares stdio with npm ([npm install](https://docs.npmjs.com/cli/v11/commands/npm-install)). Package-manager output is easy to lose, which is exactly why the durable log inside the target matters. RPM's guidance that scripts "should not rely on their output to be seen by users" generalises here.

## 5. How to test for it

The test is a negative control: prove that an install with no target specified touches nothing that looks like an instance.

```bash
#!/usr/bin/env bash
set -euo pipefail
SB=$(mktemp -d)
mkdir -p "$SB/home/agent/skills" "$SB/prefix"
echo "v1" > "$SB/home/agent/skills/a.md"      # decoy default instance
echo "{}" > "$SB/home/agent/config.json"

fp() { ( cd "$1" && find . -type f -print0 | sort -z \
        | xargs -0 sha256sum | sha256sum ); }  # add `stat -c %Y` for mtimes if you care
BEFORE=$(fp "$SB/home/agent")

# env -u removes any ambient target var; HOME points at the sandbox
HOME="$SB/home" env -u AGENT_DIR \
  npm install -g --prefix "$SB/prefix" ./agent-framework-*.tgz

AFTER=$(fp "$SB/home/agent")
[ "$BEFORE" = "$AFTER" ] || { echo "FAIL: install mutated default instance"; exit 1; }
echo "PASS"
```

I ran a reduced version of this against a naive `postinstall` of the same shape as the incident (on Node 24.22.1 / npm 11.19.1). The decoy file changed from `v1` to `v2` and the harness reported `MUTATED`, which confirms the negative control can fail. A harness that has never been seen to fail proves nothing, so keep a deliberately naive fixture package in your test suite.

Extensions worth adding:

- **Positive control.** The same install with the target explicitly given must deploy correctly, so the test cannot pass by the hook doing nothing at all.
- **Several decoys.** Create two or three plausible instances and assert that the tool refuses and names all of them.
- **sudo / HOME variants.** Run once with `HOME` unset and once as root in a container. Do not assume the sudo behaviour; test it on your CI image.
- **Downgrade test.** Install an older package over a newer instance; assert skip plus warning.
- **Snapshot more than files.** Also fingerprint the database and config, since the incident's damage was a cross-artefact skew. A `schema` stamp check is a cheap invariant.
- **Run with and without `--ignore-scripts`.** The deploy command must work in both, since users who harden installs will hit the second path.

## 6. Checklist for agent-framework maintainers

1. The `postinstall` (and `preinstall`, `prepare`) hook never writes to any instance directory. Compile-only, or print a notice.
2. A named `init` / `upgrade` command takes `--instance` (or equivalent) and has no hidden default that falls back to `$HOME`.
3. If a target is inferred, it is inferred only when exactly one candidate exists; zero or many means refuse and list candidates.
4. `--plan` / `--dry-run` shows adds, changes, removals and locally modified files, driven by a shipped manifest with hashes.
5. A backup is written before any mutation; failure to back up aborts.
6. Each instance has a deploy-state marker (package version, per-file origin, schema version). Same version is a no-op; newer-than-package or schema mismatch is a refusal.
7. Code assets and state migrations are applied together or not at all, and the marker is updated last.
8. Results are logged to stdout and to a log file inside the instance, with the target path as the first line.
9. The tool works with `--ignore-scripts` and under pnpm / npm policies that skip scripts. Do not make correctness depend on the hook running.
10. An opt-out env var may exist for CI, but safety must not depend on it.
11. CI includes the decoy-instance negative control, its positive control and a deliberately naive fixture that proves the harness can fail.
12. Operators' runbooks say: install ≠ deploy; after installing, run `plan` against the intended instance.

## 7. Caveats and what I could not verify

- The incident reconstruction (code shape, the env-var default) is taken from the brief given to me, not from source I read. Snippets labelled "illustrative" are mine.
- npm 12's exact behaviour for top-level global installs is unverified; secondary sources say dependency scripts are opt-in, my local npm 11.19.1 warns but still runs a global package's postinstall.
- Shai-Hulud details and the date of the Ubuntu `HOME` default change come from secondary sources and are flagged where used.
- The Fedora packaging guidelines and Debian Policy sections on user home directories did not yield statements I could quote, so I make no claim about them.
- Homebrew's documentation appears to have changed recently (declarative `post_install_steps`); older descriptions of `post_install` in blog posts may no longer match.

## References

- npm scripts (lifecycle, global installs, root behaviour): https://docs.npmjs.com/cli/v10/using-npm/scripts
- npm config (`ignore-scripts`, `prefix`, `global`): https://docs.npmjs.com/cli/v10/using-npm/config
- npm config, v11 (`allow-scripts`, `strict-allow-scripts`): https://docs.npmjs.com/cli/v11/using-npm/config
- npm install, v11: https://docs.npmjs.com/cli/v11/commands/npm-install
- npm folders: https://docs.npmjs.com/cli/v10/configuring-npm/folders
- npm 12 coverage (secondary): https://www.infoq.com/news/2026/08/npm-12-released/ and https://dev.to/mr_manushukla/npm-12-shipped-on-8-july-2026-with-install-scripts-off-by-default-the-ci-fix-5289
- pnpm v10.0.0 release notes: https://github.com/pnpm/pnpm/releases/tag/v10.0.0
- pnpm build settings: https://pnpm.io/settings/build
- Yarn `enableScripts`: https://yarnpkg.com/configuration/yarnrc
- Debian Policy, maintainer scripts: https://www.debian.org/doc/debian-policy/ch-maintainerscripts.html
- Debian Policy, files and conffiles: https://www.debian.org/doc/debian-policy/ch-files.html
- RPM scriptlets: https://rpm-software-management.github.io/rpm/man/rpm-scriptlets.7
- Homebrew Formula Cookbook: https://docs.brew.sh/Formula-Cookbook
- Python Packaging, setup.py deprecated: https://packaging.python.org/en/latest/discussions/setup-py-deprecated/
- PEP 517: https://peps.python.org/pep-0517/
- Wheel binary distribution format: https://packaging.python.org/en/latest/specifications/binary-distribution-format/
- Nix configuration, `sandbox`: https://nix.dev/manual/nix/stable/command-ref/conf-file.html
- Node.js `os.homedir()`: https://nodejs.org/api/os.html#oshomedir
- sudoers manual: https://www.sudo.ws/docs/man/sudoers.man/
- Ubuntu sudo HOME bug: https://blueprints.launchpad.net/bugs/1556302
- Steam `rm -rf "$STEAMROOT/"*` issue: https://github.com/ValveSoftware/steam-for-linux/issues/3671
- CERT-EU advisory on ua-parser-js: https://www.cert.europa.eu/publications/security-advisories/2021-057/
- Shai-Hulud write-up (secondary): https://flashpoint.io/blog/shai-hulud-worm-targeting-npm-supply-chains/
