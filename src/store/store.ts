import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import type { MemoryNode, NodeKind } from '../core/types.js';
import { toMatchQuery } from './fts.js';
import { migrate } from './schema.js';

export interface IngestStats {
  inserted: number;
  updated: number;
  unchanged: number;
}

export interface ProjectRecord {
  id: string;
  root: string;
  originUrl: string | null;
}

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
  rank: number;
}

export interface VectorHit {
  id: string;
  kind: NodeKind;
  ts: string;
  title: string;
  body: string;
  signal: number;
  /** Euclidean distance from the query vector; lower is closer. */
  distance: number;
}

export interface EmbeddableNode {
  rowid: number;
  id: string;
  title: string;
  body: string;
}

function epochOf(ts: string): number {
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? Date.now() : parsed;
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
    this.db
      .prepare(
        `INSERT INTO projects (id, root, origin_url, created_at)
         VALUES (@id, @root, @originUrl, @now)
         ON CONFLICT(id) DO UPDATE SET root = excluded.root, origin_url = excluded.origin_url`,
      )
      .run({ ...project, now: Date.now() });
  }

  markSynced(projectId: string): void {
    this.db.prepare('UPDATE projects SET last_synced_at = ? WHERE id = ?').run(Date.now(), projectId);
  }

  /**
   * Every other project id ever recorded in THIS repo's own database.
   *
   * A repo's `.nexusmem/memory.db` is never shared with another repo (each
   * gets its own, gitignored), so any id here besides `currentProjectId` is
   * evidence of a prior identity for this same repo -- typically its git
   * remote URL changed since the last sync. See `reconcileProjectId` in
   * `store/reconcile.ts`.
   */
  listOtherProjectIds(currentProjectId: string): string[] {
    return (this.db.prepare('SELECT id FROM projects WHERE id != ?').all(currentProjectId) as Array<{ id: string }>).map(
      (r) => r.id,
    );
  }

  /**
   * Write a batch of nodes in one transaction.
   *
   * Ids are content-addressed, so re-ingesting the same event is a no-op --
   * a node is only rewritten when the derived content actually changed (which
   * happens when scoring or body composition is improved between releases).
   */
  upsertNodes(nodes: readonly MemoryNode[]): IngestStats {
    const exists = this.db.prepare('SELECT body, signal, title FROM nodes WHERE id = ?');
    // vec0 has no triggers to keep itself in sync (see schema.ts) -- when a
    // node's indexed text actually changes, its old embedding is stale and
    // must be dropped so the embedding pass in vector/embed.ts re-embeds it.
    const dropStaleEmbedding = this.db.prepare(
      'DELETE FROM nodes_vec WHERE rowid = (SELECT rowid FROM nodes WHERE id = ?)',
    );
    const insertNode = this.db.prepare(
      `INSERT INTO nodes (id, kind, project_id, ts, ts_epoch, source, title, body, signal, meta, created_at)
       VALUES (@id, @kind, @projectId, @ts, @tsEpoch, @source, @title, @body, @signal, @meta, @now)
       ON CONFLICT(id) DO UPDATE SET
         ts = excluded.ts, ts_epoch = excluded.ts_epoch, source = excluded.source,
         title = excluded.title, body = excluded.body, signal = excluded.signal, meta = excluded.meta`,
    );
    const clearFiles = this.db.prepare('DELETE FROM node_files WHERE node_id = ?');
    const insertFile = this.db.prepare(
      `INSERT INTO node_files (node_id, path, previous_path, insertions, deletions, is_binary)
       VALUES (@nodeId, @path, @previousPath, @insertions, @deletions, @isBinary)
       ON CONFLICT(node_id, path) DO UPDATE SET
         previous_path = excluded.previous_path, insertions = excluded.insertions,
         deletions = excluded.deletions, is_binary = excluded.is_binary`,
    );

    const stats: IngestStats = { inserted: 0, updated: 0, unchanged: 0 };

    const run = this.db.transaction((batch: readonly MemoryNode[]) => {
      const now = Date.now();

      for (const node of batch) {
        const prior = exists.get(node.id) as { body: string; signal: number; title: string } | undefined;

        if (prior) {
          if (prior.body === node.body && prior.signal === node.signal && prior.title === node.title) {
            stats.unchanged += 1;
            continue;
          }
          stats.updated += 1;
          dropStaleEmbedding.run(node.id);
        } else {
          stats.inserted += 1;
        }

        insertNode.run({
          id: node.id,
          kind: node.kind,
          projectId: node.projectId,
          ts: node.ts,
          tsEpoch: epochOf(node.ts),
          source: node.source,
          title: node.title,
          body: node.body,
          signal: node.signal,
          meta: JSON.stringify(node.meta),
          now,
        });

        clearFiles.run(node.id);
        for (const file of node.files) {
          insertFile.run({
            nodeId: node.id,
            path: file.path,
            previousPath: file.previousPath ?? null,
            insertions: file.insertions,
            deletions: file.deletions,
            isBinary: file.binary ? 1 : 0,
          });
        }
      }
    });

    run(nodes);
    return stats;
  }

  /**
   * The stored `meta` blob for one node, or null if it has never been
   * written. Used by the session summarizer to recognise work it has
   * already done without re-reading the node's whole body.
   */
  getNodeMeta(id: string): Record<string, unknown> | null {
    const row = this.db.prepare('SELECT meta FROM nodes WHERE id = ?').get(id) as { meta: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.meta) as Record<string, unknown>;
    } catch {
      return null; // a meta blob we cannot read is treated as absent, never as a reason to fail a sync
    }
  }

  getSyncCursor(projectId: string, source: string): string | null {
    const row = this.db
      .prepare('SELECT cursor FROM sync_state WHERE project_id = ? AND source = ?')
      .get(projectId, source) as { cursor: string | null } | undefined;
    return row?.cursor ?? null;
  }

  setSyncCursor(projectId: string, source: string, cursor: string | null): void {
    this.db
      .prepare(
        `INSERT INTO sync_state (project_id, source, cursor, last_run_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id, source) DO UPDATE SET cursor = excluded.cursor, last_run_at = excluded.last_run_at`,
      )
      .run(projectId, source, cursor, Date.now());
  }

  /** Every source that has ever synced for this project, most recently run first. */
  listSyncState(projectId: string): Array<{ source: string; cursor: string | null; lastRunAt: number | null }> {
    return this.db
      .prepare('SELECT source, cursor, last_run_at AS lastRunAt FROM sync_state WHERE project_id = ? ORDER BY last_run_at DESC')
      .all(projectId) as Array<{ source: string; cursor: string | null; lastRunAt: number | null }>;
  }

  /** Drop every node for a project. Used by `sync --rebuild`. */
  clearProject(projectId: string): number {
    // nodes_vec has no FK/trigger relationship to nodes (see schema.ts) --
    // clean it up explicitly, before the rows it points at disappear.
    this.db
      .prepare('DELETE FROM nodes_vec WHERE rowid IN (SELECT rowid FROM nodes WHERE project_id = ?)')
      .run(projectId);
    const info = this.db.prepare('DELETE FROM nodes WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM sync_state WHERE project_id = ?').run(projectId);
    return info.changes;
  }

  /** How many nodes of one source exist for a project. Used to preview a `pruneSourceNodes` wipe before running it. */
  countSourceNodes(projectId: string, source: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM nodes WHERE project_id = ? AND source = ?')
      .get(projectId, source) as { count: number };
    return row.count;
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
    // json_each keeps this one statement regardless of how many sections a
    // repo has, instead of an id list that grows into SQLite's parameter cap.
    const scope = `project_id = @projectId AND source = @source
        AND id NOT IN (SELECT value FROM json_each(@keepIds))
        AND id NOT IN (SELECT node_id FROM node_files WHERE path IN (SELECT value FROM json_each(@keepPaths)))`;

    const params = {
      projectId,
      source,
      keepIds: JSON.stringify(keepIds),
      keepPaths: JSON.stringify(opts.keepPaths ?? []),
    };

    return this.db.transaction(() => {
      // Same ordering constraint as clearProject: nodes_vec is not reachable by
      // FK or trigger, so its rows must go while their rowids still resolve.
      // nodes_fts *is* trigger-backed (schema.ts) and cleans itself up on
      // DELETE, and node_files cascades.
      this.db.prepare(`DELETE FROM nodes_vec WHERE rowid IN (SELECT rowid FROM nodes WHERE ${scope})`).run(params);
      return this.db.prepare(`DELETE FROM nodes WHERE ${scope}`).run(params).changes;
    })();
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
        `SELECT n.id, n.kind, n.ts, n.title, n.body, n.signal, v.distance AS distance
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
        `SELECT n.id, n.kind, n.ts, n.title, n.body, n.signal,
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

  /** Escape hatch for tests and future modules. */
  get raw(): Database.Database {
    return this.db;
  }
}
