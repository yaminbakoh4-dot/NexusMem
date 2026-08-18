import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { type MemoryNode, type NodeKind, type Provenance } from '../core/types.js';
import type { FileEdge } from '../structure/types.js';
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
import { toMatchQuery } from './fts.js';
import { migrate } from './schema.js';
import {
  countProjectNodes,
  getSyncCursor,
  listOtherProjectIds,
  listSyncState,
  markSynced,
  setSyncCursor,
  upsertProject,
  type ProjectRecord,
} from './projects.js';
import {
  clearProject,
  countSourceNodes,
  getNodeMeta,
  getNodeProjectId,
  getNodesByIds,
  getSupersededIds,
  listRecentNodes,
  pruneSourceNodes,
  setSupersedes,
  upsertNodes,
  type IngestStats,
  type LinkedNode,
  type RecentNode,
} from './nodes.js';
import { getLinkedNodeIds, linkNodes } from './links.js';

export type { ProjectRecord } from './projects.js';
export type { IngestStats, LinkedNode, RecentNode } from './nodes.js';

export interface StoreStats {
  total: number;
  byKind: Record<string, number>;
  oldest: string | null;
  newest: string | null;
  distinctFiles: number;
}

export interface SearchHit {
  id: string;
  kind: NodeKind;
  ts: string;
  title: string;
  body: string;
  signal: number;
  provenance: Provenance;
  /** bm25 score; lower is a better lexical match. */
  rank: number;
  /**
   * Human-readable name of the project this hit came from.
   *
   * Never set by the store, which is always querying one project and has
   * nothing to disambiguate. The cross-project pipeline attaches it so a
   * packed context block can say which repository each line is from.
   */
  project?: string;
}

interface NodeRow {
  id: string;
  kind: NodeKind;
  ts: string;
  title: string;
  body: string;
  signal: number;
  provenance: Provenance;
  rank: number;
}

export interface VectorHit {
  id: string;
  kind: NodeKind;
  ts: string;
  title: string;
  body: string;
  signal: number;
  provenance: Provenance;
  /** Euclidean distance from the query vector; lower is closer. */
  distance: number;
}

export interface EmbeddableNode {
  rowid: number;
  id: string;
  title: string;
  body: string;
}

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

export class MemoryStore {
  private constructor(private readonly db: Database.Database) {}

  static open(dbPath: string): MemoryStore {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);

    // WAL lets a long `sync` write while an agent reads via `query`.
    db.pragma('journal_mode = WAL');
    // NORMAL is the right durability trade for a rebuildable derived index:
    // worst case after a crash we re-run sync, which is idempotent anyway.
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');

    // Must load before migrate(): the nodes_vec migration's CREATE VIRTUAL
    // TABLE ... USING vec0 needs the module registered first.
    sqliteVec.load(db);

