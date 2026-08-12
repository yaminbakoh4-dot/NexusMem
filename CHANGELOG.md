# Changelog

Notable changes per published version. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Tags were added retroactively on 2026-08-11 and point at the exact commits the npm tarballs were
built from, matched by publish timestamp: `v0.1.0` → `67a4776`, `v0.1.1` → `809e62c`,
`v0.1.2` → `b22a3b0`.

## [Unreleased]

### Added

- **Diff-level nodes.** Commit patches are now indexed, one node per changed file, so a question
  about *what the change looked like* reaches the lines themselves rather than the commit message
  and a `+41/-6` summary. New `code_diff` kind, `diff` source, `scan-diff` preview command, and a
  `sources.diff` config block. Read by a second `git log --patch` walk with its own cursor: folding
  it into the existing `--numstat` walk would put patch text and numstat rows in one field, where a
  diff line reading `-1\t2\tfoo` is indistinguishable from a real file entry.
  Bounded on purpose — 200 commits on a first sync, 20 files per commit, no merges (their patch
  exists only in a combined format this parser does not read), and binaries, lockfiles and build
  output skipped. Patches are redacted with the shape-matching rules only; the key/value rule that
  serves prose would rewrite `const apiKey = process.env.SERVICE_API_KEY` into a redaction marker.
- **Cross-project recall.** `query --all-projects` (and `search_memory`'s `allProjects`) searches
  every repository NexusMem has been run in on this machine, tagging each result with the repository
  it came from. Databases stay per-repository — a shared global store was rejected for giving up the
  property that deleting one repo's `.nexusmem/` removes that repo's memory and nothing else — so a
  plain index at `~/.nexusmem/projects.json`, written by `init` and refreshed by `sync`, is what
  makes the others findable. New `projects` command lists it; `--prune` forgets entries whose
  database is gone. A stale or corrupt registry degrades the query, never fails it.
  Ranking fuses each project's list by rank (RRF) instead of comparing raw BM25 costs, which are
  computed against their own corpus and are not comparable across databases. The bias this leaves —
  every project's rank-1 hit is worth the same, so recall favours breadth — is documented rather
  than hidden.
- **Query-aware diff excerpts.** A packed summary is ~320 characters and a patch is thousands, so
  the packer now picks the hunk whose tokens match the query and starts the excerpt at the changed
  line. Found by dogfooding: "what flags are passed to every git invocation" retrieved the right
  file and then spent the whole summary on a class definition seventy lines above the answer.
  Matching splits identifiers on case and underscore boundaries, because `\bretry\b` does not match
  `RETRY_DELAYS_MS` and a natural-language question otherwise never meets the code it is about.
- `CHANGELOG.md` now ships inside the npm tarball. npm's always-included list covers `package.json`,
  `README` and `LICENSE` but not the changelog, so it previously reached GitHub readers only.

### Internal

- The test suite no longer writes to the developer's real `~/.nexusmem`. `sync` records the
  repository it ingested in the project registry, and the suite syncs temporary repositories in
  several places, so a green run left seven dead entries behind — found by running `nexusmem
  projects` after the fact, not by any test. `tests/setup.ts` now points `NEXUSMEM_HOME` at a
  throwaway directory for the whole suite, and one test fails if that guard is ever removed.
- `npm run smoke` drives the *packaged* artifact: build, pack, install into a throwaway directory,
  then run the installed CLI, an end-to-end ingest/query against a fixture repository, and an
  `initialize` handshake over real stdio. It also audits the manifest `npm publish` would send,
  which is a different artifact from the tarball. Both defects that ever reached npm users passed a
  green unit suite first; each is now pinned by a check verified to fail when the defect is
  reintroduced. Runs in CI on Linux and Windows as its own job.

## [0.1.2] — 2026-08-10

### Fixed

- `nexusmem --version` printed `0.1.0` on 0.1.1. The version string in `src/cli/index.ts` was a
  literal separate from `package.json`, and the 0.1.1 bump only touched the latter. `src/mcp/server.ts`
  had the same problem in its `McpServer` constructor, so an MCP client's `initialize` handshake
  would have reported the same stale version. Both now read the real version through
  `readOwnVersion()` in `src/core/version.ts`, which resolves `package.json` via `import.meta.url`.
  Found by running the published package end to end rather than trusting `npm publish --dry-run`
  and the registry API, neither of which executes a `--version` flag.

The ingestion and retrieval pipeline was never affected — only the two places that report a version
independently of running a command.

## [0.1.1] — 2026-08-10

### Changed

- README rewritten for someone deciding whether to read the source: what it does, how retrieval
  scores, what it costs, and where it breaks. `README.md` ships inside the package, so this is a
  real change to what npm delivers — but no code changed between 0.1.0 and 0.1.1.
- Documented the ranking flaw the tool found in itself, and the fact that the conversation source
  in the sample `status` output is opt-in rather than default.
- Dropped `&&` from the quickstart, which Windows PowerShell 5.1 cannot parse.

## [0.1.0] — 2026-08-10

First public release.

### Added

- **Collectors.** Git history (commit metadata and diff stats, not diff bodies), shell commands with
  exit codes via an opt-in PowerShell hook, tracked markdown docs via `git ls-files -- '*.md'`, and
  opt-in assistant transcripts.
- **Hybrid retrieval.** SQLite FTS5 BM25 and `sqlite-vec` KNN over 768-dim embeddings, fused with
  reciprocal rank fusion, then ranked by relevance against signal and recency priors and packed into
  an explicit token budget.
- **MCP server** over stdio (`nexusmem mcp`) exposing `search_memory`, `sync_project` and
  `get_status`, for Claude Desktop, Cursor, Windsurf and other MCP clients.
- **CLI**: `init`, `sync`, `query`, `status`, `mcp`, and `hook install|remove|status`, plus four
  dry-run previews — `scan-git`, `scan-shell`, `scan-docs`, `scan-conversation` — that write nothing
  and print the nodes ingestion would create with their signal scores.
- Content-addressed node ids (`sha256(projectId + kind + naturalKey)`), so `sync` is idempotent and
  two clones of one repository share a memory namespace.
- Everything stays on the machine: one SQLite database in WAL mode under `<repo>/.nexusmem/`.

### Notes

- Requires Node **>= 22**. `better-sqlite3` 12.11.1 publishes no prebuilt binary for Node 20 — its
  prebuilds start at ABI 127 — so a lower floor would have been a promise the package could not keep.
  Do not lower it without checking upstream prebuilds first.
- Not done at this release: diff bodies are not indexed, queries are scoped to a single project,
  there is no local-model summarization pass, and the conversation collector has never been audited
  for the stale-node bug that was found and fixed in the docs collector.

[Unreleased]: https://github.com/yaminbakoh4-dot/NexusMem/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/yaminbakoh4-dot/NexusMem/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/yaminbakoh4-dot/NexusMem/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/yaminbakoh4-dot/NexusMem/releases/tag/v0.1.0
