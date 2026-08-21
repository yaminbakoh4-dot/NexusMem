import { truncate } from '../core/text.js';

export interface ContradictionCandidate {
  title: string;
  body: string;
}

const MAX_BODY_CHARS = 1500;
const MAX_REASON_CHARS = 200;

/**
 * Exported so a test can size a prompt budget against it without hard-coding
 * a length -- same convention as `slm/summarize.ts`'s `SESSION_INSTRUCTIONS`.
 */
export const CONTRADICTION_INSTRUCTIONS = `You are checking whether a NEWER memory replaces or contradicts an OLDER one, for an AI coding assistant's memory index.

Answer in exactly this shape:
VERDICT: YES or NO
REASON: <one line, under 20 words>

Say YES only if the NEWER memory states something that makes the OLDER one factually wrong or obsolete -- a decision reversed, a bug fixed, a plan abandoned. Say NO if they are about different things, or the newer one only adds detail without contradicting the older one. When unsure, say NO.`;

/**
 * Build the prompt for one older/newer pair. Bodies are truncated, not the
 * titles -- a title is already short and is what the model needs most to
 * tell two same-topic memories apart.
 */
export function buildContradictionPrompt(older: ContradictionCandidate, newer: ContradictionCandidate): string {
  const body = [
    `OLDER (${older.title}):`,
    truncate(older.body, MAX_BODY_CHARS),
    '',
    `NEWER (${newer.title}):`,
    truncate(newer.body, MAX_BODY_CHARS),
  ].join('\n');

  return `${CONTRADICTION_INSTRUCTIONS}\n\n---\n\n${body}\n\n---\n\nAnswer:`;
}

export interface ContradictionVerdict {
  contradicts: boolean;
  reason: string;
}

/**
 * Parse the model's reply. Anything that doesn't contain a recognisable
 * `VERDICT: YES|NO` line returns null -- treated as "no suggestion", never
 * guessed as a YES. A missed contradiction costs nothing (the node still
 * shows up in the plain heuristic `stale` list); a wrongly-claimed one would
 * print a false accusation next to a real memory, which is the more
 * expensive mistake here.
 */
export function parseContradictionVerdict(raw: string): ContradictionVerdict | null {
  const lines = raw
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const verdictLine = lines.find((l) => /^VERDICT:/i.test(l));
  if (!verdictLine) return null;

  const verdict = /^VERDICT:\s*(YES|NO)\b/i.exec(verdictLine);
  if (!verdict) return null;

  const reasonLine = lines.find((l) => /^REASON:/i.test(l));
  const reason = reasonLine ? reasonLine.replace(/^REASON:\s*/i, '').trim() : '';

  return {
    contradicts: verdict[1]!.toUpperCase() === 'YES',
    reason: truncate(reason, MAX_REASON_CHARS),
  };
}
