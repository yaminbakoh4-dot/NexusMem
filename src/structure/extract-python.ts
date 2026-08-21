/**
 * Regex extraction of Python import specifiers. Two shapes are handled:
 *
 * - **Relative** (`from .foo import bar`, `from . import x`) -- always safe,
 *   the leading dot(s) unambiguously anchor it to this package.
 * - **Bare, same-directory** (`import foo`, `from foo import bar`) -- only
 *   when the module name has *no* dots. A real-world dogfood pass (2026-08-21,
 *   against ComfyUI-Manager and a second local project) found this is
 *   actually the dominant style in flat, unpackaged Python scripts: neither
 *   real project used a single relative-dot import, yet both import sibling
 *   files this way (`import manager_core`, `from memory_manager import ...`).
 *   `resolvePythonSpecifier` is what keeps this safe (same-directory only,
 *   stdlib-name guarded) -- extraction alone cannot tell "foo" apart from a
 *   third-party package.
 *
 * A *dotted* absolute import (`import os.path`, `from numpy.random import
 * default_rng`) is still skipped entirely, same as before: it could be
 * stdlib, third-party, or this project's own top-level package, and even if
 * local it names an arbitrary path, not necessarily a subdirectory of the
 * importing file -- no way to tell apart from text alone.
 */

const RELATIVE_IMPORT_PATTERN = /\bfrom\s+(\.+)([\w.]*)\s+import\s+([^\n]+)/g;
const BARE_FROM_IMPORT_PATTERN = /^[ \t]*from\s+([A-Za-z_]\w*)\s+import\b/gm;
const BARE_IMPORT_PATTERN = /^[ \t]*import\s+([^\n]+)/gm;

function cleanNames(raw: string): string[] {
  return raw
    .split('#')[0]!
    .replace(/[()]/g, '')
    .split(',')
    .map((token) => token.trim().split(/\s+as\s+/)[0]!.trim())
    .filter((name) => /^[A-Za-z_]\w*$/.test(name));
}

/**
 * Every import specifier found in `source`, deduplicated. Relative specifiers
 * keep their leading dots (`.foo`, `..pkg.sub`); bare same-directory ones are
 * returned dot-free (`foo`) so `resolvePythonSpecifier` can tell the two
 * shapes apart by presence of a leading dot alone.
 */
export function extractPythonImportSpecifiers(source: string): string[] {
  const seen = new Set<string>();

  RELATIVE_IMPORT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RELATIVE_IMPORT_PATTERN.exec(source)) !== null) {
    const dots = match[1]!;
    const module = match[2]!;
    if (module) {
      seen.add(dots + module);
      continue;
    }
    for (const name of cleanNames(match[3]!)) {
      seen.add(dots + name);
    }
  }

  BARE_FROM_IMPORT_PATTERN.lastIndex = 0;
  while ((match = BARE_FROM_IMPORT_PATTERN.exec(source)) !== null) {
    seen.add(match[1]!);
  }

  BARE_IMPORT_PATTERN.lastIndex = 0;
  while ((match = BARE_IMPORT_PATTERN.exec(source)) !== null) {
    // cleanNames already rejects anything containing a dot (its identifier
    // regex is anchored, no `.` in the character class), so a dotted
    // `import foo.bar` is dropped here for free, same as the `from` form.
    for (const name of cleanNames(match[1]!)) {
      seen.add(name);
    }
  }

  return [...seen];
}
