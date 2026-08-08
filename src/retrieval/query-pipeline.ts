import type { MemoryStore, SearchHit, VectorHit } from '../store/store.js';
import type { EmbeddingProvider } from '../vector/embed.js';
import { mergeSearchAndVectorHits, reciprocalRankFusion } from './fuse.js';
import { packContext, type PackResult } from './pack.js';
import { rankHits } from './rank.js';

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

  const ranked = rankHits(hits, { halfLifeDays: opts.halfLifeDays, relevanceScores });
  const packed = packContext(ranked, opts.budget);

  return { bm25Count: bm25Hits.length, vectorCount: vectorHits.length, hits, packed };
}
