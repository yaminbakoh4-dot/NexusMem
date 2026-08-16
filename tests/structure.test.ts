import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractImportSpecifiers } from '../src/structure/extract.js';
import { resolveSpecifier } from '../src/structure/resolve.js';
import { collectFileEdges } from '../src/structure/collect.js';
import { gitFixture } from './helpers.js';

describe('extractImportSpecifiers', () => {
  it('extracts a static import, a side-effect import, a re-export, require and dynamic import', () => {
    const source = [
      `import { a } from './a.js';`,
      `import './side-effect.js';`,
      `export { b } from '../lib/b.js';`,
      `const c = require('./c.js');`,
      `const d = await import('./d.js');`,
    ].join('\n');

    expect(extractImportSpecifiers(source).sort()).toEqual(
      ['../lib/b.js', './a.js', './c.js', './d.js', './side-effect.js'].sort(),
    );
  });

  it('drops bare package specifiers -- they resolve into node_modules, not this project', () => {
    expect(extractImportSpecifiers(`import { z } from 'zod';\nimport './local.js';`)).toEqual(['./local.js']);
  });

  it('deduplicates repeated specifiers', () => {
    expect(extractImportSpecifiers(`import './a.js';\nimport { x } from './a.js';`)).toEqual(['./a.js']);
  });

  it('returns nothing for a file with no relative imports', () => {
    expect(extractImportSpecifiers(`export const x = 1;\nconsole.log('./looks-like-a-path-in-a-string');`)).toEqual(
      [],
    );
  });
});

describe('resolveSpecifier', () => {
  const tracked = new Set(['src/a.ts', 'src/lib/b.tsx', 'src/util/index.ts', 'src/data.json']);

  it('rewrites a .js specifier to the real .ts source (TS/ESM convention)', () => {
    expect(resolveSpecifier('src/entry.ts', './a.js', tracked)).toBe('src/a.ts');
  });

  it('rewrites into a sibling directory and finds a .tsx file', () => {
    expect(resolveSpecifier('src/entry.ts', './lib/b.js', tracked)).toBe('src/lib/b.tsx');
  });

  it('resolves an extensionless specifier to an index file', () => {
    expect(resolveSpecifier('src/entry.ts', './util', tracked)).toBe('src/util/index.ts');
  });

  it('resolves a specifier with a real, non-rewritable extension directly', () => {
    expect(resolveSpecifier('src/entry.ts', './data.json', tracked)).toBe('src/data.json');
  });

  it('returns null when nothing in the tracked set matches', () => {
    expect(resolveSpecifier('src/entry.ts', './missing.js', tracked)).toBeNull();
  });
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

describe('collectFileEdges', () => {
  it('walks tracked files and resolves real edges, skipping bare packages and unresolvable specifiers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexusmem-structure-'));
    const g = (...args: string[]) => gitFixture(dir, args, { env: GIT_ENV });
    g('init', '-q', '-b', 'main');

    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), `import { b } from './b.js';\nimport 'left-pad';\n`);
    writeFileSync(join(dir, 'src', 'b.ts'), `import { z } from 'zod';\nexport const b = 1;\n`);
    writeFileSync(join(dir, 'README.md'), '# not js/ts, should be ignored\n');

    g('add', '.');
    g('commit', '-q', '-m', 'chore: initial commit');

    const { edges, filesScanned, unreadable } = await collectFileEdges(dir);

    expect(filesScanned).toBe(2); // README.md is not a tracked JS/TS pathspec
    expect(unreadable).toEqual([]);
    expect(edges).toEqual([{ fromPath: 'src/a.ts', toPath: 'src/b.ts', kind: 'import' }]);
  });
});
