/**
 * Small-language-model abstraction, used only for session summarization.
 *
 * Mirrors the embedding provider's contract on purpose: `complete` returns
 * `null` rather than throwing for every failure -- server down, model not
 * pulled, timeout, malformed response -- so a machine without a chat model
 * loses summaries and nothing else. Everything NexusMem does apart from this
 * one collector must keep working with no SLM present at all.
 *
 * Local-only by construction. There is no API-key option and no hosted
 * fallback: the input is verbatim conversation transcript, and the whole
 * argument for summarizing it at all is that the text never leaves the
 * machine.
 */
export interface SummarizationProvider {
  /** Stable name for the model behind this provider, recorded on the nodes it produces. */
  readonly identity: string;
  complete(prompt: string): Promise<string | null>;
}

export interface OllamaChatProviderOptions {
  baseUrl?: string;
  model?: string;
  /** Milliseconds before giving up on one completion. Default 120s. */
  timeoutMs?: number;
  /** Upper bound on generated tokens. Default 400 -- a summary, not an essay. */
  maxTokens?: number;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
/**
 * Chosen for a 12GB VRAM budget shared with the embedding model: ~1.9GB on
 * disk, and reliable enough at holding a fixed output shape that the parser
 * in summarize.ts does not need to be clever.
 */
export const DEFAULT_SLM_MODEL = 'qwen2.5:3b';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 400;

export class OllamaChatProvider implements SummarizationProvider {
  readonly identity: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;

  constructor(opts: OllamaChatProviderOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.model = opts.model ?? DEFAULT_SLM_MODEL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.identity = `ollama:${this.model}`;
  }

  async complete(prompt: string): Promise<string | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
          options: {
            // Deterministic: the same session must summarize to the same text
            // across syncs, or the content hash that suppresses re-work would
            // never match and every sync would rewrite every summary node.
            temperature: 0,
            seed: 1,
            num_predict: this.maxTokens,
          },
        }),
        signal: controller.signal,
      });

      if (!res.ok) return null;

      const data = (await res.json()) as { response?: unknown };
      if (typeof data.response !== 'string') return null;

      const text = data.response.trim();
      return text.length > 0 ? text : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Deterministic, network-free provider for tests. */
export class FakeSummarizationProvider implements SummarizationProvider {
  readonly identity = 'fake-slm';
  readonly prompts: string[] = [];

  constructor(private readonly reply: (prompt: string) => string | null = () => 'A fake summary.') {}

  async complete(prompt: string): Promise<string | null> {
    this.prompts.push(prompt);
    return this.reply(prompt);
  }
}
