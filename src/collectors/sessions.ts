import { makeNodeId } from '../core/ids.js';
import { truncate } from '../core/text.js';
import type { MemoryNode } from '../core/types.js';
import type { RawConversationTurn } from '../conversation/types.js';
import type { SummarizationProvider } from '../slm/provider.js';
import {
  buildSessionPrompt,
  groupTurnsIntoSessions,
  parseSummary,
  selectSettledSessions,
  sessionFallbackTitle,
  type SessionGroup,
} from '../slm/summarize.js';
import { extractMentionedFiles } from './conversation.js';

export const SESSION_SOURCE_PREFIX = 'session';

export interface SessionCollectorOptions {
  /** Minutes of quiet before a session is considered finished. Default 30. */
  settleMinutes?: number;
  /** Character budget for one prompt. Default 12000. */
  maxPromptChars?: number;
  /** Final cap on a stored summary body. Default 2500. */
  maxBodyChars?: number;
  /** Sessions summarized in one sync. Default 10 -- each is a model call measured in seconds. */
  maxSessions?: number;
  /** Injected for testing. */
  now?: Date;
  /**
   * Returns the content hash already stored for a session, or null.
   *
   * The collector asks rather than reads so it stays free of the store: the
   * sync layer owns database access, and this stays a pure
   * transcripts-plus-model function that a test can drive with a Map.
   */
  knownHash?: (sessionKey: string) => string | null;
  onProgress?: (done: number, total: number) => void;
}

const DEFAULT_SETTLE_MINUTES = 30;
const DEFAULT_MAX_BODY_CHARS = 2500;
const DEFAULT_MAX_SESSIONS = 10;

export interface SessionCollectorResult {
  nodes: MemoryNode[];
  /** Sessions already summarized at the same content hash, so not re-sent to the model. */
  cached: number;
  /** Sessions still being worked in, so not eligible yet. */
  unsettled: number;
  /**
   * Eligible sessions left for a later sync because `maxSessions` was
   * reached. Distinct from `unsettled`: these are ready and merely queued,
   * and without the distinction a first sync of a long-lived repository
   * reports a number well below the session count with nothing to explain
   * the gap.
   */
  deferred: number;
  /** Sessions the model failed to summarize. */
  failed: number;
  /** True if the model produced nothing at all -- almost always "no chat model pulled". */
  providerUnavailable: boolean;
}

/**
 * Signal for a session summary.
 *
 * Above a typical conversation turn (0.3-0.7) because a summary is the
 * distilled form of many turns, and a query that matches it is better served
 * by the overview than by one exchange out of forty. Held below the top of
 * the commit range so a summary can never outrank the commit that a question
 * is literally about. Longer sessions score higher: more exchanges distilled
 * into the same budget is a denser node, not a longer one.
 */
export function scoreSession(turnCount: number): number {
  const score = 0.6 + Math.min(0.25, turnCount / 100);
  return Number(score.toFixed(3));
}

function toNode(
  session: SessionGroup,
  projectId: string,
  summary: { title: string; body: string },
  meta: { hash: string; model: string; includedTurns: number },
  maxBodyChars: number,
): MemoryNode {
  const header = `Session of ${session.startedAt.slice(0, 10)} — ${session.turns.length} exchange(s)`;
  const body = `${header}\n\n${summary.body}`;

  return {
    id: makeNodeId(projectId, 'session_summary', session.sessionKey),
    kind: 'session_summary',
    projectId,
    // The session's end, not its start: a summary describes a finished piece
    // of work, and recency ranking should treat it as being as fresh as the
    // last thing that happened in it.
    ts: session.endedAt,
    source: `${SESSION_SOURCE_PREFIX}:${session.source}`,
    title: truncate(summary.title, 200),
    body: truncate(body, maxBodyChars),
    // Drawn from the whole session rather than only the summary: the model
    // mentions few paths, but `node_files` is what lets "why is this file
    // like this" reach the session that explains it.
    files: extractMentionedFiles(session.turns.map((t) => `${t.userText}\n${t.assistantText}`).join('\n')),
    signal: scoreSession(session.turns.length),
    provenance: 'derived', // a model's distillation, not a directly observed event
    meta: {
      sessionKey: session.sessionKey,
      source: session.source,
      turnCount: session.turns.length,
      summarizedTurns: meta.includedTurns,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      cwd: session.cwd,
      model: meta.model,
      contentHash: meta.hash,
    },
  };
}

/**
 * Summarize each finished session into a single node.
 *
 * This is the one collector that costs real compute, so three things bound
 * it: only settled sessions are eligible, a session whose prompt hashes to
 * what is already stored is skipped entirely, and no more than
 * `maxSessions` reach the model in one sync. The rest wait for the next run.
 */
export async function collectSessionSummaries(
  turns: readonly RawConversationTurn[],
  projectId: string,
  provider: SummarizationProvider,
  opts: SessionCollectorOptions = {},
): Promise<SessionCollectorResult> {
  const maxBodyChars = opts.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;

  const all = groupTurnsIntoSessions(turns);
  const settled = selectSettledSessions(all, opts.settleMinutes ?? DEFAULT_SETTLE_MINUTES, opts.now);

  const nodes: MemoryNode[] = [];
  let cached = 0;
  let failed = 0;
  let attempted = 0;

  // Newest first: if the cap bites, the sessions a developer is most likely
  // to ask about are the ones that got summarized.
  const candidates = [...settled].sort((a, b) => b.endedAt.localeCompare(a.endedAt));
  const pending: Array<{ session: SessionGroup; prompt: ReturnType<typeof buildSessionPrompt> }> = [];

  for (const session of candidates) {
    const prompt = buildSessionPrompt(session, opts.maxPromptChars);
    if (opts.knownHash?.(session.sessionKey) === prompt.hash) {
      cached += 1;
      continue;
    }
    pending.push({ session, prompt });
  }

  for (const { session, prompt } of pending.slice(0, maxSessions)) {
    const raw = await provider.complete(prompt.prompt);
    attempted += 1;

    const summary = raw === null ? null : parseSummary(raw, sessionFallbackTitle(session));
    if (!summary) {
      failed += 1;
      // Nothing was stored, so the hash was never recorded and the next sync
      // retries this session -- a model that was merely busy gets another go.
      continue;
    }

    nodes.push(
      toNode(
        session,
        projectId,
        summary,
        { hash: prompt.hash, model: provider.identity, includedTurns: prompt.includedTurns },
        maxBodyChars,
      ),
    );
    opts.onProgress?.(nodes.length, Math.min(pending.length, maxSessions));
  }

  return {
    nodes,
    cached,
    unsettled: all.length - settled.length,
    deferred: Math.max(0, pending.length - maxSessions),
    failed,
    providerUnavailable: attempted > 0 && nodes.length === 0,
  };
}
