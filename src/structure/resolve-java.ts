import { posix } from 'node:path';

function endsAtSegmentBoundary(path: string, suffix: string): boolean {
  return path === suffix || path.endsWith(`/${suffix}`);
}

/**
 * Resolve a Java import specifier (`a.b.C` or `a.b.*`) against the
 * tracked-path set by suffix match on the dotted package+class name -- Java
 * imports are fully-qualified from a source root (`src/main/java/...`) this
 * pass never computes explicitly, so a real file is found by asking "does
 * any tracked path end with this exact dotted path" instead of guessing the
 * root. A wildcard import genuinely depends on every class in that package,
 * so it returns every match; a single-class import returns one only when
 * the match is unambiguous -- more than one hit means guessing which file
 * is real, which this pass refuses to do.
 */
export function resolveJavaSpecifier(specifier: string, trackedPaths: ReadonlySet<string>): string[] {
  const isWildcard = specifier.endsWith('.*');
  const segments = (isWildcard ? specifier.slice(0, -2) : specifier).split('.').filter(Boolean);
  if (segments.length === 0) return [];

  if (isWildcard) {
    const dirSuffix = segments.join('/');
    return [...trackedPaths].filter((p) => p.endsWith('.java') && endsAtSegmentBoundary(posix.dirname(p), dirSuffix)).sort();
  }

  const fileSuffix = `${segments.join('/')}.java`;
  const matches = [...trackedPaths].filter((p) => endsAtSegmentBoundary(p, fileSuffix));
  return matches.length === 1 ? matches : [];
}
