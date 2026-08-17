# `nexusmem forget`: why it exists, what it actually closes

**Status:** shipped 2026-08-17, in direct response to an external source-level review of NexusMem by
Simon Strandgaard ([neoneye2](https://github.com/neoneye), Agent Memory Atlas), published at
<https://neoneye.github.io/agent-memory-atlas/systems/nexusmem/>, analyzed against commit `ed92303`
(v0.4.0). The review read real source (`schema.ts`, `store.ts`, `reconcile.ts`, `rank.ts`, `redact.ts`),
scored NexusMem against a 7-mechanism rubric, and flagged its most serious finding this way:

> "the only removals are keyed on the source, the source file survives, and the next full sync
> re-derives [what was pruned]"
>
> "Walk away if anything you capture must be removable on request."

That finding was correct and specific, not a generic complaint. Before this release, `pruneSourceNodes`
(the mechanism behind `sync --prune-source`) only deleted at the granularity of one collector source
(`shell:pwsh`, `docs`, ...), hard-deleted rows with no trace, and — the part that actually mattered —
never touched the sources those rows were derived from. The shell-hook log (`shell-history.jsonl`) is
deliberately append-only; a full transcript re-read has no cursor at all. So a prune followed by
`sync --rebuild` re-derived the exact same content-addressed node ids and put the pruned content right
back. Deleting a leaked credential from the database did not stop it from reappearing on the next full
sync.

## What changed

Three additive tables (schema `V5`): `deny_list`, `tombstones`, `mutation_audit`. A deny-list entry is
consulted at every place a node can be written — `upsertNodes` (the single choke point every collector
writes through) and both of `reconcile.ts`'s independent write paths (the id-migration insert, and the
`conversation_turn` reassignment, which is a bare `UPDATE` that would otherwise bypass the check
entirely). This is the fix shape the review itself named: *"a value-keyed deny-list consulted at the
collector seam — not a delete on the table."*

`nexusmem forget <value>` (or `--regex <pattern>`):

1. Deletes every node currently matching the value, across this repo and its stale prior identities
   (same scope `--prune-source` already used).
2. Writes a standing `deny_list` entry, so `upsertNodes`/`reconcile.ts` skip the value on every future
   write — including a `sync --rebuild` that re-reads the untouched, append-only shell-hook log.
3. Leaves one `tombstones` row per removed node — **hash-only**: `body`/`title` are stored as sha256,
   never the literal content. A record that proves something was forgotten should not itself become
   something worth forgetting.
4. Writes one `mutation_audit` row for the whole operation (pattern, scope, affected count), whether or
   not anything matched — pre-emptively blocking a value that hasn't appeared yet is a valid, auditable
   call.

Dry-run by default, matching `sync --prune-source`'s existing convention exactly: without `--yes` it
only counts and prints. `tests/forget.test.ts` proves the specific claim being rebutted — a value is
forgotten, `sync --rebuild` is run (dropping every node and re-reading the untouched hook log from
line 0, the exact scenario the review described), and the value does not come back, while an unrelated
command logged in the same file still does.

## What this does not close

Stated plainly, not left for someone else to find:

- **Permanent in v0.** A `deny_list` entry cannot be removed once written — matching the already-
  established irreversible framing of `--prune-source`/`--rebuild`. `forget --list` shows active
  entries; there is no `--remove <id>` yet.
- **Per-repository, not global.** The deny-list lives in the one `.nexusmem/memory.db` `forget` ran
  against. A value that leaked into shell history from several repositories needs `forget` run once per
  repo — there is no shared, machine-wide deny-list.
- **Matching is a full scan, not an index.** `forget`/`previewForget` filter in JS over every row in
  scope; fine at the per-repo scale this project runs at, not a design that would hold up at millions
  of rows.
- **This closes two of the review's seven rubric mechanisms** (`tombstone`, `mutation_audit`) — it does
  not touch `trust_state`, full `bi-temporal` query support, or `human_review`. Those remain open;
  see the review itself for what each means.

The other four items the review praised without qualification — the shell hook's exit-code capture,
the ranking-exponent budget in `rank.ts`, the two-profile redaction split, and the external-content FTS5
index — are unrelated to this change and unaffected by it.
