import pc from 'picocolors';
import { MemoryStore } from '../../store/store.js';
import { loadContext } from '../context.js';

export interface StaleOptions {
  cwd: string;
  minAgeDays?: number;
  limit?: number;
  out?: (chunk: string) => void;
}

/**
 * `nexusmem stale`. Lists inferred nodes old enough that nothing has
 * confirmed they still hold -- a heuristic surfacing list, not contradiction
 * detection. Mutates nothing; run `mark-stale` yourself on whichever ids
 * actually turned out wrong.
 */
export async function runStale(opts: StaleOptions): Promise<number> {
  const { projectId, ws } = await loadContext(opts.cwd);
  const out = opts.out ?? ((chunk: string) => void process.stdout.write(chunk));

  const store = MemoryStore.open(ws.dbPath);
  try {
    const candidates = store.listStaleCandidates(projectId, { minAgeDays: opts.minAgeDays, limit: opts.limit });

    if (candidates.length === 0) {
      out(`${pc.dim('no stale candidates')} -- no inferred node older than the threshold lacks a successor\n`);
      return 0;
    }

    out(
      [
        `${pc.bold(String(candidates.length))} stale candidate(s) -- oldest first, none of these were changed:`,
        ...candidates.map(
          (c) => `  ${pc.dim(c.id)} ${pc.yellow(`${c.ageDays}d old`)} [${c.kind}] ${c.title}`,
        ),
        '',
        `run ${pc.bold('nexusmem mark-stale <id> --supersedes <newId>')} on any that are actually wrong`,
      ].join('\n').concat('\n'),
    );
    return 0;
  } finally {
    store.close();
  }
}
