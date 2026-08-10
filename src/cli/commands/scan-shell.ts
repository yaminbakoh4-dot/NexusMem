import pc from 'picocolors';
import { collectShellHistory } from '../../collectors/shell-history.js';
import { makeProjectId } from '../../core/project.js';
import { approxTokens } from '../../core/text.js';
import type { MemoryNode } from '../../core/types.js';
import { readRepoInfo } from '../../git/repo.js';
import { collectAvailableShellHistory } from '../../shell/detect.js';
import { formatSignal, SHELL_SIGNAL_BANDS } from '../format.js';

export interface ScanShellOptions {
  cwd: string;
  tailLines: number;
  minSignal: number;
  json: boolean;
}

export async function runScanShell(opts: ScanShellOptions): Promise<number> {
  const repo = await readRepoInfo(opts.cwd);
  const projectId = makeProjectId({ root: repo.root, originUrl: repo.originUrl });

  const results = await collectAvailableShellHistory({ tailLines: opts.tailLines, repoRoot: repo.root });

  if (!opts.json) {
    process.stderr.write(
      results.length
        ? `${pc.dim('sources found')} ${results.map((r) => r.name).join(', ')}\n\n`
        : `${pc.yellow('no shell history source found on this machine')}\n`,
    );
  }

  const allNodes: MemoryNode[] = [];
  for (const result of results) {
    const nodes = collectShellHistory(result.entries, projectId).filter((n) => n.signal >= opts.minSignal);
    allNodes.push(...nodes);

    if (!opts.json) {
      process.stdout.write(`${pc.bold(`shell:${result.name}`)} ${pc.dim(`(${nodes.length} of ${result.entries.length} above threshold)`)}\n`);
      for (const node of nodes) process.stdout.write(`${formatNode(node)}\n`);
      process.stdout.write('\n');
    }
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(allNodes, null, 2)}\n`);
    return 0;
  }

  const approxTotal = allNodes.reduce((n, x) => n + approxTokens(x.body), 0);
  process.stderr.write(`${pc.bold(String(allNodes.length))} node(s) total  ${pc.dim(`~${approxTotal.toLocaleString()} tokens if sent raw`)}\n`);

  return 0;
}

function formatNode(node: MemoryNode): string {
  const approx = node.meta.tsApprox ? pc.dim('~') : ' ';
  const exit = node.meta.exitCode;
  // Red is reserved for the failure itself. The signal column grades
  // importance, not danger, and reads green-for-high like every other
  // `scan-*` command -- see cli/format.ts.
  const exitLabel = typeof exit === 'number' && exit !== 0 ? pc.red(`exit ${exit}`) : '';
  return [formatSignal(node.signal, SHELL_SIGNAL_BANDS), approx + node.ts.slice(0, 16).replace('T', ' '), node.title, exitLabel]
    .filter(Boolean)
    .join(' ');
}
