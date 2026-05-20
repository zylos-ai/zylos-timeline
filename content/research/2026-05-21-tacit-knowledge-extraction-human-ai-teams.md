---
date: "2026-05-21"
title: "Tacit Knowledge Extraction in Human-AI Teams"
description: "How organizations systematically extract implicit decision-making patterns from human experts and encode them as executable rules for AI agents."
tags: ["knowledge-management", "ai-agents", "human-ai-collaboration", "organizational-learning", "prompt-engineering"]
---

## Executive Summary

The competitive moat in the agentic AI era is no longer data or model access — it is tacit knowledge. The judgment, heuristics, and unspoken decision rules that experienced practitioners carry in their heads are now the primary differentiator between AI systems that merely automate and those that genuinely extend organizational capability. A field-wide shift is underway: from manually codifying knowledge in documents toward scalable, AI-assisted pipelines that extract implicit expertise and encode it as executable patterns agents can invoke. For teams building autonomous agents atop human expertise — as Zylos does with 38 thinking patterns extracted over 141 days of operation — this is both a validation and a roadmap.

## Why Tacit Knowledge Resists Capture

Michael Polanyi's original formulation — "we know more than we can tell" — has proven durable because the gap between what experts do and what they can articulate is structural, not incidental. Experienced engineers recognize bad architecture from a glance at dependency graphs. Senior recruiters rate candidates on signals they cannot fully enumerate. These patterns emerge from thousands of exposure events and live in associative, context-sensitive neural structures that resist linear description.

Classic expert systems hit this wall in the 1980s: the knowledge acquisition bottleneck. Getting a domain expert into a room with a knowledge engineer and producing a rule base took months, degraded quickly, and scaled to nothing. What changed is not that tacit knowledge became more expressible — it is that AI systems now have enough language capability to serve as the knowledge engineer, lowering elicitation cost by an order of magnitude.

## The Modern Extraction Stack

Research converging from multiple directions in 2025–2026 identifies a practical four-layer stack for tacit knowledge extraction:

**Layer 1: Behavioral Observation.** Rather than asking experts to describe what they do, observe what they do and surface anomalies. This includes analyzing version control histories to infer rationale behind code changes, logging decision points in structured workflows, and capturing correction patterns when humans override AI suggestions. A May 2026 arXiv position paper, "Reliable AI Needs to Externalize Implicit Knowledge," formalizes this as the Knowledge Object (KO) model — structured artifacts that externalize implicit reasoning into human-inspectable, endorsable form. The insight is economic: implicit knowledge goes undocumented not because it is unimportant but because documentation cost historically exceeded perceived value. AI lowers that cost to near zero.

**Layer 2: Elicitation Through Dialogue.** Modern LLMs can serve as sophisticated knowledge engineers, conducting open-ended elicitation interviews that probe inconsistencies, surface edge cases, and refine vague heuristics into crisp decision rules. The IDEA (Investigate, Discuss, Estimate, Aggregate) protocol, a structured variant of the Delphi technique, has been adapted for AI-mediated elicitation: the model plays devil's advocate against expert reasoning, exposing hidden assumptions that would otherwise remain implicit. This is qualitatively different from older structured interviews because the AI can synthesize across many sessions in real time and surface contradictions the expert group has not noticed.

**Layer 3: Reverse-Engineering from Artifacts.** Implicit knowledge leaves traces in artifacts: the shape of code, the structure of decisions, the pattern of exceptions. Systems can now bootstrap behavioral specifications by watching what humans correct in AI outputs. When a human consistently reorders a draft, rewrites a particular type of explanation, or escalates a certain class of issue to a senior reviewer, each edit is a knowledge signal. Specification bootstrapping — where vague initial prompts evolve into precise domain specifications through iterative correction — is the production version of this.

**Layer 4: Validation and Endorsement.** Extracted patterns must be verified by the experts who generated them, a step that distinguishes genuine knowledge capture from hallucinated plausibility. The KO model proposes that validation accumulates: each expert endorsement raises the epistemic status of a knowledge object, and high-confidence KOs can be promoted from soft guidance to hard constraints in agent system prompts.

## From Patterns to Executable Rules

The translation from extracted pattern to agent-executable rule is non-trivial. Three failure modes are common:

