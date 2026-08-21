import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractImportSpecifiers } from '../src/structure/extract.js';
import { extractGoImportSpecifiers } from '../src/structure/extract-go.js';
import { extractJavaImportSpecifiers } from '../src/structure/extract-java.js';
import { extractPhpIncludeSpecifiers } from '../src/structure/extract-php.js';
import { extractPythonImportSpecifiers } from '../src/structure/extract-python.js';
import { extractRustModSpecifiers } from '../src/structure/extract-rust.js';
import { resolveSpecifier } from '../src/structure/resolve.js';
import { parseGoModulePath, resolveGoSpecifier } from '../src/structure/resolve-go.js';
import { resolveJavaSpecifier } from '../src/structure/resolve-java.js';
import { resolvePhpSpecifier } from '../src/structure/resolve-php.js';
import { resolvePythonSpecifier } from '../src/structure/resolve-python.js';
import { resolveRustModSpecifier } from '../src/structure/resolve-rust.js';
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
  it('extracts a module-level relative import and a from-import, plus the bare "import os" as a dot-free candidate', () => {
    const source = ['import os', 'from .utils import helper', 'from ..pkg.sub import thing'].join('\n');
    expect(extractPythonImportSpecifiers(source).sort()).toEqual(['..pkg.sub', '.utils', 'os'].sort());
  });

  it('extracts each name from a bare "from . import x, y as z" as its own candidate', () => {
    expect(extractPythonImportSpecifiers('from . import x, y as z')).toEqual(['.x', '.y']);
  });

  it('drops a dotted absolute import -- could be a real path anywhere on sys.path, not necessarily a subdirectory here', () => {
    expect(extractPythonImportSpecifiers('import os.path\nfrom numpy.random import default_rng\n')).toEqual([]);
  });

  it('captures a bare, dot-free absolute import as a same-directory candidate -- resolvePythonSpecifier is what filters stdlib out, not extraction', () => {
    expect(extractPythonImportSpecifiers('import numpy as np\nfrom agents import Agent\n').sort()).toEqual(['agents', 'numpy'].sort());
  });

  it('extracts every comma-separated name from one bare "import a, b as c" line', () => {
    expect(extractPythonImportSpecifiers('import agents, invideo_bot as bot').sort()).toEqual(['agents', 'invideo_bot'].sort());
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

  it('strips a trailing comment from a bare "import x" line too', () => {
    expect(extractPythonImportSpecifiers('import agents  # noqa')).toEqual(['agents']);
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

  it('resolves a bare, dot-free specifier to a same-directory sibling module -- the flat-script import style found dogfooding real projects', () => {
    expect(resolvePythonSpecifier('pkg/entry.py', 'a', tracked)).toBe('pkg/a.py');
  });

  it('resolves a bare specifier to a same-directory package __init__.py', () => {
    expect(resolvePythonSpecifier('app/entry.py', 'utils', new Set(['app/utils/__init__.py']))).toBe('app/utils/__init__.py');
  });

  it('does not resolve a bare specifier across directories -- only exact same-directory siblings are safe enough to guess', () => {
    expect(resolvePythonSpecifier('entry.py', 'b', tracked)).toBeNull(); // pkg/sub/b.py exists, but not at the root
  });

  it('refuses a bare specifier that is a well-known stdlib module name, even if a same-named local file exists', () => {
    const shadowed = new Set(['os.py']);
    expect(resolvePythonSpecifier('entry.py', 'os', shadowed)).toBeNull();
  });
});

describe('extractGoImportSpecifiers', () => {
  it('extracts a single-line import', () => {
    expect(extractGoImportSpecifiers('import "fmt"')).toEqual(['fmt']);
  });

  it('extracts every path in a grouped import block, stripping aliases, blank identifier and dot imports', () => {
    const source = ['import (', '\t"fmt"', '\talias "acme/internal/util"', '\t_ "acme/plugin"', '\t. "acme/dot"', ')'].join(
      '\n',
    );
    expect(extractGoImportSpecifiers(source).sort()).toEqual(['acme/dot', 'acme/internal/util', 'acme/plugin', 'fmt'].sort());
  });

  it('does not double-count a single-line import as also matching the block form', () => {
    expect(extractGoImportSpecifiers('import "fmt"\nimport "os"\n')).toEqual(['fmt', 'os']);
  });

  it('deduplicates repeated paths', () => {
    expect(extractGoImportSpecifiers('import "fmt"\nimport (\n\t"fmt"\n)\n')).toEqual(['fmt']);
  });
});

describe('parseGoModulePath / resolveGoSpecifier', () => {
  it('parses the module line from a real go.mod', () => {
    expect(parseGoModulePath('module acme/widget\n\ngo 1.22\n')).toBe('acme/widget');
  });

  it('returns null when there is no module line', () => {
    expect(parseGoModulePath('go 1.22\n')).toBeNull();
  });

  const tracked = new Set(['internal/util/a.go', 'internal/util/b.go', 'internal/util/b_test.go', 'main.go', 'cmd/root.go']);

  it('resolves every non-test .go file in the imported package directory', () => {
    expect(resolveGoSpecifier('acme/widget', 'acme/widget/internal/util', tracked)).toEqual([
      'internal/util/a.go',
      'internal/util/b.go',
    ]);
  });

  it('resolves the module root itself to root-level .go files', () => {
    expect(resolveGoSpecifier('acme/widget', 'acme/widget', tracked)).toEqual(['main.go']);
  });

  it('returns [] for an external import outside this module', () => {
    expect(resolveGoSpecifier('acme/widget', 'github.com/other/pkg', tracked)).toEqual([]);
  });

  it('returns [] for the standard library', () => {
    expect(resolveGoSpecifier('acme/widget', 'fmt', tracked)).toEqual([]);
  });
});

describe('extractRustModSpecifiers', () => {
  it('extracts a plain mod declaration', () => {
    expect(extractRustModSpecifiers('mod foo;')).toEqual(['foo']);
  });

  it('extracts a pub mod declaration', () => {
    expect(extractRustModSpecifiers('pub mod foo;\npub(crate) mod bar;')).toEqual(['foo', 'bar']);
  });

  it('ignores an inline mod block -- there is no separate file to link to', () => {
    expect(extractRustModSpecifiers('mod foo {\n    pub fn x() {}\n}')).toEqual([]);
  });

  it('deduplicates repeated declarations', () => {
    expect(extractRustModSpecifiers('mod foo;\nmod foo;')).toEqual(['foo']);
  });
});

describe('resolveRustModSpecifier', () => {
  const tracked = new Set(['src/lib.rs', 'src/foo.rs', 'src/bar/mod.rs', 'src/foo/nested.rs']);

  it('resolves a sibling module from the crate root (lib.rs)', () => {
    expect(resolveRustModSpecifier('src/lib.rs', 'foo', tracked)).toBe('src/foo.rs');
  });

  it('resolves a directory-style submodule (mod.rs) from the crate root', () => {
    expect(resolveRustModSpecifier('src/lib.rs', 'bar', tracked)).toBe('src/bar/mod.rs');
  });

  it('resolves a non-mod.rs file\'s submodule into its same-named directory', () => {
    expect(resolveRustModSpecifier('src/foo.rs', 'nested', tracked)).toBe('src/foo/nested.rs');
  });

  it('returns null when nothing matches', () => {
    expect(resolveRustModSpecifier('src/lib.rs', 'missing', tracked)).toBeNull();
  });
});

describe('extractJavaImportSpecifiers', () => {
  it('extracts a class import and a wildcard import', () => {
    expect(extractJavaImportSpecifiers('import a.b.C;\nimport a.b.*;\n').sort()).toEqual(['a.b.*', 'a.b.C'].sort());
  });

  it('skips a static import', () => {
    expect(extractJavaImportSpecifiers('import static a.b.C.member;')).toEqual([]);
  });

  it('deduplicates repeated imports', () => {
    expect(extractJavaImportSpecifiers('import a.b.C;\nimport a.b.C;')).toEqual(['a.b.C']);
  });
});

describe('resolveJavaSpecifier', () => {
  const tracked = new Set(['src/main/java/a/b/C.java', 'src/main/java/a/b/D.java', 'src/main/java/a/b/other/E.java']);

  it('resolves a single class import by suffix match', () => {
    expect(resolveJavaSpecifier('a.b.C', tracked)).toEqual(['src/main/java/a/b/C.java']);
  });

  it('resolves a wildcard import to every class directly in that package, not a nested one', () => {
    expect(resolveJavaSpecifier('a.b.*', tracked).sort()).toEqual(['src/main/java/a/b/C.java', 'src/main/java/a/b/D.java'].sort());
  });

  it('returns [] for a single-class import with no match', () => {
    expect(resolveJavaSpecifier('a.b.Missing', tracked)).toEqual([]);
  });

  it('returns [] rather than guessing when a suffix would match more than one file', () => {
    const ambiguous = new Set(['src/main/java/a/b/C.java', 'other-root/a/b/C.java']);
    expect(resolveJavaSpecifier('a.b.C', ambiguous)).toEqual([]);
  });

  it('returns [] for a wildcard rather than merging two unrelated packages that share a directory suffix', () => {
    const twoModules = new Set(['alpha/foo/X.java', 'beta/foo/Y.java']);
    expect(resolveJavaSpecifier('foo.*', twoModules)).toEqual([]);
  });
});

describe('extractPhpIncludeSpecifiers', () => {
  it('extracts a __DIR__-anchored require', () => {
    expect(extractPhpIncludeSpecifiers("require __DIR__ . '/config.php';")).toEqual(['/config.php']);
  });

  it('extracts a dirname(__FILE__)-anchored include_once with parens', () => {
    expect(extractPhpIncludeSpecifiers("include_once(dirname(__FILE__) . '/legacy.php');")).toEqual(['/legacy.php']);
  });

  it('skips a bare unanchored require -- resolves against CWD/include_path in real PHP, not this file', () => {
    expect(extractPhpIncludeSpecifiers("require 'config.php';")).toEqual([]);
  });

  it('deduplicates repeated specifiers', () => {
    expect(extractPhpIncludeSpecifiers("require __DIR__ . '/a.php';\nrequire __DIR__ . '/a.php';")).toEqual(['/a.php']);
  });
});

describe('resolvePhpSpecifier', () => {
  const tracked = new Set(['app/config.php', 'lib/util.php']);

  it('resolves a sibling file', () => {
    expect(resolvePhpSpecifier('app/index.php', '/config.php', tracked)).toBe('app/config.php');
  });

  it('resolves an up-directory specifier', () => {
    expect(resolvePhpSpecifier('app/index.php', '/../lib/util.php', tracked)).toBe('lib/util.php');
  });

  it('appends .php when the specifier omits it', () => {
    expect(resolvePhpSpecifier('app/index.php', '/config', tracked)).toBe('app/config.php');
  });

  it('returns null when nothing matches', () => {
    expect(resolvePhpSpecifier('app/index.php', '/missing.php', tracked)).toBeNull();
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

  it('resolves a real-world flat-script Python edge: a bare same-directory import with no leading dot', async () => {
    // The style found dogfooding two real local projects (ComfyUI-Manager,
    // ai-content-factory) 2026-08-21: neither used a single PEP 328 relative
    // import, both import sibling files this way.
    const dir = mkdtempSync(join(tmpdir(), 'nexusmem-structure-py-bare-'));
    const g = (...args: string[]) => gitFixture(dir, args, { env: GIT_ENV });
    g('init', '-q', '-b', 'main');

    writeFileSync(join(dir, 'app.py'), 'import os\nimport agents\nfrom memory_manager import get_memory\n');
    writeFileSync(join(dir, 'agents.py'), 'def run():\n    pass\n');
    writeFileSync(join(dir, 'memory_manager.py'), 'def get_memory():\n    pass\n');

    g('add', '.');
    g('commit', '-q', '-m', 'chore: initial commit');

    const { edges } = await collectFileEdges(dir);

    expect(edges.sort((a, b) => a.toPath.localeCompare(b.toPath))).toEqual([
      { fromPath: 'app.py', toPath: 'agents.py', kind: 'import' },
      { fromPath: 'app.py', toPath: 'memory_manager.py', kind: 'import' },
    ]);
  });

  it('resolves a Go internal import to every non-test file in the imported package', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexusmem-structure-go-'));
    const g = (...args: string[]) => gitFixture(dir, args, { env: GIT_ENV });
    g('init', '-q', '-b', 'main');

    writeFileSync(join(dir, 'go.mod'), 'module acme/widget\n\ngo 1.22\n');
    writeFileSync(join(dir, 'main.go'), 'package main\n\nimport "acme/widget/internal/util"\n\nfunc main() {}\n');
    mkdirSync(join(dir, 'internal', 'util'), { recursive: true });
    writeFileSync(join(dir, 'internal', 'util', 'a.go'), 'package util\n');
    writeFileSync(join(dir, 'internal', 'util', 'b.go'), 'package util\n');
    writeFileSync(join(dir, 'internal', 'util', 'b_test.go'), 'package util\n');

    g('add', '.');
    g('commit', '-q', '-m', 'chore: initial commit');

    const { edges, filesScanned } = await collectFileEdges(dir);

    expect(filesScanned).toBe(4); // go.mod is not a tracked pathspec
    expect(edges.sort((a, b) => a.toPath.localeCompare(b.toPath))).toEqual([
      { fromPath: 'main.go', toPath: 'internal/util/a.go', kind: 'import' },
      { fromPath: 'main.go', toPath: 'internal/util/b.go', kind: 'import' },
    ]);
  });

  it('resolves a Rust mod declaration to its sibling file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexusmem-structure-rust-'));
    const g = (...args: string[]) => gitFixture(dir, args, { env: GIT_ENV });
    g('init', '-q', '-b', 'main');

    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'lib.rs'), 'mod util;\n');
    writeFileSync(join(dir, 'src', 'util.rs'), 'pub fn run() {}\n');

    g('add', '.');
    g('commit', '-q', '-m', 'chore: initial commit');

    const { edges, filesScanned } = await collectFileEdges(dir);

    expect(filesScanned).toBe(2);
    expect(edges).toEqual([{ fromPath: 'src/lib.rs', toPath: 'src/util.rs', kind: 'import' }]);
  });

  it('resolves a Java class import by suffix match against the real tracked source tree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexusmem-structure-java-'));
    const g = (...args: string[]) => gitFixture(dir, args, { env: GIT_ENV });
    g('init', '-q', '-b', 'main');

    mkdirSync(join(dir, 'src', 'main', 'java', 'a', 'b'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'main', 'java', 'a', 'b', 'Main.java'),
      'package a.b;\n\nimport a.b.Helper;\n\nclass Main {}\n',
    );
    writeFileSync(join(dir, 'src', 'main', 'java', 'a', 'b', 'Helper.java'), 'package a.b;\n\nclass Helper {}\n');

    g('add', '.');
    g('commit', '-q', '-m', 'chore: initial commit');

    const { edges, filesScanned } = await collectFileEdges(dir);

    expect(filesScanned).toBe(2);
    expect(edges).toEqual([
      { fromPath: 'src/main/java/a/b/Main.java', toPath: 'src/main/java/a/b/Helper.java', kind: 'import' },
    ]);
  });

  it('resolves a PHP __DIR__-anchored require to a real sibling file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexusmem-structure-php-'));
    const g = (...args: string[]) => gitFixture(dir, args, { env: GIT_ENV });
    g('init', '-q', '-b', 'main');

    writeFileSync(join(dir, 'index.php'), "<?php\nrequire __DIR__ . '/config.php';\n");
    writeFileSync(join(dir, 'config.php'), '<?php\nreturn [];\n');

    g('add', '.');
    g('commit', '-q', '-m', 'chore: initial commit');

    const { edges, filesScanned } = await collectFileEdges(dir);

    expect(filesScanned).toBe(2);
    expect(edges).toEqual([{ fromPath: 'index.php', toPath: 'config.php', kind: 'import' }]);
  });
});
