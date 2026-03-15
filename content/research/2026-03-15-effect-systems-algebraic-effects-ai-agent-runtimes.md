---
date: "2026-03-15"
title: "Effect Systems and Algebraic Effects for Controlled Side Effects in AI Agent Runtimes"
description: "Deep research into effect systems, algebraic effects, and capability-based patterns for enforcing side-effect governance in AI agent architectures — with focus on Rust implementations."
tags:
  - research
  - ai-agents
  - rust
  - programming-languages
  - effect-systems
  - security
  - architecture
---

## Executive Summary

Effect systems are a class of type-level abstractions that track and constrain what kinds of computational side effects (I/O, state mutation, network access, nondeterminism) a function or module is permitted to perform. Algebraic effects are a specific, mathematically principled approach where effects are declared as named operations and handled by composable "handlers" that intercept and route those operations — analogous to how exceptions work, but generalized and resumable.

For AI agent runtimes — especially architectures like Zylos's Session-Governor-Executor model where a Session layer has zero direct tool access and must request the Governor for any side effect — effect systems provide a compelling theoretical foundation and a practical vocabulary for enforcing this separation at the type level.

Key takeaways:

- Algebraic effects (Koka, Eff, OCaml 5, Unison "Abilities") provide the cleanest model: effects are declared in function signatures, handlers intercept them, and the type system prevents unhandled or unauthorized effects from executing.
- Rust does not have native algebraic effects yet, but the Keyword Generics / Effect Generics initiative is actively working toward this. In the meantime, Rust developers can approximate effect governance using capability tokens, typestate patterns, and trait-based capability bounds.
- Capability-based security and effect systems are complementary but not equivalent: capabilities control *who* can do something (object possession), while effect types control *what* can happen statically (type annotations). A synthesis of both is optimal for agent runtimes.
- Monad-based approaches (Haskell IO monad, Scala ZIO/Cats Effect) achieve similar goals but at a composition cost — monads don't stack cleanly without transformers, while algebraic effects compose freely.
- For a Session-Governor-Executor architecture: the most practical Rust pattern today is capability token injection — the Session type receives no I/O capability at construction, the Governor mediates all capability grants, and the type system enforces zero-capability at compile time.

---

## What Are Effect Systems?

An **effect system** is a formal extension to a type system that tracks not just *what* a computation produces (its return type) but *what it does* while producing it. The "effect" of a function is a set of labels describing its observable behaviors: reading files, writing to a database, throwing exceptions, performing network calls, generating random numbers, and so on.

A function signature in Koka looks like:

```koka
fun greet(name: string): console ()
  println("Hello, " ++ name)
```

The `: console ()` says this function returns `unit` and has the `console` effect (it writes output). A pure function has an empty effect set `<>`. The compiler statically verifies that every effect a function can perform is either declared in its type or handled by an enclosing handler.

The Wikipedia definition captures this: "An effect system can be used to provide a compile-time check of the possible effects of the program. Effect systems extend types to keep track of effects, permitting concise notation for functions with effects, while maintaining information about the extent and nature of side effects."

Effect systems were first proposed in the 1980s for region-based memory analysis and exception typing. They have enjoyed a major revival as the programming language community seeks principled ways to control side effects in concurrent, distributed, and safety-critical systems — including AI agent runtimes.

---

## Algebraic Effects and Handlers

### The Core Idea

**Algebraic effects** give effect systems a clean operational semantics. Rather than effects being opaque labels in a type, they are named *operations* defined in an effect interface, and *handlers* intercept those operations and decide what to do with them — including whether to resume the calling computation, abort it, or transform it.

Think of algebraic effects as a structured, typed form of non-local control flow. When a function performs an effect operation (like `ask()` for configuration or `log("message")` for logging), execution is suspended and control passes to the nearest enclosing handler for that effect. The handler can:

1. **Resume** the suspended computation (with or without a value)
2. **Abort** the computation (like throwing an exception)
3. **Run the continuation multiple times** (for nondeterminism, backtracking — but not all languages support this)

The critical property is **composability**: effects compose freely. Unlike monad transformers (which require explicit lifting), multiple effects can be in scope simultaneously with no boilerplate.

### Delimited Continuations

Algebraic effects are implemented on top of **delimited continuations** — the ability to capture "the rest of the computation" at a specific point and treat it as a first-class value. When an effect operation is invoked:

