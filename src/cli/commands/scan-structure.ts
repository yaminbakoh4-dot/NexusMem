import pc from 'picocolors';
import { collectFileEdges } from '../../structure/collect.js';
import { readRepoInfo } from '../../git/repo.js';

export interface ScanStructureOptions {
  cwd: string;
  json: boolean;
}

export async function runScanStructure(opts: ScanStructureOptions): Promise<number> {
  const repo = await readRepoInfo(opts.cwd);
  const { edges, filesScanned, unreadable } = await collectFileEdges(repo.root);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(edges, null, 2)}\n`);
    return 0;
  }

  if (unreadable.length > 0) {
    process.stderr.write(`${pc.yellow('unreadable')} ${unreadable.join(', ')}\n\n`);
  }

  for (const edge of edges) {
    process.stdout.write(`${edge.fromPath} ${pc.dim('->')} ${edge.toPath}\n`);
  }

  process.stderr.write(
    `\n${pc.bold(String(edges.length))} edge(s) from ${filesScanned} tracked .ts/.tsx/.js/.jsx file(s)\n`,
  );

  return 0;
}
