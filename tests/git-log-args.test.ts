import { describe, expect, it } from 'vitest';
import { buildLogArgs } from '../src/git/log.js';

/**
 * `buildLogArgs` (the pure arg-builder behind `readCommits`) had zero direct
 * coverage -- every existing git test exercises it only indirectly, by
 * running a real `git log` through `collectGitCommits`/`scan-git`, which
 * proves the end result but not this function's own per-option contract.
 */

describe('buildLogArgs', () => {
  it('defaults to HEAD with merges included and no bounds', () => {
    expect(buildLogArgs()).toEqual(['log', expect.stringMatching(/^--format=/), '--numstat', '--no-color', 'HEAD']);
  });

  it('walks afterCommit..rev for an incremental sync, instead of a bare rev', () => {
    const args = buildLogArgs({ afterCommit: 'abc123', rev: 'HEAD' });
    expect(args).toContain('abc123..HEAD');
    expect(args).not.toContain('HEAD');
  });

  it('excludes merges with --no-merges only when includeMerges is false', () => {
    expect(buildLogArgs({ includeMerges: false })).toContain('--no-merges');
    expect(buildLogArgs({ includeMerges: true })).not.toContain('--no-merges');
    expect(buildLogArgs()).not.toContain('--no-merges'); // default is true
  });

  it('adds --max-count only for a positive maxCount', () => {
    expect(buildLogArgs({ maxCount: 50 })).toContain('--max-count=50');
    expect(buildLogArgs({ maxCount: 0 })).not.toEqual(expect.arrayContaining([expect.stringMatching(/^--max-count=/)]));
    expect(buildLogArgs({ maxCount: null })).not.toEqual(expect.arrayContaining([expect.stringMatching(/^--max-count=/)]));
  });

  it('adds --since verbatim when set', () => {
    expect(buildLogArgs({ since: '90.days.ago' })).toContain('--since=90.days.ago');
    expect(buildLogArgs({ since: null })).not.toEqual(expect.arrayContaining([expect.stringMatching(/^--since=/)]));
  });

  it('restricts to pathspecs after a -- separator, only when paths is non-empty', () => {
    expect(buildLogArgs({ paths: ['src/a.ts', 'src/b.ts'] })).toEqual(expect.arrayContaining(['--', 'src/a.ts', 'src/b.ts']));
    expect(buildLogArgs({ paths: [] })).not.toContain('--');
    expect(buildLogArgs()).not.toContain('--');
  });

  it('combines afterCommit, since, maxCount and paths in one call', () => {
    const args = buildLogArgs({ afterCommit: 'abc123', rev: 'HEAD', since: '90.days.ago', maxCount: 10, paths: ['src/'] });
    expect(args).toContain('abc123..HEAD');
    expect(args).toContain('--since=90.days.ago');
    expect(args).toContain('--max-count=10');
    expect(args.slice(args.indexOf('--'))).toEqual(['--', 'src/']);
  });
});