1. The current continuation (everything that follows this operation) is captured
2. Control jumps to the handler
3. The handler may invoke the continuation zero or more times

This is why algebraic effects can express async/await, generators, exceptions, cooperative multithreading, and probabilistic computation — all as library code without language-level special cases.

### Key Languages

**Koka** (Microsoft Research) is the most mature research language built around algebraic effects as its primary abstraction. Every function's effects are tracked in its row-polymorphic type signature. The Koka compiler compiles via C with efficient reference counting (no GC required), and effect handlers compile to efficient local transformations. Koka's row polymorphism means effect sets are open and extensible — you can write functions generic over what effects they perform.

**Eff** (University of Ljubljana) was the original research language for algebraic effects. It is academically thorough and supports multi-shot continuations (handlers can resume a continuation multiple times), enabling powerful patterns like backtracking and probabilistic programming. Its effect types are statically checked.

**OCaml 5** introduced effect handlers as an experimental feature. The key design choice was to limit to **one-shot continuations** (a continuation can only be resumed once) — a pragmatic decision that enables more efficient stack-based implementation. The `eio` library (Effects-based IO, 1.0 released March 2024) is the flagship production use case, providing direct-style concurrent I/O without monads, callbacks, or the "function color problem."

**Unison** calls algebraic effects "abilities." Its ability system is based on the Frank language. Unison's content-addressed code model means distributed computation becomes an ability — you can write `remoteExec(fn)` and the runtime handles shipping the function hash to another node. The type system tracks which abilities a function requires, so unauthorized network access or I/O is a compile error.

**Effekt** (a research language) focuses on effect safety with particularly strong guarantees about effect handling scoping and is actively used in research on language-level security.

---

## How Effect Systems Apply to AI Agent Side-Effect Control

### The Core Problem

An AI agent runtime faces a governance problem: the Session (the LLM reasoning layer) should not be able to directly execute tools, write files, make network calls, or mutate state. It should only be able to *request* these operations, with a Governor layer making the actual authorization and execution decision.

This is architecturally similar to:
- A user-space process requesting kernel services via syscalls (the kernel is the governor)
- A capability-based OS where processes hold unforgeable tokens for each operation type
- A pure functional program where all I/O is collected in a monad and executed by the runtime at the boundary

Effect systems provide the *language-level* enforcement: if the Session's code does not have the `NetworkAccess` or `FileWrite` effect in scope (and no handler for those effects has been installed), then any code attempting those operations is a **compile error**.

### The Handler-as-Governor Pattern

The elegant mapping is:

- **Effect operations** = tool invocations (read_file, http_post, run_code, etc.)
- **Effect handlers** = the Governor
- **Session code** = effectful computations that declare which effects they need
- **Executor** = where the handler actually performs the real work

In a Koka-style model:

```
effect tool
  fun read_file(path: string): string
  fun http_post(url: string, body: string): string

fun session-reasoning(): tool string
  val content = read_file("/data/input.txt")
  val result = http_post("https://api.example.com", content)
  result

fun run-with-governor(session: () -> <tool,exn> string): string
  with handler
    fun read_file(path) -> resume(governor-approve-and-read(path))
    fun http_post(url, body) -> resume(governor-approve-and-post(url, body))
  session()
```

The `session-reasoning` function declares it needs the `tool` effect. It cannot execute — it cannot even be called — unless wrapped in a handler. The handler *is* the Governor. If the Governor rejects an operation, it does not resume the continuation. The Session literally cannot proceed.

This is fundamentally different from runtime sandboxing (which can be bypassed) or policy checks that happen after the fact. The type system makes unauthorized side effects structurally impossible.

### Observability-Driven Sandboxing (Current Practice)

In practice today, most agent systems implement a weaker version: **observability-driven sandboxing**, where a middleware layer intercepts tool calls and decides whether to allow them. NVIDIA's security guidance and Arize's work on agent observability describe patterns where execution is gated by explicit policy checks. This is the handler pattern implemented at the runtime level — but without static type-level guarantees.

The architectural separation of "planner proposes, executor carries out under stricter tool permissions" (identified in security research as an emerging best practice) directly mirrors the Session-Governor-Executor architecture.

---

## Rust Approaches to Effect-Like Patterns

Rust does not have native algebraic effects (yet), but the language has strong foundations for approximating them.

