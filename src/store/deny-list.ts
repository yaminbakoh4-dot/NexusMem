import type { Database } from 'better-sqlite3';

/**
 * Value-keyed deletion, consulted at every node-write seam.
 *
 * `pruneSourceNodes` (store.ts) deletes at the granularity of a whole
 * collector source; this is the finer-grained complement -- a standing rule
 * that a specific value (a leaked key, a name) must never become a node,
 * checked on every insert rather than swept after the fact. See
 * `MemoryStore.forget`.
 */

export type DenyMatchType = 'literal' | 'regex';

export interface DenyListEntry {
  id: number;
  projectId: string;
  matchType: DenyMatchType;
  pattern: string;
  ignoreCase: boolean;
  reason: string | null;
  createdAt: number;
}

export interface DenyListInput {
  matchType: DenyMatchType;
  pattern: string;
  ignoreCase: boolean;
  reason: string | null;
}

export class DenyListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DenyListError';
  }
}

/**
 * Rejects patterns that would silently deny far more than intended:
 * - an empty/whitespace-only literal, which `String.includes` would match
 *   against every node ever written.
 * - a regex that fails to compile.
 * - a regex that matches the empty string (`.*`, `a*`, ...), which matches
 *   every node just as broadly as an empty literal does.
 */
export function validatePattern(input: DenyListInput): void {
  if (input.pattern.trim().length === 0) {
    throw new DenyListError('pattern must not be empty');
  }

  if (input.matchType === 'regex') {
    let compiled: RegExp;
    try {
      compiled = new RegExp(input.pattern, input.ignoreCase ? 'i' : '');
    } catch (err) {
      throw new DenyListError(`invalid regex: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (compiled.test('')) {
      throw new DenyListError('regex must not match the empty string (it would deny every node)');
    }
  }
}

function toEntry(row: {
  id: number;
  project_id: string;
  match_type: string;
  pattern: string;
  ignore_case: number;
  reason: string | null;
  created_at: number;
}): DenyListEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    matchType: row.match_type as DenyMatchType,
    pattern: row.pattern,
    ignoreCase: row.ignore_case === 1,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

export function listDenyListEntries(db: Database, projectId: string): DenyListEntry[] {
  const rows = db
    .prepare(
      `SELECT id, project_id, match_type, pattern, ignore_case, reason, created_at
       FROM deny_list WHERE project_id = ? ORDER BY created_at ASC`,
    )
    .all(projectId) as Parameters<typeof toEntry>[0][];
  return rows.map(toEntry);
}

export function insertDenyListEntry(db: Database, input: DenyListInput & { projectId: string }): DenyListEntry {
  validatePattern(input);
  const createdAt = Date.now();
  const result = db
    .prepare(
      `INSERT INTO deny_list (project_id, match_type, pattern, ignore_case, reason, created_at)
       VALUES (@projectId, @matchType, @pattern, @ignoreCase, @reason, @createdAt)`,
    )
    .run({
      projectId: input.projectId,
      matchType: input.matchType,
      pattern: input.pattern,
      ignoreCase: input.ignoreCase ? 1 : 0,
      reason: input.reason,
      createdAt,
    });
  return {
    id: Number(result.lastInsertRowid),
    projectId: input.projectId,
    matchType: input.matchType,
    pattern: input.pattern,
    ignoreCase: input.ignoreCase,
    reason: input.reason,
    createdAt,
  };
}

/** Whether an equivalent entry (same matchType + pattern + ignoreCase) is already active for this project -- keeps `importDenyList` idempotent across repeated runs of the same export file. */
export function denyListEntryExists(db: Database, projectId: string, input: DenyListInput): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM deny_list WHERE project_id = ? AND match_type = ? AND pattern = ? AND ignore_case = ? LIMIT 1`,
    )
    .get(projectId, input.matchType, input.pattern, input.ignoreCase ? 1 : 0);
  return row !== undefined;
}

/** `title`, `body` and `meta` concatenated, matching against everything a query could surface for this node. */
function matchableText(node: { title: string; body: string; meta: unknown }): string {
  return `${node.title}\n${node.body}\n${JSON.stringify(node.meta ?? {})}`;
}

/** First entry (in creation order) that matches this node's title/body/meta, or null. */
export function firstMatchingEntry(
  entries: readonly DenyListEntry[],
  node: { title: string; body: string; meta: unknown },
): DenyListEntry | null {
  if (entries.length === 0) return null;
  const text = matchableText(node);

  for (const entry of entries) {
    if (entry.matchType === 'literal') {
      const haystack = entry.ignoreCase ? text.toLowerCase() : text;
      const needle = entry.ignoreCase ? entry.pattern.toLowerCase() : entry.pattern;
      if (haystack.includes(needle)) return entry;
    } else {
      const compiled = new RegExp(entry.pattern, entry.ignoreCase ? 'i' : '');
      if (compiled.test(text)) return entry;
    }
  }

  return null;
}
