import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runScanDocs } from '../src/cli/commands/scan-docs.js';
import { gitFixture } from './helpers.js';

/** `nexusmem scan-docs` (`runScanDocs`) had zero test coverage. */

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
  dir = mkdtempSync(join(tmpdir(), 'nexusmem-scan-docs-'));
  gitFixture(dir, ['init', '-q', '-b', 'main'], { env: GIT_ENV });

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

function commitFile(path: string, content: string): void {
  writeFileSync(join(dir, path), content);
  gitFixture(dir, ['add', '.'], { env: GIT_ENV });
  gitFixture(dir, ['commit', '-q', '-m', `docs: add ${path}`], { env: GIT_ENV });
}

describe('nexusmem scan-docs', () => {
  it('reports no tracked .md files when none exist', async () => {
    const code = await runScanDocs({ cwd: dir, json: false, minSignal: 0 });

    expect(code).toBe(0);
    expect(stderr.join('')).toContain('no tracked .md files found');
  });

  it('lists sections from a real tracked markdown file', async () => {
    commitFile('README.md', '# Title\n\nSome real content here, more than trivial.\n\n## Section two\n\nMore content.\n');

    const code = await runScanDocs({ cwd: dir, json: false, minSignal: 0 });

    expect(code).toBe(0);
    expect(stderr.join('')).toContain('README.md');
    expect(stdout.join('')).toContain('Title');
  });

  it('reports a tracked-but-missing-on-disk file as unreadable, not as a crash', async () => {
    commitFile('GONE.md', '# Gone\n\nThis file will be deleted from disk without git rm.\n');
    unlinkSync(join(dir, 'GONE.md'));

    const code = await runScanDocs({ cwd: dir, json: false, minSignal: 0 });

    expect(code).toBe(0);
    expect(stderr.join('')).toContain('unreadable');
    expect(stderr.join('')).toContain('GONE.md');
  });

  it('--json emits an array of doc_section nodes', async () => {
    commitFile('README.md', '# Title\n\nSome real content here, more than trivial.\n');

    const code = await runScanDocs({ cwd: dir, json: true, minSignal: 0 });

    expect(code).toBe(0);
    const nodes = JSON.parse(stdout.join(''));
    expect(Array.isArray(nodes)).toBe(true);
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes[0].kind).toBe('doc_section');
  });
});
