import pc from 'picocolors';
import { collectCommitDiffs } from '../../collectors/diffs.js';
import { makeProjectId } from '../../core/project.js';
import type { MemoryNode } from '../../core/types.js';
import { readRepoInfo } from '../../git/repo.js';
import { DIFF_SIGNAL_BANDS, formatSignal } from '../format.js';
import { summarize } from './scan-git.js';

export interface ScanDiffOptions {
  cwd: string;
  since?: string;
  /** Commits to walk, not nodes to emit -- one commit yields one node per changed file. */
  limit?: number;
  json: boolean;
  minSignal: number;
}

const DEFAULT_SCAN_COMMITS = 50;

export async function runScanDiff(opts: ScanDiffOptions): Promise<number> {
  const repo = await readRepoInfo(opts.cwd);
  const projectId = makeProjectId({ root: repo.root, originUrl: repo.originUrl });

  if (!opts.json) {
    process.stderr.write(
      [
        `${pc.dim('repo   ')} ${repo.root}`,
        `${pc.dim('branch ')} ${repo.branch ?? pc.yellow('(detached)')}`,
        `${pc.dim('project')} ${pc.cyan(projectId)}`,
        '',
      ].join('\n'),
    );
  }

  const nodes: MemoryNode[] = [];

  for await (const node of collectCommitDiffs(repo.root, projectId, {
    since: opts.since ?? null,
    maxCount: opts.limit ?? DEFAULT_SCAN_COMMITS,
  })) {
    if (node.signal < opts.minSignal) continue;
    nodes.push(node);
    if (!opts.json) process.stdout.write(`${formatNode(node)}\n`);
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(nodes, null, 2)}\n`);
    return 0;
  }

  // The same summary the other scan commands print, from the same helper --
  // "~N tokens if sent raw" has to mean one thing across all of them.
  process.stderr.write(`\n${summarize(nodes)}\n`);
  return 0;
}

function formatNode(node: MemoryNode): string {
  const sha = String(node.meta.shortSha ?? '').padEnd(9);
  const churn = `+${node.meta.insertions ?? 0}/-${node.meta.deletions ?? 0}`;
  return [
    formatSignal(node.signal, DIFF_SIGNAL_BANDS),
    pc.dim(node.ts.slice(0, 10)),
    pc.magenta(sha),
    String(node.meta.path ?? ''),
    pc.dim(`(${churn}, ${node.meta.hunkCount ?? 0} hunk(s))`),
  ].join(' ');
}
