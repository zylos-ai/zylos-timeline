---
date: "2026-09-30"
title: "Modules Are Not Processes: Keeping Logical Decomposition and Runtime Placement Apart"
description: "A design doc used module names as sentence subjects until a reviewer asked why every module read like its own process. The fix, the architecture-literature background for it, a review checklist, and a small script that catches the mistake automatically."
tags: ["software-architecture", "documentation", "ai-agents", "design-docs", "python", "sqlite"]
---

## Executive Summary

A multi-session agent architecture document described seven modules, M1 through M7, and wrote about them the way people write about services: "M4 calls...", "M1 acknowledges...", "M4 restarts." That phrasing happened to be accurate for two of the seven — a message dispatcher and a session supervisor, each a single long-running daemon that talks to the other through a shared SQLite database because they really are two separate processes. The same sentence pattern, applied to the other five modules, produced a false statement: "M5 generates the target artifacts inside M4's transaction." M5 is a memory-sync routine that runs inside the agent's own LLM session, not a process at all; M4 is a supervisor daemon; a database transaction belongs to one connection in one process, so a transaction cannot span the two. The document was not wrong about the system — it was wrong about grammar, and the grammar error was hiding a real architectural question that the writer had never actually answered for five of the seven modules: *where does this code run, and who is the actor?*

This article uses that incident as a case study in an old distinction that the software-architecture literature has made repeatedly and independently — Kruchten's 4+1 view model, the SEI's "Documenting Software Architectures: Views and Beyond," arc42, and the C4 model all draw a line between *what a system is logically decomposed into* and *what actually executes at runtime*. The line matters more, not less, in LLM-agent systems, where "the agent," subagents, hooks, daemons, and shared-state files sit at wildly different points on that spectrum and a design doc's sentence subjects are usually the only place the distinction is recorded at all.

