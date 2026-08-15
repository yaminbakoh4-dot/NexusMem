import * as vscode from 'vscode';
import { listRecentMemory } from './mcpClient.js';
import { rowsForState, type RecentMemoryRow, type RecentMemoryState } from './recentMemoryRows.js';

const RECENT_MEMORY_LIMIT = 30;

/**
 * Thin `vscode.TreeDataProvider` adapter over `rowsForState` -- the actual
 * row content/ordering logic lives there, tested without a `vscode` import.
 * This class only owns load state and the `TreeItem`/`ThemeIcon` mapping.
 */
export class RecentMemoryProvider implements vscode.TreeDataProvider<RecentMemoryRow> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private state: RecentMemoryState = { kind: 'loading' };

  constructor(private readonly resolveCliPath: () => string) {}

  async refresh(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.state = { kind: 'no-workspace' };
      this.changeEmitter.fire();
      return;
    }

    this.state = { kind: 'loading' };
    this.changeEmitter.fire();

    try {
      const items = await listRecentMemory({
        command: this.resolveCliPath(),
        projectRoot: folder.uri.fsPath,
        limit: RECENT_MEMORY_LIMIT,
      });
      this.state = { kind: 'items', items };
    } catch (error) {
      this.state = { kind: 'error', message: error instanceof Error ? error.message : String(error) };
    }

    this.changeEmitter.fire();
  }

  getTreeItem(row: RecentMemoryRow): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
    treeItem.id = row.id;
    treeItem.description = row.description;
    treeItem.tooltip = row.tooltip;
    treeItem.iconPath = new vscode.ThemeIcon(row.iconId);
    if (row.searchQuery) {
      treeItem.command = { command: 'nexusmem.searchMemory', title: 'Search', arguments: [row.searchQuery] };
    }
    return treeItem;
  }

  getChildren(row?: RecentMemoryRow): RecentMemoryRow[] {
    if (row) return []; // flat list, no nesting
    return rowsForState(this.state);
  }
}
