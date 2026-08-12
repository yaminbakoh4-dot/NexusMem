import { makeNodeId } from '../core/ids.js';
import { truncate } from '../core/text.js';
import type { FileTouch, MemoryNode } from '../core/types.js';
import { readCommits, type ReadCommitsOptions } from '../git/log.js';
import type { RawCommit } from '../git/parse.js';

/**
 * Maps raw git commits onto MemoryNodes.
 *
 * This is the only place that knows a commit is a commit -- everything
 * downstream (storage, search, context packing) sees generic nodes.
 */

export interface GitCommitCollectorOptions extends ReadCommitsOptions {
  /** Keep at most this many files per node, biggest churn first. Default 40. */
  maxFilesPerNode?: number;
  /** Hard cap on node body size, to bound index and embedding cost. Default 4000. */
  maxBodyChars?: number;
}

const DEFAULTS = { maxFilesPerNode: 40, maxBodyChars: 4000 } as const;
const MAX_TITLE_CHARS = 200;

export interface ConventionalHeader {
  type: string | null;
  scope: string | null;
  breaking: boolean;
  description: string;
}

const CONVENTIONAL = /^([a-z]+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/i;

export function parseConventionalHeader(subject: string): ConventionalHeader {
  const m = CONVENTIONAL.exec(subject.trim());
  if (!m) return { type: null, scope: null, breaking: false, description: subject.trim() };
  return {
    type: (m[1] ?? '').toLowerCase(),
    scope: m[2] ?? null,
    breaking: Boolean(m[3]),
    description: (m[4] ?? '').trim(),
  };
}

/**
 * Prior importance by commit type.
 *
 * The intuition: when an agent asks "why is this code like this?", a `fix` or
 * `refactor` explains far more than a `chore` or `style`.
 *
 * Exported because the diff collector scores a file's patch from the same
 * commit type. A second copy there would be free to drift, which is exactly
 * how the four `signalColor` copies ended up disagreeing.
 */
export const TYPE_WEIGHTS: Record<string, number> = {
  fix: 0.8,
  feat: 0.8,
  revert: 0.78,
  perf: 0.7,
  refactor: 0.68,
  security: 0.85,
  test: 0.45,
  docs: 0.35,
  build: 0.32,
  ci: 0.28,
  chore: 0.25,
  style: 0.2,
};

const AUTOMATED = /^(merge (branch|pull request|remote)|bump |update dependenc|\[bot\]|revert "merge)/i;

export function scoreCommit(commit: RawCommit): number {
  const header = parseConventionalHeader(commit.subject);

  let score = header.type ? (TYPE_WEIGHTS[header.type] ?? 0.5) : 0.5;

  if (header.breaking) score += 0.12;
  // A commit that bothered to explain *why* is worth more than a bare subject.
  if (commit.messageBody.length > 120) score += 0.1;
  if (commit.isMerge) score = Math.min(score, 0.3);
  if (AUTOMATED.test(commit.subject)) score -= 0.15;

  const churn = commit.files.reduce((n, f) => n + (f.insertions ?? 0) + (f.deletions ?? 0), 0);
  // Very large commits are usually vendoring / generated code, not intent.
  if (commit.files.length > 100 || churn > 5000) score *= 0.75;
  if (commit.files.length <= 1 && churn <= 3) score -= 0.05;

  return Number(Math.min(1, Math.max(0.05, score)).toFixed(3));
}

function byChurnDesc(a: FileTouch, b: FileTouch): number {
  const ca = (a.insertions ?? 0) + (a.deletions ?? 0);
  const cb = (b.insertions ?? 0) + (b.deletions ?? 0);
  return cb - ca;
}

function renderFileLine(f: FileTouch): string {
  const churn = f.binary ? 'binary' : `+${f.insertions ?? 0}/-${f.deletions ?? 0}`;
  return f.previousPath ? `  ${f.path} (${churn}, renamed from ${f.previousPath})` : `  ${f.path} (${churn})`;
}

export function toMemoryNode(
  commit: RawCommit,
  projectId: string,
  opts: GitCommitCollectorOptions = {},
): MemoryNode {
  const maxFiles = opts.maxFilesPerNode ?? DEFAULTS.maxFilesPerNode;
  const maxBody = opts.maxBodyChars ?? DEFAULTS.maxBodyChars;

  const header = parseConventionalHeader(commit.subject);
  const keptFiles = [...commit.files].sort(byChurnDesc).slice(0, maxFiles);

  const insertions = commit.files.reduce((n, f) => n + (f.insertions ?? 0), 0);
  const deletions = commit.files.reduce((n, f) => n + (f.deletions ?? 0), 0);

  const bodyParts = [commit.subject];
  if (commit.messageBody) bodyParts.push('', commit.messageBody);
  if (keptFiles.length) {
    bodyParts.push('', 'Files changed:', ...keptFiles.map(renderFileLine));
    if (commit.files.length > keptFiles.length) {
      bodyParts.push(`  ...and ${commit.files.length - keptFiles.length} more file(s)`);
    }
  }

  return {
    id: makeNodeId(projectId, 'git_commit', commit.sha),
    kind: 'git_commit',
    projectId,
    ts: commit.authoredAt,
    source: 'git',
    title: truncate(commit.subject || `(no subject) ${commit.shortSha}`, MAX_TITLE_CHARS),
    body: truncate(bodyParts.join('\n'), maxBody),
    files: keptFiles,
    signal: scoreCommit(commit),
    meta: {
      sha: commit.sha,
      shortSha: commit.shortSha,
      parents: commit.parents,
      authorName: commit.authorName,
      authorEmail: commit.authorEmail,
      committedAt: commit.committedAt,
      isMerge: commit.isMerge,
      filesChanged: commit.files.length,
      insertions,
      deletions,
      conventionalType: header.type,
      conventionalScope: header.scope,
      breaking: header.breaking,
    },
  };
}

/** Stream commits from `cwd`'s repository as MemoryNodes. */
export async function* collectGitCommits(
  cwd: string,
  projectId: string,
  opts: GitCommitCollectorOptions = {},
): AsyncGenerator<MemoryNode> {
  for await (const commit of readCommits(cwd, opts)) {
    yield toMemoryNode(commit, projectId, opts);
  }
}
