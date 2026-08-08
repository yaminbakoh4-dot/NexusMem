# NexusMem

[![License: MIT](https://img.shields.io/badge/license-MIT-informational)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen)
![Status](https://img.shields.io/badge/phase%201-feature--complete-blue)

> A local-first persistent memory engine — an **SSD for AI coding agents**.

AI coding assistants (Claude Code, Cursor, MCP-based agents, ...) forget
everything the moment a session ends, and re-uploading the whole repo as
context on every request is slow and expensive. NexusMem records what
actually happened on your machine — git history and shell command history —
into a small local database, then hands your agent back **only the slice of
context that's actually relevant** to the question in front of it.

**Nothing leaves your machine.** No cloud, no account, no API key.

## Features

- 🔒 **100% local-first.** SQLite on disk, in `.agent-ssd/` inside your repo.
  No network calls, no telemetry, works fully offline.
- 🔍 **Real full-text search**, not string matching — SQLite FTS5 with BM25
  ranking over every commit and shell command ever ingested.
- 📜 **Git collector** — every commit, its diff stats, renames, and a
  conventional-commit-aware importance score, all derived at ingest time.
- 💻 **Shell collector** — PSReadLine on Windows out of the box, `.bash_history`
  / `.zsh_history` elsewhere, plus an opt-in PowerShell hook that upgrades
  capture to exact timestamp + cwd + exit code (a failed command outranks a
  passing one automatically).
- 🎯 **Ranked, budgeted retrieval** — `relevance × structural signal ×
  recency`, packed to fit whatever token budget you give it. Designed so
  that at real repo scale, irrelevant history is left out entirely rather
  than summarized down — that's where the token savings actually come from
  (see [Benchmarks](#benchmarks) for honest, measured numbers, not a marketing
  figure).
- 🧩 **Kind-agnostic core.** Every source normalizes to one `MemoryNode`
  shape, so a shell command and a git commit rank on a level field.

## Quick start

**Requirements:** Node.js ≥ 20.11, Git, and a shell — PowerShell is the
primary target on Windows; bash/zsh are supported elsewhere.

```bash
git clone https://github.com/yaminbakoh4-dot/agent-ssd.git
cd agent-ssd
npm install
npm run build
npm link
```

`npm link` puts `agent-ssd` on your `PATH`, so it works from any repo on your
machine — you're not limited to running it from inside this folder.

```bash
cd path/to/some/other/git-repo
agent-ssd init
agent-ssd sync
agent-ssd query "why does the retry logic exist"
```

```
Relevant history for: why does the retry logic exist

- 2026-08-02 test: add coverage for the retry logic
  The retry path had zero tests and had regressed twice already.
- 2026-07-28 fix: race condition when two saves happen concurrently
  Last-write-wins was silently dropping the earlier write instead of erroring.
```

Optional, for much higher-quality shell context (real cwd + exit code instead
of an approximation):

```bash
agent-ssd hook install
```

This edits your PowerShell profile to log every command's timestamp, cwd and
exit code to a small local JSONL file. It wraps your existing prompt rather
than replacing it, is fully idempotent, and `agent-ssd hook remove` undoes it
cleanly. Nothing is installed without you running this yourself.

## Architecture

```
git / shell            collectors/          core/               store/            retrieval/
   raw events    ->    normalize to   ->   MemoryNode    ->    SQLite      ->    rank + pack
                       one shape                                (FTS5)          within a token budget
```

Every collector normalizes to a single `MemoryNode` shape, so storage, search
and context-packing never need to know where a fact came from.

### Design decisions

**Content-addressed ids.** `id = sha256(projectId + kind + naturalKey)`.
Running `sync` twice can never produce duplicates, so ingestion stays correct
even if a cursor is lost or history is rewritten.

**Stable project identity.** Derived from the normalized `origin` URL when
there is one, falling back to the absolute path. Two clones of the same repo
— on two machines, over ssh and https — share one memory namespace.

**`signal` computed at ingest, not at query.** Every node carries a 0..1
structural-importance score. Retrieval ranks by `relevance × signal`, which is
what stops a `chore: bump deps` from eating the budget a `fix:` deserves.

**Score = relevance × signal × recency, each floored, never zeroed.** Each
factor lives in `[floor, 1]`, not `[0, 1]` — multiplying three `[0,1]` terms
lets any one of them crush the other two to nothing, so a perfectly relevant
five-year-old commit would lose outright to a barely-relevant one from this
morning. Floors turn each factor into a *reordering* instead of a gate.

**Keyword search before vector search.** Phase 1 uses SQLite FTS5/BM25.
Developer queries are keyword-heavy (file names, symbols, error strings) —
exactly where BM25 beats embeddings. `sqlite-vec` + a local Ollama embedding
model arrive in Phase 2 as *hybrid* retrieval, not as a replacement.

**Streaming collectors.** `git log` is parsed incrementally from a stream, and
breaking out of the iterator kills the child process — `--limit` never pays
for the full history. Ingestion batches into transactions rather than
materializing the whole history first.

**Cursors are validated, not trusted.** `sync` stores the HEAD sha it reached.
On the next run it checks that the cursor is still an ancestor of HEAD; after
a rebase or amend it is not, so the walk widens to a full history re-scan
instead of silently skipping commits. Content-addressed ids make the
redundant work free.

**Two quality tiers for shell history, one collector.** Zero-config,
NexusMem scrapes whatever history file your shell already keeps. These files
carry no cwd, so entries can't be correctly scoped to one project — they're
attributed to whichever repo you happen to run `sync` from, which is an
approximation, not a guarantee. `agent-ssd hook install` logs the real
timestamp, cwd and exit code instead; once that log exists, the noisier raw
scrape is skipped automatically. A failed command scores meaningfully higher
than the same command succeeding — a build that just broke is exactly the
context an agent should see first.

**The workspace ignores itself.** `.agent-ssd/` contains its own `.gitignore`
with `*`, so `init` never edits a file in a repo it does not own.

## Benchmarks

The project's target is **>70% lower token spend** than sending raw history,
at real repo scale. Here is the honest, currently-measured picture, not a
projection:

| Scenario (23-commit fixture repo) | Result |
| --- | --- |
| Tight budget, 3 matches, 1 dropped entirely | **25% saved** |
| Generous budget, 6 matches, all kept | **~15% *more*** (fixed per-node formatting overhead outweighs the little there was to trim) |

The mechanism is structural, not compression: packing a single small node
barely shrinks it — the summary is already close to the raw body. The real
saving is that once a query has more relevant candidates than the token
budget allows, the low-score ones are **left out entirely**. At real repo
scale — hundreds of commits, a handful actually relevant to any one
question — the win is dropping the hundreds, not shaving the handful. The
23-commit fixture above is too small to demonstrate that regime; a proper
benchmark against a real, large repository is on the roadmap.

## Layout

```
src/
  core/          MemoryNode shape, id derivation, project identity  (pure)
  git/           low-level git access: exec, repo info, log parsing (pure parser)
  shell/         shell-history strategies: PSReadLine, bash, zsh, hook log (pure parsers)
  hooks/         PowerShell profile hook: snippet generation + install/remove
  collectors/    raw source events (git, shell) -> MemoryNode
  config/        .agent-ssd workspace paths + validated config
  store/         SQLite schema, migrations, repository, FTS5 query building
  retrieval/     ranking (relevance x signal x recency) + token-budgeted packing
  cli/           agent-ssd command surface
  mcp/           Model Context Protocol server         (Phase 2)
tests/
```

### On-disk layout

```
<repo>/.agent-ssd/
  .gitignore     '*' — the workspace ignores itself
  config.json    validated on read; corrupt config fails loudly, never silently
  memory.db      SQLite (WAL): nodes, node_files, nodes_fts, sync_state
```

Delete `.agent-ssd/` and nothing is lost that `sync` cannot rebuild.

## Command reference

```
agent-ssd init          create .agent-ssd/ and the database
agent-ssd sync          ingest new history (incremental, git + shell)
agent-ssd status        what is currently remembered, per source
agent-ssd query <text>  search + rank + pack remembered context for a question
agent-ssd scan-git      preview git nodes without writing
agent-ssd scan-shell    preview shell nodes without writing
agent-ssd hook install  opt in to high-quality shell capture
agent-ssd hook remove   undo the above
agent-ssd hook status   check whether the hook is installed
```

Every command accepts `-C, --cwd <path>` to target a repository other than
the current directory. Run `agent-ssd <command> --help` for the full flag
list.

## Development

```bash
npm install       # install dependencies
npm run dev -- scan-git --since 90.days.ago   # run the CLI from source, no build step
npm run typecheck
npm test
npm run build      # emit dist/, what npm link actually runs
```

`scan-git` / `scan-shell` write nothing — they print the `MemoryNode`s
ingestion *would* create, with their signal scores. Useful for tuning scoring
against a real repository before committing to a schema change. Add `--json`
to pipe either into something else.

## Contributing

Issues and PRs are welcome. Before opening a PR:

```bash
npm run typecheck && npm test
```

There's no CI configured yet — that's a good first-PR-sized task if you're
looking for one.

## Roadmap

| Phase | Scope |
| --- | --- |
| 1 | `init` / `sync` / `query`, git + shell collectors, SQLite + FTS5, token-budgeted context packing |
| 2 | `sqlite-vec` + Ollama embeddings, hybrid retrieval, MCP server |
| 3 | Diff-level nodes, session summarization via a local SLM, cross-project recall |

### Known limitations

- Rewriting history (rebase, amend) leaves nodes for the abandoned commits.
  They are real events, so they are not wrong — but a `sync --prune` that
  drops nodes whose commit is no longer reachable is worth having. `sync
  --rebuild` is the blunt workaround today.
- FTS5's `unicode61` tokenizer splits on whitespace, so languages that do not
  use spaces (Thai, Japanese, Chinese) only match on whole-token boundaries.
  Hybrid retrieval in Phase 2 covers this case.
- Without the hook, shell history has no cwd, so the scrape fallback can
  attribute another project's commands to whichever repo you ran `sync` from.
  Bounded (only the tail window) and documented, not silently "correct."
- PSReadLine multi-line entries (a function typed across several lines at the
  prompt) are read as separate single-line commands; not reconstructed.
- Position-based ids for the scrape fallbacks (no stable id exists in the
  source file itself) can drift if the underlying history file is trimmed
  from the front between syncs — same class of imprecision as the git rebase
  case above, and likewise fixed by switching to the hook.

## License

[MIT](LICENSE)
