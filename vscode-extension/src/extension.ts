import * as vscode from 'vscode';
import { searchMemory, ServerNotFoundError, type SearchMemoryResult } from './mcpClient.js';
import { renderResultsHtml } from './renderResults.js';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('nexusmem.searchMemory', () => runSearchMemory(context)));
}

export function deactivate(): void {}

async function runSearchMemory(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage('NexusMem: open a folder or workspace first.');
    return;
  }

  const query = await vscode.window.showInputBox({
    prompt: 'Search NexusMem-remembered history for this repository',
    placeHolder: 'e.g. why did npm whoami fail',
  });
  if (!query || query.trim().length === 0) return;

  const cliPath = vscode.workspace.getConfiguration('nexusmem').get<string>('cliPath', 'nexusmem');

  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `NexusMem: searching for "${query}"` },
      () => searchMemory({ command: cliPath, projectRoot: folder.uri.fsPath, query }),
    );

    showResultsPanel(context, query, result);
  } catch (error) {
    await reportSearchError(cliPath, error);
  }
}

async function reportSearchError(cliPath: string, error: unknown): Promise<void> {
  if (error instanceof ServerNotFoundError) {
    const choice = await vscode.window.showErrorMessage(
      `${error.message} Install it with "npm install -g nexusmem", or point the nexusmem.cliPath setting (currently "${cliPath}") at an existing install.`,
      'Open Setting',
    );
    if (choice === 'Open Setting') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'nexusmem.cliPath');
    }
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  void vscode.window.showErrorMessage(`NexusMem search failed: ${message}`);
}

let resultsPanel: vscode.WebviewPanel | undefined;

function showResultsPanel(context: vscode.ExtensionContext, query: string, result: SearchMemoryResult): void {
  if (resultsPanel) {
    resultsPanel.dispose();
  }

  const panel = vscode.window.createWebviewPanel('nexusmem.results', `NexusMem: ${query}`, vscode.ViewColumn.Beside, {
    enableScripts: false,
  });
  panel.webview.html = renderResultsHtml(query, result, panel.webview.cspSource);

  resultsPanel = panel;
  panel.onDidDispose(
    () => {
      if (resultsPanel === panel) resultsPanel = undefined;
    },
    undefined,
    context.subscriptions,
  );
}
