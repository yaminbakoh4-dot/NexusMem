import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
   * Write a batch of nodes in one transaction.
   *
   * Ids are content-addressed, so re-ingesting the same event is a no-op --
   * a node is only rewritten when the derived content actually changed (which
   * happens when scoring or body composition is improved between releases).
   */
  upsertNodes(nodes: readonly MemoryNode[]): IngestStats {
    const exists = this.db.prepare('SELECT body, signal, title FROM nodes WHERE id = ?');
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
    const info = this.db.prepare('DELETE FROM nodes WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM sync_state WHERE project_id = ?').run(projectId);
    return info.changes;
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
