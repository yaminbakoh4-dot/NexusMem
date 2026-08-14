/**
 * FTS5 has its own query language (`AND`, `OR`, `NEAR`, `*`, `^`, `:` column
 * filters). User input must never reach it raw -- a stray `"` or a bare `OR`
 * turns a search into a syntax error.
 */

/** Characters FTS5 treats as syntax rather than text. */
const FTS_SYNTAX = /["'()*:^{}[\]-]/g;

/**
 * Tokens too generic to carry search signal on their own. bm25 rewards rare
 * terms, so a token that is common in *meaning* but happens to be rare in
 * *this* corpus gets an inflated score purely from scarcity, not relevance --
 * verified live: a query ending in "...PSID sender id" pulled an unrelated
 * `winget install --id ...` shell command into the results, because "id"
 * alone prefix-matched "--id" with nothing else to weigh it down.
 *
 * Deliberately not a general English stopword list -- a real signal token
 * lost is worse than a little noise kept, so this only excludes what
 * dogfooding has actually shown to be a problem. Short technical terms like
 * "ai"/"ui"/"db" are left alone.
 */
const LOW_SIGNAL_TOKENS = new Set(['id']);

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

  // Drop low-signal tokens, but never down to zero: a query that is only
  // "id" must still search for something rather than matching nothing.
  const signal = tokens.filter((t) => !LOW_SIGNAL_TOKENS.has(t.toLowerCase()));
  const kept = signal.length > 0 ? signal : tokens;

  return kept.map((t) => `"${t}"*`).join(' OR ');
}
