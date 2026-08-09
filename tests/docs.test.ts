import { describe, expect, it } from 'vitest';
import { collectDocFiles, scoreDocSection, toMemoryNodes } from '../src/collectors/docs.js';
import type { RawDocFile } from '../src/docs/types.js';

const file = (content: string, path = 'README.md'): RawDocFile => ({
  path,
  content,
  ts: '2026-08-09T10:00:00.000Z',
});

describe('scoreDocSection', () => {
  it('scores a section with explanation markers above one without', () => {
    const explained = scoreDocSection('README.md', 'Why BM25 first', 'We chose BM25 first because developer queries are keyword-heavy.');
    const plain = scoreDocSection('README.md', 'Install', 'Run npm install.');
    expect(explained).toBeGreaterThan(plain);
  });

  it('boosts README.md over other doc files, all else equal', () => {
    const readme = scoreDocSection('README.md', 'Overview', 'Some section content of reasonable length here.');
    const other = scoreDocSection('docs/phase-2-spec.md', 'Overview', 'Some section content of reasonable length here.');
    expect(readme).toBeGreaterThan(other);
  });

  it('stays inside 0.05..1', () => {
    expect(scoreDocSection('README.md', 'Why', 'because ' + 'x'.repeat(2000))).toBeLessThanOrEqual(1);
    expect(scoreDocSection('README.md', null, 'x')).toBeGreaterThanOrEqual(0.05);
  });
});

describe('toMemoryNodes (docs)', () => {
  it('keeps a whole short file as one node when it has no headings', () => {
    const nodes = toMemoryNodes(file('Just a short line of prose.'), 'proj1');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.title).toBe('README.md');
    expect(nodes[0]!.kind).toBe('doc_section');
  });

  it('splits at markdown headings, one node per section', () => {
    const content = ['# Overview', '', 'Intro text.', '', '## Why BM25 first', '', 'Because developer queries are keyword-heavy.'].join('\n');
    const nodes = toMemoryNodes(file(content), 'proj1');
    expect(nodes.map((n) => n.meta.heading)).toEqual(['Overview', 'Why BM25 first']);
    expect(nodes[1]!.title).toBe('README.md — Why BM25 first');
    expect(nodes[1]!.body).toContain('keyword-heavy');
    expect(nodes[1]!.body).not.toContain('Intro text');
  });

  it('is content-addressed via file path + heading, stable across re-runs', () => {
    const content = '## Section A\n\nContent.';
    const a = toMemoryNodes(file(content), 'proj1');
    const b = toMemoryNodes(file(content), 'proj1');
    expect(a[0]!.id).toBe(b[0]!.id);
  });

  it('gives distinct ids to duplicate headings in the same file', () => {
    const content = '## Why\n\nFirst reason.\n\n## Why\n\nSecond reason.';
    const nodes = toMemoryNodes(file(content), 'proj1');
    expect(nodes).toHaveLength(2);
    expect(nodes[0]!.id).not.toBe(nodes[1]!.id);
  });

  it('tags every node with the docs source and the file as a touched path', () => {
    const nodes = toMemoryNodes(file('## A\n\ntext'), 'proj1');
    expect(nodes[0]!.source).toBe('docs');
    expect(nodes[0]!.files.map((f) => f.path)).toEqual(['README.md']);
  });

  it('splits an oversized headingless file further and labels titles with a part suffix', () => {
    const content = Array.from({ length: 10 }, (_, i) => `Paragraph number ${i} with some filler text repeated here.`).join('\n\n');
    const nodes = toMemoryNodes(file(content), 'proj1', { maxChunkChars: 120 });
    expect(nodes.length).toBeGreaterThan(1);
    expect(nodes[0]!.title).toContain('(part 1/');
    const ids = nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('returns nothing for an empty file', () => {
    expect(toMemoryNodes(file(''), 'proj1')).toEqual([]);
  });
});

describe('collectDocFiles', () => {
  it('flattens nodes across multiple files', () => {
    const nodes = collectDocFiles(
      [file('## A\n\ntext', 'README.md'), file('## B\n\ntext', 'docs/phase-2-spec.md')],
      'proj1',
    );
    expect(nodes.map((n) => n.meta.path)).toEqual(['README.md', 'docs/phase-2-spec.md']);
  });
});
