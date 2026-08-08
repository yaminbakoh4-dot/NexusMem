import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryNode } from '../src/core/types.js';
import { MemoryStore } from '../src/store/store.js';
import { currentSchemaVersion, LATEST_SCHEMA_VERSION } from '../src/store/schema.js';
import { toMatchQuery } from '../src/store/fts.js';

const PROJECT = 'proj-a';

function node(overrides: Partial<MemoryNode> & Pick<MemoryNode, 'id'>): MemoryNode {
  return {
    kind: 'git_commit',
    projectId: PROJECT,
    ts: '2026-03-01T10:00:00+07:00',
    source: 'git',
    title: 'feat: something',
    body: 'feat: something',
    files: [],
    signal: 0.5,
    meta: {},
    ...overrides,
  };
}

describe('MemoryStore', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('migrates a fresh database to the latest schema', () => {
    expect(currentSchemaVersion(store.raw)).toBe(LATEST_SCHEMA_VERSION);
  });

  it('is idempotent: re-ingesting identical nodes changes nothing', () => {
    const nodes = [node({ id: 'a' }), node({ id: 'b' })];

    expect(store.upsertNodes(nodes)).toEqual({ inserted: 2, updated: 0, unchanged: 0 });
    expect(store.upsertNodes(nodes)).toEqual({ inserted: 0, updated: 0, unchanged: 2 });
    expect(store.stats(PROJECT).total).toBe(2);
  });

  it('rewrites a node only when its derived content changed', () => {
    store.upsertNodes([node({ id: 'a', signal: 0.5 })]);
    expect(store.upsertNodes([node({ id: 'a', signal: 0.9 })])).toEqual({
      inserted: 0,
      updated: 1,
      unchanged: 0,
    });
  });

  it('persists file touches, including renames and binaries', () => {
    store.upsertNodes([
      node({
        id: 'a',
        files: [
          { path: 'src/core/app.ts', previousPath: 'src/app.ts', insertions: 3, deletions: 1, binary: false },
          { path: 'assets/logo.png', insertions: null, deletions: null, binary: true },
        ],
      }),
    ]);

    const rows = store.raw
      .prepare('SELECT path, previous_path, insertions, is_binary FROM node_files ORDER BY path')
      .all() as Array<{ path: string; previous_path: string | null; insertions: number | null; is_binary: number }>;

    expect(rows).toEqual([
      { path: 'assets/logo.png', previous_path: null, insertions: null, is_binary: 1 },
      { path: 'src/core/app.ts', previous_path: 'src/app.ts', insertions: 3, is_binary: 0 },
    ]);
    expect(store.stats(PROJECT).distinctFiles).toBe(2);
  });

  it('replaces the file list when a node is updated', () => {
    store.upsertNodes([node({ id: 'a', files: [{ path: 'old.ts', insertions: 1, deletions: 0, binary: false }] })]);
    store.upsertNodes([
      node({ id: 'a', signal: 0.9, files: [{ path: 'new.ts', insertions: 1, deletions: 0, binary: false }] }),
    ]);

    const paths = (store.raw.prepare('SELECT path FROM node_files').all() as Array<{ path: string }>).map(
      (r) => r.path,
    );
    expect(paths).toEqual(['new.ts']);
  });

  it('cascades file rows when a project is cleared', () => {
    store.upsertNodes([node({ id: 'a', files: [{ path: 'a.ts', insertions: 1, deletions: 0, binary: false }] })]);
    expect(store.clearProject(PROJECT)).toBe(1);

    const remaining = store.raw.prepare('SELECT COUNT(*) AS n FROM node_files').get() as { n: number };
    expect(remaining.n).toBe(0);
    expect(store.getSyncCursor(PROJECT, 'git')).toBeNull();
  });

  it('keeps sync cursors per project and source', () => {
    expect(store.getSyncCursor(PROJECT, 'git')).toBeNull();
    store.setSyncCursor(PROJECT, 'git', 'abc123');
    store.setSyncCursor(PROJECT, 'shell:pwsh', 'line-42');
    store.setSyncCursor('proj-b', 'git', 'def456');

    expect(store.getSyncCursor(PROJECT, 'git')).toBe('abc123');
    expect(store.getSyncCursor(PROJECT, 'shell:pwsh')).toBe('line-42');
    expect(store.getSyncCursor('proj-b', 'git')).toBe('def456');
  });

  it('isolates stats between projects', () => {
    store.upsertNodes([node({ id: 'a' }), node({ id: 'b', projectId: 'proj-b' })]);
    expect(store.stats(PROJECT).total).toBe(1);
    expect(store.stats('proj-b').total).toBe(1);
  });
});

describe('MemoryStore.search', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
    store.upsertNodes([
      node({
        id: 'wal',
        title: 'fix(store): close the WAL handle on Windows',
        body: 'fix(store): close the WAL handle on Windows\n\nSQLite kept the file locked.\n\nFiles changed:\n  src/store/db.ts (+12/-3)',
      }),
      node({
        id: 'auth',
        title: 'feat(auth): add refresh tokens',
        body: 'feat(auth): add refresh tokens\n\nFiles changed:\n  src/auth/token.ts (+80/-0)',
      }),
      node({
        id: 'chore',
        title: 'chore: bump deps',
        body: 'chore: bump deps\n\nFiles changed:\n  package.json (+4/-4)',
      }),
    ]);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds nodes by a word in the body', () => {
    const hits = store.search(PROJECT, 'sqlite locked');
    expect(hits.map((h) => h.id)).toContain('wal');
  });

  it('finds nodes by file path', () => {
    const hits = store.search(PROJECT, 'token.ts');
    expect(hits[0]?.id).toBe('auth');
  });

  it('ranks a title match above a body-only match', () => {
    const hits = store.search(PROJECT, 'store');
    // 'store' appears in the title of `wal` and only in a file path elsewhere.
    expect(hits[0]?.id).toBe('wal');
  });

  it('does not leak nodes across projects', () => {
    expect(store.search('proj-b', 'WAL')).toHaveLength(0);
  });

  it('survives FTS5 syntax in user input instead of throwing', () => {
    for (const q of ['"unterminated', 'a OR', 'NEAR(', '*', 'src/store/db.ts', "it's broken -- why?"]) {
      expect(() => store.search(PROJECT, q)).not.toThrow();
    }
  });

  it('reflects updates in the index', () => {
    store.upsertNodes([node({ id: 'wal', title: 'fix(store): totally rewritten', body: 'kangaroo' })]);
    expect(store.search(PROJECT, 'kangaroo').map((h) => h.id)).toEqual(['wal']);
    expect(store.search(PROJECT, 'locked')).toHaveLength(0);
  });

  it('drops a deleted node from the index', () => {
    store.clearProject(PROJECT);
    expect(store.search(PROJECT, 'WAL')).toHaveLength(0);
  });
});

describe('toMatchQuery', () => {
  it('quotes tokens and adds prefix matching', () => {
    expect(toMatchQuery('refresh token')).toBe('"refresh"* OR "token"*');
  });

  it('strips FTS5 operators out of user text', () => {
    expect(toMatchQuery('NEAR("a" b)')).toBe('"NEAR"* OR "a"* OR "b"*');
  });

  it('returns null when nothing searchable is left', () => {
    expect(toMatchQuery('   ')).toBeNull();
    expect(toMatchQuery('*(){}')).toBeNull();
  });
});
