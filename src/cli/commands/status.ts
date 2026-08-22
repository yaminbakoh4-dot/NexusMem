import { basename } from 'node:path';
import { statSync } from 'node:fs';
import pc from 'picocolors';
import { getChainStats, type ChainStats } from '../../correlate/failure-fix.js';
import { MemoryStore } from '../../store/store.js';
import { currentSchemaVersion, LATEST_SCHEMA_VERSION } from '../../store/schema.js';
import { loadContext } from '../context.js';
import type { RepoInfo } from '../../git/repo.js';
import type { StoreStats } from '../../store/store.js';

export interface StatusOptions {
  cwd: string;
  /** Where the status report goes. Defaults to real stdout for the CLI. */
  out?: (chunk: string) => void;
  /** Print a plain-text, no-ANSI summary meant to be copy-pasted onto X/Reddit/etc. */
  share?: boolean;
}

function daySpan(oldest: string, newest: string): number {
  const oldestDay = Date.parse(oldest.slice(0, 10));
  const newestDay = Date.parse(newest.slice(0, 10));
  return Math.round((newestDay - oldestDay) / 86_400_000) + 1;
}

function buildShareText(repo: RepoInfo, stats: StoreStats, chains: ChainStats): string {
  if (stats.total === 0) {
    return 'Nothing synced yet in this repo -- run `nexusmem sync` first, then `nexusmem status --share`.\n';
  }

  const days = daySpan(stats.oldest ?? stats.newest ?? '', stats.newest ?? stats.oldest ?? '');
  const commits = stats.byKind.git_commit ?? 0;
  const shellCommands = stats.byKind.shell_command ?? 0;
  const docs = stats.byKind.doc_section ?? 0;
  const parts = [`${commits} commit(s)`, `${shellCommands} shell command(s)`, `${docs} doc section(s)`].filter(
    (p) => !p.startsWith('0 '),
  );

  const lines = [
    `NexusMem has been watching ${basename(repo.root)} for ${days} day(s):`,
    `  ${stats.total} memories${parts.length ? ` (${parts.join(', ')})` : ''}`,
  ];
  if (chains.failuresTotal) {
    lines.push(`  ${chains.resolvedTotal}/${chains.failuresTotal} failure -> fix chain(s) linked`);
  }
  lines.push('', 'Local-only SQLite, no cloud, no telemetry.', 'https://github.com/yaminbkk/NexusMem');

  return lines.join('\n').concat('\n');
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
  const out = opts.out ?? ((chunk: string) => void process.stdout.write(chunk));
  const { repo, ws, projectId } = await loadContext(opts.cwd);
  const store = MemoryStore.open(ws.dbPath);

  try {
    const stats = store.stats(projectId);
    const chains = getChainStats(store, projectId);

    if (opts.share) {
      out(buildShareText(repo, stats, chains));
      return 0;
    }

    const sources = store.listSyncState(projectId);
    const gitCursor = sources.find((s) => s.source === 'git')?.cursor ?? null;
    const schema = currentSchemaVersion(store.raw);
    const otherProjectIds = store.listOtherProjectIds(projectId);
    const otherProjectNodes = store.countProjectNodes(otherProjectIds);
    const structure = store.fileEdgeStats(projectId);
    const staleCount = store.countStaleCandidates(projectId);

    // WAL content counts towards what is actually on disk.
    const dbBytes = fileSize(ws.dbPath) + fileSize(`${ws.dbPath}-wal`);

    const kinds = Object.entries(stats.byKind)
      .sort((a, b) => b[1] - a[1])
      .map(([kind, n]) => `    ${String(n).padStart(6)}  ${kind}`);
    const staleProjectWarning = otherProjectIds.length
      ? `${pc.yellow('stale   ')} ${otherProjectIds.length} prior project ${
          otherProjectIds.length === 1 ? 'identity holds' : 'identities hold'
        } ${otherProjectNodes} node(s) — run ${pc.bold(
          'nexusmem sync --prune-source <name>',
        )} to remove stale source data`
      : '';

    out(
      [
        `${pc.dim('repo    ')} ${repo.root}`,
        `${pc.dim('branch  ')} ${repo.branch ?? pc.yellow('(detached)')}`,
        `${pc.dim('project ')} ${pc.cyan(projectId)}`,
        `${pc.dim('schema  ')} v${schema}${schema === LATEST_SCHEMA_VERSION ? '' : pc.yellow(` (latest is v${LATEST_SCHEMA_VERSION})`)}`,
        `${pc.dim('database')} ${ws.dbPath} ${pc.dim(`(${humanBytes(dbBytes)})`)}`,
        staleProjectWarning,
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
        '',
        gitCursor && gitCursor !== repo.head ? `${pc.yellow('git behind HEAD')} — run ${pc.bold('nexusmem sync')}` : '',
        chains.failuresTotal
          ? `${pc.dim('chains  ')} ${pc.bold(String(chains.resolvedTotal))}/${chains.failuresTotal} failure(s) resolved ${pc.dim(`(${chains.resolvedByRetry} retry, ${chains.resolvedByDiscussion} discussion)`)}${
              chains.resolvedTotal < chains.failuresTotal ? ` — run ${pc.bold('nexusmem sync --link-failures')} to link more` : ''
            }`
          : '',
        structure.edges ? `${pc.dim('structure')} ${pc.bold(String(structure.edges))} import edge(s) across ${structure.files} file(s)` : '',
        staleCount
          ? `${pc.dim('aging   ')} ${pc.bold(String(staleCount))} unconfirmed node(s) worth a look — run ${pc.bold('nexusmem stale')}`
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
