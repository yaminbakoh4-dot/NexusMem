import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/cli/commands/init.js';
import { runMarkStale } from '../src/cli/commands/mark-stale.js';
import { runSync } from '../src/cli/commands/sync.js';
import { readConfig, resolveWorkspace, writeConfig } from '../src/config/workspace.js';
import { makeProjectId } from '../src/core/project.js';
import type { MemoryNode } from '../src/core/types.js';
import { runHybridQuery } from '../src/retrieval/query-pipeline.js';
import { MemoryStore } from '../src/store/store.js';
import { gitFixture } from './helpers.js';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

const REMOTE = 'https://example.com/acme/mark-stale.git';

function initGitRepo(dir: string): void {
  const g = (...args: string[]) => gitFixture(dir, args, { env: GIT_ENV });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  g('add', '.');
  g('commit', '-q', '-m', 'chore: initial commit');
  g('remote', 'add', 'origin', REMOTE);
}

function node(projectId: string, overrides: Partial<MemoryNode> & Pick<MemoryNode, 'id'>): MemoryNode {
  return {
    kind: 'doc_section',
    projectId,
    ts: '2026-01-01T00:00:00Z',
    source: 'docs',
    title: 'untitled',
    body: 'untitled',
    files: [],
    signal: 0.5,
    meta: {},
    ...overrides,
  };
}

describe('nexusmem mark-stale', () => {
  let dir: string;
  let projectId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-mark-stale-'));
    initGitRepo(dir);
    await runInit({ cwd: dir, force: false, hook: false, enableConversation: false, out: () => {} });

    const ws = resolveWorkspace(dir);
    const cfg = await readConfig(ws);
    await writeConfig(ws, { ...cfg, sources: { ...cfg.sources, shell: { ...cfg.sources.shell, enabled: false } } });
    await runSync({ cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true });
    projectId = makeProjectId({ root: dir, originUrl: REMOTE });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(nodes: MemoryNode[]): void {
    const ws = resolveWorkspace(dir);
    const store = MemoryStore.open(ws.dbPath);
    store.upsertNodes(nodes);
    store.close();
  }

  it('writes supersedes on the new node, pointing at the stale one -- the old node is untouched otherwise', async () => {
    seed([node(projectId, { id: 'old', title: 'old conclusion' }), node(projectId, { id: 'new', title: 'new conclusion' })]);

    const chunks: string[] = [];
    const code = await runMarkStale({ cwd: dir, nodeId: 'old', supersedesId: 'new', out: (c) => chunks.push(c) });

    expect(code).toBe(0);
    expect(chunks.join('')).toMatch(/marked stale/);

    const ws = resolveWorkspace(dir);
    const store = MemoryStore.open(ws.dbPath);
    try {
      const row = store.raw.prepare('SELECT supersedes FROM nodes WHERE id = ?').get('new') as { supersedes: string | null };
      expect(row.supersedes).toBe('old');
      const oldRow = store.raw.prepare('SELECT supersedes FROM nodes WHERE id = ?').get('old') as { supersedes: string | null };
      expect(oldRow.supersedes).toBeNull(); // the stale node itself is never rewritten
    } finally {
      store.close();
    }
  });

  it('down-weights the stale node relative to its replacement in an actual query', async () => {
    seed([
      node(projectId, { id: 'old', title: 'deploy process', body: 'deploy process: run the old script' }),
      node(projectId, { id: 'new', title: 'deploy process', body: 'deploy process: run the new script' }),
    ]);
    await runMarkStale({ cwd: dir, nodeId: 'old', supersedesId: 'new', out: () => {} });

    const ws = resolveWorkspace(dir);
    const store = MemoryStore.open(ws.dbPath);
    try {
      const result = await runHybridQuery(store, projectId, 'deploy process', { budget: 2000, candidates: 30 });
      const oldNode = result.packed.nodes.find((n) => n.id === 'old');
      const newNode = result.packed.nodes.find((n) => n.id === 'new');
      expect(oldNode).toBeDefined();
      expect(newNode).toBeDefined();
      expect(newNode!.score).toBeGreaterThan(oldNode!.score);
    } finally {
      store.close();
    }
  });

  it('rejects a node id that does not exist', async () => {
    seed([node(projectId, { id: 'new' })]);
    await expect(runMarkStale({ cwd: dir, nodeId: 'does-not-exist', supersedesId: 'new', out: () => {} })).rejects.toThrow(
      /no node found/,
    );
  });

  it('rejects a supersedesId that does not exist', async () => {
    seed([node(projectId, { id: 'old' })]);
    await expect(runMarkStale({ cwd: dir, nodeId: 'old', supersedesId: 'does-not-exist', out: () => {} })).rejects.toThrow(
      /no node found/,
    );
  });

  it('rejects a node superseding itself', async () => {
    seed([node(projectId, { id: 'solo' })]);
    await expect(runMarkStale({ cwd: dir, nodeId: 'solo', supersedesId: 'solo', out: () => {} })).rejects.toThrow(
      /cannot supersede itself/,
    );
  });

  it('rejects linking a node that belongs to a different project', async () => {
    seed([node(projectId, { id: 'mine' }), node('some-other-project', { id: 'theirs' })]);
    await expect(runMarkStale({ cwd: dir, nodeId: 'mine', supersedesId: 'theirs', out: () => {} })).rejects.toThrow(
      /current project/,
    );
  });
});
