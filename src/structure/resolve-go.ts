import { posix } from 'node:path';

/** `go.mod`'s `module <path>` line, or null if absent/unparsable. */
export function parseGoModulePath(goModContent: string): string | null {
  const match = goModContent.match(/^module\s+(\S+)/m);
  return match ? match[1]! : null;
}

/**
 * Every tracked, non-test `.go` file in the package directory `importPath`
 * resolves to once `modulePath`'s prefix is stripped. Go imports a whole
 * package, not a single file, so a real dependency touches every source file
 * in that directory -- not one arbitrary pick. Returns `[]` for an external
 * import (stdlib or a different module) or when `modulePath` is unknown.
 */
export function resolveGoSpecifier(modulePath: string, importPath: string, trackedPaths: ReadonlySet<string>): string[] {
  let relDir: string;
  if (importPath === modulePath) {
    relDir = '.';
  } else if (importPath.startsWith(`${modulePath}/`)) {
    relDir = importPath.slice(modulePath.length + 1);
  } else {
    return [];
  }

  return [...trackedPaths].filter((p) => p.endsWith('.go') && !p.endsWith('_test.go') && posix.dirname(p) === relDir).sort();
}
