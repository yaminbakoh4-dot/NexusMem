import { significantTokens } from '../store/fts.js';
import type { MemoryStore } from '../store/store.js';
import { filterBoilerplateTokens, RESOLVED_BY_DISCUSSION, RESOLVED_BY_RETRY } from './failure-fix.js';

/**
 * Pre-commit risk signal for a set of files -- the building block behind
 * `nexusmem precheck`. Answers two questions per file, both derivable from
 * data this project already collects:
 *
 * 1. "Did something fail here recently, and is it still unresolved?" A
 *    `shell_command` failure counts as resolved if `correlate/failure-fix.ts`
 *    already linked it (`resolved_by:retry` or `resolved_by:discussion`);
 *    unlinked failures are surfaced as still-open. Matching is against the
 *    file's own basename tokens (see `tokensForFile`), reusing the exact
 *    corpus-relative boilerplate filter the discussion-bridge heuristic
 *    already validated -- just re-scoped to `shell_command` nodes, since
 *    frequency is only meaningful measured against the population the match
 *    query actually runs over.
 *
 * 2. "How much has this file actually changed recently?" Sourced from
 *    `node_files`, scoped to `kind = 'git_commit'` only -- `code_diff` nodes
 *    record the identical per-commit file touches, and summing both would
 *    double-count every commit's churn.
 *
 * Deliberately does NOT attempt to correlate failures to *staged* changes by
 * diffing `git status` at capture time (see the module comment in
 * `src/hooks/powershell.ts` for why that was rejected -- it would add a git
 * spawn to every command in every session) or by looking at nearby past
 * commits (a pre-commit check is about files with no commit yet).
 */

export interface FailureMatch {
  id: string;
  command: string;
  ts: string;
}

export interface FileRisk {
  path: string;
  unresolvedFailures: FailureMatch[];
  commitsRecent: number;
}

export interface AssessOptions {
  /** How far back a failure or commit counts as "recent". Default 30 days. */
  recentDays?: number;
}

const DEFAULT_RECENT_DAYS = 30;

interface FailureRow {
  id: string;
  command: string | null;
  ts: string;
}

/**
 * Word-tokenize a file's basename, not its full path -- a shell failure or
 * discussion is far more likely to name a file the way a person would say it
 * ("precheck failed") than by its repo-relative path. The trailing extension
 * is dropped before splitting: a bare `.ts`/`.js`/etc. would otherwise become
 * a required AND-match token that almost no real command or discussion ever
 * types out literally, silently suppressing nearly every match on this
 * (TS-heavy) codebase. Remaining dots (e.g. `index.test.ts` -> `index.test`)
 * still become word boundaries, same as kebab-case/snake_case separators.
 */
function tokensForFile(path: string): string[] {
  const base = path.split('/').pop() ?? path;
  const stem = base.replace(/\.[a-zA-Z0-9]+$/, '');
  const words = stem.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  return significantTokens(words.join(' '));
}

export function assessFiles(
  store: MemoryStore,
  projectId: string,
  paths: readonly string[],
  opts: AssessOptions = {},
): FileRisk[] {
  const db = store.raw;
  const recentDays = opts.recentDays ?? DEFAULT_RECENT_DAYS;
  const cutoffEpoch = Date.now() - recentDays * 24 * 60 * 60 * 1000;

  const findFailures = db.prepare(
    `SELECT n.id AS id, json_extract(n.meta, '$.command') AS command, n.ts AS ts
     FROM nodes_fts
     JOIN nodes n ON n.rowid = nodes_fts.rowid
     WHERE nodes_fts MATCH ?
       AND n.project_id = ?
       AND n.kind = 'shell_command'
       AND json_extract(n.meta, '$.exitCode') IS NOT NULL
       AND json_extract(n.meta, '$.exitCode') != 0
       AND n.ts_epoch >= ?
       AND n.id NOT IN (SELECT from_node_id FROM node_links WHERE relation IN (?, ?))
     ORDER BY n.ts_epoch DESC`,
  );

  const countCommits = db.prepare(
    `SELECT COUNT(DISTINCT nf.node_id) AS c
     FROM node_files nf
     JOIN nodes n ON n.id = nf.node_id
     WHERE n.project_id = ? AND n.kind = 'git_commit' AND nf.path = ? AND n.ts_epoch >= ?`,
  );

  return paths.map((path) => {
    const tokens = filterBoilerplateTokens(db, projectId, tokensForFile(path), ['shell_command']);
    const match = tokens.length > 0 ? tokens.map((t) => `"${t}"*`).join(' AND ') : null;

    const unresolvedFailures = match
      ? (findFailures.all(match, projectId, cutoffEpoch, RESOLVED_BY_RETRY, RESOLVED_BY_DISCUSSION) as FailureRow[])
          .filter((row): row is FailureRow & { command: string } => Boolean(row.command))
          .map((row) => ({ id: row.id, command: row.command, ts: row.ts }))
      : [];

    const commitsRecent = (countCommits.get(projectId, path, cutoffEpoch) as { c: number }).c;

    return { path, unresolvedFailures, commitsRecent };
  });
}
