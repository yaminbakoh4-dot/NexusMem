import pc from 'picocolors';
import { forgetProjects, readLiveRegistry, registryPath } from '../../config/registry.js';
import { MemoryStore } from '../../store/store.js';

export interface ProjectsOptions {
  /** Forget registered projects whose database is no longer on disk. */
  prune: boolean;
  json: boolean;
}

/**
 * What `query --all-projects` would search, and what it would skip.
 *
 * Cross-project recall reads from databases outside the current repository,
 * which is exactly the kind of thing a user should be able to inspect before
 * trusting it. This is that inspection.
 */
export async function runProjects(opts: ProjectsOptions): Promise<number> {
  const { entries, missing } = await readLiveRegistry();

  const rows = entries.map((entry) => {
    let nodes: number | null = null;
    try {
      const store = MemoryStore.open(entry.dbPath);
      try {
        nodes = store.stats(entry.projectId).total;
      } finally {
        store.close();
      }
    } catch {
      // Present but unopenable (corrupt file, a lock we cannot take, a
      // native module mismatch). Reported as unknown rather than as zero,
      // which would read as "synced and empty".
      nodes = null;
    }
    return { ...entry, nodes };
  });

  if (opts.prune) {
    const removed = await forgetProjects(missing.map((entry) => entry.projectId));
    process.stderr.write(`${pc.yellow('pruned')} ${removed} project(s) whose database is gone\n`);
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ registry: registryPath(), projects: rows, missing }, null, 2)}\n`);
    return 0;
  }

  process.stderr.write(`${pc.dim('registry')} ${registryPath()}\n\n`);

  if (rows.length === 0) {
    process.stderr.write(`${pc.yellow('no projects registered')} -- run ${pc.bold('nexusmem sync')} in a repository\n`);
    return 0;
  }

  for (const row of rows) {
    const seen = new Date(row.lastSeenAt).toISOString().slice(0, 16).replace('T', ' ');
    const count = row.nodes === null ? pc.yellow('unreadable') : `${row.nodes} node(s)`;
    process.stdout.write(`${pc.cyan(row.projectId.slice(0, 8))}  ${row.root}\n    ${pc.dim(`${count}, last seen ${seen}`)}\n`);
  }

  if (!opts.prune && missing.length > 0) {
    process.stderr.write(
      `\n${pc.yellow(`${missing.length} registered project(s) have no database on disk`)}` +
        ` ${pc.dim('-- run with --prune to forget them')}\n`,
    );
    for (const entry of missing) process.stderr.write(`    ${pc.dim(entry.root)}\n`);
  }

  return 0;
}
