# NexusMem vs. projectmem

**Status:** written 2026-08-16, against `riponcm/projectmem` as it existed that day (commit history through
`3d8e3f3`, cloned and read in full — not judged from its README alone). Re-check before quoting this later;
a fast-moving project's numbers age.

projectmem is a real, working competitor, not a strawman: 705 GitHub stars vs. NexusMem's 8 at the time of
writing, a git pre-commit warning system that actually works, and an arXiv paper
([2606.12329](https://arxiv.org/abs/2606.12329)) backing a 207-event dogfooding study. This document exists
to give an honest, source-level comparison — where NexusMem is ahead, where it isn't, and where the two
measure different things entirely.

## Scale, as of 2026-08-16

| | NexusMem | projectmem |
|---|---|---|
| GitHub stars | 8 | 705 |
| Forks | 3 | 37 |
| Language | TypeScript | Python |
| Install | `npx nexusmem` | `pip install projectmem` |
| Research paper | none | [arXiv:2606.12329](https://arxiv.org/abs/2606.12329) |

projectmem is ahead here by a wide margin. Anyone reading this as "NexusMem is winning" would be reading it
wrong — this document is about which specific technical claims hold up, not about overall project traction.

## Failure-tracking: both real, different shapes

Both projects track failed attempts and try to stop you repeating them. Neither invented this idea first in
any provable sense; what differs is mechanism and timing.

**projectmem** (`src/projectmem/commands/precheck.py`, read in full): a real git pre-commit hook, installed
automatically at `pjm init`, that checks staged files against typed events (`issue`/`attempt`/`fix`/`decision`)
in an append-only `events.jsonl` log. Warns on unresolved failed attempts, open issues, high git churn, recent
reverts, and possibly-stale memories citing the file — *before* you commit, without you asking.

**NexusMem** (this release): `nexusmem precheck` matches a file's own basename tokens against unresolved
`shell_command` failures (no `resolved_by:*` link from `sync --link-failures`), using the same corpus-relative
boilerplate filter the discussion-bridge heuristic already validated (see `src/correlate/precheck.ts`), plus
git-commit churn from `node_files`. `nexusmem hook git install` wires this into a real
`.git/hooks/pre-commit`, same automatic timing as projectmem's.

The real, disclosed difference: projectmem's events are **explicit** — a developer (or their agent) runs
`pjm issue`/`pjm attempt`/`pjm fix` to record them. NexusMem's failures are **inferred** from real shell exit
codes, no explicit logging step required, but only as reliable as exit-code capture and the token-match
heuristic — a failure whose command doesn't share words with the file's name won't be found. Neither is
strictly better; they trade explicit-and-precise for automatic-and-approximate.

## Import-graph / structure: both now cross into the other's primary language, at different scope

**Update 2026-08-22:** this section was written 2026-08-16, when NexusMem's import graph was JS/TS-only and
the claim below ("neither tool resolves the other's primary language") was true. It no longer is. Left the
rest of this document's dated snapshots (the stars/forks table, the token-savings numbers) untouched per its
own standing practice of re-verifying before quoting rather than guessing forward — but a claim about current
*capability*, still stated in the present tense, needed correcting rather than silently going stale.

projectmem's `src/projectmem/structure.py` (read 2026-08-16, not re-checked since) builds a file tree across
20+ languages/extensions for its dashboard, but the actual import-edge resolver, `_python_relationships`, only
parsed `.py` via `ast` as of that date. A JS/TS/Go/Rust project got projectmem's file tree with **zero**
relationship edges — confirmed by reading the function, not inferred from behavior, at the time.

NexusMem's `nexusmem scan-structure` has since grown from JS/TS-only to seven languages — JS, TS, Python, Go,
Rust, Java, PHP — all five new ones added in `v0.6.0`, with Python's coverage extended again in `v0.7.0`
(the bare-import fix below), both after this document was first written. Each
extractor/resolver pair is deliberately scoped narrower than "full" resolution, the same missed-edge-over-
wrong-edge discipline the original JS/TS resolver established: Go resolves an internal import to every
non-test file in the target package directory; Rust covers explicit `mod` declarations, not inline `mod { }`
blocks; Java refuses an ambiguous wildcard import instead of guessing which of two same-named packages it
means; PHP resolves only `__DIR__`-anchored `require`/`include`. Python specifically covers PEP 328 relative
imports (`from .foo import bar`) and bare same-directory sibling imports (`import foo`), guarded against a
~180-name stdlib list so a project's own `queue.py` can't shadow the real module — a *dotted* absolute import
referencing the project's own top-level package (e.g. `from f5_tts.cleantext import x`, a Google-style-guide-
preferred convention) is still out of scope; the same unambiguous-suffix-match technique already used for Java
would close it, but that specific fix was proposed and explicitly declined, not forgotten.

**Live-verified today (2026-08-22), against real third-party Python repositories, not synthetic fixtures:**
`ComfyUI-Manager` (a real, popular ComfyUI extension on this machine) resolves 18 real Python edges among 40
total; a smaller real Python project resolves 4. Both correctly produce **zero** edges for genuinely external
runtime imports the tracked-path set doesn't contain (`folder_paths`, `nodes`, stdlib modules) — the same
discipline holding at real-repo scale, not just synthetic. This repo's own JS/TS-only codebase, re-scanned the
same day: 535 edges from 171 tracked files (up from the original 104-file/330-edge count as the repo grew,
same measurement, not a different one).

**Still true, updated framing:** neither tool has full parity with the other's native-language resolver — projectmem's
`ast`-based Python parser is more complete for Python specifically than NexusMem's regex-based one, while
NexusMem now resolves four languages (Go, Rust, Java, PHP) `_python_relationships` never touches at all, as of
the one date that function was read. Re-read `structure.py` before repeating either half of that claim if this
document is revisited again — this is exactly the kind of comparative claim that ages fastest.

## Token savings: measured vs. estimated

**NexusMem**, re-run fresh today rather than quoted from an old table — this project's own standing practice
is to re-check a number before repeating it, not trust that an old measurement still holds:

```
npm run bench -- --corpus nexusmem,vite --vite-root <local vite clone>
```

| Corpus | vs. full-file-read | vs. `git log -p` | Queries |
|---|---|---|---|
| this repo (115 commits as of this run) | 95.1% aggregate | 97.7% aggregate | 12 |
| `vitejs/vite` (9,567 commits) | 98.8% aggregate | 99.9% aggregate | 12 |

Raw per-query output is machine- and run-dependent and deliberately gitignored (`/bench/results/`, same as
every other benchmark run) — the reproducible artifact is [`scripts/benchmark.ts`](../scripts/benchmark.ts)
itself, not a committed JSON file; re-run the command above to get your own. Methodology and its own honest
limits (the file set is NexusMem's own ranking, not an independent judge) are in the README's
[`## What it costs you`](../README.md#what-it-costs-you) section — that caveat applies here too; this is
packing savings once retrieval already picked a candidate set, not proof the set was the right one.

**projectmem**'s `pjm score` (`src/projectmem/commands/score.py`, read in full) computes a "Failure Prevention
Score" — hours saved, tokens prevented, dollars protected — as **fixed constants multiplied by event counts**,
not a measurement against any real baseline:

```python
HOURS_PER_FAILED_APPROACH = 0.5    # 30 min saved per documented dead-end
HOURS_PER_FIX_WITH_CONTEXT = 0.25  # 15 min saved per fix with file context
HOURS_PER_DECISION = 0.15          # 9 min saved per documented decision
HOURS_PER_CHURN_FLAG = 0.75        # 45 min saved per churn alert
TOKENS_PER_FAILED_APPROACH = 3000  # tokens to rediscover a dead-end
TOKENS_PER_CONTEXT_REBUILD = 2000  # tokens to rebuild context from scratch
TOKENS_PER_DECISION = 500          # tokens to re-derive a decision
USD_PER_MILLION_TOKENS = 10.0      # average $/1M tokens
```

These are reasonable-sounding guesses, stated as such by their own variable names — not verified against an
actual baseline the way NexusMem's benchmark measures real full-file/full-history token counts for the exact
files a query's answer touches. "We measure against real full-file reads at real scale; projectmem estimates
with assumed constants" is the accurate claim here, not "projectmem's numbers are fake" — they're a different
kind of number (a rough ROI estimate) being used for a claim (token/cost savings) that reads as measured.

## What this document is not

Not a claim that NexusMem is the better tool overall — projectmem has 88x the GitHub stars, a published paper,
a working dashboard, and a feature (explicit issue/decision tracking) NexusMem doesn't attempt. It's a
source-level record of three specific technical claims, checked against real code on both sides, as of one
date. Re-verify before repeating any number here.
