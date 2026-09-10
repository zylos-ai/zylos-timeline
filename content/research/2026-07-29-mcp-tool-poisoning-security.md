---
date: "2026-07-29"
title: "MCP Tool Poisoning: How the Protocol Connecting Agents to Tools Became AI's Newest Supply Chain"
description: "A deep look at tool poisoning attacks, line jumping, rug pulls, and confused-deputy exploits in the Model Context Protocol — the 2025-2026 incident timeline, how natural-language tool descriptions extend the software supply-chain attack surface, and the boundaries of proposed defenses such as planner/executor separation, information-flow policies, and signed manifests."
tags:
  - ai-agents
  - mcp
  - security
  - prompt-injection
  - supply-chain
  - tool-calling
  - agent-architecture
---

## Executive Summary

MCP connects agents to tools, but the security boundary extends beyond the code implementing each
connector. Tool descriptions and returned documents can influence a model that also has permission
to read private data or perform external actions. Valid JSON does not establish that the prose inside
it is safe to treat as instructions.

The research separates into several mechanisms: **tool poisoning** embeds instructions in metadata;
**line jumping / tool shadowing** influences use of another tool without invoking the malicious one;
**rug pulls** change something after approval; and **indirect injection** arrives through legitimate
tool output. OAuth proxy mistakes, unsafe command construction, and compromised packages add
conventional software vulnerabilities to these model-mediated risks.

The cases below are selected disclosures available by July 2026, not a census of compromised MCP
deployments. Their evidence ranges from controlled demonstrations to malicious packages found in
registries. Likewise, repository scans, installation-command detections, registry submission tests,
and verified exposed credentials measure different things; they cannot be combined into a single
"percentage of vulnerable MCP servers."

The practical response is layered: inspect what reaches the model, restrict what actions and data
flows can follow, reapprove changes to the exact artifacts being trusted, and fix ordinary software
security bugs. Signed metadata helps detect metadata changes; it cannot reveal a remote implementation
change when the signed bytes remain identical. Planner/executor separation is promising research,
with policy and utility limitations, rather than a universal deployed solution.

## What Tool Poisoning Attacks Actually Look Like

