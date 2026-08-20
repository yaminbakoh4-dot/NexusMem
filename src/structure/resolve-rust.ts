import { posix } from 'node:path';

/**
 * Resolve a Rust `mod name;` declaration against the tracked-path set,
 * following 2018+ edition module resolution: a crate-root or `mod.rs` file's
 * submodules sit beside it (`name.rs` / `name/mod.rs`); any other file
 * `foo.rs`'s submodules sit in a same-named directory (`foo/name.rs` /
 * `foo/name/mod.rs`). Pre-2018 edition layouts are not handled.
 */
export function resolveRustModSpecifier(fromPath: string, name: string, trackedPaths: ReadonlySet<string>): string | null {
  const dir = posix.dirname(fromPath);
  const base = posix.basename(fromPath, '.rs');
  const moduleDir = base === 'mod' || base === 'lib' || base === 'main' ? dir : posix.join(dir, base);

  const sibling = posix.join(moduleDir, `${name}.rs`);
  if (trackedPaths.has(sibling)) return sibling;

  const nested = posix.join(moduleDir, name, 'mod.rs');
  if (trackedPaths.has(nested)) return nested;

  return null;
}
