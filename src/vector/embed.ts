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
  embed(text: string): Promise<Float32Array | null>;
}

export interface OllamaEmbeddingProviderOptions {
  baseUrl?: string;
  model?: string;
  dimension?: number;
  /** Milliseconds before giving up on a single embed call. Default 10s. */
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'nomic-embed-text';
/** Confirmed against a live Ollama call -- see store/schema.ts's EMBEDDING_DIM. */
const DEFAULT_DIMENSION = 768;
const DEFAULT_TIMEOUT_MS = 10_000;

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly dimension: number;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(opts: OllamaEmbeddingProviderOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.dimension = opts.dimension ?? DEFAULT_DIMENSION;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async embed(text: string): Promise<Float32Array | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: text }),
        signal: controller.signal,
      });

      if (!res.ok) return null;

      const data = (await res.json()) as { embedding?: unknown };
      if (!Array.isArray(data.embedding) || data.embedding.length !== this.dimension) return null;

      return new Float32Array(data.embedding as number[]);
    } catch {
      return null; // Ollama not running, model not pulled, network hiccup -- all degrade the same way
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Deterministic, network-free provider for tests. */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  constructor(readonly dimension = 8) {}

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
