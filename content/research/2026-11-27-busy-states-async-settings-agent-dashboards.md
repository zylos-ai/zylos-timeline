---
date: "2026-11-27"
title: "Busy States for Async Settings: What an Agent Dashboard Should Do While a Runtime Switch Is in Flight"
description: "How a web control panel for an always-on agent should behave while a settings change takes seconds to minutes and may fail or time out. Covers response-time limits, disabled versus aria-disabled controls, inline versus global feedback, client guards plus server idempotency, busy scope, long-running operations, unknown outcomes, server-derived busy state and multi-tab behavior."
tags: ["research", "ai-agents", "dashboards", "ux", "async-operations", "idempotency", "accessibility", "agent-runtime", "settings"]
---

## Executive Summary

A dashboard for an always-on agent has controls that behave unlike ordinary form fields. Switching the agent's runtime or model, or saving which models it uses by default, can take seconds or minutes, may restart a live process, and can fail, time out or succeed after the page has stopped listening. Consider a panel where, while a runtime switch is in flight, the buttons stay clickable, so a second submit is possible, and a single status line at the top of the page reports results far from the control that caused them. A default-settings card on the same page, with a "set as default" switch and a "save models" button, has the same exposure. This scenario is an illustration built for this article, not a report of a specific incident. The article asks what published guidance says about that situation and turns it into a playbook.

Earlier articles on this site cover stale-tab writes, "saved" versus "applied", durable pending intent and phone layouts; this one is about the interval between "the user clicked" and "the system has settled".

1. **Feedback has to start within about a second and say what is happening.** Nielsen Norman Group (NN/g) puts the limits at 0.1 s, 1 s and 10 s, and says that "without any visual change from the system, most users will assume the action was not registered and they will try again." That is the double-submit bug, described for users in general.
2. **Disabling is a fair double-submit guard, but native `disabled` is blunt.** GOV.UK says to avoid disabled buttons if possible, yet ships an opt-in double-click guard. Accessibility guidance converges on keeping a busy control focusable with `aria-disabled="true"`, blocking activation in code, and announcing the state through a live region that already exists in the page.
3. **Feedback belongs beside the control that caused it.** NN/g describes a banner far from the user's focus being missed, and users repeating the action as a result. A single status line at the top of a long panel invites exactly that.
4. **A client guard is a courtesy; the server is the guarantee.** Idempotency keys let a retry be recognized, and the server must check for conflicts and register the operation in one atomic step.
5. **Lock only the controls that conflict with the running operation.** **(inference)**
6. **For operations with real side effects, show pending, not success.** Redrawing a toggle cannot undo an agent restart.
7. **A long operation is a resource.** AIP-151 defines an operation resource the client can poll. HTTP 202 only says the request was accepted and does not guarantee anything to poll, so this article recommends pairing it with such a resource. Busy state can then come from the server and survive a reload.
8. **A timeout is not a failure.** HTTP says a client that read no response cannot know whether the request was applied. Keep the intent's idempotency key, and the operation ID once known, and resolve the outcome from them: read the operation's record by ID, or resend with the same key. An empty list of running operations plus an unchanged runtime proves nothing. Until resolved, say "outcome unknown" and offer a way to check again.

Sections 1 and 2 cover the UX evidence and the engineering, section 3 a worked example in generic terms, section 4 failure modes, section 5 a checklist. Statements of my own reasoning are labelled **(inference)**; claims I could not verify are left out and listed at the end.

## 1. What the usability and accessibility sources say

### 1.1 Three time limits, and what each demands

Jakob Nielsen's response-time page, an excerpt from his 1993 book chapter with a section for web applications added in 2014, gives the limits that every later guide cites ([NN/g: Response Times: The 3 Important Limits](https://www.nngroup.com/articles/response-times-3-important-limits/)).

- **0.1 second** is "about the limit for having the user feel that the system is reacting instantaneously", and "no special feedback is necessary except to display the result".
- **1.0 second** is "about the limit for the user's flow of thought to stay uninterrupted", although the user will notice the delay. The 2014 text adds: "For delays of more than 1 second, indicate to the user that the computer is working on the problem."
- **10 seconds** is "about the limit for keeping the user's attention focused on the dialogue". Anything slower, per the 2014 text, "needs a percent-done indicator" and should offer "a clearly signposted way for the user to interrupt the operation".

NN/g's later article on progress indicators makes the same cut-offs concrete: use a progress indicator for any action that takes longer than about a second, use a looped indicator for waits of about 2 to 10 seconds, and use a percent-done indicator for 10 seconds or more. It also says that when timing is uncertain, "the bigger the variability in your estimates, the lower the threshold for showing the more elaborate feedback." It cites a study in which users who saw a moving bar waited on average three times longer than those who saw none ([NN/g: Progress Indicators](https://www.nngroup.com/articles/progress-indicators/)). The first heuristic in NN/g's list, "Visibility of System Status", asks for "appropriate feedback within a reasonable amount of time" ([NN/g: 10 Usability Heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/)).

What does this imply for a runtime switch? **(inference)** The operation straddles the thresholds. A default saved to a database may finish well under a second and needs only a visible result. A runtime switch that stops one process and starts another sits in the "seconds to minutes" range, where a looped spinner is acceptable at first and not for long. A percent-done bar is usually impossible, because nobody knows what fraction of a process start is complete. Nielsen's 1993 text covers this case: if the total work is unknown, running feedback in terms of work done is still possible. For a switch that means naming the step ("stopping the current session", "starting the new one", "waiting for it to report ready"), which the server can supply through the operation resource in section 2.4.

