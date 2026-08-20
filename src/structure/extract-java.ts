/**
 * Regex extraction of Java `import` specifiers (`import a.b.C;` or the
 * wildcard `import a.b.*;`). `import static ...` is skipped -- the member
 * name after the class isn't reliably distinguishable from a nested class
 * name by text alone, same "missed edge over wrong one" bar as everywhere
 * else here.
 */

const IMPORT_PATTERN = /\bimport\s+(?!static\b)([\w.]+(?:\.\*)?)\s*;/g;

export function extractJavaImportSpecifiers(source: string): string[] {
  const seen = new Set<string>();
  IMPORT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMPORT_PATTERN.exec(source)) !== null) {
    seen.add(match[1]!);
  }
  return [...seen];
}
