import { describe, expect, it } from 'vitest';
import {
  RECORD_SEP,
  UNIT_SEP,
  parseCommitRecord,
  parseNumstat,
  resolveRenamePath,
  splitRecords,
  unquoteGitPath,
} from '../src/git/parse.js';
import { parseConventionalHeader, scoreCommit, toMemoryNode } from '../src/collectors/git-commits.js';
import { makeProjectId, normalizeGitUrl } from '../src/core/project.js';
import { makeNodeId } from '../src/core/ids.js';

/** Build the exact byte layout `git log --format=... --numstat` produces. */
function record(fields: {
  sha: string;
  short: string;
  parents?: string;
  subject: string;
  body?: string;
  numstat?: string;
}): string {
  const parts = [
    fields.sha,
    fields.short,
    fields.parents ?? '',
    'Ada Lovelace',
    'ada@example.com',
    '2026-03-01T10:00:00+07:00',
    '2026-03-01T10:05:00+07:00',
    fields.subject,
    fields.body ?? fields.subject,
  ];
  return RECORD_SEP + parts.join(UNIT_SEP) + UNIT_SEP + `\n${fields.numstat ?? ''}`;
}

describe('splitRecords', () => {
  it('carries an incomplete trailing record into the next chunk', () => {
    const a = record({ sha: 'a'.repeat(40), short: 'aaaaaaa', subject: 'feat: one' });
    const b = record({ sha: 'b'.repeat(40), short: 'bbbbbbb', subject: 'fix: two' });
    const stream = a + b;
    const cut = a.length + 10;

    const first = splitRecords(stream.slice(0, cut));
    expect(first.records).toHaveLength(1);

    const second = splitRecords(first.rest + stream.slice(cut), true);
    expect(second.records).toHaveLength(1);

    expect(parseCommitRecord(first.records[0]!)?.subject).toBe('feat: one');
    expect(parseCommitRecord(second.records[0]!)?.subject).toBe('fix: two');
  });
});

describe('parseCommitRecord', () => {
  it('parses fields, body and numstat', () => {
    const raw = record({
      sha: 'c'.repeat(40),
      short: 'ccccccc',
      subject: 'fix(db): close the write handle',
      body: 'fix(db): close the write handle\n\nWAL files were kept open on Windows.',
      numstat: '12\t3\tsrc/store/db.ts\n0\t8\tsrc/store/old.ts\n',
    });

    const commit = parseCommitRecord(raw);
    expect(commit).not.toBeNull();
    expect(commit!.shortSha).toBe('ccccccc');
    expect(commit!.subject).toBe('fix(db): close the write handle');
    expect(commit!.messageBody).toBe('WAL files were kept open on Windows.');
    expect(commit!.isMerge).toBe(false);
    expect(commit!.files).toEqual([
      { path: 'src/store/db.ts', insertions: 12, deletions: 3, binary: false },
      { path: 'src/store/old.ts', insertions: 0, deletions: 8, binary: false },
    ]);
  });

  it('flags merge commits from the parent list', () => {
    const raw = record({
      sha: 'd'.repeat(40),
      short: 'ddddddd',
      parents: `${'e'.repeat(40)} ${'f'.repeat(40)}`,
      subject: 'Merge branch feature/x',
    });
    expect(parseCommitRecord(raw)!.isMerge).toBe(true);
  });

  it('keeps a body that contains a stray unit separator', () => {
    const raw = record({
      sha: '1'.repeat(40),
      short: '1111111',
      subject: 'chore: weird',
      body: `chore: weird\n\nsome${UNIT_SEP}text`,
    });
    expect(parseCommitRecord(raw)!.messageBody).toBe(`some${UNIT_SEP}text`);
  });

  it('rejects garbage instead of yielding a broken node', () => {
    expect(parseCommitRecord('not a record')).toBeNull();
  });
});

describe('parseNumstat', () => {
  it('marks binary files with null churn', () => {
    expect(parseNumstat('-\t-\tassets/logo.png\n')).toEqual([
      { path: 'assets/logo.png', insertions: null, deletions: null, binary: true },
    ]);
  });

  it('ignores blank lines', () => {
    expect(parseNumstat('\n\n1\t1\ta.ts\n\n')).toHaveLength(1);
  });
});

describe('resolveRenamePath', () => {
  it('expands the braced form', () => {
    expect(resolveRenamePath('src/{git => collectors}/log.ts')).toEqual({
      path: 'src/collectors/log.ts',
      previousPath: 'src/git/log.ts',
    });
  });

  it('handles an empty side of the brace', () => {
    expect(resolveRenamePath('src/{ => nested}/a.ts')).toEqual({
      path: 'src/nested/a.ts',
      previousPath: 'src/a.ts',
    });
  });

  it('handles the plain arrow form', () => {
    expect(resolveRenamePath('old/a.ts => new/b.ts')).toEqual({
      path: 'new/b.ts',
      previousPath: 'old/a.ts',
    });
  });

  it('leaves ordinary paths alone', () => {
    expect(resolveRenamePath('src/cli/index.ts')).toEqual({ path: 'src/cli/index.ts' });
  });
});

