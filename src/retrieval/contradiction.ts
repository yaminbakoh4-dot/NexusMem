import { DEFAULT_SLM_MODEL, type SummarizationProvider } from '../slm/provider.js';
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
  /** How many stale candidates to examine at all. Default 10. */
  limit?: number;
  /** Nearest-neighbour nodes considered per candidate before picking the closest newer one. Default 25. */
  neighborLimit?: number;
  /**
   * Cap on *new* SLM judgments this run -- an already-judged pair costs
   * nothing and does not count against it. Unset means every candidate
   * within `limit` may be judged. This is what lets a bounded automatic
   * run on sync coexist with an unbounded explicit `stale` run.
   */
  maxJudgments?: number;
  /** Model tag recorded with each judgment. Informational; the provider decides what actually runs. */
  model?: string;
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
 * content comparison, not just age. Suggest-only: the only write is the
 * memoized judgment itself, never `supersedes`. A human still runs
 * `mark-stale` themselves on whichever ids this confirms, same as the plain
 * heuristic list.
 *
 * No distance floor gates which neighbour gets sent to the model: the SLM is
 * the semantic judge, so an unrelated "nearest" neighbour should just get a
 * NO verdict rather than needing a second, hand-picked similarity threshold
 * to filter it out first.
 *
 * Judgments are memoized (`contradiction_checks`, either verdict): a pair the
 * model already ruled on is skipped outright -- no embed of the candidate, no
 * chat call -- so re-running against the same corpus converges to zero model
 * calls. Each *new* judgment costs one chat completion, plus one embedding
 * call only for a candidate that has no stored vector yet (post-sync, almost
 * none). Bounded by `limit`/`maxJudgments` so a large backlog doesn't turn
 * one run into hundreds of model calls. Either provider being unavailable
 * degrades a candidate to "no suggestion" and records nothing (so the pair
 * is retried next run), never an error -- same contract as every other use
 * of these providers.
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
  const model = opts.model ?? DEFAULT_SLM_MODEL;
  const suggestions: ContradictionSuggestion[] = [];
  let judgments = 0;
  let consecutiveNullReplies = 0;

  for (const candidate of candidates.slice(0, limit)) {
    if (opts.maxJudgments !== undefined && judgments >= opts.maxJudgments) break;

    const full = store.getNodesByIds([candidate.id])[0];
    if (!full) continue;

    const embedding = store.getEmbedding(candidate.id) ?? (await embeddingProvider.embed(`${full.title}\n${full.body}`));
    if (!embedding) continue;

    const candidateEpoch = Date.parse(candidate.ts);
    const nearest = store
      .vectorSearch(projectId, embedding, neighborLimit + 1)
      .find((hit) => hit.id !== candidate.id && Date.parse(hit.ts) > candidateEpoch);
    if (!nearest) continue;

    if (store.hasContradictionCheck(candidate.id, nearest.id)) continue;

    const reply = await slmProvider.complete(buildContradictionPrompt(full, nearest));
    if (!reply) {
      // Two nulls in a row reads as "provider is down", not two unlucky
      // prompts -- stop burning a timeout per remaining candidate.
      consecutiveNullReplies += 1;
      if (consecutiveNullReplies >= 2) break;
      continue;
    }
    consecutiveNullReplies = 0;

    const verdict = parseContradictionVerdict(reply);
    if (!verdict) continue; // malformed reply: not trustworthy either way, leave the pair unrecorded for a retry

    judgments += 1;
    store.recordContradictionCheck({
      candidateId: candidate.id,
      againstId: nearest.id,
      contradicts: verdict.contradicts,
      reason: verdict.contradicts ? verdict.reason : null,
      model,
    });
    if (!verdict.contradicts) continue;

    suggestions.push({
      candidateId: candidate.id,
      againstId: nearest.id,
      againstTitle: nearest.title,
      reason: verdict.reason,
    });
  }

  return suggestions;
}
