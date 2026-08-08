import { sha256Hex } from '../core/ids.js';
import type { RawShellEntry } from './types.js';
import type { ScrapeOptions } from './parse-psreadline.js';

/** A `#<epoch>` comment line precedes the command when `HISTTIMEFORMAT` is set. */
const EPOCH_COMMENT = /^#(\d{9,10})$/;

/**
 * Parse `.bash_history`.
 *
 * Real timestamps are used when present (`HISTTIMEFORMAT` is set); otherwise
 * falls back to the same backward-from-mtime approximation as PSReadLine.
 */
export function parseBashHistory(raw: string, mtimeMs: number, opts: ScrapeOptions = {}): RawShellEntry[] {
  const lines = raw.split(/\r?\n/);

  const prelim: Array<{ command: string; ts: string | null }> = [];
  let pendingEpoch: number | null = null;

  for (const line of lines) {
    if (line.trim().length === 0) continue;

    const m = EPOCH_COMMENT.exec(line.trim());
    if (m) {
      pendingEpoch = Number(m[1]);
      continue;
    }

    prelim.push({ command: line, ts: pendingEpoch !== null ? new Date(pendingEpoch * 1000).toISOString() : null });
    pendingEpoch = null;
  }

  const tail = opts.tailLines ? prelim.slice(-opts.tailLines) : prelim;
  const startIndex = prelim.length - tail.length;

  return tail.map((p, i) => {
    const fromEnd = tail.length - 1 - i;
    const approx = p.ts === null;
    return {
      naturalKey: `bash:${startIndex + i}:${sha256Hex(p.command).slice(0, 12)}`,
      command: p.command,
      ts: p.ts ?? new Date(mtimeMs - fromEnd * 1000).toISOString(),
      tsApprox: approx,
      exitCode: null,
      cwd: null,
      durationMs: null,
      shell: 'bash',
    };
  });
}
