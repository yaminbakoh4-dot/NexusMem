import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface SearchMemoryOptions {
  /** Executable that starts NexusMem's MCP server, e.g. "nexusmem" or an absolute path to it. */
  command: string;
  /** Args before the trailing "mcp", e.g. a script path when `command` is a bare node binary. Empty for the normal `nexusmem` shim. */
  commandArgs?: string[];
  /** Repository root to search -- NexusMem scopes every tool call by this, not any implicit cwd. */
  projectRoot: string;
  query: string;
  budget?: number;
  /** Extra env vars for the spawned server, merged on top of the SDK's fixed inherited allowlist (PATH, APPDATA, ...). */
  env?: Record<string, string>;
}

export interface SearchMemoryResult {
  text: string;
  matched: number;
  bm25Matched: number;
  vectorMatched: number;
  tokensUsed: number;
  tokensBudget: number;
  projectsSearched: string[];
}

interface ToolCallResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Thrown when the connection never completed its initial handshake, so the
 * caller can point at the nexusmem.cliPath setting instead of a raw protocol
 * error.
 *
 * Not just an ENOENT check: on Windows, a missing command doesn't surface as
 * ENOENT here at all. `cross-spawn` (used internally by the SDK's stdio
 * transport) resolves a bare command through `cmd.exe`, which spawns
 * successfully -- so the transport's 'spawn' event fires and `connect()`
 * proceeds to the handshake -- and only then does cmd.exe print "'x' is not
 * recognized..." and exit, which the SDK reports as `McpError -32000
 * Connection closed`. Confirmed by a real failing run against this exact
 * scenario before this class existed, not just reasoned about: any failure
 * before the handshake finishes is treated the same way, since the fix for
 * the user is identical either way.
 */
export class ServerNotFoundError extends Error {
  constructor(public readonly command: string, cause: unknown) {
    super(`Could not start "${command} mcp". Is NexusMem installed and on PATH?`, { cause });
    this.name = 'ServerNotFoundError';
  }
}

/**
 * Spawns `<command> mcp` fresh per call and speaks MCP over stdio -- the same
 * protocol/server Claude Desktop and Cursor already exercise against this
 * codebase (see the root project's tests/mcp.test.ts). One-shot rather than a
 * kept-alive connection: simplest correct thing for a command-palette query
 * fired every so often, not a hot path.
 */
export async function searchMemory(options: SearchMemoryOptions): Promise<SearchMemoryResult> {
  const transport = new StdioClientTransport({
    command: options.command,
    args: [...(options.commandArgs ?? []), 'mcp'],
    cwd: options.projectRoot,
    env: options.env,
  });

  const client = new Client({ name: 'nexusmem-vscode', version: '0.0.1' });

  let connected = false;
  try {
    await client.connect(transport, { timeout: 10_000 });
    connected = true;

    const result = (await client.callTool(
      {
        name: 'search_memory',
        arguments: { projectRoot: options.projectRoot, query: options.query, budget: options.budget },
      },
      undefined,
      { timeout: 20_000 },
    )) as ToolCallResult;

    if (result.isError) {
      const message = result.content.find((c) => c.type === 'text')?.text ?? 'search_memory returned an error';
      throw new Error(message);
    }

    const structured = result.structuredContent as Partial<SearchMemoryResult> | undefined;
    const text = structured?.text ?? result.content.find((c) => c.type === 'text')?.text ?? '';

    return {
      text,
      matched: structured?.matched ?? 0,
      bm25Matched: structured?.bm25Matched ?? 0,
      vectorMatched: structured?.vectorMatched ?? 0,
      tokensUsed: structured?.tokensUsed ?? 0,
      tokensBudget: structured?.tokensBudget ?? options.budget ?? 2000,
      projectsSearched: structured?.projectsSearched ?? [],
    };
  } catch (error) {
    if (!connected) {
      throw new ServerNotFoundError(options.command, error);
    }
    throw error;
  } finally {
    await client.close();
  }
}
