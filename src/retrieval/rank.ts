import type { SearchHit } from '../store/store.js';

export interface RankedHit extends SearchHit {
  /** 0..1, normalized from bm25 within this result set. 1 = best lexical match. */
  relevance: number;
  /** 0..1, structural importance rescaled so it can never zero out relevance. */
  signalWeight: number;
  /** 0..1, decays with age but never below the floor. */
  recencyFactor: number;
  ageDays: number;
  /** relevance * signalWeight * recencyFactor. Sort key, best first. */
  score: number;
}

export interface RankOptions {
  /** Days for the recency factor to halve. Default 30. */
  halfLifeDays?: number;
  /** Injectable for deterministic tests; defaults to the real clock. */
  now?: Date;
}

/**
 * Floors on each factor.
 *
 * Every factor lives in [floor, 1] rather than [0, 1]. Multiplying three
 * [0,1] terms lets any single dimension crush the other two to zero -- an
 * old-but-perfect match would lose to a recent-but-mediocre one purely on
 * age. Floors keep the combination a *reordering* within each dimension
 * instead of an on/off gate.
 */
const RELEVANCE_FLOOR = 0.15;
const SIGNAL_FLOOR = 0.2;
const RECENCY_FLOOR = 0.3;
const DEFAULT_HALF_LIFE_DAYS = 30;
const MS_PER_DAY = 86_400_000;

/**
 * bm25() in SQLite is a *cost*: smaller (more negative) is a better match.
 * Min-max normalize within this result set so the scale is comparable across
 * queries, then rescale into [RELEVANCE_FLOOR, 1].
 */
function normalizeRelevance(hits: readonly SearchHit[]): number[] {
  const costs = hits.map((h) => h.rank);
  const min = Math.min(...costs);
  const max = Math.max(...costs);

  if (min === max) return hits.map(() => 1);

  return costs.map((cost) => {
    const normalized = (max - cost) / (max - min); // best cost -> 1, worst -> 0
    return RELEVANCE_FLOOR + (1 - RELEVANCE_FLOOR) * normalized;
  });
}

function ageDaysOf(ts: string, now: Date): number {
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, (now.getTime() - parsed) / MS_PER_DAY);
}

/**
 * Combine lexical match quality, structural importance and recency into one
 * score, and return hits sorted best-first.
 *
 * This is the layer the whole "signal at ingest time" design pays off in:
 * `signalWeight` is what keeps a `fix:` commit ahead of an equally-relevant
 * `chore:` one, without a query-time re-analysis of either.
 */
export function rankHits(hits: readonly SearchHit[], opts: RankOptions = {}): RankedHit[] {
  if (hits.length === 0) return [];

  const halfLife = opts.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const now = opts.now ?? new Date();
  const relevances = normalizeRelevance(hits);

  const ranked = hits.map((hit, i) => {
    const relevance = relevances[i] ?? RELEVANCE_FLOOR;
    const signalWeight = SIGNAL_FLOOR + (1 - SIGNAL_FLOOR) * hit.signal;
    const ageDays = ageDaysOf(hit.ts, now);
    const recencyFactor = RECENCY_FLOOR + (1 - RECENCY_FLOOR) * 2 ** (-ageDays / halfLife);

    return { ...hit, relevance, signalWeight, ageDays, recencyFactor, score: relevance * signalWeight * recencyFactor };
  });

  return ranked.sort((a, b) => b.score - a.score);
}
