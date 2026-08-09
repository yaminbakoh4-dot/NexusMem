import { type spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git, GitError, GitSpawnError, gitStream } from '../src/git/exec.js';
import { NotAGitRepositoryError, readRepoInfo } from '../src/git/repo.js';
import { gitFixture } from './helpers.js';

/**
 * These cover the distinction the error types exist for: whether git ran at
 * all, and if it did, whether "not a repository" was actually its verdict.
 * Before the split, every one of these paths produced the same
 * `NotAGitRepositoryError`.
 */
describe('git failure classification', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-giterr-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a real non-repository directory as NotAGitRepositoryError', async () => {
    // A temp dir could sit under a repo on some machines; a bare `--show-toplevel`
    // would then walk up and succeed. Fencing stops the walk at `dir`.
    const prev = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = dir;
    try {
      await expect(readRepoInfo(dir)).rejects.toBeInstanceOf(NotAGitRepositoryError);
    } finally {
      if (prev === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = prev;
    }
  });

  it('does not claim "not a git repository" when the directory does not exist', async () => {
    const missing = join(dir, 'no', 'such', 'path');

    const err = await readRepoInfo(missing).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GitSpawnError);
    expect(err).not.toBeInstanceOf(NotAGitRepositoryError);
    expect((err as GitSpawnError).code).toBe('ENOENT');
    // Not retryable: a missing binary or missing cwd does not fix itself.
    expect((err as GitSpawnError).transient).toBe(false);
  });

  it('marks resource-pressure spawn failures transient and ENOENT not', () => {
    // Constructed directly: the Windows EPERM/EAGAIN race this classification
    // exists for cannot be provoked on demand, so assert the policy instead.
    const transient = new GitSpawnError('x', [], 'EAGAIN', true, null);
    expect(transient.transient).toBe(true);
    expect(new GitSpawnError('x', [], 'ENOENT', false, null).transient).toBe(false);
  });

  it('keeps git\'s own message for a failure that is not "not a repository"', async () => {
    gitFixture(dir, ['init', '-q']);
    // A config value git cannot parse: rev-parse fails, but the repo is real.
    gitFixture(dir, ['config', 'core.repositoryformatversion', 'bogus']);

    const err = await readRepoInfo(dir).catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(NotAGitRepositoryError);
    expect(err).toBeInstanceOf(GitError);
    // git's own first stderr line is carried into the message rather than discarded.
    expect((err as GitError).message).toMatch(/repository version|repositoryformatversion/i);
  });

  it('still resolves a healthy repository', async () => {
    const run = (...args: string[]) => gitFixture(dir, args);
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'Test');
    run('commit', '-q', '--allow-empty', '-m', 'init');

    const info = await readRepoInfo(dir);

    expect(info.branch).toBe('main');
    expect(info.head).toMatch(/^[0-9a-f]{40}$/);
    expect(info.originUrl).toBeNull(); // no remote configured
  });
});

/**
 * The Windows `uv_spawn` race these retries exist for cannot be provoked on
 * demand, so `spawn` is injected instead of waiting for the real thing. `sleep`
 * is injected too, both to keep the suite fast and to make the backoff schedule
 * itself assertable rather than merely "something waited".
 */
describe('transient spawn retry', () => {
  const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`spawn git ${code}`), { code });

  function stream(text: string): Readable {
    const r = new Readable({ read() {} });
    if (text) r.push(text);
    r.push(null);
    return r;
  }

  /** Minimal stand-in for the ChildProcess surface gitStream actually touches. */
  function child(outcome: { stdout?: string; stderr?: string; code?: number; error?: NodeJS.ErrnoException }) {
    const c = new EventEmitter() as EventEmitter & Record<string, unknown>;
    c.stdout = stream(outcome.stdout ?? '');
    c.stderr = stream(outcome.stderr ?? '');
    c.exitCode = null;
    c.kill = () => undefined;

    setImmediate(() => {
      if (outcome.error) {
        c.emit('error', outcome.error);
        return;
      }
      c.exitCode = outcome.code ?? 0;
      c.emit('close', outcome.code ?? 0);
    });

    return c;
  }

  /** Returns a spawn stub that plays `outcomes` in order, plus the call count and observed backoff. */
  function harness(outcomes: Array<Parameters<typeof child>[0]>) {
    const sleeps: number[] = [];
    let calls = 0;
    const spawn = (() => {
      const outcome = outcomes[Math.min(calls, outcomes.length - 1)]!;
      calls += 1;
      return child(outcome);
    }) as unknown as typeof nodeSpawn;

    return {
      sleeps,
      calls: () => calls,
      opts: { spawn, sleep: async (ms: number) => void sleeps.push(ms) },
    };
  }

  it('retries a transient spawn failure and returns the eventual output', async () => {
    const h = harness([{ error: errno('EAGAIN') }, { error: errno('EPERM') }, { stdout: 'refs/heads/main\n' }]);

    await expect(git('/repo', ['rev-parse', '--abbrev-ref', 'HEAD'], h.opts)).resolves.toBe('refs/heads/main\n');

    expect(h.calls()).toBe(3);
    expect(h.sleeps).toEqual([50, 150]); // backoff schedule, in order
  });

  it('gives up after the last delay and reports the real spawn error', async () => {
    const h = harness([{ error: errno('EAGAIN') }]);

    const err = await git('/repo', ['status'], h.opts).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GitSpawnError);
    expect((err as GitSpawnError).code).toBe('EAGAIN');
    expect(h.calls()).toBe(4); // one attempt plus three retries
    expect(h.sleeps).toEqual([50, 150, 400]);
  });

  it('does not retry ENOENT -- a missing binary or cwd does not fix itself', async () => {
    const h = harness([{ error: errno('ENOENT') }]);

    await expect(git('/repo', ['status'], h.opts)).rejects.toBeInstanceOf(GitSpawnError);

    expect(h.calls()).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  it('does not retry a non-zero exit -- that is git\'s own answer, not a failure to start', async () => {
    const h = harness([{ code: 128, stderr: 'fatal: not a git repository' }]);

    await expect(git('/repo', ['rev-parse'], h.opts)).rejects.toBeInstanceOf(GitError);

    expect(h.calls()).toBe(1);
  });

  it('does not retry once output has already reached the consumer', async () => {
    // Guards the streaming boundary: re-running here would replay chunks into a
    // parser that has already consumed them.
    const h = harness([{ stdout: 'commit 1\n', error: errno('EAGAIN') }]);
    const chunks: string[] = [];

    const err = await (async () => {
      try {
        for await (const chunk of gitStream('/repo', ['log'], h.opts)) chunks.push(chunk);
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(chunks).toEqual(['commit 1\n']);
    expect(err).toBeInstanceOf(GitSpawnError);
    expect(h.calls()).toBe(1);
    expect(h.sleeps).toEqual([]);
  });
});
