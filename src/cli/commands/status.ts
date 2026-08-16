import { statSync } from 'node:fs';
import pc from 'picocolors';
import { getChainStats } from '../../correlate/failure-fix.js';
import { MemoryStore } from '../../store/store.js';
import { currentSchemaVersion, LATEST_SCHEMA_VERSION } from '../../store/schema.js';
import { loadContext } from '../context.js';

export interface StatusOptions {
  cwd: string;
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export async function runStatus(opts: StatusOptions): Promise<number> {
  const { repo, ws, projectId } = await loadContext(opts.cwd);
  const store = MemoryStore.open(ws.dbPath);

  try {
    const stats = store.stats(projectId);
    const sources = store.listSyncState(projectId);
    const gitCursor = sources.find((s) => s.source === 'git')?.cursor ?? null;
    const schema = currentSchemaVersion(store.raw);
    const chains = getChainStats(store, projectId);

    // WAL content counts towards what is actually on disk.
    const dbBytes = fileSize(ws.dbPath) + fileSize(`${ws.dbPath}-wal`);

    const kinds = Object.entries(stats.byKind)
      .sort((a, b) => b[1] - a[1])
      .map(([kind, n]) => `    ${String(n).padStart(6)}  ${kind}`);

    process.stdout.write(
      [
        `${pc.dim('repo    ')} ${repo.root}`,
        `${pc.dim('branch  ')} ${repo.branch ?? pc.yellow('(detached)')}`,
        `${pc.dim('project ')} ${pc.cyan(projectId)}`,
        `${pc.dim('schema  ')} v${schema}${schema === LATEST_SCHEMA_VERSION ? '' : pc.yellow(` (latest is v${LATEST_SCHEMA_VERSION})`)}`,
        `${pc.dim('database')} ${ws.dbPath} ${pc.dim(`(${humanBytes(dbBytes)})`)}`,
        '',
        `${pc.bold(String(stats.total))} node(s)${stats.total ? ` ${pc.dim(`${stats.oldest?.slice(0, 10)} .. ${stats.newest?.slice(0, 10)}`)}` : ''}`,
        ...kinds,
        stats.total ? `    ${pc.dim(`${stats.distinctFiles} distinct file path(s)`)}` : '',
        '',
        sources.length ? pc.dim('sources') : pc.yellow('no sources synced yet'),
        ...sources.map((s) => {
          const when = s.lastRunAt ? new Date(s.lastRunAt).toISOString().slice(0, 16).replace('T', ' ') : 'never';
          const cursorLabel = s.source === 'git' ? (s.cursor?.slice(0, 7) ?? '-') : (s.cursor ?? '-');
          return `    ${s.source.padEnd(14)} ${pc.dim(`last run ${when}`)}  ${pc.dim(`cursor ${cursorLabel}`)}`;
        }),
        gitCursor && gitCursor !== repo.head ? `${pc.yellow('git behind HEAD')} — run ${pc.bold('nexusmem sync')}` : '',
        '',
        chains.failuresTotal
          ? `${pc.dim('chains  ')} ${pc.bold(String(chains.resolvedTotal))}/${chains.failuresTotal} failure(s) resolved ${pc.dim(`(${chains.resolvedByRetry} retry, ${chains.resolvedByDiscussion} discussion)`)}${
              chains.resolvedTotal < chains.failuresTotal ? ` — run ${pc.bold('nexusmem sync --link-failures')} to link more` : ''
            }`
          : '',
      ]
        .filter((line) => line !== '')
        .join('\n')
        .concat('\n'),
    );

    return 0;
  } finally {
    store.close();
  }
}
