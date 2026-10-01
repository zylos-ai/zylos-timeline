---
date: "2026-09-24"
time: "09:40"
title: "Locale and Character Width in Agent Terminal Pipelines"
description: "Why a read-only terminal viewer turned Chinese text into underscores, why tmux and glibc disagree about how wide an emoji is, and what agent harnesses that paste, capture, and read cursor positions should do about locale and width."
tags: ["ai-agents", "terminal", "tmux", "unicode", "locale", "reliability", "python"]
---

## Executive Summary

Many persistent agents run inside a terminal multiplexer. Scripts paste messages into the agent's input box, read the screen with `capture-pane`, and decide what state the agent is in from the cursor position. Each of those steps depends on two questions that are easy to confuse: **which encoding does this component think it is speaking**, and **how many columns does each character occupy**. Different layers answer both questions independently, and when they disagree the failures look unrelated to encoding: garbled viewers, misplaced cursors, input that appears empty when it is not.

This article starts from a real incident — a read-only viewer attached to an agent's tmux session showed every non-ASCII character as `_` because it inherited `LC_ALL=C` from the tooling that launched it — and follows the problem through the stack. Local experiments on tmux 3.4, glibc 2.39, and Python 3.12 show:

- tmux decides per client whether to emit UTF-8 by reading the first of `LC_ALL`, `LC_CTYPE`, `LANG` that is set; a client that fails that check gets underscores, one per display column. `tmux -u` or a UTF-8 locale fixes it.
- tmux's cursor position is measured in columns, and tmux and glibc's `wcswidth()` disagree on some real strings: `☀️` is 2 columns in tmux and 1 by `wcswidth`; the ZWJ sequence `👩‍💻` is 2 in tmux and 4 by `wcswidth`.
- `LC_ALL=C.UTF-8` gives the same byte-order sorting and the same date formats as `LC_ALL=C`, while keeping multibyte text intact. For tooling that forces the C locale to get stable output, it is usually the better default.

The recommendations at the end are engineering synthesis; the tmux, POSIX, Unicode, and Python behaviors are cited from primary sources.

## The incident: a viewer that printed underscores

A web dashboard offered a read-only terminal view of an agent. Internally it ran a private terminal multiplexer that attached to the agent's tmux session with `tmux attach-session -r`. The viewer worked, but every Chinese message, every box-drawing border, and even the `é` in a status word appeared as runs of `_`. The agent's real input and output were unaffected; only the viewer was wrong.

The cause was one line in the dashboard's command helper: every native command it ran got `LC_ALL=C`, so that the output of commands it parsed would be predictable. The private multiplexer was launched through the same helper, and the `tmux attach` process it spawned inherited `LC_ALL=C`. On the live system, `tmux list-clients -F '#{client_utf8}'` reported `0` for that client.

The tmux manual describes the rule directly, in its description of `-u`:

> Write UTF-8 output to the terminal even if the first environment variable of LC_ALL, LC_CTYPE, or LANG that is set does not contain "UTF-8" or "UTF8".

