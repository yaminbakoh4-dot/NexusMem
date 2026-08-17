import pc from 'picocolors';
import type { DenyListInput } from '../../store/deny-list.js';
import { DenyListError } from '../../store/deny-list.js';
import { MemoryStore } from '../../store/store.js';
import { loadContext } from '../context.js';

export interface ForgetOptions {
  cwd: string;
  /** Text to forget. Required unless `list` is set. */
  value?: string;
  /** Treat `value` as a regular expression instead of a literal substring. */
  regex?: boolean;
  ignoreCase?: boolean;
  reason?: string;
  /** List active deny-list entries for this project instead of forgetting a new value. */
  list?: boolean;
  /** Confirm the irreversible delete + deny-list write. Without it, only a dry-run count is printed. */
  yes?: boolean;
  out?: (chunk: string) => void;
}

/**
 * `nexusmem forget <value>` -- the value-keyed complement to `sync
 * --prune-source`. Where a prune deletes an entire collector source, this
 * deletes every node matching one specific value *and* writes a standing
 * deny-list entry, so the value can never be re-derived from an
 * append-only source (the shell-hook log, a full transcript re-read) on a
 * later `sync --rebuild`. See `MemoryStore.forget`.
 *
 * Dry-run by default, matching `--prune-source`'s convention exactly: without
 * `--yes` this only counts and prints.
 */
export async function runForget(opts: ForgetOptions): Promise<number> {
  const { ws, projectId } = await loadContext(opts.cwd);
  const out = opts.out ?? ((chunk: string) => void process.stdout.write(chunk));

  const store = MemoryStore.open(ws.dbPath);
  try {
    if (opts.list) {
      const entries = store.listDenyList(projectId);
      if (entries.length === 0) {
        out(`${pc.dim('forget --list')} no active deny-list entries for this project\n`);
        return 0;
      }
      out(
        [
          `${pc.dim('deny-list entries')} (${entries.length}):`,
          ...entries.map(
            (e) =>
              `  #${e.id} ${e.matchType === 'regex' ? pc.dim('/') + e.pattern + pc.dim('/') : JSON.stringify(e.pattern)}` +
              `${e.ignoreCase ? pc.dim(' (case-insensitive)') : ''}` +
              `${e.reason ? pc.dim(` -- ${e.reason}`) : ''}`,
          ),
          '',
        ].join('\n'),
      );
      return 0;
    }

    if (!opts.value) {
      throw new DenyListError('a value is required (or pass --list to see active deny-list entries)');
    }

    const input: DenyListInput = {
      matchType: opts.regex ? 'regex' : 'literal',
      pattern: opts.value,
      ignoreCase: opts.ignoreCase ?? false,
      reason: opts.reason ?? null,
    };
    const otherProjectIds = store.listOtherProjectIds(projectId);
    const scopeIds = [projectId, ...otherProjectIds];

    if (!opts.yes) {
      const preview = store.previewForget(projectId, otherProjectIds, input);
      const total = preview.reduce((sum, p) => sum + p.count, 0);

      if (total === 0) {
        out(`${pc.dim('forget')} no node(s) currently match this value -- re-run with --yes to deny-list it anyway (blocks future ingest)\n`);
        return 0;
      }

      const describe = (p: (typeof preview)[number]) =>
        `  ${pc.dim(p.source)}${p.projectId !== projectId ? pc.dim(` (prior identity ${p.projectId.slice(0, 8)})`) : ''}: ${p.count} node(s)`;
      out(
        [
          `${pc.yellow('would remove')} ${total} node(s):`,
          ...preview.map(describe),
          pc.dim('re-run with --yes to permanently deny-list this value and delete these node(s) -- this cannot be undone'),
          '',
        ].join('\n'),
      );
      return 0;
    }

    const result = store.forget(projectId, otherProjectIds, input);
    const identityPart = otherProjectIds.length > 0 ? `, ${scopeIds.length} project identit${scopeIds.length === 1 ? 'y' : 'ies'}` : '';
    out(`${pc.green('forgotten')} ${result.removed} node(s) deleted${identityPart}, deny-list entry #${result.entryId} written\n`);
    return 0;
  } finally {
    store.close();
  }
}
