import { toMatchQuery } from '../store/fts.js';
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
 * - **Conversation bridge.** The best FTS match (via the same `toMatchQuery`
 *   the search path already uses) among `conversation_turn`/`session_summary`
 *   nodes in the following `discussionWindowMs`, searched on the failing
 *   command's own text. Loose by construction (`toMatchQuery` is an OR of
 *   prefix-matched tokens, not a phrase match) -- a discussion that merely
 *   shares a few words with the command can outrank a more specific one.
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

/** The one relation kind this module writes. A separate, future correlator could add others without a schema change. */
export const RESOLVED_BY = 'resolved_by';

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
      store.linkNodes(failure.id, retry.id, RESOLVED_BY);
      linkedByRetry += 1;
    }

    const match = toMatchQuery(failure.command);
    if (match) {
      const discussion = findDiscussion.get(match, projectId, failure.ts_epoch, failure.ts_epoch + discussionWindowMs) as
        | { id: string }
        | undefined;
      if (discussion) {
        store.linkNodes(failure.id, discussion.id, RESOLVED_BY);
        linkedByDiscussion += 1;
      }
    }
  }

  return { failuresExamined: failures.length, linkedByRetry, linkedByDiscussion };
}
