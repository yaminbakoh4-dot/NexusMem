import { makeNodeId } from '../core/ids.js';
import { truncate } from '../core/text.js';
import type { FileTouch, MemoryNode } from '../core/types.js';
import { redact } from '../conversation/redact.js';
import type { RawConversationTurn } from '../conversation/types.js';

export interface ConversationCollectorOptions {
  /** Default 3000 -- exchanges run longer than a commit message but still need a cap. */
  maxBodyChars?: number;
}

const DEFAULT_MAX_BODY_CHARS = 3000;
const MAX_TITLE_CHARS = 200;
const MAX_FILES_PER_NODE = 20;

const EXPLANATION_MARKERS =
  /\b(because|the reason|design decision|trade-?off|instead of|rationale|so that)\b|เพราะ|ทำไม|เหตุผล/i;
const TRIVIAL_ACK = /^(ok|okay|thanks?|ขอบคุณ|ครับ|ค่ะ|got it|sounds good|👍|done)\.?!?$/i;

/**
 * Prior importance of a conversation exchange.
 *
 * A much noisier signal than a commit type, so scores stay closer to the
 * middle. The intuition mirrors `scoreCommit`: an exchange that explains a
 * *why* is worth far more to a future query than one that just confirms
 * something happened.
 */
export function scoreConversationTurn(turn: RawConversationTurn): number {
  const text = `${turn.userText}\n${turn.assistantText}`;
  let score = 0.3;

  if (EXPLANATION_MARKERS.test(text)) score += 0.25;
  if (turn.assistantText.length > 600) score += 0.15;
  else if (turn.assistantText.length < 80) score -= 0.1;

  if (TRIVIAL_ACK.test(turn.userText.trim())) score -= 0.2;
  if (turn.userText.trim().endsWith('?')) score += 0.05;

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

export function toMemoryNode(
  turn: RawConversationTurn,
  projectId: string,
  opts: ConversationCollectorOptions = {},
): MemoryNode {
  const maxBody = opts.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;

  const userRedacted = redact(turn.userText);
  const assistantRedacted = redact(turn.assistantText);

  const body = [`Q: ${userRedacted.text}`, '', `A: ${assistantRedacted.text}`].join('\n');

  return {
    id: makeNodeId(projectId, 'conversation_turn', turn.naturalKey),
    kind: 'conversation_turn',
    projectId,
    ts: turn.ts,
    source: `conversation:${turn.source}`,
    title: truncate(userRedacted.text.split(/\r?\n/)[0] ?? userRedacted.text, MAX_TITLE_CHARS),
    body: truncate(body, maxBody),
    files: extractMentionedFiles(`${userRedacted.text}\n${assistantRedacted.text}`),
    signal: scoreConversationTurn(turn),
    meta: {
      cwd: turn.cwd,
      source: turn.source,
      redactedCount: userRedacted.redactedCount + assistantRedacted.redactedCount,
    },
  };
}

export function collectConversationTurns(
  turns: readonly RawConversationTurn[],
  projectId: string,
  opts: ConversationCollectorOptions = {},
): MemoryNode[] {
  return turns.filter((t) => t.assistantText.length > 0).map((turn) => toMemoryNode(turn, projectId, opts));
}
