import type { Database } from 'better-sqlite3';

/**
 * Record a directed relationship between two existing nodes -- e.g. a
 * failed `shell_command` and whatever node later resolved it
 * (`relation = 'resolved_by'`). A relation, not a new content node: the
 * correlation *is* the relationship, and duplicating either side's content
 * into a third node would just be another independently-ranked candidate.
 *
 * Idempotent by design (`INSERT OR IGNORE` against the table's own primary
 * key) so re-running a correlation pass over already-linked nodes is a
 * no-op, not a duplicate-row error.
 */
export function linkNodes(db: Database, fromNodeId: string, toNodeId: string, relation: string): void {
  db.prepare('INSERT OR IGNORE INTO node_links (from_node_id, to_node_id, relation, created_at) VALUES (?, ?, ?, ?)').run(
    fromNodeId,
    toNodeId,
    relation,
    Date.now(),
  );
}

/** Ids linked from `fromNodeId` under one relation, most recently linked first. Empty if none exist. */
export function getLinkedNodeIds(db: Database, fromNodeId: string, relation: string): string[] {
  return (
    db
      .prepare('SELECT to_node_id FROM node_links WHERE from_node_id = ? AND relation = ? ORDER BY created_at DESC')
      .all(fromNodeId, relation) as Array<{ to_node_id: string }>
  ).map((row) => row.to_node_id);
}
