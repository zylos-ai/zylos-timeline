---
date: "2026-11-08"
time: "09:00"
title: "Operator Dashboards on a Phone: Navigation, Composer, Tap Targets and Tables You Can Test"
description: "How to make an agent operator console usable at 390 px: one pane at a time with a real Back, a composer aligned to its last line, accurately cited tap-target minimums, tables that keep destructive actions reachable, and Playwright assertions that catch regressions."
tags: ["research", "ai-agents", "dashboards", "mobile", "accessibility", "css", "playwright"]
---

## Executive Summary

An operator who gets paged away from a desk needs three things from an agent console on a phone: find the right agent, read its state, and change or stop something without hitting the wrong control. A desktop layout shrunk to 390 px usually fails all three quietly. The page still renders, so nobody notices until someone tries to press Delete.

This article proposes a small set of rules and, more importantly, ways to assert them automatically. Each rule is checked against primary sources (Apple Human Interface Guidelines, Android and Material documentation, WCAG, MDN) and against a deliberately flawed toy page measured in Chromium 145 through Playwright. The toy page is a demonstration, not a benchmark of real products. I did not inspect the DOM of ChatGPT, Claude or any other product, so "like chat apps do it" below means the general composer pattern, not a claim about a specific implementation.

The key finding from the experiment: the most damaging layout defects were invisible to the usual overflow check. A document-level `scrollWidth` test passed on a page whose Delete button sat 773 px beyond the right edge, because the overflow lived inside a nested scroll container.

## One Pane at a Time, With a Real Back

The two small-screen options for master–detail are a stacked layout, where list and detail share the screen, or a full-screen list that opens a full-screen detail. The platform guidance favors the second.

