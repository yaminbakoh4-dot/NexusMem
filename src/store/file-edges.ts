import type { Database } from 'better-sqlite3';
import type { FileEdge } from '../structure/types.js';

/**
 * Replace this project's entire `file_edges` snapshot in one transaction.
 *
 * Edges describe the current working tree, not history -- unlike
 * `pruneSourceNodes`'s incremental diff-against-a-scan, there is no cursor
 * to walk, so every `scan-structure`/sync run is a full rescan and this is
 * always a delete-then-insert of the whole set, never a partial update.
 */
export function replaceFileEdges(db: Database, projectId: string, edges: readonly FileEdge[]): void {
  db.transaction(() => {
    db.prepare('DELETE FROM file_edges WHERE project_id = ?').run(projectId);
    const insert = db.prepare('INSERT OR IGNORE INTO file_edges (project_id, from_path, to_path, kind) VALUES (?, ?, ?, ?)');
    for (const edge of edges) insert.run(projectId, edge.fromPath, edge.toPath, edge.kind);
  })();
}

/** Edge count + distinct source-file count, for `nexusmem status`'s `structure` line. */
export function fileEdgeStats(db: Database, projectId: string): { edges: number; files: number } {
  const edges = (db.prepare('SELECT COUNT(*) AS c FROM file_edges WHERE project_id = ?').get(projectId) as { c: number }).c;
  const files = (
    db.prepare('SELECT COUNT(DISTINCT from_path) AS c FROM file_edges WHERE project_id = ?').get(projectId) as {
      c: number;
    }
  ).c;
  return { edges, files };
}
