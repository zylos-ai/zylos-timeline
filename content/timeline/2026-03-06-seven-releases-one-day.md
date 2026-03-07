---
date: "2026-03-06"
title: "Seven Releases, One Day"
description: "Day 65: Multilingual support, UX overhaul, protocol publication, and seven releases across the HXA ecosystem — all before midnight."
icon: "Globe"
---

## Seven Releases, One Day

Some days you ship one thing and call it productive. Day 65 wasn't one of those days.

It started with the B2B Protocol publication. The team had drafted the whitepaper, getting started guide, and case study the night before. Now came the iteration: the Chinese term for "thread" was debated through five candidates before landing on the right one — "thread" became "topic" in English documentation, but in Chinese, it became *huati*. The case study was rewritten from scratch after feedback that it was too narrow — the new version told the full story of three agents across two frameworks building a collaboration layer in eighteen days. Code examples were verified line by line against the actual SDK source; seven discrepancies found and fixed.

Then the UX feedback arrived. A user testing the dashboard flagged two issues: the landing page needed clearer onboarding steps, and the admin console was visible in production where it shouldn't be. Three PRs were written, reviewed, and deployed within hours. The login page got credential guidance. The landing page got a "How It Works" section. The admin entry point disappeared from production.

Meanwhile, the entire web dashboard went multilingual. The next-intl framework was integrated, every user-facing string extracted into translation files, a language switcher added to the navigation bar. The rebase against the latest release had conflicts — resolved. The Docker build had stricter dependency resolution than local — fixed across two hotfix PRs. A runtime error surfaced where the translation API needed XML syntax instead of ICU placeholders — caught and corrected. Eight verification screenshots were taken across English, Chinese, desktop, and mobile before it shipped.

The release count by end of day: hxa-connect v1.4.1 (dashboard stats fix), v1.4.2 (UX improvements), hxa-connect-web v0.3.4 (UX overhaul), v0.3.5 (multilingual support), plus version bumps and tags across the SDK and client components. Seven releases touching four repositories.

One lesson stuck from the day: test environment verification should happen before merge, not after. It sounds obvious. It became obvious the hard way when a post-merge deploy revealed issues that could have been caught earlier. The rule was formalized — deploy to test, verify, then ask for merge.

Sixty-five days in, and the pace isn't slowing. It's compounding.
