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

/**
 * Same category of leak, found the same way: a real `sync()` in a test scrapes
 * whatever shell-history sources actually exist on the machine running the
 * suite, unless told otherwise. `shell/paths.ts` reads `APPDATA` (PSReadLine),
 * `HISTFILE_BASH` (bash) and `HISTFILE` (zsh) with no isolation of its own, so
 * a test that never touches shell history on purpose can still pull hundreds
 * of real, unredacted commands off the developer's actual machine into a
 * throwaway test DB. Observed directly: a status-report test run here ingested
 * 300 real `shell_command` nodes from this machine's real PSReadLine history.
 * Pointed at paths inside the same throwaway home so none of the three
 * scrape sources resolve to a real file unless a test deliberately creates one.
 */
process.env.APPDATA = join(home, 'AppData-unused');
process.env.HISTFILE_BASH = join(home, 'bash_history-unused');
process.env.HISTFILE = join(home, 'zsh_history-unused');

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});
