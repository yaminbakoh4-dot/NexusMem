export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** Rough heuristic for English-dominant text: ~4 chars per token. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