### 1.2 Immediate acknowledgement prevents repeat clicks

The most useful single sentence in this literature for our problem comes from the progress indicators article: "Without any visual change from the system, most users will assume the action was not registered and they will try again." GOV.UK's button page lists causes: habits from operating systems where double clicking is the norm, slow connections that delay feedback, and users who "have motor impairments such as hand tremors which cause them to click the button involuntarily". Its example: "the GOV.UK Notify team discovered that a number of users were receiving invitations twice" ([GOV.UK Design System: Button](https://design-system.service.gov.uk/components/button/)).

The page offers an opt-in `data-prevent-double-click="true"` attribute that makes the button ignore the second click. Its caveats matter more than the feature: it works only with JavaScript, "you should also think about the issue server-side to protect against attacks", and for slow connections the team should first show what is happening, such as a spinner or modal. The order is information first, guard second, server enforcement as well.

### 1.3 Disabled buttons: the critique, and the one use everyone allows

The same GOV.UK page states a position on disabled buttons: "Disabled buttons have poor contrast and can confuse some users, so avoid them if possible", and "only use disabled buttons if research shows it makes the user interface easier to understand."

Smashing Magazine's article on disabled buttons collects the usual objections ([Smashing Magazine: Frustrating Design Patterns: Disabled Buttons](https://www.smashingmagazine.com/2021/08/frustrating-design-patterns-disabled-buttons/)). Disabled buttons do not explain what is wrong, so users hit a wall and guess; citing Adam Silver, it says they are usually not focusable, so keyboard users cannot reach them, and they "suffer from insufficient contrast". It also lists acceptable uses, and one is ours: preventing double submissions such as payments or bookings, ideally with a label like "Adding to cart..." and a spinner.

So the critique is aimed at buttons disabled for unexplained reasons, typically form validation. A button disabled because its own operation is running has a complete explanation, and it should be stated on the button. **(inference)** Two parts of the critique still apply: the explanation must be visible (a label change, not just a grey fill), and the disabled state must not outlast the operation (section 4).

### 1.4 `disabled`, `aria-disabled`, `aria-busy` and live regions

Four attributes get confused here, and they do different jobs.

**`disabled`.** The native attribute "will communicate a form control as semantically being disabled, change its styling to reflect its state and suppress all functionality" ([MDN: aria-disabled](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-disabled)). It also removes the control from the tab order, the root of the discoverability complaints.

**`aria-disabled="true"`.** It "only semantically exposes these elements as being disabled" and does not change focusability. MDN's consequence: "Web developers must manually ensure such elements have their functionality suppressed when exposed to the disabled state." It also warns that `pointer-events: none` "prevents mouse clicks, but does not prevent the element from being activated via the keyboard", and that the disabled styling, including forced-colors mode, is the author's job.

The WAI-ARIA Authoring Practices frame the trade-off ([W3C APG: Developing a Keyboard Interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)). Skipping disabled elements "usually reduces the number of key presses required to complete a task", but "screen reader users are far less likely to discover disabled elements that are not focusable". Use native `disabled` when users can infer the element from its neighbors (a "Previous" button next to "Next"), and keep it focusable with `aria-disabled="true"` when it "does need to remain discoverable".

One design system's loading-button guidance is the closest match ([Primer: Button accessibility](https://primer.style/product/components/button/accessibility/)). For loading buttons, "don't remove them from the DOM or add `disabled` to avoid disrupting focus and keyboard navigation"; use `aria-disabled="true"` instead, with a hidden `aria-live="polite"` region carrying a message such as "Saving profile". Two details are worth copying: "the live region must be present on page load", and the message should be rendered only while the button is loading. On failure it says to move focus to a heading in the error banner.

**`aria-busy`.** MDN calls it "a global ARIA state that indicates whether an element is currently being modified", telling assistive technologies "they may want to wait before informing users of the update"; it is mostly used to hold live-region announcements until several updates finish, and script must reset it ([MDN: aria-busy](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-busy)). The wording is advisory and the page says nothing about blocking clicks or focus. **(inference)** It describes a region that is changing; it is not a lock. Use it on the region being replaced and use an activation guard to stop clicks.

**Live regions and `role="status"`.** A `status` element has an implicit `aria-live` of `polite` and `aria-atomic` of `true`, and MDN says not to give it focus on update ([MDN: status role](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/status_role)). The live regions guide adds the timing rule that makes many implementations fail silently: "Establish the live region before updating its content", and "the most reliable way to ensure that live regions are registered is to include them in the initial markup." It also says behavior varies across browser and assistive technology combinations ([MDN: ARIA live regions](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Guides/Live_regions)).

WCAG 2.2 success criterion 4.1.3 (Status Messages) is the normative hook. Its understanding document says status messages must be presentable "without receiving focus", gives a busy indicator example (the screen reader says "application busy"), and notes that when a busy message disappears, sighted users can tell the system is ready but screen reader users cannot, so a message such as "system available" is needed ([W3C: Understanding SC 4.1.3](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)). **(inference)** A switch that ends in an error needs the failure announced, not just "switching" removed.

