import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runScanGit } from '../src/cli/commands/scan-git.js';
import { gitFixture } from './helpers.js';

/**
 * `nexusmem scan-git` was never exercised by any test -- `tests/cli-scan.test.ts`
 * only pins the `cli/format.ts` helpers it happens to import. This covers the
 * command itself: repo header, per-node filtering by `minSignal`, and the two
 * output modes (`--json` vs the human-readable list + summary).
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

let dir: string;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexusmem-scan-git-'));
  const git = (...args: string[]) => gitFixture(dir, args, { env: GIT_ENV });
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'https://example.com/acme/scan-git.git');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'style: reformat a.txt');
  writeFileSync(join(dir, 'a.txt'), 'two\n');
  git('add', '.');
  git('commit', '-q', '-m', 'security: fix a real vulnerability in a.txt handling');

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
});

describe('nexusmem scan-git', () => {
  it('prints the repo/branch/origin/project header and both commits at minSignal 0', async () => {
    const code = await runScanGit({ cwd: dir, merges: false, json: false, minSignal: 0 });

    expect(code).toBe(0);
    const header = stderr.join('');
    // Compare basenames, not the full path: mkdtempSync's `dir` and the path
    // git itself reports back can differ in Windows short-name vs long-name
    // form for the parent (e.g. `USER-0~1` vs `user-0118012023`) even though
    // both resolve to the same directory.
    expect(header).toContain(basename(dir));
    expect(header).toContain('main');
    expect(header).toContain('scan-git.git');

    expect(stdout.join('')).toContain('reformat a.txt');
    expect(stdout.join('')).toContain('fix a real vulnerability');
  });

  it('filters out low-signal commits below minSignal', async () => {
    // style: 0.2, security: 0.85 in TYPE_WEIGHTS -- 0.5 sits strictly between them.
    const code = await runScanGit({ cwd: dir, merges: false, json: false, minSignal: 0.5 });

    expect(code).toBe(0);
    expect(stdout.join('')).not.toContain('reformat a.txt');
    expect(stdout.join('')).toContain('fix a real vulnerability');
  });

  it('respects --limit, walking only the newest N commits', async () => {
    await runScanGit({ cwd: dir, merges: false, json: false, minSignal: 0, limit: 1 });
    expect(stdout.join('')).toContain('fix a real vulnerability');
    expect(stdout.join('')).not.toContain('reformat a.txt');
  });

  it('--json emits an array of nodes on stdout and nothing on stderr', async () => {
    const code = await runScanGit({ cwd: dir, merges: false, json: true, minSignal: 0 });

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    const nodes = JSON.parse(stdout.join(''));
    expect(Array.isArray(nodes)).toBe(true);
    expect(nodes).toHaveLength(2);
    expect(nodes.map((n: { title: string }) => n.title)).toEqual(
      expect.arrayContaining([expect.stringContaining('reformat a.txt'), expect.stringContaining('fix a real vulnerability')]),
    );
  });

  it('prints the shared token summary after the node list', async () => {
    await runScanGit({ cwd: dir, merges: false, json: false, minSignal: 0 });
    expect(stderr.join('')).toMatch(/~\d+ tokens if sent raw/);
  });
});
