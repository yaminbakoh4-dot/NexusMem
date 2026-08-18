import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SLM_MODEL, OllamaChatProvider } from '../src/slm/provider.js';

/**
 * `OllamaChatProvider.complete` is contractually total: every failure mode
 * (server down, model not pulled, timeout, malformed response) resolves to
 * `null` rather than throwing, so the one collector that uses it is the only
 * thing degraded when a machine has no local model. Only the deterministic
 * `FakeSummarizationProvider` test double was exercised before this --
 * the real network path had no coverage of its own contract.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetchOnce(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

describe('OllamaChatProvider', () => {
  it('has a stable identity mentioning the model', () => {
    expect(new OllamaChatProvider().identity).toBe(`ollama:${DEFAULT_SLM_MODEL}`);
    expect(new OllamaChatProvider({ model: 'llama3:8b' }).identity).toBe('ollama:llama3:8b');
  });

  it('returns the trimmed response text on success', async () => {
    stubFetchOnce(async () => jsonResponse({ response: '  a real summary  ' }));

    const result = await new OllamaChatProvider().complete('summarize this');
    expect(result).toBe('a real summary');
  });

  it('posts a deterministic, non-streaming request to <baseUrl>/api/generate', async () => {
    const fetchMock = stubFetchOnce(async () => jsonResponse({ response: 'ok' }));

    await new OllamaChatProvider({ baseUrl: 'http://example:1234', model: 'm', maxTokens: 50 }).complete('hello');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://example:1234/api/generate');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: 'm',
      prompt: 'hello',
      stream: false,
      options: { temperature: 0, seed: 1, num_predict: 50 },
    });
  });

  it('returns null on a non-OK HTTP response, without throwing', async () => {
    stubFetchOnce(async () => jsonResponse({}, false));
    await expect(new OllamaChatProvider().complete('x')).resolves.toBeNull();
  });

  it('returns null when the response body has no string `response` field', async () => {
    stubFetchOnce(async () => jsonResponse({ response: 42 }));
    await expect(new OllamaChatProvider().complete('x')).resolves.toBeNull();

    vi.unstubAllGlobals();
    stubFetchOnce(async () => jsonResponse({}));
    await expect(new OllamaChatProvider().complete('x')).resolves.toBeNull();
  });

  it('returns null for a whitespace-only response, not an empty string', async () => {
    stubFetchOnce(async () => jsonResponse({ response: '   \n  ' }));
    await expect(new OllamaChatProvider().complete('x')).resolves.toBeNull();
  });

  it('returns null when the connection itself fails (server not running)', async () => {
    stubFetchOnce(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(new OllamaChatProvider().complete('x')).resolves.toBeNull();
  });

  it('returns null when the response body is not valid JSON', async () => {
    stubFetchOnce(
      async () =>
        ({
          ok: true,
          json: async () => {
            throw new SyntaxError('bad json');
          },
        }) as unknown as Response,
    );
    await expect(new OllamaChatProvider().complete('x')).resolves.toBeNull();
  });

  it('aborts and returns null once the timeout elapses, rather than hanging', async () => {
    stubFetchOnce(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );

    const result = await new OllamaChatProvider({ timeoutMs: 10 }).complete('x');
    expect(result).toBeNull();
  });
});
