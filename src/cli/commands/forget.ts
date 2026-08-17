import { readFile, writeFile } from 'node:fs/promises';
import pc from 'picocolors';
import { z } from 'zod';
import type { DenyListInput } from '../../store/deny-list.js';
import { DenyListError } from '../../store/deny-list.js';
import { MemoryStore } from '../../store/store.js';
import { loadContext } from '../context.js';

export interface ForgetOptions {
  cwd: string;
  /** Text to forget. Required unless `list`/`export`/`import` is set. */
  value?: string;
  /** Treat `value` as a regular expression instead of a literal substring. */
  regex?: boolean;
  ignoreCase?: boolean;
  reason?: string;
  /** List active deny-list entries for this project instead of forgetting a new value. */
  list?: boolean;
  /** Write this project's deny-list to a JSON file at this path, for `--import` in another checkout. */
  export?: string;
  /** Re-apply a deny-list JSON file (from `--export`) against this project. */
  import?: string;
  /** Confirm the irreversible delete + deny-list write. Without it, only a dry-run count is printed. */
  yes?: boolean;
  out?: (chunk: string) => void;
}

/**
 * Shape written by `--export` / read by `--import`.
 *
 * Deliberately just `DenyListInput` fields, nothing repo- or id-specific: the
 * whole point is that this file is portable across every checkout of the
 * same project, which is exactly what `deny_list` itself is not (it lives in
 * `.nexusmem/memory.db`, gitignored, never travels with `git clone`).
 */
const ExportPayloadSchema = z.object({
  version: z.literal(1),
  entries: z.array(
    z.object({
      matchType: z.enum(['literal', 'regex']),
      pattern: z.string(),
      ignoreCase: z.boolean(),
      reason: z.string().nullable(),
    }),
  ),
});

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

    if (opts.export) {
      const entries = store.listDenyList(projectId);
      const payload = {
        version: 1 as const,
        entries: entries.map((e) => ({ matchType: e.matchType, pattern: e.pattern, ignoreCase: e.ignoreCase, reason: e.reason })),
      };
      await writeFile(opts.export, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      out(
        [
          `${pc.green('exported')} ${entries.length} deny-list entrie(s) to ${opts.export}`,
          pc.yellow(
            'this file contains the raw forgotten value(s) in plaintext -- store it somewhere secure ' +
              '(password manager, encrypted note) and never commit it to git or share it publicly.',
          ),
          '',
        ].join('\n'),
      );
      return 0;
    }

    if (opts.import) {
      let raw: string;
      try {
        raw = await readFile(opts.import, 'utf8');
      } catch (err) {
        throw new DenyListError(`could not read ${opts.import}: ${err instanceof Error ? err.message : String(err)}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new DenyListError(`${opts.import} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      const validated = ExportPayloadSchema.safeParse(parsed);
      if (!validated.success) {
        throw new DenyListError(
          `${opts.import} is not a valid deny-list export: ${validated.error.issues.map((i) => i.message).join('; ')}`,
        );
      }
      const entries: DenyListInput[] = validated.data.entries;
      const otherProjectIds = store.listOtherProjectIds(projectId);

      if (!opts.yes) {
        const preview = store.previewImportDenyList(projectId, otherProjectIds, entries);
        const toImport = preview.filter((p) => !p.alreadyPresent);
        const totalRemove = toImport.reduce((sum, p) => sum + p.wouldRemove, 0);

        if (toImport.length === 0) {
          out(`${pc.dim('forget --import')} all ${preview.length} entrie(s) in ${opts.import} are already active -- nothing to do\n`);
          return 0;
        }
        const describe = (p: (typeof toImport)[number]) =>
          `  ${p.matchType === 'regex' ? pc.dim('/') + p.pattern + pc.dim('/') : JSON.stringify(p.pattern)}: ${p.wouldRemove} node(s)`;
        out(
          [
            `${pc.yellow('would import')} ${toImport.length} new deny-list entrie(s)` +
              `${preview.length > toImport.length ? ` (${preview.length - toImport.length} already active)` : ''}, ` +
              `removing ${totalRemove} node(s):`,
            ...toImport.map(describe),
            pc.dim('re-run with --yes to permanently deny-list these value(s) and delete matching node(s) -- this cannot be undone'),
            '',
          ].join('\n'),
        );
        return 0;
      }

      const result = store.importDenyList(projectId, otherProjectIds, entries);
      out(
        `${pc.green('imported')} ${result.imported} deny-list entrie(s)${result.skipped > 0 ? ` (${result.skipped} already active)` : ''}, ` +
          `${result.removedNodes} node(s) deleted\n`,
      );
      return 0;
    }

    if (!opts.value) {
      throw new DenyListError('a value is required (or pass --list/--export/--import)');
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
