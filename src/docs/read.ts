import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from '../git/exec.js';
import type { RawDocFile } from './types.js';

/**
 * `.md` pathspecs to index by default.
 *
 * A bare `*.md` is not anchored to the repo root -- git's default (non-glob)
 * pathspec matching runs per path component, so it already reaches
 * `docs/phase-2-spec.md` as well as the top-level `README.md` (confirmed
 * against this repo). One pattern covers both.
 */
const DEFAULT_PATHSPECS = ['*.md'];

export interface ListDocFilesOptions {
  include?: string[];
}

/**
 * Tracked-only by design: `git ls-files` already excludes `node_modules`,
 * `.git` and the self-ignoring `.nexusmem/` workspace (see
 * config/workspace.ts) for free, the same way the git collector gets commit
 * history without hand-rolled ignore logic.
 */
export async function listDocFiles(repoRoot: string, opts: ListDocFilesOptions = {}): Promise<string[]> {
  const pathspecs = opts.include ?? DEFAULT_PATHSPECS;
  const out = await git(repoRoot, ['ls-files', '--', ...pathspecs]);
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export interface DocScan {
  files: RawDocFile[];
  /**
   * Tracked paths that could not be read this run.
   *
   * Reported rather than silently dropped because "produced no sections" and
   * "was never looked at" mean opposite things to a caller that prunes: nodes
   * from a file in here must be kept, or one unreadable file would wipe every
   * section it had ever contributed.
   */
  unreadable: string[];
}

export async function readDocFiles(repoRoot: string, opts: ListDocFilesOptions = {}): Promise<DocScan> {
  const paths = await listDocFiles(repoRoot, opts);
  const files: RawDocFile[] = [];
  const unreadable: string[] = [];

  for (const relPath of paths) {
    const path = relPath.replace(/\\/g, '/');
    const absPath = join(repoRoot, relPath);
    let content: string;
    let mtime: Date;
    try {
      [content, { mtime }] = await Promise.all([readFile(absPath, 'utf8'), stat(absPath)]);
    } catch {
      // Tracked in git but missing on disk (deleted-but-not-staged, a
      // worktree quirk) -- skip rather than fail the whole sync over it.
      unreadable.push(path);
      continue;
    }

    files.push({ path, content, ts: mtime.toISOString() });
  }

  return { files, unreadable };
}
