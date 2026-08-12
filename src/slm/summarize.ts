import { sha256Hex } from '../core/ids.js';
import { truncate } from '../core/text.js';
import { scoreConversationTurn } from '../collectors/conversation.js';
import { redact } from '../conversation/redact.js';
import type { RawConversationTurn } from '../conversation/types.js';

/** One working session's worth of exchanges, in the order they happened. */
export interface SessionGroup {
  sessionKey: string;
  source: string;
  cwd: string | null;
  turns: RawConversationTurn[];
  startedAt: string;
  endedAt: string;
}

export interface SessionPrompt {
  prompt: string;
  /**
   * Identity of exactly what was sent to the model.
   *
   * Hashing the finished prompt rather than the raw session means a change
   * to the template, the truncation limits, or the turn-selection rule all
   * invalidate the cached summary, and nothing else does. With a
   * temperature-0 model, an unchanged hash provably implies an unchanged
   * summary, which is what makes skipping the work safe rather than merely
   * cheap.
   */
  hash: string;
  /** Turns that actually made it into the prompt, after any budget trimming. */
  includedTurns: number;
}

export const MAX_USER_CHARS = 400;
export const MAX_REPLY_CHARS = 700;
export const DEFAULT_MAX_PROMPT_CHARS = 12_000;

/**
 * Split a flat list of exchanges into sessions, ordered oldest first.
 *
 * Grouping is by the session id the reader recorded, never by time gap: two
 * sessions on the same repository can overlap in wall-clock time, and a long
 * pause inside one session is just lunch, not a boundary.
 */
