import type { MemoryStore } from '../store/store.js';
import type { EmbeddingProvider } from './embed.js';

export interface EmbedPendingResult {
  embedded: number;
  skipped: number;
  /** True if the provider never produced a single vector -- likely means Ollama isn't reachable at all. */
  providerUnavailable: boolean;
}

/**
 * Embed every node for a project that doesn't have a vector yet.
 *
 * A node with no embedding just doesn't participate in vector search --
 * BM25 still finds it. This is additive, not a gate: sync always succeeds
 * whether or not an embedding provider is available.
 */
export async function embedPendingNodes(
  store: MemoryStore,
  provider: EmbeddingProvider,
  projectId: string,
  opts: { batchLimit?: number } = {},
): Promise<EmbedPendingResult> {
  const pending = store.findNodesNeedingEmbedding(projectId, opts.batchLimit ?? 200);

  let embedded = 0;
  let skipped = 0;

  for (const node of pending) {
    const vector = await provider.embed(`${node.title}\n${node.body}`);
    if (vector && vector.length === provider.dimension) {
      store.upsertEmbedding(node.rowid, vector);
      embedded += 1;
    } else {
      skipped += 1;
    }
  }

  return { embedded, skipped, providerUnavailable: pending.length > 0 && embedded === 0 };
}