[Invariant Labs' April 1, 2025 disclosure](https://invariantlabs.ai/blog/mcp-security-notification)
demonstrated a calculator tool whose description instructed Cursor to read local configuration and
SSH-key files and pass the contents through an extra argument. The addition still worked. The
security failure lay in the surrounding actions and the mismatch between the tool-call information
presented to the user and the information influencing the model.

This is a result for the demonstrated client and setup, not a requirement that every MCP client hide
descriptions or expose every tool at once. A client can filter tools, inspect metadata, or apply
additional authorization. The relevant question is what attacker-controlled text actually reaches
the decision-making model and which consequential actions remain available afterward.

The same report demonstrated **shadowing**: a malicious tool description altered how the agent used
a separate trusted email tool. The attacker did not need execution of its own tool. A per-call
approval gate on that malicious tool therefore would not, by itself, address the earlier exposure of
its description.

[Invariant's WhatsApp demonstration](https://invariantlabs.ai/blog/whatsapp-mcp-exploited), published
April 7 and expanded April 9, used a third-party WhatsApp connector alongside a malicious sleeper
server. After initially advertising benign metadata, the sleeper changed its description to redirect
messages and include chat history already in context. The trusted connector performed the sending;
the malicious server did not need a tool call. This was not a compromise of WhatsApp encryption:
the agent was misusing its authorized access before encryption protected the outbound message.

A second experiment injected instructions through a received WhatsApp message, causing contact-list
exfiltration when the agent processed it. That variant required the agent to encounter the crafted
message and have the necessary read/send capabilities, but did not require installation of a malicious
MCP server. Metadata poisoning and tool-output injection thus cross different entry boundaries even
when they aim at the same unauthorized disclosure.

## Line Jumping and Tool Shadowing: Attacks Before Invocation

[Trail of Bits' April 21, 2025 research](https://blog.trailofbits.com/2025/04/21/jumping-the-line-how-mcp-servers-can-attack-you-before-you-ever-use-them/)
showed tool descriptions influencing models before the described tool was called. Its payload
invented operating-system and compliance requirements to induce unsafe permission changes through
other tools. Tested applications included Claude Desktop.

The timing distinction matters: discovery can expose instructions before an invocation gate has
anything to approve. MCP defines `tools/list` for discovery, but the
[June 18, 2025 tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
does not prescribe one universal interface or require every connected server's description to be
concatenated immediately into a shared model context. The findings apply when a host loads the
malicious metadata into a model that can influence other actions.

Process isolation and model-context isolation are different controls. OS sandboxes can limit a
server’s filesystem access while its description still influences a shared model. Conversely,
a host can limit which descriptions it exposes. Evaluating a client requires checking both boundaries
in the actual version and configuration; "connected" alone is not proof of compromise.

## Rug Pulls: When Trust Is Bound to the Wrong Thing

A rug pull changes a previously approved dependency: its description, local launch configuration,
package artifact, or remote backend. These changes need different evidence and controls.

[Check Point's MCPoison disclosure](https://research.checkpoint.com/2025/cursor-vulnerability-mcpoison/)
(CVE-2025-54136, August 2025) concerned **local Cursor MCP configuration**. In the vulnerable behavior,
approval was remembered under an MCP entry's name; later changes to its command or arguments could
execute without a new prompt. The demonstrated attack began with approval of a benign entry and then
modified the project configuration. Check Point reports that Cursor fixed it in version 1.3.

The WhatsApp sleeper case instead changed descriptions supplied by a server. Comparing newly received
metadata with an approved snapshot can detect that change. Neither example establishes that clients
can measure arbitrary remote implementation code.

Consider a remote service whose description and schema remain byte-identical while its implementation
adds an unauthorized data copy. A metadata hash remains unchanged, and a signature over that metadata
still verifies. Pinning a local package or container digest covers those artifact bytes; attesting
which code a remote service actually runs requires a separate mechanism. Even a correctly signed
artifact can be malicious if the trusted publisher signs malicious content.

## Indirect Injection via Tool Output

[Invariant's May 26, 2025 GitHub demonstration](https://invariantlabs.ai/blog/mcp-github-vulnerability)
used a public issue containing instructions that induced an agent to read private repositories and
publish their content in a public pull request. The setup combined attacker-writable issue text with
an account integration able to access both public and private repositories. This was a controlled
demonstration using demo repositories, not evidence of a breach of every GitHub MCP deployment.

The dangerous composition is private-data access, untrusted content, and an external write channel
within one workflow. Task-scoped credentials, repository restrictions, output checks, and approval of
consequential writes can reduce that exposure. Separate sessions can also help when their credentials
and available data genuinely differ; merely opening a second chat is not an access-control boundary.

This yields a useful failure trace: the fetched issue is data; the model interprets part of it as a
new instruction; a private read succeeds under existing credentials; then a public write discloses
the result. Controls should identify which transition they actually prevent. Fixing a JSON parser
alone does not prevent a well-formed issue body from containing manipulative prose.

## Confused Deputy and Token Passthrough

The [MCP security guidance](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices)
describes a different class of failure in OAuth proxies. A proxy may use one static client identity
with a third-party authorization server while supporting multiple dynamically registered MCP clients.
If prior third-party consent is reused without checking consent for the requesting MCP client, an
attacker can exploit that mismatch to obtain an authorization code through an attacker-controlled
registered redirect.

The guidance calls for per-user, per-client consent checks before starting the upstream authorization
flow, exact redirect-URI validation, and protected state/consent handling. Cookie-backed consent needs
client binding and integrity protection; server-side sessions are an alternative to signed cookie
contents. These are authorization controls outside the model.

**Token passthrough** is separately prohibited: an MCP server must not accept tokens that were not
issued for it and simply relay them downstream. Audience validation and appropriately scoped upstream
credentials preserve distinct service boundaries. A cross-tenant access-control bug is not, without
additional evidence, proof of token passthrough or of the proxy-consent attack described above.

## Selected 2025–2026 Disclosures

Dates below identify public disclosures or advisories, except where the row explicitly supplies the
earlier remediation date. A reported proof of concept, a package discovery, and a confirmed production
breach are different evidence categories.

| Disclosure | Case and primary source | Mechanism and scope |
|---|---|---|
| Apr 2025 | [WhatsApp demonstration](https://invariantlabs.ai/blog/whatsapp-mcp-exploited) | Controlled metadata-shadowing and received-message injection experiments; authorized messaging tools became the disclosure channel. |
| May 2025 | [GitHub demonstration](https://invariantlabs.ai/blog/mcp-github-vulnerability) | Public issue injection caused a private-read/public-write sequence in the researchers' demo setup. |
| Jun 2025 | [MCP Inspector, CVE-2025-49596](https://github.com/modelcontextprotocol/inspector/security/advisories/GHSA-7f8r-222p-6f5g) | Missing authentication between Inspector client and proxy allowed unauthorized stdio command launches. Versions below 0.14.1 affected; fixed in 0.14.1. |
| Jul 2025 | [mcp-remote, CVE-2025-6514](https://jfrog.com/blog/2025-6514-critical-mcp-remote-rce-vulnerability/) | Crafted OAuth authorization-endpoint URL reached unsafe OS handling. Versions 0.0.5–0.1.15 affected; fixed in 0.1.16. JFrog demonstrated arbitrary commands on Windows and executable launch with limited parameter control on macOS/Linux. Download counts are not victim counts. |
| Jul 2025 | Filesystem server [CVE-2025-53109](https://github.com/modelcontextprotocol/servers/security/advisories/GHSA-q66q-fx2p-7w4m) and [CVE-2025-53110](https://github.com/modelcontextprotocol/servers/security/advisories/GHSA-hc55-p739-j48w) | Symlink-handling and path-prefix validation bypasses could permit access outside intended directories. These are server path-enforcement bugs, not proof that all MCP clients lack OS sandboxes. |
| Aug 2025 | [Cursor MCPoison, CVE-2025-54136](https://research.checkpoint.com/2025/cursor-vulnerability-mcpoison/) | Previously approved local MCP entry could change command/arguments without reapproval; fixed in Cursor 1.3. |
| Sep 2025 | [Flowise, CVE-2025-59528](https://github.com/FlowiseAI/Flowise/security/advisories/GHSA-3gcm-f6qx-ff7p) | `mcpServerConfig` passed through `convertToValidJSONString` into the JavaScript `Function` constructor, enabling execution with Node.js privileges. Advisory lists 3.0.5 affected and 3.0.6 patched; its example uses an API token. This is unsafe evaluation during parsing, not ordinary stdio process spawning. |
| Sep 2025 | [Malicious Postmark impersonator](https://postmarkapp.com/blog/information-regarding-malicious-postmark-mcp-package) | Postmark confirmed that an unofficial impersonating npm package added a hidden BCC in version 1.0.16 to copy emails externally; it was not an authorized Postmark release. |
| Sep 2025 | [Framelink/Figma-Context-MCP, CVE-2025-53967](https://github.com/GLips/Figma-Context-MCP/security/advisories/GHSA-gxw4-4fc5-9gr5) | Untrusted parameters entered `child_process.exec` shell strings. Fixed in 0.6.3; this advisory concerns `figma-developer-mcp`, not Figma's own server. |
| Oct 2025 (fixed Jun 2025) | [Smithery hosting research](https://blog.gitguardian.com/breaking-mcp-server-hosting/) | GitGuardian used build-path traversal to recover a Fly.io token from Docker configuration and demonstrate hosted-server control. The researchers identified potential reach across 3,000+ hosted servers, not 3,000 proven victims. Smithery completed the fix on June 15. |
| Jan 2026 | [gemini-mcp-tool, CVE-2026-0755](https://www.zerodayinitiative.com/advisories/ZDI-26-021/) | ZDI reported unvalidated input to `execAsync` permitting command execution in the service-account context without authentication. This is the named third-party tool, not a claim about every Gemini integration. |
| Feb 2026 | [Trojanized Oura MCP clone](https://www.straiker.ai/blog/smartloader-clones-oura-ring-mcp-to-deploy-supply-chain-attack) | Straiker found a malicious clone distributed with fabricated GitHub credibility and delivering StealC; this was an impersonating package campaign, not a vulnerability in Oura's API. |
| Mar 2026 | [nginx-ui, CVE-2026-33032](https://github.com/0xJacky/nginx-ui/security/advisories/GHSA-h6c2-x2m2-mwhf) | `/mcp_message` omitted authentication; an empty IP allowlist allowed all addresses. The advisory demonstrated unauthenticated access to nginx-management tools. Network exposure and deployment configuration determine reachability. |
| Apr 2026 | [OX Security's configuration/stdio research](https://www.ox.security/blog/the-mother-of-all-ai-supply-chains-critical-systemic-vulnerability-at-the-core-of-the-mcp/) | OX reported paths from attacker-influenced configuration to process execution across several integrations, plus separate marketplace tests. Authentication and injection prerequisites differed by product; these are not one universal unauthenticated stdio exploit. |

The OX report says Anthropic regarded the underlying launch behavior as expected. That is the
researcher's account of the vendor response. The boundary to examine is who can supply or alter launch
configuration and what authority the process receives. Legitimately launching a locally approved MCP
server and letting an untrusted remote request choose arbitrary commands are materially different
operations. Neither the transport name nor a large download count establishes exploitability.

## What the Ecosystem Measurements Actually Measure

Several studies show reasons to scrutinize dependencies, but their units must remain separate:

- **Repository analysis:** [Endor Labs' 2025 report summary](https://www.endorlabs.com/lp/state-of-dependency-management-2025)
  describes analysis of 10,663 GitHub repositories implementing MCP servers and reports that 82% of
  servers use sensitive APIs requiring security controls. Sensitive API use is a risk indicator, not
  a demonstrated path-traversal exploit rate. The public summary does not supply the full subgroup
  methodology, so this figure should not be restated as a rate of exploitable live deployments.
- **Definition scanning:** [Aguara's author report](https://dev.to/0x711/mcp-has-a-supply-chain-problem-1nb8),
  posted February 27, 2026 and edited March 3, describes a registry corpus of over 42,000 tools. It
  reports 1,679 tool definitions containing `pip install` and 742 containing system package-manager
  commands. These are detected instruction/configuration patterns, not verified malicious executions;
  the categories may overlap and should not be summed into a count of compromised servers.
- **Registry submission tests:** [OX Security](https://www.ox.security/blog/the-mother-of-all-ai-supply-chains-critical-systemic-vulnerability-at-the-core-of-the-mcp/)
  reports that malicious trial submissions were accepted by 9 of 11 tested registries. That is a result
  for its submission experiment, not a random-sample estimate of package safety or a count of infected
  users.
- **Public secret exposure:** [GitGuardian's March 17, 2026 report announcement](https://blog.gitguardian.com/the-state-of-secrets-sprawl-2026/)
  reports 24,008 unique secrets in MCP-related configuration files on public GitHub, including 2,117
  unique credentials confirmed valid. Validity is at the time of testing, not a claim that they remain
  usable today. These are credentials, not distinct vulnerable servers.

These studies support dependency review, credential hygiene, and runtime controls. They do not establish
a single global vulnerability percentage. A package-name search also does not automatically enumerate
all MCP implementations or prove that every matching package is an MCP server.

## Why Existing Supply-Chain Controls Still Matter

MCP adds natural-language influence to familiar software risks; it does not replace code as an attack
surface. Dependency pinning, artifact review, SAST, secret scanning, restricted process privileges,
and safe argument handling still address the package and implementation failures in the timeline.

The additional problem is intent: a JSON schema can validate a description's type and structure
without determining whether the text tries to redirect the agent. Text scanners can detect patterns,
but passing a scanner is not proof that a model will use the content safely. Conversely, natural
language in context is not literally executable machine code; an attack still depends on the model's
response and the tools, permissions, and approval checks available to it.

A useful review therefore follows two paths: what software or commands will execute, and what text
will influence the component choosing the next action. A sandbox constrains process effects; a data-flow
policy constrains which information may reach which destination. Neither substitutes for the other.

## Defenses: Available Controls and Research Proposals

**Treat annotations as hints.** The
[2025-06-18 tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
says tool annotations from untrusted servers must be treated as untrusted. A self-declared
`readOnlyHint` cannot establish that an implementation is harmless. Approval policy needs an
independent basis for trusting the server and the requested operation.

**Define what a signature covers.**
[ETDI, the Enhanced Tool Definition Interface](https://arxiv.org/html/2506.01333v1), is a research
proposal combining signed/versioned definitions, declared permissions, OAuth, and policy enforcement.
It calls for new signed versions when definitions change. That verifies the signed declaration, not
arbitrary remote execution. A backend API-contract hash detects contract-byte changes, not an
implementation backdoor behind an unchanged contract. The proposal depends on components faithfully
enforcing its checks. It should not be described as a shipped MCP-wide guarantee.

**Put enforcement at the action boundary.** An operator can use a gateway or host policy to constrain
allowed tools, destinations, credential scopes, and high-impact writes, and to log the resulting
calls. This is an architectural recommendation, not a claim that every product marketed as an MCP
gateway offers equivalent enforcement. Inspect actual arguments and outcomes; an innocuous tool name
or a trusted publisher does not establish that each call is authorized.

**Preserve human-review information.** Show consequential destinations and data movement, and reapprove
changes to local launch configuration or metadata when those are the approved objects. Review should
happen before those changed objects acquire authority. An approval screen that hides the relevant
arguments cannot support a meaningful decision.

## Architectural Patterns: Planner/Executor Separation and Information Flow

Google/DeepMind and ETH researchers' [CaMeL paper, March 2025](https://arxiv.org/html/2503.18813v1)
separates a privileged planner from a quarantined model that parses untrusted content without tool
access. A custom interpreter executes the plan and propagates metadata describing provenance and
allowed readers. Explicit security policies decide whether tool calls and data flows are permitted.

The abstract's **67% is the share of AgentDojo tasks solved with security guarantees**, not the share
of attacks blocked. Utility and security are evaluated separately. Policies are configurable: a flow
may be permitted because recipients already have access, or because a trusted source authorizes it.
The design is not a universal rule requiring every untrusted-derived argument to pass a sanitizer.

Separating the models alone is insufficient: the quarantined model can still return an attacker-chosen
recipient as data. The interpreter's policy must prevent sensitive content from flowing there. The
paper also identifies limitations, including side channels, utility loss, and out-of-scope misleading
text that does not violate protected flows. Its guarantees depend on its threat model, trusted
components, and correctly specified policies; it is not proof of safety for arbitrary MCP software.

## What This Means for Dynamically Loaded Skills and Tools

The same questions apply to plugin or skill systems that load instructions from outside the core
agent. Our recommendations follow from the boundaries above:

- **Review descriptions as behavior-influencing input.** Inspect the actual material shown to the
  model, including changed metadata. Do not assume a friendly display name describes the whole input.
- **Constrain cross-tool effects.** A description for one tool should not grant permission to change
  another tool's recipients, filesystem scope, or output destinations. Enforce consequential limits
  outside the model where possible.
- **Bind approval to a specified object.** Recheck local command/arguments, metadata, and executable
  artifacts as distinct objects. Metadata-only checks cannot detect unchanged-schema backend changes;
  signatures also do not establish the publisher's benign intent.
- **Scope credentials and data to the task.** A public-issue workflow should not inherit unrelated
  private-repository access merely because one account can access both. Session separation helps only
  if it changes the actual authority or information available.
- **Test the complete disclosure path.** Check discovery, model exposure, private reads, argument
  policy, and external writes in the deployed client. A blocked malicious-tool invocation does not
  prove that its description never influenced a trusted tool.

The cited disclosures provide concrete failure mechanisms. They support these layered controls while
leaving the effectiveness of any particular client, gateway, or deployment to version-specific
verification.
