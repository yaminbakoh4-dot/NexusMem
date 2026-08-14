# Contributing to NexusMem

Bug fixes, test coverage, and small focused features are welcome. This file is
what the "Contribution notes" section on individual issues usually points to.

## Before you start

For anything bigger than a one-line fix, comment on the relevant issue with
your approach before opening a PR. If there's no issue yet, open one first.
This avoids two people solving the same gap at the same time, and avoids
building something that gets rejected for scope reasons after the work is
already done.

Keep changes focused. A bug fix doesn't need an accompanying refactor; a test
gap doesn't need new abstractions. Smaller PRs get reviewed faster.

## Setup

Requirements: Node 22 or newer, and git.

```bash
npm ci
```

## Making changes

```bash
npm run typecheck   # tsc --noEmit
npm run build       # tsup -> dist/
npm test            # vitest run
npm run smoke       # builds, packs, installs the tarball, drives the installed CLI
```

All four should pass before you open a PR. CI runs the same four on
`ubuntu-latest` and `windows-latest`, Node 22 and 24 — **Windows is a
first-class target, not an afterthought.** The shell collector is
PSReadLine-first and several fixes in this repo exist only because of faults
Windows produces that Linux never does. If you can only test on one OS, say
so in the PR description rather than assuming the other one behaves the same.

**Prove it red first.** Every behavioral fix or new feature should have a
test that fails against the old code and passes against the new one. A test
that would have passed even with the defect still in place isn't proof of
anything — this codebase has been bitten by that more than once (see
`CHANGELOG.md`/commit history for examples). If you're fixing a bug, write
the failing test before the fix and mention in the PR that you did.

## Commit messages

`type(scope): imperative, lowercase description` — e.g.
`fix(retrieval): stop the generic token "id" from outranking real matches`,
`test(mcp): cover stdio tool calls end to end`. Look at `git log` for more
examples. No hard rule on `scope`; omit it if the change doesn't cleanly
belong to one area (`test: ...`, `docs: ...`, `chore: ...`).

## CHANGELOG.md

Update the `[Unreleased]` section in the same commit as the fix or feature,
not in a follow-up. Match the existing entries' voice: state what broke or
what changed and why, not just what file moved.

## Opening the PR

- If your PR is from a fork, GitHub will hold CI pending a maintainer's
  approval to run — that's normal, not a rejection. It'll get approved
  shortly after you open the PR.
- Describe what changed and why, and how you tested it (which commands you
  ran, and — if you're fixing a bug — how you confirmed the test would have
  caught the original defect).
- No production dependencies should be added without discussing it first in
  the issue.

## What's out of scope for now

The roadmap is intentionally not public. If you want to work on something
substantial that isn't already an open issue, ask first — it may already be
planned differently than it looks from outside, or deliberately deferred.
