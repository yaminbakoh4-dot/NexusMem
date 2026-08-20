/**
 * Regex extraction of Go import paths from both the single-line `import
 * "path"` form and the grouped `import ( ... )` block form. An alias, the
 * blank identifier (`_`) or a dot import are just a prefix before the quoted
 * path and are stripped -- only the path itself becomes the edge.
 */

const SINGLE_IMPORT = /\bimport\s+(?:[\w.]+\s+)?"([^"]+)"/g;
const IMPORT_BLOCK = /\bimport\s*\(([\s\S]*?)\)/g;
const BLOCK_LINE = /(?:^|\n)\s*(?:[\w.]+\s+)?"([^"]+)"/g;

export function extractGoImportSpecifiers(source: string): string[] {
  const seen = new Set<string>();

  IMPORT_BLOCK.lastIndex = 0;
  let block: RegExpExecArray | null;
  while ((block = IMPORT_BLOCK.exec(source)) !== null) {
    BLOCK_LINE.lastIndex = 0;
    let line: RegExpExecArray | null;
    while ((line = BLOCK_LINE.exec(block[1]!)) !== null) {
      seen.add(line[1]!);
    }
  }

  SINGLE_IMPORT.lastIndex = 0;
  let single: RegExpExecArray | null;
  while ((single = SINGLE_IMPORT.exec(source)) !== null) {
    seen.add(single[1]!);
  }

  return [...seen];
}
