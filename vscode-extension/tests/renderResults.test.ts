import { describe, expect, it } from 'vitest';
import { renderResultsHtml } from '../src/renderResults.js';
import type { SearchMemoryResult } from '../src/mcpClient.js';

function baseResult(overrides: Partial<SearchMemoryResult> = {}): SearchMemoryResult {
  return {
    text: 'fix: handle the retry timeout correctly',
    matched: 2,
    bm25Matched: 2,
    vectorMatched: 0,
    tokensUsed: 120,
    tokensBudget: 2000,
    projectsSearched: ['NexusMem'],
    ...overrides,
  };
}

describe('renderResultsHtml', () => {
  it('includes the query, the packed text and the stats', () => {
    const html = renderResultsHtml('retry timeout', baseResult(), 'https://x');
    expect(html).toContain('retry timeout');
    expect(html).toContain('fix: handle the retry timeout correctly');
    expect(html).toContain('matched: 2');
    expect(html).toContain('tokens: 120/2000');
    expect(html).toContain('NexusMem');
  });

  it('shows a no-matches message instead of an empty <pre> when text is blank', () => {
    const html = renderResultsHtml('nothing found', baseResult({ text: '', matched: 0 }), 'https://x');
    expect(html).toContain('No matches.');
    expect(html).not.toContain('<pre></pre>');
  });

  /**
   * A malicious or just-unlucky query/result (e.g. a commit message containing
   * "<script>") must not become live markup in the webview -- the packed
   * text comes from this machine's own git/shell history, but the webview
   * still runs with the extension's permissions, so unescaped injection would
   * be a real vulnerability, not a hypothetical one.
   */
  it('escapes HTML-significant characters in the query and in the packed text', () => {
    const html = renderResultsHtml('<img src=x onerror=alert(1)>', baseResult({ text: '<script>alert(1)</script>' }), 'https://x');

    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes HTML in project names', () => {
    const html = renderResultsHtml('q', baseResult({ projectsSearched: ['<b>evil</b>'] }), 'https://x');
    expect(html).not.toContain('<b>evil</b>');
    expect(html).toContain('&lt;b&gt;evil&lt;/b&gt;');
  });

  it('embeds the given csp source and disallows scripts in the Content-Security-Policy', () => {
    const html = renderResultsHtml('q', baseResult(), 'vscode-webview://abc');
    expect(html).toContain("script-src 'none'");
    expect(html).toContain('style-src vscode-webview://abc');
  });
});
