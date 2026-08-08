import pc from 'picocolors';
import { collectGitCommits } from '../../collectors/git-commits.js';
import { makeProjectId } from '../../core/project.js';
import type { MemoryNode } from '../../core/types.js';
import { readRepoInfo } from '../../git/repo.js';

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

function signalColor(signal: number): string {
  const s = signal.toFixed(2);
  if (signal >= 0.7) return pc.green(s);
  if (signal >= 0.45) return pc.yellow(s);
  return pc.dim(s);
}

function formatNode(node: MemoryNode): string {
  const sha = String(node.meta.shortSha ?? '').padEnd(9);
  const date = node.ts.slice(0, 10);
  const files = Number(node.meta.filesChanged ?? 0);
  const churn = `+${node.meta.insertions ?? 0}/-${node.meta.deletions ?? 0}`;
  return [
    signalColor(node.signal),
    pc.dim(date),
    pc.magenta(sha),
    node.title,
    pc.dim(`(${files} file${files === 1 ? '' : 's'}, ${churn})`),
  ].join(' ');
}

function summarize(nodes: MemoryNode[]): string {
  if (nodes.length === 0) return pc.yellow('no commits matched');

  const timestamps = nodes.map((n) => n.ts).sort();
  const avgSignal = nodes.reduce((n, x) => n + x.signal, 0) / nodes.length;
  const approxTokens = Math.round(nodes.reduce((n, x) => n + x.body.length, 0) / 4);

  const fileHits = new Map<string, number>();
  for (const node of nodes) {
    for (const f of node.files) fileHits.set(f.path, (fileHits.get(f.path) ?? 0) + 1);
  }
  const hottest = [...fileHits.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([path, count]) => `    ${String(count).padStart(3)}x ${path}`);

  return [
    `${pc.bold(String(nodes.length))} nodes  ${pc.dim(`${timestamps[0]?.slice(0, 10)} .. ${timestamps.at(-1)?.slice(0, 10)}`)}`,
    `  avg signal ${avgSignal.toFixed(3)}   ~${approxTokens.toLocaleString()} tokens if sent raw`,
    hottest.length ? `  hottest files:\n${hottest.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
