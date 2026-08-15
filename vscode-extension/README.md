# NexusMem for VS Code

Search a [NexusMem](https://github.com/yaminbkk/NexusMem)-tracked repository's remembered history —
git commits, code diffs, shell commands (with exit codes), tracked docs and (if enabled) conversation
transcripts — from the command palette, without leaving the editor.

This is an early, minimal surface: a search command, a read-only results panel, a sidebar list of
what's been remembered lately, and a proactive check when a terminal command fails. It talks to the
same MCP server ([`nexusmem mcp`](../README.md)) that Claude Desktop, Cursor and Windsurf already use
against this codebase — no new server-side surface for search or live detection, just a client for the
existing one (plus one new tool, `list_recent_memory`, for the sidebar).

## Requirements

- [NexusMem](https://www.npmjs.com/package/nexusmem) installed and on `PATH`:

  ```bash
  npm install -g nexusmem
  ```

- The repository you're searching must already be initialized and synced (`nexusmem init && nexusmem sync`
  from a terminal, once).

## Usage

1. Open a folder that is a NexusMem-tracked git repository.
2. Run **NexusMem: Search Memory** from the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
3. Type a free-text query (e.g. `why did npm whoami fail`). Results open in a panel beside the editor:
   the packed, token-budgeted context block NexusMem would hand an agent, plus match/token stats.

### Recent Memory sidebar

The Explorer view (`Ctrl+Shift+E` / `Cmd+Shift+E`) gains a **NexusMem: Recent Memory** panel: the most
recently remembered items for the open repository, newest first — chronology, not a search. Click a
row to search for it (pre-fills the query above with that item's title). Refresh with the ↻ button in
the panel's title bar; it also loads once automatically when the extension activates.

### Live terminal-failure detection

When a command in an integrated terminal exits non-zero, NexusMem checks its memory for that command in
the background. If there's a match (e.g. a past run of the same command that later succeeded, or a
related fix), a notification offers **Show details**, which opens the same results panel as a manual
search. Silent when there's no match — this is meant to surface something genuinely useful, not to
comment on every failed command.

Depends on [VS Code's terminal shell integration](https://code.visualstudio.com/docs/terminal/shell-integration)
actually being active for your shell (the status bar / a colored bar next to the prompt is the usual
tell). If it isn't, this feature quietly does nothing rather than erroring — everything else in this
extension still works.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `nexusmem.cliPath` | `nexusmem` | Executable used to launch the MCP server (`<cliPath> mcp`). Set to an absolute path if `nexusmem` isn't on `PATH` (e.g. a local build). |
| `nexusmem.liveFailureDetection.enabled` | `true` | Check NexusMem's memory when a terminal command fails, and notify if it finds something. |

## Not yet built

Not in scope yet, tracked for later: a command to trigger `sync_project` from within the editor.

## Development

```bash
npm install
npm run typecheck
npm run compile   # -> dist/extension.js
npm test          # vitest; the stdio integration test builds the root NexusMem CLI first
```

Then, from VS Code, open this folder and press `F5` to launch an Extension Development Host.
