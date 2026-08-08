import { approxTokens, truncate } from '../core/text.js';
import type { RankedHit } from './rank.js';

export interface PackedNode {
  id: string;
  kind: string;
  ts: string;
  title: string;
  signal: number;
  score: number;
  summary: string;
  tokens: number;
}

export interface PackResult {
  nodes: PackedNode[];
  tokensUsed: number;
  tokensBudget: number;
  consideredNodes: number;
  droppedForBudget: number;
}

const DEFAULT_SUMMARY_CHARS = 320;
/** Formatting overhead per node (date prefix, bullet, line breaks) counted as tokens. */
const NODE_OVERHEAD_TOKENS = 8;

const CONVERSATION_ANSWER_MARKER = '\n\nA: ';

function summarize(hit: RankedHit, maxChars: number): string {
  // Conversation nodes always shape their body as "Q: <question>\n\nA:
  // <answer>" (collectors/conversation.ts repeats the full original question
  // in every chunk so each node is self-contained). The answer is the part
  // worth showing -- truncating from the start of the body would otherwise
  // spend the whole summary on a long question and never reach it.
  const answerIdx = hit.body.indexOf(CONVERSATION_ANSWER_MARKER);
  if (answerIdx !== -1) {
    const answer = hit.body.slice(answerIdx + CONVERSATION_ANSWER_MARKER.length).trim();
    if (answer) return truncate(answer, maxChars);
  }

  // Body already leads with the title; skip straight to whatever follows it
  // so the summary doesn't repeat text that's already shown as the heading.
  const rest = hit.body.startsWith(hit.title) ? hit.body.slice(hit.title.length).trim() : hit.body;
  return truncate(rest || hit.title, maxChars);
}

/**
 * Greedily fill a token budget with the highest-scoring hits.
 *
 * Nodes are tried strictly in score order. One that doesn't fit is skipped,
 * not a stopping point -- a later, smaller, lower-priority node may still
 * fit the remaining budget. This is best-effort packing, not knapsack-
 * optimal, but it keeps "why is node X included" answerable by score alone.
 */
export function packContext(
  ranked: readonly RankedHit[],
  tokensBudget: number,
  opts: { summaryChars?: number } = {},
): PackResult {
  const summaryChars = opts.summaryChars ?? DEFAULT_SUMMARY_CHARS;
  const nodes: PackedNode[] = [];
  let tokensUsed = 0;
  let droppedForBudget = 0;

  for (const hit of ranked) {
    const summary = summarize(hit, summaryChars);
    const tokens = approxTokens(hit.title) + approxTokens(summary) + NODE_OVERHEAD_TOKENS;

    if (tokensUsed + tokens > tokensBudget) {
      droppedForBudget += 1;
      continue;
    }

    nodes.push({
      id: hit.id,
      kind: hit.kind,
      ts: hit.ts,
      title: hit.title,
      signal: hit.signal,
      score: hit.score,
      summary,
      tokens,
    });
    tokensUsed += tokens;
  }

  return { nodes, tokensUsed, tokensBudget, consideredNodes: ranked.length, droppedForBudget };
}

/** Render a packed result as plain text, ready to paste into an agent's context. */
export function renderContextBlock(query: string, result: PackResult): string {
  if (result.nodes.length === 0) return `No remembered context matched "${query}".`;

  const lines = [`Relevant history for: ${query}`, ''];
  for (const node of result.nodes) {
    lines.push(`- ${node.ts.slice(0, 10)} ${node.title}`);
    if (node.summary && node.summary !== node.title) {
      lines.push(`  ${node.summary.replace(/\n+/g, ' ')}`);
    }
  }
  return lines.join('\n');
}
