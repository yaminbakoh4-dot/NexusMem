import { makeNodeId } from '../core/ids.js';
import { truncate } from '../core/text.js';
import type { FileTouch, MemoryNode } from '../core/types.js';
import { chunkAssistantText } from '../conversation/chunk.js';
import { redact } from '../conversation/redact.js';
import type { RawConversationTurn } from '../conversation/types.js';

export interface ConversationCollectorOptions {
  /** Default 2500 -- final safety cap on one chunk's assembled Q+A body. */
  maxBodyChars?: number;
  /**
   * Default 900 -- target size for one assistant-reply chunk before it's
   * closed out and a new node started. Small enough that a single
   * explanatory point stays retrievable on its own, not buried inside
   * several unrelated ones in the same long reply.
   */
  maxChunkChars?: number;
}

const DEFAULT_MAX_BODY_CHARS = 2500;
const DEFAULT_MAX_CHUNK_CHARS = 900;
const MAX_TITLE_CHARS = 200;
const MAX_FILES_PER_NODE = 20;

const EXPLANATION_MARKERS =
  /\b(because|the reason|design decision|trade-?off|instead of|rationale|so that)\b/i;
const TRIVIAL_ACK = /^(ok|okay|thanks?|got it|sounds good|👍|done)\.?!?$/i;

/**
 * Prior importance of one chunk of a conversation exchange.
 *
 * Scored per chunk, not per whole exchange -- a genuinely explanatory point
 * should outrank a routine one even when they came from the same reply.
 * A much noisier signal than a commit type, so scores stay closer to the
 * middle. The intuition mirrors `scoreCommit`: text that explains a *why*
 * is worth far more to a future query than text that just confirms
 * something happened.
 */
export function scoreConversationTurn(userText: string, replyText: string): number {
  const text = `${userText}\n${replyText}`;
  let score = 0.3;

  if (EXPLANATION_MARKERS.test(text)) score += 0.25;
  if (replyText.length > 400) score += 0.15;
  else if (replyText.length < 80) score -= 0.1;

  if (TRIVIAL_ACK.test(userText.trim())) score -= 0.2;
  if (userText.trim().endsWith('?')) score += 0.05;

  return Number(Math.min(1, Math.max(0.05, score)).toFixed(3));
}

const FILE_PATH = /\b(?:[\w.-]+\/)*[\w-]+\.(?:ts|tsx|js|jsx|json|md|py|rs|go|java|c|cpp|h|hpp|css|html|ya?ml|toml|sql|sh|ps1)\b/g;

/**
 * Heuristic file-mention extraction, not a parsed diff -- lets a
 * conversation node join the `node_files` path index like git/shell nodes
 * do, so "why is this file the way it is" can be answered from either
 * direction. False positives (a path-shaped word in prose) are possible and
 * acceptable for a best-effort cross-reference.
 */
function extractMentionedFiles(text: string): FileTouch[] {
  const seen = new Set<string>();
  const files: FileTouch[] = [];

  for (const match of text.matchAll(FILE_PATH)) {
    const path = match[0];
    if (seen.has(path)) continue;
    seen.add(path);
    files.push({ path, insertions: null, deletions: null, binary: false });
    if (files.length >= MAX_FILES_PER_NODE) break;
  }

  return files;
}

/**
 * Truncating `${userFirstLine}${suffix}` as one string would silently drop
 * the suffix whenever the question alone already reached MAX_TITLE_CHARS --
 * exactly the case for a long original question, which is also exactly the
 * case where a reply is most likely to have been split into many chunks
 * that then all render with one indistinguishable title. Truncate the
 * question first, leaving guaranteed room for whatever comes after it.
 */
function withSuffix(base: string, suffix: string): string {
  const budget = Math.max(20, MAX_TITLE_CHARS - suffix.length);
  return `${truncate(base, budget)}${suffix}`;
}

function chunkTitle(userFirstLine: string, heading: string | null, index: number, count: number): string {
  if (heading) return withSuffix(userFirstLine, ` — ${heading}`);
  if (count > 1) return withSuffix(userFirstLine, ` (part ${index + 1}/${count})`);
  return truncate(userFirstLine, MAX_TITLE_CHARS);
}

/**
 * One exchange becomes one node per chunk of its assistant reply (see
 * `chunkAssistantText`), each pairing the *original* question with just
 * that chunk -- so every node is independently self-contained and
 * searchable, not dependent on a sibling node for context. Short exchanges
 * (the common case) produce exactly one chunk, unchanged from before.
 */
export function toMemoryNodes(
  turn: RawConversationTurn,
  projectId: string,
  opts: ConversationCollectorOptions = {},
): MemoryNode[] {
  const maxBody = opts.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  const maxChunk = opts.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;

  const userRedacted = redact(turn.userText);
  const userFirstLine = userRedacted.text.split(/\r?\n/)[0] ?? userRedacted.text;

  const assistantRedacted = redact(turn.assistantText);
  const chunks = chunkAssistantText(assistantRedacted.text, maxChunk);
  // Redaction found something but chunking produced nothing to attach it to
  // (a reply that was pure whitespace after redaction) -- shouldn't happen
  // since callers filter out empty assistantText first, but stay defensive.
  if (chunks.length === 0) return [];

  return chunks.map((chunk, index) => {
    const body = [`Q: ${userRedacted.text}`, '', `A: ${chunk.text}`].join('\n');

    return {
      id: makeNodeId(projectId, 'conversation_turn', `${turn.naturalKey}:${index}`),
      kind: 'conversation_turn',
      projectId,
      ts: turn.ts,
      source: `conversation:${turn.source}`,
      title: chunkTitle(userFirstLine, chunk.heading, index, chunks.length),
      body: truncate(body, maxBody),
      files: extractMentionedFiles(`${userRedacted.text}\n${chunk.text}`),
      signal: scoreConversationTurn(userRedacted.text, chunk.text),
      meta: {
        cwd: turn.cwd,
        source: turn.source,
        chunkIndex: index,
        chunkCount: chunks.length,
        heading: chunk.heading,
        // Redaction runs once over the whole reply before chunking (so a
        // secret can never straddle a chunk boundary and slip through) --
        // this is the turn's total, repeated on every chunk it produced,
        // not a per-chunk count.
        redactedCount: userRedacted.redactedCount + assistantRedacted.redactedCount,
      },
    };
  });
}

export function collectConversationTurns(
  turns: readonly RawConversationTurn[],
  projectId: string,
  opts: ConversationCollectorOptions = {},
): MemoryNode[] {
  return turns.filter((t) => t.assistantText.length > 0).flatMap((turn) => toMemoryNodes(turn, projectId, opts));
}
