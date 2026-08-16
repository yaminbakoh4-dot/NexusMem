import type Database from 'better-sqlite3';
import { significantTokens } from '../store/fts.js';
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
 * - **Conversation bridge.** The best FTS match (AND of every significant,
 *   non-boilerplate token in the failing command) among
 *   `conversation_turn`/`session_summary` nodes in the following
 *   `discussionWindowMs`. Originally used an OR-of-tokens match and was
 *   dogfooded against this repo's real history 2026-08-15: roughly half
 *   the links were wrong, and the confirmed false positives were all driven
 *   by a single shared generic token (e.g. an "npm whoami" failure linked to
 *   an unrelated summary that just happens to mention "npm"). Tightened to
 *   AND -- still loose in the other direction, since a discussion that
 *   paraphrases the command instead of naming its words will not match, but
 *   an unvalidated false positive is worse than a missed true positive here.
 *   Does not chain further to whatever commit that conversation might cite;
 *   linking failure -> discussion is the whole claim this heuristic makes.
 *
 *   Re-dogfooded at larger scale 2026-08-16 against a second real project
 *   (`villa-bot`, previously unseen by this heuristic): the AND fix held on
 *   this repo's own 5 links (still 5/5 correct) but missed a new false-
 *   positive class the small original sample never surfaced -- a command
 *   made entirely of the tool's own boilerplate words (`nexusmem sync`)
 *   AND-matched an unrelated turn that just happened to show the same
 *   command as generic advice. bm25 score could not separate this from a
 *   true positive (measured: the false positive scored -9.685, *stronger*
 *   than two real true positives at -5.899/-6.559) -- bm25 rewards rarity
 *   *within whatever corpus it's run against*, and in villa-bot's smaller
 *   corpus those words hadn't accumulated enough occurrences to be
 *   recognized as boilerplate, even though the same words measure 33-39%
 *   document frequency in this repo's own (more self-referential) history.
 *   `filterBoilerplateTokens` below adds that corpus-relative check as a
 *   second filtering pass. Note honestly: at villa-bot's actual measured
 *   frequency for those words (9.3%/4.6%, comfortably under the threshold),
 *   this pass does *not* retroactively catch that specific instance -- it
 *   was a low-frequency AND-coincidence, not corpus saturation. What it does
 *   protect against is the class the numbers actually support: a command
 *   whose words are truly ubiquitous in a project's own history (like this
 *   repo's own name/verbs), which the villa-bot corpus wasn't saturated with
 *   yet but plausibly will be over time, and which this repo's corpus
 *   already is.
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

/**
 * A token appearing in more than this fraction of a project's own
 * `conversation_turn`/`session_summary` nodes is treated as corpus-relative
 * boilerplate for the discussion-bridge heuristic -- picked from real
 * measured numbers, not guessed: the known "id" false positive measures
 * 22-40% document frequency across two real corpora checked, and this repo's
 * own name/verbs ("nexusmem"/"sync") measure 33-39% in this repo's own
 * history, while genuinely distinguishing terms from the same real links
 * ("whoami", "wsl", "publish") all measure under 2%. 0.2 sits clearly below
 * the boilerplate cluster and clearly above the signal cluster in every
 * real measurement taken so far.
 */
const MAX_TOKEN_DOC_FREQUENCY = 0.2;

/**
 * Below this many discussable nodes, frequency is not a meaningful signal --
 * with a handful of nodes total, any word can trivially hit 20%+ just by
 * appearing once or twice, which would suppress real links on a young
 * project purely for lack of data rather than because the word is actually
 * boilerplate. 10 is a floor, not a tuned value: below it, skip the filter
 * entirely and fall back to whatever `significantTokens` already decided.
 */
const MIN_CORPUS_FOR_FREQUENCY_FILTER = 10;

/**
 * Drops tokens that are boilerplate *in this specific project's own
 * history*, unlike `LOW_SIGNAL_TOKENS` in `fts.ts` which is a fixed list for
 * general search. Deliberately does NOT fall back to the unfiltered token
 * list when every token is boilerplate (the pattern `significantTokens`
 * itself uses) -- for this heuristic specifically, a command built entirely
 * of words that saturate the project's own corpus (e.g. this repo's own
 * name/verbs, "nexusmem sync") has no word left that could distinguish a
 * real discussion of *this* failure from generic chatter, and this
 * heuristic's whole design already prefers a missed link over a false one.
 */
function filterBoilerplateTokens(db: Database.Database, projectId: string, tokens: string[]): string[] {
  if (tokens.length === 0) return tokens;

  const total = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM nodes WHERE project_id = ? AND kind IN ('conversation_turn', 'session_summary')`)
      .get(projectId) as { c: number }
  ).c;
  if (total < MIN_CORPUS_FOR_FREQUENCY_FILTER) return tokens;

  const countMatching = db.prepare(
    `SELECT COUNT(*) AS c FROM nodes_fts JOIN nodes n ON n.rowid = nodes_fts.rowid
     WHERE nodes_fts MATCH ? AND n.project_id = ? AND n.kind IN ('conversation_turn', 'session_summary')`,
  );

  return tokens.filter((t) => {
    const matching = (countMatching.get(`"${t}"*`, projectId) as { c: number }).c;
    return matching / total <= MAX_TOKEN_DOC_FREQUENCY;
  });
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

    const tokens = filterBoilerplateTokens(db, projectId, significantTokens(failure.command));
    const match = tokens.length > 0 ? tokens.map((t) => `"${t}"*`).join(' AND ') : null;
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
