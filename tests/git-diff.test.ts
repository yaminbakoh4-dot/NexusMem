import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectCommitDiffs,
  indexableFiles,
  isGeneratedPath,
  scoreFileDiff,
  toMemoryNodes,
} from '../src/collectors/diffs.js';
import {
  buildDiffLogArgs,
  parseCommitDiffRecord,
  parseDiffGitPaths,
  parseFileDiffs,
  type RawCommitDiff,
  type RawFileDiff,
} from '../src/git/diff.js';
import { RECORD_SEP, UNIT_SEP } from '../src/git/parse.js';
import { packContext, renderContextBlock } from '../src/retrieval/pack.js';
import { gitFixture } from './helpers.js';

/**
 * Diff patches are parsed by a second walk, separate from the `--numstat` one
 * in `log.ts`. These pin the shapes git actually emits -- renames, deletions,
 * binaries, quoted paths -- because every one of them is a case where the
 * per-file identity of a node comes from a different line of the header.
 */

const MODIFY = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,4 +1,4 @@',
  ' const port = 3000;',
  '-const host = "localhost";',
  '+const host = "0.0.0.0";',
  ' export { port, host };',
].join('\n');

describe('parseFileDiffs', () => {
  it('reads path, hunk count and line counts from a modification', () => {
    const [file] = parseFileDiffs(MODIFY);
    expect(file).toMatchObject({
      path: 'src/app.ts',
      status: 'modified',
      binary: false,
      insertions: 1,
      deletions: 1,
      hunkCount: 1,
    });
    expect(file!.patch).toContain('+const host = "0.0.0.0";');
    // The `diff --git`/`index` preamble is metadata, not content worth indexing.
    expect(file!.patch.startsWith('@@')).toBe(true);
  });

  it('splits a multi-file commit into one entry per file', () => {
    const second = [
      'diff --git a/README.md b/README.md',
      'index 3333333..4444444 100644',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1 +1,2 @@',
      ' # Title',
      '+A new line.',
    ].join('\n');

    const files = parseFileDiffs(`${MODIFY}\n${second}`);
    expect(files.map((f) => f.path)).toEqual(['src/app.ts', 'README.md']);
    expect(files[1]!.insertions).toBe(1);
    expect(files[1]!.deletions).toBe(0);
  });

  it('marks an added file and a deleted file by their mode lines', () => {
    const added = [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      'index 0000000..5555555',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,2 @@',
      '+export const a = 1;',
      '+export const b = 2;',
    ].join('\n');
    const deleted = [
      'diff --git a/old.ts b/old.ts',
      'deleted file mode 100644',
      'index 5555555..0000000',
      '--- a/old.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-export const a = 1;',
      '-export const b = 2;',
    ].join('\n');

    const files = parseFileDiffs(`${added}\n${deleted}`);
    expect(files[0]).toMatchObject({ path: 'new.ts', status: 'added', insertions: 2, deletions: 0 });
    // `+++ /dev/null` carries no path -- the identity has to come from the `---` side.
    expect(files[1]).toMatchObject({ path: 'old.ts', status: 'deleted', insertions: 0, deletions: 2 });
  });

  it('keeps both sides of a rename', () => {
    const renamed = [
      'diff --git a/src/old-name.ts b/src/new-name.ts',
      'similarity index 92%',
      'rename from src/old-name.ts',
      'rename to src/new-name.ts',
      '--- a/src/old-name.ts',
      '+++ b/src/new-name.ts',
      '@@ -1,2 +1,2 @@',
      '-const a = 1;',
      '+const a = 2;',
    ].join('\n');

    const [file] = parseFileDiffs(renamed);
    expect(file).toMatchObject({ path: 'src/new-name.ts', previousPath: 'src/old-name.ts', status: 'renamed' });
  });

  it('flags a binary file instead of inventing hunks for it', () => {
    const binary = [
      'diff --git a/logo.png b/logo.png',
      'index 6666666..7777777 100644',
      'Binary files a/logo.png and b/logo.png differ',
    ].join('\n');

    const [file] = parseFileDiffs(binary);
    expect(file).toMatchObject({ path: 'logo.png', binary: true, hunkCount: 0, patch: '' });
  });

  it('reads a mode-only change as a file with no hunks', () => {
    const modeOnly = [
      'diff --git a/run.sh b/run.sh',
      'old mode 100644',
      'new mode 100755',
    ].join('\n');

    const [file] = parseFileDiffs(modeOnly);
    expect(file).toMatchObject({ path: 'run.sh', hunkCount: 0 });
  });

  it('does not start a new file section for a `diff --git` line inside a hunk', () => {
    // A patch committed as content (a fixture file, a doc example) arrives with
    // a `+`/`-`/` ` prefix, so column 0 stays a reliable section boundary.
    const nested = [
      'diff --git a/tests/fixture.txt b/tests/fixture.txt',
      'index 8888888..9999999 100644',
      '--- a/tests/fixture.txt',
      '+++ b/tests/fixture.txt',
      '@@ -1,2 +1,3 @@',
      ' sample patch below',
      '+diff --git a/ghost.ts b/ghost.ts',
      '+@@ -1 +1 @@',
    ].join('\n');

    const files = parseFileDiffs(nested);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe('tests/fixture.txt');
    expect(files[0]!.insertions).toBe(2);
  });

  it('counts each hunk of a multi-hunk file', () => {
    const twoHunks = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,3 +1,3 @@',
      '-a',
      '+b',
      ' c',
      '@@ -20,3 +20,4 @@ function tail()',
      ' d',
      '+e',
    ].join('\n');

    expect(parseFileDiffs(twoHunks)[0]).toMatchObject({ hunkCount: 2, insertions: 2, deletions: 1 });
  });

  it('parses a CRLF patch stream the same as an LF one', () => {
    const lf = parseFileDiffs(MODIFY);
    const crlf = parseFileDiffs(MODIFY.replace(/\n/g, '\r\n'));
    expect(crlf).toEqual(lf);
  });

  it('returns nothing for an empty patch block', () => {
    expect(parseFileDiffs('')).toEqual([]);
  });
});