### The Keyword Generics / Effect Generics Initiative

The Rust team has been running the [Keyword Generics Initiative](https://rust-lang.github.io/keyword-generics-initiative/) since 2022, aimed at unifying `async`, `const`, and `try` as first-class *effects* in the language. A February 2024 update from the initiative describes this explicitly: "Rust has unknowingly shipped an effect system as part of the language since Rust 1.0."

The current Rust effects are:
- **`async`**: suspends computation, enabling cooperative multitasking
- **`const`**: restricts to compile-time-evaluable computations
- **`try`**: propagates errors through `?` operator

The initiative is working toward "effect-generic" trait definitions — the ability to write code that is generic over whether it is async or not, fallible or not. This mirrors Koka's row-polymorphic effect types. An RFC for effect-generic trait definitions was targeted for 2024, though the work is still ongoing as of early 2026.

The key blog post is Yoshua Wuyts's ["Extending Rust's Effect System"](https://blog.yoshuawuyts.com/extending-rusts-effect-system/) and the initiative's ["Effect-Generic Bounds and Functions"](https://rust-lang.github.io/keyword-generics-initiative/explainer/effect-generic-bounds-and-functions.html) explainer.

### Capability Tokens

The most practical pattern for enforcing effect governance in Rust today is **capability tokens** — zero-sized types (ZSTs) that act as unforgeable access rights.

```rust
// Zero-sized capability token for network access
pub struct NetworkCapability(PhantomData<()>);

// Token can only be created by the Governor
impl NetworkCapability {
    pub(crate) fn new() -> Self { NetworkCapability(PhantomData) }
}

// A function requiring network access must receive the token
pub fn http_post(
    cap: &NetworkCapability,
    url: &str,
    body: &str,
) -> Result<String, HttpError> {
    // actual network call
}
```

The `NetworkCapability` type is `pub(crate)` to its constructor — only the Governor module can mint one. Session code that tries to call `http_post` without holding a `NetworkCapability` gets a compile error. This is the [PermRust approach](https://arxiv.org/html/2506.11701v1) — a token-based permission system for Rust as a zero-cost abstraction.

Key properties:
- **Zero runtime cost**: ZSTs are erased at compile time
- **Unforgeable**: Cannot be constructed outside the Governor module
- **Composable**: Multiple capabilities can be combined as struct fields
- **Revocable**: The Governor can choose not to pass a token for a given session
- **Auditable**: Tool call sites are statically visible — every `http_post` call has a visible `&NetworkCapability` argument

### Typestate Pattern

The **typestate pattern** encodes valid state transitions in the type system, making illegal transitions compile errors. For agent runtimes, this can enforce the Session lifecycle:

```rust
// Session can only execute tools when in Approved state
struct Session<State> {
    context: Context,
    _state: PhantomData<State>,
}

struct Pending;
struct Approved { tools: Vec<ToolGrant> }
struct Executing;

impl Session<Pending> {
    fn request_approval(self, tools: Vec<ToolRequest>) -> PendingApproval {
        // send to governor
    }
}

impl Session<Approved> {
    fn execute_tool(&self, tool: &ToolGrant) -> ToolResult {
        // can only execute tools listed in Approved state
    }
}
```

The Session literally cannot call `execute_tool` until the Governor has transitioned it to the `Approved` state. An attempted call in `Pending` state is a compile error.

### Trait-Based Capability Bounds

Another pattern is defining capability traits and bounding functions on them:

```rust
trait HasNetworkAccess: private::Sealed {}
trait HasFileAccess: private::Sealed {}
trait HasMemoryAccess: private::Sealed {}

// Only code with ALL capabilities can call this
fn privileged_operation<C: HasNetworkAccess + HasFileAccess>(cap: &C) { ... }

// Sessions receive a zero-capability context
struct SessionContext; // implements no capability traits

// Executors receive a full-capability context
struct ExecutorContext; // implements all capability traits
impl HasNetworkAccess for ExecutorContext {}
impl HasFileAccess for ExecutorContext {}
```

The `private::Sealed` pattern prevents external crates from implementing the capability traits, making the capability system unforgeable.

### Library Approaches: effing-mad

The [`effing-mad`](https://github.com/rosefromthedead/effing-mad) crate brings algebraic effects and effect handlers to Rust via traits and macros, allowing code to be written in a style similar to Rust's `async` functions. It is not production-ready but demonstrates the feasibility. A 2024 blog post ["A universal lowering strategy for control effects in Rust"](https://www.abubalay.com/blog/2024/01/14/rust-effect-lowering) describes a general approach for compiling control effects in Rust via coroutine lowering.

---

## Comparison: Effect Systems vs Capability-Based Security vs Monads

### Effect Systems

**Mechanism**: Type-level annotations declaring what effects a computation may perform; handlers intercept those effects at runtime.

**Strengths**:
- Static verification: unauthorized effects are compile errors
- Composable: effects stack without boilerplate
- Testable: swap in mock handlers for testing
- Introspectable: the type signature tells you exactly what a function can do

**Weaknesses**:
- Requires language support or heavy library machinery
- Effect polymorphism adds type-system complexity
- Multi-shot continuations (for backtracking) have performance implications
- Effect inference can be complex

### Capability-Based Security

**Mechanism**: Unforgeable object references (capabilities) that carry authority. You can only perform an operation if you hold a reference to an object that grants that operation.

**Strengths**:
- Maps naturally to object-oriented and systems programming
- Fine-grained: can revoke individual capabilities without affecting others
- Composable: capabilities can be attenuated (pass a read-only view of a capability)
- Well-studied: decades of OS security research (EROS, seL4, Capsicum, WASI)

**Weaknesses**:
- Runtime rather than compile-time enforcement (unless combined with type system)
- Capability confusion: confused deputy problem still possible
- No static proof of "cannot perform X" — only "does not hold a token for X at runtime"

**The synthesis**: A 2024 paper ["Type, Ability, and Effect Systems: Perspectives on"](https://arxiv.org/pdf/2510.07582) shows that minimal meaningful effect and capability systems are **incomparable** — neither subsumes the other. The paper proposes combining them to get both static guarantees (from effects) and dynamic composability (from capabilities). This is the ideal architecture for an agent runtime.

### Monad-Based Approaches (Haskell IO, ZIO, Cats Effect)

**Mechanism**: Side effects are wrapped in a data type (the monad). Code that describes effects is pure; only the runtime "interpreter" executes them. Composition uses `bind`/`flatMap`.

**Strengths**:
- Mature ecosystem, especially in Haskell and Scala
- Strong static guarantees: IO values are inert until interpreted
- Dependency injection via ZIO's environment type `R`
- Battle-tested in production at scale

**Weaknesses**:
- **The stacking problem**: composing multiple monads requires monad transformers (`ReaderT`, `StateT`, `ExceptT`, etc.), which adds O(n²) boilerplate for n effects
- **Performance**: Free monads are ~30x slower than direct mtl code; even fused-effects libraries have overhead
- **Ergonomics**: `do` notation helps, but complex transformer stacks are hard to reason about
- **"Function color"**: async IO requires either monadic style throughout or effect abstraction

**Algebraic effects vs monads**: Algebraic effects are *strictly more compositional*. Where ZIO builds a "super ZIO monad" combining IO, dependency injection, and error handling into one type parameter triple `ZIO[R, E, A]`, Kyo (a Scala algebraic effects library) allows arbitrary effect stacks with no monad transformer stacking. Research has shown that modular algebraic effects correspond to a specific class of monad transformers — they are theoretically equivalent but algebraic effects present with far better ergonomics for complex effect stacks.

| Property | Effect System | Capabilities | Monads |
|---|---|---|---|
| Static guarantees | Compile-time | Runtime | Compile-time |
| Composability | Excellent (rows) | Good (attenuation) | Poor (transformers) |
| Runtime cost | Low (continuations) | Zero | Low-High (free monads) |
| Language support | Koka, OCaml 5, Unison | WASI, seL4, Rust ZSTs | Haskell, Scala |
| Revocability | Via handler | Via capability | Via interpreter |
| Testability | Swap handlers | Stub capabilities | Swap interpreters |

---

## Real-World Examples

### OCaml 5 + Eio

The `eio` library (1.0 released March 2024) is the most production-ready example of algebraic effects in a real language. It provides effects-based direct-style I/O for OCaml 5 — async I/O without callbacks, without monads, and without the function color problem.

In Eio, the `Eio.Net.t` capability object must be passed explicitly to any function that does networking. The runtime provides this capability at the top level, and it is threaded down through the call stack. A function that does not receive `Eio.Net.t` cannot perform network I/O — this is a runtime capability check with static discipline enforced by explicit parameter passing.

Eio also demonstrates the performance advantage: effects-based I/O avoids heap allocations needed to simulate a stack in the monadic approach, making it significantly faster than equivalent monadic code.

### Scala ZIO's Environment Type

ZIO's `ZIO[R, E, A]` type encodes dependencies in `R`, errors in `E`, and results in `A`. A service that requires database access has type `ZIO[Database, DbError, Result]`. Code that does not have `Database` in scope cannot instantiate such a computation. This is a monad-based approximation of effect typing — the `R` type acts as a capability bundle.

ZIO's `ZLayer` provides dependency injection that looks like effect handling: you provide a `ZLayer[Any, Nothing, Database]` that supplies the database capability, and the runtime wires it to all code that requires it.

### Koka in Agent Control

Koka's row-polymorphic effects make it straightforward to express agent control. An agent reasoning loop might be typed as:

```
type tool-effects = <tool-call, memory-read, memory-write>
fun agent-step(context: Context): <tool-effects, abort> Action
```

A safety governor handler wraps every `tool-call` operation, logs it, checks a policy, and either resumes or aborts. The type system guarantees that `agent-step` can only perform `tool-call`, `memory-read`, `memory-write`, and `abort` — nothing else. Adding a new operation (say `network-access`) to the step function would require adding it to the type signature, which would cascade as a compile error through any handler that doesn't handle it.

### WASI: Capability-Based Security at the System Level

The WebAssembly System Interface (WASI) implements capability-based security at the ABI level. A WebAssembly module cannot access files, network, or system resources unless explicitly granted those capabilities by its host. This is the OS-level version of the same pattern — and it is being used by several AI agent runtimes (LangChain's WASM tools, Cloudflare Workers AI) to sandbox tool execution.

### Tower/Axum Middleware as Effect Handlers

Rust's Tower ecosystem uses `Service<Request, Response=...>` middleware layers that wrap services. Each layer can inspect, transform, allow, or reject requests. This is architecturally an effect handler: the inner service is the "effectful computation," and each middleware layer is a handler that intercepts "requests" (effects) and decides whether to pass them through.

An agent runtime built on Tower can implement a `GovernorLayer` that intercepts all outgoing tool calls, checks policy, logs the operation, and either forwards to the executor or rejects. The composition model is the same as algebraic effect handlers — pure inner service, intercepting outer layers.

---

## Practical Patterns for a Session-Governor-Executor Architecture

### Pattern 1: Capability Token Injection (Recommended for Rust Today)

The Session type is constructed with no capabilities. To perform any tool call, it must request a `ToolGrant` from the Governor, which returns a scoped capability token. The token is a ZST that the Executor accepts as proof of authorization.

```rust
// Session has no tool capabilities
pub struct Session { context: Arc<Context> }

// Governor issues scoped grants
pub struct ToolGrant {
    pub tool: ToolId,
    pub scope: GrantScope,
    pub(crate) _token: ToolGrantToken, // only Governor can construct
}

// Executor requires the grant
impl Executor {
    pub fn execute(&self, grant: ToolGrant) -> impl Future<Output = ToolResult> {
        // type system proves grant was issued by Governor
    }
}
```

### Pattern 2: Effect-Typed Async Channels

Use typed Tokio channels where the message type encodes the effect being requested. The Session sends `EffectRequest<NetworkEffect>` to the Governor channel; the Governor channel only accepts these types and processes them according to policy. This approximates algebraic effect operations over async channels.

### Pattern 3: Typestate Session Lifecycle

Encode the Session's lifecycle states in the type system so that tool execution is only possible in `Approved` state, and `Approved` state can only be reached via the Governor's approval path.

### Pattern 4: Actor Model with Capability Mailboxes

Using Actix or Ractor, the Session actor and Executor actor communicate strictly through typed message passing. The Session actor holds no capability handles — it can only send messages to the Governor actor's address. The Governor actor holds all capability handles (Tokio `TcpStream`, file descriptors, etc.) and acts as the exclusive intermediary.

This is the object-capability model applied to Rust actors: capabilities are held by actors (objects), and only objects that hold a reference to an actor can send it messages (invoke its capabilities).

---

## Limitations and Trade-offs

### Effect Systems

- **Language maturity**: Full algebraic effect systems are only in research languages (Koka, Eff) or experimental features (OCaml 5). Production Rust requires workarounds.
- **Effect inference complexity**: Row-polymorphic effect inference can produce confusing error messages and slow compilation in large codebases.
- **Multi-shot continuations**: Languages like Eff support resuming continuations multiple times (for backtracking), but OCaml 5 deliberately restricts to one-shot for performance. AI agent runtimes may need backtracking (re-trying a tool call with different arguments), which one-shot systems cannot express natively.
- **Async interaction**: Combining algebraic effects with async/await is non-trivial. OCaml 5's Eio works because OCaml's effects replaced the need for async; in Rust, async is already stable and effects would need to compose with it.

### Capability-Based Security

- **Ambient authority leakage**: In languages without capability discipline (including Rust), global statics (`static`, `lazy_static`, `once_cell`) can leak ambient authority. A capability system is only as strong as the language's ability to prevent ambient access.
- **Confused deputy**: Code that holds a capability and accepts untrusted input can still be confused into exercising its capabilities on behalf of an attacker (prompt injection in AI agents is exactly this).
- **Granularity**: Capabilities are binary (you have it or you don't). Expressing "can read files in /tmp but not /home" requires hierarchical or attenuating capability design, which adds complexity.

### Monad-Based Approaches

- **Free monad performance**: Free monad-based effect systems are ~30x slower than direct code. Production Scala ZIO uses a more efficient internal representation, but the fundamental overhead of monad composition cannot be fully eliminated.
- **Transformer stacking**: Real applications with 5+ effect types produce deeply nested monad transformer stacks that are difficult to read, write, and debug.
- **Async boundary**: Monadic code requires the "function color" problem — either everything is monadic or you need explicit lifting at boundaries.

### General Trade-offs

The ideal solution for an AI agent runtime would be:
1. A language with native algebraic effects (for compositional, statically-checked effect governance)
2. A capability-based OS/runtime (for least-privilege at the system level)
3. Hardware-enforced isolation (for true sandboxing of tool execution)

In practice, today's choice is: use Rust with capability tokens + typestate for static discipline, combined with Tower/Axum middleware for runtime interception, running tool execution in WASI sandboxes for OS-level isolation. This layered approach compensates for the absence of native algebraic effects in Rust.

---

## Relevance to Zylos Session-Governor-Executor Architecture

The Session-Governor-Executor model maps directly to the effect handler pattern:

- **Session** = effectful computation that declares which tool effects it needs
- **Governor** = effect handler that intercepts each tool effect operation, applies policy, logs, and either resumes or aborts
- **Executor** = the actual effect implementation (the "real world" side of the handler)

The property Zylos wants — Sessions have zero direct tool access — is exactly what effect systems enforce: if `NetworkEffect` is not in scope, the Session code cannot invoke it. The Governor is the only entity that installs the handler, and therefore the only entity that can authorize execution.

For the current Rust implementation, the recommended approach is:

1. **Capability tokens** for compile-time proof that a tool invocation was authorized by the Governor
2. **Typestate session lifecycle** to enforce that tool execution only occurs after Governor approval
3. **Actor model** (Tokio + message passing) to enforce that Sessions cannot hold direct tool handles
4. **Tower middleware** at the HTTP/service layer for runtime policy interception and audit logging
5. **WASI sandboxing** for Executor processes to enforce OS-level capability discipline

As Rust's effect generics initiative matures, a more native algebraic effect approach may become viable — potentially expressing the entire Session-Governor protocol as an effect type with the Governor as an effect handler, giving compile-time guarantees that no tool effect can escape the Governor boundary.

---

*Sources:*
- [Effect system - Wikipedia](https://en.wikipedia.org/wiki/Effect_system)
- [Algebraic Effects in Modern Languages - tuttlem.github.io](https://tuttlem.github.io/2025/06/27/algebraic-effects-in-modern-languages.html)
- [Algebraic Handler Lookup in Koka, Eff, OCaml, and Unison](https://interjectedfuture.com/algebraic-handler-lookup-in-koka-eff-ocaml-and-unison/)
- [Algebraic Effects for Functional Programming - Microsoft Research](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/08/algeff-tr-2016-v2.pdf)
- [Why Algebraic Effects? - antelang.org](https://antelang.org/blog/why_effects/)
- [The Koka Programming Language](https://koka-lang.github.io/koka/doc/book.html)
- [Koka: Programming with Row-polymorphic Effect Types (arxiv)](https://arxiv.org/pdf/1406.2061)
- [Eio 1.0 Release: Effects-Based I/O Library for OCaml - Tarides](https://tarides.com/blog/2024-03-20-eio-1-0-release-introducing-a-new-effects-based-i-o-library-for-ocaml/)
- [ocaml-multicore/eio - GitHub](https://github.com/ocaml-multicore/eio)
- [Practical Algebraic Effect Handlers in Multicore OCaml - kcsrk.info](https://kcsrk.info/slides/handlers_edinburgh.pdf)
- [Unison Abilities and Ability Handlers](https://www.unison-lang.org/docs/language-reference/abilities-and-ability-handlers/)
- [Trying out Unison part 3: effects through abilities - SoftwareMill](https://softwaremill.com/trying-out-unison-part-3-effects-through-abilities/)
- [Extending Rust's Effect System - Yoshua Wuyts](https://blog.yoshuawuyts.com/extending-rusts-effect-system/)
- [2024-02-09: Extending Rust's Effect System - Keyword Generics Initiative](https://rust-lang.github.io/keyword-generics-initiative/updates/2024-02-09-extending-rusts-effect-system.html)
- [Effect-Generic Bounds and Functions - Keyword Generics Initiative](https://rust-lang.github.io/keyword-generics-initiative/explainer/effect-generic-bounds-and-functions.html)
- [A universal lowering strategy for control effects in Rust](https://www.abubalay.com/blog/2024/01/14/rust-effect-lowering)
- [effing-mad: Algebraic effects for Rust - GitHub](https://github.com/rosefromthedead/effing-mad)
- [The problem of effects in Rust - withoutboats](https://boats.gitlab.io/blog/post/the-problem-of-effects/)
- [PermRust: A Token-based Permission System for Rust (arxiv)](https://arxiv.org/html/2506.11701v1)
- [The Typestate Pattern in Rust - Cliffle](https://cliffle.com/blog/rust-typestate/)
- [What are Effect Systems and Why Do We Care? - idiomaticsoft](https://idiomaticsoft.com/post/2024-01-02-effect-systems/)
- [The Effect Pattern and Effect Systems in Scala - Rock the JVM](https://rockthejvm.com/articles/the-effect-pattern)
- [Cats Effect vs ZIO - SoftwareMill](https://softwaremill.com/cats-effect-vs-zio/)
- [fp-scala-kyo-hello-world: Kyo algebraic effects for Scala](https://github.com/coleea/fp-scala-kyo-hello-world)
- [Monad Transformers and Modular Algebraic Effects: What Binds Them Together (Haskell 2019)](https://www.fceia.unr.edu.ar/~mauro/pubs/haskell2019.pdf)
- [Type, Ability, and Effect Systems: Perspectives on (arxiv 2024)](https://arxiv.org/pdf/2510.07582)
- [Capability-based security - Wikipedia](https://en.wikipedia.org/wiki/Capability-based_security)
- [Object-capability model - Wikipedia](https://en.wikipedia.org/wiki/Object-capability_model)
- [Systems Security Foundations for Agentic Computing (eprint 2025)](https://eprint.iacr.org/2025/2173.pdf)
- [Best Practices for Designing Least-Privilege Access in Agentic Systems](https://hyphenxsolutions.com/Blog/designing-least-privilege-access-for-agentic-workflows/)
- [Practical Security Guidance for Sandboxing Agentic Workflows - NVIDIA](https://developer.nvidia.com/blog/practical-security-guidance-for-sandboxing-agentic-workflows-and-managing-execution-risk/)
- [How Observability-Driven Sandboxing Secures AI Agents - Arize](https://arize.com/blog/how-observability-driven-sandboxing-secures-ai-agents/)
- [fused-effects: A fast, flexible, fused effect system - Hackage](https://hackage.haskell.org/package/fused-effects)
- [Effect Handlers via Generalised Continuations - JFP 2020](https://www.cambridge.org/core/journals/journal-of-functional-programming/article/effect-handlers-via-generalised-continuations/DF590482FEE2F6888CD68B4B446E31D5)
- [ractor: Rust actor framework - GitHub](https://github.com/slawlor/ractor)
