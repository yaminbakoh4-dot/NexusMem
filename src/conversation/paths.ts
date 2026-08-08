import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Claude Code's own slugging rule for a project path, reverse-engineered
 * from what is actually on disk (undocumented -- see claude-code-reader.ts).
 * `D:\ai-projects\NexusMem` -> `D--ai-projects-NexusMem`: every path
 * separator and drive-letter colon becomes `-`; everything else, including
 * hyphens already in folder names, passes through untouched.
 */
export function claudeProjectSlug(repoRoot: string): string {
  return repoRoot.replace(/[\\/:]/g, '-');
}

export function claudeProjectTranscriptDir(repoRoot: string): string {
  return join(homedir(), '.claude', 'projects', claudeProjectSlug(repoRoot));
}

/** Every session transcript recorded for this repo, oldest-looking name first is not guaranteed -- callers should sort if order matters. */
export async function listTranscriptFiles(repoRoot: string): Promise<string[]> {
  const dir = claudeProjectTranscriptDir(repoRoot);
  if (!existsSync(dir)) return [];

  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => join(dir, e.name));
}