describe('parseDiffGitPaths', () => {
  it('splits a plain header', () => {
    expect(parseDiffGitPaths('diff --git a/src/x.ts b/src/x.ts')).toEqual({ a: 'src/x.ts', b: 'src/x.ts' });
  });

  it('splits a quoted header without cutting at the space inside the path', () => {
    expect(parseDiffGitPaths('diff --git "a/my dir/x.ts" "b/my dir/x.ts"')).toEqual({
      a: 'my dir/x.ts',
      b: 'my dir/x.ts',
    });
  });
});

describe('parseCommitDiffRecord', () => {
  const record = (fields: string[], patch: string) => `${RECORD_SEP}${fields.join(UNIT_SEP)}${UNIT_SEP}${patch}`;

  it('reads the format fields and the patch that follows them', () => {
    const parsed = parseCommitDiffRecord(
      record(['abc1234def5678', 'abc1234', '2026-08-12T09:00:00+07:00', 'fix: stop the leak'], `\n${MODIFY}`),
    );

    expect(parsed).toMatchObject({
      sha: 'abc1234def5678',
      shortSha: 'abc1234',
      authoredAt: '2026-08-12T09:00:00+07:00',
      subject: 'fix: stop the leak',
    });
    expect(parsed!.files.map((f) => f.path)).toEqual(['src/app.ts']);
  });

  it('keeps a subject that itself contains the field separator', () => {
    const parsed = parseCommitDiffRecord(
      record(['abc1234def5678', 'abc1234', '2026-08-12T09:00:00+07:00', `fix: a${UNIT_SEP}b`], `\n${MODIFY}`),
    );
    expect(parsed!.subject).toBe(`fix: a${UNIT_SEP}b`);
    expect(parsed!.files).toHaveLength(1);
  });

  it('rejects a record whose first field is not a sha', () => {
    expect(parseCommitDiffRecord(record(['not-a-sha', 'x', 'ts', 'subject'], ''))).toBeNull();
  });
});

