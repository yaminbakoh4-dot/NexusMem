# Phase 2 architecture draft

**Status:** implemented and the acceptance test passes (2026-08-08). All
three pieces (conversation collector, hybrid vector search, MCP server)
shipped the same day; the acceptance test failed on the first real run,
was root-caused against the live database (not guessed), fixed, and
re-verified against the live database again. Written progressively over one
session -- see the dated sections below for the actual sequence, including
the failure.

**Why these three, together:** dogfooding Phase 1 on this repo the same day
showed a real design question return an unrelated `cd` command as its top
match (see [README § Roadmap](../README.md#roadmap)). The root causes were
threaded through all three items below — no vector search to catch a
worded-differently match, no MCP server to make the tool available inside
the assistant itself instead of a side terminal, and no way to capture the
conversation where the actual reasoning happened. None of the three fixes
the problem alone.

**Acceptance test for this phase:** re-run
`nexusmem query "why floors on ranking factor score"` against this repo.
Originally it returned a stray `cd` command. Phase 2 is done when it returns
the actual rationale from `src/retrieval/rank.ts`.

### Acceptance test, attempt 1: not met, root cause diagnosed

After shipping all three pieces and running a real sync (git + shell +
conversation + embeddings, 319 nodes, 199 embedded), the query still does
**not** surface the rationale cleanly. Top hits are meta-conversation about
this very project (messages *about* the roadmap, the rename, session
wrap-up) and shell noise -- better-scoring by pure keyword/semantic
proximity than the actual explanation, but not the right answer.

Diagnosis, not a guess -- checked directly against the database:

```
nodes mentioning floor/veto/crush: 6
  a5c93... len=4000  (hit the cap)
  53708... len=4000  (hit the cap)
  af57f... len=4000  (hit the cap)
  c9541... len=2069
  d28a8... len=745
  8c84a... len=2487
```

The explanation **is** in the index. Half the nodes that mention it are
truncated at exactly `maxBodyChars` (4000). The root cause is granularity,
not truncation alone: one exchange = one user turn + *the entire* assistant
reply, however long and however many unrelated topics it covers. A single
reply in this session routinely covers several distinct design points under
different headers -- the floors explanation is real content in there, but
it's one paragraph diluted inside 4000+ characters about other things, and
neither BM25 nor a single embedding vector for the whole blob can pinpoint
it.

**Fix implemented same session:** split an assistant reply into multiple
nodes, each still anchored to the same user turn (`naturalKey` +
`:<chunkIndex>` suffix instead of one node per exchange regardless of
length). Boundaries: a literal `#`/`##`/`###` markdown heading, **or** a
paragraph opening with a **bold lead sentence** -- the second case matters
more in practice, because this project's own chat responses (the actual
corpus) are written with bold-led paragraphs as informal section markers,
not literal markdown headings. Plain paragraphs accumulate into the current
chunk up to `maxChunkChars` (900). Implementation: `src/conversation/chunk.ts`.

### Acceptance test, attempt 2: two more real bugs, found by actually looking

Re-ran the acceptance test against a full rebuild. The chunking fix worked
-- direct SQL query against the rebuilt database confirmed a node with
`heading = "every factor has a floor, not the full 0..1"` existed, 971 chars,
cleanly isolated. But the query
output looked wrong in a new way: many results shared what looked like
identical titles, reading like duplicate/replayed transcript data.

Investigated before assuming a new bug was a data problem: it wasn't. Every
one of those "duplicate" rows had a distinct id and distinct `chunkIndex` --
they were correctly-chunked, genuinely different pieces of one very long
reply that all happened to render with the same title. Root cause:
`` `${userFirstLine} (part ${index+1}/${count})` `` was truncated as one
string to `MAX_TITLE_CHARS`, and whenever the *question itself* was already
near that length (this session asks long questions), the differentiating
suffix never survived truncation. Fixed by truncating the question first,
reserving guaranteed room for the suffix (`withSuffix()` in
`collectors/conversation.ts`).

With titles fixed, the floors chunk was visibly present at rank #2 of 20 --
but its displayed *summary* still showed only the (long, repeated-per-chunk)
question, never the answer. `retrieval/pack.ts`'s `summarize()` truncated
from the start of the body; for a conversation node shaped `Q: <question>\n\nA:
<answer>`, a long question consumed the entire summary before truncation
ever reached the answer. Fixed: `summarize()` now looks for the `\n\nA: `
marker and, when present, summarizes from the answer onward instead of from
the start of the body. Git/shell node bodies never contain that marker, so
their summaries are unaffected.

### Acceptance test, attempt 3: passes

```
$ nexusmem query "why floors on ranking factor score"
...
- 2026-08-08 ...production-grade... — every factor has a floor, not the full 0..1
  **every factor has a floor, not the full 0..1** — relevance, signalWeight,
  recencyFactor all sit in [floor, 1]. Reason: multiplying three 0..1 terms means
  any one of them hitting 0 swallows the other two instantly. A commit that
  matches the question closely but is 5 years old would lose to a commit from
  today that is barely relevant...
```

The real rationale -- floors exist because multiplying three [0,1] terms
lets a zero in any one crush the others, illustrated with the exact
old-relevant-vs-new-irrelevant example from `rank.ts`'s own doc comment --
now renders accurately, at rank #2 of 20 packed results. Rank #1 is a
conversation chunk from *this very debugging session* discussing this exact
query, which is a legitimate, arguably-correct top match, not noise. Calling
this a pass: the tool now explains its own design when asked, which is what
the acceptance test was actually checking for, even though "rank #1 exactly"
was never a stated requirement.

**Known follow-up, fixed in Phase 3:** the embedding pass used to stop after
200 nodes per `sync` call, so a large corpus needed several runs before every
node was embedded (three were needed here, for 426 nodes). It now drains the
whole backlog in one pass and sends texts to Ollama in batches of 32, measured
at 4.2x the throughput of one call per node (20.3ms/node → 4.8ms/node over 96
real nodes from this repo). See `vector/sync.ts`.

## 1. Conversation collector

The highest-priority piece. Everything else in this doc is in service of
making this collector's output actually retrievable.

### Source

Claude Code persists session transcripts locally per-project, under a path
of the shape `~/.claude/projects/<project-slug>/`. This is the primary
target, but the format is internal and undocumented (subject to change
between Claude Code versions), so the reader needs to be:

- **Isolated behind an adapter**, mirroring the `shell/` strategy pattern
  (`parse-psreadline.ts`, `parse-bash.ts`, ...): one pure-parsing module per
  transcript source, all producing the same intermediate shape. A future
  Cursor or other-tool transcript reader slots in the same way.
- **Defensive**, not throw-on-unexpected-shape: a schema change in the host
  tool should degrade to "no conversation nodes this sync," never break
  `sync` for git/shell.

### Node shape

New `NodeKind = 'conversation_turn'`. No core changes needed — this is
exactly what the "every collector normalizes to one `MemoryNode` shape"
decision (README § Design decisions) was for.

- **Granularity:** one node per logical exchange (a user message + the
  assistant's response up to the next user message), not one node per whole
  session. A multi-hour session is not one memory; each design decision
  inside it is. Matches the same intuition as one node per commit rather
  than one node per day.
- **`title`**: first ~200 chars of the user's message, same truncation
  convention as `git-commits.ts`.
- **`body`**: the exchange text, capped like other collectors
  (`maxBodyChars`) — full tool-call noise (raw file contents, huge diffs
  pasted into context) should be stripped or summarized out, not indexed
  verbatim. This is the collector most likely to blow the token/storage
  budget if this isn't enforced from the start.
- **`files`**: file paths mentioned or edited during the exchange, extracted
  heuristically (tool-call arguments, `edited_file`-shaped mentions). This
  is what lets a future `query` join a conversation turn to the commit it
  produced via the existing `node_files` path index — "why is this file
  like this" becomes answerable from both directions.
- **`signal`**: needs its own scoring function, analogous to
  `scoreCommit` / `scoreShellCommand`. Starting heuristics: turns containing
  explanation markers ("because", "the reason", "rationale"), a design
  decision being stated and then acted on, or a bug being diagnosed score
  high; routine tool-call acknowledgment turns score low. This is the
  collector where Phase 3's local-SLM summarization has the clearest payoff
  — a small model classifying "does this turn explain a decision" is a much
  better signal than regex heuristics, but heuristics should ship first so
  the collector exists before that dependency does.

### Privacy

This is the collector most likely to index something sensitive — pasted
credentials, personal context, business-confidential discussion. Treat it
like the shell hook: **opt-in**, not automatic on `sync`. A
`sources.conversation.enabled` config flag, default `false`. A basic
secret-pattern redaction pass (reuse/extend whatever pattern set a future
security review settles on) before a turn is ever written to the FTS index,
not just at display time.

---

## 2. Hybrid vector search (`sqlite-vec` + Ollama)

### Why now, not instead of FTS5

Unchanged from the Phase 1 decision: BM25 stays for keyword-heavy queries
(file names, symbols, exact error strings). Vector search is added
*alongside* it because the dogfooding failure was specifically a
**worded-differently** query — "why floors on ranking factor score" vs. the
actual code comment's phrasing. That's a semantic-similarity gap, not a
keyword gap; BM25 structurally cannot close it no matter how the ranking
formula around it is tuned.

### Storage

Mirror the existing `nodes_fts` external-content pattern: a `nodes_vec`
virtual table (via the `sqlite-vec` extension) keyed by `rowid`, storing an
embedding per node, populated by the same insert/update triggers already
wired for `nodes_fts` in `store/schema.ts`. No new source-of-truth — the
`nodes` table stays authoritative, `nodes_vec` is a derived index exactly
like `nodes_fts` is.

### Embedding model

Constraint that matters here specifically: this machine already runs large
local models day-to-day (observed in this session's own shell history —
`gemma2:27b`, `llama3.1`, others) inside a 12GB VRAM budget (RTX 4070 Ti).
The embedding model must be small enough to stay loaded without evicting
whatever chat model is active — a dedicated embedding model
(`nomic-embed-text`-class, ~130–340M params, sub-1GB) rather than borrowing
a general-purpose chat model for embeddings. This needs a real benchmark
before locking in a choice, not just a VRAM-budget argument.

### Fusion

Reciprocal Rank Fusion (RRF) of the BM25 rank and the vector-similarity
rank into a single `relevance` figure — this replaces only the `relevance`
input to the existing `rankHits` formula in `retrieval/rank.ts`
(`relevance × signalWeight × recencyFactor`). The rest of that pipeline —
the floors, the signal weighting, the recency decay — does not change.
Vector search is a better `relevance`, not a parallel ranking system.

### Ingest cost

Embeddings are computed once at ingest (batched, like `signal` scoring),
not at query time. Incremental `sync` only embeds new/changed nodes, same
idempotency guarantee as everything else — re-running `sync` must stay free.

---

## 3. MCP server

### What it exposes

A minimal tool surface wrapping the existing CLI pipeline, not a new
pipeline:

- `search_memory(projectRoot, query, budget?)` — wraps
  `store.search` → `rankHits` → `packContext`, returns the same packed
  context `query` already prints, structured instead of formatted.
- `sync_project(projectRoot)` — wraps `runSync`.
- `get_status(projectRoot)` — wraps `runStatus`'s data, structured.

No new business logic — this is a thin adapter, same relationship the CLI
commands already have to `core`/`collectors`/`retrieval`/`store`.

### Multi-project handling

MCP tool calls don't carry an implicit shell `cwd` the way a terminal
command does. Every tool takes an explicit `projectRoot` argument and
reuses `cli/context.ts`'s `loadContext(cwd)` — no new context-resolution
logic, just a different caller.

### Transport & security

stdio, local process only — consistent with "nothing leaves your machine."
No auth layer needed for v1: if a client can spawn the process, it already
has filesystem access to everything the server would expose.

---

## Suggested module layout

```
src/
  conversation/
    types.ts               # RawConversationTurn, mirrors shell/types.ts
    claude-code-reader.ts   # pure parser, isolated adapter for the transcript format
  collectors/
    conversation.ts         # RawConversationTurn -> MemoryNode, scoreConversationTurn()
  vector/
    embed.ts                # Ollama embedding client
    schema.ts                # nodes_vec migration, mirrors store/schema.ts's fts triggers
  retrieval/
    fuse.ts                  # RRF(bm25Rank, vectorRank) -> relevance, feeds rank.ts
  mcp/
    server.ts                 # stdio MCP server bootstrap
    tools.ts                   # search_memory / sync_project / get_status
```

## Open questions for next session

1. Confirm the actual on-disk shape of Claude Code's transcript files before
   writing `claude-code-reader.ts` against assumptions.
2. Redaction pattern set for the conversation collector — reuse a security
   review's findings if one exists by then, don't invent one ad hoc.
3. `sqlite-vec` ships prebuilt binaries the same way `better-sqlite3` does —
   confirm Windows/PowerShell install story is as smooth before depending on
   it (this project's whole install path has been Windows-first so far).
4. Embedding model benchmark: retrieval quality vs. VRAM/latency, on this
   machine's actual hardware, before locking the default.