describe('unquoteGitPath', () => {
  it('decodes octal byte escapes back into UTF-8', () => {
    // "café.ts" as git would quote it byte by byte.
    const quoted = '"caf\\303\\251.ts"';
    expect(unquoteGitPath(quoted)).toBe('café.ts');
  });

  it('decodes embedded quotes', () => {
    expect(unquoteGitPath('"a\\"b.ts"')).toBe('a"b.ts');
  });

  it('passes unquoted paths through untouched', () => {
    expect(unquoteGitPath('src/a.ts')).toBe('src/a.ts');
  });
});

describe('scoreCommit', () => {
  const base = (subject: string, body = subject) =>
    parseCommitRecord(record({ sha: '9'.repeat(40), short: '9999999', subject, body }))!;

  it('ranks intent-bearing commits above chores', () => {
    expect(scoreCommit(base('fix: null deref in parser'))).toBeGreaterThan(
      scoreCommit(base('chore: bump deps')),
    );
    expect(scoreCommit(base('feat: add mcp server'))).toBeGreaterThan(
      scoreCommit(base('style: reformat')),
    );
  });

  it('rewards commits that explain why', () => {
    const bare = base('refactor: split store module');
    const explained = base(
      'refactor: split store module',
      `refactor: split store module\n\n${'The old module mixed schema, migrations and queries. '.repeat(4)}`,
    );
    expect(scoreCommit(explained)).toBeGreaterThan(scoreCommit(bare));
  });

  it('stays inside 0..1', () => {
    for (const s of ['feat!: rewrite everything', 'Merge branch main', 'style: nit']) {
      const score = scoreCommit(base(s));
      expect(score).toBeGreaterThanOrEqual(0.05);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});

describe('parseConventionalHeader', () => {
  it('extracts type, scope and breaking marker', () => {
    expect(parseConventionalHeader('feat(cli)!: drop node 18')).toEqual({
      type: 'feat',
      scope: 'cli',
      breaking: true,
      description: 'drop node 18',
    });
  });

  it('degrades gracefully for freeform subjects', () => {
    expect(parseConventionalHeader('made it faster')).toEqual({
      type: null,
      scope: null,
      breaking: false,
      description: 'made it faster',
    });
  });
});

describe('toMemoryNode', () => {
  const commit = parseCommitRecord(
    record({
      sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      short: 'a1b2c3d',
      subject: 'fix(git): stream log output',
      body: 'fix(git): stream log output\n\nBuffering blew up on large repos.',
      numstat: '40\t10\tsrc/git/log.ts\n-\t-\tdocs/diagram.png\n',
    }),
  )!;

  it('is content-addressed and stable across runs', () => {
    const a = toMemoryNode(commit, 'proj1');
    const b = toMemoryNode(commit, 'proj1');
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(makeNodeId('proj1', 'git_commit', commit.sha));
  });

  it('namespaces ids per project', () => {
    expect(toMemoryNode(commit, 'proj1').id).not.toBe(toMemoryNode(commit, 'proj2').id);
  });

  it('puts message and file paths into the searchable body', () => {
    const node = toMemoryNode(commit, 'proj1');
    expect(node.body).toContain('Buffering blew up on large repos.');
    expect(node.body).toContain('src/git/log.ts');
    expect(node.meta.filesChanged).toBe(2);
    expect(node.meta.insertions).toBe(40);
  });

  it('caps the file list but records the true count', () => {
    const many = { ...commit, files: Array.from({ length: 60 }, (_, i) => ({ path: `f${i}.ts`, insertions: i, deletions: 0, binary: false })) };
    const node = toMemoryNode(many, 'proj1', { maxFilesPerNode: 5 });
    expect(node.files).toHaveLength(5);
    expect(node.meta.filesChanged).toBe(60);
    expect(node.body).toContain('and 55 more file(s)');
    // Kept files are the highest-churn ones.
    expect(node.files[0]!.path).toBe('f59.ts');
  });
});

describe('project identity', () => {
  it('normalises equivalent remote URLs', () => {
    const expected = 'github.com/acme/repo';
    expect(normalizeGitUrl('git@github.com:acme/Repo.git')).toBe(expected);
    expect(normalizeGitUrl('https://github.com/acme/repo')).toBe(expected);
    expect(normalizeGitUrl('ssh://git@github.com/acme/repo.git/')).toBe(expected);
  });

  it('gives the same id to two clones of one repo', () => {
    const a = makeProjectId({ root: 'D:/work/repo', originUrl: 'git@github.com:acme/repo.git' });
    const b = makeProjectId({ root: '/home/x/repo', originUrl: 'https://github.com/acme/repo' });
    expect(a).toBe(b);
  });

  it('falls back to the path for remoteless repos', () => {
    const a = makeProjectId({ root: 'D:/work/repo', originUrl: null });
    const b = makeProjectId({ root: 'D:/work/other', originUrl: null });
    expect(a).not.toBe(b);
  });
});
