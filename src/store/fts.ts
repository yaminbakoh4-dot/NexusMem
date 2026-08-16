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

function significantTokens(input: string): string[] {
  const tokens = input
    .replace(FTS_SYNTAX, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return [];

  // Drop low-signal tokens, but never down to zero: a query that is only
  // "id" must still search for something rather than matching nothing.
  const signal = tokens.filter((t) => !LOW_SIGNAL_TOKENS.has(t.toLowerCase()));
  return signal.length > 0 ? signal : tokens;
}

/**
 * Turn free-form user text into a safe FTS5 MATCH expression.
 *
 * Each token becomes a quoted prefix term, and tokens are OR-ed so that a
 * multi-word question still finds partially matching nodes -- bm25 ranking
 * then rewards the nodes that matched more of them.
 */
export function toMatchQuery(input: string): string | null {
  const kept = significantTokens(input);
  if (kept.length === 0) return null;

  return kept.map((t) => `"${t}"*`).join(' OR ');
}

/**
 * Same tokenization as `toMatchQuery`, but AND-ed rather than OR-ed --
 * every significant token must appear for a match. Built for
 * `failure-fix.ts`'s discussion-bridge heuristic, which found (dogfooding
 * against this repo's real history) that a single shared generic token was
 * enough to link a failure to a wholly unrelated discussion, e.g. an
 * "npm whoami" failure matched to a summary that merely mentions "npm" in
 * passing. Requiring every token cuts recall -- a discussion that paraphrases
 * the command instead of naming it will not match -- but a false positive
 * here silently attaches the wrong "fix" to a real failure, which is worse
 * than finding none.
 */
export function toStrictMatchQuery(input: string): string | null {
  const kept = significantTokens(input);
  if (kept.length === 0) return null;

  return kept.map((t) => `"${t}"*`).join(' AND ');
}
