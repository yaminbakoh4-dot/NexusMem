# NexusMem

[![License: MIT](https://img.shields.io/badge/license-MIT-informational)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen)

A local-first persistent memory engine for AI coding agents (Claude Code, Cursor, MCP-based agents).

AI coding assistants forget context once a session ends, and re-uploading the entire repository as
context on every request is slow and expensive. NexusMem records local machine events — git history,
shell commands, docs, and conversation transcripts — into an on-disk SQLite database, returning only
the relevant context slice within a strict token budget.

All data remains local on your machine. No cloud dependencies, accounts, or telemetry.

---

## Design Principles

- **100% Local-First**: SQLite database stored in `.nexusmem/` inside your repository using
  `sqlite-vec` and `FTS5`. Works fully offline.
- **Kind-Agnostic Core**: Every source normalizes to a single `MemoryNode` schema, allowing git
  commits, shell commands, and documentation to be scored and ranked on an equal basis.
- **Hybrid Search (BM25 + Vector)**: Combines exact keyword matching via SQLite FTS5 (BM25) with
  semantic vector search (`sqlite-vec` via a local Ollama model) using Reciprocal Rank Fusion (RRF).
  RRF fuses on rank position only, never on raw scores, which is what makes it safe to combine a BM25
  cost with a vector distance on an unrelated scale. Degrades gracefully to BM25-only if Ollama is
  offline.
- **Ranked, Budgeted Retrieval**: Scores candidates using
  `score = relevance × signal^a × recency^b`, then packs nodes into a caller-specified token budget.
  Each factor is floored into `[floor, 1]` rather than `[0, 1]`, so no single low factor can zero out
  a strong match. The exponents `a` and `b` are derived, not tuned: `relevance` is the only
  query-derived factor, so each query-independent prior is raised to the power that caps its entire
  range at overturning a 2× relevance gap (`span^exponent = 2`, giving `a ≈ 0.431`, `b ≈ 0.576`).
- **MCP Server Native**: Exposes `search_memory`, `sync_project`, and `get_status` as Model Context
  Protocol (MCP) tools over stdio for Claude Desktop, Cursor, and Windsurf.

---

## Architecture

```
git / shell / docs / transcripts
              │
              ▼   collectors/    normalize to one MemoryNode shape
              │
              ▼   store/         SQLite (FTS5 + sqlite-vec)
              │
              ▼   retrieval/     RRF fuse -> rank -> pack to token budget
```

### Key Subsystems

1. **Git Collector**: Ingests commits, diff statistics, renames, and conventional commit signals
   incrementally via stream iterators. Sync cursors are validated as ancestors of `HEAD` before being
   trusted, so a rebase or amend widens the walk instead of silently skipping commits.
2. **Shell Collector**: Scrapes default history files (`PSReadLine`, `.bash_history`,
   `.zsh_history`). An optional PowerShell profile hook upgrades capture to include exact timestamps,
   working directories, and exit codes (where failed commands receive a higher structural signal).
3. **Docs Collector**: Indexes Markdown documentation (`.md` files) tracked by git. Line endings are
   normalized to LF before chunking to prevent CRLF splitting failures on Windows. Scoped pruning
   removes orphaned sections when headings are renamed or deleted, scoped by project and exact source
   so it cannot affect git, shell, or conversation nodes.
4. **Conversation Collector** (opt-in): Indexes AI assistant transcripts, redacting secrets before
   writing to disk. Replies are chunked at heading and bold-lead boundaries rather than stored as
   whole exchanges.

### Storage Model

Node ids are content-addressed (`sha256(projectId + kind + naturalKey)`), so running `sync` twice
cannot produce duplicates and ingestion stays correct even if a cursor is lost. Project identity is
derived from the normalized origin URL when one exists, falling back to the absolute path, so two
clones of the same repository share one memory namespace.

`nodes_fts` is trigger-populated and stays consistent automatically. `nodes_vec` is not — computing
an embedding requires an async call to Ollama, which a synchronous SQL trigger cannot make — so it is
filled by an explicit pass after `sync` writes nodes, and a node whose content changes has its stale
embedding dropped for re-embedding.

---

## Quickstart

### Prerequisites

- Node.js ≥ 20.11
- Git
- Local Ollama instance with an embedding model (optional, for vector search)

### Installation

```bash
git clone https://github.com/yaminbakoh4-dot/NexusMem.git
cd NexusMem
npm install
npm run build
npm link
```

`npm link` puts `nexusmem` on your `PATH`, so it runs against any repository on your machine.

### Basic Usage

Run from any git repository:

```bash
nexusmem init
nexusmem sync
nexusmem query "why does the retry logic exist"
```

### Optional: High-Precision Shell Hook

To capture exact working directory and exit status for shell history:

```bash
nexusmem hook install
```

This wraps your existing PowerShell prompt rather than replacing it, is idempotent, and is undone
cleanly by `nexusmem hook remove`.

---

## MCP Server Configuration

Add the following to your MCP client configuration file:

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

Available tools:

| Tool | Description |
| --- | --- |
| `search_memory` | Searches and ranks memory for a given prompt within a token budget. |
| `sync_project` | Runs ingestion and updates embeddings for the specified repository root. |
| `get_status` | Returns current ingestion counts and database state per source. |

Each tool takes an explicit `projectRoot`, because MCP tool calls carry no implicit shell working
directory. `sync_project` runs `init` first automatically if the repository has not been set up yet.

---

## Benchmarks & Evaluation

NexusMem distinguishes between **packer efficiency** (internal packing performance against candidate
sets) and **end-to-end token savings** (real-world savings on the context bill). The two are not
interchangeable, and quoting the first as if it were the second is the specific overclaim this
section exists to prevent.

### Packer Efficiency

Measures how effectively the ranking packer drops low-scoring candidate nodes relative to the raw
candidate body sum within a strict token budget:

| Scenario | Candidate Corpus | Result |
| --- | --- | --- |
| Fixture repo (tight budget, 3 matches, 1 dropped) | 23 commits | 25% |
| Fixture repo (generous budget, 6 matches, all kept) | 23 commits | -15% (overhead exceeds trim) |
| Core repo design evaluation | 515 nodes | 81% – 84% |

Efficiency is derived from excluding irrelevant low-scoring candidates entirely, not from text
summarization. It increases with corpus size and goes negative on a tiny one, where fixed per-node
formatting overhead outweighs the little there is to trim.

The baseline it divides by is hypothetical: without NexusMem those candidate bodies would never have
entered the context window at all. This figure is useful for tuning the ranker, not as a claim about
a session's token bill.

### End-to-End Token Savings

Measures packed context size against reading the equivalent full source files into context.

**Measured result: ~40%** on design queries evaluated against this codebase (reading `README.md` +
`docs/phase-2-spec.md` in full, ~32k chars ≈ 8–9k tokens, versus retrieving relevant packed context).
Hand-tallied from one real session, not instrumented — treat it as an order-of-magnitude figure.

**The long-term >70% target is not met at this scale, and this repository cannot demonstrate it.**
The target describes large repositories (thousands of commits) where the win comes from omitting
hundreds of unrelated history items rather than shaving a handful. A benchmark against a repository
of that size is still outstanding.

One caveat in NexusMem's favour is not a percentage at all: the conversation turns and shell commands
in memory have no cheap `grep` equivalent. Without a collector recording them they are gone, not
merely more expensive to retrieve.

### Search Latency

Measured on this repository's corpus (~530 nodes), warm, p50 over 10 runs:

| Operation | Latency |
| --- | --- |
| BM25-only retrieval pipeline (FTS5) | ~1.1 ms |
| Vector search (`sqlite-vec` KNN) | ~3.2 ms |
| RRF fuse + rank + pack | ~0.6 ms |
| Query embedding (local Ollama call) | ~55–77 ms |
| End-to-end hybrid retrieval | ~56 ms |

All SQLite-side work totals roughly 5 ms. The end-to-end figure is dominated by the local embedding
call, which is the only meaningful latency target on this path.

---

## Command Reference

| Command | Description |
| --- | --- |
| `nexusmem init` | Initializes `.nexusmem/` directory and SQLite schema. |
| `nexusmem sync` | Ingests new events (git, shell, docs; `--conversation` for transcripts). |
| `nexusmem status` | Prints memory counts per source and database status. |
| `nexusmem query <text>` | Executes hybrid search, ranks, and packs context to stdout. |
| `nexusmem scan-git` | Dry-run preview of git nodes and signal scores without writing to DB. |
| `nexusmem scan-shell` | Dry-run preview of shell history nodes without writing to DB. |
| `nexusmem scan-docs` | Dry-run preview of doc section nodes without writing to DB. |
| `nexusmem scan-conversation` | Dry-run preview of conversation nodes without writing to DB. |
| `nexusmem hook install` | Installs PowerShell profile wrapper for high-precision shell logs. |
| `nexusmem hook remove` | Removes the PowerShell profile wrapper. |
| `nexusmem hook status` | Reports whether the hook is installed. |
| `nexusmem mcp` | Starts the MCP stdio server. |

Every command accepts `-C, --cwd <path>` to target a repository other than the current directory.
Useful `sync` flags: `--conversation` opts the conversation source in for one run without persisting
it to config; `--no-embed` skips the vector-embedding pass; `--rebuild` drops the project's nodes and
re-ingests from scratch.

---

## On-Disk Layout

```
<repo>/.nexusmem/
  .gitignore     '*' — the workspace ignores itself, so init never edits a file it does not own
  config.json    validated on read; a corrupt config fails loudly, never silently
  memory.db      SQLite (WAL): nodes, node_files, nodes_fts, nodes_vec, sync_state
```

Deleting `.nexusmem/` loses nothing that `sync` cannot rebuild.

---

## Technical Limitations & Edge Cases

- **Windows Line Endings**: Markdown files are normalized from CRLF to LF prior to chunking.
  Un-normalized CRLF causes the paragraph splitter (`\n{2,}`) to never fire — `\r\n\r\n` contains no
  two consecutive `\n` — collapsing an entire file into a few coarse, heading-less blocks.
- **Git Rebase / Amend**: Rewriting git history leaves orphaned nodes for unreachable commits. These
  are real events, so they are not wrong, but a targeted prune does not exist yet;
  `sync --rebuild` forces a clean re-scan if required.
- **Non-Segmented Languages**: FTS5 `unicode61` tokenization splits on whitespace. Languages without
  space boundaries (Thai, Japanese, Chinese) rely on the vector search pass for recall.
- **Unscoped Shell History**: Scraped shell history files without the PowerShell hook lack directory
  context and are attributed to whichever repository `sync` was executed from. Bounded to the tail
  window, and an approximation rather than a guarantee.
- **PSReadLine Multi-Line Entries**: A function typed across several lines at the prompt is read as
  separate single-line commands, not reconstructed.
- **Scrape-Fallback Id Drift**: Position-based ids for the scrape fallbacks can drift if the
  underlying history file is trimmed from the front between syncs. Installing the hook fixes this.
- **Conversation Retrieval Precision**: Chunking replies at heading boundaries improved precision on
  long replies but has not been evaluated systematically.
- **Embedding Batch Size**: The embedding pass processes a bounded batch per `sync`; a large corpus
  needs several runs to embed fully.

---

## Development & Testing

```bash
npm install
npm run typecheck
npm test
npm run build
```

`scan-git`, `scan-shell`, `scan-docs` and `scan-conversation` write nothing — they print the
`MemoryNode`s ingestion would create, with their signal scores, which is the intended way to tune
scoring against a real repository before committing to a schema change. Add `--json` to pipe the
output elsewhere.

There is no CI configured yet.

---

## License

MIT
