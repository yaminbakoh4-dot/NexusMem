import { resolve } from 'node:path';
import { git, gitOrNull, GitError } from './exec.js';

export class NotAGitRepositoryError extends Error {
  constructor(readonly cwd: string) {
    super(`Not a git repository: ${cwd}`);
    this.name = 'NotAGitRepositoryError';
  }
}

/**
 * git's own wording when the path simply isn't inside a work tree, e.g.
 * `fatal: not a git repository (or any of the parent directories): .git`.
 *
 * Matching on it is what keeps this error meaning exactly one thing. Every
 * other non-zero exit from `rev-parse` -- dubious ownership, a corrupt object
 * store, an unreadable config -- is a different problem with a different fix,
 * and is now surfaced with git's own message instead of being relabelled.
 */
const NOT_A_REPO = /not a git repository/i;

export interface RepoInfo {
  /** Absolute, platform-native path to the work tree root. */
  root: string;
  /** `null` on a detached HEAD. */
  branch: string | null;
  /** `null` in a repo with no commits yet. */
  head: string | null;
  originUrl: string | null;
}

/**
 * Whether `ancestor` is reachable from `descendant`.
 *
 * Used to validate a stored sync cursor: after a rebase, amend or branch
 * switch the old HEAD may no longer be in history, and `cursor..HEAD` would
 * then silently skip commits. Falling back to a full resync is the safe move.
 */
export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (err) {
    if (err instanceof GitError) return false;
    throw err;
  }
}

export async function readRepoInfo(cwd: string): Promise<RepoInfo> {
  let rootRaw: string;
  try {
    rootRaw = await git(cwd, ['rev-parse', '--show-toplevel']);
  } catch (err) {
    if (err instanceof GitError && NOT_A_REPO.test(err.stderr)) {
      throw new NotAGitRepositoryError(cwd);
    }
    // Anything else -- a `GitSpawnError` (git missing, or a transient Windows
    // spawn failure), or git failing for some reason of its own -- keeps its
    // own type and message. Reporting those as "not a git repository" sent
    // the reader to inspect a repository that was never the problem.
    throw err;
  }

  // git always prints forward slashes; resolve() gives us a native path back.
  const root = resolve(rootRaw.trim());

  const [branchRaw, headRaw, originRaw] = await Promise.all([
    gitOrNull(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    gitOrNull(root, ['rev-parse', 'HEAD']),
    gitOrNull(root, ['remote', 'get-url', 'origin']),
  ]);

  const branch = branchRaw?.trim() ?? null;

  return {
    root,
    branch: branch && branch !== 'HEAD' ? branch : null,
    head: headRaw?.trim() || null,
    originUrl: originRaw?.trim() || null,
  };
}
