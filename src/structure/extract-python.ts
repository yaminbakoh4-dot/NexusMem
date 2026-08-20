/**
 * Regex extraction of *relative* Python import specifiers (`from .foo import
 * bar`, `from . import x`), mirroring `extract.ts`'s JS/TS scope: absolute
 * imports (`import os`, `from numpy import array`) are skipped, since they
 * could be stdlib, third-party, or this project's own top-level package with
 * no way to tell apart from text alone -- same "missed edge over wrong edge"
 * bar as JS/TS's bare-specifier skip.
 */

const RELATIVE_IMPORT_PATTERN = /\bfrom\s+(\.+)([\w.]*)\s+import\s+([^\n]+)/g;

function cleanNames(raw: string): string[] {
  return raw
    .split('#')[0]!
    .replace(/[()]/g, '')
    .split(',')
    .map((token) => token.trim().split(/\s+as\s+/)[0]!.trim())
    .filter((name) => /^[A-Za-z_]\w*$/.test(name));
}

/**
 * Dotted relative specifiers found in `source`, deduplicated. `from .foo
 * import bar` yields `.foo` (the module is the edge, same as JS/TS ignoring
 * which named export is used); `from . import x, y` yields `.x` and `.y`,
 * since each name could itself be a submodule file.
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
  return [...seen];
}
