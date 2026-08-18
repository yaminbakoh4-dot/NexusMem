import type { Database } from 'better-sqlite3';
import type { NodeKind } from '../core/types.js';
import { sha256Hex } from '../core/ids.js';
import {
  denyListEntryExists,
  firstMatchingEntry,
  insertDenyListEntry,
  listDenyListEntries,
  validatePattern,
  type DenyListEntry,
  type DenyListInput,
  type DenyMatchType,
} from './deny-list.js';

/** One source's worth of matches within one project identity, for `forget`'s dry-run preview. */
export interface ForgetPreview {
  projectId: string;
  source: string;
  count: number;
}

export interface ForgetResult {
  removed: number;
  entryId: number;
  auditId: number;
}

/** One entry from an `importDenyList` source, before it's checked against what's already active. */
export interface ImportPreviewItem {
  matchType: DenyMatchType;
  pattern: string;
  alreadyPresent: boolean;
  /** Nodes this entry would remove right now. Always 0 for an already-present entry -- forget already ran that sweep. */
  wouldRemove: number;
}

export interface ImportDenyListResult {
  /** Newly written deny-list entries -- each one also ran forget's full delete sweep. */
  imported: number;
  /** Entries whose matchType+pattern+ignoreCase was already active; left untouched. */
  skipped: number;
  removedNodes: number;
}

interface ScannableNodeRow {
  id: string;
  kind: NodeKind;
  project_id: string;
  source: string;
  ts: string;
  signal: number;
  title: string;
  body: string;
  meta: string;
}

