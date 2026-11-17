---
date: "2026-10-19"
time: "09:00"
title: "Shell Pipeline Success Is Not Task Success: Evidence for Agent Tooling"
description: "Reproduced Bash cases show how logging pipelines hide failures, why pipefail needs stage-level evidence, and how agents can validate completion without mistaking readable output for success."
tags: ["research", "shell", "bash", "agent-tooling", "reliability", "testing"]
---

## Executive Summary

An agent runs a release command, saves its output through `tee`, and receives exit status zero. The log contains “release started.” Can it report completion? No: the producer may have failed while the logger succeeded. Even when every pipeline stage succeeds, the expected artifact may still be wrong.

This article proposes a small evidence contract for Bash-based agent runners: preserve the overall status and each pipeline stage's status immediately, collect explicitly managed asynchronous consumers, and validate the requested result separately. It is a proposal for tool authors, not a claim that an existing agent platform implements it. The examples use harmless substitute commands in isolated directories; they do not perform releases.

The distinction matters after command parsing is already correct. Safe quoting answers whether the intended command ran. Outcome evidence answers whether that command accomplished the intended task.

## One Log, Two Different Outcomes

Bash normally reports the final command's exit status for a foreground pipeline. With `pipefail`, it instead reports the rightmost nonzero stage status, or zero when all stages succeed. “Rightmost” means pipeline position, not which process failed last in time. These semantics are defined in the [Bash pipeline documentation](https://www.gnu.org/software/bash/manual/html_node/Pipelines.html).

Run this in a fresh directory under Bash:

```bash
set +e
set +o pipefail
bash -c 'printf "release started\n"; exit 7' | tee build.log
snapshot=( "$?" "${PIPESTATUS[@]}" )
printf 'overall=%s producer=%s tee=%s\n' "${snapshot[@]}"
```

The observed output was:

```text
release started
overall=0 producer=7 tee=0
```

The file exists and contains the visible message. Neither fact establishes producer success. Replacing `set +o pipefail` with `set -o pipefail` produced `overall=7 producer=7 tee=0`. Logging did its job in both cases; the release substitute failed in both cases.

A second experiment used three stages exiting `7`, `9`, and `0`. With `pipefail`, the overall result was `9`, while the saved stage vector was `7,9,0`. This makes the scalar useful for a broad failure gate, but insufficient for explaining which operations failed. A runner should retain stage identities alongside the vector: “producer=7, formatter=9, logger=0” is more actionable than “command failed: 9.”

## Capture the Evidence Before Reporting It

Bash exposes the preceding foreground pipeline's individual statuses through `PIPESTATUS`. It updates this array after simple commands too. A diagnostic `printf`, or even an assignment, can replace the evidence being inspected. The behavior is documented under [Bash variables](https://www.gnu.org/software/bash/manual/html_node/Bash-Variables.html).

This tempting sequence loses the vector:

```bash
set +e
set -o pipefail
bash -c 'exit 7' | cat
rc=$?
stages=( "${PIPESTATUS[@]}" )
printf 'overall=%s stages=%s\n' "$rc" "${stages[*]}"
```

It printed `overall=7 stages=0`. The scalar was saved correctly, but the successful `rc=$?` assignment became the command described by `PIPESTATUS`.

