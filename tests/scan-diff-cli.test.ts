import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runScanDiff } from '../src/cli/commands/scan-diff.js';
import { gitFixture } from './helpers.js';

/** `nexusmem scan-diff` (`runScanDiff`) had zero test coverage -- same gap as scan-git. */

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
  dir = mkdtempSync(join(tmpdir(), 'nexusmem-scan-diff-'));
  const git = (...args: string[]) => gitFixture(dir, args, { env: GIT_ENV });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'chore: add a.txt');
  writeFileSync(join(dir, 'b.txt'), 'two\n');
  git('add', '.');
  git('commit', '-q', '-m', 'security: add b.txt to close a real gap');

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

describe('nexusmem scan-diff', () => {
  it('emits one node per changed file across both commits at minSignal 0', async () => {
    const code = await runScanDiff({ cwd: dir, json: false, minSignal: 0 });

    expect(code).toBe(0);
    expect(stdout.join('')).toContain('a.txt');
    expect(stdout.join('')).toContain('b.txt');
  });

  it('filters low-signal diffs below minSignal', async () => {
    const code = await runScanDiff({ cwd: dir, json: false, minSignal: 0.5 });

    expect(code).toBe(0);
    expect(stdout.join('')).not.toContain('a.txt');
    expect(stdout.join('')).toContain('b.txt');
  });

  it('--json emits an array of file-diff nodes', async () => {
    const code = await runScanDiff({ cwd: dir, json: true, minSignal: 0 });

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    const nodes = JSON.parse(stdout.join(''));
    expect(Array.isArray(nodes)).toBe(true);
    expect(nodes.map((n: { meta: { path: string } }) => n.meta.path)).toEqual(expect.arrayContaining(['a.txt', 'b.txt']));
  });

  it('respects --limit, walking only the newest N commits', async () => {
    await runScanDiff({ cwd: dir, json: false, minSignal: 0, limit: 1 });
    expect(stdout.join('')).toContain('b.txt');
    expect(stdout.join('')).not.toContain('a.txt');
  });
});