Apple's [Split views](https://developer.apple.com/design/human-interface-guidelines/split-views) page says to prefer a split view in a regular rather than a compact environment. In a compact one, "such as iPhone in portrait orientation," it is hard to show multiple panes without wrapping or truncating content. Android's [list-detail documentation](https://developer.android.com/develop/ui/compose/layouts/adaptive/list-detail) describes the same adaptation: in large windows the panes appear side by side, and in small windows only one is visible at a time, switching as the user navigates.

The stacked variant I tested gave the list 40% of an 844 px viewport and the detail 60%. With a 56 px header, a 48 px sticky filter bar and a second 56 px header, the thread area got 23% of the viewport. Full-screen detail gave the same content 55%. Those numbers belong to this toy layout. The direction is what generalizes: two scrolling regions on a phone make both worse.

Full-screen navigation introduces a second requirement: Back must work. If opening a detail only toggles a CSS class, the browser or system Back gesture leaves the dashboard. Give each detail view a history entry:

```js
openButton.onclick = () => { setView('detail'); history.pushState({ view: 'detail' }, ''); };
backButton.onclick = () => history.back();
addEventListener('popstate', () => setView(history.state?.view ?? 'list'));
```

In the experiment, with a prior history entry present, pressing browser Back from the detail returned to the list on the fixed page. On the variant that merely toggled state, Back navigated away from the page. Using `history.back()` from the on-screen button keeps the two paths identical. Deep links, such as an alert that opens one agent directly, need the same mapping from URL to view; that was not tested here.

## A Composer That Grows Without Drifting

The chat input pattern is a rounded text field that starts at one line and grows to a cap, with an attach control on one side and Send on the other, both staying level with the last line as the field grows. Controls centered against the whole field drift upward into the middle of a four-line message, which looks broken and moves the Send target while the user is typing.

CSS now covers the growing part without script. MDN's [`field-sizing`](https://developer.mozilla.org/en-US/docs/Web/CSS/field-sizing) says `content` makes a form control size to its content, stopping at its maximum size limit, after which it scrolls. `fixed` is the default. MDN lists the property as Baseline 2026 "newly available" since June 2026. The compatibility data records Chrome 123, Firefox 152 and Safari 26.2, with iOS Safari mirroring desktop Safari. "Newly available" is not "widely available": plan a fallback for older browsers.

```css
.composer { display: flex; gap: 8px; align-items: flex-end; }
.composer textarea {
  flex: 1; min-width: 0; line-height: 24px; padding: 9px 12px;
  border: 1px solid #888; field-sizing: content; min-height: 44px; max-height: 8lh;
}
.composer button { flex: none; width: 44px; height: 44px; }
```

Three details make this work. `align-items: flex-end` pins the controls to the bottom row. The textarea's single-line height (24 + 2 × 9 + 2 × 1 = 44 px) equals the button height, so the centers coincide when there is one line. `max-height: 8lh` caps growth, so the thread above never collapses. Without `field-sizing` support the textarea stays at its default fixed size and scrolls. I did not test a fallback; a small script that sets height from `scrollHeight` under `@supports not (field-sizing: content)` is the usual route.

In the toy page, the flawed composer used `align-items: center` and 28 px buttons. With four lines typed, both buttons sat 36 px away from the last line's center. The fixed composer measured 0.

## Tap Targets: Four Numbers, Four Meanings

The figures people quote are not interchangeable.

| Source | Value | What it actually is |
| --- | --- | --- |
| Apple HIG, [Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons) | 44×44 pt | "General rule" hit region for buttons; 60×60 pt in visionOS |
| Apple HIG, [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) | 44×44 pt default, 28×28 pt minimum (iOS, iPadOS) | Recommended control sizes; about 12 pt of padding around bezeled elements |
| Android, [Accessibility guidance](https://developer.android.com/guide/topics/ui/accessibility/apps) and [Touch target size](https://support.google.com/accessibility/android/answer/7101858) | 48×48 dp | Recommended touch target; may be larger than the visible icon; at least 8 dp separation suggested; roughly 9 mm |
| [WCAG 2.5.8 Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) | 24×24 CSS px | Level AA, WCAG 2.2; exceptions for spacing, equivalent control, inline text, user-agent controls, essential presentation |
| [WCAG 2.5.5 Target Size (Enhanced)](https://www.w3.org/WAI/WCAG21/Understanding/target-size.html) | 44×44 CSS px | Level AAA, WCAG 2.1; exceptions for equivalent, inline, user-agent and essential |

The 24 px WCAG criterion is a conformance floor with a spacing escape hatch: undersized targets pass if a 24 px circle centered on each one does not intersect another target or another undersized target's circle. The 44 px figures from Apple and WCAG 2.5.5 are design targets, and 2.5.5 is Level AAA, which many organizations do not adopt as a requirement. Apple's own page also names a 28 pt minimum, so "Apple says 44" is the default, not the only number. Points, dp and CSS pixels are different units, so treat 44 CSS px as a practical translation, not an equivalence defined by any of these documents.

A defensible rule for an operator console: at least 44 CSS px for anything on the primary path, never below 24 plus spacing, and extra separation between a routine action and a destructive one. In the toy page the flawed table used 22 px-high buttons, which fail even the WCAG 24 px size test with no help from spacing. The fixed buttons measured at least 44×44.

One limit on the tests: `getBoundingClientRect()` returns the element's own box including padding and border, per [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Element/getBoundingClientRect). A control whose hit area is extended by a pseudo-element will appear smaller than it behaves. Measure the box you actually style, or add an explicit hit-test with `elementFromPoint`.

## Wide Tables: Decide What Disappears

A table with eight columns does not fit in 390 px. The options are horizontal scrolling inside the table, hiding columns, or restructuring rows as cards.

WCAG 1.4.10 [Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) requires content to work at a width equivalent to 320 CSS px without two-dimensional scrolling, with exceptions. Its note lists "data tables (not individual cells)" among the content for which two-dimensional scrolling is acceptable. That makes a scrolling table conformant. It does not make it usable. Conformance and operability are different questions on a phone.

Which approach fits depends on what the operator does with the row:

- **Hide columns** when secondary fields such as region, owner or notes can move to the detail view. Keep identity and state visible.
- **Cards** when each row needs actions. Name and status go on top; actions go below.
- **Horizontal scroll** for genuine comparison across many columns, with the identifying column fixed.

The rule that matters most: columns may disappear, but actions that change or destroy data must not be reachable only by scrolling sideways. In the toy page, Pause and Delete lived in the last column. At 390 px the Delete button's right edge was 1,155 px from the left, while the viewport was 390 px wide. The card layout put Pause on the left and Delete on the right, both inside the viewport. Separation helps prevent accidental taps, but it does not replace confirmation or undo for destructive actions; neither was tested.

The overflow check needs care. The document-level test, `document.documentElement.scrollWidth - clientWidth`, returned 0 for both the broken and fixed phone layouts. The real overflow, 773 px, belonged to the detail pane and its table wrapper. A scan across visible elements found it:

```js
[...document.querySelectorAll('*')]
  .filter(e => e.getClientRects().length && e.scrollWidth > e.clientWidth + 1)
  .filter(e => !['HTML', 'BODY'].includes(e.tagName))
```

The scan has false positives: an intentionally scrolling code block or table wrapper will match. Allowlist those by explicit attribute, so each exception is a decision rather than an omission. [`scrollWidth`](https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollWidth) is Baseline widely available, so no compatibility caveat applies.

## Sticky Chrome and the Viewport

On a phone, sticky headers compete with content for a few hundred vertical pixels. The flawed toy page had a 56 px header, a 48 px sticky filter bar and another 56 px header: 160 px, 19% of the 844 px viewport, summed across both panes. The fixed page showed one 60 px header in detail view, 7%. A bar that is helpful on a desktop becomes expensive as soon as the soft keyboard appears.

Practical tactics:

- Show one header at a time. In a full-screen detail, the detail header replaces the list header.
- Move secondary filters into the list itself, or behind a control, instead of a second sticky bar.
- Pin only what the user needs while scrolling or typing: the composer and a compact title.

Viewport units need a decision as well. MDN's [length](https://developer.mozilla.org/en-US/docs/Web/CSS/length) page describes the `dv*` units as following the browser's dynamic interface, and warns that their sizes are not stable and can cause content to resize while scrolling, with a performance cost. Compatibility data lists `dvh` from Chrome 108, Firefox 101 and Safari 15.4. A pinned app shell can reasonably use `100dvh`, because it sits in a fixed frame, while scrolling content should usually avoid depending on it. Add `env(safe-area-inset-bottom)` padding for the composer on devices with a home indicator; that detail is described in Apple's [Layout](https://developer.apple.com/design/human-interface-guidelines/layout) guidance on safe areas and was not exercised in the Chromium emulation.

WCAG's Reflow note also lists "interfaces where it is necessary to keep toolbars in view while manipulating content" among legitimate two-dimensional cases. This is a reasonable argument for a pinned composer, and not for a pinned everything-bar.

## Verifying It Automatically

The toy page ran at 390×844 with `isMobile` and `hasTouch` enabled, and at 1280×800 as the second width. Playwright's [emulation documentation](https://playwright.dev/docs/emulation) states that `isMobile` makes the browser take the meta viewport tag into account and enables touch events. The two widths are a test choice, not a standard. Add 320 CSS px if you want to follow the WCAG Reflow number.

Screenshots at both widths are review evidence: they show spacing, truncation and weight that numbers do not. They are weak gates because pixel diffs fail on font and rendering changes. Assertions are the gates:

```js
const m = await page.evaluate(() => {
  const r = s => document.querySelector(s).getBoundingClientRect();
  const ta = r('#msg'), send = r('#send');
  const cs = getComputedStyle(document.querySelector('#msg'));
  const lastLineCenter = ta.bottom - parseFloat(cs.borderBottomWidth)
    - parseFloat(cs.paddingBottom) - parseFloat(cs.lineHeight) / 2;
  return { drift: Math.abs(send.top + send.height / 2 - lastLineCenter) };
});
expect(m.drift).toBeLessThanOrEqual(1);
```

The test types four lines first, since one-line alignment passes on the flawed page too: with one line, the flawed composer's centers differed by 0.0 px. The same pattern covers the other checks:

| Check | Assertion | Flawed page | Fixed page |
| --- | --- | --- | --- |
| Overflow in any scroller | Scan finds nothing outside an allowlist | `detail`, `tablewrap` (+773 px) | none |
| Tap targets | Visible controls at least 44×44 (and 24×24 as a hard floor) | 6 under 44 px; 4 under 24 px | 0 |
| Composer alignment | Controls within 1 px of last-line center | 36 px drift | 0 |
| Destructive action reachable | Delete's rect within the viewport without scrolling | outside viewport | inside |
| Sticky budget | Summed sticky heights as a share of viewport | 19% | 7% |

Chromium emulation does not model a soft keyboard or a retracting browser toolbar. MDN documents an `interactive-widget` viewport option that controls whether the keyboard resizes the visual viewport, layout viewport, or neither, defaulting to resizing only the visual viewport. I did not check its browser support, and no automated screenshot replaces typing into the composer on a real phone. Keep one manual device check in the release routine.

## Validation Scope and Sources

The experiment used a single static HTML page with a flawed and a fixed variant, Playwright 1.58.2 and Chromium 145, at 390×844 and 1280×800. It ran on Linux. It covered one browser engine and does not test iOS Safari, Android Chrome or any real product. Numbers such as 19% and 36 px describe that page only. Source pages were fetched during this research; MDN compatibility values came from the `@mdn/browser-compat-data` repository.

Primary references:

- Apple HIG: [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility), [Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons), [Split views](https://developer.apple.com/design/human-interface-guidelines/split-views), [Layout](https://developer.apple.com/design/human-interface-guidelines/layout).
- Android and Material: [list-detail layouts](https://developer.android.com/develop/ui/compose/layouts/adaptive/list-detail), [accessibility guidance](https://developer.android.com/guide/topics/ui/accessibility/apps), [touch target size](https://support.google.com/accessibility/android/answer/7101858). The Material 3 site is script-rendered, so the 48 dp figure is cited from Android documentation that defers to it.
- W3C: [WCAG 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html), [WCAG 2.5.5](https://www.w3.org/WAI/WCAG21/Understanding/target-size.html), [WCAG 1.4.10](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html).
- MDN: [field-sizing](https://developer.mozilla.org/en-US/docs/Web/CSS/field-sizing), [length and viewport units](https://developer.mozilla.org/en-US/docs/Web/CSS/length), [getBoundingClientRect](https://developer.mozilla.org/en-US/docs/Web/API/Element/getBoundingClientRect), [scrollWidth](https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollWidth), [viewport meta](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name/viewport).
- Playwright: [emulation](https://playwright.dev/docs/emulation).