The concrete output is a **run-location table** (a column added to the module table naming where each module's code actually executes), a **naming rule** for sentence subjects, a table of **consequences that follow from run location** (crash semantics, transactions, what "restart" means, log location, concurrency — plus locks and file handles, whose lifetime also depends on who owns and explicitly releases them), a **review checklist**, and a documented case of the **shared-JSON-file-with-two-writers smell**, including the standard remedies. It also includes a small Python script — written and actually run for this article, not just described — that scans a Markdown design doc for exactly the "module-as-actor" sentence pattern that started the incident, flags true positives, and correctly leaves legitimate usages like "calls M7's getFrontier" alone.

## The incident, restated generically

The design doc modeled a multi-session agent platform as seven modules, M1–M7. Two of them were genuinely processes:

- **M1**, a message dispatcher: one long-running daemon that receives inbound events and routes them.
- **M4**, a session supervisor: one long-running daemon that starts, monitors, and restarts agent sessions.

M1 and M4 coordinate through a shared SQLite database, because they are separate OS processes with no other channel between them. For these two, subject-verb sentences ("M4 restarts the session," "M1 acknowledges the message") are literally true: each name denotes one running thing, and the verb describes an action that thing takes.

The other five modules were not processes in that sense — none of them is one long-running thing with its own lifetime that a name like "M6" could pick out (for brevity, the rest of this article calls them *non-process* modules, even where an invocation briefly runs as a child process):

- A **channel-state registry** — a JSON file per channel, written by two of the daemons (M1 and M4) rather than owned by either.
- **M5**, a memory-sync routine, which runs as part of the agent's own LLM session, not as a standalone process.
- A **session-start hook** — a script invoked at the start of each session. It is registered as an external command with a timeout, so each invocation runs as a short-lived child process that the session's runtime spawns and waits on: it has its own PID and exit status, but no lifetime beyond that one invocation.
- A **channel component** — a set of scripts invoked by whichever process handles that channel (again, each invocation a short-lived child process, not a resident one).
- A **DB schema and function library** — SQL and helper functions with no process of their own; they execute inside whichever caller (M1 or M4) opens the connection.

The document used the same subject-verb shorthand for all seven, and for the five non-process modules it generated sentences that could not be true of anything: a transaction "inside M4's transaction" performed by code that runs in a different process's memory space (M5); a registry file "generating" or "restarting" as if it were an agent, when it is inert data written by two other things; a hook module "acknowledging," as if it persisted between invocations, when each invocation is a separate short-lived process that some other process starts, waits on, and outlives — there is no one running "M6" for the sentence to be about.

The owner's question — "what are M1–M7, and why do your sentences read as if each module were a different process?" — was really two questions. The first ("what are M1–M7") turned out not to have been answered precisely even by the document's author, because the document's grammar had let it fake an answer. The second is the general problem this article addresses.

## Why the architecture literature keeps re-deriving this distinction

This is not a new observation. Four independent bodies of work — spanning three decades — converge on the same split, from different starting points and for different stated reasons.

### Kruchten's 4+1: logical view vs. process view

Philippe Kruchten's 1995 *IEEE Software* paper, "Architectural Blueprints — The '4+1' View Model of Software Architecture," organizes a software architecture description into five concurrent views. The **logical view** "is concerned with the functionality that the system provides to end users" and captures functional decomposition as classes and subsystems — a static, structural picture. The separate **process view** "deals with the dynamic aspects of the system, explains the system processes and how they communicate, and focuses on the run-time behaviour of the system," explicitly covering concurrency, distribution, and integrator/performance/scalability concerns. ([Kruchten, IEEE Software 12(6), 1995, via ACM Digital Library](https://dl.acm.org/doi/10.1109/52.469759); summary and citation confirmed via [Wikipedia, 4+1 architectural view model](https://en.wikipedia.org/wiki/4%2B1_architectural_view_model))

The load-bearing point for this article: Kruchten did not fold process concerns into the logical view as a footnote. He gave runtime decomposition its own first-class view precisely because a class diagram (logical) and a process diagram (who runs, who talks to whom, what is concurrent) answer different questions and can disagree about boundaries — several logical classes can live in one process, and a single logical subsystem can be split across several processes.

### SEI: module views are not component-and-connector views

Clements, Bass, and colleagues at Carnegie Mellon's Software Engineering Institute make the split even sharper in *Documenting Software Architectures: Views and Beyond*, which defines three "viewtypes." **Module views** "show elements that correspond to implementation units" — the things a programmer edits and a build system compiles. **Component-and-connector (C&C) views** "show elements in execution": components and connectors "can exist in many forms: processes, objects, clients, servers, and data stores," connected by "the pathways of interaction, such as communication links and protocols, information flows, and access to shared storage." A third viewtype, **allocation views**, maps either of the first two onto non-software structures — hardware (the deployment style), configuration-management structure, or the teams that own the code (work-assignment style). ([SEI / Clements et al., summarized via search of the publisher's sample chapter and abstract](https://www.researchgate.net/publication/234787962_Documenting_Software_Architectures_Views_and_Beyond); chapter-level definitions cross-checked against the O'Reilly table of contents for [Chapter 3, Component-and-Connector Views](https://www.oreilly.com/library/view/documenting-software-architectures/9780132488617/ch03.html))

This vocabulary gives the incident a precise name: the design doc's module table was a **module view** (a decomposition into implementation units — M1 through M7), but its prose was written as if it were a **C&C view** (a runtime picture of processes talking to each other). A module view element ("the memory-sync routine") is not automatically a C&C element ("a process"); whether it is one is exactly the fact the run-location column is meant to record.

### arc42: building block view vs. runtime view vs. deployment view

arc42, a widely used pragmatic architecture-documentation template, keeps the same three-way split under different names. Section 5, the **building block view**, documents "structure of source code, modularization, hierarchically refined" — explicitly a static picture. Section 6, the **runtime view**, documents "important runtime scenarios" — how building blocks behave and interact when the system executes, which building block does what during a given scenario. Section 7, the **deployment view**, documents "hardware, infrastructure and deployment" — where things physically or virtually run. ([arc42 Overview](https://arc42.org/overview/))

arc42's own guidance stresses that the runtime view is a *companion* to the building block view, not a restatement of it in the same words: the building block view is "about static structure, not behavior," and the runtime view exists specifically to show "which building block is responsible for what activities" at runtime — implying that a building block name alone does not tell you that.

### C4: containers are runtime/deployable, components are not

Simon Brown's C4 model draws the line at the level most directly relevant to an agent platform's module table. A **container** is "something that needs to be running in order for the overall software system to work" — a runtime boundary around executing code or stored data, and, crucially, "the deployable unit." A **component**, by contrast, is "a grouping of related functionality encapsulated behind a well-defined interface" that lives *inside* a container; components "are not separately deployable units," and "all components within a container execute in the same process space." ([c4model.com, Container abstraction](https://c4model.com/abstractions/container); [c4model.com, Component abstraction](https://c4model.com/abstractions/component); level definitions cross-checked against [Wikipedia, C4 model](https://en.wikipedia.org/wiki/C4_model))

C4's container/component split maps almost exactly onto "process vs. module" for the incident above: M1 and M4 are containers (separately deployable, independently runnable daemons); M5 and M7 are components or code-level elements that execute *inside* whatever container calls them; M6 and M3's scripts fit neither box cleanly — they are not deployable units, but each invocation is its own short-lived process started by a container, which C4's "same process space" wording for components does not describe (one more reason the run-location column has to be filled in from how the code is actually invoked, not inferred from what kind of module it is); the channel-state registry is a data store, which C4 explicitly allows a container to be, but a data store is not an actor that "generates" or "restarts" — it is a thing a container reads and writes.

### ISO/IEC/IEEE 42010: the general permission to have more than one view

ISO/IEC/IEEE 42010 does not prescribe views by name; it formalizes *why* an architecture description is allowed — expected — to need more than one. A **viewpoint** is "a specification for constructing a single view. It defines the stakeholders, concerns, and modeling techniques to be used," and a **view** is "a representation of the architecture from the perspective of a particular viewpoint," with the standard requiring that "stakeholder concerns are explicitly addressed in the architecture description." ([summary of ISO/IEC/IEEE 42010 via quality.arc42.org](https://quality.arc42.org/standards/iso-42010))

Applied here: "what is this system logically made of" and "what actually runs, as what, where" are two different stakeholder concerns (a new contributor reading the module table wants the first; an on-call engineer debugging a crash wants the second), and 42010's contribution is the general principle that a document is entitled — obligated, if it wants to be precise — to answer them separately rather than collapsing them into one table with one kind of sentence.

### The gap: nobody has written this down for LLM-agent systems yet

A search for architecture-documentation guidance specific to LLM-agent systems — subagents, hooks, daemons, and tools — turned up abundant material on *building* such systems (scaffolding, harnesses, context engineering, sub-agent delegation patterns) but nothing that applies the module/process distinction to *documenting* them. That is a gap worth naming rather than papering over: agent platforms have introduced at least four actor-like categories that classical architecture writing didn't need to distinguish as sharply —

- a **subagent**, which is a bounded task delegation, often ephemeral, sometimes literally another process and sometimes just another LLM call inside the parent's session;
- a **hook**, which runs at a lifecycle point on behalf of whatever process reached that point — sometimes as an in-process callback, often (as with command-style hooks in agent harnesses) as an external command that process spawns as a child, with its own PID, exit status, and timeout — and in either case has no lifetime beyond that one invocation;
- a **daemon**, which is an ordinary long-running OS process and the one category classical architecture literature already covers well;
- a **tool** or **function library**, which, when it is an in-process function, has no existence at all except while some caller's stack frame is inside it (a tool implemented as an external command or a separate server is a process, and needs its own run-location entry).

None of the frameworks above were written with this vocabulary, but all four converge on the one fact an agent-platform document needs to state for each of these: is this a container/process/C&C-element with its own lifetime and identity, or is it a module/component/building-block whose code only exists while some container is executing it — and, for the agent-era cases in between, is it a short-lived child process that a container starts and waits on? The module's *kind* does not settle that; only how it is actually invoked does. The incident's fix, below, is one concrete way to force a document to say which, every time.

## The fix: a run-location column and a naming rule

### The run-location table

Add one column to the module table that a module view alone will never contain: **where does this module's code actually execute?**

| ID | Module | Kind | Run location |
|----|--------|------|--------------|
| M1 | Message dispatcher | Process | Daemon process A (own lifetime, own PID) |
| M4 | Session supervisor | Process | Daemon process B (own lifetime, own PID) |
| M2 | Channel-state registry | Data | *(see below — this line is the one the reviewer caught)* |
| M5 | Memory-sync routine | Library / routine | Inside the agent's own LLM session process, at sync time |
| M6 | Session-start hook | Hook script | Child process spawned by the agent session's runtime at startup, once per hook command; own PID and exit status, bounded by the hook timeout |
| M3 | Channel component (scripts) | Scripts | Child process spawned by whichever process invokes that channel's script, for the duration of that invocation |
| M7 | DB schema + function library | Library | Inside the caller's process (M1 or M4), for the duration of the call |

Three kinds of entries are correct here: **"Daemon process X"** (a name and a lifetime you can attach a PID and a restart policy to); **"Inside \<caller\>'s process, \<when\>"** (an explicit admission that the module has no lifetime of its own and borrows someone else's — true of in-process libraries and callbacks); and **"Child process spawned by \<caller\>, \<when\>"** (a real, separate process with its own PID and exit status, but a bounded lifetime that \<caller\> starts and normally waits on — true of external scripts and command-style hooks). Which of the last two applies is a fact about how the code is invoked, not about whether the module is called a "hook" or a "library", so it has to be checked, not assumed. The column is also wrong if it names a location that isn't actually one process — which is exactly what happened next.

### The reviewer's second catch: the run-location column can itself be wrong

A reviewer read the filled-in table and flagged the registry row. The first draft of the column read "written by M1" — a single writer, as if the registry file were owned the way M5's routine is owned by the agent session. But the registry is a JSON file per channel that **both M1 and M4 write**, from two separate OS processes, independently. "Written by M1" was not a simplification; it was a factual error that happened to look like the kind of clean single-owner answer the new column was designed to elicit. Two consequences followed from getting this row right instead:

1. The run-location column has to allow **multi-writer** as a documented value, not just a single process name — "written by M1 and M4, no arbitration between them" is a legitimate (if concerning) answer.
2. Writing that answer down surfaces a **latent lost-update race**: two processes doing read-modify-write on one JSON file, with no lock, no conditional write, and no ordering guarantee, can each read the same on-disk state, compute a different update, and have the second writer's `write()` silently overwrite the first writer's change. Nobody had described this failure mode before because nobody had been forced to write a true sentence about who writes the registry.

This is the general shape of the lesson: a run-location column is only doing its job if it can express "more than one process, uncoordinated" as an answer — and if it can, filling it in for every data-only module becomes a free concurrency audit.

### The naming rule

The rule adopted, stated exactly as it should appear in a style guide or doc template:

> **A module name may be the grammatical subject of a sentence only when that module is a process (or a single addressable runtime instance).** In that case, "M4 restarts the session" means *M4's code, executing at M4's run location, restarts the session* — nothing more needs to be spelled out because M4 has exactly one run location.
>
> **Data modules and library/hook/script modules never appear as sentence subjects.** Write "X calls module Y's function `f`," "X runs Y's script," or "X reads/writes Y" — where X is the actual process doing the calling, running, reading, or writing, and Y is named only as the object. This holds even when Y's script runs as its own child process: each invocation is a different, short-lived process, so the module name still does not denote one running thing. If a single run matters ("the hook exited non-zero"), name the run, not the module.
>
> **Never describe a transaction as spanning two run locations.** If a sentence needs a transaction, an "inside \<container\>'s transaction" phrase, and a component that doesn't run in that container, the sentence is describing something that cannot happen, and the fix is to re-derive what actually happens (e.g., "the agent session runs M5's routine and gets the artifacts back; whichever process is to persist them — the session itself, or M4 after receiving them as data — writes them inside its own transaction").
>
> **Never mention a lock or an open file without naming its owner and its release.** Unlike a transaction, these *can* outlive a call and be shared across processes: a library can return a locked file or connection to its caller, and a child process can inherit its parent's descriptor. So say which connection or open file description holds it, which processes hold a reference to it, and what explicit unlock, commit, or close ends it — rather than letting "for the duration of the call" or "until the child exits" stand in for that.

Applying the rule to the incident's bad sentences:

| Before (module-as-actor) | After (naming rule applied) |
|---|---|
| "M5 generates the target artifacts inside M4's transaction." | "The agent session runs M5's routine to compute the artifacts; M4, which runs in a different process, receives them as data and writes them inside its own transaction." |
| "M2 writes the new channel status after every dispatch." | "M1 writes the new channel status to M2 after every dispatch it handles; M4 also writes to M2 after a restart it initiates." |
| "M6 validates the environment before the session starts." | "The agent session's runtime runs M6's validation script as a child process at startup and acts on its exit status." |
| "M7 acquires the row lock before update." | "M4 calls M7's `acquire_lock` function, which takes the row lock inside M4's own connection; the lock stays held after the function returns, until M4 commits or rolls back." |

Notice the "after" versions are longer. That is the point: the extra words are exactly the information ("who is actually doing this, and in what process") that the module-as-actor shorthand was silently deleting.

## Consequences that depend on run location

Once a module's run location is written down honestly, a set of practical questions get answers that were previously undefined or implicitly (and sometimes wrongly) assumed:

| Question | Process module (e.g., M1, M4) | In-process library/routine (e.g., M5, M7) | Invoked script or command hook (e.g., M6, M3) | Multi-writer data module (M2) |
|---|---|---|---|---|
| **Crash / restart semantics** | Has its own crash and restart: a process manager (systemd, pm2, a supervisor loop) can kill and relaunch it independently. | Cannot crash independently — it "crashes" only as part of whatever process was running it, and has no restart of its own. | Can fail on its own: it has its own PID, can crash, exit non-zero, or hit the caller's timeout while the caller keeps running, and the caller decides whether that failure matters. It still has no restart of its own — "M6 restarts" is meaningless; "the session runtime runs M6 again" is what happens. | The file itself doesn't crash; a crash mid-write by either writer can still leave it in a half-written or stale state. |
| **Transactions** | Owns its own DB connection(s); a transaction is scoped to one connection in one process. | Has no connection of its own; any transaction it appears inside is actually the caller's. | Any connection it opens is its own, in its own process, and cannot join the caller's transaction; work it commits is committed independently of whatever the caller later does. | N/A — not a DB row. Writing a temp file and renaming it into place gives all-or-nothing replacement (no reader ever sees a half-written file), but not isolation: it does nothing to stop two writers' read-modify-write cycles from overlapping. |
| **Locks** | Can hold a lock for as long as it lives; the lock ends when it explicitly unlocks, commits, or closes the holding descriptor or connection — or when it exits, unless a child it spawned still holds a duplicate of that descriptor. | Takes locks on the caller's behalf, but their lifetime is not the call's: a lock belongs to the connection or open file description it was taken on, and lasts until something explicitly unlocks, commits, or closes that resource — possibly long after the call returns, if the library returns or caches the locked file or connection. | Depends on whose descriptor it is. A file it `open()`s itself carries its own lock, independent of (and conflicting with) the caller's, released when the child unlocks, closes it, or exits. A descriptor inherited from the caller shares the caller's `flock()` lock: the child can release it out from under the caller, or keep it held after the caller closes its own copy. | Any lock has to be advisory and external to the file (flock, a lockfile, or a DB row used as a mutex) since JSON has no native locking. |
| **Who can hold a file handle** | Yes — until it closes it or exits; a descriptor it passes to a child stays open in the child after that. | Not only inside a call: a library can open a file or connection and return it, or keep it in a cache or pool, so the handle lives until whoever ends up owning it closes it. | Handles it opens itself, until it closes them or exits; plus any descriptors the caller lets it inherit, which are not copies but references to the caller's open file description — same offset, same `flock()` lock. | Both writers can independently open, read, and write — which is exactly the hazard. |
| **What "restart" means** | Kill and relaunch the OS process; in-flight state is whatever was durably persisted. | Undefined on its own; means "the session/caller that hosts it restarts, and this module's code runs again from the top next time it's invoked." | Undefined on its own; means "the caller invokes it again," and each invocation is a fresh process with no memory of the last one beyond what it persisted. | Doesn't apply to the file; applies to each writer independently. |
| **Where logs live** | Its own log stream/file, tied to its PID. | Interleaved into whichever process's log was running it — a library's log lines are indistinguishable from the caller's own log unless explicitly tagged. | Its own stdout/stderr, which go wherever the caller routes them — captured, injected into the caller's context, or discarded; unless the caller records them, a failed run may leave no trace. | N/A, but writes to the file are worth logging separately from either writer's general log, precisely because two sources touch it. |
| **Concurrency on shared state** | Access to a shared DB is naturally serialized through the DB engine's own transaction/locking model. | No concurrency of its own; concurrency is whatever the caller's process model provides. | Runs concurrently with its caller (and with other invocations of itself) whenever the caller does not wait for it — fire-and-forget or async hooks — so any shared state it writes makes it one more writer to account for. | Concurrency is exactly the open question a "written by two processes" run-location entry raises, and it has no default safe answer — that's the smell in the next section. |

The **Locks** and **file handle** rows are the two where run location is necessary but not sufficient. Linux `flock()` locks belong to an *open file description*, not to a process or a call: every `open()` creates a new description, while descriptors duplicated by `dup()` or inherited across `fork()` — and kept across `exec()` unless marked close-on-exec — refer to the same one, so any of them can release the shared lock with `LOCK_UN`, and otherwise it is released only when all of them are closed ([flock(2)](https://man7.org/linux/man-pages/man2/flock.2.html), [open(2)](https://man7.org/linux/man-pages/man2/open.2.html)). POSIX `fcntl()` record locks behave differently again: they belong to the process, are not inherited by a forked child, and are *all* dropped when that process closes *any* descriptor for the file — including one some library opened and closed in passing ([fcntl_locking(2)](https://man7.org/linux/man-pages/man2/fcntl_locking.2.html)). A short local probe (Python 3.12, Linux 6.17) confirmed each case: an independent contender stayed blocked after a library function returned a locked descriptor; an exec'd child calling `LOCK_UN` on an inherited descriptor let the contender in while the parent still held its own copy; a lock the parent had closed stayed held until the child holding the inherited copy exited; and a process's `fcntl()` lock vanished when it opened and closed a second descriptor for the same file.

## Review checklist

A short checklist to run over a module table and its prose before treating a design doc as done:

1. **Every module row has a run-location value**, and that value is either a named process/container, or an explicit "inside \<caller\>'s process, at \<when\>," or an explicit "child process spawned by \<caller\>, at \<when\>," or an explicit list of two-or-more writers/callers if that's actually the case.
2. **No data or library/hook/script module is the subject of an action verb anywhere in the prose.** Grep for it — see the script below.
3. **No sentence describes a transaction as spanning two run locations, and every lock or open file has a named owner and release.** If a transaction is mentioned, exactly one run location should be nameable as the one holding it. If a lock or file handle is mentioned, the doc should say which connection or open file description holds it, which processes hold a reference to it (including children that inherit it), and what explicit unlock, commit, or close ends it.
4. **"Restart" is defined per module**, and for non-process modules the definition routes to whatever hosts or invokes them — the host restarting, or the caller running the script again — not a restart of the module itself.
5. **Any run-location entry naming more than one writer/caller has an explicit statement of the concurrency control (or explicit absence of one).** "Written by M1 and M4, no lock" is an acceptable sentence in a design doc; a silent single-writer claim that is actually false is not.
6. **Logs are traceable to a run location.** If a reader can't tell which process's log will contain a given module's output, the run-location column hasn't done its job yet.

## The shared-JSON-file-with-two-writers smell

The reviewer's catch above is a specific, recurring smell: **one JSON (or similarly unstructured) file, read-modify-written by two or more independent processes, with no coordination.** The failure mode is a classic lost update — process A reads the file, process B reads the same on-disk version, both compute an update from what they read, and whichever writes last erases the other's change, with no error, no log line, and no way to reconstruct what was lost. The reason it's dangerous specifically in agent platforms is that this pattern is easy to reach for: a JSON file is the simplest possible "shared state," and two daemons that each need to record something about the same channel will independently decide "I'll just read-modify-write the file" unless something stops them.

Standard remedies, roughly in order of how much they change the design:

1. **Single writer.** Make exactly one process the owner of the file; every other process that needs to change it sends a request (a queue message, an RPC, a row in a table the owner polls) instead of writing directly. This is usually the cheapest fix and the one to reach for first, because it doesn't require any new machinery — it just moves an existing write into an existing process's responsibility.
2. **Field-level ownership with separate files.** If the two writers genuinely own different pieces of the same logical state (e.g., M1 owns delivery status, M4 owns restart count), split the state so each writer has its own file that no other process writes, and have readers merge the files rather than having writers merge writes. Separate top-level *keys* in one shared file are not a substitute: each writer still reads the whole document, changes its own key, and writes the whole document back, so its write carries a stale copy of the other writer's key and can erase that writer's latest change. Splitting by key only helps if the storage itself updates individual fields atomically — which a plain JSON file does not.
3. **Atomic rename — for torn reads, not lost updates.** Writing the new content to a temp file and `rename(2)`-ing it over the old one is worth doing regardless of the other remedies: POSIX specifies that the replacement is atomic, so a reader sees either the old file or the new one, never a half-written mix, and a crash mid-write leaves the old file intact. ([POSIX `rename()`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html)) It is tempting to add a compare-version step — read a version or hash along with the file, and rename only if the on-disk version still matches — but that check and the rename are two separate operations, and `rename()` replaces its target unconditionally. Two writers can both read version *n*, both re-check and still see *n*, and both rename; the second rename silently discards the first writer's update, exactly the lost update the check was meant to catch. A version check only works if it and the replacement are made atomic together: either by doing both while holding a lock that every writer takes (remedy 4), or by using storage that offers a real conditional write, such as a single SQLite `UPDATE ... SET ..., version = version + 1 WHERE id = ? AND version = ?` whose affected-row count tells the writer whether it won (remedy 5).
4. **Advisory locks.** Wrap the whole read-modify-write — read, any version check, and the write or rename — in `flock()` (or an equivalent) that every writer takes on the same lock. Lock a separate lock file that is never itself replaced: if writers lock the data file and also replace it by rename, the next writer opens and locks the new file while the old lock is still held on the replaced one, and the serialization quietly disappears. Each writer should `open()` the lock file itself and end the critical section with an explicit `LOCK_UN` or `close()`; if it spawns helper processes while holding the lock, the locked descriptor should be close-on-exec, because a child that inherits it shares the same lock and can release it early or keep it held after the writer is done. This serializes the two writers without redesigning ownership, at the cost of one process blocking on the other and of every future writer needing to remember to take the lock — nothing enforces that at the filesystem level.
5. **Move the state into SQLite rows.** Replace the JSON file with a table in the same SQLite database the two processes may already share (as M1 and M4 do in this system), and let a single `UPDATE ... WHERE` statement (optionally wrapped in `BEGIN IMMEDIATE`) do the read-modify-write atomically inside the database engine's own transaction and locking model. This is the most robust option precisely because it moves the coordination problem into software that was built to solve it, and it composes naturally with a platform that already uses SQLite for exactly the reason M1 and M4 do (two processes, one shared source of truth).

Which remedy is right depends on how often the two writers actually collide and how bad a silent loss would be; for the registry in this incident, moving the two or three fields that both M1 and M4 touch into SQLite rows alongside the existing shared database was the change under consideration, since the infrastructure for it already existed for a different reason.

## Hands-on verification: a script that catches module-as-actor sentences

Grepping for the bad pattern by hand does not scale past one review pass, and the pattern recurs every time a doc is edited. Below is a small, dependency-free Python script written for this article that scans a Markdown design doc, takes a list of module IDs the author has flagged as **non-process** (data, library, hook, script), and reports every line where one of those IDs is immediately followed by an action verb — in English or Chinese — while skipping changelog/history sections and correctly leaving alone legitimate references like "M4 calls M5's sync routine" or "calls M7's getFrontier."

The one non-obvious implementation detail, found by actually running it rather than by inspection: Python's regex `\b` word-boundary treats CJK ideographs as word characters, so a naive `\bM5\b` pattern **never matches** in `M5生成目标产物` — there is no "boundary" between the digit `5` and the character `生` because both count as `\w`. The fix is to anchor the module ID with lookaround assertions against `[A-Za-z0-9]` specifically, rather than relying on `\b`, and then classify whatever follows by hand.

```python
#!/usr/bin/env python3
"""
check_module_actor.py

Scan a Markdown design doc for "module-as-actor" sentences: places where a
module ID that does NOT name a single long-running process (a data file, a
library, a hook or script, a config-only unit, etc.) is written as the
grammatical subject of an action verb, e.g. "M5 generates the target
artifacts" or "M3 写入状态". Modules that ARE long-running processes are not
checked, because for them "M4 restarts" is a true statement about a single
running thing.

The check is a narrow, high-precision heuristic, not a parser:
  - A hit requires one of the caller-supplied non-process module IDs to be
    immediately followed (English: separated by whitespace only; Chinese:
    adjacent, no separator) by a word/segment that starts with a known
    action verb.
  - Immediately followed by a possessive marker ("'s" in English, "的" in
    Chinese) is treated as a legitimate reference to the module's data or
    function ("M7's getFrontier", "M3的字段") and is never flagged.
  - Lines inside a changelog/history section (any heading matching
    changelog|history|变更记录|修订记录, until the next heading of the same
    or higher level) are skipped entirely, since those narrate what was
    DONE TO a module by its authors, not what the module does at runtime.

Usage:
    python3 check_module_actor.py --doc DOC.md --nonprocess M3,M5,M6,M7

Exit status is 0 always; findings are printed to stdout. This is a review
aid, not a gate.
"""
import argparse
import re
import sys

EN_VERB_STEMS = [
    "generate", "call", "restart", "acknowledge", "write", "read", "send",
    "receive", "create", "run", "execute", "hold", "spawn", "fork", "open",
    "commit", "rollback", "roll back", "check", "validate", "dispatch",
    "update", "delete", "lock", "acquire", "release", "listen", "poll",
    "retry", "start", "stop", "crash", "recover", "own", "manage", "emit",
    "publish", "subscribe", "queue", "process", "handle", "return",
]

def _inflections(stem: str):
    forms = {stem}
    if stem.endswith("e"):
        forms.add(stem + "s")
        forms.add(stem[:-1] + "ing")
        forms.add(stem + "d")
    else:
        forms.add(stem + "s")
        forms.add(stem + "ing")
        forms.add(stem + "ed")
    return forms

EN_VERB_FORMS = set()
for _s in EN_VERB_STEMS:
    EN_VERB_FORMS |= _inflections(_s)

ZH_VERBS = sorted([
    "生成", "调用", "重启", "确认", "写入", "读取", "发送", "接收", "创建",
    "运行", "执行", "持有", "派生", "打开", "提交", "回滚", "检查", "校验",
    "分发", "更新", "删除", "锁定", "获取", "释放", "监听", "轮询", "重试",
    "启动", "停止", "崩溃", "恢复", "拥有", "管理", "发布", "订阅", "入队",
    "处理", "返回", "写", "读",
], key=len, reverse=True)  # longest first so "写入" matches before "写"

CHANGELOG_HEADING_RE = re.compile(
    r"^(#+)\s*.*(changelog|history|变更记录|修订记录|修改历史).*$", re.IGNORECASE
)
HEADING_RE = re.compile(r"^(#+)\s+")


def strip_word(tok: str) -> str:
    return re.sub(r"^[^A-Za-z]+|[^A-Za-z]+$", "", tok)


def find_hits_in_line(line: str, mid: str):
    hits = []
    # MID token, then inspect what follows. We cannot use \b on both sides:
    # Python's \w (and therefore \b) treats CJK ideographs as word
    # characters, so "M5生成" has NO boundary between "5" and "生", and a
    # trailing \b would silently miss every Chinese-adjacent occurrence.
    # Anchor with lookarounds against [A-Za-z0-9] instead.
    pattern = r"(?<![A-Za-z0-9])" + re.escape(mid) + r"(?![A-Za-z0-9])"
    for m in re.finditer(pattern, line):
        rest = line[m.end():]
        if re.match(r"^'s\b", rest):
            continue  # "M7's getFrontier" -> legitimate, not an actor

        ws_then_word = re.match(r"^\s+([A-Za-z][A-Za-z\-]*)", rest)
        if ws_then_word:
            candidate = strip_word(ws_then_word.group(1)).lower()
            if candidate in EN_VERB_FORMS:
                hits.append(ws_then_word.group(1))
            continue

        cn_then = re.match(r"^([一-鿿]+)", rest)
        if cn_then:
            segment = cn_then.group(1)
            if segment.startswith("的"):
                continue  # "M3的字段" -> legitimate
            for v in ZH_VERBS:
                if segment.startswith(v):
                    hits.append(v)
                    break
    return hits


def iter_scannable_lines(text: str):
    skipping = False
    skip_level = None
    for i, line in enumerate(text.splitlines(), start=1):
        heading_m = HEADING_RE.match(line)
        if heading_m:
            level = len(heading_m.group(1))
            if skipping and level <= skip_level:
                skipping = False
                skip_level = None
            if CHANGELOG_HEADING_RE.match(line):
                skipping = True
                skip_level = level
                continue
        if skipping:
            continue
        yield i, line


def scan(doc_text: str, nonprocess_ids):
    findings = []
    for lineno, line in iter_scannable_lines(doc_text):
        for mid in nonprocess_ids:
            for verb in find_hits_in_line(line, mid):
                findings.append((lineno, mid, verb, line.strip()))
    return findings


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--doc", required=True)
    ap.add_argument("--nonprocess", required=True)
    args = ap.parse_args()

    with open(args.doc, "r", encoding="utf-8") as f:
        text = f.read()

    ids = [x.strip() for x in args.nonprocess.split(",") if x.strip()]
    findings = scan(text, ids)

    if not findings:
        print("No module-as-actor sentences found for non-process modules:", ", ".join(ids))
        return 0

    print(f"Found {len(findings)} module-as-actor sentence(s) for non-process modules {ids}:\n")
    for lineno, mid, verb, line in findings:
        print(f"  line {lineno}: [{mid}] as actor of \"{verb}\" -> {line}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

### The test document

A synthetic sample doc was written to include: the module table above; four bad module-as-actor sentences (English, for M5, M2, M6, M7); one bad sentence in Chinese (M5生成目标产物); several legitimate usages that name a non-process module only as an object ("M4 calls M5's sync routine," "calls M7's getFrontier," "M3调用M7的getFrontier"); a sentence where a flagged module (M2) appears but is not the actor ("M1 writes to M2, and M4 also writes to M2 directly"); and a changelog table plus a "History" section containing sentences that would otherwise match ("M5 generates a new artifact format," "M5 generates test fixtures for the release notes").

### Actual run and output

```
$ python3 check_module_actor.py --doc sample_doc.md --nonprocess M2,M5,M6,M7
Found 5 module-as-actor sentence(s) for non-process modules ['M2', 'M5', 'M6', 'M7']:

  line 20: [M5] as actor of "generates" -> M5 generates the target artifacts inside M4's transaction. (BAD: M5 is not
  line 23: [M2] as actor of "writes" -> M2 writes the new channel status after every dispatch. (BAD: M2 is a data
  line 26: [M6] as actor of "validates" -> M6 validates the environment before the session starts. (BAD: M6 is a hook
  line 29: [M7] as actor of "acquires" -> M7 acquires the row lock before update. (BAD: M7 is a library with no
  line 40: [M5] as actor of "生成" -> M5生成目标产物。 (BAD in Chinese: same pattern as the English M5 line above.)
```

This is the exact, unedited output of the run. All five true positives were caught, including the Chinese-language one that required fixing the `\b`-versus-CJK bug described above (an earlier version of the pattern found only 4 of the 5, silently missing every Chinese hit until the regex was corrected). None of the following were flagged, confirming the script does not raise false positives on the cases it is specifically meant to leave alone: "M4 calls M5's sync routine at the end of every session," "The supervisor calls M7's getFrontier function to compute the resume point," "M1 writes to M2, and M4 also writes to M2 directly" (M2 here is the object of "writes to," never its subject), "M3调用M7的getFrontier来判断起点。", "M6的校验逻辑在会话开始时运行。" (M6 followed by the possessive marker 的), and both changelog/history sentences that reused the same verbs the tool is watching for.

The script is a review aid, not a formal grammar checker — it does not parse sentence structure, so it can miss cases where a verb is separated from the module ID by an intervening clause, and its verb lists are illustrative rather than exhaustive. Its job is to make the specific, recurring mistake from this incident cheap to catch on every doc revision, not to replace the review checklist above.

## Takeaways

- **A module table is a module/logical/building-block view; prose about what calls what, what crashes, and what restarts is a component-and-connector/process/runtime view.** Four independent frameworks — Kruchten's 4+1, the SEI's viewtypes, arc42, and C4 — keep these apart because collapsing them produces sentences that describe things that cannot happen, not just imprecise ones.
- **The tell is grammar, not architecture.** The incident was caught because someone noticed the *sentences* had a suspicious uniform shape, not because someone audited the runtime model directly. A naming rule that forbids non-process modules as sentence subjects turns that same tell into a mechanical, greppable signal.
- **A run-location column is only useful if it can say "more than one, uncoordinated."** The single most valuable catch in this incident wasn't the naming rule — it was a reviewer refusing to accept a single-writer answer for a module two processes actually write, which surfaced a real lost-update risk that the clean version of the table would have hidden.
- **Agent platforms multiply the actor-like categories** — daemons, subagents, hooks, tool/function libraries, shared state files — well past what classical client-server or three-tier systems needed to distinguish, which makes this discipline more necessary, not less, exactly where the existing literature hasn't yet caught up to say so explicitly.

## References

- Kruchten, P. (1995). "Architectural Blueprints — The '4+1' View Model of Software Architecture." *IEEE Software* 12(6), 42–50. https://dl.acm.org/doi/10.1109/52.469759 (definitions cross-checked via https://en.wikipedia.org/wiki/4%2B1_architectural_view_model)
- Clements, P., Bass, L., et al. *Documenting Software Architectures: Views and Beyond*, 2nd ed. Module, component-and-connector, and allocation viewtypes: https://www.researchgate.net/publication/234787962_Documenting_Software_Architectures_Views_and_Beyond and chapter listing at https://www.oreilly.com/library/view/documenting-software-architectures/9780132488617/ch03.html
- arc42 architecture template — building block view, runtime view, deployment view: https://arc42.org/overview/
- C4 model (Simon Brown) — container and component abstractions: https://c4model.com/abstractions/container and https://c4model.com/abstractions/component ; level overview cross-checked via https://en.wikipedia.org/wiki/C4_model
- ISO/IEC/IEEE 42010 — architecture viewpoint and view definitions: https://quality.arc42.org/standards/iso-42010
- POSIX.1-2024 `rename()` — atomic replacement of the target, with no conditional/expected-version form: https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html
- Linux man-pages: flock(2) — locks belong to the open file description, shared by duplicated/inherited descriptors, preserved across execve: https://man7.org/linux/man-pages/man2/flock.2.html ; open(2) — open file descriptions and their sharing across fork: https://man7.org/linux/man-pages/man2/open.2.html ; fcntl_locking(2) — process-associated record locks, not inherited by fork, released when the process closes any descriptor for the file: https://man7.org/linux/man-pages/man2/fcntl_locking.2.html
