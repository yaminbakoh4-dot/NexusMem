/**
 * FTS5 has its own query language (`AND`, `OR`, `NEAR`, `*`, `^`, `:` column
 * filters). User input must never reach it raw -- a stray `"` or a bare `OR`
 * turns a search into a syntax error.
 */

/** Characters FTS5 treats as syntax rather than text. */
const FTS_SYNTAX = /["'()*:^{}[\]-]/g;

/**
 * Turn free-form user text into a safe FTS5 MATCH expression.
 *
 * Each token becomes a quoted prefix term, and tokens are OR-ed so that a
 * multi-word question still finds partially matching nodes -- bm25 ranking
 * then rewards the nodes that matched more of them.
 */
export function toMatchQuery(input: string): string | null {
  const tokens = input
    .replace(FTS_SYNTAX, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return null;

  return tokens.map((t) => `"${t}"*`).join(' OR ');
}
