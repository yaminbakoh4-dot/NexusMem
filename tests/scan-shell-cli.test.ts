import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runScanShell } from '../src/cli/commands/scan-shell.js';
import { gitFixture } from './helpers.js';

/**
 * `nexusmem scan-shell` (`runScanShell`) had zero test coverage. `bashHistoryPath`/
 * `zshHistoryPath` honor `HISTFILE_BASH`/`HISTFILE` env vars (src/shell/paths.ts),
 * which is what lets this point the scrape at a throwaway temp file instead of the
 * real machine's shell history.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

// picocolors wraps individual words in escape codes (e.g. pc.bold(count)
// leaves an ANSI reset before " node(s)"), so a regex spanning a color
// boundary can fail even though the words are adjacent on screen -- only
// shows up where CI forces color on and a local dev run doesn't. See
// tests/forget.test.ts's own copy of this helper.
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

let dir: string;
let homeDir: string;
let bashHistFile: string;
let stdout: string[];
let stderr: string[];
let prevHistfileBash: string | undefined;
let prevHistfile: string | undefined;
let prevAppData: string | undefined;
let prevNexusmemHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexusmem-scan-shell-'));
  gitFixture(dir, ['init', '-q', '-b', 'main'], { env: GIT_ENV });
  homeDir = mkdtempSync(join(tmpdir(), 'nexusmem-scan-shell-home-'));
  bashHistFile = join(homeDir, 'bash_history');

  prevHistfileBash = process.env.HISTFILE_BASH;
  prevHistfile = process.env.HISTFILE;
  prevAppData = process.env.APPDATA;
  prevNexusmemHome = process.env.NEXUSMEM_HOME;
  // Point every scrape source at paths this test controls, so a real machine's
  // shell history (or hook log) can never leak into what gets asserted.
  process.env.HISTFILE_BASH = bashHistFile;
  process.env.HISTFILE = join(homeDir, 'zsh_history_unused');
  process.env.APPDATA = join(homeDir, 'AppData_unused');
  process.env.NEXUSMEM_HOME = join(homeDir, '.nexusmem-home');

  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(chunk.toString());
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(chunk.toString());
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  process.env.HISTFILE_BASH = prevHistfileBash;
  process.env.HISTFILE = prevHistfile;
  process.env.APPDATA = prevAppData;
  process.env.NEXUSMEM_HOME = prevNexusmemHome;
});

describe('nexusmem scan-shell', () => {
  it('reports no source found when nothing is on disk', async () => {
    const code = await runScanShell({ cwd: dir, tailLines: 300, minSignal: 0, json: false });

    expect(code).toBe(0);
    expect(stderr.join('')).toContain('no shell history source found');
  });

  it('scrapes a real bash history file and lists it as a source', async () => {
    writeFileSync(bashHistFile, '#1700000000\nnpm test\n#1700000100\ngit status\n');

    const code = await runScanShell({ cwd: dir, tailLines: 300, minSignal: 0, json: false });

    expect(code).toBe(0);
    expect(stderr.join('')).toContain('sources found');
    expect(stderr.join('')).toContain('bash');
    expect(stdout.join('')).toContain('shell:bash');
    expect(stdout.join('')).toContain('npm test');
  });

  it('filters low-signal shell entries below minSignal', async () => {
    writeFileSync(bashHistFile, '#1700000000\nnpm test\n');

    await runScanShell({ cwd: dir, tailLines: 300, minSignal: 0, json: false });
    const unfiltered = /(\d+) node\(s\) total/.exec(stripAnsi(stderr.join('')));
    expect(unfiltered).not.toBeNull();
    expect(Number(unfiltered![1])).toBe(1);

    stdout = [];
    stderr = [];
    await runScanShell({ cwd: dir, tailLines: 300, minSignal: 1.1, json: false });
    const filtered = /(\d+) node\(s\) total/.exec(stripAnsi(stderr.join('')));
    expect(filtered).not.toBeNull();
    expect(Number(filtered![1])).toBe(0);
  });

  it('--json emits an array of shell_command nodes', async () => {
    writeFileSync(bashHistFile, '#1700000000\nnpm test\n');

    const code = await runScanShell({ cwd: dir, tailLines: 300, minSignal: 0, json: true });

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    const nodes = JSON.parse(stdout.join(''));
    expect(Array.isArray(nodes)).toBe(true);
    expect(nodes.some((n: { source: string }) => n.source === 'shell:bash')).toBe(true);
  });
});