describe('buildDiffLogArgs', () => {
  it('asks for patches, skips merges and pins the context width', () => {
    const args = buildDiffLogArgs({ contextLines: 5 });
    expect(args).toContain('--patch');
    // A merge's patch is empty without `-m`, and `-m`'s combined format is not
    // what `parseFileDiffs` reads.
    expect(args).toContain('--no-merges');
    expect(args).toContain('--unified=5');
    expect(args).toContain('--no-textconv');
    expect(args.at(-1)).toBe('HEAD');
  });

  it('walks only the new range when given a cursor', () => {
    const args = buildDiffLogArgs({ afterCommit: 'aaaa', rev: 'bbbb', maxCount: 10 });
    expect(args).toContain('--max-count=10');
    expect(args.at(-1)).toBe('aaaa..bbbb');
  });
});

const fileDiff = (overrides: Partial<RawFileDiff> = {}): RawFileDiff => ({
  path: 'src/app.ts',
  status: 'modified',
  binary: false,
  insertions: 4,
  deletions: 2,
  hunkCount: 1,
  patch: '@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;',
  ...overrides,
});

const commitDiff = (overrides: Partial<RawCommitDiff> = {}): RawCommitDiff => ({
  sha: 'abc1234def5678',
  shortSha: 'abc1234',
  authoredAt: '2026-08-12T09:00:00+07:00',
  subject: 'fix: stop the leak',
  files: [fileDiff()],
  ...overrides,
});

describe('scoreFileDiff', () => {
  it('scores a patch inside a fix above the same patch inside a chore', () => {
    expect(scoreFileDiff('fix: stop the leak', fileDiff())).toBeGreaterThan(
      scoreFileDiff('chore: bump deps', fileDiff()),
    );
  });

  it('scores a test file below a source file in the same commit', () => {
    expect(scoreFileDiff('fix: x', fileDiff({ path: 'tests/app.test.ts' }))).toBeLessThan(
      scoreFileDiff('fix: x', fileDiff()),
    );
  });

  it('discounts a thousand-line patch', () => {
    expect(scoreFileDiff('feat: x', fileDiff({ insertions: 900, deletions: 200 }))).toBeLessThan(
      scoreFileDiff('feat: x', fileDiff()),
    );
  });

  it('stays inside 0.05..1', () => {
    expect(scoreFileDiff('security!: patch', fileDiff({ status: 'added' }))).toBeLessThanOrEqual(1);
    expect(
      scoreFileDiff('style: reformat', fileDiff({ path: 'tests/x.test.ts', status: 'deleted', insertions: 0, deletions: 1 })),
    ).toBeGreaterThanOrEqual(0.05);
  });
});

describe('indexableFiles', () => {
  it('drops binaries, metadata-only changes and generated paths', () => {
    const kept = indexableFiles([
      fileDiff({ path: 'src/app.ts' }),
      fileDiff({ path: 'logo.png', binary: true, hunkCount: 0, patch: '' }),
      fileDiff({ path: 'run.sh', hunkCount: 0, patch: '' }),
      fileDiff({ path: 'package-lock.json' }),
      fileDiff({ path: 'dist/cli/index.js' }),
    ]);
    expect(kept.map((f) => f.path)).toEqual(['src/app.ts']);
  });

  it('recognises lockfiles and build output as generated, but not ordinary source', () => {
    expect(isGeneratedPath('pnpm-lock.yaml')).toBe(true);
    expect(isGeneratedPath('packages/web/dist/bundle.js')).toBe(true);
    expect(isGeneratedPath('src/vendor-adapter.ts')).toBe(false);
  });
});

