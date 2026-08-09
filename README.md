# NexusMem

[![License: MIT](https://img.shields.io/badge/license-MIT-informational)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen)
![Status](https://img.shields.io/badge/phase%202-shipped%2C%20acceptance%20test%20passing-brightgreen)

> A local-first persistent memory engine — an **SSD for AI coding agents**.

AI coding assistants (Claude Code, Cursor, MCP-based agents, ...) forget
everything the moment a session ends, and re-uploading the whole repo as
context on every request is slow and expensive. NexusMem records what
actually happened on your machine — git history and shell command history —
into a small local database, then hands your agent back **only the slice of
context that's actually relevant** to the question in front of it.

**Nothing leaves your machine.** No cloud, no account, no API key.

## Features

- 🔒 **100% local-first.** SQLite on disk, in `.nexusmem/` inside your repo.
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
  than summarized down — that's where the token savings actually come from.
  [Benchmarks](#benchmarks) separates *packer efficiency* (what the CLI
  prints) from *end-to-end token saving* (what you actually pay), reports
  both measured, and says plainly which target is not yet met.
- 🧩 **Kind-agnostic core.** Every source normalizes to one `MemoryNode`
  shape, so a shell command and a git commit rank on a level field.
- 🧠 **Hybrid retrieval (BM25 + vector search).** `sqlite-vec` embeddings via
  a local Ollama model, fused with BM25 through Reciprocal Rank Fusion --
  catches a semantically-related match with no shared keywords, not just
  exact terms. Degrades to BM25-only automatically if Ollama isn't running.
- 💬 **Conversation collector (opt-in).** Indexes the AI coding assistant
  transcript that produced the code, redacted for secrets before it's ever
  written to disk. Real, but retrieval precision on long replies is a known
  open issue -- see [Phase 2, honestly](#phase-2-honestly) below.
- 🔌 **MCP server** (`nexusmem mcp`) -- the same search/sync/status exposed
  as tools any MCP client (Claude Desktop, Cursor, Windsurf, ...) can call
  directly, no side terminal required.

## Quick start

**Requirements:** Node.js ≥ 20.11, Git, and a shell — PowerShell is the
primary target on Windows; bash/zsh are supported elsewhere.

```bash
git clone https://github.com/yaminbakoh4-dot/NexusMem.git
cd NexusMem
npm install
npm run build
npm link
```

`npm link` puts `nexusmem` on your `PATH`, so it works from any repo on your
machine — you're not limited to running it from inside this folder.

```bash
cd path/to/some/other/git-repo
nexusmem init
nexusmem sync
nexusmem query "why does the retry logic exist"
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
nexusmem hook install
```

This edits your PowerShell profile to log every command's timestamp, cwd and
exit code to a small local JSONL file. It wraps your existing prompt rather
than replacing it, is fully idempotent, and `nexusmem hook remove` undoes it
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

**Score = relevance × signal^a × recency^b, each factor floored, never zeroed.**
Each factor lives in `[floor, 1]`, not `[0, 1]` — multiplying three `[0,1]`
terms lets any one of them crush the other two to nothing, so a perfectly
relevant five-year-old commit would lose outright to a barely-relevant one from
this morning. Floors turn each factor into a *reordering* instead of a gate.

The exponents exist because floors alone still let the priors win. `relevance`
is the only factor derived from the query; `signal` and `recency` are priors
that hold before any query is asked. As equal multiplicands they could overturn
relevance outright — dogfooding caught a `fix:` commit taking rank 1 from the
best-matching README section on a 44% signal edge against a 15% relevance
deficit. Each prior is now raised to the power that caps its *entire* range at
overturning a 2× relevance gap (`span^exponent = 2`), which leaves the priors
ordering equally-relevant hits exactly as before while stopping them from
outvoting a decisive relevance win.

**Keyword search first, vector search additive, not a replacement.** Phase 1
shipped SQLite FTS5/BM25 alone -- developer queries are keyword-heavy (file
names, symbols, error strings), exactly where BM25 wins. Phase 2 added
`sqlite-vec` + a local Ollama embedding model on top via Reciprocal Rank
Fusion, so a semantically-related match with no shared keywords now surfaces
too, without weakening exact-term queries BM25 already handled well.

**Embeddings are not trigger-populated, unlike `nodes_fts`.** Computing an
embedding means an async HTTP call to Ollama, which a synchronous SQL
trigger cannot make -- so `nodes_vec` is filled by an explicit pass after
`sync` writes nodes, and a node whose content changes has its stale
embedding deleted so the next pass re-embeds it. If Ollama isn't running,
that pass embeds nothing and `query` falls back to BM25-only automatically;
nothing about `sync` or `query` requires an embedding provider to exist.

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
approximation, not a guarantee. `nexusmem hook install` logs the real
timestamp, cwd and exit code instead; once that log exists, the noisier raw
scrape is skipped automatically. A failed command scores meaningfully higher
than the same command succeeding — a build that just broke is exactly the
context an agent should see first.

**The workspace ignores itself.** `.nexusmem/` contains its own `.gitignore`
with `*`, so `init` never edits a file in a repo it does not own.

## Benchmarks

Two different numbers get called "token savings," and conflating them is how a
tool like this ends up overclaiming. NexusMem reports them separately, and
they are not interchangeable.

**Packer efficiency** — what `nexusmem query` prints on every run. It compares
the packed context the agent receives against the summed raw bodies of *the
same candidate set the packer was handed*. It measures one component —
ranking plus budgeted packing — against its own input, which is exactly what
makes it useful for tuning. It is **not** a claim about your session's token
bill: without NexusMem those candidate bodies would never have entered the
context window at all, so the baseline it divides by is hypothetical.

**End-to-end token saving** — the packed context against *what would otherwise
have gone into the context window* to answer the same question: reading the
files, pasting history, letting the agent grep around. This is what the
project's **>70%** target refers to. It is the harder number to measure
honestly, because the baseline depends on what the agent would have done
instead.

### Packer efficiency

| Scenario | Result |
| --- | --- |
| 23-commit fixture repo, tight budget, 3 matches, 1 dropped entirely | **25%** |
| 23-commit fixture repo, generous budget, 6 matches, all kept | **−15%** — packed output is *larger*; fixed per-node formatting overhead outweighs the little there was to trim |
| This repo, 515 nodes, two real design questions (2026-08-09) | **81%** and **84%** |

The mechanism is structural, not compression: packing a single small node
barely shrinks it — the summary is already close to the raw body. The
efficiency comes from leaving low-score candidates out entirely once there are
more of them than the budget allows, which is why it climbs with corpus size
and goes negative on a tiny one.

### End-to-end token saving

| Measurement | Result |
| --- | --- |
| The same two design questions above, answered from memory instead of reading `README.md` + `docs/phase-2-spec.md` in full (~32k chars ≈ 8–9k tokens) | **~40%** — roughly 5k tokens spent, including one failed MCP call and a re-run |

Hand-tallied from one real session on 2026-08-09, not instrumented; treat it
as an order-of-magnitude figure, not a precise one.

Note the gap. The same two queries that reported **81–84% packer efficiency**
delivered roughly **40% end-to-end saving**. Both numbers are real and both
were measured; they answer different questions. Quoting the first as if it
were the second is the specific overclaim this section exists to prevent.

**The >70% end-to-end target is not met at this scale.** The 23-commit fixture
and this 515-node repo are both too small to demonstrate the regime the target
describes — hundreds of commits with a handful relevant to any one question,
where the win is dropping the hundreds rather than shaving the handful. A
proper benchmark against a large repository is still on the roadmap.

One caveat in NexusMem's favour, which is not a percentage at all: the 130
conversation turns and 315 shell commands in this repo's memory have no cheap
`grep` equivalent. Without a collector recording them they are simply gone,
not merely more expensive to retrieve. That value is "reachable or not,"
which no savings figure captures.

## Layout

```
src/
  core/          MemoryNode shape, id derivation, project identity  (pure)
  git/           low-level git access: exec, repo info, log parsing (pure parser)
  shell/         shell-history strategies: PSReadLine, bash, zsh, hook log (pure parsers)
  conversation/  transcript reader (Claude Code), redaction, path slugging (pure parser)
  hooks/         PowerShell profile hook: snippet generation + install/remove
  collectors/    raw source events (git, shell, conversation) -> MemoryNode
  config/        .nexusmem workspace paths + validated config
  store/         SQLite schema, migrations, repository, FTS5 + sqlite-vec query building
  vector/        Ollama embedding client, embedding-pass orchestration
  retrieval/     ranking, RRF fusion, token-budgeted packing, the shared query pipeline
  mcp/           MCP server (stdio) + tool wrappers over the same CLI pipeline
  cli/           nexusmem command surface
tests/
```

### On-disk layout

```
<repo>/.nexusmem/
  .gitignore     '*' — the workspace ignores itself
  config.json    validated on read; corrupt config fails loudly, never silently
  memory.db      SQLite (WAL): nodes, node_files, nodes_fts, nodes_vec, sync_state
```

Delete `.nexusmem/` and nothing is lost that `sync` cannot rebuild.

## Command reference

```
nexusmem init             create .nexusmem/ and the database
nexusmem sync             ingest new history (git + shell + embeddings; --conversation to opt in)
nexusmem status           what is currently remembered, per source
nexusmem query <text>     search + rank + pack remembered context (--no-vector for BM25-only)
nexusmem scan-git         preview git nodes without writing
nexusmem scan-shell       preview shell nodes without writing
nexusmem scan-conversation  preview conversation nodes without writing
nexusmem hook install     opt in to high-quality shell capture
nexusmem hook remove      undo the above
nexusmem hook status      check whether the hook is installed
nexusmem mcp              start the MCP server (stdio) for Claude Desktop / Cursor / Windsurf
```

Useful sync flags: `--conversation` opts the conversation source in for one run
without persisting it to config; `--no-embed` skips the vector-embedding pass
(faster when you know Ollama isn't running).

### Using the MCP server

Point any MCP client at `nexusmem mcp` (stdio transport, no other setup). For
Claude Desktop / Cursor / Windsurf-style config files:

```json
{
  "mcpServers": {
    "nexusmem": {
      "command": "nexusmem",
      "args": ["mcp"]
    }
  }
}
```

Exposes `search_memory`, `sync_project` and `get_status`, each taking an
explicit `projectRoot` (MCP tool calls carry no implicit shell cwd) --
`sync_project` runs `init` first automatically if the repo hasn't been set up
yet.

Every command accepts `-C, --cwd <path>` to target a repository other than
the current directory. Run `nexusmem <command> --help` for the full flag
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
| 2 | `sqlite-vec` + Ollama embeddings, hybrid retrieval (RRF), MCP server, chunked conversation collector -- **shipped, acceptance test passing** (see [`docs/phase-2-spec.md`](docs/phase-2-spec.md)) |
| 3 | **Project docs collector** (index `.md` files -- README, architecture docs; the one gap live MCP dogfooding actually surfaced, see below), diff-level nodes, session summarization via a local SLM, cross-project recall, batch the embedding pass so one `sync` embeds a whole large corpus instead of needing several |

**Why a docs collector, found by dogfooding the live MCP server (2026-08-08):**
`search_memory("why did we choose BM25 before vector search")` returned
related commits and conversation turns, but not a precise answer -- because
the actual reasoning lives in `README.md`'s prose, which no collector reads.
Git, shell and conversation are covered; the project's own `.md` files are
the one source with real "why" content NexusMem still can't see.

**Highest-priority addition: a conversation/session collector.** Dogfooding
this tool on its own repo (2026-08-08) showed why. This project's git history
was 3 same-day, largely one-line commits and its shell history was an
unscoped system-wide scrape — so `nexusmem query` on a real design question
returned an unrelated `cd` command, not an answer. The actual reasoning
behind almost every design decision in this codebase (why BM25 before vector
search, why each ranking factor is floored, why the PowerShell hook escapes
paths the way it does) exists only in the AI coding assistant conversation
that produced the code, and NexusMem has no collector for that yet — only
git and shell. Capturing the conversation itself, not just its code diffs,
is probably worth more than everything else on this roadmap combined.
See [`docs/phase-2-spec.md`](docs/phase-2-spec.md) for the architecture and,
below, an honest report of where it stands after actually building it.

### Phase 2, honestly

All three pieces shipped and are exercised by real tests (165 passing,
including live `sqlite-vec` KNN queries and an MCP client/server round trip
over the SDK's own transport). The acceptance test this phase was built against
(`nexusmem query "why floors on ranking factor score"` should surface the
real rationale from `src/retrieval/rank.ts`) **failed on the first real run**
and now passes, after two more real bugs were found by checking the actual
output rather than trusting the pipeline worked because it typechecked.

In order: exchange-level granularity (one node per user turn + the *entire*
assistant reply) diluted and sometimes truncated a specific point inside a
long reply -- fixed by chunking replies at bold-lead-paragraph or markdown
heading boundaries. That fix then exposed a title-truncation bug (a long
question ate the budget meant for a "(part N/M)" suffix, making genuinely
different chunks look like duplicates) and a summary bug (the packed preview
truncated from the start of `Q: <question>\n\nA: <answer>`, so a long
question could crowd out the answer entirely). Full sequence, including the
exact diagnostic queries run against the live database, is in
[`docs/phase-2-spec.md`](docs/phase-2-spec.md).

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