The HTML `inert` attribute removes a subtree from clicks, focus, find-in-page and the accessibility tree. MDN recommends it for whole sections and `disabled` for individual controls, and warns that by default there is no visual way to tell that a subtree is inert ([MDN: inert](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/inert)). **(inference)** Making a whole panel inert during one operation also hides its explanations from screen readers, which argues for locking only what conflicts (section 2.2).

### 1.5 Where the result should appear: beside the control, not at the top of the page

NN/g's article on indicators and notifications says that indicators "are associated with a UI element or with a piece of content, and should be shown in close proximity to that element." It then describes the failure that a global status line invites ([NN/g: Indicators, Validations, and Notifications](https://www.nngroup.com/articles/indicators-validations-notifications/)).

- "Passive notifications can easily be missed, since they require no user action."
- In an e-commerce case, shoppers did not notice a confirmation "due to its location far away from the user's area of focus at the time", and "users who miss the message may respond by adding an item to the cart multiple times."
- A toast "while appropriate for passive notifications, would be a bad way to implement an error message", and the article's example is a participant who missed a message at the bottom of the screen that faded in 5 seconds.

The last two points match the panel described in the summary. A result line at the top of a long panel is far from a button lower down, and a message that auto-hides cannot be recovered by a user who looked away. The cart example is the double-submit bug: the user missed the feedback, so they repeated the action.

