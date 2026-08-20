import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractImportSpecifiers } from '../src/structure/extract.js';
import { extractPythonImportSpecifiers } from '../src/structure/extract-python.js';
import { resolveSpecifier } from '../src/structure/resolve.js';
import { resolvePythonSpecifier } from '../src/structure/resolve-python.js';
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

  it('rewrites .mjs to .mts and .cjs to .cts, not just .js/.jsx', () => {
    const esmTracked = new Set(['src/a.mts', 'src/b.cts']);
    expect(resolveSpecifier('src/entry.ts', './a.mjs', esmTracked)).toBe('src/a.mts');
    expect(resolveSpecifier('src/entry.ts', './b.cjs', esmTracked)).toBe('src/b.cts');
  });

  it('returns null for a real, non-rewritable extension that is not tracked, rather than guessing', () => {
    // Discriminating from the "extensionless" branch below it: .css has an
    // extension, so this must short-circuit at the ext-but-not-rewritable
    // check rather than falling through to try appending .ts/.tsx/etc.
    expect(resolveSpecifier('src/entry.ts', './missing.css', tracked)).toBeNull();
  });
});

describe('extractPythonImportSpecifiers', () => {
  it('extracts a module-level relative import and a from-import', () => {
    const source = ['import os', 'from .utils import helper', 'from ..pkg.sub import thing'].join('\n');
    expect(extractPythonImportSpecifiers(source).sort()).toEqual(['..pkg.sub', '.utils'].sort());
  });

  it('extracts each name from a bare "from . import x, y as z" as its own candidate', () => {
    expect(extractPythonImportSpecifiers('from . import x, y as z')).toEqual(['.x', '.y']);
  });

  it('drops an absolute import -- could be stdlib, third-party, or this project, not distinguishable from text', () => {
    expect(extractPythonImportSpecifiers('import numpy as np\nfrom numpy import array\n')).toEqual([]);
  });

  it('ignores a bare "*" in "from . import *"', () => {
    expect(extractPythonImportSpecifiers('from . import *')).toEqual([]);
  });

  it('deduplicates repeated specifiers', () => {
    expect(extractPythonImportSpecifiers('from .a import x\nfrom .a import y\n')).toEqual(['.a']);
  });

  it('strips a trailing comment from a bare import list', () => {
    expect(extractPythonImportSpecifiers('from . import x  # noqa')).toEqual(['.x']);
  });
});

describe('resolvePythonSpecifier', () => {
  const tracked = new Set(['pkg/a.py', 'pkg/sub/b.py', 'pkg/sub/__init__.py', 'pkg/data.json']);

  it('resolves a single-dot specifier to a sibling module', () => {
    expect(resolvePythonSpecifier('pkg/entry.py', '.a', tracked)).toBe('pkg/a.py');
  });

  it('resolves a dotted single-dot specifier into a subpackage module', () => {
    expect(resolvePythonSpecifier('pkg/entry.py', '.sub.b', tracked)).toBe('pkg/sub/b.py');
  });

  it('resolves a package specifier to its __init__.py when there is no matching plain module', () => {
    expect(resolvePythonSpecifier('pkg/entry.py', '.sub', tracked)).toBe('pkg/sub/__init__.py');
  });

  it('resolves a double-dot specifier one directory further up', () => {
    expect(resolvePythonSpecifier('pkg/sub/mod.py', '..a', tracked)).toBe('pkg/a.py');
  });

  it('returns null when nothing in the tracked set matches, rather than guessing', () => {
    expect(resolvePythonSpecifier('pkg/entry.py', '.missing', tracked)).toBeNull();
  });

  it('returns null for a specifier with no dots', () => {
    expect(resolvePythonSpecifier('pkg/entry.py', 'a', tracked)).toBeNull();
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

  it('also walks tracked Python files and resolves real relative-import edges', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexusmem-structure-py-'));
    const g = (...args: string[]) => gitFixture(dir, args, { env: GIT_ENV });
    g('init', '-q', '-b', 'main');

    mkdirSync(join(dir, 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'pkg', 'main.py'), 'import os\nfrom .helper import run\n');
    writeFileSync(join(dir, 'pkg', 'helper.py'), 'def run():\n    pass\n');

    g('add', '.');
    g('commit', '-q', '-m', 'chore: initial commit');

    const { edges, filesScanned } = await collectFileEdges(dir);

    expect(filesScanned).toBe(2);
    expect(edges).toEqual([{ fromPath: 'pkg/main.py', toPath: 'pkg/helper.py', kind: 'import' }]);
  });
});