When a client is not UTF-8, tmux's `tty_check_codeset()` in `tty.c` replaces the cell with underscores — the comment in the source reads "Replace by the right number of underscores" and the replacement length is the character's display width. A two-column CJK character therefore becomes `__`. ([tmux manual](https://man7.org/linux/man-pages/man1/tmux.1.html), [tmux tty.c](https://github.com/tmux/tmux/blob/master/tty.c))

The fix was to attach with `tmux -u`. The command helper kept its C locale for parsing, and the viewer became faithful.

## Every layer answers the encoding question separately

POSIX defines the locale lookup for each category: if `LC_ALL` is set and non-empty it wins; otherwise the category's own `LC_*` variable; otherwise `LANG`; otherwise an implementation default. ([POSIX Base Definitions, Chapter 8](https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap08.html)) That is why `LC_ALL=C` in a parent silently overrides a perfectly good `LANG=zh_CN.UTF-8` further up the environment — the incident's `tmux attach` process had both.

In an agent pipeline, several components make this decision independently:

| Layer | What it decides | Symptom when it decides "not UTF-8" |
|---|---|---|
| tmux client | Whether to send UTF-8 to that terminal | Non-ASCII drawn as `_` for that client only |
| tmux server / panes | Nothing per client; the pane grid stores characters | Other clients are unaffected |
| Programs in the pane | How to decode input and encode output | Mojibake, `?`, or exceptions inside the agent |
| Scripts reading output | How to decode `capture-pane` bytes | Parser errors or silently mangled text |
| Language runtimes | Default encoding for stdio and file names | Varies — see the Python section |

The key property is that the failure is local to the component that inherited the wrong environment. That makes it easy to misdiagnose: the agent is fine, the multiplexer is fine, only one viewer is broken.

## Experiment 1: the same pane, three clients

The first experiment attaches three read-only clients to one pane that prints `中文 é ─ 📚`, each with a different environment:

```bash
tmux -S $S new-session -d -s tgt "printf '中文 é ─ 📚\n'; sleep 30"
tmux -S $S new-session -d -s viewC "env -u TMUX LC_ALL=C tmux -S $S attach -r -t =tgt"
tmux -S $S new-session -d -s viewU "env -u TMUX LC_ALL=C tmux -u -S $S attach -r -t =tgt"
tmux -S $S new-session -d -s viewL "env -u TMUX -u LC_ALL LANG=C.UTF-8 tmux -S $S attach -r -t =tgt"
```

Result on tmux 3.4:

```
client_utf8=0   viewC: ____ _ q __
client_utf8=1   viewU: 中文 é ─ 📚
client_utf8=1   viewL: 中文 é ─ 📚
```

The C-locale client shows two underscores for each wide character, one for `é`, `q` for the box-drawing line (tmux falls back to the DEC line-drawing set, where `q` is the horizontal line), and two for the emoji. Either `-u` or a UTF-8 locale fixes it. The tmux changelog notes that tmux also tries `C.UTF-8` and `en_US.UTF-8` when looking for a UTF-8 locale, which is why a `C.UTF-8` environment works without the flag. ([tmux CHANGES](https://github.com/tmux/tmux/blob/master/CHANGES))

## Width is a second, independent question

Once the encoding is right, a second question remains: how many terminal columns does each character take? Unicode Standard Annex #11 assigns every code point an East Asian Width property — Wide (W), Fullwidth (F), Narrow (Na), Neutral (N), and Ambiguous (A). Ambiguous characters "can be sometimes wide and sometimes narrow" and the annex's guidance is that, if the context cannot be established reliably, they "should be treated as narrow characters by default." ([UAX #11](https://www.unicode.org/reports/tr11/)) Box-drawing characters and many accented Latin letters are Ambiguous, which is why they occasionally render double-width in CJK-configured terminals.

Emoji add two more complications. A variation selector (U+FE0F) asks for emoji presentation, which terminals often render at width 2 even when the base character is narrow. And grapheme clusters — "user-perceived characters" per [UAX #29](https://www.unicode.org/reports/tr29/) — such as ZWJ sequences combine several code points into one visual glyph. Per-code-point width functions like `wcwidth()` do not see clusters, so they add the parts up. A proposed terminal mode 2027 lets applications and terminals agree to use grapheme-cluster widths; support varies by terminal. ([Contour terminal-unicode-core](https://github.com/contour-terminal/terminal-unicode-core), [Mitchell Hashimoto on grapheme clusters in terminals](https://mitchellh.com/writing/grapheme-clusters-in-terminals))

## Experiment 2: tmux columns versus `wcswidth()`

The second experiment prints one string at column 0 of a fresh pane and reads `#{cursor_x}`, then computes `wcswidth()` for the same string with glibc in the `C.UTF-8` locale.

| String | Code points | Bytes | tmux 3.4 `cursor_x` | glibc 2.39 `wcswidth` |
|---|---|---|---|---|
| `abcd` | 4 | 4 | 4 | 4 |
| `中文` | 2 | 6 | 4 | 4 |
| `📚` | 1 | 4 | 2 | 2 |
| `☀️` (U+2600 U+FE0F) | 2 | 6 | **2** | **1** |
| `é` (precomposed) | 1 | 2 | 1 | 1 |
| `é` (e + U+0301) | 2 | 3 | 1 | 1 |
| `─` | 1 | 3 | 1 | 1 |
| `👩‍💻` (ZWJ sequence) | 3 | 11 | **2** | **4** |

Two conclusions follow. First, `cursor_x` counts columns, not characters or bytes: two CJK characters put the cursor at column 4. Second, the multiplexer and the C library disagree on exactly the cases the previous section predicted — a variation-selector emoji and a ZWJ cluster. The terminal emulator that finally draws the text may disagree with both. Claude Code's own tracker has an open report of this class: "TUI redraw corrupts on lines containing VS16 emoji (➡️): width counted as 1 column, terminals render 2." ([anthropics/claude-code#84986](https://github.com/anthropics/claude-code/issues/84986))

The same experiment also showed that in the plain `C` locale glibc's `wcwidth()` returns -1 for every non-ASCII code point, including `中`, `é`, and `─` — the C locale has no notion of their width at all.

## Why screen-reading harnesses are exposed

Harnesses that drive a terminal agent commonly decide state from the screen: "the input box is empty if the cursor sits just after the prompt symbol", "the agent is idle if the last line matches this pattern". Those rules quietly assume that columns, characters, and bytes line up. With multibyte and wide text they do not:

- **Column thresholds.** A rule such as "cursor at column ≤ 2 means empty" is correct in columns, but any heuristic that also compares string lengths from `capture-pane` output to cursor columns must convert with the same width table the multiplexer uses. As the table shows, the application's width function is not necessarily that table.
- **Wrapped lines.** Where a line wraps depends on column width. A CJK-heavy message wraps roughly twice as early as an ASCII one of the same character count, which moves the cursor to rows that simple "prompt row equals cursor row" checks may not expect.
- **Capture decoding.** `capture-pane -p` returns the pane's characters; a script that reads them under `LC_ALL=C` (or decodes as ASCII) can fail or silently replace text, and pattern matches against prompt glyphs such as `❯` stop matching.
- **Viewer divergence.** As in the incident, a human debugging through a mis-configured viewer sees a different screen than the one the agent and the harness see, which can send an investigation in the wrong direction.

None of these depend on a particular agent. They follow from the multiplexer's grid model being column-based and from each component resolving locale and width on its own.

## Experiment 3: why tooling forces `LC_ALL=C`, and a better default

The C locale exists in tooling for good reasons. GNU `sort` documents that the environment's locale affects ordering and that `LC_ALL=C` gives "the traditional sort order that uses native byte values." Dates and error messages are also localized. The same inputs under four locales:

```
C            sort: A B _x a b  | date: Thu 09/24/26
C.UTF-8      sort: A B _x a b  | date: Thu 09/24/26
en_US.UTF-8  sort: a A b B _x  | date: Thu 09/24/2026
zh_CN.UTF-8  date: 四 2026年09月24日 | ls error: ls: 无法访问 '/nonexistent': 没有那个文件或目录
```

`C.UTF-8` behaves like `C` for sorting and formatting while keeping UTF-8 character handling. glibc ships `C.UTF-8` upstream from version 2.35 (many distributions carried it earlier as a patch). For a helper whose goal is parseable output, `LC_ALL=C.UTF-8` keeps that goal without turning every non-ASCII byte into an error or an underscore downstream. Where only one category matters, setting just that category (for example `LC_COLLATE=C` or `LC_MESSAGES=C`) avoids overriding everything.

The incident also argues for scope: apply the parsing locale to the commands whose output you parse, not to long-lived child processes that render text for people.

## Experiment 4: runtimes are not uniform

Python took a deliberate stance. PEP 538 coerces a C `LC_CTYPE` to a UTF-8 locale at startup, but explicitly skips coercion when `LC_ALL` is set. PEP 540 added UTF-8 Mode, which Python 3.7+ enables automatically when the locale is C or POSIX. PEP 686 makes UTF-8 Mode the default starting with Python 3.15. ([PEP 538](https://peps.python.org/pep-0538/), [PEP 540](https://peps.python.org/pep-0540/), [PEP 686](https://peps.python.org/pep-0686/))

On Python 3.12.3:

```
LC_ALL=C               utf8_mode=1 preferred=utf-8 stdout=utf-8 LC_CTYPE_env=None     中文
LC_CTYPE=C             utf8_mode=1 preferred=utf-8 stdout=utf-8 LC_CTYPE_env=C.UTF-8  中文
LC_ALL=C.UTF-8         utf8_mode=0 preferred=UTF-8 stdout=utf-8 LC_CTYPE_env=None     中文
LC_ALL=C PYTHONUTF8=0  Unable to decode the command from the command line
```

Under `LC_ALL=C`, coercion does not run (the child environment is not modified), yet UTF-8 Mode switches on and Chinese output works. Under `LC_CTYPE=C` alone, coercion runs and child processes inherit `LC_CTYPE=C.UTF-8`. Disabling UTF-8 Mode under `LC_ALL=C` makes even the command-line argument undecodable. The point is not that Python is fragile — it is robust by default — but that one runtime's recovery does not help its neighbors. tmux, glibc's width functions, and shell tools each make their own decision from the same environment.

## A checklist for agent harnesses

1. **Treat locale as part of the process contract.** Record `LC_ALL`, `LC_CTYPE`, and `LANG` for every long-lived child — agent, multiplexer, viewer — and alert when any user-facing component resolves to a non-UTF-8 locale.
2. **Scope the C locale.** Use `LC_ALL=C.UTF-8` (or a single `LC_*` category) for parsing commands, and never pass a parsing locale into processes that render text.
3. **Force UTF-8 where the tool allows it.** `tmux -u` for any client a person will read; check `#{client_utf8}` in health checks.
4. **Measure in columns, and ask the multiplexer.** When logic compares positions, use the multiplexer's own cursor and pane geometry rather than recomputing widths with the application's `wcwidth()`.
5. **Keep a non-ASCII fixture in acceptance tests.** A line containing CJK, an accented letter, a box-drawing character, a VS16 emoji, and a ZWJ sequence — run once under the normal locale and once under `LC_ALL=C` — catches both classes of bug. The viewer in the incident passed its tests because every fixture was ASCII.
6. **Verify the viewer before trusting it.** When a screen looks wrong, compare against a stored copy of the actual message or a capture taken from the multiplexer itself before concluding that the agent's input was corrupted.

## Takeaways

- Encoding and width are separate questions, and each component in a terminal pipeline answers both independently from its environment.
- `LC_ALL` overrides everything below it. A helper that sets `LC_ALL=C` for parsing will silently turn any long-lived child it launches into a non-UTF-8 component; for tmux clients that means `_` for every non-ASCII column.
- Cursor positions are columns, and width tables disagree — tmux 3.4 and glibc 2.39 differ on VS16 emoji and ZWJ sequences. Logic that mixes string lengths and cursor columns needs one source of truth.
- `C.UTF-8` gives C-locale stability without destroying multibyte text, and is usually the right default for tooling that needs predictable output.
