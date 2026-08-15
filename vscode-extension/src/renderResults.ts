import type { SearchMemoryResult } from './mcpClient.js';

/**
 * Pure HTML builder for the results webview -- kept free of the `vscode`
 * import so it can be unit tested directly, the same split the root project
 * draws between its MCP tool wrappers and the CLI/server glue around them.
 */
export function renderResultsHtml(query: string, result: SearchMemoryResult, cspSource: string): string {
  const projects = result.projectsSearched.length > 0 ? result.projectsSearched.join(', ') : '(none)';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'none';">
<title>NexusMem: ${escapeHtml(query)}</title>
<style>
  body {
    font-family: var(--vscode-font-family, sans-serif);
    color: var(--vscode-editor-foreground);
    background-color: var(--vscode-editor-background);
    padding: 0 1rem 1rem;
  }
  h1 { font-size: 1.1rem; font-weight: 600; }
  .stats {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85rem;
    margin-bottom: 1rem;
  }
  .stats span { margin-right: 1rem; }
  pre {
    white-space: pre-wrap;
    word-break: break-word;
    background-color: var(--vscode-textCodeBlock-background);
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 4px;
    padding: 0.75rem;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
  }
</style>
</head>
<body>
<h1>${escapeHtml(query)}</h1>
<div class="stats">
  <span>matched: ${result.matched}</span>
  <span>bm25: ${result.bm25Matched}</span>
  <span>vector: ${result.vectorMatched}</span>
  <span>tokens: ${result.tokensUsed}/${result.tokensBudget}</span>
  <span>projects: ${escapeHtml(projects)}</span>
</div>
${result.text.trim().length > 0 ? `<pre>${escapeHtml(result.text)}</pre>` : '<p>No matches.</p>'}
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
