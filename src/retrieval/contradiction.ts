import type { SummarizationProvider } from '../slm/provider.js';
import { buildContradictionPrompt, parseContradictionVerdict } from '../slm/contradiction.js';
import type { StaleCandidate } from '../store/nodes.js';
import type { MemoryStore } from '../store/store.js';
import type { EmbeddingProvider } from '../vector/embed.js';

export interface ContradictionSuggestion {
  /** Same id as the `StaleCandidate` it was found for. */
  candidateId: string;
  /** The newer node the model believes replaces it. */
  againstId: string;
  againstTitle: string;
  reason: string;
}

export interface CheckContradictionsOptions {
  /** How many stale candidates to actually run through the SLM. Bounds cost. Default 10. */
  limit?: number;
  /** Nearest-neighbour nodes considered per candidate before picking the closest newer one. Default 25. */
  neighborLimit?: number;
}

const DEFAULT_LIMIT = 10;
/**
 * Dogfooded against this repo's own real corpus (`nexusmem stale --check-contradictions`):
 * a long conversation gets chunked into many same-timestamp nodes, and those siblings
 * dominate a candidate's own nearest neighbours by construction (near-identical phrasing).
 * Measured 15 same-cluster siblings ranked ahead of the first genuinely newer node, across
 * 10 real candidates -- a limit of 5 never escaped the cluster, so every candidate silently
 * got zero suggestions regardless of the SLM. 25 clears that with margin.
 */
const DEFAULT_NEIGHBOR_LIMIT = 25;

/**
 * For each stale candidate (already surfaced by `listStaleCandidates`), find
 * the most similar node newer than it via vector search, then ask the local
 * SLM whether the newer one actually contradicts the older one -- real
 * content comparison, not just age. Suggest-only: nothing is written here. A
 * human still runs `mark-stale` themselves on whichever ids this confirms,
 * same as the plain heuristic list.
 *
 * No distance floor gates which neighbour gets sent to the model: the SLM is
 * the semantic judge, so an unrelated "nearest" neighbour should just get a
 * NO verdict rather than needing a second, hand-picked similarity threshold
 * to filter it out first.
 *
 * Costs one embedding call and, when a newer node exists at all, one chat
 * completion per candidate -- bounded by `limit` so a large backlog doesn't
 * turn one `stale` run into hundreds of model calls. Either provider being
 * unavailable degrades a candidate to "no suggestion", never an error --
 * same contract as every other use of these providers.
 */
export async function checkContradictions(
  store: MemoryStore,
  embeddingProvider: EmbeddingProvider,
  slmProvider: SummarizationProvider,
  projectId: string,
  candidates: readonly StaleCandidate[],
  opts: CheckContradictionsOptions = {},
): Promise<ContradictionSuggestion[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const neighborLimit = opts.neighborLimit ?? DEFAULT_NEIGHBOR_LIMIT;
  const suggestions: ContradictionSuggestion[] = [];

  for (const candidate of candidates.slice(0, limit)) {
    const full = store.getNodesByIds([candidate.id])[0];
    if (!full) continue;

    const embedding = await embeddingProvider.embed(`${full.title}\n${full.body}`);
    if (!embedding) continue;

    const candidateEpoch = Date.parse(candidate.ts);
    const nearest = store
      .vectorSearch(projectId, embedding, neighborLimit + 1)
      .find((hit) => hit.id !== candidate.id && Date.parse(hit.ts) > candidateEpoch);
    if (!nearest) continue;

    const reply = await slmProvider.complete(buildContradictionPrompt(full, nearest));
    if (!reply) continue;

    const verdict = parseContradictionVerdict(reply);
    if (!verdict?.contradicts) continue;

    suggestions.push({
      candidateId: candidate.id,
      againstId: nearest.id,
      againstTitle: nearest.title,
      reason: verdict.reason,
    });
  }

  return suggestions;
}
