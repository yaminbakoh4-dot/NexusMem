import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectAvailableShellHistory } from '../src/shell/detect.js';
import { hookLogPath } from '../src/shell/paths.js';
import { appendHookLogEntry } from '../src/shell/hook-log.js';

/**
 * `tests/scan-shell-cli.test.ts` exercises `collectAvailableShellHistory`
 * only through a single bash-only scenario. The rest of its branch matrix --
 * zsh scraping, combining multiple sources in one call, and `preferHook`
 * skipping the PowerShell scrape once the hook log exists -- had no coverage.
 * `tests/setup.ts` already isolates APPDATA/HISTFILE_BASH/HISTFILE/NEXUSMEM_HOME
 * for the whole suite, so this only needs to point at real files within that
 * isolated home to exercise the real scrape paths.
 */

let homeDir: string;
let bashHistFile: string;
let zshHistFile: string;
let prevHistfileBash: string | undefined;
let prevHistfile: string | undefined;
let prevNexusmemHome: string | undefined;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'nexusmem-shell-detect-'));
  bashHistFile = join(homeDir, 'bash_history');
  zshHistFile = join(homeDir, 'zsh_history');

  prevHistfileBash = process.env.HISTFILE_BASH;
  prevHistfile = process.env.HISTFILE;
  process.env.HISTFILE_BASH = bashHistFile;
  process.env.HISTFILE = zshHistFile;

  // tests/setup.ts points NEXUSMEM_HOME (and so hookLogPath()) at one
  // directory shared for the whole suite. That's fine for tests that scope
  // by repoRoot alone, but this file's "no source on disk" case needs the
  // hook-log *file itself* to not exist yet -- which a sibling test file
  // appending to the shared log first would silently break. Override to a
  // directory unique to this file instead, same pattern as
  // tests/cross-project.test.ts.
  prevNexusmemHome = process.env.NEXUSMEM_HOME;
  process.env.NEXUSMEM_HOME = homeDir;
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  process.env.HISTFILE_BASH = prevHistfileBash;
  process.env.HISTFILE = prevHistfile;
  process.env.NEXUSMEM_HOME = prevNexusmemHome;
});

describe('collectAvailableShellHistory', () => {
  it('scrapes a real zsh history file', async () => {
    writeFileSync(zshHistFile, ': 1700000000:0;npm run build\n');

    const results = await collectAvailableShellHistory({ tailLines: 300 });

    const zsh = results.find((r) => r.name === 'zsh');
    expect(zsh).toBeDefined();
    expect(zsh!.entries.some((e) => e.command.includes('npm run build'))).toBe(true);
  });

  it('combines bash and zsh into two separate source results in one call', async () => {
    writeFileSync(bashHistFile, '#1700000000\nnpm test\n');
    writeFileSync(zshHistFile, ': 1700000000:0;npm run build\n');

    const results = await collectAvailableShellHistory({ tailLines: 300 });

    expect(results.map((r) => r.name).sort()).toEqual(['bash', 'zsh']);
  });

  it('the hook log is scoped to entries under repoRoot', async () => {
    const repoRoot = join(homeDir, 'my-repo');
    await appendHookLogEntry(hookLogPath(), {
      ts: '2026-01-01T00:00:00.000Z',
      cwd: repoRoot,
      exitCode: 0,
      durationMs: 5,
      command: 'echo inside repo',
    });
    await appendHookLogEntry(hookLogPath(), {
      ts: '2026-01-01T00:00:01.000Z',
      cwd: join(homeDir, 'other-repo'),
      exitCode: 0,
      durationMs: 5,
      command: 'echo outside repo',
    });

    const results = await collectAvailableShellHistory({ repoRoot });

    const hook = results.find((r) => r.name === 'pwsh-hook');
    expect(hook).toBeDefined();
    const commands = hook!.entries.map((e) => e.command);
    expect(commands).toContain('echo inside repo');
    expect(commands).not.toContain('echo outside repo');
  });

  it('returns an empty array when no source exists on disk', async () => {
    const results = await collectAvailableShellHistory({ repoRoot: join(homeDir, 'no-such-repo') });
    expect(results).toEqual([]);
  });
});
