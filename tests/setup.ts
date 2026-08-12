import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

/**
 * Point every user-scoped path at a throwaway directory, for the whole suite.
 *
 * This is a guard, not a convenience. `sync` records the repository it just
 * ingested in `~/.nexusmem/projects.json` so cross-project recall can find it
 * later, and the suite syncs a fresh temp repository in several places -- so
 * without this, running the tests wrote seven dead entries into the
 * developer's real registry. Observed, not hypothetical: they were found by
 * running `nexusmem projects` after the first green run.
 *
 * Set here rather than per-test so a new test cannot forget it.
 */
const home = mkdtempSync(join(tmpdir(), 'nexusmem-test-home-'));
process.env.NEXUSMEM_HOME = home;

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});
