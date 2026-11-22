---
date: "2026-11-13"
time: "09:00"
title: "Swipe-to-Delete in Web Conversation Lists: Gesture Mechanics, Safety Nets, and Accessible Alternatives"
description: "A sourced review of how to build swipe-to-reveal delete on a mobile-friendly web conversation list, covering Pointer Events and touch-action, undo versus confirmation, WCAG 2.5.1/2.5.7 alternatives, performance, and testing."
tags: ["research", "ux", "frontend", "accessibility", "pointer-events", "dashboard", "testing"]
---

## Executive Summary

Picture an agent operator dashboard whose conversation list should support "swipe left to delete a conversation" on phones, while the same list is used with a mouse or trackpad on desktop. What follows is research to inform that design, not a design decision. In plain language:

1. **Swipe-to-delete is feasible with plain Pointer Events and one CSS line (`touch-action: pan-y pinch-zoom`).** The browser keeps vertical scrolling and pinch zoom. Your code still receives pointer moves on both axes and must pick the axis itself; when the browser starts a vertical pan it takes the touch over and sends `pointercancel`. The hard parts are around the swipe: not fighting browser gestures, not deleting by accident, and not excluding keyboard and screen-reader users.
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

MDN defines `pan-y` as "Enable single-finger vertical panning gestures." The Pointer Events spec gives the matching use: "an image carousel may use pan-y to ensure it receives pointer events for any horizontal pan operations without interfering with vertical panning of the document" ([Pointer Events Level 3, touch-action](https://www.w3.org/TR/pointerevents3/#the-touch-action-css-property)). This reserves vertical panning for the browser; it does not filter the event stream down to horizontal moves. Your listeners still see `pointermove` with vertical components, which is why the sketch below locks the axis itself. Once the browser decides the touch is a vertical pan, it takes the touch over: the spec says the user agent "MUST suppress a pointer event stream" when "The pointer is subsequently used by the user agent to manipulate the page viewport (e.g. panning or zooming)", and suppression begins with a `pointercancel`. In a Chromium touch-emulation check (scratch harness, not a device test), a mostly vertical drag on a `pan-y pinch-zoom` row delivered `pointerdown`, one `pointermove` 17 px lower, then `pointercancel` while the page scrolled.

Three details from MDN's page matter in practice:

- **[Sourced]** "After a gesture starts, changes to `touch-action` will not have any impact on the behavior of the current gesture." You cannot decide mid-drag to take over; set it up front.
- **[Sourced]** The browser intersects `touch-action` of the touched element and its ancestors up to the scroller, so set it on the swiped element (or its row) and a descendant cannot re-enable what an ancestor removed.
- **[Sourced]** `pan-y` alone leaves `pinch-zoom` out of the allowed gestures on that region; MDN's accessibility note warns that `touch-action: none` "may inhibit operating a browser's zooming capabilities", and the same concern applies to a `pan-y`-only row. Use `touch-action: pan-y pinch-zoom`, as everywhere in this article, so users can still zoom. (`pinch-zoom` comes from MDN's syntax; the Level 3 spec's value grammar lists only `auto`, `none`, `pan-x`/`pan-y` and `manipulation`, so check MDN's compatibility table for your target browsers.)

Touch Events are the older alternative: they need `preventDefault()` in non-passive listeners to take over a gesture, which can block scrolling. **[Inference]** With `touch-action` arbitrating declaratively, a Pointer Events implementation never calls `preventDefault()` on touch moves, so there is no scroll-blocking listener.

### 1.2 Pointer capture and cancellation

`setPointerCapture(pointerId)` makes all later events for that pointer target your element "until capture is released (via `Element.releasePointerCapture()` or the `pointerup` event is fired)." It lets a drag keep working when the pointer leaves the element ([MDN: setPointerCapture](https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture)).

From the [Pointer Events Level 3](https://www.w3.org/TR/pointerevents3/) spec (**[Sourced]**, paraphrased):

- Direct-manipulation inputs such as touch should behave as if `setPointerCapture` had been called on the `pointerdown` target before any `pointerdown` listener runs (section 9.4, implicit capture).
- `pointercancel` is the first step of suppressing the pointer's event stream, followed by `pointerout`, `pointerleave` and implicit release of capture (section 4.1.3.3). A swipe handler must treat it as "abort and snap back", never as "commit".
- `lostpointercapture` fires whenever capture is released: after `pointerup` or `pointercancel` (section 9.5), on an explicit release, and, when the capturing node is removed from the document, at the document instead of the element. The sketch below does its cleanup in its `pointerup` and `pointercancel` handlers, which cover the release paths it creates; it does not listen for `lostpointercapture`. Add that listener if other code can release capture or re-render the row mid-drag.

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

With `touch-action: pan-y pinch-zoom`, the browser claims vertical pans and cancels your pointer once it starts one, but your code has already seen the first moves. A small defensive check is still worthwhile for mouse/pen, for browsers that start the pan late, and for diagonal movement:

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

// Close on any outside tap or any scroll. `scroll` does not bubble from elements,
// so listen in the capture phase on document: page scroll and nested scrollers.
document.addEventListener('pointerdown', (e) => {
  if (openRow && !openRow.contains(e.target)) settle(openRow, false);
});
document.addEventListener('scroll', () => openRow && settle(openRow, false),
  { capture: true, passive: true });
```

Notes on the sketch (all **[Inference]**): `draggable="false"` and `user-select: none` stop the browser's native link/text drag from stealing the gesture; `inert` removes the hidden Delete button from the accessibility tree and tab order while closed; the click guard is needed because a finished drag can still produce a `click` on the link; the delete handler itself (the actual removal) is Section 5.

## 3. Interaction Patterns

### 3.1 Reveal-then-tap vs full-swipe-to-commit

**[Sourced]** The iOS convention that web designers copy: a swipe reveals row actions, and in SwiftUI a full swipe performs the first one unless the app turns that off. Apple's reference for `swipeActions(edge:allowsFullSwipe:content:)` says: "By default, the user can perform the first action for a given swipe direction with a full swipe." and "You can opt out of this behavior for an edge by setting the `allowsFullSwipe` parameter to `false`." It describes `allowsFullSwipe` as "A Boolean value that indicates whether a full swipe automatically performs the first action. The default is `true`." ([Apple: swipeActions](https://developer.apple.com/documentation/swiftui/view/swipeactions(edge:allowsfullswipe:content:))). So the native default is commit-on-full-swipe, and reveal-only is an explicit opt-out. I could not retrieve Apple's HIG page text on swipe actions specifically: the HIG "Lists and tables" page I could read mentions swiping only in the context of paging between detail items, and one secondary source claims the HIG has no dedicated swipe-actions guidance. **[Not verified]** therefore: any claim of the form "Apple's HIG says full-swipe should be used only for X" should be treated as unconfirmed.

**[Sourced]** Ionic's `ion-item-sliding` shows how a widely used open-source component structures this: options revealed on the end side by default, up to two option groups (one per side), optional "expandable" options that fill the row when swiped past a threshold with an `ionSwipe` event, and `close()`/`closeOpened()` methods to keep a single row open ([Ionic docs](https://ionicframework.com/docs/api/item-sliding)). Its docs have no accessibility section, which is a reminder that the component alone does not solve the alternative-access requirement.

**[Inference]** For a destructive action the main risk of commit-on-release is that a slightly long swipe or a bounced finger deletes. Reveal-then-tap puts the commit on a deliberate tap on a clearly labeled red button. If full-swipe is added later, tie it to the Undo-backed delete in Section 5, and require a larger distance for commit than for reveal (for example, reveal at 40 px, commit only past roughly 60% of the row width with a visible haptic-like visual change).

### 3.2 Only one row open; closing behavior

Opening one row should close the previous one, tapping elsewhere should close the open row, and scrolling should close it. Ionic's `closeOpened()` exists for exactly this. The sketch above implements all three: its `pointerdown` handlers close the previous row and handle outside taps, and its capture-phase `scroll` listener on `document` closes the row whichever element scrolls, the page or a scrollable panel around the list. A listener on `.convo-list` itself would miss both, because the list is not a scroll container in this markup. **[Inference]** Also close on route change and when a server push re-renders the list.

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

Remove the row immediately for responsiveness, but keep what you need to put it back (item data and its index or neighbor id). If the server rejects the request, reinsert at the original position and show an error toast.

**[Inference]** A failed request is not always a rejection. If the server commits the delete and the response is then lost (network drop, timeout, a proxy answering 5xx), the client sees an error although the conversation is deleted; reinserting the row and saying "restored" would then be wrong. So the sketch separates three results, under one stated contract: `DELETE` on an already deleted conversation and `restore` on an already restored one return 2xx, and a 4xx response to a request means that request made no change.

- **Done** (2xx): the change happened.
- **Rejected** (4xx to the first attempt): the server answered and made no change, so the client may roll back.
- **Unconfirmed** (no response, timeout, 5xx): the change may or may not have happened. Repeat the same request once; by the contract a repeat after a committed change also returns 2xx, so a 2xx to the repeat settles it. Any other answer to the repeat leaves the result unconfirmed, including a 4xx: a 401 from an authentication layer, for example, shows only that the repeat was refused, not what happened to the first attempt. Treat such a 4xx as a rejection only if the response states the outcome of the original operation (a durable receipt or an authoritative state check), which the plain idempotency contract does not promise. If the result is still unconfirmed, the client does not guess: the row stays as the screen shows it, an alert says the result could not be confirmed, a queued Undo is not applied (the alert says so), and the next list refresh shows the server's state.

The client also needs exactly one delete transition per conversation id, with a defined answer to four races:

- **Double activation.** A second tap, swipe or keyboard Delete on the same id joins the transition already running: no second `DELETE`, no second toast. Server idempotency makes a duplicate request harmless, but it cannot stop the UI from issuing it twice.
- **Undo while the delete is in flight.** Show Undo at once, together with the optimistic removal. If it is pressed before the `DELETE` returns, record the request and send `restore` only after the `DELETE` succeeds; if the server rejects the `DELETE`, the rollback already brought the row back and no `restore` is sent; if the `DELETE` stays unconfirmed, no `restore` is sent and the alert says Undo was not applied.
- **Failed restore.** If the server rejects it, the conversation is still soft-deleted, so the row stays removed and an alert says it is in Trash (where a Trash view can restore it later). If the restore stays unconfirmed, the row stays removed and the alert says the restore could not be confirmed.
- **Stale list responses.** A list request started before the server applied the delete can return after the delete acknowledgement and resurrect the row; a tombstone cleared at the acknowledgement does not stop it. Two rules do: while a transition for an id is in flight, the local state wins over any list response; and every `DELETE` or `restore` acknowledgement bumps a sequence number, so a list response whose request started before the latest acknowledgement is discarded and fetched again.

```js
const ops = new Map();   // id -> one delete transition: { snap, state, undo, closed, done }
let ackSeq = 0;          // bumped whenever a DELETE or restore settles

// 'done' (2xx), 'rejected' (4xx to the first attempt: no change made) or 'unknown'.
// A lost response, timeout or 5xx proves nothing, so the idempotent request is
// repeated once. A 4xx to the repeat says nothing about the first attempt.
async function outcome(request) {
  for (let attempt = 1; ; attempt++) {
    try { await request(); return 'done'; }
    catch (err) {                                 // api sets err.status when the server answered
      if (attempt === 2) return 'unknown';
      if (err.status >= 400 && err.status < 500) return 'rejected';
    }
  }
}

function deleteConversation(id) {
  if (ops.has(id)) return ops.get(id).done;     // double activation joins the first transition
  const op = { snap: store.snapshot(id), state: 'deleting', undo: false, closed: false };
  ops.set(id, op);
  store.remove(id);
  toast.show('Deleting conversation', { action: 'Undo', onAction: () => undo(id),
    onClose: () => { op.closed = true; if (op.state === 'deleted') ops.delete(id); } });
  op.done = outcome(() => api.delete(`/conversations/${id}`)).then((result) => {   // soft delete
    ackSeq++;
    if (result === 'done') {
      op.state = 'deleted';
      if (op.undo) return restore(id, op);       // Undo pressed while in flight
      if (op.closed) ops.delete(id);
      return;
    }
    ops.delete(id);
    if (result === 'rejected') {
      store.insert(op.snap.item, op.snap.index);
      toast.show('Could not delete. It was restored.', { role: 'alert' });
    } else {                                      // row stays hidden; next refresh shows the truth
      toast.show(op.undo ? 'Could not confirm the delete, so Undo was not applied. Refresh to check.'
                         : 'Could not confirm the delete. Refresh to check.', { role: 'alert' });
    }
  });
  return op.done;
}

function undo(id) {
  const op = ops.get(id);
  if (!op || op.undo) return;                    // settled already, or second Undo
  op.undo = true;
  if (op.state === 'deleted') return restore(id, op); // else restore runs after the ack
}

async function restore(id, op) {
  op.state = 'restoring';
  const result = await outcome(() => api.post(`/conversations/${id}/restore`));
  ackSeq++; ops.delete(id);
  if (result === 'done') store.insert(op.snap.item, op.snap.index);
  else toast.show(result === 'rejected' ? 'Could not restore. It is still in Trash.'
                                        : 'Could not confirm the restore. Refresh to check.', { role: 'alert' });
}

async function refreshList() {
  const seq = ackSeq;
  const items = await api.get('/conversations');
  if (seq !== ackSeq) return refreshList();      // started before an ack: may predate it
  store.replace(items.filter((c) => !ops.has(c.id)));  // in-flight ids: local state wins
}
```

**[Inference]** `store`, `api` and `toast` are app-specific (the toast calls `onClose` when it is dismissed or replaced, and `api` rejects with an error carrying the HTTP `status` when the server answered, without one on a network error or timeout). The sketch was run against stubbed `api`, `store` and `toast` objects with manually resolved promises and a stub server that records whether each request was applied, not in a browser. Observed: a double activation sent one `DELETE` and showed one toast; Undo pressed while the `DELETE` was pending sent `restore` only after the `DELETE` succeeded and put the row back at its original index; Undo followed by a rejected (409) `DELETE` sent no `restore` and restored the row once; a rejected `restore` left the row removed with the Trash alert; when the server applied the `DELETE` and the response was lost, the repeated `DELETE` returned 2xx and the row stayed deleted, and a queued Undo then restored it; when the response was lost and the repeat got a 401, the result stayed unconfirmed: the row stayed removed (matching the server), the alert said so, and a queued Undo was not applied; when both attempts were lost, the row stayed removed (matching the server), the alert said the delete could not be confirmed and, with Undo queued, that Undo was not applied, and no `restore` was sent; two 503s without a change gave the same alert and the next list refresh brought the row back; a `restore` applied with its response lost was settled by the repeat and the row returned, and when both attempts were lost, or the repeat got a 401, the alert said the restore could not be confirmed and the next refresh showed the row; a list response containing the row arrived while the `DELETE` was pending and did not show it; a list request started before the delete and answered after the acknowledgement was discarded and refetched, and the row stayed gone. Not covered by the snippet: push events from other clients (`conversation.deleted`/`restored`, Section 5.5; ordering those against local actions needs something like a per-conversation version from the server), focus and draft handling (Section 5.4), and a cap on refetches if acknowledgements keep arriving during a list request.

### 5.4 Deleting the conversation that is currently open

This is the dashboard-specific trap. **[Inference]** Reasoning for an operator tool where typed text goes to an AI agent:

- On desktop with a split view, do not silently jump to a neighboring conversation: the user may keep typing and send a message to the wrong agent. Prefer returning to an empty state or the list with the Undo toast visible, and move keyboard focus somewhere sensible (the next row or the list heading).
- Disable or warn when the conversation has an in-flight agent run; that is the conditional-confirmation case from 5.1.
- Preserve unsent draft text across Undo, or warn it will be discarded.

### 5.5 Multi-tab and multi-device consistency

**[Inference]** Same browser: `BroadcastChannel` can notify other tabs. Across devices: reuse whatever push channel the dashboard already uses (SSE/WebSocket) to emit `conversation.deleted` and `conversation.restored`. If another client has that conversation open when the event arrives, show an inline banner ("This conversation was deleted. Restore / Back to list") rather than removing the screen under the user. Make `DELETE` and `restore` idempotent, so retries and duplicates from other clients are safe (the single retry of an unconfirmed request in Section 5.3 depends on it) (duplicate taps within one client are deduplicated in the client, Section 5.3), and let the server be the source of truth on conflicts (last write wins is acceptable here because the operations are inverses).

## 6. Accessibility

### 6.1 What the standards require

**[Sourced]** WCAG 2.2 SC 2.5.1 Pointer Gestures (Level A): "All functionality that uses multipoint or path-based gestures for operation can be operated with a single pointer" without a path-based gesture, unless essential. A swipe is a path-based gesture; acceptable alternatives include tap, click, double tap or long press; and "keyboard operability is not sufficient to conform to this success criterion" ([Understanding 2.5.1](https://www.w3.org/WAI/WCAG22/Understanding/pointer-gestures.html)). Gestures defined by the OS or browser, such as back/forward flicks and screen-reader swipes, are outside scope.

**[Sourced]** SC 2.5.7 Dragging Movements (Level AA): "All functionality that uses a dragging movement for operation can be achieved by a single pointer without dragging, unless dragging is essential or the functionality is determined by the user agent and not modified by the author." The Understanding document separates the two criteria: dragging means "grabbing" an element and moving it, where "the direction of the dragging movement does not factor into the interaction at all", while for 2.5.1 pointer gestures "the direction of the pointer movement matters"; an action that involves both "may fail against the requirements of both success criteria". The alternative "can't exclusively rely on a path-based gesture, such as swiping or 'flicking'", and it "does not have to be the same component, so long as the functionality is equivalent" ([Understanding 2.5.7](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html)). Browser-native scrolling is exempt unless content suppresses it or implements its own.

**[Inference]** Classification depends on how the gesture is recognised, so apply it to the actual code. The sketch in Section 2.3 is direction-dependent: it starts only after a mostly horizontal move and settles open on a leftward flick or position, which makes it a path-based gesture under 2.5.1. Once locked, the row's top layer follows the finger and is released at a position, which resembles the grab-move-release pattern of 2.5.7. Neither 2.5.7 exception fits: dragging is not essential to deleting, and the gesture is implemented by the page, not the browser. A recogniser that triggered on any release distance regardless of direction, or on a pure flick with no tracking, would classify differently. In both readings the remedy is the same: a visible, single-tap "more actions" control that reaches Delete.

**[Sourced]** SC 2.5.8 Target Size (Minimum) (Level AA): "The size of the target for pointer inputs is at least 24 by 24 CSS pixels", except when one of five exceptions applies: Spacing, Equivalent, Inline, User Agent Control, or Essential. Under Spacing, an undersized target can still pass if "a 24 CSS pixel diameter circle" centered on it does not "intersect another target or the circle for another undersized target"; under Equivalent, "The function can be achieved through a different control on the same page that meets this criterion" ([Understanding 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)). **[Inference]** So the visible size of the "more" and Delete buttons does not settle conformance by itself: what is evaluated is each pointer target's area together with its spacing from neighbors (the row link, the other button), or, for the swipe-revealed Delete, whether the "more" menu's Delete is a conforming equivalent. Make the "more" button's hit area at least 24 by 24 CSS px, or space it so the 24 px circles do not overlap the row link.

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
| 16 | Rapid double-tap on Delete | One `DELETE` request, one toast (the second activation joins the first) |
| 17 | Delete, then Undo before the request returns | `restore` sent only after the `DELETE` succeeds; row back at original index. If the server rejects the `DELETE` (4xx) instead, no `restore`, row back once. If the server rejects `restore`, row stays removed with the Trash alert |
| 18 | Server rejects the delete (4xx) | Row returns at original index with an error alert; no `restore` sent |
| 19 | Delete the currently open conversation | No silent jump; focus and draft handled |
| 20 | Same conversation deleted in another tab/device | Open copy shows banner; list updates (push handling; not in the 5.3 snippet) |
| 21 | List refresh started before a delete, answered after its acknowledgement | Response discarded and refetched; row stays deleted |
| 22 | `DELETE` or `restore` gets no confirmed answer (offline, timeout, 5xx, or the server applied it and the response was lost) | The same request is repeated once and a 2xx settles the result. If the repeat is unconfirmed too or gets a 4xx (for example a 401 from the authentication layer), the row stays as shown, an alert says the result could not be confirmed, a queued Undo is not applied and the alert says so, and the next list refresh shows the server's state |
| 23 | Mouse and trackpad on desktop | No drag swipe; hover "more" button and context menu work |
| 24 | Keyboard only | Tab reaches "more"; menu operable; Escape closes; Delete works; focus lands sensibly after |
| 25 | Screen reader | Hidden delete not announced while closed; result and Undo announced |
| 26 | `prefers-reduced-motion: reduce` | No settle or collapse animation |
| 27 | Low-end phone with a long list | Drag stays smooth; no layout thrash in a performance trace |

## 11. Limits of This Research

- Apple's HIG text on swipe actions specifically could not be retrieved; swipe-action conventions rest on Apple's SwiftUI `swipeActions` reference (framework behavior, not design guidance). The HIG Gestures and Undo and redo pages were read directly.
- The NN/g pages and the Material snackbar page were reached through search summaries; Material's own swipe-to-dismiss list guidance was not retrieved.
- The iOS edge-swipe findings are developer reports on specific iOS versions and may have changed.
- Code was not run on devices. Treat the thresholds (8 px slop, 0.45 px/ms flick, 88 px reveal) as starting values.

## References

- MDN, [touch-action](https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action)
- W3C, [Pointer Events Level 3](https://www.w3.org/TR/pointerevents3/)
- MDN, [overscroll-behavior](https://developer.mozilla.org/en-US/docs/Web/CSS/overscroll-behavior)
- MDN, [Element.setPointerCapture()](https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture)
- MDN, [wheel event](https://developer.mozilla.org/en-US/docs/Web/API/Element/wheel_event)
- MDN, [prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion)
- Chrome for Developers, [Take control of your scroll: customizing pull-to-refresh and overflow effects](https://developer.chrome.com/blog/overscroll-behavior)
- W3C WAI, [Understanding SC 2.5.1 Pointer Gestures](https://www.w3.org/WAI/WCAG22/Understanding/pointer-gestures.html)
- W3C WAI, [Understanding SC 2.5.7 Dragging Movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html)
- W3C WAI, [Understanding SC 2.5.8 Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
- Apple, [Human Interface Guidelines: Gestures](https://developer.apple.com/design/human-interface-guidelines/gestures) and [Undo and redo](https://developer.apple.com/design/human-interface-guidelines/undo-and-redo)
- Apple, [SwiftUI swipeActions(edge:allowsFullSwipe:content:)](https://developer.apple.com/documentation/swiftui/view/swipeactions(edge:allowsfullswipe:content:))
- Material Design 3, [Snackbar guidelines](https://m3.material.io/components/snackbar/guidelines)
- NN/g, [Confirmation Dialogs Can Prevent User Errors](https://www.nngroup.com/articles/confirmation-dialog/); [Preventing User Errors](https://www.nngroup.com/articles/user-mistakes/)
- web.dev, [Animations guide for high performance](https://web.dev/articles/animations-guide)
- Ionic, [ion-item-sliding](https://ionicframework.com/docs/api/item-sliding)
- use-gesture, [Options](https://use-gesture.netlify.app/docs/options/)
- Playwright, [Touchscreen](https://playwright.dev/docs/api/class-touchscreen)
- Chrome DevTools Protocol, [Input domain](https://chromedevtools.github.io/devtools-protocol/tot/Input/)
- Community reports on iOS edge-swipe: [Pqina](https://pqina.nl/blog/blocking-navigation-gestures-on-ios-13-4/), [Joel Malone](https://medium.com/@joelmalone/prevent-edge-swipe-gestures-in-your-html-game-but-only-in-safari-fba815a529a2), [Ionic issue #22299](https://github.com/ionic-team/ionic-framework/issues/22299)