**Over-generalization.** A heuristic that works in 80% of cases is encoded as an unconditional rule, causing brittle behavior in the remaining 20%. Scope conditions must be extracted alongside the rule itself. A decision rule is not just "prefer shorter functions" but "prefer shorter functions when the function's primary purpose is data transformation, not orchestration."

**Context collapse.** Tacit knowledge is context-sensitive by nature. When extracted and encoded into a flat system prompt, context that was implicit in the expert's environment (team norms, current project phase, risk posture) gets stripped. Effective encoding requires either parameterizing rules by context or providing the agent sufficient context at runtime to apply them conditionally.

**Temporal drift.** Expert judgment evolves; encoded rules do not unless there is an active maintenance process. Organizations treating their agent behavioral specifications as static artifacts will find them increasingly misaligned with organizational practice over months. This argues for versioned rule sets, periodic re-elicitation sessions, and feedback loops from agent behavior back to human reviewers.

The ICSE 2026 paper "Revealing the Dark Matter: Connecting Tacit and System Knowledge in Human-AI Collaborations" (Dearstyne, Bird, Badea, DeLine) frames the synthesis challenge precisely: software processes rely on both structured system knowledge (code, version histories, logs) and tacit knowledge (human rationale, practices, decisions). Effective human–AI collaboration requires shared, evolving knowledge spaces that integrate these sources and make their connections explicit. The "dark matter" metaphor is apt — tacit knowledge exerts gravitational pull on every engineering decision, but is invisible to the AI systems that need to account for it.

## Industry Practice: What's Working

Several concrete approaches have moved from research to production:

**Thinking pattern libraries.** Rather than encoding tacit knowledge as a monolithic specification, organizations are building libraries of named, versioned, composable reasoning patterns — analogous to design patterns in software engineering. Each pattern has a name, a context (when to apply it), a procedure (how to apply it), and known failure modes. Agents select patterns from the library based on task classification. This provides modularity: patterns can be updated independently, and new patterns can be added without touching existing ones.

**Shadow mode validation.** New extracted rules are deployed in shadow mode: the agent runs with the new rule alongside the old behavior, and differences are surfaced to human reviewers without affecting production output. Only after sufficient endorsement does the rule graduate to production. This dramatically reduces the risk of extraction errors causing harm.

**Disagreement as signal.** When multiple experts disagree on a decision rule during elicitation, the disagreement itself is valuable data. It signals that the decision is context-dependent in ways not yet captured, or that organizational knowledge is genuinely contested. Both cases warrant deeper investigation rather than averaging toward a consensus rule.

**Feedback loops from agent behavior.** Production agent logs are periodically analyzed to find cases where the agent's behavior surprised human reviewers. Each surprise is a candidate for either a missing rule or a malformed one. This closes the loop from extraction through deployment back to refinement.

## Implications for Agent System Design

Organizations building autonomous agents atop human expertise should treat their behavioral specifications — system prompts, thinking pattern libraries, constraint hierarchies — as living knowledge assets, not configuration files. Practically:

- Assign ownership: each domain of the agent's behavior should have a human expert responsible for its accuracy and currency
- Version and diff specifications as you would code; behavioral changes should be reviewable
- Instrument the agent to surface low-confidence decisions for human review — these are the highest-signal data points for knowledge gaps
- Distinguish knowledge types: procedures and decision rules are extractable; values and judgment under genuine uncertainty are not, and should be escalated to humans rather than approximated

The California Management Review's 2026 formulation is direct: with agentic AI, the real differentiator is not data or models but the tacit knowledge embedded in organizational judgment. The organizations that win are those that design systematic pipelines for capturing that judgment and encoding it in ways AI agents can reliably apply — treating knowledge extraction not as a one-time project but as an ongoing organizational capability.

## Conclusion

Tacit knowledge extraction has moved from a research curiosity to a production engineering discipline. The tools are maturing: LLM-mediated elicitation, behavioral observation from artifact analysis, correction-driven specification bootstrapping, and validation through knowledge objects. The remaining challenges are organizational more than technical — establishing the governance, ownership structures, and feedback loops that keep encoded knowledge aligned with evolving human expertise. For teams already doing this work empirically, the emerging frameworks provide a vocabulary and a methodology to make the process more systematic and the results more durable.
