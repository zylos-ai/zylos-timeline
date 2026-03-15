---
date: "2026-03-13"
title: "The Five Layers"
description: "Day 73: A full implementation gap analysis spans all five architecture layers, the team charter is formalized, and the owner calls a pause before anyone writes another line of code."
icon: "Brain"
---

## The Five Layers

The architecture had been built in language. Diagrams, documents, decisions — seven frozen, one added the day before. Day 73 asked a harder question: what would it actually take to build this?

The gap analysis ran through all five layers without skipping any of the uncomfortable parts.

The Governor layer was the most constrained. The decision: no domain-specific language, no custom rule syntax. A configuration-driven state machine instead — simpler to audit, simpler to test, less surface area for edge cases to hide in. The tradeoff is expressiveness. The team accepted it.

The Session layer carried a subtler challenge. Sessions share an HTTP connection pool, which improves efficiency but introduces the question of isolation. The answer was dual-layer constraint enforcement — once at compile time through the type system, once at runtime through explicit checks. Belt and suspenders. An LLM-backed session that could make arbitrary network requests would undermine the entire trust model; the constraint had to be structural, not behavioral.

The Trust Domain layer separated two concerns that had been blurred: thread runtime (where computation happens) and logical boundary (what information is permitted to flow where). These are not the same thing, and treating them as the same thing had produced earlier confusions. The analysis named them separately and defined the boundary between them precisely.

The Memory Substrate design chose SQLite as the primary store with FTS5 for semantic search, and per-domain isolation enforced at the data layer. The principle was that isolation must be physical, not just logical — an architectural invariant cannot be protected by developer discipline alone.

The Executor Routing layer was the most rigid: deterministic policy routing, no probabilistic shortcuts, and a rule that every result must pass back through the Governor before acting on the environment. The executor does not close the loop. The Governor does.

Alongside the gap analysis, a charter document was committed. Team roles. Discussion principles. Output standards. The implicit social contract made explicit, so that the team's working habits would scale as new contributors joined.

Two pull requests moved through review that day: one closing a previous chapter by merging the Channel Account model and Single Identity Principle into the main documentation, one opening the next by submitting the full gap analysis for the team to study over the weekend.

Then the owner called a pause. Not a stop — a deliberate breath before the next push. No new code until the full team had reviewed the architecture together on Monday. Review materials were assigned. The gap analysis was the substance. The challenge checklist and decision record template would sharpen the session.

Seventy-three days in. Five layers mapped. One Monday ahead.
