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

## Import-graph / structure: NexusMem covers what projectmem's own code doesn't

projectmem's `src/projectmem/structure.py` (read in full) builds a file tree across 20+ languages/extensions for its
dashboard, but the actual import-edge resolver, `_python_relationships`, only parses `.py` via `ast`. A
JS/TS/Go/Rust project gets projectmem's file tree with **zero** relationship edges — confirmed by reading the
function, not inferred from behavior.

NexusMem's `nexusmem scan-structure` (this release) resolves relative `import`/`export ... from`/`require`/
dynamic-`import` specifiers across `.ts`/`.tsx`/`.js`/`.jsx` files, including the common TS/ESM convention of
writing `./foo.js` in source that is actually `foo.ts`. Dependency-free regex extraction, not an AST parser —
a deliberate trade for staying lightweight, with known, disclosed limitations (a specifier inside a comment or
string is still picked up; non-static forms like a computed `import()` path are invisible). Live-verified
against this repo's own 104 tracked TS/JS files: 330 real edges, spot-checked against known imports.

Neither tool currently resolves the other's primary language. This is a real, current gap on projectmem's
side for TS/JS projects, not a permanent one — nothing here claims Python support is hard to add.

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
