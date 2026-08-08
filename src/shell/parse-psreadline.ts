import { sha256Hex } from '../core/ids.js';
import type { RawShellEntry } from './types.js';

export interface ScrapeOptions {
  /** Keep only the last N lines. Unbounded by default. */
  tailLines?: number;
}

/**
 * Parse PowerShell's `ConsoleHost_history.txt`.
 *
 * One command per line, no metadata at all -- not a timestamp, not an exit
 * code, not a cwd. Multi-line entries (a function typed at the prompt) are
 * not reconstructed; each physical line is treated as its own command. Good
 * enough for the common one-liner case, which is nearly all shell history.
 */
export function parsePsReadLineHistory(raw: string, mtimeMs: number, opts: ScrapeOptions = {}): RawShellEntry[] {
  const allLines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const tail = opts.tailLines ? allLines.slice(-opts.tailLines) : allLines;
  const startIndex = allLines.length - tail.length;

  return tail.map((command, i) => {
    // No per-line timestamp exists, so space entries backward from the
    // file's mtime, one synthetic second apart -- preserves order and keeps
    // recency ranking roughly sane without ever being presented as exact.
    const fromEnd = tail.length - 1 - i;
    return {
      naturalKey: `pwsh:${startIndex + i}:${sha256Hex(command).slice(0, 12)}`,
      command,
      ts: new Date(mtimeMs - fromEnd * 1000).toISOString(),
      tsApprox: true,
      exitCode: null,
      cwd: null,
      durationMs: null,
      shell: 'pwsh',
    };
  });
}
