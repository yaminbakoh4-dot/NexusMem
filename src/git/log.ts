import { GitError, gitStream } from './exec.js';
import { GIT_LOG_FORMAT, parseCommitRecord, splitRecords, type RawCommit } from './parse.js';

export interface ReadCommitsOptions {
  /** Revision to walk back from. Default `HEAD`. */
  rev?: string;
  /** Exclusive lower bound -- walks `<afterCommit>..<rev>`. Used for incremental sync. */
  afterCommit?: string | null;
  /** Any git date expression, e.g. `90.days.ago` or `2025-01-01`. */
  since?: string | null;
  maxCount?: number | null;
  /** Merge commits carry PR titles, so they are kept by default. */
  includeMerges?: boolean;
  /** Restrict to pathspecs. */
  paths?: string[];
}

/** Errors that just mean "there is nothing to read", not "something broke". */
const EMPTY_HISTORY = /does not have any commits yet|unknown revision|bad revision|ambiguous argument/i;

export function buildLogArgs(opts: ReadCommitsOptions = {}): string[] {
  const { rev = 'HEAD', afterCommit, since, maxCount, includeMerges = true, paths } = opts;

  const args = ['log', `--format=${GIT_LOG_FORMAT}`, '--numstat', '--no-color'];

  if (!includeMerges) args.push('--no-merges');
  if (maxCount && maxCount > 0) args.push(`--max-count=${maxCount}`);
  if (since) args.push(`--since=${since}`);

  args.push(afterCommit ? `${afterCommit}..${rev}` : rev);

  if (paths?.length) args.push('--', ...paths);

  return args;
}

/**
 * Walk commit history, yielding one parsed commit at a time.
 *
 * The generator is lazy: breaking out of the loop kills the underlying `git`
 * process, so `--limit`-style callers never pay for the full history.
 */
export async function* readCommits(cwd: string, opts: ReadCommitsOptions = {}): AsyncGenerator<RawCommit> {
  const args = buildLogArgs(opts);
  let buffer = '';

  try {
    for await (const chunk of gitStream(cwd, args)) {
      buffer += chunk;
      const { records, rest } = splitRecords(buffer);
      buffer = rest;
      for (const record of records) {
        const commit = parseCommitRecord(record);
        if (commit) yield commit;
      }
    }
  } catch (err) {
    if (err instanceof GitError && EMPTY_HISTORY.test(err.stderr)) return;
    throw err;
  }

  for (const record of splitRecords(buffer, true).records) {
    const commit = parseCommitRecord(record);
    if (commit) yield commit;
  }
}
