import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadContext } from '../src/cli/context.js';
import { runInit } from '../src/cli/commands/init.js';
import { makeProjectId } from '../src/core/project.js';
import { gitFixture } from './helpers.js';

/**
 * `loadContext` (the shared repo/workspace/config resolver every CLI command
 * calls first) only ever had indirect coverage, as a pass-through inside
 * other commands' tests. This pins its own contract directly: the project id
 * is recomputed from the repo, not trusted from anything persisted, so a
 * changed origin can never silently keep the old id.
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
  dir = mkdtempSync(join(tmpdir(), 'nexusmem-context-'));
  const git = (...args: string[]) => gitFixture(dir, args, { env: GIT_ENV });
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'https://example.com/acme/context.git');
});

async function init(): Promise<void> {
  await runInit({ cwd: dir, force: false, hook: false, enableConversation: false, out: () => {} });
}

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadContext', () => {
  it('resolves repo, workspace and config, deriving projectId from the repo rather than trusting config', async () => {
    await init();
    const ctx = await loadContext(dir);

    expect(ctx.repo.root).toBeDefined();
    expect(ctx.repo.originUrl).toBe('https://example.com/acme/context.git');
    expect(ctx.projectId).toBe(makeProjectId({ root: ctx.repo.root, originUrl: ctx.repo.originUrl }));
    expect(ctx.ws.dbPath).toContain('.nexusmem');
    expect(ctx.config.sources).toBeDefined();
  });

  it('recomputes projectId (not cached) when the origin changes between calls', async () => {
    await init();
    const before = await loadContext(dir);

    gitFixture(dir, ['remote', 'set-url', 'origin', 'https://example.com/acme/context-renamed.git'], { env: GIT_ENV });
    const after = await loadContext(dir);

    expect(after.projectId).not.toBe(before.projectId);
    expect(after.projectId).toBe(makeProjectId({ root: after.repo.root, originUrl: 'https://example.com/acme/context-renamed.git' }));
  });
});
