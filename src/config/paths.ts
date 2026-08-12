import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The user-scoped (not repo-scoped) NexusMem directory.
 *
 * Lived in `shell/paths.ts` while the hook log was the only thing in it. The
 * project registry is the second, and it has nothing to do with shells, so
 * the location moved somewhere neither feature owns.
 *
 * `NEXUSMEM_HOME` overrides it. That is not a convenience flag: without it a
 * test of anything user-scoped would read and write the developer's real home
 * directory, which is exactly the kind of test this project does not have.
 */
export function globalWorkspaceDir(): string {
  return process.env.NEXUSMEM_HOME ?? join(homedir(), '.nexusmem');
}