function parseMeta(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * What `forget(db, projectId, otherProjectIds, input)` with these same
 * arguments would remove, without writing anything -- the `forget` CLI
 * command's dry-run default.
 */
export function previewForget(
  db: Database,
  projectId: string,
  otherProjectIds: readonly string[],
  input: DenyListInput,
): ForgetPreview[] {
  validatePattern(input);
  // id/createdAt are unused by matching -- this entry is never persisted,
  // it only lets previewForget reuse firstMatchingEntry's exact matching
  // logic instead of duplicating it.
  const probeEntry: DenyListEntry = { id: -1, projectId, createdAt: 0, ...input };

  const select = db.prepare('SELECT project_id, source, title, body, meta FROM nodes WHERE project_id = ?');
  const counts = new Map<string, ForgetPreview>();

  for (const scopeId of [projectId, ...otherProjectIds]) {
    const rows = select.all(scopeId) as Array<Pick<ScannableNodeRow, 'project_id' | 'source' | 'title' | 'body' | 'meta'>>;
    for (const row of rows) {
      if (!firstMatchingEntry([probeEntry], { title: row.title, body: row.body, meta: parseMeta(row.meta) })) continue;
      const key = `${row.project_id} ${row.source}`;
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else counts.set(key, { projectId: row.project_id, source: row.source, count: 1 });
    }
  }

  return [...counts.values()];
}

/**
 * Permanently deny-list a value and delete every node it currently matches
 * across `projectId` + `otherProjectIds` (the same sweep `pruneSourceNodes`
 * uses for a repo's stale prior identities).
 *
 * Unlike `pruneSourceNodes`, this doesn't just delete: the deny-list entry
 * written here is consulted by `upsertNodes` and `reconcile.ts` on every
 * future write, so a value forgotten today cannot be re-derived from an
 * append-only source (the shell-hook log, a full transcript re-read) on a
 * later `sync --rebuild`. Each removed node leaves a hash-only tombstone
 * (never the content itself) and the whole operation writes one
 * `mutation_audit` row, whether or not anything matched -- pre-emptively
 * blocking a value that hasn't appeared yet is a valid, auditable call.
 */
export function forget(
  db: Database,
  projectId: string,
  otherProjectIds: readonly string[],
  input: DenyListInput,
): ForgetResult {
  return db.transaction((): ForgetResult => {
    const entry = insertDenyListEntry(db, { ...input, projectId });
    const startedAt = Date.now();

    // Written before the delete loop so tombstones can reference a real
    // mutation_audit.id (the FK the schema enforces); affected_count and
    // finished_at are filled in once the sweep is done.
    const auditId = Number(
      db
        .prepare(
          `INSERT INTO mutation_audit (action, project_id, detail, affected_count, succeeded, error, started_at, finished_at)
           VALUES ('forget', @projectId, @detail, 0, 1, NULL, @startedAt, @startedAt)`,
        )
        .run({
          projectId,
          detail: JSON.stringify({
            pattern: input.pattern,
            matchType: input.matchType,
            ignoreCase: input.ignoreCase,
            reason: input.reason,
            scopeProjectIds: [projectId, ...otherProjectIds],
          }),
          startedAt,
        }).lastInsertRowid,
    );

    const select = db.prepare(
      'SELECT id, kind, project_id, source, ts, signal, title, body, meta FROM nodes WHERE project_id = ?',
    );
    const dropEmbedding = db.prepare('DELETE FROM nodes_vec WHERE rowid = (SELECT rowid FROM nodes WHERE id = ?)');
    const deleteNode = db.prepare('DELETE FROM nodes WHERE id = ?');
    const insertTombstone = db.prepare(
      `INSERT INTO tombstones
         (node_id, project_id, kind, source, ts, signal, body_sha256, title_sha256, body_length, deny_list_id, mutation_audit_id, removed_at)
       VALUES (@nodeId, @projectId, @kind, @source, @ts, @signal, @bodySha256, @titleSha256, @bodyLength, @denyListId, @mutationAuditId, @removedAt)`,
    );

    let removed = 0;
    for (const scopeId of [projectId, ...otherProjectIds]) {
      const rows = select.all(scopeId) as ScannableNodeRow[];
      for (const row of rows) {
        if (!firstMatchingEntry([entry], { title: row.title, body: row.body, meta: parseMeta(row.meta) })) continue;

        dropEmbedding.run(row.id);
        insertTombstone.run({
          nodeId: row.id,
          projectId: row.project_id,
          kind: row.kind,
          source: row.source,
          ts: row.ts,
          signal: row.signal,
          bodySha256: sha256Hex(row.body),
          titleSha256: sha256Hex(row.title),
          bodyLength: row.body.length,
          denyListId: entry.id,
          mutationAuditId: auditId,
          removedAt: Date.now(),
        });
        deleteNode.run(row.id);
        removed += 1;
      }
    }

    db.prepare('UPDATE mutation_audit SET affected_count = ?, finished_at = ? WHERE id = ?').run(removed, Date.now(), auditId);

    return { removed, entryId: entry.id, auditId };
  })();
}

/** Active deny-list entries for one project, oldest first. */
export function listDenyList(db: Database, projectId: string): DenyListEntry[] {
  return listDenyListEntries(db, projectId);
}

/**
 * What `importDenyList` with these same entries would do, without writing
 * anything -- `forget --import`'s dry-run default, same convention as
 * `previewForget`.
 */
export function previewImportDenyList(
  db: Database,
  projectId: string,
  otherProjectIds: readonly string[],
  entries: readonly DenyListInput[],
): ImportPreviewItem[] {
  return entries.map((input) => {
    validatePattern(input);
    if (denyListEntryExists(db, projectId, input)) {
      return { matchType: input.matchType, pattern: input.pattern, alreadyPresent: true, wouldRemove: 0 };
    }
    const preview = previewForget(db, projectId, otherProjectIds, input);
    return {
      matchType: input.matchType,
      pattern: input.pattern,
      alreadyPresent: false,
      wouldRemove: preview.reduce((sum, p) => sum + p.count, 0),
    };
  });
}

/**
 * Re-apply a previously-exported deny-list against this project.
 *
 * This is the fix for `forget`'s per-checkout gap: `deny_list` lives in
 * `.nexusmem/memory.db`, which is gitignored and never travels with `git
 * clone`/`git push`, while the things a fresh `sync` re-derives from --
 * git history and the user-home shell-hook log -- both travel or persist
 * independently of any one checkout. A fresh clone or a restored backup
 * starts with an empty deny_list and no memory of what was forgotten. See
 * docs/forget-mechanism.md.
 *
 * Entries already active (same matchType+pattern+ignoreCase) are left
 * untouched. Every new one goes through `forget` itself, so an imported
 * value is deleted from this checkout's nodes too, not just blocked going
 * forward -- exactly what running `nexusmem forget <value>` fresh in this
 * checkout would have done.
 */
export function importDenyList(
  db: Database,
  projectId: string,
  otherProjectIds: readonly string[],
  entries: readonly DenyListInput[],
): ImportDenyListResult {
  let imported = 0;
  let skipped = 0;
  let removedNodes = 0;
  for (const input of entries) {
    validatePattern(input);
    if (denyListEntryExists(db, projectId, input)) {
      skipped += 1;
      continue;
    }
    const result = forget(db, projectId, otherProjectIds, input);
    imported += 1;
    removedNodes += result.removed;
  }
  return { imported, skipped, removedNodes };
}
