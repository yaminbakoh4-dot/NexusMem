import { RESOLVED_BY_RETRY } from '../correlate/failure-fix.js';
import type { MemoryStore, SearchHit, VectorHit } from '../store/store.js';
import type { EmbeddingProvider } from '../vector/embed.js';
import { mergeSearchAndVectorHits, reciprocalRankFusion } from './fuse.js';
import { packContext, type PackResult } from './pack.js';
import { rankHits, type RankedHit } from './rank.js';

/**
 * Pull a `shell_command` failure's linked resolution (`RESOLVED_BY_RETRY`
 * only -- see `failure-fix.ts`'s doc comment for why the discussion
 * heuristic stays unsurfaced) into the ranked list, immediately after the
 * failure, so it survives `packContext`'s budget/diversity cuts alongside it
 * instead of needing to earn its own place on query relevance alone. That is
 * the whole point of Phase 7's chain feature: a resolution the query never
 * mentioned should still ride along with the failure it resolves.
 *
 * The pulled-in node inherits its failure's relevance/signalWeight/
 * recencyFactor/score wholesale rather than computing its own: it has no
 * independent relevance to this query, and is included *because* it resolves
 * a hit that already matched, not because it matched on its own. A
 * resolution already present in `ranked` on its own merits is left
 * untouched, never duplicated.
 *
 * Single-project only for now -- `runCrossProjectQuery` merges hits from
 * several stores into one list, and a hit's originating store isn't
 * threaded through packContext's input shape yet. Not extended here;
 * cross-project chain-following is a known gap, not a silent omission.
 */
function pullLinkedResolutions(store: MemoryStore, ranked: readonly RankedHit[]): RankedHit[] {
  const present = new Set(ranked.map((hit) => hit.id));
  const withLinks: RankedHit[] = [];

  for (const hit of ranked) {
    withLinks.push(hit);
    if (hit.kind !== 'shell_command') continue;

    for (const linkedId of store.getLinkedNodeIds(hit.id, RESOLVED_BY_RETRY)) {
      if (present.has(linkedId)) continue;
      const [resolution] = store.getNodesByIds([linkedId]);
      if (!resolution) continue;

      present.add(linkedId);
      withLinks.push({
        id: resolution.id,
        kind: resolution.kind,
        ts: resolution.ts,
        title: resolution.title,
        body: resolution.body,
        signal: resolution.signal,
        rank: 0, // no bm25/vector rank of its own -- never read again past this point
        relevance: hit.relevance,
        signalWeight: hit.signalWeight,
        recencyFactor: hit.recencyFactor,
        ageDays: hit.ageDays,
        score: hit.score,
        ...(hit.project ? { project: hit.project } : {}),
      });
    }
  }

  return withLinks;
}

export interface HybridQueryOptions {
  budget: number;
  candidates: number;
  halfLifeDays?: number;
  /** `null`/omitted skips vector search entirely -- BM25-only, same behavior as before hybrid retrieval existed. */
  embeddingProvider?: EmbeddingProvider | null;
}

export interface HybridQueryResult {
  bm25Count: number;
  vectorCount: number;
  /** The full candidate set that was ranked (bm25 ∪ vector, deduped) -- for callers that need the raw, unpacked bodies (e.g. a "tokens if sent unpacked" comparison). */
  hits: SearchHit[];
  packed: PackResult;
}

/** One repository's memory, as an input to a cross-project query. */
export interface QuerySource {
  store: MemoryStore;
  projectId: string;
  /** Shown to the user next to each hit; must be unique across the sources of one query. */
  label: string;
}

export interface CrossProjectQueryResult extends HybridQueryResult {
  /** Per-source match counts, for reporting which repositories actually contributed. */
  perProject: Array<{ label: string; bm25: number; vector: number }>;
}

