import { makeProjectId } from '../core/project.js';
import { readRepoInfo } from '../git/repo.js';
import { renderContextBlock } from '../retrieval/pack.js';
import { runHybridQuery } from '../retrieval/query-pipeline.js';
import { resolveWorkspace } from '../config/workspace.js';
import { MemoryStore } from '../store/store.js';
import { OllamaEmbeddingProvider } from '../vector/embed.js';
import { runInit } from '../cli/commands/init.js';
import { runSync, type SyncOptions } from '../cli/commands/sync.js';

/**
 * Thin MCP-facing wrappers over the same CLI logic (`runSync`, the hybrid
 * query pipeline, `MemoryStore.stats`) -- no new business logic here. Every
 * tool takes an explicit `projectRoot` because, unlike a terminal command,
 * an MCP tool call carries no implicit shell cwd.
 */

export interface SearchMemoryInput {
  projectRoot: string;
  query: string;
  budget?: number;
  candidates?: number;
  /** BM25 only -- skip embedding the query and vector search. Mainly for tests; real callers want hybrid retrieval. */
  noVector?: boolean;
}

export interface SearchMemoryOutput {
  text: string;
  matched: number;
  bm25Matched: number;
  vectorMatched: number;
  tokensUsed: number;
  tokensBudget: number;
}

export async function searchMemory(input: SearchMemoryInput): Promise<SearchMemoryOutput> {
  const repo = await readRepoInfo(input.projectRoot);
  const ws = resolveWorkspace(repo.root);
  const projectId = makeProjectId({ root: repo.root, originUrl: repo.originUrl });
  const budget = input.budget ?? 2000;
  const candidates = input.candidates ?? 30;

  const store = MemoryStore.open(ws.dbPath);
  try {
    const { bm25Count, vectorCount, hits, packed } = await runHybridQuery(store, projectId, input.query, {
      budget,
      candidates,
      embeddingProvider: input.noVector ? null : new OllamaEmbeddingProvider(),
    });

    return {
      text: renderContextBlock(input.query, packed),
      matched: hits.length,
      bm25Matched: bm25Count,
      vectorMatched: vectorCount,
      tokensUsed: packed.tokensUsed,
      tokensBudget: packed.tokensBudget,
    };
  } finally {
    store.close();
  }
}

export interface SyncProjectInput {
  projectRoot: string;
  /** Skip the embedding pass for this sync. Mainly for tests; real callers want vectors kept fresh. */
  noEmbed?: boolean;
}

export interface SyncProjectOutput {
  summary: string;
}

/**
 * Captures `runInit`/`runSync`'s stdout (they write directly to
 * `process.stdout`, which is fine for a CLI but not for a tool result)
 * rather than refactoring them to return structured data -- the smallest
 * change that keeps one implementation instead of two.
 *
 * Always runs `init` first: an MCP client has no reason to know this tool
 * needs a separate init step, and `runInit` is already a safe no-op (just a
 * printed notice) when the project is initialized already.
 */
export async function syncProject(input: SyncProjectInput): Promise<SyncProjectOutput> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write;

  try {
    await runInit({ cwd: input.projectRoot, force: false, hook: false, enableConversation: false });

    const opts: SyncOptions = {
      cwd: input.projectRoot,
      full: false,
      rebuild: false,
      quiet: true,
      noEmbed: input.noEmbed,
    };
    await runSync(opts);
  } finally {
    process.stdout.write = originalWrite;
  }

  return { summary: chunks.join('').trim() };
}

export interface GetStatusInput {
  projectRoot: string;
}

export interface GetStatusOutput {
  total: number;
  byKind: Record<string, number>;
  sources: Array<{ source: string; cursor: string | null; lastRunAt: number | null }>;
}

export async function getStatus(input: GetStatusInput): Promise<GetStatusOutput> {
  const repo = await readRepoInfo(input.projectRoot);
  const ws = resolveWorkspace(repo.root);
  const projectId = makeProjectId({ root: repo.root, originUrl: repo.originUrl });

  const store = MemoryStore.open(ws.dbPath);
  try {
    const stats = store.stats(projectId);
    return { total: stats.total, byKind: stats.byKind, sources: store.listSyncState(projectId) };
  } finally {
    store.close();
  }
}