    migrate(db);
    return new MemoryStore(db);
  }

  close(): void {
    this.db.close();
  }

  upsertProject(project: ProjectRecord): void {
    upsertProject(this.db, project);
  }

  markSynced(projectId: string): void {
    markSynced(this.db, projectId);
  }

  listOtherProjectIds(currentProjectId: string): string[] {
    return listOtherProjectIds(this.db, currentProjectId);
  }

  /** Total nodes held under the given project identities. */
  countProjectNodes(projectIds: readonly string[]): number {
    return countProjectNodes(this.db, projectIds);
  }

  /**
   * Write a batch of nodes in one transaction.
   *
   * Ids are content-addressed, so re-ingesting the same event is a no-op --
   * a node is only rewritten when the derived content actually changed (which
   * happens when scoring or body composition is improved between releases).
   */
  upsertNodes(nodes: readonly MemoryNode[]): IngestStats {
    return upsertNodes(this.db, nodes);
  }

  /**
   * The stored `meta` blob for one node, or null if it has never been
   * written. Used by the session summarizer to recognise work it has
   * already done without re-reading the node's whole body.
   */
  getNodeMeta(id: string): Record<string, unknown> | null {
    return getNodeMeta(this.db, id);
  }

  getSyncCursor(projectId: string, source: string): string | null {
    return getSyncCursor(this.db, projectId, source);
  }

  setSyncCursor(projectId: string, source: string, cursor: string | null): void {
    setSyncCursor(this.db, projectId, source, cursor);
  }

  /** Every source that has ever synced for this project, most recently run first. */
  listSyncState(projectId: string): Array<{ source: string; cursor: string | null; lastRunAt: number | null }> {
    return listSyncState(this.db, projectId);
  }

  /** Drop every node for a project. Used by `sync --rebuild`. */
  clearProject(projectId: string): number {
    return clearProject(this.db, projectId);
  }

  linkNodes(fromNodeId: string, toNodeId: string, relation: string): void {
    linkNodes(this.db, fromNodeId, toNodeId, relation);
  }

  /** Ids linked from `fromNodeId` under one relation, most recently linked first. Empty if none exist. */
  getLinkedNodeIds(fromNodeId: string, relation: string): string[] {
    return getLinkedNodeIds(this.db, fromNodeId, relation);
  }

  /**
   * Hydrate full content for a set of node ids, e.g. to pack a linked
   * resolution alongside the failure node that points at it. Order is not
   * guaranteed to match `ids`; ids with no matching row are silently omitted
   * rather than erroring. `node_links` has `ON DELETE CASCADE` on both
   * columns, so an individual node delete (e.g. `reconcile.ts` migrating a
   * node to a freshly-computed id) removes any link pointing at the old id
   * along with it -- correct as a safety default, though note that reconcile
   * does not currently re-create the link under the migrated node's new id;
   * that gap is not addressed here.
   */
  getNodesByIds(ids: readonly string[]): LinkedNode[] {
    return getNodesByIds(this.db, ids);
  }

  /**
   * The most recently-remembered nodes for a project, newest event first --
   * chronology, not relevance. No `body`: a listing (e.g. a sidebar) needs
   * the title and enough metadata to label each row, not the full text.
   * `idx_nodes_project_ts` already exists for exactly this access pattern.
   */
  listRecentNodes(projectId: string, limit = 20): RecentNode[] {
    return listRecentNodes(this.db, projectId, limit);
  }

  /** How many nodes of one source exist for a project. Used to preview a `pruneSourceNodes` wipe before running it. */
  countSourceNodes(projectId: string, source: string): number {
    return countSourceNodes(this.db, projectId, source);
  }

  /**
   * Delete the nodes of one source that its latest full scan did not produce.
   *
   * Needed by any source whose node ids are derived from content that can be
   * *edited in place* rather than only appended to. A `doc_section` id comes
   * from `path + heading slug`, so renaming a markdown heading mints a new node
   * and strands the old one: `sync` reports `+1 new`, and the corpus then holds
   * two contradictory versions of the same section, both of which come back for
   * the same query. Git and shell nodes describe events that already happened
   * and are never restated, so they have nothing to prune.
   *
   * Scoping is the whole safety story here, and it is deliberately narrow:
   *
   * - `project_id` -- never reaches another repository's memory.
   * - `source` -- an exact match on the collector's own key, so pruning `docs`
   *   cannot touch `conversation:claude-code`, `shell:pwsh` or `git` nodes even
   *   though they share the table.
   * - `keepIds` -- everything this scan produced.
   * - `keepPaths` -- files the scan could not read. Their nodes are kept
   *   because an unreadable file is not evidence that its sections are gone.
   *
   * Callers must pass the ids from a *complete* scan of the source. A partial
   * or filtered scan would read as "these nodes no longer exist" and delete
   * real history.
   */
  pruneSourceNodes(
    projectId: string,
    source: string,
    keepIds: readonly string[],
    opts: { keepPaths?: readonly string[] } = {},
  ): number {
    return pruneSourceNodes(this.db, projectId, source, keepIds, opts);
  }

  /**
   * What `forget(projectId, otherProjectIds, input)` with these same
   * arguments would remove, without writing anything -- the `forget` CLI
   * command's dry-run default.
   */
  previewForget(projectId: string, otherProjectIds: readonly string[], input: DenyListInput): ForgetPreview[] {
    validatePattern(input);
    // id/createdAt are unused by matching -- this entry is never persisted,
    // it only lets previewForget reuse firstMatchingEntry's exact matching
    // logic instead of duplicating it.
    const probeEntry: DenyListEntry = { id: -1, projectId, createdAt: 0, ...input };

    const select = this.db.prepare('SELECT project_id, source, title, body, meta FROM nodes WHERE project_id = ?');
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
  forget(projectId: string, otherProjectIds: readonly string[], input: DenyListInput): ForgetResult {
    return this.db.transaction((): ForgetResult => {
      const entry = insertDenyListEntry(this.db, { ...input, projectId });
      const startedAt = Date.now();

      // Written before the delete loop so tombstones can reference a real
      // mutation_audit.id (the FK the schema enforces); affected_count and
      // finished_at are filled in once the sweep is done.
      const auditId = Number(
        this.db
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

      const select = this.db.prepare(
        'SELECT id, kind, project_id, source, ts, signal, title, body, meta FROM nodes WHERE project_id = ?',
      );
      const dropEmbedding = this.db.prepare('DELETE FROM nodes_vec WHERE rowid = (SELECT rowid FROM nodes WHERE id = ?)');
      const deleteNode = this.db.prepare('DELETE FROM nodes WHERE id = ?');
      const insertTombstone = this.db.prepare(
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

      this.db
        .prepare('UPDATE mutation_audit SET affected_count = ?, finished_at = ? WHERE id = ?')
        .run(removed, Date.now(), auditId);

      return { removed, entryId: entry.id, auditId };
    })();
  }

  /** Active deny-list entries for one project, oldest first. */
  listDenyList(projectId: string): DenyListEntry[] {
    return listDenyListEntries(this.db, projectId);
  }

  /**
   * What `importDenyList` with these same entries would do, without writing
   * anything -- `forget --import`'s dry-run default, same convention as
   * `previewForget`.
   */
  previewImportDenyList(
    projectId: string,
    otherProjectIds: readonly string[],
    entries: readonly DenyListInput[],
  ): ImportPreviewItem[] {
    return entries.map((input) => {
      validatePattern(input);
      if (denyListEntryExists(this.db, projectId, input)) {
        return { matchType: input.matchType, pattern: input.pattern, alreadyPresent: true, wouldRemove: 0 };
      }
      const preview = this.previewForget(projectId, otherProjectIds, input);
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
  importDenyList(
    projectId: string,
    otherProjectIds: readonly string[],
    entries: readonly DenyListInput[],
  ): ImportDenyListResult {
    let imported = 0;
    let skipped = 0;
    let removedNodes = 0;
    for (const input of entries) {
      validatePattern(input);
      if (denyListEntryExists(this.db, projectId, input)) {
        skipped += 1;
        continue;
      }
      const result = this.forget(projectId, otherProjectIds, input);
      imported += 1;
      removedNodes += result.removed;
    }
    return { imported, skipped, removedNodes };
  }

  /**
   * Replace this project's entire `file_edges` snapshot in one transaction.
   *
   * Edges describe the current working tree, not history -- unlike
   * `pruneSourceNodes`'s incremental diff-against-a-scan, there is no cursor
   * to walk, so every `scan-structure`/sync run is a full rescan and this is
   * always a delete-then-insert of the whole set, never a partial update.
   */
  replaceFileEdges(projectId: string, edges: readonly FileEdge[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM file_edges WHERE project_id = ?').run(projectId);
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO file_edges (project_id, from_path, to_path, kind) VALUES (?, ?, ?, ?)',
      );
      for (const edge of edges) insert.run(projectId, edge.fromPath, edge.toPath, edge.kind);
    })();
  }

  /** Edge count + distinct source-file count, for `nexusmem status`'s `structure` line. */
  fileEdgeStats(projectId: string): { edges: number; files: number } {
    const edges = (
      this.db.prepare('SELECT COUNT(*) AS c FROM file_edges WHERE project_id = ?').get(projectId) as { c: number }
    ).c;
    const files = (
      this.db
        .prepare('SELECT COUNT(DISTINCT from_path) AS c FROM file_edges WHERE project_id = ?')
        .get(projectId) as { c: number }
    ).c;
    return { edges, files };
  }

  /**
   * Nodes for this project that have no embedding yet (new, or invalidated
   * by a content change).
   *
   * `afterRowid` makes paging monotonic: the pass walks rowids strictly
   * upward instead of re-reading "the first N still pending". That matters
   * because a node the provider *failed* on stays pending -- an offset-free
   * loop would fetch the same failures forever, which is exactly the shape
   * of an infinite sync.
   */
  findNodesNeedingEmbedding(projectId: string, limit = 200, afterRowid = 0): EmbeddableNode[] {
    return this.db
      .prepare(
        `SELECT n.rowid AS rowid, n.id AS id, n.title AS title, n.body AS body
         FROM nodes n
         LEFT JOIN nodes_vec v ON v.rowid = n.rowid
         WHERE n.project_id = ? AND v.rowid IS NULL AND n.rowid > ?
         ORDER BY n.rowid
         LIMIT ?`,
      )
      .all(projectId, afterRowid, limit) as EmbeddableNode[];
  }

  /** How many of this project's nodes still need a vector. For progress reporting. */
  countNodesNeedingEmbedding(projectId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM nodes n
         LEFT JOIN nodes_vec v ON v.rowid = n.rowid
         WHERE n.project_id = ? AND v.rowid IS NULL`,
      )
      .get(projectId) as { n: number };
    return row.n;
  }

  upsertEmbedding(rowid: number, embedding: Float32Array): void {
    this.db
      .prepare('INSERT OR REPLACE INTO nodes_vec (rowid, embedding) VALUES (?, ?)')
      .run(BigInt(rowid), embedding);
  }

  /**
   * Drop every vector in this database, across all projects.
   *
   * Whole-database on purpose: `nodes_vec` is shared and holds no
   * provenance, so once the vectors in it stopped being comparable there is
   * no subset that is still trustworthy. Nodes are untouched, so the next
   * embedding pass simply rebuilds them.
   */
  dropAllEmbeddings(): number {
    return this.db.prepare('DELETE FROM nodes_vec').run().changes;
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /**
   * Nearest-neighbour search over the corpus.
   *
   * `nodes_vec` has no `project_id` column of its own (embeddings are
   * generic; project scoping lives on `nodes`), so this over-fetches `k`
   * before joining and filtering, then caps to `limit`. Simple and correct;
   * not the efficient way to do this at a scale this project isn't at yet.
   */
  vectorSearch(projectId: string, embedding: Float32Array, limit = 20): VectorHit[] {
    const overfetch = Math.max(limit * 8, 50);
    return this.db
      .prepare(
        `SELECT n.id, n.kind, n.ts, n.title, n.body, n.signal, n.provenance, v.distance AS distance
         FROM nodes_vec v
         JOIN nodes n ON n.rowid = v.rowid
         WHERE v.embedding MATCH ? AND k = ? AND n.project_id = ?
         ORDER BY v.distance
         LIMIT ?`,
      )
      .all(embedding, overfetch, projectId, limit) as VectorHit[];
  }

  stats(projectId: string): StoreStats {
    const kinds = this.db
      .prepare('SELECT kind, COUNT(*) AS n FROM nodes WHERE project_id = ? GROUP BY kind')
      .all(projectId) as Array<{ kind: string; n: number }>;

    const range = this.db
      .prepare('SELECT MIN(ts) AS oldest, MAX(ts) AS newest FROM nodes WHERE project_id = ?')
      .get(projectId) as { oldest: string | null; newest: string | null };

    const files = this.db
      .prepare(
        `SELECT COUNT(DISTINCT f.path) AS n
         FROM node_files f JOIN nodes n ON n.id = f.node_id
         WHERE n.project_id = ?`,
      )
      .get(projectId) as { n: number };

    return {
      total: kinds.reduce((sum, k) => sum + k.n, 0),
      byKind: Object.fromEntries(kinds.map((k) => [k.kind, k.n])),
      oldest: range.oldest,
      newest: range.newest,
      distinctFiles: files.n,
    };
  }

  /**
   * Lexical search over the corpus.
   *
   * Title is weighted 10x body: a commit subject that names the thing you asked
   * about is far stronger evidence than the same word buried in a file list.
   * Ranking by `relevance x signal` happens a layer up, in retrieval.
   */
  search(projectId: string, query: string, limit = 20): SearchHit[] {
    const match = toMatchQuery(query);
    if (!match) return [];

    const rows = this.db
      .prepare(
        `SELECT n.id, n.kind, n.ts, n.title, n.body, n.signal, n.provenance,
                bm25(nodes_fts, 10.0, 1.0) AS rank
         FROM nodes_fts
         JOIN nodes n ON n.rowid = nodes_fts.rowid
         WHERE nodes_fts MATCH ? AND n.project_id = ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(match, projectId, limit) as NodeRow[];

    return rows;
  }

  /** The project a node belongs to, or null if no node has this id. Used by `mark-stale` to validate both ids. */
  getNodeProjectId(id: string): string | null {
    return getNodeProjectId(this.db, id);
  }

  /** Every node id some other node's `supersedes` points at, for one project -- what the ranker should down-weight. */
  getSupersededIds(projectId: string): Set<string> {
    return getSupersededIds(this.db, projectId);
  }

  /** Record that `newNodeId` supersedes `staleNodeId` -- the write behind `nexusmem mark-stale`. Caller validates both ids first. */
  setSupersedes(newNodeId: string, staleNodeId: string): void {
    setSupersedes(this.db, newNodeId, staleNodeId);
  }

  /** Escape hatch for tests and future modules. */
  get raw(): Database.Database {
    return this.db;
  }
}
