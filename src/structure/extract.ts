/**
 * Pure regex extraction of relative import/require specifiers from a JS/TS
 * source file's text. No I/O, no AST -- matches this repo's existing style
 * (`git/parse.ts` hand-rolls regex over `git log` output rather than reaching
 * for a parser library) and keeps this feature dependency-free.
 *
 * Known, accepted limitations: a specifier inside a comment or string that
 * isn't actually an import will still be picked up (no syntax awareness),
 * and non-static forms (`import(someVariable)`, path aliases from
 * `tsconfig.json`) are invisible. Only relative specifiers (`./`, `../`) are
 * extracted -- bare package specifiers resolve into `node_modules`, outside
 * "files in this project".
 */

const IMPORT_PATTERNS = [
  // import ... from '...'; export ... from '...'
  /\b(?:import|export)\b[^'"\n]*?\bfrom\s*['"]([^'"]+)['"]/g,
  // import '...'; (side-effect only)
  /\bimport\s*['"]([^'"]+)['"]/g,
  // require('...')
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // dynamic import('...')
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
] as const;

/** Relative-specifier strings found in `source`, deduplicated, in first-seen order. */
export function extractImportSpecifiers(source: string): string[] {
  const seen = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1];
      if (specifier && (specifier.startsWith('./') || specifier.startsWith('../'))) {
        seen.add(specifier);
      }
    }
  }
  return [...seen];
}
