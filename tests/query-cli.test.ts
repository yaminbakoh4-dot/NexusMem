import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runQuery } from '../src/cli/commands/query.js';
import { gitFixture } from './helpers.js';
import { MemoryStore } from '../src/store/store.js';
import { resolveWorkspace } from '../src/config/workspace.js';
import { runInit } from '../src/cli/commands/init.js';
import type { MemoryNode } from '../src/core/types.js';

/**
 * `nexusmem query` (`runQuery`) had zero test coverage. `--no-vector` is used
 * throughout so this never needs a live Ollama for embeddings. The
 * `--all-projects` path is deliberately not covered here -- its merge/scoping
 * behavior is already covered by tests/cross-project.test.ts; the only thing
 * unique to runQuery on top of that is a couple of stderr lines.
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

function node(overrides: Partial<MemoryNode> & Pick<MemoryNode, 'id' | 'projectId'>): MemoryNode {
  return {
    kind: 'note',
    ts: '2026-08-01T00:00:00Z',
    source: 'test',
    title: 'untitled',
    body: 'untitled',
    files: [],
    signal: 0.5,
    meta: {},
    ...overrides,
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nexusmem-query-cli-'));
  gitFixture(dir, ['init', '-q', '-b', 'main'], { env: GIT_ENV });
  await runInit({ cwd: dir, force: false, hook: false, enableConversation: false, out: () => {} });

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

function seedNode(overrides: Partial<MemoryNode> & Pick<MemoryNode, 'id'>): void {
  const ws = resolveWorkspace(dir);
  const store = MemoryStore.open(ws.dbPath);
  try {
    // projectId doesn't matter for this fixture beyond "some real value" --
    // runQuery derives its own from the repo, and upsertNodes doesn't
    // validate it against the caller's.
    const projects = store.raw.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string } | undefined;
    store.upsertNodes([node({ projectId: projects!.id, ...overrides })]);
  } finally {
    store.close();
  }
}

describe('nexusmem query', () => {
  it('reports no matches for a query that matches nothing', async () => {
    const code = await runQuery({ cwd: dir, query: 'nonexistent xyz123', budget: 2000, candidates: 30, noVector: true, json: false });

    expect(code).toBe(0);
    expect(stderr.join('')).toContain('no matches');
  });

  it('packs a real matching node and prints the matched/tokens summary plus the context block', async () => {
    seedNode({ id: 'n1', title: 'why does the ranker cap joint priors', body: 'because bounding each prior separately let the pair overturn 4x' });

    const code = await runQuery({ cwd: dir, query: 'ranker cap joint priors', budget: 2000, candidates: 30, noVector: true, json: false });

    expect(code).toBe(0);
    expect(stderr.join('')).toMatch(/matched \d+ bm25/);
    expect(stderr.join('')).toMatch(/tokens\s+\d+\/2000/);
    expect(stdout.join('')).toContain('why does the ranker cap joint priors');
  });

  it('--json emits matched/packed/token counts and the packed node list', async () => {
    seedNode({ id: 'n1', title: 'why does the ranker cap joint priors', body: 'because bounding each prior separately let the pair overturn 4x' });

    const code = await runQuery({ cwd: dir, query: 'ranker cap joint priors', budget: 2000, candidates: 30, noVector: true, json: true });

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    const result = JSON.parse(stdout.join(''));
    expect(result.query).toBe('ranker cap joint priors');
    expect(result.matched).toBeGreaterThan(0);
    expect(Array.isArray(result.packed)).toBe(true);
    expect(result.packed.some((n: { id: string }) => n.id === 'n1')).toBe(true);
  });
});
