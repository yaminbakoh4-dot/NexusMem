/**
 * Regex extraction of Rust `mod foo;` submodule declarations. Only the
 * file-declaring form (trailing `;`) names a real edge -- an inline `mod foo
 * { ... }` has no separate file to link to, and `use` paths are skipped: a
 * `crate::`/external path needs knowing the crate root or is third-party
 * entirely, and `self::`/`super::` still need a real resolver this pass
 * doesn't build. Same "missed edge over wrong one" scope discipline as the
 * other extractors.
 */

const MOD_DECLARATION = /\b(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/g;

export function extractRustModSpecifiers(source: string): string[] {
  const seen = new Set<string>();
  MOD_DECLARATION.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MOD_DECLARATION.exec(source)) !== null) {
    seen.add(match[1]!);
  }
  return [...seen];
}
