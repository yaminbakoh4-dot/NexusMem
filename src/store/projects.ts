import type { Database } from 'better-sqlite3';

export interface ProjectRecord {
  id: string;
  root: string;
  originUrl: string | null;
}

export function upsertProject(db: Database, project: ProjectRecord): void {
  db.prepare(
    `INSERT INTO projects (id, root, origin_url, created_at)
     VALUES (@id, @root, @originUrl, @now)
     ON CONFLICT(id) DO UPDATE SET root = excluded.root, origin_url = excluded.origin_url`,
  ).run({ ...project, now: Date.now() });
}

export function markSynced(db: Database, projectId: string): void {
  db.prepare('UPDATE projects SET last_synced_at = ? WHERE id = ?').run(Date.now(), projectId);
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
export function listOtherProjectIds(db: Database, currentProjectId: string): string[] {
  return (db.prepare('SELECT id FROM projects WHERE id != ?').all(currentProjectId) as Array<{ id: string }>).map(
    (r) => r.id,
  );
}

/** Total nodes held under the given project identities. */
export function countProjectNodes(db: Database, projectIds: readonly string[]): number {
  if (projectIds.length === 0) return 0;
  const placeholders = projectIds.map(() => '?').join(', ');
  const row = db.prepare(`SELECT COUNT(*) AS n FROM nodes WHERE project_id IN (${placeholders})`).get(...projectIds) as {
    n: number;
  };
  return row.n;
}

export function getSyncCursor(db: Database, projectId: string, source: string): string | null {
  const row = db.prepare('SELECT cursor FROM sync_state WHERE project_id = ? AND source = ?').get(projectId, source) as
    | { cursor: string | null }
    | undefined;
  return row?.cursor ?? null;
}

export function setSyncCursor(db: Database, projectId: string, source: string, cursor: string | null): void {
  db.prepare(
    `INSERT INTO sync_state (project_id, source, cursor, last_run_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id, source) DO UPDATE SET cursor = excluded.cursor, last_run_at = excluded.last_run_at`,
  ).run(projectId, source, cursor, Date.now());
}

/** Every source that has ever synced for this project, most recently run first. */
export function listSyncState(
  db: Database,
  projectId: string,
): Array<{ source: string; cursor: string | null; lastRunAt: number | null }> {
  return db
    .prepare('SELECT source, cursor, last_run_at AS lastRunAt FROM sync_state WHERE project_id = ? ORDER BY last_run_at DESC')
    .all(projectId) as Array<{ source: string; cursor: string | null; lastRunAt: number | null }>;
}
