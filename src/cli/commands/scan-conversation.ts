import pc from 'picocolors';
import { collectConversationTurns } from '../../collectors/conversation.js';
import { collectClaudeCodeTranscripts } from '../../conversation/claude-code-reader.js';
import { claudeProjectTranscriptDir, listTranscriptFiles } from '../../conversation/paths.js';
import { makeProjectId } from '../../core/project.js';
import { approxTokens } from '../../core/text.js';
import type { MemoryNode } from '../../core/types.js';
import { readRepoInfo } from '../../git/repo.js';

export interface ScanConversationOptions {
  cwd: string;
  minSignal: number;
  json: boolean;
}

export async function runScanConversation(opts: ScanConversationOptions): Promise<number> {
  const repo = await readRepoInfo(opts.cwd);
  const projectId = makeProjectId({ root: repo.root, originUrl: repo.originUrl });

  const files = await listTranscriptFiles(repo.root);

  if (!opts.json) {
    process.stderr.write(
      files.length
        ? `${pc.dim('transcripts')} ${files.length} file(s) in ${claudeProjectTranscriptDir(repo.root)}\n\n`
        : `${pc.yellow('no transcripts found')} at ${claudeProjectTranscriptDir(repo.root)}\n`,
    );
  }

  const turns = await collectClaudeCodeTranscripts(repo.root);
  const nodes = collectConversationTurns(turns, projectId).filter((n) => n.signal >= opts.minSignal);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(nodes, null, 2)}\n`);
    return 0;
  }

  for (const node of nodes) process.stdout.write(`${formatNode(node)}\n`);

  const redactedTotal = nodes.reduce((n, x) => n + (Number(x.meta.redactedCount) || 0), 0);
  const approxTotal = nodes.reduce((n, x) => n + approxTokens(x.body), 0);
  process.stderr.write(
    `\n${pc.bold(String(nodes.length))} of ${turns.length} exchange(s) above threshold  ${pc.dim(`~${approxTotal.toLocaleString()} tokens if sent raw`)}` +
      (redactedTotal > 0 ? `  ${pc.yellow(`${redactedTotal} secret-like value(s) redacted`)}` : '') +
      '\n',
  );

  return 0;
}

function signalColor(signal: number): string {
  const s = signal.toFixed(2);
  if (signal >= 0.55) return pc.green(s);
  if (signal >= 0.35) return pc.yellow(s);
  return pc.dim(s);
}

function formatNode(node: MemoryNode): string {
  return [signalColor(node.signal), node.ts.slice(0, 16).replace('T', ' '), node.title].join(' ');
}
