import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assessFiles } from '../src/correlate/precheck.js';
import { RESOLVED_BY_RETRY } from '../src/correlate/failure-fix.js';
import type { FileTouch, MemoryNode } from '../src/core/types.js';
import { MemoryStore } from '../src/store/store.js';

/**
 * `assessFiles` is the building block behind `nexusmem precheck`. These tests
 * pin its two signals -- unresolved past failures matched by the target
 * file's own basename, and recent git-commit churn -- independently of the
 * CLI command that renders them.
 */

const PROJECT = 'proj-a';
const DAY = 24 * 60 * 60 * 1000;
// `assessFiles`'s recent-window is relative to real wall-clock time
// (Date.now()), unlike correlateFailures's windows which are relative to
// another node's own timestamp -- so fixtures anchor to "now", not a fixed
// historical date.
const T0 = Date.now() - 2 * DAY;

function shellNode(id: string, opts: { ts: number; command: string; exitCode: number }): MemoryNode {
  return {
    id,
    kind: 'shell_command',
    projectId: PROJECT,
    ts: new Date(opts.ts).toISOString(),
    source: 'shell:pwsh-hook',
    title: `$ ${opts.command}`,
    body: `$ ${opts.command}`,
    files: [],
    signal: 0.3,
    meta: { command: opts.command, cwd: '/repo', exitCode: opts.exitCode, durationMs: 100, tsApprox: false },
  };
}

function gitCommitNode(id: string, opts: { ts: number; files: string[] }): MemoryNode {
  const touches: FileTouch[] = opts.files.map((path) => ({ path, insertions: 1, deletions: 0, binary: false }));
  return {
    id,
    kind: 'git_commit',
    projectId: PROJECT,
    ts: new Date(opts.ts).toISOString(),
    source: 'git',
    title: 'fix: something',
    body: 'fix: something',
    files: touches,
    signal: 0.7,
    meta: {},
  };
}

describe('assessFiles', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-precheck-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('surfaces a recent, unresolved failure whose command names the file', () => {
    store.upsertNodes([shellNode('fail', { ts: T0, command: 'npm run precheck', exitCode: 1 })]);

    const [risk] = assessFiles(store, PROJECT, ['src/cli/commands/precheck.ts']);

    expect(risk!.unresolvedFailures).toHaveLength(1);
    expect(risk!.unresolvedFailures[0]).toMatchObject({ id: 'fail', command: 'npm run precheck' });
  });

  it('does not surface a failure that is already linked as resolved', () => {
    store.upsertNodes([
      shellNode('fail', { ts: T0, command: 'npm run precheck', exitCode: 1 }),
      shellNode('retry', { ts: T0 + DAY / 24, command: 'npm run precheck', exitCode: 0 }),
    ]);
    store.linkNodes('fail', 'retry', RESOLVED_BY_RETRY);

    const [risk] = assessFiles(store, PROJECT, ['src/cli/commands/precheck.ts']);

    expect(risk!.unresolvedFailures).toEqual([]);
  });

  it('does not surface a failure outside the recent window', () => {
    store.upsertNodes([shellNode('fail', { ts: T0, command: 'npm run precheck', exitCode: 1 })]);

    const [risk] = assessFiles(store, PROJECT, ['src/cli/commands/precheck.ts'], { recentDays: 1 });
    // T0 is 2 days before "now", outside a 1-day window.

    expect(risk!.unresolvedFailures).toEqual([]);
  });

  it('does not surface a failure whose command does not name the file at all', () => {
    store.upsertNodes([shellNode('fail', { ts: T0, command: 'npm run build', exitCode: 1 })]);

    const [risk] = assessFiles(store, PROJECT, ['src/cli/commands/precheck.ts']);

    expect(risk!.unresolvedFailures).toEqual([]);
  });

  it('counts recent git-commit touches as churn, without double-counting code_diff nodes', () => {
    store.upsertNodes([
      gitCommitNode('c1', { ts: T0, files: ['src/a.ts'] }),
      gitCommitNode('c2', { ts: T0 + DAY, files: ['src/a.ts', 'src/b.ts'] }),
      // A code_diff node touching the same file must not add to the count --
      // it records the same commit's touch a second time under a different kind.
      {
        id: 'd1',
        kind: 'code_diff',
        projectId: PROJECT,
        ts: new Date(T0).toISOString(),
        source: 'diff',
        title: 'diff',
        body: 'diff',
        files: [{ path: 'src/a.ts', insertions: 1, deletions: 0, binary: false }],
        signal: 0.5,
        meta: {},
      },
    ]);

    const [riskA, riskB] = assessFiles(store, PROJECT, ['src/a.ts', 'src/b.ts']);

    expect(riskA!.commitsRecent).toBe(2);
    expect(riskB!.commitsRecent).toBe(1);
  });
});