export function groupTurnsIntoSessions(turns: readonly RawConversationTurn[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();

  for (const turn of turns) {
    const existing = groups.get(turn.sessionKey);
    if (existing) {
      existing.turns.push(turn);
      if (turn.ts < existing.startedAt) existing.startedAt = turn.ts;
      if (turn.ts > existing.endedAt) existing.endedAt = turn.ts;
      existing.cwd ??= turn.cwd;
      continue;
    }

    groups.set(turn.sessionKey, {
      sessionKey: turn.sessionKey,
      source: turn.source,
      cwd: turn.cwd,
      turns: [turn],
      startedAt: turn.ts,
      endedAt: turn.ts,
    });
  }

  for (const group of groups.values()) {
    group.turns.sort((a, b) => a.ts.localeCompare(b.ts));
  }

  return [...groups.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/**
 * Sessions quiet for long enough to be worth summarizing.
 *
 * A session still being typed into would be summarized on one sync and
 * re-summarized on the next, burning a model call each time to produce a
 * summary that was already out of date when it was written. Waiting for the
 * session to settle costs nothing -- the exchanges are already indexed
 * individually by the conversation collector.
 */
export function selectSettledSessions(
  sessions: readonly SessionGroup[],
  settleMinutes: number,
  now: Date = new Date(),
): SessionGroup[] {
  const cutoff = now.getTime() - settleMinutes * 60_000;
  return sessions.filter((s) => {
    const ended = Date.parse(s.endedAt);
    // An unparseable timestamp is treated as settled rather than skipped
    // forever: the alternative silently drops a whole session from memory.
    return Number.isNaN(ended) || ended <= cutoff;
  });
}

/** Exported so a test can size a prompt budget against it without hard-coding a length. */
export const SESSION_INSTRUCTIONS = `You are summarizing one working session between a developer and an AI coding assistant, so that a future assistant can recall what happened without re-reading the transcript.

Your first line MUST begin with "TITLE: " and nothing else. Start your reply with those six characters.

Write your answer in exactly this shape:
TITLE: <under 15 words, naming the specific work, e.g. "Raised the Node floor to 22 after a CI failure">
- <a decision that was made, and why>
- <a problem that was diagnosed, and its cause>
- <what was left unfinished or explicitly deferred>

Rules:
- Answer in English, whatever language the transcript is in. This summary is stored in a keyword index that cannot segment languages without spaces between words.
- The title must name this session specifically. "Summary of the session" or "Project update" are wrong.
- Prefer reasons over narration. "Chose X over Y because Z" is worth more than "worked on X".
- Only state what the transcript supports. Do not guess or invent.
- Between 3 and 6 bullets. No preamble, no closing remarks, no markdown bold.`;

/**
 * Build the prompt for one session.
 *
 * Every exchange is redacted before it reaches the model. The model is local,
 * so this is not about exfiltration -- it is that the model's output is
 * stored and searchable, and a secret quoted into a summary would be indexed
 * in plain text just like any other node body.
 */
export function buildSessionPrompt(session: SessionGroup, maxPromptChars = DEFAULT_MAX_PROMPT_CHARS): SessionPrompt {
  const rendered = session.turns.map((turn) => {
    const user = redact(turn.userText).text;
    const reply = redact(turn.assistantText).text;
    return {
      ts: turn.ts,
      text: [`[${turn.ts}] developer: ${truncate(user, MAX_USER_CHARS)}`, `assistant: ${truncate(reply, MAX_REPLY_CHARS)}`].join(
        '\n',
      ),
      signal: scoreConversationTurn(user, reply),
    };
  });

  // Over budget, keep the highest-signal exchanges and put them back in
  // order. Dropping the tail instead would lose the end of the session,
  // which is where conclusions live; dropping the head would lose the task.
  // Selecting by the same score the conversation collector already uses
  // keeps "what counts as important" defined in exactly one place.
  const budget = maxPromptChars - SESSION_INSTRUCTIONS.length;
  const kept: typeof rendered = [];
  let used = 0;

  for (const turn of [...rendered].sort((a, b) => b.signal - a.signal)) {
    if (used + turn.text.length > budget) continue;
    kept.push(turn);
    used += turn.text.length;
  }
  kept.sort((a, b) => a.ts.localeCompare(b.ts));

  const body = kept.map((t) => t.text).join('\n\n');
  const prompt = `${SESSION_INSTRUCTIONS}\n\n---\n\n${body}\n\n---\n\nSummary:`;

  return { prompt, hash: sha256Hex(prompt), includedTurns: kept.length };
}

export interface ParsedSummary {
  title: string;
  body: string;
}

/**
 * Title to use when the model's own is unusable: the first line of the
 * question that opened the session.
 *
 * The same convention `conversation.ts` uses for a turn's title, and for the
 * same reason -- it is the human's own words, so it is always specific to
 * this session even when it is not elegant.
 */
export function sessionFallbackTitle(session: SessionGroup): string {
  const opening = session.turns[0];
  if (!opening) return 'Working session';
  const line = redact(opening.userText).text.split(/\r?\n/)[0]?.trim();
  return line && line.length > 0 ? line : 'Working session';
}

const MAX_TITLE_CHARS = 200;

/** Titles that name no particular session, and so tell a future reader nothing. */
const GENERIC_TITLE = /^(a |the )?(session |conversation |project |work )?(summary|update|overview|recap|status)\b/i;

/**
 * Strip the decoration a small model adds even when told not to.
 * `**Chose X:**` and `- Chose X` both need to become `Chose X`.
 */
function cleanTitle(line: string): string {
  return line
    .replace(/^[-*#>\s]+/, '')
    .replace(/\*+/g, '')
    .replace(/\s*:\s*$/, '')
    .trim();
}

/**
 * Pull a title and body out of whatever the model returned.
 *
 * The `fallbackTitle` is not a formality -- it is what the title becomes
 * whenever the model's own first line cannot be trusted. Dogfooding a 3B
 * model over 14 real sessions produced nine unusable titles: conversational
 * preambles in the transcript's language, single bullets carried over with
 * their markdown, and a bare "Summary of the Session". An earlier version
 * accepted any first line as a title, which is how all nine reached the
 * index. A summary is still never rejected for bad formatting -- only its
 * title is replaced, and the model's full text is kept as the body.
 */
export function parseSummary(raw: string, fallbackTitle: string): ParsedSummary | null {
  const text = redact(raw).text.trim();
  if (text.length === 0) return null;

  const lines = text.split(/\r?\n/);
  const firstIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstIndex === -1) return null;

  const first = lines[firstIndex]!.trim();
  const labelled = /^TITLE:\s*(.+)$/i.exec(first);
  const fallback = truncate(cleanTitle(fallbackTitle) || 'Working session', MAX_TITLE_CHARS);

  // No TITLE line at all means the model wrote prose from the first
  // character. Its opening line is then an introduction, not a name for the
  // session, so it belongs in the body and nowhere else.
  if (!labelled) return { title: fallback, body: text };

  const candidate = cleanTitle(labelled[1]!);
  const rest = lines
    .slice(firstIndex + 1)
    .join('\n')
    .trim();

  return {
    title: candidate.length > 0 && !GENERIC_TITLE.test(candidate) ? truncate(candidate, MAX_TITLE_CHARS) : fallback,
    // A model that emitted only a title still gets a usable node: the title
    // doubles as the body rather than storing an empty one.
    body: rest.length > 0 ? rest : candidate,
  };
}
