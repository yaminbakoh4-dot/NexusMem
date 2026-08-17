import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runForget } from '../src/cli/commands/forget.js';
import { runInit } from '../src/cli/commands/init.js';
import { runSync } from '../src/cli/commands/sync.js';
import { readConfig, resolveWorkspace, writeConfig } from '../src/config/workspace.js';
import { makeNodeId } from '../src/core/ids.js';
import { makeProjectId } from '../src/core/project.js';
import { readRepoInfo } from '../src/git/repo.js';
import type { MemoryNode } from '../src/core/types.js';
import { appendHookLogEntry } from '../src/shell/hook-log.js';
import { hookLogPath } from '../src/shell/paths.js';
import { MemoryStore } from '../src/store/store.js';
import { gitFixture } from './helpers.js';

/**
 * End-to-end coverage for `nexusmem forget`, the value-keyed complement to
 * `sync --prune-source` (see `tests/prune-source.test.ts`, whose fixture
 * shape this follows). The last test here is the literal claim the feature
 * exists to rebut: an external review found that `pruneSourceNodes` never
 * touches the append-only shell-hook log, so a full `sync --rebuild`
 * resurrects exactly what was just deleted.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

const REMOTE = 'https://example.com/acme/forget.git';

function initGitRepo(dir: string): void {
  const g = (...args: string[]) => gitFixture(dir, args, { env: GIT_ENV });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  g('add', '.');
  g('commit', '-q', '-m', 'chore: initial commit');
  g('remote', 'add', 'origin', REMOTE);
}

// picocolors wraps individual words in escape codes, so a literal substring
// match against adjacent words fails even though they're adjacent on screen.
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function gitNode(projectId: string, key: string, body: string): MemoryNode {
  return {
    id: makeNodeId(projectId, 'git_commit', key),
    kind: 'git_commit',
    projectId,
    ts: '2026-01-01T00:00:00Z',
    source: 'git',
    title: body,
    body,
    files: [],
    signal: 0.3,
    meta: {},
  };
}

describe('nexusmem forget', () => {
  let dir: string;
  let projectId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-forget-'));
    initGitRepo(dir);
    await runInit({ cwd: dir, force: false, hook: false, enableConversation: false, out: () => {} });

    // Same reasoning as prune-source.test.ts: keep the fixture hermetic by
    // not picking up the real machine's shell history during setup. The
    // resurrection test below re-enables this deliberately.
    const ws = resolveWorkspace(dir);
    const config = await readConfig(ws);
    await writeConfig(ws, { ...config, sources: { ...config.sources, shell: { ...config.sources.shell, enabled: false } } });

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

  function nodeIds(): string[] {
    const ws = resolveWorkspace(dir);
    const store = MemoryStore.open(ws.dbPath);
    try {
      return store.listRecentNodes(projectId, 100).map((n) => n.id);
    } finally {
      store.close();
    }
  }

  it('without --yes, reports the matching count and deletes nothing', async () => {
    seed([
      gitNode(projectId, 'leak-1', 'export API_KEY=sk-secret-abc'),
      gitNode(projectId, 'control-1', 'unrelated commit'),
    ]);

    const chunks: string[] = [];
    const code = await runForget({ cwd: dir, value: 'sk-secret-abc', out: (c) => chunks.push(c) });

    expect(code).toBe(0);
    const summary = stripAnsi(chunks.join(''));
    expect(summary).toMatch(/would remove 1 node\(s\)/);
    expect(summary).toMatch(/--yes/);

    expect(nodeIds()).toHaveLength(4); // 2 seeded + the 2 the initial commit sync already produced (git_commit + code_diff)
  });

  it('with --yes, deletes exactly the matching node(s), leaves a control node untouched', async () => {
    seed([
      gitNode(projectId, 'leak-2', 'export API_KEY=sk-secret-def'),
      gitNode(projectId, 'control-2', 'unrelated commit'),
    ]);
    const before = nodeIds();
    const controlId = makeNodeId(projectId, 'git_commit', 'control-2');
    const leakId = makeNodeId(projectId, 'git_commit', 'leak-2');
    expect(before).toContain(leakId);

    const chunks: string[] = [];
    const code = await runForget({ cwd: dir, value: 'sk-secret-def', yes: true, out: (c) => chunks.push(c) });

    expect(code).toBe(0);
    expect(stripAnsi(chunks.join(''))).toMatch(/forgotten 1 node\(s\) deleted/);

    const after = nodeIds();
    expect(after).not.toContain(leakId);
    expect(after).toContain(controlId);

    const ws = resolveWorkspace(dir);
    const store = MemoryStore.open(ws.dbPath);
    try {
      const denyCount = (store.raw.prepare('SELECT COUNT(*) AS c FROM deny_list WHERE project_id = ?').get(projectId) as { c: number }).c;
      const tombstoneCount = (
        store.raw.prepare('SELECT COUNT(*) AS c FROM tombstones WHERE project_id = ?').get(projectId) as { c: number }
      ).c;
      expect(denyCount).toBe(1);
      expect(tombstoneCount).toBe(1);
    } finally {
      store.close();
    }
  });

  it('--list shows the entry just created', async () => {
    await runForget({ cwd: dir, value: 'sk-secret-list-me', yes: true, reason: 'unit test', out: () => {} });

    const chunks: string[] = [];
    const code = await runForget({ cwd: dir, list: true, out: (c) => chunks.push(c) });

    expect(code).toBe(0);
    const summary = stripAnsi(chunks.join(''));
    expect(summary).toMatch(/sk-secret-list-me/);
    expect(summary).toMatch(/unit test/);
  });

  it(
    'the resurrection bug is fixed: a forgotten value does not come back after sync --rebuild, ' +
      'while an unrelated command in the same log does',
    async () => {
      const ws = resolveWorkspace(dir);
      const config = await readConfig(ws);
      await writeConfig(ws, { ...config, sources: { ...config.sources, shell: { ...config.sources.shell, enabled: true } } });

      // isUnderRoot (shell/detect.ts) matches a hook entry's cwd against the
      // repo's resolved toplevel, not the raw fixture dir -- on this machine
      // os.tmpdir() returns an 8.3 short path (...\USER-0~1\...) while git
      // resolves the long form, so the two are different strings and only
      // the resolved root actually scopes into this repo.
      const repo = await readRepoInfo(dir);
      const secret = 'sk-secret-resurrection-test';
      await appendHookLogEntry(hookLogPath(), {
        ts: '2026-01-01T00:00:00.000Z',
        cwd: repo.root,
        exitCode: 0,
        durationMs: 12,
        command: `curl -H "Authorization: Bearer ${secret}"`,
      });
      await appendHookLogEntry(hookLogPath(), {
        ts: '2026-01-01T00:00:01.000Z',
        cwd: repo.root,
        exitCode: 0,
        durationMs: 5,
        command: 'echo control-command-should-survive',
      });

      const firstSync = await runSync({ cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true });
      expect(firstSync).toBe(0);

      const before = nodeIds();
      const beforeStore = MemoryStore.open(ws.dbPath);
      const beforeHits = beforeStore.search(projectId, secret, 10);
      beforeStore.close();
      expect(beforeHits.length).toBeGreaterThan(0); // confirms the secret was actually ingested before we try to forget it
      void before;

      const forgetResult = await runForget({ cwd: dir, value: secret, yes: true, out: () => {} });
      expect(forgetResult).toBe(0);

      // The scenario the review named: drop this project's nodes and re-read
      // the untouched, append-only hook log from line 0.
      const rebuildSync = await runSync({ cwd: dir, full: false, rebuild: true, quiet: true, noEmbed: true });
      expect(rebuildSync).toBe(0);

      const store = MemoryStore.open(ws.dbPath);
      try {
        expect(store.search(projectId, secret, 10)).toEqual([]); // discriminating: a broken deny-list would let this come back
        expect(store.search(projectId, 'control-command-should-survive', 10).length).toBeGreaterThan(0); // proves it's the deny-list, not a broken rebuild

        const denyCount = (store.raw.prepare('SELECT COUNT(*) AS c FROM deny_list WHERE project_id = ?').get(projectId) as { c: number })
          .c;
        const tombstoneCount = (
          store.raw.prepare('SELECT COUNT(*) AS c FROM tombstones WHERE project_id = ?').get(projectId) as { c: number }
        ).c;
        const auditCount = (
          store.raw.prepare('SELECT COUNT(*) AS c FROM mutation_audit WHERE project_id = ?').get(projectId) as { c: number }
        ).c;
        expect(denyCount).toBe(1); // discriminating: --rebuild must not wipe the deny-list along with the nodes
        expect(tombstoneCount).toBeGreaterThanOrEqual(1);
        expect(auditCount).toBe(1);
      } finally {
        store.close();
      }
    },
  );
});
