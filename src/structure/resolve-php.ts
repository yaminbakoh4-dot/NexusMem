import { posix } from 'node:path';

/**
 * Resolve a `__DIR__`-anchored PHP include specifier (already stripped of
 * the anchor by `extractPhpIncludeSpecifiers`, e.g. `/foo.php` or
 * `/../lib/util.php`) against the tracked-path set, relative to `fromPath`'s
 * own directory.
 */
export function resolvePhpSpecifier(fromPath: string, specifier: string, trackedPaths: ReadonlySet<string>): string | null {
  const fromDir = posix.dirname(fromPath);
  const relative = specifier.startsWith('/') ? specifier.slice(1) : specifier;
  const joined = posix.normalize(posix.join(fromDir, relative));

  if (trackedPaths.has(joined)) return joined;

  const withExt = joined.endsWith('.php') ? joined : `${joined}.php`;
  if (trackedPaths.has(withExt)) return withExt;

  return null;
}
