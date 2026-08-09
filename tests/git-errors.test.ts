import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitError, GitSpawnError } from '../src/git/exec.js';
import { NotAGitRepositoryError, readRepoInfo } from '../src/git/repo.js';

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
    execFileSync('git', ['init', '-q'], { cwd: dir });
    // A config value git cannot parse: rev-parse fails, but the repo is real.
    execFileSync('git', ['config', 'core.repositoryformatversion', 'bogus'], { cwd: dir });

    const err = await readRepoInfo(dir).catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(NotAGitRepositoryError);
    expect(err).toBeInstanceOf(GitError);
    // git's own first stderr line is carried into the message rather than discarded.
    expect((err as GitError).message).toMatch(/repository version|repositoryformatversion/i);
  });

  it('still resolves a healthy repository', async () => {
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
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
