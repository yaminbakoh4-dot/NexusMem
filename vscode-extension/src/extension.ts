import * as vscode from 'vscode';
import { searchMemory, ServerNotFoundError, type SearchMemoryResult } from './mcpClient.js';
import { renderResultsHtml } from './renderResults.js';
import { RecentMemoryProvider } from './recentMemoryView.js';

function getCliPath(): string {
  return vscode.workspace.getConfiguration('nexusmem').get<string>('cliPath', 'nexusmem');
}

export function activate(context: vscode.ExtensionContext): void {
  const recentMemory = new RecentMemoryProvider(getCliPath);
  context.subscriptions.push(vscode.window.registerTreeDataProvider('nexusmem.recentMemory', recentMemory));

  context.subscriptions.push(
    vscode.commands.registerCommand('nexusmem.searchMemory', (prefilledQuery?: string) => runSearchMemory(context, prefilledQuery)),
    vscode.commands.registerCommand('nexusmem.refreshRecentMemory', () => recentMemory.refresh()),
  );

  void recentMemory.refresh();
}

export function deactivate(): void {}

async function runSearchMemory(context: vscode.ExtensionContext, prefilledQuery?: string): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage('NexusMem: open a folder or workspace first.');
    return;
  }

  const query =
    prefilledQuery ??
    (await vscode.window.showInputBox({
      prompt: 'Search NexusMem-remembered history for this repository',
      placeHolder: 'e.g. why did npm whoami fail',
    }));
  if (!query || query.trim().length === 0) return;

  const cliPath = getCliPath();

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
