import { toStrictMatchQuery } from '../store/fts.js';
import type { MemoryStore } from '../store/store.js';

/**
 * Links a failed `shell_command` node to whatever later resolved it --
 * Phase 7's "failure -> fix chain" building block. Two independent,
 * deliberately narrow heuristics; a failure can be linked by either, both,
 * or neither. Both are unvalidated until dogfooded against a real corpus
 * (see ROADMAP.local.md's Phase 7 entry) -- this is a first pass sized for
 * that validation, not a claim that either heuristic is correct yet.
 *
 * - **Same-command retry.** A later `shell_command` in the same project and
 *   `cwd`, the *exact* normalized command text (trim + collapse whitespace +
 *   lowercase), `exitCode === 0`, within `retryWindowMs`. High precision by
 *   construction, low recall: a fix that changes the command itself (a typo
 *   correction, an added flag) is invisible to an exact-text match. Not
 *   attempted here -- fuzzy matching is a stretch goal, not this pass's job.
 * - **Conversation bridge.** The best FTS match (via `toStrictMatchQuery`,
 *   an AND of every significant token in the failing command) among
 *   `conversation_turn`/`session_summary` nodes in the following
 *   `discussionWindowMs`. Originally used `toMatchQuery` (OR-of-tokens) and
 *   was dogfooded against this repo's real history 2026-08-15: roughly half
 *   the links were wrong, and the confirmed false positives were all driven
 *   by a single shared generic token (e.g. an "npm whoami" failure linked to
 *   an unrelated summary that just happens to mention "npm"). Tightened to
 *   AND -- still loose in the other direction, since a discussion that
 *   paraphrases the command instead of naming its words will not match, but
 *   an unvalidated false positive is worse than a missed true positive here.
 *   Does not chain further to whatever commit that conversation might cite;
 *   linking failure -> discussion is the whole claim this heuristic makes.
 */

export interface CorrelateOptions {
  /** How long after a failure a same-command retry may count as its resolution. Default 24h. */
  retryWindowMs?: number;
  /** How long after a failure a conversation may count as discussing it. Default 24h. */
  discussionWindowMs?: number;
}

export interface CorrelateStats {
  failuresExamined: number;
  linkedByRetry: number;
  linkedByDiscussion: number;
}

const DEFAULT_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DISCUSSION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * One relation string per heuristic, not a shared `resolved_by` -- dogfooding
 * against this repo's real history (2026-08-15) found the retry heuristic
 * correct on every manually-checked link, but the discussion heuristic wrong
 * on roughly half. A consumer (e.g. `pack.ts`) needs to trust one and ignore
 * the other; a single relation string could not express that distinction
 * without also tagging every row, which the relation string already does
 * for free.
 */
export const RESOLVED_BY_RETRY = 'resolved_by:retry';
export const RESOLVED_BY_DISCUSSION = 'resolved_by:discussion';

interface FailureRow {
  id: string;
  ts_epoch: number;
  command: string | null;
  cwd: string | null;
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function correlateFailures(store: MemoryStore, projectId: string, opts: CorrelateOptions = {}): CorrelateStats {
  const retryWindowMs = opts.retryWindowMs ?? DEFAULT_RETRY_WINDOW_MS;
  const discussionWindowMs = opts.discussionWindowMs ?? DEFAULT_DISCUSSION_WINDOW_MS;

  const db = store.raw;

  const failures = db
    .prepare(
      `SELECT id, ts_epoch, json_extract(meta, '$.command') AS command, json_extract(meta, '$.cwd') AS cwd
       FROM nodes
       WHERE project_id = ? AND kind = 'shell_command'
         AND json_extract(meta, '$.exitCode') IS NOT NULL
         AND json_extract(meta, '$.exitCode') != 0`,
    )
    .all(projectId) as FailureRow[];

  const findRetry = db.prepare(
    `SELECT id FROM nodes
     WHERE project_id = ? AND kind = 'shell_command'
       AND json_extract(meta, '$.exitCode') = 0
       AND ts_epoch > ? AND ts_epoch <= ?
       AND lower(trim(json_extract(meta, '$.command'))) = ?
       AND (json_extract(meta, '$.cwd') IS ? OR json_extract(meta, '$.cwd') = ?)
     ORDER BY ts_epoch ASC LIMIT 1`,
  );

  const findDiscussion = db.prepare(
    `SELECT n.id FROM nodes_fts
     JOIN nodes n ON n.rowid = nodes_fts.rowid
     WHERE nodes_fts MATCH ? AND n.project_id = ? AND n.kind IN ('conversation_turn', 'session_summary')
       AND n.ts_epoch > ? AND n.ts_epoch <= ?
     ORDER BY bm25(nodes_fts, 10.0, 1.0)
     LIMIT 1`,
  );

  let linkedByRetry = 0;
  let linkedByDiscussion = 0;

  for (const failure of failures) {
    if (!failure.command) continue;

    const retry = findRetry.get(
      projectId,
      failure.ts_epoch,
      failure.ts_epoch + retryWindowMs,
      normalizeCommand(failure.command),
      failure.cwd,
      failure.cwd,
    ) as { id: string } | undefined;
    if (retry) {
      store.linkNodes(failure.id, retry.id, RESOLVED_BY_RETRY);
      linkedByRetry += 1;
    }

    const match = toStrictMatchQuery(failure.command);
    if (match) {
      const discussion = findDiscussion.get(match, projectId, failure.ts_epoch, failure.ts_epoch + discussionWindowMs) as
        | { id: string }
        | undefined;
      if (discussion) {
        store.linkNodes(failure.id, discussion.id, RESOLVED_BY_DISCUSSION);
        linkedByDiscussion += 1;
      }
    }
  }

  return { failuresExamined: failures.length, linkedByRetry, linkedByDiscussion };
}
