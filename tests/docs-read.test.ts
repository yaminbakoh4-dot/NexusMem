import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listDocFiles, readDocFiles } from '../src/docs/read.js';
import { gitFixture } from './helpers.js';

/**
 * `listDocFiles`/`readDocFiles`'s `include` option -- how `sync.ts` passes
 * through `config.sources.docs.include` for a user who wants to scope which
 * markdown files get indexed -- had zero coverage. Every existing docs test
 * (collectors/docs.ts's own tests, and scan-docs-cli.test.ts) only ever used
 * the default `*.md` pathspec.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexusmem-docs-read-'));
  const git = (...args: string[]) => gitFixture(dir, args, { env: GIT_ENV });
  git('init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# Top level\n');
  writeFileSync(join(dir, 'docs', 'guide.md'), '# Guide\n');
  git('add', '.');
  git('commit', '-q', '-m', 'docs: add README and docs/guide');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('listDocFiles', () => {
  it('defaults to every tracked .md file, at any depth', async () => {
    const files = await listDocFiles(dir);
    expect(files.sort()).toEqual(['README.md', 'docs/guide.md']);
  });

  it('a custom include pathspec scopes to just the matching files', async () => {
    const files = await listDocFiles(dir, { include: ['docs/*.md'] });
    expect(files).toEqual(['docs/guide.md']);
  });
});

describe('readDocFiles', () => {
  it('respects the same include option, reading only the scoped files', async () => {
    const { files, unreadable } = await readDocFiles(dir, { include: ['docs/*.md'] });

    expect(unreadable).toEqual([]);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe('docs/guide.md');
    expect(files[0]!.content).toContain('Guide');
  });
});