/**
 * Search several repositories at once and rank the results together.
 *
 * Node ids are `sha256(projectId + kind + naturalKey)`, so hits from
 * different databases cannot collide and the union needs no renaming.
 *
 * The one thing that does *not* survive the union is BM25's scale. A bm25()
 * cost is computed against its own corpus statistics, so -8.1 in a
 * ten-thousand-node repository and -8.1 in a fifty-node one are not the same
 * quality of match, and min-max normalizing them together silently invents a
 * comparison. RRF is therefore always applied here -- even with vector search
 * off, where a single-project query would normalize raw bm25 directly --
 * because each project's list is only ever compared against itself, by
 * position.
 *
 * Its known bias, stated rather than hidden: a project whose best match is
 * mediocre still contributes a rank-1 item, and rank 1 pays the same in every
 * list. Cross-project recall therefore favours breadth. `signal`, recency and
 * the budget are what keep that in check.
 */
export async function runCrossProjectQuery(
  sources: readonly QuerySource[],
  query: string,
  opts: HybridQueryOptions,
): Promise<CrossProjectQueryResult> {
  // One embedding for every source: the query is the same, and this is the
  // only network call on the path.
  const queryVector = opts.embeddingProvider ? await opts.embeddingProvider.embed(query) : null;

  const lists: SearchHit[][] = [];
  const hits: SearchHit[] = [];
  const perProject: CrossProjectQueryResult['perProject'] = [];
  let bm25Count = 0;
  let vectorCount = 0;

  for (const source of sources) {
    const label = (hit: SearchHit): SearchHit => ({ ...hit, project: source.label });

    const bm25Hits = source.store.search(source.projectId, query, opts.candidates).map(label);
    const vectorHits = queryVector
      ? source.store.vectorSearch(source.projectId, queryVector, opts.candidates)
      : [];

    bm25Count += bm25Hits.length;
    vectorCount += vectorHits.length;
    perProject.push({ label: source.label, bm25: bm25Hits.length, vector: vectorHits.length });

    if (bm25Hits.length > 0) lists.push(bm25Hits);
    if (vectorHits.length > 0) {
      lists.push(vectorHits.map((hit) => ({ ...hit, rank: 0, project: source.label })));
    }

    hits.push(...mergeSearchAndVectorHits(bm25Hits, vectorHits).map(label));
  }

  const relevanceScores = reciprocalRankFusion(lists);
  const ranked = rankHits(hits, { halfLifeDays: opts.halfLifeDays, relevanceScores });
  const packed = packContext(ranked, opts.budget, { query });

  return { bm25Count, vectorCount, hits, packed, perProject };
}

/**
 * The one retrieval pipeline both `nexusmem query` and the MCP `search_memory`
 * tool run -- BM25 search, optional vector search, RRF fusion when both
 * fired, then rank and pack. Kept in one place so the CLI and the MCP server
 * can never quietly drift into answering the same query differently.
 */
export async function runHybridQuery(
  store: MemoryStore,
  projectId: string,
  query: string,
  opts: HybridQueryOptions,
): Promise<HybridQueryResult> {
  const bm25Hits = store.search(projectId, query, opts.candidates);

  let vectorHits: VectorHit[] = [];
  if (opts.embeddingProvider) {
    const queryVector = await opts.embeddingProvider.embed(query);
    if (queryVector) vectorHits = store.vectorSearch(projectId, queryVector, opts.candidates);
  }

  const hits = vectorHits.length > 0 ? mergeSearchAndVectorHits(bm25Hits, vectorHits) : bm25Hits;
  const relevanceScores = vectorHits.length > 0 ? reciprocalRankFusion([bm25Hits, vectorHits]) : undefined;

  const ranked = pullLinkedResolutions(store, rankHits(hits, { halfLifeDays: opts.halfLifeDays, relevanceScores }));
  // The query reaches the packer as well as the searcher: for a diff node it
  // decides which hunk of an already-retrieved patch is worth the budget.
  const packed = packContext(ranked, opts.budget, { query });

  return { bm25Count: bm25Hits.length, vectorCount: vectorHits.length, hits, packed };
}
