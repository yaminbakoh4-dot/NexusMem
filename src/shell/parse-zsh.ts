import { sha256Hex } from '../core/ids.js';
import type { RawShellEntry } from './types.js';
import type { ScrapeOptions } from './parse-psreadline.js';

/** `EXTENDED_HISTORY` format: `: <epoch>:<duration>;<command>`. */
const EXTENDED_PREFIX = /^: (\d+):(\d+);(.*)$/;

/**
 * Parse `.zsh_history`.
 *
 * Handles the (very common, oh-my-zsh-default) extended-history format with
 * real epoch timestamps, and its backslash-continuation convention for
 * commands typed across multiple physical lines. Falls back to the same
 * backward-from-mtime approximation as PSReadLine when extended history is
 * off.
 */
export function parseZshHistory(raw: string, mtimeMs: number, opts: ScrapeOptions = {}): RawShellEntry[] {
  const rawLines = raw.split(/\r?\n/);
  const prelim: Array<{ command: string; ts: string | null; durationMs: number | null }> = [];

  let i = 0;
  while (i < rawLines.length) {
    const line = rawLines[i] ?? '';
    if (line.trim().length === 0) {
      i += 1;
      continue;
    }

    const m = EXTENDED_PREFIX.exec(line);
    let epoch: number | null = null;
    let duration: number | null = null;
    let cmd: string;

    if (m) {
      epoch = Number(m[1]);
      duration = Number(m[2]);
      cmd = m[3] ?? '';
    } else {
      cmd = line;
    }

    // A trailing backslash means the command continues on the next physical line.
    while (cmd.endsWith('\\') && i + 1 < rawLines.length) {
      i += 1;
      cmd = `${cmd.slice(0, -1)}\n${rawLines[i]}`;
    }

    prelim.push({ command: cmd, ts: epoch !== null ? new Date(epoch * 1000).toISOString() : null, durationMs: duration });
    i += 1;
  }

  const tail = opts.tailLines ? prelim.slice(-opts.tailLines) : prelim;
  const startIndex = prelim.length - tail.length;

  return tail.map((p, idx) => {
    const fromEnd = tail.length - 1 - idx;
    const approx = p.ts === null;
    return {
      naturalKey: `zsh:${startIndex + idx}:${sha256Hex(p.command).slice(0, 12)}`,
      command: p.command,
      ts: p.ts ?? new Date(mtimeMs - fromEnd * 1000).toISOString(),
      tsApprox: approx,
      exitCode: null,
      cwd: null,
      durationMs: p.durationMs,
      shell: 'zsh',
    };
  });
}
