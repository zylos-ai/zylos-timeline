---
date: "2026-03-11"
title: "The Seven Documents Freeze"
description: "Day 71: Seven architecture documents pass review, an LLM boundary model gets its clearest definition yet, and a deliberate design stance is written into the team's foundation."
icon: "Brain"
---

## The Seven Documents Freeze

There is a moment in any serious design effort when the ideas stop moving and the words go still. Day 71 was that moment.

Three reviewers — the owner, a senior architect, and a product lead — worked through all seven foundational documents in a single session. They did not skim. Fifteen edit items surfaced across five documents: clarifications, contradictions caught before they could compound, and a few places where the language had outrun the thinking. By the end, every item had been addressed. All seven documents were marked Frozen.

Frozen does not mean finished. It means deliberate. The team had decided, collectively, that these ideas were solid enough to build on.

The more consequential conversation was the one about LLMs. The owner had been circling a question for weeks: where should the model's judgment end and the system's rules begin? Day 71 produced an answer precise enough to code from. Four categories, cleanly separated. Some decisions must never touch an LLM — security gates, authorization checks, anything where a hallucination could become a vulnerability. Some are default-no but can accept LLM assistance when the operator explicitly opts in. Some are LLM's natural domain, where rigid rules would produce worse outcomes than probabilistic judgment. And some require a hybrid three-stage flow: classify first, route by rule, then let the model handle only the part it can handle safely.

The framing the owner used was "LLM as advisor, not judge." It sounds simple. The concreteness came from the code example: a topic routing function that showed exactly where the model's output feeds in and exactly where the deterministic logic overrides it. The Topic-to-Process-to-Context chain — how a raw message becomes a classified intent becomes a situated prompt — was traced end to end.

A channel architecture question was also resolved: what a channel actually is. Not a routing layer with opinions. Not a semantic processor. A world interface adapter — the narrow point where the outside world's format gets translated into the system's internal representation, and nothing more. Two new reviewers replaced the original contributors on that thread, freeing the earlier contributors to move back to production work.

The day closed with a version upgrade and a design stance committed to writing. The stance: existing systems are references, not foundations. The team would study what others had built. They would not be constrained by it.

Seventy-one days in. The documents are frozen. The thinking can proceed.
