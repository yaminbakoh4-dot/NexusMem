import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/cli/commands/init.js';
import { runSync } from '../src/cli/commands/sync.js';
import { resolveWorkspace } from '../src/config/workspace.js';
import { makeNodeId } from '../src/core/ids.js';
import { makeProjectId } from '../src/core/project.js';
import { MemoryStore } from '../src/store/store.js';
import { gitFixture } from './helpers.js';

/**
 * End-to-end coverage for the project-id reconciliation wired into `runSync`
 * (`tests/reconcile.test.ts` covers `reconcileProjectId` itself in
 * isolation). What only an integration test can catch is *ordering* within
 * `runSync` -- specifically, whether a real GitHub-style remote rename
 * survives a `sync --rebuild` run, since `--rebuild` clears the current
 * project id's nodes and reconciliation also writes under that id.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

function initGitRepo(dir: string, remote: string): void {
  const g = (...args: string[]) => gitFixture(dir, args, { env: GIT_ENV });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  g('add', '.');
  g('commit', '-q', '-m', 'chore: initial commit');
  g('remote', 'add', 'origin', remote);
}

const BEFORE_REMOTE = 'https://example.com/acme/before.git';
const AFTER_REMOTE = 'https://example.com/acme/after.git';

describe('runSync reconciliation, real repo fixture', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-sync-reconcile-'));
    initGitRepo(dir, BEFORE_REMOTE);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a plain sync after a remote rename migrates stranded content forward', async () => {
    await runInit({ cwd: dir, force: false, hook: false, enableConversation: false, out: () => {} });
    await runSync({ cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true });

    const oldProjectId = makeProjectId({ root: dir, originUrl: BEFORE_REMOTE });
    const ws = resolveWorkspace(dir);

    const store = MemoryStore.open(ws.dbPath);
    store.upsertNodes([
      {
        id: makeNodeId(oldProjectId, 'conversation_turn', 'claude-code:stranded-uuid:0'),
        kind: 'conversation_turn',
        projectId: oldProjectId,
        ts: '2026-01-01T00:00:00Z',
        source: 'conversation:claude-code',
        title: 'a stranded turn',
        body: 'irreplaceable content',
        files: [],
        signal: 0.5,
        meta: {},
      },
    ]);
    store.close();

    gitFixture(dir, ['remote', 'set-url', 'origin', AFTER_REMOTE], { env: GIT_ENV });

    await runSync({ cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true });

    const newProjectId = makeProjectId({ root: dir, originUrl: AFTER_REMOTE });
    const after = MemoryStore.open(ws.dbPath);
    try {
      expect(after.stats(newProjectId).byKind.conversation_turn ?? 0).toBe(1);
    } finally {
      after.close();
    }
  });

  it('sync --rebuild after a remote rename does NOT silently discard what reconciliation just recovered', async () => {
    await runInit({ cwd: dir, force: false, hook: false, enableConversation: false, out: () => {} });
    await runSync({ cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true });

    const oldProjectId = makeProjectId({ root: dir, originUrl: BEFORE_REMOTE });
    const ws = resolveWorkspace(dir);

    const store = MemoryStore.open(ws.dbPath);
    store.upsertNodes([
      {
        id: makeNodeId(oldProjectId, 'conversation_turn', 'claude-code:stranded-uuid:0'),
        kind: 'conversation_turn',
        projectId: oldProjectId,
        ts: '2026-01-01T00:00:00Z',
        source: 'conversation:claude-code',
        title: 'a stranded turn',
        body: 'irreplaceable content',
        files: [],
        signal: 0.5,
        meta: {},
      },
    ]);
    store.close();

    gitFixture(dir, ['remote', 'set-url', 'origin', AFTER_REMOTE], { env: GIT_ENV });

    // The combination that matters: the FIRST sync to see the renamed
    // remote is also a --rebuild. Reconciliation and the rebuild's own
    // "clear this project id's nodes" step both touch the same id.
    await runSync({ cwd: dir, full: false, rebuild: true, quiet: true, noEmbed: true });

    const newProjectId = makeProjectId({ root: dir, originUrl: AFTER_REMOTE });
    const after = MemoryStore.open(ws.dbPath);
    try {
      expect(after.stats(newProjectId).byKind.conversation_turn ?? 0).toBe(1);
    } finally {
      after.close();
    }
  });
});
