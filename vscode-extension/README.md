# NexusMem for VS Code

Search a [NexusMem](https://github.com/yaminbkk/NexusMem)-tracked repository's remembered history —
git commits, code diffs, shell commands (with exit codes), tracked docs and (if enabled) conversation
transcripts — from the command palette, without leaving the editor.

This is an early, minimal surface: one command, one read-only results panel. It talks to the same
MCP server ([`nexusmem mcp`](../README.md)) that Claude Desktop, Cursor and Windsurf already use against
this codebase — no new server-side surface, just a client for the existing one.

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

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `nexusmem.cliPath` | `nexusmem` | Executable used to launch the MCP server (`<cliPath> mcp`). Set to an absolute path if `nexusmem` isn't on `PATH` (e.g. a local build). |

## Not yet built

This MVP is query-only. Not in scope yet, tracked for later: a sidebar view of recent memory, live
terminal-failure detection surfacing "you've hit this before," and a command to trigger `sync_project`
from within the editor.

## Development

```bash
npm install
npm run typecheck
npm run compile   # -> dist/extension.js
npm test          # vitest; the stdio integration test builds the root NexusMem CLI first
```

Then, from VS Code, open this folder and press `F5` to launch an Extension Development Host.
