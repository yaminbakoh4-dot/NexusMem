import pc from 'picocolors';
import { collectDocFiles } from '../../collectors/docs.js';
import { makeProjectId } from '../../core/project.js';
import type { MemoryNode } from '../../core/types.js';
import { readDocFiles } from '../../docs/read.js';
import { readRepoInfo } from '../../git/repo.js';
import { approxTotalTokens, DOCS_SIGNAL_BANDS, formatSignal } from '../format.js';

export interface ScanDocsOptions {
  cwd: string;
  minSignal: number;
  json: boolean;
}

export async function runScanDocs(opts: ScanDocsOptions): Promise<number> {
  const repo = await readRepoInfo(opts.cwd);
  const projectId = makeProjectId({ root: repo.root, originUrl: repo.originUrl });

  const { files, unreadable } = await readDocFiles(repo.root);

  if (!opts.json) {
    process.stderr.write(
      files.length
        ? `${pc.dim('tracked .md files')} ${files.map((f) => f.path).join(', ')}\n\n`
        : `${pc.yellow('no tracked .md files found')}\n`,
    );
    if (unreadable.length > 0) {
      process.stderr.write(`${pc.yellow('unreadable')} ${unreadable.join(', ')}\n\n`);
    }
  }

  const nodes = collectDocFiles(files, projectId).filter((n) => n.signal >= opts.minSignal);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(nodes, null, 2)}\n`);
    return 0;
  }

  for (const node of nodes) process.stdout.write(`${formatNode(node)}\n`);

  const approxTotal = approxTotalTokens(nodes);
  process.stderr.write(
    `\n${pc.bold(String(nodes.length))} section(s) from ${files.length} file(s) above threshold  ${pc.dim(`~${approxTotal.toLocaleString()} tokens if sent raw`)}\n`,
  );

  return 0;
}

function formatNode(node: MemoryNode): string {
  return [formatSignal(node.signal, DOCS_SIGNAL_BANDS), node.title].join(' ');
}
