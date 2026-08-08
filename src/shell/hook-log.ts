import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * One line of the opt-in hook log: a JSONL file the installed shell hook
 * appends to on every command. This is the high-quality tier -- exact
 * timestamp, cwd and exit code, none of which the scrape-based fallbacks can
 * offer.
 */
export interface HookLogEntry {
  ts: string;
  cwd: string;
  exitCode: number | null;
  durationMs: number | null;
  command: string;
}

/** A malformed line (typically a torn write from a crash mid-append) is skipped, not fatal. */
export function parseHookLogLine(line: string): HookLogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;

  const o = obj as Record<string, unknown>;
  if (typeof o.ts !== 'string' || typeof o.cwd !== 'string' || typeof o.command !== 'string') return null;

  return {
    ts: o.ts,
    cwd: o.cwd,
    exitCode: typeof o.exitCode === 'number' ? o.exitCode : null,
    durationMs: typeof o.durationMs === 'number' ? o.durationMs : null,
    command: o.command,
  };
}

export interface ReadHookLogResult {
  entries: HookLogEntry[];
  /** Total lines currently in the file -- the caller's next cursor. */
  totalLines: number;
}

/**
 * Read lines appended since `fromLine`.
 *
 * `fromLine` beyond the file's current length means the file was rotated or
 * cleared out from under a stale cursor -- treated the same way a stale git
 * cursor is: fall back to reading everything, rather than silently skipping
 * history that is actually new.
 */
export async function readHookLog(path: string, fromLine: number): Promise<ReadHookLogResult> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { entries: [], totalLines: fromLine };
  }

  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  const slice = fromLine > 0 && fromLine <= lines.length ? lines.slice(fromLine) : lines;
  const entries = slice.map(parseHookLogLine).filter((e): e is HookLogEntry => e !== null);

  return { entries, totalLines: lines.length };
}

/** Append one entry. Exposed for tests; the real writer is the installed PowerShell hook. */
export async function appendHookLogEntry(path: string, entry: HookLogEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
}
