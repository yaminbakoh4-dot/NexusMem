import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { correlateFailures, RESOLVED_BY } from '../src/correlate/failure-fix.js';
import type { MemoryNode } from '../src/core/types.js';
import { MemoryStore } from '../src/store/store.js';

/**
 * Phase 7's first correlation pass: link a failed shell_command to whatever
 * later resolved it. Both heuristics are new and unvalidated against real
 * data (see the module's own doc comment) -- these tests pin the narrow,
 * deliberately conservative behavior as built, not a claim that the
 * heuristics are the right ones.
 */

const PROJECT = 'proj-a';
const T0 = Date.parse('2026-01-01T00:00:00Z');
const HOUR = 60 * 60 * 1000;

function shellNode(id: string, opts: { ts: number; command: string; exitCode: number; cwd?: string }): MemoryNode {
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
    meta: { command: opts.command, cwd: opts.cwd ?? '/repo', exitCode: opts.exitCode, durationMs: 100, tsApprox: false },
  };
}

function conversationNode(id: string, opts: { ts: number; body: string }): MemoryNode {
  return {
    id,
    kind: 'conversation_turn',
    projectId: PROJECT,
    ts: new Date(opts.ts).toISOString(),
    source: 'conversation:claude-code',
    title: 'a conversation turn',
    body: opts.body,
    files: [],
    signal: 0.5,
    meta: {},
  };
}

describe('correlateFailures', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-correlate-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('links a failure to a later successful retry of the exact same command in the same cwd', () => {
    store.upsertNodes([
      shellNode('fail', { ts: T0, command: 'npm test', exitCode: 1 }),
      shellNode('retry', { ts: T0 + HOUR, command: 'npm test', exitCode: 0 }),
    ]);

    const stats = correlateFailures(store, PROJECT);

    expect(stats).toEqual({ failuresExamined: 1, linkedByRetry: 1, linkedByDiscussion: 0 });
    expect(store.getLinkedNodeIds('fail', RESOLVED_BY)).toEqual(['retry']);
  });

  it('does not link a retry outside the configured retry window', () => {
    store.upsertNodes([
      shellNode('fail', { ts: T0, command: 'npm test', exitCode: 1 }),
      shellNode('retry', { ts: T0 + 3 * HOUR, command: 'npm test', exitCode: 0 }),
    ]);

    const stats = correlateFailures(store, PROJECT, { retryWindowMs: HOUR }); // discriminating: window shorter than the gap

    expect(stats.linkedByRetry).toBe(0);
    expect(store.getLinkedNodeIds('fail', RESOLVED_BY)).toEqual([]);
  });

  it('does not link a successful retry run in a different working directory', () => {
    store.upsertNodes([
      shellNode('fail', { ts: T0, command: 'npm test', exitCode: 1, cwd: '/repo-a' }),
      shellNode('retry', { ts: T0 + HOUR, command: 'npm test', exitCode: 0, cwd: '/repo-b' }),
    ]);

    correlateFailures(store, PROJECT);

    expect(store.getLinkedNodeIds('fail', RESOLVED_BY)).toEqual([]); // discriminating: same command, wrong cwd
  });

  it('does not link a textually different command, even a near-duplicate (exact match only, by design)', () => {
    store.upsertNodes([
      shellNode('fail', { ts: T0, command: 'npm test', exitCode: 1 }),
      shellNode('retry', { ts: T0 + HOUR, command: 'npm test -- --watch', exitCode: 0 }),
    ]);

    correlateFailures(store, PROJECT);

    expect(store.getLinkedNodeIds('fail', RESOLVED_BY)).toEqual([]);
  });

  it('links a failure to a later conversation that discusses it', () => {
    store.upsertNodes([
      shellNode('fail', { ts: T0, command: 'npm run typecheck', exitCode: 2 }),
      conversationNode('discussion', { ts: T0 + HOUR, body: 'Q: why does npm run typecheck fail\n\nA: a stray import' }),
    ]);

    const stats = correlateFailures(store, PROJECT);

    expect(stats.linkedByDiscussion).toBe(1);
    expect(store.getLinkedNodeIds('fail', RESOLVED_BY)).toEqual(['discussion']);
  });

  it('does not link a discussion outside the configured discussion window', () => {
    store.upsertNodes([
      shellNode('fail', { ts: T0, command: 'npm run typecheck', exitCode: 2 }),
      conversationNode('discussion', { ts: T0 + 3 * HOUR, body: 'Q: why does npm run typecheck fail\n\nA: a stray import' }),
    ]);

    correlateFailures(store, PROJECT, { discussionWindowMs: HOUR });

    expect(store.getLinkedNodeIds('fail', RESOLVED_BY)).toEqual([]);
  });

  it('a failure can be linked by both heuristics at once, as two separate edges', () => {
    store.upsertNodes([
      shellNode('fail', { ts: T0, command: 'npm test', exitCode: 1 }),
      shellNode('retry', { ts: T0 + HOUR, command: 'npm test', exitCode: 0 }),
      conversationNode('discussion', { ts: T0 + 2 * HOUR, body: 'Q: npm test is failing\n\nA: found it' }),
    ]);

    correlateFailures(store, PROJECT);

    expect(new Set(store.getLinkedNodeIds('fail', RESOLVED_BY))).toEqual(new Set(['retry', 'discussion']));
  });

  it('a node with a passing exit code is never treated as a failure to correlate', () => {
    store.upsertNodes([
      shellNode('pass', { ts: T0, command: 'npm test', exitCode: 0 }),
      shellNode('retry', { ts: T0 + HOUR, command: 'npm test', exitCode: 0 }),
    ]);

    const stats = correlateFailures(store, PROJECT);

    expect(stats.failuresExamined).toBe(0); // discriminating: exitCode 0 must never be scanned as a failure
  });

  it('is safe to run twice: re-running does not error or duplicate the link', () => {
    store.upsertNodes([
      shellNode('fail', { ts: T0, command: 'npm test', exitCode: 1 }),
      shellNode('retry', { ts: T0 + HOUR, command: 'npm test', exitCode: 0 }),
    ]);

    correlateFailures(store, PROJECT);
    correlateFailures(store, PROJECT);

    expect(store.getLinkedNodeIds('fail', RESOLVED_BY)).toEqual(['retry']);
  });
});