describe('toMemoryNodes (diffs)', () => {
  it('emits one node per changed file, carrying the patch itself', () => {
    const nodes = toMemoryNodes(
      commitDiff({ files: [fileDiff({ path: 'src/a.ts' }), fileDiff({ path: 'src/b.ts' })] }),
      'proj1',
    );

    expect(nodes).toHaveLength(2);
    expect(nodes[0]!.kind).toBe('code_diff');
    expect(nodes[0]!.source).toBe('diff');
    expect(nodes[0]!.ts).toBe('2026-08-12T09:00:00+07:00');
    expect(nodes[0]!.body).toContain('+const a = 2;');
    expect(nodes[0]!.title).toContain('src/a.ts');
    expect(nodes[0]!.title).toContain('fix: stop the leak');
    expect(nodes.map((n) => n.files[0]!.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('is content-addressed by sha + path, so a re-sync updates rather than duplicates', () => {
    const a = toMemoryNodes(commitDiff(), 'proj1');
    const b = toMemoryNodes(commitDiff(), 'proj1');
    expect(a[0]!.id).toBe(b[0]!.id);
    // Two files of the same commit must not collide.
    const two = toMemoryNodes(commitDiff({ files: [fileDiff({ path: 'x.ts' }), fileDiff({ path: 'y.ts' })] }), 'proj1');
    expect(two[0]!.id).not.toBe(two[1]!.id);
  });

  it('keeps the biggest diffs when a commit exceeds maxFilesPerCommit', () => {
    const nodes = toMemoryNodes(
      commitDiff({
        files: [
          fileDiff({ path: 'small.ts', insertions: 1, deletions: 0 }),
          fileDiff({ path: 'big.ts', insertions: 80, deletions: 20 }),
          fileDiff({ path: 'medium.ts', insertions: 10, deletions: 5 }),
        ],
      }),
      'proj1',
      { maxFilesPerCommit: 2 },
    );
    expect(nodes.map((n) => n.meta.path)).toEqual(['big.ts', 'medium.ts']);
  });

  it('truncates an oversized patch to the body cap', () => {
    const huge = `@@ -1,400 +1,400 @@\n${Array.from({ length: 400 }, (_, i) => `+line ${i}`).join('\n')}`;
    const [node] = toMemoryNodes(commitDiff({ files: [fileDiff({ patch: huge })] }), 'proj1', { maxBodyChars: 500 });
    expect(node!.body.length).toBeLessThanOrEqual(500);
  });

  it('redacts a token that appears in the patch', () => {
    const patch = '@@ -1 +1 @@\n+const t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";';
    const [node] = toMemoryNodes(commitDiff({ files: [fileDiff({ patch })] }), 'proj1');
    expect(node!.body).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(node!.body).toContain('[redacted]');
  });

  it('leaves ordinary key-named code intact, unlike prose redaction', () => {
    // The key/value rule matches `apiKey = <8+ chars>`, which describes half
    // the configuration code ever written. Running it over source would
    // destroy the lines the node exists to show.
    const patch = '@@ -1 +1 @@\n+const apiKey = process.env.SERVICE_API_KEY;';
    const [node] = toMemoryNodes(commitDiff({ files: [fileDiff({ patch })] }), 'proj1');
    expect(node!.body).toContain('process.env.SERVICE_API_KEY');
    expect(node!.body).not.toContain('[redacted]');
  });
});

describe('packing and rendering a diff node', () => {
  const diffHit = (body: string) => ({
    id: 'n1',
    kind: 'code_diff',
    ts: '2026-08-12T09:00:00+07:00',
    title: 'src/app.ts @ abc1234 — fix: stop the leak',
    body,
    signal: 0.8,
    score: 0.9,
    relevance: 0.9,
  });

  const SHORT = 'fix: stop the leak (abc1234)\nmodified src/app.ts (+1/-1, 1 hunk)\n\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;';

  const MULTI_HUNK = [
    'fix: stop the leak (abc1234)',
    'modified src/git/exec.ts (+4/-2, 3 hunks)',
    '',
    '@@ -1,3 +1,3 @@',
    '-import { spawn } from "node:child_process";',
    '+import { spawn, type SpawnOptions } from "node:child_process";',
    '@@ -40,3 +40,3 @@',
    "-const BASE_ARGS = ['--no-pager'];",
    "+const BASE_ARGS = ['-c', 'core.quotePath=false', '--no-pager'];",
    '@@ -90,2 +90,2 @@',
    '-const RETRY_DELAYS_MS = [50];',
    '+const RETRY_DELAYS_MS = [50, 150, 400];',
  ].join('\n');

  it('keeps the patch on separate lines instead of flattening it', () => {
    const rendered = renderContextBlock('why did a change', packContext([diffHit(SHORT) as never], 2000));

    expect(rendered).toContain('\n  -const a = 1;');
    expect(rendered).toContain('\n  +const a = 2;');
  });

  it('shows the hunk that matches the query, not whichever one is first in the file', () => {
    // Found by dogfooding: a query about git flags retrieved the right file and
    // then spent the whole summary on an import block 40 lines above the answer.
    const packed = packContext([diffHit(MULTI_HUNK) as never], 2000, { query: 'retry delays between spawns' });

    expect(packed.nodes[0]!.summary).toContain('RETRY_DELAYS_MS = [50, 150, 400]');
    expect(packed.nodes[0]!.summary).not.toContain('SpawnOptions');
    // The header lines survive: they say what changed and by how much.
    expect(packed.nodes[0]!.summary).toContain('modified src/git/exec.ts');
  });

  it('starts the excerpt at the changed line, not at the top of the hunk', () => {
    // A 320-char summary is about six lines. A hunk that opens with several
    // unchanged lines would otherwise spend all of them on context and stop
    // before reaching the line the node exists to show.
    const body = [
      'fix: normalize line endings (abc1234)',
      'modified src/chunk.ts (+1/-0, 1 hunk)',
      '',
      '@@ -39,10 +39,11 @@ export function chunkAssistantText(text, maxChars) {',
      ' const a = 1;',
      ' const b = 2;',
      ' const c = 3;',
      ' const d = 4;',
      ' const e = 5;',
      ' const f = 6;',
      '+  const normalized = text.replace(/\\r\\n/g, "\\n");',
    ].join('\n');

    const packed = packContext([diffHit(body) as never], 2000, { query: 'normalize CRLF line endings' });

    expect(packed.nodes[0]!.summary).toContain('const normalized = text.replace');
    // The hunk header names the enclosing function; that is how the excerpt is located.
    expect(packed.nodes[0]!.summary).toContain('@@ -39,10 +39,11 @@');
    expect(packed.nodes[0]!.summary).not.toContain('const a = 1;');
  });

  it('falls back to the first hunk when the query matches none of them', () => {
    const packed = packContext([diffHit(MULTI_HUNK) as never], 2000, { query: 'kubernetes ingress' });
    expect(packed.nodes[0]!.summary).toContain('SpawnOptions');
  });

  it('leaves non-diff nodes summarized exactly as before', () => {
    const commitHit = {
      id: 'n2',
      kind: 'git_commit',
      ts: '2026-08-12T09:00:00+07:00',
      title: 'fix: stop the leak',
      body: 'fix: stop the leak\n\nThe pool was never drained on shutdown.',
      signal: 0.8,
      score: 0.9,
      relevance: 0.9,
    };
    const packed = packContext([commitHit as never], 2000, { query: 'pool drained' });
    expect(packed.nodes[0]!.summary).toBe('The pool was never drained on shutdown.');
  });
});

describe('collectCommitDiffs against a real repository', () => {
  let dir: string;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@example.com',
  };
  const g = (...args: string[]) => gitFixture(dir, args, { env });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-diff-'));
    g('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'app.ts'), 'const timeout = 1000;\nexport { timeout };\n');
    writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion": 3}\n');
    g('add', '.');
    g('commit', '-q', '-m', 'feat: initial app');
    writeFileSync(join(dir, 'app.ts'), 'const timeout = 30000;\nexport { timeout };\n');
    writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion": 3, "bumped": true}\n');
    g('add', '.');
    g('commit', '-q', '-m', 'fix: raise the timeout so slow machines stop failing');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('indexes the changed line of the newest commit and skips the lockfile', async () => {
    const nodes = [];
    for await (const node of collectCommitDiffs(dir, 'proj1', { maxCount: 1 })) nodes.push(node);

    expect(nodes.map((n) => n.meta.path)).toEqual(['app.ts']);
    expect(nodes[0]!.body).toContain('+const timeout = 30000;');
    expect(nodes[0]!.body).toContain('-const timeout = 1000;');
    expect(nodes[0]!.title).toContain('fix: raise the timeout');
    expect(nodes[0]!.meta.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('walks only the range after a cursor', async () => {
    const all = [];
    for await (const node of collectCommitDiffs(dir, 'proj1')) all.push(node);
    expect(all).toHaveLength(2); // one per commit, lockfile skipped in both

    const firstSha = String(all.at(-1)!.meta.sha);
    const incremental = [];
    for await (const node of collectCommitDiffs(dir, 'proj1', { afterCommit: firstSha })) incremental.push(node);

    expect(incremental).toHaveLength(1);
    expect(incremental[0]!.title).toContain('fix: raise the timeout');
  });
});
