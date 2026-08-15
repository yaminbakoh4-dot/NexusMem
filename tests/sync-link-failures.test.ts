import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/cli/commands/init.js';
import { runSync } from '../src/cli/commands/sync.js';
import { RESOLVED_BY_RETRY } from '../src/correlate/failure-fix.js';
import { readConfig, resolveWorkspace, writeConfig } from '../src/config/workspace.js';
import { makeNodeId } from '../src/core/ids.js';
import { makeProjectId } from '../src/core/project.js';
import type { MemoryNode } from '../src/core/types.js';
import { MemoryStore } from '../src/store/store.js';
import { gitFixture } from './helpers.js';

/**
 * End-to-end coverage for `sync --link-failures`, wired as an opt-in extra
 * step after the normal ingest pipeline (see the comment above its call site
 * in `src/cli/commands/sync.ts`). `tests/correlate.test.ts` covers the
 * heuristics themselves; this is only the CLI wiring: off by default, runs
 * after ingest rather than replacing it (unlike `--prune-source`, which is
 * a standalone action), and reports its stats in the summary.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

const REMOTE = 'https://example.com/acme/link-failures.git';
const HOUR = 60 * 60 * 1000;

function initGitRepo(dir: string): void {
  const g = (...args: string[]) => gitFixture(dir, args, { env: GIT_ENV });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  g('add', '.');
  g('commit', '-q', '-m', 'chore: initial commit');
  g('remote', 'add', 'origin', REMOTE);
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

function shellNode(projectId: string, id: string, opts: { ts: number; command: string; exitCode: number }): MemoryNode {
  return {
    id: makeNodeId(projectId, 'shell_command', id),
    kind: 'shell_command',
    projectId,
    ts: new Date(opts.ts).toISOString(),
    source: 'shell:pwsh-hook',
    title: `$ ${opts.command}`,
    body: `$ ${opts.command}`,
    files: [],
    signal: 0.3,
    meta: { command: opts.command, cwd: '/repo', exitCode: opts.exitCode, durationMs: 100, tsApprox: false },
  };
}

describe('sync --link-failures', () => {
  let dir: string;
  let projectId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-link-failures-'));
    initGitRepo(dir);
    await runInit({ cwd: dir, force: false, hook: false, enableConversation: false, out: () => {} });

    // Same trick as tests/prune-source.test.ts: no hook is installed for
    // this throwaway repo, so a real shell sync would scrape this machine's
    // actual PSReadLine history instead of the fixture nodes seeded below.
    const ws = resolveWorkspace(dir);
    const config = await readConfig(ws);
    await writeConfig(ws, { ...config, sources: { ...config.sources, shell: { ...config.sources.shell, enabled: false } } });

    await runSync({ cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true });
    projectId = makeProjectId({ root: dir, originUrl: REMOTE });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is off by default: a plain sync does not run correlation', async () => {
    const ws = resolveWorkspace(dir);
    const store = MemoryStore.open(ws.dbPath);
    const t0 = Date.parse('2026-01-01T00:00:00Z');
    store.upsertNodes([
      shellNode(projectId, 'fail', { ts: t0, command: 'npm test', exitCode: 1 }),
      shellNode(projectId, 'retry', { ts: t0 + HOUR, command: 'npm test', exitCode: 0 }),
    ]);
    store.close();

    const chunks: string[] = [];
    await runSync({ cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true, out: (c) => chunks.push(c) });

    expect(stripAnsi(chunks.join(''))).not.toMatch(/chains:/);

    const after = MemoryStore.open(ws.dbPath);
    try {
      expect(after.getLinkedNodeIds(makeNodeId(projectId, 'shell_command', 'fail'), RESOLVED_BY_RETRY)).toEqual([]);
    } finally {
      after.close();
    }
  });

  it('--link-failures links a real failure/retry pair seeded before the run and reports it in the summary', async () => {
    const ws = resolveWorkspace(dir);
    const store = MemoryStore.open(ws.dbPath);
    const t0 = Date.parse('2026-01-01T00:00:00Z');
    const failId = makeNodeId(projectId, 'shell_command', 'fail');
    store.upsertNodes([
      shellNode(projectId, 'fail', { ts: t0, command: 'npm test', exitCode: 1 }),
      shellNode(projectId, 'retry', { ts: t0 + HOUR, command: 'npm test', exitCode: 0 }),
    ]);
    store.close();

    const chunks: string[] = [];
    const code = await runSync({
      cwd: dir,
      full: false,
      rebuild: false,
      quiet: true,
      noEmbed: true,
      linkFailures: true,
      out: (c) => chunks.push(c),
    });

    expect(code).toBe(0);
    expect(stripAnsi(chunks.join(''))).toMatch(/chains: 1 failure\(s\) examined, 1 linked by retry/);

    const after = MemoryStore.open(ws.dbPath);
    try {
      expect(after.getLinkedNodeIds(failId, RESOLVED_BY_RETRY)).toEqual([makeNodeId(projectId, 'shell_command', 'retry')]);
    } finally {
      after.close();
    }
  });
});
