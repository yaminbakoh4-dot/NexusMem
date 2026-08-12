import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { listTranscriptFiles } from './paths.js';
import type { RawConversationTurn } from './types.js';

/**
 * Parses Claude Code's local session transcript format.
 *
 * This format is internal and undocumented -- it is not a published API,
 * just what was observed on disk at `~/.claude/projects/<slug>/*.jsonl`
 * (one JSON object per line; `type: 'user' | 'assistant' | ...` records
 * threaded by `parentUuid`/`uuid`, message content shaped like the
 * Anthropic Messages API). Treat every assumption here as liable to break
 * on a Claude Code update: parse defensively, skip what doesn't match
 * rather than throw, and never let a shape change break `sync` for
 * git/shell.
 */

interface ContentBlock {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

interface TranscriptLine {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  timestamp?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
}

function parseLine(raw: string): TranscriptLine | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as TranscriptLine;
  } catch {
    return null; // a torn write or a record shape we don't recognise -- skip, don't fail sync
  }
}

/** A real human message, not a tool-result being fed back into the model. */
function extractUserText(line: TranscriptLine): string | null {
  const content = line.message?.content;
  if (typeof content === 'string') return content.trim() || null;

  if (Array.isArray(content)) {
    if (content.some((b) => b.type === 'tool_result')) return null;
    const text = content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return text || null;
  }

  return null;
}

/** The assistant's prose reply. Tool calls and internal `thinking` are deliberately excluded. */
function extractAssistantText(line: TranscriptLine): string {
  const content = line.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

export interface ParseTranscriptOptions {
  source?: string;
  /**
   * Identifies the session these lines came from. Claude Code names each
   * transcript file after its session id, so the caller passes the file's
   * basename; nothing inside the records is relied on for this.
   */
  sessionId?: string;
}

/**
 * Group a transcript into exchanges: one real human message plus every bit
 * of assistant prose that follows it, up to the next human message.
 *
 * Tool calls in between are not part of the exchange's *text* -- they are
 * execution detail, already captured with far more structure by the git and
 * shell collectors when they matter. Sidechain records (sub-agent work
 * spawned via a Task-like tool) are excluded; they are not the primary
 * human/assistant dialogue this collector is after.
 */
export function parseClaudeCodeTranscript(raw: string, opts: ParseTranscriptOptions = {}): RawConversationTurn[] {
  const source = opts.source ?? 'claude-code';
  const sessionKey = `${source}:${opts.sessionId ?? 'unknown'}`;
  const turns: RawConversationTurn[] = [];

  let current: { uuid: string; userText: string; ts: string; cwd: string | null; assistantParts: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const assistantText = current.assistantParts.join('\n\n').trim();
    turns.push({
      naturalKey: `claude-code:${current.uuid}`,
      userText: current.userText,
      assistantText,
      ts: current.ts,
      cwd: current.cwd,
      source,
      sessionKey,
    });
    current = null;
  };

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = parseLine(rawLine);
    if (!line || line.isSidechain) continue;

    if (line.type === 'user') {
      const userText = extractUserText(line);
      if (userText === null) continue; // a tool-result record, not a human message

      flush();
      current = {
        uuid: line.uuid ?? `noid-${turns.length}`,
        userText,
        ts: line.timestamp ?? new Date(0).toISOString(),
        cwd: line.cwd ?? null,
        assistantParts: [],
      };
      continue;
    }

    if (line.type === 'assistant' && current) {
      const text = extractAssistantText(line);
      if (text) current.assistantParts.push(text);
    }
  }

  flush();
  return turns;
}

/**
 * Read every transcript recorded for this repo and parse them all.
 *
 * Re-reads full files rather than tracking a per-file cursor: exchange
 * grouping needs to see a user turn's eventual assistant reply to close it
 * out, and a naive line-offset cursor can't guarantee it lands between two
 * exchanges rather than inside one. Content-addressed ids (the source's own
 * `uuid`) make re-processing a no-op cost at the store layer, same trade
 * the shell scrape fallback makes -- simpler and always correct beats
 * incremental and occasionally wrong.
 */
export async function collectClaudeCodeTranscripts(repoRoot: string): Promise<RawConversationTurn[]> {
  const files = await listTranscriptFiles(repoRoot);
  const turns: RawConversationTurn[] = [];

  for (const file of files) {
    const raw = await readFile(file, 'utf8');
    turns.push(...parseClaudeCodeTranscript(raw, { sessionId: basename(file, '.jsonl') }));
  }

  return turns;
}
