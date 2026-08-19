import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runScanStructure } from '../src/cli/commands/scan-structure.js';
import { gitFixture } from './helpers.js';

/** `nexusmem scan-structure` (`runScanStructure`) had zero test coverage. */

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
  dir = mkdtempSync(join(tmpdir(), 'nexusmem-scan-structure-'));
  const git = (...args: string[]) => gitFixture(dir, args, { env: GIT_ENV });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.ts'), "import { b } from './b.js';\nexport const a = b;\n");
  writeFileSync(join(dir, 'b.ts'), 'export const b = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'chore: add a.ts importing b.ts');

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

describe('nexusmem scan-structure', () => {
  it('prints a real import edge between two tracked files', async () => {
    const code = await runScanStructure({ cwd: dir, json: false });

    expect(code).toBe(0);
    expect(stdout.join('')).toContain('a.ts');
    expect(stdout.join('')).toContain('->');
    expect(stdout.join('')).toContain('b.ts');
    expect(stderr.join('')).toMatch(/1 edge\(s\) from 2 tracked/);
  });

  it('--json emits an array of file edges', async () => {
    const code = await runScanStructure({ cwd: dir, json: true });

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    const edges = JSON.parse(stdout.join(''));
    expect(Array.isArray(edges)).toBe(true);
    expect(edges).toHaveLength(1);
    expect(edges[0].fromPath).toContain('a.ts');
    expect(edges[0].toPath).toContain('b.ts');
  });
});