NN/g's error-message guidance says to "display the error message close to the error's source" and to "preserve the user's input" ([NN/g: Error-Message Guidelines](https://www.nngroup.com/articles/error-message-guidelines/)). GOV.UK's notification banner guidance is the counterweight. A banner is for something "not directly related to the page content", such as a service-wide issue or the outcome of an earlier action on a previous page, and "if the information is directly relevant to the thing the user is doing on that page, put the information in the main page content instead"; use banners sparingly, at most one per page ([GOV.UK Design System: Notification banner](https://design-system.service.gov.uk/components/notification-banner/)). **(inference)** Global banners fit events the user's click did not cause, such as the agent having been restarted by something else. The result of the user's own click is not that.

## 2. Engineering the busy state

### 2.1 Two layers: the client guard and the server guarantee

A disabled or `aria-disabled` button stops one kind of duplicate: the second click on the same render. It does not stop a retry after a network error, a refresh, a second tab or a script. **(inference)** The button guard is for the user; the idempotency mechanism is for correctness.

Stripe's documentation is the clearest public description of the server half ([Stripe: Idempotent requests](https://docs.stripe.com/api/idempotent_requests); [Stripe: Advanced error handling](https://docs.stripe.com/error-low-level)). The client generates a unique key and sends it in an `Idempotency-Key` header. For Stripe's v1 API, the server "saves the status code and body of the first request made with a given idempotency key after endpoint execution begins", and retries with the same key return the saved response, including `500` errors. Several details carry over to a settings API:

- Keys are compared with the original request's parameters, and a mismatch is an error.
- Results are saved only once execution begins; a request that fails validation, or conflicts with one still executing, saves nothing and can be retried.
- The `409` guidance is conditional: "If a 409 indicates that another request with the same key is still executing, wait and retry with that key and the same parameters. A new key can start a second operation." A `409` can also mean other conflicts (Stripe's status table: "The request conflicts with another request, potentially due to using the same idempotent key"), and this article also uses `409` for a different operation holding a lock (section 2.2), so a client has to tell the two cases apart.
- Keys can be random (UUID v4) or derived "from a user-attached object, like the ID of a shopping cart", which "provides a relatively straightforward way to protect against double submissions."
- If a client retries across separate calls or process restarts, it should "generate and persist a key for the operation and supply it to every attempt."

An IETF Internet-Draft, `draft-ietf-httpapi-idempotency-key-header` (version -09 when I read it; active, not an RFC), standardizes the header for POST and PATCH ([IETF datatracker](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)). The key must be unique and not reused with a different payload; a missing key where one is required should get a 400, a retry while the original is processing a 409, and a reused key with a different payload a 422 (when the server fingerprints payloads). I cite it for the shape of the contract, not as a settled standard.

For a settings call, mint the key when the user confirms, the persist-then-send discipline from an earlier article on durable user intent. **(inference)** When the operation is "make the system state X", the server can also dedupe without a header: compare the requested target with the current state and the in-flight operation, and answer a duplicate "switch to X" with the existing operation. That is the server deciding, in its response to this request, which operation carries it, which is different from a client guessing from a matching runtime (section 2.5). RFC 9110 defines an idempotent method by its intended effect: "the intended effect on the server of multiple identical requests with that method is the same as the effect for a single such request" ([RFC 9110, section 9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2)). "Set default to X" fits if the handler is a set, not a toggle. "Restart" does not, unless the server defines what a second request means while the first runs.

### 2.2 Busy scope: per control, per group, per panel

The panel in the summary raises a scope question. Which controls should go busy when one starts an operation? Three choices exist.

- **Per control.** Only the button that was clicked is busy. This is the minimum, and it stops the double submit. It leaves other controls free to start conflicting operations.
- **Per panel.** Everything in the panel is locked. It is simple and safe, but it blocks things the user can legitimately do, and it hides more of the interface from screen reader users if done with `inert` (section 1.4).
- **Per conflict group.** Each operation declares which others it conflicts with; the UI locks exactly those. The unrelated controls stay live.

**(inference)** The third choice matches what the user needs. Lock a control only if starting its action now would (a) duplicate the running operation, or (b) read or write state the running operation is about to change. Switching the model while the runtime is being replaced writes into a process about to disappear; a write that only changes a stored default does not need to wait for a running switch.

A small client-side structure makes the conflict rule executable. A runtime switch locks itself; the two default-settings controls lock each other because the switch reads the model list being saved; unrelated groups stay free.

```ts
type Scope = "runtime-switch" | "default-switch" | "default-models";

// Each running operation locks itself and whatever it conflicts with.
const conflictsWith: Record<Scope, Scope[]> = {
  "runtime-switch": ["runtime-switch"],
  "default-switch": ["default-switch", "default-models"],
  "default-models": ["default-models", "default-switch"],
};

function isLocked(scope: Scope, running: Set<Scope>): boolean {
  for (const r of running) {
    if (conflictsWith[r].includes(scope)) return true;
  }
  return false;
}
```

The same predicate should run on the server. A request that conflicts with a running operation gets an explicit refusal (a 409 is the natural code; AIP-151 says a resource that does not allow parallel operations "must return `ABORTED`", the gRPC-style equivalent). The client-side lock then becomes an optimization that avoids sending requests that will be refused, and the server rule is what holds when two tabs race.

The server's check and the registration of the new operation have to be one atomic step. **(inference)** If the handler first asks whether a conflicting operation is running and then inserts the new one, two requests that arrive together can both pass the check before either inserts, and both start. Doing both in one transaction guarded by a unique constraint (for example one lock row per conflict group, and a unique index on the idempotency key) makes the second insert fail, and that failure becomes the `409`. The same step should look up the key first, so a replay of an accepted key gets its own operation back instead of a conflict with itself, and it can record a refusal under the key, so a delayed copy of a refused request gets the same refusal instead of starting later. The `409` body should say which case applies: this key's own request still in flight, or a different operation holding the lock, named in the body.

A related rule from the earlier article on durable user intent applies here as well: **busy must never remove the way out.** If "cancel" or "end" is disabled by the same flag as "start", a stuck operation welds the whole panel shut. The conflict table should be written with escape hatches in mind, and every busy state needs a timeout path (section 2.5).

### 2.3 Pessimistic for side effects, optimistic only when it can be undone

An optimistic update shows the new state at once and corrects it later if the server disagrees. TanStack Query's documentation describes two ways to do that, and the difference is relevant ([TanStack Query: Optimistic Updates](https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates)). The UI-variable approach shows the pending value, for example with a different opacity while the mutation is pending, and "you don't need to handle rollbacks at all." The cache approach writes the new value into shared state, snapshots the old one, and rolls back on error. In both, the documentation's examples refetch on settle ("Always refetch after error or success"), because the client's guess is never final.

For a settings toggle that only edits a stored value, this is fine. For a runtime switch, **(inference)** it is not. Redrawing the current-runtime label as the new runtime before the process has started claims a fact that is not yet true and may never be. If the start fails, rolling the label back does not undo a stop of the previous session, a lost conversation state, or a half-written config. The honest display for an operation with side effects is three states, not two: the confirmed current state, a pending target, and the final outcome. The default-settings card can use the optimistic approach for simple edits, and it should still show saving state for the save, since persistence can fail.

A middle path from the same page: show the pending value from the mutation's variables beside the confirmed value, not in place of it. Variables "are not cleared when the mutation errors", so a failed attempt can offer a retry without retyping.

### 2.4 Long-running operations are resources

When an operation takes seconds to minutes, holding one HTTP request open and calling that "busy" ties the truth about the operation to one connection. AIP-151 defines a resource that breaks that tie; HTTP 202 only points toward one.

**AIP-151.** Google's API Improvement Proposal on long-running operations says slow methods should return an `Operation` object instead of the final response, and adds that "a good rule of thumb is 10 seconds" for what counts as slow ([AIP-151](https://google.aip.dev/151)). The `Operation` resource has a name that the client can poll, a `done` flag, a metadata type used "to provide information such as progress, partial failures, and similar information", and, on failure, an error in `Operation.error`. Errors that prevent the operation from starting are returned directly; failures during execution go in the operation. The page gives a 30-day rule of thumb for operation expiry, so a finished operation stays readable for a while. **(inference)** On a dashboard the name is what the UI holds, `done` decides whether the control is busy, metadata supplies the step label and `error` the message beside the control.

**HTTP 202.** The status means the request "has been accepted for processing, but processing has not been completed or may not have started", and MDN adds that "the actual processing of the request is not guaranteed; a task or action may fail or be disallowed when a server tries to process it." It is also "non-committal": the HTTP response cannot be followed by a later asynchronous response with the outcome. The page's example response includes a `monitorUrl` the client can use to follow the task ([MDN: 202 Accepted](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/202)). RFC 9110 says the 202 response "is intentionally noncommittal" and that its representation "ought to describe the request's current status and point to (or embed) a status monitor" ([RFC 9110, section 15.3.3](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.3.3)). "Ought to" is not a guarantee: a 202 by itself promises nothing the client can poll. **(inference)** The pattern this article recommends for a dashboard is a 202 that carries an operation resource in the AIP-151 style, as below.

A minimal shape for an agent runtime's settings API, adapted from those sources and from the idempotency contract in section 2.1 **(inference)**:

```ts
type OperationState = "pending" | "running" | "succeeded" | "failed";

interface Operation {
  id: string;                 // what the UI holds and polls
  kind: "runtime-switch" | "default-models" | "default-switch";
  target: unknown;            // what was asked for
  state: OperationState;      // done == succeeded | failed
  step?: string;              // "starting new session", for the busy label
  error?: { code: string; message: string };
  startedAt: string;
  finishedAt?: string;
}

// POST /settings/runtime, Idempotency-Key: K -> 202 Operation
//   same K again  -> the same Operation, never a second one
//   409 { code: "same-key-in-flight", operation? }
//   409 { code: "operation-conflict", operation }  // lock holder
// GET  /operations/:id  -> Operation, retained after it ends
// GET  /operations?state=pending,running  -> Operation[]
```

The third route is the one most often forgotten. It is what lets a freshly loaded page ask "is anything running?" (section 2.6).

### 2.5 Timeouts and the unknown outcome

A client-side timeout means the client stopped waiting, not that the server stopped working. RFC 9110 says idempotent methods are distinguished because a request "can be repeated automatically if a communication failure occurs before the client is able to read the server's response", and warns in the other direction: "a client SHOULD NOT automatically retry a request with a non-idempotent method unless it has some means to know that the request semantics are actually idempotent, regardless of the method, or some means to detect that the original request was never applied." ([RFC 9110, section 9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2)). The same section describes a client recovering from partial failure "by checking the target resource revision(s) after a failed connection". **(inference)** That works for a version-control client because a revision identifies whose write it was. A snapshot of which runtime is active does not.

Stripe gives the operational version. Network errors, it says, leave the client unable to know "whether Stripe received or executed the request", and "restoring connectivity doesn't tell you whether the original request succeeded." Its instruction is to "retry with the same idempotency key and parameters within the first 24 hours after the original request." The outcome of a `500` is "indeterminate: the operation might have produced side effects even though you received an error"; the instruction is not to start a new operation with a new key until the original outcome is resolved, by retrieving the object and reconciling. Keys expire: Stripe retains them "for at least 24 hours", and "reusing a key after it's removed can execute a new request", so "if the outcome is still unknown after that window, don't retry with either the old key or a new one" ([Stripe: Advanced error handling](https://docs.stripe.com/error-low-level)). A `504` means a gateway did not receive a timely upstream response ([RFC 9110, section 15.6.5](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.6.5)); **(inference)** that says nothing about whether upstream later acted.

**(inference)** For a dashboard this yields a fourth operation outcome beyond succeeded, failed and running: **unknown**. The UI should enter it on any of: the request timed out; the connection dropped before a response; the server answered 5xx without a structured operation error; the operation's status could not be read. The operation resolves it, not a guess from the surrounding state:

- The client creates the intent and its key before the first send and saves them where a reload can find them. Once the server names the operation, it saves the operation ID too.
- With an operation ID, the client reads that operation's retained record and acts on its terminal state.
- If the submit's response was lost, so there is no ID, the client sends the same request again with the same key. Under the idempotency contract the server answers with the operation that key already started, or starts it once if the first request never arrived. A delayed copy of the first request then finds the key taken and starts nothing, provided the server checks the key atomically (section 2.2).
- An empty list of running operations plus a runtime still on the old value proves nothing. The first request may not be registered yet and can still apply; an operation can finish between the two reads; a runtime that matches the target may have been switched by another client. The live runtime read is for showing what is active now, not for deciding this intent's outcome.
- If the status cannot be read (a `404` for the ID, a network error, a 5xx), the outcome stays unknown. Stop the spinner, say so beside the control, and offer "Check again". Do not show a failure.
- A terminal error in the operation record is shown beside the control, and the busy state is cleared.

When is it safe to send the same key again, and when is a new attempt warranted? **(inference)**

- **Same key:** whenever the outcome is unknown and the key is within the server's retention window, with identical parameters. That is what the key is for. The dashboard can use a shorter replay window than the server's retention, because a switch requested hours ago may no longer be wanted.
- **New key:** only after a confirmed terminal outcome for the old one: a `4xx` that refused the request before it started, a conflict refusal, or an operation record in state `failed`. A new key means a new operation, so it follows a fresh user action, not an automatic retry.
- **Key expired, outcome still unknown:** never replay it, since the server may run it as a new request. If the operation ID is known, its record may still be readable, because operations can outlive keys (AIP-151's rule of thumb for operation expiry is 30 days). If not, the outcome stays unknown: tell the user, re-read and show the live runtime, and offer a fresh attempt only as an explicit choice made after seeing it.

The flow below applies these rules. The helpers it calls (intent storage, `post`, `get`, `sleep`, `setBusy`, `showOutcome`, `showActive`, `watchOperation`) are left abstract. `post` sends the key in an `Idempotency-Key` header and throws an error with `status` and `body` on an HTTP error, or without `status` on a timeout or network failure. `showOutcome` replaces the busy label with the outcome beside the control; `showActive` reads and displays the live runtime.

```ts
// Intent, saved so a reload can resume it:
// { kind, target, key, createdAt, opId? }
async function submitSwitch(target) {
  const intent = loadOrCreateIntent("runtime-switch", target);
  setBusy(intent.kind, "Starting switch…");
  return submit(intent, false);
}

async function submit(intent, isReplay) {
  let op;
  try {
    op = await post("/settings/runtime",
      { target: intent.target }, intent.key);  // same key every time
  } catch (e) {
    if (e.status === 409) return onConflict(intent, e.body, isReplay);
    if (e.status >= 400 && e.status < 500)     // refused, never started
      return finish(intent, "rejected", e.body);
    // Timeout, dropped connection or 5xx: outcome unknown.
    return isReplay ? unresolved(intent) : reconcile(intent);
  }
  intent.opId = op.id;
  saveIntent(intent);
  return follow(intent);
}

async function onConflict(intent, body, isReplay) {
  if (body.code === "same-key-in-flight") {    // our own request
    if (body.operation) {
      intent.opId = body.operation.id;
      saveIntent(intent);
      return follow(intent);
    }
    if (isReplay) return unresolved(intent);   // one automatic retry only
    await sleep(RETRY_MS);
    return submit(intent, true);               // same key and parameters
  }
  // "operation-conflict": another operation holds the lock;
  // ours never started.
  finish(intent, "refused", body.operation);
  return watchOperation(body.operation);       // lock until it ends
}

async function follow(intent) {
  for (;;) {
    let op;
    try {
      op = await get(`/operations/${intent.opId}`); // retained record
    } catch (e) {
      return unresolved(intent);               // 404, network or 5xx
    }
    if (op.state === "succeeded") return finish(intent, "succeeded");
    if (op.state === "failed") return finish(intent, "failed", op.error);
    setBusy(intent.kind, op.step || "Switching…");
    await sleep(POLL_MS);
  }
}

async function reconcile(intent) {
  setBusy(intent.kind, "Outcome unknown, checking…");
  if (intent.opId) return follow(intent);
  if (Date.now() - intent.createdAt < REPLAY_WINDOW_MS)
    return submit(intent, true);  // existing operation, or starts once
  return unresolved(intent, "key-expired");
}

function finish(intent, outcome, detail) {
  clearIntent(intent);          // key retired; a new attempt needs a new key
  showOutcome(intent.kind, outcome, detail);
  return showActive();          // live runtime, display only
}

function unresolved(intent, reason) {
  // Key and opId stay saved; no failure is claimed.
  showOutcome(intent.kind, "unknown", reason,
    () => reconcile(intent));   // the "Check again" action
  return showActive();
}
```

Every branch ends with the busy label replaced: by a result, by a stated refusal while the other operation is followed, or by "outcome unknown" with "Check again". A `4xx` other than `409` is treated as final only because, as AIP-151 puts it, "errors that prevent a long-running operation from starting must return an error response", while failures during execution go in the operation record. While an intent is unresolved, the control offers "Check again" rather than a fresh start; a different target or a new attempt waits until the intent resolves or the user, having seen the live runtime, chooses to start over.

The live read must report the applied state, not the stored setting; an earlier article on this site covers why "saved" and "applied" differ in a long-running runtime.

### 2.6 Busy state belongs to the server, not to one tab's memory

A busy flag in component state is wrong after a page reload, a restored or discarded tab, or a reconnect after sleep. The operation is still running and the page has forgotten it, so the user sees an enabled "switch runtime" button mid-switch, and only the server rule from section 2.2 prevents a double start.

The fix is cheap if the API from section 2.4 exists: derive busy from the server.

- On load and on every reconnect of the realtime channel, fetch the non-terminal operations and render busy from them.
- Keep following each by polling or events; treat events as hints to re-fetch, since a missed event leaves the UI stuck.
- Treat the local flag as a cache of the server's answer. It may cover the short gap before the operation exists; the server's operation then replaces it.
- On load, pick up any saved intent that has not resolved and resolve it as in section 2.5, by its operation ID or by its key.

The Page Visibility API gives a natural trigger. The `visibilitychange` event fires when the user switches tabs, minimizes the browser or, on mobile, switches apps ([MDN: visibilitychange](https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilitychange_event)). **(inference)** Re-reading the operation list when the document becomes visible again closes most of the gap that a sleeping tab leaves. MDN says the `hidden` transition is also a good point to stop making UI updates, which supports pausing polling while hidden and resuming with a re-read.

**(inference)** Keep an unacknowledged failure displayed until the user dismisses or retries it, rather than fading it; NN/g's 5-second fade example is the case to avoid.

### 2.7 Multiple tabs and multiple clients

Two tabs of the same dashboard, or the dashboard and a command-line client, can start operations at the same time. If busy state comes from the server (section 2.6), the second tab discovers the first tab's operation on its next read, and the server's conflict rule refuses a conflicting start in the meantime. What remains is making the second tab feel current, and that is a convenience, not a correctness mechanism.

The browser's `BroadcastChannel` lets same-origin tabs and windows exchange messages, and the sender does not receive its own message ([MDN: BroadcastChannel](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel)). The page mentions nothing about delivery guarantees or ordering, so **(inference)** it is appropriate for telling other tabs "an operation just started, re-read now" and unsuitable as the only place the busy state lives. It also does not cross browsers, devices or a CLI. The server remains the single place that knows. Stale clients writing after the read shape changes are covered in an earlier article on this site, and the same precondition techniques apply when two clients edit the same default list.

What the second tab should show is the same as the first: the step label beside the affected control, locked by the same conflict table. A discreet "started from another window" note helps the user who forgot a tab. **(inference)**

## 3. Worked example: a runtime switch and a defaults card

**Runtime switch.** Within 100 ms of activation the control shows "Switching to the new runtime...", is `aria-disabled`, keeps focus, and the same text goes into a polite live region from the initial markup. The client persists an intent with a key and posts; the server returns 202 with an operation id, which the client saves (a replay of the same key gets the same operation back). The label follows the operation's step beside the control, with no global line. A second target for the same switch is locked with a short reason; unrelated controls stay usable. On a timeout the control shows "outcome unknown, checking" and resends with the same key, or reads the operation by its id if it has one; if neither answers, it says the outcome is unknown and offers "Check again", with the live runtime shown beside it. A `409` naming another operation shows that operation's step and keeps the control locked until it ends. A failed operation shows its error beside the control. A reload mid-switch restores the busy state from the server's list of non-terminal operations.

**Defaults card.** The "set as default" switch and the "save models" button share a conflict group, because the switch's meaning depends on the saved model list. **(inference)** Both are usually quick, so the treatment stays light: a spinner and `aria-disabled` for the request, a "Saved" result beside the button, no toast. After an unknown outcome the card shows what is stored and keeps the typed values for a retry. If the switch moves optimistically and the write fails, it must move back with a reason beside it. **(inference)**

## 4. Failure modes

Each is named in a source above or follows from combining them.

1. **Buttons stay clickable during a slow operation.** Users repeat the action when no visible change follows the click. Answer: immediate acknowledgement, an activation guard, and the server rule.
2. **Client guard only.** It stops one render's second click, not a retry after a drop, a refresh, a second tab or a script. Answer: idempotency key or operation-level dedupe.
3. **Global status line far from the control.** The result is missed and users repeat the action. Answer: inline result; banners only for events this control did not cause.
4. **Auto-fading results and errors.** A user who looked away loses the information. Answer: errors persist until acknowledged or retried.
5. **Native `disabled` on a busy control.** It leaves the tab order and focus can be lost. Answer: `aria-disabled` with guarded handlers.
6. **`aria-disabled` without a guard.** The click still fires. Answer: block mouse and keyboard activation in code and test with the keyboard.
7. **Live region created at the moment of the message, or busy text that just disappears.** The announcement may be dropped, and screen reader users get no "available" signal. Answer: region in the initial markup; replace busy text with an outcome message.
8. **Timeout shown as failure.** The change may have been applied; the user retries and double applies. Answer: the unknown state and a reconcile step.
9. **Failure inferred from surrounding state.** An empty running list and an unchanged runtime are read as "not applied", yet the original request can still register and apply; an operation can finish between the two reads, and a matching runtime may come from another client. Answer: resolve by operation ID or by resending the same key; use the live runtime only to show what is active.
10. **Error branches that escape the UI.** A shared catch treats every `4xx` as final or rethrows, or a failed status read is not handled, and "Starting switch…" stays on screen. Answer: handle each `409` case, show terminal operation errors beside the control, turn unreadable status into "unknown" with "Check again", and replace the busy label in every branch.
11. **Optimistic display of a side-effecting operation.** The UI claims the new runtime is active; rolling back a label does not roll back the effect. Answer: show confirmed state, pending target and outcome separately.
12. **Busy state in local memory only.** A reload or second tab shows an enabled control mid-operation. Answer: derive busy from server operations on load, reconnect and visibility change.
13. **A busy flag that never clears.** The panel, and anything else gated by that flag, stays stuck. Answer: a server-side terminal state for every operation, a "taking longer than expected" state with a re-read, and an escape route the flag never locks.
14. **Panel-wide locks, especially with `inert`.** Controls the user needs are blocked and the panel leaves the accessibility tree. Answer: conflict groups.
15. **Wrong key discipline.** Reusing a key for a different request is refused by a payload-comparing server; a fresh key per retry defeats the mechanism; replaying a key the server has already dropped can start a new operation. Answer: one persisted key per user intent, a new key only after a confirmed terminal outcome, and no replay past the retention window.
16. **Conflicting writes from two tabs.** Both pass their client guards, and a server that checks for conflicts before registering the operation in a separate step lets both through. Answer: conflict check and registration in one atomic step, and a re-read on refusal.
17. **Success claimed from the stored setting.** The save worked but the running process has not picked it up. Answer: report the applied state from the live source.

## 5. A playbook for agent dashboards

**Operations and API**

- [ ] Classify each settings action: instant write, short write (under about a second) or long-running (side effects on a live process). The class decides the busy treatment.
- [ ] Long-running actions return 202 (or equivalent) with an operation resource: id, state, step, structured error, retained for a defined period.
- [ ] A list endpoint returns non-terminal operations, so a page can learn what is running without knowing an id.
- [ ] Every operation reaches a terminal state on the server, including after a worker crash or timeout.
- [ ] The server refuses a conflicting start explicitly (409 or equivalent), names the running operation, and says whether it is this key's own request still in flight or a different operation.
- [ ] Mutating endpoints accept an idempotency key; a replay of the same key returns the operation it started, never a second one.
- [ ] Key lookup, conflict check and registration happen in one atomic step (one transaction with a unique constraint), so two concurrent requests cannot both pass the check.

**Client state**

- [ ] Busy is derived from server operations on load, reconnect and when the page becomes visible; local flags only cover the gap before the operation exists.
- [ ] A conflict table decides which controls lock; the server enforces the same table.
- [ ] One idempotency key per user intent, persisted before the first send and reused on retries; the operation ID is persisted as soon as it is known. A new key only after a confirmed terminal outcome; a key past the server's retention window is never replayed.
- [ ] Timeouts, dropped connections and unstructured 5xx mean outcome unknown. Resolve by reading the operation by ID or resending the same key, never from an empty running list plus the live runtime. Status that cannot be read stays "unknown" with a "Check again" action.
- [ ] Every branch, including `409`, `404` and failed status reads, replaces the busy label with a stated outcome; terminal operation errors appear beside the control.
- [ ] Optimistic updates only where a wrong guess is harmless and reversible.

**Presentation and accessibility**

- [ ] Within about 0.1 to 1 second the control shows the click was received.
- [ ] Busy controls stay focusable (`aria-disabled="true"`), with activation blocked in code, a visible style that survives forced-colors mode, and focus kept in place.
- [ ] A polite live region exists in the initial markup; the busy message is rendered only while it applies; the outcome replaces it. `aria-busy` marks a region being replaced and is not a lock.
- [ ] Results appear next to the control. Errors persist until acknowledged or retried and keep the user's input.
- [ ] Beyond about 10 seconds, show named steps or elapsed time and a way out; no fake percentage.
- [ ] Global banners are for events not caused by the control just used. Busy never disables the way out of a stuck operation.

**Checks worth automating**

- [ ] Double click and double Enter create exactly one operation; a reload mid-operation returns the control to busy; a response lost after the server applied the change ends in "succeeded"; a submit that times out before the server registers it ends in one operation, not a "failed" message; a `409` and a status `404` each leave the control in a stated state; two clients starting conflicting operations get one refusal and the same busy display.

## Limits of this analysis

- **The opening scenario is illustrative.** The panel in the summary is a composite used to frame the question, not a documented incident.
- **No measurements of my own.** I did not time a real runtime switch or measure double-click rates. Thresholds come from NN/g; the application to agent runtimes is my reasoning, labelled where it appears.
- **The sources are general-purpose.** GOV.UK, Stripe, Google and NN/g write about public services, payments, cloud APIs and general interfaces, so the mapping to a runtime switch is an analogy.
- **Assistive-technology behavior varies.** MDN says live-region behavior differs across browser and assistive technology combinations. Any implementation needs testing with real screen readers; none of the sources here replace that.
- **An IETF draft is not a standard.** The idempotency header draft was at version -09 and active when I read it, and may change or lapse.
- **Items I could not verify and left out.** I did not cite specific statistics on how often double submits happen, any claim about how screen readers announce `aria-busy` on a button in particular, and any claim about the exact browser support of `inert` beyond what MDN's page states.

## Sources

- Jakob Nielsen / NN/g. "Response Times: The 3 Important Limits." https://www.nngroup.com/articles/response-times-3-important-limits/
- NN/g. "Progress Indicators Make a Slow System Less Insufferable." https://www.nngroup.com/articles/progress-indicators/
- NN/g. "10 Usability Heuristics for User Interface Design." https://www.nngroup.com/articles/ten-usability-heuristics/
- NN/g. "Indicators, Validations, and Notifications: Pick the Best Messaging Option." https://www.nngroup.com/articles/indicators-validations-notifications/
- NN/g. "Error-Message Guidelines." https://www.nngroup.com/articles/error-message-guidelines/
- GOV.UK Design System. "Button" (preventing double clicks; disabled buttons). https://design-system.service.gov.uk/components/button/
- GOV.UK Design System. "Notification banner." https://design-system.service.gov.uk/components/notification-banner/
- Smashing Magazine. "Frustrating Design Patterns: Disabled Buttons." https://www.smashingmagazine.com/2021/08/frustrating-design-patterns-disabled-buttons/
- MDN. "aria-disabled." https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-disabled
- MDN. "aria-busy." https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-busy
- MDN. "ARIA: status role." https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/status_role
- MDN. "ARIA live regions." https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Guides/Live_regions
- MDN. "inert." https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/inert
- MDN. "Document: visibilitychange event." https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilitychange_event
- MDN. "BroadcastChannel." https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel
- MDN. "202 Accepted." https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/202
- W3C. "Understanding Success Criterion 4.1.3: Status Messages" (WCAG 2.2). https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html
- W3C. "ARIA Authoring Practices Guide: Developing a Keyboard Interface" (focusability of disabled controls). https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/
- Primer (GitHub). "Button accessibility" (loading and inactive buttons). https://primer.style/product/components/button/accessibility/
- Stripe. "Idempotent requests." https://docs.stripe.com/api/idempotent_requests
- Stripe. "Advanced error handling." https://docs.stripe.com/error-low-level
- IETF HTTPAPI working group. "The Idempotency-Key HTTP Header Field" (Internet-Draft). https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/
- IETF. RFC 9110, "HTTP Semantics", sections 9.2.2 and 15.6.5. https://www.rfc-editor.org/rfc/rfc9110.html
- Google. AIP-151, "Long-running operations." https://google.aip.dev/151
- TanStack Query. "Optimistic Updates." https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates
