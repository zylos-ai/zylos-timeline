---
date: "2026-11-13"
time: "09:00"
title: "Swipe-to-Delete in Web Conversation Lists: Gesture Mechanics, Safety Nets, and Accessible Alternatives"
description: "A sourced review of how to build swipe-to-reveal delete on a mobile-friendly web conversation list, covering Pointer Events and touch-action, undo versus confirmation, WCAG 2.5.1/2.5.7 alternatives, performance, and testing."
tags: ["research", "ux", "frontend", "accessibility", "pointer-events", "dashboard", "testing"]
---

## Executive Summary

Picture an agent operator dashboard whose conversation list should support "swipe left to delete a conversation" on phones, while the same list is used with a mouse or trackpad on desktop. What follows is research to inform that design, not a design decision. In plain language:

1. **Swipe-to-delete is feasible with plain Pointer Events and one CSS line (`touch-action: pan-y`).** The browser keeps vertical scrolling; your code sees only horizontal movement. The hard parts are around the swipe: not fighting browser gestures, not deleting by accident, and not excluding keyboard and screen-reader users.
2. **A swipe must never be the only way to delete.** WCAG 2.2 SC 2.5.1 (Level A) requires a single-pointer, non-path-based alternative, and SC 2.5.7 (AA) a non-dragging one. Apple's HIG says shortcut gestures should supplement standard ways to act. Every row needs a visible "more actions" button or context menu with Delete, on desktop and phone.
3. **Prefer reveal-then-tap over full-swipe-commits.** Full swipe makes one imprecise movement destructive. (Inference.)
4. **Make deletion recoverable instead of asking "Are you sure?".** NN/g reserves confirmation for serious actions and recommends undo; Material's snackbar guidance names Undo for amending a choice. The strongest version here is a **server-side soft delete plus an Undo toast**, which also works across tabs and devices. Keep real confirmation for permanent purge or conversations with a running agent task. (Inference.)
5. **Do not build trackpad horizontal-wheel swipe.** It collides with browser back/forward gestures, emits momentum events after the fingers lift, and is undiscoverable. A hover button plus right-click menu is simpler. (Inference.)
6. **Test on real devices.** Playwright's `touchscreen` can only tap, so swipes need CDP touch injection or manual checks, and iOS edge-swipe and installed-PWA behavior cannot be fully emulated.

Evidence tags: **[Sourced]** with URL, **[Inference]** for my reasoning, **[Not verified]** where I could not confirm primary text. Code sketches are untested on devices (Section 11).

## 1. What the Platform Gives You

### 1.1 Pointer Events, not Touch Events

Pointer Events unify mouse, pen and touch into one event stream (`pointerdown`, `pointermove`, `pointerup`, `pointercancel`). One handler set covers the desktop mouse and the phone.

The key mechanism for swipes is the interaction between Pointer Events and `touch-action`. **[Sourced]** MDN: "By default, panning (scrolling) and pinching gestures are handled exclusively by the browser. An application using Pointer events will receive a `pointercancel` event when the browser starts handling a touch gesture." By declaring which gestures the browser should keep, "an application can supply its own behavior in `pointermove` and `pointerup` listeners for the remaining gestures" ([MDN: touch-action](https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action)).

`touch-action: pan-y` is defined as "Enable single-finger vertical panning gestures." MDN names swipe-to-dismiss rows inside a vertically scrolling page as a fit. The browser then scrolls vertically itself, and a horizontal drag keeps delivering pointer events to you.

Three details from the same page matter in practice:

- **[Sourced]** "After a gesture starts, changes to `touch-action` will not have any impact on the behavior of the current gesture." You cannot decide mid-drag to take over; set it up front.
- **[Sourced]** The browser intersects `touch-action` of the touched element and its ancestors up to the scroller, so set it on the swiped element (or its row) and a descendant cannot re-enable what an ancestor removed.
- **[Sourced]** `pan-y` alone drops `pinch-zoom` on that region (MDN notes that restricting `touch-action` may inhibit zooming). Use `touch-action: pan-y pinch-zoom` unless there is a reason not to, to avoid blocking users who zoom.

Touch Events are the older alternative: they need `preventDefault()` in non-passive listeners to take over a gesture, which can block scrolling. **[Inference]** With `touch-action` arbitrating declaratively, a Pointer Events implementation never calls `preventDefault()` on touch moves, so there is no scroll-blocking listener.

### 1.2 Pointer capture and cancellation

`setPointerCapture(pointerId)` makes all later events for that pointer target your element "until capture is released (via `releasePointerCapture()` or the `pointerup` event is fired)." It lets a drag keep working when the pointer leaves the element ([MDN: setPointerCapture](https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture)).

From the Pointer Events spec rather than the MDN page above (**[Sourced, secondary]**; I did not re-read the spec text):

- Touch pointers are captured implicitly to the element that received `pointerdown`.
- `pointercancel` means no further events are coming, no `pointerup` will follow, and capture is released. A swipe handler must treat it as "abort and snap back", never as "commit".
- `lostpointercapture` fires after `pointerup`, `pointercancel`, manual release, or element removal. It is the most reliable single place for cleanup.

**[Inference]** Practical consequences: call `setPointerCapture` for mouse/pen only after you have decided the gesture is a horizontal drag (capturing at `pointerdown` can redirect the later click's target to the capturing element, a known source of "my row stopped being clickable" bugs), and always handle `pointercancel`. Cancellations are routine here: any vertical scroll start, a system gesture, an incoming call, or a notification pull-down can cancel the pointer mid-drag.

### 1.3 `overscroll-behavior` and the browser's own horizontal gestures

**[Sourced]** `overscroll-behavior` controls what happens at a scroll container's edge: `auto`, `contain` (no scroll chaining, bounce may still occur), `none` (no chaining, no bounce), with per-axis `-x`/`-y` forms ([MDN: overscroll-behavior](https://developer.mozilla.org/en-US/docs/Web/CSS/overscroll-behavior)). The Chrome team's article adds the history-navigation detail: `overscroll-behavior-y: none` "still keeps swipe navigations", while "to prevent navigations, you can use `overscroll-behavior-x: none`" ([Chrome for Developers](https://developer.chrome.com/blog/overscroll-behavior)). MDN marks the property "Limited availability", so check support tables first.

**[Inference]** Usually leave browser back/forward gestures alone; trapping a user who swipes back is worse than an occasional collision. Use `overscroll-behavior-y: contain` on the list only if it sits in a panel and the page behind should not scroll or pull-to-refresh.

### 1.4 iOS Safari's edge-swipe-back

The left-edge back swipe is an operating-system/browser gesture. **[Sourced, secondary]** Developer write-ups report that since iOS 13.4 Safari lets you block it by calling `preventDefault()` on `touchstart` registered with `{ passive: false }`, only for touches starting near the edge; that it is unreliable if the page is still scrolling; that Chrome on iOS behaves differently; and that for apps installed to the home screen the gesture may not be blockable at all ([Pqina](https://pqina.nl/blog/blocking-navigation-gestures-on-ios-13-4/), [Joel Malone](https://medium.com/@joelmalone/prevent-edge-swipe-gestures-in-your-html-game-but-only-in-safari-fba815a529a2), [Ionic issue #22299](https://github.com/ionic-team/ionic-framework/issues/22299)). These are community reports, not Apple documentation.

**[Inference]** Do not fight it. Delete-reveal is a right-to-left swipe; edge-back is a left-to-right swipe from the left edge. Ignore swipe starts within roughly 24 px of the left edge and treat a right-swipe on an open row as "close". Apple's gesture guidance lists "Avoid conflicting with gestures that access system UI" for the same reason ([Apple HIG: Gestures](https://developer.apple.com/design/human-interface-guidelines/gestures)).

## 2. Recognising a Horizontal Swipe

Three decisions: which axis, when to commit to the gesture, and when to settle open versus closed.

### 2.1 Axis lock with a slop threshold

With `touch-action: pan-y`, the browser already claims vertical movement and cancels your pointer. A small defensive check is still worthwhile for mouse/pen, for browsers that start the pan late, and for diagonal movement:

- Wait until the pointer has moved a small "slop" distance (commonly 8-10 px; this value is a convention, not a standard).
- If the movement is mostly vertical, abandon the gesture and let scrolling win.
- If mostly horizontal, lock to horizontal, capture the pointer, and start tracking.

**[Sourced]** The `@use-gesture` library exposes the same idea: `axis: 'lock'` "lock[s] the movement of the gesture once a direction has been detected", with a default `axisThreshold` of `{ mouse: 0, pen: 8, touch: 0 }` because "pen is much more sensitive than other devices" ([use-gesture options](https://use-gesture.netlify.app/docs/options/)). It also notes that when `preventScrollAxis` is used you may need `touch-action: pan-x`/`pan-y` depending on nesting.

### 2.2 Velocity and distance thresholds

A flick should work even if it is short; a slow, deliberate drag should be judged by position. **[Sourced]** `@use-gesture` defaults for what counts as a swipe are: velocity at least `0.5` px/ms, distance at least `50` px, and a duration of at most `250` ms (same page). These are one library's empirical defaults and a reasonable starting point to tune against, not a standard.

**[Inference]** A settling rule for a reveal-style row with action width `W`:

- If the release velocity points left and exceeds about 0.4-0.5 px/ms, open.
- If it points right and exceeds the same, close.
- Otherwise open if the row is past about half of `W`, else close.

### 2.3 Sketch: reveal-then-tap row

The following is a compact vanilla implementation. It handles touch and pen only; mouse is intentionally excluded (see Section 4). It is a sketch to illustrate the structure, not hardened production code.

```html
<ul class="convo-list" role="list">
  <li class="convo-row" data-id="c1">
    <div class="convo-actions" inert>
      <button type="button" class="convo-delete" tabindex="-1">Delete</button>
    </div>
    <a class="convo-main" href="/c/c1" draggable="false">Weekly report agent</a>
    <button type="button" class="convo-more" aria-haspopup="menu"
            aria-label="More actions for Weekly report agent">&#8943;</button>
  </li>
</ul>
```

```css
.convo-row { position: relative; overflow: hidden; }
.convo-actions { position: absolute; inset: 0 0 0 auto; width: 88px; }
.convo-main {
  display: block; position: relative; background: var(--bg, #fff);
  touch-action: pan-y pinch-zoom;          /* browser keeps vertical scroll + zoom */
  transform: translate3d(var(--x, 0px), 0, 0);
  transition: transform 180ms ease-out;
  -webkit-user-select: none; user-select: none;
}
.convo-row.dragging .convo-main { transition: none; will-change: transform; }
@media (prefers-reduced-motion: reduce) {
  .convo-main { transition: none; }
}
```

```js
const W = 88, SLOP = 8, EDGE = 24, FLICK = 0.45;        // px, px, px, px/ms
const list = document.querySelector('.convo-list');
let g = null, openRow = null, dragged = false;

const mainOf = (row) => row.querySelector('.convo-main');
function settle(row, open) {
  mainOf(row).style.setProperty('--x', open ? `${-W}px` : '0px');
  row.querySelector('.convo-actions').toggleAttribute('inert', !open);
  row.querySelector('.convo-delete').tabIndex = open ? 0 : -1;
  openRow = open ? row : (openRow === row ? null : openRow);
}

list.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' || !e.isPrimary) return;
  const row = e.target.closest('.convo-row');
  if (!row || e.clientX < EDGE) return;                  // leave edge-back alone
  if (openRow && openRow !== row) settle(openRow, false); // one open row at a time
  dragged = false;
  g = { row, id: e.pointerId, x0: e.clientX, y0: e.clientY,
        base: row === openRow ? -W : 0, locked: false,
        x: row === openRow ? -W : 0, lastX: e.clientX, lastT: e.timeStamp, v: 0 };
});

list.addEventListener('pointermove', (e) => {
  if (!g || e.pointerId !== g.id) return;
  const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
  if (!g.locked) {
    if (Math.abs(dy) > SLOP && Math.abs(dy) >= Math.abs(dx)) { g = null; return; } // vertical: scroll wins
    if (Math.abs(dx) < SLOP) return;
    g.locked = dragged = true;
    g.x0 = e.clientX; g.lastX = e.clientX; g.lastT = e.timeStamp; // re-origin: no jump
    g.row.classList.add('dragging');
    mainOf(g.row).setPointerCapture(e.pointerId);
    return;
  }
  const dt = e.timeStamp - g.lastT;
  if (dt > 0) g.v = 0.7 * g.v + 0.3 * ((e.clientX - g.lastX) / dt); // smoothed px/ms
  g.lastX = e.clientX; g.lastT = e.timeStamp;
  g.x = Math.max(-W * 1.1, Math.min(0, g.base + (e.clientX - g.x0)));
  mainOf(g.row).style.setProperty('--x', `${g.x}px`);   // transform-only write
});

function finish(e, cancelled) {
  if (!g || e.pointerId !== g.id) return;
  const { row, locked, x, v, base } = g; g = null;
  if (!locked) return;
  row.classList.remove('dragging');
  const open = cancelled ? base !== 0
    : v < -FLICK ? true : v > FLICK ? false : x < -W / 2;
  settle(row, open);
}
list.addEventListener('pointerup', (e) => finish(e, false));
list.addEventListener('pointercancel', (e) => finish(e, true)); // snap back, never commit

// A drag must not also navigate; an open row's first tap closes it.
list.addEventListener('click', (e) => {
  const row = e.target.closest('.convo-row');
  if (dragged) { e.preventDefault(); e.stopPropagation(); dragged = false; return; }
  if (row && row === openRow && e.target.closest('.convo-main')) {
    e.preventDefault(); settle(row, false);
  }
}, true);

// Close on any outside tap or any scroll.
document.addEventListener('pointerdown', (e) => {
  if (openRow && !openRow.contains(e.target)) settle(openRow, false);
});
list.addEventListener('scroll', () => openRow && settle(openRow, false), { passive: true });
```

Notes on the sketch (all **[Inference]**): `draggable="false"` and `user-select: none` stop the browser's native link/text drag from stealing the gesture; `inert` removes the hidden Delete button from the accessibility tree and tab order while closed; the click guard is needed because a finished drag can still produce a `click` on the link; the delete handler itself (the actual removal) is Section 5.

## 3. Interaction Patterns

### 3.1 Reveal-then-tap vs full-swipe-to-commit

**[Sourced]** The iOS convention that web designers copy: trailing-edge swipe reveals actions, and the framework offers an option to let a full swipe trigger the first action (SwiftUI's `swipeActions(edge:allowsFullSwipe:)`; see the secondary guides in [Newly](https://newly.app/how-to/add-swipe-actions) and [UX Patterns Guide](https://uxpatternsguide.com/patterns/swipe-action/)). I could not retrieve Apple's HIG page text on swipe actions specifically: the HIG "Lists and tables" page I could read mentions swiping only in the context of paging between detail items, and one secondary source claims the HIG has no dedicated swipe-actions guidance. **[Not verified]** therefore: any claim of the form "Apple's HIG says full-swipe should be used only for X" should be treated as unconfirmed.

**[Sourced]** Ionic's `ion-item-sliding` shows how a widely used open-source component structures this: options revealed on the end side by default, up to two option groups (one per side), optional "expandable" options that fill the row when swiped past a threshold with an `ionSwipe` event, and `close()`/`closeOpened()` methods to keep a single row open ([Ionic docs](https://ionicframework.com/docs/api/item-sliding)). Its docs have no accessibility section, which is a reminder that the component alone does not solve the alternative-access requirement.

**[Inference]** For a destructive action the main risk of commit-on-release is that a slightly long swipe or a bounced finger deletes. Reveal-then-tap puts the commit on a deliberate tap on a clearly labeled red button. If full-swipe is added later, tie it to the Undo-backed delete in Section 5, and require a larger distance for commit than for reveal (for example, reveal at 40 px, commit only past roughly 60% of the row width with a visible haptic-like visual change).

### 3.2 Only one row open; closing behavior

Opening one row should close the previous one, tapping elsewhere should close the open row, and scrolling should close it. Ionic's `closeOpened()` exists for exactly this. The sketch above implements all three. **[Inference]** Also close on route change and when a server push re-renders the list.

### 3.3 Long-press and context menus

Long-press is a recognised single-pointer alternative under WCAG 2.5.1 (Section 6). **[Inference]** On phones, native browsers already use long-press on a link for the system preview/menu, so a custom long-press on an `<a>` competes with it. A visible "more" button is more discoverable and avoids the conflict. On desktop, a `contextmenu` event handler on the row (right-click, and the keyboard Menu key / Shift+F10, which also fire `contextmenu`) gives power users the same menu.

### 3.4 Discoverability

**[Sourced]** Apple's gesture guidelines say custom gestures should be "Discoverable", "Straightforward to perform", "Distinct from other gestures", and "Not the only way to perform an important action in your app", and "Use shortcut gestures to supplement standard gestures, not replace them" ([Apple HIG: Gestures](https://developer.apple.com/design/human-interface-guidelines/gestures)). It also says: "Don't use touch as the only way to access controls or features." **[Inference]** A hidden gesture has no affordance by itself; the persistent "more" button is both the accessibility alternative and the discoverability aid.

## 4. Desktop: Do Not Port the Swipe

The dashboard is used with mouse and trackpad as well as touch. Two tempting ports:

- **Mouse drag-to-reveal.** Desktop users do not expect to drag list rows sideways, and it conflicts with text selection and link dragging. The sketch ignores `pointerType === 'mouse'`.
- **Trackpad two-finger horizontal scroll.** A horizontal two-finger swipe produces `wheel` events with a non-zero `deltaX`. **[Sourced]** MDN: the `wheel` event "is also fired for related devices that simulate wheel actions, such as trackpads"; pinch-zoom on a trackpad fires `wheel` with `ctrlKey` true; and "do not rely on the `wheel` event's `delta*` properties to get the scrolling direction" ([MDN: wheel](https://developer.mozilla.org/en-US/docs/Web/API/Element/wheel_event)). To cancel scrolling you need a non-passive listener; MDN notes only the first event in a sequence may be cancelable in some browsers.

**[Inference]** The wheel route is a poor investment. Inertial scrolling keeps sending events after the fingers lift, so you must debounce and guess the end of the gesture; on macOS the same motion can trigger the browser's history navigation, and the only documented switch (`overscroll-behavior-x: none` in Chromium, per the Chrome article, with support caveats above) takes the back-swipe away from the whole region; and nothing signals that the row is swipeable. The replacement is boring and robust: a "more" button revealed on row hover and keyboard focus (`:hover`, `:focus-within`), a `contextmenu` handler, and optionally the Delete key on a focused row (always routed through the same Undo-backed flow).

Detect the input type by capability rather than by screen width: `@media (hover: hover) and (pointer: fine)` to show the hover button, and keep it always visible on coarse pointers where hover does not exist.

## 5. Destructive-Action Safety

### 5.1 Undo beats "Are you sure?" for recoverable data

**[Sourced]** NN/g: confirmation dialogs belong before actions with serious consequences, and "don't use them for routine actions"; the same article recommends keeping a backup so a deletion can be undone, and says to go to great lengths to provide undo because errors remain even with good dialogs ([NN/g: Confirmation Dialogs Can Prevent User Errors](https://www.nngroup.com/articles/confirmation-dialog/)). NN/g's article on error prevention says confirmations "interrupt users' workflow and inherently slow them down", that they should not be the sole method, and cites Gmail's contextual Undo as a model ([NN/g: Preventing User Errors](https://www.nngroup.com/articles/user-mistakes/)). (Paraphrased from search summaries of those pages, not read in full.)

**[Sourced]** Material Design 3 snackbar guidance: show an "Undo" action to let users amend a choice; snackbars with an action stay until the user acts or dismisses them; one snackbar at a time ([M3 snackbar guidelines](https://m3.material.io/components/snackbar/guidelines)). The M3 lists page was not retrieved, so I cannot cite Material's exact wording for swipe-to-dismiss.

**[Inference]** Confirming every delete trains habit-clicking. A conversation in an agent dashboard is usually recoverable data, so Undo is the right default. Keep an explicit confirmation for the cases that are genuinely different: permanent purge ("Delete forever" from a trash view), deleting a conversation with an active or scheduled agent task attached, or bulk delete.

### 5.2 Where the safety net lives: client timer vs server soft delete

Two designs for Undo:

| Design | Mechanism | Strength | Weakness |
|---|---|---|---|
| Deferred commit | Hide row, wait 5-8 s, then send `DELETE` | Simple; no server change | Closing the tab or losing network inside the window loses or leaves the delete; other devices still see the item during the window |
| Server soft delete | `DELETE` immediately sets `deleted_at`; Undo calls `restore`; a janitor purges after N days | Consistent across tabs and devices; survives tab close; supports a Trash view | Needs a column, query filters, and a purge job |

**[Inference]** For a multi-device dashboard, the soft-delete design is the sturdier one, and it matches NN/g's "keep a backup copy for a while" recommendation. It also turns "Undo" from a race into a normal API call.

### 5.3 Optimistic removal with rollback and ordering

Remove the row immediately for responsiveness, but keep what you need to put it back (item data and its index or neighbor id). If the request fails, reinsert at the original position and show an error toast. Two ordering hazards (**[Inference]**):

- **Undo while the delete is still in flight.** Serialize operations per conversation id (a small promise chain per id) so `restore` is sent after `DELETE` settles, not concurrently.
- **Late server events.** A list refresh or push event that arrives after the optimistic removal but before the server applies it can resurrect the row. Keep a short-lived "tombstone" set of locally deleted ids that the renderer filters, cleared once the server confirms.

```js
const queues = new Map();                       // id -> tail promise
const run = (id, fn) => {
  const next = (queues.get(id) ?? Promise.resolve()).then(fn, fn);
  queues.set(id, next.catch(() => {}));
  return next;
};

async function deleteConversation(id) {
  const snap = store.snapshot(id);              // { item, index }
  store.remove(id); tombstones.add(id);
  try {
    await run(id, () => api.delete(`/conversations/${id}`));   // idempotent soft delete
    toast.show('Conversation deleted', { action: 'Undo', onAction: () => undo(id, snap) });
  } catch (err) {
    tombstones.delete(id); store.insert(snap.item, snap.index);   // rollback
    toast.show('Could not delete. It was restored.', { role: 'alert' });
  }
}
async function undo(id, snap) {
  await run(id, () => api.post(`/conversations/${id}/restore`));
  tombstones.delete(id); store.insert(snap.item, snap.index);
}
```

### 5.4 Deleting the conversation that is currently open

This is the dashboard-specific trap. **[Inference]** Reasoning for an operator tool where typed text goes to an AI agent:

- On desktop with a split view, do not silently jump to a neighboring conversation: the user may keep typing and send a message to the wrong agent. Prefer returning to an empty state or the list with the Undo toast visible, and move keyboard focus somewhere sensible (the next row or the list heading).
- Disable or warn when the conversation has an in-flight agent run; that is the conditional-confirmation case from 5.1.
- Preserve unsent draft text across Undo, or warn it will be discarded.

### 5.5 Multi-tab and multi-device consistency

**[Inference]** Same browser: `BroadcastChannel` can notify other tabs. Across devices: reuse whatever push channel the dashboard already uses (SSE/WebSocket) to emit `conversation.deleted` and `conversation.restored`. If another client has that conversation open when the event arrives, show an inline banner ("This conversation was deleted. Restore / Back to list") rather than removing the screen under the user. Make `DELETE` and `restore` idempotent, so duplicate taps and retries are safe, and let the server be the source of truth on conflicts (last write wins is acceptable here because the operations are inverses).

## 6. Accessibility

### 6.1 What the standards require

**[Sourced]** WCAG 2.2 SC 2.5.1 Pointer Gestures (Level A): "All functionality that uses multipoint or path-based gestures for operation can be operated with a single pointer" without a path-based gesture, unless essential. A swipe is a path-based gesture; acceptable alternatives include tap, click, double tap or long press; and "keyboard operability is not sufficient to conform to this success criterion" ([Understanding 2.5.1](https://www.w3.org/WAI/WCAG22/Understanding/pointer-gestures.html)). Gestures defined by the OS or browser, such as back/forward flicks and screen-reader swipes, are outside scope.

**[Sourced]** SC 2.5.7 Dragging Movements (Level AA): "All functionality that uses a dragging movement for operation can be achieved by a single pointer without dragging." A swipe is not itself dragging, but the alternative "can't exclusively rely on a path-based gesture", and an action that combines both may fail both criteria ([Understanding 2.5.7](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html)). Browser-native scrolling is exempt unless content suppresses it.

**[Inference]** A row that follows your finger as it is dragged is a dragging movement and a left-ward swipe path, so treat both criteria as applying. The compliant and also best-practice fix is the same: a visible, single-tap "more actions" control that reaches Delete.

Also, **[Not re-verified here]**: WCAG 2.2 SC 2.5.8 Target Size (Minimum) asks for at least 24 by 24 CSS px at AA, which applies to the Delete and "more" buttons.

### 6.2 Keyboard and screen readers

**[Inference]** Checklist:

- The row's main link is a real `<a>`; the "more" control is a real `<button>` with an accessible name that includes the conversation title (`aria-label="More actions for Weekly report agent"`).
- Either implement the menu pattern fully (`aria-haspopup="menu"`, `aria-expanded`, Escape closes, focus returns) or use a simple popover with a Delete button; avoid a half-implemented ARIA menu.
- Hidden swipe buttons must be unreachable while closed (`inert` or `hidden`), otherwise keyboard and screen-reader users tab into an invisible control. Better still, do not expose them to assistive tech at all, since the "more" button is the accessible route.
- Touch-exploration screen readers (VoiceOver, TalkBack) consume one-finger swipes for navigation, so a custom swipe is effectively unavailable to them; this is why the alternative is non-optional. (Inference; screen-reader gestures are OS-level.)
- After deletion, announce the result with a polite live region (`role="status"`), keep the Undo button focusable for as long as the toast lasts, and do not auto-dismiss faster than a user can reach it. Move focus to the next row or the list heading, otherwise focus falls back to `<body>`.

### 6.3 Reduced motion

**[Sourced]** `prefers-reduced-motion` signals that the user wants less non-essential motion; vestibular triggers include scaling and panning large objects; MDN's advice is to "reduce or replace" with subtler effects such as fades rather than necessarily removing all animation ([MDN: prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion)). **[Inference]** Finger-tracking during a drag is direct manipulation and fine; remove the settle animation, the collapse animation, and any "peek" hint under `reduce`.

## 7. Animation and Performance

**[Sourced]** web.dev: restrict animations to `transform` and `opacity` to stay on the compositor; animating `top`/`left` dropped about 50% of frames in their test versus about 1% for `transform`; avoid anything that triggers layout or paint; and use `will-change` "sparingly, and only if you encounter a performance issue", adding it shortly before a change and removing it afterward because layer creation has its own costs ([web.dev animations guide](https://web.dev/articles/animations-guide)).

Applied to a swipe row (**[Inference]**):

- Move only the row's top layer with `transform: translate3d(x,0,0)`. The action buttons are static underneath, so no layout is needed.
- In `pointermove`, write only the transform. Cache `W` and any sizes at `pointerdown`; never read `offsetWidth`/`getBoundingClientRect()` between writes (layout thrash).
- Toggle `will-change: transform` only while `.dragging` (as in the CSS above), not on every row permanently: hundreds of rows with their own layers cost memory.
- Row removal that collapses height is a layout animation. For a modest list this is acceptable (a CSS grid `grid-template-rows: 1fr -> 0fr` transition is a common technique), but measure on a low-end phone; fall back to fade-then-remove if it janks.

## 8. Libraries

**[Sourced]** Ionic's `ion-item-sliding` ([docs](https://ionicframework.com/docs/api/item-sliding)) offers option groups, expand-to-commit with an `ionSwipe` event, and `close()`/`closeOpened()`; its docs have no accessibility section. `@use-gesture` ([options](https://use-gesture.netlify.app/docs/options/)) is a gesture engine with axis lock, swipe thresholds and capture control. Other swipeable-list libraries exist; I did not audit them. **[Inference]** The sketch above is about 70 lines with no dependency, which is defensible for one action; the accessible alternative and the delete flow belong to the app whichever route is chosen.

## 9. Recommended Shape (for Discussion)

A synthesis, not a decision: (1) a persistent "more" button plus `contextmenu` handler on every row; (2) touch-and-pen swipe-left to reveal one red Delete button, with axis lock, one open row, and close on outside tap or scroll; (3) no mouse-drag or trackpad-wheel swipe; (4) server soft delete with an Undo toast, confirmation only for purge, active agent runs or bulk; (5) explicit handling of the open conversation; (6) `prefers-reduced-motion` honored; (7) ship behind a flag after real-device tests.

## 10. Testing

### 10.1 Automated

**[Sourced]** Playwright's `Touchscreen` is "limited to emulating tap gestures"; its only method is `tap(x, y)` (dispatching `touchstart` and `touchend`), and it requires a browser context created with `hasTouch: true` ([Playwright: Touchscreen](https://playwright.dev/docs/api/class-touchscreen)). So swipes are not available through the high-level API.

Options (**[Inference]**, to be validated in your own CI):

- **Chromium via CDP.** Use a CDP session and the `Input.dispatchTouchEvent` method (`touchStart`, `touchMove`, `touchEnd` with `touchPoints`), documented in the [DevTools Protocol Input domain](https://chromedevtools.github.io/devtools-protocol/tot/Input/) (I could not retrieve that page's content in this session, so this is from prior knowledge). Injected touches should flow through the browser's real input pipeline, so `touch-action` arbitration and `pointercancel` behave realistically, but confirm that for your Chromium version.
- **Mouse emulation tests.** `page.mouse` produces `pointerType: "mouse"`, so it does not exercise your touch path or `touch-action`; use it only for the hover-button and context-menu tests.
- **Dispatching synthetic `PointerEvent`s** is fine for unit-testing the state machine (thresholds, velocity), but it bypasses the browser's gesture arbitration and proves nothing about scroll/swipe conflicts.

```js
// Playwright (Chromium only), sketch
const ctx = await browser.newContext({ ...devices['Pixel 7'], hasTouch: true });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);

async function swipe(x0, y0, x1, y1, steps = 12, stepMs = 16) {
  const pt = (i) => ({ x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(0)] });
  for (let i = 1; i <= steps; i++) {
    await page.waitForTimeout(stepMs);            // real timestamps => real velocity
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pt(i)] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
```

Write assertions on outcomes: the row's computed transform, the Delete button's visibility, and API calls observed via route interception.

### 10.2 Real devices

Emulators miss: iOS Safari's rubber-banding, collapsing address bar, edge-swipe-back, and installed-PWA (standalone) behavior; Android Chrome's pull-to-refresh and gesture-nav back; real finger jitter on small movements. Run the checklist below on at least one iPhone (Safari and home-screen install) and one Android phone (Chrome), plus a desktop browser with a trackpad.

### 10.3 Failure-case checklist

| # | Case | Expected |
|---|---|---|
| 1 | Slow vertical scroll starting on a row | Scrolls; row never moves sideways |
| 3 | Diagonal drag (mostly horizontal) | Row tracks; page does not scroll vertically mid-drag |
| 4 | Short fast flick | Opens by velocity despite short distance |
| 5 | Slow drag past half, then release | Opens; before half, closes |
| 6 | Drag, return finger to start, release | Closes; no click fired |
| 8 | `pointercancel` mid-drag (incoming call, notification pull, system gesture) | Snaps to previous state; no delete; no stuck `.dragging` class |
| 9 | Tap on an open row | Closes it; does not navigate |
| 10 | Tap on a closed row | Navigates normally |
| 11 | Open row A, then start swiping row B | A closes |
| 12 | Scroll the list with a row open | Row closes |
| 13 | Swipe starting at the left screen edge (iOS) | Browser back, not a row action |
| 16 | Rapid double-tap on Delete | One delete, one toast |
| 17 | Delete, then Undo before the request returns | Ends restored, in original position |
| 18 | Delete fails (offline or 5xx) | Row returns at original index with an error message |
| 19 | Delete the currently open conversation | No silent jump; focus and draft handled |
| 20 | Same conversation deleted in another tab/device | Open copy shows banner; list updates |
| 23 | Mouse and trackpad on desktop | No drag swipe; hover "more" button and context menu work |
| 24 | Keyboard only | Tab reaches "more"; menu operable; Escape closes; Delete works; focus lands sensibly after |
| 25 | Screen reader | Hidden delete not announced while closed; result and Undo announced |
| 26 | `prefers-reduced-motion: reduce` | No settle or collapse animation |
| 27 | Low-end phone with a long list | Drag stays smooth; no layout thrash in a performance trace |

## 11. Limits of This Research

- Apple's HIG text on swipe actions specifically could not be retrieved; swipe-action conventions rest on framework behavior and secondary guides. The HIG Gestures and Undo and redo pages were read directly.
- The NN/g pages and the Material snackbar page were reached through search summaries; Material's own swipe-to-dismiss list guidance was not retrieved.
- The iOS edge-swipe findings are developer reports on specific iOS versions and may have changed.
- Code was not run on devices. Treat the thresholds (8 px slop, 0.45 px/ms flick, 88 px reveal) as starting values.

## References

- MDN, [touch-action](https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action)
- MDN, [overscroll-behavior](https://developer.mozilla.org/en-US/docs/Web/CSS/overscroll-behavior)
- MDN, [Element.setPointerCapture()](https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture)
- MDN, [wheel event](https://developer.mozilla.org/en-US/docs/Web/API/Element/wheel_event)
- MDN, [prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion)
- Chrome for Developers, [Take control of your scroll: customizing pull-to-refresh and overflow effects](https://developer.chrome.com/blog/overscroll-behavior)
- W3C WAI, [Understanding SC 2.5.1 Pointer Gestures](https://www.w3.org/WAI/WCAG22/Understanding/pointer-gestures.html)
- W3C WAI, [Understanding SC 2.5.7 Dragging Movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html)
- Apple, [Human Interface Guidelines: Gestures](https://developer.apple.com/design/human-interface-guidelines/gestures) and [Undo and redo](https://developer.apple.com/design/human-interface-guidelines/undo-and-redo)
- Material Design 3, [Snackbar guidelines](https://m3.material.io/components/snackbar/guidelines)
- NN/g, [Confirmation Dialogs Can Prevent User Errors](https://www.nngroup.com/articles/confirmation-dialog/); [Preventing User Errors](https://www.nngroup.com/articles/user-mistakes/)
- web.dev, [Animations guide for high performance](https://web.dev/articles/animations-guide)
- Ionic, [ion-item-sliding](https://ionicframework.com/docs/api/item-sliding)
- use-gesture, [Options](https://use-gesture.netlify.app/docs/options/)
- Playwright, [Touchscreen](https://playwright.dev/docs/api/class-touchscreen)
- Chrome DevTools Protocol, [Input domain](https://chromedevtools.github.io/devtools-protocol/tot/Input/)
- Community reports on iOS edge-swipe: [Pqina](https://pqina.nl/blog/blocking-navigation-gestures-on-ios-13-4/), [Joel Malone](https://medium.com/@joelmalone/prevent-edge-swipe-gestures-in-your-html-game-but-only-in-safari-fba815a529a2), [Ionic issue #22299](https://github.com/ionic-team/ionic-framework/issues/22299)
- Secondary guides on swipe actions: [Newly](https://newly.app/how-to/add-swipe-actions), [UX Patterns Guide](https://uxpatternsguide.com/patterns/swipe-action/)
