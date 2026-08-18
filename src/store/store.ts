import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { type MemoryNode, type NodeKind, type Provenance } from '../core/types.js';
import type { FileEdge } from '../structure/types.js';
import type { DenyListEntry, DenyListInput } from './deny-list.js';
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
import {
  forget,
  importDenyList,
  listDenyList,
  previewForget,
  previewImportDenyList,
  type ForgetPreview,
  type ForgetResult,
  type ImportDenyListResult,
  type ImportPreviewItem,
} from './forget.js';
import { fileEdgeStats, replaceFileEdges } from './file-edges.js';
import {
  countNodesNeedingEmbedding,
  dropAllEmbeddings,
  findNodesNeedingEmbedding,
  upsertEmbedding,
  vectorSearch,
  type EmbeddableNode,
  type VectorHit,
} from './embeddings.js';

export type { ProjectRecord } from './projects.js';
export type { IngestStats, LinkedNode, RecentNode } from './nodes.js';
export type { ForgetPreview, ForgetResult, ImportDenyListResult, ImportPreviewItem } from './forget.js';
export type { EmbeddableNode, VectorHit } from './embeddings.js';

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

  previewForget(projectId: string, otherProjectIds: readonly string[], input: DenyListInput): ForgetPreview[] {
    return previewForget(this.db, projectId, otherProjectIds, input);
  }

  forget(projectId: string, otherProjectIds: readonly string[], input: DenyListInput): ForgetResult {
    return forget(this.db, projectId, otherProjectIds, input);
  }

  /** Active deny-list entries for one project, oldest first. */
  listDenyList(projectId: string): DenyListEntry[] {
    return listDenyList(this.db, projectId);
  }

  previewImportDenyList(
    projectId: string,
    otherProjectIds: readonly string[],
    entries: readonly DenyListInput[],
  ): ImportPreviewItem[] {
    return previewImportDenyList(this.db, projectId, otherProjectIds, entries);
  }

  importDenyList(
    projectId: string,
    otherProjectIds: readonly string[],
    entries: readonly DenyListInput[],
  ): ImportDenyListResult {
    return importDenyList(this.db, projectId, otherProjectIds, entries);
  }

  replaceFileEdges(projectId: string, edges: readonly FileEdge[]): void {
    replaceFileEdges(this.db, projectId, edges);
  }

  /** Edge count + distinct source-file count, for `nexusmem status`'s `structure` line. */
  fileEdgeStats(projectId: string): { edges: number; files: number } {
    return fileEdgeStats(this.db, projectId);
  }

  findNodesNeedingEmbedding(projectId: string, limit = 200, afterRowid = 0): EmbeddableNode[] {
    return findNodesNeedingEmbedding(this.db, projectId, limit, afterRowid);
  }

  /** How many of this project's nodes still need a vector. For progress reporting. */
  countNodesNeedingEmbedding(projectId: string): number {
    return countNodesNeedingEmbedding(this.db, projectId);
  }

  upsertEmbedding(rowid: number, embedding: Float32Array): void {
    upsertEmbedding(this.db, rowid, embedding);
  }

  dropAllEmbeddings(): number {
    return dropAllEmbeddings(this.db);
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

  vectorSearch(projectId: string, embedding: Float32Array, limit = 20): VectorHit[] {
    return vectorSearch(this.db, projectId, embedding, limit);
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
