import pc from 'picocolors';
import { collectGitCommits } from '../../collectors/git-commits.js';
import { makeProjectId } from '../../core/project.js';
import type { MemoryNode } from '../../core/types.js';
import { readRepoInfo } from '../../git/repo.js';
import { formatSignal, GIT_SIGNAL_BANDS, summarize } from '../format.js';

export interface ScanGitOptions {
  cwd: string;
  since?: string;
  limit?: number;
  merges: boolean;
  json: boolean;
  minSignal: number;
}

export async function runScanGit(opts: ScanGitOptions): Promise<number> {
  const repo = await readRepoInfo(opts.cwd);
  const projectId = makeProjectId({ root: repo.root, originUrl: repo.originUrl });

  if (!opts.json) {
    process.stderr.write(
      [
        `${pc.dim('repo   ')} ${repo.root}`,
        `${pc.dim('branch ')} ${repo.branch ?? pc.yellow('(detached)')}`,
        `${pc.dim('origin ')} ${repo.originUrl ?? pc.dim('(none)')}`,
        `${pc.dim('project')} ${pc.cyan(projectId)}`,
        '',
      ].join('\n'),
    );
  }

  const nodes: MemoryNode[] = [];
  const collectOpts = {
    since: opts.since ?? null,
    maxCount: opts.limit ?? null,
    includeMerges: opts.merges,
  };

  for await (const node of collectGitCommits(repo.root, projectId, collectOpts)) {
    if (node.signal < opts.minSignal) continue;
    nodes.push(node);
    if (!opts.json) process.stdout.write(`${formatNode(node)}\n`);
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(nodes, null, 2)}\n`);
    return 0;
  }

  process.stderr.write(`\n${summarize(nodes)}\n`);
  return 0;
}

function formatNode(node: MemoryNode): string {
  const sha = String(node.meta.shortSha ?? '').padEnd(9);
  const date = node.ts.slice(0, 10);
  const files = Number(node.meta.filesChanged ?? 0);
  const churn = `+${node.meta.insertions ?? 0}/-${node.meta.deletions ?? 0}`;
  return [
    formatSignal(node.signal, GIT_SIGNAL_BANDS),
    pc.dim(date),
    pc.magenta(sha),
    node.title,
    pc.dim(`(${files} file${files === 1 ? '' : 's'}, ${churn})`),
  ].join(' ');
}
