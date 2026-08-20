import { posix } from 'node:path';

/**
 * Resolve a dotted relative Python specifier (already filtered to a leading
 * `.`/`..`/etc. by `extractPythonImportSpecifiers`) against the tracked-path
 * set. Level 1 (`.`) means the current package -- the directory holding
 * `fromPath` -- and each extra dot goes up one more directory, matching
 * Python's own relative-import semantics. Returns `null` when nothing in
 * `trackedPaths` matches, same "missed edge over wrong one" default as
 * `resolve.ts`.
 */
export function resolvePythonSpecifier(fromPath: string, specifier: string, trackedPaths: ReadonlySet<string>): string | null {
  const dotsMatch = specifier.match(/^\.+/);
  if (!dotsMatch) return null;

  const level = dotsMatch[0].length;
  const segments = specifier.slice(level).split('.').filter(Boolean);
  if (segments.length === 0) return null;

  let dir = posix.dirname(fromPath);
  for (let i = 1; i < level; i++) {
    dir = posix.dirname(dir);
  }

  const joined = posix.join(dir, ...segments);

  const moduleFile = `${joined}.py`;
  if (trackedPaths.has(moduleFile)) return moduleFile;

  const packageInit = posix.join(joined, '__init__.py');
  if (trackedPaths.has(packageInit)) return packageInit;

  return null;
}