Use the single array assignment shown in the first example. Both parameter expansions happen as part of that command before its completion replaces the status information. Element zero is the overall result; subsequent elements correspond to the pipeline stages. This is a Bash-specific technique, not portable POSIX `sh` syntax. Bash documents assignment expansion in [Simple Command Expansion](https://www.gnu.org/software/bash/manual/html_node/Simple-Command-Expansion.html).

The sample scripts deliberately disable `errexit` so failure reaches the capture line. They also finish with a successful reporting command, so the demonstration script's own exit can be zero even when its recorded pipeline failed. A production runner must explicitly return its chosen outcome after persisting evidence. Otherwise the final diagnostic recreates the original problem one level higher.

## An Early Reader Changes What Failure Means

Adding `pipefail` is useful, but it cannot decide application intent. Consider:

```bash
set +e
set -o pipefail
yes match | grep -q match
snapshot=( "$?" "${PIPESTATUS[@]}" )
printf 'overall=%s yes=%s grep=%s\n' "${snapshot[@]}"
```

The result was `overall=141 yes=141 grep=0`. The search found a match and exited. The producer then wrote to a pipe without a reader and received `SIGPIPE`. Linux documents that behavior in [pipe(7)](https://man7.org/linux/man-pages/man7/pipe.7.html); Bash represents fatal signals using 128 plus the signal number, as described in its [manual](https://man7.org/linux/man-pages/man1/bash.1.html).

GNU grep explicitly warns that early termination can make an upstream command fail. Its [performance documentation](https://www.gnu.org/software/grep/manual/html_node/Performance.html) gives this same class of interaction. A finite control, `seq 1 100000 | grep 1 > /dev/null`, returned zero for both stages in this environment.

For an existence query, an early match may satisfy the request. For a build, backup, or export, terminating the producer early may prevent required work. Do not globally translate status 141 into success. Decide whether early termination is allowed for this particular stage, and still inspect other failures.

When producer completion matters, a simple alternative is to capture its output completely and then search the resulting file. That costs storage and delays the search, but removes the searcher's early exit from the producer's output path. The search itself also needs interpretation: GNU grep uses zero for a match, one for no match, and ordinarily two for an error. With `-q`, finding a match can still return zero even if an error occurred; see its [exit-status contract](https://www.gnu.org/software/grep/manual/html_node/Exit-Status.html).

## Logging Branches Need Their Own Completion Evidence

A pipeline vector covers pipeline stages. It does not turn every process substitution into an additional stage. Bash runs process substitutions asynchronously, so a logger or validator launched with `>(...)` needs explicit ownership if its completion affects success. See [Process Substitution](https://www.gnu.org/software/bash/manual/html_node/Process-Substitution.html) and the [`wait` builtin](https://www.gnu.org/software/bash/manual/html_node/Job-Control-Builtins.html).

This bounded example opens a dedicated descriptor, saves the substitution's process ID immediately, closes the writer, and waits for that exact process:

```bash
set +e
set -o pipefail
exec {sink}> >(bash -c 'cat > audit.log; exit 9')
sink_pid=$!
printf 'payload\n' | tee /dev/fd/"$sink" > visible.log
snapshot=( "$?" "${PIPESTATUS[@]}" )
exec {sink}>&-
wait "$sink_pid"
sink_rc=$?
printf 'pipeline=%s producer=%s tee=%s sink=%s\n' \
  "${snapshot[@]}" "$sink_rc"
cmp visible.log audit.log
printf 'bytes_equal=%s\n' "$?"
```

Observed: `pipeline=0 producer=0 tee=0 sink=9`, followed by `bytes_equal=0`. Both files contained identical bytes, but the required consumer failed after reading them. The pipeline's zero did not account for its exit. Closing the descriptor before waiting lets the consumer observe end-of-file; retaining a writer could make a reader wait indefinitely. Production code also needs error handling for descriptor setup, cancellation, and a bounded wait. This example demonstrates collection, not a complete process supervisor.

GNU `tee` has a separate policy decision: what should happen when an output pipe closes early? Its default behavior can terminate copying. The `-p` option uses a mode designed to continue with remaining outputs when a pipe reader exits early, while still diagnosing failures on non-pipe outputs. The [GNU tee manual](https://www.gnu.org/software/coreutils/manual/html_node/tee-invocation.html) explains these output-error modes.

In a local test, `seq` generated 200,000 lines while one `tee` destination read only the first line. Default `tee` terminated with status 141, leaving the main file incomplete. With `tee -p`, both pipeline stages returned zero and the main file contained all 200,000 lines. The exact truncated length depends on scheduling and buffering; it is not a guaranteed threshold. This option protects continued copying under the chosen policy. It does not prove that the early consumer performed its intended work.

## Why `set -e` Is Not the Evidence Contract

Bash's `errexit` behavior depends on syntax and calling context. Among its exceptions are commands tested by `if`, and portions of `&&` and `||` lists. Functions invoked where `-e` is ignored can continue after a failed internal command. These rules appear in [The Set Builtin](https://www.gnu.org/software/bash/manual/html_node/The-Set-Builtin.html).

The following test printed both `continued` and `accepted`, then exited zero:

```bash
set -e
work() { false; printf 'continued\n'; }
if work; then printf 'accepted\n'; fi
```

Calling the same function directly instead produced no output and exited one. Consequently, moving an operation into a conditional can change its failure behavior. Treat `set -e` as a control-flow convenience whose scope must be understood. Use explicit checks for operations whose success a tool will claim, and preserve diagnostics before subsequent commands overwrite them.

## A Small Contract for Agent Runners

For the representative release task, a useful result record would contain:

| Evidence | What it can establish |
| --- | --- |
| Overall status and named stage statuses | Which foreground processes reported failure |
| Explicitly collected consumer statuses | Whether required asynchronous consumers completed successfully |
| Captured output and log location | What was emitted and where to inspect it |
| Artifact validation tied to this invocation | Whether the requested output satisfies its defined checks |
| Cancellation or incomplete-collection state | Whether the runner lacks a terminal result |

The first practical change can be narrow: improve one Bash adapter that currently wraps a producer in `tee`. Name its stages, capture the status array immediately, and make its success rule explicit. Avoid introducing a universal “ignore SIGPIPE” rule or assuming every logger is optional. Tool authors must choose whether losing a required audit log invalidates the task.

Artifact validation is a separate gate. A control that successfully wrote `release started` to a file yielded pipeline status zero but failed an exact-line check for `release complete`. Changing the content to the expected line made the validation pass. This deliberately tiny oracle proves the test can distinguish those inputs; a real release requires stronger checks, such as the expected version and manifest, plus whatever deployment observation the task actually requires.

A hash alone establishes bytes relative to a reference, not semantic correctness. File existence alone may describe an old artifact. Prefer invocation-specific output locations or other explicit provenance, and state which validation ran. If a required process status or result check is missing, report the outcome as incomplete rather than filling the gap with an optimistic summary.

## Validation Scope and Sources

Thirteen isolated cases were run on GNU Bash 5.2.21, GNU coreutils 9.4, GNU grep 3.11, and Linux on aarch64. They included failure and success controls, status clobbering, early consumers, explicit waiting, conditional `errexit`, and artifact mismatch. These are local demonstrations, not benchmarks or portability tests for other shells, operating systems, or tool versions.

Primary references:

- GNU Bash: [pipelines](https://www.gnu.org/software/bash/manual/html_node/Pipelines.html), [variables](https://www.gnu.org/software/bash/manual/html_node/Bash-Variables.html), [assignment expansion](https://www.gnu.org/software/bash/manual/html_node/Simple-Command-Expansion.html), [process substitution](https://www.gnu.org/software/bash/manual/html_node/Process-Substitution.html), [`wait`](https://www.gnu.org/software/bash/manual/html_node/Job-Control-Builtins.html), and [`set`](https://www.gnu.org/software/bash/manual/html_node/The-Set-Builtin.html).
- GNU coreutils: [`tee` output-error handling](https://www.gnu.org/software/coreutils/manual/html_node/tee-invocation.html), cross-checked against the [upstream manual source](https://github.com/coreutils/coreutils/blob/master/doc/coreutils.texi).
- GNU grep: [early-input termination](https://www.gnu.org/software/grep/manual/html_node/Performance.html) and [exit status](https://www.gnu.org/software/grep/manual/html_node/Exit-Status.html).
- Linux man-pages: [pipe behavior](https://man7.org/linux/man-pages/man7/pipe.7.html); [Bash manual mirror](https://man7.org/linux/man-pages/man1/bash.1.html).
