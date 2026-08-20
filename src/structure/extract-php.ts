/**
 * Regex extraction of PHP `require`/`include`(`_once`) targets, anchored to
 * `__DIR__` or `dirname(__FILE__)`. A bare `require 'foo.php'` is skipped on
 * purpose: PHP resolves an unanchored relative path against the current
 * working directory or `include_path`, not the including file's own
 * directory, so treating it as "relative to this file" would be a genuine
 * wrong-edge guess, not just a stylistic gap. `use Namespace\Class;` is also
 * out of scope -- resolving that needs composer.json's PSR-4 autoload map,
 * which this pass does not parse.
 */

const ANCHORED_INCLUDE = /\b(?:require|include)(?:_once)?\b\s*\(?\s*(?:__DIR__|dirname\s*\(\s*__FILE__\s*\))\s*\.\s*['"]([^'"]+)['"]/g;

export function extractPhpIncludeSpecifiers(source: string): string[] {
  const seen = new Set<string>();
  ANCHORED_INCLUDE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ANCHORED_INCLUDE.exec(source)) !== null) {
    seen.add(match[1]!);
  }
  return [...seen];
}
