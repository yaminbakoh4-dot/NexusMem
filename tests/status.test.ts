import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/cli/commands/init.js';
import { runStatus } from '../src/cli/commands/status.js';
import { resolveWorkspace } from '../src/config/workspace.js';
import { makeNodeId } from '../src/core/ids.js';
import { makeProjectId } from '../src/core/project.js';
import type { MemoryNode } from '../src/core/types.js';
import { MemoryStore } from '../src/store/store.js';
import { gitFixture } from './helpers.js';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

const REMOTE = 'https://example.com/acme/status.git';

function initGitRepo(dir: string): void {
  const git = (...args: string[]) => gitFixture(dir, args, { env: GIT_ENV });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  git('add', '.');
  git('commit', '-q', '-m', 'chore: initial commit');
  git('remote', 'add', 'origin', REMOTE);
}

function node(projectId: string, key: string): MemoryNode {
  return {
    id: makeNodeId(projectId, 'shell_command', key),
    kind: 'shell_command',
    projectId,
    ts: '2026-01-01T00:00:00Z',
    source: 'shell:pwsh',
    title: `$ echo ${key}`,
    body: `$ echo ${key}`,
    files: [],
    signal: 0.2,
    meta: {},
  };
}

describe('status stale project identities', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-status-'));
    initGitRepo(dir);
    await runInit({ cwd: dir, force: false, hook: false, enableConversation: false, out: () => {} });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function statusOutput(): Promise<string> {
    const chunks: string[] = [];
    await runStatus({ cwd: dir, out: (chunk) => chunks.push(chunk) });
    return chunks.join('');
  }

  it('prints nothing extra when the database has no other project identity', async () => {
    expect(await statusOutput()).not.toContain('prior project');
  });

  it('reports the identity and node counts with a cleanup hint', async () => {
    const ws = resolveWorkspace(dir);
    const staleProjectId = makeProjectId({
      root: dir,
      originUrl: 'https://example.com/acme/status-renamed-from.git',
    });
    const store = MemoryStore.open(ws.dbPath);
    try {
      store.upsertProject({
        id: staleProjectId,
        root: dir,
        originUrl: 'https://example.com/acme/status-renamed-from.git',
      });
      store.upsertNodes([node(staleProjectId, 'one'), node(staleProjectId, 'two')]);
    } finally {
      store.close();
    }

    const output = await statusOutput();
    expect(output).toContain('1 prior project identity holds 2 node(s)');
    expect(output).toContain('nexusmem sync --prune-source <name>');
  });
});
