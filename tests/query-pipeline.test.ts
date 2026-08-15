import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RESOLVED_BY_DISCUSSION, RESOLVED_BY_RETRY } from '../src/correlate/failure-fix.js';
import type { MemoryNode } from '../src/core/types.js';
import { runHybridQuery } from '../src/retrieval/query-pipeline.js';
import { MemoryStore } from '../src/store/store.js';

/**
 * Phase 7's chain feature, packing side: a shell_command failure's
 * RESOLVED_BY_RETRY resolution should ride along in the packed result even
 * when the resolution's own text has nothing to do with the query -- that is
 * the entire point (see the doc comment above `pullLinkedResolutions` in
 * `src/retrieval/query-pipeline.ts`). RESOLVED_BY_DISCUSSION must NOT be
 * pulled in, per the dogfooding finding that heuristic isn't trusted yet.
 */

const PROJECT = 'proj-a';

function node(overrides: Partial<MemoryNode> & Pick<MemoryNode, 'id'>): MemoryNode {
  return {
    kind: 'note',
    projectId: PROJECT,
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

describe('runHybridQuery -- pulling in a failure\'s linked resolution', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-query-pipeline-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('includes a RESOLVED_BY_RETRY resolution in the packed result even though its own text does not match the query', async () => {
    store.upsertNodes([
      node({ id: 'fail', kind: 'shell_command', title: 'npm publish failed', body: 'npm publish failed with an OTP error' }),
      node({ id: 'fix', kind: 'shell_command', title: 'unrelated text', body: 'this body shares no words with the query at all' }),
    ]);
    store.linkNodes('fail', 'fix', RESOLVED_BY_RETRY);

    const result = await runHybridQuery(store, PROJECT, 'npm publish OTP', { budget: 2000, candidates: 30 });

    const ids = result.packed.nodes.map((n) => n.id);
    expect(ids).toContain('fail');
    expect(ids).toContain('fix'); // discriminating: "fix" cannot win on relevance alone
  });

  it('does not duplicate a resolution that already matched the query on its own merits', async () => {
    store.upsertNodes([
      node({ id: 'fail', kind: 'shell_command', title: 'npm publish failed', body: 'npm publish failed with an OTP error' }),
      node({ id: 'fix', kind: 'shell_command', title: 'npm publish OTP retry', body: 'npm publish OTP retry succeeded' }),
    ]);
    store.linkNodes('fail', 'fix', RESOLVED_BY_RETRY);

    const result = await runHybridQuery(store, PROJECT, 'npm publish OTP', { budget: 2000, candidates: 30 });

    expect(result.packed.nodes.filter((n) => n.id === 'fix')).toHaveLength(1);
  });

  it('does not pull in a RESOLVED_BY_DISCUSSION link -- only the retry heuristic is trusted for packing', async () => {
    store.upsertNodes([
      node({ id: 'fail', kind: 'shell_command', title: 'npm publish failed', body: 'npm publish failed with an OTP error' }),
      node({ id: 'discussion', kind: 'conversation_turn', title: 'unrelated text', body: 'this body shares no words with the query at all' }),
    ]);
    store.linkNodes('fail', 'discussion', RESOLVED_BY_DISCUSSION);

    const result = await runHybridQuery(store, PROJECT, 'npm publish OTP', { budget: 2000, candidates: 30 });

    expect(result.packed.nodes.map((n) => n.id)).not.toContain('discussion');
  });

  it('a failure with no link pulls in nothing extra', async () => {
    store.upsertNodes([node({ id: 'fail', kind: 'shell_command', title: 'npm publish failed', body: 'npm publish failed with an OTP error' })]);

    const result = await runHybridQuery(store, PROJECT, 'npm publish OTP', { budget: 2000, candidates: 30 });

    expect(result.packed.nodes.map((n) => n.id)).toEqual(['fail']);
  });

  it('a pulled-in resolution inherits its failure\'s score rather than computing its own', async () => {
    store.upsertNodes([
      node({ id: 'fail', kind: 'shell_command', title: 'npm publish failed', body: 'npm publish failed with an OTP error' }),
      node({ id: 'fix', kind: 'shell_command', title: 'unrelated text', body: 'this body shares no words with the query at all' }),
    ]);
    store.linkNodes('fail', 'fix', RESOLVED_BY_RETRY);

    const result = await runHybridQuery(store, PROJECT, 'npm publish OTP', { budget: 2000, candidates: 30 });

    const fail = result.packed.nodes.find((n) => n.id === 'fail')!;
    const fix = result.packed.nodes.find((n) => n.id === 'fix')!;
    expect(fix.score).toBe(fail.score);
  });
});
