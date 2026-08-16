import { posix } from 'node:path';

/**
 * TS/ESM projects commonly write `import './foo.js'` in source that is
 * actually `foo.ts` (this repo's own source does exactly this -- see any
 * `src/**\/*.ts` import). A `.js`/`.jsx`/`.mjs`/`.cjs` specifier extension is
 * therefore not trusted literally; the real source extension is tried first.
 */
const REWRITE_EXTENSIONS: Record<string, readonly string[]> = {
  '.js': ['.ts', '.tsx', '.js'],
  '.jsx': ['.tsx', '.jsx'],
  '.mjs': ['.mts', '.mjs'],
  '.cjs': ['.cts', '.cjs'],
};

const APPEND_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.d.ts', '.json'];
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];

/**
 * Resolve a relative import specifier (already filtered to `./`/`../` by
 * `extractImportSpecifiers`) against the set of tracked project paths.
 * Returns `null` rather than guessing when nothing in `trackedPaths` matches
 * -- a missed edge is preferable to a wrong one.
 */
export function resolveSpecifier(fromPath: string, specifier: string, trackedPaths: ReadonlySet<string>): string | null {
  const fromDir = posix.dirname(fromPath);
  const joined = posix.normalize(posix.join(fromDir, specifier));

  if (trackedPaths.has(joined)) return joined;

  const ext = posix.extname(joined);
  const rewrites = REWRITE_EXTENSIONS[ext];
  if (rewrites) {
    const base = joined.slice(0, -ext.length);
    for (const replacement of rewrites) {
      const candidate = base + replacement;
      if (trackedPaths.has(candidate)) return candidate;
    }
    return null;
  }

  if (ext) return null; // a real, non-rewritable extension that just isn't tracked

  for (const suffix of APPEND_EXTENSIONS) {
    const candidate = joined + suffix;
    if (trackedPaths.has(candidate)) return candidate;
  }
  for (const indexFile of INDEX_FILES) {
    const candidate = posix.join(joined, indexFile);
    if (trackedPaths.has(candidate)) return candidate;
  }
  return null;
}
