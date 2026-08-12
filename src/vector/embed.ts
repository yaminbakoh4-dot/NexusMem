/**
 * Embedding provider abstraction.
 *
 * The real implementation calls a local Ollama server; tests and any
 * environment without Ollama running use a fake. `embed` returns `null`
 * (never throws) on any failure -- connection refused, model not pulled,
 * malformed response -- so a missing embedding provider degrades the whole
 * system to BM25-only search, not a broken `sync`.
 */
export interface EmbeddingProvider {
  readonly dimension: number;
  /**
   * Stable name for "what produced these vectors".
   *
   * Persisted alongside the corpus so a provider swap can be *detected*
   * rather than silently mixed in. Two vectors from different models --
   * or, less obviously, from two endpoints of the same model that differ
   * in normalisation -- are not comparable, and `nodes_vec` stores no
   * per-row provenance to tell them apart after the fact. Must change
   * whenever the produced vectors change meaning.
   */
  readonly identity: string;
  embed(text: string): Promise<Float32Array | null>;
  /**
   * Embed several texts in one round trip, positionally aligned with the
   * input. Optional: a provider without it is driven one call at a time.
   * A failure is per-request, so a rejected batch yields all-`null`.
   */
  embedBatch?(texts: readonly string[]): Promise<(Float32Array | null)[]>;
}

export interface OllamaEmbeddingProviderOptions {
  baseUrl?: string;
  model?: string;
  dimension?: number;
  /**
   * Milliseconds allowed *per text*. A request's real budget is this times
   * the number of texts in it, capped by `maxTimeoutMs` -- a batch of 32
   * legitimately takes longer than a single embed and must not be aborted
   * for being a batch. Default 10s.
   */
  timeoutMs?: number;
  /** Upper bound on any single request's timeout, however large the batch. Default 120s. */
  maxTimeoutMs?: number;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'nomic-embed-text';
/** Confirmed against a live Ollama call -- see store/schema.ts's EMBEDDING_DIM. */
const DEFAULT_DIMENSION = 768;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_TIMEOUT_MS = 120_000;

/**
 * Ollama's batch embedding endpoint.
 *
 * Deliberately NOT the older `/api/embeddings`, and the difference is not
 * only that this one takes an array: **`/api/embed` returns L2-normalised
 * vectors and `/api/embeddings` does not** (measured on this machine against
 * nomic-embed-text: norm 1.0 vs 20.7 for the same input). `nodes_vec` ranks
 * by Euclidean distance, so a corpus holding both is not merely
 * inconsistent -- every normalised vector sits ~20x nearer the origin than
 * every unnormalised one, and the two groups separate by scale instead of by
 * meaning. Hence `EMBEDDING_IDENTITY` below names the endpoint, and the
 * embedding pass re-embeds from scratch when it changes.
 */
const EMBED_PATH = '/api/embed';

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly dimension: number;
  readonly identity: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxTimeoutMs: number;

  constructor(opts: OllamaEmbeddingProviderOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.dimension = opts.dimension ?? DEFAULT_DIMENSION;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxTimeoutMs = opts.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
    // `baseUrl` is deliberately absent: pointing at a different host running
    // the same model is not a different embedding space, so it must not
    // trigger a re-embed.
    this.identity = `ollama${EMBED_PATH}:${this.model}:${this.dimension}`;
  }

  async embed(text: string): Promise<Float32Array | null> {
    const [only] = await this.embedBatch([text]);
    return only ?? null;
  }

  async embedBatch(texts: readonly string[]): Promise<(Float32Array | null)[]> {
    if (texts.length === 0) return [];

    const controller = new AbortController();
    const budget = Math.min(this.timeoutMs * texts.length, this.maxTimeoutMs);
    const timeout = setTimeout(() => controller.abort(), budget);

    try {
      const res = await fetch(`${this.baseUrl}${EMBED_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: controller.signal,
      });

      if (!res.ok) return texts.map(() => null);

      const data = (await res.json()) as { embeddings?: unknown };
      if (!Array.isArray(data.embeddings)) return texts.map(() => null);

      // Positional alignment with `texts` is the contract callers rely on to
      // know which node each vector belongs to. Ollama returns one row per
      // input, but a short or long array would silently shift that mapping
      // and mislabel every embedding after the gap -- refuse instead.
      if (data.embeddings.length !== texts.length) return texts.map(() => null);

      return data.embeddings.map((row) =>
        Array.isArray(row) && row.length === this.dimension ? new Float32Array(row as number[]) : null,
      );
    } catch {
      return texts.map(() => null); // Ollama not running, model not pulled, network hiccup -- all degrade the same way
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Deterministic, network-free provider for tests. */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly identity: string;

  constructor(readonly dimension = 8) {
    this.identity = `fake:${dimension}`;
  }

  async embed(text: string): Promise<Float32Array | null> {
    // A cheap hash-based vector: stable per input, distinct enough across
    // different inputs to exercise real KNN ordering in tests.
    const v = new Float32Array(this.dimension);
    for (let i = 0; i < text.length; i += 1) {
      const idx = i % this.dimension;
      v[idx] = (v[idx] ?? 0) + text.charCodeAt(i);
    }
    return v;
  }
}
