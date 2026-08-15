import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('nexusmem.searchMemory', () => {
      void vscode.window.showInformationMessage('NexusMem: search command not wired up yet.');
    }),
  );
}

export function deactivate(): void {}
